package erzeugerbild

import (
	"regexp"
	"time"
)

// The stage of the Erzeuger way - the twin of erzeuger-ereignisse.js. It
// checks nothing a second time; every number and reason comes from Lies. It
// only says what FOLLOWS:
//
//  1. Finding: a foreign signature or major version means this address does
//     not carry the Erzeuger image v1 (registerbild_unbekannt); every reason
//     travels on the findings path as layout_changed.
//  2. stale from the third equal reading of the heartbeat, per controller
//     (contract §8: readings are counted, not transitions).
//  3. uncertain for the grid point when a_alter_s is above the threshold
//     (default 30 s); a_alter_s dates the grid-point measurement only.
//  4. Events, each once per change of state: frozen_source (heartbeat stands)
//     and device_restart (heartbeat jumps back - the program restarted).

// StehtAb is the number of standing TRANSITIONS at which the third equal
// reading is reached.
const StehtAb = 2

// AlterSchwelleS is the default a_alter_s above which the grid point is
// uncertain (concept §4.3).
const AlterSchwelleS = 30

// Schrittgrenze is the largest heartbeat step back that is still an overflow.
const Schrittgrenze = 120

// Qualities of a value (mqtt-measurement-samples 2.1).
const (
	QualitaetGut       = "good"
	QualitaetAlt       = "stale"
	QualitaetUnsicher  = "uncertain"
	QualitaetUngueltig = "invalid"
)

// FindingErrorClass is the class every reason travels as on the findings
// path of the data source - the vocabulary of the source contract is closed.
const FindingErrorClass = "layout_changed"

// Ereignis is a device event for edge/events (contract mqtt-events 2.1,
// $defs/box_*): the box core adds identity, envelope and sequence.
type Ereignis struct {
	Art               string `json:"art"`
	Zeitpunkt         string `json:"zeitpunkt"`
	Datenquelle       string `json:"datenquelle"`
	Komponente        string `json:"komponente,omitempty"`
	Lesungen          *int   `json:"lesungen,omitempty"`
	Herzschlag        *int   `json:"herzschlag,omitempty"`
	HerzschlagVorher  *int   `json:"herzschlag_vorher,omitempty"`
	HerzschlagNachher *int   `json:"herzschlag_nachher,omitempty"`
}

// EreignisTopic is the local bus branch of device events.
const EreignisTopic = "edge/events"

var kennungMuster = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)

func kennungOK(s string) bool {
	return len(s) >= 1 && len(s) <= 128 && kennungMuster.MatchString(s)
}

// Zeit is the contract's one spelling of a point in time: UTC, to the second,
// with Z (device-events.js zeit).
func Zeit(t time.Time) string {
	return t.UTC().Truncate(time.Second).Format("2006-01-02T15:04:05Z")
}

// gueltig is device-events.js ereignis(): an event with a missing mandatory
// field or a malformed identifier is not sent at all - a wrong word costs the
// whole envelope in the cloud.
func (e Ereignis) gueltig() bool {
	if !kennungOK(e.Datenquelle) {
		return false
	}
	if e.Komponente != "" && !kennungOK(e.Komponente) {
		return false
	}
	return true
}

type wachtStand struct {
	herzschlag int
	steht      int
}

// Beobachtung is what one heartbeat reading means.
type Beobachtung struct {
	Urteil    string // "" (not observed), erste_lesung, laeuft, steht, ueberlauf, rueckwaerts
	Steht     int
	Qualitaet string
	Vorher    *int
	Nachher   *int
}

// Wacht counts standing readings per controller - the HerzschlagWacht of the
// WAGO way with stehtAb 2.
type Wacht struct {
	stand map[string]wachtStand
}

func (w *Wacht) urteilen(urteil string, steht int, vorher, nachher *int) Beobachtung {
	q := QualitaetGut
	if steht >= StehtAb {
		q = QualitaetAlt
	}
	return Beobachtung{Urteil: urteil, Steht: steht, Qualitaet: q, Vorher: vorher, Nachher: nachher}
}

// Beobachte takes the heartbeat of one reading; nil = no readable head, which
// is no observation: the state stays as it is and never becomes "steht".
func (w *Wacht) Beobachte(steuerung string, herzschlag *int) Beobachtung {
	if w.stand == nil {
		w.stand = map[string]wachtStand{}
	}
	vorher, da := w.stand[steuerung]
	if herzschlag == nil {
		return w.urteilen("", vorher.steht, nil, nil)
	}
	var vh *int
	if da {
		vh = zeiger(vorher.herzschlag)
	}
	urteil := HerzschlagUrteil(vh, *herzschlag, Schrittgrenze)
	steht := 0
	if urteil == "steht" {
		steht = vorher.steht + 1
	}
	w.stand[steuerung] = wachtStand{herzschlag: *herzschlag, steht: steht}
	return w.urteilen(urteil, steht, vh, zeiger(*herzschlag))
}

// Vergiss drops a controller that left the plan.
func (w *Wacht) Vergiss(steuerung string) { delete(w.stand, steuerung) }

// Befund is the finding about a reading; nil = no finding about the program.
type Befund struct {
	Finding    string
	Grund      string
	ErrorClass string
	Message    string
}

// FindingSatz is the German sentence of the finding.
const FindingSatz = "Unter dieser Adresse steht nicht das VoltPilot-Registerbild Erzeuger v1 " +
	"(Signatur oder Version fremd) - es wurde kein Wert übernommen."

// BefundVon: only a foreign signature or major version is a finding about the
// program in the controller.
func BefundVon(l Lesung) *Befund {
	if l.Grund != GrundSignaturFremd && l.Grund != GrundVersionFremd {
		return nil
	}
	return &Befund{Finding: "registerbild_unbekannt", Grund: l.Grund, ErrorClass: FindingErrorClass,
		Message: FindingSatz}
}

// Stufe is the Erzeuger stage of ONE box: the heartbeat per controller and
// whether the freeze is already reported.
type Stufe struct {
	wacht       Wacht
	eingefroren map[string]bool
}

// StufenLesung is a reading with its consequences.
type StufenLesung struct {
	Lesung
	Befund           *Befund
	HerzschlagUrteil string
	Steht            int
	// Qualitaet of the whole image ("" when not recognised).
	Qualitaet  string
	Ereignisse []Ereignis
}

// LesungAuswerten judges one reading. steuerung is the key the heartbeat
// counts under (the target); datenquelle the data source id; komponente the
// controller's component when known.
func (s *Stufe) LesungAuswerten(w []uint16, steuerung, wortfolge string, soll *Soll,
	datenquelle, komponente string, jetzt time.Time) StufenLesung {
	if s.eingefroren == nil {
		s.eingefroren = map[string]bool{}
	}
	gelesen := Lies(w, wortfolge, soll)
	// Only a READABLE image is a heartbeat observation - also one that merely
	// does not match the Soll. An unreadable reading never becomes "steht".
	lesbar := gelesen.Ergebnis == ErgebnisErkannt || istSollGrund(gelesen.Grund)
	var herzschlag *int
	if lesbar && gelesen.Kopf != nil {
		herzschlag = zeiger(gelesen.Kopf.Herzschlag)
	}
	b := s.wacht.Beobachte(steuerung, herzschlag)
	var raus []Ereignis
	melde := func(e Ereignis) {
		e.Zeitpunkt = Zeit(jetzt)
		e.Datenquelle = datenquelle
		if e.gueltig() {
			raus = append(raus, e)
		}
	}
	if b.Urteil == "rueckwaerts" {
		melde(Ereignis{Art: "device_restart", HerzschlagVorher: b.Vorher, HerzschlagNachher: b.Nachher})
	}
	steht := b.Qualitaet == QualitaetAlt
	if steht && !s.eingefroren[steuerung] {
		// lesungen counts the equal READINGS (transitions + 1).
		melde(Ereignis{Art: "frozen_source", Komponente: komponente, Lesungen: zeiger(b.Steht + 1),
			Herzschlag: b.Nachher})
	}
	if b.Steht == 0 {
		delete(s.eingefroren, steuerung)
	} else if steht {
		s.eingefroren[steuerung] = true
	}
	out := StufenLesung{Lesung: gelesen, Befund: BefundVon(gelesen), HerzschlagUrteil: b.Urteil,
		Steht: b.Steht, Ereignisse: raus}
	if gelesen.Ergebnis != ErgebnisErkannt {
		return out
	}
	out.Qualitaet = b.Qualitaet
	schwelle := AlterSchwelleS
	if soll != nil && soll.AlterSchwelleS != nil {
		schwelle = *soll.AlterSchwelleS
	}
	zuAlt := false
	for _, v := range gelesen.Werte {
		if v.Feld == "a_alter_s" && v.Wert != nil && *v.Wert > float64(schwelle) {
			zuAlt = true
		}
	}
	werte := make([]Wert, len(gelesen.Werte))
	for i, v := range gelesen.Werte {
		switch {
		case v.Grund == LeerFremd:
			v.Qualitaet = QualitaetUngueltig
		case v.Wert == nil:
			v.Qualitaet = ""
		case steht:
			v.Qualitaet = QualitaetAlt
		case zuAlt && v.Feld == "p_nvp_w":
			v.Qualitaet = QualitaetUnsicher
		default:
			v.Qualitaet = QualitaetGut
		}
		werte[i] = v
	}
	out.Werte = werte
	return out
}

// Vergiss drops a controller that left the plan: its state must not outlive
// it into a later one.
func (s *Stufe) Vergiss(steuerung string) {
	s.wacht.Vergiss(steuerung)
	delete(s.eingefroren, steuerung)
}
