package cloud

import (
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/datasourcestatus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
)

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
// measurement_config_per_component (AP-07 IP-18b): the core accepts a shared
// point once per component (measurements.geteiltePunkte) and the palette reads
// it once per target, one sample per component. Reported since its follow-ups
// exist in the cloud - point state, per-component status, revision push and the
// summing guard at Bilanz, formula and Kennzahl, visible in the portal
// (decision firstmate 23.09.2026 A, "Summen-Waechter komplett").
// erzeuger_registerbild (EZ-5): the core carries erzeugerbilder and the probe
// op erzeuger_kopf, and the palette reads the Erzeuger image every 5 s and
// sends its points with quality and events (measurements/erzeuger-*.js;
// evidence measurements/erzeuger-laufzeit.test.js). The points themselves come
// with the runtime catalog of the release that carries this reader.
// anlagensteuerung_quelle (EZ-21): componentapply derives a plant-controller
// source from the driver of an anlagensteuerung entity (no brand, no catalog)
// and the palette binds the component to it through its pin
// (componentapply/plant_controller_test.go). The cloud sends that driver only
// to a box reporting this word - an older applier refuses a driver without a
// brand and with it the whole push.
//
// geraetesuche (Gerätesuche, mqtt-geraetesuche 1.0): the agent runs a
// device-search order with the search module of internal/geraetesuche/suche
// and reports progress and one result (agent/geraetesuche.go). Both builds
// carry it; what each box type can see differs (DP-2 A) and the result names
// the recognisers that ran.
//
// heizstab_regler (Heizstab-Konzept V1): the agent runs the `heizstab` block of
// a heating rod with a Shelly output set itself (internal/heizstab,
// agent/heizstab.go) - surplus in stages without the cloud and without
// Node-RED, so both builds carry it. The cloud sends the block only to a box
// reporting this word; an older box would just ignore it.
//
// EACH BOX TYPE REPORTS FROM ITS OWN BUILD (edge-supports.md "Je Box-Art").
// Edge Light has no Node-RED palette, so the words whose way ends in the
// palette - the shared point read once per target, the Erzeuger image reader
// and the plant-controller binding - are the Docker box's only
// (edge-supports-vectors.json box_arten).
func BuiltSupports(boxArt string) []string {
	out := []string{"data_sources", "measurement_sample_provenance", "events", "automation_paused_until_revoked",
		"plan_quittung", "steuerungsverbund_anteil", "sprungprobe"}
	if boxArt != geraetesuche.BoxArtEdgeLight {
		out = append(out, "measurement_config_per_component", "erzeuger_registerbild", "anlagensteuerung_quelle")
	}
	return append(out, "geraetesuche", "heizstab_regler")
}

// UpdateBackend is the apply backend a box type reports in update.backend and
// verifies a release against: light for Edge Light (vp-edge-light), compose
// for the Docker box.
func UpdateBackend(boxArt string) string {
	if boxArt == geraetesuche.BoxArtEdgeLight {
		return UpdateBackendLight
	}
	return UpdateBackendCompose
}
