package agent

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// This file is the STUFE-4 wiring: PV-Überschussladen (the SOURCE lane) and
// the „Jetzt voll laden"-Übersteuerung. Like ocpp.go it holds no rule of its
// own — the arithmetic lives in internal/lastmgmt (surplus.go), the storage
// arbitration is one restrict-only cap applied in applySetpoint.
//
// ⚠ THE TWO LANES NEVER WIDEN EACH OTHER. The Anschlussgrenze (budget.go)
// says HOW MUCH may flow, the source policy says FROM WHERE — the lower wins,
// and a customer's economic choice can no more raise the connection limit than
// a boost can (Mockups §2a, the Kombinations-Streifen).

// boostReaperInterval bounds how often expired boosts are swept out of the
// map. They are ALSO checked at decision time (lastmgmt.Session.boosted), so
// the sweep is hygiene, never the mechanism.
const boostReaperInterval = time.Minute

// boost is ONE running override, remembered per connector key.
//
// ⚠ It is deliberately NOT persisted. A boost is a customer's decision about
// the next few hours; a box that restarts and silently resumes charging a
// vehicle from the grid — hours later, without anybody watching — would be a
// promise nobody made. Falling back to the customer's standing priority is the
// honest direction, and the button is one tap away.
type boost struct {
	until time.Time
	// pause = this is „Laden pausieren" rather than „Jetzt voll laden" (P3b,
	// Entscheid E5). ONE entry per connector holds ONE direction, so the two
	// can never run at the same time and there is nothing to arbitrate.
	pause bool
	// txID is the transaction the boost was granted for. A NEW session at the
	// same connector is a NEW vehicle: „bis das Fahrzeug voll ist" ends when
	// its session does, and inheriting a boost would charge a stranger's car
	// from the grid.
	txID int
}

// boostStore holds the running overrides.
type boostStore struct {
	mu     sync.Mutex
	items  map[string]boost
	swept  time.Time
	nextID int
}

func newBoostStore() *boostStore { return &boostStore{items: map[string]boost{}} }

// grant starts (or replaces) an override for one connector. `pause` picks the
// direction; granting one direction REPLACES the other, which is what a
// customer tapping the other entry of the same menu means.
func (b *boostStore) grant(key string, txID int, now time.Time, d time.Duration, pause bool) time.Time {
	if d <= 0 || d > lastmgmt.BoostMaxDuration {
		d = lastmgmt.BoostMaxDuration
	}
	until := now.Add(d)
	b.mu.Lock()
	b.items[key] = boost{until: until, pause: pause, txID: txID}
	b.mu.Unlock()
	return until
}

// cancel ends a boost at once („doch nicht").
func (b *boostStore) cancel(key string) {
	b.mu.Lock()
	delete(b.items, key)
	b.mu.Unlock()
}

// until returns the running override's end for a connector (and whether it is
// the PAUSE direction), or the zero time. It expires the override when the
// session changed (a new vehicle) or ended.
func (b *boostStore) until(key string, txID int, now time.Time) (time.Time, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if now.Sub(b.swept) >= boostReaperInterval {
		b.swept = now
		for k, v := range b.items {
			if !v.until.After(now) {
				delete(b.items, k)
			}
		}
	}
	it, ok := b.items[key]
	if !ok {
		return time.Time{}, false
	}
	if !it.until.After(now) {
		delete(b.items, key)
		return time.Time{}, false
	}
	// An override belongs to ITS session. txID 0 = the connector reports no
	// transaction (it stopped charging), which ends it too - „endet beim
	// Abstecken" holds for BOTH directions.
	if txID != it.txID {
		delete(b.items, key)
		return time.Time{}, false
	}
	return it.until, it.pause
}

// ocppSurplus is THE source-lane derivation, shared by the executor and the
// surface exactly like ocppBudget — the page must never show a lane the
// stations were not given.
func (a *Agent) ocppSurplus(now time.Time, set lastmgmt.Settings) lastmgmt.SurplusVerdict {
	return a.ocppSurplusFor(now, set, set.SurplusPolicy)
}

// ocppSurplusFor is the same derivation under an EXPLICIT lane policy (P5): the
// site default, or the most restrictive source any station declared for itself.
func (a *Agent) ocppSurplusFor(now time.Time, set lastmgmt.Settings,
	lane lastmgmt.SurplusPolicy) lastmgmt.SurplusVerdict {
	return a.ocpp.budget.Surplus(now, lane, set.StoragePriority)
}

// ocppLanePolicy is the policy the SITE lane is derived under (P5).
//
// The lane budget is one physical quantity - one sun, one measurement, one
// pool - so it cannot be per station. What CAN differ per station is how each
// one relates to it, and that needs the lane to EXIST whenever anybody wants
// sun. So: the most restrictive source present wins the derivation
// (nur_sonne > sonne_zuerst > schnell), and lastmgmt.splitExempt then gives
// every session back its own reading (a „Schnell laden" station is exempt, a
// blind „Sonne zuerst" one fails open exactly as it does today).
//
// ⚠ A site where NO station declared a source returns the site default
// unchanged - the compatibility promise of the whole Paket.
func ocppLanePolicy(set lastmgmt.Settings, snap csms.Snapshot) lastmgmt.SurplusPolicy {
	lane := lastmgmt.NormalizePolicy(set.SurplusPolicy)
	for _, c := range snap.Chargers {
		if c.Source == "" {
			continue
		}
		own := lastmgmt.NormalizePolicy(lastmgmt.SurplusPolicy(c.Source))
		if own == lastmgmt.PolicySolarOnly {
			return lastmgmt.PolicySolarOnly
		}
		if own == lastmgmt.PolicySolarFirst && lane == lastmgmt.PolicyFast {
			lane = lastmgmt.PolicySolarFirst
		}
	}
	return lane
}

// ocppSourceBudget turns the verdict into the allocator's input. nil = no
// source cap at all, and then the allocation is byte-for-byte pre-Stufe-4.
func ocppSourceBudget(v lastmgmt.SurplusVerdict, allocatableKw float64) *float64 {
	if !v.Active {
		return nil
	}
	// The lane is never reported wider than the physical budget it lives in:
	// two numbers where one binds would only confuse the surface.
	kw := math.Min(v.Kw, allocatableKw)
	if kw < 0 {
		kw = 0
	}
	return &kw
}

// ocppSourceBudgetAbove is the SAME lane read ABOVE the battery (P6): the whole
// measured surplus, before the storage took its share. It is only ever consulted
// by a session the customer put over the storage (lastmgmt.Session.BeforeStorage);
// nil (no lane at all) behaves exactly as it did before P6.
//
// ⚠ It is ONE physical quantity read twice, not a second pool - the allocator
// decrements BOTH counters on every source-bound allocation, so the vehicles
// together can never take more than the whole surplus.
func ocppSourceBudgetAbove(v lastmgmt.SurplusVerdict, allocatableKw float64) *float64 {
	if !v.Active || v.TotalKw == nil {
		return nil
	}
	kw := math.Min(*v.TotalKw, allocatableKw)
	if kw < 0 {
		kw = 0
	}
	return &kw
}

// ocppMeasuredChargingKw is what the charge points are MEASURED drawing right
// now — the input the battery cap must use, because an allocation a vehicle
// does not take must never be subtracted from the storage.
func (rt *ocppRuntime) measuredChargingKw(now time.Time) (float64, bool) {
	return rt.srv.Snapshot().ChargingTotal(now, ocppMeterMaxAge)
}

// OcppBatteryChargeCap is the OTHER half of „Auto vor Speicher" (surplus.go
// StorageChargeCap): while the customer chose cars-first and vehicles are
// drawing, the battery may only charge what is LEFT of the measured surplus.
//
// ⚠ RESTRICT-ONLY and CHARGE-ONLY. It returns a non-negative ceiling that the
// caller applies to a POSITIVE (charging) command; it never raises anything,
// never touches a discharge and never flips a direction — so no guard above it
// can be violated by it. ok=false = do not touch the battery at all (the
// customer did not choose cars-first, nothing is charging, or there is no
// fresh measurement to judge from — a blind cap would be a guess about a
// customer's storage).
func (a *Agent) OcppBatteryChargeCap(now time.Time) (float64, bool) {
	rt := a.ocpp
	if rt == nil {
		return 0, false
	}
	set := rt.currentSettings()
	// ⚠ P6 GENERALISES THE GATE: the cap is due whenever at least one charge
	// point sits ABOVE the battery in the customer's Rangliste. Without any
	// rank that question collapses into the site-wide StoragePriority
	// (lastmgmt.BeforeStorage), so a site that never ordered one behaves
	// exactly as it did before P6.
	cars, complete, any := a.carsBeforeStorageKw(set, now)
	if !any {
		return 0, false
	}
	if !complete {
		// A connector claiming budget without a measurement makes `cars` an
		// under-estimate, which would cap the battery too generously. The same
		// discipline as the budget tracker: an incomplete sample is not a
		// measurement.
		return 0, false
	}
	// ⚠ The storage word handed in is the DERIVED one, not the site setting: on
	// a ranked site the battery's place comes from the Rangliste, and the
	// site-wide default is only the fallback the derivation already applied.
	return rt.budget.StorageChargeCap(now, set.SurplusPolicy, lastmgmt.CarsBeforeStorage, cars)
}

// carsBeforeStorageKw is the measured charging power of every charge point the
// customer put ABOVE the battery - OCPP stations and wallboxes alike.
//
// `any` reports whether there is such a charge point at all; `complete` mirrors
// ChargingTotal's discipline (a claimant without a fresh measurement makes the
// sum an under-estimate, and an under-estimate would cap the battery too
// generously).
func (a *Agent) carsBeforeStorageKw(set lastmgmt.Settings, now time.Time) (kw float64, complete, any bool) {
	rt := a.ocpp
	if rt == nil {
		return 0, false, false
	}
	complete = true
	for _, c := range rt.srv.Snapshot().Chargers {
		if !lastmgmt.BeforeStorage(c.Rank, set.StorageRank, set.StoragePriority) {
			continue
		}
		any = true
		// ⚠ A station on its OWN grid connection is not inside this site's
		// measurement, so it is neither added back nor subtracted from the
		// storage (the C1 rule, verbatim).
		if !c.Connected || c.OwnConnection() {
			continue
		}
		for _, con := range c.ActiveConnectors() {
			// ⚠ Same three tests as csms.ChargingTotal, MeterInTransit
			// included: a sample that still describes the previous limit is
			// not a measurement of this moment (see its doc).
			if con.PowerKw == nil || con.MeteredAt.IsZero() ||
				now.Sub(con.MeteredAt) > ocppMeterMaxAge || con.MeterInTransit() {
				complete = false
				continue
			}
			if p := *con.PowerKw; p > 0 {
				kw += p
			}
		}
	}
	claims, _ := a.wallboxClaims(set, now)
	for _, c := range claims {
		if !lastmgmt.BeforeStorage(c.cfg.Rank, set.StorageRank, set.StoragePriority) {
			continue
		}
		any = true
		kw += c.measuredKw
	}
	return kw, complete, any
}

// --- the :8484 surface (read + the two customer actions) ---

// OcppBoost grants or cancels the override - in EITHER direction („Jetzt voll
// laden" and its P3b sibling „Laden pausieren", Entscheid E5).
//
// It refuses a connector that is not CHARGING: both directions override a
// RUNNING charge, and granting either to an empty plug would be a promise
// about a vehicle that is not there.
//
// ⚠ ONE method for both, on purpose. Session binding, duration cap, expiry and
// the way back („Automatik fortsetzen") are the same rules; splitting them
// would be a second mechanism to secure twice.
func (a *Agent) OcppBoost(req lastmgmt.BoostRequest) (lastmgmt.BoostResult, error) {
	rt := a.ocpp
	if rt == nil {
		return lastmgmt.BoostResult{}, csms.ErrDisabled
	}
	id := strings.TrimSpace(req.ChargePointID)
	if id == "" || req.Connector <= 0 {
		return lastmgmt.BoostResult{}, &lastmgmt.ValidationError{
			Msg: "Es fehlt die Angabe, welcher Ladevorgang gemeint ist.",
		}
	}
	key := id + "#" + fmt.Sprint(req.Connector)
	now := time.Now().UTC()
	if req.Cancel {
		rt.boosts.cancel(key)
		a.publishOcppState()
		a.ocppNudge()
		return lastmgmt.BoostResult{Key: key, Active: false,
			Note: "Für diesen Ladevorgang gilt wieder Ihre Überschuss-Priorität."}, nil
	}

	txID, ok := ocppTransactionOf(rt.srv.Snapshot(), id, req.Connector)
	if !ok {
		return lastmgmt.BoostResult{}, &lastmgmt.ValidationError{
			Msg: "An diesem Stecker läuft gerade kein Ladevorgang.",
		}
	}
	d := time.Duration(req.Minutes) * time.Minute
	until := rt.boosts.grant(key, txID, now, d, req.Pause)
	a.publishOcppState()
	a.ocppNudge()
	note := "Dieser Ladevorgang lädt jetzt mit voller verfügbarer Leistung — auch mit Netzstrom. " +
		"Anschlussgrenze, Sicherheitsabstand und Ausfall-Schutz gelten unverändert weiter."
	if req.Pause {
		// ⚠ Der Satz nennt AUCH, was NICHT passiert: die Pause gilt diesem
		// einen Ladevorgang, jeder andere lädt unverändert weiter.
		note = "Dieser Ladevorgang pausiert. Alle anderen Ladepunkte laden unverändert weiter; " +
			"Anschlussgrenze, Sicherheitsabstand und Ausfall-Schutz gelten wie bisher."
	}
	return lastmgmt.BoostResult{
		Key: key, Active: true, Pause: req.Pause, UntilMs: until.UnixMilli(),
		Duration: int(until.Sub(now) / time.Minute),
		Note:     note,
	}, nil
}

// ocppNudge asks the executor to re-decide at once: a customer who just tapped
// a button must not wait out a tick to see it.
func (a *Agent) ocppNudge() {
	if a.ocpp != nil {
		a.ocpp.nudge()
	}
}

// ocppTransactionOf finds the live transaction of one connector. A connector
// that is not charging has none, and that is the honest refusal above.
func ocppTransactionOf(snap csms.Snapshot, chargerID string, connector int) (int, bool) {
	for _, c := range snap.Chargers {
		if c.ID != chargerID {
			continue
		}
		for _, con := range c.Connectors {
			if con.ID != connector || con.Session == nil {
				continue
			}
			return con.Session.TransactionID, true
		}
	}
	return 0, false
}

// boostKeys lists the connectors with a running override, split by direction
// (for the surface). A key appears in exactly one of the two.
func (rt *ocppRuntime) boostKeys(now time.Time) (full, paused []string) {
	rt.boosts.mu.Lock()
	defer rt.boosts.mu.Unlock()
	full, paused = []string{}, []string{}
	for k, v := range rt.boosts.items {
		if !v.until.After(now) {
			continue
		}
		if v.pause {
			paused = append(paused, k)
			continue
		}
		full = append(full, k)
	}
	sort.Strings(full)
	sort.Strings(paused)
	return full, paused
}

// ocppApplyBoosts stamps the running overrides onto the allocator input. A
// boost belongs to ITS transaction, so a connector whose session ended (or
// changed) loses it here rather than inheriting it to the next vehicle.
func ocppApplyBoosts(rt *ocppRuntime, sessions []lastmgmt.Session, byKey map[string]ocppClaim, now time.Time) {
	for i := range sessions {
		claim, ok := byKey[sessions[i].Key]
		if !ok {
			continue
		}
		until, pause := rt.boosts.until(sessions[i].Key, claim.transactionID, now)
		if pause {
			sessions[i].PauseUntil = until
			continue
		}
		sessions[i].BoostUntil = until
	}
}
