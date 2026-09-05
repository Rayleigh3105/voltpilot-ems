# First-Light calibration: the guided, bounded first real write to a live battery

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 21).


The safe on-device surface (`:8484` „Steuerung kalibrieren") that proves a battery
inverter's control **sign + scale** on the REAL hardware via small, observed,
auto-reverting test writes, BEFORE the family is certified (design
`data/vp-battery-control-deepdive/report.md` §5.7; operator flow
`nodered/CONTROL-BENCH.md` → „First-Light-Kalibrierung"). It is the mechanism for the
very first real write to a live customer battery, and the whole point is the safety
envelope — implemented exactly:

- **`internal/calibration`** is the PURE state machine + sign/scale/magnitude verdict
  (no I/O; every time-dependent method takes `now`, so the envelope is deterministically
  testable). `agent/calibration.go` wires it: the bounded write path, the auto-revert
  watchdog, the measured-battery cross-check, the persisted per-device certification, and
  the `web.CalibrationController` surface. Endpoints `GET /api/calibration` +
  `POST /api/calibration/{arm,test,abort,confirm,correction,certify}`; card `static/calibration.js`.
- **The bounded write path** (`Agent.calibrationOverride`, published on `edge/setpoint`):
  a test setpoint is magnitude-capped (`VP_CALIBRATION_MAX_KW`, default 1.0 kW) AND still
  run through `guards.Clamp` (never around it), auto-reverts to the neutral release after
  `VP_CALIBRATION_TTL_SECONDS` (default 30 s) via a controller-owned `time.AfterFunc`
  watchdog (independent of the UI — the write NEVER latches), is off by default (explicit
  arm required), and its `control_enabled` bypasses **ONLY the certification allowlist** —
  it is still ANDed with `VP_CONTROL_ENABLED`, so the global kill-switch stops it dead.
  `source:"calibration"` + `calibration:true` mark it; it never grid-charges (EEG-safe).
- **The executor bypass** (`inverter-control-routing.js` + the synced `build-flows.js`
  copies, pinned by `flows-sync.test.js`): `setpoint.calibration===true` (and
  `controlRelease(opts.calibration)`) let an UNCERTIFIED Deye emit its EXISTING mapped
  WriteOps with `dwell_s=0` (a bounded manual test, so the revert is never blocked by the
  900 s EEPROM dwell). It REUSES the executor/guards/readback/release — nothing widened.
  Production (no flag) is byte-identical read-only.
- **The certification hand-off** (`CalibrationCertify`): gated on the operator confirming
  BOTH sign and scale (`Passed`), it writes the family into a persisted per-device set
  (`data-dir/calibration-certified.json`) that `Agent.controlCertified` merges with the env
  allowlist — so a released family drives the optimizer/arbiter live with NO env change.
  Never auto-certifies; a sign/scale correction resets the confirmations and revokes it.
  The fleet-wide certification stays the `VP_CONTROL_CERTIFIED_FAMILIES` allowlist edit.
- **`invert_control_sign`** (the WRITE-path sign, separate from the read-path
  `invert_grid_sign`) is plumbed through `inverter.Connection` + `BusPayload` + `Normalize`
  so the calibration sign correction actually reaches the control adapter.
- Proofs: `internal/calibration` units, `agent/calibration_test.go` (cap, guard clamp,
  cert-bypass-without-kill-switch-bypass, auto-revert, persisted+merged cert, correction
  resets+decertifies), `web` endpoint + card-structure tests, `inverter-control-routing.test.js`
  + `deye-control.e2e.test.js` (real in-process Solarman-V5: a small calibration write
  lands + reads back + matches WITHOUT certifying; the revert disables ToU on the wire).
- **The verdict is only trustworthy from a QUIET baseline + a LANDED write (fm/vp-deye-sign-fix-v6, 2026-07-25).** Two live-Pilsting defects: (1) `Verdict` judged the ABSOLUTE measured battery power, so the battery's NATURAL activity (a ~31 kW PV-surplus charge) produced a confident verdict unrelated to the command. `calibration.Verdict` now flags `BaselineBusy` (no confident sign/scale) when `|before| > max(0.1, 0.5·|cmd|)` or the baseline is unknown - a ToU command sets absolute power, so absolute-after is fine ONLY from a near-idle baseline. The card also gates the "hat die Batterie sich bewegt?" ROW on `write_readback_ok` for the CURRENT test and marks an idle-phase (stale) test "nicht mehr aktuell" - a stale/never-landed test never shows a confident row again. This makes `CanConfirm*`/`CanCertify` STRICTER, never looser. (2) The MEASURED battery sign was INVERTED - see the read-sign footgun in the Deye-control-WRITE section.
- **A proven result stays confirmable for a grace window; the test ladder scales to the inverter; the mutations can be admin-gated (fm/vp-calib-ux-t6, 2026-07-27).** Live-pilot UX fixes on the working remote-mode path. (1) **Grace window (Defect 1):** the evidence gate is unchanged (a confirmation still needs a readback-matched test with an OBSERVED same-direction movement), but the movement is a fact about the DEVICE, not about whether the bounded command is still active. `calibration.Session` now LATCHES the best attributable movement while active (`ObserveReading`, also called from `Snapshot`) and keeps it confirmable for `ConfirmGrace` (3 min) after the test auto-reverts - before this the ~2 s revert locked the boxes instantly. `ConfirmSign/ConfirmScale` take `now` (not the live `after`) and confirm against the captured evidence; it invalidates on a new test, abort, disarm, correction (`ResetConfirmations` clears it) or expiry (`ErrEvidenceExpired`). Snapshot carries `evidence_valid`/`evidence_age_seconds`; the card shows "Ergebnis des letzten Tests (vor N s)". `StartTest` now also resets prior confirmations (a new test = fresh proof). (2) **Rated-relative ladder (Defect 2):** `TestStepsForRated(ratedKw, maxKw)` offers ~1/3/5 % of nameplate (rounded 0,1 kW, capped by the authoritative `VP_CALIBRATION_MAX_KW`); on a 30 kW unit 0,3 kW (~1 %) moved nothing. Rated comes from `inverter.Selection.RatedKw` (already published). `NextStepAbove` names the next larger rung in the not-moving hint; unknown rated -> fixed fallback + a card note. (3) **Admin gate (owner scope-change):** `VP_CALIBRATION_ADMIN_SECRET` (`config.CalibrationAdminSecret`) - when set, ONLY the calibration mutation endpoints require the `X-VP-Calibration-Token` header (constant-time compared in the `calGuard` wrapper in `web.go`, 401 before the handler); GET + every other surface stay open; empty = open (non-bricking default). The card prompts for it (sessionStorage, tab-scoped). The TTL/watchdog/magnitude-cap/kill-switch safety net is independent of the token. Proofs: `calibration_test.go` (grace confirm/expiry/invalidation, ladder, next-step), `web_test.go TestCalibrationAdminGate`.

