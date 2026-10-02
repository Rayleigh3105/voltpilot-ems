package csms

// MiSpeL MP-38: signed charge point meter readings (OCMF).
//
// A station proves a meter reading under calibration law with an OCMF record
// signed by its meter (S.A.F.E. e. V., "Open Charge Metering Format"). It
// arrives as an OCPP 1.6 SampledValue with format SignedData (MeterValues,
// StopTransaction.transactionData) or as an OCPP 2.0.1 SampledValue with
// signedMeterValue (MeterValues, TransactionEvent). The box keeps the record
// byte for byte, checks its signature (internal/ocmf) and hands record, check
// result and meter identity to the cloud as one internal journal event
// "SignedMeterValue" - the crash-safe journal spool is the box-side store until
// the cloud acknowledges it. Nothing here changes a protocol answer, a session
// or the measurement runtime: the plain register values still come from the
// Raw samples as before. Contract: docs/contracts/v2/mispel-ladepunkt-ocmf.md.

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocmf"
	types16 "github.com/lorenzodonini/ocpp-go/ocpp1.6/types"
	types201 "github.com/lorenzodonini/ocpp-go/ocpp2.0.1/types"
)

// SignedMeterValueAction names the internal journal event.
const SignedMeterValueAction = "SignedMeterValue"

// Where the station delivered the key the signature was checked with.
const (
	schluesselQuelleSaeule = "saeule" // OCPP 2.0.1 signedMeterValue.publicKey
	schluesselQuelleKeine  = "keine"  // OCPP 1.6 carries no key; out-of-band key provisioning is open
)

type signedMeterPayload struct {
	ConnectorID       int             `json:"connector_id"`
	TransactionID     *int            `json:"transaction_id,omitempty"`
	OCPP              string          `json:"ocpp"`
	Quelle            string          `json:"quelle"`
	OCMF              string          `json:"ocmf"`
	Signaturstatus    string          `json:"signaturstatus"`
	Pruefgrund        string          `json:"pruefgrund,omitempty"`
	Signaturverfahren string          `json:"signaturverfahren"`
	Schluessel        string          `json:"schluessel,omitempty"`
	SchluesselSHA256  string          `json:"schluessel_sha256,omitempty"`
	SchluesselQuelle  string          `json:"schluessel_quelle"`
	Zaehlerkennung    string          `json:"zaehlerkennung,omitempty"`
	Zaehlerhersteller string          `json:"zaehlerhersteller,omitempty"`
	Zaehlermodell     string          `json:"zaehlermodell,omitempty"`
	Paginierung       string          `json:"paginierung,omitempty"`
	Ablesungen        []signedReading `json:"ablesungen"`
}

type signedReading struct {
	Zeit          string `json:"zeit"`
	GemessenAm    string `json:"gemessen_am,omitempty"`
	Zeitstatus    string `json:"zeitstatus,omitempty"`
	Anlass        string `json:"anlass,omitempty"`
	Wert          string `json:"wert,omitempty"`
	Obis          string `json:"obis,omitempty"`
	Einheit       string `json:"einheit,omitempty"`
	Stromart      string `json:"stromart,omitempty"`
	Fehler        string `json:"fehler,omitempty"`
	Zaehlerstatus string `json:"zaehlerstatus,omitempty"`
}

// signedSamples16 handles the SignedData values of one OCPP 1.6 MeterValue.
func (s *Server) signedSamples16(id string, connectorID int, txID *int, quelle string, in []types16.SampledValue, received time.Time) {
	for _, sv := range in {
		if sv.Format == types16.ValueFormatSignedData {
			s.onSignedMeterValue(id, connectorID, txID, "1.6", quelle, sv.Value, "", received)
		}
	}
}

// signedSamples201 handles the signedMeterValue entries of OCPP 2.0.1 meter values.
func (s *Server) signedSamples201(id string, evseID int, mvs []types201.MeterValue, txID *int, quelle string, received time.Time) {
	for _, mv := range mvs {
		for _, sv := range mv.SampledValue {
			smv := sv.SignedMeterValue
			if smv == nil || !strings.EqualFold(strings.TrimSpace(smv.EncodingMethod), "OCMF") {
				continue
			}
			s.onSignedMeterValue(id, evseID, txID, "2.0.1", quelle, smv.SignedMeterData, smv.PublicKey, received)
		}
	}
}

func (s *Server) onSignedMeterValue(id string, connectorID int, txID *int, version, quelle, transmitted, publicKey string, received time.Time) {
	text, ok := ocmf.Decode(transmitted)
	if !ok {
		// Another signed format (not OCMF) stays where it already is: the raw
		// sampled value of the protocol journal.
		s.log.Debug("Signierter Messwert einer Ladesäule ist kein OCMF", "charge_point_id", id, "connector", connectorID)
		return
	}
	rec, err := ocmf.Parse(text)
	if err != nil {
		s.log.Info("OCMF-Datensatz einer Ladesäule nicht lesbar", "charge_point_id", id, "connector", connectorID, "err", err)
		return
	}
	res := ocmf.Verify(rec, publicKey)
	p := signedMeterPayload{
		ConnectorID: connectorID, TransactionID: txID, OCPP: version, Quelle: quelle, OCMF: rec.Raw,
		Signaturstatus: res.Status, Pruefgrund: res.Grund, Signaturverfahren: res.Verfahren,
		SchluesselSHA256: res.SchluesselSHA256, SchluesselQuelle: schluesselQuelleKeine,
		Zaehlerkennung: rec.Daten.MS, Zaehlerhersteller: rec.Daten.MV, Zaehlermodell: rec.Daten.MM,
		Paginierung: rec.Daten.PG,
	}
	if strings.TrimSpace(publicKey) != "" {
		p.Schluessel, p.SchluesselQuelle = strings.TrimSpace(publicKey), schluesselQuelleSaeule
	}
	for _, r := range rec.Daten.RD {
		at, state, ok := ocmf.ReadingTime(r.TM)
		sr := signedReading{Zeit: r.TM, Zeitstatus: state, Anlass: r.TX, Wert: string(r.RV), Obis: r.RI,
			Einheit: r.RU, Stromart: r.RT, Zaehlerstatus: r.ST}
		if ok {
			sr.GemessenAm = at.UTC().Format(time.RFC3339Nano)
		}
		if r.EF != nil {
			sr.Fehler = *r.EF
		}
		p.Ablesungen = append(p.Ablesungen, sr)
	}
	if res.Status != ocmf.StatusGueltig {
		s.log.Info("OCMF-Signatur einer Ladesäule nicht gültig", "charge_point_id", id, "connector", connectorID,
			"status", res.Status, "grund", res.Grund)
	}
	s.journal.RecordSignedMeterValue(id, signedEventID(id, connectorID, rec.Raw), p, received)
}

// signedEventID is stable per station, connector and record, so a record the
// station repeats (MeterValues and again in StopTransaction) is one fact in the
// cloud. Shaped as a version 5 UUID for the envelope schema.
func signedEventID(id string, connectorID int, raw string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%s", id, connectorID, raw)))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x50
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// RecordSignedMeterValue journals one checked OCMF record for the cloud.
func (j *Journal) RecordSignedMeterValue(chargePointID, eventID string, payload signedMeterPayload, at time.Time) {
	j.append(ProtocolEvent{SchemaVersion: "1.0", EventID: eventID, OccurredAt: at.UTC().Format(time.RFC3339Nano),
		ChargePointID: chargePointID, Direction: "internal", MessageType: "Event", Action: SignedMeterValueAction,
		Payload: mustJSON(payload)})
}
