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
	LocalConfigTopic  = "edge/measurements/config"
	LocalStatusTopic  = "edge/measurements/config-status"
	LocalSamplesTopic = "edge/measurements/samples"
	MaxBatchSamples   = 256
	MaxConfigPoints   = 2301
)

var pointKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._*\[\]@-]{0,239}$`)

type Identity struct {
	TenantID string `json:"tenant_id"`
	SiteID   string `json:"site_id"`
	DeviceID string `json:"device_id"`
}
type Selection struct {
	PointKey string `json:"point_key"`
	CadenceS int    `json:"cadence_s"`
}
type Config struct {
	SchemaVersion  string      `json:"schema_version"`
	TenantID       string      `json:"tenant_id"`
	SiteID         string      `json:"site_id"`
	DeviceID       string      `json:"device_id"`
	Revision       int64       `json:"revision"`
	CatalogVersion string      `json:"catalog_version"`
	Selections     []Selection `json:"selections"`
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
	seen := map[string]bool{}
	for _, s := range c.Selections {
		if !pointKeyPattern.MatchString(s.PointKey) || s.CadenceS < 1 || s.CadenceS > 86400 {
			return c, errors.New("invalid selection")
		}
		if seen[s.PointKey] {
			return c, fmt.Errorf("duplicate point %s", s.PointKey)
		}
		seen[s.PointKey] = true
	}
	return c, nil
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
}

var reasons = map[string]bool{"unknown_point": true, "unsupported_catalog": true, "edge_too_old": true,
	"invalid_cadence": true, "budget_samples": true, "budget_requests": true, "budget_duty_cycle": true,
	"driver_unavailable": true, "ocpp_configuration_incompatible": true}

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
	seen := map[string]bool{}
	for _, key := range s.Accepted {
		if !pointKeyPattern.MatchString(key) || seen[key] {
			return nil, errors.New("duplicate/empty accepted")
		}
		seen[key] = true
	}
	for _, r := range s.Rejected {
		if !pointKeyPattern.MatchString(r.PointKey) || !reasons[r.Reason] || seen[r.PointKey] {
			return nil, errors.New("invalid rejection")
		}
		seen[r.PointKey] = true
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
}
type LocalBatch struct {
	CatalogVersion string    `json:"catalog_version"`
	ObservedAt     time.Time `json:"observed_at"`
	Samples        []Sample  `json:"samples"`
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
	if b.CatalogVersion == "" || b.ObservedAt.IsZero() || len(b.Samples) < 1 || len(b.Samples) > MaxBatchSamples {
		return b, errors.New("invalid batch")
	}
	seen := map[string]bool{}
	for _, s := range b.Samples {
		if !pointKeyPattern.MatchString(s.PointKey) || seen[s.PointKey] ||
			s.Raw == nil || !qualities[s.Quality] {
			return b, errors.New("invalid sample")
		}
		seen[s.PointKey] = true
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
	NextSequence int64 `json:"next_sequence"`
	Dropped      int64 `json:"dropped"`
	Gap          bool  `json:"gap"`
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
	if id.TenantID == "" || id.SiteID == "" || id.DeviceID == "" {
		return Envelope{}, errors.New("measurement identity incomplete")
	}
	b, err := parseBatch(local)
	if err != nil {
		return Envelope{}, err
	}
	files, err := o.files()
	if err != nil {
		return Envelope{}, err
	}
	for len(files) >= o.max {
		drop := 0
		if o.inFlight >= 0 && sequenceOf(files[drop]) == o.inFlight {
			drop++
		}
		if drop >= len(files) { // max >= 2, defensive only.
			return Envelope{}, errors.New("measurement outbox contains only in-flight entry")
		}
		if err = os.Remove(filepath.Join(o.dir, files[drop])); err != nil {
			return Envelope{}, err
		}
		files = append(files[:drop], files[drop+1:]...)
		o.state.Dropped++
		o.state.Gap = true
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
	payload := map[string]any{"schema_version": "2.0", "tenant_id": id.TenantID, "site_id": id.SiteID, "device_id": id.DeviceID, "catalog_version": b.CatalogVersion, "sequence": seq, "observed_at": b.ObservedAt.UTC(), "samples": b.Samples, "dropped_samples": 0, "gap": false}
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
		if json.Unmarshal(raw, &payload) == nil {
			payload["gap"], payload["dropped_samples"] = true, o.state.Dropped
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
func atomicWrite(path string, raw []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
