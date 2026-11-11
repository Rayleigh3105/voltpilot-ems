package layer1

import (
	"context"
	"errors"
	"math"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shellyem"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// A Shelly three-phase meter (Pro 3EM, Pro 3EM-400 in the profile
// "triphase") as an additional source: ONE GET of Shelly.GetStatus per cycle,
// the total active power of em:0 published as the role's channel. Read only -
// no other RPC is ever sent (internal/shellyem). The meter's address is a lane
// like every other device: source read and connection test never overlap.
//
// Roles: a grid meter at the connection point publishes power_kw
// (+Bezug/-Einspeisung, the sign proven on the real Pro 3EM-400 at Schramm's,
// 06.11.2026); a sub-meter (a sub-distribution, read as a consumer source)
// publishes load_kw - the measured power of that part of the plant. An
// Erzeuger has no meter channel. Both meter roles add the meter's details
// (counters, power per phase; shellyEMDetails) to the same reading. The Docker
// box does not read this way yet.

// CommShellyEM is the way's communication id (inverter.CommShellyEMHTTP).
const CommShellyEM = shellyem.Communication

// shellyEMPlan is the resolved read plan of a meter.
type shellyEMPlan struct {
	IP     string
	Port   int
	Addr   string
	URL    string
	Invert bool
}

func planShellyEM(conn map[string]any) (*shellyEMPlan, string) {
	ip, _ := conn["ip"].(string)
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return nil, "keine IP-Adresse"
	}
	port := int(num(conn["port"], shellyem.DefaultPort))
	if port <= 0 || port > 65535 {
		port = shellyem.DefaultPort
	}
	return &shellyEMPlan{IP: ip, Port: port, Addr: netJoin(ip, port), URL: shellyem.URL(ip, port),
		Invert: truthy(conn["invert_grid_sign"])}, ""
}

// readShellyEM is one GET + decode. err is a transport failure or the
// device's unusable answer (shellyem.Answered tells them apart).
func (r *Runtime) readShellyEM(ctx context.Context, p *shellyEMPlan) (*shellyem.Messung, error) {
	body, err := shellyem.Get(ctx, r.http, p.URL)
	if err != nil {
		return nil, err
	}
	return shellyem.Decode(body, 0)
}

// shellyEMValues is the role's channel of one reading, or why there is none.
// Next to it ride the meter's own details (shellyEMDetails), which the core
// reports as the telemetry of the meter's component (agent.meterEntityTelemetry).
func shellyEMValues(m *shellyem.Messung, role string, invert bool) (map[string]float64, string) {
	var values map[string]float64
	switch role {
	case sources.RoleNetz:
		values = map[string]float64{"power_kw": m.PowerKw(invert)}
	case sources.RoleConsumer:
		values = map[string]float64{"load_kw": m.PowerKw(invert)}
	default:
		return nil, "ein Zähler liefert keinen PV-Wert - als Netz-Zähler oder als Unterzähler (Verbraucher) anlegen"
	}
	for k, v := range shellyEMDetails(m, invert) {
		values[k] = v
	}
	return values, ""
}

// shellyEMDetails is what the meter measured beyond the role's channel. A
// value the meter did not send stays absent - never a 0. With
// invert_grid_sign (current transformers mounted against the arrow) the
// phases turn with the total, and the two counters swap: what the meter
// counts as "returned" is then what this part of the plant drew.
func shellyEMDetails(m *shellyem.Messung, invert bool) map[string]float64 {
	out := map[string]float64{}
	bezug, einsp := m.BezugWh, m.EinspWh
	if invert {
		bezug, einsp = einsp, bezug
	}
	if bezug != nil {
		out[sources.MeterEnergyKwh] = round3(*bezug / 1000)
	}
	if einsp != nil {
		out[sources.MeterEnergyExportKwh] = round3(*einsp / 1000)
	}
	for i, ch := range []string{sources.MeterPowerL1Kw, sources.MeterPowerL2Kw, sources.MeterPowerL3Kw} {
		if w := m.Phasen[i].LeistungW; w != nil {
			v := *w
			if invert {
				v = -v
			}
			out[ch] = round3(v / 1000)
		}
	}
	return out
}

// round3 rounds to 1 W (or 1 Wh) like shellyem.Messung.PowerKw; a -0 is 0.
func round3(x float64) float64 {
	v := math.Floor(x*1000+0.5) / 1000
	if v == 0 {
		return 0
	}
	return v
}

// shellyEMWhy names a failed read for the log.
func shellyEMWhy(err error) string {
	if shellyem.Answered(err) {
		return "Shelly-Zaehler: " + err.Error()
	}
	return "Shelly-Zaehler: keine Antwort (Timeout oder Verbindung abgewiesen): " + err.Error()
}

// readShellyEMSource is the source executor's read of a meter.
func (r *Runtime) readShellyEMSource(ctx context.Context, p sourcePlan) sourceOutcome {
	m, err := r.readShellyEM(ctx, p.ShellyEM)
	out := sourceOutcome{requests: 1}
	if err != nil {
		out.why, out.class = shellyEMWhy(err), errorClassOf(ctx, err, shellyem.Answered(err))
		return out
	}
	out.values, out.why = shellyEMValues(m, p.Role, p.ShellyEM.Invert)
	if out.values == nil {
		out.class = "invalid_response"
	}
	return out
}

// testShellyEM is "Verbindung testen" for a meter: a refused connect is
// unreachable, no answer in time no_answer, an answer without a usable meter
// value invalid_response with the reason (password protection, single-channel
// profile, a meter failure); else ok with the role's value.
func (r *Runtime) testShellyEM(ctx context.Context, sel *selection, role string) testReadResult {
	p, why := planShellyEM(sel.Connection)
	if p == nil {
		return testReadResult{ErrorCode: testconn.ErrInvalidRequest, Message: why}
	}
	release, ok := r.lanes.acquire(ctx, p.Addr, r.opts.LaneWait)
	if !ok {
		return testReadResult{ErrorCode: testconn.ErrNoAnswer,
			Message: "Der Zähler ist gerade mit einer anderen Abfrage beschäftigt - bitte gleich noch einmal testen."}
	}
	defer release()

	m, err := r.readShellyEM(ctx, p)
	switch {
	case errors.Is(err, shellyem.ErrGeschuetzt):
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse,
			Message: "Der Shelly verlangt eine Anmeldung. Bitte den Passwortschutz in der Shelly-Weboberfläche ausschalten."}
	case errors.Is(err, shellyem.ErrKeineRPC):
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse,
			Message: "Der Shelly kennt die RPC-Schnittstelle nicht - ein Gerät der ersten Generation (z. B. Shelly 3EM) liest Edge Light noch nicht. Gelesen werden Pro 3EM und Pro 3EM-400."}
	case errors.Is(err, shellyem.ErrEinzelkanaele):
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse,
			Message: "Der Shelly läuft mit Einzelkanälen (Profil „monophase“ oder Pro EM). Gelesen wird ein dreiphasiger Zähler im Profil „triphase“."}
	case errors.Is(err, shellyem.ErrZaehlerfehler):
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse,
			Message: "Der Zähler meldet einen Messfehler (" + strings.TrimPrefix(err.Error(), shellyem.ErrZaehlerfehler.Error()+": ") + ")."}
	case err != nil && shellyem.Answered(err):
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse}
	case err != nil && isDialError(err):
		return testReadResult{ErrorCode: testconn.ErrUnreachable}
	case err != nil && isTimeout(err):
		return testReadResult{ErrorCode: testconn.ErrNoAnswer}
	case err != nil:
		return testReadResult{ErrorCode: testconn.ErrUnreachable}
	}
	if strings.TrimSpace(role) == "" || role == "grid-meter" {
		return testReadResult{OK: true, Reading: toTestReading(map[string]float64{"power_kw": m.PowerKw(p.Invert)}, role)}
	}
	values, why := shellyEMValues(m, role, p.Invert)
	if values == nil {
		return testReadResult{ErrorCode: testconn.ErrInvalidRequest, Message: why}
	}
	return testReadResult{OK: true, Reading: toTestReading(values, role)}
}
