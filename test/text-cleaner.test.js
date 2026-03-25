// text-cleaner.test.js — Unit tests for text-cleaner utility functions
// Tests the exported cleanText, isValidText, and stripPaulGrahamContent functions.
// extractTextFromElement requires a real DOM and is not tested here (browser-only).

import { cleanText, isValidText, stripPaulGrahamContent } from '../src/utils/text-cleaner.js';

describe('cleanText — quote normalisation', () => {
    test('replaces curly apostrophes with straight apostrophes', () => {
        // U+2019 right single quotation mark → ASCII apostrophe
        const result = cleanText('it\u2019s a test');
        expect(result).toBe("it's a test");
    });

    test('replaces curly double quotes with straight double quotes', () => {
        // U+201C / U+201D → ASCII double quotes
        const result = cleanText('\u201CHello\u201D');
        expect(result).toBe('"Hello"');
    });

    test('replaces ellipsis character with three dots', () => {
        const result = cleanText('Wait\u2026 and see.');
        expect(result).toBe('Wait... and see.');
    });

    test('replaces non-breaking space with regular space', () => {
        const result = cleanText('word\u00A0word');
        expect(result).toBe('word word');
    });
});

describe('cleanText — emoji removal', () => {
    test('removes common emoji characters', () => {
        // collapseWhitespace runs after emoji removal, so double space → single space
        const result = cleanText('Hello \u{1F600} World');
        expect(result).toBe('Hello World');
    });
});

describe('cleanText — URL removal', () => {
    test('removes https URLs', () => {
        // collapseWhitespace runs after URL removal, so double space → single space
        const result = cleanText('Visit https://example.com for details.');
        expect(result).toBe('Visit for details.');
    });

    test('removes www URLs', () => {
        const result = cleanText('Go to www.example.com today.');
        expect(result).toBe('Go to today.');
    });
});

describe('cleanText — whitespace collapsing', () => {
    test('collapses multiple spaces to one', () => {
        const result = cleanText('too   many   spaces');
        expect(result).toBe('too many spaces');
    });

    test('collapses 3+ newlines to 2', () => {
        const result = cleanText('line1\n\n\n\nline2');
        expect(result).toBe('line1\n\nline2');
    });

    test('trims leading and trailing whitespace', () => {
        const result = cleanText('   trimmed   ');
        expect(result).toBe('trimmed');
    });
});

describe('cleanText — footnote marker stripping', () => {
    test('removes [N] footnote reference markers', () => {
        const result = cleanText('According to studies[1] and data[2].');
        expect(result).toBe('According to studies and data.');
    });

    test('removes standalone Notes heading', () => {
        const input = 'Main text.\n\nNotes\n\nFootnote content.';
        const result = cleanText(input);
        expect(result).not.toContain('Notes\n\n');
    });
});

describe('isValidText', () => {
    test('returns true for text with alphabetic characters', () => {
        expect(isValidText('Hello world')).toBe(true);
    });

    test('returns false for text with only numbers and symbols', () => {
        expect(isValidText('1234 !@#$')).toBe(false);
    });

    test('returns false for empty string', () => {
        expect(isValidText('')).toBe(false);
    });

    test('returns false for whitespace-only string', () => {
        expect(isValidText('   ')).toBe(false);
    });
});

describe('stripPaulGrahamContent', () => {
    test('removes YC advertisement line', () => {
        const input = 'Essay content. Want to start a startup? Get funded by Y Combinator. More content.';
        const result = stripPaulGrahamContent(input);
        expect(result).not.toContain('Want to start a startup');
        expect(result).toContain('Essay content.');
        expect(result).toContain('More content.');
    });

    test('returns unchanged text when no YC line present', () => {
        const input = 'Normal article content without any ads.';
        expect(stripPaulGrahamContent(input)).toBe(input);
    });
});
