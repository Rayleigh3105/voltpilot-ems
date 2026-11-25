package agent

// The dv.* measurement-point reader (vp-direktvermarktung-konzept d2 §5.4
// "Nachweis"): it caches only its own selections of the retained measurement
// config, acknowledges only them, refuses an entity binding and a too-fast
// cadence, and samples honestly from the Anschluss snapshot - a value the
// connection cannot know stays absent, never a fabricated zero.

import (
	"encoding/json"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
)

func dvMessplanPayload(catalogVersion string, selections ...string) []byte {
	type sel struct {
		PointKey string `json:"point_key"`
		CadenceS int    `json:"cadence_s"`
		EntityID string `json:"entity_id,omitempty"`
	}
	var s []sel
	for _, raw := range selections {
		var one sel
		if err := json.Unmarshal([]byte(raw), &one); err != nil {
			panic(err)
		}
		s = append(s, one)
	}
	doc := map[string]any{"revision": 7, "catalog_version": catalogVersion, "selections": s}
	raw, _ := json.Marshal(doc)
	return raw
}

func TestDvMesspunktPlanNimmtNurEigenePunkte(t *testing.T) {
	a := dvTestAgent(t)
	a.onDvMesspunktPlan("", dvMessplanPayload("2026.10.26.1",
		`{"point_key":"dv.vorgabe_pct","cadence_s":60}`,
		`{"point_key":"dv.grenze_kw","cadence_s":60,"entity_id":"e1"}`,
		`{"point_key":"dv.verbunden","cadence_s":5}`,
		`{"point_key":"shelly.gen2plus.input[*].state","cadence_s":30,"entity_id":"e1"}`,
		`{"point_key":"dv.lebenszeichen_alter_s","cadence_s":60}`))
	a.dvMessMu.Lock()
	defer a.dvMessMu.Unlock()
	if a.dvMessCatalogVersion != "2026.10.26.1" {
		t.Fatalf("catalog version %q", a.dvMessCatalogVersion)
	}
	var keys []string
	for _, s := range a.dvMessPlan {
		keys = append(keys, s.pointKey)
	}
	// Angenommen: vorgabe_pct und lebenszeichen_alter_s. Abgewiesen: grenze_kw
	// (Entity-Bindung), verbunden (Takt unter 15 s). Fremd: der Shelly-Punkt.
	if len(keys) != 2 || keys[0] != "dv.vorgabe_pct" || keys[1] != "dv.lebenszeichen_alter_s" {
		t.Fatalf("Plan: %v", keys)
	}
	// Ein leeres Payload (retained clear) räumt den Plan.
	a.dvMessMu.Unlock()
	a.onDvMesspunktPlan("", nil)
	a.dvMessMu.Lock()
	if len(a.dvMessPlan) != 0 {
		t.Fatalf("Plan nach Rückzug: %v", a.dvMessPlan)
	}
}

func TestDvMesspunktWerteSindEhrlich(t *testing.T) {
	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	// Ohne Server (Profil fehlt im Snapshot nie, aber der Zustand schon):
	st := &direktvermarkter.AnschlussStand{Partner: "luox", Lage: direktvermarkter.LageOhneZugang}
	if _, ok := dvMesspunktWert("dv.vorgabe_pct", st, now); ok {
		t.Fatal("vorgabe_pct ohne Server erfunden")
	}
	if v, ok := dvMesspunktWert("dv.verbunden", st, now); !ok || v != 0 {
		t.Fatalf("verbunden ohne Tunnel: %v %v", v, ok)
	}
	// Mit Server-Snapshot:
	st = &direktvermarkter.AnschlussStand{
		Partner: "luox", Lage: direktvermarkter.LageVorgabeAktiv,
		Server: &direktvermarkter.ServerStand{
			State: direktvermarkter.StateLimitActive, EffektivPct: 30, Aktiv: true,
			Lebenszeichen: now.Add(-12 * time.Second),
			WerteStand:    now.Add(-5 * time.Second),
			Werte:         map[string]float64{"referenz_w": 10000},
		},
	}
	if v, ok := dvMesspunktWert("dv.vorgabe_pct", st, now); !ok || v != 30 {
		t.Fatalf("vorgabe_pct: %v %v", v, ok)
	}
	if v, ok := dvMesspunktWert("dv.grenze_kw", st, now); !ok || v != 3.0 {
		t.Fatalf("grenze_kw: %v %v", v, ok)
	}
	if v, ok := dvMesspunktWert("dv.verbunden", st, now); !ok || v != 1 {
		t.Fatalf("verbunden: %v %v", v, ok)
	}
	if v, ok := dvMesspunktWert("dv.lebenszeichen_alter_s", st, now); !ok || v != 12 {
		t.Fatalf("lebenszeichen_alter_s: %v %v", v, ok)
	}
	// Abgelaufen zählt als verbunden (Kunde liest "Verbunden (frei)", §5.4);
	// die Grenze fällt - und wird nie als 0 erfunden.
	st.Lage = direktvermarkter.LageAbgelaufen
	st.Server.Aktiv = false
	st.Server.EffektivPct = 100
	if v, ok := dvMesspunktWert("dv.verbunden", st, now); !ok || v != 1 {
		t.Fatalf("verbunden (abgelaufen): %v %v", v, ok)
	}
	if _, ok := dvMesspunktWert("dv.grenze_kw", st, now); ok {
		t.Fatal("grenze_kw ohne aktive Vorgabe erfunden")
	}
}

func TestDvMesspunktPassVeroeffentlichtBatch(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, addr := startBusOnlyAgent(t, cfg)
	a.dvDir = t.TempDir() + "/vermarkter"
	a.entIdentity = entities.Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}
	t.Cleanup(func() {
		a.dvMu.Lock()
		if a.dv != nil {
			a.dv.Close()
		}
		a.dvMu.Unlock()
	})
	// Ein zugestelltes Profil + Plan.
	a.onDirektvermarktung(dvTestProfilDokument(t))
	a.onDvMesspunktPlan("", dvMessplanPayload("2026.10.26.1",
		`{"point_key":"dv.vorgabe_pct","cadence_s":60}`,
		`{"point_key":"dv.verbunden","cadence_s":60}`))

	got := make(chan []byte, 4)
	opts := pahomqtt.NewClientOptions().AddBroker("tcp://" + addr).
		SetClientID("test-dv-sub").SetConnectTimeout(5 * time.Second)
	client := pahomqtt.NewClient(opts)
	if tok := client.Connect(); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		t.Fatalf("bus connect: %v", tok.Error())
	}
	t.Cleanup(func() { client.Disconnect(100) })
	if tok := client.Subscribe(measurements.LocalSamplesTopic, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
		select {
		case got <- msg.Payload():
		default:
		}
	}); !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("bus subscribe: %v", tok.Error())
	}

	a.runDvMesspunktPass(map[string]time.Time{}, time.Now())

	select {
	case raw := <-got:
		var batch struct {
			CatalogVersion string                `json:"catalog_version"`
			Samples        []measurements.Sample `json:"samples"`
		}
		if err := json.Unmarshal(raw, &batch); err != nil {
			t.Fatal(err)
		}
		if batch.CatalogVersion != "2026.10.26.1" || len(batch.Samples) != 2 {
			t.Fatalf("Batch: %s", raw)
		}
		werte := map[string]float64{}
		for _, s := range batch.Samples {
			werte[s.PointKey] = s.Raw.(float64)
			if s.Quality != "good" {
				t.Fatalf("Qualität %q", s.Quality)
			}
		}
		// Ruhewert 100, nicht verbunden (kein Tunnel: baut_auf).
		if werte["dv.vorgabe_pct"] != 100 || werte["dv.verbunden"] != 0 {
			t.Fatalf("Werte: %v", werte)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("kein Batch auf dem Bus")
	}
}

