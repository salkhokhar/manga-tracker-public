# Manga Tracker MCP

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) work with a manga / manhwa reading library: what you are reading, what has new chapters, searching the sites you read on, and finding new series by theme.

Ask things like:

- "What came out since I last read?"
- "Find me a manhwa with regression and a class system that isn't in my library yet."
- "Is Return of the Mount Hua Sect on any other site?"
- "I just finished chapter 160 of The Indomitable Martial King, mark it."

It runs on your machine over stdio and reads the same library as the [Manga Tracker app](app/), a desktop and phone app that keeps that library in sync.

## Tools

| Tool | What it does | Touches the web |
|---|---|---|
| `my_library` | Your comics with progress; filter by unread, reading, completed, favorites, or a title search | No |
| `whats_new` | Comics with chapters you have not read, newest release first | No |
| `search_comics` | Title search on every supported site, marking results already in your library | Yes |
| `comic_details` | A comic's page: description, genres, status, alternative names, rating out of 5, newest chapter | Yes |
| `find_by_theme` | Searches every site for several keywords, merges the same comic found on several sites, ranks by keywords matched, and returns each candidate's description and genres | Yes |
| `mark_read` | Records the last chapter you read | Writes your library |

Every tool except `mark_read` is read-only, and is marked so for the client.

### How theme search works

The sites have no reliable tags for themes like "regression" or "class system": MangaRead has neither as a genre, and KingOfShojo filters by numeric IDs. So `find_by_theme` searches titles for each keyword and synonym on every site, then reads each candidate's page. Claude judges the fit from the descriptions and genres instead of trusting the title. Comics already in your library are left out unless asked for.

A live run with `["regression", "regressor", "class", "system"]` against a 300-comic library finished in about 15 seconds. It found 183 titles across the sites, set aside 22 the library already had, and returned candidates such as *Dragonslayer's Class Regression* and *SSS-Class Regressor Has No Conscience* with their descriptions.

## Setup

Requires Python 3.10 or newer.

```bash
git clone https://github.com/salkhokhar/manga-tracker-public
cd manga-tracker-public
pip install -e .
```

Then point it at a library, using one of these:

| Library | Environment variables |
|---|---|
| The app's cloud library (Supabase) | `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `MANGA_USER_ID` |
| The desktop app's local file | `MANGA_DB=/path/to/local_library.db` |
| None | Site tools still work; library tools say how to configure one |

`MANGA_USER_ID` is your user's ID in Supabase (Authentication, Users). The secret key bypasses Supabase's row-level security, so the server filters every query to that user ID. It stays on your machine, in your MCP client's config; never commit it.

### Claude Code

```bash
claude mcp add manga-tracker -e SUPABASE_URL=https://<project>.supabase.co -e SUPABASE_SECRET_KEY=sb_secret_... -e MANGA_USER_ID=<uuid> -- manga-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "manga-tracker": {
      "command": "manga-mcp",
      "env": {
        "SUPABASE_URL": "https://<project>.supabase.co",
        "SUPABASE_SECRET_KEY": "sb_secret_...",
        "MANGA_USER_ID": "<uuid>"
      }
    }
  }
}
```

## Sites

Sites are described by the JSON scraper configs in [`app/scrapers/`](app/scrapers/), the same ones the app uses: search URL, CSS selectors for result cards, the comic page and the chapter list, and whether ratings are out of 5 or 10. Ratings are always returned out of 5. Adding a site means adding a config; set `MANGA_SCRAPERS_DIR` to use configs from elsewhere.

What works without a browser today:

| Site | Search and details |
|---|---|
| MangaRead, KingOfShojo, ManhuaTop, Arena Scans, Toonily, Webtoons | Yes |
| Asura Scans | Skipped: it only renders in a real browser (the phone app opens it in one) |
| Manga Clash | Fails while the site's HTTPS certificate is invalid |

Every site tool reports per site whether it worked, so one site being down never fails a whole search.

## Tests

```bash
pip install -e ".[test]"
pytest
```

The tests parse saved HTML and drive every tool through an in-process MCP client with a fake fetcher, so they need no network or library.

## The app

[`app/`](app/) holds the Manga Tracker app this server grew out of:

- **Desktop**: a Flask app with a web UI and site scrapers (`app/manga_tracker_app.py`, `app/web/`).
- **Phone**: an Expo / React Native app (`app/mobile_app/`) that reads sites in hidden WebViews, merges one comic's chapters from several sites, and works offline with downloaded chapters.
- **Sync**: both sync a Supabase library both ways, and a scheduled job checks for new chapters every few hours.
