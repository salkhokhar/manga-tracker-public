import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, Image, ActivityIndicator, Dimensions, TouchableOpacity, Image as RNImage, RefreshControl, Animated, Pressable, useWindowDimensions, StatusBar } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { initDatabase, getLocalConfigs, updateLocalProgress, matchConfigToUrl } from '../services/database';
import { supabase, pushProgressToCloud } from '../services/supabase';
import { isChapterDownloaded, getLocalImageUris } from '../services/downloads';
import { getChapterCache, setChapterCache, findChapterIndex, sourceNameForUrl, nextFallbackSource } from '../services/chapterCache';
import { isSafeMangaUrl } from '../services/urlSafety';
import { parseWebViewMessage, isBoundedArray, clampString } from '../services/webviewMessage';
import { WEBVIEW_HARDENING_PROPS, webViewNavigationGate } from '../services/webviewSafety';

const READER_ALLOWED_TYPES: ReadonlySet<string> = new Set(['DEBUG', 'SHOW_WEBVIEW', 'BATCH_SUCCESS', 'SCRAPE_COMPLETE', 'CHAPTER_EMPTY']);
const MAX_READER_IMAGES = 2000;
// M2c: a chapter with zero images after this many non-Cloudflare sweep ticks
// (1 s each) is treated as unavailable: Asura Early Access pages and MangaRead
// "phantom" chapters both load fine but contain no chapter images.
const EMPTY_AFTER_TICKS = 15;
const FALLBACK_BANNER_MS = 5000;

/** Parses the `tried` route param (JSON string[] of chapter URLs already tried). */
function parseTriedParam(raw: unknown): string[] {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 20000) return [];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string').slice(0, 20) : [];
    } catch {
        return [];
    }
}

// Hosts that serve ad/tracker images. The chapter scraper sometimes picks these
// up from inline iframes or decoy <img> tags inside the reader container; they
// render as broken pages or wrong-aspect-ratio "garbage" in the reader.
const AD_HOST_BLACKLIST = [
    'pubadx.one',
    'pubfuture.com',          // referenced by KoS in Pubfuture_*.png filenames
    'a-ads.com',
    'ad.a-ads.com',
    'doubleclick.net',
    'googletagmanager.com',
    'googlesyndication.com',
    'rubiconproject.com',
    'onetag-sys.com',
    'ibb.co',                 // imgbb hosting — used as decoys on King of Shojo
    'imgbb.com',
    '7ad.org',                // ad iframe network seen on KoS chapters
];

export default function ReadScreen() {
    const { chapter_url, manga_title, chapter_title, manga_url, tried, fallback_from } = useLocalSearchParams();
    const router = useRouter();
    // useWindowDimensions auto-updates on rotation; screen Dimensions.get does not.
    const { width, height: screenHeight } = useWindowDimensions();
    
    const [images, setImages] = useState<any[]>([]);
    const [scraping, setScraping] = useState(true);
    const [config, setConfig] = useState<any>(null);
    const [debugLogs, setDebugLogs] = useState<string[]>([]);
    const [showWebView, setShowWebView] = useState(false);
    const [webViewUrl, setWebViewUrl] = useState(chapter_url as string);
    const [refreshing, setRefreshing] = useState(false);
    const [reloadCounter, setReloadCounter] = useState(0); // bumps to re-trigger the loader
    // M2c: empty-chapter fallback state
    const [emptyChapter, setEmptyChapter] = useState(false);
    const [bannerVisible, setBannerVisible] = useState(false);
    const imagesSeenRef = useRef(0);          // non-ad images received for this chapter
    const markedReadRef = useRef(false);      // progress written for this chapter
    const fallbackHandledRef = useRef(false); // empty -> fallback already decided

    // Controls overlay — fades in on tap, auto-hides after 3s
    const [controlsVisible, setControlsVisible] = useState(false);
    const controlsOpacity = useRef(new Animated.Value(0)).current;
    const hideTimerRef = useRef<any>(null);

    // Page counter — tracked via FlatList onViewableItemsChanged
    const [currentPage, setCurrentPage] = useState(1);

    // Chapter list (for prev/next navigation) — read from in-memory cache populated by Details
    const chapterList = useMemo(() => {
        const url = typeof manga_url === 'string' ? manga_url : '';
        return url ? (getChapterCache(url) || []) : [];
    }, [manga_url]);

    // Matches the row's own link OR one of its alternates, so prev/next still
    // work while reading a fallback source's copy of the chapter.
    const currentIndex = useMemo(() => {
        return findChapterIndex(chapterList, chapter_url);
    }, [chapterList, chapter_url]);
    const currentRow = currentIndex >= 0 ? chapterList[currentIndex] : null;
    const currentSiteName = useMemo(() => sourceNameForUrl(currentRow, chapter_url), [currentRow, chapter_url]);
    const triedList = useMemo(() => parseTriedParam(tried), [tried]);
    const fallbackFrom = typeof fallback_from === 'string' ? fallback_from : '';

    // Manga sites usually list chapters newest first, so "previous" reading-order = next index, "next" = previous index.
    // Sometimes the order is flipped, so we expose both directions and let the user decide visually.
    const hasPrev = currentIndex >= 0 && currentIndex < chapterList.length - 1;
    const hasNext = currentIndex > 0;
    const prevChapter = hasPrev ? chapterList[currentIndex + 1] : null;
    const nextChapter = hasNext ? chapterList[currentIndex - 1] : null;

    const handleRefresh = () => {
        setRefreshing(true);
        setEmptyChapter(false);
        fallbackHandledRef.current = false;
        imagesSeenRef.current = 0;
        setImages([]);
        setScraping(true);
        setReloadCounter(c => c + 1);
    };

    /* Controls overlay logic */
    const showControls = useCallback(() => {
        setControlsVisible(true);
        Animated.timing(controlsOpacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        hideTimerRef.current = setTimeout(() => {
            Animated.timing(controlsOpacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(({ finished }) => {
                if (finished) setControlsVisible(false);
            });
        }, 3000);
    }, [controlsOpacity]);

    const hideControls = useCallback(() => {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        Animated.timing(controlsOpacity, { toValue: 0, duration: 180, useNativeDriver: true }).start(({ finished }) => {
            if (finished) setControlsVisible(false);
        });
    }, [controlsOpacity]);

    const toggleControls = useCallback(() => {
        if (controlsVisible) hideControls();
        else showControls();
    }, [controlsVisible, showControls, hideControls]);

    useEffect(() => {
        return () => {
            if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        };
    }, []);

    /* Page counter — FlatList viewability tracking.
     * viewAreaCoveragePercentThreshold (not itemVisiblePercentThreshold) so
     * webtoon-style pages — a single image taller than the viewport (Asura's
     * 900x16000 chapters render ~7000px tall in a ~800px viewport) — count
     * as visible while they fill the screen. The "item visible %" metric
     * required 50% of the image itself to be on-screen, which a 7000px image
     * can never achieve, so the counter used to stick at the last short page
     * (typically page 2) for the whole scroll through the tall page.
     *
     * Picks the first (top-most) viewable item so the counter reflects the
     * page you're reading rather than the one barely peeking at the bottom. */
    const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 30 }).current;
    const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
        if (viewableItems && viewableItems.length > 0) {
            const firstVisible = viewableItems[0];
            if (typeof firstVisible.index === 'number') {
                setCurrentPage(firstVisible.index + 1);
            }
        }
    }).current;

    /* Chapter navigation */
    const goToChapter = (chapter: { link: string; title: string }) => {
        const url = typeof manga_url === 'string' ? manga_url : '';
        if (url) setChapterCache(url, chapterList);
        router.replace({
            pathname: '/read',
            params: {
                chapter_url: chapter.link,
                manga_title: manga_title as string,
                chapter_title: chapter.title,
                manga_url: url,
            },
        });
    };

    useEffect(() => {
        // CLEAN SLATE
        setImages([]);
        setScraping(true);
        setEmptyChapter(false);
        imagesSeenRef.current = 0;
        markedReadRef.current = false;
        fallbackHandledRef.current = false;
        setDebugLogs([]);
        setShowWebView(false);
        setWebViewUrl(chapter_url as string);
        // Warn loudly if a deep link delivered an unsafe chapter_url — the WebView
        // below will refuse to mount via the isSafeMangaUrl gate.
        if (chapter_url && !isSafeMangaUrl(chapter_url as string)) {
            console.warn(`[URL SAFETY] read.tsx refused to load unsafe chapter_url: ${String(chapter_url).substring(0, 120)}`);
        }

        // If this chapter is already downloaded, load local files instead of scraping.
        (async () => {
            try {
                const downloaded = await isChapterDownloaded(chapter_url as string);
                if (downloaded) {
                    const uris = await getLocalImageUris(chapter_url as string);
                    if (uris.length > 0) {
                        addLog(`Measuring ${uris.length} downloaded images...`);
                        // Image.getSize on file:// URIs gives us real intrinsic dimensions, so the
                        // renderer uses correct aspect ratios instead of falling back to 1.5 (which
                        // crops tall webtoon-style images badly).
                        const measured = await Promise.all(
                            uris.map(uri => new Promise<any>((resolve) => {
                                RNImage.getSize(
                                    uri,
                                    (w, h) => resolve({ url: uri, width: w, height: h, inContainer: true }),
                                    () => resolve({ url: uri, width: 0, height: 0, inContainer: true })
                                );
                            }))
                        );
                        addLog(`Loaded ${measured.length} downloaded images (offline)`);
                        imagesSeenRef.current = measured.length;
                        setImages(measured);
                        markReadOnce();
                        setScraping(false);
                        setRefreshing(false);
                        return; // skip the scraper entirely
                    }
                }
            } catch (e) {
                console.warn('[READER]: download check failed, falling back to scraper', e);
            }

            initDatabase().then(getLocalConfigs).then(configs => {
                const matched = matchConfigToUrl(configs, chapter_url as string);
                if (matched) {
                    setConfig(matched.json_rules);
                    addLog(`Matched config: ${matched.website_name}`);
                } else {
                    addLog(`No config matched. Falling back.`);
                    setScraping(false);
                }
            });
        })();
    }, [chapter_url, reloadCounter]);

    // "Reading from <site>" banner after an automatic source switch.
    useEffect(() => {
        if (!fallbackFrom) return;
        setBannerVisible(true);
        const t = setTimeout(() => setBannerVisible(false), FALLBACK_BANNER_MS);
        return () => clearTimeout(t);
    }, [chapter_url, fallbackFrom]);

    // M2c: progress is written once real chapter images arrive, not on open, so
    // a locked/phantom chapter that never loads isn't marked as read.
    const markReadOnce = () => {
        if (markedReadRef.current) return;
        markedReadRef.current = true;
        (async () => {
            try {
                const mTitle = typeof manga_title === 'string' ? manga_title : '';
                const cTitle = typeof chapter_title === 'string' ? chapter_title : 'Unknown Chapter';
                if (mTitle) {
                    const db = await initDatabase();
                    await updateLocalProgress(db, mTitle, cTitle);
                    const { data: { session } } = await supabase.auth.getSession();
                    if (session?.user) await pushProgressToCloud(session.user.id, mTitle, cTitle);
                }
            } catch (e) {
                console.warn('[READER]: progress save failed', e);
            }
        })();
    };

    // M2c: the chapter loaded but has no images (Asura Early Access, MangaRead
    // phantom). Switch to the same chapter on the next linked source that
    // hasn't been tried; when none is left, show a clear message instead of a
    // blank screen.
    const handleEmptyChapter = () => {
        if (fallbackHandledRef.current || imagesSeenRef.current > 0) return;
        fallbackHandledRef.current = true;
        const current = typeof chapter_url === 'string' ? chapter_url : '';
        const nowTried = current && triedList.indexOf(current) === -1 ? [...triedList, current] : triedList;
        const next = nextFallbackSource(currentRow, nowTried);
        if (next && isSafeMangaUrl(next.link)) {
            addLog(`No images on ${currentSiteName || 'this source'}, trying ${next.website_name || 'another source'}`);
            const url = typeof manga_url === 'string' ? manga_url : '';
            if (url) setChapterCache(url, chapterList);
            router.replace({
                pathname: '/read',
                params: {
                    chapter_url: next.link,
                    manga_title: manga_title as string,
                    chapter_title: chapter_title as string,
                    manga_url: url,
                    tried: JSON.stringify(nowTried),
                    fallback_from: currentSiteName || 'the first source',
                },
            });
            return;
        }
        addLog('No images found and no other source to try');
        setShowWebView(false);
        setScraping(false);
        setRefreshing(false);
        setEmptyChapter(true);
    };

    const addLog = (msg: string) => {
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] [SCRAPER DEBUG Read]:`, msg);
        setDebugLogs(prev => [...prev.slice(-8), `[${time}] ${msg}`]);
    };

    const INJECTED_JAVASCRIPT = config ? `
        (function() {
            let attempts = 0;
            const maxAttempts = 60; 
            const resultsMap = {};
            const currentUrl = window.location.href;
            let cleanTicks = 0;
            let emptyReported = false;

            function sendLog(msg) {
                const now = new Date().toLocaleTimeString();
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', message: '[' + now + '] ' + msg }));
            }

            const interval = setInterval(() => {
                attempts++;
                
                if (window.location.href !== currentUrl) {
                    clearInterval(interval);
                    return;
                }

                const docTitle = document.title;
                const html = document.documentElement.innerHTML;
                const isCloudflare = docTitle.includes('Just a moment') || html.includes('cf-challenge') || !!document.querySelector('#challenge-form');
                
                if (isCloudflare) {
                    sendLog('Cloudflare blocked the images. Waiting...');
                    const cfBtn = document.querySelector('input[type="checkbox"]');
                    if (cfBtn) cfBtn.click();
                    if (attempts > 5) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SHOW_WEBVIEW' }));
                    return;
                }

                // ── ONE-SHOT DIAGNOSTIC DUMP ───────────────────────────────────────
                // Runs once at attempt 3 to capture the actual DOM structure.
                // Posts back a compact JSON we can read in the terminal logs.
                // Development only: the published app skips it (page structure,
                // iframe and ad URLs serve no one outside a debugging session).
                if (${__DEV__ ? 'true' : 'false'} && attempts === 3) {
                    try {
                        const allImgs = Array.from(document.querySelectorAll('img'));
                        const allFrames = Array.from(document.querySelectorAll('iframe'));

                        const diag = {
                            url: window.location.href.substring(0, 120),
                            title: document.title.substring(0, 80),
                            htmlLen: html.length,
                            bodyLen: document.body ? document.body.innerHTML.length : 0,

                            iframes: allFrames.map(f => ({
                                src: (f.getAttribute('src') || '').substring(0, 80),
                                hasSrcdoc: f.hasAttribute('srcdoc'),
                                srcdocLen: (f.getAttribute('srcdoc') || '').length,
                                srcdocStart: (f.getAttribute('srcdoc') || '').substring(0, 120),
                                id: f.id || null,
                                cls: (f.className || '').substring(0, 40),
                                w: f.offsetWidth,
                                h: f.offsetHeight,
                            })),

                            containers: {
                                'reading-content': document.querySelectorAll('.reading-content').length,
                                'readerarea': document.querySelectorAll('#readerarea').length,
                                'chapter-content': document.querySelectorAll('.chapter-content').length,
                                'wp-manga-chapter-img': document.querySelectorAll('img.wp-manga-chapter-img').length,
                                'page-break': document.querySelectorAll('.page-break').length,
                                'no-gaps': document.querySelectorAll('.no-gaps').length,
                            },

                            imgCount: allImgs.length,
                            imgWithDataSrc: document.querySelectorAll('img[data-src]').length,
                            imgWithDataLazy: document.querySelectorAll('img[data-lazy-src]').length,

                            // Sample chapter images specifically (Madara theme uses .wp-manga-chapter-img).
                            // Falls back to first 5 images otherwise. Shows raw getAttribute values
                            // (not img.src property) so we can see leading whitespace.
                            imgSample: (function() {
                                const chapterImgs = document.querySelectorAll('img.wp-manga-chapter-img, .reading-content img, #readerarea img, .page-break img');
                                const pool = chapterImgs.length > 0 ? Array.from(chapterImgs).slice(0, 4) : allImgs.slice(0, 4);
                                return pool.map(img => ({
                                    attrs: img.getAttributeNames().join(','),
                                    rawSrc: JSON.stringify((img.getAttribute('src') || '')).substring(0, 100),
                                    rawDataSrc: JSON.stringify((img.getAttribute('data-src') || '')).substring(0, 100),
                                    rawDataLazy: JSON.stringify((img.getAttribute('data-lazy-src') || '')).substring(0, 80),
                                    rawDataOriginal: JSON.stringify((img.getAttribute('data-original') || '')).substring(0, 80),
                                    propSrc: (img.src || '').substring(0, 80),
                                    nW: img.naturalWidth,
                                    nH: img.naturalHeight,
                                    parent: img.parentElement ? img.parentElement.tagName + '.' + (img.parentElement.className || '').substring(0, 30) : null,
                                }));
                            })(),
                        };

                        // Post in chunks if too large
                        const json = JSON.stringify(diag);
                        const chunkSize = 1200;
                        for (let i = 0; i < json.length; i += chunkSize) {
                            sendLog('DIAG[' + Math.floor(i/chunkSize) + ']: ' + json.substring(i, i + chunkSize));
                        }
                    } catch (e) {
                        sendLog('DIAG ERROR: ' + e.message);
                    }
                }
                // ── END DIAGNOSTIC ─────────────────────────────────────────────────

                cleanTicks++;
                window.scrollBy(0, 3000);

                // Force Madara/lazy-loaded images to fetch — sets src from data-src so naturalHeight populates.
                // Madara sites often pad these attributes with leading whitespace, so trim first.
                document.querySelectorAll('img[data-src], img[data-lazy-src], img[data-original]').forEach(img => {
                    let lazySrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
                    if (lazySrc) lazySrc = lazySrc.trim();
                    if (lazySrc && lazySrc.startsWith('http')) {
                        if (!img.src || img.src === window.location.href || img.src.includes('spinner') || img.src.includes('placeholder') || img.src.includes('loading') || img.naturalWidth === 0) {
                            img.src = lazySrc;
                        }
                    }
                });

                const container = document.querySelector('.reading-content, #readerarea, .vimport-container, .container-chapter-reader, [class*="chapter-video-frame"], .chapter-content, #_imageList');
                const imgNodes = document.querySelectorAll('img');
                const updatedBatch = [];

                imgNodes.forEach(img => {
                    let imgSrc = '';
                    const attrs = img.getAttributeNames();
                    for (let attr of attrs) {
                        let val = img.getAttribute(attr);
                        // MangaClash and other Madara sites pad data-src/src with leading whitespace (\\t\\t\\n).
                        // Trim before any URL check or every chapter image gets dropped.
                        if (val) val = val.trim();
                        if (val && val.startsWith('//')) val = window.location.protocol + val;
                        // Accept either an http(s) URL or a data:image/... URI. The latter
                        // is needed for sites like Gourmet Scans that inline every chapter
                        // page as base64 instead of serving it from a CDN. We let the
                        // container/size check below drop data: URIs that are tiny
                        // placeholders rather than real chapter content.
                        const isHttp = val && val.startsWith('http') && !val.includes('logo') && !val.includes('avatar') && !val.includes('icon');
                        const isDataImage = val && val.startsWith('data:image/');
                        if (isHttp || isDataImage) {
                            if (attr.includes('src') || attr.includes('lazy') || (val && val.match(/\\.(jpg|jpeg|png|webp|avif)/i)) || isDataImage) {
                                if (!imgSrc || attr !== 'src') imgSrc = val;
                            }
                        }
                    }

                    if (imgSrc) {
                        const h = img.naturalHeight || 0;
                        const w = img.naturalWidth || 0;
                        // Asura's React/Astro reader doesn't use any Madara container.
                        // Every legitimate chapter <img> there carries data-page-index;
                        // comment/profile-pic decoys do not. Host-gated so the attribute
                        // doesn't false-positive on other sites that may use it for
                        // carousels, gallery widgets, etc.
                        const isAsuraHost = /asurascans\\.com|asuracomic\\.net/i.test(window.location.hostname);
                        const isInsideReader = !!(container && container.contains(img))
                            || (isAsuraHost && img.hasAttribute('data-page-index'));
                        // On Asura that attribute is the whole truth: anything without
                        // it (covers, avatars, recommendations) is not a chapter page,
                        // even while still unloaded (h === 0).
                        if (isAsuraHost && !isInsideReader) return;
                        // Asura file names are random hashes, so the page index is the
                        // only reliable order (the RN side sorts by it when present).
                        const rawIdx = isAsuraHost ? parseInt(img.getAttribute('data-page-index') || '', 10) : NaN;

                        if (isInsideReader || h >= 800 || h === 0) {
                            if (!resultsMap[imgSrc] || (resultsMap[imgSrc].height <= 1 && h > 1)) {
                                const item = { url: imgSrc, width: w, height: h, inContainer: isInsideReader };
                                if (rawIdx >= 0) item.pageIndex = rawIdx;
                                resultsMap[imgSrc] = item;
                                updatedBatch.push(item);
                                if (h > 1) sendLog("[FOUND]: " + imgSrc.split('/').pop() + " | " + w + "x" + h + " | Container: " + isInsideReader);
                            }
                        }
                    }
                });

                // Madara sites (MangaRead, MangaClash) load chapter images inside <iframe srcdoc="...">
                // The parent frame can never read naturalHeight from inside a srcdoc iframe,
                // so we parse the srcdoc attribute as a string directly instead.
                document.querySelectorAll('iframe[srcdoc]').forEach(iframe => {
                    try {
                        const srcdocHtml = iframe.getAttribute('srcdoc');
                        if (!srcdocHtml) return;
                        const parser = new DOMParser();
                        const iframeDoc = parser.parseFromString(srcdocHtml, 'text/html');
                        iframeDoc.querySelectorAll('img').forEach(img => {
                            const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
                            if (src && src.startsWith('http') && !src.includes('logo') && !src.includes('avatar') && !src.includes('icon')) {
                                if (!resultsMap[src]) {
                                    const item = { url: src, width: 0, height: 0, inContainer: true };
                                    resultsMap[src] = item;
                                    updatedBatch.push(item);
                                    sendLog('[SRCDOC]: ' + src.split('/').pop());
                                }
                            }
                        });
                    } catch(e) {}
                });

                if (updatedBatch.length > 0) {
                    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BATCH_SUCCESS', images: updatedBatch, forUrl: currentUrl }));
                }

                const totalFound = Object.keys(resultsMap).length;
                const totalSized = Object.values(resultsMap).filter(v => v.height > 1).length;
                if (attempts % 4 === 0) { sendLog('Sweep Status: ' + totalSized + ' sized / ' + totalFound + ' found'); }

                // M2c: page loaded (not a Cloudflare interstitial) but no chapter
                // images at all: locked / phantom chapter. Reported once; the
                // sweep keeps running in case RN decides to stay on this page.
                if (!emptyReported && cleanTicks >= ${EMPTY_AFTER_TICKS} && totalFound === 0) {
                    emptyReported = true;
                    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CHAPTER_EMPTY', forUrl: currentUrl }));
                }

                if (attempts >= maxAttempts) {
                    clearInterval(interval);
                    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SCRAPE_COMPLETE' }));
                }
            }, 1000);
        })();
        true;
    ` : '';

    const handleMessage = (event: any) => {
        const time = new Date().toLocaleTimeString();
        const payload = parseWebViewMessage(event.nativeEvent.data, READER_ALLOWED_TYPES, 'READER');
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
            if (payload.type === 'BATCH_SUCCESS') {
                if (payload.forUrl !== chapter_url) return;
                if (!isBoundedArray(payload.images, MAX_READER_IMAGES)) {
                    console.warn(`[${time}] [READER]: BATCH_SUCCESS rejected — images missing/oversized`);
                    return;
                }
                // Reject items that aren't well-formed image records. Each must
                // be an object with a non-empty string `url`. No length cap —
                // Gourmet Scans' base64-inlined chapter pages are ~300–500 KB
                // each and a per-URL cap would silently drop every page. The
                // outer 32 MB payload cap is the OOM safety net.
                const safeIncoming = (payload.images as unknown[]).filter(
                    (img): img is { url: string; width?: number; height?: number; inContainer?: boolean } => {
                        if (!img || typeof img !== 'object') return false;
                        const u = (img as any).url;
                        return typeof u === 'string' && u.length > 0;
                    }
                );
                console.log(`[${time}] [READER DATA]: Batch arrived`);
                const realCount = safeIncoming.filter(img => !AD_HOST_BLACKLIST.some(h => img.url.includes(h))).length;
                if (realCount > 0) {
                    imagesSeenRef.current += realCount;
                    setEmptyChapter(false);
                    markReadOnce();
                }

                setImages(prev => {
                    const combined = [...prev];
                    safeIncoming.forEach((newImg: any) => {
                        const idx = combined.findIndex(t => t.url === newImg.url);
                        if (idx > -1) {
                            if (combined[idx].height <= 1 && newImg.height > 1) {
                                combined[idx] = newImg;
                            }
                        } else {
                            combined.push(newImg);
                        }
                    });

                    // Drop ad URLs the scraper accidentally pulls in (a-ads, pubadx, etc.).
                    // These render as blank pages because they're not real chapter art.
                    const isAdUrl = (u: string) => !!u && AD_HOST_BLACKLIST.some(h => u.includes(h));

                    const filtered = combined.filter((img) => {
                        if (isAdUrl(img.url)) return false;
                        if (img.inContainer) return !!img.url; // includes srcdoc-extracted and lazy-loaded container images
                        if (img.height > 1 && img.width > 0) return img.height >= 2.5 * img.width;
                        return img.height === 0; // keep unloaded non-container images (e.g. MangaClash srcdoc-adjacent)
                    });

                    // Sort by the page number embedded in the filename so chapters
                    // display in order regardless of which image the browser finished
                    // loading first. Pulls the last digit run that sits immediately
                    // before the file extension: foo/01.webp → 1, _00.jpg → 0,
                    // page-3.jpg → 3. Falls back to original order for URLs without
                    // a numeric suffix (e.g. data: URIs from Gourmet — those stay
                    // in load order, which on Gourmet matches DOM order anyway).
                    // An explicit pageIndex from the site (Asura's data-page-index,
                    // where file names are random hashes) wins over the file name.
                    const pageOrder = (img: any): number => {
                        if (Number.isInteger(img.pageIndex) && img.pageIndex >= 0) return img.pageIndex;
                        const url = img.url;
                        if (!url || url.startsWith('data:')) return Number.MAX_SAFE_INTEGER;
                        const m = url.match(/(\d+)(?=\.[a-z]+(?:[?#]|$))/i);
                        return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
                    };
                    return filtered
                        .map((img, idx) => ({ img, idx, order: pageOrder(img) }))
                        .sort((a, b) => a.order !== b.order ? a.order - b.order : a.idx - b.idx)
                        .map(x => x.img);
                });
                setScraping(false);
                setRefreshing(false);
            }
            if (payload.type === 'CHAPTER_EMPTY') {
                if (payload.forUrl !== chapter_url) return;
                handleEmptyChapter();
                return;
            }
            if (payload.type === 'SCRAPE_COMPLETE') {
                setShowWebView(false);
                setScraping(false);
                setRefreshing(false);
                addLog("Sweep complete.");
                if (imagesSeenRef.current === 0) handleEmptyChapter();
            }
        } catch (e) {
            console.error(`[${time}] [READER ERROR]:`, e);
        }
    };

    const getHeaders = (url: string) => {
        // Many manga CDNs hotlink-protect images. We need to send a Referer matching
        // the origin site so the CDN serves the image instead of returning 403.
        if (url.includes('pstatic.net') || url.includes('webtoons.com')) {
            return { Referer: 'https://www.webtoons.com/' };
        }
        if (url.includes('tnlycdn.com') || url.includes('toonily.com')) {
            return { Referer: 'https://toonily.com/' };
        }
        if (url.includes('mangaclash.com') || url.includes('toonclash.com')) {
            return { Referer: 'https://mangaclash.com/' };
        }
        if (url.includes('asurascans.com') || url.includes('asuracomic.net')) {
            return { Referer: 'https://asurascans.com/' };
        }
        return undefined;
    };

    return (
        <View style={styles.container}>
            {/* Hide the iOS status bar so the first manga page sits flush at the top —
                the dark gap users were seeing was the safe area below the notch. */}
            <StatusBar hidden={!controlsVisible} />
            {bannerVisible && fallbackFrom ? (
                <View style={styles.fallbackBanner} pointerEvents="none">
                    <Text style={styles.fallbackBannerText} numberOfLines={2}>
                        Not available on {fallbackFrom}. Reading from {currentSiteName || 'another source'}.
                    </Text>
                </View>
            ) : null}
            {emptyChapter && images.length === 0 ? (
                <View style={styles.centerBox}>
                    <Ionicons name="lock-closed-outline" size={40} color="#888" />
                    <Text style={styles.emptyTitle}>Chapter not available yet</Text>
                    <Text style={styles.emptyText}>
                        {currentSiteName ? `${currentSiteName} has no pages for this chapter` : 'This source has no pages for this chapter'}
                        {triedList.length > 0 ? ', and no other linked source had it either.' : '. It may still be locked or not uploaded yet.'}
                    </Text>
                    <View style={{ flexDirection: 'row', marginTop: 20 }}>
                        <TouchableOpacity onPress={handleRefresh} style={[styles.emptyBtn, { backgroundColor: '#E15053' }]}>
                            <Text style={styles.emptyBtnText}>Retry</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => router.back()} style={[styles.emptyBtn, { backgroundColor: '#333', marginLeft: 10 }]}>
                            <Text style={styles.emptyBtnText}>Back</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            ) : scraping && images.length === 0 ? (
                <View style={styles.centerBox}>
                    <ActivityIndicator size="large" color="#E15053" />
                    <Text style={styles.subtext}>Starting stream...</Text>
                    {debugLogs.map((l, i) => (
                        <Text key={i} style={{ color: '#00FF00', fontSize: 10, fontFamily: 'monospace', marginTop: 5 }}>{l}</Text>
                    ))}
                </View>
            ) : (
                <FlatList
                    data={images}
                    keyExtractor={(item, idx) => item.url + idx}
                    renderItem={({ item, index }) => {
                        const ratio = (item.height > 0 && item.width > 0) ? item.height / item.width : 1.5;
                        const finalRatio = isNaN(ratio) || ratio <= 0.1 || !isFinite(ratio) ? 1.5 : ratio;
                        // iOS's image fetcher re-encodes already-encoded URLs: %5B becomes
                        // %255B, breaking any URL the scraper extracted with mixed encoding.
                        // Decoding the URL first lets iOS encode it once, correctly.
                        let fetchUrl = item.url;
                        try { fetchUrl = decodeURI(item.url); } catch { /* keep original */ }
                        return (
                            <Pressable onPress={toggleControls}>
                                <Image
                                    source={{ uri: fetchUrl, headers: getHeaders(item.url) }}
                                    style={{ width, height: width * finalRatio, backgroundColor: '#111' }}
                                    resizeMode="cover"
                                    onError={(e) => {
                                        const t = new Date().toLocaleTimeString();
                                        console.warn(`[${t}] [READER IMG FAIL] page=${index + 1}/${images.length} url=${item.url} err=${e.nativeEvent?.error || 'unknown'}`);
                                    }}
                                />
                            </Pressable>
                        );
                    }}
                    removeClippedSubviews={true}
                    maxToRenderPerBatch={3}
                    windowSize={5}
                    onViewableItemsChanged={onViewableItemsChanged}
                    viewabilityConfig={viewabilityConfig}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={handleRefresh}
                            tintColor="#E15053"
                            colors={['#E15053']}
                        />
                    }
                />
            )}

            {/* Controls overlay — top + bottom bars, fade in on tap, auto-hide after 3s */}
            {controlsVisible && (
                <>
                    <Animated.View style={[styles.topBar, { opacity: controlsOpacity, paddingTop: 44 }]} pointerEvents="box-none">
                        <TouchableOpacity onPress={() => router.back()} style={styles.topBarBtn} hitSlop={10}>
                            <Ionicons name="chevron-back" size={26} color="#FFF" />
                        </TouchableOpacity>
                        <View style={{ flex: 1, paddingHorizontal: 8 }}>
                            <Text style={styles.topBarTitle} numberOfLines={1}>{manga_title}</Text>
                            <Text style={styles.topBarSubtitle} numberOfLines={1}>{chapter_title}</Text>
                        </View>
                        {images.length > 0 && (
                            <Text style={styles.pageCounter}>{currentPage} / {images.length}</Text>
                        )}
                    </Animated.View>

                    <Animated.View style={[styles.bottomBar, { opacity: controlsOpacity }]} pointerEvents="box-none">
                        <TouchableOpacity
                            style={[styles.chapterNavBtn, !hasPrev && styles.chapterNavBtnDisabled]}
                            onPress={() => prevChapter && goToChapter(prevChapter)}
                            disabled={!hasPrev}
                            activeOpacity={0.7}
                        >
                            <Ionicons name="chevron-back" size={20} color={hasPrev ? '#FFF' : '#666'} />
                            <Text style={[styles.chapterNavText, !hasPrev && { color: '#666' }]}>Previous</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.chapterNavBtn, !hasNext && styles.chapterNavBtnDisabled]}
                            onPress={() => nextChapter && goToChapter(nextChapter)}
                            disabled={!hasNext}
                            activeOpacity={0.7}
                        >
                            <Text style={[styles.chapterNavText, !hasNext && { color: '#666' }]}>Next</Text>
                            <Ionicons name="chevron-forward" size={20} color={hasNext ? '#FFF' : '#666'} />
                        </TouchableOpacity>
                    </Animated.View>
                </>
            )}

            {config && isSafeMangaUrl(webViewUrl) && (
                <View style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                    zIndex: showWebView ? 100 : -1,
                    opacity: showWebView ? 1.0 : 0.01,
                    backgroundColor: '#FFF'
                }} pointerEvents={showWebView ? 'auto' : 'none'}>
                    {showWebView && (
                        <View style={{ padding: 12, backgroundColor: '#1E1E20', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 12 }}>Security Check</Text>
                            <TouchableOpacity onPress={() => setWebViewUrl(chapter_url + '?t=' + Date.now())} style={{ backgroundColor: '#E15053', padding: 8, borderRadius: 6 }}>
                                <Text style={{ color: '#fff', fontSize: 11, fontWeight: 'bold' }}>Reload</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                    <WebView
                        key={`${chapter_url}-${reloadCounter}`}
                        source={{ uri: webViewUrl }}
                        injectedJavaScript={INJECTED_JAVASCRIPT}
                        onMessage={handleMessage}
                        javaScriptEnabled={true}
                        domStorageEnabled={true}
                        {...WEBVIEW_HARDENING_PROPS}
                        onShouldStartLoadWithRequest={webViewNavigationGate}
                        userAgent={(chapter_url as string)?.includes('webtoons.com')
                            ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
                            : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'}
                    />
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000' },
    centerBox: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    subtext: { color: '#888', marginTop: 12, fontSize: 13 },

    /* M2c: empty chapter + fallback banner */
    emptyTitle: { color: '#FFF', fontSize: 16, fontWeight: '700', marginTop: 12 },
    emptyText: { color: '#AAA', fontSize: 13, marginTop: 6, textAlign: 'center', paddingHorizontal: 32, lineHeight: 19 },
    emptyBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
    emptyBtnText: { color: '#FFF', fontWeight: '700', fontSize: 13 },
    fallbackBanner: {
        position: 'absolute', top: 44, left: 16, right: 16, zIndex: 60,
        backgroundColor: 'rgba(30,30,32,0.92)', borderRadius: 10,
        paddingHorizontal: 12, paddingVertical: 8,
    },
    fallbackBannerText: { color: '#FFF', fontSize: 12, textAlign: 'center' },

    /* Controls overlay */
    topBar: {
        position: 'absolute', top: 0, left: 0, right: 0,
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 12, paddingBottom: 12,
        backgroundColor: 'rgba(0,0,0,0.75)',
        zIndex: 50,
    },
    topBarBtn: { padding: 6 },
    topBarTitle: { color: '#FFF', fontSize: 14, fontWeight: '700' },
    topBarSubtitle: { color: '#CCC', fontSize: 12, marginTop: 2 },
    pageCounter: { color: '#FFF', fontSize: 13, fontWeight: '600', backgroundColor: 'rgba(255,255,255,0.15)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },

    bottomBar: {
        position: 'absolute', bottom: 0, left: 0, right: 0,
        flexDirection: 'row', justifyContent: 'space-between',
        paddingHorizontal: 16, paddingTop: 14, paddingBottom: 34,
        backgroundColor: 'rgba(0,0,0,0.75)',
        zIndex: 50,
    },
    chapterNavBtn: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.15)',
        paddingHorizontal: 14, paddingVertical: 10, borderRadius: 22,
    },
    chapterNavBtnDisabled: { backgroundColor: 'rgba(255,255,255,0.06)' },
    chapterNavText: { color: '#FFF', fontWeight: '600', fontSize: 13, marginHorizontal: 4 },
});
