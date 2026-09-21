package agent

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// AP-15 IP-22: the share loss reaches the heartbeat block only with a share
// document; a restarted agent continues the day's count from disk.
func TestAnteilVerlustNurMitDokumentUndNeustartfest(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.DevTenantID, cfg.DevSiteID, cfg.DevDeviceID = vaTenant, vaSite, vaE4
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	a.State.Update(func(s *state.Snapshot) { s.TenantID, s.SiteID, s.DeviceID = vaTenant, vaSite, vaE4 })
	if a.gemeinsameSteuerung() != nil {
		t.Fatal("block without any document")
	}
	quittung(t, a.nimmAnteile(anteilDok(vaSite, 1, 8, "40.0", "30.0", "steuert_mit"), time.Now()), true, "", 8)

	// one minute with the share of 30 kW holding 57 kW of available PV
	c := guards.ExportCap{Active: true, CapKw: 30, AnteilKw: fp(30), HeuteCapKw: fp(70)}
	// noon of today in the plant's time - never across a midnight
	loc, _ := time.LoadLocation(verlustZone)
	l := time.Now().In(loc)
	now := time.Date(l.Year(), l.Month(), l.Day(), 12, 0, 0, 0, loc)
	for i := 0; i <= 6; i++ {
		a.verlust.ZaehleVerfuegbar(now.Add(time.Duration(i)*10*time.Second), c, false, fp(30), fp(57))
	}
	if err := a.verlust.Speichern(); err != nil {
		t.Fatal(err)
	}
	b := a.gemeinsameSteuerung()
	if b == nil || b.AnteilVerlust == nil || b.AnteilVerlust.GebundenS != 60 || b.AnteilVerlust.Kwh != 0.5 {
		t.Fatalf("block: %+v", b)
	}
	raw, _ := json.Marshal(b)
	if !strings.Contains(string(raw), `"anteil_verlust":{"tag":"`+a.verlust.TagVon(now)+`","kwh":0.5,"gebunden_s":60}`) {
		t.Fatalf("heartbeat block: %s", raw)
	}

	nachher, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if h, _ := nachher.verlust.Stand(); h.Kwh != 0.5 || h.GebundenS != 60 {
		t.Fatalf("after restart: %+v", h)
	}
}

func fp(v float64) *float64 { return &v }
