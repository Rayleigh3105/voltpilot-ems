package agent

import (
	"log/slog"
	"sort"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/componentapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/topology"
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
	// The local composition follows the registry too; it is rebuilt from the
	// next site sample.
	for id := range a.entComposed {
		if reg.Find(id) == nil {
			delete(a.entComposed, id)
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
	// The deadline-fallback duties follow the registry too (Inkrement 6;
	// no-op unless VP_CONSUMER_CONTROL_ENABLED is set).
	a.rebuildFlexRequirements(reg)
	slog.Info("v2 entity registry applied", "revision", reg.Revision,
		"entities", len(reg.Entities))
	// Einheitsmodell Stufe 1 - the ONE applier: on a PORTAL-managed plant the
	// local device configuration (inverter selection + sources.json) is DERIVED
	// from this push. Deliberately last: the v2 layer above is already
	// consistent and persisted, so a refusal here can never leave the registry
	// half-applied. A box-managed plant (every plant that exists today, and
	// every push from an older cloud) returns immediately - see
	// agent/component_apply.go.
	a.applyComponentsFromRegistry(reg)
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

	// Confirmed-progress evidence for the deadline fallback (Inkrement 6;
	// no-op unless VP_CONSUMER_CONTROL_ENABLED and the entity carries duties).
	a.observeFlexProgress(id, t.Channels, now)

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

// composeEntities refreshes the DISPLAY-ONLY local composition of the composed
// entities (battery-hybrid/grid-meter/house-load) from one gated composite site
// sample - the local twin of the cloud's ComposedEntityFanout (M-B3-local,
// report §3). It is what makes the :8484 entity tiles + Energiefluss show live
// values on a migrated plant whose Layer-1 flows still publish only the v1 site
// sample on edge/telemetry.
//
// HARD BOUNDARY: the result feeds Topology() (the device's own view) and
// NOTHING else - not the store-and-forward buffer, not the v2 uplink, not the
// heartbeat's observed Ist. The cloud already receives this very sample as v1
// telemetry and fans it out into telemetry_v2 itself; uplinking the same values
// from here would double-write. A real per-entity publisher on
// edge/entities/{id}/telemetry always WINS over the composition (see
// entityReading).
func (a *Agent) composeEntities(site map[string]float64, ts time.Time) {
	a.entMu.Lock()
	defer a.entMu.Unlock()
	if len(a.entRegistry.Entities) == 0 {
		a.entComposed = nil
		return
	}
	composed := entities.ComposeLocal(a.entRegistry, site)
	if len(composed) == 0 {
		a.entComposed = nil
		return
	}
	now := time.Now()
	out := make(map[string]entReading, len(composed))
	for id, channels := range composed {
		out[id] = entReading{channels: channels, ts: ts, recv: now}
	}
	a.entComposed = out
}

// entityReading picks the reading that drives the device's own view of one
// entity: a REAL per-entity publisher always wins; the local composition fills
// in for the composed entities of a migrated plant that has none. Caller holds
// entMu.
func (a *Agent) entityReading(id string) (entReading, bool) {
	if er, ok := a.entReadings[id]; ok {
		return er, true
	}
	er, ok := a.entComposed[id]
	return er, ok
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
	// Einheitsmodell Stufe 1: the applier's own Ist. Only present once this
	// plant is portal-managed, so a box-managed plant's heartbeat keeps its
	// exact pre-Stufe-1 bytes.
	sum.ComponentApply = a.componentApplySummary()
	return sum
}

// componentApplySummary reports WHO owns this plant's device configuration and
// which push revision the box really derived its local files from. nil on a
// box-managed plant - a field that is absent can only ever be read as "this box
// does not do that", which is exactly the truth there.
func (a *Agent) componentApplySummary() *cloud.ComponentApplySummary {
	rec := a.componentRecord()
	if rec.Authority != componentapply.AuthorityPortal {
		return nil
	}
	out := &cloud.ComponentApplySummary{
		Authority:       rec.Authority,
		Revision:        rec.Revision,
		RefusedRevision: rec.Refused,
		RefusedReason:   rec.RefusedReason,
	}
	if !rec.AppliedAt.IsZero() {
		out.AppliedAt = rec.AppliedAt.UTC().Format(time.RFC3339)
	}
	return out
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

// primaryHealthWindow is how long the primary inverter's own reading counts as
// live in the heartbeat's per-source block. It mirrors the :8484 dashboard's
// freshness rule ("keine aktuellen Daten" past ~90 s) rather than the source
// freshness machinery, because the primary is read by the always-on poll.
const primaryHealthWindow = 90 * time.Second

// sourcesSummary builds the additive heartbeat block that reports the
// edge-authoritative PER-MEASUREMENT-POINT Ist: the primary inverter plus every
// configured additional source, each with its OWN latest reading and freshness.
// The cloud renders it as the portal's PV breakdown ("39,0 kW = Deye 8,3 +
// Fronius 21,3 + Fronius WR 2 9,3") - the multi-inverter site's parts were
// previously visible only on the device's own :8484 page.
//
// It reports, never decides: the composite telemetry the site publishes is
// untouched, and a stale/never-read point is reported AS SUCH (health), never
// dropped-to-zero. nil when nothing is configured at all (a device before
// commissioning), so a bare heartbeat stays byte-identical.
func (a *Agent) sourcesSummary() *cloud.SourcesSummary {
	now := time.Now().UTC()
	sum := &cloud.SourcesSummary{ReportedAt: now.Format(time.RFC3339)}

	// The primary inverter first (it is the site's base PV contribution).
	a.invMu.Lock()
	inv := a.inv
	a.invMu.Unlock()
	if inv != nil {
		snap := a.State.Get()
		e := cloud.SourceEntry{
			ID: "inverter", Kind: "primary",
			Brand: inv.Brand, Model: inv.Model, Label: inv.Label,
			Health: "never",
		}
		if !snap.LastTelemetry.IsZero() {
			e.Health = "stale"
			if now.Sub(snap.LastTelemetry.UTC()) <= primaryHealthWindow {
				e.Health = "ok"
			}
			e.ReadAt = snap.LastTelemetry.UTC().Format(time.RFC3339)
			e.PvKw = channel(snap.LastReading, "pv_power_kw")
			e.PowerKw = channel(snap.LastReading, "power_kw")
			e.LoadKw = channel(snap.LastReading, "load_kw")
		}
		sum.Entries = append(sum.Entries, e)
	}

	statuses := a.SourceStatuses()
	readings := a.SourceLastReadings()
	for _, s := range a.ListSources() {
		e := cloud.SourceEntry{
			ID: s.ID, Kind: "source", Role: s.Role,
			Brand: s.Brand, Model: s.Model, Label: s.Label,
			Health: "never",
		}
		switch statuses[s.ID] {
		case "ok":
			e.Health = "ok"
		case "warn":
			e.Health = "stale"
		}
		if r, ok := readings[s.ID]; ok {
			e.PvKw, e.PowerKw, e.LoadKw = r.PvKw, r.PowerKw, r.LoadKw
			e.ReadAt = time.UnixMilli(r.ReadAtMs).UTC().Format(time.RFC3339)
		}
		sum.Entries = append(sum.Entries, e)
	}
	if len(sum.Entries) == 0 {
		return nil
	}
	return sum
}

// channel returns a copy of one channel of the primary's last reading, or nil
// when the device never delivered it (absent stays absent, never a fake 0).
func channel(reading map[string]float64, name string) *float64 {
	v, ok := reading[name]
	if !ok {
		return nil
	}
	return &v
}

// Topology builds the Anlagen-Topologie-Read-Model (AE1) from the applied
// entity registry + the latest per-entity local readings, using the SHARED
// derivation (topology.Resolve default roles -> topology.Derive). A device
// without a pushed registry yields an empty topology (byte-for-byte v1). The
// edge uses default role assignments only; the cloud layers stored overrides
// on the same defaults (contract docs/contracts/v2/topology-read-model.md).
//
// Since PR 4a (vp-vier-erzeuger-p9, contract D-17) an entity whose registry
// descriptor carries its adoption pin (edge_source_id) and has no reading of
// its own is filled DISPLAY-ONLY from the device's OWN source readings - the
// deterministic mapping the cloud pinned, never an order guess. The hybrid's
// pv then shows the PRE-FOLD primary value so the PV role never double-counts
// (the composite = primary + Σ sources lives on the fold, not here). Boundary
// exactly like ComposeLocal: Topology feeds the :8484 view and the /api/state
// topology block ONLY - never the store-and-forward buffer, the v2 uplink or
// the heartbeat's observed Ist.
func (a *Agent) Topology() topology.Topology {
	now := time.Now()
	// Source state is read BEFORE entMu (lock-order discipline: these take
	// srcMu / the state lock internally).
	srcReadings := a.SourceLastReadings()
	srcStatuses := a.SourceStatuses()
	primary := a.State.Get().LastReading

	a.entMu.Lock()
	reg := a.entRegistry
	raw := make([]topology.RawEntity, 0, len(reg.Entities))
	pvFilledFromSource := false
	hybridIdx := -1
	for _, e := range reg.Entities {
		er, ok := a.entityReading(e.ID)
		re := topology.RawEntity{
			ID: e.ID, Type: e.Type, Label: e.Label,
			Category: e.Category(), Health: entityHealth(er, now, ok),
		}
		var src *sources.LastReading
		srcHealth := ""
		if e.EdgeSourceID != "" {
			if r, has := srcReadings[e.EdgeSourceID]; has {
				switch srcStatuses[e.EdgeSourceID] {
				case "ok":
					c := r
					src, srcHealth = &c, "ok"
				case "warn":
					// A stale source keeps its last value; the health says so.
					c := r
					src, srcHealth = &c, "stale"
				}
			}
		}
		for _, m := range e.Capabilities.Measure {
			ch := topology.RawChannel{Channel: m.Channel}
			if ok {
				if v, has := er.channels[m.Channel]; has {
					val := v
					ch.Value = &val
				}
			}
			if ch.Value == nil && src != nil {
				if v := sourceChannelValue(*src, m.Channel); v != nil {
					ch.Value = v
					if m.Channel == "pv_power_kw" {
						pvFilledFromSource = true
					}
					if re.Health == "never" {
						re.Health = srcHealth
					}
				}
			}
			re.Channels = append(re.Channels, ch)
		}
		if e.Type == entities.TypeBatteryHybrid {
			hybridIdx = len(raw)
		}
		raw = append(raw, re)
	}
	a.entMu.Unlock()

	// With producers now carrying their OWN source values, the hybrid must
	// show its pre-fold primary pv - its composed value is the folded site
	// total (primary + Σ sources) and would double-count in the role sum.
	if pvFilledFromSource && hybridIdx >= 0 {
		if v, has := primary["pv_power_kw"]; has {
			for i := range raw[hybridIdx].Channels {
				if raw[hybridIdx].Channels[i].Channel == "pv_power_kw" &&
					raw[hybridIdx].Channels[i].Value != nil {
					val := v
					raw[hybridIdx].Channels[i].Value = &val
				}
			}
		}
	}
	return topology.Derive(topology.Resolve(raw))
}

// sourceChannelValue maps one source reading onto an entity measure channel:
// pv_power_kw <- the source's pv, power_kw <- its signed grid power (a Netz
// meter) else its consumer load (a wallbox reports load_kw, its entity
// declares power_kw). Absent stays absent - never a fabricated 0.
func sourceChannelValue(r sources.LastReading, channel string) *float64 {
	switch channel {
	case "pv_power_kw":
		if r.PvKw != nil {
			v := *r.PvKw
			return &v
		}
	case "power_kw":
		if r.PowerKw != nil {
			v := *r.PowerKw
			return &v
		}
		if r.LoadKw != nil {
			v := *r.LoadKw
			return &v
		}
	}
	return nil
}

// entityHealth maps a reading's freshness to the read-model health word,
// mirroring entitiesSummary (never/stale/ok on the 5-min liveness window).
func entityHealth(er entReading, now time.Time, has bool) string {
	if !has {
		return "never"
	}
	if now.Sub(er.recv) <= entityHealthWindow {
		return "ok"
	}
	return "stale"
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
