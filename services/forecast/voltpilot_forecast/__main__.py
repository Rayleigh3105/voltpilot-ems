"""Trivial entrypoint: print a baseline forecast."""

from __future__ import annotations

from voltpilot_forecast.baseline import persistence_forecast


def main() -> None:
    forecast = persistence_forecast([10.0, 12.0, 11.5], horizon=4)
    print(f"voltpilot-forecast baseline (persistence): {forecast}")


if __name__ == "__main__":
    main()
