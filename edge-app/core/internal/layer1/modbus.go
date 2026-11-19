package layer1

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbusprofil"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// Generic Modbus TCP (brand generic_modbus, communication modbus_tcp): the Go
// twin of the flow's "Modbus-TCP lesen (FC3)" and "Modbus-Register ->
// Messwerte" nodes, the modbus_tcp branch of the source executor and of
// test-read.js, on top of modbus-tcp.js (internal/modbusprofil). The selection's
// family IS the register profile; one block per read, one Modbus TCP session
// per read, under the lane of the address (poll, source read, connection test
// and the probe channel never open two sockets to one device).
//
// Read only: FC3 (or FC4 for a probe step), never a write. The SunSpec control
// adapter of the Docker box (Model 124 on the simulator) is not part of Edge
// Light.

// CommModbusTCP is inverter.CommModbusTCP.
const CommModbusTCP = "modbus_tcp"

// modbusPlan is the resolved read plan - the router's msg.mb.
type modbusPlan struct {
	IP      string
	Port    int
	Addr    string
	UnitID  byte
	Profile string
	Read    modbusprofil.Read
}

func planModbus(s *selection) (*modbusPlan, string) {
	conn := s.Connection
	ip, _ := conn["ip"].(string)
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return nil, "keine IP-Adresse"
	}
	read, ok := modbusprofil.ProfileRead(s.Family)
	if !ok {
		return nil, "unbekanntes Modbus-Profil: " + s.Family
	}
	// The router: port num(conn.port, 502), unit num(conn.unit_id, 1); the
	// reader's `conn.unit_id || 1` reads a unit 0 as 1.
	port := int(num(conn["port"], 502))
	if port <= 0 || port > 65535 {
		port = 502
	}
	unit := int(num(conn["unit_id"], 1))
	if unit <= 0 || unit > 255 {
		unit = 1
	}
	return &modbusPlan{IP: ip, Port: port, Addr: netJoin(ip, port), UnitID: byte(unit), Profile: s.Family, Read: read}, ""
}

// readModbus reads the plan's block in one session. err != nil is a failure
// of the read: transport (dial, timeout, connection lost), a Modbus exception
// or a malformed frame.
func (r *Runtime) readModbus(ctx context.Context, p *modbusPlan) ([]uint16, error) {
	c, err := modbustcp.Dial(ctx, r.dialTCP, p.Addr, p.UnitID, r.opts.ConnectTimeout, r.opts.ReadTimeout)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if p.Read.FC == modbusprofil.FcReadInput {
		return c.ReadInput(uint16(p.Read.Addr), uint16(p.Read.Count))
	}
	return c.ReadHolding(uint16(p.Read.Addr), uint16(p.Read.Count))
}

// pollModbus is one tick of the self-wiring poll: the decoded reading plus
// battery_power_kw on the LOCAL bus only (the core's house balance) and ts.
func (r *Runtime) pollModbus(ctx context.Context, p *modbusPlan) {
	release, ok := r.lanes.tryAcquire(p.Addr)
	if !ok {
		r.log.Debug("Wechselrichter belegt - Lesen uebersprungen", "ziel", p.Addr)
		return
	}
	defer release()

	regs, err := r.readModbus(ctx, p)
	if err != nil {
		r.noteError(p.Addr, "Modbus: "+err.Error())
		return
	}
	res := modbusprofil.DecodeProfile(p.Profile, regs)
	if res == nil {
		r.noteError(p.Addr, "Modbus ("+p.Profile+"): keine Messwerte decodiert")
		return
	}
	batt := res.BattKw
	r.publishTelemetry(p.Addr, telemetryFrom(res.Reading, &batt, "", r.opts.Now()))
}

// modbusSourceReading is the source executor's view of one read: the flow
// decodes the PV word for an Erzeuger and the grid word for a Netz meter.
func modbusSourceReading(p *modbusPlan, regs []uint16, err error) inverterSourceReading {
	if err != nil {
		return inverterSourceReading{why: "keine Modbus-Antwort: " + err.Error()}
	}
	res := modbusprofil.DecodeProfile(p.Profile, regs)
	if res == nil {
		return inverterSourceReading{why: "Modbus-Block zu kurz für das Profil " + p.Profile}
	}
	return inverterSourceReading{reading: map[string]float64{
		"pv_power_kw": res.Reading["pv_power_kw"], "power_kw": res.Reading["power_kw"]}}
}

// modbusSourceClass names a failed source read for the receipt, like the
// flow's readOne: no connection = unreachable, connected but silent =
// no_answer, an exception or a frame that is no answer = invalid_response.
func modbusSourceClass(ctx context.Context, err error) string {
	switch {
	case err == nil:
		return ""
	case modbustcp.IsException(err) || strings.HasPrefix(err.Error(), "modbus:"):
		return "invalid_response"
	}
	return errorClassOf(ctx, err, false)
}

// testModbus is "Verbindung testen" (test-read.js readModbus): a failed
// connect is unreachable; connected but no answer in time is no_answer; a
// refused or malformed frame and a block that does not decode are
// invalid_response; else ok with the reading.
func (r *Runtime) testModbus(ctx context.Context, p *modbusPlan, role string) testReadResult {
	release, ok := r.lanes.acquire(ctx, p.Addr, r.opts.LaneWait)
	if !ok {
		return testReadResult{ErrorCode: testconn.ErrNoAnswer,
			Message: "Das Gerät ist gerade mit einer anderen Abfrage beschäftigt - bitte gleich noch einmal testen."}
	}
	defer release()

	regs, err := r.readModbus(ctx, p)
	switch {
	case err != nil && isDialError(err):
		return testReadResult{ErrorCode: testconn.ErrUnreachable}
	case err != nil && isTimeout(err):
		return testReadResult{ErrorCode: testconn.ErrNoAnswer}
	case err != nil:
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse}
	}
	res := modbusprofil.DecodeProfile(p.Profile, regs)
	if res == nil {
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse}
	}
	return testReadResult{OK: true, Reading: toTestReading(res.Reading, role)}
}

// modbusSourceRefusal is ReadsAsSource's answer for modbus_tcp: the profile
// carries PV and grid power; the flow's executor publishes no load from it,
// so a Verbraucher would fail every tick.
func modbusSourceRefusal(role string) string {
	if role == sources.RoleConsumer {
		return "ein generisches Modbus-Gerät liefert als Energiequelle nur PV oder Netzleistung (als Erzeuger oder Netz-Zähler anlegen)"
	}
	return ""
}

// --- the probe channel: the plain register read -----------------------------

// registerProbe runs one plain read step of edge/probe/request (the register
// preview of the self-build assistant) in ONE session under the lane of the
// device's address, so it waits for a running poll instead of displacing it.
func (r *Runtime) registerProbe(ctx context.Context, id string, op modbusprofil.LeseOp) modbusprofil.Ergebnis {
	return modbusprofil.Lies(ctx, id, op, func(ctx context.Context, p modbusprofil.Leseplan) ([]uint16, string) {
		if !probe.IsPrivateHost(p.Host) {
			// The LAN rule again at the opener (lan-host-vectors.json).
			return nil, modbusprofil.MeldungAufbau + "Adresse liegt nicht im Kundennetz"
		}
		addr := net.JoinHostPort(p.Host, strconv.Itoa(p.Port))
		release, ok := r.lanes.acquire(ctx, addr, r.opts.LaneWait)
		if !ok {
			return nil, modbusprofil.MeldungWarteschlange + " für " + addr + " belegt - Gerät liest gerade"
		}
		defer release()
		c, err := modbustcp.Dial(ctx, r.dialTCP, addr, byte(p.UnitID), r.opts.ConnectTimeout, r.opts.ReadTimeout)
		if err != nil {
			if isTimeout(err) {
				return nil, modbusprofil.MeldungAufbauTimeout + " (" + millis(r.opts.ConnectTimeout) + ")"
			}
			return nil, modbusprofil.MeldungAufbau + err.Error()
		}
		defer c.Close()
		var w []uint16
		if p.FC == modbusprofil.FcReadInput {
			w, err = c.ReadInput(uint16(p.Addr), uint16(p.Count))
		} else {
			w, err = c.ReadHolding(uint16(p.Addr), uint16(p.Count))
		}
		if err != nil {
			return nil, modbusMeldung(err, r.opts.ReadTimeout)
		}
		return w, ""
	})
}

// modbusMeldung names a failure of an open session in the words of the
// palette's connection manager (lib/modbus-conn.js), so the probe classifies
// it like the Docker box: an exception is "Modbus-Ausnahme 0x..", silence an
// "Antwort-Timeout", a closed connection "geschlossen ohne Antwort", a reset
// a failed connection; a malformed frame keeps its own text.
func modbusMeldung(err error, readTimeout time.Duration) string {
	var ex *modbustcp.ExceptionError
	switch {
	case errors.As(err, &ex):
		return fmt.Sprintf("%s 0x%02x", modbusprofil.MeldungAusnahme, ex.Code)
	case isTimeout(err):
		return modbusprofil.MeldungAntwortZeit + " (" + millis(readTimeout) + ")"
	case errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF):
		return modbusprofil.MeldungGeschlossen
	case strings.HasPrefix(err.Error(), "modbus:"):
		return err.Error()
	}
	return modbusprofil.MeldungAufbau + err.Error()
}

func millis(d time.Duration) string { return strconv.FormatInt(d.Milliseconds(), 10) + " ms" }
