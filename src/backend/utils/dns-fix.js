/**
 * ⚡ EZA PRO - Resilient DNS & IPv4 Resolver
 * Prevents intermittent `getaddrinfo ENOTFOUND` on Windows when local router DNS drops AAAA/A lookups.
 */

const dns = require('dns');

let installed = false;
const dnsCache = new Map();
const lastServedIp = new Map();
const blockedIpUntil = new Map();
const bypassOsDnsUntil = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const BAD_IP_TTL_MS = 2 * 60 * 1000;
const MAX_DNS_CACHE_ENTRIES = 256;
const fallbackResolver = typeof dns.Resolver === 'function' ? new dns.Resolver() : null;
if (fallbackResolver) {
  try { fallbackResolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']); } catch (_) {}
}

function capMapSize(map, maxEntries = MAX_DNS_CACHE_ENTRIES) {
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

// Hardcoded fallback IPs for critical Google/Microsoft endpoints if all DNS servers fail or return an unreachable edge IP
const STATIC_HOST_FALLBACKS = {
  'generativelanguage.googleapis.com': ['172.217.118.4', '172.217.116.4', '172.217.112.4', '172.217.119.4'],
  'translate.googleapis.com': ['142.250.199.106']
};

function isIpBlocked(ip, now = Date.now()) {
  if (!ip) return true;
  const until = blockedIpUntil.get(ip) || 0;
  if (until <= now) {
    if (until) blockedIpUntil.delete(ip);
    return false;
  }
  return true;
}

function getFallbackIpList(hostname, now = Date.now()) {
  const raw = STATIC_HOST_FALLBACKS[hostname];
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const healthy = list.filter(ip => !isIpBlocked(ip, now));
  return healthy.length > 0 ? healthy : list;
}

function installDnsFix() {
  if (installed) return;
  installed = true;

  try {
    if (typeof dns.setDefaultResultOrder === 'function') {
      dns.setDefaultResultOrder('ipv4first');
    }
  } catch (_) {}

  const origLookup = dns.lookup.bind(dns);

  dns.lookup = function patchedLookup(hostname, options, callback) {
    let cb = callback;
    let rawOpts = options;
    if (typeof options === 'function') {
      cb = options;
      rawOpts = {};
    } else if (typeof options === 'number') {
      rawOpts = { family: options };
    } else {
      rawOpts = { ...(options || {}) };
    }

    if (typeof hostname !== 'string' || !hostname.trim()) {
      return origLookup(hostname, rawOpts, cb);
    }

    const reqFamily = rawOpts.family === 6 ? 6 : (rawOpts.family === 4 ? 4 : 0);
    const opts = { ...rawOpts, family: reqFamily };
    const wantAll = Boolean(opts && opts.all);

    const deliverIp = (ip) => {
      lastServedIp.set(hostname, ip);
      capMapSize(lastServedIp);
      if (wantAll) {
        return process.nextTick(() => cb(null, [{ address: ip, family: 4 }]));
      }
      return process.nextTick(() => cb(null, ip, 4));
    };

    const resolveFallbackOrCache = (origErr) => {
      if (reqFamily === 6) {
        return cb(origErr || new Error(`DNS IPv6 resolution failed for ${hostname}`));
      }
      const now = Date.now();
      const cached = dnsCache.get(hostname);
      if (cached && (now - cached.ts) < CACHE_TTL_MS) {
        const rawList = Array.isArray(cached.addresses) && cached.addresses.length > 0
          ? cached.addresses
          : (cached.ip ? [cached.ip] : []);
        const healthyList = rawList.filter(ip => !isIpBlocked(ip, now));
        if (healthyList.length > 0) {
          const pickIdx = (cached.idx || 0) % healthyList.length;
          cached.idx = (pickIdx + 1) % healthyList.length;
          return deliverIp(healthyList[pickIdx]);
        }
      }

      const resolveFn = fallbackResolver ? fallbackResolver.resolve4.bind(fallbackResolver) : dns.resolve4.bind(dns);
      resolveFn(hostname, (resErr, addresses) => {
        const nowRes = Date.now();
        if (!resErr && Array.isArray(addresses) && addresses.length > 0) {
          const healthyRes = addresses.filter(ip => !isIpBlocked(ip, nowRes));
          const pool = healthyRes.length > 0 ? healthyRes : [];
          if (pool.length > 0) {
            const offset = dnsRotateOffset % pool.length;
            dnsRotateOffset = (dnsRotateOffset + 1) % 100000;
            const rotated = pool.slice(offset).concat(pool.slice(0, offset));
            const ip = rotated[0];
            dnsCache.set(hostname, {
              addresses: rotated,
              idx: 1 % rotated.length,
              ts: nowRes
            });
            capMapSize(dnsCache);
            return deliverIp(ip);
          }
        }

        const fallbacks = getFallbackIpList(hostname, nowRes);
        if (fallbacks.length > 0) {
          const fbOffset = dnsRotateOffset % fallbacks.length;
          dnsRotateOffset = (dnsRotateOffset + 1) % 100000;
          return deliverIp(fallbacks[fbOffset]);
        }

        if (origErr) return cb(origErr);
        return cb(resErr || new Error(`DNS resolution failed for ${hostname}`));
      });
    };

    if (reqFamily !== 6 && (bypassOsDnsUntil.get(hostname) || 0) > Date.now()) {
      return resolveFallbackOrCache(null);
    }

    // Serve fresh healthy cached IPv4 immediately when IPv4 is acceptable
    const cachedHit = dnsCache.get(hostname);
    const nowHit = Date.now();
    if (reqFamily !== 6 && cachedHit && (nowHit - cachedHit.ts) < CACHE_TTL_MS && !wantAll) {
      const rawList = Array.isArray(cachedHit.addresses) && cachedHit.addresses.length > 0
        ? cachedHit.addresses
        : (cachedHit.ip ? [cachedHit.ip] : []);
      const healthyList = rawList.filter(ip => !isIpBlocked(ip, nowHit));
      if (healthyList.length > 0) {
        const pickIdx = (cachedHit.idx || 0) % healthyList.length;
        cachedHit.idx = (pickIdx + 1) % healthyList.length;
        return deliverIp(healthyList[pickIdx]);
      }
    }

    origLookup(hostname, opts, (err, address, family) => {
      const entryList = (!err && wantAll && Array.isArray(address))
        ? address.filter(item => item && item.address && (item.family === 6 || !isIpBlocked(item.address)))
        : null;
      const firstV4 = entryList
        ? ((entryList.find(item => item.family === 4) || {}).address || '')
        : (!err && typeof address === 'string' && family !== 6 ? address : '');
      const hasValidResult = Boolean(
        entryList
          ? entryList.length > 0
          : (!err && address && (family === 6 || !isIpBlocked(address)))
      );

      if (hasValidResult) {
        if (firstV4) {
          lastServedIp.set(hostname, firstV4);
          capMapSize(lastServedIp);
          const curCache = dnsCache.get(hostname);
          if (!curCache || (Date.now() - curCache.ts) >= CACHE_TTL_MS) {
            const allV4 = entryList
              ? entryList.filter(item => item.family === 4).map(item => item.address)
              : [firstV4];
            dnsCache.set(hostname, { addresses: allV4, idx: 0, ts: Date.now() });
            capMapSize(dnsCache);
          }
        }
        return cb(null, entryList || address, wantAll ? undefined : family);
      }

      return resolveFallbackOrCache(err);
    });
  };
}

let dnsRotateOffset = 0;

function invalidateDnsCache(hostname, badIp) {
  const now = Date.now();
  dnsRotateOffset = (dnsRotateOffset + 1) % 100000;
  if (!hostname) {
    dnsCache.clear();
    return;
  }
  const ipToBlock = badIp || lastServedIp.get(hostname);
  if (ipToBlock) {
    blockedIpUntil.set(ipToBlock, now + BAD_IP_TTL_MS);
  }
  bypassOsDnsUntil.set(hostname, now + BAD_IP_TTL_MS);

  const cached = dnsCache.get(hostname);
  if (cached && Array.isArray(cached.addresses)) {
    cached.addresses = cached.addresses.filter(ip => !isIpBlocked(ip, now));
    if (cached.addresses.length > 0) {
      cached.idx = cached.idx % cached.addresses.length;
      return;
    }
  }
  dnsCache.delete(hostname);
}

installDnsFix();

module.exports = { installDnsFix, invalidateDnsCache };

