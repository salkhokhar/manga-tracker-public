import React, { useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, Image, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme, AppColors } from '../services/theme';

// Many manga CDNs hotlink-protect cover images. Match the Referer to the origin site.
function getHeaders(url: string) {
    if (!url) return undefined;
    if (url.includes('webtoons.com') || url.includes('nhentai') || url.includes('pstatic.net')) {
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
}

// Human-readable source name derived from the manga's host. Used as a small badge
// so the library shows which site a comic was added from. Falls back to the first
// hostname segment for sites we haven't explicitly named.
const SOURCE_NAMES: Record<string, string> = {
    'asurascans.com': 'Asura',
    'asuracomic.net': 'Asura',
    'toonily.com': 'Toonily',
    'manhuatop.org': 'ManhuaTop',
    'mangaread.org': 'MangaRead',
    'arenascan.com': 'Arena',
    'kingofshojo.com': 'KingOfShojo',
    'gourmetsupremacy.com': 'Gourmet',
    'mangaclash.com': 'MangaClash',
    'toonclash.com': 'MangaClash',
    'webtoons.com': 'Webtoons',
};
function getSourceName(mangaUrl: string | undefined): string {
    if (!mangaUrl) return '';
    let host = '';
    try { host = new URL(mangaUrl).hostname.replace(/^www\./, ''); }
    catch {
        const m = mangaUrl.match(/^(?:https?:\/\/)?(?:www\.)?([^/:?#]+)/i);
        host = m ? m[1] : '';
    }
    if (!host) return '';
    return SOURCE_NAMES[host] || host.split('.')[0];
}

function MangaCard({
    manga, onPress, onLongPress,
}: {
    manga: any;
    onPress?: () => void;
    onLongPress?: (manga: any) => void;
}) {
    const router = useRouter();
    const { colors } = useAppTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const handlePress = () => {
        const time = new Date().toLocaleTimeString();
        console.log(`[${time}] [USER CLICK]: Tapped comic "${manga.title || manga.alternative_names}"`);
        if (onPress) {
            onPress();
        } else {
            router.push({
                pathname: '/details',
                params: {
                    title: manga.title || manga.alternative_names,
                    cover_url: manga.cover_url,
                    manga_url: manga.manga_url || manga.link
                }
            });
        }
    };

    const handleLongPress = useCallback(() => {
        onLongPress?.(manga);
    }, [onLongPress, manga]);

    return (
        <Pressable onPress={handlePress} onLongPress={handleLongPress} delayLongPress={350} style={({ pressed }) => [
            styles.card,
            { opacity: pressed ? 0.8 : 1 }
        ]}>
            {manga.cover_url ? (
                <Image
                    source={{
                        uri: manga.cover_url,
                        headers: getHeaders(manga.cover_url)
                    }}
                    style={styles.cover}
                    resizeMode="cover"
                />
            ) : (
                <View style={[styles.cover, styles.placeholderCover]}>
                    <Text style={styles.placeholderText}>No Image</Text>
                </View>
            )}
            {(manga.favorite === 'Yes' || manga.favorite === 1 || manga.favorite === true) && (
                <View style={styles.favoriteBadge}>
                    <Ionicons name="star" size={14} color="#FFD43B" />
                </View>
            )}
            {(() => {
                const src = getSourceName(manga.manga_url || manga.link);
                return src ? (
                    <View style={styles.sourceBadge}>
                        <Text style={styles.sourceBadgeText} numberOfLines={1}>{src}</Text>
                    </View>
                ) : null;
            })()}
            
            <View style={styles.content}>
                <Text style={styles.title} numberOfLines={2}>{manga.title || manga.alternative_names}</Text>
                
                {manga.status === 'Completed' && (
                    <Text style={styles.statusCompleted}>● Completed</Text>
                )}

                <View style={styles.infoGrid}>
                    <View style={styles.infoCol}>
                        <Text style={styles.label}>READ</Text>
                        <Text style={styles.val}>{manga.chapter || '—'}</Text>
                    </View>
                    <View style={styles.infoCol}>
                        <Text style={[styles.label, { color: colors.accent }]}>LATEST</Text>
                        <Text style={styles.val}>{manga.latest_chapter || '—'}</Text>
                        {/* M2: set by runChapterCheck when a linked source (not the
                            primary) reported the latest chapter. */}
                        {manga.latest_source ? (
                            <Text style={styles.latestSource} numberOfLines={1}>via {manga.latest_source}</Text>
                        ) : null}
                    </View>
                </View>

                {manga.last_read_date ? (
                    <Text style={styles.date}>{manga.last_read_date}</Text>
                ) : null}
            </View>
        </Pressable>
    );
}

// Default shallow compare: `manga` identity is preserved across renders for
// unchanged items (parent uses .map immutably), and `onLongPress` is stable
// via useCallback in the parent — so only changed rows re-render.
export default React.memo(MangaCard);

const makeStyles = (c: AppColors) => StyleSheet.create({
    card: {
        width: 160,
        backgroundColor: c.surface,
        borderRadius: 12,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: c.border,
        margin: 8,
    },
    cover: {
        width: '100%',
        height: 220,
    },
    placeholderCover: {
        backgroundColor: c.chipBg,
        justifyContent: 'center',
        alignItems: 'center',
    },
    placeholderText: {
        color: c.textMuted,
        fontSize: 12,
    },
    favoriteBadge: {
        position: 'absolute', top: 6, right: 6,
        backgroundColor: 'rgba(0,0,0,0.6)',
        borderRadius: 12, padding: 4,
    },
    sourceBadge: {
        position: 'absolute', top: 6, left: 6,
        backgroundColor: 'rgba(0,0,0,0.7)',
        borderRadius: 4,
        paddingHorizontal: 6, paddingVertical: 2,
        maxWidth: '70%',
    },
    sourceBadgeText: {
        color: '#fff',
        fontSize: 9,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.3,
    },
    content: {
        padding: 12,
    },
    title: {
        color: c.text,
        fontSize: 13,
        fontWeight: '700',
        marginBottom: 8,
    },
    statusCompleted: {
        color: c.success,
        fontSize: 10,
        fontWeight: '700',
        marginBottom: 6,
    },
    infoGrid: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 'auto',
    },
    infoCol: {
        alignItems: 'flex-start',
    },
    label: {
        fontSize: 9,
        fontWeight: 'bold',
        color: c.textMuted,
        marginBottom: 2,
    },
    val: {
        fontSize: 12,
        color: c.text,
        fontWeight: '600',
    },
    latestSource: {
        fontSize: 9,
        color: c.textMuted,
        marginTop: 1,
        maxWidth: 70,
    },
    date: {
        fontSize: 10,
        color: c.textDim,
        marginTop: 8,
        textAlign: 'right',
    }
});
