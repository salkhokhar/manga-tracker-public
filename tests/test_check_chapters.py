"""utils/check_chapters.py page parsing and decisions.  Run: python -m unittest discover tests"""
import datetime
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "utils"))
sys.path.insert(0, ROOT)
import check_chapters as cc  # noqa: E402

NOW = datetime.datetime(2026, 10, 24, 12, 0, tzinfo=datetime.timezone.utc)
S = "https://www.mangaread.org/manga/becoming-the-swordmaster-rank-young-lord-of-the-sichuan-tang-family/"


def row(n, date):  # markup as served by mangaread.org on 2026-10-24
    return (f'<li class="wp-manga-chapter    "> <a href="{S}chapter-{n}/"> Chapter {n} </a> '
            f'<span class="chapter-release-date"> <i>{date}</i> </span> </li>')


def page(*rows):
    return "<ul class='main version-chap'>" + "".join(rows) + "</ul>"


class FakeSession:
    """has_pages() fetches chapter pages: answer from a dict of url -> html."""
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def get(self, url, timeout=None):
        self.calls.append(url)
        html = self.pages.get(url)
        r = type("R", (), {})()
        r.ok, r.text, r.url = html is not None, html or "", url
        return r


class MadaraRows(unittest.TestCase):
    def test_dates_absolute_and_relative(self):
        rows = cc.madara_rows(page(row(279, "2 days ago"), row(278, "11.10.2026")), NOW)
        self.assertEqual([(n, d) for n, _, d in rows], [(279, "2026-10-22T12:00Z"), (278, "11 Oct 2026")])

    def test_new_tag_title_attribute(self):
        html = (f'<li class="wp-manga-chapter new-chap"><a href="{S}chapter-40/">Chapter 40</a>'
                f'<span class="chapter-release-date"><a href="{S}chapter-40/" title="5 hours ago" class="c-new-tag">'
                f'<img src="x"></a></span></li>')
        self.assertEqual(cc.madara_rows(html, NOW)[0][2], "2026-10-24T07:00Z")


class CheckMadara(unittest.TestCase):
    def test_up_to_date_needs_no_page_fetch(self):
        s = FakeSession({})
        self.assertEqual(cc.check_madara(s, page(row(121, "31.07.2026")), 121, NOW), (121, "31 Jul 2026"))
        self.assertEqual(s.calls, [])

    def test_newer_chapter_with_pages(self):
        s = FakeSession({f"{S}chapter-122/": '<img class="wp-manga-chapter-img">'})
        self.assertEqual(cc.check_madara(s, page(row(122, "1 day ago"), row(121, "31.07.2026")), 121, NOW)[0], 122)

    def test_phantom_falls_back_to_previous(self):
        s = FakeSession({f"{S}chapter-122/": "<p>no images yet</p>"})
        self.assertEqual(cc.check_madara(s, page(row(122, "1 day ago"), row(121, "31.07.2026")), 121, NOW), (121, "31 Jul 2026"))

    def test_unreachable_chapter_page_changes_nothing(self):
        self.assertIsNone(cc.check_madara(FakeSession({}), page(row(122, "1 day ago"), row(121, "x")), 121, NOW))


class Asura(unittest.TestCase):
    URL = "https://asurascans.com/comics/the-regressed-son-of-a-duke-is-an-assassin-11fe7da3"

    def test_skips_early_access(self):
        obj = lambda n, p: f'{{"id":[0,1],"series_id":[0,7],"number":[0,{n}],"slug":[0,"c"],"is_premium":[0,{p}]}}'
        html = (f'<astro-island props="{obj(151, "true")},{obj(150, "false")}"></astro-island>'
                f'<a href="{self.URL}/chapter/151">Chapter 151</a>'
                f'<a href="{self.URL}/chapter/150">Chapter 150</a>').replace('"', "&quot;").replace("<a href=&quot;", '<a href="').replace("&quot;>", '">')
        self.assertEqual(cc.asura_latest_unlocked(html, self.URL), 150)

    def test_stale_series_id_still_matches(self):
        old = "https://asurascans.com/comics/the-regressed-son-of-a-duke-is-an-assassin-89829cb7"
        html = f'<a href="{self.URL}/chapter/150">Chapter 150</a>'
        self.assertEqual(cc.asura_latest_unlocked(html, old), 150)


class PlanRowDates(unittest.TestCase):
    """plan_row's date rules, with the series page served by FakeSession."""
    def plan(self, stored_ch, stored_date, rows_html, chapter_pages=None):
        pages = {S: page(rows_html)}
        pages.update(chapter_pages or {})
        row = {"manga_url": S, "latest_chapter": stored_ch, "latest_date": stored_date}
        return cc.plan_row(FakeSession(pages), row, NOW)

    def test_same_day_upgraded_to_timestamp(self):
        ch, why = self.plan("Chapter 40", "24 Oct 2026", row(40, "6 hours ago"))
        self.assertEqual((ch, why), ({"latest_date": "2026-10-24T06:00Z"}, "date corrected"))

    def test_existing_timestamp_kept(self):
        ch, why = self.plan("Chapter 40", "2026-10-24T05:58Z", row(40, "6 hours ago"))
        self.assertEqual((ch, why), ({}, "up to date"))

    def test_dated_same_chapter_unchanged(self):
        self.assertEqual(self.plan("Chapter 121", "31 Jul 2026", row(121, "31.07.2026"))[0], {})

    def test_new_chapter_gets_its_timestamp(self):
        ch, _ = self.plan("Chapter 39", "21 Oct 2026", row(40, "10 mins ago"),
                          {f"{S}chapter-40/": '<img class="wp-manga-chapter-img">'})
        self.assertEqual(ch, {"latest_chapter": "Chapter 40", "latest_date": "2026-10-24T11:50Z"})


class FormatChapter(unittest.TestCase):
    def test_whole_and_half(self):
        self.assertEqual(cc.fmt_chapter(150.0), "Chapter 150")
        self.assertEqual(cc.fmt_chapter(12.5), "Chapter 12.5")


if __name__ == "__main__":
    unittest.main()
