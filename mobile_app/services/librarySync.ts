// Library load: bring the local library in line with the cloud in both
// directions (see syncPlan.ts for the rules). Replaces the old one-way pull,
// which only ever added and updated rows, so a comic deleted on the desktop
// stayed on the phone, and one deleted here while offline came back.

import * as SQLite from 'expo-sqlite';
import { bulkRestoreLocal, getLocalLibrary, getSetting, setSetting } from './database';
import { removeFromCloud, pushAllToCloud } from './supabase';
import { planSync, parseSnapshot, SNAPSHOT_KEY_PREFIX } from './syncPlan';

const titleOf = (r: any): string => (typeof r?.title === 'string' ? r.title.trim() : '');

export async function syncLibraryWithCloud(db: SQLite.SQLiteDatabase, userId: string, cloudData: any[]): Promise<void> {
    const snapshotKey = SNAPSHOT_KEY_PREFIX + userId;
    const localRows: any[] = await getLocalLibrary(db);
    const local = new Set(localRows.map(titleOf).filter(Boolean));
    const cloud = new Set(cloudData.map(titleOf).filter(Boolean));
    const plan = planSync(local, cloud, parseSnapshot(await getSetting(db, snapshotKey, '')));
    plan.blocked.forEach(reason => console.log(`[SYNC]: ${reason}`));

    // Deleted on this phone (e.g. while offline): remove from the cloud, and
    // don't restore it below.
    const deletedHere = new Set<string>();
    for (const t of plan.deleteCloud) {
        const res = await removeFromCloud(userId, t);
        if (res.ok) deletedHere.add(t);
    }
    if (deletedHere.size) console.log(`[SYNC]: Removed ${deletedHere.size} comic(s) deleted on this phone from the cloud`);

    const toRestore = cloudData.filter(r => !plan.deleteCloud.has(titleOf(r)));
    if (toRestore.length > 0) {
        console.log(`[SYNC]: Restoring ${toRestore.length} cloud records to local SQLite`);
        try {
            await bulkRestoreLocal(db, toRestore);
        } catch (e: any) {
            // A failed restore must not stop the rest of the load (local
            // library display, scraper configs for Discover).
            console.error('[SYNC]: Cloud restore failed; showing the local library', e?.message || e);
        }
    }

    // Deleted on another device: remove here.
    for (const t of plan.deleteLocal) {
        await db.runAsync('DELETE FROM manga WHERE title = ?', [t]);
    }
    if (plan.deleteLocal.size) console.log(`[SYNC]: Removed ${plan.deleteLocal.size} comic(s) deleted on another device: ${[...plan.deleteLocal].slice(0, 5).join(' | ')}`);

    // Added here but never reached the cloud (e.g. offline add): upload.
    let pushed = new Set<string>();
    if (plan.pushNew.size) {
        const rows = localRows.filter(r => plan.pushNew.has(titleOf(r)));
        const res = await pushAllToCloud(userId, rows);
        if (res.ok) pushed = new Set(plan.pushNew);
        console.log(`[SYNC]: Uploaded ${pushed.size} comic(s) added on this phone`);
    }

    const snapshot = [...cloud].filter(t => !deletedHere.has(t)).concat([...pushed]);
    await setSetting(db, snapshotKey, JSON.stringify(snapshot.sort()));
}
