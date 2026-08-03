package otaapply

// Der Wachhund und die Wiederaufnahme.
//
// Alles hier beantwortet EINE Frage: „Es liegt eine Brotkrume - was jetzt?"
// Sie wird bei JEDEM Start des Sidecars gestellt (Einzelschreiber-Semantik:
// nur er faehrt `docker compose up`, also faehrt auch nur er einen
// angefangenen Tausch zu Ende) und danach in jedem Takt, solange der Vorgang
// laeuft. Sie ist rein: dieselben Eingaben ergeben immer dieselbe Antwort.

import (
	"fmt"
	"time"
)

// CrashLoopRestarts ist die Zahl der Neustarts, ab der ein Stand als
// „flattert" gilt und SOFORT zurueckgenommen wird - unabhaengig von der Frist.
//
// Der Grund ist der Vorentwurf-Befund B6: ein Build, der nach zwei Sekunden
// beendet, wuerde sonst die VOLLE Wachhund-Frist lang die Steuerung
// blockieren, obwohl nach dem dritten Neustart bereits alles gesagt ist.
const CrashLoopRestarts = 3

// StartGrace ist die Zeit, die ein frisch getauschter Container haben muss,
// bevor „laeuft nicht" als Befund gilt. Ein `up -d` ist Stoppen-dann-Starten;
// die Sekunden dazwischen sind kein Fehlschlag.
const StartGrace = 45 * time.Second

// ResumeAction ist die Antwort auf eine vorliegende Brotkrume.
type ResumeAction string

const (
	// ResumeContinue: der Vorgang laeuft planmaessig weiter (naechste Phase
	// bzw. weiter auf das Selbsttest-Urteil warten).
	ResumeContinue ResumeAction = "continue"
	// ResumeCommit: alles gruen - bestaetigen.
	ResumeCommit ResumeAction = "commit"
	// ResumeRevert: zurueck auf das Rueckfallziel.
	ResumeRevert ResumeAction = "revert"
)

// ComponentHealth ist die Beobachtung des Sidecars ueber EINEN Container.
type ComponentHealth struct {
	Component string
	// Running sagt, ob der Container laeuft.
	Running bool
	// Restarts ist die Zahl der Neustarts SEIT dem Beginn des Tausches
	// (Differenz, nicht der absolute Zaehler des Containers).
	Restarts int
	// Healthy ist der Docker-Healthcheck, sofern das Image einen hat
	// (nil = kein Healthcheck; das ist kein Befund, nur keine Aussage).
	Healthy *bool
}

// ResumeInput ist die Lage bei einer vorliegenden Brotkrume.
type ResumeInput struct {
	Pending *PendingConfirm
	// SelfTest ist das Urteil des NEUEN Kerns (nil = noch keines).
	SelfTest *SelfTest
	// Health sind die Beobachtungen ueber die getauschten Container.
	Health []ComponentHealth
	Now    time.Time
}

// Resume entscheidet ueber einen angefangenen Tausch.
//
// Die Reihenfolge ist wieder bindend, und sie ist nach GESCHWINDIGKEIT DER
// AUSSAGE sortiert: was sofort und eindeutig „kaputt" sagt, gewinnt vor der
// Frist, und die Frist gewinnt vor dem Warten. Ein flatternder Stand haelt die
// Steuerung damit Sekunden statt Minuten auf.
func Resume(in ResumeInput) (ResumeAction, string) {
	if in.Pending == nil {
		return ResumeContinue, ""
	}

	// 1. Flattern: die schnellste eindeutige Aussage.
	for _, h := range in.Health {
		if h.Restarts >= CrashLoopRestarts {
			return ResumeRevert, fmt.Sprintf(
				"'%s' ist seit dem Tausch %dx neu gestartet - der neue Stand wird sofort "+
					"zurueckgenommen.", h.Component, h.Restarts)
		}
	}

	// 2. Das Urteil des neuen Standes ueber sich selbst.
	if st := in.SelfTest; st != nil && st.Token == in.Pending.Token {
		if st.Passed {
			return ResumeCommit, "Der Selbsttest des neuen Standes ist bestanden."
		}
		reason := st.Reason
		if reason == "" {
			reason = "ohne Angabe"
		}
		return ResumeRevert, "Der Selbsttest des neuen Standes ist fehlgeschlagen: " + reason
	}

	// 3. Die Frist. Sie liegt strikt unter der Neutral-Zeit des
	//    Wechselrichters - ein Haenger kann sie also nie ueberleben.
	if dl, err := time.Parse(TimeFormat, in.Pending.DeadlineAt); err == nil {
		if !in.Now.Before(dl) {
			return ResumeRevert, "Die Wachhund-Frist ist abgelaufen, ohne dass der neue Stand " +
				"sich als gesund gemeldet hat."
		}
	} else if in.Pending.DeadlineAt != "" {
		// Eine unlesbare Frist ist kein Freibrief. Ohne belastbare Frist gibt
		// es keinen Rueckhalt, also wird zurueckgenommen.
		return ResumeRevert, "Die Wachhund-Frist des laufenden Vorgangs ist unlesbar - " +
			"der Vorgang wird sicherheitshalber zurueckgenommen."
	}

	// 4. Ein Container, der nach der Anlaufzeit nicht laeuft, ist ein Befund.
	if started, err := time.Parse(TimeFormat, in.Pending.StartedAt); err == nil &&
		in.Now.Sub(started) > StartGrace {
		for _, h := range in.Health {
			if !h.Running {
				return ResumeRevert, fmt.Sprintf(
					"'%s' laeuft nach dem Tausch nicht - der neue Stand wird zurueckgenommen.",
					h.Component)
			}
			if h.Healthy != nil && !*h.Healthy {
				return ResumeRevert, fmt.Sprintf(
					"'%s' meldet sich als nicht gesund - der neue Stand wird zurueckgenommen.",
					h.Component)
			}
		}
	}

	return ResumeContinue, ""
}

// PendingSpec sind die Fakten, die eine Brotkrume festhaelt.
type PendingSpec struct {
	Token       string
	Release     string
	ReleaseSeq  int64
	Target      map[string]string
	Previous    LKG
	Deadline    time.Duration
	Urgent      bool
	ControlWas  bool
	StateSchema int
}

// NewPending baut die Brotkrume EINES Vorgangs.
func NewPending(spec PendingSpec, now time.Time) PendingConfirm {
	return PendingConfirm{
		Token:               spec.Token,
		Release:             spec.Release,
		ReleaseSeq:          spec.ReleaseSeq,
		StartedAt:           now.UTC().Format(TimeFormat),
		DeadlineAt:          now.Add(spec.Deadline).UTC().Format(TimeFormat),
		Phase:               PhasePrepared,
		Target:              spec.Target,
		Previous:            spec.Previous,
		Urgent:              spec.Urgent,
		ControlActiveBefore: spec.ControlWas,
		StateSchema:         spec.StateSchema,
	}
}

// ChangedComponents nennt - in der SEQUENZ-Reihenfolge - die Komponenten, die
// wirklich getauscht werden muessen.
//
// Zwei Eigenschaften, die beide tragend sind:
//
//  1. **Nur was sich unterscheidet.** Wer eine unveraenderte Komponente
//     mittauscht, nimmt die Failsafe-Kopie darin fuer nichts vom Netz.
//  2. **Eine feste Ordnung.** `core` vor `nodered`: waehrend der Kern
//     getauscht wird, lebt die Staleness-Failsafe von Node-RED, und danach
//     umgekehrt. NIE beide zugleich - das ist der strukturelle Fix des
//     Befunds B1 der Vorarbeit.
func ChangedComponents(current, target map[string]string) []string {
	order := []string{"core", "nodered"}
	var out []string
	seen := map[string]bool{}
	for _, name := range order {
		seen[name] = true
		if want, ok := target[name]; ok && want != "" && current[name] != want {
			out = append(out, name)
		}
	}
	// Ein kuenftiger Artefakt-Name faellt hinten an, damit ein Release mit
	// einer dritten Komponente nicht stillschweigend die Haelfte auslaesst.
	for name, want := range target {
		if seen[name] || want == "" || current[name] == want {
			continue
		}
		out = append(out, name)
	}
	return out
}

// PhaseForComponent ordnet einer Komponente ihre Phase zu (fuer die Brotkrume).
func PhaseForComponent(name string) string {
	switch name {
	case "core":
		return PhaseSwapCore
	case "nodered":
		return PhaseSwapNode
	default:
		return PhaseSwapNode
	}
}
