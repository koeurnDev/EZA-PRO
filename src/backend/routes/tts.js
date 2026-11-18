/**
 * ⚡ EZA PRO - Text-to-Speech Routes
 * Generate Khmer voice audio using Edge TTS
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');
const { FFMPEG_BIN, parseMp3DurationFast, renameFileSafe } = require('../utils/ffmpeg');
const voiceCloner = require('../utils/voice-cloner');
const audioRouter = require('./audio');
require('../utils/dns-fix');

const EMOTION_PRESETS = [];
const EMOTION_MAP = new Map();

function normalizeEmotionId() {
  return 'auto';
}

function detectEmotionFromText() {
  return 'auto';
}

const MAX_CONCURRENT_TTS = 24;

function createConcurrencyLimiter(maxConcurrent) {
  let activeCount = 0;
  const waitQueue = [];
  return function enqueue(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        activeCount++;
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        } finally {
          activeCount--;
          if (waitQueue.length > 0) {
            const next = waitQueue.shift();
            if (next) next();
          }
        }
      };
      if (activeCount < maxConcurrent) {
        run();
      } else {
        waitQueue.push(run);
      }
    });
  };
}

const enqueueTtsTask = createConcurrencyLimiter(MAX_CONCURRENT_TTS);
const enqueueSeedVcTask = createConcurrencyLimiter(1);

function normalizeSpokenTextAndLang(cleanText, spec, options = {}) {
  let spoken = String(cleanText || '').trim();
  const strictVoice = options.strictVoice !== false;
  // If bilingual "Source | Khmer", speak the Khmer part if present
  if (spoken.includes('|')) {
    const parts = spoken.split('|').map(s => s.trim()).filter(Boolean);
    const khmerPart = parts.find(p => /[\u1780-\u17FF]/.test(p));
    if (khmerPart) {
      spoken = khmerPart;
    } else if (parts.length > 1) {
      spoken = parts[parts.length - 1];
    }
  }

  const isFemale = String(spec.voice || '').includes('Sreymom') || String(spec.voice || '').includes('Queen');
  const hasKhmer = /[\u1780-\u17FF]/.test(spoken);

  if (hasKhmer) {
    return { spoken, edgeVoice: spec.voice, googleLang: 'km' };
  }

  // Edge Khmer Neural voices natively read English/Latin words and digits without switching speaker identity.
  const isExplicitForeignVoice = Boolean(
    spec &&
    spec.voice &&
    !/^km-/i.test(spec.voice) &&
    /^[a-z]{2,3}-[a-z]{2}-.+neural$/i.test(String(spec.voice))
  );
  if (isExplicitForeignVoice) {
    const voiceLang = String(spec.voice).split('-')[0].toLowerCase() || 'en';
    return { spoken, edgeVoice: spec.voice, googleLang: voiceLang };
  }

  const hasForeignNonLatinScript = /[\u3040-\u30FF\uAC00-\uD7AF\u4E00-\u9FFF\u0E00-\u0E7FăâđêôơưĂÂĐÊÔƠƯáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/.test(spoken);
  if (!hasForeignNonLatinScript) {
    const fallbackLang = String(spec.voice || 'km-KH').split('-')[0] || 'km';
    return { spoken, edgeVoice: spec.voice, googleLang: fallbackLang };
  }

  if (strictVoice) {
    const err = new Error('បន្ទាត់នេះមានតែអក្សរបរទេស មិនទាន់បកប្រែជាខ្មែរទេ — សូមបកប្រែជាខ្មែរជាមុនដើម្បីកុំឲ្យឆ្លងសំឡេងបរទេសចូល។');
    err.statusCode = 422;
    throw err;
  }

  if (/[\u3040-\u30FF]/.test(spoken)) {
    return { spoken, edgeVoice: isFemale ? 'ja-JP-NanamiNeural' : 'ja-JP-KeitaNeural', googleLang: 'ja' };
  }
  if (/[\uAC00-\uD7AF]/.test(spoken)) {
    return { spoken, edgeVoice: isFemale ? 'ko-KR-SunHiNeural' : 'ko-KR-InJoonNeural', googleLang: 'ko' };
  }
  if (/[\u4E00-\u9FFF]/.test(spoken)) {
    return { spoken, edgeVoice: isFemale ? 'zh-CN-XiaoxiaoNeural' : 'zh-CN-YunxiNeural', googleLang: 'zh-CN' };
  }
  if (/[\u0E00-\u0E7F]/.test(spoken)) {
    return { spoken, edgeVoice: isFemale ? 'th-TH-PremwadeeNeural' : 'th-TH-NiwatNeural', googleLang: 'th' };
  }
  if (/[ăâđêôơưĂÂĐÊÔƠƯáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/.test(spoken)) {
    return { spoken, edgeVoice: isFemale ? 'vi-VN-HoaiMyNeural' : 'vi-VN-NamMinhNeural', googleLang: 'vi' };
  }
  const fallbackLang = String(spec.voice || 'km-KH').split('-')[0] || 'km';
  return { spoken, edgeVoice: spec.voice, googleLang: fallbackLang };
}

function fetchGoogleTtsBuffer(text, langCode = 'km') {
  return new Promise((resolve, reject) => {
    const query = encodeURIComponent(text.slice(0, 200));
    const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(langCode)}&client=tw-ob&q=${query}`;
    const req = https.get(url, {
      family: 4,
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Google TTS fallback status ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Google TTS stream aborted')));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(12000, () => req.destroy(new Error('Google TTS request timed out')));
    req.on('error', reject);
  });
}

async function synthesizeGoogleFallback(cleanText, spec, audioFile, langOverride = null) {
  const detected = normalizeSpokenTextAndLang(cleanText, spec, { strictVoice: false });
  const voiceLang = langOverride || detected.googleLang || 'km';
  // Split text into <= 160 char chunks for Google TTS
  const parts = [];
  let remaining = detected.spoken.trim();
  while (remaining.length > 0) {
    if (remaining.length <= 160) {
      parts.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf(' ', 160);
    if (splitIdx < 30) {
      const punctOffset = remaining.slice(0, 160).search(/[។！？!?，,.\s][^\s។！？!?，,.]*$/);
      splitIdx = punctOffset >= 0 ? punctOffset + 1 : -1;
    }
    if (splitIdx < 20) {
      splitIdx = 160;
      while (splitIdx > 20 && (/[\u17B6-\u17D3\u17DD]/.test(remaining[splitIdx]) || remaining[splitIdx - 1] === '\u17D2')) {
        splitIdx--;
      }
      if (splitIdx <= 20) splitIdx = 160;
    }
    parts.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }
  const buffers = [];
  for (const part of parts) {
    if (!part) continue;
    let buf = null;
    for (let retry = 0; retry < 2; retry++) {
      try {
        buf = await fetchGoogleTtsBuffer(part, voiceLang);
        if (buf && buf.length > 32) break;
      } catch (e) {
        if (retry === 1) throw e;
        await new Promise(r => setTimeout(r, 250));
      }
    }
    if (buf) buffers.push(buf);
  }
  const combined = Buffer.concat(buffers);
  if (combined.length < MIN_VALID_AUDIO_BYTES) {
    throw new Error('Fallback TTS returned empty audio');
  }

  // If pitch/rate preset is non-zero and ffmpeg is available, shape pitch/tempo
  const uniqueTag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
  if ((spec.pitchNum !== 0 || spec.rateNum !== 0) && FFMPEG_BIN) {
    const rawTmp = `${audioFile}.${uniqueTag}.raw.mp3`;
    const shapedTmp = `${audioFile}.${uniqueTag}.shaped.tmp.mp3`;
    fs.writeFileSync(rawTmp, combined);
    try {
      const pitchRatio = Math.max(0.7, Math.min(1.4, 1 + (spec.pitchNum / 100)));
      const rateRatio = Math.max(0.7, Math.min(1.5, 1 + (spec.rateNum / 100)));
      const atempo = Math.max(0.5, Math.min(2.0, rateRatio / pitchRatio));
      const filter = `asetrate=24000*${pitchRatio.toFixed(3)},aresample=24000,atempo=${atempo.toFixed(3)}`;
      await new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG_BIN, ['-y', '-i', rawTmp, '-af', filter, '-c:a', 'libmp3lame', '-q:a', '4', shapedTmp], { windowsHide: true });
        if (proc.stdout) proc.stdout.resume();
        if (proc.stderr) proc.stderr.resume();
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
        proc.on('error', reject);
      });
      await renameFileSafe(shapedTmp, audioFile);
      try { fs.unlinkSync(rawTmp); } catch (_) { }
      return;
    } catch (_) {
      try { fs.unlinkSync(rawTmp); } catch (e) { }
      try { fs.unlinkSync(shapedTmp); } catch (e) { }
    }
  }
  const directTmp = `${audioFile}.${uniqueTag}.direct.tmp.mp3`;
  fs.writeFileSync(directTmp, combined);
  try {
    await renameFileSafe(directTmp, audioFile);
  } catch (err) {
    try { if (fs.existsSync(directTmp)) fs.unlinkSync(directTmp); } catch (_) { }
    throw err;
  }
}

const KHMER_TTS_ACRONYMS = {
  DNA: 'ឌីអិនអេ',
  VIP: 'វីអាយភី',
  CEO: 'ស៊ីអ៊ីអូ',
  CCTV: 'ស៊ីស៊ីធីវី',
  GPS: 'ជីភីអេស',
  ATM: 'អេធីអឹម',
  SMS: 'អេសអឹមអេស',
  PDF: 'ភីឌីអេហ្វ',
  QR: 'ខ្យូអរ'
};

function enhanceDramaticSpokenText(text) {
  let s = String(text || '').trim();
  if (!s) return s;
  // Convert stiff formal phrases into natural spoken Khmer cadence if present
  // and strip thousands-grouping commas inside numbers so EdgeTTS speaks them seamlessly.
  s = s.replace(/(?<=[0-9\u17E0-\u17E9]),(?=[0-9\u17E0-\u17E9]{3}(?![0-9\u17E0-\u17E9]))/g, '');
  if (/[\u1780-\u17FF]/.test(s)) {
    s = s
      .replace(/ម៉ោង\s*([0-9\u17E0-\u17E9]{1,2}):(?:00|០០)(?![0-9\u17E0-\u17E9])/g, 'ម៉ោង $1 គត់')
      .replace(/ម៉ោង\s*([0-9\u17E0-\u17E9]{1,2}):(?:30|៣០)(?![0-9\u17E0-\u17E9])/g, 'ម៉ោង $1 កន្លះ')
      .replace(/ម៉ោង\s*([0-9\u17E0-\u17E9]{1,2}):([0-9\u17E0-\u17E9]{2})(?![0-9\u17E0-\u17E9])/g, 'ម៉ោង $1 និង $2 នាទី')
      .replace(/([0-9\u17E0-\u17E9]+(?:\.[0-9\u17E0-\u17E9]+)?)\s*%/g, '$1 ភាគរយ')
      .replace(/\$\s*([0-9\u17E0-\u17E9]+(?:\.[0-9\u17E0-\u17E9]+)?)/g, '$1 ដុល្លារ')
      .replace(/(?:¥|￥)\s*([0-9\u17E0-\u17E9]+(?:\.[0-9\u17E0-\u17E9]+)?)/g, '$1 យ័ន')
      .replace(/(?<![A-Za-z])(DNA|VIP|CEO|CCTV|GPS|ATM|SMS|PDF|QR)(?![A-Za-z])/g, (_, code) => KHMER_TTS_ACRONYMS[code] || code);
  }
  s = s
    .replace(/ឬអត់\s*[?？]/g, 'ទេអ្ហី?')
    .replace(/មែនឬទេ\s*[?？]/g, 'មែនទេ?')
    .replace(/\s+។\s+/g, ', ')
    .replace(/។(?=\S)/g, ', ');
  return s.replace(/\s{2,}/g, ' ').trim();
}

function computeExpressiveProsody(spokenText, spec) {
  const isFemale = String(spec.voice || '').includes('Sreymom') || String(spec.voice || '').includes('Queen');
  const rawSpecPitch = Number(spec.pitchNum) || 0;
  const rawSpecRate = Number(spec.rateNum) || 0;

  // Edge Neural only has 2 native Khmer voices (Piseth & Sreymom). Extreme SSML
  // pitch shifts (+14Hz..+36Hz / -12Hz..-21Hz) distort neural vocoders, so compress
  // preset pitch into a safe fixed range per character without any emotion drift.
  let pitchNum = rawSpecPitch === 0
    ? (isFemale ? 2 : -2)
    : Math.round(rawSpecPitch * 0.3);

  // Give baseline 0-rate voices a natural conversational drama pace (+6%) instead of slow textbook reading
  let rateNum = rawSpecRate === 0
    ? 6
    : Math.round(rawSpecRate * 0.75);

  pitchNum = Math.round(Math.min(10, Math.max(-8, pitchNum)));
  rateNum = Math.round(Math.min(16, Math.max(-12, rateNum)));

  return {
    pitchNum,
    rateNum,
    pitchStr: pitchNum >= 0 ? `+${pitchNum}Hz` : `${pitchNum}Hz`,
    rateStr: rateNum >= 0 ? `+${rateNum}%` : `${rateNum}%`
  };
}

async function synthesizeEdgeWithFallback(cleanText, spec, audioFile, options = {}) {
  return enqueueTtsTask(async () => {
    const strictVoice = options.strictVoice !== false;
    const allowGoogleFallback = Boolean(options.allowGoogleFallback) && !strictVoice;
    const fallbackAudioFile = options.fallbackAudioFile || audioFile;
    const detected = normalizeSpokenTextAndLang(cleanText, spec, { strictVoice });
    const dramaticSpoken = enhanceDramaticSpokenText(detected.spoken);
    const expressive = computeExpressiveProsody(dramaticSpoken, spec);
    let lastErr = null;
    if (EdgeTTS) {
      for (let attempt = 0; attempt < 4; attempt++) {
        let timer = null;
        let timedOut = false;
        const attemptTmp = `${fallbackAudioFile}.att${attempt}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp.mp3`;
        try {
          if (attempt > 0) {
            const is429 = /429|status 429|too many/i.test(String(lastErr && lastErr.message || ''));
            const backoffMs = is429
              ? (500 * Math.pow(2, attempt) + Math.floor(Math.random() * 300))
              : (250 * attempt);
            await new Promise(r => setTimeout(r, backoffMs));
          }
          const tts = new EdgeTTS();
          const synthWork = (async () => {
            const hasExplicitProsody = spec && (spec.pitchNum !== 0 || spec.rateNum !== 0);
            const pitchParam = hasExplicitProsody ? spec.pitchStr : expressive.pitchStr;
            const rateParam = hasExplicitProsody ? spec.rateStr : expressive.rateStr;
            if (pitchParam !== '+0Hz' || rateParam !== '+0%') {
              await tts.synthesize(dramaticSpoken, detected.edgeVoice, {
                pitch: pitchParam,
                rate: rateParam
              });
            } else {
              await tts.synthesize(dramaticSpoken, detected.edgeVoice);
            }
            if (timedOut) return;
            await tts.toFile(attemptTmp);
            if (timedOut) {
              try { if (fs.existsSync(attemptTmp)) fs.unlinkSync(attemptTmp); } catch (_) { }
            }
          })().catch((lateErr) => {
            try { if (fs.existsSync(attemptTmp)) fs.unlinkSync(attemptTmp); } catch (_) { }
            if (!timedOut) throw lateErr;
          });
          await Promise.race([
            synthWork,
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                try {
                  if (tts.ws && typeof tts.ws.terminate === 'function') tts.ws.terminate();
                  else if (tts.ws && typeof tts.ws.close === 'function') tts.ws.close();
                } catch (_) { }
                reject(new Error('EdgeTTS synthesis timeout'));
              }, 10000);
            })
          ]);
          const stat = fs.existsSync(attemptTmp) ? fs.statSync(attemptTmp) : null;
          if (!stat || stat.size <= MIN_VALID_AUDIO_BYTES) {
            throw new Error('EdgeTTS wrote empty audio file');
          }
          await renameFileSafe(attemptTmp, fallbackAudioFile);
          return { actualEngine: 'edge', fallback: false, edgeVoice: detected.edgeVoice };
        } catch (err) {
          lastErr = err;
          try { if (fs.existsSync(attemptTmp)) fs.unlinkSync(attemptTmp); } catch (_) { }
          if (/Voices are locale specific/i.test(String(err && err.message || ''))) {
            break;
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    }
    if (!allowGoogleFallback) {
      const reason = lastErr && lastErr.message ? lastErr.message : 'Edge Neural TTS unavailable';
      throw new Error(`សំឡេង ${detected.edgeVoice} បរាជ័យ (${reason}) — បានបិទ Google Fallback ដើម្បីការពារកុំឲ្យឆ្លងសំឡេងផ្សេងចូល`);
    }
    console.warn(`[tts] EdgeTTS failed (${lastErr && lastErr.message}), using explicit non-strict Google fallback (${detected.googleLang})...`);
    await synthesizeGoogleFallback(dramaticSpoken, spec, fallbackAudioFile, detected.googleLang);
    return { actualEngine: 'google', fallback: true, edgeVoice: detected.edgeVoice };
  });
}

const DEFAULT_VOICE = 'km-KH-PisethNeural';
const MIN_VALID_AUDIO_BYTES = 100;

function getAudioCacheDir() {
  const dir = process.env.AUDIO_CACHE_DIR || path.join(__dirname, '..', '..', '..', 'audio_cache');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Ensure default/configured audio cache directory exists on load
getAudioCacheDir();

// Load Edge TTS module
let EdgeTTS;
try {
  EdgeTTS = require('@andresaya/edge-tts').EdgeTTS;
} catch (_) {
  console.warn('⚠️  EdgeTTS module not available - TTS will not work');
}

const KHMER_VOICE_PRESETS = [
  {
    id: 'Sovereign King',
    name: 'km-KH-PisethNeural',
    baseVoice: 'km-KH-PisethNeural',
    pitch: 0,
    rate: 0,
    gender: 'Male',
    language: 'Khmer (Cambodia)',
    label: '🎙️ ពិសិទ្ធ · បុរសធម្មតា (Piseth)',
    description: 'ភាសារបស់បុរស (ធម្មតា)'
  },
  {
    id: 'Radiant Queen',
    name: 'km-KH-SreymomNeural',
    baseVoice: 'km-KH-SreymomNeural',
    pitch: 0,
    rate: 0,
    gender: 'Female',
    language: 'Khmer (Cambodia)',
    label: '🎙️ ស្រីមុំ · ស្ត្រីធម្មតា (Sreymom)',
    description: 'ភាសារបស់ស្រី (ធម្មតា)'
  },
  {
    id: 'kh_narrator_fast',
    name: 'kh_narrator_fast',
    baseVoice: 'km-KH-PisethNeural',
    pitch: 4,
    rate: 18,
    gender: 'Male',
    language: 'Khmer (Cambodia)',
    label: '⚡ និទានរឿង TikTok (លឿន)',
    description: 'សង្ខេបរឿង / TikTok Recap'
  },
  {
    id: 'kh_young_man',
    name: 'kh_young_man',
    baseVoice: 'km-KH-PisethNeural',
    pitch: 14,
    rate: 6,
    gender: 'Male',
    language: 'Khmer (Cambodia)',
    label: '🧑 យុវជន (ក្មេង ស្រស់ថ្លា)',
    description: 'តួប្រុសវ័យក្មេង'
  },
  {
    id: 'kh_deep_boss',
    name: 'kh_deep_boss',
    baseVoice: 'km-KH-PisethNeural',
    pitch: -16,
    rate: -8,
    gender: 'Male',
    language: 'Khmer (Cambodia)',
    label: '🧔 លោកប្រធាន / លោកតា (ធ្ងន់)',
    description: 'តួអង្គចាស់ / អ្នកមានអំណាច'
  },
  {
    id: 'kh_young_girl',
    name: 'kh_young_girl',
    baseVoice: 'km-KH-SreymomNeural',
    pitch: 16,
    rate: 8,
    gender: 'Female',
    language: 'Khmer (Cambodia)',
    label: '👧 យុវតី / ក្មេងស្រី (ស្រស់ស្រាយ)',
    description: 'តួស្រីវ័យក្មេង'
  },
  {
    id: 'kh_child',
    name: 'kh_child',
    baseVoice: 'km-KH-SreymomNeural',
    pitch: 30,
    rate: 10,
    gender: 'Female',
    language: 'Khmer (Cambodia)',
    label: '🧒 កូនក្មេង (តូច គួរឲ្យស្រឡាញ់)',
    description: 'សំឡេងក្មេងតូច'
  },
  {
    id: 'kh_elder_woman',
    name: 'kh_elder_woman',
    baseVoice: 'km-KH-SreymomNeural',
    pitch: -12,
    rate: -8,
    gender: 'Female',
    language: 'Khmer (Cambodia)',
    label: '👵 ម្តាយ / លោកយាយ (ធ្ងន់ ស្ងប់)',
    description: 'តួម្តាយ / វ័យចំណាស់'
  }
];

const VOICE_PRESET_MAP = new Map(KHMER_VOICE_PRESETS.map(p => [p.id, p]));

function parseNumericProsody(value, fallback = 0, min = -50, max = 50) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = typeof value === 'number'
    ? value
    : parseFloat(String(value).replace(/(?:Hz|%)$/i, ''));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.round(Math.min(max, Math.max(min, numeric)));
}

function formatPitchHz(pitchNum) {
  return pitchNum >= 0 ? `+${pitchNum}Hz` : `${pitchNum}Hz`;
}

function formatRatePct(rateNum) {
  return rateNum >= 0 ? `+${rateNum}%` : `${rateNum}%`;
}

/**
 * Resolve UI or shorthand voice labels into Edge TTS neural voice names.
 * @param {string} voice
 * @returns {string}
 */
function resolveVoiceName(voice) {
  if (typeof voice !== 'string') return DEFAULT_VOICE;
  const trimmed = voice.trim();
  if (!trimmed) return DEFAULT_VOICE;
  const cloneProfile = voiceCloner.getClonedVoiceById(trimmed);
  if (cloneProfile) return cloneProfile.baseVoice;
  const preset = VOICE_PRESET_MAP.get(trimmed);
  if (preset) return preset.baseVoice;
  if (trimmed.includes('Queen') || trimmed.includes('Sreymom')) {
    return 'km-KH-SreymomNeural';
  }
  if (trimmed.includes('King') || trimmed.includes('Piseth')) {
    return 'km-KH-PisethNeural';
  }
  if (/^[a-z]{2,3}-[a-z]{2}-.+neural$/i.test(trimmed)) {
    return trimmed;
  }
  return DEFAULT_VOICE;
}

/**
 * Resolve voice preset + pitch/rate overrides cleanly, including cloned voice profiles.
 * @param {string} voice
 * @param {{ pitch?: number|string, rate?: number|string }} [options]
 */
function resolveVoiceSpec(voice, options = {}) {
  const raw = typeof voice === 'string' ? voice.trim() : '';
  const cloneProfile = voiceCloner.getClonedVoiceById(raw);
  if (cloneProfile) {
    return {
      presetId: cloneProfile.id,
      isClone: true,
      cloneProfile,
      voice: cloneProfile.baseVoice,
      pitchNum: 0,
      rateNum: 0,
      pitchStr: '+0Hz',
      rateStr: '+0%'
    };
  }
  const preset = VOICE_PRESET_MAP.get(raw) || null;
  const baseVoice = preset ? preset.baseVoice : resolveVoiceName(raw);
  const pitchNum = parseNumericProsody(options.pitch, preset ? preset.pitch : 0, -50, 50);
  const rateNum = parseNumericProsody(options.rate, preset ? preset.rate : 0, -50, 100);
  return {
    presetId: preset ? preset.id : null,
    isClone: false,
    cloneProfile: null,
    voice: baseVoice,
    pitchNum,
    rateNum,
    pitchStr: formatPitchHz(pitchNum),
    rateStr: formatRatePct(rateNum)
  };
}

/**
 * Canonical signature for cache keys and frontend readiness lookups.
 */
function getVoiceSignature(voice, options = {}) {
  const spec = resolveVoiceSpec(voice, options);
  if (spec.isClone && spec.cloneProfile) {
    return `clone:${spec.cloneProfile.id}|b=${spec.cloneProfile.baseVoice}|r=${spec.cloneProfile.revision || 1}`;
  }
  let sig = (spec.pitchNum === 0 && spec.rateNum === 0)
    ? spec.voice
    : `${spec.voice}|p=${spec.pitchStr}|r=${spec.rateStr}`;
  const emo = normalizeEmotionId(options.emotion);
  if (emo && emo !== 'auto' && emo !== 'natural') {
    sig += `|e=${emo}`;
  }
  return sig;
}

function readAudioCacheMeta(audioFile) {
  const metaFile = `${audioFile}.meta.json`;
  if (!fs.existsSync(metaFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeAudioCacheMeta(audioFile, meta) {
  const metaFile = `${audioFile}.meta.json`;
  try {
    fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8');
  } catch (_) { }
}

/**
 * Deterministic cache key shared between TTS synthesis and cache checks.
 * @param {string} text
 * @param {string} voice
 * @param {{ pitch?: number|string, rate?: number|string, emotion?: string, engine?: string }} [options]
 * @returns {string}
 */
function getAudioCacheKey(text, voice = DEFAULT_VOICE, options = {}) {
  const cleanText = typeof text === 'string' ? text.trim() : '';
  const signature = getVoiceSignature(voice, options);
  return crypto.createHash('md5')
    .update(`${signature}:${cleanText}`)
    .digest('hex');
}

/**
 * Generate TTS audio file
 * @param {string} text - Text to synthesize
 * @param {string} voiceName - Voice name, preset ID, or cloned voice ID
 * @param {{ force?: boolean, pitch?: number|string, rate?: number|string, emotion?: string, engine?: string, strictVoice?: boolean, allowGoogleFallback?: boolean, req?: object }} [options]
 * @returns {Promise<{ audioUrl: string, cached: boolean, key: string, voice: string, signature: string }>}
 */
const inFlightTtsJobs = new Map();
const inFlightTtsKeyLocks = new Map();

function withTtsKeyLock(key, fn) {
  const prev = inFlightTtsKeyLocks.get(key) || Promise.resolve();
  let resultPromise;
  resultPromise = prev.catch(() => { }).then(() => fn());
  const cleanupPromise = resultPromise.catch(() => { }).finally(() => {
    if (inFlightTtsKeyLocks.get(key) === cleanupPromise) {
      inFlightTtsKeyLocks.delete(key);
    }
  });
  inFlightTtsKeyLocks.set(key, cleanupPromise);
  return resultPromise;
}

async function synthesizeTts(text, voiceName = DEFAULT_VOICE, options = {}) {
  const cacheDir = getAudioCacheDir();
  const cleanText = typeof text === 'string' ? text.trim() : '';
  const strictVoice = options.strictVoice !== false;
  const spec = resolveVoiceSpec(voiceName, options);
  const signature = getVoiceSignature(voiceName, options);
  const key = getAudioCacheKey(cleanText, voiceName, options);
  const audioFile = path.join(cacheDir, `${key}.mp3`);

  if (!options.force && fs.existsSync(audioFile)) {
    try {
      const stat = fs.statSync(audioFile);
      const meta = readAudioCacheMeta(audioFile);
      const isPoisonedFallback = Boolean(meta && meta.fallback);
      if (stat.size > MIN_VALID_AUDIO_BYTES && !(strictVoice && isPoisonedFallback)) {
        return {
          audioUrl: `/audio_cache/${key}.mp3`,
          cached: true,
          key,
          voice: spec.isClone ? spec.presetId : spec.voice,
          signature,
          actualEngine: (meta && meta.actualEngine) || (spec.isClone ? 'seed-vc' : 'edge'),
          fallback: isPoisonedFallback
        };
      }
    } catch (_) { }
  }

  const jobKey = `${key}|s=${strictVoice ? 1 : 0}|g=${options.allowGoogleFallback ? 1 : 0}|b=${options.allowBaseFallback ? 1 : 0}`;
  if (!options.force && inFlightTtsJobs.has(jobKey)) {
    const sharedResult = await inFlightTtsJobs.get(jobKey);
    return { ...sharedResult, cached: true };
  }

  const workPromise = withTtsKeyLock(key, async () => {
    if (!options.force && fs.existsSync(audioFile)) {
      try {
        const existingStat = fs.statSync(audioFile);
        const existingMeta = readAudioCacheMeta(audioFile);
        const existingPoisoned = Boolean(existingMeta && existingMeta.fallback);
        if (existingStat.size > MIN_VALID_AUDIO_BYTES && !(strictVoice && existingPoisoned)) {
          return {
            audioUrl: `/audio_cache/${key}.mp3`,
            cached: true,
            key,
            voice: spec.isClone ? spec.presetId : spec.voice,
            signature,
            actualEngine: (existingMeta && existingMeta.actualEngine) || (spec.isClone ? 'seed-vc' : 'edge'),
            fallback: existingPoisoned
          };
        }
        if (fs.existsSync(audioFile)) fs.unlinkSync(audioFile);
        const existingMetaPath = `${audioFile}.meta.json`;
        if (fs.existsSync(existingMetaPath)) fs.unlinkSync(existingMetaPath);
      } catch (_) { }
    }

    const uniqueSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
    const tmpAudioFile = `${audioFile}.${uniqueSuffix}.tmp.mp3`;
    let synthInfo;
    try {
      if (spec.isClone && spec.cloneProfile) {
        if (!voiceCloner.isSeedVcReady()) {
          if (strictVoice && !options.allowBaseFallback) {
            const err = new Error('ម៉ូដែល AI Voice Clone (Seed-VC) មិនទាន់បានដំឡើងទេ — សូមបើក Voice Clone Studio ចុចដំឡើង (~3–4GB) ជាមុនសិន។');
            err.needsCloneEngineInstall = true;
            err.statusCode = 412;
            throw err;
          }
          // Graceful fallback to cloned profile's base voice (Edge Piseth / Sreymom)
          synthInfo = await synthesizeEdgeWithFallback(cleanText, {
            ...spec,
            voice: spec.cloneProfile.baseVoice,
            pitchStr: spec.pitchStr || '+0Hz',
            rateStr: spec.rateStr || '+0%'
          }, tmpAudioFile, {
            engine: 'edge',
            emotion: normalizeEmotionId(options.emotion),
            strictVoice: false,
            allowGoogleFallback: Boolean(options.allowGoogleFallback)
          });
          synthInfo = { actualEngine: 'edge-fallback', fallback: true };
        } else {
          const baseTmpMp3 = `${audioFile}.${uniqueSuffix}.edgebase.mp3`;
          try {
            await synthesizeEdgeWithFallback(cleanText, spec, baseTmpMp3, {
              engine: 'edge',
              emotion: normalizeEmotionId(options.emotion),
              strictVoice: true,
              allowGoogleFallback: false
            });
            await enqueueSeedVcTask(() => voiceCloner.convertSpeechWithSeedVc({
              sourceAudioFile: baseTmpMp3,
              targetRefWav: spec.cloneProfile.samplePath,
              outMp3File: tmpAudioFile
            }));
            synthInfo = { actualEngine: 'seed-vc', fallback: false };
          } finally {
            try { if (fs.existsSync(baseTmpMp3)) fs.unlinkSync(baseTmpMp3); } catch (_) { }
          }
        }
      } else {
        // Generate audio strictly using the chosen EdgeTTS voice (no silent Google fallback in strict mode)
        synthInfo = await synthesizeEdgeWithFallback(cleanText, spec, tmpAudioFile, {
          engine: 'edge',
          emotion: normalizeEmotionId(options.emotion),
          strictVoice,
          allowGoogleFallback: Boolean(options.allowGoogleFallback && !strictVoice)
        });
      }

      const stat = fs.existsSync(tmpAudioFile) ? fs.statSync(tmpAudioFile) : null;
      if (!stat || stat.size <= MIN_VALID_AUDIO_BYTES) {
        throw new Error('Generated TTS audio file was empty');
      }

      const durationSec = parseMp3DurationFast(tmpAudioFile);
      await renameFileSafe(tmpAudioFile, audioFile);
      writeAudioCacheMeta(audioFile, {
        actualEngine: (synthInfo && synthInfo.actualEngine) || 'edge',
        fallback: Boolean(synthInfo && synthInfo.fallback),
        voiceId: spec.presetId || spec.voice,
        durationSec: durationSec > 0 ? durationSec : undefined,
        createdAt: new Date().toISOString()
      });

      return {
        audioUrl: `/audio_cache/${key}.mp3`,
        cached: false,
        key,
        voice: spec.isClone ? spec.presetId : spec.voice,
        signature,
        actualEngine: (synthInfo && synthInfo.actualEngine) || 'edge',
        fallback: Boolean(synthInfo && synthInfo.fallback),
        modelUsed: ''
      };
    } finally {
      try { if (fs.existsSync(tmpAudioFile)) fs.unlinkSync(tmpAudioFile); } catch (_) { }
    }
  });

  if (!options.force) {
    inFlightTtsJobs.set(jobKey, workPromise);
  }
  try {
    return await workPromise;
  } finally {
    if (inFlightTtsJobs.get(jobKey) === workPromise) {
      inFlightTtsJobs.delete(jobKey);
    }
  }
}

/**
 * POST /api/tts/generate
 * Generate TTS audio from text
 */
router.post('/generate', async (req, res) => {
  try {
    const { text, voice, force, pitch, rate, emotion, engine, strictVoice, allowGoogleFallback } = req.body || {};

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Text is required'
      });
    }

    if (text.length > 5000) {
      return res.status(400).json({
        success: false,
        error: 'Text too long (max 5000 chars)'
      });
    }

    const result = await synthesizeTts(text.trim(), voice || DEFAULT_VOICE, {
      force: Boolean(force),
      pitch,
      rate,
      emotion,
      engine,
      strictVoice: strictVoice !== false,
      allowBaseFallback: req.body && Boolean(req.body.allowBaseFallback),
      allowGoogleFallback: Boolean(allowGoogleFallback),
      req
    });

    res.json({
      success: true,
      audioUrl: result.audioUrl,
      cached: result.cached,
      voice: result.voice,
      signature: result.signature,
      actualEngine: result.actualEngine,
      fallback: result.fallback,
      modelUsed: result.modelUsed || ''
    });
  } catch (e) {
    console.error('[tts/generate]:', e);
    res.status(e.statusCode || 500).json({
      success: false,
      error: e.message,
      needsCloneEngineInstall: Boolean(e && e.needsCloneEngineInstall)
    });
  }
});

/**
 * Short Khmer sample lines for instantaneous voice audition preview
 */
const VOICE_PREVIEW_TEXTS = {
  'Sovereign King': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងពិសិទ្ធ បុរសធម្មតា។',
  'Radiant Queen': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងស្រីមុំ ស្ត្រីធម្មតា។',
  'kh_narrator_fast': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងនិទានរឿង TikTok រហ័សទាន់ចិត្ត។',
  'kh_young_man': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងយុវជន ក្មេង ស្រស់ថ្លា។',
  'kh_deep_boss': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងលោកប្រធាន ឬលោកតា ធ្ងន់ និងម៉ឺងម៉ាត់។',
  'kh_young_girl': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងយុវតី ឬក្មេងស្រី ស្រស់ស្រាយ។',
  'kh_child': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងកូនក្មេង តូច គួរឲ្យស្រឡាញ់។',
  'kh_elder_woman': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងម្តាយ ឬលោកយាយ ធ្ងន់ និងស្ងប់។',
  'km-KH-PisethNeural': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងពិសិទ្ធ បុរសធម្មតា។',
  'km-KH-SreymomNeural': 'ជំរាបសួរ! ខ្ញុំជាសំឡេងស្រីមុំ ស្ត្រីធម្មតា។'
};

/**
 * POST /api/tts/preview
 * Generate or return cached preview sample audio for any voice
 */
router.post('/preview', async (req, res) => {
  try {
    const { voice, pitch, rate } = req.body || {};
    const rawVoice = typeof voice === 'string' && voice.trim() ? voice.trim() : DEFAULT_VOICE;
    const spec = resolveVoiceSpec(rawVoice, { pitch, rate });
    const presetId = spec.presetId || rawVoice;

    // For custom cloned voice profiles, if Seed-VC 3-4GB is not installed, audition the real uploaded reference clip directly
    if (spec.isClone && spec.cloneProfile && !voiceCloner.isSeedVcReady()) {
      return res.json({
        success: true,
        audioUrl: spec.cloneProfile.sampleUrl,
        cached: true,
        voice: spec.presetId,
        presetId,
        pitch: '+0Hz',
        rate: '+0%',
        signature: `clone:${spec.cloneProfile.id}`,
        text: `[គំរូដើម] ${spec.cloneProfile.name}`,
        isReferenceSample: true
      });
    }

    const sampleText = VOICE_PREVIEW_TEXTS[presetId] || VOICE_PREVIEW_TEXTS[spec.voice] || 'ជំរាបសួរ! ខ្ញុំជាសំឡេងខ្មែរ AI។';

    const result = await synthesizeTts(sampleText, presetId, {
      pitch,
      rate,
      strictVoice: true,
      force: Boolean(req.body && req.body.force),
      req
    });

    res.json({
      success: true,
      audioUrl: result.audioUrl,
      cached: result.cached,
      voice: result.voice,
      presetId,
      pitch: spec.pitchStr,
      rate: spec.rateStr,
      signature: result.signature,
      text: sampleText
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({
      success: false,
      error: e.message
    });
  }
});

/**
 * POST /api/tts/batch-generate
 * Generate multiple TTS audio files
 */
router.post('/batch-generate', async (req, res) => {
  try {
    const { items, fixedVoice, strictVoice } = req.body || {};
    const lockedVoice = typeof fixedVoice === 'string' && fixedVoice.trim() ? fixedVoice.trim() : '';
    const enforceStrict = strictVoice !== false;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Items array required'
      });
    }

    const results = new Array(items.length);
    let successCount = 0;
    let errorCount = 0;
    let cachedCount = 0;
    let cursor = 0;
    const reqConcurrency = Number(req.body && req.body.concurrency);
    const workerCount = Math.max(
      1,
      Math.min(
        Number.isFinite(reqConcurrency) && reqConcurrency > 0 ? Math.min(24, Math.max(1, Math.floor(reqConcurrency))) : 18,
        items.length
      )
    );

    const runWorker = async () => {
      while (cursor < items.length) {
        const pos = cursor++;
        const item = items[pos];
        try {
          if (!item || typeof item.text !== 'string' || item.text.trim().length === 0) {
            throw new Error('Item text is required');
          }
          if (item.text.length > 5000) {
            throw new Error('Item text too long (max 5000 chars)');
          }

          const targetVoice = lockedVoice || item.voice || DEFAULT_VOICE;
          const result = await synthesizeTts(
            item.text.trim(),
            targetVoice,
            {
              force: Boolean(item.force),
              pitch: item.pitch,
              rate: item.rate,
              emotion: item.emotion,
              engine: item.engine,
              strictVoice: enforceStrict,
              allowBaseFallback: req.body && Boolean(req.body.allowBaseFallback),
              req
            }
          );

          if (result.cached) cachedCount++;
          results[pos] = {
            index: item.index !== undefined ? item.index : pos,
            success: true,
            audioUrl: result.audioUrl,
            cached: result.cached,
            voice: result.voice,
            signature: result.signature,
            actualEngine: result.actualEngine
          };
          successCount++;
        } catch (err) {
          results[pos] = {
            index: item && item.index !== undefined ? item.index : pos,
            success: false,
            error: err.message,
            needsCloneEngineInstall: Boolean(err && err.needsCloneEngineInstall)
          };
          errorCount++;
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    res.json({
      success: true,
      results,
      stats: {
        total: items.length,
        success: successCount,
        cached: cachedCount,
        errors: errorCount
      }
    });
  } catch (e) {
    console.error('[tts/batch-generate]:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/check-audio-cache
 * Check which subtitle lines already have valid cached MP3 audio files.
 */
function checkAudioCacheHandler(req, res) {
  try {
    const { items } = req.body || {};
    const cacheDir = getAudioCacheDir();
    const cached = [];
    const cachedKeys = [];
    const urls = {};

    if (Array.isArray(items)) {
      for (const it of items) {
        if (!it || typeof it.text !== 'string') continue;
        const cleanText = it.text.trim();
        if (!cleanText) continue;

        const signature = getVoiceSignature(it.voice, it);
        const key = getAudioCacheKey(cleanText, it.voice, it);
        const cacheFile = path.join(cacheDir, `${key}.mp3`);
        if (fs.existsSync(cacheFile)) {
          try {
            const meta = readAudioCacheMeta(cacheFile);
            if (meta && meta.fallback) continue;
            if (fs.statSync(cacheFile).size > MIN_VALID_AUDIO_BYTES) {
              const voiceTextKey = `${signature}:${cleanText}`;
              cached.push(cleanText);
              cachedKeys.push(voiceTextKey);
              urls[voiceTextKey] = `/audio_cache/${key}.mp3`;
            }
          } catch (_) { }
        }
      }
    }

    res.json({
      success: true,
      cached,
      cachedKeys,
      urls
    });
  } catch (e) {
    res.status(500).json({ success: false, cached: [], cachedKeys: [], error: e.message });
  }
}

/**
 * GET /api/tts/voices
 * Get available Khmer voices, character presets, and custom cloned voice profiles
 */
router.get('/voices', (req, res) => {
  const formattedPresets = KHMER_VOICE_PRESETS.map(p => ({
    id: p.id,
    name: p.name,
    baseVoice: p.baseVoice,
    pitch: formatPitchHz(p.pitch),
    rate: formatRatePct(p.rate),
    pitchNum: p.pitch,
    rateNum: p.rate,
    gender: p.gender,
    language: p.language,
    label: p.label,
    description: p.description,
    isClone: false
  }));

  const clonedVoices = voiceCloner.listClonedVoices().map(c => ({
    ...c,
    pitch: '+0Hz',
    rate: '+0%',
    pitchNum: 0,
    rateNum: 0
  }));

  const baseVoices = KHMER_VOICE_PRESETS
    .filter(p => p.pitch === 0 && p.rate === 0)
    .map(p => ({
      id: p.baseVoice,
      presetId: p.id,
      name: p.id === 'Sovereign King' ? 'Piseth (Male)' : 'Sreymom (Female)',
      gender: p.gender,
      language: p.language,
      label: p.label,
      description: p.description
    }));

  res.json({
    success: true,
    voices: baseVoices,
    presets: [...formattedPresets, ...clonedVoices],
    clonedVoices,
    cloneEngine: voiceCloner.getCloneEngineStatus(),
    emotions: EMOTION_PRESETS.map(e => ({ id: e.id, label: e.label }))
  });
});

/**
 * GET /api/tts/clone/status
 * Report local GPU/Python hardware compatibility and Seed-VC install status.
 */
router.get('/clone/status', (req, res) => {
  try {
    res.json({
      success: true,
      ...voiceCloner.getCloneEngineStatus()
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/tts/clone/install
 * Trigger background installation of Seed-VC (fp16) onto D:\ voice_clone_engine.
 */
router.post('/clone/install', async (req, res) => {
  try {
    const status = await voiceCloner.startSeedVcInstall();
    res.json({ success: status.installState !== 'error', ...status });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/tts/clone/cancel
 * Abort an active Seed-VC installation.
 */
router.post('/clone/cancel', (req, res) => {
  try {
    const status = voiceCloner.cancelSeedVcInstall();
    res.json({ success: true, ...status });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/tts/cloned-voices
 * List all saved custom cloned voice profiles.
 */
router.get('/cloned-voices', (req, res) => {
  try {
    res.json({
      success: true,
      voices: voiceCloner.listClonedVoices(),
      engine: voiceCloner.getCloneEngineStatus()
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/tts/cloned-voices
 * Create a cloned voice profile from base64 uploaded audio or a local audio file path.
 */
router.post('/cloned-voices', async (req, res) => {
  try {
    const { name, baseGender, audioBase64, sourcePath, trimStartSec, trimDurationSec } = req.body || {};
    let audioBuffer = null;
    if (typeof audioBase64 === 'string' && audioBase64.trim()) {
      const cleaned = audioBase64.replace(/^data:[^;]+;base64,/, '').trim();
      audioBuffer = Buffer.from(cleaned, 'base64');
    }
    const created = await voiceCloner.createClonedVoice({
      name,
      baseGender,
      audioBuffer,
      sourcePath,
      trimStartSec,
      trimDurationSec
    });
    res.json({
      success: true,
      voice: created,
      voices: voiceCloner.listClonedVoices(),
      engine: voiceCloner.getCloneEngineStatus()
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/tts/cloned-voices/extract-video
 * Extract a clean 3-25s vocal clip from the current video for voice cloning.
 */
router.post('/cloned-voices/extract-video', async (req, res) => {
  try {
    const { name, baseGender, videoPath, startSec, durationSec } = req.body || {};
    if (!videoPath || typeof videoPath !== 'string' || !videoPath.trim()) {
      return res.status(400).json({ success: false, error: 'សូមបើកវីដេអូជាមុនសិន' });
    }
    const created = await voiceCloner.createClonedVoice({
      name,
      baseGender,
      sourcePath: videoPath.trim(),
      trimStartSec: Number(startSec) || 0,
      trimDurationSec: Number(durationSec) || 12,
      isolateVocals: true,
      vocalFilter: audioRouter.VOCAL_ISOLATION_FILTER
    });
    res.json({
      success: true,
      voice: created,
      voices: voiceCloner.listClonedVoices(),
      engine: voiceCloner.getCloneEngineStatus()
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

/**
 * DELETE /api/tts/cloned-voices/:id
 * Delete a cloned voice profile and its reference WAV.
 */
router.delete('/cloned-voices/:id', (req, res) => {
  try {
    const removed = voiceCloner.deleteClonedVoice(req.params.id);
    if (!removed) {
      return res.status(404).json({ success: false, error: 'រកមិនឃើញសំឡេង Clone នេះទេ' });
    }
    res.json({
      success: true,
      voices: voiceCloner.listClonedVoices()
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * DELETE /api/tts/cache
 * Clear TTS audio cache
 */
router.delete('/cache', (req, res) => {
  try {
    const cacheDir = getAudioCacheDir();
    const files = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];
    let deletedCount = 0;

    for (const file of files) {
      if (file.endsWith('.mp3') || file.endsWith('.meta.json')) {
        fs.unlinkSync(path.join(cacheDir, file));
        if (file.endsWith('.mp3')) deletedCount++;
      }
    }

    res.json({
      success: true,
      message: `Deleted ${deletedCount} audio files`,
      deletedCount
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.getAudioCacheDir = getAudioCacheDir;
router.KHMER_VOICE_PRESETS = KHMER_VOICE_PRESETS;
router.EMOTION_PRESETS = EMOTION_PRESETS;
router.normalizeEmotionId = normalizeEmotionId;
router.detectEmotionFromText = detectEmotionFromText;
router.checkAudioCacheHandler = checkAudioCacheHandler;
router.resolveVoiceName = resolveVoiceName;
router.resolveVoiceSpec = resolveVoiceSpec;
router.getVoiceSignature = getVoiceSignature;
router.getAudioCacheKey = getAudioCacheKey;
router.readAudioCacheMeta = readAudioCacheMeta;
router.writeAudioCacheMeta = writeAudioCacheMeta;
router.normalizeSpokenTextAndLang = normalizeSpokenTextAndLang;
router.enhanceDramaticSpokenText = enhanceDramaticSpokenText;
router.computeExpressiveProsody = computeExpressiveProsody;
router.synthesizeTts = synthesizeTts;
router.VOICE_PREVIEW_TEXTS = VOICE_PREVIEW_TEXTS;

module.exports = router;
