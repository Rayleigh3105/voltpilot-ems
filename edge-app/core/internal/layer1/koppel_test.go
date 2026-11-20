package layer1_test

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/koppelbild"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/layer1"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// The Koppelbild on Edge Light, end to end over the real local bus: the core,
// the Go Layer 1 and a stand-in controller that serves the Erzeuger image at 0,
// takes telegrams at holding register 0 (FC16) and acknowledges them at 1000.
// The stand-in judges only what this test needs (the library block itself is
// held to the contract vectors by sps/codesys/pruefer); the box side is held
// to the same vectors in internal/koppelbild.
//
// ⚠ Stand-in, no proof: the real CODESYS server is checked at the PFC200
// (PS-P9 to PS-P12).

const koppelSteuerungID = 4711

type koppelStandIn struct {
	mu        sync.Mutex
	bild      []uint16
	halte     []uint16
	herz      uint16
	annahmen  uint16
	geschrieb [][]uint16
	port      int
}

func starteKoppelSteuerung(t *testing.T) *koppelStandIn {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	s := &koppelStandIn{bild: erzeugerBild(t), halte: make([]uint16, 64), port: ln.Addr().(*net.TCPAddr).Port}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go s.bediene(c)
		}
	}()
	return s
}

// quittung is the acknowledgement of the last telegram: Stellplatz 1 offers
// limit_w on the whole generation, 0 to 265 000 W; a limit_w wish is taken as
// it is (wirksam = wish).
func (s *koppelStandIn) quittung() []uint16 {
	q := make([]uint16, koppelbild.QWoerter)
	q[0], q[1], q[2], q[3], q[4], q[5] = 0x5650, 0x4B51, 0x0102, 0x0304, 0x0100, 1
	s.herz++
	q[6], q[7] = s.herz, 0x0100
	q[8], q[9] = koppelSteuerungID>>16, koppelSteuerungID&0xFFFF
	w := s.halte
	art, wert := w[16], uint32(w[18])<<16|uint32(w[19])
	if w[0] == 0x5650 && w[1] == 0x4B57 {
		q[10], q[11], q[12], q[13] = 1, w[6], w[7], w[10]
	}
	q[14], q[15] = 0b011, s.annahmen
	for n := 0; n < 8; n++ {
		b := 20 + n*12
		q[b+4], q[b+5], q[b+6], q[b+7], q[b+10], q[b+11] = 0x7FFF, 0xFFFF, 0x7FFF, 0xFFFF, 0x7FFF, 0xFFFF
	}
	q[20], q[21], q[23] = 1, 1, 1
	q[24], q[25], q[26], q[27] = 0, 0, 0x0004, 0x0B28
	if q[10] == 1 {
		q[29] = w[20]
		if art == 1 {
			q[28] = 1
			q[30], q[31] = uint16(wert>>16), uint16(wert)
		}
	}
	rest := append(append([]uint16{}, q[:19]...), q[20:]...)
	q[19] = koppelbild.Crc16(rest)
	return q
}

func (s *koppelStandIn) bediene(c net.Conn) {
	defer c.Close()
	for {
		head := make([]byte, 7)
		if _, err := io.ReadFull(c, head); err != nil {
			return
		}
		pdu := make([]byte, int(binary.BigEndian.Uint16(head[4:6]))-1)
		if _, err := io.ReadFull(c, pdu); err != nil {
			return
		}
		fc, start, count := pdu[0], int(binary.BigEndian.Uint16(pdu[1:3])), int(binary.BigEndian.Uint16(pdu[3:5]))
		s.mu.Lock()
		var antwort []byte
		switch {
		case fc == 4 && start == 1000 && count == koppelbild.QWoerter:
			antwort = []byte{fc, byte(2 * count)}
			for _, w := range s.quittung() {
				antwort = binary.BigEndian.AppendUint16(antwort, w)
			}
		case fc == 4 && start+count <= len(s.bild):
			antwort = []byte{fc, byte(2 * count)}
			for _, w := range s.bild[start : start+count] {
				antwort = binary.BigEndian.AppendUint16(antwort, w)
			}
		case fc == 16 && start == 0 && count == 64 && len(pdu) == 6+128:
			for i := 0; i < 64; i++ {
				s.halte[i] = binary.BigEndian.Uint16(pdu[6+2*i:])
			}
			s.annahmen++
			s.geschrieb = append(s.geschrieb, append([]uint16(nil), s.halte...))
			antwort = append([]byte{fc}, pdu[1:5]...)
		default:
			antwort = []byte{fc | 0x80, 0x02}
		}
		s.mu.Unlock()
		frame := append([]byte{head[0], head[1], 0, 0}, binary.BigEndian.AppendUint16(nil, uint16(len(antwort)+1))...)
		frame = append(append(frame, head[6]), antwort...)
		if _, err := c.Write(frame); err != nil {
			return
		}
	}
}

func (s *koppelStandIn) letztes() []uint16 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.geschrieb) == 0 {
		return nil
	}
	return s.geschrieb[len(s.geschrieb)-1]
}

func platz1(w []uint16) (art uint16, wert int32, grund uint16) {
	return w[16], int32(uint32(w[18])<<16 | uint32(w[19])), w[17]
}

func TestEdgeLightWuenschtUeberDasKoppelbild(t *testing.T) {
	steuerung := starteKoppelSteuerung(t)
	a := startLightBox(t, layer1.Options{FirstPoll: time.Hour, Poll: time.Hour,
		SourcesFirstPoll: time.Hour, SourcesPoll: time.Hour})
	bus, err := layer1.DialMQTT(a.Cfg.LocalMQTTAddr, "koppel-beobachter")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(bus.Close)
	beob := &busBeobachter{}
	for _, topic := range []string{layer1.TopicKoppelStatus, "edge/probe/result"} {
		if err := bus.Subscribe(topic, func(topic string, p []byte) {
			beob.mu.Lock()
			beob.msgs = append(beob.msgs, struct {
				topic   string
				payload []byte
			}{topic, append([]byte(nil), p...)})
			beob.mu.Unlock()
		}); err != nil {
			t.Fatal(err)
		}
	}
	publish := func(topic string, v any) {
		raw, _ := json.Marshal(v)
		if err := bus.Publish(topic, raw, true); err != nil {
			t.Fatal(err)
		}
	}
	// The registry push of an Anlagensteuerung with Stellplatz 1 released
	// (limit_kw 0..265 kW), its source, the plan with the image's parameters.
	publish("edge/entities/"+erzSteuerung+"/config", map[string]any{"entity_id": erzSteuerung,
		"entity_type": "anlagensteuerung", "edge_source_id": erzPin,
		"driver":       map[string]any{"communication": "modbus_tcp", "data_source_id": erzDatenquelle},
		"capabilities": map[string]any{"actuate": []any{map[string]any{"command": "limit_kw", "min": 0, "max": 265, "platz": 1}}}})
	publish(sources.TopicConfig, map[string]any{"schema_version": sources.SchemaVersion, "sources": []any{
		map[string]any{"id": erzPin, "role": sources.RolePlantController, "communication": "modbus_tcp",
			"family":     sources.FamilyErzeugerRegisterbild,
			"connection": map[string]any{"ip": "127.0.0.1", "port": steuerung.port, "unit_id": 1}}}})
	publish(measurements.LocalConfigTopic, map[string]any{"schema_version": "2.0", "revision": 4,
		"catalog_version": "2026.10.21.1",
		"selections":      []any{map[string]any{"point_key": "erzeuger.a.p_erzeugung_w", "cadence_s": 60, "entity_id": erzSteuerung}},
		"erzeuger_registerbilder": []any{map[string]any{"entity_id": erzSteuerung, "basisadresse": 0,
			"funktionscode": 4, "wortfolge": "big", "te_anzahl": 3, "anlagenart": "pv",
			"steuerung_kennung": koppelSteuerungID}}})

	// Without a granted command the box writes life signs without a wish.
	waitFor(t, 15*time.Second, "erstes Telegramm", func() bool { return steuerung.letztes() != nil })
	if art, wert, _ := platz1(steuerung.letztes()); art != 0 || wert != 0x7FFFFFFF {
		t.Fatalf("ohne Befehl ein Wunsch: %d %d", art, wert)
	}
	w := steuerung.letztes()
	if w[8] != 0 || w[9] != koppelSteuerungID || w[10] != koppelbild.FristS || w[5] != 8 {
		t.Fatalf("Kopf %v", w[:16])
	}

	// The arbiter grants limit_kw 159 for the plan: the next telegram carries
	// 159 000 W on Stellplatz 1 with reason market, at once (not after 5 s).
	publish("edge/entities/"+erzSteuerung+"/command", map[string]any{"schema_version": "1.0", "entity_id": erzSteuerung,
		"control_enabled": true, "source": "plan-executor", "commands": map[string]any{"limit_kw": 159}})
	waitFor(t, 15*time.Second, "Wunsch 159 kW", func() bool {
		w := steuerung.letztes()
		art, wert, _ := platz1(w)
		return art == 1 && wert == 159000
	})
	if _, _, grund := platz1(steuerung.letztes()); grund != 1 {
		t.Errorf("Grund %d statt markt", grund)
	}
	waitFor(t, 15*time.Second, "Stand mit Quittung", func() bool {
		alle := beob.alle(layer1.TopicKoppelStatus)
		return len(alle) > 0 && strings.Contains(string(alle[len(alle)-1]), `"urteil":"angenommen"`) &&
			strings.Contains(string(alle[len(alle)-1]), `"wirksam":159000`)
	})
	var stand []koppelbild.Stand
	alle := beob.alle(layer1.TopicKoppelStatus)
	_ = json.Unmarshal(alle[len(alle)-1], &stand)
	if len(stand) != 1 || stand[0].Steuerung != erzSteuerung || stand[0].Lage != koppelbild.LageBereit ||
		stand[0].DataSourceID != erzDatenquelle || stand[0].Plaetze[0].Wunsch == nil {
		t.Fatalf("Stand %+v", stand)
	}

	// The box switches off control (control_enabled false): life signs, no wish.
	publish("edge/entities/"+erzSteuerung+"/command", map[string]any{"schema_version": "1.0", "entity_id": erzSteuerung,
		"control_enabled": false, "source": "plan-executor", "commands": map[string]any{"limit_kw": 159}})
	waitFor(t, 15*time.Second, "kein Wunsch bei geschlossenen Schaltern", func() bool {
		w := steuerung.letztes()
		art, _, _ := platz1(w)
		return art == 0 && w[11]&0b100 == 0
	})

	// The Schalt-Test: 100 000 W on Stellplatz 1, answered with the
	// controller's acknowledgement of exactly the test's Folge.
	anfrage, _ := json.Marshal(map[string]any{"request_id": "kt-1", "ops": []any{
		map[string]any{"id": "sp1", "op": "koppel_test", "host": "127.0.0.1", "port": steuerung.port, "unit_id": 1,
			"steuerung_id": koppelSteuerungID, "platz": 1, "art": "limit_w", "wert": 100000, "ttl_s": 30}}})
	if err := bus.Publish("edge/probe/request", anfrage, false); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 15*time.Second, "Ergebnis des Schalt-Tests", func() bool { return len(beob.alle("edge/probe/result")) > 0 })
	var ergebnis struct {
		RequestID string `json:"request_id"`
		Results   []struct {
			ID         string `json:"id"`
			OK         bool   `json:"ok"`
			Message    string `json:"message"`
			KoppelTest *struct {
				Lage        string `json:"lage"`
				Geschrieben *bool  `json:"geschrieben"`
				Urteil      string `json:"urteil"`
				Wirksam     *int64 `json:"wirksam"`
			} `json:"koppel_test"`
		} `json:"results"`
	}
	if err := json.Unmarshal(beob.alle("edge/probe/result")[0], &ergebnis); err != nil {
		t.Fatal(err)
	}
	r := ergebnis.Results[0]
	if ergebnis.RequestID != "kt-1" || !r.OK || r.KoppelTest == nil || r.KoppelTest.Urteil != "angenommen" ||
		r.KoppelTest.Wirksam == nil || *r.KoppelTest.Wirksam != 100000 {
		t.Fatalf("Schalt-Test %+v %+v", r, r.KoppelTest)
	}
	w = steuerung.letztes()
	if art, wert, grund := platz1(w); art != 1 || wert != 100000 || grund != 5 || w[11]&0b1000 == 0 {
		t.Fatalf("Testtelegramm %d %d %d e_bits %#x", art, wert, grund, w[11])
	}

	// A wrong controller id is refused with a sentence, never written.
	anfrage, _ = json.Marshal(map[string]any{"request_id": "kt-2", "ops": []any{
		map[string]any{"id": "sp1", "op": "koppel_test", "host": "127.0.0.1", "port": steuerung.port, "unit_id": 1,
			"steuerung_id": 9, "platz": 1, "art": "limit_w", "wert": 100000, "ttl_s": 30}}})
	if err := bus.Publish("edge/probe/request", anfrage, false); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 10*time.Second, "Ablehnung", func() bool { return len(beob.alle("edge/probe/result")) > 1 })
	_ = json.Unmarshal(beob.alle("edge/probe/result")[1], &ergebnis)
	if ergebnis.Results[0].OK || ergebnis.Results[0].Message == "" {
		t.Fatalf("fremde Kennung angenommen: %+v", ergebnis.Results[0])
	}
}
