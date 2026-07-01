from voltpilot_marketing_adapter.adapter import (
    MarketingSchedule,
    StubMarketingAdapter,
)


def test_stub_accepts_and_references_schedule():
    adapter = StubMarketingAdapter()
    result = adapter.submit(MarketingSchedule(site_id="site-1", slots_kw=[1.0, 2.0]))
    assert result.accepted is True
    assert result.reference == "stub-site-1-2"
