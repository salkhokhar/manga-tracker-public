// URL safety gatekeeper for everything that ends up as a WebView source.
//
// Deep links (`mangatracker://...`) and stored config can carry arbitrary URL
// strings into the app. Loading any of them in a WebView with JS enabled is
// dangerous — `javascript:`, `data:`, `file:`, `blob:`, `about:` URLs all let
// an attacker run code in the app's WebView context, read local files, or
// exfiltrate cookies.
//
// Rule of thumb: any URL that becomes `<WebView source={{ uri: ... }} />` must
// be filtered through `isSafeMangaUrl()` first. Same for any URL we hand to
// `fetch()` from a route param.

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Returns true if `url` is a string we're willing to load in a WebView.
 *
 * Accepts: http(s) URLs with a non-empty hostname.
 * Rejects: anything non-string, empty, malformed, or with a protocol outside
 *          the http(s) allowlist (incl. javascript:, data:, file:, blob:,
 *          about:, intent:, mailto:, tel:, ...).
 */
export function isSafeMangaUrl(url: unknown): url is string {
    if (typeof url !== 'string' || url.length === 0) return false;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return false;
    if (!parsed.hostname) return false;
    return true;
}

/**
 * Convenience for component-side use: validate and emit a one-time warn if the
 * URL is rejected. Returns the URL when safe, empty string when not — caller
 * decides what to render in the rejection branch.
 */
export function sanitizeMangaUrl(url: unknown, contextLabel: string): string {
    if (isSafeMangaUrl(url)) return url;
    console.warn(`[URL SAFETY] Rejected URL in ${contextLabel}: ${typeof url === 'string' ? url.substring(0, 120) : typeof url}`);
    return '';
}
