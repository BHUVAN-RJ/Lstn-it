# AudiTex — On-Device Text-to-Speech Chrome Extension

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install-FA8072?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/auditex/YOUR_EXTENSION_ID)

A Chrome Extension (Manifest V3) that reads web pages aloud using the [Kokoro ONNX](https://github.com/thewh1teagle/kokoro-onnx) model. All inference runs **locally in your browser** — no server, no API calls, no data leaves your device.

**Current version: v0.3.2 — Dual-worker turbo mode**

---

## How it works

- A Web Worker generates audio in sentence-sized chunks using the Kokoro ONNX model running via WebAssembly.
- An offscreen document reorders chunks from parallel workers and persists them to IndexedDB.
- A content-script `AudioContext` schedules chunks ahead on the Web Audio clock for gapless playback.
- When generation falls behind playback, audio is stretched 0.9× using pitch-preserving WSOLA to hide the gap.

---

## Features

- **Fully on-device** — 310MB Kokoro ONNX model runs via ONNX Runtime Web (WebAssembly)
- **Streaming playback** — audio starts playing before the full article is processed
- **28 voices** — American/British English, male/female options
- **Turbo mode** — two parallel TTS workers for ~2× generation throughput (measured on M4 Mac mini, averaged over 50 sentences)
- **Sentence highlighting** — floating overlay highlights the sentence currently being read
- **Speed control** — 0.5×–2.0× playback speed with pitch-preserving WSOLA
- **Download** — export article audio as Opus or WAV
- **Floating widget** — draggable circle with radial controls; no page DOM modification
- **Offline after setup** — model cached in OPFS after first download

---

## Installation

### Prerequisites

- Node.js 18+
- Chrome (or any Chromium-based browser)
- The Kokoro ONNX model file (`kokoro-v1.0.onnx`, ~310MB) placed in `models/`

### Setup

```bash
# 1. Install dependencies
cd tts-extension
npm install

# 2. Build the extension
npm run build
```

> The Kokoro model (~310 MB) and voices auto-download from HuggingFace on first run and are cached locally — no manual setup needed.

### Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `dist/` folder
4. After any rebuild, click the **↺ reload** button on the extension card

> If a page was open before you loaded the extension, reload that tab first.

---

## Usage

1. Navigate to any article or text-heavy webpage
2. Click the **AudiTex** extension icon in the toolbar (or right-click → **Read aloud with AudiTex**)
3. A floating circle widget appears on the page — click it to start playback

### Widget controls

| Control | Action |
|---|---|
| Circle click | Play / Pause |
| Top-left (red) | Close / Stop |
| Top-right (salmon) | Download audio |
| Left radial | Speed slider (0.5×–2.0×) |
| Right radial | Voice selector |
| Bottom radial | Seek bar |

The widget is draggable — click and drag the circle to reposition it.

### Turbo mode

Turbo mode runs two TTS workers in parallel for faster generation. It is **on by default**. To disable:

```js
chrome.storage.local.set({ turboMode: false });
```

Note: turbo mode uses ~620MB RAM (two loaded ONNX sessions).

---

## Development

```bash
# Build once
npm run build

# Watch mode (rebuilds on file changes)
npm run dev

# Run tests
npm test
```

### Debugging

| Component | How to inspect |
|---|---|
| Content script + widget | Page DevTools → Console (prefix: `[content-script]`) |
| Service worker | `chrome://extensions` → "Service worker" → Inspect (prefix: `[service-worker]`) |
| Offscreen document | `chrome://extensions` → "offscreen.html" link (prefix: `[offscreen]`) |
| TTS Web Worker | `chrome://inspect` → Workers |

---

## Project Structure

```
tts-extension/
├── src/
│   ├── manifest.json
│   ├── background/
│   │   └── service-worker.js       # Message router, offscreen lifecycle + recovery
│   ├── content/
│   │   ├── content-script.js       # DOM extraction, widget injection, audio player host
│   │   └── audio-player.js         # AudioContext playback engine (lives in content script)
│   ├── offscreen/
│   │   ├── offscreen.html
│   │   └── offscreen.js            # TTS worker host, reorder buffer, IDB persistence
│   ├── worker/
│   │   ├── tts-worker.js           # Phonemize → tokenize → ONNX → Float32 audio
│   │   ├── phoneme-normalizer.js   # IPA → Kokoro phoneme normalization
│   │   └── tokenizer.js            # 178-token Kokoro vocabulary
│   ├── widget/
│   │   ├── widget.js               # Floating circle, radial menu, drag, shadow DOM
│   │   └── widget-styles.js        # CSS as JS template literal
│   ├── utils/
│   │   ├── text-cleaner.js         # DOM walker, quote normalization, emoji strip
│   │   ├── sentence-splitter.js    # Abbreviation-aware sentence splitter
│   │   └── audio-stretcher.js      # WSOLA pitch-preserving speed change
│   └── onboarding/
│       ├── onboarding.html         # First-run model download progress + error UI
│       └── onboarding.js
├── models/
│   ├── kokoro-v1.0.onnx            # 310MB — place here manually, then run copy-model
│   └── voices/                     # 28 voice .bin files (~510KB each)
├── test/
└── dist/                           # Built extension — load this in Chrome
```

---

## Architecture

### Components

- **Content script** — extracts page text, injects the floating widget, plays audio via `AudioContext`. Lives as long as the tab is open.
- **Offscreen document** — generation-only: hosts 1–2 TTS Web Workers, manages a reorder buffer for in-order delivery, persists chunks to IndexedDB.
- **Service worker** — message router between all components, manages offscreen document lifecycle and automatic recovery.

### Why audio lives in the content script

Chrome may kill the offscreen document after ~60s of inactivity. Moving `AudioContext` to the content script means playback is never interrupted — only generation pauses, and the extension auto-recovers generation without restarting audio.

### Dual-worker turbo mode (v0.3.2)

Two workers process alternating sentences in parallel (worker 0 → even sentences, worker 1 → odd sentences). A reorder buffer in the offscreen document guarantees correct sentence-order delivery to the audio player even when workers finish out of order.

---

## Model & Voices

The Kokoro v1.0 ONNX model is sourced from [BRJ45/Kokoro-tts-onnx](https://huggingface.co/BRJ45/Kokoro-tts-onnx) on HuggingFace. On first run, the extension downloads and caches the model and voices to OPFS (Origin Private File System). Downloads resume automatically if interrupted.

**Available voices** (28 total): `af_heart`, `af_alloy`, `af_aoede` (default), `am_adam`, `bm_george`, and more.

---

## License

ISC
