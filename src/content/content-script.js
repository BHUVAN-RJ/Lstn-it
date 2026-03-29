// content-script.js — Thin orchestrator: wires extraction, read-mode, widget, and audio player.
//
// Audio playback lives in audio-player.js (survives offscreen termination).
// Page text extraction logic lives in extraction.js.
// Read-mode timer state machine lives in read-mode.js.

import { extractPageText, countWords } from './extraction.js';
import { splitSentences } from '../utils/sentence-splitter.js';
import {
    initReadMode as initReadModeModule,
    loadReadModePreferences,
    isEnabled as isReadModeEnabled,
    isPaused as isReadModePaused,
    getWpm as getReadModeWpm,
    getSentences as getReadModeSentences,
    setSentences as setReadModeSentences,
    getPageUrl as getReadModePageUrl,
    setPageUrl as setReadModePageUrl,
    getSentenceIndex as getReadModeSentenceIndex,
    startReadMode,
    stopReadMode,
    toggleReadModePlayPause,
    adjustWpm,
    getPositionKey,
    DEFAULT_WPM,
} from './read-mode.js';
import {
    createWidget, showWidget, hideWidget,
    updateState, updateStatus, updateSeeker,
    markGenerationDone, setActionHandler, updateReadMode,
    updateTurboMode,
} from '../widget/widget.js';
import { prepareHighlighter, highlightSentence, clearHighlight } from '../utils/highlight-injector.js';
import * as audioPlayer from './audio-player.js';

// ── Module-level state (only what cannot move to a sub-module) ────────────────

let widgetInjected  = false;
let chunksReady     = false;
let widgetState     = 'loading';

// Cached extraction result — enables read-mode ↔ audio-mode switching without
// re-walking the DOM.
let lastExtractionResult = null;

// Streaming cache load state — accumulates CACHE_LOAD_CHUNK messages until
// CACHE_LOAD_DONE fires, then hands all entries to the audio player at once.
let pendingCacheEntries   = [];
let pendingCacheResume    = 0;
let pendingCacheTitle     = '';
// Safety timeout: if CACHE_LOAD_DONE never arrives (offscreen killed mid-stream),
// release the accumulated entries so they don't hold memory indefinitely.
let pendingCacheTimeoutId = null;
const CACHE_LOAD_TIMEOUT_MS = 30000;

// Target seek time after a GC-triggered cache reload. Set by the needCacheReload
// callback, consumed by the CACHE_LOAD_DONE handler once audio is restored.
let pendingSeekAfterReload = null;

// ── Storage-ready gate ────────────────────────────────────────────────────────
// SHOW_WIDGET and EXTRACT_AND_STAGE can arrive before storage resolves.
// Both handlers chain off this promise to avoid a race condition.

let _resolveStorageReady;
const storageReadyPromise = new Promise(resolve => { _resolveStorageReady = resolve; });

loadReadModePreferences().then(({ enabled, wpm }) => {
    // Re-sync button state if widget was injected before storage resolved
    if (widgetInjected) updateReadMode(enabled, wpm);
    _resolveStorageReady();
}).catch(() => { _resolveStorageReady(); });

// ── Widget state helper ───────────────────────────────────────────────────────

function setWidgetState(state) {
    widgetState = state;
    updateState(state);
}

// ── Widget injection ──────────────────────────────────────────────────────────

function injectWidget() {
    if (widgetInjected) return;

    // Guard: document.body may be null on PDF viewers and some special pages.
    // Don't set widgetInjected=true until the DOM append actually succeeds so
    // a future SHOW_WIDGET can retry once the body is available.
    if (!document.body) {
        console.warn('[content-script] injectWidget: document.body not ready — skipping');
        return;
    }

    widgetInjected = true;

    try {
        const shadowHost = document.createElement('div');
        shadowHost.id = 'kokoro-tts-host';
        shadowHost.style.cssText = 'position:fixed;top:125px;right:200px;z-index:2147483647;pointer-events:none;';
        document.body.appendChild(shadowHost);

        const shadow = shadowHost.attachShadow({ mode: 'closed' });
        createWidget(shadow, shadowHost);

        // Wire up all widget actions to the local handler
        setActionHandler(handleWidgetAction);
    } catch (err) {
        console.error('[content-script] injectWidget failed:', err);
        widgetInjected = false; // allow retry on next SHOW_WIDGET
    }
}

// ── Read-mode callbacks ───────────────────────────────────────────────────────
// Called by read-mode.js to drive the widget and highlighter without
// importing them directly (avoids circular dependency).

initReadModeModule({
    stateChange(state) {
        setWidgetState(state);
    },
    statusUpdate(text) {
        updateStatus(text);
    },
    seekerUpdate(current, total) {
        updateSeeker(current, total);
    },
    highlight(index) {
        highlightSentence(index);
    },
    clearHighlight() {
        clearHighlight();
    },
});

// ── Audio player initialisation ───────────────────────────────────────────────

audioPlayer.init({
    stateChange(state) {
        console.log('[content-script] audio-player state:', state);
        if (state === 'stopped' || state === 'done') {
            chunksReady = false;
            clearHighlight();
        }
        // Don't propagate audio state to widget while read-only mode is active —
        // read mode manages widget state (playing/paused/done) via its own timer.
        if (isReadModeEnabled()) return;
        setWidgetState(state);
    },
    statusUpdate(text) {
        updateStatus(text);
    },
    progressUpdate(pct, current, total) {
        updateSeeker(current, total);
    },
    sentencePlaying(index) {
        highlightSentence(index);
    },
    chunksReady() {
        console.log('[content-script] chunks ready — switching to paused');
        chunksReady = true;
        if (widgetState !== 'playing') {
            setWidgetState('paused');
            updateStatus('Ready \u2014 click to play');
        }
    },
    generationDone() {
        console.log('[content-script] generation done');
        markGenerationDone();
    },
    generationStall() {
        // Offscreen may have been killed — ask SW to check and restart
        console.warn('[content-script] generation stall — pinging SW');
        chrome.runtime.sendMessage({ type: 'CHECK_OFFSCREEN_HEALTH' }).catch(() => {});
    },
    needCacheReload(targetTime) {
        // Audio data for this seek target was released by GC — reload from cache
        console.log('[content-script] cache reload requested for seek to', targetTime.toFixed(2));
        pendingSeekAfterReload = targetTime;
        chrome.runtime.sendMessage({ type: 'LOAD_FROM_CACHE', url: window.location.href }).catch(() => {});
    },
});

// ── Keyboard shortcut: Space = play/pause when TTS widget is active ───────────

document.addEventListener('keydown', (keyEvent) => {
    if (!widgetInjected) return;

    // Do not intercept keyboard events when the user is typing in a field
    const targetTag = keyEvent.target.tagName;
    const isTyping = targetTag === 'INPUT'
        || targetTag === 'TEXTAREA'
        || targetTag === 'SELECT'
        || keyEvent.target.isContentEditable;
    if (isTyping) return;

    if (keyEvent.code === 'Space' && !keyEvent.ctrlKey && !keyEvent.metaKey && !keyEvent.altKey) {
        const playerState = audioPlayer.getState();
        // Only intercept Space when the widget has loaded audio or is visibly active
        const isActiveWidget = playerState.hasAudio
            || widgetState === 'playing'
            || widgetState === 'paused';
        if (!isActiveWidget) return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        handleWidgetAction({ action: 'TOGGLE_PLAY_PAUSE' });
    }
}, true); // capture phase — intercepts before the page handles Space

// ── Widget action handler (local routing) ─────────────────────────────────────

function handleWidgetAction(action) {
    console.log('[content-script] widget action:', action.action);

    switch (action.action) {
        case 'TOGGLE_PLAY_PAUSE':
            if (isReadModeEnabled()) {
                toggleReadModePlayPause();
            } else {
                // Handled locally — AudioContext must stay in user gesture chain
                audioPlayer.togglePlayPause();
            }
            break;

        case 'TOGGLE_READ_MODE': {
            const nowActive = !isReadModeEnabled();
            chrome.storage.local.set({ readMode: nowActive }).catch(() => {});
            updateReadMode(nowActive, getReadModeWpm());

            if (nowActive) {
                // Capture audio position BEFORE stopping so read-mode starts from the
                // same sentence the user was listening to.
                const audioSentenceIdx = Math.max(0, audioPlayer.getCurrentSentenceIndex() ?? 0);

                // Stop audio and cancel offscreen generation (separate systems).
                audioPlayer.stop();
                chrome.runtime.sendMessage({ type: 'WIDGET_ACTION', action: 'STOP' }).catch(() => {});
                chunksReady = false;

                const sentences = getReadModeSentences();
                if (sentences.length > 0) {
                    startReadMode(sentences, audioSentenceIdx, getReadModePageUrl());
                } else {
                    // Sentences not yet extracted (very early click) — wait for them.
                    setWidgetState('loading');
                }
            } else {
                // Switch back to audio mode — stop read timer, restart generation.
                stopReadMode();
                if (lastExtractionResult) {
                    audioPlayer.reset();
                    chrome.runtime.sendMessage({
                        type:      'EXTRACTION_RESULT',
                        sentences: lastExtractionResult.sentences,
                        wordCount: lastExtractionResult.wordCount,
                        title:     lastExtractionResult.title,
                        pageUrl:   lastExtractionResult.pageUrl,
                        autoPlay:  false,
                    }).catch(() => {});
                    setWidgetState('loading');
                } else {
                    setWidgetState('loading');
                }
            }
            break;
        }

        case 'SET_READ_WPM': {
            const newWpm = adjustWpm(action.delta);
            chrome.storage.local.set({ readModeWpm: newWpm }).catch(() => {});
            updateReadMode(isReadModeEnabled(), newWpm);
            // Restart timer for the current sentence at the new speed — step back one
            // sentence so it isn't skipped (mirrors the original clearTimeout + decrement).
            if (isReadModeEnabled() && !isReadModePaused()) {
                const backIdx = Math.max(0, getReadModeSentenceIndex() - 1);
                startReadMode(null, backIdx, getReadModePageUrl());
            }
            break;
        }

        case 'SEEK_TO':
            audioPlayer.seekTo(action.timeSeconds);
            break;

        case 'SET_SPEED':
            // Local: audio-player applies WSOLA at this speed
            audioPlayer.setSpeed(action.speed);
            // Also inform offscreen (in case it's relevant for model)
            chrome.runtime.sendMessage({ type: 'WIDGET_ACTION', ...action }).catch(() => {});
            break;

        case 'SWITCH_VOICE': {
            const playerState  = audioPlayer.getState();
            const currentIdx   = audioPlayer.getCurrentSentenceIndex();
            const isMidGeneration = !playerState.generationDone && currentIdx >= 0;

            if (isMidGeneration) {
                // Cancel buffered future audio and requeue in new voice from current sentence
                audioPlayer.trimAndRestartFrom(currentIdx);
                chrome.runtime.sendMessage({
                    type:              'WIDGET_ACTION',
                    action:            'VOICE_SWITCH_RESTART',
                    voice:             action.voice,
                    fromSentenceIndex: currentIdx,
                }).catch(() => {});
            } else {
                // Not generating or position unknown — just switch for next generation
                chrome.runtime.sendMessage({ type: 'WIDGET_ACTION', ...action }).catch(() => {});
            }
            break;
        }

        case 'CLOSE_WIDGET': {
            // Stop audio locally
            const pauseTime = audioPlayer.getPausedAtTime();
            audioPlayer.stop();
            clearHighlight();
            // Tell offscreen to cancel generation + save position
            chrome.runtime.sendMessage({
                type:         'WIDGET_ACTION',
                action:       'CLOSE_WIDGET',
                pausedAtTime: pauseTime,
            }).catch(() => {});
            break;
        }

        case 'STOP':
            audioPlayer.stop();
            clearHighlight();
            chrome.runtime.sendMessage({ type: 'WIDGET_ACTION', action: 'STOP' }).catch(() => {});
            break;

        case 'REQUEST_DOWNLOAD':
            // Download handled by offscreen (loads from IDB, encodes)
            chrome.runtime.sendMessage({ type: 'WIDGET_ACTION', action: 'REQUEST_DOWNLOAD' }).catch(() => {});
            break;

        case 'TOGGLE_TURBO': {
            const enabled = action.enabled;
            audioPlayer.setTurboMode(enabled);
            chrome.storage.local.set({ turboMode: enabled }).catch(() => {});
            // Worker count can only change when offscreen is recreated on the next
            // generation — surface this to the user so the button state is not confusing.
            const playerState = audioPlayer.getState();
            const isActiveGeneration = playerState.hasAudio && !playerState.generationDone;
            if (isActiveGeneration) {
                updateStatus(`Turbo ${enabled ? 'ON' : 'OFF'} — takes effect next article`);
            }
            console.log(`[content-script] turbo mode ${enabled ? 'ON' : 'OFF'}`);
            break;
        }

        case 'SET_TURBO_INITIAL': {
            // Widget loaded prefs and is informing us of the initial turbo state
            audioPlayer.setTurboMode(action.enabled);
            break;
        }

        default:
            // Forward anything else to offscreen via SW
            chrome.runtime.sendMessage({ type: 'WIDGET_ACTION', ...action }).catch(() => {});
    }
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
        // ── Extraction ───────────────────────────────────────────────────
        case 'EXTRACT_TEXT': {
            console.log('[content-script] EXTRACT_TEXT');
            try {
                const result = extractPageText();
                sendResponse(result);
            } catch (err) {
                sendResponse({ success: false, error: 'UNKNOWN', message: err.message });
            }
            return true;
        }

        // ── Widget lifecycle ─────────────────────────────────────────────
        case 'SHOW_WIDGET': {
            console.log('[content-script] SHOW_WIDGET, initialState:', message.initialState);
            injectWidget();
            showWidget();
            // Sync read mode button once storage is definitely loaded
            storageReadyPromise.then(() => updateReadMode(isReadModeEnabled(), getReadModeWpm()));
            if (message.initialState) {
                const effectiveState = (chunksReady && message.initialState === 'loading')
                    ? 'paused' : message.initialState;
                setWidgetState(effectiveState);
            }
            return false;
        }

        // ── Highlight-only extraction for cache reload ───────────────────
        case 'EXTRACT_FOR_HIGHLIGHT': {
            console.log('[content-script] EXTRACT_FOR_HIGHLIGHT');
            try {
                const result = extractPageText();
                if (result.success && result.rootEl) {
                    prepareHighlighter(result.rootEl, result.sentences);
                }
            } catch (err) {
                console.error('[content-script] EXTRACT_FOR_HIGHLIGHT error:', err);
            }
            return false;
        }

        // ── Background staging: extract + generate without auto-play ─────
        case 'EXTRACT_AND_STAGE': {
            chunksReady = false;
            audioPlayer.reset();
            setReadModePageUrl(window.location.href);
            console.log('[content-script] EXTRACT_AND_STAGE');
            try {
                const result = extractPageText();
                if (!result.success) {
                    console.warn('[content-script] EXTRACT_AND_STAGE: no text found');
                    return false;
                }
                if (result.rootEl) prepareHighlighter(result.rootEl, result.sentences);
                // Always store sentences so read mode timer can use them
                setReadModeSentences(result.sentences);
                lastExtractionResult = {
                    sentences: result.sentences,
                    wordCount: result.wordCount,
                    title:     result.title,
                    pageUrl:   window.location.href,
                };

                // Wait for storage to resolve before checking isReadModeEnabled() —
                // avoids the race condition where EXTRACT_AND_STAGE fires before the
                // chrome.storage.local.get promise has returned.
                // Also handles the case where the user toggled read mode before
                // sentences were available (widget showed 'loading').
                storageReadyPromise.then(() => {
                    if (!isReadModeEnabled()) return;
                    const posKey = getPositionKey();
                    chrome.storage.local.get([posKey]).then(r => {
                        // Only start if read mode is still active (user may have toggled back)
                        if (isReadModeEnabled()) {
                            startReadMode(result.sentences, r[posKey] ?? 0, window.location.href);
                        }
                    }).catch(() => {
                        if (isReadModeEnabled()) startReadMode(result.sentences, 0, window.location.href);
                    });
                });

                chrome.runtime.sendMessage({
                    type:      'EXTRACTION_RESULT',
                    sentences: result.sentences,
                    wordCount: result.wordCount,
                    title:     result.title,
                    pageUrl:   window.location.href,
                    autoPlay:  false,
                });
            } catch (err) {
                console.error('[content-script] EXTRACT_AND_STAGE error:', err);
            }
            return false;
        }

        case 'EXTRACT_AND_PLAY': {
            chunksReady = false;
            audioPlayer.reset();
            setReadModePageUrl(window.location.href);
            console.log('[content-script] EXTRACT_AND_PLAY');
            try {
                const result = extractPageText();
                if (!result.success) {
                    updateStatus('No text found on this page.');
                    return false;
                }
                if (result.rootEl) prepareHighlighter(result.rootEl, result.sentences);
                // Populate sentences so switching to read mode mid-playback works
                setReadModeSentences(result.sentences);
                lastExtractionResult = {
                    sentences: result.sentences,
                    wordCount: result.wordCount,
                    title:     result.title,
                    pageUrl:   window.location.href,
                };
                chrome.runtime.sendMessage({
                    type:      'EXTRACTION_RESULT',
                    sentences: result.sentences,
                    wordCount: result.wordCount,
                    title:     result.title,
                    pageUrl:   window.location.href,
                });
            } catch (err) {
                updateStatus('Error extracting text.');
            }
            return false;
        }

        // ── Selection TTS ────────────────────────────────────────────────
        case 'EXTRACT_SELECTION': {
            chunksReady = false;
            audioPlayer.reset();
            const selSentences = splitSentences(message.text);
            const validSel = selSentences.filter(s => s.text.trim().length > 1 && countWords(s.text) >= 1);
            if (validSel.length === 0) return false;
            const selFullText = validSel.map(s => s.text).join(' ');
            chrome.runtime.sendMessage({
                type:      'EXTRACTION_RESULT',
                sentences: validSel,
                wordCount: countWords(selFullText),
                title:     document.title || '',
            });
            return false;
        }

        // ── Audio chunks from offscreen (via SW relay) ───────────────────
        case 'AUDIO_CHUNK_READY': {
            // In read mode audio is suppressed — generation runs in background for caching
            if (isReadModeEnabled()) return false;
            audioPlayer.queueChunk({
                samples:           message.samples,
                sampleRate:        message.sampleRate,
                sentenceIndex:     message.sentenceIndex,
                countAsChunk:      message.countAsChunk,
                isMidChunk:        message.isMidChunk,
                endsWithParagraph: message.endsWithParagraph,
                endsWithSection:   message.endsWithSection,
                pauseAfterMs:      message.pauseAfterMs,
            });
            return false;
        }

        // ── Cached audio loaded by offscreen from IDB (streaming) ────────
        // Offscreen streams entries one-by-one to avoid Chrome's 64MiB message
        // limit. We buffer them here and hand them to the audio player on DONE.
        case 'CACHE_LOAD_START': {
            console.log('[content-script] CACHE_LOAD_START:', message.count, 'chunks');
            // Clear any previous in-flight load before starting a new one
            if (pendingCacheTimeoutId) {
                clearTimeout(pendingCacheTimeoutId);
                pendingCacheTimeoutId = null;
            }
            pendingCacheEntries = [];
            pendingCacheResume  = message.resumePosition ?? 0;
            pendingCacheTitle   = message.title ?? '';
            // Safety: release entries if CACHE_LOAD_DONE never arrives
            pendingCacheTimeoutId = setTimeout(() => {
                console.warn('[content-script] CACHE_LOAD_DONE never arrived — releasing pending entries');
                pendingCacheEntries   = [];
                pendingCacheTimeoutId = null;
            }, CACHE_LOAD_TIMEOUT_MS);
            return false;
        }

        case 'CACHE_LOAD_CHUNK': {
            pendingCacheEntries.push({
                data:          message.data,
                sampleRate:    message.sampleRate,
                countAsChunk:  message.countAsChunk,
                sentenceIndex: message.sentenceIndex,
                pauseAfter:    message.pauseAfter,
            });
            return false;
        }

        case 'CACHE_LOAD_DONE': {
            if (pendingCacheTimeoutId) {
                clearTimeout(pendingCacheTimeoutId);
                pendingCacheTimeoutId = null;
            }
            console.log('[content-script] CACHE_LOAD_DONE:', pendingCacheEntries.length, 'chunks buffered');
            audioPlayer.loadCachedAudio(pendingCacheEntries, pendingCacheResume);
            chunksReady = true;
            setWidgetState('paused');
            updateStatus(`"${pendingCacheTitle}" ready to play`);
            markGenerationDone();
            pendingCacheEntries = [];
            // If a GC-triggered cache reload had a pending seek target, apply it now
            if (pendingSeekAfterReload !== null) {
                const seekTime = pendingSeekAfterReload;
                pendingSeekAfterReload = null;
                audioPlayer.seekTo(seekTime);
            }
            return false;
        }

        // ── Legacy single-message cache path (kept for forward compat) ───
        case 'CACHE_LOADED': {
            console.log('[content-script] CACHE_LOADED:', message.entries?.length, 'entries');
            audioPlayer.loadCachedAudio(message.entries, message.resumePosition);
            chunksReady = true;
            setWidgetState('paused');
            updateStatus(`"${message.title}" ready to play`);
            markGenerationDone();
            return false;
        }

        case 'CACHE_MISS': {
            console.warn('[content-script] CACHE_MISS — starting fresh extraction');
            return false;
        }

        // ── Generation lifecycle from offscreen ──────────────────────────
        case 'GENERATION_DONE': {
            audioPlayer.markGenerationDone();
            return false;
        }

        case 'DOWNLOAD_READY': {
            markGenerationDone();
            return false;
        }

        case 'CHUNKS_READY': {
            // Legacy — kept for compatibility during transition
            chunksReady = true;
            if (widgetState !== 'playing') {
                setWidgetState('paused');
                updateStatus('Ready \u2014 click to play');
            }
            return false;
        }

        // ── State updates from offscreen (via SW relay) ──────────────────
        case 'PLAYBACK_STATE': {
            console.log('[content-script] PLAYBACK_STATE:', message.state);
            // Only process 'loading' state from offscreen (model loading, etc.)
            // Play/pause/done states are now driven by the local audio player
            if (message.state === 'loading' && !chunksReady) {
                setWidgetState('loading');
            }
            return false;
        }

        case 'PROGRESS_UPDATE': {
            // Only process progress from offscreen during model loading (pct from LOADING_PROGRESS).
            // Playback progress is driven locally by audio-player.js.
            return false;
        }

        case 'STATUS_UPDATE': {
            updateStatus(message.text);
            return false;
        }

        case 'MODEL_READY': {
            console.log('[content-script] MODEL_READY');
            return false;
        }

        case 'SENTENCE_PLAYING': {
            // Legacy — kept for transition. In new arch, audio-player fires directly.
            highlightSentence(message.index);
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

        // ── SW queries content script for playback state ─────────────────
        case 'QUERY_PLAYBACK_STATE': {
            const state = audioPlayer.getState();
            sendResponse({
                hasAudio:          state.hasAudio,
                isPlaying:         state.isPlaying,
                generationDone:    state.generationDone,
                lastSentenceIndex: state.lastSentenceIndex,
                playbackStarted:   state.playbackStarted,
            });
            return true;
        }
    }

    return false;
});

// ── Page unload cleanup ───────────────────────────────────────────────────────
// Prevents stale incomplete chunks from accumulating in IDB across page loads.

window.addEventListener('pagehide', () => {
    // Release AudioContext + audioHistory before the page is torn down.
    // Without this, the AudioContext stays open holding the audio device, and
    // audioHistory (potentially hundreds of MB of Float32 data) stays in memory.
    // On SPAs this also handles client-side navigation where pagehide fires.
    audioPlayer.reset();

    chrome.runtime.sendMessage({ type: 'PAGE_UNLOAD', url: location.href }).catch(() => {});
    // Save read mode bookmark on unload if a session is active
    if (isReadModeEnabled() && getReadModeSentences().length > 0) {
        chrome.storage.local.set({ [getPositionKey()]: getReadModeSentenceIndex() }).catch(() => {});
    }
    // Read mode timer cleanup is handled by the browser — no need for explicit clearTimeout
});
