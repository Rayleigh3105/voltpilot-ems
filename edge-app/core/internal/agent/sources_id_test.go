package agent

// Deterministic source identity + label-only rename (vp-vier-erzeuger-p9):
// the portal pins an adopted entity to the source id, so the id must survive
// the two real-world flows that used to mint a new one - "renaming" via
// delete + re-add, and correcting a typo by re-creating the source. With the
// deterministic id a re-add of the SAME physical device converges on the SAME
// id; RenameSource changes only the label and never the id.

import (
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

func froniusUnitRequest(unitID int, label string) sources.Request {
	return sources.Request{
		Role:       sources.RoleErzeuger,
		Brand:      inverter.BrandGenericModbus,
		Model:      inverter.FamSunSpec,
		Label:      label,
		Connection: inverter.Connection{IP: "192.168.210.40", UnitID: unitID},
	}
}

func TestReaddedSourceConvergesOnTheSameID(t *testing.T) {
	a := newGateTestAgent(t)
	first, err := a.AddSource(froniusUnitRequest(2, "Fronius WR2"))
	if err != nil {
		t.Fatal(err)
	}
	if err := a.DeleteSource(first.ID); err != nil {
		t.Fatal(err)
	}
	// The delete+re-add "rename" of the pre-PUT era: same physical device,
	// new name. The id MUST converge so the cloud pin survives.
	again, err := a.AddSource(froniusUnitRequest(2, "Fronius Anlage WR2"))
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != first.ID {
		t.Fatalf("re-added source got a new id: %q -> %q (pin would orphan)",
			first.ID, again.ID)
	}
	if again.Label != "Fronius Anlage WR2" {
		t.Fatalf("label = %q", again.Label)
	}
}

func TestSecondIdenticalIdentityFallsBackToARandomID(t *testing.T) {
	a := newGateTestAgent(t)
	first, err := a.AddSource(froniusUnitRequest(1, "WR1"))
	if err != nil {
		t.Fatal(err)
	}
	// The same transport identity a second time is not a valid setup, but it
	// must never crash or produce two rows with one id.
	dup, err := a.AddSource(froniusUnitRequest(1, "WR1 nochmal"))
	if err != nil {
		t.Fatal(err)
	}
	if dup.ID == first.ID {
		t.Fatalf("duplicate identity must fall back to a distinct id")
	}
	if len(a.ListSources()) != 2 {
		t.Fatalf("both rows must stay addressable: %d", len(a.ListSources()))
	}
	// A different unit id on the same host stays deterministic (no collision).
	other, err := a.AddSource(froniusUnitRequest(2, "WR2"))
	if err != nil {
		t.Fatal(err)
	}
	if other.ID == first.ID || other.ID == dup.ID {
		t.Fatalf("unit 2 must get its own id")
	}
}

func TestRenameSourceKeepsIDAndPersists(t *testing.T) {
	a := newGateTestAgent(t)
	src, err := a.AddSource(froniusUnitRequest(2, "Fronius WR2"))
	if err != nil {
		t.Fatal(err)
	}
	renamed, err := a.RenameSource(src.ID, "  Fronius Anlage WR2  ")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.ID != src.ID {
		t.Fatalf("rename must keep the id: %q -> %q", src.ID, renamed.ID)
	}
	if renamed.Label != "Fronius Anlage WR2" {
		t.Fatalf("label = %q (should be trimmed)", renamed.Label)
	}
	list := a.ListSources()
	if len(list) != 1 || list[0].Label != "Fronius Anlage WR2" || list[0].ID != src.ID {
		t.Fatalf("in-memory list wrong: %+v", list)
	}
	if list[0].Connection.IP != "192.168.210.40" || list[0].Connection.UnitID != 2 {
		t.Fatalf("rename must not touch the transport: %+v", list[0].Connection)
	}

	if _, err := a.RenameSource("src-unknown", "X"); err != sources.ErrNotFound {
		t.Fatalf("unknown id: err = %v, want ErrNotFound", err)
	}
	var ve *sources.ValidationError
	if _, err := a.RenameSource(src.ID, "   "); err == nil {
		t.Fatalf("empty label must be refused")
	} else if !errorsAs(err, &ve) {
		t.Fatalf("empty label: err = %T, want *sources.ValidationError", err)
	}
}

// errorsAs avoids importing errors just for one assertion helper.
func errorsAs(err error, target **sources.ValidationError) bool {
	ve, ok := err.(*sources.ValidationError)
	if ok {
		*target = ve
	}
	return ok
}
