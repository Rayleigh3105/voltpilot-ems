// portal-attrappe steht in test/box-probe.sh (Weg mit API, VP_PROBE_API=1)
// für die Portal-API: Freigabe, Einmal-Code, Einlösen (mit Prüfung der
// Signatur nach docs/contracts/werkstatt-einloesen-v1.md), Probe-Fenster und
// Abnahme. Sie schreibt den Soll-Stand, den der echte Tunnel-Dienst der Probe
// abholt: Box-Peer nach der Einlösung, den Techniker-Zugang des Dienstes und
// das Probe-Fenster, bis der Dienst es schließt. Dazu der Fernlauf
// (vp-update-vor-zuordnung S1): POST /probe/fernlauf legt einen Auftrag mit
// Fenster an (wie der Knopf in der Akte), die Antwort auf die Ansicht nennt
// ihn, bis der Dienst ihn annimmt; Schritte, Ergebnis und das, was die
// Plattform von der Box hört (Zertifikatsanfrage, Abfragen), stehen unter
// /srv. Nur für die Probe: keine Rechte, keine Mandanten, ein Lauf zur Zeit.
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

// fernlauf ist ein Auftrag „aufspielen“ der Probe.
type fernlauf struct {
	ID       string          `json:"id"`
	Auftrag  json.RawMessage `json:"-"`
	Begonnen bool            `json:"begonnen"`
	Fenster  string          `json:"fenster"`
	Offen    bool            `json:"offen"`
	Ende     time.Time       `json:"ende"`
	Ergebnis json.RawMessage `json:"ergebnis,omitempty"`
}

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
	fernlaeufe                          map[string]*fernlauf
	deviceInfo                          string
	csrAm, abgefragtAm                  time.Time
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
	for _, f := range a.fernlaeufe {
		if f.Offen && a.boxPub != "" {
			fenster = append(fenster, map[string]string{"id": f.Fenster, "boxId": boxID, "technikerId": technikerID,
				"beginn": f.Ende.Add(-31 * time.Minute).Format(time.RFC3339), "ende": f.Ende.Format(time.RFC3339)})
		}
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
	a := &attrappe{fernlaeufe: map[string]*fernlauf{}}
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
	vertrauen := flag.String("trust-set-dir", "/srv/trust-set", "trust-set.json(.sig) fuer /api/v1/edge/trust-set/")
	nurVertrauen := flag.Bool("nur-vertrauen", false, "nur das Vertrauens-Set ausliefern (Probe ohne API)")
	anlegen := flag.String("anlegen", "", "Fernlauf: Auftrag aus dieser Datei bei der laufenden Attrappe anlegen, Kennung ausgeben")
	flag.Parse()
	if *anlegen != "" {
		b, err := os.ReadFile(*anlegen)
		if err != nil {
			log.Fatal(err)
		}
		resp, err := http.Post("http://127.0.0.1"+*adresse+"/probe/fernlauf", "application/json", strings.NewReader(string(b)))
		if err != nil {
			log.Fatal(err)
		}
		defer resp.Body.Close()
		var out struct {
			ID string `json:"id"`
		}
		if resp.StatusCode != 201 || json.NewDecoder(resp.Body).Decode(&out) != nil {
			log.Fatalf("Fernlauf nicht angelegt: HTTP %d", resp.StatusCode)
		}
		fmt.Println(out.ID)
		return
	}
	// Das Vertrauens-Set offen, wie EdgeTrustSetController: die Werkstatt legt
	// es mit install.sh auf die Box (K5, Update-bereit).
	for _, name := range []string{"trust-set.json", "trust-set.json.sig"} {
		http.HandleFunc("GET /api/v1/edge/trust-set/"+name, func(w http.ResponseWriter, _ *http.Request) {
			b, err := os.ReadFile(*vertrauen + "/" + name)
			if err != nil {
				http.NotFound(w, nil)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(b)
		})
	}
	if *nurVertrauen {
		log.Fatal(http.ListenAndServe(*adresse, nil))
	}
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
	// Jeder Programmstart der Box: Zertifikatsanfrage annehmen (deviceInfo und
	// Zeit merken, wie device_enrollment), Zertifikat bleibt „pending“; jede
	// Abfrage danach ist ein Lebenszeichen (zuletzt_abgefragt_am).
	http.HandleFunc("POST /api/v1/enrollment/{ref}/csr", func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			DeviceInfo string `json:"deviceInfo"`
		}
		_ = json.NewDecoder(r.Body).Decode(&q)
		a.mu.Lock()
		a.deviceInfo, a.csrAm = q.DeviceInfo, time.Now().UTC()
		a.mu.Unlock()
		a.ereignis("zertifikatsanfrage %s %s", r.PathValue("ref"), q.DeviceInfo)
		antworte(w, 202, map[string]string{"status": "pending", "ref": r.PathValue("ref")})
	})
	http.HandleFunc("GET /api/v1/enrollment/{ref}/certificate", func(w http.ResponseWriter, _ *http.Request) {
		a.mu.Lock()
		a.abgefragtAm = time.Now().UTC()
		a.mu.Unlock()
		antworte(w, 404, map[string]string{"status": "pending"})
	})
	a.fernlaufRouten()
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

// ---- Fernlauf ------------------------------------------------------------------

func (a *attrappe) fernlaufRouten() {
	// Wie der Knopf in der Akte: Auftrag mit Fenster für den Zugang des Dienstes.
	http.HandleFunc("POST /probe/fernlauf", func(w http.ResponseWriter, r *http.Request) {
		var q map[string]any
		if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
			antworte(w, 400, map[string]string{"message": "kein JSON"})
			return
		}
		roh := make([]byte, 16)
		_, _ = rand.Read(roh)
		h := hex.EncodeToString(roh)
		id := h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-8" + h[17:20] + "-" + h[20:32]
		_, _ = rand.Read(roh)
		h = hex.EncodeToString(roh)
		fenster := h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-8" + h[17:20] + "-" + h[20:32]
		ende := time.Now().UTC().Add(30 * time.Minute)
		host, port, _ := strings.Cut(a.serverEP, ":")
		if port == "" {
			port = "51820"
		}
		q["id"], q["art"], q["tunnelAdresse"], q["fensterId"], q["fensterEnde"], q["akteurName"] =
			id, "aufspielen", a.boxAdresse, fenster, ende.Format(time.RFC3339), "Probe"
		q["server"] = map[string]string{"publicKey": a.serverPub, "endpunkt": host + ":" + port, "boxNetz": "10.10.16.0/20"}
		b, _ := json.Marshal(q)
		a.mu.Lock()
		a.fernlaeufe[id] = &fernlauf{ID: id, Auftrag: b, Fenster: fenster, Offen: true, Ende: ende}
		a.schreibeSoll()
		a.mu.Unlock()
		a.ereignis("fernlauf erteilt %s fenster %s", id, fenster)
		antworte(w, 201, map[string]string{"id": id})
	})
	http.HandleFunc("PUT /api/v1/werkstatt-dienst/ansicht", func(w http.ResponseWriter, r *http.Request) {
		var roh json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&roh)
		_ = os.WriteFile("/srv/ansicht.json", roh, 0o644)
		a.mu.Lock()
		defer a.mu.Unlock()
		liste := []map[string]string{}
		for _, f := range a.fernlaeufe {
			if !f.Begonnen && f.Ergebnis == nil {
				liste = append(liste, map[string]string{"id": f.ID, "art": "aufspielen", "lauf": a.codeRef})
			}
		}
		antworte(w, 200, map[string]any{"auftraege": liste})
	})
	mit := func(w http.ResponseWriter, r *http.Request) *fernlauf {
		f := a.fernlaeufe[r.PathValue("id")]
		if f == nil {
			antworte(w, 404, map[string]string{"message": "Diesen Auftrag gibt es nicht."})
		}
		return f
	}
	http.HandleFunc("POST /api/v1/werkstatt-dienst/fernlaeufe/{id}/beginnen", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		f := mit(w, r)
		if f == nil {
			return
		}
		if f.Begonnen {
			antworte(w, 409, map[string]string{"message": "Dieser Auftrag ist schon angenommen."})
			return
		}
		f.Begonnen = true
		a.ereignis("fernlauf angenommen %s", f.ID)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(f.Auftrag)
	})
	http.HandleFunc("POST /api/v1/werkstatt-dienst/fernlaeufe/{id}/schritt", func(w http.ResponseWriter, r *http.Request) {
		var q map[string]string
		_ = json.NewDecoder(r.Body).Decode(&q)
		a.mu.Lock()
		defer a.mu.Unlock()
		f := mit(w, r)
		if f == nil {
			return
		}
		if !f.Begonnen || f.Ergebnis != nil {
			antworte(w, 409, map[string]string{"message": "Dieser Auftrag läuft nicht."})
			return
		}
		b, _ := json.Marshal(q)
		fh, err := os.OpenFile("/srv/fernlauf-"+f.ID+".schritte", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = fh.Write(append(b, '\n'))
			_ = fh.Close()
		}
		w.WriteHeader(204)
	})
	http.HandleFunc("GET /api/v1/werkstatt-dienst/fernlaeufe/{id}/meldung", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		if mit(w, r) == nil {
			return
		}
		m := map[string]any{"deviceInfo": a.deviceInfo, "zertifikat": false}
		if !a.csrAm.IsZero() {
			m["csrUpdatedAt"] = a.csrAm.Format(time.RFC3339Nano)
		}
		if !a.abgefragtAm.IsZero() {
			m["zuletztAbgefragtAm"] = a.abgefragtAm.Format(time.RFC3339Nano)
		}
		antworte(w, 200, m)
	})
	http.HandleFunc("POST /api/v1/werkstatt-dienst/fernlaeufe/{id}/ergebnis", func(w http.ResponseWriter, r *http.Request) {
		var roh json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&roh)
		a.mu.Lock()
		defer a.mu.Unlock()
		f := mit(w, r)
		if f == nil {
			return
		}
		if f.Ergebnis != nil {
			antworte(w, 409, map[string]string{"message": "Für diesen Auftrag gibt es schon ein Ergebnis."})
			return
		}
		f.Ergebnis = roh
		_ = os.WriteFile("/srv/fernlauf-"+f.ID+".json", roh, 0o644)
		a.ereignis("fernlauf ergebnis %s %s", f.ID, string(roh))
		antworte(w, 201, map[string]string{"id": f.ID})
	})
	http.HandleFunc("POST /api/v1/werkstatt-dienst/fernlaeufe/{id}/fenster/schliessen", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		f := mit(w, r)
		if f == nil {
			return
		}
		if !f.Offen {
			antworte(w, 409, map[string]string{"message": "Das Fenster ist nicht mehr offen."})
			return
		}
		f.Offen = false
		a.schreibeSoll()
		a.ereignis("fernlauf fenster geschlossen %s", f.Fenster)
		antworte(w, 200, map[string]any{"id": f.Fenster, "geschlossenAm": time.Now().UTC().Format(time.RFC3339)})
	})
}
