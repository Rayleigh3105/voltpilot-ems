# Portal performance audit

Run from `frontend/portal` with the local API and Keycloak running and port 5173 free:

```sh
npm run build
node e2e/performance/audit.mjs
```

The script starts its own static production-build server, signs in as the local
`demo` user, and reads existing data. It does not configure devices or change
plant settings. Keep the demo sites available; empty or stale telemetry is
reported by the portal and does not represent a production-sized live dataset.

Results and screenshots go to `/tmp/vp-portal-performance`. Set `VP_PERF_OUT`
to retain them elsewhere. `VP_PERF_WIDTHS` defaults to `1440,375`;
`VP_PERF_RUNS` defaults to three switches per scenario. The 375 px viewport
uses 4x CPU slowdown. There is no network throttling.
Set `VP_PERF_SWEEP=0` to repeat only the boot and switching measurements.

For a paired comparison, preserve an earlier `dist` directory and pass its
absolute path as `VP_PERF_BASELINE`. Both builds run sequentially against the
same backend. Credentials can be overridden with `VP_PERF_USER` and
`VP_PERF_PASSWORD`; they are never included in the output.

Two switching scenarios are measured: ordinary responses, and an additional
1500 ms delay delivering the attention-badge responses to the application.
The latter is a controlled regression experiment, **not production latency**.
`readyMs` starts at the site-option click and ends when the target cockpit has
left its loading state. It does not promise that every secondary widget has
finished loading. Request counts can include a background poll.

The page sweep records long tasks, chart canvases, horizontal overflow,
console errors and layout-shift sums. The sweep navigates programmatically;
its shift sums are **not field CLS**, and its sampled interaction durations
are **not field INP**. Real customer measurements, data volume, mobile network
conditions and concurrency require a separate production/staging trace.
