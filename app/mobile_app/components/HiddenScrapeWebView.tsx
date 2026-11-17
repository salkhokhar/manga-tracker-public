import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { getActiveUrl, subscribe, reportSuccess, reportError, SCRAPE_JS } from '../services/scrapeManager';
import { isSafeMangaUrl } from '../services/urlSafety';
import { parseWebViewMessage, isBoundedArray, clampString } from '../services/webviewMessage';
import { WEBVIEW_HARDENING_PROPS, webViewNavigationGate } from '../services/webviewSafety';

const SCRAPE_ALLOWED_TYPES: ReadonlySet<string> = new Set(['DL_DEBUG', 'DL_IMAGES', 'DL_ERROR']);

/**
 * Single hidden WebView mounted at the app root. It pulls its target URL from
 * scrapeManager, runs the image-extraction JS, and reports results back. Lives
 * in the root layout so it survives all navigation — that's what makes
 * "Download all" continue when the user leaves Details.
 */
export function HiddenScrapeWebView() {
    const [url, setUrl] = useState<string | null>(getActiveUrl());

    useEffect(() => {
        return subscribe(() => setUrl(getActiveUrl()));
    }, []);

    if (!url) return null;
    // Refuse to scrape anything that didn't pass URL safety. Tells scrapeManager
    // the job failed so the queue moves on instead of stalling.
    if (!isSafeMangaUrl(url)) {
        console.warn(`[URL SAFETY] HiddenScrapeWebView refused unsafe scrape URL: ${String(url).substring(0, 120)}`);
        reportError('Refused unsafe URL');
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
                injectedJavaScript={SCRAPE_JS}
                onMessage={(event) => {
                    const payload = parseWebViewMessage(event.nativeEvent.data, SCRAPE_ALLOWED_TYPES, 'SCRAPE');
                    if (!payload) return;
                    if (payload.type === 'DL_DEBUG') {
                        console.log('[SCRAPE]:', clampString(payload.message));
                        return;
                    }
                    if (payload.type === 'DL_IMAGES') {
                        if (!isBoundedArray(payload.urls)) {
                            console.warn(`[SCRAPE]: DL_IMAGES had invalid/oversized urls — refused`);
                            reportError('Invalid scrape payload');
                            return;
                        }
                        // scrapeManager.SCRAPE_JS only ever emits http(s) URLs
                        // (the download pipeline can't fetch data: URIs), so
                        // anything else is either a bug or a hostile injection.
                        const urls: string[] = (payload.urls as unknown[]).filter(
                            (u): u is string => typeof u === 'string'
                                && u.length > 0
                                && (u.startsWith('http://') || u.startsWith('https://'))
                        );
                        console.log(`[SCRAPE]: ${url} → ${urls.length} image URLs`);
                        reportSuccess(urls);
                        return;
                    }
                    if (payload.type === 'DL_ERROR') {
                        const msg = clampString(payload.message) || 'Unknown error';
                        console.warn(`[SCRAPE]: ${url} → error: ${msg}`);
                        reportError(msg);
                        return;
                    }
                }}
                onError={(e) => {
                    console.warn('[SCRAPE] WebView error:', e.nativeEvent);
                    reportError(e.nativeEvent.description || 'WebView error');
                }}
                javaScriptEnabled={true}
                domStorageEnabled={true}
                {...WEBVIEW_HARDENING_PROPS}
                onShouldStartLoadWithRequest={webViewNavigationGate}
                userAgent={url.includes('webtoons.com')
                    ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
                    : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'}
            />
        </View>
    );
}
