package otaverify

import (
	"fmt"
	"strings"
	"time"
)

// Outcome ist das Urteil einer Pruefung. Die drei Werte sind bewusst
// verschieden, weil sie verschiedene Handlungen ausloesen:
//
//   - [OutcomeOK]:       Kette und Politik in Ordnung.
//   - [OutcomeDeferred]: die Signatur ist EINWANDFREI, nur gilt dieses Release
//     nicht (jetzt) fuer dieses Geraet - falsches Backend, Anti-Rollback-Boden,
//     Rueckschritt ohne Freigabe. Kein Sicherheitsvorfall, sondern eine
//     Politik-Entscheidung.
//   - [OutcomeRejected]: Vertrauenskette oder Form kaputt. Das IST ein
//     Sicherheits-Ereignis und darf nie wie ein „passt gerade nicht" aussehen.
type Outcome string

const (
	OutcomeOK       Outcome = "ok"
	OutcomeDeferred Outcome = "deferred"
	OutcomeRejected Outcome = "rejected"
)

// Verdict ist das Ergebnis einer Pruefung, fertig zum Berichten.
//
// [Verdict.Reason] ist bei jedem Nicht-OK PFLICHT und deutsch - ein roter
// Zustand, der seinen Grund nicht sagen kann, ist nur ein Alarm (die Haus-
// Disziplin aus dem Flotten-Puls: jede rote Zeile traegt ihren Grund).
type Verdict struct {
	Outcome Outcome
	Reason  string

	// Manifest ist nur bei bestandener SIGNATURPRUEFUNG gesetzt. Bei
	// OutcomeRejected wegen kaputter Kette bleibt es nil - unverifizierte
	// Inhalte werden nicht weitergereicht, damit kein Aufrufer versehentlich
	// auf ungeprueften Feldern arbeitet.
	Manifest *Manifest

	// SignedBy ist die key_id, mit der das Manifest tatsaechlich signiert war.
	SignedBy string

	// AlreadyRunning: die geprueften Bytes beschreiben genau den Stand, der
	// hier laeuft (Vergleich gegen die eingestempelte Build-Version).
	AlreadyRunning bool

	// Notes sind nicht-blockierende Beobachtungen (etwa ein abgelaufenes
	// valid_until oder ein nicht bewertbarer Anti-Rollback-Boden). Sie machen
	// aus „geprueft" nie ein „abgelehnt", verschweigen aber auch nichts.
	Notes []string
}

// OK ist die Kurzform fuer „Kette und Politik in Ordnung".
func (v Verdict) OK() bool { return v.Outcome == OutcomeOK }

// Input ist alles, was eine Pruefung braucht. Die drei Dokumente werden als
// ROHE BYTES uebergeben, genau so, wie sie auf der Platte liegen bzw. spaeter
// ueber den Draht kommen - jede Umformung unterwegs wuerde die Signatur
// zerstoeren, und das ist Absicht.
type Input struct {
	// Roots ist die gebackene Vertrauenswurzel ([BakedRoots] im Agenten; im
	// Operator-Werkzeug der ausdruecklich angegebene Root-Schluessel).
	Roots *KeySet

	TrustSet    []byte
	TrustSetSig []byte
	Manifest    []byte
	ManifestSig []byte

	// Backend ist das Apply-Backend DIESES Geraets ("compose").
	Backend string

	// RunningVersion ist die eingestempelte Build-Version (agent.Version).
	RunningVersion string

	// CurrentSeq ist die release_seq des laufenden Stands, falls bekannt.
	//
	// In Stufe 1 ist sie normalerweise NICHT bekannt: eine Box kennt ihre
	// eigene Sequenznummer erst, wenn einmal ein Release angewendet und
	// bestaetigt wurde (Stufe 3) - der Build-Stempel allein traegt sie nicht.
	// Dann ist der Anti-Rollback-Boden schlicht nicht bewertbar und wird als
	// Notiz berichtet, statt eine Zahl zu erfinden, die die Ordnung des
	// Registers verfaelschen wuerde.
	CurrentSeq *int64

	// Now ist die Geraetezeit. NULLWERT = keine vertrauenswuerdige Uhr; dann
	// unterbleiben alle zeitabhaengigen Pruefungen (Schluesselablauf) und
	// valid_until wird nur berichtet. Siehe die Uhr-Diskussion im Kontrakt.
	Now time.Time
}

// Verify prueft die vollstaendige Kette und wendet die Politik an.
//
// Die REIHENFOLGE ist bindend (siehe Paketdoku): gebackene Wurzel -> Trust-Set
// gegen die Wurzel -> Manifest gegen den Release-Schluessel -> ERST DANN
// parsen -> ERST DANN Politik. Ein manipuliertes Manifest erreicht den Parser
// nie, und die Politik urteilt nie ueber ungeprueften Inhalt.
func Verify(in Input) Verdict {
	// --- 1. Vertrauenswurzel -------------------------------------------------
	if in.Roots == nil || len(in.Roots.Keys) == 0 {
		return reject("Diesem Stand ist kein Vertrauensanker eingebacken - es kann kein Release geprueft werden.")
	}

	// --- 2. Trust-Set gegen die Wurzel --------------------------------------
	if len(in.TrustSet) == 0 || len(in.TrustSetSig) == 0 {
		return reject("Das Vertrauens-Set oder seine Signatur fehlt.")
	}
	tsSig, err := ParseSignature(in.TrustSetSig, DomainTrustSet)
	if err != nil {
		return reject("Signatur des Vertrauens-Sets unbrauchbar: " + err.Error())
	}
	rootKey, err := in.Roots.find(tsSig.KeyID, in.Now)
	if err != nil {
		return reject("Vertrauens-Set: " + err.Error())
	}
	if err := VerifyBytes(rootKey, DomainTrustSet, in.TrustSet, tsSig); err != nil {
		return reject("Vertrauens-Set ist nicht gueltig root-signiert: " + err.Error())
	}
	// Erst JETZT parsen - vorher waren es nur Bytes unbekannter Herkunft.
	trust, err := ParseKeySet(in.TrustSet)
	if err != nil {
		return reject("Vertrauens-Set ist fehlerhaft: " + err.Error())
	}

	// --- 3. Manifest gegen den Release-Schluessel ---------------------------
	if len(in.Manifest) == 0 || len(in.ManifestSig) == 0 {
		return reject("Das Release-Manifest oder seine Signatur fehlt.")
	}
	mSig, err := ParseSignature(in.ManifestSig, DomainRelease)
	if err != nil {
		return reject("Signatur des Release-Manifests unbrauchbar: " + err.Error())
	}
	relKey, err := trust.find(mSig.KeyID, in.Now)
	if err != nil {
		return reject("Release-Manifest: " + err.Error())
	}
	if err := VerifyBytes(relKey, DomainRelease, in.Manifest, mSig); err != nil {
		return reject("Release-Manifest ist nicht gueltig signiert: " + err.Error())
	}

	// --- 4. Erst jetzt parsen ------------------------------------------------
	m, err := ParseManifest(in.Manifest)
	if err != nil {
		return reject("Release-Manifest ist fehlerhaft: " + err.Error())
	}
	// Die key_id steht an zwei Stellen: signaturgeschuetzt IM Manifest und in
	// der .sig-Datei, die den Schluessel auswaehlt. Sie muessen uebereinstimmen,
	// sonst behauptet das signierte Dokument etwas anderes als die Pruefung tat.
	if m.SigningKeyID != mSig.KeyID {
		return reject(fmt.Sprintf(
			"Das Manifest nennt den Schluessel '%s', signiert wurde aber mit '%s'.", m.SigningKeyID, mSig.KeyID))
	}

	v := Verdict{
		Outcome:        OutcomeOK,
		Manifest:       m,
		SignedBy:       mSig.KeyID,
		AlreadyRunning: m.IsRunning(in.RunningVersion),
	}

	// --- 5. Politik ----------------------------------------------------------
	// Backend, Mindeststand und Rueckschritt sind Tore fuer das ANWENDEN. Wenn
	// der signierte Zielstand laut eigener Build-Stempelung bereits laeuft,
	// gibt es nichts mehr anzuwenden. Ihn wegen seines inzwischen angehobenen
	// Bodens abzulehnen, machte aus einem bestaetigten Update im naechsten Takt
	// faelschlich wieder einen Politik-Blocker.
	if v.AlreadyRunning {
		v.Notes = append(v.Notes, "Dieses Release laeuft hier bereits.")
	} else {
		// compat.backends: nie ein Rateversuch.
		if !m.SupportsBackend(in.Backend) {
			return defer_(v, fmt.Sprintf("Release %s ist nicht fuer das Apply-Backend '%s' bestimmt (gilt fuer: %s).",
				m.Release, in.Backend, strings.Join(m.Compat.Backends, ", ")))
		}

		// Anti-Rollback-Boden + Rueckschritt: beide brauchen den eigenen Stand.
		if in.CurrentSeq == nil {
			v.Notes = append(v.Notes,
				"Der eigene Release-Stand ist unbekannt (dieses Geraet hat noch nie ein Release angewendet) - "+
					"der Anti-Rollback-Boden konnte nicht geprueft werden.")
		} else {
			cur := *in.CurrentSeq
			if cur < m.MinFromSeq {
				return defer_(v, fmt.Sprintf(
					"Release %s setzt mindestens Stand %d voraus, hier laeuft %d - es fehlt eine Zwischenstufe.",
					m.Release, m.MinFromSeq, cur))
			}
			if m.ReleaseSeq <= cur && !m.AllowDowngrade {
				return defer_(v, fmt.Sprintf(
					"Release %s (Stand %d) ist nicht neuer als der laufende Stand %d und ist nicht als Rueckschritt freigegeben.",
					m.Release, m.ReleaseSeq, cur))
			}
			if m.ReleaseSeq <= cur && m.AllowDowngrade {
				v.Notes = append(v.Notes, fmt.Sprintf(
					"Ausdruecklich freigegebener Rueckschritt von Stand %d auf %d.", cur, m.ReleaseSeq))
			}
		}
	}

	// valid_until ist ADVISORY - es fuehrt nie zu einer Ablehnung (siehe Kontrakt).
	if m.ValidUntil != "" {
		if in.Now.IsZero() {
			v.Notes = append(v.Notes, "valid_until wurde nicht geprueft (keine vertrauenswuerdige Uhr).")
		} else if exp, err := parseTime(m.ValidUntil); err == nil && in.Now.After(exp) {
			v.Notes = append(v.Notes, fmt.Sprintf(
				"Hinweis: das Manifest war nur bis %s vorgesehen (nur ein Hinweis, kein Ablehnungsgrund).", m.ValidUntil))
		}
	}

	v.Reason = fmt.Sprintf("Release %s (Stand %d) verifiziert, signiert mit '%s'.", m.Release, m.ReleaseSeq, mSig.KeyID)
	return v
}

func reject(reason string) Verdict {
	return Verdict{Outcome: OutcomeRejected, Reason: reason}
}

// defer_ behaelt das (verifizierte) Manifest bei: die Signatur war in Ordnung,
// nur die Politik sagt nein - der Aufrufer darf also ueber den Inhalt reden.
func defer_(v Verdict, reason string) Verdict {
	v.Outcome = OutcomeDeferred
	v.Reason = reason
	return v
}
