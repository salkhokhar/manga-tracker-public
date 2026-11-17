// Source auto-discovery — turn a comic title into candidate detail-page URLs
// on other configured sites, so we can probe whether the same comic exists
// there and offer it as a linkable source.
//
// How discovery works: most of the user's sites are Madara/Madara-like
// WordPress themes whose series pages live at a fixed path prefix plus a
// WordPress-sanitized slug of the title, e.g.
//   "Omniscient Reader's Viewpoint" → toonily.com/serie/omniscient-readers-viewpoint/
// We build that URL, load it in a hidden probe WebView, read the resulting
// <title>, and only surface a suggestion when tokenSetSimilarity clears
// SUGGESTION_THRESHOLD (see titleMatch.ts). The user always confirms before
// anything is linked.
//
// Patterns were verified by visiting each site directly (2026-06-08):
//   toonily.com         /serie/{slug}/    — plain slug 302-redirects to a
//                                            hashed canonical (…-7b1d8c89/), so
//                                            we do NOT need to know the hash.
//   mangaclash.com      /manga/{slug}/
//   mangaread.org       /manga/{slug}/    — site uses the www. host; origin is
//                                            taken from the config so this is
//                                            handled automatically.
//   kingofshojo.com     /manga/{slug}/
//   manhuatop.org       /manhua/{slug}/   — primary; falls back to /manga/{slug}/
//                                            since Madara sites can mix post types.
//   gourmetsupremacy.com /project/{slug}/ — replacement for the dead
//                                            gourmetscans.net domain.
//
// NOT pattern-based (deliberately absent → not discoverable, manual paste only):
//   asurascans, webtoons      — random hash / numeric id, unguessable.
//   arenascans                — random-prefixed slugs + rotating domains.
//
// Long-term this map should migrate into scraper_configs in Supabase (a
// `comic_url_pattern` field) so patterns are maintained without an app release.
// buildCandidateUrls already prefers a config-supplied pattern when present;
// the hardcoded URL_PATTERNS below is the documented interim fallback.

import { isSafeMangaUrl } from './urlSafety';

/** Token substituted with the WordPress-sanitized title slug. */
const SLUG_TOKEN = '{slug}';
/** Token in a config's search_url substituted with the URL-encoded query. */
const QUERY_TOKEN = '{query}';
/** Title plus at most two alternate names are searched per site. */
const MAX_SEARCH_NAMES = 3;

/** Result-card selectors for a site's search page. */
export interface SearchRules {
    item: string;
    title: string;
    link: string;
}

/**
 * Fallback when a config has neither `selectors.search` nor `selectors.explore`:
 * Explore's defaults (Madara `.page-item-detail`, MangaStream `.bsx`) plus the
 * Madara search-tab card, which Explore gets from per-site search selectors.
 */
export const DEFAULT_SEARCH_RULES: SearchRules = {
    item: '.page-item-detail, .bsx, .c-tabs-item__content',
    title: 'h3 a, .tt',
    link: 'h3 a, a',
};

/**
 * Hardcoded path templates per host (www-stripped, lowercased). Each value is
 * an ordered list of candidate path templates — the first that resolves to a
 * matching comic wins. Multiple entries exist only where a site mixes post
 * types (e.g. manhuatop's /manhua/ vs /manga/).
 *
 * Hosts intentionally omitted (asura/webtoons/arenascans) are not buildable
 * from a title and fall through to the manual paste-URL flow.
 */
const URL_PATTERNS: Record<string, string[]> = {
    'toonily.com': ['/serie/{slug}/'],
    'mangaclash.com': ['/manga/{slug}/'],
    'mangaread.org': ['/manga/{slug}/'],
    'kingofshojo.com': ['/manga/{slug}/'],
    'manhuatop.org': ['/manhua/{slug}/', '/manga/{slug}/'],
    'gourmetsupremacy.com': ['/project/{slug}/'],
};

/** Lowercase, www-stripped hostname, or null if the URL can't be parsed. */
export function extractHost(url: unknown): string | null {
    if (typeof url !== 'string' || url.length === 0) return null;
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return null;
    }
}

/**
 * The protocol+host origin to build candidate URLs against, derived from the
 * config's own URLs (so the real host — incl. www. or a current mirror domain —
 * is used rather than a hardcoded guess). Returns e.g. "https://www.mangaread.org".
 */
export function getConfigOrigin(config: any): string | null {
    const rules = config?.json_rules ?? config;
    const candidates: unknown[] = [];
    if (rules?.search_url) candidates.push(rules.search_url);
    if (Array.isArray(rules?.explore_categories)) {
        for (const cat of rules.explore_categories) {
            if (cat?.urls && typeof cat.urls === 'object') {
                for (const key of Object.keys(cat.urls)) candidates.push(cat.urls[key]);
            }
        }
    }
    for (const c of candidates) {
        if (typeof c !== 'string') continue;
        try {
            return new URL(c).origin;
        } catch {
            // try next candidate
        }
    }
    return null;
}

/** Convenience: www-stripped host for a config, via getConfigOrigin. */
export function getConfigHost(config: any): string | null {
    return extractHost(getConfigOrigin(config));
}

/**
 * WordPress `sanitize_title`-style slug. Mirrors the behaviour observed on the
 * live sites:
 *   - lowercased
 *   - accents stripped ("Café" → "cafe")
 *   - apostrophes DROPPED, not hyphenated ("Reader's" → "readers")
 *   - every other non-alphanumeric run collapsed to a single hyphen
 *   - leading/trailing hyphens trimmed
 *
 * Examples:
 *   "Omniscient Reader's Viewpoint" → "omniscient-readers-viewpoint"
 *   "Margrave's Bastard Son Was the Emperor" → "margraves-bastard-son-was-the-emperor"
 *   "The Dragon King's Favor" → "the-dragon-kings-favor"
 */
export function titleToSlug(title: string): string {
    if (!title || typeof title !== 'string') return '';
    let s = title;
    // Strip diacritics: decompose then drop combining marks.
    try {
        s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    } catch {
        // normalize unsupported — proceed without accent folding.
    }
    s = s.toLowerCase();
    // Drop apostrophes outright (straight + typographic) so they don't become
    // hyphens: "reader's" → "readers", matching WordPress.
    s = s.replace(/['’‘]/g, '');
    // Everything else non-alphanumeric becomes a separator.
    s = s.replace(/[^a-z0-9]+/g, '-');
    // Collapse repeats and trim.
    s = s.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    return s;
}

/** Per-config pattern override from Supabase (string or string[]), if present. */
function configPatternOverride(config: any): string[] | null {
    const raw = (config?.json_rules ?? config)?.comic_url_pattern;
    if (typeof raw === 'string' && raw.includes(SLUG_TOKEN)) return [raw];
    if (Array.isArray(raw)) {
        const valid = raw.filter((p) => typeof p === 'string' && p.includes(SLUG_TOKEN));
        if (valid.length) return valid;
    }
    return null;
}

/**
 * True when the site has a search page we can query (`search_url` with a
 * {query} token). Search discovery is preferred over slug guessing: it works
 * on sites whose URLs carry hashes or ids (Asura, Webtoons) and finds comics
 * whose slug differs from their title.
 */
export function isSearchable(config: any): boolean {
    const tpl = (config?.json_rules ?? config)?.search_url;
    return typeof tpl === 'string' && tpl.includes(QUERY_TOKEN) && !!getConfigOrigin(config);
}

/**
 * Ordered search-page URLs for `names` on this site: the comic's title first,
 * then its alternate names, capped at MAX_SEARCH_NAMES. Empty when the site
 * isn't searchable. Every URL has passed isSafeMangaUrl.
 */
export function buildSearchUrls(config: any, names: readonly string[]): string[] {
    if (!isSearchable(config)) return [];
    const tpl: string = (config?.json_rules ?? config).search_url;
    const urls: string[] = [];
    for (const name of names) {
        if (typeof name !== 'string' || name.trim().length === 0) continue;
        const url = tpl.replace(QUERY_TOKEN, encodeURIComponent(name.trim()));
        if (isSafeMangaUrl(url) && !urls.includes(url)) urls.push(url);
        if (urls.length >= MAX_SEARCH_NAMES) break;
    }
    return urls;
}

/**
 * Selectors for the result cards on this site's search page, in the order
 * Explore uses them: `selectors.search`, then `selectors.explore` (Madara
 * search results reuse the catalog card), then DEFAULT_SEARCH_RULES.
 */
export function getSearchRules(config: any): SearchRules {
    const selectors = (config?.json_rules ?? config)?.selectors;
    const pick = (rules: any): SearchRules | null => {
        if (!rules || typeof rules !== 'object' || typeof rules.item !== 'string' || !rules.item) return null;
        return {
            item: rules.item,
            title: typeof rules.title === 'string' && rules.title ? rules.title : DEFAULT_SEARCH_RULES.title,
            link: typeof rules.link === 'string' && rules.link ? rules.link : DEFAULT_SEARCH_RULES.link,
        };
    };
    return pick(selectors?.search) ?? pick(selectors?.explore) ?? DEFAULT_SEARCH_RULES;
}

/** True if we can build a title-based candidate URL for this config's site. */
export function isDiscoverable(config: any): boolean {
    if (configPatternOverride(config)) return true;
    const host = getConfigHost(config);
    return !!host && host in URL_PATTERNS;
}

/**
 * Build the ordered list of candidate detail-page URLs for `title` on the site
 * described by `config`. Returns [] when the site isn't pattern-discoverable,
 * the title yields no slug, or no safe URL can be formed.
 *
 * Resolution order for the path template(s):
 *   1. config.json_rules.comic_url_pattern  (Supabase-authoritative, future)
 *   2. URL_PATTERNS[host]                    (verified hardcoded fallback)
 *
 * Every returned URL has passed isSafeMangaUrl, so callers can hand them
 * straight to a WebView / fetch.
 */
export function buildCandidateUrls(config: any, title: string): string[] {
    const slug = titleToSlug(title);
    if (!slug) return [];

    const origin = getConfigOrigin(config);
    if (!origin) return [];

    const templates =
        configPatternOverride(config) ?? URL_PATTERNS[getConfigHost(config) ?? ''];
    if (!templates || templates.length === 0) return [];

    const urls: string[] = [];
    for (const template of templates) {
        const path = template.replace(SLUG_TOKEN, slug);
        // Join origin + path without doubling the slash.
        const url = origin.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path);
        if (isSafeMangaUrl(url) && !urls.includes(url)) urls.push(url);
    }
    return urls;
}
