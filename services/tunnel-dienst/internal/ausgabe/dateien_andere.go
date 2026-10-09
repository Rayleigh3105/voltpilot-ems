//go:build !(linux && (amd64 || arm64))

package ausgabe

import "errors"

// SperreDateien gibt es nur unter Linux auf amd64 und arm64.
func SperreDateien() error { return errors.New("auf dieser Plattform nicht eingebaut") }
