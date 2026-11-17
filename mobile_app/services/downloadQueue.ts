import { downloadChapter, deleteChapterDownload } from './downloads';
import { initDatabase, getSetting, setSetting } from './database';

export interface QueueItem {
    id: string;             // === chapterUrl, used as dedupe key
    mangaUrl: string;
    mangaTitle: string;
    chapterUrl: string;
    chapterTitle: string;
    imageUrls: string[];
    status: 'pending' | 'active' | 'done' | 'failed' | 'cancelled';
    completed: number;      // images downloaded so far
    total: number;          // total images
    error?: string;
    cancelled?: boolean;    // set by cancelDownload(); worker checks between images
}

const PERSIST_KEY = 'download_queue_v1';

let queue: QueueItem[] = [];
let workerRunning = false;
const listeners: Set<() => void> = new Set();

function notify() {
    listeners.forEach(fn => { try { fn(); } catch {} });
}

// Persist only the not-yet-finished portion so the queue survives app restarts.
async function persist() {
    try {
        const db = await initDatabase();
        const remaining = queue.filter(q => q.status === 'pending' || q.status === 'active');
        // Reset 'active' back to 'pending' for persistence — the worker will re-pick it up after restart
        const sanitized = remaining.map(q => ({ ...q, status: 'pending' as const, completed: 0 }));
        await setSetting(db, PERSIST_KEY, JSON.stringify(sanitized));
    } catch (e) {
        console.warn('[QUEUE]: persist failed', e);
    }
}

async function loadPersisted() {
    try {
        const db = await initDatabase();
        const raw = await getSetting(db, PERSIST_KEY, '');
        if (!raw) return;
        const items: QueueItem[] = JSON.parse(raw);
        if (items.length > 0) {
            console.log(`[QUEUE]: Resuming ${items.length} pending downloads from previous session`);
            queue.push(...items);
            notify();
            runWorker();
        }
    } catch (e) {
        console.warn('[QUEUE]: load failed', e);
    }
}

// Auto-resume on module import (which happens at app launch via root layout)
loadPersisted();

export function getQueue(): QueueItem[] {
    return queue.slice();
}

export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** Returns true if a chapter is currently in the queue (pending or active). */
export function isInQueue(chapterUrl: string): boolean {
    return queue.some(q => q.chapterUrl === chapterUrl && (q.status === 'pending' || q.status === 'active'));
}

export function enqueue(item: Omit<QueueItem, 'id' | 'status' | 'completed' | 'total'>): boolean {
    if (isInQueue(item.chapterUrl)) return false;
    // Drop any old completed/failed entry for the same chapter
    queue = queue.filter(q => q.chapterUrl !== item.chapterUrl);
    queue.push({
        id: item.chapterUrl,
        mangaUrl: item.mangaUrl,
        mangaTitle: item.mangaTitle,
        chapterUrl: item.chapterUrl,
        chapterTitle: item.chapterTitle,
        imageUrls: item.imageUrls,
        status: 'pending',
        completed: 0,
        total: item.imageUrls.length,
    });
    notify();
    persist();
    runWorker();
    return true;
}

/** Removes a pending item OR cancels an active one (worker bails between images). */
export function dequeue(chapterUrl: string) {
    const item = queue.find(q => q.chapterUrl === chapterUrl);
    if (!item) return;
    if (item.status === 'active') {
        // Mark for cancellation; worker checks between each image and exits cleanly
        item.cancelled = true;
        notify();
        return;
    }
    queue = queue.filter(q => q.chapterUrl !== chapterUrl);
    notify();
    persist();
}

/** Cancels every pending or active item belonging to a given manga URL.
 *  Used when the user removes a comic from their library. */
export function cancelAllForManga(mangaUrl: string): number {
    let touched = 0;
    queue.forEach(q => {
        if (q.mangaUrl === mangaUrl && (q.status === 'pending' || q.status === 'active')) {
            q.cancelled = true;
            touched++;
        }
    });
    // Drop pending ones immediately; active ones bail mid-loop
    queue = queue.filter(q => !(q.cancelled && q.status === 'pending'));
    notify();
    persist();
    return touched;
}

export function clearFinished() {
    queue = queue.filter(q => q.status !== 'done' && q.status !== 'failed');
    notify();
}

async function runWorker() {
    if (workerRunning) return;
    workerRunning = true;
    try {
        while (queue.some(q => q.status === 'pending')) {
            const next = queue.find(q => q.status === 'pending');
            if (!next) break;
            // Skip items that were cancelled while waiting in the queue
            if (next.cancelled) {
                queue = queue.filter(q => q !== next);
                notify();
                continue;
            }
            next.status = 'active';
            notify();
            try {
                const result = await downloadChapter(
                    next.mangaUrl, next.mangaTitle,
                    next.chapterUrl, next.chapterTitle,
                    next.imageUrls,
                    (p) => {
                        next.completed = p.completed;
                        next.total = p.total;
                        notify();
                    },
                    () => !!next.cancelled,  // cancellation poll for the inner loop
                );
                if (next.cancelled) {
                    next.status = 'cancelled';
                } else if (result.ok) {
                    next.status = 'done';
                } else {
                    next.status = 'failed';
                    next.error = result.error;
                }
            } catch (e: any) {
                next.status = next.cancelled ? 'cancelled' : 'failed';
                next.error = e.message || String(e);
            }
            notify();
            persist();
            // Auto-clear successful or cancelled items after a moment so the banner empties out
            if (next.status === 'done' || next.status === 'cancelled') {
                const finished = next;
                setTimeout(() => {
                    queue = queue.filter(q => q !== finished);
                    notify();
                }, 1500);
            }
        }
    } finally {
        workerRunning = false;
        notify();
    }
}
