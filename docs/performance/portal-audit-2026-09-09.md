# Portal performance audit · 9 September 2026

Customer priority: cockpit responsiveness and switching between sites. Baseline: `f783b6dd`.
This report records local measurements. Production performance and deployment
were not verified by this audit.

## Measured result

Seven alternating site switches per scenario and build, same local API and machine:

| Viewport | Scenario | Before median | After median |
|---|---|---:|---:|
| 1440 px | Ordinary | 113 ms | 68 ms |
| 1440 px | Badge +1,500 ms (synthetic) | 1617 ms | 78 ms |
| 375 px / CPU 4× | Ordinary | 127 ms | 117 ms |
| 375 px / CPU 4× | Badge +1,500 ms (synthetic) | 1604 ms | 112 ms |

`readyMs` measures the site-option click until the target cockpit leaves its loading
state. Secondary widgets may still load. The badge experiment adds 1,500 ms after
its network responses; it proves the removed dependency, not actual production
latency. These small local samples do not establish production percentiles.

The shared chart bundle fell **344.50 → 203.28 kB gzip (41.0%)**, retaining line,
bar, scatter, markers, zoom, accessibility and Universal Transition support.
The entry bundle remains **226.13 kB gzip**, below the existing 230 kB limit.
Sourcemapped guard build: entry 226.14 kB, charts 203.32 kB.

## Implemented

- Cockpit layout no longer waits for the attention badge. Stored layout/profile
  inputs remain part of the loading gate; no guessed layout is displayed.
- Topology and layout requests start before secondary cockpit reads. The topology
  hook resolves independently of its optional emphasis profile.
- ECharts uses explicit modules rather than the full package, following the
  [official import guidance](https://echarts.apache.org/handbook/en/basics/import/).
- Hidden tabs skip polling ticks and refresh immediately on becoming visible.
- A delayed page chunk cannot replace a newer site/page selection.
- Regression tests, a 210 kB chart bundle guard, and a repeatable browser audit
  were added. Existing API coalescing/freshness behavior is retained.

## Customer-page sweep

The baseline and changed build each covered ten views at 1440 and 375 px: cockpit,
schedule, measurements, earnings, market prices, weather, forecast quality,
control, devices and settings. Site switching also exercises the site picker.
The phone viewport uses CPU 4×; this is desktop Chromium emulation, not a physical phone.
All 40 page checks had **0 px document horizontal overflow**. Schedule, weather
and forecast charts rendered in both sizes; several other views lack current
local data. Screenshots show that limitation instead of fabricated live data.

The only browser error repeated before and after on both sizes was a **404 from
`/sites/{id}/fahrzeuge`** on Control. A corresponding controller exists in current
source, so the running local API needs version/configuration verification before
that page can receive a clean sign-off. No new browser errors were observed.

First schedule entry still produced a **247 ms long task** under CPU 4× (one
observation; baseline maximum 281 ms). The smaller download does not remove all
chart startup work. The earnings route had a diagnostic layout-shift sum of
0.410 desktop / 0.247 phone. These programmatic route changes are **not field
CLS**; reproduce with real customer clicks before classifying a Web Vitals issue.

One additional authenticated local boot sample gave FCP 28/64 ms and latest
observed LCP 372/516 ms (desktop/phone). This is a localhost, stored-session,
unthrottled snapshot—not a production loading SLA or percentile.

## Remaining opportunities, in priority order

1. **Reduce cockpit fan-out and fleet work.** Roughly 20–22 API reads still run
   on each switch. `AnlagenPage.tsx` fetches the tenant-wide `/overview` for one
   site. `OverviewController` reads fleet devices, telemetry, savings, profiles,
   capacity, energy totals and a 14-day series. A site-specific cockpit read
   model is the strongest next architectural candidate. Measure production
   timings first, then preserve RLS isolation and exact output with parity tests.
2. **Scope forecast-derived earnings work to the selected site.**
   `SiteEarningsController` calls `EarningsRepository.expectedMarketValue(...)`
   for the whole tenant and takes `.get(siteId)`. Cost can grow with site count;
   no production-size speedup was measured here.
3. **Cancel obsolete request work when ownership permits it.** Many site effects
   ignore late responses but their fetch continues after rapid switches. Any
   cancellation must respect the shared in-flight request consumers; simply
   attaching one caller's AbortSignal would be incorrect.
4. **Measure first chart rendering and earnings layout stability under real input.**
   Record input-to-paint and data-ready times separately. Retain chart semantics,
   motion preferences and reserved space for loading states.
5. **Close production/environment gaps.** Resolve the local vehicle-route 404;
   obtain the production URL and affected sites; collect real browser waterfalls,
   cold/repeat loads, slower networks, API/database timings and representative
   concurrent-user load. Field INP/LCP/CLS and p95/p99 remain unmeasured.

## Backend and delivery checks

Reviewed the hot-path SQL and existing lateral/top-1 rewrites in topology,
overview and earnings; compression, immutable asset caching, HTML revalidation,
authentication bootstrap, request coalescing, lazy routes and polling.
The local database has 4 sites and 4 devices, 8 telemetry chunks and no raw v2
telemetry chunks. A read-only EXPLAIN ANALYZE of the overview device-liveness
aggregation took 0.665 ms execution / 6.662 ms planning locally. This does not
establish performance with production retention or concurrency.

No migrations, backend behavior, customer settings or edge control were changed.

## Validation and reproduction

- Full portal suite: **338 files / 6,674 tests passed**.
- Follow-up navigation/chart/loading checks: **90 tests passed**.
- TypeScript + production build, bundle guard, nginx cache smoke and nginx CSP
  smoke including the browser silent-SSO check passed.
- `git diff --check` passed.
- Browser tooling: [repeatable audit](../../frontend/portal/e2e/performance/README.md).
- Visual report and raw measurement JSON: `.lavish/portal-performance/index.html`
  and its `assets/` directory (local review artifacts).

The audit uses the production frontend build with a local static proof server,
not the deployed nginx/network path. The nginx checks separately verify shipping
cache/compression policy. Production, real-device measurements, large-tenant load
tests and full API/edge/optimizer test suites are outside this measured scope.
