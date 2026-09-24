// Genau ein Führungsgerät je Netzpunkt (package K6, concept
// vp-wechselrichter-eigenregelung-k1 §6.2): only ONE storage inverter may run its
// own self-consumption loop on the connection-point meter. Two loops on the same
// meter chase each other's correction and swing up - the lesson of every cascade
// in this project.
//
// WHO THE LEADER IS - the rule, not a setting: the leader is the box's ONE
// controllable storage inverter, the selection (inverter.json, the `battery-hybrid`
// component; componentapply refuses a second one). It needs no election because the
// box cannot command a second storage at all. What the box does NOT know by itself
// is whether that device may lead, and that is what the operator declares on the
// Einrichten page (sources.BalanceSettings, balance.json):
//
//   - WHERE its meter sits (Pflichtangabe): am Netzpunkt / woanders / unbekannt.
//     "Gerät regelt" only at "am Netzpunkt" - a meter elsewhere does not see the
//     second PV system or the loads behind it, and the device would regulate the
//     wrong quantity.
//   - WHAT any further storage at the same connection point does: nothing / it
//     follows the leader (the manufacturer's master/slave) / it holds or runs a
//     fixed setpoint / it regulates itself on the same meter. The last one is a
//     second regulator - the leader then may not regulate itself.
//
// The box MEASURES one more thing where it can: with a dedicated Netz meter it
// compares the device's own grid reading against it (MeterCheck). A measured
// mismatch vetoes a declared "am Netzpunkt"; without a meter the check is
// "ungeprueft" and the operator is pointed at the guided one-time test.
//
// It is PURE: LeaderFor decides, the caller (agent/native.go) hands the refusal to
// guards.NativeMode as a standing condition of the Wegwahl (Box ②).
package guards

import (
	"math"
	"sort"
	"sync"
	"time"
)

// The meter-location words (BalanceSettings.PrimaryMeterLocation). "" reads as
// MeterUnknown: an unstated location is not "am Netzpunkt".
const (
	MeterAtGridPoint = "netzpunkt"
	MeterElsewhere   = "woanders"
	MeterUnknown     = "unbekannt"
)

// The further-storage words (BalanceSettings.FurtherStorage). "" reads as
// FurtherStorageNone - most plants have one storage, and a second one that
// regulates itself on the same meter shows up in the measurement (the
// export-with-headroom hint, the cascade's inner-loop grace) even undeclared.
const (
	FurtherStorageNone = "keine"
	// FurtherStorageFollower: the manufacturer's master/slave (parallel) mode -
	// the second unit follows the leader and does not read the meter itself.
	FurtherStorageFollower = "folger"
	// FurtherStorageHold: the second unit holds, runs a fixed setpoint or has
	// its own self-consumption switched off.
	FurtherStorageHold = "halten"
	// FurtherStorageSelfRegulating: the second unit runs its own
	// self-consumption loop on the connection point - a second regulator.
	FurtherStorageSelfRegulating = "regelt_selbst"
)

// The plausibility verdicts of MeterCheck.
const (
	MeterPlausibilityUnchecked = "ungeprueft"
	MeterPlausibilityOK        = "passt"
	MeterPlausibilityMismatch  = "passt_nicht"
)

// The leader's hints: observations without a refusal of their own.
const (
	// LeaderHintOneTimeTest: the device may lead, but without a Netz meter the
	// box cannot measure its meter location - the guided one-time test is due.
	LeaderHintOneTimeTest = "einmal_test"
	// LeaderHintCheckMeter: the plant exported while the battery still had
	// headroom (the K4b hint einspeisung_trotz_ladeleistung) - the classic
	// symptom of a device meter that does not see a second PV system.
	LeaderHintCheckMeter = "zaehlerort_pruefen"
)

var leaderHintText = map[string]string{
	LeaderHintOneTimeTest: "Ohne eigenen Netz-Zähler kann die Box nicht nachmessen, ob der Zähler des " +
		"Wechselrichters am Netzpunkt sitzt - bitte einmal geführt prüfen (Anleitung: bekannte Last " +
		"zuschalten, Anzeige des Wechselrichters und des Hausanschlusses vergleichen).",
	LeaderHintCheckMeter: "Die Anlage hat eingespeist, obwohl der Speicher noch laden konnte - das deutet " +
		"auf einen Zähler, der die zweite PV-Anlage nicht sieht. Bitte den Zählerort prüfen (Netz-Zähler " +
		"einrichten oder den geführten Einmal-Test durchführen).",
}

// LeaderHintText is the German sentence of a leader hint ("" for an unknown one).
func LeaderHintText(code string) string { return leaderHintText[code] }

// LeaderInput is what the operator declared plus what the box measured.
type LeaderInput struct {
	MeterLocation  string
	FurtherStorage string
	Plausibility   string
}

// LeaderVerdict says whether the selection may regulate itself on the
// connection point. Reason is a NativeMode refusal code ("" when it leads),
// Text its German sentence.
type LeaderVerdict struct {
	Leads  bool
	Reason string
	Text   string
}

// LeaderFor is the rule. The order is the argument: a second regulator makes the
// question of the meter moot, a meter elsewhere makes its location moot, and a
// measurement can only veto a declaration, never replace it.
func LeaderFor(in LeaderInput) LeaderVerdict {
	refuse := func(code string) LeaderVerdict {
		return LeaderVerdict{Reason: code, Text: NativeReasonText(code)}
	}
	switch in.FurtherStorage {
	case "", FurtherStorageNone, FurtherStorageFollower, FurtherStorageHold:
	default:
		// FurtherStorageSelfRegulating - and any word we do not understand: an
		// unknown statement about a second storage must not become permission.
		return refuse(NativeSecondRegulator)
	}
	switch in.MeterLocation {
	case MeterAtGridPoint:
	case MeterElsewhere:
		return refuse(NativeMeterElsewhere)
	default:
		return refuse(NativeMeterLocationMissing)
	}
	if in.Plausibility == MeterPlausibilityMismatch {
		return refuse(NativeMeterImplausible)
	}
	return LeaderVerdict{Leads: true}
}

// MeterCheck compares the device's own grid reading with the box's Netz meter
// (both signed, + import / - export). Concurrency-safe: it is fed from the
// telemetry path and read from the setpoint path.
//
// It judges the MEDIAN absolute difference over a sliding window, not a single
// pair: the two meters are read at different moments (the Deye over its logger
// every 5-25 s), so every load step produces one honest outlier pair. A meter
// that sits somewhere else differs persistently - by the second PV system's
// output, or by the loads it does not see - and that is what the median keeps.
type MeterCheck struct {
	mu    sync.Mutex
	pairs []meterPair
}

type meterPair struct {
	at       time.Time
	diffKw   float64
	meterAbs float64
}

const (
	// MeterCheckWindow is how far back the verdict looks.
	MeterCheckWindow = 10 * time.Minute
	// MeterCheckMinPairs / MeterCheckMinSpan: a verdict needs this many pairs
	// spread over at least this long - a single minute of agreement at night
	// proves nothing about the day.
	MeterCheckMinPairs = 12
	MeterCheckMinSpan  = 2 * time.Minute
	// MeterCheckMaxSkew is how far apart the two readings of one pair may be.
	MeterCheckMaxSkew = 10 * time.Second
	// MeterCheckToleranceKw / MeterCheckToleranceFrac: the allowed median
	// difference - 1 kW or 10 % of the exchange, whichever is larger. A second
	// PV system that matters is larger; CT class and phase error are smaller.
	MeterCheckToleranceKw   = 1.0
	MeterCheckToleranceFrac = 0.1
)

// MeterCheckVerdict is one evaluation.
type MeterCheckVerdict struct {
	State string
	// DeviationKw is the median absolute difference (NaN while unchecked).
	DeviationKw float64
	Pairs       int
}

// Observe adds one pair: the device's reading of the sample at `at` and the
// Netz meter's newest reading, which was meterAge old when the device's sample
// arrived (both ages on the box's own receive clock - the device stamps its
// sample with ITS time, the meter reading carries the box's). A pair whose
// halves are too far apart, or that is not finite, is not a pair.
func (m *MeterCheck) Observe(at time.Time, deviceGridKw, meterGridKw float64, meterAge time.Duration) {
	if !finite(deviceGridKw) || !finite(meterGridKw) || at.IsZero() {
		return
	}
	if meterAge < 0 {
		meterAge = -meterAge
	}
	if meterAge > MeterCheckMaxSkew {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if n := len(m.pairs); n > 0 && !at.After(m.pairs[n-1].at) {
		return // the same (or an older) sample again
	}
	m.pairs = append(m.pairs, meterPair{at: at, diffKw: math.Abs(deviceGridKw - meterGridKw),
		meterAbs: math.Abs(meterGridKw)})
	m.prune(at)
}

// Reset forgets every pair (a changed meter configuration starts over).
func (m *MeterCheck) Reset() {
	m.mu.Lock()
	m.pairs = nil
	m.mu.Unlock()
}

// Verdict judges the pairs of the last MeterCheckWindow.
func (m *MeterCheck) Verdict(now time.Time) MeterCheckVerdict {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.prune(now)
	n := len(m.pairs)
	if n < MeterCheckMinPairs || m.pairs[n-1].at.Sub(m.pairs[0].at) < MeterCheckMinSpan {
		return MeterCheckVerdict{State: MeterPlausibilityUnchecked, DeviationKw: math.NaN(), Pairs: n}
	}
	diffs := make([]float64, n)
	levels := make([]float64, n)
	for i, p := range m.pairs {
		diffs[i], levels[i] = p.diffKw, p.meterAbs
	}
	dev := median(diffs)
	tol := math.Max(MeterCheckToleranceKw, MeterCheckToleranceFrac*median(levels))
	v := MeterCheckVerdict{State: MeterPlausibilityOK, DeviationKw: round3(dev), Pairs: n}
	if dev > tol {
		v.State = MeterPlausibilityMismatch
	}
	return v
}

// prune drops pairs older than the window. Caller holds m.mu.
func (m *MeterCheck) prune(now time.Time) {
	cut := 0
	for cut < len(m.pairs) && now.Sub(m.pairs[cut].at) > MeterCheckWindow {
		cut++
	}
	if cut > 0 {
		m.pairs = append(m.pairs[:0], m.pairs[cut:]...)
	}
}

func median(v []float64) float64 {
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}
