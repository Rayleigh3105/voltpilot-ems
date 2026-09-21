package cloud

// AP-15 IP-21 on the link: the order route exists only with a handler and
// never delivers an empty payload (the order is not retained); the report goes
// NOT retained to the box's own .../v2/sprungprobe-result in exactly the shape
// uems/SprungprobeBericht#lesen accepts (docs/contracts/v2/mqtt-sprungprobe.md §3).

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sprungprobe"
	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/packets"
)

func TestSprungprobeRouteNurMitHandlerUndNieLeer(t *testing.T) {
	var got [][]byte
	link, err := New(Options{Identity: enroll.Identity{TenantID: testTenant, SiteID: testSite, DeviceID: testDevice},
		DevURL: "tcp://127.0.0.1:1", OnSprungprobe: func(p []byte) { got = append(got, p) }})
	if err != nil {
		t.Fatal(err)
	}
	want := link.topic("v2/sprungprobe")
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
		t.Fatalf("handler saw %q, want the order only - an empty message is no order", got)
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

func TestSprungprobeBerichtNichtRetainedAufEigenemTopic(t *testing.T) {
	sink := startStatusSink(t)
	type got struct {
		topic    string
		retained bool
		payload  []byte
	}
	ch := make(chan got, 2)
	if err := sink.server.Subscribe("ems/+/+/+/v2/sprungprobe-result", 3,
		func(_ *mochi.Client, _ packets.Subscription, pk packets.Packet) {
			ch <- got{pk.TopicName, pk.FixedHeader.Retain, append([]byte(nil), pk.Payload...)}
		}); err != nil {
		t.Fatal(err)
	}
	link := connectedLink(t, sink, "sprungprobe-result")
	von := time.Date(2027, 6, 13, 11, 0, 10, 0, time.UTC)
	vorher, waehrend := 55.0, 25.0
	b := sprungprobe.Bericht{ProbeID: "7c0f5e0a-0000-4000-8000-000000000021", Art: sprungprobe.ErzeugungSenken,
		Stellgroesse: "pv_kappe", Spruenge: []sprungprobe.Sprung{
			{Von: von, Bis: von.Add(60 * time.Second), VorherKw: &vorher, WaehrendKw: &waehrend},
			{Von: von.Add(120 * time.Second), Bis: von.Add(180 * time.Second), VorherKw: &vorher, WaehrendKw: nil}},
		Ts: von.Add(210 * time.Second)}
	if err := link.PublishSprungprobeResult(b); err != nil {
		t.Fatal(err)
	}
	want := "ems/" + testTenant + "/" + testSite + "/" + testDevice + "/v2/sprungprobe-result"
	select {
	case g := <-ch:
		var m map[string]any
		if err := json.Unmarshal(g.payload, &m); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(m)
		expect := `{"abgebrochen":false,"art":"erzeugung_senken","device_id":"` + testDevice +
			`","probe_id":"7c0f5e0a-0000-4000-8000-000000000021","schema_version":"1.0","site_id":"` + testSite +
			`","spruenge":[{"bis":"2027-06-13T11:01:10Z","von":"2027-06-13T11:00:10Z","vorher_kw":55,"waehrend_kw":25},` +
			`{"bis":"2027-06-13T11:03:10Z","von":"2027-06-13T11:02:10Z","vorher_kw":55,"waehrend_kw":null}],` +
			`"stellgroesse":"pv_kappe","tenant_id":"` + testTenant + `","ts":"2027-06-13T11:03:40Z"}`
		if g.topic != want || g.retained || string(raw) != expect {
			t.Fatalf("report: %s retained=%v %s; want %s", g.topic, g.retained, raw, expect)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("report never arrived")
	}
}

// A report the cloud would drop is one the box cannot build.
func TestSprungprobeBerichtDenDieCloudVerwirftGibtEsNicht(t *testing.T) {
	link := &Link{identity: enroll.Identity{TenantID: testTenant, SiteID: testSite, DeviceID: testDevice}}
	for name, b := range map[string]sprungprobe.Bericht{
		"grund ohne abbruch": {ProbeID: "p", Art: sprungprobe.ErzeugungSenken, Grund: "abgelaufen"},
		"abbruch ohne grund": {ProbeID: "p", Art: sprungprobe.ErzeugungSenken, Abgebrochen: true},
		"fremdes wort":       {ProbeID: "p", Art: sprungprobe.ErzeugungSenken, Abgebrochen: true, Grund: "zu_warm"},
		"ohne probe_id":      {Art: sprungprobe.ErzeugungSenken},
		"vier spruenge":      {ProbeID: "p", Art: sprungprobe.ErzeugungSenken, Spruenge: make([]sprungprobe.Sprung, 4)},
	} {
		if _, err := link.SprungprobeResultPayload(b); err == nil {
			t.Errorf("%s: built a report the cloud drops", name)
		}
	}
	raw, err := link.SprungprobeResultPayload(sprungprobe.Bericht{ProbeID: "p", Art: sprungprobe.VerbrauchSenken,
		Stellgroesse: "batterie_laden", Abgebrochen: true, Grund: sprungprobe.Einspeisewaechter,
		Ts: time.Date(2027, 6, 13, 11, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if m["grund"] != "einspeisewaechter" || m["abgebrochen"] != true || len(m["spruenge"].([]any)) != 0 {
		t.Fatalf("aborted report: %s", raw)
	}
}
