// content-script.js — Phase 2: extract and clean article text from the page

import { extractTextFromElement, cleanText, isValidText } from '../utils/text-cleaner.js';
import { splitSentences } from '../utils/sentence-splitter.js';

// ── Extraction strategies (tried in order) ───────────────────────────────────

/**
 * Try to find the main article element using several heuristics.
 * Returns an Element or null.
 */
function findArticleElement() {
    // 1. Explicit <article> tag
    const article = document.querySelector('article');
    if (article) return article;

    // 2. <main> tag
    const main = document.querySelector('main');
    if (main) return main;

    // 3. Common CMS/blog content selectors
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

    // 4. Fallback: the <div> with the most paragraph text
    return largestTextBlock();
}

/**
 * Find the block-level element that contains the most visible text.
 * Considers only divs/sections that have at least 3 <p> descendants.
 */
function largestTextBlock() {
    let best = null;
    let bestLen = 0;

    const candidates = document.querySelectorAll('div, section');
    for (const el of candidates) {
        const pCount = el.querySelectorAll('p').length;
        if (pCount < 3) continue;
        const len = el.innerText?.length ?? 0;
        if (len > bestLen) {
            bestLen = len;
            best = el;
        }
    }

    return best ?? document.body;
}

// ── Counting helpers ─────────────────────────────────────────────────────────

function countWords(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
}

// ── Main extraction function ─────────────────────────────────────────────────

function extractPageText() {
    const rootEl = findArticleElement();
    const rawText = extractTextFromElement(rootEl);

    if (!isValidText(rawText)) {
        return { success: false, error: 'NO_TEXT_FOUND' };
    }

    const sentences = splitSentences(rawText);
    // Filter out sentence fragments that are too short to be meaningful
    const validSentences = sentences.filter((s) => countWords(s.text) >= 3);

    if (validSentences.length === 0) {
        return { success: false, error: 'NO_TEXT_FOUND' };
    }

    const fullText = validSentences.map((s) => s.text).join(' ');

    return {
        success: true,
        text: fullText,
        sentences: validSentences,
        wordCount: countWords(fullText),
        title: document.title || '',
    };
}

// ── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'EXTRACT_TEXT') return false;

    console.log('[content-script] EXTRACT_TEXT — starting extraction');

    try {
        const result = extractPageText();
        console.log(
            `[content-script] extracted ${result.wordCount ?? 0} words,`,
            `${result.sentences?.length ?? 0} sentences`
        );
        sendResponse(result);
    } catch (err) {
        console.error('[content-script] extraction error:', err);
        sendResponse({ success: false, error: 'UNKNOWN', message: err.message });
    }

    return true; // keep channel open for async response
});
