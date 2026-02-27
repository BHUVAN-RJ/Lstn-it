// sentence-splitter.js — split cleaned text into sentences with metadata

// Common abbreviations that should NOT trigger a sentence split
const ABBREVS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'etc',
    'inc', 'ltd', 'corp', 'co', 'dept', 'est', 'approx',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
    'st', 'ave', 'blvd', 'rd', 'no', 'vol', 'fig', 'p', 'pp',
    'e.g', 'i.e', 'et', 'al',
]);

/**
 * @typedef {Object} Sentence
 * @property {string}  text              - The sentence text (trimmed)
 * @property {boolean} endsWithParagraph - true when there is a paragraph break after this sentence
 * @property {boolean} endsWithSection   - true when there is a section break (h1/h2/h3) after this sentence
 *                                         (triggers a 1.2 s pause in the audio player)
 */

/**
 * Split text into sentences.
 *
 * The text may contain:
 *   - '\u0000' — section-break sentinels inserted by text-cleaner before h1/h2/h3 headings
 *   - '\n\n'   — paragraph breaks
 *
 * The sentinel/break AFTER a sentence is reflected in the metadata of that sentence:
 *   - endsWithSection:   true → popup inserts 1.2 s pause
 *   - endsWithParagraph: true → popup inserts 0.6 s pause
 *   - (neither)          → popup inserts 0.25 s pause
 *
 * @param {string} text - Cleaned plain text (may contain \u0000 and \n\n breaks)
 * @returns {Sentence[]}
 */
export function splitSentences(text) {
    // 1. Split on section-break sentinels to identify section boundaries.
    //    Text before \u0000 ends with a section break; text after continues normally.
    const sections = text.split('\u0000');
    const sentences = [];

    for (let secIdx = 0; secIdx < sections.length; secIdx++) {
        const isLastSection = secIdx === sections.length - 1;
        const section = sections[secIdx];

        // 2. Within each section, split on paragraph breaks.
        const paragraphs = section.split(/\n\n+/);

        for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
            const para = paragraphs[pIdx].replace(/\n/g, ' ').trim();
            if (!para) continue;

            const paraSentences = splitParagraph(para);
            const isLastPara = pIdx === paragraphs.length - 1;

            for (let sIdx = 0; sIdx < paraSentences.length; sIdx++) {
                const isLastInPara = sIdx === paraSentences.length - 1;

                // A sentence gets endsWithSection when it's the very last sentence
                // before a \u0000 boundary (i.e., last in last paragraph of a non-final section).
                const endsWithSection   = isLastInPara && isLastPara && !isLastSection;
                // endsWithParagraph applies when there is a \n\n boundary but NOT a section boundary.
                const endsWithParagraph = isLastInPara && !isLastPara && !endsWithSection;

                sentences.push({
                    text: paraSentences[sIdx],
                    endsWithParagraph,
                    endsWithSection,
                });
            }
        }
    }

    return sentences.filter((s) => s.text.length > 0);
}

/**
 * Split a single paragraph (no double newlines) into sentences.
 * Uses a boundary-detection approach that respects abbreviations,
 * decimal numbers, and ellipsis.
 */
function splitParagraph(text) {
    // Tokenize by potential sentence boundaries: . ! ?
    // Strategy: scan character by character, accumulate into current sentence,
    // decide at each '.', '!', '?' whether it ends a sentence.

    const sentences = [];
    let current = '';

    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        current += ch;

        if (ch === '!' || ch === '?') {
            // Consume trailing punctuation (e.g. '?!' or '...')
            while (i + 1 < text.length && /[!?.]/.test(text[i + 1])) {
                i++;
                current += text[i];
            }
            const trimmed = current.trim();
            if (trimmed) sentences.push(trimmed);
            current = '';
            // Skip leading whitespace for next sentence
            while (i + 1 < text.length && text[i + 1] === ' ') i++;

        } else if (ch === '.') {
            // Check for ellipsis
            if (text[i + 1] === '.' && text[i + 2] === '.') {
                current += '..';
                i += 2;
                // Ellipsis mid-sentence — don't split
            } else if (isAbbreviation(current) || isDecimalNumber(current, text, i) || isListMarker(current)) {
                // Don't split
            } else if (isFollowedByUpperOrEnd(text, i)) {
                const trimmed = current.trim();
                if (trimmed) sentences.push(trimmed);
                current = '';
                while (i + 1 < text.length && text[i + 1] === ' ') i++;
            }
            // else: period mid-word or end of text — keep going
        }

        i++;
    }

    const remaining = current.trim();
    if (remaining) sentences.push(remaining);

    return sentences;
}

/** True if the text so far ends with a known abbreviation word */
function isAbbreviation(current) {
    // Extract the last word before the period
    const match = current.match(/([A-Za-z]+)\.$/);
    if (!match) return false;
    return ABBREVS.has(match[1].toLowerCase());
}

/**
 * True if the period follows a bare number with no preceding letters,
 * indicating an ordered-list marker such as "1.", "2.", "42." rather than
 * a sentence terminator.  Handles headings written in old-school HTML with
 * <b>1. Determination</b> — common on sites like paulgraham.com.
 */
function isListMarker(current) {
    // Strip everything before the trailing period, then check it's pure digits.
    return /^\d+$/.test(current.slice(0, -1).trim());
}

/** True if the period is part of a decimal number, e.g. "3.14" */
function isDecimalNumber(current, text, dotIndex) {
    const prevChar = current[current.length - 2]; // char before '.'
    const nextChar = text[dotIndex + 1];
    return /\d/.test(prevChar) && /\d/.test(nextChar);
}

/**
 * True when the character after the period (and any closing punctuation/quotes)
 * is an uppercase letter, a digit, or end-of-string — signalling a new sentence.
 */
function isFollowedByUpperOrEnd(text, dotIndex) {
    let j = dotIndex + 1;
    // Skip spaces and closing quotes/brackets
    while (j < text.length && /[\s'")\]}>]/.test(text[j])) j++;
    if (j >= text.length) return true;
    return /[A-Z0-9"']/.test(text[j]);
}
