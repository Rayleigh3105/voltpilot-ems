"""The battery-dispatch MILP (architecture section 11).

Deterministic market-revenue maximization over a rolling 24-48h horizon in 15-min
slots - the *optimize* half of predict-then-optimize. Inputs (prices, load/PV
forecasts, SoC, battery params) arrive as a plain :class:`OptimizationInput`;
the solver never knows where a forecast came from, so the forecasting layer can
later be replaced by learned models without touching this module.

Formulation (per slot t, dt = 0.25 h):

    minimize   sum_t  (import_price_t * import_t - export_value_t * export_t) * dt / 1000
                      + c_wear/2 * (charge_t + discharge_t) * dt   (battery wear, see below)
                      + epsilon * curtail_t                        (tie-break, see below)
                      + epsilon_early * (t/T) * charge_t           (charge-timing tie-break, see below)
               - V_end * (soc_T - soc_0)                           (terminal energy value, see below)
    where      import_t - export_t = load_t - pv_t + curtail_t + charge_t - discharge_t
    s.t.       0 <= charge_t    <= max_charge    * is_charging_t
               0 <= discharge_t <= max_discharge * (1 - is_charging_t)
               0 <= import_t    <= M_imp_t * is_importing_t        (never import AND export)
               0 <= export_t    <= M_exp_t * (1 - is_importing_t)
               0 <= curtail_t   <= pv_t                            (only ever a REDUCTION)
               soc_{t+1} = soc_t + (eta * charge_t - discharge_t / eta) * dt
               soc_floor <= soc_t <= soc_max                       (soc_floor: 5% technical
                                                                    floor, raised by the P11
                                                                    backup reserve, see below)
               import_t <= grid_limit, export_t <= grid_limit      (observed §14a, hard cap)
               export_t <= max_feed_in_kw                          (static connection-point
                                                                    feed-in cap, EXPORT ONLY)
    and, ONLY when netzladen_erlaubt is False (EEG mode, see below):
               charge_t <= max(pv_t, 0) - curtail_t                (charge from produced PV only,
                                                                    PV-bus Bilanzierung - FK3)
    and, ONLY when strenge_aktiv (MiSpeL MP-45 operator switch, EEG mode, see below):
               import_t <= tol / 0.25 h + M_imp_t * (1 - is_charging_t)  (no charging in a
                                                                    quarter hour with grid
                                                                    import - strict reading)
    and, ONLY when leistungspreis_eur_kw is set (peak shaving, PS-1, see below):
               peak >= grid_import_t,  peak >= peak_so_far         (epigraph over the billing
               peak_below >= grid_import_t                          period's import peak)
    with objective +=  LP * (peak - peak_so_far)                   (the Leistungspreis, exact)
                     + peak_ratchet_eur_per_kw(LP) * peak_below    (the shave-target ratchet)
    and, ONLY when grid_charge_hurdle_ct_kwh > 0 (fixed tariff, E6 A, see below):
               gc_t >= charge_t + curtail_t - max(pv_t - load_t, 0), gc_t >= 0
    with objective +=  hurdle * gc_t * dt                          (the ehrliche Marge)

Design decisions, deliberately:

- **Import and export are priced ASYMMETRICALLY per slot (P1, Stage 2 of the
  optimizer redesign - the market-revenue objective).** ``import_price_t`` is
  what an imported kWh really costs the site (its supply tariff: spot +
  Aufschlag for a dynamic tariff, the flat retail price for a fixed one, bare
  spot for a spot-settled load); ``export_value_t`` is what an exported kWh
  really earns (spot + Marktprämie for Direktvermarktung, the feste
  EEG-Einspeisevergütung for an eigenverbrauch plant, bare spot otherwise) -
  built by :mod:`voltpilot_optimization.pricing`. Minimizing this signed
  cashflow IS maximizing market revenue. The pre-P1 symmetric bare-spot model
  (critique finding F1: economically wrong for nearly every real DACH
  prosumer) is the exact special case import_price == export_value == spot,
  which remains the fallback whenever tariff/remuneration data is absent.
  Under asymmetric prices, energy routing decisions become real: PV can serve
  the battery while the load imports cheaply, and a stored kWh goes to
  whichever flow (avoided import vs. export) earns more per slot - no
  hard-coded self-consumption preference anywhere (target report §2.2).
- **Simultaneous import+export is excluded with a second binary**
  (``is_importing``). With asymmetric prices this is not just a degeneracy
  guard: whenever export_value_t > import_price_t (a real configuration - a
  spot-settled Direktvermarktung site's premium makes export worth MORE than
  import costs), an LP would import and export unboundedly in the same slot to
  farm the difference without any physical flow. The big-Ms are the tightest
  physical bounds: M_imp_t = max(load_t, 0) + max_charge (+ any negative-PV
  guard), M_exp_t = max(pv_t, 0) + max_discharge (+ any negative-load guard).
- **Simultaneous charge+discharge is excluded with binaries** (``is_charging``),
  not by an efficiency argument: with only round-trip losses in the model, an
  LP would happily charge AND discharge in the same slot whenever the price is
  NEGATIVE (burning energy through the round trip is "profitable" then), and
  negative day-ahead prices are a normal occurrence in DE-LU. 192 binaries are
  trivial for HiGHS (solves in milliseconds).
- **Terminal ENERGY VALUE instead of a hard terminal floor (P3, Stage 3 of the
  optimizer redesign, critique finding F3).** The old constraint
  ``soc_T >= soc_0`` froze the battery on every low-PV day in EEG mode (no PV
  surplus means nothing may charge, so nothing may discharge either - a full
  battery idled through a 250 EUR/MWh evening peak, and through whole German
  winters) and forced merchant plans into uneconomic end-of-horizon buy-backs.
  Instead the objective credits ``V_end * (soc_T - soc_0)``: stored energy
  left at the horizon end is WORTH something, so the plan discharges whenever
  a slot genuinely beats that value and holds otherwise. ``V_end`` comes from
  :meth:`OptimizationInput.effective_terminal_value_eur_per_kwh`, which
  delegates to the shared
  :func:`~voltpilot_optimization.domain.derive_terminal_value_eur_per_kwh`: a
  conservative low quantile of the horizon's REPLACEMENT (refill) prices,
  times the one-way efficiency, minus the pending discharge wear, and held
  strictly below the best in-horizon use value. Forecast free-refill potential
  is exported as explanation but never discounts terminal energy before the
  SoC path has actually stored it (Pilsting 28.08.2026; derivation + config
  knobs there and in
  :mod:`voltpilot_optimization.config`). Because the same eta/wear terms price
  the in-horizon discharge, "discharge at exactly the anchor price" is an
  EXACT tie broken toward holding by the epsilon tie-breaks below: a curve
  with nothing to earn still plans an idle battery (zero savings on flat,
  preserved by construction), a trough or cheap end-of-horizon tail never
  triggers a dump (its value is below the anchor), and any genuinely better
  slot discharges. Note the plan may now realize energy stored BEFORE the
  horizon (that is the F3 fix); the ex-ante savings figure reflects it, the
  realized-earnings engine stays the honest number.
  Anchoring on the best USE instead of the replacement cost was the original
  formulation and froze every flat-tariff plant outright - see the scout
  reference in the shared derivation.
- **The backup-reserve SoC floor is a HARD constraint (P11).** A customer-
  configured ``site.backup_reserve_soc_pct`` raises the battery's lower SoC
  bound (``BatteryParams.soc_floor_kwh``): the plan NEVER schedules below it,
  no matter what the terminal value or any price says - reserve is a hard
  floor, V_end a soft value. (The Deye-Copilot scout documented that product
  silently draining below its configured min-SoC; VoltPilot's must hold.) A
  battery currently BELOW its reserve relaxes the floor to the actual start
  (feasibility; it may not discharge any further, and the rolling MPC re-plan
  ratchets the floor back up as it recovers).
- **Efficiency is split symmetrically** (sqrt of the round trip per direction),
  so stored energy is charged and discharged at the same marginal loss.
- **PV curtailment is a first-class decision** (``curtail_t``, Phase 3 of the
  fleet overview): without it, the grid balance FORCES the plant to export
  surplus PV even when feeding in costs money - with a full battery the plan
  then literally pays to feed in. Curtailment is bounded by the PV forecast
  (only ever a *reduction* of feed-in, never negative generation - the safety
  property the edge re-clamps), and there is deliberately NO price condition
  in the model: discarding energy is optimal exactly when the EXPORT VALUE is
  negative (at a positive export value it burns revenue), so the economics
  pick the right slots on their own. Under P1 that automatically fixes
  critique finding F6: a Direktvermarktung plant curtails at negative spot
  (the premium is suspended there, export value = spot < 0), while a
  feste-Vergütung plant commissioned before the Solarspitzengesetz NEVER
  curtails (its export value is the fixed rate, positive regardless of spot).
  A tiny tie-break penalty (``CURTAIL_TIEBREAK_EUR_PER_KW``) keeps the
  solution deterministic where the export value makes curtailing cost-neutral
  (value == 0, e.g. a post-Solarspitzengesetz plant in a negative-price slot,
  or PV already fully consumed on site): prefer NOT curtailing. It corresponds
  to a value threshold of ~-0.004 EUR/MWh - negligible against real negative
  prices, but it means hairline-negative slots stay uncurtailed rather than
  churning the inverter for fractions of a cent.
- **Battery degradation is PRICED, not epsilon-scale (P2 of the optimizer
  redesign, critique finding F2).** ``c_wear`` is the asset's wear cost per kWh
  cycled (``BatteryParams.wear_cost_ct_per_kwh``: the per-asset
  ``asset.wear_cost_ct_per_kwh`` override or the platform default, see
  :mod:`voltpilot_optimization.config` for the LFP derivation), levied as
  ``c_wear/2`` on every AC-side kWh of charge AND discharge - a full round
  trip of one kWh costs exactly ``c_wear``. A cycle therefore happens only
  when the spread genuinely clears wear on top of round-trip losses:
  ``eta^2 * p_discharge - p_charge > c_wear * 5 * (1 + eta^2)`` [EUR/MWh]
  (~38 EUR/MWh at the 4 ct default) - the pre-P2 model cycled ~3 full
  cycles/day chasing sub-cent spreads because its only wear signal was the
  1e-6 tie-break below. The spent wear is persisted per slot
  (``PlanSlot.wear_cost_eur`` -> ``schedule.wear_cost_eur``) so reporting can
  show the honest net savings.
- **A twin tie-break on battery throughput** (``BATTERY_WEAR_TIEBREAK_EUR_PER_KW``,
  on charge + discharge) keeps the battery IDLE when cycling earns nothing
  even when ``c_wear`` is configured to 0. Without it, curtailment introduces
  a degenerate tie: routing otherwise-curtailed PV through the battery
  (charge now, discharge into a capped export later) moves no money but
  slightly lowers total curtailment, so the curtailment tie-break alone would
  PREFER that pointless wear. The tie-break is the same epsilon scale
  (~0.008 EUR/MWh equivalent), so real economics are never distorted - it
  only breaks exact ties toward the battery-friendly plan.
- **A THIRD tie-break on charge TIMING** (``EARLY_CHARGE_TIEBREAK_EUR_PER_KW``,
  a per-slot penalty on charge that grows with the slot's horizon position;
  captain decision 2026-08-09 "bei gleichen Kosten so frueh wie moeglich
  laden") places an otherwise cost-equal charge as EARLY as possible. A long
  free/negative-price PV-surplus window is a pure timing tie - filling the
  battery early or late costs the same and HiGHS put the fill at the window's
  END (Anlage Pilsting). Early filling is strictly more ROBUST (clouds arriving
  before forecast still find a full battery) and, on a plant whose curtailment
  is not yet released, immediately cuts the real loss-making export at negative
  prices by the charge power. It is 10x SMALLER than the two siblings so it
  stays cleanly sub-dominant: prefer-idle decides WHETHER to cycle, early-charge
  only WHEN a justified charge is placed - and being a positive penalty on
  charge (minimized at charge = 0) it pushes the same way as prefer-idle, so it
  can never reward spurious cycling. Full magnitude / no-circular-effect
  argument at the constant.
- **A FOURTH tie-break on discharge TIMING** (``EARLY_DISCHARGE_TIEBREAK_EUR_PER_KW``,
  the exact mirror of the third one; captain decision 2026-08-18 "erst dein
  Verbrauch, dann der Rest") places an otherwise cost-equal DISCHARGE as EARLY
  as possible - the "Jetzt-Vorzug" INSIDE the horizon, twin of the
  ``TERMINAL_VALUE_COVER_NOW_DISCOUNT_EUR_MWH`` discount that breaks the same
  tie at the horizon EDGE (see :mod:`voltpilot_optimization.config`). On a flat
  retail tariff every deficit slot avoids the SAME import price, so "cover the
  09:15 block load" and "cover the 22:00 evening load" are algebraically
  identical and HiGHS picked arbitrarily: measured at Anlage Pilsting on
  2026-08-18 the battery sat idle at 17 % through a 25-kW block load, importing
  15-23 kW at 25 ct for three hours, and spent the very same energy later.
  Covering earlier is weakly dominant in reality (a later refill opportunity
  can only add value, never remove it) and strictly more ROBUST, the same
  argument the early-charge sibling rests on. Same 1e-7 scale and the same
  no-circular-effect property (a positive penalty on discharge, minimized at
  discharge = 0, so it pushes with prefer-idle and can never reward a discharge
  the economics have not already justified). Full magnitude / sell-timing
  argument at the constant.

- **The per-site grid-charging switch (``netzladen_erlaubt``, captain decision
  2026-07-07; PV-bus semantics per FK3, captain decision 2026-07-16)** is
  exactly ONE conditional constraint - merchant mode (``True``) builds the
  identical model as before, so the two modes share every other rule (prices,
  forecasts, §14a, efficiency, curtailment, tie-breaks) and merchant plans are
  regression-identical to the pre-switch optimizer. EEG mode (``False``, the
  DB default) enforces the Ausschliesslichkeitsprinzip with **PV-bus
  Bilanzierung** (FK3, matching the captain's Excel reference spec and
  DC-hybrid physics):

  ``charge_t <= max(pv_t, 0) - curtail_t`` - the battery may charge up to the
  full PV actually PRODUCED, **while the house draws its load from the grid in
  parallel** (the PV bus feeds the battery, the grid feeds the load - two
  separate flows on a DC-hybrid). This replaces the pre-FK3 Zähler
  (meter-point) interpretation, which was strictly tighter (``charge <=
  max(pv - load, 0)`` plus an import ban while charging) and forbade charging
  on cloudy days (load > pv) that the reference spec allows. Subtracting
  ``curtail_t`` is LOAD-BEARING: it is what keeps the documented Graustrom
  loophole closed - at negative prices the model would otherwise curtail the
  PV fully and cover a nominally "solar" charge with paid grid import (the
  pre-FK3 import-ban constraint existed for exactly that and is now removed).
  With the bound on pv - curtail, the charge power is always covered by
  UNCURTAILED PV: in a charging slot the grid balance gives
  ``import <= load_t`` (the import can at most feed the load, never the
  battery), so the stored energy stays provably solar and the pricing layer
  may still credit EEG remuneration (Marktprämie / feste Vergütung) on ALL
  export in EEG mode - see :mod:`voltpilot_optimization.pricing`; the
  premium-eligibility argument is preserved. Curtailment itself stays
  unrestricted for the FEED-IN side - full curtailment while importing the
  LOAD remains a legitimate (and EEG-clean) negative-price play; a fully
  curtailed slot simply cannot charge.

- **Strenge Ausschliesslichkeit (MiSpeL MP-45, Kasten W1 = D: Option B
  schaltbar bereithalten).** The BNetzA describes the Ausschliesslichkeits-
  option more strictly than FK3: „kein Verbrauch im Stromspeicher ..., waehrend
  es gleichzeitig einen Netzbezug gibt“ (Festlegung MiSpeL, Anlage 1 S. 11;
  gleichzeitig = within the same 15-minute interval, Anlage 1 S. 7 Abschn. 1
  „Zeitgleichheit“; Speichervorrang je Viertelstunde, § 21 Abs. 4 S. 3 EnFG,
  Anlage 1 S. 14-15). With the operator switch on for an EEG site
  (``config.mispel_strenge_site_ids``), ``strenge_ausschliesslichkeit``
  forbids grid import in every charging slot beyond the tolerance:
  ``import_t <= tol / 0.25 h + M_imp_t * (1 - is_charging_t)``. It reuses the
  charge/discharge binary, so it adds no integer variable: a slot that
  charges at all (``is_charging_t = 1``) imports at most the tolerance, a slot
  that does not is unrestricted. With the default tolerance 0 this is exactly
  the quantity the MP-2 Pruefer measures, (1)¼ = MIN [ Z1NB¼ ; Z2V¼ ] = 0
  (Anlage 1 S. 33); with a tolerance > 0 it is conservative (it caps the
  import, not the MIN). Off (the default) builds no constraint at all, so
  every plan is byte-identical to FK3; a merchant site ignores the switch.
  Present in BOTH builds like ``solar_only_charge`` - the infeasible-§14a
  fallback must stay just as strict. Charging zero always satisfies it, so it
  never makes a plan infeasible on its own.

- **Ehrliche Marge on grid-sourced charge (Captain-Entscheid E6 A,
  24.09.2026; K0 vp-wr-k0-plandaten).** FK3 is a LEGAL statement (the PV bus
  may feed the battery while the house imports), not an economic one:
  economically every kW charged beyond the slot's PV surplus is a kW bought
  at the import price. At a fixed-tariff site the model used to take that
  purchase for a hairline gain - Herzogau 24.09. 14:00-14:30Z charged
  7,1/5,4/4,0 kW over the PV bus at 25 ct to sell at 28,8/29,1 ct, +0,5 to
  +0,8 ct/kWh after the round trip, lambda pinned at (25 + 0,5)/eta = 26,6.
  ``gc_t >= charge_t + curtail_t - max(pv_t - load_t, 0)`` isolates that
  grid-sourced part, and ``grid_charge_hurdle_ct_kwh`` (the ONE constant
  ``FEST_GRID_CHARGE_HURDLE_CT_PER_KWH``, 0 = no term for spot sites) prices
  it, so a purchase must now clear the round trip PLUS the hurdle. The
  in-slot trim reads the same constant, which is what lets it mark such a
  slot ``charge_from_surplus_only`` at all (its consistency guard never
  undoes a purchase the plan intends).

- **Peak shaving is priced ECONOMICALLY, never enforced as a hard cap (PS-1,
  scout vp-battery-models-b9 Teil 3 b/c).** An RLM site's Leistungspreis
  (``leistungspreis_eur_kw``, EUR per kW per billing period) applies to the
  highest 15-min mean grid IMPORT of the period. The standard epigraph
  ``peak >= grid_import_t`` for all t plus the anchor ``peak >= peak_so_far``
  (the period's measured peak so far, computed fresh per cycle) makes the
  objective term ``LP * (peak - peak_so_far)`` EXACT: exceeding the period
  peak by Δ kW costs precisely LP·Δ, and the solver weighs that against
  arbitrage/self-consumption gains on its own - no hard cap, so there is NO
  new infeasibility path (the §14a fallback machinery is untouched, and the
  term lives in BOTH builds: an advisory plan for an infeasible §14a site
  must still shave its peak). Below ``peak_so_far`` the marginal term is
  genuinely zero (nothing left to save in this period), which is where the
  **shave-target ratchet** comes in: a weak secondary term
  ``peak_ratchet_eur_per_kw(LP) * peak_below`` on the plain horizon peak
  (``peak_below >= grid_import_t``, no anchor) keeps the battery shaving
  after a torn peak and at period start (a torn peak may be a measurement
  artifact; the 1st-of-January 00:15 must not define the year's maximum).
  Deliberately wear-scale, never epsilon-scale - and CAPPED so it never
  dominates real arbitrage; the weight derivation and the trade-off
  discussion live in :mod:`voltpilot_optimization.config`. (Note the ratchet
  also adds its small weight on TOP of the full LP above the anchor - a
  documented, negligible overshoot inherent in the two-epigraph form.) The
  solved ``peak`` is published as the plan's ``grid_import_limit_kw`` (the
  edge peak-guard's target) and persisted as ``schedule.peak_target_kw``.
- **The peak-shaving reserve is a HARD SoC floor (PS-2).** The 24h horizon
  never sees the whole billing period, so the epigraph alone would let the
  evening arbitrage drain the battery before an out-of-horizon Monday-morning
  peak (reserve myopia, report (c)1). ``BatteryParams.peak_reserve_pct``
  joins the reservation stack (technical < backup < peak-reserve, highest
  configured absolute floor binds) through the same
  :meth:`BatteryParams.soc_floor_kwh` machinery as the P11 backup reserve,
  including the below-floor-start relaxation - hard, never soft.

The solver toolchain is Pyomo + HiGHS via ``highspy`` (the repo-wide choice,
see AGENTS.md); ``highspy`` stays a lazy import behind the optional ``solver``
extra so the package imports (and non-solver tests run) without the wheel.
"""

from __future__ import annotations

import logging
import math
from dataclasses import replace
from datetime import datetime
from uuid import UUID

from pyomo.environ import (
    Binary,
    ConcreteModel,
    Constraint,
    ConstraintList,
    NonNegativeReals,
    Objective,
    Param,
    RangeSet,
    Var,
    minimize,
    value,
)

from voltpilot_optimization.config import (
    night_reserve_enabled,
    peak_ratchet_eur_per_kw,
)
from voltpilot_optimization.domain import (
    VIERTELSTUNDE_H,
    WIRKUNGSGRAD_LADEPUNKT,
    FahrzeugPlan,
    FahrzeugSlot,
    OptimizationInput,
    PlanSlot,
    SchedulePlan,
)
from voltpilot_optimization.fahrzeugspeicher import LADEPUNKT_FORMELSAETZE
from voltpilot_optimization.night_reserve import (
    NightReserveTerms,
    held_level,
    night_reserve_of,
    night_reserve_terms,
    stash_night_reserve,
)
from voltpilot_optimization.stur import stur_cost_eur

logger = logging.getLogger("voltpilot.optimization.solver")


class InfeasiblePlanError(RuntimeError):
    """The MILP has no feasible solution (in practice: the §14a grid limit is
    tighter than the site's residual load even with full battery support)."""


# Tie-break penalty on curtailment (EUR per kW per slot): strictly prefer NOT
# curtailing whenever the price makes it cost-neutral. See the module docstring.
CURTAIL_TIEBREAK_EUR_PER_KW = 1e-6

# Tie-break penalty on battery throughput (EUR per kW charge/discharge per
# slot): strictly prefer an idle battery when cycling moves no money. See the
# module docstring for why curtailment makes this necessary.
BATTERY_WEAR_TIEBREAK_EUR_PER_KW = 1e-6

# Tie-break penalty on the TIMING of battery charge (captain decision
# 2026-08-09: "bei gleichen Kosten so frueh wie moeglich laden"). A per-slot
# penalty on charge that GROWS linearly with the slot's position in the horizon
# (weight t / max(n-1, 1), so 0 at the first slot and this value at the last):
# under otherwise cost-equal plans the earliest charge placement wins. It fixes
# a real degeneracy (Anlage Pilsting): a long free/negative-price PV-surplus
# window is a pure timing tie - filling the battery early or late costs exactly
# the same, and HiGHS put the fill at the END of the window. Early filling is
# strictly more ROBUST: if clouds arrive earlier than forecast the battery is
# already full (the morning surplus was captured, not wasted), and on a plant
# whose curtailment is not yet certified/released the surplus is really being
# EXPORTED at negative prices, so charging now cuts that loss-making feed-in by
# the charge power immediately.
#
# Magnitude and the no-circular-effect argument (this is a THIRD tie-break next
# to the two above, and its interplay must stay deterministic):
# - It is 10x SMALLER than the two 1e-6 siblings, so at its maximum (last slot)
#   it is a strict fraction of the prefer-idle penalty regardless of horizon
#   length. That keeps the clean separation of duties: prefer-idle decides
#   WHETHER to cycle (its 1e-6 dominates), early-charge only decides WHEN a
#   charge that is otherwise happening is placed. There is no circular effect
#   because early-charge is a POSITIVE penalty on charge (minimized at
#   charge = 0), so it pushes in the SAME direction as prefer-idle - it can
#   never reward spurious cycling, only front-load a charge the economics have
#   already justified. Discharge is deliberately untouched (only charge timing
#   is steered).
# - Its price-equivalent at the last slot is 1e-7 / (dt/1000) = ~4e-4 EUR/MWh,
#   two orders of magnitude below the ~0.01 EUR/MWh resolution of real
#   day-ahead prices, so a genuinely cheaper later slot (beyond that threshold)
#   still wins - real economics are never overridden, only exact ties broken.
#   The MIP gap is 1e-9 (below), so a realistic fill (tens of kW over several
#   slots, ~1e-6 EUR of accumulated weight difference) is resolved decisively.
EARLY_CHARGE_TIEBREAK_EUR_PER_KW = 1e-7

# Tie-break penalty on the TIMING of battery DISCHARGE - the exact mirror of
# the charge-timing tie-break above (captain decision 2026-08-18: "ab dann gilt
# durchgehend: erst dein Verbrauch, dann der Rest"). Same shape, same scale: a
# per-slot penalty on discharge that GROWS linearly with the slot's position in
# the horizon, so under otherwise cost-equal plans the EARLIEST discharge
# placement wins.
#
# The tie it breaks (Anlage Pilsting/Herzogau, 2026-08-18 morning): on a FLAT
# retail tariff every deficit slot avoids the SAME import price, so "cover the
# 09:15 block load" and "cover the 22:00 evening load" are the same money down
# to the last digit - the plan discharges the same total either way, and only
# the PLACEMENT is degenerate. HiGHS placed it late: the battery sat at 17 %
# (not the 5 % floor) through a 25-30 kW block load and imported 15-23 kW at
# 25 ct for three hours, then spent the identical energy in the evening. This
# term is the INSIDE-the-horizon twin of TERMINAL_VALUE_COVER_NOW_DISCOUNT_
# EUR_MWH (config.py), which breaks the same tie at the horizon EDGE ("cover
# now vs. hold past the horizon"); together they make "cover your own load as
# soon as you can" the strict preference everywhere. Economically: covering
# earlier is weakly dominant - a refill opportunity arriving later can only add
# value to the freed capacity, never take any away.
#
# Magnitude and the interplay (this is the FOURTH tie-break, and its ordering
# against the three above must stay deterministic):
# - Same 1e-7 as its charge twin, i.e. 10x SMALLER than the two 1e-6 siblings,
#   so the separation of duties holds: prefer-idle decides WHETHER to cycle
#   (1e-6 dominates), the timing tie-breaks only decide WHEN. It is a POSITIVE
#   penalty on discharge (minimized at discharge = 0), so it pushes in the SAME
#   direction as prefer-idle and can never reward spurious cycling - it only
#   front-loads a discharge the economics have already justified.
# - No circularity with the charge twin: charge and discharge are mutually
#   exclusive per slot (the is_charging binary) and both terms are positive
#   penalties on their OWN variable, so neither can pay for the other.
# - Its price-equivalent at the last slot is 1e-7 / (dt/1000) = ~4e-4 EUR/MWh,
#   ~25x below the 0.01 EUR/MWh resolution of real day-ahead prices, so any
#   genuinely better later slot still wins - real economics are never
#   overridden, only exact ties broken.
# - On SELL timing (the S2 winter guard's neighbourhood) it is therefore inert
#   wherever the export value differs at all between two slots: a real price
#   peak keeps the sale. It never LOWERS the bar for selling - the decision
#   "sell at all" is made by export value vs. terminal value + wear, and this
#   penalty only ever makes discharging (hence selling) marginally more
#   expensive, i.e. it pushes the same way as the S2 guard, never against it.
EARLY_DISCHARGE_TIEBREAK_EUR_PER_KW = 1e-7

# UEMS AP-15 IP-14 "Abregeln nach Wert": an EINEM Anschluss hat jede erzeugte
# kWh je Slot denselben Wert, also ist die Aufteilung einer Abregelung auf die
# Erzeuger wirtschaftlich gleichgueltig. Dieser Gleichstand-Brecher (unter dem
# Abregel-Brecher oben, er aendert also nie, OB abgeregelt wird) legt sie auf
# die Erzeugung der fuehrenden Box - ihr Regelkreis korrigiert gegen Messung;
# die PV einer mitsteuernden Box wird nur abgeregelt, soweit ihr Anteil es
# verlangt. Nur in einem Lauf mit Verbund im Modell.
VERBUND_CURTAIL_TIEBREAK_EUR_PER_KW = 5e-7

# MIP optimality tolerances (scout vp-fahrplan-idle-n7, "latent defect found in
# passing"). HiGHS defaults to mip_rel_gap = 1e-4, i.e. on a ~10 EUR objective
# it stops ~1e-3 EUR short of the true optimum - ORDERS OF MAGNITUDE above the
# 1e-6 tie-break epsilons above, whose whole job is to decide exact ties. The
# tie-breaks were therefore not decisive at all: a full 15 kW / 44-slot cycle
# carries only ~6.6e-4 EUR of tie-break penalty, so "completely idle" and
# "serve the whole evening" were tolerance-equivalent and WHICH one HiGHS
# returned was effectively arbitrary - and could flip between two consecutive
# 15-min re-plans. On a genuinely controllable plant that is an oscillation
# hazard, so we tighten the gap rather than inflate the epsilons: the gap costs
# ~10% solve time (measured over the golden suite: 529 ms -> 582 ms for all
# eight scenarios) and changes NO economics, whereas epsilons big enough to
# beat a relative gap would distort real decisions. Measured side effect: three
# of the eight golden scenarios were being solved SUBOPTIMALLY at the default
# (peak-shaving-ci by 1.2e-3 EUR) and now reach their true optimum.
MIP_REL_GAP = 1e-9
MIP_ABS_GAP = 1e-9


def build_model(inp: OptimizationInput, enforce_grid_limit: bool = True) -> ConcreteModel:
    """Build the dispatch MILP for one site over the horizon.

    Kept separate from solving so the formulation is testable without the
    HiGHS wheel installed.
    """
    p = inp.battery
    n = inp.slots
    dt = inp.slot_hours
    eta = p.one_way_efficiency
    soc0 = p.clamp_soc_kwh(inp.initial_soc_kwh)

    m = ConcreteModel()
    m.T = RangeSet(0, n - 1)  # decision slots
    m.S = RangeSet(0, n)  # SoC nodes (slot boundaries)

    # Steuerung Stufe 3 (§3.7 A4): a battery an ACTIVE customer rule claims is
    # not the plan's to command - its power bounds collapse to 0, the SoC path
    # stays flat and the run claims no savings on it. Deliberately a BOUND, not
    # a constraint: nothing is added to the model, so the explain layer's
    # KNOWN_CONSTRAINTS inventory and the golden suite are untouched, and an
    # unclaimed battery (the default) is byte-identical.
    # P7 (Scout vp-deye-diybms-luecke-l5 §3.3 / Paket P7, Captain-Entscheid
    # E4=b): OHNE Ladestand plant niemand einen Speicher. Ein Lauf, dessen
    # Start-SoC weder gemessen noch berechnet ist, weiss nicht, wie voll die
    # Batterie ist - jede Ladung koennte an die Decke stossen, jede Entladung
    # in den Boden. Die Bounds kollabieren deshalb auf 0, GENAU wie bei einer
    # von einer Kundenregel beanspruchten Batterie: derselbe Mechanismus, zwei
    # Gruende. Der Plan ist dann "Ruhe", und `soc_source` traegt das WARUM bis
    # in die Fahrplan-Seite.
    #
    # Ebenfalls eine BOUND, kein Constraint: KNOWN_CONSTRAINTS und die
    # Golden-Suite bleiben unberuehrt, und ein Lauf mit Ladestand (die Vorgabe
    # jedes Aufrufers, der seine Eingaben selbst baut) ist byte-identisch.
    battery_ruht = inp.battery_held or inp.soc_unbekannt
    charge_cap = 0.0 if battery_ruht else p.max_charge_kw
    discharge_cap = 0.0 if battery_ruht else p.max_discharge_kw
    # Steuerung Stufe 7: „Speicher jetzt laden" als Vorschau - die ersten N
    # Slots tragen eine UNTERGRENZE auf der Ladung. Ebenfalls eine BOUND (siehe
    # OptimizationInput.forced_charge_slots), also nichts im Modell und nichts
    # in KNOWN_CONSTRAINTS; die Vorgabe 0 ist byte-identisch zu jedem Lauf davor.
    forced_kw = 0.0 if battery_ruht else max(inp.forced_charge_kw, 0.0)
    forced_n = max(min(inp.forced_charge_slots, n), 0) if forced_kw > 0 else 0

    def _charge_bounds(model, t):
        low = min(forced_kw, charge_cap) if t < forced_n else 0.0
        return (low, charge_cap)

    m.charge = Var(m.T, domain=NonNegativeReals, bounds=_charge_bounds)
    m.discharge = Var(m.T, domain=NonNegativeReals, bounds=(0, discharge_cap))
    m.is_charging = Var(m.T, domain=Binary)
    # Curtailment can only ever REDUCE feed-in: bounded per slot by the PV
    # forecast, so pv - curtail (the published inverter cap) is never negative.
    m.curtail = Var(
        m.T,
        domain=NonNegativeReals,
        bounds=lambda model, t: (0.0, max(inp.pv_kw[t], 0.0)),
    )
    # SoC lower bound: the 5% technical floor, raised by the customer's backup
    # reserve (P11, hard), relaxed to the actual start when the battery
    # currently sits below it (see BatteryParams.soc_floor_kwh).
    soc_floor = p.soc_floor_kwh(soc0)
    m.soc = Var(m.S, bounds=(soc_floor, p.soc_max_kwh))
    m.soc[0].fix(soc0)

    # The tightest physical bounds on a slot's import/export (see module
    # docstring): import <= load + charge (curtail cancels at most the full
    # PV), export <= pv + discharge. The max(-x, 0) terms only guard against
    # pathological negative forecasts ever making the big-M cut into the
    # feasible region.
    # MiSpeL MP-33: das Fahrzeug am bidirektionalen Ladepunkt zieht bzw.
    # liefert zusaetzlich - ohne Fahrzeug bleiben beide Schranken wie sie waren.
    fz = inp.fahrzeug

    def _m_import(t: int) -> float:
        m_imp = max(inp.load_kw[t], 0.0) + p.max_charge_kw + max(-inp.pv_kw[t], 0.0)
        return m_imp + fz.laden_kw if fz is not None else m_imp

    def _m_export(t: int) -> float:
        m_exp = max(inp.pv_kw[t], 0.0) + p.max_discharge_kw + max(-inp.load_kw[t], 0.0)
        return m_exp + fz.rueckspeisen_kw if fz is not None else m_exp

    m.grid_import = Var(
        m.T, domain=NonNegativeReals, bounds=lambda model, t: (0.0, _m_import(t))
    )
    m.grid_export = Var(
        m.T, domain=NonNegativeReals, bounds=lambda model, t: (0.0, _m_export(t))
    )
    m.is_importing = Var(m.T, domain=Binary)
    # MiSpeL MP-33: das Fahrzeug als zweiter Speicher (siehe _add_fahrzeug).
    # Ohne Fahrzeug kommt nichts ins Modell - jeder Lauf byte-gleich.
    fahrzeug_term = _add_fahrzeug(m, inp) if fz is not None else None

    # The grid balance ties the split import/export to the physical flows.
    def _grid_balance(model, t):
        fluss = (
            inp.load_kw[t]
            - inp.pv_kw[t]
            + model.curtail[t]
            + model.charge[t]
            - model.discharge[t]
        )
        if fz is not None:
            fluss = fluss + model.fz_laden[t] - model.fz_rueck[t]
        return model.grid_import[t] - model.grid_export[t] == fluss

    m.grid_balance = Constraint(m.T, rule=_grid_balance)
    # Mutually exclusive import/export (see module docstring: with
    # export_value > import_price this is load-bearing, not just a tie-break).
    m.import_gate = Constraint(
        m.T,
        rule=lambda model, t: model.grid_import[t]
        <= _m_import(t) * model.is_importing[t],
    )
    m.export_gate = Constraint(
        m.T,
        rule=lambda model, t: model.grid_export[t]
        <= _m_export(t) * (1 - model.is_importing[t]),
    )

    m.soc_dynamics = Constraint(
        m.T,
        rule=lambda model, t: model.soc[t + 1]
        == model.soc[t] + (eta * model.charge[t] - model.discharge[t] / eta) * dt,
    )
    # Mutually exclusive charge/discharge (see module docstring).
    m.charge_gate = Constraint(
        m.T, rule=lambda model, t: model.charge[t] <= p.max_charge_kw * model.is_charging[t]
    )
    m.discharge_gate = Constraint(
        m.T,
        rule=lambda model, t: model.discharge[t]
        <= p.max_discharge_kw * (1 - model.is_charging[t]),
    )
    if not inp.netzladen_erlaubt:
        # EEG mode (site.netzladen_erlaubt = false): the battery charges ONLY
        # from PV the site actually PRODUCES - PV-bus Bilanzierung (FK3,
        # captain decision 2026-07-16: the house may import its load in
        # parallel, DC-hybrid physics). Present in BOTH builds - the
        # infeasible-§14a fallback must stay EEG-clean. Subtracting curtail is
        # load-bearing: a fully curtailed slot cannot charge, so the Graustrom
        # loophole (curtail PV, cover the "solar" charge with paid import at
        # negative prices) stays closed without the pre-FK3 import ban - via
        # the grid balance, a charging slot's import never exceeds the load.
        # Grid-charged energy is thus impossible by construction, preserving
        # the EEG premium-eligibility argument in pricing.py (all export in
        # EEG mode is provably solar). max(pv, 0) guards pathological negative
        # forecasts (curtail's own bound already uses it).
        m.solar_only_charge = Constraint(
            m.T,
            rule=lambda model, t: model.charge[t]
            <= max(inp.pv_kw[t], 0.0) - model.curtail[t],
        )
    if inp.strenge_aktiv:
        # MiSpeL MP-45 (W1 = D, Option B): the strict reading - no charging in
        # a quarter hour with grid import (Anlage 1 S. 11). FK3 above keeps
        # binding; this one tightens it: a charging slot imports at most the
        # tolerance per quarter hour (default 0 kWh, domain constant). Built
        # only with the operator switch on, so every other model is unchanged.
        toleranz_kw = inp.strenge_toleranz_kwh / VIERTELSTUNDE_H
        m.strenge_ausschliesslichkeit = Constraint(
            m.T,
            rule=lambda model, t: model.grid_import[t]
            <= toleranz_kw + _m_import(t) * (1 - model.is_charging[t]),
        )
    # Ehrliche Marge (Captain-Entscheid E6 A, K0 vp-wr-k0-plandaten): at a
    # fixed-tariff site the grid-sourced part of a charge must earn the hurdle
    # AFTER the full round trip. grid_charge_kw is that part - the charge
    # beyond the slot's forecast PV surplus: in a deficit slot every charged
    # kW is one more kW imported (FK3's PV bus feeds the battery, the grid the
    # house), in a surplus slot only the charge above the surplus is. Adding
    # curtail keeps "curtail PV, import the house" inside the count. FK3 itself
    # (solar_only_charge) is untouched - EEG still lets the PV bus charge while
    # the house imports; only the economics get the honest hurdle. Built only
    # with a hurdle > 0, so a spot site's model is byte-identical.
    hurdle_eur_per_kwh = inp.grid_charge_hurdle_ct_kwh / 100.0
    hurdle_cost = 0.0
    if hurdle_eur_per_kwh > 0.0:
        m.grid_charge_kw = Var(m.T, domain=NonNegativeReals)
        m.grid_charge_hurdle = Constraint(
            m.T,
            rule=lambda model, t: model.grid_charge_kw[t]
            >= model.charge[t]
            + model.curtail[t]
            - max(max(inp.pv_kw[t], 0.0) - inp.load_kw[t], 0.0),
        )
        hurdle_cost = sum(
            hurdle_eur_per_kwh * m.grid_charge_kw[t] * dt for t in m.T
        )
    if enforce_grid_limit and inp.grid_limit_kw is not None:
        m.grid_import_cap = Constraint(
            m.T, rule=lambda model, t: model.grid_import[t] <= inp.grid_limit_kw
        )
        # DELIBERATELY still symmetric (export capped by the observed IMPORT
        # envelope): section 14a is an import-side dimming instrument, so
        # mirroring it onto export can force curtailment of healthy PV
        # (critique F4 part 2 / question D5) - changing the semantics is
        # regulatory-adjacent and awaits the captain's D5 answer. Stage 1 only
        # fixed the STALENESS of the reading (inputs._fresh_measurement).
        m.grid_export_cap = Constraint(
            m.T, rule=lambda model, t: model.grid_export[t] <= inp.grid_limit_kw
        )
    if inp.max_feed_in_kw is not None:
        # FK1: the site's STATIC feed-in cap at the grid connection point
        # (site.max_feed_in_kw master data, the Excel reference spec's "Max
        # Einspeisung am Netzpunkt") - EXPORT ONLY, import is never capped by
        # it. Separate from the symmetric, telemetry-driven §14a cap above;
        # when both exist the tighter one wins on export (two <= constraints).
        # Deliberately NOT behind enforce_grid_limit: curtailment can always
        # bring export to zero, so this cap can never make the model
        # infeasible - the infeasible-§14a fallback build must respect the
        # physical connection limit too (a 100-kW-PV plant on a 75-kW
        # connection must plan curtailment/charge, never an impossible export).
        m.feed_in_cap = Constraint(
            m.T, rule=lambda model, t: model.grid_export[t] <= inp.max_feed_in_kw
        )
    if inp.leistungspreis_eur_kw is not None:
        # Peak shaving (PS-1, see module docstring): epigraph over the
        # billing period's 15-min import peak. Economic term, never a hard
        # cap - present in BOTH builds (deliberately not behind
        # enforce_grid_limit: it cannot cause infeasibility, and the §14a
        # fallback plan must still shave). peak carries the Leistungspreis
        # above the measured period anchor; peak_below is the plain horizon
        # peak carrying the weak shave-target ratchet.
        m.peak = Var(domain=NonNegativeReals)
        m.peak_epigraph = Constraint(
            m.T, rule=lambda model, t: model.peak >= model.grid_import[t]
        )
        m.peak_anchor = Constraint(expr=m.peak >= inp.peak_so_far_kw)
        m.peak_below = Var(domain=NonNegativeReals)
        m.peak_below_epigraph = Constraint(
            m.T, rule=lambda model, t: model.peak_below >= model.grid_import[t]
        )
    # UEMS AP-15 IP-14 (P4): die Anteile der mitsteuernden Boxen. Ohne Verbund
    # (jede Ein-Box-Anlage) kommt nichts ins Modell - byte-identisch.
    verbund_cost = _add_verbund(m, inp, enforce_grid_limit) if inp.verbund else None
    # MiSpeL MP-10: die dritte Betriebsart (siehe _add_mischbetrieb). Ohne
    # Mischbetrieb kommt nichts ins Modell - jede andere Anlage byte-gleich.
    mischbetrieb_term = (
        _add_mischbetrieb(m, inp) if inp.mischbetrieb else None
    )
    # MiSpeL MP-26: der Jahreszustand der Pauschaloption (siehe
    # _add_jahreszustand). Ohne Jahresstand kommt nichts ins Modell.
    jahreszustand_term = (
        _add_jahreszustand(m, inp) if inp.mispel_jahresstand is not None else None
    )
    if inp.mischbetrieb and inp.leistungspreis_eur_kw is not None:
        # Leistungspreis-Schutz (Bauplan MP-10, Konzept § 5.2): ob § 118 Abs. 6
        # EnWG auch den Leistungspreis entlastet, ist offen (MP-3) - bis dahin
        # laedt der Speicher nie ueber die bestehende Bezugsspitze. Der
        # Netzstrom im Speicher (1)¼ bleibt im Spielraum zwischen der Spitze
        # bisher und dem Bezug, den das Haus ohne Speicher ohnehin zieht. Exakt
        # als Obergrenze, weil der Mischbetrieb nie unter die Last abregelt
        # (``mischbetrieb_abregelung``): im Ladeslot ist der Bezug dann
        # MAX [ Last - PV ; 0 ] + (1)¼. Vom Handeingriff „jetzt laden“
        # (forced) ausgenommen - der ist eine ausdrueckliche Anweisung und
        # darf das Modell nie unloesbar machen.
        def _spitzenschutz(model, t):
            if t < forced_n:
                return Constraint.Skip
            haus = max(inp.load_kw[t] - inp.pv_kw[t], 0.0)
            return model.netz_laden[t] <= max(inp.peak_so_far_kw - haus, 0.0)

        m.mispel_spitzenschutz = Constraint(m.T, rule=_spitzenschutz)
    # Real degradation cost per AC-side kWh in each direction (see module
    # docstring); the epsilon tie-break below stays for the c_wear = 0 case.
    wear_eur_per_kwh = p.wear_cost_eur_per_kwh_each_way
    import_prices = inp.import_prices
    export_values = inp.export_values
    # Terminal energy value (P3): credit the energy left in the battery at the
    # horizon end, replacing the old hard soc_T >= soc_0 floor (see module
    # docstring - this is what un-freezes an EEG battery on low-PV days while
    # keeping end-of-horizon dumps unattractive).
    v_end = inp.effective_terminal_value_eur_per_kwh()
    peak_cost = 0.0
    if inp.leistungspreis_eur_kw is not None:
        # EUR per kW per billing period - a per-POWER price, so no dt factor.
        # The full LP prices the period peak above the anchor EXACTLY; the
        # weak (capped, wear-scale) ratchet prices the plain horizon peak so
        # shaving continues below the anchor (see config.py).
        peak_cost = (
            inp.leistungspreis_eur_kw * (m.peak - inp.peak_so_far_kw)
            + peak_ratchet_eur_per_kw(inp.leistungspreis_eur_kw) * m.peak_below
        )
    m.total_cost = Objective(
        expr=sum(
            (
                import_prices[t] * m.grid_import[t]
                - export_values[t] * m.grid_export[t]
            )
            * dt
            / 1000.0
            + wear_eur_per_kwh * (m.charge[t] + m.discharge[t]) * dt
            + CURTAIL_TIEBREAK_EUR_PER_KW * m.curtail[t]
            + BATTERY_WEAR_TIEBREAK_EUR_PER_KW * (m.charge[t] + m.discharge[t])
            + EARLY_CHARGE_TIEBREAK_EUR_PER_KW * (t / max(n - 1, 1)) * m.charge[t]
            + EARLY_DISCHARGE_TIEBREAK_EUR_PER_KW
            * (t / max(n - 1, 1))
            * m.discharge[t]
            for t in m.T
        )
        + peak_cost
        + hurdle_cost
        - v_end * (m.soc[n] - soc0),
        sense=minimize,
    )
    if verbund_cost is not None:
        m.total_cost.expr = m.total_cost.expr + verbund_cost
    if mischbetrieb_term is not None:
        m.total_cost.expr = m.total_cost.expr + mischbetrieb_term
    if jahreszustand_term is not None:
        m.total_cost.expr = m.total_cost.expr + jahreszustand_term
    if fahrzeug_term is not None:
        m.total_cost.expr = m.total_cost.expr + fahrzeug_term
    _add_night_reserve(m, inp, soc_floor)
    return m


def _z2v(m: ConcreteModel, t):
    """Z2V¼ als Leistung: Verbrauch im Stromspeicher und/oder Ladepunkt (A1 S. 33).
    Mit Fahrzeug (A3/A4) misst Z2 beide (A1 S. 30–32); ohne ist es die Ladung."""
    return m.charge[t] + m.fz_laden[t] if hasattr(m, "fz_laden") else m.charge[t]


def _z2e(m: ConcreteModel, t):
    """Z2E¼ als Leistung: Erzeugung im Stromspeicher und/oder Ladepunkt (A1 S. 34)."""
    return m.discharge[t] + m.fz_rueck[t] if hasattr(m, "fz_rueck") else m.discharge[t]


def _z2_max_kw(inp: OptimizationInput) -> tuple[float, float]:
    p = inp.battery
    if inp.fahrzeug is None:
        return p.max_charge_kw, p.max_discharge_kw
    return (
        p.max_charge_kw + inp.fahrzeug.laden_kw,
        p.max_discharge_kw + inp.fahrzeug.rueckspeisen_kw,
    )


def _wirkungsgrad_14(inp: OptimizationInput) -> float:
    """(14): „(14)A2,A3,A4 = 0,85“ sobald ein Ladepunkt eingebunden ist (A1 S. 35);
    sonst der Wirkungsgrad des Plans statt (14)A1 = (6)/(5) (MP-10/MP-11)."""
    if inp.mispel_formelsatz in LADEPUNKT_FORMELSAETZE:
        return WIRKUNGSGRAD_LADEPUNKT
    return inp.battery.roundtrip_efficiency


def _gutschrift_eur_mwh(inp: OptimizationInput) -> float:
    """Was eine saldierfaehige kWh (16) entlastet: (16) + (19). In A2 und A3 ist
    „(19)A2,A3 = 0“ - keine privilegierungsfaehigen Speicherverluste (A1 S. 37);
    in A1 und A4 ist (19) = (18) * (17) (A1 S. 36–37), im Plan (16) / Wirkungsgrad
    des Stromspeichers (A4: Naeherung, Z3 misst nur ihn)."""
    if inp.mispel_formelsatz in ("A2", "A3"):
        return inp.saldierte_bestandteile_eur_mwh
    return inp.saldierte_bestandteile_eur_mwh / inp.battery.roundtrip_efficiency


def _add_fahrzeug(m: ConcreteModel, inp: OptimizationInput):
    """Das Fahrzeug am bidirektionalen Ladepunkt als Speicher (MiSpeL MP-33).

    Regeln und Lesarten stehen in :mod:`voltpilot_optimization.fahrzeugspeicher`;
    im Modell je Slot ``t``, in dem es angesteckt ist:

    - ``fahrzeug_soc``: ``fz_soc[t+1] = fz_soc[t] + (e * fz_laden - fz_rueck / e) * dt``
      mit ``e = sqrt(0,85)`` (A1 S. 35). Ausserhalb der Fenster ist es weg -
      Laden und Rueckspeisen sind 0, was es verfaehrt, ist Fahrstrom (sonstiger
      Verbrauch, A1 S. 25 Fn. 19), und an der Ankunft steht der feste Stand.
    - **Abfahrtsziel immer erreicht:** ``fz_soc[s] >= untergrenze[s]`` ist eine
      SCHRANKE der Variablen - der Mindest-Ladestand bzw. was das naechste Ziel
      mit voller Ladeleistung erreichbar haelt, an der Abfahrt das Ziel selbst.
    - ``fahrzeug_laden_gate``/``fahrzeug_rueck_gate``: nie zugleich laden und
      rueckspeisen (Ganzzahl ``fz_laedt``), nur mit Rueckspeisung im Modell.
    - ``fahrzeug_nur_haus`` (V2H ohne V2G, E3 = D): ein rueckspeisender Slot
      speist nicht ins Netz ein (``is_importing``) - die Rueckspeisung bleibt im
      Haus; zugleich die technische Sperre der Alternative (A1 S. 27 Fn. 22).
    - ``fahrzeug_zyklenbudget``: rueckgespeiste kWh je Berliner Kalendertag
      hoechstens ``vollzyklen_je_tag`` * Kapazitaet.

    Gibt den Verschleiss je rueckgespeister kWh plus den Gleichstand-Brecher
    „frueh laden“ zurueck (bei gleichem Preis frueher am Ziel).
    """
    fz = inp.fahrzeug
    n = inp.slots
    dt = inp.slot_hours
    e = fz.einweg
    da = [t for t in range(n) if fz.angesteckt[t]]
    m.fz_laden = Var(
        m.T,
        domain=NonNegativeReals,
        bounds=lambda model, t: (0.0, fz.laden_kw if fz.angesteckt[t] else 0.0),
    )
    m.fz_rueck = Var(
        m.T,
        domain=NonNegativeReals,
        bounds=lambda model, t: (0.0, fz.rueckspeisen_kw if fz.angesteckt[t] else 0.0),
    )
    m.fz_soc = Var(
        m.S, bounds=lambda model, s: (fz.untergrenze_kwh[s], fz.kapazitaet_kwh)
    )
    for s, kwh in enumerate(fz.stand_kwh):
        if kwh is not None:
            m.fz_soc[s].fix(kwh)
    m.fahrzeug_soc = Constraint(
        da,
        rule=lambda model, t: model.fz_soc[t + 1]
        == model.fz_soc[t] + (e * model.fz_laden[t] - model.fz_rueck[t] / e) * dt,
    )
    if fz.rueckspeisen_kw > 0.0:
        m.fz_laedt = Var(da, domain=Binary)
        m.fahrzeug_laden_gate = Constraint(
            da, rule=lambda model, t: model.fz_laden[t] <= fz.laden_kw * model.fz_laedt[t]
        )
        m.fahrzeug_rueck_gate = Constraint(
            da,
            rule=lambda model, t: model.fz_rueck[t]
            <= fz.rueckspeisen_kw * (1 - model.fz_laedt[t]),
        )
        if not fz.v2g:
            m.fahrzeug_nur_haus = Constraint(
                da,
                rule=lambda model, t: model.fz_rueck[t]
                <= fz.rueckspeisen_kw * model.is_importing[t],
            )
        tage = sorted({fz.tag_je_slot[t] for t in da})
        budget_kwh = fz.vollzyklen_je_tag * fz.kapazitaet_kwh
        m.fahrzeug_zyklenbudget = Constraint(
            tage,
            rule=lambda model, tag: sum(
                model.fz_rueck[t] * dt for t in da if fz.tag_je_slot[t] == tag
            )
            <= budget_kwh,
        )
    verschleiss_eur_kwh = fz.verschleiss_ct_je_kwh / 100.0
    return sum(
        verschleiss_eur_kwh * m.fz_rueck[t] * dt
        + EARLY_CHARGE_TIEBREAK_EUR_PER_KW * (t / max(n - 1, 1)) * m.fz_laden[t]
        for t in da
    )


def _add_mischbetrieb(m: ConcreteModel, inp: OptimizationInput):
    """Mischbetrieb (MiSpeL MP-10): zwei Ladewege, Speichervorrang, Farben.

    Die Buchung der Festlegung (Anlage 1, Formelsatz A1; A5 und A5-Variante
    rechnen die Saldierung gleich, A1 S. 45, S. 52) als Teil des Modells, in kW
    je Slot (Menge = Leistung * dt):

    - ``netz_laden`` = (1)¼ = MIN [ Z1NB¼ ; Z2V¼ ] (A1 S. 33): der Netzstrom im
      Speicher. Der Rest der Ladung ist der PV-Ladeweg (10) = (5) - (9).
    - ``speicher_einspeisung`` = (2)¼ = MIN [ Z1NE¼ ; Z2E¼ ] (A1 S. 34); die
      gruene Einspeisung ist (23)¼ = Z1NE¼ - (2)¼ (A1 S. 38).
    - ``rot_einspeisung`` traegt die saldierungsfaehige Netzeinspeisung (16) =
      MAX [ (13) - (15) ; 0 ] (A1 S. 36) ueber den Lauf: die
      Speicher-Einspeisung ueber der EE-Speichererzeugung (15) = (14) * (10) -
      gelb zuerst (gesicherte Zuordnung, T S. 38-39). (13) = (11) ohne
      Fremdtankstrom; der Start-Ladestand zaehlt als EE-Speichererzeugung.
      Mit Monatsstand (MP-11) rechnet :func:`_add_monatszustand` (16) je
      Saldierungsperiode statt ueber den Lauf.

    Beide MIN und das MAX sind EXAKT, nicht nur Schranken - der Solver darf
    weder Netzstrom im Speicher noch Speicher-Einspeisung kleinrechnen
    (Praemie auf Netzstrom, Speicherstrom als gruen), noch (16) gross rechnen:

    - MIN: die Obergrenzen (MIN <= jedes Glied) plus die Planungsgrenze
      ``mischbetrieb_abregelung`` - abgeregelt wird hoechstens bis auf die
      Last, die PV deckt die Last zuerst (Speichervorrang). Mit dem
      Ueberschuss U = MAX [ pv - Last ; 0 ] sind dann (1)¼ >= Ladung - U +
      Abregelung und (2)¼ >= Einspeisung - U + Abregelung exakt, ohne
      Ganzzahl. Was die Grenze kostet, ist allein das Beziehen der LAST zum
      negativen Bezugspreis; Laden aus dem Netz bleibt dort moeglich. (Frei
      unter die Last abzuregeln - mit oder ohne Ganzzahl je Slot - machte das
      Modell an Tagen mit negativem Bezugspreis minutenlang.)
    - MAX: bringt Rot in einem Slot mehr als Gelb (Gutschrift / eta >
      Praemie), moechte der Solver (16) gross rechnen - dann bekommt das MAX
      eine Ganzzahl je Lauf (``saldierung_aktiv``); sonst reicht die
      Untergrenze.

    Zielfunktion: gruen und gelb tragen die Praemie (``mispel_praemie``), rot
    nicht; rot entlastet die Netzentnahme um (16) + (19) = (16) / (14)
    (privilegierungsfaehige Verluste, A1 S. 36-37) zu den saldierten
    Bestandteilen. Gibt diesen Term (EUR, negativ = Ertrag) zurueck.
    """
    p = inp.battery
    n = inp.slots
    dt = inp.slot_hours
    eta_rt = _wirkungsgrad_14(inp)
    praemie = inp.mispel_praemie_eur_mwh or [0.0] * n
    gutschrift_eur_mwh = _gutschrift_eur_mwh(inp)
    rot_lohnt = any(praemie[t] < gutschrift_eur_mwh for t in range(n))
    ueberschuss = [max(inp.pv_kw[t] - inp.load_kw[t], 0.0) for t in range(n)]
    z2v_max, z2e_max = _z2_max_kw(inp)

    m.netz_laden = Var(m.T, domain=NonNegativeReals, bounds=(0.0, z2v_max))
    m.speicher_einspeisung = Var(
        m.T, domain=NonNegativeReals, bounds=(0.0, z2e_max)
    )
    m.rot_einspeisung = Var(
        m.T, domain=NonNegativeReals, bounds=(0.0, z2e_max)
    )
    m.mischbetrieb_netzladen = Constraint(
        m.T,
        ["bezug", "laden"],
        rule=lambda model, t, glied: model.netz_laden[t]
        <= (model.grid_import[t] if glied == "bezug" else _z2v(model, t)),
    )
    m.mischbetrieb_einspeisung = Constraint(
        m.T,
        ["export", "entladen"],
        rule=lambda model, t, glied: model.speicher_einspeisung[t]
        <= (model.grid_export[t] if glied == "export" else _z2e(model, t)),
    )
    # Planungsgrenze: die Abregelung bleibt im PV-Ueberschuss ueber der Last.
    # Dann deckt die PV nach Abregelung die Last immer ganz, und die
    # Untergrenzen der beiden MIN sind linear und exakt.
    m.mischbetrieb_abregelung = Constraint(
        m.T, rule=lambda model, t: model.curtail[t] <= ueberschuss[t]
    )
    m.mischbetrieb_vorrang = Constraint(
        m.T,
        ["laden", "einspeisen"],
        rule=lambda model, t, glied: (
            model.netz_laden[t]
            >= _z2v(model, t) - ueberschuss[t] + model.curtail[t]
        )
        if glied == "laden"
        else (
            model.speicher_einspeisung[t]
            >= model.grid_export[t] - ueberschuss[t] + model.curtail[t]
        ),
    )
    m.mischbetrieb_rot_aus_speicher = Constraint(
        m.T,
        rule=lambda model, t: model.rot_einspeisung[t]
        <= model.speicher_einspeisung[t],
    )
    if inp.mispel_monatsstand is not None:
        return _add_monatszustand(m, inp, praemie, gutschrift_eur_mwh)

    # (16) = MAX [ (13) - (15) ; 0 ] ueber den Lauf, in kWh.
    soc0 = p.clamp_soc_kwh(inp.initial_soc_kwh)
    start_gelb = p.one_way_efficiency * max(soc0 - p.soc_floor_kwh(soc0), 0.0)
    if inp.battery_held or inp.soc_unbekannt:
        start_gelb = 0.0
    einspeisung_kwh = sum(m.speicher_einspeisung[t] * dt for t in m.T)
    gelb_kwh = start_gelb + eta_rt * sum(
        (_z2v(m, t) - m.netz_laden[t]) * dt for t in m.T
    )
    rot_kwh = sum(m.rot_einspeisung[t] * dt for t in m.T)
    m.mischbetrieb_saldierung = ConstraintList()
    m.mischbetrieb_saldierung.add(rot_kwh >= einspeisung_kwh - gelb_kwh)
    if rot_lohnt:
        big_m = start_gelb + n * dt * (eta_rt * z2v_max + z2e_max)
        m.saldierung_aktiv = Var(domain=Binary)
        m.mischbetrieb_saldierung.add(
            rot_kwh <= einspeisung_kwh - gelb_kwh + big_m * (1 - m.saldierung_aktiv)
        )
        m.mischbetrieb_saldierung.add(rot_kwh <= big_m * m.saldierung_aktiv)

    return -sum(
        praemie[t] * (m.grid_export[t] - m.rot_einspeisung[t]) * dt / 1000.0
        for t in m.T
    ) - gutschrift_eur_mwh / 1000.0 * rot_kwh


def _add_monatszustand(m: ConcreteModel, inp: OptimizationInput, praemie, gutschrift_eur_mwh):
    """Mischbetrieb II (MiSpeL MP-11): (16) je Saldierungsperiode mit dem
    Monatszustand.

    Die Saldierung rechnet je Kalendermonat (A1 S. 33-36) bzw. Rumpfmonat (A1
    S. 102). Je Periode k des Horizonts bringt ``inp.mispel_monatsstand`` den
    Saldo D = (13) - (15) der bisherigen Mengen plus des geschaetzten
    Monatsrests (:class:`~voltpilot_optimization.domain.MispelMonatsstand`);
    der Lauf fuegt E = (13) (Speicher-Einspeisung) und G = (15) =
    (14) * (10) (PV-Ladeweg) seiner Slots in k hinzu:

        (16)_k = MAX [ D + E - G ; 0 ]                       (A1 S. 36)

    Daraus folgt der Schattenpreis der gesicherten Zuordnung (T S. 38-39):
    liegt die Periode im Roten (D + E - G > 0), ist jede weitere rote kWh
    saldiert (Gutschrift) und jede PV-geladene kWh mindert (16) um (14) - die
    EE-Speichererzeugung wird zuerst der Netzeinspeisung zugeordnet; liegt sie
    im Gelben, ist eine weitere rote kWh nichts wert. „Mittags ins Netz
    entladen, mit PV nachfuellen“ aendert (16) darum nie (E und G wachsen
    gleich) und kostet nur die Verluste.

    Buchung: (16)_k = MAX [ D ; 0 ] + Σ ``rot_einspeisung`` - ``mispel_entrot``
    - rot ist der Teil der Speicher-Einspeisung des Laufs, der (16) erhoeht;
    ``mispel_entrot`` <= MAX [ D ; 0 ] die rote Menge ausserhalb des Horizonts,
    die die EE-Speichererzeugung des Laufs gelb macht (sie traegt die
    mittlere Praemie der Periode im Horizont statt der Gutschrift). Das MAX
    ist exakt: die Untergrenze immer; die Obergrenze, wenn Rot in einem Slot
    der Periode mehr bringt als Gelb - als Gleichung, wenn der Lauf das
    Vorzeichen von D + E - G nicht drehen kann, sonst mit einer Ganzzahl je
    Periode (``saldierung_monat_aktiv``).

    Abweichung (im Plan, nicht im Nachweis): (14) ist wie in MP-10 der
    Wirkungsgrad der Batterie statt (14)A1 = (6) / (5) des Monats (A1 S. 35) -
    der Quotient ist erst am Monatsende bestimmt.
    """
    dt = inp.slot_hours
    eta_rt = _wirkungsgrad_14(inp)
    z2v_max, z2e_max = _z2_max_kw(inp)
    perioden = [
        (stand, [t for t in range(inp.slots) if stand.enthaelt(inp.slot_starts[t])])
        for stand in inp.mispel_monatsstand
    ]
    perioden = [(stand, ts) for stand, ts in perioden if ts]
    m.MP = RangeSet(0, len(perioden) - 1)
    # Mutable: der Rueckfall nach der Zeitgrenze plant ohne Gutschrift.
    m.mispel_gutschrift = Param(initialize=gutschrift_eur_mwh, mutable=True)
    m.mispel_entrot = Var(
        m.MP,
        domain=NonNegativeReals,
        bounds=lambda model, k: (0.0, max(perioden[k][0].saldo_kwh, 0.0)),
    )
    m.mischbetrieb_monat_saldierung = ConstraintList()
    m.mischbetrieb_monat_max = ConstraintList()
    binaer = []
    term = 0.0
    for k, (stand, ts) in enumerate(perioden):
        d = stand.saldo_kwh
        einspeisung_kwh = sum(m.speicher_einspeisung[t] * dt for t in ts)
        gelb_kwh = eta_rt * sum((_z2v(m, t) - m.netz_laden[t]) * dt for t in ts)
        rot_kwh = sum(m.rot_einspeisung[t] * dt for t in ts)
        saldierung = max(d, 0.0) + rot_kwh - m.mispel_entrot[k]
        linear = d + einspeisung_kwh - gelb_kwh
        m.mischbetrieb_monat_saldierung.add(saldierung >= linear)
        gelb_max = eta_rt * z2v_max * dt * len(ts)
        rot_max = z2e_max * dt * len(ts)
        if any(praemie[t] < gutschrift_eur_mwh for t in ts):
            if d - gelb_max >= 0.0:
                m.mischbetrieb_monat_max.add(saldierung <= linear)
            elif d + rot_max <= 0.0:
                m.mischbetrieb_monat_max.add(saldierung <= 0.0)
            else:
                binaer.append((k, abs(d) + gelb_max + rot_max, saldierung, linear))
        praemie_mittel = sum(praemie[t] for t in ts) / len(ts)
        term = term - (
            m.mispel_gutschrift * (rot_kwh - m.mispel_entrot[k])
            + praemie_mittel * m.mispel_entrot[k]
        ) / 1000.0
    if binaer:
        m.saldierung_monat_aktiv = Var([k for k, *_ in binaer], domain=Binary)
        for k, big_m, saldierung, linear in binaer:
            b = m.saldierung_monat_aktiv[k]
            m.mischbetrieb_monat_max.add(saldierung <= linear + big_m * (1 - b))
            m.mischbetrieb_monat_max.add(saldierung <= big_m * b)

    return term - sum(
        praemie[t] * (m.grid_export[t] - m.rot_einspeisung[t]) * dt / 1000.0
        for t in m.T
    )


def _add_jahreszustand(m: ConcreteModel, inp: OptimizationInput):
    """Pauschaloption (MiSpeL MP-26): der Wert der naechsten eingespeisten
    kWh je nach Jahresstand.

    Die gesamte Netzeinspeisung eines Kalenderjahres bzw. Rumpfjahres wird
    pauschal eingeordnet (A2 S. 9-10, Abb. 1): bis (P1) grundsaetzlich
    foerderfaehig, zwischen (P1) und (P4) indifferent, darueber grundsaetzlich
    saldierungsfaehig - saldiert nur in SP≥0-Zeiten und hoechstens bis zum
    Jahres-Netzbezug. Je Zeitraum k des Horizonts bringt
    ``inp.mispel_jahresstand`` die Grenzen und die ∑J-Summen ausserhalb des
    Horizonts (:class:`~voltpilot_optimization.domain.MispelJahresstand`);
    der Lauf fuegt seine Slots in k hinzu - Z1NE¼ = ``grid_export``, Z1NB¼ =
    ``grid_import`` (ein Zaehler am Netzanschluss, A2 S. 27):

        (P15) = MIN [ (P14) ; (P1) ]                          (A2 S. 32-33)
        (P8)  = MAX [ (P7) - (P4) ; 0 ]                       (A2 S. 30)
        (P10) = MIN [ (P8) ; (P9) ]                           (A2 S. 31)

    mit (P14) = ∑J (P12)¼ • Z1NE¼ und (P7) = ∑J (P5)¼ • Z1NE¼. AW>0 liest der
    Plan aus der Praemie der Marktwertbasis (MP-12: > 0 nur in AW>0-Zeiten,
    Jahresmarktwert), SP≥0 aus dem Spot des Slots.

    - **Foerderseite** - ``pauschal_foerderfaehig`` ist die Einspeisung eines
      Slots, die die Praemie traegt; je Zeitraum hoechstens MAX [ (P1) -
      (P14) ; 0 ] ausserhalb des Horizonts. Das MIN ist ohne Ganzzahl exakt:
      die Praemie belohnt die Menge, die Grenze haelt sie. Innerhalb eines
      Zeitraums ist die Praemie je kWh gleich (anzulegender Wert minus
      Jahresmarktwert, A2 S. 20), also ist das die Praemie auf (P15).
    - **Saldierungsseite** - ``pauschal_saldiert`` ist (P10) des Zeitraums
      mit den Mengen des Laufs: <= (P9) und <= (P8). Das MAX in (P8) ist
      exakt als Gleichung, wenn der Lauf die Seite von (P4) nicht wechseln
      kann (schon darueber bzw. unerreichbar), sonst mit einer Ganzzahl je
      Zeitraum (``saldierung_jahr_aktiv``). Ist (P8) > (P9), entlastet jede
      weitere bezogene kWh (P11) = (P9) - (P10) - die Saldierung „bis zur
      Jahres-Netzentnahme“ wirkt dann auf den Bezug.

    Die Gutschrift ist ``saldierte_bestandteile_eur_mwh`` OHNE Wirkungsgrad:
    die Pauschaloption kennt keine Privilegierung von Speicherverlusten (A2
    S. 8 Fn. 5, § 21 Abs. 4a EnFG). Gibt den Term (EUR, negativ = Ertrag)
    zurueck - nur der Zuwachs durch den Lauf, die Werte ohne ihn sind fest.
    """
    dt = inp.slot_hours
    n = inp.slots
    praemie = inp.mispel_praemie_eur_mwh or [0.0] * n
    gutschrift_eur_mwh = inp.saldierte_bestandteile_eur_mwh
    zeitraeume = [
        (stand, [t for t in range(n) if stand.enthaelt(inp.slot_starts[t])])
        for stand in inp.mispel_jahresstand
    ]
    zeitraeume = [(stand, ts) for stand, ts in zeitraeume if ts]
    m.MJ = RangeSet(0, len(zeitraeume) - 1)
    m.pauschal_foerderfaehig = Var(
        m.T,
        domain=NonNegativeReals,
        bounds=lambda model, t: (0.0, model.grid_export[t].ub if praemie[t] > 0.0 else 0.0),
    )
    m.pauschal_foerderfaehig_einspeisung = Constraint(
        m.T, rule=lambda model, t: model.pauschal_foerderfaehig[t] <= model.grid_export[t]
    )
    m.pauschal_foerdergrenze = Constraint(
        m.MJ,
        rule=lambda model, k: sum(model.pauschal_foerderfaehig[t] * dt for t in zeitraeume[k][1])
        <= max(zeitraeume[k][0].p1_kwh - zeitraeume[k][0].p14_kwh, 0.0),
    )
    term = -sum(praemie[t] * m.pauschal_foerderfaehig[t] * dt / 1000.0 for t in m.T)
    if gutschrift_eur_mwh <= 0.0:
        return term

    def _p8_max(ts):
        return sum(m.grid_export[t].ub * dt for t in ts if inp.prices_eur_mwh[t] >= 0.0)

    def _p9_max(ts):
        return sum(m.grid_import[t].ub * dt for t in ts)

    m.pauschal_saldiert = Var(
        m.MJ,
        domain=NonNegativeReals,
        bounds=lambda model, k: (
            0.0,
            min(
                zeitraeume[k][0].p9_kwh + _p9_max(zeitraeume[k][1]),
                max(zeitraeume[k][0].p7_kwh + _p8_max(zeitraeume[k][1]) - zeitraeume[k][0].p4_kwh, 0.0),
            ),
        ),
    )
    m.pauschal_saldierung = ConstraintList()
    binaer = []
    for k, (stand, ts) in enumerate(zeitraeume):
        s = m.pauschal_saldiert[k]
        p7 = stand.p7_kwh + sum(
            m.grid_export[t] * dt for t in ts if inp.prices_eur_mwh[t] >= 0.0
        )
        p9 = stand.p9_kwh + sum(m.grid_import[t] * dt for t in ts)
        m.pauschal_saldierung.add(s <= p9)
        if stand.p7_kwh >= stand.p4_kwh:
            m.pauschal_saldierung.add(s <= p7 - stand.p4_kwh)
        elif stand.p7_kwh + _p8_max(ts) <= stand.p4_kwh:
            m.pauschal_saldierung.add(s <= 0.0)
        else:
            big_m = s.ub + stand.p4_kwh - stand.p7_kwh
            binaer.append((k, big_m, s, p7 - stand.p4_kwh))
        ohne_lauf = min(max(stand.p7_kwh - stand.p4_kwh, 0.0), stand.p9_kwh)
        term = term - gutschrift_eur_mwh * (s - ohne_lauf) / 1000.0
    if binaer:
        m.saldierung_jahr_aktiv = Var([k for k, *_ in binaer], domain=Binary)
        for k, big_m, s, p8 in binaer:
            b = m.saldierung_jahr_aktiv[k]
            m.pauschal_saldierung.add(s <= p8 + big_m * (1 - b))
            m.pauschal_saldierung.add(s <= big_m * b)
    return term


def _add_verbund(m: ConcreteModel, inp: OptimizationInput, enforce_grid_limit: bool):
    """Die Anteile der mitsteuernden Boxen als Nebenbedingung (AP-15 IP-14, P4).

    Regeln und Lesarten stehen in :mod:`voltpilot_optimization.verbund`. Im
    Modell: die Abregelung teilt sich in den Rest (die Erzeuger der fuehrenden
    Box) und je mitsteuernder Box ihren Teil ``curtail_box``; je Box und Slot

    - ``verbund_einspeisung``: PV der Box - ihre Abregelung (+ Entladung, wenn
      der geplante Speicher an ihr haengt) <= Einspeise-Anteil (V6),
    - ``verbund_bezug``: Netzladen des Speichers an ihr = Ladung - eigene PV
      <= Bezugs-Anteil (V3, nur mit Speicher an der Box - v1 kennt keine
      steuerbaren Verbraucher),
    - stumm (Y4/B5): ihre PV laeuft ungeplant bis zum Anteil (die Abregelung ist
      eine feste Schranke, kein Kommando), und die Anschlussgrenzen der Anlage
      sind um ihren vollen Anteil enger (``verbund_stumm_einspeisung``/
      ``verbund_stumm_bezug``) - der ungenutzte Rest geht an niemanden (R7).

    Gibt den Gleichstand-Brecher der Zielfunktion zurueck.
    """
    boxen = inp.verbund
    B = range(len(boxen))
    aktiv = [b for b in B if not boxen[b].stumm]
    stumm = [b for b in B if boxen[b].stumm]

    def _curtail_box_bounds(model, b, t):
        box = boxen[b]
        pv = max(box.pv_kw[t], 0.0)
        if box.stumm:
            # ohne Einspeise-Anteil (ausdruecklich unbegrenzt) laeuft ihre PV frei
            fest = 0.0 if box.einspeisung_unbegrenzt else max(pv - box.einspeisung_kw, 0.0)
            return (fest, fest)
        return (0.0, pv)

    m.curtail_box = Var(B, m.T, domain=NonNegativeReals, bounds=_curtail_box_bounds)
    pv_rest = [
        max(max(inp.pv_kw[t], 0.0) - sum(max(box.pv_kw[t], 0.0) for box in boxen), 0.0)
        for t in range(inp.slots)
    ]
    m.curtail_rest = Var(
        m.T, domain=NonNegativeReals, bounds=lambda model, t: (0.0, pv_rest[t])
    )
    m.verbund_abregeln = Constraint(
        m.T,
        rule=lambda model, t: model.curtail[t]
        == model.curtail_rest[t] + sum(model.curtail_box[b, t] for b in B),
    )

    def _speicher_an(b: int) -> bool:
        return inp.device_id is not None and boxen[b].device_id == inp.device_id

    if aktiv:
        # nur Boxen MIT Einspeise-Anteil; ausdruecklich unbegrenzt = keine Schranke
        aktiv_e = [b for b in aktiv if not boxen[b].einspeisung_unbegrenzt]
        if aktiv_e:
            m.verbund_einspeisung = Constraint(
                aktiv_e,
                m.T,
                rule=lambda model, b, t: max(boxen[b].pv_kw[t], 0.0)
                - model.curtail_box[b, t]
                + (model.discharge[t] if _speicher_an(b) else 0.0)
                <= boxen[b].einspeisung_kw,
            )
        mit_speicher = [b for b in aktiv if _speicher_an(b)]
        if mit_speicher:
            m.verbund_bezug = Constraint(
                mit_speicher,
                m.T,
                rule=lambda model, b, t: model.charge[t]
                - (max(boxen[b].pv_kw[t], 0.0) - model.curtail_box[b, t])
                <= boxen[b].bezug_kw,
            )
    if stumm:
        # Was eine stumme Box ins Netz schieben KOENNTE, ueber das hinaus, was
        # ihre PV im Modell schon beitraegt: ihr voller Einspeise-Anteil.
        reserve_e = [
            sum(
                boxen[b].einspeisung_kw
                - min(max(boxen[b].pv_kw[t], 0.0), boxen[b].einspeisung_kw)
                for b in stumm
                if not boxen[b].einspeisung_unbegrenzt
            )
            for t in range(inp.slots)
        ]
        caps_e = [c for c in (inp.max_feed_in_kw,) if c is not None]
        if enforce_grid_limit and inp.grid_limit_kw is not None:
            caps_e.append(inp.grid_limit_kw)
        if caps_e:
            cap_e = min(caps_e)
            m.verbund_stumm_einspeisung = Constraint(
                m.T,
                rule=lambda model, t: model.grid_export[t]
                <= max(cap_e - reserve_e[t], 0.0),
            )
        if enforce_grid_limit and inp.grid_limit_kw is not None:
            reserve_b = sum(boxen[b].bezug_kw for b in stumm)
            m.verbund_stumm_bezug = Constraint(
                m.T,
                rule=lambda model, t: model.grid_import[t]
                <= max(inp.grid_limit_kw - reserve_b, 0.0),
            )
    return VERBUND_CURTAIL_TIEBREAK_EUR_PER_KW * sum(
        m.curtail_box[b, t] for b in B for t in m.T
    )


def _add_night_reserve(
    m: ConcreteModel, inp: OptimizationInput, soc_floor: float
) -> NightReserveTerms | None:
    """The NIGHT VALUE FUNCTION (P3, Konzept vp-nachtreserve-konzept-k2 §3):
    price the charge left at SUNRISE against the site's OWN night-error
    distribution, and add that price to the objective.

    The whole point of the shape is that it is NOT a reserve: nothing is
    forbidden, no floor moves, no minimum spread is imposed. The plan simply
    learns what an empty battery at 03:00 costs in the cases its own history
    says are plausible - ``Preisabstand mal Fehlerwahrscheinlichkeit`` - and
    then sells exactly as much as that price still justifies. The marginal rule
    it implements is the newsvendor one:
    ``p_sale - wear > v_left + (p_imp - v_left) * P(eps > slack)``.

    Structurally it costs the model ONE epigraph per quantile over ONE node
    (``soc[i1]``): no scenario tree, no second SoC path, and above all NO
    influence on the running slot's setpoint - a value on the sunrise node can
    only change HOW MUCH is sold tonight, never the ramp of the quarter hour
    that is already executing.

    Returns the terms it used (stashed on the model for the explain layer), or
    ``None`` when no term was built - the byte-identical case, which is the
    normal one for a young site, a flat night price, a winter horizon without a
    sunrise, and for every caller that builds its own inputs.
    """
    stash_night_reserve(m, None)
    if inp.night_error_quantiles is None or not night_reserve_enabled():
        return None
    # A battery an ACTIVE customer rule claims is not the plan's to command
    # (Steuerung Stufe 3): its power bounds are 0, so the SoC path is flat and
    # the term could only add a constant to the objective - but the explanation
    # would then claim the PLAN holds that charge for the night, when in truth
    # the rule holds it. The customer rule wins, and it also gets the credit.
    if inp.battery_held:
        return None
    # P7: dieselbe Logik fuer einen Lauf OHNE Ladestand. Die Wertfunktion
    # bepreist den Ladestand bei SONNENAUFGANG - ohne Anfangs-Ladestand gibt es
    # keinen Pfad dorthin, den sie bewerten koennte, und der Term wuerde nur
    # eine Konstante addieren, deren Erklaerung ("haelt X kWh fuer die Nacht")
    # eine Menge behauptet, die niemand kennt.
    if inp.soc_unbekannt:
        return None
    terms = night_reserve_terms(
        load_kw=inp.load_kw,
        pv_kw=inp.pv_kw,
        import_price_eur_mwh=inp.import_prices,
        export_value_eur_mwh=inp.export_values,
        slot_hours=inp.slot_hours,
        one_way_efficiency=inp.battery.one_way_efficiency,
        soc_floor_kwh=soc_floor,
        errors=inp.night_error_quantiles,
    )
    if terms is None:
        return None
    K = terms.levels
    levels = terms.levels_kwh
    coefficients = terms.coefficients_eur_kwh
    i1 = terms.i1
    m.vf_s = Var(RangeSet(1, K), domain=NonNegativeReals)
    m.vf_c = Constraint(
        RangeSet(1, K),
        rule=lambda model, k: model.vf_s[k]
        >= levels[k - 1] - (model.soc[i1] - soc_floor),
    )
    m.total_cost.set_value(
        m.total_cost.expr
        + sum(coefficients[k - 1] * m.vf_s[k] for k in range(1, K + 1))
    )
    stash_night_reserve(m, terms)
    return terms



def optimize(
    inp: OptimizationInput,
    plan_id: UUID,
    generated_at: datetime,
    explain_plan: bool = True,
) -> SchedulePlan:
    """Solve the dispatch MILP and assemble the resulting :class:`SchedulePlan`.

    Raises :class:`InfeasiblePlanError` when no feasible dispatch exists (the
    engine then retries without the grid-limit constraint - the physical §14a
    limit is enforced by the grid operator and the edge guards regardless, and
    an advisory plan is better than none).

    ``explain_plan`` gates the post-hoc Fahrplan-Warum extraction (see
    :func:`_with_explanation`); high-volume callers that discard the plan's
    presentation fields (the Ersparnis-Simulation's year chains) pass False.
    """
    model = build_model(inp)
    _solve_plan(model, inp)
    plan = _extract_plan(model, inp, plan_id, generated_at)
    if not explain_plan:
        return plan
    return _with_explanation(plan, model, inp, fallback_14a=False)


def optimize_mit_rueckfall(
    inp: OptimizationInput, plan_id: UUID, generated_at: datetime
) -> tuple[SchedulePlan, str | None]:
    """MiSpeL MP-33c: :func:`optimize` ohne Erklaerung, dazu der Rueckfall des
    Mischbetriebs - ``None``, ``"knotengrenze"`` oder ``"zeitgrenze"`` (siehe
    :func:`_solve_plan`). Der MiSpeL-Check schreibt ihn in ``hinweis``, statt
    still einen anderen Betrag zu liefern."""
    model = build_model(inp)
    rueckfall = _solve_plan(model, inp)
    return _extract_plan(model, inp, plan_id, generated_at), rueckfall


def optimize_ignoring_grid_limit(
    inp: OptimizationInput,
    plan_id: UUID,
    generated_at: datetime,
    explain_plan: bool = True,
) -> SchedulePlan:
    """Fallback solve with the §14a cap dropped (see :func:`optimize`)."""
    model = build_model(inp, enforce_grid_limit=False)
    _solve_plan(model, inp)
    plan = _extract_plan(model, inp, plan_id, generated_at)
    if not explain_plan:
        return plan
    return _with_explanation(plan, model, inp, fallback_14a=True)


def _with_explanation(
    plan: SchedulePlan,
    model: ConcreteModel,
    inp: OptimizationInput,
    fallback_14a: bool,
) -> SchedulePlan:
    """Stamp the per-slot Fahrplan-Warum facts onto an ALREADY-EXTRACTED plan.

    Safety contract (design scout vp-fahrplan-why-design): the explain layer's
    LP re-solve MUTATES the model (binaries fixed + relaxed), so it runs
    strictly AFTER :func:`_extract_plan` - the committed setpoints are fully
    extracted before anything touches the model, and nothing here feeds back
    into them (purely additive dataclass fields). ANY failure (and a garbage
    ``OPTIMIZER_EXPLAIN_ENABLED`` value) only warn-logs and returns the plan
    unchanged - the why-layer degrades, the plan never sinks.
    """
    try:
        from voltpilot_optimization.config import (
            explain_enabled,
            limit_discharge_enabled,
            load_follow_enabled,
            slot_trim_enabled,
            surplus_charge_enabled,
            unplanned_load_discharge_enabled,
        )

        if not explain_enabled():
            return plan
        from voltpilot_optimization.explain import explain

        whys = explain(model, inp, fallback_14a=fallback_14a)
        trim = slot_trim_enabled()
        follow = load_follow_enabled()
        absorb = surplus_charge_enabled()
        unforeseen = unplanned_load_discharge_enabled()
        limiting = limit_discharge_enabled()
        # P7 - der Punkt, an dem "Ruhe" sonst keine Ruhe waere. Die fuenf
        # In-Slot-Vollmachten sind VOLLMACHTEN, keine Sollwerte: sie erlauben
        # der Box, in der laufenden Viertelstunde von den 0 kW abzuweichen und
        # gegen GEMESSENE Werte zu laden oder zu entladen
        # (`unplanned_load_discharge` zielt sogar ausdruecklich auf einen
        # RUHENDEN Slot). Ein Lauf ohne Ladestand darf sie nicht erteilen: die
        # Cloud kennt den Fuellstand nicht, gegen den die Box sie ausfuehren
        # wuerde, und die Box hat auf so einer Anlage aus demselben Grund
        # keinen eigenen Wert zum Nachhalten. Alle fuenf entfallen also - im
        # Kontrakt heisst ein abwesendes Feld "keine Pflicht", die Box faehrt
        # den Sollwert 0 starr, und der Speicher ruht wirklich.
        if inp.soc_unbekannt:
            trim = follow = absorb = unforeseen = limiting = False
        slots = [
            replace(
                slot,
                slot_role=why.slot_role,
                slot_flags=why.slot_flags,
                stored_value_ct_kwh=why.stored_value_ct_kwh,
                grid_value_ct_kwh=why.grid_value_ct_kwh,
                peak_pressure_eur_kw=why.peak_pressure_eur_kw,
                # The price-aware in-slot trim duty rides along on the SAME
                # persisted lambda (voltpilot_optimization.slot_trim): the cloud
                # decides whether topping this slot's charge up from the grid is
                # economic, the edge only enforces it against measured values.
                charge_from_surplus_only=(
                    _charge_from_surplus_only(inp, t, slot, why) if trim else None
                ),
                # The DISCHARGE-side mirror (in-slot load following): may the
                # edge raise this slot's discharge to the MEASURED house deficit
                # rather than execute the forecast watt value? Same lambda, same
                # split of authority - its own kill-switch because the two duties
                # push the setpoint in opposite directions.
                cover_load_from_battery=(
                    _cover_load_from_battery(inp, t, slot, why) if follow else None
                ),
                unplanned_load_discharge=(
                    _unplanned_load_discharge(inp, t, slot, why)
                    if unforeseen
                    else None
                ),
                # The REDUCE-only right, from the plan's own shape alone (no
                # lambda, no price): on a discharging "Netz = 0" slot the edge
                # may LIMIT the discharge to the measured deficit even where the
                # economic duty above is silent - which on a fixed-tariff site
                # is exactly when the battery gets scarce. Its own kill-switch
                # because it widens the edge's authority without an economic
                # test.
                limit_discharge_to_load=(
                    _limit_discharge_to_load(inp, t, slot, why) if limiting else None
                ),
                # The CHARGE-side counterpart that RAISES (2026-08-02): storing
                # one more kWh beats selling it here, so the edge may charge the
                # MEASURED surplus the 15-min PV forecast never saw. Same lambda
                # again; its own kill-switch because it is the only one of the
                # three duties that raises a charge.
                charge_surplus_to_battery=(
                    _charge_surplus_to_battery(inp, t, slot, why) if absorb else None
                ),
                # Erklaerbarkeit Stufe 1 (§4.2 C): what a RESTING slot rejected
                # and by how much - pure presentation, never an input to a
                # setpoint.
                why_next_best=why.next_best,
                why_next_best_margin_ct=why.next_best_margin_ct,
            )
            for t, (slot, why) in enumerate(zip(plan.slots, whys))
        ]
        # Erklaerbarkeit Stufe 1 (§4.2 A/B): the run-level origin of the
        # stored-energy value. It comes from the SAME derivation the objective
        # credited above (effective_terminal_value), so the explanation can
        # never describe a different number than the one that decided.
        tv = inp.effective_terminal_value()
        return replace(
            plan,
            slots=slots,
            fallback_14a=fallback_14a,
            why_terminal_anchor=tv.anchor_kind,
            why_refill_free_pct=(
                None if tv.refill_free_pct is None else round(tv.refill_free_pct, 1)
            ),
            # P3c: what the night value function held back, and how often that
            # much is actually needed. Read off the SOLVED plan (not the
            # intention), so a run whose economics rejected every step honestly
            # reports nothing.
            why_night_reserve=_night_reserve_fact(plan, model),
        )
    except Exception:
        logger.warning(
            "explain.failed - plan returned without why-fields",
            extra={"context": {"site_id": str(plan.site_id), "plan_id": str(plan.plan_id)}},
            exc_info=True,
        )
        return plan


def _night_reserve_fact(plan: SchedulePlan, model: ConcreteModel) -> dict | None:
    """The run-level night-reserve fact (P3c), or ``None`` when there is
    nothing established to say.

    ``held_kwh``/``held_q`` are the plan's OWN outcome - the highest step its
    sunrise charge actually covers - and they are what a customer surface may
    turn into a sentence ("hält bis zu X kWh … in 1 von N Nächten nötig"). The
    remaining keys are the derivation behind it, for the admin readout: the
    sunrise slot, all steps with their quantiles, and the price spread that
    justified them at all. A run that held nothing above the floor reports
    ``None`` rather than a step it did not reach.
    """
    terms = night_reserve_of(model)
    if terms is None or not plan.slots:
        return None
    # soc[i1] is the SoC at the END of slot i1-1 - the plan slot list is
    # end-of-slot too, so the sunrise node is slots[i1 - 1].
    held = held_level(terms, plan.slots[terms.i1 - 1].soc_kwh)
    if held is None:
        return None
    held_kwh, held_q = held
    return {
        "sunrise": terms.i1,
        "levels_kwh": [round(x, 3) for x in terms.levels_kwh],
        "q": list(terms.q),
        "p_imp_ct": round(terms.p_imp_ct, 3),
        "v_left_ct": round(terms.v_left_ct, 3),
        "held_kwh": round(held_kwh, 3),
        "held_q": held_q,
    }


def _charge_from_surplus_only(inp: OptimizationInput, t: int, slot, why) -> bool:
    """The slot's price-aware trim duty (the ``charge_from_surplus_only``
    contract flag), from the plan's own numbers + the persisted lambda.

    Everything but the import price is read off the extracted slot itself
    (battery/pv/load/curtail) and its why-record (lambda), so the verdict can
    never describe a different slot than the one it is stamped on.
    """
    from voltpilot_optimization.slot_trim import charge_from_surplus_only

    p = inp.battery
    return charge_from_surplus_only(
        battery_kw=slot.battery_kw,
        pv_kw=slot.pv_kw,
        load_kw=slot.load_kw,
        curtail_kw=slot.curtail_kw,
        # EUR/MWh -> ct/kWh: the asymmetric IMPORT price (bare spot only when
        # the site carries no tariff), i.e. what a grid kWh really costs here.
        import_price_ct_kwh=inp.import_prices[t] / 10.0,
        stored_value_ct_kwh=why.stored_value_ct_kwh,
        # ct per AC kWh in ONE direction - the ct/kWh twin of
        # BatteryParams.wear_cost_eur_per_kwh_each_way (which is EUR).
        wear_ct_per_kwh_each_way=p.wear_cost_ct_per_kwh / 2.0,
        one_way_efficiency=p.one_way_efficiency,
        # E6 A: the SAME hurdle the LP priced on the grid-sourced charge - 0 on
        # a spot site, which keeps the old margin rule byte-identically.
        hurdle_ct_per_kwh=inp.grid_charge_hurdle_ct_kwh,
    )


def _cover_load_from_battery(inp: OptimizationInput, t: int, slot, why) -> bool:
    """The slot's in-slot load-following duty (the ``cover_load_from_battery``
    contract flag), from the plan's own numbers + the persisted lambda.

    Like its charge-side twin everything but the import price comes off the
    EXTRACTED slot (battery/grid) and its why-record (lambda), so the verdict can
    never describe a different slot than the one it is stamped on.
    """
    from voltpilot_optimization.slot_trim import cover_load_from_battery

    p = inp.battery
    return cover_load_from_battery(
        battery_kw=slot.battery_kw,
        # The SOLVED grid power of the slot: only the "Netz = 0" kink (role
        # eigenverbrauch, |grid_kw| within the deadband) may carry the duty. A
        # real planned IMPORT is a deliberate cheap-hour purchase and a real
        # planned EXPORT a deliberate sale - the bidirectional edge enforcement
        # would cut either back to zero grid, so both are excluded HERE, where
        # the plan's own grid power is known.
        grid_kw=slot.grid_kw,
        # EUR/MWh -> ct/kWh: the asymmetric IMPORT price (bare spot only when the
        # site carries no tariff), i.e. what the avoided grid kWh really costs.
        import_price_ct_kwh=inp.import_prices[t] / 10.0,
        stored_value_ct_kwh=why.stored_value_ct_kwh,
        wear_ct_per_kwh_each_way=p.wear_cost_ct_per_kwh / 2.0,
        one_way_efficiency=p.one_way_efficiency,
    )


def _limit_discharge_to_load(inp: OptimizationInput, t: int, slot, why) -> bool:
    """The slot's REDUCE-only right (the ``limit_discharge_to_load`` contract
    flag), from the plan's own numbers ALONE.

    Deliberately the only one of the four per-slot duties that reads NEITHER a
    price NOR the why-record's lambda: limiting a discharge to the measured
    house can never be uneconomic - it keeps energy the plan itself values above
    the export in a "Netz = 0" slot, otherwise the plan would have sold it here
    and the grid condition would refuse the flag. ``inp``/``t``/``why`` are kept
    in the signature so this helper reads and composes exactly like its three
    siblings; see :func:`voltpilot_optimization.slot_trim.limit_discharge_to_load`
    for the full argument.
    """
    from voltpilot_optimization.slot_trim import limit_discharge_to_load

    return limit_discharge_to_load(
        battery_kw=slot.battery_kw,
        # The SOLVED grid power of the slot - the same both-sided exclusion the
        # economic sibling makes, and for the same reason: a planned EXPORT is a
        # deliberate sale the edge would otherwise cut back to zero grid, a
        # planned IMPORT a deliberate cheap-hour purchase.
        grid_kw=slot.grid_kw,
    )


def _unplanned_load_discharge(inp: OptimizationInput, t: int, slot, why) -> bool:
    """The distinct idle-slot duty; never widens cover_load_from_battery."""
    from voltpilot_optimization.slot_trim import unplanned_load_discharge

    p = inp.battery
    return unplanned_load_discharge(
        battery_kw=slot.battery_kw,
        grid_kw=slot.grid_kw,
        # The opposite-direction duty is evaluated from the same slot/why
        # facts.  Never emit both grants even though the JSON schema remains
        # additive/permissive for forward compatibility.
        charge_surplus_to_battery=_charge_surplus_to_battery(inp, t, slot, why),
        import_price_ct_kwh=inp.import_prices[t] / 10.0,
        stored_value_ct_kwh=why.stored_value_ct_kwh,
        wear_ct_per_kwh_each_way=p.wear_cost_ct_per_kwh / 2.0,
        one_way_efficiency=p.one_way_efficiency,
    )


def _charge_surplus_to_battery(inp: OptimizationInput, t: int, slot, why) -> bool:
    """The slot's in-slot surplus-absorption duty (the
    ``charge_surplus_to_battery`` contract flag), from the plan's own numbers +
    the persisted lambda.

    Like its two siblings everything but the export value comes off the
    EXTRACTED slot (grid/curtail/SoC) and its why-record (lambda), so the verdict
    can never describe a different slot than the one it is stamped on.
    """
    from voltpilot_optimization.slot_trim import charge_surplus_to_battery

    p = inp.battery
    return charge_surplus_to_battery(
        # The SOLVED grid power + curtailment of the slot: a planned EXPORT is a
        # deliberate sale and is excluded (the P1b discipline), unless the slot
        # curtails - which already prefers not to export, so storing beats
        # discarding. A planned IMPORT is deliberately NOT excluded: the duty
        # only ever RAISES a charge up to the measured surplus (predicted grid
        # 0), so it can never touch a deliberate purchase - see
        # slot_trim.charge_surplus_to_battery for the full argument.
        grid_kw=slot.grid_kw,
        curtail_kw=slot.curtail_kw,
        # The plan's own SoC trajectory (slot END) against the usable ceiling:
        # an unfulfillable duty is never published.
        soc_kwh=slot.soc_kwh,
        soc_max_kwh=p.soc_max_kwh,
        # EUR/MWh -> ct/kWh: the asymmetric EXPORT value (bare spot only when the
        # site carries no remuneration), i.e. what feeding this kWh in really
        # fetches - negative when feeding in COSTS money.
        export_value_ct_kwh=inp.export_values[t] / 10.0,
        stored_value_ct_kwh=why.stored_value_ct_kwh,
        wear_ct_per_kwh_each_way=p.wear_cost_ct_per_kwh / 2.0,
        one_way_efficiency=p.one_way_efficiency,
    )


#: MiSpeL MP-10: die Zeitgrenze des Mischbetriebs mit Saldierungs-Ganzzahl in
#: Sekunden. Gemessen: 0,3-0,5 s an normalen Tagen; an Tagen mit NEGATIVEM
#: Bezugspreis kann der Zweig „(16) > 0“ (Gutschrift auf Netzstrom, der dort
#: ohnehin bezahlt geladen wird) minutenlang verzweigen. Dann plant der Lauf
#: ohne Gutschrift (``saldierung_aktiv`` = 0, 0,3 s) - vorsichtig: er
#: ueberschaetzt keinen Wert, er verschenkt hoechstens die Gutschrift dieses
#: einen Laufs. Eine WANDUHR: unter Last trifft sie andere Laeufe - richtig
#: fuer die Live-Planung (ein Plan muss rechtzeitig stehen), falsch fuer den
#: MiSpeL-Check (MP-33c, :data:`CHECK_KNOTENGRENZE`).
MISCHBETRIEB_ZEITGRENZE_S = 20.0

#: MiSpeL MP-33c: die Abbruchregel des naechtlichen MiSpeL-Checks
#: (``OptimizationInput.wiederholbar``) - HiGHS ``mip_max_nodes`` statt der
#: Wanduhr. HiGHS rechnet deterministisch: dieselbe Eingabe erreicht die
#: Grenze in jedem Lauf am selben Knoten oder nie, unabhaengig von der Last.
#: Gemessen (Kundentyp a, A1 mit Monatszustand, Preise 10/2025-09/2026, je
#: Tag ein Loesungslauf): hoechstens 122 Knoten, Median 3; die Zeit geht in
#: die Wurzel (bis 16 s bei wenigen Knoten), nicht in den Baum. Die Grenze
#: liegt sechzehnfach darueber - sie faengt nur den Fall, der „minutenlang
#: verzweigt“ (MP-10), und der rechnet dann ohne Gutschrift wie an der
#: Wanduhr, nur in jedem Lauf gleich. Klein genug, dass sie auch unter Last
#: vor der Notbremse :data:`CHECK_NOTBREMSE_S` greift.
CHECK_KNOTENGRENZE = 2_000

#: MiSpeL MP-33c: die Notbremse des Checks in Sekunden - nur gegen einen
#: Haenger, nie die Regel. Erreicht ein Loesungslauf sie, ist das Ergebnis
#: wieder lastabhaengig; der Check sagt es dann in ``hinweis``.
CHECK_NOTBREMSE_S = 900.0


class _Zeitgrenze(RuntimeError):
    """Der Solver hat die Zeit- oder (MP-33c) die Knotengrenze erreicht;
    ``art`` ist ``"zeitgrenze"`` oder ``"knotengrenze"``."""

    def __init__(self, art: str, message: str) -> None:
        super().__init__(message)
        self.art = art


def _grenzen(inp: OptimizationInput, zeitgrenze_s: float) -> dict:
    """MiSpeL MP-33c: die Grenzen eines Mischbetrieb-Loesungslaufs - live die
    Wanduhr ``zeitgrenze_s``, im Check (``wiederholbar``) die Knotengrenze
    und die Notbremse."""
    if inp.wiederholbar:
        return {"time_limit": CHECK_NOTBREMSE_S, "knoten": CHECK_KNOTENGRENZE}
    return {"time_limit": zeitgrenze_s}


def _solve_plan(model: ConcreteModel, inp: OptimizationInput) -> str | None:
    """Loest das Plan-Modell; im Mischbetrieb mit dem Rueckfall ohne Gutschrift
    (siehe :data:`MISCHBETRIEB_ZEITGRENZE_S`). Jedes andere Modell: wie immer.

    MP-33c: gibt den Rueckfall zurueck - ``None``, ``"knotengrenze"`` (nur
    mit ``wiederholbar``, in jedem Lauf gleich) oder ``"zeitgrenze"`` (die
    Wanduhr, lastabhaengig)."""
    if hasattr(model, "saldierung_monat_aktiv"):
        return _solve_plan_monatszustand(model, inp)
    if hasattr(model, "saldierung_jahr_aktiv"):
        return _solve_plan_jahreszustand(model, inp)
    if not hasattr(model, "saldierung_aktiv"):
        _solve(model)
        return None
    if hasattr(model, "fz_laden"):
        return _solve_plan_fahrzeug(model, inp)
    try:
        _solve(model, **_grenzen(inp, MISCHBETRIEB_ZEITGRENZE_S))
    except _Zeitgrenze as grenze:
        logger.warning(
            "mischbetrieb.saldierung_zeitgrenze",
            extra={
                "context": {
                    "site_id": str(inp.site_id),
                    "zeitgrenze_s": MISCHBETRIEB_ZEITGRENZE_S,
                    "grenze": grenze.art,
                    "reason": (
                        "Mischbetrieb mit Saldierung nicht in der Zeitgrenze "
                        "geloest - dieser Lauf plant ohne Gutschrift (16) = 0"
                    ),
                }
            },
        )
        model.saldierung_aktiv.fix(0)
        _solve(model)
        return grenze.art
    return None


#: MiSpeL MP-33b: Zeitgrenze des Teilproblems „mit Saldierung“ im Mischbetrieb
#: A3/A4 mit Fahrzeug, in Sekunden (siehe :func:`_solve_plan_fahrzeug`).
FAHRZEUG_SALDIERUNG_ZEITGRENZE_S = 8.0

#: MiSpeL MP-33b: HiGHS-Optionen nur fuer die beiden Teilprobleme mit Fahrzeug.
#: Gemessen an 192 Slots (A3/A4, mit und ohne PV, Lauf-Ganzzahl fest): 5-8 s je
#: Teilproblem statt 8-15 s mit der Vorgabe 0,05 - die Wurzelschranke ist dort
#: schon die Loesung, die Zeit geht in die Suche nach ihr.
FAHRZEUG_HIGHS_OPTIONEN = {"mip_heuristic_effort": 0.3}


def _solve_plan_fahrzeug(model: ConcreteModel, inp: OptimizationInput) -> str | None:
    """Mischbetrieb A3/A4 mit Fahrzeug (MP-33b): die Lauf-Ganzzahl
    ``saldierung_aktiv`` wird aufgezaehlt statt verzweigt.

    Gemessen (Bauplan MP-33b): mit freier Ganzzahl bleibt HiGHS bei 192 Slots
    60 s an der Wurzel haengen (Schranke -9,44 gegen das Optimum -6,84) - das
    MAX von (16) mit Big-M ueber den ganzen Lauf traegt in der
    Relaxation fast nichts. Mit fester Ganzzahl ist die Wurzelschranke der
    Teilprobleme (fast) die Loesung. Darum: erst ``saldierung_aktiv = 0`` (der
    Plan ohne Gutschrift, immer zulaessig - derselbe Rueckfall wie in MP-10),
    dann ``= 1`` mit :data:`FAHRZEUG_SALDIERUNG_ZEITGRENZE_S`. Das bessere
    Ergebnis gewinnt; bei Gleichstand der Plan ohne Gutschrift. Beide optimal
    = genau die Loesung des ganzen Modells (Minimum ueber beide Werte).

    Erreicht das zweite Teilproblem die Zeitgrenze, zaehlt sein bester
    zulaessiger Plan, wenn er besser ist als der ohne Gutschrift (Log
    ``mischbetrieb.fahrzeug_saldierung_zeitgrenze`` mit Luecke). Er ist ein
    zulaessiger Plan des ganzen Modells - (16) exakt gebucht -, also
    ueberschaetzt er keinen Wert; er ist nur nicht bewiesen optimal.

    MP-33c: mit ``wiederholbar`` die Knotengrenze statt der Wanduhr; der
    Rueckweg meldet die erreichte Grenze (auch wenn ihr Plan uebernommen ist).
    """
    model.saldierung_aktiv.fix(0)
    ohne, _, _ = _solve_teil(model)
    stand_ohne = [
        (var, var.value) for var in model.component_data_objects(Var) if not var.fixed
    ]
    model.saldierung_aktiv.fix(1)
    grenzen = _grenzen(inp, FAHRZEUG_SALDIERUNG_ZEITGRENZE_S)
    try:
        mit, luecke, grenze = _solve_teil(model, **grenzen)
    except InfeasiblePlanError:
        mit, luecke, grenze = None, None, None
    if luecke is not None:
        logger.warning(
            "mischbetrieb.fahrzeug_saldierung_zeitgrenze",
            extra={
                "context": {
                    "site_id": str(inp.site_id),
                    "zeitgrenze_s": FAHRZEUG_SALDIERUNG_ZEITGRENZE_S,
                    "grenze": grenze,
                    "luecke": luecke,
                    "uebernommen": mit is not None and mit < ohne,
                    "reason": (
                        "Mischbetrieb mit Fahrzeug: Teilproblem mit Saldierung "
                        "nicht in der Zeitgrenze bewiesen - bester zulaessiger "
                        "Plan, wenn besser als ohne Gutschrift"
                    ),
                }
            },
        )
    if mit is not None and mit < ohne:
        return grenze
    model.saldierung_aktiv.fix(0)
    for var, wert in stand_ohne:
        var.set_value(wert, skip_validation=True)
    return grenze


def _solve_teil(
    model: ConcreteModel, time_limit: float | None = None, knoten: int | None = None
) -> tuple[float | None, float | None, str | None]:
    """Ein Teilproblem von :func:`_solve_plan_fahrzeug`: ``(Zielwert, Luecke,
    Grenze)``. Luecke und Grenze sind ``None``, wenn bewiesen optimal; an der
    Zeit- oder Knotengrenze der beste zulaessige Plan (Zielwert ``None``, wenn
    es keinen gibt)."""
    results = _highs(model, time_limit, FAHRZEUG_HIGHS_OPTIONEN, knoten)
    if _ist_optimal(results):
        results.solution_loader.load_vars()
        return results.best_feasible_objective, None, None
    grenze = _erreichte_grenze(results, time_limit, knoten)
    if grenze is not None:
        ziel, schranke = results.best_feasible_objective, results.best_objective_bound
        if ziel is None or not math.isfinite(ziel):
            return None, math.inf, grenze
        results.solution_loader.load_vars()
        return ziel, abs(ziel - schranke) / max(abs(ziel), 1e-9), grenze
    raise InfeasiblePlanError(
        f"dispatch MILP not solved to optimality: {results.termination_condition}"
    )


def _solve_plan_monatszustand(model: ConcreteModel, inp: OptimizationInput) -> str | None:
    """Der Rueckfall mit Monatszustand (MP-11): ohne Gutschrift, ohne Ganzzahl.

    ``saldierung_aktiv = 0`` aus MP-10 waere hier unzulaessig, sobald die
    Periode schon rot ist (D > 0 verlangt (16) > 0). Stattdessen faellt die
    Gutschrift weg, und mit ihr die Obergrenze des MAX: ohne Gutschrift
    belohnt nichts eine grosse rote Menge, die Minimierung haelt (16) von
    selbst am MAX. Wie in MP-10 ueberschaetzt der Lauf keinen Wert."""
    try:
        _solve(model, **_grenzen(inp, MISCHBETRIEB_ZEITGRENZE_S))
    except _Zeitgrenze as grenze:
        logger.warning(
            "mischbetrieb.saldierung_zeitgrenze",
            extra={
                "context": {
                    "site_id": str(inp.site_id),
                    "zeitgrenze_s": MISCHBETRIEB_ZEITGRENZE_S,
                    "grenze": grenze.art,
                    "reason": (
                        "Mischbetrieb mit Monatszustand nicht in der Zeitgrenze "
                        "geloest - dieser Lauf plant ohne Gutschrift"
                    ),
                }
            },
        )
        model.mispel_gutschrift.set_value(0.0)
        model.mischbetrieb_monat_max.deactivate()
        model.saldierung_monat_aktiv.fix(0)
        _solve(model)
        return grenze.art
    return None


def _solve_plan_jahreszustand(model: ConcreteModel, inp: OptimizationInput) -> str | None:
    """Der Rueckfall mit Jahreszustand (MP-26): der Zeitraum, der (P4) erst im
    Lauf erreichen wuerde, bleibt ohne Saldierung (``saldierung_jahr_aktiv``
    = 0, dann (P10) des Laufs = 0). Immer zulaessig - die Saldierung ist nur
    ein Ertrag - und wie in MP-10 ueberschaetzt der Lauf keinen Wert."""
    try:
        _solve(model, **_grenzen(inp, MISCHBETRIEB_ZEITGRENZE_S))
    except _Zeitgrenze as grenze:
        logger.warning(
            "jahreszustand.saldierung_zeitgrenze",
            extra={
                "context": {
                    "site_id": str(inp.site_id),
                    "zeitgrenze_s": MISCHBETRIEB_ZEITGRENZE_S,
                    "grenze": grenze.art,
                    "reason": (
                        "Pauschaloption mit Jahreszustand nicht in der "
                        "Zeitgrenze geloest - dieser Lauf plant ohne "
                        "Saldierung in dem Zeitraum, der (P4) erst erreicht"
                    ),
                }
            },
        )
        model.saldierung_jahr_aktiv.fix(0)
        _solve(model)
        return grenze.art
    return None


def _solve(
    model: ConcreteModel, time_limit: float | None = None, knoten: int | None = None
) -> None:
    results = _highs(model, time_limit, knoten=knoten)
    grenze = _erreichte_grenze(results, time_limit, knoten)
    if grenze is not None:
        raise _Zeitgrenze(grenze, f"{grenze} reached (time {time_limit} s, nodes {knoten})")
    if not _ist_optimal(results):
        raise InfeasiblePlanError(
            f"dispatch MILP not solved to optimality: {results.termination_condition}"
        )
    results.solution_loader.load_vars()


def _ist_optimal(results) -> bool:
    # Lazy import so this module (and the model-building tests) never hard-fail
    # where the HiGHS wheel is unavailable.
    from pyomo.contrib.appsi.base import TerminationCondition

    return results.termination_condition == TerminationCondition.optimal


def _erreichte_grenze(results, time_limit: float | None, knoten: int | None) -> str | None:
    """``"zeitgrenze"`` / ``"knotengrenze"`` (MP-33c), wenn HiGHS an einer
    GESETZTEN Grenze stehen blieb, sonst ``None``. appsi meldet ``mip_max_nodes``
    als ``maxIterations`` (HiGHS ``kSolutionLimit``)."""
    from pyomo.contrib.appsi.base import TerminationCondition

    if time_limit is not None and results.termination_condition == TerminationCondition.maxTimeLimit:
        return "zeitgrenze"
    if knoten is not None and results.termination_condition == TerminationCondition.maxIterations:
        return "knotengrenze"
    return None


def _highs(
    model: ConcreteModel,
    time_limit: float | None = None,
    optionen=None,
    knoten: int | None = None,
):
    from pyomo.contrib.appsi.solvers.highs import Highs

    solver = Highs()
    solver.config.load_solution = False
    # Tighten the optimality tolerance so the model's own 1e-6 tie-break
    # epsilons actually decide ties instead of being swamped by the default
    # 1e-4 relative gap (see MIP_REL_GAP above).
    #
    # mip_feasibility_tolerance is the SECOND knob of the same lesson
    # (measured on the consumer-dispatch earliness tie-break, Inkrement 2):
    # at its 1e-6 default HiGHS accepts integer assignments whose objective
    # sits ~1e-7-1e-6 above the true optimum, which silently swallows any
    # tie-break riding on BINARY variables (the earliness/preference epsilons
    # place on/off runs; the v1 charge tie-breaks ride continuous variables
    # and never hit it). 1e-9 restores exact tie resolution - never loosen it
    # to "speed up" a tie, and never raise an epsilon instead.
    solver.highs_options = {
        "mip_rel_gap": MIP_REL_GAP,
        "mip_abs_gap": MIP_ABS_GAP,
        "mip_feasibility_tolerance": 1e-9,
        **(optionen or {}),
    }
    if knoten is not None:
        solver.highs_options["mip_max_nodes"] = knoten
    if time_limit is not None:
        solver.config.time_limit = time_limit
    return solver.solve(model)


def _extract_plan(
    model: ConcreteModel,
    inp: OptimizationInput,
    plan_id: UUID,
    generated_at: datetime,
) -> SchedulePlan:
    dt = inp.slot_hours
    wear_eur_per_kwh = inp.battery.wear_cost_eur_per_kwh_each_way
    # Die MESSLATTE (Captain 04.09.2026): derselbe Speicher ohne smarte
    # Steuerung, ueber DIESELBEN Eingaben, bewertet mit DERSELBEN Preisformel
    # - siehe voltpilot_optimization.stur. Sie beschreibt nur die Bewertung
    # und beruehrt den geloesten Plan mit keinem Byte.
    # FAIL-SOFT wie die Erklaer-Schicht: die Messlatte ist reine BEWERTUNG.
    # Eine fehlende Zahl ist eine fehlende Zeile im Portal, eine geworfene
    # Ausnahme waere GAR KEIN Fahrplan - das waere der teurere Fehler.
    # P7: ohne Ladestand gibt es KEINE Messlatte. Der sture Speicher startet
    # per Definition aus einem Anfangs-Ladestand und faehrt eine eigene
    # SoC-Bahn - aus einem Platzhalter gerechnet waere er eine zweite
    # Erfindung neben der, die P7 gerade abgeschafft hat. Der bestehende
    # NULL-Weg traegt das bis in die api (`steuerungPlannedEur` bleibt null,
    # sobald auch nur EIN Slot die Messlatte nicht traegt).
    if inp.soc_unbekannt:
        stur_costs: list[float | None] = [None] * inp.slots
    else:
        try:
            stur_costs = list(stur_cost_eur(inp))
        except Exception:  # pragma: no cover - defensive, the reference is pure
            logger.warning(
                "stur reference failed for site=%s - planning without it", inp.site_id,
                exc_info=True,
            )
            stur_costs = [None] * inp.slots
    slots: list[PlanSlot] = []
    for t in range(inp.slots):
        charge = float(value(model.charge[t]))
        discharge = float(value(model.discharge[t]))
        battery_kw = charge - discharge
        # Clamp solver tolerance noise: curtailment is [0, pv] by construction.
        curtail_kw = min(max(float(value(model.curtail[t])), 0.0), max(inp.pv_kw[t], 0.0))
        # Net grid power from the balance (the import/export split is exact by
        # the is_importing binary, so max(grid, 0)/max(-grid, 0) recovers it
        # without solver noise).
        grid_kw = inp.load_kw[t] - inp.pv_kw[t] + curtail_kw + battery_kw
        if inp.fahrzeug is not None:
            # MiSpeL MP-33: der Ladepunkt zieht bzw. liefert am selben Netzpunkt.
            grid_kw += float(value(model.fz_laden[t])) - float(value(model.fz_rueck[t]))
        price = inp.prices_eur_mwh[t]
        slots.append(
            PlanSlot(
                start=inp.slot_starts[t],
                battery_kw=round(battery_kw, 4),
                grid_kw=round(grid_kw, 4),
                soc_kwh=round(float(value(model.soc[t + 1])), 4),
                load_kw=round(inp.load_kw[t], 4),
                pv_kw=round(inp.pv_kw[t], 4),
                price_eur_mwh=price,
                cost_eur=round(inp.cashflow_cost_eur(t, grid_kw), 6),
                # P7: die no-battery-Baseline ist die Referenz, GEGEN die eine
                # geplante Ersparnis rechnet. Ohne Ladestand wurde kein
                # Speicher geplant, also gibt es nichts zu vergleichen - und
                # eine 0,00 EUR waere die Behauptung "geplant und nichts wert"
                # statt der Wahrheit "gar nicht geplant". NULL traegt genau
                # das: jeder Ersparnis-Leser (api HistoryRepository /
                # OverviewRepository, Portal `plannedDayCosts`) filtert schon
                # immer auf "Baseline vorhanden".
                baseline_cost_eur=(
                    None
                    if inp.soc_unbekannt
                    else round(inp.baseline_cost_eur(t), 6)
                ),
                stur_cost_eur=(
                    None if stur_costs[t] is None else round(stur_costs[t], 6)
                ),
                curtail_kw=round(curtail_kw, 4),
                wear_cost_eur=round(
                    wear_eur_per_kwh * (charge + discharge) * dt, 6
                ),
            )
        )
    return SchedulePlan(
        plan_id=plan_id,
        tenant_id=inp.tenant_id,
        site_id=inp.site_id,
        device_id=inp.device_id,
        generated_at=generated_at,
        battery=inp.battery,
        slots=slots,
        slot_minutes=inp.slot_minutes,
        # P5: hand the site's EEG posture to the edge so the solar-only-charge
        # rule is also enforced against MEASURED values, not just the forecast.
        grid_charge_allowed=inp.netzladen_erlaubt,
        # MiSpeL MP-45: die strenge Ausschliesslichkeit samt Toleranz zur Box,
        # damit die Klemme dieselbe Regel gegen MESSWERTE haelt. None = aus.
        strict_exclusivity_tolerance_kwh=(
            inp.strenge_toleranz_kwh if inp.strenge_aktiv else None
        ),
        # MiSpeL MP-14: der Foerderweg zur Box - er entscheidet dort, ob
        # grid_charge_allowed die EEG-Klemme loesen darf.
        foerderweg=inp.foerderweg,
        # FK2: what the objective actually credited per stored kWh - persisted
        # so the portal can show the banked value on bank days.
        terminal_value_eur_per_kwh=round(
            inp.effective_terminal_value_eur_per_kwh(), 6
        ),
        # PS-1: the solved billing-period peak target - the edge peak-guard's
        # grid_import_limit_kw and the persisted schedule.peak_target_kw.
        # None when the peak module is off (no m.peak variable exists then).
        peak_target_kw=(
            round(float(value(model.peak)), 4)
            if inp.leistungspreis_eur_kw is not None
            else None
        ),
        # FK1 handed to the EDGE: the site's static feed-in limit at the grid
        # connection point, published as grid_export_limit_kw so the device can
        # REGULATE it against the measured connection point instead of only
        # planning against it. Pure pass-through of the master datum the solver
        # already constrained on - never a solved value.
        max_feed_in_kw=inp.max_feed_in_kw,
        # Morgenprognose 2026-08-24: the PV nowcast anchor this run's input was
        # corrected by (already inside inp.pv_kw) - carried so the persisted
        # run and the admin readout can name it. Pass-through, like above.
        pv_anchor_ratio=inp.pv_anchor_ratio,
        # P7: WOHER der Start-Ladestand dieses Laufs kam. Auf `unbekannt` ist
        # er zugleich der GRUND des Ruhe-Plans - persistiert je Slot-Zeile, so
        # dass die Fahrplan-Seite ihn aussprechen kann.
        soc_source=inp.soc_source,
        fahrzeug=_fahrzeug_plan(model, inp) if inp.fahrzeug is not None else None,
    )


def _fahrzeug_plan(model: ConcreteModel, inp: OptimizationInput) -> FahrzeugPlan:
    """Der Fahrzeugteil des Plans (MP-33): je Slot Laden, Rueckspeisen und
    Ladestand am Slot-Ende (``None`` = nicht angesteckt), je Abfahrt Ziel und
    geplanter Stand."""
    fz = inp.fahrzeug
    slots = []
    for t in range(inp.slots):
        da = fz.angesteckt[t]
        slots.append(
            FahrzeugSlot(
                laden_kw=round(max(float(value(model.fz_laden[t])), 0.0), 4),
                rueckspeisen_kw=round(max(float(value(model.fz_rueck[t])), 0.0), 4),
                soc_kwh=round(float(value(model.fz_soc[t + 1])), 4) if da else None,
            )
        )
    return FahrzeugPlan(
        komponente_id=fz.komponente_id,
        slots=tuple(slots),
        abfahrten=tuple(
            (s, ziel, round(float(value(model.fz_soc[s])), 4)) for s, ziel in fz.abfahrten
        ),
    )
