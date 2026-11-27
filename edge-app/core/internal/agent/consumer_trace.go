package agent

// Schaltspur der Box (vp-schalten-3s, Captain 27.11.2026: „mehr als 30
// Sekunden - bitte rausfinden, wo die Zeit hingeht"). Ein Handeingriff aus dem
// Portal trägt seine Kennung als request_id ("override:<entity>:<spur>", der
// Vertrag kennt die request_id als die eine Korrelation je Aussendung). Die
// Box hält je Verbraucher die Zeitpunkte des JÜNGSTEN Handeingriffs in ihrer
// eigenen Uhr fest und meldet sie im Herzschlag (consumers.{id}.trace):
//
//	received_at   der Umschlag kam über die Cloud-Verbindung an
//	admitted_at   Schiedsrichter und Schutzregeln haben entschieden
//	written_at    die letzte Schaltanfrage ans Gerät kam zurück (Shelly)
//	read_back_at  die Rücklesung ist da
//	outcome       written | unchanged | held | failed | withdrawn
//	reason_code   bei held der Grund der Schutzregel (guard_min_on, ...)
//
// Reine Sichtbarkeit: die Spur entscheidet nichts und schreibt nichts. Was die
// Box NICHT weiß, bleibt leer - ein fehlender Zeitpunkt heißt "dieser Schritt
// fand nicht statt" (etwa: eine Schutzregel hielt den Wunsch, es wurde nichts
// geschrieben), nie "sofort".

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shelly"
)

// consumerTraceWindow ist, wie lange die Box eine Spur im Herzschlag weiter
// meldet: lang genug, dass ein verlorener Herzschlag sie nicht verschluckt,
// kurz genug, dass der Block danach wieder fehlt.
const consumerTraceWindow = 10 * time.Minute

// Die Urteile der Box über einen Handeingriff.
const (
	traceWritten   = "written"
	traceUnchanged = "unchanged"
	traceHeld      = "held"
	traceFailed    = "failed"
	traceWithdrawn = "withdrawn"
)

type consumerTrace struct {
	requestID  string
	receivedAt time.Time
	admittedAt time.Time
	writtenAt  time.Time
	readBackAt time.Time
	outcome    string
	reasonCode string
}

type consumerTraces struct {
	mu sync.Mutex
	m  map[string]*consumerTrace
}

// traceReceived beginnt die Spur eines Handeingriffs; ein neuer Eingriff
// ersetzt die vorige Spur dieses Verbrauchers (derselbe Quellslot der Box).
func (a *Agent) traceReceived(entityID, requestID string, now time.Time) {
	if requestID == "" {
		return
	}
	a.traces.mu.Lock()
	if a.traces.m == nil {
		a.traces.m = map[string]*consumerTrace{}
	}
	a.traces.m[entityID] = &consumerTrace{requestID: requestID, receivedAt: now}
	a.traces.mu.Unlock()
	slog.Info("Schaltspur: Handeingriff empfangen", "spur", requestID, "entity", entityID)
}

// traceAdmitted hält fest, dass Schiedsrichter und Schutzregeln über DIESEN
// Handeingriff entschieden haben - nur, wenn requestID die offene Spur ist.
func (a *Agent) traceAdmitted(entityID, requestID string, now time.Time, outcome, reason string) {
	a.traces.mu.Lock()
	t := a.traces.m[entityID]
	if t == nil || t.requestID != requestID || !t.admittedAt.IsZero() {
		a.traces.mu.Unlock()
		return
	}
	t.admittedAt, t.outcome, t.reasonCode = now, outcome, reason
	nach := now.Sub(t.receivedAt)
	a.traces.mu.Unlock()
	slog.Info("Schaltspur: entschieden", "spur", requestID, "entity", entityID, "nach", nach,
		"urteil", outcome, "grund", reason)
}

// traceAdmittedFromDesired liest die request_id aus einem lokalen Wunsch und
// stempelt "entschieden" samt dem Urteil der Schutzregeln, wenn er die offene
// Spur dieses Verbrauchers ist (onEntityDesired, nach arb.Submit).
func (a *Agent) traceAdmittedFromDesired(entityID string, payload []byte, now time.Time) {
	a.traces.mu.Lock()
	t := a.traces.m[entityID]
	open := t != nil && t.admittedAt.IsZero()
	a.traces.mu.Unlock()
	if !open {
		return
	}
	var msg struct {
		RequestID string `json:"request_id"`
	}
	if json.Unmarshal(payload, &msg) != nil || msg.RequestID == "" {
		return
	}
	outcome, reason := "", ""
	if a.arb != nil {
		if dec, ok := a.arb.DecisionFor(entityID); ok && dec.Cycle != nil {
			outcome, reason = traceHeld, dec.Cycle.Code
		}
	}
	a.traceAdmitted(entityID, msg.RequestID, now, outcome, reason)
}

// traceExecuted stempelt Schreiben und Rücklesen eines Steuer-Durchgangs, der
// NACH der Entscheidung begann (ein älterer Durchgang las noch den alten
// Wunsch). wroteAt ist null, wenn der Durchgang nichts schrieb.
func (a *Agent) traceExecuted(entityID string, passStart, wroteAt, readAt time.Time, ok bool) {
	a.traces.mu.Lock()
	t := a.traces.m[entityID]
	if t == nil || t.admittedAt.IsZero() || !t.readBackAt.IsZero() || passStart.Before(t.admittedAt) {
		a.traces.mu.Unlock()
		return
	}
	t.writtenAt, t.readBackAt = wroteAt, readAt
	switch {
	case !ok:
		t.outcome = traceFailed
	case t.outcome == traceHeld:
		// Eine Schutzregel hielt den Wunsch; was hier lief, war der gehaltene Stand.
	case !wroteAt.IsZero():
		t.outcome = traceWritten
	default:
		t.outcome = traceUnchanged
	}
	id, rec, out := t.requestID, t.receivedAt, t.outcome
	a.traces.mu.Unlock()
	slog.Info("Schaltspur: am Gerät", "spur", id, "entity", entityID, "geschrieben_nach", sinceOrZero(wroteAt, rec),
		"zurueckgelesen_nach", readAt.Sub(rec), "urteil", out)
}

// traceUnchanged: der Durchgang nach der Entscheidung fand nichts zu
// schreiben (der gewünschte Stand lag schon an oder eine Schutzregel hält
// den vorigen) - das Urteil steht dann ohne Geräte-Zeitpunkte.
func (a *Agent) traceUnchanged(entityID string, passStart time.Time) {
	a.traces.mu.Lock()
	defer a.traces.mu.Unlock()
	t := a.traces.m[entityID]
	if t == nil || t.admittedAt.IsZero() || !t.readBackAt.IsZero() || t.outcome != "" ||
		passStart.Before(t.admittedAt) {
		return
	}
	t.outcome = traceUnchanged
}

// traceReadback stempelt die Rücklesung für Verbraucher, deren Treiber keine
// eigenen Zeitpunkte liefert (go-e, Ebyte, Modbus-Gerät): die erste
// Rücklesung nach der Entscheidung.
func (a *Agent) traceReadback(entityID string, now time.Time) {
	a.traces.mu.Lock()
	defer a.traces.mu.Unlock()
	t := a.traces.m[entityID]
	if t == nil || t.admittedAt.IsZero() || !t.readBackAt.IsZero() || now.Before(t.admittedAt) {
		return
	}
	t.readBackAt = now
	if t.outcome == "" {
		t.outcome = traceWritten
	}
}

// consumerTraceFor ist der Block consumers.{id}.trace (nil ohne Spur oder
// nach consumerTraceWindow).
func (a *Agent) consumerTraceFor(entityID string, now time.Time) *cloud.ConsumerTrace {
	a.traces.mu.Lock()
	defer a.traces.mu.Unlock()
	t := a.traces.m[entityID]
	if t == nil {
		return nil
	}
	if now.Sub(t.receivedAt) > consumerTraceWindow {
		delete(a.traces.m, entityID)
		return nil
	}
	return &cloud.ConsumerTrace{RequestID: t.requestID, ReceivedAt: traceTime(t.receivedAt),
		AdmittedAt: traceTime(t.admittedAt), WrittenAt: traceTime(t.writtenAt), ReadBackAt: traceTime(t.readBackAt),
		Outcome: t.outcome, ReasonCode: t.reasonCode}
}

// traceTime: Millisekunden genau, UTC; leer für einen Schritt, der nicht stattfand.
func traceTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

func sinceOrZero(t, from time.Time) time.Duration {
	if t.IsZero() {
		return 0
	}
	return t.Sub(from)
}

// shellyWriteClock umhüllt den Shelly-Doer eines Durchgangs und merkt sich,
// wann die letzte SCHALTanfrage (Gen2 Switch.Set, Gen1 /relay/N?turn=)
// zurückkam - der Zeitpunkt "ans Gerät geschrieben", ohne den Treiber zu
// ändern.
type shellyWriteClock struct {
	inner shelly.Doer
	mu    sync.Mutex
	wrote time.Time
}

func (c *shellyWriteClock) Get(ctx context.Context, url string) (int, []byte, error) {
	code, body, err := c.inner.Get(ctx, url)
	if strings.Contains(url, "/rpc/Switch.Set?") || strings.Contains(url, "/relay/") && strings.Contains(url, "turn=") {
		c.mu.Lock()
		c.wrote = time.Now()
		c.mu.Unlock()
	}
	return code, body, err
}

func (c *shellyWriteClock) wroteAt() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.wrote
}
