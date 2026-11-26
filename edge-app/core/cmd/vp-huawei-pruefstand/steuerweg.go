package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/layer1"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
)

// steuerweg drives the box's own control path against the device: a Layer 1
// runtime (internal/layer1, the Huawei window path of steuerplan) on a local
// bus, fed the Huawei selection and the setpoints of a short program the way
// the core feeds them (every 10 s, device_certified, control_enabled), and
// ended with Not-Aus (control_enabled false) so the path itself hands back.
// The tool keeps its own guard: it reads the window registers before and
// after; whatever the path did not restore, the tool restores and says so.

// schritt of the program: a setpoint for a while.
type programmSchritt struct {
	Kw    float64
	Dauer time.Duration
}

// leseProgramm reads "0:60s,-1:60s,0.5:60s".
func leseProgramm(s string) ([]programmSchritt, error) {
	var out []programmSchritt
	for _, teil := range strings.Split(s, ",") {
		kw, dauer, ok := strings.Cut(strings.TrimSpace(teil), ":")
		if !ok {
			return nil, fmt.Errorf("Programmschritt %q: kw:dauer erwartet", teil)
		}
		k, err := strconv.ParseFloat(kw, 64)
		if err != nil {
			return nil, err
		}
		d, err := time.ParseDuration(dauer)
		if err != nil {
			return nil, err
		}
		if k > 1.5 || k < -1.5 || d > 5*time.Minute {
			return nil, fmt.Errorf("Programmschritt %q: höchstens ±1,5 kW und 5 min", teil)
		}
		out = append(out, programmSchritt{k, d})
	}
	return out, nil
}

// fenster are the window registers the path may write (U32 W, U16).
var fenster = []struct{ addr, worte int }{{47075, 2}, {47077, 2}, {47086, 1}}

func leseFenster(ctx context.Context, v verbindung) (map[int]int, error) {
	out := map[int]int{}
	err := v.mit(ctx, func(c *modbustcp.Client) error {
		for _, f := range fenster {
			w, err := lies(c, f.addr, f.worte)
			if err != nil {
				return err
			}
			out[f.addr] = w
		}
		return nil
	})
	return out, err
}

type steuerwegLauf struct {
	v        verbindung
	modell   string
	programm []programmSchritt
	takt     time.Duration
	p        *protokoll
	sicher   string
}

func (s *steuerwegLauf) run(ctx context.Context) (bool, error) {
	vorher, err := leseFenster(ctx, s.v)
	if err != nil {
		return true, fmt.Errorf("Ausgangswerte nicht lesbar: %w", err)
	}
	for a, w := range vorher {
		s.p.schreib(eintrag{Schritt: "ausgangswert", Register: a, Alt: ip(w)})
	}
	worteJe := map[int]int{}
	for _, f := range fenster {
		worteJe[f.addr] = f.worte
	}
	raw, _ := json.MarshalIndent(map[string]any{"ziel": s.v.ziel, "unit": s.v.unit, "worte": worteJe, "originale": vorher}, "", "  ")
	if err := os.WriteFile(s.sicher, raw, 0o600); err != nil {
		return true, err
	}

	// The box: local bus + Layer 1 with the field timing (8 s exchanges, 1 s pause).
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return true, err
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		return true, err
	}
	defer bus.Close()
	var mu sync.Mutex
	var letzte map[string]any
	_ = bus.Subscribe(localbus.TopicControlReadback, 901, func(_ string, p []byte) {
		var m map[string]any
		_ = json.Unmarshal(p, &m)
		mu.Lock()
		letzte = m
		mu.Unlock()
		s.p.schreib(eintrag{Schritt: "rueckmeldung", Hinweis: fmt.Sprintf("mode=%v verify=%v wrote=%v blocked=%v reason=%v regs=%v",
			m["mode"], m["verify"], m["wrote"], m["blocked"], m["reason"], kurz(m["registers"]))})
	})
	_ = bus.Subscribe(localbus.TopicTelemetry, 902, func(_ string, p []byte) {
		var m map[string]float64
		_ = json.Unmarshal(p, &m)
		s.p.schreib(eintrag{Schritt: "telemetrie", Messung: m})
	})
	client, err := layer1.DialMQTT(addr, "vp-huawei-pruefstand")
	if err != nil {
		return true, err
	}
	defer client.Close()
	dir, _ := os.MkdirTemp("", "vp-huawei-steuerweg")
	defer os.RemoveAll(dir)
	rt := layer1.New(client, layer1.Options{SteuerAblage: filepath.Join(dir, "steuern.json"),
		ConnectTimeout: 8 * time.Second, ReadTimeout: 8 * time.Second, HuaweiConnectPause: s.v.pause})
	rctx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = rt.Run(rctx) }()
	<-rt.Ready()
	host, port, _ := net.SplitHostPort(s.v.ziel)
	p, _ := strconv.Atoi(port)
	sel, _ := json.Marshal(map[string]any{"schema_version": "1.0", "brand": "huawei", "model": s.modell,
		"family": "huawei_sun2000_luna", "communication": "huawei_modbus",
		"connection": map[string]any{"ip": host, "port": p, "unit_id": int(s.v.unit)}})
	if err := bus.Publish(localbus.TopicInverterConfig, sel, true); err != nil {
		return true, err
	}
	sende := func(kw float64, an bool) {
		sp, _ := json.Marshal(map[string]any{"battery_setpoint_kw": kw, "control_enabled": an, "device_certified": true,
			"source": "pruefstand", "ts": time.Now().UTC().Format("2006-01-02T15:04:05.000Z")})
		_ = bus.Publish(localbus.TopicSetpoint, sp, true)
	}
	for _, sch := range s.programm {
		s.p.schreib(eintrag{Schritt: "programm", Hinweis: fmt.Sprintf("Sollwert %.2f kW für %s", sch.Kw, sch.Dauer)})
		ende := time.Now().Add(sch.Dauer)
		for time.Now().Before(ende) && ctx.Err() == nil {
			sende(sch.Kw, true)
			select {
			case <-ctx.Done():
			case <-time.After(s.takt):
			}
		}
		if ctx.Err() != nil {
			break
		}
	}
	// Not-Aus: the path hands back by itself; wait for its release readback.
	s.p.schreib(eintrag{Schritt: "programm", Hinweis: "Not-Aus (control_enabled false): Rückgabe durch den Go-Pfad"})
	frist := time.Now().Add(90 * time.Second)
	zurueck := false
	for time.Now().Before(frist) && !zurueck {
		sende(0, false)
		time.Sleep(s.takt)
		mu.Lock()
		zurueck = letzte["mode"] == "release" && letzte["verify"] == "held"
		mu.Unlock()
	}
	stop()
	time.Sleep(500 * time.Millisecond)
	// The tool's own guard: read the window again (a failed read is no value,
	// it is retried; a box beside us may hold the dongle's one slot).
	var nachher map[int]int
	for versuch := 1; versuch <= 5; versuch++ {
		if nachher, err = leseFenster(context.Background(), s.v); err == nil {
			break
		}
		s.p.schreib(eintrag{Schritt: "nachher", Fehler: fmt.Sprintf("Versuch %d: %v", versuch, err)})
		time.Sleep(5 * time.Second)
	}
	gleich := err == nil
	for a, w := range vorher {
		e := eintrag{Schritt: "nachher", Register: a, Alt: ip(w)}
		if v, ok := nachher[a]; ok {
			e.Gelesen = ip(v)
			if v != w {
				gleich = false
			}
		}
		s.p.schreib(e)
	}
	if gleich {
		return zurueck, nil
	}
	if err != nil {
		s.p.schreib(eintrag{Schritt: "nachher", Hinweis: "Fenster nicht lesbar - das Werkzeug stellt sicherheitshalber wieder her"})
	}
	l := &lauf{v: s.v, p: s.p}
	var reihenfolge []int
	geschrieben := map[int]bool{}
	for _, f := range fenster {
		reihenfolge = append(reihenfolge, f.addr)
		geschrieben[f.addr] = true
	}
	ok, ab := l.herstellen(reihenfolge, worteJe, vorher, geschrieben)
	if !ok {
		return false, fmt.Errorf("Werkzeug-Wiederherstellung nicht bestätigt: %v", ab)
	}
	if err != nil {
		return zurueck, fmt.Errorf("Fenster nach dem Lauf nicht lesbar (%v); das Werkzeug hat die Ausgangswerte geschrieben und bestätigt", err)
	}
	return false, fmt.Errorf("der Go-Pfad gab nicht vollständig zurück; das Werkzeug hat wiederhergestellt")
}

func kurz(v any) string {
	l, _ := v.([]any)
	var out []string
	for _, r := range l {
		m, _ := r.(map[string]any)
		out = append(out, fmt.Sprintf("%v:%v/%v", m["addr"], m["commanded_raw"], m["actual_raw"]))
	}
	return strings.Join(out, " ")
}
