// popup.js — Phase 8: Full playback UI with voice/speed controls, export, dark mode

import { stretchAudio } from '../utils/audio-stretcher.js';

const ERROR_MESSAGES = {
    NO_TEXT_FOUND: "Couldn't find article text on this page.",
    MODEL_LOAD_FAILED: "Failed to load TTS model. Please reload the extension.",
    AUDIO_GENERATION_FAILED: "Failed to generate audio. Please try again.",
    PHONEMIZATION_FAILED: "Text conversion failed.",
    UNKNOWN: "Something went wrong. Please try again.",
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const statusEl      = document.getElementById('status');
const extractBtn    = document.getElementById('extractBtn');
const playerEl      = document.getElementById('player');
const playPauseBtn  = document.getElementById('playPauseBtn');
const stopBtn       = document.getElementById('stopBtn');
const downloadBtn   = document.getElementById('downloadBtn');
const progressBar   = document.getElementById('progressBar');
const errorEl       = document.getElementById('error');
const voiceSelect   = document.getElementById('voiceSelect');
const speedSlider   = document.getElementById('speedSlider');
const speedValueEl  = document.getElementById('speedValue');
const themeToggle   = document.getElementById('themeToggle');

// ── Worker state ──────────────────────────────────────────────────────────────
let ttsWorker  = null;
let modelReady = false;

// ── Audio state ───────────────────────────────────────────────────────────────
let audioContext           = null;
let nextPlayTime           = 0;     // WAA clock: when next chunk should start
let firstChunkStartTime    = 0;     // WAA clock: when the first chunk started
let totalScheduledDuration = 0;     // seconds: sum of all chunks + pauses
let scheduledSources       = [];    // AudioBufferSourceNode[] — for stop/cancel
let progressInterval       = null;
let isPlaying              = false;
let generationDone         = false; // true once GENERATION_DONE received

// Pre-buffer: hold this many SENTENCE chunks before starting the AudioContext clock.
const PREBUFFER_COUNT = 3;
let pendingChunks = [];

// Generation ID: incremented on each new Extract & Play press.
let currentGenId = 0;

// Adaptive slowdown
const SLOW_THRESHOLD = 2;
const SLOW_RATE      = 0.9;

// User-selected playback speed (passed to model at inference time)
let currentUserSpeed = 1.0;
let chunksAhead = 0;

// Pause durations between sentences (seconds)
const PAUSE_SECTION   = 1.20;
const PAUSE_PARAGRAPH = 0.60;
const PAUSE_SENTENCE  = 0.25;

// WAV export: collect all raw samples for download
let allSamples   = [];   // Float32Array[] — one per chunk, in playback order
let articleTitle  = '';   // for download filename

// ── UI helpers ────────────────────────────────────────────────────────────────
function setStatus(msg) { statusEl.textContent = msg; }

function showError(key) {
    errorEl.textContent = ERROR_MESSAGES[key] || ERROR_MESSAGES.UNKNOWN;
    errorEl.style.display = 'block';
}
function clearError() {
    errorEl.style.display = 'none';
    errorEl.textContent = '';
}

function setProgress(pct) {
    progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

function setExtracting(loading) {
    extractBtn.disabled = loading || !modelReady;
    extractBtn.textContent = loading ? 'Extracting…' : 'Extract & Play';
}

function setPlayIcon(playing) {
    playPauseBtn.innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
}

function formatSpeed(val) {
    return (val % 0.5 === 0 ? val.toFixed(1) : val.toFixed(2)) + 'x';
}

// ── Preferences (chrome.storage) ─────────────────────────────────────────────

async function loadPreferences() {
    try {
        const result = await chrome.storage.local.get(['voice', 'speed', 'theme']);
        if (result.voice && voiceSelect.querySelector(`option[value="${result.voice}"]`)) {
            voiceSelect.value = result.voice;
        }
        if (result.speed != null) {
            const speed = parseFloat(result.speed);
            if (speed >= 0.5 && speed <= 2.0) {
                speedSlider.value = speed;
                currentUserSpeed = speed;
                speedValueEl.textContent = formatSpeed(speed);
            }
        }
        if (result.theme === 'dark') {
            document.body.classList.add('dark');
            themeToggle.innerHTML = '&#9788;'; // sun
        }
        return result.voice || 'af_heart';
    } catch (_) {
        return 'af_heart';
    }
}

function savePreference(key, value) {
    chrome.storage.local.set({ [key]: value }).catch(() => {});
}

// ── Dark mode ────────────────────────────────────────────────────────────────

themeToggle.addEventListener('click', () => {
    const isDark = document.body.classList.toggle('dark');
    themeToggle.innerHTML = isDark ? '&#9788;' : '&#9789;'; // sun / moon
    savePreference('theme', isDark ? 'dark' : 'light');
});

// ── Audio playback ────────────────────────────────────────────────────────────

function resetAudio() {
    stopProgressTracking();
    if (audioContext) {
        try { audioContext.close(); } catch (_) {}
    }
    audioContext           = new AudioContext({ sampleRate: 24000 });
    nextPlayTime           = 0;
    firstChunkStartTime    = 0;
    totalScheduledDuration = 0;
    scheduledSources       = [];
    pendingChunks          = [];
    chunksAhead            = 0;
    isPlaying              = false;
    generationDone         = false;
    allSamples             = [];
    downloadBtn.disabled   = true;
    playerEl.style.display = 'none';
    setProgress(0);
}

function scheduleChunk(chunk, slowMode = false) {
    const { samples, sampleRate, endsWithParagraph, endsWithSection, isMidChunk, countAsChunk } = chunk;

    // User speed is handled by the model's native speed parameter at inference time.
    // WSOLA is only used for adaptive slowdown when the playback buffer runs thin.
    const effectiveSpeed   = slowMode ? SLOW_RATE : 1.0;
    const stretchedSamples = stretchAudio(samples, effectiveSpeed);

    // Collect raw samples for WAV export (use original samples, not stretched)
    allSamples.push(new Float32Array(samples));

    // If generation fell behind real-time, nextPlayTime may be in the past.
    // Without this snap-forward, multiple late-arriving chunks would all
    // start simultaneously (source.start(pastTime) = start NOW), causing
    // audible overlap of the tail of one sentence with the head of the next.
    if (nextPlayTime < audioContext.currentTime) {
        nextPlayTime = audioContext.currentTime + 0.02;
    }

    const buffer = audioContext.createBuffer(1, stretchedSamples.length, sampleRate);
    buffer.copyToChannel(stretchedSamples, 0);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.playbackRate.value = 1.0;

    if (countAsChunk) chunksAhead++;

    source.onended = () => {
        if (countAsChunk) chunksAhead--;
        scheduledSources = scheduledSources.filter((s) => s !== source);
    };

    source.start(nextPlayTime);
    scheduledSources.push(source);

    const pause = isMidChunk        ? 0
                : endsWithSection   ? PAUSE_SECTION
                : endsWithParagraph ? PAUSE_PARAGRAPH
                : PAUSE_SENTENCE;

    nextPlayTime           += buffer.duration + pause;
    totalScheduledDuration  = nextPlayTime - firstChunkStartTime;
}

function startPlayback() {
    nextPlayTime        = audioContext.currentTime + 0.08;
    firstChunkStartTime = nextPlayTime;
    playerEl.style.display = 'flex';
    isPlaying = true;
    setPlayIcon(true);
    setStatus('Generating & playing…');
    startProgressTracking();

    for (const chunk of pendingChunks) {
        scheduleChunk(chunk, false);
    }
    pendingChunks = [];
}

function flushPendingChunks() {
    if (pendingChunks.length === 0) return;
    if (nextPlayTime === 0) startPlayback();
}

function queueAudioChunk(samples, sampleRate, endsWithParagraph, endsWithSection, isMidChunk, countAsChunk) {
    if (!audioContext) return;

    const chunk = { samples, sampleRate, endsWithParagraph, endsWithSection, isMidChunk, countAsChunk };

    if (nextPlayTime === 0) {
        pendingChunks.push(chunk);
        const sentenceCount = pendingChunks.filter((c) => c.countAsChunk).length;
        setStatus(`Buffering… (${sentenceCount}/${PREBUFFER_COUNT})`);

        if (sentenceCount >= PREBUFFER_COUNT) {
            startPlayback();
        }
        return;
    }

    const strictlyAhead = chunksAhead - 1;
    const slowMode = !generationDone && (strictlyAhead <= SLOW_THRESHOLD);

    if (slowMode) {
        console.log(`[popup] slow mode — chunks ahead: ${strictlyAhead} (threshold ${SLOW_THRESHOLD}), WSOLA at ${SLOW_RATE}×`);
    }

    scheduleChunk(chunk, slowMode);
}

function startProgressTracking() {
    stopProgressTracking();
    progressInterval = setInterval(() => {
        if (!audioContext || !isPlaying) return;
        if (totalScheduledDuration <= 0) return;

        const elapsed = audioContext.currentTime - firstChunkStartTime;
        const pct     = (elapsed / totalScheduledDuration) * 100;
        setProgress(Math.min(pct, 100));

        if (generationDone && elapsed >= totalScheduledDuration) {
            onPlaybackComplete();
        }
    }, 100);
}

function stopProgressTracking() {
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
}

function onPlaybackComplete() {
    stopProgressTracking();
    isPlaying = false;
    setPlayIcon(false);
    setProgress(100);
    setStatus('Done — click to play again');
    extractBtn.disabled = false;
}

function stopPlayback() {
    stopProgressTracking();
    for (const src of scheduledSources) {
        try { src.stop(); } catch (_) {}
    }
    scheduledSources = [];
    if (audioContext) { try { audioContext.close(); } catch (_) {} audioContext = null; }
    nextPlayTime           = 0;
    firstChunkStartTime    = 0;
    totalScheduledDuration = 0;
    isPlaying              = false;
    generationDone         = false;
    playerEl.style.display = 'none';
    setPlayIcon(false);
    setProgress(0);
}

// ── WAV export ───────────────────────────────────────────────────────────────

function encodeWAV(samples, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = samples.length * (bitsPerSample / 8);
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');

    // fmt chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);           // chunk size
    view.setUint16(20, 1, true);            // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // data chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Convert float32 → int16
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
    }

    return buffer;
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

function downloadAudio() {
    if (allSamples.length === 0) return;

    // Concatenate all chunks
    const totalLen = allSamples.reduce((sum, s) => sum + s.length, 0);
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of allSamples) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }

    const wavBuffer = encodeWAV(merged, 24000);
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    const safeName = articleTitle.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 60) || 'audio';
    a.href = url;
    a.download = `${safeName}.wav`;
    a.click();
    URL.revokeObjectURL(url);
}

downloadBtn.addEventListener('click', downloadAudio);

// ── Button handlers ───────────────────────────────────────────────────────────

playPauseBtn.addEventListener('click', () => {
    if (!audioContext) return;
    if (audioContext.state === 'running') {
        audioContext.suspend();
        isPlaying = false;
        setPlayIcon(false);
        setStatus('Paused.');
    } else if (audioContext.state === 'suspended') {
        audioContext.resume();
        isPlaying = true;
        setPlayIcon(true);
        setStatus('Playing…');
    }
});

stopBtn.addEventListener('click', () => {
    if (ttsWorker) ttsWorker.postMessage({ type: 'CANCEL' });
    stopPlayback();
    setStatus('Stopped.');
});

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
    // Don't intercept when typing in an input/select
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (e.code === 'Space') {
        e.preventDefault();
        playPauseBtn.click();
    } else if (e.code === 'Escape') {
        e.preventDefault();
        stopBtn.click();
    }
});

// ── Voice / Speed controls ──────────────────────────────────────────────────

voiceSelect.addEventListener('change', () => {
    const voice = voiceSelect.value;
    if (!ttsWorker || !modelReady) return;

    // Send SWITCH_VOICE without cancelling generation or stopping playback.
    // The worker processes it between await points in generateAudio — voiceData
    // is swapped atomically, so subsequent sentences use the new voice while
    // already-queued chunks continue playing with the old voice. Seamless transition.
    voiceSelect.disabled = true;
    if (!isPlaying) {
        setStatus(`Switching to ${voiceSelect.selectedOptions[0].textContent}…`);
    }
    ttsWorker.postMessage({ type: 'SWITCH_VOICE', voice });
    savePreference('voice', voice);
});

speedSlider.addEventListener('input', () => {
    const val = parseFloat(speedSlider.value);
    currentUserSpeed = val;
    speedValueEl.textContent = formatSpeed(val);
    savePreference('speed', val);
});

// ── TTS Worker ────────────────────────────────────────────────────────────────

const STAGE_LABELS = {
    wasm:  'Initialising WASM…',
    model: 'Loading model…',
    voice: 'Loading voice…',
    done:  'Ready',
};

function initWorker(voice) {
    const workerUrl = chrome.runtime.getURL('tts-worker.js');
    ttsWorker = new Worker(workerUrl);

    ttsWorker.onmessage = (event) => {
        const { type, ...payload } = event.data;

        switch (type) {
            case 'LOADING_PROGRESS':
                setStatus(STAGE_LABELS[payload.stage] ?? 'Loading…');
                setProgress(payload.pct);
                break;

            case 'MODEL_READY':
                modelReady = true;
                extractBtn.disabled = false;
                setStatus('Ready — click to extract & play');
                setProgress(0);
                break;

            case 'PHONEMES_READY':
                if (!isPlaying) {
                    setStatus(`Generating audio ${payload.index + 1}/${payload.total}…`);
                }
                console.log(`[popup] phonemes [${payload.index + 1}/${payload.total}]: "${payload.phonemes}"`);
                break;

            case 'AUDIO_CHUNK': {
                const { genId, index, total, samples, sampleRate,
                        endsWithParagraph, endsWithSection, isMidChunk, countAsChunk } = payload;
                if (genId !== currentGenId) {
                    console.log(`[popup] dropping stale chunk (genId ${genId} ≠ ${currentGenId})`);
                    break;
                }
                console.log(`[popup] audio chunk ${index + 1}/${total}: ${samples.length} samples (${(samples.length / sampleRate).toFixed(2)}s) countAsChunk=${countAsChunk}`);
                queueAudioChunk(samples, sampleRate, endsWithParagraph, endsWithSection, isMidChunk, countAsChunk);
                break;
            }

            case 'GENERATION_DONE':
                if (payload.genId !== currentGenId) break;
                flushPendingChunks();
                generationDone = true;
                downloadBtn.disabled = false;
                console.log(`[popup] all ${payload.total} sentences generated`);
                break;

            case 'VOICE_READY':
                console.log('[popup] voice switched to', payload.voice);
                voiceSelect.disabled = false;
                // Don't overwrite playback status if audio is still playing
                if (!isPlaying) {
                    setStatus('Ready — click to extract & play');
                }
                break;

            case 'ERROR':
                console.error('[popup] worker error:', payload.code, payload.detail);
                showError(payload.code === 'MODEL_NOT_READY' ? 'MODEL_LOAD_FAILED' : 'UNKNOWN');
                setStatus(`Error: ${payload.detail ?? payload.code}`);
                extractBtn.disabled = !modelReady;
                voiceSelect.disabled = false;
                break;

            default:
                console.log('[popup] worker message:', type, payload);
        }
    };

    ttsWorker.onerror = (err) => {
        console.error('[popup] worker crash:', err.message, '|', err.filename, 'line', err.lineno);
        showError('MODEL_LOAD_FAILED');
        setStatus(`Worker error: ${err.message || 'unknown'}`);
    };

    extractBtn.disabled = true;
    setStatus('Loading model…');
    ttsWorker.postMessage({
        type:         'LOAD_MODEL',
        voice,
        wasmPaths:    chrome.runtime.getURL('wasm/'),
        modelUrl:     chrome.runtime.getURL('models/kokoro-v1.0.onnx'),
        voiceBaseUrl: chrome.runtime.getURL('models/voices/'),
    });
}

// ── Content script messaging ──────────────────────────────────────────────────

function sendToContentScript(tabId, message) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(response);
            }
        });
    });
}

// ── Extract & Play button ─────────────────────────────────────────────────────

extractBtn.addEventListener('click', async () => {
    clearError();
    setExtracting(true);

    resetAudio();
    setStatus('Extracting text…');

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('NO_TAB');

        const response = await sendToContentScript(tab.id, { type: 'EXTRACT_TEXT' });

        if (!response || !response.success) {
            showError(response?.error === 'NO_TEXT_FOUND' ? 'NO_TEXT_FOUND' : 'UNKNOWN');
            setStatus('No text found.');
            return;
        }

        articleTitle = response.title || '';
        const title = articleTitle ? `"${articleTitle.slice(0, 35)}"` : 'page';
        setStatus(`${response.wordCount} words from ${title} — generating…`);
        console.log(`[popup] ${response.wordCount} words, ${response.sentences.length} sentences`);

        currentGenId++;
        ttsWorker.postMessage({ type: 'CANCEL' });
        ttsWorker.postMessage({
            type:      'GENERATE_AUDIO',
            sentences: response.sentences,
            speed:     currentUserSpeed,
            genId:     currentGenId,
        });

    } catch (err) {
        console.error('[popup] error:', err);
        if (err.message === 'NO_TAB') {
            setStatus('Could not find active tab.');
        } else if (err.message.includes('Receiving end does not exist')) {
            showError('UNKNOWN');
            setStatus('Reload the page and try again.');
        } else {
            showError('UNKNOWN');
            setStatus('Error extracting text.');
        }
    } finally {
        setExtracting(false);
    }
});

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
    const voice = await loadPreferences();
    initWorker(voice);
})();
