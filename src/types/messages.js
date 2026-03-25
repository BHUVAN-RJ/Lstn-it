// messages.js — JSDoc type definitions for all inter-context messages
//
// These are documentation-only types. No runtime code is exported.
// They describe the messages flowing between the four extension contexts:
//   - Service Worker (background/service-worker.js)
//   - Offscreen Document (offscreen/offscreen.js)
//   - Content Script (content/content-script.js + content/audio-player.js)
//   - TTS Worker (worker/tts-worker.js)

// ── Chrome Extension Message Types ──────────────────────────────────────────

/**
 * @typedef {Object} ExtractionResultMessage
 * @property {'EXTRACTION_RESULT'} type
 * @property {import('./sentence-splitter').Sentence[]} sentences - Array of extracted sentences
 * @property {number} wordCount - Total word count across all sentences
 * @property {string} title - Page title
 * @property {string} [pageUrl] - Full URL of the source page
 * @property {boolean} [autoPlay] - Whether to start playback immediately (default: true)
 */

/**
 * @typedef {Object} AudioChunkReadyMessage
 * @property {'AUDIO_CHUNK_READY'} type
 * @property {number[]} samples - Audio samples as plain Array (Float32 values, –1 to 1)
 * @property {number} sampleRate - Sample rate (always 24000 Hz for Kokoro)
 * @property {number} sentenceIndex - Zero-based index of the sentence this chunk belongs to
 * @property {number} total - Total number of sentences being generated
 * @property {boolean} countAsChunk - Whether this chunk counts toward the prebuffer threshold
 * @property {boolean} isMidChunk - True for overflow tails from long-sentence splitting
 * @property {boolean} endsWithParagraph - Whether a paragraph break follows this chunk
 * @property {boolean} endsWithSection - Whether a section break (h1/h2/h3) follows this chunk
 * @property {number} [pauseAfterMs] - Explicit pause override in milliseconds
 */

/**
 * @typedef {Object} GenerationDoneMessage
 * @property {'GENERATION_DONE'} type
 */

/**
 * @typedef {Object} PlaybackStateMessage
 * @property {'PLAYBACK_STATE'} type
 * @property {'loading'|'playing'|'paused'|'done'|'stopped'} state
 */

/**
 * @typedef {Object} StatusUpdateMessage
 * @property {'STATUS_UPDATE'} type
 * @property {string} text - Human-readable status string for the widget tooltip
 */

/**
 * @typedef {Object} ProgressUpdateMessage
 * @property {'PROGRESS_UPDATE'} type
 * @property {number} pct - Progress percentage (0–100)
 */

/**
 * @typedef {Object} ModelReadyMessage
 * @property {'MODEL_READY'} type
 */

/**
 * @typedef {Object} VoiceReadyMessage
 * @property {'VOICE_READY'} type
 * @property {string} voice - Voice name that was loaded (e.g. 'af_aoede')
 */

/**
 * @typedef {Object} ErrorMessage
 * @property {'ERROR'} type
 * @property {string} code - Error code (e.g. 'WORKER_CRASHED', 'DOWNLOAD_FAILED')
 * @property {string} [detail] - Human-readable error description
 */

/**
 * @typedef {Object} CacheLoadStartMessage
 * @property {'CACHE_LOAD_START'} type
 * @property {number} count - Total number of chunks to be streamed
 * @property {string} title - Article title from the cached record
 * @property {number} resumePosition - Saved playback position in seconds
 */

/**
 * @typedef {Object} CacheLoadChunkMessage
 * @property {'CACHE_LOAD_CHUNK'} type
 * @property {number[]} data - Audio samples as plain Array (decompressed from Int16)
 * @property {number} sampleRate - Sample rate in Hz
 * @property {boolean} countAsChunk - Whether this chunk counts toward prebuffer threshold
 * @property {number} sentenceIndex - Sentence index for highlight sync
 * @property {number} pauseAfter - Silence pause in seconds after this chunk
 */

/**
 * @typedef {Object} CacheLoadDoneMessage
 * @property {'CACHE_LOAD_DONE'} type
 */

/**
 * @typedef {Object} CacheLoadedMessage
 * @property {'CACHE_LOADED'} type
 * @property {Array<{data: number[], sampleRate: number, countAsChunk: boolean, sentenceIndex: number, pauseAfter: number}>} entries
 * @property {number} resumePosition - Saved playback position in seconds
 * @property {string} title - Article title
 */

/**
 * @typedef {Object} CacheMissMessage
 * @property {'CACHE_MISS'} type
 */

/**
 * @typedef {Object} DownloadReadyMessage
 * @property {'DOWNLOAD_READY'} type
 */

/**
 * @typedef {Object} DownloadAudioMessage
 * @property {'DOWNLOAD_AUDIO'} type
 * @property {string} url - Object URL pointing to the encoded audio blob
 * @property {string} filename - Suggested filename (e.g. 'article-title.ogg')
 */

/**
 * @typedef {Object} OffscreenReadyMessage
 * @property {'OFFSCREEN_READY'} type
 */

/**
 * @typedef {Object} OnboardingReadyMessage
 * @property {'ONBOARDING_READY'} type
 */

/**
 * @typedef {Object} ShowWidgetMessage
 * @property {'SHOW_WIDGET'} type
 * @property {'loading'|'playing'|'paused'} [initialState]
 */

/**
 * @typedef {Object} ExtractAndPlayMessage
 * @property {'EXTRACT_AND_PLAY'} type
 */

/**
 * @typedef {Object} ExtractAndStageMessage
 * @property {'EXTRACT_AND_STAGE'} type
 */

/**
 * @typedef {Object} ExtractForHighlightMessage
 * @property {'EXTRACT_FOR_HIGHLIGHT'} type
 */

/**
 * @typedef {Object} QueryCacheMessage
 * @property {'QUERY_CACHE'} type
 * @property {string} url - Page URL to check
 */

/**
 * @typedef {Object} QueryCacheResponse
 * @property {boolean} hit - Whether a non-expired cache entry exists
 * @property {boolean} hasAudio - Whether audio is loaded in memory (always false from offscreen)
 * @property {boolean} generating - Whether generation is currently in progress for this URL
 */

/**
 * @typedef {Object} LoadFromCacheMessage
 * @property {'LOAD_FROM_CACHE'} type
 * @property {string} url - Page URL to load audio for
 */

/**
 * @typedef {Object} ResumeGenerationMessage
 * @property {'RESUME_GENERATION'} type
 * @property {string} url - Page URL to resume generation for
 */

/**
 * @typedef {Object} CheckAliveMessage
 * @property {'CHECK_ALIVE'} type
 */

/**
 * @typedef {Object} CheckAliveResponse
 * @property {boolean} alive - Always true (offscreen is alive if it responds)
 * @property {boolean} modelReady - Whether the ONNX session is initialised
 * @property {boolean} generating - Whether generation is currently running
 */

/**
 * @typedef {Object} CheckOffscreenHealthMessage
 * @property {'CHECK_OFFSCREEN_HEALTH'} type
 */

/**
 * @typedef {Object} QueryPlaybackStateMessage
 * @property {'QUERY_PLAYBACK_STATE'} type
 */

/**
 * @typedef {Object} QueryPlaybackStateResponse
 * @property {boolean} hasAudio - Whether the audio player has loaded audio data
 * @property {boolean} isPlaying - Whether audio is currently playing
 * @property {boolean} generationDone - Whether all sentences have been generated
 * @property {number} lastSentenceIndex - Highest sentence index seen so far
 * @property {boolean} playbackStarted - Whether startPlayback() has run
 */

/**
 * @typedef {Object} WidgetActionMessage
 * @property {'WIDGET_ACTION'} type
 * @property {WidgetActionType} action
 * @property {string} [voice] - For SWITCH_VOICE / VOICE_SWITCH_RESTART
 * @property {number} [speed] - For SET_SPEED
 * @property {number} [pausedAtTime] - For CLOSE_WIDGET
 * @property {number} [fromSentenceIndex] - For VOICE_SWITCH_RESTART
 */

/**
 * @typedef {'TOGGLE_PLAY_PAUSE'|'SEEK_TO'|'SET_SPEED'|'SWITCH_VOICE'|'VOICE_SWITCH_RESTART'|'STOP'|'CLOSE_WIDGET'|'REQUEST_DOWNLOAD'|'TOGGLE_READ_MODE'|'SET_READ_WPM'} WidgetActionType
 */

/**
 * @typedef {Object} PageUnloadMessage
 * @property {'PAGE_UNLOAD'} type
 * @property {string} url - Page URL that is unloading
 */

/**
 * @typedef {Object} SavePositionMessage
 * @property {'SAVE_POSITION'} type
 * @property {number} position - Current playback position in seconds
 */

/**
 * @typedef {Object} CancelAllMessage
 * @property {'CANCEL_ALL'} type
 */

// ── TTS Worker Message Types ──────────────────────────────────────────────────

/**
 * @typedef {Object} WorkerLoadModelMessage
 * @property {'LOAD_MODEL'} type
 * @property {string} voice - Voice name to load initially (e.g. 'af_aoede')
 * @property {string} wasmPaths - Base URL for WASM files (extension URL)
 * @property {string} remoteModelUrl - HuggingFace URL for the ONNX model
 * @property {string} remoteVoiceBaseUrl - HuggingFace base URL for voice .bin files
 * @property {string} modelUrl - Local extension URL for the ONNX model (dev only)
 * @property {string} voiceBaseUrl - Local extension URL for voice .bin files (dev only)
 */

/**
 * @typedef {Object} WorkerGenerateAudioMessage
 * @property {'GENERATE_AUDIO'} type
 * @property {import('../utils/sentence-splitter').Sentence[]} sentences
 * @property {number} speed - Speed multiplier (always 1.0 — WSOLA applied in content script)
 * @property {string} voice - Voice name
 * @property {number} genId - Generation ID for cancellation/stale-chunk detection
 * @property {number} [indexOffset] - First sentence's absolute index (for resume)
 */

/**
 * @typedef {Object} WorkerSwitchVoiceMessage
 * @property {'SWITCH_VOICE'} type
 * @property {string} voice - New voice name
 */

/**
 * @typedef {Object} WorkerCancelMessage
 * @property {'CANCEL'} type
 */

/**
 * @typedef {Object} WorkerLoadingProgressMessage
 * @property {'LOADING_PROGRESS'} type
 * @property {'wasm'|'downloading'|'retrying'|'saving'|'model_cached'|'model'|'voice'|'done'} stage
 * @property {number} pct - Progress percentage (0–100)
 */

/**
 * @typedef {Object} WorkerModelReadyMessage
 * @property {'MODEL_READY'} type
 * @property {string} voice - Voice that was loaded
 */

/**
 * @typedef {Object} WorkerPhonemesReadyMessage
 * @property {'PHONEMES_READY'} type
 * @property {number} index - Sentence index
 * @property {number} total - Total number of sentences
 * @property {string} phonemes - IPA phoneme string after normalization
 */

/**
 * @typedef {Object} WorkerAudioChunkMessage
 * @property {'AUDIO_CHUNK'} type
 * @property {number} genId - Generation ID (for cancellation check)
 * @property {number} index - Sentence index (absolute, including indexOffset)
 * @property {number} total - Total number of sentences in the job
 * @property {Float32Array} samples - Audio samples at 24 kHz
 * @property {number} sampleRate - Always 24000
 * @property {boolean} endsWithParagraph
 * @property {boolean} endsWithSection
 * @property {boolean} isMidChunk - True for overflow tails from long-sentence splitting
 * @property {boolean} countAsChunk - Whether this chunk counts toward prebuffer depth
 * @property {number} [pauseAfterMs] - Explicit pause override in milliseconds
 */

/**
 * @typedef {Object} WorkerGenerationDoneMessage
 * @property {'GENERATION_DONE'} type
 * @property {number} genId - Generation ID for this completed job
 * @property {number} total - Total number of sentences that were generated
 */

/**
 * @typedef {Object} WorkerVoiceReadyMessage
 * @property {'VOICE_READY'} type
 * @property {string} voice - Voice name that was successfully loaded
 */

/**
 * @typedef {Object} WorkerDownloadFailedMessage
 * @property {'DOWNLOAD_FAILED'} type
 * @property {string} [detail] - Human-readable failure reason
 */

/**
 * @typedef {Object} WorkerErrorMessage
 * @property {'ERROR'} type
 * @property {string} code - Error code
 * @property {string} [detail] - Human-readable error description
 */
