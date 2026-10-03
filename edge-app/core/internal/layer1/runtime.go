package layer1

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/deyedecode"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
)

// Defaults mirror the Node-RED self-wiring tab "Wechselrichter (automatisch)".
const (
	DefaultFirstPoll   = 3 * time.Second  // inject "poll": once after 3 s
	DefaultPoll        = 5 * time.Second  // ... then every 5 s
	DefaultLinkTimeout = 15 * time.Second // trigger "15s ohne Messwert -> down"
	defaultIOTimeout   = 8 * time.Second  // solarman reader + test-read.js
)

// Options configures a Runtime. Zero values take the Node-RED defaults.
type Options struct {
	FirstPoll      time.Duration
	Poll           time.Duration
	LinkTimeout    time.Duration
	ConnectTimeout time.Duration
	ReadTimeout    time.Duration
	// LaneWait bounds how long a one-shot (the connection test) waits for a
	// running poll to release the logger.
	LaneWait time.Duration
	// SourcesFirstPoll / SourcesPoll pace the additional sources (the
	// "Energiequellen (automatisch)" tab: after 4 s, then every 5 s).
	SourcesFirstPoll time.Duration
	SourcesPoll      time.Duration
	// HTTPTimeout bounds one HTTP read of a LAN device (go-e): 8 s like the flow.
	HTTPTimeout time.Duration
	Dialer      solarmanv5.Dialer
	Now         func() time.Time
	Logger      *slog.Logger
}

// Runtime is the Go Layer 1.
type Runtime struct {
	bus  Bus
	opts Options
	log  *slog.Logger

	lanes *lanes

	mu       sync.Mutex
	sel      *selection
	idleWhy  string // last logged idle reason (log once per change)
	seq      uint16 // V5 sequence carried across polls (the flow's context.seq)
	lastOK   time.Time
	linkUp   bool // the last published inverter_link
	armed    bool // a measurement was published since the last "down"
	lastErr  string
	pollKick chan struct{}
	ready    chan struct{}

	// the additional sources (sources.go, goe.go)
	http     *http.Client
	srcMu    sync.Mutex
	srcPlans []sourcePlan
	srcRR    int
	srcSig   string
	srcTrace map[string]traceState
}

// Ready is closed once every bus subscription is confirmed.
func (r *Runtime) Ready() <-chan struct{} { return r.ready }

// New builds a Runtime on bus.
func New(bus Bus, opts Options) *Runtime {
	if opts.FirstPoll <= 0 {
		opts.FirstPoll = DefaultFirstPoll
	}
	if opts.Poll <= 0 {
		opts.Poll = DefaultPoll
	}
	if opts.LinkTimeout <= 0 {
		opts.LinkTimeout = DefaultLinkTimeout
	}
	if opts.ConnectTimeout <= 0 {
		opts.ConnectTimeout = defaultIOTimeout
	}
	if opts.ReadTimeout <= 0 {
		opts.ReadTimeout = defaultIOTimeout
	}
	if opts.LaneWait <= 0 {
		opts.LaneWait = 4 * time.Second
	}
	if opts.SourcesFirstPoll <= 0 {
		opts.SourcesFirstPoll = DefaultSourcesFirstPoll
	}
	if opts.SourcesPoll <= 0 {
		opts.SourcesPoll = DefaultSourcesPoll
	}
	if opts.HTTPTimeout <= 0 {
		opts.HTTPTimeout = defaultIOTimeout
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default().WithGroup("layer1")
	}
	return &Runtime{bus: bus, opts: opts, log: opts.Logger, lanes: newLanes(),
		pollKick: make(chan struct{}, 1), ready: make(chan struct{}),
		http: newHTTPClient(opts.HTTPTimeout), srcTrace: map[string]traceState{}}
}

// Run subscribes the bus topics and polls until ctx ends.
func (r *Runtime) Run(ctx context.Context) error {
	if err := r.bus.Subscribe(localbus.TopicInverterConfig, r.onInverterConfig); err != nil {
		return err
	}
	if err := r.bus.Subscribe(localbus.TopicTestReadRequest, func(_ string, p []byte) {
		go r.onTestRead(ctx, p)
	}); err != nil {
		return err
	}
	if err := r.bus.Subscribe(TopicSourcesConfig, r.onSourcesConfig); err != nil {
		return err
	}
	close(r.ready)
	go r.runSources(ctx)

	timer := time.NewTimer(r.opts.FirstPoll)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
		case <-r.pollKick:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
		r.pollOnce(ctx)
		r.checkLink()
		timer.Reset(r.opts.Poll)
	}
}

func (r *Runtime) onInverterConfig(_ string, payload []byte) {
	s, err := parseSelection(payload)
	if err != nil {
		r.log.Warn("Wechselrichter-Auswahl verworfen", "err", err)
		return
	}
	r.mu.Lock()
	r.sel = s
	r.idleWhy = ""
	r.mu.Unlock()
	if s != nil {
		r.log.Info("Wechselrichter-Auswahl uebernommen", "marke", s.Brand, "modell", s.Model, "familie", s.Family, "anbindung", s.Communication)
	}
	select {
	case r.pollKick <- struct{}{}:
	default:
	}
}

// idle logs a (changed) idle reason once - the Node-RED router's grey status.
func (r *Runtime) idle(reason string) {
	r.mu.Lock()
	changed := r.idleWhy != reason
	r.idleWhy = reason
	r.mu.Unlock()
	if changed {
		r.log.Info("Lesen untaetig", "grund", reason)
	}
}

func (r *Runtime) pollOnce(ctx context.Context) {
	r.mu.Lock()
	s := r.sel
	r.mu.Unlock()
	if s == nil {
		r.idle("keine Auswahl")
		return
	}
	switch s.Communication {
	case CommSolarmanV5:
		p, why := planSolarman(s)
		if p == nil {
			r.idle(why)
			return
		}
		r.pollSolarman(ctx, p)
	default:
		// Honest, not silent: the parity matrix names what is ported. The core
		// then shows "keine aktuellen Daten" exactly as for a dead device.
		r.idle("Edge Light liest die Anbindung \"" + s.Communication + "\" noch nicht")
	}
}

func (r *Runtime) pollSolarman(ctx context.Context, p *solarmanPlan) {
	// One logger, one client: a poll whose lane is held (a connection test is
	// talking to the logger) skips this tick - "Logger belegt - Lesen
	// uebersprungen" - instead of opening a second socket.
	release, ok := r.lanes.tryAcquire(p.Addr)
	if !ok {
		r.log.Debug("Logger belegt - Lesen uebersprungen", "ziel", p.Addr)
		return
	}
	defer release()

	r.mu.Lock()
	seq := r.seq
	r.mu.Unlock()

	sess, err := solarmanv5.Dial(ctx, r.opts.Dialer, p.Addr, p.Serial, p.Slave, r.opts.ConnectTimeout, r.opts.ReadTimeout)
	if err != nil {
		r.readFailed(p, err)
		return
	}
	sess.SetSequence(seq)
	blocks, err := sess.ReadPlan(ctx, p.Reads)
	_ = sess.Close()
	r.mu.Lock()
	r.seq = sess.Sequence()
	r.mu.Unlock()
	if err != nil {
		r.readFailed(p, err)
		return
	}

	res := deyedecode.Decode(toBlocks(blocks), p.Decode)
	if res == nil {
		// The SoC gate dropped the read (no answer / out of range / missing
		// without opt-in): NOTHING is published - never a fabricated value.
		r.noteError(p, "SoC unplausibel -> verworfen")
		return
	}
	reading := telemetryPayload(res, r.opts.Now())
	if len(reading) <= 1 { // only ts
		r.noteError(p, "keine Messwerte decodiert")
		return
	}
	raw, _ := json.Marshal(reading)
	if err := r.bus.Publish(localbus.TopicTelemetry, raw, false); err != nil {
		r.log.Warn("Messwert konnte nicht auf den lokalen Bus", "err", err)
		return
	}
	r.mu.Lock()
	r.lastOK = r.opts.Now()
	r.lastErr = ""
	r.armed = true
	r.mu.Unlock()
	r.publishLink(true)
}

func (r *Runtime) readFailed(p *solarmanPlan, err error) {
	r.noteError(p, "V5: "+err.Error())
}

// noteError logs a changed failure once (the flow node's red status).
func (r *Runtime) noteError(p *solarmanPlan, msg string) {
	r.mu.Lock()
	changed := r.lastErr != msg
	r.lastErr = msg
	r.mu.Unlock()
	if changed {
		r.log.Warn("Wechselrichter-Lesung fehlgeschlagen", "ziel", p.Addr, "grund", msg)
	}
}

// telemetryPayload is the edge/telemetry message: the decoded reading plus ts,
// soc_source (local-bus provenance) and battery_power_kw (the MEASURED battery
// term of the house balance) - the fields the Node-RED decode node emits.
func telemetryPayload(res *deyedecode.Result, now time.Time) map[string]any {
	out := make(map[string]any, len(res.Reading)+3)
	for k, v := range res.Reading {
		out[k] = v
	}
	if len(out) == 0 {
		return map[string]any{"ts": isoMillis(now)}
	}
	if res.SocSource != "" {
		out["soc_source"] = res.SocSource
	}
	if res.BattKw != nil {
		out["battery_power_kw"] = *res.BattKw
	}
	out["ts"] = isoMillis(now)
	return out
}

// isoMillis is JavaScript's Date.toISOString().
func isoMillis(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// publishLink sends edge/status (vp-status shape).
func (r *Runtime) publishLink(up bool) {
	link := "down"
	if up {
		link = "up"
	}
	raw, _ := json.Marshal(map[string]string{"inverter_link": link, "ts": isoMillis(r.opts.Now())})
	if err := r.bus.Publish(localbus.TopicStatus, raw, false); err != nil {
		r.log.Warn("Status konnte nicht auf den lokalen Bus", "err", err)
		return
	}
	r.mu.Lock()
	r.linkUp = up
	r.mu.Unlock()
}

// checkLink is the flow's trigger node: LinkTimeout after the LAST published
// measurement, "down" is published once. Before the first measurement nothing
// is said (the trigger is not armed).
func (r *Runtime) checkLink() {
	r.mu.Lock()
	armed, last := r.armed, r.lastOK
	r.mu.Unlock()
	if !armed || r.opts.Now().Sub(last) < r.opts.LinkTimeout {
		return
	}
	r.mu.Lock()
	r.armed = false
	r.mu.Unlock()
	r.publishLink(false)
}

// --- the per-logger lane -------------------------------------------------------

// lanes serialize every socket to one logger address (the loggers serve one
// client; a second connection would cut off the first). Poll and connection
// test share it.
type lanes struct {
	mu    sync.Mutex
	locks map[string]chan struct{}
}

func newLanes() *lanes { return &lanes{locks: map[string]chan struct{}{}} }

func (l *lanes) lane(addr string) chan struct{} {
	l.mu.Lock()
	defer l.mu.Unlock()
	ch, ok := l.locks[addr]
	if !ok {
		ch = make(chan struct{}, 1)
		l.locks[addr] = ch
	}
	return ch
}

func (l *lanes) tryAcquire(addr string) (func(), bool) {
	ch := l.lane(addr)
	select {
	case ch <- struct{}{}:
		return func() { <-ch }, true
	default:
		return nil, false
	}
}

func (l *lanes) acquire(ctx context.Context, addr string, wait time.Duration) (func(), bool) {
	ch := l.lane(addr)
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case ch <- struct{}{}:
		return func() { <-ch }, true
	case <-t.C:
		return nil, false
	case <-ctx.Done():
		return nil, false
	}
}
