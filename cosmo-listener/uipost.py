"""Tiny bridge from the voice stack to the cosmo-ui screen.

Posts avatar state to the local board server (http://127.0.0.1:3180) so the
animation reflects what Cosmo is actually doing, with a real reference:
listening (and to what), working (on what), speaking (the words themselves).
Every call is best-effort with a short timeout - a down UI must never
disturb the voice path.
"""
import json
import urllib.request

UI = "http://127.0.0.1:3180"


def _req(method, path, payload=None, timeout=1.2):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(UI + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "{}")


def post(state, message=""):
    try:
        _req("POST", "/api/state", {"state": state, "message": message})
    except Exception:
        pass


def baseline():
    """The board's resting state: waiting if suggestions are open."""
    try:
        s = _req("GET", "/api/state", timeout=1.2)
        n = len([c for c in s.get("cards", [])
                 if c.get("kind") == "suggestion" and c.get("status") == "open"])
        if n:
            return "waiting", f"{n} thing{'s' if n != 1 else ''} need your voice"
        return "idle", "Watching over things"
    except Exception:
        return "idle", "Watching over things"


def post_baseline():
    state, message = baseline()
    post(state, message)
