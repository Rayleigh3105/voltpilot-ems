package vermarktertunnel

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
)

// --- fakes --------------------------------------------------------------------

type fakeRunner struct {
	mu      sync.Mutex
	alive   bool
	starts  []time.Time
	stops   int
	startOK bool
	clock   func() time.Time
}

func (r *fakeRunner) Start(konfig string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.starts = append(r.starts, r.clock())
	if r.startOK {
		r.alive = true
	}
	return nil
}

func (r *fakeRunner) Alive() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.alive
}

func (r *fakeRunner) Stop() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stops++
	r.alive = false
	return nil
}

type fakeNetz struct {
	mu        sync.Mutex
	angewandt []string // the rulesets, as strings
	entfernt  int
}

func (n *fakeNetz) Anwenden(regeln []byte) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.angewandt = append(n.angewandt, string(regeln))
	return nil
}

func (n *fakeNetz) Entfernen() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.entfernt++
	return nil
}

type fakeSchnittstelle struct {
	mu        sync.Mutex
	laeuft    string // bound address, "" = stopped
	state     string
	lastQuery time.Time
	pct       int
	aktiv     bool
	werte     map[string]float64
	werteUm   time.Time
}

func (s *fakeSchnittstelle) Start(addr string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.laeuft = addr
	return nil
}

func (s *fakeSchnittstelle) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.laeuft = ""
}

func (s *fakeSchnittstelle) State() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state == "" {
		return direktvermarkter.StateWaitingForQuery
	}
	return s.state
}

func (s *fakeSchnittstelle) LastQuery() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastQuery
}

func (s *fakeSchnittstelle) Limit() (int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pct == 0 && !s.aktiv {
		return 100, false
	}
	return s.pct, s.aktiv
}

func (s *fakeSchnittstelle) SetValues(at time.Time, values map[string]float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.werteUm = at
	s.werte = values
}

// --- harness ------------------------------------------------------------------

type pruefstand struct {
	m      *Manager
	dir    string
	ram    string
	runner *fakeRunner
	netz   *fakeNetz
	ss     *fakeSchnittstelle
	now    time.Time
	mu     sync.Mutex
}

func (p *pruefstand) clock() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.now
}

func (p *pruefstand) vor(d time.Duration) {
	p.mu.Lock()
	p.now = p.now.Add(d)
	p.mu.Unlock()
}

// zaehler writes the status file the way a running daemon would: read-side
// counters at the given value.
func (p *pruefstand) zaehler(bytes uint64) {
	inhalt := fmt.Sprintf("OpenVPN STATISTICS\nUpdated,2026-11-25 12:00:00\nTCP/UDP read bytes,%d\nTCP/UDP write bytes,999999\nEND\n", bytes)
	if err := os.WriteFile(filepath.Join(p.ram, "stand"), []byte(inhalt), 0o600); err != nil {
		panic(err)
	}
}

func neuerPruefstand(t *testing.T) *pruefstand {
	t.Helper()
	p := &pruefstand{
		dir: t.TempDir(), ram: t.TempDir(),
		runner: &fakeRunner{startOK: true},
		netz:   &fakeNetz{},
		ss:     &fakeSchnittstelle{},
		now:    time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC),
	}
	p.runner.clock = p.clock
	p.m = New(Options{
		Dir: p.dir, RAM: p.ram,
		Jetzt:  p.clock,
		Netz:   p.netz,
		Runner: p.runner,
		neueSchnittstelle: func(_ direktvermarkter.Profile, _ time.Duration, _ func(direktvermarkter.Event)) schnittstelle {
			return p.ss
		},
	})
	return p
}

func (p *pruefstand) anschluss(t *testing.T) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(p.dir, AnschlussDatei), []byte(`{"partner":"luox","referenz_wp":12000}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (p *pruefstand) zugang(t *testing.T) {
	t.Helper()
	schreibeZugang(t, p.dir, gueltigerZugang, true)
}

func lageIst(t *testing.T, m *Manager, lage string) {
	t.Helper()
	if st := m.Status(); st.Lage != lage {
		t.Fatalf("Lage = %q (grund %q, fehler %q), want %q", st.Lage, st.Grund, st.Fehler, lage)
	}
}

// --- the §5.4 table -----------------------------------------------------------

func TestLagenOhneProfilUndOhneZugang(t *testing.T) {
	p := neuerPruefstand(t)
	p.m.Pruefe()
	lageIst(t, p.m, LageOhneProfil)
	if len(p.runner.starts) != 0 {
		t.Error("ohne Profil darf nichts starten")
	}

	p.anschluss(t)
	p.m.Pruefe()
	lageIst(t, p.m, LageOhneZugang)
	if len(p.runner.starts) != 0 {
		t.Error("ohne Zugang bleibt der Tunnel unten")
	}
}

func TestBautAufMitWachsenderPauseUndGrund(t *testing.T) {
	p := neuerPruefstand(t)
	p.anschluss(t)
	p.zugang(t)
	p.runner.startOK = false // the daemon dies instantly, over and over

	for i := 0; i < 200; i++ {
		p.m.Pruefe()
		p.vor(5 * time.Second)
	}
	lageIst(t, p.m, LageBautAuf)
	if st := p.m.Status(); st.Grund != GrundTunnelKommtNicht {
		t.Errorf("nach >10 min Aufbau fehlt der Grund, habe %q", st.Grund)
	}
	// growing pause: 1000 s of ticking must see far fewer starts than ticks,
	// and the gaps must grow (10 s, 20 s, 40 s, ...).
	starts := p.runner.starts
	if len(starts) < 3 || len(starts) > 10 {
		t.Fatalf("%d Starts in 1000 s - die Pause waechst nicht (oder startet nie)", len(starts))
	}
	for i := 2; i < len(starts); i++ {
		if starts[i].Sub(starts[i-1]) < starts[i-1].Sub(starts[i-2]) {
			t.Errorf("Pause schrumpft: %v nach %v", starts[i].Sub(starts[i-1]), starts[i-1].Sub(starts[i-2]))
		}
	}
	// the configuration was written once, 0600, and never the partner's file
	fi, err := os.Stat(filepath.Join(p.dir, "openvpn.conf"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("openvpn.conf mit %v, want 0600", fi.Mode().Perm())
	}
}

func TestVerbundenVorgabeAblaufUndTrennung(t *testing.T) {
	p := neuerPruefstand(t)
	p.anschluss(t)
	p.zugang(t)
	p.m.Pruefe() // baseline the counters
	p.zaehler(1000)
	p.m.Pruefe() // first read
	p.zaehler(2000)
	p.m.Pruefe() // growth -> the peer is there
	lageIst(t, p.m, LageTunnelOben)

	// the partner queries -> verbunden
	p.ss.mu.Lock()
	p.ss.lastQuery = p.clock()
	p.ss.state = direktvermarkter.StateConnected
	p.ss.mu.Unlock()
	p.m.Pruefe()
	lageIst(t, p.m, LageVerbunden)

	// a set-point below the rest value -> vorgabe_aktiv, Grenze in kW
	p.ss.mu.Lock()
	p.ss.state = direktvermarkter.StateLimitActive
	p.ss.pct, p.ss.aktiv = 30, true
	p.ss.mu.Unlock()
	p.m.Pruefe()
	lageIst(t, p.m, LageVorgabeAktiv)
	kw, wirktAuf, aktiv := p.m.Grenze()
	if !aktiv || kw != 3.6 || wirktAuf != direktvermarkter.WirktAufEinspeisung {
		t.Fatalf("Grenze = %v %q %v, want 3.6 kW einspeisung_netzpunkt true (30 %% von 12 kWp)", kw, wirktAuf, aktiv)
	}

	// watchdog expired -> abgelaufen, no limit
	p.ss.mu.Lock()
	p.ss.state = direktvermarkter.StateExpired
	p.ss.pct, p.ss.aktiv = 100, false
	p.ss.mu.Unlock()
	p.m.Pruefe()
	lageIst(t, p.m, LageAbgelaufen)
	if _, _, aktiv := p.m.Grenze(); aktiv {
		t.Error("abgelaufene Vorgabe darf keine Grenze mehr sein")
	}

	// counters stop growing -> tunnel_unten after the freshness window,
	// alarm event after 15 min
	for i := 0; i < 40; i++ {
		p.vor(30 * time.Second)
		p.m.Pruefe()
	}
	lageIst(t, p.m, LageTunnelUnten)
	ereignisse, err := os.ReadFile(filepath.Join(p.dir, "ereignisse"))
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"tunnel verbunden", "vorgabe 30 % aktiv", "tunnel getrennt", "alarm"} {
		if !strings.Contains(string(ereignisse), text) {
			t.Errorf("Ereignisliste ohne %q:\n%s", text, ereignisse)
		}
	}

	// the peer returns -> fresh again
	p.zaehler(5000)
	p.m.Pruefe()
	p.zaehler(6000)
	p.m.Pruefe()
	if st := p.m.Status(); st.Lage == LageTunnelUnten || st.Lage == LageBautAuf {
		t.Errorf("nach Rueckkehr der Gegenstelle noch %q", st.Lage)
	}
}

func TestZugangUngueltigStopptDenTunnel(t *testing.T) {
	p := neuerPruefstand(t)
	p.anschluss(t)
	p.zugang(t)
	p.m.Pruefe()
	if len(p.runner.starts) == 0 {
		t.Fatal("Tunnel startet nicht")
	}
	// past the validity -> zugang_ungueltig, daemon stopped, conf gone
	p.mu.Lock()
	p.now = time.Date(2027, 7, 1, 0, 0, 0, 0, time.UTC)
	p.mu.Unlock()
	p.m.Pruefe()
	lageIst(t, p.m, LageZugangUngueltig)
	if p.runner.alive {
		t.Error("abgelaufener Zugang laesst den Dienst weiterlaufen")
	}
	if _, err := os.Stat(filepath.Join(p.dir, "openvpn.conf")); !os.IsNotExist(err) {
		t.Error("openvpn.conf bleibt nach dem Stopp liegen")
	}
}

func TestProfilZurueckziehenBautAllesAb(t *testing.T) {
	p := neuerPruefstand(t)
	p.anschluss(t)
	p.zugang(t)
	p.m.Pruefe()
	if err := os.Remove(filepath.Join(p.dir, AnschlussDatei)); err != nil {
		t.Fatal(err)
	}
	p.m.Pruefe()
	lageIst(t, p.m, LageOhneProfil)
	if p.runner.alive {
		t.Error("zurueckgezogenes Profil laesst den Dienst weiterlaufen")
	}
	if p.ss.laeuft != "" {
		t.Error("die Schnittstelle lauscht noch")
	}
	if _, _, aktiv := p.m.Grenze(); aktiv {
		t.Error("ohne Profil darf keine Grenze stehen")
	}
}

func TestGeaenderteGegenstelleStartetDenDienstNeu(t *testing.T) {
	p := neuerPruefstand(t)
	p.anschluss(t)
	p.zugang(t)
	p.m.Pruefe()
	if p.runner.stops != 0 {
		t.Fatalf("schon %d Stops vor der Aenderung", p.runner.stops)
	}
	neu := strings.Replace(gueltigerZugang, "1194", "443", 1)
	schreibeZugang(t, p.dir, neu, true)
	p.vor(time.Hour) // past any back-off
	p.m.Pruefe()
	if p.runner.stops == 0 {
		t.Error("geaenderte Gegenstelle ohne Neustart des Dienstes")
	}
	raw, err := os.ReadFile(filepath.Join(p.dir, "openvpn.conf"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "remote vpn.luox-energy.de 443") {
		t.Error("openvpn.conf traegt die neue Gegenstelle nicht")
	}
}

func TestSetValuesErreichenDieSchnittstelle(t *testing.T) {
	p := neuerPruefstand(t)
	p.anschluss(t)
	p.zugang(t)
	p.m.Pruefe()
	at := p.clock()
	p.m.SetValues(at, map[string]float64{"nvp_einspeisung_w": 2350})
	p.ss.mu.Lock()
	defer p.ss.mu.Unlock()
	if p.ss.werte["nvp_einspeisung_w"] != 2350 || !p.ss.werteUm.Equal(at) {
		t.Errorf("Werte kamen nicht an: %+v um %v", p.ss.werte, p.ss.werteUm)
	}
}

func TestZaehlerStand(t *testing.T) {
	dir := t.TempDir()
	pfad := filepath.Join(dir, "stand")
	if _, _, ok := zaehlerStand(pfad); ok {
		t.Error("fehlende Datei darf keinen Stand liefern")
	}
	inhalt := "OpenVPN STATISTICS\nUpdated,2026-11-25 13:45:00\nTUN/TAP read bytes,1\nTCP/UDP read bytes,1500\nAuth read bytes,200\nTCP/UDP write bytes,777\nEND\n"
	if err := os.WriteFile(pfad, []byte(inhalt), 0o600); err != nil {
		t.Fatal(err)
	}
	summe, _, ok := zaehlerStand(pfad)
	if !ok || summe != 1700 {
		t.Errorf("summe=%d ok=%v, want 1700 (nur Lese-Zaehler) true", summe, ok)
	}
}
