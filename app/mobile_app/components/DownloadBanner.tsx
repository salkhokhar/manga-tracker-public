import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getQueue, subscribe, dequeue, QueueItem } from '../services/downloadQueue';
import { useAppTheme } from '../services/theme';

/**
 * Floating banner that appears at the top of the screen whenever there are
 * pending or active downloads. Visible across all screens (mounted in root layout).
 */
export function DownloadBanner() {
    const [items, setItems] = useState<QueueItem[]>(getQueue());
    const { colors } = useAppTheme();
    const insets = useSafeAreaInsets();

    useEffect(() => {
        return subscribe(() => setItems(getQueue()));
    }, []);

    const active = items.find(i => i.status === 'active');
    const pending = items.filter(i => i.status === 'pending');
    const lastCompleted = !active && pending.length === 0
        ? items.find(i => i.status === 'done' || i.status === 'failed')
        : null;

    if (!active && pending.length === 0 && !lastCompleted) return null;

    // While downloading: show progress; while idle but with finished items: show success briefly
    const showItem: QueueItem | null = active || pending[0] || lastCompleted || null;
    if (!showItem) return null;

    const progressPct = showItem.total > 0 ? Math.round((showItem.completed / showItem.total) * 100) : 0;
    const isDone = showItem.status === 'done';
    const isFailed = showItem.status === 'failed';

    const accentColor = isFailed ? colors.destructive : isDone ? colors.success : colors.accent;
    const icon = isFailed ? 'alert-circle' : isDone ? 'checkmark-circle' : 'cloud-download';

    return (
        <View
            pointerEvents="box-none"
            style={[styles.wrapper, { top: insets.top + 4 }]}
        >
            <View style={[styles.banner, { backgroundColor: colors.surface, borderColor: colors.border, shadowColor: '#000' }]}>
                <View style={styles.row}>
                    <Ionicons name={icon as any} size={18} color={accentColor} />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
                            {isDone ? 'Downloaded' : isFailed ? 'Download failed' : 'Downloading'}{' · '}{showItem.chapterTitle}
                        </Text>
                        <Text style={[styles.subtext, { color: colors.textMuted }]} numberOfLines={1}>
                            {isFailed ? (showItem.error || 'unknown error')
                                : isDone ? showItem.mangaTitle
                                : `${showItem.completed} / ${showItem.total} pages${pending.length > 0 ? `  ·  +${pending.length} queued` : ''}`}
                        </Text>
                    </View>
                    {!isDone && !isFailed && (
                        // Show cancel button for both pending and active items.
                        // Pending: removed immediately. Active: flagged; worker bails between images.
                        <TouchableOpacity onPress={() => dequeue(showItem.chapterUrl)} hitSlop={8} style={{ padding: 4 }}>
                            <Ionicons name="close" size={18} color={colors.textMuted} />
                        </TouchableOpacity>
                    )}
                </View>
                {!isDone && !isFailed && (
                    <View style={[styles.progressTrack, { backgroundColor: colors.chipBg }]}>
                        <View style={[styles.progressFill, { backgroundColor: accentColor, width: `${progressPct}%` }]} />
                    </View>
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    wrapper: {
        position: 'absolute', left: 0, right: 0,
        zIndex: 1000, elevation: 1000,
        paddingHorizontal: 12,
    },
    banner: {
        borderRadius: 10, borderWidth: 1, padding: 10,
        shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 6,
    },
    row: { flexDirection: 'row', alignItems: 'center' },
    title: { fontSize: 13, fontWeight: '700' },
    subtext: { fontSize: 11, marginTop: 2 },
    progressTrack: { height: 3, borderRadius: 2, marginTop: 8, overflow: 'hidden' },
    progressFill: { height: '100%', borderRadius: 2 },
});
