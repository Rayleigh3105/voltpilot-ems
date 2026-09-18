package measurements

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var testID = Identity{"00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000003"}

func config(rev int64, tenant string) []byte {
	return []byte(fmt.Sprintf(`{"schema_version":"2.0","tenant_id":"%s","site_id":"%s","device_id":"%s","revision":%d,"catalog_version":"2026.08.25.1","selections":[{"point_key":"goe.api_v2.nrg","cadence_s":30}]}`, tenant, testID.SiteID, testID.DeviceID, rev))
}
func batch(at time.Time) []byte {
	return []byte(fmt.Sprintf(`{"catalog_version":"2026.08.25.1","observed_at":"%s","samples":[{"point_key":"goe.api_v2.nrg","raw":17,"decoded":17,"quality":"good"}]}`, at.Format(time.RFC3339Nano)))
}

func multiBatch(at time.Time, count int) []byte {
	samples := make([]map[string]any, count)
	for i := range samples {
		samples[i] = map[string]any{"point_key": fmt.Sprintf("test.p%d", i), "raw": i, "quality": "good"}
	}
	raw, _ := json.Marshal(map[string]any{"catalog_version": "2026.08.25.1",
		"observed_at": at, "samples": samples})
	return raw
}

func TestConfigIdentityAndRevisionAreStrict(t *testing.T) {
	if _, e := ParseConfig(config(2, testID.TenantID), testID, 1); e != nil {
		t.Fatal(e)
	}
	if _, e := ParseConfig(config(1, testID.TenantID), testID, 1); e == nil {
		t.Fatal("stale accepted")
	}
	if _, e := ParseConfig(config(2, "10000000-0000-0000-0000-000000000001"), testID, 1); e == nil {
		t.Fatal("foreign accepted")
	}
}

func TestCustomConfigCarriesExecutableDefinitionOnlyForCustomKeys(t *testing.T) {
	raw := []byte(fmt.Sprintf(`{"schema_version":"2.0","tenant_id":"%s","site_id":"%s","device_id":"%s","revision":2,"catalog_version":"2026.08.25.1","selections":[{"point_key":"custom.abc","cadence_s":30,"definition":{"label":"Test","sourceKind":"modbus_input","address":42,"selector":"input:0x002a","valueType":"uint16","widthBits":16,"signed":false,"endian":"big","scale":1,"unit":"V","cadenceS":30,"retentionClass":"unclassified","readOnly":true,"requestCostMs":400}}]}`,
		testID.TenantID, testID.SiteID, testID.DeviceID))
	c, err := ParseConfig(raw, testID, 1)
	if err != nil || len(c.Selections[0].Definition) == 0 {
		t.Fatalf("custom definition lost: %#v %v", c, err)
	}
	if _, err = ParseConfig([]byte(fmt.Sprintf(`{"schema_version":"2.0","tenant_id":"%s","site_id":"%s","device_id":"%s","revision":2,"catalog_version":"2026.08.25.1","selections":[{"point_key":"goe.api_v2.alw","cadence_s":30,"definition":{}}]}`,
		testID.TenantID, testID.SiteID, testID.DeviceID)), testID, 1); err == nil {
		t.Fatal("catalog point accepted custom definition")
	}
}

// The cloud may bind a selection to a component (Stufe 3b) long before this
// build can use that binding. The plan must still apply: refusing the unknown
// field would take a whole box's measurements away over routing metadata.
func TestPerComponentSelectionCarriesItsBindingAndIsShapeChecked(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts", "v2",
		"examples", "mqtt-measurement-config.valid.per-component.json"))
	if err != nil {
		t.Fatal(err)
	}
	c, err := ParseConfig(raw, testID, 1)
	if err != nil {
		t.Fatalf("per-component plan refused: %v", err)
	}
	if len(c.Selections) != 2 {
		t.Fatalf("selections %d", len(c.Selections))
	}
	// Stufe 3c: the binding SELECTS the device Node-RED reads the point over.
	// An absent one is the pre-3c "belongs to the device as a whole" and must
	// stay absent - inventing one would bind a plan to a component nobody named.
	if c.Selections[0].EntityID != "00000000-0000-0000-0000-0000000000a1" || c.Selections[1].EntityID != "" {
		t.Fatalf("entity binding lost/invented: %#v", c.Selections)
	}
	if c.Selections[0].PointKey != "deye.hybrid_1p.battery.battery" ||
		c.Selections[0].CadenceS != 10 {
		t.Fatalf("selection changed: %#v", c.Selections[0])
	}

	// A malformed binding is a broken DOCUMENT, not a missing component: it must
	// never reach the binding layer as an unresolvable key.
	broken := bytes.Replace(raw, []byte("00000000-0000-0000-0000-0000000000a1"), []byte("not-a-uuid"), 1)
	if _, err := ParseConfig(broken, testID, 1); err == nil {
		t.Fatal("a malformed entity_id was accepted")
	}
}

func TestTheBindingRefusalIsPartOfTheStatusVocabulary(t *testing.T) {
	// The edge refuses a point whose component it cannot place on a device it
	// reads. The word must survive WrapStatus, or the WHOLE acknowledgement is
	// dropped and every point of that device stays pending forever.
	local := []byte(`{"revision":4,"applied_at":"2026-08-27T10:00:00Z","accepted":[],` +
		`"rejected":[{"point_key":"sunspec.model_103.w","reason":"binding_unavailable"}]}`)
	wrapped, err := WrapStatus(local, testID, "edge-2026.08.27")
	if err != nil {
		t.Fatalf("binding refusal refused by WrapStatus: %v", err)
	}
	if !bytes.Contains(wrapped, []byte(`"reason":"binding_unavailable"`)) {
		t.Fatalf("refusal reason lost: %s", wrapped)
	}
	unknown := bytes.Replace(local, []byte("binding_unavailable"), []byte("because_i_said_so"), 1)
	if _, err := WrapStatus(unknown, testID, "edge-2026.08.27"); err == nil {
		t.Fatal("an unknown reason must not reach the cloud")
	}
}

func TestOutboxReplaysInOrderAndReportsBoundedDrop(t *testing.T) {
	dir := t.TempDir()
	o, e := OpenOutbox(dir, 2)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now().UTC()
	for i := 0; i < 3; i++ {
		if _, e = o.Append(batch(now.Add(time.Duration(i)*time.Second)), testID); e != nil {
			t.Fatal(e)
		}
	}
	if o.Pending() != 2 {
		t.Fatalf("pending %d", o.Pending())
	}
	first, _ := o.Next()
	var p map[string]any
	if json.Unmarshal(first.Raw, &p) != nil {
		t.Fatal("json")
	}
	if p["sequence"].(float64) != 1 || p["gap"] != true || p["dropped_samples"].(float64) != 1 {
		t.Fatalf("unexpected %#v", p)
	}
	if e = o.Ack(first.Sequence); e != nil {
		t.Fatal(e)
	}
	second, _ := o.Next()
	if second.Sequence != 2 {
		t.Fatal("out of order")
	}
	var clean map[string]any
	if json.Unmarshal(second.Raw, &clean) != nil || clean["gap"] != false || clean["dropped_samples"].(float64) != 0 {
		t.Fatalf("drop episode repeated %#v", clean)
	}
	// Reopening is the reconnect/restart path: replay remains ordered and the
	// next sequence never rewinds onto an existing envelope.
	reopened, e := OpenOutbox(dir, 2)
	if e != nil {
		t.Fatal(e)
	}
	third, e := reopened.Append(batch(now.Add(4*time.Second)), testID)
	if e != nil || third.Sequence != 3 {
		t.Fatalf("sequence did not recover: %#v %v", third, e)
	}
}
func TestNoRawMeansNoSample(t *testing.T) {
	o, _ := OpenOutbox(t.TempDir(), 2)
	bad := []byte(`{"catalog_version":"2026.08.25.1","observed_at":"2026-08-25T12:00:00Z","samples":[{"point_key":"x","decoded":1,"quality":"good"}]}`)
	if _, e := o.Append(bad, testID); e == nil {
		t.Fatal("invented raw accepted")
	}
}

func TestOutboxPreservesWideDecimalStringRawExactly(t *testing.T) {
	o, err := OpenOutbox(t.TempDir(), 2)
	if err != nil {
		t.Fatal(err)
	}
	local := []byte(`{"catalog_version":"2026.08.25.1","observed_at":"2026-08-25T12:00:00Z","samples":[{"point_key":"goe.api_v2.eto","raw":"9007199254740993","quality":"good"}]}`)
	if _, err = o.Append(local, testID); err != nil {
		t.Fatal(err)
	}
	envelope, ok := o.Next()
	if !ok {
		t.Fatal("missing persisted envelope")
	}
	var payload struct {
		Samples []struct {
			Raw any `json:"raw"`
		} `json:"samples"`
	}
	if err = json.Unmarshal(envelope.Raw, &payload); err != nil {
		t.Fatal(err)
	}
	if got, ok := payload.Samples[0].Raw.(string); !ok || got != "9007199254740993" {
		t.Fatalf("wide integer changed type or value: %#v", payload.Samples[0].Raw)
	}
}

func TestBackpressureNeverEvictsInFlightOrClearsLaterDrops(t *testing.T) {
	o, err := OpenOutbox(t.TempDir(), 2)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for i := 0; i < 2; i++ {
		if _, err = o.Append(batch(now.Add(time.Duration(i)*time.Second)), testID); err != nil {
			t.Fatal(err)
		}
	}
	first, ok := o.Next()
	if !ok || first.Sequence != 0 {
		t.Fatalf("first in-flight envelope = %#v", first)
	}
	// While sequence 0 waits for PUBACK, bounded eviction must skip it and
	// remove sequence 1. Acking 0 did not report that later loss.
	if _, err = o.Append(batch(now.Add(2*time.Second)), testID); err != nil {
		t.Fatal(err)
	}
	if err = o.Ack(first.Sequence); err != nil {
		t.Fatal(err)
	}
	second, ok := o.Next()
	var payload map[string]any
	badSecond := !ok || second.Sequence != 2 || json.Unmarshal(second.Raw, &payload) != nil ||
		payload["gap"] != true || payload["dropped_samples"].(float64) != 1
	if badSecond {
		t.Fatalf("later loss was hidden: %#v %#v", second, payload)
	}
	// Another eviction while sequence 2 carries the first loss leaves the new
	// loss pending after its PUBACK.
	_, _ = o.Append(batch(now.Add(3*time.Second)), testID)
	_, _ = o.Append(batch(now.Add(4*time.Second)), testID)
	if err = o.Ack(second.Sequence); err != nil {
		t.Fatal(err)
	}
	third, ok := o.Next()
	payload = nil
	badThird := !ok || third.Sequence != 4 || json.Unmarshal(third.Raw, &payload) != nil ||
		payload["dropped_samples"].(float64) != 1
	if badThird {
		t.Fatalf("concurrent drop was cleared: %#v %#v", third, payload)
	}
}

func TestEvictionCountsSamplesNotEnvelopeFiles(t *testing.T) {
	o, err := OpenOutbox(t.TempDir(), 2)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err = o.Append(multiBatch(now, 7), testID); err != nil {
		t.Fatal(err)
	}
	if _, err = o.Append(batch(now.Add(time.Second)), testID); err != nil {
		t.Fatal(err)
	}
	if _, err = o.Append(batch(now.Add(2*time.Second)), testID); err != nil {
		t.Fatal(err)
	}
	next, ok := o.Next()
	var payload struct {
		Dropped int64 `json:"dropped_samples"`
	}
	if !ok || json.Unmarshal(next.Raw, &payload) != nil || payload.Dropped != 7 {
		t.Fatalf("lost samples were not counted exactly: %#v %#v", next, payload)
	}
}

func TestPreparedEvictionRecoversBothCrashSidesExactly(t *testing.T) {
	for _, tc := range []struct {
		name       string
		fileExists bool
		want       int64
	}{
		{"before-remove", true, 0}, {"after-remove", false, 9},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			name := "00000000000000000000.json"
			if tc.fileExists {
				if err := os.WriteFile(filepath.Join(dir, name), batch(time.Now().UTC()), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			state, _ := json.Marshal(diskState{NextSequence: 1, PendingDropFile: name, PendingDropSamples: 9})
			if err := os.WriteFile(filepath.Join(dir, "state.json"), state, 0o644); err != nil {
				t.Fatal(err)
			}
			o, err := OpenOutbox(dir, 2)
			if err != nil {
				t.Fatal(err)
			}
			if o.state.Dropped != tc.want || o.state.PendingDropFile != "" {
				t.Fatalf("recovery state = %#v", o.state)
			}
		})
	}
}

// registerbildConfig is the UEMS AP-05 IP-6 shape: the per-installation
// parameters of a WAGO register image next to the usual selections.
func registerbildConfig(body string) []byte {
	return []byte(fmt.Sprintf(`{"schema_version":"2.0","tenant_id":"%s","site_id":"%s","device_id":"%s","revision":2,"catalog_version":"2026.08.25.1","selections":[{"point_key":"goe.api_v2.nrg","cadence_s":30}]%s}`,
		testID.TenantID, testID.SiteID, testID.DeviceID, body))
}

func TestRegisterbildIsAdditiveAndLeavesATodaysBoxUntouched(t *testing.T) {
	// ⚠ Mischbetrieb: a config WITHOUT the field must parse exactly as before -
	// no box shipped so far sends one, and none may start failing over it.
	ohne, err := ParseConfig(config(2, testID.TenantID), testID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if ohne.Registerbilder != nil {
		t.Fatalf("a config without registerbilder must carry none: %#v", ohne.Registerbilder)
	}
	roundtrip, err := json.Marshal(ohne)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(roundtrip, []byte("registerbilder")) {
		t.Fatalf("the empty field must not appear on the wire: %s", roundtrip)
	}

	mit := registerbildConfig(`,"registerbilder":[{"entity_id":"00000000-0000-0000-0000-00000000000a","basisadresse":4096,"funktionscode":4,"wortfolge":"little","kartenzahl":2,"controller_kennung":7,"karten":[{"steckplatz":2,"kartentyp":494,"variante":1},{"steckplatz":3,"kartentyp":495,"variante":25001}]}]`)
	c, err := ParseConfig(mit, testID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Registerbilder) != 1 {
		t.Fatalf("registerbild lost: %#v", c.Registerbilder)
	}
	b := c.Registerbilder[0]
	if b.Basisadresse != 4096 || b.Funktionscode != 4 || b.Wortfolge != "little" ||
		b.Kartenzahl != 2 || b.ControllerKennung != 7 || len(b.Karten) != 2 {
		t.Fatalf("registerbild parameters garbled: %#v", b)
	}
	// One controller can carry a 750-494 and a 750-495 side by side.
	if b.Karten[0].Kartentyp != 494 || b.Karten[1].Kartentyp != 495 ||
		b.Karten[1].Variante != 25001 {
		t.Fatalf("cards garbled: %#v", b.Karten)
	}
}

func TestRegisterbildShapeIsChecked(t *testing.T) {
	karte := `[{"steckplatz":2,"kartentyp":494,"variante":1}]`
	bad := map[string]string{
		"foreign function code": `{"entity_id":"00000000-0000-0000-0000-00000000000a","basisadresse":0,"funktionscode":6,"wortfolge":"big","kartenzahl":1,"controller_kennung":1,"karten":` + karte + `}`,
		"foreign word order":    `{"entity_id":"00000000-0000-0000-0000-00000000000a","basisadresse":0,"funktionscode":3,"wortfolge":"middle","kartenzahl":1,"controller_kennung":1,"karten":` + karte + `}`,
		"past the address space": `{"entity_id":"00000000-0000-0000-0000-00000000000a","basisadresse":65000,"funktionscode":3,"wortfolge":"big","kartenzahl":40,"controller_kennung":1,"karten":` + karte + `}`,
		"cards do not match kartenzahl": `{"entity_id":"00000000-0000-0000-0000-00000000000a","basisadresse":0,"funktionscode":3,"wortfolge":"big","kartenzahl":2,"controller_kennung":1,"karten":` + karte + `}`,
		"foreign card type": `{"entity_id":"00000000-0000-0000-0000-00000000000a","basisadresse":0,"funktionscode":3,"wortfolge":"big","kartenzahl":1,"controller_kennung":1,"karten":[{"steckplatz":2,"kartentyp":493,"variante":0}]}`,
		"two cards in one slot": `{"entity_id":"00000000-0000-0000-0000-00000000000a","basisadresse":0,"funktionscode":3,"wortfolge":"big","kartenzahl":2,"controller_kennung":1,"karten":[{"steckplatz":2,"kartentyp":494,"variante":1},{"steckplatz":2,"kartentyp":495,"variante":1}]}`,
		"no entity":             `{"entity_id":"","basisadresse":0,"funktionscode":3,"wortfolge":"big","kartenzahl":1,"controller_kennung":1,"karten":` + karte + `}`,
		"unknown field":         `{"entity_id":"00000000-0000-0000-0000-00000000000a","basisadresse":0,"funktionscode":3,"wortfolge":"big","kartenzahl":1,"controller_kennung":1,"karten":` + karte + `,"unit_id":1}`,
	}
	for name, body := range bad {
		if _, err := ParseConfig(registerbildConfig(`,"registerbilder":[`+body+`]`), testID, 1); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	// The same entity twice would make the poll group ambiguous.
	doppelt := `{"entity_id":"00000000-0000-0000-0000-00000000000a","basisadresse":0,"funktionscode":3,"wortfolge":"big","kartenzahl":1,"controller_kennung":1,"karten":` + karte + `}`
	if _, err := ParseConfig(registerbildConfig(`,"registerbilder":[`+doppelt+`,`+doppelt+`]`), testID, 1); err == nil {
		t.Fatal("duplicate entity accepted")
	}
}
