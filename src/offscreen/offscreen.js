// offscreen.js — TTS generation engine (no audio playback)
//
// Hosts 1 or 2 TTS Web Workers (turbo mode), manages model lifecycle,
// writes chunks to IndexedDB via a reorder buffer that guarantees
// sentence-order delivery, and forwards generated audio to the content
// script (via SW relay) for playback.
// All AudioContext / playback code lives in content/audio-player.js.

import {
    saveToCache, loadFromCache, checkCacheExists, clearExpired, normUrl,
    appendChunk, loadChunks, clearChunks,
    savePosition, loadPosition, deletePosition,
    saveGenerationJob, loadGenerationJob, deleteGenerationJob,
} from './audio-cache.js';

// ── Send messages to service worker (which relays to content script) ─────────
function notifySW(message) {
    chrome.runtime.sendMessage(message).catch(() => {});
}

// ── Worker state ─────────────────────────────────────────────────────────────
let turboMode          = true;   // default ON — dual workers
let workers            = [];     // [Worker] or [Worker, Worker]
let workersReady       = 0;      // count of workers that sent MODEL_READY
let allWorkersReady    = false;
let currentVoiceName   = null;

// ── Progress throttle state ──────────────────────────────────────────────────
// fetchToOpfsWithProgress fires onProgress on every HTTP stream chunk, which
// without throttling causes ~33K SW messages per model download. We track the
// last relayed stage + rounded pct and only forward when something changes.
let lastProgressStage = null;
let lastProgressPct   = -1;

// ── Generation state ─────────────────────────────────────────────────────────
let currentGenId          = 0;
let currentPageUrl        = null;
let articleTitle          = '';
let generationDone        = false;
let chunkSaveIndex        = 0;
let lastSentenceGenerated = -1;
let currentUserSpeed      = 1.0;
let allSentences          = [];  // full sentence list for current generation

// Pending extraction queue — holds messages that arrived before the model was ready.
// On MODEL_READY the most-recent entry is started and earlier ones are discarded.
let pendingExtractionQueue = [];
// Deferred generation resume — queued while model is still loading after restart
let pendingResume = null;

// ── Reorder buffer ───────────────────────────────────────────────────────────
// With dual workers, chunks arrive out of sentence-order. The reorder buffer
// collects chunks keyed by sentenceIndex and flushes them in strict ascending
// order once each sentence is marked complete (SENTENCE_COMPLETE from worker).
const reorderBuffer = new Map(); // sentenceIndex → { chunks: [], complete: false }
let nextFlushIndex  = 0;

// ── Worker completion tracking ───────────────────────────────────────────────
let activeWorkerCount = 0;  // workers with active GENERATE_AUDIO tasks
let workersDoneCount  = 0;  // workers that sent GENERATION_DONE for current genId

// Per-worker sentence assignments for the current generation.
// Used to re-dispatch work to a recreated worker after a crash.
// Map<workerIndex, { sentences: [], indices: [], totalSentences: number }>
const workerAssignments = new Map();

// Pause durations — must stay in sync with audio-player.js for IDB entries
const PAUSE_SECTION   = 1.20;
const PAUSE_PARAGRAPH = 0.60;
const PAUSE_SENTENCE  = 0.25;

// ── Remote model hosting (Hugging Face) ──────────────────────────────────────
const HF_REPO           = 'https://huggingface.co/BRJ45/Kokoro-tts-onnx/resolve/main';
const HF_MODEL_URL      = `${HF_REPO}/kokoro-v1.0.onnx`;
const HF_VOICE_BASE_URL = `${HF_REPO}/`;

const STAGE_LABELS = {
    wasm:         'Initialising engine\u2026',
    downloading:  'Downloading model\u2026 (first run, ~310 MB)',
    retrying:     'Retrying download\u2026',
    saving:       'Saving model locally\u2026',
    model_cached: 'Loading model\u2026',
    model:        'Loading model\u2026',
    voice:        'Loading voice\u2026',
    done:         'Ready',
};

// ── TTS Worker lifecycle ─────────────────────────────────────────────────────

/**
 * Build the LOAD_MODEL message shared by all workers.
 */
function buildLoadModelMsg(voice) {
    return {
        type:               'LOAD_MODEL',
        voice,
        wasmPaths:          chrome.runtime.getURL('wasm/'),
        remoteModelUrl:     HF_MODEL_URL,
        remoteVoiceBaseUrl: HF_VOICE_BASE_URL,
        modelUrl:           chrome.runtime.getURL('models/kokoro-v1.0.onnx'),
        voiceBaseUrl:       chrome.runtime.getURL('models/voices/'),
    };
}

/**
 * Initialise 1 or 2 TTS workers depending on turbo mode.
 * Both workers load the model in parallel for fastest start-up.
 */
function initWorkers(voice) {
    const workerCount = turboMode ? 2 : 1;
    workers           = [];
    workersReady      = 0;
    allWorkersReady   = false;
    lastProgressStage = null;
    lastProgressPct   = -1;

    const workerUrl    = chrome.runtime.getURL('tts-worker.js');
    const loadModelMsg = buildLoadModelMsg(voice);

    for (let w = 0; w < workerCount; w++) {
        const worker      = new Worker(workerUrl);
        const workerIndex = w;

        worker.onmessage = (event) => handleWorkerMessage(workerIndex, event);
        worker.onerror   = (err)  => handleWorkerError(workerIndex, err);
        worker.onmessageerror = (err) => {
            console.error(`[offscreen] worker ${workerIndex} message deserialise error:`, err);
        };

        workers.push(worker);
        worker.postMessage(loadModelMsg);
    }

    console.log(`[offscreen] initialised ${workerCount} worker(s) (turbo=${turboMode})`);
    notifySW({ type: 'STATUS_UPDATE', text: 'Loading model\u2026', relayToContent: true, relayToOnboarding: true });
    notifySW({ type: 'PLAYBACK_STATE', state: 'loading', relayToContent: true });
}

// ── Worker message dispatch ──────────────────────────────────────────────────

function handleWorkerMessage(workerIndex, event) {
    const { type, ...payload } = event.data;

    switch (type) {
        case 'LOADING_PROGRESS':
            // Relay progress from worker 0 only, throttled to stage changes or
            // ≥1% pct change — fetchToOpfsWithProgress fires on every HTTP chunk
            // which would otherwise flood the SW with ~33K messages per download.
            if (workerIndex === 0) {
                const pctRounded = Math.round(payload.pct);
                const stageChanged = payload.stage !== lastProgressStage;
                const pctChanged   = pctRounded !== lastProgressPct;
                if (stageChanged || pctChanged) {
                    lastProgressStage = payload.stage;
                    lastProgressPct   = pctRounded;
                    notifySW({ type: 'STATUS_UPDATE', text: STAGE_LABELS[payload.stage] ?? 'Loading\u2026', relayToContent: true, relayToOnboarding: true });
                    notifySW({ type: 'PROGRESS_UPDATE', pct: payload.pct, relayToContent: true, relayToOnboarding: true });
                    notifySW({ type: 'PLAYBACK_STATE', state: 'loading', relayToContent: true });
                }
            }
            break;

        case 'MODEL_READY': {
            workersReady++;
            console.log(`[offscreen] worker ${workerIndex} model ready (${workersReady}/${workers.length})`);
            if (workersReady >= workers.length) {
                allWorkersReady = true;
                notifySW({ type: 'PROGRESS_UPDATE', pct: 0, relayToContent: true, relayToOnboarding: true });
                notifySW({ type: 'MODEL_READY', relayToContent: true, relayToOnboarding: true });
                if (pendingExtractionQueue.length > 0) {
                    // Start only the most-recent extraction; discard all earlier ones
                    const queued = pendingExtractionQueue[pendingExtractionQueue.length - 1];
                    pendingExtractionQueue = [];
                    startGeneration(queued);
                } else if (pendingResume) {
                    const resume = pendingResume;
                    pendingResume = null;
                    resume();
                } else {
                    notifySW({ type: 'STATUS_UPDATE', text: 'Ready', relayToContent: true, relayToOnboarding: true });
                }
            }
            break;
        }

        case 'PHONEMES_READY':
            console.log(`[offscreen] phonemes [${payload.index + 1}/${payload.total}]: "${payload.phonemes}"`);
            break;

        case 'AUDIO_CHUNK':
            handleAudioChunk(workerIndex, payload);
            break;

        case 'SENTENCE_COMPLETE':
            handleSentenceComplete(workerIndex, payload);
            break;

        case 'GENERATION_DONE':
            handleWorkerGenerationDone(workerIndex, payload);
            break;

        case 'VOICE_READY':
            console.log(`[offscreen] worker ${workerIndex} voice switched to`, payload.voice);
            // Relay once to avoid duplicate UI flicker
            if (workerIndex === 0) {
                notifySW({ type: 'VOICE_READY', voice: payload.voice, relayToContent: true });
            }
            break;

        case 'DOWNLOAD_FAILED':
            console.error(`[offscreen] worker ${workerIndex} download failed:`, payload.detail);
            notifySW({ type: 'ERROR', code: 'WORKER_ERROR', detail: payload.detail || 'Model download failed', relayToContent: true });
            break;

        case 'ERROR':
            console.error(`[offscreen] worker ${workerIndex} error:`, payload.code, payload.detail);
            notifySW({ type: 'ERROR', code: payload.code, detail: payload.detail, relayToContent: true });
            break;

        default:
            console.log(`[offscreen] worker ${workerIndex} message:`, type, payload);
    }
}

function handleWorkerError(workerIndex, err) {
    console.error(`[offscreen] worker ${workerIndex} crash:`, err.message);
    notifySW({ type: 'ERROR', code: 'WORKER_CRASHED', detail: err.message || 'Worker crashed' });

    // Recreate the crashed worker and reload model
    const workerUrl = chrome.runtime.getURL('tts-worker.js');
    const newWorker = new Worker(workerUrl);
    const idx       = workerIndex;

    newWorker.onmessage      = (event) => handleWorkerMessage(idx, event);
    newWorker.onerror        = (err2)  => handleWorkerError(idx, err2);
    newWorker.onmessageerror = (err2)  => {
        console.error(`[offscreen] worker ${idx} message deserialise error:`, err2);
    };

    workers[workerIndex] = newWorker;
    workersReady         = Math.max(0, workersReady - 1);
    allWorkersReady      = false;

    // The assignment for this worker is saved in workerAssignments. Once
    // MODEL_READY fires for the new worker, re-dispatch its sentences.
    // Until then, decrement activeWorkerCount so GENERATION_DONE can still
    // fire from the surviving worker(s) if this worker had no pending work.
    const savedAssignment = workerAssignments.get(workerIndex);
    if (!savedAssignment || savedAssignment.sentences.length === 0) {
        // No sentences were assigned — the surviving workers can still finish
        activeWorkerCount = Math.max(0, activeWorkerCount - 1);
    }
    // If there are sentences to redo, activeWorkerCount stays the same:
    // the new worker will re-join and eventually send GENERATION_DONE.

    // Store the genId at crash time so the redispatch is scoped correctly
    const crashGenId = currentGenId;
    const originalOnMessage = newWorker.onmessage;
    newWorker.onmessage = (event) => {
        if (event.data?.type === 'MODEL_READY' && crashGenId === currentGenId && savedAssignment?.sentences.length > 0) {
            console.log(`[offscreen] worker ${idx} recovered — re-dispatching ${savedAssignment.sentences.length} sentences`);
            newWorker.postMessage({
                type:            'GENERATE_AUDIO',
                sentences:       savedAssignment.sentences,
                sentenceIndices: savedAssignment.indices,
                totalSentences:  savedAssignment.totalSentences,
                speed:           currentUserSpeed,
                voice:           currentVoiceName,
                genId:           currentGenId,
            });
        }
        originalOnMessage(event);
    };

    newWorker.postMessage(buildLoadModelMsg(currentVoiceName));
}

// ── Reorder buffer ───────────────────────────────────────────────────────────

/**
 * Store an AUDIO_CHUNK in the reorder buffer (keyed by sentenceIndex).
 */
function handleAudioChunk(workerIndex, payload) {
    const { genId, index, total, samples, sampleRate,
            endsWithParagraph, endsWithSection, isMidChunk,
            countAsChunk, pauseAfterMs } = payload;

    if (genId !== currentGenId) {
        console.log(`[offscreen] dropping stale chunk from worker ${workerIndex} (genId ${genId} \u2260 ${currentGenId})`);
        return;
    }

    console.log(`[offscreen] worker ${workerIndex} chunk sentence=${index + 1}/${total}: ${samples.length} samples (${(samples.length / sampleRate).toFixed(2)}s)`);

    // Calculate pause for IDB entry
    const pause = pauseAfterMs !== undefined
        ? pauseAfterMs / 1000
        : isMidChunk        ? 0
        : endsWithSection   ? PAUSE_SECTION
        : endsWithParagraph ? PAUSE_PARAGRAPH
        : PAUSE_SENTENCE;

    if (!reorderBuffer.has(index)) {
        reorderBuffer.set(index, { chunks: [], complete: false });
    }
    reorderBuffer.get(index).chunks.push({
        samples, sampleRate, index, total,
        endsWithParagraph, endsWithSection, isMidChunk,
        countAsChunk, pauseAfterMs, pause,
    });
}

/**
 * Mark a sentence as fully generated (all AUDIO_CHUNKs posted).
 * Triggers a flush attempt.
 */
function handleSentenceComplete(workerIndex, payload) {
    const { index, genId } = payload;
    if (genId !== currentGenId) return;

    console.log(`[offscreen] worker ${workerIndex} sentence ${index + 1} complete`);

    if (!reorderBuffer.has(index)) {
        reorderBuffer.set(index, { chunks: [], complete: true });
    } else {
        reorderBuffer.get(index).complete = true;
    }

    flushReorderBuffer();
}

/**
 * Flush all consecutive complete sentences starting from nextFlushIndex.
 * Each chunk is persisted to IDB and relayed to the content script.
 */
function flushReorderBuffer() {
    while (reorderBuffer.has(nextFlushIndex)) {
        const entry = reorderBuffer.get(nextFlushIndex);
        if (!entry.complete) break;

        for (const chunk of entry.chunks) {
            // Track highest sentence index for resume
            if (!chunk.isMidChunk && chunk.index > lastSentenceGenerated) {
                lastSentenceGenerated = chunk.index;
            }

            // Persist chunk to IndexedDB (survives offscreen termination)
            if (currentPageUrl) {
                const idx = chunkSaveIndex++;
                const buf = chunk.samples.buffer.slice(
                    chunk.samples.byteOffset,
                    chunk.samples.byteOffset + chunk.samples.byteLength
                );
                appendChunk(currentPageUrl, idx, {
                    data: buf, sampleRate: chunk.sampleRate, countAsChunk: chunk.countAsChunk,
                    sentenceIndex: chunk.index, pauseAfter: chunk.pause,
                }).catch(() => {});
            }

            // Forward audio data to content script via SW relay.
            // Use Array.from() — the message passes through two structured-clone hops
            // (offscreen → SW → content script via tabs.sendMessage). ArrayBuffer
            // arrives detached/zero-length on the second hop; plain arrays survive intact.
            notifySW({
                type:              'AUDIO_CHUNK_READY',
                relayToContent:    true,
                samples:           Array.from(chunk.samples),
                sampleRate:        chunk.sampleRate,
                sentenceIndex:     chunk.index,
                total:             chunk.total,
                countAsChunk:      chunk.countAsChunk,
                isMidChunk:        chunk.isMidChunk,
                endsWithParagraph: chunk.endsWithParagraph,
                endsWithSection:   chunk.endsWithSection,
                pauseAfterMs:      chunk.pauseAfterMs,
            });
        }

        // Mark as flushed even if the sentence produced no chunks (skipped)
        if (entry.chunks.length === 0 && nextFlushIndex > lastSentenceGenerated) {
            lastSentenceGenerated = nextFlushIndex;
        }

        reorderBuffer.delete(nextFlushIndex);
        nextFlushIndex++;
    }
}

// ── Worker generation-done tracking ──────────────────────────────────────────

function handleWorkerGenerationDone(workerIndex, payload) {
    if (payload.genId !== currentGenId) return;

    workersDoneCount++;
    console.log(`[offscreen] worker ${workerIndex} generation done (${workersDoneCount}/${activeWorkerCount})`);

    if (workersDoneCount >= activeWorkerCount) {
        generationDone = true;
        notifySW({ type: 'GENERATION_DONE', relayToContent: true });
        console.log('[offscreen] all workers done — generation complete');

        // Save complete audio to IDB cache
        (async () => {
            try {
                if (currentPageUrl) {
                    const chunks = await loadChunks(currentPageUrl);
                    if (chunks.length > 0) {
                        const entries = chunks.map(c => ({
                            data:          c.data,
                            sampleRate:    c.sampleRate,
                            countAsChunk:  c.countAsChunk,
                            sentenceIndex: c.sentenceIndex,
                            pauseAfter:    c.pauseAfter,
                        }));
                        await saveToCache(currentPageUrl, { title: articleTitle, entries });
                        console.log('[offscreen] saved to cache for', currentPageUrl);
                        // Individual chunks + job now redundant
                        clearChunks(currentPageUrl).catch(() => {});
                        deleteGenerationJob(currentPageUrl).catch(() => {});
                    }
                }
            } catch (err) {
                console.error('[offscreen] cache save failed:', err);
            } finally {
                notifySW({ type: 'DOWNLOAD_READY', relayToContent: true });
            }
        })();
    }
}

// ── Sentence assignment (round-robin across workers) ─────────────────────────

/**
 * Split sentences across workers by alternating global index.
 * Worker 0 gets even-indexed sentences, worker 1 gets odd-indexed, etc.
 *
 * @param {Array} sentences - Array of sentence objects
 * @param {number} startIndex - Global start index for these sentences
 * @returns {Array<{ sentences: Array, indices: number[] }>}
 */
function assignSentencesToWorkers(sentences, startIndex) {
    const assignments = workers.map(() => ({ sentences: [], indices: [] }));

    for (let i = 0; i < sentences.length; i++) {
        const globalIndex = startIndex + i;
        const workerIdx   = globalIndex % workers.length;
        assignments[workerIdx].sentences.push(sentences[i]);
        assignments[workerIdx].indices.push(globalIndex);
    }

    return assignments;
}

/**
 * Cancel all workers, reset reorder state, and dispatch sentence slices
 * to each worker via GENERATE_AUDIO with sentenceIndices.
 */
function dispatchToWorkers(sentences, startIndex, voice) {
    const assignments    = assignSentencesToWorkers(sentences, startIndex);
    const totalSentences = startIndex + sentences.length;

    // Reset reorder buffer for the new generation
    reorderBuffer.clear();
    nextFlushIndex    = startIndex;
    activeWorkerCount = 0;
    workersDoneCount  = 0;
    workerAssignments.clear();

    currentGenId++;

    for (let w = 0; w < workers.length; w++) {
        workers[w].postMessage({ type: 'CANCEL' });

        if (assignments[w].sentences.length === 0) continue;

        const msg = {
            type:            'GENERATE_AUDIO',
            sentences:       assignments[w].sentences,
            sentenceIndices: assignments[w].indices,
            totalSentences,
            speed:           currentUserSpeed,
            voice:           voice || currentVoiceName,
            genId:           currentGenId,
        };
        workers[w].postMessage(msg);
        // Record so a crashed worker can be re-dispatched
        workerAssignments.set(w, {
            sentences:       assignments[w].sentences,
            indices:         assignments[w].indices,
            totalSentences,
        });
        activeWorkerCount++;
    }

    console.log(`[offscreen] dispatched ${sentences.length} sentences to ${activeWorkerCount} worker(s) from index ${startIndex}`);
}

// ── Start generation from extraction result ──────────────────────────────────

async function startGeneration(message) {
    console.log('[offscreen] startGeneration() —', message.sentences?.length, 'sentences');

    // Read latest voice + speed from storage
    try {
        if (chrome.storage?.local) {
            const result = await chrome.storage.local.get(['voice', 'speed']);
            if (result.voice) currentVoiceName = result.voice;
            if (result.speed != null) {
                const speed = parseFloat(result.speed);
                if (speed >= 0.5 && speed <= 2.0) currentUserSpeed = speed;
            }
        }
    } catch (_) {}
    console.log('[offscreen] startGeneration voice:', currentVoiceName, 'speed:', currentUserSpeed);

    // Clear previous session data
    const prevUrl = currentPageUrl;
    if (prevUrl) {
        clearChunks(prevUrl).catch(() => {});
        deletePosition(prevUrl).catch(() => {});
        deleteGenerationJob(prevUrl).catch(() => {});
    }

    articleTitle   = message.title   || '';
    currentPageUrl = message.pageUrl ? normUrl(message.pageUrl) : null;
    generationDone = false;
    chunkSaveIndex = 0;
    lastSentenceGenerated = -1;
    allSentences   = message.sentences || [];
    // Clear queue and pending resume so stale work doesn't re-trigger after completion
    pendingExtractionQueue = [];
    pendingResume = null;

    // Persist sentence list for resume after offscreen restart
    if (currentPageUrl && allSentences.length > 0) {
        saveGenerationJob(currentPageUrl, {
            sentences: allSentences, title: articleTitle,
        }).catch(() => {});
    }

    dispatchToWorkers(allSentences, 0, currentVoiceName);

    const title      = articleTitle ? `"\u200B${articleTitle.slice(0, 35)}"` : 'page';
    const turboLabel = workers.length > 1 ? ' (turbo)' : '';
    notifySW({ type: 'STATUS_UPDATE', text: `${message.wordCount} words from ${title} \u2014 generating${turboLabel}\u2026`, relayToContent: true });
}

// ── WAV / Opus export (download from IDB cache) ─────────────────────────────

import { encodeToOpus } from './opus-encoder.js';

function encodeWAV(samples, sampleRate) {
    const numChannels  = 1;
    const bitsPerSample = 16;
    const byteRate     = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign   = numChannels * (bitsPerSample / 8);
    const dataSize     = samples.length * (bitsPerSample / 8);
    const buffer       = new ArrayBuffer(44 + dataSize);
    const view         = new DataView(buffer);

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
    // Load audio from IDB (content script has playback data, but we have IDB)
    let entries = [];
    if (currentPageUrl) {
        const cached = await loadFromCache(currentPageUrl);
        if (cached?.entries?.length > 0) {
            entries = cached.entries;
        } else {
            // Generation might not be fully saved yet — try chunks store
            const chunks = await loadChunks(currentPageUrl);
            entries = chunks;
        }
    }
    if (entries.length === 0) {
        notifySW({ type: 'STATUS_UPDATE', text: 'Nothing to download yet — wait for generation to start', relayToContent: true });
        return;
    }

    // Merge all chunks into one Float32Array
    const allData = entries.map(e => e.data instanceof Float32Array ? e.data : new Float32Array(e.data));
    const totalLen = allData.reduce((sum, d) => sum + d.length, 0);
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const d of allData) {
        merged.set(d, offset);
        offset += d.length;
    }

    const safeName = articleTitle.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 60) || 'audio';

    try {
        console.log(`[offscreen] encoding ${(merged.length / 24000).toFixed(1)}s to Opus\u2026`);
        const opusBuffer = await encodeToOpus(merged, 24000);
        const blob = new Blob([opusBuffer], { type: 'audio/ogg; codecs=opus' });
        const opusUrl = URL.createObjectURL(blob);
        notifySW({ type: 'DOWNLOAD_AUDIO', url: opusUrl, filename: `${safeName}.ogg` });
        setTimeout(() => URL.revokeObjectURL(opusUrl), 60000);
    } catch (err) {
        console.warn('[offscreen] Opus failed, falling back to WAV:', err.message);
        const wavBuffer = encodeWAV(merged, 24000);
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        const wavUrl = URL.createObjectURL(blob);
        notifySW({ type: 'DOWNLOAD_AUDIO', url: wavUrl, filename: `${safeName}.wav` });
        setTimeout(() => URL.revokeObjectURL(wavUrl), 60000);
    }
}

// ── Helper: cancel all workers ───────────────────────────────────────────────

function cancelAllWorkers() {
    for (const worker of workers) {
        worker.postMessage({ type: 'CANCEL' });
    }
    reorderBuffer.clear();
}

// ── Incoming messages ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    console.log('[offscreen] received:', message.type);

    switch (message.type) {
        case 'EXTRACTION_RESULT': {
            if (!allWorkersReady || workers.length === 0) {
                // Queue the message — MODEL_READY will start the most-recent entry
                pendingExtractionQueue.push(message);
                notifySW({ type: 'STATUS_UPDATE', text: 'Loading model\u2026 (text ready)', relayToContent: true, relayToOnboarding: true });
                notifySW({ type: 'PLAYBACK_STATE', state: 'loading', relayToContent: true });
                return false;
            }
            startGeneration(message);
            return false;
        }

        case 'SWITCH_VOICE': {
            currentVoiceName = message.voice;
            if (allWorkersReady) {
                for (const worker of workers) {
                    worker.postMessage({ type: 'SWITCH_VOICE', voice: message.voice });
                }
            }
            return false;
        }

        case 'WIDGET_ACTION': {
            // Content script broadcasts reach offscreen directly
            if (message.action === 'SWITCH_VOICE') {
                // Simple voice switch (not mid-generation) — update preference only
                currentVoiceName = message.voice;
                if (allWorkersReady) {
                    for (const worker of workers) {
                        worker.postMessage({ type: 'SWITCH_VOICE', voice: message.voice });
                    }
                }
            } else if (message.action === 'SET_SPEED') {
                currentUserSpeed = message.speed;
            } else if (message.action === 'VOICE_SWITCH_RESTART') {
                // Mid-generation voice switch: cancel all workers, clear IDB chunks,
                // reload the saved job, and restart from fromSentenceIndex with new voice.
                const { voice, fromSentenceIndex } = message;
                console.log('[offscreen] VOICE_SWITCH_RESTART: voice=', voice, 'from=', fromSentenceIndex);

                currentVoiceName = voice;

                (async () => {
                    try {
                        // Prefer in-memory sentence list; fall back to IDB job
                        const job = allSentences.length > 0
                            ? { sentences: allSentences }
                            : await loadGenerationJob(currentPageUrl);

                        if (!job?.sentences?.length) {
                            console.warn('[offscreen] VOICE_SWITCH_RESTART: no saved job');
                            return;
                        }

                        cancelAllWorkers();

                        // Clear old-voice chunks from IDB so the cache won't be mixed
                        await clearChunks(currentPageUrl);
                        chunkSaveIndex        = 0;
                        lastSentenceGenerated = fromSentenceIndex - 1;
                        generationDone        = false;

                        // Re-persist the job (clearChunks doesn't touch jobs store)
                        await saveGenerationJob(currentPageUrl, job).catch(() => {});

                        const remainingSentences = job.sentences.slice(fromSentenceIndex);
                        dispatchToWorkers(remainingSentences, fromSentenceIndex, voice);

                        notifySW({ type: 'STATUS_UPDATE', text: 'Switching voice\u2026', relayToContent: true });
                    } catch (err) {
                        console.error('[offscreen] VOICE_SWITCH_RESTART error:', err);
                    }
                })();
            }
            return false;
        }

        case 'SET_SPEED': {
            currentUserSpeed = message.speed;
            return false;
        }

        case 'STOP':
        case 'CANCEL_ALL': {
            cancelAllWorkers();
            generationDone = true;
            return false;
        }

        case 'PAGE_UNLOAD': {
            // Tab was refreshed or navigated — cancel generation and clear any
            // incomplete chunks so stale data doesn't persist across page loads.
            const unloadUrl = message.url ? normUrl(message.url) : currentPageUrl;
            cancelAllWorkers();
            generationDone = true;
            if (unloadUrl) {
                clearChunks(unloadUrl).catch(() => {});
                deleteGenerationJob(unloadUrl).catch(() => {});
            }
            return false;
        }

        case 'CLOSE_WIDGET': {
            // Cancel generation — stop all workers from producing more chunks
            cancelAllWorkers();
            generationDone = true;

            // Save position from content script's reported pauseTime
            if (currentPageUrl && message.pausedAtTime != null) {
                savePosition(currentPageUrl, {
                    position: message.pausedAtTime,
                    generationComplete: false, // partial — not all sentences done
                    title: articleTitle,
                }).catch(() => {});
            }
            return false;
        }

        case 'SAVE_POSITION': {
            if (currentPageUrl && message.position != null) {
                savePosition(currentPageUrl, {
                    position: message.position,
                    generationComplete: generationDone,
                    title: articleTitle,
                }).catch(() => {});
            }
            return false;
        }

        case 'REQUEST_DOWNLOAD': {
            handleDownloadRequest();
            return false;
        }

        case 'QUERY_CACHE': {
            (async () => {
                // Check if we're currently generating for this URL
                const urlMatches = !message.url || !currentPageUrl ||
                    normUrl(message.url) === currentPageUrl;
                // Include allSentences.length > 0 so we catch the first ~3s of generation
                // before any SENTENCE_COMPLETE has fired (lastSentenceGenerated is still -1).
                const isGenerating = !generationDone && workers.length > 0 && urlMatches
                    && (lastSentenceGenerated >= 0 || allSentences.length > 0);

                if (isGenerating) {
                    sendResponse({ hit: false, hasAudio: false, generating: true });
                    return;
                }
                try {
                    const hit = await checkCacheExists(message.url);
                    sendResponse({ hit, hasAudio: false, generating: false });
                } catch (_) {
                    sendResponse({ hit: false, hasAudio: false, generating: false });
                }
            })();
            return true; // async sendResponse
        }

        case 'LOAD_FROM_CACHE': {
            (async () => {
                try {
                    const cached = await loadFromCache(message.url);
                    if (!cached || cached.entries.length === 0) {
                        console.warn('[offscreen] LOAD_FROM_CACHE: miss for', message.url);
                        notifySW({ type: 'CACHE_MISS', relayToContent: true });
                        return;
                    }

                    currentPageUrl = normUrl(message.url);
                    articleTitle   = cached.title;
                    generationDone = true;

                    // Load saved position
                    const savedPos = await loadPosition(message.url);
                    const resumeAt = savedPos?.position ?? 0;

                    // Stream entries one-by-one to avoid Chrome's 64MiB per-message limit.
                    notifySW({
                        type:           'CACHE_LOAD_START',
                        count:          cached.entries.length,
                        title:          cached.title,
                        resumePosition: resumeAt,
                        relayToContent: true,
                    });

                    for (const entry of cached.entries) {
                        const floatData = entry.data instanceof Float32Array ? entry.data
                            : new Float32Array(entry.data);

                        notifySW({
                            type:          'CACHE_LOAD_CHUNK',
                            data:          Array.from(floatData),
                            sampleRate:    entry.sampleRate,
                            countAsChunk:  entry.countAsChunk,
                            sentenceIndex: entry.sentenceIndex,
                            pauseAfter:    entry.pauseAfter,
                            relayToContent: true,
                        });
                    }

                    notifySW({ type: 'CACHE_LOAD_DONE', relayToContent: true });
                    notifySW({ type: 'DOWNLOAD_READY', relayToContent: true });
                    console.log(`[offscreen] LOAD_FROM_CACHE: streamed ${cached.entries.length} chunks`);
                } catch (err) {
                    console.error('[offscreen] LOAD_FROM_CACHE error:', err);
                    notifySW({ type: 'CACHE_MISS', relayToContent: true });
                }
            })();
            return false;
        }

        case 'RESUME_GENERATION': {
            // Offscreen was restarted — resume generating remaining sentences
            (async () => {
                try {
                    const url = message.url;
                    currentPageUrl = normUrl(url);

                    const job = await loadGenerationJob(url);
                    if (!job?.sentences?.length) {
                        console.log('[offscreen] RESUME_GENERATION: no job found for', url);
                        return;
                    }

                    articleTitle  = job.title || '';
                    allSentences = job.sentences;

                    // Find last generated sentence from IDB chunks
                    const chunks = await loadChunks(url);
                    const lastIdx = chunks.reduce(
                        (max, c) => c.sentenceIndex != null ? Math.max(max, c.sentenceIndex) : max, -1);
                    const resumeFrom = lastIdx + 1;
                    chunkSaveIndex = chunks.length;
                    lastSentenceGenerated = lastIdx;
                    generationDone = false;

                    // ── Resend any chunks that are in IDB but weren't received by the content script.
                    // This closes the gap when offscreen was killed after writing to IDB but before
                    // the AUDIO_CHUNK_READY message was sent.
                    const contentLastIdx = message.contentLastSentenceIndex ?? -1;
                    if (contentLastIdx < lastIdx) {
                        const gapChunks = chunks.filter(
                            c => c.sentenceIndex != null && c.sentenceIndex > contentLastIdx
                        );
                        console.log(`[offscreen] RESUME_GENERATION: resending ${gapChunks.length} IDB gap chunks (IDB max=${lastIdx}, content max=${contentLastIdx})`);
                        for (const gapChunk of gapChunks) {
                            const floatData = gapChunk.data instanceof Float32Array
                                ? gapChunk.data
                                : new Float32Array(gapChunk.data);
                            notifySW({
                                type:              'AUDIO_CHUNK_READY',
                                relayToContent:    true,
                                samples:           Array.from(floatData),
                                sampleRate:        gapChunk.sampleRate,
                                sentenceIndex:     gapChunk.sentenceIndex,
                                total:             job.sentences.length,
                                countAsChunk:      gapChunk.countAsChunk,
                                isMidChunk:        false,
                                endsWithParagraph: false,
                                endsWithSection:   false,
                                pauseAfterMs:      (gapChunk.pauseAfter ?? PAUSE_SENTENCE) * 1000,
                            });
                        }
                    }

                    if (resumeFrom >= job.sentences.length) {
                        console.log('[offscreen] RESUME_GENERATION: all sentences already generated');
                        generationDone = true;
                        notifySW({ type: 'GENERATION_DONE', relayToContent: true });
                        return;
                    }

                    const resumeSentences = job.sentences.slice(resumeFrom);
                    console.log(`[offscreen] RESUME_GENERATION: from sentence ${resumeFrom}/${job.sentences.length}`);

                    const doResume = () => {
                        dispatchToWorkers(resumeSentences, resumeFrom, currentVoiceName);
                    };

                    if (allWorkersReady) {
                        doResume();
                    } else {
                        pendingResume = doResume;
                    }
                } catch (err) {
                    console.error('[offscreen] RESUME_GENERATION error:', err);
                }
            })();
            return false;
        }

        case 'CHECK_ALIVE': {
            // SW pings offscreen to verify it's alive
            sendResponse({ alive: true, modelReady: allWorkersReady, generating: !generationDone });
            return true;
        }
    }

    return false;
});

// ── Preferences & Init ───────────────────────────────────────────────────────

async function loadPreferences() {
    try {
        if (!chrome.storage?.local) return 'af_aoede';
        const result = await chrome.storage.local.get(['voice', 'speed', 'turboMode']);
        if (result.speed != null) {
            const speed = parseFloat(result.speed);
            if (speed >= 0.5 && speed <= 2.0) currentUserSpeed = speed;
        }
        // Turbo mode defaults to true — user can disable via storage
        turboMode = result.turboMode !== false;
        return result.voice || 'af_aoede';
    } catch (_) {
        return 'af_aoede';
    }
}

(async () => {
    console.log('[offscreen] initializing...');
    const voice = await loadPreferences();
    currentVoiceName = voice;
    console.log('[offscreen] loaded prefs, voice:', voice, 'speed:', currentUserSpeed, 'turbo:', turboMode);
    initWorkers(voice);
    clearExpired().catch(() => {});
    notifySW({ type: 'OFFSCREEN_READY' });
})();
