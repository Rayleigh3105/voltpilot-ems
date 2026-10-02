// Package ocmf reads and checks signed charge point meter readings in the Open
// Charge Metering Format (OCMF, S.A.F.E. e. V., Revision 1.4.1,
// github.com/SAFE-eV/OCMF-Open-Charge-Metering-Format, OCMF-en.md).
//
// MiSpeL (BNetzA, Beschluss 01.10.2026) requires mess- und eichrechtskonforme
// Viertelstundenwerte for every quantity relevant to subsidy and levies (Anlage 1
// S. 23, Abschn. 3.2.1; Tenor S. 28, Abschn. 3.2.3.2.1: no exception for charge
// point values). A charge point proves its Z2 value with an OCMF record signed
// by its meter. This package only reads and checks; it never changes a record:
// the payload is verified on the exact bytes the station sent ("must not be
// manipulated (removing and adding white spaces)", OCMF "JSON based OCMF Format").
//
// A valid signature proves that the record was signed with the key the station
// names. Whether that key is the one of the calibrated meter is decided "out of
// band", e.g. against the meter label or a central register (OCMF "Relation of
// Serial Numbers, Charge Point and Public Key") - that check is not here.
package ocmf

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Signature check results (box -> cloud contract, docs/contracts/v2/mispel-ladepunkt-ocmf.md).
const (
	StatusGueltig       = "gueltig"        // signature matches payload and key
	StatusUngueltig     = "ungueltig"      // signature does not match (manipulated or wrong key)
	StatusNichtPruefbar = "nicht_pruefbar" // no key, unknown method or unreadable record
)

// Reasons beside a status other than gueltig.
const (
	GrundSignaturFalsch     = "signatur_falsch"     // payload or signature changed, or another key of the same curve
	GrundSchluesselFremd    = "schluessel_fremd"    // key is of another curve than the method named in SA
	GrundSchluesselFehlt    = "schluessel_fehlt"    // the station delivered no public key
	GrundSchluesselDefekt   = "schluessel_defekt"   // key is not an EC SubjectPublicKeyInfo of a known curve
	GrundVerfahrenUnbekannt = "verfahren_unbekannt" // SA, SE or SM outside OCMF Table 22 / Table 8
	GrundSignaturDefekt     = "signatur_defekt"     // SD is not a DER ECDSA signature
)

// DefaultSignatureMethod applies when SA is missing ("default since OCMF Version 0.4", Table 22).
const DefaultSignatureMethod = "ECDSA-secp256r1-SHA256"

// Record is one OCMF record: the text as received, the payload bytes that were
// signed, and both sections read.
type Record struct {
	Raw      string
	Payload  []byte
	Daten    Payload
	Signatur Signature
}

// Payload holds the payload fields the box and cloud use (OCMF Tables 1-7).
// Unknown fields stay in Raw; nothing is dropped from the record itself.
type Payload struct {
	FV textValue `json:"FV"`
	GI string    `json:"GI"`
	GS string    `json:"GS"`
	GV string    `json:"GV"`
	PG string    `json:"PG"`
	MV string    `json:"MV"`
	MM string    `json:"MM"`
	MS string    `json:"MS"`
	MF string    `json:"MF"`
	CI string    `json:"CI"`
	RD []Reading `json:"RD"`
}

// Reading is one meter reading (OCMF Table 7). RV keeps the number exactly as
// written ("the representation must not be transformed").
type Reading struct {
	TM string    `json:"TM"`
	TX string    `json:"TX"`
	RV textValue `json:"RV"`
	RI string    `json:"RI"`
	RU string    `json:"RU"`
	RT string    `json:"RT"`
	EF *string   `json:"EF"`
	ST string    `json:"ST"`
}

// Signature is the signature section (OCMF Table 8).
type Signature struct {
	SA string `json:"SA"`
	SE string `json:"SE"`
	SM string `json:"SM"`
	SD string `json:"SD"`
}

// textValue accepts a JSON string or number and keeps its text unchanged
// (stations write "FV": 1.0 as well as "FV": "1.0", "RV": 0.2596 and "RV": "1.304").
type textValue string

func (t *textValue) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*t = textValue(s)
		return nil
	}
	if bytes.Equal(b, []byte("null")) {
		*t = ""
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	*t = textValue(n)
	return nil
}

// ErrNotOCMF marks a text that is not an OCMF record at all.
var ErrNotOCMF = errors.New("kein OCMF-Datensatz")

// Parse splits "OCMF|<payload>|<signature>" and reads both sections. The pipe
// is not allowed inside a section, so the record has exactly three parts.
func Parse(raw string) (Record, error) {
	parts := strings.Split(raw, "|")
	if len(parts) != 3 || parts[0] != "OCMF" {
		return Record{}, ErrNotOCMF
	}
	rec := Record{Raw: raw, Payload: []byte(parts[1])}
	if err := json.Unmarshal(rec.Payload, &rec.Daten); err != nil {
		return Record{}, errors.Join(ErrNotOCMF, err)
	}
	if err := json.Unmarshal([]byte(parts[2]), &rec.Signatur); err != nil {
		return Record{}, errors.Join(ErrNotOCMF, err)
	}
	rec.Daten.RD = carryOver(rec.Daten.RD)
	return rec, nil
}

// carryOver fills fields a reading omits from the reading before it: "fields
// that have an identical value to the previous reading are omitted ... only
// within a signed record" (OCMF "Readings"). TM and RV are never carried.
func carryOver(rd []Reading) []Reading {
	out := make([]Reading, len(rd))
	for i, r := range rd {
		if i > 0 {
			p := out[i-1]
			if r.TX == "" {
				r.TX = p.TX
			}
			if r.RI == "" && r.RU == "" {
				r.RI, r.RU = p.RI, p.RU
			}
			if r.RT == "" {
				r.RT = p.RT
			}
			if r.EF == nil {
				r.EF = p.EF
			}
			if r.ST == "" {
				r.ST = p.ST
			}
		}
		out[i] = r
	}
	return out
}

// Decode turns what a station transmits into the OCMF text: plain "OCMF|…",
// hex (OCPP 1.6 ValueFormat SignedData: "a signed binary data block, encoded
// as hex data") or base64 (OCPP 2.0.1 signedMeterData).
func Decode(transmitted string) (string, bool) {
	s := strings.TrimSpace(transmitted)
	if strings.HasPrefix(s, "OCMF|") {
		return s, true
	}
	if b, err := hex.DecodeString(s); err == nil && bytes.HasPrefix(b, []byte("OCMF|")) {
		return string(b), true
	}
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding} {
		if b, err := enc.DecodeString(s); err == nil && bytes.HasPrefix(b, []byte("OCMF|")) {
			return string(b), true
		}
	}
	return "", false
}

// ReadingTime reads TM ("2018-07-24T13:22:04,000+0200 S") into an instant and
// the synchronisation state letter (OCMF Table 19). ok is false when the time
// part does not follow the scheme; the state may be empty.
func ReadingTime(tm string) (at time.Time, state string, ok bool) {
	stamp, state, _ := strings.Cut(strings.TrimSpace(tm), " ")
	for _, layout := range []string{"2006-01-02T15:04:05,000-0700", "2006-01-02T15:04:05.000-0700", "2006-01-02T15:04:05,000Z07:00"} {
		if t, err := time.Parse(layout, stamp); err == nil {
			return t, strings.TrimSpace(state), true
		}
	}
	return time.Time{}, strings.TrimSpace(state), false
}
