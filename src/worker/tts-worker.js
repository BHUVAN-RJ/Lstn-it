// tts-worker.js — Phase 5: tokenization + ONNX inference
//
// NOTE: chrome.* APIs are NOT available in dedicated Web Workers created from
// extension pages. All extension URLs must be passed via postMessage from popup.js.

import * as ort from 'onnxruntime-web';
import { phonemize } from 'phonemizer';
import { normalizeForKokoro } from './phoneme-normalizer.js';
import { tokenize } from './tokenizer.js';

// ── ort environment — set at module level, before InferenceSession.create() ──
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

// ── State ─────────────────────────────────────────────────────────────────────
let session = null;       // ort.InferenceSession
let voiceData = null;     // Float32Array (510 × 256) for the active voice
let activeVoice = null;   // e.g. 'af_heart'
let voiceBaseUrl = null;  // set from LOAD_MODEL payload

// Detected at session creation time — varies between model export versions
let inputIdsName  = 'input_ids'; // 'input_ids' (v1.0+) or 'tokens' (older)
let audioOutName  = 'audio';     // first output name

// Cancellation: incremented by CANCEL message or start of each new generateAudio.
// A running generation captures `myId = cancelId` at start; if cancelId !== myId
// at any subsequent check the generation exits immediately.
let cancelId = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function post(msg, transfer) {
    transfer ? self.postMessage(msg, transfer) : self.postMessage(msg);
}
function postError(code, detail) { post({ type: 'ERROR', code, detail }); }

/**
 * Select the style (voice embedding) row for a given full token sequence length.
 * voiceData layout: 510 rows × 256 floats, indexed by len([0, ...tokens, 0]).
 */
function getStyleVector(tokenCount) {
    const idx = Math.min(tokenCount, 509);
    return voiceData.slice(idx * 256, idx * 256 + 256);
}

// ── Long-phoneme handling ─────────────────────────────────────────────────────

// Phoneme length threshold: sentences longer than this get split into exactly
// two parts so the model never hard-truncates mid-sentence.
const PHONEME_SPLIT_THRESHOLD = 500;

/**
 * If `phonemes` exceeds PHONEME_SPLIT_THRESHOLD, split into exactly two parts:
 *   [0] — up to threshold chars, cut at the last IPA word-boundary space
 *   [1] — the remainder (counted as overflow, invisible to the chunksAhead counter)
 *
 * Sentences that fit within the threshold are returned as a single-element array.
 *
 * @param {string} phonemes
 * @returns {string[]}  1 or 2 elements
 */
function splitLongSentence(phonemes) {
    if (phonemes.length <= PHONEME_SPLIT_THRESHOLD) return [phonemes];
    let cut = phonemes.lastIndexOf(' ', PHONEME_SPLIT_THRESHOLD);
    if (cut <= 0) cut = PHONEME_SPLIT_THRESHOLD; // no space — hard cut
    return [phonemes.slice(0, cut).trim(), phonemes.slice(cut).trim()];
}

// ── Phonemization ─────────────────────────────────────────────────────────────

async function phonemizeSentence(text) {
    const raw = await phonemize(text, 'en-us');
    const joined = Array.isArray(raw) ? raw.join(' ') : raw;
    return normalizeForKokoro(joined);
}

// ── Model loading ──────────────────────────────────────────────────────────────

async function loadModel({ voice, wasmPaths, modelUrl, voiceBaseUrl: vbu }) {
    voiceBaseUrl = vbu;

    post({ type: 'LOADING_PROGRESS', stage: 'wasm', pct: 0 });
    ort.env.wasm.wasmPaths = wasmPaths;

    post({ type: 'LOADING_PROGRESS', stage: 'model', pct: 5 });
    console.log('[tts-worker] loading model from', modelUrl);

    const modelBuffer = await fetchWithProgress(modelUrl, (pct) => {
        post({ type: 'LOADING_PROGRESS', stage: 'model', pct: 5 + pct * 75 });
    });

    post({ type: 'LOADING_PROGRESS', stage: 'model', pct: 82 });

    session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['wasm'],
    });

    // Detect input/output names — differs between kokoro-onnx export versions
    inputIdsName = session.inputNames.includes('input_ids') ? 'input_ids' : 'tokens';
    audioOutName = session.outputNames[0];
    console.log('[tts-worker] ONNX session created');
    console.log('[tts-worker] inputs:', session.inputNames, '→ using', inputIdsName);
    console.log('[tts-worker] outputs:', session.outputNames, '→ using', audioOutName);

    post({ type: 'LOADING_PROGRESS', stage: 'voice', pct: 85 });
    await loadVoice(voice);

    post({ type: 'LOADING_PROGRESS', stage: 'done', pct: 100 });
    post({ type: 'MODEL_READY', voice: activeVoice });
    console.log('[tts-worker] ready, voice =', activeVoice);
}

async function loadVoice(voiceName) {
    const url = voiceBaseUrl + voiceName + '.bin';
    console.log('[tts-worker] loading voice', voiceName, 'from', url);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Voice file not found: ${voiceName} (${response.status})`);

    const buffer = await response.arrayBuffer();
    voiceData = new Float32Array(buffer);
    activeVoice = voiceName;

    if (voiceData.length !== 510 * 256) {
        throw new Error(`Unexpected voice file size: ${voiceData.length} floats (expected ${510 * 256})`);
    }
}

async function fetchWithProgress(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);

    const contentLength = response.headers.get('Content-Length');
    if (!contentLength) {
        onProgress(0.5);
        const buffer = await response.arrayBuffer();
        onProgress(1);
        return buffer;
    }

    const total = parseInt(contentLength, 10);
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress(received / total);
    }

    const combined = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }
    return combined.buffer;
}

// ── Inference ──────────────────────────────────────────────────────────────────

/**
 * Run ONNX inference for a single token sequence.
 *
 * @param {number[]} tokenIds - Full token array: [0, ...inner, 0]
 * @param {number}   speed    - Playback speed multiplier (1.0 = normal)
 * @returns {Float32Array|null}  Raw audio samples at 24 kHz, or null on error
 */
async function runInference(tokenIds, speed = 1.0) {
    if (!session || !voiceData) {
        postError('MODEL_NOT_READY', 'Model has not been loaded yet.');
        return null;
    }

    const styleVector = getStyleVector(tokenIds.length);

    const feeds = {
        [inputIdsName]: new ort.Tensor('int64',
            BigInt64Array.from(tokenIds.map(BigInt)),
            [1, tokenIds.length]),
        style: new ort.Tensor('float32', styleVector, [1, 256]),
        speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
    };

    const results = await session.run(feeds);
    const output = results[audioOutName];
    if (!output) {
        throw new Error(`Output "${audioOutName}" not found. Available: ${Object.keys(results).join(', ')}`);
    }

    // output.data is a Float32Array of raw PCM samples at 24 kHz
    return output.data instanceof Float32Array
        ? output.data
        : new Float32Array(output.data);
}

// ── Full audio generation pipeline ────────────────────────────────────────────

/**
 * For each sentence: phonemize → chunk → tokenize → infer → post AUDIO_CHUNK.
 *
 * Cancellation: each call increments the shared `cancelId` counter and captures
 * its own value as `myId`. If `cancelId !== myId` at any await checkpoint the
 * generation exits silently — either because a CANCEL message was received or
 * because a newer GENERATE_AUDIO superseded this one.
 *
 * @param {Array<{text: string, endsWithParagraph: boolean, endsWithSection: boolean}>} sentences
 * @param {number} speed
 * @param {number} genId  - opaque ID echoed back in every AUDIO_CHUNK / GENERATION_DONE
 */
async function generateAudio({ sentences, speed = 1.0, genId = 0 }) {
    if (!session || !voiceData) {
        postError('MODEL_NOT_READY', 'Load the model first.');
        return;
    }

    // Claim a new generation slot — invalidates any still-running previous generation.
    cancelId++;
    const myId = cancelId;

    const total = sentences.length;

    for (let i = 0; i < sentences.length; i++) {
        if (cancelId !== myId) return; // cancelled / superseded

        const { text, endsWithParagraph, endsWithSection = false } = sentences[i];

        // 1. Phonemize
        const phonemes = await phonemizeSentence(text);
        if (cancelId !== myId) return;

        console.log(`[tts-worker] [${i + 1}/${total}] phonemes (${phonemes.length} chars): "${phonemes.slice(0, 80)}${phonemes.length > 80 ? '…' : ''}"`);
        post({ type: 'PHONEMES_READY', index: i, total, text, phonemes });

        // 2. Split sentences that exceed the phoneme threshold into exactly two parts.
        //    Part 1 (main): counts as one unit toward the chunksAhead buffer counter.
        //    Part 2 (overflow): plays seamlessly after part 1; invisible to the counter.
        const parts = splitLongSentence(phonemes);
        if (parts.length > 1) {
            console.log(`[tts-worker] [${i + 1}/${total}] long sentence split into 2 phoneme parts`);
        }

        for (let pi = 0; pi < parts.length; pi++) {
            if (cancelId !== myId) return;

            const isLastPart  = pi === parts.length - 1;
            // Part 1 is the "main" chunk — it counts toward the playback buffer.
            // Part 2 (overflow) does not; it is an invisible tail of the same sentence.
            const countAsChunk = pi === 0;

            // 3. Tokenize
            const tokenIds = tokenize(parts[pi]);
            if (tokenIds.length <= 2) {
                console.warn(`[tts-worker] skipping part ${pi + 1}/${parts.length} of sentence ${i + 1}: no tokens`);
                continue;
            }

            // 4. Infer
            const samples = await runInference(tokenIds, speed);
            if (cancelId !== myId) return;
            if (!samples) continue;

            console.log(`[tts-worker] [${i + 1}/${total}] part ${pi + 1}/${parts.length}: ${samples.length} samples (${(samples.length / 24000).toFixed(2)}s)`);

            // 5. Transfer samples buffer to popup (zero-copy).
            //    Only the last part carries the sentence-boundary pause metadata.
            //    Part 1 of a split sentence has isMidChunk=true (0ms gap before part 2).
            const samplesCopy = new Float32Array(samples);
            post(
                {
                    type: 'AUDIO_CHUNK',
                    index: i,
                    total,
                    samples: samplesCopy,
                    sampleRate: 24000,
                    endsWithParagraph: isLastPart ? endsWithParagraph : false,
                    endsWithSection:   isLastPart ? endsWithSection   : false,
                    isMidChunk:   !isLastPart,   // true only for part 1 of a 2-part sentence
                    countAsChunk,                // false for overflow part — skip chunksAhead
                    genId,
                },
                [samplesCopy.buffer]
            );
        }
    }

    if (cancelId === myId) {
        post({ type: 'GENERATION_DONE', total, genId });
    }
}

// ── Message handler ────────────────────────────────────────────────────────────

self.onmessage = async (event) => {
    const { type, ...payload } = event.data;
    console.log('[tts-worker] received:', type);

    try {
        switch (type) {
            case 'LOAD_MODEL':
                await loadModel(payload);
                break;
            case 'SWITCH_VOICE':
                await loadVoice(payload.voice);
                post({ type: 'VOICE_READY', voice: activeVoice });
                break;
            case 'CANCEL':
                // Increment the shared counter — any in-progress generateAudio loop
                // will see cancelId !== myId at its next checkpoint and exit.
                cancelId++;
                console.log('[tts-worker] CANCEL received — cancelId now', cancelId);
                break;
            case 'GENERATE_AUDIO':
                await generateAudio(payload);
                break;
            default:
                console.warn('[tts-worker] unknown message type:', type);
        }
    } catch (err) {
        console.error('[tts-worker] error handling', type, err);
        postError('WORKER_ERROR', err.message);
    }
};
