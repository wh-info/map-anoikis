"""Patch data/type-kinds.js with window.TYPE_META from the SQLite SDE.

Reads build/sde_cache/sqlite-latest.sqlite (Fuzzwork format) and appends or
replaces the window.TYPE_META line in data/type-kinds.js.

Run:
    py build/patch_type_meta.py
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

ROOT    = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "build" / "sde_cache" / "sqlite-latest.sqlite"
OUT_JS  = ROOT / "data" / "type-kinds.js"

# metaGroupID -> badge label (ships only)
META_BADGE: dict[int, str] = {
    2:  "t2",
    4:  "faction",
    14: "t3",
    15: "t3",
}

SHIP_CATEGORY = 6


def main() -> None:
    if not DB_PATH.exists():
        raise SystemExit(f"Missing {DB_PATH}")
    if not OUT_JS.exists():
        raise SystemExit(f"Missing {OUT_JS} — run build_types.py first")

    conn = sqlite3.connect(DB_PATH)
    cur  = conn.cursor()

    # Ships that are published + have a relevant metaGroupID
    placeholders = ",".join("?" * len(META_BADGE))
    cur.execute(
        f"""
        SELECT t.typeID, mt.metaGroupID
        FROM   invTypes      AS t
        JOIN   invGroups     AS g  ON g.groupID     = t.groupID
        JOIN   invMetaTypes  AS mt ON mt.typeID      = t.typeID
        WHERE  g.categoryID = ?
          AND  t.published  = 1
          AND  mt.metaGroupID IN ({placeholders})
        """,
        (SHIP_CATEGORY, *META_BADGE.keys()),
    )
    rows = cur.fetchall()
    conn.close()

    meta: dict[int, str] = {}
    for type_id, mg_id in rows:
        badge = META_BADGE.get(mg_id)
        if badge:
            meta[type_id] = badge

    # Count by badge type
    from collections import Counter
    counts = Counter(meta.values())
    for label, n in sorted(counts.items()):
        print(f"  {label:<10} {n:>5}")
    print(f"total {len(meta)} tech-tier types")

    meta_payload = json.dumps(meta, separators=(",", ":"))
    new_line = f"window.TYPE_META  = {meta_payload};\n"

    text = OUT_JS.read_text(encoding="utf-8")

    if "window.TYPE_META" in text:
        text = re.sub(r"window\.TYPE_META\s*=.*;\n?", new_line, text)
        print("replaced existing window.TYPE_META line")
    else:
        text = text.rstrip("\n") + "\n" + new_line
        print("appended window.TYPE_META line")

    OUT_JS.write_text(text, encoding="utf-8")
    kb = len(OUT_JS.read_bytes()) // 1024
    print(f"wrote {OUT_JS} ({kb} KB)")


if __name__ == "__main__":
    main()
