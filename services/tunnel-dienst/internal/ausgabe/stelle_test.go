package ausgabe

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/abgleich"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/probe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/soll"
)

// mengeErsatz ist die Kernel-Menge "fenster" im Speicher.
type mengeErsatz struct {
	mu       sync.Mutex
	fenster  map[abgleich.Paar]time.Duration
	err      error
	lesungen int
}

func (m *mengeErsatz) Fenster(context.Context) (map[abgleich.Paar]time.Duration, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lesungen++
	if m.err != nil {
		return nil, m.err
	}
	kopie := map[abgleich.Paar]time.Duration{}
	for p, d := range m.fenster {
		kopie[p] = d
	}
	return kopie, nil
}

func (m *mengeErsatz) setze(f map[abgleich.Paar]time.Duration) {
	m.mu.Lock()
	m.fenster = f
	m.mu.Unlock()
}

// sicher ist ein Puffer fürs Journal, in den mehrere Goroutinen schreiben.
type sicher struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *sicher) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *sicher) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

var (
	boxNetz  = netip.MustParsePrefix("10.10.16.0/20")
	techNetz = netip.MustParsePrefix("10.10.32.0/24")
	box1     = netip.MustParseAddr("10.10.16.2")
	box2     = netip.MustParseAddr("10.10.16.3")
	tech1    = netip.MustParseAddr("10.10.32.2")
	tech2    = netip.MustParseAddr("10.10.32.3")
	tech3    = netip.MustParseAddr("10.10.32.4")
	key1     = probe.SSHZeile(2048, 1)
	key2     = probe.SSHZeile(3072, 2)
	key3     = probe.SSHZeile(4096, 3)
)

func paar(tech, box netip.Addr) abgleich.Paar { return abgleich.Paar{Techniker: tech, Box: box} }

// gueltig baut einen geprüften Stand: zwei Boxen, drei Techniker-Zugänge;
// ssh ordnet den Zugängen t1..t3 ihre Schlüssel zu ("" = keiner).
func gueltig(t *testing.T, ssh ...string) soll.Gueltig {
	t.Helper()
	var wg []string // fünf verschiedene WireGuard-Schlüssel (32 Byte)
	for i := 1; i <= 5; i++ {
		wg = append(wg, base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{byte(i)}, 32)))
	}
	s := soll.Soll{Version: 1, BoxNetz: boxNetz.String(), TechnikerNetz: techNetz.String(), Peers: []soll.Peer{
		{Art: "box", ID: "b1", Kennung: "edge-zay5sdd", PublicKey: wg[0], Adresse: box1.String()},
		{Art: "box", ID: "b2", Kennung: "edge-k7m2xq3", PublicKey: wg[1], Adresse: box2.String()},
	}}
	for i, a := range []netip.Addr{tech1, tech2, tech3} {
		p := soll.Peer{Art: "techniker", ID: fmt.Sprintf("t%d", i+1), Kennung: fmt.Sprintf("Techniker %d", i+1),
			PublicKey: wg[2+i], Adresse: a.String()}
		if i < len(ssh) {
			p.SSHPublicKey = ssh[i]
		}
		s.Peers = append(s.Peers, p)
	}
	g, befunde, err := soll.Pruefe(s, soll.Netze{Box: boxNetz, Techniker: techNetz})
	if err != nil || len(befunde) != 0 || len(g.Peers) != 5 {
		t.Fatalf("Prüfstand: %v %v %d Peers", err, befunde, len(g.Peers))
	}
	return g
}

func neueStelle(t *testing.T) (*Stelle, *mengeErsatz, *sicher) {
	t.Helper()
	m := &mengeErsatz{fenster: map[abgleich.Paar]time.Duration{}}
	log := &sicher{}
	s := &Stelle{Menge: m, BoxNetz: boxNetz, Log: slog.New(slog.NewTextHandler(log, nil)), Jetzt: time.Now,
		Zustand: t.TempDir(), Adresse: "10.10.32.1:8022", Frische: -1}
	return s, m, log
}

func sofort(s *Stelle, box netip.Addr) Antwort {
	return s.Frage(context.Background(), box, 0, "")
}

var (
	kopfZeile      = regexp.MustCompile(`^vp-wartung-schluessel 1 [0-9a-f]{16}$`)
	schluesselForm = regexp.MustCompile(`^schluessel [1-9][0-9]* [A-Za-z0-9_-]{1,64} ssh-rsa AAAAB3NzaC1yc2E[A-Za-z0-9+/]+=*$`)
)

// zerlege prüft die Form einer Antwort so streng, wie eine Box es tut, und
// liefert Prüfwert und Zeilen.
func zerlege(t *testing.T, text []byte) (pruefwert string, schluessel []string) {
	t.Helper()
	if !bytes.HasSuffix(text, []byte("\n")) {
		t.Fatalf("Antwort endet nicht mit einem Zeilenende: %q", text)
	}
	zeilen := strings.Split(strings.TrimSuffix(string(text), "\n"), "\n")
	if len(zeilen) < 2 || !kopfZeile.MatchString(zeilen[0]) {
		t.Fatalf("Kopfzeile: %q", text)
	}
	for _, z := range zeilen[1 : len(zeilen)-1] {
		if !schluesselForm.MatchString(z) {
			t.Fatalf("Schlüsselzeile: %q", z)
		}
		schluessel = append(schluessel, z)
	}
	if zeilen[len(zeilen)-1] != fmt.Sprintf("ende %d", len(schluessel)) {
		t.Fatalf("Schlusszeile %q bei %d Schlüsseln", zeilen[len(zeilen)-1], len(schluessel))
	}
	return strings.Fields(zeilen[0])[2], schluessel
}

func TestZuordnungNachAbsender(t *testing.T) {
	s, m, _ := neueStelle(t)
	s.SetzeStand(gueltig(t, key1, key2, ""))
	m.setze(map[abgleich.Paar]time.Duration{
		paar(tech1, box1): 3600*time.Second + 500*time.Millisecond,
		paar(tech2, box2): 90*time.Second + 500*time.Millisecond,
		paar(tech3, box1): time.Hour, // Fenster offen, aber kein SSH-Schlüssel am Zugang
	})

	a := sofort(s, box1)
	if a.Code != http.StatusOK {
		t.Fatalf("%d %s", a.Code, a.Text)
	}
	_, zeilen := zerlege(t, a.Text)
	if len(zeilen) != 1 || zeilen[0] != "schluessel 3600 t1 "+key1 {
		t.Fatalf("box1 bekommt %q", zeilen)
	}

	// Die zweite Box sieht nur ihr eigenes Fenster.
	_, zeilen = zerlege(t, sofort(s, box2).Text)
	if len(zeilen) != 1 || zeilen[0] != "schluessel 90 t2 "+key2 {
		t.Fatalf("box2 bekommt %q", zeilen)
	}

	// Eine Box ohne Fenster: eine leere, gültige Liste.
	a = sofort(s, netip.MustParseAddr("10.10.16.9"))
	if _, zeilen := zerlege(t, a.Text); a.Code != http.StatusOK || len(zeilen) != 0 {
		t.Fatalf("Box ohne Fenster: %d %q", a.Code, a.Text)
	}
	if string(a.Text) != "vp-wartung-schluessel 1 "+Pruefwert(nil)+"\nende 0\n" {
		t.Fatalf("leere Liste: %q", a.Text)
	}
}

func TestNurBoxAdressenBekommenEineAntwort(t *testing.T) {
	s, m, _ := neueStelle(t)
	s.SetzeStand(gueltig(t, key1))
	m.setze(map[abgleich.Paar]time.Duration{paar(tech1, box1): time.Hour})
	for _, a := range []string{
		"10.10.32.2",   // Techniker
		"10.10.32.1",   // der Server im Techniker-Netz
		"10.10.16.1",   // der Server im Box-Netz
		"10.10.16.0",   // Netzadresse
		"10.10.31.255", // Broadcast des Box-Netzes
		"192.168.178.20",
		"127.0.0.1",
		"fd00::2",
	} {
		antwort := sofort(s, netip.MustParseAddr(a))
		if antwort.Code != http.StatusForbidden || bytes.Contains(antwort.Text, []byte("ssh-rsa")) {
			t.Errorf("%s: %d %q", a, antwort.Code, antwort.Text)
		}
	}
	if m.lesungen != 0 {
		t.Errorf("für eine fremde Adresse wird die Menge gar nicht erst gelesen (%d Lesungen)", m.lesungen)
	}
}

// Kein frischer Stand seit dem Start: keine Liste - auch keine leere, denn
// eine leere hieße "niemand darf", und die Box striche ihre Schlüssel.
func TestKeinStandKeineListe(t *testing.T) {
	s, m, _ := neueStelle(t)
	m.setze(map[abgleich.Paar]time.Duration{paar(tech1, box1): time.Hour}) // Fenster aus der Zeit vor dem Neustart
	a := sofort(s, box1)
	if a.Code != http.StatusServiceUnavailable || bytes.Contains(a.Text, []byte(Kopf)) {
		t.Fatalf("ohne Stand: %d %q", a.Code, a.Text)
	}
	s.SetzeStand(gueltig(t, key1))
	if a := sofort(s, box1); a.Code != http.StatusOK {
		t.Fatalf("mit Stand: %d %q", a.Code, a.Text)
	}
	// Die Menge ist nicht lesbar (Tabelle fehlt): ebenfalls keine Liste.
	m.mu.Lock()
	m.err = errors.New("nft: No such file or directory")
	m.mu.Unlock()
	if a := sofort(s, box1); a.Code != http.StatusServiceUnavailable || bytes.Contains(a.Text, []byte(Kopf)) {
		t.Fatalf("Menge nicht lesbar: %d %q", a.Code, a.Text)
	}
}

// Die Menge ist die einzige Wahrheit: Was dort nicht (mehr) steht, wird nicht
// ausgegeben - auch wenn der Stand den Zugang und seinen Schlüssel kennt.
func TestNurWasInDerMengeSteht(t *testing.T) {
	s, m, _ := neueStelle(t)
	s.SetzeStand(gueltig(t, key1, key2))
	if _, zeilen := zerlege(t, sofort(s, box1).Text); len(zeilen) != 0 {
		t.Fatalf("ohne Element: %q", zeilen)
	}
	m.setze(map[abgleich.Paar]time.Duration{
		paar(tech1, box1): 900 * time.Millisecond, // läuft in diesem Augenblick ab
		paar(tech2, box1): 30 * time.Second,
		paar(netip.MustParseAddr("10.10.32.77"), box1): time.Hour, // von Hand gesetzt, kein Zugang im Stand
	})
	_, zeilen := zerlege(t, sofort(s, box1).Text)
	if len(zeilen) != 1 || !strings.HasPrefix(zeilen[0], "schluessel 29 t2 ") && !strings.HasPrefix(zeilen[0], "schluessel 30 t2 ") {
		t.Fatalf("%q", zeilen)
	}
}

// Wird ein Schlüssel im offenen Fenster ersetzt oder entfernt, nennt die
// Ausgabe den alten ab dem nächsten Stand nicht mehr.
func TestErsetzterUndEntfernterSchluessel(t *testing.T) {
	s, m, log := neueStelle(t)
	m.setze(map[abgleich.Paar]time.Duration{paar(tech1, box1): time.Hour})
	s.SetzeStand(gueltig(t, key1))
	pw1, zeilen := zerlege(t, sofort(s, box1).Text)
	if len(zeilen) != 1 || !strings.HasSuffix(zeilen[0], key1) {
		t.Fatalf("%q", zeilen)
	}

	s.SetzeStand(gueltig(t, key3))
	pw2, zeilen := zerlege(t, sofort(s, box1).Text)
	if len(zeilen) != 1 || !strings.HasSuffix(zeilen[0], " t1 "+key3) || pw2 == pw1 {
		t.Fatalf("nach dem Ersetzen: %q (Prüfwert %s -> %s)", zeilen, pw1, pw2)
	}

	s.SetzeStand(gueltig(t, ""))
	pw3, zeilen := zerlege(t, sofort(s, box1).Text)
	if len(zeilen) != 0 || pw3 != Pruefwert(nil) {
		t.Fatalf("nach dem Entfernen: %q", zeilen)
	}

	// Das Journal nennt, welcher Box welcher Schlüssel ausgegeben wurde - mit
	// Fingerabdruck, nie mit dem Schlüssel selbst.
	f1, _ := soll.PruefeSSHSchluessel(key1)
	f3, _ := soll.PruefeSSHSchluessel(key3)
	journal := log.String()
	for _, muss := range []string{
		`msg="Schlüssel ausgegeben" box=10.10.16.2 kennung=edge-zay5sdd techniker="Techniker 1" zugang=t1 fingerabdruck=` + f1.Fingerabdruck,
		`msg="Schlüssel ausgegeben" box=10.10.16.2 kennung=edge-zay5sdd techniker="Techniker 1" zugang=t1 fingerabdruck=` + f3.Fingerabdruck,
		`msg="Schlüssel nicht mehr ausgegeben" box=10.10.16.2 kennung=edge-zay5sdd techniker="Techniker 1" zugang=t1 fingerabdruck=` + f1.Fingerabdruck,
		`msg="Schlüssel nicht mehr ausgegeben" box=10.10.16.2 kennung=edge-zay5sdd techniker="Techniker 1" zugang=t1 fingerabdruck=` + f3.Fingerabdruck,
	} {
		if !strings.Contains(journal, muss) {
			t.Errorf("Journal ohne %q:\n%s", muss, journal)
		}
	}
	if strings.Contains(journal, "AAAAB3NzaC1yc2E") {
		t.Errorf("der Schlüssel selbst steht im Journal:\n%s", journal)
	}
}

// Eine unveränderte Antwort steht nicht noch einmal im Journal; `status`
// zeigt, wann die Box zuletzt gefragt hat.
func TestJournalUndZustand(t *testing.T) {
	s, m, log := neueStelle(t)
	s.SetzeStand(gueltig(t, key1))
	m.setze(map[abgleich.Paar]time.Duration{paar(tech1, box1): time.Hour})
	for i := 0; i < 3; i++ {
		sofort(s, box1)
	}
	sofort(s, box2)
	if n := strings.Count(log.String(), "Schlüssel ausgegeben"); n != 1 {
		t.Fatalf("%d Zeilen statt einer:\n%s", n, log.String())
	}
	s.Sichere()
	z, err := LiesZustand(s.Zustand)
	if err != nil {
		t.Fatal(err)
	}
	b1, b2 := z.Boxen["10.10.16.2"], z.Boxen["10.10.16.3"]
	f1, _ := soll.PruefeSSHSchluessel(key1)
	if b1.Anfragen != 3 || time.Since(b1.LetzteAnfrage) > time.Minute || len(b1.Ausgegeben) != 1 ||
		b1.Ausgegeben[0].Fingerabdruck != f1.Fingerabdruck || b1.Ausgegeben[0].Techniker != "Techniker 1" {
		t.Fatalf("box1: %+v", b1)
	}
	if b2.Anfragen != 1 || len(b2.Ausgegeben) != 0 || z.Adresse != "10.10.32.1:8022" || z.Laeuft {
		t.Fatalf("box2: %+v, %+v", b2, z)
	}
	info, err := os.Stat(filepath.Join(s.Zustand, zustandsDatei))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("%v %v", info, err)
	}
}

func TestHoechstensAchtSchluesselJeAntwort(t *testing.T) {
	s, m, log := neueStelle(t)
	st := &stand{techniker: map[netip.Addr]zugang{}, boxen: map[netip.Addr]string{}}
	fenster := map[abgleich.Paar]time.Duration{}
	for i := 0; i < MaxJeBox+3; i++ {
		a := netip.AddrFrom4([4]byte{10, 10, 32, byte(10 + i)})
		ssh, err := soll.PruefeSSHSchluessel(probe.SSHZeile(2048, 100+i))
		if err != nil {
			t.Fatal(err)
		}
		st.techniker[a] = zugang{id: fmt.Sprintf("z%02d", i), kennung: "T", ssh: ssh}
		fenster[paar(a, box1)] = time.Hour
	}
	s.stand = st
	m.setze(fenster)
	_, zeilen := zerlege(t, sofort(s, box1).Text)
	if len(zeilen) != MaxJeBox || !strings.Contains(zeilen[0], " z00 ") || !strings.Contains(zeilen[MaxJeBox-1], " z07 ") {
		t.Fatalf("%d Zeilen: %q", len(zeilen), zeilen)
	}
	if !strings.Contains(log.String(), "level=WARN") {
		t.Fatal("die gekürzte Liste steht nicht im Journal")
	}
}

// Die Anfrage bleibt offen, solange die Box die Liste schon kennt, und wird
// beantwortet, sobald sich die Liste ändert.
func TestOffeneAnfrageWirdBeiAenderungBeantwortet(t *testing.T) {
	s, m, _ := neueStelle(t)
	s.SetzeStand(gueltig(t, key1))
	m.setze(map[abgleich.Paar]time.Duration{paar(tech1, box1): time.Hour})
	pw, _ := zerlege(t, sofort(s, box1).Text)

	antwort := make(chan Antwort, 1)
	go func() { antwort <- s.Frage(context.Background(), box1, 30*time.Second, pw) }()

	// Ein Lauf ohne Änderung weckt die Anfrage, beantwortet sie aber nicht.
	time.Sleep(50 * time.Millisecond)
	s.Geaendert()
	select {
	case a := <-antwort:
		t.Fatalf("ohne Änderung beantwortet: %d %q", a.Code, a.Text)
	case <-time.After(200 * time.Millisecond):
	}

	// Das Fenster wird geschlossen: die Antwort kommt sofort.
	beginn := time.Now()
	m.setze(map[abgleich.Paar]time.Duration{})
	s.Geaendert()
	select {
	case a := <-antwort:
		if _, zeilen := zerlege(t, a.Text); a.Code != http.StatusOK || len(zeilen) != 0 {
			t.Fatalf("%d %q", a.Code, a.Text)
		}
		if d := time.Since(beginn); d > 2*time.Second {
			t.Fatalf("erst nach %s", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("keine Antwort nach der Änderung")
	}

	// Ohne Änderung kommt die Antwort, wenn die Wartezeit um ist - mit derselben Liste.
	beginn = time.Now()
	a := s.Frage(context.Background(), box1, time.Second, Pruefwert(nil))
	if d := time.Since(beginn); a.Code != http.StatusOK || d < 900*time.Millisecond || d > 3*time.Second {
		t.Fatalf("%d nach %s", a.Code, d)
	}
	// Ein neuer Schlüssel am Zugang ist ebenfalls eine Änderung.
	m.setze(map[abgleich.Paar]time.Duration{paar(tech1, box1): time.Hour})
	pw, _ = zerlege(t, sofort(s, box1).Text)
	go func() { antwort <- s.Frage(context.Background(), box1, 30*time.Second, pw) }()
	time.Sleep(50 * time.Millisecond)
	s.SetzeStand(gueltig(t, key2))
	s.Geaendert()
	select {
	case a := <-antwort:
		if _, zeilen := zerlege(t, a.Text); len(zeilen) != 1 || !strings.HasSuffix(zeilen[0], key2) {
			t.Fatalf("%q", a.Text)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("keine Antwort nach dem Schlüsselwechsel")
	}
}

// Läuft das Fenster im Kernel ab, während die Anfrage offen ist, kommt die
// leere Liste zum Ablauf - nicht erst am Ende der Wartezeit.
func TestOffeneAnfrageEndetMitDemAblaufDesFensters(t *testing.T) {
	s, m, _ := neueStelle(t)
	s.Frische = time.Minute // die Lesung bleibt stehen; der Ablauf ergibt sich aus ihrer Zeitangabe
	s.SetzeStand(gueltig(t, key1))
	m.setze(map[abgleich.Paar]time.Duration{paar(tech1, box1): 2200 * time.Millisecond})
	pw, zeilen := zerlege(t, sofort(s, box1).Text)
	if len(zeilen) != 1 {
		t.Fatalf("%q", zeilen)
	}
	beginn := time.Now()
	a := s.Frage(context.Background(), box1, 30*time.Second, pw)
	d := time.Since(beginn)
	if _, zeilen := zerlege(t, a.Text); a.Code != http.StatusOK || len(zeilen) != 0 {
		t.Fatalf("%d %q", a.Code, a.Text)
	}
	if d < 800*time.Millisecond || d > 5*time.Second {
		t.Fatalf("Antwort nach %s, erwartet zum Ablauf nach gut einer Sekunde", d)
	}
}

// Je Box ist nur eine Anfrage offen: eine neuere löst die ältere ab.
func TestEineOffeneAnfrageJeBox(t *testing.T) {
	s, _, _ := neueStelle(t)
	s.SetzeStand(gueltig(t, key1))
	leer := Pruefwert(nil)
	erste := make(chan Antwort, 1)
	go func() { erste <- s.Frage(context.Background(), box1, 30*time.Second, leer) }()
	andere := make(chan Antwort, 1)
	go func() { andere <- s.Frage(context.Background(), box2, 30*time.Second, leer) }()
	time.Sleep(100 * time.Millisecond)

	ctx, abbruch := context.WithCancel(context.Background())
	zweite := make(chan Antwort, 1)
	go func() { zweite <- s.Frage(ctx, box1, 30*time.Second, leer) }()
	select {
	case a := <-erste:
		if a.Code != http.StatusTooManyRequests {
			t.Fatalf("die abgelöste Anfrage: %d %q", a.Code, a.Text)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("die ältere Anfrage bleibt offen")
	}
	select {
	case a := <-andere:
		t.Fatalf("die Anfrage einer anderen Box darf davon nichts merken: %d", a.Code)
	case a := <-zweite:
		t.Fatalf("die neuere Anfrage wartet weiter: %d", a.Code)
	case <-time.After(200 * time.Millisecond):
	}
	s.mu.Lock()
	offen := len(s.wartende)
	s.mu.Unlock()
	if offen != 2 {
		t.Fatalf("%d offene Anfragen statt zwei", offen)
	}

	// Beendet die Box die Verbindung, geht nichts hinaus und nichts ins Journal.
	abbruch()
	if a := <-zweite; a.Code != 0 {
		t.Fatalf("abgebrochen: %d", a.Code)
	}
	s.Geaendert() // weckt die andere; ihre Liste ist unverändert
	s.mu.Lock()
	offen = len(s.wartende)
	s.mu.Unlock()
	if offen != 1 {
		t.Fatalf("%d offene Anfragen statt einer", offen)
	}
}

// Wer gleichzeitig fragt, teilt sich eine Lesung der Kernel-Menge.
func TestGemeinsameLesung(t *testing.T) {
	s, m, _ := neueStelle(t)
	s.Frische = 0 // Vorgabe
	s.SetzeStand(gueltig(t, key1))
	m.setze(map[abgleich.Paar]time.Duration{paar(tech1, box1): time.Hour})
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sofort(s, netip.AddrFrom4([4]byte{10, 10, 17, byte(i + 1)}))
		}(i)
	}
	wg.Wait()
	if m.lesungen != 1 {
		t.Fatalf("%d Lesungen für 50 gleichzeitige Anfragen", m.lesungen)
	}
	// Nach einem Lauf des Dienstes gilt die alte Lesung nicht mehr.
	s.Geaendert()
	sofort(s, box1)
	if m.lesungen != 2 {
		t.Fatalf("%d Lesungen nach Geaendert", m.lesungen)
	}
}

// Der Vertragsvektor der Antwort: aus dem Vektor des Soll-Stands (Fenster
// Techniker -> Box 10.10.16.2) und einer Restlaufzeit von einer Stunde.
// Dieselbe Datei kann der Test des Box-Skripts lesen.
func TestVertragsvektorDerAntwort(t *testing.T) {
	wurzel := filepath.Join("..", "..", "..", "..", "docs", "contracts")
	daten, err := os.ReadFile(filepath.Join(wurzel, "fernwartung-soll-v1.example.json"))
	if err != nil {
		t.Fatal(err)
	}
	roh, err := soll.Lies(daten)
	if err != nil {
		t.Fatal(err)
	}
	g, _, err := soll.Pruefe(roh, soll.Netze{Box: boxNetz, Techniker: techNetz})
	if err != nil || len(g.Fenster) != 1 {
		t.Fatalf("%v %+v", err, g.Fenster)
	}
	s, m, _ := neueStelle(t)
	s.SetzeStand(g)
	m.setze(map[abgleich.Paar]time.Duration{paar(g.Fenster[0].Techniker, g.Fenster[0].Box): time.Hour + 500*time.Millisecond})
	a := sofort(s, g.Fenster[0].Box)
	vektor, err := os.ReadFile(filepath.Join(wurzel, "fernwartung-schluessel-v1.example.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if a.Code != http.StatusOK || !bytes.Equal(a.Text, vektor) {
		t.Fatalf("Antwort weicht vom Vektor ab:\n%s\n---\n%s", a.Text, vektor)
	}
	zerlege(t, vektor)
	// Die leere Liste, wie sie im Vertrag steht.
	if leer := "vp-wartung-schluessel 1 99ba3c5f3272c926\nende 0\n"; string(Text(nil)) != leer {
		t.Fatalf("leere Liste: %q", Text(nil))
	}
}

func TestPruefwertHaengtNurAnDerListe(t *testing.T) {
	a := []Eintrag{{Sekunden: 3600, Zugang: "t1", Schluessel: key1}}
	b := []Eintrag{{Sekunden: 12, Zugang: "t1", Schluessel: key1}}
	if Pruefwert(a) != Pruefwert(b) {
		t.Fatal("die Restlaufzeit darf den Prüfwert nicht ändern")
	}
	for name, c := range map[string][]Eintrag{
		"anderer Schlüssel": {{Sekunden: 3600, Zugang: "t1", Schluessel: key2}},
		"anderer Zugang":    {{Sekunden: 3600, Zugang: "t2", Schluessel: key1}},
		"ein zweiter":       {{Sekunden: 3600, Zugang: "t1", Schluessel: key1}, {Sekunden: 3600, Zugang: "t2", Schluessel: key2}},
		"leer":              nil,
	} {
		if Pruefwert(c) == Pruefwert(a) {
			t.Errorf("%s: gleicher Prüfwert", name)
		}
	}
	if !PruefwertGueltig(Pruefwert(a)) || PruefwertGueltig("") || PruefwertGueltig("ABCDEF") || PruefwertGueltig("12 34") {
		t.Fatal("Form des Prüfwerts")
	}
}
