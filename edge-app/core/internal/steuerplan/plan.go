// Package steuerplan is the Go twin of the Node-RED WRITE side of the Docker
// box (edge-app/nodered/inverter-control-routing.js and the modules the
// control plan node embeds: deye-charge-side.js, deye-grid-target.js,
// deye-tou-budget.js, unplanned-load-native.js, readback-verify.js). It turns
// the retained inverter selection and the core's guard-clamped setpoint into a
// pure WRITE PLAN; Layer 1 of Edge Light executes it.
//
// It never performs I/O and authorizes nothing physical. Every gate of the
// JavaScript original binds unchanged: the core's control_enabled, the family
// certification or the device's First-Light grant, the native certificates,
// the deliberate-fallback gate of the ToU path and the power-scale refusal.
// Layer 1 adds one gate in front of all of them (the Edge Light release of the
// family, layer1/steuern.go) - this package never widens anything.
//
// Shared vectors (edge-app/nodered/steuerplan-vectors.json, written by
// steuerplan-vectors.gen.js from the JavaScript itself) hold both sides to the
// same decisions.
package steuerplan

// WriteOp is one planned register write.
type WriteOp struct {
	Role         string         `json:"role"`
	FC           int            `json:"fc"`
	Addr         int            `json:"addr"`
	Value        int            `json:"value"`
	Encode       map[string]any `json:"encode,omitempty"`
	DwellS       int            `json:"dwell_s"`
	MinChange    int            `json:"min_change"`
	Always       bool           `json:"always,omitempty"`
	ReassertS    int            `json:"reassert_s,omitempty"`
	BenchPending bool           `json:"bench_pending,omitempty"`
}

// ReadOp is one read: a readback (with expect and tolerance), a read spec of
// a precondition or a probe (with count), or an observation (neither).
type ReadOp struct {
	Role      string         `json:"role"`
	FC        int            `json:"fc,omitempty"`
	Addr      int            `json:"addr"`
	Count     int            `json:"count,omitempty"`
	Expect    *int           `json:"expect,omitempty"`
	Tolerance *float64       `json:"tolerance,omitempty"`
	Decode    map[string]any `json:"decode,omitempty"`
}

// ProbeSpec is what the executor reads to classify a Deye's control capability.
type ProbeSpec struct {
	Reads []ReadOp `json:"reads"`
}

// SnapshotPlan names the installer registers the executor captures before the
// first ToU write, and the six program start times for the N2 check.
type SnapshotPlan struct {
	Registers    []SnapshotReg `json:"registers"`
	ProgramTimes []int         `json:"programTimes"`
}

// SnapshotReg is one captured register.
type SnapshotReg struct {
	Role string `json:"role"`
	Addr int    `json:"addr"`
}

// Plan is one write plan, the shape the JavaScript planners return. A field is
// set exactly when the original sets it; nil and empty mean absent.
type Plan struct {
	Adapter              string        `json:"adapter"`
	Family               string        `json:"family"`
	Tier                 *int          `json:"tier,omitempty"`
	Mode                 string        `json:"mode,omitempty"`
	Supported            *bool         `json:"supported,omitempty"`
	ControlPath          string        `json:"controlPath,omitempty"`
	Target               string        `json:"target,omitempty"`
	Connection           Obj           `json:"connection,omitempty"`
	Certified            bool          `json:"certified"`
	ControlEnabled       bool          `json:"controlEnabled"`
	Calibration          *bool         `json:"calibration,omitempty"`
	Remote               Obj           `json:"remote,omitempty"`
	PvLimitSupported     *bool         `json:"pvLimitSupported,omitempty"`
	PvLimitKw            *float64      `json:"pvLimitKw,omitempty"`
	CapabilityProbe      *ProbeSpec    `json:"capabilityProbe,omitempty"`
	Writes               []WriteOp     `json:"writes"`
	Readbacks            []ReadOp      `json:"readbacks"`
	Planned              []WriteOp     `json:"planned,omitempty"`
	Observations         []ReadOp      `json:"observations,omitempty"`
	PlannedReadbacks     []ReadOp      `json:"plannedReadbacks,omitempty"`
	Preconditions        []ReadOp      `json:"preconditions,omitempty"`
	GridChargeProof      *ReadOp       `json:"gridChargeProof,omitempty"`
	ProofKind            string        `json:"proofKind,omitempty"`
	NativeIntent         *string       `json:"nativeIntent,omitempty"`
	Certificate          Obj           `json:"certificate,omitempty"`
	Candidate            string        `json:"candidate,omitempty"`
	Heartbeat            *bool         `json:"heartbeat,omitempty"`
	CurtailsOwnPv        *bool         `json:"curtailsOwnPv,omitempty"`
	Pilot                Obj           `json:"pilot,omitempty"`
	SetpointUnits        *int          `json:"setpointUnits,omitempty"`
	SetpointClamped      *bool         `json:"setpointClamped,omitempty"`
	GridTest             Obj           `json:"gridTest,omitempty"`
	GridTarget           Obj           `json:"gridTarget,omitempty"`
	Reason               string        `json:"reason,omitempty"`
	PvLimitNote          string        `json:"pvLimitNote,omitempty"`
	GridTargetNote       string        `json:"gridTargetNote,omitempty"`
	Blocked              bool          `json:"blocked,omitempty"`
	PathHold             string        `json:"pathHold,omitempty"`
	TouBudgetHold        bool          `json:"touBudgetHold,omitempty"`
	PowerScaleConfirmed  *bool         `json:"powerScaleConfirmed,omitempty"`
	PowerScaleSource     string        `json:"powerScaleSource,omitempty"`
	PowerScaleSuppressed bool          `json:"powerScaleSuppressed,omitempty"`
	SnapshotPlan         *SnapshotPlan `json:"snapshotPlan,omitempty"`
	// Set by the plan node beside the module's plan (never by controlRoute).
	NativePreconditions   []ReadOp `json:"nativePreconditions,omitempty"`
	NativeGridChargeProof *ReadOp  `json:"nativeGridChargeProof,omitempty"`
}

func ptr[T any](v T) *T { return &v }

// readback is a ReadOp with expect and tolerance.
func readback(role string, addr, expect int, tol float64) ReadOp {
	return ReadOp{Role: role, FC: 3, Addr: addr, Expect: ptr(expect), Tolerance: ptr(tol)}
}

// execCopy is `{ ...w }` minus bench_pending: what the executor runs.
func execCopy(ws []WriteOp) []WriteOp {
	out := make([]WriteOp, len(ws))
	for i, w := range ws {
		w.BenchPending = false
		w.Encode = cloneMap(w.Encode)
		out[i] = w
	}
	return out
}

func cloneMap(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	return clone(m).(map[string]any)
}

func copyReads(rs []ReadOp) []ReadOp {
	out := make([]ReadOp, len(rs))
	copy(out, rs)
	return out
}
