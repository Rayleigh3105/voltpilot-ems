#!/usr/bin/env python3
"""AP-14 IP-18 (Kasten E11): der Dauerläufer — zwei simulierte Ahrenberg-Boxen als Dauerarbeit.

Der interne Kundenbereich „VoltPilot Dauerläufer (intern)“ geht in Produktion dauerhaft den Weg
Box → ingest → Writer → Messreihe → Bericht. Dieses Programm ist seine Box-Seite:

* **Ahrenberg, zwei Box-Identitäten.** E-1 liest MS-05…MS-08, E-2 liest MS-10…MS-14 (dieselben
  Reihen und Punktschlüssel wie ``uems_szenarien``); die Kennungen am Draht kommen aber aus der
  Umgebung — es sind die Kennungen, die der Betreiber im Dauerläufer-Kundenbereich anlegt, nie
  die festen Ahrenberg-Kennungen der Verträge.
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
from dataclasses import dataclass
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


def topic(tenant_id: str, box: BoxZugang) -> str:
    return f"ems/{tenant_id}/{box.site_id}/{box.device_id}/v2/measurement-samples"


def umschlag(tenant_id: str, box: BoxZugang, takt: int) -> dict:
    """Ein ``mqtt-measurement-samples`` 2.0-Umschlag im Normalbetrieb."""
    messzeit = datetime.fromtimestamp(takt * TAKT_S, tz=timezone.utc)
    samples = []
    for messstelle in BOX_REIHEN[box.code]:
        roh = ANFANGSSTAND[messstelle] + ZUWACHS[messstelle] * takt
        samples.append({
            "point_key": KANAELE[messstelle][1],
            "raw": roh,
            "decoded": round(roh / 10.0, 1),
            "quality": "good",
            "observed_at": _z(messzeit),
        })
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


def bytes_je_tag(tenant_id: str, boxen: tuple[BoxZugang, ...]) -> dict:
    """Rechnet die Datenmenge eines Tages aus echten Umschlägen vor (Nutzlast, ohne MQTT-Kopf)."""
    takte = 24 * 60 * 60 // TAKT_S
    beispiel = takt_von(datetime(2026, 11, 3, tzinfo=timezone.utc).timestamp())
    je_box = {b.code: len(draht(umschlag(tenant_id, b, beispiel))) * takte for b in boxen}
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


def nw6_vorlage() -> dict:
    """Die Zustellungen beider Boxen, gebaut von ``topic`` und ``umschlag`` — nie von Hand."""
    zustellungen = []
    for takt in range(NW6_ERSTER_TAKT, NW6_ERSTER_TAKT + NW6_TAKTE):
        for box in NW6_BOXEN:
            zustellungen.append({"box": box.code, "topic": topic(NW6_TENANT, box),
                                 "nutzlast": umschlag(NW6_TENANT, box, takt)})
    return {
        "quelle": "tools/edge-simulator/uems_dauerlaeufer.py (topic, umschlag)",
        "tenant_id": NW6_TENANT,
        "boxen": [{"code": b.code, "site_id": b.site_id, "device_id": b.device_id,
                   "point_keys": [KANAELE[m][1] for m in BOX_REIHEN[b.code]]} for b in NW6_BOXEN],
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


def _mqtt_client(konf: Konfiguration, box: BoxZugang):  # pragma: no cover - braucht paho + Broker
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
        fabrik = client_fabrik or (_mqtt_client if konf.broker else None)
        self.clients = {b.code: fabrik(konf, b) for b in konf.boxen} if fabrik else {}

    def anhalten(self, *_signal) -> None:
        """Der Signal-Handler: nur ein Merker, das Aufräumen macht die Schleife."""
        self.halt.set()

    def einmal(self, takt: int) -> int:
        """Ein Takt für beide Boxen. Getrennt ist kein Fehler: paho hält den Umschlag vor."""
        verbunden = {}
        for box in self.konf.boxen:
            nutzlast = umschlag(self.konf.tenant_id, box, takt)
            client = self.clients.get(box.code)
            if client is not None:
                client.publish(topic(self.konf.tenant_id, box), draht(nutzlast), qos=1, retain=False)
                verbunden[box.code] = bool(client.is_connected())
            self.gesendet += 1
        self.lebenszeichen.setzen({"takt": takt, "gesendet": self.gesendet, "verbunden": verbunden})
        return len(self.konf.boxen)

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
