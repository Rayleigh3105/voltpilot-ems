package koppelbild

// The box's judgement of a reading over time (contract §10): may it write in
// the next tick, and may that telegram carry wishes?

// The Lagen of contract §10.
const (
	LageBereit           = "bereit"
	LageGesperrt         = "gesperrt"
	LageSpsNeustart      = "sps_neustart"
	LageSpsSteht         = "sps_steht"
	LageZweiterSchreiber = "zweiter_schreiber"
	LageSteuerungFremd   = "steuerung_fremd"
	LageNichtLesbar      = "nicht_lesbar"
	LageKeineAntwort     = "keine_antwort"
	LageOhneSoll         = "ohne_soll"
)

const (
	// StehtAbLesung: the same SPS heartbeat from the third reading in a row.
	StehtAbLesung = 3
	// Schrittgrenze: a backward step of more than this is a restart (as in
	// the Erzeuger image); a smaller one is the 65535 -> 0 overflow.
	Schrittgrenze = 120
	// RuheLesungen: after a second writer the box writes again only once
	// angenommen_zaehler stood still this many readings (60 s).
	RuheLesungen = 12
)

// Urteil is what a reading allows.
type Urteil struct {
	Lage     string `json:"lage"`
	Schreibt bool   `json:"schreibt"`
	Wuenscht bool   `json:"wuenscht"`
}

func urteil(lage string) Urteil {
	switch lage {
	case LageBereit, LageSpsNeustart:
		return Urteil{Lage: lage, Schreibt: true, Wuenscht: true}
	case LageGesperrt:
		return Urteil{Lage: lage, Schreibt: true}
	}
	return Urteil{Lage: lage}
}

// Lage follows the readings of one controller. The zero value is a box that
// just started.
type Lage struct {
	vorige        *Kopf
	gleich        int
	geschrieben   int
	jeGeschrieben bool
	sitzung       uint16
	zweiter       bool
	ruhe          int
}

// Schrieb notes one own telegram of the session.
func (z *Lage) Schrieb(sitzung uint16) {
	z.geschrieben++
	z.jeGeschrieben = true
	z.sitzung = sitzung
}

// Nach judges one reading; nil is "Modbus did not answer".
func (z *Lage) Nach(l *Lesung) Urteil {
	if l == nil {
		z.vorige, z.gleich, z.geschrieben = nil, 0, 0
		return urteil(LageKeineAntwort)
	}
	if !l.Lesbar() {
		// Own telegrams count since the last READABLE reading.
		return urteil(LageNichtLesbar)
	}
	geschrieben := z.geschrieben
	z.geschrieben = 0
	k := l.Kopf
	if l.Grund == "steuerung_id_abweichend" {
		z.vorige, z.gleich = k, 0
		return urteil(LageSteuerungFremd)
	}
	neustart := false
	if z.vorige != nil {
		alt, neu := z.vorige.Herzschlag, k.Herzschlag
		if neu == alt {
			z.gleich++
		} else {
			z.gleich = 1
			if neu < alt && neu-alt > Schrittgrenze { // uint16: (neu - alt) mod 65536
				neustart = true
			}
		}
	} else {
		z.gleich = 1
	}
	vorige := z.vorige
	z.vorige = k
	if z.gleich >= StehtAbLesung {
		return urteil(LageSpsSteht)
	}
	if z.zweiter {
		if vorige != nil && k.AngenommenZaehler != vorige.AngenommenZaehler {
			z.ruhe = 0
		} else {
			z.ruhe++
		}
		if z.ruhe < RuheLesungen {
			return urteil(LageZweiterSchreiber)
		}
		z.zweiter = false
	}
	ku := ""
	if k.KopfUrteil != nil {
		ku = *k.KopfUrteil
	}
	if neustart || (ku == "keins" && z.jeGeschrieben && vorige != nil &&
		(vorige.KopfUrteil == nil || *vorige.KopfUrteil != "keins")) {
		return urteil(LageSpsNeustart)
	}
	if geschrieben > 0 && vorige != nil && (ku == "angenommen" || ku == "gesperrt") {
		mehr := int(k.AngenommenZaehler-vorige.AngenommenZaehler) > geschrieben
		if k.QSitzung != z.sitzung || mehr {
			z.zweiter, z.ruhe = true, 0
			return urteil(LageZweiterSchreiber)
		}
	}
	if ku == "gesperrt" || (k.QBits != nil && !k.HatQBit("fernsteuerung_frei")) {
		return urteil(LageGesperrt)
	}
	return urteil(LageBereit)
}
