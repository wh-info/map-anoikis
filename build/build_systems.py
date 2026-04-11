"""Build data/anoikis-systems.js from the EVE SDE JSONL files.

Reads mapSolarSystems.jsonl, mapRegions.jsonl, mapConstellations.jsonl, and
mapSecondarySuns.jsonl from build/sde_cache/ and emits a browser-loadable JS
global containing every Anoikis system with:

    { id, name, region, constellation, class, effect, x, y, r }

Coordinates are projected 2D by dropping SDE Y and scaling SDE X/Z into a
compact frame the camera fits automatically.

Run:
    python build/build_systems.py
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT      = Path(__file__).resolve().parent.parent
SDE_CACHE = ROOT / "build" / "sde_cache"
OUTPUT    = ROOT / "data" / "anoikis-systems.js"

WSPACE_REGION_MIN = 11000000
WSPACE_REGION_MAX = 11999999

# wormholeClassID → canonical label.
# IDs 14-18 are the five Drifter systems (per-system override).
# The K-R00033 region carries a bogus class 1 — system-level takes priority.
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

# Secondary sun typeID → wormhole effect label.
EFFECT_BY_TYPEID = {
    30574: "Magnetar",
    30575: "Black Hole",
    30576: "Red Giant",
    30577: "Pulsar",
    30669: "Wolf-Rayet",
    30670: "Cataclysmic Variable",
}

FRAME_WIDTH  = 1000.0
FRAME_CENTER = (4250.0, 4500.0)
DEFAULT_RADIUS = 2.5


def iter_jsonl(path: Path):
    """Yield (key, record) from a CCP SDE JSONL file."""
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            key = obj.get("_key")
            if "_value" in obj:
                record = obj["_value"]
            else:
                record = {k: v for k, v in obj.items() if k != "_key"}
            yield key, record


def en(name_field) -> str:
    """Extract the English string from a multilingual name object."""
    if isinstance(name_field, dict):
        return name_field.get("en") or ""
    return str(name_field) if name_field else ""


def load_lookups() -> tuple[dict, dict, dict]:
    """Return (regions, constellations, effects) lookup dicts."""
    # regionID → {name, wormholeClassID}
    regions: dict[int, dict] = {}
    for rid, rec in iter_jsonl(SDE_CACHE / "mapRegions.jsonl"):
        if rid is not None:
            regions[int(rid)] = {
                "name": en(rec.get("name")),
                "wormholeClassID": rec.get("wormholeClassID"),
            }

    # constellationID → name
    constellations: dict[int, str] = {}
    for cid, rec in iter_jsonl(SDE_CACHE / "mapConstellations.jsonl"):
        if cid is not None:
            constellations[int(cid)] = en(rec.get("name"))

    # solarSystemID → effect label
    effects: dict[int, str] = {}
    for _, rec in iter_jsonl(SDE_CACHE / "mapSecondarySuns.jsonl"):
        sid = rec.get("solarSystemID")
        tid = rec.get("typeID")
        if sid is not None and tid is not None:
            label = EFFECT_BY_TYPEID.get(int(tid))
            if label:
                effects[int(sid)] = label

    return regions, constellations, effects


def load_systems(regions: dict, constellations: dict, effects: dict) -> list[dict]:
    """Load every wspace solar system and attach region/constellation/effect."""
    required = [
        SDE_CACHE / "mapSolarSystems.jsonl",
        SDE_CACHE / "mapRegions.jsonl",
        SDE_CACHE / "mapConstellations.jsonl",
        SDE_CACHE / "mapSecondarySuns.jsonl",
    ]
    for p in required:
        if not p.exists():
            raise SystemExit(f"Missing {p} — extract from the SDE zip first")

    rows = []
    for sid, rec in iter_jsonl(SDE_CACHE / "mapSolarSystems.jsonl"):
        if sid is None:
            continue
        region_id = rec.get("regionID")
        if region_id is None:
            continue
        region_id = int(region_id)
        if not (WSPACE_REGION_MIN <= region_id <= WSPACE_REGION_MAX):
            continue

        region = regions.get(region_id, {})
        const_id = rec.get("constellationID")
        const_name = constellations.get(int(const_id)) if const_id else ""

        # wormholeClassID: system-level preferred, region-level fallback.
        sys_class = rec.get("wormholeClassID")
        reg_class = region.get("wormholeClassID")
        class_id  = sys_class if sys_class is not None else reg_class
        wh_class  = WH_CLASS_LABEL.get(class_id)

        pos = rec.get("position", {})
        rows.append({
            "id":            int(sid),
            "name":          en(rec.get("name")),
            "region":        region.get("name", ""),
            "constellation": const_name,
            "wh_class":      wh_class,
            "effect":        effects.get(int(sid)),
            "sx":            float(pos.get("x", 0)),
            "sz":            float(pos.get("z", 0)),
        })
    return rows


def project(rows: list[dict]) -> None:
    """Scale SDE X/Z into the target visual frame in-place."""
    xs = [r["sx"] for r in rows]
    zs = [r["sz"] for r in rows]
    min_x, max_x = min(xs), max(xs)
    min_z, max_z = min(zs), max(zs)
    span  = max(max_x - min_x, max_z - min_z)
    scale = FRAME_WIDTH / span if span else 1.0
    mid_x = (min_x + max_x) / 2.0
    mid_z = (min_z + max_z) / 2.0
    for r in rows:
        r["x"] = round((r["sx"] - mid_x) * scale + FRAME_CENTER[0], 3)
        r["y"] = round(-(r["sz"] - mid_z) * scale + FRAME_CENTER[1], 3)


def transform(rows: list[dict]) -> list[dict]:
    out = []
    dropped = 0
    for row in rows:
        if row["wh_class"] is None:
            dropped += 1
            continue
        out.append({
            "id":            row["id"],
            "name":          row["name"],
            "region":        row["region"],
            "constellation": row["constellation"],
            "class":         row["wh_class"],
            "effect":        row["effect"],
            "x":             row["x"],
            "y":             row["y"],
            "r":             DEFAULT_RADIUS,
        })
    if dropped:
        print(f"warning: dropped {dropped} systems with no resolvable class")
    return out


def write_js(systems: list[dict]) -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(systems, separators=(",", ":"))
    OUTPUT.write_text(
        "// Auto-generated by build/build_systems.py\n"
        "// Anoikis system data from the EVE SDE JSONL.\n"
        f"window.ANOIKIS_SYSTEMS = {payload};\n",
        encoding="utf-8",
    )
    kb = len(payload.encode("utf-8")) // 1024
    print(f"wrote {OUTPUT} ({kb} KB, {len(systems)} systems)")


def main() -> None:
    regions, constellations, effects = load_lookups()
    rows = load_systems(regions, constellations, effects)
    project(rows)
    systems = transform(rows)
    with_effect = sum(1 for s in systems if s["effect"])
    print(f"loaded {len(rows)} wspace systems, kept {len(systems)}, "
          f"{with_effect} carry an effect")
    write_js(systems)


if __name__ == "__main__":
    main()
