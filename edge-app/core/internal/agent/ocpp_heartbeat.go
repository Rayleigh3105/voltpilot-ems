package agent

import (
	"log/slog"
	"net"
	"net/netip"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// chargersSummary builds the additive `chargers` heartbeat block from the very
// same view the :8484 card renders (Stufe 3 of the Lastmanagement concept,
// `vp-ocpp-lastmgmt-konzept-w4` §5.3 / PR 9).
//
// ⚠ It REPEATS the box's own words, it never forms an opinion. Budget, safe
// default, allocation reasons and every German sentence come out of
// internal/lastmgmt through state.OcppInfo; two renderings of one verdict could
// otherwise say it differently, and only the box knows the numbers behind it.
//
// nil = no block on the heartbeat, and that is the honest default: a box
// without a single registered charge point sends a BYTE-IDENTICAL heartbeat to
// the one it sent before this feature existed. A box whose OCPP flag is off
// likewise reports nothing - there is no plant to describe.
//
// OCPP "klopft an" (docs/contracts/ocpp-klopft-an.md): the charge points the
// box refused in the last 24 h ride along as `rejected` - and a knock alone
// sends the block too, with an empty list of chargers.
func (a *Agent) chargersSummary() *cloud.ChargersSummary {
	info := a.ocppInfo()
	if info == nil {
		return nil
	}
	rejected := a.klopfenAn(time.Now())
	if len(info.Chargers) == 0 && len(rejected) == 0 {
		return nil
	}
	out := &cloud.ChargersSummary{
		Rejected:         rejected,
		ControlStatus:    info.ControlStatus,
		ReportedAt:       time.Now().UTC().Format(time.RFC3339),
		Enabled:          info.Enabled,
		ControlEnabled:   info.ControlEnabled,
		ControlNote:      info.ControlNote,
		OcppPort:         info.Port,
		URLPath:          info.URLPath,
		GridLimitKw:      info.GridLimitKw,
		MarginPct:        info.MarginPct,
		MinPowerKw:       info.MinPowerKw,
		BudgetKw:         info.BudgetKw,
		AllocatedKw:      info.AllocatedKw,
		ReservedKw:       info.ReservedKw,
		MeasuredKw:       info.MeasuredKw,
		SiteLoadKw:       info.SiteLoadKw,
		SiteGridKw:       info.SiteGridKw,
		BudgetMode:       info.BudgetMode,
		BudgetNote:       info.BudgetNote,
		BudgetBlind:      info.BudgetBlind,
		EffLimitKw:       info.EffLimitKw,
		SafeDefaultKw:    info.SafeDefaultKw,
		SafeDefaultNote:  info.SafeDefaultNote,
		SafeDefaultHolds: info.SafeDefaultHolds,
		SafeWorstCaseKw:  info.SafeWorstCaseKw,
		MaxHouseLoadKw:   info.MaxHouseLoadKw,
		ConnectorCount:   info.ConnectorCount,

		SurplusPolicy:     info.SurplusPolicy,
		StoragePriority:   info.StoragePriority,
		SurplusActive:     info.SurplusActive,
		SurplusKw:         info.SurplusKw,
		SurplusMode:       info.SurplusMode,
		SurplusNote:       info.SurplusNote,
		SurplusBlind:      info.SurplusBlind,
		SurplusTotalKw:    info.SurplusTotalKw,
		SurplusBatteryKw:  info.SurplusBatteryKw,
		SourceAllocatedKw: info.SourceAllocatedKw,

		StorageReleaseActive:   info.StorageReleaseActive,
		StorageReleaseKw:       info.StorageReleaseKw,
		StorageReleaseFloorPct: info.StorageReleaseFloorPct,
		StorageReleaseSocPct:   info.StorageReleaseSocPct,
		StorageReleaseNote:     info.StorageReleaseNote,

		Chargers: make([]cloud.ChargerEntry, 0, len(info.Chargers)),
	}
	// „aus" is the absence of the feature, not a stage worth a column.
	if info.StorageReleaseMode != string(lastmgmt.ReleaseOff) {
		out.StorageReleaseMode = info.StorageReleaseMode
	}
	for _, c := range info.Chargers {
		out.Chargers = append(out.Chargers, chargerEntry(c))
	}
	return out
}

func chargerEntry(c state.OcppCharger) cloud.ChargerEntry {
	e := cloud.ChargerEntry{
		ID: c.ID, Label: c.Label, Priority: c.Priority, Connected: c.Connected,
		Vendor: c.Vendor, Model: c.Model, Firmware: c.Firmware,
		Ready: c.Ready, Note: c.Note,
		LastSeen:   msTime(c.LastSeenMs),
		Connection: c.Connection,
	}
	// Das Echo der Bahn (Konzept k1 Regel 4): mit einer Bahn IMMER auch die
	// Speicherfreigabe, ausdrücklich false - abwesend heißt „ältere Box".
	if c.Source != "" {
		e.Source = c.Source
		if c.MinKw > 0 {
			kw := c.MinKw
			e.MinKw = &kw
		}
		rel := c.StorageRelease
		e.StorageRelease = &rel
	}
	for _, con := range c.Connectors {
		if len(e.Connectors) >= cloudMaxConnectors {
			break
		}
		e.Connectors = append(e.Connectors, cloud.ChargerConnectorEntry{
			ID: con.ID, Status: con.Status, Charging: con.Charging,
			AllocatedKw: con.AllocatedKw,
			Reason:      con.Reason, ReasonText: con.ReasonText,
			NextTurn:      msTime(con.NextTurnMs),
			PowerKw:       con.PowerKw,
			EnergyKwh:     con.EnergyKwh,
			SocPct:        con.SocPct,
			CommandStatus: con.CommandStatus,
			Readback:      con.Readback,
			ReadbackNote:  con.ReadbackNote,
			SessionSince:  msTime(con.SessionSince),
			SessionKwh:    con.SessionKwh,
			MeteredAt:     msTime(con.MeteredAtMs),
			TagRef:        con.TagRef,
			Boost:         con.Boost,
			HandPaused:    con.HandPaused,
		})
	}
	return e
}

// cloudMaxConnectors mirrors the cloud package's own per-charger cap. It is
// repeated (not exported from there) because the block is assembled here and a
// caller that overshoots would be truncated silently at the wire.
const cloudMaxConnectors = 8

// msTime renders a wall-clock millisecond stamp as RFC 3339, or "" for the
// zero value - an absent stamp stays absent, never the epoch.
func msTime(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}

// klopfenAn is the checked list of refused charge points ([] = none knocked).
// An address goes along only as a private host address of the customer
// network: never one of the box's own and - on the Docker box - never one
// inside the container's own networks, which is the bridge or the userland
// proxy, not the station.
func (a *Agent) klopfenAn(now time.Time) []geraetesuche.KlopftAn {
	rt := a.ocpp
	if rt == nil || rt.srv == nil {
		return []geraetesuche.KlopftAn{}
	}
	eigene, eigeneNetze := a.eigeneAdressen()
	liste := rt.srv.KlopfenAn(now, func(ip netip.Addr) bool {
		if !geraetesuche.KlopftAnAdresse(ip.String(), eigene) {
			return false
		}
		if a.boxArt() == geraetesuche.BoxArtDocker {
			for _, p := range eigeneNetze {
				if p.Contains(ip) {
					return false
				}
			}
		}
		return true
	})
	if err := geraetesuche.PruefeKlopftAn(liste, eigene); err != nil {
		slog.Warn("ocpp klopft an: list not sent", "err", err)
		return []geraetesuche.KlopftAn{}
	}
	return liste
}

// eigeneAdressen are the box's own IPv4 addresses (its interfaces and, on the
// Docker box, VP_LAN_HOST) and the networks of its interfaces.
func (a *Agent) eigeneAdressen() ([]netip.Addr, []netip.Prefix) {
	var adressen []netip.Addr
	var netze []netip.Prefix
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, x := range addrs {
			ipn, ok := x.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil {
				continue
			}
			ip, _ := netip.AddrFromSlice(ipn.IP.To4())
			bits, _ := ipn.Mask.Size()
			adressen = append(adressen, ip)
			netze = append(netze, netip.PrefixFrom(ip, bits).Masked())
		}
	}
	host := a.Cfg.LANHost
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		adressen = append(adressen, ip.Unmap())
	}
	return adressen, netze
}
