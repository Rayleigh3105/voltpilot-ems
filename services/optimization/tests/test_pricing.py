"""The P1 pricing layer: per-slot asymmetric import/export price series.

Import priced at the site's supply tariff, export at its remuneration
(Marktprämie for Direktvermarktung, feste EEG-Einspeisevergütung for
eigenverbrauch plants) - replicating the pricing the api's EarningsRepository
already uses for reporting. Every missing datum degrades to bare spot (the
pre-P1 symmetric model), never to an invented price. Pure functions, no
solver, no DB - plus one gather_inputs wiring test over the fake-psycopg
pattern from test_freshness.
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

import pytest

from voltpilot_optimization.config import (
    EegRateBand,
    eeg_rate_schedule,
)
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.pricing import (
    DEFAULT_SUPPLY_COMPONENTS,
    SiteTariff,
    SupplyPriceComponents,
    berlin_month,
    export_values,
    feste_verguetung_ct_per_kwh,
    import_prices,
    needs_market_values,
)

T0 = datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)
JULY = date(2026, 7, 1)
SPOT = [100.0, 50.0, -20.0, 0.0]
STARTS = horizon_slot_starts(T0, len(SPOT))


@pytest.fixture(autouse=True)
def _default_supply_components_off(monkeypatch):
    """This module pins the LEGACY (bare-spot) pricing regime for no-data
    sites. Since the OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS flag now defaults ON
    (captain decision 2026-07-29), pin it explicitly OFF here so every legacy
    vector stays byte-identical; the flag-specific tests below opt into ON by
    overriding the env in their own body."""
    monkeypatch.setenv("OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS", "false")


# ---- import side: the supply tariff ------------------------------------------


def test_dynamisch_import_is_spot_plus_aufschlag():
    tariff = SiteTariff(tarif_art="dynamisch", tarif_param_ct_kwh=18.0)
    assert import_prices(tariff, SPOT) == [280.0, 230.0, 160.0, 180.0]


def test_dynamisch_without_aufschlag_is_bare_spot():
    tariff = SiteTariff(tarif_art="dynamisch", tarif_param_ct_kwh=None)
    assert import_prices(tariff, SPOT) == SPOT


def test_fest_import_is_the_flat_retail_price_never_negative_with_spot():
    tariff = SiteTariff(tarif_art="fest", tarif_param_ct_kwh=32.0)
    assert import_prices(tariff, SPOT) == [320.0] * 4


def test_fest_without_price_degrades_to_spot_and_warns(caplog):
    tariff = SiteTariff(tarif_art="fest", tarif_param_ct_kwh=None)
    with caplog.at_level("WARNING"):
        assert import_prices(tariff, SPOT) == SPOT
    assert any("fest_tariff_without_price" in r.message for r in caplog.records)


def test_ohne_and_unknown_tarif_art_import_at_spot():
    assert import_prices(SiteTariff(tarif_art="ohne"), SPOT) == SPOT
    assert import_prices(SiteTariff(tarif_art="whatever"), SPOT) == SPOT


def test_dynamisch_null_aufschlag_now_warns_loudly(caplog):
    # The S1 fix (report vp-nacht-bezug-e7 §1.5): the silent NULL -> +0 was
    # the night-discharge symptom. Value stays legacy bare spot; the log is
    # as loud as fest+NULL.
    tariff = SiteTariff(tarif_art="dynamisch", tarif_param_ct_kwh=None)
    with caplog.at_level("WARNING"):
        assert import_prices(tariff, SPOT) == SPOT
    assert any(
        "dynamisch_tariff_without_aufschlag" in r.message for r in caplog.records
    )


# ---- import side: the structured supply-price sheet (site_supply_price) ------
# Vectors shared with the api's SlotEconomicsTest (the EegRatesTest twin
# discipline): sheet 7.6/2.05/1.59/2.946/1.5 = 15.686 ct netto, USt 19% ->
# spot 100 EUR/MWh composes to (100 + 156.86) * 1.19 = 305.6634 EUR/MWh.


SHEET = SupplyPriceComponents(
    netzentgelt_arbeitspreis_ct=7.6,
    stromsteuer_ct=2.05,
    konzessionsabgabe_ct=1.59,
    umlagen_ct=2.946,
    vertriebsaufschlag_ct=1.5,
    ust_pct=19.0,
)


def test_maintained_sheet_composes_spot_plus_components_times_ust():
    for tarif_art in ("dynamisch", "ohne"):
        tariff = SiteTariff(tarif_art=tarif_art, supply_price=SHEET)
        assert import_prices(tariff, SPOT) == pytest.approx(
            [305.6634, 246.1634, 162.8634, 186.6634]
        )


def test_ust_applies_to_the_spot_share_and_zero_ust_composes_net():
    # The USt factor covers the SPOT share too - NOT spot + taxed components.
    taxed = import_prices(
        SiteTariff(tarif_art="dynamisch", supply_price=SHEET), [100.0]
    )
    assert taxed[0] != pytest.approx(100.0 + 156.86 * 1.19)  # 286.6634
    assert taxed[0] == pytest.approx(305.6634)
    # C&I with Vorsteuer-Abzug: ust_pct 0 composes the net sum.
    net_sheet = SupplyPriceComponents(
        netzentgelt_arbeitspreis_ct=7.6,
        stromsteuer_ct=2.05,
        konzessionsabgabe_ct=1.59,
        umlagen_ct=2.946,
        vertriebsaufschlag_ct=1.5,
        ust_pct=0.0,
    )
    assert import_prices(
        SiteTariff(tarif_art="dynamisch", supply_price=net_sheet), [100.0]
    ) == pytest.approx([256.86])


def test_partial_sheet_sums_only_maintained_components():
    partial = SupplyPriceComponents(
        netzentgelt_arbeitspreis_ct=7.6, umlagen_ct=2.946, ust_pct=0.0
    )
    assert import_prices(
        SiteTariff(tarif_art="ohne", supply_price=partial), [100.0]
    ) == pytest.approx([100.0 + 105.46])


def test_maintained_sheet_replaces_the_sammelaufschlag_for_dynamisch():
    tariff = SiteTariff(
        tarif_art="dynamisch", tarif_param_ct_kwh=18.0, supply_price=SHEET
    )
    # The structured sheet wins; the one-pot Aufschlag is NOT added on top.
    assert import_prices(tariff, [100.0]) == pytest.approx([305.6634])


def test_fest_ignores_a_maintained_sheet_and_warns(caplog):
    # fest is the all-in price: components are never double-counted (§3.1
    # "fest gewinnt, nichts wird doppelt gezählt").
    tariff = SiteTariff(
        tarif_art="fest", tarif_param_ct_kwh=32.0, supply_price=SHEET
    )
    with caplog.at_level("WARNING"):
        assert import_prices(tariff, SPOT) == [320.0] * 4
    assert any(
        "fest_ignores_supply_components" in r.message for r in caplog.records
    )


def test_all_null_sheet_behaves_like_no_row():
    # A degenerate row without a single maintained component composes nothing
    # (it would tax bare spot and nothing else) - the legacy model applies.
    empty = SupplyPriceComponents(ust_pct=19.0)
    assert not empty.has_components()
    assert import_prices(
        SiteTariff(tarif_art="dynamisch", tarif_param_ct_kwh=18.0, supply_price=empty),
        [100.0],
    ) == [280.0]
    assert import_prices(
        SiteTariff(tarif_art="ohne", supply_price=empty), SPOT
    ) == SPOT


# ---- the OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS flag ----------------------------


def test_default_components_flag_prices_the_no_data_cases(monkeypatch, caplog):
    monkeypatch.setenv("OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS", "true")
    # The researched household set: 15.686 ct netto + 19% USt - identical to
    # the SHEET vector above (the report Teil 2 numbers).
    assert DEFAULT_SUPPLY_COMPONENTS.components_ct_kwh() == pytest.approx(15.686)
    expected = pytest.approx([305.6634, 246.1634, 162.8634, 186.6634])
    with caplog.at_level("WARNING"):
        assert import_prices(SiteTariff(tarif_art="ohne"), SPOT) == expected
        assert (
            import_prices(SiteTariff(tarif_art="dynamisch"), SPOT) == expected
        )
    assert any(
        "default_supply_components_applied" in r.message for r in caplog.records
    )


def test_default_components_flag_never_overrides_operator_data(monkeypatch):
    monkeypatch.setenv("OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS", "true")
    # A maintained Sammelaufschlag is operator data - it wins.
    assert import_prices(
        SiteTariff(tarif_art="dynamisch", tarif_param_ct_kwh=18.0), [100.0]
    ) == [280.0]
    # fest is untouched by the flag.
    assert import_prices(
        SiteTariff(tarif_art="fest", tarif_param_ct_kwh=32.0), [100.0]
    ) == [320.0]
    # A maintained sheet also beats the defaults.
    assert import_prices(
        SiteTariff(tarif_art="ohne", supply_price=SHEET), [100.0]
    ) == pytest.approx([305.6634])


def test_default_components_flag_off_is_the_legacy_model(monkeypatch):
    # Explicit opt-out (the Notbremse) restores bare-spot legacy pricing.
    for value in ("false", "0", "off"):
        monkeypatch.setenv("OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS", value)
        assert import_prices(SiteTariff(tarif_art="ohne"), SPOT) == SPOT
        assert import_prices(SiteTariff(tarif_art="dynamisch"), SPOT) == SPOT


def test_default_components_flag_defaults_on_when_env_absent(monkeypatch):
    # Captain decision 2026-07-29: a missing env now defaults ON, so a
    # no-data site rechnet mit den Default-Komponenten statt nacktem Spot.
    monkeypatch.delenv("OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS", raising=False)
    expected = pytest.approx([305.6634, 246.1634, 162.8634, 186.6634])
    assert import_prices(SiteTariff(tarif_art="ohne"), SPOT) == expected
    assert import_prices(SiteTariff(tarif_art="dynamisch"), SPOT) == expected


def test_default_components_flag_garbage_raises(monkeypatch):
    from voltpilot_optimization.config import default_supply_components_enabled

    monkeypatch.setenv("OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS", "maybe")
    with pytest.raises(ValueError, match="OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS"):
        default_supply_components_enabled()


# ---- export side: Direktvermarktung (spot + Marktprämie) ---------------------


def _dv_tariff(aw: float | None = 13.0) -> SiteTariff:
    return SiteTariff(
        plant_kind="direktvermarktung", anzulegender_wert_ct_kwh=aw
    )


def test_dv_premium_added_in_non_negative_slots_only():
    # AW 13 ct - MW 5 ct = 8 ct premium = 80 EUR/MWh; suspended when spot < 0
    # (the simplified §51 rule), INCLUDING the spot-zero slot (>= 0 earns).
    values = export_values(
        _dv_tariff(), False, SPOT, STARTS, {JULY: 5.0}
    )
    assert values == [180.0, 130.0, -20.0, 80.0]


def test_dv_premium_floors_at_zero_when_market_value_exceeds_aw():
    values = export_values(
        _dv_tariff(aw=4.0), False, SPOT, STARTS, {JULY: 5.0}
    )
    assert values == SPOT


def test_dv_without_anzulegender_wert_is_bare_spot():
    assert export_values(_dv_tariff(aw=None), False, SPOT, STARTS, {JULY: 5.0}) == SPOT


def test_dv_missing_market_value_month_earns_no_premium_and_warns(caplog):
    with caplog.at_level("WARNING"):
        values = export_values(_dv_tariff(), False, SPOT, STARTS, {})
    assert values == SPOT
    assert any("market_value_missing" in r.message for r in caplog.records)


def test_dv_in_merchant_mode_exports_at_bare_spot_and_flags_the_config(caplog):
    # EEG remuneration never enters the objective when grid charging is
    # allowed (Ausschliesslichkeitsprinzip - the premium-farming guard).
    with caplog.at_level("WARNING"):
        values = export_values(_dv_tariff(), True, SPOT, STARTS, {JULY: 5.0})
    assert values == SPOT
    assert any(
        "eeg_remuneration_ignored_in_merchant_mode" in r.message
        for r in caplog.records
    )


def test_market_value_month_is_the_berlin_calendar_month():
    # 2026-06-30 22:30 UTC is already 2026-07-01 00:30 in Berlin - the slot
    # belongs to JULY's Monatsmarktwert, not June's.
    at = datetime(2026, 6, 30, 22, 30, tzinfo=timezone.utc)
    assert berlin_month(at) == JULY
    values = export_values(
        _dv_tariff(), False, [100.0], [at], {JULY: 5.0, date(2026, 6, 1): 999.0}
    )
    assert values == [180.0]


def test_needs_market_values_only_for_eeg_mode_dv_with_aw():
    assert needs_market_values(_dv_tariff(), False)
    assert not needs_market_values(_dv_tariff(), True)  # merchant: no premium
    assert not needs_market_values(_dv_tariff(aw=None), False)
    assert not needs_market_values(SiteTariff(), False)  # eigenverbrauch


# ---- export side: feste EEG-Einspeisevergütung -------------------------------


def _ev_tariff(
    commissioned: date | None, kwp: float | None = 8.0
) -> SiteTariff:
    return SiteTariff(
        plant_kind="eigenverbrauch",
        commissioned_on=commissioned,
        pv_capacity_kwp=kwp,
    )


def test_feste_verguetung_is_flat_and_survives_negative_spot():
    # EEG-2023 plant (<= 10 kWp Teileinspeisung: 8.2 ct = 82 EUR/MWh): the rate
    # is the export value in EVERY slot - a fixed-remuneration plant keeps
    # earning at negative spot (critique F6: curtailing it there burns money).
    values = export_values(
        _ev_tariff(date(2023, 6, 15)), False, SPOT, STARTS, {}
    )
    assert values == [82.0] * 4


def test_post_solarspitzengesetz_plant_earns_nothing_at_negative_spot():
    # Commissioned after 2025-02-25 (§51a EEG): rate in non-negative slots,
    # ZERO (never negative - the plant is not spot-settled) when spot < 0.
    values = export_values(
        _ev_tariff(date(2025, 6, 1)), False, SPOT, STARTS, {}
    )
    assert values == [79.4, 79.4, 0.0, 79.4]  # the 2025-02 band: 7.94 ct


def test_no_commissioning_date_degrades_to_spot():
    assert export_values(_ev_tariff(None), False, SPOT, STARTS, {}) == SPOT


def test_expired_remuneration_degrades_to_spot():
    # 20 years + commissioning year: a 2004 plant is out of remuneration in
    # 2026 (ended Dec 31, 2024).
    values = export_values(
        _ev_tariff(date(2004, 6, 1)), False, SPOT, STARTS, {}
    )
    assert values == SPOT


def test_eigenverbrauch_in_merchant_mode_exports_at_bare_spot_and_flags(caplog):
    # Same Ausschliesslichkeitsprinzip guard as the DV premium - and since B5
    # the same inconsistency WARNING: an EEG-remunerated (commissioned)
    # eigenverbrauch plant in merchant mode was previously silent.
    with caplog.at_level("WARNING"):
        values = export_values(
            _ev_tariff(date(2023, 6, 15)), True, SPOT, STARTS, {}
        )
    assert values == SPOT  # behavior unchanged: bare spot
    assert any(
        "eeg_remuneration_ignored_in_merchant_mode" in r.message
        for r in caplog.records
    )


def test_eigenverbrauch_merchant_without_commissioning_date_stays_silent(caplog):
    # No commissioning date = no feste Vergütung to ignore = no inconsistency.
    with caplog.at_level("WARNING"):
        values = export_values(_ev_tariff(None), True, SPOT, STARTS, {})
    assert values == SPOT
    assert not any(
        "eeg_remuneration_ignored_in_merchant_mode" in r.message
        for r in caplog.records
    )


def test_expiry_is_evaluated_per_slot_across_the_horizon_boundary():
    # B10: a 2005 plant's remuneration ends Dec 31, 2025 (Berlin). A horizon
    # crossing that midnight (= 2025-12-31 23:00 UTC) earns the rate in the
    # 2025 slots and bare spot in the 2026 slots - not one verdict for all
    # slots from the horizon start.
    starts = [
        datetime(2025, 12, 31, 22, 30, tzinfo=timezone.utc),  # Berlin 23:30
        datetime(2025, 12, 31, 22, 45, tzinfo=timezone.utc),  # Berlin 23:45
        datetime(2025, 12, 31, 23, 0, tzinfo=timezone.utc),   # Berlin 00:00
        datetime(2025, 12, 31, 23, 15, tzinfo=timezone.utc),  # Berlin 00:15
    ]
    spot = [100.0, -20.0, 100.0, -20.0]
    tariff = _ev_tariff(date(2005, 6, 15))
    rate = feste_verguetung_ct_per_kwh(date(2005, 6, 15), 8.0) * 10.0
    values = export_values(tariff, False, spot, starts, {})
    # Pre-2025 plant: no §51a suspension, so the -20 slot still earns the rate
    # while remunerated; both post-expiry slots degrade to bare spot.
    assert values == [rate, rate, 100.0, -20.0]


def test_blended_rate_weights_the_tranches():
    # 25 kWp EEG-2023 plant: first 10 kWp at 8.2, remaining 15 at 7.1.
    rate = feste_verguetung_ct_per_kwh(date(2023, 6, 15), 25.0)
    assert rate == pytest.approx((10 * 8.2 + 15 * 7.1) / 25)
    # 60 kWp: 10 at 8.2 + 30 at 7.1 + 20 at 5.8.
    rate = feste_verguetung_ct_per_kwh(date(2023, 6, 15), 60.0)
    assert rate == pytest.approx((10 * 8.2 + 30 * 7.1 + 20 * 5.8) / 60)


def test_unknown_capacity_assumes_the_smallest_band():
    assert feste_verguetung_ct_per_kwh(date(2023, 6, 15), None) == 8.2


def test_degression_steps_and_pre_schedule_dates():
    # The 2024-08 degression step applies to a 2024-09 commissioning; a
    # pre-2012 plant uses the first band (documented approximation).
    assert feste_verguetung_ct_per_kwh(date(2024, 9, 1), 5.0) == 8.03
    assert feste_verguetung_ct_per_kwh(date(2010, 1, 1), 5.0) == 24.4


def test_eeg_schedule_env_override_and_garbage_rejection(monkeypatch):
    monkeypatch.setenv(
        "OPTIMIZER_EEG_RATES_JSON",
        '[{"from": "2000-01-01", "le10": 50.0, "le40": 40.0, "le100": 30.0}]',
    )
    schedule = eeg_rate_schedule()
    assert schedule == (EegRateBand(date(2000, 1, 1), 50.0, 40.0, 30.0),)
    assert feste_verguetung_ct_per_kwh(date(2023, 6, 15), 5.0, schedule) == 50.0

    monkeypatch.setenv("OPTIMIZER_EEG_RATES_JSON", "not json")
    with pytest.raises(ValueError, match="OPTIMIZER_EEG_RATES_JSON"):
        eeg_rate_schedule()
    monkeypatch.setenv("OPTIMIZER_EEG_RATES_JSON", "[]")
    with pytest.raises(ValueError, match="at least one"):
        eeg_rate_schedule()


# ---- baseline economics under asymmetric pricing (pure domain) ---------------


def test_baseline_cost_uses_import_price_for_imports_and_export_value_for_exports():
    n = 2
    inp = OptimizationInput(
        tenant_id=UUID(int=1),
        site_id=UUID(int=2),
        device_id=None,
        battery=BatteryParams(capacity_kwh=10, max_charge_kw=5, max_discharge_kw=5),
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=[100.0, 100.0],
        load_kw=[4.0, 1.0],
        pv_kw=[2.0, 4.0],  # slot 0: +2 kW residual import; slot 1: 3 kW export
        initial_soc_kwh=5.0,
        netzladen_erlaubt=False,
        import_price_eur_mwh=[300.0, 300.0],
        export_value_eur_mwh=[80.0, 80.0],
    )
    assert inp.baseline_cost_eur(0) == pytest.approx(300.0 * 2.0 * 0.25 / 1000.0)
    assert inp.baseline_cost_eur(1) == pytest.approx(-80.0 * 3.0 * 0.25 / 1000.0)


def test_series_length_validation():
    with pytest.raises(ValueError, match="import_price_eur_mwh"):
        OptimizationInput(
            tenant_id=UUID(int=1),
            site_id=UUID(int=2),
            device_id=None,
            battery=BatteryParams(
                capacity_kwh=10, max_charge_kw=5, max_discharge_kw=5
            ),
            slot_starts=horizon_slot_starts(T0, 2),
            prices_eur_mwh=[100.0, 100.0],
            load_kw=[1.0, 1.0],
            pv_kw=[0.0, 0.0],
            initial_soc_kwh=5.0,
            netzladen_erlaubt=True,
            import_price_eur_mwh=[100.0],
        )


# ---- gather_inputs wiring (fake psycopg, the test_freshness pattern) ---------

NOW = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)
SITE = UUID("00000000-0000-0000-0000-000000000002")
TENANT = UUID("00000000-0000-0000-0000-000000000001")
SLOTS = 16


class _FakeCursor:
    def __init__(self) -> None:
        self._rows: list = []
        self.slot_starts = horizon_slot_starts(NOW, SLOTS)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        if "FROM day_ahead_prices" in sql:
            self._rows = [(ts, "PT15M", 100.0) for ts in self.slot_starts]
        elif "FROM monthly_market_value" in sql:
            self._rows = [(JULY, 5.0)]
        elif "FROM forecast" in sql:
            self._rows = [(ts, 1.0) for ts in self.slot_starts]
        elif "FROM telemetry" in sql and "LIMIT 1" in sql:
            self._rows = []
        elif "FROM telemetry" in sql:
            self._rows = []
        else:  # pragma: no cover
            raise AssertionError(f"unhandled query: {sql}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


@pytest.fixture()
def fake_psycopg(monkeypatch):
    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _FakeCursor()

    monkeypatch.setitem(
        sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn())
    )
    monkeypatch.delenv("VOLTPILOT_ACTIVE_LOAD_MODEL", raising=False)
    monkeypatch.delenv("VOLTPILOT_ACTIVE_PV_MODEL", raising=False)


def test_gather_inputs_builds_the_asymmetric_series_for_a_dv_site(fake_psycopg):
    from voltpilot_optimization.inputs import BatterySite, gather_inputs

    site = BatterySite(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=None,
        bidding_zone="DE-LU",
        battery=BatteryParams(capacity_kwh=10, max_charge_kw=5, max_discharge_kw=5),
        netzladen_erlaubt=False,
        tariff=SiteTariff(
            plant_kind="direktvermarktung",
            tarif_art="dynamisch",
            tarif_param_ct_kwh=18.0,
            anzulegender_wert_ct_kwh=13.0,
        ),
    )
    inp = gather_inputs("postgresql://fake", site, NOW, SLOTS)
    # Spot 100 flat; import = spot + 180 (Aufschlag); export = spot + 80
    # (premium from the stored July Monatsmarktwert 5.0 vs AW 13.0).
    assert inp.prices_eur_mwh == [100.0] * SLOTS
    assert inp.import_price_eur_mwh == [280.0] * SLOTS
    assert inp.export_value_eur_mwh == [180.0] * SLOTS


def test_gather_inputs_default_tariff_stays_symmetric_spot(fake_psycopg):
    from voltpilot_optimization.inputs import BatterySite, gather_inputs

    site = BatterySite(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=None,
        bidding_zone="DE-LU",
        battery=BatteryParams(capacity_kwh=10, max_charge_kw=5, max_discharge_kw=5),
        netzladen_erlaubt=True,
    )
    inp = gather_inputs("postgresql://fake", site, NOW, SLOTS)
    assert inp.import_prices == [100.0] * SLOTS
    assert inp.export_values == [100.0] * SLOTS
