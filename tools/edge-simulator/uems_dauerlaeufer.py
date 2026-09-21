#!/usr/bin/env python3
"""AP-14 IP-18 (Kasten E11): der Dauerläufer — zwei simulierte Ahrenberg-Boxen als Dauerarbeit.

Der interne Kundenbereich „VoltPilot Dauerläufer (intern)“ geht in Produktion dauerhaft den Weg
Box → ingest → Writer → Messreihe → Bericht. Dieses Programm ist seine Box-Seite:

* **Ahrenberg, zwei Box-Identitäten.** E-1 liest MS-05…MS-08, E-2 liest MS-10…MS-14 (dieselben
  Reihen und Zählerstände wie ``uems_szenarien``); die Kennungen am Draht kommen aber aus der
  Umgebung — es sind die Kennungen, die der Betreiber im Dauerläufer-Kundenbereich anlegt, nie
  die festen Ahrenberg-Kennungen der Verträge.
* **Er lernt seine Schlüssel wie eine echte Box** (IP-18-Einrichtung, Weg a+). Hinter jeder Box
  steht ein Modbus-Gateway mit einem Zählerregister je Messstelle (``GATEWAY``, ``register``).
  Der Simulator beantwortet die Registerlesung des Baukastens (``v2/probe``, Op ``read``), lernt die
  Mess-Auswahl, die die Plattform der Box zustellt (``v2/measurement-config``, gehalten), quittiert
  sie (``v2/measurement-config-status``) und sendet genau die zugestellten Schlüssel. Ohne
  Zustellung sendet er nichts — wie eine Box ohne Plan. Der Betreiber überträgt keinen Schlüssel.
* **Normalbetrieb, keine Störung.** Ein Umschlag je Box und Minute, Messzeit auf der Minute,
  Zählerstände steigen stetig. Die Störungs-Szenarien A1…A13 sind hier absichtlich NICHT
  erreichbar (``test_uems_dauerlaeufer`` hält das fest).
* **Endlos und neustartfest ohne Zustand.** Takt, Sequenz und Zählerstand sind Funktionen der
  Minute seit 1970 — nach einem Neustart laufen Sequenz und Zähler dort weiter, wo sie ohne
  Neustart stünden; kein Sequenz-Reset, kein Zählerbruch.
* **Übersteht Broker-Trennung.** paho verbindet selbst neu; QoS-1-Umschläge warten solange in
  der Warteschlange (höchstens ``MAX_WARTESCHLANGE``, ein Tag).
* **Sauberes Ende auf SIGTERM/SIGINT** und ein **Lebenszeichen** (Datei), das eine
  Kubernetes-Probe mit ``--probe`` prüft.

Die Zugangsdaten stehen NIE im Repo: Zertifikat und Schlüssel je Box liegen als Dateien im
eingehängten Geheimnis (siehe ``.env.dauerlaeufer.example``).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Mapping

from uems_szenarien import ANFANGSSTAND, KANAELE, KATALOGSTAND, ZUWACHS, _z

TAKT_S = 60
#: Die Messstellen je Box — dieselbe Aufteilung wie A3 (E-1 Halle 1, E-2 Halle 2).
BOX_REIHEN: dict[str, tuple[str, ...]] = {
    "E-1": ("MS-05", "MS-06", "MS-07", "MS-08"),
    "E-2": ("MS-10", "MS-11", "MS-12", "MS-13", "MS-14"),
}
#: Ein Tag Minutentakt je Box; danach verwirft paho, statt den Speicher zu füllen.
MAX_WARTESCHLANGE = 24 * 60
LEBENSZEICHEN = "/tmp/dauerlaeufer-lebenszeichen"
#: Die Probe hält die Schleife für tot, wenn drei Takte lang kein Lebenszeichen kam.
PROBE_GRENZE_S = 3 * TAKT_S


@dataclass(frozen=True)
class BoxZugang:
    """Eine Box-Identität des Dauerläufers — Kennungen und die Pfade ihres Geheimnisses."""

    code: str
    site_id: str
    device_id: str
    zertifikat: str | None = None
    schluessel: str | None = None


@dataclass(frozen=True)
class Konfiguration:
    tenant_id: str
    boxen: tuple[BoxZugang, ...]
    broker: str | None
    port: int = 8883
    ca: str | None = None
    tls: bool = True
    lebenszeichen: str = LEBENSZEICHEN


def _uuid(name: str, wert: str | None) -> str:
    if not wert:
        raise ValueError(f"{name} fehlt")
    try:
        kennung = str(uuid.UUID(wert.strip()))
    except ValueError:
        raise ValueError(f"{name} ist keine UUID") from None
    if kennung != wert.strip().lower():
        raise ValueError(f"{name} ist keine kanonische UUID")
    return kennung


def konfiguration(umgebung: Mapping[str, str]) -> Konfiguration:
    """Liest ``VP_DAUERLAEUFER_*``; eine fehlende oder falsche Kennung bricht vor dem Senden ab."""
    tenant = _uuid("VP_DAUERLAEUFER_TENANT", umgebung.get("VP_DAUERLAEUFER_TENANT"))
    boxen = []
    for code, praefix in (("E-1", "VP_DAUERLAEUFER_E1"), ("E-2", "VP_DAUERLAEUFER_E2")):
        boxen.append(BoxZugang(
            code=code,
            site_id=_uuid(f"{praefix}_SITE", umgebung.get(f"{praefix}_SITE")),
            device_id=_uuid(f"{praefix}_DEVICE", umgebung.get(f"{praefix}_DEVICE")),
            zertifikat=umgebung.get(f"{praefix}_CERT") or None,
            schluessel=umgebung.get(f"{praefix}_KEY") or None,
        ))
    if boxen[0].device_id == boxen[1].device_id:
        raise ValueError("zwei Box-Identitäten verlangen zwei verschiedene Geräte")
    return Konfiguration(
        tenant_id=tenant,
        boxen=tuple(boxen),
        broker=umgebung.get("VP_DAUERLAEUFER_BROKER") or None,
        port=int(umgebung.get("VP_DAUERLAEUFER_PORT", "8883")),
        ca=umgebung.get("VP_DAUERLAEUFER_CA") or None,
        tls=umgebung.get("VP_DAUERLAEUFER_TLS", "1") != "0",
        lebenszeichen=umgebung.get("VP_DAUERLAEUFER_LEBENSZEICHEN", LEBENSZEICHEN),
    )


def takt_von(unix_s: float) -> int:
    """Die Minute seit 1970 — Takt, Sequenz und Zählerfortschritt in einem."""
    return int(unix_s // TAKT_S)


#: Die Zähler hinter den Boxen, so wie der Betreiber sie im Modbus-Baukasten anlegt (Drehbuch §14.2):
#: je Halle ein Modbus-TCP-Gateway (Port 502, Unit 1), je Messstelle ein Eingangsregister-Paar
#: (u32, hohes Wort zuerst, ×0,1 kWh). Die Adresse ist die Messstellennummer mal hundert.
GATEWAY: dict[str, str] = {"E-1": "10.99.1.10", "E-2": "10.99.2.10"}
GATEWAY_PORT = 502
GATEWAY_UNIT = 1
SKALA = 0.1
#: Steht in jeder Quittung (``edge_version``): so sieht die Plattform, wer quittiert hat.
EDGE_VERSION = "voltpilot-dauerlaeufer/2"
#: Die Kadenz, die der Betreiber je Messwert einträgt — ein Takt.
KADENZ_S = TAKT_S


def register(messstelle: str) -> int:
    """MS-05 liegt auf 500, MS-14 auf 1400."""
    return int(messstelle.split("-")[1]) * 100


def messstelle_am_register(box_code: str, adresse) -> str | None:
    for messstelle in BOX_REIHEN[box_code]:
        if register(messstelle) == adresse:
            return messstelle
    return None


def zaehlerstand(messstelle: str, takt: int) -> int:
    """Der Rohwert im Register: stetig steigend, eine Funktion der Minute seit 1970."""
    return ANFANGSSTAND[messstelle] + ZUWACHS[messstelle] * takt


def eigener_messwert(messstelle: str) -> dict:
    """Die Felder für „Eigenen Messwert hinzufügen“ — genau die, die der Simulator annimmt."""
    adresse = register(messstelle)
    return {
        "label": f"{messstelle} {KANAELE[messstelle][0]}",
        "sourceKind": "modbus_input",
        "address": adresse,
        "selector": f"input:0x{adresse:04x}",
        "valueType": "uint32",
        "widthBits": 32,
        "signed": False,
        "endian": "big",
        "scale": SKALA,
        "unit": "kWh",
        "cadenceS": KADENZ_S,
        "retentionClass": "energy_counter",
        "readOnly": True,
    }


def _basis(tenant_id: str, box: BoxZugang) -> str:
    return f"ems/{tenant_id}/{box.site_id}/{box.device_id}/v2"


def topic(tenant_id: str, box: BoxZugang) -> str:
    return f"{_basis(tenant_id, box)}/measurement-samples"


def auswahl_topic(tenant_id: str, box: BoxZugang) -> str:
    return f"{_basis(tenant_id, box)}/measurement-config"


def quittung_topic(tenant_id: str, box: BoxZugang) -> str:
    return f"{_basis(tenant_id, box)}/measurement-config-status"


def probe_topic(tenant_id: str, box: BoxZugang) -> str:
    return f"{_basis(tenant_id, box)}/probe"


def probe_antwort_topic(tenant_id: str, box: BoxZugang) -> str:
    return f"{_basis(tenant_id, box)}/probe-result"


@dataclass
class Gedaechtnis:
    """Was eine Box aus der Zustellung gelernt hat — nur im Speicher. Nach einem Neustart stellt der
    Broker die gehaltene Auswahl erneut zu; eine Datei auf der Platte gibt es nicht."""

    revision: int | None = None
    #: Messstelle → (Punktschlüssel der Plattform, Skala der Auswahl)
    gelernt: dict[str, tuple[str, float]] = field(default_factory=dict)


def _gleiche_identitaet(tenant_id: str, box: BoxZugang, nutzlast: dict) -> bool:
    return (nutzlast.get("tenant_id"), nutzlast.get("site_id"), nutzlast.get("device_id")) == (
        tenant_id, box.site_id, box.device_id)


def _zeit(jetzt: float) -> str:
    return _z(datetime.fromtimestamp(jetzt, tz=timezone.utc))


def auswahl_lernen(tenant_id: str, box: BoxZugang, dokument, gedaechtnis: Gedaechtnis,
                   jetzt: float) -> dict | None:
    """Wendet eine zugestellte Mess-Auswahl an und gibt die Quittung zurück (oder ``None``).

    Wie der Box-Kern (``x-revision-rule``): fremde Identität, kaputtes Dokument und eine ältere
    oder gleiche Revision werden ignoriert; sonst gilt die ganze Auswahl auf einmal. Angenommen wird
    jeder eigene Messwert, der als u32-Eingangsregister auf einem Zähler dieser Box liegt; alles
    andere lehnt die Box benannt ab (``unknown_point``) und liest es nie geraten.
    """
    if not isinstance(dokument, dict) or dokument.get("schema_version") != "2.0" \
            or not _gleiche_identitaet(tenant_id, box, dokument):
        return None
    revision = dokument.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        return None
    if gedaechtnis.revision is not None and revision <= gedaechtnis.revision:
        return None
    angenommen: list[str] = []
    abgelehnt: list[dict] = []
    gelernt: dict[str, tuple[str, float]] = {}
    for auswahl in dokument.get("selections") or []:
        schluessel = auswahl.get("point_key")
        definition = auswahl.get("definition") or {}
        messstelle = messstelle_am_register(box.code, definition.get("address")) \
            if isinstance(schluessel, str) and schluessel.startswith("custom.") else None
        skala = definition.get("scale")
        if (messstelle is not None and messstelle not in gelernt
                and definition.get("sourceKind") == "modbus_input"
                and definition.get("valueType") == "uint32" and definition.get("endian") == "big"
                and isinstance(skala, (int, float)) and not isinstance(skala, bool)):
            gelernt[messstelle] = (schluessel, float(skala))
            angenommen.append(schluessel)
        else:
            abgelehnt.append({"point_key": schluessel, "reason": "unknown_point"})
    gedaechtnis.revision = revision
    gedaechtnis.gelernt = gelernt
    return {
        "schema_version": "2.0",
        "tenant_id": tenant_id,
        "site_id": box.site_id,
        "device_id": box.device_id,
        "revision": revision,
        "applied_at": _zeit(jetzt),
        "accepted": angenommen,
        "rejected": abgelehnt,
        "edge_version": EDGE_VERSION,
    }


def _gelesen(box: BoxZugang, op: dict, takt: int) -> dict:
    kennung = op.get("id")
    if op.get("op") != "read" or op.get("transport") != "modbus_tcp":
        return {"id": kennung, "ok": False, "error_code": "not_supported",
                "message": "Der Dauerläufer beantwortet nur Registerlesungen seiner Zähler."}
    if op.get("host") != GATEWAY[box.code] or op.get("port", 502) != GATEWAY_PORT \
            or op.get("unit_id", 1) != GATEWAY_UNIT:
        return {"id": kennung, "ok": False, "error_code": "unreachable",
                "message": "Unter dieser Adresse antwortet kein Gerät."}
    messstelle = messstelle_am_register(box.code, op.get("address"))
    if messstelle is None or op.get("register_kind") != "input" or op.get("data_type") != "u32":
        return {"id": kennung, "ok": False, "error_code": "no_answer",
                "message": "Das Gerät kennt dieses Register nicht."}
    roh = zaehlerstand(messstelle, takt)
    woerter = [roh >> 16, roh & 0xFFFF]
    if op.get("word_order", "big") == "little":
        roh = (woerter[1] << 16) | woerter[0]
    wert = roh * op.get("scale", 1) + op.get("offset", 0)
    return {"id": kennung, "ok": True, "raw": roh, "registers": woerter, "value": round(wert, 6)}


def probe_antwort(tenant_id: str, box: BoxZugang, anfrage, jetzt: float) -> dict | None:
    """Beantwortet eine Probe-Anfrage (``mqtt-probe``) wie eine Box, die ihre Zähler liest."""
    if not isinstance(anfrage, dict) or anfrage.get("type") != "probe_request" \
            or not _gleiche_identitaet(tenant_id, box, anfrage):
        return None
    takt = takt_von(jetzt)
    return {
        "schema_version": "1.0",
        "type": "probe_result",
        "tenant_id": tenant_id,
        "site_id": box.site_id,
        "device_id": box.device_id,
        "request_id": anfrage.get("request_id"),
        "answered_at": _zeit(jetzt),
        "results": [_gelesen(box, op, takt) for op in anfrage.get("ops") or []],
    }


def umschlag(tenant_id: str, box: BoxZugang, takt: int,
             gelernt: Mapping[str, tuple[str, float]]) -> dict | None:
    """Ein ``mqtt-measurement-samples`` 2.0-Umschlag im Normalbetrieb — nur gelernte Messstellen."""
    messzeit = datetime.fromtimestamp(takt * TAKT_S, tz=timezone.utc)
    samples = []
    for messstelle in BOX_REIHEN[box.code]:
        if messstelle not in gelernt:
            continue
        schluessel, skala = gelernt[messstelle]
        roh = zaehlerstand(messstelle, takt)
        samples.append({
            "point_key": schluessel,
            "raw": roh,
            "decoded": round(roh * skala, 3),
            "quality": "good",
            "observed_at": _z(messzeit),
        })
    if not samples:
        return None
    return {
        "schema_version": "2.0",
        "tenant_id": tenant_id,
        "site_id": box.site_id,
        "device_id": box.device_id,
        "catalog_version": KATALOGSTAND,
        "sequence": takt,
        "observed_at": _z(messzeit),
        "samples": samples,
    }


def draht(nutzlast: dict) -> bytes:
    return json.dumps(nutzlast, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def beispiel_schluessel(messstelle: str) -> str:
    """Ein Schlüssel in der Form, die die Plattform vergibt (``custom.<32 Hex>``) — nur für Vorlage und
    Mengenrechnung; im Betrieb stammt jeder Schlüssel aus der Zustellung."""
    return "custom." + hashlib.md5(f"dauerlaeufer/{messstelle}".encode("utf-8")).hexdigest()


def beispiel_gelernt(box_code: str) -> dict[str, tuple[str, float]]:
    return {m: (beispiel_schluessel(m), SKALA) for m in BOX_REIHEN[box_code]}


def bytes_je_tag(tenant_id: str, boxen: tuple[BoxZugang, ...]) -> dict:
    """Rechnet die Datenmenge eines Tages aus echten Umschlägen vor (Nutzlast, ohne MQTT-Kopf)."""
    takte = 24 * 60 * 60 // TAKT_S
    beispiel = takt_von(datetime(2026, 11, 3, tzinfo=timezone.utc).timestamp())
    je_box = {b.code: len(draht(umschlag(tenant_id, b, beispiel, beispiel_gelernt(b.code)))) * takte
              for b in boxen}
    return {
        "umschlaege": takte * len(boxen),
        "samples": takte * sum(len(BOX_REIHEN[b.code]) for b in boxen),
        "nutzlast_bytes": sum(je_box.values()),
        "je_box_bytes": je_box,
    }


#: NW-6 im Kleinen: feste Testkennungen der Vorlage. Der Java-Lauf ersetzt sie durch die, die die
#: Plattform beim Anlegen vergibt (die Tenant-UUID lässt sich nicht vorgeben, Drehbuch §14.1).
NW6_TENANT = "e1b07da2-5f48-4330-a46b-6457ab9fb020"
NW6_BOXEN = (
    BoxZugang("E-1", "d1000000-0000-4000-8000-000000000001", "d1b00000-0000-4000-8000-000000000001"),
    BoxZugang("E-2", "d1000000-0000-4000-8000-000000000002", "d1b00000-0000-4000-8000-000000000002"),
)
#: Fünf Takte je Box; der letzte liegt eine Minute vor 2026-11-03T10:00:00Z, dem „Jetzt“ des Laufs.
NW6_ERSTER_TAKT = takt_von(datetime(2026, 11, 3, 9, 55, tzinfo=timezone.utc).timestamp())
NW6_TAKTE = 5
#: Die Einrichtung davor: Baukasten-Lesung, Zustellung der Auswahl, Quittung.
NW6_EINRICHTUNG = datetime(2026, 11, 3, 9, 50, tzinfo=timezone.utc).timestamp()


#: Ergänzt die Plattform in jeder eigenen Definition (measurement-budget-vectors: unbenched_register).
NW6_ANFRAGEKOSTEN_MS = 2000


def nw6_komponente(messstelle: str) -> str:
    return f"d1c00000-0000-4000-8000-{int(messstelle.split('-')[1]):012d}"


def nw6_lesung(box: BoxZugang) -> dict:
    """Die Registerlesung des Baukastens, wie ``ProbePublisher`` sie für die erste Messstelle sendet."""
    messstelle = BOX_REIHEN[box.code][0]
    return {
        "schema_version": "1.0", "type": "probe_request",
        "tenant_id": NW6_TENANT, "site_id": box.site_id, "device_id": box.device_id,
        "request_id": f"0000000000000{box.code[-1]}e6", "requested_at": _zeit(NW6_EINRICHTUNG),
        "requested_by": "kc-dauerlaeufer",
        "ops": [{"op": "read", "id": "probe", "transport": "modbus_tcp", "host": GATEWAY[box.code],
                 "port": GATEWAY_PORT, "unit_id": GATEWAY_UNIT, "register_kind": "input",
                 "address": register(messstelle), "data_type": "u32", "word_order": "big",
                 "scale": SKALA, "offset": 0}],
    }


def nw6_auswahl(box: BoxZugang) -> dict:
    """Die Zustellung nach „Eigenen Messwert hinzufügen“ je Messstelle — eine Revision je Aufruf."""
    return {
        "schema_version": "2.0", "tenant_id": NW6_TENANT, "site_id": box.site_id, "device_id": box.device_id,
        "revision": len(BOX_REIHEN[box.code]), "catalog_version": KATALOGSTAND,
        "selections": [{"point_key": beispiel_schluessel(m), "cadence_s": KADENZ_S,
                        "definition": eigener_messwert(m) | {"requestCostMs": NW6_ANFRAGEKOSTEN_MS},
                        "entity_id": nw6_komponente(m)}
                       for m in BOX_REIHEN[box.code]],
    }


def nw6_vorlage() -> dict:
    """Einrichtung und Zustellungen beider Boxen, gebaut von den Funktionen des Betriebs — nie von Hand."""
    einrichtung = []
    gelernt = {}
    for box in NW6_BOXEN:
        gedaechtnis = Gedaechtnis()
        anfrage = nw6_lesung(box)
        auswahl = nw6_auswahl(box)
        einrichtung.append({
            "box": box.code,
            "lesung": {"topic": probe_topic(NW6_TENANT, box), "anfrage": anfrage,
                       "antwort_topic": probe_antwort_topic(NW6_TENANT, box),
                       "antwort": probe_antwort(NW6_TENANT, box, anfrage, NW6_EINRICHTUNG)},
            "auswahl": {"topic": auswahl_topic(NW6_TENANT, box), "nutzlast": auswahl},
            "quittung": {"topic": quittung_topic(NW6_TENANT, box),
                         "nutzlast": auswahl_lernen(NW6_TENANT, box, auswahl, gedaechtnis, NW6_EINRICHTUNG)},
        })
        gelernt[box.code] = gedaechtnis.gelernt
    zustellungen = []
    for takt in range(NW6_ERSTER_TAKT, NW6_ERSTER_TAKT + NW6_TAKTE):
        for box in NW6_BOXEN:
            zustellungen.append({"box": box.code, "topic": topic(NW6_TENANT, box),
                                 "nutzlast": umschlag(NW6_TENANT, box, takt, gelernt[box.code])})
    return {
        "quelle": "tools/edge-simulator/uems_dauerlaeufer.py (probe_antwort, auswahl_lernen, umschlag)",
        "tenant_id": NW6_TENANT,
        "boxen": [{"code": b.code, "site_id": b.site_id, "device_id": b.device_id,
                   "gateway": {"host": GATEWAY[b.code], "port": GATEWAY_PORT, "unit_id": GATEWAY_UNIT},
                   "messstellen": [{"messstelle": m, "name": KANAELE[m][0], "register": register(m),
                                    "entity_id": nw6_komponente(m), "point_key": beispiel_schluessel(m)}
                                   for m in BOX_REIHEN[b.code]],
                   "point_keys": [beispiel_schluessel(m) for m in BOX_REIHEN[b.code]]} for b in NW6_BOXEN],
        "einrichtung": einrichtung,
        "zustellungen": zustellungen,
    }


def nw6_text() -> str:
    """Genau die Bytes der eingecheckten Vorlage ``abnahme/dauerlaeufer-nw6.json``."""
    return json.dumps(nw6_vorlage(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def nw6_dateisumme() -> str:
    """sha256 über die Bytes — der Java-Lauf rechnet sie nach, bevor er die Vorlage glaubt."""
    return hashlib.sha256(nw6_text().encode("utf-8")).hexdigest()


class Lebenszeichen:
    """Eine Datei, deren Änderungszeit die Probe liest — kein Port, keine Abhängigkeit."""

    def __init__(self, pfad: str):
        self.pfad = Path(pfad)

    def setzen(self, stand: dict) -> None:
        tmp = self.pfad.with_suffix(".tmp")
        tmp.write_text(json.dumps(stand, sort_keys=True), encoding="utf-8")
        tmp.replace(self.pfad)

    def lebt(self, jetzt: float, grenze_s: float = PROBE_GRENZE_S) -> bool:
        try:
            return jetzt - self.pfad.stat().st_mtime <= grenze_s
        except FileNotFoundError:
            return False


def _mqtt_client(konf: Konfiguration, box: BoxZugang,
                 bei_nachricht: Callable[[str, bytes], None]):  # pragma: no cover - braucht paho + Broker
    import paho.mqtt.client as mqtt

    client_id = f"dauerlaeufer-{box.device_id}"
    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id=client_id, clean_session=False)
    except AttributeError:  # paho-mqtt 1.6.x
        client = mqtt.Client(client_id=client_id, clean_session=False)
    if konf.tls:
        client.tls_set(ca_certs=konf.ca, certfile=box.zertifikat, keyfile=box.schluessel)
    client.max_queued_messages_set(MAX_WARTESCHLANGE)
    client.reconnect_delay_set(min_delay=1, max_delay=60)

    def verbunden(c, _userdata, _flags, rc):
        # Nach jeder (Neu-)Verbindung abonnieren: die gehaltene Auswahl kommt dann sofort.
        if rc == 0:
            c.subscribe([(auswahl_topic(konf.tenant_id, box), 1), (probe_topic(konf.tenant_id, box), 1)])

    client.on_connect = verbunden
    client.on_message = lambda _c, _u, nachricht: bei_nachricht(nachricht.topic, nachricht.payload)
    client.connect_async(konf.broker, konf.port, keepalive=30)
    client.loop_start()
    return client


class Dauerlaeufer:
    """Die Endlosschleife. ``client_fabrik`` und ``uhr`` sind die Test-Nähte."""

    def __init__(self, konf: Konfiguration, *, client_fabrik: Callable | None = None,
                 uhr: Callable[[], float] = time.time, echo: Callable[[str], None] | None = None):
        self.konf = konf
        self.uhr = uhr
        self.echo = echo or (lambda text: print(text, file=sys.stderr, flush=True))
        self.halt = threading.Event()
        self.lebenszeichen = Lebenszeichen(konf.lebenszeichen)
        self.gesendet = 0
        self.sperre = threading.Lock()
        self.gedaechtnis = {b.code: Gedaechtnis() for b in konf.boxen}
        fabrik = client_fabrik or (_mqtt_client if konf.broker else None)
        self.clients = {b.code: fabrik(konf, b, self._empfaenger(b)) for b in konf.boxen} if fabrik else {}

    def _empfaenger(self, box: BoxZugang) -> Callable[[str, bytes], None]:
        return lambda thema, nutzlast: self.empfangen(box.code, thema, nutzlast)

    def anhalten(self, *_signal) -> None:
        """Der Signal-Handler: nur ein Merker, das Aufräumen macht die Schleife."""
        self.halt.set()

    def empfangen(self, code: str, thema: str, nutzlast: bytes) -> None:
        """Eine Zustellung des Brokers (paho-Faden): Auswahl lernen und quittieren, Probe beantworten."""
        box = next(b for b in self.konf.boxen if b.code == code)
        client = self.clients.get(code)
        tenant = self.konf.tenant_id
        if thema == auswahl_topic(tenant, box) and not nutzlast:
            with self.sperre:  # die Plattform hat den Plan der Box gelöscht (Ausbau)
                self.gedaechtnis[code] = Gedaechtnis()
            self.echo(f"{code}: Mess-Auswahl gelöscht")
            return
        try:
            dokument = json.loads(nutzlast)
        except (ValueError, UnicodeDecodeError):
            self.echo(f"{code}: unlesbare Nachricht auf {thema} verworfen")
            return
        if thema == auswahl_topic(tenant, box):
            with self.sperre:
                quittung = auswahl_lernen(tenant, box, dokument, self.gedaechtnis[code], self.uhr())
            if quittung is not None:
                self.echo(f"{code}: Revision {quittung['revision']} angewendet, "
                          f"{len(quittung['accepted'])} angenommen, {len(quittung['rejected'])} abgelehnt")
                if client is not None:
                    client.publish(quittung_topic(tenant, box), draht(quittung), qos=1, retain=True)
        elif thema == probe_topic(tenant, box):
            antwort = probe_antwort(tenant, box, dokument, self.uhr())
            if antwort is not None and client is not None:
                client.publish(probe_antwort_topic(tenant, box), draht(antwort), qos=1, retain=False)

    def einmal(self, takt: int) -> int:
        """Ein Takt für beide Boxen. Getrennt ist kein Fehler: paho hält den Umschlag vor."""
        verbunden = {}
        gelernt = {}
        gesendet = 0
        for box in self.konf.boxen:
            with self.sperre:
                auswahl = dict(self.gedaechtnis[box.code].gelernt)
            gelernt[box.code] = len(auswahl)
            nutzlast = umschlag(self.konf.tenant_id, box, takt, auswahl)
            if nutzlast is None:
                continue  # noch keine Auswahl zugestellt: eine Box ohne Plan sendet nichts
            client = self.clients.get(box.code)
            if client is not None:
                client.publish(topic(self.konf.tenant_id, box), draht(nutzlast), qos=1, retain=False)
                verbunden[box.code] = bool(client.is_connected())
            self.gesendet += 1
            gesendet += 1
        self.lebenszeichen.setzen({"takt": takt, "gesendet": self.gesendet, "verbunden": verbunden,
                                   "gelernt": gelernt})
        return gesendet

    def laufen(self, *, hoechstens: int | None = None) -> int:
        """Bis SIGTERM (oder ``hoechstens`` Takte im Test). Rückgabe: Exit-Code."""
        letzter = None
        takte = 0
        try:
            while not self.halt.is_set():
                takt = takt_von(self.uhr())
                if takt != letzter:
                    self.einmal(takt)
                    letzter = takt
                    takte += 1
                    if hoechstens is not None and takte >= hoechstens:
                        break
                naechster = (takt + 1) * TAKT_S
                self.halt.wait(max(0.05, min(naechster - self.uhr(), TAKT_S)))
        finally:
            for client in self.clients.values():
                try:
                    client.disconnect()
                    client.loop_stop()
                except Exception as fehler:  # pragma: no cover - Aufräumen darf nie werfen
                    self.echo(f"Trennen fehlgeschlagen: {fehler}")
            self.echo(f"Dauerläufer beendet nach {self.gesendet} Umschlägen")
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AP-14 IP-18: Dauerläufer, zwei Ahrenberg-Boxen endlos")
    parser.add_argument("--probe", action="store_true",
                        help="Kubernetes-Probe: Exit 0, wenn das Lebenszeichen jünger als drei Takte ist")
    parser.add_argument("--menge", action="store_true", help="Datenmenge je Tag vorrechnen und enden")
    parser.add_argument("--nw6-vorlage", action="store_true", help="die NW-6-Vorlage ausgeben und enden")
    parser.add_argument("--nw6-summe", action="store_true", help="ihre sha256 ausgeben und enden")
    args = parser.parse_args(argv)

    if args.nw6_vorlage:
        sys.stdout.write(nw6_text())
        return 0
    if args.nw6_summe:
        print(nw6_dateisumme())
        return 0

    if args.probe:
        pfad = os.environ.get("VP_DAUERLAEUFER_LEBENSZEICHEN", LEBENSZEICHEN)
        return 0 if Lebenszeichen(pfad).lebt(time.time()) else 1

    try:
        konf = konfiguration(os.environ)
    except ValueError as fehler:
        print(f"Dauerläufer nicht gestartet: {fehler}", file=sys.stderr)
        return 2

    if args.menge:
        print(json.dumps(bytes_je_tag(konf.tenant_id, konf.boxen), ensure_ascii=False, sort_keys=True))
        return 0

    if not konf.broker:
        print("VP_DAUERLAEUFER_BROKER fehlt - Trockenlauf, es wird nichts gesendet", file=sys.stderr)
    laeufer = Dauerlaeufer(konf)
    signal.signal(signal.SIGTERM, laeufer.anhalten)
    signal.signal(signal.SIGINT, laeufer.anhalten)
    return laeufer.laufen()


if __name__ == "__main__":
    raise SystemExit(main())
