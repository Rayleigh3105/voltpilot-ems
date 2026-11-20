//go:build !linux

package sshd

import (
	"errors"
	"os"
)

// Ein Terminal gibt es nur unter Linux (die Box); auf anderen Systemen
// (Entwicklung, Tests) lehnt der Server die Anfrage ab.
const ptyMoeglich = false

func oeffnePty() (master, slave *os.File, name string, err error) {
	return nil, nil, "", errors.New("Terminal nur unter Linux")
}

func setzeGroesse(*os.File, uint32, uint32) error { return nil }
