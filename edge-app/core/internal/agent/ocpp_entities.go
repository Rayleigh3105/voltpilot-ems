package agent

import (
	"encoding/json"
	"log/slog"
	"math"
	"sort"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

// Cockpit Phase 1 / E1: a charge point becomes a MEASURING component.
//
// Until now a wallbox's kilowatts existed only inside the `chargers` heartbeat
// block - a second read path the portal had to special-case, and one that never
// reached telemetry_v2, the rollups, the entity history or the topology. The
// numbers were always there (csms/meter.go decodes them out of MeterValues);
// what was missing was the ONE step every other measuring component already
// takes: publish them as ordinary per-entity telemetry on
// edge/entities/{id}/telemetry, the E1b path (see agent/entities.go).
//
// From there the existing chain does the rest, byte for byte the same way it
// does for a metering Shelly: identity check -> store-and-forward buffer ->
// v2 uplink -> telemetry_v2 -> rollups -> per-entity history + topology.
//
// ⚠ THE MAPPING IS THE CLOUD'S, NOT A GUESS. Which entity a charge point IS
// comes from the registry descriptor's `charge_point_id` (the twin of
// `edge_source_id` one transport over) - the cloud binds it in
// device_charge_point.entity_id. Without that field NOTHING is published: a box
// paired with an older cloud stays byte-identical to before this feature, and
// there is no fallback that could pin readings onto the wrong component.

// ocppEntityReading is what ONE charge point measured, ready for the local bus.
type ocppEntityReading struct {
	EntityID string
	Ts       time.Time
	Channels map[string]float64
}

// ocppEntityReadings is the PURE rule (no clock, no I/O, no state): it turns a
// CSMS snapshot plus the cloud's charge-point -> entity binding into the set of
// per-entity readings to publish.
//
// Three honesty rules, each the house rule applied to this transport:
//
//  1. **Only FRESH measurements count.** A connector's MeteredAt older than
//     maxAge is not a reading at all - it is the last thing we heard. The same
//     window ChargingTotal uses (ocppMeterMaxAge), so the value that reaches
//     the cloud and the value that shapes the budget can never disagree about
//     what "measured" means.
//  2. **Not measured is never 0, and a PARTIAL sum is not a measurement.** A
//     plug that has never metered simply contributes nothing (it is not part
//     of the sum). But a plug that HAS metered and then went silent makes the
//     station's total INCOMPLETE - publishing the remainder would quietly drop
//     its share and read downstream as the station's real power. Such a
//     station publishes NOTHING, so the series GAPS instead of under-reporting
//     (the ChargingTotal "complete" discipline, one level up). A measured 0.0
//     is a different thing and IS published - a plugged-in car taking nothing
//     is a fact the station reported.
//  3. **The timestamp is the OBSERVATION, not the tick.** Ts is the newest
//     contributing MeteredAt, so re-publishing an unchanged sample is a no-op
//     at the idempotent (entity, channel, time) insert, and the recorded time
//     is when the station measured - not when we got round to asking.
//
// ⚠ soc_pct is deliberately NOT published, although the ev-charger catalog type
// declares it: it is the CAR's state of charge, not the station's, and
// topology.DefaultRole maps a soc_pct capability onto the STORAGE node
// regardless of category - a wallbox would start filling in the house battery's
// SoC. Summing or averaging it across connectors would be nonsense besides.
func ocppEntityReadings(snap csms.Snapshot, entityByChargePoint map[string]string,
	now time.Time, maxAge time.Duration) []ocppEntityReading {
	if len(entityByChargePoint) == 0 {
		return nil
	}
	out := make([]ocppEntityReading, 0, len(entityByChargePoint))
	for _, c := range snap.Chargers {
		entityID := entityByChargePoint[c.ID]
		if entityID == "" {
			continue
		}
		var power, energy float64
		havePower, haveEnergy := false, false
		incomplete := false
		var newest time.Time
		for _, con := range c.Connectors {
			if con.MeteredAt.IsZero() {
				// Never metered: not part of this station's sum at all.
				continue
			}
			if now.Sub(con.MeteredAt) > maxAge {
				// Metered before, silent now - the station's total cannot be
				// formed without inventing this plug's share.
				incomplete = true
				continue
			}
			contributed := false
			if con.PowerKw != nil {
				power += *con.PowerKw
				havePower = true
				contributed = true
			}
			// The energy register is CUMULATIVE. Summing the registers of a
			// station's plugs is the station's own delivered energy, and it
			// stays monotone as long as each plug's register does - which is
			// exactly what the counter rollup expects.
			if con.EnergyKwh != nil {
				energy += *con.EnergyKwh
				haveEnergy = true
				contributed = true
			}
			if contributed && con.MeteredAt.After(newest) {
				newest = con.MeteredAt
			}
		}
		if incomplete || (!havePower && !haveEnergy) {
			continue
		}
		ch := map[string]float64{}
		if havePower {
			ch["power_kw"] = round3(power)
		}
		if haveEnergy {
			ch["energy_kwh"] = round3(energy)
		}
		out = append(out, ocppEntityReading{EntityID: entityID, Ts: newest, Channels: ch})
	}
	// Deterministic order so a test - and a log - sees the same sequence twice.
	sort.Slice(out, func(i, j int) bool { return out[i].EntityID < out[j].EntityID })
	return out
}

// chargePointEntities reads the applied registry's charge-point bindings.
// Empty when the cloud never sent one (an older cloud, or a site without a
// charge-point component yet).
// chargePointConnections is WHERE each charge point hangs, keyed by its OCPP
// ChargePointId: csms.ConnectionHaus / ConnectionEigen, absent = the portal
// never said. It feeds the topology's role resolution (Cockpit Phase 1 / C2):
// a station on its OWN grid connection is not inside the house measurement, so
// it must not become a branch of the house node.
//
// Read from the CSMS snapshot, the same place the budget law reads it, so the
// picture and the arithmetic can never disagree about a station's connection.
func (a *Agent) chargePointConnections() map[string]string {
	rt := a.ocpp
	if rt == nil {
		return nil
	}
	out := map[string]string{}
	for _, c := range rt.srv.Snapshot().Chargers {
		if c.Connection != "" {
			out[c.ID] = c.Connection
		}
	}
	return out
}

func (a *Agent) chargePointEntities() map[string]string {
	a.entMu.Lock()
	defer a.entMu.Unlock()
	out := map[string]string{}
	for _, e := range a.entRegistry.Entities {
		if e.ChargePointID != "" {
			out[e.ChargePointID] = e.ID
		}
	}
	return out
}

// publishOcppEntityTelemetry publishes one per-entity reading per charge point
// that measured something fresh. It runs at the end of an OCPP pass, next to
// publishOcppState - the same choke point, so the card, the heartbeat and the
// entity series are all formed from ONE snapshot.
//
// Re-publishing an identical sample is suppressed: the pass runs on a 20 s tick
// AND on every station event, so an unchanged MeterValues sample would
// otherwise be appended to the store-and-forward buffer several times. The
// insert is idempotent per (entity, channel, time) anyway - this only keeps the
// buffer honest about how much is really pending.
func (a *Agent) publishOcppEntityTelemetry(snap csms.Snapshot, now time.Time) {
	if a.Bus == nil {
		return
	}
	binding := a.chargePointEntities()
	if len(binding) == 0 {
		return
	}
	for _, r := range ocppEntityReadings(snap, binding, now, ocppMeterMaxAge) {
		if !a.ocppMarkPublished(r) {
			continue
		}
		raw, err := json.Marshal(map[string]any{
			"schema_version": entities.SchemaVersion,
			"entity_id":      r.EntityID,
			"ts":             r.Ts.UTC().Format(time.RFC3339),
			"channels":       r.Channels,
		})
		if err != nil {
			continue
		}
		if err := a.Bus.Publish(entities.TelemetryTopic(r.EntityID), raw, false); err != nil {
			slog.Error("charge point entity telemetry publish failed",
				"entity", r.EntityID, "err", err)
		}
	}
}

// ocppMarkPublished reports whether this reading differs from the last one
// published for its entity, recording it when it does.
func (a *Agent) ocppMarkPublished(r ocppEntityReading) bool {
	rt := a.ocpp
	if rt == nil {
		return true
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.entityPublished == nil {
		rt.entityPublished = map[string]ocppEntityReading{}
	}
	prev, ok := rt.entityPublished[r.EntityID]
	if ok && prev.Ts.Equal(r.Ts) && sameChannels(prev.Channels, r.Channels) {
		return false
	}
	rt.entityPublished[r.EntityID] = r
	return true
}

// round3 keeps the published channels at the topology/telemetry precision so a
// float artefact never reads as a changed measurement.
func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

func sameChannels(a, b map[string]float64) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		w, ok := b[k]
		if !ok || w != v {
			return false
		}
	}
	return true
}
