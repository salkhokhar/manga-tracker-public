// OAuth redirect handling (security audit 2026-10-23, finding 1).
//
// The app is registered for `mangatracker://` links, so any web page, message
// or QR code can open it with a URL of the attacker's choosing. Previously any
// such link carrying `#access_token=…&refresh_token=…` was passed to
// setSession, silently signing the user into the attacker's account.
//
// Now:
//   - The Supabase client uses the PKCE flow (services/supabase.ts). A `code`
//     can only be exchanged with the verifier this app stored when *it* began
//     the sign-in, so a code from someone else's flow is useless.
//   - Tokens in a URL fragment are never accepted (implicit flow is gone).
//   - A redirect is only handled while a Google sign-in started here is still
//     open, only if it targets the redirect URI that sign-in used, and only once.

let pendingRedirectUri: string | null = null;

// Address without query/fragment or trailing slashes. Supabase returns
// "mangatracker://redirect" as "mangatracker://redirect/?code=…".
function redirectBase(url: string): string {
    return url.split(/[?#]/)[0].replace(/\/+$/, '');
}

/** Call right before opening the provider's sign-in page. */
export function beginOAuth(redirectUri: string): void {
    pendingRedirectUri = redirectBase(redirectUri);
}

/** Call when the sign-in browser closes, whatever the outcome. */
export function endOAuth(): void {
    pendingRedirectUri = null;
}

/**
 * True exactly once for a redirect that belongs to the sign-in in progress.
 * Consumes the pending state, so the same URL arriving twice (Linking event
 * plus the auth-session result) is only handled the first time.
 */
export function takePendingOAuth(url: unknown): boolean {
    if (!pendingRedirectUri || typeof url !== 'string') return false;
    if (redirectBase(url) !== pendingRedirectUri) return false;
    pendingRedirectUri = null;
    return true;
}

export interface ParsedAuthRedirect {
    code: string | null;
    error: string | null;
    errorDescription: string | null;
}

/** Read the PKCE `code` (or a provider error) from the redirect's query string. */
export function parseAuthRedirect(url: string): ParsedAuthRedirect {
    const out: ParsedAuthRedirect = { code: null, error: null, errorDescription: null };
    const q = url.indexOf('?');
    if (q === -1) return out;
    const query = url.substring(q + 1).split('#')[0];
    for (const pair of query.split('&')) {
        const eq = pair.indexOf('=');
        const rawKey = eq === -1 ? pair : pair.substring(0, eq);
        const rawVal = eq === -1 ? '' : pair.substring(eq + 1);
        let key = '', val = '';
        try {
            key = decodeURIComponent(rawKey);
            val = decodeURIComponent(rawVal.replace(/\+/g, ' '));
        } catch {
            continue;
        }
        if (key === 'code') out.code = val;
        else if (key === 'error') out.error = val;
        else if (key === 'error_description') out.errorDescription = val;
    }
    return out;
}

/** Log-safe summary of a redirect URL: which parts were present, never their values. */
export function describeRedirectForLog(url: string): string {
    const p = parseAuthRedirect(url);
    const frag = url.split('#')[1] || '';
    const hasTokens = /(^|&)(access_token|refresh_token)=/.test(frag);
    return `code=${p.code ? 'yes' : 'no'}, error=${p.error ? p.error : 'none'}, fragment tokens=${hasTokens ? 'yes (ignored)' : 'no'}`;
}
