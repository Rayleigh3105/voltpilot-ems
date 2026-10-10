package meldung

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/ausgabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/dienst"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/quelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/soll"
)

var (
	wurzel  = filepath.Join("..", "..", "..", "..", "docs", "contracts")
	netze   = soll.Netze{Box: netip.MustParsePrefix("10.10.16.0/20"), Techniker: netip.MustParsePrefix("10.10.32.0/24")}
	start   = time.Date(2026, 10, 7, 9, 15, 0, 0, time.UTC)
	box1    = netip.MustParseAddr("10.10.16.2")
	keyBox1 = "jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM="
	keyBox2 = "SBsk0U9z6BgB/U8nb+L9PdK/46p7mBvWRQe8I0Vg3C0="
)

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

// vektorLage ist der Stand des Dienstes zum Vektor des Soll-Stands: zwei
// Boxen, ein Techniker mit SSH-Schlüssel, ein Fenster in der Kernel-Menge.
func vektorLage(t *testing.T) (dienst.Lage, soll.Gueltig) {
	t.Helper()
	daten, err := os.ReadFile(filepath.Join(wurzel, "fernwartung-soll-v1.example.json"))
	if err != nil {
		t.Fatal(err)
	}
	roh, err := soll.Lies(daten)
	if err != nil {
		t.Fatal(err)
	}
	g, befunde, err := soll.Pruefe(roh, netze)
	if err != nil || len(befunde) != 0 || len(g.Fenster) != 1 {
		t.Fatalf("%v %v %+v", err, befunde, g.Fenster)
	}
	var lage dienst.Lage
	for _, key := range []string{keyBox1, keyBox2} {
		lage.Peers = append(lage.Peers, g.Peers[key])
	}
	for _, p := range g.Peers {
		if p.Art == soll.ArtTechniker {
			lage.Peers = append(lage.Peers, p)
		}
	}
	lage.Fenster = g.Fenster
	return lage, g
}

// pruefstand ist ein Melder mit gestellter Uhr, gestellten Handshakes und
// einer API, die sich jeden Rumpf merkt.
type pruefstand struct {
	m        *Melder
	uhr      time.Time
	hs       map[string]time.Time
	hsFehler error
	auskunft ausgabe.Auskunft
	rumpf    [][]byte
	antwort  error
	journal  *sicher
}

func neuerPruefstand(t *testing.T) *pruefstand {
	t.Helper()
	p := &pruefstand{uhr: start, hs: map[string]time.Time{}, journal: &sicher{},
		auskunft: ausgabe.Auskunft{Laeuft: true, Boxen: map[netip.Addr]ausgabe.BoxAuskunft{}}}
	p.m = &Melder{
		Senden: func(_ context.Context, rumpf []byte) error {
			p.rumpf = append(p.rumpf, rumpf)
			return p.antwort
		},
		Handshakes:  func(context.Context) (map[string]time.Time, error) { return p.hs, p.hsFehler },
		Auskunft:    func() ausgabe.Auskunft { return p.auskunft },
		Log:         slog.New(slog.NewTextHandler(p.journal, nil)),
		Jetzt:       func() time.Time { return p.uhr },
		GestartetUm: start,
		Intervall:   30 * time.Second,
	}
	return p
}

// lauf stellt die Uhr und ruft einmal auf.
func (p *pruefstand) lauf(um time.Time, lage dienst.Lage) {
	p.uhr = um
	p.m.Melde(context.Background(), lage, true)
}

func (p *pruefstand) letzter(t *testing.T) Bericht {
	t.Helper()
	if len(p.rumpf) == 0 {
		t.Fatal("keine Meldung gesendet")
	}
	var b Bericht
	if err := json.Unmarshal(p.rumpf[len(p.rumpf)-1], &b); err != nil {
		t.Fatal(err)
	}
	return b
}

func um(h, m, s int) time.Time { return time.Date(2026, 10, 7, h, m, s, 0, time.UTC) }

// Der Vertragsvektor der Meldung, Byte für Byte: Die erste Box war beim Start
// nicht verbunden und ist es seit 11:42:07, fragt regelmäßig und hat den
// Schlüssel des Fensters abgeholt; die zweite ist nicht verbunden.
func TestVertragsvektorDerMeldung(t *testing.T) {
	lage, g := vektorLage(t)
	p := neuerPruefstand(t)
	p.lauf(start.Add(time.Second), lage) // erste Lesung: niemand verbunden

	// Ab 11:42:07 verbunden; der Handshake erneuert sich alle zwei Minuten.
	verbunden := um(11, 42, 7)
	for jetzt := um(11, 42, 30); !jetzt.After(um(14, 0, 0)); jetzt = jetzt.Add(30 * time.Second) {
		p.hs = map[string]time.Time{keyBox1: verbunden.Add(jetzt.Sub(verbunden).Truncate(2 * time.Minute)), keyBox2: {}}
		p.lauf(jetzt, lage)
	}
	techniker := g.Peers["FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y="]
	p.auskunft.Boxen[box1] = ausgabe.BoxAuskunft{
		LetzteAnfrage: um(14, 0, 12).Add(300 * time.Millisecond),
		Bestaetigt:    map[string]map[string]time.Time{techniker.ID: {techniker.SSH.Fingerabdruck: um(13, 30, 41)}},
	}
	p.lauf(um(14, 0, 30).Add(700*time.Millisecond), lage)

	var schoen bytes.Buffer
	if err := json.Indent(&schoen, p.rumpf[len(p.rumpf)-1], "", "  "); err != nil {
		t.Fatal(err)
	}
	schoen.WriteByte('\n')
	vektor, err := os.ReadFile(filepath.Join(wurzel, "fernwartung-rueckmeldung-v1.example.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(schoen.Bytes(), vektor) {
		t.Fatalf("Meldung weicht vom Vektor ab:\n%s\n---\n%s", schoen.Bytes(), vektor)
	}
	// Der Vektor streng gelesen: ein Feld, das der Vertrag neu nennt, muss hier bekannt sein.
	dec := json.NewDecoder(bytes.NewReader(vektor))
	dec.DisallowUnknownFields()
	var b Bericht
	if err := dec.Decode(&b); err != nil {
		t.Fatal(err)
	}
}

// "Und sonst nichts": genau die vereinbarten Felder, und nichts aus dem
// Soll-Stand außer den Kennungen des Portals.
func TestMeldungNenntNurDieVereinbartenAngaben(t *testing.T) {
	lage, g := vektorLage(t)
	p := neuerPruefstand(t)
	p.hs = map[string]time.Time{keyBox1: start, keyBox2: start}
	var fingerabdruck string
	for _, peer := range g.Peers {
		if peer.Art == soll.ArtTechniker {
			fingerabdruck = peer.SSH.Fingerabdruck
			p.auskunft.Boxen[box1] = ausgabe.BoxAuskunft{LetzteAnfrage: start,
				Bestaetigt: map[string]map[string]time.Time{peer.ID: {fingerabdruck: start}}}
		}
	}
	p.lauf(start.Add(10*time.Second), lage)
	text := string(p.rumpf[0])

	var roh map[string]json.RawMessage
	if err := json.Unmarshal(p.rumpf[0], &roh); err != nil {
		t.Fatal(err)
	}
	felder := func(m map[string]json.RawMessage) string {
		var k []string
		for name := range m {
			k = append(k, name)
		}
		return strings.Join(sortiere(k), ",")
	}
	if got := felder(roh); got != "boxen,fenster,gemeldetUm,gestartetUm,schluesselausgabe,version" {
		t.Fatalf("Felder der Meldung: %s", got)
	}
	var boxen, fenster []map[string]json.RawMessage
	_ = json.Unmarshal(roh["boxen"], &boxen)
	_ = json.Unmarshal(roh["fenster"], &fenster)
	if len(boxen) != 2 || felder(boxen[0]) != "id,verbundenSeit,zuletztGefragtUm" {
		t.Fatalf("Felder einer Box: %s", roh["boxen"])
	}
	if len(fenster) != 1 || felder(fenster[0]) != "id,schluesselAbgeholtUm" {
		t.Fatalf("Felder eines Fensters: %s", roh["fenster"])
	}
	// Kein Schlüssel, kein Fingerabdruck, keine Adresse, kein Name.
	verboten := []string{"ssh-rsa", "AAAAB3NzaC1yc2E", fingerabdruck, "SHA256:", "10.10."}
	for _, peer := range g.Peers {
		verboten = append(verboten, peer.PublicKey, peer.Kennung, peer.Adresse.String())
	}
	for _, v := range verboten {
		if v != "" && strings.Contains(text, v) {
			t.Errorf("die Meldung nennt %q:\n%s", v, text)
		}
	}
	if !strings.Contains(text, `"schluesselAbgeholtUm":"2026-10-07T09:15:00Z"`) {
		t.Errorf("der abgeholte Schlüssel fehlt:\n%s", text)
	}
}

func sortiere(k []string) []string {
	for i := range k {
		for j := i + 1; j < len(k); j++ {
			if k[j] < k[i] {
				k[i], k[j] = k[j], k[i]
			}
		}
	}
	return k
}

func seit(b Bericht, i int) string {
	if b.Boxen[i].VerbundenSeit == nil {
		return "nicht verbunden"
	}
	return b.Boxen[i].VerbundenSeit.Format("15:04:05")
}

// Seit wann eine Box verbunden ist: beim Start schon verbunden heißt
// "mindestens seit dem Start", danach zählt der Handshake.
func TestVerbundenSeit(t *testing.T) {
	lage, _ := vektorLage(t)
	p := neuerPruefstand(t)

	// Erste Lesung: Box 1 hat vor einer Minute gesprochen, Box 2 vor zehn.
	p.hs = map[string]time.Time{keyBox1: start.Add(-time.Minute), keyBox2: start.Add(-10 * time.Minute)}
	p.lauf(start.Add(2*time.Second), lage)
	b := p.letzter(t)
	if seit(b, 0) != "09:15:00" || seit(b, 1) != "nicht verbunden" {
		t.Fatalf("erste Lesung: %s / %s", seit(b, 0), seit(b, 1))
	}
	if !b.Boxen[0].VerbundenSeit.Equal(b.GestartetUm) {
		t.Fatal("beim Start verbunden muss genau gestartetUm tragen (mindestens seit dem Start)")
	}

	// Box 2 verbindet sich um 09:16:10; Box 1 erneuert nur ihren Handshake.
	p.hs = map[string]time.Time{keyBox1: start.Add(time.Minute), keyBox2: um(9, 16, 10)}
	p.lauf(um(9, 16, 30), lage)
	b = p.letzter(t)
	if seit(b, 0) != "09:15:00" || seit(b, 1) != "09:16:10" {
		t.Fatalf("zweite Lesung: %s / %s", seit(b, 0), seit(b, 1))
	}

	// Box 1 verstummt. Genau drei Minuten nach dem letzten Handshake gilt sie noch als verbunden.
	p.hs[keyBox2] = um(9, 18, 10)
	p.lauf(um(9, 19, 0), lage)
	if b = p.letzter(t); seit(b, 0) != "09:15:00" {
		t.Fatalf("an der Grenze: %s", seit(b, 0))
	}
	p.lauf(um(9, 19, 30), lage)
	if b = p.letzter(t); seit(b, 0) != "nicht verbunden" || seit(b, 1) != "09:16:10" {
		t.Fatalf("nach drei Minuten ohne Handshake: %s / %s", seit(b, 0), seit(b, 1))
	}

	// Box 1 kommt zurück: seit ihrem neuen Handshake, nicht seit dem Start.
	p.hs[keyBox1] = um(9, 21, 5)
	p.lauf(um(9, 21, 30), lage)
	if b = p.letzter(t); seit(b, 0) != "09:21:05" {
		t.Fatalf("wieder verbunden: %s", seit(b, 0))
	}

	// Ein Peer ohne jeden Handshake (Null-Zeit) ist nicht verbunden.
	p.hs[keyBox2] = time.Time{}
	p.lauf(um(9, 22, 0), lage)
	if b = p.letzter(t); seit(b, 1) != "nicht verbunden" {
		t.Fatalf("ohne Handshake: %s", seit(b, 1))
	}
}

// Las der Dienst länger als drei Minuten keine Handshakes, kann er eine
// Unterbrechung übersehen haben: Dann gilt nur noch der letzte Handshake.
func TestLueckeInDerBeobachtung(t *testing.T) {
	lage, _ := vektorLage(t)
	p := neuerPruefstand(t)
	p.hs = map[string]time.Time{keyBox1: start}
	p.lauf(start.Add(time.Second), lage)
	p.hs[keyBox1] = um(9, 29, 50)
	p.lauf(um(9, 30, 0), lage)
	if b := p.letzter(t); seit(b, 0) != "09:29:50" {
		t.Fatalf("nach der Lücke: %s", seit(b, 0))
	}
}

// Kann der Dienst die Handshakes nicht lesen, geht keine Meldung hinaus:
// unbekannt ist besser als "nicht verbunden".
func TestOhneHandshakesKeineMeldung(t *testing.T) {
	lage, _ := vektorLage(t)
	p := neuerPruefstand(t)
	p.hsFehler = errors.New("wg: Operation not permitted")
	p.lauf(start.Add(time.Second), lage)
	p.lauf(start.Add(31*time.Second), lage)
	if len(p.rumpf) != 0 {
		t.Fatalf("Meldung trotz fehlender Handshakes: %s", p.rumpf[0])
	}
	if n := strings.Count(p.journal.String(), "Handshakes nicht lesbar"); n != 1 {
		t.Fatalf("Journal nennt es %d-mal:\n%s", n, p.journal.String())
	}
}

// Ohne frischen Soll-Stand kennt der Dienst die Kennungen des Portals nicht.
// Er beobachtet trotzdem, wer verbunden ist - für die erste Meldung danach.
func TestOhneSollStandKeineMeldungAberBeobachtung(t *testing.T) {
	lage, _ := vektorLage(t)
	p := neuerPruefstand(t)
	p.hs = map[string]time.Time{keyBox1: start.Add(-time.Minute)}
	p.uhr = start.Add(time.Second)
	p.m.Melde(context.Background(), dienst.Lage{}, false)
	if len(p.rumpf) != 0 {
		t.Fatal("Meldung ohne Soll-Stand")
	}
	p.hs[keyBox1] = start.Add(time.Minute)
	p.lauf(start.Add(90*time.Second), lage)
	if b := p.letzter(t); seit(b, 0) != "09:15:00" {
		t.Fatalf("Box war beim Start verbunden: %s", seit(b, 0))
	}
}

// Abgeholt ist nur der Schlüssel, der jetzt am Zugang steht. Ohne
// Schlüsselausgabe gibt es weder Anfragen noch abgeholte Schlüssel.
func TestAbgeholtGiltFuerDenSchluesselAmZugang(t *testing.T) {
	lage, g := vektorLage(t)
	var techniker soll.PeerSoll
	for _, peer := range g.Peers {
		if peer.Art == soll.ArtTechniker {
			techniker = peer
		}
	}
	p := neuerPruefstand(t)
	p.hs = map[string]time.Time{keyBox1: start}
	p.auskunft.Boxen[box1] = ausgabe.BoxAuskunft{LetzteAnfrage: start.Add(5 * time.Second),
		Bestaetigt: map[string]map[string]time.Time{techniker.ID: {"SHA256:einAndererSchluessel": start.Add(5 * time.Second)}}}
	p.lauf(start.Add(10*time.Second), lage)
	b := p.letzter(t)
	if len(b.Fenster) != 1 || b.Fenster[0].SchluesselAbgeholtUm != nil {
		t.Fatalf("ein ersetzter Schlüssel zählt als abgeholt: %+v", b.Fenster)
	}
	if b.Boxen[0].ZuletztGefragtUm == nil || !b.Boxen[0].ZuletztGefragtUm.Equal(start.Add(5*time.Second)) {
		t.Fatalf("zuletzt gefragt: %v", b.Boxen[0].ZuletztGefragtUm)
	}

	// Eine Box fragt, während die Meldung entsteht: keine Zeitangabe liegt nach gemeldetUm.
	p.auskunft.Boxen[box1] = ausgabe.BoxAuskunft{LetzteAnfrage: start.Add(42 * time.Second),
		Bestaetigt: map[string]map[string]time.Time{techniker.ID: {techniker.SSH.Fingerabdruck: start.Add(43 * time.Second)}}}
	p.lauf(start.Add(40*time.Second), lage)
	b = p.letzter(t)
	if b.Boxen[0].ZuletztGefragtUm.After(b.GemeldetUm) || b.Fenster[0].SchluesselAbgeholtUm == nil ||
		b.Fenster[0].SchluesselAbgeholtUm.After(b.GemeldetUm) {
		t.Fatalf("Zeitangabe nach gemeldetUm: %+v %+v (gemeldet %s)", b.Boxen[0], b.Fenster[0], b.GemeldetUm)
	}

	// Schlüsselausgabe aus.
	p.m.Auskunft = nil
	p.lauf(start.Add(70*time.Second), lage)
	b = p.letzter(t)
	if b.Schluesselausgabe || b.Boxen[0].ZuletztGefragtUm != nil || b.Fenster[0].SchluesselAbgeholtUm != nil {
		t.Fatalf("ohne Schlüsselausgabe: %+v", b)
	}
	if b.Boxen[0].VerbundenSeit == nil {
		t.Fatal("ohne Schlüsselausgabe meldet der Dienst weiter, wer verbunden ist")
	}
}

// Ohne Peers und Fenster steht eine leere Liste da, nie null.
func TestLeereListenSindListen(t *testing.T) {
	p := neuerPruefstand(t)
	p.lauf(start.Add(time.Second), dienst.Lage{})
	if got := string(p.rumpf[0]); !strings.Contains(got, `"boxen":[],"fenster":[]`) {
		t.Fatalf("%s", got)
	}
}

// Eine API ohne die Route (älterer Stand): eine Zeile im Journal, danach alle
// zehn Minuten ein Versuch - und sobald die API sie kennt, läuft die Meldung.
func TestApiOhneRouteFragtAlleZehnMinuten(t *testing.T) {
	lage, _ := vektorLage(t)
	p := neuerPruefstand(t)
	p.antwort = &quelle.MeldeFehler{Status: 404}
	jetzt := start
	for i := 0; i < 45; i++ { // 22 Minuten im Abstand von 30 s
		jetzt = jetzt.Add(30 * time.Second)
		p.hs = map[string]time.Time{keyBox1: jetzt}
		p.lauf(jetzt, lage)
	}
	if len(p.rumpf) != 3 {
		t.Fatalf("in 22 Minuten %d Versuche, erwartet 3 (sofort, nach 10 und nach 20 Minuten)", len(p.rumpf))
	}
	journal := p.journal.String()
	if n := strings.Count(journal, "die API kennt die Route nicht"); n != 1 {
		t.Fatalf("Journal nennt die fehlende Route %d-mal:\n%s", n, journal)
	}
	if !strings.Contains(journal, "level=INFO") || strings.Contains(journal, "level=WARN") {
		t.Fatalf("eine ältere API ist kein Fehler:\n%s", journal)
	}
	if !strings.Contains(journal, "Soll-Stand, Firewall und Schlüsselausgabe sind davon nicht berührt") {
		t.Fatalf("Journal:\n%s", journal)
	}

	// Die API ist aktualisiert: der nächste fällige Versuch kommt an.
	p.antwort = nil
	for i := 0; i < 20; i++ {
		jetzt = jetzt.Add(30 * time.Second)
		p.hs = map[string]time.Time{keyBox1: jetzt}
		p.lauf(jetzt, lage)
	}
	if !strings.Contains(p.journal.String(), `msg="Rückmeldung ans Portal angenommen" boxen=2 fenster=1`) {
		t.Fatalf("Journal:\n%s", p.journal.String())
	}
	// Danach wieder nach jedem Lauf.
	n := len(p.rumpf)
	p.lauf(jetzt.Add(30*time.Second), lage)
	p.lauf(jetzt.Add(60*time.Second), lage)
	if len(p.rumpf) != n+2 {
		t.Fatalf("nach der Annahme %d weitere Meldungen, erwartet 2", len(p.rumpf)-n)
	}
	// Die Box war bei der ersten Lesung verbunden und ist es geblieben: Die
	// Pausen der Meldung sind keine Lücke der Beobachtung.
	if b := p.letzter(t); seit(b, 0) != "09:15:00" {
		t.Fatalf("verbunden seit %s", seit(b, 0))
	}
}

// Scheitert der Aufruf, wächst der Abstand: 30 s, 1 min, 2, 4, 8, dann 10
// Minuten. Im Journal steht es einmal, und einmal, wenn es wieder geht.
func TestScheiternWaechstDenAbstand(t *testing.T) {
	lage, _ := vektorLage(t)
	p := neuerPruefstand(t)
	p.antwort = &quelle.MeldeFehler{Status: 500, Text: "Internal Server Error"}
	var versuche []time.Duration
	jetzt := start
	for i := 0; i < 140; i++ { // 35 Minuten im Abstand von 15 s
		jetzt = jetzt.Add(15 * time.Second)
		p.hs = map[string]time.Time{keyBox1: jetzt}
		vorher := len(p.rumpf)
		p.lauf(jetzt, lage)
		if len(p.rumpf) > vorher {
			versuche = append(versuche, jetzt.Sub(start))
		}
	}
	will := "[15s 45s 1m45s 3m45s 7m45s 15m45s 25m45s]"
	if got := fmt.Sprint(versuche); got != will {
		t.Fatalf("Versuche bei %s, erwartet %s", got, will)
	}
	journal := p.journal.String()
	if n := strings.Count(journal, "Rückmeldung ans Portal gescheitert"); n != 1 {
		t.Fatalf("Journal nennt das Scheitern %d-mal:\n%s", n, journal)
	}
	if !strings.Contains(journal, "level=WARN") || !strings.Contains(journal, `fehler="Rückmeldung: HTTP 500: Internal Server Error"`) {
		t.Fatalf("Journal:\n%s", journal)
	}
	p.antwort = nil
	p.lauf(start.Add(36*time.Minute), lage)
	if !strings.Contains(p.journal.String(), "Rückmeldung ans Portal angenommen") {
		t.Fatalf("Journal:\n%s", p.journal.String())
	}
	// Nach dem Erfolg beginnt der Abstand wieder von vorn.
	p.antwort = errors.New("dial tcp 192.0.2.1:443: connect: connection refused")
	p.lauf(start.Add(36*time.Minute+30*time.Second), lage)
	n := len(p.rumpf)
	p.lauf(start.Add(36*time.Minute+45*time.Second), lage)
	p.lauf(start.Add(37*time.Minute), lage)
	if len(p.rumpf) != n+1 {
		t.Fatalf("erste Pause nach neuem Scheitern: %d Versuche in 30 s, erwartet 1", len(p.rumpf)-n)
	}
	if !strings.Contains(p.journal.String(), `fehler="keine Verbindung zur API"`) {
		t.Fatalf("Journal:\n%s", p.journal.String())
	}
}

// Liegt kein Token bereit, geht nichts hinaus und nichts ins Journal: Das
// Token holt der Abruf des Soll-Stands, und der meldet sein Scheitern selbst.
func TestOhneTokenStillUndOhnePause(t *testing.T) {
	lage, _ := vektorLage(t)
	p := neuerPruefstand(t)
	p.antwort = quelle.ErrKeinToken
	p.lauf(start.Add(30*time.Second), lage)
	p.lauf(start.Add(60*time.Second), lage)
	if len(p.rumpf) != 2 || p.journal.String() != "" {
		t.Fatalf("%d Versuche, Journal:\n%s", len(p.rumpf), p.journal.String())
	}
}

// Anstossen kehrt sofort zurück, auch wenn die API nicht antwortet. Solange
// der Aufruf läuft, entfällt der nächste; die Frist beendet ihn.
func TestAnstossenWartetNichtUndLaeuftNieDoppelt(t *testing.T) {
	lage, _ := vektorLage(t)
	p := neuerPruefstand(t)
	p.m.Frist = 400 * time.Millisecond
	p.m.Jetzt = time.Now
	p.m.GestartetUm = time.Now()
	var aufrufe int
	var mu sync.Mutex
	beendet := make(chan error, 4)
	p.m.Senden = func(ctx context.Context, _ []byte) error {
		mu.Lock()
		aufrufe++
		mu.Unlock()
		<-ctx.Done() // die API antwortet nie
		beendet <- ctx.Err()
		return ctx.Err()
	}
	beginn := time.Now()
	if !p.m.Anstossen(context.Background(), lage, true) {
		t.Fatal("der erste Aufruf startet nicht")
	}
	if p.m.Anstossen(context.Background(), lage, true) {
		t.Fatal("ein zweiter Aufruf startet, während der erste läuft")
	}
	if d := time.Since(beginn); d > 100*time.Millisecond {
		t.Fatalf("Anstossen hat %s gewartet", d)
	}
	select {
	case err := <-beendet:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("beendet mit %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("die Frist beendet den Aufruf nicht")
	}
	if d := time.Since(beginn); d < 300*time.Millisecond || d > 3*time.Second {
		t.Fatalf("Aufruf endete nach %s, Frist 400 ms", d)
	}
	for ende := time.Now().Add(5 * time.Second); p.m.Laeuft(); {
		if time.Now().After(ende) {
			t.Fatal("der Aufruf gilt nach seinem Ende weiter als laufend")
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if aufrufe != 1 {
		t.Fatalf("%d Aufrufe, erwartet 1", aufrufe)
	}
	if !strings.Contains(p.journal.String(), `fehler="Frist überschritten"`) {
		t.Fatalf("Journal:\n%s", p.journal.String())
	}
}

// Ein Absturz in der Rückmeldung beendet nie den Dienst.
func TestAbsturzInDerRueckmeldungBleibtDrin(t *testing.T) {
	lage, _ := vektorLage(t)
	p := neuerPruefstand(t)
	p.m.Senden = func(context.Context, []byte) error { panic("kaputt") }
	p.m.Anstossen(context.Background(), lage, true)
	for ende := time.Now().Add(5 * time.Second); p.m.Laeuft(); {
		if time.Now().After(ende) {
			t.Fatal("der Aufruf endet nicht")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !strings.Contains(p.journal.String(), "Rückmeldung ans Portal abgebrochen") {
		t.Fatalf("Journal:\n%s", p.journal.String())
	}
	// Der nächste Aufruf läuft wieder.
	p.m.Senden = func(context.Context, []byte) error { return nil }
	if !p.m.Anstossen(context.Background(), lage, true) {
		t.Fatal("nach dem Absturz startet kein Aufruf mehr")
	}
}
