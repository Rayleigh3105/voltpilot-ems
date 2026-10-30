package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"path/filepath"
	"strconv"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche/suche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
)

// The device search on the box (Gerätesuche, docs/contracts/v2/mqtt-geraetesuche.md).
// An order on .../v2/geraetesuche (not retained) starts a read-only search of
// the box's own networks; progress goes out every 2 s, exactly one result per
// order. The admission and the one-shot discipline live in suche.Leitung; here
// is only what the agent knows: its identity, its box type, VP_LAN_HOST, what
// it already reads, and its link.
//
// Docker box: TCP through NAT to the /24 around VP_LAN_HOST, the open order on
// disk (geraetesuche-offen.json). Edge Light: its interfaces, the ARP table,
// mDNS/SSDP/Speedwire and the vendor list; the order in RAM only.

func (a *Agent) boxArt() string {
	if a.Cfg.BoxArt == geraetesuche.BoxArtEdgeLight {
		return geraetesuche.BoxArtEdgeLight
	}
	return geraetesuche.BoxArtDocker
}

// geraetesucheOffenPfad is where the Docker box keeps the open order; ""
// on Edge Light, which writes nothing to its flash.
func (a *Agent) geraetesucheOffenPfad() string {
	if a.boxArt() == geraetesuche.BoxArtEdgeLight || a.Cfg.DataDir == "" {
		return ""
	}
	return filepath.Join(a.Cfg.DataDir, "geraetesuche-offen.json")
}

func (a *Agent) neueGeraetesuche() *suche.Leitung {
	edgeLight := a.boxArt() == geraetesuche.BoxArtEdgeLight
	offen := a.geraetesucheOffenPfad()
	return suche.NeueLeitung(suche.LeitungOptionen{
		BoxArt: a.boxArt(),
		Identitaet: func() (string, string, string) {
			s := a.State.Get()
			return s.TenantID, s.SiteID, s.DeviceID
		},
		Umgebung: func() suche.Umgebung {
			u := suche.Umgebung{BoxArt: a.boxArt(), LANHost: a.Cfg.LANHost, Log: slog.Default().WithGroup("geraetesuche"),
				Dial: a.geraetesucheDial}
			if edgeLight {
				u.Schnittstellen, u.Routen, u.Nachbarn = suche.SystemSchnittstellen, suche.SystemRouten, suche.SystemNachbarn
				u.Anstoss = func(_ context.Context, ip netip.Addr) error { return suche.UDPAnstoss(ip) }
				u.Rundruf = suche.SystemRundruf{}
				a.geraetesucheMu.Lock()
				u.Spur = a.geraetesucheSpur
				a.geraetesucheMu.Unlock()
			}
			return u
		},
		Bekannt:       a.geraetesucheBekannt,
		SendeStand:    a.sendeGeraetesucheStand,
		SendeErgebnis: a.sendeGeraetesucheErgebnis,
		OffenPfad:     offen,
		Log:           slog.Default().WithGroup("geraetesuche"),
	})
}

// geraetesucheDial is the plain TCP dialer; tests replace it.
func (a *Agent) geraetesucheDial(ctx context.Context, addr string) (net.Conn, error) {
	if a.geraetesucheDialer != nil {
		return a.geraetesucheDialer(ctx, addr)
	}
	var d net.Dialer
	return d.DialContext(ctx, "tcp", addr)
}

// SetGeraetesucheSpur hands the Layer-1 logger lane of Edge Light to the
// search: a Solarman logger is only spoken to while the lane is ours, never
// next to a running poll or connection test.
func (a *Agent) SetGeraetesucheSpur(spur func(ctx context.Context, addr string) (func(), bool)) {
	a.geraetesucheMu.Lock()
	a.geraetesucheSpur = spur
	a.geraetesucheMu.Unlock()
}

// onGeraetesuche is the link's handler for .../v2/geraetesuche.
func (a *Agent) onGeraetesuche(payload []byte) {
	a.geraetesuche.Nimm(payload)
}

func (a *Agent) sendeGeraetesucheStand(s geraetesuche.Stand) error {
	a.linkMu.Lock()
	link := a.link
	a.linkMu.Unlock()
	if link == nil {
		return fmt.Errorf("no cloud link")
	}
	return link.PublishGeraetesucheStand(s)
}

func (a *Agent) sendeGeraetesucheErgebnis(e geraetesuche.Ergebnis) error {
	a.linkMu.Lock()
	link := a.link
	a.linkMu.Unlock()
	if link == nil {
		return fmt.Errorf("no cloud link")
	}
	return link.PublishGeraetesucheErgebnis(e)
}

// geraetesucheBekannt lists what the box already reads: the inverter
// selection, the additional sources and every registry entity whose driver
// names a connection. The search never connects to them again.
func (a *Agent) geraetesucheBekannt() []suche.Bekannt {
	var out []suche.Bekannt
	add := func(comm, brand, model, family, role string, c inverter.Connection) {
		if c.IP == "" {
			return
		}
		out = append(out, suche.Bekannt{Communication: comm, IP: c.IP, Port: c.Port, Serial: c.Serial,
			UnitID: c.MbSlaveID, Familie: family, Hersteller: brand, Modell: model, Rolle: role})
	}
	if a.invStore != nil {
		if sel, ok, err := a.invStore.Load(); err == nil && ok {
			add(sel.Communication, sel.Brand, sel.Model, sel.Family, "", sel.Connection)
		}
	}
	if a.srcStore != nil {
		if list, _, err := a.srcStore.Load(); err == nil {
			for _, s := range list {
				add(s.Communication, s.Brand, s.Model, s.Family, s.Role, s.Connection)
			}
		}
	}
	a.entMu.Lock()
	reg := a.entRegistry
	a.entMu.Unlock()
	for _, e := range reg.Entities {
		var d struct {
			Communication string          `json:"communication"`
			Connection    json.RawMessage `json:"connection"`
		}
		if len(e.Driver) == 0 || json.Unmarshal(e.Driver, &d) != nil || d.Communication == "" || len(d.Connection) == 0 {
			continue
		}
		var c struct {
			IP     string          `json:"ip"`
			Port   json.RawMessage `json:"port"`
			Serial json.RawMessage `json:"serial"`
			UnitID json.RawMessage `json:"unit_id"`
		}
		if json.Unmarshal(d.Connection, &c) != nil || c.IP == "" {
			continue
		}
		out = append(out, suche.Bekannt{Communication: d.Communication, IP: c.IP, Port: zahlAus(c.Port),
			Serial: textAus(c.Serial), UnitID: zahlAus(c.UnitID)})
	}
	return out
}

func zahlAus(raw json.RawMessage) int {
	s := textAus(raw)
	n, _ := strconv.Atoi(s)
	return n
}

func textAus(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String()
	}
	return ""
}
