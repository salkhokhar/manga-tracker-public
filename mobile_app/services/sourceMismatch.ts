// Linked-source sanity check: does a linked (or suggested) source look like a
// different series from the primary?
//
// Real case: a comic with 149 chapters on its primary and two linked sites had
// a third linked site returning 11 chapters — a different series that shared
// the title. Its rows fed the merged chapter list and the reader fallback.
//
// Rule: only judged when the primary has enough numbered chapters to compare
// against. A linked source whose highest chapter number is below half of the
// primary's highest, or more than double it, is flagged. A source with no
// numbered chapters at all is not judged (more likely a failed scrape).

import { parseChapterNumber } from './chapterNumber';

export const MIN_PRIMARY_NUMBERED = 20;
export const LOW_RATIO = 0.5;
export const HIGH_RATIO = 2;

export type MismatchReason = 'too_few' | 'too_many';

export interface MismatchVerdict {
    reason: MismatchReason;
    primaryMax: number;
    linkedMax: number;
}

export function chapterNumberStats(list: unknown): { max: number | null; numbered: number } {
    let max: number | null = null;
    let numbered = 0;
    if (!Array.isArray(list)) return { max, numbered };
    for (const row of list) {
        const n = row && typeof row === 'object' ? parseChapterNumber((row as any).title) : null;
        if (n === null) continue;
        numbered++;
        if (max === null || n > max) max = n;
    }
    return { max, numbered };
}

/** A verdict when `linked` looks like a different series from `primary`, else null. */
export function checkSourceMismatch(primary: unknown, linked: unknown): MismatchVerdict | null {
    const p = chapterNumberStats(primary);
    if (p.max === null || p.numbered < MIN_PRIMARY_NUMBERED) return null;
    const l = chapterNumberStats(linked);
    if (l.max === null) return null;
    if (l.max < p.max * LOW_RATIO) return { reason: 'too_few', primaryMax: p.max, linkedMax: l.max };
    if (l.max > p.max * HIGH_RATIO) return { reason: 'too_many', primaryMax: p.max, linkedMax: l.max };
    return null;
}

/** One-line explanation for the chip alert and the logs. */
export function describeMismatch(v: MismatchVerdict, sourceName: string, primaryName: string): string {
    return `"${sourceName}" lists chapters up to ${v.linkedMax}, but ${primaryName} goes up to ${v.primaryMax}. `
        + `It is probably a different series, so its chapters are hidden.`;
}
