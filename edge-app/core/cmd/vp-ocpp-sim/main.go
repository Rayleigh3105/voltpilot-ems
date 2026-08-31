// Command vp-ocpp-sim is a simulated OCPP 1.6J charge point for the load-
// management rig — the counterpart of cmd/vp-consumer-sim.
//
// It is a REAL charge point on the wire: it dials the box's CSMS over an
// actual websocket, boots, opens transactions, reports meter values, and
// stores the charging profiles it is told to store. Its simulated draw obeys
// those profiles (internal/ocppsim), which is what makes "the budget is held"
// provable at a MEASUREMENT instead of at an acknowledgement.
//
// It exposes a tiny HTTP surface so the rig can plug a vehicle in, unplug it
// and read what the station is drawing — the rig's assertion point.
//
// Dev/rig tool. Never in a customer image, never on a customer device.
//
//	vp-ocpp-sim --csms ws://127.0.0.1:8887/ocpp --id SAEULE-1 \
//	            --connectors 2 --status 127.0.0.1:9101
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	ocppcore "github.com/lorenzodonini/ocpp-go/ocpp1.6/core"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
)

func main() {
	var (
		csmsURL    = flag.String("csms", "ws://127.0.0.1:8887/ocpp", "base CSMS endpoint (the station's own id is appended)")
		id         = flag.String("id", "SAEULE-1", "OCPP ChargePointId - the station's identity")
		connectors = flag.Int("connectors", 2, "number of plugs")
		status     = flag.String("status", "127.0.0.1:9101", "rig control/status HTTP address")
		vendor     = flag.String("vendor", "RigVendor", "self-reported vendor (display only, never branched on)")
		model      = flag.String("model", "RigStation", "self-reported model (display only)")
		firmware   = flag.String("firmware", "0.0.0-rig", "self-reported firmware (display only)")
		ampsOnly   = flag.Bool("amps-only", false, "report that only ampere limits are accepted")
		rejectFull = flag.Bool("reject-full-configuration", false,
			"reject empty-key/full GetConfiguration while accepting targeted reads")
		meterEvery = flag.Duration("meter-interval", 2*time.Second, "how often meter values are published")
	)
	flag.Parse()

	st := ocppsim.New(ocppsim.Config{
		ID: *id, Connectors: *connectors,
		Vendor: *vendor, Model: *model, Firmware: *firmware,
		AmpsOnly: *ampsOnly, RejectFullConfiguration: *rejectFull,
		MeterInterval: *meterEvery,
	})

	// Retry the dial: the rig starts stations and the box in whatever order,
	// and a station that gives up on the first refused connection would make
	// the rig order-dependent for no reason.
	var lastErr error
	for i := 0; i < 100; i++ {
		if lastErr = st.Connect(*csmsURL); lastErr == nil {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if lastErr != nil {
		log.Fatalf("vp-ocpp-sim %s: could not reach %s: %v", *id, *csmsURL, lastErr)
	}
	log.Printf("vp-ocpp-sim %s: connected to %s (%d connectors)", *id, *csmsURL, *connectors)

	go func() {
		t := time.NewTicker(*meterEvery)
		defer t.Stop()
		for range t.C {
			if err := st.PublishMeterValues(); err != nil {
				log.Printf("vp-ocpp-sim %s: meter values: %v", *id, err)
			}
		}
	}()

	mux := http.NewServeMux()

	// GET /status - what the station is doing. `draw_kw` is the number the rig
	// asserts on: it is derived from the charging profiles the box actually
	// installed, so it is a measurement and not a claim.
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		type con struct {
			ID     int     `json:"id"`
			DrawKw float64 `json:"draw_kw"`
		}
		out := struct {
			ID       string            `json:"id"`
			TotalKw  float64           `json:"total_kw"`
			Cons     []con             `json:"connectors"`
			Profiles []ocppsim.Profile `json:"profiles"`
		}{ID: *id, TotalKw: st.TotalDrawKw(), Profiles: st.Profiles()}
		for c := 1; c <= *connectors; c++ {
			out.Cons = append(out.Cons, con{ID: c, DrawKw: st.DrawKw(c)})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})

	// POST /plug?connector=1&demand=240&min=5[&tag=KARTE-A] - a vehicle arrives.
	// `tag` is the CARD it presents (P7); omitted keeps the rig's one card.
	mux.HandleFunc("POST /plug", func(w http.ResponseWriter, r *http.Request) {
		c := intParam(r, "connector", 1)
		v := ocppsim.Vehicle{
			DemandKw: floatParam(r, "demand", 240),
			MinKw:    floatParam(r, "min", 0),
			IdTag:    r.URL.Query().Get("tag"),
		}
		if err := st.Plug(c, v); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	// POST /unplug?connector=1 - it leaves.
	mux.HandleFunc("POST /unplug", func(w http.ResponseWriter, r *http.Request) {
		if err := st.Unplug(intParam(r, "connector", 1)); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	// POST /status?connector=1&status=SuspendedEVSE&error=NoError - der Rig-Haken
	// für die Zustandswörter, die ein Ein-/Ausstecken nicht erzeugt
	// (`SuspendedEVSE`, `SuspendedEV`, `Finishing`, `Faulted`, `Reserved`, …).
	// Er MELDET nur; der Wagen zieht weiter, was die Profile erlauben.
	mux.HandleFunc("POST /status", func(w http.ResponseWriter, r *http.Request) {
		want := r.URL.Query().Get("status")
		if want == "" {
			http.Error(w, "status fehlt", http.StatusBadRequest)
			return
		}
		err := st.ReportStatus(intParam(r, "connector", 1),
			ocppcore.ChargePointStatus(want),
			ocppcore.ChargePointErrorCode(r.URL.Query().Get("error")))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	srv := &http.Server{Addr: *status, Handler: mux}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("vp-ocpp-sim %s: status server: %v", *id, err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	st.Stop()
	fmt.Fprintln(os.Stderr, "vp-ocpp-sim "+*id+": stopped")
}

func intParam(r *http.Request, key string, def int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func floatParam(r *http.Request, key string, def float64) float64 {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			return n
		}
	}
	return def
}
