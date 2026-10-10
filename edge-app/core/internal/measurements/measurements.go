// Package measurements owns the additive measurement desired-state bridge and
// its durable QoS1 outbox. It never changes the frozen edge/telemetry path.
package measurements

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	LocalConfigTopic           = "edge/measurements/config"
	LocalStatusTopic           = "edge/measurements/config-status"
	LocalSamplesTopic          = "edge/measurements/samples"
	LocalOcppConfigTopic       = "edge/measurements/ocpp-configuration"
	LocalOcppConfigResultTopic = "edge/measurements/ocpp-configuration-result"
	MaxBatchSamples            = 256
	MaxConfigPoints            = 2301
)

var pointKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._*\[\]@-]{0,239}$`)

// entityIDPattern is the contract's uuid shape. A selection's entity_id now
// picks the DEVICE a point is read from, so a malformed one must never reach
// the binding layer as an unresolvable key - it is a broken document, not a
// missing component.
var entityIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type Identity struct {
	TenantID string `json:"tenant_id"`
	SiteID   string `json:"site_id"`
	DeviceID string `json:"device_id"`
}
type Selection struct {
	PointKey string `json:"point_key"`
	CadenceS int    `json:"cadence_s"`
	// EntityID names the component a selection belongs to (cloud Stufe 3b).
	// Since Stufe 3c it SELECTS the device the point is read from: Node-RED
	// resolves it through the per-entity registry pin (edge_source_id) to a
	// source in edge/sources/config, and REFUSES the point when it cannot -
	// never reads it against the primary inverter. This layer only carries and
	// shape-checks it; the resolution rule lives in
	// edge-app/nodered/measurements/measurement-binding.js.
	EntityID   string          `json:"entity_id,omitempty"`
	Definition json.RawMessage `json:"definition,omitempty"`
}
// RegisterbildKarte is the Soll of one energy card: WHICH card the Hardwareblatt
// expects in which slot. Identity of a card is (device, slot) - card type and
// variant only check that the expected card is plugged in, so a card swapped to
// another slot becomes visible instead of being silently re-attached.
type RegisterbildKarte struct {
	Steckplatz int `json:"steckplatz"`
	Kartentyp  int `json:"kartentyp"`
	Variante   int `json:"variante"`
}

// Registerbild carries the per-installation parameters of a WAGO register image
// (UEMS AP-05, docs/contracts/v2/wago-registerbild.md §2). Base address,
// function code and word order differ per plant and are therefore PARAMETERS,
// never a fixed modbus_holding (AP-05 Befund 9); the controller id is not proof
// of identity, only that the expected controller answers at that address.
//
// This layer carries and shape-checks them; the reading rule lives in
// edge-app/nodered/measurements/wago-registerbild.js. The field is OPTIONAL and
// purely additive: a config without it parses exactly as before.
type Registerbild struct {
	EntityID          string              `json:"entity_id"`
	Basisadresse      int                 `json:"basisadresse"`
	Funktionscode     int                 `json:"funktionscode"`
	Wortfolge         string              `json:"wortfolge"`
	Kartenzahl        int                 `json:"kartenzahl"`
	ControllerKennung int64               `json:"controller_kennung"`
	Karten            []RegisterbildKarte `json:"karten"`
}

type Config struct {
	SchemaVersion  string      `json:"schema_version"`
	TenantID       string      `json:"tenant_id"`
	SiteID         string      `json:"site_id"`
	DeviceID       string      `json:"device_id"`
	Revision       int64       `json:"revision"`
	CatalogVersion string      `json:"catalog_version"`
	Selections     []Selection `json:"selections"`
	// Additive since UEMS AP-05 IP-6; absent on every box shipped so far.
	Registerbilder []Registerbild `json:"registerbilder,omitempty"`
}

// geteiltePunkte applies the x-point-key-rule of mqtt-measurement-config 2.0
// (AP-07 IP-18b): a point_key is unique, with ONE exception - a SHARED POINT,
// the same point_key once per component, where EVERY occurrence names an
// entity_id and no component appears twice. One occurrence without entity_id
// makes the key unique again for all of them. The same rule keys a local
// batch (one sample per component) and the per-component status.
type geteiltePunkte map[string]*geteilterPunkt

type geteilterPunkt struct {
	ohneKomponente bool
	komponenten    map[string]bool
}

// add reports whether (pointKey, entityID) may join what was seen so far.
// UUIDs compare case-insensitively: the same component in another spelling is
// still the same component twice.
func (g geteiltePunkte) add(pointKey, entityID string) bool {
	komponente := strings.ToLower(entityID)
	p, ok := g[pointKey]
	if !ok {
		p = &geteilterPunkt{komponenten: map[string]bool{}}
		g[pointKey] = p
	} else if p.ohneKomponente || komponente == "" || p.komponenten[komponente] {
		return false
	}
	if komponente == "" {
		p.ohneKomponente = true
	} else {
		p.komponenten[komponente] = true
	}
	return true
}

// ParseConfig validates identity, strict shape, duplicates and monotonicity.
func ParseConfig(raw []byte, id Identity, appliedRevision int64) (Config, error) {
	var c Config
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&c); err != nil {
		return c, fmt.Errorf("config json: %w", err)
	}
	if d.Decode(&struct{}{}) != io.EOF {
		return c, errors.New("config has trailing json")
	}
	if c.SchemaVersion != "2.0" {
		return c, errors.New("unsupported schema_version")
	}
	if c.TenantID != id.TenantID || c.SiteID != id.SiteID || c.DeviceID != id.DeviceID {
		return c, errors.New("topic identity does not match payload")
	}
	if c.Revision <= appliedRevision {
		return c, errors.New("stale revision")
	}
	if c.Revision < 1 || c.CatalogVersion == "" {
		return c, errors.New("missing revision/catalog")
	}
	if len(c.Selections) > MaxConfigPoints {
		return c, errors.New("too many selections")
	}
	seen := geteiltePunkte{}
	for _, s := range c.Selections {
		if !pointKeyPattern.MatchString(s.PointKey) || s.CadenceS < 1 || s.CadenceS > 86400 {
			return c, errors.New("invalid selection")
		}
		if s.EntityID != "" && !entityIDPattern.MatchString(s.EntityID) {
			return c, errors.New("invalid selection entity_id")
		}
		if !seen.add(s.PointKey, s.EntityID) {
			return c, fmt.Errorf("duplicate point %s", s.PointKey)
		}
		if strings.HasPrefix(s.PointKey, "custom.") {
			if len(s.Definition) == 0 || len(s.Definition) > 4096 || !validCustomDefinition(s.Definition) {
				return c, errors.New("custom selection definition missing/invalid")
			}
		} else if len(s.Definition) != 0 {
			return c, errors.New("catalog selection must not carry a custom definition")
		}
	}
	if err := validRegisterbilder(c.Registerbilder); err != nil {
		return c, err
	}
	return c, nil
}

// MaxRegisterbilder bounds the controllers one box may carry register images
// for. The image itself is bounded by the address space (§2).
const MaxRegisterbilder = 64

func validRegisterbilder(bilder []Registerbild) error {
	if len(bilder) > MaxRegisterbilder {
		return errors.New("too many registerbilder")
	}
	seen := map[string]bool{}
	for _, b := range bilder {
		if !entityIDPattern.MatchString(b.EntityID) {
			return errors.New("invalid registerbild entity_id")
		}
		if seen[b.EntityID] {
			return fmt.Errorf("duplicate registerbild %s", b.EntityID)
		}
		seen[b.EntityID] = true
		if b.Funktionscode != 3 && b.Funktionscode != 4 {
			return errors.New("registerbild funktionscode must be 3 or 4")
		}
		if b.Wortfolge != "big" && b.Wortfolge != "little" {
			return errors.New("registerbild wortfolge must be big or little")
		}
		// Base address + header + cards must stay inside the address space (§2);
		// a header is 12 words and a card block 42, and those minima are what the
		// cloud plans with. The reader navigates with the lengths FROM THE HEAD.
		if b.Basisadresse < 0 || b.Basisadresse > 65535 || b.Kartenzahl < 1 ||
			b.Basisadresse+12+b.Kartenzahl*42 > 65536 {
			return errors.New("registerbild does not fit the address space")
		}
		if len(b.Karten) != b.Kartenzahl {
			return errors.New("registerbild karten must match kartenzahl")
		}
		steckplaetze := map[int]bool{}
		for _, k := range b.Karten {
			if k.Steckplatz < 1 || k.Steckplatz > 65535 {
				return errors.New("invalid registerbild steckplatz")
			}
			if steckplaetze[k.Steckplatz] {
				return fmt.Errorf("duplicate registerbild steckplatz %d", k.Steckplatz)
			}
			steckplaetze[k.Steckplatz] = true
			if k.Kartentyp != 494 && k.Kartentyp != 495 {
				return errors.New("registerbild kartentyp must be 494 or 495")
			}
			if k.Variante < 0 || k.Variante > 65535 {
				return errors.New("invalid registerbild variante")
			}
		}
	}
	return nil
}

func validCustomDefinition(raw []byte) bool {
	var definition map[string]any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&definition) != nil || definition == nil || d.Decode(&struct{}{}) != io.EOF {
		return false
	}
	required := []string{"label", "sourceKind", "address", "selector", "valueType", "widthBits",
		"signed", "endian", "scale", "unit", "cadenceS", "retentionClass", "readOnly", "requestCostMs"}
	if len(definition) != len(required) {
		return false
	}
	for _, key := range required {
		if _, ok := definition[key]; !ok {
			return false
		}
	}
	source, _ := definition["sourceKind"].(string)
	readOnly, _ := definition["readOnly"].(bool)
	_, signedOK := definition["signed"].(bool)
	return (source == "modbus_holding" || source == "modbus_input") && readOnly && signedOK
}

type LocalStatus struct {
	Revision  int64       `json:"revision"`
	AppliedAt time.Time   `json:"applied_at"`
	Accepted  []string    `json:"accepted"`
	Rejected  []Rejection `json:"rejected"`
}
type Rejection struct {
	PointKey string `json:"point_key"`
	Reason   string `json:"reason"`
	// EntityID names the refused component of a SHARED POINT (AP-07 IP-18b,
	// mqtt-measurement-config-status x-rejection-entity-rule): the plan named the
	// point once per component, so one of them can be refused while another is
	// read. Absent everywhere else - a status without a shared point is byte for
	// byte the one sent before.
	EntityID string `json:"entity_id,omitempty"`
}

var reasons = map[string]bool{"unknown_point": true, "unsupported_catalog": true, "edge_too_old": true,
	"invalid_cadence": true, "budget_samples": true, "budget_requests": true, "budget_duty_cycle": true,
	"driver_unavailable": true, "ocpp_configuration_incompatible": true,
	// Stufe 3c: the selection names a component this box cannot place on a
	// device it reads. Refusing is the point - reading it against the primary
	// inverter would be a wrong value on the right-looking point.
	"binding_unavailable": true}

func WrapStatus(raw []byte, id Identity, edgeVersion string) ([]byte, error) {
	var s LocalStatus
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&s); err != nil {
		return nil, err
	}
	if d.Decode(&struct{}{}) != io.EOF {
		return nil, errors.New("status has trailing json")
	}
	if s.Revision < 1 || s.AppliedAt.IsZero() || edgeVersion == "" {
		return nil, errors.New("invalid status")
	}
	if len(s.Accepted)+len(s.Rejected) > MaxConfigPoints {
		return nil, errors.New("too many status points")
	}
	accepted := map[string]bool{}
	for _, key := range s.Accepted {
		if !pointKeyPattern.MatchString(key) || accepted[key] {
			return nil, errors.New("duplicate/empty accepted")
		}
		accepted[key] = true
	}
	// A rejection without entity_id refuses the whole point (as before). One
	// WITH entity_id refuses one component of a shared point; the point may
	// then also be accepted for its other components, but the same component
	// is refused at most once and never beside a whole-point refusal.
	rejected := geteiltePunkte{}
	for _, r := range s.Rejected {
		if !pointKeyPattern.MatchString(r.PointKey) || !reasons[r.Reason] ||
			(r.EntityID == "" && accepted[r.PointKey]) ||
			(r.EntityID != "" && !entityIDPattern.MatchString(r.EntityID)) ||
			!rejected.add(r.PointKey, r.EntityID) {
			return nil, errors.New("invalid rejection")
		}
	}
	return json.Marshal(struct {
		SchemaVersion string `json:"schema_version"`
		Identity
		Revision    int64       `json:"revision"`
		AppliedAt   time.Time   `json:"applied_at"`
		Accepted    []string    `json:"accepted"`
		Rejected    []Rejection `json:"rejected"`
		EdgeVersion string      `json:"edge_version"`
	}{"2.0", id, s.Revision, s.AppliedAt.UTC(), s.Accepted, s.Rejected, edgeVersion})
}

type Sample struct {
	PointKey         string     `json:"point_key"`
	Raw              any        `json:"raw"`
	Decoded          any        `json:"decoded,omitempty"`
	Quality          string     `json:"quality"`
	ObservedAt       *time.Time `json:"observed_at,omitempty"`
	SignedData       string     `json:"signed_data,omitempty"`
	SignedDataFormat string     `json:"signed_data_format,omitempty"`
	// RawMessage distinguishes an absent provenance field from explicit null.
	EntityID json.RawMessage `json:"entity_id,omitempty"`
}
type LocalBatch struct {
	CatalogVersion  string          `json:"catalog_version"`
	ObservedAt      time.Time       `json:"observed_at"`
	Samples         []Sample        `json:"samples"`
	DroppedSamples  int64           `json:"dropped_samples,omitempty"`
	Gap             bool            `json:"gap,omitempty"`
	AppliedRevision json.RawMessage `json:"applied_revision,omitempty"`
}

var qualities = map[string]bool{"good": true, "uncertain": true, "invalid": true, "stale": true, "device_error": true}

func parseBatch(raw []byte) (LocalBatch, error) {
	var b LocalBatch
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	d.DisallowUnknownFields()
	if err := d.Decode(&b); err != nil {
		return b, err
	}
	if d.Decode(&struct{}{}) != io.EOF {
		return b, errors.New("batch has trailing json")
	}
	if b.CatalogVersion == "" || b.ObservedAt.IsZero() || len(b.Samples) > MaxBatchSamples ||
		b.DroppedSamples < 0 || (len(b.Samples) == 0 && !(b.Gap && b.DroppedSamples > 0)) {
		return b, errors.New("invalid batch")
	}
	if len(b.AppliedRevision) > 0 {
		var revision int64
		if err := json.Unmarshal(b.AppliedRevision, &revision); err != nil ||
			bytes.Equal(bytes.TrimSpace(b.AppliedRevision), []byte("null")) || revision < 0 {
			return b, errors.New("invalid applied_revision")
		}
	}
	// One sample per point, or per component at a shared point: the same
	// (point_key, entity_id) rule as the plan (geteiltePunkte).
	seen := geteiltePunkte{}
	for _, s := range b.Samples {
		var entityID string
		if len(s.EntityID) > 0 {
			if err := json.Unmarshal(s.EntityID, &entityID); err != nil || !entityIDPattern.MatchString(entityID) {
				return b, errors.New("invalid sample entity_id")
			}
		}
		if !pointKeyPattern.MatchString(s.PointKey) || !seen.add(s.PointKey, entityID) ||
			s.Raw == nil || !qualities[s.Quality] {
			return b, errors.New("invalid sample")
		}
		if len(s.SignedData) > 32768 || len(s.SignedDataFormat) > 128 {
			return b, errors.New("signed data too large")
		}
		switch s.Raw.(type) {
		case json.Number, string, bool:
		default:
			return b, errors.New("raw must be scalar")
		}
		if s.Decoded != nil {
			switch s.Decoded.(type) {
			case json.Number, string, bool:
			default:
				return b, errors.New("decoded must be scalar")
			}
		}
	}
	return b, nil
}

type Envelope struct {
	Sequence int64
	Raw      []byte
}
type diskState struct {
	NextSequence       int64  `json:"next_sequence"`
	Dropped            int64  `json:"dropped"`
	Gap                bool   `json:"gap"`
	PendingDropFile    string `json:"pending_drop_file,omitempty"`
	PendingDropSamples int64  `json:"pending_drop_samples,omitempty"`
	// The WINDOW of an eviction episode, so the box can report the loss as a
	// data_gap with erkannt_aus = verdraengung (UEMS AP-07 IP-19). Durable like
	// the loss counter itself: a reboot in the middle keeps the report.
	GapVon     string `json:"gap_von,omitempty"`
	GapBis     string `json:"gap_bis,omitempty"`
	GapSamples int64  `json:"gap_samples,omitempty"`
	// GapOffen says the eviction episode is still RUNNING. While the uplink is
	// down every Append evicts again, so the window keeps growing; it is handed
	// out as ONE gap when an Append finally evicts nothing - not once per
	// discarded envelope.
	GapOffen bool `json:"gap_offen,omitempty"`
}
type Outbox struct {
	mu    sync.Mutex
	dir   string
	max   int
	state diskState
	// reported snapshots the drop count carried by an in-flight envelope. New
	// evictions may happen while QoS1 waits for PUBACK; Ack must only clear the
	// count the broker actually received, never losses that happened later.
	reported map[int64]int64
	inFlight int64
}

func OpenOutbox(dir string, max int) (*Outbox, error) {
	if max < 2 {
		return nil, errors.New("outbox max too small")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	o := &Outbox{dir: dir, max: max, reported: map[int64]int64{}, inFlight: -1}
	raw, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err == nil {
		if json.Unmarshal(raw, &o.state) != nil {
			return nil, errors.New("measurement outbox state corrupt")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if err := o.recoverPendingDrop(); err != nil {
		return nil, err
	}
	// Recover monotonically after a crash between the atomic envelope write and
	// the state write. An existing envelope is never overwritten or assigned a
	// second sequence number.
	files, err := o.files()
	if err != nil {
		return nil, err
	}
	if len(files) > 0 {
		last, parseErr := strconv.ParseInt(strings.TrimSuffix(files[len(files)-1], ".json"), 10, 64)
		if parseErr != nil {
			return nil, errors.New("measurement outbox filename corrupt")
		}
		if o.state.NextSequence <= last {
			o.state.NextSequence = last + 1
			if err := o.save(); err != nil {
				return nil, err
			}
		}
	}
	return o, nil
}

func (o *Outbox) Append(local []byte, id Identity) (Envelope, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if err := o.recoverPendingDrop(); err != nil {
		return Envelope{}, err
	}
	if id.TenantID == "" || id.SiteID == "" || id.DeviceID == "" {
		return Envelope{}, errors.New("measurement identity incomplete")
	}
	b, err := parseBatch(local)
	if err != nil {
		return Envelope{}, err
	}
	// A runtime limiter can report a loss even when no sample survived. Keep
	// that count durably and attach it to the next real envelope; the cloud
	// contract intentionally never sends an empty samples array.
	if len(b.Samples) == 0 {
		o.state.Dropped += b.DroppedSamples
		o.state.Gap = true
		return Envelope{Sequence: -1}, o.save()
	}
	files, err := o.files()
	if err != nil {
		return Envelope{}, err
	}
	verdraengt := false
	for len(files) >= o.max {
		drop := 0
		if o.inFlight >= 0 && sequenceOf(files[drop]) == o.inFlight {
			drop++
		}
		if drop >= len(files) { // max >= 2, defensive only.
			return Envelope{}, errors.New("measurement outbox contains only in-flight entry")
		}
		name := files[drop]
		count, observed, countErr := envelopeLoss(filepath.Join(o.dir, name))
		if countErr != nil {
			return Envelope{}, countErr
		}
		// The gap starts at the OLDEST envelope this episode threw away and stays
		// there while more are evicted; only its end moves.
		if o.state.GapVon == "" && observed != "" {
			o.state.GapVon = observed
		}
		o.state.GapSamples += count
		o.state.GapOffen = true
		verdraengt = true
		// Two-phase eviction: recovery can distinguish "prepared but file still
		// exists" from "file removed but loss counter not committed" exactly.
		o.state.PendingDropFile, o.state.PendingDropSamples = name, count
		if err = o.save(); err != nil {
			return Envelope{}, err
		}
		if err = os.Remove(filepath.Join(o.dir, name)); err != nil {
			return Envelope{}, err
		}
		if err = syncDir(o.dir); err != nil {
			return Envelope{}, err
		}
		files = append(files[:drop], files[drop+1:]...)
		o.state.Dropped += count
		o.state.Gap = true
		o.state.PendingDropFile, o.state.PendingDropSamples = "", 0
		if err = o.save(); err != nil {
			return Envelope{}, err
		}
	}
	// The gap is half-open [von, bis): it ends where the oldest SURVIVING
	// envelope begins - the one this envelope, or the replay behind it, does
	// deliver. Nothing survived means the gap ends at the batch written now.
	if verdraengt && o.state.GapVon != "" {
		o.state.GapBis = b.ObservedAt.UTC().Truncate(time.Second).Format("2006-01-02T15:04:05Z")
		if len(files) > 0 {
			if _, observed, err := envelopeLoss(filepath.Join(o.dir, files[0])); err == nil && observed != "" {
				o.state.GapBis = observed
			}
		}
	} else if o.state.GapOffen {
		// Nothing had to go this time: the episode is over and can be reported.
		o.state.GapOffen = false
		if err := o.save(); err != nil {
			return Envelope{}, err
		}
	}
	// Persist the loss marker before creating another envelope. A crash after
	// deleting an oldest file may duplicate a gap report, but can never hide it.
	if o.state.Gap {
		if err := o.save(); err != nil {
			return Envelope{}, err
		}
	}
	seq := o.state.NextSequence
	o.state.NextSequence++
	// Gap/drop state is injected by Next into exactly the first envelope that is
	// actually sent after an eviction. Persisted later envelopes stay clean, so
	// one loss episode cannot become a train of duplicate data-gap events.
	payload := map[string]any{"schema_version": "2.0", "tenant_id": id.TenantID, "site_id": id.SiteID, "device_id": id.DeviceID, "catalog_version": b.CatalogVersion, "sequence": seq, "observed_at": b.ObservedAt.UTC(), "samples": b.Samples, "dropped_samples": b.DroppedSamples, "gap": b.Gap || b.DroppedSamples > 0}
	// A legacy palette still produces the unchanged 2.0 shape. Provenance is
	// legal only in 2.1; never manufacture it for old local batches or replay.
	if len(b.AppliedRevision) > 0 {
		payload["applied_revision"] = b.AppliedRevision
		payload["schema_version"] = "2.1"
	}
	for _, sample := range b.Samples {
		if len(sample.EntityID) > 0 {
			payload["schema_version"] = "2.1"
			break
		}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return Envelope{}, err
	}
	if err = atomicWrite(filepath.Join(o.dir, fmt.Sprintf("%020d.json", seq)), raw); err != nil {
		return Envelope{}, err
	}
	if err = o.save(); err != nil {
		return Envelope{}, err
	}
	return Envelope{seq, raw}, nil
}
func (o *Outbox) Next() (Envelope, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	files, err := o.files()
	if err != nil || len(files) == 0 {
		return Envelope{}, false
	}
	raw, err := os.ReadFile(filepath.Join(o.dir, files[0]))
	if err != nil {
		return Envelope{}, false
	}
	seq := sequenceOf(files[0])
	o.inFlight = seq
	// A drop may happen after this older envelope was written. Surface the
	// accumulated gap on the FIRST replayed envelope, not only on a newer file
	// behind it; otherwise the receiver could observe post-gap data first.
	if o.state.Gap {
		var payload map[string]any
		d := json.NewDecoder(bytes.NewReader(raw))
		d.UseNumber()
		if d.Decode(&payload) == nil {
			already, _ := strconv.ParseInt(fmt.Sprint(payload["dropped_samples"]), 10, 64)
			payload["gap"], payload["dropped_samples"] = true, already+o.state.Dropped
			raw, _ = json.Marshal(payload)
		}
		o.reported[seq] = o.state.Dropped
	}
	return Envelope{seq, raw}, true
}
func (o *Outbox) Ack(seq int64) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if err := os.Remove(filepath.Join(o.dir, fmt.Sprintf("%020d.json", seq))); err != nil {
		return err
	}
	reported := o.reported[seq]
	delete(o.reported, seq)
	if o.inFlight == seq {
		o.inFlight = -1
	}
	if reported >= o.state.Dropped {
		o.state.Gap = false
		o.state.Dropped = 0
	} else if reported > 0 {
		o.state.Dropped -= reported
		o.state.Gap = true
	}
	return o.save()
}
func (o *Outbox) Pending() int { o.mu.Lock(); defer o.mu.Unlock(); f, _ := o.files(); return len(f) }
func sequenceOf(name string) int64 {
	seq, _ := strconv.ParseInt(strings.TrimSuffix(name, ".json"), 10, 64)
	return seq
}
func (o *Outbox) files() ([]string, error) {
	ents, err := os.ReadDir(o.dir)
	if err != nil {
		return nil, err
	}
	var f []string
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") && e.Name() != "state.json" {
			f = append(f, e.Name())
		}
	}
	sort.Strings(f)
	return f, nil
}
func (o *Outbox) save() error {
	raw, _ := json.Marshal(o.state)
	return atomicWrite(filepath.Join(o.dir, "state.json"), raw)
}
func (o *Outbox) recoverPendingDrop() error {
	if o.state.PendingDropFile == "" {
		return nil
	}
	_, err := os.Stat(filepath.Join(o.dir, o.state.PendingDropFile))
	if os.IsNotExist(err) {
		o.state.Dropped += o.state.PendingDropSamples
		o.state.Gap = true
	} else if err != nil {
		return err
	}
	o.state.PendingDropFile, o.state.PendingDropSamples = "", 0
	return o.save()
}

// envelopeLoss reports how many samples one stored envelope carries and WHEN the
// box observed them, so an eviction can name both the size and the window of the
// loss.
func envelopeLoss(path string) (int64, string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, "", err
	}
	var payload struct {
		Samples    []json.RawMessage `json:"samples"`
		Dropped    int64             `json:"dropped_samples"`
		ObservedAt string            `json:"observed_at"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return 0, "", fmt.Errorf("measurement outbox envelope corrupt: %w", err)
	}
	observed := ""
	if t, parseErr := time.Parse(time.RFC3339, payload.ObservedAt); parseErr == nil {
		observed = t.UTC().Truncate(time.Second).Format("2006-01-02T15:04:05Z")
	}
	return int64(len(payload.Samples)) + payload.Dropped, observed, nil
}

// Verdraengung hands out the window of a completed eviction episode exactly ONCE
// and clears it durably in the same step. The caller turns it into the box's own
// data_gap; a crash between the two loses the precise window, never the loss
// itself - `gap` and `dropped_samples` still ride on the next envelope.
func (o *Outbox) Verdraengung() (von, bis time.Time, samples int64, ok bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.state.GapVon == "" || o.state.GapBis == "" || o.state.GapOffen {
		return time.Time{}, time.Time{}, 0, false
	}
	von, vonErr := time.Parse(time.RFC3339, o.state.GapVon)
	bis, bisErr := time.Parse(time.RFC3339, o.state.GapBis)
	samples = o.state.GapSamples
	o.state.GapVon, o.state.GapBis, o.state.GapSamples = "", "", 0
	if err := o.save(); err != nil || vonErr != nil || bisErr != nil || !bis.After(von) {
		return time.Time{}, time.Time{}, 0, false
	}
	return von.UTC(), bis.UTC(), samples, true
}
func atomicWrite(path string, raw []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
