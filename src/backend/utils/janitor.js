/**
 * EZA PRO - Disk Cache & Orphan Temp Directory Janitor
 * Keeps customer SSDs clean by pruning expired uploads, temp dirs, audio/translation caches, and UVR leftovers.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
let startupJanitorScheduled = false;

/**
 * Prune expired files and enforce a soft total-byte cap inside a cache directory (oldest mtime first).
 */
function pruneDirectoryByAgeAndSize(dirPath, options = {}) {
  const {
    maxAgeMs = 30 * ONE_DAY_MS,
    maxTotalBytes = 0,
    maxFileCount = 0,
    ignoreNames = new Set(['.gitkeep', 'voices.json'])
  } = options || {};

  if (!dirPath || !fs.existsSync(dirPath)) return { deletedCount: 0, freedBytes: 0 };

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (_) {
    return { deletedCount: 0, freedBytes: 0 };
  }

  const now = Date.now();
  const candidates = [];
  let deletedCount = 0;
  let freedBytes = 0;

  for (const entry of entries) {
    if (!entry || ignoreNames.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    let st;
    try {
      st = fs.statSync(fullPath);
    } catch (_) {
      continue;
    }

    if (entry.isDirectory()) {
      // Only remove orphan _tmp_* folders older than maxAgeMs
      if (entry.name.startsWith('_tmp_') && (now - st.mtimeMs) > Math.min(maxAgeMs, 6 * ONE_HOUR_MS)) {
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          deletedCount++;
        } catch (_) {}
      }
      continue;
    }

    if (!entry.isFile()) continue;

    if (maxAgeMs > 0 && (now - st.mtimeMs) > maxAgeMs) {
      try {
        fs.unlinkSync(fullPath);
        deletedCount++;
        freedBytes += Number(st.size) || 0;
      } catch (_) {}
      continue;
    }

    candidates.push({
      path: fullPath,
      size: Number(st.size) || 0,
      mtimeMs: Number(st.mtimeMs) || 0
    });
  }

  if ((maxTotalBytes > 0 || maxFileCount > 0) && candidates.length > 0) {
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let totalBytes = candidates.reduce((sum, f) => sum + f.size, 0);
    let remainingCount = candidates.length;

    for (const item of candidates) {
      const overBytes = maxTotalBytes > 0 && totalBytes > maxTotalBytes;
      const overCount = maxFileCount > 0 && remainingCount > maxFileCount;
      if (!overBytes && !overCount) break;
      try {
        fs.unlinkSync(item.path);
        totalBytes -= item.size;
        remainingCount -= 1;
        deletedCount++;
        freedBytes += item.size;
      } catch (_) {}
    }
  }

  return { deletedCount, freedBytes };
}

/**
 * Clean orphaned app-owned temp directories inside os.tmpdir() left by past crashes or kills.
 */
function cleanupStaleOsTempDirs(maxAgeMs = 6 * ONE_HOUR_MS) {
  const tmpRoot = os.tmpdir();
  let deletedCount = 0;
  try {
    const entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry || !entry.isDirectory()) continue;
      if (
        !entry.name.startsWith('ezapro-export-') &&
        !entry.name.startsWith('eza-speech-') &&
        !entry.name.startsWith('eza-cast-')
      ) {
        continue;
      }
      const fullPath = path.join(tmpRoot, entry.name);
      try {
        const st = fs.statSync(fullPath);
        if ((now - st.mtimeMs) > maxAgeMs) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          deletedCount++;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return deletedCount;
}

/**
 * Run a non-blocking maintenance sweep once shortly after startup.
 */
function scheduleStartupStorageCleanup(paths = {}, logger = null) {
  if (startupJanitorScheduled || process.env.NODE_ENV === 'test' || process.env.EZA_DISABLE_JANITOR === '1') {
    return;
  }
  startupJanitorScheduled = true;

  const timer = setTimeout(() => {
    try {
      const tmpRemoved = cleanupStaleOsTempDirs(6 * ONE_HOUR_MS);
      const upStats = paths.uploadsDir
        ? pruneDirectoryByAgeAndSize(paths.uploadsDir, { maxAgeMs: 7 * ONE_DAY_MS, maxTotalBytes: 8 * 1024 * 1024 * 1024 })
        : { deletedCount: 0, freedBytes: 0 };
      const bgmStats = paths.bgmCacheDir
        ? pruneDirectoryByAgeAndSize(paths.bgmCacheDir, { maxAgeMs: 30 * ONE_DAY_MS, maxTotalBytes: 3 * 1024 * 1024 * 1024 })
        : { deletedCount: 0, freedBytes: 0 };
      const audioStats = paths.audioCacheDir
        ? pruneDirectoryByAgeAndSize(paths.audioCacheDir, { maxAgeMs: 30 * ONE_DAY_MS, maxTotalBytes: 2 * 1024 * 1024 * 1024 })
        : { deletedCount: 0, freedBytes: 0 };
      const transStats = paths.translationCacheDir
        ? pruneDirectoryByAgeAndSize(paths.translationCacheDir, { maxAgeMs: 45 * ONE_DAY_MS, maxTotalBytes: 512 * 1024 * 1024, maxFileCount: 50000 })
        : { deletedCount: 0, freedBytes: 0 };

      const totalDeleted = tmpRemoved + upStats.deletedCount + bgmStats.deletedCount + audioStats.deletedCount + transStats.deletedCount;
      const totalMb = Math.round((upStats.freedBytes + bgmStats.freedBytes + audioStats.freedBytes + transStats.freedBytes) / (1024 * 1024));
      if (totalDeleted > 0 && logger && typeof logger.logInfo === 'function') {
        logger.logInfo('Janitor:startup', `Cleaned ${totalDeleted} stale cache items (~${totalMb} MB freed)`);
      }
    } catch (err) {
      if (logger && typeof logger.logWarn === 'function') {
        logger.logWarn('Janitor:startup', err.message);
      }
    }
  }, 4500);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

module.exports = {
  pruneDirectoryByAgeAndSize,
  cleanupStaleOsTempDirs,
  scheduleStartupStorageCleanup
};
