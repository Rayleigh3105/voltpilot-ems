#!/usr/bin/env python3
"""Package the box's view of the control profiles.

The profiles under profiles/ are the only authored truth. The Go core embeds a
deterministic derivative of them (edge-app/core/internal/controlprofile/
profiles.json) - its Docker build context is edge-app/core, so the file is
generated and checked in, like the Node-RED measurement catalog.

The derivative carries ONLY what the box reads today, and only for profiles the
box can find (a `bindung`): the binding, the damping timing and the day budget of
persistent writes. It carries no lever, no write sequence and nothing a
certificate would name - a profile never releases anything on the box.
A knowledge-only edit (sources, texts, unbound families) leaves it byte-identical.
"""

from __future__ import annotations

import argparse
from typing import Any

from profilelib import REPO, canonical_json_bytes, load_profiles

EDGE = REPO / "edge-app" / "core" / "internal" / "controlprofile" / "profiles.json"


def runtime_view(profiles: list[dict[str, Any]]) -> dict[str, Any]:
    out = []
    for p in sorted(profiles, key=lambda p: p["id"]):
        if not p["bindung"]:
            continue
        damp = p["daempfung"]
        out.append({
            "id": p["id"],
            "bindung": p["bindung"],
            "daempfung": {
                "box_regelt": damp["box_regelt"],
                "einschwingzeit_s": damp["einschwingzeit_s"],
                "messtakt_s": damp["messtakt_s"],
            },
            "schreibbudget": {"dauerspeicher_je_tag": p["schreibbudget"]["dauerspeicher_je_tag"]},
        })
    return {
        "schema_version": "1.0",
        "generated_by": "catalog/control-profiles/tools/package_edge_runtime.py - nicht von Hand ändern",
        "profile": out,
    }


def output() -> bytes:
    return canonical_json_bytes(runtime_view(load_profiles()))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the checked-in derivative is stale")
    args = parser.parse_args()
    raw = output()
    if args.check:
        if not EDGE.exists() or EDGE.read_bytes() != raw:
            print(f"stale: {EDGE.relative_to(REPO)} - run catalog/control-profiles/tools/package_edge_runtime.py")
            return 1
        print(f"up to date: {EDGE.relative_to(REPO)}")
        return 0
    EDGE.parent.mkdir(parents=True, exist_ok=True)
    EDGE.write_bytes(raw)
    print(f"wrote {EDGE.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
