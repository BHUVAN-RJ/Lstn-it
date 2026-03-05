// opus-encoder.js — Encodes Float32 PCM audio to Ogg Opus using Web Codecs AudioEncoder.
//
// Requirements: Chrome 94+ (Web Codecs API). Falls back gracefully if unsupported.
// Output: Ogg Opus file (.ogg) — typically 10–20× smaller than WAV for TTS speech.
//
// Usage:
//   import { encodeToOpus } from './opus-encoder.js';
//   const oggBuffer = await encodeToOpus(float32Samples, 24000);

const OPUS_BITRATE   = 32000; // 32 kbps — excellent quality for speech TTS
const FRAME_MS       = 20;    // 20ms Opus frame (standard; supported at all sample rates)

/**
 * Encode a mono Float32Array of PCM audio to an Ogg Opus ArrayBuffer.
 *
 * @param {Float32Array} samples    - mono PCM samples
 * @param {number}       sampleRate - input sample rate (e.g. 24000)
 * @param {number}       bitrate    - target bitrate in bps (default 32000)
 * @returns {Promise<ArrayBuffer>}  Ogg Opus file bytes
 * @throws {Error} if AudioEncoder is unavailable or encoding fails
 */
export async function encodeToOpus(samples, sampleRate = 24000, bitrate = OPUS_BITRATE) {
    if (typeof AudioEncoder === 'undefined') {
        throw new Error('Web Codecs AudioEncoder not available');
    }

    // Check codec support before starting
    const support = await AudioEncoder.isConfigSupported({
        codec: 'opus',
        sampleRate,
        numberOfChannels: 1,
        bitrate,
    });
    if (!support.supported) {
        throw new Error('Opus encoding not supported in this environment');
    }

    const FRAME_SAMPLES = Math.round(sampleRate * FRAME_MS / 1000); // 480 at 24kHz
    const chunks = []; // { buf: ArrayBuffer, timestamp: number (µs) }
    let encodeError = null;

    const encoder = new AudioEncoder({
        output(chunk) {
            const buf = new ArrayBuffer(chunk.byteLength);
            chunk.copyTo(buf);
            chunks.push({ buf, timestamp: chunk.timestamp });
        },
        error(err) { encodeError = err; },
    });

    encoder.configure({
        codec: 'opus',
        sampleRate,
        numberOfChannels: 1,
        bitrate,
    });

    // Feed audio in FRAME_SAMPLES-sized frames; pad the last frame with silence
    const frameUs = Math.round(FRAME_SAMPLES / sampleRate * 1_000_000); // µs per frame
    let timestamp = 0; // µs

    for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
        let frame;
        if (offset + FRAME_SAMPLES <= samples.length) {
            frame = samples.subarray(offset, offset + FRAME_SAMPLES);
        } else {
            frame = new Float32Array(FRAME_SAMPLES);
            frame.set(samples.subarray(offset));
        }

        const audioData = new AudioData({
            format:           'f32',
            sampleRate,
            numberOfFrames:   FRAME_SAMPLES,
            numberOfChannels: 1,
            timestamp,
            data:             frame,
        });
        encoder.encode(audioData);
        audioData.close();
        timestamp += frameUs;
    }

    await encoder.flush();
    encoder.close();

    if (encodeError) throw encodeError;

    return muxOggOpus(chunks, sampleRate, frameUs);
}

// ── Minimal Ogg Opus container muxer ─────────────────────────────────────────
//
// Produces a valid Ogg Opus file per RFC 7845.
// One Opus frame per Ogg page (simple; ~35-byte overhead per 20ms frame).

function muxOggOpus(chunks, inputSampleRate, frameUs) {
    const serialNo = (Math.random() * 0xFFFFFFFF) >>> 0;
    let pageSeq = 0;
    const pages = [];

    // Page 1: Opus identification header
    pages.push(buildOggPage(buildOpusHead(inputSampleRate), 0x02 /* BOS */, BigInt(0), serialNo, pageSeq++));

    // Page 2: Opus comment header (minimal — vendor string only)
    pages.push(buildOggPage(buildOpusTags(), 0x00, BigInt(0), serialNo, pageSeq++));

    // Audio pages — one Opus frame per page
    // Granule position: end of frame in 48kHz samples (Ogg Opus always uses 48kHz clock)
    const samplesPerFrame48k = Math.round(frameUs / 1e6 * 48000); // e.g. 960 at 24kHz input
    for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const granule48k = BigInt((i + 1) * samplesPerFrame48k);
        const flags = isLast ? 0x04 /* EOS */ : 0x00;
        pages.push(buildOggPage(chunks[i].buf, flags, granule48k, serialNo, pageSeq++));
    }

    // Concatenate all pages into one ArrayBuffer
    const totalBytes = pages.reduce((s, p) => s + p.byteLength, 0);
    const out = new Uint8Array(totalBytes);
    let offset = 0;
    for (const page of pages) {
        out.set(new Uint8Array(page), offset);
        offset += page.byteLength;
    }
    return out.buffer;
}

// ── Ogg Opus header packets ───────────────────────────────────────────────────

function buildOpusHead(inputSampleRate) {
    // OpusHead v1, mono, no pre-skip, input sample rate, gain=0, mapping family 0
    const buf = new ArrayBuffer(19);
    const u   = new Uint8Array(buf);
    const dv  = new DataView(buf);
    // "OpusHead"
    u[0]=0x4F; u[1]=0x70; u[2]=0x75; u[3]=0x73; u[4]=0x48; u[5]=0x65; u[6]=0x61; u[7]=0x64;
    dv.setUint8(8,  1);                      // version
    dv.setUint8(9,  1);                      // channel count
    dv.setUint16(10, 0, true);               // pre-skip (0)
    dv.setUint32(12, inputSampleRate, true); // original input sample rate (informational)
    dv.setInt16(16, 0, true);               // output gain
    dv.setUint8(18, 0);                     // channel mapping family 0 (mono/stereo)
    return buf;
}

function buildOpusTags() {
    // Minimal OpusTags: vendor string + empty user comment list
    const vendor    = 'AudiTex';
    const enc       = new TextEncoder();
    const vendorEnc = enc.encode(vendor);
    const buf = new ArrayBuffer(8 + 4 + vendorEnc.length + 4);
    const u   = new Uint8Array(buf);
    const dv  = new DataView(buf);
    // "OpusTags"
    u[0]=0x4F; u[1]=0x70; u[2]=0x75; u[3]=0x73; u[4]=0x54; u[5]=0x61; u[6]=0x67; u[7]=0x73;
    dv.setUint32(8, vendorEnc.length, true);
    vendorEnc.forEach((b, i) => u[12 + i] = b);
    dv.setUint32(12 + vendorEnc.length, 0, true); // user comment list length = 0
    return buf;
}

// ── Ogg page builder ──────────────────────────────────────────────────────────

function buildOggPage(dataBuffer, headerType, granulePos, serialNo, pageSeq) {
    const data = new Uint8Array(dataBuffer);

    // Lacing: split payload into 255-byte segments
    const segs = [];
    let rem = data.length;
    while (rem > 255) { segs.push(255); rem -= 255; }
    segs.push(rem);

    const headerSize = 27 + segs.length;
    const page = new Uint8Array(headerSize + data.length);
    const dv   = new DataView(page.buffer);

    // Ogg page capture pattern
    page[0]=0x4F; page[1]=0x67; page[2]=0x67; page[3]=0x53; // "OggS"
    page[4] = 0;           // stream structure version
    page[5] = headerType;
    // Granule position — int64 little-endian (in 48kHz samples for Ogg Opus)
    dv.setUint32(6,  Number(granulePos & BigInt(0xFFFFFFFF)), true);
    dv.setUint32(10, Number((granulePos >> BigInt(32)) & BigInt(0xFFFFFFFF)), true);
    dv.setUint32(14, serialNo, true);
    dv.setUint32(18, pageSeq, true);
    dv.setUint32(22, 0, true); // CRC placeholder — filled in below
    page[26] = segs.length;
    segs.forEach((s, i) => page[27 + i] = s);
    page.set(data, headerSize);

    // Ogg CRC-32 with CRC bytes zeroed (already are)
    dv.setUint32(22, oggCRC32(page), true);

    return page.buffer;
}

// ── Ogg CRC-32 (polynomial 0x04C11DB7, no pre/post-conditioning) ─────────────

const OGG_CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let r = i << 24;
        for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1);
        t[i] = r >>> 0;
    }
    return t;
})();

function oggCRC32(data) {
    let crc = 0;
    for (let i = 0; i < data.length; i++) {
        crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ data[i]) & 0xFF]) >>> 0;
    }
    return crc;
}
