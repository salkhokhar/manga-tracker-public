"""manga_mcp: page parsing, the SQLite library, and the tools end to end
through an in-process MCP client. No network: a fake fetcher serves pages."""

import asyncio
import json
import sqlite3
from pathlib import Path

import pytest
from mcp import Client

from manga_mcp.library import SqliteLibrary
from manga_mcp.server import build_server
from manga_mcp.sites import Site, is_challenge, load_sites, parse_details, parse_search
from manga_mcp.text import chapter_number, format_chapter, normalize_rating, title_similarity

MADARA = Site(name="MangaRead", host="mangaread.org",
              search_url="https://www.mangaread.org/?s={query}&post_type=wp-manga",
              rules=json.loads(Path("app/scrapers/mangaread.org.json").read_text(encoding="utf-8")))
TOP = Site(name="ManhuaTop", host="manhuatop.org", search_url="https://manhuatop.org/search/{query}/",
           rules=json.loads(Path("app/scrapers/manhuatop.org.json").read_text(encoding="utf-8")))

SEARCH_HTML = """
<div class="c-tabs-item__content"><div class="post-title"><h3><a href="/manga/absolute-regression/">Absolute Regression</a></h3></div>
<span class="font-meta chapter"><a>Chapter 52</a></span></div>
<div class="c-tabs-item__content"><div class="post-title"><h3><a href="https://www.mangaread.org/manga/solo-leveling/">Solo Leveling</a></h3></div></div>
<div class="c-tabs-item__content"><div class="post-title"><h3><a href="https://ads.example.com/x">Ad</a></h3></div></div>
"""

DETAILS_HTML = """
<div class="post-title"><h1>Absolute Regression</h1></div>
<div class="summary__content"><p>A swordsman returns to his youth with every class skill he earned.</p></div>
<div class="genres-content"><a>Action</a><a>Fantasy</a><a>Action</a></div>
<span id="averagerate">4.6</span>
<div class="post-content_item"><div class="summary-heading"><h5>Alternative</h5></div><div class="summary-content">절대회귀; Absolute Return</div></div>
<div class="post-content_item"><div class="summary-heading"><h5>Status</h5></div><div class="summary-content">OnGoing</div></div>
<ul><li class="wp-manga-chapter"><a href="/c/52">Chapter 52</a></li><li class="wp-manga-chapter"><a href="/c/51">Chapter 51</a></li></ul>
"""

TOP_DETAILS = """
<h1 id="manga-title">Barbarian's Adventure</h1><p class="alternative-title">Surviving as a Barbarian / 판타지 세계 속 바바리안</p>
<span class="card-rating" title="4.5 out of 5 from 75 votes"><svg></svg></span>
<article class="chapter-item"><a href="/c/75"><strong>Chapter 75</strong></a></article>
"""


def test_text_helpers():
    assert chapter_number("Chapter 12.5") == 12.5
    assert chapter_number("Unknown") is None
    assert format_chapter("42") == "Chapter 42" and format_chapter("ch 7.5") == "Chapter 7.5"
    assert normalize_rating("9.7", 10) == 4.8 or normalize_rating("9.7", 10) == 4.9
    assert normalize_rating("4.5 out of 5", 5) == 4.5 and normalize_rating("0", 5) is None
    assert title_similarity("The Hero Returns", "Hero Returns!") == 1
    assert title_similarity("Solo Leveling", "Solo Leveling Ragnarok") < 0.85


def test_parse_search_keeps_cards_on_the_site():
    res = parse_search(SEARCH_HTML, MADARA, "https://www.mangaread.org/?s=regression")
    assert [r["title"] for r in res] == ["Absolute Regression", "Solo Leveling"]
    assert res[0]["url"] == "https://www.mangaread.org/manga/absolute-regression/"
    assert res[0]["latest_chapter"] == "Chapter 52"


def test_parse_details_madara():
    d = parse_details(DETAILS_HTML, MADARA, "https://www.mangaread.org/manga/absolute-regression/")
    assert d["title"] == "Absolute Regression"
    assert d["genres"] == ["Action", "Fantasy"]
    assert d["rating_out_of_5"] == 4.6
    assert d["alternative_names"] == ["Absolute Return"] or "Absolute Return" in d["alternative_names"]
    assert d["status"] == "OnGoing"
    assert d["latest_chapter"] == "Chapter 52" and d["chapters_listed"] == 2
    assert "class skill" in d["description"]


def test_parse_details_rating_from_attribute():
    d = parse_details(TOP_DETAILS, TOP, "https://manhuatop.org/manhua/x/")
    assert d["rating_out_of_5"] == 4.5
    assert "Surviving as a Barbarian" in d["alternative_names"]
    assert d["latest_chapter"] == "Chapter 75"


def test_challenge_detection_and_config_loading():
    assert is_challenge("<title>Just a moment...</title>")
    assert not is_challenge("<html><body>ok</body></html>")
    sites = {s.name: s for s in load_sites(Path("app/scrapers"))}
    assert sites["Asura Scans"].needs_browser and sites["Asura Scans"].rating_scale == 10
    assert sites["MangaRead"].search_url and not sites["MangaRead"].needs_browser


@pytest.fixture
def library_db(tmp_path):
    path = tmp_path / "lib.db"
    with sqlite3.connect(path) as db:
        db.execute("""CREATE TABLE manga (title TEXT, manga_url TEXT, chapter TEXT, latest_chapter TEXT,
                      latest_date TEXT, last_read_date TEXT, status TEXT, category TEXT, genre TEXT,
                      rating TEXT, alternative_names TEXT, favorite TEXT, notes TEXT)""")
        db.executemany("INSERT INTO manga VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [
            ("Solo Leveling", "https://www.mangaread.org/manga/solo-leveling/", "Chapter 200", "Chapter 200",
             "2023-05-31", "", "Completed", "Completed", "", "", "Na Honjaman Level Up", "Yes", ""),
            ("Nano Machine", "https://www.mangaread.org/manga/nano-machine/", "Chapter 330", "Chapter 337",
             "2026-11-04T22:55Z", "", "Ongoing", "Reading", "", "4.5", "", "", ""),
            ("Infinite Titles", "https://www.mangaread.org/manga/infinite-titles/", "Chapter 20", "Chapter 23",
             "2026-11-16T01:17Z", "", "Ongoing", "Reading", "", "", "", "", ""),
        ])
    return str(path)


class FakeFetcher:
    pages = {
        "https://www.mangaread.org/?s=regression&post_type=wp-manga": SEARCH_HTML,
        "https://www.mangaread.org/?s=class&post_type=wp-manga": SEARCH_HTML,
        "https://www.mangaread.org/manga/absolute-regression/": DETAILS_HTML,
    }

    def get(self, url):
        if url not in self.pages:
            raise ConnectionError("not found")
        return self.pages[url], url


def call(server, tool, args):
    async def run():
        async with Client(server) as client:
            res = await client.call_tool(tool, args)
            assert not res.is_error, res.content
            return res.structured_content
    return asyncio.run(run())


def make_server(db):
    return build_server(library=SqliteLibrary(db), sites=[MADARA], fetcher=FakeFetcher())


def test_tools_are_listed_with_annotations(library_db):
    async def run():
        async with Client(make_server(library_db)) as client:
            return {t.name: t for t in (await client.list_tools()).tools}
    tools = asyncio.run(run())
    assert set(tools) == {"my_library", "whats_new", "search_comics", "comic_details", "find_by_theme", "mark_read"}
    assert tools["whats_new"].annotations.read_only_hint is True
    assert tools["mark_read"].annotations.read_only_hint is False


def test_library_and_whats_new(library_db):
    lib = call(make_server(library_db), "my_library", {"show": "unread"})
    assert {c["title"] for c in lib["comics"]} == {"Nano Machine", "Infinite Titles"}
    new = call(make_server(library_db), "whats_new", {})
    assert [c["title"] for c in new["comics"]] == ["Infinite Titles", "Nano Machine"]
    assert new["comics"][1]["unread_chapters"] == 7


def test_search_marks_library_titles(library_db):
    res = call(make_server(library_db), "search_comics", {"query": "regression"})
    flags = {r["title"]: r["in_library"] for r in res["results"]}
    assert flags == {"Absolute Regression": None, "Solo Leveling": "Solo Leveling"}
    assert res["sites"]["MangaRead"].startswith("ok")


def test_find_by_theme_ranks_and_reads_pages(library_db):
    res = call(make_server(library_db), "find_by_theme", {"keywords": ["regression", "class"]})
    assert res["already_in_library"] == ["Solo Leveling"]
    top = res["candidates"][0]
    assert top["title"] == "Absolute Regression"
    assert top["matched_keywords"] == ["regression", "class"]
    assert "class skill" in top["description"] and top["rating_out_of_5"] == 4.6


def test_mark_read_writes_progress(library_db):
    res = call(make_server(library_db), "mark_read", {"title": "nano machine", "chapter": "335"})
    assert res == {"title": "Nano Machine", "before": "Chapter 330", "after": "Chapter 335", "latest": "Chapter 337"}
    assert next(c for c in SqliteLibrary(library_db).comics() if c.title == "Nano Machine").read == "Chapter 335"
    bad = call(make_server(library_db), "mark_read", {"title": "Nobody Knows", "chapter": "3"})
    assert "error" in bad and bad["closest"]
