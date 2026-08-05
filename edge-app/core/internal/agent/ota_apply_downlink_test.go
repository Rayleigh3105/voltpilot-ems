package agent

// Portal-Apply, Geraete-Seite: die EINMALIGE Freigabe kommt jetzt auch ueber
// den Downlink - und muendet in DENSELBEN Pfad wie die Taste an der Box.
//
// Was diese Tests schuetzen, ist genau diese Gleichheit: dass der neue
// Transport kein zweites, schwaecheres Tor aufmacht. Sie pruefen deshalb nicht
// die Torkette (die liegt in `internal/otaapply` und ist dort getestet),
// sondern dass eine Freigabe nur dann entsteht, wenn sie auch von der Taste
// entstanden waere - und sonst nie.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
)

// applyEnvelope baut einen Umschlag nach `docs/contracts/mqtt-ota-apply.schema.json`.
func applyEnvelope(t *testing.T, mutate func(m map[string]any)) []byte {
	t.Helper()
	m := map[string]any{
		"schema_version": "1.0",
		"type":           "apply_request",
		"tenant_id":      otaTestTenant,
		"site_id":        otaTestSite,
		"device_id":      otaTestDevice,
		"token":          "9f2c41ab77e05d63",
		"release":        "edge-2026.08.0",
		"requested_at":   time.Now().UTC().Format(time.RFC3339),
		"requested_by":   "7a1f2c94-admin",
	}
	if mutate != nil {
		mutate(m)
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func readApplyRequest(t *testing.T, b *otaTargetBox) *otaapply.ApplyRequest {
	t.Helper()
	req, err := otaapply.ReadJSON[otaapply.ApplyRequest](b.a.Cfg.DataDir,
		otaapply.FileApplyRequest)
	if errors.Is(err, otaapply.ErrAbsent) {
		return nil // keine Freigabe abgelegt - genau das pruefen die meisten Faelle
	}
	if err != nil {
		t.Fatal(err)
	}
	return req
}

// Der Normalfall: geprueftes Ziel, laufender Sidecar, gueltiger Umschlag - die
// Freigabe entsteht mit dem Token DER CLOUD (daran erkennt das Portal spaeter
// GENAU den Vorgang, den es freigegeben hat) und dem Urheber aus dem Umschlag.
func TestAPortalApprovalWritesTheSameSingleUseApprovalAsTheDeviceButton(t *testing.T) {
	b := applyBox(t, true)
	b.a.onApplyRequest(applyEnvelope(t, nil))

	req := readApplyRequest(t, b)
	if req == nil {
		t.Fatal("die Freigabe wurde nicht abgelegt")
	}
	if req.Token != "9f2c41ab77e05d63" {
		t.Errorf("der Token der Cloud muss unveraendert uebernommen werden: %q", req.Token)
	}
	if req.Release != "edge-2026.08.0" {
		t.Errorf("die Freigabe nennt das falsche Release: %q", req.Release)
	}
	if req.RequestedBy != "7a1f2c94-admin" {
		t.Errorf("der Urheber ist die Papier-Spur: %q", req.RequestedBy)
	}
	if !req.Fresh(time.Now()) {
		t.Error("eine gerade erteilte Freigabe muss frisch sein")
	}

	// Danach WARTET die Box - sie fragt nicht erneut, und der Herzschlag sagt
	// das auch (`can_apply` ist eine Faehigkeit, kein Angebot).
	v := b.a.OtaApplyState()
	if !v.Requested || v.CanApply {
		t.Fatalf("nach der Freigabe wartet die Box: %+v", v)
	}
	if sum := b.a.updateSummary(); sum.CanApply {
		t.Fatal("nach der Freigabe meldet der Herzschlag keine offene Faehigkeit mehr")
	}

	// `autonomy.json` bleibt UNBERUEHRT aus - die Freigabe oeffnet ein Tor fuer
	// EINEN Vorgang, sie schaltet keine Autonomie ein.
	if _, err := os.Stat(filepath.Join(b.a.Cfg.DataDir, "ota", "autonomy.json")); !os.IsNotExist(err) {
		t.Fatalf("eine Freigabe darf die Autonomie nie einschalten: %v", err)
	}
}

// Die Freigabe gilt dem Stand, den der Mensch SAH. Ist inzwischen ein anderes
// Release zugewiesen, wird NICHTS abgelegt - eine Zustimmung gilt fuer das, was
// auf dem Schirm stand, nicht fuer das, was danach kam.
func TestAnApprovalForAnotherReleaseIsRefused(t *testing.T) {
	b := applyBox(t, true)
	b.a.onApplyRequest(applyEnvelope(t, func(m map[string]any) {
		m["release"] = "edge-2026.08.9"
	}))
	if req := readApplyRequest(t, b); req != nil {
		t.Fatalf("eine Freigabe fuer ein fremdes Release darf nie entstehen: %+v", req)
	}
}

// Ohne laufenden Sidecar wuerde die Freigabe ins Leere geschrieben - genau die
// Ablehnung, die auch die Taste an der Box gibt.
func TestAPortalApprovalWithoutARunningUpdaterWritesNothing(t *testing.T) {
	b := applyBox(t, false)
	b.a.onApplyRequest(applyEnvelope(t, nil))
	if req := readApplyRequest(t, b); req != nil {
		t.Fatalf("ohne Aktualisierer darf nichts abgelegt werden: %+v", req)
	}
	if sum := b.a.updateSummary(); sum.CanApply {
		t.Fatal("der Herzschlag muss sagen, dass hier nichts angewandt werden kann")
	}
}

// Ein UNGEPRUEFTES Ziel wird durch den neuen Transport nicht anwendbar: die
// Signaturkette entscheidet, nie der Umschlag.
func TestAPortalApprovalNeverApplinesAnUnverifiedTarget(t *testing.T) {
	b := newOtaTargetBox(t, otaManifest("edge-2026.08.0", 12, 9))
	fremd := otaNewKey(t, "rel-fremd")
	b.a.onUpdateTarget(b.envelope(t, otaManifest("edge-2026.08.0", 12, 9), &fremd))
	writeUpdaterState(t, b, otaapply.UpdaterState{
		UpdatedAt: time.Now().UTC().Format(otaapply.TimeFormat),
		State:     otaapply.StateIdle,
	})
	b.a.onApplyRequest(applyEnvelope(t, nil))
	if req := readApplyRequest(t, b); req != nil {
		t.Fatalf("eine gebrochene Kette bleibt gebrochen: %+v", req)
	}
}

// Form und Identitaet: alles, was nicht auf dieses Geraet passt oder die Form
// verletzt, wird VERWORFEN - dieselbe Disziplin wie bei Telemetrie, purge_data
// und der Zuweisung.
func TestAMalformedOrForeignApprovalIsDiscarded(t *testing.T) {
	faelle := map[string]func(m map[string]any){
		"fremdes Geraet":  func(m map[string]any) { m["device_id"] = "00000000-0000-0000-0000-0000000000ff" },
		"fremder Mandant": func(m map[string]any) { m["tenant_id"] = "00000000-0000-0000-0000-0000000000ff" },
		"fremde Anlage":   func(m map[string]any) { m["site_id"] = "00000000-0000-0000-0000-0000000000ff" },
		"falsche Version": func(m map[string]any) { m["schema_version"] = "2.0" },
		"falscher Typ":    func(m map[string]any) { m["type"] = "apply_now" },
		"ohne Token":      func(m map[string]any) { delete(m, "token") },
		"krummer Token":   func(m map[string]any) { m["token"] = "nicht-hex!" },
		"ohne Release":    func(m map[string]any) { delete(m, "release") },
	}
	for name, mutate := range faelle {
		t.Run(name, func(t *testing.T) {
			b := applyBox(t, true)
			b.a.onApplyRequest(applyEnvelope(t, mutate))
			if req := readApplyRequest(t, b); req != nil {
				t.Fatalf("%s haette verworfen werden muessen: %+v", name, req)
			}
		})
	}

	// Muell und Leeres duerfen nicht einmal einen Parser-Panik ausloesen.
	b := applyBox(t, true)
	b.a.onApplyRequest([]byte("kein json"))
	b.a.onApplyRequest(nil)
	if req := readApplyRequest(t, b); req != nil {
		t.Fatalf("Muell darf nie zu einer Freigabe werden: %+v", req)
	}
}

// ⚠ DER Fall, gegen den der Umschlag-Stempel existiert: der Cloud-Link haelt
// eine DAUERHAFTE Sitzung, der Broker darf eine QoS1-Nachricht fuer eine
// abwesende Box also NACHLIEFERN. Waere der Empfangs-Zeitpunkt der Beginn des
// Fensters, waere eine stundenalte Zustimmung beim Wiederverbinden wieder
// taufrisch - und die Einmal-Freigabe damit keine.
func TestALateRedeliveredApprovalIsAlreadyExpired(t *testing.T) {
	b := applyBox(t, true)
	b.a.onApplyRequest(applyEnvelope(t, func(m map[string]any) {
		m["requested_at"] = time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339)
	}))
	if req := readApplyRequest(t, b); req != nil {
		t.Fatalf("eine nachgelieferte Freigabe darf nicht anwenden: %+v", req)
	}

	// Und ein UNLESBARER Stempel gilt nicht - im Zweifel wird nichts angewandt
	// (so steht es im Kontrakt).
	b2 := applyBox(t, true)
	b2.a.onApplyRequest(applyEnvelope(t, func(m map[string]any) {
		m["requested_at"] = "irgendwann"
	}))
	if req := readApplyRequest(t, b2); req != nil {
		t.Fatalf("ein unlesbarer Stempel darf nicht gelten: %+v", req)
	}

	// Der Stempel wird UEBERNOMMEN, nicht neu gesetzt: sonst verschoebe jede
	// Zustellung das Fenster nach hinten.
	b3 := applyBox(t, true)
	stamp := time.Now().Add(-10 * time.Minute).UTC().Truncate(time.Second)
	b3.a.onApplyRequest(applyEnvelope(t, func(m map[string]any) {
		m["requested_at"] = stamp.Format(time.RFC3339)
	}))
	req := readApplyRequest(t, b3)
	if req == nil {
		t.Fatal("eine Freigabe INNERHALB des Fensters muss gelten")
	}
	got, err := time.Parse(otaapply.TimeFormat, req.RequestedAt)
	if err != nil || !got.Equal(stamp) {
		t.Fatalf("der Stempel des Umschlags muss uebernommen werden: %q (%v)",
			req.RequestedAt, err)
	}
}

// Die EINGECHECKTEN Kontrakt-Beispiele werden vom ECHTEN Geraete-Parser
// gelesen - per PFAD, damit ein verschobenes Beispiel den Test bricht.
func TestContractExampleApprovalIsParsedAsSpecified(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "docs", "contracts", "examples")
	lies := func(name string) []byte {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}

	// Beide GUELTIGEN Beispiele nennen `edge-2026.08.1`, also traegt die Box
	// genau diese Zuweisung.
	box := func() *otaTargetBox {
		b := newOtaTargetBox(t, otaManifest("edge-2026.08.1", 13, 9))
		b.a.onUpdateTarget(b.envelope(t, otaManifest("edge-2026.08.1", 13, 9), nil))
		writeUpdaterState(t, b, otaapply.UpdaterState{
			UpdatedAt: time.Now().UTC().Format(otaapply.TimeFormat),
			State:     otaapply.StateIdle,
		})
		return b
	}

	// Die Beispiele tragen einen FESTEN Stempel - der ist laengst ausserhalb
	// des 15-Minuten-Fensters, und genau das ist richtig so (der Test darueber
	// nagelt es fest). Fuer den PARSER-Beweis wird nur dieses eine Feld auf
	// jetzt gesetzt; alles andere bleibt Byte fuer Byte das Beispiel.
	jetzt := func(raw []byte) []byte {
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		m["requested_at"] = time.Now().UTC().Format(time.RFC3339)
		out, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}

	voll := box()
	voll.a.onApplyRequest(jetzt(lies("mqtt-ota-apply.valid.rollout.json")))
	req := readApplyRequest(t, voll)
	if req == nil || req.Token != "9f2c41ab77e05d63" || req.Release != "edge-2026.08.1" {
		t.Fatalf("das Kontrakt-Beispiel wurde nicht wie spezifiziert gelesen: %+v", req)
	}
	if req.RequestedBy != "7a1f2c94-admin" {
		t.Errorf("der Urheber fehlt: %+v", req)
	}

	// Das minimale Beispiel laesst `requested_by` weg - die Box erfindet keinen
	// Namen, sie nennt den Kanal.
	knapp := box()
	knapp.a.onApplyRequest(jetzt(lies("mqtt-ota-apply.valid.minimal.json")))
	if req := readApplyRequest(t, knapp); req == nil || req.RequestedBy != "Portal" {
		t.Fatalf("ohne Urheber steht der Kanal da: %+v", req)
	}

	// Und das UNGUELTIGE Beispiel wird verworfen - ohne Token gaebe es keine
	// Einmaligkeit.
	kaputt := box()
	kaputt.a.onApplyRequest(jetzt(lies("mqtt-ota-apply.invalid.no-token.json")))
	if req := readApplyRequest(t, kaputt); req != nil {
		t.Fatalf("das ungueltige Beispiel haette verworfen werden muessen: %+v", req)
	}
}
