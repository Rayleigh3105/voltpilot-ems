package layer1

import (
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/kacoserial"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// wandlerSim is a Waveshare-like transparent TCP server with one Powador at
// `address` behind it: it answers `#AA0\r` for its own address with a command-0
// frame after a short latency and stays silent for any other address, like an
// RS485 bus without that unit. `reply` can be swapped for a scripted answer.
type wandlerSim struct {
	ln       net.Listener
	mu       sync.Mutex
	address  int
	acPowerW int
	cmdByte  byte
	silent   bool
	requests []string
}

func powadorFrame(address, acPowerW int, cmd byte, typ string) []byte {
	body := fmt.Sprintf("*%02d%c %3d %5s %5s %5d %5s %5s %5d %3d %6d ", address, cmd, 4, "412.5", "3.07", int(float64(acPowerW)/0.962), "230.4", "5.37", acPowerW, 38, 6567)
	out := append([]byte{0x0a}, []byte(body)...)
	out = append(out, kacoserial.Checksum([]byte(body)))
	return append(out, []byte(typ+"\r")...)
}

func startWandlerSim(t *testing.T, address int) *wandlerSim {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	w := &wandlerSim{ln: ln, address: address, acPowerW: 1216, cmdByte: '0'}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				buf := make([]byte, 64)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				req := string(buf[:n])
				w.mu.Lock()
				w.requests = append(w.requests, req)
				addr, ac, cmd, silent := w.address, w.acPowerW, w.cmdByte, w.silent
				w.mu.Unlock()
				if silent || req != fmt.Sprintf("#%02d0\r", addr) {
					time.Sleep(2 * time.Second)
					return
				}
				time.Sleep(40 * time.Millisecond)
				_, _ = c.Write(powadorFrame(addr, ac, cmd, " 3200I"))
				time.Sleep(500 * time.Millisecond)
			}()
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return w
}

func (w *wandlerSim) addr() (string, string) {
	h, p, _ := net.SplitHostPort(w.ln.Addr().String())
	return h, p
}

func kacoSel(host string, port any, address any) map[string]any {
	c := map[string]any{"ip": host, "port": port}
	if address != nil {
		c["address"] = address
	}
	return map[string]any{"brand": "kaco", "model": "powador-3200-int", "family": "kaco_serial", "communication": "kaco_serial", "connection": c}
}

func fastKaco() Options {
	return Options{KacoTimeout: 400 * time.Millisecond, KacoReplyGap: 100 * time.Millisecond, LinkTimeout: 600 * time.Millisecond}
}

func TestTheRetainedPowadorSelectionDrivesTheReadOntoTheBus(t *testing.T) {
	w := startWandlerSim(t, 1)
	r := newRig(t, fastKaco())
	host, port := w.addr()
	raw, _ := json.Marshal(kacoSel(host, port, 1))
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		t.Fatal(err)
	}
	msg := decodeJSON(t, r.wait(localbus.TopicTelemetry, 1, 5*time.Second)[0])
	// A string device: the AC output power IS the generation; nothing else.
	if msg["pv_power_kw"] != 1.216 || len(msg) != 2 {
		t.Fatalf("Powador-Messwert: nur pv_power_kw + ts: %v", msg)
	}
	if ts, _ := msg["ts"].(string); !strings.HasSuffix(ts, "Z") {
		t.Errorf("ts wie Date.toISOString(): %v", msg["ts"])
	}
	if decodeJSON(t, r.wait(localbus.TopicStatus, 1, 2*time.Second)[0])["inverter_link"] != "up" {
		t.Error("inverter_link up")
	}
	w.mu.Lock()
	req := w.requests[0]
	w.mu.Unlock()
	if req != "#010\r" {
		t.Errorf("Anfrage an Adresse 1: %q", req)
	}
}

func TestAPowadorAtAnotherAddressOrProtocolPublishesNothing(t *testing.T) {
	w := startWandlerSim(t, 7)
	r := newRig(t, fastKaco())
	host, port := w.addr()
	// Address 1 configured, the unit sits at 7: the bus stays silent.
	raw, _ := json.Marshal(kacoSel(host, port, 1))
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(900 * time.Millisecond)
	if r.count(localbus.TopicTelemetry) != 0 {
		t.Fatal("ohne Antwort darf nichts erscheinen")
	}
	// Address 7 reads.
	raw, _ = json.Marshal(kacoSel(host, port, "7"))
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		t.Fatal(err)
	}
	r.wait(localbus.TopicTelemetry, 1, 5*time.Second)
	n := r.count(localbus.TopicTelemetry)
	// The unit answers with another KACO protocol ('n'): never decoded, never guessed.
	w.mu.Lock()
	w.cmdByte = 'n'
	w.mu.Unlock()
	time.Sleep(900 * time.Millisecond)
	if r.count(localbus.TopicTelemetry) > n+1 {
		t.Fatalf("ein fremdes Kommando-Byte darf nicht als Messwert erscheinen (%d -> %d)", n, r.count(localbus.TopicTelemetry))
	}
	statuses := r.wait(localbus.TopicStatus, 2, 5*time.Second)
	if decodeJSON(t, statuses[len(statuses)-1])["inverter_link"] != "down" {
		t.Fatalf("der Link muss nach der Stille down gehen: %s", statuses)
	}
}

func TestPowadorConnectionTestClassifiesHonestly(t *testing.T) {
	w := startWandlerSim(t, 1)
	o := fastKaco()
	o.Poll, o.FirstPoll = time.Hour, time.Hour
	r := newRig(t, o)
	host, port := w.addr()

	ok := testRead(t, r, "ok", kacoSel(host, port, nil)) // address absent = 1
	if rd, _ := ok["reading"].(map[string]any); ok["ok"] != true || rd["pv_kw"] != 1.216 || len(rd) != 1 {
		t.Fatalf("gesunder Powador: %v", ok)
	}
	if res := testRead(t, r, "other", kacoSel(host, port, 2)); res["error_code"] != "no_answer" {
		t.Errorf("Adresse ohne Geraet am Bus: %v", res)
	}
	if res := testRead(t, r, "range", kacoSel(host, port, 33)); res["error_code"] != "invalid_request" || res["message"] != "RS485-Adresse muss zwischen 1 und 32 liegen" {
		t.Errorf("Adresse 33: %v", res)
	}
	if res := testRead(t, r, "zero", kacoSel(host, port, 0)); res["error_code"] != "invalid_request" {
		t.Errorf("Adresse 0 ist keine Busadresse: %v", res)
	}
	w.mu.Lock()
	w.cmdByte = 'n'
	w.mu.Unlock()
	res := testRead(t, r, "proto", kacoSel(host, port, 1))
	if res["error_code"] != "invalid_response" || !strings.Contains(res["message"].(string), `"n"`) || !strings.Contains(res["message"].(string), "anderes KACO-Protokoll") {
		t.Errorf("fremdes Kommando-Byte muss benannt werden: %v", res)
	}
	w.mu.Lock()
	w.cmdByte = '0'
	w.silent = true
	w.mu.Unlock()
	if res := testRead(t, r, "silent", kacoSel(host, port, 1)); res["error_code"] != "no_answer" {
		t.Errorf("stiller Bus: %v", res)
	}
	dead := freeAddr(t)
	dh, dp, _ := net.SplitHostPort(dead)
	if res := testRead(t, r, "dead", kacoSel(dh, dp, 1)); res["error_code"] != "unreachable" {
		t.Errorf("Wandler nicht erreichbar: %v", res)
	}
	if res := testRead(t, r, "noip", kacoSel("", 4196, 1)); res["error_code"] != "invalid_request" || res["message"] != "keine IP-Adresse" {
		t.Errorf("ohne IP: %v", res)
	}
}

func kacoSource(id, role, host string, port any, address any) map[string]any {
	s := kacoSel(host, port, address)
	s["id"] = id
	s["role"] = role
	s["interval_s"] = 5
	return s
}

func TestAPowadorSourceIsReadAsAnErzeugerOnly(t *testing.T) {
	w := startWandlerSim(t, 1)
	o := fastKaco()
	o.Poll, o.FirstPoll, o.SourcesFirstPoll, o.SourcesPoll = time.Hour, time.Hour, 50*time.Millisecond, 100*time.Millisecond
	r := newRig(t, o)
	r.collectSources()
	host, port := w.addr()
	plans, notes, _, ok := parseSourcesConfig(sourcesConfig(
		kacoSource("src-kaco", "pv-generation", host, port, 1),
		kacoSource("src-netz", "grid-meter", host, port, 1),
		kacoSource("src-adr", "pv-generation", host, port, 40),
	))
	if !ok || len(plans) != 2 {
		t.Fatalf("Plaene: %+v", plans)
	}
	all := ""
	for _, n := range notes {
		all += n.text + "\n"
	}
	if !strings.Contains(all, "Quelle src-kaco (pv-generation): kaco_serial "+host+":"+port+" Adresse 1 -> Leseplan (Powador #010)") ||
		!strings.Contains(all, "Quelle src-adr (pv-generation) NICHT VERDRAHTET: RS485-Adresse muss zwischen 1 und 32 liegen") {
		t.Errorf("Hinweise:\n%s", all)
	}
	if err := r.bus.Publish(sources.TopicConfig, sourcesConfig(
		kacoSource("src-kaco", "pv-generation", host, port, 1),
		kacoSource("src-netz", "grid-meter", host, port, 1),
	), true); err != nil {
		t.Fatal(err)
	}
	msg := decodeJSON(t, r.wait(sources.TopicPrefix+"src-kaco/telemetry", 1, 5*time.Second)[0])
	if msg["pv_power_kw"] != 1.216 || len(msg) != 2 {
		t.Fatalf("Erzeuger-Quelle: %v", msg)
	}
	time.Sleep(400 * time.Millisecond)
	if r.count(sources.TopicPrefix+"src-netz/telemetry") != 0 {
		t.Fatal("ein Powador misst kein Netz - als Netz-Zaehler nie veroeffentlichen")
	}
}
