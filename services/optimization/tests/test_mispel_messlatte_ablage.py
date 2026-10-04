"""MiSpeL MP-33e: die Messlatte „nur laden“ wird je Ladepunkt und Viertelstunde abgelegt.

Vertrag ``docs/contracts/v2/mispel-messlatte-nur-laden.md`` § 3; gelesen von der Ertraege-Karte am Ladepunkt
(``mispel-ladepunkt-bidirektional.md`` § 6a, Bedienkonzept BK-41 A). Geprueft wird der Schreiber
(:func:`persistence.messlatte_rows`, Savepoint im Schreiblauf) und ein Monatslauf einer Anlage ohne Hausspeicher (A2)
mit Fahrzeug: Plan, Mengen nach Anlage 1 und Messlatte passen zusammen. Der Lauf plant ``wiederholbar`` (Knotengrenze
MP-33c), damit dieselbe Eingabe dieselbe Ablage ergibt.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import time, timedelta
from fractions import Fraction
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization import fahrzeugspeicher as fz_regeln
from voltpilot_optimization import mispel_abgrenzung, persistence, pricing
from voltpilot_optimization.domain import VIERTELSTUNDE_H
from voltpilot_optimization.fahrzeugspeicher import Anwesenheit, Fenster, Messung
from voltpilot_optimization.solver import MESSLATTE_FELDER, optimize

from test_mispel_fahrzeug_a2 import _a2
from test_mispel_fahrzeugspeicher import BERLIN, V2G, V2H, _abend_preise, _fahrzeug
from test_solver import T0, needs_highs

KOMPONENTE = "6f1b6c2e-3a0d-4c55-9a51-0c1f2a3b4c5d"


def _plan(inp, t0=T0):
    fz = replace(inp.fahrzeug, komponente_id=KOMPONENTE)
    return optimize(replace(inp, fahrzeug=fz), uuid4(), t0, explain_plan=False)


# --- der Schreiber ------------------------------------------------------------


@needs_highs
def test_zeilen_je_slot_aus_der_messlatte():
    plan = _plan(_a2(_fahrzeug(V2H, soc_pct=90.0, n=96), pv=0.0, praemie=0.0, saldiert=0.0))
    ml = plan.fahrzeug.messlatte_nur_laden
    zeilen = persistence.messlatte_rows(plan)
    assert len(zeilen) == len(plan.slots) == len(ml.posten_je_slot)
    for z, slot, p in zip(zeilen, plan.slots, ml.posten_je_slot):
        assert z[:6] == (UUID(KOMPONENTE), slot.start, plan.tenant_id, plan.site_id, plan.plan_id, plan.generated_at)
        assert z[6:] == tuple(round(getattr(p, f), 6) for f in MESSLATTE_FELDER)
    # Summen der Zeilen = Posten ueber den Horizont; die kWh tragen die Betraege.
    for i, feld in enumerate(MESSLATTE_FELDER):
        assert sum(z[6 + i] for z in zeilen) == pytest.approx(getattr(ml.posten, feld), abs=1e-4)
    assert ml.posten.rueckgespeist_kwh == pytest.approx(ml.rueckgespeist_kwh, abs=1e-4)
    assert ml.posten.akku_verschleiss_eur == pytest.approx(-0.03 * ml.posten.rueckgespeist_kwh, abs=1e-4)
    assert ml.posten.weniger_gekauft_kwh > 0.0  # V2H am Abend: weniger aus dem Netz


@needs_highs
def test_ohne_rueckspeisung_ist_der_plan_selbst_nur_laden():
    fz = _fahrzeug(V2G, soc_pct=50.0, n=96)
    plan = _plan(_a2(replace(fz, rueckspeisen_kw=0.0)))
    assert plan.fahrzeug.messlatte_nur_laden is None
    zeilen = persistence.messlatte_rows(plan)
    assert len(zeilen) == len(plan.slots)
    assert all(z[6:] == (0.0,) * len(MESSLATTE_FELDER) for z in zeilen)  # gerechnet 0, nicht unbekannt


@needs_highs
def test_messlatte_nicht_rechenbar_ist_eine_luecke(monkeypatch):
    from voltpilot_optimization import solver

    monkeypatch.setattr(solver, "build_model", _kaputt_beim_zweiten(solver.build_model))
    plan = _plan(_a2(_fahrzeug(V2H, soc_pct=90.0, n=96), pv=0.0, praemie=0.0, saldiert=0.0))
    assert plan.fahrzeug.messlatte_nur_laden is None
    assert any(s.rueckspeisen_kw > 0 for s in plan.fahrzeug.slots)
    assert persistence.messlatte_rows(plan) == []  # keine Zeile: im Portal offen, nie 0


def _kaputt_beim_zweiten(echt):
    aufrufe = []

    def bau(inp, *a, **kw):
        aufrufe.append(1)
        if inp.fahrzeug is not None and inp.fahrzeug.rueckspeisen_kw == 0.0 and len(aufrufe) > 1:
            raise RuntimeError("Messlatte nicht rechenbar")
        return echt(inp, *a, **kw)

    return bau


@needs_highs
def test_ohne_fahrzeug_keine_zeile():
    plan = _plan(_a2(_fahrzeug(V2G, soc_pct=50.0, n=96)))
    assert persistence.messlatte_rows(replace(plan, fahrzeug=None)) == []


class _Cursor:
    def __init__(self, fehler=False):
        self.fehler, self.sql = fehler, []

    def executemany(self, sql, zeilen):
        if self.fehler:
            raise RuntimeError("Komponente geloescht")
        self.sql.append((sql, list(zeilen)))


class _Conn:
    def __init__(self):
        self.savepoints = 0

    def transaction(self):
        conn = self

        class _Sp:
            def __enter__(self):
                conn.savepoints += 1

            def __exit__(self, *exc):
                return False

        return _Sp()


@needs_highs
def test_ablage_im_savepoint_und_fail_soft(caplog):
    plan = _plan(_a2(_fahrzeug(V2H, soc_pct=90.0, n=96), pv=0.0, praemie=0.0, saldiert=0.0))
    cur, conn = _Cursor(), _Conn()
    persistence.TimescaleScheduleRepository._messlatte_ablegen(conn, cur, plan)
    assert conn.savepoints == 1 and len(cur.sql[0][1]) == len(plan.slots)
    # Ein spaeterer Plan ersetzt, ein aelterer nie: die Ablage haelt den Plan, der fuer die Viertelstunde galt.
    assert "ON CONFLICT (komponente_id, zeit)" in cur.sql[0][0]
    assert "WHERE ladepunkt_messlatte.generated_at <= EXCLUDED.generated_at" in cur.sql[0][0]
    # Scheitert die Ablage, bleibt der Plan: Warnung statt Ausnahme.
    persistence.TimescaleScheduleRepository._messlatte_ablegen(_Conn(), _Cursor(fehler=True), plan)
    assert "persist.messlatte_nicht_abgelegt" in caplog.text


# --- Monatslauf A2 mit Fahrzeug: Plan, Mengen und Messlatte passen zusammen -----------------------------


def _bruch(x: float) -> Fraction:
    return Fraction(round(max(x, 0.0), 9)).limit_denominator(10**9)


#: Jeden Abend 18:00 an, morgens 07:00 ab mit 80 % (Wochentage 1-7 wie MP-31 § 5).
JEDEN_ABEND = tuple(Anwesenheit(w, time(18, 0), time(7, 0), 80.0) for w in range(1, 8))


def _tag_a2(tag: int, soc_pct: float):
    """Ein Tag (96 Viertelstunden ab Berliner Mitternacht) im Haus ohne Speicher mit V2G-Fahrzeug."""
    t0 = T0 + timedelta(days=tag)
    starts = [t0 + timedelta(minutes=15 * i) for i in range(96)]
    fz, grund = fz_regeln.fahrzeugspeicher(KOMPONENTE, V2G, Fenster(20.0, 60.0, JEDEN_ABEND),
                                           Messung(True, soc_pct), starts, 15, BERLIN)
    assert grund is None, grund
    spot = _abend_preise(96, seed=tag)
    tarif = pricing.SiteTariff(tarif_art="ohne", supply_price=pricing.DEFAULT_SUPPLY_COMPONENTS)
    sonne = 4.0 if tag % 3 else 1.0  # kWp-Spitze: zwei sonnige Tage, ein trueber
    pv = [max(0.0, sonne * (1.0 - abs((i / 4.0) - 13.0) / 6.0)) for i in range(96)]
    inp = replace(
        _a2(fz, prices=spot),
        slot_starts=starts, pv_kw=pv, wiederholbar=True,
        saldierte_bestandteile_eur_mwh=pricing.saldierte_bestandteile_eur_mwh(tarif),
        import_price_eur_mwh=pricing.structured_import_prices(pricing.DEFAULT_SUPPLY_COMPONENTS, spot),
    )
    return optimize(inp, uuid4(), t0, explain_plan=False)


def monatslauf_a2(tage: int, soc_pct: float = 60.0):
    """Ein Haus ohne Speicher (A2) mit V2G-Fahrzeug, je Tag ein Plan ueber 96 Viertelstunden (wiederholbar).

    Liefert die Ablage (je Viertelstunde die Zeile des Plans, der fuer sie galt - wie das Upsert), die Zaehlerwerte
    des Plans je Viertelstunde (Z1NB/Z1NE am Netzanschluss, Z2V/Z2E am Ladepunkt als getrennte Register wie der
    Simulator MP-34, A1 S. 32) und die Plaene.
    """
    ablage: dict[tuple, tuple] = {}
    zaehler, plaene = [], []
    for tag in range(tage):
        plan = _tag_a2(tag, soc_pct)
        for z in persistence.messlatte_rows(plan):
            alt = ablage.get(z[:2])
            if alt is None or alt[5] <= z[5]:
                ablage[z[:2]] = z
        for s, f in zip(plan.slots, plan.fahrzeug.slots):
            zaehler.append({
                "Z1NB¼": _bruch(max(s.grid_kw, 0.0) * VIERTELSTUNDE_H),
                "Z1NE¼": _bruch(max(-s.grid_kw, 0.0) * VIERTELSTUNDE_H),
                "Z2V¼": _bruch(f.laden_kw * VIERTELSTUNDE_H),
                "Z2E¼": _bruch(f.rueckspeisen_kw * VIERTELSTUNDE_H),
                "AW¼": 1,
            })
        plaene.append(plan)
    return ablage, zaehler, plaene


@needs_highs
@pytest.mark.slow
def test_monatslauf_a2_plan_mengen_und_messlatte_passen_zusammen():
    tage = 30
    ablage, zaehler, plaene = monatslauf_a2(tage)
    messlatten = [p.fahrzeug.messlatte_nur_laden for p in plaene]
    assert all(ml is not None for ml in messlatten)
    assert len(ablage) == tage * 96  # jede Viertelstunde des Monats traegt genau eine Zeile
    qs = [{**w, **mispel_abgrenzung.viertelstunde("A2", w)} for w in zaehler]
    monat = mispel_abgrenzung.monat("A2", mispel_abgrenzung.summen("A2", qs))
    m5, m6 = float(monat["(5)"]), float(monat["(6)"])
    # Plan = Mengen: (5) ist das geplante Laden, (6) das geplante Zurueckspeisen (A1 S. 34-35).
    assert m5 == pytest.approx(sum(f.laden_kw for p in plaene for f in p.fahrzeug.slots) * VIERTELSTUNDE_H, abs=1e-3)
    assert m6 == pytest.approx(sum(f.rueckspeisen_kw for p in plaene for f in p.fahrzeug.slots) * VIERTELSTUNDE_H,
                               abs=1e-3)
    assert m6 > 0.0 and float(monat["(14)A2,A3,A4"]) == pytest.approx(0.85)
    summe = {f: sum(z[6 + i] for z in ablage.values()) for i, f in enumerate(MESSLATTE_FELDER)}
    # Messlatte = Plan: zurueckgespeist ist (6), der Verschleiss 3 ct darauf.
    assert summe["rueckgespeist_kwh"] == pytest.approx(m6, abs=1e-2)
    assert summe["akku_verschleiss_eur"] == pytest.approx(-0.03 * m6, abs=1e-2)
    # Die drei Netz-Posten ergeben genau „Kosten nur laden - Kosten“ der Plaene, die fuer den Monat galten.
    netz = summe["weniger_gekauft_eur"] + summe["mehr_geladen_eur"] + summe["ins_netz_verkauft_eur"]
    assert netz == pytest.approx(sum(ml.kosten_nur_laden_eur - ml.kosten_eur for ml in messlatten), abs=1e-2)
    # Mehr geladen minus weniger gekauft = Mehrbezug am Netzanschluss gegenueber „nur laden“.
    assert summe["mehr_geladen_kwh"] >= 0.0 and summe["weniger_gekauft_kwh"] >= 0.0
    # Wiederholbar: derselbe Lauf noch einmal legt dieselbe Ablage ab (bis auf Plan-Kennung und Zeitstempel).
    zweit, _, _ = monatslauf_a2(2)
    for k, z in zweit.items():
        assert z[6:] == ablage[k][6:]
