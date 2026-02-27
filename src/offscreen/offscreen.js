// offscreen.js — Audio playback + TTS worker host (replaces popup.js)
// Lives in a Chrome offscreen document; persists independently of any popup.

import { stretchAudio } from '../utils/audio-stretcher.js';

// ── Send state updates to service worker (which relays to content script widget) ──
function notifySW(message) {
    chrome.runtime.sendMessage(message).catch(() => {});
}

// ── Worker state ────────────────────────────────────────────────────────────
let ttsWorker  = null;
let modelReady = false;

// ── Audio state ─────────────────────────────────────────────────────────────
let audioContext           = null;
let nextPlayTime           = 0;
let firstChunkStartTime    = 0;
let totalScheduledDuration = 0;
let scheduledSources       = [];
let progressInterval       = null;
let isPlaying              = false;
let generationDone         = false;

const PREBUFFER_COUNT = 3;
let pendingChunks = [];

let currentGenId = 0;

// Adaptive slowdown
const SLOW_THRESHOLD = 2;
const SLOW_RATE      = 0.9;

let currentUserSpeed = 1.0;
let chunksAhead = 0;

// Pause durations (seconds)
const PAUSE_SECTION   = 1.20;
const PAUSE_PARAGRAPH = 0.60;
const PAUSE_SENTENCE  = 0.25;

// WAV export
let allSamples  = [];
let articleTitle = '';

// ── Audio history for seeking ────────────────────────────────────────────────
// Each entry: { relStart, duration, data, sampleRate, countAsChunk, sentenceIndex, pauseAfter }
// relStart = seconds from firstChunkStartTime when this chunk begins playing.
let audioHistory         = [];
let historyTotalDuration = 0;

// Pending extraction — queued if model isn't ready when EXTRACTION_RESULT arrives
let pendingExtraction = null;

// When false: pre-buffer chunks without auto-playing; wait for user TOGGLE_PLAY_PAUSE
let autoPlayMode = true;

// ── Progress throttle ───────────────────────────────────────────────────────
let lastProgressNotify = 0;
const PROGRESS_THROTTLE_MS = 500;

// ── Audio playback ──────────────────────────────────────────────────────────

function resetAudio() {
    console.log('[offscreen] resetAudio()');
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
    audioHistory           = [];
    historyTotalDuration   = 0;
    console.log('[offscreen] AudioContext created, state:', audioContext.state);
    // Offscreen documents may start suspended — force resume
    if (audioContext.state === 'suspended') {
        console.log('[offscreen] AudioContext suspended, resuming...');
        audioContext.resume().then(() => {
            console.log('[offscreen] AudioContext resumed, state:', audioContext.state);
        }).catch((err) => {
            console.error('[offscreen] AudioContext resume failed:', err);
        });
    }
    notifySW({ type: 'PROGRESS_UPDATE', pct: 0 });
}

function scheduleChunk(chunk, slowMode = false) {
    const { samples, sampleRate, endsWithParagraph, endsWithSection, isMidChunk, countAsChunk, sentenceIndex, pauseAfterMs } = chunk;

    const effectiveSpeed   = slowMode ? SLOW_RATE : 1.0;
    const stretchedSamples = stretchAudio(samples, effectiveSpeed);

    allSamples.push(new Float32Array(samples));

    if (nextPlayTime < audioContext.currentTime) {
        nextPlayTime = audioContext.currentTime + 0.02;
    }

    // Fire SENTENCE_PLAYING exactly when this chunk's audio begins (not for overflow tails)
    if (!isMidChunk && sentenceIndex !== undefined) {
        const delayMs = Math.max(0, (nextPlayTime - audioContext.currentTime) * 1000);
        setTimeout(() => {
            notifySW({ type: 'SENTENCE_PLAYING', index: sentenceIndex });
        }, delayMs);
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

    console.log(`[offscreen] scheduleChunk: ${stretchedSamples.length} samples at nextPlayTime=${nextPlayTime.toFixed(3)}, ctx.currentTime=${audioContext.currentTime.toFixed(3)}, ctx.state=${audioContext.state}`);
    source.start(nextPlayTime);
    scheduledSources.push(source);

    // pauseAfterMs (from tts-worker) takes priority when set:
    //   0         → seamless join (overflow tail of a long-clause split)
    //   > 0       → explicit clause-boundary silence (comma ~80ms, colon/semi ~150ms, dash ~120ms)
    //   undefined → use sentence-level pause logic below
    const pause = pauseAfterMs !== undefined
                ? pauseAfterMs / 1000
                : isMidChunk        ? 0
                : endsWithSection   ? PAUSE_SECTION
                : endsWithParagraph ? PAUSE_PARAGRAPH
                : PAUSE_SENTENCE;

    // Record chunk in audio history for seeking support
    const relStart = firstChunkStartTime > 0 ? (nextPlayTime - firstChunkStartTime) : 0;
    audioHistory.push({
        relStart,
        duration: stretchedSamples.length / sampleRate,
        data: new Float32Array(stretchedSamples), // copy for replay
        sampleRate,
        countAsChunk,
        sentenceIndex,
        pauseAfter: pause,
    });

    nextPlayTime           += buffer.duration + pause;
    totalScheduledDuration  = nextPlayTime - firstChunkStartTime;
    historyTotalDuration    = totalScheduledDuration;
}

function startPlayback() {
    console.log('[offscreen] startPlayback() — AudioContext state:', audioContext.state, 'currentTime:', audioContext.currentTime);
    // Ensure AudioContext is running before scheduling
    if (audioContext.state === 'suspended') {
        console.log('[offscreen] AudioContext still suspended at startPlayback, resuming...');
        audioContext.resume();
    }
    nextPlayTime        = audioContext.currentTime + 0.08;
    firstChunkStartTime = nextPlayTime;
    isPlaying = true;
    notifySW({ type: 'PLAYBACK_STATE', state: 'playing' });
    notifySW({ type: 'STATUS_UPDATE', text: 'Generating & playing\u2026' });
    startProgressTracking();

    console.log('[offscreen] scheduling', pendingChunks.length, 'buffered chunks');
    for (const chunk of pendingChunks) {
        scheduleChunk(chunk, false);
    }
    pendingChunks = [];
}

function flushPendingChunks() {
    if (pendingChunks.length === 0) return;
    if (nextPlayTime === 0) {
        if (autoPlayMode) {
            startPlayback();
        } else {
            notifySW({ type: 'CHUNKS_READY' });
        }
    }
}

function queueAudioChunk(samples, sampleRate, endsWithParagraph, endsWithSection, isMidChunk, countAsChunk, sentenceIndex, pauseAfterMs) {
    if (!audioContext) return;

    const chunk = { samples, sampleRate, endsWithParagraph, endsWithSection, isMidChunk, countAsChunk, sentenceIndex, pauseAfterMs };

    if (nextPlayTime === 0) {
        pendingChunks.push(chunk);
        const sentenceCount = pendingChunks.filter((c) => c.countAsChunk).length;
        notifySW({ type: 'STATUS_UPDATE', text: `Buffering\u2026 (${sentenceCount}/${PREBUFFER_COUNT})` });
        notifySW({ type: 'PLAYBACK_STATE', state: 'loading' });

        if (sentenceCount >= PREBUFFER_COUNT) {
            if (autoPlayMode) {
                startPlayback();
            } else {
                notifySW({ type: 'CHUNKS_READY' });
            }
        }
        return;
    }

    const strictlyAhead = chunksAhead - 1;
    const slowMode = !generationDone && (strictlyAhead <= SLOW_THRESHOLD);

    if (slowMode) {
        console.log(`[offscreen] slow mode — chunks ahead: ${strictlyAhead} (threshold ${SLOW_THRESHOLD}), WSOLA at ${SLOW_RATE}\u00d7`);
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

        // Throttle progress updates to reduce SW wake-ups
        const now = Date.now();
        if (now - lastProgressNotify >= PROGRESS_THROTTLE_MS) {
            notifySW({
                type: 'PROGRESS_UPDATE',
                pct: Math.min(pct, 100),
                current: Math.max(0, elapsed),
                total: historyTotalDuration,
            });
            lastProgressNotify = now;
        }

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
    notifySW({ type: 'PROGRESS_UPDATE', pct: 100 });
    notifySW({ type: 'PLAYBACK_STATE', state: 'done' });
    notifySW({ type: 'STATUS_UPDATE', text: 'Done' });
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
    notifySW({ type: 'PLAYBACK_STATE', state: 'stopped' });
    notifySW({ type: 'PROGRESS_UPDATE', pct: 0 });
}

// ── Seek ─────────────────────────────────────────────────────────────────────

function seekTo(targetTime) {
    if (!audioContext || audioHistory.length === 0) return;
    targetTime = Math.max(0, Math.min(targetTime, historyTotalDuration));
    console.log(`[offscreen] seekTo(${targetTime.toFixed(2)}s) — history: ${audioHistory.length} chunks, total: ${historyTotalDuration.toFixed(2)}s`);

    // Stop all currently scheduled sources
    for (const src of scheduledSources) {
        try { src.stop(); } catch (_) {}
    }
    scheduledSources = [];
    chunksAhead = 0;

    if (audioContext.state === 'suspended') audioContext.resume();

    // Seek base: small pre-roll so audio starts immediately
    const seekBase = audioContext.currentTime + 0.08;
    firstChunkStartTime = seekBase - targetTime; // so elapsed = currentTime - firstChunkStartTime = targetTime at seek moment
    nextPlayTime = seekBase;

    // Find the first history entry that overlaps targetTime
    let startIdx = audioHistory.length; // default: seek past end (nothing to replay)
    let trimSamples = 0;
    for (let i = 0; i < audioHistory.length; i++) {
        const e = audioHistory[i];
        if (e.relStart + e.duration > targetTime) {
            startIdx = i;
            trimSamples = Math.max(0, Math.floor((targetTime - e.relStart) * e.sampleRate));
            break;
        }
    }

    // Re-schedule history chunks from the seek point
    for (let i = startIdx; i < audioHistory.length; i++) {
        const entry = audioHistory[i];
        let data = entry.data;
        if (i === startIdx && trimSamples > 0) {
            data = data.subarray(trimSamples);
        }
        if (data.length === 0) continue;

        const buf = audioContext.createBuffer(1, data.length, entry.sampleRate);
        buf.copyToChannel(data, 0);
        const src = audioContext.createBufferSource();
        src.buffer = buf;
        src.connect(audioContext.destination);

        if (entry.countAsChunk) {
            chunksAhead++;
            src.onended = () => {
                chunksAhead--;
                scheduledSources = scheduledSources.filter((s) => s !== src);
            };
        } else {
            src.onended = () => { scheduledSources = scheduledSources.filter((s) => s !== src); };
        }

        src.start(nextPlayTime);
        scheduledSources.push(src);
        nextPlayTime += buf.duration + entry.pauseAfter;
    }

    totalScheduledDuration = nextPlayTime - firstChunkStartTime;
    historyTotalDuration   = totalScheduledDuration;

    if (!isPlaying) {
        isPlaying = true;
        notifySW({ type: 'PLAYBACK_STATE', state: 'playing' });
    }
    startProgressTracking();

    console.log(`[offscreen] seekTo: rescheduled ${audioHistory.length - startIdx} chunks after seek point`);
}

// ── WAV export ──────────────────────────────────────────────────────────────

function encodeWAV(samples, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = samples.length * (bitsPerSample / 8);
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');

    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

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

function handleDownloadRequest() {
    if (allSamples.length === 0) return;

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
    const safeName = articleTitle.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 60) || 'audio';

    notifySW({ type: 'DOWNLOAD_AUDIO', url, filename: `${safeName}.wav` });
}

// ── TTS Worker ──────────────────────────────────────────────────────────────

const STAGE_LABELS = {
    wasm:  'Initialising WASM\u2026',
    model: 'Loading model\u2026',
    voice: 'Loading voice\u2026',
    done:  'Ready',
};

function initWorker(voice) {
    const workerUrl = chrome.runtime.getURL('tts-worker.js');
    ttsWorker = new Worker(workerUrl);

    ttsWorker.onmessage = (event) => {
        const { type, ...payload } = event.data;

        switch (type) {
            case 'LOADING_PROGRESS':
                notifySW({ type: 'STATUS_UPDATE', text: STAGE_LABELS[payload.stage] ?? 'Loading\u2026' });
                notifySW({ type: 'PROGRESS_UPDATE', pct: payload.pct });
                notifySW({ type: 'PLAYBACK_STATE', state: 'loading' });
                break;

            case 'MODEL_READY':
                modelReady = true;
                notifySW({ type: 'PROGRESS_UPDATE', pct: 0 });
                notifySW({ type: 'MODEL_READY' });
                // Replay queued extraction if text was ready before model
                if (pendingExtraction) {
                    const queued = pendingExtraction;
                    pendingExtraction = null;
                    startGeneration(queued);
                } else {
                    notifySW({ type: 'STATUS_UPDATE', text: 'Ready' });
                }
                break;

            case 'PHONEMES_READY':
                if (!isPlaying) {
                    notifySW({ type: 'STATUS_UPDATE', text: `Generating audio ${payload.index + 1}/${payload.total}\u2026` });
                }
                console.log(`[offscreen] phonemes [${payload.index + 1}/${payload.total}]: "${payload.phonemes}"`);
                break;

            case 'AUDIO_CHUNK': {
                const { genId, index, total, samples, sampleRate,
                        endsWithParagraph, endsWithSection, isMidChunk, countAsChunk, pauseAfterMs } = payload;
                if (genId !== currentGenId) {
                    console.log(`[offscreen] dropping stale chunk (genId ${genId} \u2260 ${currentGenId})`);
                    break;
                }
                console.log(`[offscreen] audio chunk ${index + 1}/${total}: ${samples.length} samples (${(samples.length / sampleRate).toFixed(2)}s)${pauseAfterMs !== undefined ? ` +${pauseAfterMs}ms` : ''}`);
                queueAudioChunk(samples, sampleRate, endsWithParagraph, endsWithSection, isMidChunk, countAsChunk, index, pauseAfterMs);
                break;
            }

            case 'GENERATION_DONE':
                if (payload.genId !== currentGenId) break;
                flushPendingChunks();
                generationDone = true;
                notifySW({ type: 'GENERATION_DONE' });
                console.log(`[offscreen] all ${payload.total} sentences generated`);
                break;

            case 'VOICE_READY':
                console.log('[offscreen] voice switched to', payload.voice);
                notifySW({ type: 'VOICE_READY', voice: payload.voice });
                break;

            case 'ERROR':
                console.error('[offscreen] worker error:', payload.code, payload.detail);
                notifySW({ type: 'ERROR', code: payload.code, detail: payload.detail });
                break;

            default:
                console.log('[offscreen] worker message:', type, payload);
        }
    };

    ttsWorker.onerror = (err) => {
        console.error('[offscreen] worker crash:', err.message, '|', err.filename, 'line', err.lineno);
        notifySW({ type: 'ERROR', code: 'MODEL_LOAD_FAILED', detail: err.message || 'Worker crashed' });
    };

    notifySW({ type: 'STATUS_UPDATE', text: 'Loading model\u2026' });
    notifySW({ type: 'PLAYBACK_STATE', state: 'loading' });
    ttsWorker.postMessage({
        type:         'LOAD_MODEL',
        voice,
        wasmPaths:    chrome.runtime.getURL('wasm/'),
        modelUrl:     chrome.runtime.getURL('models/kokoro-v1.0.onnx'),
        voiceBaseUrl: chrome.runtime.getURL('models/voices/'),
    });
}

// ── Start generation from extraction result ─────────────────────────────────

function startGeneration(message) {
    console.log('[offscreen] startGeneration() —', message.sentences?.length, 'sentences,', message.wordCount, 'words');
    autoPlayMode = message.autoPlay !== false; // default true; EXTRACT_AND_STAGE sets false
    resetAudio();
    articleTitle = message.title || '';
    currentGenId++;
    ttsWorker.postMessage({ type: 'CANCEL' });
    ttsWorker.postMessage({
        type:      'GENERATE_AUDIO',
        sentences: message.sentences,
        speed:     currentUserSpeed,
        genId:     currentGenId,
    });

    const title = articleTitle ? `"\u200B${articleTitle.slice(0, 35)}"` : 'page';
    notifySW({ type: 'STATUS_UPDATE', text: `${message.wordCount} words from ${title} \u2014 generating\u2026` });
}

// ── Incoming messages from service worker ───────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    console.log('[offscreen] received message:', message.type, message.type === 'EXTRACTION_RESULT' ? `(${message.sentences?.length} sentences)` : '');
    switch (message.type) {
        case 'EXTRACTION_RESULT': {
            if (!modelReady || !ttsWorker) {
                // Model still loading — queue and replay when ready
                pendingExtraction = message;
                notifySW({ type: 'STATUS_UPDATE', text: 'Loading model\u2026 (text ready)' });
                notifySW({ type: 'PLAYBACK_STATE', state: 'loading' });
                return false;
            }

            startGeneration(message);
            return false;
        }

        case 'TOGGLE_PLAY_PAUSE': {
            if (!audioContext) return false;
            // Staged mode: user clicked play for the first time — start playback now
            if (!autoPlayMode && nextPlayTime === 0 && pendingChunks.length > 0) {
                autoPlayMode = true;
                startPlayback();
                return false;
            }
            if (audioContext.state === 'running') {
                audioContext.suspend();
                isPlaying = false;
                notifySW({ type: 'PLAYBACK_STATE', state: 'paused' });
                notifySW({ type: 'STATUS_UPDATE', text: 'Paused.' });
            } else if (audioContext.state === 'suspended') {
                audioContext.resume();
                isPlaying = true;
                notifySW({ type: 'PLAYBACK_STATE', state: 'playing' });
                notifySW({ type: 'STATUS_UPDATE', text: 'Playing\u2026' });
            }
            return false;
        }

        case 'STOP': {
            if (ttsWorker) ttsWorker.postMessage({ type: 'CANCEL' });
            stopPlayback();
            return false;
        }

        case 'SWITCH_VOICE': {
            if (!ttsWorker || !modelReady) return false;
            ttsWorker.postMessage({ type: 'SWITCH_VOICE', voice: message.voice });
            return false;
        }

        case 'SET_SPEED': {
            currentUserSpeed = message.speed;
            return false;
        }

        case 'SEEK_TO': {
            seekTo(message.timeSeconds);
            return false;
        }

        case 'REQUEST_DOWNLOAD': {
            handleDownloadRequest();
            return false;
        }

        case 'CANCEL_ALL': {
            if (ttsWorker) ttsWorker.postMessage({ type: 'CANCEL' });
            stopPlayback();
            return false;
        }

        case 'QUERY_READY_STATE': {
            // Service worker queries this before showing widget after 2s delay
            const sentenceCount = pendingChunks.filter((c) => c.countAsChunk).length;
            const chunksReady = (sentenceCount >= PREBUFFER_COUNT) || (generationDone && pendingChunks.length > 0);
            sendResponse({ chunksReady });
            return true; // keep channel open for sendResponse
        }
    }

    return false;
});

// ── Preferences & Init ──────────────────────────────────────────────────────

async function loadPreferences() {
    try {
        if (!chrome.storage?.local) return 'af_heart';
        const result = await chrome.storage.local.get(['voice', 'speed']);
        if (result.speed != null) {
            const speed = parseFloat(result.speed);
            if (speed >= 0.5 && speed <= 2.0) {
                currentUserSpeed = speed;
            }
        }
        return result.voice || 'af_heart';
    } catch (_) {
        return 'af_heart';
    }
}

(async () => {
    console.log('[offscreen] initializing...');
    const voice = await loadPreferences();
    console.log('[offscreen] loaded prefs, voice:', voice, 'speed:', currentUserSpeed);
    initWorker(voice);
    console.log('[offscreen] initWorker called, waiting for MODEL_READY...');
})();
