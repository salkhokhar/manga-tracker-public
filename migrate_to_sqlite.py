"""
migrate_to_sqlite.py
--------------------
One-time migration script. Run this ONCE to convert your existing
Manga_images.xlsx into the new local_library.db SQLite database.

Usage:
    python migrate_to_sqlite.py

It is completely safe to run multiple times — it uses INSERT OR IGNORE
so it will never create duplicate entries.
"""

import os
import sqlite3
import pandas as pd

EXCEL_FILE = "Manga_images.xlsx"
DB_FILE    = "local_library.db"

# ── Column mapping: Excel column name → SQLite column name ───────────────────
COL_MAP = {
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
    "Alternative Names": "alternative_names",
    "Favorite":          "favorite",
    "Category":          "category",
    "Status":            "status",
}

CREATE_TABLE_SQL = """
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
        status            TEXT DEFAULT ''
    )
"""

INSERT_SQL = """
    INSERT OR REPLACE INTO manga (
        title, manga_url, cover_url, chapter, last_read_date,
        latest_chapter, latest_date, genre, author, description,
        rating, alternative_names, favorite, category, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""

def get(row, excel_col, fallback=""):
    """Safely read a cell from the dataframe row, returning fallback if missing."""
    val = row.get(excel_col, fallback)
    cleaned = str(val).strip()
    return "" if cleaned in ("", "nan", "None") else cleaned


def migrate():
    if not os.path.exists(EXCEL_FILE):
        print(f"ERROR: '{EXCEL_FILE}' not found. Please run this script from the "
              f"same folder as the Excel file.")
        return

    print(f"Reading '{EXCEL_FILE}'... (this may take a moment for large libraries)")
    try:
        df = pd.read_excel(EXCEL_FILE, dtype=str)
    except Exception as e:
        print(f"ERROR: Could not read Excel file: {e}")
        return

    df = df.fillna("").replace("nan", "")
    df = df[df["English"].astype(str).str.strip() != ""]
    total = len(df)
    print(f"Found {total} manga entries in Excel file.\n")

    conn   = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute(CREATE_TABLE_SQL)
    conn.commit()

    inserted = 0
    skipped  = 0

    for i, (_, row) in enumerate(df.iterrows(), 1):
        title = get(row, "English")
        if not title:
            skipped += 1
            continue

        try:
            cursor.execute(INSERT_SQL, (
                title,
                get(row, "Manga URL"),
                get(row, "Cover URL"),
                get(row, "Chapter", "Chapter 0"),
                get(row, "Date"),
                get(row, "Latest Chapter"),
                get(row, "Latest Date"),
                get(row, "Genre"),
                get(row, "Author"),
                get(row, "Description"),
                get(row, "Rating"),
                get(row, "Alternative Names"),
                get(row, "Favorite"),
                get(row, "Category"),
                get(row, "Status"),
            ))
            # cursor.rowcount == 0 means INSERT OR IGNORE skipped a duplicate
            if cursor.rowcount == 1:
                inserted += 1
            else:
                skipped += 1
        except Exception as e:
            print(f"  [ERROR] Row {i} '{title}': {e}")
            skipped += 1

        # Print progress every 50 rows
        if i % 50 == 0:
            print(f"  Processed {i}/{total}...")

    conn.commit()
    conn.close()

    print(f"\n{'='*50}")
    print(f"Migration complete!")
    print(f"  Total rows processed : {total}")
    print(f"  Inserted into SQLite  : {inserted}")
    print(f"  Skipped (duplicates)  : {skipped}")
    print(f"  Database file         : {DB_FILE}")
    print(f"{'='*50}")
    print(f"\nYou can now start the app with 'python manga_tracker_app.py'")
    print(f"Your original '{EXCEL_FILE}' has NOT been modified or deleted.")


if __name__ == "__main__":
    migrate()
