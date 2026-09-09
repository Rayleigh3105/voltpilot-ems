package inverter

import (
	"encoding/json"
	"fmt"
	"strings"
)

// --- Komponenten-VORLAGEN: der Go-Katalog als DATEN ---------------------------
//
// Einheitsmodell Stufe 0a („Vorlagen werden Daten", Scout
// data/vp-komponenten-einheit-h2 Teil 3.1/Teil 8): die Cloud bekommt ein
// Vorlagen-Register (`component_template`), aus dem der spaetere EINE
// Anlege-Assistent seine Marken/Modelle rendert - statt sie, wie heute, aus
// diesem Go-Katalog zu rendern, den nur die Box kennt.
//
// ⚠ DIESE DATEI AENDERT NICHTS AM LAUFVERHALTEN DER BOX. Sie leitet aus
// DefaultCatalog() eine zweite DARSTELLUNG ab (eine Zeile je Marke+Modell) und
// serialisiert sie deterministisch. Die AUSFUEHRUNG (Decode-Familie,
// Node-RED-Adapter, Go-Executoren) bleibt Code und bleibt hier die Wahrheit;
// exportiert wird ausschliesslich, was der Katalog ohnehin schon DEKLARIERT.
//
// ⚠ DIE EINE HONESTY-REGEL, an der die Feld-Auswahl haengt: exportiert wird nur
// BELEGTES. Was der Katalog nicht deklariert, wird `null` (= „hier nicht
// erklaert"), NIE ein leerer Wert (= „es gibt keine"). Deshalb sind Channels,
// Writes und RatedKw Zeiger - siehe die Kommentare an den Feldern.
//
// Verhindert Drift: cmd/vp-template-export erzeugt die eingecheckte Datei
// services/api/src/main/resources/componenttemplates/builtin.json, und
// TestBuiltinTemplateExportMatchesTheCommittedFile vergleicht die Bytes. Ein
// Katalog-Edit ohne Re-Export faellt damit im `go test ./...`-Lauf auf, nicht
// erst beim Kunden.

// TemplateSchemaVersion versioniert die FORM des Export-Dokuments (nicht den
// Inhalt des Katalogs). Sie aendert sich nur, wenn Felder hinzukommen/wegfallen.
const TemplateSchemaVersion = "1.0"

// Vorlagen-Herkunft (`kind`). Genau dieses Vokabular kennt die Cloud-Spalte.
const (
	// TemplateKindBuiltin: die Vorlage kommt aus DIESEM Katalog, wird also mit
	// der Edge-Software ausgeliefert. Der Export erzeugt ausschliesslich solche.
	TemplateKindBuiltin = "builtin"
	// TemplateKindCertified: eine von VoltPilot geprueft eingetragene Vorlage
	// (Daten, kein Code-Release). Stufe 6 - hier nur das Vokabular.
	TemplateKindCertified = "certified"
	// TemplateKindCustom: eine selbst definierte, private Vorlage je Anlage.
	// Stufe 3 - hier nur das Vokabular.
	TemplateKindCustom = "custom"
)

// Pruef-Zustand einer Vorlage (`certification_status`). Er beantwortet eine
// ANDERE Frage als `kind`: kind = woher die Vorlage kommt, status = wofuer die
// Plattform einsteht.
const (
	// TemplateCertBuiltin ist der ehrliche Zustand einer eingebauten Vorlage:
	// sie wird mit der Edge-Software ausgeliefert und laeuft auf der Flotte.
	// Bewusst NICHT `certified` - das Wort gehoert dem Pruefstand (Stufe 6), und
	// eine Baureihe, die noch nie auf einem Tisch stand, waere damit
	// ueberbehauptet.
	TemplateCertBuiltin = "builtin"
)

// ChannelDef ist EINE Kanal-Definition einer Vorlage (Register -> Klartext-
// Messwert). Der Selbstbau-Weg (Stufe 3, Scout vp-modbus-baukasten-k6 §2.2)
// fuellt sie; eingebaute Vorlagen deklarieren KEINE (siehe Template.Channels).
type ChannelDef struct {
	Slug     string       `json:"slug"`
	Label    string       `json:"label"`
	Unit     string       `json:"unit,omitempty"`
	Register *RegisterDef `json:"register,omitempty"`
	Scale    *float64     `json:"scale,omitempty"`
	Offset   *float64     `json:"offset,omitempty"`
}

// RegisterDef adressiert EIN Register (k6 §2.2: 0-basiert, die 4xxxx-Hilfe
// steht im Assistenten).
type RegisterDef struct {
	Kind      string `json:"kind,omitempty"` // "holding" (FC3) | "input" (FC4)
	Address   int    `json:"address"`
	DataType  string `json:"data_type,omitempty"` // u16|s16|u32|s32|float32
	WordOrder string `json:"word_order,omitempty"`
	FC        int    `json:"fc,omitempty"`
}

// WriteDef ist EINE Schreib-Definition einer Vorlage - in Stufe 0a reines
// SCHEMA, ohne einen einzigen Verbraucher im Code. Die Form folgt den k6-
// Leitplanken §2.4 (zwei Schalt-Arten, nie ein freier Schreib-Baustein):
//
//	Kind "on_off"    -> genau die zwei Konstanten OnValue/OffValue
//	Kind "setpoint"  -> nur Werte innerhalb der Klemme [Min,Max]
//
// SafeValue ist in BEIDEN Faellen der Sicherheitswert fuer Stille/Widerruf.
type WriteDef struct {
	Key       string       `json:"key"`
	Label     string       `json:"label,omitempty"`
	Kind      string       `json:"kind"` // "on_off" | "setpoint"
	Register  *RegisterDef `json:"register,omitempty"`
	OnValue   *float64     `json:"on_value,omitempty"`
	OffValue  *float64     `json:"off_value,omitempty"`
	Min       *float64     `json:"min,omitempty"`
	Max       *float64     `json:"max,omitempty"`
	Unit      string       `json:"unit,omitempty"`
	SafeValue *float64     `json:"safe_value,omitempty"`
	Readback  *RegisterDef `json:"readback,omitempty"`
	Watchdog  *WatchdogDef `json:"watchdog,omitempty"`
}

// WatchdogDef beschreibt ein geraeteeigenes Totmann-Register (k6 §2.4
// Leitplanke 3c) - optional, weil ein generisches Modbus-Geraet keines haben
// muss.
type WatchdogDef struct {
	Register   *RegisterDef `json:"register,omitempty"`
	Value      *float64     `json:"value,omitempty"`
	IntervalS  int          `json:"interval_s,omitempty"`
	NoteGerman string       `json:"note,omitempty"`
}

// Template ist EINE Vorlagen-Zeile, so wie die Cloud sie speichert.
type Template struct {
	// TemplateRef ist der stabile, OPAQUE Schluessel der Vorlage. Fuer
	// eingebaute Vorlagen deterministisch `builtin:<marke>:<modell>`.
	// ⚠ Kein Abnehmer darf ihn zerlegen - Marke/Modell stehen als eigene Felder
	// daneben, genau damit niemand am String parsen muss.
	TemplateRef string `json:"template_ref"`
	Kind        string `json:"kind"`
	// Version zaehlt die DEFINITIONS-Fassung einer Vorlage. Eingebaute Vorlagen
	// bleiben auf 1: ihre Fassung ist der Edge-Softwarestand (das
	// Release-Register), nicht eine eigene Zaehlung - sonst haette ein
	// Katalog-Tippfehler eine Versionshistorie erzeugt. Geprueft/selbst gebaut
	// versioniert Stufe 6/3 ausdruecklich.
	Version int `json:"version"`

	Brand      string `json:"brand"`
	BrandLabel string `json:"brand_label"`
	Model      string `json:"model"`
	ModelLabel string `json:"model_label"`
	// ModelAliases sind die weiteren TYPENSCHILD-Namen desselben Produkts
	// (inverter.Model.Aliases). Sie tragen KEINE eigene Kennung und keine eigene
	// Vorlage - sie existieren, damit die Modell-Suche das findet, was auf dem
	// Geraet steht. Leer/abwesend = das Modell hat nur seinen einen Namen.
	ModelAliases []string `json:"model_aliases,omitempty"`
	// DeviceType ist die Geraetetyp-Dimension des Katalogs (siehe
	// inverter.DeviceType*): was fuer ein Geraet die Vorlage beschreibt. Sie
	// traegt die Typ-Karten des Anlege-Wegs; frueher steckte diese Aussage im
	// Markennamen („go-e (Wallbox)").
	DeviceType string `json:"device_type,omitempty"`
	// SupersededBy nennt die Vorlage, die DIESE abgeloest hat
	// (`builtin:<marke>:<modell>`) - leer, solange die Vorlage selbst gilt.
	//
	// ⚠ Sie ist die ALIAS-EBENE der Katalog-Neustruktur: eine abgeloeste Vorlage
	// bleibt vollstaendig AUFLOESBAR (eine Bestandsanlage referenziert ihren
	// Schluessel, und die Bestands-Uebernahme sucht ueber Marke+Modell), wird aber
	// nicht mehr ANGEBOTEN. Eine Oberflaeche blendet sie aus; ein Nachschlagen
	// findet sie weiterhin.
	SupersededBy string `json:"superseded_by,omitempty"`
	// Family ist die Decode-Profil-Referenz (der interne Registerkarten-Name,
	// mit dem Layer 1 self-wired). Sie ist die Bruecke zwischen der DATEN-Vorlage
	// und dem CODE, der sie ausfuehrt.
	Family             string `json:"family,omitempty"`
	FamilyLabel        string `json:"family_label,omitempty"`
	Communication      string `json:"communication"`
	CommunicationLabel string `json:"communication_label,omitempty"`

	// TransportSchema ist das Formular je Anbindung - das generische
	// Field-Vokabular, das die `:8484`-Seite heute schon rendert. Fuer
	// eingebaute Vorlagen ist es ECHTE Daten (deshalb nie null).
	TransportSchema []Field `json:"transport_schema"`

	// Channels: `null` heisst „diese Vorlage erklaert ihre Kanaele hier NICHT",
	// nicht „sie hat keine".
	// ⚠ Eine eingebaute Vorlage exportiert IMMER null: ihre Kanaele entstehen im
	// Decode-Profil (nodered/deye/deye-decode.js, sunspec-live.js, ...), also im
	// CODE - eine hier eingetragene Liste waere eine unbelegte Behauptung, und
	// `[]` waere die glatte Luege („liefert keine Messwerte"), obwohl ein Deye
	// PV/SoC/Batterie/Netz/Last publiziert.
	Channels []ChannelDef `json:"channels"`

	// Writes: dieselbe Regel. Eine eingebaute Vorlage exportiert null - ihr
	// Schreibweg ist der Steuer-Adapter im Code und wird vom Plattform-Register
	// `inverter_control_certification` (brand+model) freigegeben, nicht von
	// dieser Tabelle. `[]` hiesse „kann nichts schreiben" und waere fuer einen
	// steuerbaren Hybriden falsch.
	Writes []WriteDef `json:"writes"`

	// RatedKw ist die Nennleistung in kW, `null` = im Katalog unbekannt (der
	// generische SunSpec-/Fronius-/go-e-/Shelly-Eintrag). Nie 0 - 0 waere eine
	// Aussage ueber ein Geraet, die niemand belegt hat.
	RatedKw *float64 `json:"rated_kw"`

	// ControlTier ist das deklarierte Steuer-PRIMITIV der Marke (0-3). Es
	// AUTORISIERT NICHTS (so schon in inverter.go dokumentiert): ob je ein
	// Schreibbefehl herausgeht, entscheiden Not-Aus, Zertifizierungs-Register
	// und Scharfschaltung.
	ControlTier int `json:"control_tier"`

	CertificationStatus string `json:"certification_status"`
	CertifiedAt         string `json:"certified_at,omitempty"`
	CertificationNote   string `json:"certification_note,omitempty"`

	// Note ist der Anzeigetext (Marken-Hinweis + Modell-Hinweis, zusammengesetzt
	// aus genau dem, was der Katalog schon sagt).
	Note string `json:"note,omitempty"`
}

// TemplateExport ist das eingecheckte Export-Dokument.
type TemplateExport struct {
	SchemaVersion string `json:"schema_version"`
	// GeneratedFrom ist eine KONSTANTE Herkunftsangabe - bewusst kein
	// Zeitstempel: das Dokument muss bei gleichem Katalog byte-gleich bleiben,
	// sonst kann der Drift-Test es nicht vergleichen und jeder Lauf erzeugte
	// einen Diff.
	GeneratedFrom string     `json:"generated_from"`
	Templates     []Template `json:"templates"`
}

const templateGeneratedFrom = "edge-app/core/internal/inverter DefaultCatalog() " +
	"(cmd/vp-template-export)"

// BuiltinTemplateRef baut den stabilen Schluessel einer eingebauten Vorlage.
func BuiltinTemplateRef(brand, model string) string {
	return TemplateKindBuiltin + ":" + strings.TrimSpace(brand) + ":" + strings.TrimSpace(model)
}

// BuiltinTemplates leitet aus DefaultCatalog() eine Vorlage JE MARKE+MODELL ab -
// genau die Einheit, die der Kunde im Assistenten waehlt und auf die auch das
// Steuerungs-Register schluesselt (brand+model, Migration V20260814000000).
//
// Die Reihenfolge ist die Katalog-Reihenfolge (Marken, darin Modelle) und damit
// deterministisch.
func BuiltinTemplates() []Template {
	cat := DefaultCatalog()
	out := make([]Template, 0, 64)
	for _, b := range cat.Brands {
		for _, m := range b.Models {
			// Der VORGABE-Weg des Modells bestimmt Anbindung, Formular und - wo das
			// Modell keine eigene Registerkarte nennt - das Decode-Profil.
			//
			// ⚠ Exportiert wird GENAU EINE Zeile je Marke+Modell, auf dem
			// Vorgabeweg. Das Experten-Auswahlfeld „Verbindungsweg" bleibt bewusst
			// DRAUSSEN: die Cloud speichert je Vorlage EINE `communication` und EINE
			// `family` - ein Feld anzubieten, das dort nichts aendern kann, waere die
			// Sorte Behauptung, die dieses Haus nicht macht. Der cloud-seitige
			// Ausweg ist der ehrliche Modell-Eintrag („Anderes Fronius-Modell").
			transport, _ := b.resolveTransport(m, "")
			family := familyFor(m, transport)
			famLabel := ""
			if f, ok := b.family(family); ok {
				famLabel = f.Label
			}
			var rated *float64
			if m.RatedKw > 0 {
				v := m.RatedKw
				rated = &v
			}
			superseded := ""
			if b.Hidden && b.SupersededBy != "" {
				superseded = BuiltinTemplateRef(b.SupersededBy, m.ID)
			}
			out = append(out, Template{
				TemplateRef:        BuiltinTemplateRef(b.ID, m.ID),
				Kind:               TemplateKindBuiltin,
				Version:            1,
				Brand:              b.ID,
				BrandLabel:         b.Label,
				Model:              m.ID,
				ModelLabel:         m.Label,
				ModelAliases:       m.Aliases,
				DeviceType:         b.DeviceTypeOf(m),
				SupersededBy:       superseded,
				Family:             family,
				FamilyLabel:        famLabel,
				Communication:      transport.Communication,
				CommunicationLabel: transport.Label,
				TransportSchema:    transport.Fields,
				// Siehe die Feld-Kommentare: null, nicht [].
				Channels:            nil,
				Writes:              nil,
				RatedKw:             rated,
				ControlTier:         b.ControlTier,
				CertificationStatus: TemplateCertBuiltin,
				Note:                joinNote(b.Note, m.Note),
			})
		}
	}
	return out
}

// joinNote setzt Marken- und Modell-Hinweis zu EINEM Anzeigetext zusammen, ohne
// etwas zu erfinden: fehlt einer, bleibt der andere allein stehen.
func joinNote(brandNote, modelNote string) string {
	brandNote = strings.TrimSpace(brandNote)
	modelNote = strings.TrimSpace(modelNote)
	switch {
	case brandNote == "":
		return modelNote
	case modelNote == "":
		return brandNote
	default:
		return modelNote + " " + brandNote
	}
}

// MarshalBuiltinTemplates serialisiert das Export-Dokument deterministisch
// (eingerueckt + abschliessender Zeilenumbruch, damit die eingecheckte Datei
// lesbar und diff-freundlich ist).
func MarshalBuiltinTemplates() ([]byte, error) {
	doc := TemplateExport{
		SchemaVersion: TemplateSchemaVersion,
		GeneratedFrom: templateGeneratedFrom,
		Templates:     BuiltinTemplates(),
	}
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("vorlagen-export: %w", err)
	}
	return append(raw, '\n'), nil
}
