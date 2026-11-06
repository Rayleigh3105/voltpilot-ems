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

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/datasourcestatus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/goeapi"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/huaweidecode"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/kacoserial"
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

// sourceOutcome is one source read as the executor books it: the channel the
// role publishes, or why there is none - and the evidence of the read for the
// source status (requests made, error class of a failure).
type sourceOutcome struct {
	values   map[string]float64
	why      string
	requests int
	class    string
}

// readSource reads one planned source by its transport and publishes the
// channel its ROLE asks for - or names why nothing was published. Either way
// the read leaves a receipt on edge/data-sources/poll, like the flow's
// source executor (reportSource).
func (r *Runtime) readSource(ctx context.Context, p sourcePlan) {
	rctx, cancel := context.WithTimeout(ctx, sourceOverallTimeout)
	defer cancel()
	release, ok := r.lanes.acquire(rctx, p.Addr, sourceOverallTimeout)
	if !ok {
		r.finishSource(p, sourceOutcome{why: "Gesamt-Timeout nach 30 s - Lesung abgebrochen (Verbindung haengt?)", class: "timeout"})
		return
	}
	var out sourceOutcome
	switch p.Comm {
	case CommHuaweiModbus:
		rd, err := r.readHuawei(rctx, p.Huawei)
		release()
		in := huaweiSourceReading(rd, err, p.Huawei)
		in.requests, in.class = 1, errorClassOf(rctx, err, false)
		if rd != nil {
			in.requests = rd.Attempts
			if len(rd.Blocks) == 0 {
				in.class = "invalid_response"
			}
		}
		out = inverterOutcome(p, in)
	case CommKacoSerial:
		raw, err := kacoserial.Read(rctx, r.dialTCP, p.Kaco.Addr, p.Kaco.Address, r.kacoOpts())
		release()
		in := kacoSourceReading(raw, err)
		in.requests, in.class = 1, errorClassOf(rctx, err, false)
		switch {
		case errors.Is(err, kacoserial.ErrNoAnswer):
			in.class = "no_answer" // connected, the converter stayed silent
		case errors.Is(err, kacoserial.ErrClosed):
			in.class = "invalid_response" // closed before a reply (busy / not in TCP-server mode)
		}
		if err == nil && in.reading == nil {
			in.class = "invalid_response"
		}
		out = inverterOutcome(p, in)
	case CommSunSpecTCP, CommFroniusSunSpec:
		l, err := r.readSunSpec(rctx, p.Sunspec)
		release()
		in := sunspecSourceReading(l, err)
		in.requests, in.class = 1, errorClassOf(rctx, err, false)
		if l != nil && l.Requests > 1 {
			in.requests = l.Requests
		}
		if err == nil && in.reading == nil {
			in.class = "invalid_response"
		}
		out = inverterOutcome(p, in)
	case CommShellyEM:
		out = r.readShellyEMSource(rctx, p)
		release()
	default:
		res, err := r.goeGet(rctx, p.URL)
		release()
		out = goeOutcome(p, res, err)
		out.requests = 1
		if err != nil {
			out.class = errorClassOf(rctx, err, errors.Is(err, errHTTPStatus) || errors.Is(err, errBodyTooLarge) ||
				errors.Is(err, goeapi.ErrNotJSON))
		} else if out.values == nil {
			out.class = "invalid_response"
		}
	}
	r.finishSource(p, out)
}

// goeOutcome is the go-e's channel by role: a Verbraucher's load_kw; a go-e
// measures no grid power and no PV, so the flow fails those roles each tick.
func goeOutcome(p sourcePlan, res *goeapi.Result, err error) sourceOutcome {
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
			return sourceOutcome{why: why}
		}
		return sourceOutcome{values: map[string]float64{"load_kw": *load}}
	case sources.RoleNetz:
		return sourceOutcome{why: orDefault(why, "kein Netzwert in der Antwort")}
	default:
		return sourceOutcome{why: orDefault(why, "kein PV-Wert in der Antwort")}
	}
}

// finishSource publishes the outcome's channel (or names the failure) and
// leaves the receipt.
func (r *Runtime) finishSource(p sourcePlan, out sourceOutcome) {
	if out.values == nil {
		r.sourceFailed(p, out.why)
		r.reportSource(p, out.requests, 0, true, out.class)
		return
	}
	vals := make(map[string]any, len(out.values)+1)
	for k, v := range out.values {
		vals[k] = v
	}
	r.publishSource(p, vals)
	r.reportSource(p, out.requests, len(out.values), false, "")
}

// errorClassOf names a failed read in the closed vocabulary of the source
// status (datasourcestatus.ErrorClass): the overall budget ran out = timeout,
// a refused/unroutable connect = unreachable, no answer in time = no_answer,
// an answer that is no usable frame = invalid_response.
func errorClassOf(ctx context.Context, err error, answered bool) string {
	switch {
	case err == nil:
		return ""
	case answered:
		return "invalid_response"
	case ctx.Err() != nil:
		return "timeout"
	case isDialError(err):
		return "unreachable"
	case isTimeout(err):
		return "no_answer"
	}
	return "unreachable"
}

// reportSource is the flow's reportSource: one receipt per read on
// edge/data-sources/poll - the assigned data source id when the push named
// one, else the local source id; the requests the read made, the values it
// delivered and, on failure, the error class. The core resolves identity from
// its registry; the receipt is evidence, never a value.
func (r *Runtime) reportSource(p sourcePlan, requests, samples int, failed bool, class string) {
	if requests < 0 {
		requests = 0
	}
	r.srcMu.Lock()
	r.receiptSeq++
	seq := r.receiptSeq
	r.srcMu.Unlock()
	ev := datasourcestatus.Event{Ts: r.opts.Now().UTC(), EventID: r.bootID + "-" + strconv.FormatUint(seq, 10),
		Requests: &requests, Samples: samples, Failed: failed, ErrorClass: datasourcestatus.ErrorClass(class)}
	if p.DataSourceID != "" {
		ev.ID = p.DataSourceID
	} else {
		ev.SourceID = p.ID
	}
	raw, _ := json.Marshal(ev)
	if err := r.bus.Publish(datasourcestatus.Topic, raw, false); err != nil {
		r.log.Debug("Lese-Beleg nicht auf den lokalen Bus", "quelle", p.ID, "err", err)
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
	r.sourceTrace(p.ID, "fail:"+why, true, "Quelle "+p.ID+" ("+p.Comm+" "+p.IP+":"+strconv.Itoa(p.Port)+"): "+why)
}

// inverterSourceReading is what an inverter-class source (Huawei, Powador,
// SunSpec) delivered in one cycle: the decoded channels, or the reason there
// are none - plus the read's evidence for the receipt.
type inverterSourceReading struct {
	reading  map[string]float64
	why      string
	requests int
	class    string
}

func huaweiSourceReading(rd *huaweiRead, err error, p *huaweiPlan) inverterSourceReading {
	switch {
	case err != nil:
		return inverterSourceReading{why: "Huawei: keine Antwort (Timeout oder Verbindung abgewiesen): " + err.Error()}
	case len(rd.Blocks) == 0:
		return inverterSourceReading{why: "Huawei: jeder Block abgelehnt (Unit-ID " + strconv.Itoa(int(p.UnitID)) + " falsch oder Modbus TCP am Geraet nicht freigeschaltet?)"}
	}
	res := huaweidecode.Decode(rd.Blocks, p.Opts)
	if res == nil {
		return inverterSourceReading{why: "Huawei: keine Messwerte decodiert"}
	}
	return inverterSourceReading{reading: res.Reading}
}

func kacoSourceReading(raw []byte, err error) inverterSourceReading {
	if err != nil {
		return inverterSourceReading{why: "KACO seriell: " + kacoNoAnswer + ": " + err.Error()}
	}
	res := kacoserial.Decode(raw, false)
	if res == nil {
		if c, ok := kacoserial.ReplyCommandByte(raw); ok && kacoserial.ProtocolMismatch(raw) {
			return inverterSourceReading{why: "KACO seriell: Kommando-Byte " + strconv.Quote(string(c)) + " - ein anderes KACO-Protokoll, nicht die Powador-Serie 00"}
		}
		return inverterSourceReading{why: "KACO seriell: " + kacoNoAnswer}
	}
	return inverterSourceReading{reading: res.Reading}
}

// inverterOutcome is the ONE channel the source's role stands for (the flow's
// sources-read node): an Erzeuger its pv_power_kw, a Netz meter its signed
// power_kw, a Verbraucher its load_kw - an inverter has none. A channel the
// device did not deliver is a failure of this tick, never a 0.
func inverterOutcome(p sourcePlan, in inverterSourceReading) sourceOutcome {
	out := sourceOutcome{requests: in.requests, class: in.class}
	if in.reading == nil {
		out.why = in.why
		return out
	}
	key, missing := "", ""
	switch p.Role {
	case sources.RoleErzeuger:
		key, missing = "pv_power_kw", "kein PV-Wert in der Antwort"
	case sources.RoleNetz:
		key, missing = "power_kw", "kein Netzwert in der Antwort (Smart Power Sensor am Netzpunkt?)"
	default:
		out.why, out.class = "ein Wechselrichter liefert keinen Verbrauchswert (load_kw)", "invalid_response"
		return out
	}
	v, ok := in.reading[key]
	if !ok {
		out.why, out.class = missing, "invalid_response"
		return out
	}
	out.values = map[string]float64{key: v}
	return out
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
