package otaapply

// Die Torwaechter. JEDE Regel, die ein autonomes Anwenden verhindern kann,
// steht hier - rein, ohne I/O, mit einem deutschen Grund je Ausgang.
//
// Die REIHENFOLGE ist bindend, nicht Stil. Sie geht von „darf ueberhaupt
// jemand?" ueber „ist der Gegenstand vertrauenswuerdig?" zu „ist dieses Geraet
// gerade in der Lage?" - und jede Stufe kann nur ABLEHNEN, nie freigeben, was
// eine fruehere abgelehnt hat.

import (
	"fmt"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

// Action ist, was der Sidecar als naechstes tut.
type Action string

const (
	// ActionIdle: nichts zu tun (kein Ziel, laeuft schon, oder ausgeschaltet).
	ActionIdle Action = "idle"
	// ActionApply: alle Tore offen - anwenden.
	ActionApply Action = "apply"
	// ActionDefer: heute nicht, aber es ist kein Fehler. Wird spaeter erneut
	// bewertet, ohne dass ein Mensch etwas tun muss.
	ActionDefer Action = "defer"
	// ActionRefuse: es wird NIE angewandt, solange sich nichts aendert -
	// gebrochene Kette, unpassendes Backend, unverifizierte Neutral-Zeit.
	ActionRefuse Action = "refuse"
	// ActionNeutral: der Eil-Pfad - der Kern soll die Anlage erst neutral
	// parken, danach wird angewandt.
	ActionNeutral Action = "neutral"
)

// Decision ist das Ergebnis eines Torlaufs.
type Decision struct {
	Action Action
	// State ist das Wort aus dem Vertrags-Vokabular (cloud.UpdateState*), mit
	// dem dieser Ausgang gemeldet wird.
	State string
	// Reason ist der deutsche Grund. Bei allem ausser ActionIdle PFLICHT.
	Reason string
	// Deadline ist die Wachhund-Frist - nur bei ActionApply gesetzt.
	Deadline time.Duration
}

// Die Zustandswoerter, die dieses Paket meldet. Sie sind absichtlich als
// Konstanten dupliziert statt aus `internal/cloud` importiert: `cloud` zieht
// paho und damit einen Netz-Stack, und der Sidecar soll bewusst nichts davon
// enthalten. Die Woerter sind Vertrag (docs/contracts, seit Stufe 0) und
// aendern sich nicht; `TestStateVocabularyMatchesTheCloudContract` haelt beide
// Seiten zusammen.
const (
	StateIdle        = "idle"
	StateVerifying   = "verifying"
	StateDeferred    = "deferred"
	StateDownloading = "downloading"
	StateApplying    = "applying"
	StateSelfTest    = "self_test"
	StateSucceeded   = "succeeded"
	StateFailed      = "failed"
	StateRolledBack  = "rolled_back"
)

// BackendCompose ist das Apply-Backend dieser Stufe.
const BackendCompose = otaverify.BackendCompose

// DefaultDiskGuardBytes ist der freie Platz, unter dem NICHT getauscht wird.
//
// Er ist bewusst grosszuegig: er muss die beiden neuen Images UND die beiden
// `docker save`-Archive des Rueckfallziels tragen. Ein Tausch, der die Platte
// vollschreibt, nimmt sich genau die Rueckfallebene, fuer die er sie braucht.
const DefaultDiskGuardBytes uint64 = 2 << 30 // 2 GiB

// MaxCoreSignalAge ist das Alter, ab dem der Kern als „meldet sich nicht"
// gilt. Er schreibt alle zwei Sekunden; eine Minute Toleranz ueberbrueckt
// jeden Neustart, ohne einen wirklich toten Kern zu uebersehen.
const MaxCoreSignalAge = 60 * time.Second

// DecisionInput ist alles, was fuer die Entscheidung bekannt sein muss.
type DecisionInput struct {
	// Autonomous ist der Schalter (Datei ODER Not-Ein-Umgebungsvariable).
	Autonomous bool
	// Request ist eine EINMALIGE, von einem Menschen ausgeloeste Freigabe
	// ([ApplyRequest], OTA Stufe 4). nil = keine.
	Request *ApplyRequest
	// AppliedRequestToken ist der zuletzt vom Sidecar ausgefuehrte Token -
	// damit dieselbe Freigabe nie zweimal wirkt.
	AppliedRequestToken string
	// HasTarget: liegt ueberhaupt eine Zuweisung vor?
	HasTarget bool
	// Verdict ist das Urteil des EIGENEN Verifizierers des Sidecars.
	Verdict otaverify.Verdict
	// StateSchemaOnDisk ist die Version des lokalen /data-Zustands.
	StateSchemaOnDisk int
	// FreeBytes/RequiredBytes ist der Plattenwaechter.
	FreeBytes     uint64
	RequiredBytes uint64
	// Signal ist die Momentaufnahme des Kerns (nil = nie geschrieben).
	Signal *CoreSignal
	// Failed ist der Merkzettel ueber ein hier bereits zurueckgenommenes
	// Release (nil = keines).
	Failed *FailedRelease
	// Neutral ist die aufgeloeste Aussage zur Familie aus dem Signal.
	Neutral NeutralTimeout
	// ConfiguredDeadline ist die konfigurierte Wachhund-Frist.
	ConfiguredDeadline time.Duration
	Now                time.Time
}

// Decide laeuft die Tore ab.
func Decide(in DecisionInput) Decision {
	// --- 1. Darf ueberhaupt jemand? ---------------------------------------
	//
	// ZWEI Wege durch dieses eine Tor, und nur durch dieses: der Schalter
	// (Autonomie) oder eine EINMALIGE Freigabe durch einen Menschen am Geraet
	// (`:8484` „Jetzt anwenden", OTA Stufe 4). Jedes weitere Tor unten gilt
	// fuer beide UNVERAENDERT - die Freigabe verkuerzt keinen Pruefschritt,
	// sie ersetzt nur die Frage „wann".
	manual := in.ManualApproval()
	if !in.Autonomous && !manual {
		// Kein Grund noetig: „ausgeschaltet" ist kein Befund ueber ein Release.
		// Die Oberflaeche liest das aus UpdaterState.Autonomous.
		return Decision{Action: ActionIdle, State: StateIdle}
	}
	if !in.HasTarget {
		return Decision{Action: ActionIdle, State: StateIdle}
	}

	// --- 2. Ist der Gegenstand vertrauenswuerdig? --------------------------
	switch in.Verdict.Outcome {
	case otaverify.OutcomeRejected:
		// Eine gebrochene Kette ist ein SICHERHEITS-Ereignis und darf nie wie
		// „passt gerade nicht" aussehen - genau das Signal, auf das der
		// Rollout im Portal automatisch anhaelt.
		return Decision{Action: ActionRefuse, State: StateFailed,
			Reason: in.Verdict.Reason}
	case otaverify.OutcomeDeferred:
		return Decision{Action: ActionDefer, State: StateDeferred,
			Reason: in.Verdict.Reason}
	case otaverify.OutcomeOK:
		// weiter
	default:
		return Decision{Action: ActionRefuse, State: StateFailed,
			Reason: "Der Verifizierer hat kein Urteil abgegeben - es wird nichts angewandt."}
	}
	m := in.Verdict.Manifest
	if m == nil {
		// Kann per Konstruktion nicht vorkommen (OutcomeOK traegt immer ein
		// Manifest) - und genau deshalb ist es hier eine Ablehnung und kein
		// nil-Zugriff drei Zeilen spaeter.
		return Decision{Action: ActionRefuse, State: StateFailed,
			Reason: "Das Urteil nennt kein Manifest - es wird nichts angewandt."}
	}
	if in.Failed.Blocks(m.Release) {
		// Nie wieder von selbst - siehe [FailedRelease]. Das ist ein HALT, kein
		// Fehlschlag im Sinne der Kette: die Signatur war in Ordnung, die
		// Anwendung nicht.
		reason := "Release " + m.Release + " wurde auf diesem Geraet bereits " +
			"zurueckgenommen und wird nicht erneut von selbst angewandt."
		if in.Failed.Reason != "" {
			reason += " Grund damals: " + in.Failed.Reason
		}
		return Decision{Action: ActionRefuse, State: StateRolledBack, Reason: reason}
	}
	if in.Verdict.AlreadyRunning {
		return Decision{Action: ActionIdle, State: StateSucceeded,
			Reason: "Release " + m.Release + " laeuft hier bereits."}
	}
	if !m.SupportsBackend(BackendCompose) {
		return Decision{Action: ActionRefuse, State: StateDeferred,
			Reason: "Dieses Release ist nicht fuer das Compose-Backend bestimmt."}
	}

	// --- 3. Vertraegt unser lokaler Zustand diesen Stand? ------------------
	if in.StateSchemaOnDisk > 0 && m.StateSchema < in.StateSchemaOnDisk {
		// Das Release kennt unser /data-Format nicht. Es anzuwenden hiesse,
		// einem alten Stand einen neueren Zustand vorzusetzen - der klassische
		// Weg, Identitaet und Puffer zu zerlegen.
		return Decision{Action: ActionRefuse, State: StateDeferred,
			Reason: fmt.Sprintf("Dieses Release unterstuetzt den lokalen Datenstand nicht "+
				"(state_schema %d, auf dem Geraet %d).", m.StateSchema, in.StateSchemaOnDisk)}
	}

	// --- 4. Ist dieses Geraet gerade in der Lage? --------------------------
	if age := in.Signal.Age(in.Now); age > MaxCoreSignalAge {
		// Ohne den Zustand des Kerns weiss der Sidecar nicht, ob gerade
		// gesteuert wird - und ein Tausch im Blindflug ist genau das, was die
		// ganze Stufe verhindern soll.
		return Decision{Action: ActionDefer, State: StateDeferred,
			Reason: "Der Kern meldet seinen Zustand nicht (zuletzt vor " +
				age.Round(time.Second).String() + ") - ohne ihn wird nichts angewandt."}
	}
	if in.RequiredBytes > 0 && in.FreeBytes < in.RequiredBytes {
		return Decision{Action: ActionDefer, State: StateDeferred,
			Reason: fmt.Sprintf("Zu wenig freier Speicherplatz (%s frei, %s noetig) - "+
				"ein Tausch ohne Platz fuer das Rueckfallziel wird nicht begonnen.",
				humanBytes(in.FreeBytes), humanBytes(in.RequiredBytes))}
	}

	// Die Neutral-Zeit ist NUR tragend, wenn dieses Geraet wirklich steuert:
	// eine Anlage ohne Steuerpfad haelt kein Kommando, das T ueberleben
	// koennte. Steuert sie aber, ist eine unverifizierte Familie eine harte
	// Sperre - der Vorentwurf ist da eindeutig.
	if in.Signal.ControlActive {
		if !in.Neutral.Verified {
			return Decision{Action: ActionRefuse, State: StateDeferred,
				Reason: in.Neutral.Note + " Solange dieses Geraet steuert, wird deshalb " +
					"nicht autonom angewandt."}
		}
		if !NeutralSupportsWatchdog(in.Neutral) {
			return Decision{Action: ActionRefuse, State: StateDeferred,
				Reason: fmt.Sprintf("Die belegte Neutral-Zeit (%s) laesst keine Wachhund-Frist "+
					"unter ihr zu - es wird nicht autonom angewandt.", in.Neutral.T)}
		}
	}

	// Der „nicht mitten im Schreiben"-Interlock.
	if in.Signal.Dispatching {
		if !m.Urgent {
			return Decision{Action: ActionDefer, State: StateDeferred,
				Reason: "Es wird gerade ein von neutral abweichender Sollwert ausgefuehrt - " +
					"der Tausch wartet auf das Ende des Zeitfensters."}
		}
		if in.Signal.NeutralHeldSince == "" {
			// Eil-Pfad: NICHT ewig verschieben, aber auch nicht mitten hinein
			// tauschen - erst bewusst neutral stellen, dann tauschen.
			return Decision{Action: ActionNeutral, State: StateDeferred,
				Reason: "Eil-Aktualisierung: die Anlage wird zuerst bewusst neutral gestellt, " +
					"danach wird getauscht."}
		}
	}

	// Die Freigabe gilt fuer GENAU DAS Release, das der Mensch gesehen hat.
	// Steht inzwischen ein anderes Ziel da, ist das keine Freigabe mehr - eine
	// Zustimmung zu „edge-2026.08.0" ist keine zu dem, was zwei Minuten spaeter
	// zugewiesen wurde. Diese Pruefung steht bewusst HIER unten, nach dem
	// Verifizieren: vorher gibt es kein vertrauenswuerdiges Release, mit dem
	// sich vergleichen liesse.
	if !in.Autonomous && manual && in.Request.Release != "" && in.Request.Release != m.Release {
		return Decision{Action: ActionIdle, State: StateDeferred,
			Reason: "Die Freigabe galt fuer Release " + in.Request.Release + ", zugewiesen ist " +
				"inzwischen " + m.Release + " - es wird nichts angewandt."}
	}

	reason := "Release " + m.Release + " ist geprueft und wird angewandt."
	if !in.Autonomous {
		reason = "Release " + m.Release + " ist geprueft und wurde am Geraet freigegeben - " +
			"es wird jetzt angewandt."
	}
	return Decision{Action: ActionApply, State: StateDownloading, Reason: reason,
		Deadline: WatchdogDeadline(in.Neutral, in.Signal.ControlActive, in.ConfiguredDeadline)}
}

// ManualApproval sagt, ob eine gueltige, noch nicht ausgefuehrte Freigabe
// vorliegt.
//
// Drei Bedingungen, jede fuer sich noetig: sie existiert, sie ist FRISCH
// ([ApplyRequestWindow] - eine vergessene Freigabe darf nicht Tage spaeter
// zuschlagen), und ihr Token wurde noch nicht ausgefuehrt - genau das macht sie
// EINMALIG und verhindert die Tausch-Schleife, gegen die es auch `failed.json`
// gibt.
func (in DecisionInput) ManualApproval() bool {
	return in.Request.Fresh(in.Now) && in.Request.Token != in.AppliedRequestToken
}

// ApplyingAckDecision sagt, ob der Sidecar auf den durablen `applying`-Bericht
// des Kerns noch warten soll.
//
// Der Bericht ist der Grund, warum „im Update verstummt" ueberhaupt ein
// eigener Zustand sein kann - also wird auf ihn gewartet. Aber NICHT ewig: ist
// der Broker weg, gaebe es sonst eine Klasse von Geraeten, die sich nie mehr
// aktualisieren lassen, weil sie gerade offline sind. Nach der Frist wird
// weitergemacht, und der Bericht holt sich beim naechsten Herzschlag nach.
func ApplyingAckDecision(state *UpdaterState, sig *CoreSignal, waited, limit time.Duration) (proceed bool, reason string) {
	if state == nil || state.AckToken == "" {
		return true, ""
	}
	if sig != nil && sig.AckToken == state.AckToken {
		if sig.ApplyingAckedAt != "" {
			return true, ""
		}
		if sig.AckFailed {
			// Der Kern SAGT, dass er es nicht konnte. Darauf weiter zu warten
			// ist reines Zuwarten ohne Aussicht.
			return true, "Der durable Bericht konnte nicht abgesetzt werden (keine Cloud-Verbindung)."
		}
	}
	if waited >= limit {
		return true, "Der Kern hat den durablen Bericht nicht binnen " +
			limit.Round(time.Second).String() + " bestaetigt - es wird trotzdem getauscht."
	}
	return false, ""
}

// humanBytes formatiert Bytes fuer einen deutschen Grund.
func humanBytes(b uint64) string {
	switch {
	case b >= 1<<30:
		return fmt.Sprintf("%.1f GiB", float64(b)/float64(1<<30))
	case b >= 1<<20:
		return fmt.Sprintf("%.0f MiB", float64(b)/float64(1<<20))
	default:
		return fmt.Sprintf("%d Bytes", b)
	}
}
