package layer1

import (
	"context"
	"math"
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/aiswei"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// KACO's hybrid NH3 over the AISWEI register map on its own Ethernet port:
// the Go twin of the flow's "KACO NH3 lesen" node, the kaco_modbus branch of
// the source executor and readAiswei of test-read.js, on top of
// aiswei-decode.js. Every block carries its function code (FC4 input, FC3
// holding). Read only.

// CommKacoModbus is inverter.CommKacoModbus.
const CommKacoModbus = "kaco_modbus"

type nh3Plan struct {
	IP     string
	Port   int
	Addr   string
	UnitID byte
	Opts   aiswei.Options
}

// planNH3: port 502, unit 1 (a unit id that is not > 0 is 1, like the reader).
func planNH3(s *selection) (*nh3Plan, string) {
	conn := s.Connection
	ip, _ := conn["ip"].(string)
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return nil, "keine IP-Adresse"
	}
	port := int(num(conn["port"], aiswei.DefaultPort))
	if port <= 0 || port > 65535 {
		port = aiswei.DefaultPort
	}
	unit := num(conn["unit_id"], aiswei.DefaultUnitID)
	if !(unit > 0) {
		unit = aiswei.DefaultUnitID
	}
	return &nh3Plan{IP: ip, Port: port, Addr: netJoin(ip, port), UnitID: byte(int64(math.Trunc(unit)) & 0xff),
		Opts: aiswei.Options{InvertGridSign: truthy(conn["invert_grid_sign"]), InvertBattSign: truthy(conn["invert_batt_sign"])}}, ""
}

func (r *Runtime) readNH3(ctx context.Context, p *nh3Plan) (*blockRead, *aiswei.Result, error) {
	var plan []blockSpec
	for _, b := range aiswei.PlanReads(aiswei.Family) {
		plan = append(plan, blockSpec{FC: b.FC, Start: b.Start, Count: b.Count})
	}
	rd, err := r.readBlocks(ctx, p.Addr, p.UnitID, plan)
	if err != nil || len(rd.Blocks) == 0 {
		return rd, nil, err
	}
	var blocks []aiswei.Block
	for _, b := range rd.Blocks {
		blocks = append(blocks, aiswei.Block{FC: b.FC, Start: b.Start, Regs: b.Regs})
	}
	return rd, aiswei.Decode(blocks, p.Opts), nil
}

func (r *Runtime) pollNH3(ctx context.Context, p *nh3Plan) {
	release, ok := r.lanes.tryAcquire(p.Addr)
	if !ok {
		r.log.Debug("KACO NH3 belegt - Lesen uebersprungen", "ziel", p.Addr)
		return
	}
	defer release()
	_, res, err := r.readNH3(ctx, p)
	if err != nil || res == nil {
		r.noteError(p.Addr, "KACO NH3: keine Antwort (Timeout oder Verbindung abgewiesen)")
		return
	}
	r.publishTelemetry(p.Addr, telemetryFrom(res.Reading, res.BattKw, "", r.opts.Now()))
}

func (r *Runtime) testNH3(ctx context.Context, p *nh3Plan, role string) testReadResult {
	release, ok := r.lanes.acquire(ctx, p.Addr, r.opts.LaneWait)
	if !ok {
		return testReadResult{ErrorCode: testconn.ErrNoAnswer,
			Message: "Der Wechselrichter ist gerade mit einer anderen Abfrage beschäftigt - bitte gleich noch einmal testen."}
	}
	defer release()
	rd, res, err := r.readNH3(ctx, p)
	if code, ok := blockTestResult(rd, err, res != nil); !ok {
		return testReadResult{ErrorCode: code}
	}
	return testReadResult{OK: true, Reading: toTestReading(res.Reading, role)}
}

// nh3SourceReading is the executor's kaco_modbus branch.
func nh3SourceReading(res *aiswei.Result) inverterSourceReading {
	if res == nil {
		return inverterSourceReading{why: "keine NH3-Antwort (Timeout oder Verbindung abgewiesen)"}
	}
	return inverterSourceReading{reading: res.Reading}
}

func nh3Note(id, role string, p *nh3Plan) string {
	return "Quelle " + id + " (" + role + "): kaco_modbus " + p.Addr + " -> Leseplan (NH3-Registerkarte, unit " + strconv.Itoa(int(p.UnitID)) + ")"
}
