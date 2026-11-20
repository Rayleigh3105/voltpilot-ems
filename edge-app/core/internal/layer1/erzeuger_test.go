package layer1_test

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/layer1"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// The Erzeuger image on Edge Light, end to end over the real local bus: the
// UNCHANGED core, the Go Layer 1 and a stand-in for the controller's Modbus
// TCP server on 127.0.0.1 - the address a PFC200 that runs Edge Light itself
// reads its own SPS at ("in diesem Gerät"). The retained documents are the
// ones the core publishes from the cloud's plan and registry push; the
// observer sees what the palette would put on the bus on the Docker box.
//
// ⚠ Stand-in, no proof: what a real CODESYS Modbus server does on the device
// is checked at the PFC200 (PS-P9, PS-P13).

const (
	erzSteuerung   = "00000000-0000-0000-0000-0000000e2001"
	erzDatenquelle = "DQ-2001"
	erzPin         = "sps-1"
)

// erzeugerBild is the image with names of the shared runtime vectors (case
// gore-mit-namen of the head probe) - the same words the palette was judged on.
func erzeugerBild(t *testing.T) []uint16 {
	t.Helper()
	raw, err := os.ReadFile("../../../nodered/measurements/erzeuger-laufzeit-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var d struct {
		Kopfpruefung []struct {
			Name  string `json:"name"`
			Input struct {
				Bild []uint16 `json:"bild"`
			} `json:"input"`
		} `json:"kopfpruefung"`
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	for _, f := range d.Kopfpruefung {
		if f.Name == "gore-mit-namen" {
			return append([]uint16(nil), f.Input.Bild...)
		}
	}
	t.Fatal("Fall gore-mit-namen fehlt")
	return nil
}

// steuerungStandIn serves the image as input registers (FC4) from address 0,
// the heartbeat (word 6) +1 on every read of the head. Anything else is an
// exception 0x02, like a CODESYS server outside its mapped area.
type steuerungStandIn struct {
	mu      sync.Mutex
	woerter []uint16
	reads   []string
	port    int
}

func starteSteuerung(t *testing.T, woerter []uint16) *steuerungStandIn {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	s := &steuerungStandIn{woerter: woerter, port: ln.Addr().(*net.TCPAddr).Port}
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

func (s *steuerungStandIn) bediene(c net.Conn) {
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
		s.reads = append(s.reads, fmt.Sprintf("FC%d@%d+%d", fc, start, count))
		var antwort []byte
		if fc != 4 || start+count > len(s.woerter) {
			antwort = []byte{fc | 0x80, 0x02}
		} else {
			if start == 0 {
				s.woerter[6]++
			}
			antwort = []byte{fc, byte(2 * count)}
			for _, w := range s.woerter[start : start+count] {
				antwort = binary.BigEndian.AppendUint16(antwort, w)
			}
		}
		s.mu.Unlock()
		frame := append([]byte{head[0], head[1], 0, 0}, binary.BigEndian.AppendUint16(nil, uint16(len(antwort)+1))...)
		frame = append(append(frame, head[6]), antwort...)
		if _, err := c.Write(frame); err != nil {
			return
		}
	}
}

func (s *steuerungStandIn) gelesen() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.reads...)
}

// busBeobachter collects every message of the topics the palette would serve.
type busBeobachter struct {
	mu   sync.Mutex
	msgs []struct {
		topic   string
		payload []byte
	}
}

func (b *busBeobachter) alle(topic string) [][]byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out [][]byte
	for _, m := range b.msgs {
		if m.topic == topic {
			out = append(out, m.payload)
		}
	}
	return out
}

func TestEdgeLightReadsTheErzeugerImageOfTheControllerInThisDevice(t *testing.T) {
	steuerung := starteSteuerung(t, erzeugerBild(t))
	a := startLightBox(t, layer1.Options{FirstPoll: time.Hour, Poll: time.Hour,
		SourcesFirstPoll: time.Hour, SourcesPoll: time.Hour})

	bus, err := layer1.DialMQTT(a.Cfg.LocalMQTTAddr, "erzeuger-beobachter")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(bus.Close)
	beob := &busBeobachter{}
	for _, topic := range []string{measurements.LocalStatusTopic, measurements.LocalSamplesTopic,
		"edge/sources/+/telemetry", "edge/events", "edge/data-sources/poll", "edge/probe/result"} {
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

	// What the core publishes from the registry push (EZ-21) and the plan
	// (EZ-18): the controller's entity with its pin, the plant-controller
	// source behind the pin, the plan with the image's parameters.
	publish := func(topic string, v any) {
		raw, _ := json.Marshal(v)
		if err := bus.Publish(topic, raw, true); err != nil {
			t.Fatal(err)
		}
	}
	publish("edge/entities/"+erzSteuerung+"/config", map[string]any{"entity_id": erzSteuerung,
		"entity_type": "anlagensteuerung", "edge_source_id": erzPin,
		"driver": map[string]any{"communication": "modbus_tcp", "data_source_id": erzDatenquelle}})
	publish(sources.TopicConfig, map[string]any{"schema_version": sources.SchemaVersion, "sources": []any{
		map[string]any{"id": erzPin, "role": sources.RolePlantController, "communication": "modbus_tcp",
			"family":     sources.FamilyErzeugerRegisterbild,
			"connection": map[string]any{"ip": "127.0.0.1", "port": steuerung.port, "unit_id": 1}}}})
	auswahl := []map[string]any{}
	for _, key := range []string{"erzeuger.a.p_erzeugung_w", "erzeuger.a.p_nvp_w", "erzeuger.nb.n_p_prozent",
		"erzeuger.te[*].t_p_ist_w", "erzeuger.te[4].t_e", "deye.hybrid_3p.settings.battery-low-soc"} {
		auswahl = append(auswahl, map[string]any{"point_key": key, "cadence_s": 60, "entity_id": erzSteuerung})
	}
	publish(measurements.LocalConfigTopic, map[string]any{"schema_version": "2.0", "revision": 3,
		"catalog_version": "2026.10.21.1", "selections": auswahl,
		"erzeuger_registerbilder": []any{map[string]any{"entity_id": erzSteuerung, "basisadresse": 0,
			"funktionscode": 4, "wortfolge": "big", "te_anzahl": 3, "anlagenart": "pv", "steuerung_kennung": 4711,
			"veraltet_netzpunkt_s": 30}}})

	// The plan: the image's points accepted, the unit the Soll does not have
	// refused as driver_unavailable, the foreign point as before.
	waitFor(t, 10*time.Second, "Messplan-Status mit Erzeuger-Punkten", func() bool {
		for _, raw := range beob.alle(measurements.LocalStatusTopic) {
			if strings.Contains(string(raw), "erzeuger.te[*].t_p_ist_w") {
				return true
			}
		}
		return false
	})
	var status measurements.LocalStatus
	alle := beob.alle(measurements.LocalStatusTopic)
	if err := json.Unmarshal(alle[len(alle)-1], &status); err != nil {
		t.Fatal(err)
	}
	if strings.Join(status.Accepted, ",") != "erzeuger.a.p_erzeugung_w,erzeuger.a.p_nvp_w,erzeuger.nb.n_p_prozent,erzeuger.te[*].t_p_ist_w" {
		t.Errorf("angenommen: %v", status.Accepted)
	}
	gruende := map[string]string{}
	for _, r := range status.Rejected {
		gruende[r.PointKey] = r.Reason
	}
	if gruende["erzeuger.te[4].t_e"] != "driver_unavailable" || gruende["deye.hybrid_3p.settings.battery-low-soc"] == "" {
		t.Errorf("abgelehnt: %+v", status.Rejected)
	}

	// The first read: ONE request of 68 words with FC 4, the values with the
	// controller's component, the site sample on the pin's topic.
	waitFor(t, 10*time.Second, "Erzeuger-Samples", func() bool { return len(beob.alle(measurements.LocalSamplesTopic)) > 0 })
	var stapel struct {
		CatalogVersion  string `json:"catalog_version"`
		AppliedRevision int64  `json:"applied_revision"`
		Samples         []struct {
			PointKey string   `json:"point_key"`
			Decoded  *float64 `json:"decoded"`
			Quality  string   `json:"quality"`
			EntityID string   `json:"entity_id"`
		} `json:"samples"`
	}
	ersterStapel := beob.alle(measurements.LocalSamplesTopic)[0]
	if err := json.Unmarshal(ersterStapel, &stapel); err != nil {
		t.Fatal(err)
	}
	werte := map[string]float64{}
	for _, s := range stapel.Samples {
		if s.EntityID != erzSteuerung || s.Quality != "good" || s.Decoded == nil {
			t.Errorf("Sample %+v", s)
			continue
		}
		werte[s.PointKey] = *s.Decoded
	}
	want := map[string]float64{"erzeuger.a.p_erzeugung_w": 182400, "erzeuger.a.p_nvp_w": -1200,
		"erzeuger.nb.n_p_prozent": 60, "erzeuger.te[1].t_p_ist_w": 60900, "erzeuger.te[2].t_p_ist_w": 61000,
		"erzeuger.te[3].t_p_ist_w": 61100}
	if fmt.Sprint(werte) != fmt.Sprint(want) {
		t.Errorf("Werte %v, erwartet %v", werte, want)
	}
	if stapel.CatalogVersion != "2026.10.21.1" || stapel.AppliedRevision != 3 {
		t.Errorf("Stapel %s / %d", stapel.CatalogVersion, stapel.AppliedRevision)
	}
	// The core takes the batch as it takes the palette's (the outbox validates
	// it field by field).
	outbox, err := measurements.OpenOutbox(t.TempDir(), 8)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := outbox.Append(ersterStapel, measurements.Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}); err != nil {
		t.Fatalf("der Kern nimmt den Stapel nicht: %v", err)
	}
	waitFor(t, 5*time.Second, "Standort-Sample der Steuerung", func() bool {
		return len(beob.alle(sources.TopicPrefix+erzPin+"/telemetry")) > 0
	})
	var quelle map[string]any
	_ = json.Unmarshal(beob.alle(sources.TopicPrefix + erzPin + "/telemetry")[0], &quelle)
	if quelle["pv_power_kw"] != 182.4 || quelle["power_kw"] != -1.2 {
		t.Errorf("Standort-Sample %v", quelle)
	}
	waitFor(t, 5*time.Second, "Lese-Beleg der Datenquelle", func() bool {
		for _, raw := range beob.alle("edge/data-sources/poll") {
			if strings.Contains(string(raw), `"id":"`+erzDatenquelle+`"`) && strings.Contains(string(raw), `"requests":1`) {
				return true
			}
		}
		return false
	})
	if g := steuerung.gelesen(); len(g) == 0 || g[0] != "FC4@0+68" {
		t.Errorf("Lesungen an der Steuerung: %v", g)
	}

	// "Steuerung verbinden": the head probe through the local bus, names
	// included; a plain register read of the same controller is read in turn
	// (raw value and words); the WAGO head step reads the same controller and
	// reports the foreign signature (an Erzeuger image is no WAGO image).
	anfrage, _ := json.Marshal(map[string]any{"request_id": "p-1", "ops": []any{
		map[string]any{"id": "k", "op": "erzeuger_kopf", "host": "127.0.0.1", "port": steuerung.port,
			"unit_id": 1, "fc": 4, "address": 0, "word_order": "big"},
		map[string]any{"id": "r", "host": "127.0.0.1", "port": steuerung.port, "unit_id": 1, "fc": 4,
			"address": 0, "data_type": "u32", "word_order": "big"},
		map[string]any{"id": "w", "op": "wago_kopf", "host": "127.0.0.1", "port": steuerung.port, "unit_id": 1,
			"fc": 4, "address": 0, "word_order": "big"}}})
	if err := bus.Publish("edge/probe/request", anfrage, false); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 10*time.Second, "Probe-Ergebnis", func() bool { return len(beob.alle("edge/probe/result")) > 0 })
	var ergebnis struct {
		RequestID string `json:"request_id"`
		Results   []struct {
			ID           string         `json:"id"`
			OK           bool           `json:"ok"`
			ErrorCode    string         `json:"error_code"`
			Raw          *float64       `json:"raw"`
			WagoKopf     map[string]any `json:"wago_kopf"`
			Registers    []uint16       `json:"registers"`
			ErzeugerKopf *struct {
				Erkannt           bool   `json:"erkannt"`
				TeAnzahl          int    `json:"te_anzahl"`
				NetzbetreiberName string `json:"netzbetreiber_name"`
				Einheiten         []struct {
					TypName string `json:"typ_name"`
				} `json:"einheiten"`
			} `json:"erzeuger_kopf"`
		} `json:"results"`
	}
	if err := json.Unmarshal(beob.alle("edge/probe/result")[0], &ergebnis); err != nil {
		t.Fatal(err)
	}
	if ergebnis.RequestID != "p-1" || len(ergebnis.Results) != 3 {
		t.Fatalf("Probe-Ergebnis %+v", ergebnis)
	}
	k := ergebnis.Results[0].ErzeugerKopf
	if !ergebnis.Results[0].OK || k == nil || !k.Erkannt || k.TeAnzahl != 3 || k.NetzbetreiberName != "N-ERGIE Netz GmbH" ||
		len(k.Einheiten) != 3 || k.Einheiten[0].TypName != "Growatt MAX 125KTL3-X LV" {
		t.Errorf("Kopf-Bericht %+v", ergebnis.Results[0])
	}
	bild := erzeugerBild(t)
	if r := ergebnis.Results[1]; !r.OK || r.Raw == nil || *r.Raw != float64(uint32(bild[0])<<16|uint32(bild[1])) ||
		len(r.Registers) != 2 || r.Registers[0] != bild[0] || r.Registers[1] != bild[1] {
		t.Errorf("einfache Lesung: %+v", r)
	}
	if r := ergebnis.Results[2]; !r.OK || r.WagoKopf["erkannt"] != false || r.WagoKopf["grund"] != "signatur_fremd" {
		t.Errorf("WAGO-Kopf: %+v", r)
	}
}
