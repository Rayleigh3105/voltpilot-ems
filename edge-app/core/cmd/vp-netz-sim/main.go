// Command vp-netz-sim is a simulated grid meter for the load-management rig —
// the counterpart of cmd/vp-ocpp-sim on the OTHER side of the connection point.
//
// It publishes a plain measurement on the box's LOCAL BUS (edge/telemetry),
// which is exactly the way a Layer-1 flow reports a Netz-Zähler, so the rig
// feeds the dynamic budget through the REAL path instead of a test hook. What
// it reports is the CONNECTION POINT: the building's load plus whatever the
// charge points are drawing — because that is what a meter at the connection
// point sees, and separating the two again is the box's job (internal/lastmgmt).
//
// It exposes a tiny HTTP surface so the rig can move the building load and read
// back what it is reporting.
//
// Dev/rig tool. Never in a customer image, never on a customer device.
//
// A NEGATIVE building load is how the rig models PV: the connection point then
// EXPORTS while nothing charges, which is exactly the surplus the Stufe-4
// source lane is derived from (internal/lastmgmt/surplus.go).
//
//	vp-netz-sim --bus 127.0.0.1:1884 --status 127.0.0.1:9201 --house 20
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// chargerList is a repeatable --charger flag: the status URLs of the simulated
// charge points whose draw this meter sees.
type chargerList []string

func (c *chargerList) String() string { return strings.Join(*c, ",") }
func (c *chargerList) Set(v string) error {
	*c = append(*c, v)
	return nil
}

func main() {
	var (
		bus      = flag.String("bus", "127.0.0.1:1884", "the box's local MQTT bus")
		status   = flag.String("status", "127.0.0.1:9201", "rig control/status HTTP address")
		house    = flag.Float64("house", 20, "building load in kW (everything but the charge points)")
		charging = flag.Float64("charging", 0, "charge-point draw in kW to add on top")
		limit    = flag.Float64("grid-limit", 0, "observed §14a envelope in kW (0 = report none)")
		// ⚠ NaN, not 0: a battery power of 0 is a MEASUREMENT ("the storage is
		// taking nothing"), and the Stufe-4 surplus split needs to tell that
		// apart from "this site never reports the channel". Only an ABSENT
		// channel means unknown - the drop-don't-fabricate rule of the house.
		battery = flag.Float64("battery", math.NaN(), "measured battery power in kW (+ = charging; unset = the site does not report the channel)")
		every   = flag.Duration("interval", 2*time.Second, "how often the measurement is published")
	)
	var chargers chargerList
	flag.Var(&chargers, "charger", "status URL of a simulated charge point whose draw this meter sees (repeatable)")
	flag.Parse()

	var mu sync.Mutex
	cur := struct{ house, charging, limit, battery float64 }{*house, *charging, *limit, *battery}

	opts := mqtt.NewClientOptions().
		AddBroker("tcp://" + *bus).
		SetClientID(fmt.Sprintf("vp-netz-sim-%d", os.Getpid())).
		SetAutoReconnect(true).
		SetConnectRetry(true).
		SetConnectRetryInterval(500 * time.Millisecond)
	cli := mqtt.NewClient(opts)
	if tok := cli.Connect(); !tok.WaitTimeout(30*time.Second) || tok.Error() != nil {
		log.Fatalf("vp-netz-sim: could not reach the local bus %s: %v", *bus, tok.Error())
	}
	log.Printf("vp-netz-sim: publishing on %s every %s", *bus, *every)

	publish := func() {
		// A meter at the connection point sees the charge points too, so their
		// draw is READ rather than told: that is what makes the rig's grid
		// reading follow the box's own allocation without the rig having to
		// keep the two in sync (and it is what a real meter does).
		if len(chargers) > 0 {
			if kw, ok := readChargers(chargers); ok {
				mu.Lock()
				cur.charging = kw
				mu.Unlock()
			}
			// Unreadable: KEEP the last known draw. Reporting the building
			// alone would under-report the connection point, which is the
			// wrong direction to be wrong in.
		}
		mu.Lock()
		payload := map[string]any{
			"ts":       time.Now().UTC().Format(time.RFC3339),
			"power_kw": cur.house + cur.charging,
		}
		// ⚠ Only a REPORTED envelope: a §14a value of 0 means zero kilowatts,
		// so "no envelope" has to be an ABSENT channel, never a zero one.
		if cur.limit > 0 {
			payload["grid_limit_kw"] = cur.limit
		}
		if !math.IsNaN(cur.battery) {
			payload["battery_power_kw"] = cur.battery
		}
		mu.Unlock()
		raw, _ := json.Marshal(payload)
		cli.Publish("edge/telemetry", 1, false, raw)
	}
	publish()
	go func() {
		t := time.NewTicker(*every)
		defer t.Stop()
		for range t.C {
			publish()
		}
	}()

	mux := http.NewServeMux()

	// GET /status - what the meter is reporting.
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		out := map[string]float64{
			"house_kw": cur.house, "charging_kw": cur.charging,
			"grid_kw": cur.house + cur.charging, "grid_limit_kw": cur.limit,
			"battery_kw": cur.battery,
		}
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})

	// POST /set?house=150&charging=80&grid_limit=100 - move the site.
	mux.HandleFunc("POST /set", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if v, ok := floatParam(r, "house"); ok {
			cur.house = v
		}
		if v, ok := floatParam(r, "charging"); ok {
			cur.charging = v
		}
		if v, ok := floatParam(r, "grid_limit"); ok {
			cur.limit = v
		}
		if v, ok := floatParam(r, "battery"); ok {
			cur.battery = v
		}
		mu.Unlock()
		publish()
		w.WriteHeader(http.StatusNoContent)
	})

	srv := &http.Server{Addr: *status, Handler: mux}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("vp-netz-sim: status server: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	cli.Disconnect(200)
}

// readChargers sums what the simulated stations report drawing right now.
func readChargers(urls []string) (float64, bool) {
	cli := &http.Client{Timeout: time.Second}
	total, any := 0.0, false
	for _, u := range urls {
		resp, err := cli.Get(u)
		if err != nil {
			continue
		}
		var body struct {
			TotalKw float64 `json:"total_kw"`
		}
		err = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if err != nil {
			continue
		}
		total += body.TotalKw
		any = true
	}
	return total, any
}

func floatParam(r *http.Request, name string) (float64, bool) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}
