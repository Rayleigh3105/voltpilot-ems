package guards_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// Captures every public verdict field (including wording and measurement
// pointers) and every wake-up across 1,201 ticks without a share document.
// The no-jump / forward-jump hashes are pinned against origin/uems 8c4350704.
// Run the same test with the two old production files via go test -overlay
// to prove the inverse mutation: without a backward jump every byte survives.
func TestEinzelboxBestandsFingerabdruecke(t *testing.T) {
	for _, fall := range []struct {
		name    string
		sprung  time.Duration
		messung bool
		bestand string
	}{
		{"ohne_Uhrensprung", 0, true, "bae7793d256d1a79c4b61ac60c0ffa338150507c95a6250905e23bdd9c441250/ccab7635cb91117f2a055f7b6811fdbbe4c42bb0aa584d4c183fe402f107ea76"},
		{"Uhr_vor", 840 * time.Second, true, "a59adc564c3407de06de9e817c3ac1b0bafa1ed4d6ae28a58e569c7337c6d167/d2cedc41330437c98e4a3d3275224e5cde5bc3144f8b1a15b1e2638ee60c475b"},
		{"Uhr_zurueck", -840 * time.Second, true, ""},
		{"negatives_Alter_ohne_Messung", -840 * time.Second, false, ""},
	} {
		t.Run(fall.name, func(t *testing.T) {
			e, b := guards.NewExportLimiter(), lastmgmt.NewBudgetTracker()
			limit := 100.0
			set := lastmgmt.Settings{GridLimitKw: 277, HouseReserveKw: 167, MarginPct: 10, MaxHouseLoadKw: 180}
			start := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
			eHash, bHash := sha256.New(), sha256.New()
			bJSON := json.NewEncoder(bHash)
			pv := 148.0
			for s := 0; s <= 1200; s++ {
				now := start.Add(time.Duration(s) * time.Second)
				if s >= 120 {
					now = now.Add(fall.sprung)
				}
				house, rest := 50.0, 20.0
				if s >= 125 {
					house, rest = 20, 120
				}
				eUrgent, bUrgent := false, false
				// The jump is evaluated before its first sample. Include a long
				// ordinary telemetry gap, a plan cap and an incomplete sample.
				if s%5 == 0 && s != 120 && (s < 300 || s > 750) && (s < 120 || fall.messung) {
					eUrgent = e.Observe(now, house-pv, pv)
					bUrgent = b.Observe(now, rest+40, 40, s != 200)
					if s%60 == 0 {
						b.ObservePlanLimit(now, 230)
					}
				}
				ec, bc := e.Cap(now, &limit, 100), b.Budget(now, set)
				pv = ec.CapKw
				var eBuf bytes.Buffer
				if err := json.NewEncoder(&eBuf).Encode(struct {
					Urgent  bool
					Verdict guards.ExportCap
				}{eUrgent, ec}); err != nil {
					t.Fatal(err)
				}
				// K6 (main #1222, nachgezogen 26.09.2026) appended Cascade and
				// CascadeText to the verdict. Without an inner loop Cap is
				// CapCascade "byte for byte" and leaves both empty - asserted
				// here, then cut, so the pins still prove every other byte
				// against origin/uems 8c4350704.
				if ec.Cascade != "" || ec.CascadeText != "" {
					t.Fatalf("tick %d: Cap without an inner loop names a cascade: %q", s, ec.Cascade)
				}
				eHash.Write(bytes.Replace(eBuf.Bytes(), []byte(`,"Cascade":"","CascadeText":""}`), []byte("}"), 1))
				if err := bJSON.Encode(struct {
					Urgent                   bool
					Verdict                  lastmgmt.BudgetVerdict
					Age                      time.Duration
					EigenerZaehler, Pruefung bool
				}{bUrgent, bc, bc.MeasurementAge, bc.EigenerZaehler, bc.Pruefung}); err != nil {
					t.Fatal(err)
				}
			}
			got := fmt.Sprintf("%x/%x", eHash.Sum(nil), bHash.Sum(nil))
			t.Logf("%s: %s", fall.name, got)
			if fall.bestand != "" && got != fall.bestand {
				t.Fatalf("verdict bytes changed without a backward clock jump: want %s", fall.bestand)
			}
		})
	}
}
