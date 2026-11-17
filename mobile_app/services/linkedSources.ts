// Multi-source library — linked-sources data model.
//
// Background: each `manga` row owns a primary `manga_url` (the source the user
// originally added the comic from). When the same comic exists on other sites
// the user can link additional sources so refresh can poll all of them in
// parallel and the reader can fall back if one site is down.
//
// We store the additional sources as a JSON-encoded array on the manga row
// (SQLite TEXT, Supabase jsonb). The primary URL stays in `manga_url`; this
// field is *additional* sources only — never duplicates the primary.

import * as SQLite from 'expo-sqlite';
import { isSafeMangaUrl } from './urlSafety';

export interface LinkedSource {
    /** scraper_configs.website_name — used to look up the right scraper rules. */
    website_name: string;
    /** Full https URL on that site. Validated through isSafeMangaUrl on write. */
    manga_url: string;
    /** ISO timestamp when this source was linked. Informational. */
    added_at: string;
    /**
     * Wrong-series check (sourceMismatch.ts). 'suspect': its chapter numbers
     * don't fit the primary, so it is left out of the merge, the reader
     * fallback and refresh. 'kept': the user chose to keep it anyway; never
     * flagged again. Absent: passed (or not yet checked).
     */
    mismatch?: 'suspect' | 'kept';
    /**
     * 'muted': the user doesn't want this source to set latest_chapter or
     * fire new-chapter notifications (its numbering differs from the primary,
     * say). Its chapters still merge into Details and stay readable. Absent:
     * counts for update checks.
     */
    updates?: 'muted';
}

/** Parse the JSON column safely. Returns [] on null/invalid/empty. */
export function parseLinkedSources(raw: unknown): LinkedSource[] {
    if (!raw) return [];
    // Supabase returns jsonb as already-parsed objects; SQLite returns a string.
    let arr: unknown;
    if (typeof raw === 'string') {
        if (raw.length === 0) return [];
        try { arr = JSON.parse(raw); } catch { return []; }
    } else {
        arr = raw;
    }
    if (!Array.isArray(arr)) return [];
    return arr.filter(isValidLinkedSource);
}

export function serializeLinkedSources(sources: LinkedSource[]): string {
    return JSON.stringify(sources.filter(isValidLinkedSource));
}

function isValidLinkedSource(x: unknown): x is LinkedSource {
    if (!x || typeof x !== 'object') return false;
    const s = x as Record<string, unknown>;
    return typeof s.website_name === 'string'
        && s.website_name.length > 0
        && typeof s.manga_url === 'string'
        && isSafeMangaUrl(s.manga_url)
        && typeof s.added_at === 'string'
        && (s.mismatch === undefined || s.mismatch === 'suspect' || s.mismatch === 'kept')
        && (s.updates === undefined || s.updates === 'muted');
}

/** True when this source should feed the merge, reader fallback and refresh. */
export function isUsableLinkedSource(s: LinkedSource): boolean {
    return s.mismatch !== 'suspect';
}

/** True when this source may set latest_chapter and fire notifications. */
export function countsForUpdates(s: LinkedSource): boolean {
    return isUsableLinkedSource(s) && s.updates !== 'muted';
}

/**
 * Mute or unmute one linked source for update checks. Returns the updated
 * list (unchanged when the source isn't linked or already has that status).
 */
export async function setLinkedSourceUpdates(
    db: SQLite.SQLiteDatabase,
    primaryUrl: string,
    sourceUrl: string,
    status: 'muted' | undefined,
): Promise<LinkedSource[]> {
    const existing = await getLinkedSourcesByUrl(db, primaryUrl);
    const target = existing.find(s => s.manga_url === sourceUrl);
    if (!target || target.updates === status) return existing;
    const updated = existing.map(s => {
        if (s.manga_url !== sourceUrl) return s;
        const { updates: _old, ...rest } = s;
        return status ? { ...rest, updates: status } : rest;
    });
    await db.runAsync(
        'UPDATE manga SET linked_sources = ? WHERE manga_url = ?',
        [serializeLinkedSources(updated), primaryUrl],
    );
    return updated;
}

/**
 * Set or clear the wrong-series flag on one linked source. Returns the updated
 * list (unchanged when the source isn't linked or already has that status).
 */
export async function setLinkedSourceMismatch(
    db: SQLite.SQLiteDatabase,
    primaryUrl: string,
    sourceUrl: string,
    status: 'suspect' | 'kept' | undefined,
): Promise<LinkedSource[]> {
    const existing = await getLinkedSourcesByUrl(db, primaryUrl);
    const target = existing.find(s => s.manga_url === sourceUrl);
    if (!target || target.mismatch === status) return existing;
    const updated = existing.map(s => {
        if (s.manga_url !== sourceUrl) return s;
        const { mismatch: _old, ...rest } = s;
        return status ? { ...rest, mismatch: status } : rest;
    });
    await db.runAsync(
        'UPDATE manga SET linked_sources = ? WHERE manga_url = ?',
        [serializeLinkedSources(updated), primaryUrl],
    );
    return updated;
}

/**
 * Read the linked_sources column for a given primary URL. Returns [] if the
 * comic has no links or isn't in the library.
 */
export async function getLinkedSourcesByUrl(
    db: SQLite.SQLiteDatabase,
    primaryUrl: string,
): Promise<LinkedSource[]> {
    const row = await db.getFirstAsync<{ linked_sources: string | null }>(
        'SELECT linked_sources FROM manga WHERE manga_url = ?',
        [primaryUrl],
    );
    return parseLinkedSources(row?.linked_sources);
}

/**
 * Add a new linked source. No-ops if it's already linked or if it equals the
 * primary URL. Returns the updated list.
 */
export async function addLinkedSource(
    db: SQLite.SQLiteDatabase,
    primaryUrl: string,
    newSource: LinkedSource,
): Promise<LinkedSource[]> {
    if (!isValidLinkedSource(newSource)) {
        throw new Error('addLinkedSource: invalid source object');
    }
    if (newSource.manga_url === primaryUrl) {
        throw new Error('addLinkedSource: refusing to link the primary URL to itself');
    }
    const existing = await getLinkedSourcesByUrl(db, primaryUrl);
    if (existing.some(s => s.manga_url === newSource.manga_url)) return existing;
    const updated = [...existing, newSource];
    await db.runAsync(
        'UPDATE manga SET linked_sources = ? WHERE manga_url = ?',
        [serializeLinkedSources(updated), primaryUrl],
    );
    return updated;
}

/** Remove a linked source by its URL. Returns the updated list. */
export async function removeLinkedSource(
    db: SQLite.SQLiteDatabase,
    primaryUrl: string,
    sourceUrl: string,
): Promise<LinkedSource[]> {
    const existing = await getLinkedSourcesByUrl(db, primaryUrl);
    const updated = existing.filter(s => s.manga_url !== sourceUrl);
    if (updated.length === existing.length) return existing;
    await db.runAsync(
        'UPDATE manga SET linked_sources = ? WHERE manga_url = ?',
        [serializeLinkedSources(updated), primaryUrl],
    );
    return updated;
}

/** True if `url` matches the primary or any linked source for this comic. */
export function isAnySourceUrl(
    primaryUrl: string,
    linked: LinkedSource[],
    url: string,
): boolean {
    if (url === primaryUrl) return true;
    return linked.some(s => s.manga_url === url);
}
