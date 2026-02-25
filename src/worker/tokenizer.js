// tokenizer.js — Kokoro phoneme → token ID converter
//
// Vocabulary source: hexgrad/Kokoro-82M config.json (n_token: 178)
// BOS = EOS = PAD = token 0 (not in dict — implicit)
// tokenize() prepends 0 and appends 0 to every sequence.

export const MAX_PHONEME_LENGTH = 510; // hard limit from kokoro-onnx

// Complete Kokoro vocabulary: phoneme character → token ID
// Gaps in IDs are intentional (reserved slots).
export const KOKORO_VOCAB = {
    // Punctuation
    ';':  1,
    ':':  2,
    ',':  3,
    '.':  4,
    '!':  5,
    '?':  6,
    '—':  9,   // U+2014 em dash
    '…':  10,  // U+2026 ellipsis
    '"':  11,
    '(':  12,
    ')':  13,
    '\u201C': 14, // " left double quotation mark
    '\u201D': 15, // " right double quotation mark
    ' ':  16,  // space

    // Diacritics / special combining marks
    '\u0303': 17, // combining tilde (nasalisation)
    'ʣ':  18,
    'ʥ':  19,
    'ʦ':  20,
    'ʨ':  21,
    'ᵝ':  22,  // U+1D5D superscript beta
    '\uAB67': 23, // Latin small letter turned k

    // Uppercase Misaki-specific phoneme tokens
    'A':  24,
    'I':  25,
    'O':  31,  // "oh" diphthong (oʊ normalised by phoneme-normalizer)
    'Q':  33,
    'S':  35,
    'T':  36,
    'W':  39,  // "ow" diphthong (aʊ normalised by phoneme-normalizer)
    'Y':  41,
    'ᵊ':  42,  // U+1D4A superscript schwa

    // Lowercase Latin letters
    'a':  43,
    'b':  44,
    'c':  45,
    'd':  46,
    'e':  47,
    'f':  48,
    // 'g' not present — IPA velar stop is ɡ (92)
    'h':  50,
    'i':  51,
    'j':  52,
    'k':  53,
    'l':  54,
    'm':  55,
    'n':  56,
    'o':  57,
    'p':  58,
    'q':  59,
    'r':  60,
    's':  61,
    't':  62,
    'u':  63,
    'v':  64,
    'w':  65,
    'x':  66,
    'y':  67,
    'z':  68,

    // IPA vowels and consonants
    'ɑ':  69,  // open back unrounded
    'ɐ':  70,  // near-open central
    'ɒ':  71,  // open back rounded
    'æ':  72,  // near-open front (cat)
    'β':  75,  // voiced bilabial fricative
    'ɔ':  76,  // open-mid back rounded (thought)
    'ɕ':  77,
    'ç':  78,
    'ɖ':  80,
    'ð':  81,  // voiced dental fricative (this)
    'ʤ':  82,  // dʒ affricate (judge)
    'ə':  83,  // schwa (sofa)
    'ɚ':  85,  // rhotacised schwa (butter)
    'ɛ':  86,  // open-mid front (bed)
    'ɜ':  87,  // open-mid central (bird) — used in ɜɹ after normalization
    'ɟ':  90,
    'ɡ':  92,  // voiced velar stop (IPA g — NOT Latin g)
    'ɥ':  99,
    'ɨ':  101,
    'ɪ':  102, // near-close front (bit)
    'ʝ':  103,
    'ɯ':  110,
    'ɰ':  111,
    'ŋ':  112, // velar nasal (sing)
    'ɳ':  113,
    'ɲ':  114,
    'ɴ':  115,
    'ø':  116,
    'ɸ':  118,
    'θ':  119, // voiceless dental fricative (think)
    'œ':  120,
    'ɹ':  123, // alveolar approximant (English r)
    'ɾ':  125,
    'ɻ':  126,
    'ʁ':  128,
    'ɽ':  129,
    'ʂ':  130,
    'ʃ':  131, // palato-alveolar fricative (she)
    'ʈ':  132,
    'ʧ':  133, // tʃ affricate (church)
    'ʊ':  135, // near-close back rounded (foot)
    'ʋ':  136,
    'ʌ':  138, // open-mid back unrounded (cup)
    'ɣ':  139,
    'ɤ':  140,
    'χ':  142,
    'ʎ':  143,
    'ʒ':  147, // palato-alveolar fricative (measure)
    'ʔ':  148, // glottal stop

    // Prosodic markers
    'ˈ':  156, // primary stress
    'ˌ':  157, // secondary stress
    'ː':  158, // length mark (long vowel)
    'ʰ':  162, // aspiration
    'ʲ':  164, // palatalisation

    // Tone / intonation
    '↓':  169,
    '→':  171,
    '↗':  172,
    '↘':  173,
    'ᵻ':  177, // U+1D7B
};

/**
 * Convert a normalised phoneme string to a Kokoro token ID array.
 * Unknown characters are silently skipped (same behaviour as Python source).
 * BOS (0) is prepended and EOS (0) is appended.
 *
 * @param {string} phonemes  - Normalised phoneme string (output of normalizeForKokoro)
 * @returns {number[]}        - Token IDs including BOS and EOS: [0, ...ids, 0]
 */
export function tokenize(phonemes) {
    // Truncate to hard limit before mapping
    const src = phonemes.length > MAX_PHONEME_LENGTH
        ? phonemes.slice(0, MAX_PHONEME_LENGTH)
        : phonemes;

    const inner = [];
    for (const ch of src) {
        const id = KOKORO_VOCAB[ch];
        if (id !== undefined) inner.push(id);
    }

    return [0, ...inner, 0]; // BOS=0, ...tokens, EOS=0
}
