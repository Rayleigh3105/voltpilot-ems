package agent

import (
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
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
func (a *Agent) chargersSummary() *cloud.ChargersSummary {
	info := a.ocppInfo()
	if info == nil || len(info.Chargers) == 0 {
		return nil
	}
	out := &cloud.ChargersSummary{
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

		Chargers: make([]cloud.ChargerEntry, 0, len(info.Chargers)),
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
