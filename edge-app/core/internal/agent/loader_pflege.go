package agent

// Edge Light: das BESTAETIGTE Programm pflegt seinen Loader (Konzept
// vp-edge-light-loader-selbstupdate). Ein Update tauscht nur das Programm;
// Fixes an boot.sh oder am Init-Skript des Dienstes erreichten eine Box bisher
// nur durch den Wartungstunnel (install.sh). Deshalb bringt das Programm beide
// eingebettet mit (internal/loaderstand) und erneuert sie im Flash selbst -
// das funktioniert auch unter einem alten Loader, der von alledem nichts weiss.
//
// Die Regeln, jede mit Test belegt (loader_pflege_test.go und die Probe
// edge-light/test/boot-update-probe.sh):
//
//  1. Nie waehrend der Probe: solange probe.json liegt, urteilt erst die
//     Wache des Loaders ueber diese Fassung. Erst die BESTAETIGTE Fassung
//     (nach "behalten" oder regulaer aus dem Flash gestartet) pflegt.
//  2. Kein Rueckschritt: eingespielt wird nur ein eingebetteter Stand, der
//     NEUER ist als die LOADER_STAND-Marke im Flash (keine Marke = 0). Ein
//     Rueckfall auf eine aeltere Programmfassung laesst den neueren Loader
//     stehen, denn deren eingebetteter Stand ist hoechstens gleich alt.
//  3. Nie ohne startfaehigen Loader: temporaere Datei im selben Verzeichnis
//     (selbes Dateisystem), fsync, zurueckgelesen und gegen die Pruefsumme
//     verglichen, erst dann atomar umbenannt, dann sync. Strom weg an jeder
//     Stelle laesst den alten oder den neuen Loader zurueck, nie einen halben.
//  4. Flash schonen: geschrieben wird nur, was sich wirklich aendert - das
//     Init-Skript nur bei anderem Inhalt, boot.sh nur bei neuerem Stand; ein
//     zweiter Start schreibt nichts mehr. Nach Fehlern hoechstens
//     loaderPflegeVersucheMax Versuche je Programmlauf.
//  5. Der laufende Dienst bleibt unberuehrt: procd liest das Init-Skript erst
//     beim naechsten Start; boot.sh wird per rename ersetzt, ein laufender
//     Loader liest seine alte Inode weiter. Der neue Stand wirkt ab dem
//     naechsten regulaeren Tausch oder Neustart.
//  6. Nur ersetzen, nie einrichten: ohne boot.sh unter Cfg.LoaderPath (kein
//     per install.sh eingerichtetes Geraet, z. B. ein Entwicklungsrechner)
//     wird nichts geschrieben.
//  7. Nur ein vom Loader gestartetes Programm pflegt: VP_OTA_RAM_DIR setzt
//     allein ein Loader, der das Update-Protokoll kennt (auch die alten vor
//     der Bedarfs-Schwelle). Ein von Hand gestartetes Programm (Labortest,
//     mango-labtest.sh: "nichts landet im Flash") und eine Box mit Stufe 1
//     fassen den Flash nie an.
//
// Die Reihenfolge traegt Regel 3 ueber beide Dateien: zuerst das Init-Skript,
// ZULETZT boot.sh - denn boot.sh traegt die Marke. Strom weg dazwischen laesst
// die alte Marke stehen, und der naechste Lauf holt beide Schreiben nach (das
// schon neue Init-Skript ist dann byte-gleich und wird uebersprungen).

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/loaderstand"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otalight"
)

const (
	// loaderPflegeErsterBlick: so lange nach dem Start wartet die erste
	// Pruefung - der Start (Enrollment, Cloud, Selbsttest-Beobachter) hat
	// Vorrang vor einem Flash-Schreiben.
	loaderPflegeErsterBlick = 30 * time.Second
	// loaderPflegeTakt: so oft wird erneut geprueft, solange eine Probe
	// laeuft oder ein Schreiben scheiterte.
	loaderPflegeTakt = 5 * time.Minute
	// loaderPflegeVersucheMax begrenzt gescheiterte Schreibversuche je
	// Programmlauf - ein dauerhaft scheiterndes Schreiben soll den Flash
	// nicht im Takt abnutzen.
	loaderPflegeVersucheMax = 3
)

// loaderPflegeState haelt den Loader-Stand im Flash fuer den Herzschlag und
// die Testnaht des Schreibwegs.
type loaderPflegeState struct {
	// stand ist die LOADER_STAND-Marke des Loaders im Flash; 0 = keine Marke
	// (alter Loader) oder noch nicht gelesen. Gelesen beim Start der
	// Pflege-Schleife, erneuert nach einem erfolgreichen Einspielen.
	stand atomic.Int64

	// nachSchreiben (Testnaht, nil = echt) laeuft zwischen dem Schreiben der
	// temporaeren Datei und ihrer Pruefung - ein Test beschaedigt sie dort.
	nachSchreiben func(tmp string)
}

// loaderStand ist der Stand des Loaders im Flash fuer den Herzschlag
// (update.geraet.loader_stand); 0 = unbekannt oder alter Loader ohne Marke.
func (a *Agent) loaderStand() int { return int(a.loaderPflege.stand.Load()) }

// loaderPflegeLoop liest den Loader-Stand fuer den Herzschlag und erneuert
// Loader und Dienst-Init genau einmal je Programmlauf, sobald keine Probe
// laeuft. Nur Edge Light; die Docker-Box hat keinen Loader.
func (a *Agent) loaderPflegeLoop(ctx context.Context, ersterBlick, takt time.Duration) {
	defer a.done.Done()
	if !a.isLight() || !a.otaLightLoaderBereit() ||
		a.Cfg.LoaderPath == "" || a.Cfg.LoaderInitPath == "" {
		return
	}
	if raw, err := os.ReadFile(a.Cfg.LoaderPath); err == nil {
		a.loaderPflege.stand.Store(int64(loaderstand.Stand(raw)))
	}
	if loaderstand.EingebetteterStand() < 1 {
		// Ohne Marke im eingebetteten Loader wuerde jede Box auf Stand 0
		// gezogen - der Test in loaderstand erzwingt die Marke, das hier ist
		// der Gurt zum Hosentraeger.
		slog.Error("Loader-Pflege: der eingebettete Loader traegt keinen Stand - nichts wird eingespielt")
		return
	}
	versuche := 0
	if !otaWait(ctx, ersterBlick) {
		return
	}
	for {
		fertig, err := a.loaderPflegen()
		if err != nil {
			versuche++
			slog.Warn("Loader-Pflege: Einspielen gescheitert", "err", err,
				"versuch", versuche, "hoechstens", loaderPflegeVersucheMax)
			if versuche >= loaderPflegeVersucheMax {
				slog.Error("Loader-Pflege: aufgegeben bis zum naechsten Programmstart")
				return
			}
		}
		if fertig {
			return
		}
		if !otaWait(ctx, takt) {
			return
		}
	}
}

// loaderPflegen prueft einmal und spielt noetigenfalls ein. fertig heisst:
// nichts mehr zu tun in diesem Programmlauf (eingespielt, aktuell, neuer als
// wir, oder kein Loader vorhanden); err verlangt einen weiteren Versuch.
func (a *Agent) loaderPflegen() (fertig bool, err error) {
	if _, serr := os.Stat(filepath.Join(a.otaRAMDir(), otalight.FileProbe)); serr == nil {
		// Eine Fassung laeuft zur Probe (wir selbst oder eine verwaiste
		// Marke) - die Pflege wartet auf das Urteil der Wache.
		return false, nil
	}
	ist := 0
	if raw, rerr := os.ReadFile(a.Cfg.LoaderPath); rerr == nil {
		ist = loaderstand.Stand(raw)
	} else {
		slog.Info("Loader-Pflege: kein Loader vorhanden - nichts einzuspielen", "pfad", a.Cfg.LoaderPath)
		return true, nil
	}
	soll := loaderstand.EingebetteterStand()
	if ist >= soll {
		if ist > soll {
			slog.Info("Loader-Pflege: der Loader im Flash ist neuer als der eingebettete - er bleibt",
				"flash", ist, "eingebettet", soll)
		}
		a.loaderPflege.stand.Store(int64(ist))
		return true, nil
	}
	// Init-Skript zuerst (nur bei anderem Inhalt), boot.sh zuletzt: boot.sh
	// traegt die Marke, ein Abbruch dazwischen laesst den Lauf wiederholen.
	initSoll := loaderstand.InitSkript()
	if initIst, rerr := os.ReadFile(a.Cfg.LoaderInitPath); rerr != nil || !bytes.Equal(initIst, initSoll) {
		if werr := a.schreibeAtomar(a.Cfg.LoaderInitPath, initSoll); werr != nil {
			return false, fmt.Errorf("Init-Skript: %w", werr)
		}
	}
	if werr := a.schreibeAtomar(a.Cfg.LoaderPath, loaderstand.BootSH()); werr != nil {
		return false, fmt.Errorf("Loader: %w", werr)
	}
	a.loaderPflege.stand.Store(int64(soll))
	slog.Info("Loader-Pflege: Loader und Dienst-Init erneuert - wirkt ab dem naechsten Start des Dienstes",
		"von", ist, "auf", soll)
	return true, nil
}

// schreibeAtomar ersetzt eine Datei, ohne je eine halbe zu hinterlassen:
// temporaere Datei im selben Verzeichnis, fsync, zuruecklesen und gegen die
// Pruefsumme vergleichen (ein beschaedigt geschriebener Stand wird verworfen),
// atomar umbenennen, Verzeichnis fsyncen. Strom weg an jeder Stelle laesst
// die alte oder die neue Datei zurueck.
func (a *Agent) schreibeAtomar(pfad string, inhalt []byte) error {
	tmp := pfad + ".neu"
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	_, werr := f.Write(inhalt)
	serr := f.Sync()
	cerr := f.Close()
	if werr != nil || serr != nil || cerr != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("schreiben nach %s: write=%v sync=%v close=%v", tmp, werr, serr, cerr)
	}
	if hook := a.loaderPflege.nachSchreiben; hook != nil {
		hook(tmp)
	}
	zurueck, err := os.ReadFile(tmp)
	if err != nil || sha256.Sum256(zurueck) != sha256.Sum256(inhalt) {
		_ = os.Remove(tmp)
		return fmt.Errorf("%s nach dem Schreiben nicht wie geschrieben (err=%v) - verworfen", tmp, err)
	}
	if err := os.Rename(tmp, pfad); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if dir, derr := os.Open(filepath.Dir(pfad)); derr == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}
