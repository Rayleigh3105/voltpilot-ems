package modbusprofil

import (
	"context"
	"strings"
)

// The plain register read of the probe channel ("Register einmal lesen", the
// register preview of the self-build assistant) - the twin of the read op of
// vp-modbus-probe.js. The core admits the op (identity, expiry, private target,
// rate limit; internal/probe) and hands it down edge/probe/request without an
// `op` field; the executor reads, decodes the value and answers raw value plus
// the register words on edge/probe/result. Scaling is display arithmetic and
// stays in the core (probe.Op.Scaled).

// Probe error codes (docs/contracts/mqtt-probe.schema.json).
const (
	ErrInvalidRequest  = "invalid_request"
	ErrUnreachable     = "unreachable"
	ErrNoAnswer        = "no_answer"
	ErrInvalidResponse = "invalid_response"
	ErrTimeout         = "timeout"
)

// The beginnings of the failure messages of the palette's connection manager
// (lib/modbus-conn.js) and codec (modbus-tcp.js). A reader names its failures
// with them, so Klassifiziere finds the same class on both box types.
const (
	MeldungAufbauTimeout = "Verbindungsaufbau-Timeout"
	MeldungAufbau        = "Verbindung fehlgeschlagen: "
	MeldungAntwortZeit   = "Antwort-Timeout"
	MeldungGesamtZeit    = "Gesamt-Timeout"
	MeldungGeschlossen   = "Verbindung geschlossen ohne Antwort"
	MeldungAusnahme      = "Modbus-Ausnahme"
	MeldungWarteschlange = "Warteschlange"
)

// klassen is classify()'s closed table: the message prefix, the class and the
// customer sentence. The distinction the customer acts on:
//
//	unreachable      - nobody at that address (wrong IP, device off, firewall)
//	no_answer        - somebody is there but does not answer THIS question
//	invalid_response - a frame came back that is not what was asked for
//	timeout          - the box never got round to asking (the device was busy)
var klassen = []struct{ anfang, code, satz string }{
	{MeldungAufbauTimeout, ErrUnreachable, "Das Gerät ist unter dieser Adresse nicht erreichbar."},
	{"Verbindung fehlgeschlagen", ErrUnreachable, "Das Gerät ist unter dieser Adresse nicht erreichbar."},
	{MeldungAntwortZeit, ErrNoAnswer, "Das Gerät antwortet nicht auf diese Anfrage (Unit-ID und Register prüfen)."},
	{MeldungGesamtZeit, ErrNoAnswer, "Das Gerät antwortet nicht auf diese Anfrage (Unit-ID und Register prüfen)."},
	{MeldungGeschlossen, ErrNoAnswer, "Das Gerät hat die Verbindung ohne Antwort beendet."},
	{MeldungAusnahme, ErrNoAnswer, "Das Gerät weist die Anfrage ab - dieses Register gibt es dort vermutlich nicht."},
	{MeldungWarteschlange, ErrTimeout, "Das Gerät wird gerade von einer anderen Abfrage belegt. Bitte erneut versuchen."},
}

// Klassifiziere maps a failure message onto its class and the sentence the
// customer reads; the original text always travels along. Anything unplaceable
// is invalid_response - a class is never invented.
func Klassifiziere(meldung string) (code, satz string) {
	for _, k := range klassen {
		if strings.HasPrefix(meldung, k.anfang) {
			return k.code, k.satz + " (" + meldung + ")"
		}
	}
	return ErrInvalidResponse, "Die Antwort des Geräts war nicht lesbar (" + meldung + ")."
}

// LeseOp is one plain read step as it comes down the local bus.
type LeseOp struct {
	Host      string
	Port      int
	UnitID    int
	FC        int
	Address   int
	DataType  string
	WordOrder string
}

// Leseplan is what one read step asks the device.
type Leseplan struct {
	Host   string `json:"host"`
	Port   int    `json:"port"`
	UnitID int    `json:"unitId"`
	FC     int    `json:"fc"`
	Addr   int    `json:"addr"`
	Count  int    `json:"count"`
}

// PlanLesen is readPlan(): the read a step asks for, ok=false when the step is
// unusable (no host, an unknown data type, an address outside 0..65535). Port
// and unit outside their ranges fall back to 502 and 1; any FC but 4 reads
// holding registers.
func PlanLesen(op LeseOp) (Leseplan, bool) {
	host := strings.TrimSpace(op.Host)
	count := RegisterCount(op.DataType)
	if host == "" || count == 0 || op.Address < 0 || op.Address > 65535 {
		return Leseplan{}, false
	}
	p := Leseplan{Host: host, Port: op.Port, UnitID: op.UnitID, FC: FcReadHolding, Addr: op.Address, Count: count}
	if p.Port < 1 || p.Port > 65535 {
		p.Port = 502
	}
	if p.UnitID < 0 || p.UnitID > 255 {
		p.UnitID = 1
	}
	if op.FC == FcReadInput {
		p.FC = FcReadInput
	}
	return p, true
}

// Ergebnis is one answered read step on edge/probe/result.
type Ergebnis struct {
	ID        string   `json:"id"`
	OK        bool     `json:"ok"`
	Raw       *float64 `json:"raw,omitempty"`
	Registers []uint16 `json:"registers,omitempty"`
	ErrorCode string   `json:"error_code,omitempty"`
	Message   string   `json:"message,omitempty"`
}

// Leser reads one plan: the words, or the failure message (in the vocabulary
// of the Meldung* prefixes) when meldung != "".
type Leser func(ctx context.Context, p Leseplan) (woerter []uint16, meldung string)

// Lies runs one read step: plan, read, decode. The answer carries the raw
// value AND the register words - a wrong word order is only visible when the
// customer can see the two 16-bit halves.
func Lies(ctx context.Context, id string, op LeseOp, lies Leser) Ergebnis {
	p, ok := PlanLesen(op)
	if !ok {
		return Ergebnis{ID: id, ErrorCode: ErrInvalidRequest, Message: "Der Prüfschritt ist unvollständig."}
	}
	woerter, meldung := lies(ctx, p)
	if meldung != "" {
		code, satz := Klassifiziere(meldung)
		return Ergebnis{ID: id, ErrorCode: code, Message: satz}
	}
	raw, ok := DecodeValue(woerter, op.DataType, op.WordOrder)
	if !ok {
		// A frame came back but does not decode as the requested type.
		return Ergebnis{ID: id, ErrorCode: ErrInvalidResponse,
			Message: "Die Antwort passt nicht zum gewählten Datentyp (" + op.DataType + ")."}
	}
	regs := woerter
	if len(regs) > 2 {
		regs = regs[:2]
	}
	return Ergebnis{ID: id, OK: true, Raw: &raw, Registers: append([]uint16(nil), regs...)}
}
