// pronunciation-map.js — Word-level pronunciation overrides applied before
// phonemization.
//
// ── How to add a new entry ──────────────────────────────────────────────────
//
//   { from: 'OriginalText', to: 'spoken form' }
//
// Entries are sorted longest-first automatically, so you don't need to worry
// about ordering — "YC's" will always be matched before "YC".
//
// ── Matching rules ──────────────────────────────────────────────────────────
//
// Pure-word entries (only letters, digits, apostrophes, spaces):
//   Compiled to  \bWORD\b  — word-boundary safe.
//   Example: "YC" → \bYC\b  will NOT match inside "NYC".
//
// Entries containing punctuation/symbols (°F, vs., Node.js, if-else, etc.):
//   Literal string match — their surrounding chars already act as boundaries.
//
// ── Entry list ──────────────────────────────────────────────────────────────

const RAW_ENTRIES = [
    // — Tech / startup brands —
    { from: 'Airbnb',       to: 'Air BNB' },
    { from: "IonQ's",       to: 'Ion cues' },
    { from: 'Chesky',       to: 'Chess key' },
    { from: 'Node.js',      to: 'NodeJS' },
    { from: 'iPhone',       to: 'Iphone' },

    // — VC / startup shorthand —
    { from: "YC's",         to: 'Y Cees' },
    { from: "Y C's",        to: 'Y Cees' },
    { from: 'VCs',          to: "V C's" },
    { from: 'YC',           to: 'Y C' },

    // — Common abbreviations —
    { from: 'AWS',          to: 'eh W S' },
    { from: 'BTW',          to: 'by the way' },
    { from: 'U.S.',         to: 'U S' },

    // — People —
    { from: 'Bill Maher',   to: 'Bill Maar' },

    // — Punctuation / symbols —
    { from: 'if-else',      to: 'if else' },
    { from: '°F',           to: 'degree Fahrenheit' },
    { from: '°C',           to: 'degree Celsius' },
    { from: 'i.e.',         to: 'ie' },
    { from: ' vs.',         to: ' versus' },
    { from: '(vs.',         to: '(versus' },
];

// ── Pre-compilation ──────────────────────────────────────────────────────────

/**
 * Returns true if `str` contains only letters, digits, apostrophes, and spaces
 * (i.e. no punctuation that would interfere with \b word-boundary detection).
 */
function _isWordEntry(str) {
    return /^[a-zA-Z0-9'\s]+$/.test(str);
}

/**
 * Escape all regex special characters in a literal string.
 */
function _escapeRe(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sorted longest-first so longer patterns are matched before shorter prefixes
 * (e.g. "YC's" before "YC").  Pre-compiled into RegExp objects for speed.
 */
export const PRONUNCIATION_ENTRIES = RAW_ENTRIES
    .slice()
    .sort((a, b) => b.from.length - a.from.length)
    .map(({ from, to }) => {
        const escaped = _escapeRe(from);
        const re = _isWordEntry(from)
            ? new RegExp(`\\b${escaped}\\b`, 'g')   // word-boundary match
            : new RegExp(escaped, 'g');               // literal match
        return { re, to };
    });

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Apply all pronunciation overrides to a sentence of text.
 *
 * Call order in tts-worker.generateAudio():
 *   expandNumbers(rawText) → applyPronunciationMap() → splitAtClauseBoundaries()
 *
 * Must run in the worker (not in text-cleaner) so that the sentence text
 * reaching the highlight-injector is unchanged — DOM indexOf searches must
 * match the original text as it appears in the page.
 *
 * @param {string} text
 * @returns {string}
 */
export function applyPronunciationMap(text) {
    for (const { re, to } of PRONUNCIATION_ENTRIES) {
        text = text.replace(re, to);
    }
    return text;
}
