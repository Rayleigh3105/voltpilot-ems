# services/forecast - Forecast Service

**Language:** Python 3.10+
**State:** stateless
**Responsibility (architecture section 8/12):** Last-/PV-Prognose, Features.

Separates prediction from decision (a leitprinzip). v1 is deliberately ML-free: a persistence/profile baseline for load and a physical PV model. ML (XGBoost/LightGBM, quantile objectives) is a later stage.

## Run / build / test

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
python -m voltpilot_forecast     # prints a baseline forecast
pytest
```

## Status

MVP skeleton: only the persistence baseline is implemented. The physical PV model, weather integration and ML successors are future work.
