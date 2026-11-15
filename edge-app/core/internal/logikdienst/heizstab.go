package logikdienst

// Der Heizstab-Regler der Box als Logik des Kerns (Stufe 6, Zusammenführen, dritter Teil): der
// Baustein heizstab-regler.block.yaml (byte-gleiche Kopie des Vertrags, steuerlogik/zusammenfuehren/)
// gefüllt aus dem Parameterblock eines Heizstabs (heizstab-regler.md) und den Stufen seiner
// Ausgangsmenge, wie der Treiber der Box sie nennt (shelly.Config.StageCeilings). Die Stufen stehen
// als Zahlen im Text: ihre Ausgänge und ihre Leistung, genau die Werte, mit denen der Regler rechnet.
// Ändert sich der Treiber, übersetzt die API neu.

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	hz "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/heizstab"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logikdienst/regel"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shelly"
	"gopkg.in/yaml.v3"
)

//go:embed heizstab-regler.block.yaml
var heizstabBaustein []byte

// HeizstabAuftrag ist eine Übersetzung des Parameterblocks eines Heizstabs.
type HeizstabAuftrag struct {
	// Entity ist der Heizstab (Kennung der Entität im Registry-Push).
	Entity string `json:"entity"`
	// Block ist der Parameterblock `heizstab`, wie die Cloud ihn der Box schickt.
	Block json.RawMessage `json:"block"`
	// Name ist der Name der Logik; ohne ihn „Heizstab-Regler: <Gerät>“.
	Name     string          `json:"name,omitempty"`
	Registry json.RawMessage `json:"registry"`
}

// HeizstabStufe ist eine Stufe der Ausgangsmenge: Ausgänge zugleich und ihre Leistung.
type HeizstabStufe struct {
	Ausgaenge int
	Kw        float64
}

// AusHeizstab übersetzt den Block eines Heizstabs in eine Logik und prüft sie. Was sich nicht
// übersetzen lässt, steht mit Grund in der Antwort; der alte Weg bleibt dann.
func AusHeizstab(a HeizstabAuftrag) (*RegelErgebnis, error) {
	if a.Entity == "" || len(a.Block) == 0 {
		return nil, fmt.Errorf("%w: entity und block fehlen", ErrAuftrag)
	}
	grund := func(code, text string) (*RegelErgebnis, error) {
		return &RegelErgebnis{Gruende: []regel.Grund{{Code: code, Text: text}}}, nil
	}
	p, ok, err := hz.ParseParams(a.Block)
	if err != nil {
		return grund("block", "Der Parameterblock ist ungültig: "+err.Error())
	}
	if !ok {
		return grund("modus", "Der Parameterblock nennt keinen Modus, den der Regler ausführt.")
	}
	var reg entities.Registry
	if len(a.Registry) == 0 || json.Unmarshal(a.Registry, &reg) != nil {
		return grund("registry", "Ohne den Registry-Inhalt der Anlage sind die Stufen des Heizstabs unbekannt.")
	}
	e := reg.Find(a.Entity)
	if e == nil {
		return grund("geraet", "Die Anlage kennt diesen Heizstab nicht.")
	}
	cfg, isShelly := shelly.ParseDriver(e.Driver)
	outs, kws := cfg.StageCeilings()
	if !isShelly || len(outs) == 0 {
		return grund("stufen", "Der Treiber dieses Heizstabs nennt keine Stufen; der Regler schaltet ihn nicht.")
	}
	if p.SwitchesPerHour > 64 {
		return grund("schaltungen", "Mehr als 64 Schaltungen je Stunde merkt sich der Regler nicht; so übersetzt, entschiede der Kern anders.")
	}
	stufen := make([]HeizstabStufe, len(outs))
	for i := range outs {
		stufen[i] = HeizstabStufe{Ausgaenge: outs[i], Kw: kws[i]}
	}
	name := a.Name
	if strings.TrimSpace(name) == "" {
		label := e.Label
		if label == "" {
			label = "Heizstab"
		}
		name = "Heizstab-Regler: " + label
	}
	text, err := HeizstabText(p, stufen, a.Entity, e.Label, name)
	if err != nil {
		return nil, err
	}
	g, err := Pruefe(text, nil, a.Registry)
	if err != nil {
		return nil, fmt.Errorf("Übersetzung nicht lesbar: %w", err)
	}
	if g.Bericht.Sperrt {
		gruende := []regel.Grund{}
		for _, b := range g.Bericht.Befunde {
			gruende = append(gruende, regel.Grund{Code: "pruefung", Text: b})
		}
		return &RegelErgebnis{Gruende: gruende, Bericht: g.Bericht}, nil
	}
	return &RegelErgebnis{Uebersetzt: true, Text: string(text), Gruende: []regel.Grund{}, Bericht: g.Bericht}, nil
}

// HeizstabText ist der Text der Logik: der Baustein mit den Werten des Blocks, dem Gerät und den
// Stufen. Eigene Kopf-Zeilen nennen die Herkunft.
func HeizstabText(p hz.Params, stufen []HeizstabStufe, entity, geraetName, name string) ([]byte, error) {
	b, err := LiesBaustein(heizstabBaustein)
	if err != nil {
		return nil, fmt.Errorf("Baustein des Heizstab-Reglers: %w", err)
	}
	if len(stufen) == 0 {
		return nil, fmt.Errorf("Baustein des Heizstab-Reglers: keine Stufen")
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(b.logikText, &doc); err != nil || len(doc.Content) != 1 {
		return nil, fmt.Errorf("Baustein des Heizstab-Reglers: logic ist kein Objekt")
	}
	w := doc.Content[0]
	zeilen := zeilenAnfaenge(b.logikText)
	var ers []ersetzung
	// setze ersetzt einen einzeiligen Wert; was schon so dasteht, bleibt in seiner Schreibweise.
	setze := func(n *yaml.Node, wert string, text bool) error {
		if n == nil {
			return fmt.Errorf("Baustein des Heizstab-Reglers: eine Stelle fehlt")
		}
		if n.Value == wert {
			return nil
		}
		e, err := spanne(b.logikText, zeilen, n)
		if err != nil {
			return err
		}
		e.neu = wert
		if text {
			e.neu = jsonText(wert)
		}
		ers = append(ers, e)
		return nil
	}
	pfad := func(weg ...string) *yaml.Node {
		n := w
		for _, k := range weg {
			n = feld(n, k)
		}
		return n
	}
	oben := stufen[len(stufen)-1].Ausgaenge
	hoechste := oben
	if p.MaxOutputs > 0 && p.MaxOutputs < oben {
		hoechste = p.MaxOutputs
	}
	vorrang := hz.StorageFirst
	if p.Order == hz.RodFirst {
		vorrang = hz.RodFirst
	}
	reserve := hz.DefaultReserveKw
	if p.ReserveKw != nil {
		reserve = *p.ReserveKw
	}
	sekunden := func(v, vorgabe int) string {
		if v == 0 {
			v = vorgabe
		}
		return strconv.Itoa(v) + " s"
	}
	schaltungen := p.SwitchesPerHour
	if schaltungen == 0 {
		schaltungen = hz.DefaultSwitchesPerHour
	}
	if name == "" {
		name = "Heizstab-Regler"
	}
	if geraetName == "" {
		geraetName = "Heizstab"
	}
	type wert struct {
		weg  []string
		neu  string
		text bool
	}
	werte := []wert{
		{[]string{"name"}, name, true},
		{[]string{"devices", "heizstab", "entity"}, entity, true},
		{[]string{"devices", "heizstab", "name"}, geraetName, true},
		{[]string{"inputs", "stab", "source"}, entity + ".power", true},
		{[]string{"settings", "reserve", "default"}, kwText(reserve), false},
		{[]string{"settings", "hoechste", "default"}, strconv.Itoa(hoechste), false},
		{[]string{"settings", "vorrang", "default"}, vorrang, false},
		{[]string{"settings", "mindestlauf", "default"}, sekunden(p.MinRunS, hz.DefaultMinRunS), false},
		{[]string{"settings", "mindestpause", "default"}, sekunden(p.MinPauseS, hz.DefaultMinPauseS), false},
		{[]string{"settings", "haltezeit", "default"}, sekunden(p.HoldS, hz.DefaultHoldS), false},
		{[]string{"settings", "schaltungen", "default"}, strconv.Itoa(schaltungen), false},
		{[]string{"states", "stufe", "max"}, strconv.Itoa(oben), false},
		{[]string{"formulas", "oben"}, heizstabOben(stufen), false},
		{[]string{"formulas", "ziel"}, heizstabZiel(stufen), false},
		{[]string{"formulas", "naechste"}, heizstabNaechste(stufen), false},
		{[]string{"formulas", "kleinste"}, strconv.Itoa(stufen[0].Ausgaenge), false},
	}
	for _, x := range werte {
		if err := setze(pfad(x.weg...), x.neu, x.text); err != nil {
			return nil, err
		}
	}
	bereich := pfad("settings", "hoechste", "range")
	if bereich == nil || bereich.Kind != yaml.SequenceNode || len(bereich.Content) != 2 {
		return nil, fmt.Errorf("Baustein des Heizstab-Reglers: settings.hoechste.range")
	}
	if err := setze(bereich.Content[1], strconv.Itoa(oben), false); err != nil {
		return nil, err
	}
	// Von hinten nach vorn ersetzen, damit die Stellen davor gelten.
	for i := 0; i < len(ers); i++ {
		for j := i + 1; j < len(ers); j++ {
			if ers[j].von > ers[i].von {
				ers[i], ers[j] = ers[j], ers[i]
			}
		}
	}
	out := append([]byte(nil), b.logikText...)
	for _, e := range ers {
		out = append(out[:e.von], append([]byte(e.neu), out[e.bis:]...)...)
	}
	var kopf strings.Builder
	kopf.WriteString("# Übersetzt aus dem Parameterblock des Heizstab-Reglers (heizstab-regler.md), Baustein heizstab-regler.block.yaml.\n")
	kopf.WriteString("# Bearbeitet wird die Steuerart des Heizstabs, nicht dieser Text: jede Änderung übersetzt ihn neu.\n")
	var teile []string
	for _, s := range stufen {
		teile = append(teile, fmt.Sprintf("%d zugleich %s", s.Ausgaenge, kwText(s.Kw)))
	}
	kopf.WriteString("# Stufen der Ausgangsmenge (Ausgänge zugleich, Leistung): " + strings.Join(teile, ", ") + ".\n")
	return append([]byte(kopf.String()), out...), nil
}

// kwText schreibt eine Leistung so, dass der Kern genau diese Zahl liest.
func kwText(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64) + " kW"
}

// heizstabOben ist die höchste Stufe, die „hoechste“ zulässt (in Ausgängen), wie capIndex des Reglers.
func heizstabOben(stufen []HeizstabStufe) string {
	f := "0"
	for _, s := range stufen {
		a := strconv.Itoa(s.Ausgaenge)
		f = "if(hoechste >= " + a + ", " + a + ", " + f + ")"
	}
	return f
}

// heizstabZiel ist die höchste erlaubte Stufe, deren Leistung in den freien Überschuss passt, mit
// der Toleranz des Reglers (kW ≤ verfügbar · (1 + 10⁻⁶) + 10⁻⁹; den letzten Summanden trägt das
// Epsilon des Vergleichs).
func heizstabZiel(stufen []HeizstabStufe) string {
	f := "0"
	for _, s := range stufen {
		a := strconv.Itoa(s.Ausgaenge)
		f = "if(oben >= " + a + " and frei * 1.000001 >= " + kwText(s.Kw) + ", " + a + ", " + f + ")"
	}
	return f
}

// heizstabNaechste ist die Stufe über der jetzigen: eine Stufe auf einmal.
func heizstabNaechste(stufen []HeizstabStufe) string {
	f := strconv.Itoa(stufen[len(stufen)-1].Ausgaenge)
	for i := len(stufen) - 2; i >= 0; i-- {
		a := strconv.Itoa(stufen[i].Ausgaenge)
		f = "if(stufe < " + a + ", " + a + ", " + f + ")"
	}
	return f
}
