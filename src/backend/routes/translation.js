/**
 * EZA PRO - Chinese subtitle OCR and context-aware translation
 */

const express = require('express');
const router = express.Router();
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig, saveConfig, beginGeminiStream, getGeminiApiKeyCandidates, markGeminiKeyRateLimited, markGeminiKeyHealthy } = require('./config');
const { FFMPEG_BIN } = require('../utils/ffmpeg');
const voiceCloner = require('../utils/voice-cloner');
const {
  CHUON_NATH_PROMPT_GUIDE,
  isChuonNathWord,
  normalizeKhmerChuonNath,
  segmentKhmerWithChuonNath,
  auditKhmerAgainstChuonNath,
  getChuonNathStats
} = require('../utils/khmer-chuon-nath');
require('../utils/dns-fix');
const translationCache = require('../../../translation_cache');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const GEMINI_FALLBACK_MODELS = [
  GEMINI_MODEL,
  'gemini-3.1-flash-lite-preview',
  'gemini-3.8-flash',
  'gemini-4-hydrogen'
].filter((model, index, list) => Boolean(model) && list.indexOf(model) === index);
let preferredGeminiModel = GEMINI_MODEL;
const HYDROGEN_MODEL = 'gemini-4-hydrogen';
const blockedModelsUntil = new Map();

function normalizeRouterModelMode(mode) {
  return String(mode || '').trim().toLowerCase() === 'smart' ? 'smart' : 'fast';
}

function readPersistedRouterModelMode() {
  if (process.env.GEMINI_ROUTER_MODE) {
    return normalizeRouterModelMode(process.env.GEMINI_ROUTER_MODE);
  }
  try {
    const cfg = typeof loadConfig === 'function' ? loadConfig() : null;
    if (cfg && typeof cfg.GEMINI_ROUTER_MODE === 'string' && cfg.GEMINI_ROUTER_MODE.trim()) {
      return normalizeRouterModelMode(cfg.GEMINI_ROUTER_MODE);
    }
  } catch (_) {}
  return 'fast';
}

let routerModelMode = readPersistedRouterModelMode();
preferredGeminiModel = routerModelMode === 'smart' ? HYDROGEN_MODEL : GEMINI_MODEL;

function getRouterModelMode() {
  return routerModelMode;
}

function setRouterModelMode(mode, options = {}) {
  routerModelMode = normalizeRouterModelMode(mode);
  preferredGeminiModel = routerModelMode === 'smart' ? HYDROGEN_MODEL : GEMINI_MODEL;
  if (routerModelMode === 'smart') {
    blockedModelsUntil.delete(HYDROGEN_MODEL);
  } else {
    blockedModelsUntil.delete(GEMINI_MODEL);
  }
  if (options.persist !== false && typeof saveConfig === 'function') {
    try {
      saveConfig({ GEMINI_ROUTER_MODE: routerModelMode });
    } catch (_) {}
  }
  return {
    mode: routerModelMode,
    primaryModel: routerModelMode === 'smart' ? HYDROGEN_MODEL : GEMINI_MODEL,
    thinkingLevel: routerModelMode === 'smart' ? (process.env.GEMINI_4_THINKING_LEVEL || 'low') : 'none'
  };
}
const MAX_CUES = 1000;
const MAX_CUE_TEXT_LENGTH = 1000;
const MAX_TOTAL_TEXT_LENGTH = 120000;
const TRANSLATION_CHUNK_SIZE = 25;
const STORY_ANALYSIS_MIN_CUES = 4;
const OCR_BATCH_SIZE = 6;
const MAX_SPEECH_AUDIO_BYTES = 12 * 1024 * 1024;
const SPEECH_REQUEST_TIMEOUT_MS = 180000;
const DEFAULT_SPEECH_CHUNK_SEC = 60;
const SPEECH_VOCAL_FILTER = 'highpass=f=85,lowpass=f=7600';

const SOURCE_LANGUAGE_SPECS = {
  auto: { name: 'source-language (auto-detected)', ocrHint: 'any language (Chinese, English, Thai, Vietnamese, Korean, Japanese, Khmer, etc.)', speechHint: 'its original spoken language (auto-detect the language)' },
  zh: { name: 'Chinese', ocrHint: 'Simplified/Traditional Chinese', speechHint: 'Chinese' },
  en: { name: 'English', ocrHint: 'English', speechHint: 'English' },
  th: { name: 'Thai', ocrHint: 'Thai', speechHint: 'Thai' },
  vi: { name: 'Vietnamese', ocrHint: 'Vietnamese', speechHint: 'Vietnamese' },
  ko: { name: 'Korean', ocrHint: 'Korean', speechHint: 'Korean' },
  ja: { name: 'Japanese', ocrHint: 'Japanese', speechHint: 'Japanese' },
  km: { name: 'Khmer', ocrHint: 'Khmer', speechHint: 'Khmer' }
};

function isGemini4Model(modelName) {
  return /^gemini-4/i.test(String(modelName || '').trim());
}

function getGeminiTimeoutMs(modelName, timeoutMs = 60000) {
  return isGemini4Model(modelName) ? Math.max(timeoutMs, 35000) : timeoutMs;
}

function buildGeminiGenerationConfig(modelName) {
  const config = {
    maxOutputTokens: 16384,
    responseMimeType: 'application/json'
  };
  if (isGemini4Model(modelName)) {
    config.thinkingConfig = {
      thinkingLevel: process.env.GEMINI_4_THINKING_LEVEL || 'low'
    };
  } else {
    config.temperature = 0.2;
  }
  return config;
}

function callGeminiSingleModel(modelName, prompt, apiKey, extraParts = [], timeoutMs = 60000) {
  const effectiveTimeoutMs = getGeminiTimeoutMs(modelName, timeoutMs);
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      contents: [{
        parts: [{ text: prompt }, ...extraParts]
      }],
      generationConfig: buildGeminiGenerationConfig(modelName)
    });

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      family: 4,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: effectiveTimeoutMs
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch (err) {
          return reject(new Error('Gemini returned an invalid response.'));
        }

        if (res.statusCode < 200 || res.statusCode >= 300 || json.error) {
          const err = new Error(
            (json.error && json.error.message) || `Gemini API returned HTTP ${res.statusCode}.`
          );
          err.statusCode = res.statusCode;
          return reject(err);
        }

        const firstCandidate = json.candidates && json.candidates[0];
        const rawParts = (firstCandidate && firstCandidate.content && Array.isArray(firstCandidate.content.parts))
          ? firstCandidate.content.parts
          : [];
        const answerParts = rawParts.filter(part => part && !part.thought && typeof part.text === 'string');
        const text = (answerParts.length > 0 ? answerParts : rawParts)
          .map(part => (part && typeof part.text === 'string' ? part.text : ''))
          .join('');
        if (!text || !text.trim()) {
          const blockReason = (json.promptFeedback && json.promptFeedback.blockReason) ||
            (firstCandidate && firstCandidate.finishReason) || '';
          const emptyErr = new Error(
            blockReason ? `Gemini returned an empty response (${blockReason}).` : 'Gemini returned an empty response.'
          );
          emptyErr.isEmptyModelResponse = true;
          return reject(emptyErr);
        }
        resolve(text.trim());
      });
    });

    req.setTimeout(effectiveTimeoutMs, () => req.destroy(new Error('Gemini request timed out.')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function callGeminiApi(prompt, apiKey, extraParts = [], timeoutMs = 20000) {
  let lastError = null;
  const now = Date.now();
  const primaryModel = routerModelMode === 'smart' ? HYDROGEN_MODEL : GEMINI_MODEL;
  preferredGeminiModel = primaryModel;
  const baseOrdered = [
    primaryModel,
    ...GEMINI_FALLBACK_MODELS.filter(m => m !== primaryModel)
  ].filter(Boolean);
  const healthyModels = baseOrdered.filter(m => (blockedModelsUntil.get(m) || 0) <= now);
  const orderedModels = healthyModels.length > 0 ? healthyModels : baseOrdered;

  const hasAudioPart = Array.isArray(extraParts) && extraParts.some(p => p && p.inline_data && String(p.inline_data.mime_type || '').startsWith('audio/'));
  const hasImagePart = Array.isArray(extraParts) && extraParts.some(p => p && p.inline_data && String(p.inline_data.mime_type || '').startsWith('image/'));
  const streamTask = hasAudioPart ? 'Audio AI' : (hasImagePart ? 'Vision OCR' : 'Translation');

  for (const modelName of orderedModels) {
    const scope = `api:${modelName}`;
    const keyCandidates = getGeminiApiKeyCandidates(apiKey, scope);
    if (keyCandidates.length === 0) continue;

    let switchModelImmediately = false;
    for (const candidateKey of keyCandidates) {
      const stream = beginGeminiStream(candidateKey, streamTask);
      let succeeded = false;
      try {
        for (let netAttempt = 0; netAttempt < 2; netAttempt++) {
          try {
            if (netAttempt > 0) {
              await new Promise(r => setTimeout(r, 200));
            }
            const result = await callGeminiSingleModel(modelName, prompt, candidateKey, extraParts, timeoutMs);
            blockedModelsUntil.delete(modelName);
            markGeminiKeyHealthy(candidateKey, scope);
            succeeded = true;
            stream.end(true, 200);
            return result;
          } catch (err) {
            lastError = err;
            const msg = String(err && err.message || '');
            const isTimeout = /ETIMEDOUT|timed out/i.test(msg);
            const isSocketBlip = /ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up/i.test(msg);
            if (isSocketBlip && netAttempt === 0) {
              continue;
            }
            const isKeyAuthErr = err.statusCode === 401 || err.statusCode === 403 || /api key not valid|api_key_invalid|unauthenticated|permission denied/i.test(msg);
            if (isKeyAuthErr && keyCandidates.length > 1) {
              markGeminiKeyRateLimited(candidateKey, 5 * 60 * 1000, scope);
              break;
            }
            const isRateLimited = err.statusCode === 429 || /\b429\b|quota|rate[- ]?limit/i.test(msg);
            if (isRateLimited) {
              const isDailyQuota = /free_tier|PerDay|limit:\s*0\b|daily/i.test(msg);
              markGeminiKeyRateLimited(candidateKey, isDailyQuota ? 30 * 60 * 1000 : 45 * 1000, scope);
              break;
            }
            const isModelIssue =
              isTimeout ||
              err.isEmptyModelResponse ||
              err.statusCode === 404 ||
              err.statusCode === 503 ||
              /no longer available|not found|not supported|deprecated|high demand|overloaded|unavailable/i.test(msg);
            if (isModelIssue) {
              // Model itself is slow/overloaded/404/safety-blocked -> skip retrying across 5 accounts and advance to next model!
              blockedModelsUntil.set(modelName, Date.now() + (err.statusCode === 404 ? 10 * 60 * 1000 : 90 * 1000));
              switchModelImmediately = true;
              break;
            }
            if (isSocketBlip) {
              break;
            }
            throw err;
          }
        }
      } finally {
        if (!succeeded) {
          stream.end(false, lastError && lastError.statusCode);
        }
      }
      if (switchModelImmediately) {
        break;
      }
    }
  }
  throw lastError || new Error('Gemini API request failed.');
}

function googleTranslateText(text, sl = 'auto', tl = 'km') {
  return new Promise((resolve, reject) => {
    const cleanSl = sl && sl !== 'auto' ? sl : 'auto';
    const cleanTl = tl === 'zh-km' || tl === 'en-km' ? 'km' : (tl === 'zh' ? 'zh-CN' : tl);
    const query = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(cleanSl)}&tl=${encodeURIComponent(cleanTl)}&dt=t&q=${query}`;
    const req = https.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Google Translate HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const sentences = Array.isArray(parsed && parsed[0]) ? parsed[0] : [];
          const translated = sentences.map(s => (Array.isArray(s) && s[0]) ? String(s[0]) : '').join('').trim();
          if (!translated) return reject(new Error('Empty Google Translate response'));
          if (tl === 'zh-km' || tl === 'en-km') {
            return resolve(`${text.trim()} | ${translated}`);
          }
          resolve(translated);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Google Translate timeout')));
    req.on('error', reject);
  });
}

async function mapWithConcurrency(items, concurrency, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  const workers = Math.min(Math.max(1, Number(concurrency) || 1), list.length || 1);
  let cursor = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < list.length) {
      const idx = cursor++;
      results[idx] = await fn(list[idx], idx);
    }
  }));
  return results;
}

async function translateWithGoogleFallbackSafe(text, sourceLang = 'auto', targetLang = 'km', retries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await googleTranslateText(text, sourceLang, targetLang);
      if (raw && String(raw).trim()) {
        return String(raw).trim();
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) {
      await new Promise(resolve => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
  if (lastErr) {
    console.warn('[translation] Google Translate fallback failed:', lastErr.message);
  }
  return '';
}

function secondsToSrtTime(seconds) {
  const totalMilliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const wholeSeconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

function secondsToDisplayTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds % 60).toFixed(1);
  return `${minutes}:${remainder.padStart(4, '0')}`;
}

function extractSpeechAudio(videoPath, outputPath, options = {}) {
  const { startSec = null, durationSec = null, isolateVocals = true } = options;
  return new Promise((resolve, reject) => {
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
    if (Number.isFinite(startSec) && startSec > 0) {
      args.push('-ss', String(startSec));
    }
    args.push('-i', videoPath);
    if (Number.isFinite(durationSec) && durationSec > 0) {
      args.push('-t', String(durationSec));
    }
    args.push('-vn');
    if (isolateVocals) {
      args.push('-af', SPEECH_VOCAL_FILTER);
    }
    args.push('-ac', '1', '-ar', '16000', '-b:a', '64k', '-f', 'mp3', '-y', outputPath);

    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });

    let stderr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', chunk => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    proc.once('error', reject);
    proc.once('close', code => {
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}.`));
    });
  });
}

function probeVideoDurationSec(videoPath) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_BIN, ['-nostdin', '-hide_banner', '-i', videoPath], { windowsHide: true });
    let stderr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', d => { stderr += d; });
    proc.once('error', () => resolve(0));
    proc.once('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return resolve(0);
      resolve(parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]));
    });
  });
}

async function extractSpeechAudioChunks(videoPath, tempDirectory, options = {}) {
  const {
    chunkDurationSec = DEFAULT_SPEECH_CHUNK_SEC,
    isolateVocals = true
  } = options;
  const safeChunkSec = Math.max(30, Math.min(600, Number(chunkDurationSec) || DEFAULT_SPEECH_CHUNK_SEC));
  const totalDur = await probeVideoDurationSec(videoPath);

  if (totalDur <= safeChunkSec) {
    const singlePath = path.join(tempDirectory, 'speech_0.mp3');
    await extractSpeechAudio(videoPath, singlePath, { isolateVocals });
    return [{ index: 0, offsetSec: 0, audioPath: singlePath }];
  }

  const jobs = [];
  let idx = 0;
  for (let offset = 0; offset < totalDur - 0.1; offset += safeChunkSec) {
    jobs.push({
      idx,
      offsetSec: offset,
      durationSec: Math.min(safeChunkSec, totalDur - offset),
      chunkPath: path.join(tempDirectory, `speech_${idx}.mp3`)
    });
    idx++;
  }

  const chunkResults = new Array(jobs.length).fill(null);
  let jobCursor = 0;
  const extractWorkers = Math.min(4, jobs.length || 1);
  await Promise.all(Array.from({ length: extractWorkers }, async () => {
    while (jobCursor < jobs.length) {
      const job = jobs[jobCursor++];
      await extractSpeechAudio(videoPath, job.chunkPath, {
        startSec: job.offsetSec,
        durationSec: job.durationSec,
        isolateVocals
      });
      if (fs.existsSync(job.chunkPath) && fs.statSync(job.chunkPath).size > 0) {
        chunkResults[job.idx] = { index: job.idx, offsetSec: job.offsetSec, audioPath: job.chunkPath };
      }
    }
  }));
  return chunkResults.filter(Boolean);
}

function decodeUnicodeEscapes(value) {
  return String(value || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function decodeJsonStringFragment(raw) {
  const src = String(raw || '');
  let out = src;
  try {
    out = JSON.parse(`"${src}"`);
  } catch (_) {
    out = src
      .replace(/\\"/g, '"')
      .replace(/\\n/g, ' ')
      .replace(/\\t/g, ' ')
      .replace(/\\\\/g, '\\');
  }
  return decodeUnicodeEscapes(out);
}

function stripTrailingCommasOutsideStrings(jsonText) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (inStr) {
      out += ch;
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < jsonText.length && /\s/.test(jsonText[j])) j++;
      if (j < jsonText.length && (jsonText[j] === '}' || jsonText[j] === ']')) {
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function recoverCompleteArrayItems(cleaned) {
  const arrIdx = cleaned.indexOf('[');
  if (arrIdx < 0) return [];
  const objects = [];
  let inStr = false;
  let esc = false;
  let depth = 0;
  let objStart = -1;
  for (let i = arrIdx + 1; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && objStart >= 0) {
        const frag = cleaned.slice(objStart, i + 1);
        try {
          objects.push(JSON.parse(stripTrailingCommasOutsideStrings(frag)));
        } catch (_) {}
        objStart = -1;
      }
    }
  }
  return objects;
}

function parseJsonObject(response, label) {
  const cleaned = String(response || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // 1. Direct JSON object parse (with trailing-comma tolerance)
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const objSlice = cleaned.slice(start, end + 1);
    for (const candidate of [objSlice, stripTrailingCommasOutsideStrings(objSlice)]) {
      try {
        return JSON.parse(candidate);
      } catch (_) {}
    }
  }

  // 2. Top-level JSON array parse -> wrap for translations, frames, and segments
  const arrStart = cleaned.indexOf('[');
  const arrEnd = cleaned.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    const arrSlice = cleaned.slice(arrStart, arrEnd + 1);
    for (const candidate of [arrSlice, stripTrailingCommasOutsideStrings(arrSlice)]) {
      try {
        const parsedArr = JSON.parse(candidate);
        if (Array.isArray(parsedArr)) {
          return {
            translations: parsedArr,
            frames: parsedArr,
            segments: parsedArr,
            terms: [],
            relationships: []
          };
        }
      } catch (_) {}
    }
  }

  // 2.5 Balanced object recovery inside truncated arrays (independent of field key order)
  const balancedObjects = recoverCompleteArrayItems(cleaned);
  if (balancedObjects.length > 0) {
    const trItems = balancedObjects.filter(o => o && o.id !== undefined && typeof o.translation === 'string');
    if (trItems.length > 0) {
      return { translations: trItems, fixes: trItems, terms: [], relationships: [] };
    }
    const segItems = balancedObjects.filter(o =>
      o && Number.isFinite(Number(o.startSec)) && Number.isFinite(Number(o.endSec)) && typeof o.text === 'string'
    );
    if (segItems.length > 0) {
      return { segments: segItems };
    }
    const frameItems = balancedObjects.filter(o => o && o.frame !== undefined && typeof o.text === 'string');
    if (frameItems.length > 0) {
      return { frames: frameItems };
    }
  }

  // 3. Regex recovery for translation items {"id": N, "translation": "...", "voice": "..."}
  const recovered = [];
  const itemRegex = /"id"\s*:\s*(\d+)\s*,\s*"translation"\s*:\s*"((?:\\.|[^"\\])*)"(?:\s*,\s*"voice"\s*:\s*"([^"]*)")?/g;
  let match;
  while ((match = itemRegex.exec(cleaned)) !== null) {
    recovered.push({
      id: Number(match[1]),
      translation: decodeJsonStringFragment(match[2]),
      voice: match[3] || ''
    });
  }
  if (recovered.length > 0) {
    return { translations: recovered, terms: [], relationships: [] };
  }

  // 4. Regex recovery for speech segments {"startSec": N, "endSec": N, "text": "...", "voice": "..."}
  const recoveredSegments = [];
  const segRegex = /"startSec"\s*:\s*([0-9.]+)\s*,\s*"endSec"\s*:\s*([0-9.]+)\s*,\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"(?:\s*,\s*"voice"\s*:\s*"([^"]*)")?/g;
  let segMatch;
  while ((segMatch = segRegex.exec(cleaned)) !== null) {
    recoveredSegments.push({
      startSec: Number(segMatch[1]),
      endSec: Number(segMatch[2]),
      text: decodeJsonStringFragment(segMatch[3]),
      voice: segMatch[4] || ''
    });
  }
  if (recoveredSegments.length > 0) {
    return { segments: recoveredSegments };
  }

  // 5. Regex recovery for OCR frames {"frame": N, "text": "..."}
  const recoveredFrames = [];
  const frameRegex = /"frame"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let frameMatch;
  while ((frameMatch = frameRegex.exec(cleaned)) !== null) {
    recoveredFrames.push({
      frame: Number(frameMatch[1]),
      text: decodeJsonStringFragment(frameMatch[2])
    });
  }
  if (recoveredFrames.length > 0) {
    return { frames: recoveredFrames };
  }

  throw new Error(`Gemini returned invalid ${label} JSON.`);
}

function validateCueList(cues) {
  if (!Array.isArray(cues) || cues.length === 0 || cues.length > MAX_CUES) {
    return `សូមផ្ទុក subtitle ចន្លោះពី 1 ដល់ ${MAX_CUES} បន្ទាត់។`;
  }
  let totalLength = 0;
  for (const cue of cues) {
    if (!cue || typeof cue.text !== 'string' || cue.text.length > MAX_CUE_TEXT_LENGTH) {
      return 'ទិន្នន័យ subtitle មិនត្រឹមត្រូវ ឬអត្ថបទមួយបន្ទាត់វែងពេក។';
    }
    totalLength += cue.text.length;
  }
  if (totalLength > MAX_TOTAL_TEXT_LENGTH) {
    return 'អត្ថបទ subtitle សរុបវែងពេកសម្រាប់ដំណើរការមួយលើក។';
  }
  return null;
}

function getSourceLanguage(sourceLang = 'auto') {
  return SOURCE_LANGUAGE_SPECS[sourceLang] || null;
}

function getTargetLanguage(targetLang) {
  const languages = {
    km: 'natural, conversational Khmer suitable for Cambodian TV drama dubbing',
    en: 'natural, conversational English suitable for TV drama dubbing',
    th: 'natural, conversational Thai suitable for Thai drama dubbing',
    vi: 'natural, conversational Vietnamese suitable for Vietnamese drama dubbing',
    zh: 'natural, conversational Simplified Chinese suitable for drama dubbing',
    ko: 'natural, conversational Korean suitable for K-drama dubbing',
    ja: 'natural, conversational Japanese suitable for anime and drama dubbing',
    'zh-km': 'bilingual Chinese and Khmer, preserving the Chinese dialogue and adding the Khmer translation separated by " | "',
    'en-km': 'bilingual English and Khmer, preserving the source dialogue and adding the Khmer translation separated by " | "'
  };
  return languages[targetLang];
}

function normalizeKhmerSpacing(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!/[\u1780-\u17FF]/.test(s)) return s;
  // Remove artificial spaces before bound Khmer suffixes/particles/demonstratives
  const boundSuffixes = 'ពេក|ណាស់|ទេ|ហើយ|ដែរ|ផង|សោះ|ឡើយ|វិញ|នេះ|នោះ|ទៀត|អី|ហ្នឹង|មែនទេ|ទេអ្ហី|អ្ហ៎|ណា៎|ចុះ|ផងដែរ|ទាំងអស់|ប៉ុណ្ណោះ|ឯង';
  const suffixRe = new RegExp(`([\\u1780-\\u17FF])\\s+(${boundSuffixes})(?=[\\s។!?៖,，。！？]|$)`, 'g');
  s = s.replace(suffixRe, '$1$2');
  s = s.replace(suffixRe, '$1$2');

  // Remove artificial spaces after short bound Khmer prepositions/copulas/negations when joining two Khmer words
  const boundPrefixes = 'របស់|នៃ|ជា|គឺ|គឺជា|នៅ|ក្នុង|លើ|ក្រោម|ពី|ដោយ|សម្រាប់|ចំពោះ|មិន|អត់|កុំ|បាន|នឹង|កំពុង|ដ៏|ឲ្យ|ឱ្យ|អោយ|ថា';
  const prefixRe = new RegExp(`(^|[\\s\\u17D4-\\u17DA])(${boundPrefixes})\\s+([\\u1780-\\u17FF])`, 'g');
  s = s.replace(prefixRe, '$1$2$3');
  s = s.replace(prefixRe, '$1$2$3');

  // Remove spaces before Khmer punctuation
  s = s.replace(/\s+([។!?៖])/g, '$1');
  return s.replace(/\s{2,}/g, ' ').trim();
}

const ALLOWED_SHORT_ASCII_IN_KHMER = new Set([
  'ok', 'km', 'cm', 'mm', 'kg', 'mg', 'ml', 'hr', 'vs', 'id', 'tv', 'pc', 'ai', 'dr', 'mr', 'ms', 'am', 'pm', 'no', 'dj'
]);

const CJK_FOREIGN_SCRIPT_RE = /[\u2E80-\u2FDF\u3040-\u30FF\u3100-\u312F\u31A0-\u31EF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u;
const CJK_FOREIGN_SCRIPT_GLOBAL_RE = /[\u2E80-\u2FDF\u3040-\u30FF\u3100-\u312F\u31A0-\u31EF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\u{20000}-\u{2FA1F}]+/gu;
const CJK_FULLWIDTH_PUNCT_RE = /[\u3000-\u303F\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFEF]/;

function normalizeCjkPunctuationToKhmer(text) {
  return String(text || '')
    .replace(/\u3000+/g, ' ')
    .replace(/。+/g, '។')
    .replace(/[，、]/g, ', ')
    .replace(/？/g, '?')
    .replace(/！/g, '!')
    .replace(/：/g, ': ')
    .replace(/；/g, '; ')
    .replace(/[（【]/g, '(')
    .replace(/[）】]/g, ')')
    .replace(/[「『《]/g, '«')
    .replace(/[」』》]/g, '»')
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

/** Detects foreign script leaks, CJK punctuation, mixed Latin fragments, or impossible Khmer vowel/diacritic sequences. */
function hasCorruptedKhmerText(text) {
  const tr = String(text || '').trim();
  if (!tr) return false;
  if (CJK_FOREIGN_SCRIPT_RE.test(tr) || CJK_FULLWIDTH_PUNCT_RE.test(tr)) {
    return true;
  }
  if (/[\u0E00-\u109F\u0400-\u052F\u0590-\u06FF\u0900-\u0DFF]/.test(tr)) {
    return true;
  }
  if (/[\u00C0-\u024F\u1E00-\u1EFF]/.test(tr)) {
    return true;
  }
  if (/[\u1780-\u17FF][a-z]{1,8}|(?:^|[\s\u1780-\u17FF])[a-z]{1,4}[\u1780-\u17FF]/.test(tr)) {
    return true;
  }
  const strayTokenMatches = tr.matchAll(/[\u1780-\u17FF]\s+([a-z]{1,3})(?=\s+[\u1780-\u17FF]|\s*[។!?៖,.]|$)/g);
  for (const m of strayTokenMatches) {
    if (!ALLOWED_SHORT_ASCII_IN_KHMER.has(m[1])) {
      return true;
    }
  }
  if (/(?!\u17BB[\u17B7-\u17BA])[\u17B6-\u17C5][\u17B6-\u17C5]/.test(tr)) return true;
  if (/[\u17C6\u17C7\u17CB\u17CC\u17CD\u17CF\u17D0][\u17B6-\u17C5]/.test(tr)) return true;
  if (/([\u17C6-\u17D1])\1/.test(tr)) return true;
  if (/\u17D2(?:\u17D2|[\u17B6-\u17D1]|\s|$)/.test(tr)) return true;
  if (/(?:^|[\s។!?៖,.\-"'()…])[\u17B6-\u17D1]/.test(tr)) return true;
  return false;
}

function cleanTranslatedText(text, targetLang) {
  let out = String(text || '').trim();
  if (targetLang === 'km') {
    if (/[\u1780-\u17FF]/.test(out)) {
      out = normalizeCjkPunctuationToKhmer(out)
        .replace(/\u200B+/g, '')
        .replace(/[\u0E00-\u109F]+/g, ' ')
        .replace(CJK_FOREIGN_SCRIPT_GLOBAL_RE, ' ')
        .replace(/[\u0400-\u052F\u0590-\u06FF\u0900-\u0DFF]+/g, ' ')
        .replace(/[\u00C0-\u024F\u1E00-\u1EFF]+/g, ' ')
        .replace(new RegExp(CJK_FULLWIDTH_PUNCT_RE.source, 'g'), ' ');
    }
    out = normalizeKhmerChuonNath(out);
    out = normalizeKhmerSpacing(out);
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

function isTranslationIncomplete(translatedText, sourceText, targetLang) {
  const tr = String(translatedText || '').trim();
  const src = String(sourceText || '').trim();
  if (!tr) return true;
  if (targetLang === 'km') {
    const hasKhmer = /[\u1780-\u17FF]/.test(tr);
    if (hasCorruptedKhmerText(tr)) return true;
    if (!hasKhmer && (CJK_FOREIGN_SCRIPT_RE.test(src) || CJK_FULLWIDTH_PUNCT_RE.test(src) || /[A-Za-z\u0E00-\u0E7F]/.test(src))) return true;
    if (tr === src && src.length > 0 && !/^[\d\s.,!?\-'"()…]+$/.test(src)) return true;
  } else if (tr === src && src.length > 1) {
    return true;
  }
  return false;
}

const VALID_VOICE_PRESETS = new Set([
  'Sovereign King',
  'Radiant Queen',
  'kh_narrator_fast',
  'kh_young_man',
  'kh_deep_boss',
  'kh_young_girl',
  'kh_child',
  'kh_elder_woman'
]);

function normalizeSuggestedVoice(rawVoice) {
  const v = String(rawVoice || '').trim();
  if (!v) return '';
  if (VALID_VOICE_PRESETS.has(v)) return v;
  if (voiceCloner.isCustomCloneVoiceId(v)) return v;
  const low = v.toLowerCase();
  if (low.includes('young_girl') || low.includes('girl') || low.includes('sister') || low.includes('daughter')) return 'kh_young_girl';
  if (low.includes('elder_woman') || low.includes('mother') || low.includes('grandmother') || low.includes('matriarch') || low.includes('old_woman')) return 'kh_elder_woman';
  if (low.includes('queen') || low.includes('sreymom') || low.includes('female') || low.includes('woman') || low.includes('wife') || low.includes('lady')) return 'Radiant Queen';
  if (low.includes('child') || low.includes('kid')) return 'kh_child';
  if (low.includes('deep') || low.includes('boss') || low.includes('president') || low.includes('ceo') || low.includes('father') || low.includes('grandfather') || low.includes('elder_man')) return 'kh_deep_boss';
  if (low.includes('young_man') || low.includes('boy') || low.includes('assistant')) return 'kh_young_man';
  if (low.includes('narrator')) return 'kh_narrator_fast';
  if (low.includes('king') || low.includes('piseth') || low.includes('male') || low.includes('man') || low.includes('husband')) return 'Sovereign King';
  return '';
}

function normalizeSuggestedEmotion() {
  return '';
}

function inferEmotionForCue() {
  return '';
}

/**
 * Detect whether two consecutive cues are spoken by the SAME character continuing their thought,
 * rather than a turn switch to the other speaker.
 */
function isContinuousSameSpeaker(cues, prevIdx, currIdx) {
  if (prevIdx < 0 || currIdx >= cues.length || currIdx !== prevIdx + 1) return false;
  const prev = cues[prevIdx] || {};
  const curr = cues[currIdx] || {};
  const prevText = `${prev.text || ''} ${prev.translated || ''}`.trim();
  const currText = `${curr.text || ''} ${curr.translated || ''}`.trim();
  if (!prevText || !currText) return false;

  // If curr explicitly refutes prev's accusation (e.g., prev="你故意的！" -> curr/next="那不过是一块表... 与其质问我是不是故意的"), speaker switched!
  const nextCue = cues[currIdx + 1] || {};
  const currAndNext = `${currText} ${nextCue.text || ''} ${nextCue.translated || ''}`;
  if (/故意的|ដោយចេតនា/.test(prevText) && prevText.length <= 35 && /与其质问|ជាជាងសួរខ្ញុំ|不过是一块|គ្រាន់តែជា/.test(currAndNext)) {
    return false;
  }

  // If prev ends with a direct question mark, the next line is normally the other person answering
  const prevAsksQuestion = /[?？]\s*$/.test(prev.text || '') || /[?？]\s*$/.test(prev.translated || '') ||
    /(?:មែនទេ|ទេអ្ហី|ឬទេ|អ្ហ៎|吗|呢)\s*[?？!！。.]*$/.test(prevText);
  if (prevAsksQuestion) {
    return false;
  }

  const prevEnd = Number(prev.endSec) || 0;
  const currStart = Number(curr.startSec) || 0;
  const gap = currStart - prevEnd;

  // Continuation conjunction at start of curr
  const startsWithContinuation = /^(?:ប៉ុន្តែ|ព្រោះ|ប្រសិនបើ|បើសិន|ម្យ៉ាងទៀត|ហើយ|ដូច្នេះ|ជាងនេះ|ជាជាងសួរ|កុំថាឡើយ|ណាមួយ|ទោះបី|与其|不过|如果|因为|所以|而且|更何况|不仅|况且|只要|哪怕|就算)/.test(curr.text || '') ||
    /^(?:ប៉ុន្តែ|ព្រោះ|ប្រសិនបើ|បើសិន|ម្យ៉ាងទៀត|ហើយ|ដូច្នេះ|ជាងនេះ|ជាជាងសួរ|កុំថាឡើយ|ណាមួយ|ទោះបី)/.test(curr.translated || '');
  if (startsWithContinuation && gap <= 1.2) {
    return true;
  }

  // Prev ends with comma or unfinished clause
  if (/[,，、；…—]\s*$/.test(prev.text || '') && gap <= 1.0) {
    return true;
  }

  // Very tight gap (<= 0.16s) after a non-question statement longer than a short interjection
  if (gap >= -0.05 && gap <= 0.16 && prevText.length >= 10) {
    return true;
  }

  // Mid-sentence split (trailing comma/ellipsis/dash) across pause up to 0.42s keeps same speaker
  if (gap > 0.16 && gap <= 0.42 && prevText.length >= 4 && /[,，、…\-—]$/.test(prevText)) {
    return true;
  }

  return false;
}

/**
 * Automatically infer and assign distinct male/female/character voices across dialogue cues
 * based on AI voice suggestions, speaker self-references, forms of address, and turn-taking.
 */
function normalizeCastMode(mode) {
  const s = String(mode || '').trim().toLowerCase();
  if (s === 'single') return 'single';
  if (s === 'multi') return 'multi';
  return 'duo';
}

function isFemaleVoicePreset(voice) {
  const v = String(voice || '').trim();
  if (voiceCloner.isCustomCloneVoiceId(v)) {
    const profile = voiceCloner.getClonedVoiceById(v);
    if (profile) return profile.baseGender === 'Female';
  }
  return v === 'Radiant Queen' ||
    v === 'kh_young_girl' ||
    v === 'kh_elder_woman' ||
    v === 'kh_child' ||
    v.includes('Sreymom') ||
    v.includes('Female');
}

function isAllowedVoicePreset(v) {
  return VALID_VOICE_PRESETS.has(v) || voiceCloner.isCustomCloneVoiceId(v);
}

function collapseVoiceForCastMode(voice, castMode = 'duo', fixedVoice = '') {
  const mode = normalizeCastMode(castMode);
  const norm = normalizeSuggestedVoice(voice) || String(voice || '').trim() || 'Sovereign King';
  if (mode === 'single') {
    const chosen = normalizeSuggestedVoice(fixedVoice) || String(fixedVoice || '').trim();
    if (chosen && isAllowedVoicePreset(chosen)) return chosen;
    return isAllowedVoicePreset(norm) ? norm : 'Sovereign King';
  }
  if (mode === 'duo') {
    return isFemaleVoicePreset(norm) ? 'Radiant Queen' : 'Sovereign King';
  }
  return isAllowedVoicePreset(norm) ? norm : 'Sovereign King';
}

function normalizeCueVoicesForCastMode(cues, castMode = 'duo', fixedVoice = '') {
  if (!Array.isArray(cues)) return cues;
  const mode = normalizeCastMode(castMode);
  const lockedSingle = mode === 'single'
    ? collapseVoiceForCastMode(fixedVoice || (cues[0] && cues[0].voice), 'single', fixedVoice)
    : '';
  for (let i = 0; i < cues.length; i++) {
    if (!cues[i]) continue;
    if (mode === 'single') {
      cues[i].voice = lockedSingle;
      cues[i].suggestedVoice = lockedSingle;
      continue;
    }
    cues[i].voice = collapseVoiceForCastMode(cues[i].voice, mode);
    if (cues[i].suggestedVoice) {
      cues[i].suggestedVoice = collapseVoiceForCastMode(cues[i].suggestedVoice, mode);
    }
  }
  return cues;
}

const MULTI_CAST_VOICE_RULES = `Available character voice IDs (STRICT DISCIPLINE — keep total cast compact, MAX 2 voices per gender, NEVER split ONE character across multiple IDs):
- "Radiant Queen": DEFAULT Female Lead / Adult Woman / Wife (USE THIS CONSISTENTLY for the female protagonist across ALL her lines)
- "Sovereign King": DEFAULT Male Lead / Adult Man / Husband / CEO (USE THIS CONSISTENTLY for the male protagonist across ALL his lines)
- "kh_elder_woman": ONLY for an actual older Mother / Grandmother / Mother-in-law speaking as an elder
- "kh_deep_boss": ONLY for an actual older Father / Grandfather / Patriarch clearly separate from the Male Lead
- "kh_young_girl": ONLY for a clearly distinct 2nd young woman / younger sister / maid (NEVER for the main Female Lead!)
- "kh_young_man": ONLY for a clearly distinct 2nd male assistant / brother / rival (NEVER for the main Male Lead!)
- "kh_child": ONLY for a small child`;

function buildEstablishedCastRoster(segments = []) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  const byVoice = new Map();
  for (const seg of segments) {
    const v = normalizeSuggestedVoice(seg && seg.suggestedVoice);
    const txt = String((seg && seg.text) || '').replace(/\s+/g, ' ').trim();
    if (!v || !txt) continue;
    if (!byVoice.has(v)) byVoice.set(v, []);
    const examples = byVoice.get(v);
    if (examples.length < 2) examples.push(`"${txt.slice(0, 32)}"`);
  }
  if (byVoice.size === 0) return '';
  const lines = Array.from(byVoice.entries()).map(([v, ex]) => `- "${v}" (heard on: ${ex.join(', ')})`);
  return `CAST CONTINUITY LOCK FROM PART 1 (CRITICAL):\nPart 1 already assigned these exact character voice IDs:\n${lines.join('\n')}\nYou MUST reuse ONLY these exact voice IDs for the same returning characters. Do NOT split any character onto a new voice ID (e.g. do not mix Sovereign King / kh_young_man / kh_deep_boss or Radiant Queen / kh_young_girl / kh_elder_woman for the same actor). Only introduce another ID if an unmistakably new speaker joins.`;
}
router.buildEstablishedCastRoster = buildEstablishedCastRoster;

/** Extracts sample dialogue from Part 1 so later 60s chunks preserve consistent names and script style. */
function buildTranscriptContinuityContext(segments = [], srcSpec = null) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  const sampleLines = segments
    .map(seg => String((seg && seg.text) || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 30);
  if (sampleLines.length === 0) return '';
  const scriptRule = srcSpec && srcSpec.name === 'Chinese'
    ? 'Keep Simplified Chinese characters (简体中文) strictly — do NOT switch to Traditional Chinese.'
    : 'Keep the exact same language script and orthography used in Part 1.';
  return `PART 1 DIALOGUE & PROPER-NOUN CONTINUITY (CRITICAL):\n${scriptRule} Keep character names, titles, and recurring terms spelling-identical to Part 1:\n${sampleLines.map(line => `- ${line}`).join('\n')}`;
}
router.buildTranscriptContinuityContext = buildTranscriptContinuityContext;

function buildAudioCastPrompt(chunkEntries, castMode = 'duo', contextLines = []) {
  const mode = normalizeCastMode(castMode);
  const voiceRules = mode === 'duo'
    ? `ONLY TWO VOICES EXIST IN THIS SCENE. You MUST pick ONLY from these 2 exact IDs:
- "Radiant Queen" (Female / Woman speaker — lighter, higher vocal pitch/timbre)
- "Sovereign King" (Male / Man speaker — deeper, lower male vocal pitch/timbre)
STRICT 2-CHARACTER LOCK: NEVER output any other voice ID (never use kh_young_girl, kh_young_man, kh_elder_woman, kh_deep_boss, or kh_child).
CRITICAL RULES FOR AUDIO DIARIZATION:
1. LISTEN TO THE ACTUAL HUMAN VOICE TIMBRE in the attached MP3 audio at each [start - end] window — DO NOT guess blindly from text!
2. EMOTION DOES NOT CHANGE SPEAKER IDENTITY: If the woman screams, whispers, cries, or gets angry, her voice is STILL female ("Radiant Queen"). If the man yells, pleads, or speaks softly, he is STILL male ("Sovereign King").
3. Keep consecutive lines from the same voice on the exact same voice ID.`
    : `${MULTI_CAST_VOICE_RULES}
CRITICAL RULES FOR AUDIO DIARIZATION:
1. Match each line primarily by listening to the ACTUAL human voice timbre at each [start - end] window in the audio.
2. NEVER change a character's voice ID just because their emotion changes (e.g. angry, crying, whispering). One character = ONE permanent voice ID across the entire video.
3. Most short dramas have ONLY 2-4 speaking characters total. When in doubt between two male voices or two female voices, keep the speaker on "Sovereign King" or "Radiant Queen".`;

  const timelineText = chunkEntries.map(entry => {
    const src = String(entry.cue.text || '').replace(/\s+/g, ' ').trim();
    const tr = String(entry.cue.translated || '').replace(/\s+/g, ' ').trim();
    const textPart = tr && tr !== src ? `"${src}" -> "${tr}"` : `"${src || tr}"`;
    return `${entry.id}. [${entry.relStart.toFixed(1)}s - ${entry.relEnd.toFixed(1)}s] ${textPart}`;
  }).join('\n');

  const contextBlock = contextLines.length > 0
    ? `\nSpeaker continuity from immediately preceding lines (keep same real voices consistent):\n${contextLines.join('\n')}\n`
    : '';

  return `You are a professional film audio diarizer & voice casting director.
Listen carefully to the attached vocal audio segment (timestamps start at 0.0s for this clip).
For every numbered cue below, identify the ACTUAL human speaker heard inside its [start - end] timestamp window so vocal identity stays steady across lines.

${voiceRules}
${contextBlock}
Subtitles to match against the audio:
${timelineText}

Return ONLY valid JSON with EVERY cue id listed above:
{"casting":[{"id":1,"voice":"Radiant Queen"}]}`;
}

async function castVoicesWithAudioChunks(cues, videoPath, apiKey, castMode = 'duo', aiVoiceMap = new Map(), aiEmotionMap = new Map()) {
  if (!videoPath || typeof videoPath !== 'string' || !videoPath.trim() || !apiKey || !Array.isArray(cues) || cues.length === 0) {
    return { usedAudio: false, assignedCount: 0 };
  }
  const normalizedVideoPath = path.normalize(videoPath.trim());
  try {
    const stats = fs.statSync(normalizedVideoPath);
    if (!stats.isFile()) return { usedAudio: false, assignedCount: 0 };
  } catch (_) {
    return { usedAudio: false, assignedCount: 0 };
  }

  const effectiveCastMode = normalizeCastMode(castMode);
  if (effectiveCastMode === 'single') {
    return { usedAudio: false, assignedCount: 0 };
  }
  let tempDirectory = '';
  let assignedCount = 0;

  try {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-cast-'));
    const chunks = await extractSpeechAudioChunks(normalizedVideoPath, tempDirectory, {
      chunkDurationSec: 60,
      isolateVocals: true
    });
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return { usedAudio: false, assignedCount: 0 };
    }

    for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
      const chunk = chunks[cIdx];
      const chunkStart = Number(chunk.offsetSec) || 0;
      const nextOffset = (chunks[cIdx + 1] && Number(chunks[cIdx + 1].offsetSec)) || Infinity;

      const chunkEntries = [];
      for (let i = 0; i < cues.length; i++) {
        const s = Number(cues[i].startSec) || 0;
        const e = Number(cues[i].endSec) || (s + 1);
        const mid = (s + e) / 2;
        if (mid >= chunkStart - 0.35 && mid < nextOffset - 0.35) {
          chunkEntries.push({
            id: i + 1,
            cue: cues[i],
            relStart: Math.max(0, s - chunkStart),
            relEnd: Math.max(0.1, e - chunkStart)
          });
        }
      }
      if (chunkEntries.length === 0) continue;

      let audioBuf;
      try {
        audioBuf = fs.readFileSync(chunk.audioPath);
      } catch (_) {
        continue;
      }
      if (!audioBuf || audioBuf.length === 0 || audioBuf.length > MAX_SPEECH_AUDIO_BYTES) continue;

      const audioBase64 = audioBuf.toString('base64');
      for (let offset = 0; offset < chunkEntries.length; offset += 45) {
        const batch = chunkEntries.slice(offset, offset + 45);
        const contextLines = [];
        const firstId = batch[0].id;
        for (let prevId = Math.max(1, firstId - 3); prevId < firstId; prevId++) {
          const prevVoice = aiVoiceMap.get(prevId);
          if (prevVoice) {
            const snippet = String((cues[prevId - 1] && cues[prevId - 1].text) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
            contextLines.push(`- Line ${prevId} ("${snippet}") => ${prevVoice}`);
          }
        }
        try {
          const prompt = buildAudioCastPrompt(batch, effectiveCastMode, contextLines);
          const raw = await callGeminiApi(prompt, apiKey, [{
            inline_data: {
              mime_type: 'audio/mp3',
              data: audioBase64
            }
          }], 35000);
          const parsed = parseJsonObject(raw, 'audio voice casting');
          const items = Array.isArray(parsed.casting)
            ? parsed.casting
            : (Array.isArray(parsed.translations) ? parsed.translations : []);
          for (const item of items) {
            const id = Number(item && item.id);
            if (!id || id < 1 || id > cues.length) continue;
            const rawVoice = normalizeSuggestedVoice(item.voice);
            if (!rawVoice) continue;
            const finalVoice = collapseVoiceForCastMode(rawVoice, effectiveCastMode);
            aiVoiceMap.set(id, finalVoice);
            assignedCount++;
          }
        } catch (err) {
          console.warn('[translation/audio-cast] chunk batch fallback:', err.message);
        }
      }
    }
    return { usedAudio: assignedCount > 0, assignedCount };
  } catch (err) {
    console.warn('[translation/audio-cast] extraction fallback:', err.message);
    return { usedAudio: false, assignedCount: 0 };
  } finally {
    if (tempDirectory) {
      try {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
      } catch (_) {}
    }
  }
}

function resolveSafeTextCastVoice(existingAudioVoice, textCandidateVoice, castMode = 'multi') {
  const existingAudio = normalizeSuggestedVoice(existingAudioVoice);
  const candidate = normalizeSuggestedVoice(textCandidateVoice);
  const normalizedMode = normalizeCastMode(castMode);
  if (!candidate) return existingAudio ? collapseVoiceForCastMode(existingAudio, normalizedMode) : '';
  // Never let text-only LLM guessing flip the gender of an audio-detected suggestedVoice
  const safeV = (existingAudio && isFemaleVoicePreset(existingAudio) !== isFemaleVoicePreset(candidate))
    ? existingAudio
    : candidate;
  return collapseVoiceForCastMode(safeV, normalizedMode);
}
router.resolveSafeTextCastVoice = resolveSafeTextCastVoice;

function consolidateCharacterVoicesForCues(cues, resolved, lockedLexical = []) {
  if (!Array.isArray(cues) || cues.length < 4 || !Array.isArray(resolved) || resolved.length !== cues.length) {
    return resolved;
  }

  // Pass A: Same continuous sentence / comma split within the same gender must keep exact same preset ID
  for (let i = 1; i < cues.length; i++) {
    if (
      !lockedLexical[i] &&
      resolved[i - 1] &&
      resolved[i] &&
      resolved[i] !== resolved[i - 1] &&
      isFemaleVoicePreset(resolved[i - 1]) === isFemaleVoicePreset(resolved[i]) &&
      isContinuousSameSpeaker(cues, i - 1, i)
    ) {
      resolved[i] = resolved[i - 1];
    }
  }

  // Pass B: Cap active cast at max 2 distinct voices per gender and collapse stray 1-line un-locked outliers
  for (const isFem of [false, true]) {
    const leadVoice = isFem ? 'Radiant Queen' : 'Sovereign King';
    const statsMap = new Map();
    for (let i = 0; i < resolved.length; i++) {
      const v = resolved[i];
      if (!v || isFemaleVoicePreset(v) !== isFem) continue;
      if (!statsMap.has(v)) statsMap.set(v, { voice: v, count: 0, lockedCount: 0 });
      const entry = statsMap.get(v);
      entry.count++;
      if (lockedLexical[i]) entry.lockedCount++;
    }
    if (statsMap.size <= 1) continue;

    const ranked = Array.from(statsMap.values()).sort((a, b) => {
      const aLock = a.lockedCount > 0 ? 1 : 0;
      const bLock = b.lockedCount > 0 ? 1 : 0;
      if (bLock !== aLock) return bLock - aLock;
      if (b.count !== a.count) return b.count - a.count;
      if (a.voice === leadVoice && b.voice !== leadVoice) return -1;
      if (b.voice === leadVoice && a.voice !== leadVoice) return 1;
      return 0;
    });

    const primary = ranked[0];
    const keptVoices = new Set([primary.voice]);
    const secondary = ranked[1];
    if (secondary && (secondary.lockedCount > 0 || secondary.count >= 2 || primary.count < 3)) {
      keptVoices.add(secondary.voice);
    }

    for (let i = 0; i < resolved.length; i++) {
      const v = resolved[i];
      if (!v || isFemaleVoicePreset(v) !== isFem || keptVoices.has(v)) continue;
      if (lockedLexical[i]) continue;

      let targetVoice = primary.voice;
      if (i > 0 && keptVoices.has(resolved[i - 1]) && isFemaleVoicePreset(resolved[i - 1]) === isFem) {
        const prevGap = (Number(cues[i].startSec) || 0) - (Number(cues[i - 1].endSec) || 0);
        if (prevGap <= 1.2) targetVoice = resolved[i - 1];
      } else if (i + 1 < resolved.length && keptVoices.has(resolved[i + 1]) && isFemaleVoicePreset(resolved[i + 1]) === isFem) {
        const nextGap = (Number(cues[i + 1].startSec) || 0) - (Number(cues[i].endSec) || 0);
        if (nextGap <= 1.2) targetVoice = resolved[i + 1];
      }
      resolved[i] = targetVoice;
    }
  }

  return resolved;
}
router.consolidateCharacterVoicesForCues = consolidateCharacterVoicesForCues;

function inferCharacterVoicesForCues(cues, aiVoiceMap = new Map(), forceReassign = false, aiEmotionMap = new Map(), options = {}) {
  if (!Array.isArray(cues) || cues.length === 0) return cues;
  const castMode = normalizeCastMode(options && options.castMode);
  if (castMode === 'single') {
    return normalizeCueVoicesForCastMode(cues, 'single', options && options.fixedVoice);
  }

  // Check if user already customized voices (unless forceReassign is requested)
  const existingVoices = cues.map(c => String(c && c.voice || 'Sovereign King').trim());
  const allSameDefault = existingVoices.every(v => !v || v === 'Sovereign King' || v === 'km-KH-PisethNeural');
  if (!forceReassign && !allSameDefault && aiVoiceMap.size === 0) {
    if (castMode === 'duo') {
      normalizeCueVoicesForCastMode(cues, 'duo');
    }
    return cues;
  }

  const femalePool = ['Radiant Queen', 'kh_young_girl', 'kh_elder_woman'];
  const malePool = ['Sovereign King', 'kh_young_man', 'kh_deep_boss'];
  const isFemaleVoice = v => femalePool.includes(v);
  const isMaleVoice = v => malePool.includes(v);

  // Keep primary male/female leads on consistent voices unless a distinct supporting archetype is present
  const stabilizeCharacterVoice = (voice, combinedText) => {
    if (!voice) return '';
    if (voice === 'kh_young_girl') {
      if (/ប្អូនស្រី|ក្មេងស្រី|អ្នកបម្រើ|妹妹|小妹|丫头|闺蜜/.test(combinedText)) return 'kh_young_girl';
      return 'Radiant Queen';
    }
    if (voice === 'kh_deep_boss') {
      if (/លោកតា|ឪពុក|លោកប៉ា|爷爷|老爷子|爸|父亲|董事长/.test(combinedText)) return 'kh_deep_boss';
      return 'Sovereign King';
    }
    return voice;
  };

  const resolved = new Array(cues.length).fill('');
  const lockedLexical = new Array(cues.length).fill(false);
  const aiVoiceHint = idx => normalizeSuggestedVoice(aiVoiceMap.get(idx + 1) || (cues[idx] && cues[idx].suggestedVoice));
  const canOverrideAsElderWoman = hint => !hint || hint === 'Sovereign King' || isFemaleVoice(hint);
  const lockElderWomanWithBridge = idx => {
    resolved[idx] = 'kh_elder_woman';
    lockedLexical[idx] = true;
    // Walk back across immediate continuous split fragments (e.g. "晚词，" + "这次又麻烦你了。")
    let anchorIdx = idx;
    while (
      anchorIdx > 0 &&
      !lockedLexical[anchorIdx - 1] &&
      canOverrideAsElderWoman(aiVoiceHint(anchorIdx - 1)) &&
      ((Number(cues[anchorIdx].startSec) || 0) - (Number(cues[anchorIdx - 1].endSec) || 0)) <= 0.35 &&
      !/^(?:妈|婆婆|奶奶|ម៉ាក់|អ្នកម្តាយ|លោកយាយ)[！!，,\s]/.test(`${(cues[anchorIdx - 1] && cues[anchorIdx - 1].text) || ''} ${(cues[anchorIdx - 1] && cues[anchorIdx - 1].translated) || ''}`.trim())
    ) {
      anchorIdx--;
      resolved[anchorIdx] = 'kh_elder_woman';
      lockedLexical[anchorIdx] = true;
    }
    // Bridge short intervening same-scene lines between two locked elder-woman lines (e.g., bedside monologue)
    for (let k = anchorIdx - 1; k >= Math.max(0, anchorIdx - 8); k--) {
      if (resolved[k] === 'kh_elder_woman' && lockedLexical[k]) {
        let contiguous = true;
        for (let m = k; m < anchorIdx; m++) {
          const g = (Number(cues[m + 1] && cues[m + 1].startSec) || 0) - (Number(cues[m] && cues[m].endSec) || 0);
          if (g > 2.6) {
            contiguous = false;
            break;
          }
          if (m > k) {
            const midText = `${(cues[m] && cues[m].text) || ''} ${(cues[m] && cues[m].translated) || ''}`.trim();
            if (lockedLexical[m] || /^(?:妈|婆婆|奶奶|ម៉ាក់|អ្នកម្តាយ|លោកយាយ)[！!，,\s]/.test(midText) || !canOverrideAsElderWoman(aiVoiceHint(m))) {
              contiguous = false;
              break;
            }
          }
        }
        if (contiguous) {
          for (let m = k + 1; m < anchorIdx; m++) {
            resolved[m] = 'kh_elder_woman';
            lockedLexical[m] = true;
          }
        }
        break;
      }
      if (lockedLexical[k]) break;
    }
  };

  // Pass 1: Apply strong lexical speaker self-identification & vocative (who is addressed) rules.
  // Respect existing AI/audio speaker detections unless unambiguous 1st-person self-ID contradicts them.
  for (let i = 0; i < cues.length; i++) {
    if (lockedLexical[i]) continue;
    const aiSuggested = aiVoiceHint(i);
    const origText = String(cues[i].text || '');
    const khText = String(cues[i].translated || '');
    const combined = `${origText} ${khText}`;

    // Unambiguous bilingual or Khmer maternal self-identification ("我" translated as "ម៉ាក់", or Mom self-reference)
    const isBilingualMomSelfId = /我/.test(origText) && !/妈|婆婆|奶奶|母亲|妈妈/.test(origText) && /(?:ម៉ាក់|អ្នកម្តាយ)/.test(khText);
    const isKhmerMomSelfId = /(?:^|[,，!！\s])ម៉ាក់(?:អត់|មិន|គ្មាន|សុំ|នឹង|ទៅ|នៅ|គ្រាន់|ជា|ចង់|ដឹង|យល់)|(?:មើលថែ|ជូន|ឲ្យ|ឱ្យ|ចាំ)ម៉ាក់បាន/.test(khText)
      && !/^(?:妈|婆婆|奶奶|ម៉ាក់|អ្នកម្តាយ|លោកយាយ)[！!，,\s]/.test(khText.trim());
    if (isBilingualMomSelfId || isKhmerMomSelfId || /当妈的|你妈我|为娘/.test(origText)) {
      lockElderWomanWithBridge(i);
      continue;
    }

    // Addressing Mom / Mother-in-law: lock addresser burst + adjacent Mom reply BEFORE any aiSuggested early-continue
    if (/^(?:妈|婆婆|奶奶|ម៉ាក់|អ្នកម្តាយ|លោកយាយ)[！!，,\s]/.test(combined.trim())) {
      const addresserVoice = (aiSuggested && (aiSuggested === 'kh_young_man' || isFemaleVoice(aiSuggested)))
        ? (aiSuggested === 'kh_elder_woman' ? 'Radiant Queen' : aiSuggested)
        : 'Radiant Queen';
      resolved[i] = addresserVoice;
      lockedLexical[i] = true;

      if (i - 1 >= 0 && !lockedLexical[i - 1]) {
        const gapPrev = (Number(cues[i].startSec) || 0) - (Number(cues[i - 1].endSec) || 0);
        const prevCombined = `${(cues[i - 1] && cues[i - 1].text) || ''} ${(cues[i - 1] && cues[i - 1].translated) || ''}`.trim();
        const isPrevAddressingMom = /^(?:妈|婆婆|奶奶|ម៉ាក់|អ្នកម្តាយ|លោកយាយ)[！!，,\s]/.test(prevCombined);
        if (!isPrevAddressingMom && gapPrev <= 2.5 && canOverrideAsElderWoman(aiVoiceHint(i - 1)) && (gapPrev <= 1.2 || /(?:កូន|ក្មួយ|媳妇)/.test(prevCombined))) {
          lockElderWomanWithBridge(i - 1);
        }
      }

      // Include tight continuation cues spoken by the same addresser (e.g. "妈，不麻烦。" + 0.16s + "你有没有哪里不舒服？")
      let addresserEnd = i;
      while (addresserEnd + 1 < cues.length && !lockedLexical[addresserEnd + 1]) {
        const burstGap = (Number(cues[addresserEnd + 1].startSec) || 0) - (Number(cues[addresserEnd].endSec) || 0);
        const prevTurnEndedWithQuestion = /[?？吗嗎]$/.test(String(cues[addresserEnd].text || '').trim());
        const nextCombinedBurst = `${(cues[addresserEnd + 1] && cues[addresserEnd + 1].text) || ''} ${(cues[addresserEnd + 1] && cues[addresserEnd + 1].translated) || ''}`.trim();
        const nextHintBurst = aiVoiceHint(addresserEnd + 1);
        const sameAddresserBurst = burstGap >= -0.05 && burstGap <= 0.25 && !prevTurnEndedWithQuestion &&
          (!nextHintBurst || isFemaleVoice(nextHintBurst) === isFemaleVoice(addresserVoice)) &&
          !/老毛病|我没/.test(nextCombinedBurst);
        if (!sameAddresserBurst) break;
        addresserEnd++;
        resolved[addresserEnd] = addresserVoice;
        lockedLexical[addresserEnd] = true;
      }

      const replyIdx = addresserEnd + 1;
      if (replyIdx < cues.length && !lockedLexical[replyIdx]) {
        const gapNext = (Number(cues[replyIdx].startSec) || 0) - (Number(cues[addresserEnd].endSec) || 0);
        const nextCombined = `${(cues[replyIdx] && cues[replyIdx].text) || ''} ${(cues[replyIdx] && cues[replyIdx].translated) || ''}`.trim();
        const isNextAddressingMom = /^(?:妈|婆婆|奶奶|ម៉ាក់|អ្នកម្តាយ|លោកយាយ)[！!，,\s]/.test(nextCombined);
        const nextHint = aiVoiceHint(replyIdx);
        const endOrig = String(cues[addresserEnd].text || '');
        const endKh = String(cues[addresserEnd].translated || '');
        const isDirectMomQuestion = /[?？吗嗎呢]/.test(origText + endOrig) || /[?？]/.test(khText + endKh);
        if (!isNextAddressingMom && gapNext <= 3.5 && canOverrideAsElderWoman(nextHint) && (!nextHint || isDirectMomQuestion || nextHint === 'Sovereign King')) {
          lockElderWomanWithBridge(replyIdx);
        }
      }
      continue;
    }

    // Strong 1st-person Female self-identification (preserve sub-archetypes like kh_young_girl / kh_elder_woman when audio detected)
    if (/នាងខ្ញុំ|ចាស៎|ចាស!|^ចាស[។!,\s]|ខ្ញុំជាប្រពន្ធ|ខ្ញុំមានផ្ទៃពោះ|^(?:អូន|នាង)ខ្ញុំ|អូនជាប្រពន្ធ|អូនសុំអង្វរ|老娘|本小姐|本宫|妾身|我是你老婆|我是你妻子/.test(combined)) {
      resolved[i] = (aiSuggested && (isFemaleVoice(aiSuggested) || aiSuggested === 'kh_child')) ? aiSuggested : 'Radiant Queen';
      lockedLexical[i] = true;
      continue;
    }

    // Strong 1st-person Male self-identification (preserve sub-archetypes like kh_young_man / kh_deep_boss when audio detected)
    if (/ខ្ញុំបាទ|^បាទ[!！។,\s]|អញជាប្ដី|ខ្ញុំជាប្ដី|បងស្រឡាញ់អូន(?!\s*(?:ទេ|អត់|មែន))|បងនឹងការពារអូន|បងសុំទោសអូន|老夫|老子|本少|本少爷|我是你老公|我是你丈夫/.test(combined)) {
      resolved[i] = (aiSuggested && isMaleVoice(aiSuggested)) ? aiSuggested : 'Sovereign King';
      lockedLexical[i] = true;
      continue;
    }

    if (aiSuggested) {
      resolved[i] = castMode === 'duo'
        ? collapseVoiceForCastMode(aiSuggested, 'duo')
        : aiSuggested;
      continue;
    }

    // Fallback lexical heuristics ONLY when AI/audio did not provide a speaker for this cue:
    // 1. Assistant / subordinate reporting to President/Boss -> Young Man
    if (/បានត្រៀមរួចរាល់ហើយទាន|បាទលោកប្រធាន|បាទទាន|报告总裁|已經準備好|已经准备好|总裁，已经|查到了/.test(combined)) {
      resolved[i] = 'kh_young_man';
      lockedLexical[i] = true;
      continue;
    }

    // 2. Daughter / Young woman wishing Father
    if (/កូនសូមជូនពរ(?:ឲ្យ|ឱ្យ)ប៉ា|ជូនពរ(?:ឲ្យ|ឱ្យ)ប៉ា|爸！.*祝您|ប៉ា!.*កូនសូម/.test(combined)) {
      resolved[i] = 'Radiant Queen';
      lockedLexical[i] = true;
      continue;
    }


    // 4. Female context / addressing Husband
    if (/女厕所|បន្ទប់ទឹកស្រី|ប្ដីរបស់ខ្ញុំ|ប្ដីខ្ញុំ|លោកប្ដី|ប្ដីសម្លាញ់|怀孕|我怀孕|老公/.test(combined)) {
      resolved[i] = 'Radiant Queen';
      lockedLexical[i] = true;
      continue;
    }

    // 5. Male addressing Wife / Mrs. Fu
    if (/傅太太|លោកស្រី\s*ហ្វូ|លោកស្រី|ប្រពន្ធសម្លាញ់|老婆|夫人|太太|娘子|អូនសម្លាញ់|ប្រពន្ធរបស់ខ្ញុំ|ប្រពន្ធខ្ញុំ|លោកតាខ្ញុំ|爷爷曾|យើងជាឪពុក/.test(combined)) {
      resolved[i] = 'Sovereign King';
      lockedLexical[i] = true;
      continue;
    }
  }

  // Pass 2: Backward & Forward Continuity Propagation from locked lexical anchors (never overwrite AI audio detections)
  for (let i = 0; i < cues.length; i++) {
    const combined = `${cues[i].text || ''} ${cues[i].translated || ''}`;
    if (/傅太太|លោកស្រី|ប្រពន្ធសម្លាញ់|老婆/.test(combined) && resolved[i] === 'Sovereign King') {
      let mStart = i;
      while (mStart > 0 && !lockedLexical[mStart - 1] && !aiVoiceHint(mStart - 1) && isContinuousSameSpeaker(cues, mStart - 1, mStart)) {
        mStart--;
        resolved[mStart] = 'Sovereign King';
        lockedLexical[mStart] = true;
      }
      if (mStart > 0 && !lockedLexical[mStart - 1] && !aiVoiceHint(mStart - 1)) {
        resolved[mStart - 1] = 'Radiant Queen';
        lockedLexical[mStart - 1] = true;
      }
      if (i + 1 < cues.length && !lockedLexical[i + 1] && !aiVoiceHint(i + 1) && !isContinuousSameSpeaker(cues, i, i + 1)) {
        resolved[i + 1] = 'Radiant Queen';
      }
    }

    if (/លោកប្រធាន|傅总|许总|总裁/.test(combined) && resolved[i] === 'kh_young_man') {
      if (i + 1 < cues.length && !lockedLexical[i + 1] && !aiVoiceHint(i + 1)) {
        resolved[i + 1] = 'Sovereign King';
      }
    }
  }

  // Pass 2.5: Forward propagation ONLY for unresolved cues across continuous same-speaker sentences
  for (let i = 1; i < cues.length; i++) {
    if (!lockedLexical[i] && !resolved[i] && !aiVoiceHint(i) && resolved[i - 1] && isContinuousSameSpeaker(cues, i - 1, i)) {
      resolved[i] = resolved[i - 1];
    }
  }

  // Pass 3: Conversational turn-taking for remaining unresolved cues (sticking cleanly to Sovereign King <-> Radiant Queen)
  for (let i = 0; i < cues.length; i++) {
    if (resolved[i]) continue;
    const prevVoice = i > 0 ? resolved[i - 1] : '';
    const nextVoice = i + 1 < cues.length ? resolved[i + 1] : '';

    // Keep same speaker if this cue is a continuation of previous cue
    if (i > 0 && prevVoice && isContinuousSameSpeaker(cues, i - 1, i)) {
      resolved[i] = prevVoice;
      continue;
    }

    if (prevVoice && nextVoice && isFemaleVoice(prevVoice) === isFemaleVoice(nextVoice)) {
      // Back-and-forth sandwich (A -> B -> A)
      resolved[i] = isFemaleVoice(prevVoice) ? 'Sovereign King' : 'Radiant Queen';
    } else if (prevVoice) {
      resolved[i] = isFemaleVoice(prevVoice) ? 'Sovereign King' : 'Radiant Queen';
    } else if (nextVoice) {
      resolved[i] = isFemaleVoice(nextVoice) ? 'Sovereign King' : 'Radiant Queen';
    } else {
      resolved[i] = 'Sovereign King';
    }
  }

  if (castMode === 'multi') {
    consolidateCharacterVoicesForCues(cues, resolved, lockedLexical);
  }

  for (let i = 0; i < cues.length; i++) {
    const aiAssigned = aiVoiceMap.has(i + 1);
    if (forceReassign || aiAssigned || !cues[i].voice || cues[i].voice === 'Sovereign King' || cues[i].voice === 'km-KH-PisethNeural') {
      cues[i].voice = resolved[i] || 'Sovereign King';
    }
    if (castMode === 'duo') {
      cues[i].voice = collapseVoiceForCastMode(cues[i].voice, 'duo');
    }
    delete cues[i].emotion;
    delete cues[i].suggestedEmotion;
  }

  return cues;
}

function getPromptLanguageMeta(targetLang) {
  const meta = {
    km: {
      renderingName: 'Khmer',
      editorRole: 'an expert Cambodian TV-drama dubbing director and scriptwriter',
      formatHint: ` Write strictly in pure Khmer Unicode script (ក-អ); never mix Thai or English letters. ${CHUON_NATH_PROMPT_GUIDE} Follow proper Cambodian Khmer spacing: do NOT insert spaces between every single word—write connected Khmer phrases naturally without spaces (e.g., នោះគ្រាន់តែជានាឡិកាដៃមួយគ្រឿងប៉ុណ្ណោះ), inserting spaces ONLY between clauses, after punctuation, or where standard Khmer writing requires a pause. Use vivid, emotional, natural spoken Cambodian dialogue (e.g. ណា៎!, ទេអ្ហី!, ម៉េចក៏..., មែនទេ?, ចាស៎, បាទ, ហ្នឹង!) so it sounds like real actors speaking with emotion rather than stiff textbook translation.`
    },
    en: {
      renderingName: 'English',
      editorRole: 'an English TV-drama dubbing editor',
      formatHint: ''
    },
    th: {
      renderingName: 'Thai',
      editorRole: 'a Thai TV-drama dubbing editor',
      formatHint: ''
    },
    vi: {
      renderingName: 'Vietnamese',
      editorRole: 'a Vietnamese TV-drama dubbing editor',
      formatHint: ''
    },
    zh: {
      renderingName: 'Simplified Chinese',
      editorRole: 'a Chinese TV-drama dubbing editor',
      formatHint: ''
    },
    ko: {
      renderingName: 'Korean',
      editorRole: 'a Korean TV-drama dubbing editor',
      formatHint: ''
    },
    ja: {
      renderingName: 'Japanese',
      editorRole: 'a Japanese TV-drama and anime dubbing editor',
      formatHint: ''
    },
    'zh-km': {
      renderingName: 'Khmer paired with the original Chinese',
      editorRole: 'a bilingual Chinese-Khmer TV-drama subtitle and dubbing editor',
      formatHint: ' Preserve the bilingual "Chinese | Khmer" format separated by " | ".'
    },
    'en-km': {
      renderingName: 'Khmer paired with English',
      editorRole: 'a bilingual English-Khmer TV-drama subtitle and dubbing editor',
      formatHint: ' Preserve the bilingual "English | Khmer" format separated by " | ".'
    }
  };
  return meta[targetLang] || meta.km;
}

/**
 * Formats an Episode Story & Character Bible into concise prompt instructions for chunks and reflection.
 */
function formatStoryBibleForPrompt(bible, targetLang) {
  if (!bible || typeof bible !== 'object') return '';
  const parts = [];
  if (bible.synopsis) parts.push(`Plot & Scene Context: ${bible.synopsis}`);
  if (bible.tone) parts.push(`Drama Tone: ${bible.tone}`);
  if (Array.isArray(bible.characters) && bible.characters.length > 0) {
    const charLines = bible.characters.slice(0, 15).map(ch => {
      const aliasList = Array.isArray(ch.names) ? ch.names.join(' / ') : (ch.name || '');
      const rendering = ch.rendering || ch.khmerName || '';
      const role = ch.role || '';
      const gender = ch.gender ? ` [${ch.gender}]` : '';
      return `- ${aliasList} => STRICT consistent name "${rendering}"${gender}${role ? ` (${role})` : ''}`;
    });
    parts.push(`Characters & Locked ${targetLang === 'km' ? 'Khmer ' : ''}Names:\n${charLines.join('\n')}`);
  }
  if (Array.isArray(bible.relationshipPronouns) && bible.relationshipPronouns.length > 0) {
    parts.push(`Pronoun & Form-of-Address Rules:\n${bible.relationshipPronouns.slice(0, 12).map(r => `- ${r}`).join('\n')}`);
  }
  if (Array.isArray(bible.sttCorrections) && bible.sttCorrections.length > 0) {
    parts.push(`ASR/STT Homophone Fixes (translate intended story meaning, NOT speech-recognition typo):\n${bible.sttCorrections.slice(0, 15).map(c => `- "${c.wrong}" -> "${c.intended}"${c.note ? ` (${c.note})` : ''}`).join('\n')}`);
  }
  if (Array.isArray(bible.terms) && bible.terms.length > 0) {
    const termLines = bible.terms.slice(0, 20).map(t => `- "${t.source}" => "${t.rendering}"${t.note ? ` (${t.note})` : ''}`);
    parts.push(`Key Plot Terms:\n${termLines.join('\n')}`);
  }
  return parts.join('\n\n');
}

/**
 * Extracts a full-episode Story Bible (plot arc, character Khmer-script roster, pronoun matrix,
 * and ASR/STT homophone repairs) so every translation batch matches the real story.
 */
async function buildEpisodeStoryBible(cues, srcSpec, targetLanguage, langMeta, apiKey) {
  const empty = { synopsis: '', tone: '', characters: [], relationshipPronouns: [], sttCorrections: [], terms: [] };
  if (!Array.isArray(cues) || cues.length < STORY_ANALYSIS_MIN_CUES || !apiKey) {
    return { bible: empty, apiCalls: 0 };
  }
  const allLines = cues.map((cue, i) => `${i + 1}: ${(cue.text || '').replace(/\s+/g, ' ').trim()}`);
  const fullScriptText = allLines.join('\n');
  const scriptForPrompt = fullScriptText.length <= 16000
    ? fullScriptText
    : `${fullScriptText.slice(0, 7500)}\n...\n${fullScriptText.slice(Math.floor(fullScriptText.length * 0.45), Math.floor(fullScriptText.length * 0.45) + 4000)}\n...\n${fullScriptText.slice(-4300)}`;
  const khmerNameRule = targetLanguage.toLowerCase().includes('khmer') || langMeta.renderingName === 'Khmer'
    ? 'Transliterate ALL Chinese/foreign personal names and surnames into ONE consistent pure Khmer script spelling (e.g., ពេជ្រ/ប៉ី ជីអាន, ចឹង យ៉ានឈីង, គូ ឈឹងឈួន) — NEVER leave English/Pinyin like "Gu Chengchuan" or switch spellings (e.g. ភី vs ប៉ី vs ជាន).'
    : `Choose ONE consistent ${langMeta.renderingName} spelling for every character name.`;

  const biblePrompt = `You are ${langMeta.editorRole} preparing a full ${srcSpec.name} short-drama translation into ${targetLanguage}.
Read the ENTIRE episode dialogue chronologically from line 1 to the end before translating any single line.
Analyze:
1. "synopsis": 2-4 sentences explaining the real plot, conflict, hidden facts (e.g. secret pregnancy, divorce terms, disguised billionaire), and who each character actually is.
2. "tone": Emotional atmosphere of the episode.
3. "characters": Every character (including all STT spelling/homophone variants referencing that same person, e.g. 佩女士/耴女士/简姐/之安姐 -> 裴之安), their exact gender, role, and ONE locked "rendering" (${khmerNameRule}).
4. "relationshipPronouns": Explicit pronoun pairs in spoken ${langMeta.renderingName} for each pair speaking (in Khmer drama dubbing: close friends use ឯង/គ្នា or នាង/ខ្ញុំ NEVER stiff "អ្នក"; servants -> madam use អ្នកស្រីតូច/លោកស្រី; estranged exes/antagonists use លោក/ខ្ញុំ or អ្នកឯង/នាង; family uses ប៉ា/ម៉ាក់/កូន/អូន/បង).
5. "sttCorrections": Any speech-to-text homophone errors in the transcript that would break the plot if translated literally (e.g. "怕妈...他们" -> "爸妈 (both parents died)", "简姐" -> "之安姐", "老顾书" -> "老顾头", "正太太" -> "郑太太", wrong "他" when context clearly refers to a woman).
6. "terms": Key numbers/amounts/plot terms (e.g. "六个亿" -> "ប្រាំមួយរយលាន", "四胞胎" -> "កូនភ្លោះបួន").

Return ONLY valid JSON:
{"synopsis":"...","tone":"...","characters":[{"names":["..."],"rendering":"...","gender":"female|male|unknown","role":"..."}],"relationshipPronouns":["..."],"sttCorrections":[{"wrong":"...","intended":"...","note":"..."}],"terms":[{"source":"...","rendering":"...","note":"..."}]}

Complete Episode Dialogue:
${scriptForPrompt}`;

  try {
    const parsed = parseJsonObject(
      await callGeminiApi(biblePrompt, apiKey, [], 18000),
      'story bible'
    );
    return {
      bible: {
        synopsis: typeof parsed.synopsis === 'string' ? parsed.synopsis.trim() : '',
        tone: typeof parsed.tone === 'string' ? parsed.tone.trim() : '',
        characters: Array.isArray(parsed.characters) ? parsed.characters.slice(0, 20) : [],
        relationshipPronouns: Array.isArray(parsed.relationshipPronouns) ? parsed.relationshipPronouns.slice(0, 15) : [],
        sttCorrections: Array.isArray(parsed.sttCorrections) ? parsed.sttCorrections.slice(0, 20) : [],
        terms: Array.isArray(parsed.terms) ? parsed.terms.slice(0, 25) : []
      },
      apiCalls: 1
    };
  } catch (err) {
    console.warn('[translation] Story Bible pass skipped, continuing with direct translation:', err.message);
    return { bible: empty, apiCalls: 0 };
  }
}

/**
 * Resolves a returned translation item ID strictly without allowing off-by-one shifts when lines are skipped.
 */
function resolveDraftCueId(rawId, idxInArray, indices, totalDraftCount, allUseLocalOneBased, allUseLocalZeroBased = false) {
  if (Number.isInteger(rawId) && indices.includes(rawId - 1)) {
    return rawId;
  }
  if (allUseLocalOneBased && Number.isInteger(rawId) && rawId >= 1 && rawId <= indices.length) {
    return indices[rawId - 1] + 1;
  }
  if (allUseLocalZeroBased && Number.isInteger(rawId) && rawId >= 0 && rawId < indices.length) {
    return indices[rawId] + 1;
  }
  if (!Number.isInteger(rawId) && totalDraftCount === indices.length && idxInArray >= 0 && idxInArray < indices.length) {
    return indices[idxInArray] + 1;
  }
  return null;
}

/**
 * Performs a full-episode story, pronoun, and name consistency reflection pass over translated cues,
 * patching only lines whose meaning, reply polarity, character name, or spoken register drifts from the plot.
 */
async function reflectOnEpisodeTranslations(resultCues, googleFallbackIndices, storyBibleText, srcSpec, targetLang, targetLanguage, langMeta, apiKey) {
  if (!Array.isArray(resultCues) || resultCues.length < STORY_ANALYSIS_MIN_CUES || !apiKey) {
    return { apiCalls: 0, fixedCount: 0 };
  }
  const REVIEW_BATCH_SIZE = 120;
  let apiCalls = 0;
  let fixedCount = 0;

  for (let start = 0; start < resultCues.length; start += REVIEW_BATCH_SIZE) {
    const end = Math.min(resultCues.length, start + REVIEW_BATCH_SIZE);
    const reviewItems = [];
    for (let i = start; i < end; i++) {
      const c = resultCues[i];
      if (!c || typeof c.text !== 'string' || !c.text.trim()) continue;
      reviewItems.push({
        id: i + 1,
        speaker: normalizeSuggestedVoice(c.voice) || '',
        source: c.text.trim(),
        translation: String(c.translated || '').trim()
      });
    }
    if (reviewItems.length < STORY_ANALYSIS_MIN_CUES) continue;

    const reflectPrompt = `You are ${langMeta.editorRole} doing a final full-episode continuity & dialogue check on a ${srcSpec.name} -> ${targetLanguage} drama script.
${storyBibleText ? `\nEpisode Story Bible:\n${storyBibleText}\n` : ''}
Check the complete chronological dialogue below and return corrections ONLY for lines that have ANY of these defects:
1. Meaning/Subtext Mismatch with Story: e.g. a reply answering "Didn't you ask?" like "问啊" mistranslated as command "សួរទៅ!" instead of "ធ្លាប់សួរតើ!"; missing sarcasm; wrong yes/no polarity; shifted line translation; or literal idiom calques (like "ខ្មៅលើក្រដាសស" -> "មានកត់ត្រាជាលាយលក្ខណ៍អក្សរច្បាស់លាស់").
2. STT Typo Translated Literally: e.g. "怕妈...他们" -> "ពុកម៉ែ..." (NOT "ខ្លាចម៉ែស្លាប់"), "简姐" -> female lead's real name, "他" when speaking of a female character -> "នាង".
3. Character Name / Surname Drift or Non-Khmer Pinyin: unify ALL occurrences of the same character to ONE exact ${langMeta.renderingName} spelling matching the Story Bible (transliterate any leftover Latin names like "Gu Chengchuan" into pure Khmer script).
4. Wrong Social Pronoun / Relationship Register: close friends must NOT call each other stiff "អ្នក" (use ឯង/គ្នា/នាង); servants -> young madam use លោកស្រី/អ្នកស្រីតូច; wife/husband/in-laws match their scene relationship.
5. Corrupted/Unnatural Suffixes or Truncation.${targetLang === 'km' ? ` ${CHUON_NATH_PROMPT_GUIDE}` : ''}

IMPORTANT:
- Return ONLY lines that genuinely need fixing! If a line already fits the story accurately and naturally, OMIT it.
- Preserve exact input "id" numbers.
Return ONLY valid JSON: {"fixes":[{"id":12,"translation":"..."}]} (or {"fixes":[]} if all lines already match the story).

Complete Episode Script:
${JSON.stringify(reviewItems)}`;

    try {
      apiCalls++;
      const parsed = parseJsonObject(
        await callGeminiApi(reflectPrompt, apiKey, [], 15000),
        'story reflection'
      );
      const fixes = Array.isArray(parsed.fixes) ? parsed.fixes : [];
      for (const fix of fixes) {
        const id = Number(fix && fix.id);
        if (!Number.isInteger(id) || id < 1 || id > resultCues.length) continue;
        if (typeof fix.translation !== 'string' || !fix.translation.trim()) continue;
        const idx = id - 1;
        const rawFix = fix.translation.trim();
        if (targetLang === 'km' && hasCorruptedKhmerText(normalizeCjkPunctuationToKhmer(rawFix))) continue;
        const cleaned = cleanTranslatedText(rawFix, targetLang);
        if (!cleaned || isTranslationIncomplete(cleaned, resultCues[idx].text, targetLang)) continue;
        if (cleaned !== resultCues[idx].translated) {
          resultCues[idx].translated = cleaned;
          resultCues[idx].translatedLang = targetLang;
          googleFallbackIndices.delete(idx);
          fixedCount++;
        }
      }
    } catch (err) {
      console.warn('[translation] Story reflection pass skipped cleanly:', err.message);
    }
  }
  return { apiCalls, fixedCount };
}

async function translateWithReflection(cues, targetLang, apiKey, useCache, force, sourceLang = 'auto', options = {}) {
  const translationStartMs = Date.now();
  const effectiveCastMode = normalizeCastMode(options && options.castMode);
  const fixedVoice = normalizeSuggestedVoice(options && options.fixedVoice) || '';
  const videoPath = options && typeof options.videoPath === 'string' ? options.videoPath : '';
  const resultCues = cues.map(cue => ({ ...cue }));
  const targetLanguage = getTargetLanguage(targetLang);
  const langMeta = getPromptLanguageMeta(targetLang);
  const srcSpec = getSourceLanguage(sourceLang) || SOURCE_LANGUAGE_SPECS.auto;
  const cacheSrcKey = sourceLang && sourceLang !== 'auto' ? sourceLang : 'zh';
  const contextDigest = crypto.createHash('sha256')
    .update(`story-v2:${cacheSrcKey}->${targetLang}\n${cues.map(cue => cue.text || '').join('\n')}`)
    .digest('hex');
  let translatedCount = 0;
  let cacheHits = 0;
  let apiCalls = 0;
  const pending = [];

  for (let i = 0; i < resultCues.length; i++) {
    const cue = resultCues[i];
    if (typeof cue.text !== 'string' || !cue.text.trim()) {
      continue;
    }
    const hasCurrentTranslation = cue.translated && cue.translated !== cue.text &&
      !isTranslationIncomplete(cue.translated, cue.text, targetLang) &&
      (!cue.translatedLang
        ? targetLang === 'km'
        : cue.translatedLang === targetLang);
    if (!force && hasCurrentTranslation) continue;

    const cueCacheContext = `${contextDigest}:${i}`;
    const rawCached = useCache && !force
      ? await translationCache.get(cue.text, cacheSrcKey, targetLang, cueCacheContext)
      : null;
    const cached = rawCached && !isTranslationIncomplete(rawCached, cue.text, targetLang)
      ? cleanTranslatedText(rawCached, targetLang)
      : null;
    if (cached) {
      cue.translated = cached;
      cue.translatedLang = targetLang;
      translatedCount++;
      cacheHits++;
    } else {
      pending.push(i);
    }
  }

  const hasExistingAudioCast = resultCues.filter(c => Boolean(normalizeSuggestedVoice(c && c.suggestedVoice))).length >=
    Math.max(1, Math.ceil(resultCues.length * 0.8));

  if (pending.length === 0) {
    const cachedVoiceMap = new Map();
    const cachedEmotionMap = new Map();
    if (effectiveCastMode !== 'single' && videoPath && apiKey && !hasExistingAudioCast) {
      await castVoicesWithAudioChunks(resultCues, videoPath, apiKey, effectiveCastMode, cachedVoiceMap, cachedEmotionMap);
    }
    inferCharacterVoicesForCues(resultCues, cachedVoiceMap, false, cachedEmotionMap, { castMode: effectiveCastMode, fixedVoice });
    return { cues: resultCues, translatedCount, cacheHits, apiCalls };
  }

  const aiVoiceMap = new Map();
  const aiEmotionMap = new Map();

  // Pass 1: Build full-episode Story Bible (plot summary, character Khmer roster, pronouns & STT typo fixes)
  const storyResult = await buildEpisodeStoryBible(cues, srcSpec, targetLanguage, langMeta, apiKey);
  apiCalls += storyResult.apiCalls;
  const storyBible = storyResult.bible;
  const storyBibleText = formatStoryBibleForPrompt(storyBible, targetLang);

  const chunkSlices = [];
  for (let offset = 0; offset < pending.length; offset += TRANSLATION_CHUNK_SIZE) {
    chunkSlices.push(pending.slice(offset, offset + TRANSLATION_CHUNK_SIZE));
  }

  const googleFallbackIndices = new Set();

  const translateSingleChunk = async (indices) => {
    const firstIdx = indices[0];
    const lastIdx = indices[indices.length - 1];
    const leadingContext = [];
    for (let j = Math.max(0, firstIdx - 4); j < firstIdx; j++) {
      if (cues[j] && cues[j].text) {
        leadingContext.push({ id: j + 1, source: cues[j].text });
      }
    }
    const trailingContext = [];
    for (let j = lastIdx + 1; j <= Math.min(cues.length - 1, lastIdx + 2); j++) {
      if (cues[j] && cues[j].text) {
        trailingContext.push({ id: j + 1, source: cues[j].text });
      }
    }

    const chunk = indices.map((cueIndex) => {
      const item = {
        id: cueIndex + 1,
        source: cues[cueIndex].text
      };
      const existingHint = normalizeSuggestedVoice(cues[cueIndex] && cues[cueIndex].suggestedVoice);
      if (existingHint) {
        item.audioHint = collapseVoiceForCastMode(existingHint, effectiveCastMode);
      }
      return item;
    });
    const voiceGuide = effectiveCastMode === 'single'
      ? `1) locked single voice "${fixedVoice || 'Sovereign King'}" (do NOT split speakers; set "voice":"${fixedVoice || 'Sovereign King'}" on every item)`
      : (effectiveCastMode === 'duo'
        ? `1) the speaker's character voice "voice" (STRICT 2-CHARACTER LOCK — choose ONLY from these 2 IDs):
- "Radiant Queen" (Female character / woman / wife)
- "Sovereign King" (Male character / man / husband)`
        : `1) the speaker's character voice "voice" — ${MULTI_CAST_VOICE_RULES}`);
    const translationPrompt = `Translate EVERY single ${srcSpec.name} short-drama subtitle item below into ${targetLanguage}.
Act as ${langMeta.editorRole}. Translate for true story meaning, conversational subtext (e.g. "问啊" replying "why didn't you ask?" means "ធ្លាប់សួរតើ!", NOT imperative "សួរទៅ!"), sarcasm, character voice, and natural spoken dialogue rather than word-for-word literal phrasing.${langMeta.formatHint}
Keep character names (strictly in ${targetLang === 'km' ? 'pure Khmer script' : langMeta.renderingName}, NEVER Latin Pinyin for Chinese names), titles, pronouns, and relationships 100% consistent with the Story Bible.
${storyBibleText ? `\n=== EPISODE STORY BIBLE ===\n${storyBibleText}\n` : ''}For each item, also infer:
${voiceGuide}
CRITICAL VOICE RULES:
- If an item includes "audioHint" (detected from real video audio), PRESERVE that exact speaker voice unless unambiguous 1st-person proof contradicts it — NEVER replace a speaker who starts from line 1 with the opposite gender.
- Do NOT switch a character's "voice" between lines just because their tone changes! Keep the Female Lead as "Radiant Queen" and the Male Lead as "Sovereign King" throughout the entire conversation.
- When one character speaks 2 or 3 consecutive subtitle lines to finish a thought, assign the EXACT SAME "voice" to all of those consecutive lines.
- If a line addresses "傅太太 / លោកស្រី / 老婆 / ប្រពន្ធសម្លាញ់", the speaker is Male ("Sovereign King") speaking to a woman. If a line mentions "女厕所 / បន្ទប់ទឹកស្រី / នាងខ្ញុំ / ចាស" or addresses "老公 / លោកប្ដី", the speaker is Female ("Radiant Queen").
IMPORTANT: Return a translation for EVERY item in the input array (${chunk.length} items total). Preserve the EXACT input "id" for each item, NEVER merge/skip items or shift IDs, and do not leave any source-language words untranslated.
${targetLang === 'km' ? 'Use ONLY pure, properly spelled Khmer script — NEVER insert Thai, Vietnamese, Arabic, European accents, CJK, English Pinyin names, stray lowercase Latin letters, or doubled/corrupted Khmer vowel signs (such as ទៅោ or ប្រាំាំ).' : `Use ONLY pure ${langMeta.renderingName} script without foreign character leaks.`}
Ensure all double quotes inside translated strings are properly escaped (e.g. \\") or use single quotes/Khmer quotation marks («...»).
Return ONLY valid JSON: {"translations":[{"id":${chunk[0].id},"translation":"...","voice":"Radiant Queen"}]}.
${leadingContext.length > 0 ? `\nPreceding Scene Lines (context only — do NOT include in output):\n${JSON.stringify(leadingContext)}\n` : ''}Dialogue items to translate (chronological flow):
${JSON.stringify(chunk)}${trailingContext.length > 0 ? `\nFollowing Scene Lines (context only — do NOT include in output):\n${JSON.stringify(trailingContext)}` : ''}`;

    const draftMap = new Map();
    const applyDraftItems = (drafts, targetIndices, assignVoice = false) => {
      const list = Array.isArray(drafts) ? drafts : [];
      const allUseLocalOneBased = list.length === targetIndices.length &&
        !targetIndices.includes(0) &&
        list.every((d, idx) => Number(d && d.id) === idx + 1);
      const allUseLocalZeroBased = list.length === targetIndices.length &&
        list.every((d, idx) => Number(d && d.id) === idx);
      list.forEach((item, idxInArr) => {
        if (!item || typeof item.translation !== 'string' || !item.translation.trim()) return;
        // Keep unstripped text so foreign-script/CJK leaks trigger retry before sanitization
        const trVal = item.translation.trim();
        if (!trVal) return;
        const resolvedId = resolveDraftCueId(
          Number(item.id),
          idxInArr,
          targetIndices,
          list.length,
          allUseLocalOneBased,
          allUseLocalZeroBased
        );
        if (resolvedId === null) return;
        const existingDraft = draftMap.get(resolvedId);
        if (!existingDraft || isTranslationIncomplete(existingDraft, cues[resolvedId - 1].text, targetLang)) {
          draftMap.set(resolvedId, trVal);
        }
        if (assignVoice) {
          const existingSuggested = normalizeSuggestedVoice(cues[resolvedId - 1] && cues[resolvedId - 1].suggestedVoice);
          if (existingSuggested) {
            if (!aiVoiceMap.has(resolvedId)) {
              aiVoiceMap.set(resolvedId, collapseVoiceForCastMode(existingSuggested, effectiveCastMode));
            }
          } else if (item.voice) {
            const normVoice = normalizeSuggestedVoice(item.voice);
            if (normVoice) aiVoiceMap.set(resolvedId, collapseVoiceForCastMode(normVoice, effectiveCastMode));
          }
        }
      });
    };

    let lastChunkErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        apiCalls++;
        const parsed = parseJsonObject(
          await callGeminiApi(translationPrompt, apiKey, [], 45000),
          'translation'
        );
        const drafts = Array.isArray(parsed.translations) ? parsed.translations : [];
        applyDraftItems(drafts, indices, true);
        if (draftMap.size >= indices.length) break;
      } catch (chunkErr) {
        lastChunkErr = chunkErr;
        console.warn(`[translation] Chunk translation attempt ${attempt + 1} warning:`, chunkErr.message);
      }
    }

    // Identify any missing or incomplete/corrupted lines in this chunk before stripping foreign characters
    const getIncompleteIndices = () => indices.filter(cueIndex => {
      const tr = draftMap.get(cueIndex + 1);
      return isTranslationIncomplete(tr, cues[cueIndex].text, targetLang);
    });

    // Retry missing/corrupted cues in smaller sub-batches EVEN if full-chunk attempts threw an error
    let missingIndices = getIncompleteIndices();
    if (missingIndices.length > 0 && apiKey) {
      const SUB_BATCH_SIZE = 8;
      const subBatches = [];
      for (let off = 0; off < missingIndices.length; off += SUB_BATCH_SIZE) {
        subBatches.push(missingIndices.slice(off, off + SUB_BATCH_SIZE));
      }
      await mapWithConcurrency(subBatches, 2, async (subIndices) => {
        try {
          const retryItems = subIndices.map(cueIndex => ({
            id: cueIndex + 1,
            contextBefore: cues[cueIndex - 1] ? cues[cueIndex - 1].text : '',
            source: cues[cueIndex].text,
            contextAfter: cues[cueIndex + 1] ? cues[cueIndex + 1].text : ''
          }));
          const retryPrompt = `Translate each ${srcSpec.name} subtitle completely into natural spoken ${targetLanguage} fitting the story and neighboring lines.${langMeta.formatHint}
${storyBibleText ? `\nStory Bible:\n${storyBibleText}\n` : ''}CRITICAL: Translate 100% of every line — do NOT skip lines and do NOT leave ANY ${srcSpec.name} characters, CJK punctuation, or untranslated source words inside "translation". Preserve exact input "id" values. ${targetLang === 'km' ? 'Use ONLY pure, validly spelled Khmer script — NEVER mix Thai, Vietnamese, Arabic, European accents, English Pinyin names, CJK, or doubled Khmer vowel signs.' : ''}
Return ONLY valid JSON: {"translations":[{"id":${retryItems[0].id},"translation":"..."}]}.
Items: ${JSON.stringify(retryItems)}`;
          apiCalls++;
          const retryParsed = parseJsonObject(await callGeminiApi(retryPrompt, apiKey, [], 35000), 'translation');
          const retryDrafts = Array.isArray(retryParsed.translations) ? retryParsed.translations : [];
          applyDraftItems(retryDrafts, subIndices, false);
        } catch (retryErr) {
          console.warn('[translation] Sub-batch retry skipped:', retryErr.message);
        }
      });
    }

    // Throttled Google Translate fallback for remaining missing/incomplete lines (avoid parallel 429 burst)
    missingIndices = getIncompleteIndices();
    if (missingIndices.length > 0) {
      await mapWithConcurrency(missingIndices, 2, async (cueIndex) => {
        const fallbackTr = await translateWithGoogleFallbackSafe(cues[cueIndex].text, sourceLang, targetLang, 2);
        if (!fallbackTr) return;
        const cleanedFallback = cleanTranslatedText(fallbackTr, targetLang);
        if (cleanedFallback && !isTranslationIncomplete(cleanedFallback, cues[cueIndex].text, targetLang)) {
          draftMap.set(cueIndex + 1, cleanedFallback);
          googleFallbackIndices.add(cueIndex);
        } else if (
          !draftMap.has(cueIndex + 1) &&
          cleanedFallback &&
          cleanedFallback !== cues[cueIndex].text &&
          (targetLang !== 'km' || /[\u1780-\u17FF]/.test(cleanedFallback))
        ) {
          // Store unstripped candidate if still partially mixed so Pass 4 sweeper repairs remaining words
          draftMap.set(cueIndex + 1, fallbackTr);
          googleFallbackIndices.add(cueIndex);
        }
      });
      if (draftMap.size === 0 && lastChunkErr) {
        throw lastChunkErr;
      }
    }

    for (const cueIndex of indices) {
      const rawDraft = draftMap.get(cueIndex + 1);
      if (rawDraft && !isTranslationIncomplete(rawDraft, cues[cueIndex].text, targetLang)) {
        resultCues[cueIndex].translated = cleanTranslatedText(rawDraft, targetLang);
        resultCues[cueIndex].translatedLang = targetLang;
      } else if (rawDraft && rawDraft.trim()) {
        // Keep unstripped incomplete draft temporarily so Story Reflection + Pass 4 repair leaked words
        resultCues[cueIndex].translated = rawDraft.trim();
        delete resultCues[cueIndex].translatedLang;
      } else if (
        cues[cueIndex].translated &&
        cues[cueIndex].translated !== cues[cueIndex].text &&
        !isTranslationIncomplete(cues[cueIndex].translated, cues[cueIndex].text, targetLang)
      ) {
        resultCues[cueIndex].translated = cleanTranslatedText(cues[cueIndex].translated, targetLang);
        resultCues[cueIndex].translatedLang = targetLang;
      } else {
        resultCues[cueIndex].translated = '';
        delete resultCues[cueIndex].translatedLang;
      }
    }
  };

  // Scale parallel translation concurrency across Router Management accounts, and overlap audio voice casting when needed
  const healthyKeyCount = getGeminiApiKeyCandidates(apiKey, `api:${preferredGeminiModel}`).length;
  const maxConcurrentChunks = Math.min(8, Math.max(3, healthyKeyCount));
  let sliceCursor = 0;
  const runChunkPool = async () => {
    const workerCount = Math.min(maxConcurrentChunks, chunkSlices.length || 1);
    const workers = Array.from({ length: workerCount }, async () => {
      while (sliceCursor < chunkSlices.length) {
        const idx = sliceCursor++;
        await translateSingleChunk(chunkSlices[idx]);
      }
    });
    await Promise.all(workers);
  };

  const audioCastVoiceMap = new Map();
  const audioCastEmotionMap = new Map();
  if (effectiveCastMode !== 'single' && videoPath && apiKey && !hasExistingAudioCast) {
    await Promise.all([
      runChunkPool(),
      castVoicesWithAudioChunks(resultCues, videoPath, apiKey, effectiveCastMode, audioCastVoiceMap, audioCastEmotionMap)
    ]);
    for (const [id, v] of audioCastVoiceMap.entries()) aiVoiceMap.set(id, v);
    for (const [id, e] of audioCastEmotionMap.entries()) aiEmotionMap.set(id, e);
  } else {
    await runChunkPool();
  }
  inferCharacterVoicesForCues(resultCues, aiVoiceMap, false, aiEmotionMap, { castMode: effectiveCastMode, fixedVoice });

  // Pass 3: Full-episode Story Reflection & Consistency Review (runs on episodes >= 4 lines if within time budget to prevent Cloudflare 524)
  if (pending.length >= STORY_ANALYSIS_MIN_CUES && (Date.now() - translationStartMs) < 38000) {
    const reflResult = await reflectOnEpisodeTranslations(
      resultCues,
      googleFallbackIndices,
      storyBibleText,
      srcSpec,
      targetLang,
      targetLanguage,
      langMeta,
      apiKey
    );
    apiCalls += reflResult.apiCalls;
  }

  // Pass 4: Post-Episode Anti-Leak & Completeness Sweeper (guarantees zero untranslated/Chinese-leaked cues slip through)
  let sweptCount = 0;
  const findLeakedCueIndices = () => {
    const out = [];
    for (let i = 0; i < resultCues.length; i++) {
      const src = cues[i] && typeof cues[i].text === 'string' ? cues[i].text.trim() : '';
      if (!src) continue;
      if (isTranslationIncomplete(resultCues[i].translated, src, targetLang)) {
        out.push(i);
      }
    }
    return out;
  };

  let leakedIndices = findLeakedCueIndices();
  if (leakedIndices.length > 0 && apiKey) {
    // 4a. Small focused Gemini repair batches (max 6 cues)
    const RESCUE_BATCH_SIZE = 6;
    const rescueBatches = [];
    for (let off = 0; off < leakedIndices.length; off += RESCUE_BATCH_SIZE) {
      rescueBatches.push(leakedIndices.slice(off, off + RESCUE_BATCH_SIZE));
    }
    let fatalAuthErr = false;
    await mapWithConcurrency(rescueBatches, 2, async (subIndices) => {
      try {
        const repairItems = subIndices.map(cueIdx => ({
          id: cueIdx + 1,
          previousLine: cueIdx > 0 ? (resultCues[cueIdx - 1].translated || cues[cueIdx - 1].text || '') : '',
          source: cues[cueIdx].text,
          partialDraft: resultCues[cueIdx].translated && resultCues[cueIdx].translated !== cues[cueIdx].text
            ? resultCues[cueIdx].translated
            : '',
          nextLine: cueIdx + 1 < cues.length ? (resultCues[cueIdx + 1].translated || cues[cueIdx + 1].text || '') : ''
        }));
        const repairPrompt = `CRITICAL ANTI-LEAK TRANSLATION REPAIR (${srcSpec.name} -> ${targetLanguage}):
Every item below was missed OR still contains leaked ${srcSpec.name}/foreign characters or untranslated words.
${storyBibleText ? `\nEpisode Story Bible:\n${storyBibleText}\n` : ''}Rules:
1. Translate EVERY word, phrase, interjection, and character name 100% into natural spoken ${targetLanguage}.${langMeta.formatHint}
2. ZERO characters from ${srcSpec.name} (NO Hanzi/CJK letters or CJK punctuation like ，。？！) may remain in "translation".
3. Preserve exact input "id" values. Return ONLY valid JSON: {"translations":[{"id":${repairItems[0].id},"translation":"..."}]}.
Items: ${JSON.stringify(repairItems)}`;
        apiCalls++;
        const parsed = parseJsonObject(await callGeminiApi(repairPrompt, apiKey, [], 35000), 'anti-leak repair');
        const drafts = Array.isArray(parsed.translations) ? parsed.translations : [];
        const allOneBased = drafts.length === subIndices.length &&
          !subIndices.includes(0) &&
          drafts.every((d, idx) => Number(d && d.id) === idx + 1);
        const allZeroBased = drafts.length === subIndices.length &&
          drafts.every((d, idx) => Number(d && d.id) === idx);
        drafts.forEach((item, idxInArr) => {
          if (!item || typeof item.translation !== 'string' || !item.translation.trim()) return;
          const resolvedId = resolveDraftCueId(
            Number(item.id),
            idxInArr,
            subIndices,
            drafts.length,
            allOneBased,
            allZeroBased
          );
          if (resolvedId === null) return;
          const idx = resolvedId - 1;
          const rawCandidate = item.translation.trim();
          const cleaned = cleanTranslatedText(rawCandidate, targetLang);
          if (
            !isTranslationIncomplete(rawCandidate, cues[idx].text, targetLang) ||
            (cleaned && !hasCorruptedKhmerText(rawCandidate.replace(/[\u3000-\u303F\uFF01-\uFF60]/g, '')) && !isTranslationIncomplete(cleaned, cues[idx].text, targetLang))
          ) {
            resultCues[idx].translated = cleaned;
            resultCues[idx].translatedLang = targetLang;
            googleFallbackIndices.delete(idx);
            sweptCount++;
          }
        });
      } catch (err) {
        if (err && (err.statusCode === 401 || err.statusCode === 403)) {
          fatalAuthErr = true;
        }
        console.warn('[translation] Pass 4a anti-leak batch warning:', err.message);
      }
    });

    // 4b. Isolated 1-item Gemini rescue for up to 12 stubborn survivors (e.g. one sensitive line breaking a batch)
    leakedIndices = findLeakedCueIndices();
    if (leakedIndices.length > 0 && leakedIndices.length <= 12 && !fatalAuthErr) {
      await mapWithConcurrency(leakedIndices, 2, async (cueIdx) => {
        try {
          const singlePrompt = `Translate this single ${srcSpec.name} subtitle completely into ${targetLanguage}.${langMeta.formatHint}
ZERO ${srcSpec.name}/Chinese/foreign characters may remain. Return ONLY JSON: {"id":${cueIdx + 1},"translation":"..."}
Context before: ${cueIdx > 0 ? (resultCues[cueIdx - 1].translated || cues[cueIdx - 1].text || '') : ''}
Source: ${cues[cueIdx].text}
Context after: ${cueIdx + 1 < cues.length ? (resultCues[cueIdx + 1].translated || cues[cueIdx + 1].text || '') : ''}`;
          apiCalls++;
          const parsed = parseJsonObject(await callGeminiApi(singlePrompt, apiKey, [], 30000), 'single-cue repair');
          const rawCandidate = typeof parsed.translation === 'string'
            ? parsed.translation.trim()
            : (Array.isArray(parsed.translations) && parsed.translations[0] && typeof parsed.translations[0].translation === 'string'
              ? parsed.translations[0].translation.trim()
              : '');
          if (!rawCandidate) return;
          const cleaned = cleanTranslatedText(rawCandidate, targetLang);
          if (cleaned && !isTranslationIncomplete(cleaned, cues[cueIdx].text, targetLang) && !(targetLang === 'km' && CJK_FOREIGN_SCRIPT_RE.test(rawCandidate))) {
            resultCues[cueIdx].translated = cleaned;
            resultCues[cueIdx].translatedLang = targetLang;
            googleFallbackIndices.delete(cueIdx);
            sweptCount++;
          }
        } catch (err) {
          console.warn(`[translation] Pass 4b single-cue #${cueIdx + 1} warning:`, err.message);
        }
      });
    }
  }

  // 4c. Final throttled Google Translate rescue for any remaining leaked cues
  leakedIndices = findLeakedCueIndices();
  if (leakedIndices.length > 0) {
    await mapWithConcurrency(leakedIndices, 2, async (cueIdx) => {
      const fallbackRaw = await translateWithGoogleFallbackSafe(cues[cueIdx].text, sourceLang, targetLang, 2);
      if (!fallbackRaw) return;
      const cleaned = cleanTranslatedText(fallbackRaw, targetLang);
      if (cleaned && !isTranslationIncomplete(cleaned, cues[cueIdx].text, targetLang) && !(targetLang === 'km' && CJK_FOREIGN_SCRIPT_RE.test(fallbackRaw))) {
        resultCues[cueIdx].translated = cleaned;
        resultCues[cueIdx].translatedLang = targetLang;
        googleFallbackIndices.add(cueIdx);
        sweptCount++;
      }
    });
  }

  // 4d. Final validation: never falsely mark leaked/source-text lines as completed targetLang
  let untranslatedCount = 0;
  for (let i = 0; i < resultCues.length; i++) {
    const src = cues[i] && typeof cues[i].text === 'string' ? cues[i].text.trim() : '';
    if (!src) continue;
    const rawTr = String(resultCues[i].translated || '').trim();
    if (rawTr && !isTranslationIncomplete(rawTr, src, targetLang)) {
      resultCues[i].translated = cleanTranslatedText(rawTr, targetLang);
      resultCues[i].translatedLang = targetLang;
    } else {
      untranslatedCount++;
      delete resultCues[i].translatedLang;
      if (rawTr === src || (targetLang === 'km' && !/[\u1780-\u17FF]/.test(rawTr))) {
        resultCues[i].translated = '';
      }
    }
  }

  translatedCount = pending.filter(idx => {
    const tr = resultCues[idx] && resultCues[idx].translated;
    return tr && !isTranslationIncomplete(tr, cues[idx].text, targetLang);
  }).length + cacheHits;

  // Persist finalized, story-verified translations (excluding raw per-line Google fallback or incomplete lines)
  if (useCache) {
    for (const cueIndex of pending) {
      if (googleFallbackIndices.has(cueIndex)) continue;
      const translation = resultCues[cueIndex].translated;
      if (
        translation &&
        translation !== resultCues[cueIndex].text &&
        !isTranslationIncomplete(translation, resultCues[cueIndex].text, targetLang)
      ) {
        await translationCache.set(
          resultCues[cueIndex].text,
          translation,
          cacheSrcKey,
          targetLang,
          `${contextDigest}:${cueIndex}`
        );
      }
    }
  }

  return { cues: resultCues, translatedCount, untranslatedCount, sweptCount, cacheHits, apiCalls, storyBible };
}

router.post('/auto-cast-voices', async (req, res) => {
  const { cues, force = true, useAi: reqUseAi = true, videoPath = '', castMode = 'duo', fixedVoice = '' } = req.body || {};
  if (!Array.isArray(cues) || cues.length === 0) {
    return res.status(400).json({ success: false, error: 'មិនមានទិន្នន័យ subtitle សម្រាប់បែងចែកសំឡេងទេ។' });
  }
  const effectiveCastMode = normalizeCastMode(castMode);
  const cloned = cues.map(c => ({ ...c }));
  if (effectiveCastMode === 'single') {
    normalizeCueVoicesForCastMode(cloned, 'single', fixedVoice);
    return res.json({ success: true, cues: cloned, usedAudio: false, castMode: 'single' });
  }
  const aiVoiceMap = new Map();
  const aiEmotionMap = new Map();
  let useAi = Boolean(reqUseAi);
  let usedAudio = false;
  let audioApiKey = '';
  try {
    audioApiKey = loadConfig(req).GEMINI_API_KEY || '';
  } catch (_) {
    audioApiKey = '';
  }
  if (useAi && audioApiKey && videoPath) {
    const audioResult = await castVoicesWithAudioChunks(
      cloned,
      videoPath,
      audioApiKey,
      effectiveCastMode,
      aiVoiceMap,
      aiEmotionMap
    );
    usedAudio = audioResult.usedAudio;
    if (usedAudio && audioResult.assignedCount >= Math.max(1, Math.floor(cloned.length * 0.8))) {
      useAi = false;
    }
  }

  let apiKey = '';
  if (useAi && cloned.length <= 120) {
    try {
      apiKey = loadConfig(req).GEMINI_API_KEY || '';
    } catch (_) {
      apiKey = '';
    }
  }

  if (apiKey) {
    try {
      const scriptItems = cloned.map((c, idx) => {
        const item = {
          id: idx + 1,
          time: `${Number(c.startSec || 0).toFixed(1)}-${Number(c.endSec || 0).toFixed(1)}s`,
          source: String(c.text || '').trim(),
          khmer: String(c.translated || '').trim()
        };
        const existingSuggested = normalizeSuggestedVoice(c && c.suggestedVoice);
        if (existingSuggested) {
          item.audioHint = collapseVoiceForCastMode(existingSuggested, effectiveCastMode);
        }
        return item;
      });
      const castVoiceGuide = effectiveCastMode === 'duo'
        ? `VOICE CHOICES (STRICT 2-CHARACTER LOCK — ONLY these 2 exact IDs):
- "Radiant Queen": Female character / Woman / Wife
- "Sovereign King": Male character / Man / Husband`
        : `VOICE CHOICES — ${MULTI_CAST_VOICE_RULES}`;
      const castPrompt = `Analyze this complete short-drama scene dialogue in chronological order and assign the exact speaker voice ("voice") for every line.
${castVoiceGuide}
CRITICAL RULES:
1. If a line includes "audioHint" (detected directly from real video voice audio), RESPECT and PRESERVE that speaker's identity/gender! Never replace a speaker who starts speaking from line 1 ("audioHint") with a wrong voice/gender just by guessing text.
2. Keep the same voice ID for the same character throughout the entire scene. Do NOT switch a character's voice just because they get angry or ask a question.
3. When one character speaks 2 or 3 consecutive subtitle lines to complete a thought or argument (especially when there is 0.0-0.4s gap between cues), assign the EXACT SAME "voice" to all of those consecutive lines — do NOT blindly alternate Male/Female on every line.
4. Pay attention to forms of address: a line addressing "傅太太 / លោកស្រី / 老婆 / ប្រពន្ធសម្លាញ់" is spoken by Male ("Sovereign King") to Female; a line mentioning "女厕所 / បន្ទប់ទឹកស្រី / នាងខ្ញុំ / ចាស" or addressing "老公 / លោកប្ដី" is spoken by Female ("Radiant Queen").
Return ONLY valid JSON: {"casting":[{"id":1,"voice":"Radiant Queen"}]}
Dialogue lines:
${JSON.stringify(scriptItems)}`;
      const parsed = parseJsonObject(await callGeminiApi(castPrompt, apiKey, [], 22000), 'voice casting');
      if (Array.isArray(parsed.casting)) {
        for (const item of parsed.casting) {
          const id = Number(item && item.id);
          if (!Number.isInteger(id) || id < 1 || id > cloned.length) continue;
          const v = normalizeSuggestedVoice(item.voice);
          if (v && !aiVoiceMap.has(id)) {
            const safeVoice = resolveSafeTextCastVoice(cloned[id - 1] && cloned[id - 1].suggestedVoice, v, effectiveCastMode);
            if (safeVoice) aiVoiceMap.set(id, safeVoice);
          }
        }
      }
    } catch (castErr) {
      console.warn('[translation/auto-cast-voices] AI diarization fallback to local rules:', castErr.message);
    }
  }

  inferCharacterVoicesForCues(cloned, aiVoiceMap, Boolean(force), aiEmotionMap, { castMode: effectiveCastMode });
  res.json({ success: true, cues: cloned, usedAudio, castMode: effectiveCastMode });
});

router.get('/languages', (req, res) => {
  res.json({
    success: true,
    sourceLanguages: Object.entries(SOURCE_LANGUAGE_SPECS).map(([id, spec]) => ({ id, name: spec.name })),
    targetLanguages: ['km', 'en', 'th', 'vi', 'zh', 'ko', 'ja', 'zh-km', 'en-km']
  });
});

const inFlightTranslationJobs = new Map();

router.post('/translate-cues', async (req, res) => {
  const { cues, sourceLang = 'auto', targetLang = 'km', useCache = true, force = false, videoPath = '', castMode = 'duo', fixedVoice = '' } = req.body || {};
  const cueError = validateCueList(cues);
  if (cueError) {
    return res.status(400).json({ success: false, error: cueError });
  }
  if (!getSourceLanguage(sourceLang)) {
    return res.status(400).json({ success: false, error: 'ភាសាដើមមិនត្រឹមត្រូវ។' });
  }
  if (!getTargetLanguage(targetLang)) {
    return res.status(400).json({ success: false, error: 'ភាសាគោលដៅមិនត្រឹមត្រូវ។' });
  }
  if (typeof useCache !== 'boolean' || typeof force !== 'boolean') {
    return res.status(400).json({ success: false, error: 'ជម្រើសបកប្រែមិនត្រឹមត្រូវ។' });
  }

  let apiKey;
  try {
    apiKey = loadConfig(req).GEMINI_API_KEY;
  } catch (err) {
    console.error('[translation/translate-cues] API key error:', err.message);
    return res.status(500).json({ success: false, error: 'មិនអាចអាន Gemini API key បានទេ។' });
  }
  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'សូមបញ្ចូល Gemini API key ក្នុង Settings ជាមុនសិន។' });
  }

  try {
    const effectiveCastMode = normalizeCastMode(castMode);
    const jobKey = crypto.createHash('sha256')
      .update(`${sourceLang}->${targetLang}|${effectiveCastMode}|${fixedVoice}|${useCache}|${force}\n${cues.map(c => c.text || '').join('\n')}`)
      .digest('hex');

    let jobPromise = inFlightTranslationJobs.get(jobKey);
    if (!jobPromise) {
      jobPromise = translateWithReflection(cues, targetLang, apiKey, useCache, force, sourceLang, {
        castMode: effectiveCastMode,
        videoPath,
        fixedVoice
      });
      inFlightTranslationJobs.set(jobKey, jobPromise);
      jobPromise.finally(() => {
        if (inFlightTranslationJobs.get(jobKey) === jobPromise) {
          inFlightTranslationJobs.delete(jobKey);
        }
      }).catch(() => {});
    }

    const result = await jobPromise;
    res.json({
      success: true,
      cues: result.cues,
      sourceLang,
      targetLang,
      stats: {
        translatedCount: result.translatedCount,
        totalCount: cues.length,
        cacheHits: result.cacheHits,
        apiCalls: result.apiCalls,
        cacheHitRate: cues.length > 0
          ? `${(result.cacheHits / cues.length * 100).toFixed(1)}%`
          : '0%'
      }
    });
  } catch (err) {
    console.error('[translation/translate-cues]:', err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/ocr-frames', async (req, res) => {
  const { frames, sourceLang = 'auto' } = req.body || {};
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > OCR_BATCH_SIZE) {
    return res.status(400).json({ success: false, error: `សូមផ្ញើ frame ចន្លោះពី 1 ដល់ ${OCR_BATCH_SIZE}។` });
  }
  const srcSpec = getSourceLanguage(sourceLang);
  if (!srcSpec) {
    return res.status(400).json({ success: false, error: 'ភាសាដើមមិនត្រឹមត្រូវ។' });
  }

  let totalBase64Length = 0;
  for (const frame of frames) {
    if (!frame || typeof frame.imageBase64 !== 'string' ||
        !Number.isFinite(frame.timeSec) || frame.timeSec < 0 ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(frame.mimeType || 'image/jpeg') ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.imageBase64)) {
      return res.status(400).json({ success: false, error: 'ទិន្នន័យ frame ឬរូបភាពមិនត្រឹមត្រូវ។' });
    }
    totalBase64Length += frame.imageBase64.length;
  }
  if (totalBase64Length > 10 * 1024 * 1024) {
    return res.status(413).json({ success: false, error: 'ទំហំរូបភាពធំពេក។' });
  }

  let apiKey;
  try {
    apiKey = loadConfig(req).GEMINI_API_KEY;
  } catch (err) {
    console.error('[translation/ocr-frames] API key error:', err.message);
    return res.status(500).json({ success: false, error: 'មិនអាចអាន Gemini API key បានទេ។' });
  }
  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'សូមបញ្ចូល Gemini API key ក្នុង Settings ជាមុនសិន។' });
  }

  try {
    const imageParts = [];
    frames.forEach((frame, index) => {
      imageParts.push({ text: `Frame ${index + 1}, timestamp ${frame.timeSec.toFixed(3)} seconds:` });
      imageParts.push({
        inline_data: {
          mime_type: frame.mimeType || 'image/jpeg',
          data: frame.imageBase64
        }
      });
    });
    const prompt = `Read only the visible hardcoded ${srcSpec.ocrHint} subtitle text in each supplied video frame.
Ignore logos, signs, UI, and other scene text. If a frame has no subtitle text, return an empty string for it.
Preserve original characters and line breaks as accurately as possible. Do not infer text that is not visible.
Return only JSON with exactly one result per input frame, in the same order:
{"frames":[{"frame":1,"text":"..."},{"frame":2,"text":""}]}`;
    const parsed = parseJsonObject(await callGeminiApi(prompt, apiKey, imageParts), 'OCR');
    if (!Array.isArray(parsed.frames)) {
      throw new Error('Gemini returned an incomplete OCR result.');
    }
    const frameTextByIndex = new Map();
    parsed.frames.forEach((item, idx) => {
      if (!item || typeof item.text !== 'string') return;
      const frameNum = Number(item.frame);
      const targetIdx = Number.isInteger(frameNum) && frameNum >= 1 && frameNum <= frames.length
        ? frameNum - 1
        : idx;
      frameTextByIndex.set(targetIdx, decodeUnicodeEscapes(item.text).trim());
    });
    res.json({
      success: true,
      frames: frames.map((frame, index) => ({
        frameIndex: index,
        timeSec: frame.timeSec,
        text: frameTextByIndex.get(index) || ''
      }))
    });
  } catch (err) {
    console.error('[translation/ocr-frames]:', err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/auto-detect-speech', async (req, res) => {
  const {
    videoPath,
    sourceLang = 'auto',
    isolateVocals = true,
    chunkDurationSec = DEFAULT_SPEECH_CHUNK_SEC
  } = req.body || {};
  if (typeof videoPath !== 'string' || !videoPath.trim() || videoPath.length > 4096) {
    return res.status(400).json({ success: false, error: 'ផ្លូវវីដេអូមិនត្រឹមត្រូវ។' });
  }
  if (!path.isAbsolute(videoPath)) {
    return res.status(400).json({ success: false, error: 'សូមជ្រើសរើសវីដេអូពីទីតាំងឯកសារពិត។' });
  }
  const srcSpec = getSourceLanguage(sourceLang);
  if (!srcSpec) {
    return res.status(400).json({ success: false, error: 'ភាសាដើមមិនត្រឹមត្រូវ។' });
  }

  const normalizedVideoPath = path.normalize(videoPath);
  let videoStats;
  try {
    videoStats = fs.statSync(normalizedVideoPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ success: false, error: 'រកមិនឃើញឯកសារវីដេអូទេ។' });
    }
    console.error('[translation/auto-detect-speech] Video file error:', err.message);
    return res.status(500).json({ success: false, error: 'មិនអាចអានឯកសារវីដេអូបានទេ។' });
  }
  if (!videoStats.isFile()) {
    return res.status(400).json({ success: false, error: 'ផ្លូវដែលបានជ្រើសមិនមែនជាឯកសារទេ។' });
  }

  let apiKey;
  try {
    apiKey = loadConfig(req).GEMINI_API_KEY;
  } catch (err) {
    console.error('[translation/auto-detect-speech] API key error:', err.message);
    return res.status(500).json({ success: false, error: 'មិនអាចអាន Gemini API key បានទេ។' });
  }
  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'សូមបញ្ចូល Gemini API key ក្នុង Settings ជាមុនសិន។' });
  }

  let tempDirectory;
  let stage = 'audio extraction';
  try {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-speech-'));
    const chunks = await extractSpeechAudioChunks(normalizedVideoPath, tempDirectory, {
      chunkDurationSec,
      isolateVocals: Boolean(isolateVocals)
    });

    if (chunks.length === 0) {
      return res.status(422).json({ success: false, error: 'រកមិនឃើញសំឡេងក្នុងវីដេអូទេ។' });
    }

    const effectiveCastMode = normalizeCastMode(req.body && req.body.castMode);
    const fixedVoice = collapseVoiceForCastMode(req.body && req.body.fixedVoice, 'single', req.body && req.body.fixedVoice);
    // Keep full multi-archetype labels (e.g., kh_elder_woman) during STT even in Duo mode,
    // so older women are detected as Female before cue.voice collapses cleanly for Duo.
    const detectSpeechCastMode = effectiveCastMode === 'single' ? 'single' : 'multi';
    const speechVoiceRules = detectSpeechCastMode === 'single'
      ? `locked single narrator "voice" — output ONLY "${fixedVoice}" for EVERY segment (do NOT switch speaker voice)`
      : (detectSpeechCastMode === 'duo'
        ? `speaker "voice" (STRICT 2-CHARACTER DUO LOCK — output ONLY ONE of these 2 IDs based on the real human gender/pitch you hear):
- "Radiant Queen" (Female / Woman speaker)
- "Sovereign King" (Male / Man speaker)
Keep the SAME speaker on the EXACT SAME voice ID from start to finish (never split one person into multiple voices when their emotion changes).`
        : `speaker "voice" — ${MULTI_CAST_VOICE_RULES}
CRITICAL: A single speaking character MUST keep the exact same voice ID across ALL of their lines, even when angry, whispering, or crying. Keep total episode cast compact (usually 2-4 speakers max).`);

    const chunkPayloads = [];
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx];
      const audio = fs.readFileSync(chunk.audioPath);
      if (audio.length === 0) continue;
      if (audio.length > MAX_SPEECH_AUDIO_BYTES) {
        return res.status(413).json({
          success: false,
          error: 'សំឡេងវែងពេកសម្រាប់ដំណើរការមួយលើក។ សូមបំបែកវីដេអូជាផ្នែកខ្លីៗ។'
        });
      }
      chunkPayloads.push({ chunk, audioBase64: audio.toString('base64') });
    }

    stage = 'Gemini transcription';
    const speechPrompt = `Transcribe EVERY SINGLE spoken dialogue line, phrase, question, exclamation, or short reply in this video audio in ${srcSpec.speechHint}.
${srcSpec.name === 'Chinese' ? 'Output strictly in Simplified Chinese characters (简体中文) — NEVER switch mid-video to Traditional Chinese, and transcribe character names, numbers, and idioms accurately from context.' : ''}
Do NOT skip any spoken utterance, even if it is short (1-2 words), quiet, emotional, or spoken over background music.
Do not translate, summarize, or invent dialogue. Ignore pure instrumental music and non-vocal sound effects.
Split continuous speech into readable subtitle segments. For each segment, give accurate startSec (when the voice begins speaking), endSec (when the voice completely finishes the phrase), and ${speechVoiceRules}.
Return only valid JSON in this exact shape:
{"segments":[{"startSec":1.25,"endSec":2.8,"text":"...","voice":"Radiant Queen"}]}
If there is no intelligible speech, return {"segments":[]}.`;

    const speechKeyCount = getGeminiApiKeyCandidates(apiKey, `api:${preferredGeminiModel}`).length;
    const segmentsByChunk = new Array(chunkPayloads.length).fill(null).map(() => []);
    const processSpeechChunk = async (payloadIdx, extraRosterPrompt = '') => {
      const { chunk, audioBase64 } = chunkPayloads[payloadIdx];
      const promptWithRoster = extraRosterPrompt ? `${speechPrompt}\n\n${extraRosterPrompt}` : speechPrompt;
      const response = await callGeminiApi(promptWithRoster, apiKey, [{
        inline_data: {
          mime_type: 'audio/mp3',
          data: audioBase64
        }
      }], SPEECH_REQUEST_TIMEOUT_MS);
      const parsed = parseJsonObject(response, 'speech transcription');
      if (!Array.isArray(parsed.segments)) {
        throw new Error('Gemini returned an invalid number of speech segments.');
      }
      for (const segment of parsed.segments) {
        if (!segment || typeof segment.text !== 'string') continue;
        const cleanSegText = decodeUnicodeEscapes(segment.text).trim();
        if (!cleanSegText) continue;
        const rawStart = Number(segment.startSec);
        const rawEnd = Number(segment.endSec);
        if (!Number.isFinite(rawStart) || rawStart < 0) continue;
        const safeEnd = Number.isFinite(rawEnd) && rawEnd > rawStart ? rawEnd : rawStart + 1.4;
        segmentsByChunk[payloadIdx].push({
          startSec: Number(Math.max(0, rawStart + chunk.offsetSec - 0.05).toFixed(3)),
          endSec: Number((safeEnd + chunk.offsetSec + 0.15).toFixed(3)),
          text: cleanSegText.slice(0, MAX_CUE_TEXT_LENGTH),
          suggestedVoice: normalizeSuggestedVoice(segment.voice)
        });
      }
    };

    if (chunkPayloads.length === 1) {
      await processSpeechChunk(0, '');
    } else if (chunkPayloads.length > 1) {
      // Process Part 1 first so character names, Simplified script, and voice IDs lock across all 60s chunks
      await processSpeechChunk(0, '');
      const part1Continuity = [
        effectiveCastMode !== 'single' ? buildEstablishedCastRoster(segmentsByChunk[0]) : '',
        buildTranscriptContinuityContext(segmentsByChunk[0], srcSpec)
      ].filter(Boolean).join('\n\n');
      const remainingIndices = Array.from({ length: chunkPayloads.length - 1 }, (_, k) => k + 1);
      const speechConcurrency = Math.min(6, Math.max(2, speechKeyCount), remainingIndices.length || 1);
      let remCursor = 0;
      const speechWorkers = Array.from({ length: speechConcurrency }, async () => {
        while (remCursor < remainingIndices.length) {
          const payloadIdx = remainingIndices[remCursor++];
          await processSpeechChunk(payloadIdx, part1Continuity);
        }
      });
      await Promise.all(speechWorkers);
    }
    const allSegments = segmentsByChunk.flat();

    if (allSegments.length === 0) {
      return res.status(422).json({ success: false, error: 'មិនបានរកឃើញពាក្យនិយាយច្បាស់ទេ។ សូមពិនិត្យសំឡេង ឬនាំចូល SRT។' });
    }

    allSegments.sort((a, b) => a.startSec - b.startSec);
    const limitedSegments = allSegments.slice(0, MAX_CUES);

    for (let i = 0; i < limitedSegments.length; i++) {
      const seg = limitedSegments[i];
      const nextSeg = limitedSegments[i + 1];
      const minDur = Math.max(1.2, Math.min(3.5, seg.text.length * 0.08));
      if (seg.endSec - seg.startSec < minDur) {
        seg.endSec = nextSeg
          ? Math.max(seg.endSec, Math.min(seg.startSec + minDur, nextSeg.startSec - 0.05))
          : Number((seg.startSec + minDur).toFixed(3));
      }
      if (nextSeg && seg.endSec > nextSeg.startSec - 0.03) {
        seg.endSec = Math.max(seg.startSec + 0.3, Number((nextSeg.startSec - 0.03).toFixed(3)));
      }
    }

    const detectedVoiceMap = new Map();
    const cues = limitedSegments.map((segment, index) => {
      const start = secondsToSrtTime(segment.startSec);
      const end = secondsToSrtTime(segment.endSec);
      const rawSuggested = effectiveCastMode === 'single' ? fixedVoice : normalizeSuggestedVoice(segment.suggestedVoice);
      const collapsed = rawSuggested || 'Sovereign King';
      if (rawSuggested) detectedVoiceMap.set(index + 1, collapsed);
      return {
        index: index + 1,
        start: secondsToDisplayTime(segment.startSec),
        end: secondsToDisplayTime(segment.endSec),
        startSec: segment.startSec,
        endSec: segment.endSec,
        timecode: `${start} --> ${end}`,
        text: segment.text,
        translated: segment.text,
        voice: collapsed,
        suggestedVoice: rawSuggested ? collapsed : ''
      };
    });

    inferCharacterVoicesForCues(cues, detectedVoiceMap, true, new Map(), { castMode: effectiveCastMode, fixedVoice });

    return res.json({
      success: true,
      cues,
      chunkCount: chunks.length,
      sourceLang
    });
  } catch (err) {
    console.error(`[translation/auto-detect-speech] ${stage} error:`, err.message);
    const status = stage === 'Gemini transcription' ? 502 : 500;
    return res.status(status).json({
      success: false,
      error: stage === 'Gemini transcription'
        ? err.message
        : 'មិនអាចដកសំឡេងពីវីដេអូបានទេ។ សូមពិនិត្យ FFmpeg និងឯកសារវីដេអូ។'
    });
  } finally {
    if (tempDirectory) {
      try {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
      } catch (err) {
        console.error('[translation/auto-detect-speech] Temporary audio cleanup failed:', err.message);
      }
    }
  }
});

router.get('/router-mode', (req, res) => {
  const mode = getRouterModelMode();
  res.json({
    success: true,
    mode,
    primaryModel: mode === 'smart' ? HYDROGEN_MODEL : GEMINI_MODEL,
    thinkingLevel: mode === 'smart' ? (process.env.GEMINI_4_THINKING_LEVEL || 'low') : 'none',
    fallbackModels: GEMINI_FALLBACK_MODELS
  });
});

router.post('/router-mode', (req, res) => {
  const requested = req.body && typeof req.body.mode === 'string' ? req.body.mode.trim().toLowerCase() : '';
  if (requested !== 'fast' && requested !== 'smart') {
    return res.status(400).json({ success: false, error: 'Router mode must be "fast" or "smart".' });
  }
  const status = setRouterModelMode(requested);
  console.log(`[translation/router-mode] Switched router model mode to "${status.mode}" (${status.primaryModel})`);
  return res.json({
    success: true,
    ...status,
    fallbackModels: GEMINI_FALLBACK_MODELS
  });
});

router.get('/chuon-nath-stats', (req, res) => {
  try {
    return res.json({
      success: true,
      ...getChuonNathStats()
    });
  } catch (err) {
    console.error('[translation/chuon-nath-stats]:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/chuon-nath-check', (req, res) => {
  if (!req.body || typeof req.body.text !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing text string' });
  }
  try {
    const audit = auditKhmerAgainstChuonNath(req.body.text);
    return res.json({
      success: true,
      normalized: audit.normalizedText,
      audit
    });
  } catch (err) {
    console.error('[translation/chuon-nath-check]:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/clear-cache', (req, res) => {
  try {
    translationCache.clear();
    res.json({ success: true, message: 'Translation cache cleared' });
  } catch (err) {
    console.error('[translation/clear-cache]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.getSourceLanguage = getSourceLanguage;
router.getTargetLanguage = getTargetLanguage;
router.getPromptLanguageMeta = getPromptLanguageMeta;
router.extractSpeechAudio = extractSpeechAudio;
router.extractSpeechAudioChunks = extractSpeechAudioChunks;
router.normalizeCastMode = normalizeCastMode;
router.collapseVoiceForCastMode = collapseVoiceForCastMode;
router.normalizeCueVoicesForCastMode = normalizeCueVoicesForCastMode;
router.inferCharacterVoicesForCues = inferCharacterVoicesForCues;
router.GEMINI_MODEL = GEMINI_MODEL;
router.GEMINI_FALLBACK_MODELS = GEMINI_FALLBACK_MODELS;
router.SPEECH_VOCAL_FILTER = SPEECH_VOCAL_FILTER;
router.buildGeminiGenerationConfig = buildGeminiGenerationConfig;
router.getGeminiTimeoutMs = getGeminiTimeoutMs;
router.getRouterModelMode = getRouterModelMode;
router.setRouterModelMode = setRouterModelMode;
router.parseJsonObject = parseJsonObject;
router.normalizeKhmerSpacing = normalizeKhmerSpacing;
router.normalizeKhmerChuonNath = normalizeKhmerChuonNath;
router.isChuonNathWord = isChuonNathWord;
router.segmentKhmerWithChuonNath = segmentKhmerWithChuonNath;
router.auditKhmerAgainstChuonNath = auditKhmerAgainstChuonNath;
router.getChuonNathStats = getChuonNathStats;
router.hasCorruptedKhmerText = hasCorruptedKhmerText;
router.cleanTranslatedText = cleanTranslatedText;
router.isTranslationIncomplete = isTranslationIncomplete;
router.formatStoryBibleForPrompt = formatStoryBibleForPrompt;
router.buildEpisodeStoryBible = buildEpisodeStoryBible;
router.reflectOnEpisodeTranslations = reflectOnEpisodeTranslations;
router.resolveDraftCueId = resolveDraftCueId;
router.translateWithReflection = translateWithReflection;

module.exports = router;
