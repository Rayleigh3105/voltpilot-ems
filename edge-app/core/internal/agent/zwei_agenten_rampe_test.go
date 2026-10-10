package agent

// AP-15 Folge of PR 1075 (vp-uems-v15-folge-blinde-rampe-planrueckkehr): the
// blind ramp of the share path (guards/exportanteil.go ramp, V2) with the
// plan coming back DURING it. The connection-point meter of the leading box
// goes away while its battery charges the PV, and 20-50 s later the next
// slot of its plan discharges - an ordinary quarter-hour change in the sun,
// which the failure matrix never reaches (meter failure and slot change
// charge -> discharge within the same 90 s). The ramp began with no
// discharge; the discharge ceiling holds the discharge at 0, but the charge
// that drops the watchdog cannot hold ("laedt nie"), and the producers only
// ramp down linearly - V6 not in every evaluation.

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
)

// zaRueckkehr is the slot change of the case: charge before, discharge from it.
var zaRueckkehr = zaT0.Add(5 * time.Minute)

// zaPlanLadenDannEntladen is the plan of Halle 1 for the case: the battery
// charges the PV (+100 kW) until zaRueckkehr and discharges 60 kW for the
// market from that slot on.
func zaPlanLadenDannEntladen(exportLimit *float64) func(time.Time) *plan.Plan {
	return func(now time.Time) *plan.Plan {
		yes := true
		p := &plan.Plan{SlotMinutes: 15, ReceivedAt: now, GeneratedAt: now,
			GridChargeAllowed: &yes, GridExportLimitKw: exportLimit}
		q := now.Truncate(15 * time.Minute)
		for i := 0; i < 16; i++ {
			start := q.Add(time.Duration(i) * 15 * time.Minute)
			soll := 100.0
			if !start.Before(zaRueckkehr) {
				soll = -60
			}
			p.Slots = append(p.Slots, plan.Slot{Start: start, BatterySetpointKw: soll})
		}
		return p
	}
}

// zaRampeFall: the meter of Halle 1 goes away vor seconds before the slot
// change charge -> discharge; vor < 0: it never goes away (the same slot
// change in normal operation, the reference).
func zaRampeFall(vor time.Duration) zaFall {
	grenze := zaEinspeisegrenze
	ausfall := zaRueckkehr.Sub(zaT0) - vor
	if vor < 0 {
		ausfall = time.Hour
	}
	return zaFall{zeile: "A7l", ausfall: "Netzzähler der führenden Box fällt aus, während die Batterie lädt; der Plan kehrt mit Entladung zurück",
		haelt: true, nachZeit: "≤ 90 s nach dem letzten Wert", m2MaxS: 90, punkte: []zaPunkt{zaMittag}, ende: 20 * time.Minute,
		stoer: func(l *zaLauf, t time.Duration) {
			if t == -15*time.Minute+time.Second { // before the first delivery
				l.e1.plan = zaPlanLadenDannEntladen(&grenze)
			}
			l.e1.zaehlerFehlt = t >= ausfall
		}}
}

// The case at the connection point of the model, for every distance between
// the failure and the slot change the brief names (20-50 s): the ramp starts
// 30 s after the last value, so the return lands before it (fresh, einAnstieg
// against the measurement) or on it (blind, einAnstieg against the ramp's
// start). M-1 the quarter against the limit, M-2 the largest excess and how
// long it lasts - both measured, both logged. What remains is the slot change
// itself: the battery (25 kW/s) leaves the charge faster than the PV (10
// kW/s) follows its cap down, for a few seconds - exactly as in normal
// operation with the meter there (the reference). The bound: M-1 at most the
// limit (the sum of the shares), M-2 no larger than the same slot change in
// normal operation and over within one regulation (10 s). On uems (the ramp
// as before) +115.5 kW for 51 s.
func TestA7lRampePlanRueckkehrHaelt(t *testing.T) {
	ref := zaFahre(t, zaRampeFall(-1), zaMittag)
	t.Logf("Referenz ohne Ausfall: M-1 %.1f kW, M-2 %.1f kW, längste %d s",
		ref.ein.hoechstesViertel().mittel, ref.ein.groessteUeberKw, ref.ein.laengsteUeber)
	for _, vor := range []time.Duration{20 * time.Second, 30 * time.Second, 35 * time.Second, 40 * time.Second, 45 * time.Second, 50 * time.Second} {
		r := zaFahre(t, zaRampeFall(vor), zaMittag)
		h := r.ein.hoechstesViertel()
		t.Logf("Rückkehr %v nach dem Ausfall: M-1 %.1f kW (%s), M-2 %.1f kW, längste %d s, gesamt %d s",
			vor, h.mittel, h.start.Add(2*time.Hour).Format("15:04"), r.ein.groessteUeberKw, r.ein.laengsteUeber, r.ein.sekundenUeber)
		if h.mittel > zaEinspeisegrenze+zaEps || r.ein.groessteUeberKw > ref.ein.groessteUeberKw+zaEps || r.ein.laengsteUeber > 10 {
			t.Errorf("Rückkehr %v nach dem Ausfall: M-1 %.3f kW, M-2 %.3f kW / %d s - die Rampe lässt die wegfallende Ladung durch (Referenz %.3f kW)",
				vor, h.mittel, r.ein.groessteUeberKw, r.ein.laengsteUeber, ref.ein.groessteUeberKw)
		}
	}
}
