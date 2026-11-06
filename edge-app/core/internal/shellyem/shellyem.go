// Package shellyem reads a Shelly energy meter of the Gen2+ line over its local
// HTTP RPC: the Pro 3EM and the Pro 3EM-400 in the profile "triphase" - one EM
// component (em:0) with the three phases and their sum, the energy counters in
// emdata:0. ONE GET of Shelly.GetStatus per cycle carries both from the same
// moment (EM.GetStatus + EMData.GetStatus would be two requests and two
// moments).
//
// READ ONLY: the only request is the status RPC - never Switch.*, *.SetConfig,
// Shelly.Reboot or an update call. Like the relay driver (internal/shelly), a
// password-protected Shelly is refused with an honest message (Gen2 digest auth
// is not supported).
//
// Sign: act_power is positive in the direction of the current transformers'
// arrow. Installed as the manufacturer shows it at the grid connection point
// (arrow towards the house), positive is Bezug and negative Einspeisung - the
// VoltPilot grid convention (+Bezug/-Einspeisung). Proven on a real Pro 3EM-400
// at the grid point (Schramm, 06.11.2026): +6.68 kW while three PV inverters
// delivered 4.5 kW and the two sub-meters together read 11.3 kW, which only
// adds up as Bezug. invert_grid_sign turns a reversed installation around.
//
// Time: the meter's own clock is never used - a Shelly without time sync runs
// free (the real ones were 2.5 h ahead after 620 days); the reading carries the
// box's receive time.
//
// Shared vectors: testdata/shelly-em-vectors.json (raw answers of the three
// real meters, identity anonymised, plus constructed cases).
package shellyem

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
)

// Catalog identity of the way.
const (
	Communication = "shelly_em_http"
	Family        = "shelly_em_triphase"
	DefaultPort   = 80
	StatusPath    = "/rpc/Shelly.GetStatus"
	// MaxBody caps the status answer (a Pro 3EM answers ~1.4 KB).
	MaxBody = 65536
)

// Errors a read can end with. A transport failure (timeout, refused) is
// returned as is.
var (
	// ErrGeschuetzt: the Shelly answered 401 - its password protection is on.
	ErrGeschuetzt = errors.New("Shelly verlangt eine Anmeldung (Passwortschutz aktiv)")
	// ErrKeineRPC: 404 on the RPC path - a Gen1 Shelly (the classic 3EM speaks
	// /status, not /rpc), not read yet.
	ErrKeineRPC = errors.New("Shelly kennt die RPC-Schnittstelle nicht (Gen1-Geraet wie der Shelly 3EM?)")
	// ErrHTTPStatus: another HTTP error status.
	ErrHTTPStatus = errors.New("Shelly antwortet mit einem HTTP-Fehler")
	// ErrZuGross: the answer is larger than MaxBody.
	ErrZuGross = errors.New("Antwort zu gross")
	// ErrKeinJSON: the answer is no JSON object.
	ErrKeinJSON = errors.New("Antwort ist kein JSON-Objekt")
	// ErrKeinDreiphasen: no em:N component - not a three-phase meter profile.
	ErrKeinDreiphasen = errors.New("kein Dreiphasen-Zaehler (em:0) in der Antwort")
	// ErrEinzelkanaele: only em1:N components - the monophase profile of a
	// Pro 3EM or a Pro EM (single channels), not read yet.
	ErrEinzelkanaele = errors.New("Profil mit Einzelkanaelen (em1, z. B. „monophase“ oder Pro EM) wird noch nicht gelesen")
	// ErrKeinMesswert: em:0 has no finite total_act_power.
	ErrKeinMesswert = errors.New("kein Wert fuer die Gesamtleistung (total_act_power)")
	// ErrZaehlerfehler: the meter reports a failure that makes its values unusable.
	ErrZaehlerfehler = errors.New("Zaehler meldet einen Messfehler")
)

// Phase is one phase of em:0. A field the meter did not send is nil.
type Phase struct {
	LeistungW *float64 `json:"leistung_w,omitempty"` // act_power
	SpannungV *float64 `json:"spannung_v,omitempty"` // voltage
	StromA    *float64 `json:"strom_a,omitempty"`    // current
	BezugWh   *float64 `json:"bezug_wh,omitempty"`   // emdata total_act_energy
	EinspWh   *float64 `json:"einspeisung_wh,omitempty"`
	Fehler    []string `json:"fehler,omitempty"` // <p>_errors
}

// Messung is one decoded status answer.
type Messung struct {
	LeistungW float64  `json:"leistung_w"`          // total_act_power, + in arrow direction
	ScheinVA  *float64 `json:"schein_va,omitempty"` // total_aprt_power
	StromA    *float64 `json:"strom_a,omitempty"`   // total_current
	Phasen    [3]Phase `json:"phasen"`              // a, b, c
	BezugWh   *float64 `json:"bezug_wh,omitempty"`  // emdata total_act
	EinspWh   *float64 `json:"einspeisung_wh,omitempty"`
	Fehler    []string `json:"fehler,omitempty"` // em:0 errors that do not void the values
	Profil    string   `json:"profil"`           // "triphase"
	Kanal     int      `json:"kanal"`            // N of em:N
}

// PowerKw is the grid channel: kW rounded to 1 W, the device's sign unless
// invert.
func (m *Messung) PowerKw(invert bool) float64 {
	w := m.LeistungW
	if invert {
		w = -w
	}
	return round3(w / 1000)
}

// phase prefixes of em:N.
var phasen = [3]string{"a", "b", "c"}

// Errors in em:N that void the values (the rest is named, the values stay).
func voids(e string) bool {
	return e == "power_meter_failure" || strings.HasPrefix(e, "out_of_range:")
}

// Decode reads a Shelly.GetStatus answer (or an EM.GetStatus object with
// emdata merged by the caller) for the EM component kanal.
func Decode(body []byte, kanal int) (*Messung, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil || top == nil {
		return nil, ErrKeinJSON
	}
	key := "em:" + strconv.Itoa(kanal)
	raw, ok := top[key]
	if !ok {
		for k := range top {
			if strings.HasPrefix(k, "em1:") {
				return nil, ErrEinzelkanaele
			}
		}
		return nil, ErrKeinDreiphasen
	}
	var em map[string]json.RawMessage
	if err := json.Unmarshal(raw, &em); err != nil || em == nil {
		return nil, ErrKeinDreiphasen
	}
	total := number(em["total_act_power"])
	if total == nil {
		return nil, ErrKeinMesswert
	}
	m := &Messung{LeistungW: *total, ScheinVA: number(em["total_aprt_power"]), StromA: number(em["total_current"]),
		Profil: "triphase", Kanal: kanal}
	var void []string
	for _, e := range stringsOf(em["errors"]) {
		if voids(e) {
			void = append(void, e)
		} else {
			m.Fehler = append(m.Fehler, e)
		}
	}
	for i, p := range phasen {
		ph := &m.Phasen[i]
		ph.LeistungW = number(em[p+"_act_power"])
		ph.SpannungV = number(em[p+"_voltage"])
		ph.StromA = number(em[p+"_current"])
		for _, e := range stringsOf(em[p+"_errors"]) {
			ph.Fehler = append(ph.Fehler, e)
			if voids(e) {
				void = append(void, p+":"+e)
			}
		}
	}
	if len(void) > 0 {
		return nil, fmt.Errorf("%w: %s", ErrZaehlerfehler, strings.Join(void, ", "))
	}
	if rawData, ok := top["emdata:"+strconv.Itoa(kanal)]; ok {
		var d map[string]json.RawMessage
		if json.Unmarshal(rawData, &d) == nil && d != nil {
			m.BezugWh = counter(d["total_act"])
			m.EinspWh = counter(d["total_act_ret"])
			for i, p := range phasen {
				m.Phasen[i].BezugWh = counter(d[p+"_total_act_energy"])
				m.Phasen[i].EinspWh = counter(d[p+"_total_act_ret_energy"])
			}
		}
	}
	return m, nil
}

// number is a finite JSON number, else nil (null, absent, text: never a 0).
// json.Unmarshal of `null` into a float64 succeeds and leaves 0 - the trap the
// vector "total_act_power null" pins.
func number(raw json.RawMessage) *float64 {
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return nil
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return &f
}

// counter is an energy counter: a finite number >= 0.
func counter(raw json.RawMessage) *float64 {
	v := number(raw)
	if v == nil || *v < 0 {
		return nil
	}
	return v
}

func stringsOf(raw json.RawMessage) []string {
	var out []string
	if len(raw) == 0 || json.Unmarshal(raw, &out) != nil {
		return nil
	}
	return out
}

// URL is the status URL of a meter.
func URL(ip string, port int) string {
	host := ip
	if strings.Contains(ip, ":") && !strings.HasPrefix(ip, "[") {
		host = "[" + ip + "]"
	}
	return "http://" + host + ":" + strconv.Itoa(port) + StatusPath
}

// Get fetches the status answer once. A transport failure comes back as is;
// 401 as ErrGeschuetzt, another status >= 400 as ErrHTTPStatus, an oversized
// body as ErrZuGross.
func Get(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, MaxBody))
		return nil, ErrGeschuetzt
	}
	if res.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, MaxBody))
		return nil, ErrKeineRPC
	}
	if res.StatusCode >= 400 {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, MaxBody))
		return nil, fmt.Errorf("%w %d", ErrHTTPStatus, res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, MaxBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > MaxBody {
		return nil, ErrZuGross
	}
	return body, nil
}

// Answered reports whether err is an answer of the device (it spoke, but not
// usably) rather than a transport failure.
func Answered(err error) bool {
	for _, e := range []error{ErrGeschuetzt, ErrKeineRPC, ErrHTTPStatus, ErrZuGross, ErrKeinJSON, ErrKeinDreiphasen,
		ErrEinzelkanaele, ErrKeinMesswert, ErrZaehlerfehler} {
		if errors.Is(err, e) {
			return true
		}
	}
	return false
}

func round3(x float64) float64 {
	v := math.Floor(x*1000+0.5) / 1000
	if v == 0 {
		return 0
	}
	return v
}
