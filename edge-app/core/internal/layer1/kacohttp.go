package layer1

import (
	"context"
	"strconv"
	"strings"
	"sync"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/kacohttp"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// KACO NX/NH3 over the App-Schnittstelle (HTTP 8484 of the communication
// unit): the Go twin of the flow's "KACO App-Schnittstelle lesen" node, the
// kaco_http branch of the source executor and readKaco of test-read.js, on top
// of kaco-http.js. Without a serial the inventory names it (never guessed);
// inverter, meter and - for the hybrid - battery are asked in parallel, each
// isolated: at night what answers is carried, the rest is absent. Read only.

// CommKacoHTTP is inverter.CommKacoHTTP.
const CommKacoHTTP = "kaco_http"

type kacoHTTPPlan struct {
	IP     string
	Port   int
	Addr   string
	Target kacohttp.Target
}

// planKacoHTTP: port 8484, https only with insecure_tls, the serial trimmed.
// The family is NOT judged here (the router and the store node do; test-read.js
// tests any family as a string device unless it is the hybrid).
func planKacoHTTP(s *selection) (*kacoHTTPPlan, string) {
	conn := s.Connection
	ip, _ := conn["ip"].(string)
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return nil, "keine IP-Adresse"
	}
	port := int(num(conn["port"], kacohttp.DefaultPort))
	if port <= 0 || port > 65535 {
		port = kacohttp.DefaultPort
	}
	insecure := truthy(conn["insecure_tls"])
	scheme := "http"
	if insecure {
		scheme = "https"
	}
	serial, _ := conn["serial"].(string)
	family := s.Family
	if family != kacohttp.FamilyHybrid {
		family = kacohttp.FamilyString
	}
	hasBattery := kacohttp.HasBattery(family)
	return &kacoHTTPPlan{IP: ip, Port: port, Addr: netJoin(ip, port), Target: kacohttp.Target{
		IP: urlHost(ip), Port: port, Scheme: scheme, InsecureTLS: insecure, Serial: strings.TrimSpace(serial),
		Family: family, HasBattery: &hasBattery, InvertGridSign: truthy(conn["invert_grid_sign"]),
		InvertBattSign: truthy(conn["invert_batt_sign"])}}, ""
}

// kacoEvidence counts the GETs of one cycle and keeps the first failure's
// class - the source receipt's evidence (pollEvidence's counted http).
type kacoEvidence struct {
	mu       sync.Mutex
	requests int
	class    string
}

func (r *Runtime) readKacoHTTP(ctx context.Context, p *kacoHTTPPlan) (*kacohttp.Result, *kacoEvidence) {
	ev := &kacoEvidence{}
	get := func(ctx context.Context, url string) []byte {
		rctx, cancel := context.WithTimeout(ctx, r.opts.HTTPTimeout)
		defer cancel()
		body, err := r.httpGetWhere(rctx, url, p.Target.InsecureTLS, func(status int) bool { return status == 200 })
		ev.mu.Lock()
		defer ev.mu.Unlock()
		ev.requests++
		if err != nil && ev.class == "" {
			ev.class = errorClassOf(rctx, err, err == errHTTPStatus || err == errBodyTooLarge)
		}
		if err != nil {
			return nil
		}
		return body
	}
	return kacohttp.Read(ctx, get, p.Target), ev
}

func (r *Runtime) pollKacoHTTP(ctx context.Context, p *kacoHTTPPlan) {
	release, ok := r.lanes.tryAcquire(p.Addr)
	if !ok {
		r.log.Debug("KACO belegt - Lesen uebersprungen", "ziel", p.Addr)
		return
	}
	defer release()
	res, _ := r.readKacoHTTP(ctx, p)
	if res == nil {
		r.noteError(p.Addr, "KACO: keine Antwort (Timeout, oder die Kommunikationseinheit meldet keinen Wechselrichter)")
		return
	}
	r.publishTelemetry(p.Addr, telemetryFrom(res.Reading, res.BattKw, "", r.opts.Now()))
}

// testKacoHTTP is readKaco: every failure is invalid_response; a success
// gives the serial it used back, so the form can fill it in.
func (r *Runtime) testKacoHTTP(ctx context.Context, p *kacoHTTPPlan, role string) testReadResult {
	release, ok := r.lanes.acquire(ctx, p.Addr, r.opts.LaneWait)
	if !ok {
		return testReadResult{ErrorCode: testconn.ErrNoAnswer,
			Message: "Der Wechselrichter ist gerade mit einer anderen Abfrage beschäftigt - bitte gleich noch einmal testen."}
	}
	defer release()
	res, _ := r.readKacoHTTP(ctx, p)
	if res == nil {
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse}
	}
	return testReadResult{OK: true, Reading: toTestReading(res.Reading, role), Serial: res.Serial}
}

// kacoHTTPSourceReading is the executor's kaco_http branch.
func kacoHTTPSourceReading(res *kacohttp.Result) inverterSourceReading {
	if res == nil {
		return inverterSourceReading{why: "keine KACO-Antwort (Timeout, oder die Kommunikationseinheit meldet keinen Wechselrichter)"}
	}
	return inverterSourceReading{reading: res.Reading}
}

func kacoHTTPNote(id, role string, p *kacoHTTPPlan) string {
	return "Quelle " + id + " (" + role + "): kaco_http " + p.IP + ":" + strconv.Itoa(p.Port) + " -> Leseplan (App-Schnittstelle)"
}
