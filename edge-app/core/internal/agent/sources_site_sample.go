package agent

// Eine Anlage OHNE Wechselrichter und ohne Anlagensteuerung - nur Erzeuger und
// Zähler (Schramm „Zuhause“, 07.11.2026: drei KACO Powador TL3, alle als
// „Weiterer Erzeuger“ übernommen, später ein Shelly Pro 3EM am Netzanschluss).
//
// Bis hierher bildete eine solche Box NIE ein Standort-Sample: der Fold
// (foldSiteSample) lief nur aus dem Sample des Wechselrichters
// (onLocalTelemetry) oder aus der Lesung einer Anlagensteuerung
// (plantControllerSample). Die Box las alle drei KACO frisch, stand aber auf
// „keine_messwerte“; die Cloud bekam keine Telemetrie, kein Verlauf, keine
// Heute-kWh, keine Netz- und Haus-Komponente - und das Cockpit sagte „Ist Ihr
// Gerät mit Strom versorgt?“.
//
// Zwei Wege, beide nur auf einer Box ohne Wechselrichter:
//
//   - sourcesSiteSample faltet aus den Quellen das Standort-Sample, durch
//     DENSELBEN Fold (kein zweiter Weg in den Puffer): PV = Summe der frischen
//     Erzeuger, Netz = frischer Netz-Zähler, Haus = PV + Netz − Batterie, mit
//     Batterie 0 nur als Tatsache (siehe sourcesBatteryFact).
//   - producerEntityTelemetry meldet die Lesung jedes Erzeugers als Telemetrie
//     SEINER Komponente (edge/entities/{id}/telemetry, pv_power_kw). Ohne sie
//     hinge die PV-Summe in der Cloud an keiner Komponente: die v1→v2-Brücke
//     legt pv_power_kw nur auf einen battery-hybrid, und das Cockpit liest den
//     PV-Knoten aus telemetry_v2.
//
// Mit Wechselrichter bleibt alles byte-gleich: sein Sample IST das
// Standort-Sample, und die Brücke trägt die Summe bereits auf dem
// battery-hybrid - eine eigene Erzeuger-Telemetrie daneben zählte doppelt.
// Beide Wege gelten nur auf einer PORTAL-verwalteten Anlage (dort nennt das
// Portal die Geräteliste, und „kein Wechselrichter“ ist seine Aussage) und
// schweigen, solange auf edge/telemetry ein Sample eines Wechselrichters
// ankommt - auch ohne gespeicherte Auswahl (sourcesOnlyPlant). Eine
// box-verwaltete Anlage verhält sich wie bisher.

import (
	"encoding/json"
	"log/slog"
	"sort"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/componentapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// primaryStandDown is how long a primary sample on edge/telemetry keeps both
// paths silent: its sample IS the site sample, a second one from the sources
// would interleave two truths (PV with and without the primary).
const primaryStandDown = 2 * time.Minute

// sourcesOnlyPlant is THE gate of both paths: this plant is portal-managed
// (the portal owns the device list and names no inverter - a box-managed
// plant keeps its behaviour byte for byte), the box has no inverter
// selection, no Anlagensteuerung, and no primary sample arrived recently.
func (a *Agent) sourcesOnlyPlant(now time.Time) bool {
	if !a.PortalManagedComponents() {
		return false
	}
	if _, hasInverter := a.GetInverter(); hasInverter {
		return false
	}
	a.srcMu.Lock()
	defer a.srcMu.Unlock()
	if !a.lastPrimaryAt.IsZero() && now.Sub(a.lastPrimaryAt) < primaryStandDown {
		return false
	}
	for _, s := range a.srcs {
		if s.Role == sources.RolePlantController {
			return false // the controller's reading IS the site sample (plantControllerSample)
		}
	}
	return true
}

// sourcesSampleEvery is the cadence of the site sample on a box without an
// inverter: the default read interval of a source (sources.Request, 5 s), so
// three sources do not triple the telemetry rate. Every fold takes each
// source's LATEST fresh reading.
const sourcesSampleEvery = 5 * time.Second

// sourcesSiteSample folds a site sample from the additional sources when this
// box has neither an inverter nor an Anlagensteuerung (see the file comment).
// It never fabricates: without one fresh Erzeuger or Netz reading there is no
// sample, and the PV base is 0 only because there is no primary - the value is
// then exactly what the fresh Erzeuger measured.
func (a *Agent) sourcesSiteSample(now time.Time) {
	if !a.sourcesOnlyPlant(now) {
		return
	}
	a.srcMu.Lock()
	freshPv, freshGrid := false, false
	for _, s := range a.srcs {
		r, ok := a.sourceFresh(s, now)
		if !ok {
			continue
		}
		switch {
		case s.Role == sources.RoleErzeuger && r.pv != nil:
			freshPv = true
		case s.Role == sources.RoleNetz && r.grid != nil:
			freshGrid = true
		}
	}
	if (!freshPv && !freshGrid) || now.Sub(a.lastSourcesSample) < sourcesSampleEvery {
		a.srcMu.Unlock()
		return
	}
	a.lastSourcesSample = now
	a.srcMu.Unlock()

	measurements := map[string]float64{}
	if freshPv {
		// The fold adds Σ fresh Erzeuger onto this base; with no primary the
		// base is nothing, so a dusk reading of 0,0 kW stays a measured 0,0.
		measurements["pv_power_kw"] = 0
	}
	a.foldSiteSample(now.UTC(), measurements, map[string]float64{}, a.sourcesBatteryFact(), nil)
}

// sourcesBatteryFact is the battery term of a box without an inverter: 0 as a
// FACT when nothing on this plant can hold a battery - every configured
// Erzeuger is of a provably batteryless family (inverter.FamilyBatteryless:
// string, micro, SunSpec live, KOSTAL PIKO) and the registry names no storage.
// Anything else is nil: the battery is unknown and the house stays unmeasured,
// never a balance that silently pretends 0 (docs/edge-runtime.md, Messwerte).
func (a *Agent) sourcesBatteryFact() *float64 {
	a.srcMu.Lock()
	for _, s := range a.srcs {
		if s.Role == sources.RoleErzeuger && !inverter.FamilyBatteryless(s.Family) {
			a.srcMu.Unlock()
			return nil
		}
	}
	a.srcMu.Unlock()
	if a.registryHasStorage() {
		return nil
	}
	zero := 0.0
	return &zero
}

// registryHasStorage reports whether the pushed registry names a storage
// entity (a battery-hybrid or any other storage-category component).
func (a *Agent) registryHasStorage() bool {
	a.entMu.Lock()
	defer a.entMu.Unlock()
	for _, e := range a.entRegistry.Entities {
		if e.Type == entities.TypeBatteryHybrid || e.Category() == entities.CategoryStorage {
			return true
		}
	}
	return false
}

// producerEntityTelemetry reports one Erzeuger reading as the per-entity
// telemetry of the component it belongs to, on a box without an inverter (see
// the file comment). It publishes on the local bus like every other entity
// publisher (shelly_control, ebyte_control); onEntityTelemetry then keeps the
// reading for the heartbeat's observed health and queues it for the v2 uplink.
func (a *Agent) producerEntityTelemetry(sourceID string, pv *float64, tsRaw string, now time.Time) {
	if a.Bus == nil || pv == nil || !a.sourcesOnlyPlant(now) {
		return
	}
	a.srcMu.Lock()
	erzeuger := false
	for _, s := range a.srcs {
		if s.ID == sourceID {
			erzeuger = s.Role == sources.RoleErzeuger
			break
		}
	}
	a.srcMu.Unlock()
	if !erzeuger || a.registryHasStorage() {
		return
	}
	entityID := a.sourceEntityIDs()[sourceID]
	if entityID == "" || !a.entityMeasures(entityID, "pv_power_kw") {
		return
	}
	ts := now.UTC()
	if tsRaw != "" {
		if t, err := time.Parse(time.RFC3339, tsRaw); err == nil {
			ts = t.UTC()
		}
	}
	raw, _ := json.Marshal(map[string]any{
		"schema_version": entities.SchemaVersion,
		"entity_id":      entityID,
		"ts":             ts.Format(time.RFC3339Nano),
		"channels":       map[string]float64{"pv_power_kw": *pv},
	})
	if err := a.Bus.Publish(entities.TelemetryTopic(entityID), raw, false); err != nil {
		slog.Error("Erzeuger-Telemetrie der Komponente nicht veröffentlicht", "entity", entityID,
			"source", sourceID, "err", err)
	}
}

// entityMeasures reports whether the registry entity declares the channel.
func (a *Agent) entityMeasures(entityID, channel string) bool {
	a.entMu.Lock()
	defer a.entMu.Unlock()
	e := a.entRegistry.Find(entityID)
	if e == nil {
		return false
	}
	for _, m := range e.Capabilities.Measure {
		if m.Channel == channel {
			return true
		}
	}
	return false
}

// sourceEntityIDs maps each running source id to the registry entity whose
// reading it is - never by order, label or address:
//
//  1. the cloud's adoption pin (edge_source_id, contract D-17), and
//  2. on a portal-managed plant, the entity the box DERIVED the source from
//     (componentapply.Derive, the same rule that wrote sources.json). That
//     answer exists the moment the push is applied - before the cloud's
//     first binding has pinned anything.
//
// Cached per (registry revision, source ids); recomputed when either changes.
func (a *Agent) sourceEntityIDs() map[string]string {
	a.srcMu.Lock()
	running := append([]sources.Source(nil), a.srcs...)
	a.srcMu.Unlock()
	a.entMu.Lock()
	reg := a.entRegistry
	a.entMu.Unlock()

	ids := make([]string, 0, len(running))
	for _, s := range running {
		ids = append(ids, s.ID)
	}
	sort.Strings(ids)
	key := reg.Revision + "\n" + strings.Join(ids, ",")

	a.srcMu.Lock()
	if a.srcEntities != nil && a.srcEntitiesKey == key {
		m := a.srcEntities
		a.srcMu.Unlock()
		return m
	}
	a.srcMu.Unlock()

	m := map[string]string{}
	if componentapply.IsPortalManaged(reg) {
		if plan, err := componentapply.Derive(reg, a.invCat, running, time.Now()); err == nil {
			for src, ent := range plan.SourceEntities {
				m[src] = ent
			}
		}
	}
	for _, e := range reg.Entities {
		if e.EdgeSourceID != "" {
			m[e.EdgeSourceID] = e.ID // the cloud's pin wins over the derivation
		}
	}
	// Only ids that really run here: a pin to a source this box no longer has
	// names nothing.
	running2 := map[string]bool{}
	for _, id := range ids {
		running2[id] = true
	}
	for src := range m {
		if !running2[src] {
			delete(m, src)
		}
	}

	a.srcMu.Lock()
	a.srcEntities = m
	a.srcEntitiesKey = key
	a.srcMu.Unlock()
	return m
}
