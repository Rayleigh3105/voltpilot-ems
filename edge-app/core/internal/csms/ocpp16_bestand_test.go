package csms_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
)

// ocpp16BestandGolden is the fingerprint of the OCPP 1.6J wire, the persisted
// chargers.json and the snapshot for one fixed station conversation. It was
// recorded on the stand BEFORE the OCPP 2.0.1 lane existed (MiSpeL MP-35) and
// pins that a 1.6 station sees byte-for-byte the same central system after it.
//
// A deliberate change to the 1.6 path rewrites it with
// VP_OCPP16_BESTAND_SCHREIBEN=1 and says why in the PR.
const ocpp16BestandGolden = "testdata/ocpp16_bestand.golden.json"

var tagRefPattern = regexp.MustCompile(`tagref_[0-9a-f]{24}`)

type ocpp16Bestand struct {
	Subprotocol string            `json:"subprotocol"`
	Frames      []json.RawMessage `json:"frames"`
	Chargers    json.RawMessage   `json:"chargers_json"`
	Snapshot    json.RawMessage   `json:"snapshot"`
}

func TestOCPP16BestandBleibtByteGleich(t *testing.T) {
	at := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	s, err := csms.New(csms.Options{Enabled: true, DataDir: dir, Log: quiet(), Now: func() time.Time { return at }})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add(csms.AddRequest{ID: "BESTAND-16"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Stop)
	snap := s.Snapshot()
	url := fmt.Sprintf("ws://127.0.0.1:%d%s/BESTAND-16", snap.Port, snap.URLPath)

	dialer := websocket.Dialer{Subprotocols: []string{"ocpp1.6"}, HandshakeTimeout: 2 * time.Second}
	conn, resp, err := dialer.Dial(url, http.Header{})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	ts := at.Format(time.RFC3339)
	calls := []string{
		`[2,"b1","BootNotification",{"chargePointVendor":"Bestand","chargePointModel":"WB-16","firmwareVersion":"1.0.0","chargePointSerialNumber":"S-16"}]`,
		`[2,"b2","Heartbeat",{}]`,
		`[2,"b3","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Preparing"}]`,
		`[2,"b4","Authorize",{"idTag":"KARTE-16"}]`,
		`[2,"b5","StartTransaction",{"connectorId":1,"idTag":"KARTE-16","meterStart":1000,"timestamp":"` + ts + `"}]`,
		`[2,"b6","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Charging"}]`,
		`[2,"b7","MeterValues",{"connectorId":1,"transactionId":1,"meterValue":[{"timestamp":"` + ts + `","sampledValue":[` +
			`{"value":"1500","measurand":"Energy.Active.Import.Register","unit":"Wh"},` +
			`{"value":"200","measurand":"Energy.Active.Export.Register","unit":"Wh"},` +
			`{"value":"7400","measurand":"Power.Active.Import","unit":"W"},` +
			`{"value":"55","measurand":"SoC","unit":"Percent"}]}]}]`,
		`[2,"b8","StopTransaction",{"transactionId":1,"meterStop":2000,"timestamp":"` + ts + `","idTag":"KARTE-16"}]`,
		`[2,"b9","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Available"}]`,
		`[2,"b10","DataTransfer",{"vendorId":"Bestand"}]`,
		`[2,"b11","Unbekannt",{}]`,
	}
	got := ocpp16Bestand{Subprotocol: resp.Header.Get("Sec-WebSocket-Protocol")}
	for _, call := range calls {
		if err := conn.WriteMessage(websocket.TextMessage, []byte(call)); err != nil {
			t.Fatalf("write %s: %v", call, err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, frame, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read after %s: %v", call, err)
		}
		got.Frames = append(got.Frames, json.RawMessage(frame))
	}

	raw, err := os.ReadFile(filepath.Join(dir, "chargers.json"))
	if err != nil {
		t.Fatal(err)
	}
	got.Chargers = json.RawMessage(raw)
	snap = s.Snapshot()
	snap.Port = 0 // the free port differs per run; everything else is fixed
	if got.Snapshot, err = json.Marshal(snap); err != nil {
		t.Fatal(err)
	}
	want, err := json.MarshalIndent(got, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	// The card pseudonym is an HMAC under this box's own random privacy key, so
	// it differs per data dir; its presence and shape are part of the print.
	want = tagRefPattern.ReplaceAll(append(want, '\n'), []byte("tagref_<pseudonym>"))

	if os.Getenv("VP_OCPP16_BESTAND_SCHREIBEN") == "1" {
		if err := os.MkdirAll(filepath.Dir(ocpp16BestandGolden), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(ocpp16BestandGolden, want, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("Fingerabdruck geschrieben: %s", ocpp16BestandGolden)
		return
	}
	golden, err := os.ReadFile(ocpp16BestandGolden)
	if err != nil {
		t.Fatalf("Fingerabdruck fehlt (%v) - auf dem Stand vor der Änderung mit VP_OCPP16_BESTAND_SCHREIBEN=1 aufnehmen", err)
	}
	if !bytes.Equal(golden, want) {
		t.Fatalf("OCPP-1.6-Bestand hat sich geändert.\nvorher:\n%s\nnachher:\n%s", golden, want)
	}
}
