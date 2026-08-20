package agent

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
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
)

// ocppRuntime holds everything the executor needs. nil while the feature is off.
type ocppRuntime struct {
	srv   *csms.Server
	store *lastmgmt.Store

	mu       sync.Mutex
	settings lastmgmt.Settings
	plan     *lastmgmt.Plan
	// reserved is the power held back for stations we cannot reach (see
	// ocppStep) — never allocated, and shown so the arithmetic adds up.
	reserved float64
	// commissioned fingerprints what a station was last set up WITH, so a
	// reconnect or a changed site limit re-commissions and nothing else does.
	commissioned map[string]string
	lastReadback map[string]time.Time
	lastErrLog   map[string]time.Time
	// active tracks which connectors held a live profile last tick, so a
	// session that ended gets its profile CLEARED instead of leaving a limit
	// the next vehicle would inherit.
	active map[string]int
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
	})
	if err != nil {
		return fmt.Errorf("Ladepunkt-Server: %w", err)
	}
	rt := &ocppRuntime{
		srv: srv, store: store, settings: set,
		commissioned: map[string]string{},
		lastReadback: map[string]time.Time{},
		lastErrLog:   map[string]time.Time{},
		active:       map[string]int{},
	}
	a.ocpp = rt

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
	safe := lastmgmt.DeriveSafeDefault(set.GridLimitKw, effectiveMaxHouseLoad(set), snap.ConnectorCount())
	planable := set.GridLimitKw * (1 - set.MarginPct/100)

	for _, c := range snap.Chargers {
		if !c.Connected {
			continue
		}
		a.ocppCommission(ctx, c, planable, safe, now)
	}

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
	reserved := 0.0
	if safe.Computable {
		reserved = safe.PerConnectorKw * float64(ocppUnreachableConnectors(snap))
	}
	allocSet := set
	allocSet.HouseReserveKw += reserved

	sessions, byKey := ocppSessions(snap, allocSet)
	plan := lastmgmt.Decide(lastmgmt.Input{
		Settings: allocSet, Sessions: sessions, Previous: rt.previousPlan(), Now: now,
	})
	rt.setPlan(&plan)
	rt.setReserved(reserved)

	if allowed, _ := a.ocppControlAllowed(); allowed {
		a.ocppApply(ctx, plan, byKey, now)
	}
	a.ocppReadback(ctx, snap, now)
	a.publishOcppState()
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

// ocppClaim links an allocator key back to the station it belongs to.
type ocppClaim struct {
	chargerID     string
	connectorID   int
	transactionID int
}

// ocppSessions turns the CSMS snapshot into allocator input.
func ocppSessions(snap csms.Snapshot, set lastmgmt.Settings) ([]lastmgmt.Session, map[string]ocppClaim) {
	var out []lastmgmt.Session
	byKey := map[string]ocppClaim{}
	budget := set.BudgetKw()
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

func (rt *ocppRuntime) setReserved(kw float64) {
	rt.mu.Lock()
	rt.reserved = kw
	rt.mu.Unlock()
}

func (rt *ocppRuntime) currentReserved() float64 {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.reserved
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

	info := &state.OcppInfo{
		Enabled: snap.Enabled, Listening: snap.Listening, Error: snap.Error,
		Endpoint:       rt.srv.Endpoint(a.ocppHost()),
		ControlEnabled: allowed, ControlNote: note,
		GridLimitKw: set.GridLimitKw, HouseReserveKw: set.HouseReserveKw,
		MarginPct: set.MarginPct, MinPowerKw: set.MinPowerKw,
		BudgetKw:       set.BudgetKw(),
		ReservedKw:     rt.currentReserved(),
		MaxHouseLoadKw: effectiveMaxHouseLoad(set),
		ConnectorCount: snap.ConnectorCount(),
		SafeDefaultKw:  safe.PerConnectorKw, SafeDefaultNote: safe.Reason,
		SafeDefaultHolds: safe.Holds, SafeWorstCaseKw: safe.WorstCaseKw,
		Chargers: []state.OcppCharger{},
	}
	if plan != nil {
		info.AllocatedKw = plan.AllocatedKw
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
			if con.Session != nil {
				ocn.SessionSince = con.Session.StartedAt.UnixMilli()
			}
			if con.PowerKw != nil {
				measured += *con.PowerKw
				haveMeasured = true
			}
			if plan != nil {
				if alloc, ok := plan.Get(c.ID + "#" + fmt.Sprint(con.ID)); ok {
					kw := alloc.Kw
					ocn.AllocatedKw = &kw
					ocn.Reason = alloc.Reason
					ocn.ReasonText = lastmgmt.Text(alloc.Reason)
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
