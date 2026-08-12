// Package componentapply holds the PURE half of the Einheitsmodell's one
// applier (Stufe 1, Konzept vp-komponenten-einheit-h2 §7.1): it turns the
// cloud's entity-registry push into the LOCAL device configuration this box
// runs on - the primary inverter selection and the additional-source list.
//
// It touches nothing: no disk, no bus, no clock (every time-dependent function
// takes `now`) - the otaapply/calibration/curtailcal/probe discipline. Every
// rule that can REFUSE a derivation lives here and is provable without a
// container; internal/agent only wires the result to the two existing stores
// and the two existing retained local-bus topics.
//
// THE FOUR RULES, and why each one exists:
//
//   - AUTHORITY IS PER PLANT, AND ABSENT MEANS BOX. The push carries
//     `component_authority`; only "portal" makes this package's output the local
//     truth. An older cloud omits the field, so a box that gets this build can
//     never mistake yesterday's push for a takeover - and every plant that
//     exists today keeps its :8484-authored configuration untouched.
//
//   - NEVER PARTIALLY APPLY. The whole plan is derived and validated FIRST; a
//     single driver block that does not translate into a valid selection refuses
//     the ENTIRE derivation, and the box keeps running exactly what it ran
//     before. A half-applied read path is the one failure mode that would take a
//     live plant's measurements down, and it is structurally impossible here
//     because nothing is written until everything validated.
//
//   - AN EMPTY SOLL IS NOT A SOLL. A push that names no device at all yields
//     ErrNoConfiguration, never an empty plan. Wiping a working box because the
//     portal has not been filled in yet would be exactly the "ein falsches Soll
//     legt den Lesepfad einer Live-Anlage lahm" risk the concept names.
//
//   - IDENTITY IS DERIVED, NEVER INVENTED. A source's id is
//     sources.DeterministicID over its transport identity - the SAME function
//     :8484 uses - so a plant whose Ist is taken over as Soll re-derives
//     byte-identically to what already runs, and the box quits with "no change".
//     Two drivers with the identical transport identity are an ambiguous Soll and
//     are refused by name, never silently collapsed.
package componentapply

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// The authority vocabulary of the registry push. ABSENT is deliberately not a
// third value: Authority() maps everything it does not know onto box.
const (
	AuthorityBox    = "box"
	AuthorityPortal = "portal"
)

// RoleInverter is the driver role that names the plant's PRIMARY inverter (the
// one battery/PV device the control path targets). It is not a sources role -
// the primary lives in inverter.Selection, not in sources.json.
const RoleInverter = "inverter"

// StateVersion of the persisted apply record. A file from a future version is
// ignored wholesale rather than half-read (the shelly/calibration store rule).
const StateVersion = 1

// ErrNoConfiguration is the sentinel for "this push names no device at all".
// It is NOT an error in the operational sense - it is the honest statement that
// the portal has nothing to say yet - and the caller must treat it as "leave
// everything alone", never as "clear everything".
var ErrNoConfiguration = errors.New("der Push enthält keine Geräte-Konfiguration")

// Driver is the typed read of a descriptor's opaque `driver` block. The block
// itself stays json.RawMessage on the entity (verbatim pass-through for the
// go-e/Shelly write executors, which have consumed it since E1a); this is the
// READ view the applier needs.
type Driver struct {
	// Role is the plant role this device plays. Absent = derived from the
	// entity type (see roleFor) - never guessed beyond the types whose role is
	// unambiguous.
	Role          string          `json:"role,omitempty"`
	Brand         string          `json:"brand"`
	Model         string          `json:"model,omitempty"`
	Family        string          `json:"family,omitempty"`
	Communication string          `json:"communication,omitempty"`
	CapacityKwp   float64         `json:"capacity_kwp,omitempty"`
	IntervalS     int             `json:"interval_s,omitempty"`
	// RegistryUnitID is the operator's MaStR reference for this device. It is
	// pure master data (never part of the transport identity), but it IS part of
	// sources.Source - so without it here a Stufe-2 takeover would silently drop
	// the operator's registry number on the first push back.
	RegistryUnitID string          `json:"registry_unit_id,omitempty"`
	Connection     json.RawMessage `json:"connection,omitempty"`
}

// CommunicationSelfBuild marks a component the CUSTOMER defined themselves in
// the portal (Einheitsmodell Stufe 3, vp-modbus-baukasten-k6 §2.2). It is the
// one communication this applier deliberately does NOT turn into a source: such
// a device is read by its own generated flow, not by the self-wiring tab.
//
// ⚠ The value is shared verbatim with the cloud
// (services/api .../components/SelfBuildDefinition.COMMUNICATION) - change both
// together, or the box would start refusing pushes it should ignore.
const CommunicationSelfBuild = "modbus_baukasten"

// Plan is the derived local configuration of one push: at most one primary
// inverter plus the additional read-only sources, all already validated against
// the box's own catalog.
type Plan struct {
	// Revision is the push revision this plan was derived from - the exact
	// string the heartbeat echoes back, so the portal can say "läuft auf dem
	// Gerät · <revision>" without a second bookkeeping.
	Revision string
	// Inverter is the primary selection, or nil when the push names none (a
	// plant that only has meters/producers is a legitimate shape).
	Inverter *inverter.Selection
	Sources  []sources.Source
}

// Empty reports whether the plan names no device at all.
func (p Plan) Empty() bool { return p.Inverter == nil && len(p.Sources) == 0 }

// Authority reads the push's authority marker. ANYTHING that is not exactly
// "portal" - absent, empty, a value from a newer cloud we do not know - is box.
// The safe direction is the one that changes nothing.
func Authority(raw string) string {
	if strings.TrimSpace(raw) == AuthorityPortal {
		return AuthorityPortal
	}
	return AuthorityBox
}

// IsPortalManaged is the one gate the agent asks before doing anything at all.
func IsPortalManaged(reg entities.Registry) bool {
	return Authority(reg.ComponentAuthority) == AuthorityPortal
}

// ParseDriver reads an entity's opaque driver block. ok=false means the entity
// simply carries none (a composed grid-meter, a house-load, a consumer whose
// connection the portal has not filled in) - that is not an error, it is a
// device this box does not read.
func ParseDriver(e entities.Entity) (Driver, bool, error) {
	if len(e.Driver) == 0 {
		return Driver{}, false, nil
	}
	var d Driver
	if err := json.Unmarshal(e.Driver, &d); err != nil {
		return Driver{}, false, fmt.Errorf("Anbindung von %q ist unlesbar: %w", e.ID, err)
	}
	// A driver WITHOUT a connection is the pre-Stufe-1 shape (brand/model only,
	// recorded by the v1 customer source paths). It names no reachable device,
	// so it is not part of the read path - and treating it as one would derive a
	// selection with an empty IP.
	if len(d.Connection) == 0 {
		return Driver{}, false, nil
	}
	// ⚠ A SELF-BUILT device is not part of the local read path at all, and
	// skipping it HERE - before the brand check - is load-bearing, not
	// cosmetic: Derive is all-or-nothing, roleFor does not know the
	// `modbus-generic` type, and a self-built device carries no brand by
	// construction. Without this branch ONE customer-defined sensor would sink
	// the WHOLE push, so a plant would lose the application of its inverter and
	// every source the moment it defines its first own device.
	//
	// Its READ PLAN travels elsewhere: as a generated flow over v2/flows (one
	// vp-modbus-read per channel, publishing its own per-entity telemetry). The
	// driver block carries display/context only.
	if d.Communication == CommunicationSelfBuild {
		return Driver{}, false, nil
	}
	if strings.TrimSpace(d.Brand) == "" {
		return Driver{}, false, fmt.Errorf("Anbindung von %q nennt keine Marke", e.ID)
	}
	return d, true, nil
}

// connection maps the driver's opaque connection object onto the box's own
// Connection struct. A JSON round trip on purpose: the field list lives in
// exactly ONE place (inverter.Connection), so a transport field added there is
// carried by this path without a second mapping table to forget.
func (d Driver) connection() (inverter.Connection, error) {
	var c inverter.Connection
	if err := json.Unmarshal(d.Connection, &c); err != nil {
		return c, fmt.Errorf("Verbindungsfelder unlesbar: %w", err)
	}
	return c, nil
}

// roleFor decides what a device is. The driver's explicit role wins; otherwise
// the entity TYPE decides, and only for the types whose plant role is
// unambiguous. Anything else is refused by name - a device read into the wrong
// role would silently land in the wrong side of the energy balance.
func roleFor(e entities.Entity, d Driver) (string, error) {
	switch strings.TrimSpace(d.Role) {
	case RoleInverter, sources.RoleErzeuger, sources.RoleNetz, sources.RoleConsumer:
		return strings.TrimSpace(d.Role), nil
	case "":
		// fall through to the type-derived default
	default:
		return "", fmt.Errorf("Anbindung von %q nennt die unbekannte Rolle %q", e.ID, d.Role)
	}
	switch e.Type {
	case entities.TypeBatteryHybrid:
		return RoleInverter, nil
	case entities.TypeProducer:
		return sources.RoleErzeuger, nil
	case entities.TypeGridMeter:
		return sources.RoleNetz, nil
	}
	if e.Category() == entities.CategoryConsumer {
		return sources.RoleConsumer, nil
	}
	return "", fmt.Errorf("für %q (%s) ist nicht bestimmbar, welche Rolle das Gerät hat",
		e.ID, e.Type)
}

// Derive turns a registry push into the local configuration. It validates
// EVERYTHING before returning anything: the returned plan is either complete and
// applicable, or there is an error and the caller changes nothing.
//
// The catalog is the box's own (inverter.DefaultCatalog): the box does not take
// the cloud's word for what it can read. A model the cloud believes in but this
// build does not know is a refusal with the catalog's own German message - the
// honest "diese Box kann das (noch) nicht", never a silently mis-read device.
func Derive(reg entities.Registry, cat inverter.Catalog, now time.Time) (Plan, error) {
	plan := Plan{Revision: reg.Revision}
	byID := map[string]string{} // deterministic source id -> entity id that claimed it
	var invEntity string

	// Registry order is the cloud's; sort by entity id so the derived source
	// list - and therefore the retained edge/sources/config bytes - is stable
	// across two pushes that carry the same set in a different order.
	ents := append([]entities.Entity(nil), reg.Entities...)
	sort.SliceStable(ents, func(i, j int) bool { return ents[i].ID < ents[j].ID })

	for _, e := range ents {
		d, ok, err := ParseDriver(e)
		if err != nil {
			return Plan{}, err
		}
		if !ok {
			continue
		}
		role, err := roleFor(e, d)
		if err != nil {
			return Plan{}, err
		}
		conn, err := d.connection()
		if err != nil {
			return Plan{}, fmt.Errorf("Anbindung von %q: %w", e.ID, err)
		}

		if role == RoleInverter {
			if invEntity != "" {
				return Plan{}, fmt.Errorf(
					"der Push nennt zwei Wechselrichter (%q und %q) - es kann nur einen geben",
					invEntity, e.ID)
			}
			sel, err := cat.Normalize(inverter.SelectionRequest{
				Brand: d.Brand, Model: d.Model, Family: d.Family, Connection: conn,
			}, now)
			if err != nil {
				return Plan{}, fmt.Errorf("Wechselrichter %q: %s", e.ID, message(err))
			}
			if lbl := strings.TrimSpace(e.Label); lbl != "" {
				sel.Label = lbl
			}
			invEntity = e.ID
			plan.Inverter = &sel
			continue
		}

		src, err := sources.Normalize(cat, sources.Request{
			Role:           role,
			Label:          e.Label,
			Brand:          d.Brand,
			Model:          d.Model,
			Family:         d.Family,
			Connection:     conn,
			IntervalS:      d.IntervalS,
			CapacityKwp:    d.CapacityKwp,
			RegistryUnitID: d.RegistryUnitID,
		}, now)
		if err != nil {
			return Plan{}, fmt.Errorf("Gerät %q: %s", e.ID, message(err))
		}
		src.ID = sources.DeterministicID(src)
		if other, clash := byID[src.ID]; clash {
			return Plan{}, fmt.Errorf(
				"zwei Geräte (%q und %q) haben dieselbe Verbindung - so ist nicht entscheidbar, "+
					"welches gemeint ist", other, e.ID)
		}
		byID[src.ID] = e.ID
		plan.Sources = append(plan.Sources, src)
	}

	if plan.Empty() {
		return Plan{}, ErrNoConfiguration
	}
	return plan, nil
}

// message unwraps the German customer-facing text of a catalog/sources
// validation failure, so a refusal reads as a sentence and not as a Go error
// chain. Anything else keeps its own text.
func message(err error) string {
	var iv *inverter.ValidationError
	if errors.As(err, &iv) {
		return iv.Msg
	}
	var sv *sources.ValidationError
	if errors.As(err, &sv) {
		return sv.Msg
	}
	return err.Error()
}

// SameAs reports whether applying this plan would change nothing.
//
// It deliberately ignores the timestamps (Selection.UpdatedAt,
// Source.CreatedAt): they move on every re-derivation and say nothing about the
// device. Without that, the "Übernahme ist ein No-op" property would be false
// on paper - every retained redelivery would rewrite two files and republish two
// retained topics for an identical configuration.
func (p Plan) SameAs(current *inverter.Selection, currentSources []sources.Source) bool {
	if (p.Inverter == nil) != (current == nil) {
		return false
	}
	if p.Inverter != nil && !sameSelection(*p.Inverter, *current) {
		return false
	}
	if len(p.Sources) != len(currentSources) {
		return false
	}
	have := make(map[string]sources.Source, len(currentSources))
	for _, s := range currentSources {
		have[s.ID] = s
	}
	for _, want := range p.Sources {
		got, ok := have[want.ID]
		if !ok || !sameSource(want, got) {
			return false
		}
	}
	return true
}

func sameSelection(a, b inverter.Selection) bool {
	a.UpdatedAt, b.UpdatedAt = time.Time{}, time.Time{}
	return a == b
}

func sameSource(a, b sources.Source) bool {
	a.CreatedAt, b.CreatedAt = time.Time{}, time.Time{}
	return a == b
}

// Record is the persisted outcome of the last apply attempt
// (<data_dir>/components-applied.json). It survives a restart and a cloud
// outage, so a rebooting box knows it is portal-managed BEFORE the first push
// arrives - which is what keeps the local edit refusal honest while offline.
type Record struct {
	Version   int    `json:"version"`
	Authority string `json:"authority"`
	// Revision is the push revision that was successfully APPLIED (empty while
	// nothing has been). A refusal never overwrites it - the box keeps running
	// the last configuration that really worked, and says so.
	Revision  string    `json:"revision,omitempty"`
	AppliedAt time.Time `json:"applied_at,omitempty"`
	// Refused/RefusedReason carry the LAST refusal, so the honest "das Portal
	// hat etwas geschickt, das diese Box nicht anwenden kann" reaches the
	// heartbeat instead of disappearing into the log.
	Refused         string `json:"refused_revision,omitempty"`
	RefusedReason   string `json:"refused_reason,omitempty"`
	RefusedSourceID string `json:"-"`
}

// NewRecord builds the record of a successful apply.
func NewRecord(authority, revision string, now time.Time) Record {
	return Record{
		Version:   StateVersion,
		Authority: authority,
		Revision:  revision,
		AppliedAt: now.UTC(),
	}
}

// WithRefusal returns the record with a refusal recorded, KEEPING the last
// applied revision: what runs on the box is still what was applied last, and
// claiming otherwise would be the fabrication this codebase does not do.
func (r Record) WithRefusal(revision, reason string) Record {
	r.Version = StateVersion
	r.Refused = revision
	r.RefusedReason = reason
	return r
}

// Cleared returns the record with any refusal cleared (a later push applied).
func (r Record) Cleared() Record {
	r.Refused, r.RefusedReason = "", ""
	return r
}
