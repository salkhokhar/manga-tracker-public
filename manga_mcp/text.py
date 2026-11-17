"""Small text helpers shared by the library and site code: chapter numbers,
title matching and rating scales. Standard library only."""

from __future__ import annotations

import re

_CHAPTER_RE = re.compile(r"(?:chapter|chap|ch|episode|ep)\.?\s*#?\s*(\d+(?:\.\d+)?)", re.I)
_NUMBER_RE = re.compile(r"(\d+(?:\.\d+)?)")
_STOPWORDS = {"the", "a", "an", "of", "in", "on", "to", "and", "is", "i", "my", "with", "for", "at"}

RATING_MAX = 5


def chapter_number(value: object) -> float | None:
    """12.5 for "Chapter 12.5", 40 for "40", None when there is no number."""
    s = str(value or "")
    m = _CHAPTER_RE.search(s) or _NUMBER_RE.search(s)
    return float(m.group(1)) if m else None


def format_chapter(value: object) -> str | None:
    """'Chapter 12' for 12, '12', 'ch 12' or 'Chapter 12'; None without a number."""
    n = chapter_number(value)
    if n is None:
        return None
    return f"Chapter {int(n)}" if n == int(n) else f"Chapter {n}"


def normalize_title(title: object) -> str:
    """Lowercase words only: 'The Hero Returns!' -> 'the hero returns'."""
    s = str(title or "").lower()
    s = re.sub(r"\s*[\[(].*?[\])]\s*", " ", s)
    return " ".join(re.findall(r"[a-z0-9]+", s))


def title_similarity(a: object, b: object) -> float:
    """Share of content words two titles have in common (0 to 1)."""
    ta = {t for t in normalize_title(a).split() if t not in _STOPWORDS}
    tb = {t for t in normalize_title(b).split() if t not in _STOPWORDS}
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


SAME_SERIES = 0.85


def split_names(raw: object) -> list[str]:
    """'A; B / C' -> ['A', 'B', 'C'] (how sites list alternative names)."""
    parts = re.split(r"[;|/,\n]+", str(raw or ""))
    return [p.strip() for p in parts if len(p.strip()) >= 3]


def normalize_rating(raw: object, scale: int) -> float | None:
    """A site's rating text on its own scale -> a 0-5 value with one decimal."""
    m = _NUMBER_RE.search(str(raw or ""))
    if not m:
        return None
    n = float(m.group(1))
    if n <= 0:
        return None
    s = 10 if scale == 10 else 5
    return round(min(RATING_MAX, n * RATING_MAX / s), 1)
