#!/usr/bin/env python3
"""Die Cloud-Nutzlasten des Simulator-Aufbaus - je Box, festgenagelt zugestellt.

Die Cloud läuft in diesem Aufbau NICHT (wie in tools/nw3-box-image). Was sie
den beiden Boxen der Anlage AN-1 schickt, entsteht hier aus den Vertrags-
Beispielen und -Vektoren; geändert wird nur, was der Fall R1 verlangt, und
jede Änderung steht mit ihrer Quelle daneben:

  v2/entities          Registry-Push je Box   examples/edge-entity.valid.registry-push.json
  v2/verbund-anteile   Anteils-Dokument       verbund-anteile-mqtt-vectors.json (Kennungen, Form)
                       je Box mit Revision    + Referenzfall R1: 40/60 kW Einspeisung, 0/77 kW Bezug
  v2/plan              Plan je Box, EINE      examples/mqtt-schedule-2.0.valid.gemeinsame-steuerung-*.json
                       plan_id für beide
  schedule             v1-Fahrplan je Box     examples/mqtt-schedule.valid.export-limit.json - die
                       (Schattenphase)        Form, mit der zwei_agenten_test.go zaPlan die Boxen fährt
  v2/charging-config   Ladepark je Box        ladepark-je-box-vectors.json Fall R3

Der Plan ist ein LAUF: die Box fährt ihn höchstens 20 Minuten (danach
`execution.mode: fallback`, Matrix A3). Wie die Cloud - und wie
`zwei_agenten_test.go planZustellen` - kommt darum jede Viertelstunde ein neuer
Lauf für beide Boxen: `--runde N --nur-plan` gibt Fahrplan v1 und Plan v2 mit
einer neuen, für beide Boxen gleichen `plan_id` und `lauf_nr` 4711 + N − 1.

Der Bezugs-Punkt (AP-15 IP-29, Profil `nacht`): der Plan lädt den Speicher
100 kW aus dem Netz (zaNacht.e1BattKw), und weil die Anlage den Nullpunkt der
führenden Box um `--nullpunkt` kW verschiebt (uems_verbund.NULLPUNKT_NACHT_KW),
bekommt E-1 ihre Bezugsgrenze um denselben Betrag tiefer zugestellt. E-4 misst
ihren Abgang unverschoben und bekommt alles wie immer.

Varianten des Drehbuchs (szenarien.py): `--ohne-anteile` (A12: ein alter
Edge-Stand - weder Anteils-Dokument noch Plan v2 noch Ladepark je Box, nur der
Fahrplan wie heute) und `--ungueltig` (A9: der Lauf kommt an, die Box lehnt ihn
ab - Plan v2 mit unbekannter schema_version, kein v1-Fahrplan) und `--zuschlag`
(A2n: Übergangszuschlag Lesart B, PR 1092 - Bezug 0/73 statt 0/77, verteilbar 77).

Aufruf: nutzlast.py --aus <verzeichnis> [--revision 1] [--runde 1] [--nur-plan]
                    [--profil mittag|nacht|nacht_a20] [--nullpunkt 0]
                    [--ohne-anteile] [--ungueltig] [--zuschlag 0] [--jetzt 2026-09-22T01:00:00Z]
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import os
import uuid
from pathlib import Path

HIER = Path(__file__).resolve().parent
VERTRAEGE = HIER.parents[1] / "docs" / "contracts"
V2 = VERTRAEGE / "v2"

MQTT_VEKTOREN = V2 / "verbund-anteile-mqtt-vectors.json"
REGISTRY_BEISPIEL = V2 / "examples" / "edge-entity.valid.registry-push.json"
PLAN_FUEHRT = V2 / "examples" / "mqtt-schedule-2.0.valid.gemeinsame-steuerung-fuehrt.json"
PLAN_STEUERT_MIT = V2 / "examples" / "mqtt-schedule-2.0.valid.gemeinsame-steuerung-steuert-mit.json"
FAHRPLAN_V1 = VERTRAEGE / "examples" / "mqtt-schedule.valid.export-limit.json"
LADEPARK_VEKTOREN = V2 / "ladepark-je-box-vectors.json"

BOXEN = ("E-1", "E-4")
# Referenzfall R1 / uems-referenzunternehmen.json gemeinsame_steuerungen[0].auslegung
ANTEILE = {"einspeisung": {"E-1": 40.0, "E-4": 60.0}, "bezug": {"E-1": 0.0, "E-4": 77.0}}
EINSPEISEGRENZE_KW = 100.0
BEZUGSGRENZE_KW = 550.0
# Übergangszuschlag (PR 1092, Lesart B, verbund-anteil-vectors.json „Ahrenberg A2 Bezug“):
# die Cloud rechnet den Puffer vom Rest über den Rückfällen ab - Bezug 0/73 statt 0/77,
# `verteilbar` bleibt 77. Die Einspeiseseite bleibt 40/60 (der Rest fehlt dort, Handgriff am Gerät).
def anteile_mit_zuschlag(zuschlag_kw: float) -> tuple[dict, dict | None]:
    if not zuschlag_kw:
        return ANTEILE, None
    werte = {r: dict(v) for r, v in ANTEILE.items()}
    werte["bezug"]["E-4"] = round(werte["bezug"]["E-4"] - zuschlag_kw, 1)
    return werte, {r: sum(v.values()) for r, v in ANTEILE.items()}


E1_SPEICHER_KW = -60.0     # zaMittag.e1BattKw: der Speicher entlädt 60 kW für den Markt (V6)
E1_SPEICHER_NACHT_KW = 100.0  # zaNacht.e1BattKw: der Plan lädt den Speicher 100 kW aus dem Netz


def speicher_kw(profil: str) -> float:
    if profil == "heute":
        return 0.0
    return E1_SPEICHER_KW if profil == "mittag" else E1_SPEICHER_NACHT_KW
PLAN_SLOTS = 16            # zaPlan: vier Stunden ab dem Viertel von jetzt


def kennungen() -> dict[str, str]:
    return json.loads(MQTT_VEKTOREN.read_text(encoding="utf-8"))["kennungen"]


def speicher_entitaet(k: dict[str, str]) -> str:
    """Die Speicher-Entität K-2 an Box Halle 1 - konstruiert wie die Kennungen der Vektoren."""
    return k["E-1"][:-2] + "b2"


def zeit(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def viertel(t: dt.datetime) -> dt.datetime:
    return t.replace(minute=t.minute - t.minute % 15, second=0, microsecond=0)


def identitaet(d: dict, k: dict[str, str], box: str) -> dict:
    d["tenant_id"], d["site_id"], d["device_id"] = k["tenant"], k["site"], k[box]
    return d


def registry(k: dict, box: str, revision: int, jetzt: dt.datetime) -> dict:
    vorlage = json.loads(REGISTRY_BEISPIEL.read_text(encoding="utf-8"))
    d = identitaet(copy.deepcopy(vorlage), k, box)
    d["revision"] = f"uems-registry:{revision}"
    d["published_at"] = zeit(jetzt)
    speicher, _erzeuger, zaehler = vorlage["entities"]
    zaehler = copy.deepcopy(zaehler)
    if box == "E-1":
        # K-2 Speicher 100 kW (geraete_rueckfaelle K-2 nenn_kw) - die Vorlage trägt 30 kW
        s = copy.deepcopy(speicher)
        s["entity_id"] = speicher_entitaet(k)
        s["label"] = "Speicher Halle 1 (K-2)"
        s["capabilities"]["actuate"] = [{"command": "setpoint_kw", "min": -100, "max": 100},
                                        {"command": "limit_kw", "max": 100}]
        s["guards"]["limits"].update({"max_charge_kw": 100, "max_discharge_kw": 100})
        zaehler["entity_id"] = k["E-1"][:-2] + "d2"
        zaehler["label"] = "Netzanschluss NA-1 (DQ-2)"
        d["entities"] = [s, zaehler]
    else:
        # Box Verwaltung misst nur ihren Abgang; ihre PV ist die Box-eigene
        # Entität pv-<device_id> des Plan-Beispiels, kein Registry-Eintrag.
        zaehler["entity_id"] = k["E-4"][:-2] + "da"
        zaehler["label"] = "Abgang PV und Ladepark Verwaltung (DQ-10)"
        d["entities"] = [zaehler]
    return d


def anteile(k: dict, box: str, revision: int, jetzt: dt.datetime, schritt: str = "ziel",
            werte: dict | None = None, verteilbar: dict | None = None) -> dict:
    """Form wie jedes Dokument der Vektoren (zwei_agenten_test.go zaDokV); Zahlen
    aus R1, für A10/A18/A20 die Zahlen des Drehbuchs."""
    werte = werte or ANTEILE
    return {
        "schema_version": "1.0",
        "tenant_id": k["tenant"], "site_id": k["site"], "device_id": k[box],
        "epoche": 1, "revision": revision, "schritt": schritt,
        "verteilbar": verteilbar or {r: sum(v.values()) for r, v in werte.items()},
        "anteile": {r: {k[b]: v[b] for b in BOXEN} for r, v in werte.items()},
        "published_at": zeit(jetzt),
        "rolle": "fuehrt" if box == "E-1" else "steuert_mit",
    }


def plan_id(runde: int) -> str:
    """Runde 1 trägt die plan_id der Beispiele; jede weitere Runde eine neue."""
    basis = json.loads(PLAN_FUEHRT.read_text(encoding="utf-8"))["plan_id"]
    return basis if runde == 1 else str(uuid.uuid5(uuid.UUID(basis), f"runde-{runde}"))


def plan_v2(k: dict, box: str, jetzt: dt.datetime, runde: int = 1, profil: str = "mittag",
            nullpunkt: float = 0.0) -> dict:
    vorlage = PLAN_FUEHRT if box == "E-1" else PLAN_STEUERT_MIT
    d = identitaet(json.loads(vorlage.read_text(encoding="utf-8")), k, box)
    q = viertel(jetzt)
    d["plan_id"] = plan_id(runde)
    d["lauf_nr"] = d["lauf_nr"] + runde - 1
    d["generated_at"] = zeit(jetzt)
    d["horizon_slots"] = PLAN_SLOTS
    e = d["entities"][0]
    if box == "E-1":
        # grid_import_limit_kw trägt nur die führende Box (mqtt-schedule-2.0.md)
        d["grid_import_limit_kw"] = BEZUGSGRENZE_KW - nullpunkt
        e["entity_id"] = speicher_entitaet(k)
        e["charge_from_grid_allowed"] = True
        befehl = {"setpoint_kw": speicher_kw(profil)}
    else:
        e["entity_id"] = f"pv-{k['E-4']}"
        befehl = {"limit_kw": 60.0}
    e["slots"] = [{"start": zeit(q + dt.timedelta(minutes=15 * i)), "commands": dict(befehl)}
                  for i in range(PLAN_SLOTS)]
    return d


def fahrplan_v1(k: dict, box: str, plan_id: str, jetzt: dt.datetime, profil: str = "mittag") -> dict:
    d = identitaet(json.loads(FAHRPLAN_V1.read_text(encoding="utf-8")), k, box)
    q = viertel(jetzt)
    d["plan_id"] = plan_id
    d["generated_at"] = zeit(jetzt)
    d["horizon_slots"] = PLAN_SLOTS
    d["grid_charge_allowed"] = True
    kw = speicher_kw(profil) if box == "E-1" else 0.0
    if box == "E-1":
        # zaPlan(e1Batt, &grenze): nur die führende Box trägt die Grenze des Netzpunkts
        d["grid_export_limit_kw"] = EINSPEISEGRENZE_KW
    else:
        d.pop("grid_export_limit_kw", None)
    d["slots"] = [{"start": zeit(q + dt.timedelta(minutes=15 * i)), "battery_setpoint_kw": kw}
                  for i in range(PLAN_SLOTS)]
    return d


def ladepark(k: dict, box: str, jetzt: dt.datetime, nullpunkt: float = 0.0) -> dict:
    v = json.loads(LADEPARK_VEKTOREN.read_text(encoding="utf-8"))
    fall = next(f for f in v["ausschnitt"] if f["fall"].startswith("R3"))
    teil = fall["erwartet"][box]
    return {
        "schema_version": "1.0",
        "tenant_id": k["tenant"], "site_id": k["site"], "device_id": k[box],
        "published_at": zeit(jetzt),
        "grid_limit_kw": BEZUGSGRENZE_KW - (nullpunkt if box == "E-1" else 0.0),
        # Nennleistung, Anschlüsse und Mindestleistung je Säule aus der Referenzdatei
        # (geraete_rueckfaelle K-13.x: 22 kW, 4,1 kW = 6 A dreiphasig) - ohne sie
        # nimmt die Box die Säule nicht in ihre Freigabeliste auf (IP-29).
        "charge_points": [{"id": s["id"], "rank": s["rank"], "rated_kw": 22.0, "connectors": 1,
                           "min_kw": 4.1} for s in teil["saeulen"]],
        "priority_charge_point_ids": teil["vorrang"],
    }


def alle(revision: int, jetzt: dt.datetime, runde: int = 1, nur_plan: bool = False,
         profil: str = "mittag", nullpunkt: float = 0.0, ohne_anteile: bool = False,
         ungueltig: bool = False, zuschlag: float = 0.0) -> dict[str, dict[str, dict]]:
    """{box: {leaf: nutzlast}} - leaf ist das Topic unter ems/{tenant}/{site}/{device}/."""
    k = kennungen()
    out: dict[str, dict[str, dict]] = {}
    for box in BOXEN:
        v2 = plan_v2(k, box, jetzt, runde, profil, nullpunkt)
        out[box] = {} if nur_plan else {"v2/entities": registry(k, box, revision, jetzt)}
        if not nur_plan and not ohne_anteile:
            out[box]["v2/verbund-anteile"] = anteile(k, box, revision, jetzt, "ziel",
                                                     *anteile_mit_zuschlag(zuschlag))
            out[box]["v2/charging-config"] = ladepark(k, box, jetzt, nullpunkt)
        if ohne_anteile:
            # A12 wie zwei_agenten_test.go e1PlanHeute: ohne Anteil gibt es keinen
            # Wächter über dem Speicher (V6 kommt mit dem Anteil) - die führende
            # Box bekommt den Plan von heute, gegen die Grenze gerechnet: keine
            # Markt-Entladung, kein Laden aus dem Netz.
            out[box]["schedule"] = fahrplan_v1(k, box, v2["plan_id"], jetzt, "heute")
            continue
        if ungueltig:
            v2["schema_version"] = "9.9"  # A9: zugestellt, aber von der Box abzulehnen
        else:
            out[box]["schedule"] = fahrplan_v1(k, box, v2["plan_id"], jetzt, profil)
        out[box]["v2/plan"] = v2
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aus", required=True, type=Path)
    p.add_argument("--revision", type=int, default=1)
    p.add_argument("--runde", type=int, default=1, help="Lauf der Cloud (je Viertelstunde einer)")
    p.add_argument("--nur-plan", action="store_true", help="nur Fahrplan v1 und Plan v2")
    p.add_argument("--jetzt", help="UTC, Vorgabe: jetzt")
    p.add_argument("--profil", default=os.environ.get("VB_PROFIL", "mittag"))
    p.add_argument("--nullpunkt", type=float, default=float(os.environ.get("VB_NULLPUNKT_KW", "0")))
    p.add_argument("--ohne-anteile", action="store_true",
                   default=os.environ.get("VB_ZUSTELLUNG") == "ohne_anteile")
    p.add_argument("--ungueltig", action="store_true")
    p.add_argument("--zuschlag", type=float, default=float(os.environ.get("VB_ZUSCHLAG_KW", "0")),
                   help="Übergangszuschlag in kW: Bezug-Anteil von E-4 um so viel kleiner (A2n)")
    a = p.parse_args(argv)
    jetzt = (dt.datetime.strptime(a.jetzt, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
             if a.jetzt else dt.datetime.now(dt.timezone.utc))
    a.aus.mkdir(parents=True, exist_ok=True)
    k = kennungen()
    for box, leafs in alle(a.revision, jetzt, a.runde, a.nur_plan, a.profil, a.nullpunkt,
                           a.ohne_anteile, a.ungueltig, a.zuschlag).items():
        for leaf, d in leafs.items():
            name = f"{box}__{leaf.replace('/', '_')}.json"
            (a.aus / name).write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")),
                                      encoding="utf-8")
            print(f"ems/{k['tenant']}/{k['site']}/{k[box]}/{leaf} {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
