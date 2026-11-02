package werkstatt

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Die Vektoren teilt die Box mit der API (EinloesenVertragTest.java).
type vektoren struct {
	Key         string          `json:"test_privater_schluessel_pkcs8_pem"`
	Anfrage     Anfrage         `json:"anfrage"`
	Kanonisch   string          `json:"kanonisch"`
	CsrSha256   string          `json:"csr_sha256"`
	SchluesselS string          `json:"geraete_schluessel_sha256"`
	SignaturGo  string          `json:"signatur_go"`
	Ungueltig   []feldAenderung `json:"signatur_ungueltig"`
	Formfehler  []feldAenderung `json:"formfehler"`
}

type feldAenderung struct {
	Name string `json:"name"`
	Feld string `json:"feld"`
	Wert string `json:"wert"`
}

func lies(t *testing.T) vektoren {
	t.Helper()
	raw, err := os.ReadFile("../../../../docs/contracts/werkstatt-einloesen-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vektoren
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func mit(a Anfrage, feld, wert string) Anfrage {
	m := map[string]*string{"edgeRef": &a.EdgeRef, "code": &a.Code, "fassung": &a.Fassung,
		"geraeteSchluessel": &a.GeraeteSchluessel, "wireguardSchluessel": &a.WireguardSchluessel,
		"hostSchluessel": &a.HostSchluessel, "csrPem": &a.CsrPem, "signatur": &a.Signatur}
	*m[feld] = wert
	return a
}

func testschluessel(t *testing.T, v vektoren) *ecdsa.PrivateKey {
	t.Helper()
	b, _ := pem.Decode([]byte(v.Key))
	k, err := x509.ParsePKCS8PrivateKey(b.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return k.(*ecdsa.PrivateKey)
}

func TestVektorenKanonischUndSignatur(t *testing.T) {
	v := lies(t)
	if f := Formfehler(v.Anfrage); len(f) > 0 {
		t.Fatalf("Formfehler im Vektor: %v", f)
	}
	if got := Kanonisch(v.Anfrage); got != v.Kanonisch {
		t.Fatalf("kanonischer Text:\n%s\nVektor:\n%s", got, v.Kanonisch)
	}
	csr := sha256.Sum256([]byte(v.Anfrage.CsrPem))
	if hex.EncodeToString(csr[:]) != v.CsrSha256 {
		t.Fatal("csr_sha256")
	}
	der, _ := base64.StdEncoding.DecodeString(v.Anfrage.GeraeteSchluessel)
	s := sha256.Sum256(der)
	if hex.EncodeToString(s[:]) != v.SchluesselS {
		t.Fatal("geraete_schluessel_sha256")
	}
	if !SignaturGueltig(v.Anfrage) {
		t.Fatal("die Signatur des Vektors gilt nicht")
	}
	goSig := v.Anfrage
	goSig.Signatur = v.SignaturGo
	if !SignaturGueltig(goSig) {
		t.Fatal("signatur_go gilt nicht")
	}
	// Go kodiert den Schlüssel byte-gleich wie der Vektor (und die API, die über JCA neu kodiert).
	spki, err := SPKI(&testschluessel(t, v).PublicKey)
	if err != nil || spki != v.Anfrage.GeraeteSchluessel {
		t.Fatalf("SPKI %q, Vektor %q (%v)", spki, v.Anfrage.GeraeteSchluessel, err)
	}
}

func TestVektorenJedeAenderungBrichtDieSignatur(t *testing.T) {
	v := lies(t)
	for _, f := range v.Ungueltig {
		if SignaturGueltig(mit(v.Anfrage, f.Feld, f.Wert)) {
			t.Errorf("%s: Signatur gilt noch", f.Name)
		}
	}
}

func TestVektorenFormfehler(t *testing.T) {
	v := lies(t)
	for _, f := range v.Formfehler {
		got := Formfehler(mit(v.Anfrage, f.Feld, f.Wert))
		gefunden := false
		for _, g := range got {
			if strings.HasPrefix(g, f.Feld+":") {
				gefunden = true
			}
		}
		if !gefunden {
			t.Errorf("%s: kein Formfehler für %s (%v)", f.Name, f.Feld, got)
		}
	}
}

func TestSigniereMitDemTestschluessel(t *testing.T) {
	v := lies(t)
	a := v.Anfrage
	a.Fassung = "edge-light-2026.12.3"
	if err := Signiere(testschluessel(t, v), &a); err != nil {
		t.Fatal(err)
	}
	if !SignaturGueltig(a) || a.GeraeteSchluessel != v.Anfrage.GeraeteSchluessel {
		t.Fatal("eigene Signatur gilt nicht")
	}
	b := a
	b.Fassung = v.Anfrage.Fassung
	if SignaturGueltig(b) {
		t.Fatal("Signatur über die alte Fassung gilt noch")
	}
}

// ---- der Befehl gegen eine Attrappe des Portals ----------------------------------------------

const (
	testRef  = "edge-k7m2xq3"
	testCode = "wk-abcdefghijklmnopqrstuvwxyz"
	testWG   = "/iwscgv6ILyS1xKzB+lbL/O57nrWajmiSQdU6qaQU0A="
	testHost = "SHA256:2SDE0cZR4XtlVLjiHnsD7uTHNtWugyfzDJt4URFUDik"
)

func boxVerzeichnis(t *testing.T, mitSchluessel bool) (string, *ecdsa.PrivateKey) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ref"), []byte(testRef+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !mitSchluessel {
		return dir, nil
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalECPrivateKey(key)
	_ = os.MkdirAll(filepath.Join(dir, "identity"), 0o700)
	if err := os.WriteFile(filepath.Join(dir, "identity", "device.key"),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir, key
}

func lauf(t *testing.T, args []string, stdin string) (int, string, string) {
	t.Helper()
	t.Setenv("VP_CONFIG", "")
	t.Setenv("VP_REF", "")
	t.Setenv("VP_DATA_DIR", "")
	t.Setenv("VP_PORTAL_BASE_URL", "")
	var out, errb bytes.Buffer
	rc := Befehl(args, "edge-light-2026.11.0", strings.NewReader(stdin), &out, &errb)
	return rc, out.String(), errb.String()
}

func TestBefehlLoestEinWieDerVertragSagt(t *testing.T) {
	dir, key := boxVerzeichnis(t, true)
	var gesehen Anfrage
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/werkstatt/einloesen" {
			http.NotFound(w, r)
			return
		}
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&gesehen); err != nil {
			w.WriteHeader(400)
			return
		}
		_, _ = w.Write([]byte(`{"schema":"vp-werkstatt-einloesung.v1","edgeRef":"` + testRef + `","freigabe":"2026-11-mango-1",
"tunnelErgebnis":"angelegt","tunnel":{"adresse":"10.10.16.2","boxNetz":"10.10.16.0/20","technikerNetz":"10.10.32.0/24",
"serverEndpunkt":"wartung.voltpilot.de","serverPort":51820,"serverPublicKey":"LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=","serverAdresse":"10.10.16.1"},
"probe":{"fensterId":"5d1b2c3e-0000-4000-8000-000000000001","technikerId":"7e57ab1e-0000-4000-8000-00000000c0de","technikerName":"Werkstatt-Dienst",
"beginn":"2026-11-02T10:00:00Z","ende":"2026-11-02T10:30:00Z"},"geraeteSchluessel":{"sha256":"ab","festgehaltenAm":"2026-11-02T10:00:00Z"}}`))
	}))
	defer srv.Close()

	rc, out, errText := lauf(t, []string{"--daten", dir, "--portal", srv.URL, "--wireguard", testWG,
		"--host-schluessel", testHost}, testCode+"\n")
	if rc != OK {
		t.Fatalf("rc %d, stderr %s", rc, errText)
	}
	// Was ankam: Kennung aus dem Datenverzeichnis, Fassung des Programms, signiert, CSR mit dem Geräteschlüssel.
	if gesehen.EdgeRef != testRef || gesehen.Code != testCode || gesehen.Fassung != "edge-light-2026.11.0" ||
		gesehen.WireguardSchluessel != testWG || gesehen.HostSchluessel != testHost {
		t.Fatalf("Anfrage %+v", gesehen)
	}
	if !SignaturGueltig(gesehen) {
		t.Fatal("Signatur gilt nicht")
	}
	spki, _ := SPKI(&key.PublicKey)
	b, _ := pem.Decode([]byte(gesehen.CsrPem))
	csr, err := x509.ParseCertificateRequest(b.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		t.Fatalf("CSR: %v", err)
	}
	csrKey, _ := SPKI(csr.PublicKey.(*ecdsa.PublicKey))
	if gesehen.GeraeteSchluessel != spki || csrKey != spki {
		t.Fatal("Geräteschlüssel und CSR passen nicht zum Schlüssel der Box")
	}
	var a Antwort
	if err := json.Unmarshal([]byte(out), &a); err != nil || a.Tunnel.Adresse != "10.10.16.2" ||
		a.Probe.TechnikerName != "Werkstatt-Dienst" {
		t.Fatalf("stdout %q (%v)", out, err)
	}
	if strings.Contains(out, testCode) || strings.Contains(errText, testCode) {
		t.Fatal("der Code steht in der Ausgabe")
	}
}

func TestBefehlAbgelehnt(t *testing.T) {
	dir, _ := boxVerzeichnis(t, true)
	for _, fall := range []struct {
		status int
		body   string
		rc     int
		satz   string
	}{
		{403, `{"message":"Der Code gilt nicht."}`, Abgewiesen, "Der Code gilt nicht."},
		{409, `{"code":"schluessel_festgehalten","message":"Für edge-k7m2xq3 ist schon ein anderer Geräteschlüssel festgehalten."}`, Abgewiesen, "schluessel_festgehalten"},
		{503, `{"message":"kaputt"}`, Unerreichbar, "HTTP 503"},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(fall.status)
			_, _ = w.Write([]byte(fall.body))
		}))
		rc, out, errText := lauf(t, []string{"--daten", dir, "--portal", srv.URL, "--wireguard", testWG,
			"--host-schluessel", testHost}, testCode)
		srv.Close()
		if rc != fall.rc || out != "" || !strings.Contains(errText, fall.satz) {
			t.Errorf("HTTP %d: rc %d, stdout %q, stderr %q", fall.status, rc, out, errText)
		}
	}
	// Portal nicht erreichbar.
	rc, _, errText := lauf(t, []string{"--daten", dir, "--portal", "http://127.0.0.1:1", "--wireguard", testWG,
		"--host-schluessel", testHost}, testCode)
	if rc != Unerreichbar || !strings.Contains(errText, "nicht erreicht") {
		t.Errorf("unerreichbar: rc %d, %s", rc, errText)
	}
}

func TestBefehlAufrufUndBox(t *testing.T) {
	dir, _ := boxVerzeichnis(t, true)
	ohneSchluessel, _ := boxVerzeichnis(t, false)
	ok := []string{"--wireguard", testWG, "--host-schluessel", testHost, "--portal", "http://127.0.0.1:1"}
	for _, fall := range []struct {
		name  string
		args  []string
		stdin string
		satz  string
	}{
		{"Code als Argument", append([]string{"--daten", dir, testCode}, ok...), "", "Standardeingabe"},
		{"kein Code", append([]string{"--daten", dir}, ok...), "\n", "kein Code"},
		{"Code falsch", append([]string{"--daten", dir}, ok...), "wk-123\n", "kein Code"},
		{"ohne Geräteschlüssel", append([]string{"--daten", ohneSchluessel}, ok...), testCode, "kein Geräteschlüssel"},
		{"ohne Kennung", append([]string{"--daten", t.TempDir()}, ok...), testCode, "keine Kennung"},
		{"Host-Schlüssel fehlt", []string{"--daten", dir, "--wireguard", testWG, "--portal", "http://127.0.0.1:1"}, testCode, "hostSchluessel"},
		{"WireGuard kaputt", []string{"--daten", dir, "--wireguard", "abc", "--host-schluessel", testHost, "--portal", "http://127.0.0.1:1"}, testCode, "wireguardSchluessel"},
	} {
		rc, out, errText := lauf(t, fall.args, fall.stdin)
		if rc != Aufruf || out != "" || !strings.Contains(errText, fall.satz) {
			t.Errorf("%s: rc %d, stdout %q, stderr %q", fall.name, rc, out, errText)
		}
	}
	// Ohne Schlüssel entsteht auch keiner: eingelöst wird nur, was der erste Start anlegte.
	if _, err := os.Stat(filepath.Join(ohneSchluessel, "identity", "device.key")); !os.IsNotExist(err) {
		t.Fatalf("device.key angelegt: %v", err)
	}
	// Eine Sticker-Kennung bekommt keinen Werkstatt-Code.
	sticker := t.TempDir()
	_ = os.WriteFile(filepath.Join(sticker, "ref"), []byte("VP-ABC123\n"), 0o644)
	rc, _, errText := lauf(t, append([]string{"--daten", sticker}, ok...), testCode)
	if rc != Aufruf || !strings.Contains(errText, "Prüfzeichen") {
		t.Errorf("Sticker: rc %d, %s", rc, errText)
	}
}
