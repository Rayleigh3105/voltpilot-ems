"""MiSpeL MP-13: der MiSpeL-Check in der Simulation.

Preise und Wetter ohne Datenbank, die Fenster-Uhr, der Monatszustand in der
Kette und der Check selbst über ein GESCHRUMPFTES Fenster (wenige Tage, echte
HiGHS-Lösungen). Der Ganzjahreslauf 10/2025-09/2026 ist der Prüfnachweis des
PRs, kein Unit-Test (Minuten statt Sekunden)."""

from __future__ import annotations

import importlib.util
import json
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from voltpilot_forecast.weather import IrradianceSample

from voltpilot_optimization import mispel_abgrenzung
from voltpilot_optimization.simulation import mispel_check as mc
from voltpilot_optimization.simulation.data import (
    BERLIN,
    expand_price_rows,
    price_rows_from_json,
    window_slot_starts,
)
from voltpilot_optimization.simulation.profiles import business_series_kw
from voltpilot_optimization.simulation.runner import _MonatsBuchung

FIXTURE = Path(__file__).parent / "fixtures" / "day-ahead-de-lu-2025-10-bis-2026-09.json"

solver = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)


# --------------------------------------------------------------------------- Preise ohne Datenbank


def test_fenster_10_2025_bis_09_2026_hat_365_tage_berliner_zeit():
    slots = window_slot_starts(2025, 10)
    assert len(slots) == 365 * 96
    assert slots[0] == datetime(2025, 10, 1, tzinfo=BERLIN).astimezone(timezone.utc)
    assert slots[-1].astimezone(BERLIN) == datetime(2026, 9, 30, 23, 45, tzinfo=BERLIN)


def test_preis_fixture_ist_die_preisstatistik_des_konzepts():
    """Konzept § 3: Mittel 104,05 €/MWh, 2 052 negative Viertelstunden."""
    slots = window_slot_starts(2025, 10)
    prices = expand_price_rows(price_rows_from_json(json.loads(FIXTURE.read_text())), slots)
    assert len(prices) == 35040
    assert round(sum(prices) / len(prices), 2) == 104.05
    assert sum(1 for p in prices if p < 0) == 2052


def test_energy_charts_format_stunden_und_viertelstunden_gemischt():
    """Bis 30.09.2025 stündlich, danach Viertelstunden - die Schrittweite
    zwischen zwei Stempeln ist die Auflösung; eine Stunde deckt vier Slots."""
    t0 = int(datetime(2025, 9, 30, 22, tzinfo=BERLIN).timestamp())
    stamps = [t0, t0 + 3600, t0 + 7200, t0 + 8100]
    doc = {"unix_seconds": stamps, "price": [10.0, 20.0, 30.0, 40.0]}
    rows = price_rows_from_json(doc)
    assert [r[1] for r in rows] == ["PT60M", "PT60M", "PT15M", "PT15M"]
    slots = [datetime.fromtimestamp(t0, timezone.utc) + timedelta(minutes=15 * i) for i in range(10)]
    assert expand_price_rows(rows, slots) == [10.0] * 4 + [20.0] * 4 + [30.0, 40.0]


def test_kompaktes_format_null_ist_eine_luecke_nie_null():
    start = datetime(2026, 1, 1, tzinfo=BERLIN)
    preise = [50.0, None, 70.0] + [60.0] * 97
    doc = {"beginn": start.isoformat(), "aufloesung_min": 15, "preise": preise}
    slots = [start.astimezone(timezone.utc) + timedelta(minutes=15 * i) for i in range(100)]
    # Lückenregel des Datenbankpfads: die Lücke trägt den letzten Preis.
    assert expand_price_rows(price_rows_from_json(doc), slots)[:3] == [50.0, 50.0, 70.0]


def test_kompaktes_format_kennt_nur_15_und_60_minuten():
    with pytest.raises(ValueError, match="aufloesung_min"):
        price_rows_from_json({"beginn": "2026-01-01T00:00:00+01:00", "aufloesung_min": 30, "preise": [1.0]})


# --------------------------------------------------------------------------- Lastprofil Gewerbe


def test_gewerbeprofil_werktag_tagsueber_sonntag_grundlast():
    slots = window_slot_starts(2026, 3, 1)
    load = business_series_kw(slots, 5000.0)
    assert sum(load) * 0.25 == pytest.approx(5000.0)
    by_local = {s.astimezone(BERLIN): kw for s, kw in zip(slots, load)}
    mittwoch_mittag = by_local[datetime(2026, 3, 4, 12, tzinfo=BERLIN)]
    mittwoch_nacht = by_local[datetime(2026, 3, 4, 2, tzinfo=BERLIN)]
    sonntag_mittag = by_local[datetime(2026, 3, 8, 12, tzinfo=BERLIN)]
    assert mittwoch_mittag > 3 * mittwoch_nacht
    assert sonntag_mittag == pytest.approx(mittwoch_nacht, rel=1e-3)


# --------------------------------------------------------------------------- Monatszustand in der Kette


def _slot(battery_kw, grid_kw):
    return SimpleNamespace(battery_kw=battery_kw, grid_kw=grid_kw)


def test_monatsbuchung_ist_der_speichervorrang_des_rechenwerks():
    """(5), (6), (9) = Σ(1)¼, (11) = Σ(2)¼ wie A1 S. 33-34 - gegen das
    Rechenwerk gerechnet, nicht gegen eine zweite Formel."""
    tag = datetime(2026, 1, 10, tzinfo=BERLIN).astimezone(timezone.utc)
    slots = [_slot(8.0, 12.0), _slot(8.0, 3.0), _slot(-6.0, -10.0), _slot(-6.0, -2.0), _slot(0.0, 4.0)]
    buchung = _MonatsBuchung()
    buchung.buche(tag, slots)
    q = [
        mispel_abgrenzung.viertelstunde("A1", {
            "Z1NB¼": max(s.grid_kw, 0) * 0.25, "Z1NE¼": max(-s.grid_kw, 0) * 0.25,
            "Z2V¼": max(s.battery_kw, 0) * 0.25, "Z2E¼": max(-s.battery_kw, 0) * 0.25, "AW¼": 7,
        })
        for s in slots
    ]
    assert buchung.werte["(9)"] == pytest.approx(float(sum(x["(1)¼"] for x in q)))
    assert buchung.werte["(11)"] == pytest.approx(float(sum(x["(2)¼"] for x in q)))
    assert buchung.werte["(5)"] == pytest.approx(4.0)
    assert buchung.werte["(6)"] == pytest.approx(3.0)
    assert buchung.viertelstunden == 5


def test_monatsbuchung_beginnt_jeden_kalendermonat_leer():
    """Saldierungsperiode ist der Kalendermonat (A1 S. 14): am Monatsersten
    ist der Stand leer, ein Folgetag im selben Monat trägt ihn weiter."""
    buchung = _MonatsBuchung()
    jan31 = datetime(2026, 1, 31, tzinfo=BERLIN).astimezone(timezone.utc)
    feb1 = datetime(2026, 2, 1, tzinfo=BERLIN).astimezone(timezone.utc)
    buchung.buche(jan31, [_slot(4.0, 4.0)] * 96)
    fenster = [feb1 + timedelta(minutes=15 * i) for i in range(192)]
    staende = buchung.staende(feb1, fenster, 0.9)
    assert [s.bisher_kwh for s in staende] == [0.0]
    assert buchung.viertelstunden == 0
    # 12 h Netzstrom einspeichern, 12 h zurückspeisen: (16) = (13) = 48 kWh.
    buchung.buche(feb1, [_slot(4.0, 4.0)] * 48 + [_slot(-4.0, -4.0)] * 48)
    zweiter = buchung.staende(feb1 + timedelta(days=1), fenster[96:], 0.9)
    assert zweiter[0].bisher_kwh == pytest.approx(48.0)


# --------------------------------------------------------------------------- Check über ein geschrumpftes Fenster


def _synthetische_preise(slots):
    """Billige Nächte, teure Abende, negative Mittage am Wochenende."""
    out = []
    for s in slots:
        local = s.astimezone(BERLIN)
        if 0 <= local.hour < 5:
            out.append(20.0)
        elif 17 <= local.hour < 21:
            out.append(260.0)
        elif 11 <= local.hour < 15 and local.weekday() >= 5:
            out.append(-15.0)
        else:
            out.append(95.0)
    return out


class _SonnigesWetter:
    def hourly_irradiance(self, latitude, longitude, year):
        index = {}
        start = datetime(2026, 5, 1, tzinfo=timezone.utc)
        for h in range(24 * 40):
            t = start + timedelta(hours=h)
            if 8 <= t.astimezone(BERLIN).hour < 17:
                index[t] = IrradianceSample(ghi_w_m2=700.0, dni_w_m2=500.0, dhi_w_m2=150.0)
        return index


@pytest.fixture
def mai_fenster(monkeypatch):
    """Drei Tage Ende Mai bis 1. Juni: eine Monatsgrenze im Fenster."""
    start = datetime(2026, 5, 30, tzinfo=BERLIN).astimezone(timezone.utc)
    slots = [start + timedelta(minutes=15 * i) for i in range(3 * 96)]
    monkeypatch.setattr(mc, "window_slot_starts", lambda year, month, months: slots)
    return slots


def _deps(**kw):
    return mc.CheckDeps(
        load_prices=lambda zone, slots: _synthetische_preise(slots),
        weather=_SonnigesWetter(),
        **kw,
    )


def test_nicht_unterstuetzter_formelsatz_bekommt_keine_naeherung():
    for satz in ("A2", "A5", "A5-Variante", "A6"):
        r = mc.mispel_check(replace(mc.KUNDENTYPEN["a"], formelsatz=satz), _deps())
        assert r["unterstuetzt"] is False
        assert mc.NICHT_UNTERSTUETZT in r["hinweis"]


def test_formelsatz_und_anlage_passen_zusammen():
    with pytest.raises(ValueError, match="A10 ist der reine Netzspeicher"):
        mc.mispel_check(replace(mc.KUNDENTYPEN["b"], jahresverbrauch_kwh=1000.0), _deps())
    with pytest.raises(ValueError, match="ohne Erzeugungsanlage"):
        mc.mispel_check(replace(mc.KUNDENTYPEN["b"], formelsatz="A11", pv_kwp=10.0), _deps())
    with pytest.raises(ValueError, match="anzulegendem Wert"):
        mc.mispel_check(replace(mc.KUNDENTYPEN["a"], anzulegender_wert_ct=None), _deps())


@solver
def test_reiner_netzspeicher_a10_saldierung_macht_den_handel(mai_fenster):
    mittel = {"mittel": mc.STANDARD_FAELLE["mittel"]}
    r = mc.mispel_check(mc.KUNDENTYPEN["b"], _deps(), faelle=mittel)
    assert r["unterstuetzt"] is True and r["formelsatz"] == "A10"
    f = r["faelle"]["mittel"]
    # Ohne PV und Last tut der sture Speicher nichts - die Messlatte ist 0.
    assert f["stur"]["nettoKostenEur"] == 0.0
    heute = f["heute"]["vorteilGegenStur"]["volleVoraussichtEur"]
    mit = f["mitMispel"]["vorteilGegenStur"]["volleVoraussichtEur"]
    assert mit > heute >= -1e-6
    assert f["mitMispel"]["einspeisungKwh"] > f["heute"]["einspeisungKwh"]
    # (20)A10 = (3): jeder Netzbezug ist umlagereduziert (A1 S. 96).
    monate = f["mitMispel"]["rechenwerk"]["monate"]
    assert set(monate) == {"2026-05", "2026-06"}
    menge = sum(m["umlagereduzierendeMengeKwh"] for m in monate.values())
    assert menge == pytest.approx(f["mitMispel"]["netzbezugKwh"], abs=0.2)
    saldiert = (4.0 + 2.946) * 10  # Netzentgelt-AP + Umlagen, EUR/MWh, USt 0
    assert f["mitMispel"]["gutschriftSaldierungEur"] == pytest.approx(menge * saldiert / 1000, abs=0.05)
    assert r["spanne"] == {"mittel": f["differenzEur"]}
    assert f["differenzEur"] == pytest.approx(sum(p["eur"] for p in f["posten"]), abs=0.02)
    assert r["marktwerteSolarCt"] is None


@solver
def test_gewerbe_mit_eeg_pv_a1_mischbetrieb_und_rechenwerk(mai_fenster):
    anlage = replace(mc.KUNDENTYPEN["a"], jahresverbrauch_kwh=4000.0, speicher_kwh=40.0, speicher_kw=20.0)
    r = mc.mispel_check(anlage, _deps(), faelle={"mittel": mc.STANDARD_FAELLE["mittel"]})
    f = r["faelle"]["mittel"]
    rw = f["mitMispel"]["rechenwerk"]
    assert rw["formelsatz"] == "A1"
    assert set(rw["monate"]) == {"2026-05", "2026-06"}
    for m in rw["monate"].values():
        assert {"saldierungsfaehigeEinspeisungKwh", "foerderfaehigeEinspeisungKwh",
                "umlagereduzierendeMengeKwh", "marktpraemieEur"} <= set(m)
    # Gesicherte Zuordnung (16): ohne Netzstrom im Speicher keine Saldierung.
    jahr = rw["jahre"]["2026"]
    assert jahr["(22)"] >= 0 and jahr["(33)"] > 0
    # Posten: Handel, Marktwert-Effekt, Z2, Bilanzkreis - Summe = Differenz.
    namen = [p["posten"] for p in f["posten"]]
    assert namen == ["Netzladen-Handel mit Saldierung", "Jahresmarktwert statt Monatsmarktwert",
                     "Zweiter Zähler Z2", "Gesonderter Bilanzkreis"]
    assert f["differenzEur"] == pytest.approx(sum(p["eur"] for p in f["posten"]), abs=0.02)
    # Marktwerte: Näherung je Monat, ein Fensterwert je Kalenderjahr.
    mw = r["marktwerteSolarCt"]
    assert set(mw["monat"]) == {"2026-05", "2026-06"} and set(mw["jahr"]) == {"2026"}
    assert mw["genaehert"] == ["2026", "2026-05", "2026-06"]
    namen_annahmen = {a["name"] for a in r["annahmen"]}
    assert {"Vergleich", "AW¼", "Marktwert Solar", "Zweiter Zähler Z2 €/a"} <= namen_annahmen


@solver
def test_heute_im_eeg_modus_laedt_nie_aus_dem_netz(mai_fenster, monkeypatch):
    """Ausschließlichkeitsoption heute im EEG-Modus nach FK3 (Konzept § 8.5,
    W1 = D): je Viertelstunde lädt der Speicher höchstens die PV-Erzeugung."""
    seen = {}
    original = mc.run_milp_year

    def spy(data, battery, netzladen, **kw):
        dispatch = original(data, battery, netzladen, **kw)
        seen.setdefault("misch" if kw.get("mischbetrieb") else "heute", (data, dispatch, netzladen))
        return dispatch

    monkeypatch.setattr(mc, "run_milp_year", spy)
    anlage = replace(mc.KUNDENTYPEN["a"], jahresverbrauch_kwh=4000.0, speicher_kwh=40.0, speicher_kw=20.0)
    mc.mispel_check(anlage, _deps(), faelle={"mittel": mc.STANDARD_FAELLE["mittel"]})
    data, dispatch, netzladen = seen["heute"]
    assert netzladen is False
    for b, pv in zip(dispatch.battery_kw, data.pv_kw):
        assert b <= pv + 1e-3  # Planwerte sind gerundet
    assert seen["misch"][2] is True


@solver
def test_amtliche_marktwerte_gehen_vor(mai_fenster):
    deps = _deps(
        monatsmarktwerte_ct={date(2026, 5, 1): 3.296, date(2026, 6, 1): 4.0},
        jahresmarktwerte_ct={2026: 5.0},
    )
    anlage = replace(mc.KUNDENTYPEN["a"], jahresverbrauch_kwh=4000.0, speicher_kwh=40.0, speicher_kw=20.0)
    r = mc.mispel_check(anlage, deps, faelle={"mittel": mc.STANDARD_FAELLE["mittel"]})
    mw = r["marktwerteSolarCt"]
    assert mw["monat"]["2026-05"] == 3.296 and mw["jahr"]["2026"] == 5.0
    assert mw["genaehert"] == []


@solver
def test_kommandozeile_liest_preise_aus_json(mai_fenster, tmp_path, capsys):
    preise = tmp_path / "preise.json"
    start = mai_fenster[0]
    preise.write_text(json.dumps({
        "beginn": start.isoformat(), "aufloesung_min": 15,
        "preise": _synthetische_preise(mai_fenster),
    }))
    assert mc.main(["--kundentyp", "b", "--preise", str(preise), "--fall", "mittel"]) == 0
    doc = json.loads(capsys.readouterr().out)
    assert doc["formelsatz"] == "A10" and list(doc["spanne"]) == ["mittel"]
    assert doc["fenster"] == {"von": "2026-05-30", "bis": "2026-06-01", "viertelstunden": 288}


@solver
def test_heute_streng_laedt_nie_bei_gleichzeitigem_netzbezug(mai_fenster, monkeypatch):
    """Die Lesart der Festlegung (A1 S. 11, MP-45) als Option für „heute“:
    kein Verbrauch im Speicher, während es gleichzeitig einen Netzbezug gibt."""
    seen = {}
    original = mc.run_milp_year

    def spy(data, battery, netzladen, **kw):
        dispatch = original(data, battery, netzladen, **kw)
        if not kw.get("mischbetrieb"):
            seen["heute"] = (dispatch, kw.get("strenge"))
        return dispatch

    monkeypatch.setattr(mc, "run_milp_year", spy)
    anlage = replace(mc.KUNDENTYPEN["a"], jahresverbrauch_kwh=4000.0, speicher_kwh=40.0, speicher_kw=20.0)
    r = mc.mispel_check(anlage, _deps(), faelle={"mittel": mc.STANDARD_FAELLE["mittel"]}, heute_streng=True)
    dispatch, strenge = seen["heute"]
    assert strenge is True
    for b, g in zip(dispatch.battery_kw, dispatch.grid_kw):
        assert not (b > 1e-3 and g > 1e-3)
    annahme = next(a for a in r["annahmen"] if a["name"] == "Ausschließlichkeitsoption heute")
    assert annahme["art"] == "Lesart"
