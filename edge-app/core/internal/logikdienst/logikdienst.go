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

// AnlageGeraet is one device of the plant as the probes see it.
type AnlageGeraet struct {
	KwPerOutput   *float64  `json:"kw_per_output,omitempty"`
	Outputs       int       `json:"outputs,omitempty"`
	SetpointRange []float64 `json:"setpoint_range,omitempty"`
}

func (a Anlage) kern() map[string]logik.ProbenGeraet {
	out := map[string]logik.ProbenGeraet{}
	for k, g := range a {
		pg := logik.ProbenGeraet{KwJeAusgang: g.KwPerOutput, Ausgaenge: g.Outputs}
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
	// API can show them and later check them against the plant (V-5).
	Geraete   []Geraet  `json:"geraete"`
	Eingaenge []Eingang `json:"eingaenge"`
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
// logic switches. A device the registry does not know keeps the defaults.
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
		if cfg, ok := shelly.ParseDriver(e.Driver); ok {
			n, kw := cfg.OutputFacts()
			out[k] = AnlageGeraet{Outputs: n, KwPerOutput: kw}
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
		Geraete: []Geraet{}, Eingaenge: []Eingang{}}
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
		b.Geraete = append(b.Geraete, Geraet{Kennung: k, EntityID: g.Entity, Name: g.Name})
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
}

// ErrSperrt marks a readable logic the check blocks (E5 = C).
var ErrSperrt = errors.New("Die Prüfung sperrt die Logik")

// ErrAuftrag marks a malformed request.
var ErrAuftrag = errors.New("Auftrag unvollständig")

// Artefakt reads and checks the text and builds the deployment artifact. A
// blocked logic is ErrSperrt and comes with its report; no artifact leaves
// this service for a logic the check blocks.
func Artefakt(a Auftrag) (json.RawMessage, *Bericht, error) {
	if !uuidMuster.MatchString(a.FlowID) {
		return nil, nil, fmt.Errorf("%w: flow_id ist keine UUID", ErrAuftrag)
	}
	if a.FlowVersion < 1 {
		return nil, nil, fmt.Errorf("%w: flow_version ab 1", ErrAuftrag)
	}
	if a.Site != nil && a.Site.Timezone != "" {
		if _, err := time.LoadLocation(a.Site.Timezone); err != nil {
			return nil, nil, fmt.Errorf("%w: Zeitzone %q unbekannt", ErrAuftrag, a.Site.Timezone)
		}
	}
	g, err := Pruefe([]byte(a.Text), a.Anlage, a.Registry)
	if err != nil {
		return nil, nil, err
	}
	if g.Bericht.Sperrt {
		return nil, g.Bericht, ErrSperrt
	}
	bundle := flowdeploy.Bundle{Format: flowdeploy.FormatSteuerlogik, Logic: string(g.Kanonisch)}
	if a.Site != nil && (a.Site.Timezone != "" || a.Site.Latitude != nil || a.Site.Longitude != nil) {
		bundle.Site = &flowdeploy.BundleSite{Timezone: a.Site.Timezone, Latitude: a.Site.Latitude,
			Longitude: a.Site.Longitude}
	}
	bundleRaw, err := json.Marshal(bundle)
	if err != nil {
		return nil, nil, err
	}
	hash, err := flowdeploy.ContentHash(bundleRaw)
	if err != nil {
		return nil, nil, err
	}
	required := []map[string]any{}
	for _, d := range g.Bericht.Geraete {
		// In this stage the logic switches nothing: the box only checks that
		// the device it observes exists.
		required = append(required, map[string]any{"entity_id": d.EntityID, "capabilities": []string{}})
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
		return nil, nil, err
	}
	return raw, g.Bericht, nil
}

// artefaktID is derived like flowc's: the same (flow, version) yields the
// same artifact_id.
func artefaktID(flowID string, version int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%d", flowID, version)))
	h := hex.EncodeToString(sum[:])
	return h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-8" + h[17:20] + "-" + h[20:32]
}
