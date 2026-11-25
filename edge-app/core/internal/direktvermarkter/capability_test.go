package direktvermarkter_test

import (
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
)

// TestCapabilityWordIsReservedNotAdvertised pins the word's spelling now, so
// Stage 2/4's addition to cloud.BuiltSupports() and the shared contract uses
// exactly this string, never a second, drifted spelling.
func TestCapabilityWordIsReservedNotAdvertised(t *testing.T) {
	if direktvermarkter.Capability != "direktvermarktung" {
		t.Fatalf("Capability = %q, want %q", direktvermarkter.Capability, "direktvermarktung")
	}
}
