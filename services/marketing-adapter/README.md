# services/marketing-adapter - Direktvermarktung Adapter

**Language:** Python 3.10+
**State:** stateless
**Responsibility (architecture section 8/13):** generische DV-Schnittstelle.

Direct marketing is a core feature, brought in early via a **generic adapter first** (architecture section 4/13). The MVP demonstrates the mechanics with a stub; a certified provider integration (§9 EEG Fernsteuerbarkeit) is a fast-follow.

## Run / build / test

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
python -m voltpilot_marketing_adapter   # runs the stub submit
pytest
```

## Status

MVP stub. `MarketingAdapter` defines the provider-agnostic port; `StubMarketingAdapter` echoes an acceptance. Real provider protocols, auth and certification are future work.
