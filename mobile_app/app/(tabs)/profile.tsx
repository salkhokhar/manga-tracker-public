import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator, Modal, Pressable, TextInput, KeyboardAvoidingView, Platform, Image, Dimensions, Linking } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

// Pre-compute fixed pixel sizes for the avatar grid so images don't blow up if percentage layouts misbehave
const SCREEN_WIDTH = Dimensions.get('window').width;
const AVATAR_GRID_PADDING = 16; // matches modalSheet horizontal padding
const AVATAR_GRID_GAP = 8;
const AVATAR_GRID_COLS = 3;
const AVATAR_TILE_SIZE = Math.floor(
    (SCREEN_WIDTH - AVATAR_GRID_PADDING * 2 - AVATAR_GRID_GAP * (AVATAR_GRID_COLS - 1)) / AVATAR_GRID_COLS
);
const AVATAR_IMAGE_SIZE = AVATAR_TILE_SIZE - 12; // minus tile padding
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { supabase, pushAllToCloud, deleteAccountFromCloud, pullLibraryFromCloud, getUsername, setUsernameInCloud, validateUsernameFormat } from '../../services/supabase';
import { initDatabase, getLocalLibrary, bulkRestoreLocal, getSetting, setSetting, getLocalConfigs } from '../../services/database';
import { getDownloadsSummary, deleteAllDownloads } from '../../services/downloads';
import {
    isBackgroundCheckEnabled,
    enableBackgroundCheck,
    disableBackgroundCheck,
    runChapterCheck,
    getBackgroundFetchStatus,
    getLastCheckTime,
    IS_EXPO_GO,
} from '../../services/notifications';
import { useAppTheme, AppColors, ThemeMode } from '../../services/theme';
import { AVATARS, getAvatarById } from '../../assets/avatars';

const APP_VERSION = '1.0.0';
// Update this URL with your real Buy Me a Coffee / Ko-fi / PayPal link
const DONATE_URL = 'https://www.buymeacoffee.com/salkhokhar';

const SORT_OPTIONS = ['Newest', 'Latest', 'Popular', 'Rating', 'A-Z'];
const THEME_OPTIONS: ThemeMode[] = ['system', 'dark', 'light'];
const LIBRARY_SORT_OPTIONS = [
    { label: 'Recently Read', value: 'recent' },
    { label: 'Title A-Z', value: 'title' },
    { label: 'Latest Update', value: 'latest' },
];
const LIBRARY_FILTER_OPTIONS = [
    { label: 'Show all', value: 'all' },
    { label: 'Favorites only', value: 'favorites' },
    { label: 'With new chapters only', value: 'updates' },
];

export default function ProfileScreen() {
    const router = useRouter();
    const { colors, mode: themeMode, setMode: setThemeMode } = useAppTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [user, setUser] = useState<any>(null);
    const [username, setUsername] = useState<string>('');
    const [mangaList, setMangaList] = useState<any[]>([]);
    const [sources, setSources] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [pulling, setPulling] = useState(false);
    const [lastSync, setLastSync] = useState<string | null>(null);

    // Settings (persisted in SQLite)
    const [defaultSource, setDefaultSourceState] = useState('');
    const [defaultSort, setDefaultSortState] = useState('');
    const [defaultExploreType, setDefaultExploreTypeState] = useState('');
    const [librarySort, setLibrarySortState] = useState('recent');
    const [libraryFilter, setLibraryFilterState] = useState('all');

    // Picker modal state — single modal that adapts to whichever setting is being edited
    const [pickerOpen, setPickerOpen] = useState(false);
    const [pickerKind, setPickerKind] = useState<'source' | 'sort' | 'explore_type' | 'theme' | 'lib_sort' | 'lib_filter' | null>(null);

    // Username editor state
    const [usernameModalOpen, setUsernameModalOpen] = useState(false);
    const [usernameInput, setUsernameInput] = useState('');
    const [usernameError, setUsernameError] = useState<string | null>(null);
    const [savingUsername, setSavingUsername] = useState(false);

    // Avatar state
    const [avatarId, setAvatarIdState] = useState<string | null>(null);
    const [avatarModalOpen, setAvatarModalOpen] = useState(false);
    const [savingAvatar, setSavingAvatar] = useState(false);

    // Storage stats
    const [storage, setStorage] = useState<{ chapterCount: number; totalBytes: number }>({ chapterCount: 0, totalBytes: 0 });
    const [clearingDownloads, setClearingDownloads] = useState(false);

    // Notifications
    const [notifEnabled, setNotifEnabled] = useState(false);
    const [notifBusy, setNotifBusy] = useState(false);
    const [bgStatus, setBgStatus] = useState<string>('unknown');
    const [lastCheck, setLastCheck] = useState<string | null>(null);
    const [checkingNow, setCheckingNow] = useState(false);

    const refresh = async () => {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            setUser(session?.user || null);

            const db = await initDatabase();

            if (session?.user) {
                const [list, name, avatar, src, srt, expType, libSrt, libFlt, configs] = await Promise.all([
                    getLocalLibrary(db),
                    getUsername(session.user.id, session.user.email),
                    getSetting(db, 'avatar', ''),
                    getSetting(db, 'default_source', ''),
                    getSetting(db, 'default_sort', ''),
                    getSetting(db, 'default_explore_type', ''),
                    getSetting(db, 'library_sort', 'recent'),
                    getSetting(db, 'library_favorites_only', '0').then(async fav => {
                        if (fav === '1') return 'favorites';
                        const upd = await getSetting(db, 'library_updates_only', '0');
                        return upd === '1' ? 'updates' : 'all';
                    }),
                    getLocalConfigs(db),
                ]);
                setMangaList(list);
                setUsername(name);
                setAvatarIdState(avatar || null);
                // Storage summary
                try {
                    const s = await getDownloadsSummary();
                    setStorage(s);
                } catch (e) { console.warn('[PROFILE]: storage fetch failed', e); }
                // Notification status
                try {
                    const [enabled, status, last] = await Promise.all([
                        isBackgroundCheckEnabled(),
                        getBackgroundFetchStatus(),
                        getLastCheckTime(),
                    ]);
                    setNotifEnabled(enabled);
                    setBgStatus(status);
                    setLastCheck(last);
                } catch (e) { console.warn('[PROFILE]: notif status failed', e); }
                setDefaultSourceState(src);
                setDefaultSortState(srt);
                setDefaultExploreTypeState(expType);
                setLibrarySortState(libSrt || 'recent');
                setLibraryFilterState(libFlt);
                setSources(configs);
            } else {
                setMangaList([]);
                setUsername('');
                setAvatarIdState(null);
                setSources([]);
            }
        } catch (e) {
            console.error('[PROFILE]: refresh failed', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { refresh(); }, []);
    useFocusEffect(useCallback(() => { refresh(); }, []));

    const stats = useMemo(() => ({
        total: mangaList.length,
        favorites: mangaList.filter(m => m.favorite === 'Yes' || m.favorite === 1).length,
        updates: mangaList.filter(m => m.latest_chapter && m.chapter !== m.latest_chapter).length,
        completed: mangaList.filter(m => m.status === 'Completed').length,
    }), [mangaList]);

    const handleSync = async () => {
        if (!user || syncing) return;
        setSyncing(true);
        try {
            const db = await initDatabase();
            const list = await getLocalLibrary(db);
            const result = await pushAllToCloud(user.id, list);
            if (result.ok) {
                setLastSync(new Date().toLocaleTimeString());
                Alert.alert('Synced', `Pushed ${result.pushed} comics to cloud.`);
            } else {
                Alert.alert('Sync failed', result.error || 'Unknown error');
            }
        } catch (e: any) {
            Alert.alert('Sync failed', e.message || 'Unknown error');
        } finally {
            setSyncing(false);
        }
    };

    const handlePull = () => {
        if (!user || pulling) return;
        Alert.alert(
            'Pull from cloud?',
            'This replaces your local library with whatever is in the cloud. Anything not yet synced will be lost.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Pull', style: 'destructive', onPress: async () => {
                        setPulling(true);
                        try {
                            const cloud = await pullLibraryFromCloud(user.id);
                            const db = await initDatabase();
                            await bulkRestoreLocal(db, cloud);
                            const fresh = await getLocalLibrary(db);
                            setMangaList(fresh);
                            setLastSync(new Date().toLocaleTimeString());
                            Alert.alert('Pulled', `Restored ${cloud.length} comics from cloud.`);
                        } catch (e: any) {
                            Alert.alert('Pull failed', e.message || 'Unknown error');
                        } finally {
                            setPulling(false);
                        }
                    }
                }
            ]
        );
    };

    const handleSignOut = () => {
        Alert.alert('Sign out', 'You can sign back in any time.', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Sign out', style: 'destructive', onPress: async () => {
                    await supabase.auth.signOut();
                    setUser(null);
                    setMangaList([]);
                    router.replace('/(tabs)/');
                }
            }
        ]);
    };

    const handleDeleteAccount = () => {
        Alert.alert(
            'Delete account?',
            'This permanently deletes your account, your cloud library, and all reading history. Local copies on this device stay until you uninstall. This cannot be undone.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete', style: 'destructive', onPress: async () => {
                        if (!user) return;
                        const result = await deleteAccountFromCloud();
                        if (result.ok) {
                            await supabase.auth.signOut();
                            Alert.alert('Account deleted', 'Your account has been removed.');
                            setUser(null);
                            router.replace('/(tabs)/');
                        } else {
                            Alert.alert('Delete failed', result.error || 'Could not delete account.');
                        }
                    }
                }
            ]
        );
    };

    /* ------ Username editor ------ */
    const openUsernameEditor = () => {
        setUsernameInput(username);
        setUsernameError(null);
        setUsernameModalOpen(true);
    };

    const saveUsername = async () => {
        if (!user || savingUsername) return;
        const trimmed = usernameInput.trim();
        if (trimmed === username) {
            setUsernameModalOpen(false);
            return;
        }
        const formatErr = validateUsernameFormat(trimmed);
        if (formatErr) {
            setUsernameError(formatErr);
            return;
        }
        setSavingUsername(true);
        setUsernameError(null);
        try {
            const result = await setUsernameInCloud(user.id, trimmed);
            if (result.ok) {
                setUsername(trimmed);
                setUsernameModalOpen(false);
            } else {
                setUsernameError(result.error || 'Could not save username');
            }
        } catch (e: any) {
            setUsernameError(e.message || 'Something went wrong');
        } finally {
            setSavingUsername(false);
        }
    };

    /* ------ Notifications ------ */
    const handleToggleNotifs = async (next: boolean) => {
        if (notifBusy) return;
        setNotifBusy(true);
        try {
            if (next) {
                const r = await enableBackgroundCheck();
                if (r.ok) {
                    setNotifEnabled(true);
                    Alert.alert('Notifications enabled', 'You\'ll be alerted when new chapters arrive. Background frequency is decided by iOS — usually a few times per day.');
                } else if (r.expoGoLimited) {
                    Alert.alert('Expo Go limitation', r.error || 'Background tasks need a dev build.');
                } else {
                    Alert.alert('Could not enable', r.error || 'Unknown error');
                }
            } else {
                await disableBackgroundCheck();
                setNotifEnabled(false);
            }
        } finally {
            setNotifBusy(false);
        }
    };

    const handleCheckNow = async () => {
        if (checkingNow) return;
        setCheckingNow(true);
        try {
            const r = await runChapterCheck();
            setLastCheck(new Date().toISOString());
            if (r.updated > 0) {
                Alert.alert('Done', `${r.updated} new chapter${r.updated === 1 ? '' : 's'} found across ${r.checked} comics. Check your notifications.`);
            } else {
                Alert.alert('All caught up', `Checked ${r.checked} comics, nothing new.${r.failures > 0 ? ` (${r.failures} failed — likely Cloudflare-protected.)` : ''}`);
            }
        } catch (e: any) {
            Alert.alert('Check failed', e.message || 'Unknown error');
        } finally {
            setCheckingNow(false);
        }
    };

    /* ------ Storage ------ */
    const formatBytes = (n: number): string => {
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
        return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
    };

    const handleClearAllDownloads = () => {
        if (storage.chapterCount === 0) {
            Alert.alert('Nothing to clear', 'You have no downloaded chapters.');
            return;
        }
        Alert.alert(
            'Clear all downloads?',
            `This deletes ${storage.chapterCount} chapter${storage.chapterCount === 1 ? '' : 's'} (${formatBytes(storage.totalBytes)}) from this device. Your library and reading progress are not affected. You can re-download anytime.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete', style: 'destructive', onPress: async () => {
                        setClearingDownloads(true);
                        try {
                            const removed = await deleteAllDownloads();
                            setStorage({ chapterCount: 0, totalBytes: 0 });
                            Alert.alert('Cleared', `Removed ${removed} chapters from local storage.`);
                        } catch (e: any) {
                            Alert.alert('Failed', e.message || 'Unknown error');
                        } finally {
                            setClearingDownloads(false);
                        }
                    }
                }
            ]
        );
    };

    /* ------ Donate ------ */
    const handleDonate = async () => {
        const canOpen = await Linking.canOpenURL(DONATE_URL);
        if (canOpen) {
            Linking.openURL(DONATE_URL);
        } else {
            Alert.alert('Could not open link', DONATE_URL);
        }
    };

    /* ------ CSV export ------ */
    const csvEscape = (val: any): string => {
        const s = (val ?? '').toString();
        if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
            return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
    };

    const handleExportCSV = async () => {
        if (!mangaList.length) {
            Alert.alert('Library is empty', 'Add some comics first, then export.');
            return;
        }
        try {
            const db = await initDatabase();
            // Count downloaded chapters per manga
            const dlRows = await db.getAllAsync<{ manga_url: string; cnt: number }>(
                'SELECT manga_url, COUNT(*) as cnt FROM downloaded_chapters GROUP BY manga_url'
            );
            const dlCount: Record<string, number> = {};
            dlRows.forEach(r => { dlCount[r.manga_url] = r.cnt; });

            const headers = [
                'Title', 'URL', 'Author', 'Genre', 'Status', 'Category',
                'Current Chapter', 'Last Read Date', 'Latest Chapter', 'Latest Date',
                'Rating', 'Favorite', 'Notes', 'Description', 'Cover URL', 'Downloaded Chapters',
            ];
            const rows = mangaList.map(m => [
                m.title, m.manga_url, m.author, m.genre, m.status, m.category,
                m.chapter, m.last_read_date, m.latest_chapter, m.latest_date,
                m.rating, m.favorite ? 'Yes' : '', m.notes, m.description, m.cover_url,
                dlCount[m.manga_url] || 0,
            ]);
            const csv = [
                headers.map(csvEscape).join(','),
                ...rows.map(r => r.map(csvEscape).join(',')),
            ].join('\n');

            const filename = `manga-library-${new Date().toISOString().split('T')[0]}.csv`;
            const uri = (FileSystem.documentDirectory || '') + filename;
            await FileSystem.writeAsStringAsync(uri, csv);

            const sharingAvailable = await Sharing.isAvailableAsync();
            if (sharingAvailable) {
                await Sharing.shareAsync(uri, {
                    mimeType: 'text/csv',
                    dialogTitle: 'Export library',
                    UTI: 'public.comma-separated-values-text',
                });
            } else {
                Alert.alert('Saved', `CSV saved to: ${uri}`);
            }
        } catch (e: any) {
            console.error('[EXPORT]: failed', e);
            Alert.alert('Export failed', e.message || 'Unknown error');
        }
    };

    /* ------ Avatar picker (local-only — stays in SQLite, not synced to cloud) ------ */
    const handlePickAvatar = async (id: string) => {
        if (savingAvatar) return;
        setSavingAvatar(true);
        try {
            const db = await initDatabase();
            await setSetting(db, 'avatar', id);
            setAvatarIdState(id);
            setAvatarModalOpen(false);
        } catch (e: any) {
            Alert.alert('Could not save avatar', e.message || 'Unknown error');
        } finally {
            setSavingAvatar(false);
        }
    };

    /* ------ Settings handlers ------ */
    const openPicker = (kind: 'source' | 'sort' | 'explore_type' | 'theme' | 'lib_sort' | 'lib_filter') => {
        setPickerKind(kind);
        setPickerOpen(true);
    };

    const writeSetting = async (key: string, value: string) => {
        const db = await initDatabase();
        await setSetting(db, key, value);
    };

    const handlePickerSelect = async (value: string) => {
        if (pickerKind === 'source') { setDefaultSourceState(value); await writeSetting('default_source', value); }
        else if (pickerKind === 'sort') { setDefaultSortState(value); await writeSetting('default_sort', value); }
        else if (pickerKind === 'explore_type') { setDefaultExploreTypeState(value); await writeSetting('default_explore_type', value); }
        else if (pickerKind === 'theme') { await setThemeMode(value as ThemeMode); }
        else if (pickerKind === 'lib_sort') { setLibrarySortState(value); await writeSetting('library_sort', value); }
        else if (pickerKind === 'lib_filter') {
            setLibraryFilterState(value);
            await writeSetting('library_favorites_only', value === 'favorites' ? '1' : '0');
            await writeSetting('library_updates_only', value === 'updates' ? '1' : '0');
        }
        setPickerOpen(false);
    };

    // Aggregate every distinct primary type that any loaded config offers, so the
    // "Default type" picker only lists options that exist somewhere in your sources.
    // Mirrors getPrimaryTypes() in explore.tsx (splits c.type on " - " and takes [0]).
    const availableExploreTypes = useMemo(() => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const cfg of sources) {
            const cats = cfg?.json_rules?.explore_categories || [];
            for (const c of cats) {
                const primary = ((c.type || '').split(' - ')[0] || '').trim();
                if (primary && !seen.has(primary)) {
                    seen.add(primary);
                    result.push(primary);
                }
            }
        }
        return result.sort();
    }, [sources]);

    const pickerOptions = useMemo(() => {
        if (pickerKind === 'source') return [{ label: 'No default (use first)', value: '' }, ...sources.map(s => ({ label: s.website_name, value: s.website_name }))];
        if (pickerKind === 'sort') return [{ label: 'No default (use first)', value: '' }, ...SORT_OPTIONS.map(s => ({ label: s, value: s }))];
        if (pickerKind === 'explore_type') return [{ label: 'No default (use first)', value: '' }, ...availableExploreTypes.map(t => ({ label: t, value: t }))];
        if (pickerKind === 'theme') return THEME_OPTIONS.map(t => ({ label: t === 'system' ? 'Match system' : t === 'dark' ? 'Dark' : 'Light', value: t }));
        if (pickerKind === 'lib_sort') return LIBRARY_SORT_OPTIONS;
        if (pickerKind === 'lib_filter') return LIBRARY_FILTER_OPTIONS;
        return [];
    }, [pickerKind, sources, availableExploreTypes]);

    const pickerCurrent =
        pickerKind === 'source' ? defaultSource :
        pickerKind === 'sort' ? defaultSort :
        pickerKind === 'explore_type' ? defaultExploreType :
        pickerKind === 'theme' ? themeMode :
        pickerKind === 'lib_sort' ? librarySort :
        pickerKind === 'lib_filter' ? libraryFilter : '';

    const pickerTitle =
        pickerKind === 'source' ? 'Default source' :
        pickerKind === 'sort' ? 'Default sort (Explore)' :
        pickerKind === 'explore_type' ? 'Default type (Explore)' :
        pickerKind === 'theme' ? 'Theme' :
        pickerKind === 'lib_sort' ? 'Default library sort' :
        pickerKind === 'lib_filter' ? 'Default library filter' : '';

    /* ------ Render ------ */

    if (loading) {
        return <View style={styles.centerBox}><ActivityIndicator size="large" color="#E15053" /></View>;
    }

    if (!user) {
        return (
            <View style={styles.centerBox}>
                <Ionicons name="person-circle-outline" size={64} color="#3A3A3D" />
                <Text style={styles.signedOutTitle}>Not signed in</Text>
                <Text style={styles.signedOutBody}>Open the Library tab and sign in to see your profile.</Text>
                <TouchableOpacity style={styles.primaryBtn} onPress={() => router.replace('/(tabs)/')}>
                    <Text style={styles.primaryBtnText}>Go to Library</Text>
                </TouchableOpacity>
            </View>
        );
    }

    const initials = (username || user.email || '?').slice(0, 2).toUpperCase();
    const chosenAvatar = getAvatarById(avatarId);

    return (
        <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 32 }}>
            <View style={styles.identityBlock}>
                <TouchableOpacity onPress={() => setAvatarModalOpen(true)} activeOpacity={0.8} style={styles.avatarTouchable}>
                    {chosenAvatar ? (
                        <Image source={chosenAvatar.source} style={styles.avatarImage} resizeMode="cover" />
                    ) : (
                        <View style={styles.avatar}>
                            <Text style={styles.avatarText}>{initials}</Text>
                        </View>
                    )}
                    <View style={styles.avatarEditBadge}>
                        <Ionicons name="pencil" size={12} color="#FFF" />
                    </View>
                </TouchableOpacity>
                <TouchableOpacity onPress={openUsernameEditor} activeOpacity={0.7} style={styles.usernameRow}>
                    <Text style={styles.username} numberOfLines={1}>{username}</Text>
                    <Ionicons name="pencil" size={14} color={colors.textMuted} style={{ marginLeft: 8 }} />
                </TouchableOpacity>
                <Text style={styles.email} numberOfLines={1}>{user.email}</Text>
            </View>

            <Section label="Library">
                <View style={styles.statsRow}>
                    <Stat value={stats.total} label="Total" />
                    <Stat value={stats.favorites} label="Favorites" />
                    <Stat value={stats.updates} label="New" />
                    <Stat value={stats.completed} label="Done" />
                </View>
            </Section>

            <Section label="Notifications">
                <Row
                    icon={notifEnabled ? 'notifications' : 'notifications-outline'}
                    label={notifEnabled ? 'New chapter alerts: ON' : 'New chapter alerts: OFF'}
                    sublabel={
                        IS_EXPO_GO
                            ? 'Background checks unavailable in Expo Go. Use "Check now" — or build a dev client for automatic alerts.'
                            : notifEnabled
                                ? `iOS decides cadence (typically 2-6× per day).${bgStatus !== 'available' ? ` System status: ${bgStatus}.` : ''}`
                                : 'Get a push when new chapters drop in your library.'
                    }
                    onPress={() => handleToggleNotifs(!notifEnabled)}
                    busy={notifBusy}
                />
                <Row
                    icon="refresh-outline"
                    label={checkingNow ? 'Checking...' : 'Check for new chapters now'}
                    sublabel={lastCheck ? `Last check: ${new Date(lastCheck).toLocaleString()}` : 'Never run'}
                    onPress={handleCheckNow}
                    busy={checkingNow}
                    last
                />
            </Section>

            <Section label="Sync">
                <Row icon="cloud-upload-outline" label={syncing ? 'Pushing...' : 'Push library to cloud'} sublabel={lastSync ? `Last action at ${lastSync}` : undefined} onPress={handleSync} busy={syncing} />
                <Row icon="cloud-download-outline" label={pulling ? 'Pulling...' : 'Pull library from cloud'} sublabel="Replaces local data with cloud" onPress={handlePull} busy={pulling} last />
            </Section>

            <Section label="Storage">
                <Row
                    icon="folder-outline"
                    label="Downloaded chapters"
                    value={storage.chapterCount === 0 ? 'None' : `${storage.chapterCount} · ${formatBytes(storage.totalBytes)}`}
                />
                <Row
                    icon="trash-outline"
                    label={clearingDownloads ? 'Clearing...' : 'Clear all downloads'}
                    onPress={handleClearAllDownloads}
                    busy={clearingDownloads}
                    destructive
                    last
                />
            </Section>

            <Section label="Explore defaults">
                <Row icon="globe-outline" label="Default source" value={defaultSource || 'First available'} onPress={() => openPicker('source')} />
                <Row icon="layers-outline" label="Default type" value={defaultExploreType || 'First available'} onPress={() => openPicker('explore_type')} />
                <Row icon="swap-vertical-outline" label="Default sort" value={defaultSort || 'First available'} onPress={() => openPicker('sort')} last />
            </Section>

            <Section label="Library defaults">
                <Row icon="reorder-three-outline" label="Sort" value={LIBRARY_SORT_OPTIONS.find(o => o.value === librarySort)?.label || 'Recently Read'} onPress={() => openPicker('lib_sort')} />
                <Row icon="funnel-outline" label="Filter" value={LIBRARY_FILTER_OPTIONS.find(o => o.value === libraryFilter)?.label || 'Show all'} onPress={() => openPicker('lib_filter')} last />
            </Section>

            <Section label="Appearance">
                <Row icon="moon-outline" label="Theme" value={themeMode === 'system' ? 'System' : themeMode === 'dark' ? 'Dark' : 'Light'} onPress={() => openPicker('theme')} last />
            </Section>

            <Section label="Data">
                <Row icon="download-outline" label="Export library as CSV" sublabel="Includes notes, progress, downloads, everything" onPress={handleExportCSV} last />
            </Section>

            <View style={styles.section}>
                <Text style={styles.sectionLabel}>Support the developer</Text>
                <View style={styles.supportCard}>
                    <View style={styles.supportEmojiRow}>
                        <Text style={styles.supportEmoji}>☕</Text>
                    </View>
                    <Text style={styles.supportTitle}>Built with love over 1000+ hours</Text>
                    <Text style={styles.supportBody}>
                        This app is a labour of love — completely ad-free, no tracking, no nonsense.
                        If it makes your reading life better, consider buying me a coffee. Every cup
                        keeps the late-night coding fueled.
                    </Text>
                    <TouchableOpacity style={styles.supportBtn} onPress={handleDonate} activeOpacity={0.8}>
                        <Ionicons name="cafe" size={16} color="#FFF" style={{ marginRight: 6 }} />
                        <Text style={styles.supportBtnText}>Buy me a coffee</Text>
                    </TouchableOpacity>
                </View>
            </View>

            <Section label="App">
                <Row icon="information-circle-outline" label="Version" value={APP_VERSION} last />
            </Section>

            <Section label="Account">
                <Row icon="log-out-outline" label="Sign out" onPress={handleSignOut} />
                <Row icon="trash-outline" label="Delete account" onPress={handleDeleteAccount} destructive last />
            </Section>

            {/* Avatar picker modal */}
            <Modal visible={avatarModalOpen} transparent animationType="slide" onRequestClose={() => setAvatarModalOpen(false)}>
                <Pressable style={styles.modalBackdrop} onPress={() => setAvatarModalOpen(false)}>
                    <Pressable style={styles.modalSheet} onPress={() => { /* swallow */ }}>
                        <View style={styles.modalHandle} />
                        <Text style={styles.modalTitle}>Choose your avatar</Text>
                        <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={styles.avatarGrid}>
                            {AVATARS.map((a, idx) => {
                                const selected = avatarId === a.id;
                                const isLastInRow = (idx + 1) % 3 === 0;
                                return (
                                    <TouchableOpacity
                                        key={a.id}
                                        onPress={() => handlePickAvatar(a.id)}
                                        disabled={savingAvatar}
                                        style={[styles.avatarOption, isLastInRow && { marginRight: 0 }, selected && styles.avatarOptionSelected]}
                                        activeOpacity={0.7}
                                    >
                                        <Image source={a.source} style={styles.avatarOptionImage} resizeMode="cover" />
                                        {selected && (
                                            <View style={styles.avatarOptionCheck}>
                                                <Ionicons name="checkmark-circle" size={22} color={colors.accent} />
                                            </View>
                                        )}
                                        <Text style={styles.avatarOptionLabel} numberOfLines={1}>{a.name}</Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </ScrollView>
                        {savingAvatar && (
                            <View style={{ paddingVertical: 8, alignItems: 'center' }}>
                                <ActivityIndicator size="small" color={colors.accent} />
                            </View>
                        )}
                    </Pressable>
                </Pressable>
            </Modal>

            {/* Username edit modal */}
            <Modal visible={usernameModalOpen} transparent animationType="slide" onRequestClose={() => setUsernameModalOpen(false)}>
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
                    <Pressable style={styles.modalBackdrop} onPress={() => setUsernameModalOpen(false)}>
                        <Pressable style={styles.modalSheet} onPress={() => { /* swallow */ }}>
                            <View style={styles.modalHandle} />
                            <Text style={styles.modalTitle}>Edit username</Text>
                            <Text style={styles.usernameHelp}>3–20 characters. Letters, numbers, and underscores only. Synced across devices.</Text>
                            <TextInput
                                style={styles.usernameInput}
                                value={usernameInput}
                                onChangeText={(t) => { setUsernameInput(t); setUsernameError(null); }}
                                autoCapitalize="none"
                                autoCorrect={false}
                                placeholder="your_username"
                                placeholderTextColor={colors.textDim}
                                maxLength={20}
                            />
                            {usernameError && <Text style={styles.usernameError}>{usernameError}</Text>}
                            <View style={styles.usernameButtonRow}>
                                <TouchableOpacity style={[styles.usernameBtn, styles.usernameBtnSecondary]} onPress={() => setUsernameModalOpen(false)} disabled={savingUsername}>
                                    <Text style={styles.usernameBtnSecondaryText}>Cancel</Text>
                                </TouchableOpacity>
                                <TouchableOpacity style={[styles.usernameBtn, styles.usernameBtnPrimary]} onPress={saveUsername} disabled={savingUsername}>
                                    {savingUsername ? <ActivityIndicator color="#fff" /> : <Text style={styles.usernameBtnPrimaryText}>Save</Text>}
                                </TouchableOpacity>
                            </View>
                        </Pressable>
                    </Pressable>
                </KeyboardAvoidingView>
            </Modal>

            {/* Picker modal */}
            <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
                <Pressable style={styles.modalBackdrop} onPress={() => setPickerOpen(false)}>
                    <Pressable style={styles.modalSheet} onPress={() => { /* swallow */ }}>
                        <View style={styles.modalHandle} />
                        <Text style={styles.modalTitle}>{pickerTitle}</Text>
                        <ScrollView style={{ maxHeight: 480 }}>
                            {pickerOptions.map((opt, idx) => {
                                const active = pickerCurrent === opt.value;
                                return (
                                    <TouchableOpacity key={idx} style={[styles.modalRow, active && styles.modalRowActive]} onPress={() => handlePickerSelect(opt.value)}>
                                        <Text style={[styles.modalRowText, active && styles.modalRowTextActive]}>{opt.label}</Text>
                                        {active && <Text style={styles.modalCheck}>✓</Text>}
                                    </TouchableOpacity>
                                );
                            })}
                        </ScrollView>
                    </Pressable>
                </Pressable>
            </Modal>
        </ScrollView>
    );
}

/* ---------- Small UI primitives (theme-aware) ---------- */

const Section = ({ label, children }: { label: string; children: React.ReactNode }) => {
    const { colors } = useAppTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    return (
        <View style={styles.section}>
            <Text style={styles.sectionLabel}>{label}</Text>
            <View style={styles.sectionInner}>{children}</View>
        </View>
    );
};

const Stat = ({ value, label }: { value: number; label: string }) => {
    const { colors } = useAppTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    return (
        <View style={styles.statBox}>
            <Text style={styles.statValue}>{value}</Text>
            <Text style={styles.statLabel}>{label}</Text>
        </View>
    );
};

const Row = ({
    icon, label, sublabel, value, onPress, destructive, busy, last,
}: {
    icon?: any; label: string; sublabel?: string; value?: string;
    onPress?: () => void; destructive?: boolean; busy?: boolean; last?: boolean;
}) => {
    const { colors } = useAppTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const content = (
        <View style={[styles.row, last && { borderBottomWidth: 0 }]}>
            {icon && <Ionicons name={icon} size={20} color={destructive ? colors.destructive : colors.textMuted} style={{ marginRight: 12 }} />}
            <View style={{ flex: 1 }}>
                <Text style={[styles.rowLabel, destructive && { color: colors.destructive }]}>{label}</Text>
                {sublabel && <Text style={styles.rowSublabel}>{sublabel}</Text>}
            </View>
            {busy && <ActivityIndicator size="small" color={colors.accent} style={{ marginRight: 4 }} />}
            {value && <Text style={styles.rowValue}>{value}</Text>}
            {onPress && !value && <Ionicons name="chevron-forward" size={18} color={colors.textDim} />}
            {onPress && value && <Ionicons name="chevron-forward" size={16} color={colors.textDim} style={{ marginLeft: 4 }} />}
        </View>
    );
    if (onPress) return <TouchableOpacity activeOpacity={0.6} onPress={onPress} disabled={busy}>{content}</TouchableOpacity>;
    return content;
};

/* ---------- Styles ---------- */

const makeStyles = (c: AppColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    centerBox: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: c.bg, padding: 24 },

    signedOutTitle: { color: c.text, fontSize: 18, fontWeight: '700', marginTop: 16 },
    signedOutBody: { color: c.textMuted, fontSize: 13, textAlign: 'center', marginTop: 8 },
    primaryBtn: { backgroundColor: c.accent, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8, marginTop: 24 },
    primaryBtnText: { color: '#FFF', fontWeight: 'bold' },

    identityBlock: { alignItems: 'center', paddingVertical: 28, paddingHorizontal: 16, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
    avatarTouchable: { marginBottom: 12, position: 'relative' },
    avatar: { width: 84, height: 84, borderRadius: 42, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    avatarImage: { width: 84, height: 84, borderRadius: 42, backgroundColor: c.chipBg, borderWidth: 2, borderColor: c.surface },
    avatarText: { color: '#FFF', fontSize: 28, fontWeight: 'bold' },
    avatarEditBadge: {
        position: 'absolute', bottom: 0, right: 0,
        width: 26, height: 26, borderRadius: 13,
        backgroundColor: c.accent,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: c.surface,
    },
    usernameRow: { flexDirection: 'row', alignItems: 'center' },
    username: { color: c.text, fontSize: 20, fontWeight: '700' },
    email: { color: c.textMuted, fontSize: 12, marginTop: 4 },

    /* Avatar picker grid — fixed pixel sizing so it never blows up */
    avatarGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 4 },
    avatarOption: {
        width: AVATAR_TILE_SIZE,
        marginBottom: 14,
        marginRight: AVATAR_GRID_GAP,
        alignItems: 'center',
        padding: 6,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: 'transparent',
    },
    avatarOptionSelected: { borderColor: c.accent, backgroundColor: c.chipBg },
    avatarOptionImage: { width: AVATAR_IMAGE_SIZE, height: AVATAR_IMAGE_SIZE, borderRadius: 8, backgroundColor: c.chipBg },
    avatarOptionCheck: { position: 'absolute', top: 4, right: 4, backgroundColor: c.surfaceAlt, borderRadius: 11 },
    avatarOptionLabel: { color: c.textMuted, fontSize: 10, marginTop: 6, textAlign: 'center', width: AVATAR_IMAGE_SIZE },

    /* Username edit modal */
    usernameHelp: { color: c.textMuted, fontSize: 12, lineHeight: 17, marginBottom: 12 },
    usernameInput: { backgroundColor: c.inputBg, color: c.text, borderRadius: 8, paddingHorizontal: 14, height: 44, fontSize: 15 },
    usernameError: { color: c.destructive, fontSize: 12, marginTop: 8 },
    usernameButtonRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16 },
    usernameBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8, marginLeft: 8, minWidth: 80, alignItems: 'center' },
    usernameBtnSecondary: { backgroundColor: c.chipBg },
    usernameBtnSecondaryText: { color: c.text, fontWeight: '600' },
    usernameBtnPrimary: { backgroundColor: c.accent },
    usernameBtnPrimaryText: { color: '#FFF', fontWeight: 'bold' },

    section: { marginTop: 20, paddingHorizontal: 16 },
    sectionLabel: { color: c.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8, paddingHorizontal: 4 },
    sectionInner: { backgroundColor: c.surface, borderRadius: 12, overflow: 'hidden' },

    /* Support / donate card */
    supportCard: { backgroundColor: c.surface, borderRadius: 12, padding: 18, alignItems: 'center', borderWidth: 1, borderColor: c.border },
    supportEmojiRow: { marginBottom: 10 },
    supportEmoji: { fontSize: 38 },
    supportTitle: { color: c.text, fontSize: 15, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
    supportBody: { color: c.textMuted, fontSize: 13, lineHeight: 19, textAlign: 'center', marginBottom: 14 },
    supportBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.accent, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 24 },
    supportBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },

    statsRow: { flexDirection: 'row', paddingVertical: 16 },
    statBox: { flex: 1, alignItems: 'center' },
    statValue: { color: c.text, fontSize: 22, fontWeight: 'bold' },
    statLabel: { color: c.textMuted, fontSize: 11, marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.4 },

    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    rowLabel: { color: c.text, fontSize: 14, fontWeight: '500' },
    rowSublabel: { color: c.textMuted, fontSize: 11, marginTop: 2 },
    rowValue: { color: c.textMuted, fontSize: 13 },

    /* Picker modal */
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    modalSheet: { backgroundColor: c.surfaceAlt, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 },
    modalHandle: { alignSelf: 'center', width: 36, height: 4, backgroundColor: c.border, borderRadius: 2, marginBottom: 12 },
    modalTitle: { color: c.text, fontSize: 16, fontWeight: 'bold', marginBottom: 12 },
    modalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 12, borderRadius: 8, marginBottom: 4 },
    modalRowActive: { backgroundColor: c.chipBg },
    modalRowText: { color: c.text, fontSize: 14, fontWeight: '500' },
    modalRowTextActive: { color: c.accent, fontWeight: '700' },
    modalCheck: { color: c.accent, fontSize: 16, fontWeight: 'bold' },
});
