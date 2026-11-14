// Package logikdienst is the Steuerlogik service beside the API (Stufe 2,
// second part; docs/contracts/v2/steuerlogik.md "Der Dienst neben der API"):
// it takes a logic as text (the YAML writing form or the canonical JSON),
// reads it with the SAME readers the box uses (logik/textform for the writing
// form, logik for the canonical form), runs the check of the contract
// (structure and units, settings, probes) and builds the deployment artifact
// of bundle format "steuerlogik" with its content hash. The API never parses
// the language itself - it only calls this service - so the language is read
// nowhere a second, different way.
//
// Like flowc it knows neither tenants nor tokens: all auth and tenancy live in
// the Java API, which reaches it only on the internal network.
package logikdienst

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flowdeploy"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik/textform"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shelly"
)

const (
	// Version is this service's compiler_version on the artifacts it builds.
	Version = "1.0.0"
	// MinCoreVersion is the core gate of a Steuerlogik artifact. The real gate
	// is the box's supports word steuerlogik_mitlauf, which the cloud checks
	// before it delivers; a box without the core acks the format as an error.
	MinCoreVersion = "0.1.0"
	// minPaletteVersion: a Steuerlogik bundle needs no Node-RED palette (the
	// box skips the palette gate for this format); the field is mandatory.
	minPaletteVersion = "0.0.0"
	// MaxTextBytes bounds an incoming text (the writing form carries comments;
	// the canonical document itself is bounded by the core).
	MaxTextBytes = 256 * 1024
)

var uuidMuster = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Anlage are the plant facts a probe needs about a device (contract vectors:
// kw_per_output, outputs, setpoint_range).
type Anlage map[string]AnlageGeraet

// AnlageGeraet is one device of the plant as the probes see it. A device that
// regulates itself (K2) adds the step of its setpoint and its closed list of
// modes (steuerlogik-geraete-vectors.json).
type AnlageGeraet struct {
	KwPerOutput   *float64  `json:"kw_per_output,omitempty"`
	Outputs       int       `json:"outputs,omitempty"`
	SetpointRange []float64 `json:"setpoint_range,omitempty"`
	SetpointStep  *float64  `json:"setpoint_step,omitempty"`
	Modes         []string  `json:"modes,omitempty"`
}

func (a Anlage) kern() map[string]logik.ProbenGeraet {
	out := map[string]logik.ProbenGeraet{}
	for k, g := range a {
		pg := logik.ProbenGeraet{KwJeAusgang: g.KwPerOutput, Ausgaenge: g.Outputs,
			SollwertSchritt: g.SetpointStep, Betriebsarten: g.Modes}
		if len(g.SetpointRange) == 2 {
			pg.SollwertBereich = &[2]float64{g.SetpointRange[0], g.SetpointRange[1]}
		}
		out[k] = pg
	}
	return out
}

// Bericht is the check report of a logic, in the contract's terms.
type Bericht struct {
	Name       string     `json:"name"`
	Sperrt     bool       `json:"sperrt"`
	Ausdruecke int        `json:"ausdruecke"`
	Befunde    []string   `json:"befunde"`
	Zusammen   []Zusammen `json:"zusammen"`
	Proben     []Probe    `json:"proben"`
	Hinweise   []string   `json:"hinweise"`
	// Geraete and Eingaenge name what the logic switches and reads, so the
	// API can show them and check them against the plant (V-5).
	Geraete   []Geraet  `json:"geraete"`
	Eingaenge []Eingang `json:"eingaenge"`
	// Stellwerte describe the settings for the API and the portal (name, kind,
	// unit, range, step, who may set them, target value after E2 = B), so
	// neither has to read the language.
	Stellwerte []logik.StellwertInfo `json:"stellwerte"`
}

// Zusammen is a constraint between settings with its state.
type Zusammen struct {
	Name       string `json:"name"`
	Gilt       bool   `json:"gilt"`
	Verletzbar bool   `json:"im_bereich_verletzbar"`
}

// Probe is the outcome of one probe.
type Probe struct {
	Name         string       `json:"name"`
	Besteht      bool         `json:"besteht"`
	Abweichungen []Abweichung `json:"abweichungen"`
}

// Abweichung is an expectation that did not hold.
type Abweichung struct {
	Stelle string `json:"stelle"`
	Soll   string `json:"soll"`
	Ist    string `json:"ist"`
}

// Geraet is one device the logic switches.
type Geraet struct {
	Kennung  string `json:"kennung"`
	EntityID string `json:"entity_id"`
	Name     string `json:"name"`
	// Ausgaenge are the output kinds the logic sets for it (level, on_off,
	// setpoint, mode, percent): the API checks them against what the box can
	// execute before it arms the logic.
	Ausgaenge []string `json:"ausgaenge"`
}

// Eingang is one input the logic reads.
type Eingang struct {
	Kennung string `json:"kennung"`
	Source  string `json:"source"`
	Name    string `json:"name"`
}

// ErrUnlesbar marks a text the readers refuse (the German reason follows).
var ErrUnlesbar = errors.New("Logik nicht lesbar")

// Gelesen is a read and checked logic.
type Gelesen struct {
	// Kanonisch is the canonical JSON the box reads (key order preserved).
	Kanonisch []byte
	Bericht   *Bericht
}

// anlageAusRegistry derives the probes' plant facts from the registry push
// of the site - the document the box gets - with the box's own driver reader
// (shelly.Config.OutputFacts): outputs and kW per output of each device the
// logic switches, and band, step and modes of a device that regulates itself. A device the registry does not know keeps the defaults.
func anlageAusRegistry(L *logik.Logik, registry json.RawMessage) Anlage {
	var reg entities.Registry
	if len(registry) == 0 || json.Unmarshal(registry, &reg) != nil {
		return nil
	}
	out := Anlage{}
	for _, k := range L.GeraetListe {
		e := reg.Find(L.Geraete[k].Entity)
		if e == nil {
			continue
		}
		var g AnlageGeraet
		if cfg, ok := shelly.ParseDriver(e.Driver); ok {
			g.Outputs, g.KwPerOutput = cfg.OutputFacts()
		}
		// A device that regulates itself: the released band and step of its
		// setpoint in °C and its modes, as the box's guard chain applies them.
		for _, c := range e.Capabilities.Actuate {
			switch c.Command {
			case entities.CmdSetpointC:
				if c.Min != nil && c.Max != nil {
					g.SetpointRange = []float64{*c.Min, *c.Max}
				}
				g.SetpointStep = c.Step
			case entities.CmdMode:
				g.Modes = append([]string(nil), c.Modes...)
			}
		}
		if g.Outputs != 0 || g.KwPerOutput != nil || g.SetpointRange != nil || g.SetpointStep != nil || g.Modes != nil {
			out[k] = g
		}
	}
	return out
}

// Pruefe reads a text and runs the check. A text the readers refuse is
// ErrUnlesbar with the reason; a readable logic always comes back with its
// report, Sperrt saying whether the check blocks it. The plant facts of the
// probes come from anlage (by device key) or, where it says nothing, from the
// site's registry push (by entity).
func Pruefe(text []byte, anlage Anlage, registry json.RawMessage) (*Gelesen, error) {
	if len(text) > MaxTextBytes {
		return nil, fmt.Errorf("%w: Der Text ist größer als %d KB", ErrUnlesbar, MaxTextBytes/1024)
	}
	var baum *textform.Knoten
	var err error
	if istJSON(text) {
		baum, err = textform.LiesJSON(text)
	} else {
		baum, err = textform.Lies(text)
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrUnlesbar, err.Error())
	}
	kanonisch, err := baum.JSON()
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrUnlesbar, err.Error())
	}
	L, err := logik.Lesen(kanonisch)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrUnlesbar, err.Error())
	}
	fakten := anlageAusRegistry(L, registry)
	for k, g := range anlage {
		if fakten == nil {
			fakten = Anlage{}
		}
		fakten[k] = g
	}
	pb := L.Pruefe(fakten.kern())
	b := &Bericht{Name: L.Name, Sperrt: pb.Sperrt(), Ausdruecke: pb.Ausdruecke,
		Befunde: []string{}, Zusammen: []Zusammen{}, Proben: []Probe{}, Hinweise: []string{},
		Geraete: []Geraet{}, Eingaenge: []Eingang{}, Stellwerte: L.StellwertInfos()}
	for _, f := range pb.Befunde {
		b.Befunde = append(b.Befunde, f.Text)
	}
	for _, z := range pb.Zusammen {
		b.Zusammen = append(b.Zusammen, Zusammen{Name: z.Name, Gilt: z.Gilt, Verletzbar: z.Verletzbar})
	}
	for _, p := range pb.Proben {
		pr := Probe{Name: p.Name, Besteht: p.Bestanden, Abweichungen: []Abweichung{}}
		for _, a := range p.Abweichungen {
			pr.Abweichungen = append(pr.Abweichungen, Abweichung{Stelle: a.Stelle, Soll: a.Soll, Ist: a.Ist})
		}
		b.Proben = append(b.Proben, pr)
	}
	b.Hinweise = append(b.Hinweise, pb.Hinweise...)
	for _, k := range L.GeraetListe {
		g := L.Geraete[k]
		d := Geraet{Kennung: k, EntityID: g.Entity, Name: g.Name, Ausgaenge: []string{}}
		for _, art := range []string{"level", "on_off", "setpoint", "mode", "percent"} {
			if _, ok := L.Ausgaenge[k][art]; ok {
				d.Ausgaenge = append(d.Ausgaenge, art)
			}
		}
		b.Geraete = append(b.Geraete, d)
	}
	for _, k := range L.WertListe {
		e := L.Werte[k]
		b.Eingaenge = append(b.Eingaenge, Eingang{Kennung: k, Source: e.Source, Name: e.Name})
	}
	return &Gelesen{Kanonisch: kanonisch, Bericht: b}, nil
}

func istJSON(text []byte) bool {
	t := bytes.TrimLeft(bytes.TrimPrefix(text, []byte("\xef\xbb\xbf")), " \t\r\n")
	return len(t) > 0 && t[0] == '{'
}

// Ort is where the plant is; it travels in the bundle (flow-artifact.md §2.1).
type Ort struct {
	Timezone  string   `json:"timezone,omitempty"`
	Latitude  *float64 `json:"latitude,omitempty"`
	Longitude *float64 `json:"longitude,omitempty"`
}

// Auftrag is what the API asks an artifact for.
type Auftrag struct {
	Text   string `json:"text"`
	Anlage Anlage `json:"anlage,omitempty"`
	// Registry is the site's registry push (edge-entity.schema.json), the
	// source of the probes' device facts.
	Registry    json.RawMessage `json:"registry,omitempty"`
	FlowID      string          `json:"flow_id"`
	FlowVersion int             `json:"flow_version"`
	CompiledAt  time.Time       `json:"compiled_at"`
	Site        *Ort            `json:"site,omitempty"`
	// Armed builds the artifact of an armed logic (Stufe 3, "scharf"): its
	// wishes go to the arbiter, and the required entities name the command
	// the box will switch with.
	Armed bool `json:"armed,omitempty"`
	// Settings are the set values (the document's form) with their revision;
	// nil = none, the bundle then carries no settings at all.
	Settings *Einstellung `json:"settings,omitempty"`
	// SettingsKeepFitting is for a NEW version: a value that no longer fits
	// (name, unit or range changed, report §8.9) falls back to its default and
	// is named in the answer instead of refusing the version.
	SettingsKeepFitting bool `json:"settings_keep_fitting,omitempty"`
}

// Einstellung are set values with their revision.
type Einstellung struct {
	Revision int64                      `json:"revision"`
	Values   map[string]json.RawMessage `json:"values"`
}

// Verworfen is a set value a new version does not take, with the reason.
type Verworfen struct {
	Kennung string `json:"kennung"`
	Grund   string `json:"grund"`
}

// ErrStellwerte marks set values that do not fit the logic (range, step,
// kind, constraints); the German reason follows.
var ErrStellwerte = errors.New("Stellwerte passen nicht")

// Gebaut is what Artefakt answers besides the artifact and the report: the
// set values the bundle carries and those a new version dropped.
type Gebaut struct {
	Settings  *Einstellung `json:"settings,omitempty"`
	Verworfen []Verworfen  `json:"verworfen,omitempty"`
}

// ErrSperrt marks a readable logic the check blocks (E5 = C).
var ErrSperrt = errors.New("Die Prüfung sperrt die Logik")

// ErrAuftrag marks a malformed request.
var ErrAuftrag = errors.New("Auftrag unvollständig")

// Artefakt reads and checks the text and builds the deployment artifact. A
// blocked logic is ErrSperrt and comes with its report; no artifact leaves
// this service for a logic the check blocks.
func Artefakt(a Auftrag) (json.RawMessage, *Bericht, error) {
	art, b, _, err := ArtefaktMitWerten(a)
	return art, b, err
}

// ArtefaktMitWerten is Artefakt with the set values it took: set values that
// do not fit are ErrStellwerte, or with SettingsKeepFitting dropped and named.
func ArtefaktMitWerten(a Auftrag) (json.RawMessage, *Bericht, *Gebaut, error) {
	art, b, gebaut, err := artefakt(a)
	return art, b, gebaut, err
}

func artefakt(a Auftrag) (json.RawMessage, *Bericht, *Gebaut, error) {
	if !uuidMuster.MatchString(a.FlowID) {
		return nil, nil, nil, fmt.Errorf("%w: flow_id ist keine UUID", ErrAuftrag)
	}
	if a.FlowVersion < 1 {
		return nil, nil, nil, fmt.Errorf("%w: flow_version ab 1", ErrAuftrag)
	}
	if a.Site != nil && a.Site.Timezone != "" {
		if _, err := time.LoadLocation(a.Site.Timezone); err != nil {
			return nil, nil, nil, fmt.Errorf("%w: Zeitzone %q unbekannt", ErrAuftrag, a.Site.Timezone)
		}
	}
	g, err := Pruefe([]byte(a.Text), a.Anlage, a.Registry)
	if err != nil {
		return nil, nil, nil, err
	}
	if g.Bericht.Sperrt {
		return nil, g.Bericht, nil, ErrSperrt
	}
	L, err := logik.Lesen(g.Kanonisch)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("%w: %s", ErrUnlesbar, err.Error())
	}
	gebaut := &Gebaut{}
	bundle := flowdeploy.Bundle{Format: flowdeploy.FormatSteuerlogik, Logic: string(g.Kanonisch), Armed: a.Armed}
	if a.Settings != nil {
		werte, verworfen, err := stellwerte(L, a.Settings.Values, a.SettingsKeepFitting)
		if err != nil {
			return nil, g.Bericht, nil, err
		}
		bundle.Settings = &flowdeploy.BundleSettings{Revision: a.Settings.Revision, Values: werte}
		gebaut.Settings = &Einstellung{Revision: a.Settings.Revision, Values: werte}
		gebaut.Verworfen = verworfen
	}
	if a.Site != nil && (a.Site.Timezone != "" || a.Site.Latitude != nil || a.Site.Longitude != nil) {
		bundle.Site = &flowdeploy.BundleSite{Timezone: a.Site.Timezone, Latitude: a.Site.Latitude,
			Longitude: a.Site.Longitude}
	}
	bundleRaw, err := json.Marshal(bundle)
	if err != nil {
		return nil, nil, nil, err
	}
	hash, err := flowdeploy.ContentHash(bundleRaw)
	if err != nil {
		return nil, nil, nil, err
	}
	required := []map[string]any{}
	for _, d := range g.Bericht.Geraete {
		// Running along, the logic switches nothing: the box only checks that
		// the device it observes exists. Armed, the box must actuate with the
		// command it will switch the device with.
		caps := []string{}
		if a.Armed {
			caps = SchaltRecht(d, L.SollwertGroesse(d.Kennung), a.Registry)
		}
		required = append(required, map[string]any{"entity_id": d.EntityID, "capabilities": caps})
	}
	compiledAt := a.CompiledAt
	if compiledAt.IsZero() {
		compiledAt = time.Now()
	}
	art := map[string]any{
		"schema_version":      flowdeploy.SchemaVersion,
		"kind":                "artifact",
		"artifact_id":         artefaktID(a.FlowID, a.FlowVersion),
		"flow_id":             a.FlowID,
		"flow_version":        a.FlowVersion,
		"runtime":             "edge",
		"content_hash":        hash,
		"compiled_at":         compiledAt.UTC().Format(time.RFC3339),
		"compiler_version":    Version,
		"min_palette_version": minPaletteVersion,
		"min_core_version":    MinCoreVersion,
		"required_entities":   required,
		"bundle":              json.RawMessage(bundleRaw),
	}
	raw, err := json.Marshal(art)
	if err != nil {
		return nil, nil, nil, err
	}
	return raw, g.Bericht, gebaut, nil
}

// stellwerte checks set values against the logic and writes them in the
// document's form. Strict: a value that does not fit refuses all. Keep
// fitting (a new version): it falls back to its default and is named; if the
// fitting values together break a constraint, all fall back.
func stellwerte(L *logik.Logik, roh map[string]json.RawMessage, behalten bool) (map[string]json.RawMessage, []Verworfen, error) {
	gelesen := map[string]any{}
	var verworfen []Verworfen
	for _, k := range sortiert(roh) {
		var v any
		if json.Unmarshal(roh[k], &v) != nil {
			if !behalten {
				return nil, nil, fmt.Errorf("%w: Stellwert %s nicht lesbar", ErrStellwerte, k)
			}
			verworfen = append(verworfen, Verworfen{Kennung: k, Grund: "nicht lesbar"})
			continue
		}
		if _, err := L.LiesStellwert(k, v); err != nil {
			if !behalten {
				return nil, nil, fmt.Errorf("%w: %s", ErrStellwerte, err.Error())
			}
			verworfen = append(verworfen, Verworfen{Kennung: k, Grund: err.Error()})
			continue
		}
		gelesen[k] = v
	}
	werte, err := L.PruefeStellwerte(gelesen)
	if err != nil {
		if !behalten {
			return nil, nil, fmt.Errorf("%w: %s", ErrStellwerte, err.Error())
		}
		for _, k := range sortiert(gelesen) {
			verworfen = append(verworfen, Verworfen{Kennung: k, Grund: err.Error()})
		}
		werte = nil
	}
	out := map[string]json.RawMessage{}
	for k, w := range werte {
		raw, err := json.Marshal(L.StellwertRoh(k, w))
		if err != nil {
			return nil, nil, err
		}
		out[k] = raw
	}
	return out, verworfen, nil
}

func sortiert[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// SchaltRecht are the commands an armed logic switches a device with, exactly
// as the box will (agent/steuerlogik_scharf.go, logikBefehl): a level on a
// Shelly output set -> setpoint_kw (heizstab-regler.md), any other level and
// on_off -> on_off; a mode -> mode, at an SG-Ready heat pump without mode the
// contact (on_off, E10 = A); a setpoint in °C -> setpoint_c, in kW ->
// setpoint_kw (K2). A share needs no capability here - the API refuses to arm
// it. Without the device in the registry nothing is required (the API never
// arms a logic whose device the registry does not know). The box checks the
// result against its registry when it takes the bundle.
func SchaltRecht(d Geraet, sollwert logik.Groesse, registry json.RawMessage) []string {
	var reg entities.Registry
	if len(registry) == 0 || json.Unmarshal(registry, &reg) != nil {
		return []string{}
	}
	e := reg.Find(d.EntityID)
	if e == nil {
		return []string{}
	}
	cfg, isShelly := shelly.ParseDriver(e.Driver)
	set := map[string]bool{}
	for _, art := range d.Ausgaenge {
		switch art {
		case "level":
			if isShelly && cfg.IsGroup() {
				set["actuate:"+entities.CmdSetpointKw] = true
			} else {
				set["actuate:"+entities.CmdOnOff] = true
			}
		case "on_off":
			set["actuate:"+entities.CmdOnOff] = true
		case "mode":
			if sgReadyKontakt(*e) {
				set["actuate:"+entities.CmdOnOff] = true
			} else {
				set["actuate:"+entities.CmdMode] = true
			}
		case "setpoint":
			switch sollwert {
			case logik.GroesseTemp:
				set["actuate:"+entities.CmdSetpointC] = true
			case logik.GroesseKW:
				set["actuate:"+entities.CmdSetpointKw] = true
			}
		}
	}
	return sortiert(set)
}

// sgReadyKontakt says whether a logic's mode reaches this device as its
// SG-Ready contact: a heat pump on SG-Ready that declares no mode of its own
// gets boost as the contact closed (state 3) and normal as open (E10 = A).
// The box decides the same (agent.logikBefehl; agreement test there).
func sgReadyKontakt(e entities.Entity) bool {
	return e.Type == "heat-pump-sgready" && !e.Supports(entities.CmdMode)
}

// artefaktID is derived like flowc's: the same (flow, version) yields the
// same artifact_id.
func artefaktID(flowID string, version int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%d", flowID, version)))
	h := hex.EncodeToString(sum[:])
	return h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-8" + h[17:20] + "-" + h[20:32]
}
