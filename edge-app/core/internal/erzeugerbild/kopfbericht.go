package erzeugerbild

// KopfBericht is the head report of the probe op erzeuger_kopf
// (docs/contracts/mqtt-probe.schema.json) for the step "Steuerung verbinden":
// head, per unit kind and rated power and - when the image carries them - the
// names. No measurement value. Its JSON is the bus result's erzeuger_kopf
// block; the core decodes it as probe.ErzeugerKopf and judges it.
//
// Gap, not zero: a field this reading did not produce is ABSENT. After a
// foreign signature only signatur_ok=false; after a foreign major version only
// the version. A name read empty is "" ("keiner"), a name not read is absent.
type KopfBericht struct {
	SignaturOK bool   `json:"signatur_ok"`
	Erkannt    bool   `json:"erkannt"`
	Grund      string `json:"grund,omitempty"`

	Hauptversion   *int   `json:"hauptversion,omitempty"`
	Nebenversion   *int   `json:"nebenversion,omitempty"`
	TeAnzahl       *int   `json:"te_anzahl,omitempty"`
	Herzschlag     *int   `json:"herzschlag,omitempty"`
	Programmstand  *int   `json:"programmstand,omitempty"`
	SteuerungID    *int64 `json:"steuerung_id,omitempty"`
	Anlagenart     *int   `json:"anlagenart,omitempty"`
	BeschreibungAb *int   `json:"beschreibung_ab,omitempty"`

	Einheiten            []KopfEinheit `json:"einheiten,omitempty"`
	NetzbetreiberName    *string       `json:"netzbetreiber_name,omitempty"`
	DirektvermarkterName *string       `json:"direktvermarkter_name,omitempty"`
}

// KopfEinheit is one unit (inverter or engine) of the head report.
type KopfEinheit struct {
	Einheit int     `json:"einheit"`
	Art     *int    `json:"art,omitempty"`
	NennKW  *int    `json:"nenn_kw,omitempty"`
	TypName *string `json:"typ_name,omitempty"`
}

func zeiger[T any](v T) *T { return &v }

// Bericht builds the head report from the 12 head words, the unit words from
// base + 38 (nil when their read failed) and the name words from base +
// beschreibung_ab (nil when not read). The twin of kopfBericht.
func Bericht(kopfWoerter []uint16, wortfolge string, einheiten, namen []uint16) KopfBericht {
	if wortfolge == "" {
		wortfolge = "big"
	}
	grund, k := LiesKopf(kopfWoerter, wortfolge)
	if grund == GrundZuWenigWoerter || grund == GrundSignaturFremd {
		return KopfBericht{Grund: grund}
	}
	b := KopfBericht{SignaturOK: true, Hauptversion: zeiger(k.Hauptversion), Nebenversion: zeiger(k.Nebenversion)}
	if grund == GrundTeAnzahlUngueltig {
		b.Grund = grund
		b.TeAnzahl = zeiger(k.TeAnzahl)
		return b
	}
	if grund != "" {
		b.Grund = grund
		return b
	}
	laenge := k.TeAnzahl * EinheitLaenge
	if einheiten == nil || len(einheiten) < laenge {
		// The head names more units than the controller has registers.
		b.Grund = GrundZuWenigWoerter
		b.TeAnzahl = zeiger(k.TeAnzahl)
		return b
	}
	bereich, mitNamen := NamensBereich(k, 0)
	namenDa := mitNamen && namen != nil && len(namen) >= bereich.Count
	text := func(start int) *string {
		s, _ := liesName(namen, start)
		return &s
	}
	b.Erkannt = true
	b.TeAnzahl = zeiger(k.TeAnzahl)
	b.Herzschlag = zeiger(k.Herzschlag)
	b.Programmstand = k.Programmstand
	b.SteuerungID = k.SteuerungID
	b.Anlagenart = k.Anlagenart
	b.BeschreibungAb = zeiger(k.BeschreibungAb)
	b.Einheiten = []KopfEinheit{}
	for n := 1; n <= k.TeAnzahl; n++ {
		start := (n - 1) * EinheitLaenge
		e := KopfEinheit{Einheit: n}
		if a := int(einheiten[start+2]); imVokabular("t_art", int64(a)) {
			e.Art = zeiger(a)
		}
		if nenn := int(einheiten[start+3]); nenn != 0xFFFF {
			e.NennKW = zeiger(nenn)
		}
		if namenDa {
			e.TypName = text(offsetTypName + (n-1)*NameWoerter)
		}
		b.Einheiten = append(b.Einheiten, e)
	}
	if namenDa {
		b.NetzbetreiberName = text(offsetNetzbetreiber)
		b.DirektvermarkterName = text(offsetDirektvermarkter)
	}
	return b
}

// KopfTeil is one read of the head report.
type KopfTeil struct {
	Teil  string // kopf, einheiten, namen
	Start int
	Count int
}

// KopfPlan is how the head report reads its words: the head first, then -
// behind a recognised head - the unit blocks and the names, never a block
// split. The twin of kopfPlan.
func KopfPlan(basisadresse int, k *Kopf) []KopfTeil {
	if k == nil {
		return []KopfTeil{{Teil: "kopf", Start: basisadresse, Count: Kopflaenge}}
	}
	out := []KopfTeil{{Teil: "einheiten", Start: basisadresse + FesterTeil, Count: k.TeAnzahl * EinheitLaenge}}
	bereich, ok := NamensBereich(k, basisadresse)
	for _, a := range PlaneNamen(bereich, ok, 0) {
		out = append(out, KopfTeil{Teil: "namen", Start: a.Start, Count: a.Count})
	}
	return out
}
