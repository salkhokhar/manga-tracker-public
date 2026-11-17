// Two-way title sync with Supabase: same rules as the desktop's
// library_merge.plan_sync, so a comic added or deleted on either device ends up
// the same on both.
//
// `base` is the set of titles the cloud held after this device's last sync for
// this account (null before the first one). A title missing on one side is
// resolved by whether it was there last time:
//
//   in cloud only, not in base  → added elsewhere        → restored here (normal pull)
//   in cloud only, in base      → deleted on this device → deleteCloud
//   local only, in base         → deleted elsewhere      → deleteLocal
//   local only, not in base     → new here, not synced   → pushNew
//
// Safety: no deletions on the first sync, none when the cloud comes back empty
// while the base was not, none when the local library is empty (a restore after
// sign-out), and none on a side where more than deletionLimit() would go.

export interface SyncPlan {
    deleteCloud: Set<string>;
    deleteLocal: Set<string>;
    pushNew: Set<string>;
    blocked: string[];
}

export const SNAPSHOT_KEY_PREFIX = 'cloud_titles_snapshot:';

/** Most titles one sync may delete on one side: 5, or 20% of a big library. */
export function deletionLimit(size: number): number {
    return Math.max(5, Math.ceil(size * 0.2));
}

export function planSync(local: Set<string>, cloud: Set<string>, base: Set<string> | null): SyncPlan {
    const plan: SyncPlan = { deleteCloud: new Set(), deleteLocal: new Set(), pushNew: new Set(), blocked: [] };
    const localOnly = [...local].filter(t => !cloud.has(t));
    const cloudOnly = [...cloud].filter(t => !local.has(t));
    if (base === null) {
        plan.blocked.push('first sync on this device: nothing deleted');
        localOnly.forEach(t => plan.pushNew.add(t));
        return plan;
    }
    if (cloud.size === 0 && base.size > 0) {
        plan.blocked.push('cloud returned no titles: nothing deleted');
        return plan;
    }
    if (local.size === 0 && base.size > 0) {
        plan.blocked.push('local library is empty: restoring, nothing deleted');
        return plan;
    }
    cloudOnly.filter(t => base.has(t)).forEach(t => plan.deleteCloud.add(t));
    localOnly.forEach(t => (base.has(t) ? plan.deleteLocal : plan.pushNew).add(t));
    if (plan.deleteCloud.size > deletionLimit(cloud.size)) {
        plan.blocked.push(`${plan.deleteCloud.size} cloud deletions is too many: skipped`);
        plan.deleteCloud.clear();
    }
    if (plan.deleteLocal.size > deletionLimit(local.size)) {
        plan.blocked.push(`${plan.deleteLocal.size} local deletions is too many: skipped`);
        plan.deleteLocal.clear();
    }
    return plan;
}

export function parseSnapshot(raw: unknown): Set<string> | null {
    if (typeof raw !== 'string' || !raw) return null;
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? new Set(arr.filter((t: unknown): t is string => typeof t === 'string')) : null;
    } catch {
        return null;
    }
}
