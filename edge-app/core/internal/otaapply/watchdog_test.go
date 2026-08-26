package otaapply

// Der Wachhund, die Wiederaufnahme, die Sequenz - und die Tabelle der

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func pending(mut func(*PendingConfirm)) *PendingConfirm {
	p := NewPending(PendingSpec{
		Token: "tok", Release: "edge-2026.08.0", ReleaseSeq: 12,
		Target:   map[string]string{"core": "repo/core@sha256:aa", "nodered": "repo/nr@sha256:bb"},
		Previous: LKG{Release: "edge-2026.07.2"},
		Deadline: 10 * time.Minute,
	}, testNow)
	p.Phase = PhaseSelfTest
	if mut != nil {
		mut(&p)
	}
	return &p
}

func TestACrashLoopRevertsImmediatelyWithoutWaitingForTheDeadline(t *testing.T) {
	in := ResumeInput{
		Pending: pending(nil),
		Health: []ComponentHealth{
			{Component: "core", Running: true, Restarts: CrashLoopRestarts},
		},
		// Die Frist ist noch LANGE nicht abgelaufen - genau darum geht es:
		// eine Steuerung soll nicht Minuten warten, wenn nach Sekunden alles
		// gesagt ist.
		Now: testNow.Add(20 * time.Second),
	}
	a, reason := Resume(in)
	if a != ResumeRevert {
		t.Fatalf("Flattern muss sofort zuruecknehmen, ist %v", a)
	}
	if !strings.Contains(reason, "neu gestartet") {
		t.Fatalf("Grund unklar: %q", reason)
	}
}

func TestAPassedSelfTestCommitsAndAFailedOneReverts(t *testing.T) {
	p := pending(nil)
	in := ResumeInput{Pending: p, Now: testNow.Add(time.Minute),
		SelfTest: &SelfTest{Token: p.Token, Passed: true}}
	if a, _ := Resume(in); a != ResumeCommit {
		t.Fatalf("bestandener Selbsttest muss bestaetigen, ist %v", a)
	}

	in.SelfTest = &SelfTest{Token: p.Token, Passed: false, Reason: "Steuerpfad kaputt"}
	a, reason := Resume(in)
	if a != ResumeRevert || !strings.Contains(reason, "Steuerpfad kaputt") {
		t.Fatalf("fehlgeschlagener Selbsttest muss zuruecknehmen (%v, %q)", a, reason)
	}
}

// Ein Urteil zu einem ANDEREN Vorgang darf diesen nie beantworten - sonst
// koennte ein liegengebliebenes altes „bestanden" einen neuen Tausch segnen.
func TestASelfTestOfAnotherRunIsIgnored(t *testing.T) {
	p := pending(nil)
	in := ResumeInput{Pending: p, Now: testNow.Add(time.Minute),
		SelfTest: &SelfTest{Token: "ein-anderer", Passed: true}}
	if a, _ := Resume(in); a != ResumeContinue {
		t.Fatalf("fremdes Urteil darf nicht bestaetigen, ist %v", a)
	}
}

func TestTheDeadlineReverts(t *testing.T) {
	p := pending(nil)
	in := ResumeInput{Pending: p, Now: testNow.Add(11 * time.Minute)}
	a, reason := Resume(in)
	if a != ResumeRevert || !strings.Contains(reason, "Frist") {
		t.Fatalf("abgelaufene Frist muss zuruecknehmen (%v, %q)", a, reason)
	}

	// Eine UNLESBARE Frist ist kein Freibrief.
	p = pending(func(p *PendingConfirm) { p.DeadlineAt = "irgendwann" })
	if a, _ := Resume(ResumeInput{Pending: p, Now: testNow}); a != ResumeRevert {
		t.Fatalf("unlesbare Frist muss zuruecknehmen, ist %v", a)
	}
}

func TestAContainerThatDoesNotRunAfterTheGraceIsAFinding(t *testing.T) {
	p := pending(nil)
	// Innerhalb der Anlaufzeit ist „laeuft nicht" KEIN Befund.
	in := ResumeInput{Pending: p, Now: testNow.Add(10 * time.Second),
		Health: []ComponentHealth{{Component: "core", Running: false}}}
	if a, _ := Resume(in); a != ResumeContinue {
		t.Fatalf("waehrend der Anlaufzeit darf nichts zurueckgenommen werden, ist %v", a)
	}
	// Danach schon.
	in.Now = testNow.Add(StartGrace + time.Second)
	a, reason := Resume(in)
	if a != ResumeRevert || !strings.Contains(reason, "laeuft nach dem Tausch nicht") {
		t.Fatalf("erwartet Ruecknahme (%v, %q)", a, reason)
	}
}

func TestAnUnhealthyContainerRevertsButAMissingHealthcheckIsNoFinding(t *testing.T) {
	p := pending(nil)
	no := false
	in := ResumeInput{Pending: p, Now: testNow.Add(StartGrace + time.Second),
		Health: []ComponentHealth{{Component: "nodered", Running: true, Healthy: &no}}}
	if a, _ := Resume(in); a != ResumeRevert {
		t.Fatalf("unhealthy muss zuruecknehmen, ist %v", a)
	}
	// Healthy == nil heisst „kein Healthcheck" und ist KEINE Aussage.
	in.Health = []ComponentHealth{{Component: "nodered", Running: true}}
	if a, _ := Resume(in); a != ResumeContinue {
		t.Fatalf("ohne Healthcheck darf nichts behauptet werden, ist %v", a)
	}
}

// DIE Sequenz-Zusage: nie beide Failsafe-Kopien gleichzeitig weg.
func TestOnlyChangedComponentsSwapAndAlwaysCoreFirst(t *testing.T) {
	cur := map[string]string{"core": "repo/core@sha256:old", "nodered": "repo/nr@sha256:same"}
	tgt := map[string]string{"core": "repo/core@sha256:new", "nodered": "repo/nr@sha256:same"}
	if got := ChangedComponents(cur, tgt); !reflect.DeepEqual(got, []string{"core"}) {
		t.Fatalf("nur der Kern hat sich geaendert, erwartet [core], ist %v", got)
	}

	tgt["nodered"] = "repo/nr@sha256:new"
	got := ChangedComponents(cur, tgt)
	if !reflect.DeepEqual(got, []string{"core", "nodered"}) {
		t.Fatalf("Reihenfolge muss core vor nodered sein, ist %v", got)
	}

	if got := ChangedComponents(tgt, tgt); len(got) != 0 {
		t.Fatalf("ohne Unterschied wird nichts getauscht, ist %v", got)
	}

	// Ein kuenftiger dritter Artefakt-Name faellt hinten an, statt still zu
	// verschwinden.
	tgt2 := map[string]string{"core": "repo/core@sha256:new", "etwas-neues": "repo/x@sha256:z"}
	got = ChangedComponents(cur, tgt2)
	if len(got) != 2 || got[0] != "core" || got[1] != "etwas-neues" {
		t.Fatalf("unbekannte Komponente muss mitgenommen werden, ist %v", got)
	}
}
