package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// This file is the EXECUTOR of the OCPP load management: it turns the pure
// allocator's decision (internal/lastmgmt) into OCPP charging profiles
// (internal/csms). It contains no allocation rule and no OCPP vocabulary of
// its own — it is wiring, and deliberately thin.
//
// TWO GATES, and they are different on purpose:
//
//   - VP_OCPP_ENABLED runs the SERVER and installs the two PROTECTIVE
//     profiles (station cap + safe default). Those only ever REDUCE what a
//     station may draw, so they make a site safer, never more controlled.
//   - The LIVE allocation additionally needs the plant's own control
//     switches (VP_CONTROL_ENABLED ∧ VP_CONSUMER_CONTROL_ENABLED, Konzept
//     §7.5). Without them the site runs on n × safe default, which is by
//     construction under the connection limit — safe, just not optimised.
//     And the surface SAYS so: a refusal nobody can see is a riddle.

const (
	// ocppTickInterval is how often the allocation is recomputed AND the live
	// profiles are refreshed.
	//
	// ⚠ It must stay comfortably below csms.TxProfileDuration: every tick
	// re-arms the dead man's switch, so the ratio between the two IS the
	// number of consecutive missed ticks a charging vehicle survives before it
	// drops to the safe default. 20 s against 120 s = six.
	ocppTickInterval = 20 * time.Second
	// ocppReadbackInterval bounds how often ONE connector is asked what it
	// will actually do. The readback is evidence, not control, so it runs on a
	// slower cadence than the refresh.
	ocppReadbackInterval = 60 * time.Second
	// ocppCallTimeout bounds a single request to a station.
	ocppCallTimeout = 10 * time.Second
	// ocppLogInterval rate-limits the repeated-failure log line: a station
	// that has been unreachable for an hour must not write 180 lines about it
	// (the OTA-blocker lesson - log on CHANGE, then rarely).
	ocppLogInterval = 5 * time.Minute
	// ocppMeterMaxAge is how old a connector's own MeterValues sample may be
	// and still count toward the measured charging power. Sized at three times
	// the cadence we ask a station for (csms.DefaultMeterInterval, 10 s), so a
	// single missed report is absorbed while a station that stopped metering is
	// noticed within half a minute.
	ocppMeterMaxAge = 3 * csms.DefaultMeterInterval
)

// ocppRuntime holds everything the executor needs. nil while the feature is off.
type ocppRuntime struct {
	srv   *csms.Server
	store *lastmgmt.Store
	// budget is the Stufe-2 dynamic budget tracker: it is fed from the
	// telemetry choke point (ocppObserve) and asked once per pass. On a site
	// that never measures anything it hands back exactly the static Stufe-1
	// budget, so it is on the path unconditionally.
	budget *lastmgmt.BudgetTracker
	// boosts holds the running „Jetzt voll laden"-Übersteuerungen (Stufe 4,
	// ocpp_surplus.go). Deliberately in memory only - see the boost doc.
	boosts *boostStore
	// wake carries an out-of-band "re-decide now" from the telemetry path, so
	// a building load step does not have to wait out a full tick.
	wake chan struct{}

	mu       sync.Mutex
	settings lastmgmt.Settings
	plan     *lastmgmt.Plan
	// commissioned fingerprints what a station was last set up WITH, so a
	// reconnect or a changed site limit re-commissions and nothing else does.
	commissioned map[string]string
	lastReadback map[string]time.Time
	lastErrLog   map[string]time.Time
	// active tracks which connectors held a live profile last tick, so a
	// session that ended gets its profile CLEARED instead of leaving a limit
	// the next vehicle would inherit.
	active map[string]int
	// entityPublished remembers the last per-charge-point entity reading we
	// put on the local bus, so an unchanged MeterValues sample is not appended
	// to the store-and-forward buffer once per pass (Cockpit Phase 1 / E1).
	entityPublished map[string]ocppEntityReading
}

// startOcpp brings up the charge-point server and its executor. With the flag
// off it is a no-op and the agent behaves byte-for-byte as before.
func (a *Agent) startOcpp(ctx context.Context) error {
	if !a.Cfg.OcppEnabled {
		return nil
	}
	store, err := lastmgmt.NewStore(a.Cfg.DataDir)
	if err != nil {
		return fmt.Errorf("Lastmanagement-Einstellungen: %w", err)
	}
	set, _, err := store.Load()
	if err != nil {
		// A corrupt settings file must not stop the box: the defaults mean
		// "no budget", so nothing charges until an operator fixes it - which
		// is the honest, safe degradation.
		slog.Error("Lastmanagement-Einstellungen unlesbar - es wird ohne Ladebudget gestartet", "err", err)
		set = lastmgmt.Settings{}.WithDefaults()
	}
	srv, err := csms.New(csms.Options{
		Enabled: true,
		Port:    a.Cfg.OcppPort,
		DataDir: a.Cfg.DataDir,
		Log:     slog.Default().WithGroup("ocpp"),
		OnSampledValues: func(samples []csms.SampledReading, observedAt time.Time) {
			raw, marshalErr := json.Marshal(struct {
				ObservedAt time.Time             `json:"observed_at"`
				Samples    []csms.SampledReading `json:"samples"`
			}{observedAt.UTC(), samples})
			if marshalErr == nil && a.Bus != nil {
				if publishErr := a.Bus.Publish("edge/measurements/ocpp-meter-values", raw, false); publishErr != nil {
					slog.Warn("OCPP-Messwerte konnten lokal nicht publiziert werden", "err", publishErr)
				}
			}
		},
		OnMeasurementConfigurationResult: func(result csms.MeasurementConfigurationResult) {
			raw, marshalErr := json.Marshal(result)
			if marshalErr == nil && a.Bus != nil {
				if publishErr := a.Bus.Publish(measurements.LocalOcppConfigResultTopic,
					raw, false); publishErr != nil {
					slog.Warn("OCPP-Messkonfiguration Ergebnis konnte lokal nicht publiziert werden",
						"err", publishErr)
				}
			}
		},
	})
	if err != nil {
		return fmt.Errorf("Ladepunkt-Server: %w", err)
	}
	rt := &ocppRuntime{
		srv: srv, store: store, settings: set,
		budget:       lastmgmt.NewBudgetTracker(),
		boosts:       newBoostStore(),
		wake:         make(chan struct{}, 1),
		commissioned: map[string]string{},
		lastReadback: map[string]time.Time{},
		lastErrLog:   map[string]time.Time{},
		active:       map[string]int{},
	}
	a.ocpp = rt
	// Protocol events have their own durable queue: a WAN outage must not erase
	// a transaction stop reason or an RFID authorization trace. Start draining
	// before the socket so leftovers from a prior boot are delivered even when
	// the OCPP listen port itself is currently unavailable.
	a.done.Add(1)
	go a.ocppJournalLoop(ctx)

	if err := srv.Start(ctx); err != nil {
		// The server failing to bind is a real fault and is SHOWN (the
		// snapshot carries the error), but it must not stop the agent: the
		// plant's inverter path is unaffected by a busy port.
		slog.Error("der Ladepunkt-Server konnte nicht gestartet werden", "err", err)
		a.publishOcppState()
		return nil
	}
	a.done.Add(1)
	go a.ocppLoop(ctx)
	a.publishOcppState()
	return nil
}

// onCloudCommand shares the existing per-device command topic with purge_data.
// OCPP commands are one-shot and non-retained; the edge never acknowledges an
// expired/replayed command by pretending it reached a station.
func (a *Agent) onCloudCommand(payload []byte) bool {
	var envelope struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(payload, &envelope) == nil && envelope.Type == "ocpp_command" {
		if a.ocpp == nil {
			slog.Warn("OCPP command received while CSMS is unavailable")
			return true
		}
		a.entMu.Lock()
		identity := csms.CommandIdentity{TenantID: a.entIdentity.TenantID,
			SiteID: a.entIdentity.SiteID, DeviceID: a.entIdentity.DeviceID}
		a.entMu.Unlock()
		if err := a.ocpp.srv.ExecuteCloudCommand(a.ctx, payload, identity); err != nil {
			slog.Warn("OCPP cloud command was not sent", "err", err)
			// A failed durable pre-send decision is transport-retryable, not a
			// terminal business rejection. Leaving QoS1 unacknowledged makes the
			// broker redeliver after storage/restart recovery.
			return acknowledgeOcppCommand(err)
		}
		return true
	}
	a.onPurgeCommand(payload)
	return true
}

func acknowledgeOcppCommand(err error) bool {
	return !errors.Is(err, csms.ErrCommandStorage)
}

// ocppJournalLoop drains oldest-first and acknowledges local files only after
// the broker's QoS1 confirmation. It never speaks to a station.
func (a *Agent) ocppJournalLoop(ctx context.Context) {
	defer a.done.Done()
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		case <-a.ocpp.srv.ProtocolEventsChanged():
		}
		a.linkMu.Lock()
		link := a.link
		a.linkMu.Unlock()
		if link == nil || !link.Connected() {
			continue
		}
		for {
			raw, token, ok := a.ocpp.srv.NextProtocolEvent()
			if !ok {
				break
			}
			if err := link.PublishOcppEvent(raw); err != nil {
				slog.Warn("OCPP journal publish failed; event remains queued", "err", err)
				break
			}
			if err := a.ocpp.srv.AckProtocolEvent(token); err != nil {
				slog.Error("OCPP journal ack failed", "err", err)
				break
			}
		}
	}
}

// stopOcpp shuts the server down (called from the agent's own Stop).
func (a *Agent) stopOcpp() {
	if a.ocpp != nil {
		a.ocpp.srv.Stop()
	}
}

// ocppLoop is the executor: decide, command, refresh, read back.
func (a *Agent) ocppLoop(ctx context.Context) {
	defer a.done.Done()
	rt := a.ocpp
	tick := time.NewTicker(ocppTickInterval)
	defer tick.Stop()
	for {
		a.ocppStep(ctx)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		case <-rt.srv.Changed():
			// A station connected, a session started or a measurement moved:
			// re-decide at once rather than waiting out the tick. The channel
			// coalesces, so a burst costs one extra pass.
		case <-rt.wake:
			// The connection point demands a MEANINGFULLY smaller budget (a
			// machine in the building switched on). Waiting out the tick would
			// leave the site over its planned import for up to 20 s.
		}
	}
}

// ocppStep is ONE pass: commission what needs it, decide, command, refresh.
func (a *Agent) ocppStep(ctx context.Context) {
	rt := a.ocpp
	if rt == nil {
		return
	}
	now := time.Now().UTC()
	snap := rt.srv.Snapshot()
	set := rt.currentSettings()

	// The emergency default is a SITE-wide figure: it is the free power
	// divided by ALL the site's plugs, so a station arriving changes it for
	// everyone - and everyone must be re-commissioned with the new value.
	//
	// ⚠ The two PERMANENT profiles are derived from the MAINTAINED connection
	// limit, deliberately not from the §14a envelope the live budget honours: a
	// dimming event is temporary, and folding it into a profile that outlives
	// the box would leave a station permanently throttled by a limit that
	// expired hours ago - besides re-commissioning every station on every
	// envelope change. §14a binds the LIVE allocation, where it belongs.
	safe := lastmgmt.DeriveSafeDefault(set.GridLimitKw, effectiveMaxHouseLoad(set), snap.ConnectorCount())
	planable := set.GridLimitKw * (1 - set.MarginPct/100)

	for _, c := range snap.Chargers {
		if !c.Connected {
			continue
		}
		a.ocppCommission(ctx, c, planable, safe, now)
	}

	// THE BUDGET (see ocppBudget: one derivation, shared with the surface).
	verdict, reserved := a.ocppBudget(now, set, snap, safe)

	// ⚠ WHAT WE CANNOT SEE IS STILL DRAWING. A station whose websocket is
	// down is NOT charging nothing: it is holding its own safe default, and
	// its cars may well be taking it. Allocating the full budget to the
	// stations we CAN reach would therefore spend that power twice — the site
	// would draw budget + (unreachable plugs × safe default) + the building.
	//
	// So the unreachable plugs' emergency share is RESERVED out of the budget
	// before anything is allocated. It is the import-side twin of the
	// exportlimit doctrine: blind never means unlimited. Pessimistic on
	// purpose — an unplugged connector on a dead station reserves power it is
	// not using, and that is the correct direction to be wrong in.
	//
	// ⚠ …EXCEPT while the budget is MEASURED — see ocppBudget.
	allocKw := ocppAllocatable(verdict, reserved)

	// THE SOURCE LANE (Stufe 4). It is the customer's ECONOMIC choice and can
	// only ever narrow what the physical budget above already allows - the two
	// compose most-restrictive-wins, and neither widens the other.
	surplus := a.ocppSurplus(now, set)

	sessions, byKey := ocppSessions(snap, allocKw)
	ocppApplyBoosts(rt, sessions, byKey, now)
	plan := lastmgmt.Decide(lastmgmt.Input{
		Settings: set, Sessions: sessions, BudgetKw: &allocKw,
		SourceBudgetKw:      ocppSourceBudget(surplus, allocKw),
		SourceAllowsMinimum: surplus.AllowMinimum,
		Policy:              set.SurplusPolicy,
		Previous:            rt.previousPlan(), Now: now,
	})
	rt.setPlan(&plan)

	if allowed, _ := a.ocppControlAllowed(); allowed {
		a.ocppApply(ctx, plan, byKey, now)
	}
	a.ocppReadback(ctx, snap, now)
	a.publishOcppState()
	// Cockpit Phase 1 / E1: the same snapshot the card renders also becomes
	// per-charge-point entity telemetry, so a wallbox's kilowatts reach
	// telemetry_v2 / the rollups / the topology like every other measuring
	// component. No-op without the cloud's charge_point_id binding.
	a.publishOcppEntityTelemetry(snap, now)
}

// ocppBudget is THE budget derivation, and it is deliberately shared by the
// executor and the surface: the page must never show a different number than
// the one the stations were given (one arithmetic, one answer). It is safe to
// call from either side — lastmgmt.BudgetTracker.Budget is idempotent for a
// given moment, so a render evaluates exactly what the next pass would.
//
// ⚠ WHAT WE CANNOT SEE IS STILL DRAWING: an unreachable station holds its own
// safe default and its cars may be taking it, so that share is RESERVED out of
// the budget (the import-side twin of the exportlimit doctrine, blind never
// means unlimited). EXCEPT while the budget is MEASURED — then that draw is
// already inside the measured grid power, where it counts as building load and
// has therefore already shrunk the budget; reserving on top would subtract the
// same power twice, over-conservative in a way no surface could explain ("4 ×
// 24 kW held back for stations that are drawing nothing"). Between two samples
// its draw can still rise, which the very next sample contracts the budget for,
// and the engineering margin covers the gap. Every blind stage gets it back.
func (a *Agent) ocppBudget(now time.Time, set lastmgmt.Settings, snap csms.Snapshot, safe lastmgmt.SafeDefault) (lastmgmt.BudgetVerdict, float64) {
	a.ocppFeedPlanLimit(now)
	verdict := a.ocpp.budget.Budget(now, set)
	reserved := 0.0
	if safe.Computable && !verdict.Measured() {
		reserved = safe.PerConnectorKw * float64(ocppUnreachableConnectors(snap))
	}
	return verdict, reserved
}

// ocppFeedPlanLimit is the FAHRPLAN lane of the charging budget (Stufe 4,
// Captain-Entscheid 20.08.2026 „Weg A"): the plan hands the box a CEILING, and
// the box works out what is left for the vehicles.
//
// What the cloud contributes here is exactly ONE thing the box cannot know on
// its own: the billing-period PEAK TARGET. The connection limit and the §14a
// envelope are already the box's (settings + the observed envelope), and the
// feed-in limit is an export constraint that cannot bound charging - so the
// only thing worth carrying down is the target the battery guard is already
// defending (PS-3). Composed most-restrictive-wins, it stops the charge park
// from blowing the very peak the battery is paying to hold.
//
// ⚠ STRIKT FAIL-OPEN, und das ist die tragende Zusage: kein Plan, ein
// VERALTETER Plan, kein Ziel im Plan oder keine Messung am Netzanschluss ⇒ die
// Bahn wird ABGERÄUMT und die lokale Logik gilt unverändert. Ein Fahrzeug darf
// NIE wegen eines fehlenden Plans stehen bleiben; im Zweifel lädt es.
//
// ⚠ Die Frische-Regel weicht BEWUSST von der des Batterie-Wächters ab: dort ist
// plan.PeakImportLimit staleness-UNABHÄNGIG, weil das Verteidigen eines alten
// Ziels dort nichts kostet (es verschiebt nur Batterieleistung). Hier könnte
// dasselbe alte Ziel ein Auto stehen lassen - also gilt es nur, solange der
// Plan frisch ist.
//
// ⚠ Das v2-Plan-Ziel (peakTargetV2) ist hier bewusst NICHT dabei: die
// v2-Planung ist ein Schattenlauf ohne eine einzige geflaggte Anlage, und der
// Batterie-Wächter verteidigt es ohnehin. Wer sie scharfschaltet, nimmt sie
// hier mit auf - mit ihrer EIGENEN Frische, nie mit der des v1-Plans.
func (a *Agent) ocppFeedPlanLimit(now time.Time) {
	rt := a.ocpp
	if rt == nil {
		return
	}
	a.mu.Lock()
	p := a.currentPlan
	a.mu.Unlock()

	// Ohne Lastspitzen-Zähler gibt es keine Projektion - und damit keine Bahn.
	if a.peak == nil || !p.Fresh(now) {
		rt.budget.ClearPlanLimit()
		return
	}
	target := p.PeakImportLimit()
	if target == nil {
		rt.budget.ClearPlanLimit()
		return
	}
	// The tracker turns the quarter-hour MEAN target into what the site may
	// still average over the REST of this quarter - the same projection the
	// battery's peak guard uses, so the two instruments defend one number.
	allowed, ok := a.peak.AllowedImport(now, *target)
	if !ok {
		rt.budget.ClearPlanLimit()
		return
	}
	rt.budget.ObservePlanLimit(now, allowed)
}

// ocppAllocatable is what is left to hand out.
func ocppAllocatable(v lastmgmt.BudgetVerdict, reservedKw float64) float64 {
	if kw := v.Kw - reservedKw; kw > 0 {
		return kw
	}
	return 0
}

// ocppCommission installs the two permanent profiles when the station is new,
// reconnected, or the site's numbers moved.
func (a *Agent) ocppCommission(ctx context.Context, c csms.ChargerState, planableKw float64, safe lastmgmt.SafeDefault, now time.Time) {
	rt := a.ocpp
	if !safe.Computable {
		return // nothing honest to install yet; the snapshot carries the reason
	}
	maxKw := planableKw
	if c.RatedKw > 0 {
		n := len(c.Connectors)
		if c.Connectors2Declared() > n {
			n = c.Connectors2Declared()
		}
		if n < 1 {
			n = 1
		}
		if r := c.RatedKw * float64(n); r < maxKw || maxKw <= 0 {
			maxKw = r
		}
	}
	// The fingerprint includes the CONNECTION generation, so a station that
	// rebooted and may have lost its profiles is set up again.
	fp := fmt.Sprintf("%d|%.3f|%.3f", c.ConnectedAt.UnixNano(), maxKw, safe.PerConnectorKw)
	rt.mu.Lock()
	same := rt.commissioned[c.ID] == fp
	rt.mu.Unlock()
	if same {
		return
	}

	cctx, cancel := context.WithTimeout(ctx, ocppCallTimeout)
	defer cancel()
	if err := rt.srv.Commission(cctx, c.ID, maxKw, safe.PerConnectorKw, csms.DefaultMeterInterval); err != nil {
		rt.logThrottled("commission:"+c.ID, now, func() {
			slog.Warn("Ladesäule konnte nicht eingerichtet werden", "charge_point_id", c.ID, "err", err)
		})
		return
	}
	rt.mu.Lock()
	rt.commissioned[c.ID] = fp
	rt.mu.Unlock()
}

// ocppApply writes the live allocation and REFRESHES it every tick.
//
// ⚠ The refresh is unconditional: an unchanged limit still has to be
// re-written, because it is the WRITE that re-arms the dead man's switch. The
// pacing that avoids pointless churn happens one layer up, on the VALUE
// (lastmgmt.Pacing), not on the write.
func (a *Agent) ocppApply(ctx context.Context, plan lastmgmt.Plan, byKey map[string]ocppClaim, now time.Time) {
	rt := a.ocpp
	seen := map[string]int{}
	for _, alloc := range plan.Allocations {
		claim, ok := byKey[alloc.Key]
		if !ok {
			continue
		}
		seen[alloc.Key] = claim.connectorID
		cctx, cancel := context.WithTimeout(ctx, ocppCallTimeout)
		err := rt.srv.ApplyLimit(cctx, claim.chargerID, claim.connectorID, claim.transactionID, alloc.Kw)
		cancel()
		if err != nil {
			rt.logThrottled("apply:"+alloc.Key, now, func() {
				slog.Warn("Ladegrenze konnte nicht gesetzt werden",
					"charge_point_id", claim.chargerID, "connector", claim.connectorID,
					"kw", alloc.Kw, "err", err)
			})
		}
	}

	// A session that ended keeps no profile behind: clearing costs one message
	// and stops the next vehicle inheriting the previous one's limit.
	rt.mu.Lock()
	gone := map[string]int{}
	for key, connector := range rt.active {
		if _, still := seen[key]; !still {
			gone[key] = connector
		}
	}
	rt.active = seen
	rt.mu.Unlock()
	for key, connector := range gone {
		chargerID := key
		if i := strings.LastIndex(key, "#"); i > 0 {
			chargerID = key[:i]
		}
		cctx, cancel := context.WithTimeout(ctx, ocppCallTimeout)
		if err := rt.srv.ClearLimit(cctx, chargerID, connector); err != nil {
			slog.Debug("Ladegrenze einer beendeten Sitzung konnte nicht entfernt werden",
				"charge_point_id", chargerID, "connector", connector, "err", err)
		}
		cancel()
	}
}

// ocppReadback asks each active connector, on a slower cadence, what it will
// actually do - the D3 evidence rung between "we commanded it" and "we
// measured it".
func (a *Agent) ocppReadback(ctx context.Context, snap csms.Snapshot, now time.Time) {
	rt := a.ocpp
	for _, c := range snap.Chargers {
		if !c.Connected {
			continue
		}
		for _, con := range c.ActiveConnectors() {
			key := c.ID + "#" + fmt.Sprint(con.ID)
			rt.mu.Lock()
			last := rt.lastReadback[key]
			due := now.Sub(last) >= ocppReadbackInterval
			if due {
				rt.lastReadback[key] = now
			}
			rt.mu.Unlock()
			if !due {
				continue
			}
			cctx, cancel := context.WithTimeout(ctx, ocppCallTimeout)
			_, _, err := rt.srv.ReadBack(cctx, c.ID, con.ID)
			cancel()
			if err != nil {
				rt.logThrottled("readback:"+key, now, func() {
					slog.Debug("Rückfrage nach dem Ladeplan fehlgeschlagen",
						"charge_point_id", c.ID, "connector", con.ID, "err", err)
				})
			}
		}
	}
}

// ocppObserve feeds the dynamic budget from the ONE telemetry choke point
// (agent.onLocalTelemetry), with the SAME gated composite `power_kw` every
// other guard on this box reads — so the charge-point budget and the export
// watchdog can never disagree about what the connection point is doing.
//
// ⚠ The two halves of the control law are paired HERE, at telemetry cadence,
// not at decision time: the grid sample already CONTAINS the charge points'
// draw, so it has to be paired with the charging power of the same moment. Ask
// again 20 s later and a ramping vehicle would make the rest of the site look
// smaller than it is.
//
// It costs nothing on a box without charge points: a.ocpp is nil then.
func (a *Agent) ocppObserve(ts time.Time, measurements map[string]float64, battKw *float64) {
	rt := a.ocpp
	if rt == nil {
		return
	}
	// ⚠ Only a REPORTED §14a envelope is passed on. A `grid_limit_kw` of 0
	// means zero kilowatts (the documented guards.Reading footgun) — only an
	// ABSENT channel means unknown, and inventing one would cap a site the grid
	// operator never capped.
	if kw, ok := measurements["grid_limit_kw"]; ok {
		rt.budget.ObserveGridLimit(kw)
	}
	grid, ok := measurements["power_kw"]
	if !ok {
		return
	}
	charging, complete := rt.srv.Snapshot().ChargingTotal(ts, ocppMeterMaxAge)
	m := lastmgmt.Measurement{GridKw: grid, ChargingKw: charging, Complete: complete}
	// ⚠ The battery's MEASURED charge is the third channel of the Stufe-4
	// surplus split (surplus.go): it is already inside `grid`, so handing it
	// to the cars means taking it back out. A DISCHARGE is not a surplus the
	// cars could claim and enters as 0 - but it still counts as a MEASUREMENT
	// ("the battery is taking nothing"), which is what cars-first needs to
	// know. A site whose flows never publish the channel reports nothing and
	// both priorities collapse into the measured status quo.
	//
	// ⚠ It is handed in EXPLICITLY, never read out of `measurements`: the
	// battery channel is deliberately NOT a published measurement (see the
	// parse in onLocalTelemetry), so a map lookup would silently always miss
	// and the storage arbitration would be dead on every real box. Found by
	// the rig, not by a unit test - the tests fed the map by hand.
	if battKw != nil {
		m.HaveBattery = true
		if *battKw > 0 {
			m.BatteryChargeKw = *battKw
		}
	}
	if rt.budget.ObserveM(ts, m) {
		rt.nudge()
	}
}

// ocppClaim links an allocator key back to the station it belongs to.
type ocppClaim struct {
	chargerID     string
	connectorID   int
	transactionID int
}

// ocppSessions turns the CSMS snapshot into allocator input. budgetKw is the
// allocatable budget, used only as the honest ceiling for a station that
// declares no rating of its own.
func ocppSessions(snap csms.Snapshot, budgetKw float64) ([]lastmgmt.Session, map[string]ocppClaim) {
	var out []lastmgmt.Session
	byKey := map[string]ocppClaim{}
	budget := budgetKw
	for _, c := range snap.Chargers {
		if !c.Connected {
			// ⚠ A station we cannot reach gets no allocation - but it is NOT
			// treated as drawing nothing either: it is holding its own safe
			// default, which the budget already accounts for through the
			// emergency-default arithmetic. Handing its share to the others
			// would double-spend it.
			continue
		}
		for _, con := range c.ActiveConnectors() {
			key := c.ID + "#" + fmt.Sprint(con.ID)
			maxKw := c.RatedKw
			if maxKw <= 0 {
				// No declared rating: the budget itself is the only honest
				// ceiling. Inventing a nameplate would be a guess about
				// somebody's hardware.
				maxKw = budget
			}
			s := lastmgmt.Session{
				Key: key, Priority: c.Priority, MinKw: c.MinKw, MaxKw: maxKw,
			}
			if con.Session != nil {
				s.Since = con.Session.StartedAt
				byKey[key] = ocppClaim{c.ID, con.ID, con.Session.TransactionID}
			} else {
				byKey[key] = ocppClaim{c.ID, con.ID, 0}
			}
			out = append(out, s)
		}
	}
	return out, byKey
}

// ocppUnreachableConnectors counts the plugs of stations we cannot currently
// reach — the ones whose draw we must assume rather than know.
func ocppUnreachableConnectors(snap csms.Snapshot) int {
	total := 0
	for _, c := range snap.Chargers {
		if c.Connected {
			continue
		}
		n := len(c.Connectors)
		if c.Connectors2Declared() > n {
			n = c.Connectors2Declared()
		}
		if n < 1 {
			// A station that has never reported a plug still has at least one.
			n = 1
		}
		total += n
	}
	return total
}

// effectiveMaxHouseLoad falls back to the statically reserved building load
// when no measured worst case was maintained: it is the only figure we have,
// and using 0 there would make the emergency default far too generous.
func effectiveMaxHouseLoad(set lastmgmt.Settings) float64 {
	if set.MaxHouseLoadKw > 0 {
		return set.MaxHouseLoadKw
	}
	return set.HouseReserveKw
}

// ocppControlAllowed reports whether the LIVE allocation may be written, and
// says why not when it may not.
func (a *Agent) ocppControlAllowed() (bool, string) {
	if !a.Cfg.ControlEnabled {
		return false, "Die Steuerung ist an dieser Box abgeschaltet (Not-Aus). Die Ladesäulen halten ihr hinterlegtes Sicherheitsprofil."
	}
	if !a.Cfg.ConsumerControlEnabled {
		return false, "Die Verbrauchersteuerung ist an dieser Box noch nicht freigegeben. Die Ladesäulen halten ihr hinterlegtes Sicherheitsprofil."
	}
	return true, ""
}

// --- settings access (the :8484 surface writes them) ---

func (rt *ocppRuntime) currentSettings() lastmgmt.Settings {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.settings
}

func (rt *ocppRuntime) previousPlan() *lastmgmt.Plan {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.plan
}

func (rt *ocppRuntime) setPlan(p *lastmgmt.Plan) {
	rt.mu.Lock()
	rt.plan = p
	rt.mu.Unlock()
}

// nudge asks the executor to re-decide out of band. Non-blocking: the channel
// coalesces, so a burst of measurements costs one extra pass.
func (rt *ocppRuntime) nudge() {
	select {
	case rt.wake <- struct{}{}:
	default:
	}
}

// logThrottled runs fn at most once per ocppLogInterval per key. A station
// unreachable for an hour must not write 180 identical lines.
func (rt *ocppRuntime) logThrottled(key string, now time.Time, fn func()) {
	rt.mu.Lock()
	last := rt.lastErrLog[key]
	if now.Sub(last) < ocppLogInterval {
		rt.mu.Unlock()
		return
	}
	rt.lastErrLog[key] = now
	rt.mu.Unlock()
	fn()
}

// --- the state snapshot the :8484 surface renders ---

func (a *Agent) publishOcppState() {
	info := a.ocppInfo()
	a.State.Update(func(s *state.Snapshot) { s.Ocpp = info })
}

func (a *Agent) ocppInfo() *state.OcppInfo {
	rt := a.ocpp
	if rt == nil {
		return nil
	}
	snap := rt.srv.Snapshot()
	set := rt.currentSettings()
	plan := rt.previousPlan()
	allowed, note := a.ocppControlAllowed()
	safe := lastmgmt.DeriveSafeDefault(set.GridLimitKw, effectiveMaxHouseLoad(set), snap.ConnectorCount())
	now := time.Now().UTC()
	verdict, reserved := a.ocppBudget(now, set, snap, safe)
	surplus := a.ocppSurplus(now, set)
	boosted := map[string]bool{}
	for _, k := range rt.boostKeys(now) {
		boosted[k] = true
	}

	info := &state.OcppInfo{
		Enabled: snap.Enabled, Listening: snap.Listening, Error: snap.Error,
		Endpoint: rt.srv.Endpoint(a.ocppHost()),
		Port:     snap.Port, URLPath: snap.URLPath,
		ControlEnabled: allowed, ControlNote: note,
		GridLimitKw: set.GridLimitKw, HouseReserveKw: set.HouseReserveKw,
		MarginPct: set.MarginPct, MinPowerKw: set.MinPowerKw,
		BudgetKw:       verdict.Kw,
		ReservedKw:     reserved,
		MaxHouseLoadKw: effectiveMaxHouseLoad(set),
		ConnectorCount: snap.ConnectorCount(),
		SafeDefaultKw:  safe.PerConnectorKw, SafeDefaultNote: safe.Reason,
		SafeDefaultHolds: safe.Holds, SafeWorstCaseKw: safe.WorstCaseKw,
		StaticBudget:   set.StaticBudget,
		BudgetMode:     string(verdict.Mode),
		BudgetNote:     verdict.Reason,
		BudgetBlind:    verdict.Blind,
		EffLimitKw:     verdict.LimitKw,
		Grid14aKw:      verdict.Section14aKw,
		Grid14aBinds:   verdict.Section14aBinds,
		PlanLimitKw:    verdict.PlanLimitKw,
		PlanLimitBinds: verdict.PlanLimitBinds,
		SiteLoadKw:     verdict.SiteLoadKw,
		SiteGridKw:     verdict.GridKw,

		SurplusPolicy:    string(set.SurplusPolicy),
		StoragePriority:  string(set.StoragePriority),
		SurplusActive:    surplus.Active,
		SurplusMode:      string(surplus.Mode),
		SurplusNote:      surplus.Reason,
		SurplusBlind:     surplus.Blind,
		SurplusTotalKw:   surplus.TotalKw,
		SurplusBatteryKw: surplus.BatteryKw,

		Chargers: []state.OcppCharger{},
	}
	if surplus.Active {
		kw := surplus.Kw
		info.SurplusKw = &kw
	}
	if verdict.MeasurementAge > 0 {
		info.MeasurementAgeS = int(verdict.MeasurementAge / time.Second)
	}
	if plan != nil {
		info.AllocatedKw = plan.AllocatedKw
		info.SourceAllocatedKw = plan.SourceAllocatedKw
	}

	var measured float64
	haveMeasured := false
	for _, c := range snap.Chargers {
		oc := state.OcppCharger{
			ID: c.ID, Label: c.Label, Priority: c.Priority, Connected: c.Connected,
			Vendor: c.Vendor, Model: c.Model, Firmware: c.Firmware,
			Ready: !c.CommissionedAt.IsZero(), Note: c.CommissionError,
		}
		if !c.LastSeen.IsZero() {
			oc.LastSeenMs = c.LastSeen.UnixMilli()
		}
		if oc.Note == "" && !oc.Ready && !c.Connected {
			oc.Note = "Diese Ladesäule hat sich noch nicht gemeldet."
		}
		for _, con := range c.Connectors {
			ocn := state.OcppConnector{
				ID: con.ID, Status: con.Status,
				Charging:      con.Session != nil && (con.Status == "" || csms.ChargingStatus(con.Status)),
				PowerKw:       con.PowerKw,
				EnergyKwh:     con.EnergyKwh,
				SocPct:        con.SocPct,
				CommandStatus: con.CommandStatus,
				Readback:      con.Readback,
				ReadbackNote:  con.ReadbackNote,
			}
			if !con.MeteredAt.IsZero() {
				ocn.MeteredAtMs = con.MeteredAt.UnixMilli()
			}
			if con.Session != nil {
				ocn.SessionSince = con.Session.StartedAt.UnixMilli()
				// Cockpit Phase 1 / E2: the session's OWN delivered energy.
				// The station reports a CUMULATIVE register, so the balance is
				// register minus the reading at StartTransaction - derivable
				// here and nowhere else without a second data source (the
				// cloud had to join the Slice-10 journal for it). Absent
				// register = absent balance, never a fabricated 0.
				if con.EnergyKwh != nil {
					kwh := *con.EnergyKwh - float64(con.Session.MeterStartWh)/1000
					// A negative balance is a register that moved backwards
					// (a reset, a swapped meter): we do not know what was
					// delivered, so we say nothing instead of a wrong number.
					if kwh >= 0 {
						ocn.SessionKwh = &kwh
					}
				}
			}
			if con.PowerKw != nil {
				measured += *con.PowerKw
				haveMeasured = true
			}
			ocn.Boost = boosted[c.ID+"#"+fmt.Sprint(con.ID)]
			if plan != nil {
				if alloc, ok := plan.Get(c.ID + "#" + fmt.Sprint(con.ID)); ok {
					kw := alloc.Kw
					ocn.AllocatedKw = &kw
					ocn.Reason = alloc.Reason
					// TextFor names the customer's own priority where the
					// sentence is ABOUT that priority - a waiting vehicle
					// whose owner cannot see WHICH setting holds it is a riddle.
					ocn.ReasonText = lastmgmt.TextFor(alloc.Reason, set.SurplusPolicy)
					ocn.Boost = alloc.Boost
					if !alloc.NextTurnAt.IsZero() {
						ocn.NextTurnMs = alloc.NextTurnAt.UnixMilli()
					}
				}
			}
			oc.Connectors = append(oc.Connectors, ocn)
		}
		sort.Slice(oc.Connectors, func(i, j int) bool { return oc.Connectors[i].ID < oc.Connectors[j].ID })
		info.Chargers = append(info.Chargers, oc)
	}
	sort.Slice(info.Chargers, func(i, j int) bool { return info.Chargers[i].ID < info.Chargers[j].ID })
	if haveMeasured {
		info.MeasuredKw = &measured
	}
	return info
}

// ocppHost is the host an operator types into a station. The box does not
// know its own LAN name, so this is a PLACEHOLDER the surface replaces with
// the address the browser reached it on - inventing a hostname here would put
// a wrong string on a copy field.
func (a *Agent) ocppHost() string { return "" }

// --- web.OcppController: the :8484 "Ladepunkte" surface ---
//
// READ + SETUP only. There is deliberately no method here that commands a
// charging limit: limits come from the load management alone, so the surface
// can never become a second, unarbitrated writer to a customer's charge point.

// OcppView is everything the page renders (nil = the feature is off).
func (a *Agent) OcppView() *state.OcppInfo { return a.ocppInfo() }

// OcppChargers is the persisted allowlist.
func (a *Agent) OcppChargers() []csms.Charger {
	if a.ocpp == nil {
		return []csms.Charger{}
	}
	return a.ocpp.srv.List()
}

// OcppSettings is the site's load-management configuration.
func (a *Agent) OcppSettings() lastmgmt.Settings {
	if a.ocpp == nil {
		return lastmgmt.Settings{}.WithDefaults()
	}
	return a.ocpp.currentSettings()
}

// OcppAddCharger registers a ChargePointId so a station carrying it is
// admitted (the "Säule anbinden" step).
func (a *Agent) OcppAddCharger(req csms.AddRequest) (csms.Charger, error) {
	if a.ocpp == nil {
		return csms.Charger{}, csms.ErrDisabled
	}
	c, err := a.ocpp.srv.Add(req)
	if err == nil {
		a.publishOcppState()
	}
	return c, err
}

// OcppUpdateCharger edits the operator-editable fields (PATCH semantics).
func (a *Agent) OcppUpdateCharger(id string, req csms.UpdateRequest) (csms.Charger, error) {
	if a.ocpp == nil {
		return csms.Charger{}, csms.ErrDisabled
	}
	c, err := a.ocpp.srv.Update(id, req)
	if err == nil {
		a.ocppForget(id)
		a.publishOcppState()
	}
	return c, err
}

// OcppRemoveCharger revokes a station: it is dropped from the allowlist and
// disconnected, and a reconnect is refused.
func (a *Agent) OcppRemoveCharger(id string) error {
	if a.ocpp == nil {
		return csms.ErrDisabled
	}
	err := a.ocpp.srv.Remove(id)
	if err == nil {
		a.ocppForget(id)
		a.publishOcppState()
	}
	return err
}

// OcppSaveSettings stores the site's load-management configuration.
//
// ⚠ It FORGETS every commissioning fingerprint: the site limits feed the two
// permanent profiles, so a changed connection limit must be re-deposited at
// every station rather than waiting for the next reconnect. A safety default
// nobody refreshed is a stale promise.
func (a *Agent) OcppSaveSettings(req lastmgmt.SettingsRequest) (lastmgmt.Settings, error) {
	if a.ocpp == nil {
		return lastmgmt.Settings{}, csms.ErrDisabled
	}
	rt := a.ocpp
	rt.mu.Lock()
	next, err := rt.settings.Apply(req)
	if err != nil {
		rt.mu.Unlock()
		return lastmgmt.Settings{}, err
	}
	rt.settings = next
	rt.commissioned = map[string]string{}
	rt.mu.Unlock()

	if err := rt.store.Save(next); err != nil {
		return lastmgmt.Settings{}, err
	}
	a.publishOcppState()
	return next, nil
}

// ocppForget drops a station's commissioning fingerprint so the next pass
// sets it up again with the current numbers.
func (a *Agent) ocppForget(id string) {
	rt := a.ocpp
	rt.mu.Lock()
	delete(rt.commissioned, id)
	rt.mu.Unlock()
}
