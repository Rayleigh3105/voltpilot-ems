package cloud

import (
	"encoding/json"

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
	// Logik: nil = no Steuerlogik runs along (no block).
	Logik *LogikSummary
	// Koppel: the Koppelbild status of the plant controllers (koppelbild.md
	// §15), as Layer 1 published it; nil = no block.
	Koppel json.RawMessage
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
// point once per component (measurements.geteiltePunkte) and reads it once per
// target, one sample per component - the Docker box's palette and Edge Light's
// Messwerte-Bibliothek (internal/messwerte) both already do this deduplication.
// Reported by both box types since its follow-ups exist in the cloud - point
// state, per-component status, revision push and the summing guard at Bilanz,
// formula and Kennzahl, visible in the portal (decision firstmate 23.09.2026 A,
// "Summen-Waechter komplett"; B15, Pi-Ablösung-Konzept, extended to Edge Light).
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
// verbraucherregeln (Steuerarten auf Edge Light): the box runs the consumer
// rules the cloud compiles from a Steuerart - the reactive rule with a local
// signal as the generated vp-consumer-policy artifact (Docker box: the
// palette; Edge Light: the Go twin internal/verbraucherregel behind the same
// bus topics, held to verbraucherregel-vectors.json) and the time windows,
// price windows and deadlines from plan and registry push in the core. Both
// builds carry it; the portal unlocks those Steuerarten on an Edge Light only
// for a box that reports it.
//
// heizstab_phasen (Handeingriff je Phase, heizstab-shelly.md): a setpoint_kw
// desired may carry an explicit output set (`outputs`) and the stage path of
// a Shelly output set switches exactly those outputs while they fit the
// granted setpoint (shelly.ExplicitOutputs). The core runs the stage path in
// both builds, so both carry it; the portal offers per-phase switches only
// for a box reporting it.
//
// steuerlogik_mitlauf (Steuerlogik Stufe 2, second part): the box accepts a
// bundle of format steuerlogik on v2/flows and runs the logic along in the
// core (internal/logiklauf, agent/steuerlogik.go) - computing with the real
// inputs every second, switching nothing, claiming nothing - and reports
// wish against observed state in the heartbeat block logik. The core runs in
// both builds, so both carry it; the cloud delivers a logic only to a box
// reporting it.
//
// modbus_geraet (Steuerlogik K3): the core reads and writes a self-built
// Modbus device with write values itself (agent/modbusgeraet.go) - setpoint in
// °C, mode, on/off, rest values, the switch test through its own connection.
// Both builds carry the core path; the cloud ships a definition with controls
// only to a box reporting it and compiles no Node-RED flow for that device.
//
// steuerlogik_scharf (Steuerlogik Stufe 3): the box also takes an ARMED
// Steuerlogik bundle (bundle.armed, set values in bundle.settings) and hands
// its wishes to the arbiter - class flow, rank 40, TTL 45 s, its devices
// owned against plan and deadline fallback, never a second master
// (agent/steuerlogik_scharf.go). Both builds carry it; the cloud arms a logic
// only on a box reporting it, and a box with only steuerlogik_mitlauf never
// switches after a logic.
//
// steuerlogik_regeln (Steuerlogik Stufe 6, Zusammenführen): the core knows the
// language additions a rule of the guided builder translates to (the formula
// word unknown as an if() branch: "voll" wishes nothing outside its condition),
// and its Kern is the one the equality vectors regel-kern-vectors.json hold
// against the Node-RED path. Both builds carry it; the cloud ships a rule as a
// Kern logic only to a box reporting it.
//
// steuerlogik_steuerarten (Steuerlogik Stufe 6, third part): the core knows
// the language additions a Steuerart (the generated Verbraucherregel) and the
// heating-rod controller translate to - the source site.surplus, the device
// signal power, the counter history changes()/oldest_change() and the output
// must_run (a Pflicht as the D-5 override) - and its Kern is the one the
// equality tests hold against verbraucherregel-vectors.json and
// heizstab-regler-vectors.json. Both builds carry it; the cloud ships those
// translations only to a box reporting it.
//
// EACH BOX TYPE REPORTS FROM ITS OWN BUILD (edge-supports.md "Je Box-Art").
// measurement_config_per_component is both box types' (B15, Pi-Ablösung-
// Konzept): Edge Light's Messwerte-Bibliothek (internal/messwerte) already
// reads a shared point once per target, same as the Docker box's palette. The
// Erzeuger image reader and the plant-controller binding are both box types'
// too, since Edge Light reads the image with the Go twin (internal/
// erzeugerbild, wired in layer1/erzeuger.go - PFC200 concept Stufe 2).
//
// koppelbild (PFC200 Stufe 4, koppelbild.md §15): Layer 1 reads the
// acknowledgement and writes the telegram of a controller's Koppelbild in the
// session of its Erzeuger image, takes the Anlagensteuerung's released
// Stellplätze as capabilities, answers the probe op koppel_test and reports
// the heartbeat block koppel (layer1/koppel.go). Only Edge Light has Layer 1;
// the Docker box never reports it.
func BuiltSupports(boxArt string) []string {
	out := []string{"data_sources", "measurement_sample_provenance", "events", "automation_paused_until_revoked",
		"plan_quittung", "steuerungsverbund_anteil", "sprungprobe", "measurement_config_per_component"}
	out = append(out, "erzeuger_registerbild", "anlagensteuerung_quelle")
	out = append(out, "geraetesuche", "heizstab_regler", "verbraucherregeln", "heizstab_phasen", "steuerlogik_mitlauf",
		"modbus_geraet", "steuerlogik_scharf", "steuerlogik_regeln", "steuerlogik_steuerarten")
	if geraetesuche.GoKern(boxArt) {
		out = append(out, "koppelbild")
	}
	return out
}

// UpdateBackend is the apply backend a box type reports in update.backend and
// verifies a release against: light for Edge Light (vp-edge-light), industrie
// for Edge Industrie (vp-edge-industrie), compose for the Docker box.
func UpdateBackend(boxArt string) string {
	switch boxArt {
	case geraetesuche.BoxArtEdgeLight:
		return UpdateBackendLight
	case geraetesuche.BoxArtEdgeIndustrie:
		return UpdateBackendIndustrie
	}
	return UpdateBackendCompose
}
