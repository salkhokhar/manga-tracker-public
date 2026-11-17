import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, ViewStyle } from 'react-native';
import { useAppTheme } from '../services/theme';

/* Tiny shared pulsing animation. Loops between 0.35 and 1.0 opacity over ~1.4s. */
function useSkeletonAnim() {
    const opacity = useRef(new Animated.Value(0.5)).current;
    useEffect(() => {
        const loop = Animated.loop(
            Animated.sequence([
                Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
                Animated.timing(opacity, { toValue: 0.35, duration: 700, useNativeDriver: true }),
            ])
        );
        loop.start();
        return () => loop.stop();
    }, [opacity]);
    return opacity;
}

/* Single rectangle skeleton — building block for everything else. */
export const SkeletonBlock = ({ style }: { style?: ViewStyle | ViewStyle[] }) => {
    const opacity = useSkeletonAnim();
    const { colors } = useAppTheme();
    return <Animated.View style={[{ backgroundColor: colors.chipBg, borderRadius: 6, opacity }, style]} />;
};

/* Mimics a MangaCard while data loads. */
export const SkeletonCard = () => {
    const { colors } = useAppTheme();
    return (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <SkeletonBlock style={{ width: '100%', height: 220, borderRadius: 0 }} />
            <View style={{ padding: 12 }}>
                <SkeletonBlock style={{ height: 12, marginBottom: 8, width: '95%' }} />
                <SkeletonBlock style={{ height: 12, marginBottom: 12, width: '70%' }} />
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <SkeletonBlock style={{ height: 10, width: 50 }} />
                    <SkeletonBlock style={{ height: 10, width: 50 }} />
                </View>
            </View>
        </View>
    );
};

/* A 2-column grid of skeleton cards for use in loading states. */
export const SkeletonGrid = ({ count = 6 }: { count?: number }) => (
    <View style={styles.grid}>
        {Array.from({ length: count }).map((_, i) => <SkeletonCard key={i} />)}
    </View>
);

/* A skeleton chapter row for the Details screen. */
export const SkeletonChapterRow = () => {
    const { colors } = useAppTheme();
    return (
        <View style={[styles.chapterRow, { borderBottomColor: colors.border }]}>
            <View style={{ flex: 1 }}>
                <SkeletonBlock style={{ height: 12, width: '60%', marginBottom: 6 }} />
                <SkeletonBlock style={{ height: 10, width: '30%' }} />
            </View>
            <SkeletonBlock style={{ width: 22, height: 22, borderRadius: 11, marginLeft: 8 }} />
        </View>
    );
};

const styles = StyleSheet.create({
    card: {
        width: 160,
        borderRadius: 12,
        overflow: 'hidden',
        borderWidth: 1,
        margin: 8,
    },
    grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', padding: 8 },
    chapterRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 14,
        borderBottomWidth: 1,
    },
});
