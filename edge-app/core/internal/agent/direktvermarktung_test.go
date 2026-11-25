package agent

// The guard half of Stage 2 (vp-direktvermarktung-konzept d2, E2): the
// partner's fresh set-point composes into the export watchdog as
// min(registered limit, partner limit); the F5 "acts on generation" variant
// becomes a PV cap instead; an expired or missing watchdog composes NOTHING.
// The battery-first behaviour of the composed limit itself is the cascade's
// (guards/exportcascade.go) - a compliance limit lets the storage charge
// first by construction, which the container probe shows end to end.

import (
	"context"
	"math"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/vermarktertunnel"
)

type fakeVermarkter struct {
	mu        sync.Mutex
	anschluss *vermarktertunnel.Anschluss
	kw        float64
	wirktAuf  string
	aktiv     bool
	werte     map[string]float64
	werteUm   time.Time
}

func (f *fakeVermarkter) Run(ctx context.Context) { <-ctx.Done() }

func (f *fakeVermarkter) Anschluss() (vermarktertunnel.Anschluss, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.anschluss == nil {
		return vermarktertunnel.Anschluss{}, false
	}
	return *f.anschluss, true
}

func (f *fakeVermarkter) SetValues(at time.Time, values map[string]float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.werteUm, f.werte = at, values
}

func (f *fakeVermarkter) Grenze() (float64, string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.kw, f.wirktAuf, f.aktiv
}

func (f *fakeVermarkter) Status() vermarktertunnel.Status {
	return vermarktertunnel.Status{Lage: vermarktertunnel.LageVerbunden}
}

func TestVermarkterGrenzenKomponiertDasMinimum(t *testing.T) {
	a := &Agent{}
	fv := &fakeVermarkter{kw: 3.6, wirktAuf: direktvermarkter.WirktAufEinspeisung, aktiv: true}
	a.vermarkter = fv

	// partner below the registered limit: the partner wins
	eff, pvCap := a.vermarkterGrenzen(fptr(30))
	if eff == nil || *eff != 3.6 || pvCap != nil {
		t.Fatalf("eff=%v pvCap=%v, want 3.6/nil", eff, pvCap)
	}
	// registered below the partner: the registered limit stays (never widened)
	eff, _ = a.vermarkterGrenzen(fptr(2))
	if eff == nil || *eff != 2 {
		t.Fatalf("eff=%v, want 2 (min)", eff)
	}
	// no registered limit: the partner limit alone
	eff, _ = a.vermarkterGrenzen(nil)
	if eff == nil || *eff != 3.6 {
		t.Fatalf("eff=%v, want 3.6", eff)
	}
	// watchdog not fresh / set-point at rest: NOTHING composes
	fv.mu.Lock()
	fv.aktiv = false
	fv.mu.Unlock()
	eff, pvCap = a.vermarkterGrenzen(fptr(30))
	if eff == nil || *eff != 30 || pvCap != nil {
		t.Fatalf("abgelaufen: eff=%v pvCap=%v, want 30/nil", eff, pvCap)
	}
	// F5 answered "generation": the SAME limit returns as a PV cap and the
	// export limit stays untouched
	fv.mu.Lock()
	fv.aktiv, fv.wirktAuf = true, direktvermarkter.WirktAufErzeugung
	fv.mu.Unlock()
	eff, pvCap = a.vermarkterGrenzen(fptr(30))
	if eff == nil || *eff != 30 || pvCap == nil || *pvCap != 3.6 {
		t.Fatalf("erzeugung: eff=%v pvCap=%v, want 30/3.6", eff, pvCap)
	}
	// no manager at all (vp-edge-core without the feature) = untouched
	a.vermarkter = nil
	eff, pvCap = a.vermarkterGrenzen(fptr(30))
	if eff == nil || *eff != 30 || pvCap != nil {
		t.Fatalf("ohne Manager: eff=%v pvCap=%v", eff, pvCap)
	}
}

func TestFeedVermarkterDrehtDasVorzeichenUndLaesstFehlendesWeg(t *testing.T) {
	a := &Agent{}
	fv := &fakeVermarkter{anschluss: &vermarktertunnel.Anschluss{Partner: "luox", ReferenzWp: 12000}}
	a.vermarkter = fv
	a.merkeNetzgrenze(fptr(8)) // registered 8 kW on 12 kWp reference

	ts := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	a.feedVermarkter(ts, map[string]float64{
		"power_kw":    -2.35, // grid: negative = export
		"pv_power_kw": 5.0,
	})
	fv.mu.Lock()
	defer fv.mu.Unlock()
	if !fv.werteUm.Equal(ts) {
		t.Fatalf("Zeitstempel %v, want %v", fv.werteUm, ts)
	}
	if fv.werte["nvp_einspeisung_w"] != 2350 {
		t.Errorf("nvp_einspeisung_w = %v, want 2350 (Einspeisung positiv)", fv.werte["nvp_einspeisung_w"])
	}
	if fv.werte["erzeugung_w"] != 5000 {
		t.Errorf("erzeugung_w = %v", fv.werte["erzeugung_w"])
	}
	if fv.werte["referenz_w"] != 12000 {
		t.Errorf("referenz_w = %v", fv.werte["referenz_w"])
	}
	if got := fv.werte["netzbetreiber_vorgabe_pct"]; got != 67 {
		t.Errorf("netzbetreiber_vorgabe_pct = %v, want 67 (8 kW von 12 kWp)", got)
	}
}

func TestFeedVermarkterOhneMessungLaesstDenKanalWeg(t *testing.T) {
	a := &Agent{}
	fv := &fakeVermarkter{anschluss: &vermarktertunnel.Anschluss{Partner: "luox", ReferenzWp: 12000}}
	a.vermarkter = fv
	a.feedVermarkter(time.Now(), map[string]float64{"soc_pct": 50})
	fv.mu.Lock()
	defer fv.mu.Unlock()
	if _, da := fv.werte["nvp_einspeisung_w"]; da {
		t.Error("ohne Netz-Messung darf kein nvp_einspeisung_w stehen (Unbekannt ist keine Null)")
	}
	if _, da := fv.werte["erzeugung_w"]; da {
		t.Error("ohne PV-Messung darf kein erzeugung_w stehen")
	}
	// F7: without a registered limit the grid-operator register shows 100
	if fv.werte["netzbetreiber_vorgabe_pct"] != netzbetreiberOhneSignalPct {
		t.Errorf("netzbetreiber_vorgabe_pct = %v, want %v", fv.werte["netzbetreiber_vorgabe_pct"], netzbetreiberOhneSignalPct)
	}
}

func TestNetzbetreiberPctKlemmtInsBand(t *testing.T) {
	a := &Agent{}
	a.merkeNetzgrenze(fptr(99)) // 99 kW on a 12 kWp reference: over 100 %
	if got := a.netzbetreiberPct(12000); got != 100 {
		t.Errorf("pct = %v, want 100 (geklemmt)", got)
	}
	a.merkeNetzgrenze(fptr(-1))
	if got := a.netzbetreiberPct(12000); got != 0 {
		t.Errorf("pct = %v, want 0 (geklemmt)", got)
	}
	a.merkeNetzgrenze(nil)
	if got := a.netzbetreiberPct(12000); got != netzbetreiberOhneSignalPct {
		t.Errorf("pct = %v, want %v (F7)", got, netzbetreiberOhneSignalPct)
	}
	if math.IsNaN(a.netzbetreiberPct(0)) {
		t.Error("Referenz 0 darf kein NaN ergeben")
	}
}
