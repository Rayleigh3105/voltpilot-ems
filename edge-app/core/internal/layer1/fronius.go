package layer1

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/froniusapi"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// A Fronius over its Solar API v1: the Go twin of the flow's "Fronius Solar
// API lesen" + decode nodes, the fronius_solar_api branch of the source
// executor and readFronius of test-read.js, on top of solar-api.js. ONE GET on
// GetPowerFlowRealtimeData.fcgi per tick; https (with a self-signed
// certificate accepted) only when the operator ticked insecure_tls. Read only.

// CommFroniusSolarAPI is inverter.CommFroniusSolarAPI.
const CommFroniusSolarAPI = "fronius_solar_api"

// froniusPollTimeout is the primary read node's 5 s; the source executor and
// the connection test use the 8-s HTTP budget.
const froniusPollTimeout = 5 * time.Second

var errFroniusNoReading = errors.New("fronius: keine Messwerte (kein JSON, BadStatus oder keine Site-Werte)")

// froniusPlan is the resolved read plan (router branch / store node).
type froniusPlan struct {
	IP             string
	Port           int
	Addr           string
	URL            string
	Insecure       bool
	InvertGridSign bool
}

// planFronius builds the plan without judging the family: the router checks
// it for the primary inverter, the store node and test-read.js do not.
func planFronius(s *selection) (*froniusPlan, string) {
	conn := s.Connection
	ip, _ := conn["ip"].(string)
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return nil, "keine IP-Adresse"
	}
	port := int(num(conn["port"], froniusapi.DefaultPort))
	if port <= 0 || port > 65535 {
		port = froniusapi.DefaultPort
	}
	insecure := truthy(conn["insecure_tls"])
	scheme := "http"
	if insecure {
		scheme = "https"
	}
	return &froniusPlan{IP: ip, Port: port, Addr: netJoin(ip, port), URL: froniusapi.PowerFlowURL(scheme, urlHost(ip), port),
		Insecure: insecure, InvertGridSign: truthy(conn["invert_grid_sign"])}, ""
}

// urlHost brackets an IPv6 literal for a URL.
func urlHost(ip string) string {
	if strings.Contains(ip, ":") && !strings.HasPrefix(ip, "[") {
		return "[" + ip + "]"
	}
	return ip
}

// getFronius is the flow's GET + JSON.parse + decodePowerFlow: a transport
// error is returned as is, an answer without a reading as errFroniusNoReading.
func (r *Runtime) getFronius(ctx context.Context, p *froniusPlan, timeout time.Duration) (*froniusapi.Result, error) {
	rctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	body, err := r.httpGet(rctx, p.URL, p.Insecure)
	if err != nil {
		return nil, err
	}
	res := froniusapi.DecodeBody(body, froniusapi.Options{InvertGridSign: p.InvertGridSign})
	if res == nil {
		return nil, errFroniusNoReading
	}
	return res, nil
}

// pollFronius is one tick of the primary read path. P_Akku is calibration
// only: it is never published (the cloud derives the battery from the balance).
func (r *Runtime) pollFronius(ctx context.Context, p *froniusPlan) {
	release, ok := r.lanes.tryAcquire(p.Addr)
	if !ok {
		r.log.Debug("Fronius belegt - Lesen uebersprungen", "ziel", p.Addr)
		return
	}
	defer release()
	res, err := r.getFronius(ctx, p, froniusPollTimeout)
	if err != nil {
		r.noteError(p.Addr, "Fronius Solar API: "+err.Error())
		return
	}
	r.publishTelemetry(p.Addr, telemetryFrom(res.Reading, nil, "", r.opts.Now()))
}

// testFronius is readFronius: every failure is the one class fronius_api
// (the UI names the Solar API, not the network).
func (r *Runtime) testFronius(ctx context.Context, p *froniusPlan, role string) testReadResult {
	release, ok := r.lanes.acquire(ctx, p.Addr, r.opts.LaneWait)
	if !ok {
		return testReadResult{ErrorCode: testconn.ErrNoAnswer,
			Message: "Der Wechselrichter ist gerade mit einer anderen Abfrage beschäftigt - bitte gleich noch einmal testen."}
	}
	defer release()
	res, err := r.getFronius(ctx, p, r.opts.HTTPTimeout)
	if err != nil {
		return testReadResult{ErrorCode: testconn.ErrFroniusAPI}
	}
	return testReadResult{OK: true, Reading: toTestReading(res.Reading, role)}
}

// froniusSourceReading is the executor's fronius_solar_api branch: PV, grid
// and load from the one reading.
func froniusSourceReading(res *froniusapi.Result, err error) inverterSourceReading {
	if err != nil || res == nil {
		return inverterSourceReading{why: "keine Fronius-Antwort / keine Messwerte (Timeout, Verbindung abgewiesen oder Solar API deaktiviert)"}
	}
	return inverterSourceReading{reading: res.Reading, withLoad: true}
}

// httpGet is ONE GET of a LAN device's API: the body of an answer below 400,
// capped like the flow (it destroys the request beyond maxHTTPBody). insecure
// accepts a self-signed certificate - only ever for an https URL the operator
// asked for (insecure_tls).
func (r *Runtime) httpGet(ctx context.Context, url string, insecure bool) ([]byte, error) {
	return r.httpGetWhere(ctx, url, insecure, func(status int) bool { return status < 400 })
}

// httpGetWhere is httpGet with the device module's own rule for an accepted
// status (kaco-http.js takes exactly 200).
func (r *Runtime) httpGetWhere(ctx context.Context, url string, insecure bool, accept func(status int) bool) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	client := r.http
	if insecure {
		client = r.insecureHTTP()
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if !accept(res.StatusCode) {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxHTTPBody))
		return nil, errHTTPStatus
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxHTTPBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxHTTPBody {
		return nil, errBodyTooLarge
	}
	return body, nil
}

// insecureHTTP is the client for insecure_tls: TLS without certificate
// verification (the GEN24 / KACO-stick self-signed certificate), built once.
func (r *Runtime) insecureHTTP() *http.Client {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.httpNoVerify == nil {
		timeout := r.opts.HTTPTimeout
		r.httpNoVerify = &http.Client{
			Timeout: timeout,
			Transport: &http.Transport{
				Proxy:             nil,
				DisableKeepAlives: true,
				DialContext:       (&net.Dialer{Timeout: timeout}).DialContext,
				// The operator's explicit choice for a LAN device with a
				// self-signed certificate; never set without insecure_tls.
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
			},
		}
	}
	return r.httpNoVerify
}
