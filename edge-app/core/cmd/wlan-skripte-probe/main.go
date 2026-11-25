// wlan-skripte-probe ist NUR fuer die Labor-Pruefung des Selbstupdates der
// WLAN-Skripte (edge-light/test/wlan-anschluss-probe.sh, Lauf skripte-update):
// derselbe Lauf, den das bestaetigte Programm auf der Box macht
// (wlanstand.Pflege.Lauf, aufgerufen von agent/wlan_pflege.go), aber ohne
// Agent, Cloud und Loader - so laeuft er als kleines i686-Programm im
// OpenWrt-Emulator gegen die echten Skripte, das echte WLAN und relayd. Die
// Schranken davor (nur Edge Light, nur unter einem Update-Loader, nie in der
// Probe) belegen wlan_pflege_test.go und boot-update-probe.sh (Fall 12, mit dem
// echten Programm). Auf keiner Box installiert.
//
//	wlan-skripte-probe [<pfad von wlan-anschluss.sh>]
//
// Ausgabe: eine Zeile je Wert (vorher, nachher, geschrieben, wege,
// wege_fehler, fehler); Rueckgabe 1, wenn der Lauf scheiterte.
//
//	VP_WLAN_PROBE_HALT=<datei> VP_WLAN_PROBE_HALT_BEI=<skriptname>
//	    haelt an, sobald die temporaere Datei dieses Skripts geschrieben ist
//	    (vor der Pruefung und dem Umbenennen): legt <datei> an und schlaeft.
//	    Die Probe beendet den Prozess dort mit kill -9 - Abbruch mitten im
//	    Schreiben.
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/wlanstand"
)

func main() {
	pfad := "/usr/libexec/vp-edge-light/wlan-anschluss.sh"
	if len(os.Args) > 1 {
		pfad = os.Args[1]
	}
	p := wlanstand.Pflege{Anschluss: pfad}
	if halt, bei := os.Getenv("VP_WLAN_PROBE_HALT"), os.Getenv("VP_WLAN_PROBE_HALT_BEI"); halt != "" && bei != "" {
		p.NachSchreiben = func(tmp string) {
			if filepath.Base(tmp) != bei+".neu" {
				return
			}
			_ = os.WriteFile(halt, []byte(tmp+"\n"), 0o644)
			for {
				time.Sleep(time.Hour)
			}
		}
	}
	erg, err := p.Lauf(context.Background())
	fmt.Printf("vorher=%d\nnachher=%d\ngeschrieben=%s\nwege=%s\nwege_fehler=%s\n",
		erg.Vorher, erg.Nachher, strings.Join(erg.Geschrieben, " "), erg.Wege, erg.WegeFehler)
	if err != nil {
		fmt.Printf("fehler=%v\n", err)
		os.Exit(1)
	}
	fmt.Println("fehler=")
}
