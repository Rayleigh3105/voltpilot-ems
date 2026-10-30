package suche

// The recognisers at their edges: a Solarman logger that first sends a
// foreign frame (Discovery 30.10.: a 118-byte frame of its own), one that
// answers serial 0 only with its header (then the second frame carries the
// serial), a sleeping inverter behind its logger; a page title that names a
// person; the Shelly Gen1 meter; the sorting of weitere.

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche/geraetesim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5/v5sim"
)

// v5Logger answers like a real logger whose behaviour the test chooses.
type v5Logger struct {
	ln        net.Listener
	serial    uint32
	fremd     bool // send a foreign frame before every answer
	nullStumm bool // serial 0: header only, no inverter reply
	schlaeft  bool // the inverter behind it never answers
	mu        sync.Mutex
	anfragen  int
}

func startV5Logger(t *testing.T, l *v5Logger) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	l.ln = ln
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go l.handle(c)
		}
	}()
	return ln.Addr().String()
}

func (l *v5Logger) handle(c net.Conn) {
	defer c.Close()
	for {
		kopf := make([]byte, 3)
		if _, err := io.ReadFull(c, kopf); err != nil {
			return
		}
		rest := make([]byte, int(binary.LittleEndian.Uint16(kopf[1:]))+10)
		if _, err := io.ReadFull(c, rest); err != nil {
			return
		}
		frame := append(kopf, rest...)
		seq := binary.LittleEndian.Uint16(frame[5:])
		angefragt := binary.LittleEndian.Uint32(frame[7:])
		l.mu.Lock()
		l.anfragen++
		l.mu.Unlock()
		if l.fremd {
			fremd := v5sim.ResponseFrame(l.serial, seq+7, 0x01, 0x00, make([]byte, 90))
			binary.LittleEndian.PutUint16(fremd[3:], 0x4710) // the logger's own heartbeat
			fremd[len(fremd)-2] = solarmanv5.Checksum(fremd)
			_, _ = c.Write(fremd)
		}
		var antwort []byte
		switch {
		case l.schlaeft || (l.nullStumm && angefragt == 0):
			antwort = v5sim.ResponseFrame(l.serial, seq, 0x01, 0x00, nil)
		default:
			regs := append([]uint16{0x0005, 0, 0}, geraetesim.Text("2201234567", 5)...)
			body := []byte{1, 0x03, byte(2 * len(regs))}
			for _, r := range regs {
				body = binary.BigEndian.AppendUint16(body, r)
			}
			crc := solarmanv5.CRC16(body)
			body = append(body, byte(crc), byte(crc>>8))
			antwort = v5sim.ResponseFrame(l.serial, seq, solarmanv5.FrameTypeSolar, 0x01, body)
		}
		if _, err := c.Write(antwort); err != nil {
			return
		}
	}
}

func einGeraet(t *testing.T, addr string, port int) (*Lauf, *geraet) {
	t.Helper()
	n := neuesTestnetz()
	n.ziele["10.77.0.34:"+strconv.Itoa(port)] = addr
	l, grund := Neu(Umgebung{BoxArt: geraetesuche.BoxArtDocker, LANHost: "10.77.0.20", Dial: n.dial, Takt: testTakt}, nil)
	if grund != "" {
		t.Fatal(grund)
	}
	return l, &geraet{lauf: l, ip: netip.MustParseAddr("10.77.0.34"), offen: map[int]bool{port: true}}
}

func TestSolarmanUeberliestFremdeRahmenUndLerntDieSeriennummer(t *testing.T) {
	for _, f := range []struct {
		name      string
		logger    *v5Logger
		erkennung string
		anfragen  int
		spannung  string
		seriennr  string
	}{
		{"fremder Rahmen zuerst", &v5Logger{serial: 3115580613, fremd: true}, "sicher", 1, "lv", "2201234567"},
		{"Seriennummer 0 nur im Kopf", &v5Logger{serial: 3115580613, nullStumm: true}, "sicher", 2, "lv", "2201234567"},
		{"Wechselrichter schläft", &v5Logger{serial: 3115580613, schlaeft: true}, "wahrscheinlich", 2, "", ""},
	} {
		addr := startV5Logger(t, f.logger)
		_, g := einGeraet(t, addr, 8899)
		fund, ok := erkenneSolarman(context.Background(), g, 8899, nil)
		if !ok || fund.Schluessel != "solarman:3115580613" || fund.Erkennung != f.erkennung ||
			fund.Spannung != f.spannung || fund.Seriennummer != f.seriennr || *fund.Verbindung.Serial != 3115580613 {
			t.Fatalf("%s: %+v", f.name, fund)
		}
		f.logger.mu.Lock()
		anfragen := f.logger.anfragen
		f.logger.mu.Unlock()
		if anfragen != f.anfragen {
			t.Fatalf("%s: %d requests, want %d", f.name, anfragen, f.anfragen)
		}
	}
}

func TestSeitentitelBehaeltNurDasModell(t *testing.T) {
	p := &geraetesim.Protokoll{}
	n := neuesTestnetz()
	n.http(t, "10.77.0.1:80", geraetesim.Router(p, "FRITZ!Box 7590 - Annas Netz"))
	n.http(t, "10.77.0.2:80", geraetesim.Router(p, "Drucker im Büro"))
	l, _ := Neu(Umgebung{BoxArt: geraetesuche.BoxArtDocker, LANHost: "10.77.0.20", Dial: n.dial, Takt: testTakt}, nil)
	g := &geraet{lauf: l, ip: netip.MustParseAddr("10.77.0.1"), offen: map[int]bool{80: true}}
	f, ok := l.netztechnik(context.Background(), g)
	if !ok || f.Modell != "FRITZ!Box 7590" || f.Art != "router" {
		t.Fatalf("router: %+v", f)
	}
	drucker := &geraet{lauf: l, ip: netip.MustParseAddr("10.77.0.2"), offen: map[int]bool{80: true}}
	if f, ok := l.netztechnik(context.Background(), drucker); ok {
		t.Fatalf("a printer became network gear: %+v", f)
	}
}

func TestWeitereNurAlsArt(t *testing.T) {
	for _, f := range []struct {
		g    geraet
		want string
	}{
		{geraet{mac: mac("da:a1:19:01:02:03")}, "telefon_tablet"},
		{geraet{hinweis: hinweise{mdns: map[string]bool{"telefon": true}}}, "telefon_tablet"},
		{geraet{hinweis: hinweise{mdns: map[string]bool{"rechner": true}}}, "rechner"},
		{geraet{mac: mac("00:1b:21:01:02:03")}, "unbekannt"},
		{geraet{}, "unbekannt"},
	} {
		if got := weitereArt(&f.g); got != f.want {
			t.Fatalf("%+v: %s, want %s", f.g, got, f.want)
		}
	}
}

// Every pair of the catalog has a recogniser that can produce it, and every
// recogniser of a port chain is a word of the contract.
func TestJedesKatalogPaarHatEinenErkenner(t *testing.T) {
	inKette := map[string]bool{"netztechnik": true, "modbus_offen": true}
	for _, k := range kette {
		for _, e := range k.erkenner {
			if !enthaelt(geraetesuche.Erkenner, e.name) || enthaelt(geraetesuche.Wege, e.name) {
				t.Fatalf("recogniser %q is no contract word", e.name)
			}
			inKette[e.name] = true
		}
	}
	for _, z := range geraetesuche.Katalog {
		if !inKette[z.Erkenner] {
			t.Fatalf("catalog pair (%s, %s) has no recogniser", z.Erkenner, z.Art)
		}
	}
	for _, b := range []Bekannt{{Communication: "solarman_v5", IP: "10.77.0.35", Serial: "0x1234"},
		{Communication: "shelly_http", IP: "10.77.0.36"}, {Communication: "fronius_sunspec", IP: "10.77.0.37"},
		{Communication: "modbus_tcp", IP: "10.77.0.38", Rolle: "plant-controller"}, {Communication: "kaco_http", IP: "10.77.0.39"}} {
		f, ok := bekanntFund(b)
		if !ok || !f.LiestBoxSchon {
			t.Fatalf("%+v: %+v", b, f)
		}
		f.Anbindung = mustRow(t, f).Anbindung(geraetesuche.BoxArtDocker)
		if f.Erkennung == geraetesuche.ErkennungUnbekannt {
			f.Anbindung = geraetesuche.AnbindungSelbstBeschreiben
		}
		bereich, _ := waehleNetze(Umgebung{LANHost: "10.77.0.20"})
		if err := geraetesuche.PruefeFund(f, []probe.Bereich{bereich[0].bereich}); err != nil {
			t.Fatalf("%+v: %v", b, err)
		}
	}
}

func mustRow(t *testing.T, f geraetesuche.Fund) geraetesuche.KatalogZeile {
	t.Helper()
	z, ok := geraetesuche.KatalogPaar(f.Erkenner, f.Art)
	if !ok {
		t.Fatalf("pair (%s, %s)", f.Erkenner, f.Art)
	}
	return z
}
