package layer1

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/datasourcestatus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/erzeugerbild"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbusprofil"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

// The Erzeuger image on Edge Light (concept vp-pfc200-edge-konzept, Stufe 2
// "Lesen"): the Go twin of the palette's reader (internal/erzeugerbild) behind
// the same local-bus topics the palette serves on the Docker box -
//
//   - edge/measurements/config (retained): the plan; Erzeuger points are
//     judged here, the status merges with the library's points (messwerte.go)
//   - edge/entities/+/config, edge/sources/config (retained): the binding of a
//     selection's component to its controller (pin -> connection)
//   - edge/measurements/samples, edge/events, edge/sources/<pin>/telemetry,
//     edge/data-sources/poll: what a reading yields
//   - edge/probe/request -> edge/probe/result: the op erzeuger_kopf of the
//     "Steuerung verbinden" step (and the plain register read, modbus.go)
//
// The controller may be anywhere in the customer LAN or, on a WAGO PFC200
// that runs Edge Light itself, the device's own Modbus server on 127.0.0.1
// ("in diesem Gerät"). Read only: nothing here writes a register.

// erzeugerTakt paces the runtime; a controller is read when its 5 s are due.
const erzeugerTakt = time.Second

// TopicEntityConfig is the retained per-entity registry the core publishes.
const TopicEntityConfig = "edge/entities/+/config"

// planeErzeuger judges the Erzeuger part of a plan with the current binding
// (nil: the plan was cleared).
func (r *Runtime) planeErzeuger(k *erzeugerbild.Konfig) erzeugerbild.PlanStatus {
	r.erzMu.Lock()
	defer r.erzMu.Unlock()
	if k == nil {
		r.erzKonfig = nil
		return r.erz.Plane(erzeugerbild.Konfig{}, r.erzBindung())
	}
	hat := false
	for _, s := range k.Auswahl {
		if erzeugerbild.IstErzeugerSchluessel(s.PointKey) {
			hat = true
			break
		}
	}
	if !hat {
		r.erzKonfig = nil
		return r.erz.Plane(erzeugerbild.Konfig{}, r.erzBindung())
	}
	r.erzKonfig = k
	st := r.erz.Plane(*k, r.erzBindung())
	r.erzBindSig = r.erzBindungsSignatur()
	var anfragen []string
	for _, a := range r.erz.Anfragen() {
		anfragen = append(anfragen, "FC"+strconv.Itoa(a.FC)+" "+a.Ziel.Quelle.IP+":"+
			strconv.Itoa(a.Ziel.Quelle.Port)+" @"+strconv.Itoa(a.Start)+"+"+strconv.Itoa(a.Count))
	}
	r.log.Info("Erzeuger-Bild: Messplan", "revision", k.Revision, "gelesen", len(st.Accepted),
		"abgelehnt", len(st.Rejected), "anfragen", anfragen)
	return st
}

func (r *Runtime) erzBindung() erzeugerbild.Bindung {
	b := erzeugerbild.Bindung{Entitaeten: map[string]erzeugerbild.BindungsEntitaet{},
		Quellen: map[string]erzeugerbild.BindungsQuelle{}}
	for id, e := range r.erzEnt {
		b.Entitaeten[id] = e
	}
	for id, q := range r.erzQuellen {
		b.Quellen[id] = q
	}
	return b
}

// erzBindungsSignatur names the binding a plan was made from, so a change of
// registry or source list re-judges the plan - and nothing else does.
func (r *Runtime) erzBindungsSignatur() string {
	var teile []string
	for id, e := range r.erzEnt {
		teile = append(teile, "e"+id+"|"+e.EntityType+"|"+e.EdgeSourceID+"|"+e.DataSourceID)
	}
	for id, q := range r.erzQuellen {
		teile = append(teile, "q"+id+"|"+q.IP+"|"+strconv.Itoa(q.Port)+"|"+strconv.Itoa(q.UnitID))
	}
	sort.Strings(teile)
	return strings.Join(teile, "\n")
}

// erzBindungGeaendert re-judges a plan with Erzeuger points after the binding
// changed (an entity or source arrived after the plan, as at boot).
func (r *Runtime) erzBindungGeaendert() {
	r.erzMu.Lock()
	neu := r.erzKonfig != nil && r.erzBindungsSignatur() != r.erzBindSig
	r.erzMu.Unlock()
	if neu {
		r.messplanNeuBewerten()
	}
}

// onEntityConfig takes one retained edge/entities/{id}/config; an empty
// payload is the core's "entity removed".
func (r *Runtime) onEntityConfig(topic string, payload []byte) {
	id := strings.TrimSuffix(strings.TrimPrefix(topic, "edge/entities/"), "/config")
	if id == "" || strings.Contains(id, "/") {
		return
	}
	var doc struct {
		EntityID     string `json:"entity_id"`
		EntityType   string `json:"entity_type"`
		EdgeSourceID string `json:"edge_source_id"`
		Driver       *struct {
			DataSourceID string `json:"data_source_id"`
		} `json:"driver"`
	}
	r.erzMu.Lock()
	if len(payload) == 0 || json.Unmarshal(payload, &doc) != nil || doc.EntityID == "" {
		delete(r.erzEnt, id)
	} else {
		e := erzeugerbild.BindungsEntitaet{EntityType: doc.EntityType, EdgeSourceID: doc.EdgeSourceID}
		if doc.Driver != nil {
			e.DataSourceID = doc.Driver.DataSourceID
		}
		r.erzEnt[doc.EntityID] = e
	}
	r.erzMu.Unlock()
	r.erzBindungGeaendert()
	r.messplanNeuBewerten() // the library binds its components through the registry too
}

// erzQuellenAus reads the connection of every source of edge/sources/config -
// the measurement binding resolves a pin to any of them, a plant controller
// (role plant-controller, EZ-21) in particular.
func erzQuellenAus(payload []byte) map[string]erzeugerbild.BindungsQuelle {
	out := map[string]erzeugerbild.BindungsQuelle{}
	var doc struct {
		Sources []struct {
			ID         string `json:"id"`
			Connection struct {
				IP     string  `json:"ip"`
				Port   float64 `json:"port"`
				UnitID float64 `json:"unit_id"`
			} `json:"connection"`
		} `json:"sources"`
	}
	if len(payload) == 0 || json.Unmarshal(payload, &doc) != nil {
		return out
	}
	for _, s := range doc.Sources {
		ip := strings.TrimSpace(s.Connection.IP)
		if s.ID == "" || ip == "" {
			continue
		}
		port := int(s.Connection.Port)
		if port == 0 {
			port = 502
		}
		out[s.ID] = erzeugerbild.BindungsQuelle{IP: ip, Port: port, UnitID: int(s.Connection.UnitID)}
	}
	return out
}

// runErzeuger reads the planned controllers until ctx ends. The reads run
// WITHOUT the runtime's lock: Beginne claims them, Beende judges the answers
// (and drops them if a new plan came in meanwhile).
func (r *Runtime) runErzeuger(ctx context.Context) {
	t := time.NewTicker(erzeugerTakt)
	defer t.Stop()
	for {
		r.erzeugerTakt(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (r *Runtime) erzeugerTakt(ctx context.Context) {
	r.erzMu.Lock()
	runde := r.erz.Beginne(r.opts.Now())
	r.erzMu.Unlock()
	if runde == nil {
		return
	}
	antworten := r.leseErzeuger(ctx, runde.Anfragen)
	r.erzMu.Lock()
	erg := r.erz.Beende(runde, antworten)
	r.erzMu.Unlock()
	for _, n := range erg.Nachrichten {
		raw, err := json.Marshal(n.Payload)
		if err != nil {
			continue
		}
		if err := r.bus.Publish(n.Topic, raw, false); err != nil {
			r.log.Warn("Erzeuger-Bild: Nachricht nicht auf den lokalen Bus", "topic", n.Topic, "err", err)
		}
	}
	r.erzBelege(erg.Belege)
}

// leseErzeuger reads the claimed requests: one Modbus TCP session per
// controller and tick under the lane of its address (a probe of the same
// controller waits for it), the blocks in order. A transport failure ends the
// session - the rest of that image cannot be complete anyway.
func (r *Runtime) leseErzeuger(ctx context.Context, anfragen []erzeugerbild.GeplanteAnfrage) []erzeugerbild.Antwort {
	out := make([]erzeugerbild.Antwort, len(anfragen))
	for i := 0; i < len(anfragen); {
		j := i
		for j < len(anfragen) && anfragen[j].Ziel.Key == anfragen[i].Ziel.Key {
			j++
		}
		q := anfragen[i].Ziel.Quelle
		klasse := ""
		var c *modbustcp.Client
		addr := net.JoinHostPort(q.IP, strconv.Itoa(q.Port))
		release, frei := func() {}, true
		switch {
		case !probe.IsPrivateHost(q.IP):
			// The LAN rule again at the opener (lan-host-vectors.json): a
			// controller lives in the customer's network or on this device.
			klasse = "unreachable"
			r.noteError(addr, "Erzeuger-Bild: Adresse liegt nicht im Kundennetz")
		default:
			release, frei = r.lanes.acquire(ctx, addr, r.opts.LaneWait)
			if !frei {
				klasse = "timeout"
				release = func() {}
				break
			}
			var err error
			c, err = modbustcp.Dial(ctx, r.dialTCP, addr, byte(q.UnitID), r.opts.ConnectTimeout, r.opts.ReadTimeout)
			if err != nil {
				klasse = erzFehlerklasse(err)
			}
		}
		for k := i; k < j; k++ {
			if klasse != "" {
				out[k].Klasse = klasse
				continue
			}
			a := anfragen[k]
			var w []uint16
			var err error
			if a.FC == 4 {
				w, err = c.ReadInput(uint16(a.Start), uint16(a.Count))
			} else {
				w, err = c.ReadHolding(uint16(a.Start), uint16(a.Count))
			}
			switch {
			case err == nil:
				out[k].Woerter = w
			case modbustcp.IsException(err):
				out[k].Klasse = "no_answer"
			case strings.HasPrefix(err.Error(), "modbus:"):
				out[k].Klasse = "invalid_response"
			default:
				klasse = erzFehlerklasse(err)
				out[k].Klasse = klasse
			}
		}
		if c != nil {
			_ = c.Close()
		}
		release()
		i = j
	}
	return out
}

// erzFehlerklasse maps a transport error onto the source contract's classes.
func erzFehlerklasse(err error) string {
	switch {
	case isDialError(err):
		return "unreachable"
	case isTimeout(err):
		return "no_answer"
	case errors.Is(err, context.Canceled):
		return "timeout"
	}
	return "invalid_response"
}

// erzBelege sends the read receipts of a tick on edge/data-sources/poll: per
// controller one receipt with the requests and the delivered samples, then one
// per failure class - the core's collector sums the counts and keeps the last
// verdict, so a tick with a refused image or an implausible value ends failed.
func (r *Runtime) erzBelege(belege []erzeugerbild.Beleg) {
	type summe struct {
		ziel     erzeugerbild.Ziel
		requests int
		samples  int
		klassen  []string
		gesehen  map[string]bool
	}
	var reihe []*summe
	je := map[string]*summe{}
	for _, b := range belege {
		s := je[b.Ziel.Key]
		if s == nil {
			s = &summe{ziel: b.Ziel, gesehen: map[string]bool{}}
			je[b.Ziel.Key] = s
			reihe = append(reihe, s)
		}
		s.requests += b.Requests
		s.samples += b.Samples
		if b.Failed && !s.gesehen[b.ErrorClass] {
			s.gesehen[b.ErrorClass] = true
			s.klassen = append(s.klassen, b.ErrorClass)
		}
	}
	for _, s := range reihe {
		if s.requests > 0 || s.samples > 0 {
			r.erzBeleg(s.ziel, s.requests, s.samples, false, "")
		}
		for _, k := range s.klassen {
			r.erzBeleg(s.ziel, 0, 0, true, k)
		}
	}
}

func (r *Runtime) erzBeleg(z erzeugerbild.Ziel, requests, samples int, failed bool, class string) {
	ev := datasourcestatus.Event{Samples: samples, Failed: failed, ErrorClass: datasourcestatus.ErrorClass(class)}
	switch {
	case z.DataSourceID != "":
		ev.ID = z.DataSourceID
	case z.SourceID != "":
		ev.SourceID = z.SourceID
	default:
		return // the primary target carries no source of its own here
	}
	r.srcMu.Lock()
	r.receiptSeq++
	seq := r.receiptSeq
	r.srcMu.Unlock()
	ev.Ts = r.opts.Now().UTC()
	ev.EventID = r.bootID + "-" + strconv.FormatUint(seq, 10)
	ev.Requests = &requests
	raw, _ := json.Marshal(ev)
	if err := r.bus.Publish(datasourcestatus.Topic, raw, false); err != nil {
		r.log.Debug("Lese-Beleg nicht auf den lokalen Bus", "ziel", z.Key, "err", err)
	}
}

// --- the probe channel ----------------------------------------------------

type probeAnfrage struct {
	RequestID string                 `json:"request_id"`
	Ops       []erzeugerbild.ProbeOp `json:"ops"`
}

// probeAntwort is one answered step on edge/probe/result: the Erzeuger head
// of an erzeuger_kopf step, or the raw value and register words of a plain
// register read.
type probeAntwort struct {
	erzeugerbild.ProbeErgebnis
	Raw       *float64 `json:"raw,omitempty"`
	Registers []uint16 `json:"registers,omitempty"`
}

// onProbe answers one edge/probe/request, the steps one after another like
// vp-modbus-probe.js: a plain register read (no `op` on the bus,
// modbus.go registerProbe) and the op erzeuger_kopf are read here; any other
// step (wago_kopf) is refused by name at once instead of letting the core wait
// for its timeout (edge-light/docs/paritaet.md D).
func (r *Runtime) onProbe(ctx context.Context, payload []byte) {
	var req probeAnfrage
	if json.Unmarshal(payload, &req) != nil || req.RequestID == "" || len(req.Ops) == 0 || len(req.Ops) > 8 {
		return
	}
	results := make([]probeAntwort, 0, len(req.Ops))
	for i, op := range req.Ops {
		if op.ID == "" {
			op.ID = strconv.Itoa(i)
		}
		switch op.Op {
		case "":
			e := r.registerProbe(ctx, op.ID, modbusprofil.LeseOp{Host: op.Host, Port: op.Port, UnitID: op.UnitID,
				FC: op.FC, Address: op.Address, DataType: op.DataType, WordOrder: op.WordOrder})
			results = append(results, probeAntwort{ProbeErgebnis: erzeugerbild.ProbeErgebnis{ID: e.ID, OK: e.OK,
				ErrorCode: e.ErrorCode, Message: e.Message}, Raw: e.Raw, Registers: e.Registers})
		case erzeugerbild.OpErzeugerKopf:
			results = append(results, probeAntwort{ProbeErgebnis: r.kopfProbe(ctx, op)})
		default:
			results = append(results, probeAntwort{ProbeErgebnis: erzeugerbild.ProbeErgebnis{ID: op.ID,
				ErrorCode: erzeugerbild.ProbeNichtGestuetzt,
				Message: "Edge Light führt diesen Prüfschritt („" + op.Op + "“) noch nicht aus - " +
					"nur einzelne Register und den Kopf eines Erzeuger-Registerbilds."}})
		}
	}
	raw, _ := json.Marshal(struct {
		RequestID string         `json:"request_id"`
		Results   []probeAntwort `json:"results"`
	}{req.RequestID, results})
	if err := r.bus.Publish(localbus.TopicProbeResult, raw, false); err != nil {
		r.log.Warn("Probe-Ergebnis nicht auf den lokalen Bus", "err", err)
	}
}

// kopfProbe runs one erzeuger_kopf op in ONE session under the lane of the
// controller's address, so it never runs next to the plan's read.
func (r *Runtime) kopfProbe(ctx context.Context, op erzeugerbild.ProbeOp) erzeugerbild.ProbeErgebnis {
	var c *modbustcp.Client
	var release func()
	defer func() {
		if c != nil {
			_ = c.Close()
		}
		if release != nil {
			release()
		}
	}()
	tot := ""
	lies := func(ctx context.Context, v erzeugerbild.ProbeVerbindung, start, count int) ([]uint16, string, string) {
		if tot != "" {
			return nil, tot, ""
		}
		if c == nil {
			addr := net.JoinHostPort(v.Host, strconv.Itoa(v.Port))
			if !probe.IsPrivateHost(v.Host) {
				tot = erzeugerbild.ProbeUnerreichbar
				return nil, tot, "Adresse liegt nicht im Kundennetz"
			}
			rel, ok := r.lanes.acquire(ctx, addr, r.opts.LaneWait)
			if !ok {
				tot = erzeugerbild.ProbeZeit
				return nil, tot, "Warteschlange voll"
			}
			release = rel
			var err error
			c, err = modbustcp.Dial(ctx, r.dialTCP, addr, byte(v.UnitID), r.opts.ConnectTimeout, r.opts.ReadTimeout)
			if err != nil {
				c = nil
				tot = erzFehlerklasse(err)
				return nil, tot, err.Error()
			}
		}
		var w []uint16
		var err error
		if v.FC == 4 {
			w, err = c.ReadInput(uint16(start), uint16(count))
		} else {
			w, err = c.ReadHolding(uint16(start), uint16(count))
		}
		switch {
		case err == nil:
			return w, "", ""
		case modbustcp.IsException(err):
			return nil, erzeugerbild.ProbeKeineAntwort, err.Error()
		case strings.HasPrefix(err.Error(), "modbus:"):
			return nil, erzeugerbild.ProbeUnlesbar, err.Error()
		}
		// The session is gone: every further read of this op fails alike.
		tot = erzFehlerklasse(err)
		return nil, tot, err.Error()
	}
	return erzeugerbild.KopfProbe(ctx, op, lies)
}
