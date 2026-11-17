package cloud

// vp-entkoppelte-box-meldet-verbunden: eine Box, deren Anlage im Portal getrennt
// wurde, behält ihr Zertifikat (ein Wiederverbinden stellt auf denselben
// Schlüssel neu aus). Der Broker nimmt TLS und CONNECT deshalb weiter an, die
// Rechte auf ihre Topics sind aber entzogen (Default-Deny in acl.conf). Mit
// `deny_action = disconnect` (docker-compose.prod.yml) wirft EMQX sie beim
// ersten abgelehnten SUBSCRIBE hinaus. Paho meldet den Verlust (OnConnectionLost)
// und der eigene OnConnect-Rückruf meldete danach trotzdem noch „verbunden" -
// die Box edge-px6jphw stand so tagelang auf pairing_state "verbunden" /
// cloud_connected true, ohne TCP-Verbindung zum Broker (netstat) und ohne ein
// einziges PUBACK (box-event-outbox seit 12.11. unverändert).
//
// Die beiden Broker hier spielen die zwei EMQX-Antworten auf ein Abo ohne
// Recht nach: rauswerfen (Produktion) und SUBACK 0x80 (deny_action = ignore).

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/hooks/auth"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/mochi-mqtt/server/v2/packets"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
)

// rauswurfHook ahmt EMQX mit deny_action = disconnect für ein Gerät ohne
// Grant nach: CONNECT wird angenommen (das Zertifikat ist ja gültig), das
// erste SUBSCRIBE beendet die Verbindung ohne SUBACK. Nur die erste Verbindung
// wird angenommen - so endet der Test in einem ruhigen Zustand, in dem die
// Box nachweislich NICHT verbunden ist.
type rauswurfHook struct {
	mochi.HookBase
	verbindungen atomic.Int32
}

func (h *rauswurfHook) ID() string { return "rauswurf-bei-abgelehntem-abo" }

func (h *rauswurfHook) Provides(b byte) bool {
	return b == mochi.OnConnectAuthenticate || b == mochi.OnACLCheck || b == mochi.OnSubscribe
}

func (h *rauswurfHook) OnConnectAuthenticate(_ *mochi.Client, _ packets.Packet) bool {
	return h.verbindungen.Add(1) == 1
}

func (h *rauswurfHook) OnACLCheck(_ *mochi.Client, _ string, _ bool) bool { return false }

func (h *rauswurfHook) OnSubscribe(cl *mochi.Client, pk packets.Packet) packets.Packet {
	cl.Stop(packets.ErrNotAuthorized)
	return pk
}

// ablehnHook ahmt EMQX mit deny_action = ignore nach: Verbindung bleibt, jedes
// Abo bekommt SUBACK 0x80 (MQTT 3.1.1), jedes PUBLISH wird verworfen.
type ablehnHook struct{ mochi.HookBase }

func (h *ablehnHook) ID() string { return "abo-abgelehnt" }

func (h *ablehnHook) Provides(b byte) bool {
	return b == mochi.OnConnectAuthenticate || b == mochi.OnACLCheck
}

func (h *ablehnHook) OnConnectAuthenticate(_ *mochi.Client, _ packets.Packet) bool { return true }

func (h *ablehnHook) OnACLCheck(_ *mochi.Client, _ string, _ bool) bool { return false }

func brokerMit(t *testing.T, hook mochi.Hook) string {
	t.Helper()
	addr := fmt.Sprintf("127.0.0.1:%d", freeTestPort(t))
	s := mochi.New(&mochi.Options{InlineClient: true})
	if err := s.AddHook(hook, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.AddListener(listeners.NewTCP(listeners.Config{ID: hook.ID(), Address: addr})); err != nil {
		t.Fatal(err)
	}
	go func() { _ = s.Serve() }()
	t.Cleanup(func() { _ = s.Close() })
	return addr
}

// verbindungsProtokoll sammelt jede OnConnect-Meldung des Links in Reihenfolge.
type verbindungsProtokoll struct {
	mu      sync.Mutex
	meldung []bool
}

func (p *verbindungsProtokoll) melde(v bool) {
	p.mu.Lock()
	p.meldung = append(p.meldung, v)
	p.mu.Unlock()
}

func (p *verbindungsProtokoll) alle() []bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]bool(nil), p.meldung...)
}

func linkGegen(t *testing.T, addr string, p *verbindungsProtokoll) *Link {
	t.Helper()
	l, err := New(Options{
		Identity:    enroll.Identity{TenantID: testTenant, SiteID: testSite, DeviceID: testDevice},
		DevURL:      "tcp://" + addr,
		DevClientID: "vp-zugang-entzogen",
		OnSchedule:  func([]byte) {},
		OnConnect:   p.melde,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.Close)
	l.Connect()
	return l
}

// Produktion: Broker wirft beim abgelehnten Abo hinaus. Der Link darf danach
// nie „verbunden" als letzte Meldung stehen lassen - die Box ist es nicht.
func TestRauswurfBeimAboEndetNichtAufVerbunden(t *testing.T) {
	for i := 0; i < 5; i++ { // die Reihenfolge der beiden Paho-Rückrufe ist nicht festgelegt
		p := &verbindungsProtokoll{}
		l := linkGegen(t, brokerMit(t, &rauswurfHook{}), p)

		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) && len(p.alle()) == 0 {
			time.Sleep(10 * time.Millisecond)
		}
		// Die Box ist hinausgeworfen und kommt nicht wieder hinein: der Zustand
		// muss sich auf „nicht verbunden" setzen und dort bleiben.
		time.Sleep(700 * time.Millisecond)
		if l.Connected() {
			t.Fatal("Testaufbau: der Broker hätte die Verbindung beenden müssen")
		}
		m := p.alle()
		if len(m) > 0 && m[len(m)-1] {
			t.Fatalf("Lauf %d: letzte Meldung ist „verbunden\", obwohl der Broker die Box hinausgeworfen hat: %v", i, m)
		}
		for _, v := range m {
			if v {
				t.Fatalf("Lauf %d: „verbunden\" gemeldet, obwohl der Broker kein einziges Abo angenommen hat: %v", i, m)
			}
		}
	}
}

// deny_action = ignore: Verbindung offen, aber jedes Abo mit 0x80 abgelehnt.
// Das ist kein „verbunden" - die Plattform nimmt von dieser Box nichts an.
func TestAlleAbosAbgelehntIstNichtVerbunden(t *testing.T) {
	p := &verbindungsProtokoll{}
	l := linkGegen(t, brokerMit(t, &ablehnHook{}), p)

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !l.Connected() {
		time.Sleep(10 * time.Millisecond)
	}
	if !l.Connected() {
		t.Fatal("Testaufbau: die Verbindung selbst muss stehen")
	}
	time.Sleep(500 * time.Millisecond)
	for _, v := range p.alle() {
		if v {
			t.Fatalf("„verbunden\" gemeldet, obwohl der Broker jedes Abo abgelehnt hat: %v", p.alle())
		}
	}
}

// Gegenprobe: mit Rechten bleibt alles wie bisher - genau eine Meldung
// „verbunden", sobald die Abos stehen.
func TestMitRechtenMeldetDerLinkVerbunden(t *testing.T) {
	addr := fmt.Sprintf("127.0.0.1:%d", freeTestPort(t))
	s := mochi.New(&mochi.Options{InlineClient: true})
	if err := s.AddHook(new(auth.AllowHook), nil); err != nil {
		t.Fatal(err)
	}
	if err := s.AddListener(listeners.NewTCP(listeners.Config{ID: "mit-rechten", Address: addr})); err != nil {
		t.Fatal(err)
	}
	go func() { _ = s.Serve() }()
	t.Cleanup(func() { _ = s.Close() })

	p := &verbindungsProtokoll{}
	linkGegen(t, addr, p)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && len(p.alle()) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if m := p.alle(); len(m) != 1 || !m[0] {
		t.Fatalf("mit Rechten: genau eine Meldung „verbunden\" erwartet, bekam %v", m)
	}
}
