// Chapter-number parsing shared by the multi-source refresh (pick the highest
// chapter across a comic's sources) and the downgrade guards in Details and
// Explore (a lagging primary must not undo a newer linked-source value).
//
// Chapter titles vary wildly between sites: "Chapter 120", "Ch. 120.5",
// "Episode 42", "Vol.3 Chapter 12", "120 - The End". We only need a comparable
// number, so an explicit chapter/episode marker wins, and the first number in
// the string is the fallback. Returns null when nothing numeric is present.

const MARKER_RE = /(?:chapter|chap|ch|episode|ep)\.?\s*#?\s*(\d+(?:\.\d+)?)/i;
const FIRST_NUMBER_RE = /(\d+(?:\.\d+)?)/;

export function parseChapterNumber(title: unknown): number | null {
    if (typeof title !== 'string' || title.length === 0) return null;
    const m = title.match(MARKER_RE) || title.match(FIRST_NUMBER_RE);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n : null;
}

/**
 * True when writing `candidate` over `current` would move latest_chapter
 * backwards. Unparseable values never block a write (nothing to compare), and
 * an equal number is not a downgrade.
 */
export function isChapterDowngrade(current: unknown, candidate: unknown): boolean {
    const cur = parseChapterNumber(current);
    const cand = parseChapterNumber(candidate);
    if (cur === null || cand === null) return false;
    return cand < cur;
}

/**
 * Decides which latest_chapter survives a cloud pull (bulkRestoreLocal).
 * A local refresh may not have reached Supabase yet (background check with no
 * session, offline push), so the higher parsed number wins and a tie keeps
 * local. A cloud value with no number ('Unknown', '') never wipes a real local
 * one; when local has no number there is nothing to protect, so cloud wins as
 * it always did.
 */
export function pickLatestChapter(local: unknown, cloud: unknown): 'local' | 'cloud' {
    const l = parseChapterNumber(local);
    if (l === null) return 'cloud';
    const c = parseChapterNumber(cloud);
    if (c === null) return 'local';
    return c > l ? 'cloud' : 'local';
}

/**
 * Decides whether a freshly-found chapter string counts as a new release
 * relative to what's stored (`latest`) and what the user has read (`read`).
 * Compares numerically when both sides parse — so "Ch.120" from one site and
 * "Chapter 120" from another are the same chapter, not a false alert — and
 * falls back to the original string inequality otherwise.
 */
export function isNewerChapter(found: unknown, latest: unknown, read: unknown): boolean {
    if (typeof found !== 'string' || found.length === 0) return false;
    const f = parseChapterNumber(found);
    const l = parseChapterNumber(latest);
    if (f !== null && l !== null) {
        if (f <= l) return false;
        const r = parseChapterNumber(read);
        return r === null || f > r;
    }
    return found !== latest && found !== read;
}
