// vp-solarman-sim is a Solarman V5 datalogger simulator serving a believable
// Deye hybrid_3p (LV) register picture. Dev/test tool for Edge Light
// (edge-light/scripts/qemu-smoke.sh) - never part of a customer install.
package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5/v5sim"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8899", "Listen-Adresse")
	serial := flag.Uint("serial", 2985159064, "Logger-Seriennummer")
	flag.Parse()

	sim, err := v5sim.Start(*addr, uint32(*serial))
	if err != nil {
		log.Fatalf("vp-solarman-sim: %v", err)
	}
	// PV 2,2 kW, Last 1,8 kW, Einspeisung 2,3 kW, Batterie -1,5 kW, SoC 57 %.
	sim.Set(map[uint16]uint16{
		0x0000: 0x0005,
		0x024b: 5230, 0x024c: 57, 0x024e: 0xfa24,
		0x026b: 0xf704, 0x02c4: 0xffff,
		0x028d: 1800, 0x02a0: 1000, 0x02a1: 1200,
	})
	log.Printf("vp-solarman-sim: Deye hybrid_3p auf %s (Seriennummer %d)", sim.Addr(), *serial)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	_ = sim.Close()
}
