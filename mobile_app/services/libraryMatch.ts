/**
 * "Is this comic already in the library under another site?"
 *
 * Adding the same series from a second site used to create a second library
 * entry (its URL differs, and titles are only unique per row). Before an add,
 * the screens look for a library row whose names (title + alternative names)
 * match the new title, so the new site can be linked as another source of
 * that row instead. Pure, so it can be unit tested.
 */

import { bestNameSimilarity, SUGGESTION_THRESHOLD } from './titleMatch';
import { namesForMatching } from './altNames';
import { parseLinkedSources, LinkedSource } from './linkedSources';

export interface LibraryRowLike {
    title: string;
    manga_url?: string | null;
    alternative_names?: string | null;
    linked_sources?: unknown;
}

/**
 * The library row that is the same series as `title` at `url`, or null.
 * A row with that exact URL as primary or linked source is not a match: it is
 * the same entry, not a duplicate. The best-scoring row wins at a tie.
 */
export function findSameSeries<T extends LibraryRowLike>(library: readonly T[], title: string, url: string): T | null {
    const incoming = namesForMatching(title, '');
    if (incoming.length === 0) return null;
    let best: T | null = null;
    let bestScore = 0;
    for (const row of library) {
        if (!row || typeof row.title !== 'string') continue;
        if (row.manga_url === url) continue;
        if (parseLinkedSources(row.linked_sources).some(s => s.manga_url === url)) continue;
        const score = bestNameSimilarity(incoming, namesForMatching(row.title, row.alternative_names || ''));
        if (score >= SUGGESTION_THRESHOLD && score > bestScore) {
            best = row;
            bestScore = score;
        }
    }
    return best;
}

export interface DuplicateMerge {
    /** Shared title of the rows. */
    title: string;
    /** Row that stays (the oldest: lowest id) and its primary URL. */
    keepId: number;
    keepUrl: string;
    /** Rows folded into it. */
    removeIds: number[];
    removedUrls: string[];
    /** linked_sources of the kept row afterwards. */
    linkedSources: LinkedSource[];
    /** Reading progress afterwards: the furthest of the rows, with its date. */
    chapter: string;
    lastReadDate: string;
}

export interface MergeRowLike extends LibraryRowLike {
    id: number;
    chapter?: string | null;
    last_read_date?: string | null;
}

const chapterNo = (v: unknown): number => {
    const m = typeof v === 'string' ? v.match(/\d+(?:\.\d+)?/) : null;
    return m ? parseFloat(m[0]) : -1;
};

/**
 * Library rows that share a title but have different URLs are the same comic
 * added from two sites. Titles are unique in the cloud, so those rows share
 * one cloud record and fight over its URL on every sync. Plans folding each
 * group into its oldest row: the other rows' URLs, and whatever they had
 * linked, become linked sources of it; the furthest reading progress is kept.
 * `nameForUrl` gives the scraper config name for a URL.
 */
export function planDuplicateMerges(rows: readonly MergeRowLike[], nameForUrl: (url: string) => string, now: string): DuplicateMerge[] {
    const groups = new Map<string, MergeRowLike[]>();
    for (const r of rows) {
        if (!r || typeof r.title !== 'string' || !r.title.trim()) continue;
        const key = r.title.trim().toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
    }
    const plans: DuplicateMerge[] = [];
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const sorted = [...group].sort((a, b) => a.id - b.id);
        const keep = sorted[0];
        const keepUrl = keep.manga_url || '';
        if (!keepUrl) continue;
        const linked: LinkedSource[] = parseLinkedSources(keep.linked_sources);
        const seen = new Set<string>([keepUrl, ...linked.map(s => s.manga_url)]);
        let best = keep;
        const removedUrls: string[] = [];
        for (const dup of sorted.slice(1)) {
            if (chapterNo(dup.chapter) > chapterNo(best.chapter)) best = dup;
            const dupUrl = dup.manga_url || '';
            if (dupUrl) removedUrls.push(dupUrl);
            const incoming: LinkedSource[] = [
                ...(dupUrl ? [{ website_name: nameForUrl(dupUrl), manga_url: dupUrl, added_at: now }] : []),
                ...parseLinkedSources(dup.linked_sources),
            ];
            for (const s of incoming) {
                if (!s.website_name || seen.has(s.manga_url)) continue;
                seen.add(s.manga_url);
                linked.push(s);
            }
        }
        plans.push({
            title: keep.title,
            keepId: keep.id,
            keepUrl,
            removeIds: sorted.slice(1).map(r => r.id),
            removedUrls,
            linkedSources: linked,
            chapter: best.chapter || keep.chapter || '',
            lastReadDate: best.last_read_date || keep.last_read_date || '',
        });
    }
    return plans;
}
