package agent

// Steuerlogik-Konzept Stufe 1 ("Fühler lesen", docs/… report.md §9): the
// add-on sensors (temperature, digital input) of every Shelly-backed entity
// the cloud SELECTED a point for (edge/measurements/config - the same
// governance every other family uses: explicit opt-in, a cadence floor),
// published as ordinary measurement samples (edge/measurements/samples).
//
// This is additive and INDEPENDENT of the control executor
// (shelly_control.go/shelly_group.go stay untouched - reading an add-on
// sensor is not a switching action and must work even with
// VP_CONTROL_ENABLED off) and of Node-RED (SHELLY.md: "keinen
// Node-RED-Lesepfad" - single writer of the device socket).
//
// Scope left out of THIS stage, on purpose: accept/reject STATUS reporting
// (measurements.LocalStatusTopic). layer1.Runtime.onMessplan (Edge Light)
// already evaluates EVERY selection in a config revision and rejects
// whatever is not in its own small Deye map with "edge_too_old" - a second,
// independent full-plan evaluator on the SAME local topic would race its
// status publish (storeAndSendMeasurementStatus replaces the stored
// document wholesale, it does not merge per revision). Fixing that merge is
// bigger than reading a sensor; a selected Shelly point simply starts
// streaming samples once its entity resolves, with no "accepted" line yet.
// Noted for the next stage, not guessed around here.

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shelly"
)

const (
	shellySensorPollTick = 30 * time.Second
	// minShellySensorTakt mirrors the catalog's own min_cadence_s for these
	// points (shelly.gen1.external_sensor[*]/shelly.gen2plus.temperature[*]/
	// input[*]: 30) - nothing faster, even if the cloud asked.
	minShellySensorTakt = 30 * time.Second
)

// shellySensorKind names which add-on component family a point_key template
// reads, and which Shelly generation it applies to.
type shellySensorKind int

const (
	kindGen2Temperature shellySensorKind = iota
	kindGen2Input
	kindGen1Temperature
)

// shellySensorTemplates are the point_key TEMPLATES this reader serves - the
// literal wildcard string a selection names (x-point-key-rule: the cloud
// selects the template, the box expands it into one concrete sample per
// component it actually finds). Everything else is another reader's point,
// never guessed at here.
var shellySensorTemplates = map[string]shellySensorKind{
	"shelly.gen2plus.temperature[*].tc":                  kindGen2Temperature,
	"shelly.gen2plus.input[*].state":                     kindGen2Input,
	"shelly.gen1.external_sensor[*].ext_temperature.*.tc": kindGen1Temperature,
}

type shellySensorSelection struct {
	pointKey string
	entityID string
	kind     shellySensorKind
	takt     time.Duration
}

// onShellySensorPlan caches which selections of the retained
// edge/measurements/config this reader serves. A selection naming no
// entity_id is never read generically against "the" Shelly - Stufe 3c's
// binding rule applies here exactly as everywhere else.
func (a *Agent) onShellySensorPlan(_ string, payload []byte) {
	a.shellySensorMu.Lock()
	defer a.shellySensorMu.Unlock()
	if len(payload) == 0 {
		a.shellySensorPlan = nil
		return
	}
	var doc struct {
		CatalogVersion string `json:"catalog_version"`
		Selections     []struct {
			PointKey string `json:"point_key"`
			CadenceS int    `json:"cadence_s"`
			EntityID string `json:"entity_id"`
		} `json:"selections"`
	}
	if err := json.Unmarshal(payload, &doc); err != nil || doc.CatalogVersion == "" {
		return
	}
	var plan []shellySensorSelection
	for _, s := range doc.Selections {
		kind, ok := shellySensorTemplates[s.PointKey]
		takt := time.Duration(s.CadenceS) * time.Second
		if !ok || s.EntityID == "" || takt < minShellySensorTakt {
			continue
		}
		plan = append(plan, shellySensorSelection{pointKey: s.PointKey, entityID: s.EntityID, kind: kind, takt: takt})
	}
	a.shellySensorCatalogVersion = doc.CatalogVersion
	a.shellySensorPlan = plan
}

// startShellySensorPoll launches the add-on sensor read loop. It idles
// cheaply while no Shelly entity has a selected sensor point.
func (a *Agent) startShellySensorPoll(ctx context.Context) {
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		t := time.NewTicker(shellySensorPollTick)
		defer t.Stop()
		last := map[string]time.Time{}
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			a.runShellySensorPass(ctx, a.shellyDoerRef(), last, time.Now())
		}
	}()
}

// runShellySensorPass reads every entity with a DUE selection once (one
// Shelly.GetStatus/status answer serves every component of that entity -
// temperature AND input together, never a second request per point) and
// publishes every component its answer actually named, honestly (a probe
// the device could not read stays absent from the batch - never a
// fabricated or carried-over value).
func (a *Agent) runShellySensorPass(ctx context.Context, doer shelly.Doer, last map[string]time.Time, now time.Time) {
	if doer == nil {
		return
	}
	a.shellySensorMu.Lock()
	plan := append([]shellySensorSelection(nil), a.shellySensorPlan...)
	catalogVersion := a.shellySensorCatalogVersion
	a.shellySensorMu.Unlock()
	if len(plan) == 0 {
		return
	}
	byEntity := map[string][]shellySensorSelection{}
	for _, s := range plan {
		byEntity[s.entityID] = append(byEntity[s.entityID], s)
	}
	a.entMu.Lock()
	reg := a.entRegistry
	a.entMu.Unlock()

	var samples []measurements.Sample
	for entityID, sels := range byEntity {
		due := false
		for _, s := range sels {
			if now.Sub(last[s.pointKey+"\x00"+entityID]) >= s.takt {
				due = true
			}
		}
		if !due {
			continue
		}
		e := reg.Find(entityID)
		if e == nil {
			continue // the component this selection named is gone - no samples, no guess
		}
		cfg, ok := shelly.ParseDriver(e.Driver)
		if !ok {
			continue // not a shelly-backed entity (another driver claims this component)
		}
		ident, st, de := a.shellySensorIdentityAndRead(ctx, doer, cfg)
		if de != nil {
			slog.Warn("shelly sensor read failed", "entity", entityID, "target", cfg.HostPort(), "err", de)
			if de.Code == shelly.ErrInvalidResponse {
				a.shellyForgetIdentity(cfg)
			}
			continue
		}
		for _, s := range sels {
			key := s.pointKey + "\x00" + entityID
			if now.Sub(last[key]) < s.takt {
				continue
			}
			last[key] = now
			samples = append(samples, shellySensorSamples(s, ident, st, now)...)
		}
	}
	a.publishShellySensorSamples(catalogVersion, samples, now)
}

// shellySensorIdentityAndRead resolves a device's dialect like shellyIdentity
// does (persisted hit, else detect once) but through DetectSensors/
// ReadSensors - never Detect/DetectGroup, which assume a switch channel
// exists (Switch.GetStatus?id=cfg.Channel) and 404 on a device that
// switches nothing at all. A cache hit still costs one request (ReadSensors
// has no "state already read" shortcut); detect-once-persist still saves
// the /shelly probe on every later pass.
func (a *Agent) shellySensorIdentityAndRead(ctx context.Context, doer shelly.Doer, cfg shelly.Config) (
	shelly.Identity, shelly.SensorState, *shelly.DriverError) {
	store := a.shellyStoreRef()
	if store != nil {
		if id, ok := store.Get(cfg.Key()); ok {
			st, de := shelly.ReadSensors(ctx, doer, cfg, id)
			return id, st, de
		}
	}
	id, st, err := shelly.DetectSensors(ctx, doer, cfg)
	if err != nil {
		de, _ := err.(*shelly.DriverError)
		if de == nil {
			de = &shelly.DriverError{Code: shelly.ErrUnreachable, Message: err.Error()}
		}
		return shelly.Identity{}, shelly.SensorState{}, de
	}
	if store != nil {
		if err := store.Put(cfg.Key(), id); err != nil {
			slog.Warn("shelly sensor identity not persisted", "key", cfg.Key(), "err", err)
		}
	}
	return id, st, nil
}

// shellySensorSamples expands one selection against one read: one concrete
// sample per component the device's answer named with a readable value, the
// device's OWN component id substituted verbatim into the template (never
// re-indexed) - a probe present but unreadable (nil TempC/On) contributes no
// sample this round. A selection whose generation does not match the
// detected device (a gen1-only template selected at a gen2 device, say)
// yields nothing - never a value read against the wrong dialect.
func shellySensorSamples(s shellySensorSelection, ident shelly.Identity, st shelly.SensorState, now time.Time) []measurements.Sample {
	at := now.UTC()
	entityID, _ := json.Marshal(s.entityID)
	var out []measurements.Sample
	switch s.kind {
	case kindGen2Temperature:
		if ident.Gen != shelly.Gen2 {
			return nil
		}
		for _, t := range st.Temperatures {
			if t.TempC == nil {
				continue
			}
			out = append(out, measurements.Sample{
				PointKey: "shelly.gen2plus.temperature[" + strconv.Itoa(t.ID) + "].tc",
				Raw:      *t.TempC, Decoded: *t.TempC, Quality: "good", ObservedAt: &at, EntityID: entityID,
			})
		}
	case kindGen2Input:
		if ident.Gen != shelly.Gen2 {
			return nil
		}
		for _, in := range st.Inputs {
			if in.On == nil {
				continue
			}
			out = append(out, measurements.Sample{
				PointKey: "shelly.gen2plus.input[" + strconv.Itoa(in.ID) + "].state",
				Raw:      *in.On, Decoded: *in.On, Quality: "good", ObservedAt: &at, EntityID: entityID,
			})
		}
	case kindGen1Temperature:
		if ident.Gen != shelly.Gen1 {
			return nil
		}
		for _, t := range st.Temperatures {
			if t.TempC == nil {
				continue
			}
			out = append(out, measurements.Sample{
				PointKey: "shelly.gen1.external_sensor[0].ext_temperature." + strconv.Itoa(t.ID) + ".tc",
				Raw:      *t.TempC, Decoded: *t.TempC, Quality: "good", ObservedAt: &at, EntityID: entityID,
			})
		}
	}
	return out
}

// publishShellySensorSamples sends one local batch, exactly like every other
// measurement reader (layer1.publishEinstellungen, the Node-RED runtime):
// the core puts it into the durable outbox via the existing
// onMeasurementSamples subscriber.
func (a *Agent) publishShellySensorSamples(catalogVersion string, samples []measurements.Sample, now time.Time) {
	if a.Bus == nil || catalogVersion == "" || len(samples) == 0 {
		return
	}
	raw, err := json.Marshal(measurements.LocalBatch{CatalogVersion: catalogVersion, ObservedAt: now.UTC(), Samples: samples})
	if err != nil {
		return
	}
	if err := a.Bus.Publish(measurements.LocalSamplesTopic, raw, false); err != nil {
		slog.Warn("shelly sensor sample publish failed", "err", err)
	}
}
