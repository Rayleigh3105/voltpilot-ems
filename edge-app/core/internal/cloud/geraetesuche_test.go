package cloud

// The device search on the link (docs/contracts/v2/mqtt-geraetesuche.md §1):
// the order route exists only with a handler and never delivers an empty
// payload; progress and result go NOT retained to the box's own topics with
// the link's identity; and the chargers block goes out for a knocking station
// alone (docs/contracts/ocpp-klopft-an.md).

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/packets"
)

func TestGeraetesucheRouteNurMitHandlerUndNieLeer(t *testing.T) {
	var got [][]byte
	link, err := New(Options{Identity: enroll.Identity{TenantID: testTenant, SiteID: testSite, DeviceID: testDevice},
		DevURL: "tcp://127.0.0.1:1", OnGeraetesuche: func(p []byte) { got = append(got, p) }})
	if err != nil {
		t.Fatal(err)
	}
	want := link.topic("v2/geraetesuche")
	var route *downlinkRoute
	for i := range link.downlinks {
		if link.downlinks[i].topic == want {
			route = &link.downlinks[i]
		}
	}
	if route == nil {
		t.Fatalf("no route for %s", want)
	}
	route.handler(nil, &commandAckMessage{payload: []byte(`{"schema_version":"1.0"}`)})
	route.handler(nil, &commandAckMessage{payload: nil})
	if len(got) != 1 {
		t.Fatalf("handler saw %q, want the order only", got)
	}
	bare, err := New(Options{Identity: enroll.Identity{TenantID: testTenant, SiteID: testSite, DeviceID: testDevice},
		DevURL: "tcp://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range bare.downlinks {
		if r.topic == want {
			t.Fatal("route registered without a handler")
		}
	}
}

func TestGeraetesucheStandUndErgebnisNichtRetainedMitEigenerIdentitaet(t *testing.T) {
	sink := startStatusSink(t)
	type got struct {
		topic    string
		retained bool
		payload  map[string]any
	}
	ch := make(chan got, 4)
	if err := sink.server.Subscribe("ems/+/+/+/v2/#", 4, func(_ *mochi.Client, _ packets.Subscription, pk packets.Packet) {
		var m map[string]any
		_ = json.Unmarshal(pk.Payload, &m)
		ch <- got{pk.TopicName, pk.FixedHeader.Retain, m}
	}); err != nil {
		t.Fatal(err)
	}
	link := connectedLink(t, sink, "geraetesuche")
	ts := time.Date(2026, 11, 2, 9, 0, 2, 0, time.UTC)
	such := "44444444-4444-4444-8444-444444444444"
	// A foreign identity in the struct never reaches the wire.
	if err := link.PublishGeraetesucheStand(geraetesuche.Stand{SchemaVersion: "1.0", TenantID: "fremd", SuchID: such,
		Nr: 1, Ts: ts, Schritt: "netze_bestimmen", Netze: []geraetesuche.Netz{}, Funde: []geraetesuche.Fund{}}); err != nil {
		t.Fatal(err)
	}
	if err := link.PublishGeraetesucheErgebnis(geraetesuche.Ergebnis{SchemaVersion: "1.0", SuchID: such, Ts: ts,
		Zustand: "abgelehnt", Grund: "lan_host_fehlt", Erkenner: []string{}, Netze: []geraetesuche.Netz{},
		Funde: []geraetesuche.Fund{}}); err != nil {
		t.Fatal(err)
	}
	base := "ems/" + testTenant + "/" + testSite + "/" + testDevice + "/v2/"
	for _, leaf := range []string{"geraetesuche-stand", "geraetesuche-ergebnis"} {
		select {
		case g := <-ch:
			if g.topic != base+leaf || g.retained || g.payload["tenant_id"] != testTenant ||
				g.payload["device_id"] != testDevice || g.payload["such_id"] != such {
				t.Fatalf("%s: %s retained=%v %v", leaf, g.topic, g.retained, g.payload)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s never arrived", leaf)
		}
	}
}

func TestKlopfendeSaeuleAlleinSendetDenLadeBlock(t *testing.T) {
	sink := startStatusSink(t)
	link := connectedLink(t, sink, "klopft-an")
	k := geraetesuche.KlopftAn{ID: "CP-HALLE1", IP: "192.168.178.80", Attempts: 3,
		FirstSeen: time.Date(2026, 11, 2, 8, 10, 0, 0, time.UTC), LastSeen: time.Date(2026, 11, 2, 8, 59, 30, 0, time.UTC)}
	sum := &ChargersSummary{ReportedAt: "2026-11-02T09:00:00Z", Chargers: []ChargerEntry{},
		Rejected: []geraetesuche.KlopftAn{k}}
	if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, sum); err != nil {
		t.Fatal(err)
	}
	block, ok := sink.last(t)["chargers"].(map[string]any)
	if !ok {
		t.Fatal("a knock alone sent no chargers block")
	}
	rejected := block["rejected"].([]any)
	if len(rejected) != 1 || rejected[0].(map[string]any)["id"] != "CP-HALLE1" || len(block["chargers"].([]any)) != 0 {
		t.Fatalf("block: %v", block)
	}
	// Neither a station nor a knock: the heartbeat stays as it was.
	if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		&ChargersSummary{Chargers: []ChargerEntry{}, Rejected: []geraetesuche.KlopftAn{}}); err != nil {
		t.Fatal(err)
	}
	if _, ok := sink.last(t)["chargers"]; ok {
		t.Fatal("an empty block went out")
	}
}
