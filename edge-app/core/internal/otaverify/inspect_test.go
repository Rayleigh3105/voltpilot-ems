package otaverify

import (
	"strings"
	"testing"
	"time"
)

// Die Vertrauens-Identitaet beantwortet zwei Betriebsfragen (OTA Stufe 4):
// „traegt diese Box schon ein schluesseltragendes Image?" (TOFU-Abschluss) und
// „hat sie das neue Trust-Set schon gesehen?" (Rotations-Drill). Diese Tests
// nageln vor allem fest, dass sie dabei NIE etwas behauptet, was sie nicht
// gegen die eingebackene Wurzel geprueft hat.

func TestInspectTrustReportsTheVerifiedTrustSet(t *testing.T) {
	w := newWorld(t)
	got := InspectTrust(w.in.Roots, w.in.TrustSet, w.in.TrustSetSig, w.in.Now)

	if !got.HasRoot() || len(got.RootKeyIDs) != 1 || got.RootKeyIDs[0] != "root-2026-a" {
		t.Fatalf("root key ids = %v, want [root-2026-a]", got.RootKeyIDs)
	}
	if !got.HasTrustSet() || len(got.TrustSetKeyIDs) != 1 || got.TrustSetKeyIDs[0] != "rel-2026-a" {
		t.Fatalf("trust set key ids = %v, want [rel-2026-a]", got.TrustSetKeyIDs)
	}
	if got.TrustSetSignedBy != "root-2026-a" {
		t.Fatalf("signed by = %q", got.TrustSetSignedBy)
	}
	if got.TrustSetError != "" {
		t.Fatalf("unexpected error on a healthy chain: %q", got.TrustSetError)
	}
}

// Der Rotations-Drill haengt an genau diesem Stempel: er unterscheidet die Box,
// die das neue Set schon hat, von der, die noch das alte faehrt.
func TestInspectTrustCarriesTheGeneratedStampSoARotationIsObservable(t *testing.T) {
	root := newPair(t, "root-2026-a")
	relA := newPair(t, "rel-2026-a")
	relB := newPair(t, "rel-2026-b")
	roots := &KeySet{SchemaVersion: SignatureSchemaVersion, Keys: []PublicKey{root.keySetEntry("")}}

	alt := mustJSON(t, KeySet{SchemaVersion: SignatureSchemaVersion,
		GeneratedAt: "2026-08-01T10:00:00Z", Keys: []PublicKey{relA.keySetEntry("")}})
	neu := mustJSON(t, KeySet{SchemaVersion: SignatureSchemaVersion,
		GeneratedAt: "2026-09-01T10:00:00Z", Keys: []PublicKey{relB.keySetEntry("")}})

	before := InspectTrust(roots, alt, signDoc(t, root, DomainTrustSet, alt), time.Now())
	after := InspectTrust(roots, neu, signDoc(t, root, DomainTrustSet, neu), time.Now())

	if before.TrustSetGeneratedAt != "2026-08-01T10:00:00Z" {
		t.Fatalf("before = %q", before.TrustSetGeneratedAt)
	}
	if after.TrustSetGeneratedAt != "2026-09-01T10:00:00Z" {
		t.Fatalf("after = %q", after.TrustSetGeneratedAt)
	}
	// Der widerrufene Schluessel darf nach der Rotation nirgends mehr auftauchen.
	if len(after.TrustSetKeyIDs) != 1 || after.TrustSetKeyIDs[0] != "rel-2026-b" {
		t.Fatalf("after keys = %v, want only rel-2026-b", after.TrustSetKeyIDs)
	}
}

// Ein Image ohne Wurzel ist der dokumentierte VOR-Crossover-Zustand: eine
// ehrliche Aussage, kein Fehler - aber es darf dann auch kein Trust-Set
// anerkennen, sonst waere „geprueft" ein leeres Wort.
func TestInspectTrustReportsAKeylessImageWithoutAcceptingAnything(t *testing.T) {
	w := newWorld(t)
	got := InspectTrust(&KeySet{SchemaVersion: SignatureSchemaVersion}, w.in.TrustSet,
		w.in.TrustSetSig, w.in.Now)

	if got.HasRoot() || len(got.RootKeyIDs) != 0 {
		t.Fatalf("expected no baked root, got %v", got.RootKeyIDs)
	}
	if got.HasTrustSet() {
		t.Fatal("a keyless image must never report an accepted trust set")
	}
	if !strings.Contains(got.TrustSetError, "Vertrauensanker") {
		t.Fatalf("reason should name the missing anchor, got %q", got.TrustSetError)
	}
}

// Wer `/data` beschreiben kann, darf der Flotte keine Schluesselmenge
// vorspielen, die kein Geraet je akzeptieren wuerde.
func TestInspectTrustRefusesATrustSetTheRootDidNotSign(t *testing.T) {
	w := newWorld(t)
	fremd := newPair(t, "root-fremd")
	got := InspectTrust(w.in.Roots, w.in.TrustSet, signDoc(t, fremd, DomainTrustSet, w.in.TrustSet),
		w.in.Now)

	if got.HasTrustSet() {
		t.Fatalf("a foreign-signed trust set must not be reported: %v", got.TrustSetKeyIDs)
	}
	if got.TrustSetError == "" {
		t.Fatal("a refusal must carry its reason")
	}
	// Die Wurzel selbst ist davon unberuehrt - das Image ist ja gekreuzt.
	if !got.HasRoot() {
		t.Fatal("the baked root is a property of the image, not of the placed file")
	}
}

func TestInspectTrustReportsAMissingTrustSetAsTheOpenCrossoverItIs(t *testing.T) {
	w := newWorld(t)
	got := InspectTrust(w.in.Roots, nil, nil, w.in.Now)

	if !got.HasRoot() {
		t.Fatal("root should still be reported")
	}
	if got.HasTrustSet() {
		t.Fatal("no trust set placed, nothing may be claimed")
	}
	if !strings.Contains(got.TrustSetError, "kein root-signiertes Vertrauens-Set") {
		t.Fatalf("reason = %q", got.TrustSetError)
	}
}

// Ein gueltig signiertes, aber LEERES Set ist der Total-Widerruf - eine
// gueltige Aussage, die als solche berichtet und nicht als Fehler verkleidet
// wird.
func TestInspectTrustNamesATotalRevocation(t *testing.T) {
	root := newPair(t, "root-2026-a")
	roots := &KeySet{SchemaVersion: SignatureSchemaVersion, Keys: []PublicKey{root.keySetEntry("")}}
	leer := mustJSON(t, KeySet{SchemaVersion: SignatureSchemaVersion, GeneratedAt: "2026-09-02T00:00:00Z"})

	got := InspectTrust(roots, leer, signDoc(t, root, DomainTrustSet, leer), time.Now())
	if got.HasTrustSet() {
		t.Fatal("an empty set grants nothing")
	}
	if !strings.Contains(got.TrustSetError, "Total-Widerruf") {
		t.Fatalf("reason = %q", got.TrustSetError)
	}
	if got.TrustSetGeneratedAt != "2026-09-02T00:00:00Z" {
		t.Fatalf("the stamp of a revocation set still travels: %q", got.TrustSetGeneratedAt)
	}
}

// Zwei Boxen mit demselben Set muessen denselben String melden - die Cloud
// vergleicht sie.
func TestKeyIDsAreSortedSoTwoBoxesWithTheSameSetAgree(t *testing.T) {
	ks := &KeySet{SchemaVersion: SignatureSchemaVersion, Keys: []PublicKey{
		newPair(t, "rel-2026-c").keySetEntry(""),
		newPair(t, "rel-2026-a").keySetEntry(""),
		newPair(t, "rel-2026-b").keySetEntry(""),
	}}
	got := KeyIDs(ks)
	want := []string{"rel-2026-a", "rel-2026-b", "rel-2026-c"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("KeyIDs = %v, want %v", got, want)
		}
	}
	if KeyIDs(nil) != nil {
		t.Fatal("nil set yields nil")
	}
}
