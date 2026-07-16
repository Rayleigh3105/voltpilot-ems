"""Ersparnis-Simulation (Inkrement 1): the internal simulation service.

Computes the 3-way what-if over a full historical reference year - (a) ohne
Speicher / (b) Standard-Speicher (greedy self-consumption) / (c) VoltPilot
(the UNCHANGED production MILP, chained day by day) - plus a battery-size
sweep and the Netzladen variant. Design + measured evidence: the
``vp-sim-design-t6`` report; the load-bearing method facts are:

- **365 chained days, 48-h window / 24-h commit (MANDATORY).** Naive 24h/24h
  chaining reproduces the horizon-end artefact 365 times over (measured
  -148 EUR/a vs. greedy); a 48-h lookahead with only the first 24 h committed
  mirrors the production MPC's sight and makes the MILP provably >= greedy
  (residual noise +-0.6 EUR/a).
- **No day sampling, ever.** Midnight boundaries cut the overnight carry;
  every sampling variant measured -8..-55 % biased. Month-chunk parallelism
  with 2 warmup days reproduces the exact sequential result (-0.03 %) faster
  than any sampling could.
- The greedy standard battery (scenario b) shares the physics of (c) -
  capacity, power caps, sqrt-split efficiency, SoC band - and none of the
  intelligence (no prices, no lookahead, no curtailment, no wear in
  dispatch); wear is charged POST-HOC at the same preset rate so "netto" is
  one currency across all three columns.

The service is an async job over HTTP (stdlib, internal compose network
only); ALL auth/tenancy lives in the Java api, which resolves site master
data into explicit job inputs. See ``server.py`` for the routes.
"""
