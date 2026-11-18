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
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})(?:\s+.*)?$/.exec(value.trim());
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
  if (!Array.isArray(cues)) return '';
  return cues
    .filter(cue => cue && typeof cue === 'object')
    .map((cue, i) => {
      const idx = i + 1;
      const startSec = Math.max(0, Number(cue.startSec) || 0);
      const endSec = Math.max(startSec, Number(cue.endSec) || startSec);
      const start = secondsToSrtTime(startSec);
      const end = secondsToSrtTime(endSec);
      const rawTxt = (cue.translated !== undefined && cue.translated !== null && (cue.translated !== '' || Boolean(cue.translatedLang)))
        ? cue.translated
        : (cue.text || '');
      const txt = String(rawTxt).replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').trim();
      return `${idx}\n${start} --> ${end}\n${txt}`;
    })
    .join('\n\n') + '\n';
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
  if (normalized.startsWith('\\\\') || normalized.startsWith('//') || normalized.slice(2).includes(':')) {
    return res.status(403).json({ success: false, error: 'Invalid or forbidden srt file path.' });
  }
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
    const rawTrimmed = filePath.trim();
    if (!path.isAbsolute(rawTrimmed)) {
      return res.status(400).json({ success: false, error: 'filePath must be an absolute path.' });
    }
    savePath = path.normalize(rawTrimmed);
    if (savePath.startsWith('\\\\') || savePath.startsWith('//') || savePath.slice(2).includes(':')) {
      return res.status(403).json({ success: false, error: 'Invalid or forbidden target path.' });
    }
    const baseName = path.basename(savePath);
    if (!baseName || /[.\s]+$/.test(baseName) || path.extname(savePath).toLowerCase() !== '.srt') {
      return res.status(403).json({ success: false, error: 'filePath must end with .srt' });
    }
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

function readSafeCompanionSrt(candPath) {
  const stat = fs.statSync(candPath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SRT_BYTES) return null;
  const raw = fs.readFileSync(candPath, 'utf8');
  const cues = parseSrt(raw);
  return cues.length > 0 ? cues : null;
}

function findCompanionSrtHandler(req, res) {
  const { videoPath } = req.body || {};
  if (typeof videoPath !== 'string' || !videoPath.trim()) {
    return res.status(400).json({ success: false, error: 'videoPath is required.' });
  }
  const normalized = path.normalize(videoPath.trim());
  if (!path.isAbsolute(normalized) || normalized.startsWith('\\\\') || normalized.startsWith('//') || normalized.slice(2).includes(':')) {
    return res.status(400).json({ success: false, error: 'videoPath must be a valid local absolute path.' });
  }
  const dir = path.dirname(normalized);
  const ext = path.extname(normalized);
  const stem = path.basename(normalized, ext);

  // Common subtitle naming patterns:
  const candidates = [
    path.join(dir, `${stem}.srt`),
    path.join(dir, `${stem}.zh.srt`),
    path.join(dir, `${stem}.zh-CN.srt`),
    path.join(dir, `${stem}.chs.srt`),
    path.join(dir, `${stem}.chi.srt`),
    path.join(dir, `${stem}.en.srt`),
    path.join(dir, `${stem}.km.srt`),
    path.join(dir, 'subtitles', `${stem}.srt`),
    path.join(dir, 'Subtitles', `${stem}.srt`),
  ];

  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      try {
        const cues = readSafeCompanionSrt(cand);
        if (cues) {
          return res.json({
            success: true,
            found: true,
            filePath: cand,
            fileName: path.basename(cand),
            cues
          });
        }
      } catch (_) {}
    }
  }

  // Check if any companion .srt with matching video stem exists in same folder (never match unrelated SRT files)
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const files = fs.readdirSync(dir);
      const stemLower = stem.toLowerCase();
      const matchingSrt = files.find((f) => {
        if (!/\.srt$/i.test(f)) return false;
        const fStemLower = path.basename(f, path.extname(f)).toLowerCase();
        return (
          fStemLower === stemLower ||
          fStemLower.startsWith(`${stemLower}.`) ||
          fStemLower.startsWith(`${stemLower}_`) ||
          fStemLower.startsWith(`${stemLower}-`) ||
          fStemLower.startsWith(`${stemLower} `)
        );
      });
      if (matchingSrt) {
        const fullPath = path.join(dir, matchingSrt);
        const cues = readSafeCompanionSrt(fullPath);
        if (cues) {
          return res.json({
            success: true,
            found: true,
            filePath: fullPath,
            fileName: matchingSrt,
            cues
          });
        }
      }
    }
  } catch (_) {}

  return res.json({ success: true, found: false });
}

module.exports = router;
module.exports.srtTimeToSeconds = srtTimeToSeconds;
module.exports.parseSrt = parseSrt;
module.exports.serializeSrt = serializeSrt;
module.exports.secondsToSrtTime = secondsToSrtTime;
module.exports.secondsToDisplayTime = secondsToDisplayTime;
module.exports.loadSrtFileHandler = loadSrtFileHandler;
module.exports.saveSrtFileHandler = saveSrtFileHandler;
module.exports.findCompanionSrtHandler = findCompanionSrtHandler;
