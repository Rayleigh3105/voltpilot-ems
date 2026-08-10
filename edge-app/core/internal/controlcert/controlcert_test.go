package controlcert

import (
	"os"
	"path/filepath"
	"testing"
)

func pilstingDeye() Device {
	return Device{Brand: "deye", Model: "SUN-30K-SG01HP3-EU", Family: "hybrid_3p"}
}

func doc(activated bool, models ...Model) *Document {
	return &Document{
		SchemaVersion: SchemaVersion,
		TenantID:      "t", SiteID: "s", DeviceID: "d",
		Activated: activated,
		Models:    models,
	}
}

func entry() Model {
	return Model{Brand: "deye", Model: "SUN-30K-SG01HP3-EU", Family: "hybrid_3p",
		ControlPath: "remote", CertifiedAt: "2026-07-27T14:05:00Z"}
}

// THE point of the whole feature: a model certified once is granted on the NEXT
// customer's box without any bench run, env edit or First-Light there.
func TestACertifiedModelIsGrantedOnAnotherCustomersDeviceWithoutAnyLocalProof(t *testing.T) {
	g, v, reason := Match(doc(true, entry()), pilstingDeye())
	if v != VerdictGranted {
		t.Fatalf("verdict = %q, want granted (reason %q)", v, reason)
	}
	if !g.Granted || g.Family != "hybrid_3p" || g.Model != "SUN-30K-SG01HP3-EU" {
		t.Fatalf("grant = %+v", g)
	}
	if g.ControlPath != "remote" {
		t.Fatalf("the proven control path must travel with the grant, got %q", g.ControlPath)
	}
}

// Both halves are required. The register alone controls nothing.
func TestARegisteredModelWithoutActivationGrantsNothingButSaysWhy(t *testing.T) {
	g, v, _ := Match(doc(false, entry()), pilstingDeye())
	if v != VerdictCoveredNotActivated {
		t.Fatalf("verdict = %q, want covered_not_activated", v)
	}
	if g.Granted || g.Family != "" {
		t.Fatalf("an unactivated plant must get NO grant, got %+v", g)
	}
	// ... but the covered model IS named, so a surface can say which one waits.
	if g.Model != "SUN-30K-SG01HP3-EU" {
		t.Fatalf("a covered model must stay nameable, got %+v", g)
	}
}

// The key is the MODEL, so one bench run never leaks onto a sibling that merely
// shares the register family (hybrid_3p covers LV SG04LP3 AND HV SG01HP3).
func TestASiblingOfTheSameFamilyIsNotCovered(t *testing.T) {
	sibling := Device{Brand: "deye", Model: "SUN-12K-SG04LP3-EU", Family: "hybrid_3p"}
	if _, v, _ := Match(doc(true, entry()), sibling); v != VerdictNotCovered {
		t.Fatalf("verdict = %q, want not_covered - a family is not a model", v)
	}
}

// The family is CHECKED, not derived: same model under another register map is
// not what the bench proved.
func TestTheFamilyMustMatchToo(t *testing.T) {
	other := pilstingDeye()
	other.Family = "hybrid_1p"
	if _, v, _ := Match(doc(true, entry()), other); v != VerdictNotCovered {
		t.Fatalf("verdict = %q, want not_covered", v)
	}
}

func TestBrandModelAndFamilyMatchCaseInsensitively(t *testing.T) {
	shouty := Device{Brand: "DEYE", Model: "sun-30k-sg01hp3-eu", Family: "HYBRID_3P"}
	if _, v, _ := Match(doc(true, entry()), shouty); v != VerdictGranted {
		t.Fatalf("verdict = %q, want granted", v)
	}
}

// The write sign is firmware-dependent, so a stated bench convention is part of
// what was proven - a differently configured box is NOT covered, and says why.
func TestAContradictedSignConventionFailsClosedWithAReason(t *testing.T) {
	no := false
	e := entry()
	e.InvertControlSign = &no

	dev := pilstingDeye()
	dev.InvertControlSign = true

	g, v, reason := Match(doc(true, e), dev)
	if v != VerdictNotCovered {
		t.Fatalf("verdict = %q, want not_covered", v)
	}
	if g.Granted {
		t.Fatalf("a sign mismatch must grant nothing, got %+v", g)
	}
	if reason == "" {
		t.Fatal("a refusal must name its reason")
	}
	// The matching box is still granted.
	dev.InvertControlSign = false
	if _, v, _ = Match(doc(true, e), dev); v != VerdictGranted {
		t.Fatalf("verdict = %q, want granted for the benched sign", v)
	}
}

// Absent is NOT false: an entry that does not state a sign claims nothing, so
// it can contradict nothing.
func TestAnAbsentSignConventionChecksNothing(t *testing.T) {
	for _, configured := range []bool{false, true} {
		dev := pilstingDeye()
		dev.InvertControlSign = configured
		if _, v, _ := Match(doc(true, entry()), dev); v != VerdictGranted {
			t.Fatalf("configured sign %v: verdict = %q, want granted", configured, v)
		}
	}
}

// Unknown is a THIRD answer and must never be reported as "not covered".
func TestNoDocumentOrNoSelectionIsUnknownNeverNotCovered(t *testing.T) {
	if _, v, _ := Match(nil, pilstingDeye()); v != VerdictUnknown {
		t.Fatalf("no document: verdict = %q, want unknown", v)
	}
	if _, v, _ := Match(doc(true, entry()), Device{}); v != VerdictUnknown {
		t.Fatalf("no selection: verdict = %q, want unknown", v)
	}
	noModel := Device{Brand: "deye", Family: "hybrid_3p"}
	if _, v, _ := Match(doc(true, entry()), noModel); v != VerdictUnknown {
		t.Fatalf("selection without a model: verdict = %q, want unknown", v)
	}
}

// An EMPTY register is valid and means "nothing certified yet" - never
// "everything allowed".
func TestAnEmptyRegisterCoversNothing(t *testing.T) {
	if _, v, _ := Match(doc(true), pilstingDeye()); v != VerdictNotCovered {
		t.Fatalf("verdict = %q, want not_covered", v)
	}
}

func TestParseRejectsAnUnknownSchemaVersionInsteadOfGuessing(t *testing.T) {
	raw := []byte(`{"schema_version":"2.0","tenant_id":"t","site_id":"s","device_id":"d",
	   "activated":true,"certified_models":[],"published_at":"2026-08-10T09:00:00Z"}`)
	if _, err := Parse(raw); err == nil {
		t.Fatal("an unknown contract version must be rejected fail-closed")
	}
}

func TestParseTreatsTheRetainedClearAsNoDocumentNotAnError(t *testing.T) {
	for _, raw := range [][]byte{nil, {}, []byte("   ")} {
		d, err := Parse(raw)
		if err != nil || d != nil {
			t.Fatalf("retained clear: doc=%v err=%v, want (nil, nil)", d, err)
		}
	}
}

func TestParseRejectsGarbageAndAnIncompleteIdentity(t *testing.T) {
	if _, err := Parse([]byte("not json")); err == nil {
		t.Fatal("garbage must be rejected")
	}
	raw := []byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"","device_id":"d",
	   "activated":true,"certified_models":[],"published_at":"x"}`)
	if _, err := Parse(raw); err == nil {
		t.Fatal("an incomplete identity must be rejected")
	}
}

// One malformed row must not cost the whole register its meaning, and it can
// only ever grant LESS.
func TestParseDropsAMalformedEntryButKeepsTheRest(t *testing.T) {
	raw := []byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s","device_id":"d",
	  "activated":true,"published_at":"2026-08-10T09:00:00Z","certified_models":[
	    {"brand":"deye","family":"hybrid_3p","certified_at":"x"},
	    {"brand":"deye","model":"SUN-30K-SG01HP3-EU","family":"hybrid_3p","certified_at":"x"}]}`)
	d, err := Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(d.Models) != 1 || d.Models[0].Model != "SUN-30K-SG01HP3-EU" {
		t.Fatalf("models = %+v, want only the well-formed one", d.Models)
	}
}

// An unknown control path is dropped rather than stored as a claim.
func TestParseDropsAnUnknownControlPath(t *testing.T) {
	raw := []byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s","device_id":"d",
	  "activated":true,"published_at":"2026-08-10T09:00:00Z","certified_models":[
	    {"brand":"deye","model":"m","family":"f","control_path":"telepathie","certified_at":"x"}]}`)
	d, err := Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if d.Models[0].ControlPath != "" {
		t.Fatalf("control_path = %q, want dropped", d.Models[0].ControlPath)
	}
}

func TestBelongsToEnforcesTheTopicIdentity(t *testing.T) {
	d := doc(true, entry())
	if !d.BelongsTo("t", "s", "d") {
		t.Fatal("own identity must match")
	}
	if d.BelongsTo("t", "s", "someone-else") {
		t.Fatal("a foreign device id must NOT match")
	}
	if (*Document)(nil).BelongsTo("t", "s", "d") {
		t.Fatal("nil must never belong to anyone")
	}
}

// The committed contract fixtures are read BY PATH, so moving one deliberately
// breaks the contract check (the plan_test.go / otaverify discipline).
func TestTheCommittedContractFixturesParseAndDecideAsDocumented(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "docs", "contracts", "examples")

	granted := mustParseFixture(t, filepath.Join(dir, "mqtt-control-certification.valid.granted.json"))
	dev := Device{Brand: "deye", Model: "SUN-30K-SG01HP3-EU", Family: "hybrid_3p"}
	if _, v, _ := Match(granted, dev); v != VerdictGranted {
		t.Fatalf("granted fixture: verdict = %q", v)
	}
	if !granted.BelongsTo("00000000-0000-0000-0000-000000000001",
		"00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000003") {
		t.Fatal("granted fixture must belong to its documented identity")
	}

	pending := mustParseFixture(t, filepath.Join(dir, "mqtt-control-certification.valid.not-activated.json"))
	if _, v, _ := Match(pending, dev); v != VerdictCoveredNotActivated {
		t.Fatalf("not-activated fixture: verdict = %q", v)
	}

	// The invalid fixture is invalid because its entry names no MODEL - the
	// row is dropped, so the register covers nothing.
	bad := mustParseFixture(t, filepath.Join(dir, "mqtt-control-certification.invalid.model-missing.json"))
	if _, v, _ := Match(bad, dev); v != VerdictNotCovered {
		t.Fatalf("invalid fixture: verdict = %q, want not_covered", v)
	}
}

func mustParseFixture(t *testing.T, path string) *Document {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	d, err := Parse(raw)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if d == nil {
		t.Fatalf("%s parsed to no document", path)
	}
	return d
}
