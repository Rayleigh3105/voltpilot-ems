package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// quelleEchoVektoren liest den Abschnitt `box` des Vertrags
// docs/contracts/ladepunkt-quelle-echo-vectors.json - dieselbe Datei, aus der
// API und Portal ihre Hälfte prüfen.
type quelleEchoBox struct {
	Name       string          `json:"name"`
	SitePolicy string          `json:"site_policy"`
	Station    json.RawMessage `json:"station"`
	Heartbeat  struct {
		Source         string   `json:"source"`
		MinKw          *float64 `json:"min_kw"`
		StorageRelease *bool    `json:"storage_release"`
	} `json:"heartbeat"`
}

// Konzept k1 Regel 4 („Gewählt ist nicht geladen"): der Herzschlag nennt je
// Säule die Bahn, die die Box FÄHRT - aufgelöst wie die Entscheidung, mit der
// Speicherfreigabe immer ausdrücklich. Der Weg ist der echte: das retained
// Dokument stellt die Säule ein, der Herzschlag meldet sie zurück.
func TestTheHeartbeatEchoesTheLaneEachStationRuns(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts",
		"ladepunkt-quelle-echo-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Box []quelleEchoBox `json:"box"`
	}
	if err := json.Unmarshal(raw, &v); err != nil || len(v.Box) == 0 {
		t.Fatalf("vectors: %v", err)
	}
	for _, c := range v.Box {
		t.Run(c.Name, func(t *testing.T) {
			a := chargingCfgAgent(t)
			ocppSite(t, a, 0)
			a.ocpp.mu.Lock()
			a.ocpp.settings.SurplusPolicy = lastmgmt.SurplusPolicy(c.SitePolicy)
			a.ocpp.mu.Unlock()
			var station map[string]any
			if err := json.Unmarshal(c.Station, &station); err != nil {
				t.Fatal(err)
			}
			station["id"] = "saeule-echo"
			cp, _ := json.Marshal([]any{station})
			a.onChargingConfig([]byte(fmt.Sprintf(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
			  "device_id":"d","charge_points":%s,"published_at":"2026-10-23T13:11:00Z"}`, cp)))

			sum := a.chargersSummary()
			if sum == nil || len(sum.Chargers) != 1 {
				t.Fatalf("summary = %+v", sum)
			}
			e := sum.Chargers[0]
			if e.Source != c.Heartbeat.Source {
				t.Fatalf("source = %q, want %q", e.Source, c.Heartbeat.Source)
			}
			if (e.MinKw == nil) != (c.Heartbeat.MinKw == nil) || (e.MinKw != nil && *e.MinKw != *c.Heartbeat.MinKw) {
				t.Fatalf("min_kw = %v, want %v", e.MinKw, c.Heartbeat.MinKw)
			}
			if e.StorageRelease == nil || c.Heartbeat.StorageRelease == nil || *e.StorageRelease != *c.Heartbeat.StorageRelease {
				t.Fatalf("storage_release = %v, want %v (always explicit next to a lane)", e.StorageRelease, c.Heartbeat.StorageRelease)
			}
		})
	}
}

// Eine Säule ohne Bahn-Aussage (eine ältere Box) schickt die Felder gar nicht:
// abwesend heißt „nicht bestätigt", nie eine erfundene Bahn.
func TestAStationWithoutALaneSendsNoEcho(t *testing.T) {
	e := chargerEntry(stateChargerOhneBahn())
	b, _ := json.Marshal(e)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for _, k := range []string{"source", "min_kw", "storage_release"} {
		if _, ok := m[k]; ok {
			t.Fatalf("%s must be absent without a lane: %s", k, b)
		}
	}
}

func stateChargerOhneBahn() state.OcppCharger {
	return state.OcppCharger{ID: "alt", Connected: true}
}
