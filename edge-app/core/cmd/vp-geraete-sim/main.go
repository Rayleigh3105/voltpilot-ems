// vp-geraete-sim serves simulated devices for the device search on fixed
// addresses: a Shelly Pro 3, a go-e charger, a Fronius Datamanager (Solar API)
// and a SunSpec inverter (Modbus TCP). With vp-solarman-sim it gives a lab
// network to search (edge-light/docs/paritaet.md, Gerätesuche). Dev/test tool
// - never part of a customer install; its answers are no hardware evidence.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche/geraetesim"
)

func main() {
	shelly := flag.String("shelly", "", "Listen-Adresse des Shelly Pro 3 (HTTP), leer = aus")
	goe := flag.String("goe", "", "Listen-Adresse des go-e (HTTP), leer = aus")
	fronius := flag.String("fronius", "", "Listen-Adresse des Fronius Datamanager (HTTP), leer = aus")
	sunspec := flag.String("sunspec", "", "Listen-Adresse des SunSpec-Wechselrichters (Modbus TCP), leer = aus")
	flag.Parse()

	protokoll := &geraetesim.Protokoll{}
	serve := func(name, addr string, h http.Handler) {
		if addr == "" {
			return
		}
		go func() {
			log.Printf("vp-geraete-sim: %s auf %s", name, addr)
			if err := http.ListenAndServe(addr, h); err != nil {
				log.Fatalf("vp-geraete-sim: %s: %v", name, err)
			}
		}()
	}
	serve("Shelly Pro 3", *shelly, geraetesim.ShellyGen2(protokoll, "SPSW-003XE16EU", "1.4.4", 3, false, false))
	serve("go-e", *goe, geraetesim.Goe(protokoll, "204117", "go-eCharger_V4", "56.1"))
	serve("Fronius", *fronius, geraetesim.Fronius(protokoll, "31234567"))
	if *sunspec != "" {
		m, err := geraetesim.StartModbus(*sunspec)
		if err != nil {
			log.Fatalf("vp-geraete-sim: SunSpec: %v", err)
		}
		m.SunSpec(1, 40000, "Fronius", "Symo GEN24 10.0 Plus", "1.30.7-1", "34112233")
		log.Printf("vp-geraete-sim: SunSpec auf %s", m.Addr())
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	for _, e := range protokoll.Eintraege() {
		log.Printf("vp-geraete-sim: gefragt: %s", e)
	}
}
