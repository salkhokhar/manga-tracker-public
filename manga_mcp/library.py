"""The reading library: which comics you follow, how far you have read, and
the newest chapter each site has.

Two backends, picked from the environment by `library_from_env()`:

* Supabase (the cloud copy the desktop and phone apps sync to):
  SUPABASE_URL, SUPABASE_SECRET_KEY and MANGA_USER_ID. The secret key
  bypasses row-level security, so every query here is filtered to
  MANGA_USER_ID. It stays on your machine, in the MCP client's config.
* A local SQLite file from the desktop app: MANGA_DB=path/to/local_library.db.
"""

from __future__ import annotations

import datetime
import json
import os
import sqlite3
from dataclasses import dataclass

from .text import chapter_number

FIELDS = ("title", "manga_url", "chapter", "latest_chapter", "latest_date",
          "last_read_date", "status", "category", "genre", "rating",
          "alternative_names", "linked_sources", "favorite", "notes")


@dataclass
class Comic:
    title: str
    url: str
    read: str
    latest: str
    latest_date: str
    last_read_date: str
    status: str
    category: str
    genres: str
    your_rating: str
    alternative_names: str
    other_sources: list[str]
    favorite: bool
    notes: str

    @property
    def unread(self) -> int | None:
        """Chapters between the last read and the newest, when both are numbered."""
        r, l = chapter_number(self.read), chapter_number(self.latest)
        if l is None:
            return None
        return max(0, int(l - (r or 0)))

    def as_dict(self) -> dict:
        d = {
            "title": self.title, "url": self.url,
            "last_read": self.read or None, "latest": self.latest or None,
            "unread_chapters": self.unread, "latest_released": self.latest_date or None,
            "status": self.status or None, "category": self.category or None,
        }
        if self.genres:
            d["genres"] = self.genres
        if self.your_rating:
            d["your_rating"] = self.your_rating
        if self.other_sources:
            d["other_sources"] = self.other_sources
        if self.favorite:
            d["favorite"] = True
        if self.notes:
            d["notes"] = self.notes
        return d


def _linked_urls(raw: object) -> list[str]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "[]")
        except ValueError:
            return []
    if not isinstance(raw, list):
        return []
    return [s["manga_url"] for s in raw if isinstance(s, dict) and isinstance(s.get("manga_url"), str)]


def _to_comic(row: dict) -> Comic:
    g = lambda k: str(row.get(k) or "").strip()
    fav = str(row.get("favorite") or "").strip().lower() in ("1", "yes", "true")
    return Comic(
        title=g("title"), url=g("manga_url"), read=g("chapter"), latest=g("latest_chapter"),
        latest_date=g("latest_date"), last_read_date=g("last_read_date"), status=g("status"),
        category=g("category"), genres=g("genre"), your_rating=g("rating"),
        alternative_names=g("alternative_names"), other_sources=_linked_urls(row.get("linked_sources")),
        favorite=fav, notes=g("notes"),
    )


class SupabaseLibrary:
    def __init__(self, url: str, key: str, user_id: str, session=None):
        import requests
        self.api = url.rstrip("/") + "/rest/v1/manga_library"
        self.user_id = user_id
        self.session = session or requests.Session()
        self.headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    def comics(self) -> list[Comic]:
        r = self.session.get(self.api, headers=self.headers, timeout=30, params={
            "select": ",".join(FIELDS), "user_id": f"eq.{self.user_id}", "order": "title",
        })
        r.raise_for_status()
        return [_to_comic(row) for row in r.json() if row.get("title")]

    def set_progress(self, title: str, chapter: str) -> None:
        r = self.session.patch(
            self.api, timeout=30,
            headers={**self.headers, "Prefer": "return=representation"},
            params={"user_id": f"eq.{self.user_id}", "title": f"eq.{title}"},
            json={"chapter": chapter, "last_read_date": datetime.date.today().isoformat()},
        )
        r.raise_for_status()
        if not r.json():
            raise LookupError(f'"{title}" is not in the library')


class SqliteLibrary:
    def __init__(self, path: str):
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def comics(self) -> list[Comic]:
        with self._connect() as conn:
            have = {r[1] for r in conn.execute("PRAGMA table_info(manga)")}
            cols = [c for c in FIELDS if c in have]
            rows = conn.execute(f"SELECT {', '.join(cols)} FROM manga ORDER BY title").fetchall()
        return [_to_comic(dict(r)) for r in rows if r["title"]]

    def set_progress(self, title: str, chapter: str) -> None:
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE manga SET chapter = ?, last_read_date = ? WHERE title = ?",
                (chapter, datetime.date.today().isoformat(), title),
            )
            if cur.rowcount == 0:
                raise LookupError(f'"{title}" is not in the library')


def library_from_env():
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SECRET_KEY", "")
    user = os.environ.get("MANGA_USER_ID", "")
    if url and key and user:
        return SupabaseLibrary(url, key, user)
    path = os.environ.get("MANGA_DB", "")
    if path:
        return SqliteLibrary(path)
    return None
