/**
 * ⚡ EZA PRO - Draft Management Routes
 * Save and load work-in-progress projects
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mapWithConcurrency, renameFileSafe } = require('../utils/ffmpeg');

const DEFAULT_DRAFTS_DIR = path.join(__dirname, '..', '..', '..', 'drafts');
const draftWriteQueues = new Map();

function getDraftKey(videoPath) {
  const clean = typeof videoPath === 'string' ? videoPath.trim() : '';
  if (!clean) return '';
  const normalized = path.normalize(clean);
  const canonical = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  return crypto.createHash('md5').update(canonical).digest('hex');
}

function resolveExistingDraftPath(draftsDir, videoPath) {
  const clean = typeof videoPath === 'string' ? videoPath.trim() : '';
  const canonicalKey = getDraftKey(clean);
  const canonicalPath = canonicalKey ? path.join(draftsDir, `${canonicalKey}.json`) : '';
  if (canonicalPath && fs.existsSync(canonicalPath)) {
    return { key: canonicalKey, draftPath: canonicalPath };
  }
  if (clean) {
    const candidates = [
      path.normalize(clean),
      clean
    ];
    for (const candidateStr of candidates) {
      const legacyKey = crypto.createHash('md5').update(candidateStr).digest('hex');
      if (legacyKey && legacyKey !== canonicalKey) {
        const legacyPath = path.join(draftsDir, `${legacyKey}.json`);
        if (fs.existsSync(legacyPath)) {
          return { key: legacyKey, draftPath: legacyPath };
        }
      }
    }
  }
  return { key: canonicalKey, draftPath: canonicalPath };
}

function enqueueDraftWrite(key, fn) {
  const prev = draftWriteQueues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  draftWriteQueues.set(key, next);
  next.finally(() => {
    if (draftWriteQueues.get(key) === next) {
      draftWriteQueues.delete(key);
    }
  });
  return next;
}

function getDraftsDir() {
  return process.env.DRAFTS_DIR || DEFAULT_DRAFTS_DIR;
}

function ensureDraftsDir() {
  const dir = getDraftsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

if (!process.env.DRAFTS_DIR && !__dirname.includes('.asar')) {
  ensureDraftsDir();
}

/**
 * POST /api/drafts/save
 * Save current work as draft
 */
router.post('/save', async (req, res) => {
  try {
    const { cues, videoPath, videoName, timestamp, isAutoSave = false } = req.body || {};

    if (typeof videoPath !== 'string' || !videoPath.trim()) {
      return res.status(400).json({ 
        success: false, 
        error: 'videoPath is required' 
      });
    }
    const cleanVideoPath = videoPath.trim();
    
    if (!Array.isArray(cues)) {
      return res.status(400).json({ 
        success: false, 
        error: 'cues must be an array' 
      });
    }

    // Generate canonical key from normalized video path with serialized per-key atomic saves
    const key = getDraftKey(cleanVideoPath);
    const draftsDir = ensureDraftsDir();
    const draftPath = path.join(draftsDir, `${key}.json`);
    const incomingTranslatedCount = cues.filter(c =>
      c && typeof c.translated === 'string' && c.translated.trim() && (Boolean(c.translatedLang) || c.translated !== c.text)
    ).length;

    const existingCheck = resolveExistingDraftPath(draftsDir, cleanVideoPath);

    const saveResult = await enqueueDraftWrite(key, async () => {
      // Never let background auto-save overwrite an existing translated draft with raw untranslated cues
      const checkAutoPath = fs.existsSync(draftPath) ? draftPath : existingCheck.draftPath;
      if (isAutoSave && incomingTranslatedCount === 0 && fs.existsSync(checkAutoPath)) {
        try {
          const existingDraft = JSON.parse(await fs.promises.readFile(checkAutoPath, 'utf8'));
          const existingTranslated = Array.isArray(existingDraft && existingDraft.cues)
            ? existingDraft.cues.filter(c => c && typeof c.translated === 'string' && c.translated.trim() && (Boolean(c.translatedLang) || c.translated !== c.text)).length
            : 0;
          if (existingTranslated > 0) {
            return {
              skippedOverwrite: true,
              message: 'Preserved existing translated draft',
              draftKey: existingCheck.key || key,
              savedPath: checkAutoPath,
              cueCount: existingDraft.cues.length
            };
          }
        } catch (_) {}
      }

      const parsedTs = typeof timestamp === 'number'
        ? timestamp
        : (typeof timestamp === 'string' && timestamp.trim() ? Date.parse(timestamp) : NaN);
      const draftData = {
        cues,
        videoPath: path.normalize(cleanVideoPath),
        videoName: (typeof videoName === 'string' && videoName.trim()) || path.basename(cleanVideoPath),
        timestamp: Number.isFinite(parsedTs) ? parsedTs : Date.now(),
        cueCount: cues.length,
        translatedCount: incomingTranslatedCount,
        lastModified: new Date().toISOString(),
        version: '1.0'
      };

      const tmpPath = `${draftPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.promises.writeFile(tmpPath, JSON.stringify(draftData, null, 2), 'utf8');
        await renameFileSafe(tmpPath, draftPath);
      } finally {
        try { if (fs.existsSync(tmpPath)) await fs.promises.unlink(tmpPath); } catch (_) {}
      }

      return {
        skippedOverwrite: false,
        message: 'Draft saved successfully',
        draftKey: key,
        savedPath: draftPath,
        cueCount: cues.length
      };
    });

    res.json({
      success: true,
      ...saveResult
    });
  } catch (e) {
    console.error('[drafts/save]:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/drafts/load
 * Load draft by video path
 */
router.post('/load', async (req, res) => {
  try {
    const { videoPath, draftKey } = req.body || {};
    
    let key;
    let draftPath;
    const draftsDir = ensureDraftsDir();
    if (draftKey !== undefined && draftKey !== null && draftKey !== '') {
      if (typeof draftKey !== 'string' || !/^[a-f0-9]{32}$/.test(draftKey.trim())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid draftKey'
        });
      }
      key = draftKey.trim();
      draftPath = path.join(draftsDir, `${key}.json`);
    } else if (typeof videoPath === 'string' && videoPath.trim()) {
      const resolved = resolveExistingDraftPath(draftsDir, videoPath.trim());
      key = resolved.key;
      draftPath = resolved.draftPath;
    } else {
      return res.status(400).json({
        success: false,
        error: 'videoPath or draftKey required'
      });
    }

    const pendingWrite = draftWriteQueues.get(key);
    if (pendingWrite) {
      await pendingWrite.catch(() => {});
    }
    if (fs.existsSync(draftPath)) {
      const draft = JSON.parse(await fs.promises.readFile(draftPath, 'utf8'));
      return res.json({ 
        success: true, 
        draft, 
        draftKey: key, 
        found: true 
      });
    }
    
    res.status(404).json({ 
      success: false, 
      draft: null, 
      found: false,
      message: 'Draft not found'
    });
  } catch (e) {
    console.error('[drafts/load]:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/drafts/list
 * List all saved drafts
 */
router.get('/list', async (req, res) => {
  try {
    const draftsDir = getDraftsDir();
    if (!fs.existsSync(draftsDir)) {
      return res.json({ success: true, drafts: [], total: 0 });
    }

    const entries = await fs.promises.readdir(draftsDir);
    const jsonFiles = entries.filter(f => f.endsWith('.json'));
    const readResults = await mapWithConcurrency(jsonFiles, 12, async (f) => {
      const filePath = path.join(draftsDir, f);
      try {
        const [stats, raw] = await Promise.all([
          fs.promises.stat(filePath),
          fs.promises.readFile(filePath, 'utf8')
        ]);
        const data = JSON.parse(raw);
        const rawTs = typeof data.timestamp === 'number'
          ? data.timestamp
          : (typeof data.timestamp === 'string' && data.timestamp.trim() ? Date.parse(data.timestamp) : NaN);
        return {
          key: path.basename(f, '.json'),
          fileName: f,
          videoPath: data.videoPath || 'Unknown',
          videoName: data.videoName || path.basename(data.videoPath || ''),
          cueCount: data.cueCount || data.cues?.length || 0,
          translatedCount: data.translatedCount || 0,
          timestamp: Number.isFinite(rawTs) ? rawTs : stats.mtimeMs,
          lastModified: data.lastModified || stats.mtime.toISOString(),
          size: stats.size,
          sizeReadable: (stats.size / 1024).toFixed(1) + ' KB'
        };
      } catch (err) {
        console.warn('Failed to read draft:', f, err.message);
        return null;
      }
    });

    const files = readResults.filter(Boolean).sort((a, b) => b.timestamp - a.timestamp);

    res.json({ 
      success: true, 
      drafts: files, 
      total: files.length 
    });
  } catch (e) {
    console.error('[drafts/list]:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * DELETE /api/drafts/:key
 * Delete a specific draft
 */
router.delete('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    
    if (!key || !/^[a-f0-9]{32}$/.test(key)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid draft key' 
      });
    }

    const draftsDir = ensureDraftsDir();
    const draftPath = path.join(draftsDir, `${key}.json`);
    const deleted = await enqueueDraftWrite(key, async () => {
      if (fs.existsSync(draftPath)) {
        await fs.promises.unlink(draftPath);
        return true;
      }
      return false;
    });
    if (deleted) {
      return res.json({ 
        success: true, 
        message: 'Draft deleted successfully' 
      });
    }
    
    res.status(404).json({ 
      success: false, 
      message: 'Draft not found' 
    });
  } catch (e) {
    console.error('[drafts/delete]:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * DELETE /api/drafts/clear/all
 * Clear all drafts
 */
router.delete('/clear/all', async (req, res) => {
  try {
    const draftsDir = getDraftsDir();
    if (!fs.existsSync(draftsDir)) {
      return res.json({ success: true, message: 'Deleted 0 drafts', deletedCount: 0 });
    }
    await Promise.all([...draftWriteQueues.values()].map(p => p.catch(() => {})));
    const files = fs.readdirSync(draftsDir);
    let deletedCount = 0;

    for (const file of files) {
      if (file.endsWith('.json')) {
        const key = file.replace(/\.json$/i, '');
        await enqueueDraftWrite(key, async () => {
          const target = path.join(draftsDir, file);
          if (fs.existsSync(target)) {
            await fs.promises.unlink(target);
            deletedCount++;
          }
        });
      }
    }

    res.json({ 
      success: true, 
      message: `Deleted ${deletedCount} drafts`,
      deletedCount
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.getDraftKey = getDraftKey;
router.resolveExistingDraftPath = resolveExistingDraftPath;

module.exports = router;
