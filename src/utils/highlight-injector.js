// highlight-injector.js — Range-based sentence highlighting with floating overlay rects.
//
// Strategy:
//   1. prepareHighlighter() — walks DOM, builds a two-phase buffer:
//        preNormBuf : 1:1 char substitutions only (same length as raw DOM text)
//        normBuf    : whitespace-collapsed version used for indexOf searches
//        normToPreNorm[normPos] = preNormBuf position
//      Each sentence's position is stored in normBuf coordinates.
//   2. highlightSentence(idx) — maps normBuf pos → preNormBuf pos → text node +
//      DOM offset → DOM Range → per-line overlay rects.
//   3. mergeLineRects() merges getClientRects() output into one rect per visual
//      line. Tiny rects (footnote markers, punctuation spans) are filtered out.
//
// No modification of article DOM — only overlay divs are injected.

// ── Constants ────────────────────────────────────────────────────────────────

const RECT_PADDING_X      = 4;   // px glow breathing room
const RECT_PADDING_Y      = 2;
const MIN_RECT_WIDTH      = 20;  // px — filter footnote/marker rects
const LINE_MERGE_TOLERANCE = 4;  // px — vertical tolerance for same-line merging

const TRANSITION_ON  = 'top 0.28s cubic-bezier(0.4,0,0.2,1), left 0.28s cubic-bezier(0.4,0,0.2,1), width 0.28s cubic-bezier(0.4,0,0.2,1), height 0.28s cubic-bezier(0.4,0,0.2,1), opacity 0.18s ease';
const TRANSITION_OFF = 'opacity 0.18s ease';

// Must match text-cleaner.js
const STRIP_TAGS = new Set([
    'script', 'style', 'noscript', 'figure', 'figcaption',
    'nav', 'footer', 'header', 'aside', 'form', 'button',
    'img', 'video', 'audio', 'canvas', 'svg', 'iframe',
    'template', 'dialog',
]);

const BLOCK_TAGS = new Set([
    'p', 'div', 'article', 'section', 'main',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'dt', 'dd', 'blockquote', 'pre',
    'tr', 'td', 'th',
]);

// ── Module state ─────────────────────────────────────────────────────────────

let nodeRanges        = [];  // [{node, start, end, gap}] — positions in preNormBuf coords
let normBuffer        = '';  // whitespace-collapsed buffer for indexOf
let normToPreNorm     = [];  // normToPreNorm[normPos] = preNormBuf position
let sentencePositions = [];  // [{start, end}] in normBuffer coords, or null

let currentRange     = null;
let overlayContainer = null;
let overlayPool      = [];

// ── Phase 1: 1:1 character substitutions (no length change) ─────────────────
//
// These mirror text-cleaner.js normalizeApostrophes + NBSP handling,
// and also convert \n → space so all whitespace is spaces/tabs.
// Result is same length as input — preNormBuf position == raw DOM position.

function preNormalize(text) {
    return text
        .replace(/[\u2019\u2018\u0060\u00B4]/g, "'")   // curly apostrophes
        .replace(/[\u201C\u201D\u2033]/g, '"')           // curly quotes
        .replace(/[\u2013\u2014]/g, '-')                 // en/em dash
        .replace(/\u00A0/g, ' ')                         // non-breaking space
        .replace(/\n/g, ' ');                            // newline → space (1:1)
}

// ── DOM walker ────────────────────────────────────────────────────────────────
//
// Returns ordered entries: { type:'text', node } | { type:'br' } | { type:'block' }
// Mirrors text-cleaner._walk so our buffer aligns with text-cleaner's output.

function collectBufferEntries(rootEl) {
    const entries = [];
    function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (node.textContent) entries.push({ type: 'text', node });
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.tagName.toLowerCase();
        if (STRIP_TAGS.has(tag)) return;
        // Must mirror text-cleaner._walk: skip Medium metadata elements so that
        // the buffer stays in sync with the extracted sentence text.
        const testId = node.getAttribute('data-testid');
        if (testId === 'storyReadTime' || testId === 'storyPublishDate' || testId === 'authorName') return;
        if (tag === 'br') { entries.push({ type: 'br' }); return; }
        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock) entries.push({ type: 'block' });
        for (const child of node.childNodes) walk(child);
        if (isBlock) entries.push({ type: 'block' });
    }
    walk(rootEl);
    return entries;
}

// ── Phase 1 buffer build ──────────────────────────────────────────────────────
//
// Builds preNormBuf (1:1 with raw DOM) and nodeRanges in preNormBuf coordinates.
//   Text nodes → preNormalize() → same length as textContent
//   <br>       → 1 space char
//   block      → 2 space chars (collapses to 1 in Phase 2)

function buildPreNormBuffer(entries) {
    const ranges = [];
    let buf = '';
    for (const entry of entries) {
        if (entry.type === 'text') {
            const text = preNormalize(entry.node.textContent);
            ranges.push({ node: entry.node, start: buf.length, end: buf.length + text.length, gap: false });
            buf += text;
        } else if (entry.type === 'br') {
            ranges.push({ node: null, start: buf.length, end: buf.length + 1, gap: true });
            buf += ' ';
        } else {
            // block boundary: 2 spaces → collapses to 1 in Phase 2
            ranges.push({ node: null, start: buf.length, end: buf.length + 2, gap: true });
            buf += '  ';
        }
    }
    return { preNormBuf: buf, ranges };
}

// ── Phase 2: whitespace collapse + position map ──────────────────────────────
//
// Collapses runs of spaces/tabs to a single space.
// map[normPos] = preNormBuf position of the corresponding character.
// This is the key: normBuffer positions can now be reliably mapped back to
// preNormBuf positions (and from there to DOM text node offsets).

function buildNormBuffer(preNormBuf) {
    let norm = '';
    const map = [];
    let i = 0;
    while (i < preNormBuf.length) {
        const ch = preNormBuf[i];
        if (ch === ' ' || ch === '\t') {
            const runStart = i;
            while (i < preNormBuf.length && (preNormBuf[i] === ' ' || preNormBuf[i] === '\t')) i++;
            norm += ' ';
            map.push(runStart);
        } else {
            norm += ch;
            map.push(i);
            i++;
        }
    }
    return { normBuf: norm, n2p: map };
}

// ── Text node lookup ──────────────────────────────────────────────────────────
//
// Given a preNormBuf position, return the text node and the offset within it.
// If the position falls in a gap (br / block boundary), snap to nearest real node.

function getNodeAtPrePos(prePos, snapForward = true) {
    // Exact match inside a real text node
    for (const nr of nodeRanges) {
        if (!nr.gap && nr.start <= prePos && nr.end > prePos) {
            return { entry: nr, offset: prePos - nr.start };
        }
    }
    // prePos is in a gap — snap to nearest real text node
    if (snapForward) {
        for (const nr of nodeRanges) {
            if (!nr.gap && nr.start >= prePos) return { entry: nr, offset: 0 };
        }
        for (let i = nodeRanges.length - 1; i >= 0; i--) {
            if (!nodeRanges[i].gap) {
                const nr = nodeRanges[i];
                return { entry: nr, offset: nr.end - nr.start };
            }
        }
    } else {
        for (let i = nodeRanges.length - 1; i >= 0; i--) {
            const nr = nodeRanges[i];
            if (!nr.gap && nr.end <= prePos) return { entry: nr, offset: nr.end - nr.start };
        }
        for (const nr of nodeRanges) {
            if (!nr.gap) return { entry: nr, offset: 0 };
        }
    }
    return null;
}

// ── Overlay container & pool ─────────────────────────────────────────────────

const OVERLAY_CSS = `
#kokoro-tts-overlay-container {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 2147483646;
    overflow: visible;
}
.kokoro-tts-hl {
    position: fixed;
    pointer-events: none;
    border-radius: 5px;
    background: rgba(14, 165, 233, 0.07);
    border: 1.5px solid rgba(14, 165, 233, 0.5);
    box-shadow:
        0 0 0 3px rgba(14, 165, 233, 0.07),
        0 2px 18px rgba(14, 165, 233, 0.18);
    opacity: 0;
    transition: ${TRANSITION_ON};
}
`;

let cssInjected = false;

function ensureOverlayDOM() {
    if (overlayContainer) return;
    if (!cssInjected && document.head) {
        const style = document.createElement('style');
        style.id = 'kokoro-tts-hl-style';
        style.textContent = OVERLAY_CSS;
        document.head.appendChild(style);
        cssInjected = true;
    }
    overlayContainer = document.createElement('div');
    overlayContainer.id = 'kokoro-tts-overlay-container';
    document.body.appendChild(overlayContainer);
    window.addEventListener('scroll', onScrollOrResize, { passive: true });
    window.addEventListener('resize', onScrollOrResize, { passive: true });
}

function getOrCreateOverlayDiv(idx) {
    if (overlayPool[idx]) return overlayPool[idx];
    const div = document.createElement('div');
    div.className = 'kokoro-tts-hl';
    overlayContainer.appendChild(div);
    overlayPool[idx] = div;
    return div;
}

// ── Scroll / resize tracking ─────────────────────────────────────────────────

function onScrollOrResize() {
    if (!currentRange) return;
    positionOverlays(currentRange, false);
}

// ── Auto-scroll ───────────────────────────────────────────────────────────────
//
// Called on every sentence change. If the sentence is already comfortably
// within the viewport (MARGIN px from each edge) nothing happens.
// Otherwise, smooth-scrolls the page so the sentence is vertically centred.

const SCROLL_MARGIN = 80; // px — how close to the edge before we scroll

function scrollToSentence(range) {
    const rect = range.getBoundingClientRect();
    const vh   = window.innerHeight;
    if (rect.top >= SCROLL_MARGIN && rect.bottom <= vh - SCROLL_MARGIN) return;
    const target = window.scrollY + (rect.top + rect.height / 2) - vh / 2;
    window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

// ── Same-line rect merging ────────────────────────────────────────────────────
//
// getClientRects() returns one DOMRect per CSS inline formatting box.
// Every <font>, <a>, <b> etc. gets its own rect even on the same visual line.
// We:
//   1. Filter out rects narrower than MIN_RECT_WIDTH (footnote markers, punctuation)
//   2. Merge rects whose vertical centres are within LINE_MERGE_TOLERANCE of each other
//      into one bounding rect per visual line.

function mergeLineRects(rects) {
    // Filter tiny rects first
    const filtered = rects.filter((r) => r.width >= MIN_RECT_WIDTH && r.height > 1);
    if (filtered.length === 0) return [];

    // Sort top-to-bottom, then left-to-right
    const sorted = [...filtered].sort((a, b) => a.top !== b.top ? a.top - b.top : a.left - b.left);

    const lines = []; // [{top, bottom, left, right}]
    for (const r of sorted) {
        const midY = (r.top + r.bottom) / 2;
        const line = lines.find((l) => midY >= l.top - LINE_MERGE_TOLERANCE && midY <= l.bottom + LINE_MERGE_TOLERANCE);
        if (line) {
            line.top    = Math.min(line.top,    r.top);
            line.bottom = Math.max(line.bottom, r.bottom);
            line.left   = Math.min(line.left,   r.left);
            line.right  = Math.max(line.right,  r.right);
        } else {
            lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
        }
    }
    return lines;
}

// ── Core overlay positioning ─────────────────────────────────────────────────
//
// Single div + CSS clip-path polygon = one rendering surface, zero junction seams.
//
// For a sentence spanning N lines the clip shape is an 8-point polygon:
//
//   A────────────B          A = (firstLeft, firstTop)   ← sentence start
//   │            │          B = (colRight,  firstTop)
//   H──┐         │          C = (colRight,  lastBottom)
//      │         C          D = (lastRight, lastBottom) ← sentence end
//      F─────────D          E = (lastRight, lastTop)
//      │         │          F = (colLeft,   lastTop)
//      G─────────E          G = (colLeft,   firstBottom)
//                           H = (firstLeft, firstBottom)
//
// For a single-line sentence the polygon collapses to a plain rectangle.
// The div is sized to the bounding box; the clip-path is in div-local coords.
// Because there is only one div the border and box-shadow never overlap.

function positionOverlays(range, animate = true) {
    if (!overlayContainer) return;

    const lineRects = mergeLineRects([...range.getClientRects()]);
    if (lineRects.length === 0) {
        if (overlayPool[0]) overlayPool[0].style.opacity = '0';
        return;
    }

    const t     = animate ? TRANSITION_ON : TRANSITION_OFF;
    const first = lineRects[0];
    const last  = lineRects[lineRects.length - 1];
    const px    = RECT_PADDING_X;
    const py    = RECT_PADDING_Y;

    // Column bounds (= full paragraph width when there are middle lines)
    const colLeft  = Math.min(...lineRects.map((r) => r.left));
    const colRight = Math.max(...lineRects.map((r) => r.right));

    const div = getOrCreateOverlayDiv(0);
    div.style.transition = t;
    div.style.opacity = '1';

    // Hide unused pool divs
    for (let i = 1; i < overlayPool.length; i++) overlayPool[i].style.opacity = '0';

    if (lineRects.length === 1) {
        // Single line — plain rectangle, no clip-path
        div.style.clipPath = '';
        div.style.top    = (first.top    - py) + 'px';
        div.style.left   = (first.left   - px) + 'px';
        div.style.width  = (first.right - first.left + px * 2) + 'px';
        div.style.height = (first.bottom - first.top + py * 2) + 'px';
        return;
    }

    // Multi-line: div covers bounding box, clip-path cuts the selection shape.
    //
    // Verified with even-odd fill rule at each zone:
    //
    //   startX              endX  divWidth
    //    A────────────────────────────B   py       (firstTop)
    //    │                            │
    //    H──G                         │   iSB      (firstBottom — inner step left)
    //       │                         │
    //       │           D─────────────C   iST      (lastTop  — inner step right)
    //       │           │
    //       F───────────E                 divH     (lastBottom)
    //
    //   First-line zone:  x = startX … divWidth  ✓
    //   Middle zone:      x = 0      … divWidth  ✓
    //   Last-line zone:   x = 0      … endX      ✓

    const divWidth  = colRight - colLeft + 2 * px;
    const divHeight = last.bottom - first.top + 2 * py;

    div.style.top    = (first.top - py) + 'px';
    div.style.left   = (colLeft   - px) + 'px';
    div.style.width  = divWidth  + 'px';
    div.style.height = divHeight + 'px';

    const startX = first.left - colLeft;           // sentence start offset from colLeft (no left padding — A/H x)
    const endX   = last.right - colLeft + 2 * px;  // sentence end offset from div left (with right padding — D/E x)
    const iSB    = first.bottom - first.top + py;  // inner step bottom y (firstBottom in local)
    const iST    = last.top    - first.top + py;   // inner step top y    (lastTop in local)

    div.style.clipPath = `polygon(` +
        `${startX}px ${py}px, `   +   // A
        `${divWidth}px ${py}px, ` +   // B
        `${divWidth}px ${iST}px, ` +  // C
        `${endX}px ${iST}px, `    +   // D
        `${endX}px ${divHeight}px, ` + // E
        `0px ${divHeight}px, `    +   // F
        `0px ${iSB}px, `          +   // G
        `${startX}px ${iSB}px)`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Call once after text extraction. Builds the two-phase buffer and pre-computes
 * each sentence's position in normBuffer.
 *
 * @param {Element} rootEl    - Article root element
 * @param {Array}   sentences - Sentence objects with `.text` (from text-cleaner)
 */
export function prepareHighlighter(rootEl, sentences) {
    currentRange = null; nodeRanges = []; normBuffer = ''; normToPreNorm = []; sentencePositions = [];
    clearHighlight();

    // Phase 1: build preNormBuf (1:1 with raw DOM) + nodeRanges
    const entries = collectBufferEntries(rootEl);
    const { preNormBuf, ranges } = buildPreNormBuffer(entries);
    nodeRanges = ranges;

    // Phase 2: collapse whitespace → normBuffer + position map
    const { normBuf, n2p } = buildNormBuffer(preNormBuf);
    normBuffer    = normBuf;
    normToPreNorm = n2p;

    // Pre-compute sentence positions in normBuffer.
    // Sentence text from text-cleaner has already been through normalizeApostrophes
    // and sentence-splitter's \n→space+trim. We apply the same two phases here so
    // the search string matches the buffer.
    let searchFrom = 0;
    for (const sent of sentences) {
        const { normBuf: normSent } = buildNormBuffer(preNormalize(sent.text));
        if (!normSent) { sentencePositions.push(null); continue; }

        const pos = normBuffer.indexOf(normSent, searchFrom);
        if (pos === -1) { sentencePositions.push(null); continue; }

        sentencePositions.push({ start: pos, end: pos + normSent.length });
        searchFrom = pos + normSent.length;
    }

    const found = sentencePositions.filter(Boolean).length;
    console.log(`[highlight-injector] ${found}/${sentences.length} sentences located in DOM`);

    ensureOverlayDOM();
}

/**
 * Highlight the sentence at `idx`.
 * Maps normBuffer positions → preNormBuf positions → DOM text node offsets → Range.
 */
export function highlightSentence(idx) {
    const pos = sentencePositions[idx];
    if (!pos) return;

    // Guard: positions must be within the map
    if (pos.start >= normToPreNorm.length || pos.end === 0 || pos.end - 1 >= normToPreNorm.length) return;

    // Map normBuffer positions to preNormBuf positions
    const preStart    = normToPreNorm[pos.start];
    const preLastChar = normToPreNorm[pos.end - 1];  // preNorm pos of last char (inclusive)

    const startResult = getNodeAtPrePos(preStart,    true  /* snap forward */);
    const endResult   = getNodeAtPrePos(preLastChar, false /* snap backward */);
    if (!startResult || !endResult) return;

    try {
        const range = document.createRange();
        range.setStart(startResult.entry.node, startResult.offset);
        // setEnd is exclusive: one past the last character
        const endOff = Math.min(endResult.offset + 1, endResult.entry.node.textContent.length);
        range.setEnd(endResult.entry.node, endOff);
        currentRange = range;
    } catch (_) {
        // Text node may have been mutated by the page — skip silently
        return;
    }

    positionOverlays(currentRange, true);
    scrollToSentence(currentRange);
}

/**
 * Hide all overlay divs (called on stop / done / widget close).
 */
export function clearHighlight() {
    currentRange = null;
    for (const div of overlayPool) {
        div.style.opacity = '0';
    }
}
