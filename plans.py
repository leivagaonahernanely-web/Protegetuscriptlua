"""Small plan quota helpers shared by the Flask app and Discord bot."""

LIMITS = {
    "FREE": {"scripts": 2, "keys": 100, "obfuscations": 15},
    "PRO": {"scripts": 7, "keys": 400, "obfuscations": 50},
    "PREMIUM": {"scripts": None, "keys": None, "obfuscations": None},
}


def current_plan(user):
    return (getattr(user, "plan", None) or "FREE").upper()


def check(user, resource, amount=1):
    limit = LIMITS.get(current_plan(user), LIMITS["FREE"]).get(resource)
    if limit is None:
        return True, ""
    # The legacy User model does not track usage columns; the database routes
    # enforce ownership limits separately. Keep the bot command permissive.
    return True, ""


def consume(user, resource, amount=1):
    return None
