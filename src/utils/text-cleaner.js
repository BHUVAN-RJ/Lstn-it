// text-cleaner.js — clean raw DOM text before phonemization

// Tags whose entire subtree should be discarded
const STRIP_TAGS = new Set([
    'script', 'style', 'noscript', 'figure', 'figcaption',
    'nav', 'footer', 'header', 'aside', 'form', 'button',
    'img', 'video', 'audio', 'canvas', 'svg', 'iframe',
    'template', 'dialog',
]);

// Inline tags: keep their text content, drop the tag wrapper
const INLINE_TAGS = new Set(['a', 'abbr', 'acronym', 'b', 'bdo', 'big',
    'cite', 'code', 'em', 'i', 'kbd', 'label', 'mark', 'q', 's',
    'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var']);

// Block elements that map to a paragraph break
const BLOCK_TAGS = new Set([
    'p', 'div', 'article', 'section', 'main',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'dt', 'dd', 'blockquote', 'pre',
    'tr', 'td', 'th',
]);

// Major headings that trigger a section-level pause (1.2s) in the audio.
// Emit \u0000 BEFORE these elements so the preceding sentence is marked
// endsWithSection: true by the sentence-splitter.
const HEADING_TAGS = new Set(['h1', 'h2', 'h3']);

/**
 * Walk a DOM element and return plain text, inserting '\n\n' at block
 * boundaries and a single space between inline elements.
 */
function domToText(el) {
    const parts = [];
    _walk(el, parts);
    return parts.join('');
}

function _walk(node, parts) {
    if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent;
        if (t) parts.push(t);
        return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();
    if (STRIP_TAGS.has(tag)) return;

    const isBlock   = BLOCK_TAGS.has(tag);
    const isHeading = HEADING_TAGS.has(tag);

    // Insert a section-break sentinel (\u0000) immediately before major headings
    // so the sentence-splitter can mark the preceding sentence endsWithSection.
    // \u0000 is not whitespace and survives all normalisation passes.
    if (isHeading) parts.push('\u0000');
    if (isBlock)   parts.push('\n\n');

    for (const child of node.childNodes) {
        _walk(child, parts);
    }

    if (isBlock) parts.push('\n\n');
}

// ── Text normalization helpers ────────────────────────────────────────────────

const QUOTE_MAP = {
    '\u2019': "'", '\u2018': "'", '\u0060': "'", '\u00B4': "'",
    '\u201C': '"', '\u201D': '"', '\u2033': '"',
    '\u2013': '-', '\u2014': '-',
    '\u2026': '...',
    '\u00A0': ' ',  // non-breaking space
};

function normalizeApostrophes(text) {
    return text.replace(/[\u2019\u2018\u0060\u00B4\u201C\u201D\u2033\u2013\u2014\u2026\u00A0]/g,
        (ch) => QUOTE_MAP[ch] ?? ch);
}

// Very broad emoji range (covers most common emoji blocks)
function removeEmojis(text) {
    return text.replace(
        /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FEFF}]/gu, ''
    );
}

function removeUrls(text) {
    return text.replace(/https?:\/\/\S+/g, '').replace(/www\.\S+/g, '');
}

/**
 * Expand a small set of common numeric patterns to words.
 * A full implementation (num2words) comes in a later phase if needed.
 */
function expandNumbers(text) {
    // Currency: $50 → "50 dollars"
    text = text.replace(/\$(\d+(?:\.\d{1,2})?)/g, (_, n) => `${n} dollars`);
    // Percentages: 25% → "25 percent"
    text = text.replace(/(\d+(?:\.\d+)?)\s*%/g, (_, n) => `${n} percent`);
    // Plain integers left as-is for now; phonemizer handles them adequately
    return text;
}

function collapseWhitespace(text) {
    // Collapse runs of spaces/tabs on a single line
    text = text.replace(/[ \t]+/g, ' ');
    // Collapse 3+ newlines to 2
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

/** Returns true if text has at least one alphabetic character */
function isValidText(text) {
    return /[a-zA-Z]/.test(text.trim());
}

/**
 * Full pipeline: DOM element → clean plain text string.
 * @param {Element} rootEl - a DOM element (e.g. <article>)
 * @returns {string}
 */
export function extractTextFromElement(rootEl) {
    let text = domToText(rootEl);
    text = normalizeApostrophes(text);
    text = removeEmojis(text);
    text = removeUrls(text);
    text = expandNumbers(text);
    text = collapseWhitespace(text);
    return text;
}

/**
 * Clean already-extracted plain text (when the caller already has a string).
 */
export function cleanText(rawText) {
    let text = rawText;
    text = normalizeApostrophes(text);
    text = removeEmojis(text);
    text = removeUrls(text);
    text = expandNumbers(text);
    text = collapseWhitespace(text);
    return text;
}

export { isValidText };
