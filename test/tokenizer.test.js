// tokenizer.test.js — Unit tests for the Kokoro phoneme tokenizer

import { tokenize, KOKORO_VOCAB, MAX_PHONEME_LENGTH } from '../src/worker/tokenizer.js';

describe('tokenize — basic behaviour', () => {
    test('wraps token IDs with BOS (0) and EOS (0)', () => {
        const result = tokenize('a');
        expect(result[0]).toBe(0);
        expect(result[result.length - 1]).toBe(0);
    });

    test('maps a known phoneme character to its vocabulary ID', () => {
        // 'a' → 43 per KOKORO_VOCAB
        const result = tokenize('a');
        expect(result).toEqual([0, 43, 0]);
    });

    test('silently skips characters not in KOKORO_VOCAB', () => {
        // Chinese character has no vocab entry — should be dropped
        const result = tokenize('\u4e2d');
        expect(result).toEqual([0, 0]); // BOS + EOS only
    });

    test('handles an empty phoneme string', () => {
        const result = tokenize('');
        expect(result).toEqual([0, 0]); // BOS + EOS only
    });

    test('maps multiple known characters in sequence', () => {
        // 'h' → 50, 'ə' → 83, 'l' → 54
        const result = tokenize('həl');
        expect(result).toEqual([0, 50, 83, 54, 0]);
    });

    test('maps the primary stress marker correctly', () => {
        // 'ˈ' → 156
        const result = tokenize('ˈ');
        expect(result).toEqual([0, 156, 0]);
    });

    test('maps the space character correctly', () => {
        // ' ' → 16
        const result = tokenize(' ');
        expect(result).toEqual([0, 16, 0]);
    });
});

describe('tokenize — truncation', () => {
    test('truncates input longer than MAX_PHONEME_LENGTH before tokenising', () => {
        const longInput = 'a'.repeat(MAX_PHONEME_LENGTH + 100);
        const result = tokenize(longInput);
        // BOS + MAX_PHONEME_LENGTH tokens + EOS
        expect(result).toHaveLength(MAX_PHONEME_LENGTH + 2);
    });

    test('does not truncate input at exactly MAX_PHONEME_LENGTH', () => {
        const exactInput = 'a'.repeat(MAX_PHONEME_LENGTH);
        const result = tokenize(exactInput);
        expect(result).toHaveLength(MAX_PHONEME_LENGTH + 2);
    });
});

describe('KOKORO_VOCAB', () => {
    test('contains 178 entries or fewer (n_token limit from Kokoro config)', () => {
        // The spec says n_token = 178 and token 0 is implicit (BOS/EOS/PAD)
        expect(Object.keys(KOKORO_VOCAB).length).toBeLessThanOrEqual(178);
    });

    test('does not contain token ID 0 (BOS/EOS/PAD is implicit)', () => {
        const ids = Object.values(KOKORO_VOCAB);
        expect(ids).not.toContain(0);
    });

    test('all values are positive integers', () => {
        const ids = Object.values(KOKORO_VOCAB);
        for (const id of ids) {
            expect(Number.isInteger(id)).toBe(true);
            expect(id).toBeGreaterThan(0);
        }
    });
});
