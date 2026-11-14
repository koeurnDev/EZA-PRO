/**
 * ⚡ EZA PRO - Draft Management Routes
 * Save and load work-in-progress projects
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DRAFTS_DIR = path.join(__dirname, '..', '..', '..', 'drafts');

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

    // Generate unique key from video path
    const key = crypto.createHash('md5').update(cleanVideoPath).digest('hex');
    const draftsDir = ensureDraftsDir();
    const draftPath = path.join(draftsDir, `${key}.json`);
    const incomingTranslatedCount = cues.filter(c =>
      c && typeof c.translated === 'string' && c.translated.trim() && (Boolean(c.translatedLang) || c.translated !== c.text)
    ).length;

    // Never let background auto-save overwrite an existing translated draft with raw untranslated cues
    if (isAutoSave && incomingTranslatedCount === 0 && fs.existsSync(draftPath)) {
      try {
        const existingDraft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
        const existingTranslated = Array.isArray(existingDraft && existingDraft.cues)
          ? existingDraft.cues.filter(c => c && typeof c.translated === 'string' && c.translated.trim() && (Boolean(c.translatedLang) || c.translated !== c.text)).length
          : 0;
        if (existingTranslated > 0) {
          return res.json({
            success: true,
            skippedOverwrite: true,
            message: 'Preserved existing translated draft',
            draftKey: key,
            savedPath: draftPath,
            cueCount: existingDraft.cues.length
          });
        }
      } catch (_) {}
    }
    
    // Prepare draft data
    const draftData = { 
      cues, 
      videoPath: cleanVideoPath,
      videoName: (typeof videoName === 'string' && videoName.trim()) || path.basename(cleanVideoPath),
      timestamp: timestamp || Date.now(),
      cueCount: cues.length,
      translatedCount: incomingTranslatedCount,
      lastModified: new Date().toISOString(),
      version: '1.0'
    };

    // Save to file
    fs.writeFileSync(draftPath, JSON.stringify(draftData, null, 2), 'utf8');
    
    res.json({ 
      success: true, 
      message: 'Draft saved successfully',
      draftKey: key, 
      savedPath: draftPath,
      cueCount: cues.length
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
router.post('/load', (req, res) => {
  try {
    const { videoPath, draftKey } = req.body || {};
    
    let key;
    if (draftKey !== undefined && draftKey !== null && draftKey !== '') {
      if (typeof draftKey !== 'string' || !/^[a-f0-9]{32}$/.test(draftKey.trim())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid draftKey'
        });
      }
      key = draftKey.trim();
    } else if (typeof videoPath === 'string' && videoPath.trim()) {
      key = crypto.createHash('md5').update(videoPath.trim()).digest('hex');
    } else {
      return res.status(400).json({ 
        success: false, 
        error: 'videoPath or draftKey required' 
      });
    }

    const draftsDir = ensureDraftsDir();
    const draftPath = path.join(draftsDir, `${key}.json`);
    
    if (fs.existsSync(draftPath)) {
      const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
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
router.get('/list', (req, res) => {
  try {
    const draftsDir = getDraftsDir();
    if (!fs.existsSync(draftsDir)) {
      return res.json({ success: true, drafts: [], total: 0 });
    }

    const files = fs.readdirSync(draftsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filePath = path.join(draftsDir, f);
        try {
          const stats = fs.statSync(filePath);
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          
          return {
            key: path.basename(f, '.json'),
            fileName: f,
            videoPath: data.videoPath || 'Unknown',
            videoName: data.videoName || path.basename(data.videoPath || ''),
            cueCount: data.cueCount || data.cues?.length || 0,
            translatedCount: data.translatedCount || 0,
            timestamp: data.timestamp || stats.mtimeMs,
            lastModified: data.lastModified || stats.mtime.toISOString(),
            size: stats.size,
            sizeReadable: (stats.size / 1024).toFixed(1) + ' KB'
          };
        } catch (err) {
          console.warn('Failed to read draft:', f, err.message);
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.timestamp - a.timestamp);

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
router.delete('/:key', (req, res) => {
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
    
    if (fs.existsSync(draftPath)) {
      fs.unlinkSync(draftPath);
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
router.delete('/clear/all', (req, res) => {
  try {
    const draftsDir = getDraftsDir();
    if (!fs.existsSync(draftsDir)) {
      return res.json({ success: true, message: 'Deleted 0 drafts', deletedCount: 0 });
    }
    const files = fs.readdirSync(draftsDir);
    let deletedCount = 0;

    for (const file of files) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(draftsDir, file));
        deletedCount++;
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

module.exports = router;
