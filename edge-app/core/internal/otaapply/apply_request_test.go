package otaapply

import (
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

// Die EINMALIGE Freigabe am Geraet (OTA Stufe 4 „Jetzt anwenden").
//
// Was diese Tests schuetzen, ist die eine Zusage, die den Knopf rechtfertigt:
// er oeffnet AUSSCHLIESSLICH das erste Tor, fuer GENAU EINEN Vorgang und GENAU
// EIN Release - jede andere Regel gilt unveraendert.

func manualInput(req *ApplyRequest, done string) DecisionInput {
	in := baseInput()
	in.Autonomous = false
	in.Request = req
	in.AppliedRequestToken = done
	return in
}

// Die Uhr dieser Suite ist testNow (decide_test.go) - eine Freigabe „jetzt"
// muss dazu passen, sonst laeuft sie sofort ab.
func freshRequest(release string, now time.Time) *ApplyRequest {
	return &ApplyRequest{
		Token:       "tok-1",
		Release:     release,
		RequestedAt: now.Format(TimeFormat),
	}
}

func TestAManualApprovalOpensTheFirstGateOnlyForOneRun(t *testing.T) {
	now := testNow
	in := manualInput(freshRequest("edge-2026.08.0", now), "")
	if got := Decide(in); got.Action != ActionApply {
		t.Fatalf("eine gueltige Freigabe muss anwenden lassen: %+v", got)
	}
	// Der Grund sagt, dass es eine FREIGABE war - nicht „autonom".
	if r := Decide(in).Reason; !strings.Contains(r, "freigegeben") {
		t.Errorf("Grund nennt die Freigabe nicht: %q", r)
	}

	// Und derselbe Token ein zweites Mal bewirkt NICHTS - sonst waere das die
	// Tausch-Schleife, gegen die es auch failed.json gibt.
	again := manualInput(freshRequest("edge-2026.08.0", now), "tok-1")
	if got := Decide(again); got.Action != ActionIdle {
		t.Fatalf("eine bereits ausgefuehrte Freigabe darf nicht erneut wirken: %+v", got)
	}
}

// Eine Zustimmung gilt fuer das, was auf dem Schirm stand.
func TestAnApprovalDoesNotCoverAReleaseThatArrivedAfterwards(t *testing.T) {
	in := manualInput(freshRequest("edge-2026.07.2", testNow), "")
	got := Decide(in) // das zugewiesene Manifest ist edge-2026.08.0
	if got.Action == ActionApply {
		t.Fatal("die Freigabe galt einem ANDEREN Release - es darf nichts angewandt werden")
	}
	if !strings.Contains(got.Reason, "edge-2026.07.2") ||
		!strings.Contains(got.Reason, "edge-2026.08.0") {
		t.Errorf("der Grund muss BEIDE Staende benennen: %q", got.Reason)
	}
}

// Eine vergessene Freigabe darf nicht Tage spaeter zuschlagen.
func TestAnExpiredApprovalDoesNothing(t *testing.T) {
	alt := freshRequest("edge-2026.08.0", testNow.Add(-2*ApplyRequestWindow))
	if got := Decide(manualInput(alt, "")); got.Action != ActionIdle {
		t.Fatalf("eine abgelaufene Freigabe hat gewirkt: %+v", got)
	}
	// Ein unlesbarer Stempel gilt ebenfalls nicht - im Zweifel nichts anwenden.
	kaputt := &ApplyRequest{Token: "t", Release: "edge-2026.08.0", RequestedAt: "gestern"}
	if kaputt.Fresh(testNow) {
		t.Fatal("ein unlesbarer Stempel darf nicht als frisch gelten")
	}
	if (&ApplyRequest{}).Fresh(testNow) {
		t.Fatal("eine Freigabe ohne Token ist keine")
	}
}

// DIE Zusage: die Freigabe ueberspringt KEINEN anderen Pruefschritt. Wenn ein
// spaeteres Tor schliesst, ist das Ergebnis dasselbe wie im autonomen Fall.
func TestAnApprovalNeverSkipsAnyLaterGate(t *testing.T) {
	now := testNow
	cases := []struct {
		name   string
		mutate func(*DecisionInput)
	}{
		{"gebrochene Kette", func(in *DecisionInput) {
			in.Verdict = otaverify.Verdict{Outcome: otaverify.OutcomeRejected,
				Reason: "Signatur passt nicht zu den Bytes."}
		}},
		{"bereits zurueckgenommen", func(in *DecisionInput) {
			in.Failed = &FailedRelease{Release: "edge-2026.08.0", Reason: "Selbsttest"}
		}},
		{"zu wenig Platz", func(in *DecisionInput) {
			in.FreeBytes = 1
			in.RequiredBytes = DefaultDiskGuardBytes
		}},
		{"Kern meldet sich nicht", func(in *DecisionInput) {
			in.Signal = nil
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			auto := baseInput()
			c.mutate(&auto)
			manual := manualInput(freshRequest("edge-2026.08.0", now), "")
			c.mutate(&manual)

			a, m := Decide(auto), Decide(manual)
			if m.Action == ActionApply {
				t.Fatalf("die Freigabe hat ein spaeteres Tor uebersprungen: %+v", m)
			}
			if a.Action != m.Action || a.State != m.State {
				t.Fatalf("freigegeben und autonom muessen hier gleich urteilen: %+v vs %+v", a, m)
			}
		})
	}
}

// Ohne Freigabe UND ohne Schalter passiert weiterhin gar nichts.
func TestWithoutApprovalAndWithoutTheSwitchNothingHappens(t *testing.T) {
	if got := Decide(manualInput(nil, "")); got.Action != ActionIdle || got.Reason != "" {
		t.Fatalf("ausgeschaltet ist kein Befund ueber ein Release: %+v", got)
	}
}
