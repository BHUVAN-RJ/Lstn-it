// service-worker.js — Message router between content script widget and offscreen document
//
// Message routing:
//   chrome.runtime.sendMessage from content scripts → reaches SW + offscreen
//   chrome.runtime.sendMessage from offscreen → reaches SW only (NOT content scripts)
//   chrome.tabs.sendMessage from SW → reaches content scripts
//
// So the SW must relay offscreen→content script messages via chrome.tabs.sendMessage.

let activeTtsTabId = null;

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

// ── Context menu ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
    console.log('[service-worker] Kokoro TTS installed.');
    chrome.contextMenus.create({
        id: 'kokoro-tts-play',
        title: 'Read aloud with Kokoro TTS',
        contexts: ['page', 'selection'],
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== 'kokoro-tts-play') return;
    if (!tab?.id) return;

    await ensureOffscreenDocument();
    activeTtsTabId = tab.id;

    // Show widget on the page
    chrome.tabs.sendMessage(tab.id, { type: 'SHOW_WIDGET' }).catch(() => {});

    if (info.selectionText) {
        // Selected text: send directly to offscreen (via broadcast), skip extraction
        chrome.runtime.sendMessage({
            type: 'EXTRACTION_RESULT',
            sentences: [{ text: info.selectionText, endsWithParagraph: false, endsWithSection: false }],
            wordCount: info.selectionText.trim().split(/\s+/).length,
            title: tab.title || '',
        }).catch(() => {});
    } else {
        // Full page: tell content script to extract then send EXTRACTION_RESULT
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_AND_PLAY' }).catch(() => {});
    }
});

// ── Extension icon click ────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
    console.log('[service-worker] icon clicked, tab:', tab?.id);
    if (!tab?.id) return;

    await ensureOffscreenDocument();
    console.log('[service-worker] offscreen document ready');
    activeTtsTabId = tab.id;

    // Start text extraction + background generation immediately — no widget yet
    chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_AND_STAGE' }).catch(() => {});
    console.log('[service-worker] sent EXTRACT_AND_STAGE to tab', tab.id);

    // Show widget after 2s; query offscreen for ready state to set initial icon
    setTimeout(async () => {
        let initialState = 'loading';
        try {
            const response = await chrome.runtime.sendMessage({ type: 'QUERY_READY_STATE' });
            if (response?.chunksReady) initialState = 'paused';
        } catch (_) {}
        chrome.tabs.sendMessage(tab.id, { type: 'SHOW_WIDGET', initialState }).catch(() => {});
        console.log('[service-worker] showed widget after 2s, initialState:', initialState);
    }, 1000);
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

// Messages that the offscreen sends and the content script widget needs
const RELAY_TO_CONTENT = new Set([
    'PLAYBACK_STATE', 'STATUS_UPDATE', 'PROGRESS_UPDATE',
    'MODEL_READY', 'GENERATION_DONE', 'VOICE_READY', 'ERROR', 'CHUNKS_READY',
    'SENTENCE_PLAYING',
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const fromContentScript = !!sender.tab;
    const source = fromContentScript ? `content-script(tab ${sender.tab.id})` : 'extension-page';
    console.log(`[service-worker] message: ${message.type} from ${source}`);

    if (fromContentScript) {
        if (message.type === 'EXTRACTION_RESULT') {
            // Track which tab is active; offscreen already got the message directly
            activeTtsTabId = sender.tab.id;
            console.log('[service-worker] activeTtsTabId set to', activeTtsTabId);
        } else if (message.type === 'WIDGET_ACTION') {
            console.log('[service-worker] WIDGET_ACTION:', message.action, message.action === 'SWITCH_VOICE' ? message.voice : '');
            // Translate widget actions to messages the offscreen understands
            const actionMap = {
                'TOGGLE_PLAY_PAUSE': { type: 'TOGGLE_PLAY_PAUSE' },
                'STOP':              { type: 'STOP' },
                'SWITCH_VOICE':      { type: 'SWITCH_VOICE', voice: message.voice },
                'SET_SPEED':         { type: 'SET_SPEED', speed: message.speed },
                'REQUEST_DOWNLOAD':  { type: 'REQUEST_DOWNLOAD' },
                'SEEK_TO':           { type: 'SEEK_TO', timeSeconds: message.timeSeconds },
            };
            const mapped = actionMap[message.action];
            if (mapped) {
                console.log('[service-worker] relaying to offscreen:', mapped.type, mapped.voice ?? '');
                chrome.runtime.sendMessage(mapped).catch((err) => {
                    console.error('[service-worker] relay FAILED:', err);
                });
            }
        }
        return false;
    }

    // From offscreen — relay state updates to the active tab's content script
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
});
