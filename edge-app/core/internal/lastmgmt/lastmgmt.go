// Package lastmgmt is the PURE load-management core of the OCPP charge-point
// feature (Konzept `vp-ocpp-lastmgmt-konzept-w4` §4.1): given a site charging
// budget and the running charge sessions, it decides how many kW each session
// may draw. It has no I/O, no clock of its own (every time-dependent function
// takes its `now`) and no OCPP import — the `Tagesprotokoll`/`FleetPflege`/
// `otaapply` discipline of the house, so every rule below is provable without
// a websocket, a station or a container.
//
// The four rules, and why each exists:
//
//   - WATER FILLING with floors: everyone charging shares the budget equally,
//     clamped to their own [min, max]. A head that cannot use its share hands
//     the rest back (a 3.7 kW car on a 50 kW share does not waste 46 kW).
//   - PAUSE INSTEAD OF STARVE: below a session's minimum nothing is allocated
//     at all. This is the D4 `power_ranges_kw` discipline on n vehicles — a
//     value between 0 and the minimum is not a slower charge, it is a charge
//     that never starts, so the budget would be spent on nothing.
//   - ROTATION: when the budget cannot serve everyone, who waits CHANGES on a
//     fixed cadence, so no vehicle stands forever.
//   - VORRANG (Captain decision): a priority charge point is served to its
//     full demand FIRST, and the rest share what remains — fairly, including
//     rotation. It is a rank ABOVE the fairness, never a bypass of a limit.
//
// ⚠ Mindestleistung and Ausfall-Profil are TWO different quantities and are
// kept apart on purpose (Mockups §2.8). The Mindestleistung (MinKw here) is
// ALLOCATION POLICY: below it we pause rather than starve. The Ausfall-Profil
// (SafeDefault below) is EMERGENCY OPERATION: what a station is allowed to do
// when the box is silent. Setting them equal makes the fallback arithmetic
// impossible — the emergency share must be small enough that ALL connectors
// running it simultaneously still fit under the connection limit, while the
// minimum must be large enough to actually move a car.
package lastmgmt

import (
	"math"
	"sort"
	"time"
)

// Reason vocabulary. Machine-readable, so no surface ever has to search a
// German sentence for keywords (the `target_verdict`-next-to-`state` rule);
// the German text lives next to it in Text() and nowhere else.
const (
	// ReasonCharging: the session has an allocation and may draw it.
	ReasonCharging = "laedt"
	// ReasonBudget: the budget cannot serve everyone right now; this session
	// waits its turn. NextTurnAt says when, when that is computable.
	ReasonBudget = "wartet_budget"
	// ReasonNoBudget: there is no charging budget at all (not configured, or
	// the building has eaten it). Named separately because the operator lever
	// is a different one.
	ReasonNoBudget = "kein_budget"
	// ReasonBelowMinimum: even the WHOLE budget is below this session's own
	// minimum useful power. Not a queue problem — the site is too small for
	// this charge point, and saying "wait" would be a promise nobody can keep.
	ReasonBelowMinimum = "unter_mindestleistung"
)

// Text renders the customer-facing German sentence for a reason. Unknown
// reasons yield "" — a word we do not understand must not become a sentence.
func Text(reason string) string {
	switch reason {
	case ReasonCharging:
		return "lädt"
	case ReasonBudget:
		return "wartet — Budget vergeben"
	case ReasonNoBudget:
		return "wartet — zurzeit steht keine Ladeleistung zur Verfügung"
	case ReasonBelowMinimum:
		return "wartet — die verfügbare Leistung reicht für diesen Ladepunkt nicht aus"
	}
	return ""
}

// Session is ONE claimant on the budget: one connector with a live
// transaction. One connector = one vehicle (Konzept §3.5).
type Session struct {
	// Key identifies the claimant stably across decisions
	// ("<chargePointId>#<connectorId>").
	Key string
	// Priority marks a Vorrang charge point.
	Priority bool
	// MinKw is the minimum useful charging power. Below it we pause instead of
	// allocating: a value between 0 and the minimum starts no charge at all.
	MinKw float64
	// MaxKw is this connector's ceiling (station rating, cable, operator cap).
	MaxKw float64
	// Since is when this session became a claimant. It is the fairness anchor:
	// the queue order is by arrival, then rotated.
	Since time.Time
}

// Settings are the operator-maintained facts of the site. In Stufe 0+1 they
// are STATIC (the box's own setup surface); Stufe 2 replaces HouseReserveKw
// with the measured connection point, which changes nothing here.
type Settings struct {
	// GridLimitKw is the Anschlussgrenze — the contractual/physical ceiling at
	// the connection point. 0 = not configured, and then nothing charges: a
	// budget we cannot justify is not a budget.
	GridLimitKw float64
	// HouseReserveKw is statically held back for the building. Stufe 2 swaps
	// this for the measured house load.
	HouseReserveKw float64
	// MarginPct is the engineering margin never allocated (Konzept §4.2): OCPP
	// is a seconds-scale loop and vehicles follow it slowly, so the budget is
	// deliberately not spent to the last kW. Default DefaultMarginPct.
	MarginPct float64
	// MinPowerKw is the site-wide Mindestleistung (see the package doc).
	MinPowerKw float64
	// RotationPeriod is how long a waiting vehicle waits before the queue turns.
	RotationPeriod time.Duration
	// MaxHouseLoadKw is the HIGHEST building load known for this site. It is
	// used for the Ausfall-Profil arithmetic (see SafeDefault) and, since
	// Stufe 2, as the blind assumption of the dynamic budget (see budget.go).
	MaxHouseLoadKw float64
	// StaticBudget switches the Stufe-2 dynamic budget OFF for this site: the
	// budget then comes from HouseReserveKw alone, whatever the connection
	// point measures.
	//
	// ⚠ The flag is deliberately NEGATIVE so its zero value is the intended
	// default ("use the measurement when there is one"). It needs no pointer
	// and no WithDefaults entry, so an operator's explicit "off" can never be
	// overwritten by a defaulting pass — and a site with no measurement is
	// byte-identical either way (budget.go's BudgetStatic branch).
	StaticBudget bool
}

// Defaults. Every one of them is a starting point the operator may move; none
// of them is a physical fact.
const (
	DefaultMarginPct      = 10.0
	DefaultRotationPeriod = 15 * time.Minute
	// DefaultMinChangeKw / DefaultMinHoldTime pace the profile writes: a
	// station's charging profile is not free to rewrite (the Deye EEPROM
	// lesson, generalised — never hammer a device).
	DefaultMinChangeKw = 1.0
	DefaultMinHoldTime = 30 * time.Second
)

// WithDefaults fills the unset knobs. It never invents a GridLimitKw: without
// a configured connection limit the honest budget is zero.
func (s Settings) WithDefaults() Settings {
	if s.MarginPct <= 0 || s.MarginPct >= 100 {
		s.MarginPct = DefaultMarginPct
	}
	if s.RotationPeriod <= 0 {
		s.RotationPeriod = DefaultRotationPeriod
	}
	if s.MinPowerKw < 0 {
		s.MinPowerKw = 0
	}
	return s
}

// BudgetKw is the charging budget.
//
// ⚠ The order of operations is the approved one and it is NOT commutative:
// the engineering margin comes off the CONNECTION LIMIT first, and only what
// is left after the building gets shared out (Mockups §1: 277 kW → nie über
// 249 kW geplant → Ladebudget 249 − 167 = 82 kW). Applying the margin to the
// remainder instead would hand the building's share of the margin back to the
// cars — on the mockups' own scenario that is 99 kW instead of 82 kW, i.e. a
// third car charging that must not be. The margin protects the CONNECTION, so
// it is taken at the connection.
func (s Settings) BudgetKw() float64 {
	s = s.WithDefaults()
	return budgetUnder(s.GridLimitKw, s)
}

// Allocation is what ONE session may draw.
type Allocation struct {
	Key    string  `json:"key"`
	Kw     float64 `json:"kw"`
	Paused bool    `json:"paused"`
	Reason string  `json:"reason"`
	// NextTurnAt is an ESTIMATE of when a waiting session gets its turn,
	// computed from the rotation cadence and the current queue. Zero = not
	// computable (the queue would have to change first) — never a made-up time.
	NextTurnAt time.Time `json:"next_turn_at,omitzero"`
	// ChangedAt is when this VALUE last changed. It carries the pacing across
	// decisions; the executor refreshes the profile on its own cadence
	// regardless (the dead-man's switch needs the refresh).
	ChangedAt time.Time `json:"changed_at,omitzero"`
}

// Plan is one decision over the whole site.
type Plan struct {
	// BudgetKw is the usable budget the decision worked with.
	BudgetKw float64 `json:"budget_kw"`
	// AllocatedKw is the sum of the allocations. It is <= BudgetKw by
	// construction; the difference is head room, not an error.
	AllocatedKw float64      `json:"allocated_kw"`
	Allocations []Allocation `json:"allocations"`
}

// Get returns the allocation for a key.
func (p Plan) Get(key string) (Allocation, bool) {
	for _, a := range p.Allocations {
		if a.Key == key {
			return a, true
		}
	}
	return Allocation{}, false
}

// Pacing bounds how often an allocation's VALUE may move.
type Pacing struct {
	// MinChangeKw: a smaller increase is not worth a profile write.
	MinChangeKw float64
	// MinHold: how long a value is held before a small increase is accepted
	// anyway.
	MinHold time.Duration
}

// WithDefaults fills the unset pacing knobs.
func (p Pacing) WithDefaults() Pacing {
	if p.MinChangeKw <= 0 {
		p.MinChangeKw = DefaultMinChangeKw
	}
	if p.MinHold <= 0 {
		p.MinHold = DefaultMinHoldTime
	}
	return p
}

// Input is everything one decision needs.
type Input struct {
	Settings Settings
	Sessions []Session
	Pacing   Pacing
	// Previous is the last decision, for pacing continuity. nil on the first.
	Previous *Plan
	// BudgetKw overrides the budget derived from Settings. It is how Stufe 2
	// hands in the MEASURED budget (see budget.go) and how the executor
	// subtracts the share it holds back for stations it cannot reach. nil =
	// derive it from the settings, which is exactly Stufe 1.
	BudgetKw *float64
	Now      time.Time
}

// Decide is THE allocation. Deterministic: the same input yields the same plan,
// down to the ordering.
func Decide(in Input) Plan {
	set := in.Settings.WithDefaults()
	pacing := in.Pacing.WithDefaults()
	budget := set.BudgetKw()
	if in.BudgetKw != nil {
		budget = round3(math.Max(0, *in.BudgetKw))
	}

	plan := Plan{BudgetKw: budget, Allocations: []Allocation{}}
	if len(in.Sessions) == 0 {
		return plan
	}

	// 1) A stable base order: arrival first, then key. Everything downstream
	//    is a permutation of this, so two boxes with the same facts decide the
	//    same way.
	sessions := append([]Session(nil), in.Sessions...)
	sort.Slice(sessions, func(i, j int) bool {
		if !sessions[i].Since.Equal(sessions[j].Since) {
			return sessions[i].Since.Before(sessions[j].Since)
		}
		return sessions[i].Key < sessions[j].Key
	})

	// 2) Vorrang is a RANK, not a bypass: priority sessions keep their arrival
	//    order among themselves and simply sit ahead of everyone else.
	sort.SliceStable(sessions, func(i, j int) bool {
		return sessions[i].Priority && !sessions[j].Priority
	})

	// 3) Rotation turns the NON-priority tail so a waiting vehicle eventually
	//    gets to the front. It is a no-op whenever everyone fits.
	prio := 0
	for _, s := range sessions {
		if s.Priority {
			prio++
		}
	}
	tail := sessions[prio:]
	epoch := rotationEpoch(in.Now, set.RotationPeriod)
	queue := append([]Session(nil), sessions[:prio]...)
	queue = append(queue, rotate(tail, epoch)...)

	// 4) Vorrang is served FIRST and to its FULL demand, then the rest share
	//    what is left (Captain decision; Mockups §2b wording: "Vorrang-Säulen
	//    bekommen zuerst ihre volle Leistung — alle anderen teilen sich fair
	//    den Rest"). It is a rank above the fairness, never a bypass of a
	//    limit: the priority group is itself water-filled and itself capped by
	//    the budget, so a Vorrang station can no more overshoot the connection
	//    than any other. The consequence — a big Vorrang station makes the
	//    others wait longer — is real, and the surface is required to say so.
	prioQ, tailQ := queue[:prio], queue[prio:]

	give := map[string]float64{}
	pausedReason := map[string]string{}
	rest := budget

	admit := func(group []Session, avail float64) ([]Session, float64) {
		var adm []Session
		for _, s := range group {
			minKw := effectiveMin(s, set)
			switch {
			case budget <= 0:
				pausedReason[s.Key] = ReasonNoBudget
			case budget+1e-9 < minKw:
				// Not a queue problem: even the WHOLE budget is below this
				// session's minimum. Saying "wait" would promise a turn that
				// never comes.
				pausedReason[s.Key] = ReasonBelowMinimum
			case avail+1e-9 < minKw:
				pausedReason[s.Key] = ReasonBudget
			default:
				avail -= minKw
				give[s.Key] = minKw
				adm = append(adm, s)
				continue
			}
		}
		return adm, avail
	}

	admPrio, rest := admit(prioQ, rest)
	rest = waterFill(admPrio, give, rest)
	admTail, rest := admit(tailQ, rest)
	rest = waterFill(admTail, give, rest)
	_ = rest

	// 5) Pacing: hold a value that only moved a little, unless enough time has
	//    passed. A DECREASE is never paced — it protects the connection, and a
	//    protection you postpone is not one. A pause/resume is a decrease or
	//    the thing the customer is waiting for; both go through at once.
	total := 0.0
	for _, s := range queue {
		a := Allocation{Key: s.Key}
		if kw, ok := give[s.Key]; ok {
			a.Kw = round3(kw)
			a.Reason = ReasonCharging
		} else {
			a.Paused = true
			a.Kw = 0
			a.Reason = pausedReason[s.Key]
			if a.Reason == "" {
				a.Reason = ReasonBudget
			}
			if a.Reason == ReasonBudget {
				a.NextTurnAt = nextTurn(s.Key, tailQ, len(admTail), in.Now, set.RotationPeriod)
			}
		}
		a = pace(a, in.Previous, pacing, in.Now)
		total += a.Kw
		plan.Allocations = append(plan.Allocations, a)
	}
	sort.Slice(plan.Allocations, func(i, j int) bool { return plan.Allocations[i].Key < plan.Allocations[j].Key })
	plan.AllocatedKw = round3(total)
	return plan
}

// effectiveMin is the session's own minimum, defaulting to the site-wide one
// and NEVER above the connector's own ceiling.
//
// ⚠ The clamp is the point: a site-wide Mindestleistung of 30 kW (a DC park
// figure) must not make an 11 kW AC box unservable — 11 kW IS that box's full
// power, and refusing it would be the site's policy overruling physics. A
// per-connector minimum (the D4 non-convex floor of a real charge point) is
// set on the Session by the caller and wins over the site default.
func effectiveMin(s Session, set Settings) float64 {
	m := s.MinKw
	if m <= 0 {
		m = set.MinPowerKw
	}
	if m < 0 {
		m = 0
	}
	if s.MaxKw > 0 && m > s.MaxKw {
		m = s.MaxKw
	}
	return m
}

// pace holds a small INCREASE until it is worth a profile write.
func pace(a Allocation, prev *Plan, p Pacing, now time.Time) Allocation {
	a.ChangedAt = now
	if prev == nil {
		return a
	}
	old, ok := prev.Get(a.Key)
	if !ok {
		return a
	}
	// A pause, a resume and every reduction go through immediately.
	if a.Paused != old.Paused || a.Kw+1e-9 < old.Kw {
		return a
	}
	if a.Kw-old.Kw >= p.MinChangeKw {
		return a
	}
	if !old.ChangedAt.IsZero() && now.Sub(old.ChangedAt) >= p.MinHold {
		return a
	}
	// Hold the previous value AND its age, so the hold expires on schedule
	// instead of being renewed by every decision.
	a.Kw = old.Kw
	a.ChangedAt = old.ChangedAt
	return a
}

// rotationEpoch is the fixed-cadence counter the queue turn rides on.
func rotationEpoch(now time.Time, period time.Duration) int {
	if period <= 0 || now.IsZero() {
		return 0
	}
	e := now.UnixNano() / int64(period)
	if e < 0 {
		e = 0
	}
	return int(e)
}

// rotate turns a slice by n positions (left), leaving it untouched when there
// is nothing to turn.
func rotate[T any](in []T, n int) []T {
	if len(in) < 2 {
		return append([]T(nil), in...)
	}
	n = ((n % len(in)) + len(in)) % len(in)
	out := make([]T, 0, len(in))
	out = append(out, in[n:]...)
	out = append(out, in[:n]...)
	return out
}

// nextTurn estimates when a waiting session reaches an admitted slot, assuming
// the queue does not change. It is derived from the SAME rotation the decision
// itself used, so the "dran in ca. X Min." a customer reads is the mechanism's
// own arithmetic and not a decoration.
//
// Zero = not computable, and the surface must then say nothing rather than
// promise a time: with no admitted slot in the rotating tail (everything is
// eaten by Vorrang, or the budget serves nobody) the turn genuinely never comes.
func nextTurn(key string, tail []Session, admitted int, now time.Time, period time.Duration) time.Time {
	if admitted <= 0 || period <= 0 || len(tail) == 0 {
		return time.Time{}
	}
	idx := -1
	for i, s := range tail {
		if s.Key == key {
			idx = i
			break
		}
	}
	if idx < 0 {
		return time.Time{}
	}
	// The tail turns left by one position each epoch, so this session reaches
	// the last admitted slot after (idx - admitted + 1) turns.
	steps := idx - admitted + 1
	if steps <= 0 {
		return time.Time{}
	}
	epoch := rotationEpoch(now, period)
	return time.Unix(0, int64(epoch+steps)*int64(period)).UTC()
}

// waterFill raises the admitted sessions from their minimum toward their
// ceiling, sharing the spare equally and handing back what a head cannot use
// (a 3.7 kW car on a 50 kW share must not waste 46 kW). Returns what is left.
func waterFill(adm []Session, give map[string]float64, spare float64) float64 {
	open := append([]Session(nil), adm...)
	for spare > 1e-9 && len(open) > 0 {
		share := spare / float64(len(open))
		var next []Session
		moved := 0.0
		for _, s := range open {
			head := s.MaxKw - give[s.Key]
			if head <= 1e-9 {
				continue
			}
			take := math.Min(share, head)
			give[s.Key] += take
			moved += take
			if head-take > 1e-9 {
				next = append(next, s)
			}
		}
		spare -= moved
		if moved <= 1e-9 {
			break
		}
		open = next
	}
	return spare
}
