package otaapply

// Die Regel des Aufraeumens - rein, ohne einen einzigen Container.
//
// Jeder Test hier prueft EINE Haelfte derselben Aussage: entfernt wird genau
// das Verwaiste, und die Rueckfallebene bleibt unter allen Umstaenden stehen.

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

const (
	coreRepo = "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core"
	nrRepo   = "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered"
)

func at(day int) time.Time {
	return time.Date(2026, 8, day, 12, 0, 0, 0, time.UTC)
}

// img baut EINEN `docker images`-Eintrag.
func img(id, repo, tag, digest string, created time.Time) ImageRecord {
	return ImageRecord{ID: id, Repo: repo, Tag: tag, Digest: digest, Created: created}
}

func refsOf(p PrunePlan) []string {
	var out []string
	for _, r := range p.Remove {
		out = append(out, r.Ref)
	}
	return out
}

func removesID(p PrunePlan, id string) bool {
	for _, r := range p.Remove {
		if r.ID == id {
			return true
		}
	}
	return false
}

// Die Referenz: nach mehreren Runden bleiben der laufende Stand, das
// Rueckfallziel und GENAU EIN abgeloestes Release stehen.
func TestOnlyTheOrphansOlderThanTheKeptReleaseAreRemoved(t *testing.T) {
	plan := PlanPrune(PruneInput{
		Policy: DefaultPrunePolicy(),
		Images: []ImageRecord{
			img("sha256:v4", coreRepo, "", "sha256:d4", at(4)), // laeuft
			img("sha256:v3", coreRepo, "", "sha256:d3", at(3)), // Vorgaenger
			img("sha256:v2", coreRepo, "", "sha256:d2", at(2)),
			img("sha256:v1", coreRepo, "", "sha256:d1", at(1)),
		},
		InUse:      []string{"sha256:v4"},
		Superseded: []string{"sha256:v3"},
	})
	if removesID(plan, "sha256:v4") {
		t.Fatal("das laufende Abbild darf nie entfernt werden")
	}
	if removesID(plan, "sha256:v3") {
		t.Fatalf("der zuletzt abgeloeste Stand bleibt bei der Vorgabe stehen: %v", refsOf(plan))
	}
	if !removesID(plan, "sha256:v2") || !removesID(plan, "sha256:v1") {
		t.Fatalf("die aelteren Verwaisten muessen weg: %v", refsOf(plan))
	}
	if len(plan.Keep) != 1 || plan.Keep[0] != "sha256:v3" {
		t.Fatalf("aufgehoben werden soll genau der Vorgaenger, ist %v", plan.Keep)
	}
}

// Der HALTER ist der Mechanismus - kein Sonderfall, sondern die allgemeine
// Regel „ein Abbild mit Container bleibt".
func TestAStoppedHolderContainerProtectsTheRollbackImage(t *testing.T) {
	plan := PlanPrune(PruneInput{
		Policy: PrunePolicy{Enabled: true, KeepReleases: 0, Source: "test"},
		Images: []ImageRecord{
			img("sha256:new", coreRepo, "", "sha256:dn", at(4)),
			img("sha256:lkg", coreRepo, "", "sha256:dl", at(3)),
			img("sha256:old", coreRepo, "", "sha256:do", at(1)),
		},
		// Der laufende Container UND der gestoppte Rueckfall-Halter.
		InUse: []string{"sha256:new", "sha256:lkg"},
	})
	if removesID(plan, "sha256:lkg") {
		t.Fatalf("ein Abbild, auf das ein GESTOPPTER Container zeigt, bleibt: %v", refsOf(plan))
	}
	if !removesID(plan, "sha256:old") {
		t.Fatalf("das wirklich verwaiste Abbild muss weg: %v", refsOf(plan))
	}
}

// Der `:lkg`-Tag bleibt, auch wenn sein Halter fehlt - docker selbst schuetzt
// hier NICHT (einen Tag abzuhaengen gelingt trotz Container).
func TestTheRollbackNamespaceIsNeverRemovedEvenWithoutItsHolder(t *testing.T) {
	plan := PlanPrune(PruneInput{
		Policy: PrunePolicy{Enabled: true, KeepReleases: 0, Source: "test"},
		Images: []ImageRecord{
			img("sha256:lkg", LKGTagPrefix+"core", "lkg", "", at(3)),
			img("sha256:lkg", coreRepo, "", "sha256:dl", at(3)),
			img("sha256:old", coreRepo, "", "sha256:do", at(1)),
		},
		InUse: nil, // kein einziger Container - der haerteste Fall
	})
	if removesID(plan, "sha256:lkg") {
		t.Fatalf("der Rueckfall-Namensraum ist tabu: %v", refsOf(plan))
	}
	if !removesID(plan, "sha256:old") {
		t.Fatalf("das Verwaiste muss trotzdem weg: %v", refsOf(plan))
	}
}

// Ausdruecklich Geschuetztes (Ziel, Rueckfall, eine vorab geholte Zuweisung)
// bleibt, ohne dass ein Container darauf zeigen muesste.
func TestProtectedReferencesSurviveWithoutAContainer(t *testing.T) {
	plan := PlanPrune(PruneInput{
		Policy: PrunePolicy{Enabled: true, KeepReleases: 0, Source: "test"},
		Images: []ImageRecord{
			img("sha256:next", coreRepo, "", "sha256:dn", at(5)), // vorab geholt
			img("sha256:old", coreRepo, "", "sha256:do", at(1)),
		},
		Protected: []string{"sha256:next"},
	})
	if removesID(plan, "sha256:next") {
		t.Fatalf("ein vorab geholtes naechstes Ziel bleibt: %v", refsOf(plan))
	}
	if !removesID(plan, "sha256:old") {
		t.Fatalf("das Verwaiste muss weg: %v", refsOf(plan))
	}
}

// Die Kulanz zaehlt JE REPOSITORY - sonst behielte „eines aufheben" den
// Vorgaenger von core und entfernte den von nodered.
func TestTheKeptReleaseIsCountedPerRepository(t *testing.T) {
	plan := PlanPrune(PruneInput{
		Policy: DefaultPrunePolicy(),
		Images: []ImageRecord{
			img("sha256:c3", coreRepo, "", "sha256:c3d", at(3)),
			img("sha256:c2", coreRepo, "", "sha256:c2d", at(2)),
			img("sha256:c1", coreRepo, "", "sha256:c1d", at(1)),
			img("sha256:n3", nrRepo, "", "sha256:n3d", at(3)),
			img("sha256:n2", nrRepo, "", "sha256:n2d", at(2)),
			img("sha256:n1", nrRepo, "", "sha256:n1d", at(1)),
		},
		InUse: []string{"sha256:c3", "sha256:n3"},
	})
	for _, keep := range []string{"sha256:c2", "sha256:n2"} {
		if removesID(plan, keep) {
			t.Fatalf("je Repository bleibt ein abgeloestes Release: %v", refsOf(plan))
		}
	}
	for _, gone := range []string{"sha256:c1", "sha256:n1"} {
		if !removesID(plan, gone) {
			t.Fatalf("die aelteren muessen weg: %v", refsOf(plan))
		}
	}
}

// Die Kandidatenmenge ist die ganze Zusage: was nicht in der Liste steht, kann
// nicht entfernt werden - ein fremdes Abbild kommt gar nicht in ihre Naehe.
func TestNothingOutsideTheCandidateListCanBeRemoved(t *testing.T) {
	plan := PlanPrune(PruneInput{
		Policy: PrunePolicy{Enabled: true, KeepReleases: 0, Source: "test"},
		Images: []ImageRecord{img("sha256:old", coreRepo, "", "sha256:do", at(1))},
	})
	if len(plan.Remove) != 1 || plan.Remove[0].ID != "sha256:old" {
		t.Fatalf("nur der eine Kandidat darf im Plan stehen: %v", refsOf(plan))
	}
}

// Entfernt wird ueber NAMEN, und ein Abbild mit Tag UND Digest braucht beide -
// sonst ueberlebt es unter der jeweils anderen Referenz.
func TestEveryNameOfARemovedImageIsListed(t *testing.T) {
	plan := PlanPrune(PruneInput{
		Policy: PrunePolicy{Enabled: true, KeepReleases: 0, Source: "test"},
		Images: []ImageRecord{img("sha256:old", coreRepo, "v1", "sha256:do", at(1))},
	})
	got := refsOf(plan)
	want := []string{coreRepo + ":v1", coreRepo + "@sha256:do"}
	if len(got) != len(want) {
		t.Fatalf("erwartet %v, ist %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("erwartet %v, ist %v", want, got)
		}
	}
}

// Ein Abbild ganz ohne Namen wird ueber seine Kennung entfernt.
func TestAnUnnamedImageIsRemovedByItsID(t *testing.T) {
	plan := PlanPrune(PruneInput{
		Policy: PrunePolicy{Enabled: true, KeepReleases: 0, Source: "test"},
		Images: []ImageRecord{img("sha256:old", "", "", "", at(1))},
	})
	if len(plan.Remove) != 1 || plan.Remove[0].Ref != "sha256:old" {
		t.Fatalf("erwartet die Kennung als Referenz, ist %v", refsOf(plan))
	}
}

// Eine Kennung, die in EINEM Repository aufgehoben wird, bleibt ueberall.
func TestAnIDKeptInOneRepositoryIsNeverRemovedViaAnother(t *testing.T) {
	plan := PlanPrune(PruneInput{
		Policy: DefaultPrunePolicy(),
		Images: []ImageRecord{
			img("sha256:shared", coreRepo, "", "sha256:a", at(2)),
			img("sha256:shared", nrRepo, "", "sha256:b", at(2)),
			img("sha256:nrOld", nrRepo, "", "sha256:c", at(1)),
		},
	})
	if removesID(plan, "sha256:shared") {
		t.Fatalf("eine anderswo aufgehobene Kennung darf nirgends entfernt werden: %v", refsOf(plan))
	}
}

// Eine unbekannte Bau-Zeit gilt als NEU - die vorsichtige Richtung.
func TestAnUnknownBuildTimeIsTreatedAsRecent(t *testing.T) {
	plan := PlanPrune(PruneInput{
		Policy: DefaultPrunePolicy(),
		Images: []ImageRecord{
			img("sha256:dated", coreRepo, "", "sha256:a", at(3)),
			img("sha256:undated", coreRepo, "", "sha256:b", time.Time{}),
		},
	})
	if removesID(plan, "sha256:undated") {
		t.Fatalf("ohne Bau-Zeit wird eher aufgehoben als entfernt: %v", refsOf(plan))
	}
}

// Der zuletzt abgeloeste Stand gewinnt die Kulanz auch dann, wenn seine
// Bau-Zeit aelter aussieht (ein neu gebautes Rueckfall-Abbild ist real).
func TestTheSupersededReleaseWinsTheGraceRegardlessOfBuildTime(t *testing.T) {
	plan := PlanPrune(PruneInput{
		Policy: DefaultPrunePolicy(),
		Images: []ImageRecord{
			img("sha256:stray", coreRepo, "", "sha256:s", at(9)),
			img("sha256:prev", coreRepo, "", "sha256:p", at(1)),
		},
		Superseded: []string{"sha256:prev"},
	})
	if removesID(plan, "sha256:prev") {
		t.Fatalf("der Vorgaenger bleibt: %v", refsOf(plan))
	}
	if !removesID(plan, "sha256:stray") {
		t.Fatalf("das andere Verwaiste muss weg: %v", refsOf(plan))
	}
}

// Ausgeschaltet heisst: NICHTS - und der Grund wird genannt.
func TestDisabledPlansNothingAndSaysWhy(t *testing.T) {
	plan := PlanPrune(PruneInput{
		Policy: PrunePolicy{Enabled: false, Source: PruneSourceDevice},
		Images: []ImageRecord{img("sha256:old", coreRepo, "", "sha256:do", at(1))},
	})
	if len(plan.Remove) != 0 {
		t.Fatalf("ausgeschaltet darf nichts geplant werden: %v", refsOf(plan))
	}
	if plan.Skipped == "" {
		t.Fatal("ein Nicht-Aufraeumen ohne Grund waere ein Raetsel")
	}
}

// ---------------------------------------------------------------------------
// Der Schalter
// ---------------------------------------------------------------------------

func TestThePolicyDefaultsToCleaningUpOneKeptRelease(t *testing.T) {
	got := ResolvePrunePolicy(t.TempDir(), PrunePolicy{})
	if !got.Enabled || got.KeepReleases != DefaultPruneKeepReleases ||
		got.Source != PruneSourceDefault {
		t.Fatalf("die Vorgabe muss aufraeumen und eines aufheben, ist %+v", got)
	}
}

func TestTheDeviceSwitchOverridesTheFleetDefault(t *testing.T) {
	dir := t.TempDir()
	no := false
	if err := WriteJSON(dir, FilePrune, PruneSwitch{Enabled: &no}); err != nil {
		t.Fatal(err)
	}
	got := ResolvePrunePolicy(dir, PrunePolicy{Enabled: true, KeepReleases: 2, Source: "umgebung"})
	if got.Enabled {
		t.Fatalf("der Geraete-Schalter gewinnt, ist %+v", got)
	}
	if got.KeepReleases != 2 {
		t.Fatalf("eine nicht genannte Zahl bleibt die der Flotte, ist %+v", got)
	}
	if got.Source != PruneSourceDevice {
		t.Fatalf("die Herkunft muss die Datei sein, ist %q", got.Source)
	}
}

// Nur die Zahl zu setzen darf das Aufraeumen NICHT abschalten - deshalb sind
// die Felder Zeiger.
func TestSettingOnlyTheCountLeavesTheSwitchAlone(t *testing.T) {
	dir := t.TempDir()
	zero := 0
	if err := WriteJSON(dir, FilePrune, PruneSwitch{KeepReleases: &zero}); err != nil {
		t.Fatal(err)
	}
	got := ResolvePrunePolicy(dir, PrunePolicy{})
	if !got.Enabled {
		t.Fatalf("eine reine Zahl-Angabe schaltet nichts ab, ist %+v", got)
	}
	if got.KeepReleases != 0 {
		t.Fatalf("eine ausdrueckliche 0 ist gueltig, ist %+v", got)
	}
}

// Eine UNLESBARE Datei ist etwas anderes als „nichts gesagt": dann wird nicht
// geraten, sondern nichts entfernt.
func TestAnUnreadableSwitchStopsTheCleanupInsteadOfGuessing(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(Dir(dir), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(Dir(dir), FilePrune), []byte("{kaputt"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := ResolvePrunePolicy(dir, PrunePolicy{})
	if got.Enabled || got.Source != PruneSourceUnreadable {
		t.Fatalf("unlesbar heisst nichts entfernen, ist %+v", got)
	}
}

// Der Rueckfall-Namensraum ist EINE Zeichenkette - Regel und Wirkung duerfen
// nie auseinanderlaufen.
func TestTheRollbackNamespaceMatchesTheNamesTheEngineWrites(t *testing.T) {
	if LKGTagPrefix != "vp-edge-lkg-" {
		t.Fatalf("das Praefix ist ein Vertrag mit otaupdater (lkgTag/lkgHolder), ist %q", LKGTagPrefix)
	}
}
