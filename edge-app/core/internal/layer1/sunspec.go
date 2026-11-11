package layer1

import (
	"context"
	"math"
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sunspeclive"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// SunSpec over Modbus TCP: the Go twin of the flow's "SunSpec lesen" node
// (build-flows.js, the sunspec branch of the router) on top of sunspec-live.js
// makeSunspecReader. Both ids of the way are read - `sunspec_tcp` (KACO and
// every later SunSpec brand) and the persisted `fronius_sunspec`. ONE TCP
// session per poll walks the model list and reads the bodies; a refused read
// ends the walk with what was found, a transport failure (timeout, connection
// lost) ends the read without a value. KACO and Fronius serve ONE Modbus-TCP
// client at a time, so poll, source read and connection test share the lane of
// the address.
//
// Read only: FC3, never a write. The curtailment of the Docker box (Model 123,
// sunspec/curtail.js) is not part of Edge Light.

// Communication ids of the SunSpec-live way (inverter.CommSunSpecTCP /
// inverter.CommFroniusSunSpec - one way, two ids).
const (
	CommSunSpecTCP     = "sunspec_tcp"
	CommFroniusSunSpec = "fronius_sunspec"
)

func isSunSpecComm(comm string) bool { return comm == CommSunSpecTCP || comm == CommFroniusSunSpec }

// The flow's warnFail text when a read yields no reading.
const sunspecNoValue = "keine Antwort / kein SunSpec-Geraet (Timeout, Verbindung abgewiesen oder Walk abgebrochen)"

// sunspecPlan is the resolved read plan - the router's msg.sunspec.conn.
type sunspecPlan struct {
	IP        string
	Port      int
	Addr      string
	UnitID    byte
	ModelType string // "auto" | "float" | "int_sf"
	Target    sunspeclive.Target
}

func planSunSpec(s *selection) (*sunspecPlan, string) {
	conn := s.Connection
	ip, _ := conn["ip"].(string)
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return nil, "keine IP-Adresse"
	}
	// The router: port num(conn.port, 502); unit_id num(conn.unit_id, 1) and the
	// reader's Number(unitId) > 0 ? unitId : 1 - a unit 0 reads as 1.
	port := int(num(conn["port"], sunspeclive.DefaultPort))
	if port <= 0 || port > 65535 {
		port = sunspeclive.DefaultPort
	}
	unit := num(conn["unit_id"], sunspeclive.DefaultUnitID)
	if !(unit > 0) {
		unit = sunspeclive.DefaultUnitID
	}
	mt, _ := conn["model_type"].(string)
	if mt != "float" && mt != "int_sf" {
		mt = "auto"
	}
	return &sunspecPlan{
		IP: ip, Port: port, Addr: netJoin(ip, port), UnitID: byte(int(math.Trunc(unit)) & 0xff), ModelType: mt,
		Target: sunspeclive.Target{InvertGridSign: truthy(conn["invert_grid_sign"]), ModelType: mt},
	}, ""
}

// sunspecLabel names the plan in the log: "ip:port Unit n".
func sunspecLabel(p *sunspecPlan) string { return p.Addr + " Unit " + strconv.Itoa(int(p.UnitID)) }

// readSunSpec runs one session. err != nil is a TRANSPORT failure.
func (r *Runtime) readSunSpec(ctx context.Context, p *sunspecPlan) (*sunspeclive.Lesung, error) {
	l, err := sunspeclive.Read(ctx, r.dialTCP, p.Addr, p.UnitID, r.opts.ConnectTimeout, r.opts.ReadTimeout, p.Target)
	if err == nil && l.Found {
		r.noteSunSpecDevice(p.Addr, l)
	}
	return l, err
}

// noteSunSpecDevice names the device behind an address once (and again when it
// changes) - never the serial number, the box log is no identity register.
func (r *Runtime) noteSunSpecDevice(addr string, l *sunspeclive.Lesung) {
	model, typ := 0, ""
	if l.Result != nil && l.Result.Meta.Inverter != nil {
		model, typ = l.Result.Meta.InverterModel, l.Result.Meta.InverterType
	}
	key := l.Common.Hersteller + "|" + l.Common.Modell + "|" + l.Common.Version + "|" + strconv.Itoa(model)
	if prev, ok := r.sunspecSeen.Load(addr); ok && prev == key {
		return
	}
	r.sunspecSeen.Store(addr, key)
	base := 0
	if l.Result != nil {
		base = l.Result.Meta.Base
	}
	r.log.Info("SunSpec-Geraet gelesen", "ziel", addr, "hersteller", l.Common.Hersteller, "modell", l.Common.Modell,
		"firmware", l.Common.Version, "basis", base, "wechselrichter_modell", model, "modelltyp", typ, "anfragen", l.Requests)
}

// pollSunSpec is one tick of the self-wiring poll (the flow publishes
// Object.assign({ts}, out.reading): pv_power_kw and, with a meter model,
// power_kw - no battery channel on this way).
func (r *Runtime) pollSunSpec(ctx context.Context, p *sunspecPlan) {
	release, ok := r.lanes.tryAcquire(p.Addr)
	if !ok {
		r.log.Debug("Wechselrichter belegt - Lesen uebersprungen", "ziel", p.Addr)
		return
	}
	defer release()

	l, err := r.readSunSpec(ctx, p)
	if err != nil {
		r.noteError(p.Addr, "SunSpec ("+sunspecLabel(p)+"): "+sunspecNoValue+": "+err.Error())
		return
	}
	if !l.Found || l.Result == nil {
		r.noteError(p.Addr, "SunSpec ("+sunspecLabel(p)+"): "+sunspecNoValue+stoppedNote(l))
		return
	}
	r.publishTelemetry(p.Addr, telemetryFrom(l.Result.Reading, nil, "", r.opts.Now()))
}

// sunspecSourceReading is the source executor's view of one read.
func sunspecSourceReading(l *sunspeclive.Lesung, err error) inverterSourceReading {
	switch {
	case err != nil:
		return inverterSourceReading{why: "SunSpec-Lesefehler: " + err.Error()}
	case !l.Found || l.Result == nil:
		return inverterSourceReading{why: sunspecNoValue + stoppedNote(l)}
	}
	return inverterSourceReading{reading: l.Result.Reading}
}

// stoppedNote names the refused read that ended a walk early.
func stoppedNote(l *sunspeclive.Lesung) string {
	if l == nil || l.Stopped == "" {
		return ""
	}
	return " - Walk abgebrochen bei " + l.Stopped
}

// testSunSpec is "Verbindung testen" (test-read.js readSunSpec): a failed
// connect is unreachable; a connected device that does not answer in time is
// no_answer (test-read.js says invalid_response here - the Go side tells the
// two apart, like for Huawei); no "SunS" marker or nothing decodable is
// invalid_response; else ok with the reading.
func (r *Runtime) testSunSpec(ctx context.Context, p *sunspecPlan, role string) testReadResult {
	release, ok := r.lanes.acquire(ctx, p.Addr, r.opts.LaneWait)
	if !ok {
		return testReadResult{ErrorCode: testconn.ErrNoAnswer,
			Message: "Der Wechselrichter ist gerade mit einer anderen Abfrage beschäftigt - bitte gleich noch einmal testen."}
	}
	defer release()

	l, err := r.readSunSpec(ctx, p)
	switch {
	case err != nil && sunspeclive.IsDialError(err):
		return testReadResult{ErrorCode: testconn.ErrUnreachable}
	case err != nil && isTimeout(err):
		return testReadResult{ErrorCode: testconn.ErrNoAnswer}
	case err != nil:
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse}
	case !l.Found:
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse,
			Message: "Unter dieser Adresse antwortet kein SunSpec-Gerät (kein „SunS“ an 40001, 50001 oder 1) - ist Modbus TCP am Wechselrichter eingeschaltet?"}
	case l.Result == nil:
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse,
			Message: "Das Gerät spricht SunSpec, liefert aber keinen lesbaren Messwert (kein Wechselrichter- oder Zählermodell)."}
	}
	return testReadResult{OK: true, Reading: toTestReading(l.Result.Reading, role)}
}
