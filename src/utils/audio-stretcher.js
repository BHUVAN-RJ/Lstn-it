// audio-stretcher.js — WSOLA time-scale modification for speech audio
//
// Stretches or compresses audio in time without changing pitch.
// Used for:
//   - Adaptive playback slowdown (buying inference time when the buffer runs thin)
//   - Phase 8 user-facing speed controls (0.5x–2.0x)
//
// Algorithm: WSOLA (Waveform Similarity Overlap-Add)
//   Like plain OLA, but with a cross-correlation search that finds the
//   best-matching analysis position near the natural position. This aligns
//   phases across overlapping frames, eliminating the muffled/fluttery
//   artifacts of plain OLA at near-unity speeds.
//
//   Self-correlation trap: when the "trivially correct" position (prevBestAna
//   + hopSyn) falls inside the search range, its autocorrelation always wins,
//   causing the input to advance by hopSyn instead of hopAna → wrong speed.
//   Fix: exclude a small zone around that position from the search.

// ── Constants ─────────────────────────────────────────────────────────────────

const WINDOW_SIZE = 1024;  // ~43 ms at 24 kHz — spans several pitch periods
const HOP_SIZE    = 256;   // 25% advance → 75% overlap (COLA-compliant for Hann)

// WSOLA search parameters
const SEARCH_DELTA     = 128; // search ±128 samples around natural analysis position
const CORR_STEP        = 4;   // subsample correlation (every 4th sample) for speed
const SELF_CORR_MARGIN = 6;   // exclude ±6 samples around the self-correlation point

// Pre-computed Hann window — module-level singleton, zero allocation on the hot path.
const HANN_WINDOW = (() => {
    const w = new Float32Array(WINDOW_SIZE);
    for (let i = 0; i < WINDOW_SIZE; i++) {
        w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW_SIZE - 1));
    }
    return w;
})();

// ── Fallback: linear interpolation for very short clips ──────────────────────

function linearResample(samples, speed) {
    const outLen = Math.round(samples.length / speed);
    const output = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const srcPos = i * speed;
        const srcIdx = Math.floor(srcPos);
        const frac   = srcPos - srcIdx;
        const s0     = srcIdx     < samples.length ? samples[srcIdx]     : 0;
        const s1     = srcIdx + 1 < samples.length ? samples[srcIdx + 1] : 0;
        output[i]    = s0 + frac * (s1 - s0);
    }
    return output;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Time-stretch `samples` by `speed` using WSOLA.
 *
 * speed > 1  → shorter output  (plays faster), e.g. 1.5 for 1.5×
 * speed < 1  → longer output   (plays slower), e.g. 0.9 for 0.9×
 * speed ≈ 1  → passthrough     (returns the SAME Float32Array, zero allocation)
 *
 * Output sample rate is identical to input — only duration changes.
 * Pitch is fully preserved regardless of speed.
 *
 * @param {Float32Array} samples  Raw mono PCM at any sample rate
 * @param {number}       speed    Multiplier, clamped internally to [0.25, 4.0]
 * @returns {Float32Array}
 */
export function stretchAudio(samples, speed) {
    if (Math.abs(speed - 1.0) < 0.005) return samples;

    const clampedSpeed = Math.max(0.25, Math.min(4.0, speed));

    // Very short clips: WSOLA would produce only 1-2 frames — use linear
    // resampling instead (simpler and artefact-free for very short audio).
    if (samples.length < WINDOW_SIZE * 2) {
        return linearResample(samples, clampedSpeed);
    }

    const hopSyn    = HOP_SIZE;
    const hopAna    = Math.round(HOP_SIZE * clampedSpeed);
    const overlapLen = WINDOW_SIZE - hopSyn; // samples in the overlap region

    const trimLen = Math.round(samples.length / clampedSpeed);
    const outLen  = trimLen + WINDOW_SIZE; // extra room so the loop never overflows

    const output = new Float32Array(outLen);
    const sumW   = new Float32Array(outLen); // accumulated Hann weights for normalisation

    let synthPos    = 0;
    let prevBestAna = 0; // analysis position chosen for the previous frame
    let frameIdx    = 0;

    while (synthPos + WINDOW_SIZE <= outLen) {
        const natAna = frameIdx * hopAna;
        let bestAna;

        if (frameIdx < 2) {
            // First two frames: no meaningful accumulated output to correlate
            // against — use plain OLA (no search). Phase error is negligible
            // at the very start.
            bestAna = natAna;
        } else {
            // Monotonic constraint: analysis must always advance forward through
            // the input. Without this, the search can jump backwards and repeat
            // content, causing audible overlap of consecutive sentences.
            const searchStart = Math.max(prevBestAna + 1, natAna - SEARCH_DELTA);
            const searchEnd   = Math.min(samples.length - WINDOW_SIZE, natAna + SEARCH_DELTA);

            if (searchStart >= searchEnd) {
                bestAna = Math.min(natAna, Math.max(0, samples.length - WINDOW_SIZE));
            } else {
                // Self-correlation exclusion zone: the position prevBestAna + hopSyn
                // would give trivially perfect phase continuity with the previous
                // frame, but at the wrong time-advance (hopSyn instead of hopAna).
                // Excluding this zone forces the search to find a genuinely good
                // phase match at approximately the correct speed.
                const selfCorrPos = prevBestAna + hopSyn;
                const excludeLo   = selfCorrPos - SELF_CORR_MARGIN;
                const excludeHi   = selfCorrPos + SELF_CORR_MARGIN;

                bestAna = natAna; // fallback: natural position
                let bestCorr = -Infinity;

                // Correlate each candidate against the accumulated (unnormalized)
                // output at the overlap region. The output is a Hann-weighted blend
                // of multiple prior frames — no single candidate can self-correlate
                // trivially (and we also exclude the nearest self-corr zone).
                for (let c = searchStart; c <= searchEnd; c++) {
                    // Skip the self-correlation zone
                    if (c >= excludeLo && c <= excludeHi) continue;

                    let corr = 0;
                    for (let i = 0; i < overlapLen; i += CORR_STEP) {
                        corr += output[synthPos + i] * samples[c + i];
                    }
                    if (corr > bestCorr) {
                        bestCorr = corr;
                        bestAna  = c;
                    }
                }
            }
        }

        if (bestAna + WINDOW_SIZE > samples.length) break;

        // Overlap-add with Hann window at the chosen analysis position.
        for (let i = 0; i < WINDOW_SIZE; i++) {
            const w              = HANN_WINDOW[i];
            output[synthPos + i] += samples[bestAna + i] * w;
            sumW  [synthPos + i] += w;
        }

        prevBestAna = bestAna;
        synthPos   += hopSyn;
        frameIdx++;
    }

    // Divide out accumulated window weights to eliminate OLA amplitude ripple.
    for (let i = 0; i < outLen; i++) {
        if (sumW[i] > 1e-6) output[i] /= sumW[i];
    }

    return output.subarray(0, trimLen);
}
