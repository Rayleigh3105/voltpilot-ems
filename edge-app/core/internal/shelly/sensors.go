package shelly

// Steuerlogik-Konzept Stufe 1 ("Fühler lesen", docs section 9): the add-on
// sensors of a Shelly - Gen2 Temperature/Input components, Gen1 the combined
// DS1820 ext_temperature map - read from the SAME status answer a connection
// test already reads, for a device that may not switch anything at all
// (Config without Channel/Channels: a pure sensor Shelly). No second request
// and no reuse of the control path's own fetch (groupio.go/shelly.go stay
// untouched - the heating-rod executor is safety-critical and this read is
// additive, not worth the coupling).
//
// Gen1 input-as-measurement is deliberately OUT of scope here: the pinned
// docs (catalog/measurement-points/sources/shelly/raw/gen1.html) show only a
// "low-power switch add-on" that CONTROLS the relay, never a documented
// digital-input-as-sensor add-on for Gen1 - worth a question to the
// Fachbetrieb (F8) before extending this, never a guess.

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Temperature is one Temperature component's reading.
type Temperature struct {
	// ID is the device's OWN component id (Shelly.GetStatus key
	// "temperature:<id>"), never re-indexed - the catalog point_key carries
	// it verbatim (e.g. shelly.gen2plus.temperature[100].tc).
	ID int
	// TempC is nil when the device itself could not read the probe (Gen2
	// "tC": null; Gen1 "999", the device's own invalid marker) - never a
	// fabricated or carried-over value.
	TempC *float64
}

// Input is one digital Input component's reading (Gen2 only - see the
// package comment on Gen1 scope).
type Input struct {
	ID int
	// On is nil when the component is disabled or answered no state.
	On *bool
}

// SensorState is one add-on read: every Temperature/Input component the
// device's answer actually named this round. A probe the answer did not name
// at all is simply absent from the slice - not a zero-value entry.
type SensorState struct {
	Temperatures []Temperature
	Inputs       []Input
}

// DetectSensors probes the device once (dialect + auth, same rules as
// Detect/DetectGroup) and reads its add-on sensors from the very status
// answer the probe required anyway.
func DetectSensors(ctx context.Context, doer Doer, cfg Config) (Identity, SensorState, error) {
	if cfg.IP == "" {
		return Identity{}, SensorState{}, &DriverError{Code: ErrInvalidRequest, Message: "keine IP-Adresse"}
	}
	base := "http://" + cfg.HostPort()
	code, body, err := doer.Get(ctx, base+"/shelly")
	if de := classify(code, err); de != nil {
		return Identity{}, SensorState{}, de
	}
	var probe struct {
		Gen    *int   `json:"gen"`
		Model  string `json:"model"`
		App    string `json:"app"`
		Type   string `json:"type"`
		AuthEn *bool  `json:"auth_en"`
		Auth   *bool  `json:"auth"`
	}
	if e := json.Unmarshal(body, &probe); e != nil {
		return Identity{}, SensorState{}, &DriverError{Code: ErrInvalidResponse,
			Message: "Die Antwort des Geräts war kein Shelly-Format."}
	}
	if (probe.AuthEn != nil && *probe.AuthEn) || (probe.Auth != nil && *probe.Auth) {
		return Identity{}, SensorState{}, &DriverError{Code: ErrInvalidResponse,
			Message: "Das Shelly-Gerät ist passwortgeschützt - der Passwortschutz wird nicht unterstützt (siehe SHELLY.md)."}
	}
	switch {
	case probe.Gen != nil && *probe.Gen >= 2:
		ident := Identity{Gen: Gen2, Model: probe.Model, App: probe.App, DetectedAt: time.Now().UTC()}
		st, de := readGen2Sensors(ctx, doer, base)
		if de != nil {
			return Identity{}, SensorState{}, de
		}
		return ident, st, nil
	case probe.Type != "":
		ident := Identity{Gen: Gen1, Model: probe.Type, DetectedAt: time.Now().UTC()}
		st, de := readGen1Sensors(ctx, doer, base)
		if de != nil {
			return Identity{}, SensorState{}, de
		}
		return ident, st, nil
	default:
		return Identity{}, SensorState{}, &DriverError{Code: ErrInvalidResponse,
			Message: "Die Antwort des Geräts war kein Shelly-Format."}
	}
}

// ReadSensors re-reads a device whose dialect is already known and
// persisted - one request, the same parser DetectSensors uses.
func ReadSensors(ctx context.Context, doer Doer, cfg Config, ident Identity) (SensorState, *DriverError) {
	base := "http://" + cfg.HostPort()
	switch ident.Gen {
	case Gen2:
		return readGen2Sensors(ctx, doer, base)
	case Gen1:
		return readGen1Sensors(ctx, doer, base)
	default:
		return SensorState{}, &DriverError{Code: ErrInvalidRequest, Message: "unbekannter Shelly-Dialekt"}
	}
}

func readGen2Sensors(ctx context.Context, doer Doer, base string) (SensorState, *DriverError) {
	code, body, err := doer.Get(ctx, base+"/rpc/Shelly.GetStatus")
	if de := classify(code, err); de != nil {
		return SensorState{}, de
	}
	var all map[string]json.RawMessage
	if e := json.Unmarshal(body, &all); e != nil {
		return SensorState{}, &DriverError{Code: ErrInvalidResponse,
			Message: "Die Statusantwort des Geräts war nicht lesbar."}
	}
	var st SensorState
	for key, raw := range all {
		switch {
		case strings.HasPrefix(key, "temperature:"):
			id, ok := componentID(key, "temperature:")
			if !ok {
				continue
			}
			var c struct {
				TC *float64 `json:"tC"`
			}
			if e := json.Unmarshal(raw, &c); e == nil {
				st.Temperatures = append(st.Temperatures, Temperature{ID: id, TempC: c.TC})
			}
		case strings.HasPrefix(key, "input:"):
			id, ok := componentID(key, "input:")
			if !ok {
				continue
			}
			var c struct {
				State *bool `json:"state"`
			}
			if e := json.Unmarshal(raw, &c); e == nil {
				st.Inputs = append(st.Inputs, Input{ID: id, On: c.State})
			}
		}
	}
	sortTemperatures(st.Temperatures)
	sortInputs(st.Inputs)
	return st, nil
}

// gen1ExtTemperatureDoc is the slice of Shelly1/1PM's combined /status this
// reader needs (ext_temperature: a map "probe index" -> {tC}, DS1820 add-on,
// pinned docs section "Shelly1/1PM: /status" / the MQTT ext_temperatures
// aggregate it mirrors). 999 is the device's own invalid marker, documented
// for every ext_temperature topic ("reports temperature in °C, 999 if
// invalid") - never published as a real reading.
type gen1ExtTemperatureDoc struct {
	ExtTemperature map[string]struct {
		TC *float64 `json:"tC"`
	} `json:"ext_temperature"`
}

const gen1InvalidTempC = 999

func readGen1Sensors(ctx context.Context, doer Doer, base string) (SensorState, *DriverError) {
	code, body, err := doer.Get(ctx, base+"/status")
	if de := classify(code, err); de != nil {
		return SensorState{}, de
	}
	var doc gen1ExtTemperatureDoc
	if e := json.Unmarshal(body, &doc); e != nil {
		return SensorState{}, &DriverError{Code: ErrInvalidResponse,
			Message: "Die Statusantwort des Geräts war nicht lesbar."}
	}
	var st SensorState
	for key, probe := range doc.ExtTemperature {
		id, err := strconv.Atoi(key)
		if err != nil {
			continue
		}
		tc := probe.TC
		if tc != nil && *tc >= gen1InvalidTempC {
			tc = nil
		}
		st.Temperatures = append(st.Temperatures, Temperature{ID: id, TempC: tc})
	}
	sortTemperatures(st.Temperatures)
	return st, nil
}

// componentID parses the numeric id out of a Shelly.GetStatus top-level key
// ("temperature:100" -> 100, true); a key that does not parse is not this
// component family (never guessed).
func componentID(key, prefix string) (int, bool) {
	id, err := strconv.Atoi(strings.TrimPrefix(key, prefix))
	return id, err == nil
}

func sortTemperatures(t []Temperature) {
	sort.Slice(t, func(i, j int) bool { return t[i].ID < t[j].ID })
}

func sortInputs(in []Input) {
	sort.Slice(in, func(i, j int) bool { return in[i].ID < in[j].ID })
}
