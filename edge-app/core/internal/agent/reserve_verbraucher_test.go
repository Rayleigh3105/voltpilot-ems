package agent

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// AP-15 Folge of IP-19: reserve_verbraucher of the share document reaches the
// Bezugswaechter (the charge park gets share − reserve) and the heartbeat
// block - also after a restart (the document lives on disk). A document
// without the field claims no reserve.
func TestReserveVerbraucherAusDemDokumentInWaechterUndHerzschlag(t *testing.T) {
	mitReserve := bytes.Replace(anteilDok(vaSite, 1, 8, "10.0", "60.0", "steuert_mit"),
		[]byte(`"published_at"`), []byte(`"reserve_verbraucher":{"bezug":10.0},"published_at"`), 1)
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.DevTenantID, cfg.DevSiteID, cfg.DevDeviceID = vaTenant, vaSite, vaE4
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	a.State.Update(func(s *state.Snapshot) { s.TenantID, s.SiteID, s.DeviceID = vaTenant, vaSite, vaE4 })
	quittung(t, a.nimmAnteile(mitReserve, time.Now()), true, "", 8)

	nachher, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for name, box := range map[string]*Agent{"angenommen": a, "nach Neustart": nachher} {
		an := box.bezugAnteil()
		if an == nil || an.AnteilKw != 77 || an.ReserveKw != 10 || an.Fuehrt {
			t.Fatalf("%s: import share %+v, want 77 kW with a reserve of 10", name, an)
		}
		raw, _ := json.Marshal(box.gemeinsameSteuerung())
		if !strings.Contains(string(raw), `"anteile_kw":{"einspeisung":60.0,"bezug":77.0},"reserve_verbraucher_kw":{"bezug":10.0}`) {
			t.Fatalf("%s: heartbeat block %s does not mirror the reserve", name, raw)
		}
	}

	// the next document without the field (an older cloud): no reserve, and
	// the heartbeat does not claim one
	a.State.Update(func(s *state.Snapshot) { s.TenantID, s.SiteID, s.DeviceID = vaTenant, vaSite, vaE4 })
	quittung(t, a.nimmAnteile(anteilDok(vaSite, 1, 9, "10.0", "60.0", "steuert_mit"), time.Now()), true, "", 9)
	if an := a.bezugAnteil(); an == nil || an.ReserveKw != 0 || an.AnteilKw != 77 {
		t.Fatalf("without the field: %+v, want 77 kW and no reserve", an)
	}
	if raw, _ := json.Marshal(a.gemeinsameSteuerung()); strings.Contains(string(raw), "reserve_verbraucher") {
		t.Fatalf("heartbeat block claims a reserve without the field: %s", raw)
	}
}
