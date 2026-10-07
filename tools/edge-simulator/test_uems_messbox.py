"""Messen-Bau m2: die Mess-Seite der Demo-Box Halle 1 ohne Broker - Zähler, Lernen, Nachliefern, Neustart."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import uems_messbox as mb

VERTRAEGE = Path(__file__).resolve().parents[2] / "docs/contracts/v2"
TENANT = "20000000-0000-0000-0000-000000000001"
SITE = "20000000-0000-0000-0000-000000000501"
DEVICE = "20000000-0000-0000-0000-000000000701"
UMGEBUNG = {"VP_MESSBOX_TENANT": TENANT, "VP_MESSBOX_SITE": SITE, "VP_MESSBOX_DEVICE": DEVICE}
SCHLUESSEL = "custom.0c4f2b1a9e8d7c6b5a4f3e2d1c0b9a88"


def _konf(**mehr) -> mb.Konfiguration:
    return mb.konfiguration({**UMGEBUNG, **mehr})


def _definition(**anders) -> dict:
    """Ein eigener Messwert, wie ihn das Portal über „Eigenen Messwert hinzufügen“ anlegt und die
    Plattform ihn zustellt (`MeasurementSelectionService` → `custom_definition`)."""
    return {
        "label": "PV-Erzeugung Dach Halle 1 · Zählerstand",
        "sourceKind": "modbus_input",
        "address": mb.REGISTER_PV_ERZEUGUNG,
        "selector": "input:0x0bb8",
        "valueType": "uint32",
        "widthBits": 32,
        "signed": False,
        "endian": "big",
        "scale": 0.1,
        "unit": "kWh",
        "cadenceS": 300,
        "retentionClass": "energy_counter",
        "readOnly": True,
        "requestCostMs": 2000,
    } | anders


def _auswahl(revision: int = 1, *punkte: dict) -> dict:
    return {
        "schema_version": "2.0",
        "tenant_id": TENANT,
        "site_id": SITE,
        "device_id": DEVICE,
        "revision": revision,
        "catalog_version": "2026.09.23.3",
        "selections": list(punkte) or [{"point_key": SCHLUESSEL, "cadence_s": 300, "definition": _definition(),
                                        "entity_id": "2364973a-367d-428e-a648-97cc8f93de09"}],
    }


def _pruefer(name: str):
    jsonschema = pytest.importorskip("jsonschema", reason="Vertragspruefung braucht jsonschema")
    schema = json.loads((VERTRAEGE / name).read_text(encoding="utf-8"))
    return jsonschema.validators.validator_for(schema)(schema, format_checker=jsonschema.FormatChecker())


class FakeClient:
    def __init__(self):
        self.gesendet: list[tuple[str, dict, bool]] = []

    def publish(self, topic, nutzlast, qos, retain):
        assert qos == 1
        self.gesendet.append((topic, json.loads(nutzlast), retain))

    def is_connected(self):
        return True

    def disconnect(self):
        pass

    def loop_stop(self):
        pass


# ─────────────────────────────────────────────────────────────── Der Zähler

def test_nachts_null_mittags_leistung_und_jahreszeiten():
    a = mb.Anlage()
    assert mb.leistung_kw(datetime(2026, 10, 6, 1, 0, tzinfo=timezone.utc), a) == 0.0
    assert mb.leistung_kw(datetime(2026, 10, 6, 11, 0, tzinfo=timezone.utc), a) > 0.0
    z = mb.Zaehler()
    tag = lambda t: z.stand_kwh(t + timedelta(days=1)) - z.stand_kwh(t)  # noqa: E731
    juni, oktober, dezember = (tag(datetime(2026, m, d, tzinfo=timezone.utc)) for m, d in ((6, 21), (10, 6), (12, 21)))
    # 240 kWp auf dem Dach von Halle 1: im Juni ein Vielfaches des Dezembers, im Oktober dazwischen.
    assert juni > oktober > dezember > 0
    assert 100 < oktober < 800
    # Nie über der Wechselrichter-Leistung.
    assert max(mb.leistung_kw(datetime(2026, 6, 21, h, tzinfo=timezone.utc), a) for h in range(24)) <= a.spitze_kw


def test_der_zaehler_steigt_stetig_und_ist_eine_funktion_der_zeit():
    t = datetime(2026, 10, 6, 9, 0, tzinfo=timezone.utc)
    erster = mb.Zaehler()
    staende = [erster.stand_kwh(t + timedelta(minutes=5 * i)) for i in range(48)]
    assert all(b >= a for a, b in zip(staende, staende[1:]))
    # Ein Neustart (neuer Zähler ohne Gedächtnis) liest an derselben Minute denselben Stand - kein Zählersprung.
    zweiter = mb.Zaehler()
    assert zweiter.stand_kwh(t + timedelta(hours=3)) == pytest.approx(erster.stand_kwh(t + timedelta(hours=3)))
    assert mb.Zaehler().roh(t) == erster.roh(t)
    # Innerhalb eines Schritts bleibt der Stand stehen (gelesen wird im Takt).
    assert erster.stand_kwh(t + timedelta(minutes=2)) == erster.stand_kwh(t)


def test_das_wetter_ist_je_tag_fest_und_bleibt_im_band():
    tage = [datetime(2026, 10, 1, tzinfo=timezone.utc) + timedelta(days=i) for i in range(60)]
    werte = [mb.wetter(t) for t in tage]
    assert all(0.2 <= w <= 1.0 for w in werte)
    assert len({round(w, 6) for w in werte}) > 30
    assert mb.wetter(tage[3]) == mb.wetter(tage[3] + timedelta(hours=13))


# ─────────────────────────────────────────────────────────────── Lernen

def test_lernt_den_eigenen_messwert_und_quittiert_nach_vertrag():
    k = _konf()
    g = mb.Gedaechtnis()
    jetzt = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)
    auswahl = _auswahl(3)
    _pruefer("mqtt-measurement-config.schema.json").validate(auswahl)
    quittung = mb.auswahl_lernen(k, auswahl, g, jetzt)
    _pruefer("mqtt-measurement-config-status.schema.json").validate(quittung)
    assert quittung["accepted"] == [SCHLUESSEL]
    assert quittung["rejected"] == []
    assert quittung["revision"] == 3
    assert g.punkte == [mb.Punkt(SCHLUESSEL, mb.REGISTER_PV_ERZEUGUNG, 0.1, 300)]
    # Eine ältere oder gleiche Revision und eine fremde Identität ändern nichts.
    assert mb.auswahl_lernen(k, _auswahl(3), g, jetzt) is None
    assert mb.auswahl_lernen(k, _auswahl(2), g, jetzt) is None
    assert mb.auswahl_lernen(k, _auswahl(9) | {"device_id": SITE}, g, jetzt) is None
    assert g.revision == 3


def test_was_nicht_auf_dem_zaehler_liegt_lehnt_die_box_benannt_ab():
    k = _konf()
    g = mb.Gedaechtnis()
    fremd = {"point_key": "custom.ffff", "cadence_s": 300, "definition": _definition(address=4000, selector="input:0x0fa0")}
    katalog = {"point_key": "grid.import_energy", "cadence_s": 60}
    quittung = mb.auswahl_lernen(k, _auswahl(1, fremd, katalog), g, datetime(2026, 10, 6, tzinfo=timezone.utc))
    assert quittung["accepted"] == []
    assert quittung["rejected"] == [
        {"point_key": "custom.ffff", "reason": "unknown_point"},
        {"point_key": "grid.import_energy", "reason": "unknown_point"},
    ]
    assert g.punkte == []


# ─────────────────────────────────────────────────────────────── Umschläge

def test_der_umschlag_folgt_dem_vertrag_sequenz_und_messzeit_aus_der_zeit():
    k = _konf()
    g = mb.Gedaechtnis()
    mb.auswahl_lernen(k, _auswahl(1), g, datetime(2026, 10, 6, tzinfo=timezone.utc))
    zaehler: dict[int, mb.Zaehler] = {}
    t = datetime(2026, 10, 6, 10, 35, tzinfo=timezone.utc)
    nutzlast = mb.umschlag(k, g, zaehler, t)
    _pruefer("mqtt-measurement-samples.schema.json").validate(nutzlast)
    assert nutzlast["sequence"] == int(t.timestamp()) // 300
    assert nutzlast["observed_at"] == "2026-10-06T10:35:00Z"
    sample = nutzlast["samples"][0]
    assert sample["point_key"] == SCHLUESSEL
    assert sample["decoded"] == pytest.approx(sample["raw"] * 0.1)
    # Nicht auf dem Raster der Kadenz: kein Umschlag.
    assert mb.umschlag(k, g, zaehler, t + timedelta(minutes=2)) is None


def test_nach_dem_lernen_liefert_die_box_die_letzten_160_stunden_nach_danach_im_takt():
    jetzt = [datetime(2026, 10, 6, 12, 0, 1, tzinfo=timezone.utc).timestamp()]
    client = FakeClient()
    box = mb.MessBox(_konf(), client_fabrik=lambda _k, _cb: client, uhr=lambda: jetzt[0], echo=lambda _t: None)
    box.halt.wait = lambda _s: False  # die Drossel schläft im Test nicht
    box.empfangen(mb.auswahl_topic(box.k), json.dumps(_auswahl(1)).encode())
    quittungen = [n for t, n, r in client.gesendet if t.endswith("measurement-config-status")]
    assert len(quittungen) == 1 and client.gesendet[0][2] is True
    box.laufen(hoechstens=1, schlafen=lambda _s: None)
    umschlaege = [n for t, n, _r in client.gesendet if t.endswith("measurement-samples")]
    # 160 Stunden zu je zwölf Fünf-Minuten-Schritten: die erste Messzeit nach dem Beginn, die letzte jetzt.
    assert len(umschlaege) == 160 * 12
    assert umschlaege[0]["observed_at"] == "2026-09-29T20:05:00Z"
    assert umschlaege[-1]["observed_at"] == "2026-10-06T12:00:00Z"
    sequenzen = [u["sequence"] for u in umschlaege]
    assert sequenzen == sorted(sequenzen) and len(set(sequenzen)) == len(sequenzen)
    staende = [u["samples"][0]["raw"] for u in umschlaege]
    assert staende == sorted(staende)
    # Danach im Takt: die nächste Messzeit erst, wenn sie da ist (eine Schleife, die Uhr läuft im Schlaf).
    uhrzeiten = iter([datetime(2026, 10, 6, 12, 4, 0, tzinfo=timezone.utc).timestamp(),
                      datetime(2026, 10, 6, 12, 5, 30, tzinfo=timezone.utc).timestamp()])

    def schlafen(_s):
        jetzt[0] = next(uhrzeiten, jetzt[0])

    vorher = len(client.gesendet)
    box.laufen(hoechstens=3, schlafen=schlafen)
    neu = [n for t, n, _r in client.gesendet[vorher:] if t.endswith("measurement-samples")]
    assert [n["observed_at"] for n in neu] == ["2026-10-06T12:05:00Z"]


def test_ohne_zustellung_sendet_die_box_nichts_und_eine_geloeschte_auswahl_beendet_das_senden():
    jetzt = [datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc).timestamp()]
    client = FakeClient()
    box = mb.MessBox(_konf(), client_fabrik=lambda _k, _cb: client, uhr=lambda: jetzt[0], echo=lambda _t: None)
    box.laufen(hoechstens=1, schlafen=lambda _s: None)
    assert client.gesendet == []
    box.halt.wait = lambda _s: False
    box.empfangen(mb.auswahl_topic(box.k), json.dumps(_auswahl(1)).encode())
    box.laufen(hoechstens=1, schlafen=lambda _s: None)
    vorher = len(client.gesendet)
    box.empfangen(mb.auswahl_topic(box.k), b"")
    jetzt[0] += 600
    box.laufen(hoechstens=1, schlafen=lambda _s: None)
    assert len(client.gesendet) == vorher


def test_konfiguration_bricht_vor_dem_senden_ab():
    with pytest.raises(ValueError, match="VP_MESSBOX_DEVICE fehlt"):
        mb.konfiguration({"VP_MESSBOX_TENANT": TENANT, "VP_MESSBOX_SITE": SITE})
    with pytest.raises(ValueError, match="kanonische"):
        mb.konfiguration({**UMGEBUNG, "VP_MESSBOX_SITE": "2364973a367d428ea64897cc8f93de09"})
    with pytest.raises(ValueError, match="sieben Tagen"):
        mb.konfiguration({**UMGEBUNG, "VP_MESSBOX_NACHLIEFERN_H": "168"})
    k = _konf(VP_MESSBOX_BROKER="emqx", VP_MESSBOX_PV_PEAK_KW="150")
    assert k.broker == "emqx" and k.anlage.spitze_kw == 150.0 and k.nachliefern_h == 160
