package cloud

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"

	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/packets"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
)

// The receipt goes RETAINED on the box's own v2 subtree with the identity of
// the link; a rejection carries its word and the stand the box keeps.
func TestAnteileResultRetainedAufEigenemTopic(t *testing.T) {
	sink := startStatusSink(t)
	type got struct {
		topic    string
		retained bool
		payload  map[string]any
	}
	ch := make(chan got, 4)
	if err := sink.server.Subscribe("ems/+/+/+/v2/verbund-anteile-result", 2,
		func(_ *mochi.Client, _ packets.Subscription, pk packets.Packet) {
			var m map[string]any
			_ = json.Unmarshal(pk.Payload, &m)
			ch <- got{pk.TopicName, pk.FixedHeader.Retain, m}
		}); err != nil {
		t.Fatal(err)
	}
	link := connectedLink(t, sink, "anteile-result")
	at := time.Date(2027, 10, 20, 9, 0, 5, 0, time.UTC)
	if err := link.PublishAnteileResult(AnteileResult{Epoche: 1, Revision: 8, Angenommen: true,
		Wirksam: &AnteileStand{1, 8}, At: at}); err != nil {
		t.Fatal(err)
	}
	if err := link.PublishAnteileResult(AnteileResult{Epoche: 1, Revision: 7, Grund: "revision_aelter",
		Wirksam: &AnteileStand{1, 9}, At: at}); err != nil {
		t.Fatal(err)
	}
	want := "ems/" + testTenant + "/" + testSite + "/" + testDevice + "/v2/verbund-anteile-result"
	for i, expect := range []string{
		`{"device_id":"` + testDevice + `","epoche":1,"revision":8,"schema_version":"1.0","site_id":"` + testSite +
			`","tenant_id":"` + testTenant + `","ts":"2027-10-20T09:00:05Z","urteil":"angenommen","wirksam":{"epoche":1,"revision":8}}`,
		`{"device_id":"` + testDevice + `","epoche":1,"grund":"revision_aelter","revision":7,"schema_version":"1.0","site_id":"` +
			testSite + `","tenant_id":"` + testTenant + `","ts":"2027-10-20T09:00:05Z","urteil":"abgelehnt","wirksam":{"epoche":1,"revision":9}}`,
	} {
		select {
		case g := <-ch:
			raw, _ := json.Marshal(g.payload)
			if g.topic != want || !g.retained || string(raw) != expect {
				t.Fatalf("receipt %d: %s retained=%v %s; want %s", i, g.topic, g.retained, raw, expect)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("receipt %d never arrived", i)
		}
	}
}

// Go side of the quittungen group of verbund-anteile-mqtt-vectors.json: every
// receipt the cloud accepts is exactly what the box builds for that verdict;
// every receipt the cloud drops is one the box cannot build - either the
// builder refuses it, or its shape is fixed by the link (identity, version,
// the two verdict words).
func TestAnteileQuittungenWieDieVektoren(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/contracts/v2/verbund-anteile-mqtt-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Kennungen  map[string]string `json:"kennungen"`
		Quittungen []struct {
			Name     string         `json:"name"`
			TopicBox string         `json:"topic_box"`
			Nutzlast map[string]any `json:"nutzlast"`
			Erwartet struct {
				Gueltig bool `json:"gueltig"`
			} `json:"erwartet"`
		} `json:"quittungen"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	gueltig, verweigert, unbaubar := 0, 0, 0
	for _, c := range v.Quittungen {
		link, err := New(Options{Identity: enroll.Identity{TenantID: v.Kennungen["tenant"],
			SiteID: v.Kennungen["site"], DeviceID: c.TopicBox}, DevURL: "tcp://127.0.0.1:1"})
		if err != nil {
			t.Fatal(err)
		}
		n := c.Nutzlast
		r := AnteileResult{Epoche: int64(n["epoche"].(float64)), Revision: int64(n["revision"].(float64)),
			Angenommen: n["urteil"] == "angenommen"}
		r.At, _ = time.Parse(time.RFC3339, n["ts"].(string))
		if g, ok := n["grund"].(string); ok {
			r.Grund = g
		}
		if w, ok := n["wirksam"].(map[string]any); ok {
			r.Wirksam = &AnteileStand{int64(w["epoche"].(float64)), int64(w["revision"].(float64))}
		}
		baubar := n["schema_version"] == "1.0" && n["device_id"] == c.TopicBox &&
			(n["urteil"] == "angenommen" || n["urteil"] == "abgelehnt")
		payload, err := link.AnteileResultPayload(r)
		switch {
		case c.Erwartet.Gueltig:
			if err != nil {
				t.Fatalf("%s: %v", c.Name, err)
			}
			var got map[string]any
			_ = json.Unmarshal(payload, &got)
			if !reflect.DeepEqual(got, n) {
				t.Fatalf("%s: box builds %v, vector %v", c.Name, got, n)
			}
			gueltig++
		case !baubar:
			unbaubar++ // identity, version and verdict word come from the link, never from input
		case err == nil:
			t.Fatalf("%s: the cloud drops this receipt, the box built it: %s", c.Name, payload)
		default:
			verweigert++
		}
	}
	if gueltig != 5 || verweigert != 4 || unbaubar != 3 {
		t.Fatalf("quittungen: %d gueltig, %d verweigert, %d unbaubar - Vektor-Datei gewachsen, pruefen",
			gueltig, verweigert, unbaubar)
	}
}

// The share document is a retained downlink on the box's own v2 subtree; an
// EMPTY retained message reaches the handler too (it decides to keep the
// share), exactly like v2/plan. Without the handler there is no route.
func TestVerbundAnteileRouteNurMitHandler(t *testing.T) {
	var got [][]byte
	link, err := New(Options{Identity: enroll.Identity{TenantID: testTenant, SiteID: testSite, DeviceID: testDevice},
		DevURL: "tcp://127.0.0.1:1", OnVerbundAnteile: func(p []byte) { got = append(got, p) }})
	if err != nil {
		t.Fatal(err)
	}
	want := link.topic("v2/verbund-anteile")
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
	if len(got) != 2 || len(got[1]) != 0 {
		t.Fatalf("handler saw %q, want the document and the empty retained message", got)
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

// The share fields exist only with a held document; a block with IP-10 fields
// alone marshals byte for byte as before.
func TestHerzschlagBlockMitAnteilen(t *testing.T) {
	age, e, r := 4, int64(1), int64(9)
	ip10 := GemeinsameSteuerung{PlanID: "4711aaaa-0000-4000-8000-000000004711",
		Waechter: &Waechter{Einspeisung: "regelt"}, MesspunktAlterS: &age}
	raw, _ := json.Marshal(ip10)
	if string(raw) != `{"plan_id":"4711aaaa-0000-4000-8000-000000004711","waechter":{"einspeisung":"regelt"},"messpunkt_alter_s":4}` {
		t.Fatalf("IP-10 block changed: %s", raw)
	}
	nurAnteile := GemeinsameSteuerung{Rolle: "steuert_mit", AnteileEpoche: &e, AnteileRevision: &r,
		AnteileKw: &AnteileKw{Einspeisung: "90.0", Bezug: "77.0"}}
	raw, _ = json.Marshal(nurAnteile)
	if string(raw) != `{"rolle":"steuert_mit","anteile_revision":9,"anteile_epoche":1,"anteile_kw":{"einspeisung":90.0,"bezug":77.0}}` {
		t.Fatalf("share block: %s", raw)
	}
}
