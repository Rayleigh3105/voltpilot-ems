package entladeschutz

import (
	"context"
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ladepunktsim"
)

// simSaeule turns the guard's V2X setpoints into commands for the simulated
// wallbox (MP-34): negative = entladen, 0 = halt. The wallbox accepts.
type simSaeule struct {
	lp      *ladepunktsim.Ladepunkt
	befehle int
}

func (s *simSaeule) SetV2XSetpoint21(_ context.Context, _ string, _ int, kw float64) (csms.V2XSetpoint, error) {
	s.befehle++
	b := ladepunktsim.Befehl{Richtung: ladepunktsim.Halt}
	if kw < 0 {
		b = ladepunktsim.Befehl{Richtung: ladepunktsim.Entladen, LeistungKw: -kw}
	}
	return csms.V2XSetpoint{SetpointKw: kw, Status: "Accepted"}, s.lp.Befehlen(b)
}

type abendErgebnis struct {
	z2v, z2e, z1ne, maxExportKw float64
	minSoc                      float64
	socUm23                     float64
	befehleNachAbstecken        int
	abfahrten                   []ladepunktsim.Abfahrt
	ueberHaus                   bool // fed back more than the house drew in some minute
}

// fahreAbend runs the MP-34 evening (18:00 arrival with 60 % of 60 kWh,
// reserve 40 %, departure 07:00 with 80 %, house 2.5/3.5/2.0/0.5 kW) with
// the BOX GUARD as the controller: the plan wishes 10 kW feed-back until
// 23:00; from 01:00 the load management charges 11 kW to the target (the
// guard does not charge - that is lastmgmt's job, modelled as the test
// controller of MP-34). The wallbox is technically V2H AND V2G - whether
// anything reaches the grid is the guard's decision alone.
func fahreAbend(t *testing.T, freigabe Freigabe, export *float64, absteckenUm *time.Time) abendErgebnis {
	t.Helper()
	ort := time.FixedZone("CEST", 2*3600)
	tag := func(d, h, m int) time.Time { return time.Date(2026, 10, d, h, m, 0, 0, ort) }
	ankunft, abfahrt := tag(1, 18, 0), tag(2, 7, 0)
	nachtruhe, nachtladen := tag(1, 23, 0), tag(2, 1, 0)
	if absteckenUm != nil {
		abfahrt = *absteckenUm
	}
	lp, err := ladepunktsim.New(ladepunktsim.Faehigkeit{Nutzbarkeit: ladepunktsim.Bidirektional, V2H: true, V2G: true,
		LadeleistungKw: 11, RueckspeiseleistungKw: 10}, ankunft)
	if err != nil {
		t.Fatal(err)
	}
	if err := lp.Anstecken(ladepunktsim.Fahrzeug{KapazitaetKwh: 60, SocPct: 60, MindestSocPct: 0, AbfahrtSocPct: 80,
		MaxLadeKw: 11, MaxEntladeKw: 11}); err != nil {
		t.Fatal(err)
	}
	haus := func(t time.Time) float64 {
		switch h := t.Hour(); {
		case h == 18:
			return 2.5
		case h >= 19 && h < 21:
			return 3.5
		case h >= 21 && h < 23:
			return 2.0
		default:
			return 0.5
		}
	}
	s := &simSaeule{lp: lp}
	w := NewWaechter()
	planAbfahrt := tag(2, 7, 0)
	erg := abendErgebnis{minSoc: 100}
	var entladenKw float64 // the setpoint the wallbox accepted (actuator state)
	abgesteckt := false
	for jetzt := ankunft; jetzt.Before(tag(2, 7, 15)); jetzt = jetzt.Add(time.Minute) {
		if !abgesteckt && !jetzt.Before(abfahrt) {
			if _, err := lp.Abstecken(); err != nil {
				t.Fatal(err)
			}
			abgesteckt = true
		}
		m := lp.Messung()
		wunsch := 0.0
		if jetzt.Before(nachtruhe) {
			wunsch = 10
		}
		// The grid meter at t sees the house now and the wallbox's last step.
		netz := haus(jetzt) - entladenKw
		l := Lage{Jetzt: jetzt, Schalter: true, PlanFrisch: true, CloudVerbunden: true,
			Freigabe: freigabe, WunschKw: wunsch, MindestSocPct: f(40), AbfahrtAt: &planAbfahrt,
			AbfahrtSocPct: f(80), KapazitaetKwh: f(60), RueckspeiseleistungKw: f(10), LadeleistungKw: f(11),
			Verbunden: true, OCPP21: true, Angesteckt: m.Angesteckt, FahrzeugBidirektional: true,
			SocPct: m.SocPct, SocZeit: jetzt, FahrzeugMaxEntladeKw: f(11), FahrzeugMaxLadeKw: f(11),
			NetzKw: &netz, NetzZeit: jetzt, AktuellEntladenKw: entladenKw, ExportgrenzeKw: export}
		vorher := s.befehle
		e := w.Schritt(context.Background(), s, Steckplatz{"SIM", 1}, l)
		if abgesteckt && s.befehle > vorher {
			erg.befehleNachAbstecken++
		}
		entladenKw = e.EntladenKw
		if e.EntladenKw == 0 && m.Angesteckt {
			b := ladepunktsim.Befehl{Richtung: ladepunktsim.Halt}
			if !jetzt.Before(nachtladen) {
				b = ladepunktsim.Befehl{Richtung: ladepunktsim.Laden, LeistungKw: 11, BisSocPct: 80}
			}
			if err := lp.Befehlen(b); err != nil {
				t.Fatal(err)
			}
		}
		h := haus(jetzt)
		schritt := lp.Schritt(time.Minute, ladepunktsim.Umgebung{HauslastKw: h})
		entladenKw = schritt.ErzeugungKwh * 60 // what really flowed back
		erg.z2v += schritt.VerbrauchKwh
		erg.z2e += schritt.ErzeugungKwh
		netzKwh := h/60 + schritt.VerbrauchKwh - schritt.ErzeugungKwh
		if netzKwh < 0 {
			erg.z1ne += -netzKwh
			erg.maxExportKw = math.Max(erg.maxExportKw, -netzKwh*60)
		}
		if schritt.ErzeugungKwh > h/60+1e-9 {
			erg.ueberHaus = true
		}
		if soc := lp.Messung().SocPct; soc != nil {
			erg.minSoc = math.Min(erg.minSoc, *soc)
			if jetzt.Equal(nachtruhe.Add(-time.Minute)) {
				erg.socUm23 = *soc
			}
		}
	}
	erg.abfahrten = lp.Abfahrten()
	return erg
}

// TestSzenarioV2HAbendNurBisZurReserve is the MP-39 simulator evidence: the
// evening in the house only, never below the reserve, the target at 07:00.
func TestSzenarioV2HAbendNurBisZurReserve(t *testing.T) {
	erg := fahreAbend(t, FreigabeV2H, f(7), nil)
	// V2H: no Erzeugung im Ladepunkt while the site feeds in (A1 S. 11,
	// Abschn. 2.1.3) - not one Wh into the grid, though the wallbox could.
	if erg.z1ne != 0 || erg.ueberHaus {
		t.Fatalf("V2H speiste ins Netz: Z1NE %.4f kWh, über Haus %v", erg.z1ne, erg.ueberHaus)
	}
	// Reserve 40 % + margin: feeding back ends between 40 and 41.1 %.
	if erg.minSoc < 40 || erg.socUm23 > 41.1 || erg.socUm23 < 40 {
		t.Fatalf("Reserve: min %.3f %%, um 23:00 %.3f %%", erg.minSoc, erg.socUm23)
	}
	if erg.z2e < 9 || erg.z2e > 11 { // ≈ 19 %-points of 60 kWh at √0,85
		t.Fatalf("Z2E %.3f kWh", erg.z2e)
	}
	if len(erg.abfahrten) != 1 || !erg.abfahrten[0].Erreicht || erg.abfahrten[0].SocPct < 80-1e-6 {
		t.Fatalf("Abfahrt: %+v", erg.abfahrten)
	}
	t.Logf("V2H-Abend mit Wächter: Z2E %.3f kWh, Z2V %.3f kWh, Z1NE %.3f kWh, Ladestand um 23:00 %.2f %%, min %.2f %%, Abfahrt %.1f %%",
		erg.z2e, erg.z2v, erg.z1ne, erg.socUm23, erg.minSoc, erg.abfahrten[0].SocPct)
}

func TestSzenarioV2GBisZurExportgrenze(t *testing.T) {
	erg := fahreAbend(t, FreigabeV2G, f(7), nil)
	if erg.z1ne <= 0 || erg.maxExportKw > 7+1e-9 || erg.minSoc < 40 {
		t.Fatalf("V2G: Z1NE %.3f kWh, Export max %.3f kW, min SoC %.3f", erg.z1ne, erg.maxExportKw, erg.minSoc)
	}
	// Without an export limit the same consent feeds in nothing.
	if erg := fahreAbend(t, FreigabeV2G, nil, nil); erg.z1ne != 0 {
		t.Fatalf("V2G ohne Exportgrenze: Z1NE %.3f kWh", erg.z1ne)
	}
}

func TestSzenarioFreigabeAusUndAbstecken(t *testing.T) {
	if erg := fahreAbend(t, FreigabeAus, f(7), nil); erg.z2e != 0 {
		t.Fatalf("Freigabe aus: Z2E %.3f kWh", erg.z2e)
	}
	ort := time.FixedZone("CEST", 2*3600)
	um := time.Date(2026, 10, 1, 20, 0, 0, 0, ort)
	erg := fahreAbend(t, FreigabeV2H, f(7), &um)
	if erg.befehleNachAbstecken != 0 || len(erg.abfahrten) != 1 || !erg.abfahrten[0].Zeit.Equal(um) {
		t.Fatalf("Abstecken 20:00: %d Befehle danach, Abfahrten %+v", erg.befehleNachAbstecken, erg.abfahrten)
	}
}
