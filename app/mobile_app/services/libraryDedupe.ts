/**
 * Folds library rows that are the same comic added from two sites into one
 * row with linked sources (plan: services/libraryMatch.ts planDuplicateMerges).
 *
 * Such rows share a title, and the cloud keeps one record per title, so they
 * fought over that record's URL: every cloud pull then tried to give one row
 * the other's URL, broke the unique-URL rule, and the whole restore rolled
 * back. Nothing the scheduled check found reached the phone.
 *
 * Two steps so the cloud is updated first: planLibraryMerges() reads, the
 * caller pushes the merged rows, and only then applyLibraryMerges() writes.
 */

import * as SQLite from 'expo-sqlite';
import { getLocalConfigs, matchConfigToUrlStrict } from './database';
import { planDuplicateMerges, DuplicateMerge } from './libraryMatch';
import { serializeLinkedSources } from './linkedSources';

const hostOf = (url: string): string => {
    const m = url.match(/^(?:https?:\/\/)?(?:www\.)?([^/:?#]+)/i);
    return m ? m[1] : '';
};

export interface PlannedMerge extends DuplicateMerge {
    /** The kept row as it will be, for the cloud push (pushAllToCloud shape). */
    mergedRow: any;
}

export async function planLibraryMerges(db: SQLite.SQLiteDatabase): Promise<PlannedMerge[]> {
    const rows = await db.getAllAsync<any>('SELECT * FROM manga ORDER BY id');
    const configs = await getLocalConfigs(db);
    const nameForUrl = (url: string) => matchConfigToUrlStrict(configs, url)?.website_name || hostOf(url);
    const plans = planDuplicateMerges(rows, nameForUrl, new Date().toISOString());
    return plans.map(p => ({
        ...p,
        mergedRow: {
            ...rows.find(r => r.id === p.keepId),
            linked_sources: serializeLinkedSources(p.linkedSources),
            chapter: p.chapter,
            last_read_date: p.lastReadDate,
        },
    }));
}

export async function applyLibraryMerges(db: SQLite.SQLiteDatabase, plans: readonly PlannedMerge[]): Promise<void> {
    if (plans.length === 0) return;
    await db.withTransactionAsync(async () => {
        for (const p of plans) {
            for (const id of p.removeIds) await db.runAsync('DELETE FROM manga WHERE id = ?', [id]);
            await db.runAsync(
                'UPDATE manga SET linked_sources = ?, chapter = ?, last_read_date = ? WHERE id = ?',
                [serializeLinkedSources(p.linkedSources), p.chapter, p.lastReadDate, p.keepId],
            );
            // Downloads and the saved chapter list follow the comic to its kept URL.
            for (const url of p.removedUrls) {
                await db.runAsync('UPDATE downloaded_chapters SET manga_url = ? WHERE manga_url = ?', [p.keepUrl, url]);
                await db.runAsync('DELETE FROM chapter_lists WHERE manga_url = ?', [url]);
            }
        }
    });
    console.log(`[SQLITE]: Merged ${plans.length} comic(s) that were in the library twice: ${plans.map(p => p.title).slice(0, 5).join(' | ')}`);
}
