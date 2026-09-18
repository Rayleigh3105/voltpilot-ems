// Package boxevents builds the box half of the event contract (UEMS AP-07 IP-3):
// the closed vocabulary a BOX may report, its envelope `mqtt-events-2.1` and the
// durable outbox that carries it to `.../v2/events`.
//
// The vocabulary is closed and it is the CLOUD's. This package never invents an
// art, never adds a field and never guesses a version: `mqtt-events-2.1.schema.json`
// plus `services/ingest` BoxEventsValidator decide what is accepted, and one
// rejected entry discards the WHOLE envelope there. An art the box may not report -
// `clock_jump` above all, whose Urheber is `datenannahme` (events-vocabulary.md §4,
// column "Box" = "-") - is therefore refused here instead of being sent and dropped.
package boxevents

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"sync/atomic"
	"time"
)

// Topic is the local bus leaf a Node-RED driver publishes a DEVICE event on.
// The core owns identity (tenant/site/device) and the envelope; a driver only
// ever states what it saw - exactly like edge/data-sources/poll.
const Topic = "edge/events"

// SchemaVersion is the ONE version this runtime speaks. A newer art arrives with
// a newer version, and the cloud knows a version before a box sends it.
const SchemaVersion = "2.1"

// MaxEvents is the contract's per-envelope ceiling (mqtt-events-2.1, maxItems).
const MaxEvents = 64

// SprungSchwelleS is the clock_jump threshold of the provenance contract. The box
// cannot REPORT a jump (no box art exists), so it uses the same threshold only to
// notice that its own wall clock is not to be trusted for a stamp.
const SprungSchwelleS = 300

var (
	uuidMuster       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	kennungMuster    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)
	zeitMuster       = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$`)
	ErrUnbekannteArt = errors.New("art nicht im Box-Vokabular")
)

type feldTyp int

const (
	typUUID feldTyp = iota
	typWort
	typZeit
	typKennung
	typMesskanal
	typGanzAb0
	typGanzAb1
	typStatuswort
	typErkanntAus
)

type artRegel struct {
	pflicht []string
	erlaubt map[string]feldTyp
}

// arten mirrors mqtt-events-2.1.schema.json $defs/box_* one to one. Six arts, no
// more: data_gap (erkannt_aus: verdraengung), box_restart, device_restart,
// frozen_source, range_limit, layout_changed.
var arten = map[string]artRegel{
	"data_gap": {
		pflicht: []string{"ereignis_id", "art", "von", "bis", "erkannt_aus"},
		erlaubt: map[string]feldTyp{"ereignis_id": typUUID, "art": typWort, "von": typZeit,
			"bis": typZeit, "erkannt_aus": typErkanntAus, "datenquelle": typKennung,
			"komponente": typKennung, "messkanal": typMesskanal, "erwartet_fehlend": typGanzAb0},
	},
	"box_restart": {
		pflicht: []string{"ereignis_id", "art", "zeitpunkt"},
		erlaubt: map[string]feldTyp{"ereignis_id": typUUID, "art": typWort, "zeitpunkt": typZeit},
	},
	"device_restart": {
		pflicht: []string{"ereignis_id", "art", "zeitpunkt", "datenquelle"},
		erlaubt: map[string]feldTyp{"ereignis_id": typUUID, "art": typWort, "zeitpunkt": typZeit,
			"datenquelle": typKennung, "herzschlag_vorher": typGanzAb0, "herzschlag_nachher": typGanzAb0},
	},
	"frozen_source": {
		pflicht: []string{"ereignis_id", "art", "zeitpunkt", "datenquelle"},
		erlaubt: map[string]feldTyp{"ereignis_id": typUUID, "art": typWort, "zeitpunkt": typZeit,
			"datenquelle": typKennung, "komponente": typKennung, "messkanal": typMesskanal,
			"lesungen": typGanzAb1, "herzschlag": typGanzAb0},
	},
	"range_limit": {
		pflicht: []string{"ereignis_id", "art", "zeitpunkt", "datenquelle"},
		erlaubt: map[string]feldTyp{"ereignis_id": typUUID, "art": typWort, "zeitpunkt": typZeit,
			"datenquelle": typKennung, "komponente": typKennung, "statuswort": typStatuswort},
	},
	"layout_changed": {
		pflicht: []string{"ereignis_id", "art", "zeitpunkt", "datenquelle"},
		erlaubt: map[string]feldTyp{"ereignis_id": typUUID, "art": typWort, "zeitpunkt": typZeit,
			"datenquelle": typKennung, "fassung_erwartet": typGanzAb1, "fassung_gelesen": typGanzAb1,
			"karten_erwartet": typGanzAb0, "karten_gelesen": typGanzAb0},
	},
}

// TreiberArten are the arts a Node-RED driver may deliver over Topic. The two the
// CORE itself owns - box_restart (its own start) and the data_gap of a buffer
// eviction (its own outbox) - are never accepted from the local bus: a driver
// cannot know either, and a forged one would be indistinguishable from the real
// report.
var TreiberArten = []string{"device_restart", "frozen_source", "range_limit", "layout_changed"}

// Arten lists the closed box vocabulary, sorted, for tests and documentation.
func Arten() []string {
	namen := make([]string, 0, len(arten))
	for name := range arten {
		namen = append(namen, name)
	}
	sort.Strings(namen)
	return namen
}

// Ereignis is ONE validated box event, ready to travel in an envelope. It is a
// map on purpose: the vocabulary is the cloud's, so the shape is checked against
// the contract table instead of being frozen into a Go struct per art.
type Ereignis map[string]any

// Pruefe validates one event against the closed table: known art, every required
// field present, no unknown field, every field of the declared type. It returns a
// COPY, so a caller cannot mutate what was checked.
func Pruefe(roh map[string]any) (Ereignis, error) {
	art, _ := roh["art"].(string)
	regel, bekannt := arten[art]
	if !bekannt {
		return nil, fmt.Errorf("%w: %q", ErrUnbekannteArt, art)
	}
	for _, feld := range regel.pflicht {
		if _, da := roh[feld]; !da {
			return nil, fmt.Errorf("%s: Pflichtfeld %q fehlt", art, feld)
		}
	}
	geprueft := make(Ereignis, len(roh))
	for feld, wert := range roh {
		typ, erlaubt := regel.erlaubt[feld]
		if !erlaubt {
			return nil, fmt.Errorf("%s: fremdes Feld %q", art, feld)
		}
		sauber, err := pruefeFeld(art, feld, typ, wert)
		if err != nil {
			return nil, err
		}
		geprueft[feld] = sauber
	}
	return geprueft, nil
}

func pruefeFeld(art, feld string, typ feldTyp, wert any) (any, error) {
	fehler := func() error { return fmt.Errorf("%s: Feld %q ungueltig", art, feld) }
	switch typ {
	case typUUID:
		s, ok := wert.(string)
		if !ok || !uuidMuster.MatchString(s) {
			return nil, fehler()
		}
		return s, nil
	case typWort:
		s, ok := wert.(string)
		if !ok || s != art {
			return nil, fehler()
		}
		return s, nil
	case typZeit:
		s, ok := wert.(string)
		if !ok || !zeitMuster.MatchString(s) {
			return nil, fehler()
		}
		if _, err := time.Parse(time.RFC3339, s); err != nil {
			return nil, fehler()
		}
		return s, nil
	case typKennung:
		s, ok := wert.(string)
		if !ok || len(s) < 1 || len(s) > 128 || !kennungMuster.MatchString(s) {
			return nil, fehler()
		}
		return s, nil
	case typMesskanal:
		s, ok := wert.(string)
		if !ok || len(s) < 1 || len(s) > 240 {
			return nil, fehler()
		}
		return s, nil
	case typErkanntAus:
		// The box knows exactly ONE detection: its own buffer threw data away.
		// `kadenz` is the writer's and `herzschlag` the cloud's (§4).
		if s, ok := wert.(string); ok && s == "verdraengung" {
			return s, nil
		}
		return nil, fehler()
	case typGanzAb0, typGanzAb1, typStatuswort:
		n, ok := ganzzahl(wert)
		if !ok {
			return nil, fehler()
		}
		switch typ {
		case typGanzAb0:
			if n < 0 {
				return nil, fehler()
			}
		case typGanzAb1:
			if n < 1 {
				return nil, fehler()
			}
		case typStatuswort:
			if n < 0 || n > 65535 {
				return nil, fehler()
			}
		}
		return n, nil
	}
	return nil, fehler()
}

// ganzzahl accepts what JSON and Go both call a whole number. A float carrying a
// fraction is NOT a whole number - it is a broken document, never rounded here.
func ganzzahl(wert any) (int64, bool) {
	switch v := wert.(type) {
	case int:
		return int64(v), true
	case int64:
		return v, true
	case json.Number:
		n, err := v.Int64()
		return n, err == nil
	case float64:
		if v != float64(int64(v)) {
			return 0, false
		}
		return int64(v), true
	}
	return 0, false
}

// VomTreiber parses ONE local-bus message of a Node-RED driver. `ereignis_id` may
// be missing: the core mints it once, here, and the outbox then persists exactly
// those bytes - so a QoS1 redelivery or an outbox replay repeats the SAME id and
// the cloud stores one event (events-vocabulary.md §3).
func VomTreiber(payload []byte, neueID func() string) (Ereignis, error) {
	var roh map[string]any
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.UseNumber()
	if err := dec.Decode(&roh); err != nil {
		return nil, err
	}
	art, _ := roh["art"].(string)
	if !enthaelt(TreiberArten, art) {
		return nil, fmt.Errorf("%w: %q darf kein Treiber melden", ErrUnbekannteArt, art)
	}
	if _, da := roh["ereignis_id"]; !da {
		roh["ereignis_id"] = neueID()
	}
	return Pruefe(roh)
}

func enthaelt(liste []string, wert string) bool {
	for _, e := range liste {
		if e == wert {
			return true
		}
	}
	return false
}

// BoxNeustart is the core's OWN report: this runtime started at `start`.
func BoxNeustart(ereignisID string, start time.Time) (Ereignis, error) {
	return Pruefe(map[string]any{
		"ereignis_id": ereignisID,
		"art":         "box_restart",
		"zeitpunkt":   Zeit(start),
	})
}

// PufferVerdraengung is the core's OWN report: the durable sample outbox threw
// entries away, so [von, bis) never reached the cloud. Half-open like every gap.
func PufferVerdraengung(ereignisID string, von, bis time.Time, erwartetFehlend int64, datenquelle string) (Ereignis, error) {
	roh := map[string]any{
		"ereignis_id": ereignisID,
		"art":         "data_gap",
		"von":         Zeit(von),
		"bis":         Zeit(bis),
		"erkannt_aus": "verdraengung",
	}
	if erwartetFehlend > 0 {
		roh["erwartet_fehlend"] = erwartetFehlend
	}
	if datenquelle != "" {
		roh["datenquelle"] = datenquelle
	}
	return Pruefe(roh)
}

// Zeit is the contract's single time spelling: UTC, whole seconds, trailing Z.
func Zeit(t time.Time) string { return t.UTC().Truncate(time.Second).Format("2006-01-02T15:04:05Z") }

// NeueID mints one random UUIDv4 for an `ereignis_id`. It is called exactly once
// per event - at Append time - because the persisted bytes are what a QoS1
// redelivery and an outbox replay repeat unchanged.
func NeueID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// A box without entropy must still be able to name its events; the clock
		// plus a counter stay unique per box, which is all the contract needs.
		n := uint64(time.Now().UnixNano()) ^ atomic.AddUint64(&idZaehler, 1)
		for i := 0; i < 8; i++ {
			b[i], b[i+8] = byte(n>>(8*i)), byte(n>>(8*(7-i)))
		}
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

var idZaehler uint64
