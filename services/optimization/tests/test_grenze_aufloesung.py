"""Der Python-Zwilling der Grenzen am Netzanschluss (UEMS AP-15 IP-3) gegen
``docs/contracts/v2/netzanschluss-grenze-vectors.json`` - dieselbe Datei faehrt
der Java-Zwilling (``GrenzeAufloesungVectorsTest``)."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from voltpilot_optimization.grenze_aufloesung import (
    Fassung,
    aufloesen,
    plausibel,
)

VECTORS = (
    Path(__file__).resolve().parents[3]
    / "docs" / "contracts" / "v2" / "netzanschluss-grenze-vectors.json"
)
DATA = json.loads(VECTORS.read_text(encoding="utf-8"))


def _num(v):
    return None if v is None else float(v)


@pytest.mark.parametrize("fall", DATA["aufloesen"], ids=lambda f: f["name"])
def test_jeder_aufloesungsfall_gilt_im_python_zwilling(fall):
    fassungen = [
        Fassung(
            date.fromisoformat(x["gueltig_ab"]),
            _num(x["einspeisegrenze_kw"]),
            _num(x["bezugsgrenze_kw"]),
        )
        for x in fall["fassungen"]
    ]
    w = aufloesen(
        _num(fall["anlage"]["einspeisung_kw"]),
        _num(fall["anlage"]["bezug_kw"]),
        fall["gebunden"],
        fassungen,
        date.fromisoformat(fall["tag"]),
    )
    e = fall["erwartet"]
    assert w.einspeisung_kw == _num(e["einspeisung_kw"])
    assert w.bezug_kw == _num(e["bezug_kw"])
    assert w.quelle_einspeisung == e["quelle_einspeisung"]
    assert w.quelle_bezug == e["quelle_bezug"]


@pytest.mark.parametrize("fall", DATA["plausibel"], ids=lambda f: f["name"])
def test_jeder_plausibilitaetsfall_gilt_im_python_zwilling(fall):
    assert (
        plausibel(
            _num(fall["einspeisegrenze_kw"]),
            _num(fall["bezugsgrenze_kw"]),
            _num(fall["vereinbart_kw"]),
            _num(fall["anschluss_kva"]),
        )
        == fall["erwartet"]
    )


def test_ohne_fassung_kommt_der_wert_der_anlage_als_dasselbe_objekt_zurueck():
    einspeisung = 70.0
    w = aufloesen(einspeisung, None, True, [], date(2027, 6, 13))
    assert w.einspeisung_kw is einspeisung
    w = aufloesen(
        einspeisung, None, False,
        [Fassung(date(2027, 1, 1), 1.0, 1.0)], date(2027, 6, 13),
    )
    assert w.einspeisung_kw is einspeisung
