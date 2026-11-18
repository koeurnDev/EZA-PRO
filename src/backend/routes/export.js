/**
 * ⚡ EZA PRO - Video Export Routes
 * FFmpeg video export with burned-in Khmer subtitles, AI Dubbing mixing, and HD presets
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { FFMPEG_BIN, parseMp3DurationFast, mapWithConcurrency, lowerProcessPriority } = require('../utils/ffmpeg');
const ttsRouter = require('./tts');
const audioRouter = require('./audio');
const { normalizeKhmerChuonNath, segmentKhmerWithChuonNath } = require('../utils/khmer-chuon-nath');
const { resolveUnpackedPath, logWarn, logError } = require('../utils/logger');

const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, '..', '..', '..', 'Exported');
const DUB_BATCH_SIZE = 20;
const MIN_VALID_AUDIO_BYTES = 100;

const RESOLUTION_SPECS = {
  source: null,
  '720p': { longEdge: 1280, shortEdge: 720 },
  '1080p': { longEdge: 1920, shortEdge: 1080 },
  '4k': { longEdge: 3840, shortEdge: 2160 }
};

const QUALITY_PROFILES = {
  fast: {
    libx264: ['-c:v', 'libx264', '-preset', 'superfast', '-crf', '25', '-pix_fmt', 'yuv420p'],
    h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p2', '-rc', 'vbr', '-cq', '29', '-b:v', '0', '-pix_fmt', 'yuv420p'],
    h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '28', '-pix_fmt', 'nv12'],
    h264_amf: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'qvbr', '-qvbr_quality_level', '29', '-pix_fmt', 'yuv420p']
  },
  balanced: {
    libx264: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p'],
    h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '27', '-b:v', '0', '-pix_fmt', 'yuv420p'],
    h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'fast', '-global_quality', '27', '-pix_fmt', 'nv12'],
    h264_amf: ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'qvbr', '-qvbr_quality_level', '27', '-pix_fmt', 'yuv420p']
  },
  hd: {
    libx264: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p'],
    h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-spatial-aq', '1', '-pix_fmt', 'yuv420p'],
    h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', '23', '-pix_fmt', 'nv12'],
    h264_amf: ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'qvbr', '-qvbr_quality_level', '23', '-pix_fmt', 'yuv420p']
  },
  ultra: {
    libx264: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p'],
    h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p7', '-rc', 'vbr', '-cq', '19', '-b:v', '0', '-spatial-aq', '1', '-pix_fmt', 'yuv420p'],
    h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'slow', '-global_quality', '19', '-pix_fmt', 'nv12'],
    h264_amf: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'qvbr', '-qvbr_quality_level', '19', '-pix_fmt', 'yuv420p']
  }
};

const MAXRATE_TIERS_KBPS = {
  fast: { '720p': 1100, '1080p': 1600, '4k': 4500 },
  balanced: { '720p': 1400, '1080p': 2200, '4k': 6500 },
  hd: { '720p': 2000, '1080p': 3200, '4k': 9500 },
  ultra: { '720p': 3500, '1080p': 6000, '4k': 16000 }
};

// Typical average bitrate as a fraction of the VBV maxrate ceiling (used for size estimates and QSV VBR targets)
const AVG_BITRATE_FACTOR = { fast: 0.78, balanced: 0.85, hd: 0.90, ultra: 0.75 };

function getExportDir() {
  return process.env.EXPORT_DIR || EXPORT_DIR;
}

try {
  if (!fs.existsSync(getExportDir())) {
    fs.mkdirSync(getExportDir(), { recursive: true });
  }
} catch (dirErr) {
  logWarn('export:init', `Export directory creation deferred: ${dirErr.message}`);
}

let cachedHwEncoder;
let cachedHwEncoderCheckedAt = 0;
const HW_ENCODER_NEGATIVE_CACHE_MS = 30000;

let activeExportJobSeq = 0;
let activeExportJobPromise = null;

function killExportProcessTree(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
  } catch (_) {}
  try { proc.kill('SIGKILL'); } catch (_) {}
}

let activeExportState = {
  jobId: 0,
  running: false,
  cancelled: false,
  percent: 0,
  timeStr: '00:00',
  speed: '1x',
  phase: 'idle',
  statusText: '',
  error: null,
  outputFile: null,
  proc: null,
  helperProcs: new Set(),
  startTime: null
};

const DOWNLOAD_ALLOWLIST = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.srt']);

function isBlockedNetworkOrStreamPath(rawPath, normalizedPath) {
  const raw = String(rawPath || '').trim();
  const norm = String(normalizedPath || '').trim();
  if (!raw || !norm) return true;
  if (raw.startsWith('\\\\') || raw.startsWith('//') || norm.startsWith('\\\\') || norm.startsWith('//')) {
    return true;
  }
  const withoutDrive = norm.replace(/^[A-Za-z]:/, '');
  if (withoutDrive.includes(':')) return true;
  const baseName = path.basename(norm);
  if (/[. ]$/.test(baseName)) return true;
  return false;
}

/**
 * Convert seconds to ASS timestamp format (H:MM:SS.CS).
 */
function secondsToAssTime(sec) {
  const safeSec = Math.max(0, Number(sec) || 0);
  const totalCs = Math.round(safeSec * 100);
  const cs = totalCs % 100;
  const totalWholeSec = Math.floor(totalCs / 100);
  const s = totalWholeSec % 60;
  const m = Math.floor(totalWholeSec / 60) % 60;
  const h = Math.floor(totalWholeSec / 3600);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function wrapSingleLine(line, maxChars = 34) {
  if (!line || line.length <= maxChars) return line;

  const mid = Math.floor(line.length / 2);
  let bestIdx = -1;
  let bestDist = Infinity;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === ' ' || char === '\u200B') {
      const dist = Math.abs(i - mid);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
  }

  if (bestIdx !== -1 && bestIdx > 8 && bestIdx < line.length - 8) {
    return line.slice(0, bestIdx).trim() + '\\N' + line.slice(bestIdx + 1).trim();
  }

  // Fallback for unspaced Khmer text: split at nearest Chuon Nath word boundary instead of mid-word
  if (/[\u1780-\u17FF]/.test(line)) {
    const segs = segmentKhmerWithChuonNath(line);
    let dictBestIdx = -1;
    let dictBestDist = Infinity;
    for (let i = 0; i < segs.length - 1; i++) {
      const endPos = segs[i].end;
      if (endPos < 6 || endPos > line.length - 4) continue;
      const dist = Math.abs(endPos - mid);
      if (dist < dictBestDist) {
        dictBestDist = dist;
        dictBestIdx = endPos;
      }
    }
    if (dictBestIdx !== -1) {
      return line.slice(0, dictBestIdx).trim() + '\\N' + line.slice(dictBestIdx).trim();
    }
  }

  let cut = maxChars;
  while (cut > 6 && (
    /[\u17B6-\u17D3\u17DD]/.test(line[cut]) ||
    line[cut - 1] === '\u17D2' ||
    (line.charCodeAt(cut) >= 0xDC00 && line.charCodeAt(cut) <= 0xDFFF)
  )) {
    cut--;
  }
  if (cut <= 6) cut = maxChars;
  return line.slice(0, cut) + '\\N' + line.slice(cut);
}

/**
 * Wrap long Khmer text into balanced ASS dialogue lines.
 */
function wrapKhmerText(text, maxChars = 34) {
  if (!text) return '';
  const normalized = String(text).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n').map(part => wrapSingleLine(part.trim(), maxChars)).filter(Boolean);
  return lines.join('\\N');
}

/**
 * Generate ASS subtitle script with style settings.
 */
const _assKmSegmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
  ? new Intl.Segmenter('km', { granularity: 'word' })
  : null;

function normalizeKhmerSpacing(text) {
  let s = normalizeKhmerChuonNath(String(text || '').replace(/\s+/g, ' ').trim());
  if (!/[\u1780-\u17FF]/.test(s)) return s;
  const boundSuffixes = 'ពេក|ណាស់|ទេ|ហើយ|ដែរ|ផង|សោះ|ឡើយ|វិញ|នេះ|នោះ|ទៀត|អី|ហ្នឹង|មែនទេ|ទេអ្ហី|អ្ហ៎|ណា៎|ចុះ|ផងដែរ|ទាំងអស់|ប៉ុណ្ណោះ|ឯង';
  const suffixRe = new RegExp(`([\\u1780-\\u17FF])\\s+(${boundSuffixes})(?=[\\s។!?៖,，。！？]|$)`, 'g');
  s = s.replace(suffixRe, '$1$2').replace(suffixRe, '$1$2');

  const boundPrefixes = 'របស់|នៃ|ជា|គឺ|គឺជា|នៅ|ក្នុង|លើ|ក្រោម|ពី|ដោយ|សម្រាប់|ចំពោះ|មិន|អត់|កុំ|បាន|នឹង|កំពុង|ដ៏|ឲ្យ|ឱ្យ|អោយ|ថា';
  const prefixRe = new RegExp(`(^|[\\s\\u17D4-\\u17DA])(${boundPrefixes})\\s+([\\u1780-\\u17FF])`, 'g');
  s = s.replace(prefixRe, '$1$2$3').replace(prefixRe, '$1$2$3');

  s = s.replace(/\s+([។!?៖])/g, '$1');
  return s.replace(/\s{2,}/g, ' ').trim();
}

function getKhmerVisualLength(str) {
  const s = String(str || '')
    .replace(/\u17D2[\u1780-\u17A2]/g, '')
    .replace(/[\u17B7-\u17BD\u17C6\u17C9-\u17D3\u17DD\u200B-\u200D]/g, '');
  return Array.from(s).length;
}

function segmentTextForKaraoke(rawText, maxCharsPerChunk = 22, maxWordsPerChunk = 6) {
  const clean = normalizeKhmerSpacing(rawText);
  if (!clean) return [];

  const spaceGroups = clean.split(/\s+/).filter(Boolean);
  const mergedWords = [];

  for (let gIdx = 0; gIdx < spaceGroups.length; gIdx++) {
    const group = spaceGroups[gIdx];
    const isLastGroup = gIdx === spaceGroups.length - 1;
    const groupVisLen = getKhmerVisualLength(group);

    if (groupVisLen <= 9 || !/[\u1780-\u17FF]/.test(group)) {
      mergedWords.push({
        text: group,
        spaceAfter: !isLastGroup
      });
      continue;
    }

    const cnSegs = segmentKhmerWithChuonNath(group);
    const subTokens = [];
    let curTok = '';
    for (const seg of cnSegs) {
      if (!seg.text) continue;
      if (seg.isKhmer) {
        if (curTok) subTokens.push(curTok);
        if (!seg.inDict && _assKmSegmenter && getKhmerVisualLength(seg.text) > 12) {
          let first = true;
          for (const sub of _assKmSegmenter.segment(seg.text)) {
            if (!sub.segment) continue;
            if (first) {
              curTok = sub.segment;
              first = false;
            } else if (sub.isWordLike) {
              if (curTok) subTokens.push(curTok);
              curTok = sub.segment;
            } else {
              curTok += sub.segment;
            }
          }
        } else {
          curTok = seg.text;
        }
      } else {
        curTok += seg.text;
      }
    }
    if (curTok) subTokens.push(curTok);

    const phraseUnits = [];
    let acc = '';
    for (let t = 0; t < subTokens.length; t++) {
      const piece = subTokens[t];
      const nextAcc = acc ? (acc + piece) : piece;
      const accVisLen = getKhmerVisualLength(acc);
      const nextVisLen = getKhmerVisualLength(nextAcc);
      const isBoundModifier = /^(?:ពេក|ណាស់|ទេ|ហើយ|ដែរ|ផង|សោះ|ឡើយ|វិញ|នេះ|នោះ|ជា|គឺ|របស់|នៃ|ក្នុង|នៅ|មិន|អត់|បាន|នឹង|ប៉ុណ្ណោះ|គ្រឿង|ដៃ)[។!?៖]*$/.test(piece);
      if (acc && accVisLen >= 5 && nextVisLen > 9 && !isBoundModifier) {
        phraseUnits.push(acc);
        acc = piece;
      } else {
        acc = nextAcc;
      }
    }
    if (acc) {
      if (phraseUnits.length > 0 && getKhmerVisualLength(acc) <= 4) {
        phraseUnits[phraseUnits.length - 1] += acc;
      } else {
        phraseUnits.push(acc);
      }
    }

    for (let u = 0; u < phraseUnits.length; u++) {
      const isLastInGroup = u === phraseUnits.length - 1;
      mergedWords.push({
        text: phraseUnits[u],
        spaceAfter: isLastInGroup && !isLastGroup
      });
    }
  }

  const chunks = [];
  let curWords = [];
  let curVisChars = 0;

  for (let i = 0; i < mergedWords.length; i++) {
    const item = mergedWords[i];
    const wVisLen = Math.max(1, getKhmerVisualLength(item.text));
    const endsClause = /[។!?៖,，。！？]$/.test(item.text);
    const prevEndedWithSpace = curWords.length > 0 && curWords[curWords.length - 1].spaceAfter;

    if (
      curWords.length > 0 &&
      prevEndedWithSpace &&
      (curVisChars + wVisLen > maxCharsPerChunk || curWords.length >= maxWordsPerChunk)
    ) {
      chunks.push({ words: curWords });
      curWords = [];
      curVisChars = 0;
    } else if (curWords.length > 0 && curVisChars + wVisLen > maxCharsPerChunk + 10) {
      chunks.push({ words: curWords });
      curWords = [];
      curVisChars = 0;
    }

    curWords.push({
      text: item.text,
      spaceAfter: item.spaceAfter,
      weight: Math.max(2, wVisLen)
    });
    curVisChars += wVisLen + (item.spaceAfter ? 1 : 0);

    if (endsClause && item.spaceAfter && curVisChars >= 6) {
      chunks.push({ words: curWords });
      curWords = [];
      curVisChars = 0;
    }
  }
  if (curWords.length > 0) {
    if (curWords.length === 1 && chunks.length > 0 && getKhmerVisualLength(curWords[0].text) <= 4) {
      chunks[chunks.length - 1].words.push(curWords[0]);
    } else {
      chunks.push({ words: curWords });
    }
  }
  return chunks;
}

const FONTS_DIR = resolveUnpackedPath(path.resolve(__dirname, '../../frontend/fonts'));

function hexToAssColor(hex, alpha = '00') {
  if (!hex || typeof hex !== 'string') return null;
  const clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    const r = clean[0] + clean[0];
    const g = clean[1] + clean[1];
    const b = clean[2] + clean[2];
    return `&H${alpha}${b}${g}${r}`.toUpperCase();
  }
  if (clean.length === 6) {
    const r = clean.substring(0, 2);
    const g = clean.substring(2, 4);
    const b = clean.substring(4, 6);
    return `&H${alpha}${b}${g}${r}`.toUpperCase();
  }
  return null;
}

function normalizeCustomTextOverlay(raw = null) {
  if (!raw || typeof raw !== 'object') {
    return { enabled: false, text: '', xPercent: 0.5, yPercent: 0.08, fontSizePx: 15, textColor: '#ffffff', bgStyle: 'pill', opacityPercent: 95 };
  }
  const cleanText = String(raw.text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[{}]/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\\N')
    .slice(0, 220);
  const rawX = Number(raw.xPercent);
  const rawY = Number(raw.yPercent);
  const rawFont = Number(raw.fontSizePx);
  const rawOp = Number(raw.opacityPercent);
  const allowedBg = new Set(['outline', 'pill', 'gold_box', 'clean']);
  const bgStyle = allowedBg.has(String(raw.bgStyle || '')) ? String(raw.bgStyle) : 'pill';
  const colorRaw = String(raw.textColor || '#ffffff').trim();
  const textColor = /^#[0-9a-fA-F]{3,6}$/.test(colorRaw) ? colorRaw : '#ffffff';
  return {
    enabled: Boolean(raw.enabled && cleanText),
    text: cleanText,
    xPercent: Number.isFinite(rawX) ? Math.min(0.96, Math.max(0.04, rawX)) : 0.5,
    yPercent: Number.isFinite(rawY) ? Math.min(0.97, Math.max(0.03, rawY)) : 0.08,
    fontSizePx: Number.isFinite(rawFont) ? Math.min(40, Math.max(10, Math.round(rawFont))) : 15,
    textColor,
    bgStyle,
    opacityPercent: Number.isFinite(rawOp) ? Math.min(100, Math.max(20, Math.round(rawOp))) : 95
  };
}

function serializeAss(cues, styleName = 'tiktok', fontSize = 58, marginV = 154, wordPopEnabled = true, customColors = null, customTextOverlay = null, totalDurationSec = 36000) {
  let primaryCol = '&H00FFFFFF';
  let outlineCol = '&H00000000';
  let backCol = '&H80000000';
  let borderStyle = 1;
  let outline = 4.0;
  let shadow = 2.0;
  let highlightCol = '&H0000B8FF&'; // Default Gold active word pop

  if (styleName === 'tiktok') {
    primaryCol = '&H00FFFFFF';
    outlineCol = '&H00000000';
    outline = 3.8;
    shadow = 1.8;
    highlightCol = '&H0000B8FF&'; // Gold
  } else if (styleName === 'tiktok_gold') {
    primaryCol = '&H0000D7FF'; // Gold #ffd700
    outlineCol = '&H00000000';
    outline = 4.0;
    shadow = 2.0;
    highlightCol = '&H00FFFFFF&'; // White highlight
  } else if (styleName === 'hormozi') {
    primaryCol = '&H0000FF66'; // Lime green #00ff66
    outlineCol = '&H00000000';
    outline = 4.5;
    shadow = 2.2;
    highlightCol = '&H0000FFFF&'; // Bright yellow
  } else if (styleName === 'mrbeast') {
    primaryCol = '&H00FFFFFF';
    outlineCol = '&H00000000';
    backCol = '&H00000000'; // Deep solid black 3D shadow (no blue tint)
    outline = 4.2;
    shadow = 2.8;
    highlightCol = '&H0000FFFF&';
  } else if (styleName === 'capcut_box') {
    primaryCol = '&H00090D16'; // Dark text
    outlineCol = '&H00000000';
    backCol = '&H0000E6FF'; // Yellow box #ffe600
    borderStyle = 3;
    outline = 4.0;
    shadow = 0;
    highlightCol = '&H00FFFFFF&'; // White highlight in yellow box
  } else if (styleName === 'drama_red') {
    primaryCol = '&H00FFFFFF';
    outlineCol = '&H003C12BE'; // Ruby red outline #be123c
    outline = 4.0;
    shadow = 2.0;
    highlightCol = '&H0000B8FF&';
  } else if (styleName === 'cinema') {
    primaryCol = '&H00FFFFFF';
    outlineCol = '&H00000000';
    outline = 2.4;
    shadow = 1.4;
    highlightCol = '&H0000B8FF&';
  } else if (styleName === 'pill') {
    primaryCol = '&H00FFFFFF';
    outlineCol = '&H00000000';
    backCol = '&HB0111111'; // Dark pill
    borderStyle = 3;
    outline = 3.5;
    shadow = 0;
    highlightCol = '&H0000B8FF&';
  } else if (styleName === 'neon') {
    primaryCol = '&H00FFFFFF';
    outlineCol = '&H00C0E500'; // Cyan glow #00e5c0
    outline = 4.2;
    shadow = 2.2;
    highlightCol = '&H0000B8FF&';
  }

  // Custom color overrides if provided
  if (customColors && typeof customColors === 'object') {
    if (customColors.primaryColor) {
      const p = hexToAssColor(customColors.primaryColor);
      if (p) primaryCol = p;
    }
    if (customColors.outlineColor) {
      const o = hexToAssColor(customColors.outlineColor);
      if (o) outlineCol = o;
    }
    if (customColors.backColor) {
      const b = hexToAssColor(customColors.backColor);
      if (b) backCol = b;
    }
    if (customColors.highlightColor) {
      const h = hexToAssColor(customColors.highlightColor);
      if (h) highlightCol = h.endsWith('&') ? h : h + '&';
    }
  }

  const vMargin = Number(marginV) > 0 ? Number(marginV) : 154;
  const fSize = Number(fontSize) > 0 ? Number(fontSize) : 58;
  const normOverlay = normalizeCustomTextOverlay(customTextOverlay);
  let customStyleLine = '';
  let customDialogueLine = '';
  if (normOverlay.enabled && normOverlay.text) {
    const ovFontSize = Math.max(24, Math.round(normOverlay.fontSizePx * 3.6));
    const alphaNum = Math.min(220, Math.max(0, Math.round((1 - normOverlay.opacityPercent / 100) * 255)));
    const alphaHex = alphaNum.toString(16).padStart(2, '0').toUpperCase();
    let ovPrimary = hexToAssColor(normOverlay.textColor, alphaHex) || `&H${alphaHex}FFFFFF`;
    let ovOutlineCol = `&H${alphaHex}000000`;
    let ovBackCol = '&H80000000';
    let ovBorderStyle = 1;
    let ovOutline = 3.6;
    let ovShadow = 1.8;
    if (normOverlay.bgStyle === 'pill') {
      const boxAlpha = Math.min(235, Math.max(85, alphaNum + 95)).toString(16).padStart(2, '0').toUpperCase();
      ovBorderStyle = 3;
      ovOutlineCol = `&H${boxAlpha}180F09`;
      ovBackCol = `&H${boxAlpha}180F09`;
      ovOutline = 9.0;
      ovShadow = 0;
    } else if (normOverlay.bgStyle === 'gold_box') {
      ovPrimary = `&H${alphaHex}160D09`;
      ovBorderStyle = 3;
      ovOutlineCol = `&H${alphaHex}00D7FF`;
      ovBackCol = `&H${alphaHex}00D7FF`;
      ovOutline = 9.0;
      ovShadow = 0;
    } else if (normOverlay.bgStyle === 'clean') {
      ovBorderStyle = 1;
      ovOutline = 1.4;
      ovShadow = 2.4;
    }
    const posX = Math.round(normOverlay.xPercent * 1080);
    const posY = Math.round(normOverlay.yPercent * 1920);
    const endAss = secondsToAssTime(Math.max(10, Number(totalDurationSec) || 36000));
    customStyleLine = `\nStyle: CustomOverlayText,Kantumruy Pro,${ovFontSize},${ovPrimary},&H000000FF,${ovOutlineCol},${ovBackCol},1,0,0,0,100,100,0,0,${ovBorderStyle},${ovOutline},${ovShadow},5,24,24,24,1`;
    customDialogueLine = `Dialogue: 5,0:00:00.00,${endAss},CustomOverlayText,,0,0,0,,{\\an5\\pos(${posX},${posY})}${normOverlay.text}`;
  }

  const header = `[Script Info]
Title: Khmer Short Drama Subtitles
ScriptType: v4.00+
Collisions: Normal
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: KhmerSub,Kantumruy Pro,${fSize},${primaryCol},&H000000FF,${outlineCol},${backCol},1,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},2,40,40,${vMargin},1${customStyleLine}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = [];
  if (customDialogueLine) {
    events.push(customDialogueLine);
  }
  for (const c of cues) {
    if (!c || typeof c !== 'object') continue;
    const startSec = Math.max(0, Number(c.startSec) || 0);
    const rawEnd = Number(c.endSec);
    const endSec = Number.isFinite(rawEnd) && rawEnd > startSec ? rawEnd : startSec + 0.1;
    const rawTxt = String(c.translated || c.text || '').replace(/\r/g, '').replace(/\{/g, '(').replace(/\}/g, ')').trim();
    if (!rawTxt) continue;

    const cueDur = Math.max(0.1, endSec - startSec);
    const chunks = wordPopEnabled ? segmentTextForKaraoke(rawTxt, 24, 5) : [];
    if (!wordPopEnabled || !chunks.length || cueDur < 0.25) {
      const start = secondsToAssTime(startSec);
      const end = secondsToAssTime(endSec);
      events.push(`Dialogue: 0,${start},${end},KhmerSub,,0,0,0,,${wrapKhmerText(normalizeKhmerSpacing(rawTxt))}`);
      continue;
    }

    let totalWeight = 0;
    for (const ch of chunks) {
      ch.weight = ch.words.reduce((acc, w) => acc + w.weight, 0);
      totalWeight += ch.weight;
    }
    totalWeight = Math.max(1, totalWeight);

    // Sync word-by-word highlight to actual spoken duration (or 86% of cue window) with slight onset lead
    // so text never lags behind the spoken voice, while holding the final word until endSec.
    const rawSpeechDur = Number(c._spokenDurSec) > 0.15
      ? Math.min(cueDur, Number(c._spokenDurSec) * 0.90)
      : cueDur * 0.86;
    const activeSpeakDur = Math.max(0.18, rawSpeechDur);

    let accumWeight = 0;
    let groupStartSec = startSec;
    for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
      const ch = chunks[cIdx];
      for (let wIdx = 0; wIdx < ch.words.length; wIdx++) {
        const w = ch.words[wIdx];
        const isLastWordOfCue = (cIdx === chunks.length - 1) && (wIdx === ch.words.length - 1);
        const wStartSec = groupStartSec;
        accumWeight += w.weight;
        const wEndSec = isLastWordOfCue
          ? Math.max(wStartSec + 0.05, endSec)
          : (startSec + (accumWeight / totalWeight) * activeSpeakDur);
        if (!isLastWordOfCue && wEndSec - wStartSec < 0.02) continue;
        groupStartSec = wEndSec;

        const lineText = ch.words.map((wordObj, idx) => {
          const sep = wordObj.spaceAfter ? ' ' : '';
          if (idx === wIdx) {
            return `{\\c${highlightCol}}${wordObj.text}{\\c${primaryCol}&}${sep}`;
          }
          return `${wordObj.text}${sep}`;
        }).join('').trim();

        events.push(`Dialogue: 0,${secondsToAssTime(wStartSec)},${secondsToAssTime(wEndSec)},KhmerSub,,0,0,0,,${lineText}`);
      }
    }
  }

  return header + events.join('\n') + '\n';
}

function makeEvenDimension(val) {
  return Math.max(2, Math.round(val / 2) * 2);
}

/**
 * Compute target scale filter expression when scaling or normalizing dimensions.
 */
function getScaleFilterExpr(resolution = 'source', mediaInfo = null, scaleFlags = 'lanczos') {
  const safeScaleFlags = scaleFlags === 'bilinear' ? 'bilinear' : 'lanczos';
  const spec = RESOLUTION_SPECS[resolution];
  if (!spec) {
    if (
      !mediaInfo ||
      mediaInfo.width <= 0 ||
      mediaInfo.height <= 0 ||
      (mediaInfo.width % 2 !== 0) ||
      (mediaInfo.height % 2 !== 0)
    ) {
      return `scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=${safeScaleFlags}`;
    }
    return '';
  }

  if (mediaInfo && mediaInfo.width > 0 && mediaInfo.height > 0) {
    const { width, height } = mediaInfo;
    let targetW;
    let targetH;
    if (width > height) {
      targetW = spec.longEdge;
      targetH = makeEvenDimension((height * spec.longEdge) / width);
    } else if (height > width) {
      targetH = spec.longEdge;
      targetW = makeEvenDimension((width * spec.longEdge) / height);
    } else {
      targetW = spec.shortEdge;
      targetH = spec.shortEdge;
    }
    if (targetW === width && targetH === height) {
      return '';
    }
    return `scale=${targetW}:${targetH}:flags=${safeScaleFlags}`;
  }

  return `scale='if(gt(iw,ih),${spec.longEdge},if(eq(iw,ih),${spec.shortEdge},-2))':'if(gt(iw,ih),-2,${spec.longEdge})':flags=${safeScaleFlags}`;
}

function normalizeAntiCopyrightOptions(raw = {}) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const enabled = Boolean(src.enabled);
  const rawColor = String(src.colorShift || 'none').toLowerCase();
  const colorAliasMap = { vivid: 'cinema_crisp', warm: 'warm_vivid' };
  const mappedColor = colorAliasMap[rawColor] || rawColor;
  const allowedColors = new Set(['none', 'warm_vivid', 'cinema_crisp', 'bright_pop']);
  const colorShift = allowedColors.has(mappedColor) ? mappedColor : 'none';
  let zoomRaw = Number(src.zoomPercent);
  if (Number.isFinite(zoomRaw) && zoomRaw >= 100 && zoomRaw <= 125) {
    zoomRaw -= 100;
  }
  const zoomPercent = enabled && Number.isFinite(zoomRaw) ? Math.min(25, Math.max(0, Math.round(zoomRaw))) : 0;
  const speedRaw = Number(src.speedRate);
  const speedRate = enabled && Number.isFinite(speedRaw) ? Number(Math.min(1.25, Math.max(0.85, speedRaw)).toFixed(2)) : 1.0;
  const pitchRaw = src.audioPitchPct !== undefined
    ? Number(src.audioPitchPct)
    : (src.pitchSemitones !== undefined ? Math.round(Number(src.pitchSemitones) * 5.95) : 0);
  const audioPitchPct = enabled && Number.isFinite(pitchRaw) ? Math.min(12, Math.max(-12, Math.round(pitchRaw))) : 0;
  return {
    enabled,
    mirror: enabled && Boolean(src.mirror),
    zoomPercent,
    speedRate,
    colorShift: enabled ? colorShift : 'none',
    audioPitchPct,
    vignette: enabled && Boolean(src.vignette),
    stripMetadata: enabled ? (src.stripMetadata !== false) : false
  };
}

function buildAntiCopyrightVideoPrefix(cr, resolution = 'source', mediaInfo = null, scaleFlags = 'lanczos') {
  if (!cr || !cr.enabled) return [];
  const safeScaleFlags = scaleFlags === 'bilinear' ? 'bilinear' : 'lanczos';
  const parts = [];
  if (cr.mirror) {
    parts.push('hflip');
  }
  if (cr.zoomPercent > 0) {
    const z = (1 + cr.zoomPercent / 100).toFixed(4);
    parts.push(`crop=trunc(iw/${z}/2)*2:trunc(ih/${z}/2)*2:(iw-ow)/2:(ih-oh)/2`);
    if (!RESOLUTION_SPECS[resolution]) {
      if (mediaInfo && mediaInfo.width > 0 && mediaInfo.height > 0) {
        parts.push(`scale=${makeEvenDimension(mediaInfo.width)}:${makeEvenDimension(mediaInfo.height)}:flags=${safeScaleFlags},setsar=1`);
      } else {
        parts.push(`scale=ceil(iw*${z}/2)*2:ceil(ih*${z}/2)*2:flags=${safeScaleFlags},setsar=1`);
      }
    }
  }
  if (cr.colorShift === 'warm_vivid') {
    parts.push('eq=contrast=1.06:saturation=1.10:brightness=0.02');
  } else if (cr.colorShift === 'cinema_crisp') {
    parts.push('eq=contrast=1.10:saturation=1.14:brightness=-0.02,unsharp=3:3:0.4');
  } else if (cr.colorShift === 'bright_pop') {
    parts.push('eq=contrast=1.05:saturation=1.12:brightness=0.04');
  }
  if (cr.vignette) {
    parts.push('vignette=angle=PI/5');
  }
  if (Math.abs(cr.speedRate - 1.0) >= 0.005) {
    parts.push(`setpts=PTS/${cr.speedRate.toFixed(4)}`);
  }
  return parts;
}

function buildAntiCopyrightAudioTail(cr) {
  if (!cr || !cr.enabled) return '';
  const speed = Number(cr.speedRate) || 1.0;
  const pitchPct = Number(cr.audioPitchPct) || 0;
  const hasSpeed = Math.abs(speed - 1.0) >= 0.005;
  const hasPitch = Math.abs(pitchPct) >= 1;
  if (!hasSpeed && !hasPitch) return '';
  if (hasPitch) {
    const ratio = Number((1 + pitchPct / 100).toFixed(4));
    const netTempo = Number(Math.min(2.0, Math.max(0.5, speed / ratio)).toFixed(4));
    return `,aresample=44100,asetrate=44100*${ratio},aresample=44100,atempo=${netTempo}`;
  }
  const safeTempo = Number(Math.min(2.0, Math.max(0.5, speed)).toFixed(4));
  return `,atempo=${safeTempo}`;
}

/**
 * Build FFmpeg video filter chain with optional anti-copyright transforms, HD upscaling, subtitle mask, and ASS burn-in.
 */
function buildExportFilter(assFilePath, options = {}) {
  const {
    maskEnabled = true,
    maskMode = 'feathered',
    maskXPercent,
    maskYPercent = 0.78,
    maskHPercent = 0.07,
    maskWPercent = 0.92,
    maskBlurSigma = 12,
    resolution = 'source',
    mediaInfo = null,
    burnSubtitles = true,
    antiCopyright = null,
    fastRender = false
  } = options;

  const escapedAss = assFilePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "'\\\\\\''");
  const escapedFontsDir = FONTS_DIR
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "'\\\\\\''");
  const assFilter = (process.platform !== 'win32' && fs.existsSync(FONTS_DIR))
    ? `ass='${escapedAss}':fontsdir='${escapedFontsDir}'`
    : `ass='${escapedAss}'`;
  const cr = normalizeAntiCopyrightOptions(antiCopyright);
  const effectiveMediaInfo = (cr.enabled && cr.zoomPercent > 0 && mediaInfo && mediaInfo.width > 0 && mediaInfo.height > 0)
    ? {
        width: makeEvenDimension(mediaInfo.width / (1 + cr.zoomPercent / 100)),
        height: makeEvenDimension(mediaInfo.height / (1 + cr.zoomPercent / 100))
      }
    : (cr.enabled && cr.zoomPercent > 0 ? null : mediaInfo);
  const scaleFlags = fastRender ? 'bilinear' : 'lanczos';
  const scaleExpr = getScaleFilterExpr(resolution, effectiveMediaInfo, scaleFlags);
  const crFilters = buildAntiCopyrightVideoPrefix(cr, resolution, mediaInfo, scaleFlags);
  const preChain = [...crFilters, scaleExpr].filter(Boolean).join(',');
  const subTail = burnSubtitles ? assFilter : '';

  if (!maskEnabled) {
    const simpleChain = [preChain, subTail].filter(Boolean).join(',');
    return simpleChain || 'null';
  }

  const safeW = Number(Math.min(1, Math.max(0.05, Number(maskWPercent) || 0.92)).toFixed(4));
  const safeH = Number(Math.min(0.85, Math.max(0.02, Number(maskHPercent) || 0.07)).toFixed(4));
  const rawX = (maskXPercent !== undefined && maskXPercent !== null && maskXPercent !== '' && Number.isFinite(Number(maskXPercent)))
    ? Number(maskXPercent)
    : (1 - safeW) / 2;
  const maxX = Math.max(0, Math.floor((1 - safeW) * 10000) / 10000);
  const safeX = Number(Math.min(Math.max(0, rawX), maxX).toFixed(4));
  const rawY = (maskYPercent !== undefined && maskYPercent !== null && maskYPercent !== '' && Number.isFinite(Number(maskYPercent)))
    ? Number(maskYPercent)
    : 0.78;
  const maxY = Math.max(0, Math.floor((1 - safeH) * 10000) / 10000);
  const safeY = Number(Math.min(Math.max(0, rawY), maxY).toFixed(4));
  const parsedSigma = Number(maskBlurSigma);
  const safeBlurSigma = Number((Number.isFinite(parsedSigma) ? Math.min(40, Math.max(2, parsedSigma)) : 12).toFixed(1));

  if (maskMode === 'cinema_bar') {
    const box = `drawbox=x=0:y=ih*${safeY}:w=iw:h=ih*${safeH}:color=black@0.75:t=fill`;
    return [preChain, box, subTail].filter(Boolean).join(',');
  }
  if (maskMode === 'black') {
    const box = `drawbox=x=iw*${safeX}:y=ih*${safeY}:w=iw*${safeW}:h=ih*${safeH}:color=black@0.92:t=fill`;
    return [preChain, box, subTail].filter(Boolean).join(',');
  }

  const brightnessExpr = maskMode === 'frosted' ? ',eq=brightness=0.06' : '';
  const tailPass = subTail ? `[vmasked]${subTail}` : '[vmasked]null';
  // Use bounded multi-pass boxblur only when fastRender=true so default builds preserve gblur quality & tests
  const fastBlurRadius = Math.max(2, Math.min(18, Math.round(safeBlurSigma * 0.85)));
  const maskBlurOp = fastRender
    ? `boxblur=lr=max(1\\,min(floor(min(w\\,h)/2)-1\\,${fastBlurRadius})):lp=2:cr=max(0\\,min(floor(min(cw\\,ch)/2)-1\\,${fastBlurRadius})):cp=2`
    : `gblur=sigma=${safeBlurSigma}`;
  const blurTail = `[copy]crop=iw*${safeW}:ih*${safeH}:iw*${safeX}:ih*${safeY},${maskBlurOp}${brightnessExpr}[blurred];[orig][blurred]overlay=W*${safeX}:H*${safeY}[vmasked];${tailPass}`;

  if (preChain) {
    return `[0:v]${preChain}[vscaled];[vscaled]split[orig][copy];${blurTail}`;
  }
  return `[0:v]split[orig][copy];${blurTail}`;
}

function toFilterComplexVideo(videoFilter, outLabel = 'vout') {
  if (videoFilter.startsWith('[0:v]')) {
    return `${videoFilter}[${outLabel}]`;
  }
  return `[0:v]${videoFilter}[${outLabel}]`;
}

function getResolvedOutputDimensions(resolution = 'source', mediaInfo = null) {
  const baseW = (mediaInfo && mediaInfo.width > 0) ? mediaInfo.width : 1080;
  const baseH = (mediaInfo && mediaInfo.height > 0) ? mediaInfo.height : 1920;
  const spec = RESOLUTION_SPECS[resolution];
  if (!spec) {
    return { width: baseW, height: baseH };
  }
  if (baseW > baseH) {
    return {
      width: spec.longEdge,
      height: makeEvenDimension((baseH * spec.longEdge) / baseW)
    };
  }
  if (baseH > baseW) {
    return {
      width: makeEvenDimension((baseW * spec.longEdge) / baseH),
      height: spec.longEdge
    };
  }
  return { width: spec.shortEdge, height: spec.shortEdge };
}

function resolveSponsorOverlaySpec(options = {}) {
  const {
    sponsorEnabled = false,
    sponsorPath = '',
    sponsorPosition = 'top-right',
    sponsorScale = 22,
    sponsorOpacity = 100,
    sponsorXPercent,
    sponsorYPercent,
    resolution = 'source',
    mediaInfo = null
  } = options;

  if (!sponsorEnabled || typeof sponsorPath !== 'string' || !sponsorPath.trim()) {
    return null;
  }

  const normalizedPath = path.normalize(sponsorPath.trim());
  if (!path.isAbsolute(normalizedPath)) {
    const err = new Error('sponsorPath must be an absolute path');
    err.statusCode = 400;
    throw err;
  }
  if (isBlockedNetworkOrStreamPath(sponsorPath, normalizedPath)) {
    const err = new Error('Invalid or network path not permitted');
    err.statusCode = 403;
    throw err;
  }
  if (!fs.existsSync(normalizedPath)) {
    const err = new Error('Sponsor/Logo file not found');
    err.statusCode = 404;
    throw err;
  }

  const ext = path.extname(normalizedPath).toLowerCase();
  if (ext === '.svg') {
    const err = new Error('មិនគាំទ្ររូបភាព .SVG ផ្ទាល់ពេល Export ទេ — សូមប្ដូរជា PNG, JPG, WEBP, GIF ឬ MP4 ជំនួស។');
    err.statusCode = 400;
    throw err;
  }
  const isGif = ext === '.gif';
  const isStaticImage = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']).has(ext);
  let inputArgs;
  if (isStaticImage) {
    inputArgs = ['-loop', '1', '-i', normalizedPath];
  } else if (isGif) {
    inputArgs = ['-ignore_loop', '0', '-i', normalizedPath];
  } else {
    inputArgs = ['-stream_loop', '-1', '-i', normalizedPath];
  }

  const outDims = getResolvedOutputDimensions(resolution, mediaInfo);
  const rawScale = Number(sponsorScale);
  const scaleRatio = Number.isFinite(rawScale) && rawScale > 0
    ? (rawScale > 1 ? rawScale / 100 : rawScale)
    : 0.22;
  const clampedScale = Math.min(0.75, Math.max(0.05, scaleRatio));
  const targetWidth = makeEvenDimension(Math.round(outDims.width * clampedScale));

  const rawOpacity = Number(sponsorOpacity);
  const opacityRatio = Number.isFinite(rawOpacity) && rawOpacity > 0
    ? (rawOpacity > 1 ? rawOpacity / 100 : rawOpacity)
    : 1.0;
  const clampedOpacity = Math.min(1.0, Math.max(0.15, opacityRatio));

  const pos = String(sponsorPosition || 'top-right').trim().toLowerCase();
  let xExpr = 'W-w-W*0.035';
  let yExpr = 'H*0.035';
  if (pos === 'top-left') {
    xExpr = 'W*0.035';
    yExpr = 'H*0.035';
  } else if (pos === 'top-center') {
    xExpr = '(W-w)/2';
    yExpr = 'H*0.035';
  } else if (pos === 'bottom-left') {
    xExpr = 'W*0.035';
    yExpr = 'H-h-H*0.06';
  } else if (pos === 'bottom-center') {
    xExpr = '(W-w)/2';
    yExpr = 'H-h-H*0.06';
  } else if (pos === 'bottom-right') {
    xExpr = 'W-w-W*0.035';
    yExpr = 'H-h-H*0.06';
  } else if (pos === 'custom' && Number.isFinite(Number(sponsorXPercent)) && Number.isFinite(Number(sponsorYPercent))) {
    const cx = Math.min(0.95, Math.max(0, Number(sponsorXPercent))).toFixed(4);
    const cy = Math.min(0.95, Math.max(0, Number(sponsorYPercent))).toFixed(4);
    xExpr = `min(W-w\\,max(0\\,W*${cx}))`;
    yExpr = `min(H-h\\,max(0\\,H*${cy}))`;
  }

  return {
    enabled: true,
    filePath: normalizedPath,
    mediaType: (isStaticImage || isGif) ? 'image' : 'video',
    position: pos,
    scalePercent: Math.round(clampedScale * 100),
    opacityRatio: clampedOpacity,
    targetWidth,
    xExpr,
    yExpr,
    inputArgs
  };
}

function buildVideoGraphWithSponsor(videoFilter, outLabel = 'vout', sponsorSpecOrList = null, scaleFlags = 'lanczos') {
  const rawList = Array.isArray(sponsorSpecOrList) ? sponsorSpecOrList : [sponsorSpecOrList];
  const activeList = rawList.filter(s => s && s.enabled && s.inputIndex >= 1);
  if (activeList.length === 0) {
    return toFilterComplexVideo(videoFilter, outLabel);
  }
  const safeScaleFlags = scaleFlags === 'bilinear' ? 'bilinear' : 'lanczos';
  const parts = [];
  let prevLabel = 'vpre_sponsor';
  parts.push(toFilterComplexVideo(videoFilter, prevLabel));
  for (let i = 0; i < activeList.length; i++) {
    const spec = activeList[i];
    const isLast = i === activeList.length - 1;
    const ovLabel = activeList.length === 1 ? 'vsponsor' : `vsponsor_${i}`;
    const nextLabel = isLast ? outLabel : `vpre_ov${i + 1}`;
    const { inputIndex, targetWidth, opacityRatio, xExpr, yExpr } = spec;
    const alphaFilter = opacityRatio < 0.995 ? `,colorchannelmixer=aa=${opacityRatio.toFixed(2)}` : '';
    const formatTail = isLast ? ',format=yuv420p' : '';
    parts.push(`[${inputIndex}:v]scale=${targetWidth}:-2:flags=${safeScaleFlags},format=rgba${alphaFilter}[${ovLabel}]`);
    parts.push(`[${prevLabel}][${ovLabel}]overlay=x=${xExpr}:y=${yExpr}:shortest=1:format=auto${formatTail}[${nextLabel}]`);
    prevLabel = nextLabel;
  }
  return parts.join(';');
}

/**
 * Probe video/audio metadata directly via FFmpeg without requiring ffprobe.
 */
function parseMediaInfoFromStderr(stderr) {
  let durationSec = 0;
  const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (durMatch) {
    durationSec = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
  }

  let width = 0;
  let height = 0;
  const videoMatch = stderr.match(/Stream #\d+:\d+[^:]*:\s*Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})(?=[\s,\[])/);
  if (videoMatch) {
    width = parseInt(videoMatch[1], 10);
    height = parseInt(videoMatch[2], 10);
  }
  const rotMatch = stderr.match(/displaymatrix:\s*rotation\s+of\s+(-?\d+(?:\.\d+)?)\s*degrees|rotate\s*:\s*(-?\d+)/i);
  if (rotMatch && width > 0 && height > 0) {
    const rotDeg = Math.round(Math.abs(parseFloat(rotMatch[1] || rotMatch[2] || '0')));
    if (rotDeg % 180 === 90) {
      const tmpW = width;
      width = height;
      height = tmpW;
    }
  }

  let videoBitrateKbps = 0;
  if (videoMatch) {
    const vBrMatch = stderr.match(/Stream #\d+:\d+[^:]*:\s*Video:[^\n]*?,\s*(\d+)\s*kb\/s/);
    if (vBrMatch) videoBitrateKbps = parseInt(vBrMatch[1], 10) || 0;
  }
  if (!videoBitrateKbps) {
    const totalBrMatch = stderr.match(/Duration:[^\n]*bitrate:\s*(\d+)\s*kb\/s/);
    if (totalBrMatch) videoBitrateKbps = parseInt(totalBrMatch[1], 10) || 0;
  }

  const hasAudio = /Stream #\d+:\d+[^:]*:\s*Audio:/m.test(stderr);
  return { durationSec, width, height, hasAudio, videoBitrateKbps };
}

function probeMediaInfo(filePath) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(info);
    };
    const proc = spawn(FFMPEG_BIN, ['-hide_banner', '-i', filePath], { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { try { proc.kill(); } catch (_) {} }
      finish({ durationSec: 0, width: 0, height: 0, hasAudio: false, videoBitrateKbps: 0 });
    }, 8000);
    if (proc.stdout) proc.stdout.resume();
    proc.stderr.on('data', d => {
      if (stderr.length < 131072) stderr += d.toString();
    });
    proc.on('error', () => finish({ durationSec: 0, width: 0, height: 0, hasAudio: true, videoBitrateKbps: 0 }));
    proc.on('close', () => {
      const info = parseMediaInfoFromStderr(stderr);
      if (!info.videoBitrateKbps && info.durationSec > 0) {
        try {
          const st = fs.statSync(filePath);
          if (st && st.size > 0) {
            info.videoBitrateKbps = Math.max(200, Math.round((st.size * 8) / info.durationSec / 1000) - 96);
          }
        } catch (_) {}
      }
      finish(info);
    });
  });
}

function detectHardwareEncoder() {
  const now = Date.now();
  if (cachedHwEncoder && typeof cachedHwEncoder === 'string') {
    return cachedHwEncoder;
  }
  if (cachedHwEncoder === null && (now - cachedHwEncoderCheckedAt) < HW_ENCODER_NEGATIVE_CACHE_MS) {
    return null;
  }
  cachedHwEncoderCheckedAt = now;
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
    const res = spawnSync(FFMPEG_BIN, [
      '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.05',
      '-c:v', enc, '-f', 'null', '-'
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (res.status === 0) {
      cachedHwEncoder = enc;
      return enc;
    }
  }
  cachedHwEncoder = null;
  return null;
}

/**
 * Compute adaptive VBV maxrate ceiling (kbps) from preset, output resolution, and source bitrate
 * so re-encoding low-bitrate web dramas never bloats file size 10-20x.
 */
function computeAdaptiveMaxrateKbps({ qualityPreset = 'balanced', resolution = 'source', mediaInfo = null } = {}) {
  const presetKey = MAXRATE_TIERS_KBPS[qualityPreset] ? qualityPreset : 'balanced';
  const tiers = MAXRATE_TIERS_KBPS[presetKey];
  const srcW = Number(mediaInfo && mediaInfo.width) || 0;
  const srcH = Number(mediaInfo && mediaInfo.height) || 0;
  const longEdge = Math.max(srcW, srcH);

  let tier = '1080p';
  if (resolution === '4k' || (resolution === 'source' && longEdge >= 3000)) {
    tier = '4k';
  } else if (resolution === '720p' || (resolution === 'source' && longEdge > 0 && longEdge <= 1360)) {
    tier = '720p';
  }

  const tierCap = tiers[tier];
  const srcKbps = Number(mediaInfo && mediaInfo.videoBitrateKbps) || 0;
  if (srcKbps > 0 && presetKey !== 'ultra') {
    const minFloor = tier === '720p' ? 950 : (tier === '4k' ? 3500 : 1400);
    const multiplier = presetKey === 'fast' ? 2.0 : (presetKey === 'balanced' ? 2.4 : 3.2);
    const sourceGuided = Math.max(minFloor, Math.round(srcKbps * multiplier));
    return Math.min(tierCap, sourceGuided);
  }
  return tierCap;
}

function getAudioBitrateForPreset(qualityPreset = 'balanced') {
  if (qualityPreset === 'ultra') return '192k';
  if (qualityPreset === 'hd') return '160k';
  return '128k';
}

function estimateExportSize({
  qualityPreset = 'balanced',
  resolution = 'source',
  durationSec = 0,
  mediaInfo = null,
  fastCopy = false,
  speedRate = 1.0
} = {}) {
  const rawDur = Math.max(0, Number(durationSec) || Number(mediaInfo && mediaInfo.durationSec) || 0);
  const effSpeed = Number.isFinite(Number(speedRate)) && Number(speedRate) > 0 ? Number(speedRate) : 1.0;
  const effDurSec = rawDur > 0 ? (rawDur / effSpeed) : 0;
  const presetKey = QUALITY_PROFILES[qualityPreset] ? qualityPreset : 'balanced';
  const outDims = getResolvedOutputDimensions(resolution, mediaInfo);
  const audioBitrate = getAudioBitrateForPreset(presetKey);
  const audioBitrateKbps = parseInt(audioBitrate, 10) || 128;

  if (fastCopy) {
    const srcVbps = Number(mediaInfo && mediaInfo.videoBitrateKbps) || 1000;
    const totalKbps = srcVbps + audioBitrateKbps;
    const estMB = effDurSec > 0 ? Math.round((totalKbps * effDurSec) / 8 / 1024) : 0;
    return {
      mode: 'copy',
      qualityPreset: presetKey,
      resolution,
      outputWidth: outDims.width,
      outputHeight: outDims.height,
      durationSec: Number(effDurSec.toFixed(1)),
      maxrateKbps: srcVbps,
      audioBitrateKbps,
      estimatedBitrateKbps: totalKbps,
      estimatedSizeMB: estMB,
      maxSizeMB: estMB
    };
  }

  const maxrateKbps = computeAdaptiveMaxrateKbps({
    qualityPreset: presetKey,
    resolution,
    mediaInfo
  });
  const avgFactor = AVG_BITRATE_FACTOR[presetKey] || 0.85;
  const estimatedVideoKbps = Math.max(400, Math.round(maxrateKbps * avgFactor));
  const estimatedBitrateKbps = estimatedVideoKbps + audioBitrateKbps;
  const maxTotalKbps = maxrateKbps + audioBitrateKbps;
  const estimatedSizeMB = effDurSec > 0 ? Math.round((estimatedBitrateKbps * effDurSec) / 8 / 1024) : 0;
  const maxSizeMB = effDurSec > 0 ? Math.round((maxTotalKbps * effDurSec) / 8 / 1024) : 0;

  return {
    mode: 'reencode',
    qualityPreset: presetKey,
    resolution,
    outputWidth: outDims.width,
    outputHeight: outDims.height,
    durationSec: Number(effDurSec.toFixed(1)),
    maxrateKbps,
    audioBitrateKbps,
    estimatedBitrateKbps,
    estimatedSizeMB,
    maxSizeMB
  };
}

function buildVideoEncodingArgs(qualityPreset = 'balanced', requestedEncoder = 'cpu', encodeContext = null) {
  const presetKey = QUALITY_PROFILES[qualityPreset] ? qualityPreset : 'balanced';
  const profile = QUALITY_PROFILES[presetKey];
  let encoderName = 'libx264';

  if (requestedEncoder === 'auto' || requestedEncoder === 'gpu') {
    const hw = detectHardwareEncoder();
    if (hw && profile[hw]) {
      encoderName = hw;
    }
  } else if (profile[requestedEncoder]) {
    encoderName = requestedEncoder;
  }

  let baseArgs = [...profile[encoderName]];
  if (encodeContext && typeof encodeContext === 'object') {
    const maxrateKbps = computeAdaptiveMaxrateKbps({
      qualityPreset: presetKey,
      resolution: encodeContext.resolution || 'source',
      mediaInfo: encodeContext.mediaInfo || null
    });
    if (maxrateKbps > 0) {
      if (encoderName === 'h264_qsv') {
        // QSV ICQ (-global_quality) ignores VBV caps; adding -maxrate silently flips it to a low-quality QVBR.
        // Use an explicit VBR target so Intel output matches the size estimate and keeps quality predictable.
        const gqIdx = baseArgs.indexOf('-global_quality');
        if (gqIdx !== -1) baseArgs.splice(gqIdx, 2);
        const targetKbps = Math.max(400, Math.round(maxrateKbps * (AVG_BITRATE_FACTOR[presetKey] || 0.85)));
        baseArgs.push('-b:v', `${targetKbps}k`);
      }
      baseArgs.push('-maxrate', `${maxrateKbps}k`, '-bufsize', `${maxrateKbps * 2}k`);
    }
  }

  return {
    encoderName,
    args: [...baseArgs, '-movflags', '+faststart']
  };
}

/**
 * Compute natural speedup tempo so long Khmer dub lines do not overlap the next cue.
 */
function computeCueTempo(clipDurSec, startSec, endSec, nextStartSec, autoFitTiming = true) {
  if (!autoFitTiming || !Number.isFinite(clipDurSec) || clipDurSec <= 0) {
    return 1.0;
  }
  const cueSlot = Number.isFinite(endSec) && endSec > startSec ? endSec - startSec : clipDurSec;
  const softCeiling = Math.max(cueSlot * 1.25, cueSlot + 0.6);
  let allowedDur = softCeiling;

  if (Number.isFinite(nextStartSec) && nextStartSec > startSec + 0.05) {
    const untilNext = Math.max(0.25, nextStartSec - startSec - 0.06);
    allowedDur = Math.min(softCeiling, Math.max(cueSlot, untilNext));
    if (untilNext < cueSlot) {
      allowedDur = untilNext;
    }
  }

  if (clipDurSec <= allowedDur * 1.05) {
    return 1.0;
  }
  return Math.min(1.55, Number((clipDurSec / allowedDur).toFixed(3)));
}

function buildTempoFilterChain(tempo) {
  if (!Number.isFinite(tempo) || Math.abs(tempo - 1.0) < 0.03) {
    return '';
  }
  const parts = [];
  let rem = tempo;
  while (rem > 2.0) {
    parts.push('atempo=2.0');
    rem /= 2.0;
  }
  while (rem < 0.5) {
    parts.push('atempo=0.5');
    rem /= 0.5;
  }
  parts.push(`atempo=${rem.toFixed(3)}`);
  return ',' + parts.join(',');
}

function isValidAudioFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > MIN_VALID_AUDIO_BYTES;
  } catch (_) {
    return false;
  }
}

/**
 * Normalize spoken cue text for boundary duplicate comparison.
 */
function normalizeDubClipText(s) {
  return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * Remove accidental chunk-boundary duplicate cues and strictly stagger/fit
 * adjacent dubbing clips so two Khmer voices never speak over each other.
 */
function enforceNonOverlappingDubSchedule(clips, autoFitTiming = true) {
  if (!Array.isArray(clips) || clips.length === 0) return clips;
  clips.sort((a, b) => a.startSec - b.startSec || a.cueIndex - b.cueIndex);

  // 1. Drop near-simultaneous chunk-boundary duplicate lines (e.g. startSec within 0.25s with overlapping text)
  const deduped = [];
  for (const clip of clips) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(clip.startSec - prev.startSec) <= 0.25) {
      const pNorm = normalizeDubClipText(prev.spokenText);
      const cNorm = normalizeDubClipText(clip.spokenText);
      const minLen = Math.min(pNorm.length, cNorm.length);
      if (minLen >= 2 && (pNorm === cNorm || pNorm.includes(cNorm) || cNorm.includes(pNorm))) {
        if (cNorm.length > pNorm.length) {
          deduped[deduped.length - 1] = {
            ...clip,
            startSec: Math.min(prev.startSec, clip.startSec),
            endSec: Math.max(prev.endSec, clip.endSec)
          };
        }
        continue;
      }
    }
    deduped.push(clip);
  }
  clips.length = 0;
  clips.push(...deduped);

  if (!autoFitTiming) {
    for (const c of clips) c.tempo = 1.0;
    return clips;
  }

  // 2. Ensure strictly increasing onset times and fit each clip inside its slot before the next speaker
  for (let i = 0; i < clips.length; i++) {
    const cur = clips[i];
    const next = clips[i + 1];
    const rawDur = Number(cur.clipDurSec) || 0;
    // Account for ~0.22s trailing/leading Edge TTS silence trimmed in renderDubMasterWav
    const effDur = rawDur > 0.65 ? Math.max(0.35, rawDur - 0.22) : rawDur;
    const nextStartSec = next ? next.startSec : Infinity;

    cur.tempo = computeCueTempo(effDur, cur.startSec, cur.endSec, nextStartSec, true);

    if (next) {
      const predictedEnd = cur.startSec + (effDur / Math.max(1, cur.tempo));
      if (predictedEnd > next.startSec - 0.03) {
        const overflow = (predictedEnd + 0.04) - next.startSec;
        const afterNext = clips[i + 2];
        const nextDur = (Number(next.clipDurSec) || 1.2) > 0.65
          ? Math.max(0.35, (Number(next.clipDurSec) || 1.2) - 0.22)
          : (Number(next.clipDurSec) || 1.2);
        const slackAfterNext = afterNext
          ? Math.max(0, afterNext.startSec - (next.startSec + nextDur / 1.25) - 0.06)
          : 0.9;
        const nudgeForward = Math.max(0, Math.min(0.45, overflow, slackAfterNext));
        if (nudgeForward > 0.02) {
          next.startSec = Number((next.startSec + nudgeForward).toFixed(3));
        }

        // If two genuinely different lines still start too close (< 0.35s), separate onsets cleanly
        if (next.startSec - cur.startSec < 0.35) {
          const minTalkSpan = Math.min(1.1, Math.max(0.4, effDur / 1.65));
          next.startSec = Number((cur.startSec + minTalkSpan + 0.04).toFixed(3));
          if (next.endSec <= next.startSec + 0.4) {
            next.endSec = Number((next.startSec + 1.2).toFixed(3));
          }
        }

        const finalSlot = Math.max(0.35, Number((next.startSec - cur.startSec - 0.03).toFixed(3)));
        if ((effDur / Math.max(1, cur.tempo)) > finalSlot) {
          cur.tempo = Math.min(1.75, Number((effDur / finalSlot).toFixed(3)));
        }
        cur.maxSlotSec = finalSlot;
      }
    }
  }
  return clips;
}

/**
 * Resolve or synthesize cached TTS audio files and measure durations in bounded concurrency.
 */
async function prepareCueAudioClips(cues, options = {}) {
  const {
    autoGenerateMissingTts = true,
    autoFitTiming = true,
    ttsEngine = '',
    castMode = '',
    fixedVoice = '',
    strictVoice = true,
    voicePitch = '',
    voiceRate = '',
    req = null,
    onProgress = null,
    isCancelled = () => false
  } = options;

  const cacheDir = ttsRouter.getAudioCacheDir();
  const candidates = [];
  const trimmedFixedVoice = typeof fixedVoice === 'string' ? fixedVoice.trim() : '';
  const lockSingleVoice = trimmedFixedVoice
    ? trimmedFixedVoice
    : (String(castMode || '').trim().toLowerCase() === 'single'
      ? (cues.find(c => c && typeof c.voice === 'string' && c.voice.trim())?.voice?.trim() || 'Sovereign King')
      : '');

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (!cue || typeof cue !== 'object') continue;
    const spokenText = String(cue.translated || cue.text || '').replace(/\r/g, '').trim();
    if (!spokenText) continue;
    const startSec = Math.max(0, Number(cue.startSec) || 0);
    const rawEnd = Number(cue.endSec);
    const endSec = Number.isFinite(rawEnd) && rawEnd > startSec ? rawEnd : startSec + 1.5;
    const itemPitch = (cue.pitch !== undefined && cue.pitch !== null && cue.pitch !== '')
      ? cue.pitch
      : (voicePitch || undefined);
    const itemRate = (cue.rate !== undefined && cue.rate !== null && cue.rate !== '')
      ? cue.rate
      : (voiceRate || undefined);
    candidates.push({
      cueIndex: i,
      startSec,
      endSec,
      spokenText,
      voice: lockSingleVoice || cue.voice || 'Sovereign King',
      pitch: itemPitch,
      rate: itemRate
    });
  }

  candidates.sort((a, b) => a.startSec - b.startSec);

  const clips = [];
  let completed = 0;
  let droppedCount = 0;
  let cursor = 0;
  let abortError = null;
  const workerCount = Math.min(10, Math.max(1, candidates.length));

  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < candidates.length && !abortError) {
      if (isCancelled()) {
        const cancelErr = new Error('Export cancelled by user');
        cancelErr.cancelled = true;
        abortError = cancelErr;
        throw cancelErr;
      }
      const item = candidates[cursor++];
      if (!item) break;

      const ttsOpts = {
        engine: 'edge',
        strictVoice: strictVoice !== false,
        ...(item.pitch !== undefined ? { pitch: item.pitch } : {}),
        ...(item.rate !== undefined ? { rate: item.rate } : {})
      };
      const key = ttsRouter.getAudioCacheKey(item.spokenText, item.voice, ttsOpts);
      let filePath = path.join(cacheDir, `${key}.mp3`);

      if (!isValidAudioFile(filePath) && autoGenerateMissingTts) {
        const synthOpts = { ...ttsOpts, allowBaseFallback: true, req };
        let result;
        let lastTtsErr = null;
        for (let ttsTry = 0; ttsTry < 4; ttsTry++) {
          if (abortError) return;
          if (isCancelled()) {
            const cancelErr = new Error('Export cancelled by user');
            cancelErr.cancelled = true;
            abortError = cancelErr;
            throw cancelErr;
          }
          try {
            if (ttsTry > 0) await new Promise(r => setTimeout(r, 350 * ttsTry * ttsTry));
            result = await ttsRouter.synthesizeTts(item.spokenText, item.voice, synthOpts);
            lastTtsErr = null;
            break;
          } catch (err) {
            lastTtsErr = err;
            if (err && (err.needsCloneEngineInstall || err.statusCode === 422)) {
              break;
            }
          }
        }
        if (lastTtsErr) {
          if (lastTtsErr.needsCloneEngineInstall) {
            abortError = lastTtsErr;
            throw lastTtsErr;
          }
          console.warn(`[export/tts] Cue ${item.cueIndex + 1} skipped after retries:`, lastTtsErr.message);
        }
        if (result && result.key) {
          filePath = path.join(cacheDir, `${result.key}.mp3`);
        }
      }

      if (isValidAudioFile(filePath)) {
        clips.push({ ...item, filePath });
      } else {
        droppedCount++;
      }

      completed++;
      if (onProgress) {
        onProgress(completed, candidates.length);
      }
    }
  });

  await Promise.all(workers);
  clips.sort((a, b) => a.startSec - b.startSec || a.cueIndex - b.cueIndex);

  const resolveClipInfoFast = async (filePath) => {
    const meta = ttsRouter.readAudioCacheMeta ? ttsRouter.readAudioCacheMeta(filePath) : null;
    const metaDur = meta && Number(meta.durationSec);
    if (Number.isFinite(metaDur) && metaDur > 0 && isValidAudioFile(filePath)) {
      return { durationSec: metaDur, width: 0, height: 0, hasAudio: true };
    }
    const fastDur = parseMp3DurationFast(filePath);
    if (fastDur > 0) {
      if (meta && !meta.durationSec && ttsRouter.writeAudioCacheMeta) {
        ttsRouter.writeAudioCacheMeta(filePath, { ...meta, durationSec: fastDur });
      }
      return { durationSec: fastDur, width: 0, height: 0, hasAudio: true };
    }
    return probeMediaInfo(filePath);
  };

  // Probe durations cleanly (fast MP3 frame header / meta cache first, FFmpeg fallback only when needed)
  const validClips = [];
  for (let i = 0; i < clips.length; i += 12) {
    const slice = clips.slice(i, i + 12);
    const infos = await Promise.all(slice.map(c => resolveClipInfoFast(c.filePath)));
    for (let j = 0; j < slice.length; j++) {
      const clip = slice[j];
      let info = infos[j];
      if ((!info || !info.hasAudio || !info.durationSec || info.durationSec <= 0) && autoGenerateMissingTts) {
        try {
          try { if (fs.existsSync(clip.filePath)) fs.unlinkSync(clip.filePath); } catch (_) {}
          const metaPath = `${clip.filePath}.meta.json`;
          try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch (_) {}
          const regen = await ttsRouter.synthesizeTts(clip.spokenText, clip.voice, {
            engine: 'edge',
            strictVoice: strictVoice !== false,
            ...(clip.pitch !== undefined ? { pitch: clip.pitch } : {}),
            ...(clip.rate !== undefined ? { rate: clip.rate } : {}),
            allowBaseFallback: true,
            force: true,
            req
          });
          if (regen && regen.key) {
            clip.filePath = path.join(cacheDir, `${regen.key}.mp3`);
          }
          if (isValidAudioFile(clip.filePath)) {
            info = await resolveClipInfoFast(clip.filePath);
          }
        } catch (repairErr) {
          console.warn(`[export/tts] Corrupt cached clip repair failed for cue ${clip.cueIndex + 1}:`, repairErr.message);
        }
      }
      const dur = info && Number.isFinite(info.durationSec) ? info.durationSec : 0;
      if (dur > 0 && (!info || info.hasAudio !== false)) {
        clip.clipDurSec = dur;
        validClips.push(clip);
      } else {
        droppedCount++;
      }
    }
  }

  clips.length = 0;
  clips.push(...validClips);
  clips.droppedCount = droppedCount;
  clips.candidateCount = candidates.length;

  enforceNonOverlappingDubSchedule(clips, autoFitTiming);

  return clips;
}

function runFfmpegSimple(args, onSpawn = null, inactivityTimeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    lowerProcessPriority(proc);
    if (onSpawn) onSpawn(proc);
    let stderr = '';
    let settled = false;
    let inactivityTimer = null;
    const armTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (inactivityTimeoutMs > 0) {
        inactivityTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          killExportProcessTree(proc);
          reject(new Error('FFmpeg helper timed out with no activity.'));
        }, inactivityTimeoutMs);
      }
    };
    armTimer();
    proc.stderr.on('data', d => {
      armTimer();
      stderr += d.toString();
      if (stderr.length > 16384) stderr = stderr.slice(-8192);
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (code === 0) return resolve();
      const err = new Error(`FFmpeg helper exited with code ${code}: ${stderr.slice(-500)}`);
      err.code = code;
      reject(err);
    });
  });
}

/**
 * Render arbitrarily many timed dubbing clips into one clean stereo WAV track using
 * batch-relative offsets + hierarchical merging (keeps temp disk tiny on 2-3h movies).
 */
async function renderDubMasterWav(clips, workDir, onSpawn = null, isCancelled = () => false) {
  const masterWav = path.join(workDir, 'dub_master.wav');
  const singleBatch = clips.length <= DUB_BATCH_SIZE;
  const helperConcurrency = Math.min(3, Math.max(1, (os.cpus() ? os.cpus().length : 2) - 1));

  const batchJobs = [];
  for (let start = 0; start < clips.length; start += DUB_BATCH_SIZE) {
    batchJobs.push({
      batch: clips.slice(start, start + DUB_BATCH_SIZE),
      batchIdx: Math.floor(start / DUB_BATCH_SIZE)
    });
  }

  let segments = await mapWithConcurrency(batchJobs, singleBatch ? 1 : helperConcurrency, async ({ batch, batchIdx }) => {
    if (isCancelled()) {
      const cancelErr = new Error('Export cancelled by user');
      cancelErr.cancelled = true;
      throw cancelErr;
    }
    const outWav = singleBatch
      ? masterWav
      : path.join(workDir, `dub_batch_${batchIdx}.wav`);
    const scriptPath = path.join(workDir, `dub_batch_${batchIdx}.ffscript`);
    // Shift batch timestamps relative to first clip unless writing single final WAV from t=0
    const batchOffsetMs = singleBatch ? 0 : Math.max(0, Math.round(batch[0].startSec * 1000));

    const args = ['-y'];
    const filterLines = [];
    const mixLabels = [];

    for (let j = 0; j < batch.length; j++) {
      const clip = batch[j];
      args.push('-i', clip.filePath);
      const relDelayMs = Math.max(0, Math.round(clip.startSec * 1000) - batchOffsetMs);
      const trimSilenceFilter = (clip.trimSilence !== false && Number(clip.clipDurSec) > 0.65)
        ? ',silenceremove=start_periods=1:start_duration=0:start_threshold=-55dB,areverse,silenceremove=start_periods=1:start_duration=0:start_threshold=-55dB,areverse'
        : '';
      const delayFilter = relDelayMs > 0 ? `,adelay=${relDelayMs}|${relDelayMs}` : '';
      const tempoFilter = buildTempoFilterChain(clip.tempo);
      const maxSlotFilter = (Number.isFinite(clip.maxSlotSec) && clip.maxSlotSec > 0.25)
        ? `,afade=t=out:st=${Math.max(0.05, clip.maxSlotSec - 0.04).toFixed(3)}:d=0.04,atrim=0:${clip.maxSlotSec.toFixed(3)}`
        : '';
      const label = batch.length === 1 ? 'aout' : `a${j}`;
      filterLines.push(`[${j}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo${trimSilenceFilter}${tempoFilter}${maxSlotFilter}${delayFilter}[${label}]`);
      mixLabels.push(`[${label}]`);
    }

    if (batch.length > 1) {
      filterLines.push(`${mixLabels.join('')}amix=inputs=${batch.length}:duration=longest:normalize=0:dropout_transition=0[aout]`);
    }

    fs.writeFileSync(scriptPath, filterLines.join(';\n'), 'utf8');
    args.push('-filter_complex_script', scriptPath, '-map', '[aout]', '-c:a', 'pcm_s16le', outWav);
    await runFfmpegSimple(args, onSpawn);
    return { path: outWav, offsetMs: batchOffsetMs };
  });

  let pass = 0;
  while (segments.length > 1) {
    const totalGroups = Math.ceil(segments.length / DUB_BATCH_SIZE);
    const isFinalPass = totalGroups === 1;
    const mergeJobs = [];

    for (let start = 0; start < segments.length; start += DUB_BATCH_SIZE) {
      mergeJobs.push({
        group: segments.slice(start, start + DUB_BATCH_SIZE),
        groupIdx: Math.floor(start / DUB_BATCH_SIZE)
      });
    }

    const nextSegments = await mapWithConcurrency(mergeJobs, isFinalPass ? 1 : helperConcurrency, async ({ group, groupIdx }) => {
      if (isCancelled()) {
        const cancelErr = new Error('Export cancelled by user');
        cancelErr.cancelled = true;
        throw cancelErr;
      }
      const outWav = (isFinalPass && group.length > 0)
        ? masterWav
        : path.join(workDir, `dub_merge_p${pass}_g${groupIdx}.wav`);
      const mergeScript = path.join(workDir, `dub_merge_p${pass}_g${groupIdx}.ffscript`);
      const groupOffsetMs = isFinalPass ? 0 : group[0].offsetMs;

      const args = ['-y'];
      const labels = [];
      const prepLines = [];
      for (let i = 0; i < group.length; i++) {
        args.push('-i', group[i].path);
        const relDelayMs = Math.max(0, group[i].offsetMs - groupOffsetMs);
        const delayFilter = relDelayMs > 0 ? `,adelay=${relDelayMs}|${relDelayMs}` : '';
        const outLabel = group.length === 1 ? 'aout' : `b${i}`;
        prepLines.push(`[${i}:a]aformat=sample_fmts=fltp:channel_layouts=stereo${delayFilter}[${outLabel}]`);
        labels.push(`[${outLabel}]`);
      }
      if (group.length > 1) {
        prepLines.push(`${labels.join('')}amix=inputs=${group.length}:duration=longest:normalize=0:dropout_transition=0[aout]`);
      }
      fs.writeFileSync(mergeScript, prepLines.join(';\n'), 'utf8');
      args.push('-filter_complex_script', mergeScript, '-map', '[aout]', '-c:a', 'pcm_s16le', outWav);
      await runFfmpegSimple(args, onSpawn);

      for (const seg of group) {
        if (seg.path !== masterWav) {
          try { fs.unlinkSync(seg.path); } catch (_) {}
        }
      }
      return { path: outWav, offsetMs: groupOffsetMs };
    });

    segments = nextSegments;
    pass++;
  }

  return masterWav;
}

/**
 * Build audio mixing filtergraph combining source audio and AI Dubbing WAV cleanly.
 */
function buildAudioMixGraph({
  audioMixMode = 'duck',
  hasSourceAudio = true,
  hasIsolatedBgmInput = false,
  durationSec = 120,
  origVolume,
  bgVolume = 0.28,
  dubVolume = 1.25,
  bgmOnPause = true,
  sourceAudioTransform = ''
}) {
  const safeDur = Math.max(0.1, Number.isFinite(Number(durationSec)) && Number(durationSec) > 0 ? Number(durationSec) : 120).toFixed(3);
  const parsedBg = Number(bgVolume);
  const parsedDub = Number(dubVolume);
  const parsedOrig = Number(origVolume);
  const safeBgVolNum = Number.isFinite(parsedBg) ? Math.min(1.5, Math.max(0, parsedBg)) : 0.28;
  const safeBgVol = safeBgVolNum.toFixed(2);
  const safeDubVolNum = Number.isFinite(parsedDub) ? Math.min(2.0, Math.max(0, parsedDub)) : 1.25;
  const safeDubVol = safeDubVolNum.toFixed(2);
  const srcTail = typeof sourceAudioTransform === 'string' ? sourceAudioTransform : '';
  const dubNorm = `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${safeDubVol},apad=whole_dur=${safeDur},atrim=0:${safeDur},asetpts=PTS-STARTPTS`;
  const bgmIsoPad = `[0:a]${audioRouter.BGM_ISOLATION_FILTER}${srcTail},apad=whole_dur=${safeDur},atrim=0:${safeDur},asetpts=PTS-STARTPTS`;

  if (!hasSourceAudio || audioMixMode === 'dub_only') {
    return `${dubNorm},dynaudnorm=f=150:g=15:p=0.9,alimiter=limit=0.95[aout]`;
  }

  // Unified 3-layer mixer (Original Movie Audio + BGM/SFX + AI Dubbing)
  if (audioMixMode === 'mix_custom' || (!['bgm_only', 'bg_low', 'duck'].includes(audioMixMode) && origVolume !== undefined)) {
    const safeOrigNum = Number.isFinite(parsedOrig) ? Math.min(1.5, Math.max(0, parsedOrig)) : 0;
    const rawBgNum = Number.isFinite(parsedBg) ? Math.min(1.8, Math.max(0, parsedBg)) : 0.75;
    const pauseBgmNum = (bgmOnPause === false) ? Number((rawBgNum * 0.82).toFixed(2)) : rawBgNum;

    if (safeOrigNum <= 0.005 && pauseBgmNum <= 0.005) {
      return `${dubNorm},dynaudnorm=f=150:g=15:p=0.9,alimiter=limit=0.95[aout]`;
    }

    const origNorm = `[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo${srcTail},apad=whole_dur=${safeDur},atrim=0:${safeDur},asetpts=PTS-STARTPTS`;

    if (hasIsolatedBgmInput) {
      const hasBgmStem = pauseBgmNum > 0.005;
      const hasOrig = safeOrigNum > 0.005;
      const boostedStemVol = Math.min(2.2, pauseBgmNum * 1.45).toFixed(2);
      const bgmNorm = `[2:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo${srcTail},volume=${boostedStemVol},apad=whole_dur=${safeDur},atrim=0:${safeDur},asetpts=PTS-STARTPTS[bg]`;

      if (hasBgmStem && hasOrig) {
        return (
          `${bgmNorm};` +
          `${origNorm},volume=${safeOrigNum.toFixed(2)}[orig];` +
          `${dubNorm}[dubfull];` +
          `[dubfull]asplit=3[dub][sc_bgm][sc_orig];` +
          `[bg][sc_bgm]sidechaincompress=threshold=0.14:ratio=2.2:attack=25:release=260[bg_ducked];` +
          `[orig][sc_orig]sidechaincompress=threshold=0.05:ratio=2.6:attack=20:release=320[orig_ducked];` +
          `[bg_ducked][orig_ducked][dub]amix=inputs=3:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`
        );
      }

      if (hasBgmStem) {
        return `${bgmNorm};${dubNorm}[dubfull];[dubfull]asplit=2[dub][sc];[bg][sc]sidechaincompress=threshold=0.14:ratio=2.2:attack=25:release=260[bg_ducked];[bg_ducked][dub]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`;
      }

      // BGM set to 0%, only Original + Dub
      return `${origNorm},volume=${safeOrigNum.toFixed(2)}[orig];${dubNorm}[dubfull];[dubfull]asplit=2[dub][sc];[orig][sc]sidechaincompress=threshold=0.05:ratio=2.6:attack=20:release=320[orig_ducked];[orig_ducked][dub]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`;
    }

    // No isolated BGM stem: keep phase-clean single [0:a] stream
    if (safeOrigNum > 0.005) {
      const pauseTarget = Math.min(1.5, Math.max(safeOrigNum, pauseBgmNum * 0.78));
      const duckRatio = pauseTarget > safeOrigNum * 1.15 ? 3.5 : 2.5;
      return `${origNorm},volume=${pauseTarget.toFixed(2)}[bg];${dubNorm}[dubfull];[dubfull]asplit=2[dub][sc];[bg][sc]sidechaincompress=threshold=0.06:ratio=${duckRatio}:attack=20:release=320[bg_ducked];[bg_ducked][dub]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`;
    }

    // Original muted (0%), BGM+SFX via vocal suppression filter
    return `${bgmIsoPad},volume=${Math.min(1.8, pauseBgmNum * 1.25).toFixed(2)}[bg];${dubNorm}[dubfull];[dubfull]asplit=2[dub][sc];[bg][sc]sidechaincompress=threshold=0.06:ratio=3.5:attack=20:release=320[bg_ducked];[bg_ducked][dub]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`;
  }

  if (audioMixMode === 'bgm_only') {
    const baseBgmNum = Math.min(1.8, Math.max(0.1, Number.isFinite(parsedBg) ? parsedBg : 0.75));
    const stemBgmVol = Math.min(2.2, baseBgmNum * 1.45).toFixed(2);
    const dspBgmVol = Math.min(1.8, baseBgmNum * 1.25).toFixed(2);
    const bgmSource = hasIsolatedBgmInput
      ? `[2:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo${srcTail},volume=${stemBgmVol},apad=whole_dur=${safeDur},atrim=0:${safeDur},asetpts=PTS-STARTPTS[bg]`
      : `${bgmIsoPad},volume=${dspBgmVol}[bg]`;
    const scExpr = hasIsolatedBgmInput
      ? 'threshold=0.14:ratio=2.2:attack=25:release=260'
      : 'threshold=0.06:ratio=3.5:attack=20:release=320';
    return `${bgmSource};${dubNorm}[dubfull];[dubfull]asplit=2[dub][sc];[bg][sc]sidechaincompress=${scExpr}[bg_ducked];[bg_ducked][dub]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`;
  }

  const bgNorm = `${bgmIsoPad},volume=${safeBgVol}[bg]`;

  if (audioMixMode === 'bg_low') {
    const lowVol = Math.min(0.45, Math.max(0.05, Number(bgVolume) || 0.18)).toFixed(2);
    return `${bgmIsoPad},volume=${lowVol}[bg];${dubNorm}[dub];[bg][dub]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`;
  }

  // Smart auto-ducking with vocal suppression: suppresses original dialogue voice and ducks smoothly under Khmer speech
  return `${bgNorm};${dubNorm}[dubfull];[dubfull]asplit=2[dub][sc];[bg][sc]sidechaincompress=threshold=0.06:ratio=3.8:attack=20:release=320[bg_ducked];[bg_ducked][dub]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`;
}

function executeFfmpegRender(args, totalDurationSec, basePercent = 0, expectedJobId = activeExportState.jobId, inactivityTimeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    lowerProcessPriority(proc);
    if (activeExportState.jobId === expectedJobId) {
      activeExportState.proc = proc;
    }
    let stderrTail = '';
    let settled = false;
    let stallTimer = null;
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      if (inactivityTimeoutMs > 0) {
        stallTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (activeExportState.proc === proc) activeExportState.proc = null;
          killExportProcessTree(proc);
          reject(new Error(`FFmpeg stalled with no output for ${Math.round(inactivityTimeoutMs / 60000)}m: ${stderrTail.slice(-300)}`));
        }, inactivityTimeoutMs);
      }
    };
    armStallTimer();
    const startPct = Math.min(90, Math.max(0, Number(basePercent) || 0));

    proc.stderr.on('data', (d) => {
      armStallTimer();
      const str = d.toString();
      stderrTail = (stderrTail + str).slice(-2000);
      if (activeExportState.jobId !== expectedJobId || activeExportState.cancelled) return;

      const timeMatch = str.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (timeMatch) {
        const h = parseInt(timeMatch[1], 10);
        const m = parseInt(timeMatch[2], 10);
        const s = parseFloat(timeMatch[3]);
        const curSec = h * 3600 + m * 60 + s;
        const ratio = Math.min(1, Math.max(0, curSec / Math.max(0.1, totalDurationSec)));
        activeExportState.percent = Math.min(99, Math.round(startPct + ratio * (99 - startPct)));
        const mmss = `${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}`;
        activeExportState.timeStr = h > 0 ? `${h}:${mmss}` : mmss;
      }

      const speedMatch = str.match(/speed=\s*([\d\.]+x)/);
      if (speedMatch) {
        activeExportState.speed = speedMatch[1];
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (stallTimer) clearTimeout(stallTimer);
      if (activeExportState.proc === proc) activeExportState.proc = null;
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (stallTimer) clearTimeout(stallTimer);
      if (activeExportState.proc === proc) {
        activeExportState.proc = null;
      }
      resolve({ code, stderrTail });
    });
  });
}

/**
 * Inspect host CPU/RAM/GPU capabilities to size concurrency and Eco/Low-Spec protections safely.
 */
function getSystemSpecProfile() {
  const cpuCores = Math.max(1, (os.cpus() || []).length || 2);
  const totalRamBytes = Number(os.totalmem()) || 0;
  const totalRamGB = Number((totalRamBytes / (1024 * 1024 * 1024)).toFixed(1));
  const gpuEncoder = detectHardwareEncoder();
  const hasHardwareEncoder = Boolean(gpuEncoder);
  const isVeryLowRam = totalRamGB > 0 && totalRamGB <= 5.5;
  const isLowSpec = isVeryLowRam || cpuCores <= 4 || (totalRamGB > 0 && totalRamGB <= 8.5);
  return {
    cpuCores,
    totalRamGB,
    hasHardwareEncoder,
    gpuEncoder: gpuEncoder || null,
    isLowSpec,
    isVeryLowRam,
    recommendedVmConcurrency: isVeryLowRam ? 1 : (isLowSpec ? 2 : 4),
    recommendedPreset: isLowSpec ? 'fast' : 'balanced'
  };
}

/**
 * GET /api/export/capabilities
 * Inspect supported GPU encoders and export options.
 */
router.get('/capabilities', (req, res) => {
  const systemProfile = getSystemSpecProfile();
  res.json({
    success: true,
    gpuEncoder: systemProfile.gpuEncoder,
    presets: Object.keys(QUALITY_PROFILES),
    resolutions: Object.keys(RESOLUTION_SPECS),
    maxrateTiers: MAXRATE_TIERS_KBPS,
    systemProfile
  });
});

/**
 * POST /api/export/estimate
 * Probe source media metadata and estimate final exported MP4 size for the chosen preset.
 */
router.post('/estimate', async (req, res) => {
  try {
    const {
      videoPath = '',
      duration = 0,
      width = 0,
      height = 0,
      videoBitrateKbps = 0,
      qualityPreset = 'balanced',
      resolution = 'source',
      fastCopy = false,
      antiCopyright = null
    } = req.body || {};

    let mediaInfo = {
      durationSec: Number(duration) || 0,
      width: Number(width) || 0,
      height: Number(height) || 0,
      hasAudio: true,
      videoBitrateKbps: Number(videoBitrateKbps) || 0
    };

    if (typeof videoPath === 'string' && videoPath.trim()) {
      const normalizedPath = path.normalize(videoPath.trim());
      if (
        path.isAbsolute(normalizedPath) &&
        !isBlockedNetworkOrStreamPath(videoPath, normalizedPath) &&
        fs.existsSync(normalizedPath)
      ) {
        const probed = await probeMediaInfo(normalizedPath);
        mediaInfo = {
          durationSec: probed.durationSec || mediaInfo.durationSec,
          width: probed.width || mediaInfo.width,
          height: probed.height || mediaInfo.height,
          hasAudio: probed.hasAudio,
          videoBitrateKbps: probed.videoBitrateKbps || mediaInfo.videoBitrateKbps
        };
      }
    }

    const crOpts = normalizeAntiCopyrightOptions(antiCopyright);
    const estimate = estimateExportSize({
      qualityPreset,
      resolution,
      durationSec: mediaInfo.durationSec || Number(duration) || 0,
      mediaInfo,
      fastCopy: Boolean(fastCopy),
      speedRate: crOpts.speedRate
    });

    return res.json({
      success: true,
      sourceMedia: mediaInfo,
      ...estimate
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/export/video
 * Export video with burned-in Khmer subtitles, optional AI Dubbing audio mixing, and HD presets
 */
router.post('/video', async (req, res) => {
  let workDir = null;
  let outPath = null;

  const cleanupTempFiles = () => {
    if (workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    }
  };
  const cleanupPartialOut = () => {
    if (outPath) {
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
    }
  };
  let myJobId = 0;
  let thisJobPromise = null;
  let resolveCurrentJobPromise = null;

  try {
    const {
      videoPath,
      cues,
      duration = 120,
      maskEnabled = true,
      maskMode = 'feathered',
      subStyle = 'tiktok',
      subFontSize = 58,
      subMarginV = 154,
      subPrimaryColor = '',
      subOutlineColor = '',
      subBackColor = '',
      subHighlightColor = '',
      wordPopEnabled = true,
      maskXPercent,
      maskYPercent = 0.78,
      maskHPercent = 0.07,
      maskWPercent = 0.92,
      maskBlurSigma = 12,
      includeDubAudio = false,
      autoGenerateMissingTts = true,
      autoFitTiming = true,
      audioMixMode = 'duck',
      origVolume,
      bgVolume,
      dubVolume = 1.15,
      bgmOnPause = true,
      ensureAiBgm = false,
      ttsEngine = '',
      castMode = '',
      fixedVoice = '',
      strictVoice = true,
      qualityPreset = 'balanced',
      resolution = 'source',
      encoder = 'auto',
      fastCopy = false,
      ecoCpu = false,
      burnSubtitles = true,
      outputDir = '',
      logoEnabled = false,
      logoPath = '',
      logoPosition = 'top-right',
      logoScale = 18,
      logoOpacity = 100,
      logoXPercent,
      logoYPercent,
      sponsorEnabled = false,
      sponsorPath = '',
      sponsorPosition = 'top-right',
      sponsorScale = 22,
      sponsorOpacity = 100,
      sponsorXPercent,
      sponsorYPercent,
      antiCopyright = null,
      customTextOverlay = null
    } = req.body || {};

    const textOverlayOpts = normalizeCustomTextOverlay(customTextOverlay);
    const hasCustomTextOverlay = Boolean(textOverlayOpts.enabled && textOverlayOpts.text);

    if (typeof videoPath !== 'string' || !videoPath.trim()) {
      return res.status(400).json({ success: false, error: 'videoPath required' });
    }
    if (!Array.isArray(cues) || (cues.length === 0 && !hasCustomTextOverlay)) {
      return res.status(400).json({ success: false, error: 'Invalid or empty cues array' });
    }
    let exportDir = getExportDir();
    if (outputDir !== undefined && outputDir !== null && String(outputDir).trim()) {
      if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir.trim())) {
        return res.status(400).json({ success: false, error: 'outputDir must be an absolute path' });
      }
      exportDir = path.normalize(outputDir.trim());
      if (isBlockedNetworkOrStreamPath(outputDir, exportDir)) {
        return res.status(403).json({ success: false, error: 'Invalid or forbidden outputDir.' });
      }
    }

    const normalizedVideoPath = path.normalize(videoPath.trim());
    if (isBlockedNetworkOrStreamPath(videoPath, normalizedVideoPath)) {
      return res.status(403).json({ success: false, error: 'Invalid or forbidden videoPath.' });
    }
    if (!fs.existsSync(normalizedVideoPath)) {
      return res.status(404).json({ success: false, error: 'Video file not found' });
    }
    try {
      fs.accessSync(normalizedVideoPath, fs.constants.R_OK);
    } catch (_) {
      return res.status(403).json({ success: false, error: 'Cannot read video file' });
    }

    if (activeExportJobPromise && activeExportState.cancelled) {
      await Promise.race([
        activeExportJobPromise.catch(() => {}),
        new Promise(r => setTimeout(r, 4000))
      ]);
    }
    if (activeExportState.running || activeExportJobPromise) {
      return res.status(409).json({ success: false, error: 'Another export is already running' });
    }

    myJobId = ++activeExportJobSeq;
    const isMyJobCancelled = () => activeExportState.cancelled || activeExportState.jobId !== myJobId;
    thisJobPromise = new Promise(resolve => { resolveCurrentJobPromise = resolve; });
    activeExportJobPromise = thisJobPromise;
    activeExportState.jobId = myJobId;
    activeExportState.running = true;
    activeExportState.cancelled = false;
    activeExportState.percent = 0;
    activeExportState.timeStr = '00:00';
    activeExportState.speed = '1x';
    activeExportState.phase = 'preparing';
    activeExportState.statusText = '⏳ កំពុងរៀបចំ Render...';
    activeExportState.error = null;
    activeExportState.outputFile = null;
    activeExportState.proc = null;
    activeExportState.startTime = Date.now();

    fs.mkdirSync(exportDir, { recursive: true });
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezapro-export-'));

    const crOpts = normalizeAntiCopyrightOptions(antiCopyright);
    const hasCrVisualTransform = Boolean(
      crOpts.mirror ||
      crOpts.zoomPercent > 0 ||
      Math.abs(crOpts.speedRate - 1.0) >= 0.005 ||
      crOpts.colorShift !== 'none' ||
      crOpts.vignette
    );
    const exportCues = Math.abs(crOpts.speedRate - 1.0) >= 0.005
      ? cues.map(c => ({
          ...c,
          startSec: Number(((Number(c && c.startSec) || 0) / crOpts.speedRate).toFixed(3)),
          endSec: Number(((Number(c && c.endSec) || 0) / crOpts.speedRate).toFixed(3))
        }))
      : cues;

    const subCustomColors = {
      primaryColor: subPrimaryColor,
      outlineColor: subOutlineColor,
      backColor: subBackColor,
      highlightColor: subHighlightColor
    };
    const cuesForAss = Boolean(burnSubtitles) ? exportCues : [];
    const tempAss = path.join(workDir, 'subtitles.ass');
    fs.writeFileSync(tempAss, serializeAss(cuesForAss, subStyle, subFontSize, subMarginV, Boolean(wordPopEnabled), subCustomColors, textOverlayOpts, 36000), 'utf8');

    const outName = `${path.basename(normalizedVideoPath, path.extname(normalizedVideoPath))}_Dubbed_${Date.now()}.mp4`;
    outPath = path.join(exportDir, outName);

    const mediaInfo = await probeMediaInfo(normalizedVideoPath);
    if (!mediaInfo || mediaInfo.width <= 0 || mediaInfo.height <= 0) {
      cleanupTempFiles();
      if (activeExportState.jobId === myJobId) {
        activeExportState.running = false;
        activeExportState.phase = 'error';
      }
      return res.status(422).json({
        success: false,
        error: 'មិនអាចអានទំហំវីដេអូបានទេ (ឯកសារអាចខូច ឬគ្មាន Video Track)។'
      });
    }
    let logoSpec = null;
    let sponsorSpec = null;
    try {
      logoSpec = resolveSponsorOverlaySpec({
        sponsorEnabled: logoEnabled,
        sponsorPath: logoPath,
        sponsorPosition: logoPosition,
        sponsorScale: logoScale,
        sponsorOpacity: logoOpacity,
        sponsorXPercent: logoXPercent,
        sponsorYPercent: logoYPercent,
        resolution,
        mediaInfo
      });
      sponsorSpec = resolveSponsorOverlaySpec({
        sponsorEnabled,
        sponsorPath,
        sponsorPosition,
        sponsorScale,
        sponsorOpacity,
        sponsorXPercent,
        sponsorYPercent,
        resolution,
        mediaInfo
      });
    } catch (sponsorErr) {
      cleanupTempFiles();
      activeExportState.running = false;
      return res.status(sponsorErr.statusCode || 400).json({
        success: false,
        error: sponsorErr.message
      });
    }
    const overlaySpecs = [logoSpec, sponsorSpec].filter(Boolean);
    const parsedDuration = parseFloat(duration);
    const rawDurationSec = mediaInfo.durationSec > 0
      ? mediaInfo.durationSec
      : (Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : 120);
    const totalDurationSec = Number((rawDurationSec / crOpts.speedRate).toFixed(3));
    if (hasCustomTextOverlay) {
      fs.writeFileSync(tempAss, serializeAss(cuesForAss, subStyle, subFontSize, subMarginV, Boolean(wordPopEnabled), subCustomColors, textOverlayOpts, totalDurationSec + 5), 'utf8');
    }

    const requestedFastCopy = Boolean(fastCopy);
    const explicitBurnSubtitles = Boolean(req.body && req.body.burnSubtitles === true);
    const useVideoStreamCopy =
      !hasCrVisualTransform &&
      !hasCustomTextOverlay &&
      resolution === 'source' &&
      overlaySpecs.length === 0 &&
      (requestedFastCopy ? !explicitBurnSubtitles : (!Boolean(burnSubtitles) && !maskEnabled));

    const wantsBgmStem =
      audioMixMode === 'bgm_only' ||
      ((audioMixMode === 'mix_custom' || origVolume !== undefined) &&
        bgmOnPause !== false &&
        (!Number.isFinite(Number(bgVolume)) || Number(bgVolume) > 0));
    let cachedBgmStems = wantsBgmStem
      ? audioRouter.getCachedStemsForVideo(normalizedVideoPath)
      : null;
    const detectedAudioSep = (ensureAiBgm && wantsBgmStem && mediaInfo.hasAudio && typeof audioRouter.detectSeparationEngine === 'function')
      ? audioRouter.detectSeparationEngine()
      : null;
    const hasAiEngine = Boolean(
      detectedAudioSep &&
      typeof audioRouter.isAiSeparationEngine === 'function' &&
      audioRouter.isAiSeparationEngine(detectedAudioSep.id)
    );
    const cachedIsAi = Boolean(
      cachedBgmStems &&
      typeof audioRouter.isAiSeparationEngine === 'function' &&
      audioRouter.isAiSeparationEngine(cachedBgmStems.engine)
    );
    const sysProfile = getSystemSpecProfile();
    const useEcoCpu = Boolean(ecoCpu);
    const useLowResourceArgs = useEcoCpu || sysProfile.isVeryLowRam;
    const needsAiBgmSeparation = Boolean(
      !useLowResourceArgs &&
      ensureAiBgm && wantsBgmStem && mediaInfo.hasAudio &&
      hasAiEngine && !cachedIsAi &&
      typeof audioRouter.isolateVideoBgm === 'function'
    );

    const shouldMixDub = Boolean(includeDubAudio) && audioMixMode !== 'original';
    const ttsMaxPercent = needsAiBgmSeparation ? 15 : 20;
    const bgmStartPercent = shouldMixDub ? ttsMaxPercent : 0;
    const bgmEndPercent = 75;
    const encodeStartPercent = needsAiBgmSeparation ? bgmEndPercent : (shouldMixDub ? 20 : 0);

    let dubMasterWav = null;
    let dubbedCueCount = 0;
    let droppedDubCount = 0;

    if (shouldMixDub) {
      activeExportState.phase = 'tts';
      activeExportState.statusText = '🎙️ កំពុងពិនិត្យ និងបង្កើតសំឡេង AI Dubbing...';

      const clips = await prepareCueAudioClips(exportCues, {
        autoGenerateMissingTts,
        autoFitTiming,
        ttsEngine,
        castMode,
        fixedVoice,
        strictVoice,
        voicePitch: req.body && (req.body.voicePitch || req.body.pitch),
        voiceRate: req.body && (req.body.voiceRate || req.body.rate),
        req,
        isCancelled: isMyJobCancelled,
        onProgress: (done, total) => {
          if (activeExportState.jobId !== myJobId || activeExportState.cancelled) return;
          activeExportState.percent = Math.min(ttsMaxPercent, Math.round((done / Math.max(1, total)) * ttsMaxPercent));
          activeExportState.statusText = `🎙️ កំពុងបង្កើតសំឡេង AI Dubbing (${done}/${total})...`;
        }
      });
      droppedDubCount = Number(clips.droppedCount) || 0;

      if (isMyJobCancelled()) {
        cleanupTempFiles();
        cleanupPartialOut();
        if (activeExportState.jobId === myJobId) {
          activeExportState.running = false;
          activeExportState.cancelled = false;
          activeExportState.phase = 'cancelled';
        }
        return res.status(499).json({ success: false, cancelled: true, error: 'Export cancelled by user' });
      }

      if (clips.length === 0 && (Number(clips.candidateCount) || 0) > 0) {
        cleanupTempFiles();
        cleanupPartialOut();
        const dubFailMsg = `បង្កើតសំឡេង AI Dubbing មិនបានសម្រេចទេ (0/${clips.candidateCount} បន្ទាត់) — សូមពិនិត្យអ៊ីនធឺណិត ឬសេវា TTS មុន Export ម្ដងទៀត។`;
        logError('export/video:tts-zero-clips', dubFailMsg);
        if (activeExportState.jobId === myJobId) {
          activeExportState.running = false;
          activeExportState.phase = 'error';
          activeExportState.error = dubFailMsg;
          activeExportState.statusText = dubFailMsg;
        }
        return res.status(502).json({ success: false, error: dubFailMsg });
      }

      if (clips.length > 0) {
        dubbedCueCount = clips.length;
        if (!useVideoStreamCopy && Boolean(burnSubtitles)) {
          // Sync ASS word-by-word karaoke timing cleanly using exact cueIndex when burning subtitles
          const syncedCues = exportCues.map(c => ({ ...c }));
          for (const clip of clips) {
            const spokenDur = (Number(clip.clipDurSec) || 0) / Math.max(0.5, Number(clip.tempo) || 1);
            if (spokenDur > 0.1) {
              const match = (Number.isInteger(clip.cueIndex) && syncedCues[clip.cueIndex])
                ? syncedCues[clip.cueIndex]
                : syncedCues.find(c => Math.abs((Number(c && c.startSec) || 0) - clip.startSec) < 0.04);
              if (match) match._spokenDurSec = spokenDur;
            }
          }
          fs.writeFileSync(tempAss, serializeAss(syncedCues, subStyle, subFontSize, subMarginV, Boolean(wordPopEnabled), subCustomColors, textOverlayOpts, totalDurationSec), 'utf8');
        } else if (!useVideoStreamCopy && hasCustomTextOverlay) {
          fs.writeFileSync(tempAss, serializeAss([], subStyle, subFontSize, subMarginV, Boolean(wordPopEnabled), subCustomColors, textOverlayOpts, totalDurationSec), 'utf8');
        }

        if (activeExportState.jobId === myJobId) {
          activeExportState.phase = 'audio_mix';
          activeExportState.statusText = `🔊 កំពុងរៀបចំតម្រៀបសំឡេង Dubbing ${clips.length} បន្ទាត់...`;
        }
        dubMasterWav = await renderDubMasterWav(clips, workDir, (p) => {
          if (activeExportState.jobId === myJobId) activeExportState.proc = p;
          if (p) {
            activeExportState.helperProcs.add(p);
            const dropHelper = () => activeExportState.helperProcs.delete(p);
            p.once('close', dropHelper);
            p.once('error', dropHelper);
          }
        }, isMyJobCancelled);
      }
    }

    const fastRender = String(qualityPreset || 'balanced').toLowerCase() === 'fast' || useLowResourceArgs;
    const filterString = useVideoStreamCopy
      ? ''
      : buildExportFilter(tempAss, {
          maskEnabled,
          maskMode,
          maskXPercent,
          maskYPercent,
          maskHPercent,
          maskWPercent,
          maskBlurSigma,
          resolution,
          mediaInfo,
          burnSubtitles: Boolean(burnSubtitles) || hasCustomTextOverlay,
          antiCopyright: crOpts,
          fastRender
        });

    const sourceAudioTransform = buildAntiCopyrightAudioTail(crOpts);
    const rawSourceAudioAf = sourceAudioTransform.replace(/^,+/, '');

    if (needsAiBgmSeparation) {
      if (activeExportState.jobId === myJobId) {
        activeExportState.phase = 'audio';
        activeExportState.percent = Math.max(activeExportState.percent || 0, bgmStartPercent);
        activeExportState.statusText = '🎵 កំពុងបំបែកភ្លេង BGM+SFX ដោយ UVR AI (GPU)...';
      }
      try {
        const upgraded = await audioRouter.isolateVideoBgm(normalizedVideoPath, {
          isCancelled: isMyJobCancelled,
          onProcess: (p) => {
            if (activeExportState.jobId === myJobId) activeExportState.proc = p;
            if (p) {
              activeExportState.helperProcs.add(p);
              const dropHelper = () => {
                activeExportState.helperProcs.delete(p);
                if (activeExportState.proc === p) activeExportState.proc = null;
              };
              p.once('close', dropHelper);
              p.once('error', dropHelper);
            }
          },
          onProgress: (info) => {
            if (!info || activeExportState.jobId !== myJobId || activeExportState.cancelled) return;
            const frac = Math.min(1, Math.max(0, (Number(info.percent) || 0) / 100));
            activeExportState.percent = Math.min(
              bgmEndPercent,
              Math.round(bgmStartPercent + frac * (bgmEndPercent - bgmStartPercent))
            );
            if (info.statusText) {
              activeExportState.statusText = info.statusText;
            }
          }
        });
        if (upgraded && upgraded.bgmPath) cachedBgmStems = upgraded;
      } catch (bgmErr) {
        if (bgmErr && bgmErr.cancelled) {
          if (activeExportState.jobId === myJobId) activeExportState.cancelled = true;
        } else {
          console.warn('[export] Auto AI BGM separation fallback:', bgmErr.message);
        }
      }
    }
    if (isMyJobCancelled()) {
      cleanupTempFiles();
      cleanupPartialOut();
      if (activeExportState.jobId === myJobId) {
        activeExportState.running = false;
        activeExportState.cancelled = false;
        activeExportState.phase = 'cancelled';
      }
      return res.status(499).json({ success: false, cancelled: true, error: 'Export cancelled by user' });
    }
    // Only layer the isolated BGM stem alongside raw original audio when origVolume is ~0 or separated via neural AI;
    // ffmpeg_dsp stems derive from [0:a] with MP3/filter delay and cause comb-filtering if mixed on top of [0:a].
    const isAiStemEngine = Boolean(
      cachedBgmStems &&
      (cachedBgmStems.engine === 'demucs' || cachedBgmStems.engine === 'audio-separator')
    );
    const canUseIsolatedStemWithOrig =
      (Number(origVolume) || 0) <= 0.005 ||
      isAiStemEngine;

    const buildResolvedAudioGraph = (hasIsolatedBgmInput) => {
      const resolvedBgVol = Number.isFinite(Number(bgVolume))
        ? Number(bgVolume)
        : (audioMixMode === 'bg_low' ? 0.25 : ((audioMixMode === 'bgm_only' || audioMixMode === 'mix_custom') ? 0.65 : 0.55));
      return buildAudioMixGraph({
        audioMixMode,
        hasSourceAudio: mediaInfo.hasAudio,
        hasIsolatedBgmInput,
        durationSec: totalDurationSec,
        origVolume,
        bgVolume: resolvedBgVol,
        dubVolume,
        bgmOnPause: bgmOnPause !== false,
        sourceAudioTransform
      });
    };

    const appendMetaAndOut = (targetArgs) => {
      if (crOpts.stripMetadata) {
        targetArgs.push('-map_metadata', '-1', '-map_chapters', '-1');
      }
      targetArgs.push(outPath);
    };

    const buildFinalArgs = (useEncoder) => {
      const audioBitrate = getAudioBitrateForPreset(qualityPreset);
      if (useVideoStreamCopy) {
        const args = ['-y', '-i', normalizedVideoPath];
        const hasIsolatedBgmInput = Boolean(mediaInfo.hasAudio && cachedBgmStems && cachedBgmStems.bgmPath && canUseIsolatedStemWithOrig);

        if (dubMasterWav) {
          args.push('-i', dubMasterWav);
          if (hasIsolatedBgmInput) {
            args.push('-i', cachedBgmStems.bgmPath);
          }
          const audioGraph = buildResolvedAudioGraph(hasIsolatedBgmInput);
          const fcScript = path.join(workDir, 'export_fastcopy.ffscript');
          fs.writeFileSync(fcScript, audioGraph, 'utf8');
          args.push('-filter_complex_script', fcScript, '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', audioBitrate, '-movflags', '+faststart');
          appendMetaAndOut(args);
        } else if (audioMixMode === 'bgm_only' && hasIsolatedBgmInput) {
          const safeDur = Math.max(0.1, Number.isFinite(Number(totalDurationSec)) && Number(totalDurationSec) > 0 ? Number(totalDurationSec) : 120).toFixed(3);
          const fcScript = path.join(workDir, 'export_fastcopy.ffscript');
          fs.writeFileSync(fcScript, `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo${sourceAudioTransform},apad=whole_dur=${safeDur},atrim=0:${safeDur},asetpts=PTS-STARTPTS[aout]`, 'utf8');
          args.push('-i', cachedBgmStems.bgmPath, '-filter_complex_script', fcScript, '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', audioBitrate, '-movflags', '+faststart');
          appendMetaAndOut(args);
        } else if (mediaInfo.hasAudio && (audioMixMode === 'bgm_only' || rawSourceAudioAf)) {
          const afStr = [audioMixMode === 'bgm_only' ? audioRouter.BGM_ISOLATION_FILTER : '', rawSourceAudioAf].filter(Boolean).join(',');
          args.push('-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-af', afStr, '-c:a', 'aac', '-b:a', audioBitrate, '-movflags', '+faststart');
          appendMetaAndOut(args);
        } else {
          args.push('-map', '0:v:0');
          if (mediaInfo.hasAudio) args.push('-map', '0:a:0?');
          args.push('-c', 'copy', '-movflags', '+faststart');
          appendMetaAndOut(args);
        }
        return { args, encoderName: 'stream-copy' };
      }

      const enc = buildVideoEncodingArgs(qualityPreset, useEncoder, {
        resolution,
        mediaInfo
      });
      const encArgs = [...enc.args];
      if (enc.encoderName === 'libx264' && !encArgs.includes('-threads')) {
        const safeCpuThreads = useLowResourceArgs
          ? Math.max(1, Math.min(4, Math.floor(sysProfile.cpuCores / 2) || 1))
          : Math.max(2, Math.min(sysProfile.cpuCores, 8));
        encArgs.push('-threads', String(safeCpuThreads));
      }
      const filterThreads = (useLowResourceArgs || sysProfile.isLowSpec)
        ? (sysProfile.cpuCores <= 2 ? 1 : 2)
        : Math.min(4, Math.max(2, sysProfile.cpuCores));
      const scaleFlags = fastRender ? 'bilinear' : 'lanczos';
      const args = ['-y', '-filter_threads', String(filterThreads), '-i', normalizedVideoPath];

      const attachOverlayInputs = (startIdx) => {
        let nextIdx = startIdx;
        return overlaySpecs.map(spec => {
          args.push(...spec.inputArgs);
          const item = { ...spec, inputIndex: nextIdx };
          nextIdx += 1;
          return item;
        });
      };

      if (dubMasterWav) {
        args.push('-i', dubMasterWav);
        const hasIsolatedBgmInput = Boolean(mediaInfo.hasAudio && cachedBgmStems && cachedBgmStems.bgmPath && canUseIsolatedStemWithOrig);
        if (hasIsolatedBgmInput) {
          args.push('-i', cachedBgmStems.bgmPath);
        }
        const activeOverlays = attachOverlayInputs(hasIsolatedBgmInput ? 3 : 2);
        const videoGraph = buildVideoGraphWithSponsor(filterString, 'vout', activeOverlays, scaleFlags);
        const audioGraph = buildResolvedAudioGraph(hasIsolatedBgmInput);
        const fcScript = path.join(workDir, `export_${enc.encoderName}.ffscript`);
        fs.writeFileSync(fcScript, `${videoGraph};${audioGraph}`, 'utf8');
        args.push('-filter_complex_script', fcScript, '-map', '[vout]', '-map', '[aout]');
        args.push(...encArgs, '-c:a', 'aac', '-b:a', audioBitrate);
        appendMetaAndOut(args);
      } else {
        const hasIsolatedBgmInput = Boolean(audioMixMode === 'bgm_only' && cachedBgmStems && cachedBgmStems.bgmPath);
        if (hasIsolatedBgmInput) {
          args.push('-i', cachedBgmStems.bgmPath);
          const activeOverlays = attachOverlayInputs(2);
          const videoGraph = buildVideoGraphWithSponsor(filterString, 'vout', activeOverlays, scaleFlags);
          const safeDur = Math.max(0.1, Number.isFinite(Number(totalDurationSec)) && Number(totalDurationSec) > 0 ? Number(totalDurationSec) : 120).toFixed(3);
          const fcScript = path.join(workDir, `export_${enc.encoderName}.ffscript`);
          fs.writeFileSync(
            fcScript,
            `${videoGraph};[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo${sourceAudioTransform},apad=whole_dur=${safeDur},atrim=0:${safeDur},asetpts=PTS-STARTPTS[aout]`,
            'utf8'
          );
          args.push('-filter_complex_script', fcScript, '-map', '[vout]', '-map', '[aout]');
          args.push(...encArgs, '-c:a', 'aac', '-b:a', audioBitrate);
          appendMetaAndOut(args);
        } else if (overlaySpecs.length > 0) {
          const activeOverlays = attachOverlayInputs(1);
          const videoGraph = buildVideoGraphWithSponsor(filterString, 'vout', activeOverlays, scaleFlags);
          const fcScript = path.join(workDir, `export_${enc.encoderName}.ffscript`);
          fs.writeFileSync(fcScript, videoGraph, 'utf8');
          args.push('-filter_complex_script', fcScript, '-map', '[vout]');
          if (mediaInfo.hasAudio) {
            args.push('-map', '0:a:0?');
            if (audioMixMode === 'bgm_only' || rawSourceAudioAf) {
              const afStr = [audioMixMode === 'bgm_only' ? audioRouter.BGM_ISOLATION_FILTER : '', rawSourceAudioAf].filter(Boolean).join(',');
              args.push('-af', afStr, '-c:a', 'aac', '-b:a', audioBitrate);
            } else {
              args.push('-c:a', 'copy');
            }
          }
          args.push(...encArgs);
          appendMetaAndOut(args);
        } else {
          args.push('-map', '0:v:0', '-vf', filterString, ...encArgs);
          if (mediaInfo.hasAudio) {
            args.push('-map', '0:a:0?');
            if (audioMixMode === 'bgm_only' || rawSourceAudioAf) {
              const afStr = [audioMixMode === 'bgm_only' ? audioRouter.BGM_ISOLATION_FILTER : '', rawSourceAudioAf].filter(Boolean).join(',');
              args.push('-af', afStr, '-c:a', 'aac', '-b:a', audioBitrate);
            } else {
              args.push('-c:a', 'copy');
            }
          }
          appendMetaAndOut(args);
        }
      }
      return { args, encoderName: enc.encoderName };
    };

    activeExportState.phase = 'encoding';
    activeExportState.percent = Math.max(activeExportState.percent || 0, encodeStartPercent);
    activeExportState.statusText = useVideoStreamCopy
      ? '⚡ កំពុងបញ្ចូលសំឡេងរហ័ស (-c:v copy — រក្សាវីដេអូដើម 100%)...'
      : (dubMasterWav
        ? '⚡ កំពុង Render HD និងលាយសំឡេង AI Dubbing...'
        : '⚡ កំពុង Render HD និងដុតអក្សររត់...');

    let attempt = buildFinalArgs(encoder);
    let result = await executeFfmpegRender(attempt.args, totalDurationSec, encodeStartPercent);

    // If hardware GPU encoder failed unexpectedly, fall back once cleanly to CPU libx264
    if (!isMyJobCancelled() && result.code !== 0 && attempt.encoderName !== 'libx264' && attempt.encoderName !== 'stream-copy') {
      cleanupPartialOut();
      if (activeExportState.jobId === myJobId) {
        activeExportState.statusText = '🔄 GPU មិនគាំទ្រវីដេអូនេះ — កំពុងប្ដូរទៅ CPU libx264...';
      }
      attempt = buildFinalArgs('cpu');
      result = await executeFfmpegRender(attempt.args, totalDurationSec, encodeStartPercent);
    }

    cleanupTempFiles();
    const wasCancelled = isMyJobCancelled();
    if (activeExportState.jobId === myJobId) {
      activeExportState.cancelled = false;
      activeExportState.proc = null;
    }
    const elapsedTime = ((Date.now() - activeExportState.startTime) / 1000).toFixed(1);

    if (!wasCancelled && result.code === 0 && fs.existsSync(outPath)) {
      const stats = fs.statSync(outPath);
      if (activeExportState.jobId === myJobId) {
        activeExportState.running = false;
        activeExportState.percent = 100;
        activeExportState.phase = 'done';
        activeExportState.statusText = '✅ Export រួចរាល់!';
        activeExportState.outputFile = outPath;
      }

      return res.json({
        success: true,
        outputFile: outPath,
        downloadUrl: `/api/export/download?file=${encodeURIComponent(outPath)}`,
        fileSize: stats.size,
        exportTime: `${elapsedTime}s`,
        cueCount: cues.length,
        dubbedCueCount,
        droppedDubCount,
        audioMixMode: dubMasterWav ? audioMixMode : (audioMixMode === 'bgm_only' ? 'bgm_only' : 'original'),
        encoder: attempt.encoderName,
        resolution,
        qualityPreset,
        logoApplied: !useVideoStreamCopy && Boolean(logoSpec),
        sponsorApplied: !useVideoStreamCopy && Boolean(sponsorSpec || logoSpec)
      });
    }

    cleanupPartialOut();
    const cleanStderr = String((result && result.stderrTail) || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    const errMsg = wasCancelled
      ? 'Export cancelled by user'
      : `FFmpeg failed with exit code ${result.code}${cleanStderr ? `: ${cleanStderr.slice(-280)}` : ''}`;
    if (!wasCancelled) {
      logError('export/video:ffmpeg', errMsg);
    }
    if (activeExportState.jobId === myJobId) {
      activeExportState.running = false;
      activeExportState.phase = wasCancelled ? 'cancelled' : 'error';
      activeExportState.error = errMsg;
      activeExportState.statusText = errMsg;
    }

    return res.status(wasCancelled ? 499 : 500).json({
      success: false,
      cancelled: wasCancelled,
      error: errMsg
    });
  } catch (e) {
    logError('export/video', e);
    console.error('[export/video]:', e);
    cleanupTempFiles();
    cleanupPartialOut();
    const wasCancelled = Boolean(e && e.cancelled) || activeExportState.cancelled || activeExportState.jobId !== myJobId;
    if (activeExportState.jobId === myJobId) {
      activeExportState.running = false;
      activeExportState.cancelled = false;
      activeExportState.proc = null;
      activeExportState.phase = wasCancelled ? 'cancelled' : 'error';
      activeExportState.error = e.message;
      activeExportState.statusText = e.message;
    }
    if (!res.headersSent) {
      res.status(wasCancelled ? 499 : (e.cancelled ? 499 : 500)).json({
        success: false,
        cancelled: wasCancelled,
        error: e.message
      });
    }
  } finally {
    if (activeExportJobPromise === thisJobPromise) {
      activeExportJobPromise = null;
    }
    if (typeof resolveCurrentJobPromise === 'function') {
      resolveCurrentJobPromise();
    }
  }
});

/**
 * GET /api/export/progress
 * Get current export progress
 */
router.get('/progress', (req, res) => {
  res.json({
    running: activeExportState.running,
    percent: activeExportState.percent,
    timeStr: activeExportState.timeStr,
    speed: activeExportState.speed,
    phase: activeExportState.phase,
    statusText: activeExportState.statusText,
    error: activeExportState.error,
    outputFile: activeExportState.outputFile
  });
});

/**
 * POST /api/export/cancel
 * Cancel ongoing export (works during TTS prep, dub batching, or final render)
 */
function cancelActiveExportProcesses() {
  if (!(activeExportState.running || activeExportState.proc || activeExportState.helperProcs.size > 0)) {
    return false;
  }
  activeExportState.cancelled = true;
  for (const hp of Array.from(activeExportState.helperProcs)) {
    killExportProcessTree(hp);
  }
  activeExportState.helperProcs.clear();
  if (activeExportState.proc) {
    killExportProcessTree(activeExportState.proc);
  }
  activeExportState.running = false;
  activeExportState.phase = 'cancelled';
  activeExportState.error = 'Export cancelled by user';
  activeExportState.statusText = '🛑 បានបោះបង់ការ Export';
  return true;
}

router.post('/cancel', (req, res) => {
  try {
    if (cancelActiveExportProcesses()) {
      res.json({ success: true, cancelled: true, message: 'Export cancelled' });
    } else {
      res.json({ success: true, message: 'No export running' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/default-dir', (req, res) => {
  const dir = path.resolve(getExportDir());
  res.json({ success: true, exportDir: dir });
});

router.post('/open-folder', (req, res) => {
  try {
    const rawTarget = req.body && typeof req.body.targetPath === 'string' ? req.body.targetPath.trim() : '';
    let resolved = rawTarget ? path.normalize(rawTarget) : path.resolve(getExportDir());
    if (!path.isAbsolute(resolved)) {
      return res.status(400).json({ success: false, error: 'targetPath must be an absolute path' });
    }
    if (rawTarget && isBlockedNetworkOrStreamPath(rawTarget, resolved)) {
      return res.status(403).json({ success: false, error: 'Invalid or network path not permitted' });
    }
    if (!fs.existsSync(resolved)) {
      if (!rawTarget) {
        fs.mkdirSync(resolved, { recursive: true });
      } else {
        const parent = path.dirname(resolved);
        if (!fs.existsSync(parent)) {
          return res.status(404).json({ success: false, error: 'Folder not found' });
        }
        resolved = parent;
      }
    }
    const stat = fs.statSync(resolved);
    if (process.platform === 'win32') {
      const args = stat.isFile() ? [`/select,${resolved}`] : [resolved];
      const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
    } else if (process.platform === 'darwin') {
      const args = stat.isFile() ? ['-R', resolved] : [resolved];
      const child = spawn('open', args, { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      const targetDir = stat.isFile() ? path.dirname(resolved) : resolved;
      const child = spawn('xdg-open', [targetDir], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    return res.json({ success: true, openedPath: resolved });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/export/download
 * Stream an exported MP4 or SRT file as a browser/phone download attachment
 */
router.get('/download', (req, res) => {
  try {
    const rawFile = req.query && typeof req.query.file === 'string' ? req.query.file.trim() : '';
    const target = rawFile ? path.normalize(rawFile) : (activeExportState.outputFile || '');
    if (!target || !path.isAbsolute(target)) {
      return res.status(400).json({ success: false, error: 'Missing or invalid file path' });
    }
    if (isBlockedNetworkOrStreamPath(rawFile || target, target)) {
      return res.status(403).json({ success: false, error: 'Access denied for path' });
    }
    const fileName = path.basename(target);
    const ext = path.extname(fileName).toLowerCase();
    if (!DOWNLOAD_ALLOWLIST.has(ext)) {
      return res.status(403).json({ success: false, error: 'File type not permitted for download' });
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return res.status(404).json({ success: false, error: 'Exported file not found' });
    }
    const mimeMap = {
      '.srt': 'application/x-subrip; charset=utf-8',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska',
      '.webm': 'video/webm'
    };
    const mime = mimeMap[ext] || 'video/mp4';
    const stat = fs.statSync(target);
    const safeAsciiName = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeAsciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    const stream = fs.createReadStream(target);
    req.on('close', () => stream.destroy());
    stream.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
      else res.destroy();
    });
    return stream.pipe(res);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.secondsToAssTime = secondsToAssTime;
router.wrapKhmerText = wrapKhmerText;
router.segmentTextForKaraoke = segmentTextForKaraoke;
router.serializeAss = serializeAss;
router.normalizeCustomTextOverlay = normalizeCustomTextOverlay;
router.normalizeAntiCopyrightOptions = normalizeAntiCopyrightOptions;
router.buildAntiCopyrightVideoPrefix = buildAntiCopyrightVideoPrefix;
router.serializeAss = serializeAss;
router.hexToAssColor = hexToAssColor;
router.buildExportFilter = buildExportFilter;
router.resolveSponsorOverlaySpec = resolveSponsorOverlaySpec;
router.buildVideoGraphWithSponsor = buildVideoGraphWithSponsor;
router.getScaleFilterExpr = getScaleFilterExpr;
router.computeCueTempo = computeCueTempo;
router.buildTempoFilterChain = buildTempoFilterChain;
router.buildAudioMixGraph = buildAudioMixGraph;
router.computeAdaptiveMaxrateKbps = computeAdaptiveMaxrateKbps;
router.getAudioBitrateForPreset = getAudioBitrateForPreset;
router.estimateExportSize = estimateExportSize;
router.QUALITY_PROFILES = QUALITY_PROFILES;
router.MAXRATE_TIERS_KBPS = MAXRATE_TIERS_KBPS;
router.buildVideoEncodingArgs = buildVideoEncodingArgs;
router.parseMediaInfoFromStderr = parseMediaInfoFromStderr;
router.detectHardwareEncoder = detectHardwareEncoder;
router.getSystemSpecProfile = getSystemSpecProfile;
router.prepareCueAudioClips = prepareCueAudioClips;
router.enforceNonOverlappingDubSchedule = enforceNonOverlappingDubSchedule;
router.renderDubMasterWav = renderDubMasterWav;
router.cancelActiveExportProcesses = cancelActiveExportProcesses;

module.exports = router;
