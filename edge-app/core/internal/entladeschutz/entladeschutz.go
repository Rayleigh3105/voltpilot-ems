// Package entladeschutz decides how much a bidirectional vehicle may feed back
// right now - the box's discharge command with protection limits (MiSpeL
// MP-39, Bauplan vp-mispel-fundament § 8, Entscheid E3 = D).
//
// The cloud plans (Fahrzeug als Speicher, MP-33); the box decides locally
// whether a planned discharge is executed and how far (CLAUDE.md „Cloud
// plant; der Go-Core entscheidet über lokale Ausführung und Schutzgrenzen“).
// Entscheiden is pure: every input is a field of Lage, every refusal names
// its limit in Grund. The runtime that feeds it and sends the setpoint is
// Waechter (waechter.go).
//
// Words after the Festlegung (Anlage 1, 01.10.2026): feeding back is
// „Erzeugung im Ladepunkt“, charging „Verbrauch im Ladepunkt“ (A1 S. 27,
// Abschn. 3.2.5). The stage „nur ins Haus“ (V2H) is the technical rule of the
// „Alternative zur Ausschließlichkeitsoption“: no Erzeugung im Ladepunkt
// „während es gleichzeitig eine Netzeinspeisung gibt“ (A1 S. 11, Abschn.
// 2.1.3; S. 26 Fn. 21; S. 27 Fn. 22). Everything else here - export limit,
// § 14a EnWG, reserve, departure target, driver's consent, abort on
// unplugging - is protection on the box, not a rule of the Festlegung.
//
// In doubt the vehicle charges instead of feeding back: every unknown input
// (unknown is not zero, stale telemetry is not current) ends in 0 kW.
package entladeschutz

import (
	"math"
	"strings"
	"time"
)

// Freigabe is the driver's consent, carried in the plan (mqtt-schedule-2.0,
// entity block `fahrzeug.rueckspeisen`); the customer sets it in the portal
// (MP-41, after the operating concept BK-41). Absent or unknown = aus.
type Freigabe string

const (
	// FreigabeAus: the box never feeds back from this vehicle.
	FreigabeAus Freigabe = "aus"
	// FreigabeV2H: only into the house (vehicle-to-home) - no Erzeugung im
	// Ladepunkt while the site feeds into the grid (A1 S. 11, Abschn. 2.1.3).
	FreigabeV2H Freigabe = "v2h"
	// FreigabeV2G: house and grid (vehicle-to-grid), up to the export limit
	// of the grid connection (A1 S. 26 Fn. 21).
	FreigabeV2G Freigabe = "v2g"
)

// FreigabeLesen reads the plan's word; anything it does not know is aus.
func FreigabeLesen(s string) Freigabe {
	switch f := Freigabe(strings.TrimSpace(s)); f {
	case FreigabeV2H, FreigabeV2G:
		return f
	default:
		return FreigabeAus
	}
}

// Gründe - why a discharge is refused (0 kW) or reduced. Exactly one is
// reported: the first hard stop, or the tightest power limit.
const (
	GrundSchalterAus          = "schalter_aus"             // csms.Options.V2XDischarge off (default)
	GrundLademodusAus         = "lademodus_aus"            // Lademodus „Aus“: a Handeingriff pauses this charge (MP-39b)
	GrundLademodusSchnell     = "lademodus_schnell"        // Lademodus „Schnell“: only charge, for this charge (MP-39b)
	GrundAutomatikPausiert    = "automatik_pausiert"       // „Automatik pausieren“: every entity on its failsafe (MP-39b)
	GrundPlanVeraltet         = "plan_veraltet"            // no fresh plan: no discharge wish exists
	GrundCloudGetrennt        = "cloud_getrennt"           // communication loss with the cloud
	GrundFreigabeAus          = "freigabe_aus"             // driver's consent absent or aus
	GrundKeinWunsch           = "kein_wunsch"              // the plan does not ask for feeding back now
	GrundVerbindungVerloren   = "verbindung_verloren"      // communication loss with the station
	GrundNichtOCPP21          = "nicht_ocpp21"             // only the OCPP 2.1 lane can feed back (MP-37)
	GrundAbgesteckt           = "abgesteckt"               // no vehicle / no session on the connector
	GrundEigenerNetzanschluss = "eigener_netzanschluss"    // station outside the site's grid meter
	GrundNichtBidirektional   = "nicht_bidirektional"      // the vehicle does not ask for a BPT mode
	GrundLadestandUnbekannt   = "ladestand_unbekannt"      // SoC missing or stale
	GrundMindestSocUnbekannt  = "mindest_soc_unbekannt"    // the plan names no reserve
	GrundMindestSoc           = "mindest_soc"              // at or below the reserve
	GrundUnterV2XBereich      = "unter_v2x_bereich"        // the vehicle reports energy below its V2X range
	GrundAbfahrtUnbekannt     = "abfahrt_unbekannt"        // departure, target, capacity or charge power unknown
	GrundAbfahrtsziel         = "abfahrtsziel"             // feeding back would put the departure target out of reach
	GrundLeistungUnbekannt    = "leistung_unbekannt"       // neither wallbox nor vehicle names a feed-back power
	GrundNetzUnbekannt        = "netz_unbekannt"           // grid meter missing or stale
	GrundNurHaus              = "nur_haus"                 // V2H: never while the site feeds in
	GrundExportgrenze         = "exportgrenze"             // V2G: export limit of the grid connection
	GrundLeistungsgrenze      = "leistungsgrenze"          // wallbox or vehicle power limit
	GrundFahrzeugMindest      = "fahrzeug_mindestleistung" // allowed power below the vehicle's minimum
)

// Fixed protection margins. They are box rules, not values of the Festlegung.
const (
	// MaxAlterLadestand: an older SoC is not current.
	MaxAlterLadestand = 5 * time.Minute
	// MaxAlterNetz: an older grid reading is not current (the live meter age
	// the charge-point executor uses, csms.MaxLiveMeterAge).
	MaxAlterNetz = 30 * time.Second
	// SocMargePct: feeding back stops this far above the reserve - the SoC
	// report lags behind the energy that already flowed.
	SocMargePct = 1.0
	// NetzMargeKw: V2H keeps at least this much import at the grid meter,
	// V2G this much below the export limit - the regulation's dead band.
	NetzMargeKw = 0.2
	// AbfahrtPuffer: the departure target must be reachable this much
	// earlier than the departure (one plan slot).
	AbfahrtPuffer = 15 * time.Minute
	// MindestEntladenKw: below this the box does not start a feed-back at
	// all (no flapping around zero).
	MindestEntladenKw = 0.5
)

// WirkungsgradJeWeg is √0,85 for one direction: the Festlegung fixes the
// round trip through a charge point at (14)A2,A3,A4 = 0,85 „mangels
// geeigneter Messwerte“ (A1 S. 35); optimizer (MP-33) and simulator (MP-34)
// split it the same way. Used only to keep the departure target reachable.
var WirkungsgradJeWeg = math.Sqrt(0.85)

// Lage is everything the decision reads, at one moment. Pointers: nil =
// unknown, never 0.
type Lage struct {
	Jetzt time.Time
	// Schalter is csms.Options.V2XDischarge - the global switch, default off.
	Schalter bool
	// Halt is a local reason that holds every feed-back on this connector,
	// whatever the plan says (MiSpeL MP-39b, captain's decision 04.10.2026:
	// Aus, Schnell and a scene hold the feed-back): GrundLademodusAus or
	// GrundLademodusSchnell while a Handeingriff runs on this charge (the
	// boost/pause of the load management, bound to its session), or
	// GrundAutomatikPausiert while the operator pause holds the box. Empty =
	// nothing holds. The box knows no scene: a scene arrives with the plan
	// (no vehicle block = Freigabe aus).
	Halt string

	// --- the cloud's plan (mqtt-schedule-2.0, entity block `fahrzeug`) ---

	// PlanFrisch: the plan is fresh (plan2.Plan.Fresh); CloudVerbunden: the
	// box currently holds its cloud connection.
	PlanFrisch, CloudVerbunden bool
	Freigabe                   Freigabe
	// WunschKw is the plan's feed-back wish for the current slot as a
	// magnitude (>= 0; a negative setpoint_kw of the charger entity).
	WunschKw float64
	// MindestSocPct is the driver's reserve (`fahrzeug.mindest_soc_pct`,
	// MP-31 § 5): never feed back below it. nil = not said = no feed-back.
	MindestSocPct *float64
	// AbfahrtAt / AbfahrtSocPct: the next departure and its target from the
	// plan (the vehicle window, MP-31 § 5); KapazitaetKwh the usable capacity
	// of the vehicle that usually stands here.
	AbfahrtAt     *time.Time
	AbfahrtSocPct *float64
	KapazitaetKwh *float64

	// --- the station (csms) ---

	// Verbunden: the station's socket is up and it spoke recently.
	Verbunden bool
	// OCPP21: the station runs on the OCPP 2.1 lane (only it can feed back).
	OCPP21 bool
	// Angesteckt: a vehicle is plugged in with a running session.
	Angesteckt bool
	// EigenerNetzanschluss: the station hangs on its own grid connection and
	// is NOT inside the site's grid meter - house and export limit unknown.
	EigenerNetzanschluss bool
	// RueckspeiseleistungKw is the wallbox's feed-back power (plan block, MP-31
	// § 2); LadeleistungKw its charging power and StationsleistungKw its rated
	// power as the station declares it (csms MaxKw) - an upper bound both ways.
	RueckspeiseleistungKw, LadeleistungKw, StationsleistungKw *float64

	// --- the vehicle (ISO 15118-20 over OCPP 2.1, MP-37 csms.EVNeeds) ---

	FahrzeugBidirektional bool
	// SocPct / SocZeit: the vehicle's state of charge and when it was measured.
	SocPct  *float64
	SocZeit time.Time
	// The vehicle's own view: capacity, departure, target, energy below its
	// V2X range (evMinV2XEnergyRequest > 0), power limits (magnitudes).
	FahrzeugKapazitaetKwh *float64
	FahrzeugAbfahrtAt     *time.Time
	FahrzeugZielSocPct    *float64
	FahrzeugUnterV2XKwh   *float64
	FahrzeugMaxLadeKw     *float64
	FahrzeugMaxEntladeKw  *float64
	FahrzeugMinEntladeKw  *float64

	// --- the grid connection ---

	// NetzKw is the site's grid meter (Z1), + = Netzbezug, − = Netzeinspeisung,
	// INCLUDING the charge point; NetzZeit when it was measured.
	NetzKw   *float64
	NetzZeit time.Time
	// AktuellEntladenKw is the feed-back the station last ACCEPTED (magnitude,
	// 0 when none) - the actuator state the grid balance is corrected with.
	AktuellEntladenKw float64
	// ExportgrenzeKw is the export limit of the grid connection; nil = not
	// configured, then V2G feeds in nothing (it behaves like V2H).
	ExportgrenzeKw *float64
	// Paragraph14aKw is the observed § 14a EnWG envelope (import cap at the
	// connection point); nil = never reported. It caps the charging power
	// the departure target is computed with.
	Paragraph14aKw *float64
}

// Entscheid is the box's answer: how much to feed back now.
type Entscheid struct {
	// EntladenKw is the allowed feed-back power at the meter (magnitude, >= 0).
	// It is sent as a NEGATIVE OCPP 2.1 setpoint.
	EntladenKw float64
	// Grund names the limit that bound (empty: the wish is executed verbatim).
	Grund string
	// Modus is the effective stage (v2h or v2g) when EntladenKw > 0.
	Modus Freigabe
}

func aus(grund string) Entscheid { return Entscheid{Grund: grund} }

// Entscheiden applies every protection limit to the plan's wish.
func Entscheiden(l Lage) Entscheid {
	// Hard stops, in the order a reader checks them.
	switch {
	case !l.Schalter:
		return aus(GrundSchalterAus)
	case l.Halt != "":
		// The customer's hand on this charge (or the operator pause) outranks
		// the plan: safety before the next plan run.
		return aus(l.Halt)
	case l.Freigabe != FreigabeV2H && l.Freigabe != FreigabeV2G:
		return aus(GrundFreigabeAus)
	case !l.PlanFrisch:
		return aus(GrundPlanVeraltet)
	case !l.CloudVerbunden:
		return aus(GrundCloudGetrennt)
	case !(l.WunschKw > 0) || math.IsInf(l.WunschKw, 0):
		return aus(GrundKeinWunsch)
	case !l.Verbunden:
		return aus(GrundVerbindungVerloren)
	case !l.OCPP21:
		return aus(GrundNichtOCPP21)
	case !l.Angesteckt:
		return aus(GrundAbgesteckt)
	case l.EigenerNetzanschluss:
		return aus(GrundEigenerNetzanschluss)
	case !l.FahrzeugBidirektional:
		return aus(GrundNichtBidirektional)
	}

	// Reserve (Mindest-Ladestand): the driver's, and the vehicle's own floor.
	soc, ok := wert(l.SocPct)
	if !ok || l.SocZeit.IsZero() || l.Jetzt.Sub(l.SocZeit) > MaxAlterLadestand || soc < 0 || soc > 100 {
		return aus(GrundLadestandUnbekannt)
	}
	reserve, ok := wert(l.MindestSocPct)
	if !ok {
		return aus(GrundMindestSocUnbekannt)
	}
	if soc <= reserve+SocMargePct {
		return aus(GrundMindestSoc)
	}
	if v, ok := wert(l.FahrzeugUnterV2XKwh); ok && v > 0 {
		return aus(GrundUnterV2XBereich)
	}

	// Departure target: always reachable, even when the box charges with the
	// slowest power it can count on.
	kapazitaet, ok := maxWert(l.KapazitaetKwh, l.FahrzeugKapazitaetKwh)
	abfahrt, okA := fruehester(l.AbfahrtAt, l.FahrzeugAbfahrtAt)
	ziel, okZ := maxWert(l.AbfahrtSocPct, l.FahrzeugZielSocPct)
	ladeKw, okL := minWert(l.LadeleistungKw, l.FahrzeugMaxLadeKw, l.Paragraph14aKw)
	if !ok || !okA || !okZ || !okL || kapazitaet <= 0 {
		return aus(GrundAbfahrtUnbekannt)
	}
	ziel = math.Max(ziel, reserve)
	rest := abfahrt.Sub(l.Jetzt) - AbfahrtPuffer
	if rest <= 0 {
		return aus(GrundAbfahrtsziel)
	}
	nachladbarPct := ladeKw * WirkungsgradJeWeg * rest.Hours() / kapazitaet * 100
	benoetigtPct := ziel - nachladbarPct
	if soc <= benoetigtPct+SocMargePct {
		return aus(GrundAbfahrtsziel)
	}

	// Power: the wish, the wallbox and the vehicle.
	e := Entscheid{EntladenKw: l.WunschKw}
	grenze, ok := minWert(l.RueckspeiseleistungKw, l.FahrzeugMaxEntladeKw)
	if !ok {
		return aus(GrundLeistungUnbekannt)
	}
	if v, ok := wert(l.StationsleistungKw); ok && v < grenze {
		grenze = v
	}
	if grenze < e.EntladenKw {
		e.EntladenKw, e.Grund = grenze, GrundLeistungsgrenze
	}

	// Grid: the balance without the charge point, corrected by the feed-back
	// the station accepted (the meter includes the charge point).
	netz, ok := wert(l.NetzKw)
	if !ok || l.NetzZeit.IsZero() || l.Jetzt.Sub(l.NetzZeit) > MaxAlterNetz {
		return aus(GrundNetzUnbekannt)
	}
	ohneLadepunkt := netz + math.Max(0, l.AktuellEntladenKw)
	modus := l.Freigabe
	export, okE := wert(l.ExportgrenzeKw)
	if modus == FreigabeV2G && (!okE || export <= 0) {
		modus = FreigabeV2H
	}
	var netzGrenze float64
	var netzGrund string
	if modus == FreigabeV2H {
		// A1 S. 11, Abschn. 2.1.3: keine Erzeugung im Ladepunkt, „während es
		// gleichzeitig eine Netzeinspeisung gibt“.
		netzGrenze, netzGrund = ohneLadepunkt-NetzMargeKw, GrundNurHaus
		if l.Freigabe == FreigabeV2G {
			netzGrund = GrundExportgrenze
		}
	} else {
		netzGrenze, netzGrund = ohneLadepunkt+export-NetzMargeKw, GrundExportgrenze
	}
	if netzGrenze < e.EntladenKw {
		e.EntladenKw, e.Grund = netzGrenze, netzGrund
	}

	if v, ok := wert(l.FahrzeugMinEntladeKw); ok && e.EntladenKw < v {
		return aus(GrundFahrzeugMindest)
	}
	if e.EntladenKw < MindestEntladenKw {
		if e.Grund == "" {
			e.Grund = GrundLeistungsgrenze
		}
		return aus(e.Grund)
	}
	e.Modus = modus
	return e
}

func wert(p *float64) (float64, bool) {
	if p == nil || math.IsNaN(*p) || math.IsInf(*p, 0) {
		return 0, false
	}
	return *p, true
}

// minWert is the smallest KNOWN value; ok = at least one is known.
func minWert(ps ...*float64) (float64, bool) {
	out, ok := math.Inf(1), false
	for _, p := range ps {
		if v, known := wert(p); known && v < out {
			out, ok = v, true
		}
	}
	return out, ok
}

// maxWert is the largest KNOWN value; ok = at least one is known.
func maxWert(ps ...*float64) (float64, bool) {
	out, ok := math.Inf(-1), false
	for _, p := range ps {
		if v, known := wert(p); known && v > out {
			out, ok = v, true
		}
	}
	return out, ok
}

func fruehester(ts ...*time.Time) (time.Time, bool) {
	var out time.Time
	for _, t := range ts {
		if t != nil && !t.IsZero() && (out.IsZero() || t.Before(out)) {
			out = *t
		}
	}
	return out, !out.IsZero()
}
