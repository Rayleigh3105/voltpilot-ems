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
a = p.parse_args()
a.fn(a)
