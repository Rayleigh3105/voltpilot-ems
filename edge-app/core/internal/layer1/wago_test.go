package layer1

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/datasourcestatus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/messwerte"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// wagoSteuerung serves a WAGO register image from address 0 over FC4 and the
// nameplate at 0xFA10; anything else is exception 2.
type wagoSteuerung struct {
	mu      sync.Mutex
	woerter []uint16
	schild  []uint16
	port    int
}

func starteWagoSteuerung(t *testing.T, woerter, schild []uint16) *wagoSteuerung {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	s := &wagoSteuerung{woerter: woerter, schild: schild, port: ln.Addr().(*net.TCPAddr).Port}
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

func (s *wagoSteuerung) bediene(c net.Conn) {
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
		bank, off := s.woerter, start
		if start >= 0xfa10 {
			bank, off = s.schild, start-0xfa10
		}
		var antwort []byte
		if fc != 4 || off+count > len(bank) {
			antwort = []byte{fc | 0x80, 0x02}
		} else {
			antwort = []byte{fc, byte(2 * count)}
			for _, w := range bank[off : off+count] {
				antwort = binary.BigEndian.AppendUint16(antwort, w)
			}
		}
		s.mu.Unlock()
		frame := append([]byte{head[0], head[1], 0, 0}, binary.BigEndian.AppendUint16(nil, uint16(len(antwort)+1))...)
		if _, err := c.Write(append(append(frame, head[6]), antwort...)); err != nil {
			return
		}
	}
}

// wagoBild is a v1 image with two 750-495 cards (slots 2 and 3), controller 7,
// power L1 of card n = -30 000 + n (raw, int32).
func wagoBild() []uint16 {
	w := []uint16{0x5650, 0x5242, 1, 0, 12, 42, 2, 1731, 0x0102, 0x0304, 0, 7}
	for n := 0; n < 2; n++ {
		karte := make([]uint16, 42)
		karte[0], karte[1], karte[2], karte[3], karte[5] = uint16(2+n), 495, 0, 15, 4
		v := uint32(int32(-30000 + n))
		karte[22], karte[23] = uint16(v>>16), uint16(v)
		w = append(w, karte...)
	}
	return w
}

func TestEdgeLightReadsTheEnergyCardsOfAWagoRegisterImage(t *testing.T) {
	sps := starteWagoSteuerung(t, wagoBild(), []uint16{0x3735, 0x302d, 0x3832, 0x3132, 0, 0, 0, 0})
	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour})
	l := r.listen(measurements.LocalStatusTopic, measurements.LocalSamplesTopic, datasourcestatus.Topic, localbus.TopicProbeResult)
	if err := r.bus.Publish(sources.TopicConfig, sourcesConfig(map[string]any{"id": "src-sps", "role": sources.RolePlantController,
		"communication": "modbus_tcp", "family": "voltpilot.wago_registerbild_v1",
		"connection": map[string]any{"ip": "127.0.0.1", "port": sps.port, "unit_id": 1}}), true); err != nil {
		t.Fatal(err)
	}
	r.entitaet("sps-1", "anlagensteuerung", "src-sps", "DQ-W")
	time.Sleep(200 * time.Millisecond)
	raw, _ := json.Marshal(map[string]any{"schema_version": "2.0", "revision": 9, "catalog_version": messwerte.KatalogVersion(),
		"registerbilder": []any{map[string]any{"entity_id": "sps-1", "basisadresse": 0, "funktionscode": 4, "wortfolge": "big",
			"kartenzahl": 2, "controller_kennung": 7, "karten": []any{
				map[string]any{"steckplatz": 2, "kartentyp": 495, "variante": 0},
				map[string]any{"steckplatz": 3, "kartentyp": 495, "variante": 0}}}},
		"selections": []any{map[string]any{"point_key": "wago.pm495.karte[*].power_l1", "cadence_s": 60, "entity_id": "sps-1"}}})
	if err := r.bus.Publish(measurements.LocalConfigTopic, raw, true); err != nil {
		t.Fatal(err)
	}
	var status measurements.LocalStatus
	statuses := l.wait(t, measurements.LocalStatusTopic, 1, 5*time.Second)
	_ = json.Unmarshal(statuses[len(statuses)-1], &status)
	if len(status.Accepted) != 1 || len(status.Rejected) != 0 {
		t.Fatalf("Status %+v", status)
	}
	var b batch
	_ = json.Unmarshal(l.wait(t, measurements.LocalSamplesTopic, 1, 5*time.Second)[0], &b)
	if len(b.Samples) != 2 || b.Samples[0]["point_key"] != "wago.pm495.karte[0].power_l1" || b.Samples[0]["raw"] != "ffff8ad0" ||
		b.Samples[1]["raw"] != "ffff8ad1" || b.Samples[0]["decoded"] != nil || b.Samples[0]["entity_id"] != "sps-1" {
		t.Fatalf("Kartenwerte roh, ohne kW (der Faktor haengt am Messbereich): %v", b.Samples)
	}
	beleg := false
	for _, raw := range l.wait(t, datasourcestatus.Topic, 1, 5*time.Second) {
		var ev map[string]any
		_ = json.Unmarshal(raw, &ev)
		beleg = beleg || ev["id"] == "DQ-W"
	}
	if !beleg {
		t.Fatal("Lese-Beleg der Datenquelle der Steuerung fehlt")
	}

	// "Steuerung verbinden": the head of the image, with the nameplate.
	res := probeResult(t, r, l, "w-1", map[string]any{"id": "k", "op": "wago_kopf", "host": "127.0.0.1", "port": sps.port,
		"unit_id": 1, "fc": 4, "address": 0, "word_order": "big", "nameplate": true})
	k, _ := res[0]["wago_kopf"].(map[string]any)
	if res[0]["ok"] != true || k["erkannt"] != true || k["kartenzahl"] != 2.0 || k["controller_kennung"] != 7.0 || k["typenschild"] != "750-8212" {
		t.Fatalf("Kopf-Probe: %v", res[0])
	}
	zu, _ := strconv.Atoi(freeAddrPort(t))
	if res := probeResult(t, r, l, "w-2", map[string]any{"id": "k", "op": "wago_kopf", "host": "127.0.0.1", "port": zu,
		"unit_id": 1, "fc": 4, "address": 0, "word_order": "big"}); res[0]["error_code"] != "unreachable" {
		t.Fatalf("Kopf-Probe ohne Steuerung: %v", res[0])
	}
}
