"""CLI argument parsing (offline, no ENTSO-E calls)."""

from __future__ import annotations

from voltpilot_market_data.cli import _build_parser


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
