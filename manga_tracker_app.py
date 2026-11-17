import os
import io
import re
import csv
import json
import copy
import time
import sqlite3
import logging
import datetime
import threading
import subprocess
import concurrent.futures
import urllib.parse

import requests
from playwright.sync_api import sync_playwright
import psutil
from PIL import Image
Image.init()
from bs4 import BeautifulSoup
from flask import Flask, jsonify, request, send_from_directory, Response
from waitress import serve
import cloud_database as cloud
import library_merge

# ── Logger ────────────────────────────────────────────────────────────────────
LOG_FILE = "perf_log.txt"
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s.%(msecs)03d  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.FileHandler(LOG_FILE, mode="w", encoding="utf-8"),
        logging.StreamHandler(),
    ]
)
log  = logging.getLogger("MangaTracker")
_proc = psutil.Process(os.getpid())

def mem_mb():
    return _proc.memory_info().rss / 1024 / 1024

class Timer:
    def __init__(self, label):
        self.label = label
    def __enter__(self):
        self.t0 = time.perf_counter()
        self.m0 = mem_mb()
        log.debug(f"[START] {self.label}  |  mem={self.m0:.1f} MB")
        return self
    def __exit__(self, *_):
        ms  = (time.perf_counter() - self.t0) * 1000
        m1  = mem_mb()
        log.info(f"[DONE]  {self.label}  |  elapsed={ms:.1f} ms  |  mem={m1:.1f} MB (Δ{m1-self.m0:+.1f})")

# ── Config ────────────────────────────────────────────────────────────────────
DB_FILE      = "local_library.db"
DEFAULT_PORT = 59021
COVERS_DIR   = "covers"
WEB_DIR      = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
HEADERS      = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache"
}

if not os.path.exists(COVERS_DIR):
    os.makedirs(COVERS_DIR)

SCRAPER_CONFIG = {}
SCRAPERS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scrapers")

def load_scrapers():
    global SCRAPER_CONFIG
    SCRAPER_CONFIG = {}
    if os.path.exists(SCRAPERS_DIR):
        for f in os.listdir(SCRAPERS_DIR):
            if f.endswith(".json"):
                fpath = os.path.join(SCRAPERS_DIR, f)
                try:
                    with open(fpath, "r", encoding="utf-8") as file:
                        SCRAPER_CONFIG[f[:-5]] = json.load(file)
                except Exception as e:
                    log.error(f"Failed to load scraper config '{f}': {e}")
    if "mangaread.org" not in SCRAPER_CONFIG:
        SCRAPER_CONFIG["mangaread.org"] = {"name": "MangaRead", "theme": "madara"}
    if "default" not in SCRAPER_CONFIG:
        SCRAPER_CONFIG["default"] = {
            "name": "Default", "theme": "madara",
            "selectors": {
                "explore": { "item": ".page-item-detail, .c-tabs-item__content, .bsx, .series-card", "title": "h3 a, h4 a, .tt, h3", "link": "h3 a, h4 a, a", "image": "img", "image_attr": "data-src, src", "rating": ".post-total-rating, .num-score, .rating, .score" },
                "chapters": { "item": "#chapterlist li, .wp-manga-chapter, .eph-num, a[href*='/chapter/']", "link": "self", "title": "self", "date": ".chapterdate, .dt" },
                "images": { "item": "img", "src_attr": "data-src, src" }
            }
        }
    log.info(f"Loaded {len(SCRAPER_CONFIG)} scraper configurations.")

load_scrapers()

def resolve_domain(name):
    if not name:
        return "mangaread.org"
    n = name.lower().replace(" ", "")
    if "mangaread" in n:
        return "mangaread.org"
    for dom, cfg in SCRAPER_CONFIG.items():
        if dom == "default": continue
        s_name = cfg.get("name", "").lower().replace(" ", "")
        if s_name == n or n in s_name or n in dom:
            return dom
    return name

def get_scraper_config(domain):
    """Deep-merges the site-specific config on top of the default config.
    This ensures a site can override only one sub-selector without wiping out
    all the other defaults."""
    merged = copy.deepcopy(SCRAPER_CONFIG.get("default", {}))
    if domain in SCRAPER_CONFIG:
        specific = SCRAPER_CONFIG[domain]
        # Deep-merge selectors: a site overriding one sub-key keeps all other defaults
        if "selectors" in specific:
            merged_sels = merged.get("selectors", {})
            for key, val in specific["selectors"].items():
                if key in merged_sels and isinstance(merged_sels[key], dict):
                    merged_sels[key] = {**merged_sels[key], **val}
                else:
                    merged_sels[key] = val
            merged["selectors"] = merged_sels
        # Shallow-merge every other top-level key
        for k, v in specific.items():
            if k != "selectors":
                merged[k] = v
    return merged

def get_domain_from_url(url):
    try:
        return urllib.parse.urlparse(url).netloc.replace("www.", "")
    except Exception as e:
        log.warning(f"get_domain_from_url failed for '{url}': {e}")
        return ""

def requires_proxy(cfg):
    """Returns True if this site's images must be routed through the backend proxy.
    Controlled by the 'requires_proxy' flag in the site's JSON config,
    or automatically True for the legacy 'mangareader' theme."""
    return cfg.get("requires_proxy", False) or cfg.get("theme") == "mangareader"

def cover_filename(title):
    cleaned = "".join(c for c in title if c.isalnum() or c in (" ", "-", "_")).strip()
    return f"{cleaned}.jpg"

def format_date(s):
    if not s or s == "nan":
        return ""
    s = str(s).strip()
    _MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    m = re.match(r'^(\d{1,2})\.(\d{1,2})\.(\d{4})$', s)
    if m:
        return f"{int(m[1]):02d} {_MONTHS[int(m[2])-1]} {m[3]}"
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', s)
    if m:
        return f"{int(m[3]):02d} {_MONTHS[int(m[2])-1]} {m[1]}"
    # "2 days ago" only means something at the moment it was scraped, so store
    # the date it refers to instead (a stored "1 hour ago" was wrong by the next day).
    rel = library_merge.relative_to_absolute(s)
    if rel:
        return rel
    return s

# ── Data Engine ───────────────────────────────────────────────────────────────
class DataEngine:
    """Manages all reads and writes to the local SQLite database.
    All public methods are thread-safe via self.lock."""

    # Maps the dict keys the rest of the app uses → SQLite column names
    _COL = {
        "English":           "title",
        "Manga URL":         "manga_url",
        "Cover URL":         "cover_url",
        "Chapter":           "chapter",
        "Date":              "last_read_date",
        "Latest Chapter":    "latest_chapter",
        "Latest Date":       "latest_date",
        "Genre":             "genre",
        "Author":            "author",
        "Description":       "description",
        "Rating":            "rating",
        "Site Rating":       "site_rating",
        "Alternative Names": "alternative_names",
        "Favorite":          "favorite",
        "Category":          "category",
        "Status":            "status",
        "Notes":             "notes",
    }

    _CREATE = """
        CREATE TABLE IF NOT EXISTS manga (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            title             TEXT NOT NULL UNIQUE,
            manga_url         TEXT DEFAULT '',
            cover_url         TEXT DEFAULT '',
            chapter           TEXT DEFAULT 'Chapter 0',
            last_read_date    TEXT DEFAULT '',
            latest_chapter    TEXT DEFAULT '',
            latest_date       TEXT DEFAULT '',
            genre             TEXT DEFAULT '',
            author            TEXT DEFAULT '',
            description       TEXT DEFAULT '',
            rating            TEXT DEFAULT '',
            alternative_names TEXT DEFAULT '',
            favorite          TEXT DEFAULT '',
            category          TEXT DEFAULT '',
            status            TEXT DEFAULT '',
            notes             TEXT DEFAULT '',
            site_rating       TEXT DEFAULT ''
        )
    """

    _CREATE_HISTORY = """
        CREATE TABLE IF NOT EXISTS reading_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            manga_title TEXT NOT NULL,
            chapter     TEXT,
            date        TEXT NOT NULL,
            UNIQUE(manga_title, chapter, date)
        )
    """

    def __init__(self, db_path):
        self.db_path = db_path
        self.lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute(self._CREATE)
        # Key-value store for local app settings (pending_username, etc.)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            )
        """)
        self._conn.execute(self._CREATE_HISTORY)
        try:
            self._conn.execute("ALTER TABLE manga ADD COLUMN notes TEXT DEFAULT ''")
        except sqlite3.OperationalError:
            pass # duplicate column
        # The site's own average on the 5-point scale (library_merge.py). Local
        # only; `rating` is the reader's own and is what syncs.
        try:
            self._conn.execute("ALTER TABLE manga ADD COLUMN site_rating TEXT DEFAULT ''")
        except sqlite3.OperationalError:
            pass # duplicate column
        self._conn.commit()
        self._migrate_rating_split()
        count = self._conn.execute("SELECT COUNT(*) FROM manga").fetchone()[0]
        log.info(f"DataEngine connected to '{db_path}' ({count} entries).")

    def _migrate_rating_split(self):
        """One-time split of the old `rating` column (library_merge.migrate_legacy_rating):
        site averages this app scraped move to site_rating on the site's scale,
        whole-number picks from the phone's old 1–10 picker are halved."""
        if self._conn.execute("SELECT value FROM settings WHERE key = 'rating_split_v2'").fetchone():
            return
        rows = self._conn.execute(
            "SELECT title, manga_url, rating FROM manga WHERE rating IS NOT NULL AND rating != ''"
        ).fetchall()
        changed = 0
        for row in rows:
            scale = library_merge.rating_scale_for(get_scraper_config(get_domain_from_url(row["manga_url"] or "")))
            rating, site_rating = library_merge.migrate_legacy_rating(row["rating"], scale)
            if rating == (row["rating"] or "") and site_rating is None:
                continue
            self._conn.execute(
                "UPDATE manga SET rating = ?, site_rating = COALESCE(?, site_rating) WHERE title = ?",
                (rating, site_rating, row["title"]),
            )
            changed += 1
        self._conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('rating_split_v2', '1')")
        self._conn.commit()
        if rows:
            log.info(f"Rating split: {len(rows)} rated title(s) checked, {changed} changed.")

    def _to_dict(self, row):
        """Convert a sqlite3.Row into the dict format the rest of the app expects."""
        try:
            n = row["notes"]
        except IndexError:
            n = ""

        return {
            "English":           row["title"],
            "Manga URL":         row["manga_url"],
            "Cover URL":         row["cover_url"],
            "Chapter":           row["chapter"],
            "Date":              row["last_read_date"],
            "Latest Chapter":    row["latest_chapter"],
            "Latest Date":       row["latest_date"],
            "Genre":             row["genre"],
            "Author":            row["author"],
            "Description":       row["description"],
            "Rating":            row["rating"],
            "Site Rating":       row["site_rating"],
            "Alternative Names": row["alternative_names"],
            "Favorite":          row["favorite"],
            "Category":          row["category"],
            "Status":            row["status"],
            "Notes":             n,
        }

    def get_all(self):
        with self.lock:
            rows = self._conn.execute("SELECT * FROM manga ORDER BY id").fetchall()
        return [self._to_dict(r) for r in rows]

    def search(self, q=""):
        if not q:
            return self.get_all()
        with self.lock:
            rows = self._conn.execute(
                "SELECT * FROM manga WHERE title LIKE ? ORDER BY id",
                (f"%{q}%",)
            ).fetchall()
        return [self._to_dict(r) for r in rows]

    def title_exists(self, title):
        """Returns True if a title (case-insensitive, trimmed) already exists."""
        with self.lock:
            row = self._conn.execute(
                "SELECT 1 FROM manga WHERE LOWER(TRIM(title)) = LOWER(TRIM(?))",
                (title,)
            ).fetchone()
        return row is not None

    def update_chapter(self, title, ch):
        try:
            dt = datetime.datetime.now().strftime("%d.%m.%Y")
            with self.lock:
                self._conn.execute(
                    "UPDATE manga SET chapter=?, last_read_date=? WHERE title=?",
                    (f"Chapter {ch}", dt, title)
                )
                self._conn.execute(
                    "INSERT INTO reading_history (manga_title, chapter, date) VALUES (?, ?, ?)",
                    (title, str(ch), datetime.datetime.now().strftime("%Y-%m-%d"))
                )
                self._conn.commit()
            return True
        except Exception as e:
            log.error(f"update_chapter failed for '{title}': {e}")
            return False

    def toggle_favorite(self, title, fav):
        try:
            val = "Yes" if fav else ""
            with self.lock:
                self._conn.execute(
                    "UPDATE manga SET favorite=? WHERE title=?",
                    (val, title)
                )
                self._conn.commit()
            return True
        except Exception as e:
            log.error(f"toggle_favorite failed for '{title}': {e}")
            return False

    def add_record(self, meta):
        t = meta.get("Title")
        if not t:
            return False
        try:
            with self.lock:
                self._conn.execute("""
                    INSERT INTO manga (
                        title, manga_url, cover_url, chapter, last_read_date,
                        latest_chapter, latest_date, genre, author, description,
                        rating, alternative_names, favorite, category, status, site_rating
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    t,
                    meta.get("Manga URL", ""),
                    meta.get("ImageURL", ""),
                    "Chapter 0",
                    datetime.datetime.now().strftime("%d.%m.%Y"),
                    meta.get("Latest Chapter", ""),
                    meta.get("Latest Date", ""),
                    meta.get("Genre", ""),
                    meta.get("Author", ""),
                    meta.get("Description", ""),
                    meta.get("Rating", ""),
                    meta.get("Alternative Names", ""),
                    "",
                    meta.get("Category", ""),
                    meta.get("Status", ""),
                    meta.get("Site Rating", ""),
                ))
                self._conn.commit()
            return True
        except sqlite3.IntegrityError:
            log.warning(f"add_record: '{t}' already exists in database.")
            return False
        except Exception as e:
            log.error(f"add_record failed for '{t}': {e}")
            return False

    def delete_record(self, t):
        try:
            with self.lock:
                cur = self._conn.execute("DELETE FROM manga WHERE title=?", (t,))
                self._conn.commit()
                deleted = cur.rowcount   # read inside lock before it can be invalidated
            if deleted == 0:
                log.warning(f"delete_record: '{t}' not found in database.")
                return False
            fn = cover_filename(t)
            loc = os.path.join(COVERS_DIR, fn)
            if os.path.exists(loc):
                os.remove(loc)
            return True
        except Exception as e:
            log.error(f"delete_record failed for '{t}': {e}")
            return False

    def update_records_batch(self, ups):
        """Batch-update metadata fields. Only overwrites a field if the new value
        is non-empty (so we never blank-out data with an empty string)."""
        if not ups:
            return
        try:
            with self.lock:
                for t, meta in ups:
                    self._conn.execute("""
                        UPDATE manga SET
                            author            = COALESCE(NULLIF(?, ''), author),
                            genre             = COALESCE(NULLIF(?, ''), genre),
                            description       = COALESCE(NULLIF(?, ''), description),
                            latest_chapter    = COALESCE(NULLIF(?, ''), latest_chapter),
                            latest_date       = COALESCE(NULLIF(?, ''), latest_date),
                            cover_url         = COALESCE(NULLIF(?, ''), cover_url),
                            manga_url         = COALESCE(NULLIF(?, ''), manga_url),
                            site_rating       = COALESCE(NULLIF(?, ''), site_rating),
                            category          = COALESCE(NULLIF(?, ''), category),
                            status            = COALESCE(NULLIF(?, ''), status)
                        WHERE title = ?
                    """, (
                        meta.get("Author", ""),
                        meta.get("Genre", ""),
                        meta.get("Description", ""),
                        meta.get("Latest Chapter", ""),
                        meta.get("Latest Date", ""),
                        meta.get("ImageURL", ""),
                        meta.get("Manga URL", ""),
                        meta.get("Site Rating", ""),
                        meta.get("Category", ""),
                        meta.get("Status", ""),
                        t
                    ))
                self._conn.commit()
        except Exception as e:
            log.error(f"update_records_batch failed: {e}")

    def apply_cloud_changes(self, changes_by_title: dict) -> int:
        """Write merge results ({title: {app_key: value}}) to the local DB.
        Keys are the app's dict keys; only those in _COL are written."""
        updated = 0
        try:
            with self.lock:
                for title, changes in changes_by_title.items():
                    cols = [(self._COL[k], v) for k, v in changes.items() if k in self._COL]
                    if not cols:
                        continue
                    sets = ", ".join(f"{c} = ?" for c, _ in cols)
                    self._conn.execute(
                        f"UPDATE manga SET {sets} WHERE title = ?",
                        [v for _, v in cols] + [title],
                    )
                    updated += 1
                self._conn.commit()
        except Exception as e:
            log.error(f"apply_cloud_changes failed: {e}")
        return updated

    def bulk_restore(self, records: list) -> int:
        """Insert records downloaded from cloud into local DB.
        Uses INSERT OR IGNORE so existing local records are never overwritten."""
        if not records:
            return 0
        try:
            rows = [
                (
                    r.get("English", ""),
                    r.get("Manga URL", ""),
                    r.get("Cover URL", ""),
                    r.get("Chapter", "Chapter 0"),
                    r.get("Date", ""),
                    r.get("Latest Chapter", ""),
                    r.get("Latest Date", ""),
                    r.get("Genre", ""),
                    r.get("Author", ""),
                    r.get("Description", ""),
                    r.get("Rating", ""),
                    r.get("Alternative Names", ""),
                    r.get("Favorite", ""),
                    r.get("Category", ""),
                    r.get("Status", ""),
                    r.get("Notes", ""),
                )
                for r in records if str(r.get("English", "")).strip()
            ]
            with self.lock:
                self._conn.executemany("""
                    INSERT OR IGNORE INTO manga (
                        title, manga_url, cover_url, chapter, last_read_date,
                        latest_chapter, latest_date, genre, author, description,
                        rating, alternative_names, favorite, category, status, notes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, rows)
                self._conn.commit()
            log.info(f"bulk_restore: inserted {len(rows)} records from cloud.")
            return len(rows)
        except Exception as e:
            log.error(f"bulk_restore failed: {e}")
            return 0

    def update_note(self, title, note):
        try:
            with self.lock:
                self._conn.execute("UPDATE manga SET notes=? WHERE title=?", (note, title))
                self._conn.commit()
            return True
        except Exception as e:
            log.error(f"update_note failed for '{title}': {e}")
            return False

    def get_reading_history_counts(self):
        try:
            with self.lock:
                rows = self._conn.execute("SELECT date, count(DISTINCT manga_title) as count FROM reading_history GROUP BY date").fetchall()
                return [{"date": r["date"], "count": r["count"]} for r in rows]
        except Exception as e:
            log.error(f"get_reading_history_counts failed: {e}")
            return []

    def get_raw_reading_history(self):
        try:
            with self.lock:
                rows = self._conn.execute("SELECT manga_title, chapter, date FROM reading_history").fetchall()
                return [{"manga_title": r["manga_title"], "chapter": r["chapter"], "date": r["date"]} for r in rows]
        except Exception as e:
            log.error(f"get_raw_reading_history failed: {e}")
            return []

    def bulk_restore_history(self, records: list):
        if not records:
            return 0
        try:
            rows = [(r.get("manga_title"), r.get("chapter"), r.get("date")) for r in records if r.get("manga_title")]
            with self.lock:
                self._conn.executemany("INSERT OR IGNORE INTO reading_history (manga_title, chapter, date) VALUES (?, ?, ?)", rows)
                self._conn.commit()
            return len(rows)
        except Exception as e:
            log.error(f"bulk_restore_history failed: {e}")
            return 0

    def save_setting(self, key: str, value: str) -> None:

        """Persist a key-value setting to local DB."""
        with self.lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (key, value)
            )
            self._conn.commit()

    def get_setting(self, key: str, default: str = "") -> str:
        """Read a setting from local DB."""
        with self.lock:
            row = self._conn.execute(
                "SELECT value FROM settings WHERE key = ?", (key,)
            ).fetchone()
        return row["value"] if row else default

    def delete_setting(self, key: str) -> None:
        """Remove a setting from local DB."""
        with self.lock:
            self._conn.execute("DELETE FROM settings WHERE key = ?", (key,))
            self._conn.commit()


    def count(self) -> int:
        """Return the number of manga in local DB."""
        with self.lock:
            return self._conn.execute("SELECT COUNT(*) FROM manga").fetchone()[0]

# ── Scraper Logic ─────────────────────────────────────────────────────────────
class MockResponse:
    def __init__(self, content, status_code, url, cookies=None):
        self.text = content
        self.content = content.encode('utf-8')
        self.status_code = status_code
        self.url = url
        self.headers = {'Content-Type': 'text/html; charset=utf-8'}
        self.cookies = cookies or {}

def _playwright_fetch(url, headers, cookies, method, data):
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent=headers.get("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36") if headers else "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
            )
            if cookies:
                dom = urllib.parse.urlparse(url).netloc
                pw_cookies = [{"name": str(k), "value": str(v), "domain": dom, "path": "/"} for k, v in cookies.items()]
                context.add_cookies(pw_cookies)
            page = context.new_page()

            # Block heavy resources to speed up loads drastically
            page.route("**/*.{png,jpg,jpeg,webp,gif,svg,css,woff2,mp4,webm,avif}", lambda route: route.abort())

            nav_url = url if method == "GET" else f"https://{urllib.parse.urlparse(url).netloc}/"
            try:
                page.goto(nav_url, wait_until="domcontentloaded", timeout=15000)
            except Exception as e:
                log.warning(f"Playwright goto timed out: {e}. Will attempt to use parsed DOM anyway.")

            title = page.title()
            if "Just a moment" in title or "Cloudflare" in title or "Attention Required" in title:
                log.info("Cloudflare challenge detected in Playwright, waiting...")
                try:
                    page.wait_for_selector(".page-item-detail, .post-title, .wp-manga-chapter, body", timeout=15000)
                except Exception as e:
                    log.warning(f"Playwright selector wait timed out: {e}")
                    page.wait_for_timeout(5000)

            if method == "GET":
                html = page.content()
            else:
                js = f"""
                (data) => fetch('{url}', {{
                    method: 'POST',
                    headers: {{ 'Content-Type': 'application/x-www-form-urlencoded' }},
                    body: new URLSearchParams(data).toString()
                }}).then(r => r.text())
                """
                html = page.evaluate(js, data)

            extracted_cookies = {c['name']: c['value'] for c in context.cookies()}
            browser.close()
            return MockResponse(html, 200, url, extracted_cookies)
    except Exception as e:
        log.error(f"Playwright fallback failed for '{url}': {e}")
        return None

def robust_get(url, headers=None, timeout=10, cookies=None, method="GET", data=None):
    if method == "GET":
        r = requests.get(url, headers=headers, timeout=timeout, cookies=cookies)
    else:
        r = requests.post(url, headers=headers, data=data, timeout=timeout, cookies=cookies)

    if r.status_code in [403, 503]:
        log.warning(f"Got {r.status_code} for {url}, falling back to Playwright...")
        pw_res = _playwright_fetch(url, headers, cookies, method, data)
        if pw_res:
            return pw_res
    return r

def safe_select(soup, sels, attr=None, first=True):
    if not sels:
        return "" if first else []
    for sel in [s.strip() for s in sels.split(",")]:
        try:
            if sel == "self":
                if first:
                    return soup.get(attr) if attr else soup.text.strip()
                else:
                    return [soup]
            if first:
                el = soup.select_one(sel)
                if el:
                    return el.get(attr) if attr else el.text.strip()
            else:
                els = soup.select(sel)
                if els:
                    return els
        except Exception as e:
            log.debug(f"safe_select: selector '{sel}' failed: {e}")
    return "" if first else []


def get_online_search_results(query, site="MangaRead"):
    dom = resolve_domain(site)
    cfg = get_scraper_config(dom)
    url = cfg.get("search_url", "https://{domain}/?s={query}&post_type=wp-manga").format(domain=dom, query=urllib.parse.quote(query))
    sels = cfg.get("selectors", {}).get("search", cfg.get("selectors", {}).get("explore", {}))
    out = []
    h = HEADERS.copy()
    h["Referer"] = f"https://{dom}/"
    try:
        r = robust_get(url, headers=h, timeout=10, cookies={"isAdult": "1"})
        soup = BeautifulSoup(r.text, "html.parser")
        hits = safe_select(soup, sels.get("item"), first=False)
        for hit in (hits or [])[:15]:
            t = safe_select(hit, sels.get("title"))
            if not t:
                continue
            link = safe_select(hit, sels.get("link"), attr="href")
            if link and not link.startswith("http"):
                link = urllib.parse.urljoin(url, link)
            img_el = hit.select_one(sels.get("image"))
            cv = ""
            if img_el:
                for a in [at.strip() for at in sels.get("image_attr", "data-src, src").split(",")]:
                    cv = img_el.get(a, "")
                    if cv:
                        break
                if cv and not cv.startswith("http"):
                    cv = urllib.parse.urljoin(url, cv)
                if cv and requires_proxy(cfg):
                    cv = f"/api/proxy_image?url={urllib.parse.quote(cv)}"
            out.append({"title": t, "mangaUrl": link, "coverUrl": cv, "rating": safe_select(hit, sels.get("rating")), "latestCh": safe_select(hit, sels.get("latest_chapter")), "isOnlineOnly": True, "site": site})
    except Exception as e:
        log.error(f"get_online_search_results failed for query='{query}' site='{site}': {e}")
    return out

def fetch_manga_details(url):
    dom = get_domain_from_url(url)
    cfg = get_scraper_config(dom)
    sels = cfg.get("selectors", {}).get("details", {})
    h = HEADERS.copy()
    h["Referer"] = f"https://{dom}/"
    try:
        r = robust_get(url, headers=h, timeout=10, cookies={"isAdult": "1"})
        soup = BeautifulSoup(r.text, "html.parser")
        t = safe_select(soup, sels.get("title")) or safe_select(soup, "title").replace("HOT", "").strip()
        cv = safe_select(soup, sels.get("image"), attr="src") or safe_select(soup, sels.get("image"), attr="data-src")
        ib = None
        if cv:
            try:
                ir = requests.get(cv, headers=h, timeout=10)
                if ir.status_code == 200:
                    ib = io.BytesIO(ir.content)
            except Exception as e:
                log.warning(f"fetch_manga_details: failed to download cover image from '{cv}': {e}")
        out = {
            "Title": t, "Author": safe_select(soup, sels.get("author")),
            "Genre": ", ".join([a.text.strip() for a in safe_select(soup, sels.get("genre"), first=False)]),
            "Description": safe_select(soup, sels.get("desc")), "Latest Chapter": safe_select(soup, sels.get("latest_chapter")),
            "Latest Date": format_date(safe_select(soup, sels.get("latest_date"))), "ImageURL": cv,
            "ImageBytes": ib, "Manga URL": url,
            # The site's average on its own scale → 5-point "Site Rating"; the
            # reader's "Rating" is never read from a page.
            "Site Rating": library_merge.normalize_site_rating(
                safe_select(soup, sels.get("rating"), attr=sels.get("rating_attr")),
                library_merge.rating_scale_for(cfg)),
        }
        metas = safe_select(soup, sels.get("meta_container"), first=False)
        for b in (metas or []):
            head = safe_select(b, sels.get("meta_key"))
            val = safe_select(b, sels.get("meta_val"))
            if head:
                if "Alternative" in head: out["Alternative Names"] = val
                elif "Type" in head: out["Category"] = val
                elif "Status" in head: out["Status"] = val
        return out
    except Exception as e:
        log.error(f"fetch_manga_details failed for '{url}': {e}")
        return None

def scrape_chapters(url):
    dom = get_domain_from_url(url)
    cfg = get_scraper_config(dom)
    theme = cfg.get("theme", "madara").lower()
    sels = cfg.get("selectors", {}).get("chapters", {})
    h = HEADERS.copy()
    h["Referer"] = f"https://{dom}/"
    try:
        if theme == "madara":
            ajax_url = url.rstrip('/') + "/ajax/chapters/"
            r = robust_get(ajax_url, headers=h, timeout=10, method="POST")
            if r.status_code != 200:
                pr = robust_get(url, headers=h, timeout=10)
                # Check if chapters are already in the HTML
                soup_pr = BeautifulSoup(pr.text, "html.parser")
                chaps_in_pr = safe_select(soup_pr, sels.get("item"), first=False)

                if chaps_in_pr:
                    r = pr
                else:
                    m = re.search(r'data-id="(\d+)"|post-(\d+)|post_id\s*:\s*(\d+)', pr.text)
                    m_id = next((g for g in m.groups() if g), None) if m else None
                    if m_id:
                        req_cookies = getattr(pr, 'cookies', {}).copy()
                        req_cookies["isAdult"] = "1"
                        r = robust_get(f"https://{dom}/wp-admin/admin-ajax.php", headers=h, data={"action": "manga_get_chapters", "manga": m_id}, timeout=10, cookies=req_cookies, method="POST")
                    else:
                        r = pr
        elif cfg.get("force_playwright"):
            # Force Playwright (e.g. to see "Early Access" labels for filtering or bypass heavy JS walls)
            log.info(f"Forcing Playwright via config for '{url}'...")
            pw_res = _playwright_fetch(url, h, {"isAdult": "1"}, "GET", None)
            if pw_res:
                r = pw_res
            else:
                r = robust_get(url, headers=h, timeout=10, cookies={"isAdult": "1"})
        else:
            r = robust_get(url, headers=h, timeout=10, cookies={"isAdult": "1"})

        soup = BeautifulSoup(r.text, "html.parser")
        chaps = safe_select(soup, sels.get("item"), first=False)
        out = []
        for c in (chaps or []):
            if "Early Access" in c.text:
                continue
            ls = sels.get("link", "a")
            link = c.get("href") if ls == "self" else safe_select(c, ls, attr="href")
            if link:
                if not link.startswith("http"):
                    link = urllib.parse.urljoin(url, link)
                ts = sels.get("title", "a")
                t = c.text.strip() if ts == "self" else safe_select(c, ts)
                if "{{" in t or "}}" in t or "number" in t.lower():
                    continue
                t = t.split('\n')[0].strip()
                if t:
                    out.append({"name": t, "url": link, "date": safe_select(c, sels.get("date"))})
        return out
    except Exception as e:
        log.error(f"scrape_chapters failed for '{url}': {e}")
        return []

def scrape_chapter_images(url):
    dom = get_domain_from_url(url)
    cfg = get_scraper_config(dom)
    sels = cfg.get("selectors", {}).get("images", {})
    h = HEADERS.copy()
    h["Referer"] = f"https://{dom}/"

    if "asurascans" in dom:
        try:
            api_url = url.replace("asurascans.com/comics/", "api.asurascans.com/api/series/").replace("/chapter/", "/chapters/")
            api_url = api_url.replace("asurascans.com/series/", "api.asurascans.com/api/series/")
            r = requests.get(api_url, headers=h, timeout=10)
            if r.status_code == 200:
                data = r.json()
                if "data" in data and "chapter" in data["data"] and "pages" in data["data"]["chapter"]:
                    return [f"/api/proxy_image?url={urllib.parse.quote(p['url'])}" for p in data["data"]["chapter"]["pages"]]
                elif "data" in data and "pages" in data["data"]:
                    return [f"/api/proxy_image?url={urllib.parse.quote(p['url'])}" for p in data["data"]["pages"]]
        except Exception as e:
            log.warning(f"AsuraScans API image fetch failed for '{url}': {e}")

    try:
        r = robust_get(url, headers=h, timeout=10, cookies={"isAdult": "1"})
        soup = BeautifulSoup(r.text, "html.parser")
        imgs = safe_select(soup, sels.get("item"), first=False)
        if not imgs:
            imgs = [i for i in soup.find_all("img") if i.get("src") and ("chapter" in i.get("src") or "uploads" in i.get("src") or "asura-images" in i.get("src"))]

        out = []
        for i in (imgs or []):
            for a in [at.strip() for at in sels.get("src_attr", "data-src, src").split(",")]:
                src = i.get(a)
                if src:
                    src = src.strip()
                    if src.startswith("//"):
                        src = "https:" + src
                    elif not src.startswith("http"):
                        src = urllib.parse.urljoin(url, src)
                    if requires_proxy(cfg):
                        src = f"/api/proxy_image?url={urllib.parse.quote(src)}"
                    out.append(src)
                    break
        return out
    except Exception as e:
        log.error(f"scrape_chapter_images failed for '{url}': {e}")
        return []

def scrape_explore(site="MangaRead", cat="manhwa", pg=1, order="new-manga", stat="all"):
    out = []
    ut = None

    dom = resolve_domain(site)
    cfg = get_scraper_config(dom)

    # Try to find URL from explore_categories in JSON
    categories = cfg.get("explore_categories", [])
    col = {"new-manga": "Newest", "latest": "Latest", "trending": "Popular", "popular": "Popular", "rating": "Rating", "alphabet": "A-Z"}.get(order, "Newest")

    for c in categories:
        c_type = str(c.get("type", "")).lower()
        if cat.lower() in c_type or c_type == "all combined" or cat.lower() == "all":
            ut = c.get("urls", {}).get(col)
            if ut: break

    sels = cfg.get("selectors", {}).get("explore", {})
    if not ut:
        base = f"https://{dom}/manga" if cat == "all" else f"https://{dom}/genres/{cat}"
        ut = f"{base}/?m_orderby={order}"

    h = HEADERS.copy()
    h["Referer"] = f"https://{dom}/"
    for spg in range(pg, pg + 1):
        try:
            u = urllib.parse.urlparse(ut)
            q = dict(urllib.parse.parse_qsl(u.query))
            if spg > 1:
                q["page"] = spg
            furl = urllib.parse.urlunparse((u.scheme, u.netloc, u.path, u.params, urllib.parse.urlencode(q), u.fragment))
            r = robust_get(furl, headers=h, timeout=12, cookies={"isAdult": "1"})
            if r.status_code != 200:
                break
            soup = BeautifulSoup(r.text, "html.parser")
            items = safe_select(soup, sels.get("item"), first=False)
            if not items:
                break
            for it in items:
                t = safe_select(it, sels.get("title"))
                if not t:
                    continue
                link = safe_select(it, sels.get("link"), attr="href")
                if link and not link.startswith("http"):
                    link = urllib.parse.urljoin(furl, link)
                cv = ""
                img_el = it.select_one(sels.get("image"))
                if img_el:
                    for a in [at.strip() for at in sels.get("image_attr", "data-src, src").split(",")]:
                        cv = img_el.get(a, "")
                        if cv:
                            break
                    if cv and not cv.startswith("http"):
                        cv = urllib.parse.urljoin(furl, cv)
                    if cv and requires_proxy(cfg):
                        cv = f"/api/proxy_image?url={urllib.parse.quote(cv)}"

                # Robust rating extraction
                rat = safe_select(it, sels.get("rating"))
                if not rat:
                    # Fallback to common classes if not in sels
                    rat = safe_select(it, ".post-total-rating, .num-score, .rating, .score, .num-rating")

                out.append({"title": t, "mangaUrl": link, "coverUrl": cv, "rating": rat, "latestCh": safe_select(it, sels.get("latest_chapter")), "date": safe_select(it, sels.get("date")), "isOnlineOnly": True, "site": dom})
        except Exception as e:
            log.error(f"scrape_explore page {spg} failed for site='{site}': {e}")
            break
    return out

# ── App Init ──────────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder=WEB_DIR)
engine = DataEngine(DB_FILE)
_port = 0

class LibraryRefresher:
    def __init__(self):
        self.running = False
        self.current = 0
        self.total = 0
        self.status = "Idle"
        self._lock = threading.Lock()

    def run(self):
        with self._lock:
            if self.running: return
            self.running = True
        try:
            recs = engine.get_all()
            self.total = len(recs)
            self.current = 0
            batch = []
            # max_workers=3 to avoid hammering sites; refresh_item also adds a 0.1s courtesy delay
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
                futures = {ex.submit(self.refresh_item, r): r for r in recs}
                for f in concurrent.futures.as_completed(futures):
                    self.current += 1
                    res = f.result()
                    if res:
                        batch.append((res["title"], res["details"]))
                        self.status = f"Updated: {res['title']}"
                        if len(batch) >= 10:
                            engine.update_records_batch(batch)
                            batch = []
            if batch:
                engine.update_records_batch(batch)
            self.status = "Completed"
        except Exception as e:
            log.error(f"LibraryRefresher.run failed: {e}")
            self.status = "Error"
        finally:
            time.sleep(2)
            self.running = False

    def refresh_item(self, r):
        # Courtesy delay so we don't accidentally DDOS sites during a bulk refresh
        time.sleep(0.1)
        t = r.get("English")
        u = r.get("Manga URL")
        # Skip entries with no URL — we have no way to refresh them
        if not u:
            log.debug(f"refresh_item: skipping '{t}' — no Manga URL stored.")
            return None
        det = fetch_manga_details(u)
        if not det:
            return None
        fn = cover_filename(t)
        loc = os.path.join(COVERS_DIR, fn)
        if not os.path.exists(loc) and det.get("ImageBytes"):
            try:
                img = Image.open(det["ImageBytes"])
                if img.mode != "RGB":
                    img = img.convert("RGB")
                img.save(loc)
            except Exception as e:
                log.warning(f"refresh_item: failed to save cover for '{t}': {e}")
        return {"title": t, "details": det}

refresher = LibraryRefresher()
img_exec = concurrent.futures.ThreadPoolExecutor(max_workers=8)

def ensure_cover(t, u):
    if not u or u in ("", "nan"):
        return ""
    fn = cover_filename(t)
    loc = os.path.join(COVERS_DIR, fn)
    if os.path.exists(loc):
        return fn
    try:
        dom = get_domain_from_url(u)
        h = HEADERS.copy()
        h["Referer"] = f"https://{dom}/"
        res = requests.get(u, headers=h, timeout=8, cookies={"isAdult": "1"})
        if res.status_code == 200:
            img = Image.open(io.BytesIO(res.content))
            if img.mode != "RGB":
                img = img.convert("RGB")
            img.save(loc)
            return fn
    except Exception as e:
        log.warning(f"ensure_cover failed for '{t}' (url={u}): {e}")
    return ""

# ── API Routes ────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")

@app.route("/<path:f>")
def static_web(f):
    full = os.path.join(WEB_DIR, f)
    if os.path.exists(full):
        return send_from_directory(WEB_DIR, f)
    return "Not found", 404

@app.route("/covers/<path:f>")
def cover_file(f):
    return send_from_directory(COVERS_DIR, f)

ALLOWED_PROXY_DOMAINS = None

def _get_allowed_domains():
    global ALLOWED_PROXY_DOMAINS
    if ALLOWED_PROXY_DOMAINS is None:
        ALLOWED_PROXY_DOMAINS = {d for d in SCRAPER_CONFIG if d != "default"}
    return ALLOWED_PROXY_DOMAINS

@app.route("/api/proxy_image")
def api_proxy_image():
    url = request.args.get("url")
    if not url:
        return "No URL", 400
    try:
        if not url.startswith("http"):
            return "Invalid URL", 400
            
        dom = get_domain_from_url(url)
        allowed = _get_allowed_domains()
        # Allow exact domains or subdomains of allowed domains
        if not any(dom == d or dom.endswith("." + d) for d in allowed):
            log.warning(f"SSRF attempt? Blocked proxy request to unauthorized domain: {dom}")
            return "Domain not allowed", 403

        h = HEADERS.copy()
        h["Referer"] = f"https://{dom}/"
        res = requests.get(url, headers=h, timeout=15, cookies={"isAdult": "1"})
        if res.status_code != 200:
            return f"Error {res.status_code}", res.status_code
        return Response(res.content, content_type=res.headers.get("Content-Type", "image/jpeg"))
    except Exception as e:
        log.error(f"api_proxy_image failed for '{url}': {e}")
        return "Failed", 500

@app.route("/api/comics")
def api_comics():
    q = request.args.get("q", "")
    recs = engine.search(q) if q else engine.get_all()
    out = []
    for r in recs:
        t = str(r.get("English", "")).strip()
        if not t or t == "nan":
            continue
        fn = cover_filename(t)
        loc = os.path.join(COVERS_DIR, fn)
        if os.path.exists(loc):
            curl = f"http://127.0.0.1:{_port}/covers/{urllib.parse.quote(fn)}"
        else:
            curl = str(r.get("Cover URL", "")) or str(r.get("Image", ""))
            if curl and curl != "nan":
                img_exec.submit(ensure_cover, t, curl)
        out.append({
            "title": t, "chapter": str(r.get("Chapter", "")), "date": format_date(r.get("Date", "")),
            "latestCh": str(r.get("Latest Chapter", "")), "latestDate": format_date(r.get("Latest Date", "")),
            # Unformatted value for sorting: keeps the time of a timestamp
            # ("2026-10-26T13:05Z"), which the display format drops.
            "latestDateRaw": str(r.get("Latest Date", "") or ""),
            "genre": str(r.get("Genre", "")), "author": str(r.get("Author", "")), "description": str(r.get("Description", "")),
            "mangaUrl": str(r.get("Manga URL", "")), "rating": str(r.get("Rating", "")), "siteRating": str(r.get("Site Rating", "") or ""), "altNames": str(r.get("Alternative Names", "")),
            "category": str(r.get("Category", "")), "status": str(r.get("Status", "")), "favorite": str(r.get("Favorite", "")).lower() == "yes",
            "coverUrl": curl
        })
    return jsonify(out)

@app.route("/api/update_chapter", methods=["POST"])
def api_up_ch():
    d = request.json
    return jsonify({"ok": engine.update_chapter(d["title"], d["chapter"])})

@app.route("/api/toggle_favorite", methods=["POST"])
def api_fav():
    d = request.json
    return jsonify({"ok": engine.toggle_favorite(d["title"], d["favorite"])})

@app.route("/api/refresh", methods=["POST"])
def api_ref():
    if not refresher.running:
        threading.Thread(target=refresher.run, daemon=True).start()
        return jsonify({"ok": True})
    return jsonify({"ok": False}), 400

@app.route("/api/refresh/status")
def api_ref_stat():
    return jsonify({"running": refresher.running, "current": refresher.current, "total": refresher.total, "status": refresher.status})

@app.route("/api/sites")
def api_sites():
    res = {}
    for dom, cfg in SCRAPER_CONFIG.items():
        if dom == "default": continue
        s_name = cfg.get("name", dom)
        cats = cfg.get("explore_categories", [])

        types = set()
        orders = set()
        for c in cats:
            types.add(str(c.get("type", "")).lower())
            for o in c.get("urls", {}).keys():
                orders.add(o)

        if types:
            res[s_name] = {
                "types": sorted(list(types)),
                "orders": sorted(list(orders))
            }

    if "MangaRead" not in res:
        res["MangaRead"] = {"types": ["all", "manhwa", "manga", "manhua"], "orders": ["Newest", "Latest", "Popular", "Rating", "A-Z"]}
    return jsonify(res)

@app.route("/api/search_online")
def api_search():
    return jsonify(get_online_search_results(request.args.get("q", ""), request.args.get("site", "MangaRead")))

@app.route("/api/scrape_details")
def api_scrape_details():
    det = fetch_manga_details(request.args.get("url", ""))
    if det and "ImageBytes" in det:
        del det["ImageBytes"]
    return jsonify(det) if det else (jsonify({"error": "Failed"}), 500)

@app.route("/api/manga_chapters")
def api_chaps():
    return jsonify(scrape_chapters(request.args.get("url", "")))

@app.route("/api/chapter_images")
def api_imgs():
    return jsonify(scrape_chapter_images(request.args.get("url", "")))

@app.route("/api/explore")
def api_explore():
    return jsonify(scrape_explore(request.args.get("site", "MangaRead"), request.args.get("category", "manhwa"), int(request.args.get("page", 1)), request.args.get("orderby", "new-manga"), request.args.get("status", "all")))

@app.route("/api/add_manga", methods=["POST"])
def api_add():
    u = request.json.get("url")
    # 1. Fetch details (Scraping part)
    det = fetch_manga_details(u)
    if not det:
        return jsonify({"ok": False, "msg": "Failed to scrape details"}), 500

    # 2. Check if already in library (SQLite handles case-insensitive trim check)
    if engine.title_exists(det["Title"]):
        return jsonify({"ok": False, "msg": "In Library"}), 409

    # 3. Add record to SQLite (instant — no more slow Excel save)
    if engine.add_record(det):
        # Save cover image locally
        fn = cover_filename(det["Title"])
        loc = os.path.join(COVERS_DIR, fn)
        if not os.path.exists(loc) and det.get("ImageBytes"):
            try:
                det["ImageBytes"].seek(0)
                img = Image.open(det["ImageBytes"])
                if img.mode != "RGB":
                    img = img.convert("RGB")
                img.save(loc)
            except Exception as e:
                log.error(f"api_add: failed to save cover for '{det['Title']}': {e}")
        return jsonify({"ok": True})

    return jsonify({"ok": False, "msg": "Database error"}), 500

@app.route("/api/delete_manga", methods=["POST"])
def api_del():
    title = request.json.get("title")
    ok = engine.delete_record(title)
    if ok and cloud.get_current_user():
        # Remove it from the cloud now too, so the phone drops it on its next
        # load. If this fails (offline), the next sync deletes it instead.
        threading.Thread(target=cloud.delete_from_cloud, args=(title,), daemon=True).start()
    return jsonify({"ok": ok})

# ── Auth & Cloud Routes ───────────────────────────────────────────────────────
@app.route("/api/auth/status")
def api_auth_status():
    user = cloud.get_current_user()
    if user and engine.count() == 0:
        log.info("Local library empty on startup. Pulling from cloud...")
        cloud_records = cloud.pull_from_cloud()
        if cloud_records:
            engine.bulk_restore(cloud_records)
            log.info(f"Restored {len(cloud_records)} records.")
        cloud_history = cloud.pull_history_from_cloud()
        if cloud_history:
            engine.bulk_restore_history(cloud_history)
            log.info(f"Restored reading history from cloud.")
    return jsonify({"loggedIn": user is not None, "user": user})

@app.route("/api/auth/register", methods=["POST"])
def api_auth_register():
    d        = request.json or {}
    username = d.get("username", "").strip().lower()
    result   = cloud.register(d.get("email", ""), d.get("password", ""), username)
    # Save pending username so we can push it to Supabase on first login
    if result.get("ok") and result.get("pending_username"):
        engine.save_setting("pending_username", result["pending_username"])
    return jsonify(result)

@app.route("/api/auth/login", methods=["POST"])
def api_auth_login():
    d      = request.json or {}
    result = cloud.login(d.get("email", ""), d.get("password", ""))
    if result.get("ok"):
        # 1. If we have a pending username (from registration), create the Supabase profile
        pending = engine.get_setting("pending_username")
        if pending and not result["user"].get("username"):
            profile_res = cloud.create_profile(pending)
            if profile_res.get("ok"):
                engine.delete_setting("pending_username")
                result["user"]["username"] = pending
            else:
                log.warning(f"profile creation failed: {profile_res.get('msg')}")
        # 2. Smart sync: pull from cloud if local DB is empty, else push local up
        threading.Thread(target=_run_smart_sync, daemon=True).start()
    return jsonify(result)

@app.route("/api/auth/logout", methods=["POST"])
def api_auth_logout():
    return jsonify(cloud.logout())

@app.route("/api/auth/delete_account", methods=["POST"])
def api_auth_delete_account():
    """
    Fully deletes the user's account:
      1. Deletes their manga_library rows
      2. Deletes their profile row
      3. Calls delete_own_account() RPC to remove them from auth.users
      4. Signs them out locally
    """
    user = cloud.get_current_user()
    if not user:
        return jsonify({"ok": False, "msg": "Not logged in."})
    try:
        client = cloud.get_client()
        uid    = user["id"]
        # Delete data rows first
        client.table("manga_library").delete().eq("user_id", uid).execute()
        client.table("profiles").delete().eq("user_id", uid).execute()
        # Delete the auth.users entry via SECURITY DEFINER RPC
        client.rpc("delete_own_account").execute()
        log.info(f"Account fully deleted for {user['email']}")
    except Exception as e:
        log.error(f"delete_account failed: {e}")
        return jsonify({"ok": False, "msg": "Failed to delete account. Please try again."})
    cloud.logout()
    return jsonify({"ok": True})

@app.route("/api/sync", methods=["POST"])
def api_sync():
    threading.Thread(target=_bg_sync, daemon=True).start()
    return jsonify({"ok": True, "msg": "Sync started in background."})

# Titles the cloud held after this machine's last successful sync (JSON list).
# It is what lets a sync tell "deleted on one device" from "added on the other".
_SYNC_SNAPSHOT_KEY = "cloud_titles_snapshot"
_sync_lock = threading.Lock()

def _bg_sync():
    if not _sync_lock.acquire(blocking=False):
        log.info("Sync already running; skipped.")
        return
    try:
        _sync_with_cloud()
    finally:
        _sync_lock.release()

def _sync_with_cloud():
    # Two-way sync, see library_merge.py: titles added or deleted on either
    # device are applied on the other, then per-title values are merged, and
    # only then is the local library pushed. Pushing the local copy as-is used
    # to roll back the phone's newer chapters, dates, progress and deletions.
    cloud_records = cloud.pull_from_cloud_strict()
    if cloud_records is None:
        log.warning("Sync skipped: could not read the cloud library (offline or signed out).")
        return
    by_title = {str(r.get("English", "")).strip(): r for r in cloud_records if str(r.get("English", "")).strip()}
    local_titles = {str(r.get("English", "")).strip() for r in engine.get_all()}

    # Per account: another account's snapshot must never drive deletions here.
    user = cloud.get_current_user() or {}
    snapshot_key = f"{_SYNC_SNAPSHOT_KEY}:{user.get('id', '')}"
    snapshot = engine.get_setting(snapshot_key, "")
    try:
        base = set(json.loads(snapshot)) if snapshot else None
    except ValueError:
        base = None
    plan = library_merge.plan_sync(local_titles, set(by_title), base)
    for reason in plan["blocked"]:
        log.info(f"Sync: {reason}")

    if plan["add_local"]:
        adds = []
        for t in plan["add_local"]:
            r = dict(by_title[t])
            # The phone stores favourites as "1"/"0"; the desktop as "Yes"/"".
            r["Favorite"] = "Yes" if str(r.get("Favorite", "")).strip().lower() in ("yes", "1", "true") else ""
            adds.append(r)
        engine.bulk_restore(adds)
        log.info(f"Sync: added {len(adds)} title(s) from the cloud: {sorted(plan['add_local'])[:5]}")
    for t in plan["delete_cloud"]:
        cloud.delete_from_cloud(t)
        by_title.pop(t, None)
    if plan["delete_cloud"]:
        log.info(f"Sync: removed {len(plan['delete_cloud'])} title(s) deleted on this machine from the cloud.")
    for t in plan["delete_local"]:
        engine.delete_record(t)
    if plan["delete_local"]:
        log.info(f"Sync: removed {len(plan['delete_local'])} title(s) deleted on another device: {sorted(plan['delete_local'])[:5]}")

    changes = {}
    for local in engine.get_all():
        remote = by_title.get(str(local.get("English", "")).strip())
        if remote:
            diff = library_merge.merge_record(local, remote)
            if diff:
                changes[local["English"]] = diff
    if changes:
        n = engine.apply_cloud_changes(changes)
        log.info(f"Sync merge: kept newer cloud values for {n} title(s).")

    records = engine.get_all()
    result  = cloud.sync_to_cloud(records)
    history = engine.get_raw_reading_history()
    h_res   = cloud.sync_history_to_cloud(history)
    log.info(f"Background sync result: {result}, history: {h_res}")
    if result.get("ok"):
        # After the push the cloud holds exactly the local titles.
        engine.save_setting(snapshot_key, json.dumps(sorted(str(r.get("English", "")).strip() for r in records)))

def _run_smart_sync():
    """Restore from the cloud if the local DB is empty, then two-way sync."""
    if engine.count() == 0:
        cloud_records = cloud.pull_from_cloud()
        if cloud_records:
            engine.bulk_restore(cloud_records)
            log.info(f"Smart sync: restored {len(cloud_records)} records from cloud.")
        cloud_history = cloud.pull_history_from_cloud()
        if cloud_history:
            engine.bulk_restore_history(cloud_history)
    _bg_sync()

@app.route("/api/stats")
def api_stats():
    return jsonify(engine.get_reading_history_counts())

@app.route("/api/add_note", methods=["POST"])
def api_add_note():
    t = request.json.get("title")
    n = request.json.get("note", "")
    return jsonify({"ok": engine.update_note(t, n)})



@app.route("/auth/confirm")
def auth_confirm():
    """Serves the email confirmation landing page."""
    return send_from_directory(WEB_DIR, "confirm.html")

@app.route("/api/export")
def api_export():
    """
    Export the user's library as a downloadable file.
    ?format=csv  (default) or ?format=json
    """
    fmt     = request.args.get("format", "csv").lower()
    records = engine.get_all()

    FIELDS = [
        "English", "Manga URL", "Cover URL", "Chapter", "Date",
        "Latest Chapter", "Latest Date", "Genre", "Author",
        "Description", "Rating", "Alternative Names",
        "Favorite", "Category", "Status",
    ]

    if fmt == "json":
        payload  = json.dumps(records, ensure_ascii=False, indent=2)
        filename = "manga_tracker_export.json"
        resp     = Response(
            payload,
            mimetype="application/json",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    else:
        buf = io.StringIO()
        writer = csv.DictWriter(
            buf, fieldnames=FIELDS,
            extrasaction="ignore", lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(records)
        filename = "manga_tracker_export.csv"
        resp     = Response(
            buf.getvalue(),
            mimetype="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    return resp

@app.route("/api/auth/callback", methods=["POST"])
def api_auth_callback():
    """Saves the session when user arrives from a fragment-based email confirmation link."""
    d = request.json or {}
    result = cloud.restore_session_from_tokens(
        d.get("access_token", ""),
        d.get("refresh_token", "")
    )
    if result.get("ok"):
        # Smart sync on fresh confirmation
        threading.Thread(target=_run_smart_sync, daemon=True).start()
    return jsonify(result)

@app.route("/api/auth/verify_otp", methods=["POST"])
def api_auth_verify_otp():
    """Handles PKCE-style email confirmation (token_hash + type)."""
    d = request.json or {}
    result = cloud.verify_otp(d.get("token_hash", ""), d.get("type", "signup"))
    return jsonify(result)

@app.route("/api/auth/exchange_code", methods=["POST"])
def api_auth_exchange_code():
    """Exchange an OAuth PKCE authorization code for a session (Google/Facebook)."""
    d      = request.json or {}
    result = cloud.exchange_code_for_session(d.get("code", ""))
    if result.get("ok"):
        threading.Thread(target=_run_smart_sync, daemon=True).start()
    return jsonify(result)

@app.route("/api/auth/oauth_url")
def api_auth_oauth_url():
    """Returns the provider's OAuth redirect URL so the frontend can redirect there."""
    provider = request.args.get("provider", "").lower()
    if provider not in ("google", "facebook"):
        return jsonify({"ok": False, "msg": "Unsupported provider."})
    return jsonify(cloud.get_oauth_url(provider))

@app.route("/api/auth/set_username", methods=["POST"])
def api_auth_set_username():
    """Create a profile for an OAuth user who signed in without going through registration."""
    d        = request.json or {}
    username = d.get("username", "").strip().lower()
    result   = cloud.create_profile(username)
    return jsonify(result)

if __name__ == "__main__":
    _port = int(os.getenv("MANGA_PORT", DEFAULT_PORT))
    url = f"http://127.0.0.1:{_port}"
    threading.Thread(target=lambda: serve(app, host="127.0.0.1", port=_port, threads=32), daemon=True).start()
    time.sleep(0.8)

    # Try to silently restore the last session (user stays logged in)
    session_result = cloud.restore_session()
    if session_result["ok"]:
        log.info(f"Auto-login: {session_result['user']['email']}")
        # Smart sync: pull from cloud if local DB is empty, else push up
        threading.Thread(target=_run_smart_sync, daemon=True).start()
    else:
        log.info("No active session — user will need to log in.")

    browser = None
    for p in [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", r"C:\Program Files\Microsoft\Edge\Application\msedge.exe", r"C:\Program Files\Google\Chrome\Application\chrome.exe"]:
        if os.path.exists(p):
            browser = p
            break
    if browser:
        p_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".app_profile")
        subprocess.Popen([browser, f"--app={url}", "--window-size=1400,900", f"--user-data-dir={p_dir}"])
    else:
        import webbrowser
        webbrowser.open(url)
    log.info("App Ready")
    while True:
        time.sleep(10)
