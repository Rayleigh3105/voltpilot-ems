package layer1

import (
	"context"
	"errors"
	"strconv"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/kostaldxs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/kostalrtu"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// The SAME classic KOSTAL PIKO line over Modbus RTU through a transparent
// RS485-to-Ethernet gateway (the kacoserial hardware class) - the documented
// AUSWEG next to the Web-API (kostaldxs), never the Vorgabeweg, because the
// register map is only COMMUNITY-documented (report §2.5/§3.2). ONE TCP
// connection per register block, no pooling - the same "converter serves one
// client" discipline as kacoserial.Read.
//
// Read only. "Verbindung testen" cross-checks this path against the Web-API
// (Connection.CrossCheckIP) when both are reachable - the built-in
// safeguard against an unofficial register assignment (report §9/E2).

// DefaultKostalRtuTimeout bounds one FC03 round trip over the gateway.
const DefaultKostalRtuTimeout = 4 * time.Second

var errKostalRtuShortFrame = errors.New("kostal rtu: Antwort zu kurz")

// readRtuBlock issues ONE FC03 request and returns its registers. A dial
// failure, a write/read timeout or a malformed/exception frame are returned
// as errors for the caller to classify (solarmanv5.IsProtocolError tells a
// frame-level refusal apart from a transport failure).
func (r *Runtime) readRtuBlock(ctx context.Context, addr string, unitID byte, spec kostalrtu.BlockSpec) (kostalrtu.Block, error) {
	rctx, cancel := context.WithTimeout(ctx, r.opts.KostalRtuTimeout)
	defer cancel()
	conn, err := r.dialTCP(rctx, addr)
	if err != nil {
		return kostalrtu.Block{}, err
	}
	defer conn.Close()
	stop := context.AfterFunc(rctx, func() { _ = conn.SetDeadline(time.Now()) })
	defer stop()

	req := solarmanv5.ReadHoldingRequest(unitID, uint16(spec.Start), uint16(spec.Count))
	_ = conn.SetWriteDeadline(time.Now().Add(r.opts.KostalRtuTimeout))
	if _, err := conn.Write(req); err != nil {
		return kostalrtu.Block{}, err
	}

	want := 5 + 2*spec.Count // addr, fn, byteCount, data.., crcLo, crcHi
	buf := make([]byte, 0, want)
	chunk := make([]byte, 256)
	_ = conn.SetReadDeadline(time.Now().Add(r.opts.KostalRtuTimeout))
	for len(buf) < want {
		n, err := conn.Read(chunk)
		if n > 0 {
			buf = append(buf, chunk[:n]...)
			// A Modbus exception reply is exactly 5 bytes (addr, fn|0x80, code,
			// crcLo, crcHi) - shorter than `want` for any count > 1. Complete on
			// its own: waiting for more bytes would only hit the read deadline.
			if len(buf) >= 5 && buf[1]&0x80 != 0 {
				break
			}
		}
		if err != nil {
			if len(buf) >= 5 {
				break
			}
			return kostalrtu.Block{}, err
		}
	}
	if len(buf) < 5 {
		return kostalrtu.Block{}, errKostalRtuShortFrame
	}
	regs, err := solarmanv5.ParseReadResponse(buf)
	if err != nil {
		return kostalrtu.Block{}, err
	}
	out := make([]uint16, len(regs))
	copy(out, regs)
	return kostalrtu.Block{Start: spec.Start, Regs: out}, nil
}

// pollKostalPikoRtu is one tick of the self-wiring poll - ONE FC03 request
// (FastBlockSpec, the AC total power register), the same minimalism as the
// Web-API path.
func (r *Runtime) pollKostalPikoRtu(ctx context.Context, p *kostalPikoRtuPlan) {
	release, ok := r.lanes.tryAcquire(p.Addr)
	if !ok {
		r.log.Debug("PIKO (Modbus RTU) belegt - Lesen uebersprungen", "ziel", p.Addr)
		return
	}
	defer release()

	block, err := r.readRtuBlock(ctx, p.Addr, p.UnitID, kostalrtu.FastBlockSpec)
	if err != nil {
		r.noteError(p.Addr, "KOSTAL PIKO (Modbus RTU): keine/ungueltige Antwort: "+err.Error())
		return
	}
	res := kostalrtu.Decode([]kostalrtu.Block{block})
	if res == nil || len(res.Reading) == 0 {
		r.noteError(p.Addr, "KOSTAL PIKO (Modbus RTU): keine AC-Leistung im Register")
		return
	}
	r.publishTelemetry(p.Addr, telemetryFrom(res.Reading, nil, "", r.opts.Now()))
}

// testKostalPikoRtu is "Verbindung testen" for the RTU Ausweg: reads the
// full TestBlockSpecs, then - if CrossCheckIP is set - compares the RTU
// AC power against a fresh Web-API read of the SAME physical device,
// the built-in Gegenprobe the report requires for this unofficial
// register map (§9/E2).
func (r *Runtime) testKostalPikoRtu(ctx context.Context, p *kostalPikoRtuPlan, role string) testReadResult {
	release, ok := r.lanes.acquire(ctx, p.Addr, r.opts.LaneWait)
	if !ok {
		return testReadResult{ErrorCode: testconn.ErrNoAnswer,
			Message: "Der Wandler ist gerade mit einer anderen Abfrage beschäftigt - bitte gleich noch einmal testen."}
	}
	defer release()

	var blocks []kostalrtu.Block
	var firstErr error
	for _, spec := range kostalrtu.TestBlockSpecs {
		b, err := r.readRtuBlock(ctx, p.Addr, p.UnitID, spec)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue // per-block isolation: the remaining blocks are still read.
		}
		blocks = append(blocks, b)
	}
	if len(blocks) == 0 {
		switch {
		case isDialError(firstErr):
			return testReadResult{ErrorCode: testconn.ErrUnreachable}
		case isTimeout(firstErr):
			return testReadResult{ErrorCode: testconn.ErrNoAnswer}
		default:
			return testReadResult{ErrorCode: testconn.ErrInvalidResponse,
				Message: "Keine gueltige Modbus-Antwort - Protokoll am Gerät auf \"Modbus\" gestellt? Geräteadresse korrekt?"}
		}
	}
	res := kostalrtu.Decode(blocks)
	if res == nil || len(res.Reading) == 0 {
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse,
			Message: "Keine AC-Leistung im erwarteten Register (30031) - Registerkarte stimmt nicht (siehe KOSTAL.md)."}
	}
	verbose := kostalrtu.DecodeVerbose(blocks)
	msg := kostalRtuCrossCheckMessage(ctx, r, p, verbose)
	return testReadResult{OK: true, Reading: toTestReading(res.Reading, role), Message: msg}
}

// kostalRtuCrossCheckMessage runs the built-in Gegenprobe against the
// Web-API when CrossCheckIP is set: a fresh dxs.json AC-power read of the
// SAME physical PIKO, compared against the RTU reading. Never fails the test
// on its own - the RTU read already succeeded; this is additional evidence,
// reported honestly either way (report §2.5 "Was der Weg vor Ort verlangt").
func kostalRtuCrossCheckMessage(ctx context.Context, r *Runtime, p *kostalPikoRtuPlan, v kostalrtu.Verbose) string {
	rtuKw := v.PvPowerKw
	base := ""
	if rtuKw != nil {
		base = "RTU-AC-Leistung: " + strconv.FormatFloat(*rtuKw, 'f', 3, 64) + " kW"
	}
	if p.CrossCheckIP == "" {
		if base == "" {
			return "Keine Gegenprobe (keine IP für die Web-API angegeben)."
		}
		return base + " · keine Gegenprobe (keine IP für die Web-API angegeben)"
	}
	webRes, err := r.getDxs(ctx, &kostalDxsPlan{IP: p.CrossCheckIP, Port: kostaldxs.DefaultPort, Addr: netJoin(p.CrossCheckIP, kostaldxs.DefaultPort)}, kostaldxs.FastIDs)
	if err != nil || webRes == nil {
		return base + " · Gegenprobe über die Web-API nicht erreichbar (" + p.CrossCheckIP + ")"
	}
	webKw, ok := webRes.Reading["pv_power_kw"]
	if !ok {
		return base + " · Gegenprobe: Web-API antwortet, aber ohne AC-Leistung"
	}
	if rtuKw == nil {
		return "Gegenprobe Web-API: " + strconv.FormatFloat(webKw, 'f', 3, 64) + " kW"
	}
	diffKw := *rtuKw - webKw
	if diffKw < 0 {
		diffKw = -diffKw
	}
	return base + " · Gegenprobe Web-API: " + strconv.FormatFloat(webKw, 'f', 3, 64) + " kW (Abweichung " +
		strconv.FormatFloat(diffKw, 'f', 3, 64) + " kW)"
}
