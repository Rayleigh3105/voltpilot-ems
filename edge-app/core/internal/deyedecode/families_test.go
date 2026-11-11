package deyedecode

import "testing"

// The family of a device-type code is ha-solarman's AUTODETECTION_DEYE at the
// pinned commit, read through the catalog manifest's map-to-family table.
// Codes outside the source name no family.
func TestFamilieAusTypFolgtDerQuelle(t *testing.T) {
	for _, f := range []struct {
		code    uint16
		familie string
	}{
		{0x0002, FamilyString}, {0x0200, FamilyString},
		{0x0003, FamilyHybrid1P}, {0x0300, FamilyHybrid1P}, {0x0103, FamilyHybrid1P}, {0x0104, FamilyHybrid1P},
		{0x0004, FamilyMicro}, {0x0400, FamilyMicro},
		{0x0005, FamilyHybrid3P}, {0x0500, FamilyHybrid3P},
		{0x0006, FamilyHybrid3P}, {0x0007, FamilyHybrid3P}, {0x0600, FamilyHybrid3P},
		{0x0008, FamilyHybrid3P}, {0x0601, FamilyHybrid3P},
	} {
		if got, ok := FamilieAusTyp(f.code); !ok || got != f.familie {
			t.Fatalf("0x%04x: %q %v, want %q", f.code, got, ok, f.familie)
		}
		if !Known(f.familie) {
			t.Fatalf("0x%04x: family %q has no register map", f.code, f.familie)
		}
	}
	for _, code := range []uint16{0x0000, 0x0001, 0x0009, 0x0100, 0x0102, 0x0105, 0x0700, 0xffff} {
		if got, ok := FamilieAusTyp(code); ok {
			t.Fatalf("0x%04x: guessed family %q", code, got)
		}
	}
}

// Every code with a voltage class is a three-phase hybrid (deye_p3.yaml): the
// two lists come from the same source line and must not drift apart.
func TestSpannungsklasseNurBeiHybrid3P(t *testing.T) {
	for _, code := range append(append([]int{}, deviceTypesLV...), deviceTypesHV...) {
		if f, ok := FamilieAusTyp(uint16(code)); !ok || f != FamilyHybrid3P {
			t.Fatalf("0x%04x: class without hybrid_3p (%q)", code, f)
		}
	}
}
