package layer1

import (
	"context"
	"encoding/json"
	"math/rand"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/erzeugerbild"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/koppelbild"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

// The Koppelbild on Edge Light (PFC200 concept Stufe 4 "Wünschen",
// docs/contracts/v2/koppelbild.md): the box writes wishes into the
// controller's holding registers 0..63, the controller decides and
// acknowledges in its input registers 1000..1115. It runs in the SAME session
// as the Erzeuger image of the same controller (one socket, one lane - the
// edge rule for a shared physical socket), behind these local-bus topics:
//
//   - edge/entities/+/config (retained): the Anlagensteuerung's released
//     Stellplätze as actuate capabilities with their platz
//   - edge/entities/+/command (retained): the arbiter's granted command and
//     the box's two-gate posture (control_enabled), like any adapter takes it
//   - edge/koppelbild/status (retained, published): the status block the core
//     carries as `koppel` in the heartbeat - display only
//   - edge/probe/request -> edge/probe/result: the op koppel_test (Schalt-Test)
//
// The controller always decides; every wish runs out by itself (frist 60 s).

// TopicEntityCommand is the retained granted command per entity.
const TopicEntityCommand = "edge/entities/+/command"

// TopicKoppelStatus carries the Koppelbild status of all controllers.
const TopicKoppelStatus = "edge/koppelbild/status"

// koppelTestPause lets the controller's cycle take a test telegram before the
// box reads its acknowledgement again.
var koppelTestPause = 1500 * time.Millisecond

// koppelBefehl is the last granted command of an Anlagensteuerung.
type koppelBefehl struct {
	befehl koppelbild.Befehl
	frei   bool
}

// koppelZiel is one controller with a Koppelbild candidate: the component, its
// connection and the expected controller id of its image's version.
type koppelZiel struct {
	entityID     string
	dataSourceID string
	key          string
	quelle       erzeugerbild.BindungsQuelle
	soll         *uint32
}

// koppelZiele lists the controllers of the current Erzeuger plan, keyed by
// the target key the plan reads them under. Only pinned plant controllers
// (an Anlagensteuerung bound to a source) have a Koppelbild.
func (r *Runtime) koppelZiele() map[string][]koppelZiel {
	r.erzMu.Lock()
	defer r.erzMu.Unlock()
	if r.erzKonfig == nil {
		return nil
	}
	b := r.erzBindung()
	out := map[string][]koppelZiel{}
	for _, p := range r.erzKonfig.Bilder {
		e, da := b.Entitaeten[p.EntityID]
		if !da || e.EntityType != "anlagensteuerung" {
			continue
		}
		z, ok := b.ZielVon(p.EntityID)
		if !ok || z.SourceID == "" {
			continue
		}
		q, da := b.Quellen[z.SourceID]
		if !da {
			continue
		}
		kz := koppelZiel{entityID: p.EntityID, dataSourceID: z.DataSourceID, key: z.Key, quelle: q}
		if p.SteuerungKennung != nil && *p.SteuerungKennung >= 0 && *p.SteuerungKennung < 0xFFFFFFFF {
			v := uint32(*p.SteuerungKennung)
			kz.soll = &v
		}
		out[z.Key] = append(out[z.Key], kz)
	}
	return out
}

// koppelSteuerung returns the runtime of a controller, created with a fresh
// session on first use; the expected id follows the image's version.
func (r *Runtime) koppelSteuerung(z koppelZiel) *koppelbild.Steuerung {
	st, da := r.koppel[z.entityID]
	if !da {
		st = koppelbild.Neu(z.soll, uint16(1+rand.Intn(65534)))
		r.koppel[z.entityID] = st
		r.koppelDQ[z.entityID] = z.dataSourceID
	}
	st.SetzeSoll(z.soll)
	return st
}

// koppelAustausch runs the Koppelbild of one controller in an open session:
// read the acknowledgement, judge it, write the telegram when it is due (or
// when erzwingen, a Schalt-Test) and the reading allows it. It returns the
// transport error class that ended the session, "" otherwise, and whether a
// telegram went out.
func (r *Runtime) koppelAustausch(c *modbustcp.Client, z koppelZiel, erzwingen bool) (string, bool) {
	q, err := c.ReadInput(koppelbild.QBasis, koppelbild.QWoerter)
	jetzt := r.opts.Now()
	klasse := ""
	r.koppelMu.Lock()
	st := r.koppelSteuerung(z)
	var u koppelbild.Urteil
	switch {
	case err == nil:
		u = st.Lies(q, jetzt)
	case modbustcp.IsException(err):
		// The server answered, but has no registers at 1000: no Koppelbild.
		u = st.Lies([]uint16{}, jetzt)
	default:
		klasse = erzFehlerklasse(err)
		u = st.Lies(nil, jetzt)
	}
	var w []uint16
	if klasse == "" && u.Schreibt && (erzwingen || st.Faellig(jetzt)) {
		b := r.koppelBefehl[z.entityID]
		w = st.Telegramm(koppelbild.WuenscheAus(b.befehl, r.koppelCaps[z.entityID]), b.frei, nil, jetzt)
	}
	r.koppelMu.Unlock()
	geschrieben := false
	if w != nil {
		if err := c.WriteRegisters(koppelbild.WBasis, w); err != nil {
			r.log.Warn("Koppelbild: Telegramm nicht geschrieben", "steuerung", z.entityID, "err", err)
			if !modbustcp.IsException(err) && !strings.HasPrefix(err.Error(), "modbus:") {
				klasse = erzFehlerklasse(err)
			}
		} else {
			geschrieben = true
		}
	}
	r.koppelStatus()
	return klasse, geschrieben
}

// koppelSitzung opens one session under the lane of the controller's
// address, runs fn and closes it.
func (r *Runtime) koppelSitzung(ctx context.Context, z koppelZiel, fn func(c *modbustcp.Client)) string {
	if !probe.IsPrivateHost(z.quelle.IP) {
		return "unreachable"
	}
	addr := net.JoinHostPort(z.quelle.IP, strconv.Itoa(z.quelle.Port))
	release, frei := r.lanes.acquire(ctx, addr, r.opts.LaneWait)
	if !frei {
		return "timeout"
	}
	defer release()
	c, err := modbustcp.Dial(ctx, r.dialTCP, addr, byte(z.quelle.UnitID), r.opts.ConnectTimeout, r.opts.ReadTimeout)
	if err != nil {
		jetzt := r.opts.Now()
		r.koppelMu.Lock()
		r.koppelSteuerung(z).Lies(nil, jetzt)
		r.koppelMu.Unlock()
		r.koppelStatus()
		return erzFehlerklasse(err)
	}
	defer c.Close()
	fn(c)
	return ""
}

// koppelEilig sends the telegram of a changed wish at once (at most one per
// second), outside the regular 5 s tick of the reading.
func (r *Runtime) koppelEilig(ctx context.Context, ziele map[string][]koppelZiel) {
	jetzt := r.opts.Now()
	for _, liste := range ziele {
		for _, z := range liste {
			r.koppelMu.Lock()
			st := r.koppel[z.entityID]
			eilig := st != nil && st.Eilig(jetzt)
			r.koppelMu.Unlock()
			if eilig {
				r.koppelSitzung(ctx, z, func(c *modbustcp.Client) { r.koppelAustausch(c, z, false) })
			}
		}
	}
}

// koppelVergiss drops the controllers that left the plan.
func (r *Runtime) koppelVergiss(ziele map[string][]koppelZiel) {
	da := map[string]bool{}
	for _, liste := range ziele {
		for _, z := range liste {
			da[z.entityID] = true
		}
	}
	r.koppelMu.Lock()
	weg := false
	for id := range r.koppel {
		if !da[id] {
			delete(r.koppel, id)
			delete(r.koppelDQ, id)
			weg = true
		}
	}
	r.koppelMu.Unlock()
	if weg {
		r.koppelStatus()
	}
}

// koppelStatus publishes the status of every controller (retained).
func (r *Runtime) koppelStatus() {
	r.koppelMu.Lock()
	ids := make([]string, 0, len(r.koppel))
	for id := range r.koppel {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	stand := make([]koppelbild.Stand, 0, len(ids))
	for _, id := range ids {
		s := r.koppel[id].Stand()
		s.Steuerung, s.DataSourceID = id, r.koppelDQ[id]
		stand = append(stand, s)
	}
	r.koppelMu.Unlock()
	raw, err := json.Marshal(stand)
	if err != nil {
		return
	}
	if err := r.bus.Publish(TopicKoppelStatus, raw, true); err != nil {
		r.log.Warn("Koppelbild: Stand nicht auf den lokalen Bus", "err", err)
	}
}

// onEntityCommand takes one retained edge/entities/{id}/command; an empty
// payload is the arbiter's "nothing granted" (failsafe release).
func (r *Runtime) onEntityCommand(topic string, payload []byte) {
	id := strings.TrimSuffix(strings.TrimPrefix(topic, "edge/entities/"), "/command")
	if id == "" || strings.Contains(id, "/") {
		return
	}
	var doc struct {
		ControlEnabled bool   `json:"control_enabled"`
		Source         string `json:"source"`
		Commands       struct {
			SetpointKw *float64 `json:"setpoint_kw"`
			SetpointC  *float64 `json:"setpoint_c"`
			LimitKw    *float64 `json:"limit_kw"`
			LimitPct   *float64 `json:"limit_pct"`
			OnOff      *bool    `json:"on_off"`
			Mode       string   `json:"mode"`
		} `json:"commands"`
	}
	r.koppelMu.Lock()
	defer r.koppelMu.Unlock()
	if len(payload) == 0 || json.Unmarshal(payload, &doc) != nil {
		delete(r.koppelBefehl, id)
	} else {
		c := doc.Commands
		r.koppelBefehl[id] = koppelBefehl{frei: doc.ControlEnabled, befehl: koppelbild.Befehl{SetpointKw: c.SetpointKw,
			SetpointC: c.SetpointC, LimitKw: c.LimitKw, LimitPct: c.LimitPct, OnOff: c.OnOff, Mode: c.Mode,
			Source: doc.Source}}
	}
	if st := r.koppel[id]; st != nil {
		st.Geaendert()
	}
}

// koppelFaehigkeiten takes the released Stellplätze of an entity config.
func (r *Runtime) koppelFaehigkeiten(id, entityType string, actuate []koppelCap) {
	var f []koppelbild.Faehigkeit
	if entityType == "anlagensteuerung" {
		for _, a := range actuate {
			if a.Platz >= 1 && a.Platz <= koppelbild.Plaetze && koppelbild.ArtFuer(a.Command) != "" {
				f = append(f, koppelbild.Faehigkeit{Platz: a.Platz, Kommando: a.Command})
			}
		}
	}
	r.koppelMu.Lock()
	defer r.koppelMu.Unlock()
	if len(f) == 0 {
		delete(r.koppelCaps, id)
	} else {
		r.koppelCaps[id] = f
	}
	if st := r.koppel[id]; st != nil {
		st.Geaendert()
	}
}

// koppelCap is one actuate capability of an entity config.
type koppelCap struct {
	Command string `json:"command"`
	Platz   int    `json:"platz"`
}

// probeSchritt is one op of edge/probe/request: the read ops of the Erzeuger
// image and the koppel_test fields.
type probeSchritt struct {
	erzeugerbild.ProbeOp
	SteuerungID *int64 `json:"steuerung_id,omitempty"`
	Platz       *int   `json:"platz,omitempty"`
	Art         string `json:"art,omitempty"`
	Wert        *int64 `json:"wert,omitempty"`
	TTLSeconds  *int   `json:"ttl_s,omitempty"`
}

// koppelProbe runs a Schalt-Test (op koppel_test): the controller must be one
// the plan reads (the same session and Folge as the regular telegrams - a
// separate writer would be a second writer); for ttl_s the test wish rides
// every telegram, the answer is the controller's acknowledgement of exactly
// the test's Folge.
func (r *Runtime) koppelProbe(ctx context.Context, op probeSchritt) probeAntwort {
	antwort := probeAntwort{ProbeErgebnis: erzeugerbild.ProbeErgebnis{ID: op.ID}}
	fehler := func(code, satz string, k *probe.KoppelTest) probeAntwort {
		antwort.ErrorCode, antwort.Message, antwort.KoppelTest = code, satz, k
		return antwort
	}
	if op.SteuerungID == nil || op.Platz == nil || op.Wert == nil || op.TTLSeconds == nil ||
		*op.Platz < 1 || *op.Platz > koppelbild.Plaetze || koppelbild.KommandoFuer(op.Art) == "" {
		return fehler(erzeugerbild.ProbeUngueltig, "Der Schalt-Test ist unvollständig.", nil)
	}
	port, unit := op.Port, op.UnitID
	if port == 0 {
		port = 502
	}
	var z *koppelZiel
	for _, liste := range r.koppelZiele() {
		for i := range liste {
			q := liste[i].quelle
			if q.IP == op.Host && q.Port == port && q.UnitID == unit {
				z = &liste[i]
			}
		}
	}
	if z == nil {
		return fehler(erzeugerbild.ProbeUngueltig,
			"Die Box liest diese Steuerung nicht (kein Messplan für sie) - der Schalt-Test braucht ihre laufende Verbindung.", nil)
	}
	if z.soll == nil || int64(*z.soll) != *op.SteuerungID {
		return fehler(erzeugerbild.ProbeUngueltig,
			"Die Kennung der Steuerung passt nicht zur Fassung, die die Box liest.", &probe.KoppelTest{Lage: koppelbild.LageOhneSoll})
	}
	platz := *op.Platz
	r.koppelMu.Lock()
	st := r.koppelSteuerung(*z)
	st.SetzeTest(&koppelbild.Test{Platz: platz, Art: op.Art, Wert: int32(*op.Wert),
		Bis: r.opts.Now().Add(time.Duration(*op.TTLSeconds) * time.Second)})
	warten := st.Abstand(r.opts.Now())
	r.koppelMu.Unlock()
	if warten > 0 {
		select {
		case <-ctx.Done():
			return fehler(erzeugerbild.ProbeZeit, "Der Schalt-Test wurde abgebrochen.", nil)
		case <-time.After(warten):
		}
	}
	geschrieben := false
	klasse := r.koppelSitzung(ctx, *z, func(c *modbustcp.Client) {
		var k string
		k, geschrieben = r.koppelAustausch(c, *z, true)
		if k != "" {
			geschrieben = false
		}
	})
	r.koppelMu.Lock()
	folge := int(st.Folge(platz))
	angebot := st.Angebot(platz)
	u := st.Urteil()
	r.koppelMu.Unlock()
	block := &probe.KoppelTest{Lage: u.Lage, Geschrieben: &geschrieben}
	if angebot != nil {
		block.Angebot, _ = json.Marshal(angebot)
	}
	if klasse != "" {
		return fehler(klasse, "Die Steuerung war für den Schalt-Test nicht erreichbar.", block)
	}
	if !geschrieben {
		return fehler(erzeugerbild.ProbeUnlesbar, "Die Box durfte den Testwunsch nicht schreiben ("+u.Lage+").", block)
	}
	block.Folge = &folge
	select {
	case <-ctx.Done():
		return fehler(erzeugerbild.ProbeZeit, "Der Schalt-Test wurde abgebrochen.", block)
	case <-time.After(koppelTestPause):
	}
	r.koppelSitzung(ctx, *z, func(c *modbustcp.Client) { r.koppelAustausch(c, *z, false) })
	r.koppelMu.Lock()
	u = st.Urteil()
	p := st.Platz(platz)
	if l := st.Stand(); l.KopfUrteil != nil {
		block.KopfUrteil = *l.KopfUrteil
	}
	r.koppelMu.Unlock()
	block.Lage = u.Lage
	if p != nil && int(p.QFolge) == folge && p.QUrteil != nil {
		block.Urteil = *p.QUrteil
		if p.QWirksam != nil {
			v := int64(*p.QWirksam)
			block.Wirksam = &v
		}
		antwort.OK = true
		antwort.KoppelTest = block
		return antwort
	}
	return fehler(erzeugerbild.ProbeKeineAntwort,
		"Die Steuerung hat den Testwunsch nicht quittiert - läuft der Baustein Koppelbild im Programm?", block)
}
