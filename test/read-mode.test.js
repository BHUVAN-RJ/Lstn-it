// read-mode.test.js — Unit tests for src/content/read-mode.js
//
// Uses the node environment (default). chrome.storage.local is mocked in test/setup.js.
// Fake timers are used so setTimeout-driven advancement can be controlled.

import {
    initReadMode,
    isEnabled,
    isPaused,
    getWpm,
    getSentenceIndex,
    getSentences,
    setSentences,
    getPageUrl,
    setPageUrl,
    startReadMode,
    stopReadMode,
    toggleReadModePlayPause,
    adjustWpm,
    loadReadModePreferences,
    getPositionKey,
    DEFAULT_WPM,
    MIN_WPM,
    MAX_WPM,
} from '../src/content/read-mode.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a simple array of sentence objects for testing. */
function makeSentences(count) {
    const sentences = [];
    for (let i = 0; i < count; i++) {
        sentences.push({ text: `Sentence number ${i + 1} has several words in it.` });
    }
    return sentences;
}

// ── Module resets between tests ───────────────────────────────────────────────
// read-mode.js is a singleton — we need to stop any running timers and reset
// state between tests so they don't interfere with each other.

beforeEach(() => {
    jest.useFakeTimers();
    // Stop any ongoing session from a previous test
    stopReadMode();
    // Reset sentences and URL
    setSentences([]);
    setPageUrl('');
    // Re-initialise with no-op callbacks so stale callbacks don't carry over
    initReadMode({
        stateChange:    () => {},
        statusUpdate:   () => {},
        seekerUpdate:   () => {},
        highlight:      () => {},
        clearHighlight: () => {},
    });
});

afterEach(() => {
    jest.useRealTimers();
});

// ── initReadMode ──────────────────────────────────────────────────────────────

describe('initReadMode', () => {
    test('wires stateChange callback', () => {
        const stateChange = jest.fn();
        initReadMode({ stateChange });
        startReadMode(makeSentences(1), 0, 'http://example.com');
        expect(stateChange).toHaveBeenCalledWith('playing');
    });

    test('wires highlight callback and calls it on advance', () => {
        const highlight = jest.fn();
        initReadMode({ highlight });
        const sentences = makeSentences(2);
        startReadMode(sentences, 0, 'http://example.com');
        // advance() is called synchronously on start
        expect(highlight).toHaveBeenCalledWith(0);
    });

    test('wires clearHighlight callback', () => {
        const clearHighlight = jest.fn();
        initReadMode({ clearHighlight });
        startReadMode(makeSentences(1), 0, 'http://example.com');
        stopReadMode();
        expect(clearHighlight).toHaveBeenCalled();
    });
});

// ── startReadMode ─────────────────────────────────────────────────────────────

describe('startReadMode', () => {
    test('sets enabled to true', () => {
        startReadMode(makeSentences(3), 0, 'http://example.com');
        expect(isEnabled()).toBe(true);
    });

    test('calls stateChange with "playing"', () => {
        const stateChange = jest.fn();
        initReadMode({ stateChange });
        startReadMode(makeSentences(2), 0, 'http://example.com');
        expect(stateChange).toHaveBeenCalledWith('playing');
    });

    test('starts from the given fromIndex', () => {
        const sentences = makeSentences(5);
        startReadMode(sentences, 2, 'http://example.com');
        // After advance() is called, sentIdx is incremented to 3
        expect(getSentenceIndex()).toBe(3);
    });

    test('stores the sentence list', () => {
        const sentences = makeSentences(4);
        startReadMode(sentences, 0, 'http://example.com');
        expect(getSentences()).toBe(sentences);
    });

    test('stores the page URL', () => {
        startReadMode(makeSentences(1), 0, 'http://test.com/page');
        expect(getPageUrl()).toBe('http://test.com/page');
    });

    test('passes null for sentences to keep the existing list', () => {
        const sentences = makeSentences(3);
        setSentences(sentences);
        startReadMode(null, 0, 'http://example.com');
        expect(getSentences()).toBe(sentences);
    });

    test('calls stateChange("done") after all sentences advance', () => {
        const stateChange = jest.fn();
        initReadMode({ stateChange });
        const sentences = makeSentences(2);
        startReadMode(sentences, 0, 'http://example.com');
        // First advance fired immediately — now run the remaining timers
        jest.runAllTimers();
        // The final call should be 'done'
        const calls = stateChange.mock.calls.map(c => c[0]);
        expect(calls).toContain('done');
    });
});

// ── stopReadMode ──────────────────────────────────────────────────────────────

describe('stopReadMode', () => {
    test('sets enabled to false', () => {
        startReadMode(makeSentences(3), 0, 'http://example.com');
        stopReadMode();
        expect(isEnabled()).toBe(false);
    });

    test('calls clearHighlight', () => {
        const clearHighlight = jest.fn();
        initReadMode({ clearHighlight });
        startReadMode(makeSentences(3), 0, 'http://example.com');
        stopReadMode();
        expect(clearHighlight).toHaveBeenCalled();
    });

    test('sets paused to false', () => {
        startReadMode(makeSentences(3), 0, 'http://example.com');
        toggleReadModePlayPause(); // pause it first
        stopReadMode();
        expect(isPaused()).toBe(false);
    });
});

// ── toggleReadModePlayPause ───────────────────────────────────────────────────

describe('toggleReadModePlayPause', () => {
    test('pauses when currently playing', () => {
        startReadMode(makeSentences(5), 0, 'http://example.com');
        expect(isPaused()).toBe(false);
        toggleReadModePlayPause();
        expect(isPaused()).toBe(true);
    });

    test('resumes when paused', () => {
        startReadMode(makeSentences(5), 0, 'http://example.com');
        toggleReadModePlayPause(); // pause
        toggleReadModePlayPause(); // resume
        expect(isPaused()).toBe(false);
    });

    test('calls stateChange("paused") when pausing', () => {
        const stateChange = jest.fn();
        initReadMode({ stateChange });
        startReadMode(makeSentences(5), 0, 'http://example.com');
        toggleReadModePlayPause();
        expect(stateChange).toHaveBeenCalledWith('paused');
    });

    test('calls stateChange("playing") when resuming', () => {
        const stateChange = jest.fn();
        initReadMode({ stateChange });
        startReadMode(makeSentences(5), 0, 'http://example.com');
        toggleReadModePlayPause(); // pause
        stateChange.mockClear();
        toggleReadModePlayPause(); // resume
        expect(stateChange).toHaveBeenCalledWith('playing');
    });
});

// ── adjustWpm ─────────────────────────────────────────────────────────────────

describe('adjustWpm', () => {
    test('increases WPM by the given delta', () => {
        // Reset to default first
        adjustWpm(DEFAULT_WPM - getWpm()); // ensure default
        const before = getWpm();
        const after = adjustWpm(50);
        expect(after).toBe(before + 50);
    });

    test('clamps to MAX_WPM', () => {
        const result = adjustWpm(MAX_WPM + 1000);
        expect(result).toBe(MAX_WPM);
    });

    test('clamps to MIN_WPM', () => {
        const result = adjustWpm(-(MAX_WPM + 1000));
        expect(result).toBe(MIN_WPM);
    });

    test('returns the new WPM value', () => {
        const current = getWpm();
        const delta = 20;
        const expected = Math.min(MAX_WPM, current + delta);
        expect(adjustWpm(delta)).toBe(expected);
    });
});

// ── loadReadModePreferences ───────────────────────────────────────────────────

describe('loadReadModePreferences', () => {
    test('returns enabled:false and default wpm when storage is empty', async () => {
        // setup.js mocks get to return {}
        global.chrome.storage.local.get = () => Promise.resolve({});
        const result = await loadReadModePreferences();
        expect(typeof result.enabled).toBe('boolean');
        expect(typeof result.wpm).toBe('number');
    });

    test('picks up readMode:true from storage', async () => {
        global.chrome.storage.local.get = () => Promise.resolve({ readMode: true });
        const result = await loadReadModePreferences();
        expect(result.enabled).toBe(true);
    });

    test('picks up a valid readModeWpm from storage', async () => {
        global.chrome.storage.local.get = () => Promise.resolve({ readModeWpm: 300 });
        const result = await loadReadModePreferences();
        expect(result.wpm).toBe(300);
    });

    test('ignores an out-of-range readModeWpm', async () => {
        global.chrome.storage.local.get = () => Promise.resolve({ readModeWpm: 50 }); // below MIN
        const before = getWpm();
        const result = await loadReadModePreferences();
        // Should not have changed to 50
        expect(result.wpm).not.toBe(50);
    });
});

// ── getPositionKey ────────────────────────────────────────────────────────────

describe('getPositionKey', () => {
    test('returns a key containing the page URL', () => {
        setPageUrl('http://example.com/article');
        expect(getPositionKey()).toBe('readModePos_http://example.com/article');
    });

    test('returns a key with empty suffix when URL is unset', () => {
        setPageUrl('');
        expect(getPositionKey()).toBe('readModePos_');
    });
});
