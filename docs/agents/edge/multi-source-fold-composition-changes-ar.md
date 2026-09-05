# Multi-source fold: composition changes are EXPLAINED steps (3rd real device bug 2026-07-17)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 7).


The captain's two-Fronius-at-one-Datamanager site (`nodered/FRONIUS.md` §5c has
the worked example + the unit-id convention) froze the PV tile at primary+WR1
while WR2 showed "Liefert Daten". Chain: the fixed 60-s source-freshness window
dropped the slowly-read (sequential double SunSpec walk) WR2 in and out of the
sum → the composite oscillated → every flip restarted the despiker's
confirmation candidate ("Streng" preset) → the tile never adopted the new
level. Rules now baked into `core/internal/agent/agent.go` (pinned by
`agent/source_agg_test.go` with the live numbers):

- **Source freshness follows the ACHIEVED cadence** (`sourceFresh`:
  max(3·interval, 3·observed period, 60 s), capped 15 min). A delivering
  source must never drop out of the sum for being read slowly.
- **A changed fold composition resets the despiker/envelope baselines** of the
  affected channels (`noteSourceMix` → `ResetChannels`): the step is
  configuration, not a device spike. Without this, strict presets freeze on
  any source add/remove/flap.
- **A meaningfully negative primary load (< −1 kW) with Erzeuger PV proves the
  netting topology** (`load_reg = house − Σac`, the site-total-CT algebra) →
  house = load + Σac; the established `max(0, load − Σpv)` branch stays for
  load ≥ 0 (ambiguous). Both live ONLY on the raw-load fallback path since the
  2026-07-17 standard (see the house-consumption-standard section above).
- **A kWp-less Erzeuger disables the PV envelope bound** (no honest bound
  exists; a stated one would clip real power). Enter per-inverter kWp.
- The multi-inverter unit-ID auto-detection (`/api/probe-units` →
  `test-read.js makeProbeUnits`, bounded SID scan 1..10) is fronius_sunspec
  only; the UI offers per-unit source creation, never silent auto-add.

