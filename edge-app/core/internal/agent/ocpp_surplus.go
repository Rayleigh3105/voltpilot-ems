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

// grant starts (or extends) a boost for one connector.
func (b *boostStore) grant(key string, txID int, now time.Time, d time.Duration) time.Time {
	if d <= 0 || d > lastmgmt.BoostMaxDuration {
		d = lastmgmt.BoostMaxDuration
	}
	until := now.Add(d)
	b.mu.Lock()
	b.items[key] = boost{until: until, txID: txID}
	b.mu.Unlock()
	return until
}

// cancel ends a boost at once („doch nicht").
func (b *boostStore) cancel(key string) {
	b.mu.Lock()
	delete(b.items, key)
	b.mu.Unlock()
}

// until returns the running boost's end for a connector, or the zero time.
// It expires the boost when the session changed (a new vehicle) or ended.
func (b *boostStore) until(key string, txID int, now time.Time) time.Time {
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
		return time.Time{}
	}
	if !it.until.After(now) {
		delete(b.items, key)
		return time.Time{}
	}
	// A boost belongs to ITS session. txID 0 = the connector reports no
	// transaction (it stopped charging), which ends the boost too.
	if txID != it.txID {
		delete(b.items, key)
		return time.Time{}
	}
	return it.until
}

// ocppSurplus is THE source-lane derivation, shared by the executor and the
// surface exactly like ocppBudget — the page must never show a lane the
// stations were not given.
func (a *Agent) ocppSurplus(now time.Time, set lastmgmt.Settings) lastmgmt.SurplusVerdict {
	return a.ocpp.budget.Surplus(now, set.SurplusPolicy, set.StoragePriority)
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
	if set.StoragePriority != lastmgmt.CarsBeforeStorage {
		return 0, false
	}
	cars, complete := rt.measuredChargingKw(now)
	if !complete {
		// A connector claiming budget without a measurement makes `cars` an
		// under-estimate, which would cap the battery too generously. The same
		// discipline as the budget tracker: an incomplete sample is not a
		// measurement.
		return 0, false
	}
	return rt.budget.StorageChargeCap(now, set.SurplusPolicy, set.StoragePriority, cars)
}

// --- the :8484 surface (read + the two customer actions) ---

// OcppBoost grants or cancels the override.
//
// It refuses a connector that is not CHARGING: „Jetzt voll laden" overrides
// the SOURCE of a running charge, and granting it to an empty plug would be a
// promise about a vehicle that is not there.
func (a *Agent) OcppBoost(req lastmgmt.BoostRequest) (lastmgmt.BoostResult, error) {
	rt := a.ocpp
	if rt == nil {
		return lastmgmt.BoostResult{}, csms.ErrDisabled
	}
	id := strings.TrimSpace(req.ChargePointID)
	if id == "" || req.Connector <= 0 {
		return lastmgmt.BoostResult{}, &lastmgmt.ValidationError{
			Msg: "Es fehlt die Angabe, welcher Ladevorgang voll geladen werden soll.",
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
	until := rt.boosts.grant(key, txID, now, d)
	a.publishOcppState()
	a.ocppNudge()
	return lastmgmt.BoostResult{
		Key: key, Active: true, UntilMs: until.UnixMilli(),
		Duration: int(until.Sub(now) / time.Minute),
		Note: "Dieser Ladevorgang lädt jetzt mit voller verfügbarer Leistung — auch mit Netzstrom. " +
			"Anschlussgrenze, Sicherheitsabstand und Ausfall-Schutz gelten unverändert weiter.",
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

// ocppBoostKeys lists the connectors with a running boost (for the surface).
func (rt *ocppRuntime) boostKeys(now time.Time) []string {
	rt.boosts.mu.Lock()
	defer rt.boosts.mu.Unlock()
	out := []string{}
	for k, v := range rt.boosts.items {
		if v.until.After(now) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
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
		sessions[i].BoostUntil = rt.boosts.until(sessions[i].Key, claim.transactionID, now)
	}
}
