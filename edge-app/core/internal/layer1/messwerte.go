package layer1

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/datasourcestatus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/erzeugerbild"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/messwerte"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
)

// The measurement library on Edge Light ("Zusatzmesswerte nach Katalog"): the
// Go twin of the palette's vp-measurements node behind the same local-bus
// topics -
//
//   - edge/measurements/config (retained): the plan; its Erzeuger points go to
//     the Erzeuger image (erzeuger.go), every other point to internal/messwerte
//   - edge/measurements/config-status (retained): ONE answer for both parts
//   - edge/measurements/samples, edge/data-sources/poll: what a read yields
//   - edge/measurements/ocpp-configuration(-result), ocpp-meter-values: the
//     OCPP points, fed by the core's own CSMS
//
// Read only. A register read takes the lane of its device, so it never runs
// next to the telemetry poll of the same logger; HTTP reads take none, like
// on the Docker box.

const (
	messwerteTakt          = 250 * time.Millisecond
	messwerteHTTPTimeout   = 4 * time.Second
	messwerteMaxBody       = 1 << 20
	solarmanMessTimeout    = 4 * time.Second
	modbusMessTimeout      = 3 * time.Second
	topicOcppMeterValues   = "edge/measurements/ocpp-meter-values"
	messwerteOcppMaxLaenge = 1024
)

// messplanDokument is the retained edge/measurements/config as Layer 1 reads it.
type messplanDokument struct {
	Revision       *float64                     `json:"revision"`
	CatalogVersion string                       `json:"catalog_version"`
	Selections     []messwerte.Auswahl          `json:"selections"`
	Erzeugerbilder []erzeugerbild.Bildparameter `json:"erzeuger_registerbilder"`
}

// messwerteZustand is the library's part of the Runtime.
type messwerteZustand struct {
	lz      *messwerte.Laufzeit
	katalog *messwerte.Katalog
	katSig  string
	desired *messplanDokument
	erz     erzeugerbild.PlanStatus
	quellen map[string]messwerte.Geraet
	disc    map[string]*messwerte.Discovery
	discSig map[string]string
	kick    chan struct{}
	http    *http.Client
	seq     uint16
}

func newMesswerteZustand() messwerteZustand {
	return messwerteZustand{quellen: map[string]messwerte.Geraet{}, disc: map[string]*messwerte.Discovery{},
		discSig: map[string]string{}, kick: make(chan struct{}, 1),
		http: &http.Client{Timeout: messwerteHTTPTimeout, Transport: &http.Transport{
			// rejectUnauthorized:false like the palette: a device's self-signed
			// certificate (GEN24) is the norm in a customer LAN.
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
		}}}
}

// onMessplan takes the retained plan. The Erzeuger part is judged at once;
// the library part by the worker (runMesswerte), which also answers.
func (r *Runtime) onMessplan(_ string, payload []byte) {
	if len(payload) == 0 {
		r.planeErzeuger(nil)
		r.mwMu.Lock()
		r.mw.desired = nil
		r.mwMu.Unlock()
		r.messplanNeuBewerten()
		return
	}
	var doc messplanDokument
	if err := json.Unmarshal(payload, &doc); err != nil || doc.Revision == nil || *doc.Revision < 1 || doc.CatalogVersion == "" {
		r.log.Warn("Messplan verworfen", "err", err)
		return
	}
	r.mwMu.Lock()
	r.mw.desired = &doc
	r.mwMu.Unlock()
	r.messplanNeuBewerten()
}

// messplanNeuBewerten re-judges the stored plan: after a new plan, a changed
// inverter, registry or source list. The worker coalesces bursts (a reconnect
// replays every retained document) into one apply.
func (r *Runtime) messplanNeuBewerten() {
	select {
	case r.mw.kick <- struct{}{}:
	default:
	}
}

// runMesswerte is the library's worker: re-judge on a kick, read every tick.
func (r *Runtime) runMesswerte(ctx context.Context) {
	t := time.NewTicker(messwerteTakt)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.mw.kick:
			r.messwerteAnwenden(ctx)
		case <-t.C:
			if r.mw.lz.Aktiv() {
				r.mw.lz.Tick(ctx)
			}
		}
	}
}

// messwerteAnwenden discovers the SunSpec targets that changed, then applies
// the plan: the Erzeuger part to the image, the rest to the library.
//
// The walk runs only for a plan with a SunSpec point (the palette walks on
// every inverter change): a SunSpec device often serves one client, and a
// walk nobody needs is load on it.
func (r *Runtime) messwerteAnwenden(ctx context.Context) {
	r.mwMu.Lock()
	doc := r.mw.desired
	r.mwMu.Unlock()
	if doc == nil {
		r.mw.lz.Leeren() // a cleared plan reads nothing
		return
	}
	for _, s := range doc.Selections {
		if strings.HasPrefix(s.PointKey, "sunspec.") {
			r.erkenneSunSpec(ctx)
			break
		}
	}
	erz := r.planeErzeuger(&erzeugerbild.Konfig{Revision: int64(*doc.Revision), CatalogVersion: doc.CatalogVersion,
		Auswahl: erzeugerAuswahl(doc.Selections), Bilder: doc.Erzeugerbilder})
	konfig := messwerte.Konfig{Revision: doc.Revision, CatalogVersion: doc.CatalogVersion}
	keys := []string{}
	for _, s := range doc.Selections {
		// The Erzeuger image judges its own points; the core reads the Shelly
		// add-on sensors itself (measurements.KernEigeneVorlagen) - never twice.
		if !erzeugerbild.IstErzeugerSchluessel(s.PointKey) && !measurements.KernEigeneVorlagen[s.PointKey] {
			konfig.Selections = append(konfig.Selections, s)
			keys = append(keys, s.PointKey)
		}
	}
	sort.Strings(keys)
	sig := strings.Join(keys, "\n")
	r.mwMu.Lock()
	r.mw.erz = erz
	k := r.mw.katalog
	r.mwMu.Unlock()
	if k == nil || sig != r.mw.katSig {
		var err error
		if k, err = messwerte.LadeKatalog(keys); err != nil {
			r.log.Error("Messwerte: eingebetteter Katalog unlesbar", "err", err)
			return
		}
		r.mwMu.Lock()
		r.mw.katalog, r.mw.katSig = k, sig
		r.mwMu.Unlock()
	}
	plan, err := r.mw.lz.Apply(k, konfig, r.messwerteOptionen())
	if err != nil {
		r.log.Error("Messwerte: Plan nicht bewertet", "err", err)
		return
	}
	if plan.Applied {
		r.log.Info("Messplan uebernommen", "revision", *doc.Revision, "gelesen", len(plan.Accepted)+len(erz.Accepted),
			"abgelehnt", len(plan.Rejected)+len(erz.Rejected), "bloecke", len(plan.Blocks), "http", len(plan.HTTPGroups))
	}
}

func erzeugerAuswahl(sel []messwerte.Auswahl) []erzeugerbild.Auswahl {
	out := make([]erzeugerbild.Auswahl, len(sel))
	for i, s := range sel {
		// A cadence that is no integer is refused there, never rounded into one.
		c := 0
		if s.CadenceS == float64(int(s.CadenceS)) {
			c = int(s.CadenceS)
		}
		out[i] = erzeugerbild.Auswahl{PointKey: s.PointKey, CadenceS: c, EntityID: s.EntityID}
	}
	return out
}

// messwerteOptionen are the facts a plan is judged against now.
func (r *Runtime) messwerteOptionen() messwerte.PlanOptionen {
	r.mu.Lock()
	sel := r.sel
	r.mu.Unlock()
	o := messwerte.PlanOptionen{Bindung: messwerte.Bindung{Entitaeten: map[string]messwerte.Entitaet{},
		Quellen: map[string]messwerte.Geraet{}}, ByteOrders: map[string]string{},
		Discoveries: map[string]*messwerte.Discovery{},
		Ocpp:        &messwerte.OcppFaehigkeit{Supported: true, MaxLength: messwerteOcppMaxLaenge}}
	r.erzMu.Lock()
	for id, e := range r.erzEnt {
		o.Bindung.Entitaeten[id] = messwerte.Entitaet{EntityID: id, EntityType: e.EntityType,
			EdgeSourceID: e.EdgeSourceID, DataSourceID: e.DataSourceID}
	}
	r.erzMu.Unlock()
	r.mwMu.Lock()
	for id, q := range r.mw.quellen {
		o.Bindung.Quellen[id] = q
		bo, _ := q.Connection["byte_order"].(string)
		o.ByteOrders[messwerte.SourceTargetKey(id)] = bo
	}
	for key, d := range r.mw.disc {
		o.Discoveries[key] = d
	}
	o.Discovery = r.mw.disc[messwerte.TargetPrimary]
	r.mwMu.Unlock()
	if sel != nil {
		o.ByteOrder, _ = sel.Connection["byte_order"].(string)
	}
	return o
}

// messwerteQuellenAus keeps the source list (edge/sources/config) by id - the
// devices a bound component is read from.
func messwerteQuellenAus(payload []byte) map[string]messwerte.Geraet {
	out := map[string]messwerte.Geraet{}
	var doc struct {
		Sources []struct {
			ID            string         `json:"id"`
			Communication string         `json:"communication"`
			Connection    map[string]any `json:"connection"`
		} `json:"sources"`
	}
	if len(payload) == 0 || json.Unmarshal(payload, &doc) != nil {
		return out
	}
	for _, s := range doc.Sources {
		if s.ID != "" {
			out[s.ID] = messwerte.Geraet{Communication: s.Communication, Connection: s.Connection}
		}
	}
	return out
}

// --- SunSpec discovery per target --------------------------------------------

func istSunSpecGeraet(comm string) bool { return comm == CommSunSpecTCP || comm == CommFroniusSunSpec }

// erkenneSunSpec walks every SunSpec target whose device changed (the model
// base of each target is its own; a target without a walk has no address).
func (r *Runtime) erkenneSunSpec(ctx context.Context) {
	ziele := map[string]messwerte.Geraet{}
	r.mu.Lock()
	if r.sel != nil {
		if ip, _ := r.sel.Connection["ip"].(string); strings.TrimSpace(ip) != "" {
			ziele[messwerte.TargetPrimary] = messwerte.Geraet{Communication: r.sel.Communication, Connection: r.sel.Connection}
		}
	}
	r.mu.Unlock()
	r.mwMu.Lock()
	for id, q := range r.mw.quellen {
		ziele[messwerte.SourceTargetKey(id)] = q
	}
	r.mwMu.Unlock()
	for key, g := range ziele {
		sig, _ := json.Marshal([]any{g.Communication, g.Connection})
		r.mwMu.Lock()
		gleich := r.mw.discSig[key] == string(sig)
		r.mwMu.Unlock()
		if !istSunSpecGeraet(g.Communication) {
			r.mwMu.Lock()
			delete(r.mw.disc, key)
			delete(r.mw.discSig, key)
			r.mwMu.Unlock()
			continue
		}
		if gleich {
			continue
		}
		ziel := messwerte.Ziel{Key: key}
		if strings.HasPrefix(key, "source:") {
			ziel.SourceID = strings.TrimPrefix(key, "source:")
		}
		d, err := messwerte.Erkenne(ctx, func(ctx context.Context, start, count int) ([]uint16, error) {
			return r.liesMessRegister(ctx, messwerte.Leseauftrag{Start: start, Count: count, SourceKind: "sunspec_model", Target: ziel})
		})
		if err != nil {
			r.log.Warn("SunSpec-Erkennung fehlgeschlagen", "ziel", key, "err", err)
			continue
		}
		r.mwMu.Lock()
		r.mw.disc[key], r.mw.discSig[key] = d, string(sig)
		r.mwMu.Unlock()
	}
	r.mwMu.Lock()
	for key := range r.mw.disc {
		if _, ok := ziele[key]; !ok {
			delete(r.mw.disc, key)
			delete(r.mw.discSig, key)
		}
	}
	r.mwMu.Unlock()
}

// --- the device access (messwerte.IO) ----------------------------------------

type messwerteIO struct{ r *Runtime }

// geraetVon resolves a target's device at read time: a source that vanished
// since the plan is a gap, never a read of the primary inverter.
func (r *Runtime) geraetVon(z messwerte.Ziel) (messwerte.Geraet, error) {
	if z.Key == "" || z.Key == messwerte.TargetPrimary {
		r.mu.Lock()
		sel := r.sel
		r.mu.Unlock()
		if sel == nil {
			return messwerte.Geraet{}, errors.New("keine Geräteverbindung")
		}
		if ip, _ := sel.Connection["ip"].(string); strings.TrimSpace(ip) == "" {
			return messwerte.Geraet{}, errors.New("keine Geräteverbindung")
		}
		return messwerte.Geraet{Communication: sel.Communication, Connection: sel.Connection}, nil
	}
	r.mwMu.Lock()
	g, ok := r.mw.quellen[z.SourceID]
	r.mwMu.Unlock()
	if ip, _ := g.Connection["ip"].(string); !ok || z.SourceID == "" || strings.TrimSpace(ip) == "" {
		return messwerte.Geraet{}, errors.New("gebundenes Gerät nicht verfügbar")
	}
	return g, nil
}

// messFehler names a failed device access in the receipt vocabulary: no
// connection = unreachable, silence = no_answer; anything else has no class
// (like a palette error without a code).
func messFehler(err error) error {
	klasse := ""
	switch {
	case isDialError(err) || errors.Is(err, solarmanv5.ErrDial):
		klasse = "unreachable"
	case isTimeout(err) || errors.Is(err, solarmanv5.ErrNoAnswer):
		klasse = "no_answer"
	}
	return &messwerte.Lesefehler{Klasse: klasse, Text: err.Error()}
}

func (r *Runtime) liesMessRegister(ctx context.Context, a messwerte.Leseauftrag) ([]uint16, error) {
	g, err := r.geraetVon(a.Target)
	if err != nil {
		return nil, &messwerte.Lesefehler{Text: err.Error()}
	}
	ip, _ := g.Connection["ip"].(string)
	ip = strings.TrimSpace(ip)
	solarman := g.Communication == CommSolarmanV5
	port := int(num(g.Connection["port"], 0))
	if port <= 0 {
		port = 502
		if solarman {
			port = solarmanv5.DefaultPort
		}
	}
	addr := netJoin(ip, port)
	release, ok := r.lanes.acquire(ctx, addr, r.opts.LaneWait)
	if !ok {
		return nil, &messwerte.Lesefehler{Klasse: "timeout", Text: "Gerät belegt (" + addr + ")"}
	}
	defer release()
	if solarman {
		serial, err := solarmanv5.NormLoggerSerial(g.Connection["serial"])
		if err != nil {
			return nil, &messwerte.Lesefehler{Text: "Datenlogger-Seriennummer fehlt"}
		}
		slave := byte(num(g.Connection["mb_slave_id"], 1))
		if slave == 0 {
			slave = 1
		}
		sess, err := solarmanv5.Dial(ctx, r.opts.Dialer, addr, serial, slave, solarmanMessTimeout, solarmanMessTimeout)
		if err != nil {
			return nil, messFehler(err)
		}
		defer sess.Close()
		r.mwMu.Lock()
		sess.SetSequence(r.mw.seq)
		r.mwMu.Unlock()
		w, err := sess.ReadHolding(ctx, uint16(a.Start), uint16(a.Count))
		r.mwMu.Lock()
		r.mw.seq = sess.Sequence()
		r.mwMu.Unlock()
		if err != nil {
			return nil, messFehler(err)
		}
		return w, nil
	}
	unit := byte(num(g.Connection["unit_id"], 1))
	if unit == 0 {
		unit = 1
	}
	c, err := modbustcp.Dial(ctx, r.dialTCP, addr, unit, modbusMessTimeout, modbusMessTimeout)
	if err != nil {
		return nil, messFehler(err)
	}
	defer c.Close()
	var w []uint16
	if a.SourceKind == "modbus_input" {
		w, err = c.ReadInput(uint16(a.Start), uint16(a.Count))
	} else {
		w, err = c.ReadHolding(uint16(a.Start), uint16(a.Count))
	}
	if err != nil {
		return nil, messFehler(err)
	}
	return w, nil
}

func (m messwerteIO) LiesRegister(ctx context.Context, a messwerte.Leseauftrag) ([]uint16, error) {
	return m.r.liesMessRegister(ctx, a)
}

func (m messwerteIO) LiesJSON(ctx context.Context, a messwerte.JSONAuftrag) ([]any, error) {
	r := m.r
	g, err := r.geraetVon(a.Target)
	if err != nil {
		return nil, &messwerte.Lesefehler{Text: err.Error()}
	}
	ip, _ := g.Connection["ip"].(string)
	scheme, port := "http", 80
	if truthy(g.Connection["insecure_tls"]) {
		scheme, port = "https", 443
	}
	if p := int(num(g.Connection["port"], 0)); p > 0 {
		port = p
	}
	serial := serialText(g.Connection["serial"])
	pfad, err := messwerte.JSONPfad(a.Points, a.Filter, serial)
	if err != nil {
		return nil, &messwerte.Lesefehler{Text: err.Error()}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, scheme+"://"+netJoin(strings.TrimSpace(ip), port)+pfad, nil)
	if err != nil {
		return nil, &messwerte.Lesefehler{Text: err.Error()}
	}
	resp, err := r.mw.http.Do(req)
	if err != nil {
		return nil, messFehler(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, messwerteMaxBody+1))
	if err != nil {
		return nil, messFehler(err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &messwerte.Lesefehler{Klasse: "invalid_response", Text: "HTTP " + strconv.Itoa(resp.StatusCode)}
	}
	if len(body) > messwerteMaxBody {
		return nil, &messwerte.Lesefehler{Klasse: "invalid_response", Text: "Antwort größer als 1 MB"}
	}
	payload, err := messwerte.ParseGeraeteJSON(body)
	if err != nil {
		return nil, &messwerte.Lesefehler{Klasse: "invalid_response", Text: err.Error()}
	}
	if len(a.Points) > 0 && a.Points[0].SourceKind == "rpc_json" {
		return messwerte.ShellyStatus(a.Points, payload), nil
	}
	return []any{payload}, nil
}

// serialText is String(serial) for the forms a connection carries it in.
func serialText(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return ""
}

// Beleg turns the runtime's evidence into source receipts: one per data
// source the read belongs to (the target's own, else every component of it).
func (m messwerteIO) Beleg(b messwerte.Beleg) {
	r := m.r
	pin := PrimaryPinVon(b.Target)
	entity := b.EntityID
	r.mwMu.Lock()
	if entity == "" && b.PointKey != "" && r.mw.desired != nil {
		for _, s := range r.mw.desired.Selections {
			if s.PointKey == b.PointKey {
				entity = s.EntityID
				break
			}
		}
	}
	r.mwMu.Unlock()
	ids := map[string]bool{}
	var reihe []string
	if b.Target != nil && b.Target.DataSourceID != "" {
		reihe = []string{b.Target.DataSourceID}
	} else {
		r.erzMu.Lock()
		var keys []string
		for id := range r.erzEnt {
			keys = append(keys, id)
		}
		sort.Strings(keys)
		for _, id := range keys {
			e := r.erzEnt[id]
			passt := false
			if entity != "" {
				passt = id == entity
			} else {
				passt = e.EdgeSourceID == pin || (pin == "inverter" && e.EdgeSourceID == "" &&
					(e.EntityType == "battery-hybrid" || e.EntityType == "grid-meter" || e.EntityType == "house-load"))
			}
			if passt && e.DataSourceID != "" && !ids[e.DataSourceID] {
				ids[e.DataSourceID] = true
				reihe = append(reihe, e.DataSourceID)
			}
		}
		r.erzMu.Unlock()
	}
	for _, id := range reihe {
		ev := datasourcestatus.Event{ID: id, Failed: b.Failed, ErrorClass: datasourcestatus.ErrorClass(b.ErrorClass)}
		if b.Samples != nil {
			ev.Samples = *b.Samples
		}
		ev.Requests = b.Requests
		r.srcMu.Lock()
		r.receiptSeq++
		seq := r.receiptSeq
		r.srcMu.Unlock()
		ev.Ts = r.opts.Now().UTC()
		ev.EventID = r.bootID + "-" + strconv.FormatUint(seq, 10)
		raw, _ := json.Marshal(ev)
		if err := r.bus.Publish(datasourcestatus.Topic, raw, false); err != nil {
			r.log.Debug("Lese-Beleg nicht auf den lokalen Bus", "err", err)
		}
	}
}

// PrimaryPinVon is the pin of a target: its source, else the primary inverter.
func PrimaryPinVon(z *messwerte.Ziel) string {
	if z != nil && z.SourceID != "" {
		return z.SourceID
	}
	return "inverter"
}

// Status answers the plan once for both parts: the library's verdict and the
// Erzeuger image's.
func (m messwerteIO) Status(s messwerte.Status) {
	r := m.r
	r.mwMu.Lock()
	erz := r.mw.erz
	r.mwMu.Unlock()
	accepted := append([]string{}, s.Accepted...)
	accepted = append(accepted, erz.Accepted...)
	var rejected []measurements.Rejection
	for _, a := range s.Rejected {
		rejected = append(rejected, measurements.Rejection{PointKey: a.PointKey, Reason: a.Reason, EntityID: a.EntityID})
	}
	for _, a := range erz.Rejected {
		rejected = append(rejected, measurements.Rejection{PointKey: a.PointKey, Reason: a.Reason, EntityID: a.EntityID})
	}
	if rejected == nil {
		rejected = []measurements.Rejection{}
	}
	rev := int64(0)
	if s.Revision != nil {
		rev = int64(*s.Revision)
	}
	raw, _ := json.Marshal(measurements.LocalStatus{Revision: rev, AppliedAt: s.AppliedAt.UTC(), Accepted: accepted, Rejected: rejected})
	// Not from inside a bus handler: a QoS1 publish waits for its PUBACK.
	go func() {
		if err := r.bus.Publish(measurements.LocalStatusTopic, raw, true); err != nil {
			r.log.Warn("Messplan-Status konnte nicht auf den lokalen Bus", "err", err)
		}
	}()
}

// Proben sends one local batch; the core puts it into the durable outbox.
func (m messwerteIO) Proben(b messwerte.Probenstapel) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(b); err != nil {
		return
	}
	if err := m.r.bus.Publish(measurements.LocalSamplesTopic, bytes.TrimSpace(buf.Bytes()), false); err != nil {
		m.r.log.Warn("Messwerte konnten nicht auf den lokalen Bus", "err", err)
	}
}

// OcppKonfigurieren asks the core's CSMS to configure the sampled data.
func (m messwerteIO) OcppKonfigurieren(revision *float64, values map[string]string) {
	rev := int64(0)
	if revision != nil {
		rev = int64(*revision)
	}
	raw, _ := json.Marshal(map[string]any{"revision": rev, "values": values})
	go func() {
		if err := m.r.bus.Publish(measurements.LocalOcppConfigTopic, raw, true); err != nil {
			m.r.log.Warn("OCPP-Messkonfiguration nicht auf den lokalen Bus", "err", err)
		}
	}()
}

func (r *Runtime) onOcppErgebnis(_ string, payload []byte) {
	var res struct {
		Revision float64 `json:"revision"`
		Applied  bool    `json:"applied"`
	}
	if json.Unmarshal(payload, &res) != nil {
		return
	}
	r.mwMu.Lock()
	k := r.mw.katalog
	r.mwMu.Unlock()
	r.mw.lz.OcppErgebnis(k, &res.Revision, res.Applied)
}

func (r *Runtime) onOcppMeterValues(_ string, payload []byte) {
	var doc struct {
		ObservedAt time.Time                `json:"observed_at"`
		Samples    []messwerte.SampledValue `json:"samples"`
	}
	if json.Unmarshal(payload, &doc) != nil {
		return
	}
	r.mw.lz.OnMeterValues(doc.Samples, doc.ObservedAt)
}
