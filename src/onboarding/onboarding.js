// onboarding.js — Welcome + first-run setup page for AudiTex

function showDone() {
    document.getElementById('progress-section').style.display = 'none';
    document.getElementById('done-banner').classList.add('visible');
}

function updateProgress(pct, text) {
    const fill = document.getElementById('progress-fill');
    const status = document.getElementById('progress-text');
    if (fill && pct != null) fill.style.width = pct + '%';
    if (status && text != null) status.textContent = text;
}

document.addEventListener('DOMContentLoaded', () => {

    // ── Listen for progress from service worker ──────────────────────────────
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'PROGRESS_UPDATE') {
            updateProgress(message.pct, null);
        } else if (message.type === 'STATUS_UPDATE') {
            updateProgress(null, message.text);
        } else if (message.type === 'MODEL_READY') {
            updateProgress(100, 'Ready');
            // Small delay so the 100% fill animation plays before switching
            setTimeout(showDone, 400);
        }
    });

    // ── Trigger offscreen init via service worker ────────────────────────────
    // SW will call ensureOffscreenDocument() which auto-starts the worker + download.
    chrome.runtime.sendMessage({ type: 'ONBOARDING_READY' }).catch(() => {});
});
