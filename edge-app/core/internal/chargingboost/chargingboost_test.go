package chargingboost

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// examplesDir reads the CONTRACT's own fixtures by PATH, so moving one breaks
// this test deliberately (the house discipline).
func examplesDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "docs", "contracts", "examples"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Skipf("contract examples not reachable: %v", err)
	}
	return dir
}

func read(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(examplesDir(t), name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestTheContractFixturesParse(t *testing.T) {
	grant, err := Parse(read(t, "mqtt-charging-boost.valid.jetzt-voll-laden.json"))
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	if grant.ChargePointID != "saeule-1" || grant.Connector != 1 || grant.Minutes != 240 || grant.Cancel {
		t.Fatalf("grant = %+v", grant)
	}
	if grant.Actor == "" {
		t.Fatal("the paper trail must travel")
	}
	cancel, err := Parse(read(t, "mqtt-charging-boost.valid.zuruecknehmen.json"))
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if !cancel.Cancel {
		t.Fatal("the withdrawal must parse as one")
	}
	if _, err := Parse(read(t, "mqtt-charging-boost.invalid.stecker-null.json")); err == nil {
		t.Fatal("connector 0 must be refused - a plug is counted from 1")
	}
}

func TestEveryMalformedRequestIsRefusedByName(t *testing.T) {
	base := `{"schema_version":"1.0","tenant_id":"t","site_id":"s","device_id":"d",
	          "charge_point_id":"SAEULE-1","connector_id":1,"requested_at":"2026-08-20T13:24:00Z"}`
	if _, err := Parse([]byte(base)); err != nil {
		t.Fatalf("the baseline must parse: %v", err)
	}
	for name, payload := range map[string]string{
		"leer":                 "",
		"kaputt":               `{`,
		"fremde Version":       strings.Replace(base, `"1.0"`, `"2.0"`, 1),
		"ohne Identität":       strings.Replace(base, `"device_id":"d"`, `"device_id":""`, 1),
		"ohne Säule":           strings.Replace(base, `"charge_point_id":"SAEULE-1"`, `"charge_point_id":"  "`, 1),
		"Stecker 0":            strings.Replace(base, `"connector_id":1`, `"connector_id":0`, 1),
		"zu lange Dauer":       strings.Replace(base, `"connector_id":1`, `"connector_id":1,"minutes":600`, 1),
		"ohne Zeitstempel":     strings.Replace(base, `"requested_at":"2026-08-20T13:24:00Z"`, `"requested_at":""`, 1),
		"kaputter Zeitstempel": strings.Replace(base, `"2026-08-20T13:24:00Z"`, `"gestern"`, 1),
	} {
		if _, err := Parse([]byte(payload)); err == nil {
			t.Fatalf("%s must be refused", name)
		}
	}
}

// TestALateDeliveryIsAlreadyExpiredWhenItLands is the second half of the replay
// defence - the first is that the message is not retained.
func TestALateDeliveryIsAlreadyExpiredWhenItLands(t *testing.T) {
	granted := time.Date(2026, 8, 20, 13, 24, 0, 0, time.UTC)
	req := Request{RequestedAt: granted}
	if req.Expired(granted.Add(Window - time.Second)) {
		t.Fatal("inside the window it is valid")
	}
	if !req.Expired(granted.Add(Window + time.Second)) {
		t.Fatal("a redelivered message must be expired on arrival")
	}
	// A stamp from the FUTURE is clock skew, not the customer's fault.
	if req.Expired(granted.Add(-time.Minute)) {
		t.Fatal("a future stamp must not expire a request")
	}
	msg := req.ExpiredMessage(granted.Add(Window + time.Minute))
	if !strings.Contains(msg, "13:24") || !strings.Contains(msg, "13:2") {
		t.Fatalf("the refusal must name BOTH clocks: %q", msg)
	}
}

func TestAForeignIdentityIsNotUs(t *testing.T) {
	r := Request{TenantID: "t", SiteID: "s", DeviceID: "d"}
	if !r.MatchesIdentity("t", "s", "d") {
		t.Fatal("our own identity must match")
	}
	if r.MatchesIdentity("t", "s", "anderes") {
		t.Fatal("a foreign device must never match")
	}
}
