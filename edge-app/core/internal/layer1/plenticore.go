package layer1

import (
	"context"
	"math"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/kostalplenticore"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// A KOSTAL PLENTICORE BI over the vendor's Modbus TCP server: the Go twin of
// the flow's "KOSTAL PLENTICORE lesen" node and readKostal of test-read.js, on
// top of kostal-decode.js. Battery power (local bus only), SoC and - with an
// installed KOSTAL Smart Energy Meter - the grid power; no PV, no load. The
// flow reads it as the primary inverter only (no source branch). Read only.

// CommKostalModbus is inverter.CommKostalModbus.
const CommKostalModbus = "kostal_modbus"

type plenticorePlan struct {
	IP     string
	Port   int
	Addr   string
	UnitID byte
	Opts   kostalplenticore.Options
}

// planPlenticore: the router's defaults (1502, unit 71, byte_order auto) and
// the reader's rule that a unit id that is not > 0 is the vendor's 71.
func planPlenticore(s *selection) (*plenticorePlan, string) {
	conn := s.Connection
	ip, _ := conn["ip"].(string)
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return nil, "keine IP-Adresse"
	}
	port := int(num(conn["port"], kostalplenticore.DefaultPort))
	if port <= 0 || port > 65535 {
		port = kostalplenticore.DefaultPort
	}
	unit := num(conn["unit_id"], kostalplenticore.DefaultUnitID)
	if !(unit > 0) {
		unit = kostalplenticore.DefaultUnitID
	}
	order, _ := conn["byte_order"].(string)
	if order != "little" && order != "big" {
		order = "auto"
	}
	return &plenticorePlan{IP: ip, Port: port, Addr: netJoin(ip, port), UnitID: byte(int64(math.Trunc(unit)) & 0xff),
		Opts: kostalplenticore.Options{InvertGridSign: truthy(conn["invert_grid_sign"]),
			InvertBattSign: truthy(conn["invert_batt_sign"]), ByteOrder: order}}, ""
}

func (r *Runtime) readPlenticore(ctx context.Context, p *plenticorePlan) (*blockRead, *kostalplenticore.Result, error) {
	var plan []blockSpec
	for _, b := range kostalplenticore.PlanReads(kostalplenticore.Family) {
		plan = append(plan, blockSpec{FC: 3, Start: b.Start, Count: b.Count})
	}
	rd, err := r.readBlocks(ctx, p.Addr, p.UnitID, plan)
	if err != nil || len(rd.Blocks) == 0 {
		return rd, nil, err
	}
	var blocks []kostalplenticore.Block
	for _, b := range rd.Blocks {
		blocks = append(blocks, kostalplenticore.Block{Start: b.Start, Regs: b.Regs})
	}
	return rd, kostalplenticore.Decode(blocks, p.Opts), nil
}

func (r *Runtime) pollPlenticore(ctx context.Context, p *plenticorePlan) {
	release, ok := r.lanes.tryAcquire(p.Addr)
	if !ok {
		r.log.Debug("KOSTAL PLENTICORE belegt - Lesen uebersprungen", "ziel", p.Addr)
		return
	}
	defer release()
	_, res, err := r.readPlenticore(ctx, p)
	if err != nil || res == nil {
		r.noteError(p.Addr, "KOSTAL PLENTICORE: keine Antwort (Timeout, Verbindung abgewiesen oder Modbus im Webserver nicht aktiviert)")
		return
	}
	r.publishTelemetry(p.Addr, telemetryFrom(res.Reading, res.BattKw, "", r.opts.Now()))
}

func (r *Runtime) testPlenticore(ctx context.Context, p *plenticorePlan, role string) testReadResult {
	release, ok := r.lanes.acquire(ctx, p.Addr, r.opts.LaneWait)
	if !ok {
		return testReadResult{ErrorCode: testconn.ErrNoAnswer,
			Message: "Der Wechselrichter ist gerade mit einer anderen Abfrage beschäftigt - bitte gleich noch einmal testen."}
	}
	defer release()
	rd, res, err := r.readPlenticore(ctx, p)
	if code, ok := blockTestResult(rd, err, res != nil); !ok {
		return testReadResult{ErrorCode: code}
	}
	return testReadResult{OK: true, Reading: toTestReading(res.Reading, role)}
}
