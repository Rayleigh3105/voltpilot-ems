package agent

// Der Herzschlag folgt einem Verbraucher sofort, wenn sich an ihm etwas
// SICHTBARES ändert (Schaltung übernommen, Stufe wechselt, eine Abweichung
// beginnt oder endet), statt bis zu statusHeartbeatEvery auf den nächsten
// Takt zu warten - derselbe Wächter wie ocpp_status_kick.go, hier für jeden
// Verbraucher, dessen Rücklesung über onEntityReadback ankommt (go-e,
// Shelly/Heizstab, Ebyte). Schreiben und Rücklesen sind schon schnell
// (consumerControlTick); ohne diesen Wächter wartete nur die Meldung an die
// Cloud auf den nächsten regulären Takt (Captain-Befund beim Heizstab-
// Schalten in "Wie der Kunde es sieht", vp-schalten-sofort). Der Wächter
// hängt bewusst an der RÜCKLESUNG, nicht am Steuer-Takt: das hält ihn so nah
// wie möglich am tatsächlichen "jetzt weiß die Box es" statt an einem festen
// Takt, der selbst bis zu consumerControlTick alt sein kann.
//
// Gemessene Werte (actual_kw, Tageszähler, verfügbarer Überschuss) bleiben
// draußen: ein laufender Verbraucher ändert sie ständig, und der reguläre
// Takt trägt sie wie bisher. Reine Sichtbarkeit: der Wächter schreibt
// nichts und entscheidet nichts.

import (
	"sort"
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
)

// noteConsumerReadback asks for an early status heartbeat when the consumers
// block's visible fingerprint moved since the last look - called from
// onEntityReadback right after a per-entity readback lands. consumerFPOnce
// seeds the baseline on the very first call (a box that just started asks
// for nothing), exactly like ocppStatusWatch.
func (a *Agent) noteConsumerReadback() {
	fp := consumersStatusFingerprint(a.consumersSummary())
	a.consumerFPMu.Lock()
	seeded := a.consumerFPSeeded
	changed := seeded && fp != a.consumerFP
	a.consumerFP, a.consumerFPSeeded = fp, true
	a.consumerFPMu.Unlock()
	if changed {
		a.requestStatusHeartbeat()
	}
}

// consumersStatusFingerprint is what the consumers block shows a customer, in
// words: a change here is one visible on the Verbraucher-/Heizstab-card. See
// the package comment above for what is deliberately left out.
func consumersStatusFingerprint(cs cloud.ConsumersSummary) string {
	ids := make([]string, 0, len(cs))
	for id := range cs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var b strings.Builder
	for _, id := range ids {
		e := cs[id]
		b.WriteString(id)
		b.WriteByte('|')
		b.WriteString(e.State)
		b.WriteByte('|')
		b.WriteString(e.ReasonCode)
		b.WriteByte('|')
		switch {
		case e.Confirmed == nil:
			b.WriteByte('?')
		case *e.Confirmed:
			b.WriteByte('1')
		default:
			b.WriteByte('0')
		}
		if s := e.Stage; s != nil {
			b.WriteByte('|')
			b.WriteString(strconv.Itoa(s.Commanded))
			b.WriteByte('/')
			if s.Confirmed != nil {
				b.WriteString(strconv.Itoa(*s.Confirmed))
			} else {
				b.WriteByte('?')
			}
			b.WriteByte('/')
			outputs := append([]int(nil), s.OutputsOn...)
			sort.Ints(outputs)
			for i, ch := range outputs {
				if i > 0 {
					b.WriteByte(',')
				}
				b.WriteString(strconv.Itoa(ch))
			}
			b.WriteByte('/')
			b.WriteString(s.MismatchSince)
		}
		if h := e.Heizstab; h != nil {
			b.WriteByte('|')
			b.WriteString(strconv.Itoa(h.Stufe))
			b.WriteByte('/')
			b.WriteString(strconv.Itoa(h.Ausgaenge))
			b.WriteByte('/')
			b.WriteString(h.Code)
			b.WriteByte('/')
			b.WriteString(h.Grund)
		}
		b.WriteByte('\n')
	}
	return b.String()
}
