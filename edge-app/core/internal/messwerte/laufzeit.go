package messwerte

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

// The runtime: the Go twin of measurement-runtime.js MeasurementRuntime -
// read-only, every device access injected (IO), held to
// edge-app/nodered/measurements/measurement-runtime-vectors.json.

// Topics of the local bus the runtime speaks on.
const (
	TopicConfig  = "edge/measurements/config"
	TopicStatus  = "edge/measurements/config-status"
	TopicSamples = "edge/measurements/samples"
)

// errorClasses is the closed vocabulary of a read receipt (data-source-status.js).
var errorClasses = map[string]bool{"unreachable": true, "no_answer": true, "invalid_response": true,
	"implausible": true, "fronius_api": true, "timeout": true, "layout_changed": true, "budget": true}

// Lesefehler is a failed device access with its receipt class.
type Lesefehler struct {
	Klasse string
	Text   string
}

func (e *Lesefehler) Error() string { return e.Text }

// errorClass is errorClass(): the class a failure names, "" for none.
func errorClass(err error) string {
	var l *Lesefehler
	if errors.As(err, &l) && errorClasses[l.Klasse] {
		return l.Klasse
	}
	return ""
}

// Leseauftrag is one register request of a block.
type Leseauftrag struct {
	Start, Count int
	SourceKind   string
	Target       Ziel
}

// JSONAuftrag is one HTTP request of a group: the go-e filter carries every
// selected API key of the group.
type JSONAuftrag struct {
	Group  string
	Target Ziel
	Filter string
	Points []*Punkt
}

// Beleg is the evidence of one read for the source status: the target (nil
// when unknown), the component, and what the read cost or yielded.
type Beleg struct {
	Target     *Ziel
	EntityID   string
	Requests   *int
	Samples    *int
	Failed     bool
	ErrorClass string
	PointKey   string
}

// Status is the answer to a plan (edge/measurements/config-status).
type Status struct {
	Revision  *float64
	AppliedAt time.Time
	Accepted  []string
	Rejected  []Ablehnung
}

// IO is the device access and the outbox of the runtime.
type IO interface {
	LiesRegister(ctx context.Context, a Leseauftrag) ([]uint16, error)
	// LiesJSON returns the parsed answer(s) of one request (a Shelly status
	// split into one answer per component is several).
	LiesJSON(ctx context.Context, a JSONAuftrag) ([]any, error)
	Beleg(b Beleg)
	Status(s Status)
	Proben(b Probenstapel)
	// OcppKonfigurieren asks the core to configure the charge points' sampled
	// data; the answer comes back through Laufzeit.OcppErgebnis.
	OcppKonfigurieren(revision *float64, values map[string]string)
}

// Probenstapel is one local batch (edge/measurements/samples).
type Probenstapel struct {
	CatalogVersion  string    `json:"catalog_version"`
	ObservedAt      string    `json:"observed_at"`
	Samples         []Sample  `json:"samples"`
	AppliedRevision *float64  `json:"applied_revision,omitempty"`
	Gap             bool      `json:"gap,omitempty"`
	DroppedSamples  int       `json:"dropped_samples,omitempty"`
	at              time.Time `json:"-"`
}

// reservation is the bus time a request reserves before it touches the wire.
var reservation = map[string]int64{"modbus_holding": 4000, "modbus_input": 4000, "sunspec_model": 4000,
	"http_api_key": 4000, "rest_json": 4000, "rpc_json": 4000, "erzeuger_registerbild": 4000, ocppSourceKind: 0}

type ticket struct {
	at, started, cost int64
	pending           bool
}

type ocppAusstand struct {
	generation int
	plan       Plan
	config     Konfig
	optionen   PlanOptionen
}

// Laufzeit is the measurement runtime of one box.
type Laufzeit struct {
	io   IO
	now  func() time.Time
	mono func() int64

	mu              sync.Mutex
	tickMu          sync.Mutex
	katalog         *Katalog
	active          *Plan
	optionen        PlanOptionen
	due, probenDue  map[string]int64
	lesetakt        map[string]float64
	ocppDue         map[string]int64
	applyGeneration int
	ausstand        *ocppAusstand
	decoder         decoderZustand
	requestWindow   []*ticket
	sampleWindow    []int64
}

type decoderZustand struct {
	previous, values map[string]any
}

// NeueLaufzeit builds a runtime; now is the wall clock, mono a monotonic
// millisecond clock (the request budget).
func NeueLaufzeit(io IO, now func() time.Time, mono func() int64) *Laufzeit {
	if now == nil {
		now = time.Now
	}
	if mono == nil {
		start := time.Now()
		mono = func() int64 { return time.Since(start).Milliseconds() }
	}
	return &Laufzeit{io: io, now: now, mono: mono, due: map[string]int64{}, probenDue: map[string]int64{},
		lesetakt: map[string]float64{}, ocppDue: map[string]int64{},
		decoder: decoderZustand{map[string]any{}, map[string]any{}}}
}

func probenSchluessel(s Kandidat) string {
	return LeseSchluessel(s.Target.Key, s.Point.PointKey) + "\x00" + s.EntityID
}

// Apply is apply(): plan against the catalog k; an applied plan becomes active
// at once - or, when it needs the charge points configured, once the core
// confirms (OcppErgebnis). A refused plan leaves the active one running.
func (l *Laufzeit) Apply(k *Katalog, c Konfig, o PlanOptionen) (Plan, error) {
	cand, err := k.BuildPlan(c, o)
	if err != nil {
		return Plan{}, err
	}
	l.mu.Lock()
	if cand.Applied && len(cand.OcppConfiguration) > 0 {
		l.applyGeneration++
		l.ausstand = &ocppAusstand{generation: l.applyGeneration, plan: cand, config: c, optionen: o}
		l.mu.Unlock()
		l.io.OcppKonfigurieren(c.Revision, cand.OcppConfiguration)
		return cand, nil
	}
	if cand.Applied {
		l.applyGeneration++
		l.ausstand = nil
		l.activate(k, cand, c, o)
	}
	l.mu.Unlock()
	l.publishStatus(c, cand.Accepted, cand.Rejected)
	return cand, nil
}

// OcppErgebnis is the core's answer to OcppKonfigurieren: confirmed, the
// pending plan becomes active; refused, the plan without its OCPP points does,
// and the OCPP points are reported as incompatible.
func (l *Laufzeit) OcppErgebnis(k *Katalog, revision *float64, applied bool) {
	l.mu.Lock()
	a := l.ausstand
	if a == nil || !gleicheRevision(a.config.Revision, revision) || a.generation != l.applyGeneration {
		l.mu.Unlock()
		return
	}
	l.ausstand = nil
	if applied {
		l.activate(k, a.plan, a.config, a.optionen)
		l.mu.Unlock()
		l.publishStatus(a.config, a.plan.Accepted, a.plan.Rejected)
		return
	}
	var ocppSel []Kandidat
	ocppKeys := map[string]bool{}
	for _, s := range a.plan.Selections {
		if s.Point.SourceKind == ocppSourceKind {
			ocppSel = append(ocppSel, s)
			ocppKeys[s.RequestedKey] = true
		}
	}
	rest := a.config
	rest.Selections = nil
	for _, s := range a.config.Selections {
		if !ocppKeys[s.PointKey] {
			rest.Selections = append(rest.Selections, s)
		}
	}
	fallback, err := k.BuildPlan(rest, a.optionen)
	if err == nil && fallback.Applied {
		l.activate(k, fallback, a.config, a.optionen)
	}
	l.mu.Unlock()
	accepted := fallback.Accepted
	if accepted == nil {
		accepted = []string{}
	}
	rejected := append(append([]Ablehnung{}, fallback.Rejected...),
		ablehnungenVon(ocppSel, "ocpp_configuration_incompatible", geteiltePunkte(a.config.Selections))...)
	l.publishStatus(a.config, accepted, rejected)
}

func gleicheRevision(a, b *float64) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// activate is the atomic cutover (l.mu held): no timer of the previous plan
// survives, the decoder state starts afresh.
func (l *Laufzeit) activate(k *Katalog, p Plan, c Konfig, o PlanOptionen) {
	entities := map[string]string{}
	seen := map[string]bool{}
	for _, s := range c.Selections {
		if !seen[s.PointKey] {
			seen[s.PointKey] = true
			entities[s.PointKey] = s.EntityID
		}
	}
	sel := make([]Kandidat, len(p.Selections))
	for i, s := range p.Selections {
		if s.EntityID == "" {
			s.EntityID = entities[s.RequestedKey]
		}
		sel[i] = s
	}
	p.Selections = sel
	lesetakt := map[string]float64{}
	for _, s := range sel {
		key := LeseSchluessel(s.Target.Key, s.Point.PointKey)
		if t, ok := lesetakt[key]; !ok || s.CadenceS < t {
			lesetakt[key] = s.CadenceS
		}
	}
	l.katalog = k
	l.active = &p
	l.optionen = o
	l.lesetakt = lesetakt
	l.due = map[string]int64{}
	for key := range lesetakt {
		l.due[key] = 0
	}
	l.probenDue = map[string]int64{}
	for _, s := range sel {
		l.probenDue[probenSchluessel(s)] = 0
	}
	l.decoder = decoderZustand{map[string]any{}, map[string]any{}}
}

func (l *Laufzeit) publishStatus(c Konfig, accepted []string, rejected []Ablehnung) {
	if accepted == nil {
		accepted = []string{}
	}
	if rejected == nil {
		rejected = []Ablehnung{}
	}
	l.io.Status(Status{Revision: c.Revision, AppliedAt: l.now(), Accepted: accepted, Rejected: rejected})
}

// Leeren drops the active plan (the plan was cleared): nothing is read.
func (l *Laufzeit) Leeren() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.active, l.ausstand = nil, nil
	l.applyGeneration++
}

// Aktiv reports whether a plan is active.
func (l *Laufzeit) Aktiv() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.active != nil
}

func (l *Laufzeit) beleg(target Ziel, b Beleg) {
	t := target
	b.Target = &t
	l.io.Beleg(b)
}

func eins() *int { n := 1; return &n }

// Tick reads what is due and publishes the samples; the kept samples come
// back. Ticks never overlap; a new plan applied while one runs does not
// relabel its reads.
func (l *Laufzeit) Tick(ctx context.Context) []Sample {
	l.tickMu.Lock()
	defer l.tickMu.Unlock()
	l.mu.Lock()
	if l.active == nil {
		l.mu.Unlock()
		return nil
	}
	plan, decoder, lesetakt, optionen := l.active, l.decoder, l.lesetakt, l.optionen
	now := l.now()
	ms := now.UnixMilli()
	dueKeys := map[string]bool{}
	for _, s := range plan.Selections {
		key := LeseSchluessel(s.Target.Key, s.Point.PointKey)
		if l.due[key] <= ms {
			dueKeys[key] = true
		}
	}
	if len(dueKeys) == 0 {
		l.mu.Unlock()
		return nil
	}
	dueProben := map[int]bool{}
	for i, s := range plan.Selections {
		if dueKeys[LeseSchluessel(s.Target.Key, s.Point.PointKey)] && l.probenDue[probenSchluessel(s)] <= ms {
			dueProben[i] = true
		}
	}
	for key := range dueKeys {
		t := lesetakt[key]
		if t == 0 {
			t = 1
		}
		l.due[key] = ms + int64(t*1000)
	}
	for i := range dueProben {
		s := plan.Selections[i]
		l.probenDue[probenSchluessel(s)] = ms + int64(s.CadenceS*1000)
	}
	l.mu.Unlock()

	var samples []Sample
	worte := map[string]map[int]uint16{}
	bucket := func(target string) map[int]uint16 {
		b := worte[target]
		if b == nil {
			b = map[int]uint16{}
			worte[target] = b
		}
		return b
	}
	for _, b := range plan.Blocks {
		faellig := false
		for _, p := range b.Points {
			if dueKeys[LeseSchluessel(b.Target.Key, p)] {
				faellig = true
				break
			}
		}
		if faellig {
			l.readBlock(ctx, b, bucket(b.Target.Key))
		}
	}
	for _, g := range plan.HTTPGroups {
		samples = append(samples, l.readJSON(ctx, g, dueKeys, plan, dueProben, lesetakt)...)
	}
	for _, x := range plan.DecoderPrerequisites {
		if !dueKeys[LeseSchluessel(x.Target.Key, x.TriggerKey)] {
			continue
		}
		words := bucket(x.Target.Key)
		addresses := adressen(x.Point, optionen.discoveryFor(x.Target.Key))
		if w, ok := alleWorte(words, addresses); ok {
			_, _ = DecodeRegisters(x.Point, w, addresses, decoderOptionen(x.Point, words, x.Target.Key, plan, decoder))
		}
	}
	dekodiert := map[string]*Sample{}
	for i, s := range plan.Selections {
		if !dueProben[i] {
			continue
		}
		key := LeseSchluessel(s.Target.Key, s.Point.PointKey)
		if d, ok := dekodiert[key]; ok {
			if d != nil {
				samples = append(samples, mitEntity(*d, s))
			}
			continue
		}
		words := bucket(s.Target.Key)
		var sample *Sample
		if s.Point.Address != nil {
			addresses := adressen(s.Point, optionen.discoveryFor(s.Target.Key))
			if w, ok := alleWorte(words, addresses); ok && len(addresses) > 0 {
				sample, _ = DecodeRegisters(s.Point, w, addresses, decoderOptionen(s.Point, words, s.Target.Key, plan, decoder))
			}
		} else if len(DerivedAddresses(s.Point)) > 0 {
			sample = DecodeDerived(s.Point, words)
		}
		dekodiert[key] = sample
		if sample != nil {
			samples = append(samples, mitEntity(*sample, s))
		}
	}
	verwerfen := false
	for _, x := range samples {
		if x.InvalidateAll {
			verwerfen = true
			if s, ok := findeAuswahl(plan, x.PointKey, x.EntityID, false); ok {
				l.beleg(s.Target, Beleg{Failed: true, ErrorClass: "implausible", PointKey: s.RequestedKey, EntityID: s.EntityID})
			}
		}
	}
	if verwerfen {
		return []Sample{}
	}
	return l.publishSamples(samples, now, plan)
}

func mitEntity(s Sample, x Kandidat) Sample {
	if x.EntityID != "" {
		s.EntityID = x.EntityID
	}
	return s
}

// findeAuswahl is the selection a sample belongs to: same component, and the
// point itself or (template) its requested key.
func findeAuswahl(plan *Plan, pointKey, entity string, template bool) (Kandidat, bool) {
	for _, x := range plan.Selections {
		if x.EntityID != entity {
			continue
		}
		if x.Point.PointKey == pointKey || (template && x.RequestedKey == TemplateKey(pointKey)) {
			return x, true
		}
	}
	return Kandidat{}, false
}

func adressen(p *Punkt, d *Discovery) []int {
	if p.Address.Registers != nil {
		return p.Address.Registers
	}
	if p.Address.Kind != "sunspec_relative" || d == nil {
		return nil
	}
	m, ok := d.Models[p.Address.ModelID]
	off, isInt := offsetInt(p.Address)
	if !ok || !isInt {
		return nil
	}
	out := make([]int, p.Address.WidthWords)
	for i := range out {
		out[i] = m.Base + off + i
	}
	return out
}

func alleWorte(words map[int]uint16, addresses []int) ([]uint16, bool) {
	out := make([]uint16, len(addresses))
	for i, a := range addresses {
		w, ok := words[a]
		if !ok {
			return nil, false
		}
		out[i] = w
	}
	return out, true
}

func decoderOptionen(p *Punkt, words map[int]uint16, target string, plan *Plan, z decoderZustand) DecodeOptionen {
	o := DecodeOptionen{PreviousValues: z.previous, DecodedValues: z.values}
	if b, ok := plan.ByteOrders[target]; ok {
		o.ByteOrder = b
	} else if target == TargetPrimary {
		o.ByteOrder = plan.ByteOrder
	}
	if d := p.Decoder; d != nil {
		if d.ByteOrder != nil && d.ByteOrder.Register != nil {
			if w, ok := words[*d.ByteOrder.Register]; ok {
				o.ByteOrderWord = &w
			}
		}
		if d.Variant != nil && d.Variant.Register != nil {
			if w, ok := words[*d.Variant.Register]; ok {
				o.VariantWord = &w
			}
		}
	}
	return o
}

// readBlock reads one block into the target's words; the receipt names the
// request and how it ended.
func (l *Laufzeit) readBlock(ctx context.Context, b Block, words map[int]uint16) {
	kind := b.SourceKind
	if kind == "" {
		kind = "modbus_holding"
	}
	t := l.beginRequest(kind)
	if t == nil {
		l.beleg(b.Target, Beleg{Failed: true, ErrorClass: "budget"})
		return
	}
	w, err := l.io.LiesRegister(ctx, Leseauftrag{Start: b.Start, Count: b.Count, SourceKind: b.SourceKind, Target: b.Target})
	l.finishRequest(t)
	switch {
	case err != nil:
		l.beleg(b.Target, Beleg{Requests: eins(), Failed: true, ErrorClass: errorClass(err)})
		return
	case len(w) < b.Count:
		l.beleg(b.Target, Beleg{Requests: eins(), Failed: true, ErrorClass: "invalid_response"})
		return
	}
	l.beleg(b.Target, Beleg{Requests: eins()})
	for i := 0; i < b.Count; i++ {
		words[b.Start+i] = w[i]
	}
}

func httpGroupKey(s Kandidat, lesetakt map[string]float64) string {
	takt := lesetakt[LeseSchluessel(s.Target.Key, s.Point.PointKey)]
	if takt == 0 {
		takt = s.CadenceS
	}
	return s.Target.Key + ":" + s.Point.PollGroup + ":" + jsNumberString(takt)
}

func (l *Laufzeit) readJSON(ctx context.Context, g HTTPGruppe, dueKeys map[string]bool, plan *Plan,
	dueProben map[int]bool, lesetakt map[string]float64) []Sample {
	var inGroup []int
	for i, x := range plan.Selections {
		if dueKeys[LeseSchluessel(x.Target.Key, x.Point.PointKey)] && httpGroupKey(x, lesetakt) == g.Key {
			inGroup = append(inGroup, i)
		}
	}
	var points []*Punkt
	seen := map[string]bool{}
	var filter []string
	for _, i := range inGroup {
		p := plan.Selections[i].Point
		if seen[p.PointKey] {
			continue
		}
		seen[p.PointKey] = true
		points = append(points, p)
		if p.SourceKind == "http_api_key" {
			if parts := strings.SplitN(p.Selector, "filter=", 3); len(parts) > 1 && parts[1] != "" {
				filter = append(filter, parts[1])
			}
		}
	}
	if len(points) == 0 {
		return nil
	}
	t := l.beginRequest(points[0].SourceKind)
	if t == nil {
		l.beleg(g.Target, Beleg{Failed: true, ErrorClass: "budget"})
		return nil
	}
	payloads, err := l.io.LiesJSON(ctx, JSONAuftrag{Group: g.Key, Target: g.Target, Filter: strings.Join(filter, ","), Points: points})
	l.finishRequest(t)
	if err != nil {
		l.beleg(g.Target, Beleg{Requests: eins(), Failed: true, ErrorClass: errorClass(err)})
		return nil
	}
	l.beleg(g.Target, Beleg{Requests: eins()})
	dekodiert := map[string][]Sample{}
	var out []Sample
	for _, i := range inGroup {
		if dueProben != nil && !dueProben[i] {
			continue
		}
		x := plan.Selections[i]
		d, ok := dekodiert[x.Point.PointKey]
		if !ok {
			for _, p := range payloads {
				d = append(d, DecodeJSONSamples(x.Point, p)...)
			}
			dekodiert[x.Point.PointKey] = d
		}
		for _, s := range d {
			out = append(out, mitEntity(s, x))
		}
	}
	return out
}

// OnMeterValues takes OCPP sampled values from the core: one sample per
// component of an accepted point, each at its own cadence.
func (l *Laufzeit) OnMeterValues(values []SampledValue, observedAt time.Time) []Sample {
	l.mu.Lock()
	plan, k := l.active, l.katalog
	if plan == nil {
		l.mu.Unlock()
		return nil
	}
	at := observedAt
	if at.IsZero() {
		at = l.now()
	}
	accepted := map[string]bool{}
	for _, a := range plan.Accepted {
		accepted[a] = true
	}
	var samples []Sample
	for _, v := range values {
		s := k.DecodeOcppSampledValue(v)
		if s == nil || !accepted[TemplateKey(s.PointKey)] {
			continue
		}
		for _, x := range plan.Selections {
			if x.RequestedKey != TemplateKey(s.PointKey) {
				continue
			}
			key := s.PointKey + "\x00" + x.EntityID
			if at.UnixMilli() < l.ocppDue[key] {
				continue
			}
			l.ocppDue[key] = at.UnixMilli() + int64(x.CadenceS*1000)
			samples = append(samples, mitEntity(*s, x))
		}
	}
	l.mu.Unlock()
	return l.publishSamples(samples, at, plan)
}

func (l *Laufzeit) trimRequests(ms int64) {
	for len(l.requestWindow) > 0 && !l.requestWindow[0].pending && l.requestWindow[0].at <= ms-60000 {
		l.requestWindow = l.requestWindow[1:]
	}
}

// beginRequest admits a request against the running budget (requests per
// minute, bus time with the whole field timeout reserved up front); nil =
// blocked.
func (l *Laufzeit) beginRequest(kind string) *ticket {
	l.mu.Lock()
	defer l.mu.Unlock()
	ms := l.mono()
	l.trimRequests(ms)
	if float64(len(l.requestWindow)) >= Grenzen.RequestsPerMinute {
		return nil
	}
	reserve, ok := reservation[kind]
	if !ok {
		// COST_MS knows only the contract's alias kinds; anything else reserves 4 s.
		reserve = 4000
		if _, alias := budget.Aliases[kind]; alias && RequestCostMs("", kind) != 0 {
			reserve = int64(RequestCostMs("", kind))
		}
	}
	duty := int64(0)
	for _, t := range l.requestWindow {
		if t.pending {
			t.cost = max(t.cost, max(1, ms-t.started))
		}
		duty += t.cost
	}
	if float64(duty+reserve)/600 > Grenzen.DutyPercent {
		return nil
	}
	t := &ticket{at: ms, started: ms, cost: reserve, pending: true}
	l.requestWindow = append(l.requestWindow, t)
	return t
}

func (l *Laufzeit) finishRequest(t *ticket) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if t == nil || !t.pending {
		return
	}
	t.pending = false
	t.cost = max(1, l.mono()-t.started)
}

// publishSamples keeps at most 600 samples per minute (the rest is a named
// gap), leaves one receipt per sample and publishes one batch.
func (l *Laufzeit) publishSamples(samples []Sample, at time.Time, plan *Plan) []Sample {
	ms := at.UnixMilli()
	l.mu.Lock()
	for len(l.sampleWindow) > 0 && l.sampleWindow[0] <= ms-60000 {
		l.sampleWindow = l.sampleWindow[1:]
	}
	room := max(0, int(Grenzen.SamplesPerMinute)-len(l.sampleWindow))
	if room > len(samples) {
		room = len(samples)
	}
	kept, dropped := samples[:room], samples[room:]
	for range kept {
		l.sampleWindow = append(l.sampleWindow, ms)
	}
	l.mu.Unlock()
	for _, s := range kept {
		if x, ok := findeAuswahl(plan, s.PointKey, s.EntityID, true); ok {
			b := Beleg{PointKey: x.RequestedKey, EntityID: x.EntityID}
			if s.Quality == "invalid" {
				b.Failed, b.ErrorClass = true, "implausible"
			} else {
				b.Samples = eins()
			}
			l.beleg(x.Target, b)
		}
	}
	for _, s := range dropped {
		if x, ok := findeAuswahl(plan, s.PointKey, s.EntityID, true); ok {
			l.beleg(x.Target, Beleg{Failed: true, ErrorClass: "budget", PointKey: x.RequestedKey, EntityID: x.EntityID})
		}
	}
	if len(kept) > 0 || len(dropped) > 0 {
		b := Probenstapel{CatalogVersion: plan.CatalogVersion, ObservedAt: isoMillis(at), Samples: append([]Sample{}, kept...), at: at}
		if r := plan.Revision; r != nil && *r >= 0 && *r <= 9007199254740991 && *r == float64(int64(*r)) {
			b.AppliedRevision = r
		}
		if len(dropped) > 0 {
			b.Gap, b.DroppedSamples = true, len(dropped)
		}
		l.io.Proben(b)
	}
	if kept == nil {
		return []Sample{}
	}
	return kept
}

// isoMillis is Date.toISOString().
func isoMillis(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
