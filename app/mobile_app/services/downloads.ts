// SDK 54 moved the function-style API (downloadAsync, makeDirectoryAsync, etc.) to /legacy.
// The new File/Directory classes work too but require a larger rewrite — legacy keeps things simple.
import * as FileSystem from 'expo-file-system/legacy';
import {
    initDatabase,
    recordChapterDownload,
    getDownloadedChapter,
    deleteDownloadRecord,
    deleteAllDownloadRecordsForManga,
    getDownloadedChaptersForManga,
    DownloadedChapter,
} from './database';

const DOWNLOADS_ROOT = `${FileSystem.documentDirectory}downloads/`;

// Map any URL/title to a safe filesystem segment.
function slugify(s: string): string {
    return (s || '')
        .toLowerCase()
        .replace(/https?:\/\//, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 80);
}

function chapterDirFor(mangaUrl: string, chapterUrl: string): string {
    return `${DOWNLOADS_ROOT}${slugify(mangaUrl)}/${slugify(chapterUrl)}/`;
}

// Match Referer for hotlink-protected CDNs (mirrors the Reader)
function refererFor(url: string): string | null {
    if (url.includes('webtoons.com') || url.includes('pstatic.net')) return 'https://www.webtoons.com/';
    if (url.includes('tnlycdn.com') || url.includes('toonily.com')) return 'https://toonily.com/';
    if (url.includes('mangaclash.com') || url.includes('toonclash.com')) return 'https://mangaclash.com/';
    if (url.includes('asurascans.com') || url.includes('asuracomic.net')) return 'https://asurascans.com/';
    return null;
}

export interface DownloadProgress {
    completed: number;
    total: number;
    bytes: number;
}

export async function downloadChapter(
    mangaUrl: string,
    mangaTitle: string,
    chapterUrl: string,
    chapterTitle: string,
    imageUrls: string[],
    onProgress?: (p: DownloadProgress) => void,
    shouldCancel?: () => boolean,
): Promise<{ ok: boolean; error?: string; localDir?: string }> {
    if (!imageUrls.length) return { ok: false, error: 'No images to download' };
    const dir = chapterDirFor(mangaUrl, chapterUrl);
    try {
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    } catch (e: any) {
        // ignore "already exists"
    }

    let completed = 0;
    let totalBytes = 0;
    for (let i = 0; i < imageUrls.length; i++) {
        // Cancellation check between each image — the worker sets shouldCancel via a flag
        if (shouldCancel?.()) {
            console.log(`[DOWNLOAD]: Cancelled "${chapterTitle}" after ${completed}/${imageUrls.length} pages`);
            try { await FileSystem.deleteAsync(dir, { idempotent: true }); } catch {}
            return { ok: false, error: 'Cancelled by user' };
        }
        const url = imageUrls[i];
        const ext = url.match(/\.(jpe?g|png|webp|avif|gif)/i)?.[1] || 'jpg';
        const filename = String(i + 1).padStart(4, '0') + '.' + ext;
        const dest = dir + filename;
        try {
            const referer = refererFor(url);
            const headers: Record<string, string> = {};
            if (referer) headers['Referer'] = referer;
            const result = await FileSystem.downloadAsync(url, dest, { headers });
            if (result.status >= 200 && result.status < 400) {
                const info = await FileSystem.getInfoAsync(dest, { size: true });
                if (info.exists && (info as any).size) totalBytes += (info as any).size;
                completed++;
            } else {
                console.warn(`[DOWNLOAD]: HTTP ${result.status} for ${url}`);
            }
            if (onProgress) onProgress({ completed, total: imageUrls.length, bytes: totalBytes });
        } catch (e: any) {
            console.warn(`[DOWNLOAD]: Failed ${url}: ${e.message || e}`);
        }
    }

    if (completed === 0) {
        // Clean up empty dir
        try { await FileSystem.deleteAsync(dir, { idempotent: true }); } catch {}
        return { ok: false, error: 'Could not download any images' };
    }

    const db = await initDatabase();
    await recordChapterDownload(db, {
        manga_url: mangaUrl,
        manga_title: mangaTitle,
        chapter_url: chapterUrl,
        chapter_title: chapterTitle,
        local_dir: dir,
        image_count: completed,
        total_size_bytes: totalBytes,
        downloaded_at: new Date().toISOString(),
    });
    console.log(`[DOWNLOAD]: Saved ${completed}/${imageUrls.length} images for "${chapterTitle}" (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
    return { ok: true, localDir: dir };
}

// Returns local file:// URIs for a downloaded chapter, in page order.
export async function getLocalImageUris(chapterUrl: string): Promise<string[]> {
    const db = await initDatabase();
    const rec = await getDownloadedChapter(db, chapterUrl);
    if (!rec) return [];
    try {
        const files = await FileSystem.readDirectoryAsync(rec.local_dir);
        return files
            .filter(f => /\.(jpe?g|png|webp|avif|gif)$/i.test(f))
            .sort()
            .map(f => rec.local_dir + f);
    } catch (e) {
        console.warn('[DOWNLOAD]: readDirectory failed', e);
        return [];
    }
}

export async function deleteChapterDownload(chapterUrl: string): Promise<void> {
    const db = await initDatabase();
    const rec = await getDownloadedChapter(db, chapterUrl);
    if (rec) {
        try { await FileSystem.deleteAsync(rec.local_dir, { idempotent: true }); } catch {}
    }
    await deleteDownloadRecord(db, chapterUrl);
}

export async function deleteAllMangaDownloads(mangaUrl: string): Promise<number> {
    const db = await initDatabase();
    const records = await getDownloadedChaptersForManga(db, mangaUrl);
    for (const r of records) {
        try { await FileSystem.deleteAsync(r.local_dir, { idempotent: true }); } catch {}
    }
    await deleteAllDownloadRecordsForManga(db, mangaUrl);
    // Also remove the parent manga dir if empty
    const mangaDir = `${DOWNLOADS_ROOT}${slugify(mangaUrl)}/`;
    try { await FileSystem.deleteAsync(mangaDir, { idempotent: true }); } catch {}
    return records.length;
}

export async function isChapterDownloaded(chapterUrl: string): Promise<boolean> {
    const db = await initDatabase();
    const rec = await getDownloadedChapter(db, chapterUrl);
    return !!rec;
}

export async function getDownloadedChapterUrls(mangaUrl: string): Promise<Set<string>> {
    const db = await initDatabase();
    const records = await getDownloadedChaptersForManga(db, mangaUrl);
    return new Set(records.map(r => r.chapter_url));
}

// Aggregate: total chapters + total bytes stored locally.
export async function getDownloadsSummary(): Promise<{ chapterCount: number; totalBytes: number }> {
    const db = await initDatabase();
    const row = await db.getFirstAsync<{ cnt: number; total: number }>(
        'SELECT COUNT(*) as cnt, COALESCE(SUM(total_size_bytes), 0) as total FROM downloaded_chapters'
    );
    return { chapterCount: row?.cnt || 0, totalBytes: row?.total || 0 };
}

// Wipes every downloaded chapter from disk + the metadata table.
export async function deleteAllDownloads(): Promise<number> {
    const db = await initDatabase();
    const all = await db.getAllAsync<DownloadedChapter>('SELECT * FROM downloaded_chapters');
    for (const r of all) {
        try { await FileSystem.deleteAsync(r.local_dir, { idempotent: true }); } catch {}
    }
    await db.execAsync('DELETE FROM downloaded_chapters');
    // Also try to remove the root downloads dir if empty
    try { await FileSystem.deleteAsync(DOWNLOADS_ROOT, { idempotent: true }); } catch {}
    return all.length;
}
