/**
 * Khmer Orthography Normalization, Word Segmentation & Lookup Utilities
 * Based on the Supreme Patriarch Chuon Nath Khmer Dictionary (1967 Buddhist Institute edition,
 * full extracted headwords, cross-links & prose vocabulary in src/backend/data/chuon-nath-words.txt).
 */

const fs = require('fs');
const path = require('path');

const CHUON_NATH_DATA_PATH = path.join(__dirname, '..', 'data', 'chuon-nath-words.txt');

/**
 * Unambiguous wrong/colloquial spellings mapped to canonical Chuon Nath Dictionary forms.
 * Every entry below was verified against the full Chuon Nath lexicon for zero collisions.
 */
const CHUON_NATH_SPELLING_MAP = Object.freeze({
  // Canonical Chuon Nath PDF spelling (U+17B2 + U+17D2 + U+1799)
  'អោយ': 'ឲ្យ',
  'ឱ្យ': 'ឲ្យ',

  // High-frequency short-drama & literary orthography fixes
  'ជម្ងឺ': 'ជំងឺ',
  'សំរាប់': 'សម្រាប់',
  'បំរើ': 'បម្រើ',
  'បំរុង': 'បម្រុង',
  'បំរាម': 'បម្រាម',
  'គំរោង': 'គម្រោង',
  'សំរាក': 'សម្រាក',
  'សំរេច': 'សម្រេច',
  'សំរួល': 'សម្រួល',
  'សំរែក': 'សម្រែក',
  'សំរស់': 'សម្រស់',
  'តំរូវ': 'តម្រូវ',
  'ចំរើន': 'ចម្រើន',
  'ជំរាប': 'ជម្រាប',
  'កំរិត': 'កម្រិត',
  'កំរើក': 'កម្រើក',
  'កំរាល': 'កម្រាល',
  'ទំរង់': 'ទម្រង់',
  'ទំលាប់': 'ទម្លាប់',
  'ទំលាក់': 'ទម្លាក់',
  'សំឡាញ់': 'សម្លាញ់',
  'សំលាប់': 'សម្លាប់',
  'សំលេង': 'សំឡេង',
  'សម្លេង': 'សំឡេង',
  'កំលាំង': 'កម្លាំង',
  'តំលៃ': 'តម្លៃ',
  'ចំលើយ': 'ចម្លើយ',
  'តំឡើង': 'ដំឡើង',
  'ប្រយត្ន': 'ប្រយ័ត្ន',
  'បណ្តោយ': 'បណ្ដោយ',
  'សណ្តាប់': 'សណ្ដាប់',
  'ចំនេះ': 'ចំណេះ',
  'ស្រ្តី': 'ស្ត្រី',
  'មន្រ្តី': 'មន្ត្រី',
  'ប្រពន្ធ័': 'ប្រព័ន្ធ',
  'ប្រព្ធន្ធ': 'ប្រព័ន្ធ',
  'ការិយាលយ័': 'ការិយាល័យ',
  'សមយ័': 'សម័យ',
  'វិសយ័': 'វិស័យ',
  'និស្សយ័': 'និស្ស័យ',
  'អាស្រែយ៍': 'អាស្រ័យ',
  'គណះ': 'គណៈ',
  'ឋានះ': 'ឋានៈ',
  'សភាវះ': 'សភាវៈ',
  'លក្ខណះ': 'លក្ខណៈ',
  'បញ្ហារ': 'បញ្ហា',
  'កាតព្វកິດ': 'កាតព្វកិច្ច'
});

function escapeRegexLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ORDERED_WRONG_TOKENS = Object.keys(CHUON_NATH_SPELLING_MAP).sort((a, b) => b.length - a.length);
const CHUON_NATH_REPLACE_RE = new RegExp(ORDERED_WRONG_TOKENS.map(escapeRegexLiteral).join('|'), 'g');

const CHUON_NATH_PROMPT_GUIDE =
  'Follow authoritative Chuon Nath Khmer Dictionary (វចនានុក្រមខ្មែរ ជួន ណាត PDF) spelling strictly for ALL words: ' +
  'always spell "ឲ្យ" (NEVER "អោយ" or "ឱ្យ"), and use standard Chuon Nath forms such as ' +
  'សម្រាប់, បម្រើ, បម្រុង, គម្រោង, សម្រាក, សម្រេច, ទម្លាប់, ជំងឺ, សម្លាញ់, សម្លាប់, សំឡេង, កម្លាំង, តម្លៃ, ចម្លើយ, ស្ត្រី, មន្ត្រី, ប្រព័ន្ធ, ប្រាកដ, បញ្ហា, កាតព្វកិច្ច, ឧស្សាហ៍, អ្វី។';

const KHMER_WORD_RUN_RE = /[\u1780-\u17D3\u17D7\u17DD]+/g;
const COMMON_SINGLE_KHMER_WORDS = new Set(['ឬ', 'ឯ', 'ឮ', 'ឪ']);

let cachedWordSet = null;
let cachedMaxWordLen = 32;
let cachedDynamicMap = null;

function countBaseConsonants(word) {
  const m = word.match(/[\u1780-\u17B3]/g);
  return m ? m.length : 0;
}

/**
 * Loads all Chuon Nath words (~24,704) and synthesizes collision-free dynamic spelling rules
 * across the entire vocabulary on first access.
 */
function ensureDictionaryLoaded() {
  if (cachedWordSet && cachedDynamicMap) return;

  let words = ['ឲ្យ'];
  try {
    if (fs.existsSync(CHUON_NATH_DATA_PATH)) {
      words = fs.readFileSync(CHUON_NATH_DATA_PATH, 'utf8')
        .split(/\r?\n/)
        .map(w => w.trim())
        .filter(Boolean);
    }
  } catch (err) {
    console.warn('[khmer-chuon-nath] Failed to load dictionary wordlist:', err.message);
  }

  const wordSet = new Set(words);
  let maxLen = 1;
  for (const w of wordSet) {
    if (w.length > maxLen) maxLen = w.length;
  }

  const candidates = new Map();
  const addCandidate = (wrong, canon) => {
    if (!wrong || wrong === canon) return;
    if (wordSet.has(wrong)) return;
    if (Object.prototype.hasOwnProperty.call(CHUON_NATH_SPELLING_MAP, wrong)) return;
    const prev = candidates.get(wrong);
    if (prev === undefined) {
      candidates.set(wrong, canon);
    } else if (prev !== null && prev !== canon) {
      candidates.set(wrong, null); // ambiguous variant; never blindly rewrite
    }
  };

  for (const canon of wordSet) {
    if (canon.length < 3) continue;
    const baseCount = countBaseConsonants(canon);

    // 1. C + ម្រ <-> wrong C + ំរ (require >=2 base consonants so short monosyllables never mis-fire)
    if (canon.includes('\u1798\u17D2\u179A') && baseCount >= 2 && canon.length >= 4) {
      addCandidate(canon.replace(/([\u1780-\u17A2])\u1798\u17D2\u179A/g, '$1\u17C6\u179A'), canon);
    }

    // 2. C + ម្ល <-> wrong C + ំល or C + ំឡ
    if (canon.includes('\u1798\u17D2\u179B') && baseCount >= 2 && canon.length >= 4) {
      addCandidate(canon.replace(/([\u1780-\u17A2])\u1798\u17D2\u179B/g, '$1\u17C6\u179B'), canon);
      addCandidate(canon.replace(/([\u1780-\u17A2])\u1798\u17D2\u179B/g, '$1\u17C6\u17A1'), canon);
    }

    // 3. C + ម្ង <-> wrong C + ំង (e.g. ទម្ងន់ <- ទំងន់, សម្ងាត់ <- សំងាត់, ចម្ងាយ <- ចំងាយ)
    if (canon.includes('\u1798\u17D2\u1784') && canon.length >= 4) {
      addCandidate(canon.replace(/([\u1780-\u17A2])\u1798\u17D2\u1784/g, '$1\u17C6\u1784'), canon);
    }

    // 4. ័យ <-> wrong យ័ (e.g. សម័យ <- សមយ័, បរាជ័យ <- បរាជយ័)
    if (canon.includes('\u17D0\u1799')) {
      addCandidate(canon.replace(/\u17D0\u1799/g, '\u1799\u17D0'), canon);
    }

    // 5. Subscript ្ត្រ / ្ដ្រ <-> wrong ្រ្ត / ្រ្ដ (e.g. កន្ត្រៃ <- កន្រ្តៃ, ស្ត្រី <- ស្រ្តី)
    if (canon.includes('\u17D2\u178F\u17D2\u179A')) {
      addCandidate(canon.replace(/\u17D2\u178F\u17D2\u179A/g, '\u17D2\u179A\u17D2\u178F'), canon);
    }
    if (canon.includes('\u17D2\u178A\u17D2\u179A')) {
      addCandidate(canon.replace(/\u17D2\u178A\u17D2\u179A/g, '\u17D2\u179A\u17D2\u178A'), canon);
    }

    // 6. C1 + ័ + C2 <-> wrong C1 + C2 + ័ (e.g. ប្រព័ន្ធ <- ប្រពន្ធ័)
    if (canon.includes('\u17D0') && !canon.includes('\u17D0\u1799') && canon.length >= 4) {
      addCandidate(
        canon.replace(/([\u1780-\u17A2])\u17D0([\u1780-\u17A2](?:\u17D2[\u1780-\u17B3])*)/g, '$1$2\u17D0'),
        canon
      );
    }

    // 7. Trailing ៈ -> wrong ះ (e.g. កម្ពុជៈ <- កម្ពុជះ, គណៈ <- គណះ)
    if (canon.endsWith('\u17C8') && canon.length >= 4) {
      addCandidate(canon.slice(0, -1) + '\u17C7', canon);
    }

    // 8. Trailing ៍ -> wrong ៏ (skipping [កដ]៏ to never collide with compound ក៏ / ដ៏ particles)
    if (canon.endsWith('\u17CD') && canon.length >= 5) {
      const wrong = canon.slice(0, -1) + '\u17CF';
      if (!/[កដ]\u17CF$/.test(wrong)) {
        addCandidate(wrong, canon);
      }
    }
  }

  const dynamicMap = new Map();
  for (const [wrong, canon] of candidates.entries()) {
    if (canon) dynamicMap.set(wrong, canon);
  }

  cachedWordSet = wordSet;
  cachedMaxWordLen = maxLen;
  cachedDynamicMap = dynamicMap;
}

/**
 * Returns the full loaded Chuon Nath dictionary Set (~24,704 words).
 */
function getChuonNathWordSet() {
  ensureDictionaryLoaded();
  return cachedWordSet;
}

/**
 * Returns synthesized unambiguous dynamic spelling rules derived across all Chuon Nath words.
 */
function getDynamicSpellingMap() {
  ensureDictionaryLoaded();
  return cachedDynamicMap;
}

/**
 * Returns dictionary and dynamic-rule counts for monitoring and API introspection.
 */
function getChuonNathStats() {
  ensureDictionaryLoaded();
  return {
    totalWords: cachedWordSet.size,
    dynamicRules: cachedDynamicMap.size
  };
}

/**
 * Checks whether an exact Khmer word exists in the loaded Chuon Nath dictionary dataset.
 */
function isChuonNathWord(word) {
  const clean = String(word || '').trim();
  if (!clean) return false;
  return getChuonNathWordSet().has(clean);
}

/**
 * Repairs inverted Unicode typing order where a dependent vowel precedes a subscript coeng
 * (e.g., "អី្វ" -> "អ្វី", "សី្ត" -> "ស្ដី").
 */
function fixKhmerClusterOrder(text) {
  let out = String(text || '');
  if (!/[\u17B6-\u17C5]\u17D2/.test(out)) return out;
  for (let pass = 0; pass < 2; pass++) {
    const next = out.replace(/([\u17B6-\u17C5])(\u17D2[\u1780-\u17B3](?:\u17D2[\u1780-\u17B3])*)/g, '$2$1');
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Computes valid Khmer grapheme/syllable boundary positions inside a Khmer word run.
 */
function computeKhmerSplitBoundaries(run) {
  const n = run.length;
  const canSplit = new Uint8Array(n + 1);
  canSplit[0] = 1;
  canSplit[n] = 1;
  for (let i = 1; i < n; i++) {
    if (/[\u17B6-\u17D3\u17D7\u17DD]/.test(run[i]) || run[i - 1] === '\u17D2') {
      canSplit[i] = 0;
    } else {
      canSplit[i] = 1;
    }
  }
  return canSplit;
}

/**
 * Segments a single contiguous Khmer word run into Chuon Nath words via dynamic programming.
 * When includeDynamicMisspellings is true, also recognizes unambiguous synthesized wrong spellings
 * so unspaced misspellings like "ទំលាយកន្រ្តៃ" are kept whole instead of split across letters.
 */
function segmentKhmerRunTokens(run, baseOffset = 0, includeDynamicMisspellings = false) {
  ensureDictionaryLoaded();
  const n = run.length;
  if (!n) return [];

  if (cachedWordSet.has(run)) {
    return [{ text: run, start: baseOffset, end: baseOffset + n, isKhmer: true, inDict: true }];
  }

  const canSplit = computeKhmerSplitBoundaries(run);
  const nextBound = new Int32Array(n + 1);
  let lastB = n;
  nextBound[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    nextBound[i] = lastB;
    if (canSplit[i]) lastB = i;
  }

  const INF = 1e12;
  const dpUnknown = new Float64Array(n + 1);
  const dpCost = new Float64Array(n + 1);
  const dpNext = new Int32Array(n + 1);
  const dpInDict = new Uint8Array(n + 1);
  dpUnknown.fill(INF);
  dpCost.fill(INF);
  dpUnknown[n] = 0;
  dpCost[n] = 0;

  for (let i = n - 1; i >= 0; i--) {
    if (!canSplit[i]) continue;

    // Candidate dictionary (and optional dynamic misspelling) matches starting at boundary i
    const maxEnd = Math.min(n, i + cachedMaxWordLen);
    for (let end = i + 1; end <= maxEnd; end++) {
      if (!canSplit[end]) continue;
      const slice = run.slice(i, end);
      const isCanon = cachedWordSet.has(slice);
      const isDyn = !isCanon && includeDynamicMisspellings && cachedDynamicMap.has(slice);
      if (!isCanon && !isDyn) continue;

      const unk = dpUnknown[end];
      const len = end - i;
      const stepPenalty = isCanon
        ? (100 + (len === 1 && !COMMON_SINGLE_KHMER_WORDS.has(slice) ? 60 : 0) + (len === 2 ? 12 : 0))
        : 145;
      const cost = stepPenalty + dpCost[end];

      if (unk < dpUnknown[i] || (unk === dpUnknown[i] && cost < dpCost[i])) {
        dpUnknown[i] = unk;
        dpCost[i] = cost;
        dpNext[i] = end;
        dpInDict[i] = isCanon ? 1 : 2;
      }
    }

    // Fallback: advance by one full syllable cluster as an unknown segment
    const fbEnd = nextBound[i];
    const fbUnk = (fbEnd - i) + dpUnknown[fbEnd];
    const fbCost = 100 + dpCost[fbEnd];
    if (fbUnk < dpUnknown[i] || (fbUnk === dpUnknown[i] && fbCost < dpCost[i])) {
      dpUnknown[i] = fbUnk;
      dpCost[i] = fbCost;
      dpNext[i] = fbEnd;
      dpInDict[i] = 0;
    }
  }

  const rawTokens = [];
  let pos = 0;
  while (pos < n) {
    const nextPos = dpNext[pos] > pos ? dpNext[pos] : nextBound[pos];
    rawTokens.push({
      text: run.slice(pos, nextPos),
      start: baseOffset + pos,
      end: baseOffset + nextPos,
      isKhmer: true,
      inDict: dpInDict[pos] === 1,
      isDynamic: dpInDict[pos] === 2
    });
    pos = nextPos;
  }

  if (includeDynamicMisspellings) {
    return rawTokens;
  }

  // Merge adjacent unknown syllable clusters into unified unknown words
  const merged = [];
  for (const tok of rawTokens) {
    const prev = merged[merged.length - 1];
    if (prev && !prev.inDict && !tok.inDict) {
      prev.text += tok.text;
      prev.end = tok.end;
    } else {
      merged.push(tok);
    }
  }
  return merged;
}

/**
 * Segments any text into interleaved Chuon Nath Khmer word tokens and non-Khmer spans.
 */
function segmentKhmerWithChuonNath(text) {
  const input = String(text || '');
  if (!input) return [];
  ensureDictionaryLoaded();

  const segments = [];
  let lastIdx = 0;
  KHMER_WORD_RUN_RE.lastIndex = 0;
  let m;
  while ((m = KHMER_WORD_RUN_RE.exec(input)) !== null) {
    if (m.index > lastIdx) {
      segments.push({
        text: input.slice(lastIdx, m.index),
        start: lastIdx,
        end: m.index,
        isKhmer: false,
        inDict: false
      });
    }
    const runTokens = segmentKhmerRunTokens(m[0], m.index);
    for (const tok of runTokens) {
      segments.push(tok);
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < input.length) {
    segments.push({
      text: input.slice(lastIdx),
      start: lastIdx,
      end: input.length,
      isKhmer: false,
      inDict: false
    });
  }
  return segments;
}

/**
 * Normalizes a Khmer word run at Chuon Nath DP token boundaries using dynamic spelling rules.
 * Never alters exact dictionary words or matches across non-boundary internal prefixes/suffixes.
 */
function normalizeRunWithDynamicRules(run) {
  ensureDictionaryLoaded();
  if (!run || cachedWordSet.has(run)) return run;
  const direct = cachedDynamicMap.get(run);
  if (direct) return direct;

  const tokens = segmentKhmerRunTokens(run, 0, true);
  return tokens.map(tok => (tok.isDynamic ? (cachedDynamicMap.get(tok.text) || tok.text) : tok.text)).join('');
}

/**
 * Normalizes Khmer text to standard Chuon Nath Dictionary orthography
 * ("ឲ្យ", Unicode cluster order, static high-frequency rules, and DP boundary-safe dynamic repair).
 */
function normalizeKhmerChuonNath(text) {
  let out = String(text || '');
  if (!/[\u1780-\u17FF]/.test(out)) return out;
  out = fixKhmerClusterOrder(out);
  out = out.replace(CHUON_NATH_REPLACE_RE, match => CHUON_NATH_SPELLING_MAP[match] || match);
  ensureDictionaryLoaded();
  out = out.replace(KHMER_WORD_RUN_RE, run => normalizeRunWithDynamicRules(run));
  return out;
}

/**
 * Audits Khmer text against the full Chuon Nath dictionary after normalization.
 */
function auditKhmerAgainstChuonNath(text) {
  const normalizedText = normalizeKhmerChuonNath(text);
  const segments = segmentKhmerWithChuonNath(normalizedText);
  const khmerTokens = segments.filter(s => s.isKhmer);
  const matchedTokens = khmerTokens.filter(s => s.inDict).length;
  const unknownSet = new Set();
  for (const tok of khmerTokens) {
    if (!tok.inDict) unknownSet.add(tok.text);
  }
  const totalTokens = khmerTokens.length;
  return {
    totalTokens,
    matchedTokens,
    unknownTokens: [...unknownSet],
    normalizedText,
    coverage: totalTokens > 0 ? Number((matchedTokens / totalTokens).toFixed(4)) : 1
  };
}

module.exports = {
  CHUON_NATH_DATA_PATH,
  CHUON_NATH_SPELLING_MAP,
  CHUON_NATH_PROMPT_GUIDE,
  getChuonNathWordSet,
  getDynamicSpellingMap,
  getChuonNathStats,
  isChuonNathWord,
  fixKhmerClusterOrder,
  segmentKhmerWithChuonNath,
  normalizeKhmerChuonNath,
  auditKhmerAgainstChuonNath
};
