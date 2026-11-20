package layer1

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/steuerplan"
)

// The control path of Layer 1 (Steuern in Go, Teil 1b): the Go twin of the
// "Steuerung" row of the Node-RED self-wiring tab - edge/setpoint -> plan node
// (steuerplan.Planen) -> Deye executor (steuerplan.Ausfuehren) over the ONE
// logger socket -> vp-control-readback (steuerplan.Form) on
// edge/control/readback. At start the crash recovery hands back what a
// control session left latched in EEPROM.
//
// Only the Deye (solarman_v5) is steered; every other transport stays read
// only. In front of every gate of the core and the planner sits the Edge
// Light release (freigabe.go): without it a device is planned and probed,
// never written.

const (
	// steuerLaneWait is how long a tick waits for the logger behind a running
	// poll (the flow's ACQUIRE_MS), steuerLaneWaitCal for a calibration test.
	steuerLaneWait    = 9 * time.Second
	steuerLaneWaitCal = 14 * time.Second
	// steuerSessionBudget bounds one tick on the socket (the flow's 12-s timer).
	steuerSessionBudget = 12 * time.Second
)

// steuerung is the state of the control path. ablage and seq belong to the
// control goroutine alone.
type steuerung struct {
	mu      sync.Mutex
	sel     steuerplan.Obj // the selection as the core published it
	pending steuerplan.Obj // the newest setpoint not yet run
	kick    chan struct{}

	ablage   *steuerplan.Ablage
	seq      uint16
	lastWarn map[string]string
}

func newSteuerung() steuerung {
	return steuerung{kick: make(chan struct{}, 1), ablage: steuerplan.NeueAblage(), lastWarn: map[string]string{}}
}

// steuerAuswahl is the selection the plan node reads: vp-inverter-config's
// structural check (schema 1.0, a communication, a family, a connection with
// an ip) - but the WHOLE object, model included.
func steuerAuswahl(payload []byte) steuerplan.Obj {
	var o steuerplan.Obj
	if json.Unmarshal(payload, &o) != nil || o == nil || o["schema_version"] != "1.0" {
		return nil
	}
	if c, _ := o["communication"].(string); strings.TrimSpace(c) == "" {
		return nil
	}
	if f, _ := o["family"].(string); strings.TrimSpace(f) == "" {
		return nil
	}
	conn, _ := o["connection"].(map[string]any)
	if ip, _ := conn["ip"].(string); strings.TrimSpace(ip) == "" {
		return nil
	}
	return o
}

func (r *Runtime) steuerAuswahlSetzen(payload []byte) {
	r.st.mu.Lock()
	r.st.sel = steuerAuswahl(payload)
	r.st.mu.Unlock()
}

// onSetpoint is vp-sollwert: a setpoint without a finite battery_setpoint_kw
// is dropped; the newest one runs next (a tick never overlaps another).
func (r *Runtime) onSetpoint(_ string, payload []byte) {
	var sp steuerplan.Obj
	if json.Unmarshal(payload, &sp) != nil || sp == nil {
		return
	}
	kw, ok := sp["battery_setpoint_kw"].(float64)
	if !ok || math.IsNaN(kw) || math.IsInf(kw, 0) {
		return
	}
	r.st.mu.Lock()
	r.st.pending = sp
	r.st.mu.Unlock()
	select {
	case r.st.kick <- struct{}{}:
	default:
	}
}

// runSteuern is the control goroutine: crash recovery once, then one tick per
// setpoint.
func (r *Runtime) runSteuern(ctx context.Context) {
	r.steuerLaden()
	if snap := r.st.ablage.Snapshot; snap != nil {
		if plan, warn := steuerplan.Absturz(snap); plan != nil {
			r.log.Warn(warn)
			r.steuerAusfuehren(ctx, plan, steuerplan.Obj{"source": "crash_recovery"}, nil, "")
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.st.kick:
		}
		r.st.mu.Lock()
		sp, sel := r.st.pending, r.st.sel
		r.st.pending = nil
		r.st.mu.Unlock()
		if sp != nil {
			r.steuerTakt(ctx, sel, sp)
		}
	}
}

// steuerTakt is one tick of the plan node and the executor.
func (r *Runtime) steuerTakt(ctx context.Context, sel, sp steuerplan.Obj) {
	a := r.st.ablage
	now := r.opts.Now()
	ziel := steuerplan.Ziel(sel)
	in := steuerplan.PlanEingabe{Setpoint: sp, Selection: sel, Snapshot: a.Snapshot,
		Catalog: steuerplan.CertifiedNativeCapabilities, Now: now,
		TouBudget: func(ip string, port float64) any { return a.Budget[ip+":"+portString(port)] }}
	if ziel != "" {
		in.Cap, in.Sticky, in.NativeCfg = a.Faehigkeit[ziel], a.Pfad[ziel], a.Geraetekonfig[ziel]
	}
	gesperrt := ""
	if ziel != "" {
		familie, _ := sel["family"].(string)
		familie = strings.TrimSpace(familie)
		pfad := steuerplan.Steuerpfad(sel, sp, in.Cap, in.Sticky, now)
		if !steuernFreigegeben(familie, pfad) && (sp["device_certified"] == true || sp["calibration"] == true) {
			// The Edge Light release closes the device's own grant: the plan
			// comes out exactly as for an uncertified device.
			gated := make(steuerplan.Obj, len(sp))
			for k, v := range sp {
				gated[k] = v
			}
			gated["device_certified"], gated["calibration"] = false, false
			in.Setpoint = gated
			gesperrt = "Edge Light: Steuerung für " + familie + " (" + pfadWort(pfad) +
				") noch nicht am Prüfstand freigegeben - es wird nur gelesen"
		}
	}
	out, z := steuerplan.Planen(in, a.Plan)
	a.Plan = z
	if out.Warn != "" {
		r.log.Info(out.Warn)
	}
	if out.Control == nil {
		return
	}
	if gesperrt != "" && len(out.Control.Writes) == 0 {
		out.Control.Reason, out.Control.Blocked = gesperrt, true
	}
	r.steuerAusfuehren(ctx, out.Control, sp, out.NativeCapabilities, out.NativeRefusal)
}

func pfadWort(p string) string {
	if p == steuerplan.DeyePathRemote {
		return "Fernsteuerung"
	}
	return "Zeitfenster"
}

func portString(port float64) string {
	b, _ := json.Marshal(port)
	return string(b)
}

// steuerAusfuehren runs the executor over the logger's lane and publishes the
// readback as vp-control-readback shapes it.
func (r *Runtime) steuerAusfuehren(ctx context.Context, plan *steuerplan.Plan, sp steuerplan.Obj,
	caps *steuerplan.NativeLevers, refusal string) {
	now := r.opts.Now()
	var sess *solarmanv5.Session
	release := func() {}
	defer func() {
		if sess != nil {
			r.st.seq = sess.Sequence()
			_ = sess.Close()
		}
		release()
	}()
	sctx, cancel := context.WithTimeout(ctx, steuerSessionBudget)
	defer cancel()
	isCal := sp["source"] == "calibration" || (plan.Calibration != nil && *plan.Calibration)
	verbinde := func(context.Context) (steuerplan.Spur, error) {
		ip, _ := plan.Connection["ip"].(string)
		port, _ := plan.Connection["port"].(float64)
		addr := netJoin(ip, int(port))
		wait := steuerLaneWait
		if isCal {
			wait = steuerLaneWaitCal
		}
		rel, ok := r.lanes.acquire(ctx, addr, wait)
		if !ok {
			return nil, errors.New("Logger belegt - Schreiben auf den naechsten Takt verschoben")
		}
		release = rel
		serial, err := solarmanv5.NormLoggerSerial(plan.Connection["serial"])
		if err != nil {
			return nil, err
		}
		slave := byte(1)
		if v, ok := plan.Connection["mb_slave_id"].(float64); ok && v > 0 && v < 256 {
			slave = byte(v)
		}
		s, err := solarmanv5.Dial(sctx, r.opts.Dialer, addr, serial, slave, r.opts.ConnectTimeout, r.opts.ReadTimeout)
		if err != nil {
			return nil, err
		}
		s.SetSequence(r.st.seq)
		sess = s
		return solarmanSpur{s}, nil
	}
	res := steuerplan.Ausfuehren(sctx, steuerplan.AusfuehrEingabe{Control: plan, Setpoint: sp,
		NativeCapabilities: caps, NativeRefusal: refusal, Now: now}, r.st.ablage, verbinde)
	for _, w := range res.Warnungen {
		r.steuerWarnung(w)
	}
	if res.Dauerhaft {
		r.steuerSpeichern()
	}
	if res.Payload == nil {
		return
	}
	shaped := steuerplan.Form(res.Payload, isoMillis(now))
	if shaped == nil {
		return
	}
	raw, _ := json.Marshal(shaped)
	if err := r.bus.Publish(localbus.TopicControlReadback, raw, false); err != nil {
		r.log.Warn("Steuer-Rueckmeldung nicht gesendet", "err", err)
	}
}

// steuerWarnung logs a warning once per distinct line in a row (the flow's
// 30-s rate limit, without a clock): a standing cause is said once.
func (r *Runtime) steuerWarnung(w string) {
	key := w
	if i := strings.Index(w, "): "); i > 0 {
		key = w[:i]
	}
	if r.st.lastWarn[key] == w {
		return
	}
	r.st.lastWarn[key] = w
	r.log.Warn(w)
}

// solarmanSpur is the executor's view of a Solarman session.
type solarmanSpur struct{ s *solarmanv5.Session }

func spurFehler(err error) error {
	if solarmanv5.IsProtocolError(err) {
		return &steuerplan.Protokollfehler{Msg: err.Error()}
	}
	return err
}

func (p solarmanSpur) Lies(ctx context.Context, addr, count int) ([]int, error) {
	regs, err := p.s.ReadHoldingAsAnswered(ctx, uint16(addr), uint16(count))
	if err != nil {
		return nil, spurFehler(err)
	}
	out := make([]int, len(regs))
	for i, v := range regs {
		out[i] = int(v)
	}
	return out, nil
}

func (p solarmanSpur) Schreibe(ctx context.Context, fc, addr, value int) error {
	return spurFehler(p.s.WriteRegister(ctx, byte(fc), uint16(addr), uint16(value)))
}

// --- the durable part of the store ('file' context of the flow) -------------

type steuerDatei struct {
	Snapshot steuerplan.Obj            `json:"snapshot"`
	Pfad     map[string]steuerplan.Obj `json:"pfad"`
	Budget   map[string]any            `json:"budget"`
}

func (r *Runtime) steuerLaden() {
	if r.opts.SteuerAblage == "" {
		return
	}
	raw, err := os.ReadFile(r.opts.SteuerAblage)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			r.log.Warn("Steuer-Ablage nicht lesbar", "datei", r.opts.SteuerAblage, "err", err)
		}
		return
	}
	var d steuerDatei
	if err := json.Unmarshal(raw, &d); err != nil {
		r.log.Warn("Steuer-Ablage unlesbar; verworfen", "datei", r.opts.SteuerAblage, "err", err)
		return
	}
	a := r.st.ablage
	a.Snapshot = d.Snapshot
	for k, v := range d.Pfad {
		a.Pfad[k] = v
	}
	for k, v := range d.Budget {
		a.Budget[k] = v
	}
}

// steuerSpeichern writes the durable records atomically - only when a tick
// changed them (a snapshot per ToU session, a path decision, a plan change of
// the day budget), so the flash of a small box is spared.
func (r *Runtime) steuerSpeichern() {
	if r.opts.SteuerAblage == "" {
		return
	}
	a := r.st.ablage
	raw, err := json.Marshal(steuerDatei{Snapshot: a.Snapshot, Pfad: a.Pfad, Budget: a.Budget})
	if err == nil {
		tmp := r.opts.SteuerAblage + ".neu"
		if err = os.MkdirAll(filepath.Dir(tmp), 0o700); err == nil {
			if err = os.WriteFile(tmp, raw, 0o600); err == nil {
				err = os.Rename(tmp, r.opts.SteuerAblage)
			}
		}
	}
	if err != nil {
		r.log.Warn("Steuer-Ablage nicht geschrieben", "datei", r.opts.SteuerAblage, "err", err)
	}
}
