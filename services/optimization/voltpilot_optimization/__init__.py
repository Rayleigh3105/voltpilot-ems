"""Voltpilot-EMS optimization engine.

Responsibility (architecture section 8/11): MILP/MPC schedule (HiGHS). Stateless
job. This is an MVP skeleton - it proves the Pyomo + HiGHS toolchain is wired
(see :mod:`voltpilot_optimization.solver`). The real rolling-horizon battery
dispatch MILP under the observed §14a limit is future work.
"""

__version__ = "0.1.0"
