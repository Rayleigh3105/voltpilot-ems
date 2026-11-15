package agent

// Steuerlogik running along (Stufe 2, second part; docs/contracts/v2/
// steuerlogik.md, steuerlogik-rueckmeldung.md): a delivered logic computes
// every second with the box's real inputs (internal/logiklauf) and reports in
// the heartbeat what it would switch next to what is switched. This file only
// READS: the site sample, the Fühler samples of Stufe 1 and the observed
// switch state of a device. A logic running along never becomes a command
// (steuerlogik_test.go proves it on the real path); only an ARMED logic's
// wishes go to the arbiter, in steuerlogik_scharf.go.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
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
	// relais is the read relay state of a single Shelly relay the box drives
	// itself (the control pass's readback): 1 = on, 0 = off.
	relais map[string]logikMesswert
}

// logikMerkeRelais keeps the relay state the control pass just read back.
func (a *Agent) logikMerkeRelais(entityID string, on bool, at time.Time) {
	a.logikIn.mu.Lock()
	defer a.logikIn.mu.Unlock()
	if a.logikIn.relais == nil {
		a.logikIn.relais = map[string]logikMesswert{}
	}
	v := 0.0
	if on {
		v = 1
	}
	a.logikIn.relais[entityID] = logikMesswert{v: v, at: at}
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
	// site.surplus (Stufe 6, dritter Teil): Sonnenstrom minus Hausverbrauch, nur aus einer
	// Messung, in der beide stehen - wie die Verbraucherregel ihren pv_surplus_kw bildet
	// (verbraucherregel.SiteSignals). Fehlt einer, bleibt der letzte Wert und altert.
	pv, okPV := ms["pv_power_kw"]
	last, okLast := ms["load_kw"]
	if okPV && okLast && endlich(pv) && endlich(last) {
		a.logikIn.site["site.surplus"] = logikMesswert{v: pv - last, at: ts}
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
// site.surplus, battery.power, battery.soc, price.current (the spot price of
// the price feed, ct/kWh, while it is valid), <entity>.power (logikLeistung),
// <entity>.<signal> of a self-built Modbus device
// whose definition maps that signal to a channel, and <entity>.temperature of
// a Fühler with exactly one temperature probe. Everything else is unknown - more probes on one
// entity is ambiguous, and a guess would be invented.
func (a *Agent) logikQuelle(source string, now time.Time) logik.EinWert {
	if source == "price.current" {
		ct, seit, ok := a.priceFeed().Current(now)
		if !ok {
			return logik.EinWert{}
		}
		return messwert(logikMesswert{v: ct, at: seit}, now)
	}
	entity, kanal, ok := strings.Cut(source, ".")
	if ok {
		// A self-built Modbus device with write values (K3) delivers every
		// signal its definition maps to a channel.
		if w, geraet := a.mbQuelle(entity, kanal, now); geraet {
			return w
		}
	}
	a.logikIn.mu.Lock()
	if w, fest := a.logikIn.site[source]; fest {
		a.logikIn.mu.Unlock()
		return messwert(w, now)
	}
	a.logikIn.mu.Unlock()
	// Erst nach den festen Quellen: battery.power ist der Speicher, kein Gerät „battery“.
	if ok && kanal == "power" && !istFesteQuelle(source) {
		return a.logikLeistung(entity, now)
	}
	a.logikIn.mu.Lock()
	defer a.logikIn.mu.Unlock()
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

// logikLeistung is <entity>.power (Stufe 6, third part): what the device
// draws now - MEASURED (its own power_kw, at most 30 s old), else the kW of its
// CONFIRMED stage while the readback is fresh; the heating-rod controller reads
// its rod exactly so (heizstabRodKw). Nothing fresh: unknown.
func (a *Agent) logikLeistung(entityID string, now time.Time) logik.EinWert {
	a.entMu.Lock()
	er, ok := a.entReadings[entityID]
	a.entMu.Unlock()
	if ok && now.Sub(er.recv) <= heizstabRodMeasuredMaxAge {
		if kw, has := er.channels["power_kw"]; has && endlich(kw) {
			return messwert(logikMesswert{v: kw, at: er.recv}, now)
		}
	}
	if st := a.shellyGroupStage(entityID); st != nil && st.ConfirmedKw != nil {
		if at, err := time.Parse(time.RFC3339, st.At); err == nil && now.Sub(at) <= heizstabStageMaxAge {
			return messwert(logikMesswert{v: *st.ConfirmedKw, at: at}, now)
		}
	}
	return logik.EinWert{}
}

// istFesteQuelle: die Quellen der Anlage, die jede Box liest (Wortliste, quelle_fest) - auch ohne Messwert nie
// das Signal eines Geräts.
func istFesteQuelle(source string) bool {
	switch source {
	case "site.grid", "site.pv", "site.surplus", "battery.power", "battery.soc", "sun.elevation", "price.current":
		return true
	}
	return false
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
		stamm.Ausgaenge, stamm.KwJeAusgang = cfg.OutputFacts()
	}
	geraetFakten(*e, &stamm)
	if mb, ok := a.mbIst(entityID, now); ok {
		// A self-built Modbus device with write values: its read-back is the
		// observed state of all three outputs.
		ist.Ein, ist.Sollwert, ist.Betriebsart = mb.On, mb.Setpoint, mb.Mode
		return stamm, ist
	}
	if st := a.shellyGroupStage(entityID); st != nil && st.Confirmed != nil {
		if at, err := time.Parse(time.RFC3339, st.At); err == nil && now.Sub(at) <= heizstabStageMaxAge {
			n := *st.Confirmed
			ist.Stufe = &n
			return stamm, ist
		}
	}
	a.logikIn.mu.Lock()
	r, gelesen := a.logikIn.relais[entityID]
	a.logikIn.mu.Unlock()
	if gelesen && now.Sub(r.at) <= heizstabStageMaxAge {
		on := r.v > 0
		ist.Ein = &on
		return stamm, ist
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

// geraetFakten fills the device facts a logic needs for a device that
// regulates itself (K2): the released band and step of its setpoint in °C and
// its closed list of modes, from the registry capabilities.
func geraetFakten(e entities.Entity, stamm *logik.GeraetStamm) {
	for _, c := range e.Capabilities.Actuate {
		switch c.Command {
		case entities.CmdSetpointC:
			if c.Min != nil && c.Max != nil {
				stamm.SollwertBereich = &[2]float64{*c.Min, *c.Max}
			}
			stamm.SollwertSchritt = c.Step
		case entities.CmdMode:
			stamm.Betriebsarten = append([]string(nil), c.Modes...)
		}
	}
}

// logikAdapter lets the deployer hand Steuerlogik artifacts to the run; the
// run itself never sees the deployer (its import allowlist).
type logikAdapter struct{ lz *logiklauf.Laufzeit }

func (ad logikAdapter) Annehmbar(art flowdeploy.Artifact) (bool, string) {
	L, err := logiklauf.Lies([]byte(art.Bundle.Logic))
	if err != nil {
		return false, "Logik nicht lesbar: " + err.Error()
	}
	if _, err := logiklauf.Zone(auftragOrt(art.Bundle.Site)); err != nil {
		return false, "Zeitzone der Anlage unbekannt"
	}
	werte, err := auftragStellwerte(art.Bundle.Settings)
	if err != nil {
		return false, err.Error()
	}
	if _, err := L.PruefeStellwerte(werte); err != nil {
		return false, "Stellwerte passen nicht: " + err.Error()
	}
	return true, ""
}

func (ad logikAdapter) Angleichen(arts []flowdeploy.Artifact) error {
	auftraege := make([]logiklauf.Auftrag, 0, len(arts))
	for _, art := range arts {
		werte, err := auftragStellwerte(art.Bundle.Settings)
		if err != nil {
			return err
		}
		a := logiklauf.Auftrag{FlowID: art.FlowID, Fassung: art.FlowVersion, Hash: art.ContentHash,
			Dokument: []byte(art.Bundle.Logic), Ort: auftragOrt(art.Bundle.Site), Scharf: art.Bundle.Armed,
			Stellwerte: werte}
		if art.Bundle.Settings != nil {
			a.StellStand = art.Bundle.Settings.Revision
		}
		auftraege = append(auftraege, a)
	}
	return ad.lz.Angleichen(auftraege)
}

// auftragStellwerte decodes the set values of a bundle into the document's
// form the core reads (strings, numbers, schedule lists).
func auftragStellwerte(s *flowdeploy.BundleSettings) (map[string]any, error) {
	out := map[string]any{}
	if s == nil {
		return out, nil
	}
	for k, roh := range s.Values {
		var v any
		if err := json.Unmarshal(roh, &v); err != nil {
			return nil, fmt.Errorf("Stellwert %s nicht lesbar", k)
		}
		out[k] = v
	}
	return out, nil
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
				a.runSteuerlogik(now)
			}
		}
	}()
}

// logikSummary is the heartbeat block; nil while nothing runs.
func (a *Agent) logikSummary() *cloud.LogikSummary {
	if a.logik == nil {
		return nil
	}
	sum := a.logik.Summary()
	a.logikScharfSummary(sum, time.Now().UTC())
	return sum
}

func endlich(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
