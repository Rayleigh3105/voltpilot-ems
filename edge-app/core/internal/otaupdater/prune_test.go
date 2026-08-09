package otaupdater

// Das Aufraeumen abgeloester Abbilder - gegen die geschriebene docker-Welt.
//
// Die REGEL ist in [otaapply] rein geprueft; hier steht die WIRKUNG: laeuft es
// an der richtigen Stelle, sieht es nur die eigenen Repositories, ueberlebt
// die Rueckfallebene, und kann es einen bestaetigten Tausch nie kippen.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

// swapAndConfirm faehrt einen vollstaendigen, bestaetigten Tausch.
func (r *rig) swapAndConfirm() {
	r.t.Helper()
	r.runToSelfTest()
	r.selfTest(true, "in Ordnung")
	r.tick()
	if st := r.state(); st.State != otaapply.StateSucceeded {
		r.t.Fatalf("der Tausch wurde nicht bestaetigt: %+v", st)
	}
}

func (r *rig) removedImages() []string {
	var out []string
	for _, l := range r.fd.log {
		if i := strings.Index(l, "docker image rm "); i == 0 {
			out = append(out, strings.TrimSpace(strings.TrimPrefix(l, "docker image rm ")))
		}
	}
	return out
}

// DIE Referenz: nach dem bestaetigten Tausch sind die verwaisten Abbilder
// frueherer Releases weg - und ALLES, was die Rueckfallebene traegt, steht.
func TestAConfirmedSwapRemovesOrphansAndNeverTheRollbackTarget(t *testing.T) {
	r := newRig(t)
	// Ein Stand aus einer frueheren Runde, den niemand mehr haelt - genau die
	// Sorte Abbild, die auf der Pilsting-Karte 58-mal lag.
	old := digest(coreRepo, 'e')
	oldNr := digest(nrRepo, 'f')
	r.fd.present(old)
	r.fd.present(oldNr)
	// Danach erst der LAUFENDE Stand, damit er der juengere ist.
	r.fd.clock++
	r.fd.created[digest(coreRepo, 'a')] = r.fd.clock
	r.fd.clock++
	r.fd.created[digest(nrRepo, 'b')] = r.fd.clock

	r.assign(nil)
	r.swapAndConfirm()

	removed := r.removedImages()
	for _, ref := range []string{old, oldNr} {
		if r.fd.hasImage(ref) {
			t.Fatalf("das verwaiste Abbild '%s' muesste weg sein (entfernt: %v)", ref, removed)
		}
	}
	// 1. Das laufende Ziel.
	for _, ref := range []string{digest(coreRepo, 'c'), digest(nrRepo, 'd')} {
		if !r.fd.hasImage(ref) {
			t.Fatalf("das LAUFENDE Abbild '%s' darf nie entfernt werden", ref)
		}
	}
	// 2. Der `:lkg`-Tag UND sein gestoppter Halter.
	for _, comp := range []string{"core", "nodered"} {
		if !r.fd.hasImage(lkgTag(comp)) {
			t.Fatalf("der Rueckfall-Tag '%s' fehlt", lkgTag(comp))
		}
		if _, ok := r.fd.holders[lkgHolder(comp)]; !ok {
			t.Fatalf("der Rueckfall-Halter '%s' fehlt", lkgHolder(comp))
		}
	}
	// 3. Das `docker save`-Archiv - eine DATEI, per Konstruktion ausserhalb der
	//    Reichweite jeder Abbild-Entfernung.
	for _, comp := range []string{"core", "nodered"} {
		tar := filepath.Join(otaapply.Dir(r.dataDir), otaapply.SubdirLKG, comp+".tar")
		if !r.fd.tars[tar] {
			t.Fatalf("das Rueckfall-Archiv '%s' fehlt", tar)
		}
	}
	// 4. Die Kulanz: der zuletzt abgeloeste Stand bleibt bei der Vorgabe liegen.
	for _, ref := range []string{digest(coreRepo, 'a'), digest(nrRepo, 'b')} {
		if !r.fd.hasImage(ref) {
			t.Fatalf("der Vorgaenger '%s' bleibt bei der Vorgabe (eines aufheben) stehen", ref)
		}
	}
}

// Zwei Runden hintereinander: es bleiben der laufende Stand und GENAU EIN
// abgeloester - der Fall, um den es auf der Karte geht.
func TestAfterTwoUpdatesOnlyTheCurrentAndOneSupersededStandRemain(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.swapAndConfirm()

	// Runde zwei auf einen dritten Stand.
	r.now = r.now.Add(time.Hour)
	r.e.o.Token = func() string { return "tok-2" }
	r.assign(func(m *otaverify.Manifest) {
		m.Release, m.ReleaseSeq = "edge-2026.08.1", 13
		m.Artifacts = []otaverify.Artifact{
			{Type: otaverify.ArtifactOCIImage, Name: "core", Ref: digest(coreRepo, '1')},
			{Type: otaverify.ArtifactOCIImage, Name: "nodered", Ref: digest(nrRepo, '2')},
		}
	})
	r.signalCore(func(s *otaapply.CoreSignal) { s.Version = "edge-2026.08.0" })
	r.swapAndConfirm()

	if r.fd.hasImage(digest(coreRepo, 'a')) || r.fd.hasImage(digest(nrRepo, 'b')) {
		t.Fatalf("der Stand von vor zwei Runden muss weg sein (entfernt: %v)", r.removedImages())
	}
	for _, ref := range []string{
		digest(coreRepo, '1'), digest(nrRepo, '2'), // laeuft
		digest(coreRepo, 'c'), digest(nrRepo, 'd'), // die Kulanz
	} {
		if !r.fd.hasImage(ref) {
			t.Fatalf("'%s' haette stehen bleiben muessen", ref)
		}
	}
}

// Ausgeschaltet je Geraet: KEIN einziges Entfernen - und der Tausch laeuft
// unveraendert durch.
func TestTheDeviceSwitchTurnsTheCleanupOffCompletely(t *testing.T) {
	r := newRig(t)
	no := false
	if err := otaapply.WriteJSON(r.dataDir, otaapply.FilePrune,
		otaapply.PruneSwitch{Enabled: &no}); err != nil {
		t.Fatal(err)
	}
	r.fd.present(digest(coreRepo, 'e'))
	r.assign(nil)
	r.swapAndConfirm()

	if got := r.removedImages(); len(got) != 0 {
		t.Fatalf("ausgeschaltet darf nichts entfernt werden, entfernt wurde: %v", got)
	}
	if !r.fd.hasImage(digest(coreRepo, 'e')) {
		t.Fatal("das verwaiste Abbild haette stehen bleiben muessen")
	}
}

// Die Reinigung ist die Kuer, der Tausch die Pflicht: ein Fehlschlag beim
// Aufraeumen darf einen bestaetigten Tausch nie kippen.
func TestACleanupFailureNeverBreaksAConfirmedSwap(t *testing.T) {
	r := newRig(t)
	r.fd.present(digest(coreRepo, 'e'))
	r.assign(nil)
	r.runToSelfTest()
	r.selfTest(true, "in Ordnung")
	// Erst JETZT scheitern lassen - vorher braucht der Tausch `docker images`
	// nicht, und der Fehler soll genau die Reinigung treffen.
	r.fd.failOn["docker images"] = "der docker-Daemon antwortet nicht"
	r.tick()

	if st := r.state(); st.State != otaapply.StateSucceeded {
		t.Fatalf("der Tausch muss bestaetigt bleiben, ist %+v", st)
	}
	if got := r.removedImages(); len(got) != 0 {
		t.Fatalf("ohne vollstaendige Liste darf NICHTS entfernt werden, entfernt: %v", got)
	}
	if !strings.Contains(r.logs.String(), "es wird nichts aufgeraeumt") {
		t.Fatalf("der Abbruch muss benannt werden:\n%s", r.logs.String())
	}
}

// Ohne belastbare Sicht auf die belegten Abbilder wird NICHT geraten.
func TestWithoutTheInUseListNothingIsRemoved(t *testing.T) {
	r := newRig(t)
	r.fd.present(digest(coreRepo, 'e'))
	r.assign(nil)
	r.runToSelfTest()
	r.selfTest(true, "in Ordnung")
	r.fd.failOn["docker ps"] = "der docker-Daemon antwortet nicht"
	r.tick()

	if st := r.state(); st.State != otaapply.StateSucceeded {
		t.Fatalf("der Tausch muss bestaetigt bleiben, ist %+v", st)
	}
	if got := r.removedImages(); len(got) != 0 {
		t.Fatalf("ohne belegte Abbilder darf nichts entfernt werden, entfernt: %v", got)
	}
}

// Eine ZURUECKNAHME raeumt nichts auf - dort ist jedes Abbild potenziell das,
// worauf gleich zurueckgefallen wird.
func TestARollbackNeverCleansUp(t *testing.T) {
	r := newRig(t)
	r.fd.present(digest(coreRepo, 'e'))
	r.assign(nil)
	r.runToSelfTest()
	r.selfTest(false, "der Steuerpfad hat den Trockenlauf nicht bestanden")
	r.tick()

	if st := r.state(); st.State != otaapply.StateRolledBack {
		t.Fatalf("erwartet eine Ruecknahme, ist %+v", st)
	}
	if got := r.removedImages(); len(got) != 0 {
		t.Fatalf("eine Ruecknahme raeumt nichts auf, entfernt: %v", got)
	}
}

// Ein vorab geholtes NAECHSTES Ziel bleibt stehen - genau das naehme ein
// pauschales `image prune -a` mit.
func TestAPrefetchedNextTargetIsProtected(t *testing.T) {
	r := newRig(t)
	next := digest(coreRepo, '1')
	nextNr := digest(nrRepo, '2')
	r.assign(nil)
	r.runToSelfTest()
	r.selfTest(true, "in Ordnung")
	// Waehrend des Tausches ist eine neue Zuweisung eingetroffen und ihre
	// Abbilder liegen schon lokal.
	r.fd.present(next)
	r.fd.present(nextNr)
	r.assign(func(m *otaverify.Manifest) {
		m.Release, m.ReleaseSeq = "edge-2026.08.1", 13
		m.Artifacts = []otaverify.Artifact{
			{Type: otaverify.ArtifactOCIImage, Name: "core", Ref: next},
			{Type: otaverify.ArtifactOCIImage, Name: "nodered", Ref: nextNr},
		}
	})
	r.tick()

	for _, ref := range []string{next, nextNr} {
		if !r.fd.hasImage(ref) {
			t.Fatalf("das vorab geholte naechste Ziel '%s' darf nicht entfernt werden (entfernt: %v)",
				ref, r.removedImages())
		}
	}
}

// Ein unlesbarer Schalter ist etwas anderes als „nichts gesagt": dann wird
// nichts entfernt.
func TestAnUnreadableSwitchStopsTheCleanup(t *testing.T) {
	r := newRig(t)
	if err := os.WriteFile(filepath.Join(otaapply.Dir(r.dataDir), otaapply.FilePrune),
		[]byte("{kaputt"), 0o644); err != nil {
		t.Fatal(err)
	}
	r.fd.present(digest(coreRepo, 'e'))
	r.assign(nil)
	r.swapAndConfirm()

	if got := r.removedImages(); len(got) != 0 {
		t.Fatalf("ein unlesbarer Schalter haelt die Reinigung an, entfernt: %v", got)
	}
}

// Die Kandidatenmenge sind AUSSCHLIESSLICH die Repositories, die dieses Geraet
// selbst getauscht hat - der Aktualisierer selbst und jedes fremde Abbild
// kommen gar nicht in die Naehe.
func TestOnlyOurOwnRepositoriesAreEverListed(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.swapAndConfirm()

	for _, l := range r.fd.log {
		if !strings.HasPrefix(l, "docker images") {
			continue
		}
		repo := l[strings.LastIndex(l, " ")+1:]
		if repo != coreRepo && repo != nrRepo {
			t.Fatalf("es wurde ein fremdes Repository aufgelistet: %q", repo)
		}
	}
}

// Der Rueckfall-Namensraum wird nie als Kandidat aufgelistet.
func TestPrunableReposSkipTheRollbackNamespaceAndKeepRegistryPorts(t *testing.T) {
	repos := prunableRepos(
		map[string]string{"core": "127.0.0.1:5999/soak/core@sha256:aa"},
		otaapply.LKG{Images: map[string]otaapply.LKGImage{
			"core": {Digest: "127.0.0.1:5999/soak/core@sha256:bb", Tag: lkgTag("core")},
		}},
		otaapply.LKG{Images: map[string]otaapply.LKGImage{
			"core": {Ref: otaapply.LKGTagPrefix + "core:lkg"},
		}},
	)
	if len(repos) != 1 || repos[0] != "127.0.0.1:5999/soak/core" {
		t.Fatalf("erwartet genau das eigene Repository (mit Registry-Port), ist %v", repos)
	}
}

func TestImageRepoSplitsTagsAndDigestsButNotRegistryPorts(t *testing.T) {
	cases := map[string]string{
		"repo/name@sha256:aa":       "repo/name",
		"repo/name:v1":              "repo/name",
		"127.0.0.1:5999/soak/core":  "127.0.0.1:5999/soak/core",
		"127.0.0.1:5999/core:v1":    "127.0.0.1:5999/core",
		"127.0.0.1:5999/c@sha256:a": "127.0.0.1:5999/c",
		"":                          "",
	}
	for in, want := range cases {
		if got := imageRepo(in); got != want {
			t.Fatalf("imageRepo(%q) = %q, erwartet %q", in, got, want)
		}
	}
}
