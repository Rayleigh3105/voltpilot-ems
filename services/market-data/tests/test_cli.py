"""CLI argument parsing (offline, no ENTSO-E calls)."""

from __future__ import annotations

from voltpilot_market_data.cli import _build_parser, _build_source
from voltpilot_market_data.energy_charts import EnergyChartsDayAheadPriceSource
from voltpilot_market_data.entsoe import EntsoeDayAheadPriceSource


def test_default_zone_from_market_data_zone_env(monkeypatch):
    monkeypatch.setenv("MARKET_DATA_ZONE", "AT")
    args = _build_parser().parse_args(["fetch"])
    assert args.zone == "AT"


def test_explicit_zone_overrides_env(monkeypatch):
    monkeypatch.setenv("MARKET_DATA_ZONE", "AT")
    args = _build_parser().parse_args(["fetch", "--zone", "CH"])
    assert args.zone == "CH"


def test_default_zone_falls_back_to_de_lu(monkeypatch):
    monkeypatch.delenv("MARKET_DATA_ZONE", raising=False)
    args = _build_parser().parse_args(["fetch"])
    assert args.zone == "DE-LU"


def test_default_source_falls_back_to_energy_charts(monkeypatch):
    monkeypatch.delenv("MARKET_DATA_SOURCE", raising=False)
    args = _build_parser().parse_args(["serve"])
    assert args.source == "energy-charts"


def test_source_from_market_data_source_env(monkeypatch):
    # The prod compose selects the source purely via MARKET_DATA_SOURCE (the
    # captain's ENTSO-E switch) - no --source flag on the container command.
    monkeypatch.setenv("MARKET_DATA_SOURCE", "entsoe")
    args = _build_parser().parse_args(["serve"])
    assert args.source == "entsoe"


def test_build_source_wires_the_entsoe_adapter():
    env = {"ENTSOE_SECURITY_TOKEN": "dummy-token"}
    assert isinstance(_build_source(env, "entsoe").delegate, EntsoeDayAheadPriceSource)
    assert isinstance(
        _build_source(env, "energy-charts").delegate, EnergyChartsDayAheadPriceSource
    )
