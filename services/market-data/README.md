# services/market-data - ENTSO-E day-ahead price adapter

**Language:** Python 3.10+
**State:** stateless (scheduled/manual job)
**Responsibility (architecture section 8/11/13):** fetch external **market data**
(day-ahead spot prices per Gebotszone) behind an **anti-corruption adapter** and
expose an internal, provider-agnostic price series to the optimizer.

Day-ahead prices are an input to the MILP optimizer (architecture section 11:
"Eingaben: ... Day-Ahead-Preise (ENTSO-E)"). ENTSO-E Transparency is the first
provider; a commercial data provider can be swapped in later **without touching
callers** - that is the whole point of the port below (architecture section 13).

## Design (the anti-corruption layer)

```
optimizer / job  ->  DayAheadPriceSource        (port, source.py)
                         ^
                         |  implemented by
                         |
              EntsoeDayAheadPriceSource          (adapter, entsoe.py)
                         ^
                         |  wrapped by
                         |
              ResilientPriceSource               (cache+retry+breaker, resilience.py)
```

- `model.py` - internal representation: `PriceSeries` / `PricePoint` (EUR/MWh,
  UTC slot bounds, 15-min or hourly). Carries **no** vendor vocabulary.
- `source.py` - `DayAheadPriceSource` port + `PriceSourceError` /
  `PriceSourceUnavailable`.
- `zones.py` - the only place ENTSO-E's EIC addressing leaks in. Bidding zone
  -> EIC: `DE-LU -> 10Y1001A1001A82H`, `AT -> 10YAT-APG------L`,
  `CH -> 10YCH-SWISSGRIDZ`. Adding a zone is a one-line edit.
- `entsoe.py` - the ENTSO-E adapter: builds the `A44` request, parses the
  `Publication_MarketDocument` XML into a `PriceSeries`. Densifies to the full
  Period `timeInterval` length, carrying the last price forward over both
  interior gaps and omitted trailing slots (ENTSO-E's variable-block quirk), and
  handles `Acknowledgement_MarketDocument` "no data" replies.
- `resilience.py` - `ResilientPriceSource`: retry w/ exponential backoff,
  circuit breaker, and a **last-good cache keyed by (zone, delivery-day
  window)** so the optimizer always gets a usable series for the requested day -
  never a different day's - even when ENTSO-E is down (architecture section 13).
- `persistence.py` - writes a series into the `day_ahead_prices` hypertable and
  reads the last-good series back (`latest_series`, used to prime the cache on a
  cron run) - `TimescaleDayAheadPriceRepository`, optional `[db]` extra, with an
  in-memory double for tests.
- `service.py` / `cli.py` - the fetch orchestration and the cron/manual
  entrypoint.

## Persistence

Prices are timeseries data, so they live in a **TimescaleDB hypertable**
`day_ahead_prices`, keyed by `(bidding_zone, resolution, ts)`. Prices are
market-wide **per bidding zone**, not per tenant - so there is deliberately no
`tenant_id` (and no RLS) on this table, unlike `telemetry`.

Schema is owned by the forward-only migration
`db/migration/V20260701001200__day_ahead_prices_hypertable.sql`
(Flyway/Liquibase-compatible, date-based version chosen so it does not collide
with the api service's future `V1, V2, ...` baseline). The local dev stack
mirrors it via `infra/local/timescale/02-day-ahead-prices.sql` so the table
exists after `docker compose up` without running Flyway. Keep the two in sync.

## Run / build / test

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'          # add ,db extra for the TimescaleDB writer: '.[dev,db]'
pytest                           # fixture-based; never hits the live API

# Manual fetch (needs a live ENTSOE_SECURITY_TOKEN in the environment):
export ENTSOE_SECURITY_TOKEN=...            # captain-provided, see below
python -m voltpilot_market_data fetch --zone DE-LU              # next delivery day
python -m voltpilot_market_data fetch --zone DE-LU --day 2026-07-02
python -m voltpilot_market_data fetch --zone DE-LU --persist    # write to DB
```

`--zone` defaults to `MARKET_DATA_ZONE` (fallback `DE-LU`) when omitted; an
explicit `--zone` always overrides it.

## Scheduled fetch

ENTSO-E publishes the next day's day-ahead prices around **12:45 market time**.
Run the job daily shortly after, e.g. cron:

```cron
# fetch tomorrow's DE-LU day-ahead prices at 13:00 and persist them
0 13 * * *  ENTSOE_SECURITY_TOKEN=... python -m voltpilot_market_data fetch --zone DE-LU --persist
```

The containerised form (`Dockerfile`) defaults to `fetch --persist` and reads
the zone from `MARKET_DATA_ZONE` (fallback `DE-LU`), so the same image serves any
bidding zone by environment alone; deploy it as a K8s `CronJob` (future infra).
Following the repo's backbone-first convention, this service is **not** added to
`docker-compose.yml` (like the other `services/*` app skeletons).

## ENTSO-E security token (captain-provided secret)

A live token is **not** required for tests or CI - parsing/mapping/resilience
run entirely off recorded fixtures under `tests/fixtures/`. A token is needed
only for a real end-to-end fetch. To obtain one:

1. Register at <https://transparency.entsoe.eu>.
2. Email `transparency@entsoe.eu`, subject **"Restful API access"**, from the
   registered address, to have the API role granted.
3. Copy the token from *My Account Settings -> Web Api Security Token*.
4. Set `ENTSOE_SECURITY_TOKEN` in `.env` (placeholder is in `.env.example`).

## Status

MVP. DE-LU implemented end to end against fixtures; AT/CH ready via the zone
map. The optimizer integration (feeding `PriceSeries` into the MILP) is owned by
the optimization service and is out of scope here.
