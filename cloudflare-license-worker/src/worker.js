import { renderAdminHtml } from './admin-ui.js';

const OFFLINE_GRACE_MS = 48 * 60 * 60 * 1000;

export const COMMERCIAL_PLANS = {
  monthly_10: {
    planId: 'monthly_10',
    label: '$10 / ខែ (30 ថ្ងៃ)',
    priceUsd: 10,
    durationDays: 30,
    warrantySupport: 'standard_warranty'
  },
  yearly_50: {
    planId: 'yearly_50',
    label: '$50 / ឆ្នាំ (365 ថ្ងៃ)',
    priceUsd: 50,
    durationDays: 365,
    warrantySupport: 'vip_warranty'
  },
  quarterly_25: {
    planId: 'quarterly_25',
    label: '90 ថ្ងៃ (3 ខែ)',
    priceUsd: 25,
    durationDays: 90,
    warrantySupport: 'standard_warranty'
  },
  trial_7: {
    planId: 'trial_7',
    label: 'សាកល្បង 7 ថ្ងៃ',
    priceUsd: 0,
    durationDays: 7,
    warrantySupport: 'trial_support'
  },
  lifetime: {
    planId: 'lifetime',
    label: 'Lifetime',
    priceUsd: 0,
    durationDays: 0,
    warrantySupport: 'vip_warranty'
  }
};

let schemaReadyPromise = null;
let cachedSigningKey = null;
let cachedPrivateKeyStr = '';
const verifyFailRateMap = new Map();
const adminLoginFailMap = new Map();

function pruneRateMap(map, now) {
  if (map.size <= 500) return;
  for (const [k, v] of map.entries()) {
    if (!v || now > v.resetAt) map.delete(k);
  }
}

function isRateLimited(map, key, maxCount, windowMs, now = Date.now()) {
  if (!key) return false;
  pruneRateMap(map, now);
  const entry = map.get(key);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= maxCount;
}

function recordRateFailure(map, key, windowMs, now = Date.now()) {
  if (!key) return;
  pruneRateMap(map, now);
  const entry = map.get(key);
  if (!entry || now > entry.resetAt) {
    map.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    entry.count += 1;
  }
}

export function compareSemver(verA = '1.0.0', verB = '1.0.0') {
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

export function normalizePlanSpec(rawPlanId, rawDays, rawPriceUsd) {
  const cleanId = String(rawPlanId || '').trim().toLowerCase();
  if (COMMERCIAL_PLANS[cleanId]) {
    const preset = COMMERCIAL_PLANS[cleanId];
    const parsedDays = Number(rawDays);
    const durationDays = Number.isFinite(parsedDays) && parsedDays >= 0 ? Math.round(parsedDays) : preset.durationDays;
    const parsedPrice = Number(rawPriceUsd);
    const priceUsd = Number.isFinite(parsedPrice) && parsedPrice >= 0 ? parsedPrice : preset.priceUsd;
    return {
      planId: preset.planId,
      priceUsd,
      durationDays,
      warrantySupport: preset.warrantySupport
    };
  }
  const days = Number.isFinite(Number(rawDays)) && Number(rawDays) >= 0 ? Math.round(Number(rawDays)) : 30;
  if (days === 0) return { ...COMMERCIAL_PLANS.lifetime };
  if (days === 30) return { ...COMMERCIAL_PLANS.monthly_10 };
  if (days === 365) return { ...COMMERCIAL_PLANS.yearly_50 };
  if (days === 90) return { ...COMMERCIAL_PLANS.quarterly_25 };
  if (days === 7) return { ...COMMERCIAL_PLANS.trial_7 };
  const parsedPrice = Number(rawPriceUsd);
  return {
    planId: 'custom',
    priceUsd: Number.isFinite(parsedPrice) && parsedPrice >= 0 ? parsedPrice : 0,
    durationDays: days,
    warrantySupport: 'standard_warranty'
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders
    }
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff'
    }
  });
}

function toBase64Url(bytes) {
  let binary = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

function normalizeAppScope(scope) {
  const val = String(scope || '').trim().toLowerCase();
  if (val === 'studio' || val === 'ezarg') return 'studio';
  if (val === 'downloader' || val === 'eza_pro' || val === 'eza-pro-downloader') return 'downloader';
  return 'all';
}

function normalizeClientAppId(appId) {
  const val = String(appId || '').trim().toLowerCase();
  if (val === 'downloader' || val === 'eza-pro-downloader' || val === 'eza_pro') return 'downloader';
  return 'studio';
}

function generateLicenseKeyString() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let part = '';
    for (let i = 0; i < 4; i++) {
      part += alphabet[bytes[g * 4 + i] % alphabet.length];
    }
    groups.push(part);
  }
  return `EZAPRO-${groups.join('-')}`;
}

async function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode('eza-pro-admin-compare-v1'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(String(a || ''))),
    crypto.subtle.sign('HMAC', key, enc.encode(String(b || '')))
  ]);
  const arrA = new Uint8Array(sigA);
  const arrB = new Uint8Array(sigB);
  if (arrA.length !== arrB.length) return false;
  let diff = 0;
  for (let i = 0; i < arrA.length; i++) diff |= arrA[i] ^ arrB[i];
  return diff === 0;
}

async function getSigningKey(privateKeyJson) {
  if (!privateKeyJson) {
    throw new Error('LEASE_PRIVATE_JWK secret is not configured on Cloudflare Worker.');
  }
  if (cachedSigningKey && cachedPrivateKeyStr === privateKeyJson) {
    return cachedSigningKey;
  }
  const jwk = JSON.parse(privateKeyJson);
  cachedSigningKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  cachedPrivateKeyStr = privateKeyJson;
  return cachedSigningKey;
}

async function signLeaseToken(env, payloadObj) {
  const key = await getSigningKey(env.LEASE_PRIVATE_JWK);
  const enc = new TextEncoder();
  const payloadB64 = toBase64Url(enc.encode(JSON.stringify(payloadObj)));
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(payloadB64)
  );
  const sigB64 = toBase64Url(new Uint8Array(sigBuf));
  return `${payloadB64}.${sigB64}`;
}

async function ensureSchema(db) {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS licenses (
          license_key TEXT PRIMARY KEY,
          customer_name TEXT NOT NULL DEFAULT '',
          contact TEXT NOT NULL DEFAULT '',
          app_scope TEXT NOT NULL DEFAULT 'all',
          plan_id TEXT NOT NULL DEFAULT 'monthly_10',
          price_usd REAL NOT NULL DEFAULT 10,
          duration_days INTEGER NOT NULL DEFAULT 30,
          first_activated_at INTEGER,
          warranty_support TEXT NOT NULL DEFAULT 'standard_warranty',
          status TEXT NOT NULL DEFAULT 'active',
          max_machines INTEGER NOT NULL DEFAULT 1,
          bound_machines TEXT NOT NULL DEFAULT '[]',
          expires_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_seen_at INTEGER,
          last_machine_id TEXT DEFAULT '',
          last_app_version TEXT DEFAULT '',
          verify_count INTEGER NOT NULL DEFAULT 0
        )`
      ).run();
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL
        )`
      ).run();
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          license_key TEXT DEFAULT '',
          machine_id TEXT DEFAULT '',
          event TEXT NOT NULL,
          detail TEXT DEFAULT '',
          ip TEXT DEFAULT '',
          created_at INTEGER NOT NULL
        )`
      ).run();
      const migrations = [
        "ALTER TABLE licenses ADD COLUMN app_scope TEXT NOT NULL DEFAULT 'all'",
        "ALTER TABLE licenses ADD COLUMN plan_id TEXT NOT NULL DEFAULT 'monthly_10'",
        "ALTER TABLE licenses ADD COLUMN price_usd REAL NOT NULL DEFAULT 10",
        "ALTER TABLE licenses ADD COLUMN duration_days INTEGER NOT NULL DEFAULT 30",
        "ALTER TABLE licenses ADD COLUMN first_activated_at INTEGER",
        "ALTER TABLE licenses ADD COLUMN warranty_support TEXT NOT NULL DEFAULT 'standard_warranty'"
      ];
      for (const sql of migrations) {
        try {
          await db.prepare(sql).run();
        } catch (_) {}
      }
    })().catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }
  return schemaReadyPromise;
}

async function loadSettingsMap(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const map = {
    maintenance_banner: '',
    maintenance_locked: '0',
    min_app_version: '1.0.0',
    download_url: '',
    support_contact: 'https://t.me/ezapro_support',
    router_locked: '0'
  };
  for (const row of results || []) {
    if (row && row.key) map[row.key] = String(row.value || '');
  }
  return map;
}

async function logAudit(db, { licenseKey = '', machineId = '', event, detail = '', ip = '' }) {
  try {
    await db
      .prepare(
        'INSERT INTO audit_logs (license_key, machine_id, event, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(licenseKey, machineId, event, String(detail || '').slice(0, 300), String(ip || '').slice(0, 64), Date.now())
      .run();
  } catch (_) {}
}

function parseBoundMachines(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeMachineId).filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function verifyAdminRequest(request, env) {
  const expected = String(env.ADMIN_SECRET || '').trim();
  if (!expected) return false;
  const headerToken = request.headers.get('x-admin-secret') || '';
  const authHeader = request.headers.get('authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const candidate = (headerToken || bearer).trim();
  if (!candidate) return false;
  return constantTimeEqual(candidate, expected);
}

async function handlePublicVerify(request, env) {
  await ensureSchema(env.DB);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const now = Date.now();

  if (isRateLimited(verifyFailRateMap, ip, 25, 60 * 1000, now)) {
    return jsonResponse(
      {
        success: false,
        valid: false,
        reason: 'rate_limited',
        error: 'បានព្យាយាមផ្ទៀងផ្ទាត់ញឹកញាប់ពេក។ សូមរង់ចាំ ១ នាទីសិន។'
      },
      429
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    recordRateFailure(verifyFailRateMap, ip, 60 * 1000, now);
    return jsonResponse({ success: false, valid: false, error: 'ទម្រង់ទិន្នន័យមិនត្រឹមត្រូវ។' }, 400);
  }

  const licenseKey = normalizeLicenseKey(body.licenseKey || body.code);
  const machineId = normalizeMachineId(body.machineId);
  const appId = normalizeClientAppId(body.appId);
  const appVersion = String(body.appVersion || '1.0.0').trim().slice(0, 20);
  const recordedClientTag = `${appId} v${appVersion}`.slice(0, 32);

  if (!licenseKey || licenseKey.length < 8) {
    recordRateFailure(verifyFailRateMap, ip, 60 * 1000, now);
    return jsonResponse({ success: false, valid: false, reason: 'format', error: 'សូមបញ្ចូល License Key ឲ្យបានត្រឹមត្រូវ។' }, 400);
  }
  if (!machineId || machineId.length < 8) {
    recordRateFailure(verifyFailRateMap, ip, 60 * 1000, now);
    return jsonResponse({ success: false, valid: false, reason: 'machine_id', error: 'មិនអាចស្គាល់ Machine ID ម៉ាស៊ីននេះបានទេ។' }, 400);
  }

  const settings = await loadSettingsMap(env.DB);
  const maintenanceBanner = settings.maintenance_banner || '';
  const maintenanceLocked = settings.maintenance_locked === '1';
  const minAppVersion = settings.min_app_version || env.MIN_APP_VERSION || '1.0.0';
  const downloadUrl = settings.download_url || '';
  const supportContact = settings.support_contact || 'https://t.me/ezapro_support';
  const routerLocked = false;

  if (maintenanceLocked) {
    return jsonResponse(
      {
        success: false,
        valid: false,
        reason: 'maintenance',
        maintenanceBanner,
        maintenanceLocked: true,
        downloadUrl,
        supportContact,
        error: maintenanceBanner || 'ប្រព័ន្ធកំពុងថែទាំបណ្ដោះអាសន្ន។ សូមព្យាយាមម្ដងទៀតបន្តិចទៀត។'
      },
      423
    );
  }

  if (minAppVersion && compareSemver(appVersion, minAppVersion) < 0) {
    return jsonResponse(
      {
        success: false,
        valid: false,
        reason: 'outdated_version',
        minAppVersion,
        downloadUrl,
        supportContact,
        error: `សូមអាប់ដេតកម្មវិធីទៅជំនាន់ថ្មី v${minAppVersion} ជាមុនសិន ដើម្បីប្រើប្រាស់បន្ត។`
      },
      426
    );
  }

  const row = await env.DB.prepare('SELECT * FROM licenses WHERE license_key = ?').bind(licenseKey).first();
  if (!row) {
    recordRateFailure(verifyFailRateMap, ip, 60 * 1000, now);
    await logAudit(env.DB, { licenseKey, machineId, event: 'reject_not_found', detail: 'Key missing', ip });
    return jsonResponse({ success: false, valid: false, reason: 'not_found', supportContact, error: 'License Key មិនត្រឹមត្រូវ ឬមិនមានក្នុងប្រព័ន្ធទេ។' }, 404);
  }

  if (row.status !== 'active') {
    recordRateFailure(verifyFailRateMap, ip, 60 * 1000, now);
    await logAudit(env.DB, { licenseKey, machineId, event: `reject_${row.status}`, detail: row.customer_name, ip });
    return jsonResponse(
      {
        success: false,
        valid: false,
        reason: row.status,
        supportContact,
        error:
          row.status === 'paused'
            ? 'គណនីនេះត្រូវបានផ្អាកបណ្ដោះអាសន្នដោយ Admin។'
            : 'License Key នេះត្រូវបានបិទសិទ្ធិ (Revoked) ដោយ Admin។'
      },
      403
    );
  }

  const maxMachines = Math.max(1, Number(row.max_machines || 1));
  const prevBoundRaw = String(row.bound_machines || '[]');
  const boundMachines = parseBoundMachines(prevBoundRaw);
  const alreadyBound = boundMachines.includes(machineId);
  const durationDays = Number(row.duration_days || 0);
  const isFirstEverActivation = !alreadyBound && boundMachines.length === 0 && !row.first_activated_at && durationDays > 0;

  let effectiveExpiresAt = row.expires_at !== null && row.expires_at !== undefined && Number(row.expires_at) > 0 ? Number(row.expires_at) : null;
  if (isFirstEverActivation && effectiveExpiresAt !== null) {
    // Grant full purchased duration starting from the customer's actual first activation moment
    effectiveExpiresAt = Math.max(effectiveExpiresAt, now + Math.round(durationDays * 86400000));
  }

  if (effectiveExpiresAt !== null && now > effectiveExpiresAt) {
    await logAudit(env.DB, { licenseKey, machineId, event: 'reject_expired', detail: row.customer_name, ip });
    return jsonResponse(
      {
        success: false,
        valid: false,
        reason: 'expired',
        expiresAt: effectiveExpiresAt,
        supportContact,
        error: 'License Key នេះផុតកំណត់សុពលភាពហើយ។ សូមទាក់ទង Admin ដើម្បីបន្តសុពលភាព ($10/ខែ ឬ $50/ឆ្នាំ)។'
      },
      403
    );
  }

  const appScope = normalizeAppScope(row.app_scope);
  if (appScope !== 'all' && appScope !== appId) {
    await logAudit(env.DB, {
      licenseKey,
      machineId,
      event: 'reject_wrong_app',
      detail: `Tried ${appId} on ${appScope} (${row.customer_name})`,
      ip
    });
    const neededName = appScope === 'studio' ? 'EZA PRO Studio' : 'EZA PRO Downloader';
    const currentName = appId === 'downloader' ? 'EZA PRO Downloader' : 'EZA PRO Studio';
    return jsonResponse(
      {
        success: false,
        valid: false,
        reason: 'wrong_app',
        requiredApp: appScope,
        supportContact,
        error: `License Key នេះសម្រាប់តែកម្មវិធី ${neededName} ប៉ុណ្ណោះ (មិនអាចប្រើជាមួយ ${currentName} បានទេ)។`
      },
      403
    );
  }

  if (!alreadyBound) {
    if (boundMachines.length >= maxMachines) {
      await logAudit(env.DB, {
        licenseKey,
        machineId,
        event: 'reject_limit',
        detail: `${boundMachines.length}/${maxMachines} (${row.customer_name})`,
        ip
      });
      return jsonResponse(
        {
          success: false,
          valid: false,
          reason: 'machine_limit',
          maxMachines,
          boundCount: boundMachines.length,
          supportContact,
          error: `License Key នេះបានភ្ជាប់លើម៉ាស៊ីនផ្សេងរួចហើយ (${boundMachines.length}/${maxMachines})! សូមទាក់ទង Admin ដើម្បី Reset ម៉ាស៊ីន។`
        },
        403
      );
    }
    boundMachines.push(machineId);
    const firstActivatedAt = row.first_activated_at ? Number(row.first_activated_at) : now;
    const casRes = await env.DB.prepare(
      `UPDATE licenses
       SET bound_machines = ?, expires_at = ?, first_activated_at = ?, updated_at = ?, last_seen_at = ?, last_machine_id = ?, last_app_version = ?, verify_count = verify_count + 1
       WHERE license_key = ? AND bound_machines = ?`
    )
      .bind(JSON.stringify(boundMachines), effectiveExpiresAt, firstActivatedAt, now, now, machineId, recordedClientTag, licenseKey, prevBoundRaw)
      .run();
    if (!casRes || !casRes.meta || Number(casRes.meta.changes) !== 1) {
      await logAudit(env.DB, {
        licenseKey,
        machineId,
        event: 'reject_limit_race',
        detail: `Concurrent bind conflict (${row.customer_name})`,
        ip
      });
      return jsonResponse(
        {
          success: false,
          valid: false,
          reason: 'machine_limit',
          maxMachines,
          boundCount: maxMachines,
          supportContact,
          error: `License Key នេះបានភ្ជាប់លើម៉ាស៊ីនផ្សេងរួចហើយ (${maxMachines}/${maxMachines})! សូមទាក់ទង Admin ដើម្បី Reset ម៉ាស៊ីន។`
        },
        403
      );
    }
    await logAudit(env.DB, {
      licenseKey,
      machineId,
      event: 'activate',
      detail: `Bound ${boundMachines.length}/${maxMachines} (${row.customer_name})`,
      ip
    });
  } else {
    await env.DB.prepare(
      `UPDATE licenses
       SET updated_at = ?, last_seen_at = ?, last_machine_id = ?, last_app_version = ?, verify_count = verify_count + 1
       WHERE license_key = ?`
    )
      .bind(now, now, machineId, recordedClientTag, licenseKey)
      .run();
  }

  const expiresAt = effectiveExpiresAt;
  const leaseUntil = expiresAt ? Math.min(now + OFFLINE_GRACE_MS, expiresAt) : now + OFFLINE_GRACE_MS;
  const planId = String(row.plan_id || (expiresAt === null ? 'lifetime' : 'monthly_10'));
  const priceUsd = Number.isFinite(Number(row.price_usd)) ? Number(row.price_usd) : 0;
  const warrantySupport = String(row.warranty_support || 'standard_warranty');

  const leasePayload = {
    v: 1,
    licenseKey,
    machineId,
    appScope,
    planId,
    priceUsd,
    warrantySupport,
    maxMachines,
    boundCount: boundMachines.length,
    status: 'active',
    customerName: String(row.customer_name || ''),
    expiresAt,
    issuedAt: now,
    leaseUntil,
    routerLocked,
    maintenanceBanner,
    supportContact
  };
  const leaseToken = await signLeaseToken(env, leasePayload);

  return jsonResponse({
    success: true,
    valid: true,
    leaseToken,
    appScope,
    planId,
    priceUsd,
    warrantySupport,
    customerName: leasePayload.customerName,
    expiresAt,
    maxMachines,
    boundCount: boundMachines.length,
    serverNow: now,
    leaseUntil,
    maintenanceBanner,
    maintenanceLocked: false,
    minAppVersion,
    downloadUrl,
    supportContact,
    routerLocked
  });
}

async function handleAdminRoutes(request, env, pathname) {
  await ensureSchema(env.DB);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  if (pathname === '/api/admin/login' && request.method === 'POST') {
    const now = Date.now();
    if (isRateLimited(adminLoginFailMap, ip, 8, 5 * 60 * 1000, now)) {
      return jsonResponse({ success: false, error: 'បញ្ចូលលេខសម្ងាត់ខុសច្រើនដងពេក។ សូមរង់ចាំ ៥ នាទី។' }, 429);
    }
    let body = {};
    try {
      body = await request.json();
    } catch (_) {}
    const expectedAdminSecret = String(env.ADMIN_SECRET || '').trim();
    const ok = expectedAdminSecret
      ? await constantTimeEqual(String(body.secret || '').trim(), expectedAdminSecret)
      : false;
    if (!expectedAdminSecret || !ok) {
      recordRateFailure(adminLoginFailMap, ip, 5 * 60 * 1000, now);
      return jsonResponse({ success: false, error: 'លេខសម្ងាត់ Admin មិនត្រឹមត្រូវទេ។' }, 401);
    }
    adminLoginFailMap.delete(ip);
    return jsonResponse({ success: true });
  }

  const authorized = await verifyAdminRequest(request, env);
  if (!authorized) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  if (pathname === '/api/admin/overview' && request.method === 'GET') {
    const now = Date.now();
    const { results: licenseRows } = await env.DB.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();
    const { results: logRows } = await env.DB.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50').all();
    const settings = await loadSettingsMap(env.DB);

    const licenses = (licenseRows || []).map((row) => {
      const boundMachines = parseBoundMachines(row.bound_machines);
      const expiresAt = row.expires_at !== null && row.expires_at !== undefined && Number(row.expires_at) > 0 ? Number(row.expires_at) : null;
      const isExpired = Boolean(expiresAt && now > expiresAt);
      const planId = String(row.plan_id || (expiresAt === null ? 'lifetime' : 'monthly_10'));
      return {
        licenseKey: row.license_key,
        customerName: row.customer_name || '',
        contact: row.contact || '',
        appScope: normalizeAppScope(row.app_scope),
        planId,
        priceUsd: Number.isFinite(Number(row.price_usd)) ? Number(row.price_usd) : 0,
        durationDays: Number(row.duration_days || 0),
        firstActivatedAt: row.first_activated_at ? Number(row.first_activated_at) : null,
        warrantySupport: row.warranty_support || 'standard_warranty',
        status: row.status || 'active',
        effectiveStatus: row.status !== 'active' ? row.status : isExpired ? 'expired' : 'active',
        maxMachines: Number(row.max_machines || 1),
        boundMachines,
        expiresAt,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : null,
        lastMachineId: row.last_machine_id || '',
        lastAppVersion: row.last_app_version || '',
        verifyCount: Number(row.verify_count || 0)
      };
    });

    const stats = {
      total: licenses.length,
      active: licenses.filter((l) => l.effectiveStatus === 'active').length,
      blocked: licenses.filter((l) => l.status === 'paused' || l.status === 'revoked').length,
      expired: licenses.filter((l) => l.effectiveStatus === 'expired').length,
      seen24h: licenses.filter((l) => l.lastSeenAt && now - l.lastSeenAt <= 24 * 60 * 60 * 1000).length,
      monthlyCount: licenses.filter((l) => l.planId === 'monthly_10' && l.effectiveStatus === 'active').length,
      yearlyCount: licenses.filter((l) => l.planId === 'yearly_50' && l.effectiveStatus === 'active').length
    };

    return jsonResponse({
      success: true,
      serverNow: now,
      stats,
      licenses,
      settings,
      logs: logRows || []
    });
  }

  if (pathname === '/api/admin/licenses' && request.method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch (_) {
      return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
    }

    const now = Date.now();
    const licenseKey = normalizeLicenseKey(body.licenseKey) || generateLicenseKeyString();
    const customerName = String(body.customerName || '').trim().slice(0, 120);
    const contact = String(body.contact || '').trim().slice(0, 120);
    const appScope = normalizeAppScope(body.appScope);
    const planSpec = normalizePlanSpec(body.planId, body.durationDays, body.priceUsd);
    const durationDays = planSpec.durationDays;
    const maxMachines = Math.max(1, Math.min(20, Number(body.maxMachines || 1)));
    const prebind = normalizeMachineId(body.prebindMachineId || '');
    const boundMachines = prebind && prebind.length >= 8 ? [prebind] : [];
    const firstActivatedAt = boundMachines.length > 0 ? now : null;
    const expiresAt = Number.isFinite(durationDays) && durationDays > 0 ? now + Math.round(durationDays * 86400000) : null;

    await env.DB.prepare(
      `INSERT INTO licenses (license_key, customer_name, contact, app_scope, plan_id, price_usd, duration_days, first_activated_at, warranty_support, status, max_machines, bound_machines, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
    )
      .bind(
        licenseKey,
        customerName,
        contact,
        appScope,
        planSpec.planId,
        planSpec.priceUsd,
        durationDays,
        firstActivatedAt,
        planSpec.warrantySupport,
        maxMachines,
        JSON.stringify(boundMachines),
        expiresAt,
        now,
        now
      )
      .run();

    await logAudit(env.DB, {
      licenseKey,
      machineId: prebind,
      event: 'admin_create',
      detail: `${customerName || 'Customer'} [${planSpec.planId} $${planSpec.priceUsd}] (${durationDays > 0 ? durationDays + 'd' : 'Lifetime'})`,
      ip
    });

    return jsonResponse({
      success: true,
      license: {
        licenseKey,
        customerName,
        contact,
        appScope,
        planId: planSpec.planId,
        priceUsd: planSpec.priceUsd,
        durationDays,
        warrantySupport: planSpec.warrantySupport,
        status: 'active',
        maxMachines,
        boundMachines,
        expiresAt
      }
    });
  }

  if (pathname === '/api/admin/licenses/action' && request.method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch (_) {
      return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
    }

    const licenseKey = normalizeLicenseKey(body.licenseKey);
    const action = String(body.action || '').trim();
    if (!licenseKey) return jsonResponse({ success: false, error: 'Missing licenseKey' }, 400);

    const row = await env.DB.prepare('SELECT * FROM licenses WHERE license_key = ?').bind(licenseKey).first();
    if (!row) return jsonResponse({ success: false, error: 'License Key មិនមានទេ' }, 404);

    const now = Date.now();

    if (action === 'set_status') {
      const nextStatus = ['active', 'paused', 'revoked'].includes(body.status) ? body.status : 'paused';
      await env.DB.prepare('UPDATE licenses SET status = ?, updated_at = ? WHERE license_key = ?')
        .bind(nextStatus, now, licenseKey)
        .run();
      await logAudit(env.DB, { licenseKey, event: `admin_${nextStatus}`, detail: row.customer_name, ip });
      return jsonResponse({ success: true, status: nextStatus });
    }

    if (action === 'reset_machines') {
      await env.DB.prepare('UPDATE licenses SET bound_machines = ?, updated_at = ? WHERE license_key = ?')
        .bind('[]', now, licenseKey)
        .run();
      await logAudit(env.DB, { licenseKey, event: 'admin_reset_hwid', detail: row.customer_name, ip });
      return jsonResponse({ success: true });
    }

    if (action === 'unbind_machine') {
      const targetMachine = normalizeMachineId(body.machineId || '');
      if (!targetMachine) {
        return jsonResponse({ success: false, error: 'Missing machineId' }, 400);
      }
      const nextMachines = parseBoundMachines(row.bound_machines).filter((m) => m !== targetMachine);
      await env.DB.prepare('UPDATE licenses SET bound_machines = ?, updated_at = ? WHERE license_key = ?')
        .bind(JSON.stringify(nextMachines), now, licenseKey)
        .run();
      await logAudit(env.DB, { licenseKey, machineId: targetMachine, event: 'admin_unbind_hwid', detail: row.customer_name, ip });
      return jsonResponse({ success: true, boundMachines: nextMachines });
    }

    if (action === 'extend_days') {
      if (row.status === 'revoked') {
        return jsonResponse(
          {
            success: false,
            error: 'គណនីនេះកំពុងជាប់ Ban (Revoked) — សូមចុចបើកសកម្ម (Active) ជាមុនសិនមុនបន្តថ្ងៃ។'
          },
          409
        );
      }

      const explicitLifetime = body.lifetime === true;
      if (explicitLifetime) {
        await env.DB.prepare("UPDATE licenses SET expires_at = NULL, plan_id = 'lifetime', duration_days = 0, warranty_support = 'vip_warranty', status = 'active', updated_at = ? WHERE license_key = ?")
          .bind(now, licenseKey)
          .run();
        await logAudit(env.DB, {
          licenseKey,
          event: 'admin_extend',
          detail: `Lifetime (${row.customer_name})`,
          ip
        });
        return jsonResponse({ success: true, expiresAt: null, planId: 'lifetime' });
      }

      const days = Number(body.days);
      if (!Number.isFinite(days) || days <= 0) {
        return jsonResponse({ success: false, error: 'ចំនួនថ្ងៃបន្តសុពលភាពត្រូវតែធំជាង ០។' }, 400);
      }

      const isCurrentlyLifetime = row.expires_at === null || String(row.plan_id || '') === 'lifetime';
      if (isCurrentlyLifetime) {
        return jsonResponse(
          {
            success: false,
            error: 'គណនីនេះជា Lifetime រួចហើយ (មិនចាំបាច់បន្តថ្ងៃទេ)។'
          },
          409
        );
      }

      const baseMs = row.expires_at && Number(row.expires_at) > now ? Number(row.expires_at) : now;
      const roundedDays = Math.round(days);
      const nextExpires = baseMs + roundedDays * 86400000;
      const renewSpec = normalizePlanSpec(body.planId || '', roundedDays, body.priceUsd);
      const nextPlanId = renewSpec.planId !== 'custom' ? renewSpec.planId : (row.plan_id || 'custom');
      const nextPrice = renewSpec.priceUsd > 0 ? renewSpec.priceUsd : Number(row.price_usd || 0);

      await env.DB.prepare("UPDATE licenses SET expires_at = ?, plan_id = ?, price_usd = ?, duration_days = ?, status = 'active', updated_at = ? WHERE license_key = ?")
        .bind(nextExpires, nextPlanId, nextPrice, roundedDays, now, licenseKey)
        .run();
      await logAudit(env.DB, {
        licenseKey,
        event: 'admin_extend',
        detail: `+${roundedDays}d [${nextPlanId}] (${row.customer_name})`,
        ip
      });
      return jsonResponse({ success: true, expiresAt: nextExpires, planId: nextPlanId });
    }

    if (action === 'update_info') {
      const customerName = String(body.customerName ?? row.customer_name).trim().slice(0, 120);
      const contact = String(body.contact ?? row.contact).trim().slice(0, 120);
      const rawMax = body.maxMachines;
      const parsedMax = (rawMax !== '' && rawMax !== undefined && rawMax !== null) ? Number(rawMax) : NaN;
      const maxMachines = Number.isFinite(parsedMax)
        ? Math.max(1, Math.min(20, Math.round(parsedMax)))
        : Math.max(1, Number(row.max_machines || 1));
      const appScope = normalizeAppScope(body.appScope ?? row.app_scope);
      await env.DB.prepare('UPDATE licenses SET customer_name = ?, contact = ?, max_machines = ?, app_scope = ?, updated_at = ? WHERE license_key = ?')
        .bind(customerName, contact, maxMachines, appScope, now, licenseKey)
        .run();
      return jsonResponse({ success: true });
    }

    if (action === 'delete') {
      await env.DB.prepare('DELETE FROM licenses WHERE license_key = ?').bind(licenseKey).run();
      await logAudit(env.DB, { licenseKey, event: 'admin_delete', detail: row.customer_name, ip });
      return jsonResponse({ success: true });
    }

    return jsonResponse({ success: false, error: 'Unknown action' }, 400);
  }

  if (pathname === '/api/admin/settings' && request.method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch (_) {
      return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
    }

    const now = Date.now();
    const pairs = [
      ['maintenance_banner', String(body.maintenance_banner || '').trim().slice(0, 300)],
      ['maintenance_locked', body.maintenance_locked ? '1' : '0'],
      ['min_app_version', String(body.min_app_version || '1.0.0').trim().slice(0, 32)],
      ['download_url', String(body.download_url || '').trim().slice(0, 400)],
      ['support_contact', String(body.support_contact || 'https://t.me/ezapro_support').trim().slice(0, 300)],
      ['router_locked', body.router_locked ? '1' : '0']
    ];
    for (const [key, value] of pairs) {
      await env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
        .bind(key, value, now)
        .run();
    }
    return jsonResponse({ success: true, settings: await loadSettingsMap(env.DB) });
  }

  return jsonResponse({ success: false, error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/api/health') {
        return jsonResponse({ ok: true, service: 'eza-pro-license-admin', now: Date.now() });
      }
      if (pathname === '/api/license/verify' && request.method === 'POST') {
        return await handlePublicVerify(request, env);
      }
      if (pathname.startsWith('/api/admin/')) {
        return await handleAdminRoutes(request, env, pathname);
      }
      if (pathname === '/' || pathname === '/admin') {
        return htmlResponse(renderAdminHtml());
      }
      return jsonResponse({ success: false, error: 'Not found' }, 404);
    } catch (err) {
      return jsonResponse({ success: false, error: err && err.message ? err.message : 'Server error' }, 500);
    }
  }
};
