package controlprofile_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/controlprofile"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
)

// The authored truth, read by path on purpose (like docs/contracts vectors):
// a stale embedded copy fails `go test` even where Python never runs.
const catalogDir = "../../../../catalog/control-profiles/profiles"

func TestEmbeddedProfilesLoad(t *testing.T) {
	if err := controlprofile.Err(); err != nil {
		t.Fatal(err)
	}
	if len(controlprofile.All()) == 0 {
		t.Fatal("no profiles embedded")
	}
}

// TestEmbeddedMatchesTheCatalog: every profile the box can find (a binding)
// carries exactly the binding, damping timing and day budget of its canonical
// file - and nothing is embedded that the catalog does not bind.
func TestEmbeddedMatchesTheCatalog(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join(catalogDir, "*.json"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("catalog profiles: %v (%d files)", err, len(paths))
	}
	var want []controlprofile.Profile
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var p controlprofile.Profile
		if err := json.Unmarshal(raw, &p); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if len(p.Bindings) > 0 {
			want = append(want, p)
		}
	}
	slices.SortFunc(want, func(a, b controlprofile.Profile) int {
		if a.ID < b.ID {
			return -1
		}
		if a.ID > b.ID {
			return 1
		}
		return 0
	})
	if got := controlprofile.All(); !reflect.DeepEqual(got, want) {
		t.Fatalf("embedded profiles.json is stale - run catalog/control-profiles/tools/package_edge_runtime.py\n got %+v\nwant %+v", got, want)
	}
}

// TestBindingsNameRealCatalogEntries: a binding names brand, family and models
// exactly as the box's own inverter catalog has them, and a control path Layer 1
// actually reports - otherwise the profile would silently bind nothing.
func TestBindingsNameRealCatalogEntries(t *testing.T) {
	cat := inverter.DefaultCatalog()
	for _, p := range controlprofile.All() {
		for _, b := range p.Bindings {
			i := slices.IndexFunc(cat.Brands, func(x inverter.Brand) bool { return x.ID == b.Brand })
			if i < 0 {
				t.Errorf("%s: brand %q not in the inverter catalog", p.ID, b.Brand)
				continue
			}
			brand := cat.Brands[i]
			if !slices.ContainsFunc(brand.Families, func(f inverter.Family) bool { return f.ID == b.Family }) {
				t.Errorf("%s: family %q not offered by brand %q", p.ID, b.Family, b.Brand)
			}
			for _, m := range b.Models {
				if !slices.ContainsFunc(brand.Models, func(x inverter.Model) bool { return x.ID == m }) {
					t.Errorf("%s: model %q not offered by brand %q", p.ID, m, b.Brand)
				}
			}
			if b.ControlPath != nil && *b.ControlPath != "remote" && *b.ControlPath != "tou" {
				t.Errorf("%s: control path %q is none Layer 1 reports", p.ID, *b.ControlPath)
			}
		}
	}
}

func TestFor(t *testing.T) {
	cases := []struct {
		dev  controlprofile.Device
		want string
	}{
		{controlprofile.Device{Brand: "deye", Model: "sun-30k-sg01hp3", Family: inverter.FamHybrid3p, ControlPath: "remote"}, "deye_hp3_remote"},
		{controlprofile.Device{Brand: "deye", Family: inverter.FamHybrid1p, ControlPath: "remote"}, "deye_hp3_remote"},
		{controlprofile.Device{Brand: "deye", Family: inverter.FamHybrid3p, ControlPath: "tou"}, "deye_tou"},
		// An older Layer 1 reports no path: no profile, the Vorgabe applies.
		{controlprofile.Device{Brand: "deye", Family: inverter.FamHybrid3p}, ""},
		{controlprofile.Device{Brand: "kostal", Model: "plenticore-bi-10-26", Family: inverter.FamKostalPlenticore}, "kostal"},
		{controlprofile.Device{Brand: "kaco", Family: inverter.FamKacoNH3}, "kaco_nh3"},
		{controlprofile.Device{Brand: "fronius", Model: "fronius-eco-27-3-s", Family: inverter.FamSunSpecLive}, "fronius_pv"},
		// "Anderes Fronius-Modell" may be a GEN24 hybrid: bound to nothing.
		{controlprofile.Device{Brand: "fronius", Model: inverter.FamSunSpecLive, Family: inverter.FamSunSpecLive}, ""},
		// KACO over SunSpec shares the family with Fronius, not the brand.
		{controlprofile.Device{Brand: "kaco", Model: "fronius-eco-27-3-s", Family: inverter.FamSunSpecLive}, ""},
		{controlprofile.Device{}, ""},
	}
	for _, c := range cases {
		p, ok := controlprofile.For(c.dev)
		if got := map[bool]string{true: p.ID}[ok]; got != c.want {
			t.Errorf("For(%+v) = %q, want %q", c.dev, got, c.want)
		}
	}
}

func TestPersistentWritesPerDay(t *testing.T) {
	n, ok := controlprofile.PersistentWritesPerDay(controlprofile.Device{Brand: "deye", Family: inverter.FamHybrid3p, ControlPath: "tou"})
	if !ok || n != 20 {
		t.Fatalf("deye tou: %d %v, want 20 (concept §6.6, F12)", n, ok)
	}
	if _, ok := controlprofile.PersistentWritesPerDay(controlprofile.Device{Brand: "fronius", Model: "fronius-eco-25-3-s", Family: inverter.FamSunSpecLive}); ok {
		t.Fatal("a RAM-only device states no persistent budget")
	}
	if _, ok := controlprofile.PersistentWritesPerDay(controlprofile.Device{Brand: "unbekannt"}); ok {
		t.Fatal("no profile, no statement")
	}
}
