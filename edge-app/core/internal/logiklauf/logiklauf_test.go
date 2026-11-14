package logiklauf

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
)

const beispiele = "../../../../docs/contracts/v2/steuerlogik"

const modul = "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/"

// The run must not be able to switch: its package reaches neither the
// arbiter nor a driver, nor the deployer that writes Node-RED. Its own
// imports are exactly the core, the sun and the heartbeat types; everything
// else it reaches comes through the heartbeat types and is checked against
// the forbidden list.
func TestNurLesewegeImportiert(t *testing.T) {
	deps := goListe(t, "-deps", ".")
	verboten := []string{"desired", "agent", "flowdeploy", "shelly", "ebyte", "modbustcp", "inverter",
		"csms", "localbus", "componentapply", "heizstab", "goeapi", "lastmgmt", "verbraucherregel", "layer1"}
	for _, d := range deps {
		for _, v := range verboten {
			if d == modul+v || strings.HasPrefix(d, modul+v+"/") {
				t.Errorf("logiklauf erreicht %s - ein Weg zum Schalten", d)
			}
		}
	}
	var eigene []string
	for _, imp := range goListe(t, "-f", `{{join .Imports "\n"}}`, ".") {
		if strings.HasPrefix(imp, modul) {
			eigene = append(eigene, strings.TrimPrefix(imp, modul))
		}
	}
	slices.Sort(eigene)
	if want := []string{"cloud", "logik", "sonnenstand"}; !slices.Equal(eigene, want) {
		t.Fatalf("logiklauf importiert %v, erlaubt sind nur %v", eigene, want)
	}
}

func goListe(t *testing.T, args ...string) []string {
	t.Helper()
	out, err := exec.Command("go", append([]string{"list"}, args...)...).Output()
	if err != nil {
		t.Fatalf("go list %v: %v", args, err)
	}
	return strings.Fields(string(out))
}

// --- a small plant -----------------------------------------------------------

type anlage struct {
	werte map[string]logik.EinWert
	iste  map[string]Ist
	jetzt time.Time
}

func (a *anlage) deps(dir string) Deps {
	return Deps{
		DataDir: dir,
		Quelle:  func(s string, _ time.Time) logik.EinWert { return a.werte[s] },
		Geraet:  func(id string, _ time.Time) (logik.GeraetStamm, Ist) { return logik.GeraetStamm{}, a.iste[id] },
		Jetzt:   func() time.Time { return a.jetzt },
	}
}

func zahl(v float64) logik.EinWert { return logik.EinWert{Zahl: &v} }

func an(b bool) *bool { return &b }

func auftrag(t *testing.T, name string, fassung int) Auftrag {
	t.Helper()
	roh, err := os.ReadFile(filepath.Join(beispiele, name+".logic.json"))
	if err != nil {
		t.Fatal(err)
	}
	return Auftrag{FlowID: "11111111-2222-4333-8444-555555555555", Fassung: fassung,
		Hash: "sha256:" + strings.Repeat("a", 64), Dokument: roh}
}

// lauf runs n beats, one per second, from the plant's clock on.
func lauf(lz *Laufzeit, a *anlage, n int) {
	for i := 0; i < n; i++ {
		a.jetzt = a.jetzt.Add(time.Second)
		lz.Tick(a.jetzt)
	}
}

func einziger(t *testing.T, lz *Laufzeit) cloud.LogikLauf {
	t.Helper()
	sum := lz.Summary()
	if sum == nil || len(sum.Laeufe) != 1 {
		t.Fatalf("genau ein Lauf erwartet: %+v", sum)
	}
	return sum.Laeufe[0]
}

func mittag() time.Time {
	ort, _ := time.LoadLocation(DefaultZeitzone)
	return time.Date(2026, 6, 21, 12, 0, 0, 0, ort)
}

// The heat pump example of the contract runs along: with surplus and a cold
// tank the core would recommend after its waiting time, while the old control
// keeps the contact open - the log carries both sides, the counters the
// deviation, and nothing in the run touches the device.
func TestWaermepumpeLaeuftMitUndVergleicht(t *testing.T) {
	a := &anlage{jetzt: mittag(),
		werte: map[string]logik.EinWert{"site.grid": zahl(-3), "fuehler-puffer-oben.temperature": zahl(42)},
		iste:  map[string]Ist{"waermepumpe-1": {Ein: an(false)}},
	}
	lz := New(a.deps(t.TempDir()))
	if lz.Summary() != nil {
		t.Fatal("ohne Logik kein Block im Herzschlag")
	}
	if err := lz.Angleichen([]Auftrag{auftrag(t, "waermepumpe", 1)}); err != nil {
		t.Fatal(err)
	}
	lauf(lz, a, 21*60)
	e := einziger(t, lz)
	if e.Zustand != "mitlaufend" || e.Name != "Wärmepumpe" || e.FlowVersion != 1 {
		t.Fatalf("Kopf: %+v", e)
	}
	if e.Lage == nil || e.Lage.Titel != "Speichert Sonnenstrom" {
		t.Fatalf("Lage: %+v", e.Lage)
	}
	if e.Zustaende["empfehlung"] != "on" {
		t.Fatalf("Zustände: %v", e.Zustaende)
	}
	if len(e.Unbekannt) != 0 {
		t.Fatalf("alle Eingänge frisch, unbekannt: %v", e.Unbekannt)
	}
	g := e.Geraete["wp"]
	if g.EntityID != "waermepumpe-1" || g.Wunsch == nil || g.Wunsch.Ein == nil || !*g.Wunsch.Ein ||
		g.Ist == nil || g.Ist.Ein == nil || *g.Ist.Ein {
		t.Fatalf("Gerät: %+v", g)
	}
	if g.VerglichenS != 21*60 || g.AbweichendS <= 0 || g.AbweichendS != g.LaengsteAbweichungS {
		t.Fatalf("Zähler: verglichen %d, abweichend %d, längste %d", g.VerglichenS, g.AbweichendS, g.LaengsteAbweichungS)
	}
	w := e.Wechsel[len(e.Wechsel)-1]
	if w.Was != "wunsch" || w.Geraet != "wp" || w.Neu == nil || !*w.Neu.Ein || w.Andere == nil || *w.Andere.Ein ||
		w.Lage != "Speichert Sonnenstrom" {
		t.Fatalf("letzte Zeile: %+v", w)
	}

	// The old control switches as well: an "ist" line, the run of deviation ends.
	a.iste["waermepumpe-1"] = Ist{Ein: an(true)}
	lauf(lz, a, 60)
	e = einziger(t, lz)
	w = e.Wechsel[len(e.Wechsel)-1]
	if w.Was != "ist" || !*w.Neu.Ein || !*w.Andere.Ein || w.Nr != 2 || len(e.Wechsel) != 2 {
		t.Fatalf("Zeile des Ist-Wechsels: %+v", w)
	}
	g2 := e.Geraete["wp"]
	if g2.AbweichendS != g.AbweichendS || g2.VerglichenS != g.VerglichenS+60 {
		t.Fatalf("nach dem Gleichziehen darf keine Abweichung dazukommen: %+v", g2)
	}
}

// A Fühler without a fresh value is unknown - never a guessed temperature:
// the logic shows its fault line, the heartbeat names the gap.
func TestFehlenderFuehlerIstUnbekannt(t *testing.T) {
	alt := zahl(42)
	alt.Alter = 11 * 60 // older than max_age 10 min
	for name, puffer := range map[string]logik.EinWert{"fehlt": {}, "zu alt": alt} {
		t.Run(name, func(t *testing.T) {
			a := &anlage{jetzt: mittag(),
				werte: map[string]logik.EinWert{"site.grid": zahl(-3), "fuehler-puffer-oben.temperature": puffer},
				iste:  map[string]Ist{},
			}
			lz := New(a.deps(""))
			if err := lz.Angleichen([]Auftrag{auftrag(t, "waermepumpe", 1)}); err != nil {
				t.Fatal(err)
			}
			lauf(lz, a, 5)
			e := einziger(t, lz)
			if !slices.Equal(e.Unbekannt, []string{"puffer"}) {
				t.Fatalf("unbekannt: %v", e.Unbekannt)
			}
			if e.Lage == nil || e.Lage.Titel != "Störung Fühler" {
				t.Fatalf("Lage: %+v", e.Lage)
			}
			g := e.Geraete["wp"]
			if g.Ist != nil || g.VerglichenS != 0 {
				t.Fatalf("ohne Ist kein Vergleich: %+v", g)
			}
		})
	}
}

// The sun is computed from the site location the delivery carries; without
// a location it stays unknown.
func TestSonnenstandNurMitOrt(t *testing.T) {
	a := &anlage{jetzt: mittag(), werte: map[string]logik.EinWert{}, iste: map[string]Ist{}}
	for _, mitOrt := range []bool{false, true} {
		lz := New(a.deps(""))
		auf := auftrag(t, "heizung", 1)
		if mitOrt {
			breite, laenge := 48.1, 11.6
			auf.Ort = Ort{Zeitzone: "Europe/Berlin", Breite: &breite, Laenge: &laenge}
		}
		if err := lz.Angleichen([]Auftrag{auf}); err != nil {
			t.Fatal(err)
		}
		lauf(lz, a, 2)
		if got := slices.Contains(einziger(t, lz).Unbekannt, "sonne"); got == mitOrt {
			t.Fatalf("mit Ort %v: sonne unbekannt = %v", mitOrt, got)
		}
	}
}

// An unchanged delivery keeps the run, a new version starts it over, an
// empty set stops it; a restart of the box program reads the saved run and
// applies after_restart (the recommendation is "off" after a restart).
func TestAngleichenUndNeustart(t *testing.T) {
	dir := t.TempDir()
	a := &anlage{jetzt: mittag(),
		werte: map[string]logik.EinWert{"site.grid": zahl(-3), "fuehler-puffer-oben.temperature": zahl(42)},
		iste:  map[string]Ist{"waermepumpe-1": {Ein: an(false)}},
	}
	lz := New(a.deps(dir))
	auf := auftrag(t, "waermepumpe", 1)
	if err := lz.Angleichen([]Auftrag{auf}); err != nil {
		t.Fatal(err)
	}
	lauf(lz, a, 21*60)
	seit := einziger(t, lz).Seit
	if err := lz.Angleichen([]Auftrag{auf}); err != nil {
		t.Fatal(err)
	}
	if e := einziger(t, lz); e.Seit != seit || e.Zustaende["empfehlung"] != "on" {
		t.Fatalf("unveränderte Auslieferung muss weiterlaufen: %+v", e)
	}
	lz.Stop()

	var platte struct {
		Laeufe map[string]json.RawMessage `json:"laeufe"`
	}
	roh, err := os.ReadFile(filepath.Join(dir, stateFile))
	if err != nil || json.Unmarshal(roh, &platte) != nil || len(platte.Laeufe) != 1 {
		t.Fatalf("gesicherter Lauf fehlt: %v %s", err, roh)
	}

	neu := New(a.deps(dir))
	if err := neu.Angleichen([]Auftrag{auf}); err != nil {
		t.Fatal(err)
	}
	lauf(neu, a, 1)
	if e := einziger(t, neu); e.Zustaende["empfehlung"] != "off" {
		t.Fatalf("after_restart off: %+v", e.Zustaende)
	}

	auf2 := auf
	auf2.Fassung, auf2.Hash = 2, "sha256:"+strings.Repeat("b", 64)
	if err := neu.Angleichen([]Auftrag{auf2}); err != nil {
		t.Fatal(err)
	}
	if e := einziger(t, neu); e.FlowVersion != 2 || len(e.Wechsel) != 0 {
		t.Fatalf("neue Fassung beginnt neu: %+v", e)
	}
	if err := neu.Angleichen(nil); err != nil {
		t.Fatal(err)
	}
	if neu.Summary() != nil {
		t.Fatal("leerer Satz stoppt die Logik")
	}
}

// The day counters start over at local midnight (the beat at 00:00:00 is
// the first of the new day).
func TestZaehlerBeginnenUmMitternachtNeu(t *testing.T) {
	ort, _ := time.LoadLocation(DefaultZeitzone)
	a := &anlage{jetzt: time.Date(2026, 6, 21, 23, 59, 0, 0, ort),
		werte: map[string]logik.EinWert{"site.grid": zahl(1), "fuehler-puffer-oben.temperature": zahl(42)},
		iste:  map[string]Ist{"waermepumpe-1": {Ein: an(false)}},
	}
	lz := New(a.deps(""))
	if err := lz.Angleichen([]Auftrag{auftrag(t, "waermepumpe", 1)}); err != nil {
		t.Fatal(err)
	}
	lauf(lz, a, 50)
	if e := einziger(t, lz); e.Tag != "2026-06-21" || e.Geraete["wp"].VerglichenS != 50 {
		t.Fatalf("vor Mitternacht: %+v", e)
	}
	lauf(lz, a, 30)
	e := einziger(t, lz)
	if e.Tag != "2026-06-22" || e.Geraete["wp"].VerglichenS != 21 {
		t.Fatalf("nach Mitternacht: Tag %s, verglichen %d", e.Tag, e.Geraete["wp"].VerglichenS)
	}
}

// More logics than the bound are refused as a whole.
func TestZuVieleLogiken(t *testing.T) {
	a := &anlage{jetzt: mittag()}
	lz := New(a.deps(""))
	var set []Auftrag
	for i := 0; i <= MaxLaeufe; i++ {
		auf := auftrag(t, "waermepumpe", 1)
		auf.FlowID = strings.Repeat(string(rune('a'+i)), 8)
		set = append(set, auf)
	}
	if err := lz.Angleichen(set); err == nil {
		t.Fatal("mehr als MaxLaeufe muss abgelehnt werden")
	}
}

// The heartbeat block of the heat pump example after 21 minutes of surplus
// against an open contact and one minute after the old control closed it is
// pinned as a contract fixture (examples/steuerlogik-rueckmeldung.valid.
// waermepumpe.json): the API's listener tests read it, so box and API meet on
// the same block. VP_FIXTURES_SCHREIBEN=1 rewrites it after an intended change.
func TestBeispielRueckmeldungIstGepinnt(t *testing.T) {
	a := &anlage{jetzt: time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC),
		werte: map[string]logik.EinWert{"site.grid": zahl(-3), "fuehler-puffer-oben.temperature": zahl(42)},
		iste:  map[string]Ist{"waermepumpe-1": {Ein: an(false)}},
	}
	lz := New(a.deps(""))
	auf := auftrag(t, "waermepumpe", 1)
	auf.FlowID = "5e1f0c2a-7b3d-4e8f-9a1b-2c3d4e5f6a7b"
	auf.Hash = "sha256:" + strings.Repeat("0", 64)
	if err := lz.Angleichen([]Auftrag{auf}); err != nil {
		t.Fatal(err)
	}
	lauf(lz, a, 21*60)
	a.iste["waermepumpe-1"] = Ist{Ein: an(true)}
	lauf(lz, a, 60)
	block, err := json.MarshalIndent(lz.Summary(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	block = append(block, '\n')
	pfad := filepath.Join(beispiele, "..", "examples", "steuerlogik-rueckmeldung.valid.waermepumpe.json")
	if os.Getenv("VP_FIXTURES_SCHREIBEN") == "1" {
		if err := os.WriteFile(pfad, block, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	soll, err := os.ReadFile(pfad)
	if err != nil {
		t.Fatalf("%v (VP_FIXTURES_SCHREIBEN=1 legt sie an)", err)
	}
	if string(soll) != string(block) {
		t.Fatalf("%s weicht vom Block ab (VP_FIXTURES_SCHREIBEN=1 nach gewollter Änderung):\n%s", pfad, block)
	}
}
