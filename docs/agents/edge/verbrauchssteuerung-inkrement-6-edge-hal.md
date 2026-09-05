# Verbrauchssteuerung Inkrement 6 (edge half): the deadline fallback

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 10).


Full picture in the root AGENTS.md "Steuerbare Verbraucher - Inkrement 6".
What must hold HERE:

- **`internal/flexfallback` is the PURE half** (the otaapply/calibration
  discipline: every function takes `now`, no I/O) and **embeds Go tzdata**
  (`_ "time/tzdata"`) - the core's Alpine image ships NO zoneinfo, and the
  recurrence windows are wall-clock in the SITE timezone (E7, DST-correct;
  overnight windows anchor on the FROM day). Never move the window arithmetic
  onto the device clock's zone.
- **The trigger is a floor, not a scheduler:** `latestStart = deadline −
  remaining need − StartMargin` (one 15-min slot, the ONLY earliness ever
  taken). Refusal order is load-bearing: outside window → `plan_fresh` →
  `progress_unknown` → `fulfilled` → `not_yet_due`. Unknown progress (the
  entity's own telemetry stale/never, or no `power_kw` channel) starts
  NOTHING - kein erfundener Lauf; past the deadline the duty is honestly
  missed, never run outside its window.
- **Progress is a CONFIRMED lower bound** (`flexfallback.Tracker`): hold-last
  accrual from the entity's OWN measured `power_kw` at/above
  `RunThresholdKw` (10 % of run power, 50-W floor), gaps beyond
  `MaxSampleGap` accrue nothing (evidence, not extrapolation). Persisted
  throttled to `<data>/flexfallback.json` (agent/flexfallback.go) so a reboot
  keeps the day's accrued runtime/energy; a new instance key resets it.
- **The wish enters the NORMAL chain as class `deadline-fallback` (rank 50,
  D-20), NEVER override**, source kind `deadline-fallback` via
  `SubmitInternal` only - `desired.Parse` rejects both externally. Rank 50 is
  the seamless-takeover mechanism: a fresh plan's market desire (60) and a
  reactive Pflichtregel (flow override, 70) SUPERSEDE the fallback holder
  directly (no failsafe blip); a plain flow wish (40) does not outrank the
  due duty. Consumer clamp + cycle guard bind unchanged - a Mindestpause
  HOLDS the self-start with the honest `guard_min_off`.
- **Everything is gated on `VP_CONSUMER_CONTROL_ENABLED`** (default OFF):
  with the flag off there are no desires, no trackers, no file - pinned by
  `agent/flex_fallback_test.go TestFlagOffIsByteIdentical`. The heartbeat's
  consumers block reports a fallback run as `running_optimized` +
  `flex_deadline_fallback` (agent/consumers.go); the cloud listener and the
  portal map know the word.
- Proofs: `internal/flexfallback` units,
  `internal/desired/deadline_fallback_test.go`,
  `agent/flex_fallback_test.go`, rig C7 in `test/e2e-v2-compose.sh` (which
  also sets `VP_CONSUMER_CONTROL_ENABLED` in `test/docker-compose.e2e-v2.yml`).

