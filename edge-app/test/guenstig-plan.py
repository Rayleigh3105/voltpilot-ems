"""Der v2-Plan, den die Wolke einer Säule auf „Günstig" OHNE Ziel schickt.

Rig-Helfer von `e2e-guenstig.sh`. Er erfindet nichts: Profil und Dokument
sind die eines OCPP-Ladepunkts, wie die API sie anlegt - Fall `guenstig` in
`docs/contracts/v2/ladepunkt-profil-vectors.json` (Regelart und Nennleistung
aus `ConsumerService.ensureProfile`, das Dokument aus `SteuerartDokument`;
die API pinnt beides). Daraus entsteht der Plan über genau die Funktionen,
die der Optimierer im Takt aufruft:
`compile_consumer` -> `co_optimize` -> `build_plan_v2_payload`.

Nur die Preise sind gestellt, damit der Rig die beiden Seiten der Grenze
sicher trifft: `--jetzt teuer` legt die ersten zwei Stunden über die Grenze,
`--jetzt billig` darunter.

    python guenstig-plan.py --jetzt teuer --tenant … --site … --device … \
        --entity … --out plan.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

from voltpilot_optimization.co_solver import co_optimize
from voltpilot_optimization.consumer_inputs import ConsumerProfileRow, compile_consumer
from voltpilot_optimization.domain import BatteryParams, horizon_slot_starts
from voltpilot_optimization.entities import CoOptimizationInput, StorageEntity
from voltpilot_optimization.publisher_v2 import build_plan_v2_payload

SLOTS = 96
TEUER_CT = 32.0
BILLIG_CT = 22.0
VECTORS = (Path(__file__).resolve().parents[2]
           / "docs" / "contracts" / "v2" / "ladepunkt-profil-vectors.json")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jetzt", choices=("teuer", "billig"), required=True)
    ap.add_argument("--tenant", required=True)
    ap.add_argument("--site", required=True)
    ap.add_argument("--device", required=True)
    ap.add_argument("--entity", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    now = datetime.now(timezone.utc)
    slots = horizon_slot_starts(now, SLOTS)
    # Bezugspreis je Viertelstunde: die ersten acht Slots (zwei Stunden, mehr
    # als jeder Rig-Schritt dauert) liegen auf der gewählten Seite der Grenze,
    # danach wechselt es stündlich.
    erste = TEUER_CT if a.jetzt == "teuer" else BILLIG_CT
    zweite = BILLIG_CT if a.jetzt == "teuer" else TEUER_CT
    imp_ct = [erste if t < 8 else (zweite if (t // 4) % 2 == 0 else erste)
              for t in range(SLOTS)]
    spot_ct = [p - 20.0 for p in imp_ct]

    # Profil und Dokument, wie die API sie für „Günstig" anlegt (Audit W-02:
    # vorher stand hier ein Profil `continuous`, das die API nie anlegte).
    vektoren = json.loads(VECTORS.read_text(encoding="utf-8"))
    (fall,) = [f for f in vektoren["faelle"] if f["name"] == "guenstig"]
    document = dict(fall["dokument"], entity_id=a.entity)
    grenze = document["requirements"][0]["condition"]["value"]
    if not BILLIG_CT < grenze < TEUER_CT:
        print(f"guenstig-plan: die Rig-Preise schließen die Grenze {grenze} ct nicht ein",
              file=sys.stderr)
        return 2
    profile = ConsumerProfileRow(entity_id=a.entity,
                                 control_kind=fall["profil"]["control_kind"],
                                 rated_power_kw=float(fall["profil"]["rated_power_kw"]))
    load = compile_consumer(profile, document, slots, 15, spot_ct, imp_ct)
    print(f"guenstig-plan: Verbraucher im Plan: {'ja' if load else 'NEIN'}",
          file=sys.stderr)

    inp = CoOptimizationInput(
        tenant_id=UUID(a.tenant),
        site_id=UUID(a.site),
        device_id=UUID(a.device),
        slot_starts=slots,
        prices_eur_mwh=[p * 10.0 for p in spot_ct],
        base_load_kw=[0.5] * SLOTS,
        # Eine Anlage wie im Feld: ein Speicher, damit der Plan auch dann
        # erscheint, wenn er den Ladepunkt NICHT kommandiert (genau der
        # Fehlerfall). Keine Sonne: die Bahn „nur_sonne" bleibt ohne Überschuss.
        storages=(StorageEntity(
            entity_id="speicher-rig",
            params=BatteryParams(capacity_kwh=10.0, max_charge_kw=5.0,
                                 max_discharge_kw=5.0, roundtrip_efficiency=0.92,
                                 wear_cost_ct_per_kwh=4.0),
            initial_soc_kwh=5.0,
            charge_from_grid_allowed=False,
        ),),
        controllable_loads=(load,) if load else (),
        import_price_eur_mwh=[p * 10.0 for p in imp_ct],
    )
    plan = co_optimize(inp, uuid4(), now)
    payload = build_plan_v2_payload(plan)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    for e in payload["entities"]:
        if e["entity_id"] == a.entity and e["slots"]:
            print(f"guenstig-plan: erster Slot {e['slots'][0]}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
