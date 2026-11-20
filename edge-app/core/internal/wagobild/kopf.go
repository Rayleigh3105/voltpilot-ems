package wagobild

// The head check of one reading (wago-kopf.js): the reading, its finding, and
// the heartbeat watch's verdict - plus the head report of the probe channel.

// Qualities of a reading's values.
const (
	QualitaetGut = "good"
	QualitaetAlt = "stale"
	// StehtAb readings with a standing heartbeat freeze the values (§3).
	StehtAb = 3
	// Schrittgrenze is the largest step over 65 535 that is still an overflow.
	Schrittgrenze = 120
	// FindingErrorClass is the source status of a foreign image.
	FindingErrorClass = "layout_changed"
)

// Befund is the finding about the program behind the address: only a
// foreign signature or major version - any other reason is about the plant.
type Befund struct {
	Finding    string `json:"finding"`
	Grund      string `json:"grund"`
	ErrorClass string `json:"error_class"`
	Message    string `json:"message"`
}

// BefundVon is befund(): nil without a finding.
func BefundVon(l Lesung) *Befund {
	if l.Grund == nil || (*l.Grund != "signatur_fremd" && *l.Grund != "hauptversion_fremd") {
		return nil
	}
	return &Befund{Finding: "registerbild_unbekannt", Grund: *l.Grund, ErrorClass: FindingErrorClass,
		Message: "Unter dieser Adresse steht nicht das VoltPilot-Registerbild v1 " +
			"(Signatur oder Version fremd) - es wurde kein Kartenwert uebernommen."}
}

type wachtStand struct {
	herzschlag, steht int
}

// HerzschlagWacht counts standing heartbeats per controller across readings.
type HerzschlagWacht struct {
	stand map[string]wachtStand
}

// Beobachtung is what one heartbeat means.
type Beobachtung struct {
	Urteil    *string
	Steht     int
	Qualitaet string
	Vorher    *int
	Nachher   *int
}

func urteilen(urteil *string, steht int, vorher, nachher *int) Beobachtung {
	q := QualitaetGut
	if steht >= StehtAb {
		q = QualitaetAlt
	}
	return Beobachtung{Urteil: urteil, Steht: steht, Qualitaet: q, Vorher: vorher, Nachher: nachher}
}

// Beobachte takes one reading's heartbeat (nil = no readable head, which
// changes nothing).
func (h *HerzschlagWacht) Beobachte(steuerung string, herzschlag *int) Beobachtung {
	if h.stand == nil {
		h.stand = map[string]wachtStand{}
	}
	vorher, da := h.stand[steuerung]
	if herzschlag == nil {
		return urteilen(nil, vorher.steht, nil, nil)
	}
	var vh *int
	if da {
		vh = zahl(vorher.herzschlag)
	}
	u := HerzschlagUrteil(vh, *herzschlag, Schrittgrenze)
	steht := 0
	if u == "steht" {
		steht = vorher.steht + 1
	}
	h.stand[steuerung] = wachtStand{herzschlag: *herzschlag, steht: steht}
	return urteilen(&u, steht, vh, zahl(*herzschlag))
}

// Vergiss drops a controller.
func (h *HerzschlagWacht) Vergiss(steuerung string) { delete(h.stand, steuerung) }

// Gepruefte is pruefeLesung(): the reading with finding and heartbeat verdict;
// Qualitaet only for a recognised image.
type Gepruefte struct {
	Lesung
	Befund            *Befund `json:"befund"`
	HerzschlagUrteil  *string `json:"herzschlag_urteil"`
	Steht             int     `json:"steht"`
	HerzschlagVorher  *int    `json:"herzschlag_vorher"`
	HerzschlagNachher *int    `json:"herzschlag_nachher"`
	Qualitaet         *string `json:"qualitaet"`
}

// PruefeLesung judges one reading of steuerung (wacht nil: no watch).
func PruefeLesung(w []uint16, steuerung string, p Parameter, soll *Soll, wacht *HerzschlagWacht) Gepruefte {
	l := LiesRegisterbild(w, p, soll)
	var hs *int
	if l.Kopf != nil {
		hs = zahl(l.Kopf.Herzschlag)
	}
	b := Beobachtung{Qualitaet: QualitaetGut}
	if wacht != nil {
		b = wacht.Beobachte(steuerung, hs)
	}
	g := Gepruefte{Lesung: l, Befund: BefundVon(l), HerzschlagUrteil: b.Urteil, Steht: b.Steht,
		HerzschlagVorher: b.Vorher, HerzschlagNachher: b.Nachher}
	if l.Ergebnis == "erkannt" {
		q := b.Qualitaet
		g.Qualitaet = &q
	}
	return g
}

// KopfBericht is kopfBericht(): what a head read on the probe channel shows -
// the head, recognised or the reason why not; the nameplate only as display.
type KopfBericht struct {
	SignaturOK        bool    `json:"signatur_ok"`
	Erkannt           bool    `json:"erkannt"`
	Grund             string  `json:"grund,omitempty"`
	Hauptversion      *int    `json:"hauptversion,omitempty"`
	Nebenversion      *int    `json:"nebenversion,omitempty"`
	Kopflaenge        *int    `json:"kopflaenge,omitempty"`
	Kartenblocklaenge *int    `json:"kartenblocklaenge,omitempty"`
	Kartenzahl        *int    `json:"kartenzahl,omitempty"`
	Herzschlag        *int    `json:"herzschlag,omitempty"`
	ControllerKennung *uint32 `json:"controller_kennung,omitempty"`
	Typenschild       *string `json:"typenschild,omitempty"`
}

// BerichteKopf reports the twelve head words in a word order; typenschild nil
// = not asked.
func BerichteKopf(w []uint16, wortfolge string, typenschild []uint16) KopfBericht {
	var schild *string
	if typenschild != nil {
		schild = liesTypenschild(typenschild)
	}
	b := KopfBericht{Typenschild: schild}
	if len(w) < KopflaengeMin {
		b.Grund = "laenge_ungueltig"
		return b
	}
	if w[kopfSignatur1] != Signatur1 || w[kopfSignatur2] != Signatur2 {
		b.Grund = "signatur_fremd"
		return b
	}
	b.SignaturOK = true
	hv := int(w[kopfHauptversion])
	b.Hauptversion = &hv
	if hv != Hauptversion {
		b.Grund = "hauptversion_fremd"
		return b
	}
	kopf, block := int(w[kopfKopflaenge]), int(w[kopfBlocklaenge])
	if kopf < KopflaengeMin || block < KartenblocklaengeMin {
		b.Grund = "laenge_ungueltig"
		return b
	}
	if Wert32(w, kopfPruefwert, wortfolge) != WortfolgePruefwert {
		b.Grund = "wortfolge_abweichend"
		return b
	}
	b.Erkannt = true
	kennung := Wert32(w, kopfKennung, wortfolge)
	b.Nebenversion, b.Kopflaenge, b.Kartenblocklaenge = zahl(int(w[kopfNebenversion])), &kopf, &block
	b.Kartenzahl, b.Herzschlag, b.ControllerKennung = zahl(int(w[kopfKartenzahl])), zahl(int(w[kopfHerzschlag])), &kennung
	return b
}
