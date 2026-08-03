package otaapply

// Die Gruppen-Sicherung des kleinen kritischen /data-Bestandes.
//
// `/data` liegt AUSSERHALB jedes getauschten Slots (es ist ein benanntes
// Volume, die Images tragen es nicht) - ein Code-Rollback allein kann es also
// gar nicht beruehren. Was es beruehren KANN, ist ein neuer Stand, der beim
// Start eine Datei umschreibt (eine Migration, ein Format-Wechsel, ein Fehler).
// Genau dagegen wird vor dem Tausch eine Kopie gezogen.
//
// # Die eine bewusste Abweichung vom Vorentwurf
//
// Der Vorentwurf listet das Geraete-ZERTIFIKAT unter dem, was bei einem
// Rollback „restored" wird. Automatisch zurueckzuspielen ist es hier NICHT -
// und das ist eine Sicherheits-Entscheidung, keine Auslassung:
//
// Die Identitaet (device.key / device.crt / identity.json) wird waehrend des
// Betriebs LEGITIM neu bezogen. `enroll.Reconcile` uebernimmt eine geaenderte
// device_id oder einen geaenderten Broker, sobald das Portal sie meldet (siehe
// edge-app/CLAUDE.md „Cloud host is re-read on reconnect"). Faellt eine solche
// Uebernahme zufaellig in das Zeitfenster eines Updates, wuerde ein
// automatisches Zuruecksetzen genau den Identitaets-Drift wiederherstellen,
// dessen Behebung eine eigene Runde gekostet hat - das Geraet publizierte
// wieder unter einer veralteten device_id und stuende im Portal auf „wartet
// auf erste Daten".
//
// Deshalb: Identitaet wird GESICHERT (eine zerstoerte Datei ist von Hand
// wiederherstellbar, und der Betreiber sieht sie im Snapshot-Verzeichnis),
// aber nie automatisch zurueckgespielt. Zurueckgespielt wird ausschliesslich
// der vom BETREIBER eingerichtete Zustand, den ein Stand migrieren koennte und
// den niemand aus der Cloud rekonstruieren kann - Freigaben, Geraetewahl,
// Quellen, Filter-Einstellungen. Der eigentliche PRAEVENTIVE Schutz der
// Identitaet bleibt, was der Vorentwurf selbst als Zielbild nennt: sie
// schreibgeschuetzt einzuhaengen.

import (
	"io"
	"os"
	"path/filepath"
)

// SnapshotFiles ist der kleine kritische Bestand: er wird vor jedem Tausch
// kopiert.
//
// Bewusst eine LISTE und kein Verzeichnis-Durchlauf: der Puffer
// (store-and-forward, potenziell hunderte MB) und die Protokolldateien dieses
// Pakets gehoeren NICHT hinein - eine Sicherung, die die Platte fuellt, nimmt
// dem Tausch genau den Platz, den sein Rueckfallziel braucht.
var SnapshotFiles = []string{
	// Identitaet - gesichert, aber NICHT automatisch zurueckgespielt.
	"device.key",
	"device.crt",
	"identity.json",
	// Vom Betreiber eingerichteter Zustand - gesichert UND zurueckgespielt.
	"calibration-certified.json",
	"curtail-certified.json",
	"inverter.json",
	"sources.json",
	"balance.json",
	"despike.json",
	"mirror.json",
	"config.json",
}

// RestoreFiles ist die Teilmenge, die ein Rueckfall wirklich zuruecksetzt
// (siehe die Paket-Erlaeuterung oben zur Identitaet).
var RestoreFiles = []string{
	"calibration-certified.json",
	"curtail-certified.json",
	"inverter.json",
	"sources.json",
	"balance.json",
	"despike.json",
	"mirror.json",
	"config.json",
}

// SnapshotDir ist das Zielverzeichnis der Gruppen-Sicherung.
func SnapshotDir(dataDir string) string { return filepath.Join(Dir(dataDir), SubdirSnapshot) }

// Snapshot zieht die Kopie. Eine fehlende Quelldatei ist KEIN Fehler (nicht
// jede Box hat eine Kalibrier-Freigabe) - sie fehlt dann auch in der Kopie,
// und ein Rueckfall wuerde sie folgerichtig nicht anlegen.
func Snapshot(dataDir string) error {
	dst := SnapshotDir(dataDir)
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	if err := os.MkdirAll(dst, 0o700); err != nil {
		return err
	}
	for _, name := range SnapshotFiles {
		src := filepath.Join(dataDir, name)
		if _, err := os.Stat(src); err != nil {
			continue
		}
		if err := copyFile(src, filepath.Join(dst, name)); err != nil {
			return err
		}
	}
	return nil
}

// RestoreSnapshot spielt die Teilmenge [RestoreFiles] zurueck und nennt, was
// wirklich zurueckgesetzt wurde.
//
// Nur bei UNTERSCHIED: eine unveraenderte Datei wird nicht angefasst, damit
// die Meldung „X wurde zurueckgesetzt" eine echte Aussage ist und nicht eine
// Liste aller Dateien, die es gibt.
func RestoreSnapshot(dataDir string) ([]string, error) {
	src := SnapshotDir(dataDir)
	var restored []string
	for _, name := range RestoreFiles {
		from := filepath.Join(src, name)
		want, err := os.ReadFile(from)
		if err != nil {
			continue
		}
		to := filepath.Join(dataDir, name)
		if have, err := os.ReadFile(to); err == nil && string(have) == string(want) {
			continue
		}
		if err := copyFile(from, to); err != nil {
			return restored, err
		}
		restored = append(restored, name)
	}
	return restored, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	fi, err := in.Stat()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fi.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}
