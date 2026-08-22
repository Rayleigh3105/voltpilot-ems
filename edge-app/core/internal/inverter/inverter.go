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
	CommSolarmanV5      = "solarman_v5"       // Deye WiFi datalogger, Modbus-RTU over TCP 8899
	CommModbusTCP       = "modbus_tcp"        // generic Modbus/SunSpec over TCP 502
	CommFroniusSolarAPI = "fronius_solar_api" // Fronius Solar API (local HTTP/JSON), like HA
	// CommFroniusSunSpec reads a Fronius inverter over real SunSpec Modbus TCP
	// (dynamic model discovery, port 502) - the path for a Fronius Eco 27.0-3-S
	// whose Solar API does not work. Read-only (telemetry); control is a separate
	// bench-gated increment. See nodered/sunspec/sunspec-live.js + FRONIUS.md.
	CommFroniusSunSpec = "fronius_sunspec"
	// CommGoeHTTP reads a go-e Charger (wallbox) over its local HTTP API v2 (LAN
	// HTTP/JSON, keyless, port 80): ONE GET to /api/status returns the charging
	// power, which VoltPilot maps onto the CONSUMER load channel. Read-only by
	// construction (no charge/current control). See nodered/goe/goe-api.js.
	CommGoeHTTP = "goe_http_api"
	// CommShellyHTTP is a Shelly relay/plug switching a consumer (heating rod,
	// pump, generic load) over its local HTTP API (LAN, keyless, port 80).
	// The generation dialect (Gen1 REST vs Gen2+ RPC) and the metering
	// capability (1PM/Plug-S class vs plain relay) are DETECTED once by the
	// CORE and persisted - never configured by the operator. Unlike every
	// other transport the CORE owns the whole socket (source poll, connection
	// test AND the consumer-control executor, internal/shelly) - single
	// writer, no Node-RED read path. See nodered/SHELLY.md.
	CommShellyHTTP = "shelly_http"
	// CommKostalModbus reads a KOSTAL PLENTICORE battery inverter over the
	// vendor's own Modbus-TCP server (TCP 1502, Unit-ID 71 - NOT the generic 502/1
	// defaults, which is why this is its own communication like fronius_sunspec):
	// fixed register map per the official interface description (Rev. 2.9), see
	// nodered/kostal/kostal-decode.js + the scout report
	// data/vp-kostal-plenticore-s5. Read-only in this increment; the control path
	// (external battery management, Tier 2) is a separate gated increment.
	CommKostalModbus = "kostal_modbus"
)

// Brand ids.
const (
	BrandDeye          = "deye"
	BrandGenericModbus = "generic_modbus"
	BrandFronius       = "fronius"
	// BrandFroniusSunSpec is a separate catalog entry (not a second communication
	// on BrandFronius) so the per-brand-fixed-communication model stays unchanged:
	// "Fronius" = Solar API (HTTP), "Fronius (Modbus / SunSpec)" = SunSpec Modbus.
	BrandFroniusSunSpec = "fronius_sunspec"
	// BrandGoe is the go-e Charger wallbox (a read-only CONSUMER measurement
	// point). Added as a source in the "Weitere Energiequellen" flow, not as a
	// primary inverter.
	BrandGoe = "go-e"
	// BrandShelly is a Shelly relay/plug switching a consumer (heating rod or
	// another switchable load). Added as a source with the Verbraucher role,
	// never as a primary inverter; the control path is the core executor
	// (internal/shelly).
	BrandShelly = "shelly"
	// BrandKostal is the KOSTAL PLENTICORE BI battery inverter (AC-coupled,
	// battery-only - the DC side IS the battery, no MPPTs). It is a PRIMARY
	// inverter: it measures battery power + SoC and, via an attached KOSTAL
	// Smart Energy Meter, the grid power; the site's PV rides on other
	// inverters as Erzeuger sources. The hybrid PLENTICORE plus is deliberately
	// NOT offered yet (its PV DC registers are not decoded, and a battery-only
	// read of a PV-carrying hybrid would understate the house balance).
	BrandKostal = "kostal"
)

// Default ports per communication.
const (
	defaultSolarmanPort       = 8899
	defaultModbusPort         = 502
	defaultFroniusPort        = 80 // Fronius Solar API (HTTP); GEN24 self-signed HTTPS uses insecure_tls
	defaultFroniusSunSpecPort = 502
	defaultGoePort            = 80   // go-e Charger local HTTP API v2
	defaultShellyPort         = 80   // Shelly local HTTP API (both generations)
	defaultKostalPort         = 1502 // KOSTAL PLENTICORE Modbus-TCP server
	defaultKostalUnitID       = 71   // KOSTAL default Modbus Unit-ID (changeable on the device)
)

// Control tiers - the battery-control PRIMITIVE a brand exposes, decoupled from
// the read communication (design data/vp-battery-control-deepdive/report.md §1).
// The Node-RED control adapter (nodered/inverter-control-routing.js controlRoute)
// dispatches on this, so a new hybrid's control surface is catalog data, exactly
// like the read side. Higher tier = more real-time, higher risk. This is the
// declared surface; whether a live write ever happens is still gated end-to-end
// by the kill-switch (Config.ControlEnabled) AND per-model certification
// (Config.ControlCertified), never by the tier.
const (
	ControlTierReadOnly  = 0 // no certified control surface (read + monitor only)
	ControlTierSunSpec   = 1 // SunSpec Model 124 storage / Immediate Controls (RAM rate window + hold)
	ControlTierVendorEMS = 2 // vendor external-EMS: a true forced-watts RAM setpoint (Sungrow/SolarEdge)
	ControlTierToU       = 3 // vendor Time-of-Use window (EEPROM) - Deye/Sunsynk
)

// Geraetetypen - die DIMENSION, mit der der Anlege-Weg beginnt („Was moechten
// Sie anbinden?", Konzept data/vp-anlegen-rework/konzept.md, Captain-Entscheid 2).
//
// Sie ist eine Eigenschaft des GERAETS, nie des Verbindungswegs: eine go-e ist
// eine Wallbox, egal ob sie per HTTP oder spaeter anders gelesen wird, und ein
// Deye bleibt ein Wechselrichter. Vor dieser Dimension ordneten sich go-e und
// Shelly als Pseudo-MARKEN in die Herstellerliste ein („go-e (Wallbox)"), was
// eine Kategorie in eine Marke verwandelte und den Klammer-Zusatz im Namen
// erzwang.
//
// Das Vokabular ist VOLLSTAENDIG, auch wenn der eingebaute Katalog heute nur
// drei davon belegt - dieselbe Disziplin wie beim `kind`-Vokabular der
// Vorlagen-Tabelle. Ein Typ ohne Eintrag ist kein Versaeumnis, sondern die
// ehrliche Aussage „dafuer bringt die Box (noch) kein Lese-Profil mit":
//   - DeviceTypeChargePoint: eine OCPP-Ladesaeule verbindet sich SELBST zur Box
//     (internal/csms); sie wird nie aus diesem Katalog gewaehlt.
//   - DeviceTypeMeter: fuer einen reinen Zaehler gibt es kein eigenes
//     Decode-Profil - ein generischer Eintrag waere eine unbelegte Behauptung.
//   - DeviceTypeCustom: der Selbstbau-Baukasten definiert seine Kanaele selbst
//     (Cloud-Tabelle site_component_template), er hat keine Katalog-Vorlage.
const (
	DeviceTypeInverter    = "inverter"     // Wechselrichter / Speicher
	DeviceTypeWallbox     = "wallbox"      // Wallbox mit eigener lokaler Schnittstelle
	DeviceTypeSwitch      = "switch"       // schaltbarer Verbraucher (Relais/Schaltaktor)
	DeviceTypeMeter       = "meter"        // Zaehler (reserviert, siehe oben)
	DeviceTypeChargePoint = "charge_point" // OCPP-Ladesaeule (reserviert, siehe oben)
	DeviceTypeCustom      = "custom"       // Eigenbau/Baukasten (reserviert, siehe oben)
)

// Transport ist EIN Verbindungsweg, ueber den die Geraete einer Marke gelesen
// werden. Er ist eine Eigenschaft des GERAETS, nie des Markennamens - die Regel,
// die den zweiten Fronius-Eintrag („Fronius (Modbus / SunSpec)") aufgeloest hat:
// ein Fronius Eco 27 spricht SunSpec Modbus, ein GEN24 die Solar API, und beide
// sind ein Fronius.
//
// Family ist das Decode-Profil DIESES Wegs. Es gilt nur dort, wo das MODELL
// keine eigene Registerkarte deklariert (Fronius/generisch: ein Profil je Weg);
// bei Deye/KOSTAL gehoert die Familie dem Modell (SG04LP3 != SG01HP3) und der
// Weg traegt keine.
type Transport struct {
	Communication string  `json:"communication"`
	Label         string  `json:"label"`
	Family        string  `json:"family,omitempty"`
	Note          string  `json:"note,omitempty"`
	Fields        []Field `json:"fields"`
}

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
	// RatedKw is the inverter's nameplate AC power in kW (0 = unknown). It is the
	// authoritative physical bound the edge derives a per-channel plausibility
	// envelope from (guards.Envelope): a 12 kW inverter can neither generate nor
	// move ~26 kW, so a beyond-rating reading is garbage regardless of the
	// operator's despike sensitivity preset. Only PV and battery charge/discharge
	// are inverter-bounded; pure grid import follows the house connection, not the
	// inverter (see guards.Envelope).
	RatedKw float64 `json:"rated_kw,omitempty"`

	// DeviceType uebersteuert den Geraetetyp der Marke fuer DIESES Modell (leer =
	// der der Marke). Vorgesehen fuer eine Marke, die mehrere Typen baut; heute
	// nutzt es kein eingebautes Modell.
	DeviceType string `json:"device_type,omitempty"`

	// Transports sind die Verbindungswege, ueber die DIESES Modell gelesen werden
	// kann - der ERSTE ist der Vorgabeweg. Leer = der einzige Weg der Marke.
	//
	// ⚠ Der Vorgabeweg ist die Aussage; die weiteren sind der Experten-Ausweg
	// („die Solar API dieses GEN24 antwortet nicht"). Er wird NIE geraten: hat ein
	// Modell nur einen Weg, gibt es kein Auswahlfeld und nichts zu uebersteuern.
	Transports []string `json:"transports,omitempty"`

	// Fields sind die AUFGELOESTEN Formularfelder dieses Modells auf seinem
	// Vorgabeweg, samt dem Auswahlfeld „Verbindungsweg" davor. Gesetzt NUR bei
	// mehreren Wegen (sonst gelten die Felder der Marke) - siehe resolveCatalog.
	Fields []Field `json:"fields,omitempty"`
}

// Brand groups a manufacturer with its fixed communication method, the concrete
// models it offers (the UI selection unit), the register-map families those
// models resolve to, and the connection fields that method needs.
type Brand struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// DeviceType ist die Typ-Dimension (siehe DeviceType*): was fuer ein Geraet
	// die Marke baut. Sie steuert, unter welcher Typ-Karte die Marke im
	// Anlege-Weg erscheint - und ersetzt damit die frueheren Klammer-Zusaetze im
	// Markennamen („go-e (Wallbox)").
	DeviceType string `json:"device_type"`
	// Communication/CommLabel/Fields SPIEGELN den VORGABE-Transport (Transports[0]).
	// Sie bleiben, weil aeltere Abnehmer sie lesen und weil eine Marke mit genau
	// einem Weg dadurch unveraendert aussieht; die Wahrheit steht in Transports.
	Communication string   `json:"communication"`
	CommLabel     string   `json:"comm_label"`
	Note          string   `json:"note,omitempty"`
	Models        []Model  `json:"models"`
	Families      []Family `json:"families"`
	Fields        []Field  `json:"fields"`
	// Transports sind ALLE Verbindungswege dieser Marke, der erste ist die
	// Vorgabe. Genau ein Eintrag = das bisherige Verhalten.
	Transports []Transport `json:"transports"`
	// Hidden markiert eine ALIAS-Marke: sie bleibt vollstaendig aufloesbar (eine
	// Bestandsanlage referenziert ihre Kennung), wird aber NICHT mehr angeboten.
	//
	// ⚠ Das ist die Alias-Ebene der harten Kompatibilitaets-Regel: eine
	// Praesentations-Neuordnung darf keine gespeicherte Kennung entwerten. Eine
	// versteckte Marke behaelt ihren Inhalt BYTE-GLEICH - Modelle, Familien,
	// Felder, Transport - damit `Normalize`/`Backfill`/`RatedKw` und die
	// cloud-seitige Vorlagen-Aufloesung (brand+model) unveraendert antworten.
	Hidden bool `json:"hidden,omitempty"`
	// SupersededBy nennt die SICHTBARE Marke, die diese abgeloest hat (leer, wenn
	// die Marke selbst sichtbar ist). Sie ist die Bruecke fuer jede Oberflaeche,
	// die einen Nachfolger zeigen will - nie ein Grund, die alte Kennung
	// umzuschreiben.
	SupersededBy string `json:"superseded_by,omitempty"`
	// ControlTier is the battery-control PRIMITIVE the brand exposes (see the
	// ControlTier* constants). It is decoupled from Communication on purpose: a
	// future Tier-2 vendor (Sungrow/SolarEdge) reads over modbus_tcp yet must
	// dispatch to the external-EMS adapter, which a communication-only dispatch
	// could not express. Stamped onto the published Selection so controlRoute can
	// dispatch on it. 0 (read-only) is the honest default for uncertified brands.
	ControlTier int `json:"control_tier"`
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
		{Key: "invert_batt_sign", Label: "Batterie-Vorzeichen invertieren (Messung)", Type: "checkbox",
			Help: "Nur setzen, wenn die gemessene Batterieleistung verkehrt herum ist: bei Ladung muss der Wert positiv sein. Zeigt die Kalibrierung/das Cockpit die Batterie beim Laden negativ, hier setzen (firmwareabhängig, z. B. bei manchen SG01HP3-HV-Geräten)."},
		{Key: "power_scale", Label: "Leistungsskalierung", Type: "select", Default: 0,
			Help: "Wird bei 3-phasigen Hybriden (SG04LP3/SG01HP3) automatisch aus dem Gerät erkannt (Niedervolt = Watt, Hochvolt = Dekawatt ×10). Nur als manuelle Übersteuerung ändern, wenn die automatische Erkennung nicht greift.",
			Options: []Opt{
				{Value: 0, Label: "Automatisch (empfohlen)"},
				{Value: 1, Label: "Watt (×1)"},
				{Value: 10, Label: "Dekawatt (×10)"},
			}},
		{Key: "control_write_fc", Label: "Schreib-Funktionscode (Steuerung)", Type: "select", Default: 0,
			Help: "Modbus-Funktion für Steuerungs-Schreibbefehle. Viele Deye-Hybride nehmen einen Einzelregister-Schreibbefehl (FC6) zwar an, der Wechselrichter antwortet aber nicht und übernimmt den Wert nicht - deshalb ist FC16 (mehrere Register) die Voreinstellung, wie sie die funktionierenden Deye-Integrationen nutzen. Nur auf FC6 zurückstellen, wenn eine abweichende Firmware ausschließlich FC6 beantwortet.",
			Options: []Opt{
				{Value: 0, Label: "Automatisch (FC16, empfohlen)"},
				{Value: 16, Label: "FC16 – mehrere Register (0x10)"},
				{Value: 6, Label: "FC6 – einzelnes Register (0x06)"},
			}},
		{Key: "remote_mode", Label: "Fernsteuerung (Remote Mode)", Type: "select", Default: "auto",
			Help: "Neuere Deye-Firmware (Protokoll V105.1+) bietet eine echte Fernsteuerung: ein vorzeichenbehafteter Leistungssollwert für die Batterie, abgesichert durch einen Totmannschalter im Wechselrichter. VoltPilot erkennt automatisch, ob Ihr Gerät sie hat, und nutzt sonst die Zeitfenster-Steuerung. Nur auf \"Aus\" stellen, wenn die Fernsteuerung auf Ihrem Gerät Probleme macht.",
			Options: []Opt{
				{Value: "auto", Label: "Automatisch erkennen (empfohlen)"},
				{Value: "off", Label: "Aus – immer Zeitfenster-Steuerung"},
			}},
		{Key: "remote_watchdog_s", Label: "Totmannschalter der Fernsteuerung (Sekunden)", Type: "number", Default: 0,
			Help: "Wie lange der Wechselrichter einen Sollwert ohne neue Nachricht von VoltPilot hält, bevor er die Fernsteuerung von selbst verlässt und normal weiterläuft. Leer/0 = 60 Sekunden (empfohlen, ca. 6 Sollwert-Takte Reserve). Erlaubt sind 10 bis 18000 Sekunden."},
		{Key: "remote_battery_strategy", Label: "Batterie-Strategie der Fernsteuerung", Type: "select", Default: 0,
			Help: "Standard: „Nur Leistung\" - der Wechselrichter bekommt ausschließlich den Leistungssollwert, ohne SoC-Ziel im Gerät. Bei „Leistung + SoC-Grenze\" wird zusätzlich eine SoC-Grenze im Gerät gesetzt; auf manchen Firmwares (z. B. SUN-30K-SG01HP3-EU) wurde diese Grenze aber als ZIEL statt als Grenze ausgelegt, sodass die Batterie ein Vielfaches der befohlenen Leistung lieferte. Nur zum Nachtesten umstellen. Die SoC-Grenzen von VoltPilot greifen in beiden Fällen (guards.Clamp).",
			Options: []Opt{
				{Value: 0, Label: "Nur Leistung (empfohlen)"},
				{Value: 5, Label: "Leistung + SoC-Grenze (nur zum Test)"},
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

// froniusFields describes the Fronius Solar API (local HTTP/JSON) connection.
// Unlike the Modbus/Solarman transports it needs NO serial, NO unit id and NO
// auth (the Solar API is unauthenticated on the LAN, like Home Assistant reads
// it). Only the host, the port (80 by default) and an escape hatch for the GEN24
// self-signed-cert firmware and the rare inverted grid sign.
func froniusFields() []Field {
	return []Field{
		{Key: "ip", Label: "IP-Adresse des Wechselrichters", Type: "text", Required: true,
			Help: "Die IP des Fronius-Wechselrichters im lokalen Netz (z. B. 192.168.0.20). Die Solar API muss in der Weboberfläche des Wechselrichters aktiviert sein."},
		{Key: "port", Label: "Port", Type: "number", Default: defaultFroniusPort,
			Help: "HTTP-Port der Solar API, üblicherweise 80."},
		{Key: "insecure_tls", Label: "Selbstsigniertes Zertifikat akzeptieren (HTTPS)", Type: "checkbox",
			Help: "Nur setzen, wenn Ihre GEN24-Firmware auf HTTPS mit selbstsigniertem Zertifikat umleitet."},
		{Key: "invert_grid_sign", Label: "Netz-Vorzeichen invertieren", Type: "checkbox",
			Help: "Normalerweise NICHT nötig (Fronius-Vorzeichen passt bereits). Nur setzen, wenn Netzbezug/-einspeisung bei der Kalibrierung vertauscht sind."},
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
	// FamFroniusSolarAPI is the single decode profile for the Fronius Solar API
	// (HTTP/JSON). The Solar API is self-describing (GetPowerFlowRealtimeData
	// returns PV+grid+load+battery+SoC in one call), so there is no per-model
	// register map to pick - one family covers every Fronius line.
	FamFroniusSolarAPI = "fronius_solar_api"
	// FamSunSpecLive is the register profile for the real SunSpec-live read path
	// (dynamic model discovery). Addresses are discovered per device, so - like
	// the Solar API - there is one family, not a per-model register map. The
	// Node-RED routing keys on communication=fronius_sunspec + this profile.
	FamSunSpecLive = "sunspec_live"
	// FamGoeHTTP is the single decode profile for the go-e HTTP API v2. The API is
	// self-describing (one GET returns the charging power), so there is no
	// per-model register map - one family covers every go-e Charger model.
	FamGoeHTTP = "goe_http_api"
	// FamShellyHTTP is the single decode profile for the Shelly local HTTP API.
	// The GENERATION dialect (Gen1 REST vs Gen2+ RPC) is NOT a family: the
	// core detects it per device and persists it (internal/shelly Store), so
	// one family covers every Shelly relay/plug model.
	FamShellyHTTP = "shelly_http"
	// FamKostalPlenticore is the register profile of the KOSTAL PLENTICORE BI
	// battery-inverter line (official Modbus map, G1/G2 identical for the read
	// registers used) - nodered/kostal/kostal-decode.js owns the map + decode.
	FamKostalPlenticore = "kostal_plenticore"
)

// deyeFamilies is the register-map reference list (what each Model decodes with).
func deyeFamilies() []Family {
	return []Family{
		{ID: FamHybrid3p, Label: "Hybrid, 3-phasig", Note: "SUN-*-SG04LP3 (LV) oder SG01HP3/SG02HP3 (HV)"},
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
	m := func(id, label, family string, ratedKw float64, note string) Model {
		return Model{ID: id, Label: label, Family: family, RatedKw: ratedKw, Note: note}
	}
	return []Model{
		// --- 3-phase hybrid, LOW-VOLTAGE battery (SG04LP3, 2 MPPT) --------------
		m("sun-5k-sg04lp3", "SUN-5K-SG04LP3-EU", FamHybrid3p, 5, "5 kW · Hybrid · 3-phasig · Niedervolt-Speicher (LV)"),
		m("sun-6k-sg04lp3", "SUN-6K-SG04LP3-EU", FamHybrid3p, 6, "6 kW · Hybrid · 3-phasig · Niedervolt-Speicher (LV)"),
		m("sun-8k-sg04lp3", "SUN-8K-SG04LP3-EU", FamHybrid3p, 8, "8 kW · Hybrid · 3-phasig · Niedervolt-Speicher (LV)"),
		m("sun-10k-sg04lp3", "SUN-10K-SG04LP3-EU", FamHybrid3p, 10, "10 kW · Hybrid · 3-phasig · Niedervolt-Speicher (LV)"),
		m("sun-12k-sg04lp3", "SUN-12K-SG04LP3-EU", FamHybrid3p, 12, "12 kW · Hybrid · 3-phasig · Niedervolt-Speicher (LV)"),
		// --- 3-phase hybrid, HIGH-VOLTAGE battery (SG01HP3, 3-4 MPPT) -----------
		m("sun-29.9k-sg01hp3", "SUN-29.9K-SG01HP3-EU", FamHybrid3p, 29.9, "29,9 kW · Hybrid · 3-phasig · Hochvolt-Speicher (HV)"),
		m("sun-30k-sg01hp3", "SUN-30K-SG01HP3-EU", FamHybrid3p, 30, "30 kW · Hybrid · 3-phasig · Hochvolt-Speicher (HV)"),
		m("sun-35k-sg01hp3", "SUN-35K-SG01HP3-EU", FamHybrid3p, 35, "35 kW · Hybrid · 3-phasig · Hochvolt-Speicher (HV)"),
		m("sun-40k-sg01hp3", "SUN-40K-SG01HP3-EU", FamHybrid3p, 40, "40 kW · Hybrid · 3-phasig · Hochvolt-Speicher (HV)"),
		m("sun-50k-sg01hp3", "SUN-50K-SG01HP3-EU", FamHybrid3p, 50, "50 kW · Hybrid · 3-phasig · Hochvolt-Speicher (HV)"),
		// --- 3-phase hybrid, HIGH-VOLTAGE battery, new generation (SG02HP3-EU-AM3, 3 MPPT) ---
		m("sun-25k-sg02hp3", "SUN-25K-SG02HP3-EU-AM3", FamHybrid3p, 25, "25 kW · Hybrid · 3-phasig · Hochvolt-Speicher (HV) · neue Generation"),
		m("sun-29.9k-sg02hp3", "SUN-29.9K-SG02HP3-EU-AM3", FamHybrid3p, 29.9, "29,9 kW · Hybrid · 3-phasig · Hochvolt-Speicher (HV) · neue Generation"),
		m("sun-30k-sg02hp3", "SUN-30K-SG02HP3-EU-AM3", FamHybrid3p, 30, "30 kW · Hybrid · 3-phasig · Hochvolt-Speicher (HV) · neue Generation"),
		// --- single-phase hybrid (SG03LP1) -------------------------------------
		m("sun-3.6k-sg03lp1", "SUN-3.6K-SG03LP1-EU", FamHybrid1p, 3.6, "3,6 kW · Hybrid · 1-phasig"),
		m("sun-5k-sg03lp1", "SUN-5K-SG03LP1-EU", FamHybrid1p, 5, "5 kW · Hybrid · 1-phasig"),
		m("sun-6k-sg03lp1", "SUN-6K-SG03LP1-EU", FamHybrid1p, 6, "6 kW · Hybrid · 1-phasig"),
		m("sun-7.6k-sg03lp1", "SUN-7.6K-SG03LP1-EU", FamHybrid1p, 7.6, "7,6 kW · Hybrid · 1-phasig"),
		m("sun-8k-sg03lp1", "SUN-8K-SG03LP1-EU", FamHybrid1p, 8, "8 kW · Hybrid · 1-phasig"),
		// --- string grid-tie, no battery (G03 / G04) ---------------------------
		m("sun-4k-g03", "SUN-4K-G03", FamString, 4, "4 kW · String · nur Erzeugung"),
		m("sun-5k-g03", "SUN-5K-G03", FamString, 5, "5 kW · String · nur Erzeugung"),
		m("sun-6k-g03", "SUN-6K-G03", FamString, 6, "6 kW · String · nur Erzeugung"),
		m("sun-7k-g03", "SUN-7K-G03", FamString, 7, "7 kW · String · nur Erzeugung"),
		m("sun-8k-g03", "SUN-8K-G03", FamString, 8, "8 kW · String · nur Erzeugung"),
		m("sun-10k-g03", "SUN-10K-G03", FamString, 10, "10 kW · String · nur Erzeugung"),
		m("sun-12k-g03", "SUN-12K-G03", FamString, 12, "12 kW · String · nur Erzeugung"),
		m("sun-15k-g04", "SUN-15K-G04", FamString, 15, "15 kW · String · 3-phasig · nur Erzeugung"),
		m("sun-20k-g04", "SUN-20K-G04", FamString, 20, "20 kW · String · 3-phasig · nur Erzeugung"),
		m("sun-25k-g04", "SUN-25K-G04", FamString, 25, "25 kW · String · 3-phasig · nur Erzeugung"),
		m("sun-30k-g04", "SUN-30K-G04", FamString, 30, "30 kW · String · 3-phasig · nur Erzeugung"),
		m("sun-33k-g04", "SUN-33K-G04", FamString, 33, "33 kW · String · 3-phasig · nur Erzeugung"),
		m("sun-50k-g04", "SUN-50K-G04", FamString, 50, "50 kW · String · 3-phasig · nur Erzeugung"),
		// --- micro-inverter, no battery (SUN*G3) -------------------------------
		m("sun600g3", "SUN600G3-EU-230", FamMicro, 0.6, "600 W · Mikro · 2 MPPT · nur Erzeugung"),
		m("sun800g3", "SUN800G3-EU-230", FamMicro, 0.8, "800 W · Mikro · 2 MPPT · nur Erzeugung"),
		m("sun1000g3", "SUN1000G3-EU-230", FamMicro, 1.0, "1000 W · Mikro · 2 MPPT · nur Erzeugung"),
		m("sun1300g3", "SUN1300G3-EU-230", FamMicro, 1.3, "1300 W · Mikro · 4 MPPT · nur Erzeugung"),
		m("sun1600g3", "SUN1600G3-EU-230", FamMicro, 1.6, "1600 W · Mikro · 4 MPPT · nur Erzeugung"),
		m("sun2000g3", "SUN2000G3-EU-230", FamMicro, 2.0, "2000 W · Mikro · 4 MPPT · nur Erzeugung"),
	}
}

// froniusFamilies is the register-map reference list for Fronius. Since the
// brand became ONE entry it lists BOTH decode profiles - which one a model reads
// with follows its TRANSPORT (see froniusTransports), not its name.
func froniusFamilies() []Family {
	return []Family{
		{ID: FamFroniusSolarAPI, Label: "Fronius Solar API", Note: "Lokale HTTP/JSON-Schnittstelle (GetPowerFlowRealtimeData, v1)"},
		{ID: FamSunSpecLive, Label: "SunSpec über Modbus", Note: "Dynamische SunSpec-Modellerkennung über Modbus TCP"},
	}
}

// froniusTransports sind die ZWEI Verbindungswege der Marke Fronius. Die
// Reihenfolge ist die Vorgabe-Reihenfolge der Marke; welcher Weg fuer EIN Modell
// gilt, sagt `Model.Transports` (erster Eintrag = Vorgabe).
func froniusTransports() []Transport {
	return []Transport{
		{Communication: CommFroniusSolarAPI, Label: "Solar API (HTTP)", Family: FamFroniusSolarAPI,
			Note:   "Die lokale Solar API des Wechselrichters muss in seiner Weboberfläche aktiviert sein.",
			Fields: froniusFields()},
		{Communication: CommFroniusSunSpec, Label: "SunSpec über Modbus TCP", Family: FamSunSpecLive,
			Note:   "Modbus TCP muss in der Weboberfläche des Wechselrichters aktiviert sein (\"Wechselrichter-Steuerung über Modbus\").",
			Fields: froniusSunspecFields()},
	}
}

// froniusModels ist die EINE Modell-Liste der Marke. Jedes Modell nennt seine
// Verbindungswege selbst - Eco liest ueber SunSpec, GEN24/Symo/Primo ueber die
// Solar API -, und der jeweils zweite Eintrag ist der Experten-Ausweg fuer den
// Fall, dass der uebliche Weg auf diesem Geraet nicht antwortet.
//
// ⚠ KEIN Modell setzt hier `Family`: bei Fronius folgt das Decode-Profil dem
// WEG (Solar API -> fronius_solar_api, SunSpec -> sunspec_live), nicht dem
// Produkt. Ein gesetztes `Family` wuerde den Ausweg still wirkungslos machen.
//
// ⚠ Die Kennungen `fronius_solar_api` und `sunspec_live` sind PERSISTIERTE
// Modell-Kennungen (sie stammen aus der Zeit, als die Familie als Modell-Id
// diente) - sie bleiben, damit jede Bestandsanlage und jeder Vorlagen-Schluessel
// weiter aufloest.
func froniusModels() []Model {
	solarFirst := []string{CommFroniusSolarAPI, CommFroniusSunSpec}
	sunspecFirst := []string{CommFroniusSunSpec, CommFroniusSolarAPI}
	return []Model{
		{ID: FamFroniusSolarAPI, Label: "Fronius GEN24 / Symo / Primo", Transports: solarFirst,
			Note: "GEN24, Symo, Primo, Symo Hybrid u. a."},
		{ID: "fronius-eco-27-3-s", Label: "Fronius Eco 27.0-3-S", Transports: sunspecFirst, RatedKw: 27,
			Note: "27 kW · 3-phasig · String (nur Erzeugung)"},
		{ID: "fronius-eco-25-3-s", Label: "Fronius Eco 25.0-3-S", Transports: sunspecFirst, RatedKw: 25,
			Note: "25 kW · 3-phasig · String (nur Erzeugung)"},
		{ID: FamSunSpecLive, Label: "Anderes Fronius-Modell", Transports: sunspecFirst,
			Note: "Weiteres Fronius-Modell, Nennleistung unbekannt"},
	}
}

// froniusSunspecFields describes the Fronius SunSpec-Modbus (TCP 502) read
// connection: host + Modbus unit id + an optional model-type hint (the walker
// auto-detects float vs int+SF, so this is advisory) + the grid-sign escape
// hatch. No serial, no auth. unit_id is a first-class field: on TCP the inverter
// is typically unit 1; a second inverter / a Smart Meter may sit at another unit
// id (that multi-unit modelling is a later increment - here it is configurable).
func froniusSunspecFields() []Field {
	return []Field{
		{Key: "ip", Label: "IP-Adresse des Wechselrichters", Type: "text", Required: true,
			Help: "Die IP des Fronius-Wechselrichters bzw. Datamanagers im lokalen Netz (z. B. 192.168.210.40). Modbus TCP muss in der Weboberfläche des Wechselrichters aktiviert sein (\"Wechselrichter-Steuerung über Modbus\")."},
		{Key: "port", Label: "Port", Type: "number", Default: defaultFroniusSunSpecPort,
			Help: "Modbus-TCP-Port, üblicherweise 502."},
		{Key: "unit_id", Label: "Modbus-Unit-ID", Type: "number", Default: 1,
			Help: "Die Modbus-Adresse des Wechselrichters, per TCP meist 1."},
		{Key: "model_type", Label: "SunSpec-Modelltyp", Type: "select", Default: "auto",
			Help: "Wird normalerweise automatisch erkannt. Nur ändern, wenn die automatische Erkennung nicht greift.",
			Options: []Opt{
				{Value: "auto", Label: "Automatisch (empfohlen)"},
				{Value: "float", Label: "Float (111/112/113)"},
				{Value: "int_sf", Label: "Integer + Skalierung (101/102/103)"},
			}},
		{Key: "invert_grid_sign", Label: "Netz-Vorzeichen invertieren", Type: "checkbox",
			Help: "Nur relevant mit separatem Zähler; auf echtem Gerät prüfen."},
		{Key: "curtail_write_fc", Label: "Schreib-Funktionscode (Abregelung)", Type: "select", Default: 0,
			Help: "Modbus-Funktion für die Einspeise-Begrenzung. Der Datamanager übernimmt die Begrenzung nur als geschlossenen Satz: einzelne FC6-Schreibbefehle landen zwar im Register, werden aber nie zum aktiven Befehl (am 09.08.2026 an einer echten Anlage gemessen). Deshalb ist FC16 (mehrere Register in einem Vorgang) die Voreinstellung - so beschreibt es auch das Fronius-Handbuch und so macht es die erprobte Victron-Umsetzung. Nur auf FC6 zurückstellen, wenn eine abweichende Firmware ausschließlich FC6 beantwortet.",
			Options: []Opt{
				{Value: 0, Label: "Automatisch (FC16, empfohlen)"},
				{Value: 16, Label: "FC16 – mehrere Register (0x10)"},
				{Value: 6, Label: "FC6 – einzelne Register (0x06)"},
			}},
	}
}

// froniusSunspecFamilies is the single decode profile (discovery is dynamic).
//
// ⚠ ALIAS-EBENE, EINGEFROREN. Diese drei Funktionen beschreiben die frueher
// eigenstaendige Marke „Fronius (Modbus / SunSpec)". Sie ist seit der
// Katalog-Neustruktur VERSTECKT (Brand.Hidden) und bleibt inhaltlich
// unveraendert, damit jede Bestandsanlage - allen voran die zwei Fronius Eco der
// Anlage Herzogau - ihre gespeicherte Marken-/Modell-Kennung, ihren
// Vorlagen-Schluessel (`builtin:fronius_sunspec:…`) und ihr Verhalten BEHAELT.
// Hier nichts „aufraeumen": jede Aenderung hier ist eine Aenderung an einer
// laufenden Kundenanlage.
func froniusSunspecFamilies() []Family {
	return []Family{
		{ID: FamSunSpecLive, Label: "SunSpec (Live-Messwerte)", Note: "Dynamische SunSpec-Modellerkennung über Modbus TCP"},
	}
}

// froniusSunspecModels offers the concrete Fronius Modbus/SunSpec inverters. The
// Eco 27.0-3-S carries RatedKw=27 so the physical-envelope guard engages; a
// generic entry (no rating) covers other SunSpec-conformant Fronius inverters.
// Siehe froniusSunspecFamilies: EINGEFROREN.
func froniusSunspecModels() []Model {
	return []Model{
		{ID: "fronius-eco-27-3-s", Label: "Fronius Eco 27.0-3-S", Family: FamSunSpecLive, RatedKw: 27,
			Note: "27 kW · 3-phasig · String (nur Erzeugung) · SunSpec Modbus TCP"},
		{ID: "fronius-eco-25-3-s", Label: "Fronius Eco 25.0-3-S", Family: FamSunSpecLive, RatedKw: 25,
			Note: "25 kW · 3-phasig · String (nur Erzeugung) · SunSpec Modbus TCP"},
		{ID: FamSunSpecLive, Label: "Fronius (SunSpec, generisch)", Family: FamSunSpecLive,
			Note: "Anderes SunSpec-fähiges Fronius-Modell (Nennleistung unbekannt)"},
	}
}

// goeFields describes the go-e Charger (HTTP API v2) connection: only the host +
// the HTTP port (80 by default). Keyless on the LAN, self-describing, no serial /
// unit id / auth - the leanest of all transports (like the Fronius Solar API but
// without even the HTTPS escape hatch, since go-e is plain HTTP). The go-e's HTTP
// API must be enabled once in the go-e app.
func goeFields() []Field {
	return []Field{
		{Key: "ip", Label: "IP-Adresse der Wallbox", Type: "text", Required: true,
			Help: "Die IP der go-e-Wallbox im lokalen Netz (z. B. 192.168.0.50). Die lokale HTTP-API (v2) muss in der go-e-App aktiviert sein."},
		{Key: "port", Label: "Port", Type: "number", Default: defaultGoePort,
			Help: "HTTP-Port der go-e-API, üblicherweise 80."},
	}
}

// goeFamilies is the single decode profile (the go-e HTTP API is self-describing).
func goeFamilies() []Family {
	return []Family{
		{ID: FamGoeHTTP, Label: "go-e HTTP API (v2)", Note: "Lokale HTTP/JSON-Schnittstelle (/api/status)"},
	}
}

// goeModels offers one generic go-e entry (like the Fronius Solar API single
// entry): /api/status returns the same shape across the go-e Charger lines, so no
// per-model register map is needed. No RatedKw is set, so the physical-envelope
// guard stays inactive (a wallbox's load has no fixed nameplate ceiling here).
func goeModels() []Model {
	return []Model{
		{ID: FamGoeHTTP, Label: "go-e Charger", Family: FamGoeHTTP,
			Note: "HOME, HOMEfix, Gemini u. a. - nur lesen"},
	}
}

// shellyFields describes the Shelly connection: host + HTTP port + the switch
// channel on multi-channel devices. Generation and metering capability are
// detected, never asked - the customer cannot know their "Gen".
func shellyFields() []Field {
	return []Field{
		{Key: "ip", Label: "IP-Adresse des Shelly", Type: "text", Required: true,
			Help: "Die IP des Shelly im lokalen Netz (z. B. 192.168.0.60). Feste IP/DHCP-Reservierung empfohlen; der Passwortschutz der Shelly-Weboberfläche muss AUS sein."},
		{Key: "port", Label: "Port", Type: "number", Default: defaultShellyPort,
			Help: "HTTP-Port des Shelly, üblicherweise 80."},
		{Key: "channel", Label: "Schaltkanal", Type: "number", Default: 0,
			Help: "Nur bei Mehrkanal-Geräten (z. B. Shelly 2PM): 0 = erster Kanal, 1 = zweiter."},
	}
}

// shellyFamilies is the single profile (dialect + metering are detected).
func shellyFamilies() []Family {
	return []Family{
		{ID: FamShellyHTTP, Label: "Shelly HTTP API", Note: "Lokale HTTP-Schnittstelle; Generation (Gen1/Gen2+) wird automatisch erkannt"},
	}
}

// shellyModels offers one generic entry: whether the device measures power
// (1PM/Plug-S class) is DETECTED from the device itself, not picked from a
// list - a picked-but-wrong metering claim would fabricate a capability. No
// RatedKw (the consumer's Nennleistung lives in the cloud consumer profile).
func shellyModels() []Model {
	return []Model{
		{ID: FamShellyHTTP, Label: "Shelly Relais / Schaltaktor", Family: FamShellyHTTP,
			Note: "Shelly 1/1PM, Plus 1/1PM, Plug S u. a., alle Generationen · Generation und Leistungsmessung werden automatisch erkannt"},
	}
}

// kostalFields describes the KOSTAL PLENTICORE Modbus-TCP connection: the
// vendor server on TCP 1502 with Unit-ID 71 (both device-changeable), plus the
// float byte-order setting (device register 5: factory default little/CDAB;
// "auto" reads it live each cycle) and the two READ-sign escape hatches. The
// grid sign hangs on the CONFIGURED energy-meter position (Sensorposition 2 =
// Netzanschlusspunkt matches VoltPilot's +Bezug/-Einspeisung; Position 1 needs
// the invert hatch) - verified on the device, never guessed.
func kostalFields() []Field {
	return []Field{
		{Key: "ip", Label: "IP-Adresse des Wechselrichters", Type: "text", Required: true,
			Help: "Die IP des PLENTICORE im lokalen Netz. Modbus (TCP) muss im Webserver des Wechselrichters aktiviert sein (Servicemenü)."},
		{Key: "port", Label: "Port", Type: "number", Default: defaultKostalPort,
			Help: "Modbus-TCP-Port des PLENTICORE, werksseitig 1502."},
		{Key: "unit_id", Label: "Modbus-Unit-ID", Type: "number", Default: defaultKostalUnitID,
			Help: "Die Modbus-Adresse des Geräts, werksseitig 71."},
		{Key: "byte_order", Label: "Byte-Reihenfolge (Float-Register)", Type: "select", Default: "auto",
			Help: "Wird automatisch aus dem Gerät gelesen (Register 5; Werkseinstellung Little-Endian/CDAB). Nur ändern, wenn die automatische Erkennung nicht greift.",
			Options: []Opt{
				{Value: "auto", Label: "Automatisch (empfohlen)"},
				{Value: "little", Label: "Little-Endian (CDAB, Werk)"},
				{Value: "big", Label: "Big-Endian (ABCD)"},
			}},
		{Key: "invert_grid_sign", Label: "Netz-Vorzeichen invertieren", Type: "checkbox",
			Help: "Nur setzen, wenn Netzbezug/-einspeisung bei der Kalibrierung vertauscht sind (Energiezähler in Sensorposition 1 statt am Netzanschlusspunkt)."},
		{Key: "invert_batt_sign", Label: "Batterie-Vorzeichen invertieren (Messung)", Type: "checkbox",
			Help: "Nur setzen, wenn die gemessene Batterieleistung verkehrt herum ist: bei Ladung muss der Wert positiv sein."},
	}
}

// kostalFamilies is the register-map reference list (one family - the official
// map covers the BI line).
func kostalFamilies() []Family {
	return []Family{
		{ID: FamKostalPlenticore, Label: "PLENTICORE BI (Batterie-Wechselrichter)",
			Note: "Offizielle Modbus-TCP-Registerkarte (Port 1502, Unit-ID 71)"},
	}
}

// kostalModels offers the PLENTICORE BI models individually (the captain's
// per-model rule). RatedKw is the nameplate AC power (S_ac,r) - the physical
// envelope bound; the generic entry has none.
func kostalModels() []Model {
	return []Model{
		{ID: "plenticore-bi-10-26", Label: "PLENTICORE BI 10/26", Family: FamKostalPlenticore, RatedKw: 10,
			Note: "10 kVA · Batterie-Wechselrichter (AC-gekoppelt, Hochvolt-Batterie, 26 A)"},
		{ID: "plenticore-bi-5.5-13", Label: "PLENTICORE BI 5.5/13", Family: FamKostalPlenticore, RatedKw: 5.5,
			Note: "5,5 kVA · Batterie-Wechselrichter (AC-gekoppelt, Hochvolt-Batterie, 13 A)"},
		{ID: "kostal-plenticore-bi-generic", Label: "Anderes PLENTICORE-BI-Modell", Family: FamKostalPlenticore,
			Note: "Weiteres Modell der Baureihe, auch G2 (Nennleistung unbekannt)"},
	}
}

// DefaultCatalog returns the built-in option tree.
//
// Der Baum hat seit der Katalog-Neustruktur (Konzept
// data/vp-anlegen-rework/konzept.md, Captain-Entscheide 22.08.2026) DREI
// Dimensionen: GERAETETYP (was fuer ein Geraet), MARKE (Hersteller, exakt in
// seiner offiziellen Schreibweise) und MODELL (das Produkt vom Typenschild).
// Der VERBINDUNGSWEG ist eine Eigenschaft des Modells (`Model.Transports`), nie
// ein Bestandteil des Markennamens - deshalb gibt es genau EINEN Fronius, und
// deshalb steht in keinem Label mehr ein Technik-Zusatz in Klammern (die Technik
// wohnt in `Note` und in `Transport.Label`).
func DefaultCatalog() Catalog {
	cat := Catalog{
		SchemaVersion: SchemaVersion,
		Brands: []Brand{
			{
				ID:         BrandDeye,
				Label:      "Deye",
				DeviceType: DeviceTypeInverter,
				Note:       "Deye-Wechselrichter werden über ihren WiFi-Datenlogger ausgelesen. Wählen Sie Ihr genaues Modell.",
				Models:     deyeModels(),
				Families:   deyeFamilies(),
				Transports: []Transport{{
					Communication: CommSolarmanV5,
					Label:         "Solarman-V5 (WiFi-Datenlogger, TCP 8899)",
					Fields:        solarmanFields(),
				}},
				// Tier 3: Deye's only control lever is the Time-of-Use window in EEPROM
				// (write-on-change). The register map is bench-pending, so an actual
				// live write is still blocked by the certification allowlist.
				ControlTier: ControlTierToU,
			},
			{
				ID:    BrandGenericModbus,
				Label: "Anderes Modell",
				// Frueher „Anderer Hersteller (Modbus / SunSpec)" - eine PSEUDO-MARKE,
				// die in der Herstellerliste stand, als waere sie ein Fabrikat. Sie ist
				// jetzt der ehrliche Auffang-Eintrag ihres Typs; die Kennung bleibt,
				// weil Bestandsanlagen sie tragen.
				DeviceType: DeviceTypeInverter,
				Note:       "Für jeden Wechselrichter mit SunSpec-/Modbus-TCP-Schnittstelle, dessen Hersteller hier nicht steht.",
				Models: []Model{
					// ⚠ Modell- und Familien-Bezeichnung sind bewusst VERSCHIEDEN: sie
					// hiessen beide „SunSpec (Standard)" und standen damit zweimal
					// gleich im Baum (der Duplikat-Befund des Konzepts). Die Kennung
					// `sunspec` bleibt - sie ist persistiert.
					{ID: FamSunSpec, Label: "SunSpec-kompatibler Wechselrichter", Family: FamSunSpec,
						Note: "Für jeden Wechselrichter mit SunSpec-Registermodell"},
				},
				Families: []Family{
					{ID: FamSunSpec, Label: "SunSpec-Registermodell", Note: "SunSpec-konformes Modbus-Registermodell"},
				},
				Transports: []Transport{{
					Communication: CommModbusTCP,
					Label:         "Modbus TCP (TCP 502)",
					Fields:        modbusFields(),
				}},
				// Tier 1: SunSpec Model 124 / Immediate Controls. The generic SunSpec
				// family is the ONE certified control path (proven against edge/sim).
				ControlTier: ControlTierSunSpec,
			},
			{
				ID:         BrandFronius,
				Label:      "Fronius",
				DeviceType: DeviceTypeInverter,
				Note:       "Fronius-Wechselrichter. Der Verbindungsweg ergibt sich aus dem Modell; unter „Verbindungsweg\" lässt er sich im Ausnahmefall umstellen.",
				Models:     froniusModels(),
				Families:   froniusFamilies(),
				Transports: froniusTransports(),
				// Tier 1: Fronius battery/curtailment control is SunSpec Model 123/124.
				// Uncertified (planned-only until a bench pass); the control adapter is
				// wired via this brand's selection (report §7.9 / froniusControl).
				ControlTier: ControlTierSunSpec,
			},
			{
				ID:    BrandFroniusSunSpec,
				Label: "Fronius",
				// ⚠ VERSTECKTE ALIAS-MARKE (die frueher zweite Fronius-Zeile). Sie wird
				// nicht mehr angeboten, bleibt aber vollstaendig aufloesbar - siehe
				// Brand.Hidden. Inhalt EINGEFROREN.
				Hidden:       true,
				SupersededBy: BrandFronius,
				DeviceType:   DeviceTypeInverter,
				Note:         "Frühere zweite Fronius-Zeile (Auslesen über SunSpec Modbus TCP). Wird nicht mehr angeboten - bestehende Geräte behalten sie unverändert.",
				Models:       froniusSunspecModels(),
				Families:     froniusSunspecFamilies(),
				Transports: []Transport{{
					Communication: CommFroniusSunSpec,
					Label:         "SunSpec Modbus TCP (TCP 502)",
					Fields:        froniusSunspecFields(),
				}},
				// Tier 1: also a SunSpec control surface. Control via this read-brand is
				// not wired in controlRoute today (it routes Fronius control through the
				// Solar-API brand's selection); this read-only brand idles there.
				ControlTier: ControlTierSunSpec,
			},
			{
				ID:         BrandKostal,
				Label:      "KOSTAL",
				DeviceType: DeviceTypeInverter,
				Note:       "KOSTAL PLENTICORE BI (Batterie-Wechselrichter). Modbus muss im Webserver des Wechselrichters aktiviert sein.",
				Models:     kostalModels(),
				Families:   kostalFamilies(),
				Transports: []Transport{{
					Communication: CommKostalModbus,
					Label:         "Modbus TCP (TCP 1502, Unit-ID 71)",
					Fields:        kostalFields(),
				}},
				// Tier 2: the PLENTICORE's external battery management is a true
				// forced-watts RAM setpoint (register 1034) behind the inverter's own
				// configurable watchdog - the vendor external-EMS primitive. The Tier-2
				// control adapter is a separate gated increment (scout report
				// data/vp-kostal-plenticore-s5 §3.3); until then controlRoute's Tier-2
				// stub honestly refuses, and certification stays per-device/First-Light
				// regardless.
				ControlTier: ControlTierVendorEMS,
			},
			{
				ID:         BrandGoe,
				Label:      "go-e",
				DeviceType: DeviceTypeWallbox,
				Note:       "go-e-Wallbox - wird über ihre lokale HTTP-API ausgelesen (nur lesen). Die API muss in der go-e-App aktiviert sein.",
				Models:     goeModels(),
				Families:   goeFamilies(),
				Transports: []Transport{{
					Communication: CommGoeHTTP,
					Label:         "go-e HTTP API v2 (HTTP/JSON)",
					Fields:        goeFields(),
				}},
				// Tier 0 for the inverter control-path: a go-e wallbox is a CONSUMER,
				// controlled by the certified Go core executor (internal/goe), not the
				// Node-RED battery controlRoute.
				ControlTier: ControlTierReadOnly,
			},
			{
				ID:         BrandShelly,
				Label:      "Shelly",
				DeviceType: DeviceTypeSwitch,
				Note:       "Shelly-Relais vor einem Verbraucher (z. B. Heizstab). Generation und Leistungsmessung werden automatisch erkannt.",
				Models:     shellyModels(),
				Families:   shellyFamilies(),
				Transports: []Transport{{
					Communication: CommShellyHTTP,
					Label:         "Shelly HTTP API (lokal)",
					Fields:        shellyFields(),
				}},
				// Tier 0 for the inverter control-path: a Shelly switches a
				// CONSUMER, driven by the core executor (internal/shelly), not
				// the Node-RED battery controlRoute.
				ControlTier: ControlTierReadOnly,
			},
		},
	}
	return resolveCatalog(cat)
}

// resolveCatalog fuellt die ABGELEITETEN Felder des Baums, damit jeder Abnehmer
// (die `:8484`-Seite, der Vorlagen-Export, die Cloud) DENSELBEN aufgeloesten
// Baum sieht statt die Ableitung je Seite nachzubauen:
//
//   - Brand.Communication/CommLabel/Fields spiegeln den VORGABE-Transport
//     (Transports[0]) - die Rueckwaerts-kompatible Sicht einer Marke mit genau
//     einem Weg.
//   - Model.Fields wird NUR bei mehreren Wegen gesetzt (sonst waere es eine
//     Kopie der Marken-Felder je Modell und blaehte den Baum um ein Vielfaches
//     auf): der Vorgabeweg + das Auswahlfeld „Verbindungsweg" davor.
func resolveCatalog(cat Catalog) Catalog {
	for i := range cat.Brands {
		b := &cat.Brands[i]
		if len(b.Transports) == 0 {
			continue
		}
		def := b.Transports[0]
		b.Communication, b.CommLabel, b.Fields = def.Communication, def.Label, def.Fields
		for j := range b.Models {
			m := &b.Models[j]
			if len(m.Transports) < 2 {
				continue
			}
			t, ok := b.transport(m.Transports[0])
			if !ok {
				continue
			}
			m.Fields = append([]Field{transportField(*b, *m)}, t.Fields...)
		}
	}
	return cat
}

// transportField baut das Experten-Auswahlfeld „Verbindungsweg" eines Modells
// mit mehreren Wegen. Es traegt die Beschriftungen der Marke, ist also weiterhin
// vollstaendig datengetrieben - die Oberflaeche kennt keine Marke.
func transportField(b Brand, m Model) Field {
	opts := make([]Opt, 0, len(m.Transports))
	for k, comm := range m.Transports {
		t, ok := b.transport(comm)
		if !ok {
			continue
		}
		label := t.Label
		if k == 0 {
			label += " – üblich für dieses Modell"
		}
		opts = append(opts, Opt{Value: comm, Label: label})
	}
	return Field{
		Key: "transport", Label: "Verbindungsweg", Type: "select", Default: m.Transports[0],
		Help:    "Wird automatisch aus dem Modell abgeleitet. Nur ändern, wenn der übliche Weg auf Ihrem Gerät nicht funktioniert - zum Beispiel bei abgeschalteter Solar API.",
		Options: opts,
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

// transport findet einen Verbindungsweg der Marke.
func (b Brand) transport(comm string) (Transport, bool) {
	for _, t := range b.Transports {
		if t.Communication == comm {
			return t, true
		}
	}
	return Transport{}, false
}

// TransportsFor nennt die Verbindungswege EINES Modells, erster = Vorgabe. Ein
// Modell ohne eigene Angabe erbt die der Marke (der Normalfall: genau einer).
func (b Brand) TransportsFor(m Model) []string {
	if len(m.Transports) > 0 {
		return m.Transports
	}
	out := make([]string, 0, len(b.Transports))
	for _, t := range b.Transports {
		out = append(out, t.Communication)
	}
	return out
}

// DeviceTypeOf ist der Geraetetyp eines Modells: seine eigene Angabe, sonst die
// der Marke.
func (b Brand) DeviceTypeOf(m Model) string {
	if t := strings.TrimSpace(m.DeviceType); t != "" {
		return t
	}
	return b.DeviceType
}

// resolveTransport waehlt den Verbindungsweg eines Modells: den ausdruecklich
// gewuenschten (nur aus der Liste DIESES Modells - ein Weg, den das Modell nicht
// nennt, ist keine Auswahl, sondern ein Fehler) oder den Vorgabeweg.
func (b Brand) resolveTransport(m Model, want string) (Transport, error) {
	allowed := b.TransportsFor(m)
	if len(allowed) == 0 {
		return Transport{}, invalid("Für %s ist kein Verbindungsweg hinterlegt.", b.Label)
	}
	pick := allowed[0]
	if want = strings.TrimSpace(want); want != "" {
		found := false
		for _, c := range allowed {
			if c == want {
				found, pick = true, c
				break
			}
		}
		if !found {
			return Transport{}, invalid("Dieser Verbindungsweg steht für %s nicht zur Verfügung.", m.Label)
		}
	}
	t, ok := b.transport(pick)
	if !ok {
		return Transport{}, invalid("Für %s ist kein Verbindungsweg hinterlegt.", b.Label)
	}
	return t, nil
}

// FieldsFor sind die Formularfelder EINES Modells auf EINEM Weg - genau das, was
// die Oberflaeche rendert, wenn der Kunde den Verbindungsweg umstellt.
func (b Brand) FieldsFor(m Model, comm string) []Field {
	t, err := b.resolveTransport(m, comm)
	if err != nil {
		return b.Fields
	}
	if len(b.TransportsFor(m)) < 2 {
		return t.Fields
	}
	return append([]Field{transportField(b, m)}, t.Fields...)
}

// VisibleBrands sind die Marken, die eine Oberflaeche anbieten darf - die
// versteckten Alias-Marken bleiben aufloesbar, aber unsichtbar.
func (c Catalog) VisibleBrands() []Brand {
	out := make([]Brand, 0, len(c.Brands))
	for _, b := range c.Brands {
		if !b.Hidden {
			out = append(out, b)
		}
	}
	return out
}

// RatedKw returns the nameplate AC power (kW) of the given brand+model, ok=false
// when the model is unknown or has no rating (e.g. the generic SunSpec entry).
// The physical-envelope guard (guards.Envelope) uses this to bound PV and
// battery power regardless of the operator's despike preset.
func (c Catalog) RatedKw(brandID, modelID string) (float64, bool) {
	b, ok := c.brand(strings.TrimSpace(brandID))
	if !ok {
		return 0, false
	}
	m, ok := b.model(strings.TrimSpace(modelID))
	if !ok || m.RatedKw <= 0 {
		return 0, false
	}
	return m.RatedKw, true
}

// FamilyHasBattery reports whether a register-map family models a battery
// (hybrids do; string/micro grid-tie inverters do not). Only battery families
// have a physically-bounded battery charge/discharge, so the envelope's
// derived-battery consistency check applies to them alone.
func FamilyHasBattery(family string) bool {
	switch family {
	case FamHybrid1p, FamHybrid3p, FamKostalPlenticore:
		return true
	default:
		return false
	}
}

// FamilyBatteryless reports whether a register-map family PROVABLY has no
// battery (pure grid-tie generation: Deye string/micro AC output, the Fronius
// Eco SunSpec-live read). For these, "battery power = 0" is a physical fact -
// the Netz-meter house-load balance may treat a missing battery reading as
// zero there. NOT the complement of FamilyHasBattery: families that MAY carry
// a battery without publishing its power in every sample (the generic Modbus
// profile, Fronius Solar API) return false from BOTH - a missing battery
// reading there means "unknown", never a fabricated 0.
func FamilyBatteryless(family string) bool {
	switch family {
	case FamString, FamMicro, FamSunSpecLive:
		return true
	default:
		return false
	}
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

	// InvertControlSign flips the battery-power WRITE direction (charge<->discharge)
	// for the control adapter. It is SEPARATE from InvertGridSign (a READ-path sign):
	// the write sign is firmware-dependent (sunsynk inverts vs ha-solarman raw) and is
	// proven on the real inverter by the First-Light calibration step, never guessed.
	// Read by the Node-RED control adapter (conn.invert_control_sign) on the control
	// transports (solarman_v5 / modbus_tcp / fronius_sunspec).
	InvertControlSign bool `json:"invert_control_sign,omitempty"`

	// ControlWriteFc pins the Modbus WRITE function code the Deye control adapter
	// uses for a control register write: 16 = write-multiple-registers (FC16 / 0x10,
	// the DEFAULT and firmware-robust path), 6 = write-single-register (FC6 / 0x06,
	// the legacy path). Many Deye hybrid firmwares (LSW3/Solarman logger) ACCEPT an
	// FC6 write frame at the transport but the inverter never answers it and the
	// register does not change - the live Pilsting symptom (a 2-byte stub where the
	// FC6 echo belongs). The demonstrably-working Deye integrations (deye-controller,
	// ha-solarman via pysolarmanv5) write every register - even a single one - via
	// FC16, so FC16 is the default for Deye. This is an operator escape hatch mirroring
	// PowerScale/InvertBattSign: 0 = auto (-> FC16 for Deye), 16 explicit, 6 to flip
	// back to FC6 if a different firmware only answers FC6. Solarman-V5 (Deye) only -
	// the SunSpec/Modbus control path always uses its own FC6 register writes. The
	// Node-RED control adapter reads conn.control_write_fc (0/absent -> FC16).
	ControlWriteFc int `json:"control_write_fc,omitempty"`

	// RemoteMode is the operator hatch for the Deye REMOTE-MODE control path
	// (protocol V105.1+ registers 1100-1121: a true signed watt setpoint for the
	// battery, armed behind the inverter's OWN watchdog). "auto" (default/empty) =
	// the edge PROBES the block and uses remote mode when the firmware has it,
	// falling back to the Time-of-Use path when it does not - a Deye firmware update
	// has removed the feature from a user's inverter before and a later one restored
	// it, so it is detected, never assumed. "off" forces the ToU path. Solarman-V5
	// (Deye) only. Read by the Node-RED control adapter as conn.remote_mode.
	RemoteMode string `json:"remote_mode,omitempty"`

	// RemoteWatchdogS is the dead-man's timeout (seconds) written to register 1101
	// while remote mode drives the battery: if VoltPilot goes silent for this long
	// the inverter LEAVES remote mode by itself and reverts to its own behaviour with
	// nothing changed. 0/absent = 60 s (the documented recommendation, ~6 setpoint
	// ticks of slack); the protocol allows 10..18000. It can never be disabled from
	// config - the whole safety argument of this path is that the timer exists.
	RemoteWatchdogS int `json:"remote_watchdog_s,omitempty"`

	// RemoteBatteryStrategy selects the battery-side strategy (register 1105) the Deye
	// REMOTE-MODE control path arms: 0/absent = the DEFAULT "Power only" (2) - the signed
	// setpoint (1109) is the only instruction, NO on-device SoC target in 1108; 5 =
	// "Power + SOC" (opt-in), which additionally writes an on-device SoC belt in 1108.
	// The default flipped to Power because on the live SUN-30K-SG01HP3-EU the 1108 SoC
	// value was driven toward as a TARGET (a ~8x over-delivery on a commanded -1 kW), not
	// as a floor - so strategy 5 + 1108 is a re-testable variant, not the default, and
	// guards.Clamp remains the SoC authority either way (it clamps a charge to 0 at/above
	// SocMax and a discharge to 0 at/below SocMin, every tick). Solarman-V5 (Deye) only.
	// Read by the Node-RED control adapter as conn.remote_battery_strategy (see
	// inverter-control-routing.js resolveDeyeRemoteStrategy).
	RemoteBatteryStrategy int `json:"remote_battery_strategy,omitempty"`

	// InvertBattSign flips the battery-power READ sign so the decoded
	// `battery_power_kw` honors the documented convention (+ charge / - discharge),
	// which the cloud's balance-derived battery_kw and the First-Light verdict both
	// assume. Like InvertGridSign it is a READ-path sign and, per DEYE.md, the raw
	// Deye battery register (0x024E) sign is FIRMWARE-DEPENDENT (the captain's live
	// SUN-30K-SG01HP3-EU HV firmware reports charge as NEGATIVE) - so it is an
	// operator-set escape hatch, NOT a silent universal flip. It is the read-side
	// twin of InvertControlSign (which is the write side). The Node-RED Deye reader
	// already forwards conn.invert_batt_sign into deye/deye-decode.js; this field is
	// what carries it through the self-wiring path (BusPayload below). Solarman-V5
	// (Deye) only - the other transports have no hybrid battery register here.
	InvertBattSign bool `json:"invert_batt_sign,omitempty"`

	// AllowMissingSoc is the NARROW operator opt-in for a battery whose BMS is not
	// coupled to the inverter: the SoC register then reads a permanent, perfectly
	// stable 0 while voltage/current/power are all readable, and the decoder's
	// documented drop-don't-fabricate gate (deye/deye-decode.js socPlausible)
	// discards EVERY sample - so such a plant delivers nothing at all and cannot
	// even be added (live case Muehlfeldweg 2, 21.08.2026).
	//
	// With the opt-in the decoder keeps the reading WITHOUT its soc_pct - never a
	// fabricated 0, so no SoC sample is ever published and the July-2026
	// axis-spike symptom stays structurally impossible - and ONLY for the exact-0
	// value on a demonstrably ALIVE register block. The logger's all-zero empty
	// answer and an out-of-range value still drop the whole read, opt-in or not.
	//
	// It is set by the PORTAL wizard's "Trotzdem fortfahren (nur Lesen)" and
	// travels in the component's connection; there is deliberately no :8484 form
	// field for it (an operator hatch that reads like a normal setting invites
	// switching it on where it does not belong). Solarman-V5 (Deye) only - the
	// other decoders already omit an implausible SoC instead of dropping the read.
	//
	// A plant carrying it is NOT controllable: without a SoC the guards.Clamp SoC
	// window would be blind, so the platform refuses to arm control for it.
	AllowMissingSoc bool `json:"allow_missing_soc,omitempty"`

	// modbus_tcp
	UnitID  int    `json:"unit_id,omitempty"`
	Profile string `json:"profile,omitempty"`

	// shelly_http: the switch/relay output on multi-channel devices (0 = the
	// first). Generation + metering are DETECTED per device (internal/shelly),
	// never configured.
	Channel int `json:"channel,omitempty"`

	// fronius_solar_api (InvertGridSign above is shared as the sign escape hatch)
	InsecureTLS bool `json:"insecure_tls,omitempty"`

	// fronius_sunspec (SunSpec-live over Modbus; reuses UnitID + InvertGridSign).
	// ModelType is an optional hint ("auto"|"float"|"int_sf"); the walker
	// auto-detects, so "auto" is the default.
	ModelType string `json:"model_type,omitempty"`

	// CurtailWriteFc pins the Modbus WRITE function code the Fronius CURTAILMENT
	// adapter uses for the Model-123 limit block. 0/absent = auto = FC16
	// (0x10, write-multiple), the only form Fronius documents for these five
	// registers and the one Victron's production Fronius limiter uses; 6 flips
	// back to the legacy per-register FC6 writes, which were measured at
	// Pilsting (09.08.2026) to be ACCEPTED and then ignored by the Datamanager.
	// The sibling of ControlWriteFc above, for the OTHER control path.
	// Node-RED reads conn.curtail_write_fc (sunspec/model-discovery.js
	// resolveCurtailWriteFc).
	CurtailWriteFc int `json:"curtail_write_fc,omitempty"`

	// Transport ist der EXPERTEN-AUSWEG: der Verbindungsweg, den der Kunde
	// ABWEICHEND vom Vorgabeweg seines Modells waehlt (Captain-Entscheid 3 des
	// Anlegen-Reworks: „Transport automatisch je Modell + Experten-Override").
	//
	// ⚠ Er ist ein reines ANFRAGE-Feld: `Normalize` loest ihn zu
	// `Selection.Communication` auf und LOESCHT ihn danach (die `Channel`-Regel an
	// derselben Stelle). Er wird nie persistiert, nie veroeffentlicht und steht in
	// keinem `BusPayload` - der Verbindungsweg IST `communication`, und zwei
	// Wahrheiten ueber dieselbe Angabe waeren eine zu viel. Beim Wiederanzeigen
	// leitet die Oberflaeche ihn aus `Selection.Communication` ab.
	Transport string `json:"transport,omitempty"`

	// kostal_modbus (reuses IP/Port/UnitID/InvertGridSign/InvertBattSign).
	// ByteOrder is the float word order of the PLENTICORE's two-word registers
	// (device register 5): "auto" (default - read live from the device each
	// cycle), or an explicit "little" (CDAB, the factory default) / "big"
	// (ABCD) override for when the auto-detect cannot be read.
	ByteOrder string `json:"byte_order,omitempty"`
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
	// ControlTier is the brand's battery-control primitive (see ControlTier*),
	// carried through so the Node-RED control adapter can dispatch on it. Purely a
	// dispatch/documentation fact - it never authorises a write on its own.
	ControlTier int `json:"control_tier"`
	// RatedKw is the selected model's catalog nameplate AC power in kW (0 =
	// unknown, e.g. the generic entries). Published so Layer 1 can turn a kW
	// setpoint into a rated-relative register value (Deye remote mode 1109 is
	// 0.1 % of rated; the string/micro active-power limit is a percentage).
	RatedKw float64 `json:"rated_kw,omitempty"`
}

// Normalize validates a request against the catalog and returns the normalized
// Selection (communication + label derived, defaults filled). A validation
// failure is a *ValidationError with a German customer-facing message.
func (c Catalog) Normalize(req SelectionRequest, now time.Time) (Selection, error) {
	b, ok := c.brand(strings.TrimSpace(req.Brand))
	if !ok {
		return Selection{}, invalid("Unbekannte Marke.")
	}

	// Resolve the concrete model -> its TRANSPORT + register-map family + label.
	// Model is the primary selector; a bare Family is accepted for backward
	// compatibility.
	//
	// ⚠ Die Familie folgt bei mehreren Wegen dem WEG, nicht dem Produkt: ein
	// Modell ohne eigenes `Family` erbt das Decode-Profil seines Transports
	// (Fronius/generisch), ein Modell MIT `Family` behaelt seine Registerkarte
	// (Deye/KOSTAL - dort ist sie eine Produkt-Eigenschaft).
	var modelID, registerFamily, typeLabel string
	var ratedKw float64
	transport := Transport{}
	wantTransport := strings.TrimSpace(req.Connection.Transport)
	if m := strings.TrimSpace(req.Model); m != "" {
		mod, ok := b.model(m)
		if !ok {
			return Selection{}, invalid("Bitte wählen Sie ein gültiges Modell für %s.", b.Label)
		}
		t, err := b.resolveTransport(mod, wantTransport)
		if err != nil {
			return Selection{}, err
		}
		transport = t
		modelID = mod.ID
		registerFamily = mod.Family
		if registerFamily == "" {
			registerFamily = t.Family
		}
		typeLabel = mod.Label
		ratedKw = mod.RatedKw
	} else if fID := strings.TrimSpace(req.Family); fID != "" {
		fam, ok := b.family(fID)
		if !ok {
			return Selection{}, invalid("Bitte wählen Sie einen gültigen Typ für %s.", b.Label)
		}
		registerFamily = fam.ID
		typeLabel = fam.Label
		// Eine reine Familien-Anfrage (aelterer Client / Integration) waehlt den
		// Weg, dessen Decode-Profil sie nennt - sonst den Vorgabeweg der Marke.
		transport = b.Transports[0]
		for _, t := range b.Transports {
			if t.Family == fam.ID {
				transport = t
				break
			}
		}
	} else {
		return Selection{}, invalid("Bitte wählen Sie ein Modell für %s.", b.Label)
	}
	if registerFamily == "" {
		return Selection{}, invalid("Für %s ist kein Registerprofil hinterlegt.", b.Label)
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
		Communication: transport.Communication,
		UpdatedAt:     now.UTC(),
		ControlTier:   b.ControlTier,
		RatedKw:       ratedKw,
	}

	// Der gewaehlte Weg IST `sel.Communication` - das Anfrage-Feld hat seine
	// Aufgabe erfuellt und wird hier geloescht (siehe Connection.Transport).
	conn.Transport = ""

	// The Shelly switch channel belongs to shelly_http only (cleared here
	// once instead of per-case; the shelly case validates it below).
	if transport.Communication != CommShellyHTTP {
		conn.Channel = 0
	}

	// The Deye SoC-gate opt-in belongs to the Solarman read path and nowhere else:
	// only deye-decode drops a WHOLE reading over an implausible SoC, every other
	// decoder simply omits the channel. Cleared here once (the Channel pattern
	// above) so a transport added later cannot silently inherit it.
	if transport.Communication != CommSolarmanV5 {
		conn.AllowMissingSoc = false
	}

	switch transport.Communication {
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
		// 0 = auto-detect the LV/HV scale from the device register 0x0000 (the
		// default); 1 or 10 is a manual override. See deye/deye-decode.js.
		if conn.PowerScale != 0 && conn.PowerScale != 1 && conn.PowerScale != 10 {
			return Selection{}, invalid("Die Leistungsskalierung muss automatisch (0), 1 oder 10 sein.")
		}
		// 0 = auto (-> FC16, the default), 16 = FC16, 6 = FC6. See the ControlWriteFc
		// doc: Deye firmwares commonly ignore an FC6 write, so FC16 is the default and
		// FC6 is the flip-back escape hatch. The Node-RED control adapter reads it.
		if conn.ControlWriteFc != 0 && conn.ControlWriteFc != 6 && conn.ControlWriteFc != 16 {
			return Selection{}, invalid("Der Schreib-Funktionscode muss automatisch (0), 16 oder 6 sein.")
		}
		// Remote mode (registers 1100-1121): "auto" (the default) probes the device,
		// "off" forces the Time-of-Use path. See Connection.RemoteMode.
		switch strings.TrimSpace(conn.RemoteMode) {
		case "", "auto":
			conn.RemoteMode = "auto"
		case "off":
			// explicit opt-out, keep as-is
		default:
			return Selection{}, invalid("Die Fernsteuerung muss automatisch oder aus sein.")
		}
		// 0 = the documented 60 s default; anything else must be inside the protocol's
		// [10, 18000] s range. It can never be turned off from config.
		if conn.RemoteWatchdogS != 0 && (conn.RemoteWatchdogS < 10 || conn.RemoteWatchdogS > 18000) {
			return Selection{}, invalid("Der Totmannschalter der Fernsteuerung muss zwischen 10 und 18000 Sekunden liegen.")
		}
		// 0 = the default "Power only" battery-side strategy (register 1105 <- 2), no
		// on-device SoC target; 5 = the opt-in "Power + SOC" strategy that also writes an
		// on-device SoC belt in 1108. See Connection.RemoteBatteryStrategy. The Node-RED
		// control adapter reads it (0/anything but 5 -> Power).
		if conn.RemoteBatteryStrategy != 0 && conn.RemoteBatteryStrategy != 5 {
			return Selection{}, invalid("Die Batterie-Strategie der Fernsteuerung muss „Nur Leistung\" (0) oder „Leistung + SoC-Grenze\" (5) sein.")
		}
		// fields of the other transports are not part of this one.
		conn.UnitID, conn.Profile, conn.InsecureTLS, conn.ModelType = 0, "", false, ""
		conn.CurtailWriteFc = 0 // the Fronius curtailment write-FC is not part of this transport
		conn.ByteOrder = ""
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
		// fields of the other transports are not part of this one.
		conn.Serial, conn.MbSlaveID, conn.InvertGridSign, conn.PowerScale, conn.InsecureTLS, conn.ModelType = "", 0, false, 0, false, ""
		conn.InvertBattSign = false // the Deye read-side battery sign is not part of this transport
		conn.ControlWriteFc = 0     // the Deye control write-FC is not part of this transport
		conn.CurtailWriteFc = 0     // the Fronius curtailment write-FC is not part of this transport
		conn.RemoteMode, conn.RemoteWatchdogS, conn.RemoteBatteryStrategy = "", 0, 0
		conn.ByteOrder = ""
	case CommFroniusSolarAPI:
		// The Solar API (HTTP/JSON) needs only host + port; no serial, unit id or
		// auth. `insecure_tls` and `invert_grid_sign` (shared) are the only extras.
		if conn.Port == 0 {
			conn.Port = defaultFroniusPort
		}
		// fields of the other transports are not part of this one (Fronius Solar API
		// is read-only, so the control sign is meaningless here).
		conn.Serial, conn.MbSlaveID, conn.PowerScale, conn.ModelType = "", 0, 0, ""
		conn.UnitID, conn.Profile, conn.InvertControlSign, conn.InvertBattSign = 0, "", false, false
		conn.ControlWriteFc = 0
		conn.CurtailWriteFc = 0 // the Fronius curtailment write-FC is not part of this transport
		conn.RemoteMode, conn.RemoteWatchdogS, conn.RemoteBatteryStrategy = "", 0, 0
		conn.ByteOrder = ""
	case CommFroniusSunSpec:
		// Real SunSpec over Modbus TCP: host + unit id + an optional model-type
		// hint + the grid-sign escape hatch. The register-map profile is the single
		// sunspec_live family (discovery is dynamic). model_type "auto" (default)
		// lets the walker classify float vs int+SF.
		if conn.Port == 0 {
			conn.Port = defaultFroniusSunSpecPort
		}
		if conn.UnitID == 0 {
			conn.UnitID = 1
		}
		if conn.UnitID < 1 || conn.UnitID > 247 {
			return Selection{}, invalid("Die Modbus-Unit-ID muss zwischen 1 und 247 liegen.")
		}
		switch conn.ModelType {
		case "", "auto":
			conn.ModelType = "auto"
		case "float", "int_sf":
			// explicit override, keep as-is
		default:
			return Selection{}, invalid("Der SunSpec-Modelltyp muss automatisch, float oder int_sf sein.")
		}
		// 0 = auto (-> FC16, the default), 16 = FC16, 6 = FC6. See CurtailWriteFc.
		if conn.CurtailWriteFc != 0 && conn.CurtailWriteFc != 6 && conn.CurtailWriteFc != 16 {
			return Selection{}, invalid("Der Schreib-Funktionscode der Abregelung muss automatisch, FC16 oder FC6 sein.")
		}
		conn.Profile = registerFamily // sunspec_live
		// fields of the other transports are not part of this one.
		conn.Serial, conn.MbSlaveID, conn.PowerScale, conn.InsecureTLS = "", 0, 0, false
		conn.InvertBattSign = false // the Deye read-side battery sign is not part of this transport
		conn.ControlWriteFc = 0     // the Deye control write-FC is not part of this transport
		conn.RemoteMode, conn.RemoteWatchdogS, conn.RemoteBatteryStrategy = "", 0, 0
		conn.ByteOrder = ""
	case CommKostalModbus:
		// KOSTAL PLENTICORE vendor Modbus server: port 1502 / Unit-ID 71 factory
		// defaults (both device-changeable), float byte order "auto" = read live
		// from device register 5 each cycle ("little" CDAB is the factory
		// setting; an explicit value overrides for an unreadable register 5).
		if conn.Port == 0 {
			conn.Port = defaultKostalPort
		}
		if conn.UnitID == 0 {
			conn.UnitID = defaultKostalUnitID
		}
		if conn.UnitID < 1 || conn.UnitID > 247 {
			return Selection{}, invalid("Die Modbus-Unit-ID muss zwischen 1 und 247 liegen.")
		}
		switch conn.ByteOrder {
		case "", "auto":
			conn.ByteOrder = "auto"
		case "little", "big":
			// explicit override, keep as-is
		default:
			return Selection{}, invalid("Die Byte-Reihenfolge muss automatisch, little oder big sein.")
		}
		conn.Profile = registerFamily // kostal_plenticore
		// fields of the other transports are not part of this one. InvertControlSign
		// is kept: it is the shared WRITE-path sign the future Tier-2 control
		// adapter reads (the modbus_tcp precedent).
		conn.Serial, conn.MbSlaveID, conn.PowerScale, conn.InsecureTLS, conn.ModelType = "", 0, 0, false, ""
		conn.ControlWriteFc = 0
		conn.CurtailWriteFc = 0 // the Fronius curtailment write-FC is not part of this transport
		conn.RemoteMode, conn.RemoteWatchdogS, conn.RemoteBatteryStrategy = "", 0, 0
	case CommGoeHTTP:
		// go-e HTTP API v2: host + port only. No serial, unit id, auth or sign
		// escape hatch (charging power is unsigned load).
		if conn.Port == 0 {
			conn.Port = defaultGoePort
		}
		// fields of the other transports are not part of this one (go-e is a read-only
		// consumer source, no control sign).
		conn.Serial, conn.MbSlaveID, conn.InvertGridSign, conn.PowerScale = "", 0, false, 0
		conn.UnitID, conn.Profile, conn.InsecureTLS, conn.ModelType = 0, "", false, ""
		conn.InvertControlSign, conn.InvertBattSign = false, false
		conn.ControlWriteFc = 0
		conn.CurtailWriteFc = 0 // the Fronius curtailment write-FC is not part of this transport
		conn.RemoteMode, conn.RemoteWatchdogS, conn.RemoteBatteryStrategy = "", 0, 0
		conn.ByteOrder = ""
	case CommShellyHTTP:
		// Shelly local HTTP: host + port + switch channel. Generation dialect
		// and metering are DETECTED by the core (internal/shelly), never
		// configured; no serial/unit id/sign hatch.
		if conn.Port == 0 {
			conn.Port = defaultShellyPort
		}
		if conn.Channel < 0 || conn.Channel > 3 {
			return Selection{}, invalid("Der Schaltkanal muss zwischen 0 und 3 liegen.")
		}
		conn.Serial, conn.MbSlaveID, conn.InvertGridSign, conn.PowerScale = "", 0, false, 0
		conn.UnitID, conn.Profile, conn.InsecureTLS, conn.ModelType = 0, "", false, ""
		conn.InvertControlSign, conn.InvertBattSign = false, false
		conn.ControlWriteFc = 0
		conn.CurtailWriteFc = 0
		conn.RemoteMode, conn.RemoteWatchdogS, conn.RemoteBatteryStrategy = "", 0, 0
		conn.ByteOrder = ""
	default:
		return Selection{}, invalid("Unbekannte Kommunikationsmethode.")
	}

	sel.Connection = conn
	return sel, nil
}

// Backfill re-derives the CATALOG-owned metadata of a PERSISTED selection - the
// model's nameplate (RatedKw) and the brand's control primitive (ControlTier) -
// WITHOUT touching any operator-owned setting (the connection fields ip/port/
// serial/slave/invert_*/power_scale/control_write_fc, the label, family, model id,
// communication or updated_at all survive byte-identical). It re-derives strictly
// from the catalog by brand+model.
//
// Why it exists: a selection persisted before those fields were added (RatedKw
// #248, ControlTier #238) reloads with them at 0, and the retained
// edge/inverter/config the agent re-publishes on boot then carries rated_kw:0 /
// control_tier:0. The Deye REMOTE-MODE setpoint is 0.1 % of the nameplate, so an
// unknown rating makes the control adapter refuse every tick (deyeRemoteControl's
// `if (!(ratedKw > 0))` guard) - the exact live-pilot symptom. Backfilling on load
// fixes every existing field device with no operator "re-save the inverter" step.
//
// changed=true when a field was actually filled or corrected (so the caller can
// re-persist + log once). resolved=false when brand+model no longer resolve in the
// catalog - the selection is then returned BYTE-IDENTICAL (a renamed/removed model
// must never have its metadata silently cleared; the caller logs instead).
func (c Catalog) Backfill(sel Selection) (out Selection, changed bool, resolved bool) {
	b, ok := c.brand(strings.TrimSpace(sel.Brand))
	if !ok {
		return sel, false, false
	}
	// RatedKw comes from the concrete MODEL. A legacy family-only selection (no
	// model) has no rating to derive - that is correct, not a failure, so it still
	// resolves and ControlTier is backfilled from the brand.
	if mID := strings.TrimSpace(sel.Model); mID != "" {
		if _, mok := b.model(mID); !mok {
			// Brand known but the model was renamed/removed: leave EVERYTHING
			// untouched (the "brand+model no longer resolve" case).
			return sel, false, false
		}
	}
	out = sel
	if out.ControlTier != b.ControlTier {
		out.ControlTier = b.ControlTier
		changed = true
	}
	if mID := strings.TrimSpace(sel.Model); mID != "" {
		m, _ := b.model(mID) // presence verified above
		if out.RatedKw != m.RatedKw {
			out.RatedKw = m.RatedKw
			changed = true
		}
	}
	return out, changed, true
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
		// invert_batt_sign is the READ-path battery sign (firmware-dependent per
		// DEYE.md): with it the decoded battery_power_kw honors the documented
		// + charge / - discharge convention the balance-derived battery_kw and the
		// First-Light verdict assume. The Deye reader already forwards it into
		// deye/deye-decode.js; publishing it here is what lets the SELF-WIRING path
		// carry it (without this the field was unreachable and every self-wired Deye
		// used the raw register sign, inverted on the captain's HV firmware). Absent
		// = false.
		conn["invert_batt_sign"] = s.Connection.InvertBattSign
		// allow_missing_soc is the narrow "the BMS reports no SoC" opt-in. It must
		// reach the DECODER (that is where the plausibility gate lives), so it rides
		// the retained config into the self-wiring reader exactly like
		// invert_batt_sign. Absent = false = the unchanged drop rule.
		conn["allow_missing_soc"] = s.Connection.AllowMissingSoc
		conn["power_scale"] = s.Connection.PowerScale
		// invert_control_sign is the WRITE-path sign the calibration step proves; the
		// Deye control adapter reads it. Absent = false (no inversion).
		conn["invert_control_sign"] = s.Connection.InvertControlSign
		// control_write_fc is the Modbus WRITE function code the Deye control adapter
		// uses (0/absent -> FC16, the firmware-robust default; 6 flips back to FC6).
		// Publishing it here is what lets the SELF-WIRING path carry it (like
		// invert_batt_sign) - without it every self-wired Deye would fall back to the
		// adapter's own FC16 default with no way to flip back. See ControlWriteFc.
		conn["control_write_fc"] = s.Connection.ControlWriteFc
		// remote_mode / remote_watchdog_s drive the Tier-2 REMOTE-MODE control path
		// (registers 1100-1121). "auto" = probe the device; "off" = force ToU. The
		// watchdog is the inverter's own dead-man's switch (0 -> the adapter's 60 s
		// default). Publishing them here is what lets the SELF-WIRING path carry them.
		conn["remote_mode"] = s.Connection.RemoteMode
		conn["remote_watchdog_s"] = s.Connection.RemoteWatchdogS
		// remote_battery_strategy selects the remote-mode battery-side strategy (1105):
		// 0/absent = "Power only" (2, the default - no on-device 1108 target), 5 = the
		// opt-in "Power + SOC" belt. Publishing it here is what lets the SELF-WIRING path
		// carry it (like remote_mode) - without it a self-wired Deye always used the
		// adapter default. See Connection.RemoteBatteryStrategy.
		conn["remote_battery_strategy"] = s.Connection.RemoteBatteryStrategy
	case CommModbusTCP:
		conn["unit_id"] = s.Connection.UnitID
		conn["profile"] = s.Connection.Profile
		conn["invert_control_sign"] = s.Connection.InvertControlSign
	case CommFroniusSolarAPI:
		conn["insecure_tls"] = s.Connection.InsecureTLS
		conn["invert_grid_sign"] = s.Connection.InvertGridSign
	case CommFroniusSunSpec:
		conn["unit_id"] = s.Connection.UnitID
		conn["profile"] = s.Connection.Profile
		conn["model_type"] = s.Connection.ModelType
		conn["invert_grid_sign"] = s.Connection.InvertGridSign
		conn["invert_control_sign"] = s.Connection.InvertControlSign
	case CommKostalModbus:
		conn["unit_id"] = s.Connection.UnitID
		conn["profile"] = s.Connection.Profile
		// byte_order: the float word order of the PLENTICORE's two-word registers
		// ("auto" = read device register 5 live each cycle; the reader needs it).
		conn["byte_order"] = s.Connection.ByteOrder
		conn["invert_grid_sign"] = s.Connection.InvertGridSign
		// invert_batt_sign: READ-path battery sign hatch (the BusPayload lesson of
		// fm/vp-deye-sign-fix-v6 - a hatch that is not published never reaches the
		// self-wiring reader).
		conn["invert_batt_sign"] = s.Connection.InvertBattSign
		// invert_control_sign: the WRITE-path sign the future Tier-2 control
		// adapter reads (published now so the control increment is JS-side only).
		conn["invert_control_sign"] = s.Connection.InvertControlSign
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
		// `control_tier` is the battery-control primitive the Node-RED controlRoute
		// dispatches on (additive; controlRoute falls back to communication-inference
		// when it is absent, so an older core stays byte-compatible).
		"control_tier": s.ControlTier,
		// `rated_kw` is the selected MODEL's catalog nameplate (kW), 0 when unknown.
		// The WRITE side needs it: the Deye remote-mode setpoint is 0.1 % of RATED
		// power and the string/micro active-power limit is a percentage of it, so
		// without it the control adapter refuses rather than guessing a rating.
		"rated_kw":   s.RatedKw,
		"connection": conn,
		"updated_at": s.UpdatedAt.UTC().Format(time.RFC3339),
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
