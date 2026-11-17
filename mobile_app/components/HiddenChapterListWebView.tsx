import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import {
    getActiveChapterListJob,
    subscribe,
    reportChapterList,
    reportChapterListError,
} from '../services/chapterListManager';
import type { ChapterInfo } from '../services/chapterCache';
import { isSafeMangaUrl } from '../services/urlSafety';
import { parseWebViewMessage, isBoundedArray, clampString } from '../services/webviewMessage';
import { WEBVIEW_HARDENING_PROPS, webViewNavigationGate } from '../services/webviewSafety';

const CHLIST_ALLOWED_TYPES: ReadonlySet<string> = new Set(['CHLIST_RESULT', 'CHLIST_DEBUG', 'CHLIST_ERROR']);
// Same cap Details applies to its own SUCCESS payload.
const MAX_CHAPTERS = 10000;
const MAX_TITLE_CHARS = 300;

/**
 * M2b — single hidden WebView mounted at the app root (alongside the scrape
 * and probe views). It pulls the active linked-source job from
 * chapterListManager, runs that site's chapter-extraction JS, and reports the
 * rows back so Details can merge them into the primary list.
 *
 * Same security posture as the sibling hidden views: isSafeMangaUrl gate on
 * the source, message allowlist + bounded-field validation on every inbound
 * message, hardening props + navigation gate on the WebView itself.
 */
export function HiddenChapterListWebView() {
    const [job, setJob] = useState(getActiveChapterListJob());

    useEffect(() => {
        return subscribe(() => setJob(getActiveChapterListJob()));
    }, []);

    if (!job) return null;
    const { url, injectedJs } = job;
    if (!isSafeMangaUrl(url)) {
        console.warn(`[URL SAFETY] HiddenChapterListWebView refused unsafe URL: ${String(url).substring(0, 120)}`);
        reportChapterListError('Refused unsafe URL');
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
                injectedJavaScript={injectedJs}
                onMessage={(event) => {
                    const payload = parseWebViewMessage(event.nativeEvent.data, CHLIST_ALLOWED_TYPES, 'CHLIST');
                    if (!payload) return;
                    if (payload.type === 'CHLIST_DEBUG') {
                        console.log('[CHLIST]:', clampString(payload.message));
                        return;
                    }
                    if (payload.type === 'CHLIST_ERROR') {
                        reportChapterListError(clampString(payload.message) || 'Unknown chapter-list error');
                        return;
                    }
                    if (payload.type === 'CHLIST_RESULT') {
                        if (!isBoundedArray(payload.chapters, MAX_CHAPTERS)) {
                            reportChapterListError('CHLIST_RESULT chapters missing/oversized');
                            return;
                        }
                        // Keep only well-formed rows with an http(s) link — these
                        // links end up as reader / download WebView sources later.
                        const chapters: ChapterInfo[] = [];
                        for (const raw of payload.chapters as unknown[]) {
                            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
                            const r = raw as Record<string, unknown>;
                            if (!isSafeMangaUrl(r.link)) continue;
                            chapters.push({
                                title: clampString(r.title, MAX_TITLE_CHARS),
                                link: r.link,
                                date: clampString(r.date, MAX_TITLE_CHARS),
                            });
                        }
                        reportChapterList(chapters);
                        return;
                    }
                }}
                onError={(e) => {
                    console.warn('[CHLIST] WebView error:', e.nativeEvent);
                    reportChapterListError(e.nativeEvent.description || 'WebView error');
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
