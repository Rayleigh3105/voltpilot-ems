# Three-pot storage attribution (green / grey / arbitrage) — design

**Status: DESIGN (E4-Basis groundwork). No runtime change ships with this
document** — it extends the shipped two-pot storage-mix model
(`services/api` `EarningsRepository.arbitrageSplit`, the "Arbitrage-Ausweis")
into the 15-min three-pot attribution the v2 revenue-share model needs
(plan-draft D6: Erlösbeteiligung with per-value-stream counterfactual
baselines; §2.7 DV-konformer Modus; D15 Graustrom).

## 1. Why three pots

The shipped `arbitrageSplit` tracks battery content as **two pools** — PV-
charged vs grid-charged kWh — and attributes the realized savings into
`arbitrageEur` (grid-charged buy/sell cashflow) plus the remainder
`pvShiftEur`. That answers *"what did the netzladen permission earn"*, but v2
needs finer answers:

- **Erlösbeteiligung (D6).** Revenue share applies to *market* value streams
  (arbitrage, DV dispatch), not to consumption-side services the customer
  already pays for via hardware/service. Billing therefore needs grid-charged
  energy SPLIT by *why it was charged*: market arbitrage vs a
  consumption-side strategy (peak-shaving precharge, backup-reserve refill,
  §14a support).
- **Compliance evidence (DV-konform / EEG).** A DV-konform or EEG site must
  never grid-charge. The attribution walk sees measured grid-charge directly;
  pot 2 doubles as the *"grey energy reached an EEG battery"* alarm with
  kWh-precision — evidence, not vibes.
- **Premium eligibility (Graustrom, D15).** Discharged energy inherits its
  pot. Exported green kWh keep EEG premium eligibility arguments; exported
  grey/arbitrage kWh must never be premium-credited. Today's pricing layer
  argues this ex-ante from the solver constraint; the attribution makes it
  measurable ex-post.

## 2. The model

Battery content is carried as **three pools** (kWh), updated per 15-min
rollup bucket in time order — the same deterministic one-pass walk as
`arbitrageSplit`, per site (v2: per storage *entity*, see §5):

| Pot | Content | Typical value stream |
|---|---|---|
| **green** | PV-charged energy | Eigenverbrauchs-Verschiebung, EEG-eligible export |
| **grey** | grid-charged energy serving a CONSUMPTION-side strategy | peak shaving, backup reserve, §14a support |
| **arbitrage** | grid-charged energy on a MARKET signal | spot arbitrage, DV dispatch |

Charge-side classification per bucket:

1. `green_in = min(charge, max(pv - load, 0))` — verbatim the shipped
   surplus rule (conservative: pre-window content counts as green, exactly
   like today).
2. `grid_in = charge - green_in` is split grey vs arbitrage by the
   **planned intent** of that slot: the optimizer already persists its plan
   per slot (`schedule` hypertable, latest run per slot — the
   `HistoryRepository.savings` DISTINCT-ON rule). The slot's intent is
   derived from the persisted run:
   - peak module active AND the slot's planned SoC trajectory rises toward
     the reserve floor / ahead of a planned peak window → **grey**;
   - otherwise (charged because import price < later best-use value) →
     **arbitrage**;
   - no persisted plan covering the slot (edge fallback, plan gap) →
     **grey** (conservative: never over-attribute the billable pot).
3. Discharge draws **proportionally from the three pools** (the shipped
   mix rule, generalized from 2 to 3 pools); round-trip losses debit all
   pools proportionally, keeping the self-honesty property (a badly-run
   battery shows negative pot values summing to the site's `savedEur`).

Euro attribution per bucket mirrors the pools: each pot is debited its
charge cost and credited its share of discharge value at the bucket's price;
the invariant **`green + grey + arbitrage == savedEur`** holds exactly by
construction (the remainder rule lands on green, as `pvShiftEur` does
today).

## 3. Intent signal — why the persisted plan is enough

The walk needs *why the optimizer charged* — and the optimizer is the only
honest source of that. Rather than a heuristic on measured flows (fragile,
game-able), the design reads the **persisted plan slot** the charge executed
under:

- `schedule.grid_kw > 0` with `battery_kw > 0` → planned grid charge.
- `schedule.peak_target_kw IS NOT NULL` on the run + the run's SoC
  trajectory versus the entity's reserve floors → grey (peak/reserve).
- otherwise → arbitrage.

This stays **read-side only** for the MVP (computable from columns that
already exist: `battery_kw`, `grid_kw`, `soc_kwh`, `peak_target_kw`). The v2
co-optimizer can later make intent EXPLICIT — it knows which objective term
motivated each charge — by persisting a per-slot `charge_intent` label
(see §4); the read-side derivation is the fallback for v1 rows forever.

## 4. Data-model sketch (no migration ships yet)

```sql
-- Option A (preferred): additive nullable column on the existing plan rows.
ALTER TABLE schedule ADD COLUMN IF NOT EXISTS
    charge_intent TEXT NULL;  -- 'green' | 'grey' | 'arbitrage'
                              -- NULL = derive read-side (v1 rows)

-- Option B: materialized attribution (only if the walk gets too hot to run
-- per request; same RLS/tenant discipline as telemetry_rollup_15m).
CREATE TABLE attribution_15m (
    tenant_id      UUID        NOT NULL,
    site_id        UUID        NOT NULL,
    entity_id      TEXT        NOT NULL,  -- v2 storage entity ('storage-main' for v1 sites)
    bucket         TIMESTAMPTZ NOT NULL,
    green_kwh      DOUBLE PRECISION NOT NULL DEFAULT 0,
    grey_kwh       DOUBLE PRECISION NOT NULL DEFAULT 0,
    arbitrage_kwh  DOUBLE PRECISION NOT NULL DEFAULT 0,
    green_eur      DOUBLE PRECISION NOT NULL DEFAULT 0,
    grey_eur       DOUBLE PRECISION NOT NULL DEFAULT 0,
    arbitrage_eur  DOUBLE PRECISION NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, entity_id, bucket)
);
-- RLS + grants exactly like telemetry_rollup_15m (V2 policy pattern);
-- writer = the rollup refresh job owner (superuser), readers = app role.
```

MVP recommendation: **no new table** — generalize the `arbitrageSplit` walk
in place (`EarningsRepository`), returning three pots instead of two, keyed
by the existing rollups × prices × persisted plans. Option B only if p95
latency on year-range requests demands it.

## 5. v2 multi-entity fit

The co-optimizer (`voltpilot_optimization/co_solver.py`) dispatches N
storage entities; rollups today aggregate per SITE. Until per-entity
telemetry lands (E1a entity registry + per-entity rollups), the walk stays
site-level and v2 sites with one storage behave identically to v1. The
`entity_id` column in Option B and the per-entity `charge_intent` are
forward-shaped for that split; nothing else changes.

## 6. Edge cases (decided conservatively)

- **Pre-window content** counts as green (shipped rule, never inflates the
  billable arbitrage pot).
- **Plan gaps / edge fallback slots**: grid charge → grey (§2 rule 2c) —
  the self-consumption fallback never grid-charges by construction, so real
  occurrences indicate measurement noise or a legacy edge; attributing them
  grey keeps the billing pot clean.
- **DV-konform / EEG sites**: expected `grey_in + arbitrage_in == 0`; any
  positive measured value surfaces in the compliance report, never
  silently reclassified.
- **Asymmetric prices**: pots are valued at the same import-price /
  export-value series the earnings engine already uses — no new price
  source.

## 7. Open questions for the implementation ticket

1. Does Erlösbeteiligung bill the arbitrage pot GROSS (buy/sell cashflow) or
   NET of the wear it caused (`schedule.wear_cost_eur` exists per slot)?
2. Threshold for the DV-konform grey-energy alarm (measurement noise floor —
   the rollup's `greatest(x, 0)` NULL-handling suggests ≥ 0.1 kWh/bucket).
3. Portal surface: does the three-pot split extend the existing
   "davon durch Netzladen verdient" hero line or become its own
   Erlösbeteiligung report page?
