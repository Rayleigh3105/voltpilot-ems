package agent

import (
	"log/slog"
	"sort"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// The v2 entity layer of the agent (contract:
// docs/contracts/v2/edge-entity-config.md; package entities holds the pure
// model). The cloud pushes the entity set retained on .../v2/entities; the
// agent persists it, mirrors it as per-entity RETAINED local configs (D-3),
// consumes per-entity local telemetry, routes accepted readings through the
// store-and-forward buffer to the v2 uplink (E1b - same replay/ack
// discipline as v1), clamps whatever commands an entity through its
// registry-derived guard chain, and reports the applied revision PLUS the
// per-entity observed Ist and the local commissioning view in the status
// heartbeat (E1b bidirectional sync - the cloud reconciles, never silently
// overwrites). A device without a pushed registry behaves byte-for-byte v1.

// entReading is the latest accepted local telemetry of one entity.
type entReading struct {
	channels map[string]float64
	ts       time.Time // observation (zero = none given)
	recv     time.Time // arrival on the local bus
}

// onEntityRegistryPush handles the retained .../v2/entities payload. An empty
// payload clears the registry (retained-clear = device has no v2 entities).
func (a *Agent) onEntityRegistryPush(payload []byte) {
	a.entMu.Lock()
	id := a.entIdentity
	a.entMu.Unlock()
	if id.DeviceID == "" {
		slog.Warn("v2 entity registry push before cloud identity is known; ignored")
		return
	}

	var reg entities.Registry
	if len(payload) > 0 {
		parsed, skipped, err := entities.ParseRegistryPush(payload, id)
		if err != nil {
			slog.Warn("v2 entity registry push rejected", "err", err)
			return
		}
		for _, s := range skipped {
			slog.Warn("v2 entity registry push: entry skipped", "detail", s)
		}
		reg = parsed
	}
	a.applyEntityRegistry(reg)
}

// applyEntityRegistry diffs the new set against the current one, republishes
// the per-entity retained configs, clears removed entities (config AND
// command - the provisioning clearRetained precedent), persists, and stamps
// the heartbeat ack.
func (a *Agent) applyEntityRegistry(reg entities.Registry) {
	a.entMu.Lock()
	old := a.entRegistry
	a.entRegistry = reg
	a.entAppliedAt = time.Now()
	for id := range a.entReadings {
		if reg.Find(id) == nil {
			delete(a.entReadings, id)
		}
	}
	a.entMu.Unlock()

	for _, e := range old.Entities {
		if reg.Find(e.ID) == nil {
			a.publishEntityRetained(entities.ConfigTopic(e.ID), nil)
			a.publishEntityRetained(entities.CommandTopic(e.ID), nil)
		}
	}
	for _, e := range reg.Entities {
		a.publishEntityRetained(entities.ConfigTopic(e.ID), e.ConfigPayload(reg.Revision))
	}

	if a.entStore != nil {
		if err := a.entStore.Save(reg); err != nil {
			slog.Error("persisting v2 entity registry failed", "err", err)
		}
	}
	// The arbiter's per-entity states follow the registry (desires for
	// removed entities are dropped; their retained commands were cleared
	// above).
	if a.arb != nil {
		a.arb.SetEntities(reg)
		a.pokeArbitration()
	}
	slog.Info("v2 entity registry applied", "revision", reg.Revision,
		"entities", len(reg.Entities))
}

// publishEntityConfigs republishes the persisted per-entity retained configs
// at boot - the in-process local bus loses retained state with the process
// (the inverter/sources-config precedent).
func (a *Agent) publishEntityConfigs() {
	a.entMu.Lock()
	reg := a.entRegistry
	a.entMu.Unlock()
	for _, e := range reg.Entities {
		a.publishEntityRetained(entities.ConfigTopic(e.ID), e.ConfigPayload(reg.Revision))
	}
}

func (a *Agent) publishEntityRetained(topic string, payload []byte) {
	if a.Bus == nil {
		return
	}
	if err := a.Bus.Publish(topic, payload, true); err != nil {
		slog.Error("entity retained publish failed", "topic", topic, "err", err)
	}
}

// onEntityTelemetry consumes edge/entities/{id}/telemetry: identity-checked,
// parsed, kept as the entity's latest reading (feeding the per-entity guard
// context), and queued for the v2 uplink. Unknown entities are ignored (a
// publisher without a pushed registry entry is not an error - it is simply
// not part of this device's entity set yet).
func (a *Agent) onEntityTelemetry(topic string, payload []byte) {
	id := entities.IDFromTopic(topic, "telemetry")
	if id == "" {
		return
	}
	a.entMu.Lock()
	known := a.entRegistry.Find(id) != nil
	a.entMu.Unlock()
	if !known {
		return
	}
	t, err := entities.ParseTelemetry(id, payload)
	if err != nil {
		slog.Debug("entity telemetry dropped", "entity", id, "err", err)
		return
	}
	now := time.Now()
	a.entMu.Lock()
	if a.entReadings == nil {
		a.entReadings = map[string]entReading{}
	}
	a.entReadings[id] = entReading{channels: t.Channels, ts: t.Ts, recv: now}
	a.entMu.Unlock()

	// Store-and-forward (E1b): the v2 uplink rides the SAME buffer as v1
	// telemetry - appended with its ORIGINAL observation time, drained by
	// the publisher loop, acked only after the QoS1 confirm. The unclaim
	// pause applies exactly like v1 (no claimed identity to deliver to).
	if a.cloudRemoved.Load() {
		return
	}
	ts := t.Ts
	if ts.IsZero() {
		ts = now
	}
	if _, err := a.buf.AppendEntity(id, ts, t.Channels); err != nil {
		slog.Error("v2 telemetry buffer append failed", "entity", id, "err", err)
		return
	}
	a.State.Update(func(s *state.Snapshot) {
		s.BufferPending = a.buf.Pending()
		s.BufferDataLoss = a.buf.DataLoss()
	})
	a.kick()
}

// entityHealthWindow is the per-entity telemetry liveness window for the
// heartbeat's observed health (mirrors the portal's 5-min device window).
const entityHealthWindow = 5 * time.Minute

// entitiesSummary builds the additive heartbeat ack block (nil = no entities
// - a device without a pushed registry stays byte-for-byte v1, so the
// local_setup Ist also only ships once the device has v2 entities).
func (a *Agent) entitiesSummary() *cloud.EntitiesSummary {
	now := time.Now()
	a.entMu.Lock()
	sum := &cloud.EntitiesSummary{
		Revision:  a.entRegistry.Revision,
		AppliedAt: a.entAppliedAt.UTC().Format(time.RFC3339),
		Count:     len(a.entRegistry.Entities),
		IDs:       a.entRegistry.IDs(),
	}
	if sum.Count > 0 {
		sum.Observed = map[string]cloud.EntityObserved{}
		for _, e := range a.entRegistry.Entities {
			obs := cloud.EntityObserved{EntityType: e.Type, Health: "never"}
			if er, ok := a.entReadings[e.ID]; ok {
				obs.Health = "stale"
				if now.Sub(er.recv) <= entityHealthWindow {
					obs.Health = "ok"
				}
				ts := er.ts
				if ts.IsZero() {
					ts = er.recv
				}
				obs.LastTelemetryAt = ts.UTC().Format(time.RFC3339)
				channels := make([]string, 0, len(er.channels))
				for name := range er.channels {
					channels = append(channels, name)
				}
				sort.Strings(channels)
				obs.Channels = channels
			}
			sum.Observed[e.ID] = obs
		}
	}
	a.entMu.Unlock()
	if sum.Count == 0 {
		return nil
	}
	sum.LocalSetup = a.localSetupSummary()
	// The E2 per-entity decision map (holder/granted/all_match) is built
	// outside entMu - it reads the arbiter and the readback records.
	sum.Arbitration = a.arbitrationSummary()
	return sum
}

// localSetupSummary reports the edge-authoritative commissioning view (the
// :8484 inverter selection + sources) as the heartbeat's local Ist - the
// cloud reconciles it against its registry, never auto-imports it.
func (a *Agent) localSetupSummary() []cloud.LocalSetupEntry {
	var out []cloud.LocalSetupEntry
	a.invMu.Lock()
	if a.inv != nil {
		out = append(out, cloud.LocalSetupEntry{
			ID:    "inverter",
			Kind:  "inverter",
			Brand: a.inv.Brand,
			Model: a.inv.Model,
			Label: a.inv.Label,
		})
	}
	a.invMu.Unlock()
	for _, s := range a.ListSources() {
		out = append(out, cloud.LocalSetupEntry{
			ID:    s.ID,
			Kind:  "source",
			Role:  s.Role,
			Brand: s.Brand,
			Model: s.Model,
			Label: s.Label,
		})
	}
	return out
}

// entityGuardReading builds the guard context for one entity from ITS latest
// channels, falling back to the site reading for anything it never reported
// (the battery-hybrid entity usually reports soc/pv itself; grid limit stays
// a site-level observation).
func (a *Agent) entityGuardReading(id string) guards.Reading {
	a.mu.Lock()
	r := a.lastReading
	a.mu.Unlock()
	a.entMu.Lock()
	er, ok := a.entReadings[id]
	a.entMu.Unlock()
	if !ok {
		return r
	}
	if v, ok := er.channels["soc_pct"]; ok {
		r.SocPct = v
	}
	if v, ok := er.channels["pv_power_kw"]; ok {
		r.PvKw = v
	}
	return r
}

// restoreEntities loads the persisted registry at boot (before Start
// republishes the retained configs).
func (a *Agent) restoreEntities() {
	if a.entStore == nil {
		return
	}
	reg, ok, err := a.entStore.Load()
	if err != nil {
		slog.Warn("persisted v2 entity registry unreadable", "err", err)
		return
	}
	if ok {
		a.entRegistry = reg
		a.entAppliedAt = time.Now()
	}
}

// setEntityIdentity records the cloud identity the registry push must match.
func (a *Agent) setEntityIdentity(tenantID, siteID, deviceID string) {
	a.entMu.Lock()
	a.entIdentity = entities.Identity{TenantID: tenantID, SiteID: siteID, DeviceID: deviceID}
	a.entMu.Unlock()
}

// entitySubscriptionID is the local-bus subscription id of the telemetry
// wildcard (ids 1-5 are taken in Start).
const entitySubscriptionID = 6

// startEntityLayer wires the local half: the telemetry wildcard subscription
// and the boot republish of retained configs. The v2 uplink needs no own
// loop since E1b - accepted readings enter the shared buffer and the v1
// publisherLoop drains both eras.
func (a *Agent) startEntityLayer() error {
	if err := a.Bus.Subscribe(entities.TelemetryWildcard, entitySubscriptionID,
		a.onEntityTelemetry); err != nil {
		return err
	}
	a.publishEntityConfigs()
	return nil
}
