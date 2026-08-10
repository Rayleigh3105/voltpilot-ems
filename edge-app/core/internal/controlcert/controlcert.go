// Package controlcert is the PURE half of the platform-level control
// certification (contract docs/contracts/mqtt-control-certification.schema.json):
// parse the retained cloud document and decide whether it grants THIS device's
// selected inverter a live battery-control write.
//
// Why the platform register exists at all: a bench certification used to land
// in exactly two places, and neither of them was the platform. Either an
// operator edited VP_CONTROL_CERTIFIED_FAMILIES (fleet-wide, keyed on the
// register FAMILY, so one proof leaked onto untested siblings), or the operator
// ran First-Light on the box, which wrote a grant into that ONE box's
// calibration-certified.json. So the same model had to be certified again for
// every new customer, and the platform had no memory of ever having done it.
//
// THE DECISION IS MADE ON THE DEVICE. The cloud says WHICH models the platform
// certified; the device compares that against its OWN selection. That is why
// the whole (small) register travels instead of the cloud guessing which model
// sits behind a box - the same discipline as the OTA sidecar, which believes
// the core nothing.
//
// THIS PACKAGE AUTHORIZES NOTHING PHYSICAL. A grant opens exactly the
// certification gate that the env allowlist and the local First-Light grant
// already open; the global kill switch, the guard chain (rated band, SoC
// window, §14a, EEG solar-only clamp) and every Layer-1 rule bind unchanged.
package controlcert

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// SchemaVersion is the only contract version this build accepts. An unknown
// version is REJECTED, never best-effort parsed: a document we do not fully
// understand must not be able to open a write gate.
const SchemaVersion = "1.0"

// maxModels bounds the register we are willing to hold in memory. The contract
// caps it too; a longer list is a defect upstream, not something to tolerate.
const maxModels = 256

// Document is the retained cloud document as delivered.
type Document struct {
	SchemaVersion string  `json:"schema_version"`
	TenantID      string  `json:"tenant_id"`
	SiteID        string  `json:"site_id"`
	DeviceID      string  `json:"device_id"`
	Activated     bool    `json:"activated"`
	Models        []Model `json:"certified_models"`
	PublishedAt   string  `json:"published_at"`
}

// Model is one bench-certified inverter model.
type Model struct {
	Brand  string `json:"brand"`
	Model  string `json:"model"`
	Family string `json:"family"`
	// ControlPath ("remote"/"tou") is the surface the bench run drove, or "".
	ControlPath string `json:"control_path,omitempty"`
	// InvertControlSign is the bench-proven WRITE sign convention. It is a
	// POINTER because absent and false are different statements: absent means
	// the bench did not answer the question (so the device checks nothing),
	// false means it did.
	InvertControlSign *bool  `json:"invert_control_sign,omitempty"`
	CertifiedAt       string `json:"certified_at"`
	FirmwareNote      string `json:"firmware_note,omitempty"`
	Note              string `json:"note,omitempty"`
}

// Device is what this box has selected - the only facts a grant is matched
// against. Deliberately its own tiny struct rather than an inverter.Selection
// so this package stays pure and importable from anywhere (the otaapply /
// calibration discipline).
type Device struct {
	Brand             string
	Model             string
	Family            string
	InvertControlSign bool
}

// Grant is the decision plus everything a surface needs to say WHY.
//
// ⚠ Granted is the ONLY grant marker. The descriptive fields are deliberately
// filled for a COVERED-but-unarmed model too, so a surface can name WHICH model
// is waiting for its one click - "one click is needed" and "a bench run is
// needed" are different sentences, and naming the model is what makes the first
// one credible. Never test a grant by looking at Model or Family.
type Grant struct {
	// Granted is the decision. Everything else is description.
	Granted bool
	// Family the grant applies to - the same value the certification gate is
	// keyed on everywhere else in the agent. Only set when Granted.
	Family string
	// Model is the register entry that matched (for logs + the operator view).
	Model string
	// ControlPath seeds Layer 1's sticky path decision, or "" when the entry
	// does not state one.
	ControlPath string
	// CertifiedAt is the register entry's bench date, verbatim.
	CertifiedAt string
}

// Verdict is the tri-state answer for the SELECTED inverter, so a surface can
// tell "not covered" (bench needed) from "covered, waiting for you" (one click)
// from "granted" - the distinction the portal could not make before.
type Verdict string

const (
	// VerdictGranted: the platform certified this model AND this plant is
	// activated.
	VerdictGranted Verdict = "granted"
	// VerdictCoveredNotActivated: the model IS certified, but nobody armed this
	// plant yet. An operator decision, not a defect.
	VerdictCoveredNotActivated Verdict = "covered_not_activated"
	// VerdictNotCovered: this model is not in the register - a bench run is
	// genuinely needed, and no click can substitute for it.
	VerdictNotCovered Verdict = "not_covered"
	// VerdictUnknown: no usable document (never published, cleared, unparseable,
	// or no inverter selected). NEVER read as "not covered" - we simply do not
	// know, and that is a different sentence.
	VerdictUnknown Verdict = "unknown"
)

// Parse validates the retained payload. An EMPTY payload is the retained-clear
// and yields (nil, nil) - the honest "no document" state, not an error.
//
// Every rejection is fail-closed: a document we cannot fully validate grants
// nothing, and the caller keeps whatever the env allowlist and First-Light say.
func Parse(payload []byte) (*Document, error) {
	if len(strings.TrimSpace(string(payload))) == 0 {
		return nil, nil
	}
	var doc Document
	if err := json.Unmarshal(payload, &doc); err != nil {
		return nil, fmt.Errorf("Das Zertifizierungs-Dokument ist kein gueltiges JSON: %w", err)
	}
	if doc.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf("Unbekannte Vertragsversion %q der Steuerungs-Zertifizierung", doc.SchemaVersion)
	}
	if strings.TrimSpace(doc.TenantID) == "" || strings.TrimSpace(doc.SiteID) == "" ||
		strings.TrimSpace(doc.DeviceID) == "" {
		return nil, fmt.Errorf("Das Zertifizierungs-Dokument nennt keine vollstaendige Identitaet")
	}
	if len(doc.Models) > maxModels {
		return nil, fmt.Errorf("Das Register nennt %d Modelle (Obergrenze %d)", len(doc.Models), maxModels)
	}
	kept := doc.Models[:0]
	for _, m := range doc.Models {
		// A malformed ENTRY is dropped, not fatal: one bad row must not cost
		// the whole register its meaning. It can only ever grant less.
		if strings.TrimSpace(m.Brand) == "" || strings.TrimSpace(m.Model) == "" ||
			strings.TrimSpace(m.Family) == "" {
			continue
		}
		if m.ControlPath != "" && m.ControlPath != "remote" && m.ControlPath != "tou" {
			m.ControlPath = "" // an unknown word is dropped, never stored as a claim
		}
		kept = append(kept, m)
	}
	doc.Models = kept
	return &doc, nil
}

// BelongsTo reports whether the document was addressed to this identity. The
// caller checks it before applying anything (the topic==payload identity rule
// of telemetry / purge_data / the OTA assignment).
func (d *Document) BelongsTo(tenantID, siteID, deviceID string) bool {
	if d == nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(d.TenantID), strings.TrimSpace(tenantID)) &&
		strings.EqualFold(strings.TrimSpace(d.SiteID), strings.TrimSpace(siteID)) &&
		strings.EqualFold(strings.TrimSpace(d.DeviceID), strings.TrimSpace(deviceID))
}

// Match is the whole decision. It returns the grant (when there is one), the
// tri-state verdict for surfaces, and a plain-German reason for the cases where
// a covered-looking model still gets nothing.
//
// Matched on: brand, model AND family. The family is checked rather than
// derived - a box that selected the same model under a different register map
// is not what the bench proved. The bench sign convention is checked only when
// the entry states one (absent = no claim, so nothing to contradict).
func Match(doc *Document, dev Device) (Grant, Verdict, string) {
	if doc == nil {
		return Grant{}, VerdictUnknown, ""
	}
	if strings.TrimSpace(dev.Family) == "" || strings.TrimSpace(dev.Model) == "" {
		// No inverter selected (or a selection without a model, e.g. a generic
		// entry): we cannot compare, so we claim nothing in either direction.
		return Grant{}, VerdictUnknown, ""
	}
	entry, ok := doc.find(dev)
	if !ok {
		return Grant{}, VerdictNotCovered, ""
	}
	if entry.InvertControlSign != nil && *entry.InvertControlSign != dev.InvertControlSign {
		// The write sign is firmware-dependent, so the bench statement is part
		// of what was proven. A box configured the other way round is NOT what
		// was tested - fail closed and say exactly that.
		return Grant{}, VerdictNotCovered, signMismatchReason(*entry.InvertControlSign)
	}
	described := Grant{
		Model:       entry.Model,
		ControlPath: entry.ControlPath,
		CertifiedAt: entry.CertifiedAt,
	}
	if !doc.Activated {
		// Described but NOT granted: the model is covered, nobody armed this
		// plant. Family stays empty so no caller can mistake this for a grant.
		return described, VerdictCoveredNotActivated, ""
	}
	described.Granted = true
	described.Family = dev.Family
	return described, VerdictGranted, ""
}

func (d *Document) find(dev Device) (Model, bool) {
	for _, m := range d.Models {
		if eq(m.Brand, dev.Brand) && eq(m.Model, dev.Model) && eq(m.Family, dev.Family) {
			return m, true
		}
	}
	return Model{}, false
}

func signMismatchReason(certified bool) string {
	want, have := "nicht umgekehrt", "umgekehrt"
	if certified {
		want, have = "umgekehrt", "nicht umgekehrt"
	}
	return "Die Freigabe des Modells gilt fuer das Steuer-Vorzeichen " + want +
		"; dieses Geraet ist " + have + " eingestellt."
}

func eq(a, b string) bool {
	return strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
}

// Published parses the document stamp, or the zero time when it is missing or
// unparseable (a stamp is diagnostics here, never a gate).
func (d *Document) Published() time.Time {
	if d == nil {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(d.PublishedAt))
	if err != nil {
		return time.Time{}
	}
	return t.UTC()
}
