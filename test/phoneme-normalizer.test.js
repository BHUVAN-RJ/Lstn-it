// phoneme-normalizer.test.js — Unit tests for normalizeForKokoro

import { normalizeForKokoro } from '../src/worker/phoneme-normalizer.js';

describe('normalizeForKokoro — diphthong substitutions', () => {
    test('replaces oʊ (oh diphthong) with uppercase O', () => {
        // "hello" IPA contains oʊ
        const result = normalizeForKokoro('həlˈoʊ');
        expect(result).toBe('həlˈO');
    });

    test('replaces aʊ (ow diphthong) with uppercase W', () => {
        // "brown" IPA contains aʊ
        const result = normalizeForKokoro('bɹˈaʊn');
        expect(result).toBe('bɹˈWn');
    });

    test('replaces ɜː (er vowel) with ɜɹ', () => {
        // "world" IPA contains ɜː
        const result = normalizeForKokoro('wˈɜːld');
        expect(result).toBe('wˈɜɹld');
    });

    test('replaces ɑː (ah vowel) with ɑ', () => {
        // "father" IPA contains ɑː
        const result = normalizeForKokoro('fˈɑːðɚ');
        expect(result).toBe('fˈɑðɚ');
    });
});

describe('normalizeForKokoro — length mark stripping', () => {
    test('strips bare ː length marks not preceded by ɜ or ɑ', () => {
        // A hypothetical IPA string with a lone length mark
        const result = normalizeForKokoro('tˈiːm');
        // ː is stripped by the bare ː rule; the preceding vowel stays
        expect(result).toBe('tˈim');
    });

    test('does not double-strip ɜː — the specific rule runs first', () => {
        // ɜː should become ɜɹ (not ɜ) because the ɜː rule runs before the bare ː strip
        const result = normalizeForKokoro('ɜː');
        expect(result).toBe('ɜɹ');
    });
});

describe('normalizeForKokoro — idempotency and passthrough', () => {
    test('returns already-normalised text unchanged', () => {
        // Text that needs no changes
        const input = 'həlˈO wˈɜɹld';
        expect(normalizeForKokoro(input)).toBe(input);
    });

    test('returns empty string unchanged', () => {
        expect(normalizeForKokoro('')).toBe('');
    });

    test('strips the long-mark ː from characters that would otherwise pass through', () => {
        // normalizeForKokoro strips ː (the long-mark modifier) as part of its rules
        // so ˈjuː → ˈju
        const input = 'ˈaɪ sˈi ˈjuː';
        expect(normalizeForKokoro(input)).toBe('ˈaɪ sˈi ˈju');
    });
});

describe('normalizeForKokoro — real-word examples', () => {
    test('normalises the word "hello"', () => {
        // phonemizer en-us output for "hello": həlˈoʊ
        expect(normalizeForKokoro('həlˈoʊ')).toBe('həlˈO');
    });

    test('normalises the word "world"', () => {
        // phonemizer en-us output for "world": wˈɜːld
        expect(normalizeForKokoro('wˈɜːld')).toBe('wˈɜɹld');
    });
});
