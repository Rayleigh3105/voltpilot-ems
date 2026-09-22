package anteile

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// SchemaVersion is the share document version the box reads.
const SchemaVersion = "1.0"

var (
	// ErrNichtIhres: the payload names another box than the topic - not this
	// box's document, discarded WITHOUT a receipt (mqtt-verbund-anteile.md §2).
	ErrNichtIhres = errors.New("Anteils-Dokument fuer eine andere Box")
	// ErrUnlesbar: not a share document 1.0 (JSON, version, a required field,
	// a negative kW). The contract has no receipt word for it: discarded, the
	// held share stays.
	ErrUnlesbar = errors.New("Anteils-Dokument unlesbar")
)

// Gelesen is one share document read off the wire.
type Gelesen struct {
	Dokument Dokument
	Schritt  string
	// Rolle is the addressed box's role (fuehrt | steuert_mit), empty when
	// the cloud does not send it.
	Rolle string
	Box   string
	// ReserveBezug is reserve_verbraucher.bezug (optional, AP-15 Folge of
	// IP-19): the rated power of the box's controllable import devices
	// outside the charge park, as decimal text; "" when the cloud does not
	// send it - then there is no reserve, as before.
	ReserveBezug json.Number
	// roh keeps the decimal text of every share for the heartbeat mirror.
	roh map[string]map[string]json.Number
}

type draht struct {
	SchemaVersion string                            `json:"schema_version"`
	TenantID      string                            `json:"tenant_id"`
	SiteID        string                            `json:"site_id"`
	DeviceID      string                            `json:"device_id"`
	Epoche        json.Number                       `json:"epoche"`
	Revision      json.Number                       `json:"revision"`
	Schritt       string                            `json:"schritt"`
	Rolle         string                            `json:"rolle"`
	Verteilbar    map[string]json.Number            `json:"verteilbar"`
	Anteile       map[string]map[string]json.Number `json:"anteile"`
	// ReserveVerbraucher is optional (additive, schema_version stays 1.0).
	ReserveVerbraucher map[string]json.Number `json:"reserve_verbraucher"`
}

// Lesen reads a …/v2/verbund-anteile payload for the box own (whose topic
// delivered it). A payload naming another device is ErrNichtIhres; a tenant
// or site other than own stays readable - DokumentPruefen answers it with
// fremde_anlage (T4).
func Lesen(own Identitaet, payload []byte) (*Gelesen, error) {
	g, err := parse(payload)
	if err != nil {
		return nil, err
	}
	if own.Box == "" || g.Box != own.Box {
		return nil, ErrNichtIhres
	}
	return g, nil
}

func parse(payload []byte) (*Gelesen, error) {
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.UseNumber()
	var d draht
	if err := dec.Decode(&d); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnlesbar, err)
	}
	if d.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf("%w: schema_version %q", ErrUnlesbar, d.SchemaVersion)
	}
	epoche, err1 := d.Epoche.Int64()
	revision, err2 := d.Revision.Int64()
	if err1 != nil || err2 != nil || epoche < 1 || revision < 1 {
		return nil, fmt.Errorf("%w: epoche/revision", ErrUnlesbar)
	}
	if d.TenantID == "" || d.SiteID == "" || d.DeviceID == "" ||
		!slices.Contains([]string{"uebergang", "ziel"}, d.Schritt) ||
		(d.Rolle != "" && !slices.Contains([]string{"fuehrt", "steuert_mit"}, d.Rolle)) {
		return nil, fmt.Errorf("%w: Pflichtfeld", ErrUnlesbar)
	}
	dok := Dokument{Mandant: d.TenantID, Anlage: d.SiteID, Epoche: epoche, Revision: revision,
		Verteilbar: map[string]*big.Rat{}, Anteile: map[string]map[string]*big.Rat{}}
	for _, r := range Richtungen {
		v, err := kw(d.Verteilbar[r])
		if err != nil {
			return nil, fmt.Errorf("%w: verteilbar.%s", ErrUnlesbar, r)
		}
		dok.Verteilbar[r] = v
		// a missing table stays missing: DokumentPruefen names the own id as
		// absent (unknown is no zero), exactly like the Java twin
		if tabelle, ok := d.Anteile[r]; ok {
			je := map[string]*big.Rat{}
			for box, n := range tabelle {
				a, err := kw(n)
				if err != nil {
					return nil, fmt.Errorf("%w: anteile.%s", ErrUnlesbar, r)
				}
				je[box] = a
			}
			dok.Anteile[r] = je
		}
	}
	var reserve json.Number
	if n, ok := d.ReserveVerbraucher["bezug"]; ok {
		// a negative or unreadable reserve is a broken document like a
		// negative share: discarded, the held share stays
		if _, err := kw(n); err != nil {
			return nil, fmt.Errorf("%w: reserve_verbraucher.bezug", ErrUnlesbar)
		}
		reserve = n
	}
	return &Gelesen{Dokument: dok, Schritt: d.Schritt, Rolle: d.Rolle, Box: d.DeviceID, ReserveBezug: reserve,
		roh: d.Anteile}, nil
}

func kw(n json.Number) (*big.Rat, error) {
	if n == "" {
		return nil, ErrUnlesbar
	}
	r, ok := new(big.Rat).SetString(n.String())
	if !ok || r.Sign() < 0 {
		return nil, ErrUnlesbar
	}
	return r, nil
}

// Gehalten is the share the box holds after an accepted document: epoch,
// revision, its role and its OWN share per direction (the Y3 heartbeat
// mirror), plus whose document it was.
type Gehalten struct {
	Identitaet Identitaet
	Stand      Stand
	Rolle      string
	// AnteilKw is the own share per direction as the decimal text of the
	// document (kW, one decimal - never re-rounded through a float).
	AnteilKw map[string]json.Number
	// ReserveBezugKw is the reserve of the box's other controllable import
	// devices from the same document (decimal text); "" = the document has
	// none - the heartbeat then does not claim one.
	ReserveBezugKw json.Number
}

// Halten turns an accepted document into the held share of its box.
func Halten(g *Gelesen) *Gehalten {
	own := map[string]json.Number{}
	for _, r := range Richtungen {
		own[r] = g.roh[r][g.Box]
	}
	return &Gehalten{
		Identitaet:     Identitaet{Mandant: g.Dokument.Mandant, Anlage: g.Dokument.Anlage, Box: g.Box},
		Stand:          Stand{Epoche: g.Dokument.Epoche, Revision: g.Dokument.Revision},
		Rolle:          g.Rolle,
		AnteilKw:       own,
		ReserveBezugKw: g.ReserveBezug,
	}
}

// StandFuer is the stand an incoming document is compared with: only a share
// held under the SAME identity counts - a box re-claimed into another plant
// must not refuse that plant's first document as revision_aelter.
func (h *Gehalten) StandFuer(own Identitaet) *Stand {
	if h == nil || h.Identitaet != own {
		return nil
	}
	s := h.Stand
	return &s
}

// --- persistence (Y2: the share lives on disk, R15: it is back before the
// first measurement) ---------------------------------------------------------

// Store persists the last ACCEPTED share document. There is no Clear: a lost
// or deleted document never widens what the box holds.
type Store struct{ path string }

// NewStore stores under dir (created if needed).
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(dir, "verbund-anteile.json")}, nil
}

type gespeichert struct {
	AngenommenAm time.Time       `json:"angenommen_am"`
	Payload      json.RawMessage `json:"payload"`
}

// Save writes the accepted payload atomically (temp file, fsync, rename): a
// crash leaves the old or the new document, never half of one.
func (s *Store) Save(payload []byte, at time.Time) error {
	raw, err := json.Marshal(gespeichert{AngenommenAm: at.UTC(), Payload: payload})
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Load returns the held share, nil when the box never accepted a document.
// The stored payload is re-read through the same parser; its identity check
// happened when it was accepted.
func (s *Store) Load() (*Gehalten, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var st gespeichert
	if err := json.Unmarshal(raw, &st); err != nil {
		return nil, fmt.Errorf("gespeichertes Anteils-Dokument beschaedigt: %w", err)
	}
	g, err := parse(st.Payload)
	if err != nil {
		return nil, fmt.Errorf("gespeichertes Anteils-Dokument: %w", err)
	}
	return Halten(g), nil
}
