/**
 * M2b — global serialized chapter-LIST scraper for linked sources.
 *
 * Mirrors probeManager / scrapeManager: a single hidden <WebView>
 * (components/HiddenChapterListWebView.tsx) mounted at the app root pulls the
 * active job from here, loads that source's comic page with the chapter
 * extraction JS built from the source's scraper config, and reports the rows
 * back. Details enqueues one job per linked source after the primary list has
 * rendered and merges each result in as it arrives (services/chapterMerge.ts).
 *
 * Why a separate hidden WebView rather than re-using the Details one: the
 * Details script is bound to the primary's config and URL (reload button,
 * user-agent switch, Cloudflare pop-over, SUCCESS also writes desc/genre/
 * author). Keeping linked-source scraping here leaves that path untouched and
 * lets the primary list render the moment it arrives.
 *
 * Limitation shared with the other hidden views: a source behind an
 * interactive Cloudflare challenge can't be solved here — it times out and the
 * merge simply proceeds without it.
 */

import type { ChapterInfo } from './chapterCache';
import { getLockedRowMarkers, buildLockFilterJs } from './chapterLocks';

export interface ChapterListSpec {
    /** Comic page URL on the linked site (isSafeMangaUrl-validated by the caller). */
    url: string;
    /** scraper_configs.website_name of that site. */
    websiteName: string;
    /** Merged json_rules for that site (from getLocalConfigs). */
    config: any;
}

interface ChapterListJob extends ChapterListSpec {
    resolvers: ((chapters: ChapterInfo[]) => void)[];
    rejecters: ((error: string) => void)[];
    timeoutId?: any;
}

// The injected script gives up after ~45 ticks; allow for page load on top.
const CHLIST_TIMEOUT_MS = 55000;
const MAX_QUEUE = 32;

let pending: ChapterListJob[] = [];
let activeJob: ChapterListJob | null = null;
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach((fn) => { try { fn(); } catch {} });
}

export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** The job the hidden WebView should currently be loading, or null. */
export function getActiveChapterListJob(): { url: string; websiteName: string; injectedJs: string } | null {
    if (!activeJob) return null;
    return {
        url: activeJob.url,
        websiteName: activeJob.websiteName,
        injectedJs: buildChapterListJs(activeJob.config, getLockedRowMarkers(activeJob.config, activeJob.url)),
    };
}

export function getChapterListQueueDepth(): number {
    return pending.length + (activeJob ? 1 : 0);
}

/**
 * Enqueue a chapter-list scrape for one linked source. De-dupes by URL: a
 * repeat enqueue attaches to the in-flight / queued job's outcome.
 */
export function enqueueChapterListScrape(spec: ChapterListSpec): Promise<ChapterInfo[]> {
    if (!spec || typeof spec.url !== 'string' || spec.url.length === 0) {
        return Promise.reject('Missing URL');
    }
    const existing = activeJob?.url === spec.url
        ? activeJob
        : pending.find((p) => p.url === spec.url);
    if (existing) {
        return new Promise<ChapterInfo[]>((resolve, reject) => {
            existing.resolvers.push(resolve);
            existing.rejecters.push(reject);
        });
    }
    if (getChapterListQueueDepth() >= MAX_QUEUE) {
        console.warn('[CHLIST]: queue full, dropping scrape for', spec.url);
        return Promise.reject('Queue full');
    }
    return new Promise<ChapterInfo[]>((resolve, reject) => {
        pending.push({ ...spec, resolvers: [resolve], rejecters: [reject] });
        notify();
        processNext();
    });
}

function processNext() {
    if (activeJob) return;
    const next = pending.shift();
    if (!next) return;
    activeJob = next;
    activeJob.timeoutId = setTimeout(() => {
        if (activeJob !== next) return;
        console.warn(`[CHLIST]: timed out: ${next.url}`);
        finish(null, 'Chapter list scrape timed out');
    }, CHLIST_TIMEOUT_MS);
    notify();
}

function finish(chapters: ChapterInfo[] | null, error: string) {
    const job = activeJob;
    if (!job) return;
    if (job.timeoutId) clearTimeout(job.timeoutId);
    activeJob = null;
    if (chapters) {
        job.resolvers.forEach((r) => { try { r(chapters); } catch {} });
    } else {
        job.rejecters.forEach((r) => { try { r(error); } catch {} });
    }
    notify();
    processNext();
}

/** Called by HiddenChapterListWebView with the validated rows for the active job. */
export function reportChapterList(chapters: ChapterInfo[]) {
    if (!activeJob) return;
    console.log(`[CHLIST]: ${activeJob.websiteName} → ${chapters.length} chapters`);
    finish(chapters, '');
}

/** Called by HiddenChapterListWebView when the active job fails. */
export function reportChapterListError(error: string) {
    if (!activeJob) return;
    console.warn(`[CHLIST]: ${activeJob.websiteName} (${activeJob.url}) → ${error}`);
    finish(null, error);
}

/**
 * Builds the injected chapter-extraction script for one site's config. It's a
 * lean copy of the extraction core in app/details.tsx (config selectors →
 * chapter-substring fallback → slug fallback → deep-link scan), without the
 * diagnostics. Emits CHLIST_RESULT / CHLIST_ERROR / CHLIST_DEBUG. Locked /
 * early-access rows are skipped via the shared filter in chapterLocks.ts.
 *
 * Escape note: regex literals below are written as /\\d/ because this outer
 * template literal strips one backslash, leaving /\d/ in the WebView.
 */
export function buildChapterListJs(config: any, lockedMarkers: string[] = []): string {
    const chRules = (config && config.selectors && config.selectors.chapters) || {};
    return `
    (function() {
        var attempts = 0;
        var maxAttempts = 45;
        var chRules = ${JSON.stringify(chRules)};
        var __bridge = window.ReactNativeWebView;
        function send(type, data) {
            try { __bridge.postMessage(JSON.stringify(Object.assign({ type: type }, data))); } catch (e) {}
        }
        var WHITESPACE_RE = /\\s+/g;
        var DIGIT_RE = /\\d/;
        ${buildLockFilterJs(lockedMarkers)}
        var lockedSkipped = 0;
        // chapters.load_more (config): sites that page the chapter list client-side.
        var __loadMoreClicks = 0, __lastCount = -1, __stalledTicks = 0;

        var iv = setInterval(function() {
            attempts++;
            try {
                var docTitle = document.title || '';
                var html = document.documentElement.innerHTML;
                var isCloudflare = docTitle.indexOf('Just a moment') !== -1 || html.indexOf('cf-challenge') !== -1 || !!document.querySelector('#challenge-form');
                if (isCloudflare) {
                    if (attempts >= maxAttempts) {
                        clearInterval(iv);
                        send('CHLIST_ERROR', { message: 'Cloudflare challenge not cleared' });
                    }
                    return;
                }

                if (attempts === 1) {
                    var loadMoreBtn = document.querySelector('.load-manga-chapters, #load-chapters, [onclick*="manga_get_chapters"]');
                    if (loadMoreBtn) loadMoreBtn.click();
                }

                var items = [];
                if (chRules.item) {
                    try { items = document.querySelectorAll(chRules.item); } catch (e) { items = []; }
                }
                if (items.length === 0) {
                    items = document.querySelectorAll("a[href*='/chapter/'], a[href*='/chapter-'], a[href*='-chapter-'], .chapter-link");
                }
                if (items.length === 0) {
                    var segs = location.pathname.split('/').filter(Boolean);
                    var slug = segs.length > 0 ? segs[segs.length - 1] : '';
                    if (slug.length > 3) {
                        var allAnchors = document.querySelectorAll('a');
                        var slugMatches = [];
                        for (var i = 0; i < allAnchors.length; i++) {
                            var a = allAnchors[i];
                            if (!a.href || a.href === location.href) continue;
                            if (a.href.indexOf(slug) === -1) continue;
                            var afterSlug = a.href.split(slug)[1] || '';
                            if (DIGIT_RE.test(afterSlug)) slugMatches.push(a);
                        }
                        if (slugMatches.length > 0) items = slugMatches;
                    }
                }

                if (items.length === 0 && attempts < maxAttempts) return;

                // Same "load more" handling as the Details scrape: click while the
                // list keeps growing, wait up to 3 ticks per page, at most 10 clicks.
                if (chRules.load_more && items.length > 0 && attempts < maxAttempts && __loadMoreClicks < 10) {
                    var moreBtn = null;
                    try { moreBtn = document.querySelector(chRules.load_more); } catch (e) {}
                    if (items.length > __lastCount) { __lastCount = items.length; __stalledTicks = 0; } else { __stalledTicks++; }
                    if (moreBtn) {
                        // Disabled = a page is still loading: wait, don't collect.
                        if (!moreBtn.disabled && __stalledTicks === 0) { __loadMoreClicks++; moreBtn.click(); return; }
                        if (__stalledTicks < 3) return;
                    }
                }
                clearInterval(iv);

                var results = [];
                for (var j = 0; j < items.length; j++) {
                    var el = items[j];
                    try {
                        var titleEl = (chRules.title === 'self') ? el : (el.querySelector(chRules.title) || el);
                        var linkEl = (chRules.link === 'self') ? el : (el.querySelector(chRules.link) || el);
                        var dateEl = null;
                        if (chRules.date) dateEl = el.querySelector(chRules.date);
                        if (!dateEl) dateEl = el.querySelector('.chapter-release-date, .chapter-release-date i, .chapterdate, .dt, time, [class*="date"]');
                        var dateText = dateEl ? (dateEl.innerText || dateEl.textContent || dateEl.getAttribute('title') || '').trim() : '';
                        var rowTitle = (titleEl.innerText || titleEl.textContent || 'Chapter').trim().replace(WHITESPACE_RE, ' ');
                        if (__isLockedRow(el, rowTitle)) { lockedSkipped++; continue; }
                        if (linkEl && linkEl.href) {
                            results.push({
                                title: rowTitle,
                                link: linkEl.href,
                                date: dateText
                            });
                        }
                    } catch (e) {}
                }

                // Deep-link scan for sites whose chapter URLs don't contain "chapter"
                // (Webtoons: /viewer, /ep-, /episode). Same last resort as Details.
                if (results.length === 0) {
                    var allLinks = document.querySelectorAll('a');
                    for (var k = 0; k < allLinks.length; k++) {
                        var href = (allLinks[k].href || '').toLowerCase();
                        var isChapterLink = href.indexOf('chapter') !== -1 || href.indexOf('viewer') !== -1 || href.indexOf('ep-') !== -1 || href.indexOf('episode') !== -1;
                        if (isChapterLink && !__isLockedRow(allLinks[k], allLinks[k].innerText)) {
                            var dup = false;
                            for (var m = 0; m < results.length; m++) { if (results[m].link === allLinks[k].href) { dup = true; break; } }
                            if (!dup) results.push({ title: (allLinks[k].innerText || '').trim() || 'Episode', link: allLinks[k].href, date: '' });
                        }
                    }
                }

                if (lockedSkipped > 0) send('CHLIST_DEBUG', { message: 'Skipped ' + lockedSkipped + ' locked chapter row(s)' });
                send('CHLIST_RESULT', { chapters: results, url: location.href });
            } catch (e) {
                clearInterval(iv);
                send('CHLIST_ERROR', { message: String((e && e.message) || e) });
            }
        }, 1000);
    })();
    true;
    `;
}
