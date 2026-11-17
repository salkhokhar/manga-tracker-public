"""Reading comic sites with the app's scraper configs (app/scrapers/*.json).

Each config describes a site: its search URL (`search_url` with `{query}`),
CSS selectors for search result cards, the comic page and the chapter list,
and the scale of its rating (`rating_scale`, 5 unless it says 10). Parsing is
kept separate from fetching so it can be tested on saved HTML.

Sites behind a browser check (Cloudflare) or that only render in a browser
are reported as unavailable rather than failing the whole call.
"""

from __future__ import annotations

import json
import os
import re
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse

from bs4 import BeautifulSoup

from .text import normalize_rating, split_names

# Some configs use the older ":contains" selector syntax, which still works.
warnings.filterwarnings("ignore", category=FutureWarning, module="soupsieve")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
TIMEOUT = 20

# Used where a config leaves a selector out (most sites are WordPress
# "Madara" or "MangaStream" themes, which share these class names).
DEFAULT_SEARCH = {
    "item": ".c-tabs-item__content, .page-item-detail, .bsx",
    "title": ".post-title h3 a, h3 a, .tt",
    "link": ".post-title h3 a, h3 a, a",
    "latest_chapter": ".font-meta.chapter, .chapter-item a, .epxs",
}
DEFAULT_DETAILS = {
    "title": ".post-title h1, .entry-title, h1",
    "desc": ".summary__content, .entry-content, .manga-excerpt, [itemprop=description]",
    "genre": ".genres-content a, .mgen a, .seriestugenre a",
    "author": ".author-content a",
    "rating": "#averagerate, .num, .score",
}
DEFAULT_CHAPTERS = {"item": ".wp-manga-chapter, #chapterlist li, .eph-num", "title": "a"}

_ALT_KEY = re.compile(r"alternative|alt(ernate)?\s*(name|title)|synonym|other\s*name|associated", re.I)
_STATUS_KEY = re.compile(r"status", re.I)


@dataclass
class Site:
    name: str
    host: str
    rules: dict
    search_url: str = ""
    rating_scale: int = 5
    needs_browser: bool = False

    def selectors(self, kind: str, defaults: dict) -> dict:
        sel = dict(defaults)
        own = (self.rules.get("selectors") or {}).get(kind) or {}
        sel.update({k: v for k, v in own.items() if v})
        return sel

    def search_rules(self) -> dict:
        sel = self.rules.get("selectors") or {}
        own = sel.get("search") or sel.get("explore") or {}
        rules = dict(DEFAULT_SEARCH)
        rules.update({k: v for k, v in own.items() if v})
        return rules


def default_scrapers_dir() -> Path:
    env = os.environ.get("MANGA_SCRAPERS_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "app" / "scrapers"


def load_sites(directory: Path | None = None) -> list[Site]:
    directory = directory or default_scrapers_dir()
    sites = []
    for path in sorted(Path(directory).glob("*.json")):
        try:
            rules = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        sites.append(Site(
            name=rules.get("name") or path.stem,
            host=path.stem.lower(),
            rules=rules,
            search_url=rules.get("search_url") or "",
            rating_scale=10 if str(rules.get("rating_scale", 5)) == "10" else 5,
            # Asura only renders in a real browser; the app opens it in one.
            needs_browser=bool(rules.get("force_playwright")),
        ))
    return sites


def host_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower().removeprefix("www.")


def site_for_url(sites: list[Site], url: str) -> Site | None:
    host = host_of(url)
    for s in sites:
        if host == s.host or host.endswith("." + s.host):
            return s
    return None


def is_challenge(html: str) -> bool:
    """A Cloudflare or similar browser check instead of the real page."""
    head = html[:5000]
    return "Just a moment" in head or "cf-challenge" in html or "challenge-platform" in head


def search_url(site: Site, query: str) -> str:
    return site.search_url.replace("{query}", quote(query.strip()))


def _select_one(node, selector: str):
    for sel in (s.strip() for s in (selector or "").split(",")):
        if not sel:
            continue
        try:
            found = node.select_one(sel)
        except Exception:  # an invalid selector in one config must not stop the rest
            continue
        if found is not None:
            return found
    return None


def _select_all(node, selector: str) -> list:
    try:
        return node.select(selector) if selector else []
    except Exception:
        return []


def _text(el) -> str:
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip() if el is not None else ""


def parse_search(html: str, site: Site, page_url: str) -> list[dict]:
    """Result cards on a search page: title, url, latest chapter."""
    soup = BeautifulSoup(html, "html.parser")
    rules = site.search_rules()
    out, seen = [], set()
    for card in _select_all(soup, rules["item"]):
        title_el = _select_one(card, rules["title"])
        link_el = _select_one(card, rules["link"])
        if link_el is not None and link_el.name != "a":
            link_el = link_el.find("a")
        href = link_el.get("href") if link_el is not None else None
        title = _text(title_el)
        if not title or not href:
            continue
        url = urljoin(page_url, href)
        if url in seen or host_of(url) != host_of(page_url):
            continue
        seen.add(url)
        out.append({
            "title": title,
            "url": url,
            "site": site.name,
            "latest_chapter": _text(_select_one(card, rules.get("latest_chapter", ""))) or None,
        })
    return out


def parse_details(html: str, site: Site, url: str) -> dict:
    """A comic page: description, genres, alternative names, rating, chapters."""
    soup = BeautifulSoup(html, "html.parser")
    det = site.selectors("details", DEFAULT_DETAILS)
    ch = site.selectors("chapters", DEFAULT_CHAPTERS)

    rating_text = ""
    rating_el = _select_one(soup, det.get("rating", ""))
    if rating_el is not None:
        attr = det.get("rating_attr")
        rating_text = (rating_el.get(attr) or "") if attr else _text(rating_el)
        if not re.search(r"\d", rating_text):
            rating_text = rating_el.get("title") or rating_el.get("content") or ""

    alt_names: list[str] = []
    status = ""
    if det.get("alt_names"):
        alt_names = split_names(_text(_select_one(soup, det["alt_names"])))
    if det.get("meta_container") and det.get("meta_key") and det.get("meta_val"):
        for block in _select_all(soup, det["meta_container"]):
            key = _text(block if det["meta_key"] == "self" else _select_one(block, det["meta_key"]))
            val = _text(block if det["meta_val"] == "self" else _select_one(block, det["meta_val"]))
            if not alt_names and _ALT_KEY.search(key):
                alt_names = split_names(_ALT_KEY.sub("", val) if det["meta_val"] == "self" else val)
            elif not status and _STATUS_KEY.search(key):
                status = _STATUS_KEY.sub("", val).strip(" :") if det["meta_val"] == "self" else val
    if not status and det.get("status"):
        status = _text(_select_one(soup, det["status"]))

    rows = _select_all(soup, ch["item"])
    chapter_titles = [_text(_select_one(r, ch.get("title", "")) or r) for r in rows]
    chapter_titles = [t for t in chapter_titles if t]
    latest = chapter_titles[0] if chapter_titles else _text(_select_one(soup, det.get("latest_chapter", ""))) or None

    genres = []
    # A site's markup can move on from its config: fall back to the usual places.
    genre_els = _select_all(soup, det.get("genre", "")) or _select_all(soup, DEFAULT_DETAILS["genre"])
    for g in genre_els:
        t = _text(g)
        if t and t not in genres:
            genres.append(t)

    desc = _text(_select_one(soup, det.get("desc", "")))
    if not desc:
        meta = soup.find("meta", attrs={"name": "description"})
        desc = (meta.get("content") or "").strip() if meta else ""

    return {
        "title": _text(_select_one(soup, det.get("title", ""))) or None,
        "url": url,
        "site": site.name,
        "description": desc[:1500] or None,
        "genres": genres,
        "author": _text(_select_one(soup, det.get("author", ""))) or None,
        "status": status or None,
        "alternative_names": alt_names[:10],
        "rating_out_of_5": normalize_rating(rating_text, site.rating_scale),
        "latest_chapter": latest,
        # Only what the page lists without scrolling: some sites load the rest later.
        "chapters_listed": len(chapter_titles) or None,
    }


@dataclass
class Fetcher:
    """GETs pages with a browser-like user agent; one session per server."""
    session: object = field(default=None)

    def __post_init__(self):
        if self.session is None:
            import requests
            self.session = requests.Session()
            self.session.headers.update({"User-Agent": USER_AGENT, "Accept": "text/html,*/*"})

    def get(self, url: str) -> tuple[str, str]:
        """(html, final_url). Raises on HTTP errors and browser checks."""
        r = self.session.get(url, timeout=TIMEOUT)
        r.raise_for_status()
        if is_challenge(r.text):
            raise PermissionError("the site answered with a browser check (Cloudflare)")
        return r.text, r.url
