# Local entity composition (M-B3-local): the :8484 view of a MIGRATED plant

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 15).


A v1→v2 migrated plant gets its entity registry pushed, so `:8484` flips to the
entity tiles + adaptive Energiefluss — but its Layer-1 flows still publish only
the v1 composite site sample, so every tile read **"wartet auf Daten"**.
`entities.ComposeLocal` (`internal/entities/compose.go`) is the LOCAL twin of the
cloud's `ComposedEntityFanout`, called at the ONE `onLocalTelemetry` choke point
(`agent.composeEntities`, after the gates) and consulted by `Agent.Topology()`
through `entityReading` — a REAL per-entity publisher on
`edge/entities/{id}/telemetry` always WINS.

- Channel map (byte-for-byte the fan-out's, `data/vp-v2-entity-backfill/report.md`
  §3): battery-hybrid `soc_pct`/`pv_power_kw` + `battery_power_kw =
  power_kw − load_kw + pv_power_kw`; grid-meter `power_kw` (signed);
  house-load `power_kw ← load_kw`. Only COMPOSED types, only DECLARED measure
  channels, an absent site channel → NO value (never a fabricated 0; the derived
  battery needs all three inputs).
- **HARD BOUNDARY — display-only.** It never reaches `buffer.AppendEntity`, the
  v2 uplink, or the heartbeat's `observed` Ist. The cloud receives the same v1
  sample and fans it out itself; uplinking here would DOUBLE-WRITE `telemetry_v2`.
  Retiring the fan-out in favour of real edge v2 telemetry is a separate,
  coordinated step.
- `house-load` is **category-PINNED to consumer** in `Entity.category()`: it
  declares no actuate capability, so the "measure-only" inference made it a METER
  and the read-model folded the Hausverbrauch into the Netz node. This matches
  the cloud type catalog (`services/api .../entitytypes/catalog.json`) and is
  guard-safe (no actuate ⇒ the capability gate refuses every command).
- Tests: `internal/entities/compose_test.go` (channel map, NULL-channel rule,
  real-zero, composed-types-only, house-load category) and
  `internal/agent/entities_compose_test.go` (the symptom end to end + the
  uplink boundary + real-telemetry-wins).

