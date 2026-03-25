// read-mode.js — Read-only mode state machine.
// Highlights sentences at a reading pace (WPM timer) without audio.

export const DEFAULT_WPM = 220;
export const MIN_WPM     = 100;
export const MAX_WPM     = 500;

// ── Module state ─────────────────────────────────────────────────────────────
// All state is module-level. Use accessor functions to read/write from outside.
let _enabled   = false;  // true = read mode on
let _wpm       = DEFAULT_WPM;
let _timer     = null;
let _sentIdx   = 0;
let _sentences = [];
let _paused    = false;
let _pageUrl   = '';

// ── Callbacks wired up by content-script via initReadMode() ─────────────────
let _onStateChange    = () => {};
let _onStatusUpdate   = () => {};
let _onSeekerUpdate   = () => {};
let _onHighlight      = () => {};
let _onClearHighlight = () => {};

// ── Initialization ────────────────────────────────────────────────────────────

/**
 * Wire up callbacks from the content script so the read-mode module can
 * drive the widget and highlighter without importing them directly.
 * @param {{ stateChange?, statusUpdate?, seekerUpdate?, highlight?, clearHighlight? }} callbacks
 */
export function initReadMode(callbacks) {
    if (callbacks.stateChange)    _onStateChange    = callbacks.stateChange;
    if (callbacks.statusUpdate)   _onStatusUpdate   = callbacks.statusUpdate;
    if (callbacks.seekerUpdate)   _onSeekerUpdate   = callbacks.seekerUpdate;
    if (callbacks.highlight)      _onHighlight      = callbacks.highlight;
    if (callbacks.clearHighlight) _onClearHighlight = callbacks.clearHighlight;
}

// ── State accessors ───────────────────────────────────────────────────────────

export function isEnabled()        { return _enabled; }
export function isPaused()         { return _paused; }
export function getWpm()           { return _wpm; }
export function getSentenceIndex() { return _sentIdx; }
export function getSentences()     { return _sentences; }
export function setSentences(list) { _sentences = list; }
export function getPageUrl()       { return _pageUrl; }
export function setPageUrl(url)    { _pageUrl = url; }

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Calculate display delay (ms) for a sentence at the current WPM.
 * Minimum delay is 500 ms to ensure even very short sentences are readable.
 * @param {{ text: string }} sentence
 * @returns {number}
 */
function delayMsForSentence(sentence) {
    const wordCount = sentence.text.trim().split(/\s+/).filter(Boolean).length || 1;
    return Math.max(500, (wordCount / _wpm) * 60 * 1000);
}

/**
 * Persist the current sentence index to chrome.storage.local
 * so the user can resume from the same position on reload.
 * @param {number} idx
 */
function savePosition(idx) {
    const storageKey = `readModePos_${_pageUrl}`;
    chrome.storage.local.set({ [storageKey]: idx }).catch(() => {});
}

/**
 * Advance to the next sentence and schedule the following one.
 * Stops automatically when all sentences have been highlighted.
 */
function advance() {
    if (!_enabled || _paused) return;
    if (_sentIdx >= _sentences.length) {
        // All sentences shown — clean up and signal done
        clearTimeout(_timer);
        _onClearHighlight();
        _onStateChange('done');
        savePosition(0); // reset bookmark when finished
        return;
    }

    _onHighlight(_sentIdx);
    savePosition(_sentIdx);
    _onSeekerUpdate(_sentIdx, _sentences.length);
    _onStatusUpdate(`Reading\u2026 (${_sentIdx + 1} / ${_sentences.length})`);

    const delay = delayMsForSentence(_sentences[_sentIdx]);
    _sentIdx++;
    _timer = setTimeout(advance, delay);
}

// ── Public operations ─────────────────────────────────────────────────────────

/**
 * Enable read mode and start highlighting from `fromIndex`.
 * @param {Array|null} sentences     - Sentence list; null keeps the existing list.
 * @param {number}     [fromIndex=0] - Sentence index to start from.
 * @param {string}     [pageUrl]     - Current page URL for bookmark storage.
 */
export function startReadMode(sentences, fromIndex, pageUrl) {
    clearTimeout(_timer);
    if (sentences) _sentences = sentences;
    if (pageUrl !== undefined) _pageUrl = pageUrl;
    _enabled = true;
    _paused  = false;
    _sentIdx = fromIndex ?? 0;
    _onStateChange('playing');
    advance();
}

/** Disable read mode, stop the timer, and clear highlights. */
export function stopReadMode() {
    clearTimeout(_timer);
    _paused  = false;
    _enabled = false;
    _onClearHighlight();
}

/** Toggle play / pause within an active read-mode session. */
export function toggleReadModePlayPause() {
    if (_paused) {
        _paused = false;
        _onStateChange('playing');
        advance();
    } else {
        _paused = true;
        clearTimeout(_timer);
        _onStateChange('paused');
        savePosition(_sentIdx);
    }
}

/**
 * Adjust WPM by `delta` and return the new clamped value.
 * @param {number} delta
 * @returns {number}
 */
export function adjustWpm(delta) {
    _wpm = Math.max(MIN_WPM, Math.min(MAX_WPM, _wpm + delta));
    return _wpm;
}

/**
 * Load read-mode preferences from chrome.storage.local.
 * Updates module state and returns { enabled, wpm }.
 * @returns {Promise<{ enabled: boolean, wpm: number }>}
 */
export async function loadReadModePreferences() {
    try {
        const result = await chrome.storage.local.get(['readMode', 'readModeWpm']);
        if (result.readMode === true) _enabled = true;
        if (result.readModeWpm >= MIN_WPM && result.readModeWpm <= MAX_WPM) {
            _wpm = result.readModeWpm;
        }
    } catch (_) {}
    return { enabled: _enabled, wpm: _wpm };
}

/** Return the chrome.storage key for the current page's read-mode position. */
export function getPositionKey() {
    return `readModePos_${_pageUrl}`;
}
