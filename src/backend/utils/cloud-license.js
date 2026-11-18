/**
 * EZA PRO - Cloud License Client & ECDSA P-256 Lease Verifier
 * Keeps private signing secrets strictly on Cloudflare Worker;
 * desktop client holds only the Worker URL + Public Key JWK.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'cloud-license-config.json');
const DEFAULT_GRACE_HOURS = 48;
const DEFAULT_SUPPORT_CONTACT = 'https://t.me/ezapro_support';

let cachedConfig = null;
let cachedMtime = 0;

function isTruePackagedBuild() {
  return process.env.EZA_PACKAGED === '1';
}

function compareSemver(verA = '1.0.0', verB = '1.0.0') {
  const parse = (v) =>
    String(v || '0.0.0')
      .trim()
      .replace(/^v/i, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(verA);
  const b = parse(verB);
  for (let i = 0; i < 3; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function normalizeMachineId(hwid) {
  return String(hwid || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
}

function normalizeLicenseKey(key) {
  return String(key || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
}

function loadCloudLicenseConfig() {
  let fileCfg = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const stat = fs.statSync(CONFIG_PATH);
      if (!cachedConfig || stat.mtimeMs !== cachedMtime) {
        cachedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        cachedMtime = stat.mtimeMs;
      }
      fileCfg = cachedConfig || {};
    }
  } catch (_) {}

  const allowEnvOverrides = !isTruePackagedBuild();
  let envPubJwk = null;
  if (allowEnvOverrides && process.env.EZA_CLOUD_PUBLIC_JWK) {
    try {
      envPubJwk = JSON.parse(process.env.EZA_CLOUD_PUBLIC_JWK);
    } catch (_) {}
  }
  const rawWorkerUrl = allowEnvOverrides
    ? (process.env.EZA_CLOUD_LICENSE_URL || fileCfg.workerUrl || '')
    : (fileCfg.workerUrl || '');

  return {
    workerUrl: String(rawWorkerUrl).trim().replace(/\/+$/, ''),
    publicKeyJwk: (allowEnvOverrides && envPubJwk) || fileCfg.publicKeyJwk || null,
    appId: String(fileCfg.appId || 'studio').trim().toLowerCase(),
    enforceInPackaged: fileCfg.enforceInPackaged !== false,
    offlineGraceHours: Number(fileCfg.offlineGraceHours || DEFAULT_GRACE_HOURS),
    defaultSupportContact: String(fileCfg.defaultSupportContact || DEFAULT_SUPPORT_CONTACT).trim()
  };
}

function isCloudLicenseEnforced() {
  const cfg = loadCloudLicenseConfig();
  if (isTruePackagedBuild()) {
    return Boolean(cfg.workerUrl && cfg.publicKeyJwk && cfg.enforceInPackaged);
  }
  if (process.env.EZA_REQUIRE_CLOUD_LICENSE === '0') return false;
  if (!cfg.workerUrl || !cfg.publicKeyJwk) return false;
  if (process.env.EZA_REQUIRE_CLOUD_LICENSE === '1') return true;
  return process.env.EZA_PACKAGED_CLIENT === '1' && cfg.enforceInPackaged;
}

function getCloudLicenseStatePath() {
  if (!isTruePackagedBuild() && process.env.EZA_CLOUD_LICENSE_STATE_FILE) {
    return process.env.EZA_CLOUD_LICENSE_STATE_FILE;
  }
  const baseDir =
    process.env.EZA_USER_DATA_DIR ||
    (process.env.EZA_CONFIG_FILE ? path.dirname(process.env.EZA_CONFIG_FILE) : path.join(__dirname, '..', '..', '..'));
  return path.join(baseDir, 'cloud-license-state.json');
}

let cachedVaultKeySecret = '';
let cachedVaultKeyBuf = null;

function getVaultKey() {
  let user = 'default';
  try {
    user = os.userInfo().username || 'default';
  } catch (_) {}
  const secret = `${os.platform()}:${os.arch()}:${user}:eza-pro-cloud-lease-v1`;
  if (cachedVaultKeyBuf && cachedVaultKeySecret === secret) {
    return cachedVaultKeyBuf;
  }
  cachedVaultKeySecret = secret;
  cachedVaultKeyBuf = crypto.scryptSync(secret, 'eza-pro-cloud-salt-v1', 32);
  return cachedVaultKeyBuf;
}

function getLegacyVaultKey() {
  let user = 'default';
  try {
    user = os.userInfo().username || 'default';
  } catch (_) {}
  const secret = `${os.hostname()}:${user}:eza-pro-cloud-lease-v1`;
  return crypto.scryptSync(secret, 'eza-pro-cloud-salt-v1', 32);
}

function encryptText(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getVaultKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptTextWithKey(payload, keyBuf) {
  if (typeof payload !== 'string' || !payload.includes(':')) return '';
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

function decryptText(payload) {
  try {
    return decryptTextWithKey(payload, getVaultKey());
  } catch (_) {
    try {
      return decryptTextWithKey(payload, getLegacyVaultKey());
    } catch (_legacyErr) {
      return '';
    }
  }
}

function loadStoredCloudLicenseState() {
  const filePath = getCloudLicenseStatePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const wrapper = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!wrapper || typeof wrapper.sealed !== 'string') return null;
    const rawJson = decryptText(wrapper.sealed);
    return rawJson ? JSON.parse(rawJson) : null;
  } catch (_) {
    return null;
  }
}

function saveStoredCloudLicenseState(stateObj) {
  const filePath = getCloudLicenseStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const prev = loadStoredCloudLicenseState();
  const nowMs = Date.now();
  const maxLocalSeenMs = Math.max(
    Number(prev && prev.maxLocalSeenMs) || 0,
    Number(stateObj && stateObj.maxLocalSeenMs) || 0,
    nowMs
  );
  const nextState = {
    ...(stateObj || {}),
    maxLocalSeenMs
  };
  const sealed = encryptText(JSON.stringify(nextState));
  const tmpPath = `${filePath}.${process.pid}.${nowMs}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, sealed }, null, 2), 'utf8');
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(tmpPath, filePath);
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
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

function clearStoredCloudLicenseState({ preserveKey = false } = {}) {
  const filePath = getCloudLicenseStatePath();
  if (!preserveKey) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
    return;
  }
  const existing = loadStoredCloudLicenseState();
  if (!existing || !existing.licenseKey) return;
  saveStoredCloudLicenseState({
    licenseKey: existing.licenseKey,
    leaseToken: '',
    lastVerifiedServerMs: existing.lastVerifiedServerMs || 0,
    maxLocalSeenMs: existing.maxLocalSeenMs || Date.now(),
    remoteSettings: existing.remoteSettings || {},
    lastError: existing.lastError || '',
    checkedAt: Date.now()
  });
}

function verifySignedLeaseToken(leaseToken, machineId, publicKeyJwk, nowMs = Date.now(), expectedAppId = '') {
  if (typeof leaseToken !== 'string' || !leaseToken.includes('.') || !publicKeyJwk) {
    return { valid: false, reason: 'invalid_token' };
  }
  const [payloadB64, sigB64] = leaseToken.split('.');
  if (!payloadB64 || !sigB64) {
    return { valid: false, reason: 'invalid_token' };
  }

  let payload;
  try {
    const pubKey = crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' });
    const sigOk = crypto.verify(
      'sha256',
      Buffer.from(payloadB64, 'utf8'),
      { key: pubKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sigB64, 'base64url')
    );
    if (!sigOk) {
      return { valid: false, reason: 'invalid_signature' };
    }
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (_) {
    return { valid: false, reason: 'invalid_signature' };
  }

  const normalizedHwid = normalizeMachineId(machineId);
  if (!payload || normalizeMachineId(payload.machineId) !== normalizedHwid) {
    return { valid: false, reason: 'machine_mismatch' };
  }
  if (expectedAppId && payload.appScope && payload.appScope !== 'all' && payload.appScope !== expectedAppId) {
    return { valid: false, reason: 'wrong_app', payload };
  }
  if (payload.status !== 'active') {
    return { valid: false, reason: payload.status || 'revoked' };
  }
  if (payload.expiresAt !== null && payload.expiresAt !== undefined && Number(payload.expiresAt) > 0 && nowMs > Number(payload.expiresAt)) {
    return { valid: false, reason: 'expired', payload };
  }
  if (!payload.leaseUntil || nowMs > Number(payload.leaseUntil)) {
    return { valid: false, reason: 'lease_expired', payload };
  }
  return { valid: true, payload };
}

function isClockRolledBack(stored, payload, nowMs = Date.now()) {
  if (stored && stored.maxLocalSeenMs && nowMs + 10 * 60 * 1000 < Number(stored.maxLocalSeenMs)) {
    return true;
  }
  if (stored && stored.lastVerifiedServerMs && nowMs + 3600000 < Number(stored.lastVerifiedServerMs)) {
    return true;
  }
  if (payload && payload.issuedAt && nowMs + 3600000 < Number(payload.issuedAt)) {
    return true;
  }
  return false;
}

function computeExpiryCountdown(expiresAt, nowMs = Date.now()) {
  if (expiresAt === null || expiresAt === undefined || Number(expiresAt) <= 0) {
    return { remainingDays: null, expiringSoon: false };
  }
  const diffMs = Number(expiresAt) - nowMs;
  const remainingDays = Math.max(0, Math.ceil(diffMs / 86400000));
  return {
    remainingDays,
    expiringSoon: diffMs > 0 && remainingDays <= 5
  };
}

function hasActiveLocalLease(machineId, nowMs) {
  const effectiveNow = typeof nowMs === 'number' ? nowMs : Date.now();
  const cfg = loadCloudLicenseConfig();
  const stored = loadStoredCloudLicenseState();
  if (!stored || !stored.leaseToken) return false;
  if (isClockRolledBack(stored, null, effectiveNow)) return false;
  const check = verifySignedLeaseToken(stored.leaseToken, machineId, cfg.publicKeyJwk, effectiveNow, cfg.appId);
  if (!check.valid || isClockRolledBack(stored, check.payload, effectiveNow)) return false;
  // Advance monotonic local watermark periodically during active use
  if (nowMs === undefined && effectiveNow - (Number(stored.maxLocalSeenMs) || 0) > 15 * 60 * 1000) {
    try {
      saveStoredCloudLicenseState({ ...stored, maxLocalSeenMs: effectiveNow });
    } catch (_) {}
  }
  return true;
}

function maskLicenseKey(key) {
  const clean = normalizeLicenseKey(key);
  if (!clean) return '';
  const parts = clean.split('-');
  if (parts.length < 3) return `${clean.slice(0, 4)}****`;
  return `${parts[0]}-${parts[1]}-****-${parts[parts.length - 1]}`;
}

function getCloudLicenseSummary(machineId, nowMs = Date.now()) {
  const cfg = loadCloudLicenseConfig();
  const stored = loadStoredCloudLicenseState();
  const remoteSettings = (stored && stored.remoteSettings) || {};
  const supportContact = remoteSettings.supportContact || cfg.defaultSupportContact;
  if (!stored || !stored.leaseToken) {
    return {
      licensed: false,
      maskedKey: stored && stored.licenseKey ? maskLicenseKey(stored.licenseKey) : '',
      planId: '',
      priceUsd: 0,
      warrantySupport: 'standard_warranty',
      customerName: '',
      expiresAt: null,
      remainingDays: null,
      expiringSoon: false,
      maxMachines: 1,
      boundCount: 0,
      supportContact,
      lastError: (stored && stored.lastError) || '',
      remoteSettings
    };
  }
  const check = verifySignedLeaseToken(stored.leaseToken, machineId, cfg.publicKeyJwk, nowMs, cfg.appId);
  const payload = check.payload || {};
  const validNow = Boolean(check.valid) && !isClockRolledBack(stored, payload, nowMs);
  const expiresAt = payload.expiresAt || null;
  const countdown = computeExpiryCountdown(expiresAt, nowMs);
  return {
    licensed: validNow,
    maskedKey: maskLicenseKey(stored.licenseKey || payload.licenseKey || ''),
    planId: String(payload.planId || (expiresAt === null ? 'lifetime' : 'monthly_10')),
    priceUsd: Number.isFinite(Number(payload.priceUsd)) ? Number(payload.priceUsd) : 0,
    warrantySupport: String(payload.warrantySupport || 'standard_warranty'),
    customerName: String(payload.customerName || ''),
    expiresAt,
    remainingDays: countdown.remainingDays,
    expiringSoon: countdown.expiringSoon,
    maxMachines: Math.max(1, Number(payload.maxMachines || stored.maxMachines || 1)),
    boundCount: Math.max(0, Number(payload.boundCount || stored.boundCount || (validNow ? 1 : 0))),
    leaseUntil: payload.leaseUntil || null,
    supportContact: payload.supportContact || supportContact,
    lastError: (stored && stored.lastError) || '',
    remoteSettings
  };
}

function getLocalLicenseSnapshot(machineId, nowMs = Date.now()) {
  const summary = getCloudLicenseSummary(machineId, nowMs);
  return {
    valid: summary.licensed,
    ...summary
  };
}

async function verifyCloudLicenseKey({ licenseKey = '', machineId, appVersion = '1.0.0', fetchImpl = null } = {}) {
  const cfg = loadCloudLicenseConfig();
  if (!cfg.workerUrl || !cfg.publicKeyJwk) {
    return {
      valid: false,
      source: 'config',
      reason: 'not_configured',
      supportContact: cfg.defaultSupportContact,
      error: 'Cloud License Server មិនទាន់ត្រូវបានកំណត់រចនាសម្ព័ន្ធទេ។'
    };
  }

  const stored = loadStoredCloudLicenseState();
  const keyToUse = normalizeLicenseKey(licenseKey || (stored && stored.licenseKey) || '');
  const cleanHwid = normalizeMachineId(machineId);

  if (!keyToUse) {
    return {
      valid: false,
      source: 'local',
      reason: 'missing_key',
      supportContact: (stored && stored.remoteSettings && stored.remoteSettings.supportContact) || cfg.defaultSupportContact,
      error: 'សូមបញ្ចូល License Key ដើម្បីចូលប្រើប្រាស់កម្មវិធី។'
    };
  }

  const doFetch = fetchImpl || global.fetch;
  if (typeof doFetch !== 'function') {
    return {
      valid: false,
      source: 'config',
      reason: 'no_fetch',
      supportContact: cfg.defaultSupportContact,
      error: 'HTTP client មិនដំណើរការ។'
    };
  }

  try {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 8500) : null;
    let res;
    try {
      res = await doFetch(`${cfg.workerUrl}/api/license/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          licenseKey: keyToUse,
          machineId: cleanHwid,
          appId: cfg.appId,
          appVersion
        }),
        signal: controller ? controller.signal : undefined
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    const data = await res.json().catch(() => null);
    if (res.status >= 500) {
      throw new Error(`Cloud server temporary error (${res.status})`);
    }
    if (res.status === 429 && (!data || typeof data !== 'object')) {
      const rateErr = 'ប្រព័ន្ធមមាញឹកបន្តិច (Rate Limited)។ សូមរង់ចាំបន្តិច រួចព្យាយាមម្ដងទៀត។';
      return {
        valid: false,
        source: 'cloud',
        reason: 'rate_limited',
        supportContact: cfg.defaultSupportContact,
        error: rateErr
      };
    }
    if (!data || typeof data !== 'object') {
      throw new Error(`Cloud server unexpected response (${res.status})`);
    }

    if (!res.ok || !data.valid) {
      const reason = data.reason || (res.status === 429 ? 'rate_limited' : 'rejected');
      const errMsg = data.error || 'License Key មិនមានសិទ្ធិប្រើប្រាស់ទេ។';
      const keepKeyReasons = new Set(['maintenance', 'lease_expired', 'rate_limited', 'expired', 'outdated_version']);
      if (keepKeyReasons.has(reason)) {
        const prevSettings = (stored && stored.remoteSettings) || {};
        saveStoredCloudLicenseState({
          licenseKey: keyToUse,
          leaseToken: reason === 'rate_limited' && stored ? (stored.leaseToken || '') : '',
          lastVerifiedServerMs: (stored && stored.lastVerifiedServerMs) || Date.now(),
          maxLocalSeenMs: (stored && stored.maxLocalSeenMs) || Date.now(),
          lastError: errMsg,
          remoteSettings: {
            ...prevSettings,
            maintenanceBanner: data.maintenanceBanner || '',
            downloadUrl: data.downloadUrl || prevSettings.downloadUrl || '',
            minAppVersion: data.minAppVersion || prevSettings.minAppVersion || '',
            supportContact: data.supportContact || prevSettings.supportContact || cfg.defaultSupportContact
          },
          checkedAt: Date.now()
        });
      } else {
        clearStoredCloudLicenseState({ preserveKey: false });
      }
      return {
        valid: false,
        source: 'cloud',
        reason,
        error: errMsg,
        expiresAt: data.expiresAt || null,
        maxMachines: data.maxMachines || 1,
        boundCount: data.boundCount || 0,
        minAppVersion: data.minAppVersion || '',
        maintenanceBanner: data.maintenanceBanner || '',
        maintenanceLocked: Boolean(data.maintenanceLocked),
        downloadUrl: data.downloadUrl || '',
        supportContact: data.supportContact || cfg.defaultSupportContact
      };
    }

    if (data.minAppVersion && compareSemver(appVersion, data.minAppVersion) < 0) {
      const verErr = `សូមអាប់ដេតកម្មវិធីទៅជំនាន់ v${data.minAppVersion} ជាមុនសិន។`;
      saveStoredCloudLicenseState({
        licenseKey: keyToUse,
        leaseToken: '',
        lastError: verErr,
        remoteSettings: {
          maintenanceBanner: String(data.maintenanceBanner || ''),
          minAppVersion: String(data.minAppVersion || ''),
          downloadUrl: String(data.downloadUrl || ''),
          supportContact: String(data.supportContact || cfg.defaultSupportContact),
          routerLocked: Boolean(data.routerLocked)
        },
        checkedAt: Date.now()
      });
      return {
        valid: false,
        source: 'cloud',
        reason: 'outdated_version',
        minAppVersion: String(data.minAppVersion),
        downloadUrl: String(data.downloadUrl || ''),
        supportContact: String(data.supportContact || cfg.defaultSupportContact),
        error: verErr
      };
    }

    const verifyTimeMs = Number(data.serverNow) > 0 ? Number(data.serverNow) : Date.now();
    const sigCheck = verifySignedLeaseToken(data.leaseToken, cleanHwid, cfg.publicKeyJwk, verifyTimeMs, cfg.appId);
    if (!sigCheck.valid) {
      clearStoredCloudLicenseState({ preserveKey: sigCheck.reason === 'lease_expired' });
      return {
        valid: false,
        source: 'cloud',
        reason: sigCheck.reason || 'invalid_signature',
        supportContact: data.supportContact || cfg.defaultSupportContact,
        error: sigCheck.reason === 'wrong_app'
          ? 'License Key នេះមិនអនុញ្ញាតឲ្យប្រើជាមួយកម្មវិធីនេះទេ។'
          : (sigCheck.reason === 'lease_expired'
            ? 'ម៉ោងលើកុំព្យូទ័រអាចខុសគ្នាពីម៉ោង Server — សូមពិនិត្យកាលបរិច្ឆេទ និងម៉ោងលើ Windows។'
            : 'ការផ្ទៀងផ្ទាត់សុវត្ថិភាព License មិនត្រឹមត្រូវទេ។')
      };
    }

    const supportContact = String(data.supportContact || sigCheck.payload.supportContact || cfg.defaultSupportContact);
    const remoteSettings = {
      maintenanceBanner: String(data.maintenanceBanner || ''),
      minAppVersion: String(data.minAppVersion || ''),
      downloadUrl: String(data.downloadUrl || ''),
      supportContact,
      routerLocked: Boolean(data.routerLocked)
    };

    const nowLocalMs = Date.now();
    const expiresAt = data.expiresAt !== undefined ? data.expiresAt : (sigCheck.payload.expiresAt || null);
    const countdown = computeExpiryCountdown(expiresAt, verifyTimeMs);
    const maxMachines = Math.max(1, Number(data.maxMachines || sigCheck.payload.maxMachines || 1));
    const boundCount = Math.max(1, Number(data.boundCount || sigCheck.payload.boundCount || 1));
    const planId = String(data.planId || sigCheck.payload.planId || (expiresAt === null ? 'lifetime' : 'monthly_10'));
    const priceUsd = Number.isFinite(Number(data.priceUsd)) ? Number(data.priceUsd) : (Number(sigCheck.payload.priceUsd) || 0);
    const warrantySupport = String(data.warrantySupport || sigCheck.payload.warrantySupport || 'standard_warranty');

    saveStoredCloudLicenseState({
      licenseKey: keyToUse,
      leaseToken: data.leaseToken,
      maxMachines,
      boundCount,
      lastError: '',
      lastVerifiedServerMs: Math.max(nowLocalMs, Number(data.serverNow) || 0, Number(sigCheck.payload && sigCheck.payload.issuedAt) || 0),
      maxLocalSeenMs: nowLocalMs,
      remoteSettings,
      checkedAt: nowLocalMs
    });

    return {
      valid: true,
      source: 'cloud',
      appScope: data.appScope || sigCheck.payload.appScope || 'all',
      planId,
      priceUsd,
      warrantySupport,
      customerName: data.customerName || sigCheck.payload.customerName || '',
      maskedKey: maskLicenseKey(keyToUse),
      expiresAt: expiresAt || null,
      remainingDays: countdown.remainingDays,
      expiringSoon: countdown.expiringSoon,
      maxMachines,
      boundCount,
      leaseUntil: sigCheck.payload.leaseUntil,
      maintenanceBanner: remoteSettings.maintenanceBanner,
      minAppVersion: remoteSettings.minAppVersion,
      downloadUrl: remoteSettings.downloadUrl,
      supportContact,
      routerLocked: remoteSettings.routerLocked
    };
  } catch (networkErr) {
    // Only allow limited offline grace lease when server is unreachable (never when revoked or clock rolled back)
    if (stored && stored.leaseToken && normalizeLicenseKey(stored.licenseKey) === keyToUse) {
      const nowOfflineMs = Date.now();
      const graceCheck = verifySignedLeaseToken(stored.leaseToken, cleanHwid, cfg.publicKeyJwk, nowOfflineMs, cfg.appId);
      if (graceCheck.valid && !isClockRolledBack(stored, graceCheck.payload, nowOfflineMs)) {
        const remoteSettings = stored.remoteSettings || {};
        const expiresAt = graceCheck.payload.expiresAt || null;
        const countdown = computeExpiryCountdown(expiresAt, nowOfflineMs);
        return {
          valid: true,
          source: 'offline_grace',
          planId: String(graceCheck.payload.planId || (expiresAt === null ? 'lifetime' : 'monthly_10')),
          priceUsd: Number(graceCheck.payload.priceUsd) || 0,
          warrantySupport: String(graceCheck.payload.warrantySupport || 'standard_warranty'),
          customerName: graceCheck.payload.customerName || '',
          maskedKey: maskLicenseKey(keyToUse),
          expiresAt,
          remainingDays: countdown.remainingDays,
          expiringSoon: countdown.expiringSoon,
          maxMachines: Math.max(1, Number(graceCheck.payload.maxMachines || stored.maxMachines || 1)),
          boundCount: Math.max(1, Number(graceCheck.payload.boundCount || stored.boundCount || 1)),
          leaseUntil: graceCheck.payload.leaseUntil,
          maintenanceBanner: remoteSettings.maintenanceBanner || '',
          downloadUrl: remoteSettings.downloadUrl || '',
          supportContact: remoteSettings.supportContact || cfg.defaultSupportContact,
          routerLocked: Boolean(remoteSettings.routerLocked)
        };
      }
    }
    return {
      valid: false,
      source: 'offline',
      reason: 'network_required',
      supportContact: (stored && stored.remoteSettings && stored.remoteSettings.supportContact) || cfg.defaultSupportContact,
      error: 'មិនអាចភ្ជាប់ Cloud Server បានទេ។ សូមពិនិត្យអ៊ីនធឺណិត រួចព្យាយាមម្ដងទៀត។',
      detail: networkErr && networkErr.message ? networkErr.message : ''
    };
  }
}

module.exports = {
  isTruePackagedBuild,
  compareSemver,
  normalizeMachineId,
  normalizeLicenseKey,
  loadCloudLicenseConfig,
  isCloudLicenseEnforced,
  getCloudLicenseStatePath,
  loadStoredCloudLicenseState,
  saveStoredCloudLicenseState,
  clearStoredCloudLicenseState,
  verifySignedLeaseToken,
  isClockRolledBack,
  computeExpiryCountdown,
  hasActiveLocalLease,
  getCloudLicenseSummary,
  getLocalLicenseSnapshot,
  verifyCloudLicenseKey,
  maskLicenseKey
};
