package direktvermarkter

import (
	"encoding/binary"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ereignisliste"
)

func testAnschluss(t *testing.T) (*Anschluss, string, *[]Event, *sync.Mutex) {
	t.Helper()
	dir := t.TempDir()
	var mu sync.Mutex
	events := &[]Event{}
	a := NewAnschluss(Ablage{Dir: dir}, func(ev Event) {
		mu.Lock()
		*events = append(*events, ev)
		mu.Unlock()
	})
	t.Cleanup(a.Close)
	return a, dir, events, &mu
}

func testZugang(fingerabdruck string) *ZugangAntwort {
	return &ZugangAntwort{SchemaVersion: SchemaVersion, Partner: "luox",
		ZugangFingerabdruck: fingerabdruck,
		GueltigBis:          "2027-11-25T00:00:00Z",
		Gegenstelle:         Gegenstelle{Host: "vpn.luox.example", Port: 1194, Protokoll: "udp"},
		Dateien: Dateien{ZertifikatPEM: "-----BEGIN CERTIFICATE-----\nZ\n-----END CERTIFICATE-----\n",
			SchluesselPEM: "-----BEGIN PRIVATE KEY-----\nS\n-----END PRIVATE KEY-----\n",
			CAPEM:         "-----BEGIN CERTIFICATE-----\nC\n-----END CERTIFICATE-----\n"}}
}

func warteAufEvent(t *testing.T, events *[]Event, mu *sync.Mutex, kind string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		for _, ev := range *events {
			if ev.Kind == kind {
				mu.Unlock()
				return
			}
		}
		mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("Ereignis %q kam nicht", kind)
}

// The core delivery cycle: profile in, access asked for, access stored,
// redelivery idempotent, withdrawal deletes everything.
func TestAnschlussZustellungsZyklus(t *testing.T) {
	a, dir, events, mu := testAnschluss(t)
	raw, doc := gueltigesDokument(t)

	noetig, geloescht, err := a.UebernimmProfil(doc, raw)
	if err != nil || !noetig || geloescht != "" {
		t.Fatalf("Uebernahme: noetig=%v geloescht=%q err=%v", noetig, geloescht, err)
	}
	if st := a.Stand(); st == nil || st.Lage != LageOhneZugang {
		t.Fatalf("Lage nach Profil ohne Zugang: %+v", st)
	}
	if fa, vorhanden := a.ErwarteterZugang(); fa != "SHA256:abc" || vorhanden {
		t.Fatalf("ErwarteterZugang: %q %v", fa, vorhanden)
	}

	if err := a.UebernimmZugang(testZugang("SHA256:abc")); err != nil {
		t.Fatalf("Zugang: %v", err)
	}
	if _, vorhanden := a.ErwarteterZugang(); !vorhanden {
		t.Fatal("Zugang nicht als vorhanden erkannt")
	}
	if st := a.Stand(); st.Lage != LageBautAuf || st.ZugangFingerabdruck != "SHA256:abc" {
		t.Fatalf("Lage mit Zugang, ohne Tunnel: %+v", st)
	}
	// Key material landed 0600, and nothing else.
	for _, name := range []string{"zertifikat.pem", "schluessel.pem", "ca.pem"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s: Rechte %v", name, info.Mode().Perm())
		}
	}

	// Redelivery of the SAME document (every reconnect): no new request, the
	// Server keeps running (watchdog state preserved is covered below).
	srvVorher := a.Server()
	noetig, geloescht, err = a.UebernimmProfil(doc, raw)
	if err != nil || noetig || geloescht != "" {
		t.Fatalf("Redelivery: noetig=%v geloescht=%q err=%v", noetig, geloescht, err)
	}
	if a.Server() != srvVorher {
		t.Fatal("Redelivery hat den Server neu gebaut")
	}

	// Withdrawal (retained clear): everything gone, fingerprint returned for
	// the geloescht acknowledgement.
	fa, err := a.Zuruecknehmen()
	if err != nil || fa != "SHA256:abc" {
		t.Fatalf("Zuruecknehmen: %q %v", fa, err)
	}
	if st := a.Stand(); st != nil {
		t.Fatalf("Stand nach Ruecknahme: %+v", st)
	}
	for _, name := range []string{"zertifikat.pem", "schluessel.pem", "ca.pem", "zugang-meta.json", "profil.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s existiert nach der Ruecknahme noch", name)
		}
	}
	warteAufEvent(t, events, mu, EventProfilZurueck)
	warteAufEvent(t, events, mu, EventZugangGeloescht)
}

// A profile naming a DIFFERENT access deletes the stored one first (one
// certificate, one plant - §8) and reports it for the acknowledgement.
func TestAnschlussFingerabdruckWechsel(t *testing.T) {
	a, _, _, _ := testAnschluss(t)
	raw, doc := gueltigesDokument(t)
	if _, _, err := a.UebernimmProfil(doc, raw); err != nil {
		t.Fatal(err)
	}
	if err := a.UebernimmZugang(testZugang("SHA256:abc")); err != nil {
		t.Fatal(err)
	}
	neu := *doc
	neu.Revision = 2
	neu.ZugangFingerabdruck = "SHA256:neu"
	noetig, geloescht, err := a.UebernimmProfil(&neu, raw)
	if err != nil || !noetig || geloescht != "SHA256:abc" {
		t.Fatalf("Wechsel: noetig=%v geloescht=%q err=%v", noetig, geloescht, err)
	}
	// The obsolete access is really gone; a late answer for it is refused.
	if err := a.UebernimmZugang(testZugang("SHA256:abc")); err == nil {
		t.Fatal("alter Zugang angenommen")
	}
	if err := a.UebernimmZugang(testZugang("SHA256:neu")); err != nil {
		t.Fatalf("neuer Zugang: %v", err)
	}
}

func TestAnschlussZugangGuards(t *testing.T) {
	a, _, _, _ := testAnschluss(t)
	if err := a.UebernimmZugang(testZugang("SHA256:abc")); err == nil {
		t.Fatal("Zugang ohne Profil angenommen")
	}
	raw, doc := gueltigesDokument(t)
	if _, _, err := a.UebernimmProfil(doc, raw); err != nil {
		t.Fatal(err)
	}
	if err := a.UebernimmZugang(testZugang("SHA256:fremd")); err == nil {
		t.Fatal("Zugang mit fremdem Fingerabdruck angenommen")
	}
}

// Boot restores the persisted profile, so the box serves its state offline.
func TestAnschlussBootRestauriert(t *testing.T) {
	dir := t.TempDir()
	raw, doc := gueltigesDokument(t)
	a1 := NewAnschluss(Ablage{Dir: dir}, nil)
	if _, _, err := a1.UebernimmProfil(doc, raw); err != nil {
		t.Fatal(err)
	}
	if err := a1.UebernimmZugang(testZugang("SHA256:abc")); err != nil {
		t.Fatal(err)
	}
	a1.Close()

	a2 := NewAnschluss(Ablage{Dir: dir}, nil)
	defer a2.Close()
	a2.Boot()
	st := a2.Stand()
	if st == nil || st.Partner != "luox" || st.Lage != LageBautAuf {
		t.Fatalf("Stand nach Boot: %+v", st)
	}
}

// The Lagen of §5.4, driven through tunnel facts and a served partner.
func TestAnschlussLagen(t *testing.T) {
	a, _, _, _ := testAnschluss(t)
	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return now }
	raw, doc := gueltigesDokument(t)
	if _, _, err := a.UebernimmProfil(doc, raw); err != nil {
		t.Fatal(err)
	}
	if err := a.UebernimmZugang(testZugang("SHA256:abc")); err != nil {
		t.Fatal(err)
	}
	srv := a.Server()
	srv.now = a.now

	lage := func() string { return a.Stand().Lage }

	if lage() != LageBautAuf {
		t.Fatalf("ohne Tunnel: %s", lage())
	}
	// Tunnel up, handshake fresh, partner has not asked yet.
	a.SetzeTunnel(&TunnelStand{ObenSeit: now.Add(-time.Minute), HandshakeAm: now.Add(-30 * time.Second),
		Gegenstelle: "vpn.luox.example:1194"})
	if lage() != LageTunnelOben {
		t.Fatalf("Handshake jung, keine Abfrage: %s", lage())
	}
	// The partner reads: verbunden.
	a.SetValues(now, map[string]float64{"nvp_einspeisung_w": 1200, "erzeugung_w": 3000,
		"netzbetreiber_vorgabe_pct": 100, "referenz_w": 10000})
	if _, exc := srv.read("input", 0, 2); exc != 0 {
		t.Fatalf("read exc=0x%02x", exc)
	}
	if lage() != LageVerbunden {
		t.Fatalf("nach Abfrage: %s", lage())
	}
	// Set-point 30 with a fresh watchdog: vorgabe_aktiv, and the kW limit
	// follows percent times reference.
	if exc := srv.write(2, []uint16{30}); exc != 0 {
		t.Fatalf("write exc=0x%02x", exc)
	}
	if exc := srv.write(3, []uint16{0, 1}); exc != 0 {
		t.Fatalf("watchdog exc=0x%02x", exc)
	}
	if lage() != LageVorgabeAktiv {
		t.Fatalf("mit Vorgabe: %s", lage())
	}
	st := a.Stand()
	if kw, ok := st.GrenzeKw(now); !ok || kw != 3.0 {
		t.Fatalf("GrenzeKw: %v %v", kw, ok)
	}
	// Watchdog expires while the tunnel stays up (luox goes silent):
	// abgelaufen, and the limit is gone (never zero).
	now = now.Add(16 * time.Minute)
	a.SetzeTunnel(&TunnelStand{ObenSeit: now.Add(-17 * time.Minute), HandshakeAm: now.Add(-30 * time.Second),
		Gegenstelle: "vpn.luox.example:1194"})
	if lage() != LageAbgelaufen {
		t.Fatalf("nach Ablauf: %s", lage())
	}
	if _, ok := a.Stand().GrenzeKw(now); ok {
		t.Fatal("GrenzeKw nach Ablauf noch aktiv")
	}
	// Handshake goes stale: tunnel_unten wins over the server state.
	now = now.Add(10 * time.Minute)
	if lage() != LageTunnelUnten {
		t.Fatalf("Handshake alt: %s", lage())
	}
	// A rejected certificate wins over everything but a missing access.
	a.SetzeZugangUngueltig(true)
	if lage() != LageZugangKaputt {
		t.Fatalf("zugang_ungueltig: %s", lage())
	}
}

// The flash event list records the §5.4 Nachweis events - and never material.
func TestAnschlussEreignisliste(t *testing.T) {
	a, dir, _, _ := testAnschluss(t)
	raw, doc := gueltigesDokument(t)
	if _, _, err := a.UebernimmProfil(doc, raw); err != nil {
		t.Fatal(err)
	}
	if err := a.UebernimmZugang(testZugang("SHA256:abc")); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Zuruecknehmen(); err != nil {
		t.Fatal(err)
	}
	var zeilen []string
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		zeilen, _ = ereignisliste.Lies(filepath.Join(dir, AblageEreignisse), 0)
		if len(zeilen) >= 4 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	text := strings.Join(zeilen, "\n")
	for _, want := range []string{EventProfilErhalten, EventZugangGespeichert, EventProfilZurueck, EventZugangGeloescht} {
		if !strings.Contains(text, want) {
			t.Fatalf("Ereignis %q fehlt in:\n%s", want, text)
		}
	}
	if strings.Contains(text, "BEGIN") || strings.Contains(text, "PRIVATE") {
		t.Fatalf("Ereignisliste traegt Material:\n%s", text)
	}
}

// The server snapshot feeds heartbeat and measurement points: write/query
// bookkeeping and the two new events.
func TestServerStandUndEreignisse(t *testing.T) {
	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	var events []Event
	srv := NewServer(gueltigesProfil(), 30*time.Second, func(ev Event) {
		mu.Lock()
		events = append(events, ev)
		mu.Unlock()
	})
	srv.now = func() time.Time { return now }

	st := srv.Stand()
	if st.State != StateWaitingForQuery || st.Abfragen != 0 || !st.LetzteSchreibung.IsZero() {
		t.Fatalf("Start-Stand: %+v", st)
	}
	if exc := srv.write(2, []uint16{40}); exc != 0 {
		t.Fatalf("write exc=0x%02x", exc)
	}
	if exc := srv.write(3, []uint16{0, 7}); exc != 0 {
		t.Fatalf("watchdog exc=0x%02x", exc)
	}
	st = srv.Stand()
	if st.Abfragen != 2 || st.LetzteSchreibung.IsZero() || st.EffektivPct != 40 || !st.Aktiv {
		t.Fatalf("Stand nach Schreiben: %+v", st)
	}
	mu.Lock()
	kinds := map[string]int{}
	var pct *int
	for _, ev := range events {
		kinds[ev.Kind]++
		if ev.Kind == EventSetpointWritten {
			pct = ev.Pct
		}
	}
	mu.Unlock()
	if kinds[EventFirstQuery] != 1 {
		t.Fatalf("partner_liest: %v", kinds)
	}
	if kinds[EventSetpointWritten] != 1 || pct == nil || *pct != 40 {
		t.Fatalf("vorgabe_geschrieben: %v pct=%v", kinds, pct)
	}
	// The same value written again is no new event.
	if exc := srv.write(2, []uint16{40}); exc != 0 {
		t.Fatal("write")
	}
	mu.Lock()
	n := 0
	for _, ev := range events {
		if ev.Kind == EventSetpointWritten {
			n++
		}
	}
	mu.Unlock()
	if n != 1 {
		t.Fatalf("vorgabe_geschrieben nach identischem Schreiben: %d", n)
	}
}

// End to end over TCP: the delivered (not embedded) profile serves a partner.
func TestAnschlussServerUeberTCP(t *testing.T) {
	a, _, _, _ := testAnschluss(t)
	raw, doc := gueltigesDokument(t)
	if _, _, err := a.UebernimmProfil(doc, raw); err != nil {
		t.Fatal(err)
	}
	srv := a.Server()
	if err := srv.Start("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	a.SetValues(time.Now(), map[string]float64{"referenz_w": 10000})

	conn, err := net.Dial("tcp", srv.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// FC 4, input register 5 (referenz_w, u32 = 2 words).
	req := make([]byte, 12)
	binary.BigEndian.PutUint16(req[0:2], 1)
	binary.BigEndian.PutUint16(req[4:6], 6)
	req[6] = 1
	req[7] = 4
	binary.BigEndian.PutUint16(req[8:10], 5)
	binary.BigEndian.PutUint16(req[10:12], 2)
	if _, err := conn.Write(req); err != nil {
		t.Fatal(err)
	}
	resp := make([]byte, 13)
	if _, err := io.ReadFull(conn, resp); err != nil {
		t.Fatal(err)
	}
	if resp[7] != 4 || resp[8] != 4 {
		t.Fatalf("Antwort: % x", resp)
	}
	lo := binary.BigEndian.Uint16(resp[9:11])
	hi := binary.BigEndian.Uint16(resp[11:13])
	// Little word order: low word first.
	if got := uint32(hi)<<16 | uint32(lo); got != 10000 {
		t.Fatalf("referenz_w = %d", got)
	}
}

