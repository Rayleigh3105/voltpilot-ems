#!/usr/bin/env python3
"""Messen-Bau m2 (Captain-Punkt „Geräte vs. Eintragung“): die Mess-Seite der Box Halle 1 in der Demo.

Die simulierte Box der Anlage Halle 1 (``voltpilot_edge_sim.py``) spricht nur die v1-Telemetrie. Damit in
der Demo eine Messstelle AUTOMATISCH von einem Gerät liest, steht neben ihr diese Mess-Seite derselben Box:

* **Sie lernt ihre Schlüssel wie eine echte Box.** Sie abonniert die gehaltene Mess-Auswahl ihres Geräts
  (``v2/measurement-config``), nimmt jeden eigenen Messwert an, der als Eingangsregister auf ihrem Zähler
  liegt (``REGISTER``), quittiert die Revision (``v2/measurement-config-status``) und sendet genau die
  zugestellten Schlüssel (``v2/measurement-samples`` 2.0). Ohne Zustellung sendet sie nichts.
* **Sie liest den PV-Ertragszähler des Hybrid-Wechselrichters** (Dach Halle 1, 240 kWp, AC-seitig
  ``VP_MESSBOX_PV_PEAK_KW``): Eingangsregister 3000, Zählerstand in 0,1 kWh, Kadenz wie in der Auswahl. Die
  Leistung folgt dem Sonnenstand am Standort (Tageslänge und Höhe je Jahreszeit) und einem Wetter je Tag;
  beides hängt nur von der Zeit ab.
* **Zustandslos und neustartfest.** Zählerstand und Sequenz sind Funktionen der Zeit: nach einem Neustart
  laufen sie dort weiter, wo sie ohne Neustart stünden; kein Zählersprung, kein Sequenz-Reset.
* **Sie schließt die Lücke eines Ausfalls.** Nach jedem Lernen schickt sie die Werte der letzten
  ``VP_MESSBOX_NACHLIEFERN_H`` Stunden nach (Vorgabe 160 h, unter der Frist von sieben Tagen, nach der ein
  Rohwert keine Viertelstunde mehr bildet, ``ViertelstundeRegeln.FRIST``) - wie eine Box, die während einer
  Trennung weiter misst. Geschichte vor der Auswahl entsteht so nicht: einen Wert vor ``enabled_at`` des
  Messwerts verwirft der Writer still, und erst die Quittung gibt einem Wert seine Fassung. Dieselben Werte
  noch einmal sind am Writer eine Wiederholung (gleicher Schlüssel, gleicher Wert) und schreiben nichts.
* **Übersteht Broker-Trennung** (paho verbindet selbst neu) und endet sauber auf SIGTERM/SIGINT.

Nur für die Demo: Zugang ohne Zertifikat auf dem Demo-Broker, wie die Ahrenberg-Boxen daneben.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import signal
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Mapping

#: Was die Box liest: ein Zähler mit einem Eingangsregister-Paar (u32, hohes Wort zuerst, ×0,1 kWh).
REGISTER_PV_ERZEUGUNG = 3000
SKALA = 0.1
REGISTER: dict[int, str] = {REGISTER_PV_ERZEUGUNG: "PV-Erzeugung Dach Halle 1 · Zählerstand"}
#: Steht in jeder Quittung (``edge_version``): so sieht die Plattform, wer quittiert hat.
EDGE_VERSION = "voltpilot-messbox-halle1/1"
#: Ohne Kadenz in der Auswahl misst der Zähler alle fünf Minuten; schneller als eine Minute nie.
KADENZ_VORGABE_S = 300
KADENZ_MIN_S = 60
#: Der Zählerstand am Anfang der Zeitachse (01.01.2024 00:00 UTC) - ein Zähler, der schon länger läuft.
EPOCHE = datetime(2024, 1, 1, tzinfo=timezone.utc)
ANFANGSSTAND_KWH = 182_640.0
#: Nachliefern: unter sieben Tagen (FRIST), damit jeder Wert noch seine Viertelstunde bildet.
NACHLIEFERN_H_VORGABE = 160
#: Höchstens so viele Umschläge je Sekunde beim Nachliefern - der Broker der Demo soll nicht stocken.
NACHLIEFERN_JE_S = 40
#: Ein Tag Warteschlange in paho bei getrenntem Broker; danach verwirft paho, statt den Speicher zu füllen.
MAX_WARTESCHLANGE = 24 * 12
LEBENSZEICHEN = "/tmp/messbox-lebenszeichen"


def _z(t: datetime) -> str:
    """RFC 3339 in UTC mit ``Z`` - die Form am Draht."""
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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


# ─────────────────────────────────────────────────────────────── Der Zähler

@dataclass(frozen=True)
class Anlage:
    """Was den Zähler treibt: Leistung am Wechselrichter und die Lage des Dachs."""

    spitze_kw: float = 200.0
    breite: float = 51.0
    laenge: float = 10.0


def _gleichverteilt(*teile: object) -> float:
    """Eine Zahl in [0, 1), nur aus den Teilen - dieselben Teile geben immer dieselbe Zahl."""
    h = hashlib.sha256("|".join(str(t) for t in teile).encode("utf-8")).digest()
    return int.from_bytes(h[:8], "big") / 2**64


def wetter(tag: datetime) -> float:
    """Das Wetter eines Kalendertags (UTC) als Anteil der klaren Sonne: 0,2 (trüb) bis 1,0 (klar).

    Ein Tag hängt ein wenig am Vortag (Wetterlagen dauern), sonst ist jeder Tag eigen.
    """
    heute = _gleichverteilt("wetter", tag.date().isoformat())
    gestern = _gleichverteilt("wetter", (tag - timedelta(days=1)).date().isoformat())
    return 0.2 + 0.8 * (0.65 * heute + 0.35 * gestern)


def sonnenhoehe_sin(t: datetime, anlage: Anlage) -> float:
    """sin der Sonnenhöhe am Standort zur Zeit ``t`` (Zeitgleichung vernachlässigt, ±16 min)."""
    t = t.astimezone(timezone.utc)
    tag_im_jahr = t.timetuple().tm_yday
    deklination = math.radians(23.44) * math.sin(2 * math.pi * (284 + tag_im_jahr) / 365)
    sonnenzeit_h = t.hour + t.minute / 60 + t.second / 3600 + anlage.laenge / 15
    stundenwinkel = math.radians(15 * (sonnenzeit_h - 12))
    phi = math.radians(anlage.breite)
    return math.sin(phi) * math.sin(deklination) + math.cos(phi) * math.cos(deklination) * math.cos(stundenwinkel)


def leistung_kw(t: datetime, anlage: Anlage) -> float:
    """Die PV-Leistung zur Zeit ``t``: Sonnenstand × Wetter des Tages, an trüben Tagen etwas unruhig."""
    s = sonnenhoehe_sin(t, anlage)
    if s <= 0:
        return 0.0
    # Die volle Spitze nur zur Mittagszeit im Hochsommer bei klarem Himmel.
    sommer_mittag = math.sin(math.radians(90 - anlage.breite + 23.44))
    form = (s / sommer_mittag) ** 1.15
    w = wetter(t)
    unruhe = (1 - w) * 0.35 * (2 * _gleichverteilt("unruhe", int(t.timestamp()) // 300) - 1)
    return max(0.0, anlage.spitze_kw * form * w * (1 + unruhe))


@dataclass
class Zaehler:
    """Der Zählerstand als Funktion der Zeit: Anfangsstand plus die Energie aller Schritte davor.

    Je UTC-Tag wird die Energie einmal Schritt für Schritt gerechnet: die Summe des Tages bleibt gemerkt, die
    laufende Summe innerhalb des Tages nur für die zuletzt gefragten Tage. Ein Zählerstand ist dann eine Summe
    über gemerkte Tage und einen Blick in die Liste des Tages, nie eine Rechnung über Jahre je Wert.
    """

    anlage: Anlage = field(default_factory=Anlage)
    schritt_s: int = KADENZ_VORGABE_S
    _vor_tag: dict[int, float] = field(default_factory=lambda: {0: 0.0})
    _im_tag: dict[int, list[float]] = field(default_factory=dict)

    def _schritt_kwh(self, beginn: datetime) -> float:
        mitte = beginn + timedelta(seconds=self.schritt_s / 2)
        return leistung_kw(mitte, self.anlage) * self.schritt_s / 3600

    def _laufend(self, tag: int) -> list[float]:
        """Die laufende Summe des Tages je Schritt (Länge: Schritte + 1, beginnend bei 0)."""
        liste = self._im_tag.get(tag)
        if liste is None:
            beginn = EPOCHE + timedelta(days=tag)
            liste = [0.0]
            for i in range(86400 // self.schritt_s):
                liste.append(liste[-1] + self._schritt_kwh(beginn + timedelta(seconds=i * self.schritt_s)))
            if len(self._im_tag) >= 16:
                self._im_tag.pop(next(iter(self._im_tag)))
            self._im_tag[tag] = liste
        return liste

    def _vor(self, tag: int) -> float:
        """Die Energie aller ganzen Tage vor ``tag``."""
        if tag not in self._vor_tag:
            start = max(k for k in self._vor_tag if k < tag)
            summe = self._vor_tag[start]
            for d in range(start, tag):
                summe += self._laufend(d)[-1]
                self._vor_tag[d + 1] = summe
        return self._vor_tag[tag]

    def stand_kwh(self, t: datetime) -> float:
        """Der Zählerstand zur Zeit ``t`` (auf den Schritt abgerundet, wie ein Zähler, der im Takt gelesen wird)."""
        t = t.astimezone(timezone.utc)
        if t < EPOCHE:
            raise ValueError("vor dem Anfang der Zeitachse")
        tag, im_tag = divmod(int((t - EPOCHE).total_seconds()), 86400)
        return ANFANGSSTAND_KWH + self._vor(tag) + self._laufend(tag)[im_tag // self.schritt_s]

    def roh(self, t: datetime) -> int:
        """Der Rohwert im Register (u32, ×0,1 kWh)."""
        wert = int(round(self.stand_kwh(t) / SKALA))
        if not 0 <= wert < 2**32:
            raise ValueError("Zählerstand außerhalb von u32")
        return wert


# ─────────────────────────────────────────────────────────────── Die Box

@dataclass(frozen=True)
class Konfiguration:
    tenant_id: str
    site_id: str
    device_id: str
    broker: str | None
    port: int = 1883
    client_id: str = "edge-mess-ahrenberg-halle1"
    anlage: Anlage = field(default_factory=Anlage)
    nachliefern_h: int = NACHLIEFERN_H_VORGABE
    lebenszeichen: str = LEBENSZEICHEN


def konfiguration(umgebung: Mapping[str, str]) -> Konfiguration:
    """Liest ``VP_MESSBOX_*``; eine fehlende oder falsche Kennung bricht vor dem Senden ab."""
    nachliefern = int(umgebung.get("VP_MESSBOX_NACHLIEFERN_H", str(NACHLIEFERN_H_VORGABE)))
    if not 0 <= nachliefern < 7 * 24:
        raise ValueError("VP_MESSBOX_NACHLIEFERN_H liegt nicht unter sieben Tagen")
    return Konfiguration(
        tenant_id=_uuid("VP_MESSBOX_TENANT", umgebung.get("VP_MESSBOX_TENANT")),
        site_id=_uuid("VP_MESSBOX_SITE", umgebung.get("VP_MESSBOX_SITE")),
        device_id=_uuid("VP_MESSBOX_DEVICE", umgebung.get("VP_MESSBOX_DEVICE")),
        broker=umgebung.get("VP_MESSBOX_BROKER") or None,
        port=int(umgebung.get("VP_MESSBOX_PORT", "1883")),
        client_id=umgebung.get("VP_MESSBOX_CLIENT_ID", "edge-mess-ahrenberg-halle1"),
        anlage=Anlage(
            spitze_kw=float(umgebung.get("VP_MESSBOX_PV_PEAK_KW", "200")),
            breite=float(umgebung.get("VP_MESSBOX_BREITE", "51.0")),
            laenge=float(umgebung.get("VP_MESSBOX_LAENGE", "10.0")),
        ),
        nachliefern_h=nachliefern,
        lebenszeichen=umgebung.get("VP_MESSBOX_LEBENSZEICHEN", LEBENSZEICHEN),
    )


def _basis(k: Konfiguration) -> str:
    return f"ems/{k.tenant_id}/{k.site_id}/{k.device_id}/v2"


def topic(k: Konfiguration) -> str:
    return f"{_basis(k)}/measurement-samples"


def auswahl_topic(k: Konfiguration) -> str:
    return f"{_basis(k)}/measurement-config"


def quittung_topic(k: Konfiguration) -> str:
    return f"{_basis(k)}/measurement-config-status"


@dataclass(frozen=True)
class Punkt:
    """Ein gelernter eigener Messwert: der Schlüssel der Plattform, sein Register, seine Kadenz."""

    point_key: str
    register: int
    skala: float
    kadenz_s: int


@dataclass
class Gedaechtnis:
    """Was die Box aus der Zustellung gelernt hat - nur im Speicher; der Broker stellt die gehaltene
    Auswahl nach einem Neustart erneut zu."""

    revision: int | None = None
    katalog: str | None = None
    punkte: list[Punkt] = field(default_factory=list)


def _gleiche_identitaet(k: Konfiguration, nutzlast: dict) -> bool:
    return (nutzlast.get("tenant_id"), nutzlast.get("site_id"), nutzlast.get("device_id")) == (
        k.tenant_id, k.site_id, k.device_id)


def auswahl_lernen(k: Konfiguration, dokument, gedaechtnis: Gedaechtnis, jetzt: datetime) -> dict | None:
    """Wendet eine zugestellte Mess-Auswahl an und gibt die Quittung zurück (oder ``None``).

    Wie der Box-Kern: fremde Identität, kaputtes Dokument und eine ältere oder gleiche Revision werden
    ignoriert; sonst gilt die ganze Auswahl auf einmal. Angenommen wird jeder eigene Messwert, der als
    u32-Eingangsregister (hohes Wort zuerst) auf dem Zähler dieser Box liegt; alles andere lehnt die Box
    benannt ab (``unknown_point``) und liest es nie geraten.
    """
    if not isinstance(dokument, dict) or dokument.get("schema_version") != "2.0" or not _gleiche_identitaet(k, dokument):
        return None
    revision = dokument.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        return None
    if gedaechtnis.revision is not None and revision <= gedaechtnis.revision:
        return None
    angenommen: list[str] = []
    abgelehnt: list[dict] = []
    punkte: list[Punkt] = []
    for auswahl in dokument.get("selections") or []:
        schluessel = auswahl.get("point_key")
        definition = auswahl.get("definition") or {}
        adresse = definition.get("address")
        skala = definition.get("scale")
        kadenz = auswahl.get("cadence_s") or definition.get("cadenceS") or KADENZ_VORGABE_S
        passt = (
            isinstance(schluessel, str) and schluessel.startswith("custom.")
            and adresse in REGISTER and all(p.register != adresse for p in punkte)
            and definition.get("sourceKind") == "modbus_input" and definition.get("valueType") == "uint32"
            and definition.get("endian") == "big"
            and isinstance(skala, (int, float)) and not isinstance(skala, bool) and math.isclose(float(skala), SKALA)
            and isinstance(kadenz, int) and not isinstance(kadenz, bool) and kadenz >= KADENZ_MIN_S
        )
        if passt:
            punkte.append(Punkt(schluessel, adresse, float(skala), kadenz))
            angenommen.append(schluessel)
        else:
            abgelehnt.append({"point_key": schluessel, "reason": "unknown_point"})
    gedaechtnis.revision = revision
    gedaechtnis.katalog = dokument.get("catalog_version")
    gedaechtnis.punkte = punkte
    return {
        "schema_version": "2.0",
        "tenant_id": k.tenant_id,
        "site_id": k.site_id,
        "device_id": k.device_id,
        "revision": revision,
        "applied_at": _z(jetzt),
        "accepted": angenommen,
        "rejected": abgelehnt,
        "edge_version": EDGE_VERSION,
    }


def raster(gedaechtnis: Gedaechtnis) -> int:
    """Der Takt, in dem Umschläge entstehen: der größte gemeinsame Teiler der gelernten Kadenzen."""
    return math.gcd(*(p.kadenz_s for p in gedaechtnis.punkte)) if gedaechtnis.punkte else KADENZ_VORGABE_S


def umschlag(k: Konfiguration, gedaechtnis: Gedaechtnis, zaehler: dict[int, Zaehler], messzeit: datetime) -> dict | None:
    """Ein ``mqtt-measurement-samples`` 2.0-Umschlag zur Messzeit: jeder gelernte Punkt, dessen Kadenz auf sie
    fällt. Die Sequenz zählt die Umschläge: die Messzeit geteilt durch das Raster der gelernten Kadenzen (ihr
    größter gemeinsamer Teiler). Zwei aufeinanderfolgende Umschläge liegen damit um genau eins auseinander, wie der
    Writer es von einer Box erwartet (sonst meldet er je Umschlag ``sequence_gap``), und die Zählung steigt auch
    über einen Neustart."""
    samples = []
    for p in gedaechtnis.punkte:
        if int(messzeit.timestamp()) % p.kadenz_s:
            continue
        z = zaehler.setdefault(p.kadenz_s, Zaehler(anlage=k.anlage, schritt_s=p.kadenz_s))
        roh = z.roh(messzeit)
        samples.append({
            "point_key": p.point_key,
            "raw": roh,
            "decoded": round(roh * p.skala, 3),
            "quality": "good",
            "observed_at": _z(messzeit),
        })
    if not samples:
        return None
    nutzlast = {
        "schema_version": "2.0",
        "tenant_id": k.tenant_id,
        "site_id": k.site_id,
        "device_id": k.device_id,
        "sequence": int(messzeit.timestamp()) // raster(gedaechtnis),
        "observed_at": _z(messzeit),
        "samples": samples,
    }
    if gedaechtnis.katalog:
        nutzlast["catalog_version"] = gedaechtnis.katalog
    return nutzlast


def messzeiten(gedaechtnis: Gedaechtnis, von: datetime, bis: datetime) -> list[datetime]:
    """Die Messzeiten aller gelernten Punkte in [von, bis] auf ihrem Kadenz-Raster, aufsteigend."""
    raster = sorted({p.kadenz_s for p in gedaechtnis.punkte})
    zeiten: set[int] = set()
    for s in raster:
        erste = -(-int(von.timestamp()) // s) * s
        zeiten.update(range(erste, int(bis.timestamp()) + 1, s))
    return [datetime.fromtimestamp(z, tz=timezone.utc) for z in sorted(zeiten)]


def draht(nutzlast: dict) -> bytes:
    return json.dumps(nutzlast, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class Lebenszeichen:
    """Eine Datei, deren Änderungszeit eine Probe lesen kann - kein Port, keine Abhängigkeit."""

    def __init__(self, pfad: str):
        self.pfad = Path(pfad)

    def setzen(self, stand: dict) -> None:
        tmp = self.pfad.with_suffix(".tmp")
        tmp.write_text(json.dumps(stand, sort_keys=True), encoding="utf-8")
        tmp.replace(self.pfad)

    def lebt(self, jetzt: float, grenze_s: float = 3 * KADENZ_VORGABE_S) -> bool:
        try:
            return jetzt - self.pfad.stat().st_mtime <= grenze_s
        except FileNotFoundError:
            return False


def _mqtt_client(k: Konfiguration, bei_nachricht: Callable[[str, bytes], None]):  # pragma: no cover - braucht Broker
    import paho.mqtt.client as mqtt

    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=k.client_id, clean_session=False)
    except AttributeError:  # paho-mqtt 1.6.x
        client = mqtt.Client(client_id=k.client_id, clean_session=False)
    client.max_queued_messages_set(MAX_WARTESCHLANGE)
    client.reconnect_delay_set(min_delay=1, max_delay=60)

    def verbunden(c, _userdata, _flags, rc, _eigenschaften=None):
        # Nach jeder (Neu-)Verbindung abonnieren: die gehaltene Auswahl kommt dann sofort. paho 2 reicht einen
        # ReasonCode und Eigenschaften, paho 1.6 eine Zahl - beide sind bei Erfolg gleich 0.
        if rc == 0:
            c.subscribe([(auswahl_topic(k), 1)])

    client.on_connect = verbunden
    client.on_message = lambda _c, _u, nachricht: bei_nachricht(nachricht.topic, nachricht.payload)
    client.connect_async(k.broker, k.port, keepalive=30)
    client.loop_start()
    return client


class MessBox:
    """Die Endlosschleife. ``client_fabrik``, ``uhr`` und ``schlafen`` sind die Test-Nähte."""

    def __init__(self, k: Konfiguration, *, client_fabrik: Callable | None = None,
                 uhr: Callable[[], float] = time.time, echo: Callable[[str], None] | None = None):
        self.k = k
        self.uhr = uhr
        self.echo = echo or (lambda text: print(text, file=sys.stderr, flush=True))
        self.halt = threading.Event()
        self.sperre = threading.Lock()
        self.gedaechtnis = Gedaechtnis()
        self.zaehler: dict[int, Zaehler] = {}
        self.nachliefern_ab: datetime | None = None
        self.gesendet = 0
        self.lebenszeichen = Lebenszeichen(k.lebenszeichen)
        fabrik = client_fabrik or (_mqtt_client if k.broker else None)
        self.client = fabrik(k, self.empfangen) if fabrik else None

    def anhalten(self, *_signal) -> None:
        self.halt.set()

    def jetzt(self) -> datetime:
        return datetime.fromtimestamp(self.uhr(), tz=timezone.utc)

    def empfangen(self, thema: str, nutzlast: bytes) -> None:
        """Eine Zustellung des Brokers (paho-Faden): Auswahl lernen und quittieren."""
        if thema != auswahl_topic(self.k):
            return
        if not nutzlast:
            with self.sperre:  # die Plattform hat den Plan der Box gelöscht
                self.gedaechtnis = Gedaechtnis()
            self.echo("Mess-Auswahl gelöscht")
            return
        try:
            dokument = json.loads(nutzlast)
        except (ValueError, UnicodeDecodeError):
            self.echo("unlesbare Mess-Auswahl verworfen")
            return
        with self.sperre:
            quittung = auswahl_lernen(self.k, dokument, self.gedaechtnis, self.jetzt())
            if quittung is not None and self.gedaechtnis.punkte:
                # Nach jedem Lernen: was die Plattform noch annimmt, nachliefern.
                self.nachliefern_ab = self.jetzt() - timedelta(hours=self.k.nachliefern_h)
        if quittung is None:
            return
        self.echo(f"Revision {quittung['revision']} angewendet: {len(quittung['accepted'])} angenommen, "
                  f"{len(quittung['rejected'])} abgelehnt")
        if self.client is not None:
            self.client.publish(quittung_topic(self.k), draht(quittung), qos=1, retain=True)

    def senden(self, messzeit: datetime) -> bool:
        with self.sperre:
            nutzlast = umschlag(self.k, self.gedaechtnis, self.zaehler, messzeit)
        if nutzlast is None:
            return False
        if self.client is not None:
            self.client.publish(topic(self.k), draht(nutzlast), qos=1, retain=False)
        self.gesendet += 1
        return True

    def nachliefern(self, bis: datetime) -> int:
        """Die Werte seit ``nachliefern_ab`` bis ``bis`` - gedrosselt, abbrechbar."""
        with self.sperre:
            ab, self.nachliefern_ab = self.nachliefern_ab, None
            gedaechtnis = Gedaechtnis(self.gedaechtnis.revision, self.gedaechtnis.katalog, list(self.gedaechtnis.punkte))
        if ab is None:
            return 0
        zeiten = messzeiten(gedaechtnis, ab, bis)
        n = 0
        for i, t in enumerate(zeiten):
            if self.halt.is_set():
                break
            n += self.senden(t)
            if (i + 1) % NACHLIEFERN_JE_S == 0:
                self.halt.wait(1.0)
        self.echo(f"{n} Umschläge nachgeliefert ({_z(ab)} bis {_z(bis)})")
        return n

    def laufen(self, *, hoechstens: int | None = None, schlafen: Callable[[float], None] | None = None) -> int:
        """Bis SIGTERM (oder ``hoechstens`` Runden im Test). Rückgabe: Exit-Code."""
        warte = schlafen or (lambda s: self.halt.wait(s))
        letzte = int(self.uhr())
        runden = 0
        try:
            while not self.halt.is_set():
                jetzt = int(self.uhr())
                if self.nachliefern_ab is not None:
                    self.nachliefern(datetime.fromtimestamp(jetzt, tz=timezone.utc))
                    letzte = jetzt
                # Jede Messzeit seit dem letzten Blick, die auf das Raster eines Punkts fällt.
                with self.sperre:
                    gedaechtnis = Gedaechtnis(self.gedaechtnis.revision, self.gedaechtnis.katalog,
                                              list(self.gedaechtnis.punkte))
                for t in messzeiten(gedaechtnis, datetime.fromtimestamp(letzte + 1, tz=timezone.utc),
                                    datetime.fromtimestamp(jetzt, tz=timezone.utc)):
                    self.senden(t)
                letzte = jetzt
                self.lebenszeichen.setzen({"gesendet": self.gesendet, "revision": self.gedaechtnis.revision,
                                           "punkte": [p.point_key for p in self.gedaechtnis.punkte],
                                           "verbunden": bool(self.client.is_connected()) if self.client else False})
                runden += 1
                if hoechstens is not None and runden >= hoechstens:
                    break
                warte(5.0)
        finally:
            if self.client is not None:
                try:
                    self.client.disconnect()
                    self.client.loop_stop()
                except Exception as fehler:  # pragma: no cover - Aufräumen darf nie werfen
                    self.echo(f"Trennen fehlgeschlagen: {fehler}")
            self.echo(f"Mess-Box beendet nach {self.gesendet} Umschlägen")
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Messen-Bau m2: Mess-Seite der Demo-Box Halle 1")
    parser.add_argument("--probe", action="store_true", help="Exit 0, wenn das Lebenszeichen frisch ist")
    parser.add_argument("--tag", help="die Viertelstunden eines Tags (JJJJ-MM-TT, UTC) ausgeben und enden")
    args = parser.parse_args(argv)
    if args.probe:
        pfad = os.environ.get("VP_MESSBOX_LEBENSZEICHEN", LEBENSZEICHEN)
        return 0 if Lebenszeichen(pfad).lebt(time.time()) else 1
    try:
        k = konfiguration(os.environ)
    except ValueError as fehler:
        print(f"Mess-Box nicht gestartet: {fehler}", file=sys.stderr)
        return 2
    if args.tag:
        z = Zaehler(anlage=k.anlage, schritt_s=900)
        beginn = datetime.fromisoformat(args.tag).replace(tzinfo=timezone.utc)
        for i in range(96):
            a = beginn + timedelta(minutes=15 * i)
            print(f"{_z(a)} {z.stand_kwh(a + timedelta(minutes=15)) - z.stand_kwh(a):.1f} kWh")
        return 0
    box = MessBox(k)
    signal.signal(signal.SIGTERM, box.anhalten)
    signal.signal(signal.SIGINT, box.anhalten)
    if not k.broker:
        print("VP_MESSBOX_BROKER fehlt - Trockenlauf, es wird nichts gesendet", file=sys.stderr)
    return box.laufen()


if __name__ == "__main__":
    sys.exit(main())
