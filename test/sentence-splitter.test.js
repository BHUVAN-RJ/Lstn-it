// sentence-splitter.test.js — Unit tests for splitSentences

import { splitSentences } from '../src/utils/sentence-splitter.js';

describe('splitSentences — basic splitting', () => {
    test('splits a simple two-sentence paragraph', () => {
        const result = splitSentences('Hello world. How are you?');
        expect(result).toHaveLength(2);
        expect(result[0].text).toBe('Hello world.');
        expect(result[1].text).toBe('How are you?');
    });

    test('returns single sentence when no boundary exists', () => {
        const result = splitSentences('This is one sentence');
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('This is one sentence');
    });

    test('handles exclamation mark as a sentence boundary', () => {
        const result = splitSentences('Stop! Collaborate and listen.');
        expect(result).toHaveLength(2);
        expect(result[0].text).toBe('Stop!');
    });

    test('filters out empty sentences', () => {
        const result = splitSentences('   ');
        expect(result).toHaveLength(0);
    });
});

describe('splitSentences — abbreviation handling', () => {
    test('does not split on Mr. before a name', () => {
        const result = splitSentences('Mr. Smith arrived.');
        // Should be a single sentence — "Mr." is not a sentence boundary
        expect(result).toHaveLength(1);
        expect(result[0].text).toContain('Mr. Smith');
    });

    test('does not split on Dr. before a name', () => {
        const result = splitSentences('Dr. Jones performed the surgery.');
        expect(result).toHaveLength(1);
    });

    test('does not split on decimal numbers like 3.14', () => {
        const result = splitSentences('Pi is approximately 3.14 radians.');
        expect(result).toHaveLength(1);
    });
});

describe('splitSentences — paragraph and section metadata', () => {
    test('marks the last sentence before \\n\\n as endsWithParagraph', () => {
        const result = splitSentences('First sentence.\n\nSecond paragraph.');
        const firstSentence = result[0];
        expect(firstSentence.endsWithParagraph).toBe(true);
        expect(firstSentence.endsWithSection).toBe(false);
    });

    test('marks the last sentence before \\u0000 as endsWithSection', () => {
        // \u0000 is the section-break sentinel emitted before h1/h2/h3 by text-cleaner
        const result = splitSentences('Intro sentence.\u0000Section heading text.');
        const introSentence = result[0];
        expect(introSentence.endsWithSection).toBe(true);
        expect(introSentence.endsWithParagraph).toBe(false);
    });

    test('plain sentence has neither endsWithParagraph nor endsWithSection', () => {
        const result = splitSentences('First. Second.');
        // The last sentence never gets a break flag
        const lastSentence = result[result.length - 1];
        expect(lastSentence.endsWithParagraph).toBe(false);
        expect(lastSentence.endsWithSection).toBe(false);
    });

    test('all returned sentences have text, endsWithParagraph, endsWithSection fields', () => {
        const result = splitSentences('One sentence. Another one.');
        for (const sentence of result) {
            expect(typeof sentence.text).toBe('string');
            expect(typeof sentence.endsWithParagraph).toBe('boolean');
            expect(typeof sentence.endsWithSection).toBe('boolean');
        }
    });
});

describe('splitSentences — ellipsis handling', () => {
    test('does not split on ellipsis mid-sentence', () => {
        const result = splitSentences('She paused... and continued.');
        expect(result).toHaveLength(1);
    });
});
