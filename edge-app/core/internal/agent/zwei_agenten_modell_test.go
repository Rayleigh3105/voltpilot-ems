package agent

// AP-15 IP-27 (NW-2, E6 = A), part 1: ONE plant model in the process. It is
// the physics the two real agents of zwei_agenten_test.go regulate against -
// Anlage AN-1 "Werk Ahrenberg - Halle 1" at the connection point NA-1 with
// the extension 1.5 of the reference company (Box Halle 1 E-1 leads, Box
// Verwaltung E-4 controls along).
//
//	NA-1 (Netzpunkt: 100 kW Einspeisung, 550 kW Bezug) - measured by E-1 (DQ-2)
//	├── Abgang Halle 1:     ungeregelte Last, K-1 PV 100 kW, K-2 Speicher 100 kW
//	└── Abgang Verwaltung:  K-12 PV 60 kW, K-13.1 … K-13.6 Ladepunkte je 22 kW
//	                        measured by E-4 (DQ-10) - behind it only what E-4 controls
//
// Signs as in every contract of the box: grid + import / - export, battery
// + charge / - discharge. The model steps one second at a time on a test
// clock; nothing here sleeps.
//
// Device fallbacks are those of the reference file 1.5 (geraete_rueckfall):
// K-1 holds its last value 60 s and then falls to 40 kW, K-2 falls to 0 after
// 60 s, K-12 has no fallback value and runs free with its nominal power, the
// six charge points fall to their stored default of 4,1 kW each after 60 s.

import (
	"math"
	"time"
)

const (
	zaSchreibTakt = 10 * time.Second // a box writes its devices every control tick
	zaStellzeit   = 1 * time.Second  // Modbus/OCPP write until the device takes it
)

// zaGeraet is one controllable device: it follows the last command it
// received, with a ramp, and falls back when commands stop.
type zaGeraet struct {
	name        string
	nennKw      float64
	rampeKwS    float64
	frei        bool    // no fallback value: runs free with its nominal power
	rueckfallKw float64 // fallback value (frei = false)
	nachS       time.Duration

	soll      float64   // commanded value (PV: limit, battery: setpoint, charge point: allocation)
	hatSoll   bool      // a command was ever received
	befehlAm  time.Time // last command that reached the device
	wirkt     float64   // the value the device regulates to (ramped)
	anstehend []zaBefehl
}

type zaBefehl struct {
	ab time.Time
	kw float64
}

// befehl queues a write that takes effect after zaStellzeit.
func (g *zaGeraet) befehl(now time.Time, kw float64) {
	g.anstehend = append(g.anstehend, zaBefehl{ab: now.Add(zaStellzeit), kw: kw})
}

// ziel is what the device regulates to this second: its command, or its
// fallback once commands stopped for longer than its watchdog.
func (g *zaGeraet) ziel(now time.Time) (float64, bool) {
	for len(g.anstehend) > 0 && !g.anstehend[0].ab.After(now) {
		g.soll, g.hatSoll, g.befehlAm = g.anstehend[0].kw, true, g.anstehend[0].ab
		g.anstehend = g.anstehend[1:]
	}
	watchdog := g.nachS
	if watchdog < zaSchreibTakt+zaStellzeit {
		// A device without its own delay still sees the write cycle: it
		// falls back once one write is missing.
		watchdog = zaSchreibTakt + zaStellzeit
	}
	if !g.hatSoll || now.Sub(g.befehlAm) > watchdog {
		if g.frei {
			return g.nennKw, true
		}
		return g.rueckfallKw, true
	}
	return g.soll, false
}

func (g *zaGeraet) schritt(now time.Time, dt float64) {
	z, _ := g.ziel(now)
	d := z - g.wirkt
	max := g.rampeKwS * dt
	if math.Abs(d) > max {
		d = math.Copysign(max, d)
	}
	g.wirkt += d
}

// zaAnlage is the plant: the uncontrolled load and the sun are time series,
// the devices follow their boxes.
type zaAnlage struct {
	now time.Time

	grundlast func(time.Time) float64 // everything no box controls (kW)
	sonneK1   func(time.Time) float64 // available PV K-1 (kW)
	sonneK12  func(time.Time) float64 // available PV K-12 (kW)
	autos     func(time.Time) float64 // demand of each plugged car (kW, 0 = none)

	k1, k12 *zaGeraet
	k2      *zaGeraet
	k13     [6]*zaGeraet

	// measured, this second
	pvK1, pvK12, battK2, ladenK13, netz, abgangE4 float64
}

func neueAnlage(start time.Time) *zaAnlage {
	m := &zaAnlage{now: start}
	m.k1 = &zaGeraet{name: "K-1", nennKw: 100, rampeKwS: 10, rueckfallKw: 40, nachS: 60 * time.Second}
	m.k12 = &zaGeraet{name: "K-12", nennKw: 60, rampeKwS: 6, frei: true}
	m.k2 = &zaGeraet{name: "K-2", nennKw: 100, rampeKwS: 25, rueckfallKw: 0, nachS: 60 * time.Second}
	for i := range m.k13 {
		m.k13[i] = &zaGeraet{name: "K-13", nennKw: 22, rampeKwS: 5.5, rueckfallKw: 4.1, nachS: 60 * time.Second}
	}
	return m
}

// schritt advances the plant by one second and computes every flow.
func (m *zaAnlage) schritt() {
	m.now = m.now.Add(time.Second)
	for _, g := range m.alle() {
		g.schritt(m.now, 1)
	}
	m.pvK1 = math.Min(math.Max(m.k1.wirkt, 0), m.sonneK1(m.now))
	m.pvK12 = math.Min(math.Max(m.k12.wirkt, 0), m.sonneK12(m.now))
	m.battK2 = m.k2.wirkt
	m.ladenK13 = 0
	for _, g := range m.k13 {
		m.ladenK13 += math.Min(math.Max(g.wirkt, 0), m.autos(m.now))
	}
	m.abgangE4 = m.ladenK13 - m.pvK12
	m.netz = m.grundlast(m.now) + m.battK2 - m.pvK1 + m.abgangE4
}

func (m *zaAnlage) alle() []*zaGeraet {
	return []*zaGeraet{m.k1, m.k12, m.k2, m.k13[0], m.k13[1], m.k13[2], m.k13[3], m.k13[4], m.k13[5]}
}

// zaMessung is M-1 and M-2 at the model's connection point (§4.12).
type zaMessung struct {
	grenzeKw float64
	richtung int // +1 Bezug, -1 Einspeisung

	// M-2: seconds above the limit, the longest stretch and the largest excess
	sekundenUeber, laengsteUeber, lauf int
	groessteUeberKw                    float64
	ersteUeber                         time.Time

	// M-1: mean per complete quarter hour of the meter (fixed quarters)
	viertel      []zaViertel
	summe        float64
	n            int
	viertelStart time.Time
}

type zaViertel struct {
	start  time.Time
	mittel float64
}

const zaEps = 1e-6

func (s *zaMessung) nimm(now time.Time, netzKw float64) {
	wert := math.Max(float64(s.richtung)*netzKw, 0)
	if ueber := wert - s.grenzeKw; ueber > zaEps {
		if s.sekundenUeber == 0 {
			s.ersteUeber = now
		}
		s.sekundenUeber++
		s.lauf++
		s.laengsteUeber = max(s.laengsteUeber, s.lauf)
		s.groessteUeberKw = math.Max(s.groessteUeberKw, ueber)
	} else {
		s.lauf = 0
	}
	// the sample of second (now-1s, now] belongs to the quarter of now-1s
	q := now.Add(-time.Second).Truncate(15 * time.Minute)
	if !q.Equal(s.viertelStart) {
		if s.n == 900 {
			s.viertel = append(s.viertel, zaViertel{start: s.viertelStart, mittel: s.summe / 900})
		}
		s.viertelStart, s.summe, s.n = q, 0, 0
	}
	s.summe += wert
	s.n++
}

// schluss closes the last quarter (only complete quarters count).
func (s *zaMessung) schluss() {
	if s.n == 900 {
		s.viertel = append(s.viertel, zaViertel{start: s.viertelStart, mittel: s.summe / 900})
	}
	s.n = 0
}

// hoechstesViertel is M-1's number: the highest quarter-hour mean.
func (s *zaMessung) hoechstesViertel() zaViertel {
	var h zaViertel
	for i, v := range s.viertel {
		if i == 0 || v.mittel > h.mittel {
			h = v
		}
	}
	return h
}
