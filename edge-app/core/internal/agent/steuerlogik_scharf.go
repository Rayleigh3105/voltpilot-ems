package agent

// Steuerlogik "scharf" (Stufe 3; docs/contracts/v2/steuerlogik.md
// "Scharf"): an armed logic's wishes go to the arbiter with the pattern of the
// heating-rod controller - class flow (rank 40), TTL 45 s, renewed every beat,
// an internal source no publisher can claim. Everything above keeps its say:
// a manual intervention (75), the guards and the cycle guard, "Automatik
// pausieren", the two switches of the box. The plan executor and the
// deadline fallback leave a device of an armed logic alone (owner_claimed,
// applied to the box's own logic), and a device has never two masters: a rod
// the heating-rod controller drives gets no wish from a logic - the box names
// the conflict in the heartbeat instead of fighting it out.
//
// The run itself (internal/logiklauf) never switches; this file is the one
// place its wishes become commands.

import (
	"log/slog"
	"strconv"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logiklauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shelly"
)

// logikTTL keeps a logic's wish alive between beats; a dead beat lets it
// expire into the fail-safe (off), like the heating-rod controller.
const logikTTL = 45 * time.Second

// typeWaermepumpeSGReady is the heat pump on its SG-Ready contact: the
// contract's mode "boost" closes the contact (state 3), "normal" opens it
// (E10 = A: start with the existing contact).
const typeWaermepumpeSGReady = "heat-pump-sgready"

// logikScharfStand is the agent-side memory of the armed logics.
type logikScharfStand struct {
	mu sync.Mutex
	// held: entities this agent submitted a wish for in the last beat.
	held map[string]bool
	// konflikt: per entity why the box gives it no wish (second master,
	// unknown device, an output the box cannot execute yet).
	konflikt map[string]*cloud.LogikHalt
	warned   map[string]string
}

// steuerlogikOwns reports whether an armed logic owns this entity right now -
// the plan executor and the deadline fallback then leave it alone.
func (a *Agent) steuerlogikOwns(entityID string) bool {
	if a.logik == nil || !a.Cfg.ConsumerControlEnabled {
		return false
	}
	_, ok := a.logik.Beansprucht()[entityID]
	return ok
}

// logikHalt says why armed logics switch nothing right now; nil = they do.
func (a *Agent) logikHalt(now time.Time) *cloud.LogikHalt {
	if !a.Cfg.ControlEnabled || !a.Cfg.ConsumerControlEnabled {
		return &cloud.LogikHalt{Code: "schalter_aus",
			Text: "Die Box schaltet keine Verbraucher: ihre Schalter für das Steuern sind aus."}
	}
	a.entMu.Lock()
	paused := a.entRegistry.Paused(now)
	a.entMu.Unlock()
	if paused {
		return &cloud.LogikHalt{Code: "pausiert",
			Text: "Die Automatik ist pausiert: die Logik rechnet weiter, schaltet aber nicht."}
	}
	return nil
}

// runSteuerlogik hands the wishes of the armed logics to the arbiter; called
// after every beat of the run.
func (a *Agent) runSteuerlogik(now time.Time) {
	if a.logik == nil || a.arb == nil {
		return
	}
	now = now.UTC()
	active := a.Cfg.ConsumerControlEnabled
	seen := map[string]bool{}
	konflikt := map[string]*cloud.LogikHalt{}
	for _, w := range a.logik.Wuensche() {
		if !active {
			break
		}
		a.entMu.Lock()
		e := a.entRegistry.Find(w.EntityID)
		var ent entities.Entity
		if e != nil {
			ent = *e
		}
		a.entMu.Unlock()
		if e == nil {
			konflikt[w.EntityID] = &cloud.LogikHalt{Code: "geraet_unbekannt",
				Text: "Dieses Gerät kennt die Box nicht; die Logik schaltet es nicht."}
			continue
		}
		if a.heizstabOwns(w.EntityID) {
			konflikt[w.EntityID] = &cloud.LogikHalt{Code: "zweiter_herr",
				Text: "Der Heizstab-Regler der Box führt dieses Gerät schon; die Logik schaltet es nicht."}
			continue
		}
		cmds, typ, warum := logikBefehl(ent, w.Ausgang)
		if warum != nil {
			konflikt[w.EntityID] = warum
			continue
		}
		if cmds.Empty() {
			continue // no wish this beat: the device falls to its rest value
		}
		seen[w.EntityID] = true
		a.arb.SubmitInternal(&desired.Desired{
			EntityID:      w.EntityID,
			RequestID:     "steuerlogik:" + w.FlowID + ":" + strconv.Itoa(w.Fassung) + ":" + w.Geraet,
			Source:        desired.Source{Kind: desired.SourceSteuerlogik, FlowID: w.FlowID, FlowVersion: w.Fassung},
			Priority:      desired.ClassFlow,
			TTL:           logikTTL,
			IssuedAt:      now,
			Commands:      a.consumerCommands(ent, cmds),
			RequestedType: typ,
		})
	}

	a.logikScharf.mu.Lock()
	var release []string
	for id := range a.logikScharf.held {
		if !seen[id] {
			release = append(release, id)
		}
	}
	for id, k := range konflikt {
		if a.logikScharf.warned[id] != k.Code {
			slog.Warn("steuerlogik: Gerät wird nicht geschaltet", "entity", id, "code", k.Code, "grund", k.Text)
		}
	}
	warned := map[string]string{}
	for id, k := range konflikt {
		warned[id] = k.Code
	}
	a.logikScharf.held, a.logikScharf.konflikt, a.logikScharf.warned = seen, konflikt, warned
	a.logikScharf.mu.Unlock()
	// A device the logic no longer wishes for (stilllegen, back to running
	// along, no wish this beat, a second master): release it NOW, never let a
	// wish linger until its TTL.
	for _, id := range release {
		a.arb.Withdraw(id, desired.Source{Kind: desired.SourceSteuerlogik}.Key(), false)
	}
	if len(release) > 0 {
		a.pokeArbitration()
	}
}

// logikBefehl puts a logic output into the commands of the device. A level
// is the heating rod's stage: on a Shelly output set the kW of the largest
// stage that fits (setpoint_kw, the word the heating-rod controller speaks),
// else on/off. A mode at an SG-Ready heat pump without a mode of its own is
// its contact (boost closes it, normal opens it; E10 = A). Everything else
// goes through the seam of K2 (logikBefehle): on_off, setpoint_c, setpoint_kw,
// mode. A command the device does not execute, and a share, the box does not
// send: the device then gets no wish and the heartbeat names why. The cloud
// requires the same commands in the armed bundle (logikdienst.SchaltRecht).
func logikBefehl(e entities.Entity, o logik.Ausgang) (entities.Commands, string, *cloud.LogikHalt) {
	var c entities.Commands
	if o.HatAnteil {
		return c, "", &cloud.LogikHalt{Code: "ausgang_offen",
			Text: "Einen Anteil stellt die Box noch nicht; die Logik schaltet dieses Gerät nicht."}
	}
	if o.HatStufe {
		cfg, isShelly := shelly.ParseDriver(e.Driver)
		if !isShelly || !cfg.IsGroup() {
			on := o.Stufe > 0
			c.OnOff = &on
			return c, entities.CmdOnOff, nil
		}
		outs, kws := cfg.StageCeilings()
		if len(outs) == 0 {
			return c, "", &cloud.LogikHalt{Code: "stufen_unbekannt",
				Text: "Die Stufen dieses Geräts sind unbekannt; die Logik schaltet es nicht."}
		}
		kw := 0.0
		for i := range outs {
			if outs[i] <= o.Stufe {
				kw = kws[i] // the largest stage that fits (restrict-only)
			}
		}
		c.SetpointKw = &kw
		return c, entities.CmdSetpointKw, nil
	}
	if o.HatBetriebsart && e.Type == typeWaermepumpeSGReady && !e.Supports(entities.CmdMode) {
		switch o.Betriebsart {
		case "":
			return c, "", nil // unknown: no wish
		case "boost", "normal":
			on := o.Betriebsart == "boost"
			c.OnOff = &on
			return c, entities.CmdOnOff, nil
		}
		return c, "", &cloud.LogikHalt{Code: "ausgang_offen",
			Text: "Am SG-Ready-Kontakt gibt es nur boost und normal, nicht „" + o.Betriebsart + "“."}
	}
	c = logikBefehle(o)
	namen := befehlsNamen(c)
	for _, cmd := range namen {
		if !e.Supports(cmd) {
			return entities.Commands{}, "", &cloud.LogikHalt{Code: "ausgang_offen",
				Text: "Das Gerät führt „" + befehlsWort(cmd) + "“ nicht aus; die Logik schaltet es nicht."}
		}
	}
	if len(namen) != 1 {
		return c, "", nil // several commands (or none): the arbiter's events name them all
	}
	return c, namen[0], nil
}

// befehlsNamen are the commands c carries, in contract words.
func befehlsNamen(c entities.Commands) []string {
	var out []string
	if c.OnOff != nil {
		out = append(out, entities.CmdOnOff)
	}
	if c.SetpointC != nil {
		out = append(out, entities.CmdSetpointC)
	}
	if c.SetpointKw != nil {
		out = append(out, entities.CmdSetpointKw)
	}
	if c.Mode != "" {
		out = append(out, entities.CmdMode)
	}
	return out
}

// befehlsWort names a command for the customer.
func befehlsWort(cmd string) string {
	switch cmd {
	case entities.CmdOnOff:
		return "Ein/Aus"
	case entities.CmdSetpointC:
		return "Sollwert in °C"
	case entities.CmdSetpointKw:
		return "Leistung in kW"
	case entities.CmdMode:
		return "Betriebsart"
	}
	return cmd
}

// logikScharfSummary adds what only the agent knows to the armed runs of the
// heartbeat block: why the logic does not switch, what the arbiter granted,
// who holds a device, which guard held a wish back, which conflict the box
// refused to fight.
func (a *Agent) logikScharfSummary(sum *cloud.LogikSummary, now time.Time) {
	if sum == nil {
		return
	}
	halt := a.logikHalt(now)
	a.logikScharf.mu.Lock()
	konflikt := a.logikScharf.konflikt
	a.logikScharf.mu.Unlock()
	for i := range sum.Laeufe {
		l := &sum.Laeufe[i]
		if l.Zustand != logiklauf.ZustandScharf {
			continue
		}
		l.Halt = halt
		for k, g := range l.Geraete {
			if k := konflikt[g.EntityID]; k != nil {
				g.Konflikt = k
			}
			if a.arb != nil {
				if dec, ok := a.arb.DecisionFor(g.EntityID); ok {
					g.Befehl = a.logikStandAusBefehl(g.EntityID, dec.Granted, dec.HolderKind == "")
					if dec.HolderKind != string(desired.SourceSteuerlogik) {
						g.Halter = dec.HolderKind
						if g.Halter == "" {
							g.Halter = "failsafe"
						}
					}
					if dec.Cycle != nil {
						g.Schutz = &cloud.LogikHalt{Code: dec.Cycle.Code, Text: dec.Cycle.Text}
					} else if dec.Clamped {
						g.Schutz = &cloud.LogikHalt{Code: "begrenzt",
							Text: "Eine Schutzgrenze der Box begrenzt, was die Logik will."}
					}
				}
			}
			l.Geraete[k] = g
		}
	}
}

// logikStandAusBefehl writes a granted command as a switch state: a setpoint
// of an output set as its stage, an on/off as on/off. failsafe with nothing
// granted reads as off (the registry's rest value of a consumer).
func (a *Agent) logikStandAusBefehl(entityID string, c entities.Commands, failsafe bool) *cloud.LogikStand {
	a.entMu.Lock()
	e := a.entRegistry.Find(entityID)
	var cfg shelly.Config
	var isShelly bool
	if e != nil {
		cfg, isShelly = shelly.ParseDriver(e.Driver)
	}
	a.entMu.Unlock()
	s := logikSchaltStand(c, failsafe, isShelly && cfg.IsGroup(), cfg)
	if c.SetpointC != nil || c.Mode != "" {
		// A device that regulates itself (K2): its setpoint and mode, next to
		// its on/off.
		if s == nil {
			s = &cloud.LogikStand{}
		}
		if c.SetpointC != nil {
			v := *c.SetpointC
			s.Sollwert = &v
		}
		s.Betriebsart = c.Mode
	}
	return s
}

// logikSchaltStand is the switch part of a granted command: the stage of an
// output set, else on/off; nil when it carries none.
func logikSchaltStand(c entities.Commands, failsafe, gruppe bool, cfg shelly.Config) *cloud.LogikStand {
	switch {
	case c.SetpointKw != nil && gruppe:
		outs, kws := cfg.StageCeilings()
		n := 0
		for i := range outs {
			if kws[i] <= *c.SetpointKw+1e-9 {
				n = outs[i]
			}
		}
		return &cloud.LogikStand{Stufe: &n}
	case c.OnOff != nil:
		on := *c.OnOff
		return &cloud.LogikStand{Ein: &on}
	case c.SetpointKw != nil:
		on := *c.SetpointKw > 0
		return &cloud.LogikStand{Ein: &on}
	case c.LimitKw != nil:
		on := *c.LimitKw > 0
		return &cloud.LogikStand{Ein: &on}
	case failsafe && gruppe:
		n := 0
		return &cloud.LogikStand{Stufe: &n}
	case failsafe && c.SetpointC == nil && c.Mode == "":
		off := false
		return &cloud.LogikStand{Ein: &off}
	}
	return nil
}
