// widget.js — Floating circle widget with radial menu
// Injected into pages via content script shadow DOM.

import { WIDGET_CSS } from './widget-styles.js';

// ── SVG icons ────────────────────────────────────────────────────────────────

const ICON_PLAY = `<svg viewBox="0 0 24 24" class="tts-circle-icon"><path d="M8 5v14l11-7z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" class="tts-circle-icon"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>`;
const ICON_LOADING = `<svg viewBox="0 0 24 24" class="tts-circle-icon"><path d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z" fill="#fff" opacity="0.5"/></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;
const ICON_HOURGLASS = `<svg viewBox="0 0 24 24"><path d="M6 2v6l3.5 3.5L6 15.5V22h12v-6.5L14.5 12 18 8.5V2H6zm10 13.17V20H8v-4.83l4-4 4 4zM8 7.83V4h8v3.83l-4 4-4-4z"/></svg>`;
const ICON_DONE = `<svg viewBox="0 0 24 24" class="tts-circle-icon"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>`;

// ── Voice list ───────────────────────────────────────────────────────────────

const VOICE_GROUPS = {
    'Default': ['af_aoede'],
    'Favorites': ['af_sarah', 'af_heart', 'af_sky', 'af_bella', 'af_jessica', 'af_kore', 'af_nova', 'am_eric', 'bf_lily'],
    'More Voices': [
        'af_alloy', 'af_nicole', 'af_river',
        'am_adam', 'am_echo', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck',
        'bf_alice', 'bf_emma', 'bf_isabella',
        'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
    ],
};

// ── Widget creation ──────────────────────────────────────────────────────────

let widgetEl = null;
let circleBtn = null;
let downloadBtn = null;
let shadowRoot = null;
let hostEl = null;
let currentState = 'loading';
let isFirstPlay = true;

// Download state
let generationDone = false;
let pendingDownload = false;

// Seeker state
let seekerSlider = null;
let seekerTime = null;
let isSeeking = false;

// Voice picker state
let voiceSelectEl = null;
let voiceNotifyTimeout = null;

// Read mode state
let readModeBtn    = null;
let readModeActive = false;
let wpmValueEl     = null;
let speedContainerEl = null;
let wpmContainerEl   = null;
let voiceItemEl      = null;

// Hover-gap timer
let hoverTimer = null;

// ── Action handler — set by content-script to intercept widget actions ───────
// Actions are dispatched locally (play/pause/seek/speed) or forwarded to
// offscreen (voice switch, close, download) by the content script.
let actionHandler = null;

export function setActionHandler(handler) {
    actionHandler = handler;
}

function dispatchAction(action) {
    if (actionHandler) {
        actionHandler(action);
    } else {
        // Fallback: send via chrome.runtime.sendMessage (legacy path)
        chrome.runtime.sendMessage({ type: 'WIDGET_ACTION', ...action }).catch(() => {});
    }
}

export function createWidget(shadow, shadowHost) {
    shadowRoot = shadow;
    hostEl = shadowHost;

    const styleEl = document.createElement('style');
    styleEl.textContent = WIDGET_CSS;
    shadow.appendChild(styleEl);

    widgetEl = document.createElement('div');
    widgetEl.className = 'tts-widget hidden';
    shadow.appendChild(widgetEl);

    circleBtn = document.createElement('button');
    circleBtn.className = 'tts-circle loading';
    circleBtn.innerHTML = ICON_LOADING;
    circleBtn.title = 'Loading...';
    circleBtn.addEventListener('click', onCircleClick);
    widgetEl.appendChild(circleBtn);

    const radial = document.createElement('div');
    radial.className = 'tts-radial';
    widgetEl.appendChild(radial);

    // ── Close + Download (top) ───────────────────────────────────────────────
    const topItem = document.createElement('div');
    topItem.className = 'tts-radial-item pos-top';
    const topControls = document.createElement('div');
    topControls.className = 'tts-top-controls';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tts-close-btn';
    closeBtn.innerHTML = ICON_CLOSE;
    closeBtn.title = 'Stop & close';
    closeBtn.addEventListener('click', onCloseClick);
    topControls.appendChild(closeBtn);

    readModeBtn = document.createElement('button');
    readModeBtn.className = 'tts-read-btn';
    readModeBtn.textContent = 'Read Only';
    readModeBtn.title = 'Toggle read-only mode (highlight sentences at reading pace, no audio)';
    readModeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dispatchAction({ action: 'TOGGLE_READ_MODE' });
    });
    topControls.appendChild(readModeBtn);

    downloadBtn = document.createElement('button');
    downloadBtn.className = 'tts-download-circle-btn';
    downloadBtn.innerHTML = ICON_DOWNLOAD;
    downloadBtn.title = 'Download audio as WAV';
    downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (generationDone) {
            dispatchAction({ action: 'REQUEST_DOWNLOAD' });
        } else {
            pendingDownload = true;
            downloadBtn.classList.add('queued');
            downloadBtn.innerHTML = ICON_HOURGLASS;
            downloadBtn.title = 'Will download once generation is complete';
        }
    });
    topControls.appendChild(downloadBtn);

    topItem.appendChild(topControls);
    radial.appendChild(topItem);

    // ── Speed control (left) ─────────────────────────────────────────────────
    const speedItem = document.createElement('div');
    speedItem.className = 'tts-radial-item pos-left';
    const speedContainer = document.createElement('div');
    speedContainer.className = 'tts-control-container';
    const speedLabel = document.createElement('span');
    speedLabel.className = 'tts-control-label';
    speedLabel.textContent = 'Speed';
    const speedSlider = document.createElement('input');
    speedSlider.type = 'range';
    speedSlider.className = 'tts-speed-slider';
    speedSlider.min = '0.5';
    speedSlider.max = '2.0';
    speedSlider.step = '0.1';
    speedSlider.value = '1.0';
    speedSlider.title = 'Speed';
    speedSlider.addEventListener('input', onSpeedChange);
    speedSlider.addEventListener('click', (e) => e.stopPropagation());
    const speedValue = document.createElement('span');
    speedValue.className = 'tts-speed-value';
    speedValue.textContent = '1.0x';
    speedContainer.appendChild(speedLabel);
    speedContainer.appendChild(speedSlider);
    speedContainer.appendChild(speedValue);
    speedContainerEl = speedContainer;

    // WPM control — shown instead of speed slider when read mode is active
    const wpmContainer = document.createElement('div');
    wpmContainer.className = 'tts-control-container';
    wpmContainer.style.display = 'none';
    wpmContainerEl = wpmContainer;

    const wpmLabel = document.createElement('span');
    wpmLabel.className = 'tts-control-label';
    wpmLabel.textContent = 'WPM';

    const wpmControl = document.createElement('div');
    wpmControl.className = 'tts-wpm-control';

    const wpmMinus = document.createElement('button');
    wpmMinus.className = 'tts-wpm-btn';
    wpmMinus.textContent = '−';
    wpmMinus.title = 'Slower reading pace';
    wpmMinus.addEventListener('click', (e) => {
        e.stopPropagation();
        dispatchAction({ action: 'SET_READ_WPM', delta: -20 });
    });

    wpmValueEl = document.createElement('span');
    wpmValueEl.className = 'tts-wpm-value';
    wpmValueEl.textContent = '220 wpm';

    const wpmPlus = document.createElement('button');
    wpmPlus.className = 'tts-wpm-btn';
    wpmPlus.textContent = '+';
    wpmPlus.title = 'Faster reading pace';
    wpmPlus.addEventListener('click', (e) => {
        e.stopPropagation();
        dispatchAction({ action: 'SET_READ_WPM', delta: +20 });
    });

    wpmControl.appendChild(wpmMinus);
    wpmControl.appendChild(wpmValueEl);
    wpmControl.appendChild(wpmPlus);
    wpmContainer.appendChild(wpmLabel);
    wpmContainer.appendChild(wpmControl);

    speedItem.appendChild(speedContainer);
    speedItem.appendChild(wpmContainer);
    radial.appendChild(speedItem);

    // ── Seeker (bottom) ──────────────────────────────────────────────────────
    const seekItem = document.createElement('div');
    seekItem.className = 'tts-radial-item pos-bottom';
    const seekContainer = document.createElement('div');
    seekContainer.className = 'tts-control-container tts-seeker-container';
    const seekLabel = document.createElement('span');
    seekLabel.className = 'tts-control-label';
    seekLabel.textContent = '◀▶';
    seekerSlider = document.createElement('input');
    seekerSlider.type = 'range';
    seekerSlider.className = 'tts-speed-slider tts-seeker-slider';
    seekerSlider.min = '0';
    seekerSlider.max = '0';
    seekerSlider.step = '0.5';
    seekerSlider.value = '0';
    seekerSlider.title = 'Seek';
    seekerTime = document.createElement('span');
    seekerTime.className = 'tts-speed-value tts-seeker-time';
    seekerTime.textContent = '0:00';
    seekerSlider.addEventListener('mousedown', () => { isSeeking = true; });
    seekerSlider.addEventListener('touchstart', () => { isSeeking = true; });
    seekerSlider.addEventListener('change', onSeekChange);
    seekerSlider.addEventListener('input', onSeekInput);
    seekerSlider.addEventListener('click', (e) => e.stopPropagation());
    seekContainer.appendChild(seekLabel);
    seekContainer.appendChild(seekerSlider);
    seekContainer.appendChild(seekerTime);
    seekItem.appendChild(seekContainer);
    radial.appendChild(seekItem);

    // ── Voice picker (right) ─────────────────────────────────────────────────
    voiceItemEl = document.createElement('div');
    const voiceItem = voiceItemEl;
    voiceItem.className = 'tts-radial-item pos-right';
    const voiceContainer = document.createElement('div');
    voiceContainer.className = 'tts-control-container';
    const voiceLabel = document.createElement('span');
    voiceLabel.className = 'tts-control-label';
    voiceLabel.textContent = 'Voice';
    const voiceSelect = document.createElement('select');
    voiceSelect.className = 'tts-voice-select';
    voiceSelect.title = 'Voice';
    buildVoiceOptions(voiceSelect);
    voiceSelect.addEventListener('change', onVoiceChange);
    voiceSelect.addEventListener('click', (e) => e.stopPropagation());
    voiceSelectEl = voiceSelect;
    voiceContainer.appendChild(voiceLabel);
    voiceContainer.appendChild(voiceSelect);
    voiceItem.appendChild(voiceContainer);
    radial.appendChild(voiceItem);

    loadWidgetPreferences(voiceSelect, speedSlider, speedValue);

    // ── Hover gap fix ────────────────────────────────────────────────────────
    widgetEl.addEventListener('mouseover', () => {
        clearTimeout(hoverTimer);
        widgetEl.classList.add('menu-open');
    });
    widgetEl.addEventListener('mouseout', (e) => {
        if (widgetEl.contains(e.relatedTarget)) return;
        hoverTimer = setTimeout(() => widgetEl.classList.remove('menu-open'), 300);
    });

    // ── Drag support ─────────────────────────────────────────────────────────
    initDrag(circleBtn);

    return widgetEl;
}

function buildVoiceOptions(select) {
    for (const [group, voices] of Object.entries(VOICE_GROUPS)) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = group;
        for (const voice of voices) {
            const option = document.createElement('option');
            option.value = voice;
            const name = voice.split('_')[1];
            option.textContent = name.charAt(0).toUpperCase() + name.slice(1);
            optgroup.appendChild(option);
        }
        select.appendChild(optgroup);
    }
}

async function loadWidgetPreferences(voiceSelect, speedSlider, speedValue) {
    try {
        const result = await chrome.storage.local.get(['voice', 'speed', 'widgetPosX', 'widgetPosY']);
        const savedVoice = result.voice && voiceSelect.querySelector(`option[value="${result.voice}"]`)
            ? result.voice
            : 'af_aoede';
        voiceSelect.value = savedVoice;
        // Save the resolved voice back to storage if nothing was stored, or if the stored
        // value pointed to a voice that no longer exists in the dropdown (e.g. after update).
        if (!result.voice || result.voice !== savedVoice) {
            chrome.storage.local.set({ voice: savedVoice }).catch(() => {});
        }
        if (result.speed != null) {
            const speed = parseFloat(result.speed);
            if (speed >= 0.5 && speed <= 2.0) {
                speedSlider.value = speed;
                speedValue.textContent = formatSpeed(speed);
            }
        }
        // Restore saved drag position, clamped to the current viewport dimensions
        if (result.widgetPosX != null && result.widgetPosY != null) {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const clampedX = Math.max(0, Math.min(result.widgetPosX, vw - 56));
            const clampedY = Math.max(0, Math.min(result.widgetPosY, vh - 56));
            hostEl.style.left   = clampedX + 'px';
            hostEl.style.top    = clampedY + 'px';
            hostEl.style.right  = 'auto';
            hostEl.style.bottom = 'auto';
            hostEl.style.transform = 'none';
        }
    } catch (_) {}
}

function formatSpeed(val) {
    return (val % 0.5 === 0 ? val.toFixed(1) : val.toFixed(2)) + 'x';
}

function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ── Event handlers ───────────────────────────────────────────────────────────

function onCircleClick() {
    if (dragMoved) { dragMoved = false; return; }
    if (currentState === 'loading') return;

    // First play from staged mode — dispatch immediately (AudioContext needs
    // to be created/resumed within the user gesture call chain)
    dispatchAction({ action: 'TOGGLE_PLAY_PAUSE' });
}

function onCloseClick(e) {
    e.stopPropagation();
    dispatchAction({ action: 'CLOSE_WIDGET' });
    hideWidget();
}

function onVoiceChange(e) {
    const voice = e.target.value;
    console.log('[widget] onVoiceChange fired — voice:', voice);
    const rawName = voice.split('_')[1] ?? voice;
    const displayName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    dispatchAction({ action: 'SWITCH_VOICE', voice });
    chrome.storage.local.set({ voice }).catch(() => {});
    showVoiceNotification(displayName);
}

function showVoiceNotification(voiceName) {
    if (!voiceSelectEl) return;
    clearTimeout(voiceNotifyTimeout);
    const prev = voiceSelectEl.parentNode.querySelector('.tts-voice-notify');
    if (prev) prev.remove();

    voiceSelectEl.style.display = 'none';
    const notify = document.createElement('span');
    notify.className = 'tts-voice-notify';
    notify.textContent = `\u2713 ${voiceName} \u2013 next`;
    voiceSelectEl.parentNode.insertBefore(notify, voiceSelectEl.nextSibling);

    voiceNotifyTimeout = setTimeout(() => {
        notify.remove();
        voiceSelectEl.style.display = '';
    }, 2000);
}

function onSpeedChange(e) {
    const speed = parseFloat(e.target.value);
    const speedValue = shadowRoot.querySelector('.tts-speed-value');
    if (speedValue) speedValue.textContent = formatSpeed(speed);
    dispatchAction({ action: 'SET_SPEED', speed });
    chrome.storage.local.set({ speed }).catch(() => {});
}

function onSeekInput(e) {
    if (seekerTime) seekerTime.textContent = formatTime(parseFloat(e.target.value));
    updateSeekerFill(parseFloat(e.target.value), parseFloat(e.target.max) || 0);
}

function onSeekChange(e) {
    const timeSeconds = parseFloat(e.target.value);
    dispatchAction({ action: 'SEEK_TO', timeSeconds });
    isSeeking = false;
}

function updateSeekerFill(current, total) {
    if (!seekerSlider) return;
    const pct = total > 0 ? Math.min((current / total) * 100, 100) : 0;
    seekerSlider.style.background = `linear-gradient(to right, #FA8072 ${pct}%, #4a4a6a ${pct}%)`;
}

// ── Drag support ─────────────────────────────────────────────────────────────

let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let hostStartX = 0;
let hostStartY = 0;
const DRAG_THRESHOLD = 5;
let dragMoved = false;

function initDrag(handle) {
    handle.addEventListener('mousedown', onDragStart);
    handle.addEventListener('touchstart', onDragStart, { passive: false });
}

function onDragStart(e) {
    if (e.target !== circleBtn && !circleBtn.contains(e.target)) return;

    const pos = e.touches ? e.touches[0] : e;
    dragStartX = pos.clientX;
    dragStartY = pos.clientY;
    dragMoved = false;

    const rect = hostEl.getBoundingClientRect();
    hostStartX = rect.left;
    hostStartY = rect.top;

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('touchend', onDragEnd);
}

function onDragMove(e) {
    const pos = e.touches ? e.touches[0] : e;
    const dx = pos.clientX - dragStartX;
    const dy = pos.clientY - dragStartY;

    if (!isDragging && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;

    if (!isDragging) {
        isDragging = true;
        widgetEl.classList.add('dragging');
    }

    dragMoved = true;
    e.preventDefault();

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let newX = hostStartX + dx;
    let newY = hostStartY + dy;
    newX = Math.max(0, Math.min(newX, vw - 56));
    newY = Math.max(0, Math.min(newY, vh - 56));

    hostEl.style.left = newX + 'px';
    hostEl.style.top = newY + 'px';
    hostEl.style.transform = 'none';
    hostEl.style.bottom = 'auto';
    hostEl.style.right = 'auto';
}

function onDragEnd() {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    document.removeEventListener('touchmove', onDragMove);
    document.removeEventListener('touchend', onDragEnd);

    if (isDragging) {
        isDragging = false;
        widgetEl.classList.remove('dragging');
        // Persist the final resting position so it survives page navigation
        const rect = hostEl.getBoundingClientRect();
        chrome.storage.local.set({ widgetPosX: rect.left, widgetPosY: rect.top }).catch(() => {});
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function showWidget() {
    if (widgetEl) widgetEl.classList.remove('hidden');
}

export function hideWidget() {
    if (!widgetEl) return;
    onDragEnd();
    widgetEl.classList.add('hidden');
}

export function updateState(state) {
    currentState = state;
    if (!circleBtn) return;

    circleBtn.classList.remove('loading', 'playing', 'paused');

    switch (state) {
        case 'loading':
            circleBtn.classList.add('loading');
            circleBtn.innerHTML = ICON_LOADING;
            circleBtn.title = 'Loading...';
            generationDone = false;
            pendingDownload = false;
            if (downloadBtn) {
                downloadBtn.classList.remove('queued');
                downloadBtn.innerHTML = ICON_DOWNLOAD;
                downloadBtn.title = 'Download audio as WAV';
            }
            break;
        case 'playing':
            isFirstPlay = false;
            circleBtn.classList.add('playing');
            circleBtn.innerHTML = ICON_PAUSE;
            circleBtn.title = 'Click to pause';
            break;
        case 'paused':
            circleBtn.classList.add('paused');
            circleBtn.innerHTML = ICON_PLAY;
            circleBtn.title = 'Click to resume';
            break;
        case 'done':
            circleBtn.innerHTML = ICON_DONE;
            circleBtn.title = 'Playback complete';
            setTimeout(() => {
                if (currentState === 'done') hideWidget();
            }, 3000);
            break;
        case 'stopped':
            hideWidget();
            break;
    }
}

export function updateStatus(text) {
    if (circleBtn) circleBtn.title = text;
}

export function updateSeeker(current, total) {
    if (!seekerSlider || isSeeking) return;
    seekerSlider.max = total.toFixed(1);
    seekerSlider.value = current.toFixed(1);
    if (seekerTime) seekerTime.textContent = formatTime(current);
    updateSeekerFill(current, total);
}

export function updateReadMode(active, wpm) {
    readModeActive = active;

    if (readModeBtn) {
        readModeBtn.classList.toggle('active', active);
        readModeBtn.title = active
            ? 'Read-only mode active — click to disable'
            : 'Toggle read-only mode (highlight sentences at reading pace, no audio)';
    }

    // Swap left radial: speed ↔ WPM control
    if (speedContainerEl) speedContainerEl.style.display = active ? 'none' : '';
    if (wpmContainerEl)   wpmContainerEl.style.display   = active ? ''     : 'none';

    // Hide voice picker in read mode
    if (voiceItemEl) voiceItemEl.style.visibility = active ? 'hidden' : '';

    if (wpmValueEl && wpm != null) {
        wpmValueEl.textContent = `${wpm} wpm`;
    }
}

export function markGenerationDone() {
    generationDone = true;
    if (downloadBtn) {
        downloadBtn.classList.remove('queued');
        downloadBtn.innerHTML = ICON_DOWNLOAD;
        downloadBtn.title = 'Download audio as WAV';
    }
    if (pendingDownload) {
        pendingDownload = false;
        dispatchAction({ action: 'REQUEST_DOWNLOAD' });
    }
}
