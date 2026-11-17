/**
 * Global serialized chapter scraper. Anyone (Details, the bulk-download flow, future
 * features) can call scheduleScrape(chapterUrl) and receive a Promise that resolves
 * when the chapter's image URLs have been extracted.
 *
 * The actual scraping happens in a hidden <WebView> mounted at the app root by
 * components/HiddenScrapeWebView.tsx. That WebView reads the active URL from this
 * module and reports results back via reportSuccess/reportError.
 *
 * Because the WebView lives at the root, it survives navigation between screens —
 * this is what makes "Download all" continue when the user leaves Details.
 */

type Resolver = (urls: string[]) => void;
type Rejecter = (error: string) => void;

interface ScrapeRequest {
    chapterUrl: string;
    resolve: Resolver;
    reject: Rejecter;
    timeoutId?: any;
}

const SCRAPE_TIMEOUT_MS = 40000; // 40s — slightly more than the WebView's internal sweep limit

let pending: ScrapeRequest[] = [];
let activeRequest: ScrapeRequest | null = null;
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach(fn => { try { fn(); } catch {} });
}

export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function getActiveUrl(): string | null {
    return activeRequest?.chapterUrl || null;
}

/** All URLs currently in flight or waiting (used to show per-row UI state). */
export function getQueuedUrls(): Set<string> {
    const out = new Set<string>();
    if (activeRequest) out.add(activeRequest.chapterUrl);
    pending.forEach(p => out.add(p.chapterUrl));
    return out;
}

export function getQueueDepth(): number {
    return pending.length + (activeRequest ? 1 : 0);
}

export function scheduleScrape(chapterUrl: string): Promise<string[]> {
    // Dedup: if the same URL is already pending, attach to its outcome
    const existingPending = pending.find(p => p.chapterUrl === chapterUrl);
    if (existingPending || activeRequest?.chapterUrl === chapterUrl) {
        return new Promise((resolve, reject) => {
            const wrap = { chapterUrl, resolve, reject };
            pending.push(wrap);
            notify();
        });
    }
    return new Promise<string[]>((resolve, reject) => {
        pending.push({ chapterUrl, resolve, reject });
        notify();
        processNext();
    });
}

function processNext() {
    if (activeRequest) return;
    const next = pending.shift();
    if (!next) return;
    activeRequest = next;
    activeRequest.timeoutId = setTimeout(() => {
        const req = activeRequest;
        if (!req) return;
        activeRequest = null;
        req.reject('Scrape timed out after 40s');
        notify();
        processNext();
    }, SCRAPE_TIMEOUT_MS);
    notify();
}

export function reportSuccess(urls: string[]) {
    const req = activeRequest;
    if (!req) return;
    if (req.timeoutId) clearTimeout(req.timeoutId);
    activeRequest = null;
    // Resolve this request AND any pending dups for the same URL
    req.resolve(urls);
    pending = pending.filter(p => {
        if (p.chapterUrl === req.chapterUrl) {
            p.resolve(urls);
            return false;
        }
        return true;
    });
    notify();
    processNext();
}

export function reportError(error: string) {
    const req = activeRequest;
    if (!req) return;
    if (req.timeoutId) clearTimeout(req.timeoutId);
    activeRequest = null;
    req.reject(error);
    pending = pending.filter(p => {
        if (p.chapterUrl === req.chapterUrl) {
            p.reject(error);
            return false;
        }
        return true;
    });
    notify();
    processNext();
}

/** The injected JS used by HiddenScrapeWebView — kept here so it's defined alongside the protocol. */
export const SCRAPE_JS = `
    (function() {
        let attempts = 0;
        const maxAttempts = 30;
        const seen = {};
        function send(type, data) { window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({type}, data))); }

        const interval = setInterval(() => {
            attempts++;
            // Force lazy images to load by setting src from data-src/data-lazy-src/data-original
            document.querySelectorAll('img[data-src], img[data-lazy-src], img[data-original]').forEach(img => {
                let lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
                if (lazy) lazy = lazy.trim();
                if (lazy && lazy.startsWith('http') && (!img.src || img.naturalWidth === 0)) img.src = lazy;
            });
            window.scrollBy(0, 3000);

            // Madara srcdoc iframes
            document.querySelectorAll('iframe[srcdoc]').forEach(iframe => {
                try {
                    const doc = new DOMParser().parseFromString(iframe.getAttribute('srcdoc') || '', 'text/html');
                    doc.querySelectorAll('img').forEach(img => {
                        const s = (img.getAttribute('src') || img.getAttribute('data-src') || '').trim();
                        if (s && s.startsWith('http') && !s.includes('logo') && !s.includes('avatar')) seen[s] = true;
                    });
                } catch(e) {}
            });

            const container = document.querySelector('.reading-content, #readerarea, .container-chapter-reader, .chapter-content, #_imageList');
            document.querySelectorAll('img').forEach(img => {
                const attrs = img.getAttributeNames();
                let src = '';
                for (const a of attrs) {
                    let v = img.getAttribute(a);
                    if (v) v = v.trim();
                    if (v && v.startsWith('//')) v = window.location.protocol + v;
                    if (v && v.startsWith('http') && !v.includes('logo') && !v.includes('avatar') && !v.includes('icon')) {
                        if (a.includes('src') || a.includes('lazy') || v.match(/\\.(jpg|jpeg|png|webp|avif)/i)) {
                            if (!src || a !== 'src') src = v;
                        }
                    }
                }
                if (src) {
                    const h = img.naturalHeight || 0;
                    const w = img.naturalWidth || 0;
                    // data-page-index marks legitimate chapter pages on Asura's
                    // React/Astro reader (no Madara container exists there).
                    // Host-gated so the attribute doesn't false-positive on
                    // other sites that use it for carousels or galleries.
                    const isAsuraHost = /asurascans\\.com|asuracomic\\.net/i.test(window.location.hostname);
                    const inReader = !!(container && container.contains(img))
                        || (isAsuraHost && img.hasAttribute('data-page-index'));
                    // Match Reader's filter: inside container OR tall webtoon-style (ratio >= 2.5)
                    if (inReader) {
                        seen[src] = true;
                    } else if (!isAsuraHost && h > 1 && w > 0 && h >= 2.5 * w) {
                        seen[src] = true;
                    }
                }
            });

            if (attempts >= 6 && Object.keys(seen).length > 0) {
                clearInterval(interval);
                send('DL_IMAGES', { urls: Object.keys(seen) });
            } else if (attempts >= maxAttempts) {
                clearInterval(interval);
                send('DL_IMAGES', { urls: Object.keys(seen) });
            }
        }, 1000);
    })();
    true;
`;
