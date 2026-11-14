/**
 * ⚡ EZA PRO - Resilient DNS & IPv4 Resolver
 * Prevents intermittent `getaddrinfo ENOTFOUND` on Windows when local router DNS drops AAAA/A lookups.
 */

const dns = require('dns');

let installed = false;
const dnsCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

// Hardcoded fallback IPs for critical Google/Microsoft endpoints if all DNS servers fail
const STATIC_HOST_FALLBACKS = {
  'generativelanguage.googleapis.com': '172.217.118.4',
  'translate.googleapis.com': '142.250.199.106'
};

function installDnsFix() {
  if (installed) return;
  installed = true;

  try {
    if (typeof dns.setDefaultResultOrder === 'function') {
      dns.setDefaultResultOrder('ipv4first');
    }
  } catch (_) {}

  try {
    const current = dns.getServers() || [];
    const extras = ['8.8.8.8', '1.1.1.1', '8.8.4.4'];
    const merged = [...new Set([...extras, ...current])];
    dns.setServers(merged);
  } catch (_) {}

  const origLookup = dns.lookup.bind(dns);

  dns.lookup = function patchedLookup(hostname, options, callback) {
    let cb = callback;
    let opts = options;
    if (typeof options === 'function') {
      cb = options;
      opts = { family: 4 };
    } else if (typeof options === 'number') {
      opts = { family: 4 };
    } else {
      opts = { ...(options || {}), family: 4 };
    }

    const wantAll = Boolean(opts && opts.all);

    const deliverIp = (ip) => {
      if (wantAll) {
        return process.nextTick(() => cb(null, [{ address: ip, family: 4 }]));
      }
      return process.nextTick(() => cb(null, ip, 4));
    };

    origLookup(hostname, opts, (err, address, family) => {
      if (!err && address) {
        if (!wantAll && typeof address === 'string') {
          dnsCache.set(hostname, { ip: address, ts: Date.now() });
        } else if (wantAll && Array.isArray(address) && address[0]?.address) {
          dnsCache.set(hostname, { ip: address[0].address, ts: Date.now() });
        }
        return cb(null, address, family);
      }

      // Check in-memory cache first
      const cached = dnsCache.get(hostname);
      if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        return deliverIp(cached.ip);
      }

      // Fallback to direct c-ares IPv4 DNS query against 8.8.8.8 / 1.1.1.1
      dns.resolve4(hostname, (resErr, addresses) => {
        if (!resErr && Array.isArray(addresses) && addresses.length > 0) {
          const ip = addresses[0];
          dnsCache.set(hostname, { ip, ts: Date.now() });
          return deliverIp(ip);
        }

        if (STATIC_HOST_FALLBACKS[hostname]) {
          return deliverIp(STATIC_HOST_FALLBACKS[hostname]);
        }

        return cb(err);
      });
    });
  };
}

installDnsFix();

module.exports = { installDnsFix };

