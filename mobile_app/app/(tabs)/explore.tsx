import React, { useState, useEffect, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, TouchableOpacity, Image, TextInput, ScrollView, Pressable, Modal, RefreshControl, Share, Alert } from 'react-native';
import { WebView } from 'react-native-webview';
import { useRouter } from 'expo-router';
import { initDatabase, getLocalConfigs, getSetting, getLocalLibrary, matchConfigToUrlStrict } from '../../services/database';
import { isSafeMangaUrl } from '../../services/urlSafety';
import { parseWebViewMessage, isBoundedArray, clampString } from '../../services/webviewMessage';
import { WEBVIEW_HARDENING_PROPS, webViewNavigationGate } from '../../services/webviewSafety';
import { isChapterDowngrade, isNewerChapter } from '../../services/chapterNumber';
import { getPageMarkers, resolveLatestWithPages } from '../../services/chapterPages';
import { isoMinute } from '../../services/latestDate';

const EXPLORE_ALLOWED_TYPES: ReadonlySet<string> = new Set([
    'DEBUG', 'SHOW_WEBVIEW', 'HIDE_WEBVIEW',
    'AUTOCOMPLETE', 'AUTOCOMPLETE_ERROR',
    'SUCCESS', 'ERROR',
]);
const MAX_EXPLORE_RESULTS = 2000;
import { useAppTheme, AppColors } from '../../services/theme';
import { Ionicons } from '@expo/vector-icons';
import { supabase, pushAddToCloud, pushLinkedSourcesToCloud } from '../../services/supabase';
import { findSameSeries } from '../../services/libraryMatch';
import { addLinkedSource } from '../../services/linkedSources';
import { extractHost } from '../../services/sourceDiscovery';

// Append (or update) ?page=N to a URL. Most manga sites accept this query param even when their
// "natural" pagination uses /page/N/ in the path — the query form usually still works as a fallback.
const buildPageUrl = (baseUrl: string, page: number): string => {
    if (page <= 1 || !baseUrl) return baseUrl;
    try {
        const u = new URL(baseUrl);
        u.searchParams.set('page', String(page));
        return u.toString();
    } catch {
        const sep = baseUrl.includes('?') ? '&' : '?';
        return `${baseUrl}${sep}page=${page}`;
    }
};

// Many manga CDNs hotlink-protect images. Match Referer to the origin site.
const getHeaders = (url: string) => {
    if (!url) return undefined;
    if (url.includes('webtoons.com') || url.includes('pstatic.net')) return { Referer: 'https://www.webtoons.com/' };
    if (url.includes('tnlycdn.com') || url.includes('toonily.com')) return { Referer: 'https://toonily.com/' };
    if (url.includes('mangaclash.com') || url.includes('toonclash.com')) return { Referer: 'https://mangaclash.com/' };
    if (url.includes('asurascans.com') || url.includes('asuracomic.net')) return { Referer: 'https://asurascans.com/' };
    return undefined;
};

// Filter helpers — decompose the flat explore_categories list into three independent axes:
// primary type ("Manhwa"), genre ("Action"), and sort ("Newest"). The convention is that
// AsuraScans-style configs encode genre after a " - " separator: "Manhwa - Action".
// Sites without that separator simply have no genre axis (only type + sort).
const splitType = (typeStr: string) => {
    const parts = (typeStr || '').split(' - ');
    return { primary: (parts[0] || '').trim(), secondary: (parts[1] || '').trim() };
};

const getPrimaryTypes = (cfg: any): string[] => {
    const cats = cfg?.json_rules?.explore_categories || [];
    const seen = new Set<string>();
    const result: string[] = [];
    cats.forEach((c: any) => {
        const p = splitType(c.type).primary;
        if (p && !seen.has(p)) { seen.add(p); result.push(p); }
    });
    return result;
};

const getGenresForType = (cfg: any, primary: string): string[] => {
    const cats = cfg?.json_rules?.explore_categories || [];
    const seen = new Set<string>();
    const result: string[] = [];
    cats.forEach((c: any) => {
        const s = splitType(c.type);
        if (s.primary === primary && !seen.has(s.secondary)) {
            seen.add(s.secondary);
            result.push(s.secondary);
        }
    });
    return result; // includes '' for "no genre filter"
};

const getCategoryByTypeGenre = (cfg: any, primary: string, genre: string) => {
    const cats = cfg?.json_rules?.explore_categories || [];
    return cats.find((c: any) => {
        const s = splitType(c.type);
        return s.primary === primary && s.secondary === genre;
    });
};

const getCategoryUrl = (cfg: any, primary: string, genre: string, sort: string): string => {
    const cat = getCategoryByTypeGenre(cfg, primary, genre);
    if (!cat?.urls) return '';
    return cat.urls[sort] || cat.urls[Object.keys(cat.urls)[0]] || '';
};

// Display helpers
const displayLabel = (s: string) => {
    if (!s) return 'All';
    // Title-case fully-lowercase strings (mangaread.org uses lowercase: 'manhwa' → 'Manhwa').
    // Leaves CamelCase alone ("MangaToon" stays "MangaToon").
    if (s === s.toLowerCase()) {
        return s.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
    return s;
};

const ExploreCard = ({ item, onLongPress }: { item: any; onLongPress?: () => void }) => {
    const router = useRouter();
    const { colors } = useAppTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    return (
        <TouchableOpacity
            style={styles.card}
            onPress={() => {
                const time = new Date().toLocaleTimeString();
                console.log(`[${time}] [USER CLICK]: Tapped explore comic "${item.title}"`);
                router.push({ pathname: '/details', params: { title: item.title, cover_url: item.image, manga_url: item.link } });
            }}
            onLongPress={onLongPress}
            delayLongPress={350}
        >
            <Image
                source={{ uri: item.image, headers: getHeaders(item.image) }}
                style={styles.cover}
                resizeMode="cover"
                onError={(e) => {
                    const t = new Date().toLocaleTimeString();
                    console.warn(`[${t}] [IMG FAIL]: "${item.title}" → ${item.image} | ${e.nativeEvent?.error || 'unknown'}`);
                }}
            />
            <View style={styles.content}>
                <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
                <Text style={styles.chapter}>{item.latest_chapter}</Text>
            </View>
        </TouchableOpacity>
    );
};

const SuggestionRow = ({ item, onPress }: { item: any, onPress: () => void }) => {
    const { colors } = useAppTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    return (
        <TouchableOpacity style={styles.suggestionRow} onPress={onPress}>
            {item.image ? (
                <Image source={{ uri: item.image, headers: getHeaders(item.image) }} style={styles.suggestionImage} />
            ) : (
                <View style={[styles.suggestionImage, styles.suggestionImagePlaceholder]} />
            )}
            <View style={styles.suggestionTextBox}>
                <Text style={styles.suggestionTitle} numberOfLines={2}>{item.title}</Text>
                {item.type ? <Text style={styles.suggestionMeta}>{item.type}</Text> : null}
            </View>
        </TouchableOpacity>
    );
};

export default function ExploreScreen() {
    const router = useRouter();
    const { colors } = useAppTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [scraping, setScraping] = useState(true);
    const [scrapedData, setScrapedData] = useState<any[]>([]);
    const [configs, setConfigs] = useState<any[]>([]);
    const [selectedConfig, setSelectedConfig] = useState<any>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchInput, setSearchInput] = useState("");
    const [currentUrl, setCurrentUrl] = useState("");
    const [showWebView, setShowWebView] = useState(false);

    // Filter state — three independent axes derived from the scraper config when source changes
    const [selectedPrimary, setSelectedPrimary] = useState<string>('');
    const [selectedGenre, setSelectedGenre] = useState<string>('');
    const [selectedSort, setSelectedSort] = useState<string>('');
    // User's preferred default type from Profile → Defaults. Applied each time a source
    // is loaded if that source's primary type list includes it; falls back to first type
    // otherwise. Stored as a ref so applyConfig can read the latest value without becoming
    // re-render-bound.
    const defaultExploreTypeRef = useRef<string>('');

    // Autocomplete state
    const [suggestions, setSuggestions] = useState<any[]>([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [autocompleteFetching, setAutocompleteFetching] = useState(false);
    const debounceTimerRef = useRef<any>(null);
    const lastQueryRef = useRef<string>('');
    const webViewRef = useRef<WebView<{}>>(null);

    // Modal state
    const [sourceModalOpen, setSourceModalOpen] = useState(false);
    const [filterModalOpen, setFilterModalOpen] = useState(false);
    const [actionMenuItem, setActionMenuItem] = useState<any | null>(null);
    const [libraryUrls, setLibraryUrls] = useState<Set<string>>(new Set());

    // Refresh the set of in-library URLs each time Explore is focused, so the action menu
    // can show the right options ("Add to library" vs "Already in library").
    useEffect(() => {
        (async () => {
            try {
                const db = await initDatabase();
                const all: any[] = await getLocalLibrary(db);
                setLibraryUrls(new Set(all.map(m => m.manga_url).filter(Boolean)));
            } catch (e) { /* ignore */ }
        })();
    }, [actionMenuItem]); // re-fetch when sheet opens, so add-to-library reflects fresh state

    // The same series from another site is linked to the existing entry
    // (services/libraryMatch.ts) instead of becoming a second one.
    const linkToExisting = async (existing: any, urlStr: string) => {
        try {
            const db = await initDatabase();
            const websiteName = matchConfigToUrlStrict(configs, urlStr)?.website_name || extractHost(urlStr);
            const updated = await addLinkedSource(db, existing.manga_url, {
                website_name: websiteName,
                manga_url: urlStr,
                added_at: new Date().toISOString(),
            });
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user) await pushLinkedSourcesToCloud(session.user.id, existing.title, updated);
            setLibraryUrls(prev => new Set([...prev, urlStr]));
            Alert.alert('Linked', `${websiteName} is now another source of "${existing.title}".`);
        } catch (e: any) {
            console.warn('[EXPLORE]: link to existing failed', e.message || e);
            Alert.alert('Could not link', e.message || 'Unknown error');
        }
    };

    const handleAddToLibraryFromExplore = async (item: any) => {
        const titleStr = item.title || '';
        const urlStr = item.link || '';
        if (!titleStr) return;
        let existing: any = null;
        try {
            const db = await initDatabase();
            existing = findSameSeries((await getLocalLibrary(db)) as any[], titleStr, urlStr);
        } catch (e) { /* no match check: add as before */ }
        if (!existing) {
            await insertIntoLibrary(item);
            return;
        }
        const from = matchConfigToUrlStrict(configs, existing.manga_url)?.website_name || extractHost(existing.manga_url || '');
        Alert.alert(
            'Already in your library',
            `"${existing.title}" is in your library from ${from}. Link this site as another source of it, or add it as a separate comic?`,
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Add separately', onPress: () => { insertIntoLibrary(item); } },
                { text: 'Link as source', onPress: () => { linkToExisting(existing, urlStr); } },
            ],
        );
    };

    const insertIntoLibrary = async (item: any) => {
        const titleStr = item.title || '';
        const urlStr = item.link || '';
        const coverStr = item.image || '';
        try {
            const db = await initDatabase();
            await db.runAsync(`
                INSERT OR REPLACE INTO manga (title, manga_url, cover_url, chapter, latest_chapter, category, last_read_date)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [titleStr, urlStr, coverStr, 'Chapter 0', item.latest_chapter || 'Unknown', 'Reading', new Date().toISOString().split('T')[0]]);
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user) {
                await pushAddToCloud(session.user.id, {
                    title: titleStr, manga_url: urlStr, cover_url: coverStr,
                    chapter: 'Chapter 0', latest_chapter: item.latest_chapter || 'Unknown', category: 'Reading',
                });
            }
            setLibraryUrls(prev => new Set([...prev, urlStr]));
        } catch (e: any) {
            console.warn('[EXPLORE]: addToLibrary failed', e.message || e);
        }
    };

    const handleShareFromExplore = async (item: any) => {
        try {
            await Share.share({
                message: item.link ? `Check out "${item.title}": ${item.link}` : `Check out "${item.title}"`,
                url: item.link || undefined,
                title: item.title,
            });
        } catch (e) { /* user-cancelled — ignore */ }
    };

    // Pagination + pull-to-refresh state
    const [currentPage, setCurrentPage] = useState(1);
    const [appendingPage, setAppendingPage] = useState(false);
    const [hasMorePages, setHasMorePages] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadAttempt, setLoadAttempt] = useState(0); // increments to force WebView remount on refresh
    // Keep the unpaginated base URL around so loadNextPage / handleRefresh can derive page-N variants
    const baseUrlRef = useRef<string>('');

    useEffect(() => {
        (async () => {
            const db = await initDatabase();
            const fetchedConfigs = await getLocalConfigs(db);
            if (!fetchedConfigs || fetchedConfigs.length === 0) {
                setScraping(false);
                return;
            }
            setConfigs(fetchedConfigs);

            // Honor user defaults from Profile → Defaults
            const defaultSource = await getSetting(db, 'default_source', '');
            const defaultSort = await getSetting(db, 'default_sort', '');
            const defaultType = await getSetting(db, 'default_explore_type', '');
            defaultExploreTypeRef.current = defaultType;
            const startCfg = (defaultSource && fetchedConfigs.find((c: any) => c.website_name === defaultSource)) || fetchedConfigs[0];
            applyConfig(startCfg, { sort: defaultSort });
        })();
        return () => {
            if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        };
    }, []);

    // Reset everything for a freshly-selected source: pick first primary + no genre + first sort,
    // load that URL, clear search/suggestions/results. Accepts optional `sort` override from
    // the user's saved default in Profile → Defaults.
    const applyConfig = (cfg: any, overrides?: { sort?: string }) => {
        setSelectedConfig(cfg);
        setSearchInput("");
        setSearchQuery("");
        setSuggestions([]);
        setShowSuggestions(false);
        setScrapedData([]);
        setScraping(true);
        setShowWebView(false);
        setCurrentPage(1);
        setHasMorePages(true);
        setAppendingPage(false);

        const primaries = getPrimaryTypes(cfg);
        // Apply the user's preferred type (Profile → Default type) if this source
        // offers it; otherwise fall back to the first primary the config exposes.
        // Case-insensitive match so "Manhwa" works regardless of how a config capitalises.
        const userDefault = (defaultExploreTypeRef.current || '').toLowerCase();
        const matchedPrimary = userDefault
            ? primaries.find(p => p.toLowerCase() === userDefault) || ''
            : '';
        const defaultPrimary = matchedPrimary || primaries[0] || '';
        const genres = getGenresForType(cfg, defaultPrimary);
        const defaultGenre = genres[0] || '';
        const cat = getCategoryByTypeGenre(cfg, defaultPrimary, defaultGenre);
        const sorts = cat?.urls ? Object.keys(cat.urls) : [];
        const preferredSort = overrides?.sort && sorts.includes(overrides.sort) ? overrides.sort : (sorts[0] || '');

        setSelectedPrimary(defaultPrimary);
        setSelectedGenre(defaultGenre);
        setSelectedSort(preferredSort);
        const url = getCategoryUrl(cfg, defaultPrimary, defaultGenre, preferredSort);
        baseUrlRef.current = url;
        setCurrentUrl(url);
    };

    // Helper: switch to a fresh URL (filter/sort change, source change, search), resetting pagination.
    const navigateToFreshUrl = (url: string) => {
        baseUrlRef.current = url;
        setCurrentPage(1);
        setHasMorePages(true);
        setAppendingPage(false);
        setScrapedData([]);
        setScraping(true);
        setCurrentUrl(url);
    };

    const handleSourceChange = (cfg: any) => {
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] [EXPLORE]: Switching source to ${cfg.website_name}`);
        applyConfig(cfg);
    };

    const handlePrimaryChange = (primary: string) => {
        if (primary === selectedPrimary) return;
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] [EXPLORE]: Type → ${primary}`);
        setSelectedPrimary(primary);
        const genres = getGenresForType(selectedConfig, primary);
        const newGenre = genres.includes(selectedGenre) ? selectedGenre : (genres[0] || '');
        setSelectedGenre(newGenre);
        setSearchQuery('');
        navigateToFreshUrl(getCategoryUrl(selectedConfig, primary, newGenre, selectedSort));
    };

    const handleGenreChange = (genre: string) => {
        if (genre === selectedGenre) return;
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] [EXPLORE]: Genre → ${genre || '(none)'}`);
        setSelectedGenre(genre);
        setSearchQuery('');
        navigateToFreshUrl(getCategoryUrl(selectedConfig, selectedPrimary, genre, selectedSort));
    };

    const handleSortChange = (sort: string) => {
        if (sort === selectedSort) return;
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] [EXPLORE]: Sort → ${sort}`);
        setSelectedSort(sort);
        setSearchQuery('');
        navigateToFreshUrl(getCategoryUrl(selectedConfig, selectedPrimary, selectedGenre, sort));
    };

    const handleSearch = () => {
        if (!selectedConfig) return;
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] [EXPLORE]: Searching for "${searchInput}" on ${selectedConfig.website_name}`);
        setSearchQuery(searchInput);
        setShowSuggestions(false);
        setShowWebView(false);
        const tpl = selectedConfig.json_rules?.search_url || '';
        navigateToFreshUrl(tpl ? tpl.replace('{query}', encodeURIComponent(searchInput)) : '');
    };

    // Triggered when the user scrolls near the bottom of the list.
    const loadNextPage = () => {
        if (!hasMorePages || appendingPage || scraping || refreshing) return;
        if (!baseUrlRef.current) return;
        const nextPage = currentPage + 1;
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] [EXPLORE]: Loading page ${nextPage}`);
        setCurrentPage(nextPage);
        setAppendingPage(true);
        setCurrentUrl(buildPageUrl(baseUrlRef.current, nextPage));
    };

    // Pull-to-refresh handler.
    const handleRefresh = () => {
        if (!baseUrlRef.current) return;
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] [EXPLORE]: Refreshing`);
        setRefreshing(true);
        setCurrentPage(1);
        setHasMorePages(true);
        setAppendingPage(false);
        setScrapedData([]);
        setScraping(true);  // so the empty-state "Nothing here" doesn't flash during refresh
        setLoadAttempt(prev => prev + 1); // forces WebView remount even if URL is identical
        setCurrentUrl(baseUrlRef.current);
    };

    const clearSearch = () => {
        if (!selectedConfig) return;
        setSearchInput('');
        setSearchQuery('');
        setSuggestions([]);
        setShowSuggestions(false);
        applyConfig(selectedConfig);
    };

    // Debounced autocomplete trigger. Calls window.runAutocomplete(query) inside the
    // existing WebView so we reuse its session (incl. Cloudflare clearance cookies).
    const handleSearchInputChange = (text: string) => {
        setSearchInput(text);
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        const trimmed = text.trim();
        if (!trimmed) {
            setSuggestions([]);
            setShowSuggestions(false);
            setAutocompleteFetching(false);
            lastQueryRef.current = '';
            return;
        }
        debounceTimerRef.current = setTimeout(() => triggerAutocomplete(trimmed), 350);
    };

    const triggerAutocomplete = (query: string) => {
        if (!webViewRef.current) return;
        lastQueryRef.current = query;
        setAutocompleteFetching(true);
        setShowSuggestions(true);
        // JSON.stringify gives a complete, valid JS string literal (quotes,
        // backslashes and newlines escaped); the old hand-rolled escaping missed newlines.
        webViewRef.current.injectJavaScript(`if (window.runAutocomplete) { window.runAutocomplete(${JSON.stringify(query)}); } true;`);
    };

    const handleSuggestionPress = (item: any) => {
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] [USER CLICK]: Tapped suggestion "${item.title}"`);
        setShowSuggestions(false);
        setSearchInput('');
        router.push({
            pathname: '/details',
            params: {
                title: item.title,
                cover_url: item.image || '',
                manga_url: item.url
            }
        });
    };

    // Injected into every page the WebView loads. Defines two things:
    //   1. window.runAutocomplete(query) — called by RN via injectJavaScript on each keystroke
    //   2. The interval-based scraper (Cloudflare detection + result extraction)
    const INJECTED_JAVASCRIPT = selectedConfig ? `
        (function() {
            // Madara WordPress sites expose this AJAX endpoint for live search suggestions.
            // It returns JSON quickly, so this gives us the same dropdown the website itself shows.
            window.runAutocomplete = function(query) {
                try {
                    const fd = new URLSearchParams();
                    fd.append('action', 'wp-manga-search-manga');
                    fd.append('title', query);
                    fetch('/wp-admin/admin-ajax.php', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'X-Requested-With': 'XMLHttpRequest',
                        },
                        body: fd.toString(),
                        credentials: 'include'
                    })
                    .then(r => r.json())
                    .then(d => {
                        window.ReactNativeWebView.postMessage(JSON.stringify({
                            type: 'AUTOCOMPLETE', query: query, data: d.data || []
                        }));
                    })
                    .catch(e => {
                        window.ReactNativeWebView.postMessage(JSON.stringify({
                            type: 'AUTOCOMPLETE_ERROR', query: query, message: e.message
                        }));
                    });
                } catch (e) {
                    window.ReactNativeWebView.postMessage(JSON.stringify({
                        type: 'AUTOCOMPLETE_ERROR', query: query, message: e.message
                    }));
                }
            };

            let attempts = 0;
            const maxAttempts = 60;
            let scraped = false;

            function sendLog(msg) {
                const t = new Date().toLocaleTimeString();
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', message: '[' + t + '] ' + msg }));
            }

            sendLog('Scraper active on: ' + window.location.href);

            const interval = setInterval(() => {
                attempts++;
                const url = window.location.href;
                const docTitle = document.title;
                const html = document.documentElement.innerHTML;

                const isCloudflare =
                    url.indexOf('__cf_chl_') !== -1 ||
                    docTitle.indexOf('Just a moment') !== -1 ||
                    docTitle.indexOf('Attention Required') !== -1 ||
                    html.indexOf('cf-challenge') !== -1 ||
                    !!document.querySelector('#challenge-form, .cf-browser-verification, #cf-please-wait, iframe[src*="challenges.cloudflare.com"]');

                if (isCloudflare) {
                    if (attempts === 1 || attempts % 5 === 0) sendLog('Cloudflare challenge active (attempt ' + attempts + ')');
                    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SHOW_WEBVIEW' }));
                    if (attempts >= maxAttempts) {
                        clearInterval(interval);
                        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SUCCESS', data: [] }));
                    }
                    return;
                }

                if (scraped) { clearInterval(interval); return; }
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'HIDE_WEBVIEW' }));

                setTimeout(() => {
                    if (scraped) return;
                    scraped = true;
                    try {
                        const isSearch = ${searchQuery.length > 0 ? 'true' : 'false'};

                        const DEFAULT_SELECTORS = {
                            "item": ".page-item-detail, .bsx",
                            "title": "h3 a, .tt",
                            "link": "h3 a, a",
                            "image": "img",
                            "image_attr": "data-src, src",
                            "latest_chapter": ".chapter-item .chapter a, .epxs"
                        };

                        let rules = DEFAULT_SELECTORS;
                        const exploreRules = ${JSON.stringify((selectedConfig.json_rules.selectors && selectedConfig.json_rules.selectors.explore) || null)};
                        if (exploreRules) rules = exploreRules;

                        const searchRules = ${JSON.stringify((selectedConfig.json_rules.selectors && selectedConfig.json_rules.selectors.search) || null)};
                        if (isSearch && searchRules) rules = searchRules;

                        const results = [];
                        // Wrap rules.item in try/catch: some cloud configs contain
                        // BeautifulSoup-specific pseudo-classes that throw in browsers.
                        let items = [];
                        try { items = document.querySelectorAll(rules.item); }
                        catch (e) { sendLog('Primary item selector threw: ' + (e && e.message ? e.message : 'unknown')); }
                        sendLog('Found ' + items.length + ' raw items using: ' + rules.item);

                        // Dump the active rules so we can see exactly what the cloud config
                        // told us to look for. Helps spot stale/wrong selectors.
                        sendLog('Active rules: item="' + (rules.item || '') + '" title="' + (rules.title || '') + '" link="' + (rules.link || '') + '" image="' + (rules.image || '') + '" latest_chapter="' + (rules.latest_chapter || '(none)') + '"');

                        // Returns a chapter snippet from the card's own text. Used as a fallback
                        // when rules.latest_chapter and the astro-island map both fail. Only
                        // matches explicit "Chapter N" / "Ep. N" patterns — never the total
                        // chapter count, since N-chapters-total is not the same as latest-chapter
                        // when a series uses half-chapters (1, 1.5, 2 means 3 total but latest=2).
                        //
                        // Use regex literals with \\ (the template literal preserves these as
                        // a single \) instead of new RegExp(string) (which would need FOUR
                        // backslashes because both the template literal AND the string literal
                        // strip a layer). Regex literals only go through template eval, so \\
                        // in source becomes \ in the final regex literal — exactly what we want.
                        var CHAPTER_TEXT_RE = /(?:Chapter|Ch\\.?|Episode|Ep\\.?)\\s*\\d+(?:\\.\\d+)?/i;
                        function extractChapterFromText(el) {
                            const t = (el.innerText || el.textContent || '');
                            var m = t.match(CHAPTER_TEXT_RE);
                            return m ? m[0].trim() : '';
                        }

                        // Asura's /browse catalog renders cards via astro-island components and
                        // exposes only the total chapter count in visible text — never the actual
                        // latest chapter number (which can differ when half-chapters exist).
                        // The exact number IS in the astro-island's props attribute as serialized
                        // JSON. Parse those props once and build a series_id → latest_chapter map.
                        // No-ops cleanly on sites that don't use astro-island.
                        function buildAstroChapterMap() {
                            var map = {};
                            try {
                                var islands = document.querySelectorAll('astro-island[props]');
                                sendLog('Astro islands found: ' + islands.length);
                                var matchingIslands = 0;
                                for (var i = 0; i < islands.length; i++) {
                                    var raw = islands[i].getAttribute('props') || '';
                                    if (raw.indexOf('latest_chapters') === -1) continue;
                                    matchingIslands++;
                                    // Log a snippet of the first matching island's props so we
                                    // can see what shape the regex needs to match against.
                                    if (matchingIslands === 1) {
                                        var idx = raw.indexOf('latest_chapters');
                                        var snip = raw.substring(Math.max(0, idx - 60), Math.min(raw.length, idx + 240));
                                        sendLog('Astro island[0] props length=' + raw.length + ' snippet near latest_chapters: ' + snip);
                                    }
                                    // Astro encodes each value as [typeTag, value]. We anchor on the
                                    // series-object shape (id followed immediately by slug) so
                                    // chapter IDs nested inside latest_chapters (where id is
                                    // followed by series_id, not slug) don't get misread as
                                    // series IDs. The decimal capture handles 142.5 etc.
                                    //
                                    // Regex literal with \\ — template literal preserves these
                                    // as single \ in the final regex (see CHAPTER_TEXT_RE).
                                    var re = /"id":\\[0,(\\d+)\\],"slug":[\\s\\S]*?"latest_chapters":\\[1,\\[/g;
                                    // M2c: latest_chapters[0] can be an Early Access chapter
                                    // (is_premium true) that can't be read yet. Take the first
                                    // entry with is_premium false; the segment stops at the next
                                    // series' latest_chapters so entries never leak across cards.
                                    // Payloads without is_premium keep the old first-number rule.
                                    var chRe = /"number":\\[0,([\\d.]+)\\][^{}]*?"is_premium":\\[0,(true|false)\\]/g;
                                    var numRe = /"number":\\[0,([\\d.]+)\\]/;
                                    var m;
                                    while ((m = re.exec(raw)) !== null) {
                                        var segStart = re.lastIndex;
                                        var segEnd = raw.indexOf('"latest_chapters"', segStart);
                                        var seg = raw.substring(segStart, segEnd === -1 ? raw.length : segEnd);
                                        var pick = null, sawPremiumField = false, c;
                                        chRe.lastIndex = 0;
                                        while ((c = chRe.exec(seg)) !== null) {
                                            sawPremiumField = true;
                                            if (c[2] === 'false') { pick = c[1]; break; }
                                        }
                                        if (!sawPremiumField) {
                                            var nm = seg.match(numRe);
                                            if (nm) pick = nm[1];
                                        }
                                        if (pick) map[m[1]] = pick;
                                    }
                                }
                            } catch (e) {
                                sendLog('Astro map parse failed: ' + (e && e.message ? e.message : 'unknown'));
                            }
                            return map;
                        }
                        var astroChapterMap = buildAstroChapterMap();
                        var mapKeys = Object.keys(astroChapterMap);
                        var mapSample = mapKeys.slice(0, 5).map(function(k) { return k + '=' + astroChapterMap[k]; }).join(', ');
                        sendLog('Astro chapter map: size=' + mapKeys.length + ' sample={' + mapSample + '}');

                        function safeQueryInside(parent, sel) {
                            try { return parent.querySelector(sel); }
                            catch (e) { return null; }
                        }

                        items.forEach((el, idx) => {
                            const titleEl = rules.title ? safeQueryInside(el, rules.title) : el;
                            const linkEl = rules.link === 'self' ? el : (rules.link ? safeQueryInside(el, rules.link) : el);
                            const imgEl = rules.image ? safeQueryInside(el, rules.image) : el;
                            const chEl = rules.latest_chapter ? safeQueryInside(el, rules.latest_chapter) : null;

                            if (titleEl && linkEl) {
                                let imgSrc = '';
                                if (imgEl) {
                                    if (rules.image_attr) {
                                        const attrs = rules.image_attr.split(',').map(a => a.trim());
                                        for (let a of attrs) {
                                            imgSrc = imgEl.getAttribute(a);
                                            if (imgSrc) imgSrc = imgSrc.trim();
                                            if (imgSrc) break;
                                        }
                                    }
                                    if (!imgSrc) imgSrc = imgEl.src || '';
                                }

                                // Resolve latest chapter in priority order:
                                //   1. Astro-island JSON map (exact number for Asura, incl. .5 chapters)
                                //   2. Cloud-config selector (Madara/Toonily/etc.)
                                //   3. Regex over card text (Chapter N / Ep. N)
                                let latestCh = '';
                                var sid = (el.getAttribute && el.getAttribute('data-series-id')) || '';
                                var astroSource = '';
                                if (sid && astroChapterMap[sid]) {
                                    latestCh = 'Chapter ' + astroChapterMap[sid];
                                    astroSource = 'astro';
                                }
                                var chElText = '';
                                if (chEl) chElText = (chEl.innerText || chEl.textContent || '').trim();
                                if (!latestCh && chElText) latestCh = chElText;
                                var regexHit = '';
                                if (!latestCh) {
                                    regexHit = extractChapterFromText(el);
                                    latestCh = regexHit;
                                }
                                if (idx === 0) {
                                    var source = astroSource || (chElText ? 'selector' : (regexHit ? 'regex' : 'none'));
                                    sendLog('Card[0] result: latestCh="' + (latestCh || 'Unknown') + '" source=' + source + ' data-series-id="' + sid + '"');
                                    sendLog('Card[0] selector="' + (rules.latest_chapter || '(none)') + '" chEl=' + (chEl ? 'found' : 'null') + ' chElText="' + chElText.substring(0, 60) + '"');
                                    // Dump card text and HTML so we can compare against the real page.
                                    // Regex literal /\\s+/g — template eval leaves \s as \s, matching whitespace.
                                    var wsRe = /\\s+/g;
                                    var cardText = (el.innerText || el.textContent || '').replace(wsRe, ' ').trim().substring(0, 320);
                                    sendLog('Card[0] text: "' + cardText + '"');
                                    var cardHtml = (el.outerHTML || '').replace(wsRe, ' ').substring(0, 360);
                                    sendLog('Card[0] html-head: ' + cardHtml);
                                }

                                results.push({
                                    title: titleEl.innerText ? titleEl.innerText.trim() : (titleEl.textContent ? titleEl.textContent.trim() : 'Unknown'),
                                    link: linkEl.href || '',
                                    image: imgSrc,
                                    latest_chapter: latestCh || 'Unknown'
                                });

                                // Flag cards with missing title or image. We cap to 5 logs to
                                // keep noise down — that's enough to tell us if the issue is
                                // systemic (e.g. lazy-load placeholder src) or one-off.
                                if (typeof window.__missingCount === 'undefined') window.__missingCount = 0;
                                var titleStr = titleEl.innerText ? titleEl.innerText.trim() : (titleEl.textContent ? titleEl.textContent.trim() : '');
                                if (window.__missingCount < 5 && (!titleStr || !imgSrc)) {
                                    window.__missingCount++;
                                    sendLog('Card[' + idx + '] MISSING: title="' + titleStr + '" img="' + (imgSrc || '').substring(0, 100) + '"');
                                }
                            }
                        });

                        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SUCCESS', data: results }));
                        clearInterval(interval);
                    } catch (e) {
                        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ERROR', message: e.message }));
                        clearInterval(interval);
                    }
                }, 1500);
            }, 1000);
        })();
        true;
    ` : '';

    // For each scraped explore result that matches a comic in the user's local library
    // (by manga_url), update its latest_chapter in SQLite AND push the updated value to
    // Supabase. Without the cloud push, the next bulkRestoreLocal pull would overwrite
    // our local update with the stale cloud value.
    const syncLatestChaptersToLibrary = async (items: any[]) => {
        if (!items || items.length === 0) return;
        try {
            const db = await initDatabase();
            const library: any[] = await getLocalLibrary(db);
            const libByUrl = new Map<string, any>();
            for (const m of library) {
                if (m.manga_url) libByUrl.set(m.manga_url, m);
            }
            const pageConfigs = await getLocalConfigs(db);
            const updates: Array<{ title: string; latest_chapter: string }> = [];
            for (const item of items) {
                const url = item.link;
                const ch = item.latest_chapter;
                if (!url || !ch || ch === 'Unknown') continue;
                const existing = libByUrl.get(url);
                if (!existing) continue;
                if (existing.latest_chapter === ch) continue;
                // M2: an Explore card only reflects the primary site. Don't regress a
                // latest_chapter that a linked source already moved further ahead.
                if (isChapterDowngrade(existing.latest_chapter, ch)) continue;
                // Phantom guard: on sites that list chapters before uploading pages
                // (MangaRead), a newer chapter is stored only once its page has
                // images. A phantom falls back to the previous chapter; an
                // unverifiable one is skipped until the next sync.
                let verified: string = ch;
                const isNewer = (t: string) => isNewerChapter(t, existing.latest_chapter, null);
                const markers = getPageMarkers(matchConfigToUrlStrict(pageConfigs, url)?.json_rules ?? null, url);
                if (markers.length > 0 && isNewer(ch)) {
                    const picked = await resolveLatestWithPages(url, markers, isNewer);
                    if (!picked || !isNewer(picked)) continue;
                    verified = picked;
                }
                updates.push({ title: existing.title, latest_chapter: verified });
            }
            if (updates.length === 0) return;
            // Found now, so latest_date is today (drives "Latest update" sorting).
            const latestDate = isoMinute();
            await db.withTransactionAsync(async () => {
                for (const u of updates) {
                    // Value came from the primary site → clear the "via <site>" hint.
                    await db.runAsync('UPDATE manga SET latest_chapter = ?, latest_source = ?, latest_date = ? WHERE title = ?', [u.latest_chapter, '', latestDate, u.title]);
                }
            });
            const t = new Date().toLocaleTimeString();
            console.log(`[${t}] [EXPLORE]: Refreshed latest_chapter for ${updates.length} library comic(s)`);
            // Push to cloud so the next sync doesn't overwrite our fresh value.
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user) {
                for (const u of updates) {
                    try {
                        await supabase.from('manga_library').upsert(
                            { user_id: session.user.id, title: u.title, latest_chapter: u.latest_chapter, latest_date: latestDate },
                            { onConflict: 'user_id,title' }
                        );
                    } catch (e: any) {
                        console.warn(`[EXPLORE]: cloud push failed for "${u.title}":`, e.message || e);
                    }
                }
            }
        } catch (e: any) {
            console.warn('[EXPLORE]: syncLatestChaptersToLibrary failed:', e.message || e);
        }
    };

    const handleWebViewMessage = (event: any) => {
        const time = new Date().toLocaleTimeString();
        // Unparseable or unknown-type messages just no-op. Aborting the scrape
        // here would let any stray ad-iframe message kill an in-flight scrape.
        const payload = parseWebViewMessage(event.nativeEvent.data, EXPLORE_ALLOWED_TYPES, 'EXPLORE');
        if (!payload) return;
        try {
            if (payload.type === 'DEBUG') {
                console.log(`[${time}] [SCRAPER DEBUG Explore]:`, clampString(payload.message));
                return;
            }
            if (payload.type === 'SHOW_WEBVIEW') { setShowWebView(true); return; }
            if (payload.type === 'HIDE_WEBVIEW') { setShowWebView(false); return; }

            if (payload.type === 'AUTOCOMPLETE') {
                // Drop stale responses (user kept typing while this one was in flight)
                if (typeof payload.query !== 'string' || payload.query !== lastQueryRef.current) return;
                if (!isBoundedArray(payload.data, MAX_EXPLORE_RESULTS)) {
                    console.warn(`[${time}] [AUTOCOMPLETE]: rejected — data missing/oversized`);
                    setSuggestions([]);
                    setAutocompleteFetching(false);
                    return;
                }
                const safeData = (payload.data as unknown[]).filter(
                    (x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
                );
                console.log(`[${time}] [AUTOCOMPLETE]: ${safeData.length} suggestions for "${payload.query}"`);
                setSuggestions(safeData as any[]);
                setAutocompleteFetching(false);
                return;
            }
            if (payload.type === 'AUTOCOMPLETE_ERROR') {
                if (typeof payload.query !== 'string' || payload.query !== lastQueryRef.current) return;
                console.warn(`[${time}] [AUTOCOMPLETE ERROR]:`, clampString(payload.message));
                setSuggestions([]);
                setAutocompleteFetching(false);
                return;
            }

            if (payload.type === 'SUCCESS') {
                if (!isBoundedArray(payload.data, MAX_EXPLORE_RESULTS)) {
                    console.warn(`[${time}] [EXPLORE]: SUCCESS rejected — data missing/oversized`);
                    setScraping(false);
                    setAppendingPage(false);
                    setShowWebView(false);
                    setRefreshing(false);
                    return;
                }
                const newItems = (payload.data as unknown[]).filter(
                    (x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
                );
                if (appendingPage) {
                    // Compute dedup against current state before updating
                    const existing = new Set(scrapedData.map((p: any) => p.link));
                    const fresh = newItems.filter((n: any) => n.link && !existing.has(n.link));
                    console.log(`[${time}] [EXPLORE SUCCESS]: Extracted ${newItems.length} (${fresh.length} new) on page ${currentPage}`);
                    // Stop pagination when a page returns nothing fresh — many sites recycle
                    // the same results on out-of-range pages instead of returning empty.
                    if (fresh.length === 0) {
                        setHasMorePages(false);
                    } else {
                        setScrapedData(prev => [...prev, ...fresh]);
                    }
                    setAppendingPage(false);
                } else {
                    console.log(`[${time}] [EXPLORE SUCCESS]: Extracted ${newItems.length} comics (page 1)`);
                    setScrapedData(newItems);
                }
                setScraping(false);
                setShowWebView(false);
                setRefreshing(false);
                // Fire-and-forget: refresh latest_chapter for any library comic that appears
                // in these results. Fixes stale "—" badges on comics added before our explore
                // scraper started returning chapter numbers correctly.
                syncLatestChaptersToLibrary(newItems);
                return;
            }
            if (payload.type === 'ERROR') {
                console.error(`[${time}] [SCRAPER ERROR Explore]:`, clampString(payload.message));
                setScraping(false);
                setAppendingPage(false);
                setRefreshing(false);
                return;
            }
        } catch (e: any) {
            console.error(`[${time}] [EXPLORE ERROR]: Handler threw`, e.message || e);
            setScraping(false);
            setAppendingPage(false);
            setRefreshing(false);
        }
    };

    const primaries = getPrimaryTypes(selectedConfig);
    const genres = getGenresForType(selectedConfig, selectedPrimary);
    const currentCat = getCategoryByTypeGenre(selectedConfig, selectedPrimary, selectedGenre);
    const sorts = currentCat?.urls ? Object.keys(currentCat.urls) : [];
    const showPrimaryRow = primaries.length > 1;
    const showGenreRow = genres.length > 1; // > 1 because the list always includes '' = "All"
    const showSortRow = sorts.length > 1;

    const filterSummary = [
        showPrimaryRow ? displayLabel(selectedPrimary) : '',
        showGenreRow && selectedGenre ? displayLabel(selectedGenre) : '',
        showSortRow ? selectedSort : '',
    ].filter(Boolean).join(' · ') || 'Filters';
    const hasFilters = showPrimaryRow || showGenreRow || showSortRow;

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                {/* Row 1: Source button (left) + Filter button (right) */}
                <View style={styles.controlsRow}>
                    <TouchableOpacity
                        style={styles.controlButton}
                        onPress={() => setSourceModalOpen(true)}
                        activeOpacity={0.7}
                    >
                        <Text style={styles.controlButtonText} numberOfLines={1}>
                            {selectedConfig?.website_name || 'Source'}
                        </Text>
                        <Text style={styles.controlChevron}>▾</Text>
                    </TouchableOpacity>

                    {hasFilters && (
                        <TouchableOpacity
                            style={[styles.controlButton, styles.filterButton]}
                            onPress={() => setFilterModalOpen(true)}
                            activeOpacity={0.7}
                        >
                            <Text style={styles.controlButtonText} numberOfLines={1}>{filterSummary}</Text>
                            <Text style={styles.controlChevron}>▾</Text>
                        </TouchableOpacity>
                    )}
                </View>

                {/* Row 2: Search */}
                <View style={styles.searchContainer}>
                    <View style={{ flex: 1, position: 'relative', justifyContent: 'center' }}>
                        <TextInput
                            style={[styles.searchInput, (searchInput || searchQuery) && { paddingRight: 36 }]}
                            placeholder={selectedConfig ? `Search ${selectedConfig.website_name}...` : "Search..."}
                            placeholderTextColor={colors.textMuted}
                            value={searchInput}
                            onChangeText={handleSearchInputChange}
                            onSubmitEditing={handleSearch}
                            returnKeyType="search"
                        />
                        {(searchInput || searchQuery) && (
                            <TouchableOpacity
                                onPress={clearSearch}
                                hitSlop={10}
                                style={{ position: 'absolute', right: 8, padding: 4 }}
                            >
                                <Text style={{ color: colors.textMuted, fontSize: 18, fontWeight: '600' }}>×</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                    <TouchableOpacity style={styles.searchButton} onPress={handleSearch}>
                        <Text style={styles.searchButtonText}>Search</Text>
                    </TouchableOpacity>
                </View>
            </View>

            {/* Source picker bottom sheet */}
            <Modal visible={sourceModalOpen} transparent animationType="slide" onRequestClose={() => setSourceModalOpen(false)}>
                <Pressable style={styles.modalBackdrop} onPress={() => setSourceModalOpen(false)}>
                    <Pressable style={styles.modalSheet} onPress={() => { /* swallow */ }}>
                        <View style={styles.modalHandle} />
                        <Text style={styles.modalTitle}>Source</Text>
                        <ScrollView style={{ maxHeight: 480 }}>
                            {configs.map((cfg, idx) => {
                                const isSelected = selectedConfig?.website_name === cfg.website_name;
                                return (
                                    <TouchableOpacity
                                        key={idx}
                                        style={[styles.modalRow, isSelected && styles.modalRowActive]}
                                        onPress={() => { handleSourceChange(cfg); setSourceModalOpen(false); }}
                                    >
                                        <Text style={[styles.modalRowText, isSelected && styles.modalRowTextActive]}>
                                            {cfg.website_name}
                                        </Text>
                                        {isSelected && <Text style={styles.modalCheck}>✓</Text>}
                                    </TouchableOpacity>
                                );
                            })}
                        </ScrollView>
                    </Pressable>
                </Pressable>
            </Modal>

            {/* Filter picker bottom sheet */}
            <Modal visible={filterModalOpen} transparent animationType="slide" onRequestClose={() => setFilterModalOpen(false)}>
                <Pressable style={styles.modalBackdrop} onPress={() => setFilterModalOpen(false)}>
                    <Pressable style={styles.modalSheet} onPress={() => { /* swallow */ }}>
                        <View style={styles.modalHandle} />
                        <Text style={styles.modalTitle}>Filters</Text>
                        <ScrollView style={{ maxHeight: 480 }}>
                            {showPrimaryRow && (
                                <View style={styles.filterSection}>
                                    <Text style={styles.filterSectionLabel}>Type</Text>
                                    <View style={styles.filterChipsWrap}>
                                        {primaries.map((primary, idx) => {
                                            const isSelected = selectedPrimary === primary;
                                            return (
                                                <TouchableOpacity
                                                    key={idx}
                                                    style={[styles.filterChip, isSelected && styles.filterChipActive]}
                                                    onPress={() => handlePrimaryChange(primary)}
                                                >
                                                    <Text style={[styles.filterChipText, isSelected && styles.filterChipTextActive]}>
                                                        {displayLabel(primary)}
                                                    </Text>
                                                </TouchableOpacity>
                                            );
                                        })}
                                    </View>
                                </View>
                            )}
                            {showGenreRow && (
                                <View style={styles.filterSection}>
                                    <Text style={styles.filterSectionLabel}>Genre</Text>
                                    <View style={styles.filterChipsWrap}>
                                        {genres.map((genre, idx) => {
                                            const isSelected = selectedGenre === genre;
                                            return (
                                                <TouchableOpacity
                                                    key={idx}
                                                    style={[styles.filterChip, isSelected && styles.filterChipActive]}
                                                    onPress={() => handleGenreChange(genre)}
                                                >
                                                    <Text style={[styles.filterChipText, isSelected && styles.filterChipTextActive]}>
                                                        {displayLabel(genre)}
                                                    </Text>
                                                </TouchableOpacity>
                                            );
                                        })}
                                    </View>
                                </View>
                            )}
                            {showSortRow && (
                                <View style={styles.filterSection}>
                                    <Text style={styles.filterSectionLabel}>Sort</Text>
                                    <View style={styles.filterChipsWrap}>
                                        {sorts.map((sort, idx) => {
                                            const isSelected = selectedSort === sort;
                                            return (
                                                <TouchableOpacity
                                                    key={idx}
                                                    style={[styles.filterChip, isSelected && styles.filterChipActive]}
                                                    onPress={() => handleSortChange(sort)}
                                                >
                                                    <Text style={[styles.filterChipText, isSelected && styles.filterChipTextActive]}>{sort}</Text>
                                                </TouchableOpacity>
                                            );
                                        })}
                                    </View>
                                </View>
                            )}
                        </ScrollView>
                        <TouchableOpacity style={styles.modalCloseBtn} onPress={() => setFilterModalOpen(false)}>
                            <Text style={styles.modalCloseBtnText}>Done</Text>
                        </TouchableOpacity>
                    </Pressable>
                </Pressable>
            </Modal>

            {scraping && scrapedData.length === 0 ? (
                <View style={styles.centerBox}>
                    <ActivityIndicator size="large" color={colors.accent} />
                    <Text style={styles.subtext}>{searchQuery ? 'Searching...' : 'Fetching latest updates...'}</Text>
                </View>
            ) : (
                <FlatList
                    data={scrapedData}
                    keyExtractor={(item, idx) => (item.link || 'item') + '-' + idx}
                    numColumns={2}
                    contentContainerStyle={{ padding: 8, alignItems: 'center' }}
                    renderItem={({ item }) => <ExploreCard item={item} onLongPress={() => setActionMenuItem(item)} />}
                    keyboardShouldPersistTaps="handled"
                    onEndReached={loadNextPage}
                    onEndReachedThreshold={0.5}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={handleRefresh}
                            tintColor={colors.accent}
                            colors={[colors.accent]}
                        />
                    }
                    ListFooterComponent={
                        appendingPage ? (
                            <View style={{ padding: 20, width: '100%', alignItems: 'center' }}>
                                <ActivityIndicator size="small" color={colors.accent} />
                                <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 6 }}>Loading page {currentPage}...</Text>
                            </View>
                        ) : !hasMorePages && scrapedData.length > 0 ? (
                            <Text style={{ color: colors.textMuted, fontSize: 12, textAlign: 'center', padding: 20 }}>
                                — End of results —
                            </Text>
                        ) : undefined
                    }
                    ListEmptyComponent={
                        <View style={{ alignItems: 'center', paddingHorizontal: 32, paddingTop: 60 }}>
                            <Text style={{ fontSize: 56, marginBottom: 12 }}>🌌</Text>
                            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' }}>Nothing here</Text>
                            <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 19, textAlign: 'center', marginBottom: 16 }}>
                                {searchQuery
                                    ? `No matches for "${searchQuery}" on ${selectedConfig?.website_name}.`
                                    : 'This source returned no items. Try a different source or filter.'}
                            </Text>
                            {searchQuery && (
                                <TouchableOpacity onPress={() => { setSearchInput(''); setSearchQuery(''); applyConfig(selectedConfig); }} style={{ backgroundColor: colors.accent, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 22 }}>
                                    <Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 14 }}>Clear search</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    }
                />
            )}

            {/* Suggestions dropdown — anchored below the header. Tap outside dismisses. */}
            {showSuggestions && (
                <Pressable style={styles.suggestionsBackdrop} onPress={() => setShowSuggestions(false)}>
                    <Pressable style={styles.suggestionsBox} onPress={() => { /* swallow inner taps */ }}>
                        {autocompleteFetching && suggestions.length === 0 ? (
                            <View style={styles.suggestionEmpty}><ActivityIndicator size="small" color="#E15053" /></View>
                        ) : suggestions.length === 0 ? (
                            <View style={styles.suggestionEmpty}>
                                <Text style={styles.suggestionEmptyText}>No suggestions — tap Search for full results</Text>
                            </View>
                        ) : (
                            <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 360 }}>
                                {suggestions.slice(0, 8).map((s, idx) => (
                                    <SuggestionRow key={idx} item={s} onPress={() => handleSuggestionPress(s)} />
                                ))}
                            </ScrollView>
                        )}
                    </Pressable>
                </Pressable>
            )}

            {/* Long-press action sheet for explore cards */}
            <Modal visible={!!actionMenuItem} transparent animationType="slide" onRequestClose={() => setActionMenuItem(null)}>
                <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }} onPress={() => setActionMenuItem(null)}>
                    <Pressable style={{ backgroundColor: colors.surfaceAlt, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 8, paddingBottom: 24 }} onPress={() => { /* swallow */ }}>
                        <View style={{ alignSelf: 'center', width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2, marginBottom: 12 }} />
                        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700', paddingHorizontal: 16, paddingBottom: 12 }} numberOfLines={2}>{actionMenuItem?.title}</Text>
                        <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
                            {actionMenuItem && libraryUrls.has(actionMenuItem.link) ? (
                                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 }}>
                                    <Ionicons name="checkmark-circle" size={20} color={colors.success} style={{ marginRight: 14 }} />
                                    <Text style={{ color: colors.success, fontSize: 15, fontWeight: '500' }}>Already in your library</Text>
                                </View>
                            ) : (
                                <TouchableOpacity
                                    style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 }}
                                    onPress={async () => { const item = actionMenuItem; setActionMenuItem(null); if (item) await handleAddToLibraryFromExplore(item); }}
                                    activeOpacity={0.6}
                                >
                                    <Ionicons name="add-circle-outline" size={20} color={colors.textMuted} style={{ marginRight: 14 }} />
                                    <Text style={{ color: colors.text, fontSize: 15, fontWeight: '500' }}>Add to library</Text>
                                </TouchableOpacity>
                            )}
                            <TouchableOpacity
                                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 }}
                                onPress={async () => { const item = actionMenuItem; if (item) await handleShareFromExplore(item); setActionMenuItem(null); }}
                                activeOpacity={0.6}
                            >
                                <Ionicons name="share-outline" size={20} color={colors.textMuted} style={{ marginRight: 14 }} />
                                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '500' }}>Share</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 }}
                                onPress={() => {
                                    const item = actionMenuItem;
                                    setActionMenuItem(null);
                                    if (item) router.push({ pathname: '/details', params: { title: item.title, cover_url: item.image, manga_url: item.link } });
                                }}
                                activeOpacity={0.6}
                            >
                                <Ionicons name="information-circle-outline" size={20} color={colors.textMuted} style={{ marginRight: 14 }} />
                                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '500' }}>View details</Text>
                            </TouchableOpacity>
                        </View>
                        <TouchableOpacity style={{ marginHorizontal: 16, marginTop: 16, paddingVertical: 13, backgroundColor: colors.chipBg, borderRadius: 10, alignItems: 'center' }} onPress={() => setActionMenuItem(null)}>
                            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }}>Cancel</Text>
                        </TouchableOpacity>
                    </Pressable>
                </Pressable>
            </Modal>

            {selectedConfig && isSafeMangaUrl(currentUrl) && (
                <View
                    pointerEvents={showWebView ? 'auto' : 'none'}
                    style={{
                        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                        zIndex: showWebView ? 100 : -1,
                        opacity: showWebView ? 1 : 0.01,
                        backgroundColor: '#FFF',
                    }}>
                    {showWebView && (
                        <View style={{ padding: 12, backgroundColor: '#1E1E20', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 13, flex: 1 }}>
                                Solve the security check — it'll continue automatically
                            </Text>
                            <TouchableOpacity onPress={() => setShowWebView(false)} style={{ backgroundColor: '#444', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6 }}>
                                <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>Hide</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                    <WebView
                        ref={webViewRef}
                        key={`${currentUrl}-${loadAttempt}`}
                        source={{ uri: currentUrl }}
                        injectedJavaScript={INJECTED_JAVASCRIPT}
                        onMessage={handleWebViewMessage}
                        javaScriptEnabled={true}
                        domStorageEnabled={true}
                        {...WEBVIEW_HARDENING_PROPS}
                        onShouldStartLoadWithRequest={webViewNavigationGate}
                        userAgent={currentUrl.includes('webtoons.com')
                            ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
                            : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'}
                        onLoadStart={(e) => console.log(`[${new Date().toLocaleTimeString()}] [WEBVIEW START]: ${e.nativeEvent.url}`)}
                        onLoadEnd={(e) => console.log(`[${new Date().toLocaleTimeString()}] [WEBVIEW END]: ${e.nativeEvent.url} (loading=${e.nativeEvent.loading})`)}
                        onError={(e) => {
                            const n = e.nativeEvent;
                            console.error(`[${new Date().toLocaleTimeString()}] [WEBVIEW ERROR]: code=${n.code} domain=${n.domain} desc="${n.description}" url=${n.url || '(empty)'}`);
                        }}
                        onHttpError={(e) => {
                            const n = e.nativeEvent;
                            console.error(`[${new Date().toLocaleTimeString()}] [WEBVIEW HTTP ERROR]: status=${n.statusCode} url=${n.url} desc="${n.description}"`);
                        }}
                    />
                </View>
            )}
        </View>
    );
}

const makeStyles = (c: AppColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    header: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },

    controlsRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
    controlButton: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: c.chipBg, borderRadius: 8,
        paddingHorizontal: 12, paddingVertical: 8,
        marginRight: 8,
        maxWidth: '50%',
    },
    filterButton: { marginRight: 0, flex: 0 },
    controlButtonText: { color: c.text, fontSize: 13, fontWeight: '600' },
    controlChevron: { color: c.textMuted, fontSize: 12, marginLeft: 6 },

    searchContainer: { flexDirection: 'row', alignItems: 'center' },
    searchInput: { flex: 1, height: 38, backgroundColor: c.inputBg, borderRadius: 8, paddingHorizontal: 12, color: c.text },
    searchButton: { marginLeft: 8, backgroundColor: c.accent, paddingHorizontal: 14, height: 38, borderRadius: 8, justifyContent: 'center' },
    searchButtonText: { color: '#FFF', fontWeight: 'bold', fontSize: 13 },

    /* Modal sheets */
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    modalSheet: {
        backgroundColor: c.surfaceAlt,
        borderTopLeftRadius: 16, borderTopRightRadius: 16,
        paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24,
    },
    modalHandle: { alignSelf: 'center', width: 36, height: 4, backgroundColor: c.border, borderRadius: 2, marginBottom: 12 },
    modalTitle: { color: c.text, fontSize: 16, fontWeight: 'bold', marginBottom: 12 },
    modalRow: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingVertical: 14, paddingHorizontal: 12,
        borderRadius: 8, marginBottom: 4,
    },
    modalRowActive: { backgroundColor: c.chipBg },
    modalRowText: { color: c.text, fontSize: 14, fontWeight: '500' },
    modalRowTextActive: { color: c.accent, fontWeight: '700' },
    modalCheck: { color: c.accent, fontSize: 16, fontWeight: 'bold' },
    modalCloseBtn: { backgroundColor: c.accent, borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginTop: 12 },
    modalCloseBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },

    /* Filter chips inside modal */
    filterSection: { marginBottom: 16 },
    filterSectionLabel: { color: c.textMuted, fontSize: 12, fontWeight: '700', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
    filterChipsWrap: { flexDirection: 'row', flexWrap: 'wrap' },
    filterChip: {
        paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16,
        backgroundColor: c.chipBg, marginRight: 6, marginBottom: 6,
        borderWidth: 1, borderColor: 'transparent',
    },
    filterChipActive: { backgroundColor: 'transparent', borderColor: c.accent },
    filterChipText: { color: c.chipText, fontWeight: '600', fontSize: 12 },
    filterChipTextActive: { color: c.accent },

    suggestionsBackdrop: {
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.35)',
        zIndex: 50,
        paddingTop: 0,
    },
    suggestionsBox: {
        marginTop: 8,
        marginHorizontal: 12,
        backgroundColor: c.surfaceAlt,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        overflow: 'hidden',
    },
    suggestionRow: { flexDirection: 'row', alignItems: 'center', padding: 10, borderBottomWidth: 1, borderBottomColor: c.border },
    suggestionImage: { width: 40, height: 56, borderRadius: 4, backgroundColor: c.chipBg },
    suggestionImagePlaceholder: { backgroundColor: c.chipBg },
    suggestionTextBox: { flex: 1, marginLeft: 10 },
    suggestionTitle: { color: c.text, fontSize: 13, fontWeight: '600' },
    suggestionMeta: { color: c.textMuted, fontSize: 11, marginTop: 2 },
    suggestionEmpty: { padding: 16, alignItems: 'center' },
    suggestionEmptyText: { color: c.textMuted, fontSize: 12 },

    centerBox: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: c.bg, padding: 20 },
    subtext: { fontSize: 14, color: c.textMuted, textAlign: 'center', marginTop: 12 },

    card: { width: 160, backgroundColor: c.surface, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: c.border, margin: 8 },
    cover: { width: '100%', height: 220 },
    content: { padding: 12 },
    title: { color: c.text, fontSize: 13, fontWeight: '700', marginBottom: 4 },
    chapter: { color: c.accent, fontSize: 11, fontWeight: 'bold' }
});
