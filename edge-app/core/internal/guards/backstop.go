// Rückhalt der Einspeisegrenze bei Box-Ausfall (package K6, concept
// vp-wechselrichter-eigenregelung-k1 §6.4).
//
// The feed-in watchdog (exportlimit.go) holds a site's feed-in limit only while
// the box lives. Its actuators are built to FORGET when the box goes silent:
// a Fronius releases WMaxLimPct after WMaxLimPct_RvrtTms (60 s, set by
// sunspec/curtail.js on purpose - a dead box must never pin a plant), and the
// plant then feeds in whatever it produces. At Herzogau that is 2 × 27 kW of
// Fronius against a registered limit of 30 kW.
//
// A limit that must hold without the box needs a DEVICE-SIDE backstop: a
// producer that regulates the connection point on its own meter and setting
// (Fronius' own dynamic power reduction with a Fronius meter at the feed-in
// point, SMA's via the Home Manager, a hybrid's own export limit when it can
// reach every producer). The box does not write any of that (E5 A) - it READS
// what it can, takes the installer's statement for the rest, and WARNS when
// neither covers the limit. The installer's recommendation lives in
// docs/edge-runtime.md#rückhalt-der-einspeisegrenze-bei-box-ausfall-k6.
package guards

import "fmt"

// The installer's statement (BalanceSettings.ExportBackstop). "" = not stated.
const (
	ExportBackstopNone    = "keiner"
	ExportBackstopPresent = "vorhanden"
)

// The verdict sources.
const (
	BackstopDeclared = "gemeldet"
	BackstopDevice   = "geraet"
)

// ExportBackstopToleranceKw: a device limit this much above the site limit
// still counts as holding it - the register's own resolution and the meter
// class, not a loophole.
const ExportBackstopToleranceKw = 0.5

// BackstopInput is what the box knows about the site's feed-in limit without
// itself.
type BackstopInput struct {
	// LimitKw is the site's feed-in limit (nil = none; no verdict at all).
	LimitKw *float64
	// Declared is the installer's statement (ExportBackstop*).
	Declared string
	// DeviceLimitKw is the leader's OWN feed-in limit as read from the device
	// (the Deye's 0x00E7); nil = not read / not readable.
	DeviceLimitKw *float64
	// MeterLocation is the leader's declared meter location (Meter*): its own
	// limit regulates the whole connection point only from there.
	MeterLocation string
	// OtherPvKwp is the nameplate sum of the further PV producers (the
	// measurement-point sources), OtherPvUnknown true when one lacks it.
	OtherPvKwp     float64
	OtherPvUnknown bool
}

// BackstopVerdict: Covered with its Source, or a warning in Text.
type BackstopVerdict struct {
	Covered bool
	Source  string
	Text    string
}

// ExportBackstopFor judges the backstop. ok=false when the site has no limit.
func ExportBackstopFor(in BackstopInput) (BackstopVerdict, bool) {
	if in.LimitKw == nil || !finite(*in.LimitKw) || *in.LimitKw < 0 {
		return BackstopVerdict{}, false
	}
	limit := *in.LimitKw
	if in.Declared == ExportBackstopPresent {
		return BackstopVerdict{Covered: true, Source: BackstopDeclared,
			Text: "Ein geräteseitiger Rückhalt der Einspeisegrenze ist bei der Einrichtung gemeldet: fällt die " +
				"Box aus, hält die Anlage die Grenze selbst."}, true
	}
	head := fmt.Sprintf("Die Einspeisegrenze von %s kW hält nur die Box: fällt sie aus, geben die "+
		"abgeregelten Wechselrichter nach ihrer Rückfallzeit (Fronius: 60 s) die volle Leistung frei.", kw1(limit))
	var why string
	if d := in.DeviceLimitKw; d != nil && finite(*d) {
		switch {
		case *d > limit+ExportBackstopToleranceKw:
			why = fmt.Sprintf(" Die eigene Grenze des Wechselrichters (%s kW) liegt über der Einspeisegrenze.", kw1(*d))
		case in.MeterLocation != MeterAtGridPoint:
			why = fmt.Sprintf(" Die eigene Grenze des Wechselrichters (%s kW) wirkt nur, wenn sein Zähler am "+
				"Netzpunkt sitzt - das ist nicht angegeben.", kw1(*d))
		case in.OtherPvUnknown:
			why = fmt.Sprintf(" Die eigene Grenze des Wechselrichters (%s kW) regelt nur seine eigene Erzeugung; "+
				"ob die weiteren Erzeuger die Grenze allein überschreiten können, ist unbekannt (Nennleistung fehlt).", kw1(*d))
		case in.OtherPvKwp > limit:
			why = fmt.Sprintf(" Die eigene Grenze des Wechselrichters (%s kW) regelt nur seine eigene Erzeugung; "+
				"die weiteren Erzeuger (%s kWp) können die Grenze allein überschreiten.", kw1(*d), kw1(in.OtherPvKwp))
		default:
			return BackstopVerdict{Covered: true, Source: BackstopDevice,
				Text: fmt.Sprintf("Der Wechselrichter hält selbst eine Einspeisegrenze von %s kW am Netzpunkt; die "+
					"weiteren Erzeuger (%s kWp) können sie allein nicht überschreiten.", kw1(*d), kw1(in.OtherPvKwp))}, true
		}
	}
	tail := " Ein geräteseitiger Rückhalt ist nicht gemeldet - bitte beim Installateur einrichten lassen " +
		"(Anleitung „Rückhalt der Einspeisegrenze“)."
	if in.Declared == ExportBackstopNone {
		tail = " Bei der Einrichtung ist „kein geräteseitiger Rückhalt“ angegeben - bitte beim Installateur " +
			"einrichten lassen (Anleitung „Rückhalt der Einspeisegrenze“)."
	}
	return BackstopVerdict{Text: head + why + tail}, true
}
