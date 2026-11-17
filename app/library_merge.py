"""Merge rules for syncing the desktop library with Supabase.

The desktop used to push its whole library on every launch ("local is
master"), which rolled back what the phone app had written to the cloud:
newer latest chapters, their real release dates, and reading progress. Neither
side keeps edit timestamps, so the merge uses values that only move forward:

  * reading progress (`Chapter` + `Date`): the higher chapter number wins,
    and its read date comes with it;
  * latest release (`Latest Chapter` + `Latest Date`): the higher chapter wins
    with its date; for the same chapter a real date beats a relative one
    ("1 hour ago", which says nothing about when it was saved) or an empty one,
    and a timestamp ("2026-10-26T13:05Z") beats a plain day;
  * the reader's rating (`Rating`): only the phone app sets it, so the cloud's
    value always wins here, an empty one included;
  * every other field keeps the local value and is only filled in from the
    cloud when empty locally.

Records use the desktop's dict keys (DataEngine._to_dict / pull_from_cloud).
Standard library only, so it can be tested without the app's dependencies.

Ratings (same rules as the phone app's services/rating.ts, keep in step):
`Rating` is the reader's own, 0.1 … 5 with one decimal; `Site Rating` is the
site's average brought onto the same 5-point scale with the site's
`rating_scale` (5 unless its config says 10), kept locally and never synced.
"""

import datetime
import re

_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# Fields where the cloud may fill an empty local value (never overwrite).
# Not "Favorite": the phone writes it as "0"/"1", the desktop as "Yes"/"",
# so a cloud "0" would read as set here.
FILL_IF_EMPTY = (
    "Manga URL", "Cover URL", "Genre", "Author", "Description",
    "Alternative Names", "Category", "Status", "Notes",
)

# Fields only the phone app edits: the cloud's value is taken as it is.
CLOUD_WINS = ("Rating",)

RATING_MAX = 5
_RATING_NUM_RE = re.compile(r"\d+(?:\.\d+)?")


def rating_scale_for(cfg):
    """10 when the site's config says so, otherwise 5."""
    try:
        return 10 if int((cfg or {}).get("rating_scale", 5)) == 10 else 5
    except (TypeError, ValueError):
        return 5


def format_rating(n):
    """2.5 → '2.5', 4.0 → '4', 4.75 → '4.8'."""
    r = round(float(n) + 1e-9, 1)
    return str(int(r)) if r == int(r) else str(r)


def normalize_site_rating(raw, scale):
    """A site's rating text on its scale → the 5-point value, or '' when there is no usable number."""
    m = _RATING_NUM_RE.search(str(raw or ""))
    if not m:
        return ""
    n = float(m.group(0))
    if n <= 0:
        return ""
    s = 10 if scale == 10 else 5
    return format_rating(min(RATING_MAX, n * RATING_MAX / s))


def migrate_legacy_rating(raw, scale):
    """One-time split of the old shared `rating` value → (rating, site_rating or None).

    This app re-wrote the column from the site on every refresh, so a value the
    site's scale allows is its average and moves to the site rating. Only a
    number above that scale (an "8" on a 5-star site) cannot be the site's: it
    is a pick from the phone's old 1–10 picker, halved onto the 5-point scale.
    """
    s = str(raw or "").strip()
    m = _RATING_NUM_RE.search(s)
    if not m:
        return "", None
    n = float(m.group(0))
    site_max = 10 if scale == 10 else 5
    if n > site_max:
        return (format_rating(n / 2), None) if n <= 10 else ("", None)
    return "", normalize_site_rating(s, scale)

_CH_RE = re.compile(r"(?:chapter|chap|ch|episode|ep)\.?\s*#?\s*(\d+(?:\.\d+)?)", re.I)
_NUM_RE = re.compile(r"(\d+(?:\.\d+)?)")
_REL_RE = re.compile(
    r"^(\d+|an?|one)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mos?|years?|yrs?|y)\s+ago$",
    re.I,
)


def chapter_number(value):
    """12.5 for "Chapter 12.5", None when there is no number."""
    s = str(value or "")
    m = _CH_RE.search(s) or _NUM_RE.search(s)
    return float(m.group(1)) if m else None


def _month(name):
    key = name[:3].title()
    return _MONTHS.index(key) + 1 if key in _MONTHS else None


def parse_absolute_date(value):
    """datetime.date for an absolute date in any format the library holds, else None.

    "16 Apr 2026", "16.04.2026", "2026-04-16", "2023-03-02 00:00:00",
    "April 16, 2026", "04/16/2026". Relative values ("2 days ago") return None.
    """
    s = " ".join(str(value or "").split())
    if not s:
        return None
    try:
        m = re.match(r"^(\d{1,2}) ([A-Za-z]{3,9})\.?,? (\d{4})$", s)
        if m and _month(m.group(2)):
            return datetime.date(int(m.group(3)), _month(m.group(2)), int(m.group(1)))
        m = re.match(r"^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$", s)
        if m and _month(m.group(1)):
            return datetime.date(int(m.group(3)), _month(m.group(1)), int(m.group(2)))
        m = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})$", s)
        if m:
            return datetime.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
        if m:
            return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", s)
        if m:
            return datetime.date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
    except ValueError:
        return None
    return None


_ISO_TIME_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})")


def has_time(value):
    """True for a stored timestamp ('2026-10-26T13:05Z'), False for a plain day."""
    return bool(_ISO_TIME_RE.match(str(value or "").strip()))


def iso_minute(dt):
    """UTC timestamp to the minute, '2026-10-26T13:05Z'. Naive datetimes are local time."""
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def relative_to_absolute(value, now=None):
    """'6 hours ago' read at `now` → '2026-10-26T07:05Z'. None when not relative.

    A timestamp, not just a day: several chapters released the same day must
    still sort by time ("10 mins ago" above "6 hours ago").
    """
    s = " ".join(str(value or "").split()).lower()
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if s in ("just now", "now", "today"):
        return iso_minute(now)
    if s == "yesterday":
        return iso_minute(now - datetime.timedelta(days=1))
    m = _REL_RE.match(s)
    if not m:
        return None
    n = int(m.group(1)) if m.group(1).isdigit() else 1
    unit = m.group(2)
    if unit.startswith("sec"):
        delta = datetime.timedelta(seconds=n)
    elif unit.startswith("min"):
        delta = datetime.timedelta(minutes=n)
    elif unit.startswith("h"):
        delta = datetime.timedelta(hours=n)
    elif unit.startswith("d"):
        delta = datetime.timedelta(days=n)
    elif unit.startswith("w"):
        delta = datetime.timedelta(weeks=n)
    elif unit.startswith("mo"):
        delta = datetime.timedelta(days=30 * n)
    else:
        delta = datetime.timedelta(days=365 * n)
    return iso_minute(now - delta)


def format_day(d):
    """The desktop's display format, '16 Apr 2026'."""
    return f"{d.day:02d} {_MONTHS[d.month - 1]} {d.year}"


def _pick_pair(local, cloud, ch_key, date_key):
    """(chapter, date) from whichever side is further along; None when local stays."""
    lc, cc = chapter_number(local.get(ch_key)), chapter_number(cloud.get(ch_key))
    if cc is None:
        return None
    if lc is None or cc > lc:
        return cloud.get(ch_key) or "", cloud.get(date_key) or ""
    return None


def deletion_limit(size):
    """Most titles one sync may delete on one side: 5, or 20% of a big library."""
    return max(5, -(-size * 20 // 100))


def plan_sync(local_titles, cloud_titles, base_titles):
    """Which titles to add or delete so both sides agree, by title.

    `base_titles` is the set of titles the cloud held after this device's last
    sync (None before the first one). A title missing on one side is resolved
    by whether it was there last time:

      in cloud only, not in base  → added elsewhere        → add_local
      in cloud only, in base      → deleted on this device → delete_cloud
      local only, in base         → deleted elsewhere      → delete_local
      local only, not in base     → new here, not synced   → (pushed by the caller)

    Safety: no deletions on the first sync (no base), none when the cloud comes
    back empty while the base was not (a failed or wrong pull), none when the
    local library is empty (a restore), and none on a side where more than
    deletion_limit() titles would go. `blocked` lists why deletions were skipped.
    """
    local, cloud = set(local_titles), set(cloud_titles)
    blocked = []
    add_local = cloud - local
    delete_cloud, delete_local = set(), set()
    if base_titles is None:
        blocked.append("first sync on this device: nothing deleted")
    elif not cloud and base_titles:
        blocked.append("cloud returned no titles: nothing deleted or added")
        add_local = set()
    elif not local and base_titles:
        # A wiped or signed-out-and-back-in library is a restore, not a
        # request to delete everything from the cloud.
        blocked.append("local library is empty: restoring, nothing deleted")
    else:
        base = set(base_titles)
        add_local = (cloud - local) - base
        delete_cloud = (cloud - local) & base
        delete_local = (local - cloud) & base
        if len(delete_cloud) > deletion_limit(len(cloud)):
            blocked.append(f"{len(delete_cloud)} cloud deletions is too many: skipped")
            delete_cloud = set()
        if len(delete_local) > deletion_limit(len(local)):
            blocked.append(f"{len(delete_local)} local deletions is too many: skipped")
            delete_local = set()
    return {"add_local": add_local, "delete_cloud": delete_cloud,
            "delete_local": delete_local, "blocked": blocked}


def merge_record(local, cloud):
    """Fields to change in the local record so it also keeps the cloud's progress.

    Returns {} when the local record already holds everything worth keeping.
    """
    changes = {}

    progress = _pick_pair(local, cloud, "Chapter", "Date")
    if progress:
        changes["Chapter"], changes["Date"] = progress

    latest = _pick_pair(local, cloud, "Latest Chapter", "Latest Date")
    if latest:
        changes["Latest Chapter"], changes["Latest Date"] = latest
    else:
        same = (chapter_number(local.get("Latest Chapter")) is not None
                and chapter_number(local.get("Latest Chapter")) == chapter_number(cloud.get("Latest Chapter")))
        local_date = parse_absolute_date(local.get("Latest Date"))
        cloud_date = parse_absolute_date(cloud.get("Latest Date"))
        # Same chapter: a real date beats a relative/empty one, and a timestamp
        # beats a plain day (it keeps same-day releases in order).
        if same and cloud_date and (
                not local_date
                or (has_time(cloud.get("Latest Date")) and not has_time(local.get("Latest Date")))):
            changes["Latest Date"] = cloud.get("Latest Date")

    for key in FILL_IF_EMPTY:
        if not str(local.get(key) or "").strip() and str(cloud.get(key) or "").strip():
            changes[key] = cloud.get(key)
    for key in CLOUD_WINS:
        if str(cloud.get(key) or "").strip() != str(local.get(key) or "").strip():
            changes[key] = str(cloud.get(key) or "").strip()
    return changes
