"""Extract the type lookup tables for the kill feed from the EVE SDE JSONL.

Reads groups.jsonl and types.jsonl from build/sde_cache/ and produces:

  data/type-kinds.js
    window.SDE_BUILD_DATE = "2026-04-11 12:00 UTC"
    window.TYPE_NAMES  = { typeID: "Rifter", ... }
    window.TYPE_KINDS  = { typeID: "ship" | "structure" | "tower"
                                | "deployable" }
    window.TYPE_ICONS  = { typeID: "frigate" | "cruiser" | ... }   # ships only
    window.TYPE_GROUPS = { typeID: groupID }                       # SDE
                                                                   # group lookup
                                                                   # (e.g. 31 =
                                                                   # Shuttle)
    window.GROUP_ICONS = { groupID: "frigate" | ... }              # used by
                                                                   # the ESI
                                                                   # fallback
                                                                   # for new
                                                                   # ships

  backend/src/type-kinds.json
    { "kinds": { "<typeID>": "ship" | ... } }

Scope:
  - Ship       (category 6)   — includes capsules
  - Structure  (category 65)  — Citadels + other Upwell
  - POS        (category 23)  — Control Towers, batteries, silos, arrays
  - Deployable (category 22)
  - Fighter    (category 87)  — drone fighters from carriers/supers

Run:
    python build/build_types.py
"""

from __future__ import annotations

import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT      = Path(__file__).resolve().parent.parent
SDE_CACHE = ROOT / "build" / "sde_cache"
OUT_JS    = ROOT / "data" / "type-kinds.js"
OUT_JSON  = ROOT / "backend" / "src" / "type-kinds.json"

# (kind_label, (categoryID,) or (categoryID, groupID)) — disjoint sets.
KIND_RULES: list[tuple[str, int, int | None]] = [
    ("ship",        6,  None),
    ("structure",  65,  None),
    ("tower",      23,  None),
    ("deployable", 22,  None),
    ("fighter",    87,  None),
]

# metaGroupIDs we surface as tech-tier badges (ships only).
META_BADGE: dict[int, str] = {
    2:  "t2",
    4:  "faction",
    14: "t3",
    15: "t3",
}

# Ship groupID → icon slug (resolves to img/icons/<slug>_64.png on the
# frontend). Covers every groupID in category 6 that exists in the SDE
# today; new ship groups added by CCP will fall back to the frontend's
# ESI lookup which reuses this same mapping.
GROUP_ICON: dict[int, str] = {
    # Frigate-sized combat
    25:   "frigate",           # Frigate
    324:  "frigate",           # Assault Frigate
    830:  "frigate",           # Covert Ops
    831:  "frigate",           # Interceptor
    834:  "frigate",           # Stealth Bomber
    893:  "frigate",           # Electronic Attack Ship
    1527: "frigate",           # Logistics Frigate
    # Frigate-sized mining / starter
    1283: "miningfrigate",     # Expedition Frigate (Venture, Prospect, Endurance)
    237:  "rookie",            # Corvette
    2001: "rookie",            # Citizen Ships
    # Destroyer-sized
    420:  "destroyer",         # Destroyer
    541:  "destroyer",         # Interdictor
    1022: "destroyer",         # Prototype Exploration Ship (Sunesis)
    1305: "destroyer",         # Tactical Destroyer
    1534: "destroyer",         # Command Destroyer
    # Cruiser-sized
    26:   "cruiser",           # Cruiser
    358:  "cruiser",           # Heavy Assault Cruiser
    832:  "cruiser",           # Logistics
    833:  "cruiser",           # Force Recon Ship
    894:  "cruiser",           # Heavy Interdiction Cruiser
    906:  "cruiser",           # Combat Recon Ship
    963:  "cruiser",           # Strategic Cruiser
    1972: "cruiser",           # Flag Cruiser
    # Battlecruiser-sized
    419:  "battlecruiser",     # Combat Battlecruiser
    540:  "battlecruiser",     # Command Ship
    1201: "battlecruiser",     # Attack Battlecruiser
    # Battleship-sized
    27:   "battleship",        # Battleship
    381:  "battleship",        # Elite Battleship
    898:  "battleship",        # Black Ops
    900:  "battleship",        # Marauder
    # Capital
    485:  "capital",           # Dreadnought
    547:  "capital",           # Carrier
    883:  "capital",           # Capital Industrial Ship (Rorqual)
    1538: "capital",           # Force Auxiliary
    4594: "capital",           # Lancer Dreadnought
    # Super-capital (supers split by hull type: carrier vs titan)
    659:  "supercarrier",      # Supercarrier
    30:   "titan",             # Titan
    # Haulers
    28:   "industrial",        # Hauler
    380:  "industrial",        # Deep Space Transport
    1202: "industrial",        # Blockade Runner
    513:  "freighter",         # Freighter
    902:  "freighter",         # Jump Freighter
    941:  "industrialcommand", # Industrial Command Ship (Orca, Porpoise)
    4902: "industrialcommand", # Expedition Command Ship
    # Mining
    463:  "miningbarge",       # Mining Barge
    543:  "miningbarge",       # Exhumer
    # Misc
    29:   "capsule",           # Capsule
    31:   "shuttle",           # Shuttle
    5087: "shuttle",           # Special Edition Yachts
}


def iter_jsonl(path: Path):
    """Yield (key, record) from a CCP SDE JSONL file.

    Each line is a JSON object with a `_key` integer field. Other fields are
    either top-level (flat format) or nested under `_value` (keyed format).
    Both layouts are handled.
    """
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


def main() -> None:
    groups_path = SDE_CACHE / "groups.jsonl"
    types_path  = SDE_CACHE / "types.jsonl"
    for p in (groups_path, types_path):
        if not p.exists():
            raise SystemExit(f"Missing {p} — extract from the SDE zip first")

    # groupID → categoryID
    group_cat: dict[int, int] = {}
    for gid, rec in iter_jsonl(groups_path):
        if gid is not None:
            cat = rec.get("categoryID")
            if cat is not None:
                group_cat[gid] = int(cat)

    names:  dict[int, str] = {}
    kinds:  dict[int, str] = {}
    meta:   dict[int, str] = {}
    icons:  dict[int, str] = {}
    # typeID → groupID, for tracked types only. Frontend uses this for
    # ship-class filters that need authoritative SDE classification rather
    # than icon-slug heuristics — e.g. shuttle-only filters can check
    # `TYPE_GROUPS[typeId] === 31`. Only emitted to the frontend file; the
    # backend already has the kind bucket it needs in type-kinds.json.
    groups: dict[int, int] = {}
    unmapped_ship_groups: set[int] = set()
    counts: dict[str, int] = {k: 0 for k, *_ in KIND_RULES}

    for tid, rec in iter_jsonl(types_path):
        if tid is None or not rec.get("published", False):
            continue
        grp = rec.get("groupID")
        cat = group_cat.get(grp)
        if cat is None:
            continue
        for kind_label, req_cat, req_grp in KIND_RULES:
            if cat == req_cat and (req_grp is None or grp == req_grp):
                names[int(tid)] = en(rec.get("name"))
                kinds[int(tid)] = kind_label
                if grp is not None:
                    groups[int(tid)] = int(grp)
                counts[kind_label] += 1
                if kind_label == "ship":
                    mg = rec.get("metaGroupID")
                    if mg is not None:
                        badge = META_BADGE.get(int(mg))
                        if badge:
                            meta[int(tid)] = badge
                    slug = GROUP_ICON.get(int(grp)) if grp is not None else None
                    if slug:
                        icons[int(tid)] = slug
                    elif grp is not None:
                        unmapped_ship_groups.add(int(grp))
                break

    for kind_label, count in counts.items():
        print(f"  {kind_label:<11} {count:>5}")
    print(f"total {len(names)} types")

    build_date = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    # Fetch the current CCP build number to embed alongside the date.
    build_number: int | None = None
    try:
        with urllib.request.urlopen(
            "https://developers.eveonline.com/static-data/tranquility/latest.jsonl",
            timeout=10,
        ) as resp:
            obj = json.loads(resp.read().decode("utf-8"))
            build_number = obj.get("buildNumber")
    except Exception as exc:
        print(f"warning: could not fetch remote build number: {exc}")

    OUT_JS.parent.mkdir(parents=True, exist_ok=True)
    names_payload  = json.dumps(names, separators=(",", ":"))
    kinds_payload  = json.dumps(kinds, separators=(",", ":"))
    meta_payload   = json.dumps(meta,  separators=(",", ":"))
    icons_payload  = json.dumps(icons, separators=(",", ":"))
    types_groups_payload = json.dumps(groups, separators=(",", ":"))
    groups_payload = json.dumps(
        {str(k): v for k, v in GROUP_ICON.items()}, separators=(",", ":")
    )
    print(f"  tech badges  {len(meta):>5}")
    print(f"  ship icons   {len(icons):>5}")
    print(f"  type groups  {len(groups):>5}")
    if unmapped_ship_groups:
        missing = ", ".join(str(g) for g in sorted(unmapped_ship_groups))
        print(f"  WARNING: ship groups with no icon mapping: {missing}")
    OUT_JS.write_text(
        "// Auto-generated by build/build_types.py\n"
        "// typeID -> name, kind, tech-tier badge, icon slug, and groupID,\n"
        "// used by the kill feed and intel filters. GROUP_ICONS is the\n"
        "// same groupID -> slug mapping, exposed so the frontend's ESI\n"
        "// fallback can resolve icons for ships added after the last SDE\n"
        "// build. TYPE_GROUPS gives authoritative SDE group classification\n"
        "// for filters that need it (e.g. shuttle-only check via group 31).\n"
        f"window.SDE_BUILD_DATE = {json.dumps(build_date)};\n"
        f"window.SDE_BUILD_NUMBER = {json.dumps(build_number)};\n"
        f"window.TYPE_NAMES  = {names_payload};\n"
        f"window.TYPE_KINDS  = {kinds_payload};\n"
        f"window.TYPE_META   = {meta_payload};\n"
        f"window.TYPE_ICONS  = {icons_payload};\n"
        f"window.TYPE_GROUPS = {types_groups_payload};\n"
        f"window.GROUP_ICONS = {groups_payload};\n",
        encoding="utf-8",
    )

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(
        json.dumps({
            "kinds": {str(k): v for k, v in kinds.items()},
            "names": {str(k): v for k, v in names.items()},
        }, separators=(",", ":")),
        encoding="utf-8",
    )
    js_kb   = len(OUT_JS.read_bytes())   // 1024
    json_kb = len(OUT_JSON.read_bytes()) // 1024
    print(f"wrote {OUT_JS} ({js_kb} KB)")
    print(f"wrote {OUT_JSON} ({json_kb} KB)")


if __name__ == "__main__":
    main()
