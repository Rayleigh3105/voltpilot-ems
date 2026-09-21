package guards

import (
	"math"
	"path/filepath"
	"testing"
	"time"
)

// AP-15 IP-22: the loss of a fixed feed-in share, case R2 of the concept
// (referenzfaelle.json: grenze_kw 70, anteile E-1 40 / E-4 30,
// pv_verwaltung_spitze_kw 57, half-sine 06:00-20:00, 160.2 kWh in 9 h).

func f(v float64) *float64 { return &v }

// r2Cap is CapAnteil's verdict for Box Verwaltung (steuert_mit): its share of
// 30 kW binds, the shadow without a share would allow the whole 70 kW.
func r2Cap() ExportCap {
	return ExportCap{Active: true, CapKw: 30, AnteilKw: f(30), HeuteCapKw: f(70), State: ExportLimiting}
}

func halbsinus(t time.Time) float64 {
	tag := time.Date(t.Year(), t.Month(), t.Day(), 6, 0, 0, 0, berlin)
	x := t.Sub(tag).Hours() / 14
	if x <= 0 || x >= 1 {
		return 0
	}
	return 57 * math.Sin(math.Pi*x)
}

// laufR2 runs the R2 day in steps of dt from von to bis; the plant produces
// the half-sine, held at the share's cap.
func laufR2(v *AnteilVerlust, von, bis time.Time, dt time.Duration, verfuegbarBekannt bool) {
	for t := von; !t.After(bis); t = t.Add(dt) {
		verf := halbsinus(t)
		pv := math.Min(verf, 30)
		if verfuegbarBekannt {
			v.ZaehleVerfuegbar(t, r2Cap(), false, &pv, &verf)
		} else {
			v.Zaehle(t, r2Cap(), false, &pv)
		}
	}
}

var junitag = time.Date(2026, 6, 17, 0, 0, 0, 0, berlin)

// Test R2: 160.2 kWh on the example day. The concept sums quarter-hour
// midpoints (160.2 rounded); the exact integral of the half-sine above 30 kW
// is 160.16 kWh. The box integrates every evaluation (here 10 s) with the
// rate of the previous one - tolerance 0.1 kWh, the rounding of the heartbeat.
func TestR2AnteilsVerlust160KwhAmBeispieltag(t *testing.T) {
	v := NewAnteilVerlust(berlin, "")
	laufR2(v, junitag.Add(5*time.Hour), junitag.Add(21*time.Hour), 10*time.Second, true)
	h, _ := v.Stand()
	if h.Tag != "2026-06-17" {
		t.Fatalf("tag %q", h.Tag)
	}
	t.Logf("R2: %.2f kWh in %.3f h", h.Kwh, h.GebundenS/3600)
	if math.Abs(h.Kwh-160.2) > 0.1 {
		t.Fatalf("R2: %.2f kWh, erwartet 160,2 (+-0,1)", h.Kwh)
	}
	// 9 h in the concept (quarter-hours above 30 kW); the box also counts the
	// 0.3 kW band just under the cap where the producers already sit at it
	if std := h.GebundenS / 3600; std < 9.0 || std > 9.25 {
		t.Fatalf("R2: %.3f h gebunden, erwartet ~9", std)
	}
}

// The field reading on the same day: the box only knows the MEASURED PV, and
// that sits at the cap - the kWh are a lower bound near 0, the hours exact.
func TestR2FeldLesartIstUntergrenze(t *testing.T) {
	v := NewAnteilVerlust(berlin, "")
	laufR2(v, junitag.Add(5*time.Hour), junitag.Add(21*time.Hour), 10*time.Second, false)
	h, _ := v.Stand()
	t.Logf("Feld-Lesart: %.2f kWh in %.3f h", h.Kwh, h.GebundenS/3600)
	if h.Kwh > 1 || h.Kwh < 0 {
		t.Fatalf("Feld-Lesart: %.2f kWh - erwartet eine Untergrenze nahe 0", h.Kwh)
	}
	if std := h.GebundenS / 3600; std < 9.0 || std > 9.25 {
		t.Fatalf("Feld-Lesart: %.3f h gebunden", std)
	}
}

func TestAnteilBindetNichtZaehltNull(t *testing.T) {
	for name, c := range map[string]ExportCap{
		// the shadow without a share holds the same cap: the limit binds, not the share
		"schatten gleich eng": {Active: true, CapKw: 30, AnteilKw: f(30), HeuteCapKw: f(30)},
		"schatten enger":      {Active: true, CapKw: 30, AnteilKw: f(30), HeuteCapKw: f(25)},
		// no share document: Cap, never counted
		"ohne dokument": {Active: true, CapKw: 30, HeuteCapKw: f(70)},
	} {
		if kw, geb := AnteilVerlustKw(c, false, f(30), f(57)); kw != 0 || geb {
			t.Fatalf("%s: %.2f kW, gebunden %v", name, kw, geb)
		}
	}
	// the producers run below the cap: nothing held back
	if kw, geb := AnteilVerlustKw(r2Cap(), false, f(20), f(20)); kw != 0 || geb {
		t.Fatalf("unter der Kappe: %.2f %v", kw, geb)
	}
	// no PV measurement: unknown, not zero - not counted at all
	if kw, geb := AnteilVerlustKw(r2Cap(), false, nil, f(57)); kw != 0 || geb {
		t.Fatalf("ohne Messung: %.2f %v", kw, geb)
	}
	// without a plan limit the shadow holds nothing: the whole available counts
	c := r2Cap()
	c.HeuteCapKw = nil
	if kw, geb := AnteilVerlustKw(c, false, f(30), f(57)); kw != 27 || !geb {
		t.Fatalf("ohne Grenze im Plan: %.2f %v", kw, geb)
	}
	// never above what the shadow allows
	c.HeuteCapKw = f(40)
	if kw, _ := AnteilVerlustKw(c, false, f(30), f(57)); kw != 10 {
		t.Fatalf("Schatten begrenzt: %.2f", kw)
	}
}

// The leading box with a fresh measurement regulates against the WHOLE limit:
// its curtailment is not a share loss. Blind, it falls to its share - then the
// share binds and counts.
func TestFuehrendeBoxFrischIstKeinAnteilsVerlust(t *testing.T) {
	frisch := ExportCap{Active: true, CapKw: 30, AnteilKw: f(40), HeuteCapKw: f(70), PvKw: f(30)}
	if kw, geb := AnteilVerlustKw(frisch, true, f(30), f(57)); kw != 0 || geb {
		t.Fatalf("fuehrt frisch: %.2f %v", kw, geb)
	}
	blind := frisch
	blind.Blind, blind.CapKw = true, 40
	if kw, geb := AnteilVerlustKw(blind, true, f(40), f(57)); kw != 17 || !geb {
		t.Fatalf("fuehrt blind: %.2f %v", kw, geb)
	}
	// the same evaluation as steuert_mit counts even with a fresh measurement
	if kw, geb := AnteilVerlustKw(frisch, false, f(30), f(57)); kw != 27 || !geb {
		t.Fatalf("steuert_mit frisch: %.2f %v", kw, geb)
	}
}

// Through the real watchdog: a co-controlling box with a fresh measurement at
// its own point, share 30 kW, plan limit 70 kW - CapAnteil reports the shadow
// and the share binds; with a share of 70 kW it does not.
func TestCapAnteilMeldetSchatten(t *testing.T) {
	l := NewExportLimiter()
	now := junitag.Add(12 * time.Hour)
	limit := 70.0
	for i := 0; i < 120; i++ {
		ts := now.Add(time.Duration(i) * time.Second)
		pv := 30.0
		l.ObserveMitSpeicher(ts, -pv, pv, f(0))
		l.CapAnteil(ts, &limit, ExportAnteil{AnteilKw: 30}, 0)
	}
	ts := now.Add(120 * time.Second)
	l.ObserveMitSpeicher(ts, -30, 30, f(0))
	c := l.CapAnteil(ts, &limit, ExportAnteil{AnteilKw: 30}, 0)
	if c.HeuteCapKw == nil || !(c.CapKw < *c.HeuteCapKw) {
		t.Fatalf("Schatten fehlt oder nicht weiter: cap %.2f heute %v", c.CapKw, c.HeuteCapKw)
	}
	if _, geb := AnteilVerlustKw(c, false, f(30), f(57)); !geb {
		t.Fatalf("Anteil 30 kW bindet nicht: %+v", c)
	}
	// Cap without a share never carries the shadow
	if c2 := NewExportLimiter().Cap(ts, &limit, 70); c2.HeuteCapKw != nil {
		t.Fatal("Cap meldet einen Schatten")
	}
}

// A restart in the middle of the day continues the counter from disk; the
// gap itself is not counted.
func TestNeustartMittenAmTagZaehltWeiter(t *testing.T) {
	dir := t.TempDir()
	ganz := NewAnteilVerlust(berlin, "")
	laufR2(ganz, junitag.Add(5*time.Hour), junitag.Add(21*time.Hour), 10*time.Second, true)
	voll, _ := ganz.Stand()

	a := NewAnteilVerlust(berlin, dir)
	laufR2(a, junitag.Add(5*time.Hour), junitag.Add(13*time.Hour), 10*time.Second, true)
	if err := a.Speichern(); err != nil {
		t.Fatal(err)
	}
	b := NewAnteilVerlust(berlin, dir)
	if err := b.Laden(junitag.Add(13*time.Hour + 30*time.Second)); err != nil {
		t.Fatal(err)
	}
	laufR2(b, junitag.Add(13*time.Hour+30*time.Second), junitag.Add(21*time.Hour), 10*time.Second, true)
	h, _ := b.Stand()
	// 30 s gap at 13:00 with ~27 kW held back = ~0.23 kWh not counted
	if d := voll.Kwh - h.Kwh; d < 0 || d > 0.3 {
		t.Fatalf("nach Neustart %.2f kWh, ohne %.2f", h.Kwh, voll.Kwh)
	}
	if h.Kwh < 150 {
		t.Fatalf("Zaehler lief nicht weiter: %.2f", h.Kwh)
	}
	if _, err := filepath.Glob(filepath.Join(dir, "*.tmp")); err != nil {
		t.Fatal(err)
	}
}

// The local midnight closes the day: the interval across it is split, the
// closed day becomes vortag, and a counter loaded the next day keeps it.
func TestTageswechselInOrtszeit(t *testing.T) {
	dir := t.TempDir()
	v := NewAnteilVerlust(berlin, dir)
	c := ExportCap{Active: true, CapKw: 20, AnteilKw: f(20), HeuteCapKw: f(70)}
	// 10 kW held back from 23:59:00 to 00:01:00 local time (22:59 UTC in summer)
	start := time.Date(2026, 6, 17, 23, 59, 0, 0, berlin)
	for t0 := start; !t0.After(start.Add(2 * time.Minute)); t0 = t0.Add(20 * time.Second) {
		v.ZaehleVerfuegbar(t0, c, false, f(20), f(30))
	}
	h, vt := v.Stand()
	if h.Tag != "2026-06-18" || vt == nil || vt.Tag != "2026-06-17" {
		t.Fatalf("heute %+v vortag %+v", h, vt)
	}
	if math.Abs(vt.GebundenS-60) > 1e-6 || math.Abs(h.GebundenS-60) > 1e-6 {
		t.Fatalf("Aufteilung: vortag %.1f s, heute %.1f s", vt.GebundenS, h.GebundenS)
	}
	if err := v.Speichern(); err != nil {
		t.Fatal(err)
	}
	// a restart on the NEXT day: the stored day becomes vortag
	w := NewAnteilVerlust(berlin, dir)
	if err := w.Laden(time.Date(2026, 6, 19, 8, 0, 0, 0, berlin)); err != nil {
		t.Fatal(err)
	}
	h2, vt2 := w.Stand()
	if h2.Tag != "2026-06-19" || h2.Kwh != 0 || vt2 == nil || vt2.Tag != "2026-06-18" {
		t.Fatalf("Laden am Folgetag: heute %+v vortag %+v", h2, vt2)
	}
	// older than yesterday: nothing is carried over
	x := NewAnteilVerlust(berlin, dir)
	if err := x.Laden(time.Date(2026, 6, 25, 8, 0, 0, 0, berlin)); err != nil {
		t.Fatal(err)
	}
	if h3, vt3 := x.Stand(); h3.Kwh != 0 || vt3 != nil {
		t.Fatalf("alter Stand uebernommen: %+v %+v", h3, vt3)
	}
}

// A gap longer than VerlustLuecke (the loop stalled) is not integrated.
func TestLueckeWirdNichtGezaehlt(t *testing.T) {
	v := NewAnteilVerlust(berlin, "")
	t0 := junitag.Add(12 * time.Hour)
	v.ZaehleVerfuegbar(t0, r2Cap(), false, f(30), f(57))
	v.ZaehleVerfuegbar(t0.Add(10*time.Minute), r2Cap(), false, f(30), f(57))
	if h, _ := v.Stand(); h.Kwh != 0 || h.GebundenS != 0 {
		t.Fatalf("Luecke gezaehlt: %+v", h)
	}
}
