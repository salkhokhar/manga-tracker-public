import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import {
    getActiveProbeUrl,
    getActiveProbeScript,
    subscribe,
    reportProbeTitles,
    reportSearchResults,
    reportProbeError,
    SearchResultCard,
} from '../services/probeManager';
import { isSafeMangaUrl } from '../services/urlSafety';
import { parseWebViewMessage, isBoundedArray, clampString } from '../services/webviewMessage';
import { WEBVIEW_HARDENING_PROPS, webViewNavigationGate } from '../services/webviewSafety';

const PROBE_ALLOWED_TYPES: ReadonlySet<string> = new Set(['PROBE_RESULT', 'PROBE_SEARCH', 'PROBE_DEBUG', 'PROBE_ERROR']);
// A search page shows a few dozen cards at most; more is a runaway selector.
const MAX_SEARCH_CARDS = 100;

/**
 * Single hidden WebView mounted at the app root (alongside HiddenScrapeWebView).
 * It pulls the active candidate URL from probeManager, reads the loaded page's
 * title(s), and reports them back for similarity scoring. Lives at the root so
 * a queued batch of probes keeps running while the user navigates.
 *
 * Mirrors HiddenScrapeWebView's security posture: A5 URL gate on the source,
 * A6 message allowlist + bounded-field validation on every inbound message,
 * A7 hardening props + navigation gate on the WebView itself.
 */
export function HiddenProbeWebView() {
    const [url, setUrl] = useState<string | null>(getActiveProbeUrl());

    useEffect(() => {
        return subscribe(() => setUrl(getActiveProbeUrl()));
    }, []);

    if (!url) return null;
    // Defence in depth: buildCandidateUrls already only emits safe URLs, but
    // refuse anything that slips through and tell the manager so the queue
    // advances instead of stalling on a bad candidate.
    if (!isSafeMangaUrl(url)) {
        console.warn(`[URL SAFETY] HiddenProbeWebView refused unsafe probe URL: ${String(url).substring(0, 120)}`);
        reportProbeError('Refused unsafe URL');
        return null;
    }

    return (
        <View
            pointerEvents="none"
            style={{ position: 'absolute', width: 0, height: 0, opacity: 0 }}
        >
            <WebView
                key={url}
                source={{ uri: url }}
                injectedJavaScript={getActiveProbeScript()}
                onMessage={(event) => {
                    const payload = parseWebViewMessage(event.nativeEvent.data, PROBE_ALLOWED_TYPES, 'PROBE');
                    if (!payload) return;
                    if (payload.type === 'PROBE_DEBUG') {
                        console.log('[PROBE]:', clampString(payload.message));
                        return;
                    }
                    if (payload.type === 'PROBE_ERROR') {
                        reportProbeError(clampString(payload.message) || 'Unknown probe error');
                        return;
                    }
                    if (payload.type === 'PROBE_RESULT') {
                        const titles = [
                            clampString(payload.h1),
                            clampString(payload.ogTitle),
                            clampString(payload.docTitle),
                        ].filter((t) => t.length > 0);
                        const finalUrl = clampString(payload.url) || url;
                        reportProbeTitles(titles, finalUrl, clampString(payload.altNames, 1000));
                        return;
                    }
                    if (payload.type === 'PROBE_SEARCH') {
                        if (!isBoundedArray(payload.results, MAX_SEARCH_CARDS)) {
                            reportProbeError('Search results missing or oversized');
                            return;
                        }
                        const cards: SearchResultCard[] = (payload.results as unknown[])
                            .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c))
                            .map((c) => ({ title: clampString(c.title, 300), link: clampString(c.link, 2048) }))
                            .filter((c) => c.title.length > 0 && c.link.length > 0);
                        reportSearchResults(cards, clampString(payload.url) || url);
                        return;
                    }
                }}
                onError={(e) => {
                    console.warn('[PROBE] WebView error:', e.nativeEvent);
                    reportProbeError(e.nativeEvent.description || 'WebView error');
                }}
                javaScriptEnabled={true}
                domStorageEnabled={true}
                {...WEBVIEW_HARDENING_PROPS}
                onShouldStartLoadWithRequest={webViewNavigationGate}
                userAgent={'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'}
            />
        </View>
    );
}
