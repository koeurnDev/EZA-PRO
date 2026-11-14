/**
 * ⚡ EZA PRO - Audio Stem Separation & BGM Isolation Routes
 * Separates video audio into clean BGM (no_vocals) and Vocals stems using
 * AI separators (UVR audio-separator / Demucs) with built-in FFmpeg multi-band DSP fallback.
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { FFMPEG_BIN } = require('../utils/ffmpeg');

const MIN_VALID_AUDIO_BYTES = 100;

/**
 * Multi-stage stereo center vocal suppression + speech-formant notch EQ + FFT denoise.
 * Preserves bass (<250Hz), high-frequency SFX/air (>4kHz), and stereo music width while
 * attenuating center-panned human dialogue (300Hz-3400Hz).
 */
const BGM_ISOLATION_FILTER = [
  'aresample=44100',
  'aformat=sample_fmts=fltp:channel_layouts=stereo',
  'stereotools=mlev=0.04:slev=1.25',
  'equalizer=f=380:t=q:w=1.0:g=-14',
  'equalizer=f=750:t=q:w=1.0:g=-18',
  'equalizer=f=1400:t=q:w=0.9:g=-22',
  'equalizer=f=2400:t=q:w=0.9:g=-20',
  'equalizer=f=3400:t=q:w=1.0:g=-15',
  'afftdn=nf=-25',
  'alimiter=limit=0.95'
].join(',');

/**
 * Center-channel dialogue booster + speech bandpass filter for clean voice extraction.
 */
const VOCAL_ISOLATION_FILTER = [
  'aresample=44100',
  'aformat=sample_fmts=fltp:channel_layouts=stereo',
  'stereotools=mlev=1.2:slev=0.15',
  'highpass=f=140',
  'lowpass=f=4200',
  'equalizer=f=1800:t=q:w=1.2:g=4',
  'afftdn=nf=-25',
  'alimiter=limit=0.95'
].join(',');

let cachedSeparationEngine;

function getBgmCacheDir() {
  const dir = process.env.BGM_CACHE_DIR ||
    (process.env.AUDIO_CACHE_DIR
      ? path.join(process.env.AUDIO_CACHE_DIR, 'bgm_stems')
      : path.join(__dirname, '..', '..', '..', 'bgm_cache'));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function isValidAudioFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > MIN_VALID_AUDIO_BYTES;
  } catch (_) {
    return false;
  }
}

/**
 * Compute deterministic cache key for a video file based on path, size, and mtime.
 */
function getBgmCacheKey(videoPath) {
  const normalized = path.normalize(String(videoPath || '').trim());
  let sig = normalized;
  try {
    const stat = fs.statSync(normalized);
    sig = `${normalized}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch (_) {}
  return crypto.createHash('md5').update(sig).digest('hex');
}

/**
 * Detect best available stem separation engine (UVR audio-separator -> Demucs -> FFmpeg DSP).
 */
function detectSeparationEngine(forceRefresh = false) {
  if (cachedSeparationEngine && !forceRefresh) {
    return cachedSeparationEngine;
  }

  try {
    const uvr = spawnSync('audio-separator', ['--version'], { encoding: 'utf8', timeout: 3000 });
    if (uvr.status === 0) {
      cachedSeparationEngine = {
        id: 'audio-separator',
        label: 'UVR MDX-Net AI',
        ai: true
      };
      return cachedSeparationEngine;
    }
  } catch (_) {}

  for (const [cmd, prefix] of [['demucs', []], ['py', ['-m', 'demucs']], ['python', ['-m', 'demucs']]]) {
    try {
      const check = spawnSync(cmd, [...prefix, '--help'], { encoding: 'utf8', timeout: 4000 });
      if (check.status === 0) {
        cachedSeparationEngine = {
          id: 'demucs',
          cmd,
          argsPrefix: prefix,
          label: 'Demucs AI (htdemucs)',
          ai: true
        };
        return cachedSeparationEngine;
      }
    } catch (_) {}
  }

  cachedSeparationEngine = {
    id: 'ffmpeg_dsp',
    label: 'FFmpeg Multi-Band & Stereo Vocal Suppressor',
    ai: false
  };
  return cachedSeparationEngine;
}

function probeHasAudio(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_BIN, ['-hide_banner', '-i', filePath], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', () => resolve(false));
    proc.on('close', () => {
      resolve(/Stream #\d+:\d+[^:]*:\s*Audio:/m.test(stderr));
    });
  });
}

function runFfmpegExtract(inputPath, filterGraph, outPath, bitrate = '192k') {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-vn',
      '-af', filterGraph,
      '-c:a', 'libmp3lame',
      '-b:a', bitrate,
      outPath
    ];
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && isValidAudioFile(outPath)) {
        return resolve();
      }
      reject(new Error(`FFmpeg stem extraction failed (code ${code}): ${stderr.slice(-400)}`));
    });
  });
}

function runDemucsSeparation(videoPath, bgmOutPath, vocalsOutPath, engineSpec) {
  return new Promise((resolve, reject) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eza-demucs-'));
    const args = [
      ...(engineSpec.argsPrefix || []),
      '--two-stems=vocals',
      '-n', 'htdemucs',
      '--mp3',
      '-o', tempDir,
      videoPath
    ];
    const proc = spawn(engineSpec.cmd || 'demucs', args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', (err) => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      reject(err);
    });
    proc.on('close', (code) => {
      try {
        if (code !== 0) {
          throw new Error(`Demucs exited with code ${code}: ${stderr.slice(-300)}`);
        }
        const baseName = path.basename(videoPath, path.extname(videoPath));
        const modelDir = path.join(tempDir, 'htdemucs', baseName);
        const noVocals = path.join(modelDir, 'no_vocals.mp3');
        const vocals = path.join(modelDir, 'vocals.mp3');
        if (!isValidAudioFile(noVocals) || !isValidAudioFile(vocals)) {
          throw new Error('Demucs output stems not found');
        }
        fs.copyFileSync(noVocals, bgmOutPath);
        fs.copyFileSync(vocals, vocalsOutPath);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      }
    });
  });
}

function getCachedStemsForVideo(videoPath) {
  if (!videoPath || typeof videoPath !== 'string') return null;
  const normalized = path.normalize(videoPath.trim());
  if (!fs.existsSync(normalized)) return null;

  const cacheDir = getBgmCacheDir();
  const key = getBgmCacheKey(normalized);
  const bgmPath = path.join(cacheDir, `${key}_bgm.mp3`);
  const vocalsPath = path.join(cacheDir, `${key}_vocals.mp3`);
  const metaPath = path.join(cacheDir, `${key}_meta.json`);

  if (!isValidAudioFile(bgmPath) || !isValidAudioFile(vocalsPath)) {
    return null;
  }

  let engine = 'ffmpeg_dsp';
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta && meta.engine) engine = meta.engine;
    } catch (_) {}
  }

  return {
    key,
    engine,
    bgmPath,
    vocalsPath,
    bgmUrl: `/bgm_cache/${key}_bgm.mp3`,
    vocalsUrl: `/bgm_cache/${key}_vocals.mp3`
  };
}

/**
 * Isolate BGM (no_vocals) and Vocals stems for a video file, with caching.
 */
async function isolateVideoBgm(videoPath, options = {}) {
  const normalized = path.normalize(String(videoPath || '').trim());
  const cacheDir = getBgmCacheDir();
  const key = getBgmCacheKey(normalized);
  const bgmPath = path.join(cacheDir, `${key}_bgm.mp3`);
  const vocalsPath = path.join(cacheDir, `${key}_vocals.mp3`);
  const metaPath = path.join(cacheDir, `${key}_meta.json`);

  if (!options.force) {
    const existing = getCachedStemsForVideo(normalized);
    if (existing) {
      return { ...existing, cached: true };
    }
  }

  const hasAudio = await probeHasAudio(normalized);
  if (!hasAudio) {
    const err = new Error('វីដេអូនេះគ្មានសំឡេងសម្រាប់បំបែក BGM ទេ។');
    err.statusCode = 422;
    throw err;
  }

  const detected = detectSeparationEngine();
  let usedEngine = 'ffmpeg_dsp';

  if (detected.id === 'demucs' && options.engine !== 'ffmpeg_dsp') {
    try {
      await runDemucsSeparation(normalized, bgmPath, vocalsPath, detected);
      usedEngine = 'demucs';
    } catch (e) {
      console.warn('[audio/isolate-bgm] Demucs fallback to FFmpeg DSP:', e.message);
    }
  }

  if (usedEngine === 'ffmpeg_dsp') {
    await Promise.all([
      runFfmpegExtract(normalized, BGM_ISOLATION_FILTER, bgmPath, '192k'),
      runFfmpegExtract(normalized, VOCAL_ISOLATION_FILTER, vocalsPath, '160k')
    ]);
  }

  try {
    fs.writeFileSync(metaPath, JSON.stringify({
      engine: usedEngine,
      videoPath: normalized,
      createdAt: new Date().toISOString()
    }, null, 2), 'utf8');
  } catch (_) {}

  return {
    cached: false,
    key,
    engine: usedEngine,
    bgmPath,
    vocalsPath,
    bgmUrl: `/bgm_cache/${key}_bgm.mp3`,
    vocalsUrl: `/bgm_cache/${key}_vocals.mp3`
  };
}

function validateVideoPathInput(videoPath) {
  if (typeof videoPath !== 'string' || !videoPath.trim() || videoPath.length > 4096) {
    return { ok: false, status: 400, error: 'ផ្លូវវីដេអូមិនត្រឹមត្រូវ (videoPath required)' };
  }
  if (!path.isAbsolute(videoPath.trim())) {
    return { ok: false, status: 400, error: 'សូមជ្រើសរើសផ្លូវវីដេអូពេញលេញ (Absolute path required)' };
  }
  const normalized = path.normalize(videoPath.trim());
  let stat;
  try {
    stat = fs.statSync(normalized);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, status: 404, error: 'រកមិនឃើញឯកសារវីដេអូទេ' };
    }
    return { ok: false, status: 500, error: 'មិនអាចអានឯកសារវីដេអូបានទេ' };
  }
  if (!stat.isFile()) {
    return { ok: false, status: 400, error: 'ផ្លូវដែលបានជ្រើសមិនមែនជាឯកសារវីដេអូទេ' };
  }
  return { ok: true, normalized };
}

/**
 * GET /api/audio/capabilities
 */
router.get('/capabilities', (req, res) => {
  res.json({
    success: true,
    engine: detectSeparationEngine()
  });
});

/**
 * POST /api/audio/status
 * Check whether isolated BGM & vocal stems are already cached for a video.
 */
router.post('/status', (req, res) => {
  const { videoPath } = req.body || {};
  const check = validateVideoPathInput(videoPath);
  if (!check.ok) {
    return res.status(check.status).json({ success: false, error: check.error });
  }
  const existing = getCachedStemsForVideo(check.normalized);
  res.json({
    success: true,
    ready: Boolean(existing),
    ...(existing || {})
  });
});

/**
 * POST /api/audio/isolate-bgm
 * Run BGM & Vocal separation for a video file.
 */
router.post('/isolate-bgm', async (req, res) => {
  const { videoPath, force = false, engine } = req.body || {};
  const check = validateVideoPathInput(videoPath);
  if (!check.ok) {
    return res.status(check.status).json({ success: false, error: check.error });
  }

  try {
    const result = await isolateVideoBgm(check.normalized, {
      force: Boolean(force),
      engine
    });
    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * DELETE /api/audio/cache
 * Clear cached BGM and vocal stems.
 */
router.delete('/cache', (req, res) => {
  try {
    const cacheDir = getBgmCacheDir();
    const files = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];
    let deletedCount = 0;
    for (const f of files) {
      if (f.endsWith('.mp3') || f.endsWith('.json')) {
        fs.unlinkSync(path.join(cacheDir, f));
        deletedCount++;
      }
    }
    res.json({
      success: true,
      deletedCount
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.BGM_ISOLATION_FILTER = BGM_ISOLATION_FILTER;
router.VOCAL_ISOLATION_FILTER = VOCAL_ISOLATION_FILTER;
router.getBgmCacheDir = getBgmCacheDir;
router.getBgmCacheKey = getBgmCacheKey;
router.detectSeparationEngine = detectSeparationEngine;
router.getCachedStemsForVideo = getCachedStemsForVideo;
router.isolateVideoBgm = isolateVideoBgm;

module.exports = router;

