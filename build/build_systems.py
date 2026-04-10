"""Build data/anoikis-systems.js from the EVE SDE SQLite dump.

Reads a locally decompressed Fuzzwork SDE (build/sde_cache/sqlite-latest.sqlite)
and emits a browser-loadable JS global containing every Anoikis system with:

    { id, name, region, constellation, class, effect, x, y, r }

Coordinates are projected 2D by dropping SDE Y and scaling SDE X/Z into a
compact frame the mockup's camera fits automatically.

Run:
    python build/build_systems.py
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SDE_PATH = ROOT / "build" / "sde_cache" / "sqlite-latest.sqlite"
OUTPUT = ROOT / "data" / "anoikis-systems.js"

# Anoikis region range (wspace). ADR / VR / Pochven are deliberately excluded.
WSPACE_REGION_MIN = 11000000
WSPACE_REGION_MAX = 11999999

# mapLocationWormholeClasses.wormholeClassID -> canonical label.
# IDs 14..18 are the five Drifter systems at system level; the K-R00033
# region row is bogus (marked class 1) and must be ignored.
WH_CLASS_LABEL = {
    1: "C1", 2: "C2", 3: "C3", 4: "C4", 5: "C5", 6: "C6",
    12: "Thera",
    13: "C13",
    14: "Drifter",  # Sentinel
    15: "Drifter",  # Barbican
    16: "Drifter",  # Vidette
    17: "Drifter",  # Conflux
    18: "Drifter",  # Redoubt
}

# invTypes.typeID of secondary-sun (group 995) entries -> effect label.
EFFECT_BY_TYPEID = {
    30574: "Magnetar",
    30575: "Black Hole",
    30576: "Red Giant",
    30577: "Pulsar",
    30669: "Wolf-Rayet",
    30670: "Cataclysmic Variable",
}

# Target visual frame — matches roughly what the Phase 2b extract produced
# so camera fit / zoom feel stay consistent.
FRAME_WIDTH = 1000.0
FRAME_CENTER = (4250.0, 4500.0)
DEFAULT_RADIUS = 2.5


def load_rows(con: sqlite3.Connection) -> list[dict]:
    """Pull every wspace system with its region, constellation, class, and effect."""
    sql = """
    SELECT
        s.solarSystemID      AS id,
        s.solarSystemName    AS name,
        r.regionName         AS region,
        c.constellationName  AS constellation,
        s.x                  AS sx,
        s.z                  AS sz,
        sys_w.wormholeClassID AS sys_class,
        reg_w.wormholeClassID AS reg_class,
        eff_t.typeID          AS effect_type
    FROM mapSolarSystems s
    JOIN mapRegions r        ON r.regionID        = s.regionID
    JOIN mapConstellations c ON c.constellationID = s.constellationID
    LEFT JOIN mapLocationWormholeClasses sys_w ON sys_w.locationID = s.solarSystemID
    LEFT JOIN mapLocationWormholeClasses reg_w ON reg_w.locationID = s.regionID
    LEFT JOIN mapDenormalize eff ON eff.solarSystemID = s.solarSystemID AND eff.groupID = 995
    LEFT JOIN invTypes      eff_t ON eff_t.typeID = eff.typeID
    WHERE s.regionID BETWEEN ? AND ?
    ORDER BY s.solarSystemID
    """
    rows = []
    for row in con.execute(sql, (WSPACE_REGION_MIN, WSPACE_REGION_MAX)):
        rows.append({
            "id": row[0],
            "name": row[1],
            "region": row[2],
            "constellation": row[3],
            "sx": row[4],
            "sz": row[5],
            "sys_class": row[6],
            "reg_class": row[7],
            "effect_type": row[8],
        })
    return rows


def classify(row: dict) -> str | None:
    """Prefer the per-system class override; fall back to region class."""
    cid = row["sys_class"]
    if cid is None:
        cid = row["reg_class"]
    return WH_CLASS_LABEL.get(cid)


def project(rows: list[dict]) -> None:
    """Scale SDE X/Z into the target visual frame in-place as x/y fields."""
    xs = [r["sx"] for r in rows]
    zs = [r["sz"] for r in rows]
    min_x, max_x = min(xs), max(xs)
    min_z, max_z = min(zs), max(zs)
    span = max(max_x - min_x, max_z - min_z)
    scale = FRAME_WIDTH / span if span else 1.0
    mid_x = (min_x + max_x) / 2.0
    mid_z = (min_z + max_z) / 2.0
    for r in rows:
        r["x"] = round((r["sx"] - mid_x) * scale + FRAME_CENTER[0], 3)
        # Flip Z so "up" in the SDE reads as "up" on screen.
        r["y"] = round(-(r["sz"] - mid_z) * scale + FRAME_CENTER[1], 3)


def transform(rows: list[dict]) -> list[dict]:
    out = []
    dropped = 0
    for row in rows:
        wh_class = classify(row)
        if wh_class is None:
            dropped += 1
            continue
        effect = EFFECT_BY_TYPEID.get(row["effect_type"])
        out.append({
            "id": row["id"],
            "name": row["name"],
            "region": row["region"],
            "constellation": row["constellation"],
            "class": wh_class,
            "effect": effect,
            "x": row["x"],
            "y": row["y"],
            "r": DEFAULT_RADIUS,
        })
    if dropped:
        print(f"warning: dropped {dropped} systems with no resolvable class")
    return out


def write_js(systems: list[dict]) -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(systems, separators=(",", ":"))
    header = (
        "// Auto-generated by build/build_systems.py\n"
        "// Real Anoikis system data extracted from the EVE SDE SQLite dump.\n"
    )
    OUTPUT.write_text(f"{header}window.ANOIKIS_SYSTEMS = {payload};\n", encoding="utf-8")
    kb = len(payload.encode("utf-8")) // 1024
    print(f"wrote {OUTPUT} ({kb} KB, {len(systems)} systems)")


def main() -> None:
    if not SDE_PATH.exists():
        raise SystemExit(f"SDE not found at {SDE_PATH} — decompress the .bz2 first")
    con = sqlite3.connect(SDE_PATH)
    try:
        rows = load_rows(con)
    finally:
        con.close()
    project(rows)
    systems = transform(rows)
    with_effect = sum(1 for s in systems if s["effect"])
    print(f"loaded {len(rows)} wspace systems, kept {len(systems)}, "
          f"{with_effect} carry an effect")
    write_js(systems)


if __name__ == "__main__":
    main()
