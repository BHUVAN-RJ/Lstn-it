// service-worker.js — coordinates messages between popup and content script / TTS worker

chrome.runtime.onInstalled.addListener(() => {
    console.log('[service-worker] Kokoro TTS installed.');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const fromPopup = !sender.tab; // messages from popup have no sender.tab

    if (fromPopup && message.type === 'EXTRACT_TEXT') {
        // Forward to the active tab's content script
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tabId = tabs[0]?.id;
            if (!tabId) {
                sendResponse({ success: false, error: 'NO_TAB' });
                return;
            }
            chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_TEXT' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('[service-worker] content script error:', chrome.runtime.lastError.message);
                    sendResponse({ success: false, error: 'CONTENT_SCRIPT_ERROR' });
                } else {
                    sendResponse(response);
                }
            });
        });
        return true; // async
    }

    // Phase 3+: route TTS messages to/from the worker
    return false;
});
