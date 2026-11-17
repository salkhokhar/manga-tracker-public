// First: gives supabase-js the Web Crypto it needs for proper PKCE (S256).
import './cryptoPolyfill';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
// SQLite-backed key-value store that ships with expo-sqlite (drop-in for
// AsyncStorage). It uses its own database file, separate from manga_tracker.db,
// so clearUserData() on sign-out never touches it; signOut() removes the
// session key itself.
import SessionStorage from 'expo-sqlite/kv-store';

// =============================================================================
// Supabase client — credentials are intentionally embedded. Read this before
// flagging them in a security audit.
//
// `supabaseUrl` and `supabaseAnonKey` (prefix `sb_publishable_`) are *public*
// by design. They identify the project and grant the holder access to whatever
// the row-level-security (RLS) policies allow — nothing more. Every Supabase
// browser/mobile client in the world embeds these same two values in plain text
// in its bundle; there is no way to hide them from a client app. Trying to
// gate them behind env vars only obscures them at build time — the values
// still ship in the compiled JS.
//
// The real security boundary is **RLS on each table**, not these keys.
// As of the 2026-05 audit:
//   - manga_library: ALL ops require auth.uid() = user_id
//   - profiles:      ALL ops require auth.uid() = user_id (one policy total)
//   - scraper_configs: SELECT requires authenticated; no public write policies
// Run scripts in services/runtimeConfig audit notes to re-verify when adding
// new tables.
//
// The env-var fallback (`process.env.EXPO_PUBLIC_*`) only exists so a dev/CI
// build can override these against a staging project. The hardcoded literals
// are the production values and the source of truth.
//
// NEVER add the `service_role` key here. That one IS a secret — it bypasses
// RLS entirely and would give every install full database access. Service-role
// operations belong in Supabase Edge Functions or a server, not in the app.
// =============================================================================
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || "https://hqnmdrhozylhnalolgan.supabase.co";
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_AGgX3c58boiTRfah0dDEQg_dqj8dnQX";

// Without an explicit storage, supabase-js on React Native falls back to an
// in-memory store (there is no localStorage), so the sign-in was lost on every
// app restart. Persist it in SQLite instead. The app handles OAuth redirects
// itself (handleAuthRedirect in app/(tabs)/index.tsx), so URL detection, which
// only applies to browsers, is off.
//
// PKCE, not supabase-js's default implicit flow: the OAuth redirect then
// carries a one-time `code` that only this install can exchange (it holds the
// verifier), instead of ready-to-use tokens that any link could inject. See
// services/authRedirect.ts.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
        flowType: 'pkce',
        storage: SessionStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
    },
});

// Supabase's documented React Native pattern: refresh the session only while
// the app is in the foreground. Phones suspend JS timers in the background, so
// the interval-based refresh would otherwise fire late or not at all.
AppState.addEventListener('change', (state) => {
    if (state === 'active') {
        supabase.auth.startAutoRefresh();
    } else {
        supabase.auth.stopAutoRefresh();
    }
});

// SQLite stores manga.linked_sources as a JSON string; Supabase jsonb expects
// the parsed array. Normalize at the cloud-write boundary so the rest of the
// app can stay agnostic to the storage shape.
function parseLinkedForCloud(raw: unknown): unknown[] {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string' && raw.length > 0) {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }
    return [];
}

// Tries the profiles table, falls back to the email's local part.
export async function getUsername(userId: string, email: string): Promise<string> {
    try {
        const { data } = await supabase
            .from('profiles')
            .select('username')
            .eq('user_id', userId)
            .maybeSingle();
        if (data?.username) return data.username;
    } catch (e: any) {
        console.warn('[SUPABASE]: profiles fetch failed (table may not exist):', e.message || e);
    }
    return (email || 'user').split('@')[0];
}

// Returns the user's chosen avatar id, or null if they haven't set one.
export async function getAvatarId(userId: string): Promise<string | null> {
    try {
        const { data } = await supabase
            .from('profiles')
            .select('avatar')
            .eq('user_id', userId)
            .maybeSingle();
        return data?.avatar || null;
    } catch (e: any) {
        console.warn('[SUPABASE]: avatar fetch failed:', e.message || e);
        return null;
    }
}

// Removed: setAvatarInCloud — avatar choice is stored locally via SQLite settings
// (key 'avatar'), not in the profiles table. The previous implementation also wrote
// to a profiles.email column that no longer exists.

export function validateUsernameFormat(name: string): string | null {
    const trimmed = (name || '').trim();
    if (trimmed.length < 3) return 'Username must be at least 3 characters';
    if (trimmed.length > 20) return 'Username must be 20 characters or fewer';
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) return 'Letters, numbers, and underscores only';
    return null;
}

// Returns true if the username is free (or already belongs to the current user).
export async function isUsernameAvailable(username: string, currentUserId: string): Promise<boolean> {
    const { data, error } = await supabase
        .from('profiles')
        .select('user_id')
        .ilike('username', username)
        .maybeSingle();
    if (error) {
        // If the row simply doesn't exist, error is expected; treat as available
        return true;
    }
    if (!data) return true;
    return data.user_id === currentUserId;
}

// Upsert profile with the new username. Returns { ok, error? }.
// Email is intentionally NOT written here — it lives in auth.users (queryable via
// the session) and the duplicate `profiles.email` column was dropped during the
// 2026-05 security audit.
export async function setUsernameInCloud(
    userId: string,
    username: string
): Promise<{ ok: boolean; error?: string }> {
    console.log(`[SUPABASE]: Setting username for ${userId} → ${username}`);
    const formatErr = validateUsernameFormat(username);
    if (formatErr) return { ok: false, error: formatErr };

    // Best-effort pre-check; will silently return "available" for usernames belonging
    // to other users because RLS hides their rows. The DB UNIQUE constraint below is
    // the actual source of truth — we catch its 23505 error and translate it.
    const free = await isUsernameAvailable(username, userId);
    if (!free) return { ok: false, error: 'That username is already taken' };

    const { error } = await supabase
        .from('profiles')
        .upsert(
            { user_id: userId, username: username.trim() },
            { onConflict: 'user_id' }
        );
    if (error) {
        console.error('[SUPABASE]: setUsernameInCloud failed:', error.message);
        // Postgres unique_violation. Authoritative "taken" check now that RLS hides
        // other users' rows from the pre-check above.
        const msg = (error.message || '').toLowerCase();
        if ((error as any).code === '23505' || msg.includes('duplicate key') || msg.includes('unique')) {
            return { ok: false, error: 'That username is already taken' };
        }
        return { ok: false, error: error.message };
    }
    return { ok: true };
}
export async function pullLibraryFromCloud(userId: string) {
    console.log(`[SUPABASE]: Pulling library for user ${userId}`);
    const { data, error } = await supabase
        .from('manga_library')
        .select('*')
        .eq('user_id', userId);

    if (error) {
        console.error("[SUPABASE ERROR]: Cloud pull failed", error.message);
        return [];
    }
    console.log(`[SUPABASE SUCCESS]: Pulled ${data?.length || 0} records`);
    return data || [];
}

/**
 * Like pullLibraryFromCloud, but null when the pull failed, so the two-way sync
 * (services/syncPlan.ts) never mistakes a failure for an empty cloud library.
 */
export async function pullLibraryFromCloudStrict(userId: string): Promise<any[] | null> {
    const { data, error } = await supabase
        .from('manga_library')
        .select('*')
        .eq('user_id', userId);
    if (error) {
        console.error("[SUPABASE ERROR]: Cloud pull failed", error.message);
        return null;
    }
    console.log(`[SUPABASE SUCCESS]: Pulled ${data?.length || 0} records`);
    return data || [];
}

export async function fetchScraperConfigsFromCloud() {
    console.log(`[SUPABASE]: Fetching scraper configs`);
    const { data, error } = await supabase.from('scraper_configs').select('website_name, json_rules');
    if (error) {
        console.error("[SUPABASE ERROR]: Config pull failed", error.message);
        return [];
    }
    console.log(`[SUPABASE SUCCESS]: Pulled ${data?.length || 0} scraper configs`);
    return data || [];
}

export async function pushAddToCloud(userId: string, manga: {
    title: string;
    manga_url?: string;
    cover_url?: string;
    chapter?: string;
    latest_chapter?: string;
    category?: string;
}) {
    console.log(`[SUPABASE]: Adding "${manga.title}" to cloud library`);
    const today = new Date().toISOString().split('T')[0];
    try {
        // Upsert so re-adding the same comic doesn't fail on the unique (user_id, title) constraint
        const { error } = await supabase
            .from('manga_library')
            .upsert({
                user_id: userId,
                title: manga.title,
                manga_url: manga.manga_url || '',
                cover_url: manga.cover_url || '',
                chapter: manga.chapter || 'Chapter 0',
                latest_chapter: manga.latest_chapter || 'Unknown',
                category: manga.category || 'Reading',
                last_read_date: today,
            }, { onConflict: 'user_id,title' });

        if (error) {
            console.error("[SUPABASE ERROR]: Cloud add failed:", error.message, error.details, error.hint);
            return false;
        }
        console.log(`[SUPABASE SUCCESS]: Added "${manga.title}" to cloud`);
        return true;
    } catch (e: any) {
        console.error("[SUPABASE ERROR]: Cloud add exception:", e.message || e);
        return false;
    }
}

// Remove a single manga from the user's cloud library (matched by title).
export async function removeFromCloud(userId: string, title: string): Promise<{ ok: boolean; error?: string }> {
    console.log(`[SUPABASE]: Removing "${title}" from cloud`);
    const { error } = await supabase
        .from('manga_library')
        .delete()
        .eq('user_id', userId)
        .eq('title', title);
    if (error) {
        console.error('[SUPABASE]: removeFromCloud failed:', error.message);
        return { ok: false, error: error.message };
    }
    return { ok: true };
}

// Partial update of one comic's linked_sources (jsonb) after a local change.
export async function pushLinkedSourcesToCloud(userId: string, title: string, sources: unknown[]): Promise<boolean> {
    try {
        const { error } = await supabase.from('manga_library')
            .update({ linked_sources: sources })
            .match({ user_id: userId, title });
        if (error) {
            console.warn('[LINKED]: cloud sync failed:', error.message);
            return false;
        }
        return true;
    } catch (e: any) {
        console.warn('[LINKED]: cloud sync exception:', e.message || e);
        return false;
    }
}

export async function pushAllToCloud(userId: string, mangaList: any[]) {
    console.log(`[SUPABASE]: Bulk-syncing ${mangaList.length} manga to cloud`);
    if (!mangaList.length) return { ok: true, pushed: 0 };
    const today = new Date().toISOString().split('T')[0];
    try {
        // Strip the local SQLite id; Supabase has its own primary key
        const rows = mangaList.map(m => ({
            user_id: userId,
            title: m.title,
            manga_url: m.manga_url || '',
            cover_url: m.cover_url || '',
            chapter: m.chapter || 'Chapter 0',
            last_read_date: m.last_read_date || today,
            latest_chapter: m.latest_chapter || 'Unknown',
            latest_date: m.latest_date || '',
            genre: m.genre || '',
            author: m.author || '',
            description: m.description || '',
            rating: m.rating || '',
            alternative_names: m.alternative_names || '',
            favorite: m.favorite || '',
            category: m.category || 'Reading',
            status: m.status || '',
            notes: m.notes || '',
            // SQLite stores linked_sources as JSON string; Supabase jsonb wants
            // an array. Parse if it came through as a string, default to [].
            linked_sources: parseLinkedForCloud(m.linked_sources),
        }));
        const { error } = await supabase
            .from('manga_library')
            .upsert(rows, { onConflict: 'user_id,title' });
        if (error) {
            console.error("[SUPABASE ERROR]: Bulk sync failed:", error.message);
            return { ok: false, pushed: 0, error: error.message };
        }
        console.log(`[SUPABASE SUCCESS]: Bulk-synced ${rows.length} records`);
        return { ok: true, pushed: rows.length };
    } catch (e: any) {
        console.error("[SUPABASE ERROR]: Bulk sync exception:", e.message || e);
        return { ok: false, pushed: 0, error: e.message };
    }
}

// Deletes the currently-signed-in user's account. Reads the user ID from the
// session itself rather than accepting it as a parameter — this removes the
// "did the caller pass the right ID?" trust boundary entirely. RLS would catch
// a wrong ID anyway (a user can't DELETE another user's rows under the existing
// auth.uid() = user_id policy), but layered defence is cheap here.
export async function deleteAccountFromCloud() {
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) {
        return { ok: false, error: 'No active session — cannot delete account' };
    }
    console.log(`[SUPABASE]: Deleting account ${userId}`);
    try {
        // 1) library rows
        const { error: libErr } = await supabase.from('manga_library').delete().eq('user_id', userId);
        if (libErr) console.warn("Library delete:", libErr.message);
        // 2) profile row (if you have a profiles table — ignored if not)
        await supabase.from('profiles').delete().eq('user_id', userId).then(() => {}, () => {});
        // 3) auth user — requires server-side RPC `delete_own_account`. The desktop app already uses this.
        const { error: rpcErr } = await supabase.rpc('delete_own_account');
        if (rpcErr) {
            console.error("delete_own_account RPC failed:", rpcErr.message);
            return { ok: false, error: rpcErr.message };
        }
        return { ok: true };
    } catch (e: any) {
        console.error("Delete account exception:", e.message || e);
        return { ok: false, error: e.message };
    }
}

export async function pushProgressToCloud(userId: string, title: string, chapter: string) {
    console.log(`[SUPABASE]: Pushing progress to cloud: ${title} -> ${chapter}`);
    const today = new Date().toISOString().split('T')[0];
    try {
        const { error } = await supabase
            .from('manga_library')
            .update({ 
                chapter: chapter, 
                last_read_date: today 
            })
            .match({ user_id: userId, title: title });

        if (error) {
            console.error("Cloud push Supabase error:", error.message, error.details, error.hint);
            return false;
        }
        return true;
    } catch (e: any) {
        console.error("Cloud push network/exception error:", e.message || e);
        return false;
    }
}
