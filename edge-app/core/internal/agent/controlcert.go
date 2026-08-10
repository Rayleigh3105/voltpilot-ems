package agent

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/controlcert"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// The PLATFORM half of the control certification: the cloud's retained register
// document (contract docs/contracts/mqtt-control-certification.schema.json) is
// the THIRD source of a certification grant, next to
//
//  1. the fleet-wide env allowlist  (config.ControlCertified, keyed on FAMILY)
//  2. the local First-Light grant   (calibration-certified.json, keyed on FAMILY,
//     earned by a readback-confirmed test on THIS box)
//  3. the platform register         (here, keyed on brand+MODEL, earned once at a
//     bench and then valid fleet-wide)
//
// The three are ORed in controlCertified (agent/calibration.go), so this file can
// only ever ADD a grant. That is what makes the change byte-identical for every
// existing plant: a box with a First-Light grant keeps it, and a box without one
// gets nothing until an operator BOTH registers its model AND arms that plant.
//
// ⚠ LOCK ORDER: the inverter selection (invMu) is always read BEFORE pcMu, never
// the other way round. Every function here follows that, so the two can never
// deadlock.

// controlCertPath is the on-disk copy of the last applied cloud document.
// Persisted for the same reason plan.json and ota/target.json are: a box that
// boots without a cloud link must not silently lose a grant it legitimately had
// until the broker answers again. Retained delivery re-converges on reconnect;
// the file only bridges the gap.
func (a *Agent) controlCertPath() string {
	return filepath.Join(a.Cfg.DataDir, "platform-cert.json")
}

// onControlCert consumes the retained cloud document - called by the cloud link
// on every (re)connect and on every change.
//
// An EMPTY payload is the retained-clear: the document is withdrawn and the box
// falls back to whatever the env allowlist and First-Light give it. Every
// rejection is fail-closed AND loud - a document that cannot open the gate must
// never fail to open it silently.
func (a *Agent) onControlCert(payload []byte) {
	doc, err := controlcert.Parse(payload)
	if err != nil {
		slog.Warn("Steuerungs-Zertifizierung: Dokument verworfen", "err", err)
		return
	}
	if doc == nil {
		a.applyControlCert(nil, true)
		slog.Info("Steuerungs-Zertifizierung: Dokument zurueckgenommen (retained clear)")
		return
	}
	// Topic identity == payload identity, the rule of telemetry / purge_data /
	// the OTA assignment. The link only ever subscribes its OWN topic, so a
	// mismatch is a misaddressed publish - never something to act on.
	a.entMu.Lock()
	id := a.entIdentity
	a.entMu.Unlock()
	if id.DeviceID != "" && !doc.BelongsTo(id.TenantID, id.SiteID, id.DeviceID) {
		slog.Warn("Steuerungs-Zertifizierung: fremde Identitaet im Dokument - verworfen",
			"device_id", doc.DeviceID)
		return
	}
	a.applyControlCert(doc, true)
}

// applyControlCert stores the document, refreshes the derived verdict and nudges
// the setpoint so a newly granted family reaches Layer 1 without waiting for the
// next tick. persist=false is the boot path (the file is already on disk).
func (a *Agent) applyControlCert(doc *controlcert.Document, persist bool) {
	dev, _ := a.platformDevice()

	a.pcMu.Lock()
	beforeG, _, _ := controlcert.Match(a.platformDoc, dev)
	a.platformDoc = doc
	afterG, _, _ := controlcert.Match(doc, dev)
	a.pcMu.Unlock()

	if persist {
		if err := a.persistControlCert(doc); err != nil {
			slog.Warn("Steuerungs-Zertifizierung konnte nicht gespeichert werden", "err", err)
		}
	}
	a.refreshPlatformCertState()

	if beforeG.Granted != afterG.Granted {
		if afterG.Granted {
			slog.Warn("Steuerungs-Zertifizierung: die Plattform gibt die Batterie-Steuerung fuer dieses Geraet FREI",
				"family", afterG.Family, "model", afterG.Model, "certified_at", afterG.CertifiedAt)
		} else {
			slog.Warn("Steuerungs-Zertifizierung: die Plattform-Freigabe fuer dieses Geraet ist ENTFALLEN",
				"family", beforeG.Family, "model", beforeG.Model)
		}
		// control_enabled / device_certified flip on edge/setpoint.
		a.nudgeSetpoint()
	}
}

// loadControlCert restores the persisted document at boot. A missing file is
// normal; a corrupt one leaves the box with no platform grant (the fail-safe
// default), which the retained redelivery repairs on the next connect.
func (a *Agent) loadControlCert() {
	raw, err := os.ReadFile(a.controlCertPath())
	if err != nil {
		if !os.IsNotExist(err) {
			slog.Warn("Steuerungs-Zertifizierung unlesbar; keine Plattform-Freigabe angewandt", "err", err)
		}
		return
	}
	doc, err := controlcert.Parse(raw)
	if err != nil {
		slog.Warn("Steuerungs-Zertifizierung beschaedigt; keine Plattform-Freigabe angewandt", "err", err)
		return
	}
	a.applyControlCert(doc, false)
}

func (a *Agent) persistControlCert(doc *controlcert.Document) error {
	path := a.controlCertPath()
	if doc == nil {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// platformGrant evaluates the register against the CURRENT inverter selection.
func (a *Agent) platformGrant() (controlcert.Grant, controlcert.Verdict, string) {
	dev, _ := a.platformDevice()
	a.pcMu.Lock()
	doc := a.platformDoc
	a.pcMu.Unlock()
	return controlcert.Match(doc, dev)
}

// platformCertified is the third OR branch of controlCertified. The family
// argument keeps the merge keyed like its two siblings; the actual match runs
// against the FULL selection (brand + model + family + the benched sign
// convention), because a family is not what a bench run proves.
func (a *Agent) platformCertified(family string) bool {
	if strings.TrimSpace(family) == "" {
		return false
	}
	g, _, _ := a.platformGrant()
	return g.Granted && strings.EqualFold(strings.TrimSpace(g.Family), strings.TrimSpace(family))
}

// platformControlPath is the control surface the BENCH run drove - it seeds
// Layer 1's sticky path decision when this device has no local First-Light
// evidence of its own. "" = the register states none (no claim).
func (a *Agent) platformControlPath(family string) string {
	if strings.TrimSpace(family) == "" {
		return ""
	}
	g, _, _ := a.platformGrant()
	if g.Granted && strings.EqualFold(strings.TrimSpace(g.Family), strings.TrimSpace(family)) {
		return g.ControlPath
	}
	return ""
}

// platformCertInfo is the display/heartbeat verdict for the SELECTED inverter,
// or nil when there is nothing to say (no document at all).
func (a *Agent) platformCertInfo() *state.PlatformCertInfo {
	a.pcMu.Lock()
	doc := a.platformDoc
	a.pcMu.Unlock()
	if doc == nil {
		return nil
	}
	g, verdict, reason := a.platformGrant()
	return &state.PlatformCertInfo{
		Verdict:     string(verdict),
		Model:       g.Model,
		CertifiedAt: g.CertifiedAt,
		Reason:      reason,
		SeenAt:      doc.Published(),
	}
}

func (a *Agent) refreshPlatformCertState() {
	info := a.platformCertInfo()
	a.State.Update(func(s *state.Snapshot) { s.PlatformCert = info })
}

// platformDevice is the selection the register is matched against.
func (a *Agent) platformDevice() (controlcert.Device, bool) {
	a.invMu.Lock()
	defer a.invMu.Unlock()
	if a.inv == nil {
		return controlcert.Device{}, false
	}
	return controlcert.Device{
		Brand:             a.inv.Brand,
		Model:             a.inv.Model,
		Family:            a.inv.Family,
		InvertControlSign: a.inv.Connection.InvertControlSign,
	}, true
}

// certSource names WHICH of the three sources granted the certification, so a
// surface can explain the state instead of showing a bare boolean. The order
// matches the OR in controlCertified.
func (a *Agent) certSource(family string) string {
	if strings.TrimSpace(family) == "" {
		return ""
	}
	if a.Cfg.ControlCertified(family) {
		return "env"
	}
	if a.deviceCertified(family) {
		return "device"
	}
	if a.platformCertified(family) {
		return "platform"
	}
	return ""
}

// refreshPlatformCertAfterSelectionChange re-derives the verdict after the
// inverter selection changed. The register is matched against brand + model +
// family + the benched sign, so picking another model (or correcting the sign)
// can gain or lose the grant even though the register itself is unchanged.
func (a *Agent) refreshPlatformCertAfterSelectionChange() {
	a.pcMu.Lock()
	has := a.platformDoc != nil
	a.pcMu.Unlock()
	if !has {
		return
	}
	before, _, _ := a.platformGrant()
	a.refreshPlatformCertState()
	after, _, _ := a.platformGrant()
	if before.Granted != after.Granted {
		a.nudgeSetpoint()
	}
}
