package agent

// Klima, Heizung, Kälte end to end (Steuerlogik K2/K3): the contract's two
// examples - the air conditioner and the cold room - run against a stand-in
// Modbus device over the box's REAL path: the core reads the device's channels
// as the logic's inputs, the logic's outputs become commands (the seam arming
// will use, logikBefehle), the arbiter applies band, step, mode list, change
// interval and rest values, and the executor writes the registers through the
// device's one connection and reads them back. Simulator evidence, no hardware
// acceptance.

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"strconv"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logiklauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbusgeraet/geraetsim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

// mbStand is one plant on a test clock: the stand-in device, the agent, its
// arbiter and the logic computing on the agent's read paths.
type mbStand struct {
	t      *testing.T
	sim    *geraetsim.Geraet
	a      *Agent
	arb    *desired.Arbiter
	uhr    time.Time
	L      *logik.Logik
	st     *logik.Lauf
	geraet string // the logic's device key
	ort    *time.Location
	netz   float64
	mit    *logiklauf.Laufzeit // optional: the same logic running along (Stufe 2)
}

// mbDefinitionJSON is a released definition for the stand-in at addr.
func mbDefinitionJSON(t *testing.T, addr string, def map[string]any) json.RawMessage {
	t.Helper()
	host, portS, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portS)
	def["transport"] = map[string]any{"host": host, "port": port, "unit_id": 1}
	raw, err := json.Marshal(def)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func neuerMbStand(t *testing.T, entityID string, def map[string]any, caps []entities.ActuateCap,
	logikDatei, geraet string, start time.Time) *mbStand {
	t.Helper()
	sim, err := geraetsim.Start("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sim.Close() })
	conn := mbDefinitionJSON(t, sim.Addr(), def)
	drv, _ := json.Marshal(map[string]any{"communication": "modbus_baukasten", "connection": conn})
	interval := 120.0
	reg := entities.Registry{Revision: "rev-mb", Entities: []entities.Entity{{
		ID: entityID, Type: "modbus-device", Label: "Gerät",
		Capabilities: entities.Capabilities{Actuate: caps},
		Guards: entities.Guards{Limits: entities.GuardLimits{MinChangeIntervalSeconds: &interval},
			Failsafe: entities.Failsafe{Behavior: "rest"}},
		Driver: drv,
	}}}
	s := &mbStand{t: t, sim: sim, uhr: start, geraet: geraet}
	s.arb = desired.New(desired.Deps{
		Now:            func() time.Time { return s.uhr },
		Reading:        func(string) guards.Reading { return guards.Reading{} },
		ControlEnabled: func() bool { return true },
		PublishCommand: func(string, []byte) {},
		PublishEvent:   func(string, []byte) {},
	})
	s.arb.SetEntities(reg)
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled, cfg.ConsumerControlEnabled = true, true
	s.a = &Agent{Cfg: cfg, entRegistry: reg, arb: s.arb}
	t.Cleanup(func() {
		s.a.mbMu.Lock()
		for _, g := range s.a.mbGeraete {
			g.schliesse()
		}
		s.a.mbMu.Unlock()
	})

	roh, err := os.ReadFile("../../../../docs/contracts/v2/steuerlogik/" + logikDatei)
	if err != nil {
		t.Fatal(err)
	}
	if s.L, err = logik.Lesen(roh); err != nil {
		t.Fatal(err)
	}
	if s.ort, err = time.LoadLocation("Europe/Berlin"); err != nil {
		t.Fatal(err)
	}
	s.st = s.L.NeuerLauf(float64(start.Unix()))
	return s
}

// sekunden runs n beats: the poll and the executor on their cadence, the logic
// every second on the agent's read paths, its wish submitted like an armed
// logic would (TTL 45 s, renewed every beat).
func (s *mbStand) sekunden(n int) {
	ctx := context.Background()
	for i := 0; i < n; i++ {
		s.uhr = s.uhr.Add(time.Second)
		now := s.uhr
		s.a.logikObserve(now, map[string]float64{"power_kw": s.netz}, nil)
		s.a.runModbusGeraetPoll(ctx, now)
		ort := now.In(s.ort)
		ein := &logik.Eingabe{Jetzt: float64(now.Unix()), DT: 1,
			UhrMin: float64(ort.Hour()*60+ort.Minute()) + float64(ort.Second())/60,
			Tag:    ort.Year()*1000 + ort.YearDay(), Wochentag: (int(ort.Weekday()) + 6) % 7,
			Werte: map[string]logik.EinWert{}, Geraete: map[string]logik.GeraetStamm{}}
		for _, w := range s.L.WertListe {
			ein.Werte[w] = s.a.logikQuelle(s.L.Werte[w].Source, now)
		}
		for _, g := range s.L.GeraetListe {
			stamm, ist := s.a.logikGeraet(s.L.Geraete[g].Entity, now)
			stamm.Sollwert, stamm.Betriebsart = ist.Sollwert, ist.Betriebsart
			ein.Geraete[g] = stamm
		}
		erg := s.L.Takt(s.st, ein)
		befehle := logikBefehle(erg.Ausgaenge[s.geraet])
		if !befehle.Empty() {
			s.arb.SubmitInternal(&desired.Desired{EntityID: s.L.Geraete[s.geraet].Entity, RequestID: "logik",
				Source:   desired.Source{Kind: desired.SourceFlow, FlowID: "logik", NodeID: s.geraet},
				Priority: desired.ClassFlow, TTL: 45 * time.Second, IssuedAt: now, Commands: befehle})
		}
		s.arb.Tick()
		if s.mit != nil {
			s.mit.Tick(now)
		}
		if now.Unix()%5 == 0 {
			s.a.runModbusGeraetControlPass(ctx, now)
		}
	}
}

func (s *mbStand) lage() string {
	s.t.Helper()
	ort := s.uhr.In(s.ort)
	ein := &logik.Eingabe{Jetzt: float64(s.uhr.Unix()), DT: 0, UhrMin: float64(ort.Hour()*60 + ort.Minute()),
		Tag: ort.Year()*1000 + ort.YearDay(), Wochentag: (int(ort.Weekday()) + 6) % 7,
		Werte: map[string]logik.EinWert{}, Geraete: map[string]logik.GeraetStamm{}}
	for _, w := range s.L.WertListe {
		ein.Werte[w] = s.a.logikQuelle(s.L.Werte[w].Source, s.uhr)
	}
	return s.L.Takt(s.st, ein).Lage.Titel
}

func klimaDefinition() map[string]any {
	return map[string]any{
		"schema_version": 1,
		"channels": []any{
			map[string]any{"slug": "raum", "label": "Raum", "unit": "°C", "signal": "room_temperature",
				"register": map[string]any{"kind": "input", "address": 0, "data_type": "s16"}, "scale": 0.1, "min_read_interval_s": 5},
			map[string]any{"slug": "stoerung", "label": "Störung", "unit": "", "signal": "fault",
				"register": map[string]any{"kind": "holding", "address": 5, "bit": 3}, "min_read_interval_s": 5},
		},
		"controls": map[string]any{
			"min_change_interval_s": 120,
			"values": []any{
				map[string]any{"slug": "ein", "label": "Ein", "kind": "on_off", "register": map[string]any{"kind": "coil", "address": 0},
					"on_value": 1, "off_value": 0, "rest": false},
				map[string]any{"slug": "soll", "label": "Soll", "kind": "setpoint_c",
					"register": map[string]any{"kind": "holding", "address": 10, "data_type": "s16"},
					"scale":    0.1, "min": 16, "max": 30, "step": 0.5, "rest": 24, "readback": map[string]any{"kind": "holding", "address": 11}},
				map[string]any{"slug": "betrieb", "label": "Betrieb", "kind": "mode", "register": map[string]any{"kind": "holding", "address": 12},
					"modes": map[string]any{"cool": 1, "heat": 2, "fan_only": 3}, "rest": "cool"},
			},
			"freigabe": map[string]any{"released_at": "2026-11-14T10:00:00Z", "released_by": "installer", "evidence": "Test bestanden"},
		},
	}
}

func klimaCaps() []entities.ActuateCap {
	f := func(v float64) *float64 { return &v }
	return []entities.ActuateCap{
		{Command: "on_off", Rest: json.RawMessage("false")},
		{Command: "setpoint_c", Min: f(16), Max: f(30), Step: f(0.5), Rest: json.RawMessage("24")},
		{Command: "mode", Modes: []string{"cool", "heat", "fan_only"}, Rest: json.RawMessage(`"cool"`)},
	}
}

func (s *mbStand) erwarte(wo string, coil bool, soll uint16, betrieb uint16) {
	s.t.Helper()
	if s.sim.CoilWert(0) != coil || s.sim.HoldingWert(10) != soll || s.sim.HoldingWert(12) != betrieb {
		s.t.Fatalf("%s: Gerät ein=%v soll=%d betrieb=%d, erwartet ein=%v soll=%d betrieb=%d", wo,
			s.sim.CoilWert(0), s.sim.HoldingWert(10), s.sim.HoldingWert(12), coil, soll, betrieb)
	}
}

func TestKlimaLogikSchreibtSollwertUndBetriebsartAmModbusGeraet(t *testing.T) {
	// Tuesday 10:00 in the plant's time zone: working hours.
	start := time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC)
	s := neuerMbStand(t, "klimageraet-buero", klimaDefinition(), klimaCaps(), "klima.logic.json", "klima", start)
	s.sim.Input(0, 270) // 27,0 °C in the office
	s.sim.Spiegel(10, 11)
	s.netz = 0.5
	// The same logic also runs along (Stufe 2): its comparison now sees the
	// device's setpoint and mode, not only on/off.
	roh, _ := os.ReadFile("../../../../docs/contracts/v2/steuerlogik/klima.logic.json")
	s.mit = s.a.newLogikLaufzeit(func() time.Time { return s.uhr })
	if err := s.mit.Angleichen([]logiklauf.Auftrag{{FlowID: "f-klima", Fassung: 1, Hash: "h1", Dokument: roh,
		Ort: logiklauf.Ort{Zeitzone: "Europe/Berlin"}}}); err != nil {
		t.Fatal(err)
	}

	// Working hours without surplus: on, cooling to the wish temperature 25 °C.
	s.sekunden(2 * 60)
	s.erwarte("Arbeitszeit", true, 250, 1)
	if got := s.lage(); got != "Kühlt" {
		t.Fatalf("Lage %q", got)
	}
	// The read-back reaches the logic as .setpoint/.mode and the run's "ist".
	stamm, ist := s.a.logikGeraet("klimageraet-buero", s.uhr)
	if ist.Sollwert == nil || *ist.Sollwert != 25 || ist.Betriebsart != "cool" || ist.Ein == nil || !*ist.Ein ||
		stamm.SollwertBereich == nil || stamm.SollwertBereich[0] != 16 || *stamm.SollwertSchritt != 0.5 ||
		len(stamm.Betriebsarten) != 3 {
		t.Fatalf("Rücklesung %+v %+v", ist, stamm)
	}

	// Surplus for six minutes: pre-cooling 1.5 K lower, 23.5 °C.
	s.netz = -2
	s.sekunden(6 * 60)
	s.erwarte("Vorkühlen", true, 235, 1)
	g := s.mit.Summary().Laeufe[0].Geraete["klima"]
	if g.Wunsch == nil || g.Ist == nil || *g.Wunsch.Sollwert != 23.5 || g.Ist.Sollwert == nil || *g.Ist.Sollwert != 23.5 ||
		g.Ist.Betriebsart != "cool" || !*g.Ist.Ein || g.VerglichenS == 0 || g.AbweichendS*10 > g.VerglichenS {
		t.Fatalf("Vergleich würde gegen ist: %+v wunsch=%+v ist=%+v", g, g.Wunsch, g.Ist)
	}

	// A hand intervention below the band: 12 °C is clamped to the band's 16 °C,
	// and it lands only after the change interval since the last change. One
	// holder owns the whole device, so the intervention states all three
	// values (what it leaves out would get its rest value).
	letzte := len(s.sim.Geschrieben())
	an := true
	s.arb.SubmitInternal(&desired.Desired{EntityID: "klimageraet-buero", RequestID: "hand",
		Source: desired.Source{Kind: desired.SourceLocalUI}, Priority: desired.ClassFlow, Override: true,
		TTL: time.Hour, IssuedAt: s.uhr, Commands: entities.Commands{SetpointC: f64p(12), OnOff: &an, Mode: "cool"}})
	if d, _ := s.arb.DecisionFor("klimageraet-buero"); len(d.Change) != 1 || *d.Granted.SetpointC != 23.5 {
		t.Fatalf("held by the change interval: %+v %+v", d.Granted, d.Change)
	}
	s.sekunden(130)
	s.erwarte("Handeingriff unter dem Band", true, 160, 1)
	for _, w := range s.sim.Geschrieben()[letzte:] {
		// Only the held 23.5 °C (re-asserted) and then the clamped 16 °C - never 12 °C.
		if w.Address == 10 && w.Wert != 235 && w.Wert != 160 {
			t.Fatalf("a setpoint outside the band or the hold reached the device: %+v", w)
		}
	}
	s.arb.Withdraw("klimageraet-buero", string(desired.SourceLocalUI), false)

	// The device reports a fault: the box never works against it - rest values.
	s.sim.Holding(5, 1<<3)
	s.sekunden(15)
	s.erwarte("Störung", false, 240, 1)
	s.sim.Holding(5, 0)
	s.sekunden(130)
	s.erwarte("Störung behoben", true, 235, 1)

	// The plant's control switches off: nothing more is written.
	vorher := len(s.sim.Geschrieben())
	s.a.Cfg.ControlEnabled = false
	s.netz = 0.5
	s.sekunden(20 * 60)
	if n := len(s.sim.Geschrieben()); n != vorher {
		t.Fatalf("%d writes with control off", n-vorher)
	}
	if s.sim.Verbindungen() != 1 {
		t.Fatalf("one socket per device, %d connections", s.sim.Verbindungen())
	}
}

func TestKuehlraumLogikVerschiebtSollwertAmModbusGeraet(t *testing.T) {
	def := map[string]any{
		"channels": []any{
			map[string]any{"slug": "raum", "label": "Kühlraum", "unit": "°C", "signal": "room_temperature",
				"register": map[string]any{"kind": "holding", "address": 100, "data_type": "s16"}, "scale": 0.1, "min_read_interval_s": 5},
			map[string]any{"slug": "tuer", "label": "Tür", "unit": "", "signal": "door_open",
				"register": map[string]any{"kind": "discrete", "address": 0}, "min_read_interval_s": 5},
			map[string]any{"slug": "abtau", "label": "Abtauung", "unit": "", "signal": "defrost",
				"register": map[string]any{"kind": "holding", "address": 101, "bit": 0}, "min_read_interval_s": 5},
		},
		"controls": map[string]any{
			"min_change_interval_s": 60,
			"values": []any{map[string]any{"slug": "soll", "label": "Sollwert", "kind": "setpoint_c",
				"register": map[string]any{"kind": "holding", "address": 200, "data_type": "u16"}, "write_fc": 6,
				"scale": 0.1, "offset": -50, "min": 2, "max": 8, "step": 0.5, "rest": 4}},
			"freigabe": map[string]any{"released_at": "2026-11-14T10:00:00Z"},
		},
	}
	caps := []entities.ActuateCap{{Command: "setpoint_c", Min: f64p(2), Max: f64p(8), Step: f64p(0.5), Rest: json.RawMessage("4")}}
	s := neuerMbStand(t, "kuehlstellenregler-1", def, caps, "kuehlraum.logic.json", "regler",
		time.Date(2026, 11, 17, 11, 0, 0, 0, time.UTC))
	s.sim.Holding(100, 42) // 4,2 °C
	s.netz = 0.8
	s.sekunden(60)
	if v := s.sim.HoldingWert(200); v != 540 {
		t.Fatalf("normal: raw %d, erwartet 540 (4 °C)", v)
	}
	// Surplus: after five minutes the cold is stored, 2 °C.
	s.netz = -3
	s.sekunden(6 * 60)
	if v := s.sim.HoldingWert(200); v != 520 {
		t.Fatalf("Vorrat: raw %d, erwartet 520 (2 °C)", v)
	}
	if got := s.lage(); got != "Kühlt auf Vorrat" {
		t.Fatalf("Lage %q", got)
	}
	// The door stays open for two minutes: back to normal.
	s.sim.Discrete(0, true)
	s.sekunden(3 * 60)
	if v := s.sim.HoldingWert(200); v != 540 {
		t.Fatalf("Tür offen: raw %d, erwartet 540", v)
	}
	for _, w := range s.sim.Geschrieben() {
		if w.FC != 6 || w.Address != 200 {
			t.Fatalf("only FC6 on the setpoint register: %+v", w)
		}
	}
}

// The release assistant's test write goes through the device's own
// connection, on a device the executor does not write yet.
func TestSchaltTestAmModbusGeraetUeberDieEigeneVerbindung(t *testing.T) {
	def := klimaDefinition()
	delete(def["controls"].(map[string]any), "freigabe")
	s := neuerMbStand(t, "klimageraet-buero", def, nil, "klima.logic.json", "klima",
		time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC))
	s.sim.Spiegel(10, 11)
	s.sekunden(10)
	if n := len(s.sim.Geschrieben()); n != 0 {
		t.Fatalf("an unreleased device got %d writes", n)
	}
	host, portS, _ := net.SplitHostPort(s.sim.Addr())
	port, _ := strconv.Atoi(portS)
	addr, fc, rb := 10, 16, 11
	op := probe.Op{ID: "t1", Op: probe.OpSwitchTest, Host: host, Port: &port, RegisterKind: probe.RegisterKindHolding,
		Address: &addr, WriteFC: &fc, ReadbackAddress: &rb}
	res := s.a.switchExchange(op, 215)
	if res == nil || !res.OK || res.Readback == nil || *res.Readback != 215 {
		t.Fatalf("test write: %+v", res)
	}
	if s.sim.Verbindungen() != 1 {
		t.Fatalf("the test opened a second socket: %d", s.sim.Verbindungen())
	}
	if w := s.sim.Geschrieben(); len(w) != 1 || w[0].Address != 10 || w[0].Wert != 215 || w[0].FC != 16 {
		t.Fatalf("writes %+v", w)
	}
}
