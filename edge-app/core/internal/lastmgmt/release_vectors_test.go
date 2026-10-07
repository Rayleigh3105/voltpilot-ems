package lastmgmt

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// „Sonne + Speicher": the release gate against the SHARED contract vectors,
// read BY PATH - the same file the optimizer, the API and the portal read.
type releaseVectors struct {
	BoxModes     []string `json:"box_modes"`
	CloudReasons []string `json:"cloud_reasons"`
	Decisions    []struct {
		Name  string `json:"name"`
		Input struct {
			PlanFresh      bool     `json:"plan_fresh"`
			MaxDischargeKw *float64 `json:"max_discharge_kw"`
			FloorPct       *float64 `json:"floor_pct"`
			CloudReason    string   `json:"cloud_reason"`
			SocPct         *float64 `json:"soc_pct"`
			DeficitKw      float64  `json:"deficit_kw"`
			Measured       bool     `json:"measured"`
			BatteryReady   bool     `json:"battery_ready"`
		} `json:"input"`
		Expect struct {
			Active       bool    `json:"active"`
			Kw           float64 `json:"kw"`
			StorageFirst bool    `json:"storage_first"`
			Mode         string  `json:"mode"`
		} `json:"expect"`
	} `json:"release_decisions"`
}

func loadReleaseVectors(t *testing.T) releaseVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts", "v2",
		"sonne-speicher-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v releaseVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestTheReleaseGateFollowsTheSharedVectors(t *testing.T) {
	for _, c := range loadReleaseVectors(t).Decisions {
		var g ReleaseGate
		in := ReleaseInput{
			Now: base, PlanFresh: c.Input.PlanFresh, MaxDischargeKw: c.Input.MaxDischargeKw,
			FloorPct: c.Input.FloorPct, CloudReason: c.Input.CloudReason, SocPct: c.Input.SocPct,
			DeficitKw: c.Input.DeficitKw, Measured: c.Input.Measured,
			BatteryReady: c.Input.BatteryReady, BmsDischargeKw: math.NaN(),
		}
		v := g.Decide(in)
		if v.Active != c.Expect.Active || v.StorageFirst != c.Expect.StorageFirst ||
			string(v.Mode) != c.Expect.Mode || math.Abs(v.Kw-c.Expect.Kw) > 1e-6 {
			t.Fatalf("%s: got %+v, want %+v", c.Name, v, c.Expect)
		}
	}
}

func TestTheBoxModesAreTheSharedVocabulary(t *testing.T) {
	v := loadReleaseVectors(t)
	ours := map[string]bool{}
	for _, m := range []ReleaseMode{ReleaseOff, ReleaseActive, ReleaseAtFloor, ReleaseNoPlan,
		ReleasePlanTrades, ReleaseSocUnknown, ReleaseNoMeasurement, ReleaseBatteryPath,
		ReleaseBmsBlocks, ReleaseNoPower, ReleaseEffectLatch} {
		ours[string(m)] = true
	}
	if len(ours) != len(v.BoxModes) {
		t.Fatalf("box modes: ours %v, vectors %v", ours, v.BoxModes)
	}
	for _, m := range v.BoxModes {
		if !ours[m] {
			t.Fatalf("mode %q missing on the box", m)
		}
	}
	cloud := map[string]bool{}
	for _, m := range []ReleaseMode{ReleaseCloudNoSoc, ReleaseCloudHeld, ReleaseCloudStale,
		ReleaseCloudNightTooBig, ReleaseCloudReserveBig, ReleaseCloudTooShort} {
		cloud[string(m)] = true
	}
	for _, r := range v.CloudReasons {
		if !cloud[r] {
			t.Fatalf("cloud reason %q unknown on the box", r)
		}
	}
	if len(cloud) != len(v.CloudReasons) {
		t.Fatalf("cloud reasons: ours %v, vectors %v", cloud, v.CloudReasons)
	}
}
