package steuerplan

import (
	"context"
	"math"
	"strconv"
	"time"
)

// The Huawei SUN2000 + LUNA2000 control path of Edge Light and Edge Industrie:
// the WINDOW path of catalog/control-profiles/profiles/huawei.json, narrowed to
// the one lever measured with its effect (captain, 26.11.2026, option C): the
// discharge limit 47077 (U32 W). The inverter stays in "Maximise self
// consumption" (47086 = 2, read as a precondition, never written) and
// regulates by itself; the box only blocks discharging (47077 = 0) or hands it
// back (47077 = the device's own value). Measured at a field SUN2000-3KTL-M1
// with a LUNA2000 (25./26.11.2026, Messbericht in edge-app/nodered/huawei/):
// W with gain 1, 0 stops discharging after 1,4 s, 1000 W caps it after ~6 s.
//
// The charge limit 47075 stays locked until its effect under PV surplus is
// measured on a sunny day: a positive setpoint (E_laden) and Halten block
// discharging only - charging is the device's own regulation; E_decken
// (negative setpoint) frees discharging and blocks no charging.
//
// The forced setpoint (47100/47246/47247/47249/47083, intents N and A) is NOT
// part of this path: grid charging is not released (the captain, 25.11.2026),
// a positive setpoint with grid_charge_allowed only charges from surplus here.
//
// The handback restores the device's own value read before the first write
// (Ausgang) - never 0, which would leave discharging blocked. 47087/47088 (grid
// charging on the device) are never touched.
//
// 47077 is treated as persistent (huawei.json schreibbudget): it is written
// only when the device holds another value (tolerance 100 W), and a tick that
// writes spends one plan change of the day budget (TouBudget, the core's
// persistent_write_budget, at most 20), the last room reserved for the
// handback.

const (
	// CommHuawei is the Huawei transport (inverter.CommHuaweiModbus).
	CommHuawei = "huawei_modbus"
	// PfadHuawei is the control path word of this path (readback control_path).
	PfadHuawei = "huawei_fenster"

	HuaweiRegArbeitsmodus = 47086 // U16: 2 = Maximise self consumption
	HuaweiRegMaxLaden     = 47075 // U32 W
	HuaweiRegMaxEntladen  = 47077 // U32 W

	HuaweiEigenverbrauch = 2
	huaweiToleranzW      = 100

	// FolgeEntladenSperren: 47077 = 0 (E_laden and Halten - discharging
	// blocked, charging the device's own regulation).
	FolgeEntladenSperren = "entladen_sperren"
	// FolgeEntladenFrei: 47077 = the device's own value (E_decken).
	FolgeEntladenFrei = "entladen_frei"
	FolgeRueckgabe    = "rueckgabe"
)

// HuaweiFeld is one register of the window path.
type HuaweiFeld struct {
	Addr  int
	Worte int // 1 = U16 (FC6), 2 = U32 (FC16)
	Rolle string
	Tol   int
}

// HuaweiFenster are the registers the path writes and whose original values
// the Ausgang holds: the discharge limit alone.
var HuaweiFenster = []HuaweiFeld{
	{HuaweiRegMaxEntladen, 2, "max_discharge_power", huaweiToleranzW},
}

// huaweiModus is the precondition: the mode the lever was measured in.
var huaweiModus = HuaweiFeld{HuaweiRegArbeitsmodus, 1, "work_mode", 0}

func huaweiFeld(addr int) HuaweiFeld {
	for _, f := range HuaweiFenster {
		if f.Addr == addr {
			return f
		}
	}
	return HuaweiFeld{Addr: addr, Worte: 1}
}

// HuaweiSchritt is one target of a plan: a fixed value, or the device's own
// value from the Ausgang (AusAusgang).
type HuaweiSchritt struct {
	Feld       HuaweiFeld
	Wert       int
	AusAusgang bool
}

// HuaweiEntscheid is what one tick should do.
type HuaweiEntscheid struct {
	Folge          string // "" = nothing to write
	Schritte       []HuaweiSchritt
	Certified      bool
	ControlEnabled bool
	Calibration    bool
	Gesperrt       bool   // writing is not allowed (the readback says blocked)
	Grund          string // why blocked, or a note on the plan
}

// HuaweiEingabe is one tick's input.
type HuaweiEingabe struct {
	Selection   Obj
	Setpoint    Obj
	Freigegeben bool // the Edge Light release (family, path, model) - layer1
	MitAusgang  bool // an Ausgang is stored: the box has written to this device
	Now         time.Time
}

// HuaweiPlanen decides the tick. Gates, all of them needed to write: the
// Edge Light release, control_enabled (Not-Aus), the device's certification
// (device_certified - for Huawei the platform register of brand and model and
// the plant's arming; First-Light does not offer Huawei) or a calibration, a
// fresh setpoint. When
// one is missing and the box has written before, the tick is the handback -
// the handback undoes the box's own writes and needs no gate.
func HuaweiPlanen(in HuaweiEingabe) HuaweiEntscheid {
	sel, sp := in.Selection, in.Setpoint
	controlEnabled := isTrue(get(sp, "control_enabled"))
	calibration := isTrue(get(sp, "calibration"))
	deviceCertified := isTrue(get(sp, "device_certified"))
	e := HuaweiEntscheid{ControlEnabled: controlEnabled, Calibration: calibration,
		Certified: in.Freigegeben && deviceCertified}
	grund := ""
	switch {
	case sel == nil || trimmed(get(obj(get(sel, "connection")), "ip")) == "":
		grund = "keine IP-Adresse"
	case sp == nil || !isFiniteNum(get(sp, "battery_setpoint_kw")):
		grund = "kein gueltiger Sollwert"
	case !in.Freigegeben:
		grund = "Edge Light: Steuerung für dieses Huawei-Modell noch nicht freigegeben - es wird nur gelesen"
	case !controlEnabled:
		grund = "Steuerung deaktiviert (Not-Aus)"
	case !deviceCertified && !calibration:
		grund = "Steuerung für dieses Gerät noch nicht zertifiziert (Plattform-Register und Scharfschaltung ausstehend)"
	case SetpointStale(get(sp, "ts"), in.Now):
		grund = "Sollwert veraltet (Kern schweigt) - Rückgabe an den Wechselrichter"
	}
	if grund != "" {
		e.Gesperrt, e.Grund = true, grund
		if in.MitAusgang {
			e.Folge, e.Schritte = FolgeRueckgabe, HuaweiRueckgabe()
		}
		return e
	}
	kw := num(get(sp, "battery_setpoint_kw"))
	if isTrue(get(obj(get(sel, "connection")), "invert_control_sign")) {
		kw = -kw
	}
	if kw < 0 {
		// E_decken: discharging is the device's own regulation within its own
		// limit (no charge block: 47075 is not released).
		e.Folge = FolgeEntladenFrei
		e.Schritte = []HuaweiSchritt{{Feld: huaweiFeld(HuaweiRegMaxEntladen), AusAusgang: true}}
		return e
	}
	// E_laden and Halten: discharging blocked; charging stays the device's own
	// regulation (47075 is not released).
	e.Folge = FolgeEntladenSperren
	e.Schritte = []HuaweiSchritt{{Feld: huaweiFeld(HuaweiRegMaxEntladen), Wert: 0}}
	if kw > 0 && isTrue(get(sp, "grid_charge_allowed")) {
		e.Grund = "Netzladen (Absicht N) ist für Huawei nicht freigegeben - die Box sperrt nur das Entladen, das Laden regelt das Gerät selbst"
	}
	return e
}

// HuaweiRueckgabe is the handback: the discharge limit back to the device's
// own value.
func HuaweiRueckgabe() []HuaweiSchritt {
	return []HuaweiSchritt{{Feld: huaweiFeld(HuaweiRegMaxEntladen), AusAusgang: true}}
}

// --- the executor --------------------------------------------------------------

// HuaweiSpur is one Modbus TCP session to the inverter (the connect pause is
// the caller's).
type HuaweiSpur interface {
	Lies(ctx context.Context, addr, worte int) (int, error)
	Schreibe(ctx context.Context, addr, worte, wert int) error
}

// HuaweiLauf is one tick of the executor.
type HuaweiLauf struct {
	Entscheid HuaweiEntscheid
	Family    string
	Setpoint  Obj
	Ausgang   map[int]int // the device's own values; nil = none stored
	Budget    TouBudget
	Limit     int
	// Sichern stores a newly read Ausgang durably BEFORE the first write; an
	// error ends the tick without a write.
	Sichern func(map[int]int) error
	Now     time.Time
}

// HuaweiErgebnis is the outcome: the readback payload (for Form), the Ausgang
// and budget after the tick.
type HuaweiErgebnis struct {
	Payload     Obj
	Ausgang     map[int]int
	Budget      TouBudget
	Geschrieben bool
	Warnung     string
}

// HuaweiAusfuehren runs one tick over an open session.
func HuaweiAusfuehren(ctx context.Context, l HuaweiLauf, spur HuaweiSpur) HuaweiErgebnis {
	res := HuaweiErgebnis{Ausgang: l.Ausgang, Budget: l.Budget}
	e := l.Entscheid
	mode := "normal"
	if e.Folge == FolgeRueckgabe {
		mode = "release"
	}
	payload := func(regs []any, wrote bool, reason string, blocked bool) Obj {
		p := Obj{"ts": isoMillis(l.Now), "family": l.Family, "source": sourceOf(l.Setpoint),
			"control_enabled": e.ControlEnabled, "certified": e.Certified, "mode": mode,
			"control_path": PfadHuawei, "registers": regs, "wrote": wrote, "blocked": blocked, "reason": reason}
		if v := get(l.Setpoint, "slot_start"); !isUndef(v) {
			p["slot_start"] = v
		}
		return p
	}
	// 1. What the device holds now (and, the first time, its own values).
	ist := map[int]int{}
	lies := func(f HuaweiFeld) error {
		v, err := spur.Lies(ctx, f.Addr, f.Worte)
		if err == nil {
			ist[f.Addr] = v
		}
		return err
	}
	// The precondition of every control write: the mode the lever was
	// measured in. Otherwise nothing is written - only a handback of what the
	// box wrote before.
	if e.Folge != FolgeRueckgabe {
		if err := lies(huaweiModus); err != nil {
			res.Warnung = "Huawei: Arbeitsmodus nicht lesbar - kein Schreiben: " + err.Error()
			res.Payload = payload([]any{}, false, res.Warnung, true)
			return res
		}
		if m := ist[HuaweiRegArbeitsmodus]; m != HuaweiEigenverbrauch {
			grund := "Huawei-Arbeitsmodus 47086 = " + strconv.Itoa(m) + " statt 2 (Eigenverbrauch): nur dort gemessen - es wird nicht gesteuert"
			if res.Ausgang == nil {
				res.Payload = payload([]any{}, false, grund, true)
				return res
			}
			e.Folge, e.Schritte, e.Gesperrt, e.Grund = FolgeRueckgabe, HuaweiRueckgabe(), true, grund
			mode = "release"
		}
	}
	neuAusgang := false
	if res.Ausgang == nil && e.Folge != FolgeRueckgabe {
		a := map[int]int{}
		for _, f := range HuaweiFenster {
			if err := lies(f); err != nil {
				res.Warnung = "Huawei: Ausgangswerte nicht lesbar - kein Schreiben: " + err.Error()
				res.Payload = payload([]any{}, false, res.Warnung, true)
				return res
			}
			a[f.Addr] = ist[f.Addr]
		}
		res.Ausgang, neuAusgang = a, true
	}
	if e.Folge == FolgeRueckgabe && res.Ausgang == nil {
		res.Payload = payload([]any{}, false, e.Grund, e.Gesperrt)
		return res
	}
	// 2. The targets of the plan, resolved against the Ausgang.
	type ziel struct {
		f    HuaweiFeld
		wert int
	}
	zieleVon := func(schritte []HuaweiSchritt) []ziel {
		out := make([]ziel, 0, len(schritte))
		for _, s := range schritte {
			w := s.Wert
			if s.AusAusgang {
				w = res.Ausgang[s.Feld.Addr]
			}
			if w < 0 {
				w = 0
			}
			out = append(out, ziel{s.Feld, w})
		}
		return out
	}
	ziele := zieleVon(e.Schritte)
	abweichend := func(zs []ziel) ([]ziel, error) {
		var out []ziel
		for _, z := range zs {
			if _, ok := ist[z.f.Addr]; !ok {
				if err := lies(z.f); err != nil {
					return nil, err
				}
			}
			if absInt(ist[z.f.Addr]-z.wert) > z.f.Tol {
				out = append(out, z)
			}
		}
		return out, nil
	}
	offen, err := abweichend(ziele)
	if err != nil {
		res.Warnung = "Huawei: Register nicht lesbar: " + err.Error()
		res.Payload = payload([]any{}, false, res.Warnung, true)
		return res
	}
	reason, blocked := e.Grund, e.Gesperrt
	// 3. The day budget: a change only while the day keeps room for the way
	// back; the handback always may.
	if len(offen) > 0 && mode != "release" && !TouBudgetAdmits(res.Budget, l.Limit) {
		res.Budget = TouBudgetHeld(res.Budget)
		reason, blocked = "Tagesbudget der Huawei-Steuerung erreicht ("+itoa(res.Budget.Changes)+" von "+itoa(l.Limit)+
			" Planwechseln im Dauerspeicher): Rückgabe an den Wechselrichter bis Mitternacht", true
		if neuAusgang {
			// Nothing written yet today by this session: nothing to give back.
			res.Ausgang = nil
			res.Payload = payload([]any{}, false, reason, blocked)
			return res
		}
		mode = "release"
		ziele = zieleVon(HuaweiRueckgabe())
		if offen, err = abweichend(ziele); err != nil {
			res.Warnung = "Huawei: Register nicht lesbar: " + err.Error()
			res.Payload = payload([]any{}, false, res.Warnung, true)
			return res
		}
	}
	// 4. The Ausgang is stored before the first write - or nothing is written.
	if len(offen) > 0 && neuAusgang && l.Sichern != nil {
		if err := l.Sichern(res.Ausgang); err != nil {
			res.Warnung = "Huawei: Ausgangswerte nicht gesichert - kein Schreiben: " + err.Error()
			res.Ausgang = nil
			res.Payload = payload([]any{}, false, res.Warnung, true)
			return res
		}
	}
	if len(offen) == 0 && neuAusgang {
		res.Ausgang = nil // the device already holds the plan: nothing to give back
	}
	// 5. Write what differs, in the plan's order.
	for _, z := range offen {
		if err := spur.Schreibe(ctx, z.f.Addr, z.f.Worte, z.wert); err != nil {
			res.Warnung = "Huawei: Schreiben " + strconv.Itoa(z.f.Addr) + " fehlgeschlagen: " + err.Error()
			break
		}
		res.Geschrieben = true
	}
	if res.Geschrieben {
		res.Budget = TouBudgetCounted(res.Budget)
	}
	// 6. Read back every target.
	regs := []any{}
	alleGehalten := true
	for _, z := range ziele {
		r := Obj{"role": z.f.Rolle, "fc": 3.0, "addr": float64(z.f.Addr), "commanded_raw": float64(z.wert)}
		v, err := spur.Lies(ctx, z.f.Addr, z.f.Worte)
		switch {
		case err != nil:
			r["actual_raw"], r["match"], r["verdict"] = nil, false, VerdictUnread
			alleGehalten = false
		case absInt(v-z.wert) <= z.f.Tol:
			r["actual_raw"], r["match"], r["verdict"] = float64(v), true, VerdictHeld
		default:
			r["actual_raw"], r["match"], r["verdict"] = float64(v), false, VerdictMismatch
			alleGehalten = false
		}
		regs = append(regs, r)
	}
	if mode == "release" && alleGehalten {
		res.Ausgang = nil // handed back: the next control captures anew
	}
	p := payload(regs, res.Geschrieben, reason, blocked)
	p["mode"] = mode
	p["folge"] = e.Folge
	if mode == "release" {
		p["folge"] = FolgeRueckgabe
	}
	res.Payload = p
	return res
}

// HuaweiGesperrtPayload is the readback of a tick that does not touch the
// device (blocked, nothing to give back): no register, the reason.
func HuaweiGesperrtPayload(e HuaweiEntscheid, family string, sp Obj, now time.Time) Obj {
	p := Obj{"ts": isoMillis(now), "family": family, "source": sourceOf(sp), "control_enabled": e.ControlEnabled,
		"certified": e.Certified, "mode": "normal", "control_path": PfadHuawei, "registers": []any{},
		"wrote": false, "blocked": e.Gesperrt, "reason": e.Grund}
	if v := get(sp, "slot_start"); !isUndef(v) {
		p["slot_start"] = v
	}
	return p
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// HuaweiAusgangObj is the durable record of an Ausgang (the 'file' context).
func HuaweiAusgangObj(a map[int]int, ip string, port, unit int, now time.Time) Obj {
	regs := Obj{}
	for k, v := range a {
		regs[strconv.Itoa(k)] = float64(v)
	}
	return Obj{"ip": ip, "port": float64(port), "unit_id": float64(unit), "regs": regs, "captured_at": isoMillis(now)}
}

// HuaweiAusgangAus reads a durable record back; nil when it is not whole
// (every window register a non-negative integer).
func HuaweiAusgangAus(o Obj) map[int]int {
	regs := obj(get(o, "regs"))
	if regs == nil {
		return nil
	}
	out := map[int]int{}
	for _, f := range HuaweiFenster {
		v := get(regs, strconv.Itoa(f.Addr))
		if !isFiniteNum(v) || num(v) < 0 || num(v) != math.Trunc(num(v)) {
			return nil
		}
		out[f.Addr] = int(num(v))
	}
	return out
}

// HuaweiBudgetObj is the durable record of the Huawei day budget.
func HuaweiBudgetObj(b TouBudget) Obj { return budgetObj(b) }
