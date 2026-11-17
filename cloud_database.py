"""
cloud_database.py
-----------------
Handles all communication with Supabase:
  - User authentication (register, login, logout)
  - Session persistence (keep user logged in across app restarts)
  - Username / profile management
  - Library sync  (push local SQLite → Supabase)
  - Pull from cloud (download library when local DB is empty)
  - Scraper config fetch
"""

import os
import re
import json
import logging
from typing import Optional

from dotenv import load_dotenv
load_dotenv()

from supabase import create_client, Client
from email_validator import validate_email

log = logging.getLogger("MangaTracker")

# ── Credentials (loaded from .env — never hardcode these) ────────────────────
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    import warnings
    warnings.warn(
        "SUPABASE_URL or SUPABASE_KEY is not set. "
        "Create a .env file in the project root with these values.",
        RuntimeWarning,
        stacklevel=2,
    )

# ── Session file (so user stays logged in after closing the app) ───────────────
SESSION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".session.json")

_client: Optional[Client]  = None
_current_user              = None
_current_session           = None
_current_username: str     = ""


# ── Client ────────────────────────────────────────────────────────────────────
def get_client() -> Client:
    global _client
    if _client is None:
        _client = create_client(SUPABASE_URL, SUPABASE_KEY)
    return _client


# ── Session persistence ───────────────────────────────────────────────────────
def _save_session(session) -> None:
    try:
        with open(SESSION_FILE, "w") as f:
            json.dump({
                "access_token":  session.access_token,
                "refresh_token": session.refresh_token,
            }, f)
    except Exception as e:
        log.error(f"_save_session failed: {e}")


def _clear_session() -> None:
    if os.path.exists(SESSION_FILE):
        try:
            os.remove(SESSION_FILE)
        except Exception as e:
            log.error(f"_clear_session failed: {e}")


def _load_session() -> Optional[dict]:
    if not os.path.exists(SESSION_FILE):
        return None
    try:
        with open(SESSION_FILE, "r") as f:
            return json.load(f)
    except Exception as e:
        log.error(f"_load_session failed: {e}")
        return None


def get_oauth_url(provider: str) -> dict:
    """
    Returns the OAuth redirect URL for 'google' or 'facebook'.
    The user's browser is redirected to this URL, which opens the provider's
    login page. After auth, Supabase redirects back to /auth/confirm.
    """
    try:
        result = get_client().auth.sign_in_with_oauth({
            "provider": provider,
            "options": {
                "redirect_to": "http://127.0.0.1:59021/auth/confirm",
            },
        })
        return {"ok": True, "url": result.url}
    except Exception as e:
        log.error(f"get_oauth_url({provider}) failed: {e}")
        return {"ok": False, "msg": f"Could not start {provider.title()} login. Make sure it is enabled in Supabase."}


def exchange_code_for_session(auth_code: str) -> dict:
    """
    Exchange a PKCE authorization code (returned by Google/Facebook OAuth)
    for a full Supabase session. The Supabase client retains the PKCE
    code_verifier internally from the sign_in_with_oauth() call.
    """
    global _current_user, _current_session, _current_username
    if not auth_code:
        return {"ok": False, "msg": "Missing authorization code."}
    try:
        result = get_client().auth.exchange_code_for_session({"auth_code": auth_code})
        if result and result.user and result.session:
            _current_user    = result.user
            _current_session = result.session
            _save_session(result.session)
            _current_username = _fetch_username()
            log.info(f"OAuth code exchanged for {result.user.email}")
            return {"ok": True, "user": {
                "email":    result.user.email,
                "id":       str(result.user.id),
                "username": _current_username,
            }}
        return {"ok": False, "msg": "Code exchange returned no session. Please try signing in again."}
    except Exception as e:
        log.error(f"exchange_code_for_session failed: {e}")
        return {"ok": False, "msg": "OAuth sign-in failed. Please try again."}


def restore_session_from_tokens(access_token: str, refresh_token: str) -> dict:
    """
    Save a session received via the email confirmation callback (fragment flow).
    Called by /api/auth/callback after the user clicks the verification link.
    """
    global _current_user, _current_session, _current_username
    if not access_token or not refresh_token:
        return {"ok": False, "msg": "Missing tokens."}
    try:
        result = get_client().auth.set_session(access_token, refresh_token)
        if result and result.user:
            _current_user    = result.user
            _current_session = result.session
            _save_session(result.session)
            _current_username = _fetch_username()
            log.info(f"Session saved from callback for {result.user.email}")
            return {"ok": True, "user": {
                "email":    result.user.email,
                "id":       str(result.user.id),
                "username": _current_username,
            }}
        return {"ok": False, "msg": "Could not establish session."}
    except Exception as e:
        log.error(f"restore_session_from_tokens failed: {e}")
        return {"ok": False, "msg": "Verification failed. The link may have expired."}


def verify_otp(token_hash: str, type_: str = "signup") -> dict:
    """
    Handle PKCE-style email confirmation (token_hash + type in query string).
    Called by /api/auth/verify_otp.
    """
    global _current_user, _current_session, _current_username
    if not token_hash:
        return {"ok": False, "msg": "Missing verification token."}
    try:
        result = get_client().auth.verify_otp({"token_hash": token_hash, "type": type_})
        if result and result.user:
            _current_user    = result.user
            _current_session = result.session
            if result.session:
                _save_session(result.session)
            _current_username = _fetch_username()
            log.info(f"OTP verified for {result.user.email}")
            return {"ok": True, "user": {
                "email":    result.user.email,
                "id":       str(result.user.id),
                "username": _current_username,
            }}
        return {"ok": False, "msg": "Could not verify token."}
    except Exception as e:
        log.error(f"verify_otp failed: {e}")
        return {"ok": False, "msg": "Verification failed. The link may have expired or already been used."}


# ── Username helpers ──────────────────────────────────────────────────────────
def _validate_username(username: str) -> tuple[bool, str]:
    """Returns (True, "") or (False, reason)."""
    if not username or not username.strip():
        return False, "Please choose a username."
    u = username.strip().lower()
    if len(u) < 3:
        return False, "Username must be at least 3 characters."
    if len(u) > 20:
        return False, "Username must be at most 20 characters."
    if not re.match(r'^[a-z0-9_]+$', u):
        return False, "Username can only contain letters, numbers, and underscores."
    return True, ""


def _check_username_available(username: str) -> bool:
    """Returns True if the username is not already taken."""
    try:
        result = (get_client()
                  .table("profiles")
                  .select("username")
                  .eq("username", username.lower())
                  .execute())
        return len(result.data) == 0
    except Exception as e:
        log.warning(f"_check_username_available failed (allowing): {e}")
        return True   # permissive on error


def _email_from_username(username: str) -> str:
    """Look up email from profiles table by username. Returns '' if not found."""
    try:
        result = (get_client()
                  .table("profiles")
                  .select("email")
                  .eq("username", username.lower())
                  .execute())
        if result.data:
            return result.data[0].get("email", "")
    except Exception as e:
        log.warning(f"_email_from_username failed: {e}")
    return ""


def _fetch_username() -> str:
    """Fetch username from Supabase profiles for the current user."""
    user = get_current_user()
    if not user:
        return ""
    try:
        result = (get_client()
                  .table("profiles")
                  .select("username")
                  .eq("user_id", user["id"])
                  .execute())
        if result.data:
            return result.data[0].get("username", "")
    except Exception as e:
        log.warning(f"_fetch_username failed: {e}")
    return ""


# ── Public auth API ───────────────────────────────────────────────────────────
def restore_session() -> dict:
    """
    Called once at app startup. Silently logs the user back in using
    the tokens saved from their last session.
    Returns {"ok": True, "user": {...}} or {"ok": False, "msg": "..."}
    """
    global _current_user, _current_session, _current_username
    saved = _load_session()
    if not saved:
        return {"ok": False, "msg": "No saved session."}
    try:
        client = get_client()
        result = client.auth.set_session(saved["access_token"], saved["refresh_token"])
        if result and result.user:
            _current_user    = result.user
            _current_session = result.session
            _save_session(result.session)
            _current_username = _fetch_username()
            log.info(f"Session restored for {result.user.email} (@{_current_username})")
            return {"ok": True, "user": {
                "email":    result.user.email,
                "id":       str(result.user.id),
                "username": _current_username,
            }}
        _clear_session()
        return {"ok": False, "msg": "Session expired. Please log in again."}
    except Exception as e:
        log.warning(f"restore_session failed: {e}")
        _clear_session()
        return {"ok": False, "msg": "Session expired. Please log in again."}


def register(email: str, password: str, username: str = "") -> dict:
    """
    Create a new user account.
    Returns {"ok": True, "pending_username": str, "msg": "..."} or {"ok": False, "msg": "..."}

    NOTE: The Supabase profile (username) cannot be saved during registration when
    email confirmation is ON, because there is no authenticated session yet.
    The Flask route saves the pending username locally; it is pushed to Supabase
    on first login (see api_auth_login in manga_tracker_app.py).
    """
    # 1. Trusted email domain check
    valid, reason = validate_email(email)
    if not valid:
        return {"ok": False, "msg": reason}

    # 2. Password strength
    if len(password) < 8:
        return {"ok": False, "msg": "Password must be at least 8 characters."}

    # 3. Username format
    valid, reason = _validate_username(username)
    if not valid:
        return {"ok": False, "msg": reason}

    # 4. Username availability
    username_clean = username.strip().lower()
    if not _check_username_available(username_clean):
        return {"ok": False, "msg": "That username is already taken. Please choose another."}

    # 5. Create auth user
    try:
        result = get_client().auth.sign_up({"email": email, "password": password})
        if result.user:
            log.info(f"New user registered: {email} (@{username_clean})")
            return {
                "ok": True,
                "pending_username": username_clean,
                "msg": (
                    "Account created! Please check your email inbox "
                    "and click the verification link before logging in."
                ),
            }
        return {"ok": False, "msg": "Registration failed. Please try again."}
    except Exception as e:
        log.error(f"register failed for '{email}': {e}")
        if "already registered" in str(e).lower() or "already exists" in str(e).lower():
            return {"ok": False, "msg": "An account with this email already exists."}
        return {"ok": False, "msg": "Registration failed. Please try again."}


def create_profile(username: str) -> dict:
    """Create a Supabase profile for the current user. Must be called AFTER login."""
    global _current_username
    user = get_current_user()
    if not user:
        return {"ok": False, "msg": "Not logged in."}
    try:
        get_client().table("profiles").insert({
            "user_id":  user["id"],
            "username": username,
            "email":    user["email"],
        }).execute()
        _current_username = username
        log.info(f"Profile created for {user['email']}: @{username}")
        return {"ok": True}
    except Exception as e:
        log.error(f"create_profile failed: {e}")
        if "duplicate" in str(e).lower() or "unique" in str(e).lower():
            return {"ok": False, "msg": "Username conflict — please try a different one."}
        return {"ok": False, "msg": "Failed to save username. Please try again."}


def login(email_or_username: str, password: str) -> dict:
    """
    Sign in an existing user.
    Accepts either an email address or a username.
    Returns {"ok": True, "user": {...}} or {"ok": False, "msg": "..."}
    """
    global _current_user, _current_session, _current_username

    # Resolve username → email if the input has no '@'
    email = email_or_username.strip()
    if "@" not in email:
        resolved = _email_from_username(email)
        if not resolved:
            return {"ok": False, "msg": "Username not found. Please check your username or use your email address."}
        email = resolved

    try:
        result = get_client().auth.sign_in_with_password({"email": email, "password": password})
        if result.user and result.session:
            _current_user     = result.user
            _current_session  = result.session
            _save_session(result.session)
            _current_username = _fetch_username()
            log.info(f"User logged in: {email} (@{_current_username})")
            return {"ok": True, "user": {
                "email":    result.user.email,
                "id":       str(result.user.id),
                "username": _current_username,
            }}
        return {"ok": False, "msg": "Login failed. Please check your credentials."}
    except Exception as e:
        log.error(f"login failed for '{email}': {e}")
        err = str(e).lower()
        if "invalid login" in err or "invalid credentials" in err:
            return {"ok": False, "msg": "Incorrect email/username or password."}
        if "email not confirmed" in err:
            return {"ok": False, "msg": "Please verify your email first. Check your inbox for a verification link."}
        return {"ok": False, "msg": "Login failed. Please try again."}


def logout() -> dict:
    """Sign out and wipe the saved session."""
    global _current_user, _current_session, _current_username
    try:
        get_client().auth.sign_out()
    except Exception as e:
        log.warning(f"logout: sign_out call failed (ignoring): {e}")
    finally:
        _current_user     = None
        _current_session  = None
        _current_username = ""
        _clear_session()
    return {"ok": True}


def get_current_user() -> Optional[dict]:
    """Returns {"email": ..., "id": ..., "username": ...} or None."""
    if _current_user:
        return {
            "email":    _current_user.email,
            "id":       str(_current_user.id),
            "username": _current_username,
        }
    return None


# ── Sync ──────────────────────────────────────────────────────────────────────
def sync_to_cloud(records: list) -> dict:
    """
    Push the full local library to Supabase (local-is-master strategy).
    Skips gracefully if the library is empty (avoids overwriting cloud data).
    """
    user = get_current_user()
    if not user:
        return {"ok": False, "msg": "Not logged in."}

    rows = []
    for r in records:
        title = str(r.get("English", "")).strip()
        if not title:
            continue
        rows.append({
            "user_id":           user["id"],
            "title":             title,
            "manga_url":         str(r.get("Manga URL", "")),
            "cover_url":         str(r.get("Cover URL", "")),
            "chapter":           str(r.get("Chapter", "Chapter 0")),
            "last_read_date":    str(r.get("Date", "")),
            "latest_chapter":    str(r.get("Latest Chapter", "")),
            "latest_date":       str(r.get("Latest Date", "")),
            "genre":             str(r.get("Genre", "")),
            "author":            str(r.get("Author", "")),
            "description":       str(r.get("Description", "")),
            "rating":            str(r.get("Rating", "")),
            "alternative_names": str(r.get("Alternative Names", "")),
            "favorite":          str(r.get("Favorite", "")),
            "category":          str(r.get("Category", "")),
            "status":            str(r.get("Status", "")),
            "notes":             str(r.get("Notes", "")),
        })

    if not rows:
        return {"ok": True, "synced": 0}

    try:
        get_client().table("manga_library").upsert(
            rows, on_conflict="user_id,title"
        ).execute()
        log.info(f"Synced {len(rows)} entries to cloud for {user['email']}")
        return {"ok": True, "synced": len(rows)}
    except Exception as e:
        log.error(f"sync_to_cloud failed: {e}")
        return {"ok": False, "msg": "Cloud sync failed. Your local data is safe."}


def pull_from_cloud() -> list:
    """
    Download all manga records for the current user from Supabase.
    Called when the local database is empty (e.g., after reinstalling the app).
    Returns a list of dicts in the same format as DataEngine.get_all().
    Falls back to [] on any failure.
    """
    records = pull_from_cloud_strict()
    return records if records is not None else []


def delete_from_cloud(title: str) -> bool:
    """Remove one title from the user's cloud library. True when the request
    went through (also when there was nothing to delete)."""
    user = get_current_user()
    if not user or not title:
        return False
    try:
        get_client().table("manga_library").delete().eq("user_id", user["id"]).eq("title", title).execute()
        log.info(f"Deleted '{title}' from cloud")
        return True
    except Exception as e:
        log.error(f"delete_from_cloud failed for '{title}': {e}")
        return False


def pull_from_cloud_strict():
    """Like pull_from_cloud, but None when the pull failed or nobody is
    signed in, so a sync never mistakes a failure for an empty cloud library."""
    user = get_current_user()
    if not user:
        return None
    try:
        result = (get_client()
                  .table("manga_library")
                  .select("*")
                  .eq("user_id", user["id"])
                  .execute())
        if not result.data:
            return []

        # Map Supabase column names → app dict keys
        records = []
        for r in result.data:
            records.append({
                "English":           r.get("title", ""),
                "Manga URL":         r.get("manga_url", ""),
                "Cover URL":         r.get("cover_url", ""),
                "Chapter":           r.get("chapter", "Chapter 0"),
                "Date":              r.get("last_read_date", ""),
                "Latest Chapter":    r.get("latest_chapter", ""),
                "Latest Date":       r.get("latest_date", ""),
                "Genre":             r.get("genre", ""),
                "Author":            r.get("author", ""),
                "Description":       r.get("description", ""),
                "Rating":            r.get("rating", ""),
                "Alternative Names": r.get("alternative_names", ""),
                "Favorite":          r.get("favorite", ""),
                "Category":          r.get("category", ""),
                "Status":            r.get("status", ""),
                "Notes":             r.get("notes", ""),
            })

        log.info(f"Pulled {len(records)} records from cloud for {user['email']}")
        return records
    except Exception as e:
        log.error(f"pull_from_cloud failed: {e}")
        return None


# ── Scraper config fetch ──────────────────────────────────────────────────────
def fetch_scraper_configs() -> list:
    """
    Download the latest scraper configs from Supabase.
    Falls back to [] — the app will use local JSON files instead.
    """
    try:
        result = (get_client()
                  .table("scraper_configs")
                  .select("website_name, json_rules")
                  .execute())
        if result.data:
            log.info(f"Fetched {len(result.data)} scraper configs from cloud.")
            return result.data
    except Exception as e:
        log.warning(f"fetch_scraper_configs failed (using local JSONs): {e}")
    return []

# ── Reading History Sync ──────────────────────────────────────────────────────
def sync_history_to_cloud(history_records: list) -> dict:
    user = get_current_user()
    if not user or not history_records:
        return {"ok": False}
    rows = []
    for r in history_records:
        rows.append({
            "user_id": user["id"],
            "manga_title": r["manga_title"],
            "chapter": r.get("chapter", ""),
            "date": r["date"]
        })
    try:
        get_client().table("reading_history").upsert(
            rows, on_conflict="user_id,manga_title,chapter,date"
        ).execute()
        return {"ok": True, "synced": len(rows)}
    except Exception as e:
        log.warning(f"sync_history_to_cloud failed (User may need to create table): {e}")
        return {"ok": False, "msg": str(e)}

def pull_history_from_cloud() -> list:
    user = get_current_user()
    if not user:
        return []
    try:
        res = get_client().table("reading_history").select("*").eq("user_id", user["id"]).execute()
        return res.data if res.data else []
    except Exception as e:
        log.warning(f"pull_history_from_cloud failed: {e}")
        return []
