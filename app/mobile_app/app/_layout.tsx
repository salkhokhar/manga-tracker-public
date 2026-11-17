import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View } from 'react-native';
import { ThemeProvider, useAppTheme } from '../services/theme';
// Importing this module registers the background task and configures the
// notification handler at app launch (the side effects run on import).
import '../services/notifications';
// Importing this auto-resumes any persisted download queue from the previous session.
import '../services/downloadQueue';
import { DownloadBanner } from '../components/DownloadBanner';
import { HiddenScrapeWebView } from '../components/HiddenScrapeWebView';
import { HiddenProbeWebView } from '../components/HiddenProbeWebView';
import { HiddenChapterListWebView } from '../components/HiddenChapterListWebView';

function ThemedStack() {
  const { colors, isDark } = useAppTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          headerBackTitle: 'Back',
          contentStyle: { backgroundColor: colors.bg },
        }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="details" options={{ title: 'Details' }} />
        <Stack.Screen name="read" options={{ headerShown: false, orientation: 'all' }} />
      </Stack>
      {/* Floating download progress banner — visible across all screens */}
      <DownloadBanner />
      {/* Hidden WebView used by the global scrape manager (chapter image extraction).
          Mounted here so it survives navigation between screens. */}
      <HiddenScrapeWebView />
      {/* Hidden WebView used by the source-probe manager (auto-suggest linked
          sources). Mounted here so a probe batch survives navigation. */}
      <HiddenProbeWebView />
      {/* Hidden WebView used by the chapter-list manager (M2b: scrape linked
          sources' chapter lists for the Details merge). */}
      <HiddenChapterListWebView />
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedStack />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
