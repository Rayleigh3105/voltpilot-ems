//go:build linux

package sshd

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

const ptyMoeglich = true

// mitFD ruft f mit dem Dateideskriptor, ohne die Datei aus der Hand zu geben.
// Nicht (*os.File).Fd: Das stellt die Datei auf blockierendes Lesen um, und
// dann beendet Close ein wartendes Lesen nicht mehr. Das Terminal bliebe
// offen, und die Shell bekäme beim Ende der Verbindung kein SIGHUP.
func mitFD(datei *os.File, f func(fd int) error) error {
	rc, err := datei.SyscallConn()
	if err != nil {
		return err
	}
	var ferr error
	if err := rc.Control(func(fd uintptr) { ferr = f(int(fd)) }); err != nil {
		return err
	}
	return ferr
}

// oeffnePty öffnet ein Terminal-Paar über /dev/ptmx. Zurück kommen die Seite
// des Servers, die Seite des Prozesses und ihr Name (/dev/pts/N).
func oeffnePty() (master, slave *os.File, name string, err error) {
	master, err = os.OpenFile("/dev/ptmx", os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		return nil, nil, "", err
	}
	var n int
	err = mitFD(master, func(fd int) error {
		// Freigeben (unlockpt) und die Nummer lesen (ptsname).
		if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
			return err
		}
		n, err = unix.IoctlGetInt(fd, unix.TIOCGPTN)
		return err
	})
	if err != nil {
		_ = master.Close()
		return nil, nil, "", err
	}
	name = fmt.Sprintf("/dev/pts/%d", n)
	slave, err = os.OpenFile(name, os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		_ = master.Close()
		return nil, nil, "", err
	}
	return master, slave, name, nil
}

func setzeGroesse(master *os.File, spalten, zeilen uint32) error {
	if spalten == 0 || zeilen == 0 || spalten > 0xffff || zeilen > 0xffff {
		return nil
	}
	return mitFD(master, func(fd int) error {
		return unix.IoctlSetWinsize(fd, unix.TIOCSWINSZ, &unix.Winsize{Col: uint16(spalten), Row: uint16(zeilen)})
	})
}
