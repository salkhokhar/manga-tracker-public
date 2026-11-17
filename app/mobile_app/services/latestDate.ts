// latest_date: when a comic last got a new chapter.
//
// The column is free text shared with the desktop app, which stores
// "16 Apr 2026" (it normalizes "16.04.2026" and "2026-04-16") but keeps any
// other site format as-is, including relative ones like "1 day ago". Sorting
// it as text put "18 Sep 2021" above "16 Apr 2026", so the Library parses it.
//
// Relative values ("11 hours ago") carry no reference date: the desktop saved
// them as the site showed them, possibly months ago. They are read relative to
// now until the next refresh, which replaces every one it can with the site's
// own date for that chapter (extractMadaraChapterDates, read at fetch time).

import { parseChapterNumber } from './chapterNumber';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const UNIT_MS: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    mo: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000,
};

function monthIndex(name: string): number {
    const i = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
    return i;
}

// A date with no time is that calendar day where the user is (local midnight),
// so formatting it back with local getters never shifts it by a day.
function utc(year: number, month: number, day: number): number | null {
    if (month < 0 || month > 11 || day < 1 || day > 31 || year < 1990 || year > 2100) return null;
    return new Date(year, month, day).getTime();
}

function unitKey(unit: string): string | null {
    const u = unit.toLowerCase();
    if (u.startsWith('sec')) return 's';
    if (u.startsWith('min')) return 'm';
    if (u.startsWith('h')) return 'h';
    if (u.startsWith('d')) return 'd';
    if (u.startsWith('w')) return 'w';
    if (u.startsWith('mo')) return 'mo';
    if (u.startsWith('y')) return 'y';
    return null;
}

/** Milliseconds since epoch for a latest_date string, or null when unreadable. */
export function parseLatestDate(value: unknown, nowMs: number = Date.now()): number | null {
    if (typeof value !== 'string') return null;
    const s = value.trim().replace(/\s+/g, ' ');
    if (!s) return null;
    let m: RegExpMatchArray | null;

    // "16 Apr 2026", "16 April 2026"
    if ((m = s.match(/^(\d{1,2}) ([A-Za-z]{3,9})\.?,? (\d{4})$/))) return utc(+m[3], monthIndex(m[2]), +m[1]);
    // "Apr 16, 2026", "April 16 2026"
    if ((m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/))) return utc(+m[3], monthIndex(m[1]), +m[2]);
    // "16.04.2026" (MangaRead and other Madara sites)
    if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) return utc(+m[3], +m[2] - 1, +m[1]);
    // UTC timestamp written by this app or the scheduled check: "2026-10-26T13:05Z"
    if ((m = s.match(ISO_TIME_RE))) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    // "2026-04-16", "2023-03-02 00:00:00" (desktop last_read_date)
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return utc(+m[1], +m[2] - 1, +m[3]);
    // "04/16/2026" (US order)
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return utc(+m[3], +m[1] - 1, +m[2]);

    // Relative: "11 hours ago", "a day ago", "1 mins ago", "just now", "yesterday"
    const lower = s.toLowerCase();
    if (lower === 'just now' || lower === 'today' || lower === 'now') return nowMs;
    if (lower === 'yesterday') return nowMs - UNIT_MS.d;
    if ((m = lower.match(/^(\d+|an?|one) ?(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mos?|years?|yrs?|y) ago$/))) {
        const n = /^\d+$/.test(m[1]) ? +m[1] : 1;
        const key = unitKey(m[2]);
        return key ? nowMs - n * UNIT_MS[key] : null;
    }
    return null;
}

const MAX_DATE_ROWS = 50;
const ISO_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/** True for a stored timestamp ("2026-10-26T13:05Z"), false for a plain day. */
export function hasTime(value: unknown): boolean {
    return typeof value === 'string' && ISO_TIME_RE.test(value.trim());
}

/**
 * UTC timestamp to the minute, "2026-10-26T13:05Z", for a release whose time
 * is known (a relative "6 hours ago", or a chapter found just now). A plain day
 * would tie every same-day release and sort them by title.
 */
export function isoMinute(ms: number = Date.now()): string {
    return new Date(ms).toISOString().slice(0, 16) + 'Z';
}

function textOf(html: string): string {
    return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Release date per chapter number from a Madara-theme series page (MangaRead
 * and similar), ready to store: each `li.wp-manga-chapter` row holds the
 * chapter link and a `chapter-release-date` span with "31.07.2026" or "July 31,
 * 2026" (stored as "31 Jul 2026"), or, for new chapters, a relative "6 hours
 * ago" as text or a `title` attribute (resolved against `nowMs`, the moment the
 * page was fetched, and stored as a UTC timestamp).
 */
export function extractMadaraChapterDates(html: unknown, nowMs: number = Date.now()): Map<number, string> {
    const out = new Map<number, string>();
    if (typeof html !== 'string' || html.indexOf('chapter-release-date') === -1) return out;
    const rowRe = /<li\b[^>]*class="[^"]*\bwp-manga-chapter\b[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
    let m: RegExpExecArray | null;
    let rows = 0;
    while ((m = rowRe.exec(html)) !== null && rows < MAX_DATE_ROWS) {
        rows++;
        const row = m[1];
        const link = row.match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
        const n = link ? parseChapterNumber(textOf(link[1])) : null;
        if (n === null || out.has(n)) continue;
        const span = row.match(/chapter-release-date[^>]*>([\s\S]*?)<\/span>/);
        if (!span) continue;
        const titled = span[1].match(/title="([^"]+)"/);
        const raw = parseLatestDate(textOf(span[1]), nowMs) !== null ? textOf(span[1]) : (titled ? titled[1] : '');
        const ms = parseLatestDate(raw, nowMs);
        if (ms === null) continue;
        // A dated row carries its year; a relative one ("6 hours ago") doesn't.
        out.set(n, /\d{4}/.test(raw) ? formatLatestDate(new Date(ms)) : isoMinute(ms));
    }
    return out;
}

/** Today in the desktop app's format ("16 Apr 2026"), for a chapter just found. */
export function formatLatestDate(date: Date = new Date()): string {
    const d = String(date.getDate()).padStart(2, '0');
    return `${d} ${MONTH_LABELS[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * Library order for a date column ("Latest update" uses latest_date, "Recently
 * read" uses last_read_date, which the desktop writes as "2023-03-02 00:00:00"
 * or "18.04.2026"): newest first, unreadable or missing dates last, ties by
 * title. Parses each row once.
 */
export function sortByDateField<T extends { title?: unknown }>(
    rows: T[],
    field: 'latest_date' | 'last_read_date',
    nowMs: number = Date.now(),
): T[] {
    const keyed = rows.map(row => ({ row, t: parseLatestDate((row as any)[field], nowMs) }));
    keyed.sort((a, b) => {
        if (a.t !== b.t) {
            if (a.t === null) return 1;
            if (b.t === null) return -1;
            return b.t - a.t;
        }
        return String(a.row.title || '').localeCompare(String(b.row.title || ''));
    });
    return keyed.map(k => k.row);
}
