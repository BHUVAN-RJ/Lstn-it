// offscreen.js — TTS generation engine (no audio playback)
//
// Hosts the TTS Web Worker, manages model lifecycle, writes chunks to IndexedDB,
// and forwards generated audio to the content script (via SW relay) for playback.
// All AudioContext / playback code has been moved to content/audio-player.js.

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
let ttsWorker        = null;
let modelReady       = false;
let currentVoiceName = null;

// ── Generation state ─────────────────────────────────────────────────────────
let currentGenId          = 0;
let currentPageUrl        = null;
let articleTitle          = '';
let generationDone        = false;
let chunkSaveIndex        = 0;
let lastSentenceGenerated = -1;
let currentUserSpeed      = 1.0;

// Pending extraction queue — holds messages that arrived before the model was ready.
// On MODEL_READY the most-recent entry is started and earlier ones are discarded.
let pendingExtractionQueue = [];
// Deferred generation resume — queued while model is still loading after restart
let pendingResume = null;

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

function initWorker(voice) {
    const workerUrl = chrome.runtime.getURL('tts-worker.js');
    ttsWorker = new Worker(workerUrl);

    ttsWorker.onmessage = (event) => {
        const { type, ...payload } = event.data;

        switch (type) {
            case 'LOADING_PROGRESS':
                notifySW({ type: 'STATUS_UPDATE', text: STAGE_LABELS[payload.stage] ?? 'Loading\u2026', relayToContent: true, relayToOnboarding: true });
                notifySW({ type: 'PROGRESS_UPDATE', pct: payload.pct, relayToContent: true, relayToOnboarding: true });
                notifySW({ type: 'PLAYBACK_STATE', state: 'loading', relayToContent: true });
                break;

            case 'MODEL_READY':
                modelReady = true;
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
                break;

            case 'PHONEMES_READY':
                console.log(`[offscreen] phonemes [${payload.index + 1}/${payload.total}]: "${payload.phonemes}"`);
                break;

            case 'AUDIO_CHUNK': {
                const { genId, index, total, samples, sampleRate,
                        endsWithParagraph, endsWithSection, isMidChunk,
                        countAsChunk, pauseAfterMs } = payload;
                if (genId !== currentGenId) {
                    console.log(`[offscreen] dropping stale chunk (genId ${genId} \u2260 ${currentGenId})`);
                    break;
                }
                console.log(`[offscreen] audio chunk ${index + 1}/${total}: ${samples.length} samples (${(samples.length / sampleRate).toFixed(2)}s)`);

                // Track highest sentence index for resume
                if (!isMidChunk && index > lastSentenceGenerated) {
                    lastSentenceGenerated = index;
                }

                // Calculate pause for IDB entry
                const pause = pauseAfterMs !== undefined
                    ? pauseAfterMs / 1000
                    : isMidChunk        ? 0
                    : endsWithSection   ? PAUSE_SECTION
                    : endsWithParagraph ? PAUSE_PARAGRAPH
                    : PAUSE_SENTENCE;

                // Persist chunk to IndexedDB (survives offscreen termination)
                if (currentPageUrl) {
                    const idx = chunkSaveIndex++;
                    const buf = samples.buffer.slice(
                        samples.byteOffset,
                        samples.byteOffset + samples.byteLength
                    );
                    appendChunk(currentPageUrl, idx, {
                        data: buf, sampleRate, countAsChunk,
                        sentenceIndex: index, pauseAfter: pause,
                    }).catch(() => {});
                }

                // Forward audio data to content script via SW relay.
                // Convert Float32Array → regular Array for chrome messaging
                // (typed arrays don't survive JSON serialization in extension APIs).
                notifySW({
                    type:              'AUDIO_CHUNK_READY',
                    relayToContent:    true,
                    samples:           Array.from(samples),
                    sampleRate,
                    sentenceIndex:     index,
                    total,
                    countAsChunk,
                    isMidChunk,
                    endsWithParagraph,
                    endsWithSection,
                    pauseAfterMs,
                });
                break;
            }

            case 'GENERATION_DONE':
                if (payload.genId !== currentGenId) break;
                generationDone = true;
                notifySW({ type: 'GENERATION_DONE', relayToContent: true });
                console.log(`[offscreen] all ${payload.total} sentences generated`);
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
                break;

            case 'VOICE_READY':
                console.log('[offscreen] voice switched to', payload.voice);
                notifySW({ type: 'VOICE_READY', voice: payload.voice, relayToContent: true });
                break;

            case 'DOWNLOAD_FAILED':
                console.error('[offscreen] model download failed:', payload.detail);
                notifySW({ type: 'ERROR', code: 'WORKER_ERROR', detail: payload.detail || 'Model download failed', relayToContent: true });
                break;

            case 'ERROR':
                console.error('[offscreen] worker error:', payload.code, payload.detail);
                notifySW({ type: 'ERROR', code: payload.code, detail: payload.detail, relayToContent: true });
                break;

            default:
                console.log('[offscreen] worker message:', type, payload);
        }
    };

    ttsWorker.onerror = (err) => {
        console.error('[offscreen] worker crash:', err.message);
        notifySW({ type: 'ERROR', code: 'WORKER_CRASHED', detail: err.message || 'Worker crashed' });
        ttsWorker = null;
        modelReady = false;
        initWorker(currentVoiceName);
    };

    ttsWorker.onmessageerror = (err) => {
        console.error('[offscreen] worker message deserialise error:', err);
    };

    notifySW({ type: 'STATUS_UPDATE', text: 'Loading model\u2026', relayToContent: true, relayToOnboarding: true });
    notifySW({ type: 'PLAYBACK_STATE', state: 'loading', relayToContent: true });
    ttsWorker.postMessage({
        type:               'LOAD_MODEL',
        voice,
        wasmPaths:          chrome.runtime.getURL('wasm/'),
        remoteModelUrl:     HF_MODEL_URL,
        remoteVoiceBaseUrl: HF_VOICE_BASE_URL,
        modelUrl:           chrome.runtime.getURL('models/kokoro-v1.0.onnx'),
        voiceBaseUrl:       chrome.runtime.getURL('models/voices/'),
    });
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
    // Clear queue and pending resume so stale work doesn't re-trigger after completion
    pendingExtractionQueue = [];
    pendingResume = null;

    // Persist sentence list for resume after offscreen restart
    if (currentPageUrl && message.sentences?.length > 0) {
        saveGenerationJob(currentPageUrl, {
            sentences: message.sentences, title: articleTitle,
        }).catch(() => {});
    }

    currentGenId++;
    ttsWorker.postMessage({ type: 'CANCEL' });
    ttsWorker.postMessage({
        type:      'GENERATE_AUDIO',
        sentences: message.sentences,
        speed:     currentUserSpeed,
        voice:     currentVoiceName,
        genId:     currentGenId,
    });

    const title = articleTitle ? `"\u200B${articleTitle.slice(0, 35)}"` : 'page';
    notifySW({ type: 'STATUS_UPDATE', text: `${message.wordCount} words from ${title} \u2014 generating\u2026`, relayToContent: true });
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
    if (entries.length === 0) return;

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

// ── Incoming messages ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    console.log('[offscreen] received:', message.type);

    switch (message.type) {
        case 'EXTRACTION_RESULT': {
            if (!modelReady || !ttsWorker) {
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
            if (ttsWorker && modelReady) {
                ttsWorker.postMessage({ type: 'SWITCH_VOICE', voice: message.voice });
            }
            return false;
        }

        case 'WIDGET_ACTION': {
            // Content script broadcasts reach offscreen directly
            if (message.action === 'SWITCH_VOICE') {
                // Simple voice switch (not mid-generation) — update preference only
                currentVoiceName = message.voice;
                if (ttsWorker && modelReady) {
                    ttsWorker.postMessage({ type: 'SWITCH_VOICE', voice: message.voice });
                }
            } else if (message.action === 'SET_SPEED') {
                currentUserSpeed = message.speed;
            } else if (message.action === 'VOICE_SWITCH_RESTART') {
                // Mid-generation voice switch: cancel current generation, clear IDB chunks,
                // reload the saved job, and restart from fromSentenceIndex with new voice.
                const { voice, fromSentenceIndex } = message;
                console.log('[offscreen] VOICE_SWITCH_RESTART: voice=', voice, 'from=', fromSentenceIndex);

                currentVoiceName = voice;
                currentGenId++;
                ttsWorker.postMessage({ type: 'CANCEL' });

                (async () => {
                    try {
                        const job = await loadGenerationJob(currentPageUrl);
                        if (!job?.sentences?.length) {
                            console.warn('[offscreen] VOICE_SWITCH_RESTART: no saved job');
                            return;
                        }
                        // Clear old-voice chunks from IDB so the cache won't be mixed
                        await clearChunks(currentPageUrl);
                        chunkSaveIndex        = 0;
                        lastSentenceGenerated = fromSentenceIndex - 1;
                        generationDone        = false;

                        // Re-persist the job (clearChunks doesn't touch jobs store)
                        await saveGenerationJob(currentPageUrl, job).catch(() => {});

                        currentGenId++;
                        ttsWorker.postMessage({
                            type:        'GENERATE_AUDIO',
                            sentences:   job.sentences.slice(fromSentenceIndex),
                            speed:       currentUserSpeed,
                            voice,
                            genId:       currentGenId,
                            indexOffset: fromSentenceIndex,
                        });
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
            if (ttsWorker) ttsWorker.postMessage({ type: 'CANCEL' });
            generationDone = true;
            return false;
        }

        case 'PAGE_UNLOAD': {
            // Tab was refreshed or navigated — cancel generation and clear any
            // incomplete chunks so stale data doesn't persist across page loads.
            const unloadUrl = message.url ? normUrl(message.url) : currentPageUrl;
            if (ttsWorker) ttsWorker.postMessage({ type: 'CANCEL' });
            generationDone = true;
            if (unloadUrl) {
                clearChunks(unloadUrl).catch(() => {});
                deleteGenerationJob(unloadUrl).catch(() => {});
            }
            return false;
        }

        case 'CLOSE_WIDGET': {
            // Cancel generation — stop the worker from producing more chunks
            if (ttsWorker) ttsWorker.postMessage({ type: 'CANCEL' });
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
                const isGenerating = !generationDone && ttsWorker && urlMatches && lastSentenceGenerated >= 0;

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
                    // A full-length article can easily have 100–300 MB of audio in total.
                    // Each individual chunk is ~500 KB — well within the limit.
                    notifySW({
                        type:           'CACHE_LOAD_START',
                        count:          cached.entries.length,
                        title:          cached.title,
                        resumePosition: resumeAt,
                        relayToContent: true,
                    });

                    for (const entry of cached.entries) {
                        // entry.data is an ArrayBuffer (decompressed from Int16 by loadFromCache)
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

                    articleTitle = job.title || '';

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
                        currentGenId++;
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
            sendResponse({ alive: true, modelReady, generating: !generationDone });
            return true;
        }
    }

    return false;
});

// ── Preferences & Init ───────────────────────────────────────────────────────

async function loadPreferences() {
    try {
        if (!chrome.storage?.local) return 'af_aoede';
        const result = await chrome.storage.local.get(['voice', 'speed']);
        if (result.speed != null) {
            const speed = parseFloat(result.speed);
            if (speed >= 0.5 && speed <= 2.0) currentUserSpeed = speed;
        }
        return result.voice || 'af_aoede';
    } catch (_) {
        return 'af_aoede';
    }
}

(async () => {
    console.log('[offscreen] initializing...');
    const voice = await loadPreferences();
    currentVoiceName = voice;
    console.log('[offscreen] loaded prefs, voice:', voice, 'speed:', currentUserSpeed);
    initWorker(voice);
    clearExpired().catch(() => {});
    notifySW({ type: 'OFFSCREEN_READY' });
})();
