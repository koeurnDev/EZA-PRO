/**
 * EZA PRO - Chinese subtitle OCR and context-aware translation
 */

const express = require('express');
const router = express.Router();
const https = require('https');
const http = require('http');
const crypto = require('crypto');

function createGeminiHttpsAgent() {
  return new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 24,
    maxFreeSockets: 12,
    timeout: 60000,
  });
}
let geminiHttpsAgent = createGeminiHttpsAgent();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn, spawnSync } = require('child_process');
const {
  loadConfig,
  saveConfig,
  beginGeminiStream,
  getGeminiApiKeyCandidates,
  markGeminiKeyRateLimited,
  markGeminiKeyHealthy,
  getRespanRuntimeConfig,
  getSafeRespanSnapshot,
  beginRespanStream,
  markRespanRateLimited,
  markRespanHealthy,
  isRespanRateLimited
} = require('./config');
const { FFMPEG_BIN, lowerProcessPriority } = require('../utils/ffmpeg');
const voiceCloner = require('../utils/voice-cloner');
const {
  CHUON_NATH_PROMPT_GUIDE,
  isChuonNathWord,
  normalizeKhmerChuonNath,
  segmentKhmerWithChuonNath,
  auditKhmerAgainstChuonNath,
  getChuonNathStats
} = require('../utils/khmer-chuon-nath');
const { invalidateDnsCache } = require('../utils/dns-fix');
const { resolveUnpackedPath, logWarn, logError } = require('../utils/logger');
let lastGeminiNetResetAt = 0;
function resetGeminiNetworkRoute(badIp = '') {
  const now = Date.now();
  invalidateDnsCache('generativelanguage.googleapis.com', badIp);
  if (now - lastGeminiNetResetAt < 500) return;
  lastGeminiNetResetAt = now;
  const prevAgent = geminiHttpsAgent;
  geminiHttpsAgent = createGeminiHttpsAgent();
  // Close only idle keep-alive sockets so active requests on healthy sibling workers are never aborted
  try {
    if (prevAgent && prevAgent.freeSockets) {
      for (const sockList of Object.values(prevAgent.freeSockets)) {
        for (const sock of sockList || []) {
          try { sock.destroy(); } catch (_) { }
        }
      }
    }
  } catch (_) { }
}
const translationCache = require('../../../translation_cache');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const GEMINI_FAST_LITE_MODEL = 'gemini-3.1-flash-lite-preview';
const GEMINI_FALLBACK_MODELS = [
  GEMINI_MODEL,
  GEMINI_FAST_LITE_MODEL,
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
  } catch (_) { }
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
    } catch (_) { }
  }
  return {
    mode: routerModelMode,
    primaryModel: routerModelMode === 'smart' ? HYDROGEN_MODEL : GEMINI_MODEL,
    thinkingLevel: routerModelMode === 'smart' ? (process.env.GEMINI_4_THINKING_LEVEL || 'low') : 'none'
  };
}
const MAX_CUES = 8000;
const MAX_CUE_TEXT_LENGTH = 1000;
const MAX_TOTAL_TEXT_LENGTH = 400000;
const TRANSLATION_CHUNK_SIZE = 25;
const STORY_ANALYSIS_MIN_CUES = 4;
const OCR_BATCH_SIZE = 12;
const MAX_SPEECH_AUDIO_BYTES = 12 * 1024 * 1024;
const SPEECH_REQUEST_TIMEOUT_MS = 75000;
const DEFAULT_SPEECH_CHUNK_SEC = 60;
const SPEECH_VOCAL_FILTER = 'highpass=f=85,lowpass=f=6800,dynaudnorm=f=150:g=11:p=0.9:m=6';

const activeSpeechState = {
  running: false,
  totalChunks: 0,
  completedChunks: 0,
  percent: 0,
  stage: 'idle',
  statusText: '',
  error: null,
};
let activeSpeechJobCount = 0;
const speechProgressByJob = new Map();

function createSpeechProgressEntry() {
  return {
    running: false,
    totalChunks: 0,
    completedChunks: 0,
    percent: 0,
    stage: 'idle',
    statusText: '',
    error: null,
    updatedAt: Date.now()
  };
}

function recordSpeechProgressEntry(key, entry) {
  if (!key) return;
  if (speechProgressByJob.has(key)) speechProgressByJob.delete(key);
  speechProgressByJob.set(key, entry);
  while (speechProgressByJob.size > 32) {
    const oldestKey = speechProgressByJob.keys().next().value;
    if (!oldestKey) break;
    speechProgressByJob.delete(oldestKey);
  }
}

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

function buildGeminiGenerationConfig(modelName, options = {}) {
  const config = {
    maxOutputTokens: 24576,
    responseMimeType: 'application/json'
  };
  if (isGemini4Model(modelName)) {
    config.thinkingConfig = {
      thinkingLevel: process.env.GEMINI_4_THINKING_LEVEL || 'low'
    };
  } else if (/^gemini-3-flash/i.test(String(modelName || '')) && !options.preferQuality) {
    config.thinkingConfig = {
      thinkingLevel: 'minimal'
    };
  } else {
    config.temperature = 0.2;
  }
  return config;
}

function callGeminiSingleModel(modelName, prompt, apiKey, extraParts = [], timeoutMs = 60000, options = {}) {
  const effectiveTimeoutMs = getGeminiTimeoutMs(modelName, timeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    let hardTimer = null;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
      fn(val);
    };

    const payload = JSON.stringify({
      contents: [{
        parts: [{ text: prompt }, ...extraParts]
      }],
      generationConfig: buildGeminiGenerationConfig(modelName, options)
    });

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      family: 4,
      agent: geminiHttpsAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: effectiveTimeoutMs
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('error', err => finish(reject, err));
      res.on('aborted', () => finish(reject, new Error('Gemini response aborted unexpectedly (ECONNRESET).')));
      res.on('end', () => {
        if (settled) return;
        let json;
        try {
          json = JSON.parse(data);
        } catch (err) {
          return finish(reject, new Error('Gemini returned an invalid response.'));
        }

        if (res.statusCode < 200 || res.statusCode >= 300 || json.error) {
          const err = new Error(
            (json.error && json.error.message) || `Gemini API returned HTTP ${res.statusCode}.`
          );
          err.statusCode = res.statusCode;
          return finish(reject, err);
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
          return finish(reject, emptyErr);
        }
        finish(resolve, text.trim());
      });
    });

    hardTimer = setTimeout(() => {
      try { req.destroy(new Error('Gemini request timed out.')); } catch (_) { }
      finish(reject, new Error('Gemini request timed out.'));
    }, effectiveTimeoutMs + 1500);
    req.setTimeout(effectiveTimeoutMs, () => req.destroy(new Error('Gemini request timed out.')));
    req.on('error', err => finish(reject, err));
    req.end(payload);
  });
}

const respanHttpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 16, timeout: 60000 });
const respanHttpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 16, timeout: 60000 });
let respanAssistCursor = 0;

function extractOpenAiMessageText(json) {
  if (!json || !Array.isArray(json.choices) || json.choices.length === 0) return '';
  const msg = json.choices[0] && json.choices[0].message;
  if (!msg) return '';
  let content = '';
  if (typeof msg.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    content = msg.content.map(part => (part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function callRespanSingleRequest(prompt, respanCfg, timeoutMs = 35000) {
  const effectiveTimeoutMs = Math.max(18000, Number(timeoutMs) || 35000);
  const baseUrl = String((respanCfg && respanCfg.baseUrl) || 'https://gateway.respan.ai/v1').trim().replace(/\/+$/, '');
  const model = String((respanCfg && respanCfg.model) || 'openai/gpt-6.2-sol:free').trim();
  const apiKey = String((respanCfg && respanCfg.apiKey) || '').trim();

  return new Promise((resolve, reject) => {
    let targetUrl;
    try {
      targetUrl = new URL(`${baseUrl}/chat/completions`);
    } catch (urlErr) {
      return reject(urlErr);
    }

    let settled = false;
    let hardTimer = null;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
      fn(val);
    };

    const systemPrompt = [
      'You are an ultra-fast Chinese-to-Khmer drama subtitle translator.',
      'Translate dialogue into natural everyday spoken Khmer (ភាសាខ្មែរនិយាយធម្មតាសាមញ្ញ ងាយយល់ រលូន ដូចមនុស្សនិយាយគ្នាប្រចាំថ្ងៃ).',
      'Keep spoken phrasing concise, avoid stiff academic or literary wording, never leave untranslated source characters or Pinyin.',
      'Strictly obey the JSON structure requested in the prompt and reply with valid JSON only.'
    ].join(' ');

    const payload = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2
    });

    const isHttp = targetUrl.protocol === 'http:';
    const mod = isHttp ? http : https;
    const req = mod.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttp ? 80 : 443),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: 'POST',
      family: 4,
      agent: isHttp ? respanHttpAgent : respanHttpsAgent,
      timeout: effectiveTimeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('error', err => finish(reject, err));
      res.on('aborted', () => finish(reject, new Error('Respan gateway aborted response.')));
      res.on('end', () => {
        if (settled) return;
        let json;
        try {
          json = JSON.parse(data);
        } catch (_) {
          const err = new Error(`Respan returned invalid JSON (HTTP ${res.statusCode}).`);
          err.statusCode = res.statusCode;
          return finish(reject, err);
        }
        if (res.statusCode < 200 || res.statusCode >= 300 || json.error) {
          const err = new Error(
            (json.error && json.error.message) || `Respan gateway returned HTTP ${res.statusCode}.`
          );
          err.statusCode = res.statusCode;
          return finish(reject, err);
        }
        const text = extractOpenAiMessageText(json);
        if (!text) {
          const emptyErr = new Error('Respan returned an empty response.');
          emptyErr.isEmptyModelResponse = true;
          return finish(reject, emptyErr);
        }
        finish(resolve, text);
      });
    });

    hardTimer = setTimeout(() => {
      try { req.destroy(new Error('Respan gateway request timed out.')); } catch (_) { }
      finish(reject, new Error('Respan gateway request timed out.'));
    }, effectiveTimeoutMs + 1500);
    req.setTimeout(effectiveTimeoutMs, () => req.destroy(new Error('Respan gateway request timed out.')));
    req.on('error', err => finish(reject, err));
    req.end(payload);
  });
}

async function tryCallRespanGateway(prompt, respanCfg, timeoutMs = 35000) {
  const stream = beginRespanStream();
  let lastErr = null;
  let ok = false;
  let lastStatus = 502;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 450 * attempt));
        const text = await callRespanSingleRequest(prompt, respanCfg, timeoutMs);
        markRespanHealthy();
        ok = true;
        lastStatus = 200;
        return { ok: true, text };
      } catch (err) {
        lastErr = err;
        lastStatus = Number(err && err.statusCode) || 502;
        const msg = String((err && err.message) || '');
        const isTransient = /ETIMEDOUT|timed out|ECONNRESET|ECONNABORTED|socket hang up/i.test(msg) ||
          lastStatus === 500 || lastStatus === 502 || lastStatus === 504;
        if (isTransient && attempt < 1) continue;
        if (lastStatus === 429 || /\b429\b|rate[- ]?limit|quota/i.test(msg)) {
          markRespanRateLimited(25000);
        } else if (lastStatus === 401 || lastStatus === 403 || /invalid.*key|unauthorized|forbidden/i.test(msg)) {
          markRespanRateLimited(5 * 60 * 1000);
        } else if (lastStatus >= 500) {
          markRespanRateLimited(15000);
        }
        break;
      }
    }
    return { ok: false, error: lastErr || new Error('Respan gateway request failed.') };
  } finally {
    stream.end(ok, lastStatus, lastErr ? lastErr.message : '');
  }
}

async function callGeminiApi(prompt, apiKey, extraParts = [], timeoutMs = 20000, options = {}) {
  let lastError = null;
  const now = Date.now();
  const hasAudioPart = Array.isArray(extraParts) && extraParts.some(p => p && p.inline_data && String(p.inline_data.mime_type || '').startsWith('audio/'));
  const hasImagePart = Array.isArray(extraParts) && extraParts.some(p => p && p.inline_data && String(p.inline_data.mime_type || '').startsWith('image/'));
  const hasMediaParts = hasAudioPart || hasImagePart || (Array.isArray(extraParts) && extraParts.length > 0);
  const streamTask = hasAudioPart ? 'Audio AI' : (hasImagePart ? 'Vision OCR' : 'Translation');

  const respanCfg = !hasMediaParts && !(options && options.preferGeminiOnly)
    ? ((options && options.respanConfig) || getRespanRuntimeConfig())
    : null;
  const canUseRespan = Boolean(respanCfg && respanCfg.enabled && respanCfg.apiKey && respanCfg.role !== 'off');
  const totalConfiguredKeys = getGeminiApiKeyCandidates(apiKey, 'api:count', { advanceCursor: false }).length;
  const hasAnyGeminiKey = totalConfiguredKeys > 0;
  let respanAttempted = false;

  if (canUseRespan && (!hasAnyGeminiKey || (respanCfg.role === 'primary' && !isRespanRateLimited()))) {
    respanAttempted = true;
    const respanOut = await tryCallRespanGateway(prompt, respanCfg, timeoutMs);
    if (respanOut.ok) return respanOut.text;
    lastError = respanOut.error;
    if (!hasAnyGeminiKey) {
      throw lastError || new Error('Respan gateway request failed.');
    }
  } else if (canUseRespan && respanCfg.role === 'assist' && !isRespanRateLimited()) {
    const preferQualityCall = Boolean(options && options.preferQuality);
    const assistTurn = !preferQualityCall && (respanAssistCursor++ % 2 === 1);
    const geminiHealthyOnFast = getGeminiApiKeyCandidates(apiKey, `api:${GEMINI_MODEL}`, { skipAllRateLimited: true, advanceCursor: false }).length > 0 ||
      getGeminiApiKeyCandidates(apiKey, `api:${GEMINI_FAST_LITE_MODEL}`, { skipAllRateLimited: true, advanceCursor: false }).length > 0;
    if (assistTurn || (!preferQualityCall && !geminiHealthyOnFast)) {
      respanAttempted = true;
      const respanOut = await tryCallRespanGateway(prompt, respanCfg, timeoutMs);
      if (respanOut.ok) return respanOut.text;
      lastError = respanOut.error;
    }
  }

    // Audio AI, Vision OCR, and Fast/Auto batches prioritize Flash-Lite for high multi-key throughput & sub-6s latency
    const preferQuality = Boolean(options && options.preferQuality);
    const preferFastModel = Boolean(hasAudioPart || hasImagePart || (options && options.preferFastModel)) && !preferQuality;
    const primaryModel = routerModelMode === 'smart' ? HYDROGEN_MODEL : GEMINI_MODEL;
    preferredGeminiModel = primaryModel;
    const baseOrdered = (hasAudioPart || hasImagePart)
      ? (preferQuality
        ? [GEMINI_MODEL, GEMINI_FAST_LITE_MODEL, HYDROGEN_MODEL]
        : [GEMINI_FAST_LITE_MODEL, GEMINI_MODEL, HYDROGEN_MODEL]
      ).filter((m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx)
      : (preferFastModel
        ? [GEMINI_FAST_LITE_MODEL, GEMINI_MODEL, HYDROGEN_MODEL].filter((m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx)
        : [primaryModel, ...GEMINI_FALLBACK_MODELS.filter(m => m !== primaryModel)].filter(Boolean));
    const healthyModels = baseOrdered.filter(m => (blockedModelsUntil.get(m) || 0) <= now);
    const candidateModels = healthyModels.length > 0 ? healthyModels : baseOrdered;
    const uncooledCounts = new Map(candidateModels.map(m => [m, getGeminiApiKeyCandidates(apiKey, `api:${m}`, { skipAllRateLimited: true, advanceCursor: false }).length]));
    const totalPoolKeys = Math.max(1, totalConfiguredKeys);
    const orderedModels = [...candidateModels].sort((a, b) => {
      const ca = uncooledCounts.get(a) || 0;
      const cb = uncooledCounts.get(b) || 0;
      if ((ca === 0) !== (cb === 0)) return ca === 0 ? 1 : -1;
      // Avoid bottlenecking concurrent workers on a model where >50% of keys hit 429 quota while another model is healthy
      const aDegraded = ca < Math.ceil(totalPoolKeys * 0.5) && cb > ca * 2;
      const bDegraded = cb < Math.ceil(totalPoolKeys * 0.5) && ca > cb * 2;
      if (aDegraded !== bDegraded) return aDegraded ? 1 : -1;
      return candidateModels.indexOf(a) - candidateModels.indexOf(b);
    });

    for (const modelName of orderedModels) {
      if ((blockedModelsUntil.get(modelName) || 0) > Date.now() && orderedModels.some(m => (blockedModelsUntil.get(m) || 0) <= Date.now())) {
        continue;
      }
      const scope = `api:${modelName}`;
      const keyCandidates = getGeminiApiKeyCandidates(apiKey, scope);
      if (keyCandidates.length === 0) continue;

      let switchModelImmediately = false;
      let rateLimitedKeys = 0;
      let dailyQuotaKeys = 0;
      let maxRpmCooldownMs = 0;
      let unreachErrors = 0;
      for (const candidateKey of keyCandidates) {
        if ((blockedModelsUntil.get(modelName) || 0) > Date.now() && orderedModels.some(m => m !== modelName && (blockedModelsUntil.get(m) || 0) <= Date.now())) {
          switchModelImmediately = true;
          break;
        }
        const stream = beginGeminiStream(candidateKey, streamTask);
        let succeeded = false;
        try {
          for (let netAttempt = 0; netAttempt < 3; netAttempt++) {
            try {
              if (netAttempt > 0) {
                await new Promise(r => setTimeout(r, 400 * netAttempt));
              }
              const result = await callGeminiSingleModel(modelName, prompt, candidateKey, extraParts, timeoutMs, options);
              blockedModelsUntil.delete(modelName);
              markGeminiKeyHealthy(candidateKey, scope);
              succeeded = true;
              stream.end(true, 200);
              return result;
            } catch (err) {
              lastError = err;
              const msg = String(err && err.message || '');
              const isTimeout = /ETIMEDOUT|timed out/i.test(msg);
              const isUnreachErr = /EHOSTUNREACH|ENETUNREACH|ENETRESET|ENOTFOUND|EAI_AGAIN/i.test(msg);
              const isSocketBlip = isUnreachErr || /ECONNRESET|ECONNREFUSED|ECONNABORTED|socket hang up|other side closed|disconnected before secure TLS|broken pipe/i.test(msg);
              if (isUnreachErr) {
                const badIpMatch = msg.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
                const badIp = (err && err.address) || (badIpMatch ? badIpMatch[1] : '');
                resetGeminiNetworkRoute(badIp);
              }
              if (isSocketBlip && netAttempt < 2) {
                continue;
              }
              const isKeyAuthErr = err.statusCode === 401 || err.statusCode === 403 || /api key not valid|api_key_invalid|unauthenticated|permission denied/i.test(msg);
              if (isKeyAuthErr) {
                for (const m of candidateModels) {
                  markGeminiKeyRateLimited(candidateKey, 15 * 60 * 1000, `api:${m}`);
                }
                markGeminiKeyRateLimited(candidateKey, 15 * 60 * 1000, 'general');
                if (keyCandidates.length > 1 || orderedModels.length > 1) {
                  switchModelImmediately = keyCandidates.length <= 1;
                  break;
                }
              }
              const isRateLimited = err.statusCode === 429 || /\b429\b|quota|rate[- ]?limit/i.test(msg);
              if (isRateLimited) {
                rateLimitedKeys++;
                const retryMatch = msg.match(/retry in\s+(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s\b/i);
                const retrySec = retryMatch
                  ? ((Number(retryMatch[1]) || 0) * 3600 + (Number(retryMatch[2]) || 0) * 60 + (parseFloat(retryMatch[3]) || 0))
                  : 0;
                const isDailyQuota = /PerDay|RequestsPerDay|TokensPerDay|\blimit:\s*0\b|daily/i.test(msg) || retrySec >= 300;
                if (isDailyQuota) dailyQuotaKeys++;
                const cooldownMs = isDailyQuota
                  ? 30 * 60 * 1000
                  : (retrySec > 0 ? Math.min(60000, Math.max(8000, Math.ceil(retrySec * 1000) + 1500)) : 25000);
                if (!isDailyQuota) {
                  maxRpmCooldownMs = Math.max(maxRpmCooldownMs, cooldownMs);
                }
                markGeminiKeyRateLimited(candidateKey, cooldownMs, scope);
                break;
              }
              const isTransientServerErr =
                err.statusCode === 500 ||
                err.statusCode === 502 ||
                err.statusCode === 504 ||
                /invalid response/i.test(msg);
              if (isTransientServerErr) {
                if (netAttempt < 1) {
                  continue;
                }
                switchModelImmediately = true;
                break;
              }
              const isPerRequestFallback = isTimeout || Boolean(err.isEmptyModelResponse);
              const isModelOutage =
                err.statusCode === 404 ||
                err.statusCode === 503 ||
                err.statusCode === 400 ||
                /no longer available|not found|not supported|deprecated|high demand|overloaded|unavailable/i.test(msg);
              if (isPerRequestFallback || isModelOutage) {
                const isSpecificModelOutage =
                  err.statusCode === 404 ||
                  err.statusCode === 503 ||
                  (err.statusCode === 400 && /model|not found|not supported|deprecated|invalid argument/i.test(msg)) ||
                  /no longer available|not found|not supported|deprecated|high demand|overloaded|unavailable/i.test(msg);
                // Block model globally ONLY on genuine outage/404/400 — not for a single safety/empty/timeout chunk!
                if (isSpecificModelOutage) {
                  blockedModelsUntil.set(modelName, Date.now() + ((err.statusCode === 404 || err.statusCode === 400) ? 10 * 60 * 1000 : 90 * 1000));
                }
                switchModelImmediately = true;
                break;
              }
              if (isSocketBlip) {
                if (isUnreachErr) {
                  unreachErrors++;
                  if (unreachErrors >= 2) {
                    err.isNetworkUnreachable = true;
                    throw err;
                  }
                }
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
      if (dailyQuotaKeys >= keyCandidates.length) {
        blockedModelsUntil.set(modelName, Date.now() + 30 * 60 * 1000);
      } else if (rateLimitedKeys >= keyCandidates.length) {
        // Transient RPM saturation across keys: cool down briefly (8-30s) instead of banning the model for 5 minutes
        const transientModelCooldownMs = Math.min(30000, Math.max(8000, maxRpmCooldownMs || 15000));
        blockedModelsUntil.set(modelName, Date.now() + transientModelCooldownMs);
      }
    }
    if (canUseRespan && !respanAttempted && !isRespanRateLimited()) {
      const respanOut = await tryCallRespanGateway(prompt, respanCfg, timeoutMs);
      if (respanOut.ok) return respanOut.text;
      lastError = respanOut.error || lastError;
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
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Google Translate stream aborted')));
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

  let googleTranslateBlockedUntil = 0;

  async function translateWithGoogleFallbackSafe(text, sourceLang = 'auto', targetLang = 'km', retries = 2) {
    if (Date.now() < googleTranslateBlockedUntil) {
      return '';
    }
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const raw = await googleTranslateText(text, sourceLang, targetLang);
        if (raw && String(raw).trim()) {
          return String(raw).trim();
        }
      } catch (err) {
        lastErr = err;
        if (/429|Too Many Requests/i.test(String(err && err.message || ''))) {
          googleTranslateBlockedUntil = Date.now() + 20000;
          break;
        }
      }
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)));
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

  function buildSpeechAudioFilterChain(isolateVocals = true, probeActivity = false) {
    if (isolateVocals && probeActivity) {
      // Run volumedetect BEFORE dynaudnorm so quiet/silent chunks keep true low loudness (-60dB) instead of getting boosted into false speech
      if (SPEECH_VOCAL_FILTER.includes(',dynaudnorm')) {
        return SPEECH_VOCAL_FILTER.replace(',dynaudnorm', ',volumedetect,dynaudnorm');
      }
      return `${SPEECH_VOCAL_FILTER},volumedetect`;
    }
    const filters = [];
    if (isolateVocals) filters.push(SPEECH_VOCAL_FILTER);
    if (probeActivity) filters.push('volumedetect');
    return filters.join(',');
  }

  function extractSpeechAudio(videoPath, outputPath, options = {}) {
    const { startSec = null, durationSec = null, isolateVocals = true, probeActivity = false, timeoutMs = 120000, onSpawn = null } = options;
    return new Promise((resolve, reject) => {
      const args = ['-nostdin', '-hide_banner', '-nostats', '-loglevel', probeActivity ? 'info' : 'error'];
      if (Number.isFinite(startSec) && startSec > 0) {
        args.push('-ss', String(startSec));
      }
      args.push('-i', videoPath);
      if (Number.isFinite(durationSec) && durationSec > 0) {
        args.push('-t', String(durationSec));
      }
      args.push('-vn');
      const filterExpr = buildSpeechAudioFilterChain(isolateVocals, probeActivity);
      if (filterExpr) {
        args.push('-af', filterExpr);
      }
      args.push('-ac', '1', '-ar', '16000', '-b:a', '40k', '-f', 'mp3', '-y', outputPath);

      const proc = spawn(FFMPEG_BIN, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      if (typeof onSpawn === 'function') {
        try { onSpawn(proc); } catch (_) { }
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill('SIGKILL'); } catch (_) { try { proc.kill(); } catch (_) { } }
        reject(new Error('FFmpeg speech extraction timed out.'));
      }, timeoutMs);

      let stderr = '';
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', chunk => {
        stderr += chunk;
        if (stderr.length > 32768) stderr = stderr.slice(-16384);
      });
      proc.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      proc.once('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          if (!probeActivity) return resolve();
          const meanMatch = stderr.match(/mean_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB/i);
          const maxMatch = stderr.match(/max_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB/i);
          if (!meanMatch && !maxMatch) {
            return resolve({ hasActivity: true, meanVolume: -20, maxVolume: -5 });
          }
          const parseDb = (m, fallback) => (!m ? fallback : (/inf/i.test(m[1]) ? -120 : parseFloat(m[1])));
          const meanVolume = parseDb(meanMatch, -20);
          const maxVolume = parseDb(maxMatch, -5);
          const isSilent = maxVolume < -75 && meanVolume < -95;
          return resolve({ hasActivity: !isSilent, meanVolume, maxVolume });
        }
        reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}.`));
      });
    });
  }

  function probeVideoDurationSec(videoPath) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (dur) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(dur);
      };
      const proc = spawn(FFMPEG_BIN, ['-nostdin', '-hide_banner', '-i', videoPath], { windowsHide: true });
      let stderr = '';
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) { try { proc.kill(); } catch (_) { } }
        finish(0);
      }, 10000);
      if (proc.stdout) proc.stdout.resume();
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', d => {
        if (stderr.length < 131072) stderr += d;
      });
      proc.once('error', () => finish(0));
      proc.once('close', () => {
        const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (!m) return finish(0);
        finish(parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]));
      });
    });
  }

  function probeAudioActivity(audioPath) {
    return new Promise((resolve) => {
      const proc = spawn(
        FFMPEG_BIN,
        ['-nostdin', '-hide_banner', '-i', audioPath, '-af', 'volumedetect', '-f', 'null', '-'],
        { windowsHide: true }
      );
      let stderr = '';
      if (proc.stdout) proc.stdout.resume();
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', d => {
        stderr += d;
        if (stderr.length > 32768) stderr = stderr.slice(-16384);
      });
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) { }
        resolve({ hasActivity: true, meanVolume: -20, maxVolume: -5 });
      }, 10000);
      proc.once('error', () => {
        clearTimeout(timer);
        resolve({ hasActivity: true, meanVolume: -20, maxVolume: -5 });
      });
      proc.once('close', () => {
        clearTimeout(timer);
        const meanMatch = stderr.match(/mean_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB/i);
        const maxMatch = stderr.match(/max_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB/i);
        if (!meanMatch && !maxMatch) {
          return resolve({ hasActivity: true, meanVolume: -20, maxVolume: -5 });
        }
        const parseDb = (m, fallback) => {
          if (!m) return fallback;
          return /inf/i.test(m[1]) ? -120 : parseFloat(m[1]);
        };
        const meanVolume = parseDb(meanMatch, -20);
        const maxVolume = parseDb(maxMatch, -5);
        const isSilent = maxVolume < -75 && meanVolume < -95;
        resolve({ hasActivity: !isSilent, meanVolume, maxVolume });
      });
    });
  }

  function calcTextBigramSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
    const setA = new Set();
    for (let i = 0; i < a.length - 1; i++) setA.add(a.slice(i, i + 2));
    let inter = 0;
    const setB = new Set();
    for (let i = 0; i < b.length - 1; i++) {
      const bg = b.slice(i, i + 2);
      if (!setB.has(bg)) {
        setB.add(bg);
        if (setA.has(bg)) inter++;
      }
    }
    const union = setA.size + setB.size - inter;
    return union > 0 ? inter / union : 0;
  }

  function deduplicateOverlappingSegments(segments) {
    const sorted = [...(Array.isArray(segments) ? segments : [])].sort((a, b) => a.startSec - b.startSec);
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const deduped = [];
    for (const seg of sorted) {
      const segNorm = norm(seg.text);
      const dupIdx = deduped.findIndex((prev) => {
        if (prev.chunkIndex === seg.chunkIndex) return false;
        if (seg.startSec > prev.endSec + 0.6 || Math.abs(seg.startSec - prev.startSec) > 2.8) return false;
        const prevNorm = norm(prev.text);
        if (!prevNorm || !segNorm) return false;
        if (prevNorm === segNorm || (Math.min(prevNorm.length, segNorm.length) >= 2 && (prevNorm.includes(segNorm) || segNorm.includes(prevNorm)))) {
          return true;
        }
        const overlapStart = Math.max(prev.startSec, seg.startSec);
        const overlapEnd = Math.min(prev.endSec, seg.endSec);
        const overlapDur = Math.max(0, overlapEnd - overlapStart);
        const minDur = Math.max(0.2, Math.min(prev.endSec - prev.startSec, seg.endSec - seg.startSec));
        const nearSimultaneous = Math.abs(seg.startSec - prev.startSec) <= 0.9 || (overlapDur / minDur) >= 0.55;
        return nearSimultaneous && calcTextBigramSimilarity(prevNorm, segNorm) >= 0.35;
      });
      if (dupIdx === -1) {
        deduped.push(seg);
        continue;
      }
      const existing = deduped[dupIdx];
      if (seg.text.length > existing.text.length) {
        deduped[dupIdx] = {
          ...seg,
          startSec: Math.min(existing.startSec, seg.startSec),
          endSec: Math.max(existing.endSec, seg.endSec)
        };
      } else {
        existing.endSec = Math.max(existing.endSec, seg.endSec);
      }
    }
    return deduped;
  }

  function probeSpeechGapActivity(mediaPath, startSec, endSec) {
    return new Promise((resolve) => {
      const dur = Math.max(0.1, Number(endSec) - Number(startSec));
      const timeoutMs = Math.min(60000, Math.max(10000, Math.ceil(dur * 300)));
      const args = [
        '-nostdin', '-hide_banner', '-nostats', '-loglevel', 'info',
        '-ss', String(Math.max(0, startSec).toFixed(3)),
        '-t', String(dur.toFixed(3)),
        '-i', mediaPath,
        '-vn',
        '-af', 'highpass=f=120,lowpass=f=4800,volumedetect,silencedetect=n=-38dB:d=0.6',
        '-f', 'null', '-'
      ];
      let settled = false;
      const proc = spawn(FFMPEG_BIN, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      const finish = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      };
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) { try { proc.kill(); } catch (_) { } }
        finish({ hasSpeech: false, activeSec: 0, maxVolume: -90, meanVolume: -90 });
      }, timeoutMs);
      let stderr = '';
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', d => {
        stderr += d;
        if (stderr.length > 32768) stderr = stderr.slice(-16384);
      });
      proc.once('error', () => finish({ hasSpeech: false, activeSec: 0, maxVolume: -90, meanVolume: -90 }));
      proc.once('close', () => {
        const meanMatch = stderr.match(/mean_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB/i);
        const maxMatch = stderr.match(/max_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB/i);
        const parseDb = (m, fb) => (!m ? fb : (/inf/i.test(m[1]) ? -120 : parseFloat(m[1])));
        const meanVolume = parseDb(meanMatch, -90);
        const maxVolume = parseDb(maxMatch, -90);
        let silentSec = 0;
        for (const m of stderr.matchAll(/silence_duration:\s*([\d.]+)/g)) {
          silentSec += parseFloat(m[1]) || 0;
        }
        const activeSec = Math.max(0, dur - silentSec);
        const hasSpeech = activeSec >= 1.2 && maxVolume >= -45 && meanVolume >= -58;
        finish({ hasSpeech, activeSec, maxVolume, meanVolume });
      });
    });
  }

  const SPEECH_CHUNK_OVERLAP_SEC = 2.5;

  async function extractSpeechAudioChunks(videoPath, tempDirectory, options = {}) {
    const {
      isolateVocals = true,
      probeActivity = false
    } = options;
    const totalDur = await probeVideoDurationSec(videoPath);

    let recommendedChunkSec = DEFAULT_SPEECH_CHUNK_SEC;
    const requestedChunkSec = Number(options.chunkDurationSec);
    const hasCustomChunkSec = Number.isFinite(requestedChunkSec) && requestedChunkSec > 0 && requestedChunkSec !== DEFAULT_SPEECH_CHUNK_SEC;
    if (!hasCustomChunkSec) {
      if (totalDur > 600) {
        // Compact 45s chunks prevent late-chunk attention drop on long dramas
        recommendedChunkSec = 45;
      }
    }
    const safeChunkSec = Math.max(30, Math.min(600, hasCustomChunkSec ? requestedChunkSec : recommendedChunkSec));

    if (totalDur <= safeChunkSec) {
      const singlePath = path.join(tempDirectory, 'speech_0.mp3');
      const activity = await extractSpeechAudio(videoPath, singlePath, { isolateVocals, probeActivity });
      if (typeof options.onProgress === 'function') {
        options.onProgress(1, 1);
      }
      return [{ index: 0, offsetSec: 0, audioPath: singlePath, activity: activity || null }];
    }

    const jobs = [];
    let idx = 0;
    for (let offset = 0; offset < totalDur - 0.1; offset += safeChunkSec) {
      jobs.push({
        idx,
        offsetSec: offset,
        durationSec: Math.min(safeChunkSec + SPEECH_CHUNK_OVERLAP_SEC, totalDur - offset),
        chunkPath: path.join(tempDirectory, `speech_${idx}.mp3`)
      });
      idx++;
    }

    const chunkResults = new Array(jobs.length).fill(null);
    let jobCursor = 0;
    let extractedCount = 0;
    let aborted = false;
    const activeExtractProcs = new Set();
    const extractWorkers = Math.min(6, jobs.length || 1);
    try {
      await Promise.all(Array.from({ length: extractWorkers }, async () => {
        while (!aborted && jobCursor < jobs.length) {
          const job = jobs[jobCursor++];
          const activity = await extractSpeechAudio(videoPath, job.chunkPath, {
            startSec: job.offsetSec,
            durationSec: job.durationSec,
            isolateVocals,
            probeActivity,
            onSpawn: (p) => {
              if (!p) return;
              if (aborted) {
                try { p.kill('SIGKILL'); } catch (_) { }
                return;
              }
              activeExtractProcs.add(p);
              const dropProc = () => activeExtractProcs.delete(p);
              p.once('close', dropProc);
              p.once('error', dropProc);
            }
          });
          extractedCount++;
          if (typeof options.onProgress === 'function') {
            options.onProgress(extractedCount, jobs.length);
          }
          if (fs.existsSync(job.chunkPath) && fs.statSync(job.chunkPath).size > 0) {
            chunkResults[job.idx] = { index: job.idx, offsetSec: job.offsetSec, audioPath: job.chunkPath, activity: activity || null };
          }
        }
      }));
    } catch (err) {
      aborted = true;
      for (const proc of activeExtractProcs) {
        try {
          if (process.platform === 'win32' && proc.pid) {
            spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          }
          proc.kill('SIGKILL');
        } catch (_) { }
      }
      activeExtractProcs.clear();
      await new Promise(r => setTimeout(r, 40));
      throw err;
    }
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
          } catch (_) { }
          objStart = -1;
        }
      }
    }
    return objects;
  }

  function parseJsonObject(response, label) {
    const cleaned = String(response || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    const arrStart = cleaned.indexOf('[');
    const arrEnd = cleaned.lastIndexOf(']');

    const tryParseTopLevelArray = () => {
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
          } catch (_) { }
        }
      }
      return null;
    };

    if (arrStart >= 0 && (start === -1 || arrStart < start)) {
      const arrResult = tryParseTopLevelArray();
      if (arrResult) return arrResult;
    }

    // 1. Direct JSON object parse (with trailing-comma tolerance)
    if (start >= 0 && end > start) {
      const objSlice = cleaned.slice(start, end + 1);
      for (const candidate of [objSlice, stripTrailingCommasOutsideStrings(objSlice)]) {
        try {
          return JSON.parse(candidate);
        } catch (_) { }
      }
    }

    // 2. Top-level JSON array parse fallback -> wrap for translations, frames, and segments
    const arrResult = tryParseTopLevelArray();
    if (arrResult) return arrResult;

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
    const suffixRe = new RegExp(`([\\u1780-\\u17D3\\u17D7\\u17DD])\\s+(${boundSuffixes})(?=[\\s។!?៖,，。！？]|$)`, 'g');
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

  const KHMER_UNIT_CONVERSION_RULES = [
    [/(\d+(?:[.,]\d+)*)\s*(?:kg|KG|Kg)\b/g, '$1 គីឡូក្រាម'],
    [/(\d+(?:[.,]\d+)*)\s*(?:km|KM|Km)\b/g, '$1 គីឡូម៉ែត្រ'],
    [/(\d+(?:[.,]\d+)*)\s*(?:cm|CM)\b/g, '$1 សង់ទីម៉ែត្រ'],
    [/(\d+(?:[.,]\d+)*)\s*(?:mm|MM)\b/g, '$1 មីលីម៉ែត្រ'],
    [/(\d+(?:[.,]\d+)*)\s*(?:mg|MG)\b/g, '$1 មីលីក្រាម'],
    [/(\d+(?:[.,]\d+)*)\s*(?:ml|ML|mL)\b/g, '$1 មីលីលីត្រ'],
    [/(\d+(?:[.,]\d+)*)\s*g\b/g, '$1 ក្រាម'],
    [/\$\s*(\d+(?:[.,]\d+)*)(?:\s*(?:USD|usd|ដុល្លារ))?(?![A-Za-z0-9])/g, '$1 ដុល្លារ'],
    [/฿\s*(\d+(?:[.,]\d+)*)(?:\s*(?:THB|thb|បាត))?(?![A-Za-z0-9])/g, '$1 បាត'],
    [/₩\s*(\d+(?:[.,]\d+)*)(?:\s*(?:KRW|krw|វ៉ុន))?(?![A-Za-z0-9])/g, '$1 វ៉ុន'],
    [/€\s*(\d+(?:[.,]\d+)*)(?:\s*(?:EUR|eur|អឺរ៉ូ))?(?![A-Za-z0-9])/g, '$1 អឺរ៉ូ'],
    [/£\s*(\d+(?:[.,]\d+)*)(?:\s*(?:GBP|gbp|ផោន))?(?![A-Za-z0-9])/g, '$1 ផោន'],
    [/(\d+(?:[.,]\d+)*)\s*(?:USD|usd)\b/g, '$1 ដុល្លារ'],
    [/(\d+(?:[.,]\d+)*)\s*(?:RMB|CNY|rmb|cny)\b/g, '$1 យ័ន'],
    [/(\d+(?:[.,]\d+)*)\s*(?:THB|thb)\b/g, '$1 បាត'],
    [/(\d+(?:[.,]\d+)*)\s*(?:JPY|jpy)\b/g, '$1 យ៉េន'],
    [/(\d+(?:[.,]\d+)*)\s*(?:KRW|krw)\b/g, '$1 វ៉ុន'],
    [/(\d+(?:[.,]\d+)*)\s*(?:EUR|eur)\b/g, '$1 អឺរ៉ូ'],
    [/(\d+(?:[.,]\d+)*)\s*(?:GBP|gbp)\b/g, '$1 ផោន'],
    [/(\d+(?:[.,]\d+)*)\s*(?:VND|vnd)\b/g, '$1 ដុង'],
    [/(\d+(?:[.,]\d+)*)\s*(?:KHR|khr)\b/g, '$1 រៀល']
  ];

  /**
   * Normalize Khmer numbers, clock times, currencies, weights, and unit spacing:
   * use uniform 0-9 digits, fix "យាន់" currency typos, expand unit codes to Khmer,
   * and keep crisp single spacing between digits and Khmer unit nouns.
   */
  function normalizeKhmerNumericText(text) {
    let s = String(text || '');
    if (!s) return s;

    // Convert Khmer Unicode digits ០-៩ to ASCII 0-9 for clean, consistent numbers
    s = s.replace(/[\u17E0-\u17E9]/g, ch => String(ch.charCodeAt(0) - 0x17E0));

    // Keep clock timestamps tight (e.g. "7: 30" -> "7:30")
    s = s.replace(/(?<=\d):\s+(?=\d{1,2}(?!\d))/g, ':');

    for (const [pattern, replacement] of KHMER_UNIT_CONVERSION_RULES) {
      s = s.replace(pattern, replacement);
    }

    // Fix common misspelling "យាន់" -> "យ័ន" in numeric or money contexts (leaves valid "យាន់" untouched)
    s = s
      .replace(
        /((?:\d+(?:[.,]\d+)*|(?:រយ|ពាន់|ម៉ឺន|សែន|លាន|ប៊ីលាន|កោដិ))\s*)យាន់(?=$|[\s។!?៖,.\-"'()»\]…]|នេះ|នោះ|ទេ|ដែរ|ផង|ទៀត|បាត់|ទៅ|ឯណោះ)/g,
        '$1យ័ន'
      )
      .replace(
        /(^|[\s«(\["'។!?៖,])((?:លុយ|ប្រាក់|តម្លៃ|ថ្លៃ)\s+)យាន់(?=$|[\s។!?៖,.\-"'()»\]…]|នេះ|នោះ|ទេ|ដែរ|ផង|ទៀត|បាត់|ទៅ|ឯណោះ)/g,
        '$1$2យ័ន'
      );

    // Separate digits cleanly from Khmer nouns/units while keeping "ទី1" compact
    s = s
      .replace(/(\d)(?=[\u1780-\u17FF])/g, '$1 ')
      .replace(/(?<=[\u1780-\u17FF])(?<!ទី)(?=\d)/g, ' ');

    return s.replace(/\s{2,}/g, ' ').trim();
  }

  const KHMER_NATURAL_LEFTOVER_FOOD_RULES = [
    [/បាយ\s*កាក\s*សំណល់|បាយ\s*សំណល់|កាក\s*សំណល់\s*បាយ|សំណល់\s*បាយ/g, 'បាយដែលនៅសល់'],
    [/ម្ហូប\s*កាក\s*សំណល់|ម្ហូប\s*សំណល់|កាក\s*សំណល់\s*ម្ហូប|សំណល់\s*ម្ហូប/g, 'ម្ហូបដែលនៅសល់'],
    [/កាក\s*សំណល់\s*អាហារ|សំណល់\s*អាហារ/g, 'អាហារដែលនៅសល់']
  ];

  const KHMER_TRASH_CONTEXT_RE = /ធុង\s*សំរាម|ឡាន\s*សំរាម|កន្លែង\s*ចាក់\s*សំរាម|បោះ\s*ចោល\s*ក្នុង/;
  const KHMER_ANIMAL_FEED_CONTEXT_RE = /(?:ឆ្កែ|ឆ្មា|សត្វ(?:ចិញ្ចឹម)?|ចំណី\s*(?:សល់ៗ?|ដែលនៅសល់)\s*(?:ឲ្យ|ឱ្យ|សម្រាប់)?\s*(?:ឆ្កែ|ឆ្មា|ជ្រូក|មាន់|ទា|ត្រី|សត្វ)|(?:ឲ្យ|ឱ្យ|ចាក់|ដាក់|បោះ)\s*(?:ឲ្យ|ឱ្យ)?\s*(?:ឆ្កែ|ឆ្មា|ជ្រូក|មាន់|សត្វ)|ចិញ្ចឹម\s*(?:ឆ្កែ|ឆ្មា|ជ្រូក|មាន់|ទា|ត្រី|គោ|ក្របី|សត្វ))/;

  const KHMER_UNNATURAL_WORD_RULES = [
    [/សារ៉ាម៉ាន់/g, 'នំប៉ាវស'],
    [/សាច់\s*ដុំ\s*គោ/g, 'សាច់ភ្លៅគោ'],
    [/ខរ\s*ម្ងាស់|ខរម្ងាស់/g, 'ស្ងោររម្ងាស់'],
    [/ពិត\s*ស្តែង|ពិត\s*ស្ដែង/g, 'តាមពិត']
  ];

  /**
   * Replace overly literal trash-sounding calques (e.g. "ទុកសំណល់អាហារ", "ញ៉ាំបាយកាកសំណល់")
   * and unambiguous unnatural real-life word blunders (e.g. "ចំណីសល់" for human meals, "សារ៉ាម៉ាន់",
   * "សាច់ដុំគោ", "ខរម្ងាស់", "ពិតស្តែង") with natural Cambodian Khmer phrasing,
   * while keeping actual trash-bin disposal and animal-feeding contexts intact.
   */
  function normalizeKhmerNaturalDramaWordChoice(text) {
    let s = String(text || '');
    if (!s) return s;

    if (!KHMER_TRASH_CONTEXT_RE.test(s)) {
      for (const [pattern, replacement] of KHMER_NATURAL_LEFTOVER_FOOD_RULES) {
        s = s.replace(pattern, replacement);
      }
      if (!KHMER_ANIMAL_FEED_CONTEXT_RE.test(s)) {
        s = s.replace(/ចំណី\s*សល់ៗ|ចំណី\s*សល់/g, 'ម្ហូបសល់');
      }
    }

    for (const [pattern, replacement] of KHMER_UNNATURAL_WORD_RULES) {
      s = s.replace(pattern, replacement);
    }
    return s;
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
    if (/[\u1780-\u17FF][A-Za-z]{1,8}|(?:^|[\s\u1780-\u17FF])[a-z]{1,4}[\u1780-\u17FF]/.test(tr)) {
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
    if (targetLang === 'zh-km' || targetLang === 'en-km') {
      const pipeIdx = out.indexOf('|');
      if (pipeIdx !== -1) {
        const left = out.slice(0, pipeIdx).trim();
        const right = cleanTranslatedText(out.slice(pipeIdx + 1).trim(), 'km');
        return `${left} | ${right}`.trim();
      }
      if (/[\u1780-\u17FF]/.test(out)) {
        return cleanTranslatedText(out, 'km');
      }
      return out.replace(/\s{2,}/g, ' ').trim();
    }
    if (targetLang === 'km') {
      out = normalizeCjkPunctuationToKhmer(out)
        .replace(/[（(][^()（）]*[\u2E80-\u9FFF\uAC00-\uD7AF\u{20000}-\u{2FA1F}][^()（）]*[)）]/gu, ' ')
        .replace(/\u200B+/g, '')
        .replace(/[\u0E00-\u109F]+/g, ' ')
        .replace(CJK_FOREIGN_SCRIPT_GLOBAL_RE, ' ')
        .replace(/[\u0400-\u052F\u0590-\u06FF\u0900-\u0DFF]+/g, ' ')
        .replace(/[\u00C0-\u024F\u1E00-\u1EFF]+/g, ' ')
        .replace(new RegExp(CJK_FULLWIDTH_PUNCT_RE.source, 'g'), ' ')
        .replace(/[（(]\s*[)）]/g, ' ')
        .replace(/«\s*»/g, ' ')
        .replace(/\[\s*\]/g, ' ');
      out = normalizeKhmerChuonNath(out);
      out = normalizeKhmerNaturalDramaWordChoice(out);
      out = normalizeKhmerNumericText(out);
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
      if (CJK_FOREIGN_SCRIPT_RE.test(tr) || /[\u0E00-\u0E7F]/.test(tr)) return true;
      if (!hasKhmer && (CJK_FOREIGN_SCRIPT_RE.test(src) || CJK_FULLWIDTH_PUNCT_RE.test(src) || /[A-Za-z\u0E00-\u0E7F]/.test(src))) return true;
      if (tr === src && src.length > 0 && !/^[\d\s.,!?\-'"()…]+$/.test(src)) return true;
    } else if (targetLang === 'zh-km' || targetLang === 'en-km') {
      const pipeIdx = tr.indexOf('|');
      const khHalf = pipeIdx !== -1 ? tr.slice(pipeIdx + 1).trim() : tr;
      const needsTranslation = CJK_FOREIGN_SCRIPT_RE.test(src) || CJK_FULLWIDTH_PUNCT_RE.test(src) || /[A-Za-z\u0E00-\u0E7F]/.test(src);
      if (needsTranslation && !/[\u1780-\u17FF]/.test(khHalf)) return true;
      if (hasCorruptedKhmerText(khHalf)) return true;
      if (CJK_FOREIGN_SCRIPT_RE.test(khHalf) || /[\u0E00-\u0E7F]/.test(khHalf)) return true;
      if (tr === src && src.length > 1) return true;
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
        chunkDurationSec: 180,
        isolateVocals: true
      });
      if (!Array.isArray(chunks) || chunks.length === 0) {
        return { usedAudio: false, assignedCount: 0 };
      }

      await mapWithConcurrency(chunks, 4, async (chunk, cIdx) => {
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
        if (chunkEntries.length === 0) return;

        let audioBuf;
        try {
          audioBuf = await fs.promises.readFile(chunk.audioPath);
        } catch (_) {
          return;
        }
        if (!audioBuf || audioBuf.length === 0 || audioBuf.length > MAX_SPEECH_AUDIO_BYTES) return;

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
      });
      return { usedAudio: assignedCount > 0, assignedCount };
    } catch (err) {
      console.warn('[translation/audio-cast] extraction fallback:', err.message);
      return { usedAudio: false, assignedCount: 0 };
    } finally {
      if (tempDirectory) {
        try {
          fs.rmSync(tempDirectory, { recursive: true, force: true });
        } catch (_) { }
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

    const femalePool = ['Radiant Queen', 'kh_young_girl', 'kh_elder_woman', 'kh_child'];
    const malePool = ['Sovereign King', 'kh_young_man', 'kh_deep_boss', 'kh_narrator_fast'];
    const isFemaleVoice = v => femalePool.includes(v) || (voiceCloner.isCustomCloneVoiceId(v) && isFemaleVoicePreset(v));
    const isMaleVoice = v => malePool.includes(v) || (voiceCloner.isCustomCloneVoiceId(v) && !isFemaleVoicePreset(v));

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

  const SHORT_DRAMA_IDIOMS_GUIDE =
    'Translate Chinese short-drama slang, idioms, titles, and conversational subtext into natural, vivid Cambodian drama speech (NEVER literal translation): ' +
    '"白月光" => ស្រីក្នុងបេះដូង / ស្នេហាដំបូង; "朱砂痣" => ស្នាមស្នេហ៍ដក់ជាប់ចិត្ត; "绿茶/绿茶婊" => ស្រីពុតត្បុត / ស្រីមុខក្រាស់; ' +
    '"心机女" => ស្រីពិសពុល; "渣男" => មនុស្សប្រុសសាវា / ប្រុសព្រាន; "海王" => ប្រុសព្រានជើងកាង; "小三/情妇" => ស្រីទីបី / ស្រីកំណាន់; ' +
    '"正室/原配" => ប្រពន្ធដើម; "替身" => តួជំនួសស្នេហ៍; "碰瓷" => ធ្វើស៊ី / រៀបគម្រោងទារលុយ; "领证" => ចុះសំបុត្រអាពាហ៍ពិពាហ៍; ' +
    '"离婚协议书" => កិច្ចព្រមព្រៀងលែងលះ; "净身出户" => ចាកចេញដោយដៃទទេ; "门当户对" => គ្រួសារមានឋានៈស្មើគ្នា; "豪门/财阀" => ត្រកូលអភិជន; ' +
    '"霸道总裁" => អគ្គនាយកមានឥទ្ធិពល / មហាសេដ្ឋីផ្តាច់ការ; "打脸" => ធ្វើឱ្យបាក់មុខ / បកអាក្រាត; "扮猪吃老虎" => ពុតជាល្ងង់ដើម្បីស៊ីត្រីក្រាញ់; ' +
    '"狗眼看人低" => មើលងាយមនុស្ស; "忘恩负义" => រមិលគុណ / ស៊ីបាយបោកឆ្នាំង; "吃醋" => ប្រចណ្ឌ; "戴绿帽子" => ក្បត់ចិត្ត / លួចមានប្រុសថ្មី; ' +
    '"包养" => ចិញ្ចឹមធ្វើស្រីកំណាន់; "亲子鉴定" => ធ្វើតេស្ត DNA; "植物人" => សន្លប់បាត់ស្មារតីយូរអង្វែង; "流产" => រលូតកូន; ' +
    '"剩饭/剩菜/剩餐/留残渣 (kept leftover meals, NOT trash)" => អាហារដែលនៅសល់ / បាយម្ហូបដែលនៅសល់ / ម្ហូបសល់ (NEVER harsh literal "សំណល់អាហារ" or "បាយកាកសំណល់" unless talking about garbage thrown in a bin); ' +
    'Conversational dialogue subtext: ONLY standalone 1-2 word reply "问啊 / 没问啊" (answering why-not) => ធ្លាប់សួរតើ! (NEVER apply "ធ្លាប់សួរតើ" to "问他/问她/问唐" + verb/clause where 问 is an STT homophone for character surname 温 e.g. "问他回来以后..." => វិន ថាំង ពេលត្រឡប់មកវិញ...); "算了" => បណ្ដោយទៅ / មិនអីទេ; "活该" => សមមុខហើយ!; ' +
    '"凭什么" => អាងអី?! / មានសិទ្ធិអី?!; "给我等着" => ចាំមើលទៅ!; "到底想干嘛" => ចង់បានស្អីឱ្យប្រាកដ?!; "敬酒不吃吃罚酒" => និយាយស្រួលៗមិនស្តាប់ ចង់ឱ្យប្រើហិង្សា!; ' +
    'Transliterate Chinese titles & surnames into pure Khmer script (e.g. 顾总 => លោកប្រធាន គូ, 傅总 => លោកប្រធាន ហ្វូ, 陆少 => លោកប្រុស លូ, 苏小姐 => កញ្ញា ស៊ូ, 沈董 => លោកប្រធាន សិន, 林特助 => ជំនួយការ លីន). NEVER leave raw Chinese characters or Latin Pinyin.';

  const KHMER_NUMERIC_AND_UNITS_GUIDE =
    'NUMBERS, COUNTRY CURRENCIES, WEIGHTS, TIME & QUANTITIES (MANDATORY FOR KHMER): ' +
    '(1) Always write ALL counts, numbers, ages, floors, dates, and measurements using Arabic digits (0-9), NEVER spelled-out Khmer words ' +
    '(e.g. write "15 នាទី", "182 ថ្ងៃ", "4,000 យ័ន", "600 លាន", "មនុស្ស 3 នាក់", "ម្ហូប 7 មុខ", "50%", ' +
    'NEVER "ដប់ប្រាំនាទី", "មួយរយប៉ែតសិបពីរថ្ងៃ", "បួនពាន់", "ប្រាំមួយរយលាន", or "មនុស្សបីនាក់"; ' +
    'keep Khmer wording ONLY for non-counting idioms like តែម្នាក់ឯង, មួយភ្លែត, ម្ដងទៀត). ' +
    '(2) Clarify exact country currency matching the story setting (NEVER misspell យ័ន as "យាន់"): ' +
    'China 块/元/人民币 -> យ័ន (exact spelling យ័ន), US 美元/美金/$ -> ដុល្លារ, Cambodia -> រៀល, Thailand 泰铢/铢 -> បាត, Korea 韩元 -> វ៉ុន, Japan 日元 -> យ៉េន, Europe -> អឺរ៉ូ, UK -> ផោន, Vietnam -> ដុង; ' +
    'convert Chinese multipliers accurately: 1 万 = 10,000 (1 ម៉ឺន), 10 万 = 100,000, 1 亿 = 100 លាន, 6个亿 = 600 លានយ័ន. ' +
    '(3) Convert weight, distance & volume accurately using digits + full Khmer units (never leave abbreviations like kg/km): ' +
    '1 斤 = 0.5 គីឡូក្រាម (so 20 斤 = 10 គីឡូក្រាម, NOT 20 គីឡូក្រាម!), 1 公斤 = 1 គីឡូក្រាម, 1 两 = 50 ក្រាម, 克 = ក្រាម, 吨 = តោន, ' +
    '1 公里 = 1 គីឡូម៉ែត្រ, 1 里 = 500 ម៉ែត្រ, 米 = ម៉ែត្រ, 厘米 = សង់ទីម៉ែត្រ, 升 = លីត្រ. ' +
    '(4) Clock time & duration MUST use digits: "ម៉ោង 7:30", "ម៉ោង 6", "ម៉ោង 8 យប់", "2 ម៉ោង", "15 នាទី" (NEVER "ម៉ោងប្រាំពីរកន្លះ"). ' +
    '(5) Quantities & counts MUST use digits + natural Khmer classifiers: "មនុស្ស 3 នាក់", "ចានចង្កឹះ 3 ឈុត", "ម្ហូប 7 មុខ", "10 កេស", "2 កែវ".';

  const KHMER_REAL_LIFE_NATURAL_SPEECH_GUIDE =
    'Real-life Spoken Cambodian Dialogue ONLY (NEVER stiff textbook, courtroom, or essay prose): ' +
    '(1) Replace stiff essay/bureaucratic calques with daily spoken Khmer: ' +
    '"ទៀតសោត/ខណៈពេលដែល/ដោយហេតុថា/ក្នុងឆាកជីវិត" => natural daily phrasing ("ហើយម្យ៉ាងទៀត/ពេលកំពុង.../ព្រោះតែ.../ក្នុងជីវិត"); ' +
    '"ជារៀងរាល់ថ្ងៃ" => "រាល់ថ្ងៃ"; "តើ...ដែរឬទេ?" => "...មែនទេ? / ...អត់?"; ' +
    '"ប្រាក់បេឡាជាតិសន្តិសុខសង្គម/ការធានារ៉ាប់រង" => "ធានារ៉ាប់រងសង្គម"; ' +
    '"ទ្រព្យសម្បត្តិមុនអាពាហ៍ពិពាហ៍ / 婚前房产" => "ផ្ទះទិញមុនការ / ទ្រព្យមុនការ"; ' +
    '"ជុំវិញតុអាហារ" => "ជុំតុបាយ"; "លាងចានឲ្យម្នាក់ៗពេញមួយផ្ទះ" => "លាងចានឲ្យមួយផ្ទះទាំងមូល"; "រៀបការចូលផ្ទះ" => "ការចូលផ្ទះ"; ' +
    '(2) Daily human meals & dishes — NEVER use animal-feed or nonsense words: ' +
    'human leftovers => "ម្ហូបសល់ / អាហារដែលនៅសល់" (NEVER "ចំណីសល់"); "馒头" => "នំប៉ាវស / នំប៉័ងចំហុយ" (NEVER hallucinated "សារ៉ាម៉ាន់"); ' +
    '"牛腱子" => "សាច់ភ្លៅគោ / សាច់គោ" (NEVER "សាច់ដុំគោ"); "排骨炖的烂" => "ស្ងោរឆ្អឹងជំនីររម្ងាស់" (NEVER invalid "ខរម្ងាស់"); "可这..." => "តែតាមពិត" (NEVER "ពិតស្តែង"); ' +
    '(3) Restaurant, shop & company proper names MUST keep transliterated proper names rather than translating literally (e.g. "夜记海鲜" => "ហាងគ្រឿងសមុទ្រ យ៉េជី", NEVER "ហាងគ្រឿងសមុទ្រយប់ជ្រៅ"); ' +
    '(4) Authentic Cambodian family kinship, single-pronoun consistency & common-sense STT fixes: ' +
    'wife speaking to husband about his own mother ("你妈") => "ម៉ាក់បង / ម៉ាក់" (NEVER "អ៊ំស្រី"); ' +
    'keep ONE consistent pronoun for the same addressee within a scene (do NOT flip between អូន, គាត់, and នាង); ' +
    'and use common sense to fix impossible STT homophones (e.g. a young child/grandson saying "我八十了" is an STT error, not age 80; "很快乐" when leaving means "很快了 / ជិតរួចហើយ", not "សប្បាយ"; "问他/问她/问唐" before a clause is surname 温糖 "វិន ថាំង", NOT "ធ្លាប់សួរតើ"); ' +
    '(5) Spoken Timing & Brevity Budget: match Cambodian spoken syllable length to each item\'s "sec" duration so dubbing sounds natural without rushing — for short cues ("sec" < 2.2), use crisp daily spoken phrasing and omit filler padding ("ដើម្បីឲ្យ...", "ពិតជា...មែន", "អស់ទាំងនេះ", "ប្រកបដោយ") while keeping 100% of emotional impact.';

  function getPromptLanguageMeta(targetLang) {
    const meta = {
      km: {
        renderingName: 'Khmer',
        editorRole: 'an expert Cambodian TV-drama dubbing director and scriptwriter',
        formatHint: ` Write strictly in pure Khmer Unicode script (ក-អ); never mix Thai or English letters. ${CHUON_NATH_PROMPT_GUIDE} ${KHMER_NUMERIC_AND_UNITS_GUIDE} ${SHORT_DRAMA_IDIOMS_GUIDE} ${KHMER_REAL_LIFE_NATURAL_SPEECH_GUIDE} Follow proper Cambodian Khmer spacing: do NOT insert spaces between every single word—write connected Khmer phrases naturally without spaces (e.g., នោះគ្រាន់តែជានាឡិកាដៃមួយគ្រឿងប៉ុណ្ណោះ), inserting spaces ONLY between clauses, after punctuation, or where standard Khmer writing requires a pause. Use vivid, emotional, natural spoken Cambodian dialogue (e.g. ណា៎!, ទេអ្ហី!, ម៉េចក៏..., មែនទេ?, ចាស៎, បាទ, ហ្នឹង!) so it sounds like real actors speaking with emotion rather than stiff textbook translation.`
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

  function getSeriesGlossaryDir() {
    return process.env.SERIES_GLOSSARY_DIR || path.join(__dirname, '..', '..', '..', 'series_glossaries');
  }

  const GENERIC_SERIES_DIR_NAMES = new Set(['uploads', 'temp', 'tmp', 'downloads', 'desktop', 'ezarg', '.']);

  /**
   * Derives a stable series glossary key from an explicit seriesKey or a drama folder path,
   * ignoring transient upload/temp/root directories so unrelated videos never cross-contaminate.
   */
  function resolveSeriesGlossaryKey(videoPath, explicitSeriesKey = '') {
    const manual = String(explicitSeriesKey || '').trim();
    if (manual) return manual.toLowerCase();
    const rawPath = String(videoPath || '').trim();
    if (!rawPath) return '';
    const resolved = path.resolve(rawPath);
    const dir = path.dirname(resolved);
    const tmpRoot = path.resolve(os.tmpdir()).toLowerCase();
    if (!dir || dir === path.parse(dir).root || dir.toLowerCase().startsWith(tmpRoot)) return '';
    const dirBase = path.basename(dir).toLowerCase();
    if (!dirBase || GENERIC_SERIES_DIR_NAMES.has(dirBase)) return '';
    return dir.toLowerCase();
  }

  function getSeriesGlossaryPath(seriesKey, targetLang = 'km') {
    if (!seriesKey) return '';
    const hash = crypto.createHash('sha1').update(`${targetLang}:${seriesKey}`).digest('hex').slice(0, 20);
    return path.join(getSeriesGlossaryDir(), `${hash}.json`);
  }

  function loadSeriesGlossary(seriesKey, targetLang = 'km') {
    const filePath = getSeriesGlossaryPath(seriesKey, targetLang);
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) { }
    return null;
  }

  function saveSeriesGlossary(seriesKey, targetLang, glossary) {
    const filePath = getSeriesGlossaryPath(seriesKey, targetLang);
    if (!filePath || !glossary || typeof glossary !== 'object') return false;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      const payload = { ...glossary, synopsis: '', seriesKey, targetLang, updatedAt: Date.now() };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
      return true;
    } catch (_) {
      return false;
    }
  }

  function normalizeGlossaryToken(s) {
    return String(s || '').replace(/\s+/g, '').trim().toLowerCase();
  }

  /**
   * Merges a new episode Story Bible with a prior Series Glossary.
   * Previously locked character renderings, relationship pronouns, shop terms, and STT fixes
   * take precedence so character names never drift between episodes (e.g. អ៊ីង អ៊ីង vs យីង យីង).
   */
  function mergeStoryBibleWithSeries(baseGlossary, episodeBible) {
    const base = baseGlossary && typeof baseGlossary === 'object' ? baseGlossary : {};
    const ep = episodeBible && typeof episodeBible === 'object' ? episodeBible : {};
    const mergedChars = [];
    const aliasToIndex = new Map();

    const addCharList = (list) => {
      if (!Array.isArray(list)) return;
      for (const ch of list) {
        if (!ch || typeof ch !== 'object') continue;
        const names = Array.isArray(ch.names)
          ? ch.names.map(x => String(x || '').trim()).filter(Boolean)
          : (ch.name ? [String(ch.name).trim()] : []);
        const rendering = String(ch.rendering || ch.khmerName || '').trim();
        if (names.length === 0 && !rendering) continue;

        let matchIdx = -1;
        for (const n of names) {
          const tok = normalizeGlossaryToken(n);
          if (tok && aliasToIndex.has(tok)) {
            matchIdx = aliasToIndex.get(tok);
            break;
          }
        }
        if (matchIdx === -1 && rendering) {
          const rTok = normalizeGlossaryToken(rendering);
          if (rTok && aliasToIndex.has(rTok)) {
            matchIdx = aliasToIndex.get(rTok);
          }
        }

        if (matchIdx >= 0) {
          const target = mergedChars[matchIdx];
          const existingTokens = new Set((target.names || []).map(normalizeGlossaryToken));
          for (const n of names) {
            const tok = normalizeGlossaryToken(n);
            if (tok && !existingTokens.has(tok)) {
              target.names.push(n);
              existingTokens.add(tok);
              aliasToIndex.set(tok, matchIdx);
            }
          }
          if (!target.rendering && rendering) target.rendering = rendering;
          if ((!target.gender || target.gender === 'unknown') && ch.gender) target.gender = ch.gender;
          if (!target.role && ch.role) target.role = ch.role;
        } else {
          const idx = mergedChars.length;
          mergedChars.push({
            names: [...names],
            rendering,
            gender: ch.gender || 'unknown',
            role: ch.role || ''
          });
          for (const n of names) {
            const tok = normalizeGlossaryToken(n);
            if (tok) aliasToIndex.set(tok, idx);
          }
          if (rendering) {
            const rTok = normalizeGlossaryToken(rendering);
            if (rTok) aliasToIndex.set(rTok, idx);
          }
        }
      }
    };

    addCharList(base.characters);
    addCharList(ep.characters);

    const mergeUniqueStrings = (a, b, limit) => {
      const out = [];
      const seen = new Set();
      for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
        const s = String(item || '').trim();
        const k = s.toLowerCase();
        if (s && !seen.has(k)) {
          seen.add(k);
          out.push(s);
          if (out.length >= limit) break;
        }
      }
      return out;
    };

    const mergeKeyedObjects = (a, b, keyField, limit) => {
      const out = [];
      const seen = new Set();
      for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
        if (!item || typeof item !== 'object') continue;
        const k = normalizeGlossaryToken(item[keyField]);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push({ ...item });
        if (out.length >= limit) break;
      }
      return out;
    };

    return {
      synopsis: String(ep.synopsis || base.synopsis || '').trim(),
      tone: String(ep.tone || base.tone || '').trim(),
      characters: mergedChars.slice(0, 30),
      relationshipPronouns: mergeUniqueStrings(base.relationshipPronouns, ep.relationshipPronouns, 18),
      sttCorrections: mergeKeyedObjects(base.sttCorrections, ep.sttCorrections, 'wrong', 25),
      terms: mergeKeyedObjects(base.terms, ep.terms, 'source', 30)
    };
  }

  /**
   * Re-reads the latest on-disk Series Glossary right before merging & saving so parallel batch
   * episodes never clobber newly discovered characters, while returning the locked episode bible.
   */
  function persistSeriesGlossaryUpdate(seriesKey, targetLang, fallbackBase, episodeBible) {
    if (
      !seriesKey ||
      !episodeBible ||
      (
        (!Array.isArray(episodeBible.characters) || episodeBible.characters.length === 0) &&
        (!Array.isArray(episodeBible.terms) || episodeBible.terms.length === 0) &&
        (!Array.isArray(episodeBible.relationshipPronouns) || episodeBible.relationshipPronouns.length === 0)
      )
    ) {
      return episodeBible;
    }
    const latestBase = loadSeriesGlossary(seriesKey, targetLang) || fallbackBase;
    const merged = mergeStoryBibleWithSeries(latestBase, episodeBible);
    saveSeriesGlossary(seriesKey, targetLang, merged);
    return { ...merged, synopsis: episodeBible.synopsis || merged.synopsis };
  }

  /**
   * Extracts a full-episode Story Bible (plot arc, character Khmer-script roster, pronoun matrix,
   * and ASR/STT homophone repairs) so every translation batch matches the real story.
   */
  async function buildEpisodeStoryBible(cues, srcSpec, targetLanguage, langMeta, apiKey, callOpts = {}) {
    const empty = { synopsis: '', tone: '', characters: [], relationshipPronouns: [], sttCorrections: [], terms: [] };
    const priorSeries = callOpts && callOpts.seriesGlossary && typeof callOpts.seriesGlossary === 'object'
      ? callOpts.seriesGlossary
      : null;
    const hasRespanTranslator = Boolean(getRespanRuntimeConfig() && getRespanRuntimeConfig().enabled);
    if (!Array.isArray(cues) || cues.length < STORY_ANALYSIS_MIN_CUES || (!apiKey && !hasRespanTranslator)) {
      return { bible: priorSeries ? mergeStoryBibleWithSeries(priorSeries, empty) : empty, apiCalls: 0 };
    }
      const allLines = cues.map((cue, i) => `${i + 1}: ${(cue.text || '').replace(/\s+/g, ' ').trim()}`);
      const fullScriptText = allLines.join('\n');
      const scriptForPrompt = fullScriptText.length <= 16000
        ? fullScriptText
        : `${fullScriptText.slice(0, 7500)}\n...\n${fullScriptText.slice(Math.floor(fullScriptText.length * 0.45), Math.floor(fullScriptText.length * 0.45) + 4000)}\n...\n${fullScriptText.slice(-4300)}`;
      const khmerNameRule = targetLanguage.toLowerCase().includes('khmer') || langMeta.renderingName === 'Khmer'
        ? 'Transliterate ALL Chinese/foreign personal names and surnames into ONE consistent pure Khmer script spelling (e.g., ពេជ្រ/ប៉ី ជីអាន, ចឹង យ៉ានឈីង, គូ ឈឹងឈួន) — NEVER leave English/Pinyin like "Gu Chengchuan" or switch spellings (e.g. ភី vs ប៉ី vs ជាន).'
        : `Choose ONE consistent ${langMeta.renderingName} spelling for every character name.`;
      const priorSeriesText = priorSeries ? formatStoryBibleForPrompt(priorSeries, langMeta.renderingName === 'Khmer' ? 'km' : 'en') : '';

      const biblePrompt = `You are ${langMeta.editorRole} preparing a full ${srcSpec.name} short-drama translation into ${targetLanguage}.
Read the ENTIRE episode dialogue chronologically from line 1 to the end before translating any single line.
${priorSeriesText ? `\n=== PRIOR EPISODES SERIES GLOSSARY (MANDATORY: KEEP these exact character spellings, pronouns & shop names across episodes!) ===\n${priorSeriesText}\n` : ''}Analyze:
1. "synopsis": 2-4 sentences explaining the real plot, conflict, hidden facts (e.g. secret pregnancy, divorce terms, disguised billionaire), and who each character actually is.
2. "tone": Emotional atmosphere of the episode.
3. "characters": Every character (including all STT spelling/homophone variants referencing that same person, e.g. 佩女士/耴女士/简姐/之安姐 -> 裴之安, or 盈盈/茵英 -> same person), their exact gender, role, and ONE locked "rendering" (${khmerNameRule} Keep surnames unified with ZERO drift such as លូ vs លុក, វិន ថាំង vs វិន តាង, or អ៊ីង អ៊ីង vs យីង យីង vs អ៊ីន អ៊ីន).
4. "relationshipPronouns": Explicit pronoun pairs in spoken ${langMeta.renderingName} for each pair speaking (in Khmer drama dubbing: close friends use ឯង/គ្នា or នាង/ខ្ញុំ NEVER stiff "អ្នក"; servants -> madam use អ្នកស្រីតូច/លោកស្រី; estranged exes/antagonists use លោក/ខ្ញុំ or អ្នកឯង/នាង; family uses ប៉ា/ម៉ាក់/កូន/អូន/បង consistently without flipping between អូន/គាត់/នាង; wife speaking to husband about his mother "你妈" says ម៉ាក់បង/ម៉ាក់ NEVER "អ៊ំស្រី").
5. "sttCorrections": Any speech-to-text homophone errors in the transcript that would break the plot if translated literally (e.g. "怕妈...他们" -> "爸妈 (both parents died)", "简姐" -> "之安姐", "老顾书" -> "老顾头", "正太太" -> "郑太太", "问他/问她/问唐" before a verb/clause -> "温糖" female lead name NOT "ធ្លាប់សួរតើ", wrong "他" when context clearly refers to a woman, or impossible child/young-person homophones like "我八十了" / departure "很快乐" -> "很快了").
6. "terms": Key numbers, currency amounts, weights, times, quantities, proper restaurant/shop brand names, and plot terms written as clear numeric digits + explicit units (e.g. "六个亿" -> "600 លានយ័ន", "四千块" -> "4,000 យ័ន", "二十斤" -> "10 គីឡូក្រាម", "7点半" -> "ម៉ោង 7:30", "四胞胎" -> "កូនភ្លោះ 4 នាក់", "夜记海鲜" -> "ហាងគ្រឿងសមុទ្រ យ៉េជី" transliterated NEVER translated literally, NEVER spell out numbers in words).

Return ONLY valid JSON:
{"synopsis":"...","tone":"...","characters":[{"names":["..."],"rendering":"...","gender":"female|male|unknown","role":"..."}],"relationshipPronouns":["..."],"sttCorrections":[{"wrong":"...","intended":"...","note":"..."}],"terms":[{"source":"...","rendering":"...","note":"..."}]}

Complete Episode Dialogue:
${scriptForPrompt}`;

      try {
        const parsed = parseJsonObject(
          await callGeminiApi(biblePrompt, apiKey, [], 18000, callOpts),
          'story bible'
        );
        const epBible = {
          synopsis: typeof parsed.synopsis === 'string' ? parsed.synopsis.trim() : '',
          tone: typeof parsed.tone === 'string' ? parsed.tone.trim() : '',
          characters: Array.isArray(parsed.characters) ? parsed.characters.slice(0, 20) : [],
          relationshipPronouns: Array.isArray(parsed.relationshipPronouns) ? parsed.relationshipPronouns.slice(0, 15) : [],
          sttCorrections: Array.isArray(parsed.sttCorrections) ? parsed.sttCorrections.slice(0, 20) : [],
          terms: Array.isArray(parsed.terms) ? parsed.terms.slice(0, 25) : []
        };
        return {
          bible: priorSeries ? mergeStoryBibleWithSeries(priorSeries, epBible) : epBible,
          apiCalls: 1
        };
      } catch (err) {
        console.warn('[translation] Story Bible pass skipped, continuing with direct translation:', err.message);
        return { bible: priorSeries ? mergeStoryBibleWithSeries(priorSeries, empty) : empty, apiCalls: 0 };
      }
    }

    /**
     * Detects whether draft response IDs use local 1-based / 0-based indexing (even if AI skipped a line).
     */
    function detectDraftIdOffsetMode(list, targetIndices) {
      const arr = Array.isArray(list) ? list : [];
      const expectedIds = new Set(targetIndices.map(i => i + 1));
      const numericIds = arr.map(d => Number(d && d.id)).filter(Number.isInteger);
      const matchedDirectCount = numericIds.filter(id => expectedIds.has(id)).length;
      const isStrictlyIncreasing = numericIds.length > 0 && numericIds.every((id, i) => i === 0 || id > numericIds[i - 1]);
      const isOnePrefix = numericIds.length > 0 && numericIds.length === arr.length &&
        arr.every((d, idx) => Number(d && d.id) === idx + 1);
      const hasInvalidGlobalId = numericIds.some(id => !expectedIds.has(id));
      const strictOneSeq = arr.length === targetIndices.length &&
        !targetIndices.includes(0) &&
        isOnePrefix;
      const strictZeroSeq = arr.length === targetIndices.length &&
        arr.every((d, idx) => Number(d && d.id) === idx);
      const allInOneBasedRange = numericIds.length > 0 &&
        numericIds.length === arr.length &&
        numericIds.every(id => id >= 1 && id <= targetIndices.length);
      const allInZeroBasedRange = numericIds.length > 0 &&
        numericIds.length === arr.length &&
        numericIds.every(id => id >= 0 && id < targetIndices.length);
      const allUseLocalOneBased = strictOneSeq ||
        (matchedDirectCount === 0 && !targetIndices.includes(0) && allInOneBasedRange) ||
        (allInOneBasedRange && ((isOnePrefix && hasInvalidGlobalId) || (numericIds[0] === 1 && !expectedIds.has(1) && isStrictlyIncreasing)));
      const allUseLocalZeroBased = strictZeroSeq ||
        (!allUseLocalOneBased && allInZeroBasedRange && (matchedDirectCount === 0 || (numericIds.includes(0) && !expectedIds.has(0))));
      return { allUseLocalOneBased, allUseLocalZeroBased };
    }

    /**
     * Resolves a returned translation item ID strictly without allowing off-by-one shifts when lines are skipped.
     */
    function resolveDraftCueId(rawId, idxInArray, indices, totalDraftCount, allUseLocalOneBased, allUseLocalZeroBased = false) {
      if (allUseLocalOneBased && Number.isInteger(rawId) && rawId >= 1 && rawId <= indices.length) {
        return indices[rawId - 1] + 1;
      }
      if (allUseLocalZeroBased && Number.isInteger(rawId) && rawId >= 0 && rawId < indices.length) {
        return indices[rawId] + 1;
      }
      if (Number.isInteger(rawId) && indices.includes(rawId - 1)) {
        return rawId;
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
    async function reflectOnEpisodeTranslations(resultCues, googleFallbackIndices, storyBibleText, srcSpec, targetLang, targetLanguage, langMeta, apiKey, geminiCallOpts = {}) {
      const hasRespanTranslator = Boolean(getRespanRuntimeConfig() && getRespanRuntimeConfig().enabled);
      if (!Array.isArray(resultCues) || resultCues.length < STORY_ANALYSIS_MIN_CUES || (!apiKey && !hasRespanTranslator)) {
        return { apiCalls: 0, fixedCount: 0 };
      }
        const REVIEW_BATCH_SIZE = 120;
        let apiCalls = 0;
        let fixedCount = 0;

        for (let start = 0; start < resultCues.length; start += REVIEW_BATCH_SIZE) {
          const end = Math.min(resultCues.length, start + REVIEW_BATCH_SIZE);
          const reviewItems = [];
          const batchIndices = [];
          for (let i = start; i < end; i++) {
            const c = resultCues[i];
            if (!c || typeof c.text !== 'string' || !c.text.trim()) continue;
            batchIndices.push(i);
            const revItem = {
              id: i + 1,
              speaker: normalizeSuggestedVoice(c.voice) || '',
              source: c.text.trim(),
              translation: String(c.translated || '').trim()
            };
            if (Number.isFinite(Number(c.startSec)) && Number.isFinite(Number(c.endSec)) && Number(c.endSec) > Number(c.startSec)) {
              revItem.sec = Number((Number(c.endSec) - Number(c.startSec)).toFixed(2));
            }
            reviewItems.push(revItem);
          }
          if (reviewItems.length < STORY_ANALYSIS_MIN_CUES) continue;

          const reflectPrompt = `You are ${langMeta.editorRole} doing a final full-episode continuity & dialogue check on a ${srcSpec.name} -> ${targetLanguage} drama script.
${storyBibleText ? `\nEpisode Story Bible:\n${storyBibleText}\n` : ''}
Check the complete chronological dialogue below and return corrections ONLY for lines that have ANY of these defects:
1. Meaning/Subtext Mismatch with Story: e.g. ONLY a standalone reply "问啊 / 没问啊" mistranslated as command "សួរទៅ!" instead of "ធ្លាប់សួរតើ!" (CONVERSELY if "问他/问她/问唐" precedes a clause like "问他回来以后...", it is character surname 温糖 -> "វិន ថាំង", NEVER "ធ្លាប់សួរតើ"); missing sarcasm; wrong yes/no polarity; shifted line translation; literal shop/restaurant brand calques (keep transliterated proper names like "夜记海鲜" -> "ហាងគ្រឿងសមុទ្រ យ៉េជី", NEVER "ហាងគ្រឿងសមុទ្រយប់ជ្រៅ"); nonsensical/animal food terms for human meals ("ចំណីសល់" -> "ម្ហូបសល់", "សារ៉ាម៉ាន់" -> "នំប៉ាវស", "សាច់ដុំគោ" -> "សាច់ភ្លៅគោ", "ខរម្ងាស់" -> "ស្ងោររម្ងាស់"); or literal idiom/phrase calques (like "ខ្មៅលើក្រដាសស" -> "មានកត់ត្រាជាលាយលក្ខណ៍អក្សរច្បាស់លាស់", and leftover meals "ទុកសំណល់អាហារ" / "បាយកាកសំណល់" -> natural "ទុកអាហារដែលនៅសល់" / "បាយដែលនៅសល់").
2. STT Typo Translated Literally: e.g. "怕妈...他们" -> "ពុកម៉ែ..." (NOT "ខ្លាចម៉ែស្លាប់"), "简姐" -> female lead's real name, "问他/问唐" before a clause -> "វិន ថាំង" (NOT "ធ្លាប់សួរតើ"), "他" when speaking of a female character -> "នាង", or common-sense impossible homophones (e.g. young child saying "我八十了", or departure "很快乐" meaning "很快了 / ជិតរួចហើយ").
3. Character Name / Surname Drift or Non-Khmer Pinyin: unify ALL occurrences of the same character to ONE exact ${langMeta.renderingName} spelling matching the Story Bible with ZERO surname drift (e.g. លូ vs លុក or វិន ថាំង vs វិន តាង or យីង យីង vs អ៊ីង អ៊ីង) and transliterate any leftover Latin names like "Gu Chengchuan" into pure Khmer script.
4. Wrong Social Pronoun / Relationship Register: close friends must NOT call each other stiff "អ្នក" (use ឯង/គ្នា/នាង); servants -> young madam use លោកស្រី/អ្នកស្រីតូច; wife speaking to husband about his own mother ("你妈") MUST say ម៉ាក់បង/ម៉ាក់ (NEVER "អ៊ំស្រី"); keep ONE consistent pronoun for the same addressee in a scene instead of flipping between អូន/គាត់/នាង.
5. Corrupted/Unnatural Suffixes or Truncation.${targetLang === 'km' ? ` ${CHUON_NATH_PROMPT_GUIDE}
6. Numbers, Currency, Weights, Time & Quantities written in words or wrong units (CRITICAL): convert any spelled-out number words (e.g. "ដប់ប្រាំនាទី" -> "15 នាទី", "មួយរយប៉ែតសិបពីរថ្ងៃ" -> "182 ថ្ងៃ", "បួនពាន់យាន់" -> "4,000 យ័ន", "ម៉ោងប្រាំពីរកន្លះ" -> "ម៉ោង 7:30", "មនុស្សបីនាក់" -> "មនុស្ស 3 នាក់") into numeric digits 0-9; fix currency typos ("យាន់" -> "យ័ន") and specify the true country currency (យ័ន/ដុល្លារ/រៀល/បាត/វ៉ុន/យ៉េន); convert 斤 accurately (1 斤 = 0.5 គីឡូក្រាម); ensure clear Khmer unit names (គីឡូក្រាម, ក្រាម, លីត្រ, គីឡូម៉ែត្រ).
7. Stiff Textbook, Courtroom, or Essay Khmer Calques (CRITICAL): rewrite formal/bureaucratic phrasing into vivid everyday Cambodian speech (e.g. "ទ្រព្យសម្បត្តិមុនអាពាហ៍ពិពាហ៍" -> "ផ្ទះទិញមុនការ / ទ្រព្យមុនការ", "ប្រាក់បេឡាជាតិសន្តិសុខសង្គម/ការធានារ៉ាប់រង" -> "ធានារ៉ាប់រងសង្គម", "ទៀតសោត/ខណៈពេលដែល/ដោយហេតុថា/ក្នុងឆាកជីវិត" -> natural daily speech, "ជារៀងរាល់ថ្ងៃ" -> "រាល់ថ្ងៃ", "តើ...ដែរឬទេ?" -> "...មែនទេ?", "ជុំវិញតុអាហារ" -> "ជុំតុបាយ", "លាងចានឲ្យម្នាក់ៗពេញមួយផ្ទះ" -> "លាងចានឲ្យមួយផ្ទះទាំងមូល", "រៀបការចូលផ្ទះ" -> "ការចូលផ្ទះ", "តែពិតស្តែង" -> "តែតាមពិត").
8. Timing Overflow on Short Lines: if an item has short "sec" (< 2.2) and an overly wordy translation stuffed with formal filler ("ដើម្បីឲ្យ...", "ពិតជា...មែន", "ប្រកបដោយ"), tighten it into natural short spoken Khmer matching the scene duration.` : ''}

IMPORTANT:
- Return ONLY lines that genuinely need fixing! If a line already fits the story accurately and naturally, OMIT it.
- Preserve exact input "id" numbers.
Return ONLY valid JSON: {"fixes":[{"id":12,"translation":"..."}]} (or {"fixes":[]} if all lines already match the story).

Complete Episode Script:
${JSON.stringify(reviewItems)}`;

          try {
            apiCalls++;
            const parsed = parseJsonObject(
              await callGeminiApi(reflectPrompt, apiKey, [], 30000, geminiCallOpts),
              'story reflection'
            );
            const fixes = Array.isArray(parsed.fixes) ? parsed.fixes : [];
            const { allUseLocalOneBased, allUseLocalZeroBased } = detectDraftIdOffsetMode(fixes, batchIndices);
            for (let fIdx = 0; fIdx < fixes.length; fIdx++) {
              const fix = fixes[fIdx];
              const resolvedId = resolveDraftCueId(
                Number(fix && fix.id),
                fIdx,
                batchIndices,
                fixes.length,
                allUseLocalOneBased,
                allUseLocalZeroBased
              );
              if (!Number.isInteger(resolvedId) || resolvedId < start + 1 || resolvedId > end || resolvedId > resultCues.length) continue;
              if (typeof fix.translation !== 'string' || !fix.translation.trim()) continue;
              const idx = resolvedId - 1;
              let rawFix = fix.translation.trim();
              if ((targetLang === 'zh-km' || targetLang === 'en-km') && !rawFix.includes('|') && resultCues[idx].text) {
                rawFix = `${resultCues[idx].text.trim()} | ${rawFix}`;
              }
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
        const explicitSeriesKey = options && typeof options.seriesKey === 'string' ? options.seriesKey : '';
        const reqSpeedMode = String((options && options.speedMode) || 'auto').toLowerCase();
        const providedStoryBible = options && options.storyBible && typeof options.storyBible === 'object' ? options.storyBible : null;
        const seriesKey = resolveSeriesGlossaryKey(videoPath, explicitSeriesKey);
        const seriesGlossary = seriesKey ? loadSeriesGlossary(seriesKey, targetLang) : null;
        const resultCues = cues.map(cue => ({ ...cue }));
        const targetLanguage = getTargetLanguage(targetLang);
        const langMeta = getPromptLanguageMeta(targetLang);
        const srcSpec = getSourceLanguage(sourceLang) || SOURCE_LANGUAGE_SPECS.auto;
        const cacheSrcKey = sourceLang && sourceLang !== 'auto' ? sourceLang : 'auto';
        const reqFastHint = reqSpeedMode === 'fast' || (reqSpeedMode === 'auto' && cues.length >= 100);
        const effectiveSeedBible = providedStoryBible
          ? (seriesGlossary ? mergeStoryBibleWithSeries(seriesGlossary, providedStoryBible) : providedStoryBible)
          : seriesGlossary;
        const bibleDigestPart = effectiveSeedBible ? `\nbible:${JSON.stringify({ c: effectiveSeedBible.characters, t: effectiveSeedBible.terms })}` : '';
        const contextDigest = crypto.createHash('sha256')
          .update(`story-v3:${cacheSrcKey}->${targetLang}:${reqFastHint ? 'fast' : 'full'}${bibleDigestPart}\n${cues.map(cue => cue.text || '').join('\n')}`)
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

        const useFastPipeline = reqSpeedMode === 'fast' || (reqSpeedMode === 'auto' && pending.length >= 100);
        const geminiCallOpts = useFastPipeline
          ? { preferFastModel: true }
          : (reqSpeedMode === 'quality' ? { preferQuality: true } : {});

        if (pending.length === 0) {
          const cachedVoiceMap = new Map();
          const cachedEmotionMap = new Map();
          if (!useFastPipeline && effectiveCastMode !== 'single' && videoPath && apiKey && !hasExistingAudioCast) {
            await castVoicesWithAudioChunks(resultCues, videoPath, apiKey, effectiveCastMode, cachedVoiceMap, cachedEmotionMap);
          }
          inferCharacterVoicesForCues(resultCues, cachedVoiceMap, false, cachedEmotionMap, { castMode: effectiveCastMode, fixedVoice });
          return { cues: resultCues, translatedCount, cacheHits, apiCalls, storyBible: effectiveSeedBible || null };
        }

        const aiVoiceMap = new Map();
        const aiEmotionMap = new Map();

        // Pass 1: Build or reuse Episode Story Bible (seeded & locked by cross-episode Series Glossary when available)
        let storyBible = providedStoryBible ? effectiveSeedBible : null;
        if (!storyBible) {
          const storyResult = await buildEpisodeStoryBible(
            cues,
            srcSpec,
            targetLanguage,
            langMeta,
            apiKey,
            { ...geminiCallOpts, seriesGlossary }
          );
          apiCalls += storyResult.apiCalls;
          storyBible = storyResult.bible;
        }
        if (seriesKey && storyBible) {
          storyBible = persistSeriesGlossaryUpdate(seriesKey, targetLang, seriesGlossary, storyBible);
        }
        const storyBibleText = formatStoryBibleForPrompt(storyBible, targetLang);

        const effectiveChunkSize = useFastPipeline ? (pending.length <= 240 ? 40 : 50) : TRANSLATION_CHUNK_SIZE;
        const chunkSlices = [];
        for (let offset = 0; offset < pending.length; offset += effectiveChunkSize) {
          chunkSlices.push(pending.slice(offset, offset + effectiveChunkSize));
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
            const cueObj = cues[cueIndex] || {};
            const item = {
              id: cueIndex + 1,
              source: cueObj.text
            };
            if (
              Number.isFinite(Number(cueObj.startSec)) &&
              Number.isFinite(Number(cueObj.endSec)) &&
              Number(cueObj.endSec) > Number(cueObj.startSec)
            ) {
              item.sec = Number((Number(cueObj.endSec) - Number(cueObj.startSec)).toFixed(2));
            }
            const existingHint = normalizeSuggestedVoice(cueObj.suggestedVoice);
            if (existingHint) {
              item.audioHint = collapseVoiceForCastMode(existingHint, effectiveCastMode);
            }
            if (cueObj.speakerId) {
              item.speakerId = String(cueObj.speakerId);
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
Act as ${langMeta.editorRole}. Translate for true story meaning, conversational subtext (ONLY standalone reply "问啊 / 没问啊" means "ធ្លាប់សួរតើ!"; NEVER apply that to "问他/问她/问唐" before a clause where 问 is an STT homophone for surname 温糖 "វិន ថាំង"), sarcasm, character voice, spoken pacing fitting each item's "sec" duration (keep short lines < 2.2s crisp without filler), and natural daily spoken dialogue rather than word-for-word literal phrasing.${langMeta.formatHint}
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
            const { allUseLocalOneBased, allUseLocalZeroBased } = detectDraftIdOffsetMode(list, targetIndices);
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
                await callGeminiApi(translationPrompt, apiKey, [], 35000, geminiCallOpts),
                'translation'
              );
              const drafts = Array.isArray(parsed.translations) ? parsed.translations : [];
              applyDraftItems(drafts, indices, true);
              if (draftMap.size >= Math.ceil(indices.length * 0.5)) break;
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
          const hasTranslatorCredential = Boolean(apiKey || (getRespanRuntimeConfig() && getRespanRuntimeConfig().enabled));
          if (missingIndices.length > 0 && hasTranslatorCredential) {
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
                    const retryParsed = parseJsonObject(await callGeminiApi(retryPrompt, apiKey, [], 30000, geminiCallOpts), 'translation');
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
            // Scale parallel translation concurrency across Router Management accounts + Respan GPT-6.2 SOL
            const activeKeyModel = useFastPipeline
              ? GEMINI_FAST_LITE_MODEL
              : ((blockedModelsUntil.get(preferredGeminiModel) || 0) > Date.now() ? GEMINI_MODEL : preferredGeminiModel);
            const respanActiveBoost = (getRespanRuntimeConfig() && getRespanRuntimeConfig().enabled && !isRespanRateLimited()) ? 2 : 0;
            const healthyKeyCount = Math.max(
              getGeminiApiKeyCandidates(apiKey, `api:${activeKeyModel}`, { skipAllRateLimited: true, advanceCursor: false }).length + respanActiveBoost,
              getGeminiApiKeyCandidates(apiKey, `api:${GEMINI_FAST_LITE_MODEL}`, { skipAllRateLimited: true, advanceCursor: false }).length + respanActiveBoost,
              1
            );
            const maxConcurrentChunks = Math.min(10, Math.max(useFastPipeline ? 6 : 3, healthyKeyCount));
            let sliceCursor = 0;
            const failedChunkIndices = new Set();
            const runChunkPool = async () => {
              const workerCount = Math.min(maxConcurrentChunks, chunkSlices.length || 1);
              const workers = Array.from({ length: workerCount }, async () => {
                while (sliceCursor < chunkSlices.length) {
                  const idx = sliceCursor++;
                  try {
                    await translateSingleChunk(chunkSlices[idx]);
                  } catch (sliceErr) {
                    failedChunkIndices.add(idx);
                    console.warn(`[translation] Chunk slice #${idx + 1} processing warning:`, sliceErr.message);
                  }
                }
              });
              await Promise.all(workers);

              // Wave-2 calm retry for any chunk slice that failed during parallel worker execution
              if (failedChunkIndices.size > 0 && chunkSlices.length > 1) {
                console.log(`[translation] Wave-2 recovery: retrying ${failedChunkIndices.size} failed chunk slice(s)...`);
                await new Promise(r => setTimeout(r, 1200));
                for (const idx of Array.from(failedChunkIndices)) {
                  try {
                    await translateSingleChunk(chunkSlices[idx]);
                    failedChunkIndices.delete(idx);
                  } catch (retryErr) {
                    console.warn(`[translation] Chunk slice #${idx + 1} Wave-2 retry warning:`, retryErr.message);
                  }
                }
              }
            };

            const audioCastVoiceMap = new Map();
            const audioCastEmotionMap = new Map();
            const shouldRunAudioCast = !useFastPipeline && effectiveCastMode !== 'single' && videoPath && apiKey && !hasExistingAudioCast;
            if (shouldRunAudioCast) {
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

            // Pass 3: Full-episode Story Reflection & Consistency Review (runs in Quality & Auto modes up to 240 cues; skipped only in explicit Fast or huge 240+ marathons)
            const shouldRunReflection = reqSpeedMode !== 'fast' &&
              pending.length >= STORY_ANALYSIS_MIN_CUES &&
              (reqSpeedMode === 'quality' || resultCues.length <= 240) &&
              (Date.now() - translationStartMs) < 120000;
            if (shouldRunReflection) {
              const reflResult = await reflectOnEpisodeTranslations(
                resultCues,
                googleFallbackIndices,
                storyBibleText,
                srcSpec,
                targetLang,
                targetLanguage,
                langMeta,
                apiKey,
                geminiCallOpts
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
              let fatalAuthErr = false;
              const runAntiLeakRepairBatches = async (targetIndices, batchSize, concurrency) => {
                if (!Array.isArray(targetIndices) || targetIndices.length === 0 || fatalAuthErr) return;
                const rescueBatches = [];
                for (let off = 0; off < targetIndices.length; off += batchSize) {
                  rescueBatches.push(targetIndices.slice(off, off + batchSize));
                }
                await mapWithConcurrency(rescueBatches, concurrency, async (subIndices) => {
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
2. Transliterate ALL character names and idioms phonetically into pure ${targetLanguage} — ZERO ${srcSpec.name}/Hanzi/CJK letters, parentheses with Hanzi like (张三), or CJK punctuation (，。？！) may remain.
3. Preserve exact input "id" values. Return ONLY valid JSON: {"translations":[{"id":${repairItems[0].id},"translation":"..."}]}.
Items: ${JSON.stringify(repairItems)}`;
                    apiCalls++;
                    const parsed = parseJsonObject(await callGeminiApi(repairPrompt, apiKey, [], 30000, geminiCallOpts), 'anti-leak repair');
                    const drafts = Array.isArray(parsed.translations) ? parsed.translations : [];
                    const { allUseLocalOneBased, allUseLocalZeroBased } = detectDraftIdOffsetMode(drafts, subIndices);
                    drafts.forEach((item, idxInArr) => {
                      if (!item || typeof item.translation !== 'string' || !item.translation.trim()) return;
                      const resolvedId = resolveDraftCueId(
                        Number(item.id),
                        idxInArr,
                        subIndices,
                        drafts.length,
                        allUseLocalOneBased,
                        allUseLocalZeroBased
                      );
                      if (resolvedId === null) return;
                      const idx = resolvedId - 1;
                      const rawCandidate = item.translation.trim();
                      const cleaned = cleanTranslatedText(rawCandidate, targetLang);
                      if (
                        !isTranslationIncomplete(rawCandidate, cues[idx].text, targetLang) ||
                        (cleaned && !isTranslationIncomplete(cleaned, cues[idx].text, targetLang) && !(targetLang === 'km' && CJK_FOREIGN_SCRIPT_RE.test(cleaned)))
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
              };

              // 4a. Small focused Gemini repair batches (max 6 cues)
              await runAntiLeakRepairBatches(leakedIndices, 6, 2);

              // 4a-bis. Micro-batch Gemini rescue (3 cues/call) when >30 stubborn lines remain so we don't overwhelm Google 429
              leakedIndices = findLeakedCueIndices();
              if (leakedIndices.length > 30 && !fatalAuthErr) {
                await runAntiLeakRepairBatches(leakedIndices.slice(0, 120), 3, 3);
              }

              // 4b. Isolated 1-item Gemini rescue for up to 30 stubborn survivors (avoids hitting Google 429)
              leakedIndices = findLeakedCueIndices();
              if (leakedIndices.length > 0 && leakedIndices.length <= 30 && !fatalAuthErr) {
                await mapWithConcurrency(leakedIndices, 3, async (cueIdx) => {
                  try {
                    const singlePrompt = `Translate this single ${srcSpec.name} subtitle completely into ${targetLanguage}.${langMeta.formatHint}
Transliterate ALL Chinese names/terms phonetically into pure ${targetLanguage} script. ZERO ${srcSpec.name}/Chinese/foreign characters or parentheses with Hanzi may remain. Return ONLY JSON: {"id":${cueIdx + 1},"translation":"..."}
Context before: ${cueIdx > 0 ? (resultCues[cueIdx - 1].translated || cues[cueIdx - 1].text || '') : ''}
Source: ${cues[cueIdx].text}
Context after: ${cueIdx + 1 < cues.length ? (resultCues[cueIdx + 1].translated || cues[cueIdx + 1].text || '') : ''}`;
                    apiCalls++;
                    const parsed = parseJsonObject(await callGeminiApi(singlePrompt, apiKey, [], 25000, geminiCallOpts), 'single-cue repair');
                    const rawCandidate = typeof parsed.translation === 'string'
                      ? parsed.translation.trim()
                      : (Array.isArray(parsed.translations) && parsed.translations[0] && typeof parsed.translations[0].translation === 'string'
                        ? parsed.translations[0].translation.trim()
                        : '');
                    if (!rawCandidate) return;
                    const cleaned = cleanTranslatedText(rawCandidate, targetLang);
                    if (cleaned && !isTranslationIncomplete(cleaned, cues[cueIdx].text, targetLang) && !(targetLang === 'km' && CJK_FOREIGN_SCRIPT_RE.test(cleaned))) {
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

            // 4c. Final throttled Google Translate rescue for any remaining leaked cues (concurrency=1 prevents 429 burst)
            leakedIndices = findLeakedCueIndices();
            if (leakedIndices.length > 0) {
              await mapWithConcurrency(leakedIndices, 1, async (cueIdx, pos) => {
                if (Date.now() < googleTranslateBlockedUntil) return;
                if (pos > 0) await new Promise(r => setTimeout(r, 250));
                const fallbackRaw = await translateWithGoogleFallbackSafe(cues[cueIdx].text, sourceLang, targetLang, 1);
                if (!fallbackRaw) return;
                const cleaned = cleanTranslatedText(fallbackRaw, targetLang);
                if (cleaned && !isTranslationIncomplete(cleaned, cues[cueIdx].text, targetLang) && !(targetLang === 'km' && CJK_FOREIGN_SCRIPT_RE.test(cleaned))) {
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
              const candidateCleaned = rawTr ? cleanTranslatedText(rawTr, targetLang) : '';
              if (candidateCleaned && !isTranslationIncomplete(candidateCleaned, src, targetLang) && !(targetLang === 'km' && CJK_FOREIGN_SCRIPT_RE.test(candidateCleaned))) {
                resultCues[i].translated = candidateCleaned;
                resultCues[i].translatedLang = targetLang;
              } else {
                untranslatedCount++;
                delete resultCues[i].translatedLang;
                if (
                  rawTr === src ||
                  (targetLang === 'km' && (!/[\u1780-\u17FF]/.test(candidateCleaned || rawTr) || CJK_FOREIGN_SCRIPT_RE.test(candidateCleaned || rawTr)))
                ) {
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

          /**
           * Refines already-translated cues/drafts into natural real-life spoken Cambodian speech without
           * re-running STT or shifting timestamps: runs deterministic word/numeric cleanup first, then aligns
           * character names with Series Glossary and runs Story Reflection when an API key is configured.
           */
          async function polishTranslatedCues(cues, targetLang = 'km', apiKey = '', sourceLang = 'auto', options = {}) {
            const srcSpec = getSourceLanguage(sourceLang) || SOURCE_LANGUAGE_SPECS.auto;
            const targetLanguage = getTargetLanguage(targetLang) || 'Khmer';
            const langMeta = getPromptLanguageMeta(targetLang);
            const videoPath = options && typeof options.videoPath === 'string' ? options.videoPath : '';
            const explicitSeriesKey = options && typeof options.seriesKey === 'string' ? options.seriesKey : '';
            const seriesKey = resolveSeriesGlossaryKey(videoPath, explicitSeriesKey);
            const seriesGlossary = seriesKey ? loadSeriesGlossary(seriesKey, targetLang) : null;
            const resultCues = cues.map(cue => ({ ...cue }));

            let deterministicFixedCount = 0;
            let eligibleCount = 0;
            for (let i = 0; i < resultCues.length; i++) {
              const cur = String(resultCues[i].translated || '').trim();
              const src = String(resultCues[i].text || '').trim();
              if (!cur || cur === src || isTranslationIncomplete(cur, src, targetLang)) continue;
              eligibleCount++;
              const normalized = cleanTranslatedText(cur, targetLang);
              if (normalized && normalized !== cur) {
                resultCues[i].translated = normalized;
                resultCues[i].translatedLang = targetLang;
                deterministicFixedCount++;
              }
            }

            let aiFixedCount = 0;
            let apiCalls = 0;
            let storyBible = seriesGlossary || null;
            const reqSpeedMode = String((options && options.speedMode) || 'quality').toLowerCase();
            const callOpts = reqSpeedMode === 'fast' ? { preferFastModel: true } : { preferQuality: true };

            const hasRespanPolish = Boolean(getRespanRuntimeConfig() && getRespanRuntimeConfig().enabled);
            if ((apiKey || hasRespanPolish) && eligibleCount >= STORY_ANALYSIS_MIN_CUES) {
                  const provided = options && options.storyBible && typeof options.storyBible === 'object' ? options.storyBible : null;
                  if (provided) {
                    storyBible = seriesGlossary ? mergeStoryBibleWithSeries(seriesGlossary, provided) : provided;
                  } else {
                    const sbRes = await buildEpisodeStoryBible(resultCues, srcSpec, targetLanguage, langMeta, apiKey, {
                      ...callOpts,
                      seriesGlossary
                    });
                    apiCalls += sbRes.apiCalls;
                    storyBible = sbRes.bible;
                  }
                  if (seriesKey && storyBible) {
                    storyBible = persistSeriesGlossaryUpdate(seriesKey, targetLang, seriesGlossary, storyBible);
                  }
                  const storyBibleText = formatStoryBibleForPrompt(storyBible, targetLang);
                  const reflRes = await reflectOnEpisodeTranslations(
                    resultCues,
                    new Set(),
                    storyBibleText,
                    srcSpec,
                    targetLang,
                    targetLanguage,
                    langMeta,
                    apiKey,
                    callOpts
                  );
                  apiCalls += reflRes.apiCalls;
                  aiFixedCount = reflRes.fixedCount;
                }

                return {
                  cues: resultCues,
                  eligibleCount,
                  deterministicFixedCount,
                  aiFixedCount,
                  totalFixedCount: deterministicFixedCount + aiFixedCount,
                  storyBible,
                  seriesKey,
                  apiCalls
                };
              }

              router.post('/auto-cast-voices', async (req, res) => {
                try {
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

                  const respanForCast = getRespanRuntimeConfig(req);
                  if (useAi && cloned.length <= 120 && (apiKey || (respanForCast && respanForCast.enabled))) {
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
                        return res.json({ success: true, cues: cloned, usedAudio, castMode: effectiveCastMode });
                      } catch (err) {
                        console.error('[translation/auto-cast-voices]:', err.message);
                        return res.status(500).json({ success: false, error: err.message });
                      }
                    });

              router.get('/languages', (req, res) => {
                res.json({
                  success: true,
                  sourceLanguages: Object.entries(SOURCE_LANGUAGE_SPECS).map(([id, spec]) => ({ id, name: spec.name })),
                  targetLanguages: ['km', 'en', 'th', 'vi', 'zh', 'ko', 'ja', 'zh-km', 'en-km']
                });
              });

              const inFlightTranslationJobs = new Map();

              router.post('/story-bible', async (req, res) => {
                try {
                  const { cues, sourceLang = 'auto', targetLang = 'km', speedMode = 'auto', videoPath = '', seriesKey = '' } = req.body || {};
                  const cueError = validateCueList(cues);
                  if (cueError) {
                    return res.status(400).json({ success: false, error: cueError });
                  }
                  const srcSpec = getSourceLanguage(sourceLang) || SOURCE_LANGUAGE_SPECS.auto;
                  const targetLanguage = getTargetLanguage(targetLang);
                  if (!targetLanguage) {
                    return res.status(400).json({ success: false, error: 'ភាសាគោលដៅមិនត្រឹមត្រូវ។' });
                  }
                  let apiKey = '';
                  try {
                    apiKey = loadConfig(req).GEMINI_API_KEY || '';
                  } catch (err) {
                    return res.status(500).json({ success: false, error: 'មិនអាចអាន Gemini API key បានទេ។' });
                  }
                  const respanRt = getRespanRuntimeConfig(req);
                  if (!apiKey && !(respanRt && respanRt.enabled)) {
                    return res.status(401).json({ success: false, error: 'សូមបញ្ចូល Gemini API Key ឬ Respan GPT-6.2 SOL Key ក្នុង Router ជាមុនសិន។' });
                  }
                    const resolvedSeriesKey = resolveSeriesGlossaryKey(videoPath, seriesKey);
                    const seriesGlossary = resolvedSeriesKey ? loadSeriesGlossary(resolvedSeriesKey, targetLang) : null;
                    const langMeta = getPromptLanguageMeta(targetLang);
                    const storyCallOpts = String(speedMode).toLowerCase() === 'quality'
                      ? { preferQuality: true, seriesGlossary }
                      : { preferFastModel: true, seriesGlossary };
                    const result = await buildEpisodeStoryBible(cues, srcSpec, targetLanguage, langMeta, apiKey, storyCallOpts);
                    let bible = result.bible;
                    if (resolvedSeriesKey && bible) {
                      bible = persistSeriesGlossaryUpdate(resolvedSeriesKey, targetLang, seriesGlossary, bible);
                    }
                    return res.json({ success: true, storyBible: bible, seriesKey: resolvedSeriesKey, apiCalls: result.apiCalls });
                  } catch (err) {
                    logError('translation/story-bible', err);
                    return res.status(502).json({ success: false, error: err.message });
                  }
                });

              router.post('/polish-cues', async (req, res) => {
                const {
                  cues,
                  sourceLang = 'auto',
                  targetLang = 'km',
                  videoPath = '',
                  seriesKey = '',
                  speedMode = 'quality',
                  storyBible = null
                } = req.body || {};
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
                let apiKey = '';
                try {
                  apiKey = loadConfig(req).GEMINI_API_KEY || '';
                } catch (err) {
                  return res.status(500).json({ success: false, error: 'មិនអាចអាន Gemini API key បានទេ។' });
                }
                const respanForPolish = getRespanRuntimeConfig(req);
                try {
                  const result = await polishTranslatedCues(cues, targetLang, apiKey, sourceLang, {
                    videoPath,
                    seriesKey,
                    speedMode,
                    storyBible
                  });
                  return res.json({
                    success: true,
                    ...result,
                    usedAi: Boolean((apiKey || (respanForPolish && respanForPolish.enabled)) && result.eligibleCount >= STORY_ANALYSIS_MIN_CUES)
                  });
                } catch (err) {
                  console.error('[translation/polish-cues]:', err.message);
                  return res.status(502).json({ success: false, error: err.message });
                }
              });

              router.get('/series-glossary', (req, res) => {
                try {
                  const { videoPath = '', seriesKey = '', targetLang = 'km' } = req.query || {};
                  const resolvedSeriesKey = resolveSeriesGlossaryKey(videoPath, seriesKey);
                  const glossary = resolvedSeriesKey ? loadSeriesGlossary(resolvedSeriesKey, targetLang) : null;
                  res.json({ success: true, seriesKey: resolvedSeriesKey, glossary });
                } catch (err) {
                  logError('translation/series-glossary', err);
                  res.status(500).json({ success: false, error: err.message });
                }
              });

              router.post('/series-glossary/clear', (req, res) => {
                try {
                  const { videoPath = '', seriesKey = '', targetLang = 'km' } = req.body || {};
                  const resolvedSeriesKey = resolveSeriesGlossaryKey(videoPath, seriesKey);
                  const filePath = getSeriesGlossaryPath(resolvedSeriesKey, targetLang);
                  let removed = false;
                  if (filePath && fs.existsSync(filePath)) {
                    try { fs.unlinkSync(filePath); removed = true; } catch (_) { }
                  }
                  res.json({ success: true, seriesKey: resolvedSeriesKey, removed });
                } catch (err) {
                  logError('translation/series-glossary:clear', err);
                  res.status(500).json({ success: false, error: err.message });
                }
              });

              router.post('/translate-cues', async (req, res) => {
                const {
                  cues,
                  sourceLang = 'auto',
                  targetLang = 'km',
                  useCache = true,
                  force = false,
                  videoPath = '',
                  seriesKey = '',
                  castMode = 'duo',
                  fixedVoice = '',
                  speedMode = 'auto',
                  storyBible = null
                } = req.body || {};
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

                let apiKey = '';
                try {
                  apiKey = loadConfig(req).GEMINI_API_KEY || '';
                } catch (err) {
                  console.error('[translation/translate-cues] API key error:', err.message);
                  return res.status(500).json({ success: false, error: 'មិនអាចអាន Gemini API key បានទេ។' });
                }
                const respanRt = getRespanRuntimeConfig(req);
                if (!apiKey && !(respanRt && respanRt.enabled)) {
                  return res.status(401).json({ success: false, error: 'សូមបញ្ចូល Gemini API Key ឬ Respan GPT-6.2 SOL Key ក្នុង Router ជាមុនសិន។' });
                }

                try {
                  const effectiveCastMode = normalizeCastMode(castMode);
                  const normalizedSpeedMode = ['fast', 'quality', 'auto'].includes(String(speedMode).toLowerCase())
                    ? String(speedMode).toLowerCase()
                    : 'auto';
                  const sbHash = storyBible ? JSON.stringify(storyBible) : '';
                  const effectiveJobSecret = apiKey || (respanRt && respanRt.apiKey) || '';
                  const keyHash = crypto.createHash('sha1').update(String(effectiveJobSecret)).digest('hex').slice(0, 12);
                      const cueFingerprint = cues
                        .map(c => `${c && c.startSec !== undefined ? c.startSec : ''}|${c && c.endSec !== undefined ? c.endSec : ''}|${(c && (c.voice || c.suggestedVoice)) || ''}|${(c && c.text) || ''}`)
                        .join('\n');
                      const jobKey = crypto.createHash('sha256')
                        .update(`${keyHash}|${sourceLang}->${targetLang}|${effectiveCastMode}|${fixedVoice}|${videoPath || ''}|${seriesKey || ''}|${normalizedSpeedMode}|${useCache}|${force}|${sbHash}\n${cueFingerprint}`)
                        .digest('hex');

                      let jobPromise = inFlightTranslationJobs.get(jobKey);
                      if (!jobPromise) {
                        jobPromise = translateWithReflection(cues, targetLang, apiKey, useCache, force, sourceLang, {
                          castMode: effectiveCastMode,
                          videoPath,
                          seriesKey,
                          fixedVoice,
                          speedMode: normalizedSpeedMode,
                          storyBible
                        });
                        inFlightTranslationJobs.set(jobKey, jobPromise);
                        jobPromise.finally(() => {
                          if (inFlightTranslationJobs.get(jobKey) === jobPromise) {
                            inFlightTranslationJobs.delete(jobKey);
                          }
                        }).catch(() => { });
                      }

                      const result = await jobPromise;
                      res.json({
                        success: true,
                        cues: result.cues,
                        storyBible: result.storyBible || null,
                        sourceLang,
                        targetLang,
                        stats: {
                          translatedCount: result.translatedCount,
                          totalCount: cues.length,
                          cacheHits: result.cacheHits,
                          apiCalls: result.apiCalls,
                          speedMode: normalizedSpeedMode,
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

              async function runOcrSliceWithFallback(framesSlice, apiKey, srcSpec) {
                const imageParts = [];
                framesSlice.forEach((frame, index) => {
                  imageParts.push({ text: `Frame ${index + 1}, timestamp ${frame.timeSec.toFixed(3)} seconds:` });
                  imageParts.push({
                    inline_data: {
                      mime_type: frame.mimeType || 'image/jpeg',
                      data: frame.imageBase64
                    }
                  });
                });
                const prompt = `Read ALL visible hardcoded ${srcSpec.ocrHint} dialogue subtitle text across the entire supplied frame (especially lower white/yellow/outlined subtitle lines, including short 1-3 character lines and partial edges).
Ignore watermarks, channel logos, stationary UI/signs, and background scenery unless clearly a dialogue subtitle or story caption. If a frame has no subtitle text, return an empty string for it.
Preserve exact original characters and line breaks cleanly without repeating words. Do not infer text that is not visible.
Return only JSON with exactly one result per input frame, in the same order:
{"frames":[{"frame":1,"text":"..."},{"frame":2,"text":""}]}`;

                try {
                  const parsed = parseJsonObject(await callGeminiApi(prompt, apiKey, imageParts, 45000), 'OCR');
                  if (!Array.isArray(parsed.frames)) {
                    throw new Error('Gemini returned an incomplete OCR result.');
                  }
                  const frameTextByIndex = new Map();
                  parsed.frames.forEach((item, idx) => {
                    if (!item || typeof item.text !== 'string') return;
                    const frameNum = Number(item.frame);
                    const targetIdx = Number.isInteger(frameNum) && frameNum >= 1 && frameNum <= framesSlice.length
                      ? frameNum - 1
                      : idx;
                    frameTextByIndex.set(targetIdx, decodeUnicodeEscapes(item.text).trim());
                  });
                  return framesSlice.map((_, index) => frameTextByIndex.get(index) || '');
                } catch (err) {
                  const msg = String((err && err.message) || '');
                  const isContentFilterOrParse = Boolean(
                    (err && err.isEmptyModelResponse) ||
                    /RECITATION|SAFETY|PROHIBITED|incomplete OCR result|did not return valid JSON|returned invalid .*JSON/i.test(msg)
                  );
                  const isFatalEnvErr = Boolean(
                    (err && err.isNetworkUnreachable) ||
                    (err && (err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 429))
                  );
                  if (isContentFilterOrParse && !isFatalEnvErr) {
                    if (framesSlice.length > 1) {
                      const mid = Math.ceil(framesSlice.length / 2);
                      const [left, right] = await Promise.all([
                        runOcrSliceWithFallback(framesSlice.slice(0, mid), apiKey, srcSpec),
                        runOcrSliceWithFallback(framesSlice.slice(mid), apiKey, srcSpec)
                      ]);
                      return left.concat(right);
                    }
                    console.warn('[translation/ocr-frames] Single frame filtered/skipped:', msg);
                    return [''];
                  }
                  throw err;
                }
              }

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
                  const texts = await runOcrSliceWithFallback(frames, apiKey, srcSpec);
                  res.json({
                    success: true,
                    frames: frames.map((frame, index) => ({
                      frameIndex: index,
                      timeSec: frame.timeSec,
                      text: texts[index] || ''
                    }))
                  });
                } catch (err) {
                  console.error('[translation/ocr-frames]:', err.message);
                  res.status(502).json({ success: false, error: err.message });
                }
              });

              const SENSEVOICE_SUPPORTED_LANGS = new Set(['auto', 'zh', 'zh-cn', 'zh-hans', 'zh-km', 'yue', 'en', 'en-km', 'ja', 'ko']);
              const SENSEVOICE_SCRIPT_PATH = resolveUnpackedPath(path.join(__dirname, '..', 'utils', 'sensevoice_stt.py'));
              function getSenseVoiceCacheDir() {
                return process.env.SENSEVOICE_CACHE_DIR || path.join(__dirname, '..', '..', '..', '.ai_models', 'sensevoice');
              }
              const activeSenseVoiceProcs = new Set();
              let cachedSenseVoiceCaps = null;

              function normalizeSttEngine(rawEngine) {
                const val = String(rawEngine || '').trim().toLowerCase();
                if (val === 'sensevoice' || val === 'sensevoice_local' || val === 'local') return 'sensevoice';
                if (val === 'auto') return 'auto';
                return 'gemini';
              }

              function isSenseVoiceSupportedLanguage(sourceLang = 'auto') {
                return SENSEVOICE_SUPPORTED_LANGS.has(String(sourceLang || 'auto').trim().toLowerCase());
              }

              function buildSenseVoiceChildEnv(extraVars = {}) {
                try {
                  const audioMod = require('./audio');
                  if (typeof audioMod.buildChildProcessEnv === 'function') {
                    return audioMod.buildChildProcessEnv({ HF_HUB_DISABLE_XET: '1', ...extraVars });
                  }
                } catch (_) { }
                return { ...process.env, HF_HUB_DISABLE_XET: '1', PYTHONIOENCODING: 'utf-8', ...extraVars };
              }

              function resolveSenseVoicePythonBin() {
                if (process.env.EZA_SENSEVOICE_PYTHON && fs.existsSync(process.env.EZA_SENSEVOICE_PYTHON)) {
                  return process.env.EZA_SENSEVOICE_PYTHON;
                }
                const root = path.resolve(__dirname, '..', '..', '..');
                const candidate = path.join(
                  root,
                  '.venv_audio',
                  process.platform === 'win32' ? 'Scripts' : 'bin',
                  process.platform === 'win32' ? 'python.exe' : 'python'
                );
                return fs.existsSync(candidate) ? candidate : '';
              }

              let inFlightSenseVoiceCheckPromise = null;

              function getSenseVoiceCacheParams(forceRefresh = false) {
                if (process.env.EZA_DISABLE_LOCAL_STT === '1') {
                  return {
                    immediate: {
                      available: false,
                      cuda: false,
                      device: 'cpu',
                      gpuName: '',
                      funasrVersion: '',
                      modelsCached: false,
                      supportedLangs: ['auto', 'zh', 'yue', 'en', 'ja', 'ko'],
                      error: 'Disabled by environment'
                    }
                  };
                }
                const now = Date.now();
                const cacheTtlMs = (cachedSenseVoiceCaps && cachedSenseVoiceCaps.data && cachedSenseVoiceCaps.data.available) ? 30000 : 2000;
                if (!forceRefresh && cachedSenseVoiceCaps && (now - cachedSenseVoiceCaps.checkedAt) < cacheTtlMs) {
                  return { immediate: cachedSenseVoiceCaps.data };
                }
                const pyBin = resolveSenseVoicePythonBin();
                const baseFail = {
                  available: false,
                  cuda: false,
                  device: 'cpu',
                  gpuName: '',
                  funasrVersion: '',
                  modelsCached: false,
                  supportedLangs: ['auto', 'zh', 'yue', 'en', 'ja', 'ko'],
                  error: pyBin ? 'sensevoice_stt.py unavailable' : '.venv_audio Python not found'
                };
                if (!pyBin || !fs.existsSync(SENSEVOICE_SCRIPT_PATH)) {
                  cachedSenseVoiceCaps = { checkedAt: now, data: baseFail };
                  return { immediate: baseFail };
                }
                return { immediate: null, now, pyBin, baseFail };
              }

              function parseSenseVoiceProbeStdout(stdout, baseFail) {
                const out = String(stdout || '').trim().split(/\r?\n/).pop() || '';
                const parsed = out ? JSON.parse(out) : null;
                return parsed && typeof parsed === 'object'
                  ? {
                    available: Boolean(parsed.available),
                    cuda: Boolean(parsed.cuda),
                    device: String(parsed.device || 'cpu'),
                    gpuName: String(parsed.gpuName || ''),
                    funasrVersion: String(parsed.funasrVersion || ''),
                    modelsCached: Boolean(parsed.modelsCached),
                    supportedLangs: ['auto', 'zh', 'yue', 'en', 'ja', 'ko'],
                    error: String(parsed.error || '')
                  }
                  : baseFail;
              }

              function getSenseVoiceCapabilities(forceRefresh = false) {
                const state = getSenseVoiceCacheParams(forceRefresh);
                if (state.immediate) return state.immediate;
                try {
                  const probe = spawnSync(
                    state.pyBin,
                    [SENSEVOICE_SCRIPT_PATH, '--check', '--cache-dir', getSenseVoiceCacheDir()],
                    { encoding: 'utf8', windowsHide: true, timeout: 25000, env: buildSenseVoiceChildEnv() }
                  );
                  const data = parseSenseVoiceProbeStdout(probe.stdout, state.baseFail);
                  cachedSenseVoiceCaps = { checkedAt: state.now, data };
                  return data;
                } catch (err) {
                  const fail = { ...state.baseFail, error: err.message };
                  cachedSenseVoiceCaps = { checkedAt: state.now, data: fail };
                  return fail;
                }
              }

              async function getSenseVoiceCapabilitiesAsync(forceRefresh = false) {
                const state = getSenseVoiceCacheParams(forceRefresh);
                if (state.immediate) return state.immediate;
                if (inFlightSenseVoiceCheckPromise) return inFlightSenseVoiceCheckPromise;
                inFlightSenseVoiceCheckPromise = new Promise((resolve) => {
                  execFile(
                    state.pyBin,
                    [SENSEVOICE_SCRIPT_PATH, '--check', '--cache-dir', getSenseVoiceCacheDir()],
                    { encoding: 'utf8', windowsHide: true, timeout: 25000, env: buildSenseVoiceChildEnv() },
                    (err, stdout) => {
                      if (err && !stdout) {
                        const fail = { ...state.baseFail, error: err.message };
                        cachedSenseVoiceCaps = { checkedAt: Date.now(), data: fail };
                        return resolve(fail);
                      }
                      try {
                        const data = parseSenseVoiceProbeStdout(stdout, state.baseFail);
                        cachedSenseVoiceCaps = { checkedAt: Date.now(), data };
                        return resolve(data);
                      } catch (parseErr) {
                        const fail = { ...state.baseFail, error: parseErr.message };
                        cachedSenseVoiceCaps = { checkedAt: Date.now(), data: fail };
                        return resolve(fail);
                      }
                    }
                  );
                }).finally(() => {
                  inFlightSenseVoiceCheckPromise = null;
                });
                return inFlightSenseVoiceCheckPromise;
              }

              function resolveSttEngineChoice({ sttEngine, sourceLang, capabilities } = {}) {
                const requested = normalizeSttEngine(sttEngine);
                const langSupported = isSenseVoiceSupportedLanguage(sourceLang);
                const svReady = Boolean(capabilities && capabilities.available);
                if (requested === 'sensevoice') {
                  if (!svReady) {
                    return {
                      ok: false,
                      status: 503,
                      error: 'ម៉ាស៊ីនស្ដាប់ Local (SenseVoice) មិនទាន់រួចរាល់ទេ។ សូមជ្រើស Gemini Cloud ឬ Auto ជំនួស។'
                    };
                  }
                  if (!langSupported) {
                    return {
                      ok: false,
                      status: 400,
                      error: 'SenseVoice Local គាំទ្រតែភាសា ចិន, កាតាំង, អង់គ្លេស, ជប៉ុន និងកូរ៉េ។ សម្រាប់ភាសាផ្សេង សូមជ្រើស Auto ឬ Gemini Cloud។'
                    };
                  }
                  return { ok: true, engine: 'sensevoice' };
                }
                if (requested === 'auto') {
                  if (svReady && langSupported) {
                    return { ok: true, engine: 'sensevoice' };
                  }
                  return { ok: true, engine: 'gemini' };
                }
                return { ok: true, engine: 'gemini' };
              }

              function extractFullSpeechWavForLocalStt(inputPath, outputWavPath, options = {}) {
                const { useVocalFilter = true, timeoutMs = 240000 } = options;
                return new Promise((resolve, reject) => {
                  const args = ['-nostdin', '-hide_banner', '-nostats', '-loglevel', 'error', '-i', inputPath, '-vn'];
                  if (useVocalFilter && SPEECH_VOCAL_FILTER) {
                    args.push('-af', SPEECH_VOCAL_FILTER);
                  }
                  args.push('-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', outputWavPath);
                  const proc = spawn(FFMPEG_BIN, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
                  lowerProcessPriority(proc);
                  let settled = false;
                  const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    try { proc.kill('SIGKILL'); } catch (_) { try { proc.kill(); } catch (_) { } }
                    reject(new Error('FFmpeg 16kHz WAV extraction timed out.'));
                  }, timeoutMs);
                  let stderr = '';
                  proc.stderr.setEncoding('utf8');
                  proc.stderr.on('data', d => {
                    stderr += d;
                    if (stderr.length > 16384) stderr = stderr.slice(-8192);
                  });
                  proc.once('error', (err) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    reject(err);
                  });
                  proc.once('close', (code) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (code === 0 && fs.existsSync(outputWavPath) && fs.statSync(outputWavPath).size > 44) {
                      return resolve(outputWavPath);
                    }
                    reject(new Error(stderr.trim() || `FFmpeg WAV extraction failed (code ${code}).`));
                  });
                });
              }

              let senseVoiceGpuChain = Promise.resolve();
              let senseVoiceWaitingCount = 0;

              /**
               * Serializes local SenseVoice PyTorch/CUDA runs one at a time across concurrent batch videos
               * so GPU VRAM never overflows when Video Manager processes multiple episodes simultaneously.
               */
              function enqueueSenseVoiceTask(fn) {
                senseVoiceWaitingCount++;
                const run = senseVoiceGpuChain.catch(() => { }).then(async () => {
                  senseVoiceWaitingCount = Math.max(0, senseVoiceWaitingCount - 1);
                  return await fn();
                });
                senseVoiceGpuChain = run.catch(() => { });
                return run;
              }

              function runSenseVoiceLocalStt(wavPath, outputJsonPath, options = {}) {
                const {
                  sourceLang = 'auto',
                  castMode = 'multi',
                  fixedVoice = 'Sovereign King',
                  timeoutMs = 15 * 60 * 1000,
                  onProgress = null
                } = options;
                const pyBin = resolveSenseVoicePythonBin();
                if (!pyBin || !fs.existsSync(SENSEVOICE_SCRIPT_PATH)) {
                  return Promise.reject(new Error('SenseVoice Local runtime is unavailable.'));
                }

                return new Promise((resolve, reject) => {
                  const args = [
                    SENSEVOICE_SCRIPT_PATH,
                    '--input', wavPath,
                    '--output', outputJsonPath,
                    '--lang', String(sourceLang || 'auto'),
                    '--device', 'auto',
                    '--hub', 'auto',
                    '--cast-mode', String(castMode || 'multi'),
                    '--fixed-voice', String(fixedVoice || 'Sovereign King'),
                    '--cache-dir', getSenseVoiceCacheDir()
                  ];
                  const proc = spawn(pyBin, args, {
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: buildSenseVoiceChildEnv()
                  });
                  lowerProcessPriority(proc);
                  activeSenseVoiceProcs.add(proc);
                  const unregisterProc = () => activeSenseVoiceProcs.delete(proc);
                  let settled = false;
                  const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    unregisterProc();
                    try { proc.kill('SIGKILL'); } catch (_) { try { proc.kill(); } catch (_) { } }
                    reject(new Error('SenseVoice Local STT timed out.'));
                  }, timeoutMs);

                  let errTail = '';
                  let errBuf = '';
                  if (proc.stdout) proc.stdout.resume();
                  proc.stderr.setEncoding('utf8');
                  proc.stderr.on('data', (chunk) => {
                    errBuf += chunk;
                    errTail = (errTail + chunk).slice(-8192);
                    const lines = errBuf.split(/\r?\n/);
                    errBuf = lines.pop() || '';
                    for (const line of lines) {
                      const m = line.match(/^EZA_STT_PROGRESS:(\d+)\|([^|]*)\|(.*)$/);
                      if (m && typeof onProgress === 'function') {
                        onProgress(parseInt(m[1], 10) || 0, m[2] || '', m[3] || '');
                      }
                    }
                  });
                  proc.once('error', (err) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    unregisterProc();
                    reject(err);
                  });
                  proc.once('close', (code) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    unregisterProc();
                    let parsed = null;
                    try {
                      if (fs.existsSync(outputJsonPath)) {
                        parsed = JSON.parse(fs.readFileSync(outputJsonPath, 'utf8'));
                      }
                    } catch (_) { }
                    if (code === 0 && parsed && parsed.success) {
                      cachedSenseVoiceCaps = null;
                      return resolve(parsed);
                    }
                    const errMsg = (parsed && parsed.error) || errTail.trim().split(/\r?\n/).pop() || `SenseVoice exited with code ${code}`;
                    reject(new Error(errMsg));
                  });
                });
              }

              function finalizeSpeechSegmentsTiming(limitedSegments) {
                for (let i = 0; i < limitedSegments.length; i++) {
                  const seg = limitedSegments[i];
                  const nextSeg = limitedSegments[i + 1];
                  const minDur = Math.max(1.2, Math.min(3.5, seg.text.length * 0.08));
                  if (seg.endSec - seg.startSec < minDur) {
                    seg.endSec = nextSeg
                      ? Math.max(seg.endSec, Math.min(seg.startSec + minDur, nextSeg.startSec - 0.05))
                      : Number((seg.startSec + minDur).toFixed(3));
                  }
                  if (nextSeg && seg.endSec > nextSeg.startSec - 0.02) {
                    if (nextSeg.startSec - seg.startSec >= 0.25) {
                      seg.endSec = Number((nextSeg.startSec - 0.02).toFixed(3));
                    } else {
                      const slotEnd = Number((seg.startSec + Math.min(0.6, Math.max(0.25, seg.text.length * 0.06))).toFixed(3));
                      seg.endSec = slotEnd;
                      nextSeg.startSec = Number((slotEnd + 0.03).toFixed(3));
                      if (nextSeg.endSec <= nextSeg.startSec + 0.25) {
                        nextSeg.endSec = Number((nextSeg.startSec + Math.max(0.8, Math.min(2.5, nextSeg.text.length * 0.08))).toFixed(3));
                      }
                    }
                  }
                }
                return limitedSegments;
              }

              function buildCuesFromDetectedSegments(limitedSegments, effectiveCastMode, fixedVoice) {
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
                    suggestedVoice: rawSuggested ? collapsed : '',
                    ...(segment.speakerId ? { speakerId: String(segment.speakerId) } : {})
                  };
                });
                inferCharacterVoicesForCues(cues, detectedVoiceMap, true, new Map(), { castMode: effectiveCastMode, fixedVoice });
                return cues;
              }

              router.get('/speech-capabilities', async (req, res) => {
                const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
                const sv = await getSenseVoiceCapabilitiesAsync(refresh);
                res.json({
                  success: true,
                  defaultEngine: sv.available ? 'sensevoice' : 'gemini',
                  engines: {
                    sensevoice: { id: 'sensevoice', ...sv },
                    gemini: { id: 'gemini', available: true }
                  }
                });
              });

              router.get('/speech-progress', (req, res) => {
                const reqJobId = typeof (req.query && req.query.jobId) === 'string' ? req.query.jobId.trim() : '';
                const reqVideoPath = typeof (req.query && req.query.videoPath) === 'string' ? req.query.videoPath.trim() : '';
                const lookup = (reqJobId && speechProgressByJob.get(reqJobId)) ||
                  (reqVideoPath && speechProgressByJob.get(path.normalize(reqVideoPath))) ||
                  activeSpeechState;
                res.json({
                  running: lookup.running,
                  totalChunks: lookup.totalChunks,
                  completedChunks: lookup.completedChunks,
                  percent: lookup.percent,
                  stage: lookup.stage,
                  statusText: lookup.statusText,
                  error: lookup.error
                });
              });

              const inFlightSpeechJobs = new Map();

              router.post('/auto-detect-speech', async (req, res) => {
                const {
                  videoPath,
                  sourceLang = 'auto',
                  isolateVocals = true,
                  chunkDurationSec = DEFAULT_SPEECH_CHUNK_SEC,
                  sttEngine = 'gemini'
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
                if (normalizedVideoPath.startsWith('\\\\') || normalizedVideoPath.startsWith('//') || normalizedVideoPath.slice(2).includes(':')) {
                  return res.status(403).json({ success: false, error: 'ផ្លូវវីដេអូមិនត្រូវបានអនុញ្ញាតទេ (Forbidden path)' });
                }
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

                const rawRequestedSttEngine = normalizeSttEngine(sttEngine);
                const engineChoice = resolveSttEngineChoice({
                  sttEngine,
                  sourceLang,
                  capabilities: await getSenseVoiceCapabilitiesAsync(false)
                });
                if (!engineChoice.ok) {
                  return res.status(engineChoice.status || 400).json({ success: false, error: engineChoice.error });
                }
                const effectiveSttEngine = engineChoice.engine;

                let apiKey = '';
                if (effectiveSttEngine === 'gemini') {
                  try {
                    apiKey = loadConfig(req).GEMINI_API_KEY;
                  } catch (err) {
                    console.error('[translation/auto-detect-speech] API key error:', err.message);
                    return res.status(500).json({ success: false, error: 'មិនអាចអាន Gemini API key បានទេ។' });
                  }
                  if (!apiKey) {
                    return res.status(401).json({ success: false, error: 'សូមបញ្ចូល Gemini API key ក្នុង Settings ជាមុនសិន។' });
                  }
                } else if (rawRequestedSttEngine === 'auto') {
                  try {
                    apiKey = loadConfig(req).GEMINI_API_KEY || '';
                  } catch (_) { }
                }

                const effectiveCastMode = normalizeCastMode(req.body && req.body.castMode);
                const fixedVoice = collapseVoiceForCastMode(req.body && req.body.fixedVoice, 'single', req.body && req.body.fixedVoice);
                // Keep full multi-archetype labels (e.g., kh_elder_woman) during STT even in Duo mode,
                // so older women are detected as Female before cue.voice collapses cleanly for Duo.
                const detectSpeechCastMode = effectiveCastMode === 'single' ? 'single' : 'multi';

                const speechJobKey = [
                  normalizedVideoPath,
                  videoStats.size,
                  Math.trunc(videoStats.mtimeMs),
                  sourceLang,
                  Boolean(isolateVocals),
                  effectiveCastMode,
                  fixedVoice,
                  Number(chunkDurationSec) || 0,
                  effectiveSttEngine,
                  rawRequestedSttEngine
                ].join('|');

                const requestedJobId = typeof (req.body && req.body.jobId) === 'string' ? req.body.jobId.trim() : '';
                const existingSpeechJob = inFlightSpeechJobs.get(speechJobKey);
                if (existingSpeechJob) {
                  if (requestedJobId) recordSpeechProgressEntry(requestedJobId, existingSpeechJob.progress);
                  recordSpeechProgressEntry(normalizedVideoPath, existingSpeechJob.progress);
                  const sharedResult = await existingSpeechJob.promise;
                  if (res.headersSent || res.writableEnded) return;
                  return res.status(sharedResult.status).json(sharedResult.body);
                }

                const jobProgress = createSpeechProgressEntry();
                if (requestedJobId) recordSpeechProgressEntry(requestedJobId, jobProgress);
                recordSpeechProgressEntry(normalizedVideoPath, jobProgress);
                const updateSpeechProgress = (patch) => {
                  Object.assign(jobProgress, patch, { updatedAt: Date.now() });
                  Object.assign(activeSpeechState, patch);
                };

                let runSenseVoicePipeline = effectiveSttEngine === 'sensevoice';
                const jobPromise = (async () => {
                  let tempDirectory;
                  let stage = 'audio extraction';
                  const isNetUnreachError = (err) => Boolean(
                    err && (err.isNetworkUnreachable || /EHOSTUNREACH|ENETUNREACH|ENETRESET|ENOTFOUND|EAI_AGAIN/i.test(String(err.message || '')))
                  );
                  activeSpeechJobCount++;
                  updateSpeechProgress({
                    running: true,
                    totalChunks: 0,
                    completedChunks: 0,
                    percent: 3,
                    stage: 'extracting',
                    statusText: runSenseVoicePipeline
                      ? 'កំពុងទាញយកសំឡេង 16kHz សម្រាប់ SenseVoice GPU... (3%)'
                      : 'កំពុងទាញយកសំឡេងពីវីដេអូ... (3%)',
                    error: null
                  });

                  try {
                    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-speech-'));

                    if (runSenseVoicePipeline) {
                      try {
                        let localInputSource = normalizedVideoPath;
                        let hasAiVocals = false;
                        try {
                          const audioMod = require('./audio');
                          const cached = typeof audioMod.getCachedStemsForVideo === 'function'
                            ? audioMod.getCachedStemsForVideo(normalizedVideoPath)
                            : null;
                          if (cached && cached.vocalsPath && fs.existsSync(cached.vocalsPath) &&
                            typeof audioMod.isAiSeparationEngine === 'function' &&
                            audioMod.isAiSeparationEngine(cached.engine)) {
                            localInputSource = cached.vocalsPath;
                            hasAiVocals = true;
                          }
                        } catch (_) { }

                        const wavPath = path.join(tempDirectory, 'sensevoice_16k.wav');
                        const outJsonPath = path.join(tempDirectory, 'sensevoice_result.json');
                        await extractFullSpeechWavForLocalStt(localInputSource, wavPath, {
                          useVocalFilter: !hasAiVocals && Boolean(isolateVocals)
                        });

                        stage = 'SenseVoice Local STT';
                        updateSpeechProgress({
                          stage: 'transcribing',
                          totalChunks: 1,
                          completedChunks: 0,
                          percent: 14,
                          statusText: senseVoiceWaitingCount > 0
                            ? '⏳ កំពុងរង់ចាំវីដេអូមុនចប់ SenseVoice GPU... (14%)'
                            : '🧠 កំពុងស្ដាប់សំឡេងដោយ SenseVoice GPU... (14%)'
                        });

                        const svResult = await enqueueSenseVoiceTask(() => runSenseVoiceLocalStt(wavPath, outJsonPath, {
                          sourceLang,
                          castMode: detectSpeechCastMode,
                          fixedVoice,
                          onProgress: (pct, svStage, msg) => {
                            const mapped = Math.min(97, Math.max(14, Math.round(14 + (pct / 100) * 83)));
                            const prefix = svStage === 'vad'
                              ? '🎯 កំពុងស្កេនរកចន្លោះនិយាយ (VAD)'
                              : (svStage === 'speakers'
                                ? '🎭 កំពុងបែងចែកសំឡេងតួអង្គ (CAM++)'
                                : (svStage === 'loading'
                                  ? '🧠 កំពុងផ្ទុកម៉ូដែល SenseVoice-Small'
                                  : '🎙️ កំពុងស្ដាប់អក្សរ (SenseVoice GPU)'));
                            updateSpeechProgress({
                              stage: 'transcribing',
                              percent: mapped,
                              statusText: `${prefix}: ${msg || ''} (${mapped}%)`
                            });
                          }
                        }));

                        const rawSegments = Array.isArray(svResult && svResult.segments) ? svResult.segments : [];
                        const normalizedSvSegs = rawSegments
                          .filter(s => s && typeof s.text === 'string' && s.text.trim() && Number.isFinite(Number(s.startSec)))
                          .map(s => {
                            const st = Math.max(0, Number(s.startSec));
                            const ed = Number.isFinite(Number(s.endSec)) && Number(s.endSec) > st ? Number(s.endSec) : st + 1.4;
                            return {
                              startSec: Number(st.toFixed(3)),
                              endSec: Number(ed.toFixed(3)),
                              text: String(s.text).trim().slice(0, MAX_CUE_TEXT_LENGTH),
                              suggestedVoice: normalizeSuggestedVoice(s.suggestedVoice),
                              speakerId: String(s.speakerId || '')
                            };
                          })
                          .sort((a, b) => a.startSec - b.startSec);

                        if (normalizedSvSegs.length === 0) {
                          return {
                            status: 422,
                            body: {
                              success: false,
                              error: 'មិនបានរកឃើញពាក្យនិយាយច្បាស់ទេ (វីដេអូអាចមានតែភ្លេង ឬស្ងាត់)។ សូមសាកល្បង OCR អក្សរ ឬនាំចូល .SRT!'
                            }
                          };
                        }

                        const limitedSvSegments = finalizeSpeechSegmentsTiming(normalizedSvSegs.slice(0, MAX_CUES));
                        const svCues = buildCuesFromDetectedSegments(limitedSvSegments, effectiveCastMode, fixedVoice);

                        updateSpeechProgress({
                          completedChunks: 1,
                          percent: 100,
                          statusText: `ចាប់សំឡេង Local GPU ជោគជ័យ: ${svCues.length} បន្ទាត់! (100%)`
                        });

                        return {
                          status: 200,
                          body: {
                            success: true,
                            cues: svCues,
                            sttEngine: 'sensevoice',
                            device: svResult.device || 'cuda:0',
                            hub: svResult.hub || 'ms',
                            chunkCount: 1,
                            activeChunkCount: 1,
                            skippedSilentChunks: 0,
                            failedChunkCount: 0,
                            sourceLang
                          }
                        };
                      } catch (svErr) {
                        if (rawRequestedSttEngine === 'auto' && apiKey) {
                          console.warn('[translation/auto-detect-speech] SenseVoice auto-fallback to Gemini:', svErr.message);
                          runSenseVoicePipeline = false;
                          stage = 'audio extraction';
                          updateSpeechProgress({
                            stage: 'extracting',
                            percent: 8,
                            statusText: 'SenseVoice Local មានបញ្ហា — កំពុងប្ដូរទៅ Gemini STT... (8%)'
                          });
                        } else {
                          throw svErr;
                        }
                      }
                    }

                    const chunks = await extractSpeechAudioChunks(normalizedVideoPath, tempDirectory, {
                      chunkDurationSec,
                      isolateVocals: Boolean(isolateVocals),
                      probeActivity: true,
                      onProgress: (done, total) => {
                        const pct = Math.min(15, Math.round(3 + (done / total) * 12));
                        updateSpeechProgress({
                          percent: pct,
                          statusText: `កំពុងទាញយកសំឡេង: ដុំ ${done}/${total} (${pct}%)`
                        });
                      }
                    });

                    if (chunks.length === 0) {
                      return { status: 422, body: { success: false, error: 'រកមិនឃើញសំឡេងក្នុងវីដេអូទេ។' } };
                    }

                    const speechVoiceRules = detectSpeechCastMode === 'single'
                      ? `locked single narrator "voice" — output ONLY "${fixedVoice}" for EVERY segment (do NOT switch speaker voice)`
                      : (detectSpeechCastMode === 'duo'
                        ? `speaker "voice" (STRICT 2-CHARACTER DUO LOCK — output ONLY ONE of these 2 IDs based on the real human gender/pitch you hear):
- "Radiant Queen" (Female / Woman speaker)
- "Sovereign King" (Male / Man speaker)
Keep the SAME speaker on the EXACT SAME voice ID from start to finish (never split one person into multiple voices when their emotion changes).`
                        : `speaker "voice" — ${MULTI_CAST_VOICE_RULES}
CRITICAL: A single speaking character MUST keep the exact same voice ID across ALL of their lines, even when angry, whispering, or crying. Keep total episode cast compact (usually 2-4 speakers max).`);

                    updateSpeechProgress({
                      stage: 'filtering',
                      percent: 16,
                      statusText: `កំពុងស្កេនរំលងផ្នែកស្ងាត់ (0/${chunks.length})... (16%)`
                    });

                    let skippedSilentChunks = 0;
                    const chunkPayloads = [];
                    const activityList = await mapWithConcurrency(chunks, 6, async (chunk) => {
                      return chunk.activity || probeAudioActivity(chunk.audioPath);
                    });
                    for (let idx = 0; idx < chunks.length; idx++) {
                      const chunk = chunks[idx];
                      const activity = activityList[idx];
                      if (activity && !activity.hasActivity) {
                        skippedSilentChunks++;
                        continue;
                      }
                      let audioStat;
                      try {
                        audioStat = await fs.promises.stat(chunk.audioPath);
                      } catch (_) {
                        continue;
                      }
                      if (!audioStat || audioStat.size === 0) continue;
                      if (audioStat.size > MAX_SPEECH_AUDIO_BYTES) {
                        return {
                          status: 413,
                          body: {
                            success: false,
                            error: 'សំឡេងវែងពេកសម្រាប់ដំណើរការមួយលើក។ សូមបំបែកវីដេអូជាផ្នែកខ្លីៗ។'
                          }
                        };
                      }
                      chunkPayloads.push({ chunk });
                    }

                    if (chunkPayloads.length === 0) {
                      return {
                        status: 422,
                        body: {
                          success: false,
                          error: 'វីដេអូនេះស្ងាត់ ឬគ្មានសំឡេងមនុស្សនិយាយច្បាស់ទេ (បានរំលងផ្នែកស្ងាត់ទាំងអស់)។ សូមសាកល្បង OCR អក្សរ ឬនាំចូល .SRT!'
                        }
                      };
                    }

                    const skipNote = skippedSilentChunks > 0 ? ` • រំលងស្ងាត់ ${skippedSilentChunks}` : '';
                    stage = 'Gemini transcription';
                    updateSpeechProgress({
                      stage: 'transcribing',
                      totalChunks: chunkPayloads.length,
                      completedChunks: 0,
                      percent: 18,
                      statusText: `កំពុងចាប់សំឡេង AI: ដុំ 0/${chunkPayloads.length}${skipNote} (18%)`
                    });

                    const speechPrompt = `Transcribe EVERY SINGLE spoken character dialogue line, phrase, question, exclamations, or short reply in this video audio in ${srcSpec.speechHint}.
${srcSpec.name === 'Chinese' ? 'Output strictly in Simplified Chinese characters (简体中文) — NEVER switch mid-video to Traditional Chinese, and transcribe character names, numbers, and idioms accurately from context.' : ''}
Do NOT skip any spoken dialogue — even short (1-2 words), quiet, whispered, emotional, or overlapping utterances.
CRITICAL FOR MIXED MUSIC/SONG SCENES: If characters speak WHILE a song, singing, or loud background music is playing, you MUST STILL transcribe EVERY spoken dialogue line audible over the music!
Ignore ONLY purely instrumental sections or standalone solo theme-song singing (OP/ED) that have ZERO spoken dialogue.
If a section truly has only music/instrumental/silence and NO spoken dialogue at all, return {"segments":[]}.
Do not translate, summarize, or invent dialogue.
Split continuous speech into readable subtitle segments. For each segment, give accurate startSec (when the spoken voice begins speaking), endSec (when the voice completely finishes the phrase), and ${speechVoiceRules}.
Return only valid JSON in this exact shape:
{"segments":[{"startSec":1.25,"endSec":2.8,"text":"...","voice":"Radiant Queen"}]}`;

                    const speechKeyCount = Math.max(
                      getGeminiApiKeyCandidates(apiKey, `api:${GEMINI_FAST_LITE_MODEL}`, { skipAllRateLimited: true, advanceCursor: false }).length,
                      getGeminiApiKeyCandidates(apiKey, `api:${GEMINI_MODEL}`, { skipAllRateLimited: true, advanceCursor: false }).length,
                      1
                    );
                    const segmentsByChunk = new Array(chunkPayloads.length).fill(null).map(() => []);
                    const failedChunkSet = new Set();
                    let completedSpeechChunks = 0;
                    let succeededChunkCount = 0;
                    let consecutiveNetUnreach = 0;
                    let firstFatalChunkErr = null;
                    let networkAbortedErr = null;

                    const processSpeechChunk = async (
                      payloadIdx,
                      extraRosterPrompt = '',
                      requestTimeoutMs = SPEECH_REQUEST_TIMEOUT_MS,
                      isRecoveryWave = false
                    ) => {
                      if (networkAbortedErr) return;
                      const { chunk } = chunkPayloads[payloadIdx];
                      const audioBase64 = (await fs.promises.readFile(chunk.audioPath)).toString('base64');
                      const promptWithRoster = extraRosterPrompt ? `${speechPrompt}\n\n${extraRosterPrompt}` : speechPrompt;
                      let lastChunkErr = null;

                      for (let attempt = 0; attempt < 3; attempt++) {
                        if (networkAbortedErr) break;
                        try {
                          if (attempt > 0) {
                            await new Promise(r => setTimeout(r, 900 * attempt));
                          }
                          const response = await callGeminiApi(promptWithRoster, apiKey, [{
                            inline_data: {
                              mime_type: 'audio/mp3',
                              data: audioBase64
                            }
                          }], requestTimeoutMs, { preferFastModel: true });
                          const parsed = parseJsonObject(response, 'speech transcription');
                          segmentsByChunk[payloadIdx] = [];
                          if (Array.isArray(parsed.segments)) {
                            for (const segment of parsed.segments) {
                              if (!segment || typeof segment.text !== 'string') continue;
                              const cleanSegText = decodeUnicodeEscapes(segment.text).trim();
                              if (!cleanSegText) continue;
                              const rawStart = Number(segment.startSec);
                              const rawEnd = Number(segment.endSec);
                              if (!Number.isFinite(rawStart) || rawStart < 0) continue;
                              const safeEnd = Number.isFinite(rawEnd) && rawEnd > rawStart ? rawEnd : rawStart + 1.4;
                              segmentsByChunk[payloadIdx].push({
                                chunkIndex: payloadIdx,
                                startSec: Number(Math.max(0, rawStart + chunk.offsetSec - 0.05).toFixed(3)),
                                endSec: Number((safeEnd + chunk.offsetSec + 0.15).toFixed(3)),
                                text: cleanSegText.slice(0, MAX_CUE_TEXT_LENGTH),
                                suggestedVoice: normalizeSuggestedVoice(segment.voice)
                              });
                            }
                          }
                          lastChunkErr = null;
                          failedChunkSet.delete(payloadIdx);
                          consecutiveNetUnreach = 0;
                          succeededChunkCount++;
                          break;
                        } catch (chunkErr) {
                          lastChunkErr = chunkErr;
                          console.warn(`[translation/auto-detect-speech] Chunk ${payloadIdx + 1} ${isRecoveryWave ? 'recovery ' : ''}attempt ${attempt + 1} warning:`, chunkErr.message);
                          if (isNetUnreachError(chunkErr)) {
                            break;
                          }
                        }
                      }

                      if (lastChunkErr) {
                        failedChunkSet.add(payloadIdx);
                        if (!firstFatalChunkErr) firstFatalChunkErr = lastChunkErr;
                        if (isNetUnreachError(lastChunkErr)) {
                          consecutiveNetUnreach++;
                          if (consecutiveNetUnreach >= 3 && succeededChunkCount === 0) {
                            networkAbortedErr = lastChunkErr;
                          }
                        } else {
                          consecutiveNetUnreach = 0;
                        }
                        if (payloadIdx === 0 && chunkPayloads.length === 1) {
                          throw lastChunkErr;
                        }
                      }

                      if (!isRecoveryWave) {
                        completedSpeechChunks++;
                        const pct = Math.min(95, Math.round(18 + (completedSpeechChunks / chunkPayloads.length) * 77));
                        updateSpeechProgress({
                          completedChunks: completedSpeechChunks,
                          percent: pct,
                          statusText: `កំពុងចាប់សំឡេង AI: ដុំ ${completedSpeechChunks}/${chunkPayloads.length}${skipNote} (${pct}%)`
                        });
                      }
                    };

                    let wave2RosterPrompt = '';
                    const speechConcurrency = Math.min(8, Math.max(2, speechKeyCount), chunkPayloads.length || 1);
                    if (chunkPayloads.length === 1) {
                      await processSpeechChunk(0, '');
                    } else if (effectiveCastMode === 'single' || chunkPayloads.length > 4) {
                      // Parallelize ALL chunks from t=0 on single-voice or long movies instead of stalling all workers behind Chunk 0
                      let chunkCursor = 0;
                      const speechWorkers = Array.from({ length: speechConcurrency }, async () => {
                        while (chunkCursor < chunkPayloads.length && !networkAbortedErr) {
                          const payloadIdx = chunkCursor++;
                          await processSpeechChunk(payloadIdx, '');
                        }
                      });
                      await Promise.all(speechWorkers);
                    } else if (chunkPayloads.length > 1) {
                      // Short multi/duo clips (<= 4 chunks): lock Part 1 character roster cleanly before remaining chunks
                      await processSpeechChunk(0, '');
                      wave2RosterPrompt = [
                        buildEstablishedCastRoster(segmentsByChunk[0]),
                        buildTranscriptContinuityContext(segmentsByChunk[0], srcSpec)
                      ].filter(Boolean).join('\n\n');
                      const remainingIndices = Array.from({ length: chunkPayloads.length - 1 }, (_, k) => k + 1);
                      let remCursor = 0;
                      const remWorkers = Math.min(speechConcurrency, remainingIndices.length || 1);
                      const speechWorkers = Array.from({ length: remWorkers }, async () => {
                        while (remCursor < remainingIndices.length && !networkAbortedErr) {
                          const payloadIdx = remainingIndices[remCursor++];
                          await processSpeechChunk(payloadIdx, wave2RosterPrompt);
                        }
                      });
                      await Promise.all(speechWorkers);
                    }

                    // Wave-2 calm recovery for chunks that timed out or hit burst 429 during parallel Wave 1
                    if (!networkAbortedErr && failedChunkSet.size > 0 && chunkPayloads.length > 1) {
                      const retryIndices = Array.from(failedChunkSet);
                      updateSpeechProgress({
                        statusText: `កំពុងស្តារដុំដែលបរាជ័យឡើងវិញ (${retryIndices.length} ដុំ)... (95%)`
                      });
                      await new Promise(r => setTimeout(r, 1800));
                      let recoveryCursor = 0;
                      const recoveryWorkers = Math.min(2, retryIndices.length);
                      await Promise.all(Array.from({ length: recoveryWorkers }, async () => {
                        while (recoveryCursor < retryIndices.length && !networkAbortedErr) {
                          const payloadIdx = retryIndices[recoveryCursor++];
                          const roster = payloadIdx === 0 ? '' : wave2RosterPrompt;
                          await processSpeechChunk(payloadIdx, roster, Math.max(SPEECH_REQUEST_TIMEOUT_MS, 95000), true);
                        }
                      }));
                    }

                    const failedChunkCount = failedChunkSet.size;
                    if (networkAbortedErr && succeededChunkCount === 0) {
                      throw networkAbortedErr;
                    }
                    const allSegments = segmentsByChunk.flat();

                    // Pass 2: Rescue any >=12s timeline gaps (such as late-chunk dropouts) that contain real vocal speech
                    if (!networkAbortedErr && chunkPayloads.length > 0 && allSegments.length > 0) {
                      try {
                        const totalVideoDur = await probeVideoDurationSec(normalizedVideoPath);
                        if (totalVideoDur >= 20) {
                          const prelim = deduplicateOverlappingSegments(allSegments);
                          const candidateGaps = [];
                          if (prelim[0].startSec >= 12) {
                            candidateGaps.push({ startSec: 0, endSec: prelim[0].startSec });
                          }
                          for (let i = 0; i < prelim.length - 1; i++) {
                            const gapStart = prelim[i].endSec;
                            const gapEnd = prelim[i + 1].startSec;
                            if (gapEnd - gapStart >= 12) {
                              candidateGaps.push({ startSec: gapStart, endSec: gapEnd });
                            }
                          }
                          const lastSegEnd = prelim[prelim.length - 1].endSec;
                          if (totalVideoDur - lastSegEnd >= 12) {
                            candidateGaps.push({ startSec: lastSegEnd, endSec: totalVideoDur });
                          }

                          if (candidateGaps.length > 0) {
                            let activityProbeSource = normalizedVideoPath;
                            let hasAiVocals = false;
                            try {
                              const audioMod = require('./audio');
                              const cached = typeof audioMod.getCachedStemsForVideo === 'function'
                                ? audioMod.getCachedStemsForVideo(normalizedVideoPath)
                                : null;
                              if (cached && cached.vocalsPath && fs.existsSync(cached.vocalsPath) &&
                                typeof audioMod.isAiSeparationEngine === 'function' &&
                                audioMod.isAiSeparationEngine(cached.engine)) {
                                activityProbeSource = cached.vocalsPath;
                                hasAiVocals = true;
                              }
                            } catch (_) { }

                            const checkedGaps = await mapWithConcurrency(candidateGaps.slice(0, 36), 6, async (g) => {
                              const act = await probeSpeechGapActivity(activityProbeSource, g.startSec, g.endSec);
                              return { ...g, ...act };
                            });
                            const speechGaps = checkedGaps
                              .filter(g => g.hasSpeech)
                              .sort((a, b) => b.activeSec - a.activeSec)
                              .slice(0, 24);

                            const rescueSlices = [];
                            for (const g of speechGaps) {
                              const winStart = Math.max(0, g.startSec - 0.5);
                              const winEnd = Math.min(totalVideoDur, g.endSec + 0.5);
                              for (let s = winStart; s < winEnd - 1.0; s += 40) {
                                const e = Math.min(winEnd, s + 42);
                                rescueSlices.push({ startSec: s, durationSec: Math.max(2, e - s) });
                              }
                            }

                            if (rescueSlices.length > 0) {
                              updateSpeechProgress({
                                percent: 96,
                                statusText: `កំពុងស្កេនស្តារសំឡេងនៅចន្លោះខ្វះ (${rescueSlices.length} វគ្គ)... (96%)`
                              });
                              let rCursor = 0;
                              let rescueChunkId = chunkPayloads.length + 100;
                              const rescueWorkers = Math.min(4, rescueSlices.length);
                              await Promise.all(Array.from({ length: rescueWorkers }, async () => {
                                while (rCursor < rescueSlices.length && !networkAbortedErr) {
                                  const sl = rescueSlices[rCursor++];
                                  const rId = ++rescueChunkId;
                                  const slicePath = path.join(tempDirectory, `speech_rescue_${rId}.mp3`);
                                  try {
                                    await extractSpeechAudio(hasAiVocals ? activityProbeSource : normalizedVideoPath, slicePath, {
                                      startSec: sl.startSec,
                                      durationSec: sl.durationSec,
                                      isolateVocals: !hasAiVocals && Boolean(isolateVocals),
                                      probeActivity: false
                                    });
                                    if (!fs.existsSync(slicePath) || fs.statSync(slicePath).size <= 100) continue;
                                    const b64 = (await fs.promises.readFile(slicePath)).toString('base64');
                                    const rPrompt = `${speechPrompt}\n\n${wave2RosterPrompt ? wave2RosterPrompt + '\n\n' : ''}RESCUE PASS: Focus carefully on EVERY spoken line inside this short audio clip, even quiet, fast, or music-overlaid dialogue.`;
                                    const rResp = await callGeminiApi(rPrompt, apiKey, [{
                                      inline_data: { mime_type: 'audio/mp3', data: b64 }
                                    }], Math.max(SPEECH_REQUEST_TIMEOUT_MS, 75000), { preferQuality: true });
                                    const rParsed = parseJsonObject(rResp, 'speech gap rescue');
                                    if (Array.isArray(rParsed.segments)) {
                                      for (const seg of rParsed.segments) {
                                        if (!seg || typeof seg.text !== 'string') continue;
                                        const cleanTxt = decodeUnicodeEscapes(seg.text).trim();
                                        if (!cleanTxt) continue;
                                        const rs = Number(seg.startSec);
                                        const re = Number(seg.endSec);
                                        if (!Number.isFinite(rs) || rs < 0) continue;
                                        const safeEnd = Number.isFinite(re) && re > rs ? re : rs + 1.4;
                                        allSegments.push({
                                          chunkIndex: rId,
                                          startSec: Number(Math.max(0, rs + sl.startSec - 0.05).toFixed(3)),
                                          endSec: Number((safeEnd + sl.startSec + 0.15).toFixed(3)),
                                          text: cleanTxt.slice(0, MAX_CUE_TEXT_LENGTH),
                                          suggestedVoice: normalizeSuggestedVoice(seg.voice)
                                        });
                                      }
                                    }
                                  } catch (rescueErr) {
                                    console.warn('[translation/speech-gap-rescue] Warning:', rescueErr.message);
                                  }
                                }
                              }));
                            }
                          }
                        }
                      } catch (gapScanErr) {
                        console.warn('[translation/speech-gap-scan] Warning:', gapScanErr.message);
                      }
                    }

                    if (allSegments.length === 0 && succeededChunkCount === 0 && firstFatalChunkErr) {
                      throw firstFatalChunkErr;
                    }

                    if (allSegments.length === 0) {
                      return {
                        status: 422,
                        body: {
                          success: false,
                          error: 'មិនបានរកឃើញពាក្យនិយាយច្បាស់ទេ (វីដេអូអាចមានតែភ្លេង/ចម្រៀង ឬស្ងាត់)។ សូមសាកល្បង OCR អក្សរ ឬនាំចូល .SRT!'
                        }
                      };
                    }

                    const dedupedSegments = deduplicateOverlappingSegments(allSegments);
                    const limitedSegments = finalizeSpeechSegmentsTiming(dedupedSegments.slice(0, MAX_CUES));
                    const cues = buildCuesFromDetectedSegments(limitedSegments, effectiveCastMode, fixedVoice);

                    updateSpeechProgress({
                      percent: 100,
                      statusText: `ចាប់សំឡេងជោគជ័យ: ${cues.length} បន្ទាត់! (100%)`
                    });

                    return {
                      status: 200,
                      body: {
                        success: true,
                        cues,
                        sttEngine: 'gemini',
                        chunkCount: chunks.length,
                        activeChunkCount: chunkPayloads.length,
                        skippedSilentChunks,
                        failedChunkCount,
                        sourceLang
                      }
                    };
                  } catch (err) {
                    console.error(`[translation/auto-detect-speech] ${stage} error:`, err.message);
                    updateSpeechProgress({ error: err.message });
                    const status = stage === 'Gemini transcription' ? 502 : 500;
                    const networkHint = isNetUnreachError(err)
                      ? 'មិនអាចភ្ជាប់អ៊ីនធឺណិតទៅ Gemini API បានទេ (Network unreachable) — សូមពិនិត្យ Hotspot/Wi-Fi ឬ DNS រួចសាកល្បងម្ដងទៀត។'
                      : err.message;
                    return {
                      status,
                      body: {
                        success: false,
                        error: stage === 'Gemini transcription'
                          ? networkHint
                          : (stage === 'SenseVoice Local STT'
                            ? `SenseVoice Local STT បរាជ័យ៖ ${err.message}`
                            : 'មិនអាចដកសំឡេងពីវីដេអូបានទេ។ សូមពិនិត្យ FFmpeg និងឯកសារវីដេអូ។')
                      }
                    };
                  } finally {
                    jobProgress.running = false;
                    jobProgress.stage = 'idle';
                    jobProgress.updatedAt = Date.now();
                    activeSpeechJobCount = Math.max(0, activeSpeechJobCount - 1);
                    if (activeSpeechJobCount === 0) {
                      activeSpeechState.running = false;
                      activeSpeechState.stage = 'idle';
                    }
                    if (tempDirectory) {
                      try {
                        fs.rmSync(tempDirectory, { recursive: true, force: true });
                      } catch (err) {
                        console.error('[translation/auto-detect-speech] Temporary audio cleanup failed:', err.message);
                      }
                    }
                  }
                })();

                const jobEntry = { promise: jobPromise, progress: jobProgress };
                inFlightSpeechJobs.set(speechJobKey, jobEntry);
                jobPromise.finally(() => {
                  if (inFlightSpeechJobs.get(speechJobKey) === jobEntry) {
                    inFlightSpeechJobs.delete(speechJobKey);
                  }
                }).catch(() => { });

                const result = await jobPromise;
                if (res.headersSent || res.writableEnded) return;
                return res.status(result.status).json(result.body);
              });

              router.get('/router-mode', (req, res) => {
                const mode = getRouterModelMode();
                res.json({
                  success: true,
                  mode,
                  primaryModel: mode === 'smart' ? HYDROGEN_MODEL : GEMINI_MODEL,
                  thinkingLevel: mode === 'smart' ? (process.env.GEMINI_4_THINKING_LEVEL || 'low') : 'none',
                  fallbackModels: GEMINI_FALLBACK_MODELS,
                  respan: getSafeRespanSnapshot(req)
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
                  fallbackModels: GEMINI_FALLBACK_MODELS,
                  respan: getSafeRespanSnapshot(req)
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
              router.deduplicateOverlappingSegments = deduplicateOverlappingSegments;
              router.probeSpeechGapActivity = probeSpeechGapActivity;
              router.normalizeSttEngine = normalizeSttEngine;
              router.isSenseVoiceSupportedLanguage = isSenseVoiceSupportedLanguage;
              router.resolveSttEngineChoice = resolveSttEngineChoice;
              router.getSenseVoiceCapabilities = getSenseVoiceCapabilities;
              router.enqueueSenseVoiceTask = enqueueSenseVoiceTask;
              router.buildSpeechAudioFilterChain = buildSpeechAudioFilterChain;
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
              router.normalizeKhmerNaturalDramaWordChoice = normalizeKhmerNaturalDramaWordChoice;
              router.normalizeKhmerNumericText = normalizeKhmerNumericText;
              router.KHMER_NUMERIC_AND_UNITS_GUIDE = KHMER_NUMERIC_AND_UNITS_GUIDE;
              router.KHMER_REAL_LIFE_NATURAL_SPEECH_GUIDE = KHMER_REAL_LIFE_NATURAL_SPEECH_GUIDE;
              router.cleanTranslatedText = cleanTranslatedText;
              router.isTranslationIncomplete = isTranslationIncomplete;
              router.resolveSeriesGlossaryKey = resolveSeriesGlossaryKey;
              router.loadSeriesGlossary = loadSeriesGlossary;
              router.saveSeriesGlossary = saveSeriesGlossary;
              router.mergeStoryBibleWithSeries = mergeStoryBibleWithSeries;
              router.formatStoryBibleForPrompt = formatStoryBibleForPrompt;
              router.buildEpisodeStoryBible = buildEpisodeStoryBible;
              router.reflectOnEpisodeTranslations = reflectOnEpisodeTranslations;
              router.detectDraftIdOffsetMode = detectDraftIdOffsetMode;
              router.resolveDraftCueId = resolveDraftCueId;
              router.translateWithReflection = translateWithReflection;
              router.polishTranslatedCues = polishTranslatedCues;
              router.callGeminiApi = callGeminiApi;
              router.cancelActiveSenseVoiceProcesses = function cancelActiveSenseVoiceProcesses() {
                let killed = 0;
                for (const proc of activeSenseVoiceProcs) {
                  try {
                    if (process.platform === 'win32' && proc.pid) {
                      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                    }
                    proc.kill('SIGKILL');
                    killed++;
                  } catch (_) { }
                }
                activeSenseVoiceProcs.clear();
                return killed;
              };

              module.exports = router;
