/**
 * ⚡ EZA PRO - Electron Main Process
 * Desktop Application Entry Point
 */

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const express = require('express');
const logger = require('./src/backend/utils/logger');

process.on('uncaughtException', (err) => {
  logger.logError('MainProcess:uncaughtException', err);
  console.error('[Main] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  logger.logError('MainProcess:unhandledRejection', reason instanceof Error ? reason : String(reason));
  console.error('[Main] Unhandled rejection:', reason);
});

let shouldRunMainApp = true;

if (app && typeof app.requestSingleInstanceLock === 'function') {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    shouldRunMainApp = false;
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  }
}

// Import backend server
const backendApp = express();

let mainWindow;
let backendServer;
let backendPort;
const geminiKeyPath = path.join(app.getPath('userData'), 'gemini-api-key.bin');
const geminiAccountsPath = path.join(app.getPath('userData'), 'gemini-accounts.bin');
const legacyGeminiAccountsPath = path.join(__dirname, 'accounts.json');

function loadGeminiAccounts(options = {}) {
  const { syncDesktop = false } = options || {};
  if (!fs.existsSync(geminiAccountsPath)) {
    return { accounts: [], activeAccountId: null };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure system storage is unavailable. Cannot read Gemini accounts.');
  }

  let data;
  try {
    const encrypted = fs.readFileSync(geminiAccountsPath);
    data = JSON.parse(safeStorage.decryptString(encrypted));
  } catch (err) {
    console.warn('[Main] Saved Gemini account file unreadable/corrupt, starting fresh:', err.message);
    return { accounts: [], activeAccountId: null };
  }
  if (!data || !Array.isArray(data.accounts) ||
    !(data.activeAccountId === null || typeof data.activeAccountId === 'string') ||
    data.accounts.some(account => !account ||
      typeof account.id !== 'string' ||
      typeof account.name !== 'string' ||
      typeof account.email !== 'string' ||
      typeof account.apiKey !== 'string')) {
    console.warn('[Main] Saved Gemini account structure invalid, starting fresh.');
    return { accounts: [], activeAccountId: null };
  }
  if (data.activeAccountId !== null && !data.accounts.some(account => account.id === data.activeAccountId)) {
    data.activeAccountId = data.accounts.length > 0 ? data.accounts[0].id : null;
  }
  if (syncDesktop) {
    try {
      const configRouter = require('./src/backend/routes/config');
      if (typeof configRouter.syncAccountsFromDesktop === 'function') {
        configRouter.syncAccountsFromDesktop(data);
      }
    } catch (_) { }
  }
  return data;
}

function saveGeminiAccounts(data) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure system storage is unavailable. Cannot save Gemini accounts safely.');
  }

  fs.mkdirSync(path.dirname(geminiAccountsPath), { recursive: true });
  const temporaryPath = `${geminiAccountsPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, safeStorage.encryptString(JSON.stringify(data)), { mode: 0o600 });
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(temporaryPath, geminiAccountsPath);
        break;
      } catch (err) {
        if ((err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') || attempt === 4) {
          throw err;
        }
        const sab = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(sab), 0, 0, 25 * (attempt + 1));
      }
    }
  } finally {
    try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch (_) { }
  }
  try {
    const configRouter = require('./src/backend/routes/config');
    if (typeof configRouter.syncAccountsFromDesktop === 'function') {
      configRouter.syncAccountsFromDesktop(data, { authoritative: true });
    }
  } catch (_) { }
}

function createGeminiAccount(name, email, apiKey) {
  return {
    id: `gemini_${crypto.randomUUID()}`,
    name,
    email,
    apiKey,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastUsed: null
  };
}

function getSafeGeminiAccounts(data = loadGeminiAccounts()) {
  return {
    activeAccountId: data.activeAccountId,
    accounts: data.accounts.map(account => ({
      id: account.id,
      name: account.name,
      email: account.email,
      keyHint: `${account.apiKey.slice(0, 8)}...${account.apiKey.slice(-4)}`,
      isActive: account.id === data.activeAccountId,
      enabled: account.enabled !== false,
      createdAt: account.createdAt || null,
      lastUsed: account.lastUsed || null
    }))
  };
}

function saveGeminiApiKey(apiKey) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure system storage is unavailable. Cannot save the Gemini API key safely.');
  }

  const data = loadGeminiAccounts();
  const activeAccount = data.accounts.find(account => account.id === data.activeAccountId);
  if (data.accounts.some(account => account.id !== data.activeAccountId && account.apiKey === apiKey)) {
    throw new Error('This Gemini API key is already saved under another account.');
  }
  if (activeAccount) {
    activeAccount.apiKey = apiKey;
  } else {
    const account = createGeminiAccount('Gemini Account', '', apiKey);
    data.accounts.push(account);
    data.activeAccountId = account.id;
  }
  saveGeminiAccounts(data);
}

function getGeminiApiKey() {
  const data = loadGeminiAccounts();
  if (data.accounts.length > 0) {
    const activeAccount = data.accounts.find(account => account.id === data.activeAccountId && account.enabled !== false)
      || data.accounts.find(account => account.enabled !== false)
      || null;
    return activeAccount ? activeAccount.apiKey : '';
  }
  if (!fs.existsSync(geminiKeyPath)) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure system storage is unavailable. Cannot read the Gemini API key.');
  }

  return safeStorage.decryptString(fs.readFileSync(geminiKeyPath));
}

function migrateLegacyGeminiKey() {
  const configPath = path.join(__dirname, 'config.json');
  const preferencesPath = path.join(app.getPath('userData'), 'config.json');
  const envPath = path.join(__dirname, '.env');
  let config = {};
  let envContents = '';
  let configKey = '';
  let envKey = '';
  let hasConfigKey = false;
  let hasEnvKey = false;

  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed;
      }
      hasConfigKey = Object.prototype.hasOwnProperty.call(config, 'GEMINI_API_KEY');
      configKey = typeof config.GEMINI_API_KEY === 'string' ? config.GEMINI_API_KEY.trim() : '';
    } catch (err) {
      console.warn('[Main] Skipping invalid config.json during legacy migration:', err.message);
    }
  }

  if (fs.existsSync(envPath)) {
    envContents = fs.readFileSync(envPath, 'utf8');
    const match = envContents.match(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*?)\s*$/m);
    hasEnvKey = !!match;
    envKey = match ? match[1].replace(/^(['"])(.*)\1$/, '$2').trim() : '';
  }

  let data = { accounts: [] };
  try {
    data = loadGeminiAccounts();
  } catch (err) {
    console.warn('[Main] Skipping legacy key migration when accounts unavailable:', err.message);
    return;
  }
  const processKey = typeof process.env.GEMINI_API_KEY === 'string'
    ? process.env.GEMINI_API_KEY.trim()
    : '';
  const legacyKey = processKey || envKey || configKey;
  if (legacyKey && !data.accounts.some(acc => acc.apiKey === legacyKey) && data.accounts.length === 0) {
    try {
      saveGeminiApiKey(legacyKey);
    } catch (err) {
      console.warn('[Main] Skipping legacy Gemini key migration:', err.message);
    }
  }

  if (hasConfigKey && !app.isPackaged) {
    delete config.GEMINI_API_KEY;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  if (!fs.existsSync(preferencesPath) && Object.keys(config).length > 0) {
    fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
    fs.writeFileSync(preferencesPath, JSON.stringify(config, null, 2), 'utf8');
  }

  if (hasEnvKey && !app.isPackaged) {
    const cleanedEnv = envContents.replace(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=.*(?:\r?\n|$)/m, '');
    fs.writeFileSync(envPath, cleanedEnv, 'utf8');
  }
}

function migrateLegacyGeminiAccount() {
  try {
    const data = loadGeminiAccounts({ syncDesktop: true });
    if (data.accounts.length > 0 || !fs.existsSync(geminiKeyPath)) return;

    const apiKey = safeStorage.decryptString(fs.readFileSync(geminiKeyPath));
    if (!apiKey) return;

    const account = createGeminiAccount('Gemini Account', '', apiKey);
    saveGeminiAccounts({ accounts: [account], activeAccountId: account.id });
    try { fs.unlinkSync(geminiKeyPath); } catch (_) { }
  } catch (err) {
    logger.logWarn('Main:migrateLegacyGeminiAccount', err.message);
    console.warn('[Main] Skipping unreadable legacy gemini-api-key.bin:', err.message);
  }
}

function migrateLegacyGeminiAccountsFile() {
  if (!fs.existsSync(legacyGeminiAccountsPath)) return;

  let legacyData;
  try {
    legacyData = JSON.parse(fs.readFileSync(legacyGeminiAccountsPath, 'utf8'));
  } catch (err) {
    console.warn('[Main] Ignoring unreadable legacy accounts.json:', err.message);
    return;
  }
  if (!legacyData || !Array.isArray(legacyData.accounts)) {
    console.warn('[Main] Legacy Gemini accounts file has invalid format, skipping.');
    return;
  }

  let data;
  try {
    data = loadGeminiAccounts();
  } catch (err) {
    logger.logWarn('Main:migrateLegacyGeminiAccountsFile', err.message);
    console.warn('[Main] Skipping legacy accounts.json migration:', err.message);
    return;
  }
  const accountIds = new Set(data.accounts.map(account => account.id));
  const accountsByKey = new Map(data.accounts.map(account => [account.apiKey, account]));
  const migratedIds = new Map();

  legacyData.accounts.forEach(legacyAccount => {
    const name = typeof legacyAccount?.name === 'string' ? legacyAccount.name.trim() : '';
    const email = typeof legacyAccount?.email === 'string' ? legacyAccount.email.trim() : '';
    const apiKey = typeof legacyAccount?.apiKey === 'string' ? legacyAccount.apiKey.trim() : '';
    if (!name || name.length > 80 || email.length > 254 || apiKey.length < 20 || apiKey.length > 512) {
      console.warn('[Main] Skipping malformed entry in legacy accounts.json');
      return;
    }

    let account = accountsByKey.get(apiKey);
    if (!account) {
      account = createGeminiAccount(name, email, apiKey);
      if (typeof legacyAccount.id === 'string' && legacyAccount.id &&
        !accountIds.has(legacyAccount.id)) {
        account.id = legacyAccount.id;
      }
      if (typeof legacyAccount.createdAt === 'string') account.createdAt = legacyAccount.createdAt;
      if (typeof legacyAccount.lastUsed === 'string') account.lastUsed = legacyAccount.lastUsed;
      data.accounts.push(account);
      accountIds.add(account.id);
      accountsByKey.set(apiKey, account);
    }
    if (typeof legacyAccount.id === 'string') migratedIds.set(legacyAccount.id, account.id);
  });

  const legacyActiveId = typeof legacyData.activeAccount === 'string'
    ? migratedIds.get(legacyData.activeAccount)
    : null;
  if (legacyActiveId) data.activeAccountId = legacyActiveId;
  if (!data.activeAccountId && data.accounts.length > 0) data.activeAccountId = data.accounts[0].id;

  try {
    saveGeminiAccounts(data);
    if (!app.isPackaged) {
      try { fs.unlinkSync(legacyGeminiAccountsPath); } catch (_) { }
    }
  } catch (err) {
    logger.logWarn('Main:migrateLegacyGeminiAccountsFile:save', err.message);
  }
}

function assertGeminiKeyRequestIsFromMainFrame(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Unauthorized API key request.');
  }
  const expectedUrl = pathToFileURL(path.join(__dirname, 'src', 'frontend', 'index.html'));
  let senderUrl;
  try {
    senderUrl = new URL(event.senderFrame.url);
  } catch (_) {
    throw new Error('Unauthorized API key request.');
  }
  if (senderUrl.protocol !== 'file:' ||
    `${senderUrl.origin}${senderUrl.pathname}` !== `${expectedUrl.origin}${expectedUrl.pathname}`) {
    throw new Error('Unauthorized API key request.');
  }
}

// Configure backend Express server
function setupBackend() {
  backendApp.use(express.json({ limit: '50mb' }));
  backendApp.use(express.urlencoded({ extended: true, limit: '50mb' }));
  backendApp.use((req, res, next) => {
    const origin = req.get('Origin');
    if (origin && origin !== 'null') {
      return res.sendStatus(403);
    }
    if (origin === 'null') {
      res.setHeader('Access-Control-Allow-Origin', 'null');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range, x-eza-access-token');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });

  // Inject API key getter into request
  backendApp.use((req, res, next) => {
    req.getGeminiApiKey = getGeminiApiKey;
    next();
  });

  // Serve static files (audio cache, cloned voice samples, etc)
  const voiceCloner = require('./src/backend/utils/voice-cloner');
  backendApp.use('/audio_cache', express.static(process.env.AUDIO_CACHE_DIR || path.join(__dirname, 'audio_cache')));
  const clonedVoicesStatic = express.static(voiceCloner.getClonedVoicesDir());
  backendApp.use('/cloned_voices', clonedVoicesStatic);

  // Setup API routes using Express Router
  const { setupRoutes } = require('./src/backend/routes');
  setupRoutes(backendApp);

  // Start backend on random available port
  return new Promise((resolve, reject) => {
    backendServer = backendApp.listen(0, '127.0.0.1', () => {
      backendServer.requestTimeout = 0;
      backendPort = backendServer.address().port;
      process.env.PORT = String(backendPort);
      logger.logInfo('Main:backend', `Backend server running on http://127.0.0.1:${backendPort} (packaged=${app.isPackaged ? '1' : '0'})`);
      console.log(`⚡ Backend server running on http://127.0.0.1:${backendPort}`);
      resolve(backendPort);
    });
    backendServer.once('error', reject);
  });
}

// Create main application window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: process.env.NODE_ENV === 'development' && !app.isPackaged && process.env.EZA_LOCK_DEVTOOLS !== '1',
      additionalArguments: [`--backend-url=http://127.0.0.1:${backendPort}`]
    },
    icon: path.join(__dirname, 'build', 'icon.png'),
    title: 'EZA PRO - AI Dubbing & Subtitle Studio',
    backgroundColor: '#070b16',
    show: true
  });

  // Load frontend
  const indexHtmlPath = path.join(__dirname, 'src', 'frontend', 'index.html');
  const expectedIndexUrl = pathToFileURL(indexHtmlPath).href;
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const targetNoHash = String(targetUrl || '').split('#')[0];
      const expectedNoHash = expectedIndexUrl.split('#')[0];
      if (targetNoHash !== expectedNoHash) {
        event.preventDefault();
      }
    } catch (_) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logger.logError('Main:did-fail-load', `code=${errorCode} ${errorDescription} url=${validatedURL}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.logError('Main:render-process-gone', JSON.stringify(details || {}));
  });
  mainWindow.loadFile(indexHtmlPath);

  const bringToFront = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    if (typeof mainWindow.moveTop === 'function') {
      mainWindow.moveTop();
    }
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(false);
      }
    }, 400);
  };

  // Show and bring window to foreground when ready
  mainWindow.once('ready-to-show', bringToFront);

  // Open DevTools only in explicit development mode; block F12 / Ctrl+Shift+I in packaged builds
  if (process.env.NODE_ENV === 'development' && !app.isPackaged && process.env.EZA_LOCK_DEVTOOLS !== '1') {
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools();
    });
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = String(input.key || '').toUpperCase();
      const isInspectShortcut =
        key === 'F12' ||
        ((input.control || input.meta) && input.shift && (key === 'I' || key === 'J' || key === 'C')) ||
        ((input.control || input.meta) && key === 'U');
      if (isInspectShortcut) {
        event.preventDefault();
      }
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Probe real file creation inside a directory because Windows Controlled Folder Access
 * lets fs.existsSync / mkdirSync appear OK on pre-existing folders like Videos while
 * blocking node/ffmpeg file writes with ENOENT or EACCES.
 */
function isDirectoryWritable(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probe = path.join(dirPath, `.eza_write_probe_${process.pid}_${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

function resolveDefaultPackagedExportDir(userDataDir) {
  const candidates = [];
  if (process.env.EXPORT_DIR) candidates.push(process.env.EXPORT_DIR);
  try {
    const videosDir = app.getPath('videos');
    if (videosDir) candidates.push(path.join(videosDir, 'EZA PRO Exported'));
  } catch (_) { }
  try {
    const downloadsDir = app.getPath('downloads');
    if (downloadsDir) candidates.push(path.join(downloadsDir, 'EZA PRO Exported'));
  } catch (_) { }
  candidates.push(path.join(userDataDir, 'Exported'));
  candidates.push(path.join(os.tmpdir(), 'EZA PRO Exported'));

  for (const dir of candidates) {
    if (isDirectoryWritable(dir)) {
      if (candidates[0] && dir !== candidates[0]) {
        logger.logWarn('Main:paths', `Default export folder not writable (${candidates[0]}), using fallback: ${dir}`);
      }
      return dir;
    }
  }
  return path.join(userDataDir, 'Exported');
}

function configurePackagedPaths() {
  process.env.EZA_PACKAGED = app.isPackaged ? '1' : '0';
  if (!app.isPackaged) return;
  const userDataDir = app.getPath('userData');

  process.env.EZA_PACKAGED_CLIENT = '1';
  delete process.env.GEMINI_API_KEY;
  process.env.EZA_USER_DATA_DIR = process.env.EZA_USER_DATA_DIR || userDataDir;
  process.env.EZA_LOG_DIR = process.env.EZA_LOG_DIR || path.join(userDataDir, 'logs');
  process.env.EZA_CONFIG_FILE = process.env.EZA_CONFIG_FILE || path.join(userDataDir, 'config.json');
  process.env.GEMINI_ACCOUNTS_FILE = process.env.GEMINI_ACCOUNTS_FILE || path.join(userDataDir, 'gemini-accounts.json');
  process.env.AUDIO_CACHE_DIR = process.env.AUDIO_CACHE_DIR || path.join(userDataDir, 'audio_cache');
  process.env.BGM_CACHE_DIR = process.env.BGM_CACHE_DIR || path.join(userDataDir, 'bgm_cache');
  process.env.TRANSLATION_CACHE_DIR = process.env.TRANSLATION_CACHE_DIR || path.join(userDataDir, 'translation_cache');
  process.env.SERIES_GLOSSARY_DIR = process.env.SERIES_GLOSSARY_DIR || path.join(userDataDir, 'series_glossaries');
  process.env.DRAFTS_DIR = process.env.DRAFTS_DIR || path.join(userDataDir, 'drafts');
  process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(userDataDir, 'uploads');
  process.env.CLONED_VOICES_DIR = process.env.CLONED_VOICES_DIR || path.join(userDataDir, 'cloned_voices');
  process.env.VOICE_CLONE_ENGINE_DIR = process.env.VOICE_CLONE_ENGINE_DIR || path.join(userDataDir, 'voice_clone_engine');
  process.env.AUDIO_SEPARATOR_MODEL_DIR = process.env.AUDIO_SEPARATOR_MODEL_DIR || path.join(userDataDir, 'ai_models', 'audio_separator');
  process.env.TORCH_HOME = process.env.TORCH_HOME || path.join(userDataDir, 'ai_models', 'torch');
  process.env.SENSEVOICE_CACHE_DIR = process.env.SENSEVOICE_CACHE_DIR || path.join(userDataDir, 'ai_models', 'sensevoice');
  process.env.EXPORT_DIR = resolveDefaultPackagedExportDir(userDataDir);
}

function ensureWindowsKhmerFontInstalled() {
  if (process.platform !== 'win32') return;
  try {
    const localAppData = process.env.LOCALAPPDATA || app.getPath('appData');
    if (!localAppData) return;
    const srcFont = logger.resolveUnpackedPath(path.join(__dirname, 'src', 'frontend', 'fonts', 'KantumruyPro-Bold.ttf'));
    if (!fs.existsSync(srcFont)) return;
    const winFontsDir = path.join(localAppData, 'Microsoft', 'Windows', 'Fonts');
    const destFont = path.join(winFontsDir, 'KantumruyPro-Bold.ttf');
    if (fs.existsSync(destFont)) return;
    fs.mkdirSync(winFontsDir, { recursive: true });
    fs.copyFileSync(srcFont, destFont);
    const { execFile } = require('child_process');
    execFile('reg.exe', [
      'add',
      'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
      '/v', 'Kantumruy Pro Bold (TrueType)',
      '/t', 'REG_SZ',
      '/d', destFont,
      '/f'
    ], { windowsHide: true }, () => { });
  } catch (err) {
    logger.logWarn('Main:font-install', err.message);
  }
}

// App lifecycle
if (shouldRunMainApp) {
  app.whenReady().then(async () => {
    console.log('⚡ EZA PRO starting...');
    configurePackagedPaths();
    ensureWindowsKhmerFontInstalled();
    logger.logInfo('Main:startup', `Starting EZA PRO v${app.getVersion()} (packaged=${app.isPackaged})`);

    migrateLegacyGeminiAccount();
    if (!app.isPackaged) {
      migrateLegacyGeminiAccountsFile();
      migrateLegacyGeminiKey();
    }

    // Setup backend first
    await setupBackend();

    // Then create window
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  }).catch((err) => {
    logger.logError('Main:startup-failed', err);
    console.error('⚡ EZA PRO failed to start:', err);
    dialog.showErrorBox('EZA PRO startup failed', `${err.message}\n\nLog: ${logger.getLogFilePath()}`);
    app.quit();
  });
}

let isShuttingDownBackend = false;
function shutdownBackendAndTunnels() {
  if (isShuttingDownBackend) return;
  isShuttingDownBackend = true;
  try {
    const exportRouter = require('./src/backend/routes/export');
    if (typeof exportRouter.cancelActiveExportProcesses === 'function') {
      exportRouter.cancelActiveExportProcesses();
    }
  } catch (_) { }
  try {
    const audioRouter = require('./src/backend/routes/audio');
    if (typeof audioRouter.cancelActiveBgmProcesses === 'function') {
      audioRouter.cancelActiveBgmProcesses();
    }
  } catch (_) { }
  try {
    const translationRouter = require('./src/backend/routes/translation');
    if (typeof translationRouter.cancelActiveSenseVoiceProcesses === 'function') {
      translationRouter.cancelActiveSenseVoiceProcesses();
    }
  } catch (_) { }
  try {
    const voiceCloner = require('./src/backend/utils/voice-cloner');
    if (typeof voiceCloner.cancelSeedVcInstall === 'function') {
      voiceCloner.cancelSeedVcInstall();
    }
  } catch (_) { }
  try {
    const configRouter = require('./src/backend/routes/config');
    if (typeof configRouter.flushUsageStats === 'function') {
      configRouter.flushUsageStats();
    }
    if (typeof configRouter.stopPublicInternetTunnel === 'function') {
      configRouter.stopPublicInternetTunnel();
    }
  } catch (_) { }
  if (backendServer) {
    try {
      backendServer.close(() => {
        console.log('⚡ Backend server closed');
      });
      if (typeof backendServer.closeAllConnections === 'function') {
        backendServer.closeAllConnections();
      }
    } catch (_) { }
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    shutdownBackendAndTunnels();
    app.quit();
  }
});

app.on('before-quit', () => {
  shutdownBackendAndTunnels();
});

function getDialogParentWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

// IPC Handlers for native dialogs
ipcMain.handle('open-folder-dialog', async (event, options) => {
  const win = getDialogParentWindow();
  const opts = { properties: ['openDirectory', 'createDirectory'] };
  const rawDefault = options && typeof options.defaultPath === 'string' ? options.defaultPath.trim() : '';
  if (rawDefault && path.isAbsolute(rawDefault) && fs.existsSync(rawDefault)) {
    opts.defaultPath = rawDefault;
  }
  if (win && typeof win.focus === 'function') {
    try { win.focus(); } catch (_) { }
  }
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);

  if (result.canceled) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('open-file-dialog', async (event, options) => {
  const win = getDialogParentWindow();
  const opts = { properties: ['openFile'], filters: options?.filters || [] };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);

  if (result.canceled) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('open-files-dialog', async (event, options) => {
  const win = getDialogParentWindow();
  const opts = { properties: ['openFile', 'multiSelections'], filters: options?.filters || [] };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);

  if (result.canceled) {
    return [];
  }

  return Array.isArray(result.filePaths) ? result.filePaths : [];
});

ipcMain.handle('save-file-dialog', async (event, options) => {
  const win = getDialogParentWindow();
  const opts = { defaultPath: options?.defaultPath || 'subtitle.srt', filters: options?.filters || [] };
  const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);

  if (result.canceled) {
    return null;
  }

  return result.filePath;
});

ipcMain.handle('gemini-key:save', (event, apiKey) => {
  assertGeminiKeyRequestIsFromMainFrame(event);
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 512) {
    throw new Error('Enter a valid Gemini API key.');
  }

  saveGeminiApiKey(apiKey.trim());
  return { success: true };
});

ipcMain.handle('gemini-key:remove', (event) => {
  assertGeminiKeyRequestIsFromMainFrame(event);
  const data = loadGeminiAccounts();
  if (data.activeAccountId) {
    data.accounts = data.accounts.filter(account => account.id !== data.activeAccountId);
    data.activeAccountId = data.accounts.length > 0 ? data.accounts[0].id : null;
    saveGeminiAccounts(data);
  } else if (fs.existsSync(geminiKeyPath)) {
    fs.unlinkSync(geminiKeyPath);
  }
  return { success: true };
});

ipcMain.handle('gemini-accounts:list', (event) => {
  assertGeminiKeyRequestIsFromMainFrame(event);
  return getSafeGeminiAccounts();
});

ipcMain.handle('gemini-accounts:add', (event, input) => {
  assertGeminiKeyRequestIsFromMainFrame(event);
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const email = typeof input?.email === 'string' ? input.email.trim() : '';
  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!name || name.length > 80 || email.length > 254 || apiKey.length < 20 || apiKey.length > 512) {
    throw new Error('Enter a valid account name and Gemini API key.');
  }

  const data = loadGeminiAccounts();
  if (data.accounts.some(account => account.apiKey === apiKey)) {
    throw new Error('This Gemini API key is already saved.');
  }
  const account = createGeminiAccount(name, email, apiKey);
  data.accounts.push(account);
  if (!data.activeAccountId) data.activeAccountId = account.id;
  saveGeminiAccounts(data);
  return getSafeGeminiAccounts(data);
});

ipcMain.handle('gemini-accounts:switch', (event, accountId) => {
  assertGeminiKeyRequestIsFromMainFrame(event);
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('Choose a Gemini account to switch to.');
  }

  const data = loadGeminiAccounts();
  const account = data.accounts.find(item => item.id === accountId);
  if (!account) throw new Error('Gemini account not found.');
  account.enabled = true;
  account.lastUsed = new Date().toISOString();
  data.activeAccountId = account.id;
  saveGeminiAccounts(data);
  return getSafeGeminiAccounts(data);
});

ipcMain.handle('gemini-accounts:batch-add', (event, input) => {
  assertGeminiKeyRequestIsFromMainFrame(event);
  const { parseGeminiBatchKeysInput } = require('./src/backend/routes/config');
  const rawText = typeof input?.rawText === 'string'
    ? input.rawText
    : (Array.isArray(input?.keys) ? input.keys.join('\n') : '');
  const data = loadGeminiAccounts();
  const { entries, invalidCount } = parseGeminiBatchKeysInput(rawText, data.accounts.length);
  if (entries.length === 0) {
    throw new Error('រកមិនឃើញ Gemini API Key ត្រឹមត្រូវទេ (យ៉ាងតិច ២០ តួអក្សរក្នុង ១ បន្ទាត់)។');
  }
  const existingKeys = new Set(data.accounts.map(a => a.apiKey));
  let addedCount = 0;
  let skippedCount = 0;
  for (const item of entries) {
    if (existingKeys.has(item.apiKey)) {
      skippedCount++;
      continue;
    }
    existingKeys.add(item.apiKey);
    const created = createGeminiAccount(item.name, item.email || '', item.apiKey);
    data.accounts.push(created);
    if (!data.activeAccountId) data.activeAccountId = created.id;
    addedCount++;
  }
  saveGeminiAccounts(data);
  return { addedCount, skippedCount, invalidCount, ...getSafeGeminiAccounts(data) };
});

ipcMain.handle('gemini-accounts:update', (event, accountId, updates) => {
  assertGeminiKeyRequestIsFromMainFrame(event);
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw new Error('Choose a Gemini account to update.');
  }
  const safeUpdates = updates && typeof updates === 'object' ? updates : {};
  const data = loadGeminiAccounts();
  const target = data.accounts.find(item => item.id === accountId.trim());
  if (!target) throw new Error('Gemini account not found.');

  if (typeof safeUpdates.name === 'string') {
    const cleanName = safeUpdates.name.trim();
    if (!cleanName || cleanName.length > 80) {
      throw new Error('Enter a valid account name (1-80 characters).');
    }
    target.name = cleanName;
  }
  if (typeof safeUpdates.email === 'string') {
    const cleanEmail = safeUpdates.email.trim();
    if (cleanEmail.length > 254 || (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))) {
      throw new Error('Enter a valid email address.');
    }
    target.email = cleanEmail;
  }
  if (typeof safeUpdates.apiKey === 'string' && safeUpdates.apiKey.trim()) {
    const cleanKey = safeUpdates.apiKey.trim();
    if (cleanKey.length < 20 || cleanKey.length > 512) {
      throw new Error('Enter a valid Gemini API key.');
    }
    if (data.accounts.some(acc => acc.id !== target.id && acc.apiKey === cleanKey)) {
      throw new Error('This Gemini API key is already saved under another account.');
    }
    target.apiKey = cleanKey;
  }

  if (typeof safeUpdates.enabled === 'boolean') {
    target.enabled = safeUpdates.enabled;
    if (!target.enabled && data.activeAccountId === target.id) {
      const nextEnabled = data.accounts.find(acc => acc.id !== target.id && acc.enabled !== false);
      data.activeAccountId = nextEnabled ? nextEnabled.id : null;
    } else if (target.enabled && !data.activeAccountId) {
      data.activeAccountId = target.id;
    }
  }

  saveGeminiAccounts(data);
  return getSafeGeminiAccounts(data);
});

ipcMain.handle('gemini-accounts:delete', (event, accountId) => {
  assertGeminiKeyRequestIsFromMainFrame(event);
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('Choose a Gemini account to delete.');
  }

  const data = loadGeminiAccounts();
  const accountIndex = data.accounts.findIndex(item => item.id === accountId);
  if (accountIndex === -1) throw new Error('Gemini account not found.');
  data.accounts.splice(accountIndex, 1);
  if (data.activeAccountId === accountId) {
    data.activeAccountId = data.accounts.length > 0 ? data.accounts[0].id : null;
  }
  saveGeminiAccounts(data);
  return getSafeGeminiAccounts(data);
});

ipcMain.handle('support:open-external', async (event, targetUrl) => {
  assertGeminiKeyRequestIsFromMainFrame(event);
  const raw = typeof targetUrl === 'string' ? targetUrl.trim() : '';
  if (!raw || raw.length > 1000) {
    throw new Error('Invalid support URL.');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error('Invalid support URL.');
  }
  if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
    throw new Error('Blocked unsupported URL protocol.');
  }
  await shell.openExternal(parsed.toString());
  return { success: true };
});

ipcMain.handle('support:reveal-logs', (event) => {
  assertGeminiKeyRequestIsFromMainFrame(event);
  const logFile = logger.getLogFilePath();
  if (fs.existsSync(logFile)) {
    shell.showItemInFolder(logFile);
    return { success: true, path: logFile };
  }
  shell.openPath(logger.getLogDir());
  return { success: true, path: logger.getLogDir() };
});

ipcMain.handle('export:open-folder', async (event, targetPath) => {
  assertGeminiKeyRequestIsFromMainFrame(event);
  const defaultExport = process.env.EXPORT_DIR || path.join(__dirname, 'Exported');
  const raw = typeof targetPath === 'string' && targetPath.trim() ? targetPath.trim() : defaultExport;
  let resolved = path.resolve(raw);
  if (!fs.existsSync(resolved)) {
    if (!targetPath || !String(targetPath).trim()) {
      fs.mkdirSync(resolved, { recursive: true });
    } else {
      const parent = path.dirname(resolved);
      if (fs.existsSync(parent)) resolved = parent;
    }
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    shell.showItemInFolder(resolved);
    return { success: true, openedPath: resolved };
  }
  const errStr = await shell.openPath(resolved);
  if (errStr) throw new Error(errStr);
  return { success: true, openedPath: resolved };
});

console.log('⚡ EZA PRO - Electron app initialized');
