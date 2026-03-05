// service-worker.js — Message router between content script widget and offscreen document
//
// Message routing:
//   chrome.runtime.sendMessage from content scripts → reaches SW + offscreen
//   chrome.runtime.sendMessage from offscreen → reaches SW only (NOT content scripts)
//   chrome.tabs.sendMessage from SW → reaches content scripts
//
// So the SW must relay offscreen→content script messages via chrome.tabs.sendMessage.

import { splitSentences } from '../utils/sentence-splitter.js';

let activeTtsTabId = null;
// Tab ID of the onboarding page (if open) — receives loading progress relay.
let onboardingTabId = null;
// Last known page URL — persisted to chrome.storage.session to survive SW sleep/wake.
// Used to restore offscreen state if Chrome terminates it while the user is paused.
let lastKnownUrl = null;

async function persistLastUrl(url) {
    lastKnownUrl = url;
    chrome.storage.session?.set({ lastKnownUrl: url }).catch(() => {});
}

async function getLastUrl() {
    if (lastKnownUrl) return lastKnownUrl;
    try {
        const r = await chrome.storage.session?.get(['lastKnownUrl']);
        lastKnownUrl = r?.lastKnownUrl || null;
    } catch (_) {}
    return lastKnownUrl;
}

function urlsMatch(a, b) {
    try {
        const norm = u => { const x = new URL(u); return x.origin + x.pathname.replace(/\/$/, ''); };
        return norm(a) === norm(b);
    } catch (_) { return a === b; }
}

// ── Offscreen document lifecycle ────────────────────────────────────────────

async function ensureOffscreenDocument() {
    const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (contexts.length > 0) return;

    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'TTS audio scheduling via Web Audio API',
    });
}

// ── Context menu + onboarding on install/update ──────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
    console.log('[service-worker] AudiTex installed/updated, reason:', details.reason);
    chrome.contextMenus.create({
        id: 'kokoro-tts-play',
        title: 'Read aloud with AudiTex',
        contexts: ['page', 'selection'],
    });
    // Open welcome/setup page on fresh install and on updates
    if (details.reason === 'install' || details.reason === 'update') {
        chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') }, (tab) => {
            onboardingTabId = tab.id;
        });
    }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== 'kokoro-tts-play') return;
    if (!tab?.id) return;

    await ensureOffscreenDocument();
    activeTtsTabId = tab.id;

    // Show widget on the page
    chrome.tabs.sendMessage(tab.id, { type: 'SHOW_WIDGET', initialState: 'loading' }).catch(() => {});

    if (info.selectionText) {
        // Selected text: split into sentences and send EXTRACTION_RESULT directly
        // to offscreen. Bypasses content script round-trip — more reliable, and
        // works even when no content script is present (PDF viewer, file://).
        const text = info.selectionText.trim();
        if (text.length > 0) {
            const sentences = splitSentences(text);
            const valid = sentences.filter(s => s.text.trim().length > 1);
            if (valid.length > 0) {
                const fullText = valid.map(s => s.text).join(' ');
                chrome.runtime.sendMessage({
                    type: 'EXTRACTION_RESULT',
                    sentences: valid,
                    wordCount: fullText.split(/\s+/).length,
                    title: tab.title || '',
                    // No pageUrl — selections don't pollute the page cache
                });
            }
        }
    } else {
        // Full page: tell content script to extract then send EXTRACTION_RESULT
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_AND_PLAY' }).catch(() => {});
    }
});

// ── Extension icon click ────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
    console.log('[service-worker] icon clicked, tab:', tab?.id, 'url:', tab?.url);
    if (!tab?.id) return;

    await ensureOffscreenDocument();
    console.log('[service-worker] offscreen document ready');
    activeTtsTabId = tab.id;
    if (tab.url) persistLastUrl(tab.url);

    // Ask offscreen: cached audio? in-progress generation? or fresh start?
    let status = { hit: false, hasAudio: false, generating: false, chunksReady: false };
    try {
        const response = await Promise.race([
            chrome.runtime.sendMessage({ type: 'QUERY_CACHE', url: tab.url }),
            new Promise(resolve => setTimeout(() => resolve(null), 600)),
        ]);
        if (response) status = response;
    } catch (_) {}

    console.log('[service-worker] cache status:', JSON.stringify(status));

    if (status.hit) {
        // Cached audio in IndexedDB — show widget immediately then load from cache
        chrome.tabs.sendMessage(tab.id, { type: 'SHOW_WIDGET', initialState: 'paused' }).catch(() => {});
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_FOR_HIGHLIGHT' }).catch(() => {});
        chrome.runtime.sendMessage({ type: 'LOAD_FROM_CACHE', url: tab.url }).catch(() => {});
        console.log('[service-worker] cache hit — loading from IndexedDB');
    } else if (status.hasAudio) {
        // Audio in memory (generation ongoing or paused) — reconnect widget
        const initialState = status.chunksReady ? 'paused' : 'loading';
        chrome.tabs.sendMessage(tab.id, { type: 'SHOW_WIDGET', initialState }).catch(() => {});
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_FOR_HIGHLIGHT' }).catch(() => {});
        if (status.chunksReady) {
            chrome.tabs.sendMessage(tab.id, { type: 'CHUNKS_READY' }).catch(() => {});
        }
        console.log('[service-worker] reconnecting to in-memory audio, state:', initialState);
    } else {
        // Fresh start — show spinner, begin extraction + generation.
        // If content script is unreachable (PDF, local file without file:// access),
        // warn the user instead of silently loading forever.
        try {
            await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_WIDGET', initialState: 'loading' });
            chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_AND_STAGE' }).catch(() => {});
            console.log('[service-worker] fresh start — extract and stage');
        } catch (_) {
            console.log('[service-worker] content script unreachable — cannot extract page text');
            // No content script → show a notification via the offscreen (which relays status)
            // or just send an error that would show in the SW console.
            // Best we can do: show a brief notification via chrome.action badge/title.
            chrome.action.setBadgeText({ text: '!', tabId: tab.id });
            chrome.action.setBadgeBackgroundColor({ color: '#FA8072', tabId: tab.id });
            chrome.action.setTitle({
                title: 'Cannot read this page directly.\nSelect text → right-click → "Read aloud with AudiTex"',
                tabId: tab.id,
            });
            // Clear badge after 5 seconds
            setTimeout(() => {
                chrome.action.setBadgeText({ text: '', tabId: tab.id }).catch(() => {});
                chrome.action.setTitle({ title: 'AudiTex — Read this page aloud', tabId: tab.id }).catch(() => {});
            }, 5000);
        }
    }
});

// ── Message routing ─────────────────────────────────────────────────────────
//
// Most messages don't need routing — chrome.runtime.sendMessage already broadcasts:
//   Content script → EXTRACTION_RESULT → offscreen hears it directly
//   Offscreen → PLAYBACK_STATE/STATUS_UPDATE → content scripts hear it directly
//
// We only handle:
//   1. WIDGET_ACTION from content script: translate action names for offscreen
//   2. DOWNLOAD_AUDIO from offscreen: trigger chrome.downloads API
//   3. EXTRACTION_RESULT from content script: track activeTtsTabId (no forwarding)
//   4. ONBOARDING_READY: ensure offscreen is alive so model download begins

// Messages that the offscreen sends and the content script widget needs
const RELAY_TO_CONTENT = new Set([
    'PLAYBACK_STATE', 'STATUS_UPDATE', 'PROGRESS_UPDATE',
    'MODEL_READY', 'GENERATION_DONE', 'VOICE_READY', 'ERROR', 'CHUNKS_READY',
    'SENTENCE_PLAYING', 'DOWNLOAD_READY', 'CACHE_MISS',
]);

// Subset of the above to also relay to the onboarding page while it's open
const RELAY_TO_ONBOARDING = new Set(['STATUS_UPDATE', 'PROGRESS_UPDATE', 'MODEL_READY']);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // ── Onboarding page (extension tab) — handle before the content-script block ──
    // The onboarding page is in a tab (sender.tab is set) but is NOT a content script.
    if (message.type === 'ONBOARDING_READY') {
        onboardingTabId = sender.tab?.id || null;
        console.log('[service-worker] ONBOARDING_READY from tab', onboardingTabId);
        // Creating the offscreen document kicks off the model download automatically.
        ensureOffscreenDocument().catch(() => {});
        return false;
    }

    const fromContentScript = !!sender.tab;
    const source = fromContentScript ? `content-script(tab ${sender.tab.id})` : 'extension-page';
    console.log(`[service-worker] message: ${message.type} from ${source}`);

    if (fromContentScript) {
        if (message.type === 'EXTRACTION_RESULT') {
            // Track which tab is active; offscreen already got the message directly
            activeTtsTabId = sender.tab.id;
            console.log('[service-worker] activeTtsTabId set to', activeTtsTabId);
            if (message.pageUrl) persistLastUrl(message.pageUrl);
        } else if (message.type === 'WIDGET_ACTION') {
            console.log('[service-worker] WIDGET_ACTION:', message.action, message.action === 'SWITCH_VOICE' ? message.voice : '');
            // Translate widget actions to messages the offscreen understands
            const actionMap = {
                'TOGGLE_PLAY_PAUSE': { type: 'TOGGLE_PLAY_PAUSE' },
                'STOP':              { type: 'STOP' },
                'CLOSE_WIDGET':      { type: 'CLOSE_WIDGET' },
                'SWITCH_VOICE':      { type: 'SWITCH_VOICE', voice: message.voice },
                'SET_SPEED':         { type: 'SET_SPEED', speed: message.speed },
                'REQUEST_DOWNLOAD':  { type: 'REQUEST_DOWNLOAD' },
                'SEEK_TO':           { type: 'SEEK_TO', timeSeconds: message.timeSeconds },
            };
            const mapped = actionMap[message.action];
            if (mapped) {
                console.log('[service-worker] relaying to offscreen:', mapped.type, mapped.voice ?? '');
                chrome.runtime.sendMessage(mapped).catch(async (err) => {
                    if (err?.message?.includes('Receiving end does not exist')) {
                        // Offscreen was terminated by Chrome — recreate it.
                        // OFFSCREEN_READY will fire once it's alive, triggering RESTORE_SESSION.
                        console.warn('[service-worker] offscreen gone — recreating for session restore');
                        await ensureOffscreenDocument();
                    } else {
                        console.error('[service-worker] relay FAILED:', err);
                    }
                });
            }
        }
        return false;
    }

    // OFFSCREEN_READY — offscreen just started (fresh or after termination).
    // If we have a saved URL that matches the active tab, send a RESTORE_SESSION.
    if (message.type === 'OFFSCREEN_READY') {
        (async () => {
            const url = await getLastUrl();
            if (!url || !activeTtsTabId) return;
            // Only restore if the active tab is still on the same page
            let tabUrl = null;
            try { tabUrl = (await chrome.tabs.get(activeTtsTabId))?.url; } catch (_) {}
            if (!tabUrl || !urlsMatch(url, tabUrl)) return;
            console.log('[service-worker] OFFSCREEN_READY — sending RESTORE_SESSION for', url);
            chrome.runtime.sendMessage({ type: 'RESTORE_SESSION', url }).catch(() => {});
            // Tell content script to restore highlight and show widget
            chrome.tabs.sendMessage(activeTtsTabId, { type: 'SHOW_WIDGET', initialState: 'loading' }).catch(() => {});
            chrome.tabs.sendMessage(activeTtsTabId, { type: 'EXTRACT_FOR_HIGHLIGHT' }).catch(() => {});
        })();
        return false;
    }

    // From offscreen — relay state updates to the active tab's content script,
    // and also to the onboarding page for loading progress feedback.
    if (RELAY_TO_CONTENT.has(message.type)) {
        if (activeTtsTabId) {
            chrome.tabs.sendMessage(activeTtsTabId, message).catch((err) => {
                // Content script is gone (tab navigated, reloaded, or closed).
                // Clear the stale tab ID so subsequent relays don't keep failing.
                if (err.message?.includes('Receiving end does not exist')) {
                    console.warn(`[service-worker] content script gone in tab ${activeTtsTabId}, clearing activeTtsTabId`);
                    activeTtsTabId = null;
                } else {
                    console.error(`[service-worker] relay failed for ${message.type}:`, err.message);
                }
            });
        }
        // Relay loading progress + model-ready to the onboarding tab if it's open
        if (onboardingTabId && RELAY_TO_ONBOARDING.has(message.type)) {
            chrome.tabs.sendMessage(onboardingTabId, message).catch(() => {});
        }
        return false;
    }

    if (message.type === 'DOWNLOAD_AUDIO') {
        chrome.downloads.download({
            url: message.url,
            filename: message.filename,
        }).catch((err) => {
            console.error('[service-worker] download failed:', err);
        });
        return false;
    }

    return false;
});

// ── Tab cleanup ─────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === activeTtsTabId) {
        chrome.runtime.sendMessage({ type: 'CANCEL_ALL' }).catch(() => {});
        activeTtsTabId = null;
    }
    if (tabId === onboardingTabId) {
        onboardingTabId = null;
    }
});
