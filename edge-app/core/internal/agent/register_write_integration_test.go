package agent

// ⚠ DIE ADRESSIERUNG, END ZU ENDE - das Gelenk, das in KEINEM der beiden
// Häuser geprüft war (Produktionsvorfall 20.08.2026).
//
// Die vorhandenen Beweise dieses Kanals fassen den TOPIC nie an:
//
//	Go    `agent/register_write_test.go` ruft `a.onRegisterWrite(payload)`
//	      DIREKT auf - das Abonnement des Cloud-Links kommt darin nicht vor.
//	Java  der Geräte-Stellvertreter in `RegisterWriteApiTest` abonniert die
//	      WILDCARD `ems/+/+/+/v2/register-write` und antwortet auf `topic +
//	      "-result"`, echot also jede Adresse zurück, die er bekommt.
//
// Beides zusammen heißt: ein Auftrag, der auf dem Pfad eines ANDEREN Geräts
// landet, wäre in beiden Suiten grün geblieben - und im Feld hätte niemand
// zugehört. Dieser Test schließt das Gelenk auf der Geräteseite: er fährt den
// ECHTEN Agenten gegen einen ECHTEN Broker und veröffentlicht den Auftrag auf
// dem Topic, das der Kontrakt (und damit der api-Publisher) baut.
//
// ⚠ ANTI-KOINZIDENZ-REGEL: Mandant, Anlage und Gerät sind DREI VERSCHIEDENE
// Kennungen, und der Gegenprobe-Auftrag trägt eine VIERTE. Ein Aufbau, in dem
// zwei davon zusammenfallen, kann eine vertauschte Kennung nicht sehen.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"
	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/hooks/auth"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/mochi-mqtt/server/v2/packets"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
)

// regTopic baut den Auftrags-Pfad WÖRTLICH so, wie ihn der Kontrakt
// (docs/contracts/mqtt-register-write.schema.json) und der api-Publisher
// bauen - bewusst als Literal, nicht über eine Hilfsfunktion des Codes unter
// Test: ein Test, der den Pfad aus derselben Quelle wie der Prüfling ableitet,
// prüft ihn nicht.
func regTopic(tenant, site, device string) string {
	return "ems/" + tenant + "/" + site + "/" + device + "/v2/register-write"
}

// regBroker ist ein Stellvertreter der Cloud, der die Quittungen MIT IHREM
// TOPIC einsammelt.
type regBroker struct {
	t      *testing.T
	server *mochi.Server
	addr   string

	mu      sync.Mutex
	results map[string]string // topic -> payload
}

func startRegBroker(t *testing.T) *regBroker {
	t.Helper()
	rb := &regBroker{t: t, addr: fmt.Sprintf("127.0.0.1:%d", freePort(t)),
		results: map[string]string{}}
	rb.server = mochi.New(&mochi.Options{InlineClient: true})
	if err := rb.server.AddHook(new(auth.AllowHook), nil); err != nil {
		t.Fatal(err)
	}
	if err := rb.server.AddListener(
		listeners.NewTCP(listeners.Config{ID: "reg-cloud", Address: rb.addr})); err != nil {
		t.Fatal(err)
	}
	// Die WILDCARD steht hier auf der CLOUD-Seite, wo sie hingehört: der
	// Zuhörer der api abonniert sie genauso, und nur so sieht der Test auch
	// eine Antwort auf einem FALSCHEN Pfad.
	if err := rb.server.Subscribe("ems/+/+/+/v2/register-write-result", 91,
		func(_ *mochi.Client, _ packets.Subscription, pk packets.Packet) {
			rb.mu.Lock()
			rb.results[pk.TopicName] = string(pk.Payload)
			rb.mu.Unlock()
		}); err != nil {
		t.Fatal(err)
	}
	go func() { _ = rb.server.Serve() }()
	t.Cleanup(func() { _ = rb.server.Close() })
	return rb
}

// order publiziert einen Auftrag NICHT-retained, genau wie der api-Publisher.
func (rb *regBroker) order(topic string, payload []byte) {
	if err := rb.server.Publish(topic, payload, false, 1); err != nil {
		rb.t.Fatal(err)
	}
}

func (rb *regBroker) resultOn(topic string) string {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	return rb.results[topic]
}

// resultTopics ist die Momentaufnahme unter der Sperre - der Test liest die
// Karte nie direkt, auch nicht im Fehlerpfad.
func (rb *regBroker) resultTopics() []string {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	out := make([]string, 0, len(rb.results))
	for topic := range rb.results {
		out = append(out, topic)
	}
	return out
}

// regOrder baut den Umschlag in der Form des Kontrakts, mit FRISCHEM
// requested_at (das Fenster zählt ab diesem Stempel, nicht ab der Ankunft).
func regOrder(tenant, site, device, requestID, host string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0",
		"type":           "register_write_request",
		"tenant_id":      tenant,
		"site_id":        site,
		"device_id":      device,
		"request_id":     requestID,
		"requested_at":   time.Now().UTC().Format(time.RFC3339Nano),
		"requested_by":   "8f1c0a2e-5b3d-4f77-9a10-2c6b7d9e1f04",
		"mode":           "lesen",
		"target":         map[string]any{"kind": "lan", "host": host, "port": 502, "unit_id": 1},
		"register":       map[string]any{"kind": "holding", "address": 231},
	})
	return raw
}

// TestThePortalOrderIsAnsweredOnlyOnThisBoxesOwnTopic fährt die GANZE Kette:
// Cloud-Topic -> Abonnement -> Identität -> Lane -> Politik -> lokaler Bus ->
// Quittung auf dem EIGENEN Ergebnis-Topic.
func TestThePortalOrderIsAnsweredOnlyOnThisBoxesOwnTopic(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}

	rb := startRegBroker(t)

	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.LocalMQTTAddr = fmt.Sprintf("127.0.0.1:%d", freePort(t))
	cfg.DevTenantID, cfg.DevSiteID, cfg.DevDeviceID = tTenant, tSite, tDevice
	cfg.DevCloudURL = "tcp://" + rb.addr
	cfg.SetpointInterval = time.Second
	cfg.SetpointIntervalSeconds = 1

	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer a.Stop()

	waitFor(t, 15*time.Second, "cloud connected", func() bool {
		return a.State.Get().CloudConnected
	})

	// Der Stellvertreter von Layer 1: er beantwortet den Einmal-Schreibauftrag
	// auf dem lokalen Bus, so wie es der Palette-Knoten `vp-register-write`
	// tut.
	bus := pahoClient(t, cfg.LocalMQTTAddr, "regwrite-node")
	if tok := bus.Subscribe("edge/register-write/request", 1,
		func(_ pahomqtt.Client, msg pahomqtt.Message) {
			var req struct {
				RequestID string `json:"request_id"`
			}
			_ = json.Unmarshal(msg.Payload(), &req)
			answer, _ := json.Marshal(map[string]any{
				"request_id": req.RequestID, "ok": true,
				"before": 3300, "after": nil, "wrote": false,
			})
			bus.Publish("edge/register-write/result", 1, false, answer)
		}); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}

	own := regTopic(tTenant, tSite, tDevice)
	rb.order(own, regOrder(tTenant, tSite, tDevice, "aa11bb22cc33dd44", "192.168.0.28"))

	waitFor(t, 20*time.Second, "die Quittung auf dem EIGENEN Ergebnis-Topic", func() bool {
		return rb.resultOn(own+"-result") != ""
	})
	got := rb.resultOn(own + "-result")
	if !strings.Contains(got, `"before_raw":3300`) || !strings.Contains(got, `"ok":true`) {
		t.Fatalf("die Quittung trägt nicht den gelesenen Ist-Wert: %s", got)
	}

	// --- Gegenprobe: ein FREMDES Gerät ---------------------------------
	// Eine VIERTE Kennung, wohlgeformt und in sich stimmig - der Auftrag ist
	// nur nicht für diese Box. Er darf NICHTS auslösen.
	foreign := "00000000-0000-0000-0000-0000000000ff"
	before := len(rb.resultTopics())
	rb.order(regTopic(tTenant, tSite, foreign),
		regOrder(tTenant, tSite, foreign, "aa11bb22cc33dd55", "192.168.0.28"))
	// Ein bewusstes NEGATIV-Warten: es soll nichts passieren, und das lässt
	// sich nur durch Zusehen belegen.
	time.Sleep(2 * time.Second)
	if after := rb.resultTopics(); len(after) != before {
		t.Fatalf("ein Auftrag für ein fremdes Gerät wurde beantwortet: %v", after)
	}
}
