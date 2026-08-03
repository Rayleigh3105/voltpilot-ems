package otaverify

// Die Vertrauens-IDENTITAET eines Geraets: gegen WELCHE Wurzel prueft dieser
// Stand, und WELCHE Release-Schluessel gelten hier gerade?
//
// Sie beantwortet die zwei Fragen, die OTA Stufe 4 flottenweit stellen muss und
// die bis dahin nur eine handgefuehrte Liste beantwortete:
//
//   - **TOFU-Abschluss:** traegt diese Box ueberhaupt schon ein
//     schluesseltragendes Image? (`RootKeyIDs` nicht leer)
//   - **Schluessel-Rotation:** hat diese Box das NEUE root-signierte Trust-Set
//     schon gesehen? (`TrustSetKeyIDs`/`TrustSetGeneratedAt`)
//
// Sie ist bewusst von [Verify] GETRENNT, weil sie eine andere Frage stellt:
// Verify urteilt ueber EIN Release, [InspectTrust] ueber den Vertrauensanker
// selbst. Eine Box ohne Zuweisung und ohne abgelegtes Release hat trotzdem eine
// Vertrauens-Identitaet - und genau die braucht der Rotations-Drill, BEVOR ein
// Release verteilt wird.
//
// Sie fuehrt die ersten zwei Schritte von [Verify] aus - gebackene Wurzel,
// Trust-Set gegen die Wurzel - und ist genauso streng: ein Trust-Set, das die
// Wurzel NICHT unterschrieben hat, wird nicht berichtet, sondern abgelehnt.
// Andernfalls koennte jeder, der `/data` beschreibt, der Flotte eine
// Schluesselmenge vorspielen, die kein Geraet je akzeptieren wuerde.

import (
	"errors"
	"sort"
	"time"
)

// TrustInfo ist die berichtbare Vertrauens-Identitaet.
//
// Jedes Feld ist so gebaut, dass ABWESENHEIT etwas anderes heisst als LEERE:
// ein alter Stand sendet den Block gar nicht („unbekannt"), ein neuer Stand
// ohne Zeremonie sendet ihn mit LEEREM RootKeyIDs („Image ohne Wurzel" - der
// dokumentierte Vor-TOFU-Zustand, kein Fehler).
type TrustInfo struct {
	// RootKeyIDs sind die key_ids der EINGEBACKENEN Wurzel dieses Images,
	// sortiert. Leer = dieses Image traegt (noch) keine Wurzel.
	RootKeyIDs []string
	// TrustSetKeyIDs sind die key_ids des abgelegten, gegen die Wurzel
	// GEPRUEFTEN Trust-Sets, sortiert. Leer = kein gueltiges Trust-Set.
	TrustSetKeyIDs []string
	// TrustSetGeneratedAt ist das `generated_at` desselben Trust-Sets (leer,
	// wenn es keines traegt) - der Stempel, an dem ein Rotations-Drill
	// erkennt, WELCHES Set eine Box hat.
	TrustSetGeneratedAt string
	// TrustSetSignedBy ist die Wurzel-key_id, mit der das Trust-Set
	// tatsaechlich unterschrieben wurde.
	TrustSetSignedBy string
	// TrustSetError ist der deutsche Grund, WARUM kein gueltiges Trust-Set
	// vorliegt (fehlt, nicht root-signiert, fehlerhaft). Leer bei Erfolg.
	//
	// Er wird berichtet, weil „diese Box hat kein Trust-Set" und „diese Box
	// hat eines, das wir nicht anerkennen" verschiedene Handlungen ausloesen -
	// das Erste ist ein offener Crossover, das Zweite ein Vorfall.
	TrustSetError string
}

// HasRoot sagt, ob dieses Image ueberhaupt einen Vertrauensanker traegt.
func (t TrustInfo) HasRoot() bool { return len(t.RootKeyIDs) > 0 }

// HasTrustSet sagt, ob ein gueltiges, root-signiertes Trust-Set vorliegt.
func (t TrustInfo) HasTrustSet() bool { return len(t.TrustSetKeyIDs) > 0 }

// KeyIDs liefert die sortierten key_ids eines Schluessel-Sets.
//
// Sortiert, damit zwei Boxen mit demselben Set denselben String melden - die
// Cloud vergleicht sie, und eine Reihenfolge, die von der Dateiform abhinge,
// machte aus zwei identischen Staenden zwei verschiedene.
func KeyIDs(ks *KeySet) []string {
	if ks == nil {
		return nil
	}
	out := make([]string, 0, len(ks.Keys))
	for _, k := range ks.Keys {
		out = append(out, k.KeyID)
	}
	sort.Strings(out)
	return out
}

// InspectTrust ermittelt die Vertrauens-Identitaet.
//
// `roots` ist die gebackene Wurzel (im Agenten [BakedRoots], im Werkzeug die
// ausdruecklich angegebene). `trustSet`/`trustSetSig` sind die ROHEN Bytes der
// abgelegten Dateien; fehlen sie, ist das kein Fehler, sondern der ehrliche
// Vor-Crossover-Zustand.
//
// Es gibt bewusst KEINEN Fehler-Rueckgabewert: die Funktion beantwortet immer
// etwas, denn „ich weiss es nicht" ist genau die Aussage, die eine
// TOFU-Verfolgung braucht. Was schiefging, steht in [TrustInfo.TrustSetError].
func InspectTrust(roots *KeySet, trustSet, trustSetSig []byte, now time.Time) TrustInfo {
	info := TrustInfo{RootKeyIDs: KeyIDs(roots)}
	if !info.HasRoot() {
		// Ohne Wurzel kann kein Trust-Set anerkannt werden - fail-closed wie
		// in Verify. Der Grund benennt genau das, statt das Set stumm zu
		// uebergehen.
		info.TrustSetError = "Diesem Stand ist kein Vertrauensanker eingebacken - " +
			"es kann kein Vertrauens-Set anerkannt werden."
		return info
	}
	if len(trustSet) == 0 || len(trustSetSig) == 0 {
		info.TrustSetError = "Auf diesem Geraet liegt kein root-signiertes Vertrauens-Set."
		return info
	}
	sig, err := ParseSignature(trustSetSig, DomainTrustSet)
	if err != nil {
		info.TrustSetError = "Signatur des Vertrauens-Sets unbrauchbar: " + err.Error()
		return info
	}
	rootKey, err := roots.find(sig.KeyID, now)
	if err != nil {
		info.TrustSetError = "Vertrauens-Set: " + err.Error()
		return info
	}
	if err := VerifyBytes(rootKey, DomainTrustSet, trustSet, sig); err != nil {
		info.TrustSetError = "Vertrauens-Set ist nicht gueltig root-signiert: " + err.Error()
		return info
	}
	// Erst JETZT parsen - vorher waren es nur Bytes unbekannter Herkunft. Die
	// Reihenfolge ist dieselbe wie in Verify und aus demselben Grund bindend.
	ks, err := ParseKeySet(trustSet)
	if err != nil {
		info.TrustSetError = "Vertrauens-Set ist fehlerhaft: " + err.Error()
		return info
	}
	info.TrustSetKeyIDs = KeyIDs(ks)
	info.TrustSetGeneratedAt = ks.GeneratedAt
	info.TrustSetSignedBy = sig.KeyID
	if len(info.TrustSetKeyIDs) == 0 {
		// Ein gueltig signiertes, aber LEERES Set ist eine gueltige Aussage
		// („ab jetzt gilt kein Release-Schluessel mehr" - der Total-Widerruf).
		// Es wird als solches berichtet, nicht als Fehler verkleidet.
		info.TrustSetError = "Das Vertrauens-Set ist gueltig signiert, nennt aber keinen " +
			"Release-Schluessel (Total-Widerruf)."
	}
	return info
}

// ErrNoTrustSet ist der Fehler, den Werkzeuge bekommen, wenn sie eine
// Trust-Set-Pruefung anfordern, aber keine Dateien liefern.
var ErrNoTrustSet = errors.New("kein Vertrauens-Set angegeben")
