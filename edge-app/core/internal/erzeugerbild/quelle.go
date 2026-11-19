package erzeugerbild

import (
	"math"
	"time"
)

// QuellenTelemetrie is the reading of an Anlagensteuerung as the box's SOURCE
// telemetry (EZ-17 Scheibe 1): the same per-source message every additional
// source publishes on edge/sources/<id>/telemetry, so the core folds it into
// the site sample (telemetry, Verlauf) on a box without an inverter of its own
// (agent.plantControllerSample). The twin of erzeugerQuelle.
type QuellenTelemetrie struct {
	PVPowerKW *float64 `json:"pv_power_kw,omitempty"`
	PowerKW   *float64 `json:"power_kw,omitempty"`
	Ts        string   `json:"ts"`
}

// QuellenTopic is where a source's telemetry goes on the local bus.
func QuellenTopic(sourceID string) string { return "edge/sources/" + sourceID + "/telemetry" }

// JSZeit is JavaScript's Date.toISOString: UTC with milliseconds.
func JSZeit(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// Quelle builds the source telemetry of a recognised reading. Only a GOOD
// value becomes a channel: stale, uncertain (grid point too old), invalid or
// not covered leaves the channel out - never a 0 (a plant without grid point:
// pv only). Own consumption (p_erzeugung_w < 0) is consumption, so the
// generation channel floors at 0. ok=false: neither channel, nothing to send.
func Quelle(l StufenLesung, jetzt time.Time) (QuellenTelemetrie, bool) {
	if l.Ergebnis != ErgebnisErkannt {
		return QuellenTelemetrie{}, false
	}
	gut := func(feld string) *float64 {
		for _, v := range l.Werte {
			if v.Feld == feld && v.Einheit == 0 {
				if v.Qualitaet == QualitaetGut && v.Wert != nil {
					return v.Wert
				}
				return nil
			}
		}
		return nil
	}
	erzeugung, netz := gut("p_erzeugung_w"), gut("p_nvp_w")
	if erzeugung == nil && netz == nil {
		return QuellenTelemetrie{}, false
	}
	out := QuellenTelemetrie{Ts: JSZeit(jetzt)}
	if erzeugung != nil {
		out.PVPowerKW = zeiger(math.Max(0, *erzeugung) / 1000)
	}
	if netz != nil {
		out.PowerKW = zeiger(*netz / 1000)
	}
	return out, true
}
