// Title normalization + similarity scoring used by source auto-discovery.
//
// Goal: given a comic title we already have in the library and a candidate
// page title scraped from another site, decide whether they're the same
// comic. False positives (linking the wrong series) are worse than false
// negatives (missing a real match) — the user always confirms before linking,
// so we can be conservative.

/** Stopwords stripped during normalization so "the regressor" matches "regressor". */
const STOPWORDS = new Set([
    'a', 'an', 'the', 'of', 'and', 'to', 'in', 'for', 'on', 'at', 'is',
    // Site-suffix noise that often appears in <title>:
    'manga', 'manhwa', 'manhua', 'webtoon', 'comic', 'comics',
    'official', 'free', 'read', 'online', 'english', 'eng',
]);

/**
 * Lowercase, strip site suffixes/separators, collapse whitespace.
 *   "Regressor of the Fallen Family | Asura Scans" → "regressor of the fallen family"
 *   "Solo Leveling - Read Online" → "solo leveling"
 */
export function normalizeTitle(raw: string): string {
    if (!raw || typeof raw !== 'string') return '';
    let s = raw.toLowerCase();
    // Drop site suffixes after the last separator.
    const seps = [' | ', ' - ', ' — ', ' :: ', ' • '];
    for (const sep of seps) {
        const idx = s.lastIndexOf(sep);
        if (idx > 8) s = s.substring(0, idx);
    }
    // Remove parenthetical / bracketed annotations (years, status).
    s = s.replace(/\s*[\[\(].+?[\]\)]\s*/g, ' ');
    // Replace anything non-alphanumeric with a space.
    s = s.replace(/[^a-z0-9]+/g, ' ').trim();
    return s;
}

/** Tokenize a normalized title into content words (stopwords removed). */
export function titleTokens(normalized: string): string[] {
    if (!normalized) return [];
    return normalized.split(/\s+/).filter(t => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Token-set Jaccard similarity between two titles. Returns 0–1.
 * 1.0 = same content tokens; 0.0 = no overlap.
 *
 * Robust to:
 *   - word order ("Hero Returns" vs "Returns of the Hero")
 *   - stopword differences ("the fallen" vs "fallen")
 *   - site-name suffixes (handled by normalizeTitle before this is called)
 *
 * Not robust to:
 *   - translated/alternate titles (Korean vs English) — those need explicit
 *     alternative_names in scraper output
 *   - heavy abbreviations ("SL" for "Solo Leveling")
 */
export function tokenSetSimilarity(a: string, b: string): number {
    const ta = new Set(titleTokens(normalizeTitle(a)));
    const tb = new Set(titleTokens(normalizeTitle(b)));
    if (ta.size === 0 || tb.size === 0) return 0;
    let intersection = 0;
    for (const t of ta) if (tb.has(t)) intersection++;
    const union = ta.size + tb.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/**
 * True when the string has more letters outside the Latin blocks (Hangul, CJK,
 * Cyrillic, …) than inside. Such titles have no word boundaries for the token
 * score to work with, so they are compared exactly instead.
 */
export function isMostlyNonLatin(s: string): boolean {
    if (!s || typeof s !== 'string') return false;
    let latin = 0;
    let other = 0;
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) latin++;
        else if (code > 0x024f && !(code >= 0xd800 && code <= 0xdfff) && !/\s/.test(s[i])) other++;
    }
    return other > latin;
}

/** Lowercased with whitespace and common punctuation removed, for exact compares. */
export function stripForExactMatch(s: string): string {
    if (!s || typeof s !== 'string') return '';
    return s.toLowerCase().replace(/[\s!-\/:-@\[-`{-~、。「」『』・…【】（）：；！？～]+/g, '');
}

/**
 * Similarity between two names. Latin names use tokenSetSimilarity; when either
 * side is mostly non-Latin the names must match exactly after stripping.
 */
export function nameSimilarity(a: string, b: string): number {
    if (isMostlyNonLatin(a) || isMostlyNonLatin(b)) {
        const sa = stripForExactMatch(a);
        return sa.length > 0 && sa === stripForExactMatch(b) ? 1 : 0;
    }
    return tokenSetSimilarity(a, b);
}

/** Best nameSimilarity over every pair — our names vs. the names a site shows. */
export function bestNameSimilarity(namesA: readonly string[], namesB: readonly string[]): number {
    let best = 0;
    for (const a of namesA) {
        if (!a) continue;
        for (const b of namesB) {
            if (!b) continue;
            const s = nameSimilarity(a, b);
            if (s > best) best = s;
            if (best >= 1) return best;
        }
    }
    return best;
}

/**
 * Default confidence threshold for auto-linking suggestions. Calibrated so that
 * "Solo Leveling" / "Solo Leveling Ragnarok" (1 distinct token = lower score)
 * doesn't auto-suggest, but "Regressor of the Fallen Family" matches itself
 * cleanly. User always confirms before linking, so this is the "show as a
 * suggestion" threshold, not the "auto-link" threshold.
 */
export const SUGGESTION_THRESHOLD = 0.85;
