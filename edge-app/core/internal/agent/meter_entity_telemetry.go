package agent

// Unterverteilungen (Konzept vp-unterzaehler-anzeige, Stufe 1, B1): ein Zähler,
// den die Box als eigene Quelle liest - ein Unterzähler in einer
// Unterverteilung oder der Netz-Zähler -, meldet seine Werte als Telemetrie
// SEINER Komponente (edge/entities/{id}/telemetry).
//
// Bis hierher erreichte die Cloud von einem Unterzähler nur der letzte kW-Wert
// im Herzschlag (sources[]); Phasen und Zählerstände fielen schon in Layer 1
// weg. Ohne Reihe in telemetry_v2 gab es für die Komponente keine Heute-kWh,
// keinen Verlauf und keine Messwerte (Schramm „Zuhause“, UV Halle/UV Keller,
// 07.11.2026).
//
// Welche Kanäle:
//
//   - Unterzähler (Rolle consumer): power_kw (= load_kw der Quelle), dazu die
//     Zählerstände energy_kwh (Bezug) und energy_export_kwh (Rückfluss) und
//     die Leistung je Phase power_l1_kw … power_l3_kw.
//   - Netz-Zähler (Rolle grid-meter): NUR die Zählerstände und Phasen. Seine
//     Leistung trägt schon das Standort-Sample; die v1→v2-Brücke der Cloud
//     (ComposedEntityFanout) schreibt sie als power_kw derselben Komponente.
//     Ein zweiter Schreiber desselben Kanals verschränkte zwei Zeitreihen.
//
// Jeder Kanal geht nur hinaus, wenn die Komponente ihn im Registry-Push
// nennt (capabilities.measure; die Cloud leitet sie aus dem Typkatalog ab) -
// dieselbe Regel wie producerEntityTelemetry. Ein Unterzähler aus einer
// älteren Cloud (Typ generic-load, nur power_kw) meldet also nur seine
// Leistung. Welche Komponente zur Quelle gehört, sagt sourceEntityIDs (Pin der
// Cloud, sonst die Ableitung des Pushs) - nie Reihenfolge, Name oder Adresse.
//
// Ein Unterzähler steht IN der Hauslast: er geht nie in das Standort-Sample
// und nie in die Bilanz (sourcesSiteSample liest nur Erzeuger und Netz).
// Gedrosselt auf den Quellentakt (höchstens alle 5 s je Komponente), damit ein
// kürzeres Leseintervall den Puffer nicht flutet.

import (
	"encoding/json"
	"log/slog"
	"sort"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// meterTelemetryEvery is the cadence limit per meter component: the default
// read interval of a source (sources.Request, 5 s), like sourcesSampleEvery.
const meterTelemetryEvery = 5 * time.Second

// meterReading is one meter reading: a sub-meter's load (its power_kw) and
// the meter details (sources.MeterDetailChannels).
type meterReading struct {
	load    *float64
	details map[string]float64
}

// meterEntityTelemetry reports one meter reading as the telemetry of the
// meter's component (see the file comment).
func (a *Agent) meterEntityTelemetry(sourceID string, r meterReading, tsRaw string, now time.Time) {
	if a.Bus == nil {
		return
	}
	a.srcMu.Lock()
	role, meter := "", false
	for _, s := range a.srcs {
		if s.ID == sourceID {
			role = s.Role
			meter = s.Communication == inverter.CommShellyEMHTTP
			break
		}
	}
	a.srcMu.Unlock()
	if !meter || (role != sources.RoleConsumer && role != sources.RoleNetz) {
		return
	}
	entityID := a.sourceEntityIDs()[sourceID]
	if entityID == "" {
		return
	}
	channels := map[string]float64{}
	if role == sources.RoleConsumer && r.load != nil {
		channels["power_kw"] = *r.load
	}
	for _, ch := range sources.MeterDetailChannels {
		if v, ok := r.details[ch]; ok {
			channels[ch] = v
		}
	}
	for ch := range channels {
		if !a.entityMeasures(entityID, ch) {
			delete(channels, ch)
		}
	}
	if len(channels) == 0 {
		return
	}
	a.srcMu.Lock()
	if last, ok := a.lastMeterTelemetry[entityID]; ok && now.Sub(last) < meterTelemetryEvery {
		a.srcMu.Unlock()
		return
	}
	if a.lastMeterTelemetry == nil {
		a.lastMeterTelemetry = map[string]time.Time{}
	}
	a.lastMeterTelemetry[entityID] = now
	a.srcMu.Unlock()

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
		"channels":       channels,
	})
	if err := a.Bus.Publish(entities.TelemetryTopic(entityID), raw, false); err != nil {
		names := make([]string, 0, len(channels))
		for ch := range channels {
			names = append(names, ch)
		}
		sort.Strings(names)
		slog.Error("Zähler-Telemetrie der Komponente nicht veröffentlicht", "entity", entityID,
			"source", sourceID, "channels", names, "err", err)
	}
}
