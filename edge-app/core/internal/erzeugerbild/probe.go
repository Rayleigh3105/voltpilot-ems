package erzeugerbild

import (
	"context"
	"strings"
)

// The probe op erzeuger_kopf on the local bus - the twin of runErzeugerKopf
// in vp-modbus-probe.js. The core admits the op (identity, expiry, private
// target, rate limit) and hands it down edge/probe/request; Edge Light reads
// it here and answers on edge/probe/result. The node DECODES, the core JUDGES
// (agent.erzeugerKopfResult) - the same split as on the Docker box.

// OpErzeugerKopf names the op on the bus.
const OpErzeugerKopf = "erzeuger_kopf"

// ProbeOp is one already-validated step as it comes down the local bus.
type ProbeOp struct {
	ID        string `json:"id"`
	Op        string `json:"op,omitempty"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	UnitID    int    `json:"unit_id"`
	FC        int    `json:"fc"`
	Address   int    `json:"address"`
	DataType  string `json:"data_type,omitempty"`
	WordOrder string `json:"word_order"`
	// Nameplate: wago_kopf only - also read the controller's nameplate.
	Nameplate bool `json:"nameplate,omitempty"`
}

// ProbeErgebnis is one answered step on edge/probe/result.
type ProbeErgebnis struct {
	ID           string       `json:"id"`
	OK           bool         `json:"ok"`
	ErrorCode    string       `json:"error_code,omitempty"`
	Message      string       `json:"message,omitempty"`
	ErzeugerKopf *KopfBericht `json:"erzeuger_kopf,omitempty"`
}

// ProbeVerbindung is where a probe step reads.
type ProbeVerbindung struct {
	Host   string
	Port   int
	UnitID int
	FC     int
}

// ProbeLeser reads count words from start; on failure the error class
// (unreachable, no_answer, invalid_response, timeout) and the original text.
type ProbeLeser func(ctx context.Context, v ProbeVerbindung, start, count int) ([]uint16, string, string)

// Probe error codes (docs/contracts/mqtt-probe.schema.json).
const (
	ProbeUngueltig      = "invalid_request"
	ProbeUnerreichbar   = "unreachable"
	ProbeKeineAntwort   = "no_answer"
	ProbeUnlesbar       = "invalid_response"
	ProbeZeit           = "timeout"
	ProbeNichtGestuetzt = "not_supported"
)

// probeSaetze are the German sentences of vp-modbus-probe.js classify().
var probeSaetze = map[string]string{
	ProbeUnerreichbar: "Das Gerät ist unter dieser Adresse nicht erreichbar.",
	ProbeKeineAntwort: "Das Gerät antwortet nicht auf diese Anfrage (Unit-ID und Register prüfen).",
	ProbeZeit:         "Das Gerät wird gerade von einer anderen Abfrage belegt. Bitte erneut versuchen.",
}

// ProbeSatz is the customer sentence of an error class, with the original
// text behind it - nothing is lost on the way up.
func ProbeSatz(klasse, text string) (string, string) {
	satz, ok := probeSaetze[klasse]
	if !ok {
		klasse = ProbeUnlesbar
		satz = "Die Antwort des Geräts war nicht lesbar"
		if text == "" {
			return klasse, satz + "."
		}
		return klasse, satz + " (" + text + ")."
	}
	if text == "" {
		return klasse, satz
	}
	return klasse, satz + " (" + text + ")"
}

func probeVerbindung(op ProbeOp) (ProbeVerbindung, bool) {
	host := strings.TrimSpace(op.Host)
	if host == "" || op.Address < 0 || op.Address > 65535 {
		return ProbeVerbindung{}, false
	}
	v := ProbeVerbindung{Host: host, Port: op.Port, UnitID: op.UnitID, FC: 3}
	if v.Port < 1 || v.Port > 65535 {
		v.Port = 502
	}
	if v.UnitID < 0 || v.UnitID > 255 {
		v.UnitID = 1
	}
	if op.FC == 4 {
		v.FC = 4
	}
	return v, true
}

// KopfProbe runs one erzeuger_kopf op: read the head; behind a recognised
// head the unit blocks and the names, each in parts of documented length. A
// failed head read fails the op with its class; failed unit blocks make the
// image incomplete (zu_wenig_woerter); failed names are simply absent - an
// image may carry none.
func KopfProbe(ctx context.Context, op ProbeOp, lies ProbeLeser) ProbeErgebnis {
	v, ok := probeVerbindung(op)
	if !ok {
		return ProbeErgebnis{ID: op.ID, ErrorCode: ProbeUngueltig, Message: "Der Prüfschritt ist unvollständig."}
	}
	wortfolge := "big"
	if op.WordOrder == "little" {
		wortfolge = "little"
	}
	kopf, klasse, text := lies(ctx, v, op.Address, Kopflaenge)
	if klasse != "" {
		code, satz := ProbeSatz(klasse, text)
		return ProbeErgebnis{ID: op.ID, ErrorCode: code, Message: satz}
	}
	grund, k := LiesKopf(kopf, wortfolge)
	if grund != "" {
		b := Bericht(kopf, wortfolge, nil, nil)
		return ProbeErgebnis{ID: op.ID, OK: true, ErzeugerKopf: &b}
	}
	teil := func(t KopfTeil) []uint16 {
		w, klasse, _ := lies(ctx, v, t.Start, t.Count)
		if klasse != "" || len(w) < t.Count {
			return nil
		}
		return w[:t.Count]
	}
	teile := KopfPlan(op.Address, k)
	einheiten := teil(teile[0])
	var namen []uint16
	if einheiten != nil && len(teile) > 1 {
		namen = []uint16{}
		for _, t := range teile[1:] {
			w := teil(t)
			if w == nil {
				namen = nil
				break
			}
			namen = append(namen, w...)
		}
	}
	b := Bericht(kopf, wortfolge, einheiten, namen)
	return ProbeErgebnis{ID: op.ID, OK: true, ErzeugerKopf: &b}
}
