package layer1

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/deyedecode"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/huaweidecode"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/kacoserial"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
)

// Communication methods (inverter.Comm* - the routing key of the selection).
const (
	CommSolarmanV5   = "solarman_v5"
	CommHuaweiModbus = "huawei_modbus"
	CommKacoSerial   = "kaco_serial"
)

// selection is the retained edge/inverter/config payload as Layer 1 reads it
// (inverter.Selection.BusPayload). Unknown fields are ignored - the payload is
// additive by contract.
type selection struct {
	Brand         string         `json:"brand"`
	Model         string         `json:"model"`
	Family        string         `json:"family"`
	Communication string         `json:"communication"`
	Connection    map[string]any `json:"connection"`
}

func parseSelection(payload []byte) (*selection, error) {
	if len(payload) == 0 {
		return nil, nil // retained clear = no selection
	}
	var s selection
	if err := json.Unmarshal(payload, &s); err != nil {
		return nil, fmt.Errorf("Wechselrichter-Auswahl unlesbar: %w", err)
	}
	if s.Connection == nil {
		s.Connection = map[string]any{}
	}
	return &s, nil
}

// solarmanPlan is the resolved read plan for a Deye over Solarman V5 - the Go
// twin of the Node-RED router's solarman branch (inverter-routing.js route +
// the flow's "Router / Leseplan" node). Every refusal carries the SAME German
// idle reason the router shows.
type solarmanPlan struct {
	IP     string
	Port   int
	Addr   string
	Serial uint32
	Slave  byte
	Reads  []solarmanv5.ReadSpec
	Decode deyedecode.Config
}

// num mirrors the router's num(): a number or numeric string, else def.
func num(v any, def float64) float64 {
	switch x := v.(type) {
	case float64:
		if !math.IsNaN(x) && !math.IsInf(x, 0) {
			return x
		}
	case json.Number:
		if f, err := x.Float64(); err == nil {
			return f
		}
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(x), 64); err == nil && !math.IsInf(f, 0) && !math.IsNaN(f) {
			return f
		}
	}
	return def
}

func truthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	}
	return false
}

func planSolarman(s *selection) (*solarmanPlan, string) {
	conn := s.Connection
	ip, _ := conn["ip"].(string)
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return nil, "keine IP-Adresse"
	}
	if !deyedecode.Known(s.Family) {
		return nil, "unbekannte Deye-Familie: " + s.Family
	}
	// The router's rule: absent, empty or not a positive number -> "fehlt".
	rawSerial, present := conn["serial"]
	if !present || rawSerial == nil || rawSerial == "" {
		return nil, "Datenlogger-Seriennummer fehlt"
	}
	serial, err := solarmanv5.NormLoggerSerial(rawSerial)
	if err != nil || serial == 0 {
		return nil, "Datenlogger-Seriennummer fehlt"
	}
	port := int(num(conn["port"], solarmanv5.DefaultPort))
	if port <= 0 || port > 65535 {
		port = solarmanv5.DefaultPort
	}
	slave := num(conn["mb_slave_id"], 1)
	if slave < 0 || slave > 247 {
		slave = 1
	}
	p := &solarmanPlan{
		IP:     ip,
		Port:   port,
		Addr:   netJoin(ip, port),
		Serial: serial,
		Slave:  byte(slave),
		Decode: deyedecode.Config{
			Family:          s.Family,
			InvertGridSign:  truthy(conn["invert_grid_sign"]),
			InvertBattSign:  truthy(conn["invert_batt_sign"]),
			AllowMissingSoc: truthy(conn["allow_missing_soc"]),
			PowerScale:      num(conn["power_scale"], 0),
			SocFromVoltage:  voltRange(conn["soc_from_voltage"]),
		},
	}
	for _, r := range deyedecode.PlanReads(s.Family) {
		p.Reads = append(p.Reads, solarmanv5.ReadSpec{Start: uint16(r.Start), Count: uint16(r.Count), Optional: r.Optional})
	}
	return p, ""
}

// voltRange takes the raw {v_empty, v_full}; the decoder applies the rules.
func voltRange(v any) *deyedecode.VoltRange {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	return &deyedecode.VoltRange{VEmpty: num(m["v_empty"], math.NaN()), VFull: num(m["v_full"], math.NaN())}
}

func netJoin(ip string, port int) string {
	if strings.Contains(ip, ":") && !strings.HasPrefix(ip, "[") {
		return "[" + ip + "]:" + strconv.Itoa(port)
	}
	return ip + ":" + strconv.Itoa(port)
}

// toBlocks converts the transport's blocks into the decoder's.
func toBlocks(in []solarmanv5.Block) []deyedecode.Block {
	out := make([]deyedecode.Block, 0, len(in))
	for _, b := range in {
		out = append(out, deyedecode.Block{Start: int(b.Start), Regs: b.Regs})
	}
	return out
}

// huaweiPlan is the resolved read plan for a Huawei SUN2000 (+ LUNA2000) over
// its own Modbus TCP server - the Go twin of the router's huawei_modbus branch
// (build-flows.js: port 502, unit_id 0, the two sign hatches) and of
// huawei-decode.js makeHuaweiReader's target handling.
type huaweiPlan struct {
	IP     string
	Port   int
	Addr   string
	UnitID byte
	Reads  []huaweidecode.ReadSpec
	Opts   huaweidecode.Options
}

func planHuawei(s *selection) (*huaweiPlan, string) {
	conn := s.Connection
	ip, _ := conn["ip"].(string)
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return nil, "keine IP-Adresse"
	}
	if !huaweidecode.Known(s.Family) {
		return nil, "unbekannte Huawei-Familie: " + s.Family
	}
	port := int(num(conn["port"], huaweidecode.DefaultPort))
	if port <= 0 || port > 65535 {
		port = huaweidecode.DefaultPort
	}
	// makeHuaweiReader: an integer >= 0 is taken, anything else is the factory
	// unit 0 (a Smart Dongle commonly answers on 1 - the form decides).
	unit := num(conn["unit_id"], huaweidecode.DefaultUnitID)
	if unit < 0 || unit != math.Trunc(unit) {
		unit = huaweidecode.DefaultUnitID
	}
	return &huaweiPlan{
		IP: ip, Port: port, Addr: netJoin(ip, port), UnitID: byte(int(unit) & 0xff),
		Reads: huaweidecode.PlanReads(s.Family),
		Opts: huaweidecode.Options{
			InvertGridSign: truthy(conn["invert_grid_sign"]),
			InvertBattSign: truthy(conn["invert_batt_sign"]),
		},
	}, ""
}

// kacoSerialPlan is the resolved read plan for a KACO Powador of the serial
// generation behind a transparent RS485-to-Ethernet converter - the Go twin of
// the router's kaco_serial branch (port 8899, bus address 1..32).
type kacoSerialPlan struct {
	IP      string
	Port    int
	Addr    string
	Address int
}

func planKacoSerial(s *selection) (*kacoSerialPlan, string) {
	conn := s.Connection
	ip, _ := conn["ip"].(string)
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return nil, "keine IP-Adresse"
	}
	if !kacoserial.Known(s.Family) {
		return nil, "unbekannte KACO-Familie: " + s.Family
	}
	port := int(num(conn["port"], kacoserial.DefaultPort))
	if port <= 0 || port > 65535 {
		port = kacoserial.DefaultPort
	}
	address := num(conn["address"], kacoserial.DefaultAddress)
	if address < kacoserial.MinAddress || address > kacoserial.MaxAddress || address != math.Trunc(address) {
		return nil, "RS485-Adresse muss zwischen 1 und 32 liegen"
	}
	return &kacoSerialPlan{IP: ip, Port: port, Addr: netJoin(ip, port), Address: int(address)}, ""
}
