// M2b — merge the chapter lists of a comic's primary source and its linked
// sources into one list for the Details screen.
//
// Rules (agreed 2026-10-22):
//   - Rows are keyed by parseChapterNumber(title). The primary's row always
//     wins for a number it has; linked sources with the same number attach as
//     `alternates` on that row.
//   - A number the primary lacks is supplied by the first linked source (in
//     linked_sources order) that has it; later sources attach as alternates.
//   - Linked-only rows are inserted at their numeric position in the primary's
//     own order (sites list newest-first, but the direction is detected from
//     the primary's numbers rather than assumed).
//   - Primary rows with no parseable number keep their place. Linked rows with
//     no parseable number are DROPPED — a linked site's deep-link-scan fallback
//     must not flood the merged list.
//   - Every row carries its own `link` (the chapter URL on whichever site
//     supplied it) and `website_name`, so the reader and downloads keep working
//     per chapter URL with no changes.
//
// Pure function, no RN imports: it's exercised by a node script outside the repo.

import { parseChapterNumber } from './chapterNumber';
import type { ChapterInfo } from './chapterCache';

export interface ChapterAlternate {
    link: string;
    website_name: string;
    title: string;
}

export interface MergedChapter extends ChapterInfo {
    website_name: string;
    /** Parsed chapter number, or null when the title had none (primary rows only). */
    number: number | null;
    alternates?: ChapterAlternate[];
}

export interface SourceChapterList {
    website_name: string;
    chapters: ChapterInfo[];
}

function isUsableRow(c: unknown): c is ChapterInfo {
    if (!c || typeof c !== 'object') return false;
    const r = c as Record<string, unknown>;
    return typeof r.link === 'string' && r.link.length > 0;
}

/**
 * Detects the primary list's ordering from its parsed numbers. Returns true
 * for newest-first (descending), which is also the default when there is no
 * usable signal (0 or 1 numbered rows, or a tie).
 */
export function isDescending(numbers: (number | null)[]): boolean {
    let desc = 0;
    let asc = 0;
    let prev: number | null = null;
    for (const n of numbers) {
        if (n === null) continue;
        if (prev !== null) {
            if (n < prev) desc++;
            else if (n > prev) asc++;
        }
        prev = n;
    }
    return desc >= asc;
}

export function mergeChapterLists(
    primary: ChapterInfo[],
    primaryName: string,
    linked: SourceChapterList[],
): MergedChapter[] {
    const seenLinks = new Set<string>();
    const byNumber = new Map<number, MergedChapter>();

    // Backbone: the primary list, order preserved, deduped by link. The first
    // row for a given number owns that number; later same-number primary rows
    // (rare — e.g. a site listing "Ch. 5" and "Ch. 5 (fixed)") are kept as
    // ordinary rows but don't take over the number.
    const backbone: MergedChapter[] = [];
    for (const raw of primary) {
        if (!isUsableRow(raw) || seenLinks.has(raw.link)) continue;
        seenLinks.add(raw.link);
        const row: MergedChapter = {
            title: typeof raw.title === 'string' ? raw.title : '',
            link: raw.link,
            date: raw.date,
            website_name: primaryName,
            number: parseChapterNumber(raw.title),
        };
        backbone.push(row);
        if (row.number !== null && !byNumber.has(row.number)) byNumber.set(row.number, row);
    }

    // Linked sources: same number → alternate; new number → linked-only row.
    const extras: MergedChapter[] = [];
    for (const source of linked) {
        if (!source || !Array.isArray(source.chapters)) continue;
        for (const raw of source.chapters) {
            if (!isUsableRow(raw) || seenLinks.has(raw.link)) continue;
            const number = parseChapterNumber(raw.title);
            if (number === null) continue; // dropped by design
            seenLinks.add(raw.link);
            const title = typeof raw.title === 'string' ? raw.title : '';
            const owner = byNumber.get(number);
            if (owner) {
                if (!owner.alternates) owner.alternates = [];
                owner.alternates.push({ link: raw.link, website_name: source.website_name, title });
                continue;
            }
            const row: MergedChapter = {
                title,
                link: raw.link,
                date: raw.date,
                website_name: source.website_name,
                number,
            };
            byNumber.set(number, row);
            extras.push(row);
        }
    }

    if (extras.length === 0) return backbone;

    // Single pass: walk the backbone and emit each linked-only row just before
    // the first numbered primary row that comes after it in list order.
    const descending = isDescending(backbone.map(r => r.number));
    extras.sort((a, b) => descending
        ? (b.number as number) - (a.number as number)
        : (a.number as number) - (b.number as number));

    const out: MergedChapter[] = [];
    let i = 0;
    const comesBefore = (extra: number, anchor: number) => descending ? extra > anchor : extra < anchor;
    for (const row of backbone) {
        if (row.number !== null) {
            while (i < extras.length && comesBefore(extras[i].number as number, row.number)) {
                out.push(extras[i++]);
            }
        }
        out.push(row);
    }
    while (i < extras.length) out.push(extras[i++]);
    return out;
}
