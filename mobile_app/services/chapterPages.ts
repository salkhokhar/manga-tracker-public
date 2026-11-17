// Phantom chapter detection (M2c follow-up).
//
// Some sites list a chapter before its pages are uploaded. Opening one returns
// HTTP 200 with no chapter images, so latest_chapter must not move to it and
// no "new chapter" notification may fire for it.
//
// Verified live on www.mangaread.org 2026-10-23 (Eleceed 423, Absolute Sword
// Sense 206, Skeleton Soldier 394):
//   - The series page lists the phantom as chapter[0].
//   - The phantom's chapter URL serves the SERIES template (body class
//     `manga-page` without `reading-manga`, no `.reading-content`) with zero
//     `img.wp-manga-chapter-img`. Same after JS runs.
//   - Real chapters carry one `wp-manga-chapter-img` per page in raw HTML
//     (1-page chapters exist, so one marker is enough). The class name also
//     appears literally inside an encoded `iframe[srcdoc]`, which covers Madara
//     sites that load pages that way.
//
// Works on raw HTML with plain fetch, so the headless background check can use
// it. Host-gated (MangaRead only by default); any site can opt in or override
// from scraper config via `selectors.images.page_markers` (string[] of raw-HTML
// substrings). An empty override array disables the check for that site.

import { parseChapterNumber } from './chapterNumber';
import { isSafeMangaUrl } from './urlSafety';

const DEFAULT_PAGE_MARKERS: Record<string, string[]> = {
    'mangaread.org': ['wp-manga-chapter-img'],
};

const MAX_MARKERS = 10;
const MAX_MARKER_LEN = 64;
/** Chapter pages fetched per source per check, at most. */
export const MAX_PAGE_CHECKS = 2;
const MAX_CANDIDATES = 5;

const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export type PageCheck = 'pages' | 'phantom' | 'unknown';

export interface ChapterCandidate {
    title: string;
    url: string;
}

export type FetchHtml = (url: string) => Promise<{ ok: boolean; html: string }>;

function hostOf(url: unknown): string | null {
    if (typeof url !== 'string' || url.length === 0) return null;
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return null;
    }
}

/**
 * Raw-HTML substrings that prove a chapter page has images, for the site at
 * `url`. Empty means "this site is not checked". A config override
 * (`selectors.images.page_markers`) wins over the built-in host default.
 */
export function getPageMarkers(configRules: any, url: unknown): string[] {
    const override = configRules?.selectors?.images?.page_markers;
    if (Array.isArray(override)) {
        return override
            .filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= MAX_MARKER_LEN)
            .slice(0, MAX_MARKERS);
    }
    const host = hostOf(url);
    if (!host) return [];
    for (const key of Object.keys(DEFAULT_PAGE_MARKERS)) {
        if (host === key || host.endsWith('.' + key)) return DEFAULT_PAGE_MARKERS[key];
    }
    return [];
}

/**
 * Classifies a fetched chapter page. A Cloudflare challenge or any non-OK
 * response is 'unknown' (we learned nothing); an OK page with no marker is a
 * 'phantom'.
 */
export function classifyChapterHtml(ok: boolean, html: unknown, markers: string[]): PageCheck {
    if (!ok || typeof html !== 'string' || html.length === 0 || markers.length === 0) return 'unknown';
    if (/<title>\s*Just a moment/i.test(html) || html.indexOf('challenge-platform') !== -1) return 'unknown';
    return markers.some(m => html.indexOf(m) !== -1) ? 'pages' : 'phantom';
}

function stripTags(html: string): string {
    return html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// String-based on purpose: React Native's URL polyfill resolves relative hrefs
// differently from the WHATWG URL used by the node tests.
const ORIGIN_RE = /^https?:\/\/[^/?#]+/i;
const PATH_RE = /^https?:\/\/[^/?#]+(\/[^?#]*)?/i;

function absoluteHref(href: string, seriesUrl: string): string | null {
    const h = href.replace(/&amp;/g, '&').trim();
    if (/^https?:\/\//i.test(h)) return h;
    if (h.indexOf('//') === 0) return 'https:' + h;
    if (h.indexOf('/') === 0) {
        const o = seriesUrl.match(ORIGIN_RE);
        return o ? o[0] + h : null;
    }
    return null;
}

function pathOf(url: string): string {
    const m = url.match(PATH_RE);
    return m ? m[1] || '/' : '';
}

/**
 * Chapter links of THIS series from a series page's raw HTML, in page order
 * (sites list newest first). Titles are normalized to "Chapter N" to match what
 * the generic refresh regex stores.
 */
export function extractChapterCandidatesFromHtml(html: unknown, seriesUrl: unknown, max = MAX_CANDIDATES): ChapterCandidate[] {
    if (typeof html !== 'string' || html.length === 0 || typeof seriesUrl !== 'string') return [];
    const seriesHost = hostOf(seriesUrl);
    const seriesPath = pathOf(seriesUrl).replace(/\/+$/, '');
    if (!seriesHost || !seriesPath) return [];
    const out: ChapterCandidate[] = [];
    const seen = new Set<string>();
    const anchorRe = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(html)) !== null && out.length < max) {
        const abs = absoluteHref(m[1], seriesUrl);
        if (!abs || !isSafeMangaUrl(abs) || seen.has(abs)) continue;
        if (hostOf(abs) !== seriesHost || pathOf(abs).indexOf(seriesPath + '/') !== 0) continue;
        // The series page itself ("…/series/" with a trailing slash) also matches
        // the prefix; it is not a chapter, and having no page images it would be
        // misread as a phantom.
        if (pathOf(abs).slice(seriesPath.length).replace(/\/+/g, '') === '') continue;
        const n = parseChapterNumber(stripTags(m[2]));
        if (n === null) continue;
        seen.add(abs);
        out.push({ title: `Chapter ${n}`, url: abs });
    }
    return out;
}

export const defaultFetchHtml: FetchHtml = async (url) => {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,*/*' },
    });
    return { ok: res.ok, html: res.ok ? await res.text() : '' };
};

export async function checkChapterPages(url: string, markers: string[], fetchHtml: FetchHtml = defaultFetchHtml): Promise<PageCheck> {
    if (!isSafeMangaUrl(url)) return 'unknown';
    try {
        const { ok, html } = await fetchHtml(url);
        return classifyChapterHtml(ok, html, markers);
    } catch {
        return 'unknown';
    }
}

/**
 * Newest candidate that is safe to store. Candidates for which `needsCheck`
 * is false (not newer than what's stored) are returned as-is with no request.
 * A phantom moves on to the next candidate; a failed check returns null so
 * the caller skips this source until the next run. Fetches at most
 * MAX_PAGE_CHECKS chapter pages. With no markers the first candidate wins.
 */
export async function pickLatestWithPages(
    candidates: ChapterCandidate[],
    markers: string[],
    needsCheck: (title: string) => boolean,
    fetchHtml: FetchHtml = defaultFetchHtml,
): Promise<string | null> {
    if (candidates.length === 0) return null;
    if (markers.length === 0) return candidates[0].title;
    let checks = 0;
    for (const c of candidates) {
        if (!needsCheck(c.title)) return c.title;
        if (checks >= MAX_PAGE_CHECKS) return null;
        checks++;
        const result = await checkChapterPages(c.url, markers, fetchHtml);
        if (result === 'pages') return c.title;
        if (result === 'unknown') return null;
        console.warn('[PAGES]: phantom chapter (listed, no pages) skipped:', c.url);
    }
    return null;
}

/**
 * Explore path: the card only carries the chapter text, not its link, so fetch
 * the series page for candidates first. Returns the newest chapter with pages
 * (or one not needing a check), or null when nothing could be verified.
 */
export async function resolveLatestWithPages(
    seriesUrl: string,
    markers: string[],
    needsCheck: (title: string) => boolean,
    fetchHtml: FetchHtml = defaultFetchHtml,
): Promise<string | null> {
    if (!isSafeMangaUrl(seriesUrl)) return null;
    try {
        const { ok, html } = await fetchHtml(seriesUrl);
        if (!ok) return null;
        return await pickLatestWithPages(extractChapterCandidatesFromHtml(html, seriesUrl), markers, needsCheck, fetchHtml);
    } catch {
        return null;
    }
}
