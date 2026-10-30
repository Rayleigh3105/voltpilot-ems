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
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

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
	fremd     bool          // send a foreign frame before every answer
	nullStumm bool          // serial 0: header only, no inverter reply
	schlaeft  bool          // the inverter behind it never answers
	typ       uint16        // Deye device-type code at 0x0000 (0 = 0x0005)
	seriennr  string        // inverter serial at 0x0003 ("" = 2201234567)
	verzug    time.Duration // before every answer
	mu        sync.Mutex
	stumm     int // this many first frames get no answer at all
	anfragen  int
	verbunden []time.Time
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
			l.mu.Lock()
			l.verbunden = append(l.verbunden, time.Now())
			l.mu.Unlock()
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
		schweigt := l.stumm > 0
		if schweigt {
			l.stumm--
		}
		l.mu.Unlock()
		if schweigt {
			continue
		}
		time.Sleep(l.verzug)
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
	return einGeraetMit(t, addr, port, testTakt)
}

func einGeraetMit(t *testing.T, addr string, port int, takt Takt) (*Lauf, *geraet) {
	t.Helper()
	n := neuesTestnetz()
	n.ziele["10.77.0.34:"+strconv.Itoa(port)] = addr
	l, grund := Neu(Umgebung{BoxArt: geraetesuche.BoxArtDocker, LANHost: "10.77.0.20", Dial: n.dial, Takt: takt}, nil)
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

// VoltPilotGATE 30.10.2026 (N1): the logger was silent on the first frame for
// more than 1.5 s, two minutes later it answered in 113 ms. The repeat on a
// fresh session finds the Deye; a slow logger gets twice Zeitlimit.
func TestSolarmanWiederholtDenErstenRahmen(t *testing.T) {
	takt := Takt{JeSekunde: 100000, Zeitlimit: 150 * time.Millisecond}
	for _, f := range []struct {
		name                string
		logger              *v5Logger
		anfragen, verbunden int
	}{
		{"erster Rahmen ohne Antwort", &v5Logger{stumm: 1}, 2, 2},
		{"Antwort nach 1,5 Zeitlimit", &v5Logger{verzug: 225 * time.Millisecond}, 1, 1},
	} {
		f.logger.serial, f.logger.typ, f.logger.seriennr = 3115580613, 0x0006, "2409066698"
		addr := startV5Logger(t, f.logger)
		_, g := einGeraetMit(t, addr, 8899, takt)
		fund, ok := erkenneSolarman(context.Background(), g, 8899, nil)
		if !ok || fund.Schluessel != "solarman:3115580613" || fund.Erkennung != "sicher" ||
			fund.Familie != "hybrid_3p" || fund.Seriennummer != "2409066698" || *fund.Verbindung.Serial != 3115580613 {
			t.Fatalf("%s: %+v", f.name, fund)
		}
		f.logger.mu.Lock()
		anfragen, verbunden := f.logger.anfragen, len(f.logger.verbunden)
		f.logger.mu.Unlock()
		if anfragen != f.anfragen || verbunden != f.verbunden {
			t.Fatalf("%s: %d requests on %d connections, want %d on %d", f.name, anfragen, verbunden, f.anfragen, f.verbunden)
		}
	}
}

// The repeat opens its session through the pacer and stays inside
// AnfragenJeErkenner: frame 1, the repeat and frame 2 with the serial, never
// a fourth; a logger that stays silent gets two frames and no find.
func TestSolarmanWiederholungImTaktUndImBudget(t *testing.T) {
	takt := Takt{JeSekunde: 1, Zeitlimit: 150 * time.Millisecond}
	for _, f := range []struct {
		name     string
		logger   *v5Logger
		fund     bool
		anfragen int
	}{
		{"Wiederholung, dann Seriennummer", &v5Logger{stumm: 1, nullStumm: true}, true, AnfragenJeErkenner},
		{"bleibt stumm", &v5Logger{stumm: 99}, false, 2},
	} {
		f.logger.serial = 3115580613
		addr := startV5Logger(t, f.logger)
		_, g := einGeraetMit(t, addr, 8899, takt)
		fund, ok := erkenneSolarman(context.Background(), g, 8899, nil)
		if ok != f.fund || (ok && (fund.Schluessel != "solarman:3115580613" || fund.Erkennung != "sicher")) {
			t.Fatalf("%s: %v %+v", f.name, ok, fund)
		}
		f.logger.mu.Lock()
		anfragen, verbunden := f.logger.anfragen, f.logger.verbunden
		f.logger.mu.Unlock()
		if anfragen != f.anfragen || len(verbunden) != 2 {
			t.Fatalf("%s: %d requests on %d connections, want %d on 2", f.name, anfragen, len(verbunden), f.anfragen)
		}
		// One new connection per second: the second session waits for its
		// slot, not only for the deadline and the pause (0.4 s).
		if d := verbunden[1].Sub(verbunden[0]); d < 900*time.Millisecond {
			t.Fatalf("%s: second session after %v, the pacer allows one per second", f.name, d)
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

// wackel is an HTTP device on a weak Wi-Fi link: the first requests the test
// chooses are lost - delayed beyond Zeitlimit or the connection is cut - and
// the rest reach the simulator. It notes when each connection came.
type wackel struct {
	geraet    http.Handler
	verzug    time.Duration // a lost request waits this long, then the connection is cut
	mu        sync.Mutex
	verloren  int            // this many first requests are lost
	je        map[string]int // when set: this many first requests of each path are lost
	pfade     []string
	verbunden []time.Time
}

func (w *wackel) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	w.mu.Lock()
	w.pfade = append(w.pfade, r.URL.RequestURI())
	verloren := w.verloren > 0
	if verloren {
		w.verloren--
	}
	if w.je != nil {
		verloren = w.je[r.URL.RequestURI()] > 0
		if verloren {
			w.je[r.URL.RequestURI()]--
		}
	}
	w.mu.Unlock()
	if !verloren {
		w.geraet.ServeHTTP(rw, r)
		return
	}
	select {
	case <-time.After(w.verzug):
	case <-r.Context().Done():
	}
	if c, _, err := rw.(http.Hijacker).Hijack(); err == nil {
		_ = c.Close()
	}
}

func (w *wackel) gesehen() ([]string, []time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.pfade...), append([]time.Time(nil), w.verbunden...)
}

func startWackel(t *testing.T, w *wackel) string {
	t.Helper()
	srv := httptest.NewUnstartedServer(w)
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			w.mu.Lock()
			w.verbunden = append(w.verbunden, time.Now())
			w.mu.Unlock()
		}
	}
	srv.Start()
	t.Cleanup(srv.Close)
	return strings.TrimPrefix(srv.URL, "http://")
}

// VoltPilotGATE 30.10.2026: in one search of three the Shelly Pro 3 at
// 192.168.178.43 (-80 dBm) had port 80 open and was no find. Its first request
// is repeated once when the answer is late or the connection breaks; the
// repeat is in the recogniser's budget: /shelly, the repeat, GetStatus.
func TestShellyWiederholtDieErsteAnfrage(t *testing.T) {
	takt := Takt{JeSekunde: 100000, Zeitlimit: 150 * time.Millisecond}
	for _, f := range []struct {
		name   string
		verzug time.Duration
	}{
		{"Antwort nach dem Zeitlimit", 400 * time.Millisecond},
		{"Verbindung abgerissen", 0},
	} {
		w := &wackel{geraet: geraetesim.ShellyGen2(nil, "SPSW-003XE16EU", "1.4.4", 3, false, false),
			verzug: f.verzug, verloren: 1}
		_, g := einGeraetMit(t, startWackel(t, w), 80, takt)
		fund, ok := erkenneShelly(context.Background(), g, 80, nil)
		if !ok || fund.Schluessel != "shelly:10.77.0.34:80" || fund.Modell != "SPSW-003XE16EU" ||
			fund.Art != "schaltaktor" || fund.Kanaele != 3 || fund.Erkennung != "sicher" {
			t.Fatalf("%s: %v %+v", f.name, ok, fund)
		}
		pfade, _ := w.gesehen()
		if want := []string{"/shelly", "/shelly", "/rpc/Shelly.GetStatus"}; !reflect.DeepEqual(pfade, want) ||
			len(pfade) != AnfragenJeErkenner {
			t.Fatalf("%s: %v, want %v", f.name, pfade, want)
		}
	}
}

// VoltPilotGATE 30.10.2026: in one search of three the Shelly Pro 3 was found
// without its channels - /shelly answered, Shelly.GetStatus was lost. The
// follow-up request is repeated once like the first one; lost twice, the
// Shelly stays a find without channels, as before.
func TestShellyWiederholtGetStatus(t *testing.T) {
	takt := Takt{JeSekunde: 100000, Zeitlimit: 150 * time.Millisecond}
	const status = "/rpc/Shelly.GetStatus"
	for _, f := range []struct {
		name     string
		verzug   time.Duration
		verloren int
		kanaele  int
	}{
		{"einmal Antwort nach dem Zeitlimit", 400 * time.Millisecond, 1, 3},
		{"einmal Verbindung abgerissen", 0, 1, 3},
		{"immer Antwort nach dem Zeitlimit", 400 * time.Millisecond, 99, 0},
		{"immer Verbindung abgerissen", 0, 99, 0},
	} {
		w := &wackel{geraet: geraetesim.ShellyGen2(nil, "SPSW-003XE16EU", "1.4.4", 3, false, false),
			verzug: f.verzug, je: map[string]int{status: f.verloren}}
		_, g := einGeraetMit(t, startWackel(t, w), 80, takt)
		fund, ok := erkenneShelly(context.Background(), g, 80, nil)
		if !ok || fund.Schluessel != "shelly:10.77.0.34:80" || fund.Modell != "SPSW-003XE16EU" ||
			fund.Art != "schaltaktor" || fund.Kanaele != f.kanaele || fund.Erkennung != "sicher" ||
			fund.Verbindung.Communication != "shelly_http" {
			t.Fatalf("%s: %v %+v", f.name, ok, fund)
		}
		if got := slices.Contains(fund.Merkmale, "shelly_status"); got != (f.kanaele > 0) {
			t.Fatalf("%s: merkmale %v", f.name, fund.Merkmale)
		}
		pfade, _ := w.gesehen()
		if want := []string{"/shelly", status, status}; !reflect.DeepEqual(pfade, want) {
			t.Fatalf("%s: %v, want %v", f.name, pfade, want)
		}
	}
}

// Both requests lost once: the repeat of /shelly takes the second request of
// the budget, GetStatus the third - no request is left for its repeat, the
// Shelly is a find without channels (contract §3: at most 3 per recogniser).
func TestShellyGetStatusWiederholungImBudget(t *testing.T) {
	w := &wackel{geraet: geraetesim.ShellyGen2(nil, "SPSW-003XE16EU", "1.4.4", 3, false, false),
		je: map[string]int{"/shelly": 1, "/rpc/Shelly.GetStatus": 1}}
	_, g := einGeraetMit(t, startWackel(t, w), 80, Takt{JeSekunde: 100000, Zeitlimit: 150 * time.Millisecond})
	fund, ok := erkenneShelly(context.Background(), g, 80, nil)
	if !ok || fund.Modell != "SPSW-003XE16EU" || fund.Kanaele != 0 {
		t.Fatalf("%v %+v", ok, fund)
	}
	pfade, _ := w.gesehen()
	if want := []string{"/shelly", "/shelly", "/rpc/Shelly.GetStatus"}; !reflect.DeepEqual(pfade, want) ||
		len(pfade) != AnfragenJeErkenner {
		t.Fatalf("%v, want %v", pfade, want)
	}
}

// The repeat of GetStatus opens its connection through the pacer as well.
func TestShellyGetStatusWiederholungImTakt(t *testing.T) {
	w := &wackel{geraet: geraetesim.ShellyGen2(nil, "SPSW-003XE16EU", "1.4.4", 3, false, false),
		je: map[string]int{"/rpc/Shelly.GetStatus": 1}}
	_, g := einGeraetMit(t, startWackel(t, w), 80, Takt{JeSekunde: 1, Zeitlimit: 150 * time.Millisecond})
	if fund, ok := erkenneShelly(context.Background(), g, 80, nil); !ok || fund.Kanaele != 3 {
		t.Fatalf("%v %+v", ok, fund)
	}
	_, verbunden := w.gesehen()
	if len(verbunden) != 3 {
		t.Fatalf("%d connections, want 3 (/shelly, lost GetStatus, repeat)", len(verbunden))
	}
	for i := 1; i < len(verbunden); i++ {
		if d := verbunden[i].Sub(verbunden[i-1]); d < 900*time.Millisecond {
			t.Fatalf("connection %d after %v, the pacer allows one per second", i+1, d)
		}
	}
}

// The repeat opens its connection through the pacer: with one new connection
// per second it comes a slot later, not only after the deadline and the pause.
func TestHTTPWiederholungImTakt(t *testing.T) {
	w := &wackel{geraet: geraetesim.ShellyGen2(nil, "SPSW-003XE16EU", "1.4.4", 3, false, false), verloren: 1}
	_, g := einGeraetMit(t, startWackel(t, w), 80, Takt{JeSekunde: 1, Zeitlimit: 150 * time.Millisecond})
	if _, ok := erkenneShelly(context.Background(), g, 80, nil); !ok {
		t.Fatal("no find after the repeat")
	}
	_, verbunden := w.gesehen()
	if len(verbunden) != 3 {
		t.Fatalf("%d connections, want 3 (lost, repeat, GetStatus)", len(verbunden))
	}
	for i := 1; i < len(verbunden); i++ {
		if d := verbunden[i].Sub(verbunden[i-1]); d < 900*time.Millisecond {
			t.Fatalf("connection %d after %v, the pacer allows one per second", i+1, d)
		}
	}
}

// Only the device's first request, only once: a device that never answers in
// time gets /shelly twice and every later request of the port 80 chain (and
// of the network gear) once - the chain does not double. An answer that does
// not match is never repeated.
func TestHTTPWiederholungNurEinmalJeGeraet(t *testing.T) {
	takt := Takt{JeSekunde: 100000, Zeitlimit: 100 * time.Millisecond}
	stumm := &wackel{geraet: http.NotFoundHandler(), verzug: 300 * time.Millisecond, verloren: 99}
	l, g := einGeraetMit(t, startWackel(t, stumm), 80, takt)
	if l.erkenne(context.Background(), g) {
		t.Fatal("a silent device became a find")
	}
	pfade, _ := stumm.gesehen()
	want := []string{"/shelly", "/shelly", "/api/status?filter=sse,typ,fwv", "/solar_api/GetAPIVersion.cgi",
		"/api/system/status", "/api/system", "/"}
	if !reflect.DeepEqual(pfade, want) {
		t.Fatalf("silent device: %v, want %v", pfade, want)
	}

	p := &geraetesim.Protokoll{}
	for _, f := range []struct {
		name   string
		geraet http.Handler
		want   []string
	}{
		{"404", http.NotFoundHandler(), []string{"GET /shelly"}},
		{"kein Shelly", geraetesim.Goe(p, "012345", "go-eCharger", "56.1"), []string{"GET /shelly"}},
		{"Anmeldung", geraetesim.Geraet{Protokoll: p, Pfade: map[string]geraetesim.Antwort{
			"/shelly": {Status: 401, Body: map[string]any{"code": 401}}}}, []string{"GET /shelly"}},
	} {
		w := &wackel{geraet: f.geraet}
		_, g := einGeraetMit(t, startWackel(t, w), 80, takt)
		if fund, ok := erkenneShelly(context.Background(), g, 80, nil); ok {
			t.Fatalf("%s: %+v", f.name, fund)
		}
		pfade, _ := w.gesehen()
		got := make([]string, len(pfade))
		for i, pf := range pfade {
			got[i] = "GET " + pf
		}
		if !reflect.DeepEqual(got, f.want) {
			t.Fatalf("%s: %v, want %v", f.name, got, f.want)
		}
	}
}

func TestAbgerissenUnterscheidetAntwortUndVerlust(t *testing.T) {
	refused := &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
	reset := &net.OpError{Op: "read", Net: "tcp", Err: os.NewSyscallError("read", syscall.ECONNRESET)}
	for _, f := range []struct {
		err  error
		want bool
	}{
		{context.DeadlineExceeded, true},
		{io.EOF, true},
		{io.ErrUnexpectedEOF, true},
		{reset, true},
		{refused, false},
		{errBudget, false},
		{errNichtIm, false},
	} {
		if got := abgerissen(f.err); got != f.want {
			t.Fatalf("%v: %v, want %v", f.err, got, f.want)
		}
	}
}

// Zeitlimit bounds the request, not the wait for its slot: with the pacer
// busy for longer than Zeitlimit a healthy Shelly answers its first request -
// no repeat, no lost find.
func TestHTTPZeitlimitBeginntNachDemTakt(t *testing.T) {
	w := &wackel{geraet: geraetesim.ShellyGen2(nil, "SPSW-003XE16EU", "1.4.4", 3, false, false)}
	l, g := einGeraetMit(t, startWackel(t, w), 80, Takt{JeSekunde: 2, Zeitlimit: 150 * time.Millisecond})
	for i := 0; i < 2; i++ { // other devices took the next slots (0.5 s each)
		if err := l.takt.warte(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	fund, ok := erkenneShelly(context.Background(), g, 80, nil)
	if !ok || fund.Modell != "SPSW-003XE16EU" {
		t.Fatalf("%v %+v", ok, fund)
	}
	if pfade, _ := w.gesehen(); !reflect.DeepEqual(pfade, []string{"/shelly", "/rpc/Shelly.GetStatus"}) {
		t.Fatalf("%v", pfade)
	}
}
