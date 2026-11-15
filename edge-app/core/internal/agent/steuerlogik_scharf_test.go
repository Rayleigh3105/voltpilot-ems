package agent

// Steuerlogik "scharf" over the REAL path (evidence of the supports word
// steuerlogik_scharf): the service beside the API builds the ARMED artifact of
// the contract's hot water example with a set value, the box takes it from
// the retained v2/flows set, every beat its wish goes through the arbiter and
// the guards, and the executor switches a stub Shelly Pro 3 over HTTP. On the
// way: the cycle guard holds a wish back, a manual intervention wins, a set
// value applies without restarting the logic, "Zurück" to the previous
// version and "Stilllegen" take effect on the next beat, and a rod the
// heating-rod controller drives is never given a second master.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logikdienst"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logiklauf"
)

const tScharfRod = "heizstab-warmwasser"

// scharfStand is one test plant: a Pro 3 stub behind a heating rod, an agent
// with its run and arbiter on ONE test clock.
type scharfStand struct {
	t     *testing.T
	a     *Agent
	arb   *desired.Arbiter
	dev   *pro3Stage
	reg   entities.Registry
	now   time.Time
	fp    map[string]string
	asrt  map[string]time.Time
	temp  float64
	gridK float64
}

func neuerScharfStand(t *testing.T, reg func(ip string, port int) entities.Registry) *scharfStand {
	t.Helper()
	s := &scharfStand{t: t, dev: newPro3Stage(), fp: map[string]string{}, asrt: map[string]time.Time{},
		temp: 35, gridK: 0.1,
		// 10:00 at the plant (Europe/Berlin): inside the logic's grid window 06:00-22:00.
		now: time.Date(2026, 11, 14, 9, 0, 0, 0, time.UTC)}
	srv := httptest.NewServer(s.dev.handler())
	t.Cleanup(srv.Close)
	host, port := splitHostPort(t, srv.URL)
	s.reg = reg(host, port)
	clock := func() time.Time { return s.now }
	s.arb = desired.New(desired.Deps{
		Now:            clock,
		Reading:        func(string) guards.Reading { return guards.Reading{} },
		ControlEnabled: func() bool { return true },
		PublishCommand: func(string, []byte) {},
		PublishEvent:   func(string, []byte) {},
	})
	s.arb.SetEntities(s.reg)
	s.a = shellyAgent(t, s.reg, s.arb, srv.Client())
	s.a.entIdentity = entities.Identity{TenantID: tLogikTenant, SiteID: tLogikSite, DeviceID: tLogikDevice}
	s.a.flowDep = s.a.newFlowDeployer()
	s.a.logik = s.a.newLogikLaufzeit(clock)
	s.a.flowDep.SetLogikLaufzeit(logikAdapter{s.a.logik})
	return s
}

// artefakt builds an artifact with the real service from the hot water
// example (the output may be rewritten for a second version).
func (s *scharfStand) artefakt(fassung int, armed bool, output string, werte map[string]string, stand int64) json.RawMessage {
	s.t.Helper()
	text, err := os.ReadFile("../../../../docs/contracts/v2/steuerlogik/wasser.logic.yaml")
	if err != nil {
		s.t.Fatal(err)
	}
	src := string(text)
	if output != "" {
		alt := `heizstab: {level: "if(netzheizen, 3, if(frei, stufe, 0))"}`
		if !strings.Contains(src, alt) {
			s.t.Fatal("das Beispiel hat seinen Ausgang geändert")
		}
		src = strings.Replace(src, alt, output, 1)
		// The probe of the cold morning follows the new output (one phase).
		src = strings.Replace(src, "expect: {netzheizen: on, heizstab.level: 3,", "expect: {netzheizen: on, heizstab.level: 1,", 1)
	}
	regRaw, _ := json.Marshal(s.reg)
	breite, laenge := 48.1, 11.6
	auftrag := logikdienst.Auftrag{Text: src, FlowID: tLogikFlow, FlowVersion: fassung, Registry: regRaw,
		CompiledAt: time.Date(2026, 11, 14, 8, 0, 0, 0, time.UTC), Armed: armed,
		Site: &logikdienst.Ort{Timezone: "Europe/Berlin", Latitude: &breite, Longitude: &laenge}}
	if werte != nil {
		auftrag.Settings = &logikdienst.Einstellung{Revision: stand, Values: map[string]json.RawMessage{}}
		for k, v := range werte {
			raw, _ := json.Marshal(v)
			auftrag.Settings.Values[k] = raw
		}
	}
	art, bericht, _, err := logikdienst.ArtefaktMitWerten(auftrag)
	if err != nil || bericht.Sperrt {
		s.t.Fatalf("Dienst: %v %+v", err, bericht)
	}
	return art
}

func (s *scharfStand) liefere(arts ...json.RawMessage) {
	s.t.Helper()
	s.a.onFlows(logikDeployment(s.t, arts...))
	for _, f := range s.a.flowsSummary().Applied {
		if f.State != "active" {
			s.t.Fatalf("ack: %+v", f)
		}
	}
}

// takt runs n seconds of the box: inputs, the logic beat, its wishes, the
// arbiter, the Shelly executor - in that order, like the running program.
func (s *scharfStand) takt(n int) {
	for i := 0; i < n; i++ {
		s.now = s.now.Add(time.Second)
		batt := 0.0
		s.a.logikObserve(s.now, map[string]float64{"power_kw": s.gridK, "soc_pct": 50}, &batt)
		s.a.logikObserveSamples(fuehlerBatch(s.t, "fuehler-speicher-oben", s.temp, s.now))
		s.a.logik.Tick(s.now)
		s.a.runSteuerlogik(s.now)
		s.a.runHeizstab(s.now)
		s.arb.Tick()
		s.a.runShellyControlPass(context.Background(), s.a.shellyDoer, s.fp, s.asrt, s.now)
	}
}

func (s *scharfStand) phasen() int {
	on, _ := s.dev.snapshot()
	n := 0
	for _, o := range on {
		if o {
			n++
		}
	}
	return n
}

func (s *scharfStand) lauf() cloud.LogikLauf {
	s.t.Helper()
	sum := s.a.logikSummary()
	if sum == nil || len(sum.Laeufe) != 1 {
		s.t.Fatalf("logik block: %+v", sum)
	}
	return sum.Laeufe[0]
}

func TestSteuerlogikScharfSchaltetDenShelly(t *testing.T) {
	s := neuerScharfStand(t, func(ip string, port int) entities.Registry {
		reg := stageRodRegistry(tScharfRod, ip, port)
		minOn := 300.0
		reg.Entities[0].Guards.Limits.MinOnSeconds = &minOn
		return reg
	})
	if !slices.Contains(cloud.BuiltSupports(geraetesuche.BoxArtEdgeLight), "steuerlogik_scharf") ||
		!slices.Contains(cloud.BuiltSupports(geraetesuche.BoxArtDocker), "steuerlogik_scharf") {
		t.Fatal("both box kinds advertise what they run")
	}

	// Fassung 1, armed, the customer set "Nie kälter als" to 42 °C.
	f1 := s.artefakt(1, true, "", map[string]string{"mindest": "42 °C"}, 1)
	s.liefere(f1)
	if !s.a.steuerlogikOwns(tScharfRod) {
		t.Fatal("an armed logic owns its device from the moment of arming (plan and deadline fallback skip it)")
	}

	// 35 °C is below 42 °C: after two minutes in the window the logic heats
	// from the grid with all three phases - real switching requests.
	s.takt(119)
	if s.phasen() != 0 {
		t.Fatalf("before two minutes nothing heats, got %d phases", s.phasen())
	}
	s.takt(3)
	if s.phasen() != 3 {
		_, sets := s.dev.snapshot()
		t.Fatalf("the logic must switch three phases, got %d (writes %v)", s.phasen(), sets)
	}
	dec, _ := s.arb.DecisionFor(tScharfRod)
	if dec.HolderKind != string(desired.SourceSteuerlogik) || dec.HolderRank != 40 {
		t.Fatalf("the logic must hold the rod in class flow: %+v", dec)
	}
	l := s.lauf()
	g := l.Geraete["heizstab"]
	if l.Zustand != "scharf" || l.ScharfSeit == "" || l.Halt != nil || l.Lage == nil || l.Lage.Art != "grid" ||
		g.Befehl == nil || *g.Befehl.Stufe != 3 || g.Ist == nil || *g.Ist.Stufe != 3 || g.Halter != "" {
		t.Fatalf("heartbeat: %+v lage %+v geraet %+v", l, l.Lage, g)
	}
	if l.Stellwerte == nil || l.Stellwerte.Stand != 1 || !slices.ContainsFunc(l.Stellwerte.Werte, func(w cloud.LogikStellwert) bool {
		return w.Kennung == "mindest" && w.Wert == "42 °C"
	}) {
		t.Fatalf("set value not applied: %+v", l.Stellwerte)
	}

	// The tank is warm: the logic wants off, the guard's minimum run holds the
	// rod on - the protection no logic overrules - and the heartbeat says why.
	s.temp = 55
	s.takt(5)
	if s.phasen() != 3 {
		t.Fatalf("the minimum run must hold, got %d phases", s.phasen())
	}
	g = s.lauf().Geraete["heizstab"]
	if g.Wunsch == nil || *g.Wunsch.Stufe != 0 || g.Schutz == nil || g.Schutz.Code != guards.CycleReasonMinOn ||
		*g.Befehl.Stufe != 3 {
		t.Fatalf("guard must be named: %+v schutz %+v", g, g.Schutz)
	}
	pinScharfBeispiel(t, s.a.logikSummary())
	s.takt(300)
	if s.phasen() != 0 {
		t.Fatalf("after the minimum run the rod goes off, got %d phases", s.phasen())
	}

	// A manual intervention wins over the logic (rank 75 against 40).
	kw := 2.0
	s.arb.SubmitInternal(&desired.Desired{EntityID: tScharfRod, RequestID: "hand", Override: true,
		Source: desired.Source{Kind: desired.SourceLocalUI}, Priority: desired.ClassFlow, TTL: time.Minute,
		IssuedAt: s.now, Commands: entities.Commands{SetpointKw: &kw}, RequestedType: entities.CmdSetpointKw})
	s.takt(2)
	if s.phasen() != 1 || s.lauf().Geraete["heizstab"].Halter != string(desired.SourceLocalUI) {
		t.Fatalf("manual intervention must win and be named: %d phases, %+v", s.phasen(), s.lauf().Geraete["heizstab"])
	}
	s.arb.Withdraw(tScharfRod, desired.Source{Kind: desired.SourceLocalUI}.Key(), false)
	s.takt(301)
	if s.phasen() != 0 {
		t.Fatalf("back with the logic: off, got %d phases", s.phasen())
	}

	// A new set value applies without restarting the logic: same run, new
	// revision; at 45 °C "Nie kälter als" the 43 °C tank heats again.
	seit := s.lauf().Seit
	s.liefere(s.artefakt(1, true, "", map[string]string{"mindest": "45 °C", "netz_ziel": "50 °C"}, 2))
	s.temp = 43
	s.takt(125)
	if l := s.lauf(); l.Seit != seit || l.Stellwerte.Stand != 2 || s.phasen() != 3 {
		t.Fatalf("set value: seit %s->%s stand %d phases %d", seit, l.Seit, l.Stellwerte.Stand, s.phasen())
	}

	// Fassung 2 heats with one phase only; it keeps the state of Fassung 1
	// (netzheizen stays on) and switches at once.
	s.liefere(s.artefakt(2, true, `heizstab: {level: "if(netzheizen, 1, if(frei, stufe, 0))"}`,
		map[string]string{"mindest": "45 °C", "netz_ziel": "50 °C"}, 2))
	s.takt(301) // the minimum run of the three phases ends, then one phase
	if s.phasen() != 1 || s.lauf().FlowVersion != 2 {
		t.Fatalf("Fassung 2 heats with one phase, got %d (v%d)", s.phasen(), s.lauf().FlowVersion)
	}
	// "Zurück zur vorigen Fassung": Fassung 1 again, on the very next beat.
	s.liefere(f1)
	s.takt(1)
	if s.phasen() != 3 || s.lauf().FlowVersion != 1 {
		t.Fatalf("Zurück must take effect on the next beat, got %d phases (v%d)", s.phasen(), s.lauf().FlowVersion)
	}

	// The box's switches off: no wish leaves, the heartbeat says why.
	s.a.Cfg.ConsumerControlEnabled = false
	s.a.runSteuerlogik(s.now)
	if l := s.lauf(); l.Halt == nil || l.Halt.Code != "schalter_aus" || s.a.steuerlogikOwns(tScharfRod) {
		t.Fatalf("switches off: %+v", l.Halt)
	}
	if dec, _ := s.arb.DecisionFor(tScharfRod); dec.HolderKind == string(desired.SourceSteuerlogik) {
		t.Fatal("the wish must be withdrawn at once")
	}
	s.a.Cfg.ConsumerControlEnabled = true

	// "Stilllegen": the set without the logic. The wish is withdrawn on the
	// next beat, the rod falls to its rest value (off) once its minimum run is
	// over - here it already is.
	s.takt(301)
	s.liefere()
	s.takt(1)
	if dec, _ := s.arb.DecisionFor(tScharfRod); dec.HolderKind != "" {
		t.Fatalf("after Stilllegen nobody may hold the rod: %+v", dec)
	}
	if s.phasen() != 0 || s.a.logikSummary() != nil || s.a.steuerlogikOwns(tScharfRod) {
		t.Fatalf("Stilllegen: %d phases, block %+v", s.phasen(), s.a.logikSummary())
	}
}

// A logic running along (not armed) still switches nothing, also with the
// box's switches on and a device the executor drives.
func TestSteuerlogikMitlaufSchaltetAuchMitSchalternNicht(t *testing.T) {
	s := neuerScharfStand(t, func(ip string, port int) entities.Registry { return stageRodRegistry(tScharfRod, ip, port) })
	s.liefere(s.artefakt(1, false, "", nil, 0))
	s.takt(200)
	if s.phasen() != 0 || s.a.steuerlogikOwns(tScharfRod) {
		t.Fatalf("running along switched %d phases", s.phasen())
	}
	if l := s.lauf(); l.Zustand != "mitlaufend" || l.Geraete["heizstab"].Wunsch == nil || *l.Geraete["heizstab"].Wunsch.Stufe != 3 {
		t.Fatalf("the run still computes its wish: %+v", l)
	}
}

// A rod the heating-rod controller drives (its Steuerart "Solar-Überschuss"
// travels as the heizstab block) is never given a second master: the armed
// logic gets no wish for it, the controller keeps it, the heartbeat names the
// conflict. The cloud refuses to arm such a logic in the first place.
func TestSteuerlogikScharfKeinZweiterHerr(t *testing.T) {
	s := neuerScharfStand(t, func(ip string, port int) entities.Registry {
		return heizstabRodRegistry(tScharfRod, ip, port, `{"modus":"ueberschuss"}`)
	})
	s.liefere(s.artefakt(1, true, "", nil, 0))
	s.takt(130)
	dec, _ := s.arb.DecisionFor(tScharfRod)
	if dec.HolderKind != string(desired.SourceHeizstab) {
		t.Fatalf("the heating-rod controller keeps the rod: %+v", dec)
	}
	g := s.lauf().Geraete["heizstab"]
	if g.Konflikt == nil || g.Konflikt.Code != "zweiter_herr" || g.Halter != string(desired.SourceHeizstab) {
		t.Fatalf("conflict must be named: %+v", g)
	}
	if s.phasen() != 0 {
		t.Fatalf("no surplus: the controller keeps the rod off, got %d phases", s.phasen())
	}
}

// The source kind of a logic is internal: no publisher on the bus can claim it.
func TestSteuerlogikQuelleIstNurIntern(t *testing.T) {
	payload := `{"schema_version":"1.0","entity_id":"e1","request_id":"r","source":{"kind":"steuerlogik"},` +
		`"priority":"flow","ttl_s":45,"issued_at":"2026-11-14T10:00:00Z","commands":{"on_off":true}}`
	if _, err := desired.Parse("e1", []byte(payload), time.Now()); err == nil {
		t.Fatal("an external desired claiming the logic's source must be refused")
	}
}

// pinScharfBeispiel pins the armed heartbeat block as a contract fixture
// (examples/steuerlogik-rueckmeldung.valid.scharf.json) the API's listener
// tests read; VP_FIXTURES_SCHREIBEN=1 rewrites it after an intended change.
func pinScharfBeispiel(t *testing.T, sum *cloud.LogikSummary) {
	t.Helper()
	block, err := json.MarshalIndent(sum, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	block = append(block, '\n')
	pfad := filepath.Join("..", "..", "..", "..", "docs", "contracts", "v2", "examples",
		"steuerlogik-rueckmeldung.valid.scharf.json")
	if os.Getenv("VP_FIXTURES_SCHREIBEN") == "1" {
		if err := os.WriteFile(pfad, block, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	soll, err := os.ReadFile(pfad)
	if err != nil {
		t.Fatalf("%v (VP_FIXTURES_SCHREIBEN=1 legt sie an)", err)
	}
	if string(soll) != string(block) {
		t.Fatalf("%s weicht vom Block ab (VP_FIXTURES_SCHREIBEN=1 nach gewollter Änderung):\n%s", pfad, block)
	}
}

// The box switches an armed logic with exactly the commands the cloud
// required in the bundle (logikdienst.SchaltRecht): one rule in two places -
// the service may not import the box, the box not the service's YAML - kept
// equal here. Where the device lacks the command, the box names the conflict
// and the bundle's requirement would have stopped it at the box as well.
func TestSteuerlogikBefehlWieImBuendel(t *testing.T) {
	gruppe := json.RawMessage(`{"brand":"shelly","communication":"shelly_http","connection":{"ip":"192.168.1.20",` +
		`"port":80,"channels":[0,1,2],"output_kw":[2,2,2],"stages":[1,2,3]}}`)
	relais := json.RawMessage(`{"brand":"shelly","communication":"shelly_http","connection":{"ip":"192.168.1.21","port":80,"channel":0}}`)
	kann := func(cmds ...string) entities.Capabilities {
		var c entities.Capabilities
		for _, cmd := range cmds {
			c.Actuate = append(c.Actuate, entities.ActuateCap{Command: cmd})
		}
		return c
	}
	an := true
	temp := &logik.Wert{Art: logik.WertZahl, V: 23.5, D: logik.GroesseTemp}
	kw := &logik.Wert{Art: logik.WertZahl, V: 2, D: logik.GroesseKW}
	faelle := []struct {
		name     string
		e        entities.Entity
		arten    []string
		groesse  logik.Groesse
		o        logik.Ausgang
		konflikt string
	}{
		{"Heizstab an der Ausgangsmenge", entities.Entity{ID: "stab", Type: "heating-rod", Driver: gruppe,
			Capabilities: kann("on_off", "setpoint_kw")}, []string{"level"}, "", logik.Ausgang{HatStufe: true, Stufe: 2}, ""},
		{"Schaltlast am Relais", entities.Entity{ID: "pumpe", Type: "switch-load", Driver: relais,
			Capabilities: kann("on_off")}, []string{"level"}, "", logik.Ausgang{HatStufe: true, Stufe: 1}, ""},
		{"SG-Ready-Kontakt", entities.Entity{ID: "wp", Type: "heat-pump-sgready", Driver: relais,
			Capabilities: kann("on_off")}, []string{"mode"}, "", logik.Ausgang{HatBetriebsart: true, Betriebsart: "boost"}, ""},
		{"Klimagerät", entities.Entity{ID: "klima", Type: "modbus-device", Capabilities: kann("on_off", "setpoint_c", "mode")},
			[]string{"on_off", "setpoint", "mode"}, logik.GroesseTemp, logik.Ausgang{HatEin: true, Ein: &an,
				HatSollwert: true, Sollwert: temp, HatBetriebsart: true, Betriebsart: "cool"}, ""},
		{"Leistung in kW", entities.Entity{ID: "last", Type: "heating-rod", Capabilities: kann("setpoint_kw")},
			[]string{"setpoint"}, logik.GroesseKW, logik.Ausgang{HatSollwert: true, Sollwert: kw}, ""},
		{"Sollwert an einem Gerät ohne ihn", entities.Entity{ID: "stab2", Type: "heating-rod", Driver: relais,
			Capabilities: kann("on_off")}, []string{"setpoint"}, logik.GroesseTemp,
			logik.Ausgang{HatSollwert: true, Sollwert: temp}, "ausgang_offen"},
		{"Betriebsart an einem Gerät ohne sie", entities.Entity{ID: "last2", Type: "switch-load", Driver: relais,
			Capabilities: kann("on_off")}, []string{"mode"}, "", logik.Ausgang{HatBetriebsart: true, Betriebsart: "eco"},
			"ausgang_offen"},
	}
	for _, f := range faelle {
		c, _, halt := logikBefehl(f.e, f.o)
		code := ""
		if halt != nil {
			code = halt.Code
		}
		if code != f.konflikt {
			t.Fatalf("%s: Konflikt %q, erwartet %q (%+v)", f.name, code, f.konflikt, halt)
		}
		reg, _ := json.Marshal(entities.Registry{Entities: []entities.Entity{f.e}})
		verlangt := logikdienst.SchaltRecht(logikdienst.Geraet{EntityID: f.e.ID, Ausgaenge: f.arten}, f.groesse, reg)
		if f.konflikt != "" {
			fehlt := false
			for _, cap := range verlangt {
				fehlt = fehlt || !f.e.Supports(strings.TrimPrefix(cap, "actuate:"))
			}
			if !fehlt {
				t.Fatalf("%s: das Bündel verlangt %v, die Box hielte es nicht auf", f.name, verlangt)
			}
			continue
		}
		var hat []string
		for _, n := range befehlsNamen(c) {
			hat = append(hat, "actuate:"+n)
		}
		slices.Sort(hat)
		if !slices.Equal(hat, verlangt) {
			t.Fatalf("%s: die Box schaltet mit %v, das Bündel verlangt %v", f.name, hat, verlangt)
		}
	}
}

// Armed on a device that regulates itself (Stufe 3 on K2/K3): the contract's
// air conditioner example as the agent's own ARMED run writes on/off, setpoint
// and mode to the stand-in Modbus device through runSteuerlogik - the seam of
// K2, the arbiter, band and change interval - and stilllegen hands the device
// back to its rest values. Simulator evidence, no hardware acceptance.
func TestKlimaLogikScharfStelltDasModbusGeraet(t *testing.T) {
	// Tuesday 10:00 in the plant's time zone: working hours.
	start := time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC)
	s := neuerMbStand(t, "klimageraet-buero", klimaDefinition(), klimaCaps(), "klima.logic.json", "klima", start)
	s.sim.Input(0, 270) // 27,0 °C in the office
	s.sim.Spiegel(10, 11)
	s.netz = 0.5
	roh, err := os.ReadFile("../../../../docs/contracts/v2/steuerlogik/klima.logic.json")
	if err != nil {
		t.Fatal(err)
	}
	s.mit = s.a.newLogikLaufzeit(func() time.Time { return s.uhr })
	s.a.logik, s.scharf = s.mit, true
	if err := s.mit.Angleichen([]logiklauf.Auftrag{{FlowID: "f-klima", Fassung: 1, Hash: "h1", Dokument: roh,
		Ort: logiklauf.Ort{Zeitzone: "Europe/Berlin"}, Scharf: true}}); err != nil {
		t.Fatal(err)
	}

	s.sekunden(2 * 60)
	s.erwarte("scharf in der Arbeitszeit", true, 250, 1)
	if d, _ := s.arb.DecisionFor("klimageraet-buero"); d.HolderKind != string(desired.SourceSteuerlogik) {
		t.Fatalf("Halter %q", d.HolderKind)
	}
	g := s.a.logikSummary().Laeufe[0].Geraete["klima"]
	if g.Konflikt != nil || g.Halter != "" || g.Befehl == nil || g.Befehl.Sollwert == nil || *g.Befehl.Sollwert != 25 ||
		g.Befehl.Betriebsart != "cool" || g.Befehl.Ein == nil || !*g.Befehl.Ein {
		t.Fatalf("Herzschlag: %+v befehl=%+v", g, g.Befehl)
	}

	// Surplus: pre-cooling to 23.5 °C, after the device's change interval.
	s.netz = -2
	s.sekunden(6 * 60)
	s.erwarte("Vorkühlen", true, 235, 1)

	// Stilllegen: the wish is withdrawn at once, the device gets its rest
	// values (off, 24 °C, cool) - the setpoint after the change interval.
	if err := s.mit.Angleichen(nil); err != nil {
		t.Fatal(err)
	}
	s.sekunden(130)
	s.erwarte("stillgelegt", false, 240, 1)
	if d, _ := s.arb.DecisionFor("klimageraet-buero"); d.HolderKind != "" {
		t.Fatalf("nach dem Stilllegen hält %q", d.HolderKind)
	}
}
