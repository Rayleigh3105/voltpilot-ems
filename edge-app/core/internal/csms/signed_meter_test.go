package csms

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
	types16 "github.com/lorenzodonini/ocpp-go/ocpp1.6/types"
	types201 "github.com/lorenzodonini/ocpp-go/ocpp2.0.1/types"
)

// kebaRecord is the public KEBA KC-P30 record with its meter key (S.A.F.E.
// Transparenzsoftware test data, see internal/ocmf/testdata).
func kebaRecord(t *testing.T) (record, key string) {
	t.Helper()
	raw, err := os.ReadFile("../ocmf/testdata/safe-transparenzsoftware.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Datensaetze []struct {
			Datei, OCMF, Schluessel string
		} `json:"datensaetze"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	for _, d := range f.Datensaetze {
		if d.Datei == "test_ocmf_keba_kcp30.xml" {
			return d.OCMF, d.Schluessel
		}
	}
	t.Fatal("KEBA-Datensatz fehlt")
	return "", ""
}

func signedEvents(t *testing.T, s *Server) []signedMeterPayload {
	t.Helper()
	var out []signedMeterPayload
	for {
		raw, token, ok := s.NextProtocolEvent()
		if !ok {
			return out
		}
		var e ProtocolEvent
		if err := json.Unmarshal(raw, &e); err != nil {
			t.Fatal(err)
		}
		if e.Action == SignedMeterValueAction {
			if e.Direction != "internal" || e.MessageType != "Event" || len(e.EventID) != 36 {
				t.Fatalf("Umschlag: %+v", e)
			}
			var p signedMeterPayload
			if err := json.Unmarshal(e.Payload, &p); err != nil {
				t.Fatal(err)
			}
			out = append(out, p)
		}
		if err := s.AckProtocolEvent(token); err != nil {
			t.Fatal(err)
		}
	}
}

func signedTestServer(t *testing.T) *Server {
	t.Helper()
	now := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	s, err := New(Options{Enabled: false, DataDir: t.TempDir(), Now: func() time.Time { return now },
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	s.chargers["cp-1"] = &ChargerState{Charger: Charger{ID: "cp-1"}, Connected: true}
	return s
}

// OCPP 1.6: the record rides in a SignedData value next to the Raw value. 1.6
// carries no key, so the check ends "nicht_pruefbar / schluessel_fehlt" - the
// record is still kept unchanged and handed on.
func TestOCPP16SignedDataIsJournalledUnchanged(t *testing.T) {
	record, _ := kebaRecord(t)
	s := signedTestServer(t)
	h := &coreHandler{srv: s}
	tx := 7
	ts := types16.NewDateTime(time.Date(2026, 10, 2, 11, 59, 58, 0, time.UTC))
	req := &core.MeterValuesRequest{ConnectorId: 1, TransactionId: &tx, MeterValue: []types16.MeterValue{{
		Timestamp: ts,
		SampledValue: []types16.SampledValue{
			{Value: "259.7", Measurand: types16.MeasurandEnergyActiveImportRegister, Unit: types16.UnitOfMeasureWh},
			{Value: hex.EncodeToString([]byte(record)), Format: types16.ValueFormatSignedData, Context: types16.ReadingContextTransactionEnd},
		},
	}}}
	if _, err := h.OnMeterValues("cp-1", req); err != nil {
		t.Fatal(err)
	}
	got := signedEvents(t, s)
	if len(got) != 1 {
		t.Fatalf("%d signierte Ereignisse, erwartet 1", len(got))
	}
	p := got[0]
	if p.OCMF != record || p.OCPP != "1.6" || p.Quelle != "MeterValues" || p.ConnectorID != 1 || p.TransactionID == nil || *p.TransactionID != 7 {
		t.Fatalf("Ereignis: %+v", p)
	}
	if p.Signaturstatus != "nicht_pruefbar" || p.Pruefgrund != "schluessel_fehlt" || p.SchluesselQuelle != "keine" || p.Schluessel != "" {
		t.Fatalf("Pruefung: %+v", p)
	}
	if len(p.Ablesungen) != 2 || p.Ablesungen[1].Wert != "0.2597" || p.Ablesungen[1].Anlass != "E" ||
		p.Ablesungen[0].GemessenAm != "2019-08-13T10:03:15Z" || p.Ablesungen[0].Zeitstatus != "I" || p.Ablesungen[1].Einheit != "kWh" {
		t.Fatalf("Ablesungen: %+v", p.Ablesungen)
	}
	// the same record again (e.g. in StopTransaction.transactionData) is the same fact in the cloud
	if id1, id2 := signedEventID("cp-1", 1, record), signedEventID("cp-1", 1, record); id1 != id2 || id1[14] != '5' {
		t.Fatalf("Ereigniskennung nicht stabil: %s %s", id1, id2)
	}
}

// OCPP 2.0.1: signedMeterValue carries record and key base64 encoded.
func TestOCPP201SignedMeterValueIsChecked(t *testing.T) {
	record, key := kebaRecord(t)
	der, _ := hex.DecodeString(key)
	s := signedTestServer(t)
	smv := func(rec string) []types201.MeterValue {
		return []types201.MeterValue{{Timestamp: *types201.NewDateTime(time.Now()), SampledValue: []types201.SampledValue{
			{Value: 259.7},
			{Value: 259.7, SignedMeterValue: &types201.SignedMeterValue{
				SignedMeterData: base64.StdEncoding.EncodeToString([]byte(rec)), SigningMethod: "",
				EncodingMethod: "OCMF", PublicKey: base64.StdEncoding.EncodeToString(der)}},
		}}}
	}
	tx := 3
	s.signedSamples201("cp-1", 1, smv(record), &tx, "TransactionEvent", time.Now())
	s.signedSamples201("cp-1", 1, smv(strings.Replace(record, `"RV":0.2597`, `"RV":0.2598`, 1)), &tx, "TransactionEvent", time.Now())
	got := signedEvents(t, s)
	if len(got) != 2 {
		t.Fatalf("%d Ereignisse", len(got))
	}
	if got[0].Signaturstatus != "gueltig" || got[0].Pruefgrund != "" || got[0].SchluesselQuelle != "saeule" ||
		len(got[0].SchluesselSHA256) != 64 || got[0].OCPP != "2.0.1" || got[0].OCMF != record {
		t.Fatalf("gueltiger Satz: %+v", got[0])
	}
	if got[1].Signaturstatus != "ungueltig" || got[1].Pruefgrund != "signatur_falsch" {
		t.Fatalf("manipulierter Satz: %+v", got[1])
	}
	// another encoding than OCMF is not read
	other := smv(record)
	other[0].SampledValue[1].SignedMeterValue.EncodingMethod = "EDL"
	s.signedSamples201("cp-1", 1, other, &tx, "MeterValues", time.Now())
	if n := len(signedEvents(t, s)); n != 0 {
		t.Fatalf("fremdes Format erzeugte %d Ereignisse", n)
	}
}
