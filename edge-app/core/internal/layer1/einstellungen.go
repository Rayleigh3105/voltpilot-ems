package layer1

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/deyedecode"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
)

// Edge Light has no measurement library (edge-light/docs/paritaet.md, D). It
// reads a CLOSED set of catalog points itself: the discharge limit the
// customer set at a Deye hybrid ("Battery Low SOC"), which the cloud takes as
// the battery's minimum charge (api WechselrichterUntergrenze). Every other
// selected point is refused by name ("edge_too_old") instead of being left
// without an answer - before this, an Edge Light never acknowledged a plan and
// the cloud re-sent it every 30 s.
//
// READ-ONLY: one FC3 read of one register in the session the telemetry poll
// already holds (one logger, one client), at the plan's cadence. VoltPilot
// never writes these registers.

// einstellungsPunkt is one point Edge Light reads itself.
type einstellungsPunkt struct {
	family   string
	register uint16
}

// einstellungsPunkte maps catalog point keys to their register (catalog
// measurement-point-catalog, source ha-solarman deye_hybrid.yaml / deye_p3.yaml;
// pinned by TestEinstellungsPunkteMatchTheCatalog).
var einstellungsPunkte = map[string]einstellungsPunkt{
	"deye.hybrid_1p.settings.battery-low-soc": {family: deyedecode.FamilyHybrid1P, register: 219},
	"deye.hybrid_3p.settings.battery-low-soc": {family: deyedecode.FamilyHybrid3P, register: 117},
}

// Reasons of the closed mqtt-measurement-config-status vocabulary
// (measurements.reasons).
const (
	grundNichtGelesen  = "edge_too_old"        // Edge Light reads this point (still) not
	grundNichtGebunden = "binding_unavailable" // the point belongs to another inverter family
	grundTakt          = "invalid_cadence"
)

// minEinstellungsTakt bounds the cadence from below: a setting is read every
// 5 minutes in the catalog (min_cadence_s 300); nothing faster.
const minEinstellungsTakt = 60 * time.Second

type messplanPunkt struct {
	pointKey string
	takt     time.Duration
	register uint16
	family   string
}

type messplan struct {
	revision int64
	catalog  string
	punkte   []messplanPunkt
}

// wire shape of the retained edge/measurements/config document (only what
// Layer 1 needs; the core already validated it before the local publish).
type messplanDokument struct {
	Revision       int64  `json:"revision"`
	CatalogVersion string `json:"catalog_version"`
	Selections     []struct {
		PointKey string `json:"point_key"`
		CadenceS int    `json:"cadence_s"`
	} `json:"selections"`
}

func (r *Runtime) onMessplan(_ string, payload []byte) {
	r.einstMu.Lock()
	r.planRaw = append([]byte(nil), payload...)
	if len(payload) == 0 {
		r.plan = nil
	}
	r.einstMu.Unlock()
	if len(payload) == 0 {
		return
	}
	var doc messplanDokument
	if err := json.Unmarshal(payload, &doc); err != nil || doc.Revision < 1 || doc.CatalogVersion == "" {
		r.log.Warn("Messplan verworfen", "err", err)
		return
	}
	r.mu.Lock()
	sel := r.sel
	r.mu.Unlock()
	family := ""
	if sel != nil && sel.Communication == CommSolarmanV5 {
		family = sel.Family
	}

	plan := &messplan{revision: doc.Revision, catalog: doc.CatalogVersion}
	accepted := []string{}
	rejected := []measurements.Rejection{}
	seen := map[string]bool{}
	for _, s := range doc.Selections {
		if seen[s.PointKey] {
			continue // a shared point: one read serves the one battery of this box
		}
		seen[s.PointKey] = true
		p, ok := einstellungsPunkte[s.PointKey]
		switch {
		case !ok:
			rejected = append(rejected, measurements.Rejection{PointKey: s.PointKey, Reason: grundNichtGelesen})
		case p.family != family:
			rejected = append(rejected, measurements.Rejection{PointKey: s.PointKey, Reason: grundNichtGebunden})
		case time.Duration(s.CadenceS)*time.Second < minEinstellungsTakt:
			rejected = append(rejected, measurements.Rejection{PointKey: s.PointKey, Reason: grundTakt})
		default:
			accepted = append(accepted, s.PointKey)
			plan.punkte = append(plan.punkte, messplanPunkt{pointKey: s.PointKey,
				takt: time.Duration(s.CadenceS) * time.Second, register: p.register, family: p.family})
		}
	}
	sort.Strings(accepted)
	r.einstMu.Lock()
	r.plan = plan
	r.einstMu.Unlock()

	status, _ := json.Marshal(measurements.LocalStatus{Revision: doc.Revision, AppliedAt: r.opts.Now().UTC(),
		Accepted: accepted, Rejected: rejected})
	// Not from inside the bus handler: a QoS1 publish waits for its PUBACK,
	// and the handlers run in order on paho's own goroutine (Bus contract).
	go func() {
		if err := r.bus.Publish(measurements.LocalStatusTopic, status, false); err != nil {
			r.log.Warn("Messplan-Status konnte nicht auf den lokalen Bus", "err", err)
		}
	}()
	if len(plan.punkte) > 0 {
		r.log.Info("Messplan uebernommen", "revision", doc.Revision, "gelesen", accepted)
	}
}

// messplanNeuBewerten re-judges the stored plan after the inverter selection
// changed: whether a point is bound depends on the inverter family.
func (r *Runtime) messplanNeuBewerten() {
	r.einstMu.Lock()
	raw := append([]byte(nil), r.planRaw...)
	r.einstMu.Unlock()
	if len(raw) > 0 {
		r.onMessplan("", raw)
	}
}

// faelligeEinstellungen names the planned points of this family whose cadence
// has elapsed, and books the attempt (a failed read waits one cadence, never a
// read every poll against a logger that refuses it).
func (r *Runtime) faelligeEinstellungen(family string, now time.Time) (*messplan, []messplanPunkt) {
	r.einstMu.Lock()
	defer r.einstMu.Unlock()
	if r.plan == nil {
		return nil, nil
	}
	var due []messplanPunkt
	for _, p := range r.plan.punkte {
		if p.family != family {
			continue
		}
		if last, ok := r.einstLetzte[p.pointKey]; ok && now.Sub(last) < p.takt {
			continue
		}
		r.einstLetzte[p.pointKey] = now
		due = append(due, p)
	}
	return r.plan, due
}

type einstellungsLesung struct {
	punkt messplanPunkt
	wert  uint16
}

// leseEinstellungen reads the due settings in the session the poll holds.
func (r *Runtime) leseEinstellungen(ctx context.Context, sess *solarmanv5.Session, due []messplanPunkt) []einstellungsLesung {
	var out []einstellungsLesung
	for _, p := range due {
		regs, err := sess.ReadHolding(ctx, p.register, 1)
		if err != nil {
			r.log.Warn("Einstellung am Wechselrichter nicht gelesen", "punkt", p.pointKey, "err", err)
			continue
		}
		out = append(out, einstellungsLesung{punkt: p, wert: regs[0]})
	}
	return out
}

// publishEinstellungen sends one local batch (edge/measurements/samples); the
// core puts it into the durable outbox like every Node-RED batch.
func (r *Runtime) publishEinstellungen(plan *messplan, lesungen []einstellungsLesung, now time.Time) {
	if plan == nil || len(lesungen) == 0 {
		return
	}
	at := now.UTC()
	samples := make([]measurements.Sample, 0, len(lesungen))
	for _, l := range lesungen {
		quality := "good"
		if l.wert > 100 {
			quality = "invalid" // a percentage above 100 is a broken answer, never a limit
		}
		obs := at
		samples = append(samples, measurements.Sample{PointKey: l.punkt.pointKey, Raw: json.Number(itoa(int(l.wert))),
			Decoded: json.Number(itoa(int(l.wert))), Quality: quality, ObservedAt: &obs})
	}
	rev, _ := json.Marshal(plan.revision)
	raw, _ := json.Marshal(measurements.LocalBatch{CatalogVersion: plan.catalog, ObservedAt: at, Samples: samples,
		AppliedRevision: json.RawMessage(rev)})
	if err := r.bus.Publish(measurements.LocalSamplesTopic, raw, false); err != nil {
		r.log.Warn("Einstellungs-Lesung konnte nicht auf den lokalen Bus", "err", err)
	}
}
