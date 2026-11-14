/**
 * ⚡ EZA PRO - Electron Main Process
 * Desktop Application Entry Point
 */

const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const express = require('express');

// Import backend server
const backendApp = express();

let mainWindow;
let backendServer;
let backendPort;
const geminiKeyPath = path.join(app.getPath('userData'), 'gemini-api-key.bin');
const geminiAccountsPath = path.join(app.getPath('userData'), 'gemini-accounts.bin');
const legacyGeminiAccountsPath = path.join(__dirname, 'accounts.json');

function loadGeminiAccounts() {
  if (!fs.existsSync(geminiAccountsPath)) {
    return { accounts: [], activeAccountId: null };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure system storage is unavailable. Cannot read Gemini accounts.');
  }

  const encrypted = fs.readFileSync(geminiAccountsPath);
  const data = JSON.parse(safeStorage.decryptString(encrypted));
  if (!data || !Array.isArray(data.accounts) ||
      !(data.activeAccountId === null || typeof data.activeAccountId === 'string') ||
      data.accounts.some(account => !account ||
        typeof account.id !== 'string' ||
        typeof account.name !== 'string' ||
        typeof account.email !== 'string' ||
        typeof account.apiKey !== 'string')) {
    throw new Error('Saved Gemini account data is invalid.');
  }
  if (data.activeAccountId !== null && !data.accounts.some(account => account.id === data.activeAccountId)) {
    throw new Error('Saved active Gemini account is missing.');
  }
  try {
    const configRouter = require('./src/backend/routes/config');
    if (typeof configRouter.syncAccountsFromDesktop === 'function') {
      configRouter.syncAccountsFromDesktop(data);
    }
  } catch (_) {}
  return data;
}

function saveGeminiAccounts(data) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure system storage is unavailable. Cannot save Gemini accounts safely.');
  }

  fs.mkdirSync(path.dirname(geminiAccountsPath), { recursive: true });
  const temporaryPath = `${geminiAccountsPath}.tmp`;
  fs.writeFileSync(temporaryPath, safeStorage.encryptString(JSON.stringify(data)), { mode: 0o600 });
  fs.renameSync(temporaryPath, geminiAccountsPath);
  try {
    const configRouter = require('./src/backend/routes/config');
    if (typeof configRouter.syncAccountsFromDesktop === 'function') {
      configRouter.syncAccountsFromDesktop(data);
    }
  } catch (_) {}
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
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    hasConfigKey = Object.prototype.hasOwnProperty.call(config, 'GEMINI_API_KEY');
    configKey = typeof config.GEMINI_API_KEY === 'string' ? config.GEMINI_API_KEY.trim() : '';
  }

  if (fs.existsSync(envPath)) {
    envContents = fs.readFileSync(envPath, 'utf8');
    const match = envContents.match(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*?)\s*$/m);
    hasEnvKey = !!match;
    envKey = match ? match[1].replace(/^(['"])(.*)\1$/, '$2').trim() : '';
  }

  const existingKey = getGeminiApiKey();
  const processKey = typeof process.env.GEMINI_API_KEY === 'string'
    ? process.env.GEMINI_API_KEY.trim()
    : '';
  const legacyKey = processKey || envKey || configKey;
  if (!existingKey && legacyKey) saveGeminiApiKey(legacyKey);

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
  const data = loadGeminiAccounts();
  if (data.accounts.length > 0 || !fs.existsSync(geminiKeyPath)) return;

  const apiKey = safeStorage.decryptString(fs.readFileSync(geminiKeyPath));
  if (!apiKey) return;

  const account = createGeminiAccount('Gemini Account', '', apiKey);
  saveGeminiAccounts({ accounts: [account], activeAccountId: account.id });
  fs.unlinkSync(geminiKeyPath);
}

function migrateLegacyGeminiAccountsFile() {
  if (!fs.existsSync(legacyGeminiAccountsPath)) return;

  const legacyData = JSON.parse(fs.readFileSync(legacyGeminiAccountsPath, 'utf8'));
  if (!legacyData || !Array.isArray(legacyData.accounts)) {
    throw new Error('Legacy Gemini accounts file has an invalid format.');
  }

  const data = loadGeminiAccounts();
  const hadAccounts = data.accounts.length > 0;
  const accountIds = new Set(data.accounts.map(account => account.id));
  const accountsByKey = new Map(data.accounts.map(account => [account.apiKey, account]));
  const migratedIds = new Map();

  legacyData.accounts.forEach(legacyAccount => {
    const name = typeof legacyAccount?.name === 'string' ? legacyAccount.name.trim() : '';
    const email = typeof legacyAccount?.email === 'string' ? legacyAccount.email.trim() : '';
    const apiKey = typeof legacyAccount?.apiKey === 'string' ? legacyAccount.apiKey.trim() : '';
    if (!name || name.length > 80 || email.length > 254 || apiKey.length < 20 || apiKey.length > 512) {
      throw new Error('Legacy Gemini accounts file contains invalid account data.');
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

  saveGeminiAccounts(data);
  fs.unlinkSync(legacyGeminiAccountsPath);
}

function assertGeminiKeyRequestIsFromMainFrame(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame ||
      event.senderFrame.url !== pathToFileURL(path.join(__dirname, 'src', 'frontend', 'index.html')).href) {
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
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
  backendApp.use('/cloned_voices', (req, res, next) => express.static(voiceCloner.getClonedVoicesDir())(req, res, next));
  
  // Setup API routes using Express Router
  const { setupRoutes } = require('./src/backend/routes');
  setupRoutes(backendApp);
  
  // Start backend on random available port
  return new Promise((resolve, reject) => {
    backendServer = backendApp.listen(0, '127.0.0.1', () => {
      backendServer.requestTimeout = 0;
      backendPort = backendServer.address().port;
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
  mainWindow.loadFile(path.join(__dirname, 'src', 'frontend', 'index.html'));

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
  mainWindow.webContents.once('did-finish-load', bringToFront);

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

function configurePackagedPaths() {
  if (!app.isPackaged) return;
  const userDataDir = app.getPath('userData');
  let videosBaseDir = userDataDir;
  try {
    videosBaseDir = app.getPath('videos') || userDataDir;
  } catch (_) {}

  process.env.EZA_PACKAGED_CLIENT = '1';
  process.env.EZA_USER_DATA_DIR = process.env.EZA_USER_DATA_DIR || userDataDir;
  process.env.EZA_CONFIG_FILE = process.env.EZA_CONFIG_FILE || path.join(userDataDir, 'config.json');
  process.env.GEMINI_ACCOUNTS_FILE = process.env.GEMINI_ACCOUNTS_FILE || path.join(userDataDir, 'gemini-accounts.json');
  process.env.AUDIO_CACHE_DIR = process.env.AUDIO_CACHE_DIR || path.join(userDataDir, 'audio_cache');
  process.env.BGM_CACHE_DIR = process.env.BGM_CACHE_DIR || path.join(userDataDir, 'bgm_cache');
  process.env.TRANSLATION_CACHE_DIR = process.env.TRANSLATION_CACHE_DIR || path.join(userDataDir, 'translation_cache');
  process.env.DRAFTS_DIR = process.env.DRAFTS_DIR || path.join(userDataDir, 'drafts');
  process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(userDataDir, 'uploads');
  process.env.CLONED_VOICES_DIR = process.env.CLONED_VOICES_DIR || path.join(userDataDir, 'cloned_voices');
  process.env.VOICE_CLONE_ENGINE_DIR = process.env.VOICE_CLONE_ENGINE_DIR || userDataDir;
  process.env.EXPORT_DIR = process.env.EXPORT_DIR || path.join(videosBaseDir, 'EZA PRO Exported');
}

// App lifecycle
app.whenReady().then(async () => {
  console.log('⚡ EZA PRO starting...');
  configurePackagedPaths();

  migrateLegacyGeminiAccount();
  migrateLegacyGeminiAccountsFile();
  migrateLegacyGeminiKey();

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
  console.error('⚡ EZA PRO failed to start:', err);
  dialog.showErrorBox('EZA PRO startup failed', err.message);
  app.quit();
});

app.on('window-all-closed', () => {
  // Close backend server
  if (backendServer) {
    backendServer.close(() => {
      console.log('⚡ Backend server closed');
    });
  }
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (backendServer) {
    backendServer.close();
  }
});

// IPC Handlers for native dialogs
ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  
  if (result.canceled) {
    return null;
  }
  
  return result.filePaths[0];
});

ipcMain.handle('open-file-dialog', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: options?.filters || []
  });
  
  if (result.canceled) {
    return null;
  }
  
  return result.filePaths[0];
});

ipcMain.handle('open-files-dialog', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: options?.filters || []
  });

  if (result.canceled) {
    return [];
  }

  return Array.isArray(result.filePaths) ? result.filePaths : [];
});

ipcMain.handle('save-file-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: options?.defaultPath || 'subtitle.srt',
    filters: options?.filters || []
  });
  
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

// Handle app updates (future)
// Can integrate electron-updater here

console.log('⚡ EZA PRO - Electron app initialized');
