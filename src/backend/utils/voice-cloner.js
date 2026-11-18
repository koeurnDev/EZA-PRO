/**
 * EZA PRO - Voice Clone Profile Store & Local Seed-VC Engine Manager
 * Manages 3-25s clean reference voice samples and 1-click Seed-VC (fp16) setup
 * isolated onto the project drive (never filling C:\ user cache directories).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { FFMPEG_BIN } = require('./ffmpeg');

const MIN_SAMPLE_SEC = 2.0;
const MAX_SAMPLE_SEC = 25.0;
const MAX_UPLOAD_BYTES = 35 * 1024 * 1024;
const CLONE_ID_REGEX = /^clone_[a-zA-Z0-9_-]{3,40}$/;

const HARDWARE_CACHE_TTL_MS = 60000;
let cachedHardwareInfo = null;
let cachedHardwareAt = 0;

let activeInstallState = {
  state: 'idle', // idle | installing | ready | error | cancelled
  percent: 0,
  stage: '',
  logs: [],
  error: '',
  proc: null,
  cancelled: false
};

function getProjectRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function getClonedVoicesDir() {
  const dir = process.env.CLONED_VOICES_DIR || path.join(getProjectRoot(), 'cloned_voices');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getVoicesIndexPath() {
  return path.join(getClonedVoicesDir(), 'voices.json');
}

function getCloneEngineDir() {
  return process.env.VOICE_CLONE_ENGINE_DIR || path.join(getProjectRoot(), 'voice_clone_engine');
}

function getSeedVcRepoDir(engineDir = getCloneEngineDir()) {
  return path.join(engineDir, 'seed-vc');
}

function getVenvPythonPath(engineDir = getCloneEngineDir()) {
  if (process.platform === 'win32') {
    return path.join(engineDir, 'venv', 'Scripts', 'python.exe');
  }
  return path.join(engineDir, 'venv', 'bin', 'python');
}

function getReadyMarkerPath(engineDir = getCloneEngineDir()) {
  return path.join(engineDir, '.seedvc-ready');
}

function isCustomCloneVoiceId(voiceId) {
  return typeof voiceId === 'string' && CLONE_ID_REGEX.test(voiceId.trim());
}

function isSeedVcReady() {
  const engineDir = getCloneEngineDir();
  const venvPy = getVenvPythonPath(engineDir);
  const inferencePy = path.join(getSeedVcRepoDir(engineDir), 'inference.py');
  return fs.existsSync(venvPy) && fs.existsSync(inferencePy) && fs.existsSync(getReadyMarkerPath(engineDir));
}

function getCloneEnvVars(engineDir = getCloneEngineDir()) {
  const dirs = {
    PIP_CACHE_DIR: path.join(engineDir, '.pip_cache'),
    HF_HOME: path.join(engineDir, '.hf_cache'),
    HUGGINGFACE_HUB_CACHE: path.join(engineDir, '.hf_cache', 'hub'),
    TORCH_HOME: path.join(engineDir, '.torch_cache'),
    TMP: path.join(engineDir, '.tmp'),
    TEMP: path.join(engineDir, '.tmp')
  };
  for (const d of Object.values(dirs)) {
    fs.mkdirSync(d, { recursive: true });
  }
  return {
    ...process.env,
    ...dirs,
    PYTHONIOENCODING: 'utf-8'
  };
}

function getFreeDiskGb(targetPath) {
  try {
    let probePath = path.resolve(targetPath);
    while (probePath && !fs.existsSync(probePath)) {
      const parent = path.dirname(probePath);
      if (parent === probePath) break;
      probePath = parent;
    }
    if (typeof fs.statfsSync === 'function' && fs.existsSync(probePath)) {
      const stats = fs.statfsSync(probePath);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (Number.isFinite(freeBytes)) {
        return Number((freeBytes / (1024 ** 3)).toFixed(2));
      }
    }
  } catch (_) {}
  return null;
}

function detectSystemPython() {
  const candidates = process.platform === 'win32'
    ? [['py', ['-3.10']], ['py', ['-3']], ['python', []]]
    : [['python3.10', []], ['python3', []], ['python', []]];

  for (const [cmd, prefixArgs] of candidates) {
    try {
      const res = spawnSync(cmd, [...prefixArgs, '-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}|{sys.executable}")'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000
      });
      if (res.status === 0 && res.stdout) {
        const [version = '', exe = ''] = res.stdout.trim().split('|');
        // Filter out Microsoft Store stub returning 0 without executable path
        if (exe && fs.existsSync(exe)) {
          return { available: true, cmd, prefixArgs, version, executable: exe };
        }
      }
    } catch (_) {}
  }
  return { available: false, cmd: '', prefixArgs: [], version: '', executable: '' };
}

function detectHardwareInfo(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedHardwareInfo && (now - cachedHardwareAt) < HARDWARE_CACHE_TTL_MS) {
    return cachedHardwareInfo;
  }

  const py = detectSystemPython();
  let gpuName = '';
  let gpuVramMb = 0;
  try {
    const smi = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000
    });
    if (smi.status === 0 && smi.stdout) {
      const firstLine = smi.stdout.trim().split(/\r?\n/)[0] || '';
      const [name = '', vramStr = ''] = firstLine.split(',').map(s => s.trim());
      if (name) {
        gpuName = name;
        gpuVramMb = Number.parseInt(vramStr, 10) || 0;
      }
    }
  } catch (_) {}

  let gitAvailable = false;
  try {
    const gitRes = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    gitAvailable = gitRes.status === 0;
  } catch (_) {}

  cachedHardwareInfo = {
    pythonAvailable: py.available,
    pythonCmd: py.cmd,
    pythonPrefixArgs: py.prefixArgs,
    pythonVersion: py.version,
    pythonExecutable: py.executable,
    gitAvailable,
    hasCudaGpu: Boolean(gpuName),
    gpuName,
    gpuVramMb
  };
  cachedHardwareAt = now;
  return cachedHardwareInfo;
}

function loadClonedVoicesStore() {
  const filePath = getVoicesIndexPath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    const dir = getClonedVoicesDir();
    return parsed.filter(item =>
      item &&
      isCustomCloneVoiceId(item.id) &&
      typeof item.sampleFile === 'string' &&
      fs.existsSync(path.join(dir, path.basename(item.sampleFile)))
    );
  } catch (_) {
    return [];
  }
}

function saveClonedVoicesStore(list) {
  const filePath = getVoicesIndexPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      if ((err.code !== 'EPERM' && err.code !== 'EBUSY') || attempt === 4) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        throw err;
      }
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, 30 * (attempt + 1));
    }
  }
}

function resolveSeedVcRunnerPath() {
  const candidate = path.join(__dirname, 'seed_vc_runner.py');
  if (candidate.includes('app.asar')) {
    const unpacked = candidate.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return candidate;
}

function formatClonedVoiceEntry(item) {
  const baseVoice = item.baseGender === 'Female' ? 'km-KH-SreymomNeural' : 'km-KH-PisethNeural';
  return {
    id: item.id,
    name: item.name,
    baseVoice,
    baseGender: item.baseGender === 'Female' ? 'Female' : 'Male',
    gender: item.baseGender === 'Female' ? 'Female' : 'Male',
    pitch: 0,
    rate: 0,
    language: 'Khmer (Cambodia)',
    isClone: true,
    durationSec: Number(item.durationSec) || 0,
    revision: Number(item.revision) || 1,
    sampleFile: item.sampleFile,
    samplePath: path.join(getClonedVoicesDir(), path.basename(item.sampleFile)),
    sampleUrl: `/cloned_voices/${encodeURIComponent(path.basename(item.sampleFile))}`,
    label: `🎭 Clone · ${item.name}`,
    description: `សំឡេង Clone (${item.durationSec ? item.durationSec.toFixed(1) + 's' : 'គំរូ'})`,
    createdAt: item.createdAt || null
  };
}

function listClonedVoices() {
  return loadClonedVoicesStore().map(formatClonedVoiceEntry);
}

function getClonedVoiceById(voiceId) {
  if (!isCustomCloneVoiceId(voiceId)) return null;
  const trimmed = voiceId.trim();
  const found = loadClonedVoicesStore().find(v => v.id === trimmed);
  return found ? formatClonedVoiceEntry(found) : null;
}

function runFfmpegCapture(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });
    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (code === 0) return resolve(stderr);
      reject(new Error(`FFmpeg failed (code ${code}): ${stderr.slice(-400)}`));
    });
  });
}

function probeWavDurationSec(wavPath) {
  const res = spawnSync(FFMPEG_BIN, ['-i', wavPath], { encoding: 'utf8', windowsHide: true, timeout: 6000 });
  const text = `${res.stderr || ''}\n${res.stdout || ''}`;
  const m = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (m) {
    return (Number(m[1]) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
  }
  // Fallback PCM duration calculation from header-stripped WAV bytes (24kHz * 2 bytes/sample)
  try {
    const size = fs.statSync(wavPath).size;
    if (size > 44) return Math.max(0, (size - 44) / (24000 * 2));
  } catch (_) {}
  return 0;
}

/**
 * Normalize uploaded or extracted reference audio into a clean 24kHz mono WAV clip (2-25s).
 */
async function createClonedVoice({
  name,
  baseGender = 'Male',
  audioBuffer = null,
  sourcePath = '',
  trimStartSec = 0,
  trimDurationSec = 15,
  isolateVocals = false,
  vocalFilter = ''
}) {
  const cleanName = String(name || '').replace(/[\r\n\t<>]/g, '').trim().slice(0, 60);
  if (!cleanName) {
    throw new Error('សូមដាក់ឈ្មោះឲ្យសំឡេង Clone។');
  }

  let rawInputPath = '';
  let cleanupTmp = false;

  if (Buffer.isBuffer(audioBuffer) && audioBuffer.length > 0) {
    if (audioBuffer.length > MAX_UPLOAD_BYTES) {
      throw new Error('ឯកសារសំឡេងគំរូធំពេក (អតិបរមា 35MB)។');
    }
    rawInputPath = path.join(os.tmpdir(), `ezapro-ref-${crypto.randomBytes(6).toString('hex')}.bin`);
    fs.writeFileSync(rawInputPath, audioBuffer);
    cleanupTmp = true;
  } else if (typeof sourcePath === 'string' && sourcePath.trim()) {
    const normalized = path.normalize(sourcePath.trim());
    if (!path.isAbsolute(normalized) || normalized.startsWith('\\\\') || normalized.startsWith('//') || normalized.slice(2).includes(':')) {
      throw new Error('ផ្លូវឯកសារសំឡេង/វីដេអូមិនត្រូវបានអនុញ្ញាតទេ (Forbidden path)។');
    }
    if (!fs.existsSync(normalized)) {
      throw new Error('រកមិនឃើញឯកសារសំឡេង/វីដេអូដើមទេ។');
    }
    rawInputPath = normalized;
  } else {
    throw new Error('សូមផ្ទុកឯកសារសំឡេង ឬជ្រើសវីដេអូដើម្បីកាត់គំរូ។');
  }

  const cloneId = `clone_${crypto.randomBytes(5).toString('hex')}`;
  const sampleFile = `${cloneId}.wav`;
  const outWav = path.join(getClonedVoicesDir(), sampleFile);

  try {
    const safeStart = Math.max(0, Number(trimStartSec) || 0);
    const safeDur = Math.max(MIN_SAMPLE_SEC, Math.min(MAX_SAMPLE_SEC, Number(trimDurationSec) || 15));

    const filterChain = isolateVocals && vocalFilter
      ? `${vocalFilter},aresample=24000,pan=mono|c0=0.5*c0+0.5*c1,loudnorm=I=-16:TP=-1.5:LRA=11`
      : 'highpass=f=80,afftdn=nf=-20,aresample=24000,aformat=channel_layouts=mono,loudnorm=I=-16:TP=-1.5:LRA=11';

    const ffArgs = ['-y'];
    if (safeStart > 0) ffArgs.push('-ss', safeStart.toFixed(2));
    ffArgs.push('-i', rawInputPath, '-t', safeDur.toFixed(2), '-vn', '-af', filterChain, '-c:a', 'pcm_s16le', outWav);

    await runFfmpegCapture(ffArgs);

    const dur = probeWavDurationSec(outWav);
    if (!fs.existsSync(outWav) || dur < MIN_SAMPLE_SEC) {
      try { if (fs.existsSync(outWav)) fs.unlinkSync(outWav); } catch (_) {}
      throw new Error(`សំឡេងគំរូខ្លីពេក (${dur.toFixed(1)}s) — សូមប្រើសំឡេងច្បាស់យ៉ាងតិច ${MIN_SAMPLE_SEC} វិនាទី។`);
    }

    const genderNorm = String(baseGender || '').toLowerCase().startsWith('f') ? 'Female' : 'Male';
    const record = {
      id: cloneId,
      name: cleanName,
      baseGender: genderNorm,
      sampleFile,
      durationSec: Number(dur.toFixed(2)),
      revision: 1,
      createdAt: new Date().toISOString()
    };

    const list = loadClonedVoicesStore();
    list.push(record);
    saveClonedVoicesStore(list);
    return formatClonedVoiceEntry(record);
  } finally {
    if (cleanupTmp && rawInputPath && fs.existsSync(rawInputPath)) {
      try { fs.unlinkSync(rawInputPath); } catch (_) {}
    }
  }
}

function deleteClonedVoice(voiceId) {
  if (!isCustomCloneVoiceId(voiceId)) return false;
  const list = loadClonedVoicesStore();
  const idx = list.findIndex(v => v.id === voiceId.trim());
  if (idx === -1) return false;
  const [removed] = list.splice(idx, 1);
  saveClonedVoicesStore(list);
  const wavPath = path.join(getClonedVoicesDir(), path.basename(removed.sampleFile));
  try {
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
  } catch (_) {}
  return true;
}

function appendInstallLog(line) {
  const clean = String(line || '').trim();
  if (!clean) return;
  activeInstallState.logs.push(clean.slice(0, 300));
  if (activeInstallState.logs.length > 60) {
    activeInstallState.logs.shift();
  }
}

function runLoggedCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (activeInstallState.cancelled) {
      return reject(new Error('ការដំឡើងត្រូវបានបោះបង់ដោយអ្នកប្រើ'));
    }
    const proc = spawn(cmd, args, { ...opts, windowsHide: true });
    activeInstallState.proc = proc;

    const handleChunk = (buf) => {
      const lines = buf.toString().split(/\r?\n/);
      for (const l of lines) {
        if (l.trim()) appendInstallLog(l);
      }
    };
    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);
    proc.on('error', err => reject(err));
    proc.on('close', code => {
      activeInstallState.proc = null;
      if (activeInstallState.cancelled) {
        return reject(new Error('ការដំឡើងត្រូវបានបោះបង់ដោយអ្នកប្រើ'));
      }
      if (code === 0) return resolve();
      reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function startSeedVcInstall() {
  if (activeInstallState.state === 'installing') {
    return getCloneEngineStatus();
  }

  const hw = detectHardwareInfo(true);
  const engineDir = getCloneEngineDir();
  const freeGb = getFreeDiskGb(engineDir);

  if (!hw.pythonAvailable) {
    activeInstallState = {
      state: 'error',
      percent: 0,
      stage: 'ខ្វះ Python 3.10',
      logs: [],
      error: 'រកមិនឃើញ Python 3.10+ លើម៉ាស៊ីនទេ។',
      proc: null,
      cancelled: false
    };
    return getCloneEngineStatus();
  }
  if (!hw.gitAvailable) {
    activeInstallState = {
      state: 'error',
      percent: 0,
      stage: 'ខ្វះ Git',
      logs: [],
      error: 'រកមិនឃើញ Git លើម៉ាស៊ីនទេ។',
      proc: null,
      cancelled: false
    };
    return getCloneEngineStatus();
  }
  if (freeGb !== null && freeGb < 5.0) {
    activeInstallState = {
      state: 'error',
      percent: 0,
      stage: 'ទំហំ Disk មិនគ្រប់គ្រាន់',
      logs: [],
      error: `ទំហំទំនេរនៅ ${engineDir} សល់តែ ${freeGb} GB (ត្រូវការយ៉ាងតិច 5 GB សម្រាប់ Seed-VC + Torch)។`,
      proc: null,
      cancelled: false
    };
    return getCloneEngineStatus();
  }

  activeInstallState = {
    state: 'installing',
    percent: 5,
    stage: 'កំពុងរៀបចំបរិស្ថាន Python...',
    logs: [`Target engine dir: ${engineDir}`],
    error: '',
    proc: null,
    cancelled: false
  };

  // Run asynchronous installer in background without blocking HTTP response
  (async () => {
    try {
      fs.mkdirSync(engineDir, { recursive: true });
      const env = getCloneEnvVars(engineDir);
      const venvDir = path.join(engineDir, 'venv');
      const venvPy = getVenvPythonPath(engineDir);
      const repoDir = getSeedVcRepoDir(engineDir);
      const runnerPy = resolveSeedVcRunnerPath();

      if (!fs.existsSync(venvPy)) {
        activeInstallState.percent = 12;
        activeInstallState.stage = 'កំពុងបង្កើត Virtual Environment...';
        await runLoggedCommand(hw.pythonCmd, [...hw.pythonPrefixArgs, '-m', 'venv', venvDir], { env });
      }

      activeInstallState.percent = 25;
      activeInstallState.stage = hw.hasCudaGpu
        ? `កំពុងដំឡើង PyTorch CUDA (${hw.gpuName})...`
        : 'កំពុងដំឡើង PyTorch (CPU)...';
      const torchArgs = hw.hasCudaGpu
        ? ['-m', 'pip', 'install', '--upgrade', 'torch', 'torchvision', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cu121']
        : ['-m', 'pip', 'install', '--upgrade', 'torch', 'torchvision', 'torchaudio'];
      await runLoggedCommand(venvPy, torchArgs, { env });

      if (!fs.existsSync(path.join(repoDir, 'inference.py'))) {
        if (fs.existsSync(repoDir)) {
          try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch (_) {}
        }
        activeInstallState.percent = 58;
        activeInstallState.stage = 'កំពុងទាញយក Seed-VC repository...';
        try {
          await runLoggedCommand('git', ['clone', '--depth', '1', 'https://github.com/Plachtaa/seed-vc.git', repoDir], { env });
        } catch (cloneErr) {
          if (!fs.existsSync(path.join(repoDir, 'inference.py'))) {
            try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch (_) {}
          }
          throw cloneErr;
        }
      }

      const reqTxt = path.join(repoDir, 'requirements.txt');
      if (fs.existsSync(reqTxt)) {
        activeInstallState.percent = 74;
        activeInstallState.stage = 'កំពុងដំឡើង Dependencies របស់ Seed-VC...';
        await runLoggedCommand(venvPy, ['-m', 'pip', 'install', '-r', reqTxt], { cwd: repoDir, env });
      }

      activeInstallState.percent = 92;
      activeInstallState.stage = 'កំពុងផ្ទៀងផ្ទាត់ Seed-VC runtime...';
      await runLoggedCommand(venvPy, [runnerPy, '--repo-dir', repoDir, '--check'], { env });

      fs.writeFileSync(getReadyMarkerPath(engineDir), JSON.stringify({
        installedAt: new Date().toISOString(),
        gpuName: hw.gpuName || 'cpu',
        pythonVersion: hw.pythonVersion
      }, null, 2), 'utf8');

      activeInstallState.percent = 100;
      activeInstallState.state = 'ready';
      activeInstallState.stage = '✅ Seed-VC រួចរាល់សម្រាប់ប្រើប្រាស់!';
      appendInstallLog('Seed-VC installation verified successfully.');
    } catch (err) {
      activeInstallState.state = activeInstallState.cancelled ? 'cancelled' : 'error';
      activeInstallState.error = err.message || 'Install failed';
      activeInstallState.stage = activeInstallState.cancelled
        ? '🛑 បានបោះបង់ការដំឡើង'
        : `❌ បរាជ័យ៖ ${activeInstallState.error}`;
      appendInstallLog(`Error: ${activeInstallState.error}`);
    }
  })();

  return getCloneEngineStatus();
}

function cancelSeedVcInstall() {
  activeInstallState.cancelled = true;
  if (activeInstallState.proc) {
    try {
      if (process.platform === 'win32' && activeInstallState.proc.pid) {
        spawn('taskkill', ['/PID', String(activeInstallState.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        activeInstallState.proc.kill('SIGTERM');
      }
    } catch (_) {}
  }
  return getCloneEngineStatus();
}

function getCloneEngineStatus() {
  const engineDir = getCloneEngineDir();
  const hw = detectHardwareInfo(false);
  const ready = isSeedVcReady();
  const freeGb = getFreeDiskGb(engineDir);
  return {
    engine: 'seed-vc',
    label: 'Seed-VC (Zero-Shot fp16)',
    ready,
    installed: ready,
    engineDir,
    venvPython: getVenvPythonPath(engineDir),
    diskFreeGb: freeGb,
    estimatedSizeGb: 3.5,
    pythonAvailable: hw.pythonAvailable,
    pythonVersion: hw.pythonVersion,
    gitAvailable: hw.gitAvailable,
    hasCudaGpu: hw.hasCudaGpu,
    gpuName: hw.gpuName,
    gpuVramMb: hw.gpuVramMb,
    installState: ready && activeInstallState.state === 'idle' ? 'ready' : activeInstallState.state,
    installPercent: ready ? 100 : activeInstallState.percent,
    installStage: ready && !activeInstallState.stage ? '✅ រួចរាល់' : activeInstallState.stage,
    installError: activeInstallState.error,
    installLogs: activeInstallState.logs.slice(-12)
  };
}

/**
 * Convert synthesized Edge Khmer speech into the cloned voice timbre via Seed-VC.
 */
async function convertSpeechWithSeedVc({ sourceAudioFile, targetRefWav, outMp3File }) {
  if (!isSeedVcReady()) {
    const err = new Error('ម៉ូដែល AI Voice Clone (Seed-VC) មិនទាន់បានដំឡើងទេ — សូមបើក Voice Clone Studio ចុចដំឡើងសិន។');
    err.needsCloneEngineInstall = true;
    throw err;
  }

  const engineDir = getCloneEngineDir();
  const venvPy = getVenvPythonPath(engineDir);
  const repoDir = getSeedVcRepoDir(engineDir);
  const runnerPy = resolveSeedVcRunnerPath();
  const env = getCloneEnvVars(engineDir);
  const hw = detectHardwareInfo(false);

  const uniqueTag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  const rawOutWav = `${outMp3File}.${uniqueTag}.seedvc.wav`;
  const tmpOutMp3 = `${outMp3File}.${uniqueTag}.tmp.mp3`;
  try {
    await new Promise((resolve, reject) => {
      const args = [
        runnerPy,
        '--repo-dir', repoDir,
        '--source', sourceAudioFile,
        '--target', targetRefWav,
        '--output', rawOutWav,
        '--steps', '18',
        '--fp16', hw.hasCudaGpu ? 'true' : 'false'
      ];
      const proc = spawn(venvPy, args, { env, windowsHide: true });
      let stderr = '';
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        try {
          if (process.platform === 'win32' && proc.pid) {
            spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          } else {
            proc.kill('SIGKILL');
          }
        } catch (_) {}
        finish(new Error('Seed-VC conversion timed out after 5 minutes'));
      }, 330000);
      if (proc.stdout) proc.stdout.resume();
      if (proc.stderr) {
        proc.stderr.on('data', d => {
          stderr += d.toString();
          if (stderr.length > 4000) stderr = stderr.slice(-4000);
        });
      }
      proc.on('error', finish);
      proc.on('close', code => {
        if (code === 0 && fs.existsSync(rawOutWav)) return finish();
        finish(new Error(`Seed-VC conversion failed (code ${code}): ${stderr.slice(-500)}`));
      });
    });

    await runFfmpegCapture([
      '-y', '-i', rawOutWav,
      '-ar', '24000', '-ac', '1',
      '-c:a', 'libmp3lame', '-b:a', '64k',
      tmpOutMp3
    ]);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(tmpOutMp3, outMp3File);
        break;
      } catch (err) {
        if ((err.code !== 'EPERM' && err.code !== 'EBUSY') || attempt === 4) {
          throw err;
        }
        await new Promise(r => setTimeout(r, 35 * (attempt + 1)));
      }
    }
  } finally {
    try { if (fs.existsSync(rawOutWav)) fs.unlinkSync(rawOutWav); } catch (_) {}
    try { if (fs.existsSync(tmpOutMp3)) fs.unlinkSync(tmpOutMp3); } catch (_) {}
  }
}

module.exports = {
  MIN_SAMPLE_SEC,
  MAX_SAMPLE_SEC,
  getClonedVoicesDir,
  getCloneEngineDir,
  isCustomCloneVoiceId,
  isSeedVcReady,
  listClonedVoices,
  getClonedVoiceById,
  createClonedVoice,
  deleteClonedVoice,
  getCloneEngineStatus,
  startSeedVcInstall,
  cancelSeedVcInstall,
  convertSpeechWithSeedVc
};
