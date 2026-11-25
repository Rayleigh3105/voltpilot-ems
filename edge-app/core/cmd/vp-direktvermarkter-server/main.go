// vp-direktvermarkter-server runs the direct-marketer data-mirror interface
// (edge-app/core/internal/direktvermarkter) stand-alone, for PS-D23: a
// staged luox (vp-luox-sim) reads and writes it in a container, without the
// rest of the Box's agent. Dev/test tool - the real Stage 2/4 wiring
// (composeCurtailment, the heartbeat, the Koppelbild) happens in the agent,
// not here.
//
// A tiny HTTP control API feeds the cached input values and exposes the
// resulting state, standing in for the agent's SetValues calls (Stage 1 does
// not wire a real device read into this server by design - a query here
// never triggers one, and this binary does not change that).
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
)

type valuesRequest struct {
	Werte map[string]float64 `json:"werte"`
}

type statusResponse struct {
	Zustand      string `json:"zustand"`
	VorgabePct   int    `json:"vorgabe_pct"`
	VorgabeAktiv bool   `json:"vorgabe_aktiv"`
}

func main() {
	partner := flag.String("partner", "luox", "Partner-ID aus dem Direktvermarkter-Katalog")
	modbusAddr := flag.String("modbus", ":1502", "Listen-Adresse der Modbus-Schnittstelle")
	httpAddr := flag.String("http", ":8080", "Listen-Adresse der Steuer-API (nur für diesen Testaufbau)")
	staleAfter := flag.Duration("stale-after", 30*time.Second, "wie alt ein eingespeister Messwert höchstens sein darf")
	watchdogDeadline := flag.Duration("watchdog-deadline", 0,
		"überschreibt die Lebenszeichen-Frist des Katalogs (900s) für einen schnellen Testlauf; 0 = Katalogwert")
	flag.Parse()

	profile, ok := direktvermarkter.For(*partner)
	if !ok {
		log.Fatalf("vp-direktvermarkter-server: unbekannter Partner %q", *partner)
	}
	if *watchdogDeadline > 0 {
		profile.Rules.WatchdogDeadlineS = int(watchdogDeadline.Seconds())
	}

	srv := direktvermarkter.NewServer(profile, *staleAfter, func(e direktvermarkter.Event) {
		log.Printf("vp-direktvermarkter-server: Ereignis %s um %s", e.Kind, e.At.Format(time.RFC3339))
	})
	if err := srv.Start(*modbusAddr); err != nil {
		log.Fatalf("vp-direktvermarkter-server: Modbus-Start: %v", err)
	}
	log.Printf("vp-direktvermarkter-server: Partner %s, Modbus auf %s, Steuer-API auf %s", profile.ID, srv.Addr(), *httpAddr)

	mux := http.NewServeMux()
	mux.HandleFunc("/werte", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST erwartet", http.StatusMethodNotAllowed)
			return
		}
		var req valuesRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		srv.SetValues(time.Now(), req.Werte)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/zustand", func(w http.ResponseWriter, r *http.Request) {
		pct, active := srv.Limit()
		resp := statusResponse{Zustand: srv.State(), VorgabePct: pct, VorgabeAktiv: active}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	log.Fatal(http.ListenAndServe(*httpAddr, mux))
}
