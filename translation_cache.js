/**
 * Translation Cache System
 * Caches Gemini API translations to avoid redundant API calls
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class TranslationCache {
  constructor(cacheDir = process.env.TRANSLATION_CACHE_DIR || path.join(__dirname, 'translation_cache')) {
    this.cacheDir = cacheDir;
    this.memoryCache = new Map(); // In-memory cache for fast access
    this.maxMemorySize = 5000; // Max items in memory (~full movie series)
    
    // Ensure cache directory exists (fall back to os.tmpdir() if packaged folder is read-only)
    if (!fs.existsSync(this.cacheDir)) {
      try {
        fs.mkdirSync(this.cacheDir, { recursive: true });
        console.log('[TranslationCache] Created cache directory');
      } catch (err) {
        console.error('[TranslationCache] Failed to create cache directory:', err.message);
        const fallbackDir = path.join(require('os').tmpdir(), 'eza-pro-translation-cache');
        try {
          fs.mkdirSync(fallbackDir, { recursive: true });
          this.cacheDir = fallbackDir;
        } catch (_) {}
      }
    }
    
    // Load cache statistics
    this.stats = {
      hits: 0,
      misses: 0,
      errors: 0
    };
  }
  
  /**
   * Generate cache key from source text
   */
  _generateKey(text, sourceLang = 'zh', targetLang = 'km', context = '') {
    const raw = typeof text === 'string' ? text : String(text || '');
    const data = context
      ? `${sourceLang}:${targetLang}:${context}:${raw}`
      : `${sourceLang}:${targetLang}:${raw}`;
    return crypto.createHash('md5').update(data).digest('hex');
  }
  
  /**
   * Get translation from cache
   */
  async get(text, sourceLang = 'zh', targetLang = 'km', context = '') {
    if (typeof text !== 'string' || !text) {
      this.stats.misses++;
      return null;
    }
    const key = this._generateKey(text, sourceLang, targetLang, context);
    
    // Check memory cache first (verify exact sourceText match to avoid casing/whitespace collisions)
    if (this.memoryCache.has(key)) {
      const memEntry = this.memoryCache.get(key);
      if (memEntry && typeof memEntry === 'object' && memEntry.sourceText === text) {
        this.memoryCache.delete(key);
        this.memoryCache.set(key, memEntry);
        this.stats.hits++;
        console.log(`[TranslationCache] 🎯 Memory hit: ${text.substring(0, 30)}...`);
        return memEntry.translation;
      }
    }
    
    // Check disk cache asynchronously to keep parallel translation workers non-blocking
    const cacheFile = path.join(this.cacheDir, `${key}.json`);
    try {
      const raw = await fs.promises.readFile(cacheFile, 'utf8');
      const cached = JSON.parse(raw);

      // Validate cache entry
      if (cached.translation && cached.sourceText === text) {
        this.stats.hits++;

        // Promote to memory cache
        this._addToMemory(key, text, cached.translation);

        console.log(`[TranslationCache] 💾 Disk hit: ${text.substring(0, 30)}...`);
        return cached.translation;
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        this.stats.errors++;
        console.warn(`[TranslationCache] ⚠️  Failed to read cache:`, err.message);
      }
    }
    
    this.stats.misses++;
    return null;
  }
  
  /**
   * Save translation to cache
   */
  async set(text, translation, sourceLang = 'zh', targetLang = 'km', context = '') {
    if (typeof text !== 'string' || !text || typeof translation !== 'string' || !translation) return;
    
    const key = this._generateKey(text, sourceLang, targetLang, context);
    const cacheFile = path.join(this.cacheDir, `${key}.json`);
    
    const cacheEntry = {
      sourceText: text,
      translation: translation,
      sourceLang,
      targetLang,
      context,
      timestamp: Date.now(),
      key
    };
    
    this._writeSeq = (this._writeSeq || 0) + 1;
    const tmpFile = `${cacheFile}.${process.pid}.${Date.now()}.${this._writeSeq}.tmp`;
    try {
      // Save to disk atomically so concurrent workers never read partial JSON
      await fs.promises.writeFile(tmpFile, JSON.stringify(cacheEntry, null, 2), 'utf8');
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await fs.promises.rename(tmpFile, cacheFile);
          break;
        } catch (renErr) {
          if (attempt < 3 && (renErr.code === 'EPERM' || renErr.code === 'EBUSY' || renErr.code === 'EACCES')) {
            await new Promise(r => setTimeout(r, 25 * (attempt + 1)));
            continue;
          }
          throw renErr;
        }
      }
      
      // Add to memory cache
      this._addToMemory(key, text, translation);
      
      console.log(`[TranslationCache] ✅ Cached: ${text.substring(0, 30)}...`);
    } catch (err) {
      this.stats.errors++;
      console.error(`[TranslationCache] ❌ Failed to save cache:`, err.message);
    } finally {
      try { await fs.promises.unlink(tmpFile); } catch (_) {}
    }
  }
  
  /**
   * Add item to memory cache with LRU eviction
   */
  _addToMemory(key, sourceText, translation) {
    if (this.memoryCache.has(key)) {
      this.memoryCache.delete(key);
    } else if (this.memoryCache.size >= this.maxMemorySize) {
      const firstKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(firstKey);
    }
    
    this.memoryCache.set(key, { sourceText, translation });
  }
  
  /**
   * Clear all caches
   */
  clear() {
    this.memoryCache.clear();
    
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          fs.unlinkSync(path.join(this.cacheDir, file));
        }
      }
      console.log('[TranslationCache] 🗑️  Cleared all caches');
    } catch (err) {
      console.error('[TranslationCache] Failed to clear disk cache:', err.message);
    }
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) : 0;
    
    return {
      ...this.stats,
      total,
      hitRate: `${hitRate}%`,
      memorySize: this.memoryCache.size,
      diskSize: this._getDiskCacheSize()
    };
  }
  
  /**
   * Get number of cached translations on disk
   */
  _getDiskCacheSize() {
    try {
      const files = fs.readdirSync(this.cacheDir);
      return files.filter(f => f.endsWith('.json')).length;
    } catch (_) {
      return 0;
    }
  }
}

// Export singleton instance
module.exports = new TranslationCache();
