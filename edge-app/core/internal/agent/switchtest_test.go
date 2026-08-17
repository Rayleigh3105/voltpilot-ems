package agent

import (
	"encoding/json"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

// Der geführte SCHALT-Test (Einheitsmodell Stufe 4). Was hier geprüft wird, ist
// die Reihenfolge und die Trennung - nicht der Modbus-Rahmen (der lebt in der
// Palette und ist dort gegen ein echtes in-process-Gateway geprüft).

/**
 * Eine Box mit BEIDEN Rücklauf-Wegen. `startProbeBox` verdrahtet nur den
 * Lese-Rücklauf; der Schalt-Rücklauf ist ein eigenes Topic (genau das ist der
 * Punkt), also braucht er hier seine eigene Zeile - im echten Agenten tut das
 * `agent.go` beim Start.
 */
func startSwitchBox(t *testing.T) *probeBox {
	t.Helper()
	box := startProbeBox(t)
	if err := box.a.Bus.Subscribe(localbus.TopicSwitchResult, 14,
		box.a.onSwitchBusResult); err != nil {
		t.Fatalf("subscribe switch result: %v", err)
	}
	return box
}

/** Kürzt das Warte-Fenster für einen Fall, der bewusst ohne Antwort bleibt. */
func shortSwitchExchange(t *testing.T, d time.Duration) {
	t.Helper()
	prev := switchExchangeTimeout
	switchExchangeTimeout = d
	t.Cleanup(func() { switchExchangeTimeout = prev })
}

/**
 * Ein Stellvertreter des Palette-Schalt-Knotens: er hört auf dem EIGENEN
 * Topic-Paar und meldet jede gesehene Anfrage.
 */
func switchStub(t *testing.T, busAddr string, seen chan<- switchBusRequest,
	answer func(req switchBusRequest) []switchBusResult) {
	t.Helper()
	opts := pahomqtt.NewClientOptions().
		AddBroker("tcp://" + busAddr).
		SetClientID("test-switch-stub").
		SetConnectTimeout(5 * time.Second)
	client := pahomqtt.NewClient(opts)
	if tok := client.Connect(); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		t.Fatalf("stub connect: %v", tok.Error())
	}
	t.Cleanup(func() { client.Disconnect(100) })
	tok := client.Subscribe(localbus.TopicSwitchRequest, 1,
		func(_ pahomqtt.Client, msg pahomqtt.Message) {
			var req switchBusRequest
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
			raw, _ := json.Marshal(switchBusResponse{
				RequestID: req.RequestID, Results: answer(req)})
			client.Publish(localbus.TopicSwitchResult, 1, false, raw)
		})
	if !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("stub subscribe: %v", tok.Error())
	}
}

func switchOp(mutate func(m map[string]any)) map[string]any {
	m := map[string]any{
		"op": "switch_test", "id": "relais", "transport": "modbus_tcp",
		"host": "192.168.0.28", "register_kind": "coil", "address": 0,
		"on_value": 1, "off_value": 0, "ttl_s": 1,
	}
	if mutate != nil {
		mutate(m)
	}
	return m
}

/**
 * ⚠ Die Reihenfolge IST die Sicherheit: das automatische Aus wird armiert,
 * BEVOR geschrieben wird. Der Beweis kommt ohne Blick in den Code aus - der
 * Stellvertreter antwortet auf den Schreibvorgang NIE (die Antwort geht
 * verloren, das Gerät hat aber sehr wohl geschaltet), und trotzdem muss der
 * Aus-Wert von selbst nachkommen. Das kann nur halten, wenn der Wachhund vor
 * dem Schreiben stand und nicht an dessen Erfolg hängt.
 */
func TestSwitchTestArmsTheAutoOffBeforeItWrites(t *testing.T) {
	shortSwitchExchange(t, 800*time.Millisecond)
	box := startSwitchBox(t)
	seen := make(chan switchBusRequest, 4)
	switchStub(t, box.addr, seen, nil) // antwortet NICHT

	box.a.onProbeRequest(probeEnvelope(t, func(m map[string]any) {
		m["ops"] = []map[string]any{switchOp(nil)}
	}))

	first := <-seen
	if len(first.Ops) != 1 || first.Ops[0].Value != 1 {
		t.Fatalf("der Ein-Wert muss geschrieben werden: %+v", first.Ops)
	}

	// Ohne Antwort meldet die Box einen ehrlichen Ausgang - und der Wachhund
	// bleibt trotzdem stehen.
	res := box.answer(t)
	if res == nil || len(res.Results) != 1 || res.Results[0].OK {
		t.Fatalf("ein verlorener Rücklauf ist kein Erfolg: %+v", res)
	}

	select {
	case off := <-seen:
		if len(off.Ops) != 1 || off.Ops[0].Value != 0 {
			t.Fatalf("das automatische Aus muss den Aus-Wert schreiben: %+v", off.Ops)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("das automatische Aus ist ausgeblieben - ein Test ohne Rücklauf " +
			"hätte das Gerät eingeschaltet zurückgelassen")
	}
}

/** Der Abbruch entwaffnet den Wachhund und schreibt den Aus-Wert SOFORT. */
func TestSwitchCancelWritesTheSafeValueImmediatelyAndDisarms(t *testing.T) {
	box := startSwitchBox(t)
	seen := make(chan switchBusRequest, 4)
	switchStub(t, box.addr, seen, func(req switchBusRequest) []switchBusResult {
		return []switchBusResult{{ID: req.Ops[0].ID, OK: true}}
	})

	box.a.onProbeRequest(probeEnvelope(t, func(m map[string]any) {
		m["ops"] = []map[string]any{switchOp(func(m map[string]any) {
			m["ttl_s"] = 60 // lange genug, dass NUR der Abbruch abschalten kann
		})}
	}))
	<-seen
	if res := box.answer(t); res == nil || !res.Results[0].OK {
		t.Fatalf("der Test muss gelingen: %+v", res)
	}

	box.a.onProbeRequest(probeEnvelope(t, func(m map[string]any) {
		m["request_id"] = "9f2c41ab77d0e316"
		m["ops"] = []map[string]any{{
			"op": "switch_cancel", "id": "relais", "transport": "modbus_tcp",
			"host": "192.168.0.28", "register_kind": "coil", "address": 0,
			"off_value": 0,
		}}
	}))

	select {
	case off := <-seen:
		if off.Ops[0].Value != 0 {
			t.Fatalf("der Abbruch schreibt den Aus-Wert: %+v", off.Ops)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("der Abbruch hat das Gerät nicht ausgeschaltet")
	}
	if res := box.answer(t); res == nil || len(res.Results) != 1 {
		t.Fatalf("auch der Abbruch wird berichtet: %+v", res)
	}

	// Und danach ist Ruhe: der entwaffnete Wachhund darf nicht nachträglich
	// noch einmal schreiben.
	select {
	case extra := <-seen:
		t.Fatalf("nach dem Abbruch darf nichts mehr geschrieben werden: %+v", extra.Ops)
	case <-time.After(1500 * time.Millisecond):
	}
}

/**
 * ⚠ EIN SOCKET-GESETZ, an der Naht geprüft: der Schalt-Schritt erreicht
 * ausschließlich das SCHALT-Topic, der Lese-Schritt ausschließlich den
 * Lese-Flow. Damit bleibt `vp-modbus-probe` schreibfrei als Eigenschaft des
 * CODES, nicht als Konvention - und beide gehen im selben Vorgang.
 */
func TestSwitchAndReadTravelOnTheirOwnTopicsInOneRequest(t *testing.T) {
	box := startSwitchBox(t)
	reads := make(chan probeBusRequest, 2)
	switches := make(chan switchBusRequest, 2)
	probeStub(t, box.addr, reads, func(req probeBusRequest) []probeBusResult {
		return []probeBusResult{{ID: "soc", OK: true, Raw: f64(94), Registers: []int{94}}}
	})
	switchStub(t, box.addr, switches, func(req switchBusRequest) []switchBusResult {
		rb := 1
		return []switchBusResult{{ID: req.Ops[0].ID, OK: true, Readback: &rb}}
	})

	box.a.onProbeRequest(probeEnvelope(t, func(m map[string]any) {
		m["ops"] = []map[string]any{
			switchOp(func(m map[string]any) { m["readback_address"] = 0 }),
			{
				"op": "read", "id": "soc", "transport": "modbus_tcp",
				"host": "192.168.0.28", "register_kind": "holding",
				"address": 588, "data_type": "u16",
			},
		}
	}))

	res := box.answer(t)
	if res == nil || len(res.Results) != 2 {
		t.Fatalf("beide Schritte werden berichtet, in Reihenfolge: %+v", res)
	}
	if res.Results[0].ID != "relais" || !res.Results[0].OK {
		t.Fatalf("der Schalt-Schritt muss laufen: %+v", res.Results[0])
	}
	// Ein Schalt-Ergebnis trägt KEINEN Messwert, sondern seinen eigenen Block.
	if res.Results[0].Value != nil || res.Results[0].Switched == nil {
		t.Fatalf("ein Schalt-Ergebnis ist kein Messwert: %+v", res.Results[0])
	}
	if res.Results[0].Switched.Written != 1 || res.Results[0].Switched.OffAfterSeconds == nil {
		t.Fatalf("der geschriebene Wert und das Aus-Fenster gehören dazu: %+v",
			res.Results[0].Switched)
	}
	if res.Results[0].Switched.ReadbackMatches == nil || !*res.Results[0].Switched.ReadbackMatches {
		t.Fatalf("der Rückleser stimmt überein und wird berichtet: %+v", res.Results[0].Switched)
	}
	if !res.Results[1].OK || res.Results[1].Value == nil {
		t.Fatalf("die Lesung daneben läuft weiter: %+v", res.Results[1])
	}

	read := <-reads
	if len(read.Ops) != 1 || read.Ops[0].ID != "soc" {
		t.Fatalf("NUR die Lesung darf den Lese-Flow erreichen: %+v", read.Ops)
	}
	sw := <-switches
	if len(sw.Ops) != 1 || sw.Ops[0].ID != "relais" {
		t.Fatalf("NUR der Schalt-Schritt darf den Schalt-Flow erreichen: %+v", sw.Ops)
	}
}

/**
 * Die Zulassungs-Regeln gelten für den Schreibweg genauso: ein öffentliches
 * Ziel, eine fremde Identität und eine verfallene Anfrage erreichen das Gerät
 * NIE. Der Beweis ist die Stille auf dem Schalt-Topic.
 */
func TestARefusedSwitchNeverReachesTheDevice(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(m map[string]any)
		silent  bool // stumm zum Anfragenden (Identität/Verfall) …
		errCode string
	}{
		{
			name: "öffentliches Ziel",
			mutate: func(m map[string]any) {
				m["ops"] = []map[string]any{switchOp(func(o map[string]any) {
					o["host"] = "203.0.113.7"
				})}
			},
			errCode: probe.ErrInvalidRequest,
		},
		{
			name: "fremdes Gerät",
			mutate: func(m map[string]any) {
				m["device_id"] = "00000000-0000-0000-0000-0000000000ff"
				m["ops"] = []map[string]any{switchOp(nil)}
			},
			silent: true,
		},
		{
			name: "verfallen",
			mutate: func(m map[string]any) {
				m["requested_at"] = time.Now().UTC().Add(-10 * time.Minute).
					Format(time.RFC3339)
				m["ops"] = []map[string]any{switchOp(nil)}
			},
			silent: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			box := startSwitchBox(t)
			seen := make(chan switchBusRequest, 2)
			switchStub(t, box.addr, seen, func(req switchBusRequest) []switchBusResult {
				return []switchBusResult{{ID: req.Ops[0].ID, OK: true}}
			})

			box.a.onProbeRequest(probeEnvelope(t, c.mutate))

			res := box.answer(t)
			if c.silent {
				if res != nil {
					t.Fatalf("eine falsch adressierte Anfrage wird STUMM verworfen: %+v", res)
				}
			} else {
				if res == nil || len(res.Results) != 1 || res.Results[0].OK {
					t.Fatalf("die Ablehnung muss berichtet werden: %+v", res)
				}
				if res.Results[0].ErrorCode != c.errCode {
					t.Fatalf("Fehlklasse %q erwartet: %+v", c.errCode, res.Results[0])
				}
				if res.Results[0].Message == "" {
					t.Fatal("eine Ablehnung ohne Satz ist ein Rätsel")
				}
			}
			select {
			case op := <-seen:
				t.Fatalf("das Gerät darf nie erreicht werden: %+v", op.Ops)
			case <-time.After(500 * time.Millisecond):
			}
		})
	}
}
