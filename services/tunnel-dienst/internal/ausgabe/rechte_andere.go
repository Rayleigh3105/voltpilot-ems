//go:build !linux

package ausgabe

import "errors"

// LegeRechteAb gibt es nur unter Linux; der Dienst läuft nur dort.
func LegeRechteAb() error { return errors.New("Rechte ablegen: nur unter Linux") }
