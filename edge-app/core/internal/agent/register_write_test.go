package agent

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/installerwrite"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
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
// Wie dort gibt es KEINEN Armierungs-Schritt - die Vorgabe-Konfiguration ist
// die Konfiguration jeder Kundenbox.
func startPortalBox(t *testing.T) *portalBox {
	t.Helper()
	box := startInstallerBox(t)
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
	box := startPortalBox(t)
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
	box := startPortalBox(t)
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

// ⚠ ES GIBT KEINEN ARMIERUNGS-SCHRITT (Captain-Korrektur 20.08.2026, D2
// KORRIGIERT). Frueher stand hier der Beweis „ein nicht armiertes Geraet
// antwortet gate_disabled"; jetzt ist der Beweis, dass eine Box mit der REINEN
// Vorgabe-Konfiguration - ohne jede gesetzte Umgebungsvariable - den Auftrag
// ausfuehrt. Der plattformweite Hebel ist der Cloud-Not-Aus am api (der mit
// deutschem Grund refuesiert, siehe RegisterWriteKillSwitchTest), die Tore sind
// Identitaet, Fenster, Einmaligkeit, Lane-Politik und Selbstkonflikt-Sperre -
// und sie laufen alle in DIESER Datei.
func TestThePathNeedsNoArmingStepOnTheBox(t *testing.T) {
	box := startPortalBox(t)
	// Struktur-Waechter: die Konfiguration traegt gar kein Feld mehr, mit dem
	// sich der Pfad armieren liesse - eine Wieder-Einfuehrung faellt hier auf.
	raw, err := json.Marshal(box.a.Cfg)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "installer_write") {
		t.Fatalf("es darf kein Armierungs-Feld mehr geben: %s", raw)
	}
	seen := make(chan installerBusRequest, 2)
	before, after := 3300, 7000
	installerStub(t, box.addr, seen, func(req installerBusRequest) installerBusResult {
		return installerBusResult{OK: true, Before: &before, After: &after, Wrote: true}
	})

	box.a.onRegisterWrite(box.order(t, "schreiben", "9f2c41ab77d05e31", nil))
	res := box.await(t)
	if !res.OK || res.ErrorCode != "" {
		t.Fatalf("ohne Armierung muss der Auftrag laufen: %+v", res)
	}
	if res.Adopted == nil || !*res.Adopted || res.AfterRaw == nil || *res.AfterRaw != 7000 {
		t.Fatalf("der Schreibvorgang muss uebernommen gemeldet werden: %+v", res)
	}
	select {
	case got := <-seen:
		if got.Mode != "apply" || got.Addr != 0x00e7 || got.Value != 7000 {
			t.Fatalf("das Geraet muss den Auftrag sehen: %+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("das Geraet wurde nie erreicht")
	}
}

// Die Selbstkonflikt-Sperre greift schon in der VORSCHAU: „wuerde abgelehnt"
// gehoert in Schritt 1, nie erst nach dem Klick des Menschen.
func TestARegisterTheRunningControlOwnsIsRefusedAlreadyInThePreview(t *testing.T) {
	box := startPortalBox(t)
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
	box := startPortalBox(t)
	installerStub(t, box.addr, nil, nil)

	// ⚠ Der Vektor ist SEIT STUFE 2 ein Funktionscode-Widerspruch, nicht mehr
	// „ueber 7000": der Portal-Kanal laeuft seither ueber den EXPERTEN-Umfang
	// (installerwrite.AdmitExpert), und dort ist der Wert 0..65535 frei - der
	// Deckel 7000 gehoert allein der engen :8484-Taste. Ein FC5 auf ein
	// Holding-Register bleibt dagegen ein Widerspruch, ueber den GENAU DIESE
	// gemeinsame Schicht urteilt.
	box.a.onRegisterWrite(box.order(t, "schreiben", "9f2c41ab77d05e51", map[string]any{
		"write_fc": 5}))
	res := box.await(t)
	if res.ErrorCode != registerwrite.ErrRefusedPolicy {
		t.Fatalf("ein FC-Widerspruch muss die Politik greifen lassen: %+v", res)
	}
	if res.Message == "" || res.BeforeRaw != nil {
		t.Fatalf("die Ablehnung nennt ihren Grund und traegt keinen Wert: %+v", res)
	}
	// VERBATIM aus dem geteilten Kern - eine zweite Formulierung hier liesse die
	// zwei Trigger dieselbe Ablehnung verschieden benennen.
	if _, err := installerwrite.AdmitExpert(installerwrite.ExpertRequest{
		Kind: "holding", Addr: 231, Value: 7000, Apply: true,
		Confirm: "0x00e7=7000", WriteFC: 5,
	}); err == nil || err.Error() != res.Message {
		t.Fatalf("der Satz muss WOERTLICH aus installerwrite kommen: %q vs %v", res.Message, err)
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
	box := startPortalBox(t)
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
	box := startPortalBox(t)
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
		req.Confirm = installerwrite.ConfirmToken(installerwrite.RegisterAddr, value)
	}
	return req
}

// --- Stufe 2 „Freie Register": die Lane-Regeln loesen die Allowlist ab -------

// registerStub spielt den Palette-Knoten der schlichten Modbus-TCP-Lane
// (edge/register-write/*). Er antwortet in DERSELBEN Form wie der
// Solarman-Knoten - genau der Punkt: der Kern hat EINE Ergebnis-Form je Lane.
func registerStub(t *testing.T, busAddr string, seen chan<- installerBusRequest,
	answer func(req installerBusRequest) installerBusResult) {
	t.Helper()
	opts := pahomqtt.NewClientOptions().
		AddBroker("tcp://" + busAddr).
		SetClientID("test-register-stub").
		SetConnectTimeout(5 * time.Second)
	client := pahomqtt.NewClient(opts)
	if tok := client.Connect(); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		t.Fatalf("stub connect: %v", tok.Error())
	}
	t.Cleanup(func() { client.Disconnect(100) })
	tok := client.Subscribe(localbus.TopicRegisterWriteRequest, 1,
		func(_ pahomqtt.Client, msg pahomqtt.Message) {
			var req installerBusRequest
			if json.Unmarshal(msg.Payload(), &req) != nil || req.RequestID == "" {
				return
			}
			if seen != nil {
				select {
				case seen <- req:
				default:
				}
			}
			if answer == nil {
				return
			}
			res := answer(req)
			res.RequestID = req.RequestID
			raw, _ := json.Marshal(res)
			client.Publish(localbus.TopicRegisterWriteResult, 1, false, raw)
		})
	if !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("stub subscribe: %v", tok.Error())
	}
}

// ⚠ DIE ABLOESUNG SELBST: ein FREIES Register auf der primaeren Lane wird
// ausgefuehrt - die harte 0x00E7-Allowlist ist weg, und was bleibt, sind die
// Regeln, die diese Schicht wirklich beurteilen kann.
func TestAFreeRegisterIsWrittenOnThePrimaryLane(t *testing.T) {
	box := startPortalBox(t)
	seen := make(chan installerBusRequest, 4)
	before, after := 12, 34
	installerStub(t, box.addr, seen, func(req installerBusRequest) installerBusResult {
		if req.Mode == installerwrite.ModeApply {
			return installerBusResult{OK: true, Before: &before, After: &after, Wrote: true}
		}
		return installerBusResult{OK: true, Before: &before}
	})

	box.a.onRegisterWrite(box.order(t, "schreiben", "11aa22bb33cc44dd", map[string]any{
		"register": map[string]any{"kind": "holding", "address": 0x1234},
		"value":    34,
		"confirm":  "0X1234=34",
	}))
	res := box.await(t)
	if !res.OK || res.AfterRaw == nil || *res.AfterRaw != 34 {
		t.Fatalf("ein freies Register muss geschrieben werden: %+v", res)
	}
	req := <-seen
	if req.Addr != 0x1234 || req.Value != 34 || req.Kind != installerwrite.KindHolding {
		t.Fatalf("der Auftrag erreicht den Knoten unveraendert: %+v", req)
	}
	// ⚠ Und ein Register OHNE bekannte Skala bekommt KEINE erfundene Einheit -
	// das Audit-Protokoll traegt dann gar keine kW-Zahl.
	entries := box.a.installerLog.List()
	if len(entries) != 1 {
		t.Fatalf("genau ein Protokoll-Eintrag erwartet, got %d", len(entries))
	}
	if entries[0].Kw != nil {
		t.Fatalf("ein freies Register hat keine Einheit: %+v", *entries[0].Kw)
	}
	if entries[0].Register != "0x1234" {
		t.Fatalf("das Protokoll nennt die geschriebene Adresse: %q", entries[0].Register)
	}
}

// Die Wertgrenze der :8484-Taste (7000) gilt fuer den PORTAL-Kanal NICHT mehr -
// dort ist ein Registerwort 0..65535, und 0 ist ein WERT.
func TestTheExpertScopeAcceptsEveryRegisterWordAndRefusesTheRest(t *testing.T) {
	box := startPortalBox(t)
	before := 1
	installerStub(t, box.addr, nil, func(req installerBusRequest) installerBusResult {
		return installerBusResult{OK: true, Before: &before, After: &req.Value, Wrote: true}
	})
	for i, value := range []int{0, 7001, 65535} {
		box.a.onRegisterWrite(box.order(t, "schreiben", regReqID(i), map[string]any{
			"register": map[string]any{"kind": "holding", "address": 0x40},
			"value":    value,
			"confirm":  installerwrite.ConfirmToken(0x40, value),
		}))
		if res := box.await(t); !res.OK {
			t.Fatalf("Wert %d ist ein Registerwort: %+v", value, res)
		}
	}
	// Ausserhalb des Wortes: die POLITIK lehnt ab, mit deutschem Grund.
	box.a.onRegisterWrite(box.order(t, "schreiben", regReqID(9), map[string]any{
		"register": map[string]any{"kind": "holding", "address": 0x40},
		"value":    65536,
		"confirm":  "0X0040=65536",
	}))
	res := box.await(t)
	if res.OK || res.ErrorCode != registerwrite.ErrRefusedPolicy || res.Message == "" {
		t.Fatalf("65536 ist kein Registerwort: %+v", res)
	}
}

// Die Komponenten-Lane: die Cloud nennt NUR die Kennung, die Box loest Host,
// Port und Unit aus IHRER angewandten Definition auf.
func TestTheEntityLaneResolvesTheEndpointFromTheBoxOwnDefinition(t *testing.T) {
	box := startPortalBox(t)
	entityID := "00000000-0000-0000-0000-0000000000aa"
	box.a.entMu.Lock()
	box.a.entRegistry = entities.Registry{Entities: []entities.Entity{{
		ID: entityID, Type: "modbus-generic", Label: "Lüftung Keller",
		Driver: json.RawMessage(`{"communication":"modbus_baukasten",` +
			`"connection":{"ip":"192.168.0.44","port":1502,"unit_id":3}}`),
	}}}
	box.a.entMu.Unlock()

	seen := make(chan installerBusRequest, 4)
	before, after := 0, 1
	registerStub(t, box.addr, seen, func(req installerBusRequest) installerBusResult {
		return installerBusResult{OK: true, Before: &before, After: &after, Wrote: true}
	})

	box.a.onRegisterWrite(box.order(t, "schreiben", "aaaabbbbccccdddd", map[string]any{
		"target":   map[string]any{"kind": "entity", "entity_id": entityID},
		"register": map[string]any{"kind": "coil", "address": 3},
		"value":    1,
		"confirm":  "0X0003=1",
	}))
	res := box.await(t)
	if !res.OK {
		t.Fatalf("die Komponenten-Lane wird ausgefuehrt: %+v", res)
	}
	req := <-seen
	if req.Host != "192.168.0.44" || req.Port != 1502 || req.UnitID != 3 {
		t.Fatalf("der Endpunkt kommt aus der Definition der Box: %+v", req)
	}
	if req.Kind != installerwrite.KindCoil || req.WriteFC != 0 {
		t.Fatalf("eine Spule reist als Spule, der Funktionscode bleibt dem Ausfuehrer: %+v", req)
	}
	// Das Ziel-Echo nennt die Komponente beim Namen - auf einer Anlage mit
	// mehreren Geraeten ist das Ziel eine bewusste Wahl.
	if !containsSub(res.TargetLabel, "Lüftung Keller") || !containsSub(res.TargetLabel, "192.168.0.44") {
		t.Fatalf("das Ziel-Echo nennt Komponente und Endpunkt: %q", res.TargetLabel)
	}

	// Eine unbekannte Kennung wird BENANNT abgelehnt, nie still verworfen.
	box.a.onRegisterWrite(box.order(t, "lesen", "1111222233334444", map[string]any{
		"target": map[string]any{"kind": "entity",
			"entity_id": "00000000-0000-0000-0000-0000000000ff"}}))
	if res := box.await(t); res.OK || res.ErrorCode != registerwrite.ErrNotSupported {
		t.Fatalf("eine unbekannte Komponente wird benannt abgelehnt: %+v", res)
	}
}

// ⚠ Eine Komponente, die ueber den Solarman-Logger gelesen wird, gehoert auf die
// PRIMAERE Lane - dieser Socket gehoert dem Wechselrichter-Tab, und ein zweiter
// Anspruch darauf ist genau das, was das Ein-Socket-Gesetz verbietet.
func TestASolarmanComponentIsNamedNotSilentlyRedirected(t *testing.T) {
	box := startPortalBox(t)
	entityID := "00000000-0000-0000-0000-0000000000bb"
	box.a.entMu.Lock()
	box.a.entRegistry = entities.Registry{Entities: []entities.Entity{{
		ID: entityID, Type: "battery-hybrid",
		Driver: json.RawMessage(`{"communication":"solarman_v5",` +
			`"connection":{"ip":"192.168.0.28","serial":"2985159064","mb_slave_id":1}}`),
	}}}
	box.a.entMu.Unlock()
	registerStub(t, box.addr, nil, func(installerBusRequest) installerBusResult {
		t.Error("die Solarman-Komponente darf den Modbus-Knoten nie erreichen")
		return installerBusResult{}
	})
	box.a.onRegisterWrite(box.order(t, "lesen", "5555666677778888", map[string]any{
		"target": map[string]any{"kind": "entity", "entity_id": entityID}}))
	res := box.await(t)
	if res.OK || res.ErrorCode != registerwrite.ErrNotSupported ||
		!containsSub(res.Message, "primären Wechselrichter") {
		t.Fatalf("der Weg wird GENANNT: %+v", res)
	}
}

// Die freie LAN-Lane: der Endpunkt reist, weil es keinen anderen Weg gibt ihn
// zu nennen - und genau deshalb prueft die Box ihn selbst.
func TestTheFreeLanLaneWritesAPrivateTargetAndRefusesEveryOther(t *testing.T) {
	box := startPortalBox(t)
	seen := make(chan installerBusRequest, 4)
	before, after := 7, 9
	registerStub(t, box.addr, seen, func(installerBusRequest) installerBusResult {
		return installerBusResult{OK: true, Before: &before, After: &after, Wrote: true}
	})

	box.a.onRegisterWrite(box.order(t, "schreiben", "9999888877776666", map[string]any{
		"target":   map[string]any{"kind": "lan", "host": "192.168.0.99"},
		"register": map[string]any{"kind": "holding", "address": 9},
		"value":    9,
		"confirm":  "0X0009=9",
	}))
	if res := box.await(t); !res.OK || res.AfterRaw == nil || *res.AfterRaw != 9 {
		t.Fatalf("eine private Adresse wird beschrieben: %+v", res)
	}
	req := <-seen
	// Die Vorgaben des Kontrakts stehen bei den REINEN Regeln, nicht hier.
	if req.Host != "192.168.0.99" || req.Port != 502 || req.UnitID != 1 {
		t.Fatalf("Port/Unit folgen den Kontrakt-Vorgaben: %+v", req)
	}

	// Ein oeffentliches Ziel wird abgelehnt, BEVOR irgendetwas angeklopft wird.
	box.a.onRegisterWrite(box.order(t, "lesen", "4444333322221111", map[string]any{
		"target": map[string]any{"kind": "lan", "host": "8.8.8.8"}}))
	res := box.await(t)
	if res.OK || res.ErrorCode != registerwrite.ErrInvalidRequest ||
		res.Message != registerwrite.MsgHostNotPrivate {
		t.Fatalf("ein oeffentliches Ziel wird nie angeklopft: %+v", res)
	}
	select {
	case req := <-seen:
		t.Fatalf("der Knoten haette nichts sehen duerfen: %+v", req)
	case <-time.After(200 * time.Millisecond):
	}
}

// ⚠ Die Selbstkonflikt-Sperre gilt dem GERAET, nicht der Zahl: dieselbe Adresse
// auf einem eigenen Modbus-Geraet des Kunden ist ein voellig anderes Register.
func TestTheSelfConflictLockIsScopedToTheControlledDevice(t *testing.T) {
	box := startPortalBox(t)
	box.a.State.Update(func(s *state.Snapshot) {
		s.ControlEnabled = true
		s.ControlCertified = true
		s.Control = &state.ControlInfo{
			ControlEnabled: true, Certified: true,
			Registers: []state.ControlRegister{{Addr: 0x00e7, Role: "export_limit"}},
		}
	})
	seen := make(chan installerBusRequest, 4)
	before, after := 1, 2
	registerStub(t, box.addr, seen, func(installerBusRequest) installerBusResult {
		return installerBusResult{OK: true, Before: &before, After: &after, Wrote: true}
	})
	installerStub(t, box.addr, nil, func(installerBusRequest) installerBusResult {
		t.Error("das gesperrte Register darf den Wechselrichter nie erreichen")
		return installerBusResult{}
	})

	// Auf der primaeren Lane: gesperrt.
	box.a.onRegisterWrite(box.order(t, "lesen", "0011223344556677", nil))
	if res := box.await(t); res.OK || res.ErrorCode != registerwrite.ErrRefusedControlOwned {
		t.Fatalf("die laufende Steuerung besitzt 0x00E7: %+v", res)
	}
	// DIESELBE Adresse auf einem fremden Geraet im LAN: frei.
	box.a.onRegisterWrite(box.order(t, "schreiben", "7766554433221100", map[string]any{
		"target":  map[string]any{"kind": "lan", "host": "192.168.0.77"},
		"value":   2,
		"confirm": "0X00E7=2",
	}))
	if res := box.await(t); !res.OK {
		t.Fatalf("ein fremdes Geraet teilt keine Register mit unserer Steuerung: %+v", res)
	}
	if req := <-seen; req.Host != "192.168.0.77" {
		t.Fatalf("der Auftrag ging ans richtige Geraet: %+v", req)
	}
}

// regReqID mints a DISTINCT correlation id in the contract's shape
// (^[0-9a-f]{16,64}$) - the replay guard would otherwise refuse the second call
// of a loop.
func regReqID(i int) string {
	return fmt.Sprintf("abcdef0123456%03d", i)
}
