"""Der v2-Plan, den die Wolke einer Säule auf „Günstig" OHNE Ziel schickt.

Rig-Helfer von `e2e-guenstig.sh`. Er erfindet nichts: das Dokument ist
wörtlich die Projektion `SteuerartDokument` der API für einen OCPP-Ladepunkt
mit Quelle `guenstig` (Pfad `SteuerartService.schreibeBahn` gibt dort `false`
zurück, also bleibt die Quelle im Dokument), und daraus entsteht der Plan
über genau die Funktionen, die der Optimierer im Takt aufruft:
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
from uuid import UUID, uuid4

from voltpilot_optimization.co_solver import co_optimize
from voltpilot_optimization.consumer_inputs import ConsumerProfileRow, compile_consumer
from voltpilot_optimization.domain import BatteryParams, horizon_slot_starts
from voltpilot_optimization.entities import CoOptimizationInput, StorageEntity
from voltpilot_optimization.publisher_v2 import build_plan_v2_payload

SLOTS = 96
TEUER_CT = 32.0
BILLIG_CT = 22.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jetzt", choices=("teuer", "billig"), required=True)
    ap.add_argument("--tenant", required=True)
    ap.add_argument("--site", required=True)
    ap.add_argument("--device", required=True)
    ap.add_argument("--entity", required=True)
    ap.add_argument("--rated-kw", type=float, default=11.0)
    ap.add_argument("--grenze-ct", type=float, default=28.0)
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

    # Wörtlich SteuerartDokument.quelle(QUELLE_GUENSTIG) + zielwert() eines
    # Ladepunkts mit gepflegter Nennleistung (SteuerartApiTest pinnt die Form).
    document = {
        "schema_version": "1.0",
        "entity_id": a.entity,
        "timezone": "Europe/Berlin",
        "requirements": [{
            "id": "guenstig",
            "name": "Günstige Stunden",
            "kind": "reactive",
            "enforcement": "opportunistic",
            "condition": {"signal": "market.import_price_ct_kwh", "operator": "lt",
                          "value": a.grenze_ct},
            "target": {"kind": "kw", "value": a.rated_kw},
        }],
    }
    profile = ConsumerProfileRow(entity_id=a.entity, control_kind="continuous",
                                 rated_power_kw=a.rated_kw)
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
