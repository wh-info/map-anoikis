"""Build data/wh-statics.json from anoik.is.

Anoik.is publishes everything as one JSON file at /static/static.json.
Each system entry already has a `statics` array. We download once, filter
out Thera and Drifter systems, and write our own copy. From that point on
the project serves statics from data/wh-statics.json — anoik.is is no
longer needed at runtime and never hit by browsers.

Schema (locked in, wandering-ready):
    {
      "J114700": { "static": ["Z060"] },
      "J113551": { "static": ["C247", "N766"] },
      ...
    }

When wandering data lands later, add a `wandering` key alongside `static`
in each entry. No migration of existing entries needed.

Run:
    python build/build_statics.py
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

ROOT   = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "data" / "wh-statics.json"

ANOIK_URL = "https://anoik.is/static/static.json?version=11"
USER_AGENT = "map-anoikis-build/0.1 (https://map.anoikis.info)"

# Class identifiers as used in anoik.is's static.json. Excluded systems get
# no entry at all in our output.
EXCLUDED_CLASSES = {
    "thera",
    "barbican",
    "conflux",
    "redoubt",
    "sentinel",
    "vidette",
}


def fetch_anoik() -> dict:
    req = urllib.request.Request(ANOIK_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> None:
    print(f"Fetching {ANOIK_URL}")
    data = fetch_anoik()
    systems = data["systems"]
    print(f"  loaded {len(systems)} systems from anoik.is")

    out: dict[str, dict] = {}
    skipped_class: dict[str, int] = {}
    for name, sys in systems.items():
        cls = sys.get("wormholeClass")
        if cls in EXCLUDED_CLASSES:
            skipped_class[cls] = skipped_class.get(cls, 0) + 1
            continue
        statics = sys.get("statics") or []
        if not statics:
            continue
        out[name] = {"static": list(statics)}

    # Sort keys for deterministic git diffs.
    out_sorted = {k: out[k] for k in sorted(out)}

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT, "w", encoding="utf-8") as fh:
        json.dump(out_sorted, fh, indent=2, sort_keys=False)
        fh.write("\n")

    print(f"Wrote {len(out_sorted)} systems -> {OUTPUT.relative_to(ROOT)}")
    if skipped_class:
        print(f"  skipped by class: {skipped_class}")


if __name__ == "__main__":
    main()
