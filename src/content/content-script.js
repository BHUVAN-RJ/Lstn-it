// content-script.js — DOM extraction + floating widget injection

import { extractTextFromElement, cleanText, isValidText } from '../utils/text-cleaner.js';
import { splitSentences } from '../utils/sentence-splitter.js';
import { createWidget, showWidget, hideWidget, updateState, updateStatus, updateSeeker } from '../widget/widget.js';
import { prepareHighlighter, highlightSentence, clearHighlight } from '../utils/highlight-injector.js';

// ── Widget injection ────────────────────────────────────────────────────────

let widgetInjected = false;

function injectWidget() {
    if (widgetInjected) return;
    widgetInjected = true;

    const shadowHost = document.createElement('div');
    shadowHost.id = 'kokoro-tts-host';
    shadowHost.style.cssText = 'position:fixed;top:125px;right:200px;z-index:2147483647;pointer-events:none;';
    document.body.appendChild(shadowHost);

    const shadow = shadowHost.attachShadow({ mode: 'closed' });

    createWidget(shadow, shadowHost);
}

// ── Extraction strategies (tried in order) ──────────────────────────────────

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

function largestTextBlock() {
    let best = null;
    let bestLen = 0;

    // Include td for table-based old-school sites (e.g. paulgraham.com)
    const candidates = document.querySelectorAll('div, section, td');
    for (const el of candidates) {
        const len = el.innerText?.length ?? 0;
        // Require either multiple <p> tags or a substantial text length (>400 chars)
        // so we don't pick tiny cells / navbars on table-based layouts
        const pCount = el.querySelectorAll('p').length;
        if (pCount < 3 && len < 400) continue;
        if (len > bestLen) {
            bestLen = len;
            best = el;
        }
    }

    return best ?? document.body;
}

function countWords(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
}

function extractPageText() {
    const rootEl = findArticleElement();
    const rawText = extractTextFromElement(rootEl);

    if (!isValidText(rawText)) {
        return { success: false, error: 'NO_TEXT_FOUND' };
    }

    const sentences = splitSentences(rawText);
    // Allow single-word sentences (e.g. section headings like "Upwind", "Ambition")
    // but reject truly empty or single-character fragments (".") that slip through.
    const validSentences = sentences.filter((s) => s.text.trim().length > 1 && countWords(s.text) >= 1);

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
        rootEl, // used by highlight-injector
    };
}

// ── Message listener ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
        // ── Original extraction (direct request) ────────────────────────
        case 'EXTRACT_TEXT': {
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
            return true;
        }

        // ── Widget lifecycle ────────────────────────────────────────────
        case 'SHOW_WIDGET': {
            console.log('[content-script] SHOW_WIDGET received, initialState:', message.initialState);
            injectWidget();
            showWidget();
            if (message.initialState) updateState(message.initialState);
            return false;
        }

        case 'CHUNKS_READY': {
            console.log('[content-script] CHUNKS_READY — switching widget to paused/play state');
            updateState('paused');
            updateStatus('Ready — click to play');
            return false;
        }

        // ── Background staging (icon click): extract + generate without auto-play
        case 'EXTRACT_AND_STAGE': {
            console.log('[content-script] EXTRACT_AND_STAGE — extracting for background generation');
            try {
                const result = extractPageText();
                if (!result.success) {
                    console.warn('[content-script] EXTRACT_AND_STAGE: no text found');
                    return false;
                }
                console.log(
                    `[content-script] extracted ${result.wordCount} words,`,
                    `${result.sentences.length} sentences (staged)`
                );
                prepareHighlighter(result.rootEl, result.sentences);
                chrome.runtime.sendMessage({
                    type: 'EXTRACTION_RESULT',
                    sentences: result.sentences,
                    wordCount: result.wordCount,
                    title: result.title,
                    autoPlay: false,
                });
            } catch (err) {
                console.error('[content-script] EXTRACT_AND_STAGE error:', err);
            }
            return false;
        }

        case 'EXTRACT_AND_PLAY': {
            console.log('[content-script] EXTRACT_AND_PLAY — extracting and sending to offscreen');
            try {
                const result = extractPageText();
                if (!result.success) {
                    updateStatus('No text found on this page.');
                    return false;
                }
                console.log(
                    `[content-script] extracted ${result.wordCount} words,`,
                    `${result.sentences.length} sentences`
                );
                prepareHighlighter(result.rootEl, result.sentences);
                // Send extraction result to service worker → offscreen
                chrome.runtime.sendMessage({
                    type: 'EXTRACTION_RESULT',
                    sentences: result.sentences,
                    wordCount: result.wordCount,
                    title: result.title,
                });
            } catch (err) {
                console.error('[content-script] extraction error:', err);
                updateStatus('Error extracting text.');
            }
            return false;
        }

        // ── State updates from offscreen (via service worker) ───────────
        case 'SENTENCE_PLAYING': {
            highlightSentence(message.index);
            return false;
        }

        case 'PLAYBACK_STATE': {
            console.log('[content-script] PLAYBACK_STATE:', message.state);
            updateState(message.state);
            if (message.state === 'done' || message.state === 'stopped') {
                clearHighlight();
            }
            return false;
        }

        case 'PROGRESS_UPDATE': {
            if (message.current != null && message.total != null) {
                updateSeeker(message.current, message.total);
            }
            return false;
        }

        case 'STATUS_UPDATE': {
            updateStatus(message.text);
            return false;
        }

        case 'MODEL_READY': {
            console.log('[content-script] MODEL_READY received');
            updateState('paused');
            updateStatus('Ready — click extension icon to play');
            return false;
        }

        case 'GENERATION_DONE': {
            // Generation complete; playback continues until audio buffer drains
            return false;
        }

        case 'VOICE_READY': {
            updateStatus('Voice switched');
            return false;
        }

        case 'ERROR': {
            console.error('[content-script] ERROR:', message.code, message.detail);
            updateStatus(`Error: ${message.detail || message.code}`);
            return false;
        }
    }

    return false;
});
