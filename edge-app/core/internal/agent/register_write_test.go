package agent

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/installerwrite"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/registerwrite"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// Der PORTAL-Trigger des Einmal-Schreibens. Bewiesen wird die VERDRAHTUNG - dass
// er GENAU den Kern der :8484-Taste ruft, dass jede Ablehnung beantwortet wird
// (ausser den zwei, die stumm sein muessen), und dass die Papier-Spur beider
// Buecher denselben Schluessel traegt.

type portalBox struct {
	*installerBox
	answers chan registerwrite.Result
}

// startPortalBox is startInstallerBox plus the cloud identity and the publish
// seam, so a test asserts on the CONTRACT BYTES the box would put on the wire.
func startPortalBox(t *testing.T, on bool) *portalBox {
	t.Helper()
	box := startInstallerBox(t, on)
	answers := make(chan registerwrite.Result, 8)
	box.a.registerPublish = func(payload []byte) error {
		var res registerwrite.Result
		if err := json.Unmarshal(payload, &res); err != nil {
			t.Errorf("die Quittung ist kein gueltiges JSON: %v", err)
			return nil
		}
		answers <- res
		return nil
	}
	box.a.entMu.Lock()
	box.a.entIdentity.TenantID = "00000000-0000-0000-0000-000000000001"
	box.a.entIdentity.SiteID = "00000000-0000-0000-0000-000000000002"
	box.a.entIdentity.DeviceID = "00000000-0000-0000-0000-000000000003"
	box.a.entMu.Unlock()
	return &portalBox{installerBox: box, answers: answers}
}

func (b *portalBox) order(t *testing.T, mode, requestID string, extra map[string]any) []byte {
	t.Helper()
	m := map[string]any{
		"schema_version": "1.0", "type": "register_write_request",
		"tenant_id":  "00000000-0000-0000-0000-000000000001",
		"site_id":    "00000000-0000-0000-0000-000000000002",
		"device_id":  "00000000-0000-0000-0000-000000000003",
		"request_id": requestID, "requested_at": time.Now().UTC().Format(time.RFC3339),
		"requested_by": "sub-1", "mode": mode,
		"target":   map[string]any{"kind": "primary"},
		"register": map[string]any{"kind": "holding", "address": 231},
	}
	if mode == "schreiben" {
		m["value"] = 7000
		m["confirm"] = "0X00E7=7000"
	}
	for k, v := range extra {
		if v == nil {
			delete(m, k)
			continue
		}
		m[k] = v
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func (b *portalBox) await(t *testing.T) registerwrite.Result {
	t.Helper()
	select {
	case res := <-b.answers:
		return res
	case <-time.After(10 * time.Second):
		t.Fatal("keine Quittung")
		return registerwrite.Result{}
	}
}

func (b *portalBox) silent(t *testing.T, why string) {
	t.Helper()
	select {
	case res := <-b.answers:
		t.Fatalf("%s: es haette KEINE Quittung geben duerfen (%+v)", why, res)
	case <-time.After(300 * time.Millisecond):
	}
}

// Die vollstaendige Reise: Vorschau liest, Bestaetigung schreibt EINMAL und
// liest zurueck - beides ueber den Bus zum Flow-Knoten, nie ueber einen eigenen
// Socket des Kerns.
func TestThePortalTriggerPreviewsThenWritesOnceThroughTheSharedCore(t *testing.T) {
	box := startPortalBox(t, true)
	seen := make(chan installerBusRequest, 4)
	before, after := 3300, 7000
	installerStub(t, box.addr, seen, func(req installerBusRequest) installerBusResult {
		if req.Mode == "apply" {
			return installerBusResult{OK: true, Before: &before, After: &after, Wrote: true}
		}
		return installerBusResult{OK: true, Before: &before}
	})

	box.a.onRegisterWrite(box.order(t, "lesen", "9f2c41ab77d05e11", nil))
	preview := box.await(t)
	if !preview.OK || preview.BeforeRaw == nil || *preview.BeforeRaw != 3300 {
		t.Fatalf("die Vorschau muss den Ist-Wert melden: %+v", preview)
	}
	if preview.AfterRaw != nil || preview.Adopted != nil {
		t.Fatalf("eine Vorschau hat kein Nachher und kein Urteil: %+v", preview)
	}
	if got := <-seen; got.Mode != "dry_run" || got.Addr != 0x00e7 {
		t.Fatalf("der Bus-Auftrag war kein Probelauf auf 0x00e7: %+v", got)
	}

	box.a.onRegisterWrite(box.order(t, "schreiben", "9f2c41ab77d05e12", nil))
	res := box.await(t)
	if !res.OK || res.Adopted == nil || !*res.Adopted || res.AfterRaw == nil || *res.AfterRaw != 7000 {
		t.Fatalf("der Schreibvorgang muss uebernommen gemeldet werden: %+v", res)
	}
	if res.TargetLabel == "" {
		t.Fatal("die Box muss echoen, WOHIN sie geschrieben hat")
	}
	got := <-seen
	if got.Mode != "apply" || got.Value != 7000 {
		t.Fatalf("der Bus-Auftrag war kein bestaetigter Schreibvorgang: %+v", got)
	}

	// GENAU EIN Bus-Auftrag je Anfrage - kein Retry hinter dem Ruecken.
	select {
	case extra := <-seen:
		t.Fatalf("es darf keinen zweiten Versuch geben: %+v", extra)
	case <-time.After(300 * time.Millisecond):
	}

	// Die Papier-Spur der Box traegt DIESELBE Kennung wie die Cloud.
	entries := box.a.installerLog.List()
	if len(entries) != 1 {
		t.Fatalf("genau der bestaetigte Schreibvorgang wird protokolliert, nicht der Probelauf: %d", len(entries))
	}
	if entries[0].RequestID != "9f2c41ab77d05e12" {
		t.Fatalf("der Kreuz-Schluessel fehlt: %+v", entries[0])
	}
	if entries[0].Source != "portal:sub-1" {
		t.Fatalf("die Herkunft muss den Trigger nennen: %q", entries[0].Source)
	}
}

// Zwei Ablehnungen sind STUMM: eine fremde Identitaet (eine Antwort bestaetigte
// einem falsch adressierten Absender die Existenz dieses Geraets) und ein
// verfallener Auftrag (die Portal-Route hat laengst aufgegeben, und eine
// nachgelieferte QoS1-Nachricht wuerde sonst einen EEPROM-Zyklus kosten).
func TestAForeignOrAnExpiredOrderIsDiscardedSilentlyAndNeverReachesTheDevice(t *testing.T) {
	box := startPortalBox(t, true)
	seen := make(chan installerBusRequest, 4)
	installerStub(t, box.addr, seen, nil)

	box.a.onRegisterWrite(box.order(t, "schreiben", "9f2c41ab77d05e21", map[string]any{
		"device_id": "00000000-0000-0000-0000-0000000000ff"}))
	box.silent(t, "fremde Identitaet")

	box.a.onRegisterWrite(box.order(t, "schreiben", "9f2c41ab77d05e22", map[string]any{
		"requested_at": time.Now().Add(-5 * time.Minute).UTC().Format(time.RFC3339)}))
	box.silent(t, "verfallener Auftrag")

	select {
	case got := <-seen:
		t.Fatalf("das Geraet wurde trotzdem erreicht: %+v", got)
	case <-time.After(300 * time.Millisecond):
	}
	if n := len(box.a.installerLog.List()); n != 0 {
		t.Fatalf("eine verworfene Anfrage hinterlaesst keine Zeile: %d", n)
	}
}

// Ein nicht armiertes Geraet ANTWORTET ehrlich, statt zu schweigen - sonst saehe
// der Betreiber einen Timeout und suchte den Fehler im Netz.
func TestAnUnarmedBoxRefusesLoudlyAndWritesNothing(t *testing.T) {
	box := startPortalBox(t, false) // Feature-Gate AUS
	seen := make(chan installerBusRequest, 2)
	installerStub(t, box.addr, seen, nil)

	box.a.onRegisterWrite(box.order(t, "schreiben", "9f2c41ab77d05e31", nil))
	res := box.await(t)
	if res.OK || res.ErrorCode != registerwrite.ErrGateDisabled || res.Message == "" {
		t.Fatalf("das geschlossene Tor muss benannt werden: %+v", res)
	}
	select {
	case got := <-seen:
		t.Fatalf("ein nicht armiertes Geraet darf nichts schreiben: %+v", got)
	case <-time.After(300 * time.Millisecond):
	}
}

// Die Selbstkonflikt-Sperre greift schon in der VORSCHAU: „wuerde abgelehnt"
// gehoert in Schritt 1, nie erst nach dem Klick des Menschen.
func TestARegisterTheRunningControlOwnsIsRefusedAlreadyInThePreview(t *testing.T) {
	box := startPortalBox(t, true)
	seen := make(chan installerBusRequest, 2)
	installerStub(t, box.addr, seen, nil)

	box.a.State.Update(func(s *state.Snapshot) {
		s.ControlEnabled = true
		s.ControlCertified = true
		s.Control = &state.ControlInfo{
			CheckedAt: time.Now(), ControlEnabled: true, Certified: true,
			Registers: []state.ControlRegister{{Role: "pv_limit", Addr: 0x00e7, CommandedRaw: 1310}},
		}
	})

	box.a.onRegisterWrite(box.order(t, "lesen", "9f2c41ab77d05e41", nil))
	res := box.await(t)
	if res.ErrorCode != registerwrite.ErrRefusedControlOwned || res.Message == "" {
		t.Fatalf("die Sperre muss mit deutschem Grund greifen: %+v", res)
	}
	select {
	case got := <-seen:
		t.Fatalf("ein gesperrtes Register darf das Geraet nie erreichen: %+v", got)
	case <-time.After(300 * time.Millisecond):
	}

	// Bei INAKTIVER Steuerung ist dasselbe Register wieder die
	// Installateurs-Domaene.
	box.a.State.Update(func(s *state.Snapshot) { s.ControlEnabled = false })
	box.a.onRegisterWrite(box.order(t, "lesen", "9f2c41ab77d05e42", nil))
	select {
	case got := <-seen:
		if got.Addr != 0x00e7 {
			t.Fatalf("falsches Register: %+v", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("bei inaktiver Steuerung muss gelesen werden duerfen")
	}
}

// Die POLITIK bleibt beim gemeinsamen Kern: derselbe deutsche Satz wie an der
// lokalen Taste, keine zweite Formulierung.
func TestPolicyRefusalsComeFromTheSharedCoreVerbatim(t *testing.T) {
	box := startPortalBox(t, true)
	installerStub(t, box.addr, nil, nil)

	box.a.onRegisterWrite(box.order(t, "schreiben", "9f2c41ab77d05e51", map[string]any{
		"value": 9000, "confirm": "0X00E7=9000"}))
	res := box.await(t)
	if res.ErrorCode != registerwrite.ErrRefusedPolicy {
		t.Fatalf("ueber der Obergrenze muss die Politik greifen: %+v", res)
	}
	if res.Message == "" || res.BeforeRaw != nil {
		t.Fatalf("die Ablehnung nennt ihren Grund und traegt keinen Wert: %+v", res)
	}
	// Eine Spule fuehrt diese Stufe nicht aus - benannt, nie still.
	box.a.onRegisterWrite(box.order(t, "lesen", "9f2c41ab77d05e52", map[string]any{
		"register": map[string]any{"kind": "coil", "address": 4}}))
	if r := box.await(t); r.ErrorCode != registerwrite.ErrNotSupported {
		t.Fatalf("eine Spule muss benannt abgelehnt werden: %+v", r)
	}
}

// Dieselbe Anfrage darf nie zweimal schreiben - die dritte Sicherung neben
// „nicht retained" und dem Fenster.
func TestTheSameOrderNeverWritesTwice(t *testing.T) {
	box := startPortalBox(t, true)
	seen := make(chan installerBusRequest, 4)
	before, after := 3300, 7000
	installerStub(t, box.addr, seen, func(req installerBusRequest) installerBusResult {
		return installerBusResult{OK: true, Before: &before, After: &after, Wrote: true}
	})

	order := box.order(t, "schreiben", "9f2c41ab77d05e61", nil)
	box.a.onRegisterWrite(order)
	if r := box.await(t); !r.OK {
		t.Fatalf("der erste Versuch muss laufen: %+v", r)
	}
	<-seen

	box.a.onRegisterWrite(order) // die QoS1-Doppelzustellung
	if r := box.await(t); r.ErrorCode != registerwrite.ErrBusy {
		t.Fatalf("die Wiederholung muss benannt abgelehnt werden: %+v", r)
	}
	select {
	case got := <-seen:
		t.Fatalf("dieselbe Anfrage darf nie ein zweites Mal schreiben: %+v", got)
	case <-time.After(300 * time.Millisecond):
	}
}

// D6: die lokalen Schreibvorgaenge erreichen das Cloud-Journal - und ein Geraet,
// das nie geschrieben hat, sendet GAR KEINEN Block.
func TestTheHeartbeatCarriesTheBoxesOwnWriteAuditOrNothingAtAll(t *testing.T) {
	box := startPortalBox(t, true)
	if sum := box.a.registerWritesSummary(); sum != nil {
		t.Fatalf("ohne Schreibvorgang gibt es keinen Block: %+v", sum)
	}

	before, after := 3300, 7000
	installerStub(t, box.addr, nil, func(req installerBusRequest) installerBusResult {
		return installerBusResult{OK: true, Before: &before, After: &after, Wrote: true}
	})
	// Ein LOKALER Schreibvorgang (die :8484-Taste) - er hat keine Cloud-Kennung
	// und muss sich deshalb selbst eine geben.
	expected := 3300
	if _, err := box.a.InstallerWrite(installerRequest(7000, true, &expected), "wartungszugang"); err != nil {
		t.Fatalf("lokaler Schreibvorgang: %v", err)
	}

	sum := box.a.registerWritesSummary()
	if sum == nil || len(sum.Entries) != 1 {
		t.Fatalf("der lokale Schreibvorgang muss gemeldet werden: %+v", sum)
	}
	e := sum.Entries[0]
	if e.RequestID == "" {
		t.Fatal("ohne Kreuz-Schluessel kann die Cloud den Vorgang nicht zuordnen")
	}
	if e.Source != "wartungszugang" || e.Requested != 7000 || e.Register != "0x00e7" {
		t.Fatalf("der Eintrag muss das Buch der Box spiegeln: %+v", e)
	}
	if e.Before == nil || *e.Before != 3300 || e.After == nil || *e.After != 7000 {
		t.Fatalf("Vorher/Nachher muessen mitreisen: %+v", e)
	}
	if sum.ReportedAt == "" {
		t.Fatal("der Block traegt seinen eigenen Stempel")
	}
}

// installerRequest baut die Eingabe der :8484-Taste.
func installerRequest(value int, apply bool, expected *int) installerwrite.Request {
	req := installerwrite.Request{Value: value, ExpectedBefore: expected}
	if apply {
		req.Mode = installerwrite.ModeApply
		req.Confirm = installerwrite.ConfirmToken(value)
	}
	return req
}
