package entladeschutz

import (
	"math"
	"testing"
	"time"
)

func f(v float64) *float64 { return &v }

var abend = time.Date(2026, 10, 1, 19, 0, 0, 0, time.FixedZone("CEST", 2*3600))

// basis is an evening at a V2H wallbox where everything allows feeding back:
// house draws 3.5 kW, vehicle at 60 % of 60 kWh, reserve 40 %, departure
// tomorrow 07:00 with 80 %, plan wishes 10 kW.
func basis() Lage {
	abfahrt := abend.Add(12 * time.Hour)
	return Lage{
		Jetzt: abend, Schalter: true,
		PlanFrisch: true, CloudVerbunden: true, Freigabe: FreigabeV2H, WunschKw: 10,
		MindestSocPct: f(40), AbfahrtAt: &abfahrt, AbfahrtSocPct: f(80), KapazitaetKwh: f(60),
		Verbunden: true, OCPP21: true, Angesteckt: true,
		RueckspeiseleistungKw: f(10), LadeleistungKw: f(11), StationsleistungKw: f(11),
		FahrzeugBidirektional: true, SocPct: f(60), SocZeit: abend,
		FahrzeugMaxLadeKw: f(11), FahrzeugMaxEntladeKw: f(11),
		NetzKw: f(3.5), NetzZeit: abend, ExportgrenzeKw: f(7),
	}
}

func pruefe(t *testing.T, name string, l Lage, kw float64, grund string) {
	t.Helper()
	e := Entscheiden(l)
	if math.Abs(e.EntladenKw-kw) > 1e-9 || e.Grund != grund {
		t.Errorf("%s: %.3f kW %q, erwartet %.3f kW %q", name, e.EntladenKw, e.Grund, kw, grund)
	}
	if e.EntladenKw < 0 {
		t.Errorf("%s: negative Rückspeisung %.3f", name, e.EntladenKw)
	}
}

func TestBasisV2HDecktNurDasHaus(t *testing.T) {
	// 3.5 kW house - 0.2 kW dead band: never Erzeugung im Ladepunkt while the
	// site feeds in (A1 S. 11, Abschn. 2.1.3).
	pruefe(t, "basis", basis(), 3.3, GrundNurHaus)
	if e := Entscheiden(basis()); e.Modus != FreigabeV2H {
		t.Fatalf("Modus %q", e.Modus)
	}
}

func TestSchalterAusEntlaedtNie(t *testing.T) {
	l := basis()
	l.Schalter = false
	pruefe(t, "schalter", l, 0, GrundSchalterAus)
}

func TestFreigabeDesFahrers(t *testing.T) {
	for _, wort := range []string{"", "aus", "ja", "V2G", " v2x "} {
		l := basis()
		l.Freigabe = FreigabeLesen(wort)
		pruefe(t, "freigabe "+wort, l, 0, GrundFreigabeAus)
	}
	l := basis()
	l.Freigabe = ""
	pruefe(t, "freigabe fehlt", l, 0, GrundFreigabeAus)

	// v2h: house only; v2g: house and grid up to the export limit.
	l = basis()
	l.Freigabe = FreigabeLesen("v2h")
	pruefe(t, "v2h", l, 3.3, GrundNurHaus)
	l = basis()
	l.Freigabe = FreigabeLesen("v2g")
	pruefe(t, "v2g", l, 10, "") // 3.5 + 7 - 0.2 = 10.3 > wish 10 = wallbox 10
	l.WunschKw = 11
	pruefe(t, "v2g wallbox", l, 10, GrundLeistungsgrenze)
}

func TestExportgrenze(t *testing.T) {
	l := basis()
	l.Freigabe = FreigabeV2G
	l.NetzKw = f(-5)                                      // PV feeds in 5 kW already
	pruefe(t, "pv speist ein", l, 1.8, GrundExportgrenze) // -5 + 7 - 0.2
	l.NetzKw = f(-6.9)
	pruefe(t, "grenze erreicht", l, 0, GrundExportgrenze)
	// While feeding back 4 kW (accepted), the meter shows 2 kW feed-in: the
	// balance without the charge point is +2 kW, so 2 + 7 - 0.2.
	l.NetzKw, l.AktuellEntladenKw = f(-2), 4
	pruefe(t, "mit laufender rückspeisung", l, 8.8, GrundExportgrenze)
	// No export limit configured: V2G feeds in nothing (behaves like V2H).
	l = basis()
	l.Freigabe, l.ExportgrenzeKw = FreigabeV2G, nil
	pruefe(t, "ohne exportgrenze", l, 3.3, GrundExportgrenze)
	l.ExportgrenzeKw = f(0)
	pruefe(t, "nulleinspeisung", l, 3.3, GrundExportgrenze)
}

func TestNurHausBeiGleichzeitigerEinspeisung(t *testing.T) {
	l := basis()
	l.NetzKw = f(-1) // the site feeds in, nothing fed back yet
	pruefe(t, "einspeisung", l, 0, GrundNurHaus)
	// Feeding back 3 kW while the meter shows 0.5 kW feed-in: cut at once.
	l.NetzKw, l.AktuellEntladenKw = f(-0.5), 3
	pruefe(t, "einspeisung beim rückspeisen", l, 2.3, GrundNurHaus)
}

func TestParagraph14a(t *testing.T) {
	// Departure in 3 h 15 min, 70 % now, target 80 %: reachable with 11 kW
	// (50.7 %-points in 3 h), not with an observed § 14a envelope of 1 kW
	// (4.6 %-points) - the box keeps the target reachable at the dimmed power.
	l := basis()
	abfahrt := abend.Add(3*time.Hour + 15*time.Minute)
	l.AbfahrtAt, l.SocPct = &abfahrt, f(70)
	pruefe(t, "ohne 14a", l, 3.3, GrundNurHaus)
	l.Paragraph14aKw = f(1)
	pruefe(t, "14a gedimmt", l, 0, GrundAbfahrtsziel)
	// An envelope above the wallbox does not change anything (restrict-only).
	l.Paragraph14aKw = f(22)
	pruefe(t, "14a weit", l, 3.3, GrundNurHaus)
}

func TestMindestLadestandReserve(t *testing.T) {
	for _, c := range []struct {
		soc   float64
		kw    float64
		grund string
	}{{40, 0, GrundMindestSoc}, {41, 0, GrundMindestSoc}, {39, 0, GrundMindestSoc}, {41.5, 3.3, GrundNurHaus}} {
		l := basis()
		l.SocPct, l.AbfahrtSocPct = f(c.soc), f(40)
		pruefe(t, "soc", l, c.kw, c.grund)
	}
	l := basis()
	l.MindestSocPct = nil
	pruefe(t, "reserve nicht gesagt", l, 0, GrundMindestSocUnbekannt)
	l = basis()
	l.FahrzeugUnterV2XKwh = f(2)
	pruefe(t, "fahrzeug unter v2x-bereich", l, 0, GrundUnterV2XBereich)
	l.FahrzeugUnterV2XKwh = f(-5)
	pruefe(t, "fahrzeug im v2x-bereich", l, 3.3, GrundNurHaus)
}

func TestAbfahrtszielBleibtErreichbar(t *testing.T) {
	l := basis()
	vorbei := abend.Add(-time.Minute)
	l.AbfahrtAt = &vorbei
	pruefe(t, "abfahrt vorbei", l, 0, GrundAbfahrtsziel)
	// The vehicle reports an earlier departure (20:00) and a higher target
	// than the plan: 45 min at 11 kW are 12.7 %-points, 60 % < 90 - 12.7.
	l = basis()
	frueh := abend.Add(time.Hour)
	l.FahrzeugAbfahrtAt, l.FahrzeugZielSocPct = &frueh, f(90)
	pruefe(t, "fahrzeug früher", l, 0, GrundAbfahrtsziel)
	// Just reachable: 12 h are plenty for 60 -> 80 %.
	pruefe(t, "erreichbar", basis(), 3.3, GrundNurHaus)
	// Unknown departure, capacity or charging power: no feed-back.
	for name, mut := range map[string]func(*Lage){
		"abfahrt":   func(l *Lage) { l.AbfahrtAt = nil },
		"ziel":      func(l *Lage) { l.AbfahrtSocPct = nil },
		"kapazität": func(l *Lage) { l.KapazitaetKwh = nil },
		"ladeleistung": func(l *Lage) {
			l.LadeleistungKw, l.FahrzeugMaxLadeKw = nil, nil
		},
	} {
		l := basis()
		mut(&l)
		pruefe(t, "unbekannt "+name, l, 0, GrundAbfahrtUnbekannt)
	}
	// The vehicle's own capacity alone is enough; the larger one counts.
	l = basis()
	l.KapazitaetKwh, l.FahrzeugKapazitaetKwh = nil, f(60)
	pruefe(t, "kapazität vom fahrzeug", l, 3.3, GrundNurHaus)
}

func TestAbsteckenUndVerbindungsverlust(t *testing.T) {
	for name, c := range map[string]struct {
		mut   func(*Lage)
		grund string
	}{
		"abgesteckt":        {func(l *Lage) { l.Angesteckt = false }, GrundAbgesteckt},
		"säule weg":         {func(l *Lage) { l.Verbunden = false }, GrundVerbindungVerloren},
		"cloud weg":         {func(l *Lage) { l.CloudVerbunden = false }, GrundCloudGetrennt},
		"plan veraltet":     {func(l *Lage) { l.PlanFrisch = false }, GrundPlanVeraltet},
		"netz veraltet":     {func(l *Lage) { l.NetzZeit = abend.Add(-MaxAlterNetz - time.Second) }, GrundNetzUnbekannt},
		"netz unbekannt":    {func(l *Lage) { l.NetzKw = nil }, GrundNetzUnbekannt},
		"ladestand alt":     {func(l *Lage) { l.SocZeit = abend.Add(-MaxAlterLadestand - time.Second) }, GrundLadestandUnbekannt},
		"ladestand fehlt":   {func(l *Lage) { l.SocPct = nil }, GrundLadestandUnbekannt},
		"kein ocpp 2.1":     {func(l *Lage) { l.OCPP21 = false }, GrundNichtOCPP21},
		"unidirektional":    {func(l *Lage) { l.FahrzeugBidirektional = false }, GrundNichtBidirektional},
		"eigener anschluss": {func(l *Lage) { l.EigenerNetzanschluss = true }, GrundEigenerNetzanschluss},
		"kein wunsch":       {func(l *Lage) { l.WunschKw = 0 }, GrundKeinWunsch},
		"laden gewünscht":   {func(l *Lage) { l.WunschKw = -3 }, GrundKeinWunsch},
	} {
		l := basis()
		c.mut(&l)
		pruefe(t, name, l, 0, c.grund)
	}
}

func TestLeistungsgrenzen(t *testing.T) {
	l := basis()
	l.RueckspeiseleistungKw, l.FahrzeugMaxEntladeKw = nil, nil
	pruefe(t, "leistung unbekannt", l, 0, GrundLeistungUnbekannt)
	l = basis()
	l.FahrzeugMinEntladeKw = f(4) // allowed 3.3 < vehicle minimum
	pruefe(t, "fahrzeug-mindestleistung", l, 0, GrundFahrzeugMindest)
	l = basis()
	l.NetzKw = f(0.6) // 0.4 kW allowed < MindestEntladenKw
	pruefe(t, "zu klein", l, 0, GrundNurHaus)
	l = basis()
	l.Freigabe, l.StationsleistungKw = FreigabeV2G, f(7.4)
	pruefe(t, "station", l, 7.4, GrundLeistungsgrenze)
}

// Unknown is not zero, and in doubt the vehicle charges: removing any single
// input never raises the feed-back.
func TestUnbekanntHebtNie(t *testing.T) {
	ref := Entscheiden(basis()).EntladenKw
	muts := []func(*Lage){
		func(l *Lage) { l.MindestSocPct = nil }, func(l *Lage) { l.AbfahrtAt = nil },
		func(l *Lage) { l.AbfahrtSocPct = nil }, func(l *Lage) { l.KapazitaetKwh = nil },
		func(l *Lage) { l.RueckspeiseleistungKw = nil }, func(l *Lage) { l.SocPct = nil },
		func(l *Lage) { l.NetzKw = nil }, func(l *Lage) { l.ExportgrenzeKw = nil },
		func(l *Lage) { l.FahrzeugMaxEntladeKw = nil }, func(l *Lage) { l.LadeleistungKw = nil },
		func(l *Lage) { l.NetzKw = f(math.NaN()) }, func(l *Lage) { l.SocPct = f(math.Inf(1)) },
	}
	for i, m := range muts {
		l := basis()
		m(&l)
		if got := Entscheiden(l).EntladenKw; got > ref {
			t.Errorf("Fall %d: %.3f kW > %.3f kW", i, got, ref)
		}
	}
}

// MiSpeL MP-39b (captain 04.10.2026: Aus, Schnell and a scene hold the
// feed-back): a local hold ends every feed-back, whatever the plan wishes -
// and names itself, not the plan's consent.
func TestHaltHaeltJedeRueckspeisung(t *testing.T) {
	for _, grund := range []string{GrundLademodusAus, GrundLademodusSchnell, GrundAutomatikPausiert} {
		l := basis()
		l.Halt = grund
		pruefe(t, grund, l, 0, grund)
		l.Freigabe = FreigabeV2G
		pruefe(t, grund+" v2g", l, 0, grund)
	}
	// The switch off still names the switch: it outranks every hold.
	l := basis()
	l.Schalter, l.Halt = false, GrundLademodusAus
	pruefe(t, "schalter vor halt", l, 0, GrundSchalterAus)
	// Without a hold the plan's stage applies again (Bestand byte-gleich).
	if e := Entscheiden(basis()); e.EntladenKw <= 0 || e.Grund == GrundLademodusAus {
		t.Fatalf("ohne halt: %+v", e)
	}
}
