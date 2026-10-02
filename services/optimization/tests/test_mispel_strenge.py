"""MiSpeL MP-45: strenge Ausschliesslichkeit als Betreiber-Schalter je Anlage.

Kasten W1 = D (Captain-Entscheid 02.10.2026): bis zur Rechtsantwort laeuft FK3
weiter, die strenge Lesart der BNetzA liegt schaltbar bereit - „kein Verbrauch
im Stromspeicher ..., waehrend es gleichzeitig einen Netzbezug gibt“
(Festlegung MiSpeL, Anlage 1 S. 11; gleichzeitig = dieselbe Viertelstunde,
Anlage 1 S. 7 Abschn. 1). Die Groesse ist dieselbe, die der Pruefer MP-2
misst: (1)¼ = MIN [ Z1NB¼ ; Z2V¼ ] (Anlage 1 S. 33).

Pruefnachweis laut Bauplan: mit Schalter kein Laden in einer Viertelstunde mit
Netzbezug; ohne Schalter byte-gleiche Plaene (FK3).
"""

from __future__ import annotations

import json
from dataclasses import replace
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization.config import (
    MISPEL_STRENGE_SITES_ENV,
    mispel_strenge_site_ids,
)
from voltpilot_optimization.domain import (
    STRENGE_TOLERANZ_KWH_JE_VIERTELSTUNDE,
    VIERTELSTUNDE_H,
)
from voltpilot_optimization.publisher import build_schedule_payload
from voltpilot_optimization.solver import build_model, optimize

from test_contract import load_validator
from test_solver import T0, make_input, needs_highs

# Ein wolkiger Tag mit einem sonnigen Mittag: billige Nacht, teurer Abend.
# Wolkig (pv 3 < Last 4): FK3 laedt die PV in den Speicher, das Haus bezieht
# parallel - genau das Bild, das die strenge Lesart verbietet. Sonnig (pv 8 >
# Last 4): echter Ueberschuss, den auch die strenge Lesart laden laesst.
N = 96
PRICES = [20.0] * 40 + [60.0] * 24 + [250.0] * 32
PV = [0.0] * 40 + [3.0] * 12 + [8.0] * 6 + [3.0] * 6 + [0.0] * 32
LOAD = 4.0


def _eeg(strenge: bool | None = None, toleranz: float | None = None):
    inp = make_input(PRICES, load=LOAD, pv=PV, soc0_kwh=1.0, netzladen_erlaubt=False)
    if strenge is not None:
        inp = replace(inp, strenge_ausschliesslichkeit=strenge)
    if toleranz is not None:
        inp = replace(inp, strenge_toleranz_kwh=toleranz)
    return inp


def _netzstrom_im_speicher_kwh(slot) -> float:
    """(1)¼ = MIN [ Z1NB¼ ; Z2V¼ ] eines geplanten 15-min-Slots in kWh."""
    bezug = max(slot.grid_kw, 0.0) * VIERTELSTUNDE_H
    laden = max(slot.battery_kw, 0.0) * VIERTELSTUNDE_H
    return min(bezug, laden)


def _payload_bytes(inp) -> bytes:
    # Feste Kennungen: make_input wuerfelt sie je Aufruf.
    inp = replace(inp, tenant_id=UUID(int=1), site_id=UUID(int=2), device_id=UUID(int=3))
    plan = optimize(inp, plan_id=UUID(int=45), generated_at=T0)
    return json.dumps(build_schedule_payload(plan), sort_keys=True).encode()


# --- Schalter --------------------------------------------------------------


def test_schalter_vorgabe_ist_keine_anlage():
    assert mispel_strenge_site_ids({}) == frozenset()
    assert mispel_strenge_site_ids({MISPEL_STRENGE_SITES_ENV: "  "}) == frozenset()


def test_schalter_liest_site_uuids():
    a, b = uuid4(), uuid4()
    env = {MISPEL_STRENGE_SITES_ENV: f" {a}, ,{b} "}
    assert mispel_strenge_site_ids(env) == frozenset({a, b})


def test_schalter_tippfehler_bricht_laut_ab():
    with pytest.raises(ValueError, match=MISPEL_STRENGE_SITES_ENV):
        mispel_strenge_site_ids({MISPEL_STRENGE_SITES_ENV: "keine-uuid"})


def test_toleranz_vorgabe_ist_null_wie_in_der_festlegung():
    # Die Festlegung kennt keine Toleranz je Viertelstunde (Anlage 1 S. 11).
    assert STRENGE_TOLERANZ_KWH_JE_VIERTELSTUNDE == 0.0
    assert _eeg().strenge_toleranz_kwh == 0.0
    assert _eeg().strenge_ausschliesslichkeit is False


def test_schalter_wirkt_nur_im_eeg_modus():
    assert _eeg(strenge=True).strenge_aktiv
    assert not _eeg(strenge=False).strenge_aktiv
    haendler = make_input(PRICES, load=LOAD, pv=PV, netzladen_erlaubt=True)
    assert not replace(haendler, strenge_ausschliesslichkeit=True).strenge_aktiv


def test_ungueltige_toleranz_und_kurze_slots_werden_verworfen():
    with pytest.raises(ValueError, match="strenge_toleranz_kwh"):
        _eeg(toleranz=-0.01)
    with pytest.raises(ValueError, match="strenge_toleranz_kwh"):
        _eeg(toleranz=float("nan"))
    # Ein 5-min-Slot koennte in derselben Viertelstunde erst laden und dann
    # beziehen - die Bedingung je Slot deckte die je Viertelstunde nicht.
    with pytest.raises(ValueError, match="quarter hours"):
        replace(_eeg(strenge=True), slot_minutes=5)


# --- Modell ------------------------------------------------------------------


def test_ohne_schalter_kein_term_in_beiden_bauarten():
    for enforce in (True, False):
        fk3 = build_model(_eeg(), enforce_grid_limit=enforce)
        aus = build_model(_eeg(strenge=False), enforce_grid_limit=enforce)
        assert not hasattr(fk3, "strenge_ausschliesslichkeit")
        assert not hasattr(aus, "strenge_ausschliesslichkeit")
        assert aus.nconstraints() == fk3.nconstraints()
        assert aus.nvariables() == fk3.nvariables()


def test_mit_schalter_eine_bedingung_je_slot_auch_im_14a_rueckfall():
    for enforce in (True, False):
        fk3 = build_model(_eeg(), enforce_grid_limit=enforce)
        streng = build_model(_eeg(strenge=True), enforce_grid_limit=enforce)
        assert hasattr(streng, "solar_only_charge"), "FK3 bindet weiter"
        assert hasattr(streng, "strenge_ausschliesslichkeit")
        assert streng.nconstraints() == fk3.nconstraints() + N
        # Keine neue Ganzzahl-Variable: die Bedingung nutzt is_charging.
        assert streng.nvariables() == fk3.nvariables()


def test_haendler_anlage_ignoriert_den_schalter():
    haendler = make_input(PRICES, load=LOAD, pv=PV, netzladen_erlaubt=True)
    model = build_model(replace(haendler, strenge_ausschliesslichkeit=True))
    assert not hasattr(model, "strenge_ausschliesslichkeit")


# --- Solver ------------------------------------------------------------------


@needs_highs
def test_fk3_laedt_bei_netzbezug_die_strenge_lesart_nicht():
    fk3 = optimize(_eeg(), plan_id=uuid4(), generated_at=T0)
    # Gegenprobe: ohne Schalter laedt FK3 die wolkige PV, waehrend das Haus
    # bezieht - sonst bewiese der Test unten nichts.
    assert any(_netzstrom_im_speicher_kwh(s) > 0.1 for s in fk3.slots)

    streng = optimize(_eeg(strenge=True), plan_id=uuid4(), generated_at=T0)
    for i, s in enumerate(streng.slots):
        if s.battery_kw > 1e-6:
            assert s.grid_kw <= 1e-6, f"Slot {i}: Laden bei Netzbezug {s.grid_kw} kW"
        assert _netzstrom_im_speicher_kwh(s) <= 1e-6
    # Der sonnige Mittag laedt weiter - aus echtem Ueberschuss.
    sonnig = streng.slots[52:58]
    assert sum(max(s.battery_kw, 0.0) for s in sonnig) > 1.0
    assert all(s.battery_kw <= PV[52 + k] - LOAD + 1e-6 for k, s in enumerate(sonnig))
    # FK3 bindet weiter: nie mehr laden als die erzeugte PV.
    assert all(s.battery_kw <= PV[i] + 1e-6 for i, s in enumerate(streng.slots))


@needs_highs
def test_toleranz_je_viertelstunde_begrenzt_den_netzbezug_beim_laden():
    toleranz = 0.25  # kWh je Viertelstunde = 1 kW Bezug
    streng = optimize(
        _eeg(strenge=True, toleranz=toleranz), plan_id=uuid4(), generated_at=T0
    )
    for s in streng.slots:
        assert _netzstrom_im_speicher_kwh(s) <= toleranz + 1e-6
        if s.battery_kw > 1e-6:
            assert s.grid_kw <= toleranz / VIERTELSTUNDE_H + 1e-6


# --- Plan und Vertrag --------------------------------------------------------


@needs_highs
def test_ohne_schalter_byte_gleicher_plan():
    vorher = _payload_bytes(_eeg())
    assert _payload_bytes(_eeg(strenge=False)) == vorher
    assert b"strict_exclusivity" not in vorher
    haendler = make_input(PRICES, load=LOAD, pv=PV, netzladen_erlaubt=True)
    assert _payload_bytes(replace(haendler, strenge_ausschliesslichkeit=True)) == (
        _payload_bytes(haendler)
    )


@needs_highs
def test_mit_schalter_traegt_der_plan_regel_und_toleranz_zur_box():
    plan = optimize(_eeg(strenge=True, toleranz=0.01), plan_id=uuid4(), generated_at=T0)
    payload = build_schedule_payload(plan)
    assert payload["grid_charge_allowed"] is False
    assert payload["strict_exclusivity"] is True
    assert payload["strict_exclusivity_tolerance_kwh"] == 0.01
    errors = list(load_validator().iter_errors(payload))
    assert not errors, [e.message for e in errors]
