// Package inverter models the customer's ONE inverter choice made in the local
// Edge-App web UI (brand -> family/type -> communication -> connection params)
// and turns it into the retained `edge/inverter/config` message that Layer 1
// (Node-RED) reads to self-wire the right read adapter.
//
// The captain's rule fixes the communication method per brand: a Deye behind
// its WiFi datalogger is the special Solarman-V5 case (TCP 8899); every other
// brand is generic Modbus-TCP (502). So the customer never picks a transport
// by hand - it follows from the brand.
//
// Read/monitoring only: NOTHING here controls the inverter.
//
// Contract for the Node-RED tranche: edge-app/INVERTER-CONFIG.md (kept in sync
// with the Catalog + Selection here). The retained payload is versioned by
// SchemaVersion; the catalog is data-driven so more brands/fields are additive.
package inverter

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SchemaVersion is the version of the edge/inverter/config payload shape.
const SchemaVersion = "1.0"

// Communication methods.
const (
	CommSolarmanV5 = "solarman_v5" // Deye WiFi datalogger, Modbus-RTU over TCP 8899
	CommModbusTCP  = "modbus_tcp"  // generic Modbus/SunSpec over TCP 502
)

// Brand ids.
const (
	BrandDeye          = "deye"
	BrandGenericModbus = "generic_modbus"
)

// Default ports per communication.
const (
	defaultSolarmanPort = 8899
	defaultModbusPort   = 502
)

// ValidationError carries a customer-facing German message; the web layer maps
// it to HTTP 400 (a bad request), everything else to 500.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, a ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, a...)}
}

// --- Catalog: the selectable options, data-driven so the UI needs no per-brand
// JavaScript and new brands/fields are additive. ---

// Opt is one choice of a select field.
type Opt struct {
	Value any    `json:"value"`
	Label string `json:"label"`
}

// Field describes one connection parameter the chosen communication needs, so
// the front-end can render the form generically.
type Field struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Type     string `json:"type"` // "text" | "number" | "checkbox" | "select"
	Required bool   `json:"required,omitempty"`
	Default  any    `json:"default,omitempty"`
	Help     string `json:"help,omitempty"`
	Options  []Opt  `json:"options,omitempty"`
}

// Family is one model family / profile within a brand.
type Family struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Note  string `json:"note,omitempty"`
}

// Brand groups a manufacturer with its fixed communication method, the model
// families it offers, and the connection fields that method needs.
type Brand struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	Communication string   `json:"communication"`
	CommLabel     string   `json:"comm_label"`
	Note          string   `json:"note,omitempty"`
	Families      []Family `json:"families"`
	Fields        []Field  `json:"fields"`
}

// Catalog is the whole option tree the UI renders.
type Catalog struct {
	SchemaVersion string  `json:"schema_version"`
	Brands        []Brand `json:"brands"`
}

func solarmanFields() []Field {
	return []Field{
		{Key: "ip", Label: "IP-Adresse des Datenloggers", Type: "text", Required: true,
			Help: "Die IP des WiFi-Sticks (LSW3) im lokalen Netz, z. B. 192.168.0.28."},
		{Key: "port", Label: "Port", Type: "number", Default: defaultSolarmanPort,
			Help: "Solarman-V5-Port, üblicherweise 8899."},
		{Key: "serial", Label: "Datenlogger-Seriennummer", Type: "text", Required: true,
			Help: "Die Seriennummer des Datenloggers (nicht des Wechselrichters!) - z. B. aus dem WLAN-Namen AP_<Seriennummer> oder der Logger-Statusseite."},
		{Key: "mb_slave_id", Label: "Modbus-Slave-ID", Type: "number", Default: 1,
			Help: "Meist 1."},
		{Key: "invert_grid_sign", Label: "Netz-Vorzeichen invertieren", Type: "checkbox",
			Help: "Nur setzen, wenn Netzbezug/-einspeisung bei der Kalibrierung vertauscht sind."},
		{Key: "power_scale", Label: "Leistungsskalierung", Type: "select", Default: 1,
			Help: "Standard ist Watt. Nur auf Dekawatt (×10) stellen, wenn die Leistungswerte um den Faktor 10 zu niedrig sind (manche HV-Firmware).",
			Options: []Opt{
				{Value: 1, Label: "Standard (Watt)"},
				{Value: 10, Label: "Dekawatt (×10)"},
			}},
	}
}

func modbusFields() []Field {
	return []Field{
		{Key: "ip", Label: "IP-Adresse des Wechselrichters", Type: "text", Required: true,
			Help: "Die IP des Wechselrichters bzw. Modbus-TCP-Gateways im lokalen Netz."},
		{Key: "port", Label: "Port", Type: "number", Default: defaultModbusPort,
			Help: "Modbus-TCP-Port, üblicherweise 502."},
		{Key: "unit_id", Label: "Modbus-Unit-ID", Type: "number", Default: 1,
			Help: "Die Modbus-Adresse des Geräts, meist 1."},
	}
}

// DefaultCatalog returns the built-in option tree.
func DefaultCatalog() Catalog {
	return Catalog{
		SchemaVersion: SchemaVersion,
		Brands: []Brand{
			{
				ID:            BrandDeye,
				Label:         "Deye",
				Communication: CommSolarmanV5,
				CommLabel:     "Solarman-V5 (WiFi-Datenlogger, TCP 8899)",
				Note:          "Deye-Wechselrichter werden über ihren WiFi-Datenlogger ausgelesen.",
				Families: []Family{
					{ID: "hybrid_3p", Label: "Hybrid, 3-phasig", Note: "SUN-*-SG04LP3 (LV) oder SG01HP3 (HV)"},
					{ID: "hybrid_1p", Label: "Hybrid, 1-phasig", Note: "SUN-*-SG03LP1"},
					{ID: "string", Label: "String-Wechselrichter", Note: "SUN-*-G03/G04 (nur Erzeugung)"},
					{ID: "micro", Label: "Micro-Wechselrichter", Note: "SUN600..2000G3 (nur Erzeugung)"},
				},
				Fields: solarmanFields(),
			},
			{
				ID:            BrandGenericModbus,
				Label:         "Anderer Hersteller (Modbus / SunSpec)",
				Communication: CommModbusTCP,
				CommLabel:     "Modbus TCP (TCP 502)",
				Note:          "Für alle Wechselrichter mit SunSpec-/Modbus-TCP-Schnittstelle.",
				Families: []Family{
					{ID: "sunspec", Label: "SunSpec (Standard)", Note: "SunSpec-konformes Modbus-Registermodell"},
				},
				Fields: modbusFields(),
			},
		},
	}
}

func (c Catalog) brand(id string) (Brand, bool) {
	for _, b := range c.Brands {
		if b.ID == id {
			return b, true
		}
	}
	return Brand{}, false
}

func (b Brand) family(id string) (Family, bool) {
	for _, f := range b.Families {
		if f.ID == id {
			return f, true
		}
	}
	return Family{}, false
}

// --- Selection: the persisted + published choice. ---

// Connection holds the transport parameters. Only the fields relevant to the
// chosen communication are validated and published (see BusPayload).
type Connection struct {
	IP   string `json:"ip"`
	Port int    `json:"port"`

	// solarman_v5
	Serial         string  `json:"serial,omitempty"`
	MbSlaveID      int     `json:"mb_slave_id,omitempty"`
	InvertGridSign bool    `json:"invert_grid_sign,omitempty"`
	PowerScale     float64 `json:"power_scale,omitempty"`

	// modbus_tcp
	UnitID  int    `json:"unit_id,omitempty"`
	Profile string `json:"profile,omitempty"`
}

// SelectionRequest is what the web form POSTs: the client picks brand + family
// and fills the connection params. Communication and label are DERIVED from the
// catalog server-side, so a client can never send an inconsistent transport.
type SelectionRequest struct {
	Brand      string     `json:"brand"`
	Family     string     `json:"family"`
	Connection Connection `json:"connection"`
}

// Selection is the validated, normalized choice.
type Selection struct {
	Brand         string     `json:"brand"`
	Label         string     `json:"label"`
	Family        string     `json:"family"`
	Communication string     `json:"communication"`
	Connection    Connection `json:"connection"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// Normalize validates a request against the catalog and returns the normalized
// Selection (communication + label derived, defaults filled). A validation
// failure is a *ValidationError with a German customer-facing message.
func (c Catalog) Normalize(req SelectionRequest, now time.Time) (Selection, error) {
	b, ok := c.brand(strings.TrimSpace(req.Brand))
	if !ok {
		return Selection{}, invalid("Unbekannte Marke.")
	}
	fam, ok := b.family(strings.TrimSpace(req.Family))
	if !ok {
		return Selection{}, invalid("Bitte wählen Sie einen gültigen Typ für %s.", b.Label)
	}

	conn := req.Connection
	conn.IP = strings.TrimSpace(conn.IP)
	if conn.IP == "" {
		return Selection{}, invalid("Bitte geben Sie die IP-Adresse an.")
	}
	if strings.ContainsAny(conn.IP, " \t") {
		return Selection{}, invalid("Die IP-Adresse darf keine Leerzeichen enthalten.")
	}
	if conn.Port != 0 && (conn.Port < 1 || conn.Port > 65535) {
		return Selection{}, invalid("Der Port muss zwischen 1 und 65535 liegen.")
	}

	sel := Selection{
		Brand:         b.ID,
		Label:         b.Label + " · " + fam.Label,
		Family:        fam.ID,
		Communication: b.Communication,
		UpdatedAt:     now.UTC(),
	}

	switch b.Communication {
	case CommSolarmanV5:
		conn.Serial = strings.TrimSpace(conn.Serial)
		if conn.Serial == "" {
			return Selection{}, invalid("Für Deye ist die Datenlogger-Seriennummer erforderlich.")
		}
		if conn.Port == 0 {
			conn.Port = defaultSolarmanPort
		}
		if conn.MbSlaveID == 0 {
			conn.MbSlaveID = 1
		}
		if conn.MbSlaveID < 1 || conn.MbSlaveID > 247 {
			return Selection{}, invalid("Die Modbus-Slave-ID muss zwischen 1 und 247 liegen.")
		}
		if conn.PowerScale == 0 {
			conn.PowerScale = 1
		}
		if conn.PowerScale != 1 && conn.PowerScale != 10 {
			return Selection{}, invalid("Die Leistungsskalierung muss 1 oder 10 sein.")
		}
		// modbus-only fields are not part of this transport.
		conn.UnitID, conn.Profile = 0, ""
	case CommModbusTCP:
		if conn.Port == 0 {
			conn.Port = defaultModbusPort
		}
		if conn.UnitID == 0 {
			conn.UnitID = 1
		}
		if conn.UnitID < 1 || conn.UnitID > 247 {
			return Selection{}, invalid("Die Modbus-Unit-ID muss zwischen 1 und 247 liegen.")
		}
		conn.Profile = fam.ID // the family IS the Modbus/SunSpec profile
		// solarman-only fields are not part of this transport.
		conn.Serial, conn.MbSlaveID, conn.InvertGridSign, conn.PowerScale = "", 0, false, 0
	default:
		return Selection{}, invalid("Unbekannte Kommunikationsmethode.")
	}

	sel.Connection = conn
	return sel, nil
}

// BusPayload builds the retained edge/inverter/config message: a clean object
// carrying only the connection fields the chosen communication actually uses,
// so Node-RED sees a predictable shape per transport.
func (s Selection) BusPayload() []byte {
	conn := map[string]any{
		"ip":   s.Connection.IP,
		"port": s.Connection.Port,
	}
	switch s.Communication {
	case CommSolarmanV5:
		conn["serial"] = s.Connection.Serial
		conn["mb_slave_id"] = s.Connection.MbSlaveID
		conn["invert_grid_sign"] = s.Connection.InvertGridSign
		conn["power_scale"] = s.Connection.PowerScale
	case CommModbusTCP:
		conn["unit_id"] = s.Connection.UnitID
		conn["profile"] = s.Connection.Profile
	}
	payload := map[string]any{
		"schema_version": SchemaVersion,
		"brand":          s.Brand,
		"label":          s.Label,
		"family":         s.Family,
		"communication":  s.Communication,
		"connection":     conn,
		"updated_at":     s.UpdatedAt.UTC().Format(time.RFC3339),
	}
	raw, _ := json.Marshal(payload)
	return raw
}

// --- Store: persist the selection across restarts (data-dir/inverter.json),
// mirroring plan.Store's atomic write. ---

// Store persists the last selection.
type Store struct{ path string }

// NewStore stores the selection under dir (created if needed).
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(dir, "inverter.json")}, nil
}

// Save writes the selection atomically.
func (s *Store) Save(sel Selection) error {
	raw, err := json.Marshal(sel)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Load returns the persisted selection, ok=false if none exists yet.
func (s *Store) Load() (Selection, bool, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return Selection{}, false, nil
	}
	if err != nil {
		return Selection{}, false, err
	}
	var sel Selection
	if err := json.Unmarshal(raw, &sel); err != nil {
		return Selection{}, false, fmt.Errorf("gespeicherte Wechselrichter-Auswahl beschädigt: %w", err)
	}
	return sel, true, nil
}
