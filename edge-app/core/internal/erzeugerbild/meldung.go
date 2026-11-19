package erzeugerbild

import (
	"math"
	"strings"
	"time"
)

// Meldung decides when a value of the image is SENT - the twin of
// erzeuger-meldung.js. The box reads the image every 5 s; it does not send
// every value every 5 s (a plant with ten units would exceed 1 100 values a
// minute). The rule per field class:
//
//   - schnell (powers, set values, effective limit): as soon as the value
//     moves by more than the field's dead band (0 = every change), at the
//     latest after cadence_s.
//   - zustand (states, bit fields, plant figures): on every change, at the
//     latest after cadence_s - the cloud's state_change needs every change.
//   - zaehler (counters, "seit", meter reading): at the selection's cadence.
//
// cadence_s is the LONGEST gap between two values, not the read rate. A new
// quality is always sent at once; a value that vanishes clears the state - the
// next value is the first again.
type Meldung struct {
	stand map[string]meldeStand
}

type meldeStand struct {
	wert      float64
	qualitaet string
	zeit      time.Time
}

// MeldeSchluessel is the key of a value: target, component, point.
func MeldeSchluessel(ziel, entityID, pointKey string) string {
	return ziel + "\x00" + entityID + "\x00" + pointKey
}

// Soll reports whether this value is to be sent now, and remembers it if so.
func (m *Meldung) Soll(schluessel string, v Wert, cadence time.Duration, jetzt time.Time) bool {
	if m.stand == nil {
		m.stand = map[string]meldeStand{}
	}
	if v.Qualitaet == "" {
		delete(m.stand, schluessel)
		return false
	}
	vergleich := float64(v.Roh)
	if v.Wert != nil {
		vergleich = *v.Wert
	}
	vorher, da := m.stand[schluessel]
	merke := func() bool {
		m.stand[schluessel] = meldeStand{wert: vergleich, qualitaet: v.Qualitaet, zeit: jetzt}
		return true
	}
	if !da || vorher.qualitaet != v.Qualitaet {
		return merke()
	}
	if jetzt.Sub(vorher.zeit) >= cadence {
		return merke()
	}
	switch v.Klasse {
	case "zustand":
		if vergleich != vorher.wert {
			return merke()
		}
	case "schnell":
		band := 0.0
		if v.Totband != nil {
			band = *v.Totband
		}
		if math.Abs(vergleich-vorher.wert) > band+1e-9 {
			return merke()
		}
	}
	return false
}

// VergissZiel forgets every state of a target (read failed, foreign image).
func (m *Meldung) VergissZiel(ziel string) {
	praefix := ziel + "\x00"
	for k := range m.stand {
		if strings.HasPrefix(k, praefix) {
			delete(m.stand, k)
		}
	}
}

// VergissAlles starts every value afresh (a new plan).
func (m *Meldung) VergissAlles() { m.stand = nil }
