// audio-cache.js — IndexedDB-backed audio cache with 72-hour TTL.
//
// Stores:
//   audio    — complete audio saved on GENERATION_DONE (existing, keyed by url)
//   chunks   — individual chunks written incrementally during generation (keyed by url_idx)
//   positions — playback position saved on pause (keyed by url)
//
// v4: audio data stored as Int16 (2 bytes/sample) instead of Float32 (4 bytes/sample) — 2× smaller.

const DB_NAME      = 'kokoro-tts-cache';
const DB_VERSION   = 4; // v4: Int16 audio storage (2× smaller than Float32)
const AUDIO_STORE  = 'audio';
const CHUNKS_STORE = 'chunks';
const POS_STORE    = 'positions';
const JOBS_STORE   = 'jobs'; // pending sentence lists — allows resuming generation after offscreen restart
const TTL_MS       = 72 * 60 * 60 * 1000; // 72 hours

// ── Float32 ↔ Int16 conversion helpers ──────────────────────────────────────

/** Convert a Float32Array buffer to an Int16Array buffer (2× smaller). */
function float32ToInt16Buffer(arrayBuffer) {
    const f32 = new Float32Array(arrayBuffer);
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        i16[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    }
    return i16.buffer;
}

/** Convert an Int16Array buffer back to a Float32Array buffer. */
function int16BufferToFloat32Buffer(arrayBuffer) {
    const i16 = new Int16Array(arrayBuffer);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) {
        f32[i] = i16[i] / 32768;
    }
    return f32.buffer;
}

/** Normalize URL to origin + pathname (strips query params and hash). */
export function normUrl(url) {
    try {
        const u = new URL(url);
        return u.origin + u.pathname.replace(/\/$/, '');
    } catch (_) {
        return url;
    }
}

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            // v4: switched to Int16 storage — drop all old stores (Float32 data incompatible)
            // and recreate fresh. Old cached articles expire in 72h anyway.
            for (const name of [AUDIO_STORE, CHUNKS_STORE, POS_STORE, JOBS_STORE]) {
                if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
            }
            db.createObjectStore(AUDIO_STORE, { keyPath: 'url' });
            db.createObjectStore(JOBS_STORE,  { keyPath: 'url' });
            const cs = db.createObjectStore(CHUNKS_STORE, { keyPath: 'id' });
            cs.createIndex('byUrl', 'url', { unique: false });
            db.createObjectStore(POS_STORE, { keyPath: 'url' });
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => reject(e.target.error);
    });
}

// ── Complete audio store (unchanged API) ────────────────────────────────────

/**
 * Save complete audio entries to cache (called on GENERATION_DONE).
 * entries: [{ data: ArrayBuffer, sampleRate, countAsChunk, sentenceIndex, pauseAfter }]
 */
export async function saveToCache(url, { title, entries }) {
    const key = normUrl(url);
    const db  = await openDb();
    // Compress Float32 → Int16 before storing (2× smaller)
    const compressed = entries.map(e => ({
        ...e,
        data: float32ToInt16Buffer(e.data),
    }));
    return new Promise((resolve, reject) => {
        const tx = db.transaction(AUDIO_STORE, 'readwrite');
        tx.objectStore(AUDIO_STORE).put({ url: key, title, generatedAt: Date.now(), entries: compressed });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror    = (e) => { db.close(); reject(e.target.error); };
    });
}

/**
 * Load cached complete audio. Returns null if not found or expired.
 */
export async function loadFromCache(url) {
    const key = normUrl(url);
    const db  = await openDb();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(AUDIO_STORE, 'readonly');
        const req = tx.objectStore(AUDIO_STORE).get(key);
        req.onsuccess = (e) => {
            db.close();
            const row = e.target.result;
            if (!row) return resolve(null);
            if (Date.now() - row.generatedAt > TTL_MS) return resolve(null);
            // Decompress Int16 → Float32 on load
            const entries = row.entries.map(entry => ({
                ...entry,
                data: int16BufferToFloat32Buffer(entry.data),
            }));
            resolve({ title: row.title, entries });
        };
        req.onerror = (e) => { db.close(); reject(e.target.error); };
    });
}

/**
 * Check whether a valid (non-expired) complete audio cache entry exists.
 */
export async function checkCacheExists(url) {
    const key = normUrl(url);
    const db  = await openDb();
    return new Promise((resolve) => {
        const tx  = db.transaction(AUDIO_STORE, 'readonly');
        const req = tx.objectStore(AUDIO_STORE).get(key);
        req.onsuccess = (e) => {
            db.close();
            const row = e.target.result;
            if (!row) return resolve(false);
            resolve(Date.now() - row.generatedAt <= TTL_MS);
        };
        req.onerror = () => { db.close(); resolve(false); };
    });
}

/** Delete all audio cache entries older than 72 hours. */
export async function clearExpired() {
    const db = await openDb();
    return new Promise((resolve) => {
        const tx    = db.transaction(AUDIO_STORE, 'readwrite');
        const req   = tx.objectStore(AUDIO_STORE).openCursor();
        req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            if (Date.now() - cursor.value.generatedAt > TTL_MS) cursor.delete();
            cursor.continue();
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror    = () => { db.close(); resolve(); };
    });
}

// ── Incremental chunk store ──────────────────────────────────────────────────

/**
 * Write a single audio chunk to the chunks store.
 * Called from scheduleChunk() as each chunk is processed — fire and forget.
 * @param {string} url  - page URL (will be normalized)
 * @param {number} idx  - chunk index (0-based, monotonically increasing per session)
 * @param {{ data: ArrayBuffer, sampleRate: number, countAsChunk: boolean, sentenceIndex: number|undefined, pauseAfter: number }} chunk
 */
export async function appendChunk(url, idx, { data, sampleRate, countAsChunk, sentenceIndex, pauseAfter }) {
    const key = normUrl(url);
    const db  = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CHUNKS_STORE, 'readwrite');
        tx.objectStore(CHUNKS_STORE).put({
            id: `${key}_${idx}`,
            url: key,
            idx,
            data: float32ToInt16Buffer(data), // compress Float32 → Int16
            sampleRate,
            countAsChunk,
            sentenceIndex,
            pauseAfter,
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror    = (e) => { db.close(); reject(e.target.error); };
    });
}

/**
 * Load all chunks for a URL, sorted by index.
 * Returns [] if none found.
 */
export async function loadChunks(url) {
    const key = normUrl(url);
    const db  = await openDb();
    return new Promise((resolve) => {
        const tx  = db.transaction(CHUNKS_STORE, 'readonly');
        const idx = tx.objectStore(CHUNKS_STORE).index('byUrl');
        const req = idx.getAll(IDBKeyRange.only(key));
        req.onsuccess = (e) => {
            db.close();
            const rows = e.target.result || [];
            rows.sort((a, b) => a.idx - b.idx);
            // Decompress Int16 → Float32 on load
            rows.forEach(row => { row.data = int16BufferToFloat32Buffer(row.data); });
            resolve(rows);
        };
        req.onerror = () => { db.close(); resolve([]); };
    });
}

/**
 * Delete all chunk entries for a URL.
 * Called at the start of a new generation (resetAudio) and after saveToCache succeeds.
 */
export async function clearChunks(url) {
    if (!url) return;
    const key = normUrl(url);
    const db  = await openDb();
    return new Promise((resolve) => {
        const tx  = db.transaction(CHUNKS_STORE, 'readwrite');
        const idx = tx.objectStore(CHUNKS_STORE).index('byUrl');
        const req = idx.openCursor(IDBKeyRange.only(key));
        req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) { cursor.delete(); cursor.continue(); }
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror    = () => { db.close(); resolve(); };
    });
}

// ── Playback position store ──────────────────────────────────────────────────

/**
 * Save current playback position for a URL (called on pause).
 * @param {string} url
 * @param {{ position: number, generationComplete: boolean, title: string }} state
 */
export async function savePosition(url, { position, generationComplete, title }) {
    const key = normUrl(url);
    const db  = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(POS_STORE, 'readwrite');
        tx.objectStore(POS_STORE).put({ url: key, position, generationComplete, title, savedAt: Date.now() });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror    = (e) => { db.close(); reject(e.target.error); };
    });
}

/**
 * Load saved playback state for a URL.
 * Returns null if not found.
 */
export async function loadPosition(url) {
    const key = normUrl(url);
    const db  = await openDb();
    return new Promise((resolve) => {
        const tx  = db.transaction(POS_STORE, 'readonly');
        const req = tx.objectStore(POS_STORE).get(key);
        req.onsuccess = (e) => { db.close(); resolve(e.target.result || null); };
        req.onerror   = () => { db.close(); resolve(null); };
    });
}

// ── Generation job store ─────────────────────────────────────────────────────
// Saves the full sentence list at generation start so that, if the offscreen
// document is terminated mid-generation, we can resume from the last completed
// sentence rather than losing the remaining audio.

/**
 * Save the sentence list for a URL (called at the start of every generation).
 * @param {string} url
 * @param {{ sentences: Array, title: string }} job
 */
export async function saveGenerationJob(url, { sentences, title }) {
    const key = normUrl(url);
    const db  = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(JOBS_STORE, 'readwrite');
        tx.objectStore(JOBS_STORE).put({ url: key, sentences, title, savedAt: Date.now() });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror    = (e) => { db.close(); reject(e.target.error); };
    });
}

/**
 * Load the saved sentence list for a URL. Returns null if not found.
 */
export async function loadGenerationJob(url) {
    const key = normUrl(url);
    const db  = await openDb();
    return new Promise((resolve) => {
        const tx  = db.transaction(JOBS_STORE, 'readonly');
        const req = tx.objectStore(JOBS_STORE).get(key);
        req.onsuccess = (e) => { db.close(); resolve(e.target.result || null); };
        req.onerror   = () => { db.close(); resolve(null); };
    });
}

/**
 * Delete the generation job for a URL (called on GENERATION_DONE or new generation).
 */
export async function deleteGenerationJob(url) {
    if (!url) return;
    const key = normUrl(url);
    const db  = await openDb();
    return new Promise((resolve) => {
        const tx = db.transaction(JOBS_STORE, 'readwrite');
        tx.objectStore(JOBS_STORE).delete(key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror    = () => { db.close(); resolve(); };
    });
}

/**
 * Delete the saved position entry for a URL (called on new generation start).
 */
export async function deletePosition(url) {
    if (!url) return;
    const key = normUrl(url);
    const db  = await openDb();
    return new Promise((resolve) => {
        const tx = db.transaction(POS_STORE, 'readwrite');
        tx.objectStore(POS_STORE).delete(key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror    = () => { db.close(); resolve(); };
    });
}
