package entladeschutz

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan2"
)

const (
	// Takt is the guard's cadence: every Takt the box re-decides every
	// bidirectional connector - abort on unplugging, a stale grid reading or
	// a lost station lands within one Takt, not with the next plan.
	Takt = 2 * time.Second
	// Erneuern: a running feed-back is re-sent at least this often (the
	// station's fuse for a discharge profile is csms.V2XDischargeFuse).
	Erneuern = 10 * time.Second
	// MaxStilleSaeule: a station that said nothing for longer is treated as
	// lost even while its socket still looks open (half-open TCP).
	MaxStilleSaeule = 90 * time.Second
	// sendeTimeout bounds one SetChargingProfile round trip.
	sendeTimeout = 5 * time.Second
)

// Steckplatz is one connector of one station - the unit the guard reserves.
type Steckplatz struct {
	ChargerID string
	Connector int
}

// Sender is the station side: csms.Server.SetV2XSetpoint21 (MP-37).
type Sender interface {
	SetV2XSetpoint21(ctx context.Context, chargerID string, connector int, setpointKw float64) (csms.V2XSetpoint, error)
}

type laufend struct {
	kw       float64
	gesendet time.Time
}

// Waechter runs the decision against the stations. A connector it feeds back
// from is RESERVED: the load management must not write its charging profile
// there (same profile id, csms.TxProfileID) until the guard releases it.
type Waechter struct {
	mu      sync.Mutex
	aktiv   map[Steckplatz]laufend
	gruende map[Steckplatz]string
	// abgelehnt: when the station last refused a V2X profile - no new
	// attempt before Erneuern (no request storm against a station that
	// cannot).
	abgelehnt map[Steckplatz]time.Time
	// Freigegeben is called after a reservation ended, so the load
	// management can hand the connector a charging profile at once.
	Freigegeben func()
}

// NewWaechter builds an idle guard.
func NewWaechter() *Waechter {
	return &Waechter{aktiv: map[Steckplatz]laufend{}, gruende: map[Steckplatz]string{},
		abgelehnt: map[Steckplatz]time.Time{}}
}

// Reserviert reports whether the guard currently owns the connector's profile.
func (w *Waechter) Reserviert(chargerID string, connector int) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, ok := w.aktiv[Steckplatz{chargerID, connector}]
	return ok
}

// Reservierte lists the reserved connectors (for the pass that also has to
// stop connectors that vanished from the station list).
func (w *Waechter) Reservierte() []Steckplatz {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]Steckplatz, 0, len(w.aktiv))
	for sp := range w.aktiv {
		out = append(out, sp)
	}
	return out
}

// Schritt decides one connector and acts on it:
//   - feed back allowed: send the negative setpoint at once when it is lower
//     than the running one (every reduction is immediate), otherwise renew it
//     every Erneuern; the connector is reserved from the first ACCEPTED send;
//   - refused while feeding back: send setpoint 0 at once (the vehicle stops
//     feeding back now, not when the plan or the fuse ends) - unless the
//     vehicle is gone or the station unreachable, where nothing can be sent -
//     and release the reservation so the load management charges again.
func (w *Waechter) Schritt(ctx context.Context, s Sender, sp Steckplatz, l Lage) Entscheid {
	w.mu.Lock()
	vorher, lief := w.aktiv[sp]
	w.mu.Unlock()
	if !lief {
		// Only a feed-back the guard is running counts in the grid balance:
		// an old accepted profile after a release would overstate the house.
		l.AktuellEntladenKw = 0
	}
	e := Entscheiden(l)
	w.mu.Lock()
	if w.gruende[sp] != e.Grund {
		slog.Info("V2X-Rückspeisung entschieden", "charge_point_id", sp.ChargerID, "connector", sp.Connector,
			"entladen_kw", e.EntladenKw, "grund", e.Grund, "modus", string(e.Modus))
		w.gruende[sp] = e.Grund
	}
	w.mu.Unlock()

	if e.EntladenKw > 0 {
		if lief && e.EntladenKw >= vorher.kw-0.05 && l.Jetzt.Sub(vorher.gesendet) < Erneuern {
			return e // unchanged or higher: wait for the renewal
		}
		w.mu.Lock()
		zuletzt, warAbgelehnt := w.abgelehnt[sp]
		w.mu.Unlock()
		if !lief && warAbgelehnt && l.Jetzt.Sub(zuletzt) < Erneuern {
			return Entscheid{Grund: GrundNichtAngenommen}
		}
		// Reserve BEFORE the first send: the load management must not write
		// its charging profile over the V2X profile in between.
		w.mu.Lock()
		w.aktiv[sp] = laufend{kw: vorher.kw, gesendet: vorher.gesendet}
		w.mu.Unlock()
		cctx, cancel := context.WithTimeout(ctx, sendeTimeout)
		res, err := s.SetV2XSetpoint21(cctx, sp.ChargerID, sp.Connector, -e.EntladenKw)
		cancel()
		if err == nil && res.Status == "Accepted" {
			w.mu.Lock()
			w.aktiv[sp] = laufend{kw: e.EntladenKw, gesendet: l.Jetzt}
			w.mu.Unlock()
			return e
		}
		slog.Warn("V2X-Rückspeisung nicht angenommen", "charge_point_id", sp.ChargerID,
			"connector", sp.Connector, "status", res.Status, "err", err)
		w.mu.Lock()
		w.abgelehnt[sp] = l.Jetzt
		w.mu.Unlock()
		e = Entscheid{Grund: GrundNichtAngenommen}
		lief = true // reserved above: release below
	}
	if !lief {
		return e
	}
	if l.Angesteckt && l.Verbunden {
		cctx, cancel := context.WithTimeout(ctx, sendeTimeout)
		if _, err := s.SetV2XSetpoint21(cctx, sp.ChargerID, sp.Connector, 0); err != nil && !errors.Is(err, csms.ErrV2XDischargeOff) {
			slog.Warn("V2X-Rückspeisung konnte nicht aktiv beendet werden - die Sicherung der Säule beendet sie",
				"charge_point_id", sp.ChargerID, "connector", sp.Connector, "err", err)
		}
		cancel()
	}
	w.mu.Lock()
	delete(w.aktiv, sp)
	w.mu.Unlock()
	if w.Freigegeben != nil {
		w.Freigegeben()
	}
	return e
}

// GrundNichtAngenommen: the station did not accept the V2X profile.
const GrundNichtAngenommen = "nicht_angenommen"

// SaeuleEintragen fills the station and vehicle part of a Lage from the csms
// snapshot. c == nil or con == nil: the station or connector is gone.
func SaeuleEintragen(l *Lage, c *csms.ChargerState, con *csms.Connector) {
	if c == nil || con == nil {
		return
	}
	l.Verbunden = c.Connected && !c.LastSeen.IsZero() && l.Jetzt.Sub(c.LastSeen) <= MaxStilleSaeule
	l.OCPP21 = c.OCPPVersion == csms.OCPPVersion21
	l.Angesteckt = con.Session != nil && !con.Session.Reconciling && con.Status != csms.StatusAvailable
	l.EigenerNetzanschluss = c.OwnConnection()
	// The station's declared rating per connector and its installed station
	// cap (csms permanent profile) bound both directions.
	var rated *float64
	if c.RatedKw > 0 {
		rated = &c.RatedKw
	}
	if v, ok := minWert(rated, c.MaxKw); ok && v > 0 {
		l.LadeleistungKw, l.StationsleistungKw = kopie(&v), kopie(&v)
	}
	if con.SocPct != nil {
		l.SocPct, l.SocZeit = kopie(con.SocPct), con.SocMeasuredAt
	}
	if v := con.V2X; v != nil && v.Status == "Accepted" && v.SetpointKw < 0 && l.Jetzt.Sub(v.SentAt) <= csms.V2XDischargeFuse {
		l.AktuellEntladenKw = -v.SetpointKw
	}
	ev := con.EV
	if ev == nil {
		return
	}
	l.FahrzeugBidirektional = ev.Bidirectional
	// DC reports its SoC only here; the newer of meter value and report wins.
	if ev.SocPct != nil && (l.SocPct == nil || ev.ReportedAt.After(l.SocZeit)) {
		l.SocPct, l.SocZeit = kopie(ev.SocPct), ev.ReportedAt
	}
	l.FahrzeugKapazitaetKwh = kopie(ev.CapacityKwh)
	l.FahrzeugZielSocPct = kopie(ev.TargetSocPct)
	l.FahrzeugUnterV2XKwh = kopie(ev.MinV2XEnergyKwh)
	l.FahrzeugMaxLadeKw = kopie(ev.MaxChargeKw)
	l.FahrzeugMaxEntladeKw = kopie(ev.MaxDischargeKw)
	l.FahrzeugMinEntladeKw = kopie(ev.MinDischargeKw)
	if ev.DepartureAt != nil {
		t := *ev.DepartureAt
		l.FahrzeugAbfahrtAt = &t
	}
}

// PlanEintragen fills the plan part: the entity's vehicle block and the
// feed-back wish of the current slot (a negative setpoint_kw).
func PlanEintragen(l *Lage, p *plan2.Plan, entityID string) {
	if p == nil || entityID == "" {
		return
	}
	l.PlanFrisch = p.Fresh(l.Jetzt)
	pe := p.Entity(entityID)
	if pe == nil || pe.Fahrzeug == nil {
		return
	}
	f := pe.Fahrzeug
	l.Freigabe = FreigabeLesen(f.Rueckspeisen)
	l.MindestSocPct = kopie(f.MindestSocPct)
	l.AbfahrtSocPct = kopie(f.AbfahrtSocPct)
	l.KapazitaetKwh = kopie(f.KapazitaetKwh)
	l.RueckspeiseleistungKw = kopie(f.RueckspeiseleistungKw)
	if f.AbfahrtAt != nil {
		t := *f.AbfahrtAt
		l.AbfahrtAt = &t
	}
	if cmds, _, ok := p.ActiveCommands(entityID, l.Jetzt); ok && cmds.SetpointKw != nil && *cmds.SetpointKw < 0 {
		l.WunschKw = -*cmds.SetpointKw
	}
}

// WunschAusPlan reports whether a slot command of a vehicle entity is the
// feed-back wish - the agent keeps it away from the arbiter, which would
// refuse a setpoint on a charge point (consumers only consume).
func WunschAusPlan(pe *plan2.Entity, setpointKw *float64) bool {
	return pe != nil && pe.Fahrzeug != nil && setpointKw != nil && *setpointKw < 0 && !math.IsNaN(*setpointKw)
}

func kopie(p *float64) *float64 {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}
