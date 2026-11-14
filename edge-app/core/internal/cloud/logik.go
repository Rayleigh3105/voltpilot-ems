package cloud

// LogikSummary is the additive status-heartbeat block "logik"
// (docs/contracts/v2/steuerlogik-rueckmeldung.md): which Steuerlogik runs on
// this box in which version and state (along or armed), and the comparison
// log "würde schalten" (the core's wish) against "ist geschaltet" (the
// observed switch state). An armed logic adds what the arbiter granted and
// why a wish was held back, its set values with their help sentences and the
// "Warum?" list. nil = no logic runs (block omitted, the heartbeat stays byte
// for byte what it was).
type LogikSummary struct {
	Laeufe []LogikLauf `json:"laeufe"`
}

// LogikLauf is one logic running along.
type LogikLauf struct {
	FlowID      string `json:"flow_id"`
	FlowVersion int    `json:"flow_version"`
	ContentHash string `json:"content_hash"`
	Name        string `json:"name"`
	// Zustand is "mitlaufend" (computing, never switching) or "scharf" (its
	// wishes go to the arbiter, its devices belong to it).
	Zustand string `json:"zustand"`
	// ScharfSeit is when this box began switching after this logic (RFC 3339).
	ScharfSeit string `json:"scharf_seit,omitempty"`
	// Halt says why an armed logic switches nothing right now (the box's
	// switches are off, "Automatik pausieren"); nil = it switches.
	Halt *LogikHalt `json:"halt,omitempty"`
	// Seit is when this version started running along on this box (RFC 3339).
	Seit string `json:"seit"`
	// Tag is the local day (YYYY-MM-DD) the counters below belong to; they
	// start over at local midnight and after a restart of the box program.
	Tag  string     `json:"tag"`
	Lage *LogikLage `json:"lage,omitempty"`
	// Zustaende is the remembered state in short form: on/off, a counter
	// value, or the remaining time of a timer.
	Zustaende map[string]string `json:"zustaende,omitempty"`
	// Unbekannt names the inputs without a fresh value right now - the
	// honest gap of the plant (never filled with a guess).
	Unbekannt []string `json:"unbekannt,omitempty"`
	// Fehler counts today's expressions the core could not compute.
	Fehler  int                    `json:"fehler,omitempty"`
	Geraete map[string]LogikGeraet `json:"geraete,omitempty"`
	// Wechsel are the latest changes of wish and observed state, oldest first,
	// at most the contract's bound; Nr counts up per run so a reader sees a gap.
	Wechsel []LogikWechsel `json:"wechsel,omitempty"`
	// Stellwerte are the set values as they apply in the run, with their revision.
	Stellwerte *LogikStellwerte `json:"stellwerte,omitempty"`
	// Warum is the "Warum?" list: per state the named conditions that decide
	// next, with their standing and the values behind them.
	Warum []LogikWarum `json:"warum,omitempty"`
	// Meldungen are the logic's own latest notifications, oldest first.
	Meldungen []LogikMeldung `json:"meldungen,omitempty"`
}

// LogikHalt is a reason in code and sentence.
type LogikHalt struct {
	Code string `json:"code"`
	Text string `json:"text"`
}

// LogikStellwerte are the set values of a run: Stand is the revision the box
// applied (the portal shows a value as taken once this reaches it).
type LogikStellwerte struct {
	Stand int64            `json:"stand"`
	Werte []LogikStellwert `json:"werte,omitempty"`
}

// LogikStellwert is one set value: the document's form, its display text and
// the help sentence with today's values.
type LogikStellwert struct {
	Kennung string `json:"kennung"`
	Wert    any    `json:"wert"`
	Text    string `json:"text"`
	Hilfe   string `json:"hilfe,omitempty"`
}

// LogikWarum is one group of the "Warum?" list. Satz is its heading for the
// customer: the logic's own sentence with today's values (Eigen), else one the
// core builds from its vocabulary - never the identifier of a state or step.
type LogikWarum struct {
	Zustand     string           `json:"zustand"`
	Name        string           `json:"name"`
	Satz        string           `json:"satz"`
	Eigen       bool             `json:"eigen,omitempty"`
	Was         string           `json:"was"`
	Schritt     string           `json:"schritt,omitempty"`
	Modus       string           `json:"modus"`
	WartetS     int              `json:"wartet_s,omitempty"`
	Bedingungen []LogikBedingung `json:"bedingungen"`
}

// LogikBedingung is a named condition with its standing; Ok null = unknown.
type LogikBedingung struct {
	Name string `json:"name"`
	Ok   *bool  `json:"ok"`
	// Allgemein: an unnamed condition the core could not put into a sentence;
	// Name is then the general sentence. Name is never a formula.
	Allgemein bool        `json:"allgemein,omitempty"`
	Werte     []LogikWert `json:"werte,omitempty"`
}

// LogikWert is a value inside a condition.
type LogikWert struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

// LogikMeldung is one notification of the logic (its notifications section).
type LogikMeldung struct {
	Nr   int64    `json:"nr"`
	T    string   `json:"t"`
	An   []string `json:"an,omitempty"`
	Text string   `json:"text"`
}

// LogikLage is the state of the logic as title and sentence for the customer.
type LogikLage struct {
	Nr    int    `json:"nr"`
	Titel string `json:"titel"`
	Art   string `json:"art,omitempty"`
	Satz  string `json:"satz,omitempty"`
}

// LogikGeraet is the comparison for one device of the logic today.
type LogikGeraet struct {
	EntityID string `json:"entity_id"`
	// Name is the device's name in the logic (devices.<kennung>.name).
	Name string `json:"name,omitempty"`
	// Wunsch is what the core would switch now; nil = no wish this second.
	Wunsch *LogikStand `json:"wunsch,omitempty"`
	// Ist is the observed switch state; nil = unknown (never "off").
	Ist *LogikStand `json:"ist,omitempty"`
	// VerglichenS counts the seconds both sides were known, AbweichendS those
	// of them where they differed, LaengsteAbweichungS the longest such run.
	VerglichenS         int `json:"verglichen_s"`
	AbweichendS         int `json:"abweichend_s"`
	LaengsteAbweichungS int `json:"laengste_abweichung_s"`
	WunschWechsel       int `json:"wunsch_wechsel"`
	IstWechsel          int `json:"ist_wechsel"`
	// Armed only: Befehl is what the arbiter granted the device (after the
	// guards), Halter the source holding it when that is not this logic (e.g.
	// "local-ui" for a manual intervention), Schutz a guard that held the wish
	// back, Konflikt a second master the box refused to fight.
	Befehl   *LogikStand `json:"befehl,omitempty"`
	Halter   string      `json:"halter,omitempty"`
	Schutz   *LogikHalt  `json:"schutz,omitempty"`
	Konflikt *LogikHalt  `json:"konflikt,omitempty"`
}

// LogikStand is a switch state: a level (outputs on), on/off, a setpoint, a
// mode or a share. Only the fields the output kind has are set.
type LogikStand struct {
	Stufe       *int     `json:"stufe,omitempty"`
	Ein         *bool    `json:"ein,omitempty"`
	Sollwert    *float64 `json:"sollwert,omitempty"`
	Betriebsart string   `json:"betriebsart,omitempty"`
	Anteil      *float64 `json:"anteil,omitempty"`
}

// LogikWechsel is one line of the comparison log.
type LogikWechsel struct {
	Nr     int64  `json:"nr"`
	T      string `json:"t"`
	Geraet string `json:"geraet"`
	// Was is "wunsch" (the core changed its wish) or "ist" (the observed
	// state changed).
	Was string `json:"was"`
	// Neu is the new value of that side, Andere the other side in the same
	// second; nil = unknown.
	Neu    *LogikStand `json:"neu,omitempty"`
	Andere *LogikStand `json:"andere,omitempty"`
	// Lage is the title of the logic's state in that second.
	Lage string `json:"lage,omitempty"`
}
