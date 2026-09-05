# go-e Charger read-only driver (consumer source, HTTP API v2)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 18).


A go-e wallbox is a READ-ONLY CONSUMER source (`fm/vp-goe-read-driver`). The
canonical decode is `nodered/goe/goe-api.js` (offline-tested `goe-api.test.js`):
ONE keyless GET `http://<ip>/api/status?filter=nrg,car,alw,amp,wh`, map
`nrg[11]` (total charging power) → `load_kw`. **`nrg[11]` is in WATTS in the v2
API** (per marq24/ha-goecharger-api2, which declares `nrg` idx 7..11 as
`UnitOfPower.WATT`; this DIFFERS from v1's 0.01 kW) — VERIFY-on-device like every
vendor scale. Absent-not-zero discipline: a real 0 W (unplugged/not charging) is
KEPT, an absent `nrg[11]` is OMITTED (never fabricated 0). `car` states 0..5 =
unknown/idle/charging/waiting/complete/error surface as honest status only.

Wiring (mirrors the Fronius Solar-API read-only precedent — never in a control
allowlist):
- Catalog: brand `go-e` / communication `goe_http_api` (`inverter.go`), one
  generic model, NO `RatedKw` (physical-envelope guard stays inactive). Served by
  `GET /api/inverter` + `GET /api/sources`.
- Source role `consumer` (`sources.RoleConsumer`, `sources-routing.js`
  `ROLE_CONSUMER`); its `load_kw` rides `edge/sources/{id}/telemetry` → the new
  `vp-verbraucher` palette node (output 3 of the "Energiequellen (automatisch)"
  read tab). The Go agent RECORDS consumer `load_kw` (`onSourceTelemetry` →
  `sourceReading.load` → `SourceLastReadings`) for freshness/status; its
  aggregation into the house balance / a consumer entity is topology-layer work.
- `test-read.js` gained a `goe_http_api` one-shot read path.
- `build-flows.js` embeds `goe/goe-api.js` into sources-read + test-read (rebuild
  `flows.json` via `build-flows.js`; `flows-sync.test.js` pins the embed).
- Proof: `goe/goe-api.test.js`, `test-read.test.js` (go-e HTTP cases),
  `sources-routing.test.js`, `flows-sync.test.js`, `sources-read.e2e.test.js`
  (real in-process HTTP server → publish on output 3), Go
  `inverter_test.go`/`sources_test.go`/`agent/source_agg_test.go`.
- UI-complete since U6 (`fm/vp-uo-u6-edge`): the `:8484` add-source picker
  (`static/sources.js` + `einrichten.html`) offers a **Verbraucher** role card
  (`roleVerbraucher`), brand-by-role filtering (`brandsForRole` — a consumer
  picks the `goe_http_api` driver, Erzeuger/Netz never offer it), a Verbraucher
  list group (`verbList`/`verbEmpty`/`verbNote`) and the consumer `load_kw`
  reading line — so a go-e wallbox is addable end to end in the UI (no
  `POST /api/sources` step). Pinned by
  `web_test.go TestInverterPageServesModelPickerStructure`. The Go
  `sources.Normalize` already accepted `RoleConsumer`.

