package agent

// Manual consumer override forward (Verbrauchssteuerung §11 / §14.13
// "Jetzt starten" / "Jetzt stoppen" / "Automatik fortsetzen"). The portal
// publishes a NON-RETAINED envelope on ems/{t}/{s}/{d}/v2/desired; this rides
// the EXISTING desired-override way - it forwards the desired to the local bus
// where the E2 arbiter validates it (schema, identity, capability, priority),
// clamps it through the per-entity guard band and enforces the bounded override
// TTL (Source local-ui, class flow, override - above the market plan, below
// contract/grid/safety). Nothing new about the override mechanism; only the
// transport is added.

import (
	"encoding/json"
	"log/slog"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

// onDesiredDownlink handles one manual override envelope. It is gated on the
// consumer control master switch (§19 Inkrement 5): with VP_CONSUMER_CONTROL_
// ENABLED off (the default) the edge ignores the downlink entirely, so a plant
// with the consumer flags off behaves byte-for-byte as before the feature.
// ⚠ The gate is ENTITY-DEPENDENT since Steuerung Stufe 4 (§3.7 B3). A
// CONSUMER wish still hangs on the consumer master switch
// (VP_CONSUMER_CONTROL_ENABLED, default off). A STORAGE wish - „Speicher jetzt
// laden" / „Ladestand halten" - hangs on the switch that actually governs the
// inverter instead: VP_CONTROL_ENABLED plus the model certification, the same
// two gates the plan's own setpoints pass. Hanging the battery on the CONSUMER
// flag would have made the storage intervention dead on every plant.
// An UNKNOWN entity keeps the strict (both-flags) gate: what we cannot
// classify we do not widen.
func (a *Agent) onDesiredDownlink(payload []byte) {
	if !a.Cfg.ControlEnabled {
		return
	}
	var env struct {
		EntityID string `json:"entity_id"`
		Withdraw bool   `json:"withdraw"`
	}
	if err := json.Unmarshal(payload, &env); err != nil || env.EntityID == "" {
		return
	}
	if !a.desiredDownlinkAllowed(env.EntityID) {
		return
	}
	if env.Withdraw {
		// "Automatik fortsetzen": end the intervention now so the plan/automation
		// re-takes at once, without waiting out the TTL. Source local-ui holds one
		// slot per entity, so the key is stable.
		a.arb.Withdraw(env.EntityID, desired.Source{Kind: desired.SourceLocalUI}.Key(), false)
		a.pokeArbitration()
		slog.Info("manual consumer override withdrawn", "entity", env.EntityID)
		return
	}
	if a.Bus == nil {
		return
	}
	// Forward the desired verbatim to the local bus; the arbiter's onEntityDesired
	// picks it up and does the validation + clamp + TTL. NOT retained on the local
	// bus either (a desire is an input with an expiry, never a state).
	if err := a.Bus.Publish(desired.DesiredTopic(env.EntityID), payload, false); err != nil {
		slog.Warn("could not forward manual override to the local bus",
			"entity", env.EntityID, "err", err)
		return
	}
	a.pokeArbitration()
	slog.Info("manual consumer override forwarded to the arbiter", "entity", env.EntityID)
}

// desiredDownlinkAllowed is the entity-dependent half of the Stufe-4 gate
// (§3.7 B3): storage rides VP_CONTROL_ENABLED + the model certification (the
// caller already checked the former), everything else keeps needing the
// consumer master switch.
func (a *Agent) desiredDownlinkAllowed(entityID string) bool {
	a.entMu.Lock()
	e := a.entRegistry.Find(entityID)
	a.entMu.Unlock()
	if e != nil && e.Type == entities.TypeBatteryHybrid {
		a.invMu.Lock()
		family := ""
		if a.inv != nil {
			family = a.inv.Family
		}
		a.invMu.Unlock()
		return a.controlCertified(family)
	}
	return a.Cfg.ConsumerControlEnabled
}
