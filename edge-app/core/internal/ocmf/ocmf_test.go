package ocmf

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"
	"strings"
	"testing"
	"time"
)

type beispiel struct {
	Datei        string `json:"datei"`
	Nr           int    `json:"nr"`
	Beschreibung string `json:"beschreibung"`
	Erwartet     string `json:"erwartet"`
	OCMF         string `json:"ocmf"`
	Schluessel   string `json:"schluessel"`
}

// Public OCMF records with their meter keys from the test data of the S.A.F.E.
// Transparenzsoftware (Apache-2.0, source and commit in the file).
func beispiele(t *testing.T) []beispiel {
	t.Helper()
	raw, err := os.ReadFile("testdata/safe-transparenzsoftware.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Quelle      string     `json:"quelle"`
		Datensaetze []beispiel `json:"datensaetze"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.Quelle, "SAFE-eV/transparenzsoftware") || len(f.Datensaetze) != 7 {
		t.Fatalf("Beispieldatei unvollstaendig: %q, %d Saetze", f.Quelle, len(f.Datensaetze))
	}
	return f.Datensaetze
}

func TestPublicExamplesVerifyAsDocumented(t *testing.T) {
	for _, b := range beispiele(t) {
		rec, err := Parse(b.OCMF)
		if err != nil {
			t.Fatalf("%s/%d: %v", b.Datei, b.Nr, err)
		}
		res := Verify(rec, b.Schluessel)
		if res.Status != b.Erwartet {
			t.Errorf("%s/%d (%s): Status %q (%s), erwartet %q", b.Datei, b.Nr, b.Beschreibung, res.Status, res.Grund, b.Erwartet)
		}
		if b.Erwartet == StatusUngueltig && res.Grund != GrundSignaturFalsch {
			t.Errorf("%s/%d: Grund %q, erwartet %q", b.Datei, b.Nr, res.Grund, GrundSignaturFalsch)
		}
		if len(res.SchluesselSHA256) != 64 {
			t.Errorf("%s/%d: kein Schluessel-Fingerabdruck", b.Datei, b.Nr)
		}
	}
}

func byFile(t *testing.T, datei string) beispiel {
	t.Helper()
	for _, b := range beispiele(t) {
		if b.Datei == datei && b.Nr == 0 {
			return b
		}
	}
	t.Fatalf("%s fehlt", datei)
	return beispiel{}
}

func TestManipulatedValueIsInvalid(t *testing.T) {
	b := byFile(t, "test_ocmf_keba_kcp30.xml")
	changed := strings.Replace(b.OCMF, `"RV":0.2597`, `"RV":0.2598`, 1)
	if changed == b.OCMF {
		t.Fatal("Messwert nicht gefunden")
	}
	rec, err := Parse(changed)
	if err != nil {
		t.Fatal(err)
	}
	if res := Verify(rec, b.Schluessel); res.Status != StatusUngueltig || res.Grund != GrundSignaturFalsch {
		t.Fatalf("manipulierter Messwert: %+v", res)
	}
	// Even white space is a change: the payload is checked on the bytes received.
	spaced := strings.Replace(b.OCMF, `{"FV":"1.0"`, `{ "FV":"1.0"`, 1)
	rec, _ = Parse(spaced)
	if res := Verify(rec, b.Schluessel); res.Status != StatusUngueltig {
		t.Fatalf("Leerzeichen eingefuegt: %+v", res)
	}
}

func TestWrongKeyIsInvalid(t *testing.T) {
	keba := byFile(t, "test_ocmf_keba_kcp30.xml")
	twin := byFile(t, "chargepoint_3.xml")
	nzr := byFile(t, "brainpoolP256r1.xml")
	rec, _ := Parse(keba.OCMF)
	// another meter's secp256r1 key
	if res := Verify(rec, twin.Schluessel); res.Status != StatusUngueltig || res.Grund != GrundSignaturFalsch {
		t.Fatalf("fremder secp256r1-Schluessel: %+v", res)
	}
	// a key of another curve than the method
	if res := Verify(rec, nzr.Schluessel); res.Status != StatusUngueltig || res.Grund != GrundSchluesselFremd {
		t.Fatalf("Schluessel einer anderen Kurve: %+v", res)
	}
	if res := Verify(rec, ""); res.Status != StatusNichtPruefbar || res.Grund != GrundSchluesselFehlt {
		t.Fatalf("ohne Schluessel: %+v", res)
	}
	if res := Verify(rec, "3059"); res.Status != StatusNichtPruefbar || res.Grund != GrundSchluesselDefekt {
		t.Fatalf("kaputter Schluessel: %+v", res)
	}
}

func TestKeyAndRecordEncodingsOfOCPP(t *testing.T) {
	b := byFile(t, "test_ocmf_keba_kcp30.xml")
	der, _ := hex.DecodeString(b.Schluessel)
	// OCPP 2.0.1 sends signedMeterData and publicKey base64 encoded.
	text, ok := Decode(base64.StdEncoding.EncodeToString([]byte(b.OCMF)))
	if !ok || text != b.OCMF {
		t.Fatal("base64-Datensatz nicht gelesen")
	}
	rec, _ := Parse(text)
	for _, key := range []string{base64.StdEncoding.EncodeToString(der), base64.StdEncoding.EncodeToString([]byte(b.Schluessel)), strings.ToLower(b.Schluessel)} {
		if res := Verify(rec, key); res.Status != StatusGueltig {
			t.Fatalf("Schluessel %q: %+v", key[:12], res)
		}
	}
	// OCPP 1.6 SignedData: "encoded as hex data".
	if text, ok := Decode(hex.EncodeToString([]byte(b.OCMF))); !ok || text != b.OCMF {
		t.Fatal("hex-Datensatz nicht gelesen")
	}
	if _, ok := Decode("1234.5"); ok {
		t.Fatal("Rohwert als OCMF gelesen")
	}
}

func TestParseReadsFieldsAndCarriesOver(t *testing.T) {
	b := byFile(t, "test_ocmf_keba_kcp30.xml")
	rec, err := Parse(b.OCMF)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Daten.GI != "KEBA_KCP30" || rec.Daten.GS != "17619300" || rec.Daten.PG != "T32" || len(rec.Daten.RD) != 2 {
		t.Fatalf("Kopf: %+v", rec.Daten)
	}
	if rec.Daten.RD[0].RV != "0.2596" || rec.Daten.RD[1].TX != "E" || rec.Daten.RD[1].RU != "kWh" {
		t.Fatalf("Ablesungen: %+v", rec.Daten.RD)
	}
	at, state, ok := ReadingTime(rec.Daten.RD[0].TM)
	if !ok || state != "I" || !at.Equal(time.Date(2019, 8, 13, 10, 3, 15, 0, time.UTC)) {
		t.Fatalf("Zeit: %v %q %v", at, state, ok)
	}
	twin, _ := Parse(byFile(t, "chargepoint_3.xml").OCMF)
	if twin.Daten.FV != "1.0" || twin.Daten.RD[1].RV != "1.304" || twin.Daten.MS != "33019230" {
		t.Fatalf("Zahl/Text-Felder: %+v", twin.Daten)
	}
	carried := carryOver([]Reading{{TM: "a", TX: "B", RI: "1-0:1.8.0", RU: "kWh", ST: "G"}, {TM: "b", RV: "2"}, {TM: "c", TX: "E", RV: "3"}})
	if carried[1].TX != "B" || carried[1].RI != "1-0:1.8.0" || carried[1].ST != "G" || carried[2].TX != "E" {
		t.Fatalf("Uebernahme: %+v", carried)
	}
	for _, bad := range []string{"", "OCMF|{}", "XYZ|{}|{}", "OCMF|{\"RD\":|{}", "OCMF|{}|{}|{}"} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("%q gelesen", bad)
		}
	}
}

func TestUnknownMethodIsNotCheckable(t *testing.T) {
	b := byFile(t, "test_ocmf_keba_kcp30.xml")
	rec, _ := Parse(b.OCMF)
	rec.Signatur.SA = "RSA-SHA1"
	if res := Verify(rec, b.Schluessel); res.Status != StatusNichtPruefbar || res.Grund != GrundVerfahrenUnbekannt {
		t.Fatalf("%+v", res)
	}
	rec.Signatur.SA, rec.Signatur.SD = "", "zz"
	if res := Verify(rec, b.Schluessel); res.Status != StatusNichtPruefbar || res.Grund != GrundSignaturDefekt {
		t.Fatalf("%+v", res)
	}
}

// Every generator lies on its curve and has the stated order - a wrong digit
// in a constant breaks one of both.
func TestCurveParameters(t *testing.T) {
	for _, c := range curves {
		if !c.onCurve(c.gx, c.gy) {
			t.Errorf("%s: Erzeuger nicht auf der Kurve", c.name)
		}
		if r := c.mul(c.gx, c.gy, c.n); r.x != nil {
			t.Errorf("%s: n*G ist nicht der Fernpunkt", c.name)
		}
		if !c.n.ProbablyPrime(20) || !c.p.ProbablyPrime(20) {
			t.Errorf("%s: p oder n nicht prim", c.name)
		}
	}
}

// The affine arithmetic used for brainpool and the 192-bit curves agrees with
// crypto/ecdsa on P-256, signature by signature.
func TestGenericArithmeticMatchesStandardLibrary(t *testing.T) {
	plain := *secp256r1
	plain.std = nil
	for i := 0; i < 20; i++ {
		k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256([]byte{byte(i), 'O', 'C', 'M', 'F'})
		r, s, err := ecdsa.Sign(rand.Reader, k, digest[:])
		if err != nil {
			t.Fatal(err)
		}
		if !plain.verify(k.X, k.Y, digest[:], r, s) {
			t.Fatalf("Satz %d: gueltige Signatur abgelehnt", i)
		}
		if plain.verify(k.X, k.Y, digest[:], r, new(big.Int).Add(s, big.NewInt(1))) {
			t.Fatalf("Satz %d: falsche Signatur angenommen", i)
		}
	}
}

// A record signed here on P-256 goes through the whole path: SPKI from
// crypto/x509, SA spelled out, signature base64.
func TestRoundTripOwnRecord(t *testing.T) {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
	payload := `{"FV":"1.0","PG":"F7","MS":"Z2-1","RD":[{"TM":"2026-10-01T00:15:00,000+0200 S","RV":12.5,"RI":"1-0:1.8.0","RU":"kWh","ST":"G"}]}`
	digest := sha256.Sum256([]byte(payload))
	sig, _ := ecdsa.SignASN1(rand.Reader, k, digest[:])
	raw := "OCMF|" + payload + `|{"SA":"ECDSA-secp256r1-SHA256","SE":"base64","SD":"` + base64.StdEncoding.EncodeToString(sig) + `"}`
	rec, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	res := Verify(rec, hex.EncodeToString(der))
	if res.Status != StatusGueltig || res.Verfahren != "ECDSA-secp256r1-SHA256" {
		t.Fatalf("%+v", res)
	}
}
