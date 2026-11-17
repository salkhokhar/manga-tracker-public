// Centralized parser/validator for WebView -> RN postMessage payloads.
//
// Any script running inside a WebView (including malicious JS injected by a
// compromised manga page, an ad iframe, or a future scraper-config update)
// can call window.ReactNativeWebView.postMessage with arbitrary content.
// Without validation, that script could:
//   - blow up our handlers with an oversized payload (OOM)
//   - send malformed JSON that throws inside the handler
//   - spoof message types we don't expect and trigger UI state changes
//   - send valid types with the wrong shape and crash downstream code
//
// Defence in depth: A5 already restricts the URLs we load to http(s) origins,
// but those origins still pull in third-party scripts (ads, analytics, CDNs).
// Treat every inbound message as untrusted.

// 32 MB has to accommodate sites that inline chapter pages as base64
// data: URIs (Gourmet Scans is the headline case — a single batch can
// carry 10+ pages at ~500 KB base64 each, easily 5–10 MB total). Smaller
// caps would silently break those sites. Still well below OOM territory
// on any phone we target.
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024; // 32 MB
export const MAX_STRING_FIELD = 64 * 1024;         // 64 KB per text field
export const MAX_ARRAY_ITEMS = 5000;               // chapters / images / urls

export interface ValidatedMessage {
    type: string;
    [key: string]: unknown;
}

/**
 * Parse a raw WebView message string. Refuses anything oversized, malformed,
 * non-object, or with a `type` outside the handler's allowlist. Returns the
 * parsed payload on success, null on any failure (with a one-line warn).
 *
 * Callers must still validate the *shape* of each field they read — this
 * function only guarantees: it's an object, it has a string `type`, and
 * `type` is one we expect.
 */
export function parseWebViewMessage(
    raw: unknown,
    allowedTypes: ReadonlySet<string>,
    context: string,
): ValidatedMessage | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    if (raw.length > MAX_PAYLOAD_BYTES) {
        console.warn(`[${context}] Refused oversized WebView message: ${raw.length} bytes`);
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e: any) {
        console.warn(`[${context}] Bad WebView JSON: ${e?.message || 'parse error'}`);
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn(`[${context}] WebView payload not an object`);
        return null;
    }
    const payload = parsed as Record<string, unknown>;
    if (typeof payload.type !== 'string') {
        console.warn(`[${context}] WebView payload missing string type`);
        return null;
    }
    if (!allowedTypes.has(payload.type)) {
        console.warn(`[${context}] Refused unknown WebView message type "${payload.type}"`);
        return null;
    }
    return payload as ValidatedMessage;
}

/** True if v is a string within the per-field length cap. */
export function isBoundedString(v: unknown, max: number = MAX_STRING_FIELD): v is string {
    return typeof v === 'string' && v.length <= max;
}

/** True if v is an array within the item-count cap. */
export function isBoundedArray(v: unknown, max: number = MAX_ARRAY_ITEMS): v is unknown[] {
    return Array.isArray(v) && v.length <= max;
}

/** Returns v if it's a bounded string, '' otherwise. Use for optional text fields. */
export function clampString(v: unknown, max: number = MAX_STRING_FIELD): string {
    if (typeof v !== 'string') return '';
    return v.length <= max ? v : v.substring(0, max);
}
