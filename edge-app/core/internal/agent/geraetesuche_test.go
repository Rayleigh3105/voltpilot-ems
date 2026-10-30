package agent

// The device search in the agent: the order goes through the agent's own
// identity and VP_LAN_HOST to suche.Leitung, the Docker box keeps the open
// order on disk and Edge Light writes nothing; each box type reports its
// own supports[] and update.backend (edge-supports.md "Je Box-Art"); what the
// box already reads comes from its selection, sources and registry.

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

const (
	gsTenant = "11111111-1111-4111-8111-111111111111"
	gsSite   = "22222222-2222-4222-8222-222222222222"
	gsDevice = "33333333-3333-4333-8333-333333333333"
)

func gsAgent(t *testing.T, boxArt, lanHost string) *Agent {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.BoxArt = boxArt
	cfg.LANHost = lanHost
	a := &Agent{Cfg: cfg, State: state.New("gs-ref", "test")}
	a.State.Update(func(s *state.Snapshot) { s.TenantID, s.SiteID, s.DeviceID = gsTenant, gsSite, gsDevice })
	// Every connection hangs until its time limit: the search keeps running.
	a.geraetesucheDialer = func(ctx context.Context, _ string) (net.Conn, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	a.geraetesuche = a.neueGeraetesuche()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	a.geraetesuche.Start(ctx)
	return a
}

func gsAuftrag() []byte {
	am := time.Now().UTC().Truncate(time.Second)
	raw, _ := json.Marshal(map[string]any{"schema_version": "1.0", "tenant_id": gsTenant, "site_id": gsSite,
		"device_id": gsDevice, "aktion": "starten", "such_id": "44444444-4444-4444-8444-444444444444",
		"ausgeloest_am": am.Format(time.RFC3339), "gueltig_bis": am.Add(time.Minute).Format(time.RFC3339)})
	return raw
}

func TestDockerBoxSuchtUndMerktDenAuftragAufDerPlatte(t *testing.T) {
	a := gsAgent(t, geraetesuche.BoxArtDocker, "10.77.0.20:8484")
	a.onGeraetesuche(gsAuftrag())
	if !a.geraetesuche.Laeuft() {
		t.Fatal("the order did not start a search")
	}
	if _, err := os.Stat(filepath.Join(a.Cfg.DataDir, "geraetesuche-offen.json")); err != nil {
		t.Fatalf("open order not on disk: %v", err)
	}
	if a.updateSummary().Backend != "compose" ||
		!slices.Equal(cloud.BuiltSupports(a.boxArt()), cloud.BuiltSupports(geraetesuche.BoxArtDocker)) {
		t.Fatal("the Docker box reports another box type")
	}
}

// Only the box type is checked here: a search on Edge Light walks the real
// interfaces of the machine (internal/geraetesuche/suche has it against
// simulated ones), and a unit test sends nothing into a real network.
func TestEdgeLightSuchtOhneFlashUndMeldetSichAlsLight(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.BoxArt = geraetesuche.BoxArtEdgeLight
	a := &Agent{Cfg: cfg, State: state.New("gs-ref", "test")}
	if a.updateSummary().Backend != "light" {
		t.Fatalf("backend %q", a.updateSummary().Backend)
	}
	supports := cloud.BuiltSupports(a.boxArt())
	if !slices.Contains(supports, "geraetesuche") || slices.Contains(supports, "erzeuger_registerbild") {
		t.Fatalf("Edge Light supports %v", supports)
	}
	if a.geraetesucheOffenPfad() != "" {
		t.Fatal("Edge Light would write the open order to its flash")
	}
}

func TestBekannteGeraeteAusAuswahlQuellenUndRegistry(t *testing.T) {
	a := &Agent{Cfg: config.Defaults(), State: state.New("gs-ref", "test")}
	a.entRegistry = entities.Registry{Entities: []entities.Entity{
		{ID: "shelly-1", Driver: json.RawMessage(`{"communication":"shelly_http","connection":{"ip":"192.168.178.50","port":80,"channel":0}}`)},
		{ID: "ebyte-1", Driver: json.RawMessage(`{"communication":"ebyte_modbus_tcp","connection":{"ip":"192.168.178.60","unit_id":"1"}}`)},
		{ID: "ohne", Driver: json.RawMessage(`{"communication":"virtual"}`)},
	}}
	b := a.geraetesucheBekannt()
	if len(b) != 2 || b[0].Communication != "shelly_http" || b[0].Port != 80 || b[1].IP != "192.168.178.60" ||
		b[1].UnitID != 1 {
		t.Fatalf("known: %+v", b)
	}
}
