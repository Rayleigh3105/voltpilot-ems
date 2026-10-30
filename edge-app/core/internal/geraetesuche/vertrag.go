// Package geraetesuche is the box half of the CONTRACT of the device search
// (Gerätesuche, docs/contracts/v2/mqtt-geraetesuche.md; shared vectors
// docs/contracts/v2/geraetesuche-vectors.json; Java twin services/api
// .../geraetesuche): the order the cloud sends, the progress and the result the
// box sends, the vocabularies and the catalog of recognisers.
//
// It holds no search. LiesAuftrag reads an order TOLERANTLY (unknown fields and
// recogniser names are skipped - a newer cloud must not break an older box);
// Stand.Pruefe and Ergebnis.Pruefe check STRICTLY what the box is about to send
// (the box never sends what the schema refuses). Pure: no clock, no bus, no
// MQTT, no network.
package geraetesuche

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

// The three topic leaves under ems/{tenant}/{site}/{device}/v2/.
const (
	TopicAuftrag  = "geraetesuche"
	TopicStand    = "geraetesuche-stand"
	TopicErgebnis = "geraetesuche-ergebnis"
)

// SchemaVersion of all three messages.
const SchemaVersion = "1.0"

// The limits of the contract (grenzen in the vectors). The box sets them
// itself; no order can widen them.
const (
	Frist        = 120 * time.Second // gueltig_bis is at most ausgeloest_am + 120 s
	StandTakt    = 2 * time.Second
	MaxDauer     = 180 * time.Second
	MaxJeStunde  = 6
	MaxNetze     = 2
	MaxPraefix   = 24
	MaxFunde     = 256
	MaxMerkmale  = 8
	KeineAntwort = 30 * time.Second // the cloud's patience without a progress message
)

// Erkenner is the closed vocabulary of recognisers and ways, in contract order.
var Erkenner = []string{"solarman", "shelly", "goe", "netztechnik", "modbus_offen", "sunspec",
	"fronius_solar_api", "kaco_aiswei", "kostal", "huawei", "sma", "victron", "opendtu_ahoy", "ebyte", "wago",
	"mdns", "ssdp", "funkmodul"}

// Wege are recognisers that produce no find of their own (multicast and the
// neighbours' MAC addresses): they only run on Edge Light.
var Wege = []string{"mdns", "ssdp", "funkmodul"}

// Box types as the catalog names them.
const (
	BoxArtDocker    = "docker"
	BoxArtEdgeLight = "edge_light"
)

// Words of a find.
const (
	AnbindungUebernehmen       = "uebernehmen"
	AnbindungSelbstBeschreiben = "selbst_beschreiben"
	AnbindungNichtMitDieserBox = "nicht_mit_dieser_box"
	AnbindungKeinLeseweg       = "kein_leseweg"
	AnbindungNurAnzeige        = "nur_anzeige"

	ErkennungSicher         = "sicher"
	ErkennungWahrscheinlich = "wahrscheinlich"
	ErkennungUnbekannt      = "unbekannt"
)

var (
	Arten            = []string{"wechselrichter", "wallbox", "schaltaktor", "zaehler", "io_modul", "sps", "dtu", "modbus_geraet", "router", "zugangspunkt"}
	NetztechnikArten = []string{"router", "zugangspunkt"}
	Anbindungen      = []string{AnbindungUebernehmen, AnbindungSelbstBeschreiben, AnbindungNichtMitDieserBox, AnbindungKeinLeseweg, AnbindungNurAnzeige}
	Erkennungen      = []string{ErkennungSicher, ErkennungWahrscheinlich, ErkennungUnbekannt}
	Hindernisse      = []string{"geschuetzt", "lokale_api_aus"}
	Communications   = []string{"solarman_v5", "shelly_http", "goe_http_api", "fronius_solar_api", "fronius_sunspec", "sunspec_tcp", "kaco_http", "kostal_modbus", "huawei_modbus", "ebyte_modbus_tcp", "modbus_tcp"}
	Schritte         = []string{"netze_bestimmen", "nachbarn_finden", "geraete_ansprechen", "geraete_erkennen"}
	Rollen           = []string{"kundennetz", "box_netz"}
	Zustaende        = []string{"fertig", "abgebrochen", "fehlgeschlagen", "abgelehnt"}
)

// Gruende maps each result state to the reasons it may carry; fertig carries none.
var Gruende = map[string][]string{
	"fertig":         {},
	"abgebrochen":    {"auf_wunsch", "neustart", "zeitlimit"},
	"abgelehnt":      {"laeuft_schon", "zu_oft", "abgelaufen", "lan_host_fehlt", "kein_privates_netz"},
	"fehlgeschlagen": {"interner_fehler"},
}

// KatalogZeile is one pair (erkenner, art) of the recognition catalog: the
// communication of the component template ("" = no VoltPilot reader) and the
// anbindung each box type reports ("" = the pair does not occur there).
type KatalogZeile struct {
	Erkenner, Art string
	Schnitt       int
	Communication string
	Docker        string
	EdgeLight     string
}

// Katalog is erkennungskatalog of the vectors (the test pins both together).
var Katalog = []KatalogZeile{
	{"solarman", "wechselrichter", 1, "solarman_v5", AnbindungUebernehmen, AnbindungUebernehmen},
	{"shelly", "schaltaktor", 1, "shelly_http", AnbindungUebernehmen, AnbindungUebernehmen},
	{"shelly", "zaehler", 2, "", AnbindungKeinLeseweg, AnbindungKeinLeseweg},
	{"goe", "wallbox", 1, "goe_http_api", AnbindungUebernehmen, AnbindungUebernehmen},
	{"netztechnik", "router", 1, "", AnbindungNurAnzeige, AnbindungNurAnzeige},
	{"netztechnik", "zugangspunkt", 1, "", AnbindungNurAnzeige, AnbindungNurAnzeige},
	{"modbus_offen", "modbus_geraet", 1, "modbus_tcp", AnbindungSelbstBeschreiben, AnbindungSelbstBeschreiben},
	{"sunspec", "wechselrichter", 2, "sunspec_tcp", AnbindungUebernehmen, AnbindungNichtMitDieserBox},
	{"fronius_solar_api", "wechselrichter", 2, "fronius_solar_api", AnbindungUebernehmen, AnbindungNichtMitDieserBox},
	{"kaco_aiswei", "wechselrichter", 2, "kaco_http", AnbindungUebernehmen, AnbindungNichtMitDieserBox},
	{"kostal", "wechselrichter", 2, "kostal_modbus", AnbindungUebernehmen, AnbindungNichtMitDieserBox},
	{"huawei", "wechselrichter", 2, "huawei_modbus", AnbindungUebernehmen, AnbindungNichtMitDieserBox},
	{"sma", "wechselrichter", 2, "", AnbindungKeinLeseweg, AnbindungKeinLeseweg},
	{"sma", "zaehler", 2, "", "", AnbindungKeinLeseweg},
	{"victron", "wechselrichter", 2, "", AnbindungKeinLeseweg, AnbindungKeinLeseweg},
	{"opendtu_ahoy", "dtu", 2, "", AnbindungKeinLeseweg, AnbindungKeinLeseweg},
	{"ebyte", "io_modul", 2, "ebyte_modbus_tcp", AnbindungUebernehmen, AnbindungUebernehmen},
	{"wago", "sps", 2, "modbus_tcp", AnbindungUebernehmen, AnbindungNichtMitDieserBox},
}

// KatalogPaar returns the row of (erkenner, art), or false.
func KatalogPaar(erkenner, art string) (KatalogZeile, bool) {
	for _, z := range Katalog {
		if z.Erkenner == erkenner && z.Art == art {
			return z, true
		}
	}
	return KatalogZeile{}, false
}

// Anbindung is what boxArt reports for the row ("" = the pair does not occur there).
func (z KatalogZeile) Anbindung(boxArt string) string {
	if boxArt == BoxArtEdgeLight {
		return z.EdgeLight
	}
	return z.Docker
}

var (
	uuidMuster       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	schluesselMuster = regexp.MustCompile(`^[a-z0-9_]{1,32}:[A-Za-z0-9._:-]{1,96}$`)
	herstellerMuster = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	seriennrMuster   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$`)
	familieMuster    = regexp.MustCompile(`^[a-z0-9][a-z0-9_]{0,31}$`)
	merkmalMuster    = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)
)

// Topic is ems/{tenant}/{site}/{device}/v2/{leaf}.
func Topic(tenant, site, device, leaf string) string {
	return "ems/" + tenant + "/" + site + "/" + device + "/v2/" + leaf
}

// ---------------------------------------------------------------- Auftrag

// Auftrag is an order from the cloud. GueltigBis is set only for starten.
// Erkenner nil = run every recogniser the box has; otherwise the cloud narrows
// to these (unknown names already skipped - empty then means none).
type Auftrag struct {
	SchemaVersion string     `json:"schema_version"`
	TenantID      string     `json:"tenant_id"`
	SiteID        string     `json:"site_id"`
	DeviceID      string     `json:"device_id"`
	Aktion        string     `json:"aktion"`
	SuchID        string     `json:"such_id"`
	AusgeloestAm  time.Time  `json:"ausgeloest_am"`
	GueltigBis    *time.Time `json:"gueltig_bis,omitempty"`
	Erkenner      []string   `json:"erkenner,omitempty"`
	AusgeloestVon string     `json:"ausgeloest_von,omitempty"`
}

// ErrAuftrag marks an order the box drops (silently towards the broker).
var ErrAuftrag = errors.New("geraetesuche: auftrag verworfen")

// LiesAuftrag reads an order from its topic and payload. Identity, version,
// action and deadline are checked; unknown fields and recogniser names are
// skipped. Whether the box is the addressee (topic = own identity) and whether
// the deadline has passed (Beginnbar) are the caller's.
func LiesAuftrag(topic string, payload []byte) (Auftrag, error) {
	teile := strings.Split(topic, "/")
	if len(teile) != 6 || teile[0] != "ems" || teile[4] != "v2" || teile[5] != TopicAuftrag {
		return Auftrag{}, fmt.Errorf("%w: topic %q", ErrAuftrag, topic)
	}
	var wire struct {
		Auftrag
		GueltigBis *time.Time `json:"gueltig_bis"`
		Erkenner   *[]string  `json:"erkenner"`
	}
	if err := json.Unmarshal(payload, &wire); err != nil {
		return Auftrag{}, fmt.Errorf("%w: %v", ErrAuftrag, err)
	}
	a := wire.Auftrag
	a.GueltigBis, a.Erkenner = nil, nil
	switch {
	case a.SchemaVersion != SchemaVersion:
		return Auftrag{}, fmt.Errorf("%w: schema_version %q", ErrAuftrag, a.SchemaVersion)
	case a.TenantID != teile[1] || a.SiteID != teile[2] || a.DeviceID != teile[3]:
		return Auftrag{}, fmt.Errorf("%w: identity differs from the topic", ErrAuftrag)
	case !uuidMuster.MatchString(a.TenantID) || !uuidMuster.MatchString(a.SiteID) ||
		!uuidMuster.MatchString(a.DeviceID) || !uuidMuster.MatchString(a.SuchID):
		return Auftrag{}, fmt.Errorf("%w: identity is not a uuid", ErrAuftrag)
	case a.AusgeloestAm.IsZero():
		return Auftrag{}, fmt.Errorf("%w: ausgeloest_am missing", ErrAuftrag)
	case len(a.AusgeloestVon) > 200:
		return Auftrag{}, fmt.Errorf("%w: ausgeloest_von too long", ErrAuftrag)
	}
	switch a.Aktion {
	case "abbrechen":
		return a, nil // a cancel never expires and narrows nothing
	case "starten":
	default:
		return Auftrag{}, fmt.Errorf("%w: aktion %q", ErrAuftrag, a.Aktion)
	}
	if wire.GueltigBis == nil {
		return Auftrag{}, fmt.Errorf("%w: starten without gueltig_bis", ErrAuftrag)
	}
	if frist := wire.GueltigBis.Sub(a.AusgeloestAm); frist <= 0 || frist > Frist {
		return Auftrag{}, fmt.Errorf("%w: deadline %s outside (0, %s]", ErrAuftrag, frist, Frist)
	}
	a.GueltigBis = wire.GueltigBis
	if wire.Erkenner != nil {
		if len(*wire.Erkenner) == 0 {
			return Auftrag{}, fmt.Errorf("%w: empty erkenner", ErrAuftrag)
		}
		a.Erkenner = []string{}
		for _, e := range *wire.Erkenner {
			if enthaelt(Erkenner, e) && !enthaelt(a.Erkenner, e) {
				a.Erkenner = append(a.Erkenner, e)
			}
		}
	}
	return a, nil
}

// Beginnbar: a start order may still begin at jetzt (until gueltig_bis
// inclusive). A redelivered order is already expired on arrival.
func (a Auftrag) Beginnbar(jetzt time.Time) bool {
	return a.Aktion == "starten" && a.GueltigBis != nil && !jetzt.After(*a.GueltigBis)
}

// ---------------------------------------------------------------- Stand, Ergebnis

// Netz is one network of the search (range rule of lan-range-vectors.json).
type Netz struct {
	Rolle      string `json:"rolle"`
	Netz       string `json:"netz"`
	BoxAdresse string `json:"box_adresse"`
	Ausschnitt *bool  `json:"ausschnitt,omitempty"`
	Erreichbar bool   `json:"erreichbar"`
	Aktiv      int    `json:"aktiv"`
}

// Verbindung carries the connection in the keys of the component templates.
type Verbindung struct {
	Communication string  `json:"communication,omitempty"`
	IP            string  `json:"ip"`
	Port          int     `json:"port"`
	Serial        *uint32 `json:"serial,omitempty"`
	UnitID        *int    `json:"unit_id,omitempty"`
}

// Fund is an energy device or a piece of network gear. There is deliberately
// no field for a MAC address, a hostname or a device name (DP-3 A).
type Fund struct {
	Schluessel    string     `json:"schluessel"`
	Erkenner      string     `json:"erkenner"`
	Art           string     `json:"art"`
	Hersteller    string     `json:"hersteller,omitempty"`
	Modell        string     `json:"modell,omitempty"`
	Seriennummer  string     `json:"seriennummer,omitempty"`
	Firmware      string     `json:"firmware,omitempty"`
	Familie       string     `json:"familie,omitempty"`
	Spannung      string     `json:"spannung,omitempty"`
	Kanaele       int        `json:"kanaele,omitempty"`
	Erkennung     string     `json:"erkennung"`
	Merkmale      []string   `json:"merkmale"`
	Anbindung     string     `json:"anbindung"`
	Hindernis     string     `json:"hindernis,omitempty"`
	Verbindung    Verbindung `json:"verbindung"`
	LiestBoxSchon bool       `json:"liest_box_schon"`
}

// Weitere counts what is neither an energy device nor network gear - only as
// a number per kind (DP-3 A). nil = not counted.
type Weitere struct {
	TelefonTablet *int `json:"telefon_tablet,omitempty"`
	Rechner       *int `json:"rechner,omitempty"`
	Unbekannt     *int `json:"unbekannt,omitempty"`
}

// Stand is the progress message (display only; the result is binding).
type Stand struct {
	SchemaVersion string    `json:"schema_version"`
	TenantID      string    `json:"tenant_id"`
	SiteID        string    `json:"site_id"`
	DeviceID      string    `json:"device_id"`
	SuchID        string    `json:"such_id"`
	Nr            int       `json:"nr"`
	Ts            time.Time `json:"ts"`
	Schritt       string    `json:"schritt"`
	Erledigt      int       `json:"erledigt"`
	Gesamt        int       `json:"gesamt"`
	RestS         *int      `json:"rest_s,omitempty"`
	Netze         []Netz    `json:"netze"`
	Funde         []Fund    `json:"funde"`
}

// Ergebnis is the one result of a search.
type Ergebnis struct {
	SchemaVersion string    `json:"schema_version"`
	TenantID      string    `json:"tenant_id"`
	SiteID        string    `json:"site_id"`
	DeviceID      string    `json:"device_id"`
	SuchID        string    `json:"such_id"`
	Ts            time.Time `json:"ts"`
	Zustand       string    `json:"zustand"`
	Grund         string    `json:"grund,omitempty"`
	DauerMs       int       `json:"dauer_ms"`
	Erkenner      []string  `json:"erkenner"`
	Netze         []Netz    `json:"netze"`
	Funde         []Fund    `json:"funde"`
	Weitere       Weitere   `json:"weitere"`
}

// Pruefe checks a progress message strictly before the box of type boxArt sends it.
func (s Stand) Pruefe(boxArt string) error {
	if err := pruefeKopf(s.SchemaVersion, s.TenantID, s.SiteID, s.DeviceID, s.SuchID, s.Ts); err != nil {
		return err
	}
	switch {
	case s.Nr < 1:
		return errors.New("nr below 1")
	case !enthaelt(Schritte, s.Schritt):
		return fmt.Errorf("schritt %q", s.Schritt)
	case s.Erledigt < 0 || s.Gesamt < 0 || s.Erledigt > s.Gesamt:
		return fmt.Errorf("erledigt %d / gesamt %d", s.Erledigt, s.Gesamt)
	case s.RestS != nil && (*s.RestS < 0 || *s.RestS > int(MaxDauer/time.Second)):
		return fmt.Errorf("rest_s %d", *s.RestS)
	}
	return pruefeNetzeUndFunde(s.Netze, s.Funde, boxArt)
}

// Pruefe checks a result strictly before the box of type boxArt sends it.
func (e Ergebnis) Pruefe(boxArt string) error {
	if err := pruefeKopf(e.SchemaVersion, e.TenantID, e.SiteID, e.DeviceID, e.SuchID, e.Ts); err != nil {
		return err
	}
	gruende, ok := Gruende[e.Zustand]
	switch {
	case !ok:
		return fmt.Errorf("zustand %q", e.Zustand)
	case len(gruende) == 0 && e.Grund != "":
		return fmt.Errorf("%s carries no grund", e.Zustand)
	case len(gruende) > 0 && !enthaelt(gruende, e.Grund):
		return fmt.Errorf("grund %q does not belong to %s", e.Grund, e.Zustand)
	case e.DauerMs < 0 || e.DauerMs > 600000:
		return fmt.Errorf("dauer_ms %d", e.DauerMs)
	case e.Zustand == "abgelehnt" && (len(e.Funde) > 0 || e.DauerMs != 0):
		return errors.New("abgelehnt searched nothing")
	case e.Erkenner == nil:
		return errors.New("erkenner missing")
	}
	for i, k := range e.Erkenner {
		if !enthaelt(Erkenner, k) || enthaelt(e.Erkenner[:i], k) {
			return fmt.Errorf("erkenner %q", k)
		}
	}
	for _, n := range []*int{e.Weitere.TelefonTablet, e.Weitere.Rechner, e.Weitere.Unbekannt} {
		if n != nil && (*n < 0 || *n > 512) {
			return fmt.Errorf("weitere %d", *n)
		}
	}
	return pruefeNetzeUndFunde(e.Netze, e.Funde, boxArt)
}

func pruefeKopf(version, tenant, site, device, such string, ts time.Time) error {
	switch {
	case version != SchemaVersion:
		return fmt.Errorf("schema_version %q", version)
	case !uuidMuster.MatchString(tenant) || !uuidMuster.MatchString(site) || !uuidMuster.MatchString(device) ||
		!uuidMuster.MatchString(such):
		return errors.New("identity is not a uuid")
	case ts.IsZero():
		return errors.New("ts missing")
	}
	return nil
}

// Bereiche turns reported networks into ranges (range rule `bereich`); every
// network must pass, at most MaxNetze, each role once.
func Bereiche(netze []Netz) ([]probe.Bereich, error) {
	if netze == nil {
		return nil, errors.New("netze missing")
	}
	if len(netze) > MaxNetze {
		return nil, fmt.Errorf("%d networks, at most %d", len(netze), MaxNetze)
	}
	var out []probe.Bereich
	for i, n := range netze {
		if !enthaelt(Rollen, n.Rolle) {
			return nil, fmt.Errorf("rolle %q", n.Rolle)
		}
		for _, m := range netze[:i] {
			if m.Rolle == n.Rolle {
				return nil, fmt.Errorf("rolle %q twice", n.Rolle)
			}
		}
		if n.Aktiv < 0 || n.Aktiv > 254 {
			return nil, fmt.Errorf("aktiv %d", n.Aktiv)
		}
		b, grund := probe.PruefeBereich(n.Netz, n.BoxAdresse)
		if grund != "" {
			return nil, fmt.Errorf("netz %s / %s: %s", n.Netz, n.BoxAdresse, grund)
		}
		out = append(out, b)
	}
	return out, nil
}

func pruefeNetzeUndFunde(netze []Netz, funde []Fund, boxArt string) error {
	bereiche, err := Bereiche(netze)
	if err != nil {
		return err
	}
	if funde == nil {
		return errors.New("funde missing")
	}
	if len(funde) > MaxFunde {
		return fmt.Errorf("%d finds, at most %d", len(funde), MaxFunde)
	}
	for i, f := range funde {
		if err := PruefeFund(f, bereiche); err != nil {
			return fmt.Errorf("fund %d: %w", i, err)
		}
		if row, _ := KatalogPaar(f.Erkenner, f.Art); row.Anbindung(boxArt) != f.Anbindung {
			return fmt.Errorf("fund %d: %s on %s reports %q, not %q", i, f.Erkenner, boxArt, row.Anbindung(boxArt), f.Anbindung)
		}
		for _, g := range funde[:i] {
			if g.Schluessel == f.Schluessel {
				return fmt.Errorf("fund %d: schluessel %q twice", i, f.Schluessel)
			}
		}
	}
	return nil
}

// PruefeFund checks one find against the rules of the contract (the reader
// skips a find that breaks one; the box never sends it).
func PruefeFund(f Fund, bereiche []probe.Bereich) error {
	row, ok := KatalogPaar(f.Erkenner, f.Art)
	netztechnik := enthaelt(NetztechnikArten, f.Art)
	switch {
	case !schluesselMuster.MatchString(f.Schluessel):
		return fmt.Errorf("schluessel %q", f.Schluessel)
	case !ok:
		return fmt.Errorf("pair (%s, %s) not in the catalog", f.Erkenner, f.Art)
	case f.Hersteller != "" && !herstellerMuster.MatchString(f.Hersteller):
		return fmt.Errorf("hersteller %q", f.Hersteller)
	case !text64(f.Modell) || !text64(f.Firmware):
		return errors.New("modell/firmware")
	case f.Seriennummer != "" && !seriennrMuster.MatchString(f.Seriennummer):
		return fmt.Errorf("seriennummer %q", f.Seriennummer)
	case f.Familie != "" && !familieMuster.MatchString(f.Familie):
		return fmt.Errorf("familie %q", f.Familie)
	case f.Spannung != "" && f.Spannung != "hv" && f.Spannung != "lv":
		return fmt.Errorf("spannung %q", f.Spannung)
	case f.Kanaele < 0 || f.Kanaele > 16:
		return fmt.Errorf("kanaele %d", f.Kanaele)
	case !enthaelt(Erkennungen, f.Erkennung):
		return fmt.Errorf("erkennung %q", f.Erkennung)
	case !enthaelt(Anbindungen, f.Anbindung):
		return fmt.Errorf("anbindung %q", f.Anbindung)
	case f.Hindernis != "" && !enthaelt(Hindernisse, f.Hindernis):
		return fmt.Errorf("hindernis %q", f.Hindernis)
	case len(f.Merkmale) < 1 || len(f.Merkmale) > MaxMerkmale:
		return fmt.Errorf("%d merkmale", len(f.Merkmale))
	case (f.Erkennung == ErkennungUnbekannt) != (f.Anbindung == AnbindungSelbstBeschreiben):
		return errors.New("unbekannt and selbst_beschreiben go together")
	case netztechnik != (f.Anbindung == AnbindungNurAnzeige):
		return errors.New("network gear and nur_anzeige go together")
	case netztechnik && (f.Seriennummer != "" || f.Firmware != "" || f.Familie != "" || f.Spannung != "" ||
		f.Kanaele != 0 || f.Hindernis != ""):
		return errors.New("network gear carries only hersteller, modell and address")
	}
	for _, m := range f.Merkmale {
		if !merkmalMuster.MatchString(m) {
			return fmt.Errorf("merkmal %q", m)
		}
	}
	v := f.Verbindung
	if grund := probe.ZielImBereich(v.IP, bereiche); grund != "" {
		return fmt.Errorf("ip %q: %s", v.IP, grund)
	}
	switch {
	case v.Port < 1 || v.Port > 65535:
		return fmt.Errorf("port %d", v.Port)
	case v.UnitID != nil && (*v.UnitID < 0 || *v.UnitID > 255):
		return fmt.Errorf("unit_id %d", *v.UnitID)
	case v.Communication != "" && (!enthaelt(Communications, v.Communication) || v.Communication != row.Communication):
		return fmt.Errorf("communication %q, the pair's is %q", v.Communication, row.Communication)
	case v.Communication == "" && (f.Anbindung == AnbindungUebernehmen || f.Anbindung == AnbindungSelbstBeschreiben):
		return fmt.Errorf("%s needs the communication", f.Anbindung)
	case v.Communication == "solarman_v5" && v.Serial == nil:
		return errors.New("solarman_v5 needs the logger serial")
	}
	return nil
}

// text64 is "" (absent) or 1..64 characters without control characters.
func text64(s string) bool {
	if s == "" {
		return true
	}
	if n := len([]rune(s)); n > 64 {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func enthaelt(liste []string, s string) bool {
	for _, x := range liste {
		if x == s {
			return true
		}
	}
	return false
}
