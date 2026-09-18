"""AP-07 IP-20: die fünf Störungs-Szenarien gegen ihre Verträge.

Kein Broker, kein Stack, keine Datenbank: geprüft wird die Nachrichtenfolge, die
der Simulator erzeugt — Reihenfolge, Sequenzen, DUP-Flag, Zeitstempel und der
Inhalt des Replays — gegen ``mqtt-measurement-samples`` 2.0/2.1,
``mqtt-events-2.1`` und ``events-raw``. Die Prüfung der Zeilen und Ereignisse in
der Datenbank gehört zu AP-07 IP-21, das ``szenarien()`` als Bibliothek aufruft.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from uems_szenarien import VERTRAEGE, Szenario, szenarien

jsonschema = pytest.importorskip("jsonschema", reason="Vertragsprüfung braucht jsonschema")

SCHEMA_DATEIEN = {
    "2.0": "mqtt-measurement-samples.schema.json",
    "2.1": "mqtt-measurement-samples-2.1.schema.json",
    "events": "mqtt-events-2.1.schema.json",
    "events-raw": "events-raw.event.schema.json",
}


def _pruefer(name: str):
    with (VERTRAEGE / SCHEMA_DATEIEN[name]).open(encoding="utf-8") as handle:
        schema = json.load(handle)
    klasse = jsonschema.validators.validator_for(schema)
    return klasse(schema, format_checker=klasse.FORMAT_CHECKER)


PRUEFER = {name: _pruefer(name) for name in SCHEMA_DATEIEN}
ALLE = szenarien()


def _zeit(wert: str) -> datetime:
    return datetime.strptime(wert, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _messzeiten(zustellung) -> list[datetime]:
    umschlag = zustellung.nutzlast
    return [_zeit(sample.get("observed_at", umschlag["observed_at"])) for sample in umschlag["samples"]]


def _pruefe_umschlag(zustellung) -> None:
    nutzlast = zustellung.nutzlast
    name = "events" if zustellung.strom == "events" else nutzlast["schema_version"]
    PRUEFER[name].validate(nutzlast)
    # Identitätsregel: die drei Topic-Segmente sind byte-gleich der Nutzlast.
    segmente = zustellung.topic.split("/")
    assert segmente[1:4] == [nutzlast["tenant_id"], nutzlast["site_id"], nutzlast["device_id"]]
    assert segmente[4] == "v2"
    assert zustellung.qos == 1 and zustellung.retain is False


@pytest.mark.parametrize("schluessel", sorted(ALLE))
def test_jede_zustellung_erfuellt_ihren_mqtt_vertrag(schluessel: str):
    szenario: Szenario = ALLE[schluessel]
    assert szenario.zustellungen, "ein Szenario ohne Zustellung prüft nichts"
    for zustellung in szenario.zustellungen:
        _pruefe_umschlag(zustellung)
        if zustellung.strom == "measurement-samples":
            schluessel_im_umschlag = [s["point_key"] for s in zustellung.nutzlast["samples"]]
            assert len(schluessel_im_umschlag) == len(set(schluessel_im_umschlag)), \
                "point_key bleibt je Umschlag eindeutig (2.0 wie 2.1)"
            if zustellung.zustellart != "wiederholt":
                # „nachgeliefert" ist eine Ableitung aus der Verzögerung, kein Etikett
                # des Simulators (§4.5 E5.2): max(5 min, 3 x Kadenz) bei 60 s Kadenz.
                verzug = min(_zeit(zustellung.eingangszeit) - m for m in _messzeiten(zustellung))
                erwartet = "nachgeliefert" if verzug > timedelta(minutes=5) else "direkt"
                assert zustellung.zustellart == erwartet, zustellung.hinweis


@pytest.mark.parametrize("schluessel", sorted(ALLE))
def test_erwartete_ereignisse_sind_gueltige_events_raw(schluessel: str):
    szenario: Szenario = ALLE[schluessel]
    assert szenario.erwartete_ereignisse, "jedes Szenario nennt, was die Cloud daraus bilden muss"
    for ereignis in szenario.erwartete_ereignisse:
        PRUEFER["events-raw"].validate(ereignis)


def test_die_naht_zu_ip21_nennt_genau_die_fuenf_faelle():
    assert sorted(ALLE) == ["A1", "A13", "A3", "A4", "A6"]
    for szenario in ALLE.values():
        assert szenario.quelle.startswith("AP-07 §7 ")
        assert szenario.erwartete_reihen, "IP-21 braucht je Szenario die erwarteten Zeilen"


# -- A1 -------------------------------------------------------------------

def test_a1_dieselben_werte_dreimal_mit_dup_und_sequenz_reset():
    szenario = ALLE["A1"]
    erst, wiederholt, nach_neustart = szenario.zustellungen

    assert [z.sequenz for z in szenario.zustellungen] == [48213, 48213, 1]
    assert [z.dup for z in szenario.zustellungen] == [False, True, False]
    # Der Umschlag ist 3,5 Stunden alt, als er ankommt — die Zustellart folgt der
    # Verzögerung, die beiden Wiederholungen tragen ihr eigenes Wort.
    assert [z.zustellart for z in szenario.zustellungen] == ["nachgeliefert", "wiederholt", "wiederholt"]
    # Der Replay-Inhalt ist Wert für Wert derselbe; nur die Sequenz unterscheidet sich.
    assert wiederholt.nutzlast == erst.nutzlast
    assert nach_neustart.nutzlast["samples"] == erst.nutzlast["samples"]
    assert nach_neustart.nutzlast["sequence"] != erst.nutzlast["sequence"]

    samples = erst.nutzlast["samples"]
    assert len(samples) == 256, "der Umschlag ist genau voll (Schema-Maximum)"
    messzeiten = _messzeiten(erst)
    assert messzeiten == sorted(messzeiten), "die Messzeiten laufen aufsteigend"
    assert messzeiten[0] == _zeit("2026-11-03T13:00:00Z")   # 14:00:00 Ortszeit
    assert messzeiten[-1] == _zeit("2026-11-03T13:04:15Z")  # 14:04:15 Ortszeit
    assert len(set(messzeiten)) == 256

    # 3 × 256 zugestellt, 256 gespeichert, 512 gezählt — nie 512 oder 768 Zeilen.
    assert sum(r.rohzeilen for r in szenario.erwartete_reihen) == 256
    assert szenario.erwartet_wiederholt == 512
    assert szenario.samples == 768

    arten = [e["ereignis"]["art"] for e in szenario.erwartete_ereignisse]
    assert arten == ["sequence_reset"], "ein sequence_reset, kein duplicate_conflict"
    reset = szenario.erwartete_ereignisse[0]["ereignis"]
    assert (reset["sequenz_erwartet"], reset["sequenz_erhalten"]) == (48214, 1)
    assert reset["strom"] == "measurement-samples"


# -- A3 -------------------------------------------------------------------

def test_a3_die_outbox_spielt_fifo_mit_originalmesszeit_nach():
    szenario = ALLE["A3"]
    halle2 = [z for z in szenario.zustellungen if z.box == "E-2"]
    halle1 = [z for z in szenario.zustellungen if z.box == "E-1"]
    replay = [z for z in halle2 if z.aus_outbox]

    assert len(replay) == 210, "3,5 Stunden Ausfall bei 60 s Kadenz"
    # FIFO: Sequenz und Messzeit laufen gemeinsam aufwärts, ohne Sprung.
    sequenzen = [z.sequenz for z in replay]
    assert sequenzen == list(range(48201, 48201 + 210))
    messzeiten = [_zeit(z.nutzlast["observed_at"]) for z in replay]
    assert messzeiten == sorted(messzeiten)
    assert messzeiten[0] == _zeit("2026-11-03T13:00:00Z")    # 14:00 Ortszeit
    assert messzeiten[-1] == _zeit("2026-11-03T16:29:00Z")   # 17:29 Ortszeit
    assert all(b - a == timedelta(minutes=1) for a, b in zip(messzeiten, messzeiten[1:]))

    # Jeder Wert des Replays trägt seine Original-Messzeit und eine spätere Eingangszeit;
    # „nachgeliefert" heißt er erst ab max(5 min, 3 x Kadenz) Verzögerung (§4.5 E5.2).
    for zustellung in replay:
        eingang = _zeit(zustellung.eingangszeit)
        assert eingang >= _zeit("2026-11-03T16:31:00Z")
        verzug = {eingang - messzeit for messzeit in _messzeiten(zustellung)}
        assert all(v > timedelta(0) for v in verzug)
        erwartet = "nachgeliefert" if min(verzug) > timedelta(minutes=5) else "direkt"
        assert zustellung.zustellart == erwartet
        assert not zustellung.dup
    gekennzeichnet = [z for z in replay if z.zustellart == "nachgeliefert"]
    assert len(gekennzeichnet) == 208, "die beiden jüngsten Takte liegen unter der Schwelle"

    # Während des Ausfalls schweigt nur Box Halle 2.
    ausfall = (_zeit("2026-11-03T13:00:00Z"), _zeit("2026-11-03T16:30:00Z"))
    assert not [z for z in halle2 if z.zustellart == "direkt"
                and ausfall[0] <= _zeit(z.eingangszeit) < ausfall[1]]
    assert len(halle1) == 3
    assert all(ausfall[0] <= _zeit(z.eingangszeit) < ausfall[1] for z in halle1)

    ereignisse = [e["ereignis"] for e in szenario.erwartete_ereignisse]
    backfill = [e for e in ereignisse if e["art"] == "backfill"]
    luecken = [e for e in ereignisse if e["art"] == "data_gap"]
    assert sum(e["anzahl"] for e in backfill) == 210 * 5
    assert {e["datenquelle"] for e in backfill} == {"DQ-4", "DQ-5"}
    assert len(luecken) == 7, "je Quelle (2) und je Reihe (5)"
    assert all(e["erkannt_aus"] == "kadenz" for e in luecken)
    assert all(e["nachgeliefert_am"] == "2026-11-03T16:31:00Z" for e in luecken)


# -- A4 -------------------------------------------------------------------

def test_a4_verdraengung_laesst_die_luecke_stehen_und_springt_in_der_sequenz():
    szenario = ALLE["A4"]
    verdraengt = (_zeit("2026-11-03T13:00:00Z"), _zeit("2026-11-06T13:00:00Z"))
    letzte_vor_ausfall = szenario.zustellungen[0]
    box_ereignis = szenario.zustellungen[1]
    replay = [z for z in szenario.zustellungen if z.aus_outbox]

    assert letzte_vor_ausfall.sequenz == 48213
    # Die Box meldet die Verdrängung selbst, über mqtt-events 2.1.
    assert box_ereignis.strom == "events"
    gemeldet = box_ereignis.nutzlast["events"][0]
    assert gemeldet["art"] == "data_gap" and gemeldet["erkannt_aus"] == "verdraengung"
    assert (_zeit(gemeldet["von"]), _zeit(gemeldet["bis"])) == verdraengt

    # Die Sequenz springt um genau 188 verlorene Umschläge.
    assert replay[0].sequenz == 48402
    sprung = szenario.erwartete_ereignisse[0]["ereignis"]
    assert sprung["art"] == "sequence_gap"
    assert sprung["sequenz_erhalten"] - sprung["sequenz_erwartet"] == sprung["anzahl"] == 188

    # Kein einziger nachgelieferter Wert liegt im verdrängten Fenster …
    behalten = [m for z in replay[:3] for m in _messzeiten(z)]
    assert behalten and all(m >= verdraengt[1] for m in behalten)
    assert behalten == sorted(behalten)

    # … und der Nachzügler der reparierten Box trifft ein längst endgültiges Intervall.
    spaet = replay[-1]
    assert _messzeiten(spaet) == [verdraengt[0]]
    eingang = _zeit(spaet.eingangszeit)
    assert eingang - verdraengt[0] > timedelta(days=7)
    late = [e["ereignis"] for e in szenario.erwartete_ereignisse if e["ereignis"]["art"] == "late_arrival"]
    assert len(late) == 1 and late[0]["eingangszeit"] == spaet.eingangszeit
    # Die Lücke des verdrängten Fensters kennt kein nachgeliefert_am — sie bleibt.
    luecke = [e["ereignis"] for e in szenario.erwartete_ereignisse if e["ereignis"]["art"] == "data_gap"]
    assert len(luecke) == 1 and "nachgeliefert_am" not in luecke[0]
    assert luecke[0]["erkannt_aus"] == "verdraengung"


# -- A6 -------------------------------------------------------------------

def test_a6_uebergabe_trennt_fuehrende_werte_vom_nachzuegler_der_alten_box():
    szenario = ALLE["A6"]
    wechsel = _zeit("2027-04-10T05:30:00Z")  # 07:30 Ortszeit
    boxen = {z.box for z in szenario.zustellungen}
    assert len(boxen) == 2, "die Zuständigkeit wandert von einer Box zur anderen"

    alt, neu = sorted(boxen, key=lambda code: code != "E-1")
    werte_alt = [m for z in szenario.zustellungen if z.box == alt for m in _messzeiten(z)]
    werte_neu = [m for z in szenario.zustellungen if z.box == neu for m in _messzeiten(z)]
    assert max(m for m in werte_alt if m < wechsel) == _zeit("2027-04-10T05:29:50Z")
    assert min(werte_neu) == _zeit("2027-04-10T05:31:10Z")
    assert all(m >= wechsel for m in werte_neu)

    nachzuegler = [z for z in szenario.zustellungen if z.aus_outbox]
    assert len(nachzuegler) == 2 and all(z.box == alt for z in nachzuegler)
    # Beide kommen aus dem Puffer, keiner überschreitet die Nachlieferungs-Schwelle:
    # „Nachzügler" ist eine Frage der Reihenfolge, „nachgeliefert" eine der Verzögerung.
    assert [z.zustellart for z in nachzuegler] == ["direkt", "direkt"]
    diesseits, jenseits = nachzuegler
    assert all(m < wechsel for m in _messzeiten(diesseits))
    assert all(m > wechsel for m in _messzeiten(jenseits))
    # Beide gehen später ein als der erste Wert der neuen Box — Reihenfolge ist erlaubt.
    assert all(_zeit(z.eingangszeit) > wechsel for z in nachzuegler)
    assert [z.sequenz for z in szenario.zustellungen if z.box == alt] == sorted(
        z.sequenz for z in szenario.zustellungen if z.box == alt
    )

    ereignisse = [e["ereignis"] for e in szenario.erwartete_ereignisse]
    handover = [e for e in ereignisse if e["art"] == "handover"]
    fremd = [e for e in ereignisse if e["art"] == "unassigned_reader"]
    assert len(handover) == 1
    assert (_zeit(handover[0]["von"]), _zeit(handover[0]["bis"])) == (wechsel, wechsel + timedelta(minutes=1))
    assert handover[0]["box_alt"] != handover[0]["box_neu"]
    assert len(fremd) == 4 and all(e["datenquelle"] == "DQ-3" for e in fremd)
    assert all(e["zustaendige_box"] == handover[0]["box_neu"] for e in fremd)
    assert {r.rolle for r in szenario.erwartete_reihen} == {"fuehrend", "spiegel"}


# -- A13 ------------------------------------------------------------------

def test_a13_die_vorgehende_uhr_wirft_nur_die_zukunft_weg():
    szenario = ALLE["A13"]
    vorgehend = [z for z in szenario.zustellungen
                 if any(m - _zeit(z.eingangszeit) > timedelta(minutes=5) for m in _messzeiten(z))]
    assert len(vorgehend) == 3
    for zustellung in vorgehend:
        versatz = {int((m - _zeit(zustellung.eingangszeit)).total_seconds()) for m in _messzeiten(zustellung)}
        assert versatz == {840}, "14 Minuten vor, auf die Sekunde"
    assert [z.sequenz for z in vorgehend] == [7816, 7817, 7818]

    # Die Nachlieferung mit alter Messzeit und die Werte nach dem Stellen bleiben gut.
    unberuehrt = [z for z in szenario.zustellungen if z not in vorgehend]
    assert len(unberuehrt) == 4
    for zustellung in unberuehrt:
        assert all(m <= _zeit(zustellung.eingangszeit) for m in _messzeiten(zustellung))
    assert [z.zustellart for z in unberuehrt] == ["direkt", "nachgeliefert", "direkt", "direkt"]
    assert sum(r.rohzeilen for r in szenario.erwartete_reihen) == 8, "nur die vier guten Takte je Reihe"

    ereignisse = [e["ereignis"] for e in szenario.erwartete_ereignisse]
    assert [e["art"] for e in ereignisse] == ["clock_ahead"] * 3
    assert all(e["vor_s"] == 840 for e in ereignisse)
    assert [e["sequenz"] for e in ereignisse] == [z.sequenz for z in vorgehend]
    assert all(e["box"] == vorgehend[0].nutzlast["device_id"] for e in ereignisse)
