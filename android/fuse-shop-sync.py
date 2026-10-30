#!/usr/bin/env python3
"""Fuse Shop sync: mirror the F-Droid repository catalog into the shop's own
index file (~/cosmo-ui/shop-index.json) in the Fuse Shop schema, with direct
APK and icon links into the F-Droid repo. Only apps with an x86_64-runnable
APK are listed (this box's Android is x86_64; arm-only apps cannot run).
Run weekly by cron or by hand; --cached reuses the last downloaded index."""
import io, json, os, sys, urllib.request

OUT = "/home/cosmo/cosmo-ui/shop-index.json"
CACHE = "/home/cosmo/fuse-shop/index-v2.json"
SOURCES = [
    "https://f-droid.org/repo/index-v2.json",
    "https://mirror.cyberbits.eu/fdroid/repo/index-v2.json",
    "https://ftp.fau.de/fdroid/repo/index-v2.json",
]
REPO = "https://f-droid.org/repo/"

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "FuseShopSync/1.0", "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=600) as r:
        data = r.read()
        if r.headers.get("Content-Encoding") == "gzip" or data[:2] == b"\x1f\x8b":
            import gzip
            data = gzip.decompress(data)
    return data

def loc(field):
    if isinstance(field, dict):
        return field.get("en-US") or field.get("en") or (next(iter(field.values())) if field else "")
    return field or ""

def x86_ok(nativecode):
    if not nativecode:
        return True
    return "x86_64" in nativecode or "x86" in nativecode

# Curation (2026-10-28): the shop stocks apps a person would use -
# productivity, games, media, everyday tools. Apps whose job is the Android
# system itself do not belong here: home-screen launchers, keyboards/IMEs,
# wallpapers, app managers, shells and terminals, root/system tweakers.
DROP_CATS = {"Launcher", "Keyboard & IME", "Wallpaper", "App Manager"}
DROP_WORDS = ["termux", "terminal", "shell", "launcher", "xposed", "magisk", "root"]

def curated_out(name, pkg, cats):
    if DROP_CATS.intersection(cats):
        return "category"
    text = (name + " " + pkg).lower()
    for w in DROP_WORDS:
        if w in text:
            return "keyword:" + w
    return ""

def main():
    raw = None
    if "--cached" in sys.argv and os.path.exists(CACHE):
        raw = open(CACHE, "rb").read()
    else:
        for url in SOURCES:
            try:
                print("trying", url, flush=True)
                raw = fetch(url)
                break
            except Exception as e:
                print("failed:", e, flush=True)
    if not raw:
        print("ERROR: no source worked")
        return 1
    idx = json.loads(raw.decode("utf-8"))
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    with open(CACHE, "wb") as f:
        f.write(raw)
    packs_root = idx.get("packages") or {}
    out_apps = []
    catcount = {}
    skipped_abi = 0
    skipped_cur = {}
    for pkg, entry in packs_root.items():
        meta = entry.get("metadata") or {}
        versions = entry.get("versions") or {}
        if not versions:
            continue
        cands = []
        for v in versions.values():
            man = v.get("manifest") or {}
            fn = (v.get("file") or {}).get("name")
            if not fn:
                continue
            cands.append((int(man.get("versionCode") or 0), str(man.get("versionName") or ""), fn, man.get("nativecode")))
        if not cands:
            continue
        ok = [c for c in cands if x86_ok(c[3])]
        if not ok:
            skipped_abi += 1
            continue
        ok.sort(key=lambda c: -c[0])
        vc, vname, apk_name, _nc = ok[0]
        name = loc(meta.get("name")).strip()
        if not name:
            continue
        cats_pre = [c for c in (meta.get("categories") or []) if isinstance(c, str)]
        why = curated_out(name, pkg, cats_pre)
        if why:
            skipped_cur[why] = skipped_cur.get(why, 0) + 1
            continue
        icon = ""
        ic = meta.get("icon")
        if isinstance(ic, dict):
            en = ic.get("en-US") or (next(iter(ic.values())) if ic else None)
            if isinstance(en, dict) and en.get("name"):
                icon = REPO + en["name"].lstrip("/")
        cats = [c for c in (meta.get("categories") or []) if isinstance(c, str)]
        for c in cats:
            catcount[c] = catcount.get(c, 0) + 1
        out_apps.append({
            "name": name,
            "package": pkg,
            "version": vname,
            "description": (loc(meta.get("summary")) or "").strip()[:180],
            "icon": icon,
            "apk": REPO + apk_name.lstrip("/"),
            "cats": cats,
            "updated": int(meta.get("lastUpdated") or 0),
        })
    out_apps.sort(key=lambda a: -a["updated"])
    for a in out_apps:
        del a["updated"]
    cats = [c for c, _ in sorted(catcount.items(), key=lambda kv: -kv[1])[:24]]
    doc = {"name": "Fuse Shop", "source": "F-Droid repository", "cats": cats, "apps": out_apps}
    tmp = OUT + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    os.replace(tmp, OUT)
    print(f"wrote {len(out_apps)} apps ({skipped_abi} arm-only skipped, curated out {sum(skipped_cur.values())}: {skipped_cur}), {len(cats)} categories -> {OUT}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
