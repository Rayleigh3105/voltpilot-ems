package cloud

// The status-heartbeat WIRE SHAPE of OTA Stufe 0 (scout vp-ota-rollout-h4
// §2.3/§5), proven against a real in-process broker rather than by inspecting
// a struct: the fleet view is only as honest as the bytes that actually leave
// the device.
//
// The hole these tests nail shut: `core_version` used to ride ONLY inside the
// `flows` ack block, which the edge does not build before its first flow
// deployment - so a box on which no automation was ever rolled out reported no
// version at all and the platform could not tell "old" from "unknown".

import (
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/hooks/auth"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/mochi-mqtt/server/v2/packets"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
)

const (
	testTenant = "00000000-0000-0000-0000-000000000001"
	testSite   = "00000000-0000-0000-0000-000000000002"
	testDevice = "00000000-0000-0000-0000-000000000003"
)

// statusSink is an in-process broker collecting everything the device
// publishes on its status topic.
type statusSink struct {
	server *mochi.Server
	addr   string

	mu   sync.Mutex
	msgs [][]byte
}

func startStatusSink(t *testing.T) *statusSink {
	t.Helper()
	s := &statusSink{addr: fmt.Sprintf("127.0.0.1:%d", freeTestPort(t))}
	s.server = mochi.New(&mochi.Options{InlineClient: true})
	if err := s.server.AddHook(new(auth.AllowHook), nil); err != nil {
		t.Fatal(err)
	}
	if err := s.server.AddListener(
		listeners.NewTCP(listeners.Config{ID: "status-sink", Address: s.addr})); err != nil {
		t.Fatal(err)
	}
	if err := s.server.Subscribe("ems/+/+/+/status", 1,
		func(_ *mochi.Client, _ packets.Subscription, pk packets.Packet) {
			s.mu.Lock()
			s.msgs = append(s.msgs, append([]byte(nil), pk.Payload...))
			s.mu.Unlock()
		}); err != nil {
		t.Fatal(err)
	}
	go func() { _ = s.server.Serve() }()
	t.Cleanup(func() { _ = s.server.Close() })
	return s
}

// last waits briefly for the newest published status and decodes it.
func (s *statusSink) last(t *testing.T) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		n := len(s.msgs)
		var raw []byte
		if n > 0 {
			raw = s.msgs[n-1]
		}
		s.mu.Unlock()
		if raw != nil {
			var out map[string]any
			if err := json.Unmarshal(raw, &out); err != nil {
				t.Fatalf("status payload is not JSON: %v", err)
			}
			return out
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("no status heartbeat arrived")
	return nil
}

func freeTestPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// connectedLink builds a link against the sink over the dev (plain MQTT) path
// and waits for the connection.
func connectedLink(t *testing.T, s *statusSink, version string) *Link {
	t.Helper()
	l, err := New(Options{
		Identity: enroll.Identity{
			TenantID: testTenant, SiteID: testSite, DeviceID: testDevice,
		},
		DevURL:      "tcp://" + s.addr,
		DevClientID: "vp-status-test-" + version,
		Version:     version,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.Close)
	l.Connect()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if l.Connected() {
			return l
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("link did not connect to the in-process broker")
	return nil
}

// TestHeartbeatCarriesTheVersionWithoutAnyFlowsBlock is the regression guard
// for OTA Stufe 0 hole 1: a device that has NEVER seen a flow deployment (so
// `flows` is nil, exactly as flowdeploy.Summary() returns before the first
// set) must still report which build it runs.
func TestHeartbeatCarriesTheVersionWithoutAnyFlowsBlock(t *testing.T) {
	sink := startStatusSink(t)
	link := connectedLink(t, sink, "edge-2026.08.0+3bf8c0380000")

	if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil,
		&UpdateSummary{Backend: UpdateBackendCompose,
			Current: "edge-2026.08.0+3bf8c0380000", State: UpdateStateIdle}, nil, nil); err != nil {
		t.Fatal(err)
	}

	got := sink.last(t)
	if _, ok := got["flows"]; ok {
		t.Fatal("this test is vacuous if the heartbeat carries a flows block")
	}
	if got["version"] != "edge-2026.08.0+3bf8c0380000" {
		t.Fatalf("top-level version = %v, want the build stamp", got["version"])
	}

	upd, ok := got["update"].(map[string]any)
	if !ok {
		t.Fatalf("update block missing: %v", got["update"])
	}
	if upd["backend"] != "compose" || upd["state"] != "idle" {
		t.Fatalf("update block = %v, want backend compose / state idle", upd)
	}
	if upd["current"] != "edge-2026.08.0+3bf8c0380000" {
		t.Fatalf("update.current = %v, want the stamped version VERBATIM", upd["current"])
	}
	// Everything the box cannot honestly know stays ABSENT - the cloud orders
	// releases by its register's release_seq, and a fabricated number here
	// would corrupt exactly that ordering.
	for _, absent := range []string{"current_seq", "target", "target_seq", "channel",
		"last_known_good", "reason"} {
		if _, ok := upd[absent]; ok {
			t.Fatalf("update.%s must be omitted in Stufe 0, got %v", absent, upd[absent])
		}
	}
}

// TestHeartbeatCarriesTheVersionAlongsideTheFlowsBlock proves the two paths
// coexist: the `flows` ack keeps its own core_version (an older cloud reads
// it), and the top-level field is not conditioned on it.
func TestHeartbeatCarriesTheVersionAlongsideTheFlowsBlock(t *testing.T) {
	sink := startStatusSink(t)
	link := connectedLink(t, sink, "edge-2026.08.0+3bf8c0380000")

	flows := &FlowsSummary{
		PaletteVersion: "0.3.0",
		CoreVersion:    "edge-2026.08.0+3bf8c0380000",
		Applied:        []AppliedFlow{},
	}
	if err := link.PublishStatus("schedule", nil, nil, nil, flows, nil, nil, nil,
		&UpdateSummary{Backend: UpdateBackendCompose,
			Current: "edge-2026.08.0+3bf8c0380000", State: UpdateStateIdle}, nil, nil); err != nil {
		t.Fatal(err)
	}

	got := sink.last(t)
	if got["version"] != "edge-2026.08.0+3bf8c0380000" {
		t.Fatalf("top-level version = %v", got["version"])
	}
	fl, ok := got["flows"].(map[string]any)
	if !ok {
		t.Fatalf("flows block missing: %v", got["flows"])
	}
	if fl["core_version"] != "edge-2026.08.0+3bf8c0380000" {
		t.Fatalf("the flows ack must keep its core_version, got %v", fl["core_version"])
	}
}

// TestHeartbeatOmitsAnUnknownVersionInsteadOfSendingAnEmptyOne: a link built
// without a build stamp reports nothing rather than an empty string - the
// cloud must be able to tell "unbekannt" from "a version called ”".
func TestHeartbeatOmitsAnUnknownVersionInsteadOfSendingAnEmptyOne(t *testing.T) {
	sink := startStatusSink(t)
	link := connectedLink(t, sink, "")

	if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil); err != nil {
		t.Fatal(err)
	}

	got := sink.last(t)
	if _, ok := got["version"]; ok {
		t.Fatalf("an unknown version must be omitted, got %v", got["version"])
	}
	if _, ok := got["update"]; ok {
		t.Fatalf("a nil update block must be omitted, got %v", got["update"])
	}
	// The rest of the heartbeat is untouched - an older cloud parses it exactly
	// as before.
	if got["device_id"] != testDevice || got["online"] != true {
		t.Fatalf("base heartbeat changed shape: %v", got)
	}
}

// TestPublishUpdateStateIsTheDurableTransitionReport pins the groundwork path:
// it carries identity + version + the update block and returns only after the
// QoS1 ack, so `applying` can be reported as the LAST act before the stack
// stops (scout vp-ota-rollout-h4 §5). Nothing calls it in Stufe 0.
func TestPublishUpdateStateIsTheDurableTransitionReport(t *testing.T) {
	sink := startStatusSink(t)
	link := connectedLink(t, sink, "edge-2026.08.0+3bf8c0380000")

	if err := link.PublishUpdateState(UpdateSummary{
		Backend: UpdateBackendCompose,
		Current: "edge-2026.07.2+665d59b80000",
		Target:  "edge-2026.08.0",
		State:   UpdateStateApplying,
	}); err != nil {
		t.Fatal(err)
	}

	got := sink.last(t)
	if got["device_id"] != testDevice || got["tenant_id"] != testTenant {
		t.Fatalf("identity missing from the durable report: %v", got)
	}
	if got["version"] != "edge-2026.08.0+3bf8c0380000" {
		t.Fatalf("version = %v", got["version"])
	}
	upd, ok := got["update"].(map[string]any)
	if !ok {
		t.Fatalf("update block missing: %v", got["update"])
	}
	if upd["state"] != "applying" || upd["target"] != "edge-2026.08.0" {
		t.Fatalf("update block = %v, want the applying transition", upd)
	}
}

// Der D6-Uplink: die Box meldet ihr eigenes Schreib-Audit - und eine Box, die
// nie geschrieben hat, sendet GAR KEINEN Block (ein leerer waere eine Aussage
// ueber einen Vorgang, den es nicht gab).
func TestHeartbeatCarriesTheRegisterWriteAuditOnlyWhenThereIsOne(t *testing.T) {
	sink := startStatusSink(t)
	link := connectedLink(t, sink, "edge-2026.08.1")

	if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil, nil, nil,
		&RegisterWritesSummary{}); err != nil {
		t.Fatal(err)
	}
	if _, ok := sink.last(t)["register_writes"]; ok {
		t.Fatal("ein leerer Block darf nicht gesendet werden")
	}

	before, after := 3300, 7000
	if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil, nil, nil,
		&RegisterWritesSummary{
			ReportedAt: "2026-08-19T14:05:00Z",
			Entries: []RegisterWriteEntry{{
				RequestID: "aabbccdd11223344", At: "2026-08-19T14:02:49Z",
				Register: "0x00e7", Before: &before, Requested: 7000, After: &after,
				Result: "applied", Source: "wartungszugang",
			}},
		}); err != nil {
		t.Fatal(err)
	}
	got := sink.last(t)
	block, ok := got["register_writes"].(map[string]any)
	if !ok {
		t.Fatalf("der Block fehlt: %v", got["register_writes"])
	}
	entries, ok := block["entries"].([]any)
	if !ok || len(entries) != 1 {
		t.Fatalf("genau ein Eintrag erwartet: %v", block["entries"])
	}
	e := entries[0].(map[string]any)
	if e["request_id"] != "aabbccdd11223344" || e["register"] != "0x00e7" {
		t.Fatalf("der Kreuz-Schluessel muss mitreisen: %v", e)
	}
	if e["before"].(float64) != 3300 || e["after"].(float64) != 7000 {
		t.Fatalf("Vorher/Nachher muessen mitreisen: %v", e)
	}
	if e["source"] != "wartungszugang" {
		t.Fatalf("die Herkunft muss den Trigger nennen: %v", e["source"])
	}
}
