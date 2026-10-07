package layer1

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/goeapi"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// Defaults of the Node-RED "Energiequellen (automatisch)" tab.
const (
	DefaultSourcesFirstPoll = 4 * time.Second // inject "sources-poll": once after 4 s
	DefaultSourcesPoll      = 5 * time.Second // ... then every 5 s
	sameIPGrace             = 400 * time.Millisecond
	sourceOverallTimeout    = 30 * time.Second
	failLogEvery            = 60 * time.Second
	maxHTTPBody             = 262144 // the flow destroys the request beyond this
)

// The flow's reason when a go-e read yields no usable charging power.
const goeNoValue = "keine go-e-Antwort / kein Ladewert (Timeout, Verbindung abgewiesen oder HTTP-API deaktiviert)"

// errHTTPStatus / errBodyTooLarge / ErrNotJSON are "a frame came back but it
// is not a usable answer" (invalid_response); a transport error is not.
var (
	errHTTPStatus   = errors.New("HTTP-Status >= 400")
	errBodyTooLarge = errors.New("Antwort zu gross")
)

// newHTTPClient is the read-only client for LAN devices: no proxy from the
// environment, no keep-alive (the go-e's ESP32 has few sockets; one short
// request every 5 s needs none).
func newHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:             nil,
			DisableKeepAlives: true,
			DialContext:       (&net.Dialer{Timeout: timeout}).DialContext,
		},
	}
}

// goeGet is the flow's httpGet + __GOE.decodeStatus: one GET, the body capped,
// parsed like JSON.parse. A transport error is returned as is (the caller
// classifies timeout vs refused); a bad answer as errHTTPStatus /
// errBodyTooLarge / goeapi.ErrNotJSON; a non-object answer as (nil, nil).
func (r *Runtime) goeGet(ctx context.Context, url string) (*goeapi.Result, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := r.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
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
	return goeapi.Decode(body)
}

// isTimeout: the request ran into its deadline (no answer in time) - as
// opposed to a refused/unroutable connection.
func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout() || errors.Is(err, context.DeadlineExceeded)
}

// --- the source poll (the flow's "sources-read" node) ---------------------------

// runSources reads every planned source in turn: first after
// SourcesFirstPoll, then every SourcesPoll. A cycle that outlasts the period
// makes the next tick drop instead of stacking (the flow's busy-skip).
func (r *Runtime) runSources(ctx context.Context) {
	first := time.NewTimer(r.opts.SourcesFirstPoll)
	defer first.Stop()
	select {
	case <-ctx.Done():
		return
	case <-first.C:
	}
	tick := time.NewTicker(r.opts.SourcesPoll)
	defer tick.Stop()
	for {
		r.sourcesOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (r *Runtime) sourcesOnce(ctx context.Context) {
	r.srcMu.Lock()
	plans := r.srcPlans
	off := 0
	if len(plans) > 1 {
		// Fairness rotation: every cycle starts at a different source.
		off = r.srcRR % len(plans)
		r.srcRR = (off + 1) % len(plans)
	}
	r.srcMu.Unlock()
	if len(plans) == 0 {
		return
	}
	ordered := append(append([]sourcePlan(nil), plans[off:]...), plans[:off]...)
	prevIP := ""
	for _, p := range ordered {
		if ctx.Err() != nil {
			return
		}
		if prevIP != "" && p.IP == prevIP {
			// A sluggish single-session gateway gets a breath between two
			// reads of the same address.
			select {
			case <-ctx.Done():
				return
			case <-time.After(sameIPGrace):
			}
		}
		prevIP = p.IP
		r.readSource(ctx, p)
	}
}

func (r *Runtime) readSource(ctx context.Context, p sourcePlan) {
	rctx, cancel := context.WithTimeout(ctx, sourceOverallTimeout)
	defer cancel()
	release, ok := r.lanes.acquire(rctx, p.Addr, sourceOverallTimeout)
	if !ok {
		r.sourceFailed(p, "Gesamt-Timeout nach 30 s - Lesung abgebrochen (Verbindung haengt?)")
		return
	}
	res, err := r.goeGet(rctx, p.URL)
	release()

	var load *float64
	if err == nil && res != nil && res.LoadKw != nil {
		load = res.LoadKw
	}
	why := ""
	if load == nil {
		why = goeNoValue
	}
	switch p.Role {
	case sources.RoleConsumer:
		if load == nil {
			r.sourceFailed(p, why)
			return
		}
		r.publishSource(p, map[string]any{"load_kw": *load})
	case sources.RoleNetz:
		// A go-e measures no grid power: the flow fails this source each tick.
		r.sourceFailed(p, orDefault(why, "kein Netzwert in der Antwort"))
	default:
		r.sourceFailed(p, orDefault(why, "kein PV-Wert in der Antwort"))
	}
}

func orDefault(s, def string) string {
	if s != "" {
		return s
	}
	return def
}

// publishSource sends edge/sources/{id}/telemetry like vp-verbraucher: QoS 1,
// not retained, ts as Date.toISOString(). An id that would break the topic is
// refused (the node does the same).
func (r *Runtime) publishSource(p sourcePlan, values map[string]any) {
	if strings.ContainsAny(p.ID, "/#+") {
		r.sourceTrace(p.ID, "badid", true, "Quelle "+p.ID+": ungueltige Quellen-ID fuer ein MQTT-Topic - nicht veroeffentlicht")
		return
	}
	values["ts"] = isoMillis(r.opts.Now())
	raw, _ := json.Marshal(values)
	if err := r.bus.Publish(sources.TopicPrefix+p.ID+"/telemetry", raw, false); err != nil {
		r.log.Warn("Quellen-Messwert konnte nicht auf den lokalen Bus", "quelle", p.ID, "err", err)
		return
	}
	text := "Quelle " + p.ID + ": "
	for _, k := range []string{"load_kw", "power_kw", "pv_power_kw"} {
		if v, ok := values[k]; ok {
			text += k + "=" + strconv.FormatFloat(v.(float64), 'f', -1, 64)
		}
	}
	r.sourceTrace(p.ID, "ok", false, text+" -> veroeffentlicht auf "+sources.TopicPrefix+p.ID+"/telemetry")
}

func (r *Runtime) sourceFailed(p sourcePlan, why string) {
	r.sourceTrace(p.ID, "fail:"+why, true, "Quelle "+p.ID+" (goe_http_api "+p.IP+":"+strconv.Itoa(p.Port)+"): "+why)
}

// sourceTrace is the flow's trace(): a class (ok / fail:<why>) is logged when
// it changes, and repeated at most once per minute. A repeated ok is debug -
// the box's log stays readable on a 64-KB ring buffer.
func (r *Runtime) sourceTrace(id, class string, warn bool, line string) {
	now := r.opts.Now()
	r.srcMu.Lock()
	st := r.srcTrace[id]
	repeat := st.class == class
	if repeat && now.Sub(st.at) < failLogEvery {
		r.srcMu.Unlock()
		return
	}
	r.srcTrace[id] = traceState{class: class, at: now}
	r.srcMu.Unlock()
	switch {
	case warn:
		r.log.Warn(line)
	case repeat:
		r.log.Debug(line)
	default:
		r.log.Info(line)
	}
}

type traceState struct {
	class string
	at    time.Time
}

// --- "Verbindung testen" for a go-e (test-read.js readGoe) ----------------------

func (r *Runtime) testGoe(ctx context.Context, sel *selection, role string) testReadResult {
	ip, _ := sel.Connection["ip"].(string)
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return testReadResult{ErrorCode: testconn.ErrInvalidRequest, Message: "keine IP-Adresse"}
	}
	port := int(num(sel.Connection["port"], 80))
	addr := ip + ":" + strconv.Itoa(port)
	release, ok := r.lanes.acquire(ctx, addr, r.opts.LaneWait)
	if !ok {
		return testReadResult{ErrorCode: testconn.ErrNoAnswer,
			Message: "Das Gerät ist gerade mit einer anderen Abfrage beschäftigt - bitte gleich noch einmal testen."}
	}
	defer release()

	res, err := r.goeGet(ctx, goeapi.StatusURL(ip, port))
	switch {
	case err == nil && res != nil && res.LoadKw != nil:
		return testReadResult{OK: true, Reading: toTestReading(map[string]float64{"load_kw": *res.LoadKw}, role)}
	case err == nil, errors.Is(err, errHTTPStatus), errors.Is(err, errBodyTooLarge), errors.Is(err, goeapi.ErrNotJSON):
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse}
	case isTimeout(err):
		return testReadResult{ErrorCode: testconn.ErrNoAnswer}
	default:
		return testReadResult{ErrorCode: testconn.ErrUnreachable}
	}
}
