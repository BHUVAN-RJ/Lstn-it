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
    // Hide error section when progress resumes
    const errorSection = document.getElementById('error-section');
    if (errorSection && pct > 0) errorSection.style.display = 'none';
}

function showError(detail) {
    const errorSection = document.getElementById('error-section');
    const errorText = document.getElementById('error-text');
    const progressText = document.getElementById('progress-text');
    if (errorSection) errorSection.style.display = 'block';
    if (errorText) errorText.textContent = detail || 'Download failed — check your connection and try again.';
    if (progressText) progressText.textContent = 'Download interrupted';
}

document.addEventListener('DOMContentLoaded', () => {

    // ── Listen for progress from service worker ──────────────────────────
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'PROGRESS_UPDATE') {
            updateProgress(message.pct, null);
        } else if (message.type === 'STATUS_UPDATE') {
            updateProgress(null, message.text);
        } else if (message.type === 'MODEL_READY') {
            updateProgress(100, 'Ready');
            setTimeout(showDone, 400);
        } else if (message.type === 'ERROR' && message.code === 'WORKER_ERROR') {
            // Worker-level error during download
            showError(message.detail);
        }
    });

    // ── Retry button ─────────────────────────────────────────────────────
    const retryBtn = document.getElementById('retry-btn');
    if (retryBtn) {
        retryBtn.addEventListener('click', () => {
            document.getElementById('error-section').style.display = 'none';
            updateProgress(0, 'Retrying download\u2026');
            // Re-trigger offscreen init which restarts the worker + download
            chrome.runtime.sendMessage({ type: 'ONBOARDING_READY' }).catch(() => {});
        });
    }

    // ── Voice preference picker ───────────────────────────────────────────
    const voiceSelect = document.getElementById('voice-select');
    const voiceSavedNote = document.getElementById('voice-saved-note');
    let voiceSavedTimeout = null;

    // Load current saved voice and apply it to the picker
    chrome.storage.local.get(['voice']).then((result) => {
        if (result.voice && voiceSelect.querySelector(`option[value="${result.voice}"]`)) {
            voiceSelect.value = result.voice;
        }
    }).catch(() => {});

    voiceSelect.addEventListener('change', () => {
        const selectedVoice = voiceSelect.value;
        chrome.storage.local.set({ voice: selectedVoice }).catch(() => {});

        // Show brief confirmation
        voiceSavedNote.classList.add('show');
        clearTimeout(voiceSavedTimeout);
        voiceSavedTimeout = setTimeout(() => {
            voiceSavedNote.classList.remove('show');
        }, 1800);
    });

    // ── Trigger offscreen init via service worker ────────────────────────
    chrome.runtime.sendMessage({ type: 'ONBOARDING_READY' }).catch(() => {});
});
