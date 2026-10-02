package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entladeschutz"
)

type v2xAttrappe struct{ gesendet []float64 }

func (s *v2xAttrappe) SetV2XSetpoint21(_ context.Context, _ string, _ int, kw float64) (csms.V2XSetpoint, error) {
	s.gesendet = append(s.gesendet, kw)
	return csms.V2XSetpoint{SetpointKw: kw, Status: "Accepted"}, nil
}

// MiSpeL MP-39: the switch is off by default - no guard, and the station
// server refuses every V2X setpoint before anything is sent.
func TestV2XEntladenVorgabeAus(t *testing.T) {
	if config.Defaults().V2XEntladen {
		t.Fatal("Config.V2XEntladen muss standardmäßig aus sein")
	}
	a := ocppAgent(t, nil)
	if a.v2x != nil || a.v2xReserviert("WB-1", 1) {
		t.Fatal("Wächter läuft ohne Schalter")
	}
	if _, err := a.ocpp.srv.SetV2XSetpoint21(context.Background(), "WB-1", 1, -3); !errors.Is(err, csms.ErrV2XDischargeOff) {
		t.Fatalf("V2X ohne Schalter: %v", err)
	}
	a.v2xStep(context.Background(), time.Now()) // no guard: a no-op, never a panic
}

// With the switch on, the guard runs and a connector it feeds back from is
// reserved for it - the load management leaves it alone (ocppApply).
func TestV2XEntladenReserviertDenStecker(t *testing.T) {
	a := ocppAgent(t, func(c *config.Config) { c.V2XEntladen = true })
	if a.v2x == nil {
		t.Fatal("kein Wächter trotz Schalter")
	}
	if _, err := a.ocpp.srv.SetV2XSetpoint21(context.Background(), "WB-1", 1, -3); errors.Is(err, csms.ErrV2XDischargeOff) {
		t.Fatalf("Schalter kommt nicht im Ladepunkt-Server an: %v", err)
	}
	f := func(v float64) *float64 { return &v }
	jetzt := time.Now()
	abfahrt := jetzt.Add(12 * time.Hour)
	l := entladeschutz.Lage{Jetzt: jetzt, Schalter: true, PlanFrisch: true, CloudVerbunden: true,
		Freigabe: entladeschutz.FreigabeV2H, WunschKw: 5, MindestSocPct: f(40), AbfahrtAt: &abfahrt,
		AbfahrtSocPct: f(80), KapazitaetKwh: f(60), RueckspeiseleistungKw: f(10), LadeleistungKw: f(11),
		Verbunden: true, OCPP21: true, Angesteckt: true, FahrzeugBidirektional: true,
		SocPct: f(60), SocZeit: jetzt, NetzKw: f(3), NetzZeit: jetzt}
	s := &v2xAttrappe{}
	sp := entladeschutz.Steckplatz{ChargerID: "WB-1", Connector: 1}
	a.v2x.Schritt(context.Background(), s, sp, l)
	if !a.v2xReserviert("WB-1", 1) || a.v2xReserviert("WB-1", 2) {
		t.Fatalf("Reservierung: %v", s.gesendet)
	}
	// The reserved connector vanished from the station list: the pass
	// releases it without sending (there is nothing to send to).
	a.v2xStep(context.Background(), jetzt.Add(entladeschutz.Takt))
	if a.v2xReserviert("WB-1", 1) {
		t.Fatal("verschwundener Stecker bleibt reserviert")
	}
}
