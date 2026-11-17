"""library_merge: desktop ↔ Supabase merge rules.  Run: python -m unittest discover tests"""
import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import library_merge as lm  # noqa: E402

NOW = datetime.datetime(2026, 10, 24, 12, 0)


def rec(**kw):
    base = {"English": "T", "Chapter": "Chapter 10", "Date": "01.10.2026",
            "Latest Chapter": "Chapter 20", "Latest Date": "16 Oct 2026",
            "Notes": "", "Rating": "", "Status": "Reading", "Favorite": ""}
    base.update(kw)
    return base


class ChapterAndDates(unittest.TestCase):
    def test_chapter_number(self):
        self.assertEqual(lm.chapter_number("Chapter 12.5"), 12.5)
        self.assertEqual(lm.chapter_number("Chapter 149The Red (5)"), 149)
        self.assertIsNone(lm.chapter_number("Unknown"))
        self.assertIsNone(lm.chapter_number(None))

    def test_absolute_formats(self):
        d = datetime.date(2026, 4, 16)
        for s in ("16 Apr 2026", "16 April 2026", "16.04.2026", "2026-04-16",
                  "2026-04-16 00:00:00", "April 16, 2026", "04/16/2026"):
            self.assertEqual(lm.parse_absolute_date(s), d, s)

    def test_relative_is_not_absolute(self):
        for s in ("2 days ago", "1 hour ago", "", None, "Unknown", "31.02.2026"):
            self.assertIsNone(lm.parse_absolute_date(s), s)

    def test_relative_to_absolute_keeps_the_time(self):
        utc = datetime.datetime(2026, 10, 24, 12, 0, tzinfo=datetime.timezone.utc)
        self.assertEqual(lm.relative_to_absolute("2 days ago", utc), "2026-10-22T12:00Z")
        self.assertEqual(lm.relative_to_absolute("6 hours ago", utc), "2026-10-24T06:00Z")
        self.assertEqual(lm.relative_to_absolute("10 mins ago", utc), "2026-10-24T11:50Z")
        self.assertEqual(lm.relative_to_absolute("a week ago", utc), "2026-10-17T12:00Z")
        self.assertEqual(lm.relative_to_absolute("Yesterday", utc), "2026-10-23T12:00Z")
        self.assertIsNone(lm.relative_to_absolute("16 Apr 2026", utc))

    def test_timestamps(self):
        self.assertTrue(lm.has_time("2026-10-26T13:05Z"))
        self.assertFalse(lm.has_time("26 Oct 2026"))
        self.assertFalse(lm.has_time("2026-10-26"))
        self.assertEqual(lm.parse_absolute_date("2026-10-26T13:05Z"), datetime.date(2026, 10, 26))


class MergeRecord(unittest.TestCase):
    def test_identical_records_change_nothing(self):
        self.assertEqual(lm.merge_record(rec(), rec()), {})

    def test_cloud_further_in_reading_wins_with_its_date(self):
        self.assertEqual(lm.merge_record(rec(), rec(**{"Chapter": "Chapter 14", "Date": "2026-10-23"})),
                         {"Chapter": "Chapter 14", "Date": "2026-10-23"})

    def test_local_further_in_reading_kept(self):
        self.assertEqual(lm.merge_record(rec(**{"Chapter": "Chapter 15"}), rec()), {})

    def test_cloud_newer_latest_chapter_wins_with_its_date(self):
        ch = lm.merge_record(rec(), rec(**{"Latest Chapter": "Chapter 21", "Latest Date": "22 Oct 2026"}))
        self.assertEqual(ch, {"Latest Chapter": "Chapter 21", "Latest Date": "22 Oct 2026"})

    def test_same_chapter_real_cloud_date_replaces_relative_local(self):
        # The Swordmaster case: desktop saved "1 hour ago" in July, phone saved the site's date.
        local = rec(**{"Latest Chapter": "Chapter 121", "Latest Date": "1 hour ago"})
        cloud = rec(**{"Latest Chapter": "Chapter 121", "Latest Date": "31 Jul 2026"})
        self.assertEqual(lm.merge_record(local, cloud), {"Latest Date": "31 Jul 2026"})

    def test_same_chapter_timestamp_replaces_plain_day(self):
        local = rec(**{"Latest Chapter": "Chapter 40", "Latest Date": "26 Oct 2026"})
        cloud = rec(**{"Latest Chapter": "Chapter 40", "Latest Date": "2026-10-26T13:05Z"})
        self.assertEqual(lm.merge_record(local, cloud), {"Latest Date": "2026-10-26T13:05Z"})

    def test_same_chapter_local_timestamp_kept(self):
        local = rec(**{"Latest Chapter": "Chapter 40", "Latest Date": "2026-10-26T13:05Z"})
        cloud = rec(**{"Latest Chapter": "Chapter 40", "Latest Date": "26 Oct 2026"})
        self.assertEqual(lm.merge_record(local, cloud), {})

    def test_same_chapter_real_local_date_kept(self):
        local = rec(**{"Latest Chapter": "Chapter 121", "Latest Date": "31 Jul 2026"})
        cloud = rec(**{"Latest Chapter": "Chapter 121", "Latest Date": "2 days ago"})
        self.assertEqual(lm.merge_record(local, cloud), {})

    def test_older_cloud_latest_never_downgrades(self):
        self.assertEqual(lm.merge_record(rec(), rec(**{"Latest Chapter": "Chapter 5", "Latest Date": "24 Oct 2026"})), {})

    def test_unnumbered_cloud_values_ignored(self):
        self.assertEqual(lm.merge_record(rec(), rec(**{"Latest Chapter": "Unknown", "Chapter": ""})), {})

    def test_empty_local_fields_filled_never_overwritten(self):
        ch = lm.merge_record(rec(**{"Notes": "", "Status": "Reading"}), rec(**{"Notes": "from phone", "Status": "Completed"}))
        self.assertEqual(ch, {"Notes": "from phone"})

    def test_rating_always_taken_from_cloud(self):
        # Only the phone sets the reader's rating: the cloud wins, even when it clears it.
        self.assertEqual(lm.merge_record(rec(Rating="8"), rec(Rating="3")), {"Rating": "3"})
        self.assertEqual(lm.merge_record(rec(Rating="4.5"), rec(Rating="")), {"Rating": ""})
        self.assertEqual(lm.merge_record(rec(Rating="4.5"), rec(Rating="4.5")), {})


class Ratings(unittest.TestCase):
    def test_scale_from_config(self):
        self.assertEqual(lm.rating_scale_for({"rating_scale": 10}), 10)
        self.assertEqual(lm.rating_scale_for({"rating_scale": "10"}), 10)
        self.assertEqual(lm.rating_scale_for({}), 5)
        self.assertEqual(lm.rating_scale_for(None), 5)

    def test_site_rating_normalised_to_five(self):
        self.assertEqual(lm.normalize_site_rating("9.7", 10), "4.9")      # Asura
        self.assertEqual(lm.normalize_site_rating("8.9", 10), "4.5")      # KingOfShojo
        self.assertEqual(lm.normalize_site_rating("4.5 out of 5 from 75 votes", 5), "4.5")  # ManhuaTop
        self.assertEqual(lm.normalize_site_rating("4.00", 5), "4")
        self.assertEqual(lm.normalize_site_rating("7", 5), "5")
        self.assertEqual(lm.normalize_site_rating("0", 5), "")
        self.assertEqual(lm.normalize_site_rating("N/A", 5), "")
        self.assertEqual(lm.normalize_site_rating("", 10), "")

    def test_legacy_split(self):
        # Within the site's scale: its average (also exact whole numbers).
        self.assertEqual(lm.migrate_legacy_rating("8.9", 10), ("", "4.5"))
        self.assertEqual(lm.migrate_legacy_rating("4.5", 5), ("", "4.5"))
        self.assertEqual(lm.migrate_legacy_rating("4", 5), ("", "4"))
        self.assertEqual(lm.migrate_legacy_rating("10", 10), ("", "5"))
        # Above it: an old 1–10 pick from the phone, halved.
        self.assertEqual(lm.migrate_legacy_rating("8", 5), ("4", None))
        self.assertEqual(lm.migrate_legacy_rating("7", 5), ("3.5", None))
        self.assertEqual(lm.migrate_legacy_rating("11", 10), ("", None))
        self.assertEqual(lm.migrate_legacy_rating("", 5), ("", None))
        self.assertEqual(lm.migrate_legacy_rating("N/A", 5), ("", None))

    def test_favorite_not_filled_from_phone_format(self):
        self.assertEqual(lm.merge_record(rec(**{"Favorite": ""}), rec(**{"Favorite": "0"})), {})


class PlanSync(unittest.TestCase):
    LIB = {f"C{i}" for i in range(50)}

    def test_first_sync_adds_but_never_deletes(self):
        p = lm.plan_sync({"A", "B"}, {"B", "C"}, None)
        self.assertEqual((p["add_local"], p["delete_cloud"], p["delete_local"]), ({"C"}, set(), set()))
        self.assertTrue(p["blocked"])

    def test_added_on_phone_comes_to_desktop(self):
        p = lm.plan_sync(self.LIB, self.LIB | {"Phone"}, self.LIB)
        self.assertEqual(p["add_local"], {"Phone"})
        self.assertFalse(p["delete_cloud"] or p["delete_local"])

    def test_deleted_here_is_deleted_from_cloud(self):
        p = lm.plan_sync(self.LIB - {"C1"}, self.LIB, self.LIB)
        self.assertEqual(p["delete_cloud"], {"C1"})
        self.assertFalse(p["add_local"])

    def test_deleted_elsewhere_is_deleted_here(self):
        p = lm.plan_sync(self.LIB, self.LIB - {"C2"}, self.LIB)
        self.assertEqual(p["delete_local"], {"C2"})

    def test_new_here_is_left_for_the_push(self):
        p = lm.plan_sync(self.LIB | {"Mine"}, self.LIB, self.LIB)
        self.assertFalse(p["delete_local"] or p["add_local"] or p["delete_cloud"])

    def test_empty_cloud_with_a_base_changes_nothing(self):
        p = lm.plan_sync(self.LIB, set(), self.LIB)
        self.assertEqual((p["add_local"], p["delete_cloud"], p["delete_local"]), (set(), set(), set()))
        self.assertTrue(p["blocked"])

    def test_empty_local_library_restores_never_deletes_cloud(self):
        small = {"A", "B", "C"}  # below the mass-deletion limit
        p = lm.plan_sync(set(), small, small)
        self.assertEqual((p["add_local"], p["delete_cloud"]), (small, set()))
        self.assertTrue(p["blocked"])

    def test_mass_local_deletion_is_blocked(self):
        p = lm.plan_sync(self.LIB, {f"C{i}" for i in range(30)}, self.LIB)  # 20 missing > limit 10
        self.assertEqual(p["delete_local"], set())
        self.assertTrue(p["blocked"])

    def test_deletions_within_limit_go_ahead(self):
        p = lm.plan_sync(self.LIB, {f"C{i}" for i in range(42)}, self.LIB)  # 8 missing ≤ 10
        self.assertEqual(len(p["delete_local"]), 8)

    def test_deletion_limit(self):
        self.assertEqual(lm.deletion_limit(7), 5)
        self.assertEqual(lm.deletion_limit(280), 56)


if __name__ == "__main__":
    unittest.main()
