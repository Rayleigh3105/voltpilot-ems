package dienst

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/abgleich"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/ausgabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/probe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/quelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/soll"
)

// Ersatz der Befehlsschicht: Peers und Fenster im Speicher, Fenster laufen
// nach der Test-Uhr ab wie im Kernel.

type uhr struct{ t time.Time }

func (u *uhr) jetzt() time.Time { return u.t }

type wgErsatz struct {
	peers map[string][]netip.Prefix
}

func (w *wgErsatz) Peers(context.Context) (map[string][]netip.Prefix, error) {
	kopie := map[string][]netip.Prefix{}
	for k, v := range w.peers {
		kopie[k] = v
	}
	return kopie, nil
}

func (w *wgErsatz) Setze(_ context.Context, key string, a netip.Addr) error {
	// WireGuard verschiebt eine Adresse zum neuen Peer.
	for k, v := range w.peers {
		if len(v) == 1 && v[0].Addr() == a && k != key {
			w.peers[k] = nil
		}
	}
	w.peers[key] = []netip.Prefix{netip.PrefixFrom(a, 32)}
	return nil
}

func (w *wgErsatz) Entferne(_ context.Context, key string) error {
	delete(w.peers, key)
	return nil
}

type fwErsatz struct {
	u         *uhr
	basisOK   bool
	basisFehl error
	bis       map[abgleich.Paar]time.Time
	geladen   int
}

func (f *fwErsatz) SichereBasis(context.Context) (bool, error) {
	if f.basisFehl != nil {
		return false, f.basisFehl
	}
	if f.basisOK {
		return false, nil
	}
	f.basisOK = true
	f.bis = map[abgleich.Paar]time.Time{}
	f.geladen++
	return true, nil
}

func (f *fwErsatz) Fenster(context.Context) (map[abgleich.Paar]time.Duration, error) {
	m := map[abgleich.Paar]time.Duration{}
	for p, bis := range f.bis {
		if rest := bis.Sub(f.u.t); rest > 0 {
			m[p] = rest.Truncate(time.Second)
		}
	}
	return m, nil
}

func (f *fwErsatz) offen(tech, box string) bool {
	bis, ok := f.bis[abgleich.Paar{Techniker: netip.MustParseAddr(tech), Box: netip.MustParseAddr(box)}]
	return ok && bis.After(f.u.t)
}

func (f *fwErsatz) EntferneFenster(_ context.Context, p abgleich.Paar) error {
	delete(f.bis, p)
	return nil
}

func (f *fwErsatz) FuegeFensterHinzu(_ context.Context, e []abgleich.FensterSetzen) error {
	for _, x := range e {
		f.bis[x.Paar] = f.u.t.Add(x.Timeout)
	}
	return nil
}

type quelleErsatz struct {
	daten []byte
	err   error
	n     int
}

func (q *quelleErsatz) Hole(context.Context) ([]byte, error) {
	q.n++
	return q.daten, q.err
}

const (
	keyBox  = "jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM="
	keyBox2 = "SBsk0U9z6BgB/U8nb+L9PdK/46p7mBvWRQe8I0Vg3C0="
	keyTech = "FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y="
)

func sollJSON(t *testing.T, beginn, ende time.Time, mitFenster bool) []byte {
	t.Helper()
	s := soll.Soll{Version: 1, ErzeugtAm: beginn, BoxNetz: "10.10.16.0/20", TechnikerNetz: "10.10.32.0/24",
		Peers: []soll.Peer{
			{Art: "box", ID: "b1", Kennung: "edge-zay5sdd", PublicKey: keyBox, Adresse: "10.10.16.2"},
			{Art: "box", ID: "b2", Kennung: "edge-k7m2xq3", PublicKey: keyBox2, Adresse: "10.10.16.3"},
			{Art: "techniker", ID: "t1", Kennung: "Max", PublicKey: keyTech, Adresse: "10.10.32.2"},
		}}
	if mitFenster {
		s.Fenster = []soll.Fenster{{ID: "f1", BoxID: "b1", TechnikerID: "t1", Beginn: beginn, Ende: ende}}
	}
	daten, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return daten
}

func aufbau(t *testing.T) (*Dienst, *uhr, *wgErsatz, *fwErsatz, *quelleErsatz) {
	t.Helper()
	u := &uhr{t: time.Date(2026, 10, 7, 14, 0, 0, 0, time.UTC)}
	wg := &wgErsatz{peers: map[string][]netip.Prefix{}}
	fw := &fwErsatz{u: u}
	q := &quelleErsatz{}
	d := &Dienst{Quelle: q, WG: wg, FW: fw,
		Netze:      soll.Netze{Box: netip.MustParsePrefix("10.10.16.0/20"), Techniker: netip.MustParsePrefix("10.10.32.0/24")},
		MaxFenster: 24 * time.Hour, MaxEntfernen: 10, Zustand: t.TempDir(),
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Jetzt: u.jetzt}
	return d, u, wg, fw, q
}

func TestEinFrischerStandWirdUmgesetztUndDannIstNichtsZuTun(t *testing.T) {
	d, u, wg, fw, q := aufbau(t)
	q.daten = sollJSON(t, u.t, u.t.Add(time.Hour), true)
	e := d.Lauf(context.Background())
	if e.Fehler != nil || !e.Frisch {
		t.Fatalf("%+v", e)
	}
	if len(wg.peers) != 3 || !fw.offen("10.10.32.2", "10.10.16.2") || fw.offen("10.10.32.2", "10.10.16.3") {
		t.Fatalf("peers %v fenster %v", wg.peers, fw.bis)
	}
	u.t = u.t.Add(30 * time.Second)
	if e := d.Lauf(context.Background()); !e.Plan.Leer() {
		t.Fatalf("zweiter Lauf soll nichts tun: %+v", e.Plan)
	}
	st, err := LiesStatus(d.Zustand)
	if err != nil || st.FehlerInFolge != 0 || st.Peers != 3 || st.Fenster != 1 {
		t.Fatalf("%+v %v", st, err)
	}
	info, err := os.Stat(filepath.Join(d.Zustand, zwischenstand))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("Zwischenstand: %v %v", info, err)
	}
}

func TestVorzeitigGeschlossenWirdSofortEntfernt(t *testing.T) {
	d, u, _, fw, q := aufbau(t)
	q.daten = sollJSON(t, u.t, u.t.Add(time.Hour), true)
	d.Lauf(context.Background())
	q.daten = sollJSON(t, u.t, u.t.Add(time.Hour), false)
	u.t = u.t.Add(time.Minute)
	d.Lauf(context.Background())
	if fw.offen("10.10.32.2", "10.10.16.2") {
		t.Fatal("geschlossenes Fenster muss weg sein")
	}
}

func TestOhneApiBleibtDerStandUndDasFensterSchliesstVonSelbst(t *testing.T) {
	d, u, wg, fw, q := aufbau(t)
	q.daten = sollJSON(t, u.t, u.t.Add(10*time.Minute), true)
	d.Lauf(context.Background())

	// API fällt aus; inzwischen hätte die API ein neues Fenster (zweite Box).
	q.err = errors.New("verbindung abgelehnt")
	u.t = u.t.Add(5 * time.Minute)
	e := d.Lauf(context.Background())
	if e.Fehler == nil || len(wg.peers) != 3 || !fw.offen("10.10.32.2", "10.10.16.2") {
		t.Fatalf("Stand muss bleiben: %+v %v", e, fw.bis)
	}
	if fw.offen("10.10.32.2", "10.10.16.3") {
		t.Fatal("ohne frischen Stand darf nichts Neues aufgehen")
	}
	// Das Fenster schließt im „Kernel", auch ohne Dienst und API.
	u.t = u.t.Add(6 * time.Minute)
	if fw.offen("10.10.32.2", "10.10.16.2") {
		t.Fatal("abgelaufenes Fenster muss zu sein")
	}
	for i := 0; i < AlarmNachFehlern; i++ {
		d.Lauf(context.Background())
	}
	st, _ := LiesStatus(d.Zustand)
	if st.FehlerInFolge != AlarmNachFehlern+1 || st.LetzterFehler == "" {
		t.Fatalf("%+v", st)
	}
}

// Eine abgelehnte Anmeldung ändert am Verhalten nichts (Stand bleibt, nichts
// Neues geht auf), steht aber sofort als Fehler mit eigenem Wortlaut im Log
// und in status.json - nicht als "API nicht erreichbar".
func TestAbgelehnteAnmeldungWirdSofortAlsSolcheGemeldet(t *testing.T) {
	for _, status := range []int{401, 403} {
		d, u, wg, fw, q := aufbau(t)
		var log bytes.Buffer
		d.Log = slog.New(slog.NewTextHandler(&log, nil))
		q.daten = sollJSON(t, u.t, u.t.Add(10*time.Minute), true)
		d.Lauf(context.Background())
		log.Reset()

		q.err = fmt.Errorf("%w (Token-Endpunkt: HTTP %d)", quelle.ErrAnmeldungAbgelehnt, status)
		u.t = u.t.Add(time.Minute)
		e := d.Lauf(context.Background())
		if !errors.Is(e.Fehler, quelle.ErrAnmeldungAbgelehnt) {
			t.Fatalf("HTTP %d: %v", status, e.Fehler)
		}
		if len(wg.peers) != 3 || !fw.offen("10.10.32.2", "10.10.16.2") || fw.offen("10.10.32.2", "10.10.16.3") {
			t.Fatalf("HTTP %d: Stand muss bleiben, nichts Neues: %v %v", status, wg.peers, fw.bis)
		}
		zeile := log.String()
		if !strings.Contains(zeile, "level=ERROR") || !strings.Contains(zeile, "Anmeldung abgelehnt: Client oder Secret prüfen") ||
			strings.Contains(zeile, "API nicht erreichbar") {
			t.Fatalf("HTTP %d: Log %q", status, zeile)
		}
		st, _ := LiesStatus(d.Zustand)
		if st.FehlerInFolge != 1 || !strings.HasPrefix(st.LetzterFehler, "Anmeldung abgelehnt: Client oder Secret prüfen") {
			t.Fatalf("HTTP %d: %+v", status, st)
		}
	}
}

// Die unerreichbare API bleibt eine Warnung mit ihrem bisherigen Wortlaut.
func TestUnerreichbareApiIstKeineAbgelehnteAnmeldung(t *testing.T) {
	d, _, _, _, q := aufbau(t)
	var log bytes.Buffer
	d.Log = slog.New(slog.NewTextHandler(&log, nil))
	q.err = errors.New("dial tcp 127.0.0.1:8080: connect: connection refused")
	e := d.Lauf(context.Background())
	zeile := log.String()
	if errors.Is(e.Fehler, quelle.ErrAnmeldungAbgelehnt) || !strings.Contains(zeile, "level=WARN") ||
		!strings.Contains(zeile, "API nicht erreichbar") || strings.Contains(zeile, "Anmeldung abgelehnt") {
		t.Fatalf("%v / %q", e.Fehler, zeile)
	}
}

func TestWiederanlaufAusDemZwischenstandNurPeersNieFenster(t *testing.T) {
	d, u, wg, fw, q := aufbau(t)
	q.daten = sollJSON(t, u.t, u.t.Add(time.Hour), true)
	d.Lauf(context.Background())

	// Neustart der VM: Schnittstelle leer, Firewall-Tabelle weg, API aus.
	d2, _, _, _, _ := aufbau(t)
	d2.Zustand = d.Zustand
	wg.peers = map[string][]netip.Prefix{}
	fw.basisOK = false
	d2.WG, d2.FW, d2.Jetzt = wg, fw, u.jetzt
	d2.Quelle = &quelleErsatz{err: errors.New("aus")}
	d2.Lauf(context.Background())
	if len(wg.peers) != 3 {
		t.Fatalf("Peers aus dem Zwischenstand erwartet: %v", wg.peers)
	}
	if len(fw.bis) != 0 {
		t.Fatalf("nie ein Fenster aus dem Zwischenstand: %v", fw.bis)
	}
	// Nur beim ersten Fehllauf, und nur bei leerer Schnittstelle.
	wg.peers = map[string][]netip.Prefix{}
	d2.Lauf(context.Background())
	if len(wg.peers) != 0 {
		t.Fatal("der Wiederanlauf läuft nur einmal")
	}
}

func TestOhneFirewallBasisKeineAenderung(t *testing.T) {
	d, u, wg, fw, q := aufbau(t)
	fw.basisFehl = errors.New("nft fehlt")
	q.daten = sollJSON(t, u.t, u.t.Add(time.Hour), true)
	if e := d.Lauf(context.Background()); e.Fehler == nil || len(wg.peers) != 0 || q.n != 0 {
		t.Fatalf("ohne Basis keine Peers und kein Abruf: %+v %v", e, wg.peers)
	}
}

func TestEinVerworfenerStandAendertNichts(t *testing.T) {
	d, u, wg, fw, q := aufbau(t)
	q.daten = sollJSON(t, u.t, u.t.Add(time.Hour), true)
	d.Lauf(context.Background())
	var s map[string]any
	_ = json.Unmarshal(sollJSON(t, u.t, u.t.Add(time.Hour), false), &s)
	s["boxNetz"] = "10.10.0.0/16"
	q.daten, _ = json.Marshal(s)
	e := d.Lauf(context.Background())
	if e.Fehler == nil || len(wg.peers) != 3 || !fw.offen("10.10.32.2", "10.10.16.2") {
		t.Fatalf("%+v", e)
	}
}

func TestEinLeererStandEntferntNichtAlleBoxen(t *testing.T) {
	d, u, wg, _, q := aufbau(t)
	d.MaxEntfernen = 2
	q.daten = sollJSON(t, u.t, u.t.Add(time.Hour), false)
	d.Lauf(context.Background())
	q.daten = []byte(`{"version":1,"boxNetz":"10.10.16.0/20","technikerNetz":"10.10.32.0/24","peers":[],"fenster":[]}`)
	e := d.Lauf(context.Background())
	if len(wg.peers) != 3 || len(e.Plan.Alarme) != 1 {
		t.Fatalf("%+v %v", e.Plan, wg.peers)
	}
}

// ── Journal: Ende eines Ausfalls, Ende eines Fensters ────────────────────────

func mitJournal(d *Dienst) *bytes.Buffer {
	var log bytes.Buffer
	d.Log = slog.New(slog.NewTextHandler(&log, nil))
	return &log
}

// Nach einem Ausfall der API steht EINE Zeile im Journal, wenn sie wieder da
// ist - sonst endet eine Kette von Warnungen und Alarmen einfach.
func TestApiWiederErreichbarStehtImJournal(t *testing.T) {
	d, u, _, _, q := aufbau(t)
	log := mitJournal(d)
	q.daten = sollJSON(t, u.t, u.t.Add(time.Hour), true)
	d.Lauf(context.Background())
	if strings.Contains(log.String(), "wieder erreichbar") {
		t.Fatalf("ohne Ausfall keine Zeile:\n%s", log.String())
	}
	q.err = errors.New("HTTP 502")
	for i := 0; i < 3; i++ {
		u.t = u.t.Add(30 * time.Second)
		d.Lauf(context.Background())
	}
	q.err = nil
	u.t = u.t.Add(30 * time.Second)
	d.Lauf(context.Background())
	if !strings.Contains(log.String(), `level=INFO msg="API wieder erreichbar" fehllaeufe=3 seit=2026-10-07T14:00:30Z dauer=1m30s`) {
		t.Fatalf("Journal:\n%s", log.String())
	}
	// Nur einmal.
	u.t = u.t.Add(30 * time.Second)
	d.Lauf(context.Background())
	if n := strings.Count(log.String(), "wieder erreichbar"); n != 1 {
		t.Fatalf("%d Zeilen", n)
	}
}

// Ein Fenster, das im Kernel abläuft, schließt ohne Zutun des Dienstes. Der
// nächste Lauf schreibt dafür eine Zeile - auch wenn die API gerade fehlt.
func TestAbgelaufenesFensterStehtImJournal(t *testing.T) {
	for _, apiAus := range []bool{false, true} {
		d, u, _, fw, q := aufbau(t)
		log := mitJournal(d)
		q.daten = sollJSON(t, u.t, u.t.Add(45*time.Second), true)
		d.Lauf(context.Background())
		u.t = u.t.Add(30 * time.Second)
		d.Lauf(context.Background())
		if strings.Contains(log.String(), "abgelaufen") {
			t.Fatalf("noch offen:\n%s", log.String())
		}
		// Die API nennt das Fenster nach seinem Ende nicht mehr.
		q.daten = sollJSON(t, u.t, u.t.Add(time.Hour), false)
		if apiAus {
			q.err = errors.New("verbindung abgelehnt")
		}
		u.t = u.t.Add(30 * time.Second)
		d.Lauf(context.Background())
		if fw.offen("10.10.32.2", "10.10.16.2") {
			t.Fatal("das Fenster muss im Kernel abgelaufen sein")
		}
		if !strings.Contains(log.String(), `level=INFO msg="Fenster abgelaufen" techniker=10.10.32.2 box=10.10.16.2 kennung=edge-zay5sdd ablauf=2026-10-07T14:00:45Z`) {
			t.Fatalf("API aus=%v, Journal:\n%s", apiAus, log.String())
		}
		if strings.Contains(log.String(), "Fenster geschlossen") {
			t.Fatalf("der Dienst hat es nicht geschlossen:\n%s", log.String())
		}
		u.t = u.t.Add(30 * time.Second)
		d.Lauf(context.Background())
		if n := strings.Count(log.String(), "Fenster abgelaufen"); n != 1 {
			t.Fatalf("API aus=%v: %d Zeilen", apiAus, n)
		}
	}
}

// Trifft ein Lauf die letzte Sekunde eines Fensters, entfernt der Dienst das
// Element selbst, weil der Stand es nicht mehr verlangt. Im Journal steht auch
// dann "abgelaufen": geschlossen hat es niemand.
func TestInDerLetztenSekundeEntferntIstAbgelaufen(t *testing.T) {
	d, u, _, fw, q := aufbau(t)
	log := mitJournal(d)
	q.daten = sollJSON(t, u.t, u.t.Add(60*time.Second+500*time.Millisecond), true)
	d.Lauf(context.Background())
	// Das Element läuft nach 60 s ab; jetzt hat es noch 0,3 s, und der Stand
	// verlangt das Fenster (unter einer Sekunde Rest) nicht mehr.
	u.t = u.t.Add(59*time.Second + 700*time.Millisecond)
	if !fw.offen("10.10.32.2", "10.10.16.2") {
		t.Fatal("Aufbau: das Fenster soll gerade noch offen sein")
	}
	d.Lauf(context.Background())
	if fw.offen("10.10.32.2", "10.10.16.2") || !strings.Contains(log.String(), `msg="Fenster abgelaufen" techniker=10.10.32.2 box=10.10.16.2`) ||
		strings.Contains(log.String(), "Fenster geschlossen") {
		t.Fatalf("Journal:\n%s", log.String())
	}
}

func TestGeschlossenIstNichtAbgelaufen(t *testing.T) {
	// Vom Dienst geschlossen: eine Zeile "geschlossen", keine "abgelaufen".
	d, u, _, _, q := aufbau(t)
	log := mitJournal(d)
	q.daten = sollJSON(t, u.t, u.t.Add(time.Hour), true)
	d.Lauf(context.Background())
	q.daten = sollJSON(t, u.t, u.t.Add(time.Hour), false)
	u.t = u.t.Add(30 * time.Second)
	d.Lauf(context.Background())
	u.t = u.t.Add(30 * time.Second)
	d.Lauf(context.Background())
	if !strings.Contains(log.String(), "Fenster geschlossen") || strings.Contains(log.String(), "abgelaufen") ||
		strings.Contains(log.String(), "Fenster fehlt") {
		t.Fatalf("Journal:\n%s", log.String())
	}

	// Von Hand aus der Menge genommen, lange vor der Ablaufzeit: eine Warnung,
	// kein "abgelaufen". Der Stand verlangt es weiter, der Lauf öffnet es wieder.
	d, u, _, fw, q := aufbau(t)
	log = mitJournal(d)
	q.daten = sollJSON(t, u.t, u.t.Add(time.Hour), true)
	d.Lauf(context.Background())
	for p := range fw.bis {
		delete(fw.bis, p)
	}
	u.t = u.t.Add(30 * time.Second)
	d.Lauf(context.Background())
	if !strings.Contains(log.String(), `level=WARN msg="Fenster fehlt vor seiner Ablaufzeit`) ||
		strings.Contains(log.String(), "abgelaufen") || !fw.offen("10.10.32.2", "10.10.16.2") {
		t.Fatalf("Journal:\n%s", log.String())
	}

	// Die Basis wurde neu geladen (nft flush ruleset): das steht schon als
	// eigene Warnung da, je Fenster kommt keine weitere Zeile.
	d, u, _, fw, q = aufbau(t)
	log = mitJournal(d)
	q.daten = sollJSON(t, u.t, u.t.Add(time.Hour), true)
	d.Lauf(context.Background())
	fw.basisOK = false
	u.t = u.t.Add(30 * time.Second)
	e := d.Lauf(context.Background())
	if !e.BasisGeladen || strings.Contains(log.String(), "abgelaufen") || strings.Contains(log.String(), "Fenster fehlt") ||
		!fw.offen("10.10.32.2", "10.10.16.2") {
		t.Fatalf("%+v\n%s", e, log.String())
	}
}

// ── Schlüsselausgabe ─────────────────────────────────────────────────────────

func sollMitSSH(t *testing.T, u *uhr, ssh string, fenster bool) []byte {
	t.Helper()
	var s soll.Soll
	if err := json.Unmarshal(sollJSON(t, u.t, u.t.Add(time.Hour), fenster), &s); err != nil {
		t.Fatal(err)
	}
	for i := range s.Peers {
		if s.Peers[i].Art == soll.ArtTechniker {
			s.Peers[i].SSHPublicKey = ssh
		}
	}
	daten, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return daten
}

// mitAusgabe hängt die echte Stelle an den Dienst; als Kernel-Menge dient
// dieselbe ersetzte Firewall, in die der Dienst die Fenster setzt.
func mitAusgabe(t *testing.T, d *Dienst, fw *fwErsatz) *ausgabe.Stelle {
	t.Helper()
	s := &ausgabe.Stelle{Menge: fw, BoxNetz: d.Netze.Box, Log: d.Log, Jetzt: time.Now, Frische: -1}
	d.Ausgabe = s
	return s
}

func schluesselFuer(t *testing.T, s *ausgabe.Stelle, box string) (code int, zeilen []string) {
	t.Helper()
	a := s.Frage(context.Background(), netip.MustParseAddr(box), 0, "")
	for _, z := range strings.Split(string(a.Text), "\n") {
		if strings.HasPrefix(z, "schluessel ") {
			zeilen = append(zeilen, z)
		}
	}
	return a.Code, zeilen
}

func TestSchluesselausgabeFolgtDemFenster(t *testing.T) {
	d, u, _, fw, q := aufbau(t)
	s := mitAusgabe(t, d, fw)
	k1, k2 := probe.SSHZeile(2048, 1), probe.SSHZeile(3072, 2)

	// Vor dem ersten gelungenen Abruf: keine Liste.
	q.err = errors.New("API aus")
	d.Lauf(context.Background())
	if code, _ := schluesselFuer(t, s, "10.10.16.2"); code != http.StatusServiceUnavailable {
		t.Fatalf("ohne Stand: %d", code)
	}

	// Zugang mit Schlüssel, aber kein Fenster: leere Liste.
	q.err = nil
	q.daten = sollMitSSH(t, u, k1, false)
	d.Lauf(context.Background())
	if code, zeilen := schluesselFuer(t, s, "10.10.16.2"); code != http.StatusOK || len(zeilen) != 0 {
		t.Fatalf("ohne Fenster: %d %q", code, zeilen)
	}

	// Fenster zu box1: nur box1 bekommt den Schlüssel.
	q.daten = sollMitSSH(t, u, k1, true)
	d.Lauf(context.Background())
	// Die Restlaufzeit wird abgerundet: 3599 oder 3600 Sekunden.
	if _, zeilen := schluesselFuer(t, s, "10.10.16.2"); len(zeilen) != 1 ||
		zeilen[0] != "schluessel 3599 t1 "+k1 && zeilen[0] != "schluessel 3600 t1 "+k1 {
		t.Fatalf("box1: %q", zeilen)
	}
	if _, zeilen := schluesselFuer(t, s, "10.10.16.3"); len(zeilen) != 0 {
		t.Fatalf("box2 sieht das Fenster von box1: %q", zeilen)
	}

	// Der Schlüssel wird im offenen Fenster ersetzt: ab dem nächsten Abruf
	// des Soll-Stands nennt die Ausgabe den alten nicht mehr.
	q.daten = sollMitSSH(t, u, k2, true)
	d.Lauf(context.Background())
	if _, zeilen := schluesselFuer(t, s, "10.10.16.2"); len(zeilen) != 1 || !strings.HasSuffix(zeilen[0], " t1 "+k2) {
		t.Fatalf("nach dem Ersetzen: %q", zeilen)
	}

	// Ein unbrauchbarer Schlüssel aus der API wird nicht weitergereicht.
	q.daten = sollMitSSH(t, u, `command="/bin/sh" `+k1, true)
	d.Lauf(context.Background())
	if code, zeilen := schluesselFuer(t, s, "10.10.16.2"); code != http.StatusOK || len(zeilen) != 0 {
		t.Fatalf("unbrauchbarer Schlüssel: %d %q", code, zeilen)
	}
	if !fw.offen("10.10.32.2", "10.10.16.2") {
		t.Fatal("der Netzweg hängt nicht am SSH-Schlüssel")
	}

	// API aus: der letzte Stand bleibt, es kommt kein neuer Schlüssel dazu -
	// auch nicht der, den die API inzwischen hätte.
	q.daten = sollMitSSH(t, u, k1, true)
	d.Lauf(context.Background())
	q.daten = sollMitSSH(t, u, k2, true)
	q.err = errors.New("API aus")
	u.t = u.t.Add(30 * time.Second)
	d.Lauf(context.Background())
	if _, zeilen := schluesselFuer(t, s, "10.10.16.2"); len(zeilen) != 1 || !strings.HasSuffix(zeilen[0], " t1 "+k1) {
		t.Fatalf("API aus: %q", zeilen)
	}
	// Läuft das Fenster inzwischen im Kernel ab, ist die Liste leer.
	u.t = u.t.Add(2 * time.Hour)
	if code, zeilen := schluesselFuer(t, s, "10.10.16.2"); code != http.StatusOK || len(zeilen) != 0 {
		t.Fatalf("nach Ablauf: %d %q", code, zeilen)
	}
}

// Nach einem Neustart ohne erreichbare API kommen die Peers aus dem
// Zwischenstand - Schlüssel kommen von dort nie.
func TestKeinSchluesselAusDemZwischenstand(t *testing.T) {
	d, u, wg, fw, q := aufbau(t)
	mitAusgabe(t, d, fw)
	q.daten = sollMitSSH(t, u, probe.SSHZeile(2048, 1), true)
	d.Lauf(context.Background())

	// Nur der Dienst startet neu; das Fenster steht noch im Kernel.
	d2, _, _, _, _ := aufbau(t)
	d2.Zustand = d.Zustand
	wg.peers = map[string][]netip.Prefix{}
	d2.WG, d2.FW, d2.Jetzt = wg, fw, u.jetzt
	d2.Quelle = &quelleErsatz{err: errors.New("aus")}
	s2 := mitAusgabe(t, d2, fw)
	d2.Lauf(context.Background())
	if len(wg.peers) != 3 || !fw.offen("10.10.32.2", "10.10.16.2") {
		t.Fatalf("Aufbau: %v %v", wg.peers, fw.bis)
	}
	if code, zeilen := schluesselFuer(t, s2, "10.10.16.2"); code != http.StatusServiceUnavailable || len(zeilen) != 0 {
		t.Fatalf("aus dem Zwischenstand: %d %q", code, zeilen)
	}
}

type ausgabeErsatz struct{ ablauf []string }

func (a *ausgabeErsatz) SetzeStand(soll.Gueltig) { a.ablauf = append(a.ablauf, "stand") }
func (a *ausgabeErsatz) Geaendert()              { a.ablauf = append(a.ablauf, "geaendert") }

func TestAusgabeErfaehrtStandUndAenderung(t *testing.T) {
	d, u, _, fw, q := aufbau(t)
	a := &ausgabeErsatz{}
	d.Ausgabe = a
	q.daten = sollJSON(t, u.t, u.t.Add(time.Hour), true)
	d.Lauf(context.Background())
	// Ein Fehllauf ändert nichts und meldet nichts.
	q.err = errors.New("aus")
	d.Lauf(context.Background())
	// Die Basis wird neu geladen, die API fehlt: die Menge ist jetzt leer,
	// und das erfährt die Ausgabe.
	fw.basisOK = false
	d.Lauf(context.Background())
	// Ein verworfener Stand wird nicht übernommen.
	q.err = nil
	q.daten = []byte(`{"version":2}`)
	d.Lauf(context.Background())
	if got := strings.Join(a.ablauf, " "); got != "stand geaendert geaendert" {
		t.Fatalf("Ablauf: %s", got)
	}
}

// ── Anlauf nach dem Start ────────────────────────────────────────────────────

func TestTaktVersuchtEsNachDemStartSchneller(t *testing.T) {
	netz := Ergebnis{Fehler: errors.New("lookup portal.voltpilot.de: connection refused"), APIFehlt: true}
	takt := Takt{Intervall: 30 * time.Second}
	for i := 0; i < AnlaufVersuche; i++ {
		if got := takt.Naechster(netz); got != AnlaufPause {
			t.Fatalf("Versuch %d: %s", i, got)
		}
	}
	// Danach wie immer - eine API, die länger fehlt, wird nicht bestürmt.
	if got := takt.Naechster(netz); got != 30*time.Second {
		t.Fatalf("nach den schnellen Versuchen: %s", got)
	}

	// Nach dem ersten gelungenen Abruf gilt nur noch das Intervall.
	takt = Takt{Intervall: 30 * time.Second}
	takt.Naechster(netz)
	if got := takt.Naechster(Ergebnis{Frisch: true}); got != 30*time.Second {
		t.Fatalf("nach Erfolg: %s", got)
	}
	if got := takt.Naechster(netz); got != 30*time.Second {
		t.Fatalf("späterer Ausfall: %s", got)
	}

	// Eine abgelehnte Anmeldung vergeht nicht von selbst.
	takt = Takt{Intervall: 30 * time.Second}
	if got := takt.Naechster(Ergebnis{Fehler: quelle.ErrAnmeldungAbgelehnt}); got != 30*time.Second {
		t.Fatalf("abgelehnte Anmeldung: %s", got)
	}
	// Ein Intervall, das selbst nicht länger ist, bleibt, wie es ist.
	takt = Takt{Intervall: 5 * time.Second}
	if got := takt.Naechster(netz); got != 5*time.Second {
		t.Fatalf("kurzes Intervall: %s", got)
	}
}

func TestErgebnisNenntDieUnerreichbareApi(t *testing.T) {
	d, _, _, _, q := aufbau(t)
	q.err = errors.New("dial tcp: connection refused")
	if e := d.Lauf(context.Background()); !e.APIFehlt {
		t.Fatalf("%+v", e)
	}
	q.err = fmt.Errorf("%w (Token-Endpunkt: HTTP 401)", quelle.ErrAnmeldungAbgelehnt)
	if e := d.Lauf(context.Background()); e.APIFehlt {
		t.Fatalf("abgelehnte Anmeldung: %+v", e)
	}
	q.err = nil
	q.daten = []byte(`kein json`)
	if e := d.Lauf(context.Background()); e.APIFehlt || e.Fehler == nil {
		t.Fatalf("ungültiger Inhalt: %+v", e)
	}
}
