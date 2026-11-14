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
    this.maxMemorySize = 500; // Max items in memory
    
    // Ensure cache directory exists
    if (!fs.existsSync(this.cacheDir)) {
      try {
        fs.mkdirSync(this.cacheDir, { recursive: true });
        console.log('[TranslationCache] Created cache directory');
      } catch (err) {
        console.error('[TranslationCache] Failed to create cache directory:', err.message);
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
    const normalized = text.trim().toLowerCase();
    const data = context
      ? `${sourceLang}:${targetLang}:${context}:${normalized}`
      : `${sourceLang}:${targetLang}:${normalized}`;
    return crypto.createHash('md5').update(data).digest('hex');
  }
  
  /**
   * Get translation from cache
   */
  async get(text, sourceLang = 'zh', targetLang = 'km', context = '') {
    const key = this._generateKey(text, sourceLang, targetLang, context);
    
    // Check memory cache first
    if (this.memoryCache.has(key)) {
      this.stats.hits++;
      console.log(`[TranslationCache] 🎯 Memory hit: ${text.substring(0, 30)}...`);
      return this.memoryCache.get(key);
    }
    
    // Check disk cache
    const cacheFile = path.join(this.cacheDir, `${key}.json`);
    try {
      if (fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        
        // Validate cache entry
        if (cached.translation && cached.sourceText === text) {
          this.stats.hits++;
          
          // Promote to memory cache
          this._addToMemory(key, cached.translation);
          
          console.log(`[TranslationCache] 💾 Disk hit: ${text.substring(0, 30)}...`);
          return cached.translation;
        }
      }
    } catch (err) {
      this.stats.errors++;
      console.warn(`[TranslationCache] ⚠️  Failed to read cache:`, err.message);
    }
    
    this.stats.misses++;
    return null;
  }
  
  /**
   * Save translation to cache
   */
  async set(text, translation, sourceLang = 'zh', targetLang = 'km', context = '') {
    if (!text || !translation) return;
    
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
    
    try {
      // Save to disk
      fs.writeFileSync(cacheFile, JSON.stringify(cacheEntry, null, 2), 'utf8');
      
      // Add to memory cache
      this._addToMemory(key, translation);
      
      console.log(`[TranslationCache] ✅ Cached: ${text.substring(0, 30)}...`);
    } catch (err) {
      this.stats.errors++;
      console.error(`[TranslationCache] ❌ Failed to save cache:`, err.message);
    }
  }
  
  /**
   * Add item to memory cache with LRU eviction
   */
  _addToMemory(key, value) {
    // Remove oldest if at capacity
    if (this.memoryCache.size >= this.maxMemorySize) {
      const firstKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(firstKey);
    }
    
    this.memoryCache.set(key, value);
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
