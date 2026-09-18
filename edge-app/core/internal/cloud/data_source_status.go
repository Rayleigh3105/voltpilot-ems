package cloud

import "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/datasourcestatus"

// StatusExtension keeps independent additive heartbeat blocks beside the legacy fields.
// Nil omits data_sources; an empty, non-nil slice clears the cloud's complete source set.
type StatusExtension struct {
	DataSources []datasourcestatus.Status
}
