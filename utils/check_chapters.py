"""Scheduled new-chapter check for every library in Supabase.

Runs from GitHub Actions every few hours (.github/workflows/check-chapters.yml)
so the phone and desktop show new chapters as soon as they open, without the
app having to be running. Same rules as the phone's refresh:

  * MangaRead and other Madara-theme sites: the newest chapter row of the
    series page, with the release date printed next to it ("31.07.2026", or
    "2 days ago" resolved now). A newer chapter only counts once its page has
    images (sites list some chapters before uploading them).
  * Asura Scans: the newest chapter that isn't Early Access (is_premium).
  * Other sites are skipped rather than guessed at.

Only moves forward: latest_chapter changes only to a higher number, and for the
same chapter only a wrong or relative stored date is replaced by the site's.

Needs SUPABASE_URL and SUPABASE_SECRET_KEY (secret key: bypasses row-level
security, so it can update every user's rows). Never printed.

  python utils/check_chapters.py --dry-run          # show what would change
  python utils/check_chapters.py --env-file .env    # load the keys from a file
"""

import argparse
import datetime
import os
import re
import sys
import time
import urllib.parse

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import library_merge as lm  # noqa: E402

UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
TIMEOUT = 20
DELAY = 0.5           # between series pages, to be polite to the sites
MAX_PAGE_CHECKS = 2   # chapter pages fetched per series to rule out phantoms
PAGE_MARKER = "wp-manga-chapter-img"


def load_env_file(path):
    if not path or not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def fetch(session, url):
    try:
        r = session.get(url, timeout=TIMEOUT)
        return r.ok, r.text if r.ok else "", r.url
    except requests.RequestException:
        return False, "", url


def is_challenge(html):
    return bool(re.search(r"<title>\s*Just a moment", html, re.I)) or "challenge-platform" in html


# ── Madara (MangaRead) ────────────────────────────────────────────────────────
_ROW_RE = re.compile(r'<li\b[^>]*class="[^"]*\bwp-manga-chapter\b[^"]*"[^>]*>(.*?)</li>', re.S)
_LINK_RE = re.compile(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S)
_DATE_RE = re.compile(r'chapter-release-date[^>]*>(.*?)</span>', re.S)
_TITLE_ATTR_RE = re.compile(r'title="([^"]+)"')


def _text(html):
    return " ".join(re.sub(r"<[^>]+>", " ", html).replace("&nbsp;", " ").split())


def madara_rows(html, now):
    """[(number, chapter_url, date or None)], newest first. The date is a UTC
    timestamp for relative ones ("6 hours ago" → '2026-10-26T07:05Z'), so
    same-day releases keep their order, and 'DD Mon YYYY' for dated ones."""
    out, seen = [], set()
    for m in _ROW_RE.finditer(html):
        row = m.group(1)
        link = _LINK_RE.search(row)
        if not link:
            continue
        n = lm.chapter_number(_text(link.group(2)))
        if n is None or n in seen:
            continue
        seen.add(n)
        date = None
        dm = _DATE_RE.search(row)
        if dm:
            raw = _text(dm.group(1))
            if not raw:
                t = _TITLE_ATTR_RE.search(dm.group(1))
                raw = t.group(1) if t else ""
            d = lm.parse_absolute_date(raw)
            date = lm.format_day(d) if d else lm.relative_to_absolute(raw, now)
        out.append((n, link.group(1), date))
        if len(out) >= 50:
            break
    return out


def has_pages(session, url):
    """True / False (phantom) / None (couldn't tell)."""
    ok, html, _ = fetch(session, url)
    if not ok or is_challenge(html):
        return None
    return PAGE_MARKER in html


def check_madara(session, html, stored_n, now):
    """(number, date) of the newest chapter safe to store, or None."""
    checks = 0
    for n, url, date in madara_rows(html, now):
        if stored_n is not None and n <= stored_n:
            return n, date
        if checks >= MAX_PAGE_CHECKS:
            return None
        checks += 1
        pages = has_pages(session, url)
        if pages:
            return n, date
        if pages is None:
            return None
        # phantom: listed without pages, try the previous chapter
    return None


# ── Asura Scans ───────────────────────────────────────────────────────────────
_ASURA_HOST = re.compile(r"(^|\.)(asurascans\.com|asuracomic\.net)$", re.I)
_ASURA_CH_OBJ = re.compile(r'"series_id":\[0,(\d+)\],"number":\[0,([\d.]+)\][^{}]*?"is_premium":\[0,(true|false)\]')


def is_asura(url):
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return bool(_ASURA_HOST.search(host))


def asura_latest_unlocked(html, page_url):
    decoded = html.replace("&quot;", '"')
    rows, counts = [], {}
    for sid, num, prem in _ASURA_CH_OBJ.findall(decoded):
        rows.append((sid, float(num), prem == "true"))
        if sid != "0":
            counts[sid] = counts.get(sid, 0) + 1
    page_id = max(counts, key=counts.get) if counts else None
    locked = {n for sid, n, prem in rows if prem and (page_id is None or sid == page_id)}
    path = urllib.parse.urlparse(page_url).path.rstrip("/")
    base = re.sub(r"-[0-9a-f]{6,12}$", "", path, flags=re.I)
    href_re = re.compile(re.escape(base) + r"(?:-[0-9a-f]{6,12})?/chapter/", re.I)
    for href, inner in _LINK_RE.findall(html):
        if not href_re.search(href):
            continue
        text = _text(inner)
        if "Early Access" in text or "Unlocks in" in text:
            continue
        n = lm.chapter_number(text)
        if n is not None and n not in locked:
            return n
    return None


# ── One library row ───────────────────────────────────────────────────────────
def fmt_chapter(n):
    return f"Chapter {int(n) if float(n).is_integer() else n}"


def plan_row(session, row, now):
    """Changes for one manga_library row ({} when nothing to do), and a reason."""
    url = row.get("manga_url") or ""
    if not url.startswith(("http://", "https://")):
        return {}, "no url"
    ok, html, final_url = fetch(session, url)
    if not ok or is_challenge(html):
        return {}, "unreachable"
    stored_n = lm.chapter_number(row.get("latest_chapter"))
    stored_date = lm.parse_absolute_date(row.get("latest_date"))
    if "wp-manga-chapter" in html:
        found = check_madara(session, html, stored_n, now)
        if not found:
            return {}, "nothing verifiable"
        n, date = found
    elif is_asura(final_url):
        n = asura_latest_unlocked(html, final_url)
        if n is None:
            return {}, "nothing verifiable"
        date = None
    else:
        return {}, "unsupported site"

    if stored_n is None or n > stored_n:
        return {"latest_chapter": fmt_chapter(n), "latest_date": date or lm.iso_minute(now)}, "new chapter"
    stored_raw = row.get("latest_date")
    # Same chapter: a stored timestamp is already exact, so keep it (the site's
    # "N hours ago" rounding would otherwise rewrite it on every run). A plain
    # day, a relative value or no date is replaced by the site's date, or
    # upgraded to a timestamp on the same day.
    if n == stored_n and date and not lm.has_time(stored_raw) and (
            lm.parse_absolute_date(date) != stored_date or lm.has_time(date)):
        return {"latest_date": date}, "date corrected"
    return {}, "up to date"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print the changes, write nothing")
    ap.add_argument("--env-file", help="load SUPABASE_URL / SUPABASE_SECRET_KEY from this file")
    ap.add_argument("--limit", type=int, default=0, help="check only the first N rows (testing)")
    args = ap.parse_args()
    load_env_file(args.env_file)

    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SECRET_KEY", "")
    if not base or not key.startswith("sb_secret_"):
        print("SUPABASE_URL and SUPABASE_SECRET_KEY (sb_secret_...) are required.")
        return 2
    api = f"{base}/rest/v1/manga_library"
    db_headers = {"apikey": key, "Content-Type": "application/json", "Prefer": "return=minimal"}

    r = requests.get(api, headers=db_headers, timeout=TIMEOUT,
                     params={"select": "user_id,title,manga_url,latest_chapter,latest_date"})
    if not r.ok:
        print(f"Could not read manga_library: HTTP {r.status_code}")
        return 1
    rows = r.json()
    if args.limit:
        rows = rows[: args.limit]

    session = requests.Session()
    session.headers.update({"User-Agent": UA, "Accept": "text/html,*/*"})
    now = datetime.datetime.now(datetime.timezone.utc)
    tally, written, failed = {}, 0, 0
    page_cache = {}
    for i, row in enumerate(rows):
        url = row.get("manga_url") or ""
        # Several users can follow the same series: check each page once.
        cache_key = (url, row.get("latest_chapter"), row.get("latest_date"))
        if cache_key in page_cache:
            changes, reason = page_cache[cache_key]
        else:
            changes, reason = plan_row(session, row, now)
            page_cache[cache_key] = (changes, reason)
            time.sleep(DELAY)
        tally[reason] = tally.get(reason, 0) + 1
        if not changes:
            continue
        print(f"  {reason}: {row['title'][:60]}: {row.get('latest_chapter')!r} / {row.get('latest_date')!r} -> {changes}")
        if args.dry_run:
            continue
        p = requests.patch(api, headers=db_headers, timeout=TIMEOUT, json=changes,
                           params={"user_id": f"eq.{row['user_id']}", "title": f"eq.{row['title']}"})
        if p.ok:
            written += 1
        else:
            failed += 1
            print(f"    write failed: HTTP {p.status_code}")

    print(f"Checked {len(rows)} rows: " + ", ".join(f"{v} {k}" for k, v in sorted(tally.items())))
    print(("Dry run: nothing written." if args.dry_run else f"Written: {written}, failed: {failed}."))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
