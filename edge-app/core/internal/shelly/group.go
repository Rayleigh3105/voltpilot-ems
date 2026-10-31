package shelly

// The HEATING-ROD output set (Heizstab-Konzept V1, data/vp-heizstab-konzept,
// decided 31.10.2026): ONE device over several switch outputs - a Shelly Pro 3
// with one heating element per phase - switched in STAGES. A stage is the
// NUMBER of outputs on together (1, 2 or 3 phases); "all together" (option B)
// is the top stage, "just one phase" the lowest. The contract is
// docs/contracts/v2/heizstab-shelly.md, the shared vectors are
// docs/contracts/v2/heizstab-stufen-vectors.json (Go here, Java for the driver
// block and the ledger).
//
// Why per-phase switching is allowed at all: only a rod in STAR WITH N puts
// 230 V across an open contact; delta or star without N would put 345-400 V
// across the Pro 3's 240-V contacts while the outputs switch one after the
// other (one HTTP request each, no multi-switch call in Gen2). The setup asks
// for the connection and never builds an output set for anything but star
// with N - the box only sees the result.
//
// The rules this file pins (pure, no I/O):
//
//   - Never more than commanded: a bare setpoint picks the HIGHEST allowed
//     stage whose kW fits (the restrict-only discipline of PlanFor), judged
//     with the LARGEST elements so an unequal rod can never overshoot; an
//     explicit on = the top allowed stage; stale = OFF (§4.2).
//   - Stage 1/2 rotate the start output once per day (HZ-3 = A: L1 -> L2 ->
//     L3), but a run never swaps phases mid-way: outputs already on are kept.
//   - A deviation does NOT lock (HZ-4 = B): an output that did not turn on is
//     simply written again at the next re-assert; an output that is on
//     although it should be off gets OFF at once and COUNTS toward the stage
//     while it stays on, so the others never push the sum above the command.
//   - The confirmed stage is what the device reports, never what was asked;
//     one unread output makes it unknown, never "off".

import (
	"fmt"
	"math"
)

// Stage-1 phase choice (HZ-3).
const (
	// RotationDaily moves the start output of a partial stage by one each
	// day (L1 -> L2 -> L3), so switching cycles and heating hours spread over
	// all elements and relays. The default.
	RotationDaily = "daily"
	// RotationFixed always starts from the first output of the set.
	RotationFixed = "fixed"
)

// MaxGroupOutputs bounds an output set: a Shelly has at most four switch
// outputs (Pro 4PM).
const MaxGroupOutputs = 4

// MaxPartialElementKw is the largest element that may run without its
// siblings: VDE-AR-N 4100 limits the unbalanced load to 4.6 kVA, and one or
// two of three equal elements unbalance the phases by one element.
const MaxPartialElementKw = 4.6

// Reason strings of the stage path (German, surface-verbatim).
const (
	reasonBelowLowestStage = "Sollwert unter der kleinsten Stufe - alle Ausgänge bleiben aus (nie mehr liefern als befohlen)"
	reasonStuckCounted     = "Ein Ausgang ist an, obwohl er aus sein soll - er bekommt AUS und zählt bis dahin zur Stufe"
)

// IsGroup reports whether the config describes ONE device over an output set
// (the stage path) instead of the single-output path (Channel).
func (c Config) IsGroup() bool { return len(c.Channels) > 0 }

// ChannelsError validates only the outputs of a set (count, range, no
// duplicate) - all a READ needs; "" = valid or not a set.
func ChannelsError(chs []int) string {
	if len(chs) > MaxGroupOutputs {
		return "Ein Gerät umfasst höchstens vier Ausgänge."
	}
	seen := map[int]bool{}
	for _, ch := range chs {
		if ch < 0 || ch > 3 {
			return "Der Schaltkanal muss zwischen 0 und 3 liegen."
		}
		if seen[ch] {
			return fmt.Sprintf("Ausgang %d steht zweimal in der Ausgangsmenge.", ch)
		}
		seen[ch] = true
	}
	return ""
}

// GroupError validates an output set for SWITCHING; "" = valid (or not a set
// at all). The sentence is the honest German refusal for the surfaces.
func (c Config) GroupError() string {
	n := len(c.Channels)
	if n == 0 {
		return ""
	}
	if msg := ChannelsError(c.Channels); msg != "" {
		return msg
	}
	if len(c.OutputKw) != n {
		return "Für jeden Ausgang fehlt die Leistung seines Heizelements (kW)."
	}
	for _, kw := range c.OutputKw {
		if math.IsNaN(kw) || math.IsInf(kw, 0) || kw <= 0 {
			return "Die Leistung jedes Heizelements muss größer als 0 sein."
		}
	}
	prev := 0
	for _, s := range c.stages() {
		if s < 1 || s > n || s <= prev {
			return "Die Stufen müssen aufsteigend zwischen 1 und der Zahl der Ausgänge liegen."
		}
		prev = s
	}
	if c.stages()[0] < n {
		for _, kw := range c.OutputKw {
			if kw > MaxPartialElementKw+1e-9 {
				return "Einzelne Phasen gibt es nur mit Heizelementen bis 4,6 kW (Schieflast) - " +
					"dieser Heizstab schaltet nur alle Ausgänge zusammen."
			}
		}
	}
	switch c.Rotation {
	case "", RotationDaily, RotationFixed:
	default:
		return "Unbekannte Phasenwahl für Stufe 1."
	}
	return ""
}

// stages is the allowed outputs-on counts, ascending; absent = only all
// outputs together (option B).
func (c Config) stages() []int {
	if len(c.Stages) == 0 {
		return []int{len(c.Channels)}
	}
	return c.Stages
}

// stageCeilingKw is the most a stage of s outputs can draw: the s LARGEST
// elements. Restrict-only judges against it, so whichever outputs the
// rotation picks, the stage never delivers more than commanded.
func (c Config) stageCeilingKw(s int) float64 {
	kws := append([]float64(nil), c.OutputKw...)
	// tiny n (<= 4): selection sort, descending
	for i := range kws {
		for j := i + 1; j < len(kws); j++ {
			if kws[j] > kws[i] {
				kws[i], kws[j] = kws[j], kws[i]
			}
		}
	}
	sum := 0.0
	for i := 0; i < s && i < len(kws); i++ {
		sum += kws[i]
	}
	return sum
}

// GroupPrev is what the executor last commanded and last read, per output
// (index into Config.Channels). Empty slices = nothing known yet (first pass,
// restart): the selection then just keeps outputs that are on.
type GroupPrev struct {
	Commanded []bool
	Read      []*bool
}

func (p GroupPrev) on(i int) bool {
	return i < len(p.Read) && p.Read[i] != nil && *p.Read[i]
}

// disobeying: read ON although the last write commanded it OFF.
func (p GroupPrev) disobeying(i int) bool {
	return i < len(p.Commanded) && !p.Commanded[i] && p.on(i)
}

// GroupPlan is the pure write plan of the stage path.
type GroupPlan struct {
	Adapter        string
	Target         string
	Certified      bool
	ControlEnabled bool
	// Mode is "on" | "off" | "idle" (no neutral, like Plan).
	Mode string
	// Channels is the output set the per-output slices index into.
	Channels []int
	// Stage is the commanded number of outputs on (0 = off).
	Stage int
	// StageKw is the power the plan allows to run: the elements of the
	// outputs it switches on plus the ones counted because they are stuck on.
	StageKw float64
	// Targets is the commanded state per output (index into Channels).
	Targets []bool
	// Counted marks outputs that are on although commanded off: they get OFF
	// and count toward the stage while they stay on (HZ-4 = B).
	Counted []bool
	TimerS  int
	Write   bool
	Reason  string
}

// GroupStage maps the arbitrated command onto the stage (number of outputs).
// OnOff false -> off; a setpoint -> the highest allowed stage that fits it
// (restrict-only; an explicit on with a setpoint is judged by the setpoint);
// OnOff true alone -> the top allowed stage; stale/nothing -> fail-safe off.
func GroupStage(cfg Config, cmd Command) (stage int, reason string) {
	hasSetpoint := cmd.SetpointKw != nil && !math.IsNaN(*cmd.SetpointKw) && !math.IsInf(*cmd.SetpointKw, 0)
	stages := cfg.stages()
	switch {
	case cmd.Stale || (cmd.OnOff == nil && !hasSetpoint):
		return 0, reasonFailsafeOff
	case cmd.OnOff != nil && !*cmd.OnOff:
		return 0, ""
	case hasSetpoint:
		sp := *cmd.SetpointKw
		if sp <= onKwThreshold {
			return 0, ""
		}
		best := 0
		for _, s := range stages {
			if cfg.stageCeilingKw(s) <= sp*(1+1e-6)+1e-9 {
				best = s
			}
		}
		if best == 0 {
			return 0, reasonBelowLowestStage
		}
		return best, ""
	default: // explicit on without a setpoint: the top allowed stage
		return stages[len(stages)-1], ""
	}
}

// SelectOutputs picks the outputs of a stage. day is the rotation day index
// (UTC days since the epoch). Outputs read ON keep priority (a run never swaps
// phases), stuck outputs count first; the rest follow the rotation order.
func SelectOutputs(cfg Config, stage int, prev GroupPrev, day int) (targets, counted []bool) {
	n := len(cfg.Channels)
	targets, counted = make([]bool, n), make([]bool, n)
	if stage <= 0 {
		for i := 0; i < n; i++ {
			counted[i] = prev.disobeying(i)
		}
		return targets, counted
	}
	if stage >= n {
		for i := range targets {
			targets[i] = true
		}
		return targets, counted
	}
	start := 0
	if cfg.Rotation != RotationFixed {
		start = ((day % n) + n) % n
	}
	order := make([]int, n)
	for k := range order {
		order[k] = (start + k) % n
	}
	avail := stage
	for i := 0; i < n; i++ {
		if prev.disobeying(i) {
			counted[i] = true
			avail--
		}
	}
	for _, i := range order { // outputs already (legitimately) on first
		if avail > 0 && !counted[i] && prev.on(i) {
			targets[i] = true
			avail--
		}
	}
	for _, i := range order {
		if avail > 0 && !counted[i] && !targets[i] {
			targets[i] = true
			avail--
		}
	}
	return targets, counted
}

// PlanGroupFor maps config + command (+ what the last pass wrote and read)
// onto the pure stage plan.
func PlanGroupFor(cfg Config, cmd Command, prev GroupPrev, day int) GroupPlan {
	if cfg.IP == "" {
		return GroupPlan{Adapter: Communication, Mode: "idle", Reason: reasonNoIP}
	}
	if msg := cfg.GroupError(); msg != "" {
		return GroupPlan{Adapter: Communication, Target: cfg.HostPort(), Mode: "idle", Reason: msg}
	}
	certified := true // the driver-level verdict, see control.go
	controlEnabled := cmd.ControlEnabled && certified
	stage, reason := GroupStage(cfg, cmd)
	targets, counted := SelectOutputs(cfg, stage, prev, day)
	p := GroupPlan{
		Adapter: Communication, Target: cfg.HostPort(), Certified: certified,
		ControlEnabled: controlEnabled, Channels: append([]int(nil), cfg.Channels...),
		Stage: stage, Targets: targets, Counted: counted,
		Reason: reason,
	}
	p.Mode = "off"
	if stage > 0 {
		p.Mode = "on"
		p.TimerS = cfg.onTimerS()
	}
	stuck := false
	for i := range targets {
		if targets[i] || counted[i] {
			p.StageKw += cfg.OutputKw[i]
		}
		stuck = stuck || counted[i]
	}
	p.StageKw = math.Round(p.StageKw*1000) / 1000
	if stuck && p.Reason == "" {
		p.Reason = reasonStuckCounted
	}
	if p.Mode == "on" && p.Reason == "" {
		if p.TimerS > 0 {
			p.Reason = reasonTimerArmed
		} else {
			p.Reason = reasonTimerNoGuard
		}
	}
	if controlEnabled {
		p.Write = true
	} else if p.Reason == "" || p.Reason == reasonTimerArmed || p.Reason == reasonTimerNoGuard {
		p.Reason = reasonKillSwitch
	}
	return p
}

// GroupState is one read of every output of the set (index into Channels).
// PowerKw is set only when EVERY output measures (the sum of real values) -
// a partial sum would claim a total nobody measured.
type GroupState struct {
	Outputs []*bool
	PowerKw *float64
}

// GroupVerdict is the evaluated readback of the stage path.
type GroupVerdict struct {
	Registers []Register
	AllMatch  *bool // nil when nothing was written (readback only)
	// Outputs is the read state per output (the next pass's GroupPrev.Read).
	Outputs []*bool
	// ConfirmedStage / ConfirmedKw: outputs on and the sum of their elements,
	// as the DEVICE reports them. nil when any output is unread - unknown is
	// never "off".
	ConfirmedStage *int
	ConfirmedKw    *float64
	PowerKw        *float64
}

// On is the rod-level fact "heats" (any output on); nil while unknown.
func (v GroupVerdict) On() *bool {
	if v.ConfirmedStage == nil {
		return nil
	}
	on := *v.ConfirmedStage > 0
	return &on
}

// EvalGroupReadback compares the commanded state per output to the read one.
func (p GroupPlan) EvalGroupReadback(cfg Config, ident Identity, st GroupState) GroupVerdict {
	n := len(cfg.Channels)
	v := GroupVerdict{Outputs: make([]*bool, n), PowerKw: st.PowerKw}
	stage, kw, known := 0, 0.0, true
	for i := 0; i < n; i++ {
		if i < len(st.Outputs) && st.Outputs[i] != nil {
			on := *st.Outputs[i]
			v.Outputs[i] = &on
			if on {
				stage++
				kw += cfg.OutputKw[i]
			}
		} else {
			known = false
		}
	}
	if known {
		kw = math.Round(kw*1000) / 1000
		v.ConfirmedStage, v.ConfirmedKw = &stage, &kw
	}
	if !p.Write || len(p.Targets) != n {
		return v
	}
	all := true
	for i := 0; i < n; i++ {
		commanded := 0
		if p.Targets[i] {
			commanded = 1
		}
		var actual *int
		match := false
		if v.Outputs[i] != nil {
			a := 0
			if *v.Outputs[i] {
				a = 1
			}
			actual = &a
			match = a == commanded
		}
		ch := cfg.Channels[i]
		v.Registers = append(v.Registers, Register{Role: "relay", Key: relayKey(ident),
			Channel: &ch, Commanded: commanded, Actual: actual, Match: match})
		all = all && match
	}
	v.AllMatch = &all
	return v
}
