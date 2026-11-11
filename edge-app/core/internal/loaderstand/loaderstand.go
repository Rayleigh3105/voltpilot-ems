// Package loaderstand traegt Loader (boot.sh) und Dienst-Init von Edge Light
// als eingebettete Kopien im Programm, damit Fixes an beiden jede Box ueber
// den normalen signierten Update-Weg erreichen - ohne Wartungstunnel, auch
// Boxen, deren Loader selbst nur das Programm tauscht.
//
// Das BESTAETIGTE Programm (nie eines in der Probe) vergleicht den Stand des
// Loaders im Flash mit seinem eingebetteten (agent/loader_pflege.go) und
// erneuert beide Dateien nur, wenn der eingebettete Stand NEUER ist. Der
// Stand ist die Zeile `LOADER_STAND=<n>` in boot.sh; ein Loader ohne Marke
// (alle Staende vor der Marke) zaehlt als 0. Ein Rueckfall auf eine aeltere
// Programmfassung spielt so nie einen aelteren Loader ein.
//
// Die Kopien hier muessen byte-gleich mit den Quellen unter
// edge-light/openwrt/files/ sein, und JEDE Aenderung braucht einen neuen
// Stand samt Zeile in stand-verlauf - beides erzwingt der Test dieses
// Pakets. Ohne neuen Stand erreicht eine Aenderung keine Box im Feld.
package loaderstand

import (
	_ "embed"
	"regexp"
	"strconv"
)

//go:embed boot.sh
var bootSH []byte

//go:embed vp-edge-light.init
var initSkript []byte

var standZeile = regexp.MustCompile(`(?m)^LOADER_STAND=([0-9]+)$`)

// BootSH ist der eingebettete Loader (Kopie von
// edge-light/openwrt/files/usr/libexec/vp-edge-light/boot.sh).
func BootSH() []byte { return append([]byte(nil), bootSH...) }

// InitSkript ist das eingebettete Init-Skript des Dienstes (Kopie von
// edge-light/openwrt/files/etc/init.d/vp-edge-light).
func InitSkript() []byte { return append([]byte(nil), initSkript...) }

// Stand liest die LOADER_STAND-Marke eines Loaders; 0 heisst: keine Marke
// (ein alter Loader) oder unlesbar - ein solcher Stand wird nie eingespielt.
func Stand(skript []byte) int {
	m := standZeile.FindSubmatch(skript)
	if m == nil {
		return 0
	}
	n, err := strconv.Atoi(string(m[1]))
	if err != nil || n < 1 {
		return 0
	}
	return n
}

// EingebetteterStand ist der Stand der eingebetteten Kopien.
func EingebetteterStand() int { return Stand(bootSH) }
