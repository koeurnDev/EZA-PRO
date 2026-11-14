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
const { FFMPEG_BIN } = require('../utils/ffmpeg');
const ttsRouter = require('./tts');
const audioRouter = require('./audio');
const { normalizeKhmerChuonNath, segmentKhmerWithChuonNath } = require('../utils/khmer-chuon-nath');

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
    libx264: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p'],
    h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p3', '-cq', '22', '-pix_fmt', 'yuv420p'],
    h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'fast', '-global_quality', '22', '-pix_fmt', 'nv12'],
    h264_amf: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '22', '-pix_fmt', 'yuv420p']
  },
  hd: {
    libx264: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p'],
    h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '18', '-pix_fmt', 'yuv420p'],
    h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', '18', '-pix_fmt', 'nv12'],
    h264_amf: ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '18', '-qp_p', '18', '-pix_fmt', 'yuv420p']
  },
  ultra: {
    libx264: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p'],
    h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p7', '-cq', '15', '-pix_fmt', 'yuv420p'],
    h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'slow', '-global_quality', '15', '-pix_fmt', 'nv12'],
    h264_amf: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '15', '-qp_p', '15', '-pix_fmt', 'yuv420p']
  }
};

function getExportDir() {
  return process.env.EXPORT_DIR || EXPORT_DIR;
}

if (!fs.existsSync(getExportDir())) {
  fs.mkdirSync(getExportDir(), { recursive: true });
}

let cachedHwEncoder;

let activeExportState = {
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
  startTime: null
};

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

  return line.slice(0, maxChars) + '\\N' + line.slice(maxChars);
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

function serializeAss(cues, styleName = 'tiktok', fontSize = 58, marginV = 320, wordPopEnabled = true) {
  let primaryCol = '&H00FFFFFF';
  let outlineCol = '&H00000000';
  let backCol = '&H80000000';
  let borderStyle = 1;
  let outline = 4.5;
  let shadow = 2.5;

  if (styleName === 'tiktok') {
    primaryCol = '&H00FFFFFF';
    outlineCol = '&H00000000';
    outline = 3.6;
    shadow = 1.8;
  } else if (styleName === 'hormozi') {
    primaryCol = '&H0066FF00';
    outlineCol = '&H00000000';
    outline = 4.0;
    shadow = 2.2;
  } else if (styleName === 'mrbeast') {
    primaryCol = '&H00FFFFFF';
    outlineCol = '&H00000000';
    backCol = '&H00C78402';
    outline = 4.0;
    shadow = 2.5;
  } else if (styleName === 'capcut_box') {
    primaryCol = '&H00160D09';
    outlineCol = '&H0000E6FF';
    backCol = '&H0000E6FF';
    borderStyle = 3;
    outline = 4.0;
    shadow = 0;
  } else if (styleName === 'drama_red') {
    primaryCol = '&H00FFFFFF';
    outlineCol = '&H003C12BE';
    outline = 3.8;
    shadow = 2.0;
  } else if (styleName === 'pill') {
    primaryCol = '&H00FFFFFF';
    outlineCol = '&H00000000';
    backCol = '&H99111111';
    borderStyle = 3;
    outline = 3.2;
    shadow = 0;
  } else if (styleName === 'neon') {
    primaryCol = '&H00FFFFFF';
    outlineCol = '&H00E5C000';
    outline = 3.8;
    shadow = 2.2;
  }

  const vMargin = marginV || 320;
  const fSize = fontSize || 58;

  const header = `[Script Info]
Title: Khmer Short Drama Subtitles
ScriptType: v4.00+
Collisions: Normal
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: KhmerSub,Kantumruy Pro,${fSize},${primaryCol},&H000000FF,${outlineCol},${backCol},1,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},2,40,40,${vMargin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = [];
  for (const c of cues) {
    if (!c || typeof c !== 'object') continue;
    const startSec = Math.max(0, Number(c.startSec) || 0);
    const rawEnd = Number(c.endSec);
    const endSec = Number.isFinite(rawEnd) && rawEnd > startSec ? rawEnd : startSec + 0.1;
    const rawTxt = String(c.translated || c.text || '').replace(/\r/g, '').replace(/\{/g, '(').replace(/\}/g, ')').trim();
    if (!rawTxt) continue;

    const cueDur = Math.max(0.1, endSec - startSec);
    const chunks = segmentTextForKaraoke(rawTxt, 24, 5);
    if (!chunks.length || cueDur < 0.25) {
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
    for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
      const ch = chunks[cIdx];
      for (let wIdx = 0; wIdx < ch.words.length; wIdx++) {
        const w = ch.words[wIdx];
        const isLastWordOfCue = (cIdx === chunks.length - 1) && (wIdx === ch.words.length - 1);
        const wStartSec = startSec + (accumWeight / totalWeight) * activeSpeakDur;
        accumWeight += w.weight;
        const wEndSec = isLastWordOfCue
          ? Math.max(wStartSec + 0.05, endSec)
          : (startSec + (accumWeight / totalWeight) * activeSpeakDur);
        if (wEndSec - wStartSec < 0.02) continue;

        const lineText = ch.words.map((wordObj, idx) => {
          const sep = wordObj.spaceAfter ? ' ' : '';
          if (idx === wIdx) {
            return `{\\c&H0000B8FF&}${wordObj.text}{\\c${primaryCol}&}${sep}`;
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
 * Compute target lanczos scale filter expression when scaling beyond 'source'.
 */
function getScaleFilterExpr(resolution = 'source', mediaInfo = null) {
  const spec = RESOLUTION_SPECS[resolution];
  if (!spec) return '';

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
    return `scale=${targetW}:${targetH}:flags=lanczos`;
  }

  return `scale='if(gt(iw,ih),${spec.longEdge},if(eq(iw,ih),${spec.shortEdge},-2))':'if(gt(iw,ih),-2,${spec.longEdge})':flags=lanczos`;
}

/**
 * Build FFmpeg video filter chain with optional HD upscaling, subtitle mask, and ASS burn-in.
 */
function buildExportFilter(assFilePath, options = {}) {
  const {
    maskEnabled = true,
    maskMode = 'feathered',
    maskYPercent = 0.78,
    maskHPercent = 0.07,
    maskWPercent = 0.92,
    resolution = 'source',
    mediaInfo = null
  } = options;

  const escapedAss = assFilePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
  const assFilter = `ass='${escapedAss}'`;
  const scaleExpr = getScaleFilterExpr(resolution, mediaInfo);

  if (!maskEnabled) {
    return scaleExpr ? `${scaleExpr},${assFilter}` : assFilter;
  }

  const safeW = Number(Math.min(1, Math.max(0.05, Number(maskWPercent) || 0.92)).toFixed(4));
  const safeH = Number(Math.min(1, Math.max(0.02, Number(maskHPercent) || 0.07)).toFixed(4));
  const safeY = Number(Math.min(Math.max(0, Number(maskYPercent) || 0.78), 1 - safeH).toFixed(4));

  if (maskMode === 'cinema_bar') {
    const box = `drawbox=x=0:y=ih*${safeY}:w=iw:h=ih*${safeH}:color=black@0.75:t=fill,${assFilter}`;
    return scaleExpr ? `${scaleExpr},${box}` : box;
  }
  if (maskMode === 'black') {
    const box = `drawbox=x=(iw-iw*${safeW})/2:y=ih*${safeY}:w=iw*${safeW}:h=ih*${safeH}:color=black@0.92:t=fill,${assFilter}`;
    return scaleExpr ? `${scaleExpr},${box}` : box;
  }

  const brightnessExpr = maskMode === 'frosted' ? ',eq=brightness=0.06' : '';
  const blurTail = `[copy]crop=iw*${safeW}:ih*${safeH}:(iw-iw*${safeW})/2:ih*${safeY},gblur=sigma=12${brightnessExpr}[blurred];[orig][blurred]overlay=(W-w)/2:H*${safeY}[vmasked];[vmasked]${assFilter}`;

  if (scaleExpr) {
    return `[0:v]${scaleExpr}[vscaled];[vscaled]split[orig][copy];${blurTail}`;
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
  if (!fs.existsSync(normalizedPath)) {
    const err = new Error('Sponsor/Logo file not found');
    err.statusCode = 404;
    throw err;
  }

  const ext = path.extname(normalizedPath).toLowerCase();
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
    xExpr = `min(W-w,max(0,W*${cx}))`;
    yExpr = `min(H-h,max(0,H*${cy}))`;
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

function buildVideoGraphWithSponsor(videoFilter, outLabel = 'vout', sponsorSpecOrList = null) {
  const rawList = Array.isArray(sponsorSpecOrList) ? sponsorSpecOrList : [sponsorSpecOrList];
  const activeList = rawList.filter(s => s && s.enabled && s.inputIndex >= 1);
  if (activeList.length === 0) {
    return toFilterComplexVideo(videoFilter, outLabel);
  }
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
    parts.push(`[${inputIndex}:v]scale=${targetWidth}:-2:flags=lanczos,format=rgba${alphaFilter}[${ovLabel}]`);
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

  const hasAudio = /Stream #\d+:\d+[^:]*:\s*Audio:/m.test(stderr);
  return { durationSec, width, height, hasAudio };
}

function probeMediaInfo(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_BIN, ['-hide_banner', '-i', filePath], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', () => resolve({ durationSec: 0, width: 0, height: 0, hasAudio: true }));
    proc.on('close', () => resolve(parseMediaInfoFromStderr(stderr)));
  });
}

function detectHardwareEncoder() {
  if (cachedHwEncoder !== undefined) {
    return cachedHwEncoder;
  }
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

function buildVideoEncodingArgs(qualityPreset = 'hd', requestedEncoder = 'cpu') {
  const profile = QUALITY_PROFILES[qualityPreset] || QUALITY_PROFILES.hd;
  let encoderName = 'libx264';

  if (requestedEncoder === 'auto' || requestedEncoder === 'gpu') {
    const hw = detectHardwareEncoder();
    if (hw && profile[hw]) {
      encoderName = hw;
    }
  } else if (profile[requestedEncoder]) {
    encoderName = requestedEncoder;
  }

  return {
    encoderName,
    args: [...profile[encoderName], '-movflags', '+faststart']
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
    candidates.push({
      cueIndex: i,
      startSec,
      endSec,
      spokenText,
      voice: lockSingleVoice || cue.voice || 'Sovereign King'
    });
  }

  candidates.sort((a, b) => a.startSec - b.startSec);

  const clips = [];
  for (let i = 0; i < candidates.length; i++) {
    if (isCancelled()) {
      const cancelErr = new Error('Export cancelled by user');
      cancelErr.cancelled = true;
      throw cancelErr;
    }

    const item = candidates[i];
    const ttsOpts = { engine: 'edge', strictVoice: strictVoice !== false };
    const key = ttsRouter.getAudioCacheKey(item.spokenText, item.voice, ttsOpts);
    let filePath = path.join(cacheDir, `${key}.mp3`);

    if (!isValidAudioFile(filePath) && autoGenerateMissingTts) {
      if (onProgress) {
        onProgress(i + 1, candidates.length);
      }
      const synthOpts = {
        ...ttsOpts,
        req
      };
      let result;
      try {
        result = await ttsRouter.synthesizeTts(item.spokenText, item.voice, synthOpts);
      } catch (firstErr) {
        if (firstErr && firstErr.needsCloneEngineInstall) {
          throw firstErr;
        }
        // Retry once cleanly for transient TTS network drops
        result = await ttsRouter.synthesizeTts(item.spokenText, item.voice, synthOpts);
      }
      if (result && result.key) {
        filePath = path.join(cacheDir, `${result.key}.mp3`);
      }
    }

    if (isValidAudioFile(filePath)) {
      clips.push({ ...item, filePath });
    }
  }

  // Probe durations cleanly in batches of 6
  for (let i = 0; i < clips.length; i += 6) {
    const slice = clips.slice(i, i + 6);
    const infos = await Promise.all(slice.map(c => probeMediaInfo(c.filePath)));
    for (let j = 0; j < slice.length; j++) {
      slice[j].clipDurSec = infos[j].durationSec || 0;
    }
  }

  for (let i = 0; i < clips.length; i++) {
    let nextStartSec = Infinity;
    for (let k = i + 1; k < clips.length; k++) {
      if (clips[k].startSec > clips[i].startSec + 0.05) {
        nextStartSec = clips[k].startSec;
        break;
      }
    }
    clips[i].tempo = computeCueTempo(
      clips[i].clipDurSec,
      clips[i].startSec,
      clips[i].endSec,
      nextStartSec,
      autoFitTiming
    );
  }

  return clips;
}

function runFfmpegSimple(args, onSpawn = null) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    if (onSpawn) onSpawn(proc);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      const err = new Error(`FFmpeg helper exited with code ${code}: ${stderr.slice(-500)}`);
      err.code = code;
      reject(err);
    });
  });
}

/**
 * Render arbitrarily many timed dubbing clips into one clean stereo WAV track using batching.
 */
async function renderDubMasterWav(clips, workDir, onSpawn = null) {
  const masterWav = path.join(workDir, 'dub_master.wav');
  const batchOutputs = [];

  for (let start = 0; start < clips.length; start += DUB_BATCH_SIZE) {
    const batch = clips.slice(start, start + DUB_BATCH_SIZE);
    const batchIdx = Math.floor(start / DUB_BATCH_SIZE);
    const outWav = clips.length <= DUB_BATCH_SIZE
      ? masterWav
      : path.join(workDir, `dub_batch_${batchIdx}.wav`);
    const scriptPath = path.join(workDir, `dub_batch_${batchIdx}.ffscript`);

    const args = ['-y'];
    const filterLines = [];
    const mixLabels = [];

    for (let j = 0; j < batch.length; j++) {
      const clip = batch[j];
      args.push('-i', clip.filePath);
      const delayMs = Math.max(0, Math.round(clip.startSec * 1000));
      const delayFilter = delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : '';
      const tempoFilter = buildTempoFilterChain(clip.tempo);
      const label = batch.length === 1 ? 'aout' : `a${j}`;
      filterLines.push(`[${j}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo${tempoFilter}${delayFilter}[${label}]`);
      mixLabels.push(`[${label}]`);
    }

    if (batch.length > 1) {
      filterLines.push(`${mixLabels.join('')}amix=inputs=${batch.length}:duration=longest:normalize=0:dropout_transition=0[aout]`);
    }

    fs.writeFileSync(scriptPath, filterLines.join(';\n'), 'utf8');
    args.push('-filter_complex_script', scriptPath, '-map', '[aout]', '-c:a', 'pcm_s16le', outWav);
    await runFfmpegSimple(args, onSpawn);
    batchOutputs.push(outWav);
  }

  if (batchOutputs.length > 1) {
    const mergeScript = path.join(workDir, 'dub_merge.ffscript');
    const args = ['-y'];
    const labels = [];
    const prepLines = [];
    for (let i = 0; i < batchOutputs.length; i++) {
      args.push('-i', batchOutputs[i]);
      prepLines.push(`[${i}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[b${i}]`);
      labels.push(`[b${i}]`);
    }
    prepLines.push(`${labels.join('')}amix=inputs=${batchOutputs.length}:duration=longest:normalize=0:dropout_transition=0[aout]`);
    fs.writeFileSync(mergeScript, prepLines.join(';\n'), 'utf8');
    args.push('-filter_complex_script', mergeScript, '-map', '[aout]', '-c:a', 'pcm_s16le', masterWav);
    await runFfmpegSimple(args, onSpawn);
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
  bgVolume = 0.28,
  dubVolume = 1.25
}) {
  const safeDur = Math.max(0.1, Number.isFinite(Number(durationSec)) && Number(durationSec) > 0 ? Number(durationSec) : 120).toFixed(3);
  const parsedBg = Number(bgVolume);
  const parsedDub = Number(dubVolume);
  const safeBgVol = Math.min(1.5, Math.max(0, Number.isFinite(parsedBg) ? parsedBg : 0.28)).toFixed(2);
  const safeDubVol = Math.min(2.0, Math.max(0.1, Number.isFinite(parsedDub) ? parsedDub : 1.25)).toFixed(2);
  const dubNorm = `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${safeDubVol},apad=whole_dur=${safeDur},atrim=0:${safeDur},asetpts=PTS-STARTPTS`;

  if (!hasSourceAudio || audioMixMode === 'dub_only') {
    return `${dubNorm},dynaudnorm=f=150:g=15:p=0.9,alimiter=limit=0.95[aout]`;
  }

  if (audioMixMode === 'bgm_only') {
    const bgmVol = Math.min(1.5, Math.max(0.1, Number.isFinite(parsedBg) ? parsedBg : 0.65)).toFixed(2);
    const bgmSource = hasIsolatedBgmInput
      ? `[2:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${bgmVol},apad=whole_dur=${safeDur},atrim=0:${safeDur},asetpts=PTS-STARTPTS[bg]`
      : `[0:a]${audioRouter.BGM_ISOLATION_FILTER},volume=${bgmVol}[bg]`;
    return `${bgmSource};${dubNorm}[dubfull];[dubfull]asplit=2[dub][sc];[bg][sc]sidechaincompress=threshold=0.01:ratio=12:attack=15:release=750[bg_ducked];[bg_ducked][dub]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`;
  }

  const bgNorm = `[0:a]${audioRouter.BGM_ISOLATION_FILTER},volume=${safeBgVol}[bg]`;

  if (audioMixMode === 'bg_low') {
    const lowVol = Math.min(0.45, Math.max(0.05, Number(bgVolume) || 0.18)).toFixed(2);
    return `[0:a]${audioRouter.BGM_ISOLATION_FILTER},volume=${lowVol}[bg];${dubNorm}[dub];[bg][dub]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`;
  }

  // Smart auto-ducking with vocal suppression: suppresses original dialogue voice and ducks smoothly under Khmer speech
  return `${bgNorm};${dubNorm}[dubfull];[dubfull]asplit=2[dub][sc];[bg][sc]sidechaincompress=threshold=0.01:ratio=14:attack=15:release=750[bg_ducked];[bg_ducked][dub]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`;
}

function executeFfmpegRender(args, totalDurationSec) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    activeExportState.proc = proc;
    let stderrTail = '';

    proc.stderr.on('data', (d) => {
      const str = d.toString();
      stderrTail = (stderrTail + str).slice(-2000);

      const timeMatch = str.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (timeMatch) {
        const h = parseInt(timeMatch[1], 10);
        const m = parseInt(timeMatch[2], 10);
        const s = parseFloat(timeMatch[3]);
        const curSec = h * 3600 + m * 60 + s;
        activeExportState.percent = Math.min(99, Math.round((curSec / totalDurationSec) * 100));
        activeExportState.timeStr = `${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}`;
      }

      const speedMatch = str.match(/speed=\s*([\d\.]+x)/);
      if (speedMatch) {
        activeExportState.speed = speedMatch[1];
      }
    });

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (activeExportState.proc === proc) {
        activeExportState.proc = null;
      }
      resolve({ code, stderrTail });
    });
  });
}

/**
 * GET /api/export/capabilities
 * Inspect supported GPU encoders and export options.
 */
router.get('/capabilities', (req, res) => {
  const gpuEncoder = detectHardwareEncoder();
  res.json({
    success: true,
    gpuEncoder,
    presets: Object.keys(QUALITY_PROFILES),
    resolutions: Object.keys(RESOLUTION_SPECS)
  });
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

  try {
    const {
      videoPath,
      cues,
      duration = 120,
      maskEnabled = true,
      maskMode = 'feathered',
      subStyle = 'tiktok',
      subFontSize = 58,
      subMarginV = 320,
      wordPopEnabled = true,
      maskYPercent = 0.78,
      maskHPercent = 0.07,
      maskWPercent = 0.92,
      includeDubAudio = false,
      autoGenerateMissingTts = true,
      autoFitTiming = true,
      audioMixMode = 'duck',
      bgVolume,
      dubVolume = 1.15,
      ttsEngine = '',
      castMode = '',
      fixedVoice = '',
      strictVoice = true,
      qualityPreset = 'hd',
      resolution = 'source',
      encoder = 'cpu',
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
      sponsorYPercent
    } = req.body || {};

    if (typeof videoPath !== 'string' || !videoPath.trim()) {
      return res.status(400).json({ success: false, error: 'videoPath required' });
    }
    if (!Array.isArray(cues) || cues.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid or empty cues array' });
    }
    let exportDir = getExportDir();
    if (outputDir !== undefined && outputDir !== null && String(outputDir).trim()) {
      if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir.trim())) {
        return res.status(400).json({ success: false, error: 'outputDir must be an absolute path' });
      }
      exportDir = path.normalize(outputDir.trim());
    }

    const normalizedVideoPath = path.normalize(videoPath.trim());
    if (!fs.existsSync(normalizedVideoPath)) {
      return res.status(404).json({ success: false, error: 'Video file not found' });
    }
    try {
      fs.accessSync(normalizedVideoPath, fs.constants.R_OK);
    } catch (_) {
      return res.status(403).json({ success: false, error: 'Cannot read video file' });
    }

    if (activeExportState.running) {
      return res.status(409).json({ success: false, error: 'Another export is already running' });
    }

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

    const tempAss = path.join(workDir, 'subtitles.ass');
    fs.writeFileSync(tempAss, serializeAss(cues, subStyle, subFontSize, subMarginV, Boolean(wordPopEnabled)), 'utf8');

    const outName = `${path.basename(normalizedVideoPath, path.extname(normalizedVideoPath))}_Dubbed_${Date.now()}.mp4`;
    outPath = path.join(exportDir, outName);

    const mediaInfo = await probeMediaInfo(normalizedVideoPath);
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
    const totalDurationSec = mediaInfo.durationSec > 0
      ? mediaInfo.durationSec
      : (Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : 120);

    const shouldMixDub = Boolean(includeDubAudio) && audioMixMode !== 'original';
    let dubMasterWav = null;
    let dubbedCueCount = 0;

    if (shouldMixDub) {
      activeExportState.phase = 'tts';
      activeExportState.statusText = '🎙️ កំពុងពិនិត្យ និងបង្កើតសំឡេង AI Dubbing...';

      const clips = await prepareCueAudioClips(cues, {
        autoGenerateMissingTts,
        autoFitTiming,
        ttsEngine,
        castMode,
        fixedVoice,
        strictVoice,
        req,
        isCancelled: () => activeExportState.cancelled,
        onProgress: (done, total) => {
          activeExportState.percent = Math.min(20, Math.round((done / Math.max(1, total)) * 20));
          activeExportState.statusText = `🎙️ កំពុងបង្កើតសំឡេង AI Dubbing (${done}/${total})...`;
        }
      });

      if (activeExportState.cancelled) {
        cleanupTempFiles();
        cleanupPartialOut();
        activeExportState.running = false;
        activeExportState.cancelled = false;
        activeExportState.phase = 'cancelled';
        return res.status(499).json({ success: false, cancelled: true, error: 'Export cancelled by user' });
      }

      if (clips.length > 0) {
        dubbedCueCount = clips.length;
        // Sync ASS word-by-word karaoke timing cleanly using exact cueIndex when available
        const syncedCues = cues.map(c => ({ ...c }));
        for (const clip of clips) {
          const spokenDur = (Number(clip.clipDurSec) || 0) / Math.max(0.5, Number(clip.tempo) || 1);
          if (spokenDur > 0.1) {
            const match = (Number.isInteger(clip.cueIndex) && syncedCues[clip.cueIndex])
              ? syncedCues[clip.cueIndex]
              : syncedCues.find(c => Math.abs((Number(c && c.startSec) || 0) - clip.startSec) < 0.04);
            if (match) match._spokenDurSec = spokenDur;
          }
        }
        fs.writeFileSync(tempAss, serializeAss(syncedCues, subStyle, subFontSize, subMarginV, Boolean(wordPopEnabled)), 'utf8');

        activeExportState.phase = 'audio_mix';
        activeExportState.statusText = `🔊 កំពុងរៀបចំតម្រៀបសំឡេង Dubbing ${clips.length} បន្ទាត់...`;
        dubMasterWav = await renderDubMasterWav(clips, workDir, (p) => { activeExportState.proc = p; });
      }
    }

    const filterString = buildExportFilter(tempAss, {
      maskEnabled,
      maskMode,
      maskYPercent,
      maskHPercent,
      maskWPercent,
      resolution,
      mediaInfo
    });

    const cachedBgmStems = audioMixMode === 'bgm_only'
      ? audioRouter.getCachedStemsForVideo(normalizedVideoPath)
      : null;

    const buildFinalArgs = (useEncoder) => {
      const enc = buildVideoEncodingArgs(qualityPreset, useEncoder);
      const args = ['-y', '-i', normalizedVideoPath];

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
        const hasIsolatedBgmInput = Boolean(cachedBgmStems && cachedBgmStems.bgmPath);
        if (hasIsolatedBgmInput) {
          args.push('-i', cachedBgmStems.bgmPath);
        }
        const activeOverlays = attachOverlayInputs(hasIsolatedBgmInput ? 3 : 2);
        const videoGraph = buildVideoGraphWithSponsor(filterString, 'vout', activeOverlays);
        const resolvedBgVol = Number.isFinite(Number(bgVolume))
          ? Number(bgVolume)
          : (audioMixMode === 'bg_low' ? 0.25 : (audioMixMode === 'bgm_only' ? 0.75 : 0.55));
        const audioGraph = buildAudioMixGraph({
          audioMixMode,
          hasSourceAudio: mediaInfo.hasAudio,
          hasIsolatedBgmInput,
          durationSec: totalDurationSec,
          bgVolume: resolvedBgVol,
          dubVolume
        });
        const fcScript = path.join(workDir, `export_${enc.encoderName}.ffscript`);
        fs.writeFileSync(fcScript, `${videoGraph};${audioGraph}`, 'utf8');
        args.push('-filter_complex_script', fcScript, '-map', '[vout]', '-map', '[aout]');
        args.push(...enc.args, '-c:a', 'aac', '-b:a', '192k', outPath);
      } else {
        const hasIsolatedBgmInput = Boolean(audioMixMode === 'bgm_only' && cachedBgmStems && cachedBgmStems.bgmPath);
        if (hasIsolatedBgmInput) {
          args.push('-i', cachedBgmStems.bgmPath);
          const activeOverlays = attachOverlayInputs(2);
          const videoGraph = buildVideoGraphWithSponsor(filterString, 'vout', activeOverlays);
          const safeDur = Math.max(0.1, Number.isFinite(Number(totalDurationSec)) && Number(totalDurationSec) > 0 ? Number(totalDurationSec) : 120).toFixed(3);
          const fcScript = path.join(workDir, `export_${enc.encoderName}.ffscript`);
          fs.writeFileSync(
            fcScript,
            `${videoGraph};[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${safeDur},atrim=0:${safeDur},asetpts=PTS-STARTPTS[aout]`,
            'utf8'
          );
          args.push('-filter_complex_script', fcScript, '-map', '[vout]', '-map', '[aout]');
          args.push(...enc.args, '-c:a', 'aac', '-b:a', '192k', outPath);
        } else if (overlaySpecs.length > 0) {
          const activeOverlays = attachOverlayInputs(1);
          const videoGraph = buildVideoGraphWithSponsor(filterString, 'vout', activeOverlays);
          const fcScript = path.join(workDir, `export_${enc.encoderName}.ffscript`);
          fs.writeFileSync(fcScript, videoGraph, 'utf8');
          args.push('-filter_complex_script', fcScript, '-map', '[vout]');
          if (mediaInfo.hasAudio) {
            args.push('-map', '0:a:0?');
            if (audioMixMode === 'bgm_only') {
              args.push('-af', audioRouter.BGM_ISOLATION_FILTER, '-c:a', 'aac', '-b:a', '192k');
            } else {
              args.push('-c:a', 'copy');
            }
          }
          args.push(...enc.args, outPath);
        } else {
          args.push('-vf', filterString, ...enc.args);
          if (mediaInfo.hasAudio) {
            if (audioMixMode === 'bgm_only') {
              args.push('-af', audioRouter.BGM_ISOLATION_FILTER, '-c:a', 'aac', '-b:a', '192k');
            } else {
              args.push('-c:a', 'copy');
            }
          }
          args.push(outPath);
        }
      }
      return { args, encoderName: enc.encoderName };
    };

    activeExportState.phase = 'encoding';
    activeExportState.statusText = dubMasterWav
      ? '⚡ កំពុង Render HD និងលាយសំឡេង AI Dubbing...'
      : '⚡ កំពុង Render HD និងដុតអក្សររត់...';

    let attempt = buildFinalArgs(encoder);
    let result = await executeFfmpegRender(attempt.args, totalDurationSec);

    // If hardware GPU encoder failed unexpectedly, fall back once cleanly to CPU libx264
    if (!activeExportState.cancelled && result.code !== 0 && attempt.encoderName !== 'libx264') {
      cleanupPartialOut();
      activeExportState.statusText = '🔄 GPU មិនគាំទ្រវីដេអូនេះ — កំពុងប្ដូរទៅ CPU libx264...';
      attempt = buildFinalArgs('cpu');
      result = await executeFfmpegRender(attempt.args, totalDurationSec);
    }

    cleanupTempFiles();
    const wasCancelled = activeExportState.cancelled;
    activeExportState.cancelled = false;
    activeExportState.proc = null;
    const elapsedTime = ((Date.now() - activeExportState.startTime) / 1000).toFixed(1);

    if (!wasCancelled && result.code === 0 && fs.existsSync(outPath)) {
      const stats = fs.statSync(outPath);
      activeExportState.running = false;
      activeExportState.percent = 100;
      activeExportState.phase = 'done';
      activeExportState.statusText = '✅ Export រួចរាល់!';
      activeExportState.outputFile = outPath;

      return res.json({
        success: true,
        outputFile: outPath,
        fileSize: stats.size,
        exportTime: `${elapsedTime}s`,
        cueCount: cues.length,
        dubbedCueCount,
        audioMixMode: dubMasterWav ? audioMixMode : (audioMixMode === 'bgm_only' ? 'bgm_only' : 'original'),
        encoder: attempt.encoderName,
        resolution,
        qualityPreset,
        logoApplied: Boolean(logoSpec),
        sponsorApplied: Boolean(sponsorSpec || logoSpec)
      });
    }

    cleanupPartialOut();
    const errMsg = wasCancelled
      ? 'Export cancelled by user'
      : `FFmpeg failed with exit code ${result.code}`;
    activeExportState.running = false;
    activeExportState.phase = wasCancelled ? 'cancelled' : 'error';
    activeExportState.error = errMsg;
    activeExportState.statusText = errMsg;

    return res.status(wasCancelled ? 499 : 500).json({
      success: false,
      cancelled: wasCancelled,
      error: errMsg
    });
  } catch (e) {
    console.error('[export/video]:', e);
    cleanupTempFiles();
    cleanupPartialOut();
    const wasCancelled = Boolean(e && e.cancelled) || activeExportState.cancelled;
    activeExportState.running = false;
    activeExportState.cancelled = false;
    activeExportState.proc = null;
    activeExportState.phase = wasCancelled ? 'cancelled' : 'error';
    activeExportState.error = e.message;
    activeExportState.statusText = e.message;
    if (!res.headersSent) {
      res.status(wasCancelled ? 499 : (e.cancelled ? 499 : 500)).json({
        success: false,
        cancelled: wasCancelled,
        error: e.message
      });
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
router.post('/cancel', (req, res) => {
  if (activeExportState.running || activeExportState.proc) {
    try {
      activeExportState.cancelled = true;
      if (activeExportState.proc) {
        activeExportState.proc.kill('SIGKILL');
      }
      activeExportState.running = false;
      activeExportState.phase = 'cancelled';
      activeExportState.error = 'Export cancelled by user';
      activeExportState.statusText = '🛑 បានបោះបង់ការ Export';
      res.json({ success: true, cancelled: true, message: 'Export cancelled' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  } else {
    res.json({ success: true, message: 'No export running' });
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
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return res.status(404).json({ success: false, error: 'Exported file not found' });
    }
    const fileName = path.basename(target);
    const ext = path.extname(fileName).toLowerCase();
    const mime = ext === '.srt' ? 'application/x-subrip; charset=utf-8' : 'video/mp4';
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
router.buildExportFilter = buildExportFilter;
router.resolveSponsorOverlaySpec = resolveSponsorOverlaySpec;
router.buildVideoGraphWithSponsor = buildVideoGraphWithSponsor;
router.getScaleFilterExpr = getScaleFilterExpr;
router.computeCueTempo = computeCueTempo;
router.buildTempoFilterChain = buildTempoFilterChain;
router.buildAudioMixGraph = buildAudioMixGraph;
router.buildVideoEncodingArgs = buildVideoEncodingArgs;
router.parseMediaInfoFromStderr = parseMediaInfoFromStderr;
router.detectHardwareEncoder = detectHardwareEncoder;
router.prepareCueAudioClips = prepareCueAudioClips;

module.exports = router;
