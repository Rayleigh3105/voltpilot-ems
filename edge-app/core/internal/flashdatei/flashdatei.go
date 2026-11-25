// Package flashdatei ersetzt eine Datei im Flash einer Edge-Light-Box, ohne je
// eine halbe zu hinterlassen. Loader-Pflege (agent/loader_pflege.go) und die
// Pflege der WLAN-Skripte (internal/wlanstand) schreiben beide nur hierueber:
// temporaere Datei <pfad>.neu im selben Verzeichnis (selbes Dateisystem),
// fsync, zurueckgelesen und gegen die Pruefsumme verglichen, wahlweise eine
// Pruefung der neuen Fassung (etwa `sh -n`), erst dann atomar umbenannt und
// das Verzeichnis gefsynct. Strom weg an jeder Stelle laesst die alte oder die
// neue Datei zurueck, nie eine halbe; ein liegengebliebener Rest <pfad>.neu
// wird beim naechsten Schreiben verworfen.
//
// Das Umbenennen ersetzt nur den Verzeichniseintrag: Wer die alte Datei gerade
// liest (ein laufender Loader, ein Skript mitten in einem Lauf von cron), liest
// seine alte Fassung zu Ende.
package flashdatei

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
)

// Neu ist die Endung der temporaeren Datei neben dem Ziel (dieselbe wie in
// edge-light/openwrt/install.sh).
const Neu = ".neu"

// Optionen sind die wahlweisen Schritte von Ersetzen.
type Optionen struct {
	// NachSchreiben (Testnaht, nil = echt) laeuft zwischen dem Schreiben der
	// temporaeren Datei und ihrer Pruefung - ein Test beschaedigt sie dort.
	NachSchreiben func(tmp string)
	// Pruefe (nil = keine) urteilt ueber die zurueckgelesene temporaere Datei
	// vor dem Umbenennen; ein Fehler verwirft sie, die alte Datei bleibt.
	Pruefe func(tmp string) error
}

// Ersetzen schreibt inhalt atomar nach pfad (Rechte 0755) - siehe Paket.
func Ersetzen(pfad string, inhalt []byte, opt Optionen) error {
	tmp := pfad + Neu
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
	if opt.NachSchreiben != nil {
		opt.NachSchreiben(tmp)
	}
	zurueck, err := os.ReadFile(tmp)
	if err != nil || sha256.Sum256(zurueck) != sha256.Sum256(inhalt) {
		_ = os.Remove(tmp)
		return fmt.Errorf("%s nach dem Schreiben nicht wie geschrieben (err=%v) - verworfen", tmp, err)
	}
	if opt.Pruefe != nil {
		if perr := opt.Pruefe(tmp); perr != nil {
			_ = os.Remove(tmp)
			return fmt.Errorf("%s verworfen: %w", tmp, perr)
		}
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
