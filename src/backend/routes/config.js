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

function getVaultKey() {
  let user = 'default';
  try {
    user = os.userInfo().username || 'default';
  } catch (_) {}
  const secret = `${os.hostname()}:${user}:eza-pro-gemini-vault-v1`;
  return crypto.scryptSync(secret, 'eza-pro-salt-v1', 32);
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

function loadGeminiAccountsStore() {
  const filePath = getAccountsFilePath();
  if (!fs.existsSync(filePath)) {
    return { accounts: [], activeAccountId: null };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || !Array.isArray(raw.accounts)) {
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
    return { accounts, activeAccountId };
  } catch (_) {
    return { accounts: [], activeAccountId: null };
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
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(serialized, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

const STREAM_VISUAL_HOLD_MS = 2800;
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
    try {
      const store = loadGeminiAccountsStore();
      if (!store.accounts.length) {
        pendingUsageByHash.clear();
        return;
      }
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
    } catch (_) {
      pendingUsageByHash.clear();
    }
  }, 1500);
  if (typeof usageFlushTimer.unref === 'function') {
    usageFlushTimer.unref();
  }
}

function beginGeminiStream(apiKey, taskLabel = 'Gemini API') {
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
    lastLatencyMs: null
  };
  entry.activeCount += 1;
  entry.totalRequests += 1;
  entry.recentUntil = now + STREAM_VISUAL_HOLD_MS;
  entry.lastTask = String(taskLabel || 'Gemini API');
  entry.lastStatus = 'streaming';
  geminiTelemetryByHash.set(keyHash, entry);

  pendingUsageByHash.set(keyHash, (pendingUsageByHash.get(keyHash) || 0) + 1);
  scheduleUsageFlush();

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
  const until = geminiKeyCooldownByScope.get(k) || 0;
  if (until <= Date.now()) {
    if (until > 0) geminiKeyCooldownByScope.delete(k);
    return false;
  }
  return true;
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
  if (process.env.GEMINI_API_KEY) {
    pushUnique(process.env.GEMINI_API_KEY);
  }

  const healthy = ordered.filter(k => !isGeminiKeyRateLimited(k, scope));
  if (healthy.length === 0) {
    return options.skipAllRateLimited ? [] : ordered;
  }
  if (healthy.length === 1 || options.preferPrimary) return healthy;

  // Smart load-balancing: rotate starting position and prefer idle + lower-latency accounts first
  const offset = smartRouterCursor % healthy.length;
  smartRouterCursor = (smartRouterCursor + 1) % 1000000;
  const rotated = healthy.slice(offset).concat(healthy.slice(0, offset));

  return rotated
    .map((key, idx) => {
      const tel = geminiTelemetryByHash.get(hashApiKeyForTelemetry(key));
      const activeCount = tel ? (tel.activeCount || 0) : 0;
      const ewma = tel && tel.ewmaLatencyMs ? tel.ewmaLatencyMs : 0;
      const slowPenalty = ewma > 9000 ? 1 : 0;
      const recentErrPenalty = tel && tel.lastStatus === 'error' ? 1 : 0;
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
  data.accounts.splice(idx, 1);
  if (data.activeAccountId === accountId.trim()) {
    data.activeAccountId = data.accounts.length > 0 ? data.accounts[0].id : null;
  }
  saveGeminiAccountsStore(data);
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
      const keyIdx = parts.findIndex(p => /^(AIza|AQ\.)/i.test(p) || p.length >= 20);
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

function syncAccountsFromDesktop(desktopData) {
  if (!desktopData || !Array.isArray(desktopData.accounts) || desktopData.accounts.length === 0) return;
  try {
    const store = loadGeminiAccountsStore();
    const byId = new Map(store.accounts.map(a => [a.id, a]));
    const byKey = new Map(store.accounts.map(a => [a.apiKey, a]));
    for (const acc of desktopData.accounts) {
      if (!acc || typeof acc.apiKey !== 'string' || !acc.apiKey.trim()) continue;
      const key = acc.apiKey.trim();
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
    if (desktopData.activeAccountId) {
      const matched = store.accounts.find(a => a.id === desktopData.activeAccountId);
      if (matched) store.activeAccountId = matched.id;
    }
    if (!store.activeAccountId && store.accounts.length > 0) {
      store.activeAccountId = store.accounts[0].id;
    }
    saveGeminiAccountsStore(store);
  } catch (_) {}
}

/**
 * Load configuration from disk
 */
function loadConfig(req = null) {
  let cfg = {
    GEMINI_API_KEY: '',
    DOWNLOAD_DIR: 'D:\\HDRG'
  };

  // Try loading from config.json
  const configFile = getConfigFilePath();
  if (fs.existsSync(configFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      cfg = { ...cfg, ...data };
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

  // Fallback to process.env
  if (!cfg.GEMINI_API_KEY && process.env.GEMINI_API_KEY) {
    cfg.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  }

  // Try loading from .env file (ignoring commented lines)
  if (!cfg.GEMINI_API_KEY) {
    const envFile = path.join(__dirname, '..', '..', '..', '.env');
    if (fs.existsSync(envFile)) {
      try {
        const envData = fs.readFileSync(envFile, 'utf8');
        const match = envData.match(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*?)\s*$/m);
        if (match) {
          const parsedKey = match[1].replace(/^(['"])(.*)\1$/, '$2').trim();
          if (parsedKey) {
            cfg.GEMINI_API_KEY = parsedKey;
          }
        }
      } catch (_) {}
    }
  }

  return cfg;
}

/**
 * Save configuration to disk
 */
function saveConfig(cfg) {
  try {
    const configFile = getConfigFilePath();
    const existing = fs.existsSync(configFile) 
      ? JSON.parse(fs.readFileSync(configFile, 'utf8'))
      : {};
    
    const merged = { ...existing, ...cfg };
    fs.writeFileSync(configFile, JSON.stringify(merged, null, 2), 'utf8');
    
    return true;
  } catch (err) {
    console.error('Failed to save config:', err);
    throw err;
  }
}

/**
 * GET /api/config
 * Get current configuration (without sensitive data)
 */
router.get('/', (req, res) => {
  try {
    const cfg = loadConfig(req);
    res.json({ 
      success: true, 
      config: {
        DOWNLOAD_DIR: cfg.DOWNLOAD_DIR,
        hasApiKey: !!cfg.GEMINI_API_KEY
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
    saveConfig(req.body);
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
    return res.json({ success: true, ...result });
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
    const stream = beginGeminiStream(apiKey, 'Connection Test');
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models?pageSize=1&key=${encodeURIComponent(apiKey)}`,
      method: 'GET',
      family: 4,
      timeout: 6500
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        stream.end(ok, res.statusCode);
        resolve({
          healthy: ok,
          statusCode: res.statusCode,
          latencyMs: Date.now() - started,
          error: ok ? '' : `HTTP ${res.statusCode}`
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', (err) => {
      stream.end(false, 502);
      resolve({
        healthy: false,
        statusCode: 0,
        latencyMs: Date.now() - started,
        error: err.message
      });
    });
    req.end();
  });
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
 * Probe every saved Gemini account concurrently without exposing API keys
 */
router.post('/accounts/test-all', async (req, res) => {
  try {
    const store = loadGeminiAccountsStore();
    const enabledAccounts = store.accounts.filter(acc => acc.enabled !== false);
    const results = await Promise.all(enabledAccounts.map(async (acc) => {
      const probe = await probeGeminiKey(acc.apiKey);
      return {
        accountId: acc.id,
        name: acc.name,
        ...probe
      };
    }));
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

function getMachineHardwareId() {
  try {
    const cpus = os.cpus() || [];
    const cpuModel = cpus[0] ? cpus[0].model : 'generic-cpu';
    const raw = `${os.platform()}|${os.arch()}|${os.hostname()}|${cpuModel}|${cpus.length}`;
    const digest = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
    return `EZA-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`;
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

function issueSignedAccessToken(subject = 'user') {
  const issuedAt = Date.now();
  const payload = `${subject}.${issuedAt}`;
  const sig = crypto
    .createHmac('sha256', getVaultKey())
    .update(payload)
    .digest('hex');
  return `${payload}.${sig}`;
}

function verifySignedAccessToken(token) {
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
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

const { spawn } = require('child_process');
let activePublicTunnel = {
  proc: null,
  url: '',
  provider: '',
  status: 'stopped',
  error: ''
};

function startPublicInternetTunnel(targetPort = 3001) {
  if (activePublicTunnel.proc && activePublicTunnel.url) {
    return Promise.resolve({
      success: true,
      url: activePublicTunnel.url,
      provider: activePublicTunnel.provider,
      status: 'running'
    });
  }
  stopPublicInternetTunnel();

  const port = Number(process.env.PORT) || Number(targetPort) || 3001;
  const localCloudflared = path.join(__dirname, '..', '..', '..', 'tools', 'cloudflared.exe');
  const hasLocalCloudflared = fs.existsSync(localCloudflared);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const launchSshFallback = () => {
      activePublicTunnel.provider = 'localhost.run (SSH HTTPS)';
      activePublicTunnel.status = 'starting';
      activePublicTunnel.error = '';
      const sshBin = process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe')
        ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
        : 'ssh';
      const proc = spawn(sshBin, [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
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
      proc.on('error', () => launchSshFallback());
    } else {
      launchSshFallback();
    }

    setTimeout(() => {
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
  });
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
  return { success: true, status: 'stopped', url: '' };
}

function getSystemHubSnapshot(req) {
  const cfg = loadConfig(req);
  const net = detectLanAddresses(3001);
  const machineId = getMachineHardwareId();
  const isPackagedClient = process.env.EZA_PACKAGED_CLIENT === '1';
  const cloudEnforced = cloudLicense.isCloudLicenseEnforced();
  const cloudSummary = cloudEnforced ? cloudLicense.getCloudLicenseSummary(machineId) : null;
  const remoteSettings = (cloudSummary && cloudSummary.remoteSettings) || {};
  return {
    ...net,
    machineId,
    isPackagedClient,
    cloudLicenseEnforced: cloudEnforced,
    cloudLicensed: Boolean(cloudSummary && cloudSummary.licensed),
    cloudLicenseInfo: cloudSummary
      ? {
          customerName: cloudSummary.customerName || '',
          maskedKey: cloudSummary.maskedKey || '',
          expiresAt: cloudSummary.expiresAt || null
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
    routerDefaultLocked: (cloudEnforced && remoteSettings.routerLocked) || Boolean(cfg.ROUTER_DEFAULT_LOCKED)
  };
}

router.post('/public-tunnel/start', async (req, res) => {
  try {
    const result = await startPublicInternetTunnel(3001);
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
    return res.json({
      success: true,
      ...getSystemHubSnapshot(req)
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/system-hub', (req, res) => {
  try {
    if (process.env.EZA_PACKAGED_CLIENT === '1' && process.env.EZA_ADMIN_TOOLS !== '1') {
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
    if (process.env.EZA_PACKAGED_CLIENT === '1' && process.env.EZA_ADMIN_TOOLS !== '1') {
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
    const clientIp = String(req.ip || (req.socket && req.socket.remoteAddress) || 'local');
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
          maintenanceBanner: result.maintenanceBanner || '',
          downloadUrl: result.downloadUrl || ''
        });
      }

      accessFailedAttempts.delete(clientIp);
      return res.status(200).json({
        success: true,
        valid: true,
        cloudLicenseEnforced: true,
        source: result.source,
        accessToken: issueSignedAccessToken('cloud'),
        cloudLicenseInfo: {
          customerName: result.customerName || '',
          maskedKey: result.maskedKey || '',
          expiresAt: result.expiresAt || null
        },
        maintenanceBanner: result.maintenanceBanner || '',
        downloadUrl: result.downloadUrl || '',
        routerLocked: Boolean(result.routerLocked)
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
    if (providedToken && verifySignedAccessToken(providedToken)) {
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
      accessToken: issueSignedAccessToken('verified'),
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
