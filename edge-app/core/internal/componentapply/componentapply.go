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
//   - AN EMPTY SOLL IS NOT A SOLL - UNTIL THE PORTAL OWNS THE BOX. A push that
//     names no device at all yields ErrNoConfiguration, never an empty plan.
//     Wiping a working box because the portal has not been filled in yet would
//     be exactly the "ein falsches Soll legt den Lesepfad einer Live-Anlage
//     lahm" risk the concept names. ONCE a portal plan has been applied,
//     though, every source on the box came from the portal (local edits are
//     refused from then on), and an empty Soll means the customer deleted the
//     last device: the caller then applies EmptiedPlan. Holding there left a
//     deleted device read, reported and listed forever, with no way to remove
//     it anywhere.
//
//   - A DEVICE THAT ALREADY RUNS HERE KEEPS ITS IDENTITY. A source id is
//     sources.DeterministicID over its transport identity - the SAME function
//     :8484 uses - BUT only for a device this box does not already run. Whenever
//     the derived transport identity (sources.TransportIdentity) matches a source
//     that is configured right now, that source's OWN id is kept, whatever it
//     looks like. Two drivers with the identical transport identity are an
//     ambiguous Soll and are refused by name, never silently collapsed.
//
//     ⚠ This is the load-bearing half, and it was learned the hard way
//     (Anlage Pilsting/Herzogau, Update edge-2026.08.5 -> .10): deterministic
//     ids were introduced WITHOUT migrating the existing ones - deliberately,
//     because re-minting a live source's id orphans the portal's adoption pin
//     (measurement_point.edge_source_id). Every plant commissioned before that
//     therefore carries RANDOM ids to this day. The takeover re-derived them
//     deterministically, rewrote sources.json, and the very devices that kept
//     delivering measurements reappeared in the portal as "Neues Gerät gefunden"
//     while their components read "nicht mehr mit einem gemeldeten Gerät
//     verbunden". Deriving an id for a device that already HAS one locally is
//     inventing an identity, not deriving it - so the box now recognises the
//     device first and only mints an id for one it has never seen.
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
// the portal has nothing to say (yet). Before the portal's first applied plan
// the caller must treat it as "leave everything alone"; after it, as
// EmptiedPlan (see the third rule at the top of this file).
var ErrNoConfiguration = errors.New("der Push enthält keine Geräte-Konfiguration")

// EmptiedPlan is the plan of an empty Soll on a box the portal already owns:
// no additional source any more, the inverter selection untouched (exactly as
// in every plan that names no inverter). Only the caller knows whether the
// portal owns the box, so Derive itself never returns it.
func EmptiedPlan(revision string) Plan { return Plan{Revision: revision} }

// Driver is the typed read of a descriptor's opaque `driver` block. The block
// itself stays json.RawMessage on the entity (verbatim pass-through for the
// go-e/Shelly write executors, which have consumed it since E1a); this is the
// READ view the applier needs.
type Driver struct {
	DataSourceID string `json:"data_source_id,omitempty"`
	// Role is the plant role this device plays. Absent = derived from the
	// entity type (see roleFor) - never guessed beyond the types whose role is
	// unambiguous.
	Role          string  `json:"role,omitempty"`
	Brand         string  `json:"brand"`
	Model         string  `json:"model,omitempty"`
	Family        string  `json:"family,omitempty"`
	Communication string  `json:"communication,omitempty"`
	CapacityKwp   float64 `json:"capacity_kwp,omitempty"`
	IntervalS     int     `json:"interval_s,omitempty"`
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

// CommunicationMqttLocal marks a BATTERY the customer connected themselves over
// a LOCAL MQTT broker (P5 Ebene 1, Konzept vp-deye-diybms-luecke-l5 §3.2b).
// Same story as CommunicationSelfBuild: such a component is read by its own
// generated flow (one vp-mqtt-read node with the user's field mapping), never
// by the self-wiring tab - so this applier deliberately does NOT turn it into a
// source.
//
// ⚠ The value is shared verbatim with the cloud
// (services/api .../components/UserDefinedBatteryDefinition.COMMUNICATION).
// ⚠ ROLLOUT ORDER: a box WITHOUT this constant refuses the driver of such a
// component ("nennt keine Marke") and Derive is all-or-nothing - the site would
// lose the application of its inverter and every source. The edge release
// therefore has to reach a site BEFORE the first battery is connected there.
const CommunicationMqttLocal = "mqtt_local"

// CommunicationHTTPLocal marks a BATTERY the customer connected themselves over
// its own HTTP/JSON endpoint in the LAN (P5 Ebene 1 "HTTP/JSON", Konzept
// vp-deye-diybms-luecke-l5 §3.2b) - the sibling of CommunicationMqttLocal, and
// the same story: read by its own generated flow (one vp-http-read node with
// the user's value-path mapping), never by the self-wiring tab.
//
// ⚠ Unlike the other two, this driver block DOES carry something the box needs:
// `connection.auth_secret`, the credential of the endpoint. It reaches the read
// node through the per-entity retained config, NOT through the flow document -
// a flow document is readable through the portal API, so a credential in it
// would be a credential in the browser.
//
// ⚠ The value is shared verbatim with the cloud
// (services/api .../components/UserDefinedBatteryDefinition.COMMUNICATION_HTTP).
// ⚠ ROLLOUT ORDER, exactly as for mqtt_local: a box WITHOUT this constant
// refuses the driver of such a component ("nennt keine Marke") and Derive is
// all-or-nothing - the site would lose the application of its inverter and
// every source. The edge release therefore has to reach a site BEFORE the first
// HTTP-connected battery is created there.
const CommunicationHTTPLocal = "http_local"

// selfReadCommunications are the communications whose devices carry their own
// generated read flow. They are skipped here - never refused: refusing would
// sink the WHOLE push over a device this applier is not responsible for.
func isSelfRead(communication string) bool {
	return communication == CommunicationSelfBuild ||
		communication == CommunicationMqttLocal ||
		communication == CommunicationHTTPLocal
}

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
	// ⚠ A SELF-READ device is not part of the local read path at all, and
	// skipping it HERE - before the brand check - is load-bearing, not
	// cosmetic: Derive is all-or-nothing, roleFor does not know the
	// `modbus-generic` / `user-defined-battery` types, and such a device
	// carries no brand by construction. Without this branch ONE
	// customer-defined sensor would sink the WHOLE push, so a plant would lose
	// the application of its inverter and every source the moment it defines
	// its first own device.
	//
	// Its READ PLAN travels elsewhere: as a generated flow over v2/flows (one
	// vp-modbus-read per channel, or ONE vp-mqtt-read / vp-http-read carrying
	// the whole field mapping of a self-connected battery), publishing its own
	// per-entity telemetry. The driver block carries display/context - and, for
	// the HTTP read type, the endpoint credential the read node picks up from
	// the per-entity retained config.
	if isSelfRead(d.Communication) {
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
	// An I/O module (Ebyte M31) is a measure-only DEVICE entity: its outputs
	// are switched through the consumer entities bound to its channels, and
	// its own source only reads states. It is read on the consumer side (it
	// never enters the energy balance - it publishes no power at all);
	// refusing it here would sink the whole push.
	if d.Communication == inverter.CommEbyteModbusTCP {
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
//
// `current` is what this box runs RIGHT NOW. It is an input, not decoration:
// a derived device that is already configured here keeps that configuration's
// id (see keepLocalIDs and the fourth rule at the top of this file), which is
// what makes the takeover a no-op on a plant whose ids predate
// sources.DeterministicID. Pass nil only where there is genuinely nothing
// running.
func Derive(reg entities.Registry, cat inverter.Catalog, current []sources.Source,
	now time.Time) (Plan, error) {
	plan := Plan{Revision: reg.Revision}
	keep := keepLocalIDs(current)
	byFingerprint := map[string]string{} // transport identity -> entity id that claimed it
	taken := map[string]bool{}           // ids already handed out in THIS plan
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
		// The clash check keys on the TRANSPORT IDENTITY, not on the final id:
		// two entities describing the same physical device are ambiguous even
		// when one of them would inherit a local id.
		src.DataSourceID = d.DataSourceID
		fingerprint := sources.TransportIdentity(src)
		if other, clash := byFingerprint[fingerprint]; clash {
			return Plan{}, fmt.Errorf(
				"zwei Geräte (%q und %q) haben dieselbe Verbindung - so ist nicht entscheidbar, "+
					"welches gemeint ist", other, e.ID)
		}
		byFingerprint[fingerprint] = e.ID
		src.ID = sources.DeterministicID(src)
		if local, ok := keep[fingerprint]; ok && !taken[local] {
			src.ID = local
		}
		// Zwei Geräte dürfen sich NIE eine Kennung teilen (sie teilten sich
		// sonst einen Messwert-Strom). Erreichbar nur über eine
		// Hash-Kollision zweier verschiedener Transport-Identitäten - vor
		// dieser Regel fing das die Kennungs-Kollision oben ab, deshalb bleibt
		// die Ablehnung hier stehen statt still zu verschwinden.
		if taken[src.ID] {
			return Plan{}, fmt.Errorf(
				"zwei Geräte teilen sich die Kennung %q - so ist nicht entscheidbar, "+
					"welches gemeint ist", src.ID)
		}
		taken[src.ID] = true
		plan.Sources = append(plan.Sources, src)
	}

	if plan.Empty() {
		return Plan{}, ErrNoConfiguration
	}
	return plan, nil
}

// keepLocalIDs maps the transport identity of every CURRENTLY configured source
// onto the id it runs under, so a derivation can recognise a device instead of
// re-identifying it.
//
// Two deliberate refusals to guess:
//
//   - AMBIGUITY YIELDS NOTHING. Two local sources with the identical transport
//     identity are not a valid setup (AddSource only produces them through its
//     loud collision fallback). Picking one of them would be a coin toss about
//     which cloud pin survives, so the fingerprint is dropped entirely and the
//     derived device gets its deterministic id. The one exception is the source
//     that ALREADY carries that deterministic id - it is by construction the one
//     a re-derivation would have addressed anyway.
//   - AN ID IS NEVER HANDED OUT TWICE. Derive additionally skips a preserved id
//     that a previous entity of the same plan already took (astronomically
//     unlikely with a random id, but a duplicate id in sources.json would make
//     two devices share one reading stream).
func keepLocalIDs(current []sources.Source) map[string]string {
	byFingerprint := map[string][]sources.Source{}
	for _, s := range current {
		fp := sources.TransportIdentity(s)
		byFingerprint[fp] = append(byFingerprint[fp], s)
	}
	keep := make(map[string]string, len(byFingerprint))
	for fp, list := range byFingerprint {
		if len(list) == 1 {
			keep[fp] = list[0].ID
			continue
		}
		for _, s := range list {
			if s.ID == sources.DeterministicID(s) {
				keep[fp] = s.ID
				break
			}
		}
	}
	return keep
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
	// Held/HeldReason carry the last revision the box saw and DELIBERATELY did
	// not apply, keeping its local files. Today that is the empty Soll BEFORE
	// the portal's first applied plan: the portal describes no connected device
	// yet, which is expressly NOT an instruction to clear a running plant.
	//
	// ⚠ Ein DRITTES Feldpaar, kein umgedeutetes: `revision` bleibt „was diese
	// Box wirklich fährt" (ein Halt hat nichts angewandt) und `refused_*`
	// bleibt „was sie NICHT KONNTE". Ein Halt ist weder das eine noch das
	// andere - er ist eine bewusste, richtige Entscheidung, und ihn in einen
	// der beiden Kanäle zu pressen hieße, entweder einen Stand zu behaupten,
	// den niemand fährt, oder einen Fehler zu melden, den es nicht gibt
	// (Befund L1, Scout vp-portal-box-spiegel-s2).
	Held       string `json:"held_revision,omitempty"`
	HeldReason string `json:"held_reason,omitempty"`
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
//
// A refusal also clears any HOLD: the two answer the same question ("what
// happened to the newest revision?") and only the newest answer is true.
func (r Record) WithRefusal(revision, reason string) Record {
	r.Version = StateVersion
	r.Refused = revision
	r.RefusedReason = reason
	r.Held, r.HeldReason = "", ""
	return r
}

// WithHold returns the record with a deliberate hold recorded: the box SAW this
// revision, applied nothing and keeps its local files. Like a refusal it keeps
// the last applied revision (that is still what runs) - and it clears a stale
// refusal, because an older revision's reason must not outlive its answer.
func (r Record) WithHold(revision, reason string) Record {
	r.Version = StateVersion
	r.Held = revision
	r.HeldReason = reason
	r.Refused, r.RefusedReason = "", ""
	return r
}

// Cleared returns the record with any refusal OR hold cleared (a later push
// applied - that is the answer to every earlier one).
func (r Record) Cleared() Record {
	r.Refused, r.RefusedReason = "", ""
	r.Held, r.HeldReason = "", ""
	return r
}
