// tts-worker.js — Phase 5: tokenization + ONNX inference
//
// NOTE: chrome.* APIs are NOT available in dedicated Web Workers created from
// extension pages. All extension URLs must be passed via postMessage from popup.js.

import * as ort from 'onnxruntime-web';
import { phonemize } from 'phonemizer';
import { normalizeForKokoro } from './phoneme-normalizer.js';
import { tokenize } from './tokenizer.js';
import { applyPronunciationMap } from './pronunciation-map.js';

// ── ort environment — set at module level, before InferenceSession.create() ──
// numThreads fixed at 1 — MV3 rejects blob: in worker-src CSP, which ORT Web
// requires to spawn threaded sub-workers. Threading is permanently unavailable.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

// ── State ─────────────────────────────────────────────────────────────────────
let session = null;           // ort.InferenceSession
let voiceData = null;         // Float32Array (510 × 256) for the active voice
let activeVoice = null;       // e.g. 'af_heart'
let voiceBaseUrl = null;      // local fallback URL (extension bundle, dev only)
let remoteVoiceBaseUrl = null; // Hugging Face base URL for voice .bin files

// ── OPFS (Origin Private File System) — persistent model/voice cache ──────────
// Downloaded files are stored here so they survive extension restarts without
// re-downloading. OPFS is available in dedicated Web Workers from extension pages.

async function opfsFileExists(filename) {
    try {
        const root = await navigator.storage.getDirectory();
        await root.getFileHandle(filename);
        return true;
    } catch { return false; }
}

/** Get the size of an existing OPFS file (0 if not found). */
async function opfsFileSize(filename) {
    try {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(filename);
        const file = await handle.getFile();
        return file.size;
    } catch { return 0; }
}

async function loadFromOpfs(filename) {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(filename);
    const file = await handle.getFile();
    return file.arrayBuffer();
}

async function saveToOpfs(filename, buffer) {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(buffer);
    await writable.close();
}

async function deleteFromOpfs(filename) {
    try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(filename);
    } catch { /* not found — ignore */ }
}

// Detected at session creation time — varies between model export versions
let inputIdsName  = 'input_ids'; // 'input_ids' (v1.0+) or 'tokens' (older)
let audioOutName  = 'audio';     // first output name
let modelHasSpeed = false;       // true if the ONNX model has a 'speed' input

// Cancellation: incremented by CANCEL message or start of each new generateAudio.
// A running generation captures `myId = cancelId` at start; if cancelId !== myId
// at any subsequent check the generation exits immediately.
let cancelId = 0;

// Mid-generation voice switching: SWITCH_VOICE sets this flag instead of loading
// immediately (because the onmessage macrotask can't run while generateAudio's
// microtask chain is active). generateAudio yields to the macrotask queue between
// sentences and picks up the pending voice.
let pendingVoice = null;
let isGenerating = false;

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

// ── Number / year expansion (moved from text-cleaner.js) ─────────────────────
//
// Keeping this in the worker (rather than text-cleaner) means sentence text
// remains in its original form all the way to the highlight-injector, so
// DOM position searches succeed even when text contains years like "2025".

const _ONES = [
    '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen',
];
const _TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const _DECADE_S = {
    'ten': 'tens', 'twenty': 'twenties', 'thirty': 'thirties', 'forty': 'forties',
    'fifty': 'fifties', 'sixty': 'sixties', 'seventy': 'seventies',
    'eighty': 'eighties', 'ninety': 'nineties',
};

function _twoDigit(n) {
    if (n <= 0)  return '';
    if (n < 20)  return _ONES[n];
    const t = Math.floor(n / 10), o = n % 10;
    return o === 0 ? _TENS[t] : `${_TENS[t]}-${_ONES[o]}`;
}

function _yearToWords(y, hasSuffix) {
    const high = Math.floor(y / 100);
    const low  = y % 100;
    let words;
    if (y === 2000) {
        return hasSuffix ? 'two thousands' : 'two thousand';
    } else if (y >= 2001 && y <= 2009) {
        words = `two thousand ${_ONES[low]}`;
    } else if (y >= 2010 && y <= 2099) {
        words = `twenty ${_twoDigit(low)}`;
    } else if (y >= 1000 && y <= 1999) {
        if (low === 0)       words = `${_twoDigit(high)} hundred`;
        else if (low < 10)   words = `${_twoDigit(high)} oh ${_ONES[low]}`;
        else                 words = `${_twoDigit(high)} ${_twoDigit(low)}`;
    } else {
        return String(y) + (hasSuffix ? 's' : '');
    }
    if (!hasSuffix) return words;
    const parts = words.split(' ');
    const last  = parts[parts.length - 1];
    if (_DECADE_S[last]) { parts[parts.length - 1] = _DECADE_S[last]; return parts.join(' '); }
    return words + 's';
}

function expandNumbers(text) {
    // Currency: $50 → "50 dollars"
    text = text.replace(/\$(\d+(?:\.\d{1,2})?)/g, (_, n) => `${n} dollars`);
    // Percentages: 25% → "25 percent"
    text = text.replace(/(\d+(?:\.\d+)?)\s*%/g, (_, n) => `${n} percent`);
    // Years: 1980 → "nineteen eighty", 1980s → "nineteen eighties"
    text = text.replace(/\b(1[0-9]{3}|20[0-9]{2})(s)?\b/g,
        (_m, year, suffix) => _yearToWords(parseInt(year, 10), !!suffix));
    // Ordinal list markers at sentence start: "1. Determination" → "one. Determination"
    // espeak-ng may silently suppress or mangle bare digits used as list labels,
    // producing empty phonemes → tokenIds.length ≤ 2 → sentence skipped.
    // Converting to word form gives the phonemizer unambiguous input.
    text = text.replace(/^(\d{1,2})\. (?=[A-Z])/, (_, num) => {
        const n = parseInt(num, 10);
        return (n > 0 && n < _ONES.length ? _ONES[n] : num) + '. ';
    });
    return text;
}

/**
 * Expand all-caps words (2+ letters) to space-separated letters.
 * Runs AFTER applyPronunciationMap so specific overrides take priority.
 *   "FBI"  → "F B I"
 *   "NASA" → "N A S A"
 *   "AI"   → "A I"
 *
 * Single uppercase letters (e.g. "I", "A") are left untouched.
 * Mixed-case words (e.g. "iPhone", "WePay") are not affected.
 * Words already expanded by the pronunciation map ("eh W S") are not re-expanded
 * because individual letters don't form a 2+ consecutive uppercase run after spacing.
 */
function expandAllCaps(text) {
    return text.replace(/\b[A-Z]{2,}\b/g, (match) => match.split('').join(' '));
}

// ── Clause-boundary splitting ─────────────────────────────────────────────────

// Maps each clause-boundary delimiter to the Kokoro IPA token it should inject.
// Kokoro's vocabulary (tokenizer.js) contains these punctuation tokens:
//   ;=1  :=2  ,=3  .=4  !=5  ?=6  —=9
// En-dash (–, U+2013) is NOT in the vocab — substitute em-dash (—, U+2014).
// By appending the token to the IPA string we let the model generate natural
// prosody (comma intonation, colon pause, etc.) rather than inserting silence.
const CLAUSE_TOKENS = {
    ',':      ',',      // token 3
    ';':      ';',      // token 1
    ':':      ':',      // token 2
    '\u2014': '\u2014', // em-dash — token 9
    '\u2013': '\u2014', // en-dash → mapped to em-dash
};

/**
 * Split sentence text at clause boundaries (comma, semicolon, colon, em-dash,
 * en-dash).  Returns the clause text WITHOUT the trailing delimiter (delimiter
 * is injected directly into the IPA string in generateAudio so Kokoro receives
 * the correct punctuation token and generates natural prosody).
 *
 * Guards:
 *   - comma between digits → thousands separator ("3,000") — not split
 *   - colon between digits → time / ratio ("10:30", "1:2")  — not split
 *
 * @param {string} text
 * @returns {{ text: string, delimToken: string }[]}
 *   text       — clause text WITHOUT trailing delimiter, ready for the phonemizer
 *   delimToken — IPA punctuation char to append after phonemization ('' for last clause)
 */
function splitAtClauseBoundaries(text) {
    // Normalise spaced hyphens (" - ") used as em-dash in plain-text writing.
    text = text.replace(/ - /g, ' \u2014 ');

    const result = [];
    const re = /[,;:\u2014\u2013]/g;
    let last = 0;
    let match;

    while ((match = re.exec(text)) !== null) {
        const pos   = match.index;
        const delim = match[0];

        // Guard: comma between digits → thousands separator
        if (delim === ',' && pos > 0 && pos + 1 < text.length) {
            if (/\d/.test(text[pos - 1]) && /\d/.test(text[pos + 1])) continue;
        }
        // Guard: colon between digits → time or ratio
        if (delim === ':' && pos > 0 && pos + 1 < text.length) {
            if (/\d/.test(text[pos - 1]) && /\d/.test(text[pos + 1])) continue;
        }

        // Only split if there is actual text before this delimiter
        const clauseText = text.slice(last, pos).trim();
        if (clauseText.length === 0) continue;

        result.push({ text: clauseText, delimToken: CLAUSE_TOKENS[delim] ?? '' });
        last = pos + 1;
    }

    // Last clause — no delimiter to inject; sentence-level pause handled externally
    const remaining = text.slice(last).trim();
    if (remaining) result.push({ text: remaining, delimToken: '' });

    if (result.length === 0) return [{ text, delimToken: '' }];
    return result;
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

const OPFS_MODEL_FILE = 'kokoro-v1.0.onnx';

async function loadModel({ voice, wasmPaths, modelUrl, voiceBaseUrl: vbu, remoteModelUrl, remoteVoiceBaseUrl: rvbu }) {
    voiceBaseUrl       = vbu  || '';
    remoteVoiceBaseUrl = rvbu || '';

    post({ type: 'LOADING_PROGRESS', stage: 'wasm', pct: 0 });
    ort.env.wasm.wasmPaths = wasmPaths;

    // ── 1. Resolve model buffer: OPFS cache → streaming download to OPFS ──
    let modelBuffer;
    const isCached = await opfsFileExists(OPFS_MODEL_FILE);

    if (isCached) {
        console.log('[tts-worker] model found in OPFS cache — loading locally');
        post({ type: 'LOADING_PROGRESS', stage: 'model_cached', pct: 5 });
        modelBuffer = await loadFromOpfs(OPFS_MODEL_FILE);
        post({ type: 'LOADING_PROGRESS', stage: 'model', pct: 80 });
    } else {
        // Stream directly to OPFS — no 620MB memory spike.
        // fetchToOpfsWithProgress handles retry + resume automatically.
        const downloadUrl = remoteModelUrl || modelUrl;
        console.log('[tts-worker] downloading model from', downloadUrl);
        post({ type: 'LOADING_PROGRESS', stage: 'downloading', pct: 0 });
        modelBuffer = await fetchToOpfsWithProgress(downloadUrl, OPFS_MODEL_FILE, (pct) => {
            post({ type: 'LOADING_PROGRESS', stage: 'downloading', pct: Math.round(pct * 78) });
        });
        post({ type: 'LOADING_PROGRESS', stage: 'model', pct: 80 });
    }

    // ── 2. Create ONNX session (retry once if OPFS file is corrupt) ──
    post({ type: 'LOADING_PROGRESS', stage: 'model', pct: 82 });
    let onnxSession;
    try {
        onnxSession = await ort.InferenceSession.create(modelBuffer, { executionProviders: ['wasm'] });
    } catch (err) {
        if (isCached) {
            // Cached file may be corrupt — delete and re-download via streaming
            console.warn('[tts-worker] cached model failed to load, re-downloading...', err);
            await deleteFromOpfs(OPFS_MODEL_FILE);
            const downloadUrl = remoteModelUrl || modelUrl;
            post({ type: 'LOADING_PROGRESS', stage: 'downloading', pct: 0 });
            modelBuffer = await fetchToOpfsWithProgress(downloadUrl, OPFS_MODEL_FILE, (pct) => {
                post({ type: 'LOADING_PROGRESS', stage: 'downloading', pct: Math.round(pct * 78) });
            });
            post({ type: 'LOADING_PROGRESS', stage: 'model', pct: 82 });
            onnxSession = await ort.InferenceSession.create(modelBuffer, { executionProviders: ['wasm'] });
        } else {
            throw err;
        }
    }
    session = onnxSession;

    // Detect input/output names — differs between kokoro-onnx export versions
    inputIdsName  = session.inputNames.includes('input_ids') ? 'input_ids' : 'tokens';
    audioOutName  = session.outputNames[0];
    modelHasSpeed = session.inputNames.includes('speed');
    console.log('[tts-worker] ONNX session created, inputs:', session.inputNames.join(', '));

    post({ type: 'LOADING_PROGRESS', stage: 'voice', pct: 85 });
    await loadVoice(voice);

    post({ type: 'LOADING_PROGRESS', stage: 'done', pct: 100 });
    post({ type: 'MODEL_READY', voice: activeVoice });
    console.log('[tts-worker] ready, voice =', activeVoice);
}

async function loadVoice(voiceName) {
    const opfsFile = `voice_${voiceName}.bin`;

    if (await opfsFileExists(opfsFile)) {
        console.log('[tts-worker] loading voice', voiceName, 'from OPFS cache');
        const buffer = await loadFromOpfs(opfsFile);
        voiceData = new Float32Array(buffer);
    } else {
        const url = (remoteVoiceBaseUrl || voiceBaseUrl) + voiceName + '.bin';
        console.log('[tts-worker] downloading voice', voiceName, 'from', url);
        // Use streaming download with retry + resume (same as model download)
        const buffer = await fetchToOpfsWithProgress(url, opfsFile, () => {});
        voiceData = new Float32Array(buffer);
    }
    activeVoice = voiceName;

    if (voiceData.length !== 510 * 256) {
        // File appears corrupt — delete it and re-download once
        console.warn('[tts-worker] voice file size mismatch — deleting and re-downloading', voiceName);
        await deleteFromOpfs(opfsFile);
        const retryUrl = (remoteVoiceBaseUrl || voiceBaseUrl) + voiceName + '.bin';
        const retryBuffer = await fetchToOpfsWithProgress(retryUrl, opfsFile, () => {});
        voiceData = new Float32Array(retryBuffer);
        activeVoice = voiceName;
        if (voiceData.length !== 510 * 256) {
            throw new Error(`Unexpected voice file size: ${voiceData.length} floats (expected ${510 * 256})`);
        }
    }
}

// ── Download with streaming-to-OPFS, resume, and retry ──────────────────────
//
// Streams directly to an OPFS file instead of accumulating chunks in memory.
// For a 310 MB model this avoids a ~620 MB memory spike (chunks + combined).
// Supports HTTP Range resume if a partial download exists in OPFS.
// Retries up to 3 times with exponential backoff on failure.

const DOWNLOAD_MAX_RETRIES = 3;
const DOWNLOAD_BACKOFF_MS  = [1000, 3000, 10000];

/**
 * Download `url` into an OPFS file, streaming chunks directly to disk.
 * Returns the complete file as an ArrayBuffer after download finishes.
 *
 * @param {string} url             - Remote URL to fetch
 * @param {string} opfsFilename    - OPFS filename to stream into
 * @param {Function} onProgress    - Called with (fraction 0–1) as data arrives
 * @returns {Promise<ArrayBuffer>} - The finished file contents
 */
async function fetchToOpfsWithProgress(url, opfsFilename, onProgress) {
    let lastError = null;

    for (let attempt = 0; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            const delay = DOWNLOAD_BACKOFF_MS[Math.min(attempt - 1, DOWNLOAD_BACKOFF_MS.length - 1)];
            console.log(`[tts-worker] download retry ${attempt}/${DOWNLOAD_MAX_RETRIES} after ${delay}ms`);
            post({ type: 'LOADING_PROGRESS', stage: 'retrying', pct: 0 });
            await new Promise(r => setTimeout(r, delay));
        }

        try {
            // Check how much we already have (for resume)
            const existingSize = await opfsFileSize(opfsFilename);

            const headers = {};
            if (existingSize > 0) {
                headers['Range'] = `bytes=${existingSize}-`;
                console.log(`[tts-worker] resuming download from byte ${existingSize}`);
            }

            const response = await fetch(url, { headers });

            // 416 = Range Not Satisfiable — file already fully downloaded
            if (response.status === 416) {
                console.log('[tts-worker] file already fully downloaded (416)');
                onProgress(1);
                return loadFromOpfs(opfsFilename);
            }

            if (!response.ok && response.status !== 206) {
                throw new Error(`HTTP ${response.status} fetching ${url}`);
            }

            // Determine total size
            const isPartial = response.status === 206;
            let totalSize = 0;
            if (isPartial) {
                // Content-Range: bytes 12345-99999/100000
                const rangeHeader = response.headers.get('Content-Range');
                const rangeMatch = rangeHeader?.match(/\/(\d+)/);
                totalSize = rangeMatch ? parseInt(rangeMatch[1], 10) : 0;
            } else {
                const cl = response.headers.get('Content-Length');
                totalSize = cl ? parseInt(cl, 10) : 0;
            }

            // If server doesn't support Range and we had partial data, start fresh
            if (!isPartial && existingSize > 0) {
                await deleteFromOpfs(opfsFilename);
            }

            const startByte = isPartial ? existingSize : 0;
            let received = startByte;

            // Open OPFS writable stream — append if resuming, create if fresh
            const root = await navigator.storage.getDirectory();
            const handle = await root.getFileHandle(opfsFilename, { create: true });
            const writable = await handle.createWritable({ keepExistingData: isPartial });
            // Seek to the end for append
            if (isPartial && startByte > 0) {
                await writable.seek(startByte);
            }

            const reader = response.body.getReader();

            // Stream chunks directly to OPFS
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                await writable.write(value);
                received += value.length;
                if (totalSize > 0) {
                    onProgress(received / totalSize);
                }
            }

            await writable.close();

            // Validate file size
            const finalSize = await opfsFileSize(opfsFilename);
            if (totalSize > 0 && finalSize !== totalSize) {
                throw new Error(`Size mismatch: expected ${totalSize}, got ${finalSize}`);
            }

            console.log(`[tts-worker] download complete: ${finalSize} bytes`);
            onProgress(1);
            return loadFromOpfs(opfsFilename);

        } catch (err) {
            lastError = err;
            console.warn(`[tts-worker] download attempt ${attempt + 1} failed:`, err.message);
            // Don't delete partial file — next attempt will resume from it
        }
    }

    // All retries exhausted — clean up partial file and report failure
    await deleteFromOpfs(opfsFilename);
    post({ type: 'DOWNLOAD_FAILED', detail: lastError?.message || 'Download failed after retries' });
    throw lastError;
}

// Legacy fallback for small files (voices) that don't need streaming
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
async function runInference(tokenIds) {
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
    };
    // Speed is handled via WSOLA in scheduleChunk (offscreen.js) rather than
    // the model's speed param — WSOLA is pitch-preserving and always available.
    if (modelHasSpeed) {
        feeds.speed = new ort.Tensor('float32', new Float32Array([1.0]), [1]);
    }

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
async function generateAudio({ sentences, speed = 1.0, voice = null, genId = 0, indexOffset = 0, sentenceIndices = null, totalSentences = null }) {
    if (!session || !voiceData) {
        postError('MODEL_NOT_READY', 'Load the model first.');
        return;
    }

    // Claim a new generation slot — invalidates any still-running previous generation.
    cancelId++;
    const myId = cancelId;
    isGenerating = true;

    // Load the requested voice BEFORE processing any sentences.
    // This guarantees the correct voice for the entire generation regardless of
    // any concurrent SWITCH_VOICE messages or race conditions in message ordering.
    // Also consume any pendingVoice that was set while no generation was running.
    const targetVoice = pendingVoice || voice;
    pendingVoice = null;
    console.log('[tts-worker] generateAudio: requested voice =', targetVoice, ', active voice =', activeVoice);
    if (targetVoice && targetVoice !== activeVoice) {
        console.log('[tts-worker] generateAudio: switching voice', activeVoice, '→', targetVoice);
        await loadVoice(targetVoice);
        if (cancelId !== myId) { isGenerating = false; return; }
        console.log('[tts-worker] generateAudio: voice loaded, activeVoice =', activeVoice);
    }

    const total = totalSentences ?? (indexOffset + sentences.length);

    for (let i = 0; i < sentences.length; i++) {
        // Yield to the macrotask queue so that queued SWITCH_VOICE messages
        // (which set pendingVoice) get a chance to run. Without this yield,
        // the async/await microtask chain keeps the event loop busy and
        // onmessage for SWITCH_VOICE never fires until generation completes.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (cancelId !== myId) { isGenerating = false; return; }

        // Resolve global sentence index — sentenceIndices (dual-worker) or fallback
        const globalIndex = sentenceIndices ? sentenceIndices[i] : (indexOffset + i);

        // Check for mid-generation voice switch
        if (pendingVoice && pendingVoice !== activeVoice) {
            console.log('[tts-worker] mid-generation voice switch:', activeVoice, '→', pendingVoice);
            await loadVoice(pendingVoice);
            pendingVoice = null;
            post({ type: 'VOICE_READY', voice: activeVoice });
            if (cancelId !== myId) { isGenerating = false; return; }
        }

        if (cancelId !== myId) { isGenerating = false; return; } // cancelled / superseded

        const { text: rawText, endsWithParagraph, endsWithSection = false } = sentences[i];
        // Expand numbers/years then apply pronunciation overrides here (not in
        // text-cleaner) so that sentence text stays in its original form for
        // the highlight-injector's DOM searches.
        const text = expandAllCaps(applyPronunciationMap(expandNumbers(rawText)));

        // 1. Split sentence at clause boundaries (comma, semicolon, colon, em/en-dash).
        //    Each clause is phonemized and inferred independently so the model receives
        //    clean input, and an explicit silence gap is scheduled between clauses.
        const clauses = splitAtClauseBoundaries(text);

        for (let ci = 0; ci < clauses.length; ci++) {
            if (cancelId !== myId) return;

            const { text: clauseText, delimToken } = clauses[ci];
            const isLastClause = ci === clauses.length - 1;

            // Detect parenthetical pattern: ", word(s)," — two consecutive comma boundaries.
            // e.g. "for this to work, though, you have to be"
            //       clause: "for this to work"  delimToken: ','
            //       clause: "though"            delimToken: ','  ← isParenthetical
            //       clause: "you have to be"    delimToken: ''
            // For a parenthetical clause we do NOT inject the comma token into the IPA
            // (that creates awkward short-phrase intonation in the model).  Instead we
            // schedule a small explicit silence so the phrasing still breathes naturally.
            const prevDelimToken = ci > 0 ? clauses[ci - 1].delimToken : '';
            const isParenthetical = !isLastClause
                                 && delimToken === ','
                                 && prevDelimToken === ',';

            // 2. Phonemize the clause.
            //    For non-last, non-parenthetical clauses we append the delimiter char to
            //    the IPA so Kokoro receives the correct punctuation token and generates
            //    natural prosody (,=3  ;=1  :=2  —=9).
            //    Parenthetical clauses skip token injection; a 60ms explicit gap is used.
            let phonemes = await phonemizeSentence(clauseText);
            if (cancelId !== myId) return;

            if (!isLastClause && delimToken && !isParenthetical) {
                // e.g. "həlˈoʊ" + "," → "həlˈoʊ,"  → token 3 → natural comma prosody
                phonemes = phonemes.trimEnd() + delimToken;
            }

            // Log phonemes once per sentence (from first clause)
            if (ci === 0) {
                console.log(`[tts-worker] [${i + 1}/${total}] phonemes (${phonemes.length} chars): "${phonemes.slice(0, 80)}${phonemes.length > 80 ? '…' : ''}"`);
                post({ type: 'PHONEMES_READY', index: globalIndex, total, text, phonemes });
            } else {
                console.log(`[tts-worker] [${i + 1}/${total}] clause ${ci + 1}/${clauses.length} phonemes (${phonemes.length} chars): "${phonemes.slice(0, 60)}${phonemes.length > 60 ? '…' : ''}"`);
            }

            // 3. Split clauses that exceed the phoneme threshold into exactly two parts.
            //    Part 1 (main): counts as one unit toward the chunksAhead buffer counter.
            //    Part 2 (overflow): plays seamlessly after part 1; invisible to the counter.
            const parts = splitLongSentence(phonemes);
            if (parts.length > 1) {
                console.log(`[tts-worker] [${i + 1}/${total}] clause ${ci + 1}: long phoneme string split into 2 parts`);
            }

            for (let pi = 0; pi < parts.length; pi++) {
                if (cancelId !== myId) return;

                const isLastPart = pi === parts.length - 1;

                // countAsChunk: true only for the very first part of the first clause —
                // the whole sentence still counts as exactly ONE pre-buffer unit.
                const countAsChunk = ci === 0 && pi === 0;

                // 4. Tokenize
                const tokenIds = tokenize(parts[pi]);
                if (tokenIds.length <= 2) {
                    console.warn(`[tts-worker] skipping clause ${ci + 1}, part ${pi + 1} of sentence ${i + 1}: no tokens`);
                    continue;
                }

                // 5. Infer
                const samples = await runInference(tokenIds);
                if (cancelId !== myId) return;
                if (!samples) continue;

                console.log(`[tts-worker] [${i + 1}/${total}] clause ${ci + 1}/${clauses.length} part ${pi + 1}/${parts.length}: ${samples.length} samples (${(samples.length / 24000).toFixed(2)}s)`);

                // Scheduling pause after this chunk:
                //   overflow part (non-last part)          → 0ms      seamless join
                //   last part of last clause               → undefined → sentence-level pause
                //   last part of any other clause          → 0ms      (Kokoro prosody baked in;
                //                                            parenthetical comma already dropped)
                const pauseAfterMs = !isLastPart  ? 0
                                   : isLastClause ? undefined
                                   : 0;

                // 6. Transfer samples buffer (zero-copy).
                //    Sentence-boundary metadata only travels on the last part of the last clause.
                const samplesCopy = new Float32Array(samples);
                post(
                    {
                        type: 'AUDIO_CHUNK',
                        index: globalIndex, // global sentence index
                        total,
                        samples: samplesCopy,
                        sampleRate: 24000,
                        endsWithParagraph: isLastPart && isLastClause ? endsWithParagraph : false,
                        endsWithSection:   isLastPart && isLastClause ? endsWithSection   : false,
                        isMidChunk:   !isLastPart,   // true for overflow tail of a long-clause split
                        countAsChunk,
                        pauseAfterMs,
                        genId,
                    },
                    [samplesCopy.buffer]
                );
            }
        }

        // Signal that all chunks for this sentence have been posted.
        // The offscreen reorder buffer uses this to know when a sentence is
        // complete and safe to flush (even if it produced zero audio chunks).
        if (cancelId !== myId) return;
        post({ type: 'SENTENCE_COMPLETE', index: globalIndex, genId });
    }

    isGenerating = false;
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
                if (isGenerating) {
                    // Don't block — just set the flag for generateAudio to pick up
                    // on its next sentence boundary (after it yields to macrotask queue).
                    pendingVoice = payload.voice;
                    console.log('[tts-worker] SWITCH_VOICE during generation — queued:', pendingVoice);
                } else {
                    await loadVoice(payload.voice);
                    pendingVoice = null;
                    post({ type: 'VOICE_READY', voice: activeVoice });
                }
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
