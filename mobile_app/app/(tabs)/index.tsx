import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, ActivityIndicator, Modal, Pressable, ScrollView, RefreshControl, Share, Alert, Platform, AppState } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { makeRedirectUri } from 'expo-auth-session';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase, pullLibraryFromCloudStrict, fetchScraperConfigsFromCloud, removeFromCloud, pushAllToCloud } from '../../services/supabase';
import { syncLibraryWithCloud } from '../../services/librarySync';
import { migrateRatingColumns } from '../../services/database';
import { planLibraryMerges, applyLibraryMerges } from '../../services/libraryDedupe';
import { deleteAllMangaDownloads } from '../../services/downloads';
import { cancelAllForManga } from '../../services/downloadQueue';
import { initDatabase, getLocalLibrary, bulkRestoreConfigs, getLocalConfigs, getSetting, setSetting, getAllDownloadedMangaUrls, clearUserData, assertMangaColumns } from '../../services/database';
import { runChapterCheck } from '../../services/notifications';
import { sortByDateField } from '../../services/latestDate';
import { beginOAuth, endOAuth, takePendingOAuth, parseAuthRedirect, describeRedirectForLog } from '../../services/authRedirect';
import MangaCard from '../../components/MangaCard';
import { SkeletonGrid } from '../../components/Skeleton';
import { useAppTheme, AppColors } from '../../services/theme';

WebBrowser.maybeCompleteAuthSession();

type SortKey = 'recent' | 'title' | 'latest';

/** "just now", "12 min ago", "3 h ago", "2 days ago" for the last-check label. */
function formatAgo(ms: number): string {
    const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
}
const SORT_LABELS: Record<SortKey, string> = {
    recent: 'Recent',
    title: 'A-Z',
    latest: 'Updates',
};

export default function DashboardScreen() {
    const router = useRouter();
    const { colors } = useAppTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [loading, setLoading] = useState(true);
    const [mangaList, setMangaList] = useState<any[]>([]);
    const [user, setUser] = useState<any>(null);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [authError, setAuthError] = useState('');

    const [refreshing, setRefreshing] = useState(false);
    // Mutex for loadData. Declared up here so hook order is stable.
    const loadingRef = useRef(false);
    // True once the library has been on screen for the signed-in user.
    const libraryShownRef = useRef(false);
    // Header line while the cloud pull runs behind the already painted list.
    const SYNC_STATUS = 'Getting the latest chapters…';
    // Saved sort/filter defaults are applied once per session (see loadData).
    const defaultsAppliedRef = useRef(false);

    // Long-press action sheet — the manga whose actions are showing
    const [actionMenuManga, setActionMenuManga] = useState<any | null>(null);

    // Apply an update to a manga: write to local SQLite, push the same fields to Supabase, update in-memory state.
    const applyMangaUpdate = async (mangaTitle: string, updates: Record<string, any>) => {
        try {
            const db = await initDatabase();
            const cols = Object.keys(updates);
            // SQL injection guard: column names go into the SET clause as raw text,
            // so they must be whitelisted before the SQL is built. Throws on unknown.
            assertMangaColumns(cols);
            const values = Object.values(updates);
            const setClause = cols.map(c => `${c} = ?`).join(', ');
            await db.runAsync(`UPDATE manga SET ${setClause} WHERE title = ?`, [...values, mangaTitle]);

            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user) {
                await supabase.from('manga_library').upsert(
                    { user_id: session.user.id, title: mangaTitle, ...updates },
                    { onConflict: 'user_id,title' }
                );
            }
            setMangaList(prev => prev.map(m => m.title === mangaTitle ? { ...m, ...updates } : m));
        } catch (e: any) {
            console.error('[ACTION]: applyMangaUpdate failed', e.message || e);
            Alert.alert('Update failed', e.message || 'Unknown error');
        }
    };

    const handleMarkAllRead = async (m: any) => {
        setActionMenuManga(null);
        if (!m.latest_chapter) {
            Alert.alert('No latest chapter known', 'Refresh the comic first so the latest chapter is up to date.');
            return;
        }
        await applyMangaUpdate(m.title, {
            chapter: m.latest_chapter,
            last_read_date: new Date().toISOString().split('T')[0],
        });
    };

    const handleMarkUnread = async (m: any) => {
        setActionMenuManga(null);
        await applyMangaUpdate(m.title, { chapter: 'Chapter 0' });
    };

    const handleToggleFavorite = async (m: any) => {
        setActionMenuManga(null);
        const isFav = m.favorite === 'Yes' || m.favorite === 1;
        await applyMangaUpdate(m.title, { favorite: isFav ? '' : 'Yes' });
    };

    const handleShare = async (m: any) => {
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] [SHARE]: Opening share sheet for "${m.title}"`);
        try {
            // Call Share.share BEFORE closing the action sheet — iOS won't present
            // a new modal while another is mid-dismiss-animation.
            const result = await Share.share({
                message: m.manga_url ? `Check out "${m.title}": ${m.manga_url}` : `Check out "${m.title}"`,
                url: m.manga_url || undefined,
                title: m.title,
            });
            console.log(`[${time}] [SHARE]: result.action=${result.action}`);
        } catch (e: any) {
            console.warn('[SHARE]: failed', e.message || e);
        } finally {
            setActionMenuManga(null);
        }
    };

    const handleRemoveFromLibrary = async (m: any) => {
        setActionMenuManga(null);
        Alert.alert(
            'Remove from library?',
            `"${m.title}" will be removed locally and in the cloud. Downloaded chapters will also be deleted.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Remove', style: 'destructive', onPress: async () => {
                        try {
                            const db = await initDatabase();
                            await db.runAsync('DELETE FROM manga WHERE title = ?', [m.title]);
                            // Cancel any in-flight or queued downloads for this manga before deleting files
                            if (m.manga_url) {
                                cancelAllForManga(m.manga_url);
                                await deleteAllMangaDownloads(m.manga_url);
                            }
                            const { data: { session } } = await supabase.auth.getSession();
                            if (session?.user) await removeFromCloud(session.user.id, m.title);
                            setMangaList(prev => prev.filter(x => x.title !== m.title));
                        } catch (e: any) {
                            Alert.alert('Remove failed', e.message || 'Unknown error');
                        }
                    }
                }
            ]
        );
    };

    // Search / sort / filter state.
    // `searchInput` is the immediate TextInput value; `searchQuery` is the
    // debounced value used for the actual filter pass. Decoupling keeps typing
    // smooth even with a large library — we don't re-filter on every keystroke.
    const [searchInput, setSearchInput] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [sortBy, setSortBy] = useState<SortKey>('recent');
    const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
    const [showUpdatesOnly, setShowUpdatesOnly] = useState(false);
    const [showDownloadedOnly, setShowDownloadedOnly] = useState(false);
    const [downloadedMangaUrls, setDownloadedMangaUrls] = useState<Set<string>>(new Set());
    const [selectedStatus, setSelectedStatus] = useState<string>('');
    const [selectedCategory, setSelectedCategory] = useState<string>('');
    const [filterModalOpen, setFilterModalOpen] = useState(false);

    // Debounce searchInput → searchQuery by 250ms.
    useEffect(() => {
        const id = setTimeout(() => setSearchQuery(searchInput), 250);
        return () => clearTimeout(id);
    }, [searchInput]);

    useEffect(() => {
        // Check session on startup
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                setUser(session.user);
                loadData(session.user.id);
            } else {
                setLoading(false);
            }
        });

        // Some platforms deliver the OAuth redirect as a deep link instead of (or
        // as well as) the auth-session result. Only a redirect for the Google
        // sign-in in progress is handled; any other incoming link is ignored here.
        const subscription = Linking.addEventListener('url', (event) => {
            if (takePendingOAuth(event.url)) handleAuthRedirect(event.url);
        });

        // React to auth state changes from anywhere in the app (e.g. sign-out from Profile)
        const { data: authSubscription } = supabase.auth.onAuthStateChange(async (event, session) => {
            const time = new Date().toLocaleTimeString();
            console.log(`[${time}] [AUTH STATE]: ${event}`);
            if (event === 'SIGNED_OUT') {
                setUser(null);
                setMangaList([]);
                libraryShownRef.current = false;
                setSearchInput('');
                setSearchQuery('');
                clearAllFilters();
                // Wipe user-personal local data so a different account signing in next
                // doesn't see the previous user's library.
                try {
                    const db = await initDatabase();
                    await clearUserData(db);
                } catch (e) {
                    console.warn('[AUTH]: clearUserData failed', e);
                }
            } else if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session) {
                setUser(session.user);
                loadData(session.user.id);
            }
        });

        return () => {
            subscription.remove();
            authSubscription?.subscription?.unsubscribe();
        };
    }, []);

    // Refresh library when the tab regains focus (e.g. after adding a comic in Details)
    // or the app comes back to the foreground: the cloud pull brings in what the
    // scheduled GitHub check found while the app was closed. That check covers
    // the primary sources every few hours, so this phone's own check (which
    // also covers linked sources) runs quietly, and only when its last one is
    // over six hours old. Pull-to-refresh runs one on demand, with progress.
    const CHECK_ON_OPEN_AFTER_MS = 6 * 60 * 60 * 1000;
    const [lastCheckedMs, setLastCheckedMs] = useState<number | null>(null);
    // runCheckAndReload is defined further down; reach it through a ref.
    const runCheckRef = useRef<((opts?: { silent?: boolean }) => Promise<void>) | null>(null);
    const refreshAndMaybeCheck = useCallback(() => {
        if (!user) return;
        // The phone's own check starts only after the cloud sync: run together
        // they compete for the database and the sync took far longer.
        loadData(user.id).finally(async () => {
            try {
                const db = await initDatabase();
                const last = await getSetting(db, 'last_chapter_check', '');
                const lastMs = last ? new Date(last).getTime() : 0;
                setLastCheckedMs(lastMs || null);
                if (Date.now() - lastMs > CHECK_ON_OPEN_AFTER_MS) {
                    runCheckRef.current?.({ silent: true });
                }
            } catch (e) { /* no-op */ }
        });
    }, [user]);

    useFocusEffect(refreshAndMaybeCheck);

    useEffect(() => {
        const sub = AppState.addEventListener('change', state => {
            if (state === 'active') refreshAndMaybeCheck();
        });
        return () => sub.remove();
    }, [refreshAndMaybeCheck]);

    // ---- Derived values (must be declared BEFORE any early return so hook order stays stable) ----
    const availableStatuses = useMemo(() => {
        const set = new Set<string>();
        mangaList.forEach(m => { if (m.status) set.add(m.status); });
        return Array.from(set);
    }, [mangaList]);

    const availableCategories = useMemo(() => {
        const set = new Set<string>();
        mangaList.forEach(m => { if (m.category) set.add(m.category); });
        return Array.from(set);
    }, [mangaList]);

    const displayList = useMemo(() => {
        let list = [...mangaList];
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase().trim();
            list = list.filter(m =>
                (m.title || '').toLowerCase().includes(q) ||
                (m.alternative_names || '').toLowerCase().includes(q) ||
                (m.author || '').toLowerCase().includes(q) ||
                (m.genre || '').toLowerCase().includes(q)
            );
        }
        if (showFavoritesOnly) list = list.filter(m => m.favorite === 'Yes' || m.favorite === 1 || m.favorite === true);
        if (showUpdatesOnly) list = list.filter(m => m.latest_chapter && m.chapter !== m.latest_chapter);
        if (showDownloadedOnly) list = list.filter(m => downloadedMangaUrls.has(m.manga_url));
        if (selectedStatus) list = list.filter(m => m.status === selectedStatus);
        if (selectedCategory) list = list.filter(m => m.category === selectedCategory);

        if (sortBy === 'title') {
            list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        } else if (sortBy === 'latest') {
            // Dates are free text in several formats; compare them as dates.
            list = sortByDateField(list, 'latest_date');
        } else {
            list = sortByDateField(list, 'last_read_date');
        }
        return list;
    }, [mangaList, searchQuery, sortBy, showFavoritesOnly, showUpdatesOnly, showDownloadedOnly, downloadedMangaUrls, selectedStatus, selectedCategory]);

    // What the badge on the sort button counts, named under the search box so
    // a filter saved as a default (Profile → Defaults) is not a mystery "1".
    const activeFilterLabels = [
        showFavoritesOnly ? 'Favorites' : '',
        showUpdatesOnly ? 'With updates' : '',
        showDownloadedOnly ? 'Downloaded' : '',
        selectedStatus,
        selectedCategory,
    ].filter(Boolean);
    const activeFilterCount = activeFilterLabels.length;

    const clearAllFilters = () => {
        setShowFavoritesOnly(false);
        setShowUpdatesOnly(false);
        setShowDownloadedOnly(false);
        setSelectedStatus('');
        setSelectedCategory('');
    };

    // Only called for a redirect that takePendingOAuth() matched to the Google
    // sign-in started in handleGoogleLogin (see services/authRedirect.ts).
    const handleAuthRedirect = async (url: string) => {
        if (!url) return;
        const time = new Date().toLocaleTimeString();
        // Never log the URL itself: it carries the one-time sign-in code.
        console.log(`[${time}] [AUTH]: Handling sign-in redirect (${describeRedirectForLog(url)})`);
        setLoading(true);
        try {
            const params = parseAuthRedirect(url);
            if (params.code) {
                console.log(`[${time}] [AUTH]: PKCE code received — exchanging for session`);
                const { data, error } = await supabase.auth.exchangeCodeForSession(params.code);
                if (error) throw error;
                if (data.session) {
                    console.log(`[${time}] [AUTH SUCCESS]: PKCE session for user ${data.session.user.id}`);
                    setUser(data.session.user);
                    await loadData(data.session.user.id);
                }
                return;
            }
            if (params.error) {
                console.error(`[${time}] [AUTH ERROR]: Provider returned error: ${params.error} — ${params.errorDescription || ''}`);
                setAuthError(params.errorDescription || params.error);
                setLoading(false);
                return;
            }
            // Tokens in the URL fragment (implicit flow) are deliberately not
            // accepted: anyone could craft such a link.
            console.warn(`[${time}] [AUTH]: Redirect had no sign-in code — ignoring`);
            setLoading(false);
        } catch (e: any) {
            console.error(`[${time}] [AUTH ERROR]: ${e.message || e}`);
            setAuthError(e.message);
            setLoading(false);
        }
    };

    const handleLogin = async () => {
        const time = new Date().toLocaleTimeString();
        // The address itself is never logged; device logs can be read by other tools.
        console.log(`[${time}] [AUTH]: Attempting email login`);
        setLoading(true);
        setAuthError('');
        if (!email || !password) {
            setAuthError('Please enter both email and password.');
            setLoading(false);
            return;
        }
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            console.error(`[${time}] [AUTH ERROR]: Login failed`, error.message);
            setAuthError(error.message);
            setLoading(false);
        } else {
            console.log(`[${time}] [AUTH SUCCESS]: User ${data.user?.id} logged in`);
            setUser(data.user);
            await loadData(data.user!.id);
        }
    };

    const handleSignUp = async () => {
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] [AUTH]: Attempting email sign-up`);
        setLoading(true);
        setAuthError('');
        if (!email || !password) {
            setAuthError('Please enter both email and password to sign up.');
            setLoading(false);
            return;
        }
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) {
            console.error(`[${time}] [AUTH ERROR]: SignUp failed`, error.message);
            setAuthError(error.message);
            setLoading(false);
        } else {
            if (data.user && data.session) {
                console.log(`[${time}] [AUTH SUCCESS]: Account created and session started for ${data.user.id}`);
                setUser(data.user);
                await loadData(data.user.id);
            } else {
                console.log(`[${time}] [AUTH INFO]: Account created, waiting for email verification`);
                setAuthError("Account created! Check your email internally if needed.");
                setLoading(false);
            }
        }
    };

    const handleGoogleLogin = async () => {
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] [AUTH]: Initializing Google OAuth Flow`);
        setLoading(true);
        setAuthError('');
        try {
            // The path matters: without it, Expo Go produces "exp://host:port" which has
            // no slash between host and the "?code=..." Supabase appends. Both Supabase's
            // whitelist matcher and iOS's URL handler sometimes fail to match that shape,
            // leaving the user on a blank page after signing in.
            // With a path, we get the well-formed "exp://host:port/--/redirect" instead.
            // Supabase refuses redirect URLs whose host is an IP address, even
            // when they're on the Redirect URLs allow list (verified 2026-10-23),
            // so Expo Go's exp://192.168.x.x:8081/--/redirect always fell back to
            // the Site URL (the desktop app's 127.0.0.1:59021). On iOS the auth
            // session catches its callback scheme itself, whether or not the app
            // registers it, so the app's own scheme works in Expo Go too.
            // Android (Expo Go) still depends on Linking, so it keeps makeRedirectUri.
            const redirectUri = Platform.OS === 'ios'
                ? 'mangatracker://redirect'
                : makeRedirectUri({ scheme: 'mangatracker', path: 'redirect' });
            console.log(`[${time}] [AUTH]: Redirect URI: ${redirectUri}`);
            console.log(`[${time}] [AUTH]: ⚠️ This URI must be added to Supabase → Auth → URL Configuration → Redirect URLs`);

            const { data, error } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: redirectUri,
                    skipBrowserRedirect: true,
                },
            });

            if (error) throw error;

            if (data?.url) {
                // The auth URL itself is not logged: it carries the PKCE challenge.
                const challengeMethod = (data.url.match(/[?&]code_challenge_method=([^&#]*)/) || [])[1] || 'none';
                console.log(`[${time}] [AUTH]: Opening Google Auth Browser (PKCE method: ${challengeMethod})`);
                // Accept exactly one redirect to redirectUri until the browser closes.
                beginOAuth(redirectUri);
                const res = await WebBrowser.openAuthSessionAsync(data.url, redirectUri);
                const resUrl = res.type === 'success' ? res.url : '';
                // Take the redirect before endOAuth clears the pending state.
                const mine = !!resUrl && takePendingOAuth(resUrl);
                endOAuth();
                console.log(`[${time}] [AUTH INFO]: Browser ended type=${res.type}${resUrl ? ` (${describeRedirectForLog(resUrl)})` : ''}`);
                if (mine) {
                    await handleAuthRedirect(resUrl);
                } else if (res.type === 'success') {
                    // The Linking listener already took this redirect and is
                    // handling it (it owns the loading state from here).
                } else if (res.type === 'cancel') {
                    console.warn(`[${time}] [AUTH]: Cancelled. Common causes: (1) tapped Cancel on iOS "wants to use to sign in" dialog, (2) closed the browser, (3) the browser landed on 127.0.0.1 / the Site URL because Supabase → Auth → URL Configuration → Redirect URLs doesn't include ${redirectUri.split('/--/')[0]}/**`);
                    setLoading(false);
                } else {
                    setLoading(false);
                }
            }
        } catch (e: any) {
            endOAuth();
            console.error(`[${time}] [AUTH ERROR]: Google Flow Exception`, e.message || e);
            setAuthError(e.message || 'Google Login failed');
            setLoading(false);
        }
    };

    // When login fires, three triggers (mount useEffect, useFocusEffect, onAuthStateChange)
    // call loadData simultaneously. The mutex (declared up top) makes the second/third bail out.
    const loadData = async (userId: string) => {
        const time = new Date().toLocaleTimeString();
        if (loadingRef.current) {
            console.log(`[${time}] [DATA]: Already syncing — skipping duplicate call`);
            return;
        }
        loadingRef.current = true;
        try {
            console.log(`[${time}] [DATA]: Synchronizing Library for user ${userId}`);
            // Placeholders only for the first load. Later reloads (every time the
            // tab regains focus) update the list in place: swapping it for the
            // loading view unmounted the list and lost the scroll position.
            if (!libraryShownRef.current) setLoading(true);
            const db = await initDatabase();

            // The local library belongs to the account that last synced on this
            // device. Signing in as someone else without signing out first (e.g.
            // a second Google account) must not merge that library into the new
            // account. No recorded owner (first run after this was added) adopts
            // the current account instead of wiping anything.
            const lastUserId = await getSetting(db, 'last_user_id', '');
            if (lastUserId && lastUserId !== userId) {
                console.log(`[${time}] [DATA]: Different account than last sync — clearing this device's library first`);
                await clearUserData(db);
            }
            if (lastUserId !== userId) await setSetting(db, 'last_user_id', userId);

            // Saved library defaults (Profile → Defaults) apply once per session.
            // Applying them on every reload reset a sort or filter picked here
            // each time the tab regained focus (coming back from Details, say).
            if (!defaultsAppliedRef.current) {
                defaultsAppliedRef.current = true;
                try {
                    const savedSort = await getSetting(db, 'library_sort', '');
                    if (savedSort === 'recent' || savedSort === 'title' || savedSort === 'latest') {
                        setSortBy(savedSort);
                    }
                    const favOnly = await getSetting(db, 'library_favorites_only', '0');
                    if (favOnly === '1') setShowFavoritesOnly(true);
                    const upOnly = await getSetting(db, 'library_updates_only', '0');
                    if (upOnly === '1') setShowUpdatesOnly(true);
                } catch (e) {
                    console.warn('[DATA]: failed to read library defaults', e);
                }
            }

            // Paint what this phone already has before touching the network. The
            // cloud pull below, with what the scheduled check found while the
            // app was closed, then updates the list in place.
            if (!libraryShownRef.current) {
                const cached = await getLocalLibrary(db);
                if (cached.length > 0) {
                    setMangaList(cached);
                    setLoading(false);
                    libraryShownRef.current = true;
                }
            }

            if (libraryShownRef.current) setRefreshStatus(SYNC_STATUS);
            // Always sync with Cloud to reflect Desktop changes instantly!
            console.log(`[${time}] [DATA]: Pulling cloud records...`);
            // Two-way: also applies comics added or deleted on another device,
            // and deletions made here while offline (services/librarySync.ts).
            const cloudData = await pullLibraryFromCloudStrict(userId);
            if (cloudData === null) {
                console.warn(`[${time}] [DATA]: Cloud unreachable; showing the local library`);
            } else {
                try {
                    // A comic that is in the library twice (same title from two
                    // sites) becomes one entry with linked sources. Cloud first,
                    // so the restore below agrees with what is written here.
                    const merges = await planLibraryMerges(db);
                    if (merges.length > 0) {
                        const res = await pushAllToCloud(userId, merges.map(m => m.mergedRow));
                        if (res.ok) {
                            await applyLibraryMerges(db, merges);
                            for (const m of merges) {
                                const rec = cloudData.find((r: any) => typeof r?.title === 'string' && r.title.trim().toLowerCase() === m.title.trim().toLowerCase());
                                if (rec) {
                                    rec.manga_url = m.keepUrl;
                                    rec.linked_sources = m.linkedSources;
                                    rec.chapter = m.chapter;
                                    rec.last_read_date = m.lastReadDate;
                                }
                            }
                        } else {
                            console.warn(`[${time}] [DATA]: Could not push merged duplicates: ${res.error}`);
                        }
                    }
                    await syncLibraryWithCloud(db, userId, cloudData);
                    // One-time split of the old rating column (services/rating.ts),
                    // after the pull so the corrected ratings go up to the cloud
                    // instead of the old ones coming down again.
                    const changedTitles = await migrateRatingColumns(db);
                    if (changedTitles.length > 0) {
                        const changedSet = new Set(changedTitles);
                        const rows = (await getLocalLibrary(db)).filter((r: any) => changedSet.has(r.title));
                        const res = await pushAllToCloud(userId, rows);
                        if (!res.ok) console.warn(`[${time}] [DATA]: Could not push ${rows.length} migrated rating(s) to the cloud: ${res.error}`);
                    }
                } catch (e: any) {
                    console.error(`[${time}] [DATA ERROR]: Cloud sync failed; showing the local library`, e?.message || e);
                }
            }

            console.log(`[${time}] [DATA]: Fetching local library...`);
            let localData = await getLocalLibrary(db);

            // Sync configs
            console.log(`[${time}] [DATA]: Checking scraper configs...`);
            // Configs are pulled on every load so fixes uploaded with
            // utils/upload_scrapers.py reach existing installs. An empty or
            // failed pull keeps the local copy. With no local copy yet, wait for
            // the pull; otherwise refresh in the background so the library
            // isn't held up by the network.
            const refreshConfigs = async () => {
                const cloudConfigs = await fetchScraperConfigsFromCloud();
                if (cloudConfigs && cloudConfigs.length > 0) {
                    await bulkRestoreConfigs(db, cloudConfigs);
                    console.log(`[${time}] [DATA]: Refreshed ${cloudConfigs.length} scraper configs from cloud`);
                }
            };
            let localConfigs = await getLocalConfigs(db);
            if (localConfigs.length === 0) {
                console.log(`[${time}] [DATA]: Local configs empty, pulling from cloud...`);
                await refreshConfigs();
            } else {
                refreshConfigs().catch(e => console.warn('[DATA]: config refresh failed', e));
            }

            console.log(`[${time}] [DATA SUCCESS]: Loaded ${localData.length} manga into dashboard`);
            setMangaList(localData);
            libraryShownRef.current = true;
            try {
                const dlSet = await getAllDownloadedMangaUrls(db);
                setDownloadedMangaUrls(dlSet);
            } catch (e) {
                console.warn('[DATA]: failed to read downloaded set', e);
            }

        } catch (e: any) {
            console.error(`[${time}] [DATA ERROR]: Sync failed`, e.message || e);
        } finally {
            loadingRef.current = false;
            setRefreshStatus(prev => (prev === SYNC_STATUS ? '' : prev));
            setLoading(false);
            setRefreshing(false);
        }
    };

    // Pull-to-refresh now triggers a per-comic chapter check (not a cloud pull).
    // Updates SQLite rows directly via runChapterCheck, then reloads local list so
    // the UI shows fresh `latest_chapter` values. Cloud sync still happens on tab
    // focus (useFocusEffect → loadData), so this PTR is purely "check for new chapters".
    const [refreshStatus, setRefreshStatus] = useState<string>('');
    const checkInFlightRef = useRef(false);
    const checkLoudRef = useRef(false);

    const runCheckAndReload = useCallback(async (opts?: { silent?: boolean }) => {
        if (checkInFlightRef.current) return;
        checkInFlightRef.current = true;
        // Quiet unless the user pulls to refresh while it runs (checkLoudRef).
        const quiet = () => !!opts?.silent && !checkLoudRef.current;
        if (!quiet()) setRefreshStatus('Checking for new chapters…');
        try {
            const result = await runChapterCheck((done, total) => {
                if (!quiet()) setRefreshStatus(`Checking for new chapters ${done}/${total}`);
            });
            setLastCheckedMs(Date.now());
            try {
                const db = await initDatabase();
                const fresh = await getLocalLibrary(db);
                setMangaList(fresh);
            } catch (e) { /* keep current list */ }
            if (!quiet()) {
                const msg = result.updated > 0
                    ? `${result.updated} new chapter${result.updated === 1 ? '' : 's'}`
                    : result.failures > 0 && result.failures === result.checked
                        ? 'Could not reach any sources'
                        : 'Up to date';
                setRefreshStatus(msg);
                setTimeout(() => setRefreshStatus(''), 2500);
            }
        } catch (e: any) {
            if (!quiet()) {
                setRefreshStatus('Check failed');
                setTimeout(() => setRefreshStatus(''), 2500);
            }
        } finally {
            checkInFlightRef.current = false;
            checkLoudRef.current = false;
        }
    }, []);
    runCheckRef.current = runCheckAndReload;

    const handleRefresh = () => {
        if (!user) return;
        // A quiet check is already running: show its progress instead of
        // ignoring the pull.
        if (checkInFlightRef.current) {
            checkLoudRef.current = true;
            setRefreshStatus('Checking for new chapters…');
            return;
        }
        if (loadingRef.current) return;
        setRefreshing(true);
        runCheckAndReload().finally(() => setRefreshing(false));
    };

    // Stable callback so memoized MangaCard items don't re-render on unrelated state changes.
    const handleCardLongPress = useCallback((m: any) => setActionMenuManga(m), []);

    const renderMangaItem = useCallback(
        ({ item }: { item: any }) => <MangaCard manga={item} onLongPress={handleCardLongPress} />,
        [handleCardLongPress]
    );

    const keyExtractor = useCallback((item: any) => item.id?.toString() || item.title, []);

    if (loading) {
        // If we have a logged-in user, show a content-shaped skeleton (feels faster than a spinner).
        // For the auth check (no user yet), keep a centered spinner since we don't know if there's data.
        if (user) {
            return (
                <View style={styles.container}>
                    <SkeletonGrid count={6} />
                </View>
            );
        }
        return (
            <View style={styles.centerBox}>
                <ActivityIndicator size="large" color="#E15053" />
                <Text style={{color: colors.textMuted, marginTop: 12}}>Loading your library...</Text>
            </View>
        );
    }

    if (!user) {
        return (
            <View style={styles.authContainer}>
                <Text style={styles.authTitle}>Sign In</Text>
                <Text style={styles.authSub}>Sync your library directly to your iPhone</Text>
                {authError ? <Text style={styles.errorText}>{authError}</Text> : null}
                <TextInput
                    style={styles.input}
                    placeholder="Email"
                    placeholderTextColor={colors.textDim}
                    value={email}
                    onChangeText={setEmail}
                    autoCapitalize="none"
                />
                <TextInput
                    style={styles.input}
                    placeholder="Password"
                    placeholderTextColor={colors.textDim}
                    secureTextEntry
                    value={password}
                    onChangeText={setPassword}
                />
                <TouchableOpacity style={styles.btn} onPress={handleLogin}>
                    <Text style={styles.btnText}>Login / Restore Data</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, { marginTop: 12, backgroundColor: '#2A2A2D' }]} onPress={handleSignUp}>
                    <Text style={styles.btnText}>Create Account</Text>
                </TouchableOpacity>

                <View style={{flexDirection: 'row', alignItems: 'center', marginVertical: 20}}>
                    <View style={{flex: 1, height: 1, backgroundColor: '#2A2A2D'}} />
                    <Text style={{color: colors.textMuted, paddingHorizontal: 10}}>OR</Text>
                    <View style={{flex: 1, height: 1, backgroundColor: '#2A2A2D'}} />
                </View>

                <TouchableOpacity style={[styles.btn, { backgroundColor: '#FFFFFF' }]} onPress={handleGoogleLogin}>
                    <Text style={[styles.btnText, { color: '#0F0F11' }]}>Continue with Google</Text>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.libHeader}>
                <View style={styles.libSearchRow}>
                    <TextInput
                        style={styles.libSearchInput}
                        placeholder="Search your library..."
                        placeholderTextColor={colors.textMuted}
                        value={searchInput}
                        onChangeText={setSearchInput}
                        autoCorrect={false}
                        clearButtonMode="while-editing"
                    />
                    <TouchableOpacity
                        style={[styles.libFilterBtn, (sortBy !== 'recent' || activeFilterCount > 0) && styles.libFilterBtnActive]}
                        onPress={() => setFilterModalOpen(true)}
                        activeOpacity={0.7}
                    >
                        <Text style={styles.libFilterBtnText}>{SORT_LABELS[sortBy]}</Text>
                        {activeFilterCount > 0 && (
                            <View style={styles.libFilterBadge}>
                                <Text style={styles.libFilterBadgeText}>{activeFilterCount}</Text>
                            </View>
                        )}
                    </TouchableOpacity>
                </View>
                {(searchInput || activeFilterCount > 0) && (
                    <Text style={styles.libCountText}>
                        {displayList.length} of {mangaList.length}{activeFilterLabels.length > 0 ? ` · ${activeFilterLabels.join(', ')}` : ''}
                    </Text>
                )}
                {refreshStatus ? (
                    <Text style={[styles.libCountText, { color: colors.accent }]}>{refreshStatus}</Text>
                ) : lastCheckedMs ? (
                    <Text style={styles.libCountText}>Checked {formatAgo(lastCheckedMs)}</Text>
                ) : null}
            </View>

            <FlatList
                data={displayList}
                keyExtractor={keyExtractor}
                numColumns={2}
                contentContainerStyle={{ padding: 8, alignItems: 'center' }}
                renderItem={renderMangaItem}
                keyboardShouldPersistTaps="handled"
                removeClippedSubviews
                initialNumToRender={8}
                maxToRenderPerBatch={8}
                windowSize={10}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={handleRefresh}
                        tintColor={colors.accent}
                        colors={[colors.accent]}
                    />
                }
                ListEmptyComponent={
                    mangaList.length === 0 ? (
                        <View style={styles.emptyBox}>
                            <Text style={styles.emptyEmoji}>📚</Text>
                            <Text style={styles.emptyTitle}>Your library is empty</Text>
                            <Text style={styles.emptyBody}>Add comics here from the Explore tab. Once added, they'll sync to all your devices.</Text>
                            <TouchableOpacity style={styles.emptyCta} onPress={() => router.push('/(tabs)/explore')} activeOpacity={0.8}>
                                <Text style={styles.emptyCtaText}>Discover comics →</Text>
                            </TouchableOpacity>
                        </View>
                    ) : (
                        <View style={styles.emptyBox}>
                            <Text style={styles.emptyEmoji}>🔍</Text>
                            <Text style={styles.emptyTitle}>No matches</Text>
                            <Text style={styles.emptyBody}>Nothing matches your search and filters.</Text>
                            {(activeFilterCount > 0 || searchInput) && (
                                <TouchableOpacity style={styles.emptyCta} onPress={() => { setSearchInput(''); setSearchQuery(''); clearAllFilters(); }} activeOpacity={0.8}>
                                    <Text style={styles.emptyCtaText}>Clear filters</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    )
                }
            />

            <Modal visible={filterModalOpen} transparent animationType="slide" onRequestClose={() => setFilterModalOpen(false)}>
                <Pressable style={styles.libModalBackdrop} onPress={() => setFilterModalOpen(false)}>
                    <Pressable style={styles.libModalSheet} onPress={() => { /* swallow */ }}>
                        <View style={styles.libModalHandle} />
                        <View style={styles.libModalTitleRow}>
                            <Text style={styles.libModalTitle}>Sort & Filter</Text>
                            {(activeFilterCount > 0 || sortBy !== 'recent') && (
                                <TouchableOpacity onPress={() => { clearAllFilters(); setSortBy('recent'); }}>
                                    <Text style={styles.libModalReset}>Reset</Text>
                                </TouchableOpacity>
                            )}
                        </View>

                        <ScrollView style={{ maxHeight: 480 }}>
                            <View style={styles.libSection}>
                                <Text style={styles.libSectionLabel}>Sort by</Text>
                                <View style={styles.libChipsWrap}>
                                    {(['recent', 'title', 'latest'] as SortKey[]).map(key => {
                                        const active = sortBy === key;
                                        const fullLabel = key === 'recent' ? 'Recently Read' : key === 'title' ? 'Title A-Z' : 'Latest Update';
                                        return (
                                            <TouchableOpacity
                                                key={key}
                                                style={[styles.libChip, active && styles.libChipActive]}
                                                onPress={() => setSortBy(key)}
                                            >
                                                <Text style={[styles.libChipText, active && styles.libChipTextActive]}>{fullLabel}</Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>
                            </View>

                            <View style={styles.libSection}>
                                <Text style={styles.libSectionLabel}>Quick filters</Text>
                                <View style={styles.libChipsWrap}>
                                    <TouchableOpacity
                                        style={[styles.libChip, showFavoritesOnly && styles.libChipActive]}
                                        onPress={() => setShowFavoritesOnly(v => !v)}
                                    >
                                        <Text style={[styles.libChipText, showFavoritesOnly && styles.libChipTextActive]}>★ Favorites</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        style={[styles.libChip, showUpdatesOnly && styles.libChipActive]}
                                        onPress={() => setShowUpdatesOnly(v => !v)}
                                    >
                                        <Text style={[styles.libChipText, showUpdatesOnly && styles.libChipTextActive]}>Has new chapters</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        style={[styles.libChip, showDownloadedOnly && styles.libChipActive]}
                                        onPress={() => setShowDownloadedOnly(v => !v)}
                                    >
                                        <Text style={[styles.libChipText, showDownloadedOnly && styles.libChipTextActive]}>Downloaded</Text>
                                    </TouchableOpacity>
                                </View>
                            </View>

                            {availableCategories.length > 0 && (
                                <View style={styles.libSection}>
                                    <Text style={styles.libSectionLabel}>Category</Text>
                                    <View style={styles.libChipsWrap}>
                                        <TouchableOpacity
                                            style={[styles.libChip, !selectedCategory && styles.libChipActive]}
                                            onPress={() => setSelectedCategory('')}
                                        >
                                            <Text style={[styles.libChipText, !selectedCategory && styles.libChipTextActive]}>All</Text>
                                        </TouchableOpacity>
                                        {availableCategories.map(c => {
                                            const active = selectedCategory === c;
                                            return (
                                                <TouchableOpacity
                                                    key={c}
                                                    style={[styles.libChip, active && styles.libChipActive]}
                                                    onPress={() => setSelectedCategory(active ? '' : c)}
                                                >
                                                    <Text style={[styles.libChipText, active && styles.libChipTextActive]}>{c}</Text>
                                                </TouchableOpacity>
                                            );
                                        })}
                                    </View>
                                </View>
                            )}

                            {availableStatuses.length > 0 && (
                                <View style={styles.libSection}>
                                    <Text style={styles.libSectionLabel}>Status</Text>
                                    <View style={styles.libChipsWrap}>
                                        <TouchableOpacity
                                            style={[styles.libChip, !selectedStatus && styles.libChipActive]}
                                            onPress={() => setSelectedStatus('')}
                                        >
                                            <Text style={[styles.libChipText, !selectedStatus && styles.libChipTextActive]}>All</Text>
                                        </TouchableOpacity>
                                        {availableStatuses.map(s => {
                                            const active = selectedStatus === s;
                                            return (
                                                <TouchableOpacity
                                                    key={s}
                                                    style={[styles.libChip, active && styles.libChipActive]}
                                                    onPress={() => setSelectedStatus(active ? '' : s)}
                                                >
                                                    <Text style={[styles.libChipText, active && styles.libChipTextActive]}>{s}</Text>
                                                </TouchableOpacity>
                                            );
                                        })}
                                    </View>
                                </View>
                            )}
                        </ScrollView>

                        <TouchableOpacity style={styles.libModalDone} onPress={() => setFilterModalOpen(false)}>
                            <Text style={styles.libModalDoneText}>Done</Text>
                        </TouchableOpacity>
                    </Pressable>
                </Pressable>
            </Modal>

            {/* Long-press action sheet */}
            <Modal visible={!!actionMenuManga} transparent animationType="slide" onRequestClose={() => setActionMenuManga(null)}>
                <Pressable style={styles.actionBackdrop} onPress={() => setActionMenuManga(null)}>
                    <Pressable style={styles.actionSheet} onPress={() => { /* swallow */ }}>
                        <View style={styles.actionHandle} />
                        <Text style={styles.actionTitle} numberOfLines={2}>{actionMenuManga?.title}</Text>
                        <View style={styles.actionList}>
                            <ActionRow icon="checkmark-done-outline" label="Mark all chapters as read" onPress={() => actionMenuManga && handleMarkAllRead(actionMenuManga)} colors={colors} />
                            <ActionRow icon="refresh-outline" label="Reset reading progress" onPress={() => actionMenuManga && handleMarkUnread(actionMenuManga)} colors={colors} />
                            <ActionRow
                                icon={(actionMenuManga?.favorite === 'Yes' || actionMenuManga?.favorite === 1) ? 'star' : 'star-outline'}
                                label={(actionMenuManga?.favorite === 'Yes' || actionMenuManga?.favorite === 1) ? 'Remove from favorites' : 'Add to favorites'}
                                onPress={() => actionMenuManga && handleToggleFavorite(actionMenuManga)}
                                colors={colors}
                            />
                            <ActionRow icon="share-outline" label="Share" onPress={() => actionMenuManga && handleShare(actionMenuManga)} colors={colors} />
                            <ActionRow icon="trash-outline" label="Remove from library" onPress={() => actionMenuManga && handleRemoveFromLibrary(actionMenuManga)} colors={colors} destructive />
                        </View>
                        <TouchableOpacity style={styles.actionCancel} onPress={() => setActionMenuManga(null)}>
                            <Text style={styles.actionCancelText}>Cancel</Text>
                        </TouchableOpacity>
                    </Pressable>
                </Pressable>
            </Modal>
        </View>
    );
}

const ActionRow = ({ icon, label, onPress, destructive, colors }: { icon: any; label: string; onPress: () => void; destructive?: boolean; colors: any }) => (
    <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 }} onPress={onPress} activeOpacity={0.6}>
        <Ionicons name={icon} size={20} color={destructive ? colors.destructive : colors.textMuted} style={{ marginRight: 14 }} />
        <Text style={{ color: destructive ? colors.destructive : colors.text, fontSize: 15, fontWeight: '500' }}>{label}</Text>
    </TouchableOpacity>
);

const makeStyles = (c: AppColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    centerBox: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: c.bg },
    authContainer: { flex: 1, backgroundColor: c.bg, justifyContent: 'center', padding: 20 },
    authTitle: { fontSize: 28, fontWeight: 'bold', color: c.text, textAlign: 'center', marginBottom: 8 },
    authSub: { fontSize: 14, color: c.textMuted, textAlign: 'center', marginBottom: 24 },
    input: { backgroundColor: c.surface, color: c.text, borderRadius: 8, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: c.border },
    btn: { backgroundColor: c.accent, padding: 16, borderRadius: 8, alignItems: 'center' },
    btnText: { color: '#fff', fontWeight: 'bold' },
    errorText: { color: c.destructive, marginBottom: 12, textAlign: 'center' },

    /* Library header */
    libHeader: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
    libSearchRow: { flexDirection: 'row', alignItems: 'center' },
    libSearchInput: { flex: 1, height: 38, backgroundColor: c.inputBg, borderRadius: 8, paddingHorizontal: 12, color: c.text, fontSize: 14 },
    libFilterBtn: {
        flexDirection: 'row', alignItems: 'center',
        marginLeft: 8, paddingHorizontal: 12, height: 38,
        backgroundColor: c.chipBg, borderRadius: 8,
        borderWidth: 1, borderColor: 'transparent',
    },
    libFilterBtnActive: { borderColor: c.accent },
    libFilterBtnText: { color: c.text, fontSize: 13, fontWeight: '600' },
    libFilterBadge: { marginLeft: 6, backgroundColor: c.accent, borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
    libFilterBadgeText: { color: '#FFF', fontSize: 10, fontWeight: 'bold' },
    libCountText: { color: c.textMuted, fontSize: 11, marginTop: 6 },

    /* Action sheet */
    actionBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    actionSheet: { backgroundColor: c.surfaceAlt, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 8, paddingBottom: 24 },
    actionHandle: { alignSelf: 'center', width: 36, height: 4, backgroundColor: c.border, borderRadius: 2, marginBottom: 12 },
    actionTitle: { color: c.text, fontSize: 15, fontWeight: '700', paddingHorizontal: 16, paddingBottom: 8 },
    actionList: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, marginTop: 4 },
    actionCancel: { marginHorizontal: 16, marginTop: 16, paddingVertical: 13, backgroundColor: c.chipBg, borderRadius: 10, alignItems: 'center' },
    actionCancelText: { color: c.text, fontWeight: '700', fontSize: 14 },

    /* Empty states */
    emptyBox: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 60 },
    emptyEmoji: { fontSize: 56, marginBottom: 12 },
    emptyTitle: { color: c.text, fontSize: 17, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
    emptyBody: { color: c.textMuted, fontSize: 13, lineHeight: 19, textAlign: 'center', marginBottom: 20 },
    emptyCta: { backgroundColor: c.accent, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 22 },
    emptyCtaText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },

    /* Library filter modal */
    libModalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    libModalSheet: { backgroundColor: c.surfaceAlt, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 },
    libModalHandle: { alignSelf: 'center', width: 36, height: 4, backgroundColor: c.border, borderRadius: 2, marginBottom: 12 },
    libModalTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    libModalTitle: { color: c.text, fontSize: 16, fontWeight: 'bold' },
    libModalReset: { color: c.accent, fontSize: 13, fontWeight: '600' },
    libSection: { marginBottom: 16 },
    libSectionLabel: { color: c.textMuted, fontSize: 11, fontWeight: '700', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
    libChipsWrap: { flexDirection: 'row', flexWrap: 'wrap' },
    libChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: c.chipBg, marginRight: 6, marginBottom: 6, borderWidth: 1, borderColor: 'transparent' },
    libChipActive: { backgroundColor: 'transparent', borderColor: c.accent },
    libChipText: { color: c.chipText, fontWeight: '600', fontSize: 12 },
    libChipTextActive: { color: c.accent },
    libModalDone: { backgroundColor: c.accent, borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginTop: 12 },
    libModalDoneText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
});
