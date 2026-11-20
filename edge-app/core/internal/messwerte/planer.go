package messwerte

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// The planner: the Go twin of measurement-planner.js buildPlan. A plan is
// applied atomically: the caller swaps the active plan only when Plan.Applied.
// Held to edge-app/nodered/measurements/measurement-planner-vectors.json.
//
// Edge Light differences, by design: the points of an Erzeuger register image
// never reach this planner (internal/erzeugerbild judges them), and a point of
// a WAGO register image is refused as edge_too_old until the box reads that
// image.

// Target keys and the binding vocabulary (measurement-binding.js).
const (
	TargetPrimary  = "primary"
	TargetOCPP     = "ocpp"
	PrimaryPin     = "inverter"
	ReasonUnbound  = "binding_unavailable"
	ReasonTooOld   = "edge_too_old"
	sourcePrefix   = "source:"
	maxCadenceS    = 86400
	ocppSourceKind = "ocpp_sampled_value"
)

// composedTypes are read through the primary inverter without a pin.
var composedTypes = map[string]bool{"battery-hybrid": true, "grid-meter": true, "house-load": true}

// SourceTargetKey is the target of a bound source.
func SourceTargetKey(sourceID string) string { return sourcePrefix + sourceID }

// Auswahl is one selection of the plan (edge/measurements/config).
type Auswahl struct {
	PointKey   string     `json:"point_key"`
	CadenceS   float64    `json:"cadence_s"`
	EntityID   string     `json:"entity_id,omitempty"`
	Definition Definition `json:"definition,omitempty"`
}

// Konfig is the retained measurement plan.
type Konfig struct {
	Revision       *float64  `json:"revision"`
	CatalogVersion string    `json:"catalog_version"`
	Selections     []Auswahl `json:"selections"`
}

// Entitaet is the part of a retained entity config the binding reads.
type Entitaet struct {
	EntityID     string
	EntityType   string
	EdgeSourceID string
	DataSourceID string
}

// Bindung is the live context of the binding: entities by id and the sources
// (edge/sources/config) by pin.
type Bindung struct {
	Entitaeten map[string]Entitaet
	Quellen    map[string]Geraet
}

// Geraet is a device the box reads: its transport and connection.
type Geraet struct {
	Communication string
	Connection    map[string]any
}

// Ziel is where a point is read: the primary inverter, a bound source, or
// the core's OCPP feed.
type Ziel struct {
	Key          string `json:"key"`
	SourceID     string `json:"sourceId,omitempty"`
	DataSourceID string `json:"dataSourceId,omitempty"`
}

// ResolveTarget is resolveTarget(): reason != "" when the selection's
// component cannot be bound (it is then refused, never read at the primary).
func (b Bindung) ResolveTarget(s Auswahl, p *Punkt) (Ziel, string) {
	var z Ziel
	switch {
	case p != nil && p.SourceKind == ocppSourceKind:
		z = Ziel{Key: TargetOCPP}
	case s.EntityID == "":
		z = Ziel{Key: TargetPrimary}
	default:
		e, ok := b.Entitaeten[s.EntityID]
		if !ok {
			return Ziel{}, ReasonUnbound
		}
		switch pin := e.EdgeSourceID; {
		case pin == PrimaryPin:
			z = Ziel{Key: TargetPrimary}
		case pin != "":
			if _, ok := b.Quellen[pin]; !ok {
				return Ziel{}, ReasonUnbound
			}
			z = Ziel{Key: SourceTargetKey(pin), SourceID: pin}
		case composedTypes[e.EntityType]:
			z = Ziel{Key: TargetPrimary}
		default:
			return Ziel{}, ReasonUnbound
		}
	}
	if e, ok := b.Entitaeten[s.EntityID]; ok && s.EntityID != "" && e.DataSourceID != "" {
		z.DataSourceID = e.DataSourceID
	}
	return z, ""
}

// OcppFaehigkeit is what the core says about the charge points' sampled data.
type OcppFaehigkeit struct {
	Supported           bool
	Readonly            bool
	MaxLength           int
	SupportedMeasurands []string
}

// PlanOptionen are the facts a plan is judged against.
type PlanOptionen struct {
	Discovery   *Discovery
	Discoveries map[string]*Discovery
	Bindung     Bindung
	ByteOrder   string
	ByteOrders  map[string]string
	Ocpp        *OcppFaehigkeit
}

func (o PlanOptionen) discoveryFor(target string) *Discovery {
	if d, ok := o.Discoveries[target]; ok {
		return d
	}
	if target == TargetPrimary {
		return o.Discovery
	}
	return nil
}

func (o PlanOptionen) byteOrderFor(target string) string {
	if b, ok := o.ByteOrders[target]; ok {
		return b
	}
	if target == TargetPrimary {
		return o.ByteOrder
	}
	return ""
}

// Ablehnung is one rejected point of the status (named per component only
// at a shared point).
type Ablehnung struct {
	PointKey string `json:"point_key"`
	Reason   string `json:"reason"`
	EntityID string `json:"entity_id,omitempty"`
}

// Kandidat is one planned read of a point at a target for one component.
type Kandidat struct {
	Point        *Punkt
	CadenceS     float64
	RequestedKey string
	Target       Ziel
	EntityID     string
	TriggerKey   string
}

// Block is one register request of a plan.
type Block struct {
	Key           string
	Start         int
	Count         int
	CadenceS      float64
	SourceKind    string
	Target        Ziel
	Points        []string
	RequestCostMs float64
}

// HTTPGruppe is one HTTP request per (target, poll group, cadence).
type HTTPGruppe struct {
	Key    string
	Target Ziel
}

// Plan is the result of BuildPlan.
type Plan struct {
	Applied              bool
	Revision             *float64
	CatalogVersion       string
	Accepted             []string
	Rejected             []Ablehnung
	Selections           []Kandidat
	DecoderPrerequisites []Kandidat
	ByteOrder            string
	ByteOrders           map[string]string
	Blocks               []Block
	HTTPGroups           []HTTPGruppe
	OcppConfiguration    map[string]string
	Metrics              *Metriken
}

// geteiltePunkte: point keys that occur more than once and name an entity at
// every occurrence - only those report their components separately.
func geteiltePunkte(sel []Auswahl) map[string]bool {
	zahl, ohne := map[string]int{}, map[string]bool{}
	for _, s := range sel {
		zahl[s.PointKey]++
		if s.EntityID == "" {
			ohne[s.PointKey] = true
		}
	}
	out := map[string]bool{}
	for k, n := range zahl {
		if n > 1 && !ohne[k] {
			out[k] = true
		}
	}
	return out
}

func ablehnung(key, entity, reason string, geteilt map[string]bool) Ablehnung {
	if geteilt[key] && entity != "" {
		return Ablehnung{PointKey: key, Reason: reason, EntityID: entity}
	}
	return Ablehnung{PointKey: key, Reason: reason}
}

func ablehnungenVon(cands []Kandidat, reason string, geteilt map[string]bool) []Ablehnung {
	seen := map[string]bool{}
	var out []Ablehnung
	for _, x := range cands {
		e := ""
		if geteilt[x.RequestedKey] {
			e = x.EntityID
		}
		k := x.RequestedKey + "\x00" + e
		if !seen[k] {
			seen[k] = true
			out = append(out, ablehnung(x.RequestedKey, x.EntityID, reason, geteilt))
		}
	}
	return out
}

// LeseSchluessel is the key of ONE physical read: the same point on the same target.
func LeseSchluessel(target, pointKey string) string {
	if target == "" {
		target = TargetPrimary
	}
	return target + "\x00" + pointKey
}

func istWagoPunkt(p *Punkt) bool {
	return p.SourceKind == "wago_registerbild" || p.Family == "wago.pm494" || p.Family == "wago.pm495"
}

// BuildPlan is buildPlan(): judge every selection, then plan the reads.
func (k *Katalog) BuildPlan(c Konfig, o PlanOptionen) (Plan, error) {
	geteilt := geteiltePunkte(c.Selections)
	var rejected []Ablehnung
	if c.CatalogVersion != k.Version {
		for _, s := range c.Selections {
			rejected = append(rejected, ablehnung(s.PointKey, s.EntityID, "unsupported_catalog", geteilt))
		}
		return Plan{Accepted: []string{}, Rejected: rejected}, nil
	}
	type eintrag struct {
		ohne       bool
		komponente map[string]bool
	}
	seen := map[string]*eintrag{}
	var valid []Kandidat
	for _, s := range c.Selections {
		komp := strings.ToLower(s.EntityID)
		if b := seen[s.PointKey]; b != nil && (b.ohne || komp == "" || b.komponente[komp]) {
			rejected = append(rejected, Ablehnung{PointKey: s.PointKey, Reason: "unknown_point"})
			continue
		}
		e := seen[s.PointKey]
		if e == nil {
			e = &eintrag{komponente: map[string]bool{}}
			seen[s.PointKey] = e
		}
		if komp != "" {
			e.komponente[komp] = true
		} else {
			e.ohne = true
		}
		abgelehnt := func(reason string) { rejected = append(rejected, ablehnung(s.PointKey, s.EntityID, reason, geteilt)) }
		p, err := k.ResolvePoint(s.PointKey, o.Discovery, s.Definition)
		if err != nil {
			return Plan{}, err
		}
		if p == nil || !p.Readable {
			abgelehnt("unknown_point")
			continue
		}
		minC := p.MinCadenceS
		if minC == 0 {
			minC = 1
		}
		if s.CadenceS != math.Trunc(s.CadenceS) || s.CadenceS < minC || s.CadenceS > maxCadenceS {
			abgelehnt("invalid_cadence")
			continue
		}
		target, why := o.Bindung.ResolveTarget(s, p)
		if why != "" {
			abgelehnt(why)
			continue
		}
		discovery := o.discoveryFor(target.Key)
		if discovery != o.Discovery {
			if p, err = k.ResolvePoint(s.PointKey, discovery, s.Definition); err != nil {
				return Plan{}, err
			}
			if p == nil || !p.Readable {
				abgelehnt("unknown_point")
				continue
			}
		}
		if (p.SourceKind == "modbus_holding" || p.SourceKind == "modbus_input" || p.SourceKind == "sunspec_model") &&
			p.Address == nil && len(DerivedAddresses(p)) == 0 {
			abgelehnt("driver_unavailable")
			continue
		}
		if istWagoPunkt(p) {
			abgelehnt(ReasonTooOld)
			continue
		}
		kand := func(pt *Punkt) Kandidat {
			return Kandidat{Point: pt, CadenceS: s.CadenceS, RequestedKey: s.PointKey, Target: target, EntityID: s.EntityID}
		}
		if strings.Contains(p.PointKey, "[*]") && p.Family == "sunspec.model_160" {
			n := -1
			if discovery != nil {
				if m, ok := discovery.Models[160]; ok {
					n = m.ModuleCount
				}
			}
			if n < 1 {
				abgelehnt("driver_unavailable")
				continue
			}
			for i := 0; i < n; i++ {
				concrete, err := k.ResolvePoint(strings.Replace(s.PointKey, "[*]", "["+strconv.Itoa(i)+"]", 1), discovery, nil)
				if err != nil {
					return Plan{}, err
				}
				if concrete != nil {
					valid = append(valid, kand(concrete))
				}
			}
			continue
		}
		valid = append(valid, kand(p))
	}

	var ocpp []Kandidat
	for _, x := range valid {
		if x.Point.SourceKind == ocppSourceKind {
			ocpp = append(ocpp, x)
		}
	}
	changes, ok := compatibleOcpp(ocpp, o.Ocpp)
	if !ok {
		rejected = append(rejected, ablehnungenVon(ocpp, "ocpp_configuration_incompatible", geteilt)...)
	}
	var accepted []Kandidat
	for _, x := range valid {
		if ok || x.Point.SourceKind != ocppSourceKind {
			accepted = append(accepted, x)
		}
	}
	lesungen := lesungenJeZiel(accepted)
	prereq := k.voraussetzungen(lesungen)
	blocks := groupModbus(append(append([]Kandidat(nil), lesungen...), prereq...), o)

	var gruppen []HTTPGruppe
	gruppeVon := map[string]Kandidat{}
	for _, x := range lesungen {
		switch x.Point.SourceKind {
		case "modbus_holding", "modbus_input", "sunspec_model", ocppSourceKind, "wago_registerbild":
			continue
		}
		key := x.Target.Key + ":" + x.Point.PollGroup + ":" + jsNumberString(x.CadenceS)
		if _, ok := gruppeVon[key]; !ok {
			gruppen = append(gruppen, HTTPGruppe{Key: key, Target: x.Target})
		}
		gruppeVon[key] = x
	}
	samples, requests, dutyMs := 0.0, 0.0, 0.0
	for _, x := range accepted {
		samples += 60 / x.CadenceS
	}
	for _, b := range blocks {
		requests += 60 / b.CadenceS
		dutyMs += 60 / b.CadenceS * b.RequestCostMs
	}
	for _, g := range gruppen {
		x := gruppeVon[g.Key]
		requests += 60 / x.CadenceS
		dutyMs += 60 / x.CadenceS * RequestCostMs(x.Point.Family, x.Point.SourceKind)
	}
	reason, m := budgetMetrics(samples, requests, dutyMs)
	if reason != "" {
		return Plan{Accepted: []string{}, Rejected: append(ablehnungenVon(accepted, reason, geteilt), rejected...),
			Metrics: &m}, nil
	}
	var keys []string
	inKeys := map[string]bool{}
	for _, x := range accepted {
		if !inKeys[x.RequestedKey] {
			inKeys[x.RequestedKey] = true
			keys = append(keys, x.RequestedKey)
		}
	}
	if keys == nil {
		keys = []string{}
	}
	if rejected == nil {
		rejected = []Ablehnung{}
	}
	return Plan{Applied: true, Revision: c.Revision, CatalogVersion: c.CatalogVersion, Accepted: keys,
		Rejected: rejected, Selections: accepted, DecoderPrerequisites: prereq, ByteOrder: o.ByteOrder,
		ByteOrders: o.ByteOrders, Blocks: blocks, HTTPGroups: gruppen, OcppConfiguration: changes, Metrics: &m}, nil
}

// lesungenJeZiel: a point shared by components is READ once per target, at
// the fastest cadence of its components.
func lesungenJeZiel(cands []Kandidat) []Kandidat {
	var reihe []string
	je := map[string]Kandidat{}
	for _, x := range cands {
		key := LeseSchluessel(x.Target.Key, x.Point.PointKey)
		b, ok := je[key]
		if !ok {
			reihe = append(reihe, key)
			je[key] = x
		} else if x.CadenceS < b.CadenceS {
			b.CadenceS = x.CadenceS
			je[key] = b
		}
	}
	out := make([]Kandidat, len(reihe))
	for i, k := range reihe {
		out[i] = je[k]
	}
	return out
}

// voraussetzungen are the points a decoder validates against (validation.
// lookup): read along whenever the point that needs them is read.
func (k *Katalog) voraussetzungen(lesungen []Kandidat) []Kandidat {
	var reihe []string
	je := map[string]Kandidat{}
	for _, s := range lesungen {
		d := s.Point.Decoder
		if d == nil || d.Validation == nil || d.Validation.Lookup == "" {
			continue
		}
		p := k.prereq[s.Point.Family+"\x00"+d.Validation.Lookup]
		if p == nil {
			continue
		}
		x := Kandidat{Point: p, CadenceS: s.CadenceS, Target: s.Target, RequestedKey: s.RequestedKey, TriggerKey: s.Point.PointKey}
		key := x.Target.Key + ":" + p.PointKey + ":" + jsNumberString(x.CadenceS) + ":" + x.TriggerKey
		if _, ok := je[key]; !ok {
			reihe = append(reihe, key)
		}
		je[key] = x
	}
	out := make([]Kandidat, len(reihe))
	for i, key := range reihe {
		out[i] = je[key]
	}
	return out
}

// addressFor is a point's register range at its target, ok=false without one
// (a SunSpec point needs its target's discovered model base).
func addressFor(p *Punkt, d *Discovery) (start, count int, ok bool) {
	if p.Address == nil {
		return 0, 0, false
	}
	switch p.Address.Kind {
	case "modbus_holding", "modbus_input":
		if len(p.Address.Registers) == 0 {
			return 0, 0, false
		}
		m := p.Address.Registers[0]
		for _, r := range p.Address.Registers {
			m = min(m, r)
		}
		return m, p.Address.WidthWords, true
	case "sunspec_relative":
		if d == nil {
			return 0, 0, false
		}
		mod, has := d.Models[p.Address.ModelID]
		off, isInt := offsetInt(p.Address)
		if !has || !isInt {
			return 0, 0, false
		}
		return mod.Base + off, p.Address.WidthWords, true
	}
	return 0, 0, false
}

func decoderDependencies(p *Punkt, o PlanOptionen, target string) []int {
	d := p.Decoder
	if d == nil {
		return nil
	}
	var out []int
	if d.Variant != nil && d.Variant.Register != nil {
		out = append(out, *d.Variant.Register)
	}
	switch o.byteOrderFor(target) {
	case "big", "little", "word_little_byte_big":
	default:
		if d.ByteOrder != nil && d.ByteOrder.Register != nil {
			out = append(out, *d.ByteOrder.Register)
		}
	}
	return out
}

// groupModbus merges the register reads of one target, family, source kind
// and cadence into blocks: neighbours (a gap of at most one word) up to 120
// words. A free register (custom) is its own poll group.
func groupModbus(cands []Kandidat, o PlanOptionen) []Block {
	type item struct {
		sel          Kandidat
		start, count int
	}
	var reihe []string
	gruppen := map[string][]item{}
	ziele := map[string]Ziel{}
	for _, x := range cands {
		// Every candidate is grouped; an HTTP or OCPP point has no register and
		// leaves its group empty, exactly like the JS planner.
		unbenched := ""
		if x.Point.Family == "custom" {
			unbenched = ":" + x.Point.PollGroup
		}
		key := x.Target.Key + ":" + x.Point.Family + ":" + x.Point.SourceKind + ":" + jsNumberString(x.CadenceS) + unbenched
		if _, ok := gruppen[key]; !ok {
			reihe = append(reihe, key)
			gruppen[key] = nil
		}
		ziele[key] = x.Target
		list := gruppen[key]
		start, count, ok := addressFor(x.Point, o.discoveryFor(x.Target.Key))
		switch {
		case ok && x.Point.Address.Registers != nil:
			seen := map[int]bool{}
			for _, r := range append(append([]int(nil), x.Point.Address.Registers...), decoderDependencies(x.Point, o, x.Target.Key)...) {
				if !seen[r] {
					seen[r] = true
					list = append(list, item{x, r, 1})
				}
			}
		case ok:
			list = append(list, item{x, start, count})
		default:
			for _, a := range DerivedAddresses(x.Point) {
				list = append(list, item{x, a, 1})
			}
		}
		gruppen[key] = list
	}
	maxWords := int(costFamily("", "modbus_holding").UnitsPerRequest)
	var blocks []Block
	for _, key := range reihe {
		list := gruppen[key]
		sort.SliceStable(list, func(i, j int) bool { return list[i].start < list[j].start })
		var b *Block
		for _, it := range list {
			end := it.start + it.count
			if b == nil || it.start > b.Start+b.Count+1 || end-b.Start > maxWords {
				blocks = append(blocks, Block{Key: key, Start: it.start, Count: it.count, CadenceS: it.sel.CadenceS,
					SourceKind: it.sel.Point.SourceKind, Target: ziele[key],
					RequestCostMs: RequestCostMs(it.sel.Point.Family, it.sel.Point.SourceKind)})
				b = &blocks[len(blocks)-1]
			} else {
				b.Count = max(b.Count, end-b.Start)
			}
			trigger := it.sel.TriggerKey
			if trigger == "" {
				trigger = it.sel.Point.PointKey
			}
			found := false
			for _, p := range b.Points {
				if p == trigger {
					found = true
					break
				}
			}
			if !found {
				b.Points = append(b.Points, trigger)
			}
		}
	}
	return blocks
}

var measurandRe = regexp.MustCompile(`measurand=([^,\]]+)`)

// compatibleOcpp: the measurands of the OCPP points must be configurable at
// the charge points; the changes are the CSV both keys take.
func compatibleOcpp(points []Kandidat, f *OcppFaehigkeit) (map[string]string, bool) {
	var ms []string
	seen := map[string]bool{}
	for _, x := range points {
		m := measurandRe.FindStringSubmatch(x.Point.Selector)
		if m == nil || m[1] == "" || seen[m[1]] {
			continue
		}
		seen[m[1]] = true
		ms = append(ms, m[1])
	}
	if len(ms) == 0 {
		return map[string]string{}, true
	}
	if f == nil || f.Readonly || !f.Supported {
		return nil, false
	}
	if f.SupportedMeasurands != nil {
		ok := map[string]bool{}
		for _, m := range f.SupportedMeasurands {
			ok[m] = true
		}
		for _, m := range ms {
			if !ok[m] {
				return nil, false
			}
		}
	}
	csv := strings.Join(ms, ",")
	if f.MaxLength > 0 && len(csv) > f.MaxLength {
		return nil, false
	}
	return map[string]string{"MeterValuesSampledData": csv, "StopTxnSampledData": csv}, true
}
