package cloud

import "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/datasourcestatus"

// StatusExtension keeps independent additive heartbeat blocks beside the legacy fields.
// Nil omits a block. An empty DataSources slice clears the complete source set.
// Empty Supports clears the report; release-table capabilities still apply.
type StatusExtension struct {
	DataSources []datasourcestatus.Status
	Supports    []string
	// GemeinsameSteuerung: nil = no block (a box without a plan 2.0 sends the
	// heartbeat it sent before AP-15 IP-10, apart from supports[]).
	GemeinsameSteuerung *GemeinsameSteuerung
}

// BuiltSupports advertises only capabilities implemented by this runtime bundle.
// assignment_effective_at is deliberately absent: its current scheduler is in the cloud.
// events is present since AP-07 IP-19: this runtime really does send box events
// over .../v2/events (internal/boxevents). automation_paused_until_revoked is
// present because entities.Registry decodes the field and Paused keeps the Ruhe
// in force without an end. A name is added here only when the way behind it
// works - never because a package exists. plan_quittung (AP-15 IP-10): the agent
// really judges every plan 2.0 on .../v2/plan-result (agent/plan_result.go).
// steuerungsverbund_anteil (AP-15 IP-17): the agent judges, stores and
// receipts the share document of a Gemeinsame Steuerung and mirrors it in the
// heartbeat (agent/verbund_anteile.go) - regulating against it is IP-18/IP-19.
// sprungprobe (AP-15 IP-21): the agent runs a Sprungprobe order bounded and
// lowering-only under its own watchdogs and reports it once
// (agent/sprungprobe.go, internal/sprungprobe).
func BuiltSupports() []string {
	return []string{"data_sources", "measurement_sample_provenance", "events", "automation_paused_until_revoked",
		"plan_quittung", "steuerungsverbund_anteil", "sprungprobe"}
}
