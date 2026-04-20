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
import math
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


def load_lookups() -> tuple[dict, dict, dict, dict, dict, dict]:
    """Return regions, constellations, effects, planets, star_type, star_info lookups."""
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

    # planetID → {typeId, r (AU), moons} — loaded from mapPlanets.jsonl if present.
    planets_by_id: dict[int, dict] = {}
    planet_xz:     dict[int, tuple[float, float]] = {}  # pid -> (x, z) for moon math
    planets_path = SDE_CACHE / "mapPlanets.jsonl"
    if planets_path.exists():
        AU = 1.496e11
        for pid, rec in iter_jsonl(planets_path):
            if pid is None:
                continue
            type_id = rec.get("typeID")
            if type_id is None:
                continue
            pos = rec.get("position") or {}
            px, py, pz = float(pos.get("x", 0)), float(pos.get("y", 0)), float(pos.get("z", 0))
            orbit_au = round(math.sqrt(px*px + py*py + pz*pz) / AU, 2)
            angle    = round(math.atan2(pz, px), 4)  # XZ plane, same projection as starmap
            ci       = rec.get("celestialIndex") or 0  # 1-based planet index (I, II, III…)
            moon_count = len(rec.get("moonIDs") or [])
            pid_i = int(pid)
            planets_by_id[pid_i] = {
                "typeId": type_id, "r": orbit_au, "a": angle,
                "ci": ci, "moons": moon_count,
            }
            if moon_count:
                planet_xz[pid_i] = (px, pz)

    # planetID → list of (orbit_radius_m, angle_rad) for each moon — SDE XZ projection.
    # Sorted inner-first at read time. Capped per planet when attached below.
    moons_by_planet: dict[int, list[tuple[float, float]]] = {}
    moons_path = SDE_CACHE / "mapMoons.jsonl"
    if moons_path.exists() and planet_xz:
        for _, rec in iter_jsonl(moons_path):
            ssid = rec.get("solarSystemID")
            if ssid is None or not (31000000 <= int(ssid) < 32000000):
                continue
            orbit_pid = rec.get("orbitID")
            if orbit_pid is None:
                continue
            pp = planet_xz.get(int(orbit_pid))
            if pp is None:
                continue
            mpos = rec.get("position") or {}
            mx, mz = float(mpos.get("x", 0)), float(mpos.get("z", 0))
            dx, dz = mx - pp[0], mz - pp[1]
            stats = rec.get("statistics") or {}
            orbit_r = float(stats.get("orbitRadius") or (dx*dx + dz*dz) ** 0.5)
            angle   = math.atan2(dz, dx)
            moons_by_planet.setdefault(int(orbit_pid), []).append((orbit_r, angle))

    # Attach capped angle lists to each planet (inner 6, sorted by orbit radius).
    for pid_i, moon_list in moons_by_planet.items():
        moon_list.sort(key=lambda t: t[0])
        planets_by_id[pid_i]["mA"] = [round(a, 3) for _, a in moon_list[:6]]

    # solarSystemID → star typeID / star statistics — loaded from mapStars.jsonl if present.
    star_type_by_system: dict[int, int] = {}
    star_info_by_system: dict[int, dict] = {}
    stars_path = SDE_CACHE / "mapStars.jsonl"
    if stars_path.exists():
        for _, rec in iter_jsonl(stars_path):
            sid = rec.get("solarSystemID")
            tid = rec.get("typeID")
            if sid is None:
                continue
            sid_i = int(sid)
            if tid is not None:
                star_type_by_system[sid_i] = int(tid)
            stats = rec.get("statistics") or {}
            radius = rec.get("radius")
            if stats or radius is not None:
                star_info_by_system[sid_i] = {
                    "spectralClass": stats.get("spectralClass"),
                    "luminosity":    stats.get("luminosity"),
                    "age":           stats.get("age"),        # seconds
                    "temperature":   stats.get("temperature"),
                    "radius":        radius,                  # meters
                }

    return regions, constellations, effects, planets_by_id, star_type_by_system, star_info_by_system


def load_systems(
    regions: dict,
    constellations: dict,
    effects: dict,
    planets_by_id: dict,
    star_type_by_system: dict,
    star_info_by_system: dict,
) -> list[dict]:
    """Load every wspace solar system and attach region/constellation/effect/planets."""
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
        sys_id = int(sid)

        # Planets: look up each planetID in the pre-built planet dict.
        planets = []
        for pid in (rec.get("planetIDs") or []):
            p_data = planets_by_id.get(int(pid))
            if p_data:
                planets.append(p_data)
        planets.sort(key=lambda p: p["r"])

        rows.append({
            "id":            sys_id,
            "name":          en(rec.get("name")),
            "region":        region.get("name", ""),
            "constellation": const_name,
            "wh_class":      wh_class,
            "effect":        effects.get(sys_id),
            "sx":            float(pos.get("x", 0)),
            "sz":            float(pos.get("z", 0)),
            "sun_type_id":   star_type_by_system.get(sys_id),
            "sun_info":      star_info_by_system.get(sys_id),
            "planets":       planets,
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
            "sunTypeId":     row.get("sun_type_id"),
            "sun":           row.get("sun_info"),
            "planets":       row.get("planets", []),
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


OUT_NAMES = ROOT / "backend" / "src" / "system-names.json"


def write_names_json(systems: list[dict]) -> None:
    """Emit a tiny {systemId: {name, class}} JSON for the backend stats."""
    lookup = {
        str(s["id"]): {"name": s["name"], "class": s["class"]}
        for s in systems
    }
    OUT_NAMES.parent.mkdir(parents=True, exist_ok=True)
    OUT_NAMES.write_text(
        json.dumps(lookup, separators=(",", ":")), encoding="utf-8",
    )
    kb = len(OUT_NAMES.read_bytes()) // 1024
    print(f"wrote {OUT_NAMES} ({kb} KB, {len(lookup)} systems)")


def main() -> None:
    (regions, constellations, effects, planets_by_id,
     star_type_by_system, star_info_by_system) = load_lookups()
    rows = load_systems(
        regions, constellations, effects,
        planets_by_id, star_type_by_system, star_info_by_system,
    )
    project(rows)
    systems = transform(rows)
    with_effect = sum(1 for s in systems if s["effect"])
    print(f"loaded {len(rows)} wspace systems, kept {len(systems)}, "
          f"{with_effect} carry an effect")
    write_js(systems)
    write_names_json(systems)


if __name__ == "__main__":
    main()
