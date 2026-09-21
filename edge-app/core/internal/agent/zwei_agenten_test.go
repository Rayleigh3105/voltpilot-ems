package agent

// AP-15 IP-27 (NW-2, E6 = A), part 2: TWO real agents (New, share document
// on disk, the unchanged setpoint path) against ONE plant model in the process
// (zwei_agenten_modell_test.go). Every row of the failure matrix of the
// concept (§5.1) that the box can carry is a table case, played in the most
// unfavourable operating point of each direction (M-3) and measured at the
// model's connection point: M-1 the highest quarter-hour mean against the
// limit, M-2 the seconds above the limit and the largest excess.
//
// What the harness plays instead of the real world - and nothing else:
//   - Node-RED: the model sends each box the local telemetry of ITS devices
//     (E-1: connection point DQ-2, K-1, K-2; E-4: feeder meter DQ-10, K-12)
//     through onLocalTelemetry, and applies the setpoint the box publishes on
//     the local bus (pv_limit_kw, battery_setpoint_kw) to those devices.
//   - the OCPP charge points of E-4: the model reports their metered draw to
//     the box's charging budget (what ocppObserve does with the CSMS snapshot)
//     and applies the allocation of ocppBudget (what SetChargingProfile does).
//   - the cloud: plan and share documents, delivered the way the retained
//     topics would deliver them.
// Time is a test clock: one model second per step, no sleeping.

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

const (
	zaEinspeisegrenze = 100.0
	zaBezugsgrenze    = 550.0
	zaVorbehalt       = 473.0
	zaK2Entity        = "7a000000-0000-4000-8000-0000000000b2"
)

var (
	// Sunday 13 June 2027, 13:00 local - the sunny Sunday of R1; the failure
	// comes at 13:10 as in the reference cases.
	zaAnlauf = time.Date(2027, 6, 13, 10, 55, 0, 0, time.UTC) // warm-up, not measured
	zaStart  = zaAnlauf.Add(5 * time.Minute)                  // M-1/M-2 from here
	zaT0     = zaStart.Add(10 * time.Minute)                  // the failure
)

// zaDok is a share document of AN-1 for one box (contract steuerungsverbund
// §3): feed-in e1/e4, import e1/e4 (kW); verteilbar is their sum.
func zaDok(box string, revision int, schritt string, e1, e4, b1, b4 float64) []byte {
	return zaDokV(box, revision, schritt, e1+e4, b1+b4, e1, e4, b1, b4)
}

// zaDokV names verteilbar on its own - for the sum check of the box.
func zaDokV(box string, revision int, schritt string, vE, vB, e1, e4, b1, b4 float64) []byte {
	rolle := "steuert_mit"
	if box == vaE1 {
		rolle = "fuehrt"
	}
	return []byte(fmt.Sprintf(`{"schema_version":"1.0","tenant_id":%q,"site_id":%q,"device_id":%q,`+
		`"epoche":1,"revision":%d,"schritt":%q,"verteilbar":{"einspeisung":%.1f,"bezug":%.1f},`+
		`"anteile":{"einspeisung":{%q:%.1f,%q:%.1f},"bezug":{%q:%.1f,%q:%.1f}},`+
		`"published_at":"2027-06-13T09:00:00Z","rolle":%q}`,
		vaTenant, vaSite, box, revision, schritt, vE, vB,
		vaE1, e1, vaE4, e4, vaE1, b1, vaE4, b4, rolle))
}

// zaBox is one box: a real agent plus the switches of the failures.
type zaBox struct {
	name string
	id   string
	cfg  config.Config
	a    *Agent
	rt   *ocppRuntime // E-4: the charging budget of its six charge points
	set  lastmgmt.Settings
	sp   map[string]any
	plan func(now time.Time) *plan.Plan

	aus           bool          // power gone: no reading, no setpoint, no write (A1, A2, A13)
	lanWeg        bool          // alive, but reaches none of its devices (A15)
	schreibtNicht bool          // reads, but does not control (A12, A14)
	internetWeg   bool          // receives no plan and no document (A5)
	uhr           time.Duration // offset of the box's clock (A8)
	zaehlerFehlt  bool          // its own measuring point is missing (A7)
	friert        *float64      // its own measuring point repeats this value (A7)
}

func zaStarteBox(t *testing.T, name, id string, dok []byte, p func(time.Time) *plan.Plan) *zaBox {
	t.Helper()
	b := &zaBox{name: name, id: id, plan: p}
	b.cfg = config.Defaults()
	b.cfg.DataDir = t.TempDir()
	b.cfg.ControlEnabled = true
	b.cfg.MaxChargeKw, b.cfg.MaxDischargeKw = 100, 100
	b.cfg.DevTenantID, b.cfg.DevSiteID, b.cfg.DevDeviceID = vaTenant, vaSite, id
	b.starte(t)
	if dok != nil {
		if r := b.a.nimmAnteile(dok, zaAnlauf); r == nil || !r.Angenommen {
			t.Fatalf("%s: share document not accepted: %+v", name, r)
		}
	}
	if id == vaE4 {
		b.set = lastmgmt.Settings{GridLimitKw: zaBezugsgrenze}.WithDefaults()
	}
	return b
}

// starte brings the agent up from its data directory - the first start and
// every restart (the share lies on disk, the plan comes back retained).
func (b *zaBox) starte(t *testing.T) {
	t.Helper()
	a, _ := startBusOnlyAgent(t, b.cfg)
	a.State.Update(func(s *state.Snapshot) { s.TenantID, s.SiteID, s.DeviceID = vaTenant, vaSite, b.id })
	// Inline and synchronous: the setpoint of applySetpoint is here when it returns.
	if err := a.Bus.Subscribe(localbus.TopicSetpoint, 1, func(_ string, p []byte) {
		var m map[string]any
		if json.Unmarshal(p, &m) == nil {
			b.sp = m
		}
	}); err != nil {
		t.Fatal(err)
	}
	b.a = a
	if b.id == vaE4 {
		b.rt = &ocppRuntime{budget: lastmgmt.NewBudgetTracker()}
	}
}

func (b *zaBox) jetzt(m *zaAnlage) time.Time { return m.now.Add(b.uhr) }

// planZustellen hands the box the plan the cloud publishes (retained).
func (b *zaBox) planZustellen(m *zaAnlage) {
	if b.aus || b.internetWeg {
		return
	}
	p := b.plan(b.jetzt(m))
	b.a.mu.Lock()
	b.a.currentPlan = p
	b.a.mu.Unlock()
}

// dokZustellen hands the box a share document; nil = not delivered.
func (b *zaBox) dokZustellen(t *testing.T, m *zaAnlage, dok []byte) (angenommen bool, grund string) {
	t.Helper()
	if b.aus || b.internetWeg {
		return false, "nicht zugestellt"
	}
	r := b.a.nimmAnteile(dok, b.jetzt(m))
	if r == nil {
		return false, "unlesbar"
	}
	return r.Angenommen, r.Grund
}

// messen is Node-RED: the readings of the box's own devices.
func (b *zaBox) messen(m *zaAnlage) {
	if b.aus || b.lanWeg {
		return
	}
	ts := b.jetzt(m)
	fuehrt := b.id == vaE1
	punkt := m.abgangE4
	if fuehrt {
		punkt = m.netz
	}
	if b.friert != nil {
		punkt = *b.friert
	}
	msg := map[string]any{"ts": ts.Format(time.RFC3339Nano)}
	if !b.zaehlerFehlt {
		msg["power_kw"] = punkt
	}
	if fuehrt {
		msg["pv_power_kw"] = m.pvK1
		msg["battery_power_kw"] = m.battK2
		msg["soc_pct"] = 50.0
	} else {
		msg["pv_power_kw"] = m.pvK12
	}
	raw, _ := json.Marshal(msg)
	b.a.onLocalTelemetry(localbus.TopicTelemetry, raw)
	if b.rt != nil && !b.zaehlerFehlt {
		// ocppObserve with the CSMS meter values of the six charge points
		b.rt.budget.ObserveM(ts, lastmgmt.Measurement{GridKw: punkt, ChargingKw: m.ladenK13, Complete: true})
	}
}

// regeln runs the box's setpoint path and writes what it publishes.
func (b *zaBox) regeln(m *zaAnlage) {
	if b.aus {
		return
	}
	now := b.jetzt(m)
	b.sp = nil
	b.a.applySetpoint(now)
	var laden float64
	if b.rt != nil {
		laden = b.ladebudget(now)
	}
	if b.lanWeg || b.schreibtNicht {
		return
	}
	if b.sp != nil && b.sp["control_enabled"] == true {
		pv := 1e9
		if v, ok := b.sp["pv_limit_kw"].(float64); ok {
			pv = v
		}
		if b.id == vaE1 {
			m.k1.befehl(m.now, math.Min(pv, m.k1.nennKw))
			if v, ok := b.sp["battery_setpoint_kw"].(float64); ok {
				m.k2.befehl(m.now, v)
			}
		} else {
			m.k12.befehl(m.now, math.Min(pv, m.k12.nennKw))
		}
	}
	if b.rt != nil {
		je := math.Min(laden/float64(len(m.k13)), 22)
		for _, g := range m.k13 {
			g.befehl(m.now, je)
		}
	}
}

// ladebudget is the charge-point budget of the box: ocppBudget with the held
// share, exactly as ocppStep derives it.
func (b *zaBox) ladebudget(now time.Time) float64 {
	b.a.ocpp = b.rt
	defer func() { b.a.ocpp = nil }()
	safe := lastmgmt.DeriveSafeDefault(b.set.GridLimitKw, effectiveMaxHouseLoad(b.set), 6)
	v, reserved := b.a.ocppBudget(now, b.set, csms.Snapshot{}, safe)
	return ocppAllocatable(v, reserved)
}

// zaPunkt is an operating point (M-3): the most unfavourable one per direction.
type zaPunkt struct {
	name     string
	richtung string
	// batteries and plans
	e1BattKw float64
	// time series; t = time since the failure
	grundlast func(t time.Duration) float64
	sonneK1   func(t time.Duration) float64
	sonneK12  func(t time.Duration) float64
	autos     func(t time.Duration) float64
}

var (
	// Einspeisung: full sun at Halle 1, no load at all (R1: "bei JEDER Last
	// >= 0"), the battery discharging 60 kW for the market (V6), no car - and
	// the gap in the clouds over the Verwaltung 5 s after the failure: its PV
	// rises from 30 to 60 kW, up to its share (R9: why there is no holding).
	zaMittag = zaPunkt{
		name: "Mittag", richtung: "Einspeisung", e1BattKw: -60,
		grundlast: func(time.Duration) float64 { return 0 },
		sonneK1:   func(time.Duration) float64 { return 100 },
		sonneK12: func(t time.Duration) float64 {
			if t >= 5*time.Second {
				return 60
			}
			return 30
		},
		autos: func(time.Duration) float64 { return 0 },
	}
	// Bezug: night, the uncontrolled load exactly at its Vorbehalt 473 kW,
	// six cars that each want 22 kW (132 kW against the share of 77 kW), and
	// a plan that wants to charge the battery 100 kW from the grid.
	zaNacht = zaPunkt{
		name: "Nacht", richtung: "Bezug", e1BattKw: 100,
		grundlast: func(time.Duration) float64 { return zaVorbehalt },
		sonneK1:   func(time.Duration) float64 { return 0 },
		sonneK12:  func(time.Duration) float64 { return 0 },
		autos:     func(time.Duration) float64 { return 22 },
	}
)

// zaPlan is a plan of four hours from the quarter of now (plan per box, IP-15);
// only the leading box carries the whole feed-in limit of the connection point.
func zaPlan(battKw float64, exportLimit *float64) func(time.Time) *plan.Plan {
	return func(now time.Time) *plan.Plan {
		yes := true
		p := &plan.Plan{SlotMinutes: 15, ReceivedAt: now, GeneratedAt: now,
			GridChargeAllowed: &yes, GridExportLimitKw: exportLimit}
		q := now.Truncate(15 * time.Minute)
		for i := 0; i < 16; i++ {
			p.Slots = append(p.Slots, plan.Slot{Start: q.Add(time.Duration(i) * 15 * time.Minute), BatterySetpointKw: battKw})
		}
		return p
	}
}

// zaLauf is one played case.
type zaLauf struct {
	t        *testing.T
	m        *zaAnlage
	e1, e4   *zaBox
	cloudWeg bool // no plan and no document for anyone (A3, A4, A9)
	notizen  []string
}

func (l *zaLauf) notiz(format string, args ...any) {
	l.notizen = append(l.notizen, fmt.Sprintf(format, args...))
}

// zaBefund pins a finding of NW-2: a row the matrix says holds, measured
// NOT holding in the most unfavourable operating point. The test SHOWS the
// excess with these numbers and breaks when it vanishes OR grows. The healing
// package flips the row at ONE place - its variable below set to nil - and the
// row must then hold as the matrix says.
type zaBefund struct {
	punkt           string // the operating point that shows it
	ursache         string
	heilung         string
	groessteUeberKw float64 // M-2: largest excess (kW)
	laengsteS       int     // M-2: longest stretch above the limit (s)
	viertelKw       float64 // M-1: highest quarter-hour mean (kW)
}

// befundA7Friert - A7, the connection-point value of the leading box
// freezes. The probe (B2, guards/eingefroren.go) calls a value frozen only
// when it stands still although the box itself adjusted >= 2 kW; Box Halle 1
// sees a constant 98 kW and has no reason to adjust, while Box Verwaltung
// legally rises to its share. Halle 1 stays at K-1 + discharge = 68 kW over
// its share of 40 kW - without end.
//
// Healing direction (firstmate, 21.09.2026): a probing adjustment - if the own
// connection-point value stands bit-identical for 60 s WHILE the box runs above
// its share, it lowers ONCE by >= 2 kW (lowering is always safe), and the
// existing Einfrierprobe decides. After the healing: befundA7Friert = nil.
var befundA7Friert = &zaBefund{
	punkt:           "Mittag",
	ursache:         "Einfrierprobe feuert nur nach eigener Verstellung >= 2 kW; die führende Box sieht konstant 98 kW und verstellt nicht",
	heilung:         "Prüf-Verstellung: 60 s bitgleich über dem Anteil -> einmal um >= 2 kW senken, die Einfrierprobe entscheidet",
	groessteUeberKw: 26.8, laengsteS: 2096, viertelKw: 126.8,
}

// befundA8Zurueck - A8, the clock of the LEADING box jumps 840 s back (R10,
// the partner 840 s ahead, holds). Every new reading then carries a timestamp
// older than the last accepted one: the watchdog discards it
// (ExportLimiter.ObserveMitSpeicher) and clamps the negative age to 0
// (capLockedAb) - the last value before the jump counts as fresh until the
// clock catches up, and the box regulates against a frozen value.
//
// Healing direction (firstmate, 21.09.2026): freshness by the monotonic time
// of receipt ("Dauer statt Uhrzeit"); a negative age is blind; a reading with
// an older timestamp is a clock jump - re-anchor instead of discarding. For
// the feed-in and the import watchdog and the Einfrierprobe. The same pattern
// sits at guards/exportlimit.go Observe + capLockedAb, guards/exportanteil.go
// ObserveMitSpeicher, guards/eingefroren.go Einfrierprobe.Wert,
// lastmgmt/budget.go ObserveM + Budget, lastmgmt/bezuganteil.go BudgetAnteil +
// Netzpunkt (guards/peakguard.go already re-anchors). After the healing:
// befundA8Zurueck = nil.
var befundA8Zurueck = &zaBefund{
	punkt:           "Mittag",
	ursache:         "Messung mit älterem Zeitstempel wird verworfen, negatives Alter auf 0 geklemmt: der letzte Wert vor dem Sprung gilt als frisch",
	heilung:         "Frische über die monotone Empfangszeit, negatives Alter = blind, älterer Zeitstempel = Uhrensprung -> neu verankern",
	groessteUeberKw: 26.8, laengsteS: 589, viertelKw: 115.0,
}

// zaFall is one row of the matrix (ausfallmatrix.json of the concept).
type zaFall struct {
	zeile     string
	ausfall   string
	haelt     bool   // "ohne Kommunikation": ja
	nachZeit  string // the matrix column "nach welcher Zeit", verbatim
	m2MaxS    int    // M-2 bound read from it (Startwert of a regulation: 60 s)
	punkte    []zaPunkt
	ende      time.Duration // measured time after zaStart (default 45 min)
	e1ohneDok bool
	// e1PlanHeute: without a share there is no watchdog above the battery
	// (V6 comes with the share) - the leading box gets today's plan, which the
	// optimizer computes against the limit: no market discharge, no grid charge.
	e1PlanHeute bool
	befund      *zaBefund // a finding against the matrix (nil = holds as the matrix says)
	// stoer is called every second with the time since the failure.
	stoer func(l *zaLauf, t time.Duration)
}

type zaErgebnis struct {
	fall           zaFall
	punkt          zaPunkt
	ein, bez       *zaMessung
	notizen        []string
	m1ok, m2ok, ok bool
	befund         *zaBefund // the finding this case shows, nil = none
}

func zaFahre(t *testing.T, f zaFall, p zaPunkt) zaErgebnis {
	t.Helper()
	m := neueAnlage(zaAnlauf)
	seit := func(now time.Time) time.Duration { return now.Sub(zaT0) }
	m.grundlast = func(now time.Time) float64 { return p.grundlast(seit(now)) }
	m.sonneK1 = func(now time.Time) float64 { return p.sonneK1(seit(now)) }
	m.sonneK12 = func(now time.Time) float64 { return p.sonneK12(seit(now)) }
	m.autos = func(now time.Time) float64 { return p.autos(seit(now)) }

	grenze := zaEinspeisegrenze
	e1Batt := p.e1BattKw
	if f.e1PlanHeute {
		e1Batt = 0
	}
	var dok1 []byte
	if !f.e1ohneDok {
		dok1 = zaDok(vaE1, 1, "ziel", 40, 60, 0, 77)
	}
	l := &zaLauf{t: t, m: m,
		e1: zaStarteBox(t, "Box Halle 1", vaE1, dok1, zaPlan(e1Batt, &grenze)),
		e4: zaStarteBox(t, "Box Verwaltung", vaE4, zaDok(vaE4, 1, "ziel", 40, 60, 0, 77), zaPlan(0, nil)),
	}
	ein := &zaMessung{grenzeKw: zaEinspeisegrenze, richtung: -1}
	bez := &zaMessung{grenzeKw: zaBezugsgrenze, richtung: +1}
	ende := f.ende
	if ende == 0 {
		ende = 45 * time.Minute
	}
	for !m.now.After(zaStart.Add(ende - time.Second)) {
		m.schritt()
		if f.stoer != nil {
			f.stoer(l, seit(m.now))
		}
		s := int(m.now.Sub(zaAnlauf) / time.Second)
		if s == 1 || (m.now.Second() == 0 && m.now.Minute()%15 == 0) {
			if !l.cloudWeg {
				l.e1.planZustellen(m)
				l.e4.planZustellen(m)
			}
		}
		if s%10 == 0 {
			l.e1.messen(m)
			l.e1.regeln(m)
		}
		if s%10 == 5 {
			l.e4.messen(m)
			l.e4.regeln(m)
		}
		if !m.now.Before(zaStart.Add(time.Second)) {
			ein.nimm(m.now, m.netz)
			bez.nimm(m.now, m.netz)
		}
	}
	ein.schluss()
	bez.schluss()
	r := zaErgebnis{fall: f, punkt: p, ein: ein, bez: bez, notizen: l.notizen}
	r.m1ok = ein.hoechstesViertel().mittel <= zaEinspeisegrenze+zaEps && bez.hoechstesViertel().mittel <= zaBezugsgrenze+zaEps
	r.m2ok = ein.laengsteUeber <= f.m2MaxS && bez.laengsteUeber <= f.m2MaxS
	r.ok = r.m1ok && r.m2ok
	if f.befund != nil && f.befund.punkt == p.name {
		r.befund = f.befund
	}
	return r
}

// The matrix rows the box carries. Each "nach welcher Zeit" is quoted from
// the concept; rows whose time names no own bound ("ohne Unterbrechung",
// "sofort", "—") get the M-2 Startwert of a regulation, 60 s.
func zaFaelle() []zaFall {
	beide := []zaPunkt{zaMittag, zaNacht}
	return []zaFall{
		{zeile: "R1", ausfall: "kein Ausfall (Normalbetrieb, Referenz)", haelt: true, nachZeit: "—", m2MaxS: 60, punkte: beide},
		{zeile: "A1", ausfall: "mitsteuernde Box fällt ganz aus", haelt: true, nachZeit: "sofort; Geräte-Rückfall nach ≤ 60 s", m2MaxS: 60, punkte: beide,
			stoer: func(l *zaLauf, t time.Duration) {
				if t == 0 {
					l.e4.aus = true
				}
			}},
		{zeile: "A2", ausfall: "führende Box fällt ganz aus", haelt: true, nachZeit: "sofort für E-4; K-1 nach 60 s", m2MaxS: 60, punkte: beide,
			stoer: func(l *zaLauf, t time.Duration) {
				if t == 0 {
					l.e1.aus = true
				}
			}},
		{zeile: "A3", ausfall: "Cloud weg, Broker erreichbar", haelt: true, nachZeit: "Grenze: ohne Unterbrechung; Plan: veraltet nach 20 min", m2MaxS: 60, punkte: beide,
			stoer: func(l *zaLauf, t time.Duration) { l.cloudWeg = t >= 0 }},
		{zeile: "A4", ausfall: "Broker oder Internet für alle Boxen weg", haelt: true, nachZeit: "ohne Unterbrechung", m2MaxS: 60, punkte: beide,
			stoer: func(l *zaLauf, t time.Duration) { l.cloudWeg = t >= 0 }},
		{zeile: "A5", ausfall: "Internet nur für Box Verwaltung weg", haelt: true, nachZeit: "ohne Unterbrechung", m2MaxS: 60, punkte: beide,
			stoer: func(l *zaLauf, t time.Duration) { l.e4.internetWeg = t >= 0 }},
		{zeile: "A7", ausfall: "Netzzähler der führenden Box und Abgangszähler fehlen", haelt: true, nachZeit: "≤ 90 s nach dem letzten Wert", m2MaxS: 90, punkte: beide,
			stoer: func(l *zaLauf, t time.Duration) {
				l.e1.zaehlerFehlt = t >= 0
				l.e4.zaehlerFehlt = t >= 0
			}},
		{zeile: "A7e", ausfall: "Netzzähler der führenden Box friert ein", haelt: true, nachZeit: "≤ 90 s nach dem letzten Wert", m2MaxS: 90, punkte: beide, befund: befundA7Friert,
			stoer: func(l *zaLauf, t time.Duration) {
				if t == 0 {
					v := l.m.netz
					l.e1.friert = &v
				}
			}},
		{zeile: "A8", ausfall: "Uhr von Box Verwaltung springt 840 s vor (R10)", haelt: true, nachZeit: "ohne Unterbrechung", m2MaxS: 60, punkte: beide,
			stoer: func(l *zaLauf, t time.Duration) {
				if t == 0 {
					l.e4.uhr = 840 * time.Second
				}
			}},
		{zeile: "A8r", ausfall: "Uhr von Box Halle 1 springt 840 s zurück", haelt: true, nachZeit: "ohne Unterbrechung", m2MaxS: 60, punkte: beide, befund: befundA8Zurueck,
			stoer: func(l *zaLauf, t time.Duration) {
				if t == 0 {
					l.e1.uhr = -840 * time.Second
				}
			}},
		{zeile: "A9", ausfall: "Plan nicht zugestellt", haelt: true, nachZeit: "ohne Unterbrechung", m2MaxS: 60, punkte: beide,
			stoer: func(l *zaLauf, t time.Duration) { l.cloudWeg = t >= 0 }},
		{zeile: "A10", ausfall: "Änderung der Anteile nicht zugestellt / nicht quittiert", haelt: true, nachZeit: "unbegrenzt sicher", m2MaxS: 60, punkte: beide,
			stoer: zaA10},
		{zeile: "A11", ausfall: "zwei Befehlsquellen: Handeingriff gegen Plan", haelt: true, nachZeit: "sofort", m2MaxS: 60, punkte: beide,
			stoer: zaA11},
		{zeile: "A12", ausfall: "Box ohne die Fähigkeit (alter Edge-Stand)", haelt: true, nachZeit: "—", m2MaxS: 60, punkte: beide, e1ohneDok: true, e1PlanHeute: true,
			stoer: func(l *zaLauf, t time.Duration) { l.e4.schreibtNicht = true }},
		{zeile: "A13", ausfall: "Neustart mitten im Eingriff", haelt: true, nachZeit: "Hochfahrzeit der Box (Geräte-Rückfall trägt sie)", m2MaxS: 60, punkte: beide,
			stoer: zaA13},
		{zeile: "A14", ausfall: "Box-Tausch: Nachfolgerin steuert bis zur Bestätigung nicht mit", haelt: true, nachZeit: "—", m2MaxS: 60, punkte: beide,
			stoer: func(l *zaLauf, t time.Duration) { l.e4.schreibtNicht = t >= 0 }},
		{zeile: "A15", ausfall: "Box lebt, erreicht ihre Geräte nicht", haelt: true, nachZeit: "Wachhund des Geräts (≤ 60 s im Beispiel)", m2MaxS: 60, punkte: beide,
			stoer: func(l *zaLauf, t time.Duration) {
				if t == 0 {
					l.box(true).lanWeg = true
				}
			}},
		{zeile: "A18", ausfall: "Cloud-Datenbank zurückgespielt: Revision läuft rückwärts", haelt: true, nachZeit: "—", m2MaxS: 60, punkte: beide,
			stoer: zaA18},
		{zeile: "A20", ausfall: "das Ungeregelte wächst über seinen Vorbehalt (BEFUND)", haelt: false,
			nachZeit: "Erkennung nach einer Viertelstunde; Verengung in Sekunden — wenn die Box verbunden ist", m2MaxS: 60,
			punkte: []zaPunkt{zaNachtA20}, ende: 60 * time.Minute, stoer: zaA20},
	}
}

// box is the box the failure of a row hits in the current operating point:
// by day the leading box (it carries the feed-in loop), by night the one
// with the charge points (it carries the import share).
func (l *zaLauf) box(jeRichtung bool) *zaBox {
	if jeRichtung && l.m.sonneK1(l.m.now) == 0 {
		return l.e4
	}
	return l.e1
}

// A10 (R12): the transition 10/60 reaches both, Box Halle 1 (the narrowed one)
// acknowledges and gets the target 10/90 - the target never reaches Box
// Verwaltung. Then a replay of a lower revision and a document whose sum
// exceeds the limit: both are refused.
func zaA10(l *zaLauf, t time.Duration) {
	switch t {
	case 0:
		l.m.k1.rueckfallKw = 10 // R12: the installer set K-1's fallback to 10 kW
		for _, b := range []*zaBox{l.e1, l.e4} {
			ok, g := b.dokZustellen(l.t, l.m, zaDok(b.id, 2, "uebergang", 10, 60, 0, 77))
			l.notiz("%s Übergang 10/60: angenommen=%v %s", b.name, ok, g)
		}
	case 2 * time.Second:
		ok, g := l.e1.dokZustellen(l.t, l.m, zaDok(vaE1, 3, "ziel", 10, 90, 0, 77))
		l.notiz("Box Halle 1 Ziel 10/90: angenommen=%v %s; Box Verwaltung: nicht zugestellt", ok, g)
	case 60 * time.Second:
		ok, g := l.e4.dokZustellen(l.t, l.m, zaDok(vaE4, 1, "ziel", 40, 60, 0, 77))
		l.notiz("Box Verwaltung Revision 1 erneut: angenommen=%v %s", ok, g)
		ok, g = l.e4.dokZustellen(l.t, l.m, zaDokV(vaE4, 4, "ziel", 100, 77, 40, 70, 0, 77))
		l.notiz("Box Verwaltung Summe 110 > 100: angenommen=%v %s", ok, g)
	}
}

// A11 (R13): a manual intervention at Box Halle 1 - discharge the battery
// with 100 kW - outranks the plan in the arbitration; the share is a
// watchdog above it.
func zaA11(l *zaLauf, t time.Duration) {
	if t != 0 {
		return
	}
	a := l.e1.a
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "tenant_id": vaTenant, "site_id": vaSite, "device_id": vaE1,
		"revision": "ip27", "published_at": time.Now().UTC().Format(time.RFC3339),
		"entities": []map[string]any{{
			"entity_id": zaK2Entity, "entity_type": "battery-hybrid",
			"capabilities": map[string]any{
				"measure": []any{map[string]any{"channel": "soc_pct", "unit": "%"}},
				"actuate": []any{map[string]any{"command": "setpoint_kw", "min": -100.0, "max": 100.0}},
			},
			"guards": map[string]any{
				"limits":   map[string]any{"max_charge_kw": 100.0, "max_discharge_kw": 100.0, "soc_min_pct": 5.0, "soc_max_pct": 95.0},
				"failsafe": map[string]any{"behavior": "self-consumption"},
			},
		}},
	})
	reg, skipped, err := entities.ParseRegistryPush(raw, entities.Identity{TenantID: vaTenant, SiteID: vaSite, DeviceID: vaE1})
	if err != nil || len(skipped) != 0 {
		l.t.Fatalf("registry: skipped=%v err=%v", skipped, err)
	}
	a.applyEntityRegistry(reg)
	now := time.Now().UTC() // the arbitration keeps its TTL on the wall clock
	hand, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "entity_id": zaK2Entity,
		"request_id": "override:" + zaK2Entity + ":ip27",
		"source":     map[string]any{"kind": "local-ui"},
		"priority":   "flow", "override": true, "ttl_s": 3600,
		"issued_at": now.Format(time.RFC3339Nano),
		"command":   map[string]any{"type": "setpoint_kw", "value": -100.0},
	})
	a.arb.Submit(zaK2Entity, hand)
	a.arb.Tick()
	if id := a.batteryEntityID(); id != zaK2Entity {
		l.t.Fatalf("battery entity %q", id)
	}
	if _, kind, ok := a.arb.HolderCommand(zaK2Entity); !ok || kind == "" {
		l.t.Fatalf("manual intervention does not hold the battery")
	}
	l.notiz("Handeingriff an K-2: -100 kW (local-ui, Rang vor dem Plan)")
}

// A13 (R15): the box restarts in the middle of curtailing; 45 s boot time.
// By day the leading box (R15), by night the one with the charge points.
func zaA13(l *zaLauf, t time.Duration) {
	b := l.box(true)
	switch t {
	case 0:
		b.aus = true
	case 45 * time.Second:
		b.starte(l.t)
		b.aus = false
		b.planZustellen(l.m) // retained, on reconnect
		an := b.a.exportAnteil()
		if an == nil {
			l.t.Fatalf("%s: no share after the restart", b.name)
		}
		l.notiz("%s nach dem Neustart: Anteil Einspeisung %.1f kW vor dem ersten Messwert", b.name, an.AnteilKw)
	}
}

// A18: the cloud database is played back - revision 5 is live on both boxes,
// then a document of revision 4 with swapped shares reaches both.
func zaA18(l *zaLauf, t time.Duration) {
	switch t {
	case -time.Minute:
		for _, b := range []*zaBox{l.e1, l.e4} {
			if ok, g := b.dokZustellen(l.t, l.m, zaDok(b.id, 5, "ziel", 40, 60, 0, 77)); !ok {
				l.t.Fatalf("%s revision 5: %s", b.name, g)
			}
		}
	case 0:
		for _, b := range []*zaBox{l.e1, l.e4} {
			ok, g := b.dokZustellen(l.t, l.m, zaDok(b.id, 4, "ziel", 60, 40, 77, 0))
			l.notiz("%s Revision 4 nach 5 (60/40 · 77/0): angenommen=%v %s", b.name, ok, g)
		}
	}
}

// A20 (R23): at night the uncontrolled load grows from its measured maximum
// 430 kW to 480 kW at 13:15 - over its Vorbehalt of 473 kW. The cloud narrows
// by itself after the first complete quarter hour (runner at minute 40,
// 10 min after the end of the quarter 13:15-13:30, IP-13 Folge): new Vorbehalt
// 495 kW, share of Box Verwaltung 77 -> 55 kW (the numbers of the matrix row).
var zaNachtA20 = zaPunkt{
	name: "Nacht", richtung: "Bezug", e1BattKw: 100,
	grundlast: func(t time.Duration) float64 {
		if t >= 5*time.Minute {
			return 480
		}
		return 430
	},
	sonneK1:  func(time.Duration) float64 { return 0 },
	sonneK12: func(time.Duration) float64 { return 0 },
	autos:    func(time.Duration) float64 { return 22 },
}

func zaA20(l *zaLauf, t time.Duration) {
	if t != 30*time.Minute+5*time.Second {
		return
	}
	for _, b := range []*zaBox{l.e1, l.e4} {
		ok, g := b.dokZustellen(l.t, l.m, zaDok(b.id, 2, "ziel", 40, 60, 0, 55))
		l.notiz("%s Verengung Bezug 0/55 um %s: angenommen=%v %s", b.name, l.m.now.Add(2*time.Hour).Format("15:04:05"), ok, g)
	}
}

// TestZweiAgentenAusfallmatrix is NW-2: every row of the matrix as a table
// case, M-1 and M-2 measured at the connection point of the model.
func TestZweiAgentenAusfallmatrix(t *testing.T) {
	if testing.Short() {
		t.Skip("two agents, 45 simulated minutes per case")
	}
	begann := time.Now()
	var ergebnisse []zaErgebnis
	for _, f := range zaFaelle() {
		for _, p := range f.punkte {
			f, p := f, p
			t.Run(f.zeile+"/"+p.name, func(t *testing.T) {
				r := zaFahre(t, f, p)
				ergebnisse = append(ergebnisse, r)
				for _, n := range r.notizen {
					t.Logf("%s", n)
				}
				t.Logf("%s", zaZeile(r))
				switch {
				case r.befund != nil:
					zaBefundGezeigt(t, r)
				case !f.haelt:
					zaBefundA20(t, r)
				case !r.ok:
					t.Errorf("%s hält laut Matrix (%s) - gemessen: %s", f.zeile, f.nachZeit, zaZeile(r))
				}
			})
		}
	}
	lauf := time.Since(begann)
	pfad := filepath.Join(os.TempDir(), "ip27-zwei-agenten-protokoll.md")
	if err := os.WriteFile(pfad, []byte(zaProtokoll(ergebnisse, lauf)), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("Testprotokoll: %s (%d Fälle, Laufzeit %.1f s)", pfad, len(ergebnisse), lauf.Seconds())
}

// zaBefundA20: the excess is SHOWN and quantified until the narrowing
// arrives - 480 + 77 = 557 kW, 7 kW over the limit - and the limit holds
// again after it (480 + 55 = 535 kW).
func zaBefundA20(t *testing.T, r zaErgebnis) {
	t.Helper()
	b := r.bez
	if b.groessteUeberKw < 7-0.01 || b.groessteUeberKw > 7+0.01 {
		t.Errorf("A20: größte Überschreitung %.3f kW, erwartet 7 kW (480 + 77 − 550)", b.groessteUeberKw)
	}
	if b.hoechstesViertel().mittel <= zaBezugsgrenze {
		t.Errorf("A20: die Überschreitung muss im Viertelstunden-Mittel sichtbar sein: %+v", b.viertel)
	}
	letztes := b.viertel[len(b.viertel)-1]
	if letztes.mittel > zaBezugsgrenze+zaEps {
		t.Errorf("A20: nach der Verengung hält die Grenze wieder - letzte Viertelstunde %.3f kW", letztes.mittel)
	}
}

// zaBefundGezeigt: the pinned finding is still there with its numbers
// (feed-in, the direction of both findings). Vanished = healed: flip the row;
// grown = worse than documented.
func zaBefundGezeigt(t *testing.T, r zaErgebnis) {
	t.Helper()
	b, e := r.befund, r.ein
	if e.sekundenUeber == 0 {
		t.Errorf("%s/%s: der Befund ist verschwunden (M-1 %.1f kW, keine Sekunde über der Grenze) - geheilt? "+
			"Dann die Befund-Variable der Zeile auf nil setzen: die Zeile muss nach der Matrix halten", r.fall.zeile, r.punkt.name, e.hoechstesViertel().mittel)
		return
	}
	h := e.hoechstesViertel().mittel
	if math.Abs(e.groessteUeberKw-b.groessteUeberKw) > 0.1 || e.laengsteUeber < b.laengsteS-5 || e.laengsteUeber > b.laengsteS+5 ||
		math.Abs(h-b.viertelKw) > 0.1 {
		t.Errorf("%s/%s: der Befund hat sich verändert - festgehalten +%.1f kW, %d s, Viertel %.1f kW; gemessen +%.1f kW, %d s, Viertel %.1f kW",
			r.fall.zeile, r.punkt.name, b.groessteUeberKw, b.laengsteS, b.viertelKw, e.groessteUeberKw, e.laengsteUeber, h)
	}
}

func zaUrteil(r zaErgebnis) string {
	switch {
	case r.befund != nil:
		return "BEFUND (Matrix: hält) – Heilungspaket"
	case !r.fall.haelt && r.bez.sekundenUeber > 0:
		return "BEFUND gezeigt"
	case r.ok:
		return "hält"
	case !r.m1ok:
		return "ROT (M-1)"
	default:
		return "ROT (M-2)"
	}
}

func zaZeile(r zaErgebnis) string {
	f := func(s *zaMessung) string {
		h := s.hoechstesViertel()
		return fmt.Sprintf("%.1f kW (%s) | %.1f kW | %d s | %d s",
			h.mittel, h.start.Add(2*time.Hour).Format("15:04"), s.groessteUeberKw, s.laengsteUeber, s.sekundenUeber)
	}
	return fmt.Sprintf("| %s | %s | %s | %s | %s | %s |", r.fall.zeile, r.punkt.name, f(r.ein), f(r.bez), r.fall.nachZeit, zaUrteil(r))
}

func zaProtokoll(rs []zaErgebnis, lauf time.Duration) string {
	var b strings.Builder
	b.WriteString("# IP-27 Zwei-Agenten-Test — Testprotokoll (NW-2)\n\n")
	b.WriteString("Anlage AN-1 am Netzanschluss NA-1: Einspeisegrenze 100 kW (Anteile 40/60), Bezugsgrenze 550 kW " +
		"(Vorbehalt 473, Anteile 0/77). Ausfall um 13:10:00, gemessen 13:00–13:45 (A20 bis 14:00), " +
		"Uhrzeiten in Ortszeit. M-1 = höchstes Viertelstunden-Mittel am Netzpunkt des Modells; M-2 = größte " +
		"Überschreitung, längste Dauer am Stück, Sekunden gesamt.\n\n")
	b.WriteString("| Zeile | Punkt | Einspeisung: M-1 höchstes Viertel | M-2 größte Überschr. | längste | gesamt | " +
		"Bezug: M-1 höchstes Viertel | M-2 größte Überschr. | längste | gesamt | Matrix: nach welcher Zeit | Urteil |\n")
	b.WriteString("|---|---|---|---|---|---|---|---|---|---|---|---|\n")
	for _, r := range rs {
		b.WriteString(zaZeile(r) + "\n")
	}
	b.WriteString("\n")
	for _, r := range rs {
		if r.befund != nil {
			fmt.Fprintf(&b, "- **Befund %s/%s:** %s. Heilungsrichtung: %s.\n", r.fall.zeile, r.punkt.name, r.befund.ursache, r.befund.heilung)
		}
	}
	for _, r := range rs {
		for _, n := range r.notizen {
			fmt.Fprintf(&b, "- %s/%s: %s\n", r.fall.zeile, r.punkt.name, n)
		}
	}
	fmt.Fprintf(&b, "\nLaufzeit: %.1f s für %d Fälle (Testuhr, je Fall 45 simulierte Minuten, A20 60).\n", lauf.Seconds(), len(rs))
	return b.String()
}
