import React, { useState, useEffect, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, Image, TouchableOpacity, ActivityIndicator, ScrollView, Dimensions, Alert, RefreshControl, TextInput, Modal, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { initDatabase, getLocalLibrary, getLocalConfigs, matchConfigToUrl, matchConfigToUrlStrict, assertMangaColumns, getSavedChapterList, saveChapterList, getDownloadedChaptersForManga } from '../services/database';
import { supabase, pushAddToCloud, removeFromCloud } from '../services/supabase';
import { useAppTheme, AppColors } from '../services/theme';
import { downloadChapter, deleteChapterDownload, deleteAllMangaDownloads, getDownloadedChapterUrls } from '../services/downloads';
import { enqueue as enqueueDownload, subscribe as subscribeDownloads, getQueue as getDownloadQueue, isInQueue, cancelAllForManga as cancelAllDownloadsForManga } from '../services/downloadQueue';
import { scheduleScrape, getQueuedUrls as getScrapeQueuedUrls, subscribe as subscribeScrape, getActiveUrl as getActiveScrapeUrl } from '../services/scrapeManager';
import { setChapterCache } from '../services/chapterCache';
import { isSafeMangaUrl } from '../services/urlSafety';
import { parseWebViewMessage, isBoundedArray, clampString } from '../services/webviewMessage';
import { WEBVIEW_HARDENING_PROPS, webViewNavigationGate } from '../services/webviewSafety';
import {
    LinkedSource,
    parseLinkedSources,
    serializeLinkedSources,
    addLinkedSource,
    removeLinkedSource,
    isUsableLinkedSource,
    setLinkedSourceMismatch,
    setLinkedSourceUpdates,
    countsForUpdates,
} from '../services/linkedSources';
import { checkSourceMismatch, describeMismatch, MismatchVerdict } from '../services/sourceMismatch';
import { buildCandidateUrls, isDiscoverable, isSearchable, buildSearchUrls, getSearchRules, getConfigHost, extractHost } from '../services/sourceDiscovery';
import { findSameSeries } from '../services/libraryMatch';
import { enqueueProbe, ProbeResult, ProbeSpec } from '../services/probeManager';
import { parseAltNames, mergeAltNames, namesForMatching } from '../services/altNames';
import { ratingScaleFor, normalizeSiteRating, formatUserRating, RATING_MAX } from '../services/rating';
import { isChapterDowngrade, isNewerChapter, parseChapterNumber } from '../services/chapterNumber';
import { isoMinute } from '../services/latestDate';
import { getPageMarkers, pickLatestWithPages } from '../services/chapterPages';
import { mergeChapterLists } from '../services/chapterMerge';
import { enqueueChapterListScrape } from '../services/chapterListManager';
import { getLockedRowMarkers, buildLockFilterJs } from '../services/chapterLocks';
import { isAsuraSeriesRekey, rewriteSeriesUrl, canonicalSeriesUrl } from '../services/urlRewrite';
import type { ChapterInfo } from '../services/chapterCache';

const DETAILS_ALLOWED_TYPES: ReadonlySet<string> = new Set(['DEBUG', 'SHOW_WEBVIEW', 'SUCCESS']);
const MAX_CHAPTERS = 10000;

// Source-discovery outcomes per primary URL for this app session, so reopening
// a comic shows its suggestions at once instead of loading every site again.
// `namesKey` records which names the round searched with: when alternate names
// arrive later, only the sites still unmatched are probed again.
interface SuggestionCacheEntry { namesKey: string; results: ProbeResult[]; finished: boolean }
const suggestionCache = new Map<string, SuggestionCacheEntry>();

import { SkeletonChapterRow } from '../components/Skeleton';

const { width, height: screenHeight } = Dimensions.get('window');

export default function DetailsScreen() {
    const { title, cover_url, manga_url } = useLocalSearchParams();
    const router = useRouter();
    const { colors } = useAppTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [scraping, setScraping] = useState(true);
    const [chapters, setChapters] = useState<any[]>([]);
    const [description, setDescription] = useState('Loading metadata natively...');
    const [genreList, setGenreList] = useState('');
    const [authorList, setAuthorList] = useState('');
    const [inLibrary, setInLibrary] = useState(false);

    // Editable per-comic fields persisted to local DB + cloud
    const [notes, setNotes] = useState('');
    const [rating, setRating] = useState('');
    // The rating box's text and validation message while the picker is open.
    const [ratingInput, setRatingInput] = useState('');
    const [ratingError, setRatingError] = useState('');
    // The primary site's own average on the 5-point scale (services/rating.ts):
    // the stored value, refreshed from each scrape; the ref feeds addToLibrary.
    const [siteRating, setSiteRating] = useState('');
    // Chapter list navigation: reading progress (for Continue), a number
    // filter and the list order.
    const [readChapter, setReadChapter] = useState('');
    const [chapterFilter, setChapterFilter] = useState('');
    const [oldestFirst, setOldestFirst] = useState(false);
    const siteRatingRef = useRef('');
    const [status, setStatus] = useState('');
    const [savingMeta, setSavingMeta] = useState(false);
    const [statusModalOpen, setStatusModalOpen] = useState(false);
    const [ratingModalOpen, setRatingModalOpen] = useState(false);

    // Linked-source state (M1: manual paste-URL flow).
    const [linkedSources, setLinkedSources] = useState<LinkedSource[]>([]);
    const [allConfigs, setAllConfigs] = useState<any[]>([]);
    const [addSourceModalOpen, setAddSourceModalOpen] = useState(false);
    const [addSourceInput, setAddSourceInput] = useState('');
    const [addSourceError, setAddSourceError] = useState('');
    const [addSourceBusy, setAddSourceBusy] = useState(false);
    // M3: auto-suggested sources discovered by probing other configured sites.
    const [suggestedSources, setSuggestedSources] = useState<ProbeResult[]>([]);
    const [probing, setProbing] = useState(false);
    const [probeProgress, setProbeProgress] = useState({ done: 0, total: 0 });
    // A round finished and there is nothing to show → "No other sources found".
    const [probeFoundNone, setProbeFoundNone] = useState(false);
    // Guards source-probing so it runs once per comic and name set per mount
    // (whether the comic was just added or opened from the library).
    const probedUrlRef = useRef<string | null>(null);
    const probedNamesRef = useRef('');
    // Alternate names (manga.alternative_names, see services/altNames.ts): the
    // stored text, mirrored in a ref for the scrape handler, plus what this
    // load's scrape read so addToLibrary can store it.
    const [altNames, setAltNames] = useState('');
    const altNamesRef = useRef('');
    const scrapedAltRef = useRef('');
    // M2b: linked-source chapter lists merged into the primary list. The primary
    // rows render as soon as they arrive; each linked source is scraped by the
    // root-mounted HiddenChapterListWebView and merged in when it resolves.
    const [mergingCount, setMergingCount] = useState(0);
    const primaryChaptersRef = useRef<any[] | null>(null);
    const linkedListsRef = useRef<Map<string, ChapterInfo[]>>(new Map());
    const linkedInFlightRef = useRef<Set<string>>(new Set());
    // Linked sources whose list could not be read this load (a site with no
    // chapters for the comic, a timeout): finished, with nothing to merge.
    const linkedFailedRef = useRef<Set<string>>(new Set());
    const linkedSourcesRef = useRef<LinkedSource[]>([]);
    // Bumped on every reset so results from a previous load/refresh are ignored.
    const mergeGenRef = useRef(0);
    // Latest wrong-series verdict per linked source URL, for the chip alert.
    const [mismatchInfo, setMismatchInfo] = useState<Record<string, MismatchVerdict>>({});
    // Verdicts from this load (null = passed), read synchronously by the merge
    // so a source never flashes in before its stored status catches up.
    const verdictsRef = useRef<Map<string, MismatchVerdict | null>>(new Map());

    const STATUS_OPTIONS = ['Plan to Read', 'Reading', 'Completed', 'On Hold', 'Dropped'];
    const [config, setConfig] = useState<any>(null);
    const [debugLogs, setDebugLogs] = useState<string[]>([]);
    const [showWebView, setShowWebView] = useState(false);
    const [webViewUrl, setWebViewUrl] = useState(manga_url as string);

    // Pull-to-refresh state
    const [refreshing, setRefreshing] = useState(false);
    const [reloadKey, setReloadKey] = useState(0); // bumps to force WebView remount

    const handleRefresh = () => {
        setRefreshing(true);
        resetMerge();
        setChapters([]);
        setDescription('Loading metadata natively...');
        setScraping(true);
        setShowWebView(false);
        setReloadKey(k => k + 1);
        // refreshing is reset when scraping flips back to false (in handleMessage SUCCESS)
    };

    // Downloads state — set of chapter URLs that are downloaded; refreshes after each op.
    const [downloadedSet, setDownloadedSet] = useState<Set<string>>(new Set());
    // Live snapshots of both global queues
    const [queueSnapshot, setQueueSnapshot] = useState(getDownloadQueue());
    const [scrapeQueueUrls, setScrapeQueueUrls] = useState<Set<string>>(getScrapeQueuedUrls());
    useEffect(() => subscribeDownloads(() => {
        setQueueSnapshot(getDownloadQueue());
        // When a download finishes, refresh the local "downloaded" set so checkmarks appear
        refreshDownloadedSet();
    }), []);
    useEffect(() => subscribeScrape(() => setScrapeQueueUrls(getScrapeQueuedUrls())), []);

    // Asura re-keys series URLs and redirects the old ones. When this page landed
    // on the re-keyed address of the same series, rewrite the saved link once and
    // point the screen at it; skipResetForUrlRef keeps the load effect below from
    // treating that as a new comic.
    const rewrittenFromRef = useRef<string | null>(null);
    const skipResetForUrlRef = useRef<string | null>(null);
    const maybeRewriteStaleUrl = async (finalUrl: string) => {
        const current = typeof manga_url === 'string' ? manga_url : Array.isArray(manga_url) ? manga_url[0] : '';
        if (!current || rewrittenFromRef.current === current || !isAsuraSeriesRekey(current, finalUrl)) return;
        rewrittenFromRef.current = current;
        try {
            const db = await initDatabase();
            const res = await rewriteSeriesUrl(db, current, finalUrl);
            if (!res.primaryTitle) return; // not a library comic: nothing saved to update
            const target = canonicalSeriesUrl(finalUrl);
            addLog(`Saved link updated: ${current} → ${target}`);
            skipResetForUrlRef.current = target;
            probedUrlRef.current = target;
            router.setParams({ manga_url: target });
        } catch (e: any) {
            console.warn('[URL REWRITE]: details rewrite failed:', e?.message || e);
        }
    };

    useEffect(() => {
        if (skipResetForUrlRef.current && skipResetForUrlRef.current === manga_url) {
            // Same comic under its rewritten URL: keep the loaded chapters,
            // just re-read the rows that are keyed by URL.
            skipResetForUrlRef.current = null;
            checkLibraryState();
            refreshDownloadedSet();
            return;
        }
        // CLEAN SLATE: Reset everything when switching comics!
        resetMerge();
        setChapters([]);
        setDescription('Loading metadata natively...');
        setScraping(true);
        setDebugLogs([]);
        setShowWebView(false);
        setWebViewUrl(manga_url as string);

        checkLibraryState();
        fetchConfigs();
        refreshDownloadedSet();
        showSavedChapters(manga_url as string);
        // Warn loudly if a deep link tried to deliver an unsafe URL — the WebView
        // below will then refuse to mount and the user sees the metadata only.
        if (manga_url && !isSafeMangaUrl(manga_url as string)) {
            console.warn(`[URL SAFETY] details.tsx refused to load unsafe manga_url: ${String(manga_url).substring(0, 120)}`);
        }
    }, [manga_url]);

    // Until the page has loaded (or when it cannot, offline): the list this
    // screen saved last time, else at least the downloaded chapters.
    const savedGenRef = useRef(0);
    const showSavedChapters = async (url: string) => {
        const gen = ++savedGenRef.current;
        if (!url) return;
        try {
            const db = await initDatabase();
            let saved: ChapterInfo[] = (await getSavedChapterList(db, url)).filter(c => isSafeMangaUrl(c.link));
            if (saved.length === 0) {
                const num = (t: string) => { const m = t.match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : -1; };
                saved = (await getDownloadedChaptersForManga(db, url))
                    .filter(d => isSafeMangaUrl(d.chapter_url))
                    .map(d => ({ title: d.chapter_title, link: d.chapter_url }))
                    .sort((a, b) => num(b.title) - num(a.title));
            }
            if (gen !== savedGenRef.current || saved.length === 0) return;
            setChapters(prev => (prev.length === 0 ? saved : prev));
        } catch (e) {
            console.warn('showSavedChapters failed', e);
        }
    };

    // Save what a finished load shows, for the next open of a library comic.
    useEffect(() => {
        const url = typeof manga_url === 'string' ? manga_url : '';
        if (scraping || !inLibrary || !url || chapters.length === 0 || mergingCount > 0) return;
        (async () => {
            try {
                const db = await initDatabase();
                await saveChapterList(db, url, chapters);
            } catch (e) {
                console.warn('saveChapterList failed', e);
            }
        })();
    }, [chapters, scraping, inLibrary, mergingCount]);

    const refreshDownloadedSet = async () => {
        try {
            const set = await getDownloadedChapterUrls(manga_url as string);
            setDownloadedSet(set);
        } catch (e) {
            console.warn('refreshDownloadedSet failed', e);
        }
    };

    const fetchConfigs = async () => {
        const db = await initDatabase();
        const configs = await getLocalConfigs(db);
        setAllConfigs(configs);
        const matched = matchConfigToUrl(configs, manga_url as string);
        if (matched) {
            setConfig(matched.json_rules);
            addLog(`Matched config: ${matched.website_name}`);
        } else {
            addLog(`No config matched. Falling back.`);
            setConfig(configs[0]?.json_rules);
        }
    };

    const addLog = (msg: string) => {
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] [SCRAPER DEBUG Details]:`, msg);
        setDebugLogs(prev => [...prev.slice(-8), `[${time}] ${msg}`]);
    };

    const checkLibraryState = async () => {
        try {
            const db = await initDatabase();
            const collection: any[] = await getLocalLibrary(db);
            const found = collection.find(m => m.manga_url === manga_url);
            setInLibrary(!!found);
            if (found) {
                setNotes(found.notes || '');
                setStatus(found.status || '');
                setLinkedSources(parseLinkedSources(found.linked_sources));
                altNamesRef.current = found.alternative_names || '';
                setAltNames(altNamesRef.current);
                setRating(found.rating || '');
                setReadChapter(found.chapter || '');
                if (found.description) setDescription(d => (d === 'Loading metadata natively...' ? found.description : d));
                // A rating read by this load's scrape beats the stored one.
                setSiteRating(siteRatingRef.current || found.site_rating || '');
            } else {
                setNotes('');
                setRating('');
                setSiteRating(siteRatingRef.current);
                setStatus('');
                setLinkedSources([]);
                altNamesRef.current = '';
                setAltNames('');
            }
        } catch (e) {
            console.error(e);
        }
    };

    // Updates a single column in the local manga row + pushes to cloud.
    const persistField = async (column: 'notes' | 'rating' | 'status', value: string) => {
        const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
        if (!titleStr || !inLibrary) return;
        setSavingMeta(true);
        try {
            const db = await initDatabase();
            // SQL injection guard. The TS type narrows this to a literal union at
            // compile time but TS doesn't enforce it at runtime, so we re-validate.
            assertMangaColumns([column]);
            await db.runAsync(`UPDATE manga SET ${column} = ? WHERE title = ?`, [value, titleStr]);
            // Push to cloud — re-use pushAddToCloud which upserts the whole row
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user) {
                const row = await db.getFirstAsync<any>('SELECT * FROM manga WHERE title = ?', [titleStr]);
                if (row) {
                    await pushAddToCloud(session.user.id, {
                        title: row.title,
                        manga_url: row.manga_url,
                        cover_url: row.cover_url,
                        chapter: row.chapter,
                        latest_chapter: row.latest_chapter,
                        category: row.category,
                    });
                    // pushAddToCloud is upsert — but doesn't include notes/rating/status in its payload.
                    // Push those explicitly via a separate update call.
                    const today = new Date().toISOString().split('T')[0];
                    await supabase.from('manga_library').upsert({
                        user_id: session.user.id,
                        title: titleStr,
                        notes: row.notes || '',
                        rating: row.rating || '',
                        status: row.status || '',
                        last_read_date: row.last_read_date || today,
                    }, { onConflict: 'user_id,title' });
                }
            }
        } catch (e: any) {
            console.error(`[META]: save ${column} failed`, e.message || e);
        } finally {
            setSavingMeta(false);
        }
    };

    // Rating box: empty clears the rating; otherwise any number from 0.1 to 5
    // with one decimal (services/rating.ts formatUserRating).
    const saveRating = async () => {
        if (ratingInput.trim() === '') {
            setRating('');
            setRatingModalOpen(false);
            await persistField('rating', '');
            return;
        }
        const value = formatUserRating(ratingInput);
        if (value === null) {
            setRatingError(`Enter a number from 0.1 to ${RATING_MAX}, like 4.8`);
            return;
        }
        setRating(value);
        setRatingModalOpen(false);
        await persistField('rating', value);
    };

    // Push the linked_sources column for this comic to the cloud as a partial
    // update. Called after every local mutation so cloud stays in sync without
    // the user having to wait for a full bulk re-push.
    const syncLinkedSourcesToCloud = async (titleStr: string, sources: LinkedSource[]) => {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session?.user) return;
            const { error } = await supabase.from('manga_library')
                .update({ linked_sources: sources })
                .match({ user_id: session.user.id, title: titleStr });
            if (error) console.warn('[LINKED]: cloud sync failed:', error.message);
        } catch (e: any) {
            console.warn('[LINKED]: cloud sync exception:', e.message || e);
        }
    };

    const handleAddLinkedSource = async () => {
        const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
        const primaryUrl = typeof manga_url === 'string' ? manga_url : Array.isArray(manga_url) ? manga_url[0] : '';
        if (!titleStr || !primaryUrl) return;

        const candidate = addSourceInput.trim();
        setAddSourceError('');

        if (!isSafeMangaUrl(candidate)) {
            setAddSourceError('That URL doesn\'t look right. Paste a full https:// link from the comic page on another site.');
            return;
        }
        if (candidate === primaryUrl) {
            setAddSourceError('That\'s the same URL the comic is already linked from.');
            return;
        }
        if (linkedSources.some(s => s.manga_url === candidate)) {
            setAddSourceError('That source is already linked.');
            return;
        }
        const matched = matchConfigToUrlStrict(allConfigs, candidate);
        if (!matched || !matched.website_name) {
            setAddSourceError('We don\'t have a scraper for that site yet.');
            return;
        }

        setAddSourceBusy(true);
        try {
            const db = await initDatabase();
            const newSource: LinkedSource = {
                website_name: matched.website_name,
                manga_url: candidate,
                added_at: new Date().toISOString(),
            };
            const updated = await addLinkedSource(db, primaryUrl, newSource);
            setLinkedSources(updated);
            setAddSourceInput('');
            setAddSourceModalOpen(false);
            await syncLinkedSourcesToCloud(titleStr, updated);
        } catch (e: any) {
            setAddSourceError(e.message || 'Failed to link source.');
        } finally {
            setAddSourceBusy(false);
        }
    };

    const handleRemoveLinkedSource = async (sourceUrl: string) => {
        const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
        const primaryUrl = typeof manga_url === 'string' ? manga_url : Array.isArray(manga_url) ? manga_url[0] : '';
        if (!titleStr || !primaryUrl) return;
        try {
            const db = await initDatabase();
            const removed = linkedSourcesRef.current.find(x => x.manga_url === sourceUrl);
            const updated = await removeLinkedSource(db, primaryUrl, sourceUrl);
            setLinkedSources(updated);
            await syncLinkedSourcesToCloud(titleStr, updated);
            if (removed) await resetLatestAfterSourceLeft(titleStr, removed);
        } catch (e: any) {
            console.warn('[LINKED]: remove failed:', e.message || e);
        }
    };

    // Store the merged alternate names (local + cloud). Updating `altNames`
    // re-runs source discovery with the new names on the sites still unmatched.
    const persistAltNames = async (titleStr: string, merged: string) => {
        altNamesRef.current = merged;
        setAltNames(merged);
        try {
            const db = await initDatabase();
            await db.runAsync('UPDATE manga SET alternative_names = ? WHERE title = ?', [merged, titleStr]);
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user) {
                await supabase.from('manga_library').upsert(
                    { user_id: session.user.id, title: titleStr, alternative_names: merged },
                    { onConflict: 'user_id,title' },
                );
            }
        } catch (e: any) {
            console.warn('[ALT NAMES]: save failed:', e.message || e);
        }
    };

    // A muted or removed source may be the one that pushed latest_chapter ahead
    // (its numbering ran past the primary's). Put latest_chapter back to the
    // primary's newest chapter when the stored value came from this source or
    // is ahead of the primary; the downgrade guard is bypassed on purpose. Any
    // other counting source that is genuinely ahead restores it on the next check.
    const resetLatestAfterSourceLeft = async (titleStr: string, s: LinkedSource) => {
        const primary = primaryChaptersRef.current;
        const primaryLatest = primary && primary.length > 0 ? clampString(primary[0].title).trim() : '';
        if (!primaryLatest) { addLog('Latest chapter left as is: primary list not loaded yet'); return; }
        try {
            const db = await initDatabase();
            const row = await db.getFirstAsync<{ latest_chapter: string; latest_source: string }>(
                'SELECT latest_chapter, latest_source FROM manga WHERE title = ?', [titleStr]
            );
            if (!row) return;
            const fromThisSource = (row.latest_source || '') === s.website_name;
            const ahead = isChapterDowngrade(row.latest_chapter, primaryLatest);
            if (!fromThisSource && !ahead) return;
            if (row.latest_chapter === primaryLatest && !row.latest_source) return;
            await db.runAsync('UPDATE manga SET latest_chapter = ?, latest_source = ? WHERE title = ?', [primaryLatest, '', titleStr]);
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user) {
                await supabase.from('manga_library').upsert(
                    { user_id: session.user.id, title: titleStr, latest_chapter: primaryLatest },
                    { onConflict: 'user_id,title' },
                );
            }
            addLog(`Latest chapter reset to ${primaryWebsiteName}'s "${primaryLatest}"`);
        } catch (e: any) {
            console.warn('[LINKED]: latest reset failed:', e.message || e);
        }
    };

    // Mute / unmute a linked source for update checks (local + cloud).
    const updateMuteStatus = async (s: LinkedSource, status: 'muted' | undefined) => {
        const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
        const primaryUrl = typeof manga_url === 'string' ? manga_url : Array.isArray(manga_url) ? manga_url[0] : '';
        if (!titleStr || !primaryUrl) return;
        try {
            const db = await initDatabase();
            const updated = await setLinkedSourceUpdates(db, primaryUrl, s.manga_url, status);
            linkedSourcesRef.current = updated;
            setLinkedSources(updated);
            await syncLinkedSourcesToCloud(titleStr, updated);
            addLog(`${status === 'muted' ? 'Muted' : 'Unmuted'} update checks for "${s.website_name}"`);
            if (status === 'muted') await resetLatestAfterSourceLeft(titleStr, s);
        } catch (e: any) {
            console.warn('[LINKED]: mute update failed:', e.message || e);
        }
    };

    // Chip "…" menu: mute/unmute update checks, or remove. Set as primary stays
    // on the name tap. Three buttons at most — Android's Alert shows no more.
    const handleLinkedSourceMenu = (s: LinkedSource) => {
        const muted = s.updates === 'muted';
        Alert.alert(
            s.website_name,
            muted
                ? 'Update checks are muted for this source: it never sets the latest chapter or sends new-chapter alerts. Its chapters still show in the list.'
                : 'Mute update checks when this source\'s chapter numbers don\'t line up with the primary. It then never sets the latest chapter or sends new-chapter alerts; its chapters still show in the list.',
            [
                { text: 'Cancel', style: 'cancel' },
                { text: muted ? 'Unmute updates' : 'Mute updates', onPress: () => updateMuteStatus(s, muted ? undefined : 'muted') },
                { text: 'Remove', style: 'destructive', onPress: () => handleRemoveLinkedSource(s.manga_url) },
            ],
        );
    };

    const primaryWebsiteName = useMemo(() => {
        const m = matchConfigToUrlStrict(allConfigs, manga_url as string);
        return m?.website_name || 'Source';
    }, [allConfigs, manga_url]);

    /* ───── M2b: linked-source chapter merge ──────────────────────────────── */

    // Forget everything collected for the current comic/load. In-flight scrapes
    // keep running in the hidden WebView but their results are ignored.
    const resetMerge = () => {
        mergeGenRef.current += 1;
        primaryChaptersRef.current = null;
        linkedListsRef.current = new Map();
        linkedInFlightRef.current = new Set();
        linkedFailedRef.current = new Set();
        verdictsRef.current = new Map();
        setMergingCount(0);
    };

    // Kept by the user → always used. Checked this load → used if it passed.
    // Not checked yet → trust the stored status.
    const feedsMerge = (s: LinkedSource) => {
        if (s.mismatch === 'kept') return true;
        if (verdictsRef.current.has(s.manga_url)) return !verdictsRef.current.get(s.manga_url);
        return isUsableLinkedSource(s);
    };

    // Rebuild the displayed list from the primary rows plus every linked list
    // collected so far, in linked_sources order (first linked source wins a
    // chapter the primary lacks; later ones become alternates).
    const recomputeMerge = (sources: LinkedSource[]) => {
        const primary = primaryChaptersRef.current;
        if (!primary) return;
        const lists = sources
            .filter(s => feedsMerge(s) && linkedListsRef.current.has(s.manga_url))
            .map(s => ({ website_name: s.website_name, chapters: linkedListsRef.current.get(s.manga_url) || [] }));
        setChapters(lists.length > 0 ? mergeChapterLists(primary, primaryWebsiteName, lists) : primary);
    };

    // Enqueue a chapter-list scrape for every linked source we haven't collected
    // yet. Each result merges in independently as it arrives.
    const scrapeLinkedSources = (sources: LinkedSource[]) => {
        const gen = mergeGenRef.current;
        for (const s of sources) {
            if (linkedListsRef.current.has(s.manga_url) || linkedInFlightRef.current.has(s.manga_url)) continue;
            if (!isSafeMangaUrl(s.manga_url)) continue;
            const cfg = matchConfigToUrlStrict(allConfigs, s.manga_url);
            if (!cfg) {
                addLog(`No scraper config for linked source "${s.website_name}" — skipped`);
                continue;
            }
            linkedInFlightRef.current.add(s.manga_url);
            setMergingCount(n => n + 1);
            enqueueChapterListScrape({ url: s.manga_url, websiteName: s.website_name, config: cfg.json_rules })
                .then(list => {
                    if (mergeGenRef.current !== gen) return;
                    linkedListsRef.current.set(s.manga_url, list);
                    // Status may have changed while this scrape was queued.
                    const cur = linkedSourcesRef.current.find(x => x.manga_url === s.manga_url) || s;
                    const verdict = checkSourceMismatch(primaryChaptersRef.current, list);
                    if (verdict && cur.mismatch !== 'kept') {
                        addLog(`Linked source "${s.website_name}" held back: ${describeMismatch(verdict, s.website_name, primaryWebsiteName)}`);
                    } else {
                        addLog(`Merged ${list.length} chapters from "${s.website_name}"`);
                    }
                    applyMismatchVerdict(cur, verdict);
                    recomputeMerge(linkedSourcesRef.current);
                })
                .catch(err => {
                    if (mergeGenRef.current !== gen) return;
                    linkedFailedRef.current.add(s.manga_url);
                    addLog(`Linked source "${s.website_name}" failed: ${String(err)}`);
                })
                .finally(() => {
                    if (mergeGenRef.current !== gen) return;
                    linkedInFlightRef.current.delete(s.manga_url);
                    setMergingCount(n => Math.max(0, n - 1));
                });
        }
    };

    // Store a new wrong-series status for one linked source (local + cloud).
    // 'kept' is the user's decision and is never overridden by the check.
    const updateMismatchStatus = async (sourceUrl: string, status: 'suspect' | 'kept' | undefined) => {
        const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
        const primaryUrl = typeof manga_url === 'string' ? manga_url : Array.isArray(manga_url) ? manga_url[0] : '';
        if (!titleStr || !primaryUrl) return;
        try {
            const db = await initDatabase();
            const before = linkedSourcesRef.current;
            const updated = await setLinkedSourceMismatch(db, primaryUrl, sourceUrl, status);
            if (updated === before || JSON.stringify(updated) === JSON.stringify(before)) return;
            linkedSourcesRef.current = updated;
            setLinkedSources(updated);
            await syncLinkedSourcesToCloud(titleStr, updated);
        } catch (e: any) {
            console.warn('[LINKED]: mismatch status update failed:', e.message || e);
        }
    };

    const applyMismatchVerdict = (s: LinkedSource, verdict: MismatchVerdict | null) => {
        verdictsRef.current.set(s.manga_url, verdict);
        setMismatchInfo(prev => {
            const next = { ...prev };
            if (verdict) next[s.manga_url] = verdict; else delete next[s.manga_url];
            return next;
        });
        if (s.mismatch === 'kept') return;
        if (verdict && s.mismatch !== 'suspect') updateMismatchStatus(s.manga_url, 'suspect');
        else if (!verdict && s.mismatch === 'suspect') updateMismatchStatus(s.manga_url, undefined);
    };

    // Tapping a flagged chip: explain, then Remove / Keep anyway.
    const handleSuspectSourceTap = (s: LinkedSource) => {
        const v = mismatchInfo[s.manga_url];
        const why = v
            ? describeMismatch(v, s.website_name, primaryWebsiteName)
            : `"${s.website_name}" didn't match ${primaryWebsiteName}'s chapter numbers last time it was checked. It is probably a different series, so its chapters are hidden.`;
        Alert.alert('Probably a different series', why, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Keep anyway', onPress: () => { addLog(`Keeping "${s.website_name}" despite the mismatch`); updateMismatchStatus(s.manga_url, 'kept'); } },
            { text: 'Remove', style: 'destructive', onPress: () => handleRemoveLinkedSource(s.manga_url) },
        ]);
    };

    // Linking/unlinking a source while the chapter list is already on screen:
    // re-merge without removed sources and scrape newly linked ones.
    useEffect(() => {
        linkedSourcesRef.current = linkedSources;
        if (!primaryChaptersRef.current) return;
        recomputeMerge(linkedSources);
        scrapeLinkedSources(linkedSources);
    }, [linkedSources]);

    // Promote a linked source to primary (M2 v1). Swaps manga_url with the chosen
    // source, demotes the old primary into linked_sources, syncs both to cloud,
    // then reloads the screen on the new primary so chapters re-scrape from it.
    // Existing downloads stay keyed to the old URL — accepted for v1.
    const handleSetPrimary = (source: LinkedSource) => {
        const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
        const oldPrimaryUrl = typeof manga_url === 'string' ? manga_url : Array.isArray(manga_url) ? manga_url[0] : '';
        const coverStr = typeof cover_url === 'string' ? cover_url : Array.isArray(cover_url) ? cover_url[0] : '';
        addLog(`Set-primary tapped: "${source.website_name}"`);
        if (!titleStr || !oldPrimaryUrl) { addLog('Set-primary aborted: missing title or current URL'); return; }
        if (!isSafeMangaUrl(source.manga_url) || source.manga_url === oldPrimaryUrl) {
            addLog(`Set-primary aborted: unsafe or same URL (${source.manga_url.substring(0, 100)})`);
            return;
        }
        const oldName = primaryWebsiteName;

        Alert.alert(
            'Set as primary source?',
            `"${source.website_name}" will become the primary source. The current primary ("${oldName}") will be kept as a linked source.\n\nChapters reload from the new source. Existing downloads stay tied to the old source.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Set as primary',
                    onPress: async () => {
                        const newLinked: LinkedSource[] = [
                            ...linkedSources.filter(s => s.manga_url !== source.manga_url),
                            { website_name: oldName, manga_url: oldPrimaryUrl, added_at: new Date().toISOString() },
                        ];
                        try {
                            const db = await initDatabase();
                            await db.runAsync(
                                'UPDATE manga SET manga_url = ?, linked_sources = ? WHERE manga_url = ?',
                                [source.manga_url, serializeLinkedSources(newLinked), oldPrimaryUrl],
                            );
                            const { data: { session } } = await supabase.auth.getSession();
                            if (session?.user) {
                                const { error } = await supabase.from('manga_library')
                                    .update({ manga_url: source.manga_url, linked_sources: newLinked })
                                    .match({ user_id: session.user.id, title: titleStr });
                                if (error) console.warn('[PRIMARY]: cloud sync failed:', error.message);
                            }
                        } catch (e: any) {
                            console.warn('[PRIMARY]: set-primary failed:', e.message || e);
                            return;
                        }
                        // Reload the details screen pointed at the new primary so the
                        // load effect re-scrapes and re-reads linked_sources.
                        addLog(`Primary is now "${source.website_name}" — reloading`);
                        router.replace({
                            pathname: '/details',
                            params: { title: titleStr, cover_url: coverStr, manga_url: source.manga_url },
                        });
                    },
                },
            ],
        );
    };

    // M3/M4: probe the user's other configured sites for this same comic and
    // surface matches as suggested linkable sources. Sites with a search page
    // are searched by every name we know (title, then alternates); the rest
    // get a guessed detail URL (sourceDiscovery). The primary, linked sources
    // and sites already matched this session are skipped; each match is
    // confirmed by the user.
    const runSourceProbes = (titleStr: string, primaryUrl: string, altRaw: string, alreadyFound: ProbeResult[]) => {
        if (!titleStr || !primaryUrl || allConfigs.length === 0) return;
        const names = namesForMatching(titleStr, altRaw);
        const namesKey = names.join('\u0001');
        const primaryHost = extractHost(primaryUrl);
        const skipHosts = new Set([
            ...linkedSources.map(s => extractHost(s.manga_url)),
            ...alreadyFound.map(r => extractHost(r.matchedUrl)),
        ].filter(Boolean) as string[]);
        const jobs: { cfg: any; spec: ProbeSpec }[] = [];
        for (const cfg of allConfigs) {
            const host = getConfigHost(cfg);
            if (!host || host === primaryHost || skipHosts.has(host)) continue;
            const base = { websiteName: cfg.website_name, comicTitle: titleStr, names, host };
            if (isSearchable(cfg)) {
                const urls = buildSearchUrls(cfg, names);
                if (urls.length > 0) jobs.push({ cfg, spec: { ...base, kind: 'search', candidateUrls: urls, searchRules: getSearchRules(cfg) } });
            } else if (isDiscoverable(cfg)) {
                const urls = buildCandidateUrls(cfg, titleStr);
                const d = cfg.json_rules?.selectors?.details;
                const detailMeta = d?.meta_container || d?.alt_names
                    ? {
                        container: String(d.meta_container || ''),
                        key: String(d.meta_key || 'self'),
                        val: String(d.meta_val || 'self'),
                        ...(d.alt_names ? { alt: String(d.alt_names) } : {}),
                    }
                    : null;
                if (urls.length > 0) jobs.push({ cfg, spec: { ...base, kind: 'page', candidateUrls: urls, detailMeta } });
            }
        }
        const entry: SuggestionCacheEntry = suggestionCache.get(primaryUrl) ?? { namesKey, results: [], finished: false };
        entry.namesKey = namesKey;
        suggestionCache.set(primaryUrl, entry);
        if (jobs.length === 0) {
            entry.finished = true;
            setProbeFoundNone(entry.results.length === 0 && alreadyFound.length === 0 && linkedSources.length === 0);
            return;
        }

        addLog(`Searching ${jobs.length} other site(s) for: ${names.join(' / ')}`);
        setProbeFoundNone(false);
        setProbeProgress({ done: 0, total: jobs.length });
        setProbing(true);
        let outstanding = jobs.length;
        const done = () => {
            outstanding -= 1;
            setProbeProgress(p => ({ ...p, done: p.done + 1 }));
            if (outstanding <= 0) {
                entry.finished = true;
                setProbing(false);
                setProbeFoundNone(entry.results.length === 0);
            }
        };

        for (const { cfg, spec } of jobs) {
            enqueueProbe(spec)
                .then(async result => {
                    if (!result) return;
                    // Title matched; also check the chapter numbers fit before
                    // suggesting it. Skipped while the primary list isn't loaded
                    // yet, and a failed check doesn't hide the suggestion: once
                    // linked, the same check runs on every load.
                    if (primaryChaptersRef.current) {
                        try {
                            const list = await enqueueChapterListScrape({ url: result.matchedUrl, websiteName: cfg.website_name, config: cfg.json_rules });
                            const verdict = checkSourceMismatch(primaryChaptersRef.current, list);
                            if (verdict) {
                                addLog(`Suggestion hidden: ${describeMismatch(verdict, cfg.website_name, primaryWebsiteName)}`);
                                return;
                            }
                        } catch (e) {
                            addLog(`Suggestion check for "${cfg.website_name}" failed; showing it anyway`);
                        }
                    }
                    const host = extractHost(result.matchedUrl);
                    if (!entry.results.some(p => extractHost(p.matchedUrl) === host)) entry.results.push(result);
                    setSuggestedSources(prev => {
                        if (prev.some(p => extractHost(p.matchedUrl) === host)) return prev;
                        return [...prev, result];
                    });
                })
                .catch(() => {})
                .finally(done);
        }
    };

    // Link a suggested source — reuses the same write/sync path as a manual add.
    const handleLinkSuggestion = async (result: ProbeResult) => {
        const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
        const primaryUrl = typeof manga_url === 'string' ? manga_url : Array.isArray(manga_url) ? manga_url[0] : '';
        if (!titleStr || !primaryUrl || !isSafeMangaUrl(result.matchedUrl)) return;
        try {
            const db = await initDatabase();
            const newSource: LinkedSource = {
                website_name: result.websiteName,
                manga_url: result.matchedUrl,
                added_at: new Date().toISOString(),
            };
            const updated = await addLinkedSource(db, primaryUrl, newSource);
            setLinkedSources(updated);
            setSuggestedSources(prev => prev.filter(p => p.matchedUrl !== result.matchedUrl));
            await syncLinkedSourcesToCloud(titleStr, updated);
            // The other site's names for this comic make the next site easier to find.
            const merged = mergeAltNames(altNamesRef.current, result.altNames || [], titleStr);
            if (merged !== altNamesRef.current) await persistAltNames(titleStr, merged);
        } catch (e: any) {
            console.warn('[LINKED]: link suggestion failed:', e.message || e);
        }
    };

    const handleDismissSuggestion = (matchedUrl: string) => {
        setSuggestedSources(prev => prev.filter(p => p.matchedUrl !== matchedUrl));
    };

    // Suggestions to actually render: drop any that became the primary or got
    // linked (guards against stale closures), and dedupe by host.
    const visibleSuggestions = useMemo(() => {
        const primaryHost = extractHost(manga_url as string);
        const linkedHosts = new Set(
            linkedSources.map(s => extractHost(s.manga_url)).filter(Boolean) as string[],
        );
        const seen = new Set<string>();
        return suggestedSources.filter(sug => {
            const host = extractHost(sug.matchedUrl);
            if (!host || host === primaryHost || linkedHosts.has(host) || seen.has(host)) return false;
            seen.add(host);
            return true;
        });
    }, [suggestedSources, linkedSources, manga_url]);

    // Kick off source-probing once per comic and name set, whether it was just
    // added or opened from the library. Waits until the comic is in the library
    // and the scraper configs have loaded (so getConfigHost etc. resolve). A
    // round already running finishes first; when alternate names arrived in the
    // meantime, the sites still unmatched get another round with them. Cached
    // results from earlier this session show immediately.
    useEffect(() => {
        if (!inLibrary || allConfigs.length === 0 || probing) return;
        const urlStr = typeof manga_url === 'string' ? manga_url : Array.isArray(manga_url) ? manga_url[0] : '';
        const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
        if (!urlStr || !titleStr) return;
        const namesKey = namesForMatching(titleStr, altNames).join('\u0001');
        if (probedUrlRef.current === urlStr && probedNamesRef.current === namesKey) return;
        probedUrlRef.current = urlStr;
        probedNamesRef.current = namesKey;
        const cached = suggestionCache.get(urlStr);
        if (cached) setSuggestedSources(cached.results);
        if (cached && cached.finished && cached.namesKey === namesKey) {
            setProbeFoundNone(cached.results.length === 0);
            return;
        }
        runSourceProbes(titleStr, urlStr, altNames, cached?.results ?? []);
    }, [inLibrary, allConfigs, manga_url, title, altNames, probing]);

    // "+ Add to Library": the same series already in the library from another
    // site (services/libraryMatch.ts) is offered a link instead of a second entry.
    const addToLibrary = async () => {
        const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
        const urlStr = typeof manga_url === 'string' ? manga_url : Array.isArray(manga_url) ? manga_url[0] : '';
        if (!titleStr) {
            console.error("[ADD ERROR]: Missing title — aborting");
            return;
        }
        let existing: any = null;
        try {
            const db = await initDatabase();
            existing = findSameSeries((await getLocalLibrary(db)) as any[], titleStr, urlStr);
        } catch (e) { /* no match check: add as before */ }
        if (!existing) {
            await insertIntoLibrary();
            return;
        }
        const from = matchConfigToUrlStrict(allConfigs, existing.manga_url)?.website_name || extractHost(existing.manga_url || '');
        const here = matchConfigToUrlStrict(allConfigs, urlStr)?.website_name || extractHost(urlStr);
        Alert.alert(
            'Already in your library',
            `"${existing.title}" is in your library from ${from}. Link ${here} as another source of it, or add this as a separate comic?`,
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Add separately', onPress: () => { insertIntoLibrary(); } },
                {
                    text: 'Link as source',
                    onPress: async () => {
                        try {
                            const db = await initDatabase();
                            const updated = await addLinkedSource(db, existing.manga_url, {
                                website_name: here,
                                manga_url: urlStr,
                                added_at: new Date().toISOString(),
                            });
                            await syncLinkedSourcesToCloud(existing.title, updated);
                            Alert.alert('Linked', `${here} is now another source of "${existing.title}". Open it from your library to see both.`);
                        } catch (e: any) {
                            Alert.alert('Could not link', e.message || 'Unknown error');
                        }
                    },
                },
            ],
        );
    };

    const insertIntoLibrary = async () => {
        const time = new Date().toLocaleTimeString();
        const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
        const urlStr = typeof manga_url === 'string' ? manga_url : Array.isArray(manga_url) ? manga_url[0] : '';
        const coverStr = typeof cover_url === 'string' ? cover_url : Array.isArray(cover_url) ? cover_url[0] : '';
        console.log(`[${time}] [USER CLICK]: Adding "${titleStr}" to library`);
        if (!titleStr) {
            console.error("[ADD ERROR]: Missing title — aborting");
            return;
        }
        const latestChapter = chapters.length > 0 ? chapters[0].title : 'Unknown';
        const altStr = mergeAltNames('', parseAltNames(scrapedAltRef.current), titleStr);

        // Step 1: local SQLite. INSERT OR REPLACE so re-adds don't error out on UNIQUE(title).
        try {
            const db = await initDatabase();
            await db.runAsync(`
                INSERT OR REPLACE INTO manga (title, manga_url, cover_url, chapter, latest_chapter, category, last_read_date, genre, author, description, alternative_names, site_rating)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                titleStr, urlStr, coverStr, 'Chapter 0',
                latestChapter, 'Reading',
                new Date().toISOString().split('T')[0],
                genreList, authorList, description, altStr, siteRatingRef.current,
            ]);
            altNamesRef.current = altStr;
            setAltNames(altStr);
            console.log(`[SQLITE]: Inserted "${titleStr}" into local library (genre="${genreList}", author="${authorList}")`);
            setInLibrary(true);
        } catch (e: any) {
            console.error("[SQLITE ERROR]: Local insert failed:", e.message || e);
            return;
        }

        // Step 2: cloud. Without this, the next time the Library tab refreshes from cloud,
        // bulkRestoreLocal will overwrite local data and the new entry will disappear.
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user) {
                await pushAddToCloud(session.user.id, {
                    title: titleStr,
                    manga_url: urlStr,
                    cover_url: coverStr,
                    chapter: 'Chapter 0',
                    latest_chapter: latestChapter,
                    category: 'Reading',
                });
                // Also push genre/author/description/alt names (not in pushAddToCloud's column set)
                if (genreList || authorList || description || altStr) {
                    await supabase.from('manga_library').upsert({
                        user_id: session.user.id,
                        title: titleStr,
                        genre: genreList,
                        author: authorList,
                        description,
                        alternative_names: altStr,
                    }, { onConflict: 'user_id,title' });
                }
            } else {
                console.warn("[CLOUD]: No session — skipping cloud push (will sync on next login)");
            }
        } catch (e: any) {
            console.error("[CLOUD ERROR]: Cloud push exception:", e.message || e);
        }
        // Source-probing is kicked off by the effect watching `inLibrary` —
        // setInLibrary(true) above triggers it, so adding a comic surfaces
        // suggestions the same way opening an existing one does.
    };

    const removeFromLibrary = async () => {
        const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
        if (!titleStr) return;
        Alert.alert(
            'Remove from library?',
            `"${titleStr}" will be removed from your library on this device and in the cloud. Downloaded chapters will also be deleted.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Remove', style: 'destructive', onPress: async () => {
                        try {
                            const db = await initDatabase();
                            await db.runAsync('DELETE FROM manga WHERE title = ?', [titleStr]);
                            console.log(`[SQLITE]: Removed "${titleStr}" from local library`);
                            setInLibrary(false);
                            // Cancel any in-flight or queued downloads for this comic, then delete saved files
                            const cancelled = cancelAllDownloadsForManga(manga_url as string);
                            if (cancelled > 0) console.log(`[QUEUE]: Cancelled ${cancelled} downloads for removed comic`);
                            await deleteAllMangaDownloads(manga_url as string);
                            await refreshDownloadedSet();
                        } catch (e: any) {
                            console.error('[SQLITE ERROR]: Local remove failed:', e.message || e);
                        }
                        try {
                            const { data: { session } } = await supabase.auth.getSession();
                            if (session?.user) await removeFromCloud(session.user.id, titleStr);
                        } catch (e: any) {
                            console.error('[CLOUD ERROR]: Remove push failed:', e.message || e);
                        }
                    }
                }
            ]
        );
    };

    /* ───── Per-chapter download flow ─────────────────────────────────────
       Tap download → schedule a scrape on the global scrapeManager (which runs
       in a hidden WebView at the app root) → enqueue the resulting image URLs
       to the global download queue. Both stages survive screen navigation.
    */
    const startDownload = async (chapterUrl: string, chapterTitle: string) => {
        if (!inLibrary) {
            Alert.alert('Add to library first', 'Downloads are available for comics in your library.');
            return;
        }
        if (isInQueue(chapterUrl) || downloadedSet.has(chapterUrl) || scrapeQueueUrls.has(chapterUrl)) return;
        const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
        try {
            const imageUrls = await scheduleScrape(chapterUrl);
            if (imageUrls.length === 0) {
                console.warn(`[DL]: No images extracted for "${chapterTitle}"`);
                return;
            }
            console.log(`[DL]: Got ${imageUrls.length} image URLs for "${chapterTitle}" — enqueueing`);
            enqueueDownload({
                mangaUrl: manga_url as string,
                mangaTitle: titleStr,
                chapterUrl,
                chapterTitle,
                imageUrls,
            });
        } catch (e: any) {
            console.warn(`[DL]: Scrape failed for "${chapterTitle}":`, e);
        }
    };

    const handleDeleteChapterDownload = (chapterUrl: string, chapterTitle: string) => {
        Alert.alert(
            'Delete download?',
            `"${chapterTitle}" will be removed from local storage. You can re-download anytime.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete', style: 'destructive', onPress: async () => {
                        await deleteChapterDownload(chapterUrl);
                        await refreshDownloadedSet();
                    }
                }
            ]
        );
    };

    const handleDownloadAll = () => {
        if (!inLibrary) {
            Alert.alert('Add to library first', 'Downloads are available for comics in your library.');
            return;
        }
        const remaining = chapters.filter(c =>
            !downloadedSet.has(c.link) && !isInQueue(c.link) && !scrapeQueueUrls.has(c.link)
        );
        if (remaining.length === 0) {
            Alert.alert('All downloaded', 'Every chapter is already saved or queued.');
            return;
        }
        Alert.alert(
            'Download all chapters?',
            `${remaining.length} chapter${remaining.length === 1 ? '' : 's'} will be queued. Scraping and downloading both run in the background — feel free to navigate away or close Details.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Download', onPress: () => {
                        // Fire-and-forget — scrapeManager serializes the scrapes globally,
                        // and each scrape's resolution enqueues the chapter to the download queue.
                        for (const ch of remaining) {
                            startDownload(ch.link, ch.title);
                        }
                    }
                }
            ]
        );
    };

    const handleDeleteAllMangaDownloads = () => {
        if (downloadedSet.size === 0) return;
        Alert.alert(
            'Delete all downloads for this comic?',
            `${downloadedSet.size} chapter${downloadedSet.size === 1 ? '' : 's'} will be removed from local storage.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete', style: 'destructive', onPress: async () => {
                        await deleteAllMangaDownloads(manga_url as string);
                        await refreshDownloadedSet();
                    }
                }
            ]
        );
    };

    // (Download image-extraction JS now lives in services/scrapeManager.ts)

    const INJECTED_JAVASCRIPT = config ? `
        (function() {
            let attempts = 0;
            // ~45s @ 1s tick — Asura/Arena/KingOfShojo can take 20s+ after the Cloudflare challenge clears,
            // and slow networks need more headroom before we declare failure.
            const maxAttempts = 45;
            const chRules = ${JSON.stringify((config.selectors && config.selectors.chapters) || {})};
            const detailsRules = ${JSON.stringify((config.selectors && config.selectors.details) || {})};
            const theme = ${JSON.stringify(String(config.theme || 'custom'))};
            // Locked / early-access rows (Asura) are skipped — see services/chapterLocks.ts.
            ${buildLockFilterJs(getLockedRowMarkers(config, manga_url as string))}
            var lockedSkipped = 0;
            // chapters.load_more (config): sites that page the chapter list client-side.
            var __loadMoreClicks = 0, __lastCount = -1, __stalledTicks = 0;

            // Cache the bridge ref at script start so we survive if the page's hydration
            // (e.g. Asura's Next.js) overwrites window.ReactNativeWebView later.
            var __bridge = window.ReactNativeWebView;
            var __bridgeStompedReported = false;

            function sendLog(msg) {
                var now = new Date().toLocaleTimeString();
                if (!__bridge) return;
                __bridge.postMessage(JSON.stringify({ type: 'DEBUG', message: '[' + now + '] ' + msg }));
            }

            // Surface any silent JS errors that would otherwise kill the interval — but skip
            // the cross-origin "Script error." noise (no source info, comes from third-party
            // scripts loaded by the host page, not our injected code).
            window.addEventListener('error', function(ev) {
                var m = ev.message || 'unknown';
                if (m === 'Script error.' && !ev.filename) return;
                sendLog('JS-ERROR: ' + m + ' at ' + (ev.filename || '?') + ':' + (ev.lineno || 0));
            });
            window.addEventListener('unhandledrejection', function(ev) {
                sendLog('JS-REJECT: ' + ((ev.reason && ev.reason.message) || String(ev.reason || 'unknown')));
            });

            // Page lifecycle: tells us if the page unloads / hides between ticks.
            window.addEventListener('pagehide', function() { sendLog('LIFECYCLE: pagehide'); });
            window.addEventListener('visibilitychange', function() {
                sendLog('LIFECYCLE: visibilitychange → ' + document.visibilityState);
            });

            const interval = setInterval(() => {
                attempts++;

                // Detect if the page replaced our bridge under us. We log this once and
                // continue using the cached __bridge ref.
                if (!__bridgeStompedReported && window.ReactNativeWebView !== __bridge) {
                    __bridgeStompedReported = true;
                    sendLog('BRIDGE-STOMPED: window.ReactNativeWebView was replaced after tick=' + attempts);
                }

                const html = document.documentElement.innerHTML;
                const docTitle = document.title;
                const isCloudflare = docTitle.includes('Just a moment') || html.includes('cf-challenge') || !!document.querySelector('#challenge-form');

                if (attempts === 1) {
                    // One-shot diagnostic so we know what the page actually looks like on landing.
                    const allLinks = document.querySelectorAll('a');
                    sendLog('Start: host=' + location.hostname + ' | title="' + docTitle + '" | html=' + html.length + ' | <a>=' + allLinks.length + ' | itemSel="' + (chRules.item || '') + '"');

                    // Anchor pattern dump — tells us what selector to use in Supabase for sites
                    // whose page reloads before our retry loop can find chapters (e.g. Asura).
                    var segs1 = location.pathname.split('/').filter(Boolean);
                    var slug1 = segs1.length > 0 ? segs1[segs1.length - 1] : '';
                    var stats = { slashChapter: 0, dashChapter: 0, slugMatch: 0, slugMatchWithDigit: 0 };
                    var navSample = [];
                    var slugSample = [];
                    // Regex literals with \\ — template eval preserves the single \ so the
                    // final regex literal in the WebView has \s/\d intact. (Using new RegExp()
                    // with strings would require \\\\ since both template + string literals strip.)
                    var WHITESPACE_RE = /\\s+/g;
                    var DIGIT_RE = /\\d/;
                    for (var i = 0; i < allLinks.length; i++) {
                        var h = allLinks[i].href || '';
                        var t = (allLinks[i].textContent || '').trim().replace(WHITESPACE_RE, ' ').substring(0, 24);
                        if (h.indexOf('/chapter/') !== -1) stats.slashChapter++;
                        if (h.indexOf('-chapter-') !== -1 || h.indexOf('/chapter-') !== -1) stats.dashChapter++;
                        if (slug1.length > 3 && h.indexOf(slug1) !== -1 && h !== location.href) {
                            stats.slugMatch++;
                            var afterSlug1 = h.split(slug1)[1] || '';
                            if (DIGIT_RE.test(afterSlug1)) stats.slugMatchWithDigit++;
                            if (slugSample.length < 5) {
                                slugSample.push(t + '→' + h.replace(location.origin, ''));
                            }
                        }
                        if (navSample.length < 5 && h && h !== location.href) navSample.push(t + '→' + h.replace(location.origin, ''));
                    }
                    sendLog('Anchor stats: slug="' + slug1 + '" /chapter/=' + stats.slashChapter + ' -chapter-=' + stats.dashChapter + ' slug-match=' + stats.slugMatch + ' slug+digit=' + stats.slugMatchWithDigit);
                    sendLog('Nav anchors: ' + navSample.join(' || '));
                    sendLog('Slug anchors: ' + (slugSample.length > 0 ? slugSample.join(' || ') : '(none)'));
                }

                if (isCloudflare) {
                    sendLog('Cloudflare detected. Showing controls...');
                    if (__bridge) __bridge.postMessage(JSON.stringify({ type: 'SHOW_WEBVIEW' }));
                    return;
                }

                // Heartbeat: log every tick for the first 12, then every 5 thereafter.
                // If the interval dies after the first tick, the absence of tick=2 onwards
                // tells us immediately, instead of waiting for a once-every-5 cadence.
                if (attempts <= 12 || attempts % 5 === 0) {
                    sendLog('tick=' + attempts + ' url=' + location.href + ' html=' + html.length + ' anchors=' + document.querySelectorAll('a').length);
                }

                if (attempts === 1) {
                    // Try the Madara load-more click on every site — harmless if the button
                    // doesn't exist. Was previously gated on theme==='madara', which silently
                    // failed for sites whose cloud config omits the theme field.
                    const loadMoreBtn = document.querySelector('.load-manga-chapters, #load-chapters, [onclick*="manga_get_chapters"]');
                    if (loadMoreBtn) {
                        sendLog('Madara load-more button found. Clicking...');
                        loadMoreBtn.click();
                    }
                }

                const results = [];
                let items = [];
                if (chRules.item) {
                    try {
                        items = document.querySelectorAll(chRules.item);
                    } catch (e) {
                        sendLog('Primary selector failed: ' + chRules.item + ' (' + (e && e.message ? e.message : 'unknown') + ')');
                        items = [];
                    }
                }

                // Generic chapter-link fallback: any anchor whose href contains a chapter-like
                // substring. Fires from tick=1 because some sites (Asura) reload the page
                // every ~20s, so we have to find chapters on the first tick or never.
                if (items.length === 0) {
                    items = document.querySelectorAll("a[href*='/chapter/'], a[href*='/chapter-'], a[href*='-chapter-'], .chapter-link");
                    if (items.length > 0 && attempts <= 2) {
                        sendLog('Primary selector empty; chapter-substring fallback picked up ' + items.length + ' candidates');
                    }
                }

                // Slug-derived fallback for sites where chapter URLs don't contain the word
                // "chapter" at all (e.g. arenascan.com /{slug}-{n}/). Every chapter URL on a
                // series page contains the series' own slug followed by a number.
                if (items.length === 0) {
                    const segs = location.pathname.split('/').filter(Boolean);
                    const slug = segs.length > 0 ? segs[segs.length - 1] : '';
                    if (slug.length > 3) {
                        const allAnchors = document.querySelectorAll('a');
                        const slugMatches = [];
                        // Regex literal /\\d/ — see WHITESPACE_RE note above for the escape rules.
                        var SLUG_DIGIT_RE = /\\d/;
                        for (let i = 0; i < allAnchors.length; i++) {
                            const a = allAnchors[i];
                            if (!a.href || a.href === location.href) continue;
                            if (a.href.indexOf(slug) === -1) continue;
                            const afterSlug = a.href.split(slug)[1] || '';
                            if (SLUG_DIGIT_RE.test(afterSlug)) slugMatches.push(a);
                        }
                        if (slugMatches.length > 0) {
                            items = slugMatches;
                            if (attempts <= 9) sendLog('Slug-derived fallback (slug="' + slug + '") picked up ' + items.length + ' candidates');
                        }
                    }
                }

                if (attempts === 1) {
                    sendLog('Post-fallback items count: ' + items.length);
                }

                // Config-driven "load more" (chapters.load_more): ManhuaTop shows 50
                // chapters and a button for the next 50. Click it whenever the list
                // has just grown, wait up to 3 ticks for the page to land, and collect
                // once the button is gone, the list stops growing, or 10 clicks are in.
                if (chRules.load_more && items.length > 0 && attempts < maxAttempts && __loadMoreClicks < 10) {
                    var moreBtn = null;
                    try { moreBtn = document.querySelector(chRules.load_more); } catch (e) {}
                    if (items.length > __lastCount) { __lastCount = items.length; __stalledTicks = 0; } else { __stalledTicks++; }
                    if (moreBtn) {
                        // The button is disabled while a page is loading: wait, don't collect.
                        if (!moreBtn.disabled && __stalledTicks === 0) {
                            __loadMoreClicks++;
                            sendLog('Load more chapters (' + __loadMoreClicks + '): ' + items.length + ' so far');
                            moreBtn.click();
                            return;
                        }
                        if (__stalledTicks < 3) return;
                    }
                }

                if (items.length > 0 || attempts >= maxAttempts) {
                    clearInterval(interval);
                    
                    if (items.length > 0) {
                        items.forEach(el => {
                            try {
                                const titleEl = (chRules.title === 'self') ? el : (el.querySelector(chRules.title) || el);
                                const linkEl = (chRules.link === 'self') ? el : (el.querySelector(chRules.link) || el);
                                // Date is optional — falls back to common selectors used by Madara/Astro themes
                                let dateEl = null;
                                if (chRules.date) {
                                    dateEl = el.querySelector(chRules.date);
                                }
                                if (!dateEl) {
                                    dateEl = el.querySelector('.chapter-release-date, .chapter-release-date i, .chapterdate, .dt, time, [class*="date"]');
                                }
                                const dateText = dateEl ? (dateEl.innerText || dateEl.textContent || dateEl.getAttribute('title') || '').trim() : '';
                                const rowTitle = (titleEl.innerText || titleEl.textContent || 'Chapter').trim();
                                if (__isLockedRow(el, rowTitle)) { lockedSkipped++; return; }

                                if (linkEl && linkEl.href) {
                                    results.push({
                                        title: rowTitle,
                                        link: linkEl.href,
                                        date: dateText
                                    });
                                }
                            } catch(e) {}
                        });
                    }

                    // SMARTER LAST RESORT: For sites like Webtoons where URLs don't contain 'chapter'
                    if (results.length === 0) {
                        sendLog('Primary selectors failed. Running Deep Link Scan...');
                        const allLinks = document.querySelectorAll('a');
                        for (let a of allLinks) {
                            const href = a.href.toLowerCase();
                            // Webtoons uses /viewer or /ep- or /episode
                            const isChapterLink = href.includes('chapter') || href.includes('viewer') || href.includes('ep-') || href.includes('episode');
                            if (isChapterLink && !results.some(r => r.link === a.href)) {
                                if (__isLockedRow(a, a.innerText)) { lockedSkipped++; continue; }
                                results.push({ title: a.innerText.trim() || 'Episode', link: a.href });
                            }
                        }
                    }

                    // Each cloud-config selector is wrapped in try/catch because some configs
                    // contain BeautifulSoup-specific pseudo-classes (e.g. :-soup-contains) that
                    // are valid in Python but throw SyntaxError in browser CSS. Without these
                    // guards, one bad selector aborts the whole tick and SUCCESS never posts.
                    function safeQueryAll(sel) {
                        try { return document.querySelectorAll(sel); }
                        catch (e) { sendLog('Selector failed: ' + sel + ' (' + (e && e.message ? e.message : 'unknown') + ')'); return []; }
                    }
                    function safeQuery(sel) {
                        try { return document.querySelector(sel); }
                        catch (e) { sendLog('Selector failed: ' + sel + ' (' + (e && e.message ? e.message : 'unknown') + ')'); return null; }
                    }

                    const descEl = safeQuery(detailsRules.desc || '.summary__content') || safeQuery('meta[name="description"]');
                    const desc = descEl ? (descEl.innerText || descEl.textContent || descEl.content || '').trim() : "";

                    // Genre + author selectors typically match multiple elements (one per tag/name).
                    // Collect the visible text of each and join with commas. Exact repeats are
                    // dropped, in case a layout renders the same tags twice (Asura's markup labels
                    // its genre block "Desktop", so a client-rendered mobile copy is possible).
                    function joinUniqueText(els) {
                        const out = [];
                        Array.from(els).forEach(el => {
                            const t = (el.innerText || el.textContent || '').trim();
                            if (t && out.indexOf(t) === -1) out.push(t);
                        });
                        return out.join(', ');
                    }
                    let genre = '';
                    if (detailsRules.genre) genre = joinUniqueText(safeQueryAll(detailsRules.genre));
                    let author = '';
                    if (detailsRules.author) author = joinUniqueText(safeQueryAll(detailsRules.author));

                    // "Alternative" names row: the meta block (Madara .post-content_item,
                    // MangaStream .imptdt) whose heading says Alternative / Synonyms.
                    // Regex literal with \\ — see WHITESPACE_RE above for the escape rules.
                    var ALT_RE = /alternative|alt(ernate)?\\s*(name|title)|synonym|other\\s*name|associated\\s*name/i;
                    let altNames = '';
                    // details.alt_names (config): a dedicated element with no heading.
                    if (detailsRules.alt_names) {
                        const altEl = safeQuery(detailsRules.alt_names);
                        altNames = altEl ? (altEl.textContent || '').replace(/\\s+/g, ' ').trim().substring(0, 1000) : '';
                    }
                    if (!altNames && detailsRules.meta_container && detailsRules.meta_key && detailsRules.meta_val) {
                        const blocks = safeQueryAll(detailsRules.meta_container);
                        for (let bi = 0; bi < blocks.length && !altNames; bi++) {
                            try {
                                const b = blocks[bi];
                                const keyEl = detailsRules.meta_key === 'self' ? b : b.querySelector(detailsRules.meta_key);
                                const valEl = detailsRules.meta_val === 'self' ? b : b.querySelector(detailsRules.meta_val);
                                const key = keyEl ? (keyEl.textContent || '') : '';
                                if (!ALT_RE.test(key)) continue;
                                let val = valEl ? (valEl.textContent || '') : '';
                                if (detailsRules.meta_key === 'self' || detailsRules.meta_val === 'self') val = val.replace(ALT_RE, '');
                                altNames = val.replace(/\\s+/g, ' ').trim().substring(0, 1000);
                            } catch (e) {}
                        }
                        if (altNames) sendLog('Alternative names: ' + altNames.substring(0, 120));
                    }

                    // The site's own rating, as text on the site's scale; the app
                    // converts it (services/rating.ts). details.rating_attr (config)
                    // names an attribute when the number is not in the text
                    // (ManhuaTop draws stars and keeps "4.5 out of 5" in title).
                    let siteRating = '';
                    if (detailsRules.rating) {
                        const ratingEl = safeQuery(detailsRules.rating);
                        if (ratingEl) {
                            let ratingText = detailsRules.rating_attr
                                ? (ratingEl.getAttribute(detailsRules.rating_attr) || '')
                                : (ratingEl.innerText || ratingEl.textContent || '');
                            if (!/\\d/.test(ratingText)) {
                                ratingText = ratingEl.getAttribute('title') || ratingEl.getAttribute('content') || ratingEl.getAttribute('aria-label') || '';
                            }
                            siteRating = ratingText.replace(/\\s+/g, ' ').trim().substring(0, 60);
                        }
                    }

                    if (lockedSkipped > 0) sendLog('Skipped ' + lockedSkipped + ' locked/early-access chapter row(s)');
                    sendLog('About to post SUCCESS with ' + results.length + ' chapters');
                    if (__bridge) {
                        try {
                            __bridge.postMessage(JSON.stringify({ type: 'SUCCESS', chapters: results, desc: desc, genre: genre, author: author, altNames: altNames, siteRating: siteRating }));
                            sendLog('Posted SUCCESS');
                        } catch (e) {
                            sendLog('SUCCESS post threw: ' + (e && e.message ? e.message : 'unknown'));
                        }
                    } else {
                        sendLog('SUCCESS post skipped: bridge missing');
                    }
                }
            }, 1000);
        })();
        true;
    ` : '';

    const handleMessage = (event: any) => {
        const time = new Date().toLocaleTimeString();
        // Unparseable or unknown-type messages just no-op. Aborting the scrape
        // here would let any stray ad-iframe message kill an in-flight scrape.
        const payload = parseWebViewMessage(event.nativeEvent.data, DETAILS_ALLOWED_TYPES, 'DETAILS');
        if (!payload) return;
        try {
            if (payload.type === 'DEBUG') {
                addLog(clampString(payload.message));
                return;
            }
            if (payload.type === 'SHOW_WEBVIEW') {
                setShowWebView(true);
                return;
            }
            if (payload.type === 'SUCCESS') {
                if (!isBoundedArray(payload.chapters, MAX_CHAPTERS)) {
                    console.warn(`[${time}] [DETAILS]: SUCCESS rejected — chapters missing/oversized`);
                    setScraping(false);
                    setShowWebView(false);
                    setRefreshing(false);
                    return;
                }
                const safeChapters = (payload.chapters as unknown[]).filter(
                    (c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c)
                );
                console.log(`[${time}] [DETAILS SUCCESS]: Extracted ${safeChapters.length} chapters, genre="${clampString(payload.genre)}", author="${clampString(payload.author)}"`);
                // A page that yielded nothing must not wipe the saved list on screen.
                setChapters(prev => (safeChapters.length === 0 && prev.length > 0 ? prev : safeChapters));
                setDescription(clampString(payload.desc) || 'No description found.');
                setGenreList(clampString(payload.genre));
                setAuthorList(clampString(payload.author));
                setScraping(false);
                setShowWebView(false);
                setRefreshing(false);
                // Alternate names from this page: kept for addToLibrary, and for a
                // library comic merged into the stored list (feeds discovery).
                const scrapedAlt = clampString(payload.altNames, 1000);
                scrapedAltRef.current = scrapedAlt;
                if (inLibrary && scrapedAlt) {
                    const altTitle = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
                    const merged = mergeAltNames(altNamesRef.current, parseAltNames(scrapedAlt), altTitle);
                    if (altTitle && merged !== altNamesRef.current) persistAltNames(altTitle, merged);
                }
                // The site's rating on its own scale → the 5-point site_rating,
                // stored for a library comic so the pill is right at once next time.
                const scrapedSiteRating = normalizeSiteRating(clampString(payload.siteRating, 60), ratingScaleFor(config));
                if (scrapedSiteRating) {
                    siteRatingRef.current = scrapedSiteRating;
                    setSiteRating(scrapedSiteRating);
                    if (inLibrary) {
                        const ratingTitle = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
                        if (ratingTitle) {
                            (async () => {
                                try {
                                    const db = await initDatabase();
                                    await db.runAsync('UPDATE manga SET site_rating = ? WHERE title = ?', [scrapedSiteRating, ratingTitle]);
                                } catch (e: any) {
                                    console.warn('[DETAILS]: site_rating save failed', e?.message || e);
                                }
                            })();
                        }
                    }
                }
                // M2b: primary list is on screen — now fan out to the linked
                // sources and merge each one in as it arrives.
                primaryChaptersRef.current = safeChapters;
                if (linkedSourcesRef.current.length > 0) {
                    recomputeMerge(linkedSourcesRef.current);
                    scrapeLinkedSources(linkedSourcesRef.current);
                }
                // If this comic is already in the library, refresh its latest_chapter
                // from the freshly-scraped chapters[0]. Catches comics that don't appear
                // on Explore page 1 anymore so they never get updated by that path.
                if (inLibrary && safeChapters.length > 0) {
                    let latest = clampString(safeChapters[0].title).trim();
                    const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
                    if (latest && titleStr) {
                        (async () => {
                            try {
                                const db = await initDatabase();
                                const row = await db.getFirstAsync<{ latest_chapter: string }>(
                                    'SELECT latest_chapter FROM manga WHERE title = ?', [titleStr]
                                );
                                // Phantom guard: on sites that list chapters before uploading
                                // pages (MangaRead), a newer chapter is stored only once its
                                // page has images. A phantom falls back to the next row; an
                                // unverifiable one leaves latest_chapter alone this time.
                                const pageUrl = manga_url as string;
                                const markers = getPageMarkers(matchConfigToUrlStrict(allConfigs, pageUrl)?.json_rules ?? null, pageUrl);
                                if (row && markers.length > 0 && isNewerChapter(latest, row.latest_chapter, null)) {
                                    const candidates = safeChapters.slice(0, 5).map(c => ({
                                        title: clampString(c.title).trim(),
                                        url: clampString(c.link),
                                    }));
                                    const picked = await pickLatestWithPages(candidates, markers, t => isNewerChapter(t, row.latest_chapter, null));
                                    if (!picked) return;
                                    latest = picked;
                                }
                                // M2: this scrape only saw the primary source. If a linked
                                // source already pushed latest_chapter further ahead, don't
                                // regress it. When we do write, the value came from the
                                // primary, so clear the "via <site>" hint.
                                if (row && row.latest_chapter !== latest && !isChapterDowngrade(row.latest_chapter, latest)) {
                                    // Only a higher chapter number moves latest_date; a reworded
                                    // title for the same chapter ("Chapter 149" → "Chapter 149 The
                                    // Red (5)") keeps the date it had.
                                    const isNew = isNewerChapter(latest, row.latest_chapter, null);
                                    const latestDate = isNew ? isoMinute() : null;
                                    if (latestDate) {
                                        await db.runAsync('UPDATE manga SET latest_chapter = ?, latest_source = ?, latest_date = ? WHERE title = ?', [latest, '', latestDate, titleStr]);
                                    } else {
                                        await db.runAsync('UPDATE manga SET latest_chapter = ?, latest_source = ? WHERE title = ?', [latest, '', titleStr]);
                                    }
                                    const { data: { session } } = await supabase.auth.getSession();
                                    if (session?.user) {
                                        await supabase.from('manga_library').upsert(
                                            { user_id: session.user.id, title: titleStr, latest_chapter: latest, ...(latestDate ? { latest_date: latestDate } : {}) },
                                            { onConflict: 'user_id,title' }
                                        );
                                    }
                                    console.log(`[${time}] [DETAILS]: Refreshed library latest_chapter for "${titleStr}" → "${latest}"`);
                                }
                            } catch (e: any) {
                                console.warn('[DETAILS]: latest_chapter refresh failed:', e.message || e);
                            }
                        })();
                    }
                }
            }
        } catch (e: any) {
            setScraping(false);
            setRefreshing(false);
        }
    };

    // The chapter rows, rebuilt only when what they show changes. Rendered
    // inline they were rebuilt (hundreds of rows) on every state change of
    // this screen, such as each source-search progress tick, which made
    // scrolling stutter.
    // The list as shown: optionally oldest first, and narrowed to the chapters
    // whose number starts with what was typed ("4" → 4, 40–49, 400…).
    const visibleChapters = useMemo(() => {
        const q = chapterFilter.trim().toLowerCase();
        let list = chapters;
        if (q) {
            list = list.filter(c => {
                const n = parseChapterNumber(c.title);
                return (n !== null && String(n).startsWith(q)) || String(c.title || '').toLowerCase().includes(q);
            });
        }
        return oldestFirst ? [...list].reverse() : list;
    }, [chapters, chapterFilter, oldestFirst]);

    // Continue: the lowest chapter above the last one read (the first chapter
    // when nothing is read yet); null when caught up.
    const nextChapter = useMemo(() => {
        const readN = parseChapterNumber(readChapter) ?? 0;
        let best: any = null;
        let bestN = Infinity;
        for (const c of chapters) {
            const n = parseChapterNumber(c.title);
            if (n === null || n <= readN) continue;
            if (n < bestN) { bestN = n; best = c; }
        }
        return best;
    }, [chapters, readChapter]);

    const openChapter = (ch: any) => {
        setChapterCache(manga_url as string, chapters);
        router.push({ pathname: '/read', params: { chapter_url: ch.link, manga_title: title, chapter_title: ch.title, manga_url: manga_url as string } });
    };

    // A stored latest_chapter that no source shows any more comes down to the
    // newest chapter the sources really have. It only ever moved up before, so
    // a number from a source since removed, or a misread page, stayed forever.
    // Runs once every source has finished loading, readable or not: a source
    // that shows no chapters cannot be what the stored number came from.
    useEffect(() => {
        if (scraping || mergingCount > 0 || !inLibrary || chapters.length === 0) return;
        const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? title[0] : '';
        if (!titleStr) return;
        const counting = linkedSourcesRef.current.filter(countsForUpdates);
        if (counting.some(s => !linkedListsRef.current.has(s.manga_url) && !linkedFailedRef.current.has(s.manga_url))) return;
        const countingNames = new Set(counting.map(s => s.website_name));
        let top: any = null;
        let topN = -1;
        for (const c of chapters) {
            if (c.website_name && c.website_name !== primaryWebsiteName && !countingNames.has(c.website_name)) continue;
            const n = parseChapterNumber(c.title);
            if (n !== null && n > topN) { topN = n; top = c; }
        }
        if (!top) return;
        (async () => {
            try {
                const db = await initDatabase();
                const row = await db.getFirstAsync<{ latest_chapter: string }>('SELECT latest_chapter FROM manga WHERE title = ?', [titleStr]);
                const storedN = row ? parseChapterNumber(row.latest_chapter) : null;
                if (storedN === null || storedN <= topN) return;
                const latest = String(top.title || '').trim();
                await db.runAsync('UPDATE manga SET latest_chapter = ?, latest_source = ? WHERE title = ?', [latest, '', titleStr]);
                const { data: { session } } = await supabase.auth.getSession();
                if (session?.user) {
                    await supabase.from('manga_library').update({ latest_chapter: latest }).match({ user_id: session.user.id, title: titleStr });
                }
                addLog(`Latest chapter corrected: "${row?.latest_chapter}" is on no source, now "${latest}"`);
            } catch (e: any) {
                console.warn('[DETAILS]: latest_chapter correction failed:', e?.message || e);
            }
        })();
    }, [scraping, mergingCount, inLibrary, chapters]);

    const chapterRows = useMemo(() => visibleChapters.map((ch, idx) => {
                            const isDl = downloadedSet.has(ch.link);
                            const queueItem = queueSnapshot.find(q => q.chapterUrl === ch.link);
                            const isDownloadQueued = !!queueItem && (queueItem.status === 'pending' || queueItem.status === 'active');
                            const isScrapingThis = scrapeQueueUrls.has(ch.link);
                            return (
                                <View key={idx} style={styles.chapterRow}>
                                    <TouchableOpacity style={{ flex: 1 }} onPress={() => {
                                        const now = new Date().toLocaleTimeString();
                                        console.log(`[${now}] [USER CLICK]: Opening chapter "${ch.title}"`);
                                        // Pass chapter list to the Reader via in-memory cache so its
                                        // prev/next-chapter buttons know what to navigate to.
                                        setChapterCache(manga_url as string, chapters);
                                        router.push({ pathname: '/read', params: { chapter_url: ch.link, manga_title: title, chapter_title: ch.title, manga_url: manga_url as string }})
                                    }}>
                                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                            <Text style={styles.chapterTitle}>{ch.title}</Text>
                                            {isDl && <Ionicons name="checkmark-circle" size={13} color={colors.success} style={{ marginLeft: 6 }} />}
                                            {ch.website_name && ch.website_name !== primaryWebsiteName ? (
                                                <View style={styles.sourceBadge}>
                                                    <Text style={styles.sourceBadgeText} numberOfLines={1}>{ch.website_name}</Text>
                                                </View>
                                            ) : null}
                                        </View>
                                        {ch.date ? <Text style={styles.chapterDate}>{ch.date}</Text> : null}
                                    </TouchableOpacity>
                                    {inLibrary && (
                                        isScrapingThis || (isDownloadQueued && queueItem?.status === 'active') ? (
                                            <ActivityIndicator size="small" color={colors.accent} style={{ marginLeft: 8 }} />
                                        ) : isDownloadQueued ? (
                                            <Text style={{ color: colors.textMuted, fontSize: 11, marginLeft: 8 }}>Queued</Text>
                                        ) : isDl ? (
                                            <TouchableOpacity onPress={() => handleDeleteChapterDownload(ch.link, ch.title)} hitSlop={10} style={{ marginLeft: 8, padding: 4 }}>
                                                <Ionicons name="trash-outline" size={18} color={colors.destructive} />
                                            </TouchableOpacity>
                                        ) : (
                                            <TouchableOpacity onPress={() => startDownload(ch.link, ch.title)} hitSlop={10} style={{ marginLeft: 8, padding: 4 }}>
                                                <Ionicons name="cloud-download-outline" size={18} color={colors.textMuted} />
                                            </TouchableOpacity>
                                        )
                                    )}
                                </View>
                            );
    }), [visibleChapters, chapters, downloadedSet, queueSnapshot, scrapeQueueUrls, inLibrary, primaryWebsiteName, styles, colors, manga_url, title]);

    return (
        <View style={styles.container}>
            <Stack.Screen options={{ title: typeof title === 'string' ? title : 'Details' }} />
            <ScrollView
                contentContainerStyle={styles.scrollBlock}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={handleRefresh}
                        tintColor={colors.accent}
                        colors={[colors.accent]}
                    />
                }
            >
                <View style={styles.header}>
                    {cover_url ? <Image source={{ uri: cover_url as string }} style={styles.cover} resizeMode="cover" /> : <View style={styles.placeholder} />}
                    <View style={styles.headerTextContainer}>
                        <Text style={styles.title} numberOfLines={3}>{title}</Text>
                        {(authorList || genreList) && (
                            <View style={{ marginBottom: 12 }}>
                                {authorList ? <Text style={styles.metaTag} numberOfLines={1}>By {authorList}</Text> : null}
                                {genreList ? <Text style={styles.metaTag} numberOfLines={2}>{genreList}</Text> : null}
                            </View>
                        )}
                        {inLibrary ? (
                            <View style={styles.actionRow}>
                                <View style={styles.libraryBadge}>
                                    <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                                    <Text style={styles.libraryBadgeText}>In Library</Text>
                                </View>
                                <TouchableOpacity style={styles.removeBtn} onPress={removeFromLibrary} activeOpacity={0.7}>
                                    <Ionicons name="trash-outline" size={14} color={colors.destructive} />
                                    <Text style={styles.removeBtnText}>Remove</Text>
                                </TouchableOpacity>
                            </View>
                        ) : (
                            <TouchableOpacity style={styles.libraryBtn} onPress={addToLibrary} activeOpacity={0.8}>
                                <Text style={styles.libraryBtnText}>+ Add to Library</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
                <Text style={styles.desc}>{description}</Text>

                {inLibrary && (
                    <View style={styles.metaBlock}>
                        <View style={styles.metaRow}>
                            <TouchableOpacity style={styles.metaPill} onPress={() => setStatusModalOpen(true)} activeOpacity={0.7}>
                                <Text style={styles.metaPillLabel}>Status</Text>
                                <Text style={styles.metaPillValue}>{status || 'Set status'}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.metaPill}
                                onPress={() => { setRatingInput(rating); setRatingError(''); setRatingModalOpen(true); }}
                                activeOpacity={0.7}
                            >
                                <Text style={styles.metaPillLabel}>Your rating</Text>
                                <Text style={styles.metaPillValue}>{rating ? `${rating} / ${RATING_MAX}` : 'Not rated'}</Text>
                            </TouchableOpacity>
                            {!!siteRating && (
                                <View style={styles.metaPill}>
                                    <Text style={styles.metaPillLabel}>Site rating</Text>
                                    <Text style={styles.metaPillValue}>{`${siteRating} / ${RATING_MAX}`}</Text>
                                </View>
                            )}
                        </View>
                        {(probing || visibleSuggestions.length > 0 || probeFoundNone) && (
                            <>
                                <Text style={styles.metaLabel}>Suggested sources</Text>
                                <ScrollView
                                    horizontal
                                    showsHorizontalScrollIndicator={false}
                                    contentContainerStyle={styles.sourceChipRow}
                                >
                                    {visibleSuggestions.map(sug => (
                                        <TouchableOpacity
                                            key={sug.matchedUrl}
                                            style={styles.suggestChip}
                                            onPress={() => handleLinkSuggestion(sug)}
                                            activeOpacity={0.7}
                                        >
                                            <Ionicons name="add-circle" size={13} color={colors.accent} style={{ marginRight: 4 }} />
                                            <Text style={[styles.sourceChipText, { color: colors.accent }]} numberOfLines={1}>{sug.websiteName}</Text>
                                            <TouchableOpacity
                                                onPress={() => handleDismissSuggestion(sug.matchedUrl)}
                                                hitSlop={8}
                                                style={styles.sourceChipRemove}
                                            >
                                                <Ionicons name="close" size={12} color={colors.textMuted} />
                                            </TouchableOpacity>
                                        </TouchableOpacity>
                                    ))}
                                    {probing && (
                                        <View style={styles.suggestLoading}>
                                            <ActivityIndicator size="small" color={colors.textMuted} />
                                            <Text style={styles.suggestLoadingText}>Searching other sites {probeProgress.done}/{probeProgress.total}</Text>
                                        </View>
                                    )}
                                    {!probing && probeFoundNone && visibleSuggestions.length === 0 && (
                                        <View style={styles.suggestLoading}>
                                            <Text style={styles.suggestLoadingText}>No other sources found</Text>
                                        </View>
                                    )}
                                </ScrollView>
                            </>
                        )}
                        <Text style={styles.metaLabel}>Sources</Text>
                        <ScrollView
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            contentContainerStyle={styles.sourceChipRow}
                        >
                            <View style={[styles.sourceChip, styles.sourceChipPrimary]}>
                                <Ionicons name="star" size={11} color={colors.accent} style={{ marginRight: 4 }} />
                                <Text style={styles.sourceChipText} numberOfLines={1}>{primaryWebsiteName}</Text>
                            </View>
                            {linkedSources.map(s => {
                                const suspect = !feedsMerge(s);
                                return (
                                <View key={s.manga_url} style={[styles.sourceChip, suspect && { borderWidth: 1, borderColor: '#E0A800' }]}>
                                    {/* The whole name is the "switch to this source" target;
                                        the star alone was too small to find. A source flagged
                                        as a probable different series explains itself instead. */}
                                    <TouchableOpacity
                                        onPress={() => (suspect ? handleSuspectSourceTap(s) : handleSetPrimary(s))}
                                        hitSlop={8}
                                        activeOpacity={0.6}
                                        style={{ flexDirection: 'row', alignItems: 'center' }}
                                    >
                                        {suspect && <Ionicons name="warning" size={12} color="#E0A800" style={{ marginRight: 4 }} />}
                                        {!suspect && s.updates === 'muted' && <Ionicons name="notifications-off-outline" size={12} color={colors.textMuted} style={{ marginRight: 4 }} />}
                                        <Text style={styles.sourceChipText} numberOfLines={1}>{s.website_name}</Text>
                                    </TouchableOpacity>
                                    {/* Mute updates / Remove. Replaces the star-outline, which
                                        duplicated the name tap. */}
                                    <TouchableOpacity
                                        onPress={() => handleLinkedSourceMenu(s)}
                                        hitSlop={8}
                                        style={styles.sourceChipRemove}
                                    >
                                        <Ionicons name="ellipsis-horizontal" size={12} color={colors.textMuted} />
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        onPress={() => handleRemoveLinkedSource(s.manga_url)}
                                        hitSlop={8}
                                        style={styles.sourceChipRemove}
                                    >
                                        <Ionicons name="close" size={12} color={colors.textMuted} />
                                    </TouchableOpacity>
                                </View>
                                );
                            })}
                            <TouchableOpacity
                                style={styles.sourceChipAdd}
                                onPress={() => { setAddSourceInput(''); setAddSourceError(''); setAddSourceModalOpen(true); }}
                                activeOpacity={0.7}
                            >
                                <Ionicons name="add" size={14} color={colors.accent} />
                                <Text style={[styles.sourceChipText, { color: colors.accent }]}>Add</Text>
                            </TouchableOpacity>
                        </ScrollView>

                        <Text style={styles.metaLabel}>Notes</Text>
                        <TextInput
                            style={styles.notesInput}
                            value={notes}
                            onChangeText={setNotes}
                            onBlur={() => persistField('notes', notes)}
                            placeholder="Personal notes — saved on blur, synced to cloud"
                            placeholderTextColor={colors.textDim}
                            multiline
                            textAlignVertical="top"
                        />
                        {savingMeta && <Text style={styles.savingText}>Saving...</Text>}
                    </View>
                )}

                <View style={styles.chapterSection}>
                    <View style={styles.chapterHeaderRow}>
                        <Text style={styles.chapterHeader}>Chapters ({chapters.length})</Text>
                        {inLibrary && chapters.length > 0 && (
                            <View style={{ flexDirection: 'row' }}>
                                {downloadedSet.size > 0 && (
                                    <TouchableOpacity onPress={handleDeleteAllMangaDownloads} style={styles.headerActionBtn}>
                                        <Ionicons name="trash-outline" size={14} color={colors.destructive} />
                                        <Text style={[styles.headerActionText, { color: colors.destructive }]}>Delete all</Text>
                                    </TouchableOpacity>
                                )}
                                <TouchableOpacity onPress={handleDownloadAll} style={styles.headerActionBtn}>
                                    <Ionicons name="cloud-download-outline" size={14} color={colors.accent} />
                                    <Text style={[styles.headerActionText, { color: colors.accent }]}>Download all</Text>
                                </TouchableOpacity>
                            </View>
                        )}
                    </View>
                    {chapters.length > 0 && (
                        <View style={styles.chapterNavRow}>
                            <TextInput
                                style={styles.chapterSearchInput}
                                value={chapterFilter}
                                onChangeText={setChapterFilter}
                                placeholder="Go to chapter…"
                                placeholderTextColor={colors.textDim}
                                keyboardType="numbers-and-punctuation"
                                autoCorrect={false}
                                clearButtonMode="while-editing"
                            />
                            <TouchableOpacity style={styles.chapterNavBtn} onPress={() => setOldestFirst(v => !v)} activeOpacity={0.7}>
                                <Ionicons name={oldestFirst ? 'arrow-up' : 'arrow-down'} size={13} color={colors.text} />
                                <Text style={styles.chapterNavBtnText}>{oldestFirst ? 'Oldest first' : 'Newest first'}</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                    {inLibrary && nextChapter && (
                        <TouchableOpacity style={styles.continueBtn} onPress={() => openChapter(nextChapter)} activeOpacity={0.8}>
                            <Ionicons name="play" size={13} color="#fff" />
                            <Text style={styles.continueBtnText} numberOfLines={1}>
                                {parseChapterNumber(readChapter) ? 'Continue' : 'Start'}: {nextChapter.title}
                            </Text>
                        </TouchableOpacity>
                    )}
                    {!scraping && chapters.length === 0 && (
                        <Text style={styles.emptyChapters}>
                            No chapters found on {primaryWebsiteName || 'this source'}. The site may have none for this comic, or the page did not load. Pull down to try again.
                        </Text>
                    )}
                    {chapters.length > 0 && visibleChapters.length === 0 && (
                        <Text style={styles.emptyChapters}>No chapter matches "{chapterFilter}".</Text>
                    )}
                    {scrapeQueueUrls.size > 0 && (
                        <Text style={styles.downloadStatus}>
                            Preparing {scrapeQueueUrls.size} chapter{scrapeQueueUrls.size === 1 ? '' : 's'}...
                        </Text>
                    )}
                    {mergingCount > 0 && (
                        <View style={styles.mergingRow}>
                            <ActivityIndicator size="small" color={colors.textMuted} />
                            <Text style={styles.mergingText}>
                                Merging {mergingCount} source{mergingCount === 1 ? '' : 's'}…
                            </Text>
                        </View>
                    )}
                    {scraping && chapters.length > 0 && (
                        <View style={styles.mergingRow}>
                            <ActivityIndicator size="small" color={colors.textMuted} />
                            <Text style={styles.mergingText}>Showing the saved list while the page loads…</Text>
                        </View>
                    )}
                    {scraping && chapters.length === 0 ? (
                        <View>
                            {Array.from({ length: 6 }).map((_, i) => <SkeletonChapterRow key={i} />)}
                        </View>
                    ) : chapterRows}
                </View>
            </ScrollView>

            {/* Status picker modal */}
            <Modal visible={statusModalOpen} transparent animationType="slide" onRequestClose={() => setStatusModalOpen(false)}>
                <Pressable style={styles.metaModalBackdrop} onPress={() => setStatusModalOpen(false)}>
                    <Pressable style={styles.metaModalSheet} onPress={() => { /* swallow */ }}>
                        <View style={styles.metaModalHandle} />
                        <Text style={styles.metaModalTitle}>Reading status</Text>
                        {STATUS_OPTIONS.map(opt => {
                            const active = status === opt;
                            return (
                                <TouchableOpacity
                                    key={opt}
                                    style={[styles.metaModalRow, active && styles.metaModalRowActive]}
                                    onPress={async () => { setStatus(opt); setStatusModalOpen(false); await persistField('status', opt); }}
                                >
                                    <Text style={[styles.metaModalRowText, active && { color: colors.accent, fontWeight: '700' }]}>{opt}</Text>
                                    {active && <Text style={{ color: colors.accent, fontSize: 16, fontWeight: 'bold' }}>✓</Text>}
                                </TouchableOpacity>
                            );
                        })}
                    </Pressable>
                </Pressable>
            </Modal>

            {/* Rating picker modal */}
            <Modal visible={ratingModalOpen} transparent animationType="slide" onRequestClose={() => setRatingModalOpen(false)}>
                <Pressable style={styles.metaModalBackdrop} onPress={() => setRatingModalOpen(false)}>
                    <Pressable style={styles.metaModalSheet} onPress={() => { /* swallow */ }}>
                        <View style={styles.metaModalHandle} />
                        <Text style={styles.metaModalTitle}>Your rating</Text>
                        <Text style={styles.addSourceHelp}>
                            {`Any number from 0.1 to ${RATING_MAX}, like 4.8.${siteRating ? ` The site rates it ${siteRating} / ${RATING_MAX}.` : ''} Leave empty to clear.`}
                        </Text>
                        <TextInput
                            style={styles.addSourceInput}
                            value={ratingInput}
                            onChangeText={(v) => { setRatingInput(v); if (ratingError) setRatingError(''); }}
                            placeholder="Not rated"
                            placeholderTextColor={colors.textDim}
                            keyboardType="decimal-pad"
                            maxLength={4}
                            autoFocus
                            onSubmitEditing={saveRating}
                        />
                        {!!ratingError && <Text style={styles.addSourceError}>{ratingError}</Text>}
                        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 }}>
                            <TouchableOpacity
                                onPress={() => setRatingModalOpen(false)}
                                style={[styles.addSourceBtn, { backgroundColor: 'transparent', marginRight: 8 }]}
                            >
                                <Text style={[styles.addSourceBtnText, { color: colors.textMuted }]}>Cancel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                onPress={saveRating}
                                style={[styles.addSourceBtn, { backgroundColor: colors.accent }]}
                            >
                                <Text style={[styles.addSourceBtnText, { color: '#fff' }]}>Save</Text>
                            </TouchableOpacity>
                        </View>
                    </Pressable>
                </Pressable>
            </Modal>

            {/* Add-source modal (M1 manual paste-URL flow). M3 will replace this
                with an in-app search across configured sites + auto-suggest. */}
            <Modal visible={addSourceModalOpen} transparent animationType="slide" onRequestClose={() => setAddSourceModalOpen(false)}>
                <Pressable style={styles.metaModalBackdrop} onPress={() => setAddSourceModalOpen(false)}>
                    <Pressable style={styles.metaModalSheet} onPress={() => { /* swallow */ }}>
                        <View style={styles.metaModalHandle} />
                        <Text style={styles.metaModalTitle}>Link another source</Text>
                        <Text style={styles.addSourceHelp}>
                            Find this comic on another site, copy its URL, and paste it here. Refresh will then pull updates from every linked source.
                        </Text>
                        <TextInput
                            style={styles.addSourceInput}
                            value={addSourceInput}
                            onChangeText={(v) => { setAddSourceInput(v); if (addSourceError) setAddSourceError(''); }}
                            placeholder="https://..."
                            placeholderTextColor={colors.textDim}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                        />
                        {!!addSourceError && <Text style={styles.addSourceError}>{addSourceError}</Text>}
                        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 }}>
                            <TouchableOpacity
                                onPress={() => setAddSourceModalOpen(false)}
                                style={[styles.addSourceBtn, { backgroundColor: 'transparent', marginRight: 8 }]}
                                disabled={addSourceBusy}
                            >
                                <Text style={[styles.addSourceBtnText, { color: colors.textMuted }]}>Cancel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                onPress={handleAddLinkedSource}
                                style={[styles.addSourceBtn, { backgroundColor: colors.accent, opacity: addSourceBusy ? 0.6 : 1 }]}
                                disabled={addSourceBusy}
                            >
                                {addSourceBusy
                                    ? <ActivityIndicator size="small" color="#fff" />
                                    : <Text style={[styles.addSourceBtnText, { color: '#fff' }]}>Link</Text>}
                            </TouchableOpacity>
                        </View>
                    </Pressable>
                </Pressable>
            </Modal>

            {/* (Download scraping now handled globally by HiddenScrapeWebView in app root) */}

            {config && isSafeMangaUrl(webViewUrl) && (
                <View style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                    zIndex: showWebView ? 100 : -1,
                    opacity: showWebView ? 1.0 : 0.01,
                    backgroundColor: '#FFF'
                }} pointerEvents={showWebView ? 'auto' : 'none'}>
                    {showWebView && (
                        <View style={{ padding: 12, backgroundColor: '#1E1E20', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 12 }}>Security Check Needed</Text>
                            <View style={{ flexDirection: 'row' }}>
                                <TouchableOpacity onPress={() => setWebViewUrl(manga_url + '?t=' + Date.now())} style={{ backgroundColor: '#E15053', padding: 8, borderRadius: 6, marginRight: 8 }}>
                                    <Text style={{ color: '#fff', fontSize: 11, fontWeight: 'bold' }}>Reload Page</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={() => setShowWebView(false)} style={{ backgroundColor: '#444', padding: 8, borderRadius: 6 }}>
                                    <Text style={{ color: '#fff', fontSize: 11, fontWeight: 'bold' }}>Close</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    )}
                    <WebView
                        // Keyed on the loaded URL, not the route param, so a saved-link
                        // rewrite (setParams below) doesn't remount and re-scrape.
                        key={`${webViewUrl}-${reloadKey}`}
                        source={{ uri: webViewUrl }}
                        injectedJavaScript={INJECTED_JAVASCRIPT}
                        onMessage={handleMessage}
                        javaScriptEnabled={true}
                        domStorageEnabled={true}
                        {...WEBVIEW_HARDENING_PROPS}
                        onShouldStartLoadWithRequest={webViewNavigationGate}
                        onLoadStart={(e) => addLog('WV LOAD-START: ' + e.nativeEvent.url)}
                        onLoadEnd={(e) => {
                            addLog('WV LOAD-END: ' + e.nativeEvent.url + ' (loading=' + e.nativeEvent.loading + ')');
                            maybeRewriteStaleUrl(e.nativeEvent.url);
                        }}
                        onError={(e) => addLog('WV ERROR: ' + e.nativeEvent.description + ' (code=' + e.nativeEvent.code + ')')}
                        onHttpError={(e) => addLog('WV HTTP-ERROR: ' + e.nativeEvent.statusCode + ' on ' + e.nativeEvent.url)}
                        onNavigationStateChange={(state) => addLog('WV NAV: ' + state.url + ' (loading=' + state.loading + ', canGoBack=' + state.canGoBack + ')')}
                        userAgent={(manga_url as string)?.includes('webtoons.com')
                            ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
                            : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'}
                    />
                </View>
            )}
        </View>
    );
}

const makeStyles = (c: AppColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    scrollBlock: { padding: 16 },
    header: { flexDirection: 'row', marginBottom: 20 },
    cover: { width: 120, height: 180, borderRadius: 8 },
    placeholder: { width: 120, height: 180, borderRadius: 8, backgroundColor: c.chipBg },
    headerTextContainer: { flex: 1, paddingLeft: 16, justifyContent: 'center' },
    title: { fontSize: 22, fontWeight: 'bold', color: c.text, marginBottom: 8 },
    metaTag: { fontSize: 11, color: c.textMuted, marginBottom: 2 },
    libraryBtn: { backgroundColor: c.success, paddingVertical: 10, borderRadius: 20, alignItems: 'center' },
    libraryBtnText: { color: '#fff', fontWeight: 'bold' },
    actionRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
    libraryBadge: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: c.surface, borderWidth: 1, borderColor: c.success,
        paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
        marginRight: 8,
    },
    libraryBadgeText: { color: c.success, fontWeight: '700', fontSize: 12, marginLeft: 4 },
    removeBtn: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
        borderWidth: 1, borderColor: c.border,
    },
    removeBtnText: { color: c.destructive, fontSize: 12, fontWeight: '600', marginLeft: 4 },
    desc: { fontSize: 13, color: c.textMuted, lineHeight: 20, marginBottom: 24 },
    chapterSection: { flex: 1 },
    chapterNavRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
    chapterSearchInput: {
        flex: 1, backgroundColor: c.inputBg, color: c.text,
        borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 13, marginRight: 8,
    },
    chapterNavBtn: {
        flexDirection: 'row', alignItems: 'center', backgroundColor: c.chipBg,
        borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9,
    },
    chapterNavBtnText: { color: c.text, fontSize: 12, fontWeight: '600', marginLeft: 5 },
    continueBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.accent, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, marginBottom: 12,
    },
    continueBtnText: { color: '#fff', fontSize: 13, fontWeight: '700', marginLeft: 6 },
    emptyChapters: { color: c.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 12 },
    chapterHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
    chapterHeader: { fontSize: 16, fontWeight: 'bold', color: c.text },
    headerActionBtn: { flexDirection: 'row', alignItems: 'center', marginLeft: 12 },
    headerActionText: { fontSize: 12, fontWeight: '600', marginLeft: 4 },
    downloadStatus: { fontSize: 12, color: c.accent, marginBottom: 8 },
    chapterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.border },
    chapterTitle: { fontSize: 14, color: c.accent, fontWeight: '600' },
    chapterDate: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    /* M2b: linked-source merge */
    mergingRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
    mergingText: { fontSize: 12, color: c.textMuted, marginLeft: 6 },
    sourceBadge: {
        marginLeft: 6, paddingHorizontal: 6, paddingVertical: 1,
        borderRadius: 8, backgroundColor: c.chipBg, borderWidth: 1, borderColor: c.border,
        maxWidth: 110,
    },
    sourceBadgeText: { fontSize: 10, color: c.textMuted, fontWeight: '600' },

    /* Editable meta (status, rating, notes) */
    metaBlock: { backgroundColor: c.surface, borderRadius: 12, padding: 14, marginBottom: 20, borderWidth: 1, borderColor: c.border },
    metaRow: { flexDirection: 'row', marginBottom: 14 },
    metaPill: {
        flex: 1,
        backgroundColor: c.chipBg,
        paddingVertical: 10, paddingHorizontal: 12,
        borderRadius: 10, marginRight: 8,
    },
    metaPillLabel: { color: c.textMuted, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
    metaPillValue: { color: c.text, fontSize: 13, fontWeight: '600', marginTop: 2 },
    metaLabel: { color: c.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 },
    notesInput: {
        backgroundColor: c.inputBg, color: c.text,
        borderRadius: 8, padding: 12, fontSize: 13,
        minHeight: 70, maxHeight: 140,
    },
    savingText: { color: c.textMuted, fontSize: 11, marginTop: 6, fontStyle: 'italic' },

    /* Linked sources */
    sourceChipRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2, paddingRight: 12, marginBottom: 14 },
    sourceChip: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: c.chipBg, borderRadius: 14,
        paddingHorizontal: 10, paddingVertical: 6, marginRight: 6,
        borderWidth: 1, borderColor: c.border,
    },
    sourceChipPrimary: { borderColor: c.accent },
    sourceChipText: { color: c.text, fontSize: 12, fontWeight: '600', maxWidth: 140 },
    sourceChipRemove: { marginLeft: 6, padding: 2 },
    sourceChipAdd: {
        flexDirection: 'row', alignItems: 'center',
        borderWidth: 1, borderColor: c.accent, borderStyle: 'dashed',
        borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6,
    },
    suggestChip: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: c.chipBg, borderRadius: 14,
        paddingHorizontal: 10, paddingVertical: 6, marginRight: 6,
        borderWidth: 1, borderColor: c.accent, borderStyle: 'dashed',
    },
    suggestLoading: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 },
    suggestLoadingText: { color: c.textMuted, fontSize: 12, marginLeft: 6 },

    /* Add-source modal */
    addSourceHelp: { color: c.textMuted, fontSize: 12, lineHeight: 18, marginBottom: 12 },
    addSourceInput: {
        backgroundColor: c.inputBg, color: c.text,
        borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13,
    },
    addSourceError: { color: c.destructive, fontSize: 12, marginTop: 8 },
    addSourceBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8, minWidth: 80, alignItems: 'center' },
    addSourceBtnText: { fontSize: 13, fontWeight: '700' },

    /* Status / rating modals */
    metaModalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    metaModalSheet: { backgroundColor: c.surfaceAlt, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 },
    metaModalHandle: { alignSelf: 'center', width: 36, height: 4, backgroundColor: c.border, borderRadius: 2, marginBottom: 12 },
    metaModalTitle: { color: c.text, fontSize: 16, fontWeight: 'bold', marginBottom: 12 },
    metaModalRow: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingVertical: 14, paddingHorizontal: 12,
        borderRadius: 8, marginBottom: 4,
    },
    metaModalRowActive: { backgroundColor: c.chipBg },
    metaModalRowText: { color: c.text, fontSize: 14, fontWeight: '500' },
});
