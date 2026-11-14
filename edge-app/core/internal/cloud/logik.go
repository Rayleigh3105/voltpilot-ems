package cloud

// LogikSummary is the additive status-heartbeat block "logik"
// (docs/contracts/v2/steuerlogik-rueckmeldung.md): which Steuerlogik runs
// along on this box in which version, its state, and the comparison log
// "würde schalten" (the core's wish) against "ist geschaltet" (the observed
// switch state). Strictly REPORTING - in this stage the core switches nothing.
// nil = nothing runs along (block omitted, the heartbeat stays byte for byte
// what it was).
type LogikSummary struct {
	Laeufe []LogikLauf `json:"laeufe"`
}

// LogikLauf is one logic running along.
type LogikLauf struct {
	FlowID      string `json:"flow_id"`
	FlowVersion int    `json:"flow_version"`
	ContentHash string `json:"content_hash"`
	Name        string `json:"name"`
	// Zustand is "mitlaufend" in this stage: computing, never switching.
	Zustand string `json:"zustand"`
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
