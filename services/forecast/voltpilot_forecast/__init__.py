"""Voltpilot-EMS forecast service.

Responsibility (architecture section 8/12): Last-/PV-Prognose, Features.
Stateless. v1 uses a simple baseline (persistence/profile) for load and a
physical PV model; no ML in v1 (XGBoost/LightGBM come later). This is a
skeleton with a trivial persistence baseline.
"""

__version__ = "0.1.0"
