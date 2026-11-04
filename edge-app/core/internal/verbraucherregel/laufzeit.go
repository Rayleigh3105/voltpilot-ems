package verbraucherregel

// The runtime around the node twin: it takes the flow artifacts the core's
// flow deployer verified (internal/flowdeploy, the same retained .../v2/flows
// set the Docker box materializes in Node-RED), runs every generated
// vp-consumer-policy node with its compiled inject trigger, and speaks the
// local bus exactly like the palette node does.
//
// Only a bundle made of the generated consumer-rule shape is accepted (one
// tab, vp-consumer-policy nodes and inject triggers wired to them); anything
// else - a customer automation from the flow editor - is refused with a
// reason, never half-run.

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flowdeploy"
)

// PaletteStand is the palette version whose vp-consumer-policy node this twin
// reproduces (flowc catalog: vp.consumer.reactive minPalette 0.5.0). An
// artifact that needs a newer palette is refused until the twin catches up.
const PaletteStand = "0.5.0"

// NodeType is the palette node this package runs.
const NodeType = "vp-consumer-policy"

// onceDelayDefault is Node-RED's inject default when onceDelay is absent.
const onceDelayDefault = 100 * time.Millisecond

// Bus is the local bus (layer1.MQTTBus satisfies it).
type Bus interface {
	Subscribe(topic string, fn func(topic string, payload []byte)) error
	Publish(topic string, payload []byte, retain bool) error
}

// Timer is a stoppable scheduled call.
type Timer interface{ Stop() bool }

// Clock is time for the runtime (real by default, fake in tests).
type Clock interface {
	Now() time.Time
	AfterFunc(d time.Duration, f func()) Timer
}

type realClock struct{}

func (realClock) Now() time.Time                            { return time.Now() }
func (realClock) AfterFunc(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }

// trigger is one compiled inject node.
type trigger struct {
	once      bool
	onceDelay time.Duration
	repeat    time.Duration // 0 = none
	targets   []string      // ids of vp-consumer-policy nodes
}

// rule is one running vp-consumer-policy node.
type rule struct {
	id string
	rt *Runtime
}

// flow is one running artifact.
type flow struct {
	flowID      string
	contentHash string
	rules       map[string]*rule
	timers      []Timer // one slot per inject node: the pending fire
	stopped     bool
}

// Laufzeit runs the accepted artifacts. It is safe for concurrent use.
type Laufzeit struct {
	bus   Bus
	clock Clock
	log   *slog.Logger

	mu         sync.Mutex
	flows      map[string]*flow
	subscribed bool
	closed     bool

	out chan outMsg
}

type outMsg struct {
	topic   string
	payload []byte
}

// Options configure a Laufzeit.
type Options struct {
	Clock  Clock
	Logger *slog.Logger
}

// New builds the runtime on bus and starts its sender.
func New(bus Bus, o Options) *Laufzeit {
	if o.Clock == nil {
		o.Clock = realClock{}
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	l := &Laufzeit{bus: bus, clock: o.Clock, log: o.Logger, flows: map[string]*flow{},
		out: make(chan outMsg, 256)}
	go l.send()
	return l
}

// send publishes in order outside every bus handler (Publish waits for the
// broker; a handler must not block).
func (l *Laufzeit) send() {
	for m := range l.out {
		if err := l.bus.Publish(m.topic, m.payload, false); err != nil {
			l.log.Warn("Verbraucherregel: Wunsch nicht gesendet", "topic", m.topic, "err", err)
		}
	}
}

// PaletteVersion implements flowdeploy.LokaleLaufzeit.
func (l *Laufzeit) PaletteVersion() string { return PaletteStand }

// bundleNode is the slice of a bundle node the runtime reads.
type bundleNode struct {
	ID        string     `json:"id"`
	Type      string     `json:"type"`
	Z         string     `json:"z"`
	Wires     [][]string `json:"wires"`
	Repeat    any        `json:"repeat"`
	Crontab   string     `json:"crontab"`
	Once      bool       `json:"once"`
	OnceDelay any        `json:"onceDelay"`
}

type parsed struct {
	rules    map[string]Config
	triggers []trigger
}

// parseBundle reads a bundle of the generated consumer-rule shape, or names
// why it is not one.
func parseBundle(b flowdeploy.Bundle) (*parsed, string) {
	tabs := map[string]bool{}
	for _, id := range b.TabIDs {
		tabs[id] = true
	}
	p := &parsed{rules: map[string]Config{}}
	var injects []bundleNode
	for _, raw := range b.NoderedFlows {
		var n bundleNode
		if err := json.Unmarshal(raw, &n); err != nil {
			return nil, "Bundle-Knoten nicht lesbar"
		}
		switch n.Type {
		case "tab":
			continue
		case NodeType:
			var cfg map[string]any
			if err := json.Unmarshal(raw, &cfg); err != nil {
				return nil, "Verbraucherregel nicht lesbar"
			}
			if !tabs[n.Z] {
				return nil, "Verbraucherregel liegt in keinem Tab des Artefakts"
			}
			p.rules[n.ID] = Config(cfg)
		case "inject":
			if !tabs[n.Z] {
				return nil, "Auslöser liegt in keinem Tab des Artefakts"
			}
			injects = append(injects, n)
		default:
			return nil, "Knoten " + n.Type + " läuft auf dieser Box nicht (Edge Light führt nur " +
				"Verbraucherregeln aus)"
		}
	}
	if len(p.rules) == 0 {
		return nil, "kein Knoten " + NodeType + " im Artefakt (Edge Light führt nur " +
			"Verbraucherregeln aus)"
	}
	for _, n := range injects {
		if strings.TrimSpace(n.Crontab) != "" {
			return nil, "Auslöser mit Zeitplan (crontab) läuft auf dieser Box nicht"
		}
		t := trigger{once: n.Once}
		rep := jsNumber(n.Repeat, n.Repeat != nil)
		if n.Repeat != nil && !math.IsNaN(rep) && rep > 0 {
			t.repeat = time.Duration(rep * float64(time.Second))
		}
		t.onceDelay = onceDelayDefault
		if n.OnceDelay != nil {
			if d := jsNumber(n.OnceDelay, true); !math.IsNaN(d) && d > 0 {
				t.onceDelay = time.Duration(d * float64(time.Second))
			}
		}
		for _, port := range n.Wires {
			for _, target := range port {
				if _, ok := p.rules[target]; !ok {
					return nil, "Auslöser zeigt auf einen Knoten, der keine Verbraucherregel ist"
				}
				t.targets = append(t.targets, target)
			}
		}
		p.triggers = append(p.triggers, t)
	}
	return p, ""
}

// Annehmbar implements flowdeploy.LokaleLaufzeit: can this runtime run the
// bundle? The reason is German and lands in the flows ack.
func (l *Laufzeit) Annehmbar(b flowdeploy.Bundle) (bool, string) {
	if _, why := parseBundle(b); why != "" {
		return false, why
	}
	return true, ""
}

// Angleichen implements flowdeploy.LokaleLaufzeit: run exactly these
// artifacts. An unchanged artifact (same flow id and content hash) keeps
// running with its state - like Node-RED's 'flows' deploy, which restarts only
// changed flows; a changed one restarts fresh; a removed one stops (its
// desired then simply expires by TTL - withdrawal is the absence of renewal).
func (l *Laufzeit) Angleichen(artifacts []flowdeploy.Artifact) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return fmt.Errorf("Verbraucherregeln beendet")
	}
	if !l.subscribed && len(artifacts) > 0 {
		if err := l.subscribeLocked(); err != nil {
			return err
		}
	}
	want := map[string]flowdeploy.Artifact{}
	for _, a := range artifacts {
		want[a.FlowID] = a
	}
	for id, f := range l.flows {
		if a, ok := want[id]; ok && a.ContentHash == f.contentHash {
			continue
		}
		l.stopLocked(f)
		delete(l.flows, id)
	}
	ids := make([]string, 0, len(want))
	for id := range want {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var errs []string
	for _, id := range ids {
		if _, running := l.flows[id]; running {
			continue
		}
		a := want[id]
		p, why := parseBundle(a.Bundle)
		if why != "" {
			errs = append(errs, a.FlowID+": "+why)
			continue
		}
		l.flows[id] = l.startLocked(a, p)
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

func (l *Laufzeit) subscribeLocked() error {
	if err := l.bus.Subscribe(TopicSite, l.onMessage); err != nil {
		return fmt.Errorf("lokaler Bus: %w", err)
	}
	if err := l.bus.Subscribe(TopicPrefix+"+/telemetry", l.onMessage); err != nil {
		return fmt.Errorf("lokaler Bus: %w", err)
	}
	l.subscribed = true
	return nil
}

func (l *Laufzeit) startLocked(a flowdeploy.Artifact, p *parsed) *flow {
	f := &flow{flowID: a.FlowID, contentHash: a.ContentHash, rules: map[string]*rule{}}
	ids := make([]string, 0, len(p.rules))
	for id := range p.rules {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		f.rules[id] = &rule{id: id, rt: NewRuntime(p.rules[id])}
	}
	for _, t := range p.triggers {
		l.armLocked(f, t)
	}
	l.log.Info("Verbraucherregel gestartet", "flow_id", a.FlowID, "flow_version", a.FlowVersion,
		"regeln", len(f.rules))
	return f
}

// armLocked schedules one inject node like Node-RED does: with `once` the
// first fire comes after onceDelay and the repeat starts from there, without
// it the repeat starts at deploy. Each inject node owns ONE timer slot, so a
// long-running repeat never piles up timers.
func (l *Laufzeit) armLocked(f *flow, t trigger) {
	slot := len(f.timers)
	f.timers = append(f.timers, nil)
	var tick func(first bool)
	schedule := func(d time.Duration, first bool) {
		f.timers[slot] = l.clock.AfterFunc(d, func() { tick(first) })
	}
	tick = func(first bool) {
		l.mu.Lock()
		defer l.mu.Unlock()
		if f.stopped {
			return
		}
		l.triggerLocked(f, t.targets)
		if t.repeat > 0 {
			schedule(t.repeat, false)
		}
	}
	switch {
	case t.once:
		schedule(t.onceDelay, true)
	case t.repeat > 0:
		schedule(t.repeat, false)
	}
}

func (l *Laufzeit) triggerLocked(f *flow, targets []string) {
	now := l.clock.Now().UnixMilli()
	for _, id := range targets {
		if r, ok := f.rules[id]; ok {
			l.emitLocked(r, r.rt.OnTrigger(now))
		}
	}
}

func (l *Laufzeit) stopLocked(f *flow) {
	f.stopped = true
	for _, t := range f.timers {
		if t != nil {
			t.Stop()
		}
	}
	f.timers = nil
	l.log.Info("Verbraucherregel beendet", "flow_id", f.flowID)
}

// emitLocked queues the desired of one step.
func (l *Laufzeit) emitLocked(r *rule, s Step) {
	if s.Publish == nil || l.closed {
		return
	}
	if !idRE.MatchString(r.rt.Entity()) {
		return
	}
	raw, err := json.Marshal(s.Publish)
	if err != nil {
		return
	}
	select {
	case l.out <- outMsg{topic: TopicPrefix + r.rt.Entity() + "/desired", payload: raw}:
	default:
		l.log.Warn("Verbraucherregel: Sendewarteschlange voll, Wunsch verworfen",
			"entity", r.rt.Entity())
	}
}

// onMessage handles edge/telemetry and edge/entities/<id>/telemetry.
func (l *Laufzeit) onMessage(topic string, payload []byte) {
	var obj any
	if err := json.Unmarshal(payload, &obj); err != nil {
		return
	}
	entity := ""
	if topic != TopicSite {
		mid, ok := strings.CutPrefix(topic, TopicPrefix)
		if !ok || !strings.HasSuffix(mid, "/telemetry") {
			return
		}
		entity = strings.TrimSuffix(mid, "/telemetry")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock.Now().UnixMilli()
	ids := make([]string, 0, len(l.flows))
	for id := range l.flows {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		f := l.flows[id]
		for _, rid := range sortedRuleIDs(f) {
			r := f.rules[rid]
			if !idRE.MatchString(r.rt.Entity()) {
				continue // the node does not even subscribe (status "Entität ungültig")
			}
			switch {
			case topic == TopicSite:
				l.emitLocked(r, r.rt.OnSite(obj, now))
			case entity == r.rt.Entity():
				l.emitLocked(r, r.rt.OnEntity(obj, now))
			}
		}
	}
}

func sortedRuleIDs(f *flow) []string {
	ids := make([]string, 0, len(f.rules))
	for id := range f.rules {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Laufend lists the running flows as "flow_id@content_hash" (for tests and logs).
func (l *Laufzeit) Laufend() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, 0, len(l.flows))
	for _, f := range l.flows {
		out = append(out, f.flowID+"@"+f.contentHash)
	}
	sort.Strings(out)
	return out
}

// Close stops every flow and the sender.
func (l *Laufzeit) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return
	}
	for id, f := range l.flows {
		l.stopLocked(f)
		delete(l.flows, id)
	}
	l.closed = true
	close(l.out)
}
