"""MCP server for a manga / manhwa reading library.

Gives an MCP client (Claude Desktop, Claude Code, ...) tools to read your
library and reading progress, see which comics have new chapters, search the
supported sites, read a comic's page, find comics by theme, and record how
far you have read. Run with `python -m manga_mcp` (stdio).
"""

from __future__ import annotations

import asyncio
import datetime
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp_types import ToolAnnotations

from .library import Comic, library_from_env
from .sites import Fetcher, Site, load_sites, parse_details, parse_search, search_url, site_for_url
from .text import SAME_SERIES, format_chapter, normalize_title, split_names, title_similarity

INSTRUCTIONS = """\
Tools for the user's manga / manhwa / manhua reading library and the sites it
reads from. Library tools reflect what the user follows and how far they have
read. Site tools fetch live pages, so they take a few seconds and some sites
may be unavailable; say which ones when it matters. To find comics by theme,
call find_by_theme with several keywords and synonyms, then judge each
candidate from its description and genres instead of trusting the title.
Only call mark_read when the user says which chapter they reached."""

MAX_WORKERS = 8
_LIBRARY_MISSING = (
    "No library is configured. Set SUPABASE_URL, SUPABASE_SECRET_KEY and "
    "MANGA_USER_ID, or MANGA_DB to the desktop app's SQLite file."
)


def _parse_date(value: str) -> datetime.datetime | None:
    s = (value or "").strip()
    for fmt in ("%Y-%m-%dT%H:%MZ", "%Y-%m-%d", "%d %b %Y", "%d %B %Y", "%d.%m.%Y", "%B %d, %Y"):
        try:
            return datetime.datetime.strptime(s, fmt)
        except ValueError:
            continue
    m = re.match(r"(\d{4}-\d{2}-\d{2})", s)
    return datetime.datetime.strptime(m.group(1), "%Y-%m-%d") if m else None


def _short(err: Exception) -> str:
    """A one-line reason: 'SSLError', 'HTTP 403', 'timed out', ..."""
    text = str(err)
    if "CERTIFICATE_VERIFY_FAILED" in text:
        return "the site's HTTPS certificate is invalid"
    if "timed out" in text.lower():
        return "timed out"
    status = getattr(getattr(err, "response", None), "status_code", None)
    return f"HTTP {status}" if status else (text.splitlines()[0][:120] or type(err).__name__)


class LibraryIndex:
    """Answers "is this comic already in the library?" by URL or by name."""

    def __init__(self, comics: list[Comic]):
        self.by_url: dict[str, Comic] = {}
        self.names: list[tuple[str, Comic]] = []
        for c in comics:
            for u in [c.url, *c.other_sources]:
                if u:
                    self.by_url[u.rstrip("/")] = c
            for n in [c.title, *split_names(c.alternative_names)]:
                self.names.append((n, c))

    def find(self, title: str = "", url: str = "") -> Comic | None:
        if url and url.rstrip("/") in self.by_url:
            return self.by_url[url.rstrip("/")]
        if title:
            best, score = None, 0.0
            for name, comic in self.names:
                s = 1.0 if normalize_title(name) == normalize_title(title) else title_similarity(name, title)
                if s > score:
                    best, score = comic, s
            if score >= SAME_SERIES:
                return best
        return None


def build_server(library=None, sites: list[Site] | None = None, fetcher: Fetcher | None = None) -> MCPServer:
    sites = sites if sites is not None else load_sites()
    fetcher = fetcher or Fetcher()
    server = MCPServer("manga-tracker", instructions=INSTRUCTIONS)

    def need_library():
        if library is None:
            raise RuntimeError(_LIBRARY_MISSING)
        return library

    def index() -> LibraryIndex:
        return LibraryIndex(library.comics()) if library is not None else LibraryIndex([])

    def pick_sites(names: list[str] | None) -> list[Site]:
        chosen = [s for s in sites if s.search_url]
        if names:
            wanted = {n.lower() for n in names}
            chosen = [s for s in chosen if s.name.lower() in wanted or s.host in wanted]
        return chosen

    def search_one(site: Site, query: str) -> tuple[list[dict], str]:
        if site.needs_browser:
            return [], "skipped: this site only works in a real browser (the phone app opens it in one)"
        try:
            html, final = fetcher.get(search_url(site, query))
        except Exception as e:  # one site failing must not fail the search
            return [], f"unavailable: {_short(e)}"
        results = parse_search(html, site, final)
        return results, f"ok, {len(results)} result(s)"

    def search_many(queries: list[str], site_list: list[Site]) -> tuple[dict, dict]:
        jobs = [(s, q) for q in queries for s in site_list]
        with ThreadPoolExecutor(MAX_WORKERS) as pool:
            done = list(pool.map(lambda job: (job, search_one(*job)), jobs))
        by_query: dict[str, list[dict]] = {q: [] for q in queries}
        status: dict[str, str] = {}
        for (site, q), (results, st) in done:
            by_query[q].extend(results)
            if not status.get(site.name, "").startswith("ok"):
                status[site.name] = st
        return by_query, status

    def details_one(url: str) -> dict[str, Any]:
        site = site_for_url(sites, url)
        if site is None:
            return {"url": url, "error": "no scraper config for this site"}
        if site.needs_browser:
            return {"url": url, "site": site.name, "error": "this site only works in a real browser"}
        try:
            html, final = fetcher.get(url)
        except Exception as e:
            return {"url": url, "site": site.name, "error": f"unavailable: {_short(e)}"}
        return parse_details(html, site, final)

    @server.tool(structured_output=True, annotations=ToolAnnotations(title="My library", read_only_hint=True))
    async def my_library(
        show: Literal["all", "unread", "reading", "completed", "favorites"] = "all",
        search: str = "",
    ) -> dict[str, Any]:
        """List the comics in the user's library with reading progress.

        show: "unread" = has chapters after the last one read; "reading" /
        "completed" filter on the reading status; "favorites" = marked favorite.
        search: optional text to match in titles and alternative names.
        """
        comics = await asyncio.to_thread(need_library().comics)
        out = []
        for c in comics:
            if show == "unread" and not c.unread:
                continue
            if show == "reading" and (c.category or c.status or "").lower() not in ("reading", ""):
                continue
            if show == "completed" and "complet" not in f"{c.category} {c.status}".lower():
                continue
            if show == "favorites" and not c.favorite:
                continue
            if search and search.lower() not in f"{c.title} {c.alternative_names}".lower():
                continue
            out.append(c.as_dict())
        return {"total_in_library": len(comics), "shown": len(out), "comics": out}

    @server.tool(structured_output=True, annotations=ToolAnnotations(title="What's new", read_only_hint=True))
    async def whats_new(limit: int = 25) -> dict[str, Any]:
        """Comics with chapters the user has not read yet, newest release first.

        Uses the newest chapters already recorded in the library (the apps and a
        scheduled job keep these current); it does not visit the sites.
        """
        comics = await asyncio.to_thread(need_library().comics)
        fresh = [c for c in comics if c.unread]
        fresh.sort(key=lambda c: _parse_date(c.latest_date) or datetime.datetime.min, reverse=True)
        return {
            "comics_with_unread": len(fresh),
            "comics": [c.as_dict() for c in fresh[: max(1, min(limit, 200))]],
        }

    @server.tool(structured_output=True, annotations=ToolAnnotations(title="Search sites", read_only_hint=True, open_world_hint=True))
    async def search_comics(query: str, sites: list[str] | None = None) -> dict[str, Any]:
        """Search the supported sites by title and say which results are already in the library.

        sites: optional site names to limit the search (default: every site
        that has a search page). Searches titles only, not descriptions.
        """
        site_list = pick_sites(sites)
        by_query, status = await asyncio.to_thread(search_many, [query], site_list)
        idx = await asyncio.to_thread(index)
        results = []
        for r in by_query[query]:
            hit = idx.find(r["title"], r["url"])
            results.append({**r, "in_library": hit.title if hit else None})
        return {"query": query, "results": results, "sites": status}

    @server.tool(structured_output=True, annotations=ToolAnnotations(title="Comic details", read_only_hint=True, open_world_hint=True))
    async def comic_details(url: str) -> dict[str, Any]:
        """Read a comic's page on a supported site: description, genres, author,
        status, alternative names, rating out of 5, and the newest chapter.
        Also says whether it is in the library and how far the user has read."""
        info = await asyncio.to_thread(details_one, url)
        hit = (await asyncio.to_thread(index)).find(info.get("title") or "", url)
        if hit:
            info["in_library"] = {"title": hit.title, "last_read": hit.read or None}
        return info

    @server.tool(structured_output=True, annotations=ToolAnnotations(title="Find by theme", read_only_hint=True, open_world_hint=True))
    async def find_by_theme(keywords: list[str], max_candidates: int = 12, include_library: bool = False) -> dict[str, Any]:
        """Find comics that may match a theme, for the caller to judge.

        Sites have no reliable tags for themes like "regression" or "class
        system", so this searches titles for each keyword on every site, merges
        the same comic found on several sites, ranks comics found by more
        keywords first, and returns each candidate's page details (description,
        genres, rating). Pass 3 to 6 keywords and synonyms, e.g. ["regression",
        "regressor", "return", "class", "system", "level"]. Comics already in
        the library are left out unless include_library is true.
        """
        keywords = [k.strip() for k in keywords if k and k.strip()][:6]
        if not keywords:
            return {"error": "give at least one keyword"}
        by_query, status = await asyncio.to_thread(search_many, keywords, pick_sites(None))
        idx = await asyncio.to_thread(index)

        merged: list[dict] = []
        for kw in keywords:
            for r in by_query[kw]:
                same = next((m for m in merged if m["url"] == r["url"]
                             or title_similarity(m["title"], r["title"]) >= SAME_SERIES
                             or normalize_title(m["title"]) == normalize_title(r["title"])), None)
                if same is None:
                    same = {"title": r["title"], "url": r["url"], "site": r["site"], "matched": [], "also_on": []}
                    merged.append(same)
                elif r["site"] != same["site"] and r["site"] not in same["also_on"]:
                    same["also_on"].append(r["site"])
                if kw not in same["matched"]:
                    same["matched"].append(kw)

        skipped = []
        if not include_library:
            keep = []
            for m in merged:
                hit = idx.find(m["title"], m["url"])
                (skipped if hit else keep).append(m if not hit else hit.title)
            merged = keep
        merged.sort(key=lambda m: len(m["matched"]), reverse=True)
        top = merged[: max(1, min(max_candidates, 25))]

        with ThreadPoolExecutor(MAX_WORKERS) as pool:
            pages = await asyncio.to_thread(lambda: list(pool.map(lambda m: details_one(m["url"]), top)))
        candidates = []
        for m, page in zip(top, pages):
            candidates.append({
                "title": m["title"], "url": m["url"], "site": m["site"], "also_on": m["also_on"],
                "matched_keywords": m["matched"],
                **{k: page.get(k) for k in ("description", "genres", "status", "rating_out_of_5",
                                            "latest_chapter", "alternative_names", "error") if page.get(k)},
            })
        return {
            "keywords": keywords,
            "titles_found": len(merged) + len(skipped),
            "already_in_library": sorted(set(skipped))[:30],
            "candidates": candidates,
            "sites": status,
        }

    @server.tool(structured_output=True, annotations=ToolAnnotations(
        title="Mark as read", read_only_hint=False, destructive_hint=False, idempotent_hint=True))
    async def mark_read(title: str, chapter: str) -> dict[str, Any]:
        """Record the last chapter the user has read for a comic in their library.

        title: the comic's title as in the library (close matches are accepted
        when there is only one). chapter: a number or "Chapter 42".
        """
        value = format_chapter(chapter)
        if value is None:
            return {"error": f'"{chapter}" has no chapter number'}
        lib = need_library()
        comics = await asyncio.to_thread(lib.comics)
        exact = [c for c in comics if c.title.lower() == title.strip().lower()]
        close = exact or [c for c in comics if title_similarity(c.title, title) >= SAME_SERIES]
        if len(close) != 1:
            near = sorted(comics, key=lambda c: title_similarity(c.title, title), reverse=True)[:5]
            return {"error": "no single comic matches that title" if not close else "several comics match",
                    "closest": [c.title for c in near]}
        comic = close[0]
        await asyncio.to_thread(lib.set_progress, comic.title, value)
        return {"title": comic.title, "before": comic.read or None, "after": value, "latest": comic.latest or None}

    return server


def main() -> None:
    build_server(library=library_from_env()).run()


if __name__ == "__main__":
    main()
