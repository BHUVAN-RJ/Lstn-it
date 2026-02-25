// phoneme-normalizer.js
// Convert phonemizer (en-us) output → Kokoro/Misaki phoneme format.
//
// Verified mappings from TECHNICAL_HANDOFF.md:
//   phonemizer         Kokoro    example
//   ─────────────────────────────────────────────────────
//   oʊ  (oh diphthong) →  O      həlˈoʊ → həlˈO
//   aʊ  (ow diphthong) →  W      bɹˈaʊn → bɹˈWn
//   ɜː  (er vowel)     →  ɜɹ     wˈɜːld → wˈɜɹld
//   ɑː  (ah vowel)     →  ɑ      fˈɑːðɚ → fˈɑðɚ
//   ː   (length mark)  →  ''     strip any remaining long-vowel markers

const REPLACEMENTS = [
    [/oʊ/g, 'O'],   // oh diphthong
    [/aʊ/g, 'W'],   // ow diphthong
    [/ɜː/g, 'ɜɹ'],  // er vowel (must come before the bare ː strip)
    [/ɑː/g, 'ɑ'],   // ah vowel
    [/ː/g,  ''],    // strip any remaining length marks
];

/**
 * Normalize a single phoneme string produced by phonemizer (en-us)
 * so it matches the format Kokoro's tokenizer expects.
 *
 * @param {string} phonemizerOutput - e.g. "həlˈoʊ wˈɜːld"
 * @returns {string}                - e.g. "həlˈO wˈɜɹld"
 */
export function normalizeForKokoro(phonemizerOutput) {
    let result = phonemizerOutput;
    for (const [pattern, replacement] of REPLACEMENTS) {
        result = result.replace(pattern, replacement);
    }
    return result;
}
