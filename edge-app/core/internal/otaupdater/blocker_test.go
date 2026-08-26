package otaupdater

// Die SICHTBARKEIT einer Verweigerung.
//
// Der Canary-Soak vom 04.08.2026 hat den blinden Fleck belegt: Autonomie an,
// ein geprueftes Release zugewiesen, die Anlage steuert - und der Sidecar
// verweigerte VOLLKOMMEN STILL. Im Protokoll standen nur die Startzeilen, im
// Herzschlag der freundliche Satz des Verifizierers. Ein Betreiber sah
// „wartet" und hatte keine Moeglichkeit zu erfahren, worauf.
//
// Die Tests hier nageln beide Haelften fest: dass die Sperre GENANNT wird -
// und dass sie bei einem 5-s-Takt nicht in ihrer eigenen Wiederholung
// untergeht.

import (
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
)

// blockedLines zaehlt die WARN-Zeilen der Sperre bzw. die Aufhebungen.
func blockedLines(t *testing.T, r *rig) (blocked, cleared int) {
	t.Helper()
	for _, line := range strings.Split(r.logs.String(), "\n") {
		switch {
		case strings.Contains(line, "autonomes Anwenden blockiert"):
			blocked++
		case strings.Contains(line, "Sperre aufgehoben"):
			cleared++
		}
	}
	return
}

// TestADiskRefusalIsNamedOnceAndNotEveryTick ist der Soak-Fall in seiner
// heutigen Form: die Sperre, die eine Box wirklich noch aufhalten kann.
//
// (Bis zum 26.08.2026 stand hier die Neutral-Zeit-Sperre. Sie ist mit allen
// anderen Geraete-Zustands-Toren entfallen; die SICHTBARKEITS-Regel, die der
// Canary-Soak erzwungen hat, gilt unveraendert fuer die verbliebenen.)
func TestADiskRefusalIsNamedOnceAndNotEveryTick(t *testing.T) {
	r := newRig(t)
	r.e.o.DiskGuard = 4 << 30
	r.e.o.FreeBytes = func(string) (uint64, error) { return 100 << 20, nil }
	r.assign(nil)
	r.tick()

	st := r.state()
	if st.Blocker != otaapply.BlockerDisk {
		t.Fatalf("Blocker soll %q sein, ist %q (Grund: %q)",
			otaapply.BlockerDisk, st.Blocker, st.Reason)
	}
	// Der Grund muss sagen, dass schon aufgeraeumt wurde - sonst liest er sich
	// als „raeum doch mal auf", obwohl der Sidecar genau das getan hat.
	if !strings.Contains(st.Reason, "bereits entfernt") {
		t.Fatalf("der Grund nennt das Aufraeumen nicht: %q", st.Reason)
	}
	if !st.Blocked() {
		t.Fatal("ein gesetzter Blocker muss als Sperre gelten")
	}
	if got := st.BlockedReason(); !strings.HasPrefix(got, otaapply.BlockedPrefix) {
		t.Fatalf("der Satz fuer die Oberflaeche traegt das Praefix nicht: %q", got)
	}
	// Es wurde NICHTS GEHOLT und nichts getauscht - die Sichtbarkeit aendert an
	// der Sperre nichts.
	for _, cmd := range r.fd.log {
		if strings.Contains(cmd, " pull ") || strings.Contains(cmd, "compose") {
			t.Fatalf("eine Sperre darf weder holen noch tauschen, es lief: %q", cmd)
		}
	}

	blocked, cleared := blockedLines(t, r)
	if blocked != 1 || cleared != 0 {
		t.Fatalf("die erste Sperre soll GENAU EINMAL genannt werden, gezaehlt %d/%d",
			blocked, cleared)
	}
	if !strings.Contains(r.logs.String(), otaapply.BlockerDisk) {
		t.Fatalf("das Protokoll traegt den Blocker-Namen nicht: %s", r.logs.String())
	}

	// Vier weitere Durchlaeufe an derselben Sperre: kein einziges Wort mehr.
	for i := 0; i < 4; i++ {
		r.now = r.now.Add(5 * 1e9)
		r.tick()
	}
	if blocked, _ = blockedLines(t, r); blocked != 1 {
		t.Fatalf("dieselbe Sperre darf nicht je Takt protokolliert werden, gezaehlt %d", blocked)
	}
}

// TestAChangedBlockerIsNamedAgainAndALiftedOneIsToo - eine ANDERE Sperre ist
// eine neue Aussage, und „es geht wieder weiter" ist die Nachricht, auf die
// ein Betreiber wartet.
func TestAChangedBlockerIsNamedAgainAndALiftedOneIsToo(t *testing.T) {
	r := newRig(t)
	r.e.o.DiskGuard = 4 << 30
	r.e.o.FreeBytes = func(string) (uint64, error) { return 100 << 20, nil }
	r.assign(nil)
	r.tick()

	// Jetzt kennt das Release unseren Datenstand nicht - ein ANDERES Tor.
	r.writeOta(otaapply.FileCurrent, map[string]any{
		"release": "edge-2026.07.9", "release_seq": 11, "state_schema": 9})
	r.now = r.now.Add(5 * 1e9)
	r.tick()
	if st := r.state(); st.Blocker != otaapply.BlockerStateSchema {
		t.Fatalf("Blocker soll %q sein, ist %q", otaapply.BlockerStateSchema, st.Blocker)
	}
	if blocked, _ := blockedLines(t, r); blocked != 2 {
		t.Fatalf("eine ANDERE Sperre ist eine neue Aussage, gezaehlt %d", blocked)
	}

	// Und nun faellt jede Sperre: Datenstand passt wieder, Platz ist da.
	r.writeOta(otaapply.FileCurrent, map[string]any{
		"release": "edge-2026.07.9", "release_seq": 11, "state_schema": 3})
	r.e.o.FreeBytes = func(string) (uint64, error) { return 8 << 30, nil }
	r.now = r.now.Add(5 * 1e9)
	r.tick()
	if st := r.state(); st.Blocker != "" {
		t.Fatalf("ohne Sperre darf kein Blocker stehen bleiben: %q", st.Blocker)
	}
	if _, cleared := blockedLines(t, r); cleared != 1 {
		t.Fatalf("die Aufhebung soll GENAU EINMAL genannt werden, gezaehlt %d", cleared)
	}
}

// TestAnUnblockedTickReportsNoBlockerAtAll - alles hier ist ADDITIV: eine Box,
// die nicht blockiert ist, traegt das Feld gar nicht (omitempty), und wer nur
// den Zustand liest, sieht dasselbe wie vorher.
func TestAnUnblockedTickReportsNoBlockerAtAll(t *testing.T) {
	r := newRig(t)
	r.tick() // keine Zuweisung -> idle
	if st := r.state(); st.Blocker != "" || st.Blocked() {
		t.Fatalf("ohne Zuweisung gibt es keine Sperre, gemeldet wurde %q", st.Blocker)
	}
	if st := r.state(); st.BlockedReason() != "" {
		t.Fatalf("ohne Sperre gibt es keinen Sperr-Satz: %q", st.BlockedReason())
	}
	if blocked, cleared := blockedLines(t, r); blocked != 0 || cleared != 0 {
		t.Fatalf("ein ruhiger Durchlauf protokolliert nichts, gezaehlt %d/%d", blocked, cleared)
	}
}
