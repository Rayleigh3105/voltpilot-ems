#!/usr/bin/env python3
"""Die Nutzlasten, die die NEUE Cloud einer Box zustellt.

Ausgangspunkt ist immer die FESTGENAGELTE Beispiel-Nutzlast unter
docs/contracts/v2/examples/ - genau die Bytes, an die der api-Erzeuger per Test
gebunden ist (z.B. MeasurementContractsTest.publisherPayloadIsTheCommittedValidFixture).
Dieses Skript aendert daran nur, was der jeweilige Fall verlangt, und jede
Aenderung ist hier mit ihrer Cloud-Quelle belegt.
"""
import argparse, json, datetime, sys


def jetzt(delta=0):
    t = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=delta)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def push(a):
    d = json.load(open(a.vorlage, encoding="utf-8"))
    # Die Revision eines quellen-bewussten Pushs heisst `uems-registry:<sequence>`
    # statt `published_at` (ist/C §3). Die Box behandelt sie als undurchsichtig.
    d["revision"] = a.revision
    d["published_at"] = jetzt()
    if a.datenquellen:
        # EntityRegistryService.java:1243-1244 - der Zusatz nach BESTAETIGTER
        # Quellen-Uebernahme: in einen vorhandenen driver-Block hinein, und dort,
        # wo es noch keinen gab, wird einer ANGELEGT. Beide Faelle stehen hier.
        for e in d["entities"]:
            if e.get("entity_type") == "producer":
                e.setdefault("driver", {})["data_source_id"] = "DQ-6"
            if e.get("entity_type") == "grid-meter":
                e.setdefault("driver", {})["data_source_id"] = "DQ-7"
    if a.pause_sekunden:
        # Handeingriff MIT Ende: RuheRegel.push(endsAt != null) -> nur das Ende,
        # kein Widerrufs-Feld. „byte-gleich zum Handeingriff von vorher".
        d["automation_paused_until"] = jetzt(a.pause_sekunden)
    if a.ruhe_sekunden:
        # Ruhe bis zum Start: RuheRegel.push(endsAt == null, jetzt) ->
        # automation_paused_until_revoked=true UND ein rollierendes Ende
        # jetzt + ENDE_FUER_AELTERE_BOX (4 h). Der Zeitraffer staucht die vier
        # Stunden; das Feld und der Pfad sind dieselben.
        d["automation_paused_until"] = jetzt(a.ruhe_sekunden)
        d["automation_paused_until_revoked"] = True
    json.dump(d, open(a.aus, "w", encoding="utf-8"), ensure_ascii=False,
              separators=(",", ":"))


def plan(a):
    d = json.load(open(a.vorlage, encoding="utf-8"))
    # Die festgenagelte Plan-Nutzlast adressiert eine Entitaet, die NICHT im
    # Registry-Push-Beispiel steht (die beiden Beispiele stammen aus
    # verschiedenen Vertraegen). Ein Plan trifft an einer echten Anlage immer
    # eine gepushte Entitaet - darum wird hier genau das gleichgezogen und
    # sonst nichts.
    for e in d["entities"]:
        e["entity_id"] = a.entitaet
    d["generated_at"] = jetzt()
    start = datetime.datetime.now(datetime.timezone.utc).replace(second=0, microsecond=0)
    for e in d["entities"]:
        for i, s in enumerate(e["slots"]):
            s["start"] = (start + datetime.timedelta(minutes=15 * i)).strftime("%Y-%m-%dT%H:%M:%SZ")
    json.dump(d, open(a.aus, "w", encoding="utf-8"), ensure_ascii=False,
              separators=(",", ":"))


def fahrplan(a):
    """Der Fahrplan 1.0 des Zusatzlaufs kurzer-verbraucher.sh.

    Vorlage ist das festgenagelte Beispiel mit der Trim-Pflicht
    (docs/contracts/examples/mqtt-schedule.valid.surplus-only-charge.json).
    Geaendert wird nur, was der Fall verlangt:

    * Fall „laden" (--ueberschuss-pflichten, Planwert > 0): der Slot von
      Herzogau am 10.10.2026 17:00, wie ihn der Prueflauf des Tags faehrt
      (surplus_short_consumer_scenario_test.go: herzogauBenchScenario) - ein
      kleines geplantes Laden und BEIDE Ueberschuss-Pflichten,
      charge_from_surplus_only (slot_trim.py) und charge_surplus_to_battery.
    * Fall „ruhe" (Planwert 0, keine Pflicht): eine Viertelstunde, die nichts
      plant - dort deckt die Box ein gemessenes Defizit sofort (Entscheid vom
      28.08.2026).

    Jeder Slot wird gleich gesetzt, damit eine Viertelstunden-Grenze im Lauf
    nichts aendert. Dazu kommt effective_floor_soc_pct (derselbe Wert wie im
    Prueflauf des Tags und im festgenagelten Beispiel
    mqtt-schedule.valid.limit-discharge.json). Ohne diese Reserve-Angabe der
    Cloud verweigert die Box die Defizitdeckung in JEDEM Stand
    (guards.CoverDeficit: EffectiveFloorPct == nil) - der Lauf waere dann an
    jeder Box gruen und bewiese nichts.
    """
    d = json.load(open(a.vorlage, encoding="utf-8"))
    jetzt_dt = datetime.datetime.now(datetime.timezone.utc)
    d["generated_at"] = jetzt_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    d["effective_floor_soc_pct"] = 5.0
    start = jetzt_dt.replace(minute=(jetzt_dt.minute // 15) * 15, second=0, microsecond=0)
    for i, s in enumerate(d["slots"]):
        s.clear()
        s["start"] = (start + datetime.timedelta(minutes=15 * i)).strftime("%Y-%m-%dT%H:%M:%SZ")
        s["battery_setpoint_kw"] = a.planwert_kw
        if a.ueberschuss_pflichten:
            s["charge_from_surplus_only"] = True
            s["charge_surplus_to_battery"] = True
    json.dump(d, open(a.aus, "w", encoding="utf-8"), ensure_ascii=False,
              separators=(",", ":"))


p = argparse.ArgumentParser()
sub = p.add_subparsers(dest="was", required=True)
q = sub.add_parser("push")
q.add_argument("--vorlage", required=True)
q.add_argument("--revision", required=True)
q.add_argument("--datenquellen", action="store_true")
q.add_argument("--pause-sekunden", type=int, default=0)
q.add_argument("--ruhe-sekunden", type=int, default=0)
q.add_argument("--aus", required=True)
q.set_defaults(fn=push)
r = sub.add_parser("plan")
r.add_argument("--vorlage", required=True)
r.add_argument("--entitaet", required=True)
r.add_argument("--aus", required=True)
r.set_defaults(fn=plan)
f = sub.add_parser("fahrplan")
f.add_argument("--vorlage", required=True)
f.add_argument("--planwert-kw", type=float, required=True)
f.add_argument("--ueberschuss-pflichten", action="store_true")
f.add_argument("--aus", required=True)
f.set_defaults(fn=fahrplan)
a = p.parse_args()
a.fn(a)
