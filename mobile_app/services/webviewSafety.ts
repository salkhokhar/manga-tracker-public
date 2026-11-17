// Shared WebView hardening props + navigation gate.
//
// Every WebView mount in this app should spread WEBVIEW_HARDENING_PROPS and
// set onShouldStartLoadWithRequest=webViewNavigationGate. Together they:
//
//   1. Block file:// reads (allowFileAccess + the *FromFileURLs pair). Without
//      this an embedded script could navigate to file:///… and exfiltrate
//      anything bundled with the app.
//   2. Refuse mixed http content on https pages (mixedContentMode='never') so
//      a hostile MITM can't downgrade resources.
//   3. Disable iOS-only conveniences that surface unexpected behaviour:
//      back/forward swipe gestures (would let users navigate away from the
//      scrape page mid-extract) and the link-preview popover.
//   4. Stop scripts from opening new windows / popups
//      (javaScriptCanOpenWindowsAutomatically + setSupportMultipleWindows).
//   5. Restrict originWhitelist from the previously-set ['*'] (which permits
//      javascript:, data:, intent:, …) to http(s) only — the documented
//      default and what we actually need for manga sites.
//   6. Refuse top-level navigations to anything isSafeMangaUrl rejects (the
//      same gate A5 applies to the initial source URL).
//
// JavaScript and DOM storage stay enabled — they're load-bearing for both the
// scrape injection and Cloudflare's challenge cookies.

import { isSafeMangaUrl } from './urlSafety';

export const WEBVIEW_HARDENING_PROPS = {
    // Default per react-native-webview docs. Previously ['*'] which allowed
    // javascript:, data:, intent:, etc. as top-level navigation targets.
    originWhitelist: ['http://*', 'https://*'] as string[],

    // file:// access — never needed for scraping, dangerous if granted.
    allowFileAccess: false,
    allowFileAccessFromFileURLs: false,
    allowUniversalAccessFromFileURLs: false,

    // Android: 'compatibility' blocks active mixed content (scripts, css,
    // iframes) but allows passive (images). 'never' would also block http
    // CDN images that some Madara themes still serve, breaking the
    // naturalHeight check used to gate chapter pages.
    mixedContentMode: 'compatibility' as const,

    // iOS: no swipe-to-go-back during a scrape, no long-press preview popover.
    allowsBackForwardNavigationGestures: false,
    allowsLinkPreview: false,

    // No window.open(), no <a target="_blank"> popups (mostly ads).
    javaScriptCanOpenWindowsAutomatically: false,
    setSupportMultipleWindows: false,

    // No geolocation prompts.
    geolocationEnabled: false,

    // Inject scrape JS into the top frame only — never into ad iframes.
    injectedJavaScriptForMainFrameOnly: true,
} as const;

/**
 * Use as the `onShouldStartLoadWithRequest` prop on every WebView. Refuses
 * any navigation attempt that isn't an http(s) URL or `about:blank` (which
 * RN-WebView emits as the initial about-blank frame on some platforms).
 *
 * This complements A5: A5 keeps unsafe URLs from being set as the WebView
 * source; this keeps the loaded page from navigating itself to one.
 */
export function webViewNavigationGate(req: { url: string }): boolean {
    if (!req || typeof req.url !== 'string') return false;
    if (req.url === 'about:blank') return true;
    if (isSafeMangaUrl(req.url)) return true;
    console.warn(`[WEBVIEW NAV] Refused navigation to: ${String(req.url).substring(0, 120)}`);
    return false;
}
