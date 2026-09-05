# Shelly relay CONTROL driver (consumer, core-owned socket, dead-man timer)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 20).


The SECOND real consumer control path after go-e (D10; pilot: Heizstab hinter
Shelly). `internal/shelly` owns transport + mapping; `agent/shelly_control.go`
wires the executor pass (in the shared consumerControlLoop next to the go-e
pass), the SOURCE POLL and the D11 connection test. Operator doc:
`nodered/SHELLY.md`; bench: `nodered/CONTROL-BENCH.md` -> "Shelly". Rules that
must hold:

- **The CORE owns the WHOLE Shelly socket - single-writer across read AND
  write.** Unlike go-e (Node-RED reads, core writes - two stateless HTTP
  endpoints) the shelly dialect is STATEFUL (detected once, persisted), so
  source poll (`runShellySourcePass`, 30 s), connection test (`shellyTest`,
  in-process - never the Node-RED test-read round trip) and executor all live
  in the core. `sources.BusConfig` EXCLUDES shelly sources from the retained
  Node-RED config (a forwarded entry would only produce the sources store's
  permanent NICHT-VERDRAHTET warn); Node-RED must never grow a shelly reader
  without retiring the core paths.
- **Two generation dialects, DETECTED never configured** (`shelly.Detect`:
  GET /shelly answers unauthenticated on every gen - `gen`>=2 = the RPC
  dialect covering Gen2/3/4, `type` without `gen` = Gen1 REST). Persisted in
  `data_dir/shelly-devices.json` (schema-versioned store; a foreign-schema
  file is ignored wholesale). A dialect-level invalid_response DROPS the
  cached identity so the next pass re-detects exactly once (firmware/device
  swap self-heal, never a loop). A password-protected Shelly (Gen1 basic /
  Gen2 digest) is REFUSED with the honest German message - auth is
  deliberately unsupported in v1.
- **Metering is a DEVICE fact, never a model pick** (D3): Gen2 = `apower`
  present in Switch.GetStatus (the documented Plus1-vs-Plus1PM difference, the
  HA discipline); Gen1 = `meters[ch].is_valid` (aioshelly discipline,
  VERIFY-on-device). A metering readback publishes the measured power as
  per-entity telemetry (`edge/entities/{id}/telemetry`) - the normal E1b chain
  carries it into observed health, consumers actual_kw, the buffered v2 uplink
  and with it the fulfilment ledger's Stufe-2 (INTEGRATED) evidence. A
  non-metering Shelly NEVER publishes a power value (the ledger then honestly
  stays Stufe 3 "angenommen" = Nennleistung x Zeit); its source reading
  carries only the REAL fact `relay_on` (which is what keeps its freshness
  alive - `onSourceTelemetry` accepts it as a usable field).
- **The cloud capability hint rides `device_source_status.load_kw`:** the
  metering poll always publishes `load_kw` (real values incl. 0.0), the bare
  relay never does - so cloud-side `load_kw IS NOT NULL` = proven measurement,
  and `ConsumerService.create` derives `consumer_profile.confirmation_channel`
  from it on edge-source bind (`power_kw` = Stufe 2 / `relay_state` = Stufe 3 /
  unbound = NULL, Stufe 4). The portal's Ink1 rule (kWh goals only with
  measurement) keys on the echoed `confirmationChannel`
  (`consumers/questions.ts consumerHasMeasurement`, type-heuristic fallback
  for older rows - unknown is never "no").
- **THE §4.2 failsafe is `off` AND on-device:** every ON write carries the
  documented one-shot flip-back timer (Gen2 `toggle_after`, Gen1 `timer`;
  `DefaultOnTimerS` 180 s = 3x the 60-s re-assert that re-arms it; config
  `on_timer_s`, -1 disables with documented risk). Stop writing - edge dead,
  WLAN gone - and the relay falls off by itself: aufhoeren zu schreiben IST
  der Failsafe (the WMaxLimPct_RvrtTms discipline). Staleness additionally
  writes an ACTIVE off - deliberately NOT the go-e neutral (a relay has no own
  logic to release into). Timer fidelity per firmware is bench_pending.
- **Restrict-only on a bare setpoint:** a relay delivers 0 or RATED - a
  sub-rated setpoint (rated known via `rated_power_kw`) snaps DOWN to off with
  the honest reason; the sanctioned command paths for on_off consumers carry
  an explicit `on_off` anyway. The arbiter's consumer clamp + cycle guard bind
  UPSTREAM unchanged (the Mindestpause is the central protection of a heating
  rod).
- **D11 "Verbindung testen"** (`:8484` sources drawer, brand Shelly -
  `sources.js` sets `control_test` for every consumer brand): identify (gen +
  metering - the honest Stufe-2/3 consequence is named in the wizard via
  `verify.js shellyCapabilityLine`), read state, and the switch test ONLY
  while the relay is OFF (a value-identical off-write; a running heat cycle is
  NEVER interrupted - then read-only + `ControlCheck.Skipped` with the honest
  note). Independent of the control flags like the go-e check.
- **Golden vectors** `internal/shelly/testdata/shelly-control-vectors.json`
  pin PlanFor/SetURL/EvalReadback (Go-only today; a future JS twin must read
  the SAME file - the goe-control-vectors discipline).
- **Gates:** executor gated on `VP_CONTROL_ENABLED` AND
  `VP_CONSUMER_CONTROL_ENABLED` (both default OFF = zero HTTP + no state file,
  byte-identical); the TYPES heating-rod/generic-load stay `simulator_only` in
  the cloud catalog until the captain's bench session flips them (D11, its own
  mini-PR). The source poll is the READ path and runs regardless (like every
  other source reader) - adding the source is the opt-in.
- Proofs: `internal/shelly` units (vectors, both-gen stubs, auth refusal,
  controlcheck write-only-while-off, store round-trip),
  `agent/shelly_control_test.go` (plan slot -> executor -> HTTP -> readback ->
  confirmed over the REAL plan path; Stufe-2 power telemetry vs Stufe-3
  none; cycle-guard hold named in the consumers block; staleness failsafe
  off; dialect detected once across restart; flag-off byte-identical; source
  poll honesty; D11 via the real TestConnection dispatch), api
  `ConsumerApiTest.consumerCreationDerivesTheConfirmationChannelFromTheReportedSource`
  + `ConsumerRequirementLedgerWriterTest` (the D3 level mapping), portal
  `questions.test.ts` (consumerHasMeasurement).

