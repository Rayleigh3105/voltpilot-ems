package layer1

import (
	"context"
	"errors"
	"net"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/huaweidecode"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// Huawei SUN2000 (+ LUNA2000) over the inverter's own Modbus TCP server: the
// Go twin of the flow's "Huawei SUN2000 lesen" node (build-flows.js
// huaweiReadFunc) on top of huawei-decode.js makeHuaweiReader. ONE TCP session
// per poll, the plan's FC3 blocks read in order over it; a block the device
// refuses (Modbus exception - no Smart Power Sensor, in particular) or garbles
// only drops its channels, a transport failure (timeout, connection lost) ends
// the read without a value. Only ONE Modbus client may hold the dongle at a
// time, so poll and connection test share the lane of the address.
//
// Read only - the control path of this brand is hard-locked (huawei.json).

// huaweiRead is the outcome of one session.
type huaweiRead struct {
	Blocks   []huaweidecode.Block
	Refused  int // blocks the device answered with an exception or a malformed frame
	Attempts int
}

// dialTCP is the box's plain TCP dialer, the test's injected one when set.
func (r *Runtime) dialTCP(ctx context.Context, addr string) (net.Conn, error) {
	if r.opts.Dialer != nil {
		return r.opts.Dialer.DialContext(ctx, "tcp", addr)
	}
	var d net.Dialer
	return d.DialContext(ctx, "tcp", addr)
}

// readHuawei runs one session. err != nil is a TRANSPORT failure (dial, timeout,
// connection lost): no blocks are usable then, like the reader's done(null).
func (r *Runtime) readHuawei(ctx context.Context, p *huaweiPlan) (*huaweiRead, error) {
	c, err := modbustcp.Dial(ctx, r.dialTCP, p.Addr, p.UnitID, r.opts.ConnectTimeout, r.opts.ReadTimeout)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	out := &huaweiRead{}
	for _, b := range p.Reads {
		out.Attempts++
		regs, err := c.ReadHolding(uint16(b.Start), uint16(b.Count))
		switch {
		case err == nil:
			out.Blocks = append(out.Blocks, huaweidecode.Block{Start: b.Start, Regs: regs})
		case modbustcp.IsException(err) || strings.HasPrefix(err.Error(), "modbus:"):
			// Per-block error isolation: the remaining blocks are still read.
			out.Refused++
		default:
			return nil, err // timeout / connection lost: the whole read is gone
		}
	}
	return out, nil
}

// pollHuawei is one tick of the self-wiring poll.
func (r *Runtime) pollHuawei(ctx context.Context, p *huaweiPlan) {
	release, ok := r.lanes.tryAcquire(p.Addr)
	if !ok {
		r.log.Debug("Wechselrichter belegt - Lesen uebersprungen", "ziel", p.Addr)
		return
	}
	defer release()

	rd, err := r.readHuawei(ctx, p)
	if err != nil {
		r.noteError(p.Addr, "Huawei: keine Antwort (Timeout oder Verbindung abgewiesen): "+err.Error())
		return
	}
	if len(rd.Blocks) == 0 {
		r.noteError(p.Addr, "Huawei: jeder Block abgelehnt (Unit-ID "+itoa(int(p.UnitID))+" falsch oder Modbus TCP am Geraet nicht freigeschaltet?)")
		return
	}
	res := huaweidecode.Decode(rd.Blocks, p.Opts)
	if res == nil {
		r.noteError(p.Addr, "Huawei: keine Messwerte decodiert")
		return
	}
	// The flow's reading: the decoded channels + battery_power_kw on the LOCAL
	// bus only (the core's house balance) + ts. No soc_source: the flow sets
	// none for this brand.
	r.publishTelemetry(p.Addr, telemetryFrom(res.Reading, res.BattKw, "", r.opts.Now()))
}

// testHuawei is "Verbindung testen" for a Huawei (test-read.js readHuawei): a
// failed connect is unreachable; connected but no frame in time is no_answer
// (the flow says invalid_response here - the Go side tells the two apart);
// every block refused or nothing decodable is invalid_response; else ok with
// PV, grid and SoC as read.
func (r *Runtime) testHuawei(ctx context.Context, p *huaweiPlan, role string) testReadResult {
	release, ok := r.lanes.acquire(ctx, p.Addr, r.opts.LaneWait)
	if !ok {
		return testReadResult{ErrorCode: testconn.ErrNoAnswer,
			Message: "Der Wechselrichter ist gerade mit einer anderen Abfrage beschäftigt - bitte gleich noch einmal testen."}
	}
	defer release()

	rd, err := r.readHuawei(ctx, p)
	switch {
	case err != nil && rd == nil && isDialError(err):
		return testReadResult{ErrorCode: testconn.ErrUnreachable}
	case err != nil && isTimeout(err):
		return testReadResult{ErrorCode: testconn.ErrNoAnswer}
	case err != nil:
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse}
	case len(rd.Blocks) == 0:
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse,
			Message: "Der Wechselrichter hat jeden Registerblock abgelehnt - Unit-ID prüfen (0 direkt, meist 1 hinter dem Smart Dongle) und Modbus TCP am Gerät freischalten."}
	}
	res := huaweidecode.Decode(rd.Blocks, p.Opts)
	if res == nil {
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse}
	}
	return testReadResult{OK: true, Reading: toTestReading(res.Reading, role)}
}

// isDialError: the error came from the dial, not from an open session.
func isDialError(err error) bool {
	var oe *net.OpError
	return errors.As(err, &oe) && oe.Op == "dial"
}
