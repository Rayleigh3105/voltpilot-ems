"""MiSpeL MP-14: der Foerderweg reist im Plan zur Box ("Foerderweg statt
Netzlade-Bit").

Die Cloud setzt das OPTIONALE Plan-Feld ``foerderweg`` aus dem am Plantag
wirksamen Foerderweg der Einspeisestelle (Fassung aus ``site_foerderweg`` oder
der Bestand, ``docs/contracts/v2/mispel-foerderweg.md`` § 1-2). Die Box loest
die EEG-Klemme nur bei Abgrenzungs-, Pauschaloption und ungefoerderter
Direktvermarktung und nur mit ``grid_charge_allowed=true``; fehlt das Feld,
laedt sie nur mit Sonnenstrom (Go: ``internal/plan/foerderweg_test.go``,
``internal/agent/foerderweg_test.go``).
"""

from __future__ import annotations

from dataclasses import replace
from uuid import uuid4

import pytest

from voltpilot_optimization.pricing import FOERDERWEGE, foerderweg_aus_bestand
from voltpilot_optimization.publisher import build_schedule_payload
from voltpilot_optimization.solver import optimize

from test_contract import load_validator, make_plan
from test_pricing import NOW, SITE, SLOTS, TENANT, fake_psycopg  # noqa: F401
from test_solver import T0, make_input, needs_highs


def test_ohne_foerderweg_bleibt_die_nutzlast_byte_gleich():
    payload = build_schedule_payload(make_plan())
    assert "foerderweg" not in payload


@pytest.mark.parametrize("weg", sorted(FOERDERWEGE))
def test_jeder_foerderweg_reist_im_plan_und_erfuellt_den_vertrag(weg):
    payload = build_schedule_payload(replace(make_plan(), foerderweg=weg))
    assert payload["foerderweg"] == weg
    errors = list(load_validator().iter_errors(payload))
    assert errors == [], [e.message for e in errors]


def test_der_vertrag_kennt_genau_die_fuenf_werte():
    schema = load_validator().schema
    assert set(schema["properties"]["foerderweg"]["enum"]) == set(FOERDERWEGE)
    payload = build_schedule_payload(replace(make_plan(), foerderweg="marktpraemie_neu"))
    assert list(load_validator().iter_errors(payload)), "ein unbekannter Wert verletzt den Vertrag"


@needs_highs
def test_der_solver_reicht_den_foerderweg_des_eingangs_in_den_plan():
    inp = replace(
        make_input([20.0] * 8, load=1.0, pv=0.0, netzladen_erlaubt=True),
        foerderweg="marktpraemie_abgrenzung",
    )
    plan = optimize(inp, uuid4(), T0)
    assert plan.foerderweg == "marktpraemie_abgrenzung"
    assert plan.grid_charge_allowed is True
    assert build_schedule_payload(plan)["foerderweg"] == "marktpraemie_abgrenzung"


@pytest.mark.parametrize(
    ("netzladen", "art"),
    [(True, "direktvermarktung"), (False, "direktvermarktung"), (False, "eigenverbrauch")],
)
def test_gather_inputs_setzt_den_foerderweg_des_plantags(fake_psycopg, netzladen, art):  # noqa: F811
    from voltpilot_optimization.domain import BatteryParams
    from voltpilot_optimization.inputs import BatterySite, gather_inputs
    from voltpilot_optimization.pricing import SiteTariff

    site = BatterySite(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=None,
        bidding_zone="DE-LU",
        battery=BatteryParams(capacity_kwh=10, max_charge_kw=5, max_discharge_kw=5),
        netzladen_erlaubt=netzladen,
        tariff=SiteTariff(plant_kind=art),
    )
    inp = gather_inputs("postgresql://fake", site, NOW, SLOTS)
    # Ohne Fassung gilt der Bestand (§ 2): dieselbe Regel wie im Optimierer.
    assert inp.foerderweg == foerderweg_aus_bestand(netzladen, art) == site.foerderweg
