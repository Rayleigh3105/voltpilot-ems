#!/usr/bin/env python3
"""AP-15 IP-29 (NW-3): das Drehbuch der Ausfallmatrix am Simulator-Aufbau und das Ergebnisblatt.

Je Matrixzeile A1–A15, A18 und A20 ein Lauf gegen den Aufbau aus IP-28
(`verbund.sh lauf`): Störung ab T0 im ungünstigsten Betriebspunkt der Zeile
(M-3), Messfenster = `nach_zeit` der Matrix, aufgerundet auf volle
Viertelstunden, plus zwei volle Viertelstunden. Die Läufe gehen nacheinander,
nie zwei Aufbauten zugleich, nach jedem `down -v` (verbund.sh).

  szenarien.py liste
  szenarien.py drehbuch <lauf> --aus <verzeichnis>     (Drehbuch + Dokumente, ohne Aufbau)
  szenarien.py fahre <lauf> … --protokolle <verzeichnis> [--status <datei>]
  szenarien.py blatt --protokolle <verzeichnis> --nw2 <ip27-protokoll.md> --aus <blatt.md>

Ein Lauf heißt wie seine Zeile, der Bezugs-Punkt trägt ein „n“ (R1n, A2n, A7n).
Die Zahlen der Vergleichsspalte stammen aus NW-2 (`zwei_agenten_test.go`,
`go test -run TestZweiAgentenAusfallmatrix`), dessen Protokoll `--nw2` liest.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import nutzlast

HIER = Path(__file__).resolve().parent
NULLPUNKT_NACHT_KW = 400.0  # uems_verbund.NULLPUNKT_NACHT_KW (ohne Import: das Modul ist der Anlagen-Prozess)
LADEPUNKTE = ",".join(f"ladepunkte:91{n:02d}" for n in range(2, 8))
EINSPEISEGRENZE_KW, BEZUGSGRENZE_KW = 100.0, 550.0
OHNE_MARGE_KW = 0.1  # näher an der Grenze heißt das Urteil „hält ohne Marge“

# Matrix §5.1 des Konzepts AP-15 (ausfallmatrix.json, entschieden 21.09.2026):
# was die Zeile verspricht und nach welcher Zeit. `haelt` = haelt_ohne_kommunikation.
MATRIX = {
    "R1": ("kein Ausfall (Normalbetrieb, Referenz)", "Einspeisung ≤ 100 kW, Bezug ≤ 550 kW", "—", True),
    "A1": ("Box Verwaltung (mitsteuernd) fällt ganz aus",
           "Einspeisung: Regelkreis der führenden Box, sonst 40 + 60 ≤ 100; Bezug: 24,6 ≤ 77",
           "sofort; Geräte-Rückfall nach ≤ 60 s", True),
    "A2": ("Box Halle 1 (führend, misst den Netzanschluss) fällt ganz aus",
           "Einspeisung ≤ 40 + 60 = 100 kW; Bezug ≤ 473 + 0 + 77 = 550 kW",
           "sofort für E-4; K-1 nach 60 s", True),
    "A3": ("Cloud weg, Broker erreichbar", "≤ 100 / ≤ 550 kW für jede Last (gespeicherter Anteil)",
           "Grenze: ohne Unterbrechung; Plan: veraltet nach 20 min", True),
    "A4": ("Broker oder Internet für alle Boxen weg", "≤ 100 / ≤ 550 kW für jede Last", "ohne Unterbrechung", True),
    "A5": ("Internet nur für Box Verwaltung weg", "≤ 100 / ≤ 550 kW für jede Last", "ohne Unterbrechung", True),
    "A6": ("Partner-Wert beim Planer veraltet", "hängt an keinem fremden Wert", "—", True),
    "A7": ("Netzzähler der führenden Box friert ein",
           "Einspeisung ≤ 40 + 60 = 100 kW ab Sekunde 90; Bezug: lädt blind nicht aus dem Netz",
           "≤ 90 s nach dem letzten Wert", True),
    "A8": ("Uhr einer Box geht falsch", "≤ 100 / ≤ 550 kW für jede Last", "ohne Unterbrechung", True),
    "A9": ("Plan nicht zugestellt oder nicht quittiert", "≤ 100 / ≤ 550 kW (Anteile reisen nicht im Plan)",
           "ohne Unterbrechung", True),
    "A10": ("Änderung der Anteile nicht zugestellt / nicht quittiert",
            "in jedem Zwischenzustand Summe ≤ Grenze (R12: 10 + 60 = 70 ≤ 100)", "unbegrenzt sicher", True),
    "A11": ("zwei Befehlsquellen: Handeingriff gegen den Plan", "kein Wunsch hebt einen Wächter auf", "sofort", True),
    "A12": ("Box ohne die Fähigkeit (alter Edge-Stand)", "wie heute: eine Box, eine Grenze", "—", True),
    "A13": ("Neustart mitten im Eingriff", "≤ 100 / ≤ 550 kW für jede Last",
            "Hochfahrzeit der Box (Geräte-Rückfall trägt sie)", True),
    "A14": ("Box-Tausch: Nachfolgerin steuert bis zur Bestätigung nicht mit", "Geräte-Rückfall ≤ Anteil, wie A1",
            "—", True),
    "A15": ("Box lebt, erreicht ihr Gerät nicht", "wie A1 - der Geräte-Rückfall steckt im Anteil",
            "Wachhund des Geräts (≤ 60 s im Beispiel)", True),
    "A18": ("Cloud-Datenbank zurückgespielt: Revision läuft rückwärts",
            "≤ 100 / ≤ 550 kW; der quittierte Stand bleibt", "—", True),
    "A20": ("das Ungeregelte wächst über seinen Vorbehalt (480 statt 473 kW)",
            "Bezug hält nur, solange der Vorbehalt stimmt: 480 + 77 = 557 kW bis zur Verengung",
            "Erkennung nach einer Viertelstunde; Verengung in Sekunden - wenn die Box verbunden ist", False),
}
ZEILEN = ("A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A12", "A13",
          "A14", "A15", "A18", "A20")

# Die Anteils-Dokumente des Drehbuchs (zwei_agenten_test.go zaA10, zaA18, zaA20):
# (revision, schritt, E-1 ein, E-4 ein, E-1 bez, E-4 bez[, verteilbar ein, bez])
DOKUMENTE = {
    "A10": {"a10-e1-r2": ("E-1", 2, "uebergang", 10, 60, 0, 77),
            "a10-e4-r2": ("E-4", 2, "uebergang", 10, 60, 0, 77),
            "a10-e1-r3": ("E-1", 3, "ziel", 10, 90, 0, 77),
            "a10-e4-r1": ("E-4", 1, "ziel", 40, 60, 0, 77),
            "a10-e4-r4": ("E-4", 4, "ziel", 40, 70, 0, 77, 100, 77)},
    "A18": {"a18-e1-r5": ("E-1", 5, "ziel", 40, 60, 0, 77), "a18-e4-r5": ("E-4", 5, "ziel", 40, 60, 0, 77),
            "a18-e1-r4": ("E-1", 4, "ziel", 60, 40, 77, 0), "a18-e4-r4": ("E-4", 4, "ziel", 60, 40, 77, 0)},
    "A20": {"a20-e1-r2": ("E-1", 2, "ziel", 40, 60, 0, 55), "a20-e4-r2": ("E-4", 2, "ziel", 40, 60, 0, 55)},
}
ANTEILE_LEAF = "v2/verbund-anteile"

# Was ein Lauf gezeigt hat, das die Zahlen allein nicht sagen - je (Lauf, Bilder-Stempel).
BEOBACHTUNGEN = {
    ("A7", "17abebe1c993"): "**Befund** (IP-28 Befund 1, vor PR 1068): der Zähler friert in der Prüf-Delle ein, "
                            "Box Halle 1 gibt den Spielraum zweimal frei; M-1 über der Grenze. Wiederholung auf "
                            "Bildern aus `f68d5e606` (PR 1068, 1075, 1078) steht aus.",
    ("A2", "17abebe1c993"): "**Befund** (Auslegung, beim Captain als G3 Übergangszuschlag): Box Halle 1 fällt in "
                            "einer Prüf-Delle aus; bis zum Geräte-Rückfall (60 s) speisen K-1 5,9 + K-2 60 + "
                            "K-12 58,8 = 124,7 kW ein, danach 40 + 58,8 = 98,8 kW - 1,2 kW Marge reichen für "
                            "60 s Übergang im selben Viertel nicht. Kein Box-Fehler gefunden. Der Captain hat "
                            "Option a entschieden: Übergangszuschlag in der Auslegungsprüfung G3 "
                            "(Rückfallzeit/900 s × größte Entladeleistung der führenden Box), nur Cloud, kein "
                            "Box-Release; Folgepaket `vp-uems-v15-folge-auslegung-uebergangszuschlag`. Der "
                            "Speicher-Watchdog bleibt im Pilot-Drehbuch.",
    ("A9", "17abebe1c993"): "Box Halle 1 lehnt jeden ungültigen Lauf ab (`schema_version_unbekannt`); nach 20 min "
                            "Rückfall des Plans, der Speicher lädt aus der PV (Viertel 2–4 bei 58–60 kW).",
    ("A10", "17abebe1c993"): "Quittungen wie zaA10: Box Halle 1 nimmt Übergang und Ziel an, Box Verwaltung "
                             "lehnt Revision 1 (`revision_aelter`) und Summe 110 (`summe_ueber_verteilbar`) ab.",
    ("A11", "17abebe1c993"): "Die Arbitrierung gibt dem Handeingriff den Speicher (`granted` −100 kW, "
                             "`manual intervention`), der Core befiehlt −100 kW - am Gerät bleibt es bei −39,2 kW: "
                             "der Einspeise-Wächter hält; kein Wunsch hebt ihn auf.",
    ("A12", "17abebe1c993"): "Der erste Aufbauversuch mit −60 kW Speicherleistung war fehlerhaft und wurde "
                              "verworfen. Dieser Lauf fährt wie NW-2 mit dem Fahrplan von heute und Speicher "
                              "0 kW; die gemessenen Werte stammen ausschließlich aus dem korrigierten Aufbau.",
    ("A15", "17abebe1c993"): "**Befund** wie A2: der Geräte-Rückfall braucht 60 s und die vorhandene Marge "
                              "reicht im laufenden Viertel nicht. Der Captain hat Option a entschieden: "
                              "Übergangszuschlag in G3 (Rückfallzeit/900 s × größte Entladeleistung der führenden "
                              "Box), nur Cloud, kein Box-Release; Folgepaket "
                              "`vp-uems-v15-folge-auslegung-uebergangszuschlag`. Der Speicher-Watchdog bleibt "
                              "im Pilot-Drehbuch.",
}


@dataclass
class Lauf:
    name: str
    zeile: str
    profil: str               # mittag (Einspeisung) | nacht | nacht_a20 (Bezug)
    t0: int                   # Messsekunde der Störung (VB_T0_S)
    nach_s: int = 0           # nach_zeit der Matrix in Sekunden (für das Messfenster)
    buch: list = field(default_factory=list)   # (Sekunde relativ zu T0, Aktion)
    env: dict = field(default_factory=dict)
    dauer: int | None = None  # ausdrücklich, sonst aus nach_s
    warum: str = ""           # warum dieser Betriebspunkt / diese Umsetzung
    nicht_fahrbar: str = ""   # Grund, wenn der Aufbau die Zeile nicht fahren kann

    def messdauer(self) -> int:
        """nach_zeit auf volle Viertelstunden aufgerundet plus zwei volle Viertelstunden."""
        if self.dauer is not None:
            return self.dauer
        return 900 * math.ceil(self.nach_s / 900) + 1800

    def bezug(self) -> bool:
        return self.profil.startswith("nacht")

    def umgebung(self) -> dict[str, str]:
        e = {"VB_PROFIL": self.profil, "VB_T0_S": str(self.t0), "VB_DAUER_S": str(self.messdauer())}
        if self.bezug():
            e.update(VB_NULLPUNKT_KW=f"{NULLPUNKT_NACHT_KW:g}", VB_LADEPUNKTE=LADEPUNKTE, VB_VERBRAUCHER="true")
        e.update(self.env)
        return e


def sende(box: str, dok: str) -> str:
    return f"sende {box} {ANTEILE_LEAF} {{dir}}/{dok}.json"


def laeufe() -> dict[str, Lauf]:
    k2 = nutzlast.speicher_entitaet(nutzlast.kennungen())
    m = "mittag"
    ls = [
        Lauf("R1", "R1", m, 600, dauer=2700, warum="wie IP-28 (T0 = Wolkenlücke bei Messsekunde 600) - vergleichbar mit R1 Lauf 2/3"),
        Lauf("A1", "A1", m, 0, 60, [(0, "stoerung A1")],
             warum="Mittag: K-12 läuft ohne Box frei mit 60 kW - genau ihr Anteil; der Bezug (24,6 ≤ 77 kW) hat Marge"),
        Lauf("A2", "A2", m, 0, 60, [(0, "stoerung A2")],
             warum="Mittag: 60 s lang speist K-1 ungeregelt, bis sein Rückfall 40 kW greift"),
        Lauf("A3", "A3", m, 0, 1200, [(0, "stoerung A3")],
             warum="Mittag; der Plan veraltet nach 20 min - das Fenster reicht über den Rückfall des Plans hinaus"),
        Lauf("A4", "A4", m, 0, 0, [(0, "stoerung A4")], warum="Mittag: der Broker steht (docker pause) bis zum Ende"),
        Lauf("A5", "A5", m, 0, 0, [(0, "stoerung A5")],
             warum="Mittag: Box Verwaltung ohne Broker-Netz, wie NW-2 A5 (die mitsteuernde Box)"),
        Lauf("A6", "A6", m, 0, nicht_fahrbar=(
            "im Aufbau läuft kein Planer; ein veralteter Partner-Wert beim Planer erreicht die Box nie - die Grenze "
            "hängt an keinem fremden Wert. Nachweis NW-4 (Matrix: nur NW-4)")),
        Lauf("A7", "A7", m, 600, 90, [(0, "stoerung A7")], dauer=1800,
             warum="wie IP-28 `make a7` (T0 600, 30 min, friert bis zum Ende) - vergleichbar mit A7 #1/#2"),
        Lauf("A7x", "A7", m, 600, 90, [(0, "stoerung A7x")], dauer=1800,
             warum="die andere Hälfte von A7: Netz- und Abgangszähler antworten nicht (A7 in NW-2), sonst wie A7"),
        Lauf("A8", "A8", m, 0, nicht_fahrbar=(
            "die Uhr eines Containers ist die des Docker-Hosts (CLOCK_REALTIME ohne Namensraum), der Go-Core ist "
            "statisch gebaut - faketime greift nicht; nötig wäre eine Prüf-Verstellung der Uhr im Core (Box-Code). "
            "Nachweis NW-2 (A8, A8r)")),
        Lauf("A9", "A9", m, 0, 1200, [(0, "cloud ungueltig")],
             warum="Mittag: ab T0 kommt jeder Viertelstunden-Lauf an, die Box lehnt ihn ab (Plan v2 mit unbekannter "
                   "schema_version, kein v1-Fahrplan); der letzte gültige Plan veraltet nach 20 min - Fenster wie A3"),
        Lauf("A10", "A10", m, 0, 0, [
            (0, 'anlage {"cmd":"rueckfall","komponente":"K-1","kw":10}'),
            (0, sende("E-1", "a10-e1-r2")), (0, sende("E-4", "a10-e4-r2")),
            (2, sende("E-1", "a10-e1-r3")),
            (60, sende("E-4", "a10-e4-r1")), (61, sende("E-4", "a10-e4-r4"))],
             warum="Mittag, wie zaA10: Übergang 10/60 an beide, Ziel 10/90 nur an Box Halle 1; dann Revision 1 "
                   "erneut und Summe 110 > 100 an Box Verwaltung (beide abzulehnen); K-1-Rückfall auf 10 kW (R12)"),
        Lauf("A11", "A11", m, 0, 0, [(-5, f"lauschen E-1 edge/entities/{k2}/+ 300"),
                                     (0, f"lokal E-1 edge/entities/{k2}/desired {{dir}}/a11-hand.json")],
             warum="Mittag: Handeingriff an K-2 -100 kW (local-ui, Vorrang vor dem Plan) - entlädt gegen die Einspeisegrenze"),
        Lauf("A12", "A12", m, 0, 0, env={"VB_ZUSTELLUNG": "ohne_anteile", "VB_E4_STEUERT": "false"},
             warum="Mittag, wie NW-2 A12: kein Anteils-Dokument, kein Plan v2, Box Halle 1 fährt den Fahrplan wie "
                   "heute (Einspeisegrenze 100 kW), Box Verwaltung schreibt nichts (Steuerpfad aus) - vom Start an"),
        Lauf("A13", "A13", m, 0, 60, [(0, "stoerung A13")],
             warum="Mittag, R15: Box Halle 1 startet mitten im Abregeln neu (docker kill + start)"),
        Lauf("A14", "A14", m, 0, 60, [(0, "tausch")],
             warum="Mittag: Box Verwaltung wird gegen eine Nachfolgerin mit neuer Kennung getauscht, die kein "
                   "Anteils-Dokument kennt; K-12 fällt auf seinen Rückfall (läuft frei, 60 kW)"),
        Lauf("A15", "A15", m, 0, 60, [(0, "stoerung A15")],
             warum="Mittag: Box Halle 1 erreicht ihr Gerät nicht (Modbus antwortet nicht) - K-1 und K-2 fallen zurück"),
        Lauf("A18", "A18", m, 60, 0, [
            (-60, sende("E-1", "a18-e1-r5")), (-60, sende("E-4", "a18-e4-r5")),
            (0, sende("E-1", "a18-e1-r4")), (0, sende("E-4", "a18-e4-r4"))],
             warum="Mittag, wie zaA18: Revision 5 an beide, bei T0 Revision 4 mit vertauschten Anteilen (60/40 · 77/0)"),
        Lauf("A20", "A20", "nacht_a20", 0, dauer=3600, buch=[
            (1805, sende("E-1", "a20-e1-r2")), (1805, sende("E-4", "a20-e4-r2"))],
             warum="Nacht (Bezugs-Punkt), wie zaA20: die Last wächst bei T0 + 5 min von 430 auf 480 kW; die "
                   "Verengung 0/55 kommt bei T0 + 30:05 (die Cloud nach dem ersten vollen Viertel) - 60 min wie NW-2"),
        Lauf("R1n", "R1", "nacht", 600, dauer=2700,
             warum="Bezugs-Punkt: Last 473 kW am Vorbehalt, sechs Wagen je 22 kW, Plan lädt den Speicher 100 kW"),
        Lauf("A2n", "A2", "nacht", 0, 60, [(0, "stoerung A2")],
             warum="Bezugs-Punkt: ohne Box Halle 1 hält nur noch der Anteil von Box Verwaltung (473 + 0 + 77)"),
        Lauf("A7n", "A7", "nacht", 600, 90, [(0, "stoerung A7")], dauer=1800,
             warum="Bezugs-Punkt: die führende Box darf blind nicht aus dem Netz laden"),
    ]
    return {x.name: x for x in ls}


def handeingriff(k2: str) -> dict:
    """zwei_agenten_test.go zaA11: -100 kW an K-2, local-ui, Rang vor dem Plan."""
    return {"schema_version": "1.0", "entity_id": k2, "request_id": f"override:{k2}:ip29",
            "source": {"kind": "local-ui"}, "priority": "flow", "override": True, "ttl_s": 3600,
            "issued_at": "@JETZT@", "command": {"type": "setpoint_kw", "value": -100.0}}


def schreibe_drehbuch(lauf: Lauf, aus: Path, jetzt: dt.datetime | None = None) -> Path:
    """Drehbuch (absolute Messsekunden, zeitlich sortiert) und die Dokumente, die es sendet."""
    aus.mkdir(parents=True, exist_ok=True)
    jetzt = jetzt or dt.datetime.now(dt.timezone.utc)
    k = nutzlast.kennungen()
    for name, d in DOKUMENTE.get(lauf.zeile, {}).items():
        box, rev, schritt, e1, e4, b1, b4, *v = d
        werte = {"einspeisung": {"E-1": e1, "E-4": e4}, "bezug": {"E-1": b1, "E-4": b4}}
        verteilbar = {"einspeisung": v[0], "bezug": v[1]} if v else None
        doc = nutzlast.anteile(k, box, rev, jetzt, schritt, werte, verteilbar)
        (aus / f"{name}.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    if lauf.zeile == "A11":
        (aus / "a11-hand.json").write_text(
            json.dumps(handeingriff(nutzlast.speicher_entitaet(k)), separators=(",", ":")), encoding="utf-8")
    zeilen = [f"# {lauf.name}: {MATRIX[lauf.zeile][0]} - Profil {lauf.profil}, T0 = Messsekunde {lauf.t0}"]
    for rel, akt in sorted(lauf.buch, key=lambda x: x[0]):
        zeilen.append(f"{lauf.t0 + rel} {akt.replace('{dir}', str(aus))}")
    datei = aus / "drehbuch.txt"
    datei.write_text("\n".join(zeilen) + "\n", encoding="utf-8")
    return datei


# --- Fenster: nie gegen fremde Testcontainers oder zu wenig Speicher --------

def fremde_testcontainers() -> int:
    r = subprocess.run(["docker", "ps", "-q", "--filter", "label=org.testcontainers=true"],
                       capture_output=True, text=True, check=False)
    return len([z for z in r.stdout.split() if z])


def freier_speicher_gib() -> float:
    """macOS: freie + inaktive + spekulative Seiten (vm_stat); Linux: MemAvailable."""
    if Path("/proc/meminfo").exists():
        for z in Path("/proc/meminfo").read_text().splitlines():
            if z.startswith("MemAvailable:"):
                return int(z.split()[1]) / 1024 / 1024
    out = subprocess.run(["vm_stat"], capture_output=True, text=True, check=False).stdout
    seite = int(re.search(r"page size of (\d+) bytes", out).group(1))
    n = sum(int(re.search(rf"{k}:\s+(\d+)", out).group(1))
            for k in ("Pages free", "Pages inactive", "Pages speculative"))
    return n * seite / 1024 ** 3


def warte_auf_fenster(max_container: int = 2, min_gib: float = 3.0) -> None:
    while True:
        n, frei = fremde_testcontainers(), freier_speicher_gib()
        if n <= max_container and frei >= min_gib:
            return
        print(f"    warte: {n} fremde Testcontainers, {frei:.1f} GiB frei", flush=True)
        time.sleep(30)


def werkzeug_stempel() -> str:
    """Commit des Werkzeugs; „+geändert“, wenn tools/uems-verbund-sim ungesichert abweicht."""
    repo = HIER.parents[1]
    sha = subprocess.run(["git", "-C", str(repo), "rev-parse", "--short=12", "HEAD"],
                         capture_output=True, text=True, check=False).stdout.strip()
    offen = subprocess.run(["git", "-C", str(repo), "status", "--porcelain", "--", str(HIER)],
                           capture_output=True, text=True, check=False).stdout.strip()
    return sha + ("+geändert" if offen else "")


def schnappschuss(ziel: Path) -> Path:
    """Das Werkzeug einfrieren: eine Reihe dauert Stunden, und bash liest ein
    laufendes Skript stückweise - eine Änderung im Arbeitsbaum darf keinen
    laufenden Lauf treffen. Verträge und Box-Quellen liest der Schnappschuss
    weiter aus dem Repo (VB_REPO, Verweise docs/ und edge-app/)."""
    import shutil
    werk = ziel / "tools" / "uems-verbund-sim"
    if werk.exists():
        shutil.rmtree(werk)
    shutil.copytree(HIER, werk, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache", "protokolle"))
    for teil in ("docs", "edge-app"):  # Verträge; verbund.yml erbt aus edge-app/docker-compose.yml
        verweis = ziel / teil
        if not verweis.exists():
            verweis.symlink_to(HIER.parents[1] / teil)
    return werk


def fahre(namen: list[str], protokolle: Path, status: Path | None) -> int:
    alle = laeufe()
    protokolle.mkdir(parents=True, exist_ok=True)
    fehler = 0
    stempel_werkzeug = werkzeug_stempel()
    werk = schnappschuss(Path(os.environ.get("TMPDIR", "/tmp")) / f"uems-verbund-ip29-werkzeug-{os.getpid()}")
    basis = dict(os.environ, VB_REPO=str(HIER.parents[1]))
    subprocess.run([str(werk / "verbund.sh"), "bilder"], env=basis, check=True)
    basis["VB_BILDER_FEST"] = "1"
    for name in namen:
        lauf = alle[name]
        if lauf.nicht_fahrbar:
            print(f"==> {name}: nicht fahrbar - {lauf.nicht_fahrbar}")
            continue
        n = 1
        while (protokolle / f"{name}-{n}.json").exists():
            n += 1
        ziel = protokolle / f"{name}-{n}.json"
        arbeit = Path(os.environ.get("TMPDIR", "/tmp")) / f"uems-verbund-ip29-{name}-{n}"
        buch = schreibe_drehbuch(lauf, arbeit / "drehbuch")
        warte_auf_fenster()
        env = dict(basis, VB_ARBEIT=str(arbeit), **lauf.umgebung())
        print(f"==> {name} (Lauf {n}): {lauf.umgebung()}", flush=True)
        if status:
            # Lebenszeichen für die Aufsicht: der Lauf ist still, bis er endet
            # (Anlauf + Messung + ~4 min Auf-/Abbau + 5 min Luft).
            bis = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=300 + lauf.messdauer() + 540)
            with status.open("a", encoding="utf-8") as f:
                f.write(f"paused: IP-29 Lauf {name} läuft im Simulator, Wecker gestellt until "
                        f"{bis.strftime('%Y-%m-%dT%H:%M:%SZ')}\n")
        r = subprocess.run([str(werk / "verbund.sh"), "lauf", "--drehbuch", str(buch),
                            "--protokoll", str(ziel)], env=env, check=False)
        if ziel.exists():
            p = json.loads(ziel.read_text(encoding="utf-8"))
            p.update(lauf=name, werkzeug=stempel_werkzeug, umgebung=lauf.umgebung())
            ziel.write_text(json.dumps(p, ensure_ascii=False, indent=1), encoding="utf-8")
        if r.returncode != 0 or not ziel.exists():
            fehler += 1
            zeile = f"working: IP-29 {name} Lauf {n} ohne Protokoll (Exit {r.returncode})"
        else:
            e = kennzahlen(json.loads(ziel.read_text(encoding="utf-8")), lauf.bezug())
            zeile = (f"working: IP-29 {name} ({lauf.profil}) M-1 {e['m1']} kW (Grenze {e['grenze']:g}), "
                     f"M-2 +{e['m2_kw']} kW / längste {e['m2_s']} s")
        print(zeile, flush=True)
        if status:
            with status.open("a", encoding="utf-8") as f:
                f.write(zeile + "\n")
    return 1 if fehler else 0


# --- Das Ergebnisblatt ----------------------------------------------------------

def kennzahlen(p: dict, bezug: bool) -> dict:
    r = p["anlage"]["bezug" if bezug else "einspeisung"]
    return {"m1": r["m1_hoechstes_viertel_kw"], "grenze": r["grenze_kw"], "m2_kw": r["m2_groesste_ueber_kw"],
            "m2_s": r["m2_laengste_ueber_s"], "m2_summe": r["m2_sekunden_ueber"],
            "viertel": [v["mittel_kw"] for v in r["m1_viertel"]]}


def urteil(m1: float | None, grenze: float, haelt_laut_matrix: bool) -> str:
    if m1 is None:
        return "kein volles Viertel gemessen"
    if m1 > grenze + 1e-6:
        return "verletzt" + ("" if haelt_laut_matrix else " - wie die Matrix erwartet (hält nicht ohne Verengung)")
    if grenze - m1 < OHNE_MARGE_KW:
        return "hält ohne Marge"
    return "hält"


def lies_nw2(text: str) -> dict[tuple[str, str], dict]:
    """Die Tabelle aus `ip27-zwei-agenten-protokoll.md`: je (Zeile, Punkt) M-1/M-2 beider Richtungen."""
    aus = {}
    for z in text.splitlines():
        t = [x.strip() for x in z.strip().strip("|").split("|")]
        if len(t) < 12 or not re.fullmatch(r"R1|A\d+[a-z]?", t[0]):
            continue
        zahl = lambda s: float(s.split()[0])  # noqa: E731 - „98.0 kW (13:15)“ → 98.0
        aus[(t[0], t[1])] = {"einspeisung": (zahl(t[2]), zahl(t[3]), int(t[4].split()[0])),
                             "bezug": (zahl(t[6]), zahl(t[7]), int(t[8].split()[0])), "urteil": t[11]}
    return aus


def nw2_text(nw2: dict, zeile: str, bezug: bool) -> str:
    punkt = "Nacht" if bezug else "Mittag"
    werte = []
    for z in ([zeile, zeile + "e"] if zeile == "A7" else [zeile]):
        v = nw2.get((z, punkt))
        if v:
            m1, m2, s = v["bezug" if bezug else "einspeisung"]
            werte.append(f"{z}: {m1:g} kW, +{m2:g} kW / {s} s")
    return "; ".join(werte) or "—"


def quittungen_text(p: dict) -> str:
    teile = []
    for box, v in sorted(p.get("boxen", {}).items()):
        a = [q["nutzlast"] for q in v.get("quittungen", []) if q["topic"] == "v2/verbund-anteile-result"]
        pl = [q["nutzlast"] for q in v.get("quittungen", []) if q["topic"] == "v2/plan-result"]
        ant = ", ".join(f"{x.get('urteil')}{' (' + x['grund'] + ')' if x.get('grund') else ''}" for x in a)
        ang = sum(1 for x in pl if x.get("angenommen"))
        teile.append(f"{box}: Anteile [{ant or '—'}], Plan {ang}/{len(pl)} angenommen")
    return "; ".join(teile)


def stempel(p: dict) -> str:
    """Die Marke der Box-Bilder (letzter Commit an edge-app/, edge/sim), ohne den Vorsatz der Bahn."""
    return (p.get("core_bild") or "").split(":")[-1].split("-")[-1] or (p.get("bilder_aus_commit") or "")[:12]


def blatt(protokolle: Path, nw2_datei: Path | None, erzeugt: str | None = None) -> str:
    alle = laeufe()
    nw2 = lies_nw2(nw2_datei.read_text(encoding="utf-8")) if nw2_datei and nw2_datei.exists() else {}
    gefahren: dict[str, list[dict]] = {}
    for f in sorted(protokolle.glob("*.json")):
        name = f.stem.rsplit("-", 1)[0]
        if name in alle:
            gefahren.setdefault(name, []).append(json.loads(f.read_text(encoding="utf-8")))
    stempel_alle = sorted({stempel(p) for ps in gefahren.values() for p in ps})
    z = [
        "# Gemeinsame Steuerung – Ausfalltests am Simulator-Aufbau (NW-3)",
        "",
        f"AP-15 IP-29, erzeugt von `tools/uems-verbund-sim/szenarien.py blatt`{' am ' + erzeugt if erzeugt else ''}. "
        "Jede Zeile der Ausfallmatrix (A1–A15, A18, A20) als Lauf gegen den Aufbau aus IP-28: zwei echte "
        "Box-Container (Go-Core + Node-RED-Palette) in EINER Anlage, ein Mosquitto, das Anlagenmodell "
        "`uems_verbund.py`. Die Cloud läuft nicht; ihre Nutzlasten kommen aus `nutzlast.py`.",
        "",
        "## Aufbau",
        "",
        f"- **Bilder:** Core und Node-RED aus `origin/uems`, Stempel {', '.join(f'`uems-{s}`' for s in stempel_alle) or '—'} "
        "(letzter Commit an `edge-app/`, `edge/sim`; einmal gebaut, jede Zeile auf denselben Bildern).",
        "- **Takt 1:1:** eine Simulator-Sekunde ist eine echte Sekunde - die Box rechnet nur in echten Sekunden "
        "(Frische 30 s, Rückfall 60 s, Einfrierprobe 30 + 20 s, Node-RED-Lesetakt 2 s).",
        "- **Messung:** M-1 = höchstes Viertelstunden-Mittel am Netzpunkt (Viertel ab Messbeginn), M-2 = größte "
        "Überschreitung, längste Strecke darüber und Sekunden gesamt; beide aus dem Anlagen-Prozess, jede Sekunde.",
        "- **M-3, ungünstigster Punkt:** Mittag für die Einspeisung (volle Sonne an K-1, Speicher entlädt 60 kW, "
        "Wolkenlücke über der Verwaltung 5 s nach T0: K-12 30 → 60 kW); Nacht für den Bezug (Last 473 kW am "
        "Vorbehalt, sechs Wagen je 22 kW, Plan lädt den Speicher 100 kW).",
        f"- **Messfenster:** `nach_zeit` der Matrix auf volle Viertelstunden aufgerundet plus zwei volle "
        "Viertelstunden; R1 und A7 wie in IP-28 (vergleichbar mit dessen Läufen).",
        f"- **Bezugs-Punkt:** die kompakte Registerkarte trägt nur int16 × 0,01 kW (±327,67 kW). Ohne "
        f"Treiberänderung verschiebt die Anlage den Nullpunkt der führenden Box um {NULLPUNKT_NACHT_KW:g} kW "
        f"(Netzzähler, Last, Anschlussleistung von E-1), und E-1 bekommt ihre Bezugsgrenze um denselben Betrag "
        f"tiefer zugestellt ({BEZUGSGRENZE_KW:g} → {BEZUGSGRENZE_KW - NULLPUNKT_NACHT_KW:g} kW). Jede Differenz "
        "„Grenze − Zähler“ bleibt gleich; gemessen wird am echten Netzpunkt. Die sechs Säulen AHR-LP-02…07 von "
        "E-4 sind echte OCPP-1.6J-Ladepunkte (`edge-app/core/cmd/vp-ocpp-sim`, unverändert), die Anlage liest "
        "ihre Leistung aus deren Statusseiten.",
        "- **Nicht fahrbar:** A8 (Uhr - Host-Uhr, statischer Core) und A6 (Planer-Wert - kein Planer im Aufbau); "
        "beide weiter mit NW-2 bzw. NW-4 nachgewiesen. A19 ist nicht gebaut (E1 = A).",
        "",
        "## Ergebnis je Zeile",
        "",
        "| Zeile | Störung | Punkt | Bilder | M-1 höchstes Viertel | M-2 größte / längste / gesamt | Matrix: Grenze · nach Zeit | NW-2 (gleiche Basis) | Urteil |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    notizen = []
    namen = ["R1"] + [n for z in ZEILEN for n in ([z, "A7x"] if z == "A7" else [z])] + [n for n in alle if n.endswith("n")]
    for name in namen:
        lauf = alle[name]
        text, grenze_text, nach, haelt = MATRIX[lauf.zeile]
        punkt = "Nacht (Bezug)" if lauf.bezug() else "Mittag (Einspeisung)"
        vgl = nw2_text(nw2, lauf.zeile, lauf.bezug())
        if lauf.nicht_fahrbar:
            z.append(f"| {name} | {text} | — | — | — | — | {grenze_text} · {nach} | {vgl} | "
                     f"nicht fahrbar: {lauf.nicht_fahrbar} |")
            continue
        ps = gefahren.get(name, [])
        if not ps:
            z.append(f"| {name} | {text} | {punkt} | — | — | — | {grenze_text} · {nach} | {vgl} | noch nicht gefahren |")
            continue
        # Je Stand der Box-Bilder eine Zeile (A7 vor und nach einer Heilung),
        # mehrere Läufe desselben Stands als Bandbreite.
        je_stand: dict[str, list[dict]] = {}
        for x in ps:
            je_stand.setdefault(stempel(x), []).append(x)
        for st, gruppe in je_stand.items():
            p = gruppe[-1]
            e = kennzahlen(p, lauf.bezug())
            u = urteil(e["m1"], e["grenze"], haelt)
            viertel = " / ".join(f"{v:g}" for v in e["viertel"])
            m1 = f"**{e['m1']:g} kW** ({viertel})" if e["m1"] is not None else "—"
            bandbreite = ""
            if len(gruppe) > 1:
                werte = [kennzahlen(x, lauf.bezug()) for x in gruppe]
                m1s = [w["m1"] for w in werte if w["m1"] is not None]
                m2s = [w["m2_kw"] for w in werte]
                m2l = [w["m2_s"] for w in werte]
                m1 += f"; {len(gruppe)} Läufe: {min(m1s):g}–{max(m1s):g}"
                bandbreite = f"; {len(gruppe)} Läufe: +{min(m2s):g}–{max(m2s):g} kW / {min(m2l)}–{max(m2l)} s"
                u = " / ".join(dict.fromkeys(urteil(w["m1"], w["grenze"], haelt) for w in werte))
            z.append(f"| {name} | {text} | {punkt} | `{st}` | {m1} | +{e['m2_kw']:g} kW / {e['m2_s']} s / "
                     f"{e['m2_summe']} s{bandbreite} | {grenze_text} · {nach} | {vgl} | {u} |")
            beob = BEOBACHTUNGEN.get((name, st))
            notizen.append(f"- **{name}** auf `{st}` ({lauf.profil}, T0 = Messsekunde {lauf.t0}, "
                           f"{lauf.messdauer() // 60} min, {len(gruppe)} Lauf/Läufe): {lauf.warum}. "
                           f"Quittungen: {quittungen_text(p)}." + (f" {beob}" if beob else ""))
    offen = [name for name in ("A20", "R1n", "A2n", "A7n") if not gefahren.get(name)]
    if offen:
        z += [
            "",
            "## Offene Containerläufe",
            "",
            f"**Nicht gefahren - offen:** {', '.join(offen)}. Die Messreihe wurde auf Anweisung nach den "
            "abgeschlossenen Läufen beendet; der begonnene A20-Lauf wurde vor der Auswertung abgebrochen und "
            "liefert deshalb kein Ergebnisprotokoll. Nachfahren aus `tools/uems-verbund-sim/`:",
            "",
            "```bash",
            "VB_BILD_ZUSATZ=ip29- VB_PROJEKT=uems-verbund-ip29 python3 szenarien.py fahre "
            + " ".join(offen) + " \\",
            "  --protokolle \"$TMPDIR/ip29/protokolle\" \\",
            "  --status /Users/mvogt/IdeaProjects/firstmate/state/vp-uems-v15-ip29-ausfallblatt.status",
            "```",
        ]
    z += ["", "## Umsetzung und Quittungen je Lauf", "", *notizen, ""]
    return "\n".join(z)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="was", required=True)
    sub.add_parser("liste")
    d = sub.add_parser("drehbuch")
    d.add_argument("lauf")
    d.add_argument("--aus", type=Path, required=True)
    f = sub.add_parser("fahre")
    f.add_argument("laeufe", nargs="+")
    f.add_argument("--protokolle", type=Path, required=True)
    f.add_argument("--status", type=Path)
    b = sub.add_parser("blatt")
    b.add_argument("--protokolle", type=Path, required=True)
    b.add_argument("--nw2", type=Path)
    b.add_argument("--aus", type=Path, required=True)
    b.add_argument("--erzeugt", help="Datum im Kopf, Vorgabe heute")
    a = p.parse_args(argv)
    if a.was == "liste":
        for x in laeufe().values():
            print(f"{x.name:4} {x.zeile:4} {x.profil:10} T0 {x.t0:4} {x.messdauer() // 60:3} min  "
                  f"{'NICHT FAHRBAR' if x.nicht_fahrbar else ''}")
        return 0
    if a.was == "drehbuch":
        print(schreibe_drehbuch(laeufe()[a.lauf], a.aus).read_text(encoding="utf-8"), end="")
        print(" ".join(f"{k}={v}" for k, v in laeufe()[a.lauf].umgebung().items()))
        return 0
    if a.was == "fahre":
        unbekannt = [x for x in a.laeufe if x not in laeufe()]
        if unbekannt:
            print(f"unbekannte Läufe {unbekannt} (szenarien.py liste)", file=sys.stderr)
            return 2
        return fahre(a.laeufe, a.protokolle, a.status)
    a.aus.parent.mkdir(parents=True, exist_ok=True)
    a.aus.write_text(blatt(a.protokolle, a.nw2, a.erzeugt or dt.date.today().isoformat()), encoding="utf-8")
    print(f"==> {a.aus}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
