// audio-player.js — Audio playback engine for content script context
//
// Receives audio chunks from offscreen (via SW relay), schedules them on a local
// AudioContext, and handles play/pause/seek/stop entirely within the content script.
// This means playback survives offscreen document termination — Chrome can kill
// the offscreen doc without interrupting audio.

import { stretchAudio } from '../utils/audio-stretcher.js';

// ── Audio state ──────────────────────────────────────────────────────────────
let audioContext           = null;
let nextPlayTime           = 0;
let firstChunkStartTime    = 0;
let totalScheduledDuration = 0;
let scheduledSources       = [];
let isPlaying              = false;
let generationDone         = false;
let killed                 = false; // true after stop/close — ignores incoming chunks
let pausedAtTime           = 0;
let pausedAtWallClock      = 0; // Date.now() when pause() was called

// Pre-buffer: accumulate chunks before starting playback
const PREBUFFER_COUNT_NORMAL = 2;
const PREBUFFER_COUNT_TURBO  = 1;
let prebufferCount  = PREBUFFER_COUNT_TURBO; // default: turbo ON
let pendingChunks   = [];
let playbackStarted = false; // true once startPlayback() has run

// Short-first-chunk handling: if the first countAsChunk chunk is < this many seconds,
// require one extra chunk before starting (avoids a long silence gap after a short opener).
const SHORT_FIRST_CHUNK_THRESHOLD_S = 2.0;
// First-chunk warm-up: always schedule the first buffered chunk slightly slower so the
// audio context and speaker have time to stabilise before full-speed audio hits.
const FIRST_CHUNK_WARMUP_SPEED = 0.9;

// Adaptive slowdown — buys inference time when buffer runs thin
// Disabled in turbo mode (dual workers produce chunks fast enough)
const SLOW_THRESHOLD = 2;
const SLOW_RATE      = 0.9;
let turboEnabled  = true; // mirrors chrome.storage.local turboMode
let chunksAhead = 0;

// User speed (0.5–2.0) applied via WSOLA at scheduling time
let currentSpeed = 1.0;

// Voice-switch transition mode — activated by trimAndRestartFrom()
// Buffers the first TRANSITION_PREBUFFER chunks and plays them at reduced speed
// to give generation a head start before catching up to real-time.
const TRANSITION_PREBUFFER = 2;
const TRANSITION_SPEED_FACTOR = 0.9;
let inVoiceTransition = false;
let transitionPendingChunks = [];

// Audio history for seeking — each entry mirrors the old offscreen audioHistory
// { relStart, duration, data (Float32Array), sampleRate, countAsChunk, isMidChunk, sentenceIndex, pauseAfter }
let audioHistory         = [];
let historyTotalDuration = 0;

// Highlight tracking — driven by audioContext.currentTime in progress interval
let currentHighlightIndex = -1;

// Progress tracking
let progressInterval   = null;
let lastProgressNotify = 0;
const PROGRESS_THROTTLE_MS = 500;

// Pause durations (seconds) — must match offscreen constants
const PAUSE_SECTION   = 1.20;
const PAUSE_PARAGRAPH = 0.60;
const PAUSE_SENTENCE  = 0.25;

// Generation stall detection — if no chunks arrive for this long while
// generation isn't done, we signal the SW to check offscreen health.
const STALL_TIMEOUT_MS = 15000;
let stallTimer = null;

// ── GC: release Float32 data from audioHistory for chunks far behind playback ──
// Metadata (relStart, duration, sentenceIndex) is retained for seek/highlight.
// Only the raw Float32Array sample data is freed.
const GC_LOOKBACK_SECONDS = 120;
// Tracks the relStart time below which data has already been released.
let gcWatermarkTime = 0;
// Last elapsed-second at which GC ran — prevents the progress interval from
// triggering GC on every tick that shares the same floor value (10 ticks/boundary).
let lastGcElapsedSec = -1;

// Short-first-chunk: set to true when the first countAsChunk chunk arrives with a
// duration below SHORT_FIRST_CHUNK_THRESHOLD_S, so we require one extra chunk.
let firstChunkIsShort = false;

// ── Callbacks (set via init) ─────────────────────────────────────────────────
let onStateChange      = () => {};
let onStatusUpdate     = () => {};
let onProgressUpdate   = () => {};
let onSentencePlaying  = () => {};
let onChunksReady      = () => {};
let onGenerationDone   = () => {};
let onGenerationStall  = () => {};
// Called when seekTo targets a time whose audio data has been GC'd
let onNeedCacheReload  = () => {};

// ── Initialization ───────────────────────────────────────────────────────────

export function init(callbacks) {
    if (callbacks.stateChange)     onStateChange     = callbacks.stateChange;
    if (callbacks.statusUpdate)    onStatusUpdate    = callbacks.statusUpdate;
    if (callbacks.progressUpdate)  onProgressUpdate  = callbacks.progressUpdate;
    if (callbacks.sentencePlaying) onSentencePlaying = callbacks.sentencePlaying;
    if (callbacks.chunksReady)     onChunksReady     = callbacks.chunksReady;
    if (callbacks.generationDone)  onGenerationDone  = callbacks.generationDone;
    if (callbacks.generationStall) onGenerationStall = callbacks.generationStall;
    if (callbacks.needCacheReload) onNeedCacheReload = callbacks.needCacheReload;
}

// ── AudioContext management ──────────────────────────────────────────────────

function ensureAudioContext() {
    if (audioContext && audioContext.state !== 'closed') return audioContext;
    try {
        audioContext = new AudioContext({ sampleRate: 24000 });
        console.log('[audio-player] AudioContext created, state:', audioContext.state);
    } catch (err) {
        console.error('[audio-player] AudioContext creation failed:', err);
        return null;
    }
    return audioContext;
}

// ── Reset (new generation starting) ──────────────────────────────────────────

export function reset() {
    console.log('[audio-player] reset()');
    stopProgressTracking();
    resetHighlightIndex();
    clearStallTimer();
    stopAllSources();
    if (audioContext) {
        try { audioContext.close(); } catch (_) {}
        audioContext = null;
    }
    nextPlayTime           = 0;
    firstChunkStartTime    = 0;
    totalScheduledDuration = 0;
    scheduledSources       = [];
    pendingChunks          = [];
    chunksAhead            = 0;
    isPlaying              = false;
    generationDone         = false;
    killed                 = false;
    pausedAtTime           = 0;
    pausedAtWallClock      = 0;
    playbackStarted        = false;
    audioHistory           = [];
    historyTotalDuration   = 0;
    inVoiceTransition      = false;
    transitionPendingChunks = [];
    // Reset GC state so a fresh generation starts clean
    gcWatermarkTime        = 0;
    lastGcElapsedSec       = -1;
    firstChunkIsShort      = false;
}

function stopAllSources() {
    for (const src of scheduledSources) {
        try { src.stop(); } catch (_) {}
    }
    scheduledSources = [];
}

// ── Chunk scheduling ─────────────────────────────────────────────────────────

// speedOverride: if provided, replaces currentSpeed for this chunk (used by transition mode)
function scheduleChunk(chunk, slowMode, speedOverride = null) {
    const ctx = ensureAudioContext();
    if (!ctx) return;

    const { samples, sampleRate, endsWithParagraph, endsWithSection,
            isMidChunk, countAsChunk, sentenceIndex, pauseAfterMs } = chunk;

    // Apply user speed + adaptive slowdown via WSOLA (pitch-preserving)
    const baseSpeed        = speedOverride !== null ? speedOverride : currentSpeed;
    const effectiveSpeed   = baseSpeed * (slowMode ? SLOW_RATE : 1.0);
    const stretchedSamples = stretchAudio(samples, effectiveSpeed);

    if (nextPlayTime < ctx.currentTime) {
        nextPlayTime = ctx.currentTime + 0.02;
    }

    const buffer = ctx.createBuffer(1, stretchedSamples.length, sampleRate);
    buffer.copyToChannel(stretchedSamples, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.playbackRate.value = 1.0;

    if (countAsChunk) chunksAhead++;

    source.onended = () => {
        if (countAsChunk) chunksAhead--;
        scheduledSources = scheduledSources.filter(s => s !== source);
    };

    source.start(nextPlayTime);
    scheduledSources.push(source);

    // Calculate pause after this chunk
    const pause = pauseAfterMs !== undefined
        ? pauseAfterMs / 1000
        : isMidChunk        ? 0
        : endsWithSection   ? PAUSE_SECTION
        : endsWithParagraph ? PAUSE_PARAGRAPH
        : PAUSE_SENTENCE;

    // Record in history for seeking
    const relStart = firstChunkStartTime > 0
        ? (nextPlayTime - firstChunkStartTime) : 0;
    audioHistory.push({
        relStart,
        duration: stretchedSamples.length / sampleRate,
        data: new Float32Array(stretchedSamples),
        sampleRate,
        countAsChunk,
        isMidChunk,
        sentenceIndex,
        pauseAfter: pause,
    });

    nextPlayTime           += buffer.duration + pause;
    totalScheduledDuration  = nextPlayTime - firstChunkStartTime;
    historyTotalDuration    = totalScheduledDuration;
}

// ── Playback start (internal — called after prebuffer threshold) ─────────────

function startPlayback() {
    const ctx = ensureAudioContext();
    if (!ctx) return;

    // Schedule chunks so they're ready when the context runs
    nextPlayTime        = ctx.currentTime + 0.08;
    firstChunkStartTime = nextPlayTime;
    playbackStarted = true;

    console.log('[audio-player] startPlayback: scheduling', pendingChunks.length, 'buffered chunks');
    let isFirstChunk = true;
    for (const chunk of pendingChunks) {
        // Schedule the very first chunk at a slightly reduced speed so the audio
        // context and speaker have time to stabilise before full-speed audio hits.
        const speedOverride = isFirstChunk ? FIRST_CHUNK_WARMUP_SPEED * currentSpeed : null;
        scheduleChunk(chunk, false, speedOverride);
        if (chunk.countAsChunk) isFirstChunk = false;
    }
    pendingChunks = [];

    // Try to resume — requires user gesture in content scripts.
    // If resume succeeds → playing. If blocked → show paused so user clicks.
    if (ctx.state === 'suspended') {
        ctx.resume().then(() => {
            if (ctx.state === 'running') {
                console.log('[audio-player] auto-resume succeeded');
                isPlaying = true;
                onStateChange('playing');
                onStatusUpdate('Generating & playing\u2026');
                startProgressTracking();
            } else {
                // Browser blocked auto-resume — wait for user gesture
                console.log('[audio-player] auto-resume blocked, waiting for user click');
                isPlaying = false;
                onChunksReady();
            }
        }).catch(() => {
            isPlaying = false;
            onChunksReady();
        });
    } else {
        // Already running (unlikely but handle it)
        isPlaying = true;
        onStateChange('playing');
        onStatusUpdate('Generating & playing\u2026');
        startProgressTracking();
    }
}

// ── Public: queue a chunk from offscreen ─────────────────────────────────────

export function queueChunk(chunkData) {
    // Ignore chunks after stop/close — generation may still be running
    if (killed) return;

    // Reset stall timer — a chunk just arrived
    resetStallTimer();

    // Ensure samples is a Float32Array (structured clone may produce ArrayBuffer)
    const samples = chunkData.samples instanceof Float32Array
        ? chunkData.samples
        : new Float32Array(chunkData.samples);

    const chunk = {
        samples,
        sampleRate:       chunkData.sampleRate,
        endsWithParagraph: chunkData.endsWithParagraph,
        endsWithSection:   chunkData.endsWithSection,
        isMidChunk:        chunkData.isMidChunk,
        countAsChunk:      chunkData.countAsChunk,
        sentenceIndex:     chunkData.sentenceIndex,
        pauseAfterMs:      chunkData.pauseAfterMs,
    };

    if (!playbackStarted) {
        pendingChunks.push(chunk);
        const sentenceCount = pendingChunks.filter(c => c.countAsChunk).length;

        // On the very first countAsChunk chunk, check if it's too short to play alone.
        // A short opener (< SHORT_FIRST_CHUNK_THRESHOLD_S) followed by silence feels broken,
        // so we require one extra chunk to arrive before starting playback.
        if (sentenceCount === 1 && chunk.countAsChunk) {
            const chunkDurationS = chunk.samples.length / (chunk.sampleRate || 24000);
            if (chunkDurationS < SHORT_FIRST_CHUNK_THRESHOLD_S) {
                firstChunkIsShort = true;
                console.log(`[audio-player] first chunk short (${chunkDurationS.toFixed(2)}s) — waiting for one more`);
            }
        }

        const requiredCount = firstChunkIsShort ? prebufferCount + 1 : prebufferCount;
        onStatusUpdate(`Buffering\u2026 (${sentenceCount}/${requiredCount})`);
        onStateChange('loading');

        if (sentenceCount >= requiredCount) {
            // Auto-start playback once enough chunks are buffered
            startPlayback();
        }
        return;
    }

    // Voice-switch transition: buffer first TRANSITION_PREBUFFER chunks then flush
    if (inVoiceTransition) {
        transitionPendingChunks.push(chunk);
        const countReady = transitionPendingChunks.filter(c => c.countAsChunk).length;
        onStatusUpdate(`Switching voice\u2026 (${countReady}/${TRANSITION_PREBUFFER})`);
        if (countReady >= TRANSITION_PREBUFFER) {
            inVoiceTransition = false;
            const transitionSpeed = TRANSITION_SPEED_FACTOR * currentSpeed;

            // Re-anchor nextPlayTime so chunks play immediately
            const ctx = ensureAudioContext();
            if (ctx) nextPlayTime = ctx.currentTime + 0.08;

            for (const tc of transitionPendingChunks) {
                scheduleChunk(tc, false, transitionSpeed);
            }
            transitionPendingChunks = [];

            // Restart progress tracking — seeker and timer resume from here
            isPlaying = true;
            onStateChange('playing');
            startProgressTracking();
            console.log('[audio-player] voice transition complete — resuming at', transitionSpeed.toFixed(2), 'x');
        }
        return;
    }

    // Already playing — schedule with adaptive slowdown (disabled in turbo mode)
    const strictlyAhead = chunksAhead - 1;
    const slowMode = !turboEnabled && !generationDone && (strictlyAhead <= SLOW_THRESHOLD);
    if (slowMode) {
        console.log(`[audio-player] slow mode — chunks ahead: ${strictlyAhead}, WSOLA at ${SLOW_RATE}\u00d7`);
    }
    scheduleChunk(chunk, slowMode);
}

// ── Public: user-initiated play (must be called within user gesture) ─────────

export function play() {
    const ctx = ensureAudioContext();
    if (!ctx) return;

    // Cache-loaded state: history populated but not yet scheduled on AudioContext
    if (audioHistory.length > 0 && !playbackStarted && pendingChunks.length === 0) {
        seekTo(pausedAtTime || 0);
        return;
    }

    // First play from buffered chunks (prebuffer not yet reached)
    if (!playbackStarted && pendingChunks.length > 0) {
        startPlayback();
        return;
    }

    // Chunks were scheduled by startPlayback() but auto-resume was blocked.
    // User click provides the gesture needed to resume.
    if (playbackStarted && !isPlaying && ctx.state === 'suspended') {
        console.log('[audio-player] user gesture resume after blocked auto-play');
        ctx.resume().catch(() => {});
        isPlaying = true;
        resetHighlightIndex(); // progress interval will pick up correct highlight
        onStateChange('playing');
        onStatusUpdate('Generating & playing\u2026');
        startProgressTracking();
        return;
    }

    // Resume from pause
    if (ctx.state === 'suspended') {
        // After a long suspend (>5s), Chrome may have invalidated scheduled sources.
        // Rebuild the entire playback timeline from pausedAtTime via seekTo.
        const pauseDurationMs = Date.now() - pausedAtWallClock;
        if (pauseDurationMs > 5000 && audioHistory.length > 0) {
            console.log(`[audio-player] long pause (${(pauseDurationMs / 1000).toFixed(1)}s) — rebuilding via seekTo`);
            seekTo(pausedAtTime);
            return;
        }

        ctx.resume().catch(() => {});
        isPlaying = true;
        resetHighlightIndex(); // progress interval will pick up correct highlight
        onStateChange('playing');
        onStatusUpdate('Playing\u2026');
        startProgressTracking();
    }
}

export function pause() {
    if (!audioContext) return;
    if (audioContext.state === 'running') {
        pausedAtTime = Math.max(0, audioContext.currentTime - firstChunkStartTime);
        pausedAtWallClock = Date.now();
        resetHighlightIndex();
        audioContext.suspend().catch(() => {});
        isPlaying = false;
        stopProgressTracking();
        onStateChange('paused');
        onStatusUpdate('Paused.');
    }
}

export function togglePlayPause() {
    if (!audioContext || !playbackStarted) {
        play();
        return;
    }
    if (isPlaying) {
        pause();
    } else {
        play();
    }
}

export function stop() {
    killed = true; // reject all future incoming chunks until reset()
    stopProgressTracking();
    resetHighlightIndex();
    clearStallTimer();
    stopAllSources();
    if (audioContext) {
        try { audioContext.close(); } catch (_) {}
        audioContext = null;
    }
    nextPlayTime           = 0;
    firstChunkStartTime    = 0;
    totalScheduledDuration = 0;
    isPlaying              = false;
    generationDone         = false;
    playbackStarted        = false;
    pendingChunks          = [];
    chunksAhead            = 0;
    onStateChange('stopped');
    onProgressUpdate(0, 0, 0);
}

export function setSpeed(speed) {
    currentSpeed = speed;
}

export function setTurboMode(enabled) {
    turboEnabled = enabled;
    prebufferCount = enabled ? PREBUFFER_COUNT_TURBO : PREBUFFER_COUNT_NORMAL;
    console.log(`[audio-player] turbo mode ${enabled ? 'ON' : 'OFF'} — prebuffer=${prebufferCount}`);
}

export function markGenerationDone() {
    if (killed) return;
    generationDone = true;
    clearStallTimer();
    // If prebuffer threshold was never reached, auto-start with what we have
    if (!playbackStarted && pendingChunks.length > 0) {
        startPlayback();
    }
    onGenerationDone();
}

// ── State query (used by content-script to answer SW questions) ──────────────

export function getState() {
    return {
        isPlaying,
        generationDone,
        pausedAtTime,
        historyTotalDuration,
        hasAudio:    audioHistory.length > 0 || pendingChunks.length > 0,
        playbackStarted,
        lastSentenceIndex: audioHistory.reduce(
            (max, e) => e.sentenceIndex != null ? Math.max(max, e.sentenceIndex) : max, -1),
    };
}

export function getPausedAtTime() {
    if (isPlaying && audioContext) {
        return Math.max(0, audioContext.currentTime - firstChunkStartTime);
    }
    return pausedAtTime;
}

// ── Seek ─────────────────────────────────────────────────────────────────────

export function seekTo(targetTime) {
    let ctx = ensureAudioContext();
    if (!ctx || audioHistory.length === 0) return;

    // If the target falls in the GC zone, sample data is gone — request a cache reload
    if (targetTime < gcWatermarkTime && gcWatermarkTime > 0) {
        console.log('[audio-player] seekTo target is in GC zone — requesting cache reload');
        onNeedCacheReload(targetTime);
        return;
    }

    // If AudioContext was closed by Chrome, create a fresh one
    if (ctx.state === 'closed') {
        console.log('[audio-player] seekTo: AudioContext was closed — creating new one');
        audioContext = new AudioContext({ sampleRate: 24000 });
        ctx = audioContext;
    }

    targetTime = Math.max(0, Math.min(targetTime, historyTotalDuration));
    console.log(`[audio-player] seekTo(${targetTime.toFixed(2)}s) — ${audioHistory.length} chunks, total: ${historyTotalDuration.toFixed(2)}s`);

    stopAllSources();
    chunksAhead = 0;
    resetHighlightIndex();

    if (ctx.state === 'suspended') ctx.resume();

    const seekBase = ctx.currentTime + 0.08;
    firstChunkStartTime = seekBase - targetTime;
    nextPlayTime = seekBase;

    // Find first chunk overlapping targetTime
    let startIdx    = audioHistory.length;
    let trimSamples = 0;
    for (let i = 0; i < audioHistory.length; i++) {
        const e = audioHistory[i];
        if (e.relStart + e.duration > targetTime) {
            startIdx    = i;
            trimSamples = Math.max(0, Math.floor((targetTime - e.relStart) * e.sampleRate));
            break;
        }
    }

    // Re-schedule from seek point
    for (let i = startIdx; i < audioHistory.length; i++) {
        const entry = audioHistory[i];
        let data = entry.data;
        if (i === startIdx && trimSamples > 0) {
            data = data.subarray(trimSamples);
        }
        if (data.length === 0) continue;

        const buf = ctx.createBuffer(1, data.length, entry.sampleRate);
        buf.copyToChannel(data, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);

        if (entry.countAsChunk) {
            chunksAhead++;
            src.onended = () => {
                chunksAhead--;
                scheduledSources = scheduledSources.filter(s => s !== src);
            };
        } else {
            src.onended = () => {
                scheduledSources = scheduledSources.filter(s => s !== src);
            };
        }

        src.start(nextPlayTime);
        scheduledSources.push(src);
        nextPlayTime += buf.duration + entry.pauseAfter;
    }

    totalScheduledDuration = nextPlayTime - firstChunkStartTime;
    historyTotalDuration   = totalScheduledDuration;

    if (!isPlaying) {
        isPlaying       = true;
        playbackStarted = true;
        onStateChange('playing');
    }
    startProgressTracking();
    resetHighlightIndex(); // progress interval will pick up correct highlight
}

// ── Load cached audio (from offscreen's CACHE_LOADED message) ────────────────

export function loadCachedAudio(entries, resumePosition) {
    reset();
    ensureAudioContext();

    let relStart = 0;
    audioHistory = entries.map(e => {
        const data = e.data instanceof Float32Array ? e.data : new Float32Array(e.data);
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
    generationDone         = true;
    playbackStarted        = false; // wait for user click
    pausedAtTime           = resumePosition || 0;

    console.log(`[audio-player] loadCachedAudio: ${audioHistory.length} chunks, ${historyTotalDuration.toFixed(1)}s, resume at ${pausedAtTime.toFixed(2)}s`);
}

// ── Voice-switch restart ──────────────────────────────────────────────────────

export function getCurrentSentenceIndex() {
    return currentHighlightIndex;
}

/**
 * Called when the user switches voice mid-generation.
 * Stops all future-scheduled audio, trims audioHistory to entries already
 * played (sentenceIndex < fromSentenceIndex), and enters transition mode so
 * the first two new chunks buffer before playback resumes at 0.9× speed.
 */
export function trimAndRestartFrom(fromSentenceIndex) {
    console.log('[audio-player] trimAndRestartFrom:', fromSentenceIndex);

    stopAllSources();
    chunksAhead = 0;

    // Keep only history entries that have already been heard
    audioHistory = audioHistory.filter(
        e => e.sentenceIndex === undefined || e.sentenceIndex < fromSentenceIndex
    );

    // Recalculate durations from trimmed history
    if (audioHistory.length > 0) {
        const last = audioHistory[audioHistory.length - 1];
        historyTotalDuration = last.relStart + last.duration + (last.pauseAfter || 0);
    } else {
        historyTotalDuration = 0;
    }
    totalScheduledDuration = historyTotalDuration;

    // New chunks will schedule from the current AudioContext time
    if (audioContext && audioContext.state !== 'closed') {
        nextPlayTime = audioContext.currentTime + 0.08;
    }

    pendingChunks  = [];
    generationDone = false;
    killed         = false;

    // Freeze seeker at current position and stop the timer — don't suspend
    // AudioContext (Chrome blocks resume() from message callbacks).
    stopProgressTracking();
    if (audioContext) {
        const elapsed = audioContext.currentTime - firstChunkStartTime;
        pausedAtTime  = Math.max(0, elapsed);
        onProgressUpdate(
            historyTotalDuration > 0 ? Math.min((pausedAtTime / historyTotalDuration) * 100, 100) : 0,
            pausedAtTime,
            historyTotalDuration,
        );
    }
    isPlaying = false;
    onStateChange('loading');

    // Enter transition mode: wait for 2 chunks, play them at 0.9× user speed
    inVoiceTransition       = true;
    transitionPendingChunks = [];

    resetStallTimer();
    resetHighlightIndex();
}

// ── Highlight helpers ────────────────────────────────────────────────────────

// Determine which sentence is playing based on elapsed AudioContext time,
// and fire onSentencePlaying only when the sentence changes.
// This is called from the progress interval (100ms) — perfectly synced with audio.
function updateHighlightFromElapsed(elapsed) {
    if (audioHistory.length === 0) return;

    let activeSentence = -1;
    for (const entry of audioHistory) {
        if (entry.sentenceIndex === undefined) continue;
        if (entry.isMidChunk) continue;
        // This entry's audio starts at relStart and lasts for duration
        if (elapsed >= entry.relStart) {
            activeSentence = entry.sentenceIndex;
        } else {
            break; // audioHistory is chronological — no need to check further
        }
    }

    if (activeSentence >= 0 && activeSentence !== currentHighlightIndex) {
        currentHighlightIndex = activeSentence;
        onSentencePlaying(activeSentence);
    }
}

function resetHighlightIndex() {
    currentHighlightIndex = -1;
}

// ── GC: free Float32 sample data for chunks well behind current playback ─────

/**
 * Core GC: release Float32 sample data for all audioHistory entries whose
 * relStart + duration falls before `boundary` seconds.
 * Metadata is kept so seek/highlight continue to work for the retained window.
 */
function gcAtBoundary(boundary) {
    if (boundary <= gcWatermarkTime || boundary <= 0) return;
    if (audioHistory.length === 0) return;

    let releasedCount = 0;
    for (const entry of audioHistory) {
        if (entry.data && entry.relStart + entry.duration < boundary) {
            entry.data = null;
            releasedCount++;
        }
    }
    if (releasedCount > 0) {
        gcWatermarkTime = boundary;
        console.log(`[audio-player] GC: freed ${releasedCount} chunks before ${boundary.toFixed(1)}s`);
    }
}

/**
 * Periodic GC — called from the progress interval during active playback.
 * Skipped when not playing (isPlaying guard) to avoid work during pause.
 */
function gcReleasedChunks() {
    if (!audioContext || !isPlaying || audioHistory.length === 0) return;
    const elapsed = audioContext.currentTime - firstChunkStartTime;
    gcAtBoundary(elapsed - GC_LOOKBACK_SECONDS);
}

// ── Progress tracking ────────────────────────────────────────────────────────

function startProgressTracking() {
    stopProgressTracking();
    progressInterval = setInterval(() => {
        if (!audioContext || !isPlaying) return;
        if (totalScheduledDuration <= 0) return;

        const elapsed = audioContext.currentTime - firstChunkStartTime;
        const pct     = (elapsed / totalScheduledDuration) * 100;

        // ── Highlight: find which sentence is playing based on AudioContext time ──
        updateHighlightFromElapsed(elapsed);

        const now = Date.now();
        if (now - lastProgressNotify >= PROGRESS_THROTTLE_MS) {
            onProgressUpdate(
                Math.min(pct, 100),
                Math.max(0, elapsed),
                historyTotalDuration,
            );
            lastProgressNotify = now;
        }

        if (generationDone && elapsed >= totalScheduledDuration) {
            onPlaybackComplete();
        }

        // Run GC once per 5-second window. Using a last-run tracker instead of
        // modulo avoids the 10-consecutive-tick problem where Math.floor(elapsed)
        // stays the same value for all 100ms ticks within the same second.
        const elapsedSec = Math.floor(elapsed);
        if (elapsedSec % 5 === 0 && elapsedSec !== lastGcElapsedSec) {
            lastGcElapsedSec = elapsedSec;
            gcReleasedChunks();
        }
    }, 100);
}

function stopProgressTracking() {
    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }
}

function onPlaybackComplete() {
    stopProgressTracking();
    isPlaying = false;

    // Suspend the AudioContext — article is done, no need to hold the audio
    // hardware open. We suspend rather than close so the user can still seek.
    if (audioContext && audioContext.state === 'running') {
        audioContext.suspend().catch(() => {});
    }

    // Run a final GC pass. The normal gcReleasedChunks() is guarded by isPlaying,
    // so it would never run here. For long articles this can free hundreds of MB.
    gcAtBoundary(totalScheduledDuration - GC_LOOKBACK_SECONDS);

    onProgressUpdate(100, historyTotalDuration, historyTotalDuration);
    onStateChange('done');
    onStatusUpdate('Done');
}

// ── Generation stall detection ───────────────────────────────────────────────

function resetStallTimer() {
    clearStallTimer();
    if (!generationDone) {
        stallTimer = setTimeout(() => {
            console.warn('[audio-player] generation stall detected — no chunks for', STALL_TIMEOUT_MS, 'ms');
            onGenerationStall();
        }, STALL_TIMEOUT_MS);
    }
}

function clearStallTimer() {
    if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
    }
}
