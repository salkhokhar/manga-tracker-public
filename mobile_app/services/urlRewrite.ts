// Stale series URL rewrite.
//
// Asura Scans re-keys its series addresses (the trailing -<hex> id changes,
// e.g. ...-assassin-89829cb7 → ...-assassin-11fe7da3) and redirects the old
// ones. Library rows saved before the change keep the old address and pay a
// redirect on every load. When a load lands on the re-keyed address of the
// same series, the stored URL is rewritten once, everywhere it is used:
//   - manga.manga_url (primary source) and the Supabase manga_library row
//   - downloaded_chapters (manga_url and the chapter_url prefix; files stay put)
//   - linked_sources entries of any comic that links the old address
//
// Host-gated: only Asura re-keys this way, and only a same-slug move counts,
// so a redirect to some other page (login, home, another series) is ignored.

import * as SQLite from 'expo-sqlite';
import { supabase } from './supabase';
import { isAsuraUrl } from './chapterLocks';
import { parseLinkedSources, serializeLinkedSources } from './linkedSources';

const ASURA_SERIES_PATH_RE = /^\/comics\/([a-z0-9-]+?)(?:-([0-9a-f]{6,12}))?\/?$/i;

function seriesParts(url: string): { slug: string; id: string | null; path: string } | null {
    if (!isAsuraUrl(url)) return null;
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    const m = u.pathname.match(ASURA_SERIES_PATH_RE);
    if (!m) return null;
    return { slug: m[1].toLowerCase(), id: m[2] ? m[2].toLowerCase() : null, path: u.pathname.replace(/\/+$/, '') };
}

/**
 * True when `newUrl` is the same Asura series as `oldUrl` under a new id
 * (or a new Asura domain). Query strings and fragments are ignored.
 */
export function isAsuraSeriesRekey(oldUrl: unknown, newUrl: unknown): boolean {
    if (typeof oldUrl !== 'string' || typeof newUrl !== 'string') return false;
    const a = seriesParts(oldUrl);
    const b = seriesParts(newUrl);
    if (!a || !b || !b.id) return false;
    if (a.slug !== b.slug) return false;
    let hostA = '', hostB = '';
    try { hostA = new URL(oldUrl).hostname; hostB = new URL(newUrl).hostname; } catch { return false; }
    return a.path !== b.path || hostA !== hostB;
}

/** Canonical form stored after a rewrite: origin + path, no query or trailing slash. */
export function canonicalSeriesUrl(url: string): string {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/+$/, '');
}

export interface RewriteResult {
    /** Title whose primary manga_url changed, or null. */
    primaryTitle: string | null;
    /** Titles whose linked_sources changed. */
    linkedTitles: string[];
}

/**
 * Rewrite `oldUrl` to `newUrl` in the local database (one transaction), then
 * mirror the changed rows to Supabase (best effort). Safe to call repeatedly:
 * once rewritten, nothing matches the old URL any more.
 */
export async function rewriteSeriesUrl(
    db: SQLite.SQLiteDatabase,
    oldUrl: string,
    newUrl: string,
): Promise<RewriteResult> {
    const result: RewriteResult = { primaryTitle: null, linkedTitles: [] };
    if (!isAsuraSeriesRekey(oldUrl, newUrl)) return result;
    const target = canonicalSeriesUrl(newUrl);
    const oldPrefix = oldUrl.replace(/\/+$/, '') + '/';
    const newPrefix = target + '/';
    const linkedUpdates: { title: string; sources: ReturnType<typeof parseLinkedSources> }[] = [];

    await db.withTransactionAsync(async () => {
        const primary = await db.getFirstAsync<{ title: string }>('SELECT title FROM manga WHERE manga_url = ?', [oldUrl]);
        const clash = await db.getFirstAsync<{ title: string }>('SELECT title FROM manga WHERE manga_url = ?', [target]);
        if (primary && !clash) {
            await db.runAsync('UPDATE manga SET manga_url = ? WHERE manga_url = ?', [target, oldUrl]);
            result.primaryTitle = primary.title;
        }

        const downloads = await db.getAllAsync<{ id: number; chapter_url: string }>(
            'SELECT id, chapter_url FROM downloaded_chapters WHERE manga_url = ?', [oldUrl]);
        for (const d of downloads) {
            const chapterUrl = d.chapter_url.startsWith(oldPrefix) ? newPrefix + d.chapter_url.slice(oldPrefix.length) : d.chapter_url;
            await db.runAsync('UPDATE OR IGNORE downloaded_chapters SET manga_url = ?, chapter_url = ? WHERE id = ?', [target, chapterUrl, d.id]);
        }

        const rows = await db.getAllAsync<{ title: string; linked_sources: string | null }>(
            "SELECT title, linked_sources FROM manga WHERE linked_sources LIKE ?", ['%' + oldUrl + '%']);
        for (const row of rows) {
            const sources = parseLinkedSources(row.linked_sources);
            if (!sources.some(s => s.manga_url === oldUrl)) continue;
            const updated = sources.map(s => (s.manga_url === oldUrl ? { ...s, manga_url: target } : s));
            await db.runAsync('UPDATE manga SET linked_sources = ? WHERE title = ?', [serializeLinkedSources(updated), row.title]);
            linkedUpdates.push({ title: row.title, sources: updated });
            result.linkedTitles.push(row.title);
        }
    });

    if (result.primaryTitle || linkedUpdates.length > 0) {
        console.log(`[URL REWRITE]: ${oldUrl} → ${target} (primary: ${result.primaryTitle ? 'yes' : 'no'}, linked: ${linkedUpdates.length})`);
        try {
            const { data: { session } } = await supabase.auth.getSession();
            const userId = session?.user?.id;
            if (userId) {
                if (result.primaryTitle) {
                    const { error } = await supabase.from('manga_library')
                        .update({ manga_url: target })
                        .match({ user_id: userId, title: result.primaryTitle });
                    if (error) console.warn('[URL REWRITE]: cloud primary update failed:', error.message);
                }
                for (const u of linkedUpdates) {
                    const { error } = await supabase.from('manga_library')
                        .update({ linked_sources: u.sources })
                        .match({ user_id: userId, title: u.title });
                    if (error) console.warn('[URL REWRITE]: cloud linked update failed:', error.message);
                }
            }
        } catch (e: any) {
            console.warn('[URL REWRITE]: cloud sync exception:', e?.message || e);
        }
    }
    return result;
}
