package suche

// The recognisers at their edges: a Solarman logger that first sends a
// foreign frame (Discovery 30.10.: a 118-byte frame of its own), one that
// answers serial 0 only with its header (then the second frame carries the
// serial), a sleeping inverter behind its logger; a page title that names a
// person; the Shelly Gen1 meter; the sorting of weitere.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/netip"
	"os"
	"reflect"
	"strconv"
	"strings"
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
	fremd     bool   // send a foreign frame before every answer
	nullStumm bool   // serial 0: header only, no inverter reply
	schlaeft  bool   // the inverter behind it never answers
	typ       uint16 // Deye device-type code at 0x0000 (0 = 0x0005)
	seriennr  string // inverter serial at 0x0003 ("" = 2201234567)
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
			typ, sn := l.typ, l.seriennr
			if typ == 0 {
				typ = 0x0005
			}
			if sn == "" {
				sn = "2201234567"
			}
			regs := append([]uint16{typ, 0, 0}, geraetesim.Text(sn, 5)...)
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

// The type code at 0x0000 names the family (VoltPilotGATE 30.10.2026: 0x0006
// came without one, M2). A code the source does not map names nothing.
func TestSolarmanNenntDieFamilieAusDemTyp(t *testing.T) {
	for _, f := range []struct {
		typ                           uint16
		hersteller, familie, spannung string
		merkmal                       string
	}{
		{0x0006, "deye", "hybrid_3p", "hv", "deye_typ_0x0006"},
		{0x0005, "deye", "hybrid_3p", "lv", "deye_typ_0x0005"},
		{0x0002, "deye", "string", "", "deye_typ_0x0002"},
		{0x0103, "deye", "hybrid_1p", "", "deye_typ_0x0103"},
		{0x0400, "deye", "micro", "", "deye_typ_0x0400"},
		{0x0009, "", "", "", ""},
	} {
		addr := startV5Logger(t, &v5Logger{serial: 3115580613, typ: f.typ})
		_, g := einGeraet(t, addr, 8899)
		fund, ok := erkenneSolarman(context.Background(), g, 8899, nil)
		if !ok || fund.Erkennung != "sicher" || fund.Hersteller != f.hersteller || fund.Familie != f.familie ||
			fund.Spannung != f.spannung {
			t.Fatalf("0x%04x: %+v", f.typ, fund)
		}
		if mit := enthaelt(fund.Merkmale, f.merkmal); mit != (f.merkmal != "") {
			t.Fatalf("0x%04x: merkmale %v", f.typ, fund.Merkmale)
		}
		if f.merkmal == "" && len(fund.Merkmale) != 2 {
			t.Fatalf("0x%04x: a type merkmal without a source: %v", f.typ, fund.Merkmale)
		}
		if err := geraetesuche.PruefeFund(mitAnbindung(fund), g.lauf.bereiche); err != nil {
			t.Fatalf("0x%04x: %v", f.typ, err)
		}
	}
}

func mitAnbindung(f geraetesuche.Fund) geraetesuche.Fund {
	f.Anbindung = geraetesuche.AnbindungUebernehmen
	return f
}

// Every Deye find of the shared vectors is what the recogniser really sends
// for that logger: the vectors are examples of the box's output, so a field
// the box leaves out (familie before M2) shows here. The address is the
// simulator's; everything else is compared.
func TestSolarmanGibtDieDeyeFundeDerVektoren(t *testing.T) {
	raw, err := os.ReadFile("../../../../../docs/contracts/v2/geraetesuche-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Stand, Ergebnis struct {
			Gueltig []struct {
				Payload struct {
					Funde []geraetesuche.Fund `json:"funde"`
				} `json:"payload"`
			} `json:"gueltig"`
		}
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	geprueft := map[string]bool{}
	for _, fall := range append(v.Stand.Gueltig, v.Ergebnis.Gueltig...) {
		for _, want := range fall.Payload.Funde {
			typ := ""
			for _, m := range want.Merkmale {
				if strings.HasPrefix(m, "deye_typ_0x") {
					typ = strings.TrimPrefix(m, "deye_typ_0x")
				}
			}
			if want.Erkenner != "solarman" || typ == "" {
				continue
			}
			want.Anbindung, want.LiestBoxSchon, want.Verbindung.IP = "", false, ""
			roh, _ := json.Marshal(want)
			if geprueft[string(roh)] {
				continue
			}
			geprueft[string(roh)] = true
			code, err := strconv.ParseUint(typ, 16, 16)
			if err != nil || want.Verbindung.Serial == nil {
				t.Fatalf("vector find %s: type %q", roh, typ)
			}
			addr := startV5Logger(t, &v5Logger{serial: *want.Verbindung.Serial, typ: uint16(code),
				seriennr: want.Seriennummer})
			_, g := einGeraet(t, addr, want.Verbindung.Port)
			got, ok := erkenneSolarman(context.Background(), g, want.Verbindung.Port, nil)
			got.Verbindung.IP = ""
			if !ok || !reflect.DeepEqual(got, want) {
				t.Fatalf("recogniser differs from the vectors\n got  %+v\n want %+v", got, want)
			}
		}
	}
	if len(geprueft) == 0 {
		t.Fatal("no Deye find in the vectors")
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

// The TL-WR840N login page has no <title>; its model stands only in
// var modelName (VoltPilotGATE 30.10.2026, M3). Only the model of the fixed
// pattern is kept - not the description beside it, not a free text.
func TestSeitenmodellErkenntTPLinkOhneTitel(t *testing.T) {
	p := &geraetesim.Protokoll{}
	n := neuesTestnetz()
	n.http(t, "10.77.0.1:80", geraetesim.TPLink(p, "Archer C6"))
	n.http(t, "10.77.0.24:80", geraetesim.TPLink(p, "TL-WR840N"))
	n.http(t, "10.77.0.25:80", geraetesim.TPLink(p, "Annas WLAN"))
	l, _ := Neu(Umgebung{BoxArt: geraetesuche.BoxArtDocker, LANHost: "10.77.0.20", Dial: n.dial, Takt: testTakt}, nil)
	l.wahl[0].gateway = netip.MustParseAddr("10.77.0.1")
	for _, f := range []struct {
		ip, art, modell string
	}{
		{"10.77.0.24", "zugangspunkt", "TL-WR840N"},
		{"10.77.0.1", "router", "Archer C6"},
	} {
		g := &geraet{lauf: l, ip: netip.MustParseAddr(f.ip), offen: map[int]bool{80: true}}
		fund, ok := l.netztechnik(context.Background(), g)
		if !ok || fund.Art != f.art || fund.Hersteller != "tp-link" || fund.Modell != f.modell ||
			len(fund.Merkmale) != 1 || fund.Merkmale[0] != "seitenmodell" {
			t.Fatalf("%s: %+v", f.ip, fund)
		}
		fund.Anbindung = geraetesuche.AnbindungNurAnzeige
		if err := geraetesuche.PruefeFund(fund, l.bereiche); err != nil {
			t.Fatalf("%s: %v", f.ip, err)
		}
	}
	frei := &geraet{lauf: l, ip: netip.MustParseAddr("10.77.0.25"), offen: map[int]bool{80: true}}
	if f, ok := l.netztechnik(context.Background(), frei); ok {
		t.Fatalf("a free text became a model: %+v", f)
	}
}

// The vendor list knows the TP-Link and High-Flying radio modules of
// VoltPilotGATE (30.10.2026); a TP-Link hint alone makes only the gateway
// network gear - plugs and cameras of the maker share its blocks.
func TestFunkmodulKenntTPLinkUndHighFlying(t *testing.T) {
	if Funkmodul(mac("dc:62:79:01:02:03")) != "tp-link" || Funkmodul(mac("d4:27:87:01:02:03")) != "high-flying" ||
		Funkmodul(mac("de:62:79:01:02:03")) != "" {
		t.Fatal("vendor list")
	}
	n := neuesTestnetz()
	l, _ := Neu(Umgebung{BoxArt: geraetesuche.BoxArtDocker, LANHost: "10.77.0.20", Dial: n.dial, Takt: testTakt}, nil)
	l.wahl[0].gateway = netip.MustParseAddr("10.77.0.1")
	gw := &geraet{lauf: l, ip: netip.MustParseAddr("10.77.0.1"), offen: map[int]bool{}, hinweis: hinweise{funkmodul: "tp-link"}}
	if f, ok := l.netztechnik(context.Background(), gw); !ok || f.Art != "router" || f.Hersteller != "tp-link" ||
		f.Merkmale[0] != "funkmodul_tp_link" {
		t.Fatalf("gateway: %+v", f)
	}
	steckdose := &geraet{lauf: l, ip: netip.MustParseAddr("10.77.0.30"), offen: map[int]bool{}, hinweis: hinweise{funkmodul: "tp-link"}}
	if f, ok := l.netztechnik(context.Background(), steckdose); ok {
		t.Fatalf("a TP-Link plug became network gear: %+v", f)
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
