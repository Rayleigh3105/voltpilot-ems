// vp-consumer-sim is the generic consumer simulator of the v2 rig
// (docs/verbrauchssteuerung.md §23; model: internal/consumersim). It joins the
// CORE'S LOCAL BUS as a Layer-1 driver stand-in for ONE consumer entity:
//
//   - consumes the core-owned retained edge/entities/{id}/command,
//   - applies it to its simulated device (on/off, stepped, continuous,
//     power_ranges_kw, availability),
//   - answers with edge/entities/{id}/readback (the v1 all_match shape),
//   - publishes periodic edge/entities/{id}/telemetry (power_kw + the
//     availability channel),
//   - listens on edge/entities/{id}/sim/availability (rig-only) so scenarios
//     can plug/unplug the simulated vehicle.
//
// Dev/rig tool only - never part of a customer image.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/consumersim"
)

func main() {
	var (
		bus       = flag.String("bus", "tcp://127.0.0.1:1884", "core local bus URL")
		entity    = flag.String("entity", "", "entity id (required)")
		preset    = flag.String("preset", "heating-rod", "wallbox|heating-rod|pump|stepped-rod")
		rated     = flag.Float64("rated-kw", 0, "override rated power")
		ranges    = flag.String("ranges", "", "override power ranges, e.g. 1.4:3.7,4.2:11")
		levels    = flag.String("levels", "", "override stepped levels, e.g. 0,1.5,3.0")
		kind      = flag.String("kind", "", "override control kind (on_off|stepped|continuous)")
		available = flag.Bool("available", true, "initial availability")
		interval  = flag.Duration("telemetry-interval", 5*time.Second, "telemetry cadence")
	)
	flag.Parse()
	if *entity == "" {
		fmt.Fprintln(os.Stderr, "--entity is required")
		os.Exit(2)
	}

	cfg, err := consumersim.Preset(*preset)
	if err != nil {
		log.Fatal(err)
	}
	cfg.EntityID = *entity
	if *rated > 0 {
		cfg.RatedKw = *rated
	}
	if *kind != "" {
		cfg.ControlKind = *kind
	}
	if *ranges != "" {
		cfg.PowerRangesKw = nil
		for _, part := range strings.Split(*ranges, ",") {
			lohi := strings.SplitN(part, ":", 2)
			if len(lohi) != 2 {
				log.Fatalf("bad --ranges entry %q", part)
			}
			lo, err1 := strconv.ParseFloat(lohi[0], 64)
			hi, err2 := strconv.ParseFloat(lohi[1], 64)
			if err1 != nil || err2 != nil {
				log.Fatalf("bad --ranges entry %q", part)
			}
			cfg.PowerRangesKw = append(cfg.PowerRangesKw, [2]float64{lo, hi})
		}
	}
	if *levels != "" {
		cfg.LevelsKw = nil
		for _, part := range strings.Split(*levels, ",") {
			v, err := strconv.ParseFloat(part, 64)
			if err != nil {
				log.Fatalf("bad --levels entry %q", part)
			}
			cfg.LevelsKw = append(cfg.LevelsKw, v)
		}
	}

	dev := consumersim.New(cfg)
	dev.SetAvailable(*available)

	opts := mqtt.NewClientOptions().
		AddBroker(*bus).
		SetClientID("vp-consumer-sim-" + *entity).
		SetAutoReconnect(true).
		SetConnectRetry(true).
		SetConnectRetryInterval(2 * time.Second)
	client := mqtt.NewClient(opts)
	if tok := client.Connect(); !tok.WaitTimeout(30*time.Second) || tok.Error() != nil {
		log.Fatalf("bus connect failed: %v", tok.Error())
	}
	log.Printf("consumer-sim %s (%s) on %s", *entity, cfg.ControlKind, *bus)

	cmdTopic := "edge/entities/" + *entity + "/command"
	readbackTopic := "edge/entities/" + *entity + "/readback"
	telemetryTopic := "edge/entities/" + *entity + "/telemetry"
	availTopic := "edge/entities/" + *entity + "/sim/availability"

	publishTelemetry := func() {
		st := dev.State()
		channels := map[string]float64{"power_kw": st.AppliedKw}
		if cfg.AvailabilityChannel != "" {
			v := 0.0
			if dev.Available() {
				v = 1
			}
			channels[cfg.AvailabilityChannel] = v
		}
		raw, _ := json.Marshal(map[string]any{
			"schema_version": "1.0",
			"entity_id":      *entity,
			"ts":             time.Now().UTC().Format(time.RFC3339Nano),
			"channels":       channels,
		})
		client.Publish(telemetryTopic, 1, false, raw)
	}

	publishReadback := func(res consumersim.Applied, controlEnabled bool) {
		match := !res.Mismatch
		commanded := any(nil)
		if !math.IsNaN(res.CommandedKw) {
			commanded = res.CommandedKw
		}
		raw, _ := json.Marshal(map[string]any{
			"schema_version":  "1.0",
			"entity_id":       *entity,
			"ts":              time.Now().UTC().Format(time.RFC3339Nano),
			"adapter":         "consumer-sim",
			"control_enabled": controlEnabled,
			"all_match":       match,
			"registers": []map[string]any{{
				"role":      "power",
				"commanded": commanded,
				"actual":    res.AppliedKw,
				"match":     match,
			}},
			"power_kw": res.AppliedKw,
			"on":       res.On,
		})
		client.Publish(readbackTopic, 1, false, raw)
	}

	if tok := client.Subscribe(cmdTopic, 1, func(_ mqtt.Client, m mqtt.Message) {
		if len(m.Payload()) == 0 {
			// Retained clear = released: the device falls back to its own
			// default (off) and reports nothing - there is no command to
			// confirm.
			dev.Apply(boolPtr(false), nil, true)
			publishTelemetry()
			log.Printf("%s: command cleared (release)", *entity)
			return
		}
		var msg struct {
			ControlEnabled bool `json:"control_enabled"`
			Commands       struct {
				OnOff      *bool    `json:"on_off"`
				SetpointKw *float64 `json:"setpoint_kw"`
			} `json:"commands"`
		}
		if err := json.Unmarshal(m.Payload(), &msg); err != nil {
			log.Printf("%s: command unreadable: %v", *entity, err)
			return
		}
		res := dev.Apply(msg.Commands.OnOff, msg.Commands.SetpointKw, msg.ControlEnabled)
		log.Printf("%s: command on=%v setpoint=%v -> applied on=%v %.3f kW mismatch=%v",
			*entity, fmtBool(msg.Commands.OnOff), fmtF64(msg.Commands.SetpointKw),
			res.On, res.AppliedKw, res.Mismatch)
		publishReadback(res, msg.ControlEnabled)
		publishTelemetry()
	}); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		log.Fatalf("subscribe failed: %v", tok.Error())
	}

	if tok := client.Subscribe(availTopic, 1, func(_ mqtt.Client, m mqtt.Message) {
		v := strings.TrimSpace(string(m.Payload()))
		dev.SetAvailable(v == "1" || v == "true")
		log.Printf("%s: availability -> %v", *entity, dev.Available())
		publishTelemetry()
	}); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		log.Fatalf("subscribe failed: %v", tok.Error())
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	t := time.NewTicker(*interval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			publishTelemetry()
		case <-stop:
			client.Disconnect(250)
			return
		}
	}
}

func boolPtr(v bool) *bool { return &v }

func fmtBool(v *bool) string {
	if v == nil {
		return "-"
	}
	return strconv.FormatBool(*v)
}

func fmtF64(v *float64) string {
	if v == nil {
		return "-"
	}
	return strconv.FormatFloat(*v, 'f', 3, 64)
}
