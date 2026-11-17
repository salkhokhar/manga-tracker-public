import * as SQLite from 'expo-sqlite';
import { pickLatestChapter } from './chapterNumber';
import { hasTime } from './latestDate';
import { ratingScaleFor, splitCloudRating, migrateLegacyRating } from './rating';

// SQL injection guard for any code path that interpolates a column name into a
// SET clause (we can't parametrise identifiers in SQL, only values). Anything
// that builds dynamic `UPDATE manga SET <col> = ?` SQL must run assertMangaColumns
// first to whitelist the column names.
//
// Today every caller passes hardcoded keys, so this is defence-in-depth — but
// the moment someone wires user input into one of those keys without the guard,
// it would otherwise become a clean injection. With the guard the worst case is
// a thrown Error, surfaced to the caller as a failed update.
export const ALLOWED_MANGA_COLUMNS: ReadonlySet<string> = new Set([
    'title',
    'manga_url',
    'cover_url',
    'chapter',
    'last_read_date',
    'latest_chapter',
    'latest_date',
    'genre',
    'author',
    'description',
    'rating',
    'alternative_names',
    'favorite',
    'category',
    'status',
    'notes',
    'linked_sources',
    'latest_source',
    'site_rating',
]);

export function assertMangaColumns(cols: readonly string[]): void {
    if (cols.length === 0) {
        throw new Error('assertMangaColumns: refusing to build SQL with no columns');
    }
    for (const c of cols) {
        if (!ALLOWED_MANGA_COLUMNS.has(c)) {
            throw new Error(`assertMangaColumns: rejected column "${c}" — not in whitelist`);
        }
    }
}

export async function initDatabase() {
    const db = await SQLite.openDatabaseAsync('manga_tracker.db');
    
    // Create the exact core table matching the desktop Python schema!
    await db.execAsync(`
        CREATE TABLE IF NOT EXISTS manga (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            manga_url TEXT UNIQUE,
            cover_url TEXT,
            chapter TEXT,
            last_read_date TEXT,
            latest_chapter TEXT,
            latest_date TEXT,
            genre TEXT,
            author TEXT,
            description TEXT,
            rating TEXT,
            alternative_names TEXT,
            favorite BOOLEAN DEFAULT FALSE,
            category TEXT DEFAULT 'Reading',
            status TEXT DEFAULT 'Unknown',
            notes TEXT DEFAULT '',
            linked_sources TEXT DEFAULT '[]',
            latest_source TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS scraper_configs (
            website_name TEXT PRIMARY KEY,
            json_rules TEXT
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS chapter_lists (
            manga_url TEXT PRIMARY KEY,
            chapters TEXT NOT NULL,
            saved_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS downloaded_chapters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            manga_url TEXT NOT NULL,
            manga_title TEXT NOT NULL,
            chapter_url TEXT UNIQUE NOT NULL,
            chapter_title TEXT NOT NULL,
            local_dir TEXT NOT NULL,
            image_count INTEGER DEFAULT 0,
            total_size_bytes INTEGER DEFAULT 0,
            downloaded_at TEXT NOT NULL
        );
    `);

    // Idempotent column migrations for existing installs. CREATE TABLE IF NOT
    // EXISTS only runs on fresh DBs, so anyone who installed before a column
    // existed needs ALTER TABLE. PRAGMA table_info lets us add only what's
    // missing without a try/catch swallow.
    await ensureColumn(db, 'manga', 'linked_sources', `TEXT DEFAULT '[]'`);
    // website_name of the linked source that produced latest_chapter, or ''
    // when it came from the primary. Local-only (not synced to Supabase) —
    // same as the latest_chapter values runChapterCheck writes.
    await ensureColumn(db, 'manga', 'latest_source', `TEXT DEFAULT ''`);
    // The primary site's own average on the 5-point scale (services/rating.ts).
    // Local-only like latest_source: Details reads it from the page again on
    // every open, so it needs no cloud column.
    await ensureColumn(db, 'manga', 'site_rating', `TEXT DEFAULT ''`);

    return db;
}

const RATING_MIGRATION_KEY = 'rating_split_v2';

/**
 * One-time split of the old `rating` column into the reader's rating and the
 * site's rating (migrateLegacyRating). Runs once per install, after a
 * successful cloud sync so the corrected values can be pushed back and a later
 * pull does not bring the old ones in again. Returns the titles whose `rating`
 * changed, for that push.
 */
export async function migrateRatingColumns(db: SQLite.SQLiteDatabase): Promise<string[]> {
    if (await getSetting(db, RATING_MIGRATION_KEY, '') === '1') return [];
    const configs = await getLocalConfigs(db);
    const rows = await db.getAllAsync<{ title: string; manga_url: string | null; rating: string | null }>(
        "SELECT title, manga_url, rating FROM manga WHERE rating IS NOT NULL AND rating != ''"
    );
    const changed: string[] = [];
    await db.withTransactionAsync(async () => {
        for (const row of rows) {
            const scale = ratingScaleFor(matchConfigToUrlStrict(configs, row.manga_url || '')?.json_rules);
            const split = migrateLegacyRating(row.rating, scale);
            if (split.rating === (row.rating || '') && split.siteRating === null) continue;
            await db.runAsync(
                'UPDATE manga SET rating = ?, site_rating = COALESCE(?, site_rating) WHERE title = ?',
                [split.rating, split.siteRating, row.title],
            );
            if (split.rating !== (row.rating || '')) changed.push(row.title);
        }
    });
    await setSetting(db, RATING_MIGRATION_KEY, '1');
    if (rows.length) console.log(`[SQLITE]: Rating split: ${rows.length} rated comic(s) checked, ${changed.length} rating(s) changed`);
    return changed;
}

async function ensureColumn(
    db: SQLite.SQLiteDatabase,
    table: string,
    column: string,
    definition: string,
): Promise<void> {
    const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
    if (cols.some(c => c.name === column)) return;
    try {
        await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (e: any) {
        // initDatabase() runs from several screens at once on launch, so two
        // callers can both see the column missing and race to add it. The
        // loser's "duplicate column" error means the column now exists.
        if (String(e?.message || e).toLowerCase().includes('duplicate column name')) return;
        throw e;
    }
}

export async function getSetting(db: SQLite.SQLiteDatabase, key: string, fallback: string = ''): Promise<string> {
    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
    return row?.value ?? fallback;
}

export async function setSetting(db: SQLite.SQLiteDatabase, key: string, value: string): Promise<void> {
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

export async function getAllSettings(db: SQLite.SQLiteDatabase): Promise<Record<string, string>> {
    const rows = await db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM settings');
    const out: Record<string, string> = {};
    rows.forEach(r => { out[r.key] = r.value; });
    return out;
}

// Wipe user-personal local data on sign-out so the next account doesn't see stale rows.
// Keeps device-level settings (theme, defaults, sort prefs) — those follow the device, not the user.
// Keeps scraper_configs (shared catalog) and downloaded_chapters (orphaned files can be cleared
// from Profile → Storage if needed).
export async function clearUserData(db: SQLite.SQLiteDatabase): Promise<void> {
    console.log('[SQLITE]: Clearing user-personal data on sign-out (library + avatar)');
    // Also drop the sync snapshots (services/syncPlan.ts): after sign-out the
    // empty library is a fresh start, never "everything was deleted here".
    await db.execAsync(`
        DELETE FROM manga;
        DELETE FROM chapter_lists;
        DELETE FROM settings WHERE key = 'avatar';
        DELETE FROM settings WHERE key LIKE 'cloud_titles_snapshot:%';
    `);
}

/* ───── Saved chapter lists ─────────────────────────────────────────────── */

// The chapter list Details last showed for a library comic, so the screen has
// something to show at once, and at all without a connection (downloaded
// chapters stay readable offline). Replaced by every successful load.
const MAX_SAVED_CHAPTERS = 5000;

export interface SavedChapter { title: string; link: string; date?: string; website_name?: string }

export async function saveChapterList(db: SQLite.SQLiteDatabase, mangaUrl: string, chapters: readonly SavedChapter[]): Promise<void> {
    if (!mangaUrl || chapters.length === 0) return;
    const rows = chapters.slice(0, MAX_SAVED_CHAPTERS).map(c => ({
        title: String(c.title || ''), link: String(c.link || ''),
        ...(c.date ? { date: String(c.date) } : {}),
        ...(c.website_name ? { website_name: String(c.website_name) } : {}),
    }));
    await db.runAsync(
        'INSERT OR REPLACE INTO chapter_lists (manga_url, chapters, saved_at) VALUES (?, ?, ?)',
        [mangaUrl, JSON.stringify(rows), new Date().toISOString()],
    );
}

export async function getSavedChapterList(db: SQLite.SQLiteDatabase, mangaUrl: string): Promise<SavedChapter[]> {
    const row = await db.getFirstAsync<{ chapters: string }>('SELECT chapters FROM chapter_lists WHERE manga_url = ?', [mangaUrl]);
    if (!row) return [];
    try {
        const parsed = JSON.parse(row.chapters);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(c => c && typeof c.title === 'string' && typeof c.link === 'string' && c.link.length > 0)
            .slice(0, MAX_SAVED_CHAPTERS);
    } catch {
        return [];
    }
}

/* ───── Downloaded chapters ─────────────────────────────────────────────── */

export interface DownloadedChapter {
    id: number;
    manga_url: string;
    manga_title: string;
    chapter_url: string;
    chapter_title: string;
    local_dir: string;
    image_count: number;
    total_size_bytes: number;
    downloaded_at: string;
}

export async function recordChapterDownload(db: SQLite.SQLiteDatabase, dl: Omit<DownloadedChapter, 'id'>): Promise<void> {
    await db.runAsync(`
        INSERT OR REPLACE INTO downloaded_chapters
            (manga_url, manga_title, chapter_url, chapter_title, local_dir, image_count, total_size_bytes, downloaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [dl.manga_url, dl.manga_title, dl.chapter_url, dl.chapter_title, dl.local_dir, dl.image_count, dl.total_size_bytes, dl.downloaded_at]);
}

export async function getDownloadedChapter(db: SQLite.SQLiteDatabase, chapterUrl: string): Promise<DownloadedChapter | null> {
    const row = await db.getFirstAsync<DownloadedChapter>('SELECT * FROM downloaded_chapters WHERE chapter_url = ?', [chapterUrl]);
    return row || null;
}

export async function getDownloadedChaptersForManga(db: SQLite.SQLiteDatabase, mangaUrl: string): Promise<DownloadedChapter[]> {
    return await db.getAllAsync<DownloadedChapter>('SELECT * FROM downloaded_chapters WHERE manga_url = ? ORDER BY downloaded_at DESC', [mangaUrl]);
}

export async function getAllDownloadedMangaUrls(db: SQLite.SQLiteDatabase): Promise<Set<string>> {
    const rows = await db.getAllAsync<{ manga_url: string }>('SELECT DISTINCT manga_url FROM downloaded_chapters');
    return new Set(rows.map(r => r.manga_url));
}

export async function deleteDownloadRecord(db: SQLite.SQLiteDatabase, chapterUrl: string): Promise<void> {
    await db.runAsync('DELETE FROM downloaded_chapters WHERE chapter_url = ?', [chapterUrl]);
}

export async function deleteAllDownloadRecordsForManga(db: SQLite.SQLiteDatabase, mangaUrl: string): Promise<void> {
    await db.runAsync('DELETE FROM downloaded_chapters WHERE manga_url = ?', [mangaUrl]);
}

// Merge cloud records into local without nuking local-only rows.
// Was previously DELETE-then-INSERT which caused two problems:
//   (1) concurrent calls interleaved their transactions and produced duplicate rows
//   (2) any locally-added manga whose cloud push hadn't finished yet got wiped
// Now we update existing rows (matched by title) and insert new ones; locally-only manga survive.
export async function bulkRestoreLocal(db: SQLite.SQLiteDatabase, cloudRecords: any[]) {
    console.log(`[SQLITE]: Merging ${cloudRecords.length} cloud records into local`);
    // manga.manga_url is UNIQUE here, but the desktop app (and so Supabase) only
    // keeps titles unique: the same series saved under two titles shares a URL.
    // Such a row is skipped (first title wins) instead of failing the whole
    // restore, and a missing URL is stored as NULL, which UNIQUE allows any
    // number of times, instead of '' which it allows once.
    let skipped = 0;
    // Wrap the whole merge in a single transaction. Without this, each SELECT +
    // UPDATE/INSERT pays a separate fsync, which on a 500-manga restore is the
    // difference between ~8s and well under 1s. If any row fails, the whole
    // batch rolls back — better than the previous half-imported state.
    // A cloud `rating` the rating box could not have produced is a site
    // average written by an older desktop app: it goes to site_rating on the
    // site's own scale instead (services/rating.ts).
    const configs = await getLocalConfigs(db);
    const splitRating = (record: any) =>
        splitCloudRating(record.rating || '', ratingScaleFor(matchConfigToUrlStrict(configs, record.manga_url || '')?.json_rules));
    // One read of the whole table instead of two queries per record, and only
    // rows that differ are written: a pull that changes three comics costs
    // three writes instead of a thousand statements, so what the scheduled
    // check found shows up right after the app opens.
    const localRows = await db.getAllAsync<any>('SELECT * FROM manga ORDER BY id');
    const byTitle = new Map<string, any[]>();
    const urlOwner = new Map<string, any>();
    for (const r of localRows) {
        if (!byTitle.has(r.title)) byTitle.set(r.title, []);
        byTitle.get(r.title)!.push(r);
        if (r.manga_url) urlOwner.set(r.manga_url, r);
    }
    let written = 0;
    await db.withTransactionAsync(async () => {
        for (const record of cloudRecords) {
            if (!record.title) continue;
            const ratingSplit = splitRating(record);
            // Titles are not unique locally: when two rows share this title,
            // update the one that already has the cloud record's URL.
            const sameTitle = byTitle.get(record.title) || [];
            const existing: any = sameTitle.find(r => r.manga_url === (record.manga_url || '')) || sameTitle[0] || null;
            // Supabase returns linked_sources as a parsed array (jsonb), SQLite
            // wants a JSON string. Normalize at this boundary.
            const linkedJson = typeof record.linked_sources === 'string'
                ? record.linked_sources
                : JSON.stringify(record.linked_sources || []);
            const mangaUrl: string | null = record.manga_url || null;
            if (mangaUrl) {
                // Any other row, same title or not: writing this URL onto a
                // second row breaks UNIQUE and rolls the whole restore back.
                const holder = urlOwner.get(mangaUrl);
                const owner = holder && holder !== existing ? holder : null;
                if (owner) {
                    skipped++;
                    console.warn(`[SQLITE]: Skipped "${record.title}": its URL already belongs to "${owner.title}" (${mangaUrl})`);
                    continue;
                }
            }
            if (existing) {
                // A chapter check may have moved latest_chapter ahead locally before
                // the cloud saw it — keep the higher one. latest_source is local-only
                // and describes the local value, so clear it when the cloud's differs.
                const keepLocal = pickLatestChapter(existing.latest_chapter, record.latest_chapter) === 'local';
                const latestChapter = keepLocal ? existing.latest_chapter : (record.latest_chapter || '');
                const latestSource = latestChapter === existing.latest_chapter ? (existing.latest_source || '') : '';
                // latest_date travels with the chapter it describes; for the same
                // chapter a local timestamp beats a cloud value that is only a day.
                const sameAsCloud = existing.latest_chapter === (record.latest_chapter || '');
                const latestDate = (keepLocal && !sameAsCloud) || (sameAsCloud && hasTime(existing.latest_date) && !hasTime(record.latest_date))
                    ? (existing.latest_date || record.latest_date || '')
                    : (record.latest_date || '');
                const next: Record<string, any> = {
                    manga_url: mangaUrl, cover_url: record.cover_url || '',
                    chapter: record.chapter || '', last_read_date: record.last_read_date || '',
                    latest_chapter: latestChapter, latest_source: latestSource, latest_date: latestDate,
                    genre: record.genre || '', author: record.author || '',
                    description: record.description || '', rating: ratingSplit.rating,
                    alternative_names: record.alternative_names || '',
                    category: record.category || 'Reading', status: record.status || 'Unknown',
                    notes: record.notes || '', linked_sources: linkedJson,
                };
                const unchanged = Object.keys(next).every(k => (existing[k] ?? '') === (next[k] ?? ''))
                    && !!existing.favorite === !!record.favorite
                    && (ratingSplit.siteRating === null || ratingSplit.siteRating === (existing.site_rating ?? ''));
                if (unchanged) continue;
                written++;
                if (existing.manga_url && urlOwner.get(existing.manga_url) === existing) urlOwner.delete(existing.manga_url);
                if (mangaUrl) urlOwner.set(mangaUrl, existing);
                Object.assign(existing, next);
                await db.runAsync(`
                    UPDATE manga SET
                        manga_url = ?, cover_url = ?, chapter = ?, last_read_date = ?,
                        latest_chapter = ?, latest_source = ?, latest_date = ?, genre = ?, author = ?,
                        description = ?, rating = ?, site_rating = COALESCE(?, site_rating), alternative_names = ?,
                        favorite = ?, category = ?, status = ?, notes = ?,
                        linked_sources = ?
                    WHERE id = ?
                `, [
                    mangaUrl, record.cover_url || '',
                    record.chapter || '', record.last_read_date || '',
                    latestChapter, latestSource, latestDate,
                    record.genre || '', record.author || '',
                    record.description || '', ratingSplit.rating, ratingSplit.siteRating,
                    record.alternative_names || '',
                    record.favorite ? 1 : 0,
                    record.category || 'Reading',
                    record.status || 'Unknown',
                    record.notes || '',
                    linkedJson,
                    existing.id,
                ]);
            } else {
                written++;
                const added = { id: -1 - written, title: record.title, manga_url: mangaUrl };
                byTitle.set(record.title, [added]);
                if (mangaUrl) urlOwner.set(mangaUrl, added);
                await db.runAsync(`
                    INSERT INTO manga (title, manga_url, cover_url, chapter, last_read_date, latest_chapter, latest_date, genre, author, description, rating, site_rating, alternative_names, favorite, category, status, notes, linked_sources)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    record.title,
                    mangaUrl, record.cover_url || '',
                    record.chapter || '', record.last_read_date || '',
                    record.latest_chapter || '', record.latest_date || '',
                    record.genre || '', record.author || '',
                    record.description || '', ratingSplit.rating, ratingSplit.siteRating || '',
                    record.alternative_names || '',
                    record.favorite ? 1 : 0,
                    record.category || 'Reading',
                    record.status || 'Unknown',
                    record.notes || '',
                    linkedJson,
                ]);
            }
        }
    });
    console.log(`[SQLITE]: Merge complete, ${written} row(s) written${skipped ? ` (${skipped} skipped: URL shared with another title)` : ''}`);
}

export async function bulkRestoreConfigs(db: SQLite.SQLiteDatabase, configs: any[]) {
    console.log(`[SQLITE]: Bulk restoring ${configs.length} scraper configs`);
    // One transaction, so a screen reading configs mid-refresh never sees an
    // empty table, and a failed insert leaves the old set in place.
    await db.withTransactionAsync(async () => {
        await db.execAsync('DELETE FROM scraper_configs');
        for (const conf of configs) {
            await db.runAsync('INSERT INTO scraper_configs (website_name, json_rules) VALUES (?, ?)', [
                conf.website_name,
                JSON.stringify(conf.json_rules)
            ]);
        }
    });
    console.log(`[SQLITE config]: Bulk restore complete`);
}

// ── DESKTOP MASTER CONFIG TRANSPLANT ──────────────────────────────────────────
const DEFAULT_CONFIG = {
    "name": "Default",
    "theme": "madara",
    // Scale of the site's own rating (services/rating.ts): 5 stars unless a
    // site's config says 10 (Asura, Webtoons, MangaStream themes).
    "rating_scale": 5,
    "selectors": {
        "explore": { 
            "item": ".page-item-detail, .c-tabs-item__content, .bsx, .series-card", 
            "title": "h3 a, h4 a, .tt, h3", 
            "link": "h3 a, h4 a, a", 
            "image": "img", 
            "image_attr": "data-src, src", 
            "latest_chapter": ".chapter-item .chapter a, .epxs, .num-score" 
        },
        "chapters": { 
            "item": "#chapterlist li, .wp-manga-chapter, .eph-num, a[href*='/chapter/'], .listing-chapters_wrap li", 
            "link": "self", 
            "title": "self", 
            "date": ".chapterdate, .dt, .chapter-release-date i" 
        },
        "details": { 
            "title": ".post-title h1, .entry-title", 
            "author": ".author-content a", 
            "genre": ".genres-content a", 
            "desc": ".summary__content, .entry-content, .manga-excerpt, #edit_description", 
            "image": ".summary_image img, .thumb img" 
        },
        "images": { 
            "item": ".reading-content img, #readerarea img, .container-chapter-reader img", 
            "src_attr": "data-src, data-lazy-src, src" 
        }
    }
};

export async function getLocalConfigs(db: SQLite.SQLiteDatabase) {
    const rows = await db.getAllAsync('SELECT * FROM scraper_configs');
    return rows.map((r: any) => {
        const specific = JSON.parse(r.json_rules);
        // DEEP MERGE LOGIC (Mirroring Python App L115)
        const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        
        if (specific.selectors) {
            Object.keys(specific.selectors).forEach(key => {
                if (merged.selectors[key] && typeof specific.selectors[key] === 'object') {
                    merged.selectors[key] = { ...merged.selectors[key], ...specific.selectors[key] };
                } else {
                    merged.selectors[key] = specific.selectors[key];
                }
            });
        }
        
        Object.keys(specific).forEach(key => {
            if (key !== 'selectors') merged[key] = specific[key];
        });
        
        return {
            website_name: r.website_name,
            json_rules: merged
        };
    });
}

export function matchConfigToUrl(configs: any[], targetUrl: string) {
    const exact = matchConfigToUrlStrict(configs, targetUrl);
    // Fallback to configs[0] for legacy callers (scrape routing). Strict
    // callers (e.g. linked-source validation) must use matchConfigToUrlStrict.
    return exact || configs[0];
}

/**
 * Returns the config whose URLs actually contain the target hostname, or null
 * if no config matches. Unlike matchConfigToUrl, never returns configs[0] as a
 * fallback — callers who need to know "did we actually identify this site?"
 * should use this variant.
 */
export function matchConfigToUrlStrict(configs: any[], targetUrl: string): any | null {
    if (!targetUrl) return null;
    let targetDomain = '';
    try {
        targetDomain = new URL(targetUrl).hostname.replace('www.', '');
    } catch (e) {
        const match = targetUrl.match(/^(?:https?:\/\/)?(?:[^@\n]+@)?(?:www\.)?([^:\/\n?]+)/im);
        if (match) targetDomain = match[1];
    }
    if (!targetDomain) return null;

    const matched = configs.find(c => {
        const rules = c.json_rules;
        const searchUrl = rules.search_url || '';
        if (searchUrl && searchUrl.includes(targetDomain)) return true;
        if (rules.explore_categories) {
            for (const cat of rules.explore_categories) {
                if (cat.urls) {
                    for (const key in cat.urls) {
                        if (cat.urls[key].includes(targetDomain)) return true;
                    }
                }
            }
        }
        return false;
    });
    return matched || null;
}

export async function getLocalLibrary(db: SQLite.SQLiteDatabase) {
    return await db.getAllAsync('SELECT * FROM manga ORDER BY last_read_date DESC');
}

export async function updateLocalProgress(db: SQLite.SQLiteDatabase, title: string, chapter: string) {
    console.log(`[SQLITE]: Updating progress for ${title} to ${chapter}`);
    const today = new Date().toISOString().split('T')[0];
    await db.runAsync(`
        UPDATE manga 
        SET chapter = ?, last_read_date = ? 
        WHERE title = ?
    `, [chapter, today, title]);
}
