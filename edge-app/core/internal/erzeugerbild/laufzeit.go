package erzeugerbild

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// Laufzeit is the Erzeuger part of the measurement runtime - the twin of what
// measurement-runtime.js and measurement-planner.js do with an Erzeuger point:
// plan the selections of a desired config against the per-controller
// parameters (erzeuger_registerbilder) and the binding, read each controller
// every 5 s, judge the image once per controller and tick (Stufe), send a
// value when the send rule says so (Meldung), report events and the site
// sample. No bus, no socket: the caller hands in the reader and publishes what
// a tick returns (internal/layer1).
//
// ⚠ The leading rule of the binding: a component that cannot be resolved is
// REFUSED, never read against anything else. A wrong value is worse than none.

// Ziel keys of the binding (measurement-binding.js).
const (
	ZielPrimary = "primary"
	primaryPin  = "inverter"
)

// Reasons of the closed mqtt-measurement-config-status vocabulary.
const (
	GrundUnbekannterPunkt = "unknown_point"
	GrundTakt             = "invalid_cadence"
	GrundNichtGebunden    = "binding_unavailable"
	GrundOhneTreiber      = "driver_unavailable"
	GrundBudgetSamples    = "budget_samples"
	GrundBudgetRequests   = "budget_requests"
	GrundBudgetDuty       = "budget_duty_cycle"
)

// The budget of the box (docs/contracts/v2/measurement-budget-vectors.json):
// samples and requests per minute, share of bus time; an Erzeuger request
// costs 400 ms.
const (
	budgetSamplesJeMinute  = 600
	budgetRequestsJeMinute = 30
	budgetDutyProzent      = 20
	anfrageKostenMs        = 400
)

// composedTypes are the entity types the box itself feeds from the primary's
// composite sample (measurement-binding.js COMPOSED_TYPES).
var composedTypes = map[string]bool{"battery-hybrid": true, "grid-meter": true, "house-load": true}

// BindungsEntitaet is one retained edge/entities/{id}/config as the binding
// needs it.
type BindungsEntitaet struct {
	EntityType   string
	EdgeSourceID string
	DataSourceID string
}

// BindungsQuelle is one source of edge/sources/config: its connection.
type BindungsQuelle struct {
	IP     string
	Port   int
	UnitID int
}

// Bindung is the snapshot of registry and source list a plan is made from.
type Bindung struct {
	Entitaeten map[string]BindungsEntitaet
	Quellen    map[string]BindungsQuelle
}

// Ziel is the device a planned point is read from.
type Ziel struct {
	Key          string // primary or source:<pin>
	SourceID     string // the pin; "" for primary
	DataSourceID string
}

// Zielverbindung is the connection of a target at plan time.
type Zielverbindung struct {
	Ziel
	Quelle BindungsQuelle
}

// ZielVon resolves a component to the device it is read from; ok=false when it
// is not bound (the Koppelbild of the same controller, layer1/koppel.go).
func (b Bindung) ZielVon(entityID string) (Ziel, bool) {
	z, grund := b.zielVon(entityID)
	return z, grund == ""
}

func (b Bindung) zielVon(entityID string) (Ziel, string) {
	if entityID == "" {
		// No component named: the plan belongs to the device as a whole.
		return Ziel{Key: ZielPrimary}, ""
	}
	e, ok := b.Entitaeten[entityID]
	if !ok {
		return Ziel{}, GrundNichtGebunden
	}
	var z Ziel
	switch {
	case e.EdgeSourceID == primaryPin:
		z = Ziel{Key: ZielPrimary}
	case e.EdgeSourceID != "":
		if _, da := b.Quellen[e.EdgeSourceID]; !da {
			return Ziel{}, GrundNichtGebunden
		}
		z = Ziel{Key: "source:" + e.EdgeSourceID, SourceID: e.EdgeSourceID}
	case composedTypes[e.EntityType]:
		z = Ziel{Key: ZielPrimary}
	default:
		return Ziel{}, GrundNichtGebunden
	}
	z.DataSourceID = e.DataSourceID
	return z, ""
}

// Auswahl is one selection of the desired config.
type Auswahl struct {
	PointKey string `json:"point_key"`
	CadenceS int    `json:"cadence_s"`
	EntityID string `json:"entity_id,omitempty"`
}

// Bildparameter is one entry of erzeuger_registerbilder
// (mqtt-measurement-config x-erzeuger-registerbilder-rule).
type Bildparameter struct {
	EntityID           string `json:"entity_id"`
	Basisadresse       int    `json:"basisadresse"`
	Funktionscode      int    `json:"funktionscode"`
	Wortfolge          string `json:"wortfolge"`
	TeAnzahl           int    `json:"te_anzahl"`
	Anlagenart         string `json:"anlagenart"`
	SteuerungKennung   *int64 `json:"steuerung_kennung,omitempty"`
	VeraltetNetzpunktS *int   `json:"veraltet_netzpunkt_s,omitempty"`
}

// Konfig is the Erzeuger part of a desired config.
type Konfig struct {
	Revision       int64
	CatalogVersion string
	Auswahl        []Auswahl
	Bilder         []Bildparameter
}

// Ablehnung is one refused point of the status.
type Ablehnung struct {
	PointKey string `json:"point_key"`
	Reason   string `json:"reason"`
	EntityID string `json:"entity_id,omitempty"`
}

// PlanStatus is the Erzeuger part of the config status.
type PlanStatus struct {
	Accepted []string
	Rejected []Ablehnung
}

var anlagenartCode = map[string]int{"pv": 1, "bhkw": 2, "gemischt": 3}

type parameter struct {
	entityID      string
	basisadresse  int
	funktionscode int
	wortfolge     string
	teAnzahl      int
	soll          Soll
}

type geplant struct {
	pointKey  string // the concrete point (te[*] expanded)
	requested string
	cadence   time.Duration
	entityID  string
	ziel      Ziel
}

type geplanterBlock struct {
	ziel  Ziel
	start int
	count int
	fc    int
}

type plan struct {
	revision   int64
	catalog    string
	auswahl    []geplant
	bloecke    []geplanterBlock
	parameter  map[string]parameter // per target key
	verbindung map[string]BindungsQuelle
}

// IstErzeugerSchluessel: every key of the family starts with "erzeuger." -
// such a key is this runtime's to judge, a key it does not know is refused as
// unknown_point (the catalog family has no other points).
func IstErzeugerSchluessel(pointKey string) bool { return strings.HasPrefix(pointKey, "erzeuger.") }

// geteiltePunkte: a point named more than once, every time with a component.
func geteiltePunkte(auswahl []Auswahl) map[string]bool {
	zahl, ohne := map[string]int{}, map[string]bool{}
	for _, s := range auswahl {
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

func bilderJeZiel(bilder []Bildparameter, b Bindung) map[string]parameter {
	out, doppelt := map[string]parameter{}, map[string]bool{}
	for _, p := range bilder {
		code, ok := anlagenartCode[p.Anlagenart]
		if p.EntityID == "" || !ok {
			continue // an entry the box cannot understand is dropped, never guessed
		}
		z, grund := b.zielVon(p.EntityID)
		if grund != "" {
			continue
		}
		if _, da := out[z.Key]; da {
			doppelt[z.Key] = true
			continue
		}
		wortfolge := p.Wortfolge
		if wortfolge == "" {
			wortfolge = "big"
		}
		par := parameter{entityID: p.EntityID, basisadresse: p.Basisadresse, funktionscode: p.Funktionscode,
			wortfolge: wortfolge, teAnzahl: p.TeAnzahl,
			soll: Soll{TeAnzahl: p.TeAnzahl, Anlagenart: code, SteuerungID: p.SteuerungKennung,
				AlterSchwelleS: p.VeraltetNetzpunktS}}
		out[z.Key] = par
	}
	for k := range doppelt {
		delete(out, k)
	}
	return out
}

// Laufzeit holds the active plan and the state that lives across ticks.
type Laufzeit struct {
	plan    *plan
	faellig map[string]time.Time // per target: the next read
	stufe   Stufe
	meldung Meldung
	fenster []time.Time // samples of the last minute
}

// Plane judges the Erzeuger selections of a config and activates the plan.
// Selections whose key is not an Erzeuger key are not this runtime's and are
// neither accepted nor refused here.
func (l *Laufzeit) Plane(k Konfig, b Bindung) PlanStatus {
	var auswahl []Auswahl
	for _, s := range k.Auswahl {
		if IstErzeugerSchluessel(s.PointKey) {
			auswahl = append(auswahl, s)
		}
	}
	geteilt := geteiltePunkte(auswahl)
	status := PlanStatus{Accepted: []string{}, Rejected: []Ablehnung{}}
	ablehnung := func(s Auswahl, grund string) {
		a := Ablehnung{PointKey: s.PointKey, Reason: grund}
		if geteilt[s.PointKey] {
			a.EntityID = s.EntityID
		}
		status.Rejected = append(status.Rejected, a)
	}
	parameterJeZiel := bilderJeZiel(k.Bilder, b)
	p := &plan{revision: k.Revision, catalog: k.CatalogVersion, parameter: map[string]parameter{},
		verbindung: map[string]BindungsQuelle{}}
	type gesehen struct {
		ohne        bool
		komponenten map[string]bool
	}
	seen := map[string]*gesehen{}
	for _, s := range auswahl {
		komponente := strings.ToLower(s.EntityID)
		g := seen[s.PointKey]
		if g != nil && (g.ohne || komponente == "" || g.komponenten[komponente]) {
			status.Rejected = append(status.Rejected, Ablehnung{PointKey: s.PointKey, Reason: GrundUnbekannterPunkt})
			continue
		}
		if g == nil {
			g = &gesehen{komponenten: map[string]bool{}}
			seen[s.PointKey] = g
		}
		if komponente == "" {
			g.ohne = true
		} else {
			g.komponenten[komponente] = true
		}
		_, einheit, _, ok := PunktTeile(s.PointKey)
		if !ok || !IstPunkt(s.PointKey) {
			ablehnung(s, GrundUnbekannterPunkt)
			continue
		}
		if s.CadenceS < LesetaktS || s.CadenceS > 86400 {
			ablehnung(s, GrundTakt)
			continue
		}
		ziel, grund := b.zielVon(s.EntityID)
		if grund != "" {
			ablehnung(s, grund)
			continue
		}
		par, da := parameterJeZiel[ziel.Key]
		if !da || par.teAnzahl < 1 || einheit == 0 && strings.HasPrefix(s.PointKey, "erzeuger.te[") ||
			einheit > 0 && einheit > par.teAnzahl || einheit < -1 {
			ablehnung(s, GrundOhneTreiber)
			continue
		}
		keys := []string{s.PointKey}
		if einheit == -1 {
			keys = nil
			for n := 1; n <= par.teAnzahl; n++ {
				keys = append(keys, strings.Replace(s.PointKey, "[*]", "["+itoa(n)+"]", 1))
			}
		}
		for _, key := range keys {
			p.auswahl = append(p.auswahl, geplant{pointKey: key, requested: s.PointKey,
				cadence: time.Duration(s.CadenceS) * time.Second, entityID: s.EntityID, ziel: ziel})
		}
		p.parameter[ziel.Key] = par
		if ziel.SourceID != "" {
			p.verbindung[ziel.Key] = b.Quellen[ziel.SourceID]
		}
	}
	// One read plan per controller: up to 8 units one request, a block never
	// split.
	var ziele []Ziel
	for _, s := range p.auswahl {
		neu := true
		for _, z := range ziele {
			if z.Key == s.ziel.Key {
				neu = false
			}
		}
		if neu {
			ziele = append(ziele, s.ziel)
		}
	}
	for _, z := range ziele {
		par := p.parameter[z.Key]
		anfragen, err := PlaneAnfragen(par.basisadresse, par.teAnzahl, 0)
		if err != nil {
			continue
		}
		for _, a := range anfragen {
			p.bloecke = append(p.bloecke, geplanterBlock{ziel: z, start: a.Start, count: a.Count, fc: par.funktionscode})
		}
	}
	// The budget of the plan (measurement-planner.js budgetMetrics): every
	// value one sample per cadence, every block one request per 5 s.
	samples, requests := 0.0, 0.0
	for _, s := range p.auswahl {
		samples += 60 / s.cadence.Seconds()
	}
	requests = float64(len(p.bloecke)) * 60 / LesetaktS
	duty := requests * anfrageKostenMs / 600
	budget := ""
	switch {
	case samples > budgetSamplesJeMinute+1e-9:
		budget = GrundBudgetSamples
	case requests > budgetRequestsJeMinute+1e-9:
		budget = GrundBudgetRequests
	case duty > budgetDutyProzent+1e-9:
		budget = GrundBudgetDuty
	}
	if budget != "" {
		abgelehnt := map[string]bool{}
		var budgetAblehnungen []Ablehnung
		for _, s := range p.auswahl {
			key := s.requested + "\x00"
			if geteilt[s.requested] {
				key += s.entityID
			}
			if abgelehnt[key] {
				continue
			}
			abgelehnt[key] = true
			a := Ablehnung{PointKey: s.requested, Reason: budget}
			if geteilt[s.requested] {
				a.EntityID = s.entityID
			}
			budgetAblehnungen = append(budgetAblehnungen, a)
		}
		status.Rejected = append(budgetAblehnungen, status.Rejected...)
		// Unlike the palette (which keeps its previous plan), Edge Light reads
		// nothing it just reported as refused.
		l.aktiviere(nil)
		return status
	}
	angenommen := map[string]bool{}
	for _, s := range p.auswahl {
		if !angenommen[s.requested] {
			angenommen[s.requested] = true
			status.Accepted = append(status.Accepted, s.requested)
		}
	}
	if len(p.auswahl) == 0 {
		p = nil
	}
	l.aktiviere(p)
	return status
}

func (l *Laufzeit) aktiviere(p *plan) {
	if l.plan != nil {
		for key := range l.plan.parameter {
			if p == nil || p.parameter[key].entityID != l.plan.parameter[key].entityID {
				l.stufe.Vergiss(key)
			}
		}
	}
	l.plan = p
	l.faellig = map[string]time.Time{}
	// A new plan starts every value afresh.
	l.meldung.VergissAlles()
}

// Aktiv reports whether a plan with at least one Erzeuger point is active.
func (l *Laufzeit) Aktiv() bool { return l.plan != nil }

// Anfrage is one read the runtime wants from a controller.
type GeplanteAnfrage struct {
	Ziel  Zielverbindung
	Start int
	Count int
	FC    int
}

// Anfragen lists the plan's reads (for the log and the tests).
func (l *Laufzeit) Anfragen() []GeplanteAnfrage {
	if l.plan == nil {
		return nil
	}
	var out []GeplanteAnfrage
	for _, b := range l.plan.bloecke {
		out = append(out, GeplanteAnfrage{Ziel: Zielverbindung{Ziel: b.ziel, Quelle: l.plan.verbindung[b.ziel.Key]},
			Start: b.start, Count: b.count, FC: b.fc})
	}
	return out
}

// Leser reads count words from start with function code fc at a target. On
// failure it returns the error class of the source contract (unreachable,
// no_answer, invalid_response, timeout).
type Leser func(ctx context.Context, ziel Zielverbindung, start, count, fc int) ([]uint16, string)

// Nachricht is one message for the local bus.
type Nachricht struct {
	Topic   string
	Payload any
}

// Beleg is one read receipt for edge/data-sources/poll (data-source-status.js
// evidence): requests made, samples delivered, failure class.
type Beleg struct {
	Ziel       Ziel
	Requests   int
	Samples    int
	Failed     bool
	ErrorClass string
}

// Sample is one value on edge/measurements/samples.
type Sample struct {
	PointKey string      `json:"point_key"`
	Raw      json.Number `json:"raw"`
	Decoded  json.Number `json:"decoded,omitempty"`
	Quality  string      `json:"quality"`
	EntityID string      `json:"entity_id,omitempty"`
}

// Stapel is the local batch of one tick.
type Stapel struct {
	CatalogVersion  string   `json:"catalog_version"`
	ObservedAt      string   `json:"observed_at"`
	Samples         []Sample `json:"samples"`
	AppliedRevision *int64   `json:"applied_revision,omitempty"`
	Gap             bool     `json:"gap,omitempty"`
	DroppedSamples  int      `json:"dropped_samples,omitempty"`
}

// SamplesTopic is the local batch topic (measurements.LocalSamplesTopic).
const SamplesTopic = "edge/measurements/samples"

// TaktErgebnis is what one tick did.
type TaktErgebnis struct {
	Lesungen    []GeplanteAnfrage
	Nachrichten []Nachricht
	Belege      []Beleg
}

// Takt runs one tick: reads every controller whose 5 s are due, judges each
// image once, and returns the bus messages in the palette's order (per
// controller its events and site sample, then the one batch of samples).
func (l *Laufzeit) Takt(ctx context.Context, jetzt time.Time, lies Leser) TaktErgebnis {
	r := l.Beginne(jetzt)
	if r == nil {
		return TaktErgebnis{}
	}
	antworten := make([]Antwort, len(r.Anfragen))
	for i, a := range r.Anfragen {
		antworten[i].Woerter, antworten[i].Klasse = lies(ctx, a.Ziel, a.Start, a.Count, a.FC)
	}
	return l.Beende(r, antworten)
}

// Runde is one tick's reads, claimed before the first byte goes out - so the
// caller can do the I/O without holding the lock it guards the runtime with.
type Runde struct {
	plan     *plan
	jetzt    time.Time
	faellig  map[string]bool
	Anfragen []GeplanteAnfrage
}

// Antwort is the answer to one Anfrage of a Runde, in its order: the words,
// or the error class of the read.
type Antwort struct {
	Woerter []uint16
	Klasse  string
}

// Beginne claims the due reads of this tick (nil: nothing due).
func (l *Laufzeit) Beginne(jetzt time.Time) *Runde {
	p := l.plan
	if p == nil {
		return nil
	}
	faellig := map[string]bool{}
	for _, s := range p.auswahl {
		if t, da := l.faellig[s.ziel.Key]; !da || !jetzt.Before(t) {
			faellig[s.ziel.Key] = true
		}
	}
	if len(faellig) == 0 {
		return nil
	}
	for key := range faellig {
		l.faellig[key] = jetzt.Add(LesetaktS * time.Second)
	}
	r := &Runde{plan: p, jetzt: jetzt, faellig: faellig}
	for _, b := range p.bloecke {
		if faellig[b.ziel.Key] {
			r.Anfragen = append(r.Anfragen, GeplanteAnfrage{Ziel: Zielverbindung{Ziel: b.ziel,
				Quelle: p.verbindung[b.ziel.Key]}, Start: b.start, Count: b.count, FC: b.fc})
		}
	}
	return r
}

// Beende judges the answers of a Runde. A plan applied while the reads were
// on the wire never relabels them: the requests are counted, nothing else of
// the old plan reaches the bus.
func (l *Laufzeit) Beende(r *Runde, antworten []Antwort) TaktErgebnis {
	out := TaktErgebnis{Lesungen: r.Anfragen}
	p, jetzt, faellig := r.plan, r.jetzt, r.faellig
	woerter := map[string]map[int]uint16{}
	for i, a := range r.Anfragen {
		var ant Antwort
		if i < len(antworten) {
			ant = antworten[i]
		} else {
			ant.Klasse = "timeout"
		}
		klasse := ant.Klasse
		if klasse != "" || len(ant.Woerter) < a.Count {
			if klasse == "" {
				klasse = "invalid_response"
			}
			out.Belege = append(out.Belege, Beleg{Ziel: a.Ziel.Ziel, Requests: 1, Failed: true, ErrorClass: klasse})
			continue
		}
		out.Belege = append(out.Belege, Beleg{Ziel: a.Ziel.Ziel, Requests: 1})
		m := woerter[a.Ziel.Key]
		if m == nil {
			m = map[int]uint16{}
			woerter[a.Ziel.Key] = m
		}
		for j := 0; j < a.Count; j++ {
			m[a.Start+j] = ant.Woerter[j]
		}
	}
	if p != l.plan {
		return out
	}
	gelesen := map[string]*StufenLesung{}
	beurteilt := map[string]bool{}
	var samples []Sample
	var sampleZiele []Ziel
	for _, s := range p.auswahl {
		if !faellig[s.ziel.Key] {
			continue
		}
		if !beurteilt[s.ziel.Key] {
			beurteilt[s.ziel.Key] = true
			gelesen[s.ziel.Key] = l.beurteile(s.ziel, p, woerter[s.ziel.Key], jetzt, &out)
		}
		g := gelesen[s.ziel.Key]
		if g == nil || g.Ergebnis != ErgebnisErkannt {
			continue
		}
		var wert *Wert
		for i := range g.Werte {
			if g.Werte[i].Punkt == s.pointKey {
				wert = &g.Werte[i]
				break
			}
		}
		if wert == nil || !l.meldung.Soll(MeldeSchluessel(s.ziel.Key, s.entityID, s.pointKey), *wert, s.cadence, jetzt) {
			continue
		}
		sample := Sample{PointKey: s.pointKey, Raw: json.Number(itoa64(wert.Roh)), Quality: wert.Qualitaet,
			EntityID: s.entityID}
		if wert.Wert != nil {
			sample.Decoded = zahlJSON(*wert.Wert)
		}
		samples = append(samples, sample)
		sampleZiele = append(sampleZiele, s.ziel)
	}
	l.veroeffentlicheSamples(samples, sampleZiele, jetzt, p, &out)
	return out
}

// beurteile is erzeugerLesung: the image of one controller, judged once.
func (l *Laufzeit) beurteile(ziel Ziel, p *plan, w map[int]uint16, jetzt time.Time, out *TaktErgebnis) *StufenLesung {
	par, da := p.parameter[ziel.Key]
	if !da {
		return nil
	}
	var g *StufenLesung
	worte := make([]uint16, LaengeBild(par.teAnzahl))
	alle := w != nil
	for i := range worte {
		v, ok := w[par.basisadresse+i]
		if !ok {
			alle = false
			break
		}
		worte[i] = v
	}
	if alle {
		soll := par.soll
		r := l.stufe.LesungAuswerten(worte, ziel.Key, par.wortfolge, &soll, ziel.DataSourceID, par.entityID, jetzt)
		g = &r
		if r.Ergebnis != ErgebnisErkannt {
			// Every reason the image is not ours or does not match its Soll is
			// layout_changed - nothing was re-attached.
			out.Belege = append(out.Belege, Beleg{Ziel: ziel, Failed: true, ErrorClass: FindingErrorClass})
		}
		for _, e := range r.Ereignisse {
			out.Nachrichten = append(out.Nachrichten, Nachricht{Topic: EreignisTopic, Payload: e})
		}
		if ziel.SourceID != "" {
			if q, ok := Quelle(r, jetzt); ok {
				out.Nachrichten = append(out.Nachrichten, Nachricht{Topic: QuellenTopic(ziel.SourceID), Payload: q})
			}
		}
	}
	if g == nil || g.Ergebnis != ErgebnisErkannt {
		// No image this tick: the next value is the first again.
		l.meldung.VergissZiel(ziel.Key)
	}
	return g
}

// veroeffentlicheSamples is publishSamples: at most 600 samples a minute; what
// does not fit is dropped and the batch says so (gap).
func (l *Laufzeit) veroeffentlicheSamples(samples []Sample, ziele []Ziel, jetzt time.Time, p *plan, out *TaktErgebnis) {
	grenze := jetzt.Add(-time.Minute)
	for len(l.fenster) > 0 && !l.fenster[0].After(grenze) {
		l.fenster = l.fenster[1:]
	}
	platz := max(0, budgetSamplesJeMinute-len(l.fenster))
	behalten := min(platz, len(samples))
	for i := 0; i < behalten; i++ {
		l.fenster = append(l.fenster, jetzt)
	}
	for i, s := range samples {
		switch {
		case i >= behalten:
			out.Belege = append(out.Belege, Beleg{Ziel: ziele[i], Failed: true, ErrorClass: "budget"})
		case s.Quality == QualitaetUngueltig:
			out.Belege = append(out.Belege, Beleg{Ziel: ziele[i], Failed: true, ErrorClass: "implausible"})
		default:
			out.Belege = append(out.Belege, Beleg{Ziel: ziele[i], Samples: 1})
		}
	}
	verworfen := len(samples) - behalten
	if behalten == 0 && verworfen == 0 {
		return
	}
	st := Stapel{CatalogVersion: p.catalog, ObservedAt: JSZeit(jetzt), Samples: samples[:behalten]}
	if p.revision >= 0 {
		rev := p.revision
		st.AppliedRevision = &rev
	}
	if verworfen > 0 {
		st.Gap, st.DroppedSamples = true, verworfen
	}
	out.Nachrichten = append(out.Nachrichten, Nachricht{Topic: SamplesTopic, Payload: st})
}

func itoa(n int) string { return itoa64(int64(n)) }

func itoa64(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// zahlJSON writes a number the way JSON.stringify does (shortest form).
func zahlJSON(v float64) json.Number {
	b, _ := json.Marshal(v)
	return json.Number(b)
}
