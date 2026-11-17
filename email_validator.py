"""
email_validator.py
------------------
Validates email addresses during registration.
Only allows sign-ups from major, trusted email providers.
"""

# ── Allowlist of trusted email providers ──────────────────────────────────────
TRUSTED_DOMAINS = {
    "gmail.com", "googlemail.com",
    "hotmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.de",
    "outlook.com", "outlook.co.uk", "outlook.fr", "outlook.de",
    "live.com", "live.co.uk", "live.fr", "live.com.au",
    "msn.com",
    "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.com.au",
    "protonmail.com", "protonmail.ch", "proton.me",
    "icloud.com", "me.com", "mac.com",
    "aol.com",
    "zoho.com",
    "tutanota.com", "tuta.io",
    "fastmail.com", "fastmail.fm",
}


def validate_email(email: str) -> tuple[bool, str]:
    """
    Validates an email address before sending it to Supabase.

    Returns:
        (True,  "")        if the email is from a trusted provider.
        (False, "reason")  if the email should be rejected.
    """
    if not email or not isinstance(email, str):
        return False, "Please enter an email address."

    email = email.strip().lower()

    if "@" not in email:
        return False, "That doesn't look like a valid email address."

    parts = email.split("@")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return False, "That doesn't look like a valid email address."

    domain = parts[1]

    if domain not in TRUSTED_DOMAINS:
        return False, (
            "Please sign up with a major email provider "
            "(Gmail, Outlook, Hotmail, Yahoo, Protonmail, iCloud, etc.)."
        )

    return True, ""
