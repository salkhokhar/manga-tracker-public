/**
 * Global serialized source-probe queue. Mirrors scrapeManager: a single hidden
 * <WebView> (components/HiddenProbeWebView.tsx) mounted at the app root pulls
 * the active candidate URL from here, loads it, reads what we need from the
 * page, and reports back. This module decides — RN-side — whether the loaded
 * page shows the comic we're looking for, using titleMatch.bestNameSimilarity.
 *
 * Why probing exists: after a comic is added we want to suggest "this also
 * exists on site X". Two kinds of job:
 *   'search' — the site's own search page (sourceDiscovery.buildSearchUrls),
 *              one per name we know for the comic; the result cards are read
 *              with the config's search selectors and the best-scoring card
 *              wins. Works on every site with a search_url, including those
 *              whose detail URLs can't be guessed (Asura, Webtoons).
 *   'page'   — a guessed detail-page URL (sourceDiscovery.buildCandidateUrls);
 *              the page's title(s) and its "Alternative" names row are scored.
 *              Fallback for sites without a search page.
 * A 404 / wrong page simply fails the similarity threshold, so we don't need
 * explicit not-found detection.
 *
 * Each job carries an ORDERED list of candidate URLs. We try them one at a time
 * and stop at the first match; if none match (or all error/time out) the job
 * resolves with null. This is what lets manhuatop try /manhua/ then /manga/,
 * and a search job try the title, then the alternate names.
 *
 * The user always confirms a suggestion before it's linked, so the threshold is
 * tuned to "worth showing", not "auto-link".
 */

import { bestNameSimilarity, SUGGESTION_THRESHOLD } from './titleMatch';
import { isSafeMangaUrl } from './urlSafety';
import { parseAltNames } from './altNames';
import { extractHost, SearchRules } from './sourceDiscovery';

export interface ProbeResult {
    /** scraper_configs.website_name this match belongs to. */
    websiteName: string;
    /** The candidate URL that matched (already isSafeMangaUrl-validated upstream). */
    matchedUrl: string;
    /** Title read from the matched page or result card (for logging / display). */
    pageTitle: string;
    /** bestNameSimilarity score, 0–1. */
    score: number;
    /**
     * Names the other site lists for this comic: its "Alternative" row for a
     * page probe, the matched card's title for a search probe. Merged into
     * manga.alternative_names when the user links the source.
     */
    altNames: string[];
}

/** Selectors for the "Alternative" names row on a detail page (config.selectors.details). */
export interface DetailMetaRules {
    container: string;
    key: string;
    val: string;
    /** A dedicated alternate-names element with no heading (config details.alt_names). */
    alt?: string;
}

export interface ProbeSpec {
    websiteName: string;
    /** Library comic title we're trying to find on the other site. */
    comicTitle: string;
    /** Ordered candidate URLs to try until one matches (detail pages or search pages). */
    candidateUrls: string[];
    /** 'search' loads search pages and scores result cards; default 'page'. */
    kind?: 'page' | 'search';
    /** Every name we know for the comic (title + usable alternates). Defaults to [comicTitle]. */
    names?: string[];
    /** Result-card selectors for a search job. */
    searchRules?: SearchRules;
    /** Where the "Alternative" row lives on this site's detail pages (page job). */
    detailMeta?: DetailMetaRules | null;
    /** Host (www-stripped) result links must belong to; defaults to the candidate URL's host. */
    host?: string | null;
}

interface ProbeJob extends ProbeSpec {
    id: string;
    kind: 'page' | 'search';
    names: string[];
    candidateIndex: number;
    resolve: (result: ProbeResult | null) => void;
    timeoutId?: any;
}

/** One result card read from a search page. */
export interface SearchResultCard {
    title: string;
    link: string;
}

// Generous per-candidate budget: these sites sit behind Cloudflare, so the
// WebView may have to clear a JS challenge before the real page renders.
const PROBE_TIMEOUT_MS = 30000;
const MAX_QUEUE = 64;

let pending: ProbeJob[] = [];
let activeJob: ProbeJob | null = null;
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach((fn) => { try { fn(); } catch {} });
}

export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** The candidate URL the hidden WebView should currently be loading, or null. */
export function getActiveProbeUrl(): string | null {
    if (!activeJob) return null;
    return activeJob.candidateUrls[activeJob.candidateIndex] || null;
}

/** The script the hidden WebView injects for the active candidate. */
export function getActiveProbeScript(): string {
    if (!activeJob) return PROBE_JS;
    if (activeJob.kind === 'search') return buildSearchProbeJs(activeJob.searchRules);
    return buildProbeJs(activeJob.detailMeta);
}

export function getProbeQueueDepth(): number {
    return pending.length + (activeJob ? 1 : 0);
}

function jobId(spec: ProbeSpec): string {
    return `${spec.comicTitle}::${spec.websiteName}`;
}

/**
 * Enqueue a probe. Returns a Promise resolving to the matching ProbeResult, or
 * null if no candidate matched. De-dupes by (comicTitle, websiteName): a repeat
 * enqueue attaches to the in-flight job's outcome rather than starting a new one.
 */
export function enqueueProbe(spec: ProbeSpec): Promise<ProbeResult | null> {
    const id = jobId(spec);
    const candidateUrls = (spec.candidateUrls || []).filter(
        (u) => typeof u === 'string' && u.length > 0,
    );
    if (candidateUrls.length === 0) return Promise.resolve(null);

    // Attach to an existing job with the same id (active or queued).
    const existing = activeJob?.id === id
        ? activeJob
        : pending.find((p) => p.id === id);
    if (existing) {
        const prior = existing.resolve;
        return new Promise<ProbeResult | null>((resolve) => {
            existing.resolve = (r) => { prior(r); resolve(r); };
        });
    }

    if (getProbeQueueDepth() >= MAX_QUEUE) {
        console.warn('[PROBE]: queue full, dropping probe for', id);
        return Promise.resolve(null);
    }

    const names = (spec.names || []).filter((n) => typeof n === 'string' && n.trim().length > 0);
    return new Promise<ProbeResult | null>((resolve) => {
        pending.push({
            ...spec,
            kind: spec.kind === 'search' ? 'search' : 'page',
            names: names.length > 0 ? names : [spec.comicTitle],
            candidateUrls,
            id,
            candidateIndex: 0,
            resolve,
        });
        notify();
        processNext();
    });
}

function armTimeout(job: ProbeJob) {
    job.timeoutId = setTimeout(() => {
        if (activeJob !== job) return;
        console.warn(`[PROBE]: candidate timed out: ${getActiveProbeUrl()}`);
        advanceCandidate(null);
    }, PROBE_TIMEOUT_MS);
}

function processNext() {
    if (activeJob) return;
    const next = pending.shift();
    if (!next) return;
    activeJob = next;
    armTimeout(activeJob);
    notify();
}

function finishJob(result: ProbeResult | null) {
    const job = activeJob;
    if (!job) return;
    if (job.timeoutId) clearTimeout(job.timeoutId);
    activeJob = null;
    try { job.resolve(result); } catch {}
    notify();
    processNext();
}

/**
 * Move to the job's next candidate URL, or finish the job with `fallback`
 * (null = no match) when candidates are exhausted. Called on a non-match,
 * an error, or a timeout for the current candidate.
 */
function advanceCandidate(fallback: ProbeResult | null) {
    const job = activeJob;
    if (!job) return;
    if (job.timeoutId) clearTimeout(job.timeoutId);
    job.candidateIndex++;
    if (job.candidateIndex < job.candidateUrls.length) {
        armTimeout(job);
        notify(); // new active URL → WebView reloads (keyed on url)
        return;
    }
    finishJob(fallback);
}

/**
 * Called by HiddenProbeWebView once a candidate detail page has loaded and its
 * title is readable. Scores every name we know against the page's titles and
 * its "Alternative" row; a clearing score finishes the job as a match,
 * otherwise we advance to the next candidate.
 *
 * `titles` may include the document title, og:title, and an h1 — we take the
 * best similarity across them since themes vary in which is the clean name.
 */
export function reportProbeTitles(titles: string[], finalUrl: string, altNamesRaw: string = '') {
    const job = activeJob;
    if (!job) return;
    if (job.kind !== 'page') { advanceCandidate(null); return; }
    const altNames = parseAltNames(altNamesRaw);
    const best = bestNameSimilarity(job.names, [...titles, ...altNames]);
    if (best >= SUGGESTION_THRESHOLD) {
        // Prefer the post-redirect canonical URL (e.g. Toonily's …-hash/ form)
        // when it's safe — it avoids a redirect hop on every later scrape.
        // Fall back to the candidate URL we navigated to.
        const candidate = getActiveProbeUrl();
        const matchedUrl = isSafeMangaUrl(finalUrl) ? finalUrl : (candidate || finalUrl);
        const pageTitle = titles.find((t) => !!t) || '';
        console.log(`[PROBE]: match ${job.websiteName} (${best.toFixed(2)}) → ${matchedUrl}`);
        finishJob({ websiteName: job.websiteName, matchedUrl, pageTitle, score: best, altNames });
        return;
    }
    advanceCandidate(null);
}

/**
 * Pick the result card that best matches our names: its link must be a safe
 * URL on `host` (when given) and its title must clear the threshold. Pure, so
 * the scoring is unit-testable without the queue.
 */
export function pickSearchMatch(
    results: readonly SearchResultCard[],
    names: readonly string[],
    host: string | null | undefined,
): { link: string; title: string; score: number } | null {
    let best: { link: string; title: string; score: number } | null = null;
    for (const r of results) {
        if (!r || typeof r.link !== 'string' || typeof r.title !== 'string') continue;
        if (!isSafeMangaUrl(r.link)) continue;
        if (host && extractHost(r.link) !== host) continue;
        const score = bestNameSimilarity(names, [r.title]);
        if (score < SUGGESTION_THRESHOLD) continue;
        if (!best || score > best.score) best = { link: r.link, title: r.title, score };
    }
    return best;
}

/**
 * Called by HiddenProbeWebView with the result cards read from a search page.
 * The best clearing card finishes the job as a match; none → next candidate
 * (the next name to search with), or no match once names run out.
 */
export function reportSearchResults(results: SearchResultCard[], finalUrl: string) {
    const job = activeJob;
    if (!job) return;
    if (job.kind !== 'search') { advanceCandidate(null); return; }
    const host = job.host ?? extractHost(getActiveProbeUrl() || finalUrl);
    const pick = pickSearchMatch(results, job.names, host);
    if (pick) {
        console.log(`[PROBE]: search match ${job.websiteName} (${pick.score.toFixed(2)}) → ${pick.link}`);
        finishJob({
            websiteName: job.websiteName,
            matchedUrl: pick.link,
            pageTitle: pick.title,
            score: pick.score,
            altNames: [pick.title],
        });
        return;
    }
    advanceCandidate(null);
}

/** Called by HiddenProbeWebView when a candidate fails to load. */
export function reportProbeError(error: string) {
    if (!activeJob) return;
    console.warn(`[PROBE]: candidate error (${getActiveProbeUrl()}): ${error}`);
    advanceCandidate(null);
}

/**
 * Injected into the probe WebView for a detail-page candidate. Polls for a
 * usable page title, riding out a Cloudflare interstitial first (its
 * title/body match the challenge patterns). Emits PROBE_RESULT with
 * document.title, og:title, the first h1 and the "Alternative" names row (read
 * with the site's meta selectors when given) so the RN side can score them.
 * PROBE_DEBUG/PROBE_ERROR for diagnostics.
 */
export function buildProbeJs(meta?: DetailMetaRules | null): string {
    const metaJson = JSON.stringify(meta && (meta.container || meta.alt) ? meta : null);
    return `
    (function() {
        function send(type, data) {
            try { window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ type: type }, data))); } catch (e) {}
        }
        var meta = ${metaJson};
        var altRe = /alternative|alt(ernate)?\\s*(name|title)|synonym|other\\s*name|associated\\s*name/i;
        // "Alternative" row: the meta container whose heading matches altRe.
        function readAltNames() {
            if (!meta) return '';
            try {
                if (meta.alt) {
                    var altEl = document.querySelector(meta.alt);
                    if (altEl) return (altEl.textContent || '').replace(/\\s+/g, ' ').trim().substring(0, 1000);
                }
                if (!meta.container) return '';
                var blocks = document.querySelectorAll(meta.container);
                for (var i = 0; i < blocks.length; i++) {
                    var b = blocks[i];
                    var keyEl = meta.key === 'self' ? b : b.querySelector(meta.key);
                    var valEl = meta.val === 'self' ? b : b.querySelector(meta.val);
                    var key = keyEl ? (keyEl.textContent || '') : '';
                    if (!altRe.test(key)) continue;
                    var val = valEl ? (valEl.textContent || '') : '';
                    if (meta.key === 'self' || meta.val === 'self') val = val.replace(altRe, '');
                    return val.replace(/\\s+/g, ' ').trim().substring(0, 1000);
                }
            } catch (e) {}
            return '';
        }
        var attempts = 0;
        var maxAttempts = 20; // ~14s at 700ms
        var challenge = /just a moment|attention required|checking your browser|verifying you are human|enable javascript and cookies/i;
        var iv = setInterval(function() {
            attempts++;
            try {
                var docTitle = document.title || '';
                var ogEl = document.querySelector('meta[property="og:title"], meta[name="og:title"]');
                var ogTitle = ogEl ? (ogEl.getAttribute('content') || '') : '';
                var h1El = document.querySelector('.post-title h1, .entry-title, h1');
                var h1 = h1El ? (h1El.textContent || '').trim() : '';
                var bodyLen = document.body ? (document.body.innerText || '').length : 0;

                var stillChallenge = challenge.test(docTitle) || (bodyLen < 80 && challenge.test((document.body && document.body.innerText) || ''));
                var haveTitle = !!(h1 || ogTitle || docTitle);

                // Resolve once we have a real (non-challenge) title and either an
                // h1 is present or we've waited a few ticks for client rendering.
                if (haveTitle && !stillChallenge && (h1 || ogTitle || attempts >= 4)) {
                    clearInterval(iv);
                    send('PROBE_RESULT', { docTitle: docTitle, ogTitle: ogTitle, h1: h1, altNames: readAltNames(), url: window.location.href });
                } else if (attempts >= maxAttempts) {
                    clearInterval(iv);
                    send('PROBE_RESULT', { docTitle: docTitle, ogTitle: ogTitle, h1: h1, altNames: readAltNames(), url: window.location.href });
                }
            } catch (e) {
                clearInterval(iv);
                send('PROBE_ERROR', { message: String((e && e.message) || e) });
            }
        }, 700);
    })();
    true;
`;
}

/** Detail-page probe script without an "Alternative" row (kept for callers that have no config). */
export const PROBE_JS = buildProbeJs(null);

/**
 * Injected into the probe WebView for a search-page candidate. Waits for the
 * result cards (client-rendered catalogs such as Asura and Webtoons fill in
 * after hydration, Cloudflare may interpose a challenge first), then emits
 * PROBE_SEARCH with each card's title and link. An empty list after the full
 * wait means "no results", which the RN side treats as a non-match.
 */
export function buildSearchProbeJs(rules?: SearchRules): string {
    const rulesJson = JSON.stringify(rules && rules.item ? rules : { item: '.page-item-detail, .bsx, .c-tabs-item__content', title: 'h3 a, .tt', link: 'h3 a, a' });
    return `
    (function() {
        function send(type, data) {
            try { window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ type: type }, data))); } catch (e) {}
        }
        var rules = ${rulesJson};
        var attempts = 0;
        var maxAttempts = 20; // ~14s at 700ms
        var challenge = /just a moment|attention required|checking your browser|verifying you are human|enable javascript and cookies/i;
        function text(el) { return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; }
        function readCards() {
            var items = [];
            try { items = document.querySelectorAll(rules.item); } catch (e) { items = []; }
            var out = [];
            for (var i = 0; i < items.length && out.length < 40; i++) {
                var el = items[i];
                var titleEl = null, linkEl = null;
                try { titleEl = rules.title === 'self' ? el : el.querySelector(rules.title); } catch (e) {}
                try { linkEl = rules.link === 'self' ? el : el.querySelector(rules.link); } catch (e) {}
                if (!linkEl || !linkEl.href) linkEl = el.closest ? el.closest('a') : null;
                if (!linkEl || !linkEl.href) continue;
                var title = text(titleEl) || linkEl.getAttribute('title') || '';
                if (!title) { var img = el.querySelector('img'); title = img ? (img.getAttribute('alt') || '') : ''; }
                if (!title) continue;
                out.push({ title: title.substring(0, 300), link: linkEl.href });
            }
            return out;
        }
        var iv = setInterval(function() {
            attempts++;
            try {
                var docTitle = document.title || '';
                var bodyLen = document.body ? (document.body.innerText || '').length : 0;
                var stillChallenge = challenge.test(docTitle) || (bodyLen < 80 && challenge.test((document.body && document.body.innerText) || ''));
                var cards = stillChallenge ? [] : readCards();
                if (cards.length > 0 || attempts >= maxAttempts) {
                    clearInterval(iv);
                    send('PROBE_SEARCH', { results: cards, url: window.location.href });
                }
            } catch (e) {
                clearInterval(iv);
                send('PROBE_ERROR', { message: String((e && e.message) || e) });
            }
        }, 700);
    })();
    true;
`;
}
