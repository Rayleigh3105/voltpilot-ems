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
// events is present since AP-07 IP-19: this runtime really does send box events
// over .../v2/events (internal/boxevents). automation_paused_until_revoked is
// present because entities.Registry decodes the field and Paused keeps the Ruhe
// in force without an end. A name is added here only when the way behind it
// works - never because a package exists.
func BuiltSupports() []string {
	return []string{"data_sources", "measurement_sample_provenance", "events", "automation_paused_until_revoked"}
}
