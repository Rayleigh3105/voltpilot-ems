//go:build !linux

package otaupdater

import "syscall"

// FreeBytes ist die BSD-Fassung (darwin) - sie existiert nur, damit die Suite
// auch auf einem Entwicklungsrechner laeuft; das Geraet ist Linux.
//
// Auf BSD-Systemen IST `f_bsize` die fundamentale Blockgroesse, in deren
// Einheiten `f_bavail` zaehlt - hier gibt es kein `f_frsize` und auch nicht die
// Verwechslungsgefahr, die die Linux-Fassung ausdruecklich benennt.
func FreeBytes(path string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return uint64(st.Bsize) * st.Bavail, nil
}
