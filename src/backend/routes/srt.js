/**
 * SRT parsing, loading, and saving endpoints
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const MAX_SRT_BYTES = 10 * 1024 * 1024;
const DEFAULT_EXPORT_DIR = path.join(__dirname, '..', '..', '..', 'Exported');

function getExportDir() {
  return process.env.EXPORT_DIR || DEFAULT_EXPORT_DIR;
}

function srtTimeToSeconds(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
  if (!match) return null;

  const milliseconds = Number(match[4].padEnd(3, '0'));
  return Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    milliseconds / 1000;
}

function secondsToDisplayTime(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const totalTenths = Math.round(safeSeconds * 10);
  const minutes = Math.floor(totalTenths / 600);
  const remainder = ((totalTenths % 600) / 10).toFixed(1);
  return `${minutes}:${remainder.padStart(4, '0')}`;
}

function secondsToSrtTime(totalSec) {
  const safeSeconds = Math.max(0, Number(totalSec) || 0);
  const totalMilliseconds = Math.round(safeSeconds * 1000);
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const wholeSeconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

function parseSrt(rawText) {
  if (typeof rawText !== 'string') return [];

  const normalized = rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  for (const block of normalized.split(/\n\s*\n+/)) {
    const lines = block.trim().split('\n');
    const timeLineIndex = lines.findIndex(line => line.includes('-->'));
    if (timeLineIndex < 0 || timeLineIndex === lines.length - 1) continue;

    const timeParts = lines[timeLineIndex].split('-->');
    if (timeParts.length !== 2) continue;

    const startSec = srtTimeToSeconds(timeParts[0]);
    const endSec = srtTimeToSeconds(timeParts[1]);
    const text = lines.slice(timeLineIndex + 1).join('\n').trim();
    if (startSec === null || endSec === null || endSec < startSec || !text) continue;

    // Only treat line 0 as a sequence index when it precedes the timecode line.
    const parsedIndex = timeLineIndex > 0 ? Number.parseInt(lines[0], 10) : NaN;
    cues.push({
      index: Number.isInteger(parsedIndex) && parsedIndex > 0 ? parsedIndex : cues.length + 1,
      start: secondsToDisplayTime(startSec),
      end: secondsToDisplayTime(endSec),
      startSec,
      endSec,
      timecode: lines[timeLineIndex].trim(),
      text,
      translated: text,
      voice: 'Sovereign King'
    });
  }
  return cues;
}

function serializeSrt(cues) {
  return cues.map((cue, i) => {
    const idx = i + 1;
    const startSec = Math.max(0, Number(cue.startSec) || 0);
    const endSec = Math.max(startSec, Number(cue.endSec) || startSec);
    const start = secondsToSrtTime(startSec);
    const end = secondsToSrtTime(endSec);
    const txt = String(cue.translated || cue.text || '').replace(/\r\n?/g, '\n').trim();
    return `${idx}\n${start} --> ${end}\n${txt}`;
  }).join('\n\n') + '\n';
}

router.post('/', (req, res) => {
  const raw = req.body && req.body.raw;
  if (typeof raw !== 'string' || raw.length > MAX_SRT_BYTES) {
    return res.status(400).json({ success: false, error: 'SRT content is missing or too large.' });
  }

  const cues = parseSrt(raw);
  if (cues.length === 0) {
    return res.status(400).json({ success: false, error: 'No valid subtitle cues were found in this SRT file.' });
  }
  return res.json({ success: true, cues });
});

function loadSrtFileHandler(req, res) {
  const { filePath } = req.body || {};
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return res.status(400).json({ success: false, error: 'filePath is required.' });
  }
  if (!path.isAbsolute(filePath)) {
    return res.status(400).json({ success: false, error: 'filePath must be an absolute path.' });
  }

  const normalized = path.normalize(filePath);
  let stats;
  try {
    stats = fs.statSync(normalized);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ success: false, error: 'SRT file not found.' });
    }
    return res.status(500).json({ success: false, error: err.message });
  }

  if (!stats.isFile()) {
    return res.status(400).json({ success: false, error: 'Selected path is not a file.' });
  }
  if (stats.size > MAX_SRT_BYTES) {
    return res.status(413).json({ success: false, error: 'SRT file is too large (max 10 MB).' });
  }

  try {
    const raw = fs.readFileSync(normalized, 'utf8');
    const cues = parseSrt(raw);
    return res.json({ success: true, cues });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

function saveSrtFileHandler(req, res) {
  const { cues, filePath } = req.body || {};
  if (!Array.isArray(cues) || cues.length === 0) {
    return res.status(400).json({ success: false, error: 'No subtitle cues to save.' });
  }
  if (filePath !== undefined && filePath !== null && typeof filePath !== 'string') {
    return res.status(400).json({ success: false, error: 'Invalid filePath.' });
  }

  let savePath;
  if (typeof filePath === 'string' && filePath.trim()) {
    if (!path.isAbsolute(filePath.trim())) {
      return res.status(400).json({ success: false, error: 'filePath must be an absolute path.' });
    }
    savePath = path.normalize(filePath.trim());
  } else {
    const exportDir = getExportDir();
    fs.mkdirSync(exportDir, { recursive: true });
    savePath = path.join(exportDir, `Subtitles_${Date.now()}.srt`);
  }

  try {
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    const srtContent = serializeSrt(cues);
    fs.writeFileSync(savePath, srtContent, 'utf8');
    return res.json({ success: true, savedPath: savePath });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = router;
module.exports.srtTimeToSeconds = srtTimeToSeconds;
module.exports.parseSrt = parseSrt;
module.exports.serializeSrt = serializeSrt;
module.exports.secondsToSrtTime = secondsToSrtTime;
module.exports.secondsToDisplayTime = secondsToDisplayTime;
module.exports.loadSrtFileHandler = loadSrtFileHandler;
module.exports.saveSrtFileHandler = saveSrtFileHandler;
