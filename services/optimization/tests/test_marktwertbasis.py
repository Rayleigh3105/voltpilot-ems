"""MiSpeL MP-12: die Marktwertbasis aus dem Förderweg im Optimierer.

Eine Anlage in einer MiSpeL-Option (Abgrenzung, Pauschal) rechnet die
Marktprämie mit dem Jahresmarktwert Solar (Anlage 1 S. 21 Vor. 5, Anlage 2
S. 20) und nur in AW>0-Viertelstunden laut ÜNB-Liste (Formel (24)¼, Anlage 1
S. 17 Fn. 8, S. 38); ohne Listeneintrag gilt der W4-Rückfall "keine Prämie bei
SP¼ < 0". Jede andere Anlage und jeder Tag vor der MiSpeL-Fassung bleibt beim
Monatsmarktwert - bitgenau wie vorher. Reine Funktionen plus der Lader über das
fake-psycopg-Muster.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

import pytest

from voltpilot_optimization.marktwertbasis import (
    AW_REGELN,
    MarktwertBasis,
    _aw_je_viertelstunde,
    _foerderweg_am,
    load_marktwertbasis,
    praemien_viertelstunde,
)
from voltpilot_optimization.pricing import (
    SiteTariff,
    export_values,
    marktpraemie_eur_mwh,
)

UTC = timezone.utc
DV = SiteTariff(plant_kind="direktvermarktung", anzulegender_wert_ct_kwh=10.0)
SEPTEMBER = date(2026, 9, 1)
OKTOBER = date(2026, 10, 1)
# Monatsmarktwert Solar 5 ct, Jahresmarktwert Solar 2026 7 ct, AW 10 ct.
MONATE = {SEPTEMBER: 5.0, OKTOBER: 5.0}
# 01.10.2026 00:00 Berlin = 30.09.2026 22:00 UTC (Sommerzeit).
MITTERNACHT = datetime(2026, 9, 30, 22, 0, tzinfo=UTC)
LETZTE_SEPTEMBER = MITTERNACHT - timedelta(minutes=15)
ERSTE_OKTOBER = MITTERNACHT


def _mispel(**kw) -> MarktwertBasis:
    return MarktwertBasis(
        mispel_tage=frozenset({OKTOBER, date(2026, 10, 2)}),
        jahresmarktwert_ct={2026: 7.0},
        **kw,
    )


def test_ohne_basis_bleibt_der_monatsmarktwert_bitgenau():
    slots = [ERSTE_OKTOBER, ERSTE_OKTOBER + timedelta(minutes=15)]
    spot = [80.0, -5.0]
    alt = export_values(DV, False, spot, slots, MONATE)
    assert alt == [80.0 + 50.0, -5.0]
    assert export_values(DV, False, spot, slots, MONATE, marktwert=MarktwertBasis()) == alt


def test_mispel_tag_mit_jahres_anderer_tag_mit_monatsmarktwert():
    # Der Tag entscheidet (Europe/Berlin): die letzte Septemberviertelstunde liegt
    # vor der MiSpeL-Fassung ab 01.10., die erste Oktoberviertelstunde danach.
    slots = [LETZTE_SEPTEMBER, ERSTE_OKTOBER]
    werte = export_values(DV, False, [80.0, 80.0], slots, MONATE, marktwert=_mispel())
    assert werte == [80.0 + (10.0 - 5.0) * 10, 80.0 + (10.0 - 7.0) * 10]


def test_zwei_anlagen_dieselben_preise_jahres_gegen_monatsmarktwert():
    slots = [ERSTE_OKTOBER + timedelta(hours=12)]
    mispel = export_values(DV, False, [60.0], slots, MONATE, marktwert=_mispel())
    andere = export_values(DV, False, [60.0], slots, MONATE)
    assert mispel == [60.0 + 30.0]
    assert andere == [60.0 + 50.0]


def test_aw_liste_gewinnt_gegen_das_vorzeichen_des_spotpreises():
    t0 = ERSTE_OKTOBER + timedelta(hours=12)
    t1, t2 = t0 + timedelta(minutes=15), t0 + timedelta(minutes=30)
    # t0: Liste "Nein" bei positivem Spot; t1: Liste "Ja" bei negativem Spot
    # (Stunden-Differenzierung); t2: kein Eintrag -> Rückfall SP¼ < 0.
    basis = _mispel(aw_groesser_null={t0: False, t1: True}, aw_regeln={OKTOBER: "stunden_4"})
    werte = export_values(DV, False, [40.0, -3.0, -3.0], [t0, t1, t2], MONATE, marktwert=basis)
    assert werte == [40.0, -3.0 + 30.0, -3.0]
    assert praemien_viertelstunde(basis, t0, 40.0) == (False, False)
    assert praemien_viertelstunde(basis, t1, -3.0) == (True, False)
    assert praemien_viertelstunde(basis, t2, -3.0) == (False, True)
    assert praemien_viertelstunde(basis, t2, 0.0) == (True, True)


def test_fehlender_jahresmarktwert_heisst_keine_praemie_nie_der_monatswert(caplog):
    basis = MarktwertBasis(mispel_tage=frozenset({OKTOBER}))
    with caplog.at_level(logging.WARNING, logger="voltpilot.optimization.pricing"):
        werte = export_values(DV, False, [80.0], [ERSTE_OKTOBER], MONATE, marktwert=basis)
    assert werte == [80.0]
    assert any(r.message == "pricing.jahresmarktwert_missing" for r in caplog.records)


def test_praemienreihe_fuer_den_mischbetrieb():
    # Die Reihe, die MP-10 für grün/gelb liest: 0 = keine Prämie, nie None.
    slots = [LETZTE_SEPTEMBER, ERSTE_OKTOBER, ERSTE_OKTOBER + timedelta(minutes=15)]
    reihe = marktpraemie_eur_mwh(DV, [80.0, 80.0, -1.0], slots, MONATE, _mispel())
    assert reihe == [50.0, 30.0, 0.0]
    ohne_aw = SiteTariff(plant_kind="direktvermarktung")
    assert marktpraemie_eur_mwh(ohne_aw, [80.0], [ERSTE_OKTOBER], MONATE, _mispel()) == [0.0]


def test_jahresmarktwert_ueber_dem_anzulegenden_wert_gibt_null_nie_negativ():
    basis = MarktwertBasis(mispel_tage=frozenset({OKTOBER}), jahresmarktwert_ct={2026: 12.0})
    assert export_values(DV, False, [80.0], [ERSTE_OKTOBER], MONATE, marktwert=basis) == [80.0]


def test_haendlermodus_bleibt_blanker_spot_auch_am_mispel_tag():
    # Netzladen eingestellt: der Mischbetrieb kommt mit MP-10, bis dahin Spot.
    assert export_values(DV, True, [80.0], [ERSTE_OKTOBER], MONATE, marktwert=_mispel()) == [80.0]


def test_foerderweg_je_tag_ist_die_spaeteste_fassung():
    fassungen = [
        (date(2026, 10, 1), "marktpraemie_abgrenzung"),
        (date(2026, 11, 1), "marktpraemie_ausschliesslichkeit"),
    ]
    assert _foerderweg_am(fassungen, date(2026, 9, 30)) is None
    assert _foerderweg_am(fassungen, date(2026, 10, 31)) == "marktpraemie_abgrenzung"
    assert _foerderweg_am(fassungen, date(2026, 11, 1)) == "marktpraemie_ausschliesslichkeit"


def test_stundenzeile_gilt_fuer_vier_viertelstunden_die_feinere_gewinnt():
    h = datetime(2026, 10, 1, 10, 0, tzinfo=UTC)
    aw = _aw_je_viertelstunde([
        (h + timedelta(minutes=30), "PT15M", True),
        (h, "PT60M", False),
    ])
    assert aw == {
        h: False,
        h + timedelta(minutes=15): False,
        h + timedelta(minutes=30): True,
        h + timedelta(minutes=45): False,
    }


def test_regeln_sind_die_sieben_veroeffentlichungen():
    assert AW_REGELN == {
        "viertelstunde", "viertelstunde_2ct",
        "stunden_1", "stunden_2", "stunden_3", "stunden_4", "stunden_6",
    }


# --- der Lader über fake-psycopg ----------------------------------------------

SITE = UUID("00000000-0000-0000-0000-000000000012")


# Was die Fake-Datenbank liefert: die Fassungen (gueltig_ab, foerderweg,
# aw_regel) und die ÜNB-Liste (regel, ts, aufloesung, aw_groesser_null).
FASSUNGEN = [(date(2026, 10, 1), "marktpraemie_pauschal", None)]
LISTE = [("viertelstunde", ERSTE_OKTOBER, "PT15M", False)]


class _Cursor:
    def __init__(self, log: list, fassungen=None, liste=None) -> None:
        self.log = log
        self._rows: list = []
        self.fassungen = FASSUNGEN if fassungen is None else fassungen
        self.liste = LISTE if liste is None else liste

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        self.log.append((sql, params))
        if "FROM site_foerderweg" in sql:
            self._rows = self.fassungen
        elif "FROM annual_market_value" in sql:
            self._rows = [(2026, 7.0)]
        elif "FROM eeg_aw_zeit" in sql:
            self._rows = [r for r in self.liste if r[0] in params[0]]
        else:  # pragma: no cover
            raise AssertionError(f"unhandled query: {sql}")

    def fetchall(self):
        return self._rows


def _fake(monkeypatch, fassungen=None, liste=None) -> list:
    log: list = []

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _Cursor(log, fassungen, liste)

    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn()))
    return log


@pytest.fixture()
def fake_db(monkeypatch):
    return _fake(monkeypatch)


def test_lader_ohne_regel_liest_keine_liste(fake_db):
    # Fassung ohne AW-Differenzierung (wie jede Fassung vor MP-12b): die Liste
    # wird nicht gelesen, jede MiSpeL-Viertelstunde läuft über den Rückfall.
    basis = load_marktwertbasis("postgresql://fake", SITE, [LETZTE_SEPTEMBER, ERSTE_OKTOBER])
    assert basis.mispel_tage == {OKTOBER}
    assert basis.jahresmarktwert_ct == {2026: 7.0}
    assert basis.aw_groesser_null == {} and basis.aw_regeln == {}
    assert not any("eeg_aw_zeit" in sql for sql, _ in fake_db)
    assert praemien_viertelstunde(basis, ERSTE_OKTOBER, -1.0) == (False, True)


def test_lader_mit_regel_stunden_4_rechnet_nach_der_liste(monkeypatch):
    # MP-12b, der Prüfnachweis im Optimierer: die Fassung trägt stunden_4; die
    # Stundenzeile "Ja" gilt für alle vier Viertelstunden - auch für die mit
    # negativem Spot - und kein Ergebnis ist vorläufig. Die Liste einer anderen
    # Regel ("viertelstunde": "Nein") trifft nicht.
    log = _fake(
        monkeypatch,
        fassungen=[(date(2026, 10, 1), "marktpraemie_abgrenzung", "stunden_4")],
        liste=[
            ("stunden_4", ERSTE_OKTOBER, "PT60M", True),
            ("viertelstunde", ERSTE_OKTOBER, "PT15M", False),
        ],
    )
    slots = [ERSTE_OKTOBER + timedelta(minutes=15 * q) for q in range(4)]
    basis = load_marktwertbasis("postgresql://fake", SITE, slots)
    assert basis.aw_regeln == {OKTOBER: "stunden_4"}
    assert basis.aw_groesser_null == {t: True for t in slots}
    [(_, params)] = [(sql, p) for sql, p in log if "eeg_aw_zeit" in sql]
    assert params[0] == ["stunden_4"]
    assert praemien_viertelstunde(basis, slots[1], -3.0) == (True, False)
    werte = export_values(DV, False, [40.0, -3.0], slots[:2], MONATE, marktwert=basis)
    assert werte == [40.0 + 30.0, -3.0 + 30.0]


def test_mischbetrieb_liest_die_praemie_nach_der_aw_regel(monkeypatch):
    # MiSpeL MP-10 baut seine Prämie für grün/gelb genau so (inputs.py, Zweig
    # site.mischbetrieb: ohne Monatsmarktwerte, Basis aus load_marktwertbasis):
    # mit stunden_4 und Stundenzeile "Ja" trägt auch die negative Viertelstunde
    # die Prämie; ohne Regel fällt sie dort weg (W4-Rückfall).
    slots = [ERSTE_OKTOBER + timedelta(minutes=15 * q) for q in range(2)]
    mit_regel = [(date(2026, 10, 1), "marktpraemie_abgrenzung", "stunden_4")]
    liste = [("stunden_4", ERSTE_OKTOBER, "PT60M", True)]
    _fake(monkeypatch, fassungen=mit_regel, liste=liste)
    praemie = marktpraemie_eur_mwh(
        DV, [40.0, -3.0], slots, {}, load_marktwertbasis("postgresql://fake", SITE, slots)
    )
    assert praemie == [30.0, 30.0]
    ohne_regel = [(date(2026, 10, 1), "marktpraemie_abgrenzung", None)]
    _fake(monkeypatch, fassungen=ohne_regel, liste=liste)
    praemie = marktpraemie_eur_mwh(
        DV, [40.0, -3.0], slots, {}, load_marktwertbasis("postgresql://fake", SITE, slots)
    )
    assert praemie == [30.0, 0.0]


def test_lader_nimmt_je_tag_die_regel_der_fassung(monkeypatch):
    # Eine Korrektur der Regel am 02.10. (gleicher Förderweg): der 01.10. liest
    # die Liste von stunden_4, der 02.10. die von viertelstunde.
    zweite = ERSTE_OKTOBER + timedelta(days=1)
    _fake(
        monkeypatch,
        fassungen=[
            (date(2026, 10, 1), "marktpraemie_abgrenzung", "stunden_4"),
            (date(2026, 10, 2), "marktpraemie_abgrenzung", "viertelstunde"),
        ],
        liste=[
            ("stunden_4", ERSTE_OKTOBER, "PT60M", False),
            ("stunden_4", zweite, "PT60M", False),
            ("viertelstunde", ERSTE_OKTOBER, "PT15M", True),
            ("viertelstunde", zweite, "PT15M", True),
        ],
    )
    basis = load_marktwertbasis("postgresql://fake", SITE, [ERSTE_OKTOBER, zweite])
    assert basis.aw_regeln == {OKTOBER: "stunden_4", date(2026, 10, 2): "viertelstunde"}
    assert basis.aw_amtlich(ERSTE_OKTOBER) is False
    assert basis.aw_amtlich(zweite) is True


def test_aw_regeln_sind_die_des_vertrags_und_der_marktdaten():
    v2 = Path(__file__).resolve().parents[3] / "docs" / "contracts" / "v2"
    vektoren = json.loads((v2 / "mispel-foerderweg-vectors.json").read_text(encoding="utf-8"))
    assert AW_REGELN == {r["wert"] for r in vektoren["aw_regeln"]}


def test_lader_ohne_mispel_tag_fragt_keinen_marktwert(monkeypatch):
    log: list = []

    class _C(_Cursor):
        def execute(self, sql, params=()):
            self.log.append((sql, params))
            self._rows = []

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _C(log)

    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn()))
    assert load_marktwertbasis("postgresql://fake", SITE, [ERSTE_OKTOBER]) == MarktwertBasis()
    assert len(log) == 1


def test_unbekannte_regel_bricht_laut_ab(monkeypatch):
    # Die Datenbank lässt sie nicht zu (CHECK site_foerderweg_aw_regel_chk) -
    # kommt sie trotzdem, rechnet der Lader nicht still weiter.
    _fake(monkeypatch, fassungen=[(date(2026, 10, 1), "marktpraemie_abgrenzung", "stunden_5")])
    with pytest.raises(ValueError):
        load_marktwertbasis("postgresql://fake", SITE, [ERSTE_OKTOBER])
