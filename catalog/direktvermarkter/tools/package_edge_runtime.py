#!/usr/bin/env python3
"""Package the box's view of the direct-marketer catalog (Direktvermarkter).

The profiles under profiles/ are the only authored truth. The Go core embeds
a deterministic derivative of them (edge-app/core/internal/direktvermarkter/
profiles.json) - its Docker build context is edge-app/core, so the file is
generated and checked in, like the measurement-point catalog and the control
profiles.

Unlike the control profiles, this derivative DOES carry the full register map
and the Modbus access settings: the box needs them to run the partner's
data-mirror server (vp-direktvermarktung-konzept d2, Stage 1). Since Stage 2
it also carries 'vorgabe_wirkt_auf' (regeln): composeCurtailment needs to
know whether the partner's set-point limits the feed-in at the connection
point (the provisional reading of F5, E2 = A) or the generation - a PV cap.
'referenz' (regeln) still stays out: the box receives the reference VALUE in
watts with its delivery (anschluss.json), and what that value means is the
delivering cloud's business, not the box's - adding it here before any code
reads it would just be dead weight, the same discipline the control profiles
already follow.

Two fields are still genuinely open with luox (section 11 of the concept, F3
and F8) and the box cannot run without a concrete answer for either. The
packager resolves them to the provisional default also used by the catalog's
own test vectors (vectors/<partner>.json: 'wortfolge_laufzeit',
'bei_veraltet_laufzeit') - so flipping the resolved value once luox confirms
is a one-line edit in ONE file, never two drifting answers.
"""

from __future__ import annotations

import argparse
from typing import Any

from profilelib import REPO, VECTORS, canonical_json_bytes, load_json, load_profiles, split_offen

EDGE = REPO / "edge-app" / "core" / "internal" / "direktvermarkter" / "profiles.json"


def _resolve_offen(value: str, laufzeit_default: str) -> str:
    """An 'offen (Fxx)' value has no usable base - fall back to the vectors'
    provisional default. A value with a base ('<wert> (Fxx)') keeps its base;
    Stage 1 does not act on it yet, but a future reader should see the base,
    not the question."""
    if value.startswith("offen ("):
        return laufzeit_default
    if value.endswith(")") and " (" in value:
        return value.rpartition(" (")[0]
    return value


# The resolved base the box may run on for 'vorgabe_wirkt_auf'. There is no
# safe invented default for a plain 'offen (F5)': the two readings curtail
# different things, so an author must state the provisional base explicitly
# ('einspeisung_netzpunkt (F5)' until luox answers F5, per decision E2 = A).
WIRKT_AUF_ERLAUBT = ("einspeisung_netzpunkt", "erzeugung")


def _resolve_wirkt_auf(partner: str, value: str) -> str:
    base, _frage = split_offen(value)
    if base not in WIRKT_AUF_ERLAUBT:
        raise SystemExit(
            f"FEHLER: {partner}: regeln.vorgabe_wirkt_auf braucht eine Basis aus "
            f"{WIRKT_AUF_ERLAUBT} (ggf. mit '(Fxx)'-Marke), nicht {value!r}")
    return base


def runtime_view(profiles: list[dict[str, Any]]) -> dict[str, Any]:
    out = []
    for p in sorted(profiles, key=lambda p: p["partner"]):
        vectors = load_json(VECTORS / f"{p['partner']}.json")
        modbus = p["zugang"]["modbus"]
        register = [
            {k: v for k, v in reg.items() if k in ("tabelle", "adresse", "typ", "bedeutung", "band")}
            for reg in sorted(p["register"], key=lambda r: (r["tabelle"], r["adresse"]))
        ]
        out.append({
            "id": p["partner"],
            "modbus": {
                "port": modbus["port"],
                "unit": modbus["unit"],
                "wortfolge": _resolve_offen(modbus["wortfolge"], vectors["wortfolge_laufzeit"]),
                "funktionen": sorted(modbus["funktionen"]),
                "verbindungen": modbus["verbindungen"],
            },
            "register": register,
            "regeln": {
                "lebenszeichen_frist_s": p["regeln"]["lebenszeichen_frist_s"],
                "ruhewert_pct": p["regeln"]["ruhewert_pct"],
                "vorgabe_wirkt_auf": _resolve_wirkt_auf(p["partner"], p["regeln"]["vorgabe_wirkt_auf"]),
                "bei_veraltet": _resolve_offen(p["regeln"]["bei_veraltet"], vectors["bei_veraltet_laufzeit"]),
            },
        })
    return {
        "schema_version": "1.0",
        "generated_by": "catalog/direktvermarkter/tools/package_edge_runtime.py - nicht von Hand ändern",
        "partner": out,
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
            print(f"stale: {EDGE.relative_to(REPO)} - run catalog/direktvermarkter/tools/package_edge_runtime.py")
            return 1
        print(f"up to date: {EDGE.relative_to(REPO)}")
        return 0
    EDGE.parent.mkdir(parents=True, exist_ok=True)
    EDGE.write_bytes(raw)
    print(f"wrote {EDGE.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
