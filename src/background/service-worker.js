// service-worker.js — Message router between content script and offscreen document
//
// New architecture (v0.3.0):
//   Audio playback lives in the content script (audio-player.js), NOT in offscreen.
//   Offscreen is a generation-only engine — it hosts the TTS worker and writes to IDB.
//   Chrome can kill the offscreen doc without interrupting audio playback.
//
// Message routing:
//   chrome.runtime.sendMessage from content scripts → reaches SW + offscreen
//   chrome.runtime.sendMessage from offscreen → reaches SW only (NOT content scripts)
//   chrome.tabs.sendMessage from SW → reaches content scripts

import { splitSentences } from '../utils/sentence-splitter.js';

let activeTtsTabId = null;
let onboardingTabId = null;
let lastKnownUrl = null;

// ── Persist activeTtsTabId in session storage across SW restarts ──────────────

async function persistActiveTtsTabId(tabId) {
    activeTtsTabId = tabId;
    chrome.storage.session?.set({ activeTtsTabId: tabId }).catch(() => {});
}

async function restoreActiveTtsTabId() {
    // Return in-memory value if we already have it
    if (activeTtsTabId) return activeTtsTabId;
    try {
        const stored = await chrome.storage.session?.get(['activeTtsTabId']);
        const storedId = stored?.activeTtsTabId;
        if (storedId) {
            try {
                // Verify the tab still exists before trusting the stored ID
                await chrome.tabs.get(storedId);
                activeTtsTabId = storedId;
                console.log('[service-worker] restored activeTtsTabId from session:', storedId);
            } catch (_) {
                // Tab no longer exists — clear the stale entry
                chrome.storage.session?.remove(['activeTtsTabId']).catch(() => {});
            }
        }
    } catch (_) {}
    return activeTtsTabId;
}

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

// ── Offscreen document lifecycle ─────────────────────────────────────────────

async function ensureOffscreenDocument() {
    const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (contexts.length > 0) return;

    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'TTS inference via Web Worker + ONNX Runtime',
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
    persistActiveTtsTabId(tab.id);

    chrome.tabs.sendMessage(tab.id, { type: 'SHOW_WIDGET', initialState: 'loading' }).catch(() => {});

    if (info.selectionText) {
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
                });
            }
        }
    } else {
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_AND_PLAY' }).catch(() => {});
    }
});

// ── Extension icon click ─────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
    console.log('[service-worker] icon clicked, tab:', tab?.id);
    if (!tab?.id) return;

    await ensureOffscreenDocument();
    persistActiveTtsTabId(tab.id);
    if (tab.url) persistLastUrl(tab.url);

    // Step 1: Check if content script already has audio in memory
    let contentState = null;
    try {
        contentState = await Promise.race([
            chrome.tabs.sendMessage(tab.id, { type: 'QUERY_PLAYBACK_STATE' }),
            new Promise(resolve => setTimeout(() => resolve(null), 600)),
        ]);
    } catch (_) {}

    if (contentState?.hasAudio) {
        // Content script already has audio — just show the widget
        const initialState = contentState.isPlaying ? 'playing' : 'paused';
        chrome.tabs.sendMessage(tab.id, { type: 'SHOW_WIDGET', initialState }).catch(() => {});
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_FOR_HIGHLIGHT' }).catch(() => {});
        console.log('[service-worker] reconnecting to content script audio, state:', initialState);
        return;
    }

    // Step 2: Check offscreen for IDB cache hit
    let cacheStatus = { hit: false, generating: false };
    try {
        const response = await Promise.race([
            chrome.runtime.sendMessage({ type: 'QUERY_CACHE', url: tab.url }),
            new Promise(resolve => setTimeout(() => resolve(null), 600)),
        ]);
        if (response) cacheStatus = response;
    } catch (_) {}

    console.log('[service-worker] cache status:', JSON.stringify(cacheStatus));

    if (cacheStatus.hit) {
        // IDB cache hit — show widget, tell offscreen to load and send to content script
        chrome.tabs.sendMessage(tab.id, { type: 'SHOW_WIDGET', initialState: 'loading' }).catch(() => {});
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_FOR_HIGHLIGHT' }).catch(() => {});
        chrome.runtime.sendMessage({ type: 'LOAD_FROM_CACHE', url: tab.url }).catch(() => {});
        console.log('[service-worker] cache hit — loading from IDB');
    } else if (cacheStatus.generating) {
        // Offscreen is already generating for this URL — show widget
        chrome.tabs.sendMessage(tab.id, { type: 'SHOW_WIDGET', initialState: 'loading' }).catch(() => {});
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_FOR_HIGHLIGHT' }).catch(() => {});
        console.log('[service-worker] generation in progress — reconnecting');
    } else {
        // Fresh start — extract and generate
        try {
            await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_WIDGET', initialState: 'loading' });
            chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_AND_STAGE' }).catch(() => {});
            console.log('[service-worker] fresh start — extract and stage');
        } catch (_) {
            console.log('[service-worker] content script unreachable');
            chrome.action.setBadgeText({ text: '!', tabId: tab.id });
            chrome.action.setBadgeBackgroundColor({ color: '#FA8072', tabId: tab.id });
            chrome.action.setTitle({
                title: 'Cannot read this page directly.\nSelect text \u2192 right-click \u2192 "Read aloud with AudiTex"',
                tabId: tab.id,
            });
            setTimeout(() => {
                chrome.action.setBadgeText({ text: '', tabId: tab.id }).catch(() => {});
                chrome.action.setTitle({ title: 'AudiTex \u2014 Read this page aloud', tabId: tab.id }).catch(() => {});
            }, 5000);
        }
    }
});

// ── Message routing ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // ── Onboarding page ──────────────────────────────────────────────────
    if (message.type === 'ONBOARDING_READY') {
        onboardingTabId = sender.tab?.id || null;
        console.log('[service-worker] ONBOARDING_READY from tab', onboardingTabId);
        ensureOffscreenDocument().catch(() => {});
        return false;
    }

    const fromContentScript = !!sender.tab;
    const source = fromContentScript ? `content-script(tab ${sender.tab.id})` : 'extension-page';
    console.log(`[service-worker] message: ${message.type} from ${source}`);

    if (fromContentScript) {
        if (message.type === 'EXTRACTION_RESULT') {
            persistActiveTtsTabId(sender.tab.id);
            if (message.pageUrl) persistLastUrl(message.pageUrl);
        } else if (message.type === 'WIDGET_ACTION') {
            console.log('[service-worker] WIDGET_ACTION:', message.action);

            // Actions that need to reach offscreen (generation-related)
            const offscreenActions = {
                'SWITCH_VOICE': { type: 'SWITCH_VOICE', voice: message.voice },
                'STOP':         { type: 'STOP' },
                'CLOSE_WIDGET': { type: 'CLOSE_WIDGET', pausedAtTime: message.pausedAtTime },
                'REQUEST_DOWNLOAD': { type: 'REQUEST_DOWNLOAD' },
                'SET_SPEED':    { type: 'SET_SPEED', speed: message.speed },
            };

            const mapped = offscreenActions[message.action];
            if (mapped) {
                chrome.runtime.sendMessage(mapped).catch(async (err) => {
                    if (err?.message?.includes('Receiving end does not exist')) {
                        console.warn('[service-worker] offscreen gone — recreating');
                        await ensureOffscreenDocument();
                        // If it was a close/stop, no need to resume
                        // If it was a voice switch, the new offscreen will pick up from storage
                    }
                });
            }
            // Note: TOGGLE_PLAY_PAUSE, SEEK_TO are handled locally by content script
            // and never reach here
        } else if (message.type === 'CHECK_OFFSCREEN_HEALTH') {
            // Content script detected a generation stall — check if offscreen is alive
            (async () => {
                try {
                    const response = await Promise.race([
                        chrome.runtime.sendMessage({ type: 'CHECK_ALIVE' }),
                        new Promise(resolve => setTimeout(() => resolve(null), 2000)),
                    ]);
                    if (!response) {
                        // Offscreen is dead — recreate and resume generation
                        console.warn('[service-worker] offscreen dead (stall check) — recreating');
                        await ensureOffscreenDocument();
                        // OFFSCREEN_READY will fire, triggering resume below
                    } else {
                        console.log('[service-worker] offscreen alive:', response);
                    }
                } catch (err) {
                    if (err?.message?.includes('Receiving end does not exist')) {
                        console.warn('[service-worker] offscreen dead (stall check) — recreating');
                        await ensureOffscreenDocument();
                    }
                }
            })();
            return false;
        }
        return false;
    }

    // ── OFFSCREEN_READY — offscreen just started (fresh or after termination) ──
    if (message.type === 'OFFSCREEN_READY') {
        (async () => {
            const url = await getLastUrl();
            // Restore persisted tab ID in case the SW was restarted
            const tabId = await restoreActiveTtsTabId();
            if (!url || !tabId) return;

            let tabUrl = null;
            try { tabUrl = (await chrome.tabs.get(tabId))?.url; } catch (_) {}
            if (!tabUrl || !urlsMatch(url, tabUrl)) return;

            // Check if content script's generation is still incomplete
            let contentState = null;
            try {
                contentState = await Promise.race([
                    chrome.tabs.sendMessage(tabId, { type: 'QUERY_PLAYBACK_STATE' }),
                    new Promise(resolve => setTimeout(() => resolve(null), 600)),
                ]);
            } catch (_) {}

            if (contentState && !contentState.generationDone) {
                // Generation was interrupted — tell offscreen to resume.
                // Pass contentLastSentenceIndex so offscreen can detect and resend any
                // chunks that were written to IDB but not yet received by the content script.
                console.log('[service-worker] OFFSCREEN_READY — resuming generation for', url);
                const contentLastSentenceIndex = contentState.lastSentenceIndex ?? -1;
                chrome.runtime.sendMessage({
                    type: 'RESUME_GENERATION',
                    url,
                    contentLastSentenceIndex,
                }).catch(() => {});
            } else {
                console.log('[service-worker] OFFSCREEN_READY — no resume needed');
            }
        })();
        return false;
    }

    // ── Relay messages from offscreen that are tagged for forwarding ─────────────
    // Offscreen marks each message at its source (relayToContent / relayToOnboarding)
    // instead of maintaining a set here — no need to update SW when new message types added.
    if (message.relayToContent || message.relayToOnboarding) {
        (async () => {
            if (message.relayToContent) {
                const tabId = await restoreActiveTtsTabId();
                if (tabId) {
                    chrome.tabs.sendMessage(tabId, message).catch((err) => {
                        if (err.message?.includes('Receiving end does not exist')) {
                            console.warn(`[service-worker] content script gone in tab ${tabId}`);
                            activeTtsTabId = null;
                            chrome.storage.session?.remove(['activeTtsTabId']).catch(() => {});
                        }
                    });
                }
            }
            if (message.relayToOnboarding && onboardingTabId) {
                chrome.tabs.sendMessage(onboardingTabId, message).catch(() => {});
            }
        })();
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

// ── Tab cleanup ──────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === activeTtsTabId) {
        chrome.runtime.sendMessage({ type: 'CANCEL_ALL' }).catch(() => {});
        activeTtsTabId = null;
        // Also clear the session-persisted value so it doesn't get restored
        chrome.storage.session?.remove(['activeTtsTabId']).catch(() => {});
    }
    if (tabId === onboardingTabId) {
        onboardingTabId = null;
    }
});
