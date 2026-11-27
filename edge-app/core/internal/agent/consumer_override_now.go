package agent

// Zweite Runde von vp-schalten-sofort (Captain-Befund auf PR #2035, 26.11.2026):
// consumer_status_kick.go machte die MELDUNG schnell, sobald die Box etwas
// zurückgelesen hatte - aber ein Handeingriff selbst wartete noch bis zu
// consumerControlTick (5 s), bevor die Box überhaupt schaltete, und seine
// Bestätigung konnte an statusKickMinGap (5 s) hängen bleiben, wenn kurz
// zuvor ein anderer Herzschlag lief. Ziel: "etwa eine Sekunde" von Klick bis
// bestätigtem Zustand im Portal-Datenweg.
//
// Zwei unabhängige, eng begrenzte Ausnahmen - keine davon ändert, WAS die
// Steuerlogik entscheidet, nur WANN die Box das schon entschiedene Ergebnis
// schreibt bzw. meldet:
//
//  1. Ein eingehender Handeingriff weckt consumerControlLoop SOFORT (dieselbe
//     Runde über go-e/Shelly/Ebyte wie am regulären Takt), statt bis zu 5 s zu
//     warten. Der Haken sitzt in onEntityDesired NACH arb.Submit (arbitiert,
//     geklemmt, Schutzgrenzen/Mindestlauf-Mindestpause bereits angewandt) -
//     die Box liest also nur FRÜHER, was die Steuerlogik ohnehin schon
//     entschieden hat; eine greifende Schutzregel lehnt genauso ab wie vorher,
//     nur dass die Ablehnung jetzt sofort im Herzschlag steht statt erst nach
//     dem nächsten Takt.
//  2. GENAU die erste Rücklesung nach einem Handeingriff (Start oder
//     "Automatik fortsetzen") darf den Herzschlag ohne statusKickMinGap
//     anfordern - ein eigener, unbegrenzter Kanal in statusHeartbeatLoop. Die
//     Markierung ist ein EINMAL-Flag je Entität (onDesiredDownlink setzt es,
//     onEntityReadback verbraucht es); jede WEITERE Änderung (Wiederholung,
//     automatische Entscheidung, Flattern) bleibt auf dem normalen,
//     ratenbegrenzten Kanal - die Ausnahme gilt nur der einen Bestätigung, die
//     ein Mensch gerade erwartet.

import (
	"encoding/json"
	"log/slog"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
)

// requestConsumerControlNow weckt consumerControlLoop ohne zu blockieren -
// dieselbe Coalescing-Form wie requestStatusHeartbeat.
func (a *Agent) requestConsumerControlNow() {
	select {
	case a.consumerControlKick() <- struct{}{}:
	default:
	}
}

func (a *Agent) consumerControlKick() chan struct{} {
	a.consumerKickOnce.Do(func() { a.consumerKickCh = make(chan struct{}, 1) })
	return a.consumerKickCh
}

// requestPriorityStatusHeartbeat ist der Kanal OHNE statusKickMinGap - nur für
// die eine Bestätigung, die markPriorityConfirm angekündigt hat.
func (a *Agent) requestPriorityStatusHeartbeat() {
	select {
	case a.priorityStatusKick() <- struct{}{}:
	default:
	}
}

func (a *Agent) priorityStatusKick() chan struct{} {
	a.priorityKickOnce.Do(func() { a.priorityKickCh = make(chan struct{}, 1) })
	return a.priorityKickCh
}

// markPriorityConfirm kündigt an, dass die NÄCHSTE Antwort zu dieser Entität
// die eines Handeingriffs ist (Start und Rücknahme). Einmal-Flag mit dem
// Zeitpunkt der Ankündigung: takePriorityConfirm löscht es beim Verbrauch,
// eine spätere, unabhängige Änderung bekommt die Ausnahme nicht noch einmal.
func (a *Agent) markPriorityConfirm(entityID string) {
	a.priorityConfirmMu.Lock()
	if a.priorityConfirmPending == nil {
		a.priorityConfirmPending = map[string]time.Time{}
	}
	a.priorityConfirmPending[entityID] = time.Now()
	a.priorityConfirmMu.Unlock()
}

// takePriorityConfirm liest UND löscht das Flag (true höchstens einmal je
// markPriorityConfirm-Aufruf).
func (a *Agent) takePriorityConfirm(entityID string) bool {
	a.priorityConfirmMu.Lock()
	defer a.priorityConfirmMu.Unlock()
	if _, ok := a.priorityConfirmPending[entityID]; ok {
		delete(a.priorityConfirmPending, entityID)
		return true
	}
	return false
}

// Dritte Runde (vp-schalten-3s, Captain 27.11.2026, "mehr als 30 Sekunden"):
// die Ausnahme hing allein an einer RÜCKLESUNG. Schreibt die Box nichts, weil
// eine Schutzregel den Wunsch hält (Mindestlauf/-pause des Heizstab-Profils,
// je 300 s) oder weil der gewünschte Stand schon anliegt, kommt keine
// Rücklesung - und die Antwort, die die Box nach Millisekunden kennt, wartete
// auf den nächsten statusHeartbeatEvery (15 s). Beide Fälle antworten jetzt
// selbst, mit demselben Einmal-Flag: entweder die Rücklesung ODER eine dieser
// Antworten verbraucht es, nie beide.

// answerManualDesired läuft in onEntityDesired direkt nach arb.Submit: ist der
// Wunsch ein Handeingriff (Quelle local-ui), kündigt es seine Antwort an; hält
// eine Schutzregel ihn, steht die Antwort schon jetzt fest.
func (a *Agent) answerManualDesired(entityID string, payload []byte) {
	var msg struct {
		Source struct {
			Kind string `json:"kind"`
		} `json:"source"`
	}
	if json.Unmarshal(payload, &msg) != nil || msg.Source.Kind != string(desired.SourceLocalUI) {
		return
	}
	a.markPriorityConfirm(entityID)
	a.answerIfHeld(entityID)
}

// answerIfHeld sendet die Antwort sofort, wenn die Entscheidung des
// Schiedsrichters eine Schutzregel nennt: geschrieben wird dann nichts Neues.
func (a *Agent) answerIfHeld(entityID string) {
	if a.arb == nil {
		return
	}
	if dec, ok := a.arb.DecisionFor(entityID); ok && dec.Cycle != nil && a.takePriorityConfirm(entityID) {
		slog.Info("Handeingriff gehalten - Antwort sofort", "entity", entityID, "grund", dec.Cycle.Code)
		a.requestPriorityStatusHeartbeat()
	}
}

// answerUnchanged: ein Steuer-Durchgang, der NACH der Ankündigung begann,
// fand für diese Entität nichts zu schreiben - die Antwort ist der Stand, der
// schon anliegt. Ein älterer Durchgang las noch den vorigen Wunsch und zählt
// nicht.
func (a *Agent) answerUnchanged(entityID string, passStart time.Time) {
	a.priorityConfirmMu.Lock()
	at, ok := a.priorityConfirmPending[entityID]
	if ok && !passStart.Before(at) {
		delete(a.priorityConfirmPending, entityID)
	} else {
		ok = false
	}
	a.priorityConfirmMu.Unlock()
	if ok {
		a.requestPriorityStatusHeartbeat()
	}
}
