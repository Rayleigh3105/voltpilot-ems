package agent

// Die Pflege von Loader und Dienst-Init durch das bestaetigte Programm
// (loader_pflege.go). Jede Pflicht-Invariante des Konzepts
// vp-edge-light-loader-selbstupdate steht hier als eigener Fall; die Probe im
// echten OpenWrt-Rootfs (edge-light/test/boot-update-probe.sh) faehrt den
// Weg zusaetzlich mit dem echten Programm.

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraet"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/loaderstand"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otalight"
)

// alterLoader ist ein Loader OHNE LOADER_STAND-Marke, wie er heute auf den
// Mangos im Feld liegt.
const alterLoader = "#!/bin/sh\n# alter Loader ohne Marke\nexec /tmp/vp-edge-light\n"

func lightPflegeBox(t *testing.T) *Agent {
	t.Helper()
	dir := t.TempDir()
	cfg := config.Defaults()
	cfg.BoxArt = geraetesuche.BoxArtEdgeLight
	cfg.DataDir = filepath.Join(dir, "data")
	cfg.OtaRAMDir = filepath.Join(dir, "ram")
	cfg.LoaderPath = filepath.Join(dir, "flash", "boot.sh")
	cfg.LoaderInitPath = filepath.Join(dir, "flash", "init-vp-edge-light")
	for _, d := range []string{cfg.DataDir, cfg.OtaRAMDir, filepath.Dir(cfg.LoaderPath)} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return &Agent{Cfg: cfg}
}

func schreibe(t *testing.T, pfad, inhalt string) {
	t.Helper()
	if err := os.WriteFile(pfad, []byte(inhalt), 0o755); err != nil {
		t.Fatal(err)
	}
}

func mtime(t *testing.T, pfad string) time.Time {
	t.Helper()
	fi, err := os.Stat(pfad)
	if err != nil {
		t.Fatal(err)
	}
	return fi.ModTime()
}

// Alter Loader (keine Marke) + bestaetigtes Programm: beide Dateien werden
// durch die eingebetteten Kopien ersetzt, der Stand steht im Herzschlag; ein
// zweiter Lauf schreibt nichts mehr (Flash schonen).
func TestEdgeLightLoaderPflegeErneuertAltenLoader(t *testing.T) {
	a := lightPflegeBox(t)
	schreibe(t, a.Cfg.LoaderPath, alterLoader)
	schreibe(t, a.Cfg.LoaderInitPath, "#!/bin/sh /etc/rc.common\n# alt\n")
	// Ein liegengebliebener halber Schreibversuch (Strom weg) stoert nicht.
	schreibe(t, a.Cfg.LoaderPath+".neu", "halb geschrie")

	fertig, err := a.loaderPflegen()
	if err != nil || !fertig {
		t.Fatalf("fertig=%v err=%v", fertig, err)
	}
	loader, _ := os.ReadFile(a.Cfg.LoaderPath)
	if !bytes.Equal(loader, loaderstand.BootSH()) {
		t.Fatal("boot.sh ist nicht die eingebettete Kopie")
	}
	initSkript, _ := os.ReadFile(a.Cfg.LoaderInitPath)
	if !bytes.Equal(initSkript, loaderstand.InitSkript()) {
		t.Fatal("das Init-Skript ist nicht die eingebettete Kopie")
	}
	if _, err := os.Stat(a.Cfg.LoaderPath + ".neu"); !os.IsNotExist(err) {
		t.Fatal("die temporaere Datei blieb liegen")
	}
	if a.loaderStand() != loaderstand.EingebetteterStand() {
		t.Fatalf("Herzschlag-Stand %d, erwartet %d", a.loaderStand(), loaderstand.EingebetteterStand())
	}

	// Zweiter Lauf: nichts wird geschrieben.
	vorLoader, vorInit := mtime(t, a.Cfg.LoaderPath), mtime(t, a.Cfg.LoaderInitPath)
	time.Sleep(10 * time.Millisecond)
	fertig, err = a.loaderPflegen()
	if err != nil || !fertig {
		t.Fatalf("zweiter Lauf: fertig=%v err=%v", fertig, err)
	}
	if !mtime(t, a.Cfg.LoaderPath).Equal(vorLoader) || !mtime(t, a.Cfg.LoaderInitPath).Equal(vorInit) {
		t.Fatal("der zweite Lauf hat erneut geschrieben")
	}
}

// Nie waehrend der Probe: solange probe.json liegt, wird nichts eingespielt -
// erst danach. Der Herzschlag traegt bis dahin den alten Stand.
func TestEdgeLightLoaderPflegeWartetAufDasProbenEnde(t *testing.T) {
	a := lightPflegeBox(t)
	schreibe(t, a.Cfg.LoaderPath, alterLoader)
	schreibe(t, a.Cfg.LoaderInitPath, string(loaderstand.InitSkript()))
	schreibe(t, filepath.Join(a.Cfg.OtaRAMDir, otalight.FileProbe),
		`{"release":"edge-light-2026.11.2","release_seq":42,"zuweisung":"z-1"}`)

	fertig, err := a.loaderPflegen()
	if err != nil || fertig {
		t.Fatalf("waehrend der Probe: fertig=%v err=%v", fertig, err)
	}
	if raw, _ := os.ReadFile(a.Cfg.LoaderPath); string(raw) != alterLoader {
		t.Fatal("waehrend der Probe wurde der Loader angefasst")
	}

	if err := os.Remove(filepath.Join(a.Cfg.OtaRAMDir, otalight.FileProbe)); err != nil {
		t.Fatal(err)
	}
	fertig, err = a.loaderPflegen()
	if err != nil || !fertig {
		t.Fatalf("nach der Probe: fertig=%v err=%v", fertig, err)
	}
	if raw, _ := os.ReadFile(a.Cfg.LoaderPath); !bytes.Equal(raw, loaderstand.BootSH()) {
		t.Fatal("nach der Probe wurde der Loader nicht erneuert")
	}
}

// Kein Rueckschritt: ein Loader mit NEUEREM Stand im Flash (Rueckfall auf eine
// aeltere Programmfassung) bleibt stehen; der Herzschlag nennt den Stand aus
// dem Flash. Gleicher Stand schreibt ebenfalls nichts.
func TestEdgeLightLoaderPflegeSpieltNieEinenAelterenEin(t *testing.T) {
	a := lightPflegeBox(t)
	neuer := "#!/bin/sh\nLOADER_STAND=99999\n# aus einer neueren Programmfassung\n"
	schreibe(t, a.Cfg.LoaderPath, neuer)
	altesInit := "#!/bin/sh /etc/rc.common\n# gehoert zu Stand 99999\n"
	schreibe(t, a.Cfg.LoaderInitPath, altesInit)

	fertig, err := a.loaderPflegen()
	if err != nil || !fertig {
		t.Fatalf("fertig=%v err=%v", fertig, err)
	}
	if raw, _ := os.ReadFile(a.Cfg.LoaderPath); string(raw) != neuer {
		t.Fatal("der neuere Loader wurde ueberschrieben (Rueckschritt)")
	}
	if raw, _ := os.ReadFile(a.Cfg.LoaderInitPath); string(raw) != altesInit {
		t.Fatal("das Init-Skript des neueren Standes wurde ueberschrieben")
	}
	if a.loaderStand() != 99999 {
		t.Fatalf("Herzschlag-Stand %d, erwartet 99999", a.loaderStand())
	}

	// Gleicher Stand: ebenfalls kein Schreiben.
	b := lightPflegeBox(t)
	schreibe(t, b.Cfg.LoaderPath, string(loaderstand.BootSH()))
	schreibe(t, b.Cfg.LoaderInitPath, string(loaderstand.InitSkript()))
	vor := mtime(t, b.Cfg.LoaderPath)
	time.Sleep(10 * time.Millisecond)
	if fertig, err := b.loaderPflegen(); err != nil || !fertig {
		t.Fatalf("gleicher Stand: fertig=%v err=%v", fertig, err)
	}
	if !mtime(t, b.Cfg.LoaderPath).Equal(vor) {
		t.Fatal("gleicher Stand wurde erneut geschrieben")
	}
}

// Nur ein vom Loader gestartetes Programm pflegt: ohne VP_OTA_RAM_DIR (von
// Hand gestartet wie der Labortest, oder Stufe 1) endet die Schleife sofort -
// "nichts landet im Flash" (mango-labtest.sh) bleibt wahr.
func TestEdgeLightLoaderPflegeNurUnterEinemUpdateLoader(t *testing.T) {
	a := lightPflegeBox(t)
	a.Cfg.OtaRAMDir = ""
	schreibe(t, a.Cfg.LoaderPath, alterLoader)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a.done.Add(1)
	a.loaderPflegeLoop(ctx, time.Millisecond, time.Millisecond)
	if raw, _ := os.ReadFile(a.Cfg.LoaderPath); string(raw) != alterLoader {
		t.Fatal("ein von Hand gestartetes Programm hat den Loader angefasst")
	}
}

// Nur ersetzen, nie einrichten: ohne Loader im Flash (Entwicklungsrechner,
// Docker-Box-Verzeichnis) wird nichts geschrieben.
func TestEdgeLightLoaderPflegeLegtNieEinenNeuenAn(t *testing.T) {
	a := lightPflegeBox(t)
	fertig, err := a.loaderPflegen()
	if err != nil || !fertig {
		t.Fatalf("fertig=%v err=%v", fertig, err)
	}
	if _, err := os.Stat(a.Cfg.LoaderPath); !os.IsNotExist(err) {
		t.Fatal("ohne vorhandenen Loader wurde einer angelegt")
	}
	if _, err := os.Stat(a.Cfg.LoaderInitPath); !os.IsNotExist(err) {
		t.Fatal("ohne vorhandenen Loader wurde ein Init-Skript angelegt")
	}
}

// Ein beschaedigt geschriebener Stand wird verworfen: die Pruefung nach dem
// Schreiben schlaegt fehl, der alte Loader bleibt unversehrt, die temporaere
// Datei verschwindet - und die Schleife gibt nach hoechstens
// loaderPflegeVersucheMax Versuchen auf (Flash schonen).
func TestEdgeLightLoaderPflegeVerwirftBeschaedigtesGeschriebenes(t *testing.T) {
	a := lightPflegeBox(t)
	schreibe(t, a.Cfg.LoaderPath, alterLoader)
	schreibe(t, a.Cfg.LoaderInitPath, string(loaderstand.InitSkript()))
	stoerungen := 0
	a.loaderPflege.nachSchreiben = func(tmp string) {
		stoerungen++
		if err := os.WriteFile(tmp, []byte("beschaedigt"), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a.done.Add(1)
	a.loaderPflegeLoop(ctx, time.Millisecond, time.Millisecond)

	if stoerungen != loaderPflegeVersucheMax {
		t.Fatalf("%d Schreibversuche, erwartet %d", stoerungen, loaderPflegeVersucheMax)
	}
	if raw, _ := os.ReadFile(a.Cfg.LoaderPath); string(raw) != alterLoader {
		t.Fatal("der alte Loader ist nicht mehr unversehrt")
	}
	if _, err := os.Stat(a.Cfg.LoaderPath + ".neu"); !os.IsNotExist(err) {
		t.Fatal("die beschaedigte temporaere Datei blieb liegen")
	}
}

// Das Init-Skript wird nur bei anderem Inhalt geschrieben; ein fehlendes wird
// zum Stand passend ergaenzt.
func TestEdgeLightLoaderPflegeErgaenztFehlendesInitSkript(t *testing.T) {
	a := lightPflegeBox(t)
	schreibe(t, a.Cfg.LoaderPath, alterLoader)
	if fertig, err := a.loaderPflegen(); err != nil || !fertig {
		t.Fatalf("fertig=%v err=%v", fertig, err)
	}
	raw, err := os.ReadFile(a.Cfg.LoaderInitPath)
	if err != nil || !bytes.Equal(raw, loaderstand.InitSkript()) {
		t.Fatalf("das fehlende Init-Skript wurde nicht ergaenzt (err=%v)", err)
	}
}

// Der Herzschlag traegt den Stand: update.geraet.loader_stand kommt aus der
// Marke im Flash, die Docker-Box und ein Loader ohne Marke senden nichts.
func TestEdgeLightLoaderStandImHerzschlag(t *testing.T) {
	a := lightPflegeBox(t)
	a.SetGeraet(geraet.Erkannt{Modell: "GL.iNet GL-MT300N-V2", Arch: "mipsle"})
	if s := a.geraetSummary(); s.LoaderStand != 0 {
		t.Fatalf("ohne gelesene Marke: loader_stand %d, erwartet 0", s.LoaderStand)
	}
	schreibe(t, a.Cfg.LoaderPath, string(loaderstand.BootSH()))
	schreibe(t, a.Cfg.LoaderInitPath, string(loaderstand.InitSkript()))
	if fertig, err := a.loaderPflegen(); err != nil || !fertig {
		t.Fatalf("fertig=%v err=%v", fertig, err)
	}
	if s := a.geraetSummary(); s.LoaderStand != loaderstand.EingebetteterStand() {
		t.Fatalf("loader_stand %d, erwartet %d", s.LoaderStand, loaderstand.EingebetteterStand())
	}

	docker := &Agent{Cfg: config.Defaults()}
	docker.SetGeraet(geraet.Erkannt{Modell: "PC", Arch: "amd64"})
	if s := docker.geraetSummary(); s.LoaderStand != 0 || s.Loader != "" {
		t.Fatalf("Docker-Box meldet loader=%q loader_stand=%d", s.Loader, s.LoaderStand)
	}
}
