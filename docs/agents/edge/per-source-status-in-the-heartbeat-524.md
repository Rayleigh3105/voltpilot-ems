# Per-source status in the heartbeat (#524)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 34).


`agent.sourcesSummary()` (`internal/agent/entities.go`) folds an additive
`sources` block into the status heartbeat: the primary inverter plus every
configured source with its OWN latest reading + `ok|stale|never` health, so the
PORTAL can explain a multi-inverter site's composite PV instead of showing one
opaque number. It only REPORTS - the composite telemetry fold is untouched, and
the block rides the status channel, never telemetry. The primary's pv comes from
`Snapshot.LastReading` (captured BEFORE the multi-source fold - never the
composite); sources reuse the existing `SourceStatuses`/`SourceLastReadings`
freshness machinery. Bounded at 16 entries in `cloud.PublishStatus`. Cloud half
+ portal rendering: root AGENTS.md "Multi-source Anlage" → Increment 2.
Proof: `agent/sources_summary_test.go`.

