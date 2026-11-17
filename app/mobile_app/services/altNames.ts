// Alternate titles for a comic ("Alternative" row on Madara / MangaStream
// detail pages). Stored in manga.alternative_names as the plain text the site
// shows, so the column stays compatible with the desktop app, which has filled
// it the same way for years. Parsed on read.
//
// Used by source discovery: a comic can be listed under a different main title
// on another site, so every name we know is scored against every name the
// other site shows (titleMatch.bestNameSimilarity), and the alternates become
// extra search queries when the main title finds nothing.

import { normalizeTitle, titleTokens, isMostlyNonLatin, stripForExactMatch } from './titleMatch';

/** Most names a comic keeps; sites list up to a dozen, the long tail is noise. */
const MAX_ALT_NAMES = 10;
const SEPARATORS = /[;|\/,\n]+/;

/** Split the stored / scraped text into trimmed, de-duplicated names. */
export function parseAltNames(raw: unknown): string[] {
    if (typeof raw !== 'string' || raw.trim().length === 0) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const part of raw.split(SEPARATORS)) {
        const name = part.trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(name);
    }
    return out;
}

/**
 * Short or generic alternates ("Reincarnation", "The Hero") would match far
 * too many series, so a name only takes part in matching when it carries two
 * content words or is reasonably long. Non-Latin names are compared exactly,
 * so two characters are enough there.
 */
export function isUsableAltName(name: string): boolean {
    if (typeof name !== 'string') return false;
    if (isMostlyNonLatin(name)) return stripForExactMatch(name).length >= 2;
    const tokens = titleTokens(normalizeTitle(name));
    return tokens.length >= 2 || tokens.join('').length >= 8;
}

/**
 * Add `incoming` names to the stored text, skipping repeats and the comic's
 * own title, capped at MAX_ALT_NAMES. Returns the text to store ('; '-joined).
 */
export function mergeAltNames(existing: unknown, incoming: string[], primaryTitle: string): string {
    const primaryKey = normalizeTitle(primaryTitle);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const name of [...parseAltNames(existing), ...incoming]) {
        const trimmed = (name || '').trim();
        if (!trimmed) continue;
        const key = normalizeTitle(trimmed) || trimmed.toLowerCase();
        if (key === primaryKey || seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
        if (out.length >= MAX_ALT_NAMES) break;
    }
    return out.join('; ');
}

/** The title plus every alternate that is specific enough to match on. */
export function namesForMatching(title: string, altRaw: unknown): string[] {
    const names = [title, ...parseAltNames(altRaw).filter(isUsableAltName)];
    return names.filter((n, i) => typeof n === 'string' && n.trim().length > 0 && names.indexOf(n) === i);
}
