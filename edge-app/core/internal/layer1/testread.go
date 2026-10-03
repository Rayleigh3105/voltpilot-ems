package layer1

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/deyedecode"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// testReadRequest is edge/test-read/request: the normalized (unsaved)
// selection plus the correlation id (agent.testReadExchange).
type testReadRequest struct {
	selection
	RequestID  string `json:"request_id"`
	Role       string `json:"role"`
	ProbeUnits bool   `json:"probe_units"`
}

// testReadResult is edge/test-read/result (agent.onTestReadResult).
type testReadResult struct {
	RequestID string            `json:"request_id"`
	OK        bool              `json:"ok"`
	ErrorCode string            `json:"error_code,omitempty"`
	Message   string            `json:"message,omitempty"`
	Reading   *testconn.Reading `json:"reading,omitempty"`
	Finding   *deyedecode.Drop  `json:"finding,omitempty"`
}

// onTestRead answers "Verbindung testen" - the Go twin of test-read.js for
// the transports Layer 1 implements. It never writes, never persists, and it
// ALWAYS answers: a request for a transport that is not ported yet gets an
// honest invalid_request instead of a silent 10-s timeout.
func (r *Runtime) onTestRead(ctx context.Context, payload []byte) {
	var req testReadRequest
	if err := json.Unmarshal(payload, &req); err != nil || req.RequestID == "" {
		r.log.Warn("Verbindungstest-Anfrage unlesbar; verworfen")
		return
	}
	if req.Connection == nil {
		req.Connection = map[string]any{}
	}
	res := r.testRead(ctx, &req)
	res.RequestID = req.RequestID
	raw, _ := json.Marshal(res)
	if err := r.bus.Publish(localbus.TopicTestReadResult, raw, false); err != nil {
		r.log.Warn("Verbindungstest-Ergebnis nicht gesendet", "err", err)
	}
}

func (r *Runtime) testRead(ctx context.Context, req *testReadRequest) testReadResult {
	if req.ProbeUnits {
		return testReadResult{ErrorCode: testconn.ErrInvalidRequest,
			Message: "Die Suche nach weiteren Wechselrichtern ist in Edge Light noch nicht verfügbar."}
	}
	switch req.Communication {
	case CommSolarmanV5:
		p, why := planSolarman(&req.selection)
		if p == nil {
			return testReadResult{ErrorCode: testconn.ErrInvalidRequest, Message: why}
		}
		return r.testSolarman(ctx, p, req.Role)
	}
	return testReadResult{ErrorCode: testconn.ErrInvalidRequest,
		Message: "Diese Anbindung („" + req.Communication + "“) wird von Edge Light noch nicht unterstützt."}
}

// testSolarman reads the logger ONCE and classifies like test-read.js:
// connect failure -> unreachable, connected but silent -> no_answer, a refused
// frame -> invalid_response, the SoC gate -> implausible WITH the reading and
// the finding. allow_missing_soc is deliberately NOT applied: the test always
// tells the truth; whether it is acceptable is the human's call in the portal.
func (r *Runtime) testSolarman(ctx context.Context, p *solarmanPlan, role string) testReadResult {
	release, ok := r.lanes.acquire(ctx, p.Addr, r.opts.LaneWait)
	if !ok {
		return testReadResult{ErrorCode: testconn.ErrNoAnswer,
			Message: "Der Datenlogger ist gerade mit einer anderen Abfrage beschäftigt - bitte gleich noch einmal testen."}
	}
	defer release()

	sess, err := solarmanv5.Dial(ctx, r.opts.Dialer, p.Addr, p.Serial, p.Slave, r.opts.ConnectTimeout, r.opts.ReadTimeout)
	if err != nil {
		return testReadResult{ErrorCode: testconn.ErrUnreachable}
	}
	defer sess.Close()
	blocks, err := sess.ReadPlan(ctx, p.Reads)
	if err != nil {
		if errors.Is(err, solarmanv5.ErrNoAnswer) {
			return testReadResult{ErrorCode: testconn.ErrNoAnswer}
		}
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse}
	}

	cfg := p.Decode
	cfg.AllowMissingSoc = false
	v, known := deyedecode.DecodeVerbose(toBlocks(blocks), cfg)
	if !known {
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse}
	}
	if v.Drop != nil && v.Drop.BMS != nil {
		// The coupled BMS reports a MEASURED SoC: the poll publishes exactly
		// this value, so the test must agree with it.
		reading := copyReading(v.Reading)
		reading["soc_pct"] = v.Drop.BMS.SocPct
		return testReadResult{OK: true, Reading: toTestReading(reading, role)}
	}
	if v.Drop != nil {
		finding := *v.Drop
		finding.BMS = nil
		return testReadResult{ErrorCode: testconn.ErrImplausible, Reading: toTestReading(v.Reading, role), Finding: &finding}
	}
	return testReadResult{OK: true, Reading: toTestReading(v.Reading, role)}
}

func copyReading(in map[string]float64) map[string]float64 {
	out := make(map[string]float64, len(in)+1)
	for k, v := range in {
		out[k] = v
	}
	return out
}

// toTestReading is test-read.js toReading: the UI's fields, only present
// finite numbers (never a fabricated 0); a grid meter shows only Netzbezug.
func toTestReading(r map[string]float64, role string) *testconn.Reading {
	pick := func(k string) *float64 {
		v, ok := r[k]
		if !ok || math.IsNaN(v) || math.IsInf(v, 0) {
			return nil
		}
		return &v
	}
	out := &testconn.Reading{GridKw: pick("power_kw")}
	if strings.TrimSpace(role) != "grid-meter" {
		out.PvKw = pick("pv_power_kw")
		out.LoadKw = pick("load_kw")
		out.SocPct = pick("soc_pct")
	}
	return out
}
