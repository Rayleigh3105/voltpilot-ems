//go:build linux && (amd64 || arm64)

package ausgabe

import (
	"errors"
	"os"
	"syscall"
	"unsafe"
)

// Landlock (Linux ab 5.13): ein Prozess kann sich ohne besondere Rechte selbst
// den Zugriff auf das Dateisystem nehmen. Die Nummern gelten für amd64 und arm64.
const (
	sysLandlockCreateRuleset = 444
	sysLandlockRestrictSelf  = 446
	// alle Dateirechte der ersten Landlock-Fassung (ausführen bis Symlink anlegen)
	landlockAlleDateirechte = 1<<13 - 1
)

// SperreDateien nimmt dem Prozess jeden weiteren Zugriff auf das Dateisystem:
// eine Regelmenge über alle Dateirechte, in der nichts erlaubt ist. Offene
// Dateien und Sockets bleiben. Der Schalter läuft unter demselben Benutzer wie
// der Dienst und könnte sonst dessen Dateien lesen, darunter das Secret für
// den Abruf des Soll-Stands.
//
// Fehlt Landlock im Kernel, meldet die Funktion das; der Schalter läuft dann
// ohne diese zusätzliche Sperre und sagt es in seiner Startzeile.
func SperreDateien() error {
	regeln := struct{ dateirechte uint64 }{landlockAlleDateirechte}
	fd, _, e := syscall.Syscall(sysLandlockCreateRuleset, uintptr(unsafe.Pointer(&regeln)), unsafe.Sizeof(regeln), 0)
	if e != 0 {
		return e
	}
	defer syscall.Close(int(fd))
	if _, _, e := syscall.AllThreadsSyscall(sysLandlockRestrictSelf, fd, 0, 0); e != 0 {
		return e
	}
	// Nachsehen statt glauben.
	if f, err := os.Open("/"); err == nil {
		f.Close()
		return errors.New("Sperre gesetzt, aber / lässt sich noch öffnen")
	}
	return nil
}
