package entladeschutz

import (
	"context"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan2"
)

// saeule is a station double: it records every setpoint and answers status.
type saeule struct {
	mu       sync.Mutex
	gesendet []float64
	status   string
	err      error
}

func (s *saeule) SetV2XSetpoint21(_ context.Context, _ string, _ int, kw float64) (csms.V2XSetpoint, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gesendet = append(s.gesendet, kw)
	if s.err != nil {
		return csms.V2XSetpoint{}, s.err
	}
	st := s.status
	if st == "" {
		st = "Accepted"
	}
	return csms.V2XSetpoint{SetpointKw: kw, Status: st}, nil
}

func (s *saeule) liste() []float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]float64(nil), s.gesendet...)
}

var sp = Steckplatz{ChargerID: "WB-1", Connector: 1}

func gleich(a, b []float64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if d := a[i] - b[i]; d > 1e-9 || d < -1e-9 {
			return false
		}
	}
	return true
}

func TestWaechterSendetErneuertUndSenktSofort(t *testing.T) {
	s := &saeule{}
	w := NewWaechter()
	l := basis()
	w.Schritt(context.Background(), s, sp, l)
	if !w.Reserviert(sp.ChargerID, sp.Connector) || !gleich(s.liste(), []float64{-3.3}) {
		t.Fatalf("start: reserviert=%v gesendet=%v", w.Reserviert(sp.ChargerID, sp.Connector), s.liste())
	}
	// Same decision 2 s later: no message; after Erneuern: renewed.
	l.Jetzt, l.NetzZeit, l.SocZeit = l.Jetzt.Add(Takt), l.Jetzt.Add(Takt), l.Jetzt.Add(Takt)
	l.AktuellEntladenKw, l.NetzKw = 3.3, f(0.2)
	w.Schritt(context.Background(), s, sp, l)
	if len(s.liste()) != 1 {
		t.Fatalf("ohne Änderung gesendet: %v", s.liste())
	}
	l.Jetzt, l.NetzZeit, l.SocZeit = abend.Add(Erneuern), abend.Add(Erneuern), abend.Add(Erneuern)
	w.Schritt(context.Background(), s, sp, l)
	if !gleich(s.liste(), []float64{-3.3, -3.3}) {
		t.Fatalf("Erneuern: %v", s.liste())
	}
	// The kettle switches off: the meter shows 1 kW feed-in -> cut at once.
	l.Jetzt = l.Jetzt.Add(Takt)
	l.NetzZeit, l.SocZeit = l.Jetzt, l.Jetzt
	l.NetzKw = f(-1)
	w.Schritt(context.Background(), s, sp, l)
	if got := s.liste(); !gleich(got, []float64{-3.3, -3.3, -2.1}) {
		t.Fatalf("Senkung nicht sofort: %v", got)
	}
}

func TestWaechterAbbruchBeimAbsteckenSofort(t *testing.T) {
	s := &saeule{}
	w := NewWaechter()
	frei := 0
	w.Freigegeben = func() { frei++ }
	l := basis()
	w.Schritt(context.Background(), s, sp, l)
	// Unplugged 2 s later - between two plans: released in the same Takt,
	// nothing sent (the session is gone), the load management is woken.
	l.Jetzt = l.Jetzt.Add(Takt)
	l.Angesteckt = false
	e := w.Schritt(context.Background(), s, sp, l)
	if e.Grund != GrundAbgesteckt || w.Reserviert(sp.ChargerID, sp.Connector) || frei != 1 || len(s.liste()) != 1 {
		t.Fatalf("abstecken: %+v reserviert=%v frei=%d gesendet=%v", e, w.Reserviert(sp.ChargerID, sp.Connector), frei, s.liste())
	}
	// A new vehicle on the same connector inherits nothing.
	l.Angesteckt = true
	l.FahrzeugBidirektional = false
	if e := w.Schritt(context.Background(), s, sp, l); e.EntladenKw != 0 || len(s.liste()) != 1 {
		t.Fatalf("neues Fahrzeug: %+v %v", e, s.liste())
	}
}

func TestWaechterVerbindungsverlust(t *testing.T) {
	// Station lost: nothing can be sent - released, the station's fuse
	// (csms.V2XDischargeFuse) ends the feed-back.
	s := &saeule{}
	w := NewWaechter()
	l := basis()
	w.Schritt(context.Background(), s, sp, l)
	l.Verbunden = false
	if e := w.Schritt(context.Background(), s, sp, l); e.Grund != GrundVerbindungVerloren || w.Reserviert(sp.ChargerID, sp.Connector) || len(s.liste()) != 1 {
		t.Fatalf("säule weg: %+v %v", e, s.liste())
	}
	if csms.V2XDischargeFuse > 30*time.Second || csms.V2XDischargeFuse < 3*Erneuern {
		t.Fatalf("Sicherung %v passt nicht zu Erneuern %v", csms.V2XDischargeFuse, Erneuern)
	}
	// Cloud lost: the vehicle is told to stop at once (setpoint 0).
	s = &saeule{}
	w = NewWaechter()
	l = basis()
	w.Schritt(context.Background(), s, sp, l)
	l.CloudVerbunden = false
	if e := w.Schritt(context.Background(), s, sp, l); e.Grund != GrundCloudGetrennt || !gleich(s.liste(), []float64{-3.3, 0}) || w.Reserviert(sp.ChargerID, sp.Connector) {
		t.Fatalf("cloud weg: %+v %v", e, s.liste())
	}
}

func TestWaechterFreigabeZurueckgenommen(t *testing.T) {
	s := &saeule{}
	w := NewWaechter()
	l := basis()
	w.Schritt(context.Background(), s, sp, l)
	l.Freigabe = FreigabeAus
	w.Schritt(context.Background(), s, sp, l)
	if !gleich(s.liste(), []float64{-3.3, 0}) || w.Reserviert(sp.ChargerID, sp.Connector) {
		t.Fatalf("freigabe aus: %v", s.liste())
	}
}

func TestWaechterAblehnungUndSchalter(t *testing.T) {
	s := &saeule{status: "Rejected"}
	w := NewWaechter()
	l := basis()
	if e := w.Schritt(context.Background(), s, sp, l); e.Grund != GrundNichtAngenommen || w.Reserviert(sp.ChargerID, sp.Connector) {
		t.Fatalf("abgelehnt: %+v", e)
	}
	l.Jetzt = l.Jetzt.Add(Takt)
	l.NetzZeit, l.SocZeit = l.Jetzt, l.Jetzt
	w.Schritt(context.Background(), s, sp, l)
	if !gleich(s.liste(), []float64{-3.3, 0}) { // refusal, stop, then quiet until Erneuern
		t.Fatalf("Ablehnung ohne Pause: %v", s.liste())
	}
	// Switch off: the decision refuses before the station is asked.
	s = &saeule{err: csms.ErrV2XDischargeOff}
	w = NewWaechter()
	l = basis()
	l.Schalter = false
	if e := w.Schritt(context.Background(), s, sp, l); e.Grund != GrundSchalterAus || len(s.liste()) != 0 {
		t.Fatalf("schalter aus: %+v %v", e, s.liste())
	}
}

func TestSaeuleUndPlanEintragen(t *testing.T) {
	jetzt := time.Date(2026, 10, 1, 17, 0, 0, 0, time.UTC)
	abfahrt := jetzt.Add(14 * time.Hour)
	c := &csms.ChargerState{Connected: true, LastSeen: jetzt.Add(-10 * time.Second), OCPPVersion: csms.OCPPVersion21}
	c.RatedKw = 11
	con := &csms.Connector{ID: 1, Status: "Charging", Session: &csms.Session{TransactionID: 7},
		SocPct: f(55), SocMeasuredAt: jetzt.Add(-time.Minute),
		V2X: &csms.V2XSetpoint{SetpointKw: -3, Status: "Accepted", SentAt: jetzt.Add(-5 * time.Second)},
		EV: &csms.EVNeeds{ReportedAt: jetzt, Bidirectional: true, SocPct: f(56), CapacityKwh: f(64),
			DepartureAt: &abfahrt, TargetSocPct: f(85), MaxDischargeKw: f(9), MinV2XEnergyKwh: f(-4)}}
	l := Lage{Jetzt: jetzt}
	SaeuleEintragen(&l, c, con)
	if !l.Verbunden || !l.OCPP21 || !l.Angesteckt || !l.FahrzeugBidirektional || *l.SocPct != 56 ||
		*l.FahrzeugKapazitaetKwh != 64 || *l.FahrzeugMaxEntladeKw != 9 || l.AktuellEntladenKw != 3 ||
		*l.LadeleistungKw != 11 || !l.FahrzeugAbfahrtAt.Equal(abfahrt) || *l.FahrzeugZielSocPct != 85 {
		t.Fatalf("säule: %+v", l)
	}
	// An expired discharge profile (older than the station's fuse) no longer
	// counts as running feed-back.
	con.V2X.SentAt = jetzt.Add(-csms.V2XDischargeFuse - time.Second)
	l = Lage{Jetzt: jetzt}
	SaeuleEintragen(&l, c, con)
	if l.AktuellEntladenKw != 0 {
		t.Fatalf("abgelaufenes Profil zählt: %v", l.AktuellEntladenKw)
	}
	// A station silent for longer than MaxStilleSaeule is lost even with an
	// open socket; Available means unplugged.
	c.LastSeen = jetzt.Add(-MaxStilleSaeule - time.Second)
	con.Status = csms.StatusAvailable
	l = Lage{Jetzt: jetzt}
	SaeuleEintragen(&l, c, con)
	if l.Verbunden || l.Angesteckt {
		t.Fatalf("still/abgesteckt: %+v", l)
	}

	payload := []byte(`{"schema_version":"2.0","tenant_id":"00000000-0000-0000-0000-000000000001",
	 "site_id":"00000000-0000-0000-0000-000000000002","device_id":"00000000-0000-0000-0000-000000000003",
	 "plan_id":"00000000-0000-0000-0000-000000000004","generated_at":"2026-10-01T17:00:00Z","slot_minutes":15,
	 "entities":[{"entity_id":"wb-1","kind":"ev-charger",
	   "fahrzeug":{"rueckspeisen":"v2h","mindest_soc_pct":40,"abfahrt":"2026-10-02T05:00:00Z","abfahrt_soc_pct":80,
	     "kapazitaet_kwh":60,"rueckspeiseleistung_kw":10},
	   "slots":[{"start":"2026-10-01T17:00:00Z","commands":{"setpoint_kw":-6}}]},
	  {"entity_id":"wb-2","slots":[{"start":"2026-10-01T17:00:00Z","commands":{"setpoint_kw":-6}}]}]}`)
	p, err := plan2.Parse(payload, jetzt)
	if err != nil {
		t.Fatal(err)
	}
	l = Lage{Jetzt: jetzt.Add(time.Minute)}
	PlanEintragen(&l, p, "wb-1")
	if !l.PlanFrisch || l.Freigabe != FreigabeV2H || l.WunschKw != 6 || *l.MindestSocPct != 40 ||
		*l.AbfahrtSocPct != 80 || *l.KapazitaetKwh != 60 || *l.RueckspeiseleistungKw != 10 ||
		!l.AbfahrtAt.Equal(time.Date(2026, 10, 2, 5, 0, 0, 0, time.UTC)) {
		t.Fatalf("plan: %+v", l)
	}
	// An entity without the vehicle block: no consent, no wish.
	l = Lage{Jetzt: jetzt.Add(time.Minute)}
	PlanEintragen(&l, p, "wb-2")
	if l.Freigabe != "" || l.WunschKw != 0 || Entscheiden(l).Grund != GrundSchalterAus {
		t.Fatalf("ohne block: %+v", l)
	}
	if !WunschAusPlan(p.Entity("wb-1"), f(-6)) || WunschAusPlan(p.Entity("wb-2"), f(-6)) || WunschAusPlan(p.Entity("wb-1"), f(6)) {
		t.Fatal("WunschAusPlan")
	}
}
