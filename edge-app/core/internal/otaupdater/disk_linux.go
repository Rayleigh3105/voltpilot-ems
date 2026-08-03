//go:build linux

package otaupdater

import "syscall"

// FreeBytes liefert den freien Platz des Dateisystems, auf dem `path` liegt.
//
// Der Plattenwaechter ist keine Hoeflichkeit: ein Tausch braucht Platz fuer die
// beiden NEUEN Images UND fuer die Archive des Rueckfallziels. Wer ohne diesen
// Platz startet, nimmt sich unterwegs genau die Ebene, auf die er
// zurueckfallen wollte - der Fall, in dem eine Box wirklich haengen bleibt.
//
// **⚠ Gerechnet wird mit `f_frsize`, NICHT mit `f_bsize`.** POSIX: `f_bsize`
// ist die BEVORZUGTE E/A-Blockgroesse, `f_frsize` die fundamentale - und
// `f_bavail` zaehlt in `f_frsize`-Einheiten. Auf ext4 sind beide 4096, dort
// faellt der Unterschied nie auf; auf einem virtiofs-Mount meldet `f_bsize`
// 256 KiB, und der Waechter sah 9,5 TiB statt 38 GiB freien Platz (in der
// Fehlerinjektions-Matrix genau so aufgefallen). Ein Waechter, der zu viel
// Platz sieht, ist kein Waechter.
func FreeBytes(path string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	unit := uint64(st.Frsize)
	if unit == 0 {
		unit = uint64(st.Bsize)
	}
	return unit * st.Bavail, nil
}
