// In-memory hand-off between Details and Reader. The Details screen scrapes the chapter list,
// then writes it here right before navigating; the Reader reads it for prev/next navigation
// and the page-counter context. Survives only as long as the JS module instance — that's fine,
// since the Reader is always opened via Details in the normal flow.

export interface ChapterInfo {
    title: string;
    link: string;
    date?: string;
    /** M2b: scraper_configs.website_name of the site that supplied `link`. Absent on legacy rows. */
    website_name?: string;
    /** M2b: the same chapter on other linked sources (data only — no UI yet). */
    alternates?: { link: string; website_name: string; title: string }[];
}

let cached: { mangaUrl: string; chapters: ChapterInfo[] } | null = null;

export function setChapterCache(mangaUrl: string, chapters: ChapterInfo[]) {
    cached = { mangaUrl, chapters };
}

export function getChapterCache(mangaUrl: string): ChapterInfo[] | null {
    if (!cached || cached.mangaUrl !== mangaUrl) return null;
    return cached.chapters;
}

export function clearChapterCache() {
    cached = null;
}

/**
 * Index of the row a chapter URL belongs to: its own `link`, or one of its
 * `alternates` (the reader may be showing a fallback source's copy).
 */
export function findChapterIndex(list: ChapterInfo[], url: unknown): number {
    if (typeof url !== 'string' || url.length === 0) return -1;
    const direct = list.findIndex(c => c.link === url);
    if (direct !== -1) return direct;
    return list.findIndex(c => Array.isArray(c.alternates) && c.alternates.some(a => a.link === url));
}

/** Site name of the copy of `row` at `url` ('' when unknown). */
export function sourceNameForUrl(row: ChapterInfo | null | undefined, url: unknown): string {
    if (!row || typeof url !== 'string') return '';
    if (row.link === url) return row.website_name || '';
    const alt = (row.alternates || []).find(a => a.link === url);
    return alt ? alt.website_name : '';
}

/**
 * Next copy of this chapter to try when the current one has no images: the
 * row's own link first, then each alternate in order, skipping every URL in
 * `tried`. Returns null when all copies have been tried.
 */
export function nextFallbackSource(
    row: ChapterInfo | null | undefined,
    tried: string[],
): { link: string; website_name: string } | null {
    if (!row) return null;
    const candidates = [
        { link: row.link, website_name: row.website_name || '' },
        ...(row.alternates || []).map(a => ({ link: a.link, website_name: a.website_name })),
    ];
    return candidates.find(c => typeof c.link === 'string' && c.link.length > 0 && tried.indexOf(c.link) === -1) || null;
}
