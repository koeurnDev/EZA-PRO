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
const { FFMPEG_BIN, renameFileSafe, lowerProcessPriority } = require('../utils/ffmpeg');

const MIN_VALID_AUDIO_BYTES = 100;
const DEFAULT_AUDIO_SEPARATOR_MODEL = process.env.EZA_AUDIO_SEPARATOR_MODEL || 'UVR-MDX-NET-Inst_HQ_3.onnx';
const DEFAULT_MDX_SEGMENT_SIZE = Math.max(64, Number.parseInt(process.env.EZA_MDX_SEGMENT_SIZE || '256', 10) || 256);
const DEFAULT_MDX_OVERLAP = Math.min(0.5, Math.max(0.05, Number.parseFloat(process.env.EZA_MDX_OVERLAP || '0.1') || 0.1));
const LONG_AUDIO_CHUNK_TRIGGER_SEC = 480;
const AUDIO_CHUNK_DURATION_SEC = 360;
const STEREO_WAV_BYTES_PER_SEC = 44100 * 2 * 2;
const RESUMABLE_JOB_TTL_MS = 24 * 60 * 60 * 1000;

const activeBgmProgressState = {
  running: false,
  key: '',
  engine: '',
  phase: 'idle',
  doneChunks: 0,
  totalChunks: 0,
  chunkPercent: 0,
  percent: 0,
  statusText: '',
  startedAt: 0,
  updatedAt: 0
};

function updateActiveBgmProgress(patch = {}) {
  Object.assign(activeBgmProgressState, patch, { updatedAt: Date.now() });
}

function getProjectRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function getExternalBaseRoots() {
  const candidates = [
    getProjectRoot(),
    process.cwd(),
    process.env.EZA_USER_DATA_DIR,
    process.env.PORTABLE_EXECUTABLE_DIR,
    process.env.PORTABLE_EXECUTABLE_DIR ? path.dirname(process.env.PORTABLE_EXECUTABLE_DIR) : '',
    process.resourcesPath ? path.dirname(process.resourcesPath) : '',
    process.resourcesPath ? path.dirname(path.dirname(process.resourcesPath)) : '',
    process.execPath ? path.dirname(process.execPath) : '',
    process.execPath ? path.dirname(path.dirname(process.execPath)) : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'EZA PRO') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'EZA PRO') : ''
  ].filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const dir of candidates) {
    try {
      const norm = path.normalize(dir);
      const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(norm);
    } catch (_) { }
  }
  return out;
}

function getVenvAudioDirs() {
  const seen = new Set();
  const dirs = [];
  const pushIfExists = (dir) => {
    if (!dir) return;
    try {
      const norm = path.normalize(dir);
      const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
      if (seen.has(key)) return;
      seen.add(key);
      if (fs.existsSync(norm)) dirs.push(norm);
    } catch (_) { }
  };
  pushIfExists(process.env.EZA_AUDIO_VENV_DIR);
  for (const base of getExternalBaseRoots()) {
    pushIfExists(path.join(base, '.venv_audio'));
  }
  return dirs;
}

function getPythonScriptsBinaryCandidates(binName) {
  if (process.platform !== 'win32') return [];
  const out = [];
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Python') : ''
  ].filter(Boolean);
  for (const pyRoot of roots) {
    try {
      if (!fs.existsSync(pyRoot)) continue;
      for (const entry of fs.readdirSync(pyRoot)) {
        const candidate = path.join(pyRoot, entry, 'Scripts', binName);
        if (fs.existsSync(candidate)) out.push(candidate);
      }
    } catch (_) { }
  }
  return out;
}

function dirHasModelWeights(dirPath) {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) return false;
    return fs.readdirSync(dirPath).some(f => /\.(onnx|ckpt|pth|safetensors)$/i.test(f));
  } catch (_) {
    return false;
  }
}

function getAiModelsDir() {
  const candidates = [
    process.env.AUDIO_SEPARATOR_MODEL_DIR
  ];
  for (const base of getExternalBaseRoots()) {
    candidates.push(path.join(base, '.ai_models', 'audio_separator'));
    candidates.push(path.join(base, 'ai_models', 'audio_separator'));
  }
  candidates.push(path.join(os.tmpdir(), 'eza-pro-ai-models', 'audio_separator'));

  const seen = new Set();
  const unique = [];
  for (const dir of candidates.filter(Boolean)) {
    const norm = path.normalize(dir);
    const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(norm);
  }

  for (const dir of unique) {
    if (dirHasModelWeights(dir)) return dir;
  }
  for (const dir of unique) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      return dir;
    } catch (_) {}
  }
  return os.tmpdir();
}

function isAiSeparationEngine(engineId) {
  return engineId === 'demucs' || engineId === 'audio-separator';
}

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
 * Mono-safe / dual-mono-safe vocal notch EQ + adaptive loudness normalization so mono or
 * narrow-stereo drama audio retains audible music/ambience instead of getting silenced.
 */
const MONO_SAFE_BGM_FILTER = [
  'aresample=44100',
  'aformat=sample_fmts=fltp:channel_layouts=stereo',
  'equalizer=f=380:t=q:w=1.0:g=-10',
  'equalizer=f=750:t=q:w=1.0:g=-13',
  'equalizer=f=1400:t=q:w=0.9:g=-15',
  'equalizer=f=2400:t=q:w=0.9:g=-13',
  'equalizer=f=3400:t=q:w=1.0:g=-10',
  'dynaudnorm=f=180:g=11:p=0.85',
  'alimiter=limit=0.95'
].join(',');

const AMBIENT_BLEND_VERSION = 3;

/**
 * Blend dialogue-safe environmental ambience & Foley SFX (<115Hz impacts/footsteps/room body,
 * >7800Hz crisp clinks/air/water, and wide-stereo L-R ambience) recovered from the vocals stem
 * back into the AI instrumental stem, gated/ducked cleanly by the mono speech core (300-3400Hz)
 * so spoken syllables, pitch F0, and sibilants never leak when original voice is muted.
 */
const AMBIENT_SFX_BLEND_FILTER = [
  '[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=4[l][h][w][det_in]',
  '[det_in]pan=mono|c0=0.5*c0+0.5*c1,highpass=f=300,highpass=f=300,highpass=f=300,lowpass=f=3400,lowpass=f=3400,volume=3.5[sc_voc]',
  '[l]lowpass=f=115,lowpass=f=115,volume=0.85[lo]',
  '[h]highpass=f=7800,highpass=f=7800,volume=0.65[hi]',
  '[w]pan=stereo|c0=0.5*c0-0.5*c1|c1=0.5*c1-0.5*c0,highpass=f=300,lowpass=f=3500,volume=0.75[side]',
  '[lo][hi][side]amix=inputs=3:normalize=0,alimiter=limit=0.85[amb_raw]',
  '[amb_raw][sc_voc]sidechaincompress=threshold=0.015:ratio=20:attack=4:release=450:makeup=1[amb]',
  '[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[bg]',
  '[bg][amb]amix=inputs=2:normalize=0:dropout_transition=0,alimiter=limit=0.95[out]'
].join(';');

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
  const candidates = [
    process.env.BGM_CACHE_DIR,
    process.env.AUDIO_CACHE_DIR ? path.join(process.env.AUDIO_CACHE_DIR, 'bgm_stems') : '',
    path.join(__dirname, '..', '..', '..', 'bgm_cache'),
    path.join(os.tmpdir(), 'eza-pro-bgm-cache')
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      return dir;
    } catch (_) {}
  }
  return os.tmpdir();
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
  const canon = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  let sig = canon;
  try {
    const stat = fs.statSync(normalized);
    sig = `${canon}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch (_) {}
  return crypto.createHash('md5').update(sig).digest('hex');
}

/**
 * Build child process environment with bundled FFmpeg and CUDA/cuDNN DLL paths on Windows.
 */
function buildChildProcessEnv(extraVars = {}, preferredVenvRoot = null) {
  const pathEntries = [];
  const pathSeen = new Set();
  const pushPath = (p) => {
    if (!p) return;
    try {
      const norm = path.normalize(p);
      const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
      if (pathSeen.has(key) || !fs.existsSync(norm)) return;
      pathSeen.add(key);
      pathEntries.push(norm);
    } catch (_) { }
  };

  if (FFMPEG_BIN && FFMPEG_BIN !== 'ffmpeg') {
    pushPath(path.dirname(FFMPEG_BIN));
  }

  const venvRoots = [
    preferredVenvRoot,
    ...getVenvAudioDirs()
  ].filter(Boolean);
  for (const venvRoot of venvRoots) {
    pushPath(path.join(venvRoot, process.platform === 'win32' ? 'Scripts' : 'bin'));
    if (process.platform === 'win32') {
      pushPath(path.join(venvRoot, 'Lib', 'site-packages', 'torch', 'lib'));
      const nvidiaBase = path.join(venvRoot, 'Lib', 'site-packages', 'nvidia');
      if (fs.existsSync(nvidiaBase)) {
        try {
          for (const pkg of fs.readdirSync(nvidiaBase)) {
            pushPath(path.join(nvidiaBase, pkg, 'bin'));
          }
        } catch (_) {}
      }
    }
  }

  const existingPath = process.env.PATH || '';
  const mergedPath = pathEntries.length > 0
    ? `${pathEntries.join(path.delimiter)}${existingPath ? path.delimiter + existingPath : ''}`
    : existingPath;

  const torchCandidates = [process.env.TORCH_HOME];
  for (const base of getExternalBaseRoots()) {
    torchCandidates.push(path.join(base, '.ai_models', 'torch'));
    torchCandidates.push(path.join(base, 'ai_models', 'torch'));
  }
  torchCandidates.push(path.join(os.tmpdir(), 'eza-pro-torch-cache'));

  let torchHome = os.tmpdir();
  for (const dir of torchCandidates.filter(Boolean)) {
    try {
      const hubDir = path.join(dir, 'hub');
      if (fs.existsSync(hubDir) && fs.readdirSync(hubDir).length > 0) {
        torchHome = dir;
        break;
      }
    } catch (_) {}
  }
  if (torchHome === os.tmpdir()) {
    for (const dir of torchCandidates.filter(Boolean)) {
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        torchHome = dir;
        break;
      } catch (_) {}
    }
  }

  const isLowRamHost = Number(os.totalmem() || 0) > 0 && Number(os.totalmem()) <= 8.5 * 1024 * 1024 * 1024;
  return {
    ...process.env,
    PATH: mergedPath,
    AUDIO_SEPARATOR_MODEL_DIR: getAiModelsDir(),
    TORCH_HOME: torchHome,
    PYTHONIOENCODING: 'utf-8',
    ...(isLowRamHost && !process.env.OMP_NUM_THREADS ? { OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2' } : {}),
    ...extraVars
  };
}

/**
 * Detect best available stem separation engine (UVR audio-separator -> Demucs -> FFmpeg DSP).
 */
function detectSeparationEngine(forceRefresh = false) {
  if (cachedSeparationEngine && !forceRefresh) {
    if (cachedSeparationEngine.ai || (Date.now() - (cachedSeparationEngine.checkedAt || 0) < 30000)) {
      return cachedSeparationEngine;
    }
  }

  const sepBinName = process.platform === 'win32' ? 'audio-separator.exe' : 'audio-separator';
  const pyBinName = process.platform === 'win32' ? 'python.exe' : 'python';
  const subDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const venvDirs = getVenvAudioDirs();
  const sepCandidates = [];
  if (process.env.AUDIO_SEPARATOR_BIN) {
    sepCandidates.push([process.env.AUDIO_SEPARATOR_BIN, [], null]);
  }
  for (const venvDir of venvDirs) {
    const candidate = path.join(venvDir, subDir, sepBinName);
    if (fs.existsSync(candidate)) {
      sepCandidates.push([candidate, [], venvDir]);
    }
  }
  for (const pyScriptSep of getPythonScriptsBinaryCandidates(sepBinName)) {
    sepCandidates.push([pyScriptSep, [], path.dirname(path.dirname(pyScriptSep))]);
  }
  sepCandidates.push(['audio-separator', [], null]);

  for (const [cmd, prefix, venvRoot] of sepCandidates) {
    try {
      const childEnv = buildChildProcessEnv({}, venvRoot);
      const uvr = spawnSync(cmd, [...prefix, '--version'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 12000,
        env: childEnv
      });
      if (uvr.status === 0) {
        cachedSeparationEngine = {
          id: 'audio-separator',
          cmd,
          argsPrefix: prefix,
          venvRoot,
          model: DEFAULT_AUDIO_SEPARATOR_MODEL,
          label: `UVR MDX-Net AI (${DEFAULT_AUDIO_SEPARATOR_MODEL.replace(/\.(onnx|ckpt|pth)$/i, '')})`,
          ai: true
        };
        return cachedSeparationEngine;
      }
    } catch (_) {}
  }

  const demucsCandidates = [];
  for (const venvDir of venvDirs) {
    const venvPy = path.join(venvDir, subDir, pyBinName);
    if (fs.existsSync(venvPy)) {
      demucsCandidates.push([venvPy, ['-m', 'demucs'], venvDir]);
    }
  }
  demucsCandidates.push(['demucs', [], null], ['py', ['-m', 'demucs'], null], ['python', ['-m', 'demucs'], null]);

  for (const [cmd, prefix, venvRoot] of demucsCandidates) {
    try {
      const childEnv = buildChildProcessEnv({}, venvRoot);
      const check = spawnSync(cmd, [...prefix, '--help'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
        env: childEnv
      });
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
    ai: false,
    checkedAt: Date.now()
  };
  return cachedSeparationEngine;
}

function buildBgmFilterForChannels(channels = 2, options = {}) {
  if (channels <= 1 || (options && options.narrowStereo)) {
    return MONO_SAFE_BGM_FILTER;
  }
  return BGM_ISOLATION_FILTER;
}

/**
 * Detect dual-mono or narrow-stereo tracks (common in Chinese vertical drama MP4s)
 * where Side (L-R) energy is minimal so stereotools center-cancel would silence BGM.
 */
function measureMeanVolumeDb(filePath, afFilter = 'volumedetect', sampleSec = 15) {
  return new Promise((resolve) => {
    let settled = false;
    const args = ['-nostdin', '-hide_banner', '-t', String(sampleSec), '-i', filePath, '-vn', '-af', afFilter, '-f', 'null', '-'];
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { try { proc.kill(); } catch (_) {} }
      finish(null);
    }, 8000);
    proc.stderr.on('data', d => {
      if (stderr.length < 32768) stderr += d.toString();
    });
    proc.on('error', () => finish(null));
    proc.on('close', () => {
      const m = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
      finish(m ? parseFloat(m[1]) : null);
    });
  });
}

function detectNarrowStereoAudio(filePath) {
  if (!filePath || typeof filePath !== 'string') return Promise.resolve(false);
  return Promise.all([
    measureMeanVolumeDb(filePath, 'volumedetect', 15),
    measureMeanVolumeDb(filePath, 'pan=mono|c0=0.5*c0-0.5*c1,volumedetect', 15)
  ]).then(([totalMean, sideMean]) => {
    if (Number.isFinite(totalMean) && Number.isFinite(sideMean)) {
      if ((totalMean - sideMean) >= 14 || sideMean <= -38) {
        return true;
      }
    }
    return false;
  }).catch(() => false);
}

function buildVocalFilterForChannels(channels = 2) {
  if (channels === 1) {
    return VOCAL_ISOLATION_FILTER.replace(',stereotools=mlev=1.2:slev=0.15', '');
  }
  return VOCAL_ISOLATION_FILTER;
}

function probeAudioInfo(filePath) {
  return new Promise((resolve) => {
    let settled = false;
    const proc = spawn(FFMPEG_BIN, ['-nostdin', '-hide_banner', '-i', filePath], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { try { proc.kill(); } catch (_) {} }
      finish({ hasAudio: false, channels: 2 });
    }, 8000);
    proc.stderr.on('data', d => {
      if (stderr.length < 16384) stderr += d.toString();
    });
    proc.on('error', () => finish({ hasAudio: false, channels: 2 }));
    proc.on('close', () => {
      const audioLineMatch = stderr.match(/Stream #\d+:\d+[^:]*:\s*Audio:([^\r\n]*)/m);
      if (!audioLineMatch) return finish({ hasAudio: false, channels: 0 });
      const channels = /\bmono\b|\b1 channels?\b/i.test(audioLineMatch[1]) ? 1 : 2;
      finish({ hasAudio: true, channels });
    });
  });
}

function probeHasAudio(filePath) {
  return probeAudioInfo(filePath).then(info => Boolean(info && info.hasAudio));
}

function createBgmWorkTempDir(prefix = '_tmp_sep_') {
  const baseDir = getBgmCacheDir();
  return fs.mkdtempSync(path.join(baseDir, prefix));
}

function cleanupStaleBgmTempDirs() {
  try {
    const baseDir = getBgmCacheDir();
    const now = Date.now();
    for (const entry of fs.readdirSync(baseDir)) {
      if (!entry.startsWith('_tmp_')) continue;
      const fullPath = path.join(baseDir, entry);
      try {
        const st = fs.statSync(fullPath);
        if (st.isDirectory() && (now - st.mtimeMs) > RESUMABLE_JOB_TTL_MS) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      } catch (_) {}
    }
  } catch (_) {}
}

function createBgmCancelledError() {
  return Object.assign(new Error('BGM isolation cancelled by user'), { cancelled: true });
}

function attachCancelWatcher(proc, isCancelled, onCancel) {
  if (typeof isCancelled !== 'function') return () => {};
  const id = setInterval(() => {
    try {
      if (isCancelled()) {
        clearInterval(id);
        killProcessTree(proc);
        onCancel();
      }
    } catch (_) {}
  }, 400);
  if (typeof id.unref === 'function') id.unref();
  return () => clearInterval(id);
}

function runFfmpegCommand(args, label = 'FFmpeg', timeoutMs = 10 * 60 * 1000, hooks = {}) {
  return new Promise((resolve, reject) => {
    if (hooks.isCancelled && hooks.isCancelled()) {
      return reject(createBgmCancelledError());
    }
    let settled = false;
    const proc = spawn(FFMPEG_BIN, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    lowerProcessPriority(proc);
    if (typeof hooks.onProcess === 'function') {
      try { hooks.onProcess(proc); } catch (_) {}
    }
    let stderr = '';
    let stopCancelWatch = () => {};
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopCancelWatch();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      killProcessTree(proc);
      finish(new Error(`${label} timed out`));
    }, timeoutMs);
    stopCancelWatch = attachCancelWatcher(proc, hooks.isCancelled, () => finish(createBgmCancelledError()));
    proc.stderr.on('data', d => {
      if (stderr.length < 16384) stderr += d.toString();
      else stderr = (stderr + d.toString()).slice(-16384);
    });
    proc.on('error', (err) => finish(err));
    proc.on('close', (code) => {
      if (hooks.isCancelled && hooks.isCancelled()) return finish(createBgmCancelledError());
      if (code === 0) return finish();
      finish(new Error(`${label} failed (code ${code}): ${stderr.slice(-400)}`));
    });
  });
}

async function runFfmpegExtract(inputPath, filterGraph, outPath, bitrate = '192k', hooks = {}) {
  await runFfmpegCommand([
    '-y',
    '-i', inputPath,
    '-vn',
    '-af', filterGraph,
    '-c:a', 'libmp3lame',
    '-b:a', bitrate,
    outPath
  ], 'FFmpeg stem extraction', 10 * 60 * 1000, hooks);
  if (!isValidAudioFile(outPath)) {
    throw new Error('FFmpeg stem extraction produced an empty output file');
  }
}

function estimateWavDurationSec(wavPath) {
  try {
    const size = fs.statSync(wavPath).size;
    return Math.max(0, (size - 44) / STEREO_WAV_BYTES_PER_SEC);
  } catch (_) {
    return 0;
  }
}

function findStemFilesInDir(dirPath, baseName = null) {
  if (!fs.existsSync(dirPath)) return { bgmFile: null, vocalsFile: null };
  const files = fs.readdirSync(dirPath).filter(f => /\.(wav|flac|mp3)$/i.test(f));
  let bgmFile;
  let vocalsFile;
  if (baseName) {
    const bgmPrefix = `${baseName}_(Instrumental)`;
    const vocPrefix = `${baseName}_(Vocals)`;
    bgmFile = files.find(f => f.startsWith(bgmPrefix));
    vocalsFile = files.find(f => f.startsWith(vocPrefix));
  } else {
    bgmFile = files.find(f => /^bgm\.(wav|flac|mp3)$/i.test(f)) ||
      files.find(f => /\(Instrumental\)|no_vocals/i.test(f));
    vocalsFile = files.find(f => /^vocals\.(wav|flac|mp3)$/i.test(f)) ||
      files.find(f => /\(Vocals\)/i.test(f) && !/no_vocals/i.test(f));
  }
  return {
    bgmFile: bgmFile ? path.join(dirPath, bgmFile) : null,
    vocalsFile: vocalsFile ? path.join(dirPath, vocalsFile) : null
  };
}

function killProcessTree(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    }
  } catch (_) {}
  try { proc.kill('SIGKILL'); } catch (_) {}
}

function isRealAudioSeparatorEngine(engineSpec) {
  return Boolean(
    engineSpec &&
    engineSpec.cmd !== process.execPath &&
    (!Array.isArray(engineSpec.argsPrefix) || engineSpec.argsPrefix.length === 0)
  );
}

function runAudioSeparatorChunk(inputWavPath, chunkOutDir, engineSpec, env, hooks = {}) {
  return new Promise((resolve, reject) => {
    if (hooks.isCancelled && hooks.isCancelled()) {
      return reject(createBgmCancelledError());
    }
    const customNames = JSON.stringify({ Instrumental: 'bgm', Vocals: 'vocals' });
    const useFastNativeFlags = isRealAudioSeparatorEngine(engineSpec);
    const isLowRamHost = Number(os.totalmem() || 0) > 0 && Number(os.totalmem()) <= 8.5 * 1024 * 1024 * 1024;
    const mdxSegmentSize = process.env.EZA_MDX_SEGMENT_SIZE
      ? DEFAULT_MDX_SEGMENT_SIZE
      : (isLowRamHost ? Math.min(128, DEFAULT_MDX_SEGMENT_SIZE) : DEFAULT_MDX_SEGMENT_SIZE);
    const args = [
      ...(engineSpec.argsPrefix || []),
      '-m', engineSpec.model || DEFAULT_AUDIO_SEPARATOR_MODEL,
      '--model_file_dir', getAiModelsDir(),
      '--output_dir', chunkOutDir,
      '--output_format', 'WAV',
      ...(useFastNativeFlags ? ['--use_soundfile', '--mdx_overlap', String(DEFAULT_MDX_OVERLAP)] : []),
      '--mdx_segment_size', String(mdxSegmentSize),
      '--custom_output_names', customNames,
      inputWavPath
    ];
    const proc = spawn(engineSpec.cmd || 'audio-separator', args, { windowsHide: true, env });
    lowerProcessPriority(proc);
    if (typeof hooks.onProcess === 'function') {
      try { hooks.onProcess(proc); } catch (_) {}
    }
    let combinedErr = '';
    let settled = false;
    let stopCancelWatch = () => {};
    let lastTqdmPct = 0;
    let subBar = 0;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopCancelWatch();
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => {
      killProcessTree(proc);
      finish(new Error('audio-separator chunk timed out after 10 minutes'));
    }, 10 * 60 * 1000);
    stopCancelWatch = attachCancelWatcher(proc, hooks.isCancelled, () => finish(createBgmCancelledError()));
    const appendTail = (d) => {
      const str = d.toString();
      combinedErr += str;
      if (combinedErr.length > 16384) combinedErr = combinedErr.slice(-8192);
      if (typeof hooks.onChunkPercent === 'function') {
        const matches = str.match(/(\d{1,3})%\|/g);
        if (matches && matches.length > 0) {
          const pct = Math.min(100, Math.max(0, parseInt(matches[matches.length - 1], 10) || 0));
          if (pct + 30 < lastTqdmPct) subBar = 1;
          lastTqdmPct = pct;
          const mapped = subBar === 0 ? Math.round(pct * 0.8) : (80 + Math.round(pct * 0.18));
          hooks.onChunkPercent(Math.min(99, mapped));
        }
      }
    };
    if (proc.stdout) proc.stdout.on('data', appendTail);
    if (proc.stderr) proc.stderr.on('data', appendTail);
    proc.on('error', (err) => finish(err));
    proc.on('close', (code) => {
      if (hooks.isCancelled && hooks.isCancelled()) return finish(createBgmCancelledError());
      if (code !== 0) {
        return finish(new Error(`audio-separator exited with code ${code}: ${combinedErr.slice(-500)}`));
      }
      const stems = findStemFilesInDir(chunkOutDir);
      if (!stems.bgmFile || !stems.vocalsFile || !isValidAudioFile(stems.bgmFile) || !isValidAudioFile(stems.vocalsFile)) {
        return finish(new Error(`audio-separator stems not found in ${chunkOutDir}`));
      }
      finish(null, stems);
    });
  });
}

function runAudioSeparatorBatch(pendingChunks, batchOutDir, engineSpec, env, hooks = {}) {
  return new Promise((resolve, reject) => {
    if (hooks.isCancelled && hooks.isCancelled()) {
      return reject(createBgmCancelledError());
    }
    const inputPaths = pendingChunks.map(c => c.path);
    const args = [
      ...(engineSpec.argsPrefix || []),
      '-m', engineSpec.model || DEFAULT_AUDIO_SEPARATOR_MODEL,
      '--model_file_dir', getAiModelsDir(),
      '--output_dir', batchOutDir,
      '--output_format', 'WAV',
      '--use_soundfile',
      '--mdx_segment_size', String(DEFAULT_MDX_SEGMENT_SIZE),
      '--mdx_overlap', String(DEFAULT_MDX_OVERLAP),
      ...inputPaths
    ];
    const proc = spawn(engineSpec.cmd || 'audio-separator', args, { windowsHide: true, env });
    lowerProcessPriority(proc);
    if (typeof hooks.onProcess === 'function') {
      try { hooks.onProcess(proc); } catch (_) {}
    }
    let combinedErr = '';
    let settled = false;
    let stopCancelWatch = () => {};
    let activePendingIdx = 0;
    let lastTqdmPct = 0;
    let subBar = 0;
    const baseToPendingIdx = new Map(pendingChunks.map((c, idx) => [c.baseName.toLowerCase(), idx]));
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopCancelWatch();
      if (err) reject(err);
      else resolve();
    };
    const timeoutMs = Math.max(15 * 60 * 1000, pendingChunks.length * 8 * 60 * 1000);
    const timer = setTimeout(() => {
      killProcessTree(proc);
      finish(new Error('audio-separator batch timed out'));
    }, timeoutMs);
    stopCancelWatch = attachCancelWatcher(proc, hooks.isCancelled, () => finish(createBgmCancelledError()));
    const handleOutput = (d) => {
      const str = d.toString();
      combinedErr += str;
      if (combinedErr.length > 16384) combinedErr = combinedErr.slice(-8192);
      const procMatch = str.match(/Processing file:\s*([^\r\n]+)/i);
      if (procMatch) {
        const foundBase = path.basename(procMatch[1].trim(), path.extname(procMatch[1].trim())).toLowerCase();
        if (baseToPendingIdx.has(foundBase)) {
          activePendingIdx = baseToPendingIdx.get(foundBase);
          lastTqdmPct = 0;
          subBar = 0;
          if (typeof hooks.onBatchProgress === 'function') {
            hooks.onBatchProgress(activePendingIdx, 0);
          }
        }
      }
      if (typeof hooks.onBatchProgress === 'function') {
        const matches = str.match(/(\d{1,3})%\|/g);
        if (matches && matches.length > 0) {
          const pct = Math.min(100, Math.max(0, parseInt(matches[matches.length - 1], 10) || 0));
          if (pct + 30 < lastTqdmPct) subBar = 1;
          lastTqdmPct = pct;
          const mapped = subBar === 0 ? Math.round(pct * 0.8) : (80 + Math.round(pct * 0.18));
          hooks.onBatchProgress(activePendingIdx, Math.min(99, mapped));
        }
      }
    };
    if (proc.stdout) proc.stdout.on('data', handleOutput);
    if (proc.stderr) proc.stderr.on('data', handleOutput);
    proc.on('error', (err) => finish(err));
    proc.on('close', (code) => {
      if (hooks.isCancelled && hooks.isCancelled()) return finish(createBgmCancelledError());
      if (code !== 0) {
        return finish(new Error(`audio-separator exited with code ${code}: ${combinedErr.slice(-500)}`));
      }
      finish();
    });
  });
}

async function concatWavListToMp3(wavPaths, outMp3Path, bitrate, listPath, hooks = {}) {
  if (wavPaths.length === 1) {
    await runFfmpegCommand([
      '-y', '-i', wavPaths[0], '-c:a', 'libmp3lame', '-b:a', bitrate, outMp3Path
    ], 'FFmpeg encode stem', 10 * 60 * 1000, hooks);
  } else {
    const listBody = wavPaths.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listBody, 'utf8');
    await runFfmpegCommand([
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'libmp3lame', '-b:a', bitrate, outMp3Path
    ], 'FFmpeg concat stem', 15 * 60 * 1000, hooks);
  }
  if (!isValidAudioFile(outMp3Path)) {
    throw new Error(`Separated stem MP3 is invalid: ${outMp3Path}`);
  }
}

async function blendAmbientSfxIntoBgm(rawBgmPath, vocalsPath, finalBgmOutPath, hooks = {}) {
  await runFfmpegCommand([
    '-y',
    '-i', rawBgmPath,
    '-i', vocalsPath,
    '-filter_complex', AMBIENT_SFX_BLEND_FILTER,
    '-map', '[out]',
    '-c:a', 'libmp3lame',
    '-b:a', '192k',
    finalBgmOutPath
  ], 'FFmpeg blend ambient SFX', 10 * 60 * 1000, hooks);
  if (!isValidAudioFile(finalBgmOutPath)) {
    throw new Error(`Ambient-blended BGM MP3 is invalid: ${finalBgmOutPath}`);
  }
}

/**
 * Run UVR audio-separator with FFmpeg WAV normalization, single-process multi-chunk batching,
 * resumable chunk checkpoints, and live chunk progress reporting.
 */
async function runAudioSeparatorSeparation(videoPath, bgmOutPath, vocalsOutPath, engineSpec, options = {}) {
  const resumableKey = options.resumableKey ? String(options.resumableKey).trim() : '';
  const tempDir = resumableKey
    ? path.join(getBgmCacheDir(), `_tmp_uvr_job_${resumableKey}`)
    : createBgmWorkTempDir('_tmp_uvr_');
  if (resumableKey && options.cleanResume && fs.existsSync(tempDir)) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
  fs.mkdirSync(tempDir, { recursive: true });
  const pyTmpDir = path.join(tempDir, 'pytmp');
  fs.mkdirSync(pyTmpDir, { recursive: true });
  const env = buildChildProcessEnv({ TMP: pyTmpDir, TEMP: pyTmpDir }, engineSpec && engineSpec.venvRoot);
  const chunkTriggerSec = Number(options.chunkTriggerSec) > 0 ? Number(options.chunkTriggerSec) : LONG_AUDIO_CHUNK_TRIGGER_SEC;
  const chunkDurationSec = Number(options.chunkDurationSec) > 0 ? Number(options.chunkDurationSec) : AUDIO_CHUNK_DURATION_SEC;

  const reportProgress = (phase, doneChunks, totalChunks, chunkPercent, statusText) => {
    const safeTotal = Math.max(1, totalChunks || 1);
    const frac = Math.min(1, Math.max(0, (doneChunks + (chunkPercent || 0) / 100) / safeTotal));
    const overallPct = phase === 'decode'
      ? 3
      : (phase === 'concat' ? 95 : Math.min(94, 6 + Math.round(frac * 86)));
    const payload = { phase, doneChunks, totalChunks: safeTotal, chunkPercent: Math.round(chunkPercent || 0), percent: overallPct, statusText };
    if (typeof options.onProgress === 'function') {
      try { options.onProgress(payload); } catch (_) {}
    }
  };
  const checkCancelled = () => {
    if (typeof options.isCancelled === 'function' && options.isCancelled()) {
      throw createBgmCancelledError();
    }
  };
  const ffmpegHooks = { isCancelled: options.isCancelled, onProcess: options.onProcess };

  let succeeded = false;
  try {
    checkCancelled();
    const sourceWav = path.join(tempDir, 'source.wav');
    const sourceMetaFile = path.join(tempDir, 'source.meta.json');
    let srcSize = 0;
    try { srcSize = fs.statSync(videoPath).size; } catch (_) {}
    let canReuseChunks = false;
    if (resumableKey && isValidAudioFile(sourceWav) && fs.existsSync(sourceMetaFile)) {
      try {
        const prevMeta = JSON.parse(fs.readFileSync(sourceMetaFile, 'utf8'));
        if (prevMeta && prevMeta.size === srcSize && prevMeta.chunkDurationSec === chunkDurationSec && prevMeta.model === engineSpec.model) {
          canReuseChunks = true;
        }
      } catch (_) {}
    }

    if (!canReuseChunks) {
      reportProgress('decode', 0, 1, 0, '🎵 កំពុងស្រង់សំឡេងដើមពីវីដេអូសម្រាប់ UVR AI...');
      await runFfmpegCommand([
        '-y', '-i', videoPath, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', sourceWav
      ], 'FFmpeg audio decode', 10 * 60 * 1000, ffmpegHooks);
    }
    checkCancelled();

    const durSec = estimateWavDurationSec(sourceWav);
    const chunkFiles = [];
    const splitDir = path.join(tempDir, 'chunks');
    if (durSec > chunkTriggerSec) {
      fs.mkdirSync(splitDir, { recursive: true });
      const existingChunks = canReuseChunks
        ? fs.readdirSync(splitDir).filter(f => f.endsWith('.wav')).sort()
        : [];
      if (existingChunks.length === 0) {
        reportProgress('decode', 0, 1, 50, '🎵 កំពុងបែងចែកសំឡេងជាវគ្គតូចៗ (4GB VRAM safe)...');
        await runFfmpegCommand([
          '-y', '-i', sourceWav, '-f', 'segment', '-segment_time', String(chunkDurationSec), '-c', 'copy',
          path.join(splitDir, 'chunk_%03d.wav')
        ], 'FFmpeg split audio chunks', 10 * 60 * 1000, ffmpegHooks);
      }
      for (const f of fs.readdirSync(splitDir).sort()) {
        if (f.endsWith('.wav')) chunkFiles.push(path.join(splitDir, f));
      }
      console.log(`[audio/isolate-bgm] UVR chunked separation: ${chunkFiles.length} chunks for ${Math.round(durSec)}s audio`);
    } else {
      chunkFiles.push(sourceWav);
    }
    if (resumableKey) {
      try { fs.writeFileSync(sourceMetaFile, JSON.stringify({ size: srcSize, chunkDurationSec, model: engineSpec.model }), 'utf8'); } catch (_) {}
    }
    checkCancelled();

    const totalChunks = chunkFiles.length;
    const bgmWavs = new Array(totalChunks).fill(null);
    const vocalsWavs = new Array(totalChunks).fill(null);
    const batchOutDir = path.join(tempDir, 'batch_out');
    fs.mkdirSync(batchOutDir, { recursive: true });

    const useBatch = isRealAudioSeparatorEngine(engineSpec) && totalChunks > 1;
    if (useBatch) {
      const pendingChunks = [];
      let preCompletedCount = 0;
      for (let i = 0; i < totalChunks; i++) {
        const baseName = path.basename(chunkFiles[i], path.extname(chunkFiles[i]));
        const batchStems = findStemFilesInDir(batchOutDir, baseName);
        const perChunkStems = (!batchStems.bgmFile || !batchStems.vocalsFile) && resumableKey
          ? findStemFilesInDir(path.join(tempDir, `out_${i}`))
          : { bgmFile: null, vocalsFile: null };
        const existingStems = (batchStems.bgmFile && batchStems.vocalsFile) ? batchStems : perChunkStems;
        if (existingStems.bgmFile && existingStems.vocalsFile && isValidAudioFile(existingStems.bgmFile) && isValidAudioFile(existingStems.vocalsFile)) {
          bgmWavs[i] = existingStems.bgmFile;
          vocalsWavs[i] = existingStems.vocalsFile;
          preCompletedCount++;
        } else {
          pendingChunks.push({ index: i, path: chunkFiles[i], baseName });
        }
      }

      if (pendingChunks.length > 0) {
        reportProgress(
          'separate',
          preCompletedCount,
          totalChunks,
          0,
          `🎵 កំពុងបំបែកភ្លេង BGM+SFX ដោយ UVR AI (GPU) [វគ្គ ${Math.min(totalChunks, preCompletedCount + 1)}/${totalChunks}]...`
        );
        try {
          await runAudioSeparatorBatch(pendingChunks, batchOutDir, engineSpec, env, {
            isCancelled: options.isCancelled,
            onProcess: options.onProcess,
            onBatchProgress: (pendingIdx, chunkPct) => {
              const doneSoFar = Math.min(totalChunks - 1, preCompletedCount + pendingIdx);
              const curNum = Math.min(totalChunks, doneSoFar + 1);
              reportProgress(
                'separate',
                doneSoFar,
                totalChunks,
                chunkPct,
                `🎵 កំពុងបំបែកភ្លេង BGM+SFX ដោយ UVR AI (GPU) [វគ្គ ${curNum}/${totalChunks} · ${chunkPct}%]...`
              );
            }
          });
        } catch (batchErr) {
          if (batchErr && batchErr.cancelled) throw batchErr;
          console.warn('[audio/isolate-bgm] UVR batch mode fallback to per-chunk:', batchErr.message);
        }
      }

      // Collect batch outputs & fill any remaining chunks individually
      for (let i = 0; i < totalChunks; i++) {
        if (bgmWavs[i] && vocalsWavs[i]) continue;
        const baseName = path.basename(chunkFiles[i], path.extname(chunkFiles[i]));
        const stems = findStemFilesInDir(batchOutDir, baseName);
        if (stems.bgmFile && stems.vocalsFile && isValidAudioFile(stems.bgmFile) && isValidAudioFile(stems.vocalsFile)) {
          bgmWavs[i] = stems.bgmFile;
          vocalsWavs[i] = stems.vocalsFile;
        } else {
          checkCancelled();
          reportProgress(
            'separate',
            i,
            totalChunks,
            0,
            `🎵 កំពុងបំបែកភ្លេង BGM+SFX ដោយ UVR AI (GPU) [វគ្គ ${i + 1}/${totalChunks}]...`
          );
          const chunkOutDir = path.join(tempDir, `out_${i}`);
          fs.mkdirSync(chunkOutDir, { recursive: true });
          const singleStems = await runAudioSeparatorChunk(chunkFiles[i], chunkOutDir, engineSpec, env, {
            isCancelled: options.isCancelled,
            onProcess: options.onProcess,
            onChunkPercent: (chunkPct) => {
              reportProgress(
                'separate',
                i,
                totalChunks,
                chunkPct,
                `🎵 កំពុងបំបែកភ្លេង BGM+SFX ដោយ UVR AI (GPU) [វគ្គ ${i + 1}/${totalChunks} · ${chunkPct}%]...`
              );
            }
          });
          bgmWavs[i] = singleStems.bgmFile;
          vocalsWavs[i] = singleStems.vocalsFile;
        }
      }
    } else {
      for (let i = 0; i < totalChunks; i++) {
        checkCancelled();
        const chunkOutDir = path.join(tempDir, `out_${i}`);
        const existingSingle = resumableKey ? findStemFilesInDir(chunkOutDir) : { bgmFile: null, vocalsFile: null };
        if (existingSingle.bgmFile && existingSingle.vocalsFile && isValidAudioFile(existingSingle.bgmFile) && isValidAudioFile(existingSingle.vocalsFile)) {
          bgmWavs[i] = existingSingle.bgmFile;
          vocalsWavs[i] = existingSingle.vocalsFile;
          reportProgress('separate', i + 1, totalChunks, 0, `🎵 កំពុងបំបែកភ្លេង BGM+SFX ដោយ UVR AI (GPU) [វគ្គ ${i + 1}/${totalChunks} · 100%]...`);
          continue;
        }
        fs.mkdirSync(chunkOutDir, { recursive: true });
        reportProgress('separate', i, totalChunks, 0, `🎵 កំពុងបំបែកភ្លេង BGM+SFX ដោយ UVR AI (GPU) [វគ្គ ${i + 1}/${totalChunks}]...`);
        const stems = await runAudioSeparatorChunk(chunkFiles[i], chunkOutDir, engineSpec, env, {
          isCancelled: options.isCancelled,
          onProcess: options.onProcess,
          onChunkPercent: (chunkPct) => {
            reportProgress(
              'separate',
              i,
              totalChunks,
              chunkPct,
              `🎵 កំពុងបំបែកភ្លេង BGM+SFX ដោយ UVR AI (GPU) [វគ្គ ${i + 1}/${totalChunks} · ${chunkPct}%]...`
            );
          }
        });
        bgmWavs[i] = stems.bgmFile;
        vocalsWavs[i] = stems.vocalsFile;
      }
    }

    checkCancelled();
    reportProgress('concat', totalChunks, totalChunks, 0, '🎵 កំពុងផ្គុំភ្លេង BGM+SFX ទៅជា MP3...');
    await Promise.all([
      concatWavListToMp3(bgmWavs, bgmOutPath, '192k', path.join(tempDir, 'bgm_concat.txt'), ffmpegHooks),
      concatWavListToMp3(vocalsWavs, vocalsOutPath, '160k', path.join(tempDir, 'vocals_concat.txt'), ffmpegHooks)
    ]);
    succeeded = true;
  } finally {
    if (!resumableKey || succeeded) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

function runDemucsSeparation(videoPath, bgmOutPath, vocalsOutPath, engineSpec, hooks = {}) {
  return new Promise((resolve, reject) => {
    if (hooks.isCancelled && hooks.isCancelled()) {
      return reject(createBgmCancelledError());
    }
    const tempDir = createBgmWorkTempDir('_tmp_demucs_');
    const args = [
      ...(engineSpec.argsPrefix || []),
      '--two-stems=vocals',
      '-n', 'htdemucs',
      '--mp3',
      '-o', tempDir,
      videoPath
    ];
    const proc = spawn(engineSpec.cmd || 'demucs', args, { windowsHide: true, env: buildChildProcessEnv({ TMP: tempDir, TEMP: tempDir }) });
    lowerProcessPriority(proc);
    if (typeof hooks.onProcess === 'function') {
      try { hooks.onProcess(proc); } catch (_) {}
    }
    let stderr = '';
    let settled = false;
    let stopCancelWatch = () => {};
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopCancelWatch();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      killProcessTree(proc);
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      finish(new Error('Demucs timed out after 15 minutes'));
    }, 15 * 60 * 1000);
    stopCancelWatch = attachCancelWatcher(proc, hooks.isCancelled, () => finish(createBgmCancelledError()));
    if (proc.stdout) proc.stdout.resume();
    if (proc.stderr) {
      proc.stderr.on('data', d => {
        stderr += d.toString();
        if (stderr.length > 16384) stderr = stderr.slice(-8192);
      });
    }
    proc.on('error', (err) => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      finish(err);
    });
    proc.on('close', (code) => {
      try {
        if (settled) return;
        if (hooks.isCancelled && hooks.isCancelled()) {
          throw createBgmCancelledError();
        }
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
        finish();
      } catch (e) {
        finish(e);
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
  const rawBgmPath = path.join(cacheDir, `${key}_bgm_raw.mp3`);
  const vocalsPath = path.join(cacheDir, `${key}_vocals.mp3`);
  const metaPath = path.join(cacheDir, `${key}_meta.json`);

  if (!isValidAudioFile(bgmPath) || !isValidAudioFile(vocalsPath)) {
    return null;
  }

  let engine = 'ffmpeg_dsp';
  let ambientVersion = 1;
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta && meta.engine) engine = meta.engine;
      if (meta && Number.isFinite(Number(meta.ambientVersion))) {
        ambientVersion = Number(meta.ambientVersion);
      }
    } catch (_) {}
  }

  const hasRawBgm = isValidAudioFile(rawBgmPath);
  return {
    key,
    engine,
    ambientVersion,
    hasRawBgm,
    needsCleanReseparate: Boolean(isAiSeparationEngine(engine) && ambientVersion === 2 && !hasRawBgm),
    needsAmbientUpgrade: Boolean(isAiSeparationEngine(engine) && ambientVersion < AMBIENT_BLEND_VERSION),
    bgmPath,
    rawBgmPath: hasRawBgm ? rawBgmPath : null,
    vocalsPath,
    bgmUrl: `/bgm_cache/${key}_bgm.mp3`,
    vocalsUrl: `/bgm_cache/${key}_vocals.mp3`
  };
}

const inFlightBgmJobs = new Map();
const inFlightAmbientUpgrades = new Map();

async function upgradeExistingBgmWithAmbient(videoPath, hooks = {}) {
  if (!videoPath || typeof videoPath !== 'string') return null;
  const normalized = path.normalize(videoPath.trim());
  const existing = getCachedStemsForVideo(normalized);
  if (!existing || !existing.needsAmbientUpgrade) return existing;

  // v2 stems without a preserved _bgm_raw.mp3 backup already have dialogue F0/sibilants mixed in;
  // re-run clean AI separation instead of filtering the polluted v2 stem in-place.
  if (existing.needsCleanReseparate) {
    const detected = detectSeparationEngine();
    if (isAiSeparationEngine(detected.id) && fs.existsSync(normalized)) {
      return await isolateVideoBgm(normalized, {
        force: true,
        isCancelled: hooks.isCancelled,
        onProcess: hooks.onProcess,
        onProgress: hooks.onProgress
      });
    }
  }

  const key = existing.key;
  if (inFlightAmbientUpgrades.has(key)) {
    return inFlightAmbientUpgrades.get(key);
  }

  const job = (async () => {
    const cacheDir = getBgmCacheDir();
    const rawBgmPath = path.join(cacheDir, `${key}_bgm_raw.mp3`);
    const tmpRaw = `${rawBgmPath}.amb.${process.pid}.${Date.now()}.tmp.mp3`;
    const tmpBgm = `${existing.bgmPath}.amb.${process.pid}.${Date.now()}.tmp.mp3`;
    const metaPath = path.join(cacheDir, `${key}_meta.json`);
    const tmpMeta = `${metaPath}.amb.${process.pid}.${Date.now()}.tmp`;
    try {
      let blendSourceBgm = existing.bgmPath;
      if (isValidAudioFile(rawBgmPath)) {
        blendSourceBgm = rawBgmPath;
      } else if (existing.ambientVersion < 2) {
        // v1 stem is pure un-blended AI instrumental: preserve it as _bgm_raw.mp3 before blending.
        await fs.promises.copyFile(existing.bgmPath, tmpRaw);
        await renameFileSafe(tmpRaw, rawBgmPath);
        blendSourceBgm = rawBgmPath;
      }
      await blendAmbientSfxIntoBgm(blendSourceBgm, existing.vocalsPath, tmpBgm, hooks);
      await renameFileSafe(tmpBgm, existing.bgmPath);
      let meta = { engine: existing.engine, videoPath: normalized, createdAt: new Date().toISOString() };
      if (fs.existsSync(metaPath)) {
        try { meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) }; } catch (_) {}
      }
      meta.ambientVersion = AMBIENT_BLEND_VERSION;
      meta.ambientUpgradedAt = new Date().toISOString();
      await fs.promises.writeFile(tmpMeta, JSON.stringify(meta, null, 2), 'utf8');
      await renameFileSafe(tmpMeta, metaPath);
      return getCachedStemsForVideo(normalized);
    } finally {
      for (const f of [tmpRaw, tmpBgm, tmpMeta]) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
      }
    }
  })();

  inFlightAmbientUpgrades.set(key, job);
  try {
    return await job;
  } finally {
    inFlightAmbientUpgrades.delete(key);
  }
}

/**
 * Isolate BGM (no_vocals) and Vocals stems for a video file, with caching,
 * in-flight deduplication + shared progress/cancellation listeners.
 */
async function isolateVideoBgm(videoPath, options = {}) {
  const normalized = path.normalize(String(videoPath || '').trim());
  const cacheDir = getBgmCacheDir();
  const key = getBgmCacheKey(normalized);
  const bgmPath = path.join(cacheDir, `${key}_bgm.mp3`);
  const vocalsPath = path.join(cacheDir, `${key}_vocals.mp3`);
  const metaPath = path.join(cacheDir, `${key}_meta.json`);

  const detected = detectSeparationEngine();
  if (!options.force) {
    let existing = getCachedStemsForVideo(normalized);
    const shouldUpgradeCachedDsp =
      existing &&
      !isAiSeparationEngine(existing.engine) &&
      options.engine !== 'ffmpeg_dsp' &&
      isAiSeparationEngine(detected.id);
    if (existing && !shouldUpgradeCachedDsp) {
      if (existing.needsAmbientUpgrade) {
        try { existing = await upgradeExistingBgmWithAmbient(normalized); } catch (_) {}
      }
      return { ...existing, cached: true };
    }
  }

  const requestedEngine = String(options.engine || 'auto');
  const jobKey = `${key}|eng=${requestedEngine}`;
  if (!options.force) {
    const existingRecord = inFlightBgmJobs.get(jobKey);
    if (existingRecord) {
      if (typeof options.onProgress === 'function') {
        existingRecord.progressListeners.add(options.onProgress);
        if (existingRecord.lastProgress) {
          try { options.onProgress(existingRecord.lastProgress); } catch (_) {}
        }
      }
      if (typeof options.isCancelled === 'function') {
        existingRecord.cancelCheckers.add(options.isCancelled);
      }
      if (typeof options.onProcess === 'function') {
        existingRecord.processListeners.add(options.onProcess);
        for (const p of existingRecord.activeProcs) {
          try { options.onProcess(p); } catch (_) {}
        }
      }
      try {
        return await existingRecord.promise;
      } finally {
        if (typeof options.onProgress === 'function') existingRecord.progressListeners.delete(options.onProgress);
        if (typeof options.isCancelled === 'function') existingRecord.cancelCheckers.delete(options.isCancelled);
        if (typeof options.onProcess === 'function') existingRecord.processListeners.delete(options.onProcess);
      }
    }
  }

  const record = {
    progressListeners: new Set(),
    cancelCheckers: new Set(),
    processListeners: new Set(),
    activeProcs: new Set(),
    lastProgress: null,
    promise: null
  };
  if (typeof options.onProgress === 'function') record.progressListeners.add(options.onProgress);
  if (typeof options.isCancelled === 'function') record.cancelCheckers.add(options.isCancelled);
  if (typeof options.onProcess === 'function') record.processListeners.add(options.onProcess);

  const emitProgress = (info) => {
    record.lastProgress = info;
    updateActiveBgmProgress({
      running: true,
      key,
      engine: detected.id,
      phase: info.phase || 'separate',
      doneChunks: info.doneChunks || 0,
      totalChunks: info.totalChunks || 1,
      chunkPercent: info.chunkPercent || 0,
      percent: info.percent || 0,
      statusText: info.statusText || ''
    });
    for (const fn of record.progressListeners) {
      try { fn(info); } catch (_) {}
    }
  };
  const checkCancelledAny = () => {
    for (const fn of record.cancelCheckers) {
      try {
        if (fn()) return true;
      } catch (_) {}
    }
    return false;
  };
  const registerProc = (proc) => {
    if (!proc) return;
    record.activeProcs.add(proc);
    proc.once('close', () => record.activeProcs.delete(proc));
    for (const fn of record.processListeners) {
      try { fn(proc); } catch (_) {}
    }
  };

  cleanupStaleBgmTempDirs();

  const jobPromise = (async () => {
    updateActiveBgmProgress({
      running: true,
      key,
      engine: detected.id,
      phase: 'preparing',
      doneChunks: 0,
      totalChunks: 1,
      chunkPercent: 0,
      percent: 1,
      statusText: isAiSeparationEngine(detected.id)
        ? '🎵 កំពុងបំបែកភ្លេង BGM+SFX ដោយ UVR AI (GPU)...'
        : '🎵 កំពុងបំបែកភ្លេង BGM...',
      startedAt: Date.now()
    });

    const audioInfo = await probeAudioInfo(normalized);
    if (!audioInfo || !audioInfo.hasAudio) {
      const err = new Error('វីដេអូនេះគ្មានសំឡេងសម្រាប់បំបែក BGM ទេ។');
      err.statusCode = 422;
      throw err;
    }

    const tmpSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp.mp3`;
    const tmpBgmPath = `${bgmPath}.${tmpSuffix}`;
    const tmpVocalsPath = `${vocalsPath}.${tmpSuffix}`;
    const tmpMetaPath = `${metaPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    let usedEngine = 'ffmpeg_dsp';
    let jobSucceeded = false;
    let jobCancelled = false;

    try {
      if (options.engine !== 'ffmpeg_dsp') {
        const allowAutoEngine = !options.engine || options.engine === 'auto';
        const preferAudioSep = detected.id === 'audio-separator' && (allowAutoEngine || options.engine === 'audio-separator');
        const preferDemucs = detected.id === 'demucs' && (allowAutoEngine || options.engine === 'demucs');

        if (preferAudioSep) {
          try {
            await runAudioSeparatorSeparation(normalized, tmpBgmPath, tmpVocalsPath, detected, {
              ...options,
              resumableKey: key,
              cleanResume: Boolean(options.force),
              onProgress: emitProgress,
              isCancelled: checkCancelledAny,
              onProcess: registerProc
            });
            usedEngine = 'audio-separator';
          } catch (e) {
            if (e && e.cancelled) throw e;
            console.warn('[audio/isolate-bgm] audio-separator fallback to FFmpeg DSP:', e.message);
            // Remove heavy UVR temp chunks when falling back to FFmpeg DSP so GBs of WAVs don't stay orphaned
            const failedUvrDir = path.join(getBgmCacheDir(), `_tmp_uvr_job_${key}`);
            try { if (fs.existsSync(failedUvrDir)) fs.rmSync(failedUvrDir, { recursive: true, force: true }); } catch (_) {}
          }
        } else if (preferDemucs) {
          try {
            await runDemucsSeparation(normalized, tmpBgmPath, tmpVocalsPath, detected, {
              isCancelled: checkCancelledAny,
              onProcess: registerProc
            });
            usedEngine = 'demucs';
          } catch (e) {
            if (e && e.cancelled) throw e;
            console.warn('[audio/isolate-bgm] Demucs fallback to FFmpeg DSP:', e.message);
          }
        }
      }

      if (usedEngine === 'ffmpeg_dsp') {
        if (checkCancelledAny()) throw createBgmCancelledError();
        emitProgress({
          phase: 'dsp',
          doneChunks: 0,
          totalChunks: 1,
          chunkPercent: 50,
          percent: 50,
          statusText: '🎛️ កំពុងបំបែកភ្លេង BGM ដោយ FFmpeg DSP...'
        });
        const isNarrowStereo = audioInfo.channels >= 2
          ? await detectNarrowStereoAudio(normalized)
          : false;
        const bgmFilter = buildBgmFilterForChannels(audioInfo.channels, { narrowStereo: isNarrowStereo });
        await Promise.all([
          runFfmpegExtract(normalized, bgmFilter, tmpBgmPath, '192k', {
            isCancelled: checkCancelledAny,
            onProcess: registerProc
          }),
          runFfmpegExtract(normalized, buildVocalFilterForChannels(audioInfo.channels), tmpVocalsPath, '160k', {
            isCancelled: checkCancelledAny,
            onProcess: registerProc
          })
        ]);
      }

      const rawBgmPath = path.join(cacheDir, `${key}_bgm_raw.mp3`);
      let preservedRawBgm = false;
      if (isAiSeparationEngine(usedEngine)) {
        const rawBgmTmp = `${tmpBgmPath}.raw.mp3`;
        try {
          await renameFileSafe(tmpBgmPath, rawBgmTmp);
          await blendAmbientSfxIntoBgm(rawBgmTmp, tmpVocalsPath, tmpBgmPath, {
            isCancelled: checkCancelledAny,
            onProcess: registerProc
          });
          await renameFileSafe(rawBgmTmp, rawBgmPath);
          preservedRawBgm = isValidAudioFile(rawBgmPath);
        } catch (ambErr) {
          if (ambErr && ambErr.cancelled) throw ambErr;
          if (!isValidAudioFile(tmpBgmPath) && isValidAudioFile(rawBgmTmp)) {
            await renameFileSafe(rawBgmTmp, tmpBgmPath);
          }
          console.warn('[audio/isolate-bgm] Ambient blend fallback to raw AI stem:', ambErr.message);
        } finally {
          try { if (fs.existsSync(rawBgmTmp)) fs.unlinkSync(rawBgmTmp); } catch (_) {}
        }
      }

      await Promise.all([
        renameFileSafe(tmpBgmPath, bgmPath),
        renameFileSafe(tmpVocalsPath, vocalsPath)
      ]);

      try {
        await fs.promises.writeFile(tmpMetaPath, JSON.stringify({
          engine: usedEngine,
          ambientVersion: AMBIENT_BLEND_VERSION,
          hasRawBgm: preservedRawBgm,
          videoPath: normalized,
          createdAt: new Date().toISOString()
        }, null, 2), 'utf8');
        await renameFileSafe(tmpMetaPath, metaPath);
      } catch (_) {}
      jobSucceeded = true;
    } catch (jobErr) {
      if (jobErr && jobErr.cancelled) jobCancelled = true;
      throw jobErr;
    } finally {
      for (const f of [tmpBgmPath, tmpVocalsPath, tmpMetaPath]) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
      }
      if (activeBgmProgressState.key === key) {
        updateActiveBgmProgress({
          running: false,
          phase: jobSucceeded ? 'done' : (jobCancelled ? 'cancelled' : 'error'),
          ...(jobSucceeded ? { percent: 100 } : {})
        });
      }
    }

    return {
      cached: false,
      key,
      engine: usedEngine,
      ambientVersion: AMBIENT_BLEND_VERSION,
      needsAmbientUpgrade: false,
      bgmPath,
      vocalsPath,
      bgmUrl: `/bgm_cache/${key}_bgm.mp3`,
      vocalsUrl: `/bgm_cache/${key}_vocals.mp3`
    };
  })().finally(() => {
    if (inFlightBgmJobs.get(jobKey) === record) {
      inFlightBgmJobs.delete(jobKey);
    }
  });

  record.promise = jobPromise;
  inFlightBgmJobs.set(jobKey, record);
  return jobPromise;
}

function validateVideoPathInput(videoPath) {
  if (typeof videoPath !== 'string' || !videoPath.trim() || videoPath.length > 4096) {
    return { ok: false, status: 400, error: 'ផ្លូវវីដេអូមិនត្រឹមត្រូវ (videoPath required)' };
  }
  if (!path.isAbsolute(videoPath.trim())) {
    return { ok: false, status: 400, error: 'សូមជ្រើសរើសផ្លូវវីដេអូពេញលេញ (Absolute path required)' };
  }
  const normalized = path.normalize(videoPath.trim());
  if (normalized.startsWith('\\\\') || normalized.startsWith('//') || normalized.slice(2).includes(':')) {
    return { ok: false, status: 403, error: 'ផ្លូវវីដេអូមិនត្រូវបានអនុញ្ញាតទេ (Forbidden path)' };
  }
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
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  res.json({
    success: true,
    engine: detectSeparationEngine(refresh)
  });
});

/**
 * GET /api/audio/bgm-progress
 * Live progress snapshot for active UVR AI / BGM isolation job.
 */
router.get('/bgm-progress', (req, res) => {
  res.json({
    success: true,
    ...activeBgmProgressState
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
 * POST /api/audio/upgrade-ambient
 * Instant (<1s) ambient SFX recovery blend on existing cached UVR BGM+Vocal stems.
 */
router.post('/upgrade-ambient', async (req, res) => {
  const { videoPath } = req.body || {};
  const check = validateVideoPathInput(videoPath);
  if (!check.ok) {
    return res.status(check.status).json({ success: false, error: check.error });
  }
  try {
    const upgraded = await upgradeExistingBgmWithAmbient(check.normalized);
    if (!upgraded) {
      return res.json({ success: true, ready: false });
    }
    return res.json({
      success: true,
      ready: true,
      ...upgraded
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
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
    const entries = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir, { withFileTypes: true }) : [];
    let deletedCount = 0;
    const now = Date.now();
    for (const entry of entries) {
      const f = entry.name;
      const fullPath = path.join(cacheDir, f);
      if (f.includes('.tmp.')) {
        try {
          const st = fs.statSync(fullPath);
          if (entry.isFile() && (now - st.mtimeMs) > 60000) {
            fs.unlinkSync(fullPath);
            deletedCount++;
          }
        } catch (_) {}
        continue;
      }
      if (f.startsWith('_tmp_')) {
        const isActiveJob = activeBgmProgressState.running && activeBgmProgressState.key && f.includes(activeBgmProgressState.key);
        if (!isActiveJob && inFlightBgmJobs.size === 0) {
          try {
            fs.rmSync(fullPath, { recursive: true, force: true });
            deletedCount++;
          } catch (_) {}
        }
        continue;
      }
      if (entry.isFile() && (f.endsWith('.mp3') || f.endsWith('.json'))) {
        fs.unlinkSync(fullPath);
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

function cancelActiveBgmProcesses() {
  let killed = 0;
  for (const rec of inFlightBgmJobs.values()) {
    if (!rec || !rec.activeProcs) continue;
    for (const proc of Array.from(rec.activeProcs)) {
      killed++;
      try {
        if (process.platform === 'win32' && proc.pid) {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        }
      } catch (_) {}
      try { proc.kill('SIGKILL'); } catch (_) {}
    }
    rec.activeProcs.clear();
  }
  return killed;
}

router.BGM_ISOLATION_FILTER = BGM_ISOLATION_FILTER;
router.MONO_SAFE_BGM_FILTER = MONO_SAFE_BGM_FILTER;
router.VOCAL_ISOLATION_FILTER = VOCAL_ISOLATION_FILTER;
router.buildBgmFilterForChannels = buildBgmFilterForChannels;
router.buildVocalFilterForChannels = buildVocalFilterForChannels;
router.detectNarrowStereoAudio = detectNarrowStereoAudio;
router.blendAmbientSfxIntoBgm = blendAmbientSfxIntoBgm;
router.upgradeExistingBgmWithAmbient = upgradeExistingBgmWithAmbient;
router.getBgmCacheDir = getBgmCacheDir;
router.cancelActiveBgmProcesses = cancelActiveBgmProcesses;
router.getAiModelsDir = getAiModelsDir;
router.getBgmCacheKey = getBgmCacheKey;
router.isAiSeparationEngine = isAiSeparationEngine;
router.detectSeparationEngine = detectSeparationEngine;
router.getCachedStemsForVideo = getCachedStemsForVideo;
router.isolateVideoBgm = isolateVideoBgm;
router.runAudioSeparatorSeparation = runAudioSeparatorSeparation;
router.buildChildProcessEnv = buildChildProcessEnv;

module.exports = router;

