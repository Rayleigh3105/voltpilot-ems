package agent

// Steuerlogik running along (Stufe 2, second part; docs/contracts/v2/
// steuerlogik.md, steuerlogik-rueckmeldung.md): a delivered logic computes
// every second with the box's real inputs (internal/logiklauf) and reports in
// the heartbeat what it would switch next to what is switched. This file only
// READS: the site sample, the Fühler samples of Stufe 1 and the observed
// switch state of a device. Nothing here holds the arbiter or a driver - the
// run's wishes never become a command (steuerlogik_test.go proves it on the
// real path).

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flowdeploy"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logiklauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shelly"
)

// logikTakt is the beat of the run (the contract's "jede Sekunde").
const logikTakt = time.Second

// logikMesswert is one observed value with its observation time.
type logikMesswert struct {
	v  float64
	at time.Time
}

// logikEingaenge is what the run can read from the box: the gated composite
// site sample (the same values every guard reads) and the Fühler
// temperatures of Stufe 1. Each value keeps its OWN time: a sample without a
// channel never refreshes that channel's age.
type logikEingaenge struct {
	mu      sync.Mutex
	site    map[string]logikMesswert            // source name -> value
	fuehler map[string]map[string]logikMesswert // entity -> point_key -> °C
}

// logikSiteKanaele maps the source names of the language to the channels of
// the site sample (signs as the box contract: grid + = import, battery + =
// charge - the same as steuerlogik.md).
var logikSiteKanaele = map[string]string{
	"site.grid":   "power_kw",
	"site.pv":     "pv_power_kw",
	"battery.soc": "soc_pct",
}

// logikObserve keeps the newest site values for the run; called from the
// telemetry choke point next to heizstabObserve.
func (a *Agent) logikObserve(ts time.Time, ms map[string]float64, battKw *float64) {
	a.logikIn.mu.Lock()
	defer a.logikIn.mu.Unlock()
	if a.logikIn.site == nil {
		a.logikIn.site = map[string]logikMesswert{}
	}
	for source, kanal := range logikSiteKanaele {
		if v, ok := ms[kanal]; ok && endlich(v) {
			a.logikIn.site[source] = logikMesswert{v: v, at: ts}
		}
	}
	if battKw != nil && endlich(*battKw) {
		a.logikIn.site["battery.power"] = logikMesswert{v: *battKw, at: ts}
	}
}

// logikObserveSamples keeps the Fühler temperatures out of a local
// measurement batch (Stufe 1 publishes them as ordinary samples).
func (a *Agent) logikObserveSamples(payload []byte) {
	var batch measurements.LocalBatch
	if json.Unmarshal(payload, &batch) != nil {
		return
	}
	a.logikIn.mu.Lock()
	defer a.logikIn.mu.Unlock()
	for _, s := range batch.Samples {
		if !istFuehlerTemperatur(s.PointKey) || len(s.EntityID) == 0 {
			continue
		}
		var entity string
		if json.Unmarshal(s.EntityID, &entity) != nil || entity == "" {
			continue
		}
		v, ok := s.Decoded.(float64)
		if !ok || !endlich(v) || s.Quality != "good" {
			continue
		}
		at := batch.ObservedAt
		if s.ObservedAt != nil {
			at = *s.ObservedAt
		}
		if a.logikIn.fuehler == nil {
			a.logikIn.fuehler = map[string]map[string]logikMesswert{}
		}
		if a.logikIn.fuehler[entity] == nil {
			a.logikIn.fuehler[entity] = map[string]logikMesswert{}
		}
		a.logikIn.fuehler[entity][s.PointKey] = logikMesswert{v: v, at: at}
	}
}

// istFuehlerTemperatur says whether a concrete point key is a temperature of
// a Shelly add-on (shelly_sensors.go expands the templates into these).
func istFuehlerTemperatur(pointKey string) bool {
	return (strings.HasPrefix(pointKey, "shelly.gen2plus.temperature[") ||
		strings.HasPrefix(pointKey, "shelly.gen1.external_sensor[")) && strings.HasSuffix(pointKey, ".tc")
}

// logikQuelle reads one input of a logic. Known: site.grid, site.pv,
// battery.power, battery.soc, price.current (the spot price of the price feed,
// ct/kWh, while it is valid) and <entity>.temperature of a Fühler with exactly
// one temperature probe. Everything else is unknown - more probes on one
// entity is ambiguous, and a guess would be invented.
func (a *Agent) logikQuelle(source string, now time.Time) logik.EinWert {
	if source == "price.current" {
		ct, seit, ok := a.priceFeed().Current(now)
		if !ok {
			return logik.EinWert{}
		}
		return messwert(logikMesswert{v: ct, at: seit}, now)
	}
	a.logikIn.mu.Lock()
	defer a.logikIn.mu.Unlock()
	if w, ok := a.logikIn.site[source]; ok {
		return messwert(w, now)
	}
	entity, kanal, ok := strings.Cut(source, ".")
	if !ok || kanal != "temperature" {
		return logik.EinWert{}
	}
	werte := a.logikIn.fuehler[entity]
	if len(werte) != 1 {
		return logik.EinWert{}
	}
	for _, w := range werte {
		return messwert(w, now)
	}
	return logik.EinWert{}
}

func messwert(w logikMesswert, now time.Time) logik.EinWert {
	v := w.v
	alter := now.Sub(w.at).Seconds()
	if alter < 0 {
		alter = 0
	}
	return logik.EinWert{Zahl: &v, Alter: alter}
}

// logikGeraet gives a device's data and its observed switch state. The state
// comes from what the box READS: the readback of its own output-set executor,
// else the pinned source of the entity (edge_source_id) while it is fresh.
// No pin, no reading - unknown, never "off".
func (a *Agent) logikGeraet(entityID string, now time.Time) (logik.GeraetStamm, logiklauf.Ist) {
	var stamm logik.GeraetStamm
	var ist logiklauf.Ist
	a.entMu.Lock()
	e := a.entRegistry.Find(entityID)
	var sourceID string
	var cfg shelly.Config
	var isShelly bool
	if e != nil {
		sourceID = e.EdgeSourceID
		cfg, isShelly = shelly.ParseDriver(e.Driver)
	}
	a.entMu.Unlock()
	if e == nil {
		return stamm, ist
	}
	if isShelly {
		if cfg.IsGroup() {
			stamm.Ausgaenge = len(cfg.Channels)
			if outs, kws := cfg.StageCeilings(); len(outs) > 0 && outs[0] > 0 {
				kw := kws[0] / float64(outs[0])
				stamm.KwJeAusgang = &kw
			}
		} else {
			stamm.Ausgaenge = 1
		}
	}
	if st := a.shellyGroupStage(entityID); st != nil && st.Confirmed != nil {
		if at, err := time.Parse(time.RFC3339, st.At); err == nil && now.Sub(at) <= heizstabStageMaxAge {
			n := *st.Confirmed
			ist.Stufe = &n
			return stamm, ist
		}
	}
	if sourceID == "" {
		return stamm, ist
	}
	for _, s := range a.ListSources() {
		if s.ID != sourceID {
			continue
		}
		a.srcMu.Lock()
		r, fresh := a.sourceFresh(s, now)
		a.srcMu.Unlock()
		if !fresh {
			break
		}
		switch {
		case isShelly && cfg.IsGroup() && len(r.outputs) == len(cfg.Channels):
			n := 0
			for _, on := range r.outputs {
				if on {
					n++
				}
			}
			ist.Stufe = &n
		case r.relayOn != nil:
			on := *r.relayOn
			ist.Ein = &on
		}
		break
	}
	return stamm, ist
}

// logikAdapter lets the deployer hand Steuerlogik artifacts to the run; the
// run itself never sees the deployer (its import allowlist).
type logikAdapter struct{ lz *logiklauf.Laufzeit }

func (ad logikAdapter) Annehmbar(art flowdeploy.Artifact) (bool, string) {
	if _, err := logiklauf.Lies([]byte(art.Bundle.Logic)); err != nil {
		return false, "Logik nicht lesbar: " + err.Error()
	}
	if _, err := logiklauf.Zone(auftragOrt(art.Bundle.Site)); err != nil {
		return false, "Zeitzone der Anlage unbekannt"
	}
	return true, ""
}

func (ad logikAdapter) Angleichen(arts []flowdeploy.Artifact) error {
	auftraege := make([]logiklauf.Auftrag, 0, len(arts))
	for _, art := range arts {
		auftraege = append(auftraege, logiklauf.Auftrag{FlowID: art.FlowID, Fassung: art.FlowVersion,
			Hash: art.ContentHash, Dokument: []byte(art.Bundle.Logic), Ort: auftragOrt(art.Bundle.Site)})
	}
	return ad.lz.Angleichen(auftraege)
}

func auftragOrt(s *flowdeploy.BundleSite) logiklauf.Ort {
	if s == nil {
		return logiklauf.Ort{}
	}
	return logiklauf.Ort{Zeitzone: s.Timezone, Breite: s.Latitude, Laenge: s.Longitude}
}

// newLogikLaufzeit builds the run on the agent's read paths; jetzt is its
// clock (nil = time.Now, tests pass their own).
func (a *Agent) newLogikLaufzeit(jetzt func() time.Time) *logiklauf.Laufzeit {
	return logiklauf.New(logiklauf.Deps{
		DataDir: a.Cfg.DataDir,
		Quelle:  a.logikQuelle,
		Geraet:  a.logikGeraet,
		Jetzt:   jetzt,
	})
}

// startLogikMitlauf runs the beat; it idles cheaply while nothing runs along.
func (a *Agent) startLogikMitlauf(ctx context.Context) {
	if a.logik == nil {
		return
	}
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		t := time.NewTicker(logikTakt)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				a.logik.Stop()
				return
			case now := <-t.C:
				a.logik.Tick(now)
			}
		}
	}()
}

// logikSummary is the heartbeat block; nil while nothing runs along.
func (a *Agent) logikSummary() *cloud.LogikSummary {
	if a.logik == nil {
		return nil
	}
	return a.logik.Summary()
}

func endlich(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
