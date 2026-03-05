// offscreen.js — Audio playback + TTS worker host (replaces popup.js)
// Lives in a Chrome offscreen document; persists independently of any popup.

import { stretchAudio } from '../utils/audio-stretcher.js';
import { encodeToOpus } from './opus-encoder.js';
import {
    saveToCache, loadFromCache, checkCacheExists, clearExpired, normUrl,
    appendChunk, loadChunks, clearChunks,
    savePosition, loadPosition, deletePosition,
    saveGenerationJob, loadGenerationJob, deleteGenerationJob,
} from './audio-cache.js';

// ── Send state updates to service worker (which relays to content script widget) ──
function notifySW(message) {
    chrome.runtime.sendMessage(message).catch(() => {});
}

// ── Worker state ────────────────────────────────────────────────────────────
let ttsWorker       = null;
let modelReady      = false;
let currentVoiceName = null; // tracks desired voice; passed in every GENERATE_AUDIO

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
let chunksReadySent = false; // prevents re-sending 'loading' state after CHUNKS_READY in staged mode

let currentGenId = 0;

// Adaptive slowdown
const SLOW_THRESHOLD = 2;
const SLOW_RATE      = 0.9;

let currentUserSpeed = 1.0;
let chunksAhead = 0;
let pausedAtTime = 0; // elapsed seconds at the moment the user paused; used for rebuild-on-resume
let scheduledHighlightTimeouts = []; // IDs of pending SENTENCE_PLAYING setTimeout calls

// Incremental chunk save counter — monotonically increasing index per session
let chunkSaveIndex = 0;
// Highest sentence index fully generated this session (used to determine resume point)
let lastSentenceGenerated = -1;
// Deferred generation resume — queued while model is still loading after an offscreen restart
let pendingResume = null;

// Pause durations (seconds)
const PAUSE_SECTION   = 1.20;
const PAUSE_PARAGRAPH = 0.60;
const PAUSE_SENTENCE  = 0.25;

// WAV export
let articleTitle = '';
let currentPageUrl = null; // set from EXTRACTION_RESULT.pageUrl; used for cache key

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

function resetAudio(prevUrl) {
    console.log('[offscreen] resetAudio()');
    stopProgressTracking();
    clearHighlightTimeouts();
    // Clear previous session data from IndexedDB
    if (prevUrl) {
        clearChunks(prevUrl).catch(() => {});
        deletePosition(prevUrl).catch(() => {});
        deleteGenerationJob(prevUrl).catch(() => {});
    }
    if (audioContext) {
        try { audioContext.close(); } catch (_) {}
    }
    try {
        audioContext = new AudioContext({ sampleRate: 24000 });
    } catch (err) {
        console.error('[offscreen] AudioContext creation failed:', err);
        notifySW({ type: 'ERROR', code: 'AUDIO_CONTEXT_FAILED', detail: err.message });
        return;
    }
    nextPlayTime           = 0;
    firstChunkStartTime    = 0;
    totalScheduledDuration = 0;
    scheduledSources       = [];
    pendingChunks          = [];
    chunksAhead            = 0;
    isPlaying              = false;
    generationDone         = false;
    pausedAtTime           = 0;
    chunkSaveIndex         = 0;
    lastSentenceGenerated  = -1;
    pendingResume          = null;
    audioHistory           = [];
    historyTotalDuration   = 0;
    chunksReadySent        = false;
    currentPageUrl         = null;
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

    // Combine user speed with adaptive slowdown.
    // currentUserSpeed (0.5–2.0) is the user-facing rate from the speed slider.
    // slowMode multiplies by SLOW_RATE (0.9) to buy inference time when the buffer runs thin.
    const effectiveSpeed   = currentUserSpeed * (slowMode ? SLOW_RATE : 1.0);
    const stretchedSamples = stretchAudio(samples, effectiveSpeed);

    if (nextPlayTime < audioContext.currentTime) {
        nextPlayTime = audioContext.currentTime + 0.02;
    }

    // Fire SENTENCE_PLAYING exactly when this chunk's audio begins (not for overflow tails).
    // Track the timeout ID so it can be cancelled on pause or seek.
    if (!isMidChunk && sentenceIndex !== undefined) {
        const delayMs = Math.max(0, (nextPlayTime - audioContext.currentTime) * 1000);
        const tid = setTimeout(() => {
            scheduledHighlightTimeouts = scheduledHighlightTimeouts.filter(x => x !== tid);
            notifySW({ type: 'SENTENCE_PLAYING', index: sentenceIndex });
        }, delayMs);
        scheduledHighlightTimeouts.push(tid);
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
    const historyEntry = {
        relStart,
        duration: stretchedSamples.length / sampleRate,
        data: new Float32Array(stretchedSamples), // copy for replay
        sampleRate,
        countAsChunk,
        isMidChunk,
        sentenceIndex,
        pauseAfter: pause,
    };
    audioHistory.push(historyEntry);

    // Persist chunk to IndexedDB immediately — survives offscreen termination
    if (currentPageUrl) {
        const idx = chunkSaveIndex++;
        const buf = historyEntry.data.buffer.slice(
            historyEntry.data.byteOffset,
            historyEntry.data.byteOffset + historyEntry.data.byteLength
        );
        appendChunk(currentPageUrl, idx, {
            data: buf, sampleRate, countAsChunk, sentenceIndex, pauseAfter: pause,
        }).catch(() => {});
    }

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
            chunksReadySent = true;
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

        // Only send loading-state updates until the play button is shown
        if (!chunksReadySent) {
            notifySW({ type: 'STATUS_UPDATE', text: `Buffering\u2026 (${sentenceCount}/${PREBUFFER_COUNT})` });
            notifySW({ type: 'PLAYBACK_STATE', state: 'loading' });
        }

        if (sentenceCount >= PREBUFFER_COUNT) {
            if (autoPlayMode) {
                startPlayback();
            } else if (!chunksReadySent) {
                chunksReadySent = true;
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
    clearHighlightTimeouts();
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

// ── Highlight sync helpers ────────────────────────────────────────────────────

/** Cancel all pending SENTENCE_PLAYING timeouts (called on pause / seek / stop). */
function clearHighlightTimeouts() {
    for (const id of scheduledHighlightTimeouts) clearTimeout(id);
    scheduledHighlightTimeouts = [];
}

/**
 * Reschedule SENTENCE_PLAYING timeouts to match the current AudioContext clock.
 * Called after resume-from-pause or after a seek so the highlighter stays in sync.
 * Also immediately fires for the sentence at the current playhead position.
 */
function rescheduleHighlights() {
    clearHighlightTimeouts();
    if (!audioContext || audioHistory.length === 0 || firstChunkStartTime === 0) return;

    const now = audioContext.currentTime;
    let currentSentence = null;      // highest-relStart sentence that has already started
    const seenSentences = new Set(); // deduplicates mid-chunk overflow tails

    for (const entry of audioHistory) {
        if (entry.sentenceIndex === undefined) continue;
        // isMidChunk: stored on live entries; for IDB-restored entries use seenSentences dedup
        const isMid = entry.isMidChunk === true;
        const playAt = firstChunkStartTime + entry.relStart;

        if (playAt <= now) {
            // Already past — track the most recent sentence for the immediate-fire below
            if (!isMid) currentSentence = entry.sentenceIndex;
        } else {
            // Future — schedule a timeout for the first occurrence of each sentence
            if (!isMid && !seenSentences.has(entry.sentenceIndex)) {
                seenSentences.add(entry.sentenceIndex);
                const delayMs = Math.max(0, (playAt - now) * 1000);
                const tid = setTimeout(() => {
                    scheduledHighlightTimeouts = scheduledHighlightTimeouts.filter(x => x !== tid);
                    notifySW({ type: 'SENTENCE_PLAYING', index: entry.sentenceIndex });
                }, delayMs);
                scheduledHighlightTimeouts.push(tid);
            }
        }
    }

    // Immediately highlight the sentence playing right now
    if (currentSentence !== null) {
        notifySW({ type: 'SENTENCE_PLAYING', index: currentSentence });
    }
}

// ── Seek ─────────────────────────────────────────────────────────────────────

function seekTo(targetTime) {
    if (!audioContext || audioHistory.length === 0) return;
    // If Chrome force-closed the AudioContext (long inactivity in offscreen doc), create a fresh one
    if (audioContext.state === 'closed') {
        console.log('[offscreen] seekTo: AudioContext was closed — creating new one');
        audioContext = new AudioContext({ sampleRate: 24000 });
    }
    targetTime = Math.max(0, Math.min(targetTime, historyTotalDuration));
    console.log(`[offscreen] seekTo(${targetTime.toFixed(2)}s) — history: ${audioHistory.length} chunks, total: ${historyTotalDuration.toFixed(2)}s`);

    // Stop all currently scheduled sources and cancel stale highlight timeouts
    for (const src of scheduledSources) {
        try { src.stop(); } catch (_) {}
    }
    scheduledSources = [];
    chunksAhead = 0;
    clearHighlightTimeouts();

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
    rescheduleHighlights(); // sync highlighter to new playhead position

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

async function handleDownloadRequest() {
    const chunks = audioHistory.map(e => e.data);
    if (chunks.length === 0) return;

    const totalLen = chunks.reduce((sum, s) => sum + s.length, 0);
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }

    const safeName = articleTitle.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 60) || 'audio';

    try {
        console.log(`[offscreen] encoding ${(merged.length / 24000).toFixed(1)}s of audio to Opus…`);
        const opusBuffer = await encodeToOpus(merged, 24000);
        const blob = new Blob([opusBuffer], { type: 'audio/ogg; codecs=opus' });
        const opusUrl = URL.createObjectURL(blob);
        notifySW({ type: 'DOWNLOAD_AUDIO', url: opusUrl, filename: `${safeName}.ogg` });
        setTimeout(() => URL.revokeObjectURL(opusUrl), 60000);
        console.log(`[offscreen] Opus export done — ${(opusBuffer.byteLength / 1024).toFixed(0)} KB`);
    } catch (err) {
        // Fallback to WAV if Opus encoding fails (e.g. old Chrome, unsupported codec)
        console.warn('[offscreen] Opus encoding failed, falling back to WAV:', err.message);
        const wavBuffer = encodeWAV(merged, 24000);
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        const wavUrl = URL.createObjectURL(blob);
        notifySW({ type: 'DOWNLOAD_AUDIO', url: wavUrl, filename: `${safeName}.wav` });
        setTimeout(() => URL.revokeObjectURL(wavUrl), 60000);
    }
}

// ── TTS Worker ──────────────────────────────────────────────────────────────

// ── Remote model hosting (Hugging Face) ──────────────────────────────────────
// Upload kokoro-v1.0.onnx and the voices/ folder to your HF repo, then set
// these two URLs. The model is downloaded once on first use and cached in OPFS.
const HF_REPO           = 'https://huggingface.co/BRJ45/Kokoro-tts-onnx/resolve/main';
const HF_MODEL_URL      = `${HF_REPO}/kokoro-v1.0.onnx`;
const HF_VOICE_BASE_URL = `${HF_REPO}/`;

const STAGE_LABELS = {
    wasm:         'Initialising engine\u2026',
    downloading:  'Downloading model\u2026 (first run, ~310 MB)',
    saving:       'Saving model locally\u2026',
    model_cached: 'Loading model\u2026',
    model:        'Loading model\u2026',
    voice:        'Loading voice\u2026',
    done:         'Ready',
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
                } else if (pendingResume) {
                    // Resume generation after offscreen restart (RESTORE_SESSION queued it)
                    const resume = pendingResume;
                    pendingResume = null;
                    resume();
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
                // Track highest fully-generated sentence index (not mid-chunk overflow tails)
                if (!isMidChunk && index > lastSentenceGenerated) lastSentenceGenerated = index;
                queueAudioChunk(samples, sampleRate, endsWithParagraph, endsWithSection, isMidChunk, countAsChunk, index, pauseAfterMs);
                break;
            }

            case 'GENERATION_DONE':
                if (payload.genId !== currentGenId) break;
                flushPendingChunks();
                generationDone = true;
                notifySW({ type: 'GENERATION_DONE' });
                console.log(`[offscreen] all ${payload.total} sentences generated`);
                // Save to IndexedDB and notify when done
                (async () => {
                    try {
                        if (currentPageUrl) {
                            const entries = buildCacheEntries();
                            if (entries.length > 0) {
                                await saveToCache(currentPageUrl, { title: articleTitle, entries });
                                console.log('[offscreen] saved to cache for', currentPageUrl, `(${entries.length} chunks)`);
                                // Individual chunks + job now redundant — audio store has the full record
                                clearChunks(currentPageUrl).catch(() => {});
                                deleteGenerationJob(currentPageUrl).catch(() => {});
                            }
                        }
                    } catch (err) {
                        console.error('[offscreen] cache save failed:', err);
                    } finally {
                        notifySW({ type: 'DOWNLOAD_READY' });
                    }
                })();
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
        notifySW({ type: 'ERROR', code: 'WORKER_CRASHED', detail: err.message || 'Worker crashed' });
        // Tear down audio + notify widget, then restart the worker so the extension remains usable
        ttsWorker = null;
        modelReady = false;
        stopPlayback();
        initWorker(currentVoiceName);
    };

    ttsWorker.onmessageerror = (err) => {
        console.error('[offscreen] worker message deserialise error:', err);
    };

    notifySW({ type: 'STATUS_UPDATE', text: 'Loading model\u2026' });
    notifySW({ type: 'PLAYBACK_STATE', state: 'loading' });
    ttsWorker.postMessage({
        type:               'LOAD_MODEL',
        voice,
        wasmPaths:          chrome.runtime.getURL('wasm/'),
        remoteModelUrl:     HF_MODEL_URL,
        remoteVoiceBaseUrl: HF_VOICE_BASE_URL,
        // Local fallbacks (only used if remote URL is missing or during development)
        modelUrl:           chrome.runtime.getURL('models/kokoro-v1.0.onnx'),
        voiceBaseUrl:       chrome.runtime.getURL('models/voices/'),
    });
}

// ── Cache helpers ────────────────────────────────────────────────────────────

/**
 * Build the array of entries to persist in IndexedDB.
 * If audio was already played, use audioHistory (has relStart / timing data).
 * If we're in staged mode (play never clicked), derive from pendingChunks.
 */
function buildCacheEntries() {
    if (audioHistory.length > 0) {
        return audioHistory.map(e => ({
            data:         e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength),
            sampleRate:   e.sampleRate,
            countAsChunk: e.countAsChunk,
            sentenceIndex: e.sentenceIndex,
            pauseAfter:   e.pauseAfter,
        }));
    }
    if (pendingChunks.length > 0) {
        return pendingChunks.map(chunk => {
            const pause = chunk.pauseAfterMs !== undefined
                ? chunk.pauseAfterMs / 1000
                : chunk.isMidChunk        ? 0
                : chunk.endsWithSection   ? PAUSE_SECTION
                : chunk.endsWithParagraph ? PAUSE_PARAGRAPH
                : PAUSE_SENTENCE;
            return {
                data:         chunk.samples.buffer.slice(chunk.samples.byteOffset, chunk.samples.byteOffset + chunk.samples.byteLength),
                sampleRate:   chunk.sampleRate,
                countAsChunk: chunk.countAsChunk,
                sentenceIndex: chunk.sentenceIndex,
                pauseAfter:   pause,
            };
        });
    }
    return [];
}

// ── Start generation from extraction result ─────────────────────────────────

async function startGeneration(message) {
    console.log('[offscreen] startGeneration() —', message.sentences?.length, 'sentences,', message.wordCount, 'words');

    // Read the latest voice + speed preferences directly from storage.
    // This is the definitive source of truth — bypasses all messaging paths.
    try {
        if (chrome.storage?.local) {
            const result = await chrome.storage.local.get(['voice', 'speed']);
            if (result.voice) {
                currentVoiceName = result.voice;
            }
            if (result.speed != null) {
                const speed = parseFloat(result.speed);
                if (speed >= 0.5 && speed <= 2.0) currentUserSpeed = speed;
            }
        }
    } catch (_) {}
    console.log('[offscreen] startGeneration voice:', currentVoiceName, 'speed:', currentUserSpeed);

    autoPlayMode = message.autoPlay !== false; // default true; EXTRACT_AND_STAGE sets false
    const prevUrl = currentPageUrl; // save before resetAudio clears it
    resetAudio(prevUrl);
    articleTitle   = message.title   || '';
    currentPageUrl = message.pageUrl || null;

    // Persist sentence list so generation can resume if Chrome kills the offscreen
    if (currentPageUrl && message.sentences?.length > 0) {
        saveGenerationJob(currentPageUrl, { sentences: message.sentences, title: articleTitle }).catch(() => {});
    }
    currentGenId++;
    ttsWorker.postMessage({ type: 'CANCEL' });
    ttsWorker.postMessage({
        type:      'GENERATE_AUDIO',
        sentences: message.sentences,
        speed:     currentUserSpeed,
        voice:     currentVoiceName, // worker loads this voice before starting inference
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
            // Cache-loaded state: audioHistory populated but audio not yet scheduled
            if (audioHistory.length > 0 && nextPlayTime === 0 && pendingChunks.length === 0) {
                seekTo(0);
                return false;
            }
            // Staged mode: user clicked play for the first time — start playback now
            if (!autoPlayMode && nextPlayTime === 0 && pendingChunks.length > 0) {
                autoPlayMode = true;
                startPlayback();
                return false;
            }
            if (audioContext.state === 'running') {
                pausedAtTime = Math.max(0, audioContext.currentTime - firstChunkStartTime);
                clearHighlightTimeouts(); // stop spurious highlights during pause
                audioContext.suspend().catch(() => {});
                isPlaying = false;
                // Persist position so it survives offscreen termination
                if (currentPageUrl) {
                    savePosition(currentPageUrl, {
                        position: pausedAtTime,
                        generationComplete: generationDone,
                        title: articleTitle,
                    }).catch(() => {});
                }
                notifySW({ type: 'PLAYBACK_STATE', state: 'paused' });
                notifySW({ type: 'STATUS_UPDATE', text: 'Paused.' });
            } else if (audioContext.state === 'closed') {
                // AudioContext was killed (e.g. keepalive failed) — rebuild from saved position
                seekTo(pausedAtTime);
            } else {
                // Normal resume — AudioContext was merely suspended, not killed
                audioContext.resume().catch(() => {});
                isPlaying = true;
                rescheduleHighlights(); // restore highlights from pause point
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
            console.log('[offscreen] SWITCH_VOICE received, voice:', message.voice, 'ttsWorker:', !!ttsWorker, 'modelReady:', modelReady);
            // Track the desired voice so it is included in the next GENERATE_AUDIO
            currentVoiceName = message.voice;
            if (!ttsWorker || !modelReady) return false;
            ttsWorker.postMessage({ type: 'SWITCH_VOICE', voice: message.voice });
            return false;
        }

        case 'WIDGET_ACTION': {
            console.log('[offscreen] WIDGET_ACTION received, action:', message.action, message.action === 'SWITCH_VOICE' ? 'voice: ' + message.voice : '');
            // Content script → offscreen via chrome.runtime.sendMessage is reliable.
            // Handle directly here in case the SW relay never arrives.
            if (message.action === 'SWITCH_VOICE') {
                currentVoiceName = message.voice;
                if (ttsWorker && modelReady) {
                    ttsWorker.postMessage({ type: 'SWITCH_VOICE', voice: message.voice });
                }
            } else if (message.action === 'SET_SPEED') {
                currentUserSpeed = message.speed;
                console.log('[offscreen] speed updated via WIDGET_ACTION:', currentUserSpeed);
            }
            return false;
        }

        case 'SET_SPEED': {
            currentUserSpeed = message.speed;
            console.log('[offscreen] SET_SPEED:', currentUserSpeed);
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

        case 'CLOSE_WIDGET': {
            // Widget is hiding — suspend audio but keep state; persist position to IDB
            // so that if Chrome terminates the offscreen, state can be restored.
            if (audioContext && audioContext.state === 'running') {
                pausedAtTime = Math.max(0, audioContext.currentTime - firstChunkStartTime);
                audioContext.suspend().catch(() => {});
                isPlaying = false;
            }
            if (currentPageUrl) {
                savePosition(currentPageUrl, {
                    position: pausedAtTime,
                    generationComplete: generationDone,
                    title: articleTitle,
                }).catch(() => {});
            }
            return false;
        }

        case 'QUERY_CACHE': {
            // Service worker asks: is there cached or in-progress audio for this URL?
            // In-memory state takes priority over IndexedDB so we don't reload live audio —
            // BUT only if the in-memory audio belongs to the same URL. If the user switched
            // to a different page, report no in-memory audio so a fresh generation starts.
            (async () => {
                const hasAudio = audioHistory.length > 0 || pendingChunks.length > 0;
                const urlMatches = !message.url || !currentPageUrl ||
                    normUrl(message.url) === currentPageUrl;
                if (hasAudio && urlMatches) {
                    sendResponse({
                        hit:         false,
                        hasAudio:    true,
                        generating:  !generationDone,
                        chunksReady: chunksReadySent || generationDone,
                    });
                    return;
                }
                try {
                    const hit = await checkCacheExists(message.url);
                    sendResponse({ hit, hasAudio: false, generating: false, chunksReady: false });
                } catch (_) {
                    sendResponse({ hit: false, hasAudio: false, generating: false, chunksReady: false });
                }
            })();
            return true; // async sendResponse
        }

        case 'LOAD_FROM_CACHE': {
            // Load previously-generated audio from IndexedDB and prepare for playback.
            (async () => {
                try {
                    const cached = await loadFromCache(message.url);
                    if (!cached || cached.entries.length === 0) {
                        console.warn('[offscreen] LOAD_FROM_CACHE: cache miss or expired for', message.url);
                        notifySW({ type: 'CACHE_MISS' });
                        return;
                    }

                    // Tear down any existing AudioContext and rebuild
                    stopProgressTracking();
                    if (audioContext) { try { audioContext.close(); } catch (_) {} }
                    audioContext = new AudioContext({ sampleRate: 24000 });
                    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});

                    // Reconstruct audioHistory from saved entries
                    let relStart = 0;
                    audioHistory = cached.entries.map(e => {
                        const data  = new Float32Array(e.data);
                        const entry = {
                            relStart,
                            duration:     data.length / e.sampleRate,
                            data,
                            sampleRate:   e.sampleRate,
                            countAsChunk: e.countAsChunk,
                            sentenceIndex: e.sentenceIndex,
                            pauseAfter:   e.pauseAfter,
                        };
                        relStart += entry.duration + e.pauseAfter;
                        return entry;
                    });

                    historyTotalDuration   = relStart;
                    totalScheduledDuration = relStart;
                    generationDone  = true;
                    autoPlayMode    = false;
                    nextPlayTime    = 0;
                    firstChunkStartTime = 0;
                    isPlaying       = false;
                    scheduledSources = [];
                    pendingChunks   = [];
                    chunksAhead     = 0;
                    chunksReadySent = false;
                    articleTitle    = cached.title;

                    // Restore saved playback position (if any)
                    const savedPos = await loadPosition(message.url);
                    const resumeAt = savedPos?.position ?? 0;
                    currentPageUrl = normUrl(message.url);

                    console.log(`[offscreen] loaded ${audioHistory.length} chunks (${historyTotalDuration.toFixed(1)}s) from cache, resume at ${resumeAt.toFixed(2)}s`);
                    pausedAtTime = resumeAt;
                    notifySW({ type: 'STATUS_UPDATE', text: `"${cached.title}" ready to play` });
                    notifySW({ type: 'PROGRESS_UPDATE', pct: 0, current: resumeAt, total: historyTotalDuration });
                    notifySW({ type: 'DOWNLOAD_READY' });
                } catch (err) {
                    console.error('[offscreen] LOAD_FROM_CACHE error:', err);
                    notifySW({ type: 'CACHE_MISS' });
                }
            })();
            return false;
        }

        case 'RESTORE_SESSION': {
            // Chrome terminated the offscreen while the user was paused.
            // Rebuild audio state from the persistent IDB stores and resume playback.
            (async () => {
                try {
                    const url = message.url;
                    const [sessionPos, chunks] = await Promise.all([
                        loadPosition(url),
                        loadChunks(url),
                    ]);

                    // Fall back to complete audio store if individual chunks are gone
                    // (generation finished before termination → clearChunks already ran)
                    let audioEntries = chunks;
                    let fromCompleteCache = false;
                    if (audioEntries.length === 0) {
                        const cached = await loadFromCache(url);
                        if (cached?.entries?.length > 0) {
                            audioEntries = cached.entries;
                            fromCompleteCache = true;
                        }
                    }

                    if (audioEntries.length === 0) {
                        console.warn('[offscreen] RESTORE_SESSION: no data found for', url);
                        notifySW({ type: 'CACHE_MISS' });
                        return;
                    }

                    // Rebuild AudioContext and audioHistory
                    stopProgressTracking();
                    if (audioContext) { try { audioContext.close(); } catch (_) {} }
                    audioContext = new AudioContext({ sampleRate: 24000 });
                    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});

                    let relStart = 0;
                    audioHistory = audioEntries.map(entry => {
                        const data = new Float32Array(entry.data);
                        const e = {
                            relStart,
                            duration:      data.length / entry.sampleRate,
                            data,
                            sampleRate:    entry.sampleRate,
                            countAsChunk:  entry.countAsChunk,
                            sentenceIndex: entry.sentenceIndex,
                            pauseAfter:    entry.pauseAfter,
                        };
                        relStart += e.duration + entry.pauseAfter;
                        return e;
                    });

                    historyTotalDuration   = relStart;
                    totalScheduledDuration = relStart;
                    scheduledSources       = [];
                    pendingChunks          = [];
                    chunksAhead            = 0;
                    isPlaying              = false;
                    autoPlayMode           = false;
                    chunksReadySent        = true;
                    generationDone         = sessionPos?.generationComplete ?? fromCompleteCache;
                    articleTitle           = sessionPos?.title ?? '';
                    currentPageUrl         = normUrl(url);
                    nextPlayTime           = 0;
                    firstChunkStartTime    = 0;
                    pausedAtTime           = sessionPos?.position ?? 0;

                    // chunkSaveIndex must continue from where we left off so new
                    // appendChunk calls don't overwrite existing IDB entries
                    chunkSaveIndex = audioHistory.length;

                    console.log(`[offscreen] RESTORE_SESSION: ${audioHistory.length} chunks (${historyTotalDuration.toFixed(1)}s), resuming from ${pausedAtTime.toFixed(2)}s`);

                    // Seek to saved position and auto-play
                    seekTo(pausedAtTime);

                    notifySW({ type: 'CHUNKS_READY' });
                    if (generationDone) {
                        notifySW({ type: 'DOWNLOAD_READY' });
                    } else {
                        // Generation was interrupted — resume it from the next sentence
                        const job = await loadGenerationJob(url);
                        if (job?.sentences?.length > 0) {
                            // Derive last generated sentence index from saved chunks
                            const lastIdx = audioEntries.reduce((max, e) =>
                                (e.sentenceIndex != null) ? Math.max(max, e.sentenceIndex) : max, -1);
                            const resumeFrom = lastIdx + 1;
                            if (resumeFrom < job.sentences.length) {
                                const resumeSentences = job.sentences.slice(resumeFrom);
                                console.log(`[offscreen] RESTORE_SESSION: resuming generation from sentence ${resumeFrom}/${job.sentences.length}`);
                                const doResume = () => {
                                    currentGenId++;
                                    lastSentenceGenerated = lastIdx;
                                    ttsWorker.postMessage({
                                        type:        'GENERATE_AUDIO',
                                        sentences:   resumeSentences,
                                        speed:       currentUserSpeed,
                                        voice:       currentVoiceName,
                                        genId:       currentGenId,
                                        indexOffset: resumeFrom,
                                    });
                                };
                                if (modelReady) {
                                    doResume();
                                } else {
                                    // Model is still loading — queue for MODEL_READY
                                    pendingResume = doResume;
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.error('[offscreen] RESTORE_SESSION error:', err);
                    notifySW({ type: 'CACHE_MISS' });
                }
            })();
            return false;
        }

        case 'CANCEL_ALL': {
            if (ttsWorker) ttsWorker.postMessage({ type: 'CANCEL' });
            stopPlayback();
            return false;
        }

        case 'QUERY_READY_STATE': {
            // Legacy — kept for compatibility; SW no longer calls this
            const sentenceCount = pendingChunks.filter((c) => c.countAsChunk).length;
            const chunksReady = (sentenceCount >= PREBUFFER_COUNT) || (generationDone && pendingChunks.length > 0);
            sendResponse({ chunksReady });
            return true;
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
    currentVoiceName = voice; // track so startGeneration always passes the right voice
    console.log('[offscreen] loaded prefs, voice:', voice, 'speed:', currentUserSpeed);
    initWorker(voice);
    console.log('[offscreen] initWorker called, waiting for MODEL_READY...');
    // Housekeeping: purge expired cache entries on startup
    clearExpired().catch(() => {});
    // Signal to the service worker that offscreen is alive.
    // SW will send RESTORE_SESSION if this was an unexpected restart after termination.
    notifySW({ type: 'OFFSCREEN_READY' });
})();
