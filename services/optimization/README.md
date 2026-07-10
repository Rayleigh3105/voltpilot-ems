# services/optimization - Optimization Engine

**Language:** Python 3.10+ (Pyomo + HiGHS)
**State:** stateless (job)
**Responsibility (architecture section 8/11):** MILP/MPC-Fahrplan (HiGHS).

The heart of the system: a deterministic battery-dispatch MILP in MPC style (rolling 24h horizon, 15-min slots) that minimizes net energy cost subject to SoC limits, charge/discharge power, round-trip efficiency and the **observed §14a limit as a hard cap**.
**Predict-then-optimize:** forecasting is a separate layer (`services/forecast`) - the optimizer consumes plain price/forecast series, so learned forecast models slot in later without touching it. No ML in here, ever.

## How the optimizer thinks (all influences at a glance)

Everything that drives a dispatch plan, and everything a plan drives.
Every box below is verified against the current code; the file names in parentheses are where each piece lives.

```mermaid
flowchart LR
    subgraph IN["Inputs - gathered per site each cycle (inputs.py)"]
        PRICES["Day-ahead prices<br/>day_ahead_prices per site.bidding_zone<br/>PT15M preferred, PT60M expanded to quarter hours<br/>horizon = contiguous priced prefix, under 4 h → site skipped"]
        LOAD["Load forecast<br/>forecast hypertable, ACTIVE model only<br/>VOLTPILOT_ACTIVE_LOAD_MODEL, default load-persistence"]
        PV["PV forecast<br/>forecast hypertable, ACTIVE model only<br/>VOLTPILOT_ACTIVE_PV_MODEL, default pv-physical"]
        FB["Persistence fallback (fallback.py)<br/>last 3 days of telemetry when no stored run<br/>covers the horizon; no telemetry at all → zeros"]
        BAT["Battery params (asset row)<br/>capacity_kwh, max_charge_kw, max_discharge_kw,<br/>roundtrip_efficiency_pct (default 92 %),<br/>usable SoC band 5-95 % (platform default),<br/>wear_cost_ct_per_kwh (NULL → platform default 4 ct)"]
        SOC["Start SoC<br/>latest telemetry soc_pct (default 50 %),<br/>clamped into the usable band;<br/>stale (&gt; OPTIMIZER_SOC_MAX_AGE_MINUTES, default 120) → default"]
        LIMIT["Observed §14a envelope<br/>latest telemetry grid_limit_kw<br/>absent → unconstrained;<br/>stale (&gt; OPTIMIZER_GRID_LIMIT_MAX_AGE_MINUTES, default 60)<br/>→ no active limit"]
        NETZ["Grid-charging switch<br/>site.netzladen_erlaubt (DB default: verboten)<br/>false → EEG mode: charge from PV surplus only"]
        FB -. "only when the active model<br/>has no covering run" .-> LOAD
        FB -.-> PV
    end

    subgraph MILP["MILP core (solver.py, Pyomo + HiGHS)"]
        OBJ["Objective: minimize spot cost + battery wear<br/>Σ price_t × grid_t × dt + c_wear/2 × (charge_t + discharge_t) × dt<br/>grid_t = load − pv + curtail + charge − discharge<br/>import and export priced symmetrically (Direktvermarktung MVP);<br/>c_wear = asset wear cost per kWh cycled (default 4 ct)"]
        CON["Constraints<br/>• SoC dynamics with sqrt-split round-trip efficiency<br/>• SoC bounds 5-95 %<br/>• charge/discharge power caps<br/>• binaries: never charge AND discharge in one slot<br/>• curtailment 0 ≤ curtail_t ≤ pv_t (only ever a reduction)<br/>• |grid_t| ≤ grid_limit_kw (hard, import AND export)<br/>• terminal SoC_end ≥ SoC_start (no savings by dumping)<br/>• two ε tie-breaks: prefer NOT curtailing,<br/>prefer an IDLE battery when cycling moves no money<br/>• EEG mode only: charge_t ≤ max(pv_t − load_t, 0)<br/>and never net-import while charging"]
        OBJ --- CON
    end

    subgraph OUT["Outputs (engine.py, per plan)"]
        DB["schedule hypertable (persistence.py)<br/>battery/grid power, SoC trajectory, forecast inputs,<br/>price, cost vs. no-battery baseline, curtail_kw,<br/>wear_cost_eur (priced degradation per slot)<br/>idempotent upsert on (site_id, generated_at, time)"]
        MQTT["Retained QoS1 MQTT (publisher.py)<br/>ems/{tenant}/{site}/{device}/schedule<br/>battery_setpoint_kw per slot;<br/>pv_limit_kw = pv − curtail, only when curtailing<br/>(skipped entirely when no device is claimed)"]
        PORTAL["Portal Fahrplan<br/>GET /api/v1/sites/{id}/schedule"]
        SAVINGS["Savings headline<br/>baseline cost (battery idle) − planned cost"]
    end

    PRICES --> OBJ
    LOAD --> OBJ
    PV --> OBJ
    BAT --> CON
    SOC --> CON
    LIMIT --> CON
    NETZ --> CON
    MILP --> DB
    MILP --> MQTT
    DB --> PORTAL
    DB --> SAVINGS

    subgraph NOTIN["Deliberately NOT plan inputs"]
        PK["site.plant_kind<br/>steers portal money WORDING only"]
        MP["site.anzulegender_wert_ct_kwh<br/>dynamic Marktprämie, realized earnings only"]
    end
    NOTIN -. "never reach the MILP - consumed only by<br/>GET /earnings + portal copy (services/api)" .-> PORTAL
```

Two influences people keep asking about are **deliberately absent** from the plan:
`site.plant_kind` (Direktvermarktung vs. Eigenverbrauch) only changes how the portal *words* the money, and `site.anzulegender_wert_ct_kwh` (the plant's EEG reference rate; the dynamic monthly Marktprämie derives from it) only enters the *realized-earnings* math in `services/api` (`EarningsRepository`).
Neither is read by `inputs.py`, so neither can change a single setpoint.
Under the symmetric-spot-price MVP assumption the cost-minimal dispatch is the same for both plant kinds, which is why the model does not need to know.

An infeasible §14a cap (the envelope is tighter than the site's residual load even with full battery support) does not kill the cycle: the engine retries without the grid constraint (`optimize_ignoring_grid_limit` in `solver.py`) - the physical limit is enforced by the grid operator and the edge guards regardless, and an advisory plan beats none.

### What happens when (plain language)

| Situation | What the plan does | Why |
|---|---|---|
| Cheap hours ahead of expensive ones | Charge (up to `max_charge_kw`, up to the 95 % SoC bound) | Buying low and discharging high beats importing at the high price - as long as the spread survives the round-trip loss. |
| Expensive hours | Discharge into load or export (up to `max_discharge_kw`, down to 5 % SoC) | Every discharged kWh replaces an import or earns export revenue at the same spot price. |
| Price spread below the round-trip losses | Battery stays idle | The efficiency terms eat the margin; the ε tie-break settles the exact tie toward idle. |
| Price spread beats the losses but not the **wear cost** | Battery stays idle | Degradation is PRICED (P2): every kWh cycled costs `wear_cost_ct_per_kwh` (per-asset `asset.wear_cost_ct_per_kwh`, NULL → `OPTIMIZER_WEAR_COST_CT_PER_KWH`, default 4 ct ≈ 250 €/kWh replacement / 6,000 cycles). A cycle needs `eta² × p_discharge − p_charge` > ~38 EUR/MWh at the default - no more ~3 cycles/day chasing sub-cent spreads. The spent wear lands per slot in `schedule.wear_cost_eur`. |
| Stale telemetry (`grid_limit_kw` older than 60 min / `soc_pct` older than 120 min, both env-tunable) | Limit treated as ABSENT / SoC falls back to the 50 % default, discard logged | A §14a dimming event is temporary and re-asserts itself in live telemetry - one old reading must never become a standing cap on every future plan (it once forced 67 % PV curtailment at positive prices); a battery that stopped reporting must not plan from yesterday's SoC. |
| Negative prices, surplus PV, battery full (or not worth storing) | Curtail PV feed-in; the published slot carries `pv_limit_kw` as an inverter cap | Feeding in costs money at a negative price. There is NO hard-coded price condition - under symmetric pricing the economics curtail exactly in the negative slots and never at positive prices. |
| Negative prices, battery has headroom | May charge - with `netzladen_erlaubt` even from the grid, even paying round-trip losses | You are PAID to consume; paid import that covers the round-trip loss is genuinely profitable under symmetric spot pricing. Not a bug (the solver tests pin this). EEG sites still charge only their own PV surplus. |
| §14a `grid_limit_kw` observed in telemetry (fresh) | Every slot's net import AND export clamped to the envelope | Hard constraint in the model; the edge guards re-clamp on execution anyway. NOTE: mirroring the observed IMPORT envelope onto EXPORT is a known modeling question (§14a is import-side dimming; critique F4 part 2 / D5) - deliberately unchanged pending the captain's decision. |
| §14a cap infeasible | Replan without the grid constraint, plan still ships | Advisory plan beats none; the physical limit is enforced by the grid operator + edge guards regardless. |
| Flat price curve | Battery idle, zero savings | Terminal condition `SoC_end ≥ SoC_start` plus the tie-breaks make idle the exact optimum. |
| EEG site (`netzladen_erlaubt = false`, the default) | Battery charges ONLY from the site's own PV surplus - a cheap or even negative-price night with no sun leaves it idle | Ausschließlichkeitsprinzip: grid power in an EEG plant's storage risks the EEG remuneration. See the switch section below. |
| Fewer than 4 h of priced slots (16 slots) | Site skipped this cycle | Prices are the binding input; the site is retried next cycle once the market-data collector caught up. |
| Active forecast model has no run covering the horizon | Persistence fallback over the last 3 days of telemetry | Never fails: with no telemetry at all it degrades to zeros, i.e. a pure price-arbitrage plan. |
| Battery asset not claimed to a device | Plan persisted, nothing published | There is no schedule topic without a device; the portal still shows the Fahrplan. |

### Per-site grid-charging switch (`site.netzladen_erlaubt`)

The former "grid charging is unconstrained" known gap is CLOSED (captain decisions 2026-07-07): every site carries the boolean `netzladen_erlaubt`, **default FALSE** - no existing plant is accidentally non-compliant, and only a Portal-Admin may flip it (enforced server-side in `services/api`).

- **Merchant mode (`true`):** the exact model described above - grid arbitrage allowed. Deliberately regression-identical to the pre-switch optimizer (the untouched solver tests pin it; `test_eeg_constraints_exist_only_in_eeg_mode_and_in_both_builds` pins the model structure).
- **EEG mode (`false`):** the Ausschließlichkeitsprinzip as two extra constraints, present in the primary AND the infeasible-§14a fallback build:
  1. `charge_t ≤ max(pv_t − load_t, 0)` - charge only from the forecast PV surplus.
  2. `grid_t ≤ M_t × (1 − is_charging_t)` - never a net-importing slot while charging. This closes the curtailment loophole: without it the model could curtail the PV fully at negative prices and cover the "solar" charge with paid grid import (Graustrom). Curtailment itself stays available - it limits feed-in, not charge availability.

Everything else (prices, forecasts, §14a, efficiency, curtailment, tie-breaks, persistence, publishing) is shared between the modes - one optimizer, one conditional constraint pair, never two code paths.
The portal derives the visible proof from the persisted plan: a slot that charges while net-importing is a grid-charge slot (own color in the Fahrplan chart); on an EEG site that color can never appear.

## What one cycle does (per site with a battery asset)

1. **Gather** (`inputs.py`): battery params from `asset` (+ `site.bidding_zone`; the per-asset `wear_cost_ct_per_kwh` override, NULL → platform default), day-ahead prices from `day_ahead_prices` (written by `services/market-data`), load/PV forecasts from the `forecast` hypertable - reading ONLY the ACTIVE model's rows (`VOLTPILOT_ACTIVE_LOAD_MODEL`/`VOLTPILOT_ACTIVE_PV_MODEL`, defaults = the baselines; shadow challengers never reach a plan - see `docs/forecasting.md`) and falling back to the persistence baseline over recent telemetry when no stored run covers the horizon (REUSING `voltpilot_forecast`, see `fallback.py`), current SoC + observed `grid_limit_kw` from latest telemetry - each behind a FRESHNESS window (stale = ignored + logged, see the behavior table), and the site's `netzladen_erlaubt` grid-charging switch.
2. **Solve** (`solver.py`): cost minimization at the day-ahead spot price (symmetric for import/export - the Direktvermarktung MVP assumption) PLUS the priced battery wear on every kWh of throughput (see the behavior table). Binaries exclude the simultaneous-charge-discharge artifact (an LP would burn energy through the round trip at NEGATIVE prices, which DE-LU regularly has). Terminal condition `soc_end >= soc_start` so a plan cannot "earn" savings by dumping the battery. **PV curtailment is a decision variable** (`0 <= curtail_t <= pv_t` - only ever a reduction of feed-in): with a full battery at negative prices the plan discards surplus instead of paying to export; no price condition is hard-coded - the economics curtail exactly when feeding in would cost money (see the module docstring, incl. the two epsilon tie-breaks that keep degenerate optima deterministic and the battery idle when cycling moves no money). An infeasible §14a cap degrades to a plan without the grid constraint (the physical limit is enforced by the grid operator + edge guards regardless); a tight EXPORT cap that used to be infeasible now resolves via minimal curtailment.
3. **Persist** (`persistence.py`): the full plan - battery/grid power, SoC trajectory, forecast inputs used, projected cost vs. the no-battery baseline per slot, planned `curtail_kw`, spent `wear_cost_eur` - upserted idempotently into the `schedule` hypertable (schema owned by the api migrations `V20260701020000` + `V20260706040000` + `V20260710000000`, RLS-scoped for the portal read). This is the ML groundwork: plan-vs-actual against `telemetry` is a plain join.
4. **Publish** (`publisher.py`): retained QoS1 to `ems/{tenant}/{site}/{device}/schedule` per the **frozen contract** [`docs/contracts/mqtt-schedule.schema.json`](../../docs/contracts/mqtt-schedule.schema.json); curtailing slots additionally carry the OPTIONAL `pv_limit_kw` inverter cap (= `pv - curtail`, omitted when not curtailing - an additive contract extension, `schema_version` stays 1.0). The headline number - projected EUR savings vs. leaving the battery idle - is what the portal shows.

## Run / build / test

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev,solver]' -e ../forecast   # forecast = the fallback baseline (path dep)
pytest                                          # solver behavior + contract + engine tests
python -m voltpilot_optimization plan           # one cycle (needs [db]+[mqtt] extras + a live stack)
python -m voltpilot_optimization serve          # cycle on startup, then every 15 min
```

`highspy` (HiGHS) lives in the optional `solver` extra because its wheel isn't available on every platform; solver-dependent tests skip without it. `db` (psycopg) and `mqtt` (paho) extras gate the live-stack I/O the same way.

Config via env (same names as the sibling collectors): `POSTGRES_HOST/PORT/DB/USER/PASSWORD` (the trusted backend role - the optimizer reads assets/prices/forecasts across tenants and stamps each plan row's tenant, like the weather collector), `MQTT_HOST/PORT` (+ optional `MQTT_USERNAME/PASSWORD`), `OPTIMIZER_INTERVAL_SECONDS` (default 900), `OPTIMIZER_HORIZON_HOURS` (default 24), `VOLTPILOT_ACTIVE_LOAD_MODEL`/`VOLTPILOT_ACTIVE_PV_MODEL` (which forecast model to consume; keep in sync with the forecast collector). Economic/freshness tunables (all in `voltpilot_optimization/config.py`, garbage values fail loudly): `OPTIMIZER_WEAR_COST_CT_PER_KWH` (platform battery wear cost per kWh cycled, default 4.0; per-asset override via `asset.wear_cost_ct_per_kwh`), `OPTIMIZER_GRID_LIMIT_MAX_AGE_MINUTES` (default 60) and `OPTIMIZER_SOC_MAX_AGE_MINUTES` (default 120) - telemetry readings older than their window are ignored (no §14a cap / default SoC).

In compose the service runs under the **`optimize` profile** (`docker compose --profile optimize up -d --build optimizer`); its Docker build context is the **repo root** (it installs `services/forecast` alongside - see the Dockerfile header).

## Status

**Built:** the full loop above, verified by offline tests (economic behavior on synthetic curves, constraint compliance, contract conformance, engine orchestration). **Built too:** the per-site grid-charging switch (see its section above), priced battery degradation (P2) and the telemetry freshness windows (F4 freshness half) - Stage 1 of the market-revenue optimizer redesign. **Future work:** the tariff/Marktprämie-aware market-revenue objective (P1, next stage), the §14a export-cap semantics question (D5 - the observed import envelope is still mirrored onto export, deliberately unchanged), terminal-SoC energy value (P3), peak-shaving / capacity tariffs, multi-battery sites, dynamic supplier tariffs, feed-in spreads, plan-vs-actual KPIs from the persisted schedules.
