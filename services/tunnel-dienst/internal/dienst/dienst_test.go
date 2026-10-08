package dienst

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/abgleich"
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
