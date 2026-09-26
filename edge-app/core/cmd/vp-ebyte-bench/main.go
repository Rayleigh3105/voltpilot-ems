// vp-ebyte-bench ist das PRUEFSTANDS-Werkzeug fuer ein Ebyte-M31-I/O-Modul: es
// faehrt den Treiber der Box (internal/ebyte) direkt gegen ein echtes Geraet -
// Identitaet, alle Ein-/Ausgaenge, einzelnes Schalten, Watchdog einrichten und
// den vollstaendigen Ausgangstest (jeder Ausgang einzeln an/aus mit Ruecklesen).
//
// ⚠ Dev-/Pruefstands-Werkzeug: es gehoert in KEIN Kunden-Image. Es schaltet
// ohne Arbiter, ohne Freigabe und ohne Not-Aus - nur an einem Pruefstand ohne
// angeschlossene Last verwenden.
//
//	vp-ebyte-bench -ip 192.168.3.50 read
//	vp-ebyte-bench -ip 192.168.3.50 -mac 00:54:2c:84:9b:90 set 3 on
//	vp-ebyte-bench -ip 192.168.3.50 cycle
//	vp-ebyte-bench -ip 192.168.3.50 arm-watchdog -offline 600
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ebyte"
)

func main() {
	ip := flag.String("ip", "", "IP-Adresse des M31")
	port := flag.Int("port", ebyte.DefaultPort, "Modbus-TCP-Port")
	unit := flag.Int("unit", ebyte.DefaultUnitID, "Modbus-Unit-Id")
	mac := flag.String("mac", "", "erwartete MAC (optional)")
	offline := flag.Int("offline", ebyte.DefaultOfflineTenths, "Watchdog-Offline-Zeit in 0,1 s (arm-watchdog)")
	flag.Parse()
	if *ip == "" || flag.NArg() == 0 {
		die("Aufruf: vp-ebyte-bench -ip <adresse> read|set <kanal> on|off|cycle|arm-watchdog")
	}
	cfg := ebyte.Config{IP: *ip, Port: *port, UnitID: *unit, MAC: *mac}
	cl := ebyte.Client{}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	switch flag.Arg(0) {
	case "read":
		id, st, de := cl.Read(ctx, cfg)
		check(de)
		dump(map[string]any{"identity": id, "state": st})
	case "set":
		if flag.NArg() != 3 {
			die("set <kanal> on|off")
		}
		ch, err := strconv.Atoi(flag.Arg(1))
		if err != nil {
			die("Kanal ist keine Zahl")
		}
		_, st, de := cl.SetOutput(ctx, cfg, ch, flag.Arg(2) == "on")
		check(de)
		dump(st)
	case "cycle":
		id, de := cl.Identify(ctx, cfg)
		check(de)
		failed := 0
		for ch := 1; ch <= id.DO; ch++ {
			_, on, de := cl.SetOutput(ctx, cfg, ch, true)
			check(de)
			time.Sleep(300 * time.Millisecond)
			_, off, de := cl.SetOutput(ctx, cfg, ch, false)
			check(de)
			ok := !off.Outputs[ch-1]
			for i, v := range on.Outputs {
				ok = ok && v == (i == ch-1)
			}
			if !ok {
				failed++
			}
			fmt.Printf("DO%-3d an=%v aus=%v %s\n", ch, on.Outputs, off.Outputs, map[bool]string{true: "OK", false: "FEHLER"}[ok])
		}
		if failed > 0 {
			die(fmt.Sprintf("%d Ausgaenge fehlerhaft", failed))
		}
	case "arm-watchdog":
		_, de := cl.ArmWatchdog(ctx, cfg, ebyte.WatchdogSetup{OfflineTenths: *offline})
		check(de)
		fmt.Println("Watchdog geschrieben, Geraet startet neu")
	default:
		die("unbekannter Befehl " + flag.Arg(0))
	}
}

func check(de *ebyte.DriverError) {
	if de != nil {
		die(de.Error())
	}
}

func dump(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func die(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}
