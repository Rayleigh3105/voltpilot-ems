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
	// ReasonNoSurplus: the PHYSICAL budget would serve this session - the
	// SOURCE lane does not (Stufe 4). Named separately from ReasonBudget
	// because the lever is a different one: this is the customer's own
	// Ueberschuss-Priorität, not a full connection.
	ReasonNoSurplus = "kein_ueberschuss"
	// ReasonBelowMinimum: even the WHOLE budget is below this session's own
	// minimum useful power. Not a queue problem — the site is too small for
	// this charge point, and saying "wait" would be a promise nobody can keep.
	ReasonBelowMinimum = "unter_mindestleistung"
	// ReasonPlan: the CLOUD PLAN holds this charge point at 0 for this slot
	// (Verbrauchsmanagement v1 / K3 - the arbitration bridge, Session.CapKw).
	// Named separately from every budget word because the lever is a different
	// one again: it is the customer's own Steuerart, not a full connection.
	ReasonPlan = "plan"
	// ReasonRule: a RULE or a HANDEINGRIFF holds this charge point at 0 (K3,
	// the same bridge from a flow/override holder). Two words rather than one,
	// because "der Fahrplan" and "Ihre Regel" send a customer to two different
	// places.
	ReasonRule = "regel"
	// ReasonManual: a HANDEINGRIFF of this customer holds exactly THIS charge
	// at 0 („Laden pausieren", Verbrauchsmanagement v1 / P3b, Entscheid E5).
	//
	// ⚠ It is its OWN word next to ReasonRule, and that is not cosmetics: the
	// lever is a different one. „Eine Regel hält diese Säule" sends a customer
	// to the rule editor; this one is their own hand on this one charge, and
	// the way back is the „Automatik fortsetzen" one tap away in the same row.
	ReasonManual = "handeingriff"
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
	case ReasonNoSurplus:
		return "wartet — kein Überschuss"
	case ReasonBelowMinimum:
		return "wartet — die verfügbare Leistung reicht für diesen Ladepunkt nicht aus"
	case ReasonPlan:
		return "pausiert — der Fahrplan lädt diese Säule gerade nicht"
	case ReasonRule:
		return "pausiert — eine Regel oder ein Handeingriff hält diese Säule"
	case ReasonManual:
		return "pausiert — Handeingriff"
	}
	return ""
}

// TextFor is Text with the customer's SOURCE choice named where the sentence
// is ABOUT that choice (Mockups §2b: „wartet — kein Überschuss (Ihre
// Priorität: Nur Sonnenstrom)"). Naming the lever in the sentence that blocks
// is the same discipline as otaapply's Blocker/reason pair: a waiting vehicle
// whose owner cannot see WHICH of their own settings holds it is a riddle.
func TextFor(reason string, policy SurplusPolicy) string {
	base := Text(reason)
	if base == "" || reason != ReasonNoSurplus {
		return base
	}
	return base + " (Ihre Priorität: " + PolicyText(policy) + ")"
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
	// BoostUntil is the „Jetzt voll laden"-Übersteuerung (Stufe 4, Mockups
	// §2b): while it lies in the future this session is EXEMPT FROM THE SOURCE
	// CAP and may draw grid power.
	//
	// ⚠ It exempts from the ECONOMY, never from the PHYSICS. It changes
	// neither the Vorrang rank nor any budget: the connection limit, the
	// engineering margin, §14a and the failsafe bind a boosted session exactly
	// like every other one - which is what the dialog's fourth consequence
	// promises. The zero value = no override.
	BoostUntil time.Time
	// PauseUntil is the SIBLING of BoostUntil („Laden pausieren", P3b): while
	// it lies in the future this session is held at 0 kW with ReasonManual.
	//
	// ⚠ It is a RESTRICTION, so it composes with everything above it by being
	// the tightest: it never raises a limit, never frees anything from the
	// source lane and never touches another session. Every OTHER charge on the
	// site allocates byte-for-byte as it would without it - which is exactly
	// what the dialog's consequence list promises.
	//
	// ⚠ Boost and pause are MUTUALLY EXCLUSIVE by construction (the box keeps
	// ONE entry per connector), so there is no "both" case to arbitrate. Were
	// one ever set anyway, the pause wins: a customer who asked for a stop must
	// get a stop.
	PauseUntil time.Time

	// --- Verbrauchsmanagement v1 / P5 -----------------------------------
	//
	// Source is THIS station's own source lane (`charge_points[].source`).
	// "" = follow Input.Policy, which is byte-for-byte the behaviour before
	// P5 - a site whose customer never chose per station allocates exactly as
	// it did. The lane BUDGET stays a site-wide quantity (one sun, one
	// measurement, one pool); this field only decides how THIS session
	// relates to it.
	Source SurplusPolicy
	// SourceExempt frees this session from the SOURCE lane, never from the
	// physics - the K3 arbitration bridge sets it for a holder from class
	// deadline-fallback upwards (a due deadline, the plan, a rule, a
	// Handeingriff). It is exactly the mechanism the boost already uses; the
	// connection limit, the engineering margin, §14a and the failsafe bind an
	// exempt session like every other one.
	SourceExempt bool
	// CapKw is an EXTERNAL, RESTRICT-ONLY ceiling handed down by the K3
	// bridge: the arbitration holder's granted limit_kw. nil = no holder, and
	// then nothing about this session changes. It can only ever LOWER MaxKw.
	//
	// ⚠ 0 is a VALUE, not an absence: it means "this session must not charge
	// now" and pauses it with CapReason. That is why it is a pointer.
	CapKw *float64
	// CapReason is the machine word for a cap-induced pause (ReasonPlan /
	// ReasonRule). Empty falls back to ReasonRule - a pause we cannot name is
	// still a pause somebody has to be able to explain.
	CapReason string
}

// boosted reports whether this session's „Jetzt voll laden" is still running.
func (s Session) boosted(now time.Time) bool {
	return !s.BoostUntil.IsZero() && s.BoostUntil.After(now)
}

// pausedByHand reports whether this session's „Laden pausieren" is running.
func (s Session) pausedByHand(now time.Time) bool {
	return !s.PauseUntil.IsZero() && s.PauseUntil.After(now)
}

// capped is MaxKw after the K3 bridge's restrict-only ceiling. It never
// raises: a cap above the connector's own ceiling changes nothing.
func (s Session) capped() float64 {
	if s.CapKw == nil {
		return s.MaxKw
	}
	c := math.Max(0, *s.CapKw)
	if s.MaxKw > 0 && s.MaxKw < c {
		return s.MaxKw
	}
	return c
}

// capPauses reports whether the bridge's cap forbids charging altogether.
func (s Session) capPauses() bool {
	return s.CapKw != nil && *s.CapKw <= 1e-9
}

// capReason names the cap-induced pause; an unnamed one is still a rule.
func (s Session) capReason() string {
	if s.CapReason == ReasonPlan || s.CapReason == ReasonRule {
		return s.CapReason
	}
	return ReasonRule
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
	// SurplusPolicy / StoragePriority are the Stufe-4 SOURCE choice of the
	// customer (see surplus.go). Their zero values are the intended defaults
	// ("Sonne zuerst" / "Speicher vor Auto"), so a site that never chose
	// behaves exactly as it did before Stufe 4.
	SurplusPolicy   SurplusPolicy
	StoragePriority StoragePriority
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
	s.SurplusPolicy = NormalizePolicy(s.SurplusPolicy)
	s.StoragePriority = NormalizeStorage(s.StoragePriority)
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
	// Boost is true while this session's „Jetzt voll laden" is running: the
	// value was formed WITHOUT the source cap and may therefore contain grid
	// power. The surface says so - a full charge nobody asked for would be a
	// silent break of the customer's own priority.
	Boost bool `json:"boost,omitempty"`
	// ChangedAt is when this VALUE last changed. It carries the pacing across
	// decisions; the executor refreshes the profile on its own cadence
	// regardless (the dead-man's switch needs the refresh).
	ChangedAt time.Time `json:"changed_at,omitzero"`
}

// Plan is one decision over the whole site.
type Plan struct {
	// BudgetKw is the usable budget the decision worked with.
	BudgetKw float64 `json:"budget_kw"`
	// SourceBudgetKw is the ECONOMIC cap the decision worked with (Stufe 4:
	// the surplus lane). nil = no source cap - either „Schnell laden" or a
	// site without the measurement to prove one.
	SourceBudgetKw *float64 `json:"source_budget_kw,omitempty"`
	// AllocatedKw is the sum of the allocations. It is <= BudgetKw by
	// construction; the difference is head room, not an error.
	AllocatedKw float64 `json:"allocated_kw"`
	// SourceAllocatedKw is the part of AllocatedKw that came OUT of the source
	// lane - i.e. what the sun is covering right now. It is a STANDORT
	// statement, never a per-vehicle solar quota (Mockups §1a: electricity is
	// not labelled at the hub). 0 without a source lane.
	SourceAllocatedKw float64      `json:"source_allocated_kw,omitempty"`
	Allocations       []Allocation `json:"allocations"`
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
	// SourceBudgetKw is the ECONOMIC cap of the SOURCE lane (Stufe 4,
	// surplus.go): how many of the budget's kilowatts may come from the
	// customer's chosen source. nil = no source cap, and then this whole file
	// behaves byte-for-byte as it did in Stufe 1-3.
	//
	// ⚠ The two caps COMPOSE most-restrictive-wins and neither can widen the
	// other: BudgetKw protects the connection, SourceBudgetKw honours the
	// customer's priority.
	SourceBudgetKw *float64
	// SourceAllowsMinimum is the „Sonne zuerst"-concession: a session whose
	// MINIMUM does not fit into the source lane is still admitted at that
	// minimum, covered from the physical budget. „Nur Sonnenstrom" leaves it
	// false and the session waits instead.
	SourceAllowsMinimum bool
	// Policy is the customer's source choice. It is the SITE-wide lane every
	// session follows unless it declared one of its own (Session.Source), and
	// it is carried so a paused session's German sentence can NAME the lever.
	Policy SurplusPolicy
	// SourceBlind reports that the lane above could NOT be proven from a
	// measurement (Verbrauchsmanagement v1 / P5). It only ever matters while a
	// lane exists at all, which blind only does for „Nur Sonnenstrom" - and
	// there it is what lets a `sonne_zuerst` station on the SAME site keep
	// failing open, exactly as it does today when it is the only policy.
	SourceBlind bool
	Now         time.Time
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

	// The SOURCE lane (Stufe 4). nil = no economic cap at all, and then every
	// line below behaves byte-for-byte as it did in Stufe 1-3.
	var srcBudget float64
	srcActive := in.SourceBudgetKw != nil
	plan := Plan{BudgetKw: budget, Allocations: []Allocation{}}
	if srcActive {
		srcBudget = round3(math.Max(0, *in.SourceBudgetKw))
		v := srcBudget
		plan.SourceBudgetKw = &v
	}
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
	//
	//    ⚠ Stufe 4 splits each rank ONCE MORE, into BOOSTED and BOUND. A
	//    boosted session ("Jetzt voll laden") is exempt from the SOURCE cap,
	//    so it does not compete for the same pool at all - and serving it
	//    first is exactly the "wirkt wie temporärer Vorrang mit Quelle-egal"
	//    the mockups promise (§2a), WITHOUT touching the Vorrang rank itself.
	//    With no source lane the two sub-groups draw from one pool and the
	//    split is a no-op.
	prioQ, tailQ := queue[:prio], queue[prio:]
	prioBoost, prioBound := splitExempt(prioQ, in)
	tailBoost, tailBound := splitExempt(tailQ, in)

	give := map[string]float64{}
	pausedReason := map[string]string{}
	// ⚠ TWO sets, and keeping them apart is an honesty rule. `exemptOf` is who
	// drew from the physical pool (what SourceAllocatedKw must not count);
	// `boostOf` is who is running „Jetzt voll laden" (what the SURFACE says).
	// Since P5 those differ - a station on „Schnell laden" and a session the
	// K3 bridge freed are exempt without anybody having pressed a button, and
	// showing them as a boost would claim a full charge nobody asked for.
	exemptOf := map[string]bool{}
	boostOf := map[string]bool{}
	rest, srcRest := budget, srcBudget

	// admit hands each session in a group its MINIMUM, or names why not.
	// exempt=true draws from the physical pool alone.
	admit := func(group []Session, exempt bool) []Session {
		var adm []Session
		for _, s := range group {
			minKw := effectiveMin(s, set)
			avail := rest
			if !exempt && srcActive && srcRest < avail {
				avail = srcRest
			}
			// ⚠ The K3 bridge's cap is checked FIRST and it is the only test
			// that can pause a session the physics would have served: a
			// holder that says 0 kW is a decision somebody made (the plan,
			// a rule, a Handeingriff), not a shortage - and naming it
			// „wartet — Budget vergeben" would send the customer to the wrong
			// lever entirely.
			// ⚠ The customer's OWN hand is checked before everything else,
			// including the K3 cap: both only ever pause, so the order decides
			// nothing but the WORD - and a pause somebody asked for by name
			// must be named after them, not after a plan they did not touch.
			if s.pausedByHand(in.Now) {
				pausedReason[s.Key] = ReasonManual
				continue
			}
			if s.capPauses() {
				pausedReason[s.Key] = s.capReason()
				continue
			}
			switch {
			case budget <= 0:
				pausedReason[s.Key] = ReasonNoBudget
			case budget+1e-9 < minKw:
				// Not a queue problem: even the WHOLE budget is below this
				// session's minimum. Saying "wait" would promise a turn that
				// never comes.
				pausedReason[s.Key] = ReasonBelowMinimum
			case avail+1e-9 < minKw:
				// ⚠ The "Sonne zuerst"-concession: the SOURCE is short but the
				// connection is not, and the customer's policy allows a
				// running vehicle to keep its minimum from the grid rather
				// than stand still. It consumes the whole remaining source
				// lane and takes the rest from the physical budget.
				if !exempt && srcActive && allowsMinimum(s, in) && rest+1e-9 >= minKw {
					srcRest = math.Max(0, srcRest-minKw)
					rest -= minKw
					give[s.Key] = minKw
					adm = append(adm, s)
					continue
				}
				if !exempt && srcActive && rest+1e-9 >= minKw {
					// The connection would serve this vehicle; the customer's
					// own source priority does not. A different lever, so a
					// different word.
					pausedReason[s.Key] = ReasonNoSurplus
					continue
				}
				pausedReason[s.Key] = ReasonBudget
			default:
				rest -= minKw
				if !exempt && srcActive {
					srcRest -= minKw
				}
				give[s.Key] = minKw
				adm = append(adm, s)
				continue
			}
		}
		return adm
	}

	fill := func(adm []Session, exempt bool) {
		if len(adm) == 0 {
			return
		}
		spare := rest
		if !exempt && srcActive && srcRest < spare {
			spare = srcRest
		}
		left := waterFill(adm, give, spare)
		moved := spare - left
		rest -= moved
		if !exempt && srcActive {
			srcRest -= moved
		}
	}

	// The order is the whole rule: within each rank the exempt group first
	// (it draws from a different pool), then the source-bound one.
	for _, g := range []struct {
		group  []Session
		exempt bool
	}{
		{prioBoost, true}, {prioBound, false},
		{tailBoost, true}, {tailBound, false},
	} {
		fill(admit(g.group, g.exempt), g.exempt)
		for _, s := range g.group {
			if g.exempt {
				exemptOf[s.Key] = true
				boostOf[s.Key] = s.boosted(in.Now) && !s.pausedByHand(in.Now)
			}
		}
	}
	admittedTail := 0
	for _, s := range append(append([]Session(nil), tailBoost...), tailBound...) {
		if _, ok := give[s.Key]; ok {
			admittedTail++
		}
	}

	// 5) Pacing: hold a value that only moved a little, unless enough time has
	//    passed. A DECREASE is never paced — it protects the connection, and a
	//    protection you postpone is not one. A pause/resume is a decrease or
	//    the thing the customer is waiting for; both go through at once.
	total := 0.0
	sourceTotal := 0.0
	for _, s := range queue {
		a := Allocation{Key: s.Key, Boost: boostOf[s.Key]}
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
				a.NextTurnAt = nextTurn(s.Key, tailQ, admittedTail, in.Now, set.RotationPeriod)
			}
		}
		a = pace(a, in.Previous, pacing, in.Now)
		total += a.Kw
		if !exemptOf[s.Key] {
			sourceTotal += a.Kw
		}
		plan.Allocations = append(plan.Allocations, a)
	}
	sort.Slice(plan.Allocations, func(i, j int) bool { return plan.Allocations[i].Key < plan.Allocations[j].Key })
	plan.AllocatedKw = round3(total)
	if srcActive {
		// What the SOURCE lane is covering right now. It is a STANDORT figure
		// (Mockups §1a: electricity is not labelled at the hub), never a
		// per-vehicle solar quota, and it can never exceed the lane itself.
		plan.SourceAllocatedKw = round3(math.Min(sourceTotal, srcBudget))
	}
	return plan
}

// splitExempt separates the sessions that draw from the PHYSICAL pool alone
// from the source-bound rest, preserving the group's order in both halves.
//
// Four things make a session exempt, and they are one idea in four dresses -
// „diese Ladung folgt der Quellen-Wahl des Kunden gerade nicht":
//
//  1. „Jetzt voll laden" is running (the Stufe-4 boost, unchanged).
//  2. The K3 bridge reports a holder from class deadline-fallback upwards -
//     a due deadline, the plan, a rule, a Handeingriff. Somebody decided this
//     vehicle charges NOW; the source lane is an economy, not a permission.
//  3. This station's OWN source is „Schnell laden" (P5, per-station lane).
//  4. The lane is BLIND and this station's OWN source is not „Nur
//     Sonnenstrom": that is literally what Surplus() does for a site-wide
//     `sonne_zuerst` today (Active=false = fail open), reproduced per session
//     so a MIXED site keeps both readings instead of forcing one on everybody.
//
// ⚠ REASONS 3 AND 4 ASK FOR THE SESSION'S EFFECTIVE SOURCE (sessionPolicy):
// its own choice, else the SITE default. The site default is what makes a
// MIXED site honest - one station on „Nur Sonnenstrom" makes the lane EXIST
// (the agent derives it from the most restrictive source present), and without
// this its neighbour on the site's „Schnell laden" would be dragged into an
// economy its customer never chose.
//
// ⚠ Exempt is exempt from the ECONOMY, never from the PHYSICS: the connection
// limit, the engineering margin, §14a and the failsafe bind an exempt session
// exactly like every other one.
func splitExempt(group []Session, in Input) (exempt, bound []Session) {
	for _, s := range group {
		free := s.boosted(in.Now) || s.SourceExempt
		if !free {
			if own, known := sessionPolicy(s, in); known {
				free = own == PolicyFast || (in.SourceBlind && own != PolicySolarOnly)
			}
		}
		if free {
			exempt = append(exempt, s)
			continue
		}
		bound = append(bound, s)
	}
	return exempt, bound
}

// sessionPolicy is the source lane THIS session follows: its own choice if it
// made one, else the site's.
//
// ⚠ known=false is the LEGACY reading and it is deliberately not the same as
// „schnell": a caller that opened a lane (`SourceBudgetKw != nil`) without
// naming a policy said nothing about who follows it, so everybody does -
// byte-for-byte the pre-P5 rule. `NormalizePolicy("")` resolves to
// PolicyFast, so collapsing the two would silently exempt every session of
// every pre-P5 caller. The agent always names the site policy
// (`Settings.WithDefaults` normalises it), so this branch is the tests' and
// never the product's.
func sessionPolicy(s Session, in Input) (SurplusPolicy, bool) {
	if s.Source != "" {
		return NormalizePolicy(s.Source), true
	}
	if in.Policy != "" {
		return NormalizePolicy(in.Policy), true
	}
	return "", false
}

// allowsMinimum is the „Sonne zuerst"-concession PER SESSION: a vehicle whose
// minimum does not fit into the surplus still gets it, from the grid, so it is
// never left standing. A station that declared its own source answers for
// itself; one that did not follows the site (Input.SourceAllowsMinimum), which
// is byte-for-byte the pre-P5 behaviour.
func allowsMinimum(s Session, in Input) bool {
	if s.Source == "" {
		return in.SourceAllowsMinimum
	}
	return NormalizePolicy(s.Source) == PolicySolarFirst
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
	// ⚠ The ceiling is the CAPPED one (P5/K3): a holder that allows 5 kW must
	// not have this session admitted at a 30 kW site minimum and then filled
	// down to 5 - the minimum IS the promise that a started charge is useful.
	if max := s.capped(); max > 0 && m > max {
		m = max
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
			// ⚠ The CAPPED ceiling (P5/K3), never the raw one: filling a
			// session above the holder's limit_kw would turn a restrict-only
			// bridge into a widening one.
			head := s.capped() - give[s.Key]
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
