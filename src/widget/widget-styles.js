// widget-styles.js — CSS for floating circle widget (injected into shadow root)

export const WIDGET_CSS = `
/* ── Host reset ──────────────────────────────────────────────────────────── */
:host {
    all: initial;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    color: #fff;
}

/* ── Widget container ────────────────────────────────────────────────────── */
.tts-widget {
    position: relative;
    pointer-events: auto;
    width: 56px;
    height: 56px;
}

/* ── Main circle ─────────────────────────────────────────────────────────── */
.tts-circle {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: #FA8072;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
    position: relative;
    z-index: 2;
    outline: none;
}

.tts-circle:hover {
    transform: scale(1.08);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
}

.tts-circle:active {
    transform: scale(0.95);
}

/* ── Circle icons ────────────────────────────────────────────────────────── */
.tts-circle-icon {
    width: 24px;
    height: 24px;
    fill: #fff;
}

/* ── Playing pulse ring ──────────────────────────────────────────────────── */
.tts-circle.playing::after {
    content: '';
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    border: 2px solid #FA8072;
    animation: tts-pulse 1.5s ease-in-out infinite;
}

@keyframes tts-pulse {
    0% { transform: scale(1); opacity: 0.7; }
    50% { transform: scale(1.25); opacity: 0; }
    100% { transform: scale(1); opacity: 0; }
}

/* ── Loading spinner ─────────────────────────────────────────────────────── */
.tts-circle.loading::after {
    content: '';
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    border: 3px solid transparent;
    border-top-color: #FA8072;
    animation: tts-spin 0.8s linear infinite;
}

@keyframes tts-spin {
    to { transform: rotate(360deg); }
}

/* ── Radial menu ─────────────────────────────────────────────────────────── */
.tts-radial {
    position: absolute;
    top: 50%;
    left: 50%;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s ease;
}

.tts-widget:hover .tts-radial,
.tts-widget.menu-open .tts-radial {
    pointer-events: auto;
    opacity: 1;
}

/* ── Radial items ────────────────────────────────────────────────────────── */
.tts-radial-item {
    position: absolute;
    transform: translate(-50%, -50%) scale(0.5);
    transition: transform 0.25s ease, opacity 0.25s ease;
    opacity: 0;
}

.tts-widget:hover .tts-radial-item,
.tts-widget.menu-open .tts-radial-item {
    opacity: 1;
}

/* Close + Download buttons — 12 o'clock (top) */
.tts-radial-item.pos-top {
    transform: translate(-50%, -50%);
}
.tts-widget:hover .tts-radial-item.pos-top,
.tts-widget.menu-open .tts-radial-item.pos-top {
    transform: translate(-50%, -50%) translateY(-58px) scale(1);
}

/* Speed control — 9 o'clock (left) */
.tts-radial-item.pos-left {
    transform: translate(-50%, -50%);
}
.tts-widget:hover .tts-radial-item.pos-left,
.tts-widget.menu-open .tts-radial-item.pos-left {
    transform: translate(-50%, -50%) translate(-110px, 0) scale(1);
}

/* Voice picker — 3 o'clock (right) */
.tts-radial-item.pos-right {
    transform: translate(-50%, -50%);
}
.tts-widget:hover .tts-radial-item.pos-right,
.tts-widget.menu-open .tts-radial-item.pos-right {
    transform: translate(-50%, -50%) translate(110px, 0) scale(1);
}

/* Seeker — 6 o'clock (bottom) */
.tts-radial-item.pos-bottom {
    transform: translate(-50%, -50%);
}
.tts-widget:hover .tts-radial-item.pos-bottom,
.tts-widget.menu-open .tts-radial-item.pos-bottom {
    transform: translate(-50%, -50%) translateY(50px) scale(1);
}

/* ── Top controls row (close + download) ─────────────────────────────────── */
.tts-top-controls {
    display: flex;
    align-items: center;
    gap: 16px;
}

/* ── Close button ────────────────────────────────────────────────────────── */
.tts-close-btn {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: #ef4444;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: transform 0.15s ease, background 0.15s ease;
}

.tts-close-btn:hover {
    background: #dc2626;
    transform: scale(1.1);
}

.tts-close-btn svg {
    width: 13px;
    height: 13px;
    fill: #fff;
}

/* ── Download circle button ──────────────────────────────────────────────── */
.tts-download-circle-btn {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: #FA8072;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: transform 0.15s ease, background 0.15s ease, opacity 0.15s ease;
}

.tts-download-circle-btn:hover {
    background: #e8604e;
    transform: scale(1.1);
}

.tts-download-circle-btn.queued {
    opacity: 0.55;
}

.tts-download-circle-btn svg {
    width: 13px;
    height: 13px;
    fill: #fff;
}

/* ── Shared control container (voice + speed + seeker use same base) ─────── */
.tts-control-container {
    background: #1e1e2e;
    border-radius: 8px;
    padding: 6px 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    white-space: nowrap;
    width: 130px;
    height: 34px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 6px;
}

/* Seeker is a bit wider for usability */
.tts-seeker-container {
    width: 150px;
}

/* ── Label shared by all controls ────────────────────────────────────────── */
.tts-control-label {
    color: #94a3b8;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
}

/* ── Voice picker ────────────────────────────────────────────────────────── */
.tts-voice-select {
    background: #2a2a3e;
    color: #e2e8f0;
    border: 1px solid #4a4a6a;
    border-radius: 4px;
    padding: 3px 4px;
    font-size: 11px;
    cursor: pointer;
    outline: none;
    flex: 1;
    min-width: 0;
}

.tts-voice-select:focus {
    border-color: #FA8072;
}

/* ── Speed / Seeker slider ───────────────────────────────────────────────── */
.tts-speed-slider {
    -webkit-appearance: none;
    appearance: none;
    flex: 1;
    min-width: 0;
    height: 4px;
    border-radius: 2px;
    background: #4a4a6a;
    outline: none;
    cursor: pointer;
}

.tts-speed-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #FA8072;
    cursor: pointer;
}

.tts-speed-value,
.tts-seeker-time {
    color: #fca99b;
    font-size: 11px;
    font-weight: 600;
    min-width: 28px;
    text-align: right;
    flex-shrink: 0;
}

/* ── Voice change notification ───────────────────────────────────────────── */
.tts-voice-notify {
    color: #fca99b;
    font-size: 10px;
    font-weight: 600;
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    animation: tts-notify-fade 2s ease forwards;
}

@keyframes tts-notify-fade {
    0%   { opacity: 0; }
    12%  { opacity: 1; }
    75%  { opacity: 1; }
    100% { opacity: 0; }
}

/* ── Dragging ────────────────────────────────────────────────────────────── */
.tts-widget.dragging {
    cursor: grabbing;
    user-select: none;
}

.tts-widget.dragging .tts-circle {
    cursor: grabbing;
    transform: scale(1.1);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}

.tts-widget.dragging .tts-radial {
    opacity: 0;
    pointer-events: none;
}

/* ── Hidden state ────────────────────────────────────────────────────────── */
.tts-widget.hidden {
    display: none;
}

`;
