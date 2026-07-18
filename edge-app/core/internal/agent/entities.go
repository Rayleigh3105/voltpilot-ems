package agent

import (
	"context"
	"log/slog"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

// The v2 entity layer of the agent (contract:
// docs/contracts/v2/edge-entity-config.md; package entities holds the pure
// model). One-way registry sync in E1a: the cloud pushes the entity set
// retained on .../v2/entities; the agent persists it, mirrors it as
// per-entity RETAINED local configs (D-3), consumes per-entity local
// telemetry, forwards accepted readings to the v2 uplink, clamps whatever
// commands an entity through its registry-derived guard chain, and echoes the
// applied revision in the status heartbeat. A device without a pushed
// registry behaves byte-for-byte v1.

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

	// Queue for the live v2 uplink; a full queue drops the sample (E1a is
	// live-only - no v2 store-and-forward yet; the v1 buffer is untouched).
	select {
	case a.entUplink <- t:
	default:
		slog.Debug("v2 uplink queue full, sample dropped", "entity", id)
	}
}

// entityUplinkLoop forwards accepted per-entity readings to the cloud as
// mqtt-telemetry-2.0 messages while the link is up (live-only in E1a).
func (a *Agent) entityUplinkLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case t := <-a.entUplink:
			a.linkMu.Lock()
			link := a.link
			a.linkMu.Unlock()
			if link == nil || !link.Connected() {
				continue // dropped: live-only, honest about it
			}
			ts := t.Ts
			if ts.IsZero() {
				ts = time.Now()
			}
			if err := link.PublishTelemetryV2(t.EntityID, ts, t.Channels); err != nil {
				slog.Warn("v2 telemetry publish failed", "entity", t.EntityID, "err", err)
			}
		}
	}
}

// entitiesSummary builds the additive heartbeat ack block (nil = no entities).
func (a *Agent) entitiesSummary() *cloud.EntitiesSummary {
	a.entMu.Lock()
	defer a.entMu.Unlock()
	if len(a.entRegistry.Entities) == 0 {
		return nil
	}
	return &cloud.EntitiesSummary{
		Revision:  a.entRegistry.Revision,
		AppliedAt: a.entAppliedAt.UTC().Format(time.RFC3339),
		Count:     len(a.entRegistry.Entities),
		IDs:       a.entRegistry.IDs(),
	}
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

// mirrorEntityCommand is the E1a command bridge: whatever the v1 execution
// path commands (the guard-clamped setpoint + optional pv limit) is ALSO
// published as the battery-hybrid entity's retained command - re-clamped
// through the entity's OWN registry-derived guard chain (most restrictive
// wins), so the per-entity guards are live on a running device before the E2
// arbitration lands. No battery-hybrid entity = no publish (pure v1).
func (a *Agent) mirrorEntityCommand(now time.Time, setpointKw float64, pvLimit *float64,
	source string, controlEnabled bool) {
	a.entMu.Lock()
	var battery *entities.Entity
	if e := a.entRegistry.FirstOfType(entities.TypeBatteryHybrid); e != nil {
		copied := *e
		battery = &copied
	}
	a.entMu.Unlock()
	if battery == nil {
		return
	}
	wish := entities.Commands{SetpointKw: &setpointKw}
	if pvLimit != nil {
		wish.LimitKw = pvLimit
	}
	granted := battery.ClampCommands(wish, a.entityGuardReading(battery.ID))
	if granted.Empty() {
		return
	}
	payload := entities.CommandPayload(battery.ID, now, controlEnabled, source, granted)
	a.publishEntityRetained(entities.CommandTopic(battery.ID), payload)
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

// startEntityLayer wires the local half: the telemetry wildcard subscription,
// the boot republish of retained configs, and the uplink loop.
func (a *Agent) startEntityLayer(ctx context.Context) error {
	if err := a.Bus.Subscribe(entities.TelemetryWildcard, entitySubscriptionID,
		a.onEntityTelemetry); err != nil {
		return err
	}
	a.publishEntityConfigs()
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		a.entityUplinkLoop(ctx)
	}()
	return nil
}
