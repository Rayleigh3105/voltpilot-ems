package cloud

import (
	"encoding/json"
	"testing"
	"time"

	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/packets"
)

// The receipt goes RETAINED on the box's own v2 subtree with the identity of
// the link; a rejection carries its word, an acceptance never a grund.
func TestPlanResultRetainedAufEigenemTopic(t *testing.T) {
	sink := startStatusSink(t)
	type got struct {
		topic    string
		retained bool
		payload  map[string]any
	}
	ch := make(chan got, 4)
	if err := sink.server.Subscribe("ems/+/+/+/v2/plan-result", 2,
		func(_ *mochi.Client, _ packets.Subscription, pk packets.Packet) {
			var m map[string]any
			_ = json.Unmarshal(pk.Payload, &m)
			ch <- got{pk.TopicName, pk.FixedHeader.Retain, m}
		}); err != nil {
		t.Fatal(err)
	}
	link := connectedLink(t, sink, "plan-result")
	at := time.Date(2027, 6, 15, 8, 15, 3, 0, time.UTC)
	if err := link.PublishPlanResult(PlanResult{PlanID: "4711aaaa-0000-4000-8000-000000004711",
		GeneratedAt: "2027-06-15T08:15:00Z", Angenommen: true, At: at}); err != nil {
		t.Fatal(err)
	}
	if err := link.PublishPlanResult(PlanResult{Grund: "unlesbar", At: at}); err != nil {
		t.Fatal(err)
	}
	want := "ems/" + testTenant + "/" + testSite + "/" + testDevice + "/v2/plan-result"
	for i, expect := range []map[string]any{
		{"schema_version": "1.0", "tenant_id": testTenant, "site_id": testSite, "device_id": testDevice,
			"ts": "2027-06-15T08:15:03Z", "angenommen": true, "plan_id": "4711aaaa-0000-4000-8000-000000004711",
			"generated_at": "2027-06-15T08:15:00Z"},
		{"schema_version": "1.0", "tenant_id": testTenant, "site_id": testSite, "device_id": testDevice,
			"ts": "2027-06-15T08:15:03Z", "angenommen": false, "grund": "unlesbar"},
	} {
		select {
		case g := <-ch:
			raw, _ := json.Marshal(g.payload)
			exp, _ := json.Marshal(expect)
			if g.topic != want || !g.retained || string(raw) != string(exp) {
				t.Fatalf("receipt %d: %s retained=%v %s; want %s", i, g.topic, g.retained, raw, exp)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("receipt %d never arrived", i)
		}
	}
}

// The heartbeat carries gemeinsame_steuerung only when the agent hands one
// over; without it the key is absent (the old heartbeat shape).
func TestHerzschlagBlockNurWennGegeben(t *testing.T) {
	sink := startStatusSink(t)
	link := connectedLink(t, sink, "heartbeat-block")
	if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		StatusExtension{Supports: BuiltSupports()}); err != nil {
		t.Fatal(err)
	}
	if _, ok := sink.last(t)["gemeinsame_steuerung"]; ok {
		t.Fatal("block invented without a plan 2.0")
	}
	age := 4
	if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		StatusExtension{Supports: BuiltSupports(), GemeinsameSteuerung: &GemeinsameSteuerung{
			PlanID: "4711aaaa-0000-4000-8000-000000004711", Waechter: &Waechter{Einspeisung: "regelt"},
			MesspunktAlterS: &age}}); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		sink.mu.Lock()
		n := len(sink.msgs)
		sink.mu.Unlock()
		if n >= 2 {
			break
		}
	}
	wire := sink.last(t)
	raw, _ := json.Marshal(wire["gemeinsame_steuerung"])
	if string(raw) != `{"messpunkt_alter_s":4,"plan_id":"4711aaaa-0000-4000-8000-000000004711","waechter":{"einspeisung":"regelt"}}` ||
		wire["schema_version"] != "1.0" {
		t.Fatalf("heartbeat block: %s (%v)", raw, wire["schema_version"])
	}
}
