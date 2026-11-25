package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
)

// The dv.* measurement points (vp-direktvermarktung-konzept d2 §5.4
// "Nachweis", Vertrag direktvermarktung-zustellung.md §5): the box's OWN
// record of the connection - effective set-point, effective limit, connected,
// watchdog age - published through the same samples pipeline as every other
// measurement, so the Verlauf and the §52-Nachweis read ordinary history.
//
// The reader pattern is the Shelly add-on one (shelly_sensors.go): the cloud
// SELECTS the points (MeasurementSelectionService.direktvermarktungsPunkte,
// box rows without entity and without a catalog entry - these are synthetic
// core points, never a device read), this reader caches its own selections
// from the retained edge/measurements/config, acknowledges ONLY its own
// points, and samples from the Anschluss snapshot. KernEigeneVorlagen keeps
// Edge Light's measurement library off these keys.

// dvMesspunktVorlagen is the Java twin of
// MeasurementSelectionService.DIREKTVERMARKTUNG_PUNKTE.
var dvMesspunktVorlagen = map[string]bool{
	"dv.vorgabe_pct":           true,
	"dv.grenze_kw":             true,
	"dv.verbunden":             true,
	"dv.lebenszeichen_alter_s": true,
}

const (
	// dvMesspunktPollTick bounds how often due selections are checked.
	dvMesspunktPollTick = 5 * time.Second
	// minDvMesspunktTakt is the floor a selection's cadence must respect.
	minDvMesspunktTakt = 15 * time.Second
)

type dvMesspunktSelection struct {
	pointKey string
	takt     time.Duration
}

// onDvMesspunktPlan caches which dv.* selections of the retained
// edge/measurements/config this reader serves, and acknowledges ONLY them -
// every other point belongs to another reader. A selection carrying an
// entity is refused: these are box points, bound to the Anschluss, never to
// a component.
func (a *Agent) onDvMesspunktPlan(_ string, payload []byte) {
	a.dvMessMu.Lock()
	defer a.dvMessMu.Unlock()
	if len(payload) == 0 {
		a.dvMessPlan = nil
		return
	}
	var doc struct {
		Revision       int64  `json:"revision"`
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
	var plan []dvMesspunktSelection
	var accepted []string
	var rejected []measurements.Rejection
	for _, s := range doc.Selections {
		if !dvMesspunktVorlagen[s.PointKey] {
			continue // not this reader's point - never judged here
		}
		takt := time.Duration(s.CadenceS) * time.Second
		switch {
		case s.EntityID != "":
			rejected = append(rejected, measurements.Rejection{PointKey: s.PointKey, Reason: "binding_unavailable"})
		case takt < minDvMesspunktTakt:
			rejected = append(rejected, measurements.Rejection{PointKey: s.PointKey, Reason: "invalid_cadence"})
		default:
			accepted = append(accepted, s.PointKey)
			plan = append(plan, dvMesspunktSelection{pointKey: s.PointKey, takt: takt})
		}
	}
	a.dvMessCatalogVersion = doc.CatalogVersion
	a.dvMessPlan = plan
	if doc.Revision >= 1 && (len(accepted) > 0 || len(rejected) > 0) {
		// Same discipline as publishShellySensorStatus: never from inside the
		// bus handler (a QoS1 publish waits for its PUBACK on paho's own
		// goroutine).
		raw, err := json.Marshal(measurements.LocalStatus{Revision: doc.Revision, AppliedAt: time.Now().UTC(),
			Accepted: accepted, Rejected: rejected})
		if err != nil || a.Bus == nil {
			return
		}
		go func() {
			if err := a.Bus.Publish(measurements.LocalStatusTopic, raw, false); err != nil {
				slog.Warn("direktvermarktung: Messplan-Quittung nicht gesendet", "err", err)
			}
		}()
	}
}

// startDvMesspunktPoll launches the sampler. It idles cheaply while nothing
// is selected or no Anschluss is delivered.
func (a *Agent) startDvMesspunktPoll(ctx context.Context) {
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		t := time.NewTicker(dvMesspunktPollTick)
		defer t.Stop()
		last := map[string]time.Time{}
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			a.runDvMesspunktPass(last, time.Now())
		}
	}()
}

// runDvMesspunktPass publishes one sample per DUE selection from the
// Anschluss snapshot - honestly: a value the connection cannot know (no
// limit active, reference stale, watchdog never written) stays absent from
// the batch, never a fabricated zero (§5.1 "Unbekannt ist keine Null").
func (a *Agent) runDvMesspunktPass(last map[string]time.Time, now time.Time) {
	a.dvMessMu.Lock()
	plan := append([]dvMesspunktSelection(nil), a.dvMessPlan...)
	catalogVersion := a.dvMessCatalogVersion
	a.dvMessMu.Unlock()
	if len(plan) == 0 || catalogVersion == "" || a.Bus == nil {
		return
	}
	a.dvMu.Lock()
	dv := a.dv
	a.dvMu.Unlock()
	if dv == nil {
		return
	}
	st := dv.Stand()
	if st == nil {
		return
	}
	at := now.UTC()
	var samples []measurements.Sample
	for _, s := range plan {
		if now.Sub(last[s.pointKey]) < s.takt {
			continue
		}
		value, ok := dvMesspunktWert(s.pointKey, st, now)
		if !ok {
			continue
		}
		last[s.pointKey] = now
		samples = append(samples, measurements.Sample{
			PointKey: s.pointKey, Raw: value, Decoded: value, Quality: "good", ObservedAt: &at,
		})
	}
	if len(samples) == 0 {
		return
	}
	raw, err := json.Marshal(measurements.LocalBatch{CatalogVersion: catalogVersion, ObservedAt: at,
		Samples: samples})
	if err != nil {
		return
	}
	if err := a.Bus.Publish(measurements.LocalSamplesTopic, raw, false); err != nil {
		slog.Warn("direktvermarktung: Messpunkt-Veroeffentlichung fehlgeschlagen", "err", err)
	}
}

// dvMesspunktWert derives one point's value from the snapshot; ok=false means
// "unknown now", and unknown is never zero.
func dvMesspunktWert(pointKey string, st *direktvermarkter.AnschlussStand, now time.Time) (float64, bool) {
	switch pointKey {
	case "dv.vorgabe_pct":
		if st.Server == nil {
			return 0, false
		}
		return float64(st.Server.EffektivPct), true
	case "dv.grenze_kw":
		return st.GrenzeKw(now)
	case "dv.verbunden":
		switch st.Lage {
		case direktvermarkter.LageVerbunden, direktvermarkter.LageVorgabeAktiv, direktvermarkter.LageAbgelaufen:
			return 1, true
		default:
			return 0, true
		}
	case "dv.lebenszeichen_alter_s":
		if st.Server == nil || st.Server.Lebenszeichen.IsZero() {
			return 0, false
		}
		return now.Sub(st.Server.Lebenszeichen).Seconds(), true
	}
	return 0, false
}
