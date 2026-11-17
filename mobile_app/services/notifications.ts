import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import { initDatabase, getLocalLibrary, getSetting, setSetting, getLocalConfigs, matchConfigToUrlStrict } from './database';
import { parseLinkedSources, countsForUpdates } from './linkedSources';
import { parseChapterNumber, isNewerChapter } from './chapterNumber';
import { isAsuraUrl, extractLatestUnlockedFromAsuraHtml } from './chapterLocks';
import { isAsuraSeriesRekey, rewriteSeriesUrl, canonicalSeriesUrl } from './urlRewrite';
import { supabase } from './supabase';
import { getPageMarkers, extractChapterCandidatesFromHtml, pickLatestWithPages } from './chapterPages';
import { extractMadaraChapterDates, hasTime, isoMinute } from './latestDate';

/** True when running inside the Expo Go sandbox (vs. a dev/standalone build). */
export const IS_EXPO_GO = Constants.appOwnership === 'expo';

export const TASK_NAME = 'CHECK_NEW_CHAPTERS';

// Configure how notifications appear when the app is foregrounded.
// (When backgrounded, iOS uses the system defaults regardless of this.)
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
    }),
});

const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * Pulls the latest chapter title out of a manga page's raw HTML using cheap regex.
 * Returns null if nothing recognizable is found.
 *
 * Strategy:
 *  - Find every `Chapter <number>` style match in the HTML
 *  - Return the FIRST match (manga sites near-universally list newest first)
 *  - Falls back to "Episode <N>" / "Ep. <N>" for Webtoons-style sites
 *
 * This is intentionally a dumb regex parse so it works in a background context
 * (no DOM, no WebView). We don't need a perfect chapter title — only a stable
 * string to compare against the previous run.
 */
export function extractLatestChapterFromHtml(html: string): string | null {
    if (!html) return null;
    const patterns = [
        /Chapter\s+(\d+(?:\.\d+)?)/i,    // "Chapter 12", "Chapter 12.5"
        /Ch(?:\.|apter)?\s*(\d+(?:\.\d+)?)/i,  // "Ch.42"
        /Episode\s+(\d+(?:\.\d+)?)/i,    // Webtoons "Episode 42"
        /Ep\.?\s*(\d+(?:\.\d+)?)/i,      // "Ep 42"
    ];
    for (const pat of patterns) {
        const m = html.match(pat);
        if (m) return m[0]; // return the full match string ("Chapter 12")
    }
    return null;
}

/** One URL to poll for a comic: its primary page or one of its linked sources. */
interface SourceToCheck {
    url: string;
    /** scraper_configs.website_name for linked sources; '' for the primary. */
    websiteName: string;
    isPrimary: boolean;
}

/**
 * Fetch one source page and regex out its latest chapter (null on any failure),
 * plus the URL the page was actually served from after redirects, and that
 * chapter's release date when the page lists one (Madara sites such as
 * MangaRead do), read now so a relative "3 days ago" becomes a real date.
 * `needsCheck` says whether a chapter would count as new for this comic; only
 * those get their chapter page fetched to rule out phantoms.
 */
async function fetchLatestFromSource(
    url: string,
    configRules: any,
    needsCheck: (title: string) => boolean,
): Promise<{ found: string | null; finalUrl: string; releasedAt: string | null }> {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,*/*' },
    });
    // Saved URLs can be stale: Asura re-keys its series addresses and
    // redirects the old ones, so parse against the URL the page came from.
    const finalUrl = res.url || url;
    if (!res.ok) return { found: null, finalUrl, releasedAt: null };
    const html = await res.text();
    const found = await findLatestInHtml(html, finalUrl, configRules, needsCheck);
    const n = found ? parseChapterNumber(found) : null;
    const releasedAt = n !== null ? extractMadaraChapterDates(html).get(n) ?? null : null;
    return { found, finalUrl, releasedAt };
}

async function findLatestInHtml(
    html: string,
    finalUrl: string,
    configRules: any,
    needsCheck: (title: string) => boolean,
): Promise<string | null> {
    // M2c: Asura lists Early Access (paywalled) chapters first. Skip them so a
    // locked chapter never becomes latest_chapter or fires a notification.
    // Falls back to the generic regex if Asura's markup stops matching.
    if (isAsuraUrl(finalUrl)) {
        const unlocked = extractLatestUnlockedFromAsuraHtml(html, finalUrl);
        if (unlocked) return unlocked;
        // No fallback to the generic scan here: an Asura series page with no
        // chapter rows (a series it lists with 0 chapters) still carries
        // "Chapter N" on its sidebar cards for other comics, and that number
        // became this comic's latest chapter.
        console.warn('[CHECK]: Asura page has no readable chapter rows; skipping', finalUrl);
        return null;
    }
    // Phantom guard: sites like MangaRead list a chapter before uploading its
    // pages. There, a chapter that would count as new is accepted only once its
    // page has images; a phantom falls back to the previous chapter, and one we
    // can't verify skips this source until the next check.
    const markers = getPageMarkers(configRules, finalUrl);
    if (markers.length > 0) {
        const candidates = extractChapterCandidatesFromHtml(html, finalUrl);
        if (candidates.length === 0) {
            console.warn('[CHECK]: no chapter links found for page check; skipping', finalUrl);
            return null;
        }
        return pickLatestWithPages(candidates, markers, needsCheck);
    }
    return extractLatestChapterFromHtml(html);
}

/**
 * Core logic — runs both in the background task AND when the user taps "Check now"
 * or pulls-to-refresh on the library. Returns counts; emits per-comic progress so
 * the library UI can render a "Checking 3/12..." indicator.
 *
 * Multi-source (M2): every comic is polled on its primary URL AND each of its
 * linked_sources in parallel; the highest parsed chapter number wins, so the
 * fastest-updating site sets latest_chapter. Ties prefer the primary. The
 * winning site's name is stored in latest_source ('' for the primary) so the
 * library card can hint where the update came from.
 *
 * Plain fetch() is intentional — this runs in a headless background context too,
 * where we don't have a WebView. Cloudflare-protected sites (Asura) will 403 and
 * silently fall into the failures bucket; that's expected. A comic only counts
 * as a failure when none of its sources yielded a chapter.
 */
export async function runChapterCheck(
    onProgress?: (done: number, total: number, currentTitle?: string) => void
): Promise<{ checked: number; updated: number; failures: number }> {
    const db = await initDatabase();
    const library = await getLocalLibrary(db);
    const total = (library as any[]).length;
    let checked = 0;
    let updated = 0;
    let failures = 0;
    const cloudUpdates: Array<{ title: string; latest_chapter: string; latest_date: string }> = [];
    const newChapters: Array<{ title: string; body: string; mangaUrl: string }> = [];
    let datesCorrected = 0;
    // Read before this run stamps it: no stamp yet means this device has never
    // checked, so its stored latest_chapter values are only a starting point.
    const firstCheck = !(await getSetting(db, 'last_chapter_check', ''));
    let configs: any[] = [];
    try { configs = await getLocalConfigs(db); } catch { /* host defaults still apply */ }

    for (let i = 0; i < (library as any[]).length; i++) {
        const m = (library as any[])[i];
        onProgress?.(i, total, m?.title);
        if (!m.manga_url) continue;
        checked++;
        try {
            const sources: SourceToCheck[] = [
                { url: m.manga_url, websiteName: '', isPrimary: true },
                // Sources flagged as a probable different series can't set
                // latest_chapter or fire notifications until the user keeps them;
                // neither can sources the user muted for update checks.
                ...parseLinkedSources(m.linked_sources).filter(countsForUpdates).map(s => ({
                    url: s.manga_url, websiteName: s.website_name, isPrimary: false,
                })),
            ];
            // All sources for one comic in parallel; comics stay sequential so the
            // progress indicator and request volume behave as before.
            const needsCheck = (t: string) => isNewerChapter(t, m.latest_chapter, m.chapter);
            const settled = await Promise.allSettled(sources.map(s =>
                fetchLatestFromSource(s.url, matchConfigToUrlStrict(configs, s.url)?.json_rules ?? null, needsCheck)
            ));

            // A source that redirected to its re-keyed Asura address gets its
            // stored URL rewritten once (primary row, downloads, linked lists).
            let primaryUrl: string = m.manga_url;
            for (let k = 0; k < settled.length; k++) {
                const r = settled[k];
                if (r.status === 'fulfilled' && isAsuraSeriesRekey(sources[k].url, r.value.finalUrl)) {
                    try {
                        const rw = await rewriteSeriesUrl(db, sources[k].url, r.value.finalUrl);
                        if (sources[k].isPrimary && rw.primaryTitle) primaryUrl = canonicalSeriesUrl(r.value.finalUrl);
                    } catch (e: any) {
                        console.warn('[CHECK]: URL rewrite failed:', e?.message || e);
                    }
                }
            }

            let best: { found: string; source: SourceToCheck; releasedAt: string | null } | null = null;
            settled.forEach((r, idx) => {
                if (r.status !== 'fulfilled' || !r.value.found) return;
                const candidate = { found: r.value.found, source: sources[idx], releasedAt: r.value.releasedAt };
                if (!best) { best = candidate; return; }
                const n = parseChapterNumber(candidate.found);
                const bestN = parseChapterNumber(best.found);
                // Strictly greater replaces; equal keeps the earlier (primary-first) entry.
                if (n !== null && (bestN === null || n > bestN)) best = candidate;
            });
            if (!best) { failures++; continue; }
            const { found, source, releasedAt } = best as { found: string; source: SourceToCheck; releasedAt: string | null };
            const latestSource = source.isPrimary ? '' : source.websiteName;
            // The site's own date for this chapter when the page lists one ("31 Jul
            // 2026", or a UTC timestamp for a relative "6 hours ago"), else now.
            const releasedDate = releasedAt;

            // Every source answered and none has the stored latest chapter: it
            // came from a source since removed or from a misread page. Bring it
            // down to the newest chapter the sources really have (it only ever
            // moved up before, so such a number stayed for good).
            const everySourceAnswered = settled.every(r => r.status === 'fulfilled' && !!r.value.found);
            const foundN = parseChapterNumber(found);
            const storedN = parseChapterNumber(m.latest_chapter);
            if (everySourceAnswered && foundN !== null && storedN !== null && storedN > foundN) {
                await db.runAsync(
                    'UPDATE manga SET latest_chapter = ?, latest_source = ? WHERE title = ?',
                    [found, latestSource, m.title],
                );
                cloudUpdates.push({ title: m.title, latest_chapter: found, latest_date: releasedDate || m.latest_date || '' });
                console.log(`[CHECK]: "${m.title}" latest corrected ${m.latest_chapter} -> ${found} (on no source)`);
                continue;
            }

            if (isNewerChapter(found, m.latest_chapter, m.chapter)) {
                const latestDate = releasedDate || isoMinute();
                await db.runAsync(
                    'UPDATE manga SET latest_chapter = ?, latest_source = ?, latest_date = ? WHERE title = ?',
                    [found, latestSource, latestDate, m.title],
                );
                cloudUpdates.push({ title: m.title, latest_chapter: found, latest_date: latestDate });
                newChapters.push({
                    title: m.title,
                    body: source.isPrimary ? `New: ${found}` : `New: ${found} on ${source.websiteName}`,
                    mangaUrl: primaryUrl,
                });
                updated++;
            } else {
                const f = parseChapterNumber(found);
                const l = parseChapterNumber(m.latest_chapter);
                const sameChapter = f !== null && l !== null && f === l;
                if (source.isPrimary && m.latest_source && sameChapter) {
                    // Primary has caught up to the chapter a linked source reported
                    // earlier — drop the "via <site>" hint so the card stops showing it.
                    await db.runAsync('UPDATE manga SET latest_source = ? WHERE title = ?', ['', m.title]);
                }
                // Same chapter, but the stored date is wrong, stale (the desktop
                // saved "1 hour ago" back in July) or only a day: use the site's.
                // A stored timestamp is already exact; the site's rounded "N hours
                // ago" would otherwise rewrite it on every check.
                if (sameChapter && releasedDate && !hasTime(m.latest_date) && releasedDate !== m.latest_date) {
                    await db.runAsync('UPDATE manga SET latest_date = ? WHERE title = ?', [releasedDate, m.title]);
                    cloudUpdates.push({ title: m.title, latest_chapter: m.latest_chapter, latest_date: releasedDate });
                    datesCorrected++;
                }
            }
        } catch (e: any) {
            failures++;
            // Cloudflare-protected sites typically throw or return 403 here — that's expected and handled.
        }
    }

    // Push fresh values in one request so the next cloud pull doesn't roll them
    // back. In a headless background run there may be no session or network;
    // bulkRestoreLocal keeps the higher local value in that case, so just log.
    if (cloudUpdates.length > 0) {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user) {
                const { error } = await supabase.from('manga_library').upsert(
                    cloudUpdates.map(u => ({ user_id: session.user.id, ...u })),
                    { onConflict: 'user_id,title' },
                );
                if (error) console.warn('[CHECK]: cloud push of latest_chapter failed:', error.message);
            }
        } catch (e: any) {
            console.warn('[CHECK]: cloud push of latest_chapter failed:', e?.message || e);
        }
    }

    if (datesCorrected > 0) console.log(`[CHECK]: Corrected latest_date from the site for ${datesCorrected} comic(s)`);
    await notifyNewChapters(newChapters, { firstCheck, inForeground: AppState.currentState === 'active' });

    onProgress?.(total, total);
    await setSetting(db, 'last_chapter_check', new Date().toISOString());
    return { checked, updated, failures };
}

/** Most individual notifications one check may send; more become one summary. */
export const MAX_INDIVIDUAL_NOTIFICATIONS = 3;

/**
 * Notification policy for one chapter check:
 *  - the first check on a device only records where every comic stands (on a
 *    fresh install the stored latest_chapter values are stale, so nearly every
 *    comic would otherwise "have a new chapter");
 *  - nothing while the app is open: the library already shows what's new;
 *  - up to MAX_INDIVIDUAL_NOTIFICATIONS one per comic, beyond that one summary.
 */
export function planNotifications(
    items: { title: string; body: string; mangaUrl: string }[],
    opts: { firstCheck: boolean; inForeground: boolean },
): { title: string; body: string; data: Record<string, string> }[] {
    if (items.length === 0 || opts.firstCheck || opts.inForeground) return [];
    if (items.length <= MAX_INDIVIDUAL_NOTIFICATIONS) {
        return items.map(i => ({
            title: i.title,
            body: i.body,
            data: { manga_url: i.mangaUrl, chapter_url: i.mangaUrl, source: 'chapter-check' },
        }));
    }
    const names = items.slice(0, 3).map(i => i.title).join(', ');
    return [{
        title: `${items.length} comics have new chapters`,
        body: `${names}${items.length > 3 ? ` and ${items.length - 3} more` : ''}`,
        data: { source: 'chapter-check-summary' },
    }];
}

async function notifyNewChapters(
    items: { title: string; body: string; mangaUrl: string }[],
    opts: { firstCheck: boolean; inForeground: boolean },
): Promise<void> {
    const planned = planNotifications(items, opts);
    if (items.length > 0) {
        const why = opts.firstCheck ? 'first check on this device' : opts.inForeground ? 'app is open' : `${planned.length} sent`;
        console.log(`[CHECK]: ${items.length} new chapter(s); notifications: ${why}`);
    }
    for (const n of planned) {
        try {
            await Notifications.scheduleNotificationAsync({ content: n, trigger: null });
        } catch (e: any) {
            console.warn('[CHECK]: notification failed:', e?.message || e);
        }
    }
}

// Define the background task. Must be at module top level so it's registered
// when the JS bundle loads (including in headless background contexts).
TaskManager.defineTask(TASK_NAME, async () => {
    try {
        const { updated } = await runChapterCheck();
        return updated > 0
            ? BackgroundFetch.BackgroundFetchResult.NewData
            : BackgroundFetch.BackgroundFetchResult.NoData;
    } catch (e) {
        console.warn('[BG TASK]: failed', e);
        return BackgroundFetch.BackgroundFetchResult.Failed;
    }
});

export async function ensureNotificationPermissions(): Promise<boolean> {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.status === 'granted') return true;
    const req = await Notifications.requestPermissionsAsync();
    return req.status === 'granted';
}

export async function isBackgroundCheckEnabled(): Promise<boolean> {
    try {
        return await TaskManager.isTaskRegisteredAsync(TASK_NAME);
    } catch {
        return false;
    }
}

export async function enableBackgroundCheck(): Promise<{ ok: boolean; error?: string; expoGoLimited?: boolean }> {
    const granted = await ensureNotificationPermissions();
    if (!granted) return { ok: false, error: 'Notification permission was not granted.' };

    // Expo Go's Info.plist does not include `fetch` in UIBackgroundModes, so registering
    // a background task throws. We can't change that without a dev build. Don't even try —
    // surface a clear message instead of the cryptic native error.
    if (IS_EXPO_GO) {
        return {
            ok: false,
            expoGoLimited: true,
            error: 'Background checks aren\'t available in Expo Go. The "Check now" button works in any build; for automatic alerts every few hours, you need a development build (npx expo prebuild && npx expo run:ios).',
        };
    }

    try {
        await BackgroundFetch.registerTaskAsync(TASK_NAME, {
            minimumInterval: 15 * 60, // 15 minutes; iOS decides actual cadence
            stopOnTerminate: false,
            startOnBoot: true,
        });
        return { ok: true };
    } catch (e: any) {
        console.warn('[BG TASK]: register failed', e);
        return { ok: false, error: e.message || 'Could not register background task' };
    }
}

export async function disableBackgroundCheck(): Promise<void> {
    try {
        await BackgroundFetch.unregisterTaskAsync(TASK_NAME);
    } catch (e) {
        // unregister can throw if task wasn't registered; safe to ignore
    }
}

export async function getBackgroundFetchStatus(): Promise<string> {
    if (Platform.OS === 'web') return 'unsupported';
    const status = await BackgroundFetch.getStatusAsync();
    switch (status) {
        case BackgroundFetch.BackgroundFetchStatus.Available: return 'available';
        case BackgroundFetch.BackgroundFetchStatus.Denied: return 'denied';
        case BackgroundFetch.BackgroundFetchStatus.Restricted: return 'restricted';
        default: return 'unknown';
    }
}

export async function getLastCheckTime(): Promise<string | null> {
    try {
        const db = await initDatabase();
        const v = await getSetting(db, 'last_chapter_check', '');
        return v || null;
    } catch { return null; }
}
