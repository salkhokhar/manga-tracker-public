import React, { createContext, useContext, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { initDatabase, getSetting, setSetting } from './database';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface AppColors {
    bg: string;          // page background
    surface: string;     // raised cards / headers
    surfaceAlt: string;  // alt cards (e.g. modal sheets)
    border: string;
    text: string;
    textMuted: string;
    textDim: string;
    accent: string;      // brand red
    destructive: string;
    success: string;
    chipBg: string;
    chipText: string;
    inputBg: string;
}

export const darkColors: AppColors = {
    bg: '#0F0F11',
    surface: '#1E1E20',
    surfaceAlt: '#18181A',
    border: '#2A2A2D',
    text: '#FFFFFF',
    textMuted: '#8A8A8E',
    textDim: '#666666',
    accent: '#E15053',
    destructive: '#FF453A',
    success: '#34C759',
    chipBg: '#2A2A2D',
    chipText: '#8A8A8E',
    inputBg: '#2A2A2D',
};

export const lightColors: AppColors = {
    bg: '#F4F4F6',
    surface: '#FFFFFF',
    surfaceAlt: '#FFFFFF',
    border: '#E2E2E5',
    text: '#1A1A1C',
    textMuted: '#6E6E73',
    textDim: '#A0A0A5',
    accent: '#D63B3F',
    destructive: '#D70015',
    success: '#16A34A',
    chipBg: '#EEEEF0',
    chipText: '#6E6E73',
    inputBg: '#EEEEF0',
};

interface ThemeContextValue {
    mode: ThemeMode;
    isDark: boolean;
    colors: AppColors;
    setMode: (mode: ThemeMode) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue>({
    mode: 'system',
    isDark: true,
    colors: darkColors,
    setMode: async () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const systemScheme = useColorScheme();
    const [mode, setModeState] = useState<ThemeMode>('system');
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const db = await initDatabase();
                const saved = await getSetting(db, 'theme', 'system');
                setModeState((saved as ThemeMode) || 'system');
            } catch (e) {
                console.warn('[THEME]: load failed', e);
            } finally {
                setLoaded(true);
            }
        })();
    }, []);

    const isDark = mode === 'system' ? systemScheme !== 'light' : mode === 'dark';
    const colors = isDark ? darkColors : lightColors;

    const setMode = async (next: ThemeMode) => {
        setModeState(next);
        try {
            const db = await initDatabase();
            await setSetting(db, 'theme', next);
        } catch (e) {
            console.warn('[THEME]: save failed', e);
        }
    };

    // Avoid the briefly-wrong colors flash by waiting for the saved pref to load
    if (!loaded) return null;

    // Using React.createElement instead of JSX so this file can stay .ts
    return React.createElement(
        ThemeContext.Provider,
        { value: { mode, isDark, colors, setMode } },
        children
    );
}

export function useAppTheme() {
    return useContext(ThemeContext);
}
