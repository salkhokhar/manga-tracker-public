// Locked / paywalled chapter detection (M2c).
//
// Asura Scans lists "Early Access" chapters in the same chapter list, with the
// same <a> markup and the same "Chapter N" title as free ones. Opening one
// returns HTTP 200 with zero chapter images. The app must not list them, count
// them as the latest chapter, or notify about them.
//
// Verified live 2026-10-23:
//   - Every chapter object in Asura's embedded astro-island JSON carries
//     `"is_premium":[0,true|false]`. It is present in the server-rendered HTML,
//     so it works both in a WebView and for the plain-fetch background refresh.
//     This is the authoritative signal.
//   - The visible "Early Access" badge and "Unlocks in 5h 19m" countdown are
//     added client-side after hydration, so they are absent from raw HTML and
//     may be absent on an early scrape tick. They are kept as a secondary check.
//
// Site-specific logic is host-gated (Asura only). The text markers can be
// overridden per site from scraper config via `selectors.chapters.locked_text`
// (string[]), so other sites can opt in from Supabase without an app release.

import { parseChapterNumber } from './chapterNumber';

const ASURA_HOST_RE = /(^|\.)(asurascans\.com|asuracomic\.net)$/i;

const DEFAULT_LOCKED_TEXT: Record<string, string[]> = {
    'asurascans.com': ['Early Access', 'Unlocks in'],
    'asuracomic.net': ['Early Access', 'Unlocks in'],
};

const MAX_MARKERS = 10;
const MAX_MARKER_LEN = 64;

function hostOf(url: unknown): string | null {
    if (typeof url !== 'string' || url.length === 0) return null;
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return null;
    }
}

export function isAsuraUrl(url: unknown): boolean {
    const host = hostOf(url);
    return !!host && ASURA_HOST_RE.test(host);
}

/**
 * Text markers that flag a chapter row as locked for the site at `url`.
 * A config override (`selectors.chapters.locked_text`) wins over the built-in
 * host default; an empty override array disables the text check for that site.
 */
export function getLockedRowMarkers(configRules: any, url: unknown): string[] {
    const override = configRules?.selectors?.chapters?.locked_text;
    if (Array.isArray(override)) {
        return override
            .filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= MAX_MARKER_LEN)
            .slice(0, MAX_MARKERS);
    }
    const host = hostOf(url);
    if (!host) return [];
    for (const key of Object.keys(DEFAULT_LOCKED_TEXT)) {
        if (host === key || host.endsWith('.' + key)) return DEFAULT_LOCKED_TEXT[key];
    }
    return [];
}

export function isLockedRowText(text: unknown, markers: string[]): boolean {
    if (typeof text !== 'string' || text.length === 0) return false;
    return markers.some(m => text.indexOf(m) !== -1);
}

const ASURA_CHAPTER_OBJ_RE = /"series_id":\[0,(\d+)\],"number":\[0,([\d.]+)\][^{}]*?"is_premium":\[0,(true|false)\]/g;

/**
 * Chapter numbers Asura marks `is_premium: true` for the series on this page.
 * Accepts raw HTML (with &quot; entities) or decoded astro-island props. The
 * page's own series is the most frequent non-zero series_id, so chapters of
 * other series embedded elsewhere on the page never hide this series' rows.
 */
export function parseAsuraLockedNumbers(text: unknown): number[] {
    if (typeof text !== 'string' || text.length === 0) return [];
    const decoded = text.indexOf('&quot;') !== -1 ? text.replace(/&quot;/g, '"') : text;
    const rows: { sid: string; n: number; premium: boolean }[] = [];
    const counts = new Map<string, number>();
    ASURA_CHAPTER_OBJ_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ASURA_CHAPTER_OBJ_RE.exec(decoded)) !== null) {
        const n = parseFloat(m[2]);
        if (!Number.isFinite(n)) continue;
        rows.push({ sid: m[1], n, premium: m[3] === 'true' });
        if (m[1] !== '0') counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
    let pageId: string | null = null;
    let best = 0;
    counts.forEach((c, sid) => { if (c > best) { best = c; pageId = sid; } });
    const out: number[] = [];
    for (const r of rows) {
        if (r.premium && (pageId === null || r.sid === pageId) && out.indexOf(r.n) === -1) out.push(r.n);
    }
    return out;
}

function stripTags(html: string): string {
    return html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Background-refresh extractor for an Asura series page fetched as raw HTML.
 * Returns "Chapter N" for the first chapter link of THIS series that is not
 * locked, or null when nothing usable is found (caller falls back).
 */
export function extractLatestUnlockedFromAsuraHtml(html: unknown, pageUrl: unknown): string | null {
    if (typeof html !== 'string' || html.length === 0 || typeof pageUrl !== 'string') return null;
    let seriesPath = '';
    try {
        seriesPath = new URL(pageUrl).pathname.replace(/\/+$/, '');
    } catch {
        return null;
    }
    if (!seriesPath) return null;
    // Asura re-keys series URLs (the trailing -<hex> id changes, e.g.
    // -89829cb7 → -11fe7da3) and redirects the old address. Match chapter
    // links on the slug with any trailing id, so a stale saved URL still works
    // even when the caller can't see the post-redirect URL.
    const baseSlugPath = seriesPath.replace(/-[0-9a-f]{6,12}$/i, '');
    const escapedBase = baseSlugPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const chapterHrefRe = new RegExp(escapedBase + '(?:-[0-9a-f]{6,12})?/chapter/', 'i');
    const locked = new Set(parseAsuraLockedNumbers(html));
    const markers = getLockedRowMarkers(null, pageUrl);
    const anchorRe = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(html)) !== null) {
        const href = m[1];
        if (!chapterHrefRe.test(href)) continue;
        const text = stripTags(m[2]);
        if (isLockedRowText(text, markers)) continue;
        const n = parseChapterNumber(text);
        if (n === null || locked.has(n)) continue;
        return `Chapter ${n}`;
    }
    return null;
}

/**
 * Injected-JS snippet shared by the Details scraper and the linked-source
 * chapter-list scraper. Defines `__isLockedRow(rowEl, titleText)` in the page.
 *
 * Escape note: regexes are written with `\\` because this template literal
 * strips one backslash, leaving single-backslash regex literals in the page.
 */
export function buildLockFilterJs(markers: string[]): string {
    return `
        var __lockedMarkers = ${JSON.stringify(markers)};
        var __isAsuraHost = /asurascans\\.com|asuracomic\\.net/i.test(location.hostname);
        var __lockedNums = null;
        function __buildLockedNums() {
            var out = {};
            if (!__isAsuraHost) return out;
            try {
                var islands = document.querySelectorAll('astro-island[props]');
                var re = /"series_id":\\[0,(\\d+)\\],"number":\\[0,([\\d.]+)\\][^{}]*?"is_premium":\\[0,(true|false)\\]/g;
                var rows = [], counts = {}, m;
                for (var i = 0; i < islands.length; i++) {
                    var raw = islands[i].getAttribute('props') || '';
                    if (raw.indexOf('is_premium') === -1) continue;
                    re.lastIndex = 0;
                    while ((m = re.exec(raw)) !== null) {
                        rows.push([m[1], parseFloat(m[2]), m[3] === 'true']);
                        if (m[1] !== '0') counts[m[1]] = (counts[m[1]] || 0) + 1;
                    }
                }
                var pageId = null, best = 0;
                for (var k in counts) { if (counts[k] > best) { best = counts[k]; pageId = k; } }
                for (var j = 0; j < rows.length; j++) {
                    if (rows[j][2] && (pageId === null || rows[j][0] === pageId)) out[String(rows[j][1])] = true;
                }
            } catch (e) {}
            return out;
        }
        function __rowNumber(text) {
            var mm = (text || '').match(/(?:chapter|chap|ch|episode|ep)\\.?\\s*#?\\s*(\\d+(?:\\.\\d+)?)/i) || (text || '').match(/(\\d+(?:\\.\\d+)?)/);
            return mm ? parseFloat(mm[1]) : null;
        }
        function __isLockedRow(rowEl, titleText) {
            try {
                var t = (rowEl && (rowEl.innerText || rowEl.textContent)) || '';
                for (var i = 0; i < __lockedMarkers.length; i++) {
                    if (t.indexOf(__lockedMarkers[i]) !== -1) return true;
                }
                if (!__isAsuraHost) return false;
                if (__lockedNums === null) __lockedNums = __buildLockedNums();
                var n = __rowNumber(titleText || t);
                return n !== null && !!__lockedNums[String(n)];
            } catch (e) { return false; }
        }
    `;
}
