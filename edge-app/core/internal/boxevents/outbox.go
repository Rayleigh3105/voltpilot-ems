package boxevents

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Identity is the box identity the cloud enrolled. The three segments of the
// topic MUST be byte-equal to the three fields of the envelope, so exactly one
// place fills both: the core, never a driver payload.
type Identity struct {
	TenantID string
	SiteID   string
	DeviceID string
}

// Envelope is one persisted `mqtt-events-2.1` envelope with its outbox sequence.
type Envelope struct {
	Sequence int64
	Raw      []byte
}

type diskState struct {
	NextSequence int64 `json:"next_sequence"`
	// Verdraengt counts envelopes this outbox had to throw away. The cloud sees
	// the loss anyway as sequence_gap with strom = events (x-sequence-rule); the
	// counter only makes it visible locally.
	Verdraengt int64 `json:"verdraengt,omitempty"`
}

// Outbox is the durable FIFO of the event stream. It is the SECOND outbox of the
// box and counts its OWN sequence: `sequence` counts the envelopes of THIS topic
// per box (mqtt-events-2.1 x-sequence-rule), never shared with measurement samples.
//
// A WAN outage loses nothing (entries survive on disk, publishing is QoS1 and the
// file is removed only after PUBACK) and a replay duplicates nothing (the bytes,
// including every `ereignis_id`, are written once and repeated unchanged).
type Outbox struct {
	mu       sync.Mutex
	dir      string
	max      int
	state    diskState
	inFlight int64
}

func OpenOutbox(dir string, max int) (*Outbox, error) {
	if max < 2 {
		return nil, errors.New("events outbox max too small")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	o := &Outbox{dir: dir, max: max, inFlight: -1}
	raw, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err == nil {
		if json.Unmarshal(raw, &o.state) != nil {
			return nil, errors.New("events outbox state corrupt")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	// Recover monotonically after a crash between the atomic envelope write and
	// the state write: an existing envelope is never overwritten and never gets a
	// second sequence number.
	files, err := o.files()
	if err != nil {
		return nil, err
	}
	if len(files) > 0 {
		last, parseErr := strconv.ParseInt(strings.TrimSuffix(files[len(files)-1], ".json"), 10, 64)
		if parseErr != nil {
			return nil, errors.New("events outbox filename corrupt")
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

// Append persists ONE envelope carrying the given already-validated events. The
// events must be non-empty and at most MaxEvents: the contract never sends an
// empty array, and an oversized one would discard the whole envelope at the cloud.
func (o *Outbox) Append(events []Ereignis, id Identity, observedAt time.Time) (Envelope, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if id.TenantID == "" || id.SiteID == "" || id.DeviceID == "" {
		return Envelope{}, errors.New("box identity incomplete")
	}
	if len(events) == 0 || len(events) > MaxEvents {
		return Envelope{}, fmt.Errorf("events per envelope: %d", len(events))
	}
	for _, e := range events {
		if _, err := Pruefe(e); err != nil {
			return Envelope{}, err
		}
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
			return Envelope{}, errors.New("events outbox contains only in-flight entry")
		}
		if err = os.Remove(filepath.Join(o.dir, files[drop])); err != nil {
			return Envelope{}, err
		}
		files = append(files[:drop], files[drop+1:]...)
		o.state.Verdraengt++
		if err = o.save(); err != nil {
			return Envelope{}, err
		}
	}
	seq := o.state.NextSequence
	o.state.NextSequence++
	payload := map[string]any{
		"schema_version": SchemaVersion,
		"tenant_id":      id.TenantID,
		"site_id":        id.SiteID,
		"device_id":      id.DeviceID,
		"sequence":       seq,
		"observed_at":    Zeit(observedAt),
		"events":         events,
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

// Next hands out the oldest pending envelope UNCHANGED. Nothing is injected on
// the way out: what was persisted is what the cloud receives, on the first
// attempt and on every replay.
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
	return Envelope{seq, raw}, true
}

func (o *Outbox) Ack(seq int64) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if err := os.Remove(filepath.Join(o.dir, fmt.Sprintf("%020d.json", seq))); err != nil {
		return err
	}
	if o.inFlight == seq {
		o.inFlight = -1
	}
	return nil
}

func (o *Outbox) Pending() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	f, _ := o.files()
	return len(f)
}

// Verdraengt reports how many envelopes this outbox threw away since it was opened.
func (o *Outbox) Verdraengt() int64 {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.state.Verdraengt
}

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
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
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
		_ = os.Remove(tmp)
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return syncDir(filepath.Dir(path))
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	err = d.Sync()
	if closeErr := d.Close(); err == nil {
		err = closeErr
	}
	return err
}
