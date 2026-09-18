#!/usr/bin/env python3
"""AP-07 IP-20: Störungs-Szenarien der Messdatenstrecke für den Edge-Simulator.

Fünf Abnahmefälle aus dem Konzept „Messdatenstrecke, Herkunft, Aufbewahrung" (§7)
als deterministische, brokerfreie Nachrichtenfolgen:

* ``A1``  Doppel-Zustellung und Sequenz-Reset (ein Umschlag verdoppelt keinen Verbrauch)
* ``A3``  Uplink-Verlust mit Outbox-Replay (Ausfall Box Halle 2, Nachlieferung 17:31)
* ``A4``  Verdrängung im Puffer (Lücke bleibt Lücke) und Nachzügler nach Endgültigkeit
* ``A6``  Übergabe DQ-3 mit Nachzügler aus der alten Box
* ``A13`` Uhr der Box geht vor (Box Lindach)

Jedes Szenario liefert (a) die Zustellungen, die eine Box auf ihre MQTT-Topics
legt — geprüft gegen ``mqtt-measurement-samples`` 2.0/2.1 und ``mqtt-events-2.1`` —
und (b) die Ereignisse, die die Cloud daraus bilden muss, als gültige
``events.raw``-Nutzlasten. Beides ist Bibliothek: AP-07 IP-21 (Testcontainers-
Abnahme A1…A16) ruft ``szenarien()`` auf und vergleicht Zeilen und Ereignisse
gegen die Datenbank; dieses Paket prüft nur die erzeugte Nachrichtenfolge.

Identitäten, Katalogstand und Beispielwerte stammen aus dem Referenzunternehmen
Kunststoffwerk Ahrenberg (``uems-referenzunternehmen.json``) und den kanonischen
Kennungen in ``events-vocabulary-vectors.json``; die Box-Zuständigkeiten löst der
Zwei-Boxen-Simulator ``uems_ahrenberg.AhrenbergScenario`` (AP-06 IP-20) auf.

Die Messzeiten des Konzepts stehen in Ortszeit (Europe/Berlin), am Draht in UTC.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from uems_ahrenberg import AhrenbergScenario

VERTRAEGE = Path(__file__).resolve().parents[2] / "docs/contracts/v2"
VOKABULAR_VEKTOREN = VERTRAEGE / "events-vocabulary-vectors.json"

KATALOGSTAND = "2026.08.26.3"
ANGEWENDETE_FASSUNG = 1
EREIGNIS_NAMESPACE = uuid.UUID("9b1c2d3e-4f50-5a6b-8c7d-0e1f2a3b4c5d")

#: Komponenten des Referenzunternehmens mit ihrer technischen Kennung.  Die
#: Kennung von K-5 steht wörtlich in mqtt-measurement-samples-2.1.md §4; die
#: übrigen setzen dieselbe Familie fort.
KOMPONENTEN: dict[str, tuple[str, str]] = {
    "MS-05": ("K-4", "a4e0b000-0000-4000-8000-0000000000c4"),
    "MS-06": ("K-5", "a4e0b000-0000-4000-8000-0000000000c5"),
    "MS-07": ("K-6", "a4e0b000-0000-4000-8000-0000000000c6"),
    "MS-08": ("K-7", "a4e0b000-0000-4000-8000-0000000000c7"),
    "MS-10": ("K-8.1", "a4e0b000-0000-4000-8000-000000000c81"),
    "MS-11": ("K-8.2", "a4e0b000-0000-4000-8000-000000000c82"),
    "MS-12": ("K-8.3", "a4e0b000-0000-4000-8000-000000000c83"),
    "MS-13": ("K-8.4", "a4e0b000-0000-4000-8000-000000000c84"),
    "MS-14": ("K-9", "a4e0b000-0000-4000-8000-0000000000c9"),
    "MS-17": ("K-10.1", "a4e0b000-0000-4000-8000-000000000ca1"),
    "MS-18": ("K-10.2", "a4e0b000-0000-4000-8000-000000000ca2"),
}

#: Der Messkanal der führenden Quelle je Messstelle (Referenzunternehmen) und der
#: eigene Punktschlüssel am Draht.  Das Referenzunternehmen nennt für einen
#: Modbus-Zähler keinen Katalogschlüssel; die Verträge benutzen deshalb
#: `custom.…` (mqtt-measurement-samples-2.1.md §4).
KANAELE: dict[str, tuple[str, str]] = {
    "MS-05": ("Wirkenergie Bezug", "custom.ms-05.wirkenergie-bezug"),
    "MS-06": ("Wirkenergie Bezug", "custom.ms-06.wirkenergie-bezug"),
    "MS-07": ("Wirkenergie Bezug", "custom.ms-07.wirkenergie-bezug"),
    "MS-08": ("Wirkenergie Bezug", "custom.ms-08.wirkenergie-bezug"),
    "MS-10": ("Wirkenergie Bezug", "custom.ms-10.wirkenergie-bezug"),
    "MS-11": ("Wirkenergie Bezug", "custom.ms-11.wirkenergie-bezug"),
    "MS-12": ("Wirkenergie Bezug", "custom.ms-12.wirkenergie-bezug"),
    "MS-13": ("Wirkenergie Bezug", "custom.ms-13.wirkenergie-bezug"),
    "MS-14": ("OCPP-Zählerstand", "custom.ms-14.ocpp-zaehlerstand"),
    "MS-17": ("Wirkenergie Bezug", "custom.ms-17.wirkenergie-bezug"),
    "MS-18": ("Wirkenergie Bezug", "custom.ms-18.wirkenergie-bezug"),
}

#: Anfangsstand je Reihe in Zählimpulsen (raw); decoded = raw / 10 kWh.
ANFANGSSTAND: dict[str, int] = {
    "MS-05": 2_214_500, "MS-06": 10_834_000, "MS-07": 3_311_800, "MS-08": 1_907_400,
    "MS-10": 406_280, "MS-11": 188_120, "MS-12": 94_640, "MS-13": 51_900,
    "MS-14": 22_340, "MS-17": 77_310, "MS-18": 64_880,
}

#: Zuwachs je Kadenz-Tick in Zählimpulsen — deterministisch, nie zufällig.
ZUWACHS: dict[str, int] = {
    "MS-05": 3, "MS-06": 9, "MS-07": 5, "MS-08": 4,
    "MS-10": 16, "MS-11": 7, "MS-12": 4, "MS-13": 2,
    "MS-14": 1, "MS-17": 3, "MS-18": 2,
}

#: Die Anlage, auf deren Kennung die Box sendet (site_id am Draht).
BOX_ANLAGE: dict[str, str] = {"E-1": "AN-1", "E-2": "AN-2", "E-2′": "AN-2", "E-3": "AN-3"}


def _kennungen() -> dict:
    with VOKABULAR_VEKTOREN.open(encoding="utf-8") as handle:
        return json.load(handle)["kennungen"]


def _z(moment: datetime) -> str:
    """Ein Zeitpunkt in UTC auf die Sekunde, wie ihn die Verträge verlangen (E13)."""
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _ortszeit(value: str) -> datetime:
    """Eine Messzeit des Konzepts (Ortszeit mit Versatz) als UTC-Zeitpunkt."""
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError(f"Messzeit braucht einen Versatz: {value}")
    return parsed.astimezone(timezone.utc)


def _zustellart(messzeit: datetime, eingang: datetime, kadenz_s: int = 60) -> str:
    """Nachgeliefert ist ein Wert erst ab max(5 min, 3 x Kadenz) Verzoegerung (Sec. 4.5 E5.2)."""
    schwelle = timedelta(seconds=max(300, 3 * kadenz_s))
    return "nachgeliefert" if eingang - messzeit > schwelle else "direkt"


def _ereignis_id(schluessel: str) -> str:
    return str(uuid.uuid5(EREIGNIS_NAMESPACE, schluessel))


@dataclass(frozen=True)
class Zustellung:
    """EIN MQTT-Publish des Simulators, mit der Eingangszeit, die er behauptet."""

    topic: str
    nutzlast: dict
    eingangszeit: str
    box: str
    strom: str = "measurement-samples"
    zustellart: str = "direkt"  # direkt | nachgeliefert | wiederholt
    dup: bool = False           # MQTT-DUP: dieselbe Zustellung ein zweites Mal
    aus_outbox: bool = False    # aus dem Puffer der Box gespielt, nicht frisch gelesen
    qos: int = 1
    retain: bool = False
    hinweis: str = ""

    @property
    def sequenz(self) -> int:
        return int(self.nutzlast["sequence"])


@dataclass(frozen=True)
class ErwarteteReihe:
    """Was die Strecke je Reihe gespeichert haben muss (Abnahme in IP-21)."""

    messstelle: str
    rohzeilen: int
    rolle: str = "fuehrend"
    hinweis: str = ""


@dataclass(frozen=True)
class Szenario:
    schluessel: str
    titel: str
    quelle: str
    zustellungen: tuple[Zustellung, ...]
    erwartete_ereignisse: tuple[dict, ...]
    erwartete_reihen: tuple[ErwarteteReihe, ...]
    erwartet_wiederholt: int = 0
    befunde: tuple[str, ...] = field(default_factory=tuple)

    @property
    def samples(self) -> int:
        return sum(len(z.nutzlast.get("samples", ())) for z in self.zustellungen)

    def plan(self) -> dict:
        return {
            "szenario": self.schluessel,
            "titel": self.titel,
            "quelle": self.quelle,
            "zustellungen": [
                {
                    "topic": z.topic,
                    "eingangszeit": z.eingangszeit,
                    "box": z.box,
                    "strom": z.strom,
                    "zustellart": z.zustellart,
                    "dup": z.dup,
                    "aus_outbox": z.aus_outbox,
                    "sequenz": z.sequenz,
                    "werte": len(z.nutzlast.get("samples", z.nutzlast.get("events", ()))),
                    "hinweis": z.hinweis,
                }
                for z in self.zustellungen
            ],
            "erwartete_ereignisse": [e["ereignis"]["art"] for e in self.erwartete_ereignisse],
            "erwartete_reihen": [vars(r) for r in self.erwartete_reihen],
            "erwartet_wiederholt": self.erwartet_wiederholt,
            "befunde": list(self.befunde),
        }


class Streckenszenarien:
    """Baut die fünf Störungs-Szenarien auf den Kennungen des Referenzunternehmens."""

    def __init__(self, ahrenberg: AhrenbergScenario | None = None):
        self.ahrenberg = ahrenberg or AhrenbergScenario.load()
        kennungen = _kennungen()
        self.tenant_id = kennungen["kundenbereich"]["KB-AHRENBERG"]
        self.anlagen = dict(kennungen["anlagen"])
        self.boxen = dict(kennungen["boxen"])

    # -- Bausteine ---------------------------------------------------------

    def site_id(self, box: str) -> str:
        return self.anlagen[BOX_ANLAGE[box]]

    def device_id(self, box: str) -> str:
        return self.boxen[box]

    def topic(self, box: str, strom: str) -> str:
        pfad = "measurement-samples" if strom == "measurement-samples" else "events"
        return f"ems/{self.tenant_id}/{self.site_id(box)}/{self.device_id(box)}/v2/{pfad}"

    def _sample(self, messstelle: str, tick: int, messzeit: datetime, *, mit_herkunft: bool) -> dict:
        roh = ANFANGSSTAND[messstelle] + ZUWACHS[messstelle] * tick
        sample = {
            "point_key": KANAELE[messstelle][1],
            "raw": roh,
            "decoded": round(roh / 10.0, 1),
            "quality": "good",
            "observed_at": _z(messzeit),
        }
        if mit_herkunft:
            sample["entity_id"] = KOMPONENTEN[messstelle][1]
        return sample

    def umschlag(
        self,
        box: str,
        sequenz: int,
        samples: list[dict],
        messzeit: datetime,
        *,
        fassung: int | None = ANGEWENDETE_FASSUNG,
    ) -> dict:
        """Ein measurement-samples-Umschlag; 2.1 sobald Herkunftsfelder mitreisen."""
        traegt_herkunft = fassung is not None or any("entity_id" in s for s in samples)
        umschlag = {
            "schema_version": "2.1" if traegt_herkunft else "2.0",
            "tenant_id": self.tenant_id,
            "site_id": self.site_id(box),
            "device_id": self.device_id(box),
            "catalog_version": KATALOGSTAND,
            "sequence": sequenz,
            "observed_at": _z(messzeit),
            "samples": samples,
        }
        if fassung is not None:
            umschlag["applied_revision"] = fassung
        return umschlag

    def ereignis_umschlag(self, box: str, sequenz: int, zeitpunkt: datetime, ereignisse: list[dict]) -> dict:
        return {
            "schema_version": "2.1",
            "tenant_id": self.tenant_id,
            "site_id": self.site_id(box),
            "device_id": self.device_id(box),
            "sequence": sequenz,
            "observed_at": _z(zeitpunkt),
            "events": ereignisse,
        }

    def cloud_ereignis(
        self,
        box: str,
        urheber: str,
        eingang: datetime,
        ereignis: dict,
        schluessel: str,
        *,
        aus_umschlag: Zustellung | None = None,
    ) -> dict:
        """Ein erwartetes Ereignis als gültige events.raw-Nutzlast (IP-21 vergleicht damit)."""
        nutzlast = {
            "schema_version": "1.0",
            "event_id": _ereignis_id(f"event:{schluessel}"),
            "tenant_id": self.tenant_id,
            "site_id": self.site_id(box),
            "urheber": urheber,
            "ingested_at": _z(eingang),
            "ereignis": ereignis | {"ereignis_id": _ereignis_id(f"ereignis:{schluessel}")},
        }
        if urheber == "box":
            # Weg 1 des Ereignisvertrags: die Datenannahme zerlegt einen Box-Umschlag
            # und nennt dabei Topic, Sequenz und observed_at des Umschlags.
            if aus_umschlag is None:
                raise ValueError("ein Box-Ereignis braucht seinen Umschlag")
            nutzlast |= {
                "device_id": self.device_id(box),
                "source_topic": aus_umschlag.topic,
                "sequence": aus_umschlag.sequenz,
                "observed_at": aus_umschlag.nutzlast["observed_at"],
            }
        return nutzlast

    # -- A1: Doppel-Zustellung und Sequenz-Reset ---------------------------

    def a1_doppel_zustellung(self) -> Szenario:
        """A1: Umschlag 48 213 zweimal, danach mit zurückgesetzter Sequenz."""
        box = "E-2"
        beginn = _ortszeit("2026-11-03T14:00:00+01:00")
        eingang = _ortszeit("2026-11-03T17:31:00+01:00")
        reihen = ("MS-10", "MS-11", "MS-12", "MS-13", "MS-14")

        # Das Registerbild von Halle 2 hat 256 Punkte über MS-10…MS-14; die Box
        # fragt sie im Sekundentakt ab, jeder Wert trägt seine eigene Messzeit.
        # Damit ist der Umschlag genau voll (Schema-Maximum 256 Samples) und die
        # Messzeiten laufen von 14:00:00 bis 14:04:15 Ortszeit — die Zahlen des
        # Abnahmefalls.  Punktschlüssel sind je Umschlag eindeutig (Vertragsregel).
        samples: list[dict] = []
        for schritt in range(256):
            messstelle = reihen[schritt % len(reihen)]
            kanal = schritt // len(reihen)
            roh = ANFANGSSTAND[messstelle] + ZUWACHS[messstelle] + kanal
            samples.append({
                "point_key": f"{KANAELE[messstelle][1]}.{kanal:02d}",
                "raw": roh,
                "decoded": round(roh / 10.0, 1),
                "quality": "good",
                "observed_at": _z(beginn + timedelta(seconds=schritt)),
                "entity_id": KOMPONENTEN[messstelle][1],
            })

        nutzlast = self.umschlag(box, 48213, samples, beginn + timedelta(seconds=255))
        wiederholung = json.loads(json.dumps(nutzlast))
        nach_neustart = json.loads(json.dumps(nutzlast)) | {"sequence": 1}

        zustellungen = (
            Zustellung(
                topic=self.topic(box, "measurement-samples"), nutzlast=nutzlast,
                eingangszeit=_z(eingang), box=box,
                zustellart=_zustellart(beginn, eingang), aus_outbox=True,
                hinweis="Umschlag 48 213, 256 Werte, Messzeit 14:00:00–14:04:15 Ortszeit",
            ),
            Zustellung(
                topic=self.topic(box, "measurement-samples"), nutzlast=wiederholung,
                eingangszeit=_z(eingang + timedelta(seconds=8)), box=box,
                zustellart="wiederholt", dup=True,
                hinweis="QoS-1-Wiederholung nach PUBACK-Zeitüberschreitung: gleiche Sequenz, gleiche Werte",
            ),
            Zustellung(
                topic=self.topic(box, "measurement-samples"), nutzlast=nach_neustart,
                eingangszeit=_z(eingang + timedelta(seconds=41)), box=box,
                zustellart="wiederholt",
                hinweis="Box-Neustart: dieselben Werte mit zurückgesetzter Sequenz 1",
            ),
        )

        ereignisse = (
            self.cloud_ereignis(
                box, "writer", eingang + timedelta(seconds=41),
                {
                    "art": "sequence_reset",
                    "zeitpunkt": _z(eingang + timedelta(seconds=41)),
                    "box": self.device_id(box),
                    "strom": "measurement-samples",
                    "sequenz_erwartet": 48214,
                    "sequenz_erhalten": 1,
                },
                "a1-sequence-reset",
            ),
        )
        # 256 Punkte, gleichmäßig über fünf Reihen: MS-10 trägt einen mehr.
        je_reihe = {code: sum(1 for i in range(256) if reihen[i % len(reihen)] == code) for code in reihen}
        return Szenario(
            schluessel="A1",
            titel="Ein erneut übertragenes Messpaket verdoppelt keinen Verbrauch",
            quelle="AP-07 §7 A1",
            zustellungen=zustellungen,
            erwartete_ereignisse=ereignisse,
            erwartete_reihen=tuple(
                ErwarteteReihe(messstelle=code, rohzeilen=je_reihe[code]) for code in reihen
            ),
            erwartet_wiederholt=512,
            befunde=(
                "kein duplicate_conflict: alle drei Zustellungen tragen denselben Wert je Messzeit (§4.5 E3.1/E3.2)",
            ),
        )

    # -- A3: Ausfall mit Outbox-Replay -------------------------------------

    def a3_ausfall_nachlieferung(self) -> Szenario:
        """A3: Uplink weg 14:00–17:30, die Box liest weiter und liefert 17:31 nach."""
        box = "E-2"
        reihen = ("MS-10", "MS-11", "MS-12", "MS-13", "MS-14")
        ausfall_von = _ortszeit("2026-11-03T14:00:00+01:00")
        ausfall_bis = _ortszeit("2026-11-03T17:30:00+01:00")
        nachlieferung = _ortszeit("2026-11-03T17:31:00+01:00")
        takte = int((ausfall_bis - ausfall_von).total_seconds() // 60)  # 210 Kadenz-Ticks à 60 s

        zustellungen: list[Zustellung] = []
        # Der letzte Umschlag vor dem Ausfall belegt „liefert Daten“.
        vorher = ausfall_von - timedelta(minutes=1)
        zustellungen.append(Zustellung(
            topic=self.topic(box, "measurement-samples"),
            nutzlast=self.umschlag(box, 48200, [self._sample(c, -1, vorher, mit_herkunft=True) for c in reihen], vorher),
            eingangszeit=_z(vorher + timedelta(seconds=2)), box=box,
            hinweis="letzter Umschlag vor dem Ausfall",
        ))
        # Box Halle 1 sendet durch: MS-05…MS-08 bekommen kein Ereignis.
        for versatz in (5, 60, 180):
            zeit = ausfall_von + timedelta(minutes=versatz)
            zustellungen.append(Zustellung(
                topic=self.topic("E-1", "measurement-samples"),
                nutzlast=self.umschlag(
                    "E-1", 90100 + versatz,
                    [self._sample(c, versatz, zeit, mit_herkunft=True) for c in ("MS-05", "MS-06", "MS-07", "MS-08")],
                    zeit,
                ),
                eingangszeit=_z(zeit + timedelta(seconds=2)), box="E-1",
                hinweis="Box Halle 1 liefert während des Ausfalls unverändert",
            ))
        # 17:31: die Outbox spielt FIFO ab, älteste Messzeit zuerst, Sequenz lückenlos.
        for tick in range(takte):
            messzeit = ausfall_von + timedelta(minutes=tick)
            eingang = nachlieferung + timedelta(seconds=tick // 2)
            zustellungen.append(Zustellung(
                topic=self.topic(box, "measurement-samples"),
                nutzlast=self.umschlag(
                    box, 48201 + tick,
                    [self._sample(c, tick, messzeit, mit_herkunft=True) for c in reihen],
                    messzeit,
                ),
                eingangszeit=_z(eingang), box=box,
                zustellart=_zustellart(messzeit, eingang),
                aus_outbox=True,
                hinweis="Outbox-Replay mit Original-Messzeit",
            ))

        eingang_bis = nachlieferung + timedelta(seconds=(takte - 1) // 2)
        ereignisse: list[dict] = []
        for quelle, anzahl in (("DQ-4", 4 * takte), ("DQ-5", takte)):
            ereignisse.append(self.cloud_ereignis(
                box, "writer", ausfall_von + timedelta(minutes=5),
                {
                    "art": "data_gap", "von": _z(ausfall_von), "bis": _z(ausfall_bis),
                    "erkannt_aus": "kadenz", "box": self.device_id(box), "datenquelle": quelle,
                    "erwartet_fehlend": anzahl, "nachgeliefert_am": _z(nachlieferung),
                },
                f"a3-data-gap-{quelle}",
            ))
            ereignisse.append(self.cloud_ereignis(
                box, "writer", eingang_bis,
                {
                    "art": "backfill", "von": _z(ausfall_von),
                    "bis": _z(ausfall_von + timedelta(minutes=takte - 1)),
                    "box": self.device_id(box), "datenquelle": quelle,
                    "eingang_von": _z(nachlieferung), "eingang_bis": _z(eingang_bis),
                    "anzahl": anzahl, "erwartet": anzahl,
                },
                f"a3-backfill-{quelle}",
            ))
        for code in reihen:
            ereignisse.append(self.cloud_ereignis(
                box, "writer", ausfall_von + timedelta(minutes=5),
                {
                    "art": "data_gap", "von": _z(ausfall_von), "bis": _z(ausfall_bis),
                    "erkannt_aus": "kadenz", "box": self.device_id(box),
                    "komponente": KOMPONENTEN[code][0], "messkanal": KANAELE[code][0],
                    "messstelle": code, "erwartet_fehlend": takte,
                    "nachgeliefert_am": _z(nachlieferung),
                },
                f"a3-data-gap-{code}",
            ))

        return Szenario(
            schluessel="A3",
            titel="Box Halle 2 fällt 14:00–17:30 aus und liefert nach",
            quelle="AP-07 §7 A3",
            zustellungen=tuple(zustellungen),
            erwartete_ereignisse=tuple(ereignisse),
            erwartete_reihen=tuple(ErwarteteReihe(messstelle=c, rohzeilen=takte + 1) for c in reihen),
            befunde=(
                "14 Viertelstunden 14:00–17:30 stehen bis zur Nachlieferung auf 0 von 15 — nie auf 0 kWh (§4.5 E5.5)",
                "MS-05…MS-08 bleiben ohne Ereignis: Box Halle 1 liefert durch",
            ),
        )

    # -- A4: Verdrängung im Puffer -----------------------------------------

    def a4_verdraengung(self) -> Szenario:
        """A4: Ausfall 8 Tage, die Outbox verdrängt die ältesten 3 Tage."""
        box = "E-2"
        reihen = ("MS-10", "MS-11", "MS-12", "MS-13", "MS-14")
        ausfall_von = _ortszeit("2026-11-03T14:00:00+01:00")
        verdraengt_bis = ausfall_von + timedelta(days=3)
        rueckkehr = ausfall_von + timedelta(days=8)
        # Der Puffer trägt 5 Tage; die ältesten 3 Tage sind mit dem Platz weg.
        verdraengte_takte = 3 * 24 * 60
        behaltene_takte = 5 * 24 * 60

        zustellungen: list[Zustellung] = [
            Zustellung(
                topic=self.topic(box, "measurement-samples"),
                nutzlast=self.umschlag(
                    box, 48213,
                    [self._sample(c, -1, ausfall_von - timedelta(minutes=1), mit_herkunft=True) for c in reihen],
                    ausfall_von - timedelta(minutes=1),
                ),
                eingangszeit=_z(ausfall_von - timedelta(seconds=58)), box=box,
                hinweis="letzter Umschlag vor dem Ausfall (Sequenz 48 213)",
            ),
            # Die Box meldet die Verdrängung selbst — mqtt-events 2.1, erkannt_aus verdraengung.
            Zustellung(
                topic=self.topic(box, "events"),
                nutzlast=self.ereignis_umschlag(box, 7, rueckkehr, [{
                    "ereignis_id": _ereignis_id("a4-box-verdraengung"),
                    "art": "data_gap",
                    "von": _z(ausfall_von),
                    "bis": _z(verdraengt_bis),
                    "erkannt_aus": "verdraengung",
                    "datenquelle": "DQ-4",
                    "erwartet_fehlend": 4 * verdraengte_takte,
                }]),
                eingangszeit=_z(rueckkehr), box=box, strom="events",
                hinweis="Puffer-Verdrängung: die ältesten drei Tage sind fort",
            ),
        ]
        # Die Randstichprobe des Replays: erster behaltener Takt, ein mittlerer, der letzte.
        # Die Sequenz springt von 48 213 auf 48 402 — 188 Umschläge sind nie angekommen.
        stichprobe = (
            (0, 48402, "ältester behaltener Takt, direkt hinter der Verdrängung"),
            (behaltene_takte // 2, 48402 + behaltene_takte // 2, "Mitte des Replays"),
            (behaltene_takte - 1, 48402 + behaltene_takte - 1, "letzter Takt vor der Rückkehr"),
        )
        for tick, sequenz, hinweis in stichprobe:
            messzeit = verdraengt_bis + timedelta(minutes=tick)
            eingang = rueckkehr + timedelta(seconds=60 + tick // 60)
            zustellungen.append(Zustellung(
                topic=self.topic(box, "measurement-samples"),
                nutzlast=self.umschlag(
                    box, sequenz,
                    [self._sample(c, verdraengte_takte + tick, messzeit, mit_herkunft=True) for c in reihen],
                    messzeit,
                ),
                eingangszeit=_z(eingang), box=box,
                zustellart=_zustellart(messzeit, eingang), aus_outbox=True, hinweis=hinweis,
            ))
        # Zweiter Akt: die reparierte Box bringt am 12.11. einen Rest des verdrängten
        # Fensters — das Intervall ist längst endgültig (Ende + 7 Tage).
        spaet_eingang = _ortszeit("2026-11-12T09:02:00+01:00")
        spaet_messzeit = ausfall_von
        zustellungen.append(Zustellung(
            topic=self.topic(box, "measurement-samples"),
            nutzlast=self.umschlag(
                box, 62001,
                [self._sample("MS-10", 0, spaet_messzeit, mit_herkunft=True)],
                spaet_messzeit,
            ),
            eingangszeit=_z(spaet_eingang), box=box,
            zustellart=_zustellart(spaet_messzeit, spaet_eingang), aus_outbox=True,
            hinweis="Nachzügler der reparierten Box nach der Endgültigkeit des Intervalls",
        ))

        ereignisse = (
            self.cloud_ereignis(
                box, "writer", rueckkehr + timedelta(seconds=60),
                {
                    "art": "sequence_gap", "zeitpunkt": _z(rueckkehr + timedelta(seconds=60)),
                    "box": self.device_id(box), "strom": "measurement-samples",
                    "sequenz_erwartet": 48214, "sequenz_erhalten": 48402, "anzahl": 188,
                },
                "a4-sequence-gap",
            ),
            self.cloud_ereignis(
                box, "box", rueckkehr,
                {
                    "art": "data_gap", "von": _z(ausfall_von), "bis": _z(verdraengt_bis),
                    "erkannt_aus": "verdraengung", "box": self.device_id(box),
                    "datenquelle": "DQ-4", "erwartet_fehlend": 4 * verdraengte_takte,
                },
                "a4-data-gap-verdraengung",
                aus_umschlag=zustellungen[1],
            ),
            self.cloud_ereignis(
                box, "writer", spaet_eingang,
                {
                    "art": "late_arrival", "von": _z(spaet_messzeit),
                    "bis": _z(spaet_messzeit + timedelta(minutes=15)),
                    "komponente": KOMPONENTEN["MS-10"][0], "messkanal": KANAELE["MS-10"][0],
                    "messstelle": "MS-10", "box": self.device_id(box),
                    "eingangszeit": _z(spaet_eingang), "anzahl": 1,
                },
                "a4-late-arrival",
            ),
        )

        return Szenario(
            schluessel="A4",
            titel="Nachlieferung unvollständig — der Puffer hat verdrängt",
            quelle="AP-07 §7 A4",
            zustellungen=tuple(zustellungen),
            erwartete_ereignisse=ereignisse,
            erwartete_reihen=tuple(
                ErwarteteReihe(
                    messstelle=c, rohzeilen=len(stichprobe) + 1 + (1 if c == "MS-10" else 0),
                    hinweis="Randstichprobe des Replays, nicht der volle Puffer",
                )
                for c in reihen
            ),
            befunde=(
                "die verdrängten Messzeiten bleiben Lücke — für immer, ohne nachgeliefert_am (§4.5 E5.5/E5.6)",
                "der Nachzügler nach der Endgültigkeit wird gespeichert, der Viertelstundenwert bleibt endgültig "
                "(0 von 15) bis zur versionierten Korrektur in AP-08",
                "das Replay wird als Randstichprobe gespielt (5 Umschläge statt 7 200); die erwarteten Zeilen "
                "des vollen Puffers rechnet IP-21 aus verdraengte_takte/behaltene_takte",
            ),
        )

    # -- A6: Übergabe mit Nachzügler ---------------------------------------

    def a6_uebergabe_nachzuegler(self) -> Szenario:
        """A6: DQ-3 wechselt 10.04.2027 07:30 die Box; ein Nachzügler kommt danach."""
        wechsel = _ortszeit("2027-04-10T07:30:00+02:00")
        alt = self.ahrenberg.box_for("DQ-3", "2027-04-10T07:29:59+02:00")
        neu = self.ahrenberg.box_for("DQ-3", "2027-04-10T07:30:00+02:00")
        if alt is None or neu is None or alt.code == neu.code:
            raise ValueError("DQ-3 muss zum Wechsel die Box tauschen")
        reihen = ("MS-05", "MS-06", "MS-07", "MS-08")
        letzte_alt = _ortszeit("2027-04-10T07:29:50+02:00")
        erste_neu = _ortszeit("2027-04-10T07:31:10+02:00")

        zustellungen: list[Zustellung] = []
        for tick in range(3):
            messzeit = letzte_alt - timedelta(minutes=2 - tick)
            zustellungen.append(Zustellung(
                topic=self.topic(alt.code, "measurement-samples"),
                nutzlast=self.umschlag(
                    alt.code, 90500 + tick,
                    [self._sample(c, tick, messzeit, mit_herkunft=True) for c in reihen],
                    messzeit,
                ),
                eingangszeit=_z(messzeit + timedelta(seconds=2)), box=alt.code,
                hinweis="Box Halle 1 ist bis 07:29:50 zuständig",
            ))
        for tick in range(3):
            messzeit = erste_neu + timedelta(minutes=tick)
            zustellungen.append(Zustellung(
                topic=self.topic(neu.code, "measurement-samples"),
                nutzlast=self.umschlag(
                    neu.code, 400 + tick,
                    [self._sample(c, 3 + tick, messzeit, mit_herkunft=True) for c in reihen],
                    messzeit,
                ),
                eingangszeit=_z(messzeit + timedelta(seconds=2)), box=neu.code,
                hinweis="Box Halle 2 liest DQ-3 ab 07:31:10",
            ))
        # Zwei Nachzügler der alten Box, einer diesseits, einer jenseits des Wechsels.
        nachzuegler_eingang = _ortszeit("2027-04-10T07:33:00+02:00")
        zustellungen.append(Zustellung(
            topic=self.topic(alt.code, "measurement-samples"),
            nutzlast=self.umschlag(
                alt.code, 90503,
                [self._sample(c, 3, letzte_alt, mit_herkunft=True) for c in reihen],
                letzte_alt,
            ),
            eingangszeit=_z(nachzuegler_eingang), box=alt.code,
            zustellart=_zustellart(letzte_alt, nachzuegler_eingang), aus_outbox=True,
            hinweis="Nachzügler mit Messzeit VOR dem Wechsel: bleibt führend (Zuständigkeit zur Messzeit)",
        ))
        nach_wechsel = _ortszeit("2027-04-10T07:30:50+02:00")
        zustellungen.append(Zustellung(
            topic=self.topic(alt.code, "measurement-samples"),
            nutzlast=self.umschlag(
                alt.code, 90504,
                [self._sample(c, 4, nach_wechsel, mit_herkunft=True) for c in reihen],
                nach_wechsel,
            ),
            eingangszeit=_z(nachzuegler_eingang + timedelta(seconds=1)), box=alt.code,
            zustellart=_zustellart(nach_wechsel, nachzuegler_eingang + timedelta(seconds=1)),
            aus_outbox=True,
            hinweis="Nachzügler mit Messzeit NACH dem Wechsel: Rolle spiegel, nie führend",
        ))

        ereignisse = [
            self.cloud_ereignis(
                alt.code, "cloud", wechsel,
                {
                    "art": "handover", "von": _z(wechsel), "bis": _z(wechsel + timedelta(minutes=1)),
                    "datenquelle": "DQ-3", "anlass": "uebergabe",
                    "box_alt": self.device_id(alt.code), "box_neu": self.device_id(neu.code),
                },
                "a6-handover",
            ),
        ]
        for code in reihen:
            ereignisse.append(self.cloud_ereignis(
                alt.code, "writer", nachzuegler_eingang + timedelta(seconds=1),
                {
                    "art": "unassigned_reader", "von": _z(nach_wechsel), "bis": _z(nach_wechsel),
                    "box": self.device_id(alt.code), "datenquelle": "DQ-3",
                    "komponente": KOMPONENTEN[code][0], "messkanal": KANAELE[code][0],
                    "anzahl": 1, "zustaendige_box": self.device_id(neu.code),
                },
                f"a6-unassigned-{code}",
            ))

        return Szenario(
            schluessel="A6",
            titel="Edge-Wechsel DQ-3 mit Herkunftswechsel und Nachzügler",
            quelle="AP-07 §7 A6",
            zustellungen=tuple(zustellungen),
            erwartete_ereignisse=tuple(ereignisse),
            erwartete_reihen=tuple(
                ErwarteteReihe(messstelle=c, rohzeilen=7, hinweis="6 führende Takte + 1 Nachzügler vor dem Wechsel")
                for c in reihen
            ) + tuple(
                ErwarteteReihe(messstelle=c, rohzeilen=1, rolle="spiegel",
                               hinweis="Nachzügler der alten Box mit Messzeit nach dem Wechsel")
                for c in reihen
            ),
            befunde=(
                f"die Zuständigkeit löst der Zwei-Boxen-Simulator auf: {alt.code} → {neu.code} "
                "(die Nachfolgerin von Box Halle 2 heißt E-2′, AP-06 E7)",
                "Befund zum Abnahmetext „beide Boxen als Anker“: mit dem letzten führenden Wert um 07:29:50 "
                "hat die Viertelstunde 07:30–07:45 nur Box Halle 2 als Anker; beide Boxen erscheinen erst "
                "in der Herkunfts-Karte, weil das Intervall eine Spiegelzeile der alten Box trägt",
            ),
        )

    # -- A13: Uhr der Box geht vor -----------------------------------------

    def a13_uhr_vor(self) -> Szenario:
        """A13: Box Lindach stempelt 14 Minuten in die Zukunft."""
        box = "E-3"
        reihen = ("MS-17", "MS-18")
        vor_s = 14 * 60
        gut = _ortszeit("2026-10-20T09:11:00+02:00")
        beginn_fehler = _ortszeit("2026-10-20T09:12:00+02:00")
        korrektur = _ortszeit("2026-10-20T10:30:00+02:00")

        zustellungen: list[Zustellung] = [
            Zustellung(
                topic=self.topic(box, "measurement-samples"),
                nutzlast=self.umschlag(box, 7815, [self._sample(c, 0, gut, mit_herkunft=True) for c in reihen], gut),
                eingangszeit=_z(gut + timedelta(seconds=2)), box=box,
                hinweis="letzter Wert vor dem Uhrfehler",
            ),
        ]
        # Drei Umschläge mit Messzeit 14 min in der Zukunft — jeder wird abgewiesen.
        for tick in range(3):
            eingang = beginn_fehler + timedelta(minutes=tick)
            gestempelt = eingang + timedelta(seconds=vor_s)
            zustellungen.append(Zustellung(
                topic=self.topic(box, "measurement-samples"),
                nutzlast=self.umschlag(
                    box, 7816 + tick,
                    [self._sample(c, 1 + tick, gestempelt, mit_herkunft=True) for c in reihen],
                    gestempelt,
                ),
                eingangszeit=_z(eingang), box=box,
                hinweis="Messzeit 840 s nach dem Eingang: abgewiesen, keine Rohwerte in der Zukunft",
            ))
        # Die Vergangenheit bleibt unberührt: ein Nachzügler mit alter Messzeit geht durch.
        alt = gut - timedelta(minutes=30)
        zustellungen.append(Zustellung(
            topic=self.topic(box, "measurement-samples"),
            nutzlast=self.umschlag(box, 7819, [self._sample(c, -30, alt, mit_herkunft=True) for c in reihen], alt),
            eingangszeit=_z(beginn_fehler + timedelta(minutes=3)), box=box,
            zustellart=_zustellart(alt, beginn_fehler + timedelta(minutes=3)), aus_outbox=True,
            hinweis="Nachlieferung mit Messzeit in der Vergangenheit: unberührt vom Uhrfehler",
        ))
        # Nach dem Stellen der Uhr laufen die Werte normal weiter.
        for tick in range(2):
            messzeit = korrektur + timedelta(minutes=tick)
            zustellungen.append(Zustellung(
                topic=self.topic(box, "measurement-samples"),
                nutzlast=self.umschlag(
                    box, 7820 + tick,
                    [self._sample(c, 80 + tick, messzeit, mit_herkunft=True) for c in reihen],
                    messzeit,
                ),
                eingangszeit=_z(messzeit + timedelta(seconds=2)), box=box,
                hinweis="Uhr gestellt: normale Werte",
            ))

        ereignisse = tuple(
            self.cloud_ereignis(
                box, "datenannahme", beginn_fehler + timedelta(minutes=tick),
                {
                    "art": "clock_ahead", "zeitpunkt": _z(beginn_fehler + timedelta(minutes=tick)),
                    "box": self.device_id(box), "strom": "measurement-samples",
                    "vor_s": vor_s, "anzahl": len(reihen), "sequenz": 7816 + tick,
                },
                f"a13-clock-ahead-{tick}",
            )
            for tick in range(3)
        )

        return Szenario(
            schluessel="A13",
            titel="Uhr der Box Lindach geht vor",
            quelle="AP-07 §7 A13",
            zustellungen=tuple(zustellungen),
            erwartete_ereignisse=ereignisse,
            erwartete_reihen=tuple(
                ErwarteteReihe(messstelle=c, rohzeilen=4,
                               hinweis="1 vor dem Fehler + 1 Nachlieferung + 2 nach der Korrektur")
                for c in reihen
            ),
            befunde=(
                "seit IP-5 ist das Sample die Einheit der Zeitprüfung: alle Samples des Umschlags sind "
                "840 s voraus, deshalb bleibt vom Umschlag nichts übrig (§4.5 E13.3)",
                "die Vergangenheit bleibt unberührt — die Nachlieferung mit alter Messzeit wird gespeichert",
            ),
        )

    def alle(self) -> tuple[Szenario, ...]:
        return (
            self.a1_doppel_zustellung(),
            self.a3_ausfall_nachlieferung(),
            self.a4_verdraengung(),
            self.a6_uebergabe_nachzuegler(),
            self.a13_uhr_vor(),
        )


def szenarien(ahrenberg: AhrenbergScenario | None = None) -> dict[str, Szenario]:
    """Alle fünf Szenarien nach Schlüssel — die Naht zu AP-07 IP-21."""
    return {szenario.schluessel: szenario for szenario in Streckenszenarien(ahrenberg).alle()}


STAMM_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://voltpilot.example/uems/ap07/ip21")


def _stamm_id(schluessel: str) -> str:
    return str(uuid.uuid5(STAMM_NAMESPACE, schluessel))


def stammdaten(s: Szenario) -> dict:
    """Die Stammdaten, die EIN Szenario braucht, damit die Strecke es lesen kann.

    Das IP-20-Drehbuch nennt Zustellungen und Erwartungen, nicht die Zeilen, die
    vorher in der Datenbank stehen müssen (Zuständigkeit, Bindung, Gerät-Einbau).
    Sie werden hier AUS dem Szenario abgeleitet — nie im Java-Lauf erfunden, der
    sonst seine eigene Annahme prüfen würde statt des Vertrags.
    """
    punkt_zu_code = {punkt: code for code, (_, punkt) in KANAELE.items()}

    boxen: list[str] = []
    geraete: dict[str, str] = {}
    anlagen: dict[str, str] = {}
    box_der_reihe: dict[str, str] = {}
    messzeiten: list[str] = []
    for z in s.zustellungen:
        if z.box not in boxen:
            boxen.append(z.box)
            geraete[z.box] = z.nutzlast["device_id"]
            anlagen[z.box] = z.nutzlast["site_id"]
        for sample in z.nutzlast.get("samples", ()):
            messzeiten.append(sample["observed_at"])
            # A1 hängt einen Kanal-Index an den Punktschlüssel (256 Punkte über fünf Reihen).
            punkt = sample["point_key"]
            code = punkt_zu_code.get(punkt) or punkt_zu_code.get(punkt.rsplit(".", 1)[0])
            if code is not None:
                box_der_reihe.setdefault(code, z.box)

    beginn = min(messzeiten) if messzeiten else s.zustellungen[0].eingangszeit
    # Ein voller Tag Vorlauf: Zuständigkeit und Einbau bestehen VOR dem ersten Wert.
    von = _z(datetime.fromisoformat(beginn.replace("Z", "+00:00")) - timedelta(days=1))

    # Die Übergabe steht als Ereignis im Drehbuch; ohne sie gehört jede Box ihrer Quelle.
    uebergabe = next(
        (e["ereignis"] for e in s.erwartete_ereignisse if e["ereignis"]["art"] == "handover"),
        None,
    )
    zustaendigkeiten: list[dict] = []
    quelle_der_reihe: dict[str, str] = {}
    if uebergabe is not None:
        quelle_id = _stamm_id(f"quelle:{s.schluessel}:{uebergabe['datenquelle']}")
        zustaendigkeiten = [
            {"datenquelle_id": quelle_id, "kennzeichen": uebergabe["datenquelle"], "kadenz_s": 60,
             "device_id": uebergabe["box_alt"], "von": von, "bis": uebergabe["von"]},
            {"datenquelle_id": quelle_id, "kennzeichen": uebergabe["datenquelle"], "kadenz_s": 60,
             "device_id": uebergabe["box_neu"], "von": uebergabe["von"], "bis": None},
        ]
        for code in box_der_reihe:
            quelle_der_reihe[code] = quelle_id
    else:
        for box in boxen:
            kennzeichen = f"DQ-{s.schluessel}-{box}"
            quelle_id = _stamm_id(f"quelle:{s.schluessel}:{kennzeichen}")
            zustaendigkeiten.append(
                {"datenquelle_id": quelle_id, "kennzeichen": kennzeichen, "kadenz_s": 60,
                 "device_id": geraete[box], "von": von, "bis": None})
            for code, b in box_der_reihe.items():
                if b == box:
                    quelle_der_reihe[code] = quelle_id

    # Je Reihe genau EIN Gerät mit EINEM Einbau; der Punktschlüssel am Draht ist der
    # des Drehbuchs, der Katalogname der der führenden Quelle des Referenzunternehmens.
    reihen = []
    for code, box in box_der_reihe.items():
        komponente, entity_id = KOMPONENTEN[code]
        kanal, punkt = KANAELE[code]
        reihen.append({
            "messstelle": code,
            "messstelle_id": _stamm_id(f"messstelle:{s.schluessel}:{code}"),
            "entity_id": entity_id,
            "komponente": komponente,
            "geraet_id": _stamm_id(f"geraet:{s.schluessel}:{code}"),
            "einbau_kennzeichen": f"{komponente}-E1",
            "kanal": kanal,
            "point_key": punkt,
            "box": box,
            "device_id": geraete[box],
            "site_id": anlagen[box],
            "datenquelle_id": quelle_der_reihe[code],
            "eingebaut_am": von,
            "gebunden_ab": von,
        })

    return {
        "tenant_id": s.zustellungen[0].nutzlast["tenant_id"],
        "boxen": [{"box": b, "device_id": geraete[b], "site_id": anlagen[b]} for b in boxen],
        "zustaendigkeiten": zustaendigkeiten,
        "reihen": reihen,
    }


def abnahme_fixture(ausgewaehlt: list[Szenario] | None = None) -> dict:
    """Die vollstaendige Abnahme-Vorlage fuer AP-07 IP-21 — Java liest sie als JSON.

    Der Java-Lauf startet kein Python. Damit Vorlage und Simulator nicht
    auseinanderlaufen, traegt die Datei eine Pruefsumme ueber ihren eigenen
    Inhalt: der Waechter hier erzeugt sie neu und vergleicht, der Java-Lauf
    rechnet sie aus der gelesenen Datei nach.
    """
    liste = list(ausgewaehlt if ausgewaehlt is not None else szenarien().values())
    inhalt = {
        "vertrag": "AP-07 IP-21 Abnahme-Vorlage",
        "quelle": "tools/edge-simulator/uems_szenarien.py",
        "szenarien": [
            {
                "szenario": s.schluessel,
                "titel": s.titel,
                "herkunft": s.quelle,
                "erwartet_wiederholt": s.erwartet_wiederholt,
                "befunde": list(s.befunde),
                "stammdaten": stammdaten(s),
                "zustellungen": [
                    {
                        "topic": z.topic,
                        "eingangszeit": z.eingangszeit,
                        "box": z.box,
                        "strom": z.strom,
                        "zustellart": z.zustellart,
                        "dup": z.dup,
                        "aus_outbox": z.aus_outbox,
                        "sequenz": z.sequenz,
                        "hinweis": z.hinweis,
                        "nutzlast": z.nutzlast,
                    }
                    for z in s.zustellungen
                ],
                "erwartete_ereignisse": [dict(e) for e in s.erwartete_ereignisse],
                "erwartete_reihen": [vars(r) for r in s.erwartete_reihen],
            }
            for s in liste
        ],
    }
    return {"pruefsumme": pruefsumme(inhalt), **inhalt}


def pruefsumme(inhalt: dict) -> str:
    """sha256 ueber den kanonisch geschriebenen Inhalt OHNE das Pruefsummenfeld."""
    ohne = {k: v for k, v in inhalt.items() if k != "pruefsumme"}
    kanonisch = json.dumps(ohne, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(kanonisch.encode("utf-8")).hexdigest()


def fixture_text(ausgewaehlt: list[Szenario] | None = None) -> str:
    """Genau die Bytes, die in der eingecheckten Datei stehen (mit Zeilenende)."""
    return json.dumps(abnahme_fixture(ausgewaehlt), ensure_ascii=False, indent=2,
                      sort_keys=True) + "\n"


def spiele(szenario: Szenario, veroeffentliche, *, echo=None) -> int:
    """Spielt die Zustellungen in ihrer Reihenfolge; `veroeffentliche(zustellung)` sendet."""
    for nummer, zustellung in enumerate(szenario.zustellungen, start=1):
        veroeffentliche(zustellung)
        if echo is not None and (nummer % 50 == 0 or nummer == len(szenario.zustellungen)):
            echo(f"{szenario.schluessel}: {nummer}/{len(szenario.zustellungen)} Zustellungen")
    return len(szenario.zustellungen)


def _broker_veroeffentlicher(host: str, port: int, *, tls: bool, benutzer: str | None, kennwort: str | None):
    try:
        import paho.mqtt.client as mqtt
    except ImportError as fehler:  # pragma: no cover - nur ohne Abhängigkeit
        raise SystemExit("paho-mqtt fehlt: pip install -r requirements.txt") from fehler

    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)
    except AttributeError:  # paho-mqtt 1.6.x
        client = mqtt.Client()
    if benutzer:
        client.username_pw_set(benutzer, kennwort)
    if tls:
        client.tls_set()
    client.connect(host, port, keepalive=30)
    client.loop_start()

    def veroeffentliche(zustellung: Zustellung) -> None:
        nachricht = client.publish(
            zustellung.topic,
            json.dumps(zustellung.nutzlast, ensure_ascii=False, separators=(",", ":")),
            qos=zustellung.qos,
            retain=zustellung.retain,
        )
        nachricht.wait_for_publish(timeout=30)

    return client, veroeffentliche


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="AP-07 IP-20: Störungs-Szenarien der Messdatenstrecke",
        epilog="Ohne --broker wird nur der Plan gedruckt; der Broker kommt aus VP_SIM_BROKER.",
    )
    parser.add_argument("--szenario", action="append", choices=["A1", "A3", "A4", "A6", "A13"],
                        help="Einzelnes Szenario; mehrfach erlaubt. Vorgabe: alle.")
    parser.add_argument("--plan", action="store_true", help="nur den Plan als JSON ausgeben")
    parser.add_argument("--zustellungen", action="store_true", help="die vollständigen Nutzlasten als JSON ausgeben")
    parser.add_argument("--abnahme", action="store_true",
                        help="die Abnahme-Vorlage für AP-07 IP-21 als JSON ausgeben (mit Prüfsumme)")
    parser.add_argument("--broker", default=os.environ.get("VP_SIM_BROKER"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("VP_SIM_PORT", "1883")))
    parser.add_argument("--tls", action="store_true", default=os.environ.get("VP_SIM_TLS") == "1")
    parser.add_argument("--benutzer", default=os.environ.get("VP_SIM_USER"))
    parser.add_argument("--kennwort", default=os.environ.get("VP_SIM_PASSWORD"))
    args = parser.parse_args(argv)

    alle = szenarien()
    ausgewaehlt = [alle[key] for key in (args.szenario or list(alle))]

    if args.abnahme:
        sys.stdout.write(fixture_text(ausgewaehlt))
        return 0

    if args.zustellungen:
        print(json.dumps(
            [{"szenario": s.schluessel,
              "zustellungen": [{"topic": z.topic, "eingangszeit": z.eingangszeit, "dup": z.dup,
                                "zustellart": z.zustellart, "nutzlast": z.nutzlast} for z in s.zustellungen]}
             for s in ausgewaehlt],
            ensure_ascii=False, indent=2))
        return 0

    if args.plan or not args.broker:
        print(json.dumps([s.plan() for s in ausgewaehlt], ensure_ascii=False, indent=2))
        if not args.broker and not args.plan:
            print("Kein Broker genannt (--broker oder VP_SIM_BROKER) — nur der Plan wurde gedruckt.",
                  file=sys.stderr)
        return 0

    client, veroeffentliche = _broker_veroeffentlicher(
        args.broker, args.port, tls=args.tls, benutzer=args.benutzer, kennwort=args.kennwort
    )
    try:
        gesamt = 0
        for szenario in ausgewaehlt:
            gesamt += spiele(szenario, veroeffentliche, echo=lambda zeile: print(zeile, file=sys.stderr))
        print(json.dumps({"broker": args.broker, "szenarien": [s.schluessel for s in ausgewaehlt],
                          "zustellungen": gesamt}, ensure_ascii=False))
    finally:
        client.loop_stop()
        client.disconnect()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
