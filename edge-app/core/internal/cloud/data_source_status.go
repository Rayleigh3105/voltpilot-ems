package cloud

import "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/datasourcestatus"

// StatusExtension keeps independent additive heartbeat blocks beside the legacy fields.
// Nil omits a block. An empty DataSources slice clears the complete source set.
// Empty Supports clears the report; release-table capabilities still apply.
type StatusExtension struct {
	DataSources []datasourcestatus.Status
	Supports    []string
}

// BuiltSupports advertises only capabilities implemented by this runtime bundle.
// assignment_effective_at is deliberately absent: its current scheduler is in the cloud.
func BuiltSupports() []string {
	return []string{"data_sources", "measurement_sample_provenance"}
}
