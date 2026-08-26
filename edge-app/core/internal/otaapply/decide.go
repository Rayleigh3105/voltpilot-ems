package otaapply

// Die Torwaechter.
//
// # Das Leitprinzip (Captain-Order 26.08.2026 „Release waehlen, Geraete
// waehlen, fertig")
//
// **Jedes Tor ueber den ZUSTAND DES GERAETS ist gefallen. Jede Eigenschaft des
// SIGNIERTEN RELEASE ist geblieben.**
//
// Das ist die Trennlinie, an der dieses Paket haengt, und sie ist nicht
// kosmetisch: eine Release-Eigenschaft wird bei jedem Takt automatisch aus dem
// in der CI signierten Manifest bewertet und braucht NIE einen Menschen am
// Geraet; ein Geraete-Zustands-Tor braucht genau das. Weggefallen sind deshalb
// der Autonomie-Schalter, die Einmal-Freigabe, die Neutral-Zeit-Regel, der
// Interlock, „der Kern meldet sich nicht" und die Dauersperre nach einer
// Ruecknahme.
//
// # Warum das nicht unsicherer ist
//
// Der bis dahin offiziell gesegnete Handpfad `update.sh --from-target` tauscht
// die Container ROH: ohne Neutral-Zeit-Nachweis, ohne Interlock, ohne
// Selbsttest, ohne Ruecknahme. Der autonome Pfad bleibt nach diesem Umbau
// STRIKT sicherer als das, was wir vorher von Hand getan haben - Signaturkette,
// Images-vor-dem-Stopp, dreifach gesichertes Rueckfallziel, Brotkrume,
// sequenzierter Tausch, Selbsttest, LKG-Ruecknahme und Wachhund sind
// unangetastet. Die entfallenen Tore verhinderten also keine Gefahr, die der
// Handpfad nicht ohnehin taeglich eingegangen ist.
//
// Die REIHENFOLGE der verbliebenen Pruefungen ist bindend: erst „ist der
// Gegenstand vertrauenswuerdig?", dann „passt er zu diesem Geraet?", dann „ist
// physisch Platz?".

import (
	"fmt"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

// Action ist, was der Sidecar als naechstes tut.
type Action string

const (
	// ActionIdle: nichts zu tun (kein Ziel oder laeuft schon).
	ActionIdle Action = "idle"
	// ActionApply: alle Pruefungen bestanden - anwenden.
	ActionApply Action = "apply"
	// ActionDefer: heute nicht, aber es ist kein Fehler. Wird spaeter erneut
	// bewertet, ohne dass ein Mensch etwas tun muss.
	ActionDefer Action = "defer"
	// ActionRefuse: es wird nicht angewandt, solange sich das RELEASE nicht
	// aendert - gebrochene Kette, unpassendes Backend, unlesbarer Datenstand.
	ActionRefuse Action = "refuse"
)

// Decision ist das Ergebnis eines Torlaufs.
type Decision struct {
	Action Action
	// State ist das Wort aus dem Vertrags-Vokabular (cloud.UpdateState*), mit
	// dem dieser Ausgang gemeldet wird.
	State string
	// Reason ist der deutsche Grund. Bei allem ausser ActionIdle PFLICHT.
	Reason string
	// Blocker ist der MASCHINENLESBARE Name der Pruefung, die hier zugemacht
	// hat (leer = keine, also idle oder anwenden).
	//
	// Er steht NEBEN Reason, weil beide verschiedene Fragen beantworten: Reason
	// ist der Satz fuer einen Menschen, Blocker ist das, worauf ein Log, eine
	// Zustandsdatei und eine Oberflaeche vergleichen duerfen - genau so, wie
	// `target_verdict` neben `state` steht, damit niemand einen deutschen Satz
	// nach Stichworten durchsuchen muss.
	Blocker string
	// Deadline ist die Wachhund-Frist - nur bei ActionApply gesetzt.
	Deadline time.Duration
}

// Die Blocker-Namen. Sie sind ein VERTRAG zwischen Sidecar-Log,
// `updater-state.json` und dem Herzschlag - kurz, stabil, ohne Umlaute.
//
// Sie sind ausdruecklich NICHT nur die verbliebenen: das Portal und ein
// Bestandsgeraet muessen die alten Woerter weiter LESEN koennen (eine Box mit
// aelterem Image meldet sie noch). Erzeugt werden nur die ersten fuenf.
const (
	// BlockerChain: die Vertrauenskette oder die Form ist kaputt (Vorfall).
	BlockerChain = "kette"
	// BlockerPolicy: gueltig signiert, gilt hier aber nicht (Anti-Rollback-Boden).
	BlockerPolicy = "politik"
	// BlockerBackend: das Release ist nicht fuer dieses Apply-Backend bestimmt.
	BlockerBackend = "backend"
	// BlockerStateSchema: das Release kennt unseren /data-Stand nicht.
	BlockerStateSchema = "state_schema"
	// BlockerDisk: der Plattenwaechter - eine PHYSISCHE Grenze, kein Tor. Er
	// schlaegt erst zu, NACHDEM der Sidecar seine abgeloesten Abbilder
	// weggeraeumt hat (siehe otaupdater.Engine.Tick).
	BlockerDisk = "platte"
	// BlockerRolledBack: genau diese ZUWEISUNG wurde hier schon zurueckgenommen.
	// Eine NEUE Zuweisung - auch desselben Release - versucht es wieder.
	BlockerRolledBack = "zurueckgenommen"

	// --- Nur noch zum LESEN: Woerter, die eine aeltere Box melden kann. -----
	// Sie werden hier nicht mehr erzeugt; das Vokabular bleibt trotzdem
	// vollstaendig, damit ein Bestandsgeraet keine unbekannte Sperre meldet.
	BlockerCoreSilent      = "kern_still"
	BlockerNeutralTime     = "neutralzeit"
	BlockerNeutralTooShort = "neutralzeit_zu_kurz"
	BlockerInterlock       = "interlock"
	BlockerApprovalRelease = "freigabe_release"

	// BlockerPull/BlockerRollback/BlockerSnapshot sind die Tore der
	// VORBEREITUNG - sie halten den Tausch auf, bevor irgendetwas gestoppt wird.
	BlockerPull     = "laden"
	BlockerRollback = "rueckfallziel"
	BlockerSnapshot = "sicherung"
	// BlockerUnreadable: eine Datei des Protokolls ist unlesbar.
	BlockerUnreadable = "unlesbar"
)

// BlockedPrefix leitet jeden Grund ein, der eine STEHENDE Sperre beschreibt.
//
// Er steht hier, damit Sidecar, Kern und Doku denselben Satzanfang benutzen:
// „wartet" und „blockiert" sehen sonst auf jeder Oberflaeche gleich aus, und
// genau daran ist der erste Canary-Soak gescheitert.
const BlockedPrefix = "Autonomie blockiert: "

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

// DecisionInput ist alles, was fuer die Entscheidung bekannt sein muss.
type DecisionInput struct {
	// HasTarget: liegt ueberhaupt eine Zuweisung vor?
	HasTarget bool
	// Assignment ist der `assigned_at`-Stempel DIESER Zuweisung. Er ist der
	// Schluessel, an dem eine zurueckgenommene Anwendung haengt - siehe
	// [FailedRelease].
	Assignment string
	// Verdict ist das Urteil des EIGENEN Verifizierers des Sidecars.
	Verdict otaverify.Verdict
	// StateSchemaOnDisk ist die Version des lokalen /data-Zustands.
	StateSchemaOnDisk int
	// FreeBytes/RequiredBytes ist der Plattenwaechter.
	FreeBytes     uint64
	RequiredBytes uint64
	// Failed ist der Merkzettel ueber eine hier bereits zurueckgenommene
	// Zuweisung (nil = keine).
	Failed *FailedRelease
	// ConfiguredDeadline ist die konfigurierte Wachhund-Frist.
	ConfiguredDeadline time.Duration
	Now                time.Time
}

// Decide laeuft die Pruefungen ab.
func Decide(in DecisionInput) Decision {
	// --- 1. Gibt es ueberhaupt etwas zu tun? ------------------------------
	if !in.HasTarget {
		return Decision{Action: ActionIdle, State: StateIdle}
	}

	// --- 2. Ist der Gegenstand vertrauenswuerdig? --------------------------
	switch in.Verdict.Outcome {
	case otaverify.OutcomeRejected:
		// Eine gebrochene Kette ist ein SICHERHEITS-Ereignis und darf nie wie
		// „passt gerade nicht" aussehen.
		return Decision{Action: ActionRefuse, State: StateFailed, Blocker: BlockerChain,
			Reason: in.Verdict.Reason}
	case otaverify.OutcomeDeferred:
		return Decision{Action: ActionDefer, State: StateDeferred, Blocker: BlockerPolicy,
			Reason: in.Verdict.Reason}
	case otaverify.OutcomeOK:
		// weiter
	default:
		return Decision{Action: ActionRefuse, State: StateFailed, Blocker: BlockerChain,
			Reason: "Der Verifizierer hat kein Urteil abgegeben - es wird nichts angewandt."}
	}
	m := in.Verdict.Manifest
	if m == nil {
		// Kann per Konstruktion nicht vorkommen (OutcomeOK traegt immer ein
		// Manifest) - und genau deshalb ist es hier eine Ablehnung und kein
		// nil-Zugriff drei Zeilen spaeter.
		return Decision{Action: ActionRefuse, State: StateFailed, Blocker: BlockerChain,
			Reason: "Das Urteil nennt kein Manifest - es wird nichts angewandt."}
	}
	if in.Verdict.AlreadyRunning {
		return Decision{Action: ActionIdle, State: StateSucceeded,
			Reason: "Release " + m.Release + " laeuft hier bereits."}
	}
	if !m.SupportsBackend(BackendCompose) {
		return Decision{Action: ActionRefuse, State: StateDeferred, Blocker: BlockerBackend,
			Reason: "Dieses Release ist nicht fuer das Compose-Backend bestimmt."}
	}

	// --- 3. Vertraegt unser lokaler Zustand diesen Stand? ------------------
	if in.StateSchemaOnDisk > 0 && m.StateSchema < in.StateSchemaOnDisk {
		// Das Release kennt unser /data-Format nicht. Es anzuwenden hiesse,
		// einem alten Stand einen neueren Zustand vorzusetzen - der klassische
		// Weg, Identitaet und Puffer zu zerlegen. Es feuert AUSSCHLIESSLICH
		// bei einem ausdruecklichen Rueckschritt.
		return Decision{Action: ActionRefuse, State: StateDeferred, Blocker: BlockerStateSchema,
			Reason: fmt.Sprintf("Dieses Release unterstuetzt den lokalen Datenstand nicht "+
				"(state_schema %d, auf dem Geraet %d).", m.StateSchema, in.StateSchemaOnDisk)}
	}

	// --- 4. Wurde GENAU DIESE Zuweisung hier schon zurueckgenommen? -------
	//
	// Das ist die Runaway-Bremse und ausdruecklich KEINE Dauersperre mehr: sie
	// haengt am `assigned_at`-Stempel, also loest ein erneutes „Aktualisieren"
	// im Portal sie von selbst - auch fuer dasselbe Release. Ohne sie drehte
	// eine Box mit einem hier nicht lauffaehigen Release im Kreis und naehme
	// sich bei jedem Versuch erneut die Sekunden ohne Steuerung.
	if in.Failed.Blocks(m.Release, in.Assignment) {
		reason := "Release " + m.Release + " wurde auf diesem Geraet bereits " +
			"zurueckgenommen. Eine erneute Zuweisung im Portal versucht es wieder."
		if in.Failed.Reason != "" {
			reason += " Grund damals: " + in.Failed.Reason
		}
		return Decision{Action: ActionRefuse, State: StateRolledBack,
			Blocker: BlockerRolledBack, Reason: reason}
	}

	// --- 5. Ist physisch Platz? -------------------------------------------
	//
	// Kein Tor, sondern eine physische Grenze: der Sidecar hat unmittelbar
	// davor seine abgeloesten Abbilder weggeraeumt. Reicht es dann immer noch
	// nicht, wird das ehrlich gemeldet statt blind getauscht.
	if in.RequiredBytes > 0 && in.FreeBytes < in.RequiredBytes {
		return Decision{Action: ActionDefer, State: StateDeferred, Blocker: BlockerDisk,
			Reason: fmt.Sprintf("Zu wenig freier Speicherplatz (%s frei, %s noetig) - "+
				"ein Tausch ohne Platz fuer das Rueckfallziel wird nicht begonnen. "+
				"Abgeloeste Abbilder wurden bereits entfernt.",
				humanBytes(in.FreeBytes), humanBytes(in.RequiredBytes))}
	}

	deadline := in.ConfiguredDeadline
	if deadline <= 0 {
		deadline = DefaultWatchdogDeadline
	}
	return Decision{Action: ActionApply, State: StateDownloading,
		Reason:   "Release " + m.Release + " ist geprueft und wird angewandt.",
		Deadline: deadline}
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
