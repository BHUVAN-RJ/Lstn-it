// extraction.js — Page text extraction strategies.
//
// Encapsulates all DOM-walking logic that turns a live web page into a
// list of sentence objects ready for TTS generation or read mode.

import { extractTextFromElement, isValidText } from '../utils/text-cleaner.js';
import { splitSentences } from '../utils/sentence-splitter.js';

// ── Word count helper ─────────────────────────────────────────────────────────

/**
 * Count the number of whitespace-separated words in a string.
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
}

// ── Editor site detection ─────────────────────────────────────────────────────

/**
 * Return true when the current page is a rich-text editor whose DOM structure
 * is not suitable for extractTextFromElement() walking.
 * Falls back to innerText-based extraction when this returns true.
 * @returns {boolean}
 */
export function isEditorSite() {
    const host = location.hostname;
    return (
        host.includes('docs.google.com') ||
        host.includes('sheets.google.com') ||
        host.includes('slides.google.com') ||
        host.includes('notion.so') ||
        host.includes('notion.site') ||
        host.includes('atlassian.net') ||
        host.endsWith('.confluence.com') ||
        host.includes('coda.io') ||
        host.includes('craft.do') ||
        host.includes('roamresearch.com') ||
        host.includes('obsidian.md')
    );
}

// ── DOM element selection strategies ─────────────────────────────────────────

/**
 * Return the most likely article element on the page by trying progressively
 * broader selectors before falling back to the largest text block.
 * @returns {Element}
 */
function findArticleElement() {
    const article = document.querySelector('article');
    if (article) return article;

    const main = document.querySelector('main');
    if (main) return main;

    const CONTENT_SELECTORS = [
        '[role="main"]',
        '.post-content', '.entry-content', '.article-body', '.article-content',
        '.story-body', '.post-body', '.content-body',
        '#content', '#main-content', '#article-body',
    ];
    for (const sel of CONTENT_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) return el;
    }

    return largestTextBlock();
}

/**
 * Walk all div/section/td elements and return the one with the most text
 * content (measured by innerText length).  Falls back to document.body
 * when nothing useful is found.
 * @returns {Element}
 */
function largestTextBlock() {
    let best = null;
    let bestLen = 0;

    const candidates = document.querySelectorAll('div, section, td');
    for (const el of candidates) {
        const len = el.innerText?.length ?? 0;
        const pCount = el.querySelectorAll('p').length;
        // Skip shallow elements that are unlikely to be the main content
        if (pCount < 3 && len < 400) continue;
        if (len > bestLen) {
            bestLen = len;
            best = el;
        }
    }

    return best ?? document.body;
}

// ── Fallback: innerText-based extraction ──────────────────────────────────────

/**
 * Extract text from the page using document.body.innerText.
 * Used on editor sites where the DOM walker would produce garbage.
 * @returns {{ success: boolean, error?: string, text?: string, sentences?: Array, wordCount?: number, title?: string, rootEl?: null }}
 */
function extractFromInnerText() {
    const rawText = (document.body.innerText || '').trim();
    if (!rawText) return { success: false, error: 'NO_TEXT_FOUND' };

    const sentences = splitSentences(rawText);
    const validSentences = sentences.filter(
        s => s.text.trim().length > 1 && countWords(s.text) >= 1
    );
    if (validSentences.length === 0) return { success: false, error: 'NO_TEXT_FOUND' };

    const fullText = validSentences.map(s => s.text).join(' ');
    return {
        success:   true,
        text:      fullText,
        sentences: validSentences,
        wordCount: countWords(fullText),
        title:     document.title || '',
        rootEl:    null,
    };
}

// ── Primary extraction entry point ────────────────────────────────────────────

/**
 * Extract all readable text from the current page.
 *
 * Returns a result object:
 *   { success: true, text, sentences, wordCount, title, rootEl }
 *   { success: false, error }
 *
 * On editor sites the rootEl will be null (innerText path).
 * On regular pages rootEl is the discovered article element so the caller
 * can pass it to prepareHighlighter().
 *
 * @returns {{ success: boolean, error?: string, text?: string, sentences?: Array, wordCount?: number, title?: string, rootEl?: Element|null }}
 */
export function extractPageText() {
    // Editor sites have complex DOM structures — fall back to raw innerText
    if (isEditorSite()) return extractFromInnerText();

    const rootEl = findArticleElement();
    const rawText = extractTextFromElement(rootEl);

    if (!isValidText(rawText)) {
        return { success: false, error: 'NO_TEXT_FOUND' };
    }

    const sentences = splitSentences(rawText);
    const validSentences = sentences.filter(
        s => s.text.trim().length > 1 && countWords(s.text) >= 1
    );

    if (validSentences.length === 0) {
        return { success: false, error: 'NO_TEXT_FOUND' };
    }

    const fullText = validSentences.map(s => s.text).join(' ');

    return {
        success:   true,
        text:      fullText,
        sentences: validSentences,
        wordCount: countWords(fullText),
        title:     document.title || '',
        rootEl,
    };
}
