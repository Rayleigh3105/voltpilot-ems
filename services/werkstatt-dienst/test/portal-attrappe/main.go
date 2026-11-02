// portal-attrappe steht in test/box-probe.sh (Weg mit API, VP_PROBE_API=1)
// für die Portal-API: Freigabe, Einmal-Code, Einlösen (mit Prüfung der
// Signatur nach docs/contracts/werkstatt-einloesen-v1.md), Probe-Fenster und
// Abnahme. Sie schreibt den Soll-Stand, den der echte Tunnel-Dienst der Probe
// abholt: Box-Peer nach der Einlösung, den Techniker-Zugang des Dienstes und
// das Probe-Fenster, bis der Dienst es schließt. Nur für die Probe: keine
// Rechte, keine Mandanten, ein Lauf zur Zeit.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	boxID       = "6f1d1c52-3c1a-4b8e-9a43-0c4f8a7c2d11"
	technikerID = "7e57ab1e-0000-4000-8000-00000000c0de"
	fensterID   = "5d1b2c3e-0000-4000-8000-000000000001"
)

type anfrage struct {
	EdgeRef             string `json:"edgeRef"`
	Code                string `json:"code"`
	Fassung             string `json:"fassung"`
	GeraeteSchluessel   string `json:"geraeteSchluessel"`
	WireguardSchluessel string `json:"wireguardSchluessel"`
	HostSchluessel      string `json:"hostSchluessel"`
	CsrPem              string `json:"csrPem"`
	Signatur            string `json:"signatur"`
}

func kanonisch(a anfrage) string {
	csr := sha256.Sum256([]byte(a.CsrPem))
	return "vp-werkstatt-einloesen.v1\nedge_ref=" + a.EdgeRef + "\ncode=" + a.Code + "\nfassung=" + a.Fassung +
		"\ngeraete_schluessel=" + a.GeraeteSchluessel + "\nwireguard_schluessel=" + a.WireguardSchluessel +
		"\nhost_schluessel=" + a.HostSchluessel + "\ncsr_sha256=" + hex.EncodeToString(csr[:]) + "\n"
}

type attrappe struct {
	mu                                  sync.Mutex
	soll, freigabe, abnahme, ereignisse string
	serverPub, serverEP                 string
	techPub, techSSH, techAdresse       string
	boxAdresse                          string
	code, codeRef                       string
	boxPub                              string
	fensterOffen                        bool
	eingeloest                          bool
}

func (a *attrappe) ereignis(f string, v ...any) {
	z := time.Now().UTC().Format(time.RFC3339) + " " + fmt.Sprintf(f, v...) + "\n"
	fh, err := os.OpenFile(a.ereignisse, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		_, _ = fh.WriteString(z)
		_ = fh.Close()
	}
	log.Print(strings.TrimSpace(z))
}

// schreibeSoll: Techniker-Zugang immer, Box und Fenster nach der Einlösung.
func (a *attrappe) schreibeSoll() {
	peers := []map[string]string{{"art": "techniker", "id": technikerID, "kennung": "Werkstatt-Dienst",
		"publicKey": a.techPub, "adresse": a.techAdresse, "sshPublicKey": a.techSSH}}
	fenster := []map[string]string{}
	if a.boxPub != "" {
		peers = append(peers, map[string]string{"art": "box", "id": boxID, "kennung": a.codeRef, "publicKey": a.boxPub, "adresse": a.boxAdresse})
	}
	if a.fensterOffen {
		jetzt := time.Now().UTC()
		fenster = append(fenster, map[string]string{"id": fensterID, "boxId": boxID, "technikerId": technikerID,
			"beginn": jetzt.Add(-time.Minute).Format(time.RFC3339), "ende": jetzt.Add(30 * time.Minute).Format(time.RFC3339)})
	}
	b, _ := json.Marshal(map[string]any{"version": 1, "erzeugtAm": time.Now().UTC().Format(time.RFC3339Nano),
		"boxNetz": "10.10.16.0/20", "technikerNetz": "10.10.32.0/24", "peers": peers, "fenster": fenster})
	_ = os.WriteFile(a.soll+".neu", append(b, '\n'), 0o644)
	_ = os.Rename(a.soll+".neu", a.soll)
}

func antworte(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *attrappe) einloesen(w http.ResponseWriter, r *http.Request) {
	var q anfrage
	if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
		antworte(w, 400, map[string]string{"message": "kein JSON"})
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.code == "" || q.Code != a.code || q.EdgeRef != a.codeRef {
		a.ereignis("einloesen abgewiesen: Code gilt nicht")
		antworte(w, 403, map[string]string{"message": "Der Code gilt nicht."})
		return
	}
	if a.eingeloest {
		antworte(w, 409, map[string]string{"message": "Dieser Code ist schon eingelöst."})
		return
	}
	der, _ := base64.StdEncoding.DecodeString(q.GeraeteSchluessel)
	k, err := x509.ParsePKIXPublicKey(der)
	ec, ok := k.(*ecdsa.PublicKey)
	sig, _ := base64.StdEncoding.DecodeString(q.Signatur)
	h := sha256.Sum256([]byte(kanonisch(q)))
	if err != nil || !ok || ec.Curve != elliptic.P256() || !ecdsa.VerifyASN1(ec, h[:], sig) {
		a.ereignis("einloesen abgewiesen: Signatur")
		antworte(w, 403, map[string]string{"message": "Der Code gilt nicht."})
		return
	}
	blk, _ := pem.Decode([]byte(q.CsrPem))
	csr, err := x509.ParseCertificateRequest(blk.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		antworte(w, 400, map[string]string{"message": "CSR ungültig"})
		return
	}
	csrDer, _ := x509.MarshalPKIXPublicKey(csr.PublicKey)
	if base64.StdEncoding.EncodeToString(csrDer) != q.GeraeteSchluessel {
		antworte(w, 422, map[string]string{"message": "CSR mit anderem Schlüssel"})
		return
	}
	a.eingeloest, a.boxPub, a.fensterOffen = true, q.WireguardSchluessel, true
	a.schreibeSoll()
	fp := sha256.Sum256(der)
	a.ereignis("eingeloest %s fassung=%s host=%s wg=%s geraeteschluessel=%s", q.EdgeRef, q.Fassung, q.HostSchluessel, q.WireguardSchluessel, hex.EncodeToString(fp[:]))
	jetzt := time.Now().UTC()
	host, port, _ := strings.Cut(a.serverEP, ":")
	n := 51820
	_, _ = fmt.Sscanf(port, "%d", &n)
	antworte(w, 200, map[string]any{"schema": "vp-werkstatt-einloesung.v1", "edgeRef": q.EdgeRef, "freigabe": "2026-11-mango-1",
		"tunnelErgebnis": "angelegt",
		"tunnel": map[string]any{"adresse": a.boxAdresse, "boxNetz": "10.10.16.0/20", "technikerNetz": "10.10.32.0/24",
			"serverEndpunkt": host, "serverPort": n, "serverPublicKey": a.serverPub, "serverAdresse": "10.10.16.1"},
		"probe": map[string]any{"fensterId": fensterID, "technikerId": technikerID, "technikerName": "Werkstatt-Dienst",
			"beginn": jetzt.Format(time.RFC3339), "ende": jetzt.Add(30 * time.Minute).Format(time.RFC3339)},
		"geraeteSchluessel": map[string]any{"sha256": hex.EncodeToString(fp[:]), "festgehaltenAm": jetzt.Format(time.RFC3339)}})
}

func main() {
	a := &attrappe{}
	adresse := flag.String("adresse", ":8090", "")
	flag.StringVar(&a.soll, "soll", "/srv/soll.json", "")
	flag.StringVar(&a.freigabe, "freigabe", "/srv/freigabe.json", "")
	flag.StringVar(&a.abnahme, "abnahme", "/srv/abnahme.json", "")
	flag.StringVar(&a.ereignisse, "ereignisse", "/srv/portal.log", "")
	flag.StringVar(&a.serverPub, "server-pub", "", "")
	flag.StringVar(&a.serverEP, "server-endpunkt", "198.51.100.10:51820", "")
	flag.StringVar(&a.techPub, "techniker-pub", "", "")
	flag.StringVar(&a.techSSH, "techniker-ssh", "", "")
	flag.StringVar(&a.techAdresse, "techniker-adresse", "10.10.32.50", "")
	flag.StringVar(&a.boxAdresse, "box-adresse", "10.10.16.5", "")
	flag.Parse()
	// Wie die API (SshSchluessel): nur die Normalform „ssh-rsa <base64>“.
	if f := strings.Fields(a.techSSH); len(f) >= 2 {
		a.techSSH = f[0] + " " + f[1]
	}
	a.schreibeSoll()

	http.HandleFunc("POST /token", func(w http.ResponseWriter, _ *http.Request) {
		antworte(w, 200, map[string]any{"access_token": "attrappe", "expires_in": 300})
	})
	http.HandleFunc("GET /api/v1/werkstatt-dienst/freigabe", func(w http.ResponseWriter, _ *http.Request) {
		b, err := os.ReadFile(a.freigabe)
		if err != nil {
			antworte(w, 404, map[string]string{"message": "Die Werkstatt ist nicht freigegeben."})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
	})
	http.HandleFunc("POST /api/v1/werkstatt-dienst/codes", func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			EdgeRef string `json:"edgeRef"`
		}
		_ = json.NewDecoder(r.Body).Decode(&q)
		roh := make([]byte, 16)
		_, _ = rand.Read(roh)
		code := "wk-" + strings.ToLower(strings.TrimRight(base32(roh), "="))
		a.mu.Lock()
		a.code, a.codeRef, a.eingeloest = code, q.EdgeRef, false
		a.mu.Unlock()
		a.ereignis("code ausgegeben fuer %s", q.EdgeRef)
		antworte(w, 201, map[string]any{"code": code, "edgeRef": q.EdgeRef, "freigabe": "2026-11-mango-1",
			"gueltigBis": time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339), "tausch": false})
	})
	http.HandleFunc("POST /api/v1/werkstatt/einloesen", a.einloesen)
	http.HandleFunc("POST /api/v1/werkstatt-dienst/fenster/{id}/schliessen", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		if r.PathValue("id") != fensterID {
			antworte(w, 404, map[string]string{"message": "Kein Probe-Fenster einer Einlösung."})
			return
		}
		if !a.fensterOffen {
			antworte(w, 409, map[string]string{"message": "Das Fenster ist nicht mehr offen."})
			return
		}
		a.fensterOffen = false
		a.schreibeSoll()
		a.ereignis("fenster geschlossen %s", fensterID)
		antworte(w, 200, map[string]any{"id": fensterID, "geschlossenAm": time.Now().UTC().Format(time.RFC3339)})
	})
	http.HandleFunc("POST /api/v1/werkstatt-dienst/abnahmen/{ref}", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			antworte(w, 400, map[string]string{"message": "kein JSON"})
			return
		}
		b, _ := json.MarshalIndent(body, "", "  ")
		_ = os.WriteFile(a.abnahme, b, 0o644)
		a.ereignis("abnahme %s", r.PathValue("ref"))
		antworte(w, 201, map[string]any{"id": "abnahme-1", "edgeRef": r.PathValue("ref"), "freigabeId": "freigabe-1",
			"einloesungId": "einloesung-1", "lanNetz": body["lanNetz"], "tunnelAdresse": a.boxAdresse, "erfasstAm": time.Now().UTC().Format(time.RFC3339)})
	})
	// Der erste Start der Box: Zertifikatsanfrage annehmen, Zertifikat bleibt „pending“.
	http.HandleFunc("POST /api/v1/enrollment/{ref}/csr", func(w http.ResponseWriter, r *http.Request) {
		antworte(w, 202, map[string]string{"status": "pending", "ref": r.PathValue("ref")})
	})
	http.HandleFunc("GET /api/v1/enrollment/{ref}/certificate", func(w http.ResponseWriter, _ *http.Request) {
		antworte(w, 404, map[string]string{"status": "pending"})
	})
	log.Fatal(http.ListenAndServe(*adresse, nil))
}

func base32(b []byte) string {
	const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
	var s strings.Builder
	puffer, bits := 0, 0
	for _, c := range b {
		puffer = puffer<<8 | int(c)
		bits += 8
		for bits >= 5 {
			s.WriteByte(abc[(puffer>>(bits-5))&31])
			bits -= 5
		}
	}
	if bits > 0 {
		s.WriteByte(abc[(puffer<<(5-bits))&31])
	}
	return s.String()
}
