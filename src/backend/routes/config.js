/**
 * ⚡ EZA PRO - Configuration Routes
 * Handle app settings and API keys
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const cloudLicense = require('../utils/cloud-license');

const CONFIG_FILE = path.join(__dirname, '..', '..', '..', 'config.json');

function getConfigFilePath() {
  return process.env.EZA_CONFIG_FILE || CONFIG_FILE;
}

function getAccountsFilePath() {
  return process.env.GEMINI_ACCOUNTS_FILE || path.join(__dirname, '..', '..', '..', '.gemini-accounts.json');
}

let cachedVaultKey = null;
let cachedVaultKeySecret = '';

function getVaultKey() {
  let user = 'default';
  try {
    user = os.userInfo().username || 'default';
  } catch (_) {}
  const secret = `${os.hostname()}:${user}:eza-pro-gemini-vault-v1`;
  if (cachedVaultKey && cachedVaultKeySecret === secret) {
    return cachedVaultKey;
  }
  cachedVaultKeySecret = secret;
  cachedVaultKey = crypto.scryptSync(secret, 'eza-pro-salt-v1', 32);
  return cachedVaultKey;
}

function encryptSecret(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getVaultKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(payload) {
  if (typeof payload !== 'string' || !payload.includes(':')) return '';
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', getVaultKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

let cachedAccountsStore = null;

function cloneAccountsStore(store) {
  return {
    activeAccountId: store.activeAccountId || null,
    accounts: (store.accounts || []).map(acc => ({ ...acc }))
  };
}

function loadGeminiAccountsStore() {
  const filePath = getAccountsFilePath();
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    cachedAccountsStore = null;
    return { accounts: [], activeAccountId: null };
  }
  if (
    cachedAccountsStore &&
    cachedAccountsStore.filePath === filePath &&
    cachedAccountsStore.mtimeMs === stat.mtimeMs &&
    cachedAccountsStore.size === stat.size
  ) {
    return cloneAccountsStore(cachedAccountsStore.store);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || !Array.isArray(raw.accounts)) {
      cachedAccountsStore = null;
      return { accounts: [], activeAccountId: null };
    }
    const accounts = [];
    for (const item of raw.accounts) {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') continue;
      let apiKey = '';
      if (typeof item.encryptedKey === 'string') {
        try {
          apiKey = decryptSecret(item.encryptedKey);
        } catch (_) {}
      } else if (typeof item.apiKey === 'string') {
        apiKey = item.apiKey;
      }
      if (!apiKey) continue;
      accounts.push({
        id: item.id,
        name: item.name,
        email: typeof item.email === 'string' ? item.email : '',
        apiKey,
        enabled: item.enabled !== false,
        requestCount: Number(item.requestCount) || 0,
        createdAt: item.createdAt || null,
        lastUsed: item.lastUsed || null
      });
    }
    let activeAccountId = typeof raw.activeAccountId === 'string' ? raw.activeAccountId : null;
    if (activeAccountId && !accounts.some(acc => acc.id === activeAccountId)) {
      activeAccountId = accounts.length > 0 ? accounts[0].id : null;
    }
    if (!activeAccountId && accounts.length > 0) {
      activeAccountId = accounts[0].id;
    }
    const parsedStore = { accounts, activeAccountId };
    cachedAccountsStore = {
      filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      store: cloneAccountsStore(parsedStore)
    };
    return parsedStore;
  } catch (_) {
    cachedAccountsStore = null;
    return { accounts: [], activeAccountId: null };
  }
}

function renameSyncWithWindowsRetry(srcPath, destPath) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(srcPath, destPath);
      return;
    } catch (err) {
      if ((err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') || attempt === 4) {
        throw err;
      }
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, 25 * (attempt + 1));
    }
  }
}

function saveGeminiAccountsStore(data) {
  const filePath = getAccountsFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const serialized = {
    activeAccountId: data.activeAccountId || null,
    accounts: (data.accounts || []).map(acc => ({
      id: acc.id,
      name: acc.name,
      email: acc.email || '',
      encryptedKey: encryptSecret(acc.apiKey),
      enabled: acc.enabled !== false,
      requestCount: Number(acc.requestCount) || 0,
      createdAt: acc.createdAt || new Date().toISOString(),
      lastUsed: acc.lastUsed || null
    }))
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(serialized, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSyncWithWindowsRetry(tmpPath, filePath);
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
  }
  cachedAccountsStore = null;
}

const STREAM_VISUAL_HOLD_MS = 2800;
const ERROR_PENALTY_TTL_MS = 20000;
const geminiTelemetryByHash = new Map();
let usageFlushTimer = null;
const pendingUsageByHash = new Map();

function hashApiKeyForTelemetry(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return '';
  return crypto.createHash('sha256').update(apiKey.trim()).digest('hex');
}

function scheduleUsageFlush() {
  if (usageFlushTimer) return;
  usageFlushTimer = setTimeout(() => {
    usageFlushTimer = null;
    if (pendingUsageByHash.size === 0) return;
    const flushedSnapshot = new Map(pendingUsageByHash);
    try {
      const store = loadGeminiAccountsStore();
      if (!store.accounts.length) {
        for (const k of flushedSnapshot.keys()) pendingUsageByHash.delete(k);
        return;
      }
      let dirty = false;
      for (const acc of store.accounts) {
        const keyHash = hashApiKeyForTelemetry(acc.apiKey);
        const delta = flushedSnapshot.get(keyHash);
        if (delta) {
          acc.requestCount = (Number(acc.requestCount) || 0) + delta;
          acc.lastUsed = new Date().toISOString();
          dirty = true;
        }
      }
      if (dirty) saveGeminiAccountsStore(store);
      for (const [k, delta] of flushedSnapshot.entries()) {
        const current = pendingUsageByHash.get(k) || 0;
        if (current <= delta) pendingUsageByHash.delete(k);
        else pendingUsageByHash.set(k, current - delta);
      }
    } catch (_) {}
  }, 1500);
  if (typeof usageFlushTimer.unref === 'function') {
    usageFlushTimer.unref();
  }
}

function flushUsageStats() {
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer);
    usageFlushTimer = null;
  }
  if (pendingUsageByHash.size === 0) return;
  try {
    const store = loadGeminiAccountsStore();
    let dirty = false;
    for (const acc of store.accounts) {
      const keyHash = hashApiKeyForTelemetry(acc.apiKey);
      const delta = pendingUsageByHash.get(keyHash);
      if (delta) {
        acc.requestCount = (Number(acc.requestCount) || 0) + delta;
        acc.lastUsed = new Date().toISOString();
        dirty = true;
      }
    }
    pendingUsageByHash.clear();
    if (dirty) saveGeminiAccountsStore(store);
  } catch (_) {}
}

function beginGeminiStream(apiKey, taskLabel = 'Gemini API', options = {}) {
  const keyHash = hashApiKeyForTelemetry(apiKey);
  if (!keyHash) {
    return { end() {} };
  }
  const now = Date.now();
  const entry = geminiTelemetryByHash.get(keyHash) || {
    activeCount: 0,
    totalRequests: 0,
    recentUntil: 0,
    lastTask: '',
    lastStatus: 'ready',
    lastLatencyMs: null,
    lastErrorAt: 0
  };
  entry.activeCount += 1;
  if (!options.skipUsageIncrement) {
    entry.totalRequests += 1;
    pendingUsageByHash.set(keyHash, (pendingUsageByHash.get(keyHash) || 0) + 1);
    scheduleUsageFlush();
  }
  entry.recentUntil = now + STREAM_VISUAL_HOLD_MS;
  entry.lastTask = String(taskLabel || 'Gemini API');
  entry.lastStatus = 'streaming';
  geminiTelemetryByHash.set(keyHash, entry);

  let ended = false;
  return {
    end(ok = true, statusCode = 200) {
      if (ended) return;
      ended = true;
      const cur = geminiTelemetryByHash.get(keyHash);
      if (!cur) return;
      cur.activeCount = Math.max(0, cur.activeCount - 1);
      const lat = Math.max(1, Date.now() - now);
      cur.lastLatencyMs = lat;
      if (ok) {
        cur.ewmaLatencyMs = cur.ewmaLatencyMs
          ? Math.round(cur.ewmaLatencyMs * 0.65 + lat * 0.35)
          : lat;
        cur.lastErrorAt = 0;
      } else {
        cur.lastErrorAt = Date.now();
      }
      cur.recentUntil = Date.now() + STREAM_VISUAL_HOLD_MS;
      if (!ok) {
        cur.lastStatus = statusCode === 429 ? 'rate_limited' : 'error';
      } else {
        cur.lastStatus = cur.activeCount > 0 ? 'streaming' : 'ready';
      }
    }
  };
}

function getKeyMaxCooldownRemainingMs(apiKey) {
  const keyHash = hashApiKeyForTelemetry(apiKey);
  if (!keyHash) return 0;
  const now = Date.now();
  let maxRemaining = 0;
  const suffix = `::${keyHash}`;
  for (const [mapKey, until] of geminiKeyCooldownByScope.entries()) {
    if (!mapKey.endsWith(suffix)) continue;
    if (until <= now) {
      geminiKeyCooldownByScope.delete(mapKey);
    } else {
      maxRemaining = Math.max(maxRemaining, until - now);
    }
  }
  return maxRemaining;
}

function clearGeminiAccountCooldowns(accountId = '') {
  const data = loadGeminiAccountsStore();
  const targetAccounts = accountId
    ? data.accounts.filter(acc => acc.id === String(accountId).trim())
    : data.accounts;
  const targetHashes = new Set(targetAccounts.map(acc => hashApiKeyForTelemetry(acc.apiKey)).filter(Boolean));
  for (const mapKey of Array.from(geminiKeyCooldownByScope.keys())) {
    const hash = mapKey.split('::')[1] || '';
    if (!accountId || targetHashes.has(hash)) {
      geminiKeyCooldownByScope.delete(mapKey);
    }
  }
  for (const hash of targetHashes) {
    const tel = geminiTelemetryByHash.get(hash);
    if (tel && (tel.lastStatus === 'rate_limited' || tel.lastStatus === 'error')) {
      tel.lastStatus = 'ready';
    }
  }
  return getSafeGeminiAccounts(data);
}

function getSafeGeminiAccounts(data = loadGeminiAccountsStore()) {
  const now = Date.now();
  let streamingCount = 0;
  const accounts = data.accounts.map(account => {
    const keyHash = hashApiKeyForTelemetry(account.apiKey);
    const tel = geminiTelemetryByHash.get(keyHash);
    const persistedCount = Number(account.requestCount) || 0;
    const pendingDelta = pendingUsageByHash.get(keyHash) || 0;
    const isStreaming = Boolean(tel && (tel.activeCount > 0 || tel.recentUntil > now));
    const cooldownRemainingMs = getKeyMaxCooldownRemainingMs(account.apiKey);
    if (isStreaming) streamingCount++;
    return {
      id: account.id,
      name: account.name,
      email: account.email || '',
      keyHint: account.apiKey.length >= 12
        ? `${account.apiKey.slice(0, 8)}...${account.apiKey.slice(-4)}`
        : '••••••••',
      isActive: account.id === data.activeAccountId,
      enabled: account.enabled !== false,
      isStreaming,
      activeTask: (isStreaming && tel && tel.lastTask) ? tel.lastTask : '',
      lastStatus: (tel && tel.activeCount > 0)
        ? 'streaming'
        : (cooldownRemainingMs > 0 ? 'rate_limited' : ((tel && tel.lastStatus) || 'ready')),
      lastLatencyMs: (tel && tel.lastLatencyMs) || null,
      ewmaLatencyMs: (tel && tel.ewmaLatencyMs) || null,
      cooldownRemainingMs,
      requestCount: Math.max(persistedCount + pendingDelta, tel ? tel.totalRequests : 0),
      createdAt: account.createdAt || null,
      lastUsed: account.lastUsed || null
    };
  });
  return {
    activeAccountId: data.activeAccountId,
    streamingCount,
    accounts
  };
}

const geminiKeyCooldownByScope = new Map();
let smartRouterCursor = 0;

function getCooldownMapKey(apiKey, scope = 'general') {
  const keyHash = hashApiKeyForTelemetry(apiKey);
  if (!keyHash) return '';
  return `${String(scope || 'general')}::${keyHash}`;
}

function isGeminiKeyRateLimited(apiKey, scope = 'general') {
  const k = getCooldownMapKey(apiKey, scope);
  if (!k) return false;
  const now = Date.now();
  const until = geminiKeyCooldownByScope.get(k) || 0;
  if (until > now) return true;
  if (until > 0) geminiKeyCooldownByScope.delete(k);

  // If checking a specific scope, also respect active global/general cooldowns
  if (scope && scope !== 'general') {
    const genKey = getCooldownMapKey(apiKey, 'general');
    const genUntil = geminiKeyCooldownByScope.get(genKey) || 0;
    if (genUntil > now) return true;
    if (genUntil > 0) geminiKeyCooldownByScope.delete(genKey);
  }
  return false;
}

function markGeminiKeyRateLimited(apiKey, durationMs = 60000, scope = 'general') {
  const k = getCooldownMapKey(apiKey, scope);
  if (!k) return;
  const safeMs = Math.max(1000, Number(durationMs) || 60000);
  geminiKeyCooldownByScope.set(k, Date.now() + safeMs);
  const keyHash = hashApiKeyForTelemetry(apiKey);
  const cur = geminiTelemetryByHash.get(keyHash);
  if (cur) {
    cur.lastStatus = 'rate_limited';
  }
}

function markGeminiKeyHealthy(apiKey, scope = 'general') {
  const k = getCooldownMapKey(apiKey, scope);
  if (k) geminiKeyCooldownByScope.delete(k);
  const keyHash = hashApiKeyForTelemetry(apiKey);
  const tel = keyHash ? geminiTelemetryByHash.get(keyHash) : null;
  if (tel && (tel.lastStatus === 'rate_limited' || tel.lastStatus === 'error')) {
    tel.lastStatus = tel.activeCount > 0 ? 'streaming' : 'ready';
    tel.lastErrorAt = 0;
  }
}

/**
 * Return smartly load-balanced Gemini API key candidates across saved Router Management accounts:
 * skips cooled-down/rate-limited accounts, spreads concurrent load across idle accounts first
 * (least-activeCount + round-robin cursor), and avoids slow/lagging accounts when healthy alternatives exist.
 */
function getGeminiApiKeyCandidates(primaryKey = '', scope = 'general', options = {}) {
  const data = loadGeminiAccountsStore();
  const disabledKeys = new Set(
    data.accounts
      .filter(acc => acc && acc.enabled === false && typeof acc.apiKey === 'string')
      .map(acc => acc.apiKey.trim())
  );
  const ordered = [];
  const seen = new Set();
  const pushUnique = (k, ignoreDisabled = false) => {
    const clean = typeof k === 'string' ? k.trim() : '';
    if (!clean || seen.has(clean)) return;
    if (!ignoreDisabled && disabledKeys.has(clean)) return;
    seen.add(clean);
    ordered.push(clean);
  };

  if (primaryKey) pushUnique(primaryKey);
  const active = data.accounts.find(acc => acc.id === data.activeAccountId && acc.enabled !== false);
  if (active) pushUnique(active.apiKey);
  for (const acc of data.accounts) {
    if (acc.enabled !== false) pushUnique(acc.apiKey);
  }
  if (process.env.GEMINI_API_KEY && process.env.EZA_PACKAGED !== '1') {
    pushUnique(process.env.GEMINI_API_KEY);
  }

  const healthy = ordered.filter(k => !isGeminiKeyRateLimited(k, scope));
  if (healthy.length === 0) {
    if (options.skipAllRateLimited) return [];
    // Sort cooled-down keys by soonest-expiring cooldown so retries pick the earliest key to recover
    return ordered
      .map((key, idx) => ({
        key,
        idx,
        until: geminiKeyCooldownByScope.get(getCooldownMapKey(key, scope)) || 0
      }))
      .sort((a, b) => (a.until - b.until) || (a.idx - b.idx))
      .map(item => item.key);
  }
  if (healthy.length === 1 || options.preferPrimary) return healthy;

  // Smart load-balancing: rotate starting position and prefer idle + lower-latency accounts first
  const offset = smartRouterCursor % healthy.length;
  if (options.advanceCursor !== false) {
    smartRouterCursor = (smartRouterCursor + 1) % 1000000;
  }
  const rotated = healthy.slice(offset).concat(healthy.slice(0, offset));
  const now = Date.now();

  return rotated
    .map((key, idx) => {
      const tel = geminiTelemetryByHash.get(hashApiKeyForTelemetry(key));
      const activeCount = tel ? (tel.activeCount || 0) : 0;
      const ewma = tel && tel.ewmaLatencyMs ? tel.ewmaLatencyMs : 0;
      const slowPenalty = ewma > 9000 ? 1 : 0;
      const recentErrPenalty = (tel && tel.lastStatus === 'error' && (now - (tel.lastErrorAt || 0)) < ERROR_PENALTY_TTL_MS) ? 1 : 0;
      return { key, idx, activeCount, slowPenalty, recentErrPenalty };
    })
    .sort((a, b) =>
      (a.activeCount - b.activeCount) ||
      (a.recentErrPenalty - b.recentErrPenalty) ||
      (a.slowPenalty - b.slowPenalty) ||
      (a.idx - b.idx)
    )
    .map(item => item.key);
}

function getActiveGeminiApiKey() {
  const data = loadGeminiAccountsStore();
  if (!data.accounts.length) return '';
  const active = data.accounts.find(acc => acc.id === data.activeAccountId && acc.enabled !== false)
    || data.accounts.find(acc => acc.enabled !== false)
    || null;
  return active ? active.apiKey : '';
}

function addGeminiAccountRecord(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const email = typeof input?.email === 'string' ? input.email.trim() : '';
  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!name || name.length > 80 || email.length > 254 || apiKey.length < 20 || apiKey.length > 512) {
    throw new Error('សូមបញ្ចូលឈ្មោះ Account និង Gemini API Key ឲ្យបានត្រឹមត្រូវ។');
  }

  const data = loadGeminiAccountsStore();
  const existing = data.accounts.find(acc => acc.apiKey === apiKey);
  if (existing) {
    existing.name = name;
    existing.email = email;
    existing.lastUsed = new Date().toISOString();
    data.activeAccountId = existing.id;
    saveGeminiAccountsStore(data);
    return getSafeGeminiAccounts(data);
  }

  const account = {
    id: `gemini_${crypto.randomUUID()}`,
    name,
    email,
    apiKey,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastUsed: new Date().toISOString()
  };
  data.accounts.push(account);
  data.activeAccountId = account.id;
  saveGeminiAccountsStore(data);
  return getSafeGeminiAccounts(data);
}

function switchGeminiAccountRecord(accountId) {
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw new Error('សូមជ្រើសរើស Gemini account ដើម្បីប្ដូរ។');
  }
  const data = loadGeminiAccountsStore();
  const account = data.accounts.find(item => item.id === accountId.trim());
  if (!account) {
    throw new Error('រកមិនឃើញ Gemini account នេះទេ។');
  }
  account.enabled = true;
  account.lastUsed = new Date().toISOString();
  data.activeAccountId = account.id;
  saveGeminiAccountsStore(data);
  return getSafeGeminiAccounts(data);
}

function deleteGeminiAccountRecord(accountId) {
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw new Error('សូមជ្រើសរើស Gemini account ដើម្បីលុប។');
  }
  const data = loadGeminiAccountsStore();
  const idx = data.accounts.findIndex(item => item.id === accountId.trim());
  if (idx === -1) {
    throw new Error('រកមិនឃើញ Gemini account នេះទេ។');
  }
  const [removed] = data.accounts.splice(idx, 1);
  if (data.activeAccountId === accountId.trim()) {
    data.activeAccountId = data.accounts.length > 0 ? data.accounts[0].id : null;
  }
  saveGeminiAccountsStore(data);
  const removedHash = removed ? hashApiKeyForTelemetry(removed.apiKey) : '';
  if (removedHash && !data.accounts.some(acc => hashApiKeyForTelemetry(acc.apiKey) === removedHash)) {
    geminiTelemetryByHash.delete(removedHash);
    pendingUsageByHash.delete(removedHash);
    const suffix = `::${removedHash}`;
    for (const mapKey of Array.from(geminiKeyCooldownByScope.keys())) {
      if (mapKey.endsWith(suffix)) geminiKeyCooldownByScope.delete(mapKey);
    }
  }
  return getSafeGeminiAccounts(data);
}

function saveGeminiApiKeyRecord(apiKey) {
  const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!trimmed || trimmed.length < 20 || trimmed.length > 512) {
    throw new Error('សូមបញ្ចូល Gemini API Key ឲ្យបានត្រឹមត្រូវ។');
  }
  const data = loadGeminiAccountsStore();
  const existingByKey = data.accounts.find(acc => acc.apiKey === trimmed);
  if (existingByKey) {
    data.activeAccountId = existingByKey.id;
    existingByKey.lastUsed = new Date().toISOString();
    saveGeminiAccountsStore(data);
    return getSafeGeminiAccounts(data);
  }
  const active = data.accounts.find(acc => acc.id === data.activeAccountId);
  if (active) {
    active.apiKey = trimmed;
    active.lastUsed = new Date().toISOString();
  } else {
    const account = {
      id: `gemini_${crypto.randomUUID()}`,
      name: 'Gemini Account',
      email: '',
      apiKey: trimmed,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString()
    };
    data.accounts.push(account);
    data.activeAccountId = account.id;
  }
  saveGeminiAccountsStore(data);
  return getSafeGeminiAccounts(data);
}

function updateGeminiAccountRecord(accountId, input = {}) {
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw new Error('សូមជ្រើសរើស Gemini account ដើម្បីកែសម្រួល។');
  }
  const data = loadGeminiAccountsStore();
  const account = data.accounts.find(item => item.id === accountId.trim());
  if (!account) {
    throw new Error('រកមិនឃើញ Gemini account នេះទេ។');
  }
  const name = typeof input.name === 'string' ? input.name.trim() : account.name;
  const email = typeof input.email === 'string' ? input.email.trim() : (account.email || '');
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!name || name.length > 80 || email.length > 254) {
    throw new Error('សូមបញ្ចូលឈ្មោះ Account និង Email ឲ្យបានត្រឹមត្រូវ។');
  }
  if (apiKey && (apiKey.length < 20 || apiKey.length > 512)) {
    throw new Error('Gemini API Key មិនត្រឹមត្រូវទេ។');
  }
  if (apiKey && data.accounts.some(item => item.id !== account.id && item.apiKey === apiKey)) {
    throw new Error('Gemini API Key នេះមានរួចហើយនៅក្នុង Router Account ផ្សេង។');
  }
  account.name = name;
  account.email = email;
  if (typeof input.enabled === 'boolean') {
    account.enabled = input.enabled;
    if (!account.enabled && data.activeAccountId === account.id) {
      const nextEnabled = data.accounts.find(item => item.id !== account.id && item.enabled !== false);
      data.activeAccountId = nextEnabled ? nextEnabled.id : null;
    } else if (account.enabled && !data.activeAccountId) {
      data.activeAccountId = account.id;
    }
  }
  if (apiKey) account.apiKey = apiKey;
  saveGeminiAccountsStore(data);
  return getSafeGeminiAccounts(data);
}

function parseGeminiBatchKeysInput(rawText, existingCount = 0) {
  const lines = String(rawText || '').split(/\r?\n/);
  const parsed = [];
  const seenKeys = new Set();
  let invalidCount = 0;
  let duplicateCount = 0;
  let seq = existingCount;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    let name = '';
    let email = '';
    let apiKey = '';

    if (trimmed.includes('|')) {
      const parts = trimmed.split('|').map(s => s.trim()).filter(Boolean);
      let keyIdx = parts.findIndex(p => /^(AIza|AQ\.)/i.test(p));
      if (keyIdx === -1) {
        keyIdx = parts.findIndex(p => p.length >= 20 && !/@/.test(p) && !/\s/.test(p));
      }
      if (keyIdx !== -1) {
        apiKey = parts[keyIdx];
        const meta = parts.filter((_, idx) => idx !== keyIdx);
        for (const m of meta) {
          if (!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m)) email = m;
          else if (!name) name = m.slice(0, 80);
        }
      }
    } else {
      const tokenMatch = trimmed.match(/(AIza[0-9A-Za-z\-_]{16,}|AQ\.[0-9A-Za-z\-_.]{16,})/);
      if (tokenMatch) {
        apiKey = tokenMatch[1].trim();
        const before = trimmed.slice(0, tokenMatch.index).replace(/[:=,\-\s]+$/, '').trim();
        if (before) name = before.slice(0, 80);
      } else if (!/\s/.test(trimmed) && trimmed.length >= 20 && trimmed.length <= 512) {
        apiKey = trimmed;
      }
    }

    if (!apiKey || apiKey.length < 20 || apiKey.length > 512) {
      invalidCount++;
      continue;
    }
    if (seenKeys.has(apiKey)) {
      duplicateCount++;
      continue;
    }
    seenKeys.add(apiKey);
    seq += 1;
    parsed.push({
      name: name || `Gemini Key #${seq}`,
      email,
      apiKey
    });
  }

  return { entries: parsed, invalidCount, duplicateCount };
}

function batchAddGeminiAccountsRecord(input = {}) {
  const rawText = typeof input.rawText === 'string'
    ? input.rawText
    : (Array.isArray(input.keys) ? input.keys.join('\n') : '');
  const data = loadGeminiAccountsStore();
  const { entries, invalidCount, duplicateCount } = parseGeminiBatchKeysInput(rawText, data.accounts.length);
  if (entries.length === 0) {
    throw new Error('រកមិនឃើញ Gemini API Key ត្រឹមត្រូវទេ (យ៉ាងតិច ២០ តួអក្សរក្នុង ១ បន្ទាត់)។');
  }

  const existingKeys = new Set(data.accounts.map(a => a.apiKey));
  let addedCount = 0;
  let skippedCount = duplicateCount;
  const nowIso = new Date().toISOString();

  for (const item of entries) {
    if (existingKeys.has(item.apiKey)) {
      skippedCount++;
      continue;
    }
    existingKeys.add(item.apiKey);
    const created = {
      id: `gemini_${crypto.randomUUID()}`,
      name: item.name,
      email: item.email || '',
      apiKey: item.apiKey,
      enabled: true,
      createdAt: nowIso,
      lastUsed: null
    };
    data.accounts.push(created);
    if (!data.activeAccountId) data.activeAccountId = created.id;
    addedCount++;
  }

  saveGeminiAccountsStore(data);
  return {
    addedCount,
    skippedCount,
    invalidCount,
    ...getSafeGeminiAccounts(data)
  };
}

function syncAccountsFromDesktop(desktopData, options = {}) {
  if (!desktopData || !Array.isArray(desktopData.accounts)) return;
  const authoritative = Boolean(options && options.authoritative);
  if (!authoritative && desktopData.accounts.length === 0) return;
  try {
    const store = loadGeminiAccountsStore();
    const byId = new Map(store.accounts.map(a => [a.id, a]));
    const byKey = new Map(store.accounts.map(a => [a.apiKey, a]));
    const incomingIds = new Set();
    const incomingKeys = new Set();
    for (const acc of desktopData.accounts) {
      if (!acc || typeof acc.apiKey !== 'string' || !acc.apiKey.trim()) continue;
      const key = acc.apiKey.trim();
      incomingKeys.add(key);
      if (acc.id) incomingIds.add(acc.id);
      const existing = (acc.id && byId.get(acc.id)) || byKey.get(key);
      if (existing) {
        if (acc.name) existing.name = acc.name;
        if (typeof acc.email === 'string') existing.email = acc.email;
        existing.apiKey = key;
        existing.enabled = acc.enabled !== false;
        if (acc.lastUsed) existing.lastUsed = acc.lastUsed;
      } else {
        const entry = {
          id: acc.id || `gemini_${crypto.randomUUID()}`,
          name: acc.name || 'Gemini Account',
          email: acc.email || '',
          apiKey: key,
          enabled: acc.enabled !== false,
          createdAt: acc.createdAt || new Date().toISOString(),
          lastUsed: acc.lastUsed || null
        };
        store.accounts.push(entry);
        byKey.set(key, entry);
      }
    }
    if (authoritative) {
      store.accounts = store.accounts.filter(acc => incomingIds.has(acc.id) || incomingKeys.has(acc.apiKey));
    }
    if (desktopData.activeAccountId) {
      const matched = store.accounts.find(a => a.id === desktopData.activeAccountId);
      if (matched) store.activeAccountId = matched.id;
    }
    if ((!store.activeAccountId || !store.accounts.some(a => a.id === store.activeAccountId)) && store.accounts.length > 0) {
      store.activeAccountId = store.accounts[0].id;
    } else if (store.accounts.length === 0) {
      store.activeAccountId = null;
    }
    saveGeminiAccountsStore(store);
  } catch (_) {}
}

/**
 * Load configuration from disk
 */
const DEFAULT_RESPAN_BASE_URL = 'https://gateway.respan.ai/v1';
const DEFAULT_RESPAN_MODEL = 'openai/gpt-6.2-sol:free';

function normalizeRespanBaseUrl(rawUrl = '') {
  const cleaned = String(rawUrl || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  if (!cleaned) return DEFAULT_RESPAN_BASE_URL;
  try {
    const parsed = new URL(cleaned);
    const host = String(parsed.hostname || '').toLowerCase();
    const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalHost)) {
      return DEFAULT_RESPAN_BASE_URL;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch (_) {
    return DEFAULT_RESPAN_BASE_URL;
  }
}

function normalizeRespanModel(rawModel = '') {
  const cleaned = String(rawModel || '').trim();
  if (!cleaned || cleaned.length > 160 || /\s/.test(cleaned)) {
    return DEFAULT_RESPAN_MODEL;
  }
  return cleaned;
}

function normalizeRespanRole(rawRole = '') {
  const val = String(rawRole || '').trim().toLowerCase();
  if (val === 'primary' || val === 'off' || val === 'assist') return val;
  return 'assist';
}

function parseDotEnvVar(envData, varName) {
  if (!envData || !varName) return '';
  const re = new RegExp(`^\\s*(?:export\\s+)?${varName}\\s*=\\s*(.*?)\\s*$`, 'm');
  const match = envData.match(re);
  if (!match) return '';
  return match[1].replace(/^(['"])(.*)\1$/, '$2').trim();
}

/**
 * Load configuration from config.json + optional secure storage & .env fallbacks
 */
function loadConfig(req = null) {
  const isStrictPackaged = process.env.EZA_PACKAGED === '1';
  let cfg = {
    GEMINI_API_KEY: '',
    RESPAN_API_KEY: '',
    RESPAN_BASE_URL: DEFAULT_RESPAN_BASE_URL,
    RESPAN_MODEL: DEFAULT_RESPAN_MODEL,
    RESPAN_ROLE: 'assist',
    DOWNLOAD_DIR: ''
  };

  // Try loading from config.json
  const configFile = getConfigFilePath();
  if (fs.existsSync(configFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      cfg = { ...cfg, ...data };
      if (typeof data.RESPAN_API_KEY_ENC === 'string' && data.RESPAN_API_KEY_ENC.trim()) {
        try {
          cfg.RESPAN_API_KEY = decryptSecret(data.RESPAN_API_KEY_ENC.trim());
        } catch (_) {}
      }
      if (isStrictPackaged) {
        cfg.GEMINI_API_KEY = '';
        if (!data.RESPAN_API_KEY_ENC) {
          cfg.RESPAN_API_KEY = '';
        }
      }
    } catch (_) {}
  }

  // Get API key from Electron secure storage if available
  if (req && req.getGeminiApiKey) {
    try {
      const apiKey = req.getGeminiApiKey();
      if (apiKey) {
        cfg.GEMINI_API_KEY = apiKey;
      }
    } catch (e) {
      console.warn('[Config] Could not load API key from secure storage:', e.message);
    }
  }

  // Fallback to encrypted Router Management accounts store
  if (!cfg.GEMINI_API_KEY) {
    const storeKey = getActiveGeminiApiKey();
    if (storeKey) {
      cfg.GEMINI_API_KEY = storeKey;
    }
  }

  // In development/test only: optional fallback to process.env or .env (never in packaged .exe)
  if (!isStrictPackaged && !cfg.GEMINI_API_KEY && process.env.GEMINI_API_KEY) {
    cfg.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  }
  if (!isStrictPackaged) {
    if (!cfg.RESPAN_API_KEY && process.env.RESPAN_API_KEY) {
      cfg.RESPAN_API_KEY = String(process.env.RESPAN_API_KEY).trim();
    }
    if (process.env.RESPAN_BASE_URL) cfg.RESPAN_BASE_URL = process.env.RESPAN_BASE_URL;
    if (process.env.RESPAN_MODEL) cfg.RESPAN_MODEL = process.env.RESPAN_MODEL;
    if (process.env.RESPAN_ROLE) cfg.RESPAN_ROLE = process.env.RESPAN_ROLE;

    const envFile = path.join(__dirname, '..', '..', '..', '.env');
    if (fs.existsSync(envFile)) {
      try {
        const envData = fs.readFileSync(envFile, 'utf8');
        if (!cfg.GEMINI_API_KEY) {
          const parsedGemini = parseDotEnvVar(envData, 'GEMINI_API_KEY');
          if (parsedGemini) cfg.GEMINI_API_KEY = parsedGemini;
        }
        if (!cfg.RESPAN_API_KEY) {
          const parsedRespan = parseDotEnvVar(envData, 'RESPAN_API_KEY');
          if (parsedRespan) cfg.RESPAN_API_KEY = parsedRespan;
        }
        const envBaseUrl = parseDotEnvVar(envData, 'RESPAN_BASE_URL');
        const envModel = parseDotEnvVar(envData, 'RESPAN_MODEL');
        const envRole = parseDotEnvVar(envData, 'RESPAN_ROLE');
        if (envBaseUrl && cfg.RESPAN_BASE_URL === DEFAULT_RESPAN_BASE_URL) cfg.RESPAN_BASE_URL = envBaseUrl;
        if (envModel && cfg.RESPAN_MODEL === DEFAULT_RESPAN_MODEL) cfg.RESPAN_MODEL = envModel;
        if (envRole) cfg.RESPAN_ROLE = envRole;

        // Also support generic API="..." line in .env cleanly (routes AIza/AQ keys to Gemini, others to Respan)
        const parsedGenericApi = parseDotEnvVar(envData, 'API');
        if (parsedGenericApi) {
          if (/^(AIza|AQ\.)/i.test(parsedGenericApi)) {
            if (!cfg.GEMINI_API_KEY) cfg.GEMINI_API_KEY = parsedGenericApi;
          } else if (!cfg.RESPAN_API_KEY) {
            cfg.RESPAN_API_KEY = parsedGenericApi;
          }
        }
      } catch (_) {}
    }
  }

  cfg.RESPAN_BASE_URL = normalizeRespanBaseUrl(cfg.RESPAN_BASE_URL);
  cfg.RESPAN_MODEL = normalizeRespanModel(cfg.RESPAN_MODEL);
  cfg.RESPAN_ROLE = normalizeRespanRole(cfg.RESPAN_ROLE);

  return cfg;
}

/**
 * Save configuration to disk
 */
function saveConfig(cfg) {
  try {
    const configFile = getConfigFilePath();
    const dir = path.dirname(configFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let existing = {};
    if (fs.existsSync(configFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed;
        }
      } catch (_) {}
    }

    const merged = { ...existing, ...cfg };
    const tmpPath = `${configFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf8');
      renameSyncWithWindowsRetry(tmpPath, configFile);
    } finally {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    }

    return true;
  } catch (err) {
    console.error('Failed to save config:', err);
    throw err;
  }
}

const RESTRICTED_PUBLIC_CONFIG_KEYS = new Set([
  'GEMINI_API_KEY',
  'GEMINI_ACCOUNTS',
  'RESPAN_API_KEY',
  'RESPAN_API_KEY_ENC',
  'GEMINI_VAULT_KEY',
  'EZA_VAULT_KEY',
  'CLOUD_LICENSE_KEY',
  'LICENSE_PRIVATE_KEY',
  'LICENSE_SECRET',
  'ADMIN_TOKEN',
  'USER_ACCESS_ENABLED',
  'USER_ACCESS_CODE',
  'MAINTENANCE_BANNER',
  'MAINTENANCE_LOCKED',
  'ROUTER_DEFAULT_LOCKED',
  '__proto__',
  'constructor',
  'prototype'
]);

const respanTelemetry = {
  activeCount: 0,
  totalRequests: 0,
  recentUntil: 0,
  lastStatus: 'ready',
  lastLatencyMs: null,
  cooldownUntil: 0,
  lastError: ''
};

function beginRespanStream() {
  const startedAt = Date.now();
  respanTelemetry.activeCount += 1;
  respanTelemetry.totalRequests += 1;
  respanTelemetry.recentUntil = startedAt + STREAM_VISUAL_HOLD_MS;
  respanTelemetry.lastStatus = 'streaming';
  let ended = false;
  return {
    end(ok = true, statusCode = 200, errorMsg = '') {
      if (ended) return;
      ended = true;
      respanTelemetry.activeCount = Math.max(0, respanTelemetry.activeCount - 1);
      respanTelemetry.lastLatencyMs = Math.max(1, Date.now() - startedAt);
      respanTelemetry.recentUntil = Date.now() + STREAM_VISUAL_HOLD_MS;
      if (ok) {
        respanTelemetry.lastStatus = respanTelemetry.activeCount > 0 ? 'streaming' : 'ready';
        respanTelemetry.lastError = '';
      } else {
        respanTelemetry.lastStatus = statusCode === 429 ? 'rate_limited' : 'error';
        respanTelemetry.lastError = String(errorMsg || '');
      }
    }
  };
}

function markRespanRateLimited(durationMs = 20000) {
  const ms = Math.max(5000, Number(durationMs) || 20000);
  respanTelemetry.cooldownUntil = Math.max(respanTelemetry.cooldownUntil || 0, Date.now() + ms);
  respanTelemetry.lastStatus = 'rate_limited';
}

function markRespanHealthy() {
  respanTelemetry.cooldownUntil = 0;
  respanTelemetry.lastError = '';
  if (respanTelemetry.activeCount === 0) respanTelemetry.lastStatus = 'ready';
}

function isRespanRateLimited() {
  return (respanTelemetry.cooldownUntil || 0) > Date.now();
}

function getRespanRuntimeConfig(req = null) {
  const cfg = loadConfig(req);
  const apiKey = typeof cfg.RESPAN_API_KEY === 'string' ? cfg.RESPAN_API_KEY.trim() : '';
  const role = normalizeRespanRole(cfg.RESPAN_ROLE);
  return {
    apiKey,
    baseUrl: normalizeRespanBaseUrl(cfg.RESPAN_BASE_URL),
    model: normalizeRespanModel(cfg.RESPAN_MODEL),
    role,
    enabled: Boolean(apiKey && role !== 'off')
  };
}

function getSafeRespanSnapshot(req = null) {
  const rt = getRespanRuntimeConfig(req);
  const now = Date.now();
  const cooldownRemainingMs = Math.max(0, (respanTelemetry.cooldownUntil || 0) - now);
  const isStreaming = respanTelemetry.activeCount > 0 || respanTelemetry.recentUntil > now;
  const k = rt.apiKey;
  return {
    hasKey: Boolean(k),
    enabled: rt.enabled,
    role: rt.role,
    baseUrl: rt.baseUrl,
    model: rt.model,
    keyHint: k.length >= 12 ? `${k.slice(0, 6)}...${k.slice(-4)}` : (k ? '••••••••' : ''),
    activeCount: respanTelemetry.activeCount,
    totalRequests: respanTelemetry.totalRequests,
    isStreaming,
    lastStatus: respanTelemetry.activeCount > 0
      ? 'streaming'
      : (cooldownRemainingMs > 0 ? 'rate_limited' : respanTelemetry.lastStatus),
    lastLatencyMs: respanTelemetry.lastLatencyMs,
    cooldownRemainingMs,
    lastError: respanTelemetry.lastError || ''
  };
}

function saveRespanConfigRecord(input = {}) {
  const nextPatch = {};
  if (input && input.clearKey === true) {
    nextPatch.RESPAN_API_KEY = '';
    nextPatch.RESPAN_API_KEY_ENC = '';
  } else if (input && typeof input.apiKey === 'string' && input.apiKey.trim()) {
    const cleanKey = input.apiKey.trim();
    if (cleanKey.length < 12 || cleanKey.length > 512 || /\s/.test(cleanKey)) {
      throw new Error('Respan API Key មិនត្រឹមត្រូវទេ (ត្រូវមានយ៉ាងតិច 12 តួអក្សរ និងគ្មានដកឃ្លា)។');
    }
    nextPatch.RESPAN_API_KEY = '';
    nextPatch.RESPAN_API_KEY_ENC = encryptSecret(cleanKey);
  }
  if (input && typeof input.baseUrl === 'string' && input.baseUrl.trim()) {
    nextPatch.RESPAN_BASE_URL = normalizeRespanBaseUrl(input.baseUrl);
  }
  if (input && typeof input.model === 'string' && input.model.trim()) {
    nextPatch.RESPAN_MODEL = normalizeRespanModel(input.model);
  }
  if (input && typeof input.role === 'string' && input.role.trim()) {
    nextPatch.RESPAN_ROLE = normalizeRespanRole(input.role);
  }
  saveConfig(nextPatch);
  markRespanHealthy();
  return getSafeRespanSnapshot();
}

function probeRespanConnection({ apiKey = '', baseUrl = '', model = '' } = {}) {
  const httpMod = require('http');
  const rt = getRespanRuntimeConfig();
  const keyToUse = String(apiKey || '').trim() || rt.apiKey;
  const resolvedBase = normalizeRespanBaseUrl(baseUrl || rt.baseUrl);
  const resolvedModel = normalizeRespanModel(model || rt.model);
  if (!keyToUse) {
    return Promise.resolve({
      healthy: false,
      statusCode: 401,
      latencyMs: 0,
      error: 'មិនទាន់មាន Respan API Key ទេ'
    });
  }

  return new Promise((resolve) => {
    const started = Date.now();
    const stream = beginRespanStream();
    let settled = false;
    const finish = (ok, statusCode, errorMsg = '', modelReply = '') => {
      if (settled) return;
      settled = true;
      stream.end(ok, statusCode, errorMsg);
      if (ok) markRespanHealthy();
      resolve({
        healthy: ok,
        statusCode,
        latencyMs: Date.now() - started,
        error: errorMsg,
        modelReply
      });
    };

    let targetUrl;
    try {
      targetUrl = new URL(`${resolvedBase}/chat/completions`);
    } catch (e) {
      return finish(false, 400, e.message);
    }

    const payload = JSON.stringify({
      model: resolvedModel,
      messages: [
        { role: 'system', content: 'Reply cleanly in JSON only.' },
        { role: 'user', content: 'Translate "你好" to everyday Khmer. Output JSON: {"ok":true,"km":"សួស្តី"}' }
      ],
      max_tokens: 48,
      temperature: 0.1
    });

    const mod = targetUrl.protocol === 'http:' ? httpMod : https;
    const req = mod.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'http:' ? 80 : 443),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: 'POST',
      family: 4,
      timeout: 12000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keyToUse}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('error', err => finish(false, res.statusCode || 502, err ? err.message : 'Response error'));
      res.on('end', () => {
        if (settled) return;
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300 && parsed && Array.isArray(parsed.choices) && parsed.choices.length > 0) {
          const reply = String((parsed.choices[0].message && parsed.choices[0].message.content) || '').trim();
          return finish(true, res.statusCode, '', reply.slice(0, 120));
        }
        const errMsg = (parsed && parsed.error && parsed.error.message) || `HTTP ${res.statusCode}`;
        finish(false, res.statusCode, errMsg);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', err => finish(false, 502, err ? err.message : 'Request failed'));
    req.end(payload);
  });
}

router.use((req, res, next) => {
  if (req.path === '/verify-access' || (req.path === '/system-hub' && req.method === 'GET')) {
    return next();
  }
  if (!isCallerAuthorized(req)) {
    return res.status(401).json({
      success: false,
      authRequired: true,
      error: 'សូមបញ្ចូលលេខកូដសុវត្ថិភាពជាមុនសិន។'
    });
  }
  next();
});

/**
 * GET /api/config
 * Get current configuration (without sensitive data)
 */
router.get('/', (req, res) => {
  try {
    const cfg = loadConfig(req);
    const hasRespanKey = Boolean(cfg.RESPAN_API_KEY);
    res.json({ 
      success: true, 
      config: {
        DOWNLOAD_DIR: cfg.DOWNLOAD_DIR,
        hasApiKey: !!(cfg.GEMINI_API_KEY || (hasRespanKey && cfg.RESPAN_ROLE !== 'off')),
        hasGeminiKey: !!cfg.GEMINI_API_KEY,
        hasRespanKey,
        respanRole: cfg.RESPAN_ROLE,
        respanModel: cfg.RESPAN_MODEL
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/config
 * Save configuration
 */
router.post('/', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        error: 'Configuration payload must be a JSON object.'
      });
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'GEMINI_API_KEY')) {
      return res.status(400).json({
        success: false,
        error: 'API keys must be saved through the secure desktop settings.'
      });
    }
    const sanitized = {};
    for (const [k, v] of Object.entries(req.body)) {
      if (RESTRICTED_PUBLIC_CONFIG_KEYS.has(k)) {
        return res.status(403).json({
          success: false,
          error: `Restricted configuration key "${k}" cannot be modified via public /api/config.`
        });
      }
      sanitized[k] = v;
    }
    saveConfig(sanitized);
    res.json({ success: true, message: 'Configuration saved' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/config/accounts
 * List Gemini accounts for Router Management
 */
router.get('/accounts', (req, res) => {
  try {
    const result = getSafeGeminiAccounts();
    return res.json({ success: true, ...result, respan: getSafeRespanSnapshot(req) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/respan', (req, res) => {
  try {
    return res.json({ success: true, ...getSafeRespanSnapshot(req) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/respan', (req, res) => {
  try {
    const snap = saveRespanConfigRecord(req.body || {});
    return res.json({ success: true, ...snap });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/respan/test', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const probe = await probeRespanConnection({
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      model: body.model
    });
    return res.json({ success: true, ...probe, respan: getSafeRespanSnapshot(req) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/config/accounts
 * Add or update a Gemini account in Router Management
 */
router.post('/accounts', (req, res) => {
  try {
    const result = addGeminiAccountRecord(req.body || {});
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/config/accounts/batch
 * Batch import multiple Gemini API keys at once
 */
router.post('/accounts/batch', (req, res) => {
  try {
    const result = batchAddGeminiAccountsRecord(req.body || {});
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/config/accounts/switch
 * Switch active Gemini account
 */
router.post('/accounts/switch', (req, res) => {
  try {
    const result = switchGeminiAccountRecord(req.body && req.body.accountId);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/config/accounts/:id
 * Update Gemini account name, email, or optional API key
 */
router.put('/accounts/:id', (req, res) => {
  try {
    const result = updateGeminiAccountRecord(req.params.id, req.body || {});
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/config/accounts/:id
 * Delete a Gemini account
 */
router.delete('/accounts/:id', (req, res) => {
  try {
    const result = deleteGeminiAccountRecord(req.params.id);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/config/accounts/test
 * Probe a saved Gemini account key without exposing the key
 */
function probeGeminiKey(apiKey) {
  return new Promise((resolve) => {
    const started = Date.now();
    const stream = beginGeminiStream(apiKey, 'Connection Test', { skipUsageIncrement: true });
    let settled = false;
    const finish = (ok, statusCode, errorMsg) => {
      if (settled) return;
      settled = true;
      stream.end(ok, statusCode);
      resolve({
        healthy: ok,
        statusCode,
        latencyMs: Date.now() - started,
        error: errorMsg
      });
    };

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models?pageSize=1&key=${encodeURIComponent(apiKey)}`,
      method: 'GET',
      family: 4,
      timeout: 6500
    }, (res) => {
      res.on('data', () => {});
      res.on('error', (err) => {
        finish(false, res.statusCode || 502, err ? err.message : 'Response stream error');
      });
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        finish(ok, res.statusCode, ok ? '' : `HTTP ${res.statusCode}`);
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', (err) => {
      finish(false, 502, err ? err.message : 'Request failed');
    });
    req.end();
  });
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  let cursor = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  }));
  return results;
}

router.post('/accounts/test', async (req, res) => {
  try {
    const accountId = req.body && typeof req.body.accountId === 'string' ? req.body.accountId.trim() : '';
    const store = loadGeminiAccountsStore();
    const target = accountId
      ? store.accounts.find(a => a.id === accountId)
      : (store.accounts.find(a => a.id === store.activeAccountId) || store.accounts[0]);
    if (!target) {
      return res.status(404).json({ success: false, error: 'រកមិនឃើញ Gemini account នេះទេ។' });
    }
    const probe = await probeGeminiKey(target.apiKey);
    const snapshot = getSafeGeminiAccounts(loadGeminiAccountsStore());
    return res.json({
      success: true,
      accountId: target.id,
      ...probe,
      ...snapshot
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/config/accounts/test-all
 * Probe every saved Gemini account with bounded concurrency without exposing API keys
 */
router.post('/accounts/test-all', async (req, res) => {
  try {
    const store = loadGeminiAccountsStore();
    const enabledAccounts = store.accounts.filter(acc => acc.enabled !== false);
    const results = await mapWithConcurrency(enabledAccounts, 5, async (acc) => {
      const probe = await probeGeminiKey(acc.apiKey);
      return {
        accountId: acc.id,
        name: acc.name,
        ...probe
      };
    });
    const healthyCount = results.filter(r => r.healthy).length;
    const pausedCount = store.accounts.length - enabledAccounts.length;
    const snapshot = getSafeGeminiAccounts(loadGeminiAccountsStore());
    return res.json({
      success: true,
      healthyCount,
      totalCount: results.length,
      pausedCount,
      results,
      ...snapshot
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/config/accounts/reset-cooldown
 * Clear 429 cooldown locks and error statuses for all or a single account
 */
router.post('/accounts/reset-cooldown', (req, res) => {
  try {
    const accountId = req.body && typeof req.body.accountId === 'string' ? req.body.accountId.trim() : '';
    const snapshot = clearGeminiAccountCooldowns(accountId);
    return res.json({ success: true, ...snapshot });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/config/gemini-key
 * Save or update active Gemini API key
 */
router.post('/gemini-key', (req, res) => {
  try {
    const result = saveGeminiApiKeyRecord(req.body && req.body.apiKey);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

function detectLanAddresses(port = 3001) {
  const lanIps = [];
  try {
    const nets = os.networkInterfaces() || {};
    for (const [ifaceName, entries] of Object.entries(nets)) {
      if (!Array.isArray(entries)) continue;
      if (/vethernet|wsl|docker|vmware|virtualbox|loopback/i.test(ifaceName)) continue;
      for (const entry of entries) {
        if (!entry || entry.internal) continue;
        const family = String(entry.family || '');
        if (family !== 'IPv4' && family !== '4') continue;
        if (entry.address && !lanIps.includes(entry.address)) {
          lanIps.push(entry.address);
        }
      }
    }
  } catch (_) {}

  lanIps.sort((a, b) => {
    const score = (ip) => ip.startsWith('192.168.') ? 0 : (ip.startsWith('10.') ? 1 : 2);
    return score(a) - score(b);
  });

  const primaryIp = lanIps[0] || '127.0.0.1';
  const webPort = Number(process.env.PORT) || Number(port) || 3001;
  return {
    lanIps,
    primaryIp,
    webPort,
    phoneUrl: `http://${primaryIp}:${webPort}`,
    lanUrls: lanIps.map(ip => `http://${ip}:${webPort}`),
    hostname: os.hostname()
  };
}

const LICENSE_MASTER_SECRET = process.env.EZA_LICENSE_SECRET || 'eza-pro-master-license-hmac-secret-2026-v1';
const accessFailedAttempts = new Map();

let cachedMachineHardwareId = '';

function readWindowsMachineGuid() {
  if (process.platform !== 'win32') return '';
  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', windowsHide: true, timeout: 2000 }
    );
    if (res.status === 0 && res.stdout) {
      const match = res.stdout.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{16,64})/);
      if (match && match[1]) return match[1].trim().toLowerCase();
    }
  } catch (_) {}
  return '';
}

function getMachineHardwareId() {
  if (cachedMachineHardwareId) return cachedMachineHardwareId;
  try {
    const winGuid = readWindowsMachineGuid();
    const cpus = os.cpus() || [];
    const cpuModel = cpus[0] ? cpus[0].model : 'generic-cpu';
    const raw = winGuid
      ? `win32-guid|${os.arch()}|${winGuid}`
      : `${os.platform()}|${os.arch()}|${os.hostname()}|${cpuModel}|${cpus.length}`;
    const digest = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
    cachedMachineHardwareId = `EZA-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`;
    return cachedMachineHardwareId;
  } catch (_) {
    return 'EZA-0000-0000-0000';
  }
}

function normalizeMachineId(hwid) {
  return String(hwid || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
}

function generateLicenseKeyForMachine(machineId, expiresTag = 'LIFETIME') {
  const cleanHwid = normalizeMachineId(machineId || getMachineHardwareId());
  if (!cleanHwid || cleanHwid.length < 8) {
    throw new Error('Machine ID មិនត្រឹមត្រូវទេ (ឧ. EZA-XXXX-XXXX-XXXX)។');
  }
  const cleanExp = String(expiresTag || 'LIFETIME').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'LIFETIME';
  const payload = `${cleanHwid}:${cleanExp}`;
  const sig = crypto
    .createHmac('sha256', LICENSE_MASTER_SECRET)
    .update(payload)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return `EZAPRO-${cleanExp}-${sig}`;
}

function verifyMachineLicenseKey(licenseKey, machineId = getMachineHardwareId()) {
  const raw = String(licenseKey || '').trim().toUpperCase();
  const match = /^EZAPRO-([A-Z0-9]+)-([A-F0-9]{16})$/.exec(raw);
  if (!match) return { valid: false, reason: 'format' };
  const [, expTag, providedSig] = match;
  const expectedKey = generateLicenseKeyForMachine(machineId, expTag);
  const expectedSig = expectedKey.split('-').pop();
  const bufA = Buffer.from(providedSig, 'utf8');
  const bufB = Buffer.from(expectedSig, 'utf8');
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return { valid: false, reason: 'signature' };
  }
  if (/^\d{8}$/.test(expTag)) {
    const nowYmd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    if (nowYmd > expTag) {
      return { valid: false, reason: 'expired', expiresTag: expTag };
    }
  }
  return { valid: true, expiresTag: expTag };
}

function hashAccessPasscode(plainCode) {
  const clean = String(plainCode || '').trim();
  if (!clean) return '';
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(clean, salt, 32).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyHashedPasscode(plainCode, storedValue) {
  const clean = String(plainCode || '').trim();
  const stored = String(storedValue || '').trim();
  if (!clean || !stored) return false;
  if (stored.startsWith('scrypt:')) {
    const [, salt, hexHash] = stored.split(':');
    if (!salt || !hexHash) return false;
    const candidate = crypto.scryptSync(clean, salt, 32);
    const target = Buffer.from(hexHash, 'hex');
    return candidate.length === target.length && crypto.timingSafeEqual(candidate, target);
  }
  const bufA = Buffer.from(clean, 'utf8');
  const bufB = Buffer.from(stored, 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function getPasscodeVersionTag(storedPasscode) {
  const clean = String(storedPasscode || '').trim();
  if (!clean) return '';
  return crypto.createHash('sha256').update(clean).digest('hex').slice(0, 8);
}

function isLoopbackAddress(rawIp) {
  const ip = String(rawIp || '').trim();
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isLoopbackNonForwardedRequest(req) {
  if (!req) return true;
  const headers = req.headers || {};
  if (
    headers['cf-connecting-ip'] ||
    headers['x-forwarded-for'] ||
    headers['x-real-ip'] ||
    headers.forwarded
  ) {
    return false;
  }
  return isLoopbackAddress((req.socket && req.socket.remoteAddress) || req.ip);
}

function getRateLimitClientKey(req) {
  const sockIp = String((req && req.socket && req.socket.remoteAddress) || (req && req.ip) || 'local').trim();
  const headers = (req && req.headers) || {};
  if (isLoopbackAddress(sockIp)) {
    const cfIp = typeof headers['cf-connecting-ip'] === 'string' ? headers['cf-connecting-ip'].trim() : '';
    if (cfIp) return `cf:${cfIp}`;
    const xff = typeof headers['x-forwarded-for'] === 'string' ? headers['x-forwarded-for'].split(',')[0].trim() : '';
    if (xff) return `xff:${xff}`;
  }
  return sockIp || 'local';
}

function issueSignedAccessToken(subject = 'user', passcodeValue = '') {
  const issuedAt = Date.now();
  const cleanSubj = String(subject || 'user').trim();
  const finalSubj = (cleanSubj === 'verified' && passcodeValue)
    ? `verified:${getPasscodeVersionTag(passcodeValue)}`
    : cleanSubj;
  const payload = `${finalSubj}.${issuedAt}`;
  const sig = crypto
    .createHmac('sha256', getVaultKey())
    .update(payload)
    .digest('hex');
  return `${payload}.${sig}`;
}

function verifySignedAccessToken(token, req = null) {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 3) return false;
  const [subject, issuedAtStr, sig] = parts;
  const payload = `${subject}.${issuedAtStr}`;
  const expectedSig = crypto
    .createHmac('sha256', getVaultKey())
    .update(payload)
    .digest('hex');
  const bufA = Buffer.from(sig, 'utf8');
  const bufB = Buffer.from(expectedSig, 'utf8');
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return false;
  }
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt) || issuedAt > Date.now() + 60000 || (Date.now() - issuedAt) > ACCESS_TOKEN_TTL_MS) {
    return false;
  }
  try {
    if (cloudLicense.isCloudLicenseEnforced() && subject !== 'cloud') {
      return false;
    }
    const cfg = loadConfig(req);
    const enabled = Boolean(cfg.USER_ACCESS_ENABLED);
    const expected = typeof cfg.USER_ACCESS_CODE === 'string' ? cfg.USER_ACCESS_CODE.trim() : '';
    if (enabled && expected) {
      if (subject === 'open') return false;
      if (subject.startsWith('verified:')) {
        const tokenTag = subject.slice('verified:'.length);
        if (tokenTag !== getPasscodeVersionTag(expected)) {
          return false;
        }
      }
    }
  } catch (_) {
    return false;
  }
  return true;
}

function extractCallerAccessToken(req) {
  if (!req) return '';
  const headerToken = typeof req.get === 'function'
    ? (req.get('x-eza-access-token') || '')
    : (req.headers && (req.headers['x-eza-access-token'] || ''));
  if (headerToken && String(headerToken).trim()) return String(headerToken).trim();
  const auth = typeof req.get === 'function'
    ? (req.get('authorization') || '')
    : (req.headers && (req.headers.authorization || ''));
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const qToken = req.query && (req.query.accessToken || req.query.token);
  return typeof qToken === 'string' ? qToken.trim() : '';
}

function isCallerAuthorized(req) {
  const cfg = loadConfig(req);
  const accessLocked = Boolean(cfg.USER_ACCESS_ENABLED && typeof cfg.USER_ACCESS_CODE === 'string' && cfg.USER_ACCESS_CODE.trim());
  if (!accessLocked) return true;
  if (isLoopbackNonForwardedRequest(req)) return true;
  const token = extractCallerAccessToken(req);
  return Boolean(token && verifySignedAccessToken(token, req));
}

const { spawn } = require('child_process');
let activePublicTunnel = {
  proc: null,
  url: '',
  provider: '',
  status: 'stopped',
  error: ''
};
let publicTunnelStartPromise = null;
let settlePendingTunnelStart = null;

function startPublicInternetTunnel(targetPort = 3001) {
  if (activePublicTunnel.proc && activePublicTunnel.url) {
    return Promise.resolve({
      success: true,
      url: activePublicTunnel.url,
      provider: activePublicTunnel.provider,
      status: 'running'
    });
  }
  if (publicTunnelStartPromise) {
    return publicTunnelStartPromise;
  }
  stopPublicInternetTunnel();

  const port = Number(process.env.PORT) || Number(targetPort) || 3001;
  const localCloudflared = path.join(__dirname, '..', '..', '..', 'tools', 'cloudflared.exe');
  const hasLocalCloudflared = fs.existsSync(localCloudflared);

  const runPromise = new Promise((resolve) => {
    let settled = false;
    let fallbackTimeout = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (settlePendingTunnelStart === finish) settlePendingTunnelStart = null;
      if (fallbackTimeout) {
        clearTimeout(fallbackTimeout);
        fallbackTimeout = null;
      }
      resolve(result);
    };
    settlePendingTunnelStart = finish;

    const launchSshFallback = () => {
      activePublicTunnel.provider = 'localhost.run (SSH HTTPS)';
      activePublicTunnel.status = 'starting';
      activePublicTunnel.error = '';
      const sshBin = process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe')
        ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
        : 'ssh';
      const nullKnownHosts = process.platform === 'win32' ? 'NUL' : '/dev/null';
      const proc = spawn(sshBin, [
        '-o', 'StrictHostKeyChecking=no',
        '-o', `UserKnownHostsFile=${nullKnownHosts}`,
        '-o', 'ServerAliveInterval=30',
        '-R', `80:127.0.0.1:${port}`,
        'nokey@localhost.run'
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      activePublicTunnel.proc = proc;
      const onChunk = (chunk) => {
        const text = String(chunk || '');
        const match = /https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)/i.exec(text);
        if (match && !activePublicTunnel.url) {
          activePublicTunnel.url = match[0];
          activePublicTunnel.status = 'running';
          finish({
            success: true,
            url: activePublicTunnel.url,
            provider: activePublicTunnel.provider,
            status: 'running'
          });
        }
      };
      proc.stdout.on('data', onChunk);
      proc.stderr.on('data', onChunk);
      proc.on('error', (err) => {
        activePublicTunnel.status = 'error';
        activePublicTunnel.error = err.message;
        finish({ success: false, error: err.message });
      });
      proc.on('exit', () => {
        if (activePublicTunnel.proc === proc) {
          activePublicTunnel.proc = null;
          if (!activePublicTunnel.url) {
            activePublicTunnel.status = 'stopped';
            finish({ success: false, error: 'មិនអាចភ្ជាប់ Tunnel បានទេ។ សូមពិនិត្យអ៊ីនធឺណិត។' });
          } else {
            activePublicTunnel.status = 'stopped';
            activePublicTunnel.url = '';
          }
        }
      });
    };

    if (hasLocalCloudflared) {
      activePublicTunnel.provider = 'Cloudflare Tunnel';
      activePublicTunnel.status = 'starting';
      const proc = spawn(localCloudflared, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      activePublicTunnel.proc = proc;
      const onCfChunk = (chunk) => {
        const text = String(chunk || '');
        const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
        if (match && !activePublicTunnel.url) {
          activePublicTunnel.url = match[0];
          activePublicTunnel.status = 'running';
          finish({
            success: true,
            url: activePublicTunnel.url,
            provider: activePublicTunnel.provider,
            status: 'running'
          });
        }
      };
      proc.stdout.on('data', onCfChunk);
      proc.stderr.on('data', onCfChunk);
      proc.on('error', () => {
        if (activePublicTunnel.proc === proc && !activePublicTunnel.url) {
          launchSshFallback();
        }
      });
      proc.on('exit', () => {
        if (activePublicTunnel.proc === proc) {
          activePublicTunnel.proc = null;
          if (!activePublicTunnel.url) {
            launchSshFallback();
          } else {
            activePublicTunnel.status = 'stopped';
            activePublicTunnel.url = '';
          }
        }
      });
    } else {
      launchSshFallback();
    }

    fallbackTimeout = setTimeout(() => {
      if (!settled) {
        finish({
          success: Boolean(activePublicTunnel.url),
          url: activePublicTunnel.url || '',
          provider: activePublicTunnel.provider,
          status: activePublicTunnel.status,
          error: activePublicTunnel.url ? '' : 'កំពុងភ្ជាប់ Tunnel... សូមចុច Refresh បន្តិចទៀត។'
        });
      }
    }, 8500);
  }).finally(() => {
    publicTunnelStartPromise = null;
  });

  publicTunnelStartPromise = runPromise;
  return runPromise;
}

function stopPublicInternetTunnel() {
  if (activePublicTunnel.proc) {
    try {
      activePublicTunnel.proc.kill();
    } catch (_) {}
  }
  activePublicTunnel = {
    proc: null,
    url: '',
    provider: '',
    status: 'stopped',
    error: ''
  };
  if (typeof settlePendingTunnelStart === 'function') {
    try {
      settlePendingTunnelStart({ success: false, status: 'stopped', url: '' });
    } catch (_) {}
  }
  publicTunnelStartPromise = null;
  return { success: true, status: 'stopped', url: '' };
}

function getSystemHubSnapshot(req) {
  const cfg = loadConfig(req);
  const localPort = Number(process.env.PORT) || (req && req.socket && req.socket.localPort) || 3001;
  const net = detectLanAddresses(localPort);
  const machineId = getMachineHardwareId();
  const isPackagedClient = process.env.EZA_PACKAGED === '1' || process.env.EZA_PACKAGED_CLIENT === '1';
  const cloudEnforced = cloudLicense.isCloudLicenseEnforced();
  const cloudSummary = cloudEnforced ? cloudLicense.getCloudLicenseSummary(machineId) : null;
  const remoteSettings = (cloudSummary && cloudSummary.remoteSettings) || {};
  const cloudCfg = cloudLicense.loadCloudLicenseConfig();
  let appVersion = '1.0.0';
  try { appVersion = require('../../../package.json').version || '1.0.0'; } catch (_) {}
  const supportContact = (cloudSummary && cloudSummary.supportContact) || remoteSettings.supportContact || cloudCfg.defaultSupportContact || 'https://t.me/ezapro_support';
  return {
    ...net,
    appVersion,
    machineId,
    isPackagedClient,
    cloudLicenseEnforced: cloudEnforced,
    cloudLicensed: Boolean(cloudSummary && cloudSummary.licensed),
    supportContact,
    cloudLicenseInfo: cloudSummary
      ? {
          planId: cloudSummary.planId || '',
          priceUsd: cloudSummary.priceUsd || 0,
          warrantySupport: cloudSummary.warrantySupport || 'standard_warranty',
          customerName: cloudSummary.customerName || '',
          maskedKey: cloudSummary.maskedKey || '',
          expiresAt: cloudSummary.expiresAt || null,
          remainingDays: cloudSummary.remainingDays,
          expiringSoon: Boolean(cloudSummary.expiringSoon),
          maxMachines: cloudSummary.maxMachines || 1,
          boundCount: cloudSummary.boundCount || 0,
          supportContact
        }
      : null,
    publicTunnelUrl: activePublicTunnel.url || '',
    publicTunnelStatus: activePublicTunnel.status || 'stopped',
    publicTunnelProvider: activePublicTunnel.provider || '',
    userAccessEnabled: cloudEnforced ? true : Boolean(cfg.USER_ACCESS_ENABLED),
    hasUserAccessCode: cloudEnforced ? true : Boolean(cfg.USER_ACCESS_CODE && String(cfg.USER_ACCESS_CODE).trim()),
    maintenanceBanner:
      (cloudEnforced && remoteSettings.maintenanceBanner) ||
      (typeof cfg.MAINTENANCE_BANNER === 'string' ? cfg.MAINTENANCE_BANNER : ''),
    maintenanceLocked: Boolean(cfg.MAINTENANCE_LOCKED),
    downloadUrl: (cloudEnforced && remoteSettings.downloadUrl) || '',
    routerDefaultLocked: false
  };
}

router.post('/public-tunnel/start', async (req, res) => {
  try {
    if (!isLoopbackNonForwardedRequest(req)) {
      return res.status(403).json({ success: false, error: 'Public tunnel control is restricted to local host only.' });
    }
    const localPort = Number(process.env.PORT) || (req && req.socket && req.socket.localPort) || 3001;
    const result = await startPublicInternetTunnel(localPort);
    return res.json({
      ...result,
      ...getSystemHubSnapshot(req)
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/public-tunnel/stop', (req, res) => {
  try {
    if (!isLoopbackNonForwardedRequest(req)) {
      return res.status(403).json({ success: false, error: 'Public tunnel control is restricted to local host only.' });
    }
    stopPublicInternetTunnel();
    return res.json({
      success: true,
      ...getSystemHubSnapshot(req)
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/system-hub', (req, res) => {
  try {
    const snap = getSystemHubSnapshot(req);
    if (!isLoopbackNonForwardedRequest(req) && !isCallerAuthorized(req)) {
      return res.json({
        success: true,
        appVersion: snap.appVersion,
        isPackagedClient: snap.isPackagedClient,
        cloudLicenseEnforced: snap.cloudLicenseEnforced,
        cloudLicensed: snap.cloudLicensed,
        supportContact: snap.supportContact,
        cloudLicenseInfo: snap.cloudLicenseInfo,
        userAccessEnabled: snap.userAccessEnabled,
        hasUserAccessCode: snap.hasUserAccessCode,
        maintenanceBanner: snap.maintenanceBanner,
        maintenanceLocked: snap.maintenanceLocked,
        downloadUrl: snap.downloadUrl,
        routerDefaultLocked: snap.routerDefaultLocked
      });
    }
    return res.json({
      success: true,
      ...snap
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/system-hub', (req, res) => {
  try {
    if (!isLoopbackNonForwardedRequest(req)) {
      return res.status(403).json({
        success: false,
        error: 'System Hub settings are restricted to local host only.'
      });
    }
    const isPackaged = process.env.EZA_PACKAGED === '1' || process.env.EZA_PACKAGED_CLIENT === '1';
    const allowAdminOverride = process.env.EZA_ADMIN_TOOLS === '1' && process.env.EZA_PACKAGED !== '1';
    if (isPackaged && !allowAdminOverride) {
      return res.status(403).json({
        success: false,
        error: 'System Hub admin settings are disabled in packaged client builds.'
      });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const updates = {};
    if (typeof body.userAccessEnabled === 'boolean') {
      updates.USER_ACCESS_ENABLED = body.userAccessEnabled;
    }
    if (typeof body.userAccessCode === 'string') {
      const code = body.userAccessCode.trim();
      if (code) updates.USER_ACCESS_CODE = hashAccessPasscode(code);
    }
    if (typeof body.maintenanceBanner === 'string') {
      updates.MAINTENANCE_BANNER = body.maintenanceBanner.trim().slice(0, 300);
    }
    if (typeof body.maintenanceLocked === 'boolean') {
      updates.MAINTENANCE_LOCKED = body.maintenanceLocked;
    }
    if (typeof body.routerDefaultLocked === 'boolean') {
      updates.ROUTER_DEFAULT_LOCKED = body.routerDefaultLocked;
    }
    saveConfig(updates);
    return res.json({
      success: true,
      ...getSystemHubSnapshot(req)
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/generate-license', (req, res) => {
  try {
    if (!isLoopbackNonForwardedRequest(req)) {
      return res.status(403).json({
        success: false,
        error: 'License generator is restricted to local host only.'
      });
    }
    const isPackaged = process.env.EZA_PACKAGED === '1' || process.env.EZA_PACKAGED_CLIENT === '1';
    const allowAdminOverride = process.env.EZA_ADMIN_TOOLS === '1' && process.env.EZA_PACKAGED !== '1';
    if (isPackaged && !allowAdminOverride) {
      return res.status(403).json({
        success: false,
        error: 'License generator is disabled in packaged client builds.'
      });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const targetMachineId = body.machineId || getMachineHardwareId();
    const durationDays = Number(body.durationDays || 0);
    let expiresTag = 'LIFETIME';
    if (Number.isFinite(durationDays) && durationDays > 0) {
      const expDate = new Date(Date.now() + durationDays * 86400000);
      expiresTag = expDate.toISOString().slice(0, 10).replace(/-/g, '');
    } else if (typeof body.expiresTag === 'string' && body.expiresTag.trim()) {
      expiresTag = body.expiresTag.trim();
    }
    const licenseKey = generateLicenseKeyForMachine(targetMachineId, expiresTag);
    return res.json({
      success: true,
      machineId: normalizeMachineId(targetMachineId),
      expiresTag,
      licenseKey
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/verify-access', async (req, res) => {
  try {
    const clientIp = getRateLimitClientKey(req);
    if (accessFailedAttempts.size > 500) {
      const nowCleanup = Date.now();
      for (const [k, v] of accessFailedAttempts.entries()) {
        if (!v || (v.lockedUntil && v.lockedUntil < nowCleanup)) accessFailedAttempts.delete(k);
      }
    }
    const attemptEntry = accessFailedAttempts.get(clientIp);
    if (attemptEntry && attemptEntry.lockedUntil > Date.now()) {
      const waitSec = Math.ceil((attemptEntry.lockedUntil - Date.now()) / 1000);
      return res.status(429).json({
        success: false,
        valid: false,
        error: `បានបញ្ចូលខុសច្រើនដងពេក។ សូមរង់ចាំ ${waitSec} វិនាទីទៀត។`
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.action === 'clear' && cloudLicense.isCloudLicenseEnforced()) {
      cloudLicense.clearStoredCloudLicenseState({ preserveKey: false });
      return res.json({ success: true, valid: false, cleared: true });
    }

    if (cloudLicense.isCloudLicenseEnforced()) {
      const machineId = getMachineHardwareId();
      const providedCode = typeof body.code === 'string' ? body.code.trim() : '';
      let appVersion = '1.0.0';
      try {
        appVersion = require('../../../package.json').version || '1.0.0';
      } catch (_) {}

      const result = await cloudLicense.verifyCloudLicenseKey({
        licenseKey: providedCode,
        machineId,
        appVersion
      });

      if (!result.valid) {
        if (providedCode && result.reason !== 'network_required' && result.reason !== 'maintenance') {
          const count = (attemptEntry ? attemptEntry.count : 0) + 1;
          accessFailedAttempts.set(clientIp, {
            count,
            lockedUntil: count >= 6 ? Date.now() + 30000 : 0
          });
        }
        const statusCode =
          result.reason === 'maintenance'
            ? 423
            : result.reason === 'network_required'
              ? 503
              : result.reason === 'missing_key'
                ? 401
                : 403;
        return res.status(statusCode).json({
          success: false,
          valid: false,
          cloudLicenseEnforced: true,
          reason: result.reason,
          error: result.error || 'License Key មិនត្រឹមត្រូវទេ។',
          minAppVersion: result.minAppVersion || '',
          maintenanceBanner: result.maintenanceBanner || '',
          downloadUrl: result.downloadUrl || '',
          supportContact: result.supportContact || ''
        });
      }

      accessFailedAttempts.delete(clientIp);
      return res.status(200).json({
        success: true,
        valid: true,
        cloudLicenseEnforced: true,
        source: result.source,
        accessToken: issueSignedAccessToken('cloud'),
        supportContact: result.supportContact || '',
        cloudLicenseInfo: {
          planId: result.planId || '',
          priceUsd: result.priceUsd || 0,
          warrantySupport: result.warrantySupport || 'standard_warranty',
          customerName: result.customerName || '',
          maskedKey: result.maskedKey || '',
          expiresAt: result.expiresAt || null,
          remainingDays: result.remainingDays,
          expiringSoon: Boolean(result.expiringSoon),
          maxMachines: result.maxMachines || 1,
          boundCount: result.boundCount || 1,
          supportContact: result.supportContact || ''
        },
        maintenanceBanner: result.maintenanceBanner || '',
        downloadUrl: result.downloadUrl || '',
        routerLocked: false
      });
    }

    const cfg = loadConfig(req);
    const enabled = Boolean(cfg.USER_ACCESS_ENABLED);
    const expected = typeof cfg.USER_ACCESS_CODE === 'string' ? cfg.USER_ACCESS_CODE.trim() : '';
    const provided = typeof body.code === 'string' ? body.code.trim() : '';
    const providedToken = typeof body.token === 'string' ? body.token.trim() : '';

    if (!enabled || !expected) {
      return res.json({ success: true, valid: true, accessToken: issueSignedAccessToken('open') });
    }
    if (providedToken && verifySignedAccessToken(providedToken, req)) {
      return res.json({ success: true, valid: true, accessToken: providedToken });
    }

    // Accept either the Admin-configured Access Passcode OR a cryptographically signed Machine License Key
    const passOk = verifyHashedPasscode(provided, expected);
    const licCheck = verifyMachineLicenseKey(provided, getMachineHardwareId());
    const valid = Boolean(passOk || licCheck.valid);

    if (!valid) {
      const count = (attemptEntry ? attemptEntry.count : 0) + 1;
      accessFailedAttempts.set(clientIp, {
        count,
        lockedUntil: count >= 6 ? Date.now() + 30000 : 0
      });
      return res.status(401).json({
        success: false,
        valid: false,
        error: licCheck.reason === 'expired'
          ? 'License Key នេះផុតកំណត់សុពលភាពហើយ។ សូមទាក់ទង Admin។'
          : 'លេខកូដចូលប្រើប្រាស់ ឬ License Key មិនត្រឹមត្រូវទេ។'
      });
    }

    accessFailedAttempts.delete(clientIp);
    return res.status(200).json({
      success: true,
      valid: true,
      accessToken: issueSignedAccessToken('verified', expected),
      expiresTag: licCheck.valid ? licCheck.expiresTag : 'PASSCODE'
    });
  } catch (err) {
    return res.status(500).json({ success: false, valid: false, error: err.message });
  }
});

// Export both router and helper functions
module.exports = router;
module.exports.loadConfig = loadConfig;
module.exports.saveConfig = saveConfig;
module.exports.detectLanAddresses = detectLanAddresses;
module.exports.getSystemHubSnapshot = getSystemHubSnapshot;
module.exports.getMachineHardwareId = getMachineHardwareId;
module.exports.generateLicenseKeyForMachine = generateLicenseKeyForMachine;
module.exports.verifyMachineLicenseKey = verifyMachineLicenseKey;
module.exports.hashAccessPasscode = hashAccessPasscode;
module.exports.verifyHashedPasscode = verifyHashedPasscode;
module.exports.issueSignedAccessToken = issueSignedAccessToken;
module.exports.verifySignedAccessToken = verifySignedAccessToken;
module.exports.isLoopbackNonForwardedRequest = isLoopbackNonForwardedRequest;
module.exports.isCallerAuthorized = isCallerAuthorized;
module.exports.getActiveGeminiApiKey = getActiveGeminiApiKey;
module.exports.getSafeGeminiAccounts = getSafeGeminiAccounts;
module.exports.addGeminiAccountRecord = addGeminiAccountRecord;
module.exports.batchAddGeminiAccountsRecord = batchAddGeminiAccountsRecord;
module.exports.parseGeminiBatchKeysInput = parseGeminiBatchKeysInput;
module.exports.updateGeminiAccountRecord = updateGeminiAccountRecord;
module.exports.switchGeminiAccountRecord = switchGeminiAccountRecord;
module.exports.deleteGeminiAccountRecord = deleteGeminiAccountRecord;
module.exports.clearGeminiAccountCooldowns = clearGeminiAccountCooldowns;
module.exports.saveGeminiApiKeyRecord = saveGeminiApiKeyRecord;
module.exports.syncAccountsFromDesktop = syncAccountsFromDesktop;
module.exports.beginGeminiStream = beginGeminiStream;
module.exports.getGeminiApiKeyCandidates = getGeminiApiKeyCandidates;
module.exports.markGeminiKeyRateLimited = markGeminiKeyRateLimited;
module.exports.markGeminiKeyHealthy = markGeminiKeyHealthy;
module.exports.isGeminiKeyRateLimited = isGeminiKeyRateLimited;
module.exports.stopPublicInternetTunnel = stopPublicInternetTunnel;
module.exports.flushUsageStats = flushUsageStats;
module.exports.getActivePublicTunnelUrl = () => activePublicTunnel.url || '';
module.exports.getRespanRuntimeConfig = getRespanRuntimeConfig;
module.exports.getSafeRespanSnapshot = getSafeRespanSnapshot;
module.exports.saveRespanConfigRecord = saveRespanConfigRecord;
module.exports.beginRespanStream = beginRespanStream;
module.exports.markRespanRateLimited = markRespanRateLimited;
module.exports.markRespanHealthy = markRespanHealthy;
module.exports.isRespanRateLimited = isRespanRateLimited;
module.exports.probeRespanConnection = probeRespanConnection;
