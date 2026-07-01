"""Trivial entrypoint: submit a demo schedule through the stub adapter."""

from __future__ import annotations

from voltpilot_marketing_adapter.adapter import (
    MarketingSchedule,
    StubMarketingAdapter,
)


def main() -> None:
    adapter = StubMarketingAdapter()
    result = adapter.submit(
        MarketingSchedule(site_id="00000000-0000-0000-0000-000000000002",
                          slots_kw=[0.0, 5.0, -3.0])
    )
    print(f"voltpilot-marketing-adapter stub submit: {result}")


if __name__ == "__main__":
    main()
