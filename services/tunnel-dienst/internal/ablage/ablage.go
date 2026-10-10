// Package ablage legt die Zustandsdateien des Dienstes ab
// (/var/lib/vp-tunnel-dienst): atomar und nur für den Dienst lesbar.
package ablage

import (
	"os"
	"path/filepath"
)

// Schreibe legt eine Datei atomar ab (0600: der Soll-Stand nennt alle Peers).
// Ein leeres Verzeichnis heißt: nichts ablegen.
func Schreibe(verzeichnis, name string, daten []byte) error {
	if verzeichnis == "" {
		return nil
	}
	if err := os.MkdirAll(verzeichnis, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(verzeichnis, "."+name+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(daten); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(verzeichnis, name))
}
