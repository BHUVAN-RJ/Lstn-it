// content-script.js — DOM extraction + floating widget injection

import { extractTextFromElement, cleanText, isValidText } from '../utils/text-cleaner.js';
import { splitSentences } from '../utils/sentence-splitter.js';
import { createWidget, showWidget, hideWidget, updateState, updateStatus, updateSeeker, markGenerationDone } from '../widget/widget.js';
import { prepareHighlighter, highlightSentence, clearHighlight } from '../utils/highlight-injector.js';

// ── Widget injection ────────────────────────────────────────────────────────

let widgetInjected  = false;
let chunksReady     = false; // set when CHUNKS_READY received; guards against SHOW_WIDGET/PLAYBACK_STATE reverting to spinner
let widgetState     = 'loading'; // mirrors the widget's current visual state

function setWidgetState(state) {
    widgetState = state;
    updateState(state);
}

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

function isEditorSite() {
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

function extractFromInnerText() {
    const rawText = (document.body.innerText || '').trim();
    if (!rawText) return { success: false, error: 'NO_TEXT_FOUND' };
    const sentences = splitSentences(rawText);
    const validSentences = sentences.filter(s => s.text.trim().length > 1 && countWords(s.text) >= 1);
    if (validSentences.length === 0) return { success: false, error: 'NO_TEXT_FOUND' };
    const fullText = validSentences.map(s => s.text).join(' ');
    return {
        success: true,
        text: fullText,
        sentences: validSentences,
        wordCount: countWords(fullText),
        title: document.title || '',
        rootEl: null, // no DOM highlighting for editor sites
    };
}

function extractPageText() {
    if (isEditorSite()) return extractFromInnerText();
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
            if (message.initialState) {
                // If chunks are already ready, don't revert a 'paused' widget back to 'loading'.
                // This guards against a race where SHOW_WIDGET(loading) arrives after CHUNKS_READY.
                const effectiveState = (chunksReady && message.initialState === 'loading') ? 'paused' : message.initialState;
                setWidgetState(effectiveState);
            }
            return false;
        }

        // ── Highlight-only extraction for cache reload ───────────────────
        case 'EXTRACT_FOR_HIGHLIGHT': {
            console.log('[content-script] EXTRACT_FOR_HIGHLIGHT — preparing highlighter without re-sending to offscreen');
            try {
                const result = extractPageText();
                if (result.success) {
                    if (result.rootEl) prepareHighlighter(result.rootEl, result.sentences);
                    console.log('[content-script] EXTRACT_FOR_HIGHLIGHT: highlighter ready');
                }
            } catch (err) {
                console.error('[content-script] EXTRACT_FOR_HIGHLIGHT error:', err);
            }
            return false;
        }

        case 'DOWNLOAD_READY': {
            markGenerationDone();
            return false;
        }

        case 'CHUNKS_READY': {
            console.log('[content-script] CHUNKS_READY — switching widget to paused/play state');
            chunksReady = true;
            // Don't overwrite 'playing' with 'paused' — happens when RESTORE_SESSION
            // auto-plays and CHUNKS_READY arrives after PLAYBACK_STATE:'playing'.
            if (widgetState !== 'playing') {
                setWidgetState('paused');
                updateStatus('Ready — click to play');
            }
            return false;
        }

        // ── Background staging (icon click): extract + generate without auto-play
        case 'EXTRACT_AND_STAGE': {
            chunksReady = false; // new generation starting — reset guard
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
                if (result.rootEl) prepareHighlighter(result.rootEl, result.sentences);
                chrome.runtime.sendMessage({
                    type: 'EXTRACTION_RESULT',
                    sentences: result.sentences,
                    wordCount: result.wordCount,
                    title: result.title,
                    pageUrl: window.location.href,
                    autoPlay: false,
                });
            } catch (err) {
                console.error('[content-script] EXTRACT_AND_STAGE error:', err);
            }
            return false;
        }

        case 'EXTRACT_AND_PLAY': {
            chunksReady = false; // new generation starting — reset guard
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
                if (result.rootEl) prepareHighlighter(result.rootEl, result.sentences);
                // Send extraction result to service worker → offscreen
                chrome.runtime.sendMessage({
                    type: 'EXTRACTION_RESULT',
                    sentences: result.sentences,
                    wordCount: result.wordCount,
                    title: result.title,
                    pageUrl: window.location.href,
                });
            } catch (err) {
                console.error('[content-script] extraction error:', err);
                updateStatus('Error extracting text.');
            }
            return false;
        }

        // ── Selection TTS: split selected text and send as proper sentences ──
        case 'EXTRACT_SELECTION': {
            chunksReady = false;
            const selSentences = splitSentences(message.text);
            const validSel = selSentences.filter(s => s.text.trim().length > 1 && countWords(s.text) >= 1);
            if (validSel.length === 0) return false;
            const selFullText = validSel.map(s => s.text).join(' ');
            chrome.runtime.sendMessage({
                type: 'EXTRACTION_RESULT',
                sentences: validSel,
                wordCount: countWords(selFullText),
                title: document.title || '',
                // autoPlay defaults to true (same as icon-click EXTRACT_AND_PLAY)
                // No pageUrl — selections don't pollute the page cache
            });
            return false;
        }

        // ── State updates from offscreen (via service worker) ───────────
        case 'SENTENCE_PLAYING': {
            highlightSentence(message.index);
            return false;
        }

        case 'PLAYBACK_STATE': {
            console.log('[content-script] PLAYBACK_STATE:', message.state);
            // Once chunks are ready, ignore 'loading' state (e.g. from voice switch LOADING_PROGRESS)
            // to prevent the play button from reverting back to a spinner.
            if (message.state === 'loading' && chunksReady) {
                return false;
            }
            if (message.state === 'stopped' || message.state === 'done') {
                chunksReady = false;
                clearHighlight();
            }
            setWidgetState(message.state);
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
            // Model loaded — generation will start shortly. Do NOT show play button here;
            // only CHUNKS_READY should transition the widget from loading to paused.
            console.log('[content-script] MODEL_READY received');
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
