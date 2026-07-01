"""Voltpilot-EMS optimization engine.

Responsibility (architecture section 8/11): the deterministic battery-dispatch
MILP (Pyomo + HiGHS) in MPC style - rolling 24h horizon, 15-min slots, cost
minimization over day-ahead prices and load/PV forecasts under SoC, power and
the observed §14a grid-limit constraints. Predict-then-optimize: forecasting is
a separate layer (services/forecast); this package only consumes its output, so
learned forecast models slot in later without touching the optimizer.

Every plan is persisted to the ``schedule`` hypertable (plan-vs-actual / ML
groundwork) and published retained to the device's MQTT schedule topic per the
frozen contract ``docs/contracts/mqtt-schedule.schema.json``.
"""

__version__ = "0.2.0"
