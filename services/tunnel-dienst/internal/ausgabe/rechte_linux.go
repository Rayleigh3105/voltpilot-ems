//go:build linux

package ausgabe

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

const (
	linuxCapabilityVersion3 = 0x20080522
	prSetNoNewPrivs         = 38
	prCapAmbient            = 47
	prCapAmbientClearAll    = 4
)

type capKopf struct {
	version uint32
	pid     int32
}

type capDaten struct {
	effective, permitted, inheritable uint32
}

// LegeRechteAb nimmt dem Prozess ALLE Capabilities (wirksam, erlaubt,
// vererbbar, ambient) und verbietet ihm, je wieder welche zu bekommen. Der
// Schalter ruft das als Erstes auf, bevor er im Tunnel lauscht: Er erbt vom
// Dienst CAP_NET_ADMIN und braucht es nicht.
//
// Capabilities gehören unter Linux dem einzelnen Thread. AllThreadsSyscall
// setzt sie für alle Threads des Go-Programms; das gibt es nur in einem
// Programm ohne cgo (gebaut mit CGO_ENABLED=0, wie die README es vorgibt).
// Gelingt es nicht, startet der Schalter nicht.
func LegeRechteAb() error {
	if _, _, e := syscall.AllThreadsSyscall6(syscall.SYS_PRCTL, prCapAmbient, prCapAmbientClearAll, 0, 0, 0, 0); e != 0 &&
		e != syscall.EINVAL { // EINVAL: Kernel vor 4.3 kennt keine ambienten Rechte
		return fehlerRechte("ambiente Rechte", e)
	}
	kopf := capKopf{version: linuxCapabilityVersion3}
	var leer [2]capDaten
	if _, _, e := syscall.AllThreadsSyscall(syscall.SYS_CAPSET, uintptr(unsafe.Pointer(&kopf)),
		uintptr(unsafe.Pointer(&leer[0])), 0); e != 0 {
		return fehlerRechte("capset", e)
	}
	if _, _, e := syscall.AllThreadsSyscall6(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0, 0, 0, 0); e != 0 {
		return fehlerRechte("no_new_privs", e)
	}
	// Nachsehen statt glauben.
	kopf = capKopf{version: linuxCapabilityVersion3}
	var ist [2]capDaten
	if _, _, e := syscall.RawSyscall(syscall.SYS_CAPGET, uintptr(unsafe.Pointer(&kopf)), uintptr(unsafe.Pointer(&ist[0])), 0); e != 0 {
		return fehlerRechte("capget", e)
	}
	if ist != leer {
		return fmt.Errorf("Rechte nicht abgelegt: %+v", ist)
	}
	return nil
}

func fehlerRechte(was string, e syscall.Errno) error {
	if errors.Is(e, syscall.ENOTSUP) {
		return fmt.Errorf("Rechte ablegen (%s): dieses Programm ist mit cgo gebaut; mit CGO_ENABLED=0 bauen", was)
	}
	return fmt.Errorf("Rechte ablegen (%s): %w", was, e)
}
