package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// dongle is a Huawei behind its Smart Dongle: FC3/FC6/FC16 on a register
// image, deaf for `taub` after each connect, `stur` registers ignore writes.
type dongle struct {
	ln    net.Listener
	mu    sync.Mutex
	regs  map[uint16]uint16
	taub  time.Duration
	stur  map[uint16]bool
	fcs   []byte
	ueber int
}

func startDongle(t *testing.T, regs map[uint16]uint16) *dongle {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	d := &dongle{ln: ln, regs: regs, stur: map[uint16]bool{}}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go d.serve(c)
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return d
}

func (d *dongle) serve(c net.Conn) {
	defer c.Close()
	seit := time.Now()
	for {
		hdr := make([]byte, 7)
		if _, err := io.ReadFull(c, hdr); err != nil {
			return
		}
		body := make([]byte, int(binary.BigEndian.Uint16(hdr[4:]))-1)
		if _, err := io.ReadFull(c, body); err != nil {
			return
		}
		d.mu.Lock()
		if time.Since(seit) < d.taub {
			d.ueber++
			d.mu.Unlock()
			continue
		}
		d.fcs = append(d.fcs, body[0])
		addr := binary.BigEndian.Uint16(body[1:])
		var resp []byte
		switch body[0] {
		case 3:
			n := binary.BigEndian.Uint16(body[3:])
			resp = []byte{3, byte(2 * n)}
			for i := uint16(0); i < n; i++ {
				resp = binary.BigEndian.AppendUint16(resp, d.regs[addr+i])
			}
		case 6:
			if !d.stur[addr] {
				d.regs[addr] = binary.BigEndian.Uint16(body[3:])
			}
			resp = body[:5]
		case 16:
			n := binary.BigEndian.Uint16(body[3:])
			if !d.stur[addr] {
				for i := uint16(0); i < n; i++ {
					d.regs[addr+i] = binary.BigEndian.Uint16(body[6+2*i:])
				}
			}
			resp = body[:5]
		default:
			resp = []byte{body[0] | 0x80, 1}
		}
		d.mu.Unlock()
		out := make([]byte, 7, 7+len(resp))
		copy(out, hdr[:4])
		binary.BigEndian.PutUint16(out[4:], uint16(len(resp)+1))
		out[6] = hdr[6]
		_, _ = c.Write(append(out, resp...))
	}
}

func (d *dongle) u32(a uint16) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return int(uint32(d.regs[a])<<16 | uint32(d.regs[a+1]))
}

func anlage() map[uint16]uint16 {
	m := map[uint16]uint16{37760: 512, 37762: 2, 47086: 2, 47100: 0, 47083: 0, 47246: 0, 47087: 0}
	put := func(a uint16, v int32) { m[a], m[a+1] = uint16(uint32(v)>>16), uint16(uint32(v)) }
	put(32064, 0)
	put(32080, 110)
	put(37113, -400)
	put(37765, -110)
	put(47075, 2500)
	put(47077, 2500)
	return m
}

func folgeHalten() []schritt {
	return []schritt{{Role: "max_charge_power", FC: 16, Addr: 47075, Value: 0, Count: 2},
		{Role: "max_discharge_power", FC: 16, Addr: 47077, Value: 0, Count: 2}}
}

func testLauf(t *testing.T, d *dongle, folge []schritt) (*lauf, *[]eintrag) {
	var log []eintrag
	var mu sync.Mutex
	p := &protokoll{jetzt: time.Now, out: []func(eintrag){func(e eintrag) { mu.Lock(); log = append(log, e); mu.Unlock() }}}
	return &lauf{v: verbindung{ziel: d.ln.Addr().String(), unit: 1, pause: 120 * time.Millisecond, timeout: 400 * time.Millisecond},
		p: p, folge: folge, halten: 150 * time.Millisecond, takt: 50 * time.Millisecond,
		sicherung: filepath.Join(t.TempDir(), "sicherung.json"), herstellFrist: 2 * time.Second, herstellAbstand: 50 * time.Millisecond}, &log
}

// Only the intent registers of huawei.json, their encoding and bounds.
func TestDieFolgeBleibtInDenAbsichtsregistern(t *testing.T) {
	if err := pruefeFolge(folgeHalten(), 1000); err != nil {
		t.Fatal(err)
	}
	for _, f := range []struct {
		name string
		s    schritt
		wort string
	}{
		{"Netzparameter", schritt{FC: 6, Addr: 47415, Value: 1}, "nicht freigegeben"},
		{"Uhrzeit", schritt{FC: 16, Addr: 40000, Value: 0, Count: 2}, "nicht freigegeben"},
		{"SoC-Modus", schritt{FC: 6, Addr: 47246, Value: 1}, "ausserhalb"},
		{"zu viel Leistung", schritt{FC: 16, Addr: 47247, Value: 1500, Count: 2}, "ausserhalb"},
		{"U32 als U16", schritt{FC: 6, Addr: 47075, Value: 0}, "U32"},
		{"Arbeitsmodus fremd", schritt{FC: 6, Addr: 47086, Value: 5}, "ausserhalb"},
	} {
		if err := pruefeFolge([]schritt{f.s}, 1000); err == nil || !strings.Contains(err.Error(), f.wort) {
			t.Errorf("%s: %v", f.name, err)
		}
	}
	if pruefeFolge(nil, 1000) == nil {
		t.Error("leere Folge")
	}
}

// The run reads and saves the originals before the first write, writes with
// read-back, waits the pause after each connect and restores every original.
func TestEinLaufSchreibtHaeltUndStelltWiederHer(t *testing.T) {
	d := startDongle(t, anlage())
	d.taub = 100 * time.Millisecond
	l, log := testLauf(t, d, folgeHalten())
	l.schnell = 60 * time.Millisecond
	var waehrend []int
	l.p.out = append(l.p.out, func(e eintrag) {
		if e.Schritt == "beobachtung" {
			waehrend = append(waehrend, int(e.Messung["r47075"]))
		}
	})
	res := l.run(context.Background())
	if res.Unerwartet != "" || !res.Hergestellt || res.Originale[47075] != 2500 || res.Originale[47077] != 2500 {
		t.Fatalf("%+v", res)
	}
	if d.u32(47075) != 2500 || d.u32(47077) != 2500 {
		t.Fatalf("nicht wiederhergestellt: %d %d", d.u32(47075), d.u32(47077))
	}
	if len(waehrend) == 0 || waehrend[0] != 0 {
		t.Fatalf("waehrend des Haltens muss 0 stehen: %v", waehrend)
	}
	if d.ueber != 0 {
		t.Fatalf("%d Anfragen vor der Wartezeit", d.ueber)
	}
	raw, err := os.ReadFile(l.sicherung)
	if err != nil || !strings.Contains(string(raw), "2500") {
		t.Fatalf("Sicherung: %s %v", raw, err)
	}
	var geschrieben, hergestellt, schnell int
	for _, e := range *log {
		switch e.Schritt {
		case "einschwingen":
			schnell++
		case "schreiben":
			geschrieben++
			if e.Alt == nil || *e.Alt != 2500 || e.Gelesen == nil || *e.Gelesen != 0 {
				t.Errorf("Protokoll schreiben: %+v", e)
			}
		case "wiederherstellen":
			hergestellt++
		}
	}
	if geschrieben != 2 || hergestellt != 2 || schnell == 0 {
		t.Fatalf("Protokoll: %d geschrieben, %d wiederhergestellt, %d schnell", geschrieben, hergestellt, schnell)
	}
}

// A read-back that does not hold ends the run at once and restores what was
// written; a register that stays off is named, the exit is not "restored".
func TestUnerwartetesRuecklesenBrichtAbUndMeldetDenZustand(t *testing.T) {
	d := startDongle(t, anlage())
	d.stur[47077] = true // takes no write
	l, _ := testLauf(t, d, folgeHalten())
	res := l.run(context.Background())
	if !strings.Contains(res.Unerwartet, "Ruecklesen 47077") || !res.Hergestellt || d.u32(47075) != 2500 {
		t.Fatalf("%+v 47075=%d", res, d.u32(47075))
	}

	d2 := startDongle(t, anlage())
	l2, _ := testLauf(t, d2, folgeHalten())
	l2.p.out = append(l2.p.out, func(e eintrag) {
		if e.Schritt == "beobachtung" {
			d2.mu.Lock()
			d2.stur[47075] = true // stops taking writes after the first
			d2.mu.Unlock()
		}
	})
	res = l2.run(context.Background())
	if res.Hergestellt || res.Abweichungen[47075] != 0 {
		t.Fatalf("eine nicht bestaetigte Wiederherstellung muss gemeldet werden: %+v", res)
	}
}

// A connection lost before the restore is retried until it comes back.
func TestWiederherstellenWartetAufDieVerbindung(t *testing.T) {
	d := startDongle(t, anlage())
	addr := d.ln.Addr().String()
	l, _ := testLauf(t, d, folgeHalten())
	l.p.out = append(l.p.out, func(e eintrag) {
		if e.Schritt == "beobachtung" && d.ln != nil {
			_ = d.ln.Close() // the tunnel drops
			go func() {
				time.Sleep(300 * time.Millisecond)
				ln, err := net.Listen("tcp", addr) // ... and comes back
				if err != nil {
					return
				}
				d.ln = ln
				go func() {
					for {
						c, err := ln.Accept()
						if err != nil {
							return
						}
						go d.serve(c)
					}
				}()
			}()
		}
	})
	l.halten = 120 * time.Millisecond
	res := l.run(context.Background())
	if !res.Hergestellt || d.u32(47075) != 2500 || d.u32(47077) != 2500 {
		t.Fatalf("%+v", res)
	}
	_ = d.ln.Close()
}

// Ctrl-C during the hold still restores.
func TestAbbruchImHaltenStelltWiederHer(t *testing.T) {
	d := startDongle(t, anlage())
	l, _ := testLauf(t, d, folgeHalten())
	l.halten = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	l.p.out = append(l.p.out, func(e eintrag) {
		if e.Schritt == "schreiben" && e.Register == 47077 {
			cancel()
		}
	})
	done := make(chan ergebnis)
	go func() { done <- l.run(ctx) }()
	select {
	case res := <-done:
		if !res.Hergestellt || d.u32(47075) != 2500 || d.u32(47077) != 2500 {
			t.Fatalf("%+v", res)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Abbruch beendet das Halten nicht")
	}
}

// The adapter's output file ({plan:{planned:[...]}}) is read as it is.
func TestFolgeDateiDesAdapters(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f.json")
	raw, _ := json.Marshal(map[string]any{"plan": map[string]any{"writes": []any{}, "planned": []map[string]any{
		{"role": "force_direction", "fc": 6, "addr": 47100, "value": 0, "encode": map[string]any{"kind": "enum"}, "bench_pending": true}}}})
	_ = os.WriteFile(p, raw, 0o600)
	f, err := leseFolgeDatei(p)
	if err != nil || len(f) != 1 || f[0].Addr != 47100 || f[0].FC != 6 {
		t.Fatalf("%+v %v", f, err)
	}
}

// The survey prints no serial number and reads every field whole.
func TestErhebungOhneSeriennummer(t *testing.T) {
	m := anlage()
	for i, r := range []uint16{0x5355, 0x4e32, 0x3030, 0x302d, 0x0053} { // "SUN2000-", NUL, Rest
		m[30000+uint16(i)] = r
	}
	m[30015], m[30016] = 0x4142, 0x4344
	d := startDongle(t, m)
	out, err := erhebe(context.Background(), verbindung{ziel: d.ln.Addr().String(), unit: 1, pause: 10 * time.Millisecond, timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if out["geraet"]["modell"] != "SUN2000-" || !strings.Contains(out["geraet"]["seriennummer"].(string), "nicht ausgegeben") {
		t.Fatalf("%v", out["geraet"])
	}
	if out["absicht"]["max_ladeleistung_w"] != 2500.0 || out["speicher"]["speicher_leistung_w"] != -110.0 {
		t.Fatalf("%v %v", out["absicht"], out["speicher"])
	}
	for _, fc := range d.fcs {
		if fc != 3 {
			t.Fatalf("lesen schreibt nie: fc %d", fc)
		}
	}
}

// The box's own path (Layer 1, Huawei window path) driven by the tool: the
// program writes the window, Not-Aus hands back through the path itself, and
// the tool's guard finds the originals in place.
func TestSteuerwegFaehrtDenGoPfadUndDieserGibtZurueck(t *testing.T) {
	d := startDongle(t, anlage())
	d.taub = 50 * time.Millisecond
	var log []eintrag
	var mu sync.Mutex
	p := &protokoll{jetzt: time.Now, out: []func(eintrag){func(e eintrag) { mu.Lock(); log = append(log, e); mu.Unlock() }}}
	prog, err := leseProgramm("0:400ms,-1:400ms,0.6:400ms")
	if err != nil {
		t.Fatal(err)
	}
	s := &steuerwegLauf{v: verbindung{ziel: d.ln.Addr().String(), unit: 1, pause: 80 * time.Millisecond, timeout: time.Second},
		modell: "sun2000-m1", programm: prog, takt: 100 * time.Millisecond, p: p, sicher: filepath.Join(t.TempDir(), "s.json")}
	zurueck, err := s.run(context.Background())
	if err != nil || !zurueck {
		t.Fatalf("zurueck=%v err=%v", zurueck, err)
	}
	if d.u32(47075) != 2500 || d.u32(47077) != 2500 {
		t.Fatalf("nicht zurückgegeben: %d %d", d.u32(47075), d.u32(47077))
	}
	mu.Lock()
	defer mu.Unlock()
	var halten, laden bool // laden: the Decken step writes 47077 back to the own value
	for _, e := range log {
		if e.Schritt == "rueckmeldung" && strings.Contains(e.Hinweis, "regs=47077:0/0") && strings.Contains(e.Hinweis, "verify=held") {
			halten = true
		}
		if e.Schritt == "rueckmeldung" && strings.Contains(e.Hinweis, "regs=47077:2500/2500") && strings.Contains(e.Hinweis, "wrote=true") {
			laden = true
		}
	}
	if !halten || !laden {
		t.Fatalf("Rückmeldungen des Go-Pfads: halten=%v laden=%v", halten, laden)
	}
	if _, err := leseProgramm("2:60s"); err == nil {
		t.Fatal("mehr als 1,5 kW")
	}
}
