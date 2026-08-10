package agent

// Agent-level tests for the PLATFORM control certification: the retained cloud
// document is a THIRD grant source next to the env allowlist and the local
// First-Light grant, it is matched against THIS box's own selection, and it can
// only ever ADD a grant - never remove one an existing plant already had.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/controlcert"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
)

// certDoc builds a cloud document for the pilot Deye that selectDeye picks.
func certDoc(activated bool, mutate ...func(*controlcert.Document)) []byte {
	doc := controlcert.Document{
		SchemaVersion: controlcert.SchemaVersion,
		TenantID:      "t-1", SiteID: "s-1", DeviceID: "d-1",
		Activated: activated,
		Models: []controlcert.Model{{
			Brand: "deye", Model: "sun-30k-sg01hp3", Family: "hybrid_3p",
			ControlPath: "remote", CertifiedAt: "2026-07-27T14:05:00Z",
		}},
		PublishedAt: "2026-08-10T09:00:00Z",
	}
	for _, m := range mutate {
		m(&doc)
	}
	raw, _ := json.Marshal(doc)
	return raw
}

// The captain's complaint, end to end: a NEW customer's box with the SAME model
// gets control certified without a bench run, an env edit or a First-Light here.
func TestAPlatformRegisteredModelCertifiesANewBoxWithoutAnyLocalProof(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, addr := startBusOnlyAgent(t, cfg)
	selectDeye(t, a) // the pilot Deye - NOT on the env allowlist

	if a.controlCertified("hybrid_3p") {
		t.Fatal("precondition: the family must start uncertified")
	}
	sub := subscribeSetpoint(t, addr)
	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 2, LoadKw: 3, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()

	a.onControlCert(certDoc(true))

	if !a.controlCertified("hybrid_3p") {
		t.Fatal("a registered + activated model must be certified on this box")
	}
	if src := a.certSource("hybrid_3p"); src != "platform" {
		t.Fatalf("cert source = %q, want platform", src)
	}
	// The proven bench path seeds Layer 1's sticky decision, exactly like a
	// local First-Light grant would.
	if p := a.certifiedControlPath("hybrid_3p"); p != "remote" {
		t.Fatalf("certified control path = %q, want remote", p)
	}
	// And it REACHES Layer 1 on edge/setpoint.
	a.applySetpoint(time.Now().UTC())
	waitFor(t, 5*time.Second, "granted setpoint", func() bool {
		m, ok := sub.latest()
		return ok && m["device_certified"] == true && m["control_enabled"] == true &&
			m["device_certified_path"] == "remote"
	})
}

// Both halves are required: the register alone arms nothing.
func TestTheRegisterWithoutActivationGrantsNothing(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)

	a.onControlCert(certDoc(false))

	if a.controlCertified("hybrid_3p") {
		t.Fatal("an unactivated plant must NOT be certified")
	}
	info := a.State.Get().PlatformCert
	if info == nil || info.Verdict != string(controlcert.VerdictCoveredNotActivated) {
		t.Fatalf("verdict = %+v, want covered_not_activated", info)
	}
	// The distinction the portal needs: "one click" is NOT "bench needed".
	if info.Model == "" {
		t.Fatal("a covered model must be named so the surface can say which one")
	}
}

// The device is the verifier: a register that does not name THIS model grants
// nothing, however activated the plant is.
func TestARegisterForAnotherModelGrantsNothingOnThisBox(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)

	a.onControlCert(certDoc(true, func(d *controlcert.Document) {
		d.Models[0].Model = "SUN-12K-SG04LP3-EU" // same family, other model
	}))

	if a.controlCertified("hybrid_3p") {
		t.Fatal("a sibling model must not certify this box - the key is the MODEL")
	}
	if v := a.State.Get().PlatformCert.Verdict; v != string(controlcert.VerdictNotCovered) {
		t.Fatalf("verdict = %q, want not_covered", v)
	}
}

// A document addressed to a DIFFERENT device is dropped (topic == payload
// identity, the rule of telemetry / purge_data / the OTA assignment).
func TestAForeignIdentityIsRejected(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)
	a.setEntityIdentity("t-1", "s-1", "d-1")

	a.onControlCert(certDoc(true, func(d *controlcert.Document) { d.DeviceID = "someone-else" }))

	if a.controlCertified("hybrid_3p") {
		t.Fatal("a foreign document must never grant anything")
	}
	if a.State.Get().PlatformCert != nil {
		t.Fatal("a rejected document must not be reported as this box's verdict")
	}
}

// SAFETY: the platform document can only ADD a grant. A box that already had a
// local First-Light grant keeps it - including through a retained clear.
func TestAPlatformDocumentNeverRemovesAnExistingLocalGrant(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)
	proveCalibration(t, a)
	if _, err := a.CalibrationCertify(); err != nil {
		t.Fatalf("CalibrationCertify: %v", err)
	}
	if !a.controlCertified("hybrid_3p") {
		t.Fatal("precondition: the local First-Light grant must be in place")
	}

	// A document that covers NOTHING, and then a retained clear.
	a.onControlCert(certDoc(false, func(d *controlcert.Document) { d.Models = nil }))
	if !a.controlCertified("hybrid_3p") {
		t.Fatal("an empty register must never revoke a local First-Light grant")
	}
	if src := a.certSource("hybrid_3p"); src != "device" {
		t.Fatalf("cert source = %q, want device", src)
	}
	a.onControlCert(nil)
	if !a.controlCertified("hybrid_3p") {
		t.Fatal("a retained clear must never revoke a local First-Light grant")
	}
}

// SAFETY: an existing plant that receives NO document behaves byte-identically -
// no file, no grant, no state.
func TestWithoutAnyDocumentNothingChangesAndNoFileIsWritten(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)

	if a.controlCertified("hybrid_3p") {
		t.Fatal("no document must mean no grant")
	}
	if a.State.Get().PlatformCert != nil {
		t.Fatal("no document must mean no claim in either direction (not even 'not covered')")
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "platform-cert.json")); !os.IsNotExist(err) {
		t.Fatalf("no document must write no file (err=%v)", err)
	}
}

// The document survives a reboot, so a box that boots offline keeps a grant it
// legitimately had until the retained redelivery re-converges.
func TestTheDocumentIsPersistedAndRestoredAcrossARestart(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)
	a.onControlCert(certDoc(true))
	if !a.controlCertified("hybrid_3p") {
		t.Fatal("precondition: granted")
	}

	a2, _ := startBusOnlyAgent(t, cfg) // same data dir = the same box rebooting
	selectDeye(t, a2)
	if !a2.controlCertified("hybrid_3p") {
		t.Fatal("the platform grant must survive a restart")
	}

	// A retained clear removes the file again.
	a2.onControlCert([]byte(""))
	if a2.controlCertified("hybrid_3p") {
		t.Fatal("a retained clear must withdraw the platform grant")
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "platform-cert.json")); !os.IsNotExist(err) {
		t.Fatalf("a withdrawn document must leave no file (err=%v)", err)
	}
}

// The bench sign convention is checked, because it is firmware-dependent: a box
// configured the other way round is NOT what was proven.
func TestAContradictedSignConventionRefusesTheGrantAndNamesTheReason(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeyeWithInvertedControlSign(t, a)

	no := false
	a.onControlCert(certDoc(true, func(d *controlcert.Document) {
		d.Models[0].InvertControlSign = &no
	}))

	if a.controlCertified("hybrid_3p") {
		t.Fatal("a contradicted sign convention must fail closed")
	}
	info := a.State.Get().PlatformCert
	if info == nil || info.Reason == "" {
		t.Fatalf("a refusal must name its reason, got %+v", info)
	}
}

// The heartbeat carries the source + the verdict, so the portal can tell the
// three situations apart instead of showing a bare boolean.
func TestTheHeartbeatReportsTheCertificationSourceAndTheRegisterVerdict(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)
	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 2, LoadKw: 3, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()

	a.onControlCert(certDoc(true))
	a.applySetpoint(time.Now().UTC())
	// A readback is what makes controlSummary emit at all.
	rb, _ := json.Marshal(map[string]any{
		"ts": time.Now().UTC().Format(time.RFC3339), "family": "hybrid_3p",
		"source": "schedule", "mode": "normal", "all_match": true,
		"registers": []map[string]any{{"role": "battery_power", "match": true}},
	})
	a.onControlReadback("", rb)

	sum := controlSummary(a.State.Get())
	if sum == nil {
		t.Fatal("expected a control summary")
	}
	if sum.CertSource != "platform" {
		t.Fatalf("cert_source = %q, want platform", sum.CertSource)
	}
	if sum.PlatformCert == nil || sum.PlatformCert.Verdict != string(controlcert.VerdictGranted) {
		t.Fatalf("platform_cert = %+v, want granted", sum.PlatformCert)
	}
	if !sum.Certified {
		t.Fatal("certified must be true - the gate flag comes from the core")
	}
}

// A box with no document at all reports NO platform block - so the cloud can
// tell "we do not know" from "not covered" and never invents a claim.
func TestAnOlderCloudLeavesTheHeartbeatBlockAbsent(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)
	rb, _ := json.Marshal(map[string]any{
		"ts": time.Now().UTC().Format(time.RFC3339), "family": "hybrid_3p",
		"source": "schedule", "mode": "normal", "all_match": true,
		"registers": []map[string]any{{"role": "battery_power", "match": true}},
	})
	a.onControlReadback("", rb)

	sum := controlSummary(a.State.Get())
	if sum == nil {
		t.Fatal("expected a control summary")
	}
	if sum.PlatformCert != nil {
		t.Fatalf("platform_cert = %+v, want absent", sum.PlatformCert)
	}
	if sum.CertSource != "" {
		t.Fatalf("cert_source = %q, want empty", sum.CertSource)
	}
}

// Changing the selection re-evaluates the register - the register did not
// change, but what it applies to did.
func TestChangingTheInverterSelectionReEvaluatesTheRegister(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)
	a.onControlCert(certDoc(true))
	if !a.controlCertified("hybrid_3p") {
		t.Fatal("precondition: granted")
	}

	selectOtherDeyeModel(t, a)
	if a.controlCertified(a.currentFamily()) {
		t.Fatal("another model must lose the grant until it is registered too")
	}
}

// selectDeyeWithInvertedControlSign is selectDeye with the WRITE sign flipped -
// the firmware-dependent setting the bench statement is checked against.
func selectDeyeWithInvertedControlSign(t *testing.T, a *Agent) {
	t.Helper()
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand: inverter.BrandDeye, Model: "sun-30k-sg01hp3",
		Connection: inverter.Connection{IP: "192.168.0.28", Serial: "2985159064",
			InvertControlSign: true},
	}); err != nil {
		t.Fatalf("SetInverter: %v", err)
	}
}

// selectOtherDeyeModel picks a DIFFERENT Deye of the SAME register family.
func selectOtherDeyeModel(t *testing.T, a *Agent) {
	t.Helper()
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand: inverter.BrandDeye, Model: "sun-12k-sg04lp3",
		Connection: inverter.Connection{IP: "192.168.0.28", Serial: "2985159064"},
	}); err != nil {
		t.Fatalf("SetInverter: %v", err)
	}
}
