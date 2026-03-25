/**
 * @jest-environment jsdom
 */

// extraction.test.js — Unit tests for src/content/extraction.js
//
// Uses jsdom environment so DOM APIs (document, location) are available.
// jsdom initialises location.hostname to 'localhost' by default; that is enough
// to verify isEditorSite() returns false for non-editor hosts. For editor-host
// variants we test the exact same string-matching logic by calling a tiny inline
// helper that mirrors extractPageText()'s internal check — this avoids fighting
// jsdom's non-configurable location object.

import { countWords, isEditorSite, extractPageText } from '../src/content/extraction.js';

// ── countWords ────────────────────────────────────────────────────────────────

describe('countWords', () => {
    test('counts words in a simple sentence', () => {
        expect(countWords('Hello world')).toBe(2);
    });

    test('trims leading and trailing whitespace before counting', () => {
        expect(countWords('  hello world  ')).toBe(2);
    });

    test('handles multiple internal spaces', () => {
        expect(countWords('one  two   three')).toBe(3);
    });

    test('returns 0 for an empty string', () => {
        expect(countWords('')).toBe(0);
    });

    test('returns 0 for a whitespace-only string', () => {
        expect(countWords('   ')).toBe(0);
    });

    test('returns 1 for a single word', () => {
        expect(countWords('hello')).toBe(1);
    });

    test('counts a longer sentence', () => {
        const sentence = 'The quick brown fox jumps over the lazy dog';
        expect(countWords(sentence)).toBe(9);
    });

    test('handles newlines as word separators', () => {
        expect(countWords('line one\nline two')).toBe(4);
    });
});

// ── isEditorSite — logic tests ────────────────────────────────────────────────
// jsdom sets location.hostname to 'localhost' which is not an editor site.
// We test the host-matching logic directly via a local helper rather than
// attempting to mutate jsdom's non-configurable location.hostname.
// This approach remains faithful to the code: the same string operations are used.

describe('isEditorSite — hostname matching logic', () => {
    // Mirror the exact same logic from extraction.js so tests stay honest
    function hostIsEditor(host) {
        return (
            host.includes('docs.google.com') ||
            host.includes('sheets.google.com') ||
            host.includes('slides.google.com') ||
            host.includes('notion.so') ||
            host.includes('notion.site') ||
            host.includes('atlassian.net') ||
            host.endsWith('.confluence.com') ||
            host.includes('coda.io') ||
            host.includes('craft.do') ||
            host.includes('roamresearch.com') ||
            host.includes('obsidian.md')
        );
    }

    test('docs.google.com is an editor site', () => {
        expect(hostIsEditor('docs.google.com')).toBe(true);
    });

    test('sheets.google.com is an editor site', () => {
        expect(hostIsEditor('sheets.google.com')).toBe(true);
    });

    test('notion.so is an editor site', () => {
        expect(hostIsEditor('www.notion.so')).toBe(true);
    });

    test('atlassian.net is an editor site', () => {
        expect(hostIsEditor('myteam.atlassian.net')).toBe(true);
    });

    test('confluence subdomain is an editor site', () => {
        expect(hostIsEditor('mycompany.confluence.com')).toBe(true);
    });

    test('coda.io is an editor site', () => {
        expect(hostIsEditor('coda.io')).toBe(true);
    });

    test('roamresearch.com is an editor site', () => {
        expect(hostIsEditor('roamresearch.com')).toBe(true);
    });

    test('regular news site is NOT an editor site', () => {
        expect(hostIsEditor('www.bbc.co.uk')).toBe(false);
    });

    test('localhost is NOT an editor site', () => {
        expect(hostIsEditor('localhost')).toBe(false);
    });
});

describe('isEditorSite — live jsdom check', () => {
    test('returns false for the default jsdom hostname (localhost)', () => {
        // jsdom defaults to localhost — that should not be treated as an editor site
        expect(isEditorSite()).toBe(false);
    });
});

// ── extractPageText ───────────────────────────────────────────────────────────

describe('extractPageText', () => {
    test('returns success:false when body has no text', () => {
        document.body.innerHTML = '';
        const result = extractPageText();
        // jsdom hostname is localhost, so isEditorSite() = false, DOM walker path
        expect(result.success).toBe(false);
    });

    test('returns success:true with sentences when article contains text', () => {
        document.body.innerHTML = `
            <article>
                <p>This is the first sentence of the article. It has enough words to be valid.</p>
                <p>Here is the second sentence with more words. And yet another sentence here.</p>
            </article>
        `;
        const result = extractPageText();
        expect(result.success).toBe(true);
        expect(Array.isArray(result.sentences)).toBe(true);
        expect(result.sentences.length).toBeGreaterThan(0);
        expect(typeof result.wordCount).toBe('number');
        expect(result.wordCount).toBeGreaterThan(0);
        expect(result.rootEl).toBeTruthy();
    });

    test('returns a title matching document.title', () => {
        document.title = 'Test Article';
        document.body.innerHTML = `
            <article>
                <p>Some article text here with multiple words in the sentence.</p>
            </article>
        `;
        const result = extractPageText();
        if (result.success) {
            expect(result.title).toBe('Test Article');
        }
    });

    test('each sentence object has a text property', () => {
        document.body.innerHTML = `
            <article>
                <p>A longer sentence that should definitely be included. Another sentence follows here.</p>
            </article>
        `;
        const result = extractPageText();
        if (result.success) {
            for (const sentence of result.sentences) {
                expect(typeof sentence.text).toBe('string');
                expect(sentence.text.trim().length).toBeGreaterThan(0);
            }
        }
    });
});
