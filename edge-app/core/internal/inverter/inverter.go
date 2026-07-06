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

// Family is one register-map / decode profile within a brand. It is the INTERNAL
// mechanism the Node-RED read adapter self-wires from (the config `family`
// field, see edge/inverter/config): it selects the register map + scaling +
// capabilities in nodered/deye/deye-decode.js. Families are exposed for
// reference/traceability; the UI selects a Model (below), never a family.
type Family struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Note  string `json:"note,omitempty"`
}

// Model is one concrete inverter product the UI offers for individual selection
// (the captain's rule: every model is pickable on its own, NO grouping into
// families). Each model maps to exactly one register-map Family, so the customer
// picks e.g. "SUN-12K-SG04LP3" and the edge internally reads it with the correct
// map/scaling - a 12k LV can never be read with an HV profile.
type Model struct {
	ID     string `json:"id"`     // stable selection id, e.g. "sun-12k-sg04lp3"
	Label  string `json:"label"`  // product name, e.g. "SUN-12K-SG04LP3"
	Family string `json:"family"` // the register-map Family this model reads with
	Note   string `json:"note,omitempty"`
}

// Brand groups a manufacturer with its fixed communication method, the concrete
// models it offers (the UI selection unit), the register-map families those
// models resolve to, and the connection fields that method needs.
type Brand struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	Communication string   `json:"communication"`
	CommLabel     string   `json:"comm_label"`
	Note          string   `json:"note,omitempty"`
	Models        []Model  `json:"models"`
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

// Register-map family ids (the INTERNAL decode profiles in
// nodered/deye/deye-decode.js). Every selectable Deye Model resolves to one of
// these; the generic-Modbus brand uses "sunspec".
const (
	FamHybrid3p = "hybrid_3p" // SG04LP3 LV + SG01HP3 HV high map (battery, 2-4 MPPT)
	FamHybrid1p = "hybrid_1p" // SG03LP1 single-phase low map (battery)
	FamString   = "string"    // G03/G04 grid-tie AC output (no battery)
	FamMicro    = "micro"     // SUN*G3 micro AC output (no battery)
	FamSunSpec  = "sunspec"   // generic Modbus/SunSpec profile
)

// deyeFamilies is the register-map reference list (what each Model decodes with).
func deyeFamilies() []Family {
	return []Family{
		{ID: FamHybrid3p, Label: "Hybrid, 3-phasig", Note: "SUN-*-SG04LP3 (LV) oder SG01HP3 (HV)"},
		{ID: FamHybrid1p, Label: "Hybrid, 1-phasig", Note: "SUN-*-SG03LP1"},
		{ID: FamString, Label: "String-Wechselrichter", Note: "SUN-*-G03/G04 (nur Erzeugung)"},
		{ID: FamMicro, Label: "Micro-Wechselrichter", Note: "SUN600..2000G3 (nur Erzeugung)"},
	}
}

// deyeModels is the COMPLETE per-model list the UI offers for individual
// selection (no grouping into families - the captain's explicit requirement).
// Each entry maps to its correct register-map Family. Model coverage follows
// ha-solarman's supported Deye lines (deye_sg04lp3 / deye_hybrid / deye_string /
// deye_2mppt+deye_4mppt); adding a model is a one-line edit here, no code change.
func deyeModels() []Model {
	m := func(id, label, family, note string) Model {
		return Model{ID: id, Label: label, Family: family, Note: note}
	}
	return []Model{
		// --- 3-phase hybrid, LOW-VOLTAGE battery (SG04LP3, 2 MPPT) --------------
		m("sun-5k-sg04lp3", "SUN-5K-SG04LP3-EU", FamHybrid3p, "5 kW · Hybrid · 3-phasig · Niedervolt-Speicher (LV)"),
		m("sun-6k-sg04lp3", "SUN-6K-SG04LP3-EU", FamHybrid3p, "6 kW · Hybrid · 3-phasig · Niedervolt-Speicher (LV)"),
		m("sun-8k-sg04lp3", "SUN-8K-SG04LP3-EU", FamHybrid3p, "8 kW · Hybrid · 3-phasig · Niedervolt-Speicher (LV)"),
		m("sun-10k-sg04lp3", "SUN-10K-SG04LP3-EU", FamHybrid3p, "10 kW · Hybrid · 3-phasig · Niedervolt-Speicher (LV)"),
		m("sun-12k-sg04lp3", "SUN-12K-SG04LP3-EU", FamHybrid3p, "12 kW · Hybrid · 3-phasig · Niedervolt-Speicher (LV)"),
		// --- 3-phase hybrid, HIGH-VOLTAGE battery (SG01HP3, 3-4 MPPT) -----------
		m("sun-29.9k-sg01hp3", "SUN-29.9K-SG01HP3-EU", FamHybrid3p, "29,9 kW · Hybrid · 3-phasig · Hochvolt-Speicher (HV)"),
		m("sun-30k-sg01hp3", "SUN-30K-SG01HP3-EU", FamHybrid3p, "30 kW · Hybrid · 3-phasig · Hochvolt-Speicher (HV)"),
		m("sun-35k-sg01hp3", "SUN-35K-SG01HP3-EU", FamHybrid3p, "35 kW · Hybrid · 3-phasig · Hochvolt-Speicher (HV)"),
		m("sun-40k-sg01hp3", "SUN-40K-SG01HP3-EU", FamHybrid3p, "40 kW · Hybrid · 3-phasig · Hochvolt-Speicher (HV)"),
		m("sun-50k-sg01hp3", "SUN-50K-SG01HP3-EU", FamHybrid3p, "50 kW · Hybrid · 3-phasig · Hochvolt-Speicher (HV)"),
		// --- single-phase hybrid (SG03LP1) -------------------------------------
		m("sun-3.6k-sg03lp1", "SUN-3.6K-SG03LP1-EU", FamHybrid1p, "3,6 kW · Hybrid · 1-phasig"),
		m("sun-5k-sg03lp1", "SUN-5K-SG03LP1-EU", FamHybrid1p, "5 kW · Hybrid · 1-phasig"),
		m("sun-6k-sg03lp1", "SUN-6K-SG03LP1-EU", FamHybrid1p, "6 kW · Hybrid · 1-phasig"),
		m("sun-7.6k-sg03lp1", "SUN-7.6K-SG03LP1-EU", FamHybrid1p, "7,6 kW · Hybrid · 1-phasig"),
		m("sun-8k-sg03lp1", "SUN-8K-SG03LP1-EU", FamHybrid1p, "8 kW · Hybrid · 1-phasig"),
		// --- string grid-tie, no battery (G03 / G04) ---------------------------
		m("sun-4k-g03", "SUN-4K-G03", FamString, "4 kW · String · nur Erzeugung"),
		m("sun-5k-g03", "SUN-5K-G03", FamString, "5 kW · String · nur Erzeugung"),
		m("sun-6k-g03", "SUN-6K-G03", FamString, "6 kW · String · nur Erzeugung"),
		m("sun-7k-g03", "SUN-7K-G03", FamString, "7 kW · String · nur Erzeugung"),
		m("sun-8k-g03", "SUN-8K-G03", FamString, "8 kW · String · nur Erzeugung"),
		m("sun-10k-g03", "SUN-10K-G03", FamString, "10 kW · String · nur Erzeugung"),
		m("sun-12k-g03", "SUN-12K-G03", FamString, "12 kW · String · nur Erzeugung"),
		m("sun-15k-g04", "SUN-15K-G04", FamString, "15 kW · String · 3-phasig · nur Erzeugung"),
		m("sun-20k-g04", "SUN-20K-G04", FamString, "20 kW · String · 3-phasig · nur Erzeugung"),
		m("sun-25k-g04", "SUN-25K-G04", FamString, "25 kW · String · 3-phasig · nur Erzeugung"),
		m("sun-30k-g04", "SUN-30K-G04", FamString, "30 kW · String · 3-phasig · nur Erzeugung"),
		m("sun-33k-g04", "SUN-33K-G04", FamString, "33 kW · String · 3-phasig · nur Erzeugung"),
		m("sun-50k-g04", "SUN-50K-G04", FamString, "50 kW · String · 3-phasig · nur Erzeugung"),
		// --- micro-inverter, no battery (SUN*G3) -------------------------------
		m("sun600g3", "SUN600G3-EU-230", FamMicro, "600 W · Mikro · 2 MPPT · nur Erzeugung"),
		m("sun800g3", "SUN800G3-EU-230", FamMicro, "800 W · Mikro · 2 MPPT · nur Erzeugung"),
		m("sun1000g3", "SUN1000G3-EU-230", FamMicro, "1000 W · Mikro · 2 MPPT · nur Erzeugung"),
		m("sun1300g3", "SUN1300G3-EU-230", FamMicro, "1300 W · Mikro · 4 MPPT · nur Erzeugung"),
		m("sun1600g3", "SUN1600G3-EU-230", FamMicro, "1600 W · Mikro · 4 MPPT · nur Erzeugung"),
		m("sun2000g3", "SUN2000G3-EU-230", FamMicro, "2000 W · Mikro · 4 MPPT · nur Erzeugung"),
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
				Note:          "Deye-Wechselrichter werden über ihren WiFi-Datenlogger ausgelesen. Wählen Sie Ihr genaues Modell.",
				Models:        deyeModels(),
				Families:      deyeFamilies(),
				Fields:        solarmanFields(),
			},
			{
				ID:            BrandGenericModbus,
				Label:         "Anderer Hersteller (Modbus / SunSpec)",
				Communication: CommModbusTCP,
				CommLabel:     "Modbus TCP (TCP 502)",
				Note:          "Für alle Wechselrichter mit SunSpec-/Modbus-TCP-Schnittstelle.",
				Models: []Model{
					{ID: FamSunSpec, Label: "SunSpec (Standard)", Family: FamSunSpec, Note: "SunSpec-konformes Modbus-Registermodell"},
				},
				Families: []Family{
					{ID: FamSunSpec, Label: "SunSpec (Standard)", Note: "SunSpec-konformes Modbus-Registermodell"},
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

func (b Brand) model(id string) (Model, bool) {
	for _, m := range b.Models {
		if m.ID == id {
			return m, true
		}
	}
	return Model{}, false
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

// SelectionRequest is what the web form POSTs: the client picks brand + the
// concrete model and fills the connection params. Communication, register-map
// family and label are DERIVED from the catalog server-side, so a client can
// never send an inconsistent transport or read a model with the wrong map.
//
// `Model` is the primary selector. `Family` is accepted as a backward-compatible
// fallback (a register-map family given directly, e.g. by an older client or an
// integration) when Model is empty.
type SelectionRequest struct {
	Brand      string     `json:"brand"`
	Model      string     `json:"model"`
	Family     string     `json:"family,omitempty"`
	Connection Connection `json:"connection"`
}

// Selection is the validated, normalized choice. `Family` stays the internal
// register-map key the Node-RED adapter self-wires from (unchanged contract);
// `Model` is the concrete product the customer picked (empty for a legacy
// family-only request).
type Selection struct {
	Brand         string     `json:"brand"`
	Label         string     `json:"label"`
	Model         string     `json:"model,omitempty"`
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

	// Resolve the concrete model -> its register-map family + label. Model is the
	// primary selector; a bare Family is accepted for backward compatibility.
	var modelID, registerFamily, typeLabel string
	if m := strings.TrimSpace(req.Model); m != "" {
		mod, ok := b.model(m)
		if !ok {
			return Selection{}, invalid("Bitte wählen Sie ein gültiges Modell für %s.", b.Label)
		}
		modelID = mod.ID
		registerFamily = mod.Family
		typeLabel = mod.Label
	} else if fID := strings.TrimSpace(req.Family); fID != "" {
		fam, ok := b.family(fID)
		if !ok {
			return Selection{}, invalid("Bitte wählen Sie einen gültigen Typ für %s.", b.Label)
		}
		registerFamily = fam.ID
		typeLabel = fam.Label
	} else {
		return Selection{}, invalid("Bitte wählen Sie ein Modell für %s.", b.Label)
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
		Label:         b.Label + " · " + typeLabel,
		Model:         modelID,
		Family:        registerFamily,
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
		conn.Profile = registerFamily // the register-map family IS the Modbus/SunSpec profile
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
		// `model` is the concrete product (additive, forward-compatible); `family`
		// stays the register-map key the Node-RED adapter routes on (unchanged).
		"model":         s.Model,
		"family":        s.Family,
		"communication": s.Communication,
		"connection":    conn,
		"updated_at":    s.UpdatedAt.UTC().Format(time.RFC3339),
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
