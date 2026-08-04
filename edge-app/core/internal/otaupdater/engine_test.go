package otaupdater

// Die Orchestrierung - gegen eine GESCHRIEBENE docker-Welt.
//
// Der Sinn des [Runner]-Schnitts ist genau dieser Test: jede Sicherheitsregel,
// die an einer REIHENFOLGE haengt (erst holen, dann sichern, dann die
// Brotkrume, dann EINE Komponente), ist hier ohne einen einzigen Container
// pruefbar - und die Ausfallmodi, auf die es ankommt (Digest passt nicht,
// Selbsttest scheitert, `prune -a` hat das Rueckfall-Image geholt, die Frist
// laeuft ab), sind als Eingabe beschreibbar statt nur im Feld beobachtbar.

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

const (
	coreRepo = "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core"
	nrRepo   = "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered"
)

func digest(repo string, c byte) string {
	return repo + "@sha256:" + strings.Repeat(string(c), 64)
}

// ---------------------------------------------------------------------------
// Die geschriebene docker-Welt
// ---------------------------------------------------------------------------

type fakeContainer struct {
	imageRef string
	running  bool
	restarts int
	health   string
}

type fakeDocker struct {
	t          *testing.T
	log        []string
	images     map[string]bool   // vorhandene Referenzen/Tags
	digests    map[string]string // Referenz -> Repo-Digest (das, was inspect meldet)
	containers map[string]*fakeContainer
	tars       map[string]bool
	// envPath ist die .env, die der Motor pinnt (der Stellvertreter liest sie,
	// damit ein `up -d` dasselbe Image nimmt, das compose naehme).
	envPath string
	// failOn laesst EIN Kommando scheitern (Teilzeichenketten-Vergleich).
	failOn map[string]string
	// pulledWrongDigest simuliert einen Pull, der andere Bytes brachte.
	pulledWrongDigest map[string]bool
}

func newFakeDocker(t *testing.T) *fakeDocker {
	f := &fakeDocker{
		t: t, images: map[string]bool{}, digests: map[string]string{},
		containers: map[string]*fakeContainer{}, tars: map[string]bool{},
		failOn: map[string]string{}, pulledWrongDigest: map[string]bool{},
	}
	// Der laufende Stand vor dem Update.
	f.present(digest(coreRepo, 'a'))
	f.present(digest(nrRepo, 'b'))
	f.containers["core"] = &fakeContainer{imageRef: digest(coreRepo, 'a'), running: true}
	f.containers["nodered"] = &fakeContainer{imageRef: digest(nrRepo, 'b'), running: true}
	return f
}

func (f *fakeDocker) present(ref string) {
	f.images[ref] = true
	f.digests[ref] = ref
}

func (f *fakeDocker) Run(_ context.Context, name string, args ...string) (string, error) {
	line := name + " " + strings.Join(args, " ")
	f.log = append(f.log, line)
	for prefix, msg := range f.failOn {
		if strings.Contains(line, prefix) {
			return "", fmt.Errorf("%s", msg)
		}
	}

	switch {
	case len(args) >= 2 && args[0] == "pull":
		ref := args[1]
		if f.pulledWrongDigest[ref] {
			// Die Bytes sind da, aber es sind die falschen.
			f.images[ref] = true
			f.digests[ref] = strings.Split(ref, "@")[0] + "@sha256:" + strings.Repeat("f", 64)
			return "", nil
		}
		f.present(ref)
		return "", nil

	case len(args) >= 4 && args[0] == "image" && args[1] == "inspect":
		// Der Motor fragt sowohl mit einer Referenz als auch mit der lokalen
		// Image-Kennung (so loest er den Digest des LAUFENDEN Containers auf).
		ref := strings.TrimPrefix(args[len(args)-1], "sha256:id-")
		if !f.images[ref] {
			return "", fmt.Errorf("No such image: %s", ref)
		}
		if args[3] == "{{.Id}}" {
			return "sha256:id-" + ref + "\n", nil
		}
		d := f.digests[ref]
		raw, _ := json.Marshal([]string{d})
		return string(raw) + "\n", nil

	case args[0] == "tag":
		f.images[args[2]] = true
		f.digests[args[2]] = f.digests[args[1]]
		return "", nil

	case args[0] == "rm":
		return "", nil

	case args[0] == "create":
		// Die gestoppte Container-Referenz: sie ist der Grund, aus dem ein
		// `prune -a` das Rueckfall-Image verschont.
		return "held\n", nil

	case args[0] == "save":
		f.tars[args[2]] = true
		return "", nil

	case args[0] == "load":
		// Aus dem Archiv zurueck in den lokalen Speicher.
		f.restoreFromTar(args[2])
		return "", nil

	case args[0] == "inspect":
		cid := args[len(args)-1]
		svc := strings.TrimPrefix(cid, "cid-")
		c, ok := f.containers[svc]
		if !ok {
			return "", fmt.Errorf("No such object: %s", cid)
		}
		return fmt.Sprintf("sha256:id-%s\t%v\t%d\t%s\n", c.imageRef, c.running, c.restarts, c.health), nil

	case args[0] == "compose":
		return f.compose(args)
	}
	f.t.Fatalf("unerwartetes Kommando: %s", line)
	return "", nil
}

// restoreFromTar bildet ab, was `docker load` WIRKLICH tut (live nachgemessen):
// es bringt den gesicherten TAG zurueck - einen Registry-Digest kann es nicht
// wiederherstellen.
func (f *fakeDocker) restoreFromTar(path string) {
	base := strings.TrimSuffix(filepath.Base(path), ".tar")
	tag := lkgTag(base)
	f.images[tag] = true
}

func (f *fakeDocker) compose(args []string) (string, error) {
	var rest []string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "compose":
		case "--project-directory", "-f":
			i++
		default:
			rest = append(rest, args[i])
		}
	}
	switch rest[0] {
	case "ps":
		svc := rest[len(rest)-1]
		if _, ok := f.containers[svc]; !ok {
			return "", nil
		}
		return "cid-" + svc + "\n", nil
	case "up":
		svc := rest[len(rest)-1]
		// `up -d` ist Stoppen-dann-Starten: der Container wird NEU angelegt,
		// sein Neustart-Zaehler beginnt bei 0 (deshalb ist der absolute Wert
		// des neuen Containers die Zahl der Neustarts SEIT dem Tausch).
		f.containers[svc] = &fakeContainer{imageRef: f.envRef(svc), running: true}
		return "", nil
	}
	f.t.Fatalf("unerwartetes compose-Kommando: %v", rest)
	return "", nil
}

// envRef liest, worauf die .env den Dienst gerade pinnt - genau wie compose es
// taete.
func (f *fakeDocker) envRef(svc string) string {
	key, _ := otaapply.EnvKeyForComponent(svc)
	env, _ := otaapply.ReadEnv(f.envPath)
	if v := env[key]; v != "" {
		return v
	}
	return f.containers[svc].imageRef
}

func (f *fakeDocker) ran(substr string) int {
	n := 0
	for _, l := range f.log {
		if strings.Contains(l, substr) {
			n++
		}
	}
	return n
}

func (f *fakeDocker) indexOf(substr string) int {
	for i, l := range f.log {
		if strings.Contains(l, substr) {
			return i
		}
	}
	return -1
}

// ---------------------------------------------------------------------------
// Der Pruefstand
// ---------------------------------------------------------------------------

type rig struct {
	t       *testing.T
	dataDir string
	deploy  string
	fd      *fakeDocker
	e       *Engine
	now     time.Time
	root    ed25519.PrivateKey
	rel     ed25519.PrivateKey
	roots   *otaverify.KeySet
}

func newRig(t *testing.T) *rig {
	t.Helper()
	r := &rig{t: t, dataDir: t.TempDir(), deploy: t.TempDir(),
		now: time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)}
	r.fd = newFakeDocker(t)
	r.fd.envPath = filepath.Join(r.deploy, ".env")

	rootPub, rootPriv, _ := ed25519.GenerateKey(nil)
	relPub, relPriv, _ := ed25519.GenerateKey(nil)
	r.root, r.rel = rootPriv, relPriv
	r.roots = &otaverify.KeySet{SchemaVersion: otaverify.SignatureSchemaVersion,
		Keys: []otaverify.PublicKey{{KeyID: "root-2026-a", Alg: otaverify.AlgEd25519,
			PublicKey: base64.StdEncoding.EncodeToString(rootPub)}}}

	// Das root-signierte Trust-Set liegt auf der Box (der Widerrufs-Anker
	// reist NIE im Downlink mit).
	ts := r.writeOta(otaapply.FileTrustSet, otaverify.KeySet{
		SchemaVersion: otaverify.SignatureSchemaVersion,
		Keys: []otaverify.PublicKey{{KeyID: "rel-2026-a", Alg: otaverify.AlgEd25519,
			PublicKey: base64.StdEncoding.EncodeToString(relPub)}}})
	r.sign(otaapply.FileTrustSet, rootPriv, otaverify.DomainTrustSet, ts, "root-2026-a")

	r.e = New(Options{
		DataDir: r.dataDir, DeployDir: r.deploy, Runner: r.fd, Roots: r.roots,
		Neutral: mustTable(t, ""), Deadline: 10 * time.Minute,
		DiskGuard: 1 << 20, ForceAutonomous: true,
		AckWait: time.Second, HealthWait: 5 * time.Second,
		Now:       func() time.Time { return r.now },
		FreeBytes: func(string) (uint64, error) { return 8 << 30, nil },
		Token:     func() string { return "tok-1" },
		Log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	r.signalCore(func(*otaapply.CoreSignal) {})
	return r
}

func mustTable(t *testing.T, spec string) *otaapply.NeutralTable {
	t.Helper()
	tab, err := otaapply.ParseNeutralTable(spec)
	if err != nil {
		t.Fatal(err)
	}
	return tab
}

func (r *rig) writeOta(name string, v any) []byte {
	r.t.Helper()
	dir := otaapply.Dir(r.dataDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		r.t.Fatal(err)
	}
	raw, _ := json.MarshalIndent(v, "", "  ")
	raw = append(raw, '\n')
	if err := os.WriteFile(filepath.Join(dir, name), raw, 0o644); err != nil {
		r.t.Fatal(err)
	}
	return raw
}

func (r *rig) sign(name string, key ed25519.PrivateKey, domain string, doc []byte, keyID string) {
	r.t.Helper()
	in, err := otaverify.SigningInput(domain, doc)
	if err != nil {
		r.t.Fatal(err)
	}
	r.writeOta(name+otaapply.SigSuffix, otaverify.Signature{
		SchemaVersion: otaverify.SignatureSchemaVersion, Alg: otaverify.AlgEd25519,
		KeyID: keyID, Domain: domain,
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, in)),
	})
}

// assign legt eine signierte Cloud-Zuweisung ab (die retained Nachricht der
// Stufe 2, byte-gleich wie sie vom Broker kaeme).
func (r *rig) assign(mut func(*otaverify.Manifest)) {
	r.t.Helper()
	m := otaverify.Manifest{
		SchemaVersion: otaverify.ManifestSchemaVersion,
		Release:       "edge-2026.08.0", ReleaseSeq: 12, TargetCommit: "3bf8c038a1b2",
		MinFromSeq: 0, StateSchema: 3,
		Compat:       otaverify.Compat{Backends: []string{otaverify.BackendCompose}},
		SigningKeyID: "rel-2026-a",
		Artifacts: []otaverify.Artifact{
			{Type: otaverify.ArtifactOCIImage, Name: "core", Ref: digest(coreRepo, 'c')},
			{Type: otaverify.ArtifactOCIImage, Name: "nodered", Ref: digest(nrRepo, 'd')},
		},
	}
	if mut != nil {
		mut(&m)
	}
	raw, _ := json.MarshalIndent(m, "", "  ")
	raw = append(raw, '\n')
	in, err := otaverify.SigningInput(otaverify.DomainRelease, raw)
	if err != nil {
		r.t.Fatal(err)
	}
	sig := otaverify.Signature{SchemaVersion: otaverify.SignatureSchemaVersion,
		Alg: otaverify.AlgEd25519, KeyID: "rel-2026-a", Domain: otaverify.DomainRelease,
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(r.rel, in))}
	sigRaw, _ := json.Marshal(sig)

	env := map[string]any{
		"schema_version": "1.0", "type": "update_target",
		"tenant_id": "00000000-0000-0000-0000-000000000001",
		"site_id":   "00000000-0000-0000-0000-000000000002",
		"device_id": "00000000-0000-0000-0000-000000000003",
		"release":   m.Release, "release_seq": m.ReleaseSeq, "channel": "canary",
		"manifest_b64":  base64.StdEncoding.EncodeToString(raw),
		"signature_b64": base64.StdEncoding.EncodeToString(sigRaw),
	}
	envRaw, _ := json.Marshal(env)
	dir := otaapply.Dir(r.dataDir)
	_ = os.MkdirAll(dir, 0o755)
	if err := os.WriteFile(filepath.Join(dir, otaapply.FileTarget), envRaw, 0o644); err != nil {
		r.t.Fatal(err)
	}
}

func (r *rig) signalCore(mut func(*otaapply.CoreSignal)) {
	r.t.Helper()
	s := otaapply.CoreSignal{
		UpdatedAt: r.now.Format(otaapply.TimeFormat), Version: "edge-2026.07.2-665d59b8",
		Healthy: true, CloudConnected: true, InverterFamily: "hybrid_3p",
	}
	mut(&s)
	if err := otaapply.WriteJSON(r.dataDir, otaapply.FileCoreSignal, s); err != nil {
		r.t.Fatal(err)
	}
}

func (r *rig) tick() {
	r.t.Helper()
	if err := r.e.Tick(context.Background()); err != nil {
		r.t.Fatalf("Tick: %v", err)
	}
}

func (r *rig) state() otaapply.UpdaterState {
	r.t.Helper()
	st, err := otaapply.ReadJSON[otaapply.UpdaterState](r.dataDir, otaapply.FileUpdaterState)
	if err != nil {
		r.t.Fatalf("Zustand nicht lesbar: %v", err)
	}
	return *st
}

func (r *rig) pending() *otaapply.PendingConfirm {
	p, _ := otaapply.ReadJSON[otaapply.PendingConfirm](r.dataDir, otaapply.FilePendingConfirm)
	return p
}

// passSelfTest schreibt das Urteil, das sonst der NEUE Kern schreibt.
func (r *rig) selfTest(passed bool, reason string) {
	r.t.Helper()
	p := r.pending()
	if p == nil {
		r.t.Fatal("kein laufender Vorgang")
	}
	if err := otaapply.WriteJSON(r.dataDir, otaapply.FileSelfTest, otaapply.SelfTest{
		Token: p.Token, Release: p.Release, Passed: passed, Reason: reason,
	}); err != nil {
		r.t.Fatal(err)
	}
}

// runToSelfTest treibt den Tausch bis zur Selbsttest-Phase.
func (r *rig) runToSelfTest() {
	r.t.Helper()
	for i := 0; i < 6; i++ {
		r.tick()
		r.now = r.now.Add(5 * time.Second)
		r.signalCore(func(*otaapply.CoreSignal) {})
		if p := r.pending(); p != nil && p.Phase == otaapply.PhaseSelfTest {
			return
		}
	}
	r.t.Fatalf("die Selbsttest-Phase wurde nicht erreicht (Zustand %+v)", r.state())
}

// ---------------------------------------------------------------------------
// Die Tests
// ---------------------------------------------------------------------------

// DIE Vorgabe: ohne Schalter passiert GAR NICHTS am System.
func TestWithAutonomyOffNotASingleDockerCommandRuns(t *testing.T) {
	r := newRig(t)
	r.e.o.ForceAutonomous = false
	r.assign(nil)
	r.tick()

	if len(r.fd.log) != 0 {
		t.Fatalf("ausgeschaltet darf NICHTS am System tun, hat aber: %v", r.fd.log)
	}
	st := r.state()
	if st.State != otaapply.StateIdle || st.Autonomous {
		t.Fatalf("erwartet idle/nicht-autonom, ist %+v", st)
	}
	if r.pending() != nil {
		t.Fatal("es darf keine Brotkrume entstehen")
	}
}

func TestTheHappyPathPullsFirstBreadcrumbsThenSwapsOneComponentAtATime(t *testing.T) {
	r := newRig(t)
	r.assign(nil)

	// Takt 1: holen, pruefen, sichern, Brotkrume - und der Kern wird um den
	// durablen Bericht gebeten.
	r.tick()
	if r.fd.ran("pull") != 2 {
		t.Fatalf("beide Images muessen VOR dem Stoppen geholt werden: %v", r.fd.log)
	}
	if r.fd.ran("compose") > 0 && r.fd.indexOf("up -d") >= 0 {
		t.Fatal("es darf nichts getauscht sein, bevor der Bericht abgesetzt ist")
	}
	p := r.pending()
	if p == nil {
		t.Fatal("die Brotkrume muss VOR dem ersten Tausch liegen")
	}
	if p.Previous.Images["core"].Digest != digest(coreRepo, 'a') {
		t.Fatalf("das Rueckfallziel muss der LAUFENDE Stand sein: %+v", p.Previous)
	}
	// Dreifach gesichert: Tag, gestoppter Container, Archiv.
	if r.fd.ran("tag") != 2 || r.fd.ran("create --name") != 2 || r.fd.ran("save") != 2 {
		t.Fatalf("das Rueckfallziel ist nicht dreifach gesichert: %v", r.fd.log)
	}
	if st := r.state(); !st.NeedApplyingAck {
		t.Fatalf("der durable Bericht muss angefordert sein: %+v", st)
	}

	// Der Kern bestaetigt den durablen Bericht.
	r.now = r.now.Add(3 * time.Second)
	r.signalCore(func(s *otaapply.CoreSignal) {
		s.AckToken = p.Token
		s.ApplyingAckedAt = r.now.Format(otaapply.TimeFormat)
	})

	// Takt 2: GENAU EINE Komponente - der Kern zuerst.
	r.tick()
	if r.fd.ran("up -d") != 1 {
		t.Fatalf("es darf immer nur EINE Komponente zugleich getauscht werden: %v", r.fd.log)
	}
	if r.fd.indexOf("--no-deps core") < 0 {
		t.Fatalf("der Kern muss zuerst getauscht werden: %v", r.fd.log)
	}
	if r.pending().Phase != otaapply.PhaseSwapCore {
		t.Fatalf("Phase: %s", r.pending().Phase)
	}

	// Takt 3: die zweite Komponente.
	r.now = r.now.Add(5 * time.Second)
	r.signalCore(func(*otaapply.CoreSignal) {})
	r.tick()
	if r.fd.indexOf("--no-deps nodered") < 0 {
		t.Fatalf("nodered muss danach folgen: %v", r.fd.log)
	}

	// Takt 4: beide getauscht -> Selbsttest.
	r.now = r.now.Add(5 * time.Second)
	r.signalCore(func(*otaapply.CoreSignal) {})
	r.tick()
	if r.pending().Phase != otaapply.PhaseSelfTest {
		t.Fatalf("erwartet Selbsttest-Phase, ist %s", r.pending().Phase)
	}
	if st := r.state(); st.State != otaapply.StateSelfTest {
		t.Fatalf("Zustand: %+v", st)
	}

	// Der neue Kern urteilt: bestanden.
	r.selfTest(true, "")
	r.now = r.now.Add(5 * time.Second)
	r.signalCore(func(*otaapply.CoreSignal) {})
	r.tick()

	st := r.state()
	if st.State != otaapply.StateSucceeded {
		t.Fatalf("erwartet succeeded, ist %+v", st)
	}
	if r.pending() != nil {
		t.Fatal("die Brotkrume muss nach dem Bestaetigen verschwinden")
	}
	lkg, err := otaapply.ReadJSON[otaapply.LKG](r.dataDir, otaapply.FileLKG)
	if err != nil || lkg.Release != "edge-2026.08.0" {
		t.Fatalf("das Rueckfallziel muss auf den bewiesenen Stand gehoben werden: %+v (%v)", lkg, err)
	}
	// Der Boden wird hier NICHT geschrieben - das ist Sache des Kerns.
	if otaapply.ReadCurrent(r.dataDir) != nil {
		t.Fatal("nur der KERN darf bezeugen, was laeuft (current.json)")
	}
}

// Ein Digest, der nicht stimmt, ist ein SICHERHEITS-Ereignis - und es wurde
// noch nichts gestoppt.
func TestAPulledImageWithTheWrongDigestStopsEverythingBeforeAnySwap(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.fd.pulledWrongDigest[digest(coreRepo, 'c')] = true

	r.tick()

	st := r.state()
	if st.State != otaapply.StateFailed {
		t.Fatalf("erwartet failed, ist %+v", st)
	}
	if !strings.Contains(st.Reason, "verlangten Digest") {
		t.Fatalf("der Grund muss den Digest benennen: %q", st.Reason)
	}
	if r.fd.indexOf("up -d") >= 0 {
		t.Fatalf("es darf NICHTS getauscht worden sein: %v", r.fd.log)
	}
	if r.pending() != nil {
		t.Fatal("ohne geprueftes Image gibt es keinen Vorgang")
	}
}

func TestAFailedSelfTestRevertsToTheLastKnownGood(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.runToSelfTest()

	r.selfTest(false, "Der Steuerpfad hat den Trockenlauf nicht bestanden")
	r.tick()

	st := r.state()
	if st.State != otaapply.StateRolledBack {
		t.Fatalf("erwartet rolled_back, ist %+v", st)
	}
	if !strings.Contains(st.Reason, "Steuerpfad") {
		t.Fatalf("der Grund des Selbsttests muss durchgereicht werden: %q", st.Reason)
	}
	env, _ := otaapply.ReadEnv(filepath.Join(r.deploy, ".env"))
	if env["VP_EDGE_CORE_IMAGE"] != digest(coreRepo, 'a') {
		t.Fatalf("die .env muss auf das Rueckfallziel zeigen: %v", env)
	}
	if r.fd.containers["core"].imageRef != digest(coreRepo, 'a') {
		t.Fatalf("der alte Stand muss wieder laufen: %s", r.fd.containers["core"].imageRef)
	}
	if r.pending() != nil {
		t.Fatal("nach der Ruecknahme gibt es keinen laufenden Vorgang mehr")
	}

	// UND: derselbe Tausch darf nicht sofort wieder beginnen. Ohne diesen
	// Merkzettel drehte die Anlage sich im Kreis (in der Matrix aufgefallen).
	before := len(r.fd.log)
	r.now = r.now.Add(10 * time.Second)
	r.signalCore(func(*otaapply.CoreSignal) {})
	r.tick()
	if r.pending() != nil {
		t.Fatal("das zurueckgerollte Release wurde ERNEUT angewandt - Endlosschleife")
	}
	for _, line := range r.fd.log[before:] {
		if strings.Contains(line, "pull") || strings.Contains(line, "up -d") {
			t.Fatalf("nach einer Ruecknahme darf nichts Neues geschehen: %s", line)
		}
	}
	if st := r.state(); st.State != otaapply.StateRolledBack ||
		!strings.Contains(st.Reason, "bereits") {
		t.Fatalf("der Halt muss benannt bleiben: %+v", st)
	}
}

// Der Fall, fuer den das Archiv existiert: der Betreiber hat waehrend des
// Tausches `docker system prune -a` gefahren.
func TestARevertSurvivesAPruneThatEvictedTheFallbackImage(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.runToSelfTest()

	// `prune -a`: alles weg, was kein Container haelt.
	delete(r.fd.images, digest(coreRepo, 'a'))
	delete(r.fd.images, digest(nrRepo, 'b'))
	delete(r.fd.images, lkgTag("core"))
	delete(r.fd.images, lkgTag("nodered"))

	r.selfTest(false, "kaputt")
	r.tick()

	if r.fd.ran("load -i") != 2 {
		t.Fatalf("das Archiv muss geladen werden, wenn das Image weg ist: %v", r.fd.log)
	}
	// Ein Archiv kann keinen Registry-Digest zurueckbringen - gepinnt wird dann
	// der lokale `:lkg`-Tag, und der Grund sagt das (live nachgemessen).
	env, _ := otaapply.ReadEnv(filepath.Join(r.deploy, ".env"))
	if env["VP_EDGE_CORE_IMAGE"] != lkgTag("core") {
		t.Fatalf("nach dem Laden aus dem Archiv muss auf den lokalen Tag gepinnt werden: %v", env)
	}
	if !strings.Contains(r.state().Reason, "lokalen Archiv") {
		t.Fatalf("der Rueckfall aus dem Archiv muss benannt werden: %q", r.state().Reason)
	}
	st := r.state()
	if st.State != otaapply.StateRolledBack {
		t.Fatalf("erwartet rolled_back, ist %+v", st)
	}
	if strings.Contains(st.Reason, "nicht vollstaendig") {
		t.Fatalf("die Ruecknahme haette gelingen muessen: %q", st.Reason)
	}
	// Der ALTE Stand laeuft wieder - jetzt eben unter dem lokalen Tag, weil
	// der Digest nach einem `prune -a` nicht wiederherstellbar ist.
	if r.fd.containers["core"].imageRef != lkgTag("core") {
		t.Fatalf("der alte Stand muss wieder laufen: %s", r.fd.containers["core"].imageRef)
	}
}

func TestTheWatchdogRevertsWhenNoVerdictArrivesInTime(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.runToSelfTest()

	// Kein Urteil, dafuer die abgelaufene Frist.
	r.now = r.now.Add(20 * time.Minute)
	r.signalCore(func(*otaapply.CoreSignal) {})
	r.tick()

	st := r.state()
	if st.State != otaapply.StateRolledBack || !strings.Contains(st.Reason, "Frist") {
		t.Fatalf("erwartet Ruecknahme wegen Frist, ist %+v", st)
	}
}

func TestACrashLoopRevertsWithoutWaitingForTheDeadline(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.runToSelfTest()

	r.fd.containers["core"].restarts = otaapply.CrashLoopRestarts
	r.now = r.now.Add(10 * time.Second) // die Frist laeuft noch lange
	r.signalCore(func(*otaapply.CoreSignal) {})
	r.tick()

	st := r.state()
	if st.State != otaapply.StateRolledBack || !strings.Contains(st.Reason, "neu gestartet") {
		t.Fatalf("erwartet sofortige Ruecknahme wegen Flatterns, ist %+v", st)
	}
}

func TestTheInterlockDefersWhileASetpointIsDispatchingAndTouchesNothing(t *testing.T) {
	r := newRig(t)
	r.e.o.Neutral = mustTable(t, "hybrid_3p:120")
	r.assign(nil)
	r.signalCore(func(s *otaapply.CoreSignal) {
		s.ControlActive = true
		s.Dispatching = true
		s.SetpointKw = -7.1
	})

	r.tick()

	if len(r.fd.log) != 0 {
		t.Fatalf("mitten im Sollwert darf nichts geschehen: %v", r.fd.log)
	}
	st := r.state()
	if st.State != otaapply.StateDeferred || !strings.Contains(st.Reason, "Zeitfensters") {
		t.Fatalf("erwartet Verschiebung mit Grund, ist %+v", st)
	}
}

func TestAnUrgentReleaseAsksTheCoreForANeutralWindowInsteadOfDeferringForever(t *testing.T) {
	r := newRig(t)
	r.e.o.Neutral = mustTable(t, "hybrid_3p:120")
	r.assign(func(m *otaverify.Manifest) { m.Urgent = true })
	r.signalCore(func(s *otaapply.CoreSignal) {
		s.ControlActive = true
		s.Dispatching = true
	})

	r.tick()
	st := r.state()
	if !st.NeedNeutral {
		t.Fatalf("der Eil-Pfad muss den Kern um die Neutralstellung bitten: %+v", st)
	}
	if len(r.fd.log) != 0 {
		t.Fatalf("vor der bestaetigten Neutralstellung darf nichts geschehen: %v", r.fd.log)
	}

	// Der Kern meldet die Anlage bestaetigt neutral.
	r.now = r.now.Add(30 * time.Second)
	r.signalCore(func(s *otaapply.CoreSignal) {
		s.ControlActive = true
		s.Dispatching = true
		s.NeutralHeldSince = r.now.Add(-25 * time.Second).Format(otaapply.TimeFormat)
	})
	r.tick()
	if r.fd.ran("pull") != 2 {
		t.Fatalf("nach der Neutralstellung muss getauscht werden: %v", r.fd.log)
	}
}

func TestAControllingPlantWithAnUnverifiedNeutralTimeoutIsRefused(t *testing.T) {
	r := newRig(t) // leere Tabelle = nichts verifiziert
	r.assign(nil)
	r.signalCore(func(s *otaapply.CoreSignal) { s.ControlActive = true })

	r.tick()

	if len(r.fd.log) != 0 {
		t.Fatalf("ohne belegtes T darf nichts geschehen: %v", r.fd.log)
	}
	st := r.state()
	if !strings.Contains(st.Reason, "hybrid_3p") {
		t.Fatalf("der Grund muss die Familie benennen: %q", st.Reason)
	}
}

func TestTheDiskGuardRefusesBeforeAnythingIsPulled(t *testing.T) {
	r := newRig(t)
	r.e.o.DiskGuard = 4 << 30
	r.e.o.FreeBytes = func(string) (uint64, error) { return 100 << 20, nil }
	r.assign(nil)

	r.tick()

	if len(r.fd.log) != 0 {
		t.Fatalf("ohne Platz wird nicht einmal geholt: %v", r.fd.log)
	}
	if st := r.state(); !strings.Contains(st.Reason, "Speicherplatz") {
		t.Fatalf("Grund: %q", st.Reason)
	}
}

// Einzelschreiber-Semantik: ein Neustart MITTEN im Tausch fuehrt den Vorgang zu
// Ende, statt etwas Neues zu beginnen.
func TestARestartMidSwapResumesTheRunInsteadOfStartingOver(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.tick() // Brotkrume liegt, nichts getauscht
	before := r.pending()
	if before == nil {
		t.Fatal("Brotkrume fehlt")
	}

	// Neuer Prozess, alles vergessen ausser der Platte.
	fresh := New(Options{
		DataDir: r.dataDir, DeployDir: r.deploy, Runner: r.fd, Roots: r.roots,
		Neutral: mustTable(t, ""), Deadline: 10 * time.Minute, DiskGuard: 1 << 20,
		ForceAutonomous: true, AckWait: time.Millisecond, HealthWait: 5 * time.Second,
		Now:       func() time.Time { return r.now },
		FreeBytes: func(string) (uint64, error) { return 8 << 30, nil },
		Token:     func() string { return "tok-2" },
		Log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	r.now = r.now.Add(5 * time.Second)
	r.signalCore(func(*otaapply.CoreSignal) {})
	if err := fresh.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}

	after := r.pending()
	if after == nil || after.Token != before.Token {
		t.Fatalf("der LAUFENDE Vorgang muss weitergefuehrt werden (%v -> %v)", before, after)
	}
	if r.fd.ran("pull") != 2 {
		t.Fatalf("es darf kein zweiter Vorgang beginnen: %v", r.fd.log)
	}
}

// Ein Rueckfallziel, das nicht sicherbar ist, verhindert den Tausch - statt
// ihn ohne Rueckfallebene zu wagen.
func TestWithoutASecuredFallbackNothingIsSwapped(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.fd.failOn["save"] = "no space left on device"

	r.tick()

	st := r.state()
	if st.State != otaapply.StateDeferred || !strings.Contains(st.Reason, "Rueckfallziel") {
		t.Fatalf("erwartet Verschiebung wegen ungesichertem Rueckfallziel, ist %+v", st)
	}
	if r.fd.indexOf("up -d") >= 0 {
		t.Fatalf("es darf nichts getauscht worden sein: %v", r.fd.log)
	}
	if r.pending() != nil {
		t.Fatal("ohne Rueckfallziel entsteht kein Vorgang")
	}
}

// Ein haengender/abgewiesener Pull ist harmlos: es wurde noch nichts gestoppt,
// und der naechste Takt versucht es erneut.
func TestAFailedPullDefersAndLeavesTheRunningStackAlone(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.fd.failOn["pull"] = "dial tcp: i/o timeout"

	r.tick()

	st := r.state()
	if st.State != otaapply.StateDeferred || !strings.Contains(st.Reason, "nicht geladen werden") {
		t.Fatalf("erwartet Verschiebung, ist %+v", st)
	}
	if r.pending() != nil {
		t.Fatal("ein gescheiterter Pull hinterlaesst keinen Vorgang")
	}
	if r.fd.containers["core"].imageRef != digest(coreRepo, 'a') {
		t.Fatal("der laufende Stand bleibt unangetastet")
	}
}

// Nur die GEAENDERTE Komponente wird getauscht - wer eine unveraenderte
// mittauscht, nimmt ihre Failsafe-Kopie fuer nichts vom Netz.
func TestAnUnchangedComponentIsNeverSwapped(t *testing.T) {
	r := newRig(t)
	r.assign(func(m *otaverify.Manifest) {
		// nodered bleibt, wie es ist.
		m.Artifacts[1].Ref = digest(nrRepo, 'b')
	})
	r.runToSelfTest()

	if r.fd.indexOf("--no-deps nodered") >= 0 {
		t.Fatalf("nodered hat sich nicht geaendert und darf nicht getauscht werden: %v", r.fd.log)
	}
	if r.fd.indexOf("--no-deps core") < 0 {
		t.Fatalf("der Kern haette getauscht werden muessen: %v", r.fd.log)
	}
}

// REGRESSION (in der Matrix aufgefallen, nicht im Unit-Test): der Motor gab
// die Wurzel ungeprueft weiter, und ohne gesetzte Test-Naht war sie nil - der
// Verifizierer lehnte dann JEDES Release mit „kein Vertrauensanker
// eingebacken" ab. Fail-closed ist die richtige Richtung, aber es war die
// falsche Begruendung: das ausgelieferte Geraet haette nie aktualisiert und
// dabei ueber den Grund die Unwahrheit gesagt.
func TestWithoutAnInjectedRootTheBakedAnchorIsUsed(t *testing.T) {
	e := New(Options{DataDir: t.TempDir(), DeployDir: t.TempDir(),
		Runner: newFakeDocker(t), Neutral: mustTable(t, ""),
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if e.o.Roots == nil {
		t.Fatal("ohne Test-Naht muss die EINGEBACKENE Wurzel geladen werden")
	}
	// Seit der Zeremonie (04.08.2026) traegt das Image die kalte Wurzel; der
	// Sidecar muss GENAU SIE laden - byteweise festgenagelt ist sie beim
	// Eigentuemer der Datei (otaverify.TestBakedRootIsExactlyTheCeremonyRoot).
	if len(e.o.Roots.Keys) != 1 || e.o.Roots.Keys[0].KeyID != "root-2026-a" {
		t.Fatalf("der Sidecar laedt nicht die eingebackene Zeremonie-Wurzel: %+v", e.o.Roots.Keys)
	}
}

// Und die Kehrseite: mit leerer Wurzel wird ein sonst einwandfreies Release
// ABGELEHNT - nie stillschweigend angewandt.
func TestAnEmptyTrustAnchorRefusesEveryRelease(t *testing.T) {
	r := newRig(t)
	r.e.o.Roots = &otaverify.KeySet{SchemaVersion: otaverify.SignatureSchemaVersion}
	r.assign(nil)
	r.tick()
	if st := r.state(); st.State != otaapply.StateFailed ||
		!strings.Contains(st.Reason, "Vertrauensanker") {
		t.Fatalf("erwartet fail-closed mit benanntem Grund, ist %+v", st)
	}
	if len(r.fd.log) != 0 {
		t.Fatalf("ohne Wurzel darf nichts geschehen: %v", r.fd.log)
	}
}

// REGRESSION (in der Matrix aufgefallen): `docker compose -f <datei>` loest den
// Dateinamen gegen das ARBEITSVERZEICHNIS auf, nicht gegen
// --project-directory. Im Sidecar-Container ist das `/`, also scheiterte jeder
// compose-Aufruf an `/docker-compose.yml`.
func TestComposeFilesAreResolvedAgainstTheDeployDirectory(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.tick()

	var seen bool
	for _, line := range r.fd.log {
		if !strings.Contains(line, "compose") {
			continue
		}
		seen = true
		if !strings.Contains(line, "-f "+filepath.Join(r.deploy, "docker-compose.yml")) {
			t.Fatalf("die Compose-Datei muss absolut adressiert werden: %s", line)
		}
	}
	if !seen {
		t.Fatal("es wurde kein compose-Aufruf beobachtet")
	}
}
