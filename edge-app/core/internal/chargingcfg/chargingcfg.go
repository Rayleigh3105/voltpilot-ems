// Package chargingcfg parses the RETAINED load-management configuration the
// portal sends to this box (contract
// docs/contracts/mqtt-charging-config.schema.json, Lastmanagement Stufe 3).
//
// It is the PURE half - no I/O, no clock of its own, no MQTT import - so every
// rule below is provable without a broker (the internal/probe / internal/otaapply
// discipline of the house).
//
// ⚠ THE DOCUMENT IS A WISH, NOT A DISTRIBUTION. It carries the two numbers the
// customer owns - the connection limit at their grid connection point and which
// stations get priority - and nothing else. The allocation itself is computed
// and enforced HERE, in internal/lastmgmt: the connection limit is a PHYSICAL
// limit, so its watchdog must not hang off the WAN (concept E1).
//
// ⚠ PATCH SEMANTICS, and they are load-bearing: an ABSENT field KEEPS what the
// box has. The portal owns the connection limit and the priority choice today;
// the safety margin, the minimum power and the highest known building load stay
// settings of this box (:8484). A document that silently reset them would be a
// data loss nobody asked for.
package chargingcfg

import (
	"encoding/json"
	"errors"
	"fmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppcontrol"
	"math"
	"strings"
)

// SchemaVersion is the only contract version this box understands. A document
// carrying anything else is DISCARDED (fail-closed) and the box keeps its own
// settings - the same rule as the control-certification document.
const SchemaVersion = "1.0"

// MaxGridLimitKw mirrors the contract's plausibility ceiling. It is deliberately
// generous (a DC charging park hangs off a medium-voltage connection) and only
// catches the typo that turns 277 kW into 277000.
const MaxGridLimitKw = 100000

// MaxPriorities mirrors the contract's cap on the priority list.
const MaxPriorities = 64

// MaxChargePoints mirrors the contract's cap on the allowlist.
const MaxChargePoints = 64

// MaxWallboxes mirrors the contract's cap on `wallboxes[]`, and MaxRank its
// ceiling on a Rangliste position (Verbrauchsmanagement v1 / P6).
const (
	MaxWallboxes = 64
	MaxRank      = 4096
)

// MaxVehicleProfiles mirrors the contract's cap on the vehicle profiles (P7).
// Generous on purpose: a company yard with one card per driver is a real site,
// and a bound that refuses a real one is worse than none.
const MaxVehicleProfiles = 128

// The connection vocabulary of the contract. Repeated here (not imported from
// csms) because this package is the PARSER and must stay free of the runtime -
// the two are pinned against each other in chargingcfg's tests.
const (
	connectionHaus  = "haus"
	connectionEigen = "eigen"
)

// ErrEmpty is the withdrawal: an empty retained payload takes the document
// back, and afterwards only what is maintained on the box applies.
var ErrEmpty = errors.New("das Konfigurations-Dokument wurde zurückgenommen")

// Config is the parsed document. Both fields are OPTIONAL by contract, and the
// difference between "absent" and "empty" is the whole PATCH semantics:
//
//	GridLimitKw == nil  -> the portal says nothing; keep the box's own number.
//	Priorities  == nil  -> the portal says nothing; keep the box's own choice.
//	Priorities  == []   -> an ASSERTION ("no station has priority") and applied.
type Config struct {
	OcppControl *ocppcontrol.Policy
	TenantID    string
	SiteID      string
	DeviceID    string
	GridLimitKw *float64
	Priorities  []string
	// SurplusPolicy / StoragePriority are the Stufe-4 SOURCE choice of the
	// customer. nil = the portal says nothing and the box keeps its own.
	//
	// ⚠ ABSENT is NOT `schnell`. „Schnell laden" is a customer's own statement
	// ("keine Quellen-Politik"); absent means "das Portal äußert sich nicht" —
	// collapsing the two would let an older cloud silently drop a customer's
	// „Nur Sonnenstrom".
	SurplusPolicy   *string
	StoragePriority *string

	// ChargePoints are the station identifiers the portal wants ADMITTED.
	//
	// ⚠ nil and an EMPTY list mean the same thing here, and that is deliberate:
	// this list only ever ADDS. LEAVING AN ID OUT IS NOT A REMOVAL - a removal
	// is said explicitly, in RemovedChargePoints below.
	ChargePoints []ChargePoint

	// RemovedChargePoints are the identifiers the portal wants taken OUT of the
	// allowlist (Captain-Order 24.08.2026: "Ebenso will ich die moeglichkeit
	// haben eingebene kennungen zu loeschen").
	//
	// ⚠ It is a SEPARATE list, not a flag inside ChargePoints, and that is what
	// keeps an OLDER box honest: it does not know this field, overreads it and
	// KEEPS the station - the previous state, never a wrong action. A `removed`
	// flag inside a ChargePoint entry would have made an older box ADMIT the
	// very id the customer just deleted.
	//
	// ⚠ It is a TOMBSTONE list and travels in EVERY following document, not
	// once: the retained payload is replaced wholesale, so a removal named a
	// single time would never reach a box that happened to be offline.
	//
	// An id the box does not (or no longer) know is a silent no-op. An id in
	// BOTH lists is a contradiction the document should never carry; if it does,
	// the REMOVAL wins - the direction that admits less.
	RemovedChargePoints []string

	// VehicleProfiles are the per-CARD source lanes (Verbrauchsmanagement v1 /
	// P7): at the same charge point the company car may charge straight away
	// while the private car waits for the sun.
	//
	// ⚠ Here nil and EMPTY are DIFFERENT, and the opposite way round from
	// ChargePoints: the portal owns this set alone (there is no :8484 surface
	// for it), so a sent list REPLACES the stored one wholesale and an empty
	// list means "no profiles". That is what makes deleting a profile work
	// without a tombstone list - the set IS the statement, exactly like
	// Priorities.
	//
	// ⚠ The key is the box's OWN pseudonym (`csms.Session.TagRef`). The cloud
	// cannot compute it; it can only repeat what the heartbeat told it.
	VehicleProfiles []VehicleProfile

	// Frame is the LADEPARK-RAHMEN (Verbrauchsmanagement v1 / E10): the five
	// physical numbers that used to live only on :8484. nil = the portal says
	// nothing and the box keeps every one of them.
	//
	// ⚠ It is the same PATCH rule one level down: a `frame` block that carries
	// only the house reserve leaves margin, minimum power, rotation, the
	// highest building load and the static-budget switch exactly as they are.
	Frame *Frame

	// StorageRank is the BATTERY's position in the customer's Rangliste
	// (Verbrauchsmanagement v1 / P6). nil = the portal says nothing, and then
	// the site-wide `storage_priority` decides exactly as it did before P6.
	StorageRank *int

	// Wallboxes are the non-OCPP charge points that take part in the same
	// Ladepark-Rahmen (P6).
	//
	// ⚠ Unlike ChargePoints, nil and an EMPTY list differ here - and that is
	// what makes "keine Wallbox mehr im Rahmen" expressible at all. The list is
	// the WHOLE statement (the `priority_charge_point_ids` rule), because a
	// wallbox is not ADMITTED by it: it is a consumer entity the box already
	// knows, and this list only says which of them take part in the budget.
	Wallboxes *[]Wallbox
}

// Wallbox is one entry of `wallboxes[]` (P6): a go-e/Modbus wallbox that takes
// part in the Ladepark-Rahmen, named by its v2 ENTITY rather than by an OCPP
// ChargePointId.
type Wallbox struct {
	EntityID string
	Label    string
	RatedKw  float64
	MinKw    float64
	Rank     int
	Source   string
}

// Frame is the Ladepark-Rahmen the portal may maintain (E10: read-only for the
// customer, writable by a platform admin). Every field is a POINTER for the
// same reason the document itself is a PATCH: absent is not zero.
type Frame struct {
	HouseReserveKw  *float64
	MarginPct       *float64
	MinPowerKw      *float64
	RotationMinutes *int
	MaxHouseLoadKw  *float64
	StaticBudget    *bool
}

// ChargePoint is one entry of the allowlist. Only `ID` is required; the rest is
// what the operator happens to know when they add it in the portal.
type ChargePoint struct {
	ID         string
	Label      string
	Priority   bool
	RatedKw    float64
	Connectors int
	// Connection is WHERE this station hangs (Cockpit Phase 1 / C1):
	// csms.ConnectionHaus / csms.ConnectionEigen, "" = the portal said nothing
	// and the box keeps what it has (absent = haus for a new station).
	Connection string
	// Source is THIS station's own source lane (Verbrauchsmanagement v1 / P5):
	// "nur_sonne" | "sonne_zuerst" | "schnell", "" = the portal said nothing
	// and the SITE-wide surplus policy applies to it.
	//
	// ⚠ Unlike `label`/`priority` it is applied to a station the box ALREADY
	// knows: there is no :8484 surface for it, so there is nothing to protect -
	// and a customer who changes the Steuerart of one station later would
	// otherwise never reach the box. Exactly the `connection` argument.
	Source string
	// MinKw is THIS station's own minimum useful charging power (the „Sonne
	// zuerst"-Mindestleistung of §3.2). 0 = the portal said nothing and the
	// site-wide Mindestleistung applies.
	MinKw float64
	// Rank is THIS station's position in the customer's Rangliste (P6). 0 =
	// the portal said nothing, and then `priority_charge_point_ids` decides
	// alone - the behaviour before P6.
	//
	// ⚠ EQUAL RANKS ARE EQUALS: the cloud gives stations the customer left
	// side by side the SAME number, and the box keeps rotating between them.
	// It is applied to a station the box ALREADY knows, for the same reason
	// `source`/`connection` are: there is no :8484 surface for it.
	Rank int
}

// VehicleProfile is one card's own source lane. It carries a QUELLE and never
// a ZIEL: a deadline is planned hours ahead for a CHARGE POINT, and which car
// will be plugged in by then is not knowable at planning time - the source, in
// contrast, is a decision of the moment and that is exactly what a session
// carries.
type VehicleProfile struct {
	// TagRef is the pseudonym the BOX minted for this card
	// (`tagref_` + 24 hex). It is matched against `csms.Session.TagRef`.
	TagRef string
	// Name is display only - the box decides nothing by it and never passes it
	// to a station. It travels so the local :8484 surface can say the same
	// name the portal says.
	Name string
	// Source is one of the three lane words; a profile without one says
	// nothing and is skipped.
	Source string
	// MinKw is this card's own minimum useful power; 0 = say nothing and the
	// station's (or the site's) number applies.
	MinKw float64
}

// wire is the on-the-wire shape. Pointers where absence differs from a value.
type wire struct {
	OcppControl     *ocppcontrol.Policy `json:"ocpp_control"`
	SchemaVersion   string              `json:"schema_version"`
	TenantID        string              `json:"tenant_id"`
	SiteID          string              `json:"site_id"`
	DeviceID        string              `json:"device_id"`
	GridLimitKw     *float64            `json:"grid_limit_kw"`
	Priorities      *[]string           `json:"priority_charge_point_ids"`
	SurplusPolicy   *string             `json:"surplus_policy"`
	StoragePriority *string             `json:"storage_priority"`
	ChargePoints    []wireCP            `json:"charge_points"`
	Removed         []string            `json:"removed_charge_point_ids"`
	Frame           *wireFrame          `json:"frame"`
	StorageRank     *int                `json:"storage_rank"`
	Wallboxes       *[]wireWB           `json:"wallboxes"`
	// A POINTER because empty and absent differ: `[]` withdraws every profile,
	// absent keeps what the box has.
	VehicleProfiles *[]wireVehicle `json:"vehicle_profiles"`
	PublishedAt     string         `json:"published_at"`
}

type wireWB struct {
	EntityID string  `json:"entity_id"`
	Label    string  `json:"label"`
	RatedKw  float64 `json:"rated_kw"`
	MinKw    float64 `json:"min_kw"`
	Rank     int     `json:"rank"`
	Source   string  `json:"source"`
}

type wireFrame struct {
	HouseReserveKw  *float64 `json:"house_reserve_kw"`
	MarginPct       *float64 `json:"margin_pct"`
	MinPowerKw      *float64 `json:"min_power_kw"`
	RotationMinutes *int     `json:"rotation_minutes"`
	MaxHouseLoadKw  *float64 `json:"max_house_load_kw"`
	StaticBudget    *bool    `json:"static_budget"`
}

type wireVehicle struct {
	TagRef string  `json:"tag_ref"`
	Name   string  `json:"name"`
	Source string  `json:"source"`
	MinKw  float64 `json:"min_kw"`
}

type wireCP struct {
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	Priority   bool    `json:"priority"`
	RatedKw    float64 `json:"rated_kw"`
	Connectors int     `json:"connectors"`
	Connection string  `json:"connection"`
	Source     string  `json:"source"`
	MinKw      float64 `json:"min_kw"`
	Rank       int     `json:"rank"`
}

// Parse reads one retained payload. An EMPTY payload returns ErrEmpty (the
// withdrawal); anything malformed returns a German error and the caller keeps
// its own settings - a document we cannot read must never become a setting.
func Parse(payload []byte) (Config, error) {
	if len(strings.TrimSpace(string(payload))) == 0 {
		return Config{}, ErrEmpty
	}
	var w wire
	if err := json.Unmarshal(payload, &w); err != nil {
		return Config{}, fmt.Errorf("Konfigurations-Dokument ist unlesbar: %w", err)
	}
	if w.SchemaVersion != SchemaVersion {
		return Config{}, fmt.Errorf("unbekannte Vertragsversion %q - das Dokument wird verworfen",
			w.SchemaVersion)
	}
	if w.TenantID == "" || w.SiteID == "" || w.DeviceID == "" {
		return Config{}, errors.New("das Konfigurations-Dokument nennt keine vollständige Identität")
	}
	cfg := Config{TenantID: w.TenantID, SiteID: w.SiteID, DeviceID: w.DeviceID}
	if w.OcppControl != nil {
		if err := w.OcppControl.Validate(); err != nil {
			return Config{}, err
		}
		cfg.OcppControl = w.OcppControl
	}
	if w.GridLimitKw != nil {
		v := *w.GridLimitKw
		// ⚠ Eine 0 oder ein unsinniger Wert wird ABGELEHNT, nicht angewandt:
		// ohne Grenze ist das Budget 0 und es lädt nichts - das wäre eine
		// Aussage, die niemand treffen wollte, und sie käme aus einem Tippfehler.
		if math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 || v > MaxGridLimitKw {
			return Config{}, fmt.Errorf("die Anschlussgrenze %g kW ist nicht plausibel", v)
		}
		cfg.GridLimitKw = &v
	}
	if w.Priorities != nil {
		list := *w.Priorities
		if len(list) > MaxPriorities {
			return Config{}, fmt.Errorf("das Dokument nennt %d Vorrang-Säulen - höchstens %d sind erlaubt",
				len(list), MaxPriorities)
		}
		out := make([]string, 0, len(list))
		for _, id := range list {
			v := strings.TrimSpace(id)
			if v == "" || contains(out, v) {
				continue
			}
			out = append(out, v)
		}
		cfg.Priorities = out
	}
	// ⚠ An unknown WORD is refused, not normalized: the box's own read path
	// tolerates a corrupt file (never strand a fleet), but a document from the
	// portal is a deliberate statement - silently turning it into something
	// else would leave a customer believing they set what they did not.
	if w.SurplusPolicy != nil {
		v := strings.TrimSpace(*w.SurplusPolicy)
		if !validPolicy(v) {
			return Config{}, fmt.Errorf("unbekannte Überschuss-Priorität %q - das Dokument wird verworfen", v)
		}
		cfg.SurplusPolicy = &v
	}
	if w.StoragePriority != nil {
		v := strings.TrimSpace(*w.StoragePriority)
		if !validStorage(v) {
			return Config{}, fmt.Errorf("unbekannte Speicher-Priorität %q - das Dokument wird verworfen", v)
		}
		cfg.StoragePriority = &v
	}
	if len(w.ChargePoints) > MaxChargePoints {
		return Config{}, fmt.Errorf("das Dokument nennt %d Ladesäulen - höchstens %d sind erlaubt",
			len(w.ChargePoints), MaxChargePoints)
	}
	for _, cp := range w.ChargePoints {
		id := strings.TrimSpace(cp.ID)
		// ⚠ Eine unbrauchbare Kennung wird ÜBERSPRUNGEN, nicht zum Abbruch: die
		// Liste fügt nur hinzu, ein Eintrag mehr oder weniger nimmt der Box
		// nichts. Das GANZE Dokument daran scheitern zu lassen kostete die
		// Anschlussgrenze mit - und die ist die Größe, ohne die nichts lädt.
		if id == "" || alreadyListed(cfg.ChargePoints, id) {
			continue
		}
		// ⚠ Ein unbekanntes Anschluss-Wort überspringt den EINTRAG - es wird
		// NICHT auf „haus" aufgelöst. „haus" heißt „ihre Leistung steckt in
		// unserer Netzmessung und wird zurückaddiert"; ist die Wahrheit
		// „eigen", fiele das Budget zu groß aus und der Hausanschluss könnte
		// überschritten werden. Die Vorsicht liegt also beim Überspringen: eine
		// neue Säule wird nicht zugelassen, eine bekannte behält, was sie hat.
		conn := strings.TrimSpace(cp.Connection)
		if conn != "" && conn != connectionHaus && conn != connectionEigen {
			continue
		}
		// ⚠ Dieselbe Vorsicht für die Quellen-Bahn: ein unbekanntes Wort
		// überspringt den EINTRAG, es wird NICHT auf „schnell" aufgelöst -
		// aus einem „Nur Sonnenstrom" würde sonst still eine Freigabe für
		// Netzstrom, die niemand erteilt hat.
		src := strings.TrimSpace(cp.Source)
		if src != "" && !validPolicy(src) {
			continue
		}
		// Eine unplausible Mindestleistung ist keine Aussage: sie wird
		// WEGGELASSEN (dann gilt die der Anlage), nie geraten.
		minKw := cp.MinKw
		if math.IsNaN(minKw) || math.IsInf(minKw, 0) || minKw < 0 || minKw > MaxGridLimitKw {
			minKw = 0
		}
		// ⚠ Eine unplausible POSITION ist keine Aussage: sie wird WEGGELASSEN
		// (dann gilt weiter die Vorrang-Wahl), nie geraten - dieselbe Regel wie
		// bei der Mindestleistung. Ein Rang, den wir nicht lesen können, dürfte
		// eine Säule sonst still vor eine andere setzen.
		rank := cp.Rank
		if rank < 0 || rank > MaxRank {
			rank = 0
		}
		cfg.ChargePoints = append(cfg.ChargePoints, ChargePoint{
			ID: id, Label: strings.TrimSpace(cp.Label), Priority: cp.Priority,
			RatedKw: cp.RatedKw, Connectors: cp.Connectors, Connection: conn,
			Source: src, MinKw: minKw, Rank: rank,
		})
	}
	if len(w.Removed) > MaxChargePoints {
		return Config{}, fmt.Errorf("das Dokument nennt %d zu entfernende Ladesäulen - höchstens %d sind erlaubt",
			len(w.Removed), MaxChargePoints)
	}
	for _, raw := range w.Removed {
		// Dieselbe Nachsicht wie oben: eine unbrauchbare Zeile wird
		// ÜBERSPRUNGEN, nicht zum Abbruch - das ganze Dokument daran scheitern
		// zu lassen kostete die Anschlussgrenze mit.
		id := strings.TrimSpace(raw)
		if id == "" || contains(cfg.RemovedChargePoints, id) {
			continue
		}
		cfg.RemovedChargePoints = append(cfg.RemovedChargePoints, id)
	}
	// ⚠ Der Widerspruch wird HIER aufgelöst, nicht beim Anwender: eine Kennung,
	// die zugleich zugelassen und entfernt werden soll, fällt aus der
	// Zulassungs-Liste. Die Löschung gewinnt - die Richtung, die weniger
	// zulässt. Das Portal sendet den Fall nie; ein Dokument aus einer anderen
	// Quelle darf ihn nicht in eine Zulassung drehen.
	if len(cfg.RemovedChargePoints) > 0 && len(cfg.ChargePoints) > 0 {
		kept := cfg.ChargePoints[:0]
		for _, cp := range cfg.ChargePoints {
			if contains(cfg.RemovedChargePoints, cp.ID) {
				continue
			}
			kept = append(kept, cp)
		}
		cfg.ChargePoints = kept
	}
	// ⚠ Die Fahrzeug-Profile sind eine MENGE: eine gesendete Liste ersetzt die
	// gespeicherte vollständig, eine LEERE nimmt alle zurück. Deshalb wird hier
	// auch bei null Einträgen eine nicht-nil Liste gesetzt, sobald das Feld
	// überhaupt da war - genau daran erkennt der Anwender die Rücknahme.
	if w.VehicleProfiles != nil {
		list := *w.VehicleProfiles
		if len(list) > MaxVehicleProfiles {
			return Config{}, fmt.Errorf("das Dokument nennt %d Fahrzeug-Profile - höchstens %d sind erlaubt",
				len(list), MaxVehicleProfiles)
		}
		profiles := make([]VehicleProfile, 0, len(list))
		for _, v := range list {
			ref := strings.TrimSpace(v.TagRef)
			// ⚠ Ein Eintrag, den wir nicht eindeutig verstehen, wird
			// ÜBERSPRUNGEN statt das Dokument zu Fall zu bringen - dieselbe
			// Nachsicht wie bei den Säulen, und aus demselben Grund: das
			// Dokument trägt die Anschlussgrenze mit.
			//
			// Verworfen wird ein Bezug, der kein Pseudonym DIESER Box sein
			// kann (ein Klartext-IdTag etwa, oder der doppelt gehashte Bezug
			// aus dem OCPP-Journal der Cloud), ein Duplikat - und vor allem
			// eine unbekannte Quelle: sie auf „schnell" aufzulösen wäre eine
			// Netzstrom-Freigabe, die niemand erteilt hat.
			if !validTagRef(ref) || vehicleListed(profiles, ref) {
				continue
			}
			src := strings.TrimSpace(v.Source)
			if !validPolicy(src) {
				continue
			}
			minKw := v.MinKw
			if math.IsNaN(minKw) || math.IsInf(minKw, 0) || minKw < 0 || minKw > MaxGridLimitKw {
				minKw = 0
			}
			profiles = append(profiles, VehicleProfile{
				TagRef: ref, Name: strings.TrimSpace(v.Name), Source: src, MinKw: minKw,
			})
		}
		cfg.VehicleProfiles = profiles
	}
	// ⚠ Der Rahmen wird NICHT hier auf Plausibilität geprüft: die Regeln
	// dafür wohnen an EINER Stelle, in lastmgmt.Settings.Apply (dieselbe, die
	// die :8484-Oberfläche fährt). Ein zweiter Satz Grenzen wäre eine zweite
	// Wahrheit, und sie könnten auseinanderlaufen. Übernommen wird nur, was
	// als ZAHL lesbar war; ein Feld, das der Anwender ablehnt, lässt den Wert
	// der Box stehen, und die Ablehnung wird protokolliert.
	// ⚠ Ein unplausibler Speicher-Rang wird VERWORFEN, nicht geklemmt: er ist
	// die eine Zahl, an der „über dem Speicher" hängt, und ein geratener Wert
	// entschiede über den Sonnenüberschuss einer Kundenanlage. Ohne ihn gilt
	// weiter `storage_priority` - der Zustand vor P6.
	if w.StorageRank != nil {
		v := *w.StorageRank
		if v > 0 && v <= MaxRank {
			cfg.StorageRank = &v
		}
	}
	if w.Wallboxes != nil {
		list := *w.Wallboxes
		if len(list) > MaxWallboxes {
			return Config{}, fmt.Errorf("das Dokument nennt %d Wallboxen - höchstens %d sind erlaubt",
				len(list), MaxWallboxes)
		}
		out := make([]Wallbox, 0, len(list))
		for _, wb := range list {
			// Dieselbe Nachsicht wie bei den Säulen: ein unbrauchbarer Eintrag
			// wird ÜBERSPRUNGEN, nicht zum Abbruch - das ganze Dokument daran
			// scheitern zu lassen kostete die Anschlussgrenze mit.
			id := strings.TrimSpace(wb.EntityID)
			if id == "" || wallboxListed(out, id) {
				continue
			}
			// ⚠ Ein unbekanntes Quellen-Wort überspringt den EINTRAG, es wird
			// NICHT auf „schnell" aufgelöst: aus einem „Nur Sonnenstrom" würde
			// sonst still eine Freigabe für Netzstrom, die niemand erteilt hat.
			src := strings.TrimSpace(wb.Source)
			if src != "" && !validPolicy(src) {
				continue
			}
			rated, minKw := wb.RatedKw, wb.MinKw
			if math.IsNaN(rated) || math.IsInf(rated, 0) || rated < 0 || rated > MaxGridLimitKw {
				rated = 0
			}
			if math.IsNaN(minKw) || math.IsInf(minKw, 0) || minKw < 0 || minKw > MaxGridLimitKw {
				minKw = 0
			}
			rank := wb.Rank
			if rank < 0 || rank > MaxRank {
				rank = 0
			}
			out = append(out, Wallbox{
				EntityID: id, Label: strings.TrimSpace(wb.Label),
				RatedKw: rated, MinKw: minKw, Rank: rank, Source: src,
			})
		}
		cfg.Wallboxes = &out
	}
	if w.Frame != nil {
		cfg.Frame = &Frame{
			HouseReserveKw:  w.Frame.HouseReserveKw,
			MarginPct:       w.Frame.MarginPct,
			MinPowerKw:      w.Frame.MinPowerKw,
			RotationMinutes: w.Frame.RotationMinutes,
			MaxHouseLoadKw:  w.Frame.MaxHouseLoadKw,
			StaticBudget:    w.Frame.StaticBudget,
		}
	}
	return cfg, nil
}

func wallboxListed(list []Wallbox, id string) bool {
	for _, w := range list {
		if w.EntityID == id {
			return true
		}
	}
	return false
}

// validTagRef accepts only what this box could itself have minted: the literal
// prefix plus lower-case hex. It is a FORM check, not a proof - a well-formed
// pseudonym of ANOTHER box simply never matches a session here, which is the
// honest outcome and needs no rule of its own.
func validTagRef(ref string) bool {
	const prefix = "tagref_"
	if !strings.HasPrefix(ref, prefix) {
		return false
	}
	hex := ref[len(prefix):]
	if len(hex) < 8 || len(hex) > 64 {
		return false
	}
	for i := 0; i < len(hex); i++ {
		c := hex[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func vehicleListed(list []VehicleProfile, ref string) bool {
	for _, v := range list {
		if v.TagRef == ref {
			return true
		}
	}
	return false
}

func alreadyListed(list []ChargePoint, id string) bool {
	for _, c := range list {
		if c.ID == id {
			return true
		}
	}
	return false
}

// The two vocabularies of the contract. They are repeated here rather than
// imported from internal/lastmgmt so this package stays what it is: a PARSER
// of a document, with no opinion about what a setting means.
func validPolicy(v string) bool {
	return v == "nur_sonne" || v == "sonne_zuerst" || v == "schnell"
}

func validStorage(v string) bool {
	return v == "speicher_vor_auto" || v == "auto_vor_speicher"
}

// MatchesIdentity reports whether the document addresses THIS device. The rule
// of every downlink here (telemetry / purge_data / assignment / apply): the
// topic identity must equal the payload identity, and a mismatch is dropped -
// answering a wrongly addressed sender would confirm this device exists.
func (c Config) MatchesIdentity(tenantID, siteID, deviceID string) bool {
	return c.TenantID == tenantID && c.SiteID == siteID && c.DeviceID == deviceID
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
