/**
 * ⚡ EZA PRO - Backend Logic
 * Migrated from server.js to work with Electron
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, exec } = require('child_process');

// Import existing modules
const translationCache = require('../../translation_cache');

let EdgeTTS;
try {
  EdgeTTS = require('@andresaya/edge-tts').EdgeTTS;
} catch (_) {
  console.warn('⚠️  EdgeTTS module not loaded');
}

// Configuration
let configFile = path.join(__dirname, '..', '..', 'config.json');
const AUDIO_CACHE_DIR = process.env.AUDIO_CACHE_DIR || path.join(__dirname, '..', '..', 'audio_cache');
const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, '..', '..', 'Exported');
const DRAFTS_DIR = path.join(__dirname, '..', '..', 'drafts');

// Ensure directories exist
[AUDIO_CACHE_DIR, EXPORT_DIR, DRAFTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Load configuration
function loadConfig() {
  let cfg = {
    DOWNLOAD_DIR: process.env.DOWNLOAD_DIR || path.join(__dirname, '..', '..', 'videos')
  };
  
  try {
    if (fs.existsSync(configFile)) {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (parsed.DOWNLOAD_DIR) {
        cfg.DOWNLOAD_DIR = parsed.DOWNLOAD_DIR;
      }
    }
  } catch (err) {
    console.warn('[Config] Warning loading config:', err.message);
  }
  
  return cfg;
}

// Save configuration
function saveConfig(cfg) {
  const current = loadConfig();
  const merged = { ...current, ...cfg };
  
  const safeConfig = {
    DOWNLOAD_DIR: merged.DOWNLOAD_DIR
  };
  
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(safeConfig, null, 2), 'utf8');
    console.log('[Config] Saved preferences');
  } catch (err) {
    console.error('[Config] Failed to save:', err.message);
  }
}

// Setup Express routes
function callGemini(prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
    });
    const request = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 30000
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (err) {
          return reject(new Error('Gemini returned an invalid response.'));
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const message = parsed.error && parsed.error.message;
          return reject(new Error(message || `Gemini API returned HTTP ${response.statusCode}.`));
        }

        const text = parsed.candidates && parsed.candidates[0] &&
          parsed.candidates[0].content && parsed.candidates[0].content.parts &&
          parsed.candidates[0].content.parts.map(part => part.text || '').join('');
        if (!text || !text.trim()) {
          return reject(new Error('Gemini returned an empty response.'));
        }
        resolve(text.trim());
      });
    });

    request.setTimeout(30000, () => request.destroy(new Error('Gemini request timed out.')));
    request.on('error', reject);
    request.end(postData);
  });
}

function setupRoutes(app, options = {}) {
  const { getGeminiApiKey, configPath } = options;
  if (configPath) configFile = configPath;
  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      message: '⚡ EZA PRO Backend is running',
      version: require('../../package.json').version
    });
  });
  
  // Get configuration
  app.get('/api/config', (req, res) => {
    const cfg = loadConfig();
    res.json({ 
      success: true, 
      config: {
        DOWNLOAD_DIR: cfg.DOWNLOAD_DIR,
        hasApiKey: typeof getGeminiApiKey === 'function' && !!getGeminiApiKey()
      }
    });
  });
  
  // Save configuration
  app.post('/api/config', (req, res) => {
    try {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'GEMINI_API_KEY')) {
        return res.status(400).json({
          success: false,
          error: 'Manage the Gemini API key through the secure settings dialog.'
        });
      }
      saveConfig(req.body);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/ai/test', async (req, res) => {
    try {
      const apiKey = typeof getGeminiApiKey === 'function' ? getGeminiApiKey() : '';
      if (!apiKey) {
        return res.status(401).json({ success: false, error: 'រកមិនឃើញ Gemini API key ទេ។' });
      }
      await callGemini('Reply with exactly: OK', apiKey);
      res.json({ success: true });
    } catch (err) {
      res.status(502).json({ success: false, error: err.message });
    }
  });

  app.post('/api/translate-cues', async (req, res) => {
    const { cues, targetLang = 'km', useCache = true } = req.body || {};
    const targetLanguages = {
      km: 'natural, conversational Khmer',
      en: 'natural English',
      'zh-km': 'bilingual Chinese and Khmer, preserving the Chinese dialogue and adding its Khmer translation separated by " | "'
    };
    if (!Array.isArray(cues) || cues.length === 0 || cues.length > 300 ||
        cues.some(cue => !cue || typeof cue.text !== 'string' || cue.text.length > 2000)) {
      return res.status(400).json({ success: false, error: 'សូមផ្ទុក subtitle ដែលមានទិន្នន័យត្រឹមត្រូវ (អតិបរមា 300 បន្ទាត់)។' });
    }
    if (!Object.prototype.hasOwnProperty.call(targetLanguages, targetLang)) {
      return res.status(400).json({ success: false, error: 'ភាសាគោលដៅមិនត្រឹមត្រូវ។' });
    }
    if (typeof useCache !== 'boolean') {
      return res.status(400).json({ success: false, error: 'ជម្រើស cache មិនត្រឹមត្រូវ។' });
    }

    let apiKey;
    try {
      apiKey = typeof getGeminiApiKey === 'function' ? getGeminiApiKey() : '';
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'សូមបញ្ចូល Gemini API key ក្នុង Settings ជាមុនសិន។' });
    }

    try {
      const resultCues = cues.map(cue => ({ ...cue }));
      let translatedCount = 0;
      let cacheHits = 0;
      let apiCalls = 0;
      const untranslated = [];

      for (let i = 0; i < resultCues.length; i++) {
        const cue = resultCues[i];
        if (cue.translated && cue.translated !== cue.text) continue;
        const cached = useCache ? await translationCache.get(cue.text, 'zh', targetLang) : null;
        if (cached) {
          cue.translated = cached;
          translatedCount++;
          cacheHits++;
        } else {
          untranslated.push({ cue });
        }
      }

      for (let i = 0; i < untranslated.length; i += 30) {
        const chunk = untranslated.slice(i, i + 30);
        const lines = chunk.map((item, index) => `${index + 1}: ${item.cue.text.replace(/\n/g, ' ')}`).join('\n');
        const prompt = `Translate these Chinese subtitle lines into ${targetLanguages[targetLang]}. Return exactly one line per input in the format [number]: [translation], with no explanation.\n\n${lines}`;
        const response = await callGemini(prompt, apiKey);
        apiCalls++;
        const translations = new Map();
        for (const line of response.split(/\r?\n/)) {
          const match = line.match(/^(\d+)[\s.:：]+(.*)$/);
          if (match && Number(match[1]) >= 1 && Number(match[1]) <= chunk.length && match[2].trim()) {
            translations.set(Number(match[1]) - 1, match[2].trim());
          }
        }
        if (translations.size !== chunk.length) {
          throw new Error(`Gemini returned ${translations.size} of ${chunk.length} subtitle translations.`);
        }
        for (let j = 0; j < chunk.length; j++) {
          const translation = translations.get(j);
          chunk[j].cue.translated = translation;
          translatedCount++;
          if (useCache) await translationCache.set(chunk[j].cue.text, translation, 'zh', targetLang);
        }
      }

      res.json({
        success: true,
        cues: resultCues,
        translatedCount,
        totalCount: cues.length,
        cacheHits,
        apiCalls,
        cacheStats: translationCache.getStats()
      });
    } catch (err) {
      console.error('[translate-cues error]:', err.message);
      res.status(502).json({ success: false, error: err.message });
    }
  });
  
  console.log('✅ Backend routes configured');
}

module.exports = {
  setupRoutes,
  loadConfig,
  saveConfig
};
