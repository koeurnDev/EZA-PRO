import { renderAdminHtml } from './admin-ui.js';

const OFFLINE_GRACE_MS = 12 * 60 * 60 * 1000;

let schemaReadyPromise = null;
let cachedSigningKey = null;
let cachedPrivateKeyStr = '';

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
      try {
        await db.prepare("ALTER TABLE licenses ADD COLUMN app_scope TEXT NOT NULL DEFAULT 'all'").run();
      } catch (_) {}
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
  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ success: false, valid: false, error: 'ទម្រង់ទិន្នន័យមិនត្រឹមត្រូវ។' }, 400);
  }

  const licenseKey = normalizeLicenseKey(body.licenseKey || body.code);
  const machineId = normalizeMachineId(body.machineId);
  const appId = normalizeClientAppId(body.appId);
  const appVersion = String(body.appVersion || '1.0.0').trim().slice(0, 20);
  const recordedClientTag = `${appId} v${appVersion}`.slice(0, 32);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const now = Date.now();

  if (!licenseKey || licenseKey.length < 8) {
    return jsonResponse({ success: false, valid: false, reason: 'format', error: 'សូមបញ្ចូល License Key ឲ្យបានត្រឹមត្រូវ។' }, 400);
  }
  if (!machineId || machineId.length < 8) {
    return jsonResponse({ success: false, valid: false, reason: 'machine_id', error: 'មិនអាចស្គាល់ Machine ID ម៉ាស៊ីននេះបានទេ។' }, 400);
  }

  const settings = await loadSettingsMap(env.DB);
  const maintenanceBanner = settings.maintenance_banner || '';
  const maintenanceLocked = settings.maintenance_locked === '1';
  const minAppVersion = settings.min_app_version || env.MIN_APP_VERSION || '1.0.0';
  const downloadUrl = settings.download_url || '';
  const routerLocked = settings.router_locked === '1';

  if (maintenanceLocked) {
    return jsonResponse(
      {
        success: false,
        valid: false,
        reason: 'maintenance',
        maintenanceBanner,
        maintenanceLocked: true,
        downloadUrl,
        error: maintenanceBanner || 'ប្រព័ន្ធកំពុងថែទាំបណ្ដោះអាសន្ន។ សូមព្យាយាមម្ដងទៀតបន្តិចទៀត។'
      },
      423
    );
  }

  const row = await env.DB.prepare('SELECT * FROM licenses WHERE license_key = ?').bind(licenseKey).first();
  if (!row) {
    await logAudit(env.DB, { licenseKey, machineId, event: 'reject_not_found', detail: 'Key missing', ip });
    return jsonResponse({ success: false, valid: false, reason: 'not_found', error: 'License Key មិនត្រឹមត្រូវ ឬមិនមានក្នុងប្រព័ន្ធទេ។' }, 404);
  }

  if (row.status !== 'active') {
    await logAudit(env.DB, { licenseKey, machineId, event: `reject_${row.status}`, detail: row.customer_name, ip });
    return jsonResponse(
      {
        success: false,
        valid: false,
        reason: row.status,
        error:
          row.status === 'paused'
            ? 'គណនីនេះត្រូវបានផ្អាកបណ្ដោះអាសន្នដោយ Admin។'
            : 'License Key នេះត្រូវបានបិទសិទ្ធិ (Revoked) ដោយ Admin។'
      },
      403
    );
  }

  if (row.expires_at !== null && row.expires_at !== undefined && Number(row.expires_at) > 0 && now > Number(row.expires_at)) {
    await logAudit(env.DB, { licenseKey, machineId, event: 'reject_expired', detail: row.customer_name, ip });
    return jsonResponse(
      {
        success: false,
        valid: false,
        reason: 'expired',
        expiresAt: Number(row.expires_at),
        error: 'License Key នេះផុតកំណត់សុពលភាពហើយ។ សូមទាក់ទង Admin ដើម្បីបន្ត។'
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
        error: `License Key នេះសម្រាប់តែកម្មវិធី ${neededName} ប៉ុណ្ណោះ (មិនអាចប្រើជាមួយ ${currentName} បានទេ)។`
      },
      403
    );
  }

  const maxMachines = Math.max(1, Number(row.max_machines || 1));
  const boundMachines = parseBoundMachines(row.bound_machines);
  const alreadyBound = boundMachines.includes(machineId);

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
          error: `License Key នេះបានភ្ជាប់លើម៉ាស៊ីនផ្សេងរួចហើយ (${boundMachines.length}/${maxMachines})! សូមទាក់ទង Admin ដើម្បី Reset ម៉ាស៊ីន។`
        },
        403
      );
    }
    boundMachines.push(machineId);
    await logAudit(env.DB, {
      licenseKey,
      machineId,
      event: 'activate',
      detail: `Bound ${boundMachines.length}/${maxMachines} (${row.customer_name})`,
      ip
    });
  }

  await env.DB.prepare(
    `UPDATE licenses
     SET bound_machines = ?, updated_at = ?, last_seen_at = ?, last_machine_id = ?, last_app_version = ?, verify_count = verify_count + 1
     WHERE license_key = ?`
  )
    .bind(JSON.stringify(boundMachines), now, now, machineId, recordedClientTag, licenseKey)
    .run();

  const expiresAt = row.expires_at !== null && row.expires_at !== undefined && Number(row.expires_at) > 0 ? Number(row.expires_at) : null;
  const leaseUntil = expiresAt ? Math.min(now + OFFLINE_GRACE_MS, expiresAt) : now + OFFLINE_GRACE_MS;

  const leasePayload = {
    v: 1,
    licenseKey,
    machineId,
    appScope,
    status: 'active',
    customerName: String(row.customer_name || ''),
    expiresAt,
    issuedAt: now,
    leaseUntil,
    routerLocked,
    maintenanceBanner
  };
  const leaseToken = await signLeaseToken(env, leasePayload);

  return jsonResponse({
    success: true,
    valid: true,
    leaseToken,
    appScope,
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
    routerLocked
  });
}

async function handleAdminRoutes(request, env, pathname) {
  await ensureSchema(env.DB);

  if (pathname === '/api/admin/login' && request.method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch (_) {}
    const ok = await constantTimeEqual(String(body.secret || '').trim(), String(env.ADMIN_SECRET || '').trim());
    if (!env.ADMIN_SECRET || !ok) {
      return jsonResponse({ success: false, error: 'លេខសម្ងាត់ Admin មិនត្រឹមត្រូវទេ។' }, 401);
    }
    return jsonResponse({ success: true });
  }

  const authorized = await verifyAdminRequest(request, env);
  if (!authorized) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  if (pathname === '/api/admin/overview' && request.method === 'GET') {
    const now = Date.now();
    const { results: licenseRows } = await env.DB.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();
    const { results: logRows } = await env.DB.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 40').all();
    const settings = await loadSettingsMap(env.DB);

    const licenses = (licenseRows || []).map((row) => {
      const boundMachines = parseBoundMachines(row.bound_machines);
      const expiresAt = row.expires_at !== null && row.expires_at !== undefined && Number(row.expires_at) > 0 ? Number(row.expires_at) : null;
      const isExpired = Boolean(expiresAt && now > expiresAt);
      return {
        licenseKey: row.license_key,
        customerName: row.customer_name || '',
        contact: row.contact || '',
        appScope: normalizeAppScope(row.app_scope),
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
      seen24h: licenses.filter((l) => l.lastSeenAt && now - l.lastSeenAt <= 24 * 60 * 60 * 1000).length
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
    const durationDays = Number(body.durationDays || 0);
    const maxMachines = Math.max(1, Math.min(20, Number(body.maxMachines || 1)));
    const prebind = normalizeMachineId(body.prebindMachineId || '');
    const boundMachines = prebind && prebind.length >= 8 ? [prebind] : [];
    const expiresAt = Number.isFinite(durationDays) && durationDays > 0 ? now + Math.round(durationDays * 86400000) : null;

    await env.DB.prepare(
      `INSERT INTO licenses (license_key, customer_name, contact, app_scope, status, max_machines, bound_machines, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
    )
      .bind(licenseKey, customerName, contact, appScope, maxMachines, JSON.stringify(boundMachines), expiresAt, now, now)
      .run();

    await logAudit(env.DB, {
      licenseKey,
      machineId: prebind,
      event: 'admin_create',
      detail: `${customerName || 'Customer'} [${appScope}] (${durationDays > 0 ? durationDays + 'd' : 'Lifetime'})`,
      ip: request.headers.get('cf-connecting-ip') || ''
    });

    return jsonResponse({
      success: true,
      license: {
        licenseKey,
        customerName,
        contact,
        appScope,
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
    const ip = request.headers.get('cf-connecting-ip') || '';

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

    if (action === 'extend_days') {
      const days = Number(body.days || 0);
      let nextExpires = null;
      if (Number.isFinite(days) && days > 0) {
        const baseMs = row.expires_at && Number(row.expires_at) > now ? Number(row.expires_at) : now;
        nextExpires = baseMs + Math.round(days * 86400000);
      }
      await env.DB.prepare("UPDATE licenses SET expires_at = ?, status = 'active', updated_at = ? WHERE license_key = ?")
        .bind(nextExpires, now, licenseKey)
        .run();
      await logAudit(env.DB, {
        licenseKey,
        event: 'admin_extend',
        detail: nextExpires ? `+${days}d (${row.customer_name})` : `Lifetime (${row.customer_name})`,
        ip
      });
      return jsonResponse({ success: true, expiresAt: nextExpires });
    }

    if (action === 'update_info') {
      const customerName = String(body.customerName ?? row.customer_name).trim().slice(0, 120);
      const contact = String(body.contact ?? row.contact).trim().slice(0, 120);
      const maxMachines = Math.max(1, Math.min(20, Number(body.maxMachines ?? row.max_machines ?? 1)));
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
      return jsonResponse({ success: false, error: err && err.message ? err.message : 'Internal server error' }, 500);
    }
  }
};
