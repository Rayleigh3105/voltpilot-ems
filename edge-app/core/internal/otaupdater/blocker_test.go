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

// TestTheNeutralTimeRefusalIsNamedOnceAndNotEveryTick ist der Soak-Fall
// woertlich: eine steuernde Anlage ohne belegtes T.
func TestTheNeutralTimeRefusalIsNamedOnceAndNotEveryTick(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.signalCore(func(s *otaapply.CoreSignal) { s.ControlActive = true })

	r.tick()

	st := r.state()
	if st.Blocker != otaapply.BlockerNeutralTime {
		t.Fatalf("Blocker soll %q sein, ist %q (Grund: %q)",
			otaapply.BlockerNeutralTime, st.Blocker, st.Reason)
	}
	// Der Grund muss den HEBEL nennen, sonst ist er eine Sackgasse.
	for _, want := range []string{"steuert", "hybrid_3p", "VP_OTA_NEUTRAL_VERIFIED"} {
		if !strings.Contains(st.Reason, want) {
			t.Fatalf("der Grund nennt %q nicht: %q", want, st.Reason)
		}
	}
	if !st.Blocked() {
		t.Fatal("ein gesetzter Blocker muss als Sperre gelten")
	}
	if got := st.BlockedReason(); !strings.HasPrefix(got, otaapply.BlockedPrefix) {
		t.Fatalf("der Satz fuer die Oberflaeche traegt das Praefix nicht: %q", got)
	}
	// Es wurde NICHTS getauscht - die Sichtbarkeit aendert an der Sperre nichts.
	if len(r.fd.log) != 0 {
		t.Fatalf("eine Sperre darf kein docker-Kommando ausloesen, es liefen: %v", r.fd.log)
	}

	blocked, cleared := blockedLines(t, r)
	if blocked != 1 || cleared != 0 {
		t.Fatalf("die erste Sperre soll GENAU EINMAL genannt werden, gezaehlt %d/%d",
			blocked, cleared)
	}
	if !strings.Contains(r.logs.String(), otaapply.BlockerNeutralTime) {
		t.Fatalf("das Protokoll traegt den Blocker-Namen nicht: %s", r.logs.String())
	}

	// Vier weitere Durchlaeufe an derselben Sperre: kein einziges Wort mehr.
	for i := 0; i < 4; i++ {
		r.now = r.now.Add(5 * 1e9)
		r.signalCore(func(s *otaapply.CoreSignal) { s.ControlActive = true })
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
	r.assign(nil)
	r.signalCore(func(s *otaapply.CoreSignal) { s.ControlActive = true })
	r.tick()

	// Jetzt meldet sich der Kern nicht mehr - ein ANDERES Tor.
	r.now = r.now.Add(10 * 60 * 1e9)
	r.tick()
	if st := r.state(); st.Blocker != otaapply.BlockerCoreSilent {
		t.Fatalf("Blocker soll %q sein, ist %q", otaapply.BlockerCoreSilent, st.Blocker)
	}
	if blocked, _ := blockedLines(t, r); blocked != 2 {
		t.Fatalf("eine ANDERE Sperre ist eine neue Aussage, gezaehlt %d", blocked)
	}

	// Und nun faellt jede Sperre: der Kern meldet sich wieder und steuert nicht.
	r.signalCore(func(*otaapply.CoreSignal) {})
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
