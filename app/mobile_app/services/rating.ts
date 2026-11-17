/**
 * Rating rules. Two separate values live on a library row:
 *
 *   manga.rating       — the reader's own rating, 0.1 … 5 with one decimal
 *                        ("4.8"), or '' when not rated. Synced to Supabase.
 *   manga.site_rating  — the primary site's average, normalised onto the same
 *                        5-point scale ("4.5"), or ''. Local only: it is read
 *                        again from the page every time Details opens.
 *
 * Sites rate on different scales — Madara themes (MangaRead, Toonily, …) and
 * ManhuaTop out of 5, Asura, Webtoons and the MangaStream theme (KingOfShojo,
 * ArenaScan) out of 10 — so a site's number is only meaningful together with
 * its config's `rating_scale` (5 when absent).
 *
 * The same rules exist in Python for the desktop app (library_merge.py); keep
 * the two in step.
 */

export const RATING_MAX = 5;

const NUMBER_RE = /\d+(?:\.\d+)?/;

/** The rating scale a site uses: 10 when its config says so, otherwise 5. */
export function ratingScaleFor(config: any): number {
    const n = Number(config?.rating_scale);
    return n === 10 ? 10 : 5;
}

/** First number in a site's rating text ("4.5 out of 5 from 75 votes" → 4.5), or null. */
export function parseRatingNumber(raw: unknown): number | null {
    if (typeof raw !== 'string') return null;
    const m = raw.match(NUMBER_RE);
    if (!m) return null;
    const n = parseFloat(m[0]);
    return Number.isFinite(n) ? n : null;
}

/** 2.5 → "2.5", 4 → "4", 4.75 → "4.8". */
export function formatRating(n: number): string {
    const rounded = Math.round(n * 10) / 10;
    return String(rounded);
}

/**
 * A site's rating text on that site's scale → the stored 5-point value, or ''
 * when there is no usable number (also for a 0, which sites show for
 * "no votes yet").
 */
export function normalizeSiteRating(raw: unknown, scale: number): string {
    const n = parseRatingNumber(raw);
    if (n === null || n <= 0) return '';
    const s = scale === 10 ? 10 : 5;
    const scaled = Math.min(RATING_MAX, (n * RATING_MAX) / s);
    return formatRating(scaled);
}

/**
 * What the reader typed in the rating box → the stored value, or null when it
 * is not a rating (empty, not a number, 0 or below, above 5).
 */
export function formatUserRating(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim().replace(',', '.');
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
    const n = parseFloat(trimmed);
    if (!Number.isFinite(n) || n <= 0 || n > RATING_MAX) return null;
    return formatRating(n);
}

/** True for a value the rating box can produce: a number in (0, 5]. */
export function isUserRating(v: unknown): boolean {
    if (typeof v !== 'string' || v.trim() === '') return false;
    if (!/^\d+(?:\.\d+)?$/.test(v.trim())) return false;
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 && n <= RATING_MAX;
}

export interface RatingSplit {
    /** New value for manga.rating ('' = not rated). */
    rating: string;
    /** New value for manga.site_rating, or null to leave it as it is. */
    siteRating: string | null;
}

/**
 * One-time migration of a stored `rating` from before the split.
 *
 * Until then the column held two kinds of value: site averages written by the
 * desktop app on every refresh ("4.5", "8.9", and whole numbers like "4" when
 * a Madara site's average is exact) and picks from the old 1–10 picker. The
 * desktop re-wrote the column from the site on each refresh and pushed it, so
 * in practice the column holds the site's number: a value the site's scale
 * allows moves to site_rating. Only a number above that scale (an "8" on a
 * 5-star site) cannot be the site's and is kept as an old pick, halved onto
 * the 5-point scale.
 */
export function migrateLegacyRating(raw: unknown, scale: number): RatingSplit {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return { rating: '', siteRating: null };
    const n = parseRatingNumber(s);
    if (n === null) return { rating: '', siteRating: null };
    const siteMax = scale === 10 ? 10 : 5;
    if (n > siteMax) {
        return n <= 10 ? { rating: formatRating(n / 2), siteRating: null } : { rating: '', siteRating: null };
    }
    return { rating: '', siteRating: normalizeSiteRating(s, scale) };
}

/**
 * A `rating` arriving from the cloud. A value the rating box could not have
 * produced (above 5, or text) can only be a site average written by a desktop
 * app from before the split: it moves to site_rating instead of showing as
 * the reader's "8.9 / 5".
 */
export function splitCloudRating(raw: unknown, scale: number): RatingSplit {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return { rating: '', siteRating: null };
    if (isUserRating(s)) return { rating: formatRating(parseFloat(s)), siteRating: null };
    if (parseRatingNumber(s) !== null) return { rating: '', siteRating: normalizeSiteRating(s, scale) };
    return { rating: '', siteRating: null };
}
