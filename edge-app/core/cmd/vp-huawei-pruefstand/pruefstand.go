package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/huaweidecode"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
)

// verbindung opens one Modbus TCP session per step to the dongle, waits the
// pause after the connect (the Smart Dongle stays silent before it) and closes
// it again: the box beside us may want the one client slot too.
type verbindung struct {
	ziel    string
	unit    byte
	pause   time.Duration
	timeout time.Duration
	dial    modbustcp.Dialer
}

func (v verbindung) mit(ctx context.Context, fn func(c *modbustcp.Client) error) error {
	c, err := modbustcp.Dial(ctx, v.dial, v.ziel, v.unit, v.timeout, v.timeout)
	if err != nil {
		return err
	}
	defer c.Close()
	if v.pause > 0 {
		t := time.NewTimer(v.pause)
		select {
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		case <-t.C:
		}
	}
	return fn(c)
}

// --- writable registers ------------------------------------------------------

// grenze is one register this tool may write: the registers of the intents
// in catalog/control-profiles/profiles/huawei.json, nothing else - never a
// grid/protection parameter, the grid code, the clock, communication,
// passwords or firmware.
type grenze struct {
	name string
	u32  bool
	min  int
	max  int // max < 0: the power limit of the run (-max-w)
}

var schreibbar = map[int]grenze{
	47075: {name: "max. Ladeleistung (W)", u32: true, min: 0, max: -1},
	47077: {name: "max. Entladeleistung (W)", u32: true, min: 0, max: -1},
	47083: {name: "Dauer Zwangsladen/-entladen (min)", min: 1, max: 5},
	47086: {name: "Arbeitsmodus", min: 2, max: 2},
	47087: {name: "Netzladen", min: 0, max: 1},
	47100: {name: "Zwangsladen/-entladen (0 Stopp, 1 Laden, 2 Entladen)", min: 0, max: 2},
	47246: {name: "Modus Zwangsladen (0 Dauer; 1 SoC NIE)", min: 0, max: 0},
	47247: {name: "Zwangsladeleistung (W)", u32: true, min: 0, max: -1},
	47249: {name: "Zwangsentladeleistung (W)", u32: true, min: 0, max: -1},
}

// schritt is one planned write as the adapter of inverter-control-routing.js
// writes it out (`planned`): FC6 one U16, FC16 two words of a U32 W.
type schritt struct {
	Role   string `json:"role"`
	FC     int    `json:"fc"`
	Addr   int    `json:"addr"`
	Value  int    `json:"value"`
	Count  int    `json:"count,omitempty"`
	Always bool   `json:"always,omitempty"`
}

func (s schritt) worte() int {
	if s.FC == 16 {
		return 2
	}
	return 1
}

// pruefeFolge refuses a sequence that leaves the allowed registers, values or
// encodings - before anything is read or written.
func pruefeFolge(folge []schritt, maxW int) error {
	if len(folge) == 0 {
		return errors.New("leere Folge")
	}
	for _, s := range folge {
		g, ok := schreibbar[s.Addr]
		if !ok {
			return fmt.Errorf("Register %d ist nicht freigegeben (nur die Absichtsregister aus huawei.json)", s.Addr)
		}
		switch {
		case g.u32 && (s.FC != 16 || s.Count != 2):
			return fmt.Errorf("Register %d ist U32: FC16 mit 2 Worten erwartet", s.Addr)
		case !g.u32 && s.FC != 6:
			return fmt.Errorf("Register %d ist U16: FC6 erwartet", s.Addr)
		}
		hi := g.max
		if hi < 0 {
			hi = maxW
		}
		if s.Value < g.min || s.Value > hi {
			return fmt.Errorf("Register %d (%s): Wert %d ausserhalb [%d, %d]", s.Addr, g.name, s.Value, g.min, hi)
		}
	}
	return nil
}

// leseFolgeDatei reads the output of the adapter: {plan:{planned:[...]}} or a
// bare array.
func leseFolgeDatei(pfad string) ([]schritt, error) {
	raw, err := os.ReadFile(pfad)
	if err != nil {
		return nil, err
	}
	var bare []schritt
	if json.Unmarshal(raw, &bare) == nil && len(bare) > 0 {
		return bare, nil
	}
	var doc struct {
		Plan struct {
			Planned []schritt `json:"planned"`
		} `json:"plan"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	return doc.Plan.Planned, nil
}

// --- register words ----------------------------------------------------------

func wert(regs []uint16) int {
	if len(regs) == 2 {
		return int(uint32(regs[0])<<16 | uint32(regs[1]))
	}
	return int(regs[0])
}

func worte(v, n int) []uint16 {
	if n == 2 {
		return []uint16{uint16(uint32(v) >> 16), uint16(uint32(v))}
	}
	return []uint16{uint16(v)}
}

func schreibe(c *modbustcp.Client, addr, n, v int) error {
	if n == 2 {
		return c.WriteRegisters(uint16(addr), worte(v, 2))
	}
	return c.WriteSingleRegister(uint16(addr), uint16(v))
}

func lies(c *modbustcp.Client, addr, n int) (int, error) {
	regs, err := c.ReadHolding(uint16(addr), uint16(n))
	if err != nil {
		return 0, err
	}
	return wert(regs), nil
}

// --- the record --------------------------------------------------------------

// eintrag is one line of the run's record (JSON lines).
type eintrag struct {
	Zeit     string             `json:"zeit"`
	Schritt  string             `json:"schritt"`
	Register int                `json:"register,omitempty"`
	Alt      *int               `json:"alt,omitempty"`
	Neu      *int               `json:"neu,omitempty"`
	Gelesen  *int               `json:"gelesen,omitempty"`
	Messung  map[string]float64 `json:"messung,omitempty"`
	Hinweis  string             `json:"hinweis,omitempty"`
	Fehler   string             `json:"fehler,omitempty"`
}

type protokoll struct {
	jetzt func() time.Time
	out   []func(eintrag)
}

func (p *protokoll) schreib(e eintrag) {
	e.Zeit = p.jetzt().UTC().Format("2006-01-02T15:04:05.000Z")
	for _, f := range p.out {
		f(e)
	}
}

func ip(v int) *int { return &v }

// beobachte reads the Edge Light read plan (huaweidecode.PlanReads) and
// decodes it like the box does: PV, grid, SoC, battery power, AC power.
func beobachte(c *modbustcp.Client) (map[string]float64, int) {
	m, n, _ := beobachteMitFehlern(c)
	return m, n
}

// beobachteMitFehlern also names why a block failed (exception, timeout,
// connection): the box ends its read at the first transport failure, this
// tool reads on to see the rest.
func beobachteMitFehlern(c *modbustcp.Client) (map[string]float64, int, []string) {
	var blocks []huaweidecode.Block
	var fehler []string
	abgelehnt := 0
	for _, b := range huaweidecode.PlanReads(huaweidecode.Family) {
		regs, err := c.ReadHolding(uint16(b.Start), uint16(b.Count))
		if err != nil {
			abgelehnt++
			fehler = append(fehler, fmt.Sprintf("%d: %v", b.Start, err))
			continue
		}
		blocks = append(blocks, huaweidecode.Block{Start: b.Start, Regs: regs})
	}
	m := map[string]float64{}
	res := huaweidecode.Decode(blocks, huaweidecode.Options{})
	if res == nil {
		return m, abgelehnt, fehler
	}
	for k, v := range res.Reading {
		m[k] = v
	}
	if res.BattKw != nil {
		m["battery_power_kw"] = *res.BattKw
	}
	if res.Meta.ActivePowerW != nil {
		m["active_power_kw"] = float64(*res.Meta.ActivePowerW) / 1000
	}
	if res.Meta.BatteryRunningStatus != nil {
		m["battery_status"] = float64(*res.Meta.BatteryRunningStatus)
	}
	return m, abgelehnt, fehler
}

// --- one write run -----------------------------------------------------------

// lauf runs one sequence: originals read and saved, the sequence written with
// read-back, held and observed, then every original restored and read back.
type lauf struct {
	v          verbindung
	p          *protokoll
	folge      []schritt
	halten     time.Duration
	takt       time.Duration
	nachlauf   time.Duration
	auffrische bool // re-write the `always` steps each tick (the adapter's own re-assert)
	sicherung  string
	// herstellFrist bounds the retries of the restore (15 min: the box's
	// tunnel guard restarts a dead tunnel after 10 min), herstellAbstand
	// spaces them (10 s).
	herstellFrist   time.Duration
	herstellAbstand time.Duration
	// schnell is how long einschwingen samples after the write (0: not).
	schnell time.Duration
}

// ergebnis: restored is false when an original could not be confirmed - the
// device state is then what Originale and the record say.
type ergebnis struct {
	Originale    map[int]int `json:"originale"`
	Unerwartet   string      `json:"unerwartet,omitempty"`
	Hergestellt  bool        `json:"wiederhergestellt"`
	Abweichungen map[int]int `json:"abweichungen,omitempty"`
}

func (l *lauf) run(ctx context.Context) ergebnis {
	res := ergebnis{Originale: map[int]int{}}
	worteJe := map[int]int{}
	var reihenfolge []int
	for _, s := range l.folge {
		if _, ok := worteJe[s.Addr]; !ok {
			reihenfolge = append(reihenfolge, s.Addr)
		}
		worteJe[s.Addr] = s.worte()
	}
	// 1. Originals, saved before the first write.
	err := l.v.mit(ctx, func(c *modbustcp.Client) error {
		for _, a := range reihenfolge {
			v, err := lies(c, a, worteJe[a])
			if err != nil {
				return fmt.Errorf("Ausgangswert %d: %w", a, err)
			}
			res.Originale[a] = v
			l.p.schreib(eintrag{Schritt: "ausgangswert", Register: a, Alt: ip(v)})
		}
		m, n := beobachte(c)
		l.p.schreib(eintrag{Schritt: "beobachtung_vorher", Messung: m, Hinweis: fmt.Sprintf("%d Bloecke abgelehnt", n)})
		return nil
	})
	if err != nil {
		res.Unerwartet = err.Error()
		res.Hergestellt = true // nothing written
		l.p.schreib(eintrag{Schritt: "abbruch_vor_schreiben", Fehler: err.Error()})
		return res
	}
	if l.sicherung != "" {
		raw, _ := json.MarshalIndent(map[string]any{"ziel": l.v.ziel, "unit": l.v.unit, "worte": worteJe, "originale": res.Originale}, "", "  ")
		if err := os.WriteFile(l.sicherung, raw, 0o600); err != nil {
			res.Unerwartet, res.Hergestellt = "Sicherung nicht geschrieben: "+err.Error(), true
			return res
		}
	}
	geschrieben := map[int]bool{}
	// 2. The sequence in its order, each step read back.
	schreibFolge := func(c *modbustcp.Client, nurImmer bool) error {
		for _, s := range l.folge {
			if nurImmer && !s.Always {
				continue
			}
			geschrieben[s.Addr] = true
			if err := schreibe(c, s.Addr, s.worte(), s.Value); err != nil {
				return fmt.Errorf("Schreiben %d=%d: %w", s.Addr, s.Value, err)
			}
			got, err := lies(c, s.Addr, s.worte())
			e := eintrag{Schritt: "schreiben", Register: s.Addr, Alt: ip(res.Originale[s.Addr]), Neu: ip(s.Value), Hinweis: s.Role}
			if err == nil {
				e.Gelesen = ip(got)
			}
			if nurImmer {
				e.Schritt = "auffrischen"
			}
			l.p.schreib(e)
			if err != nil {
				return fmt.Errorf("Ruecklesen %d: %w", s.Addr, err)
			}
			if got != s.Value {
				return fmt.Errorf("Ruecklesen %d: %d statt %d", s.Addr, got, s.Value)
			}
		}
		return nil
	}
	err = l.v.mit(ctx, func(c *modbustcp.Client) error {
		if err := schreibFolge(c, false); err != nil {
			return err
		}
		l.einschwingen(ctx, c)
		return nil
	})
	if err != nil {
		res.Unerwartet = err.Error()
		l.p.schreib(eintrag{Schritt: "unerwartet", Fehler: err.Error()})
	}
	// 3. Hold and observe (a cancelled ctx - Ctrl-C - ends the hold only).
	if err == nil {
		ende := time.Now().Add(l.halten)
		for time.Now().Before(ende) && ctx.Err() == nil {
			select {
			case <-ctx.Done():
			case <-time.After(l.takt):
			}
			if ctx.Err() != nil {
				break
			}
			herr := l.v.mit(ctx, func(c *modbustcp.Client) error {
				if l.auffrische {
					if err := schreibFolge(c, true); err != nil {
						return err
					}
				}
				m, _ := beobachte(c)
				for _, a := range reihenfolge {
					if v, err := lies(c, a, worteJe[a]); err == nil {
						m[fmt.Sprintf("r%d", a)] = float64(v)
					}
				}
				l.p.schreib(eintrag{Schritt: "beobachtung", Messung: m})
				return nil
			})
			if herr != nil && ctx.Err() == nil {
				res.Unerwartet = herr.Error()
				l.p.schreib(eintrag{Schritt: "unerwartet", Fehler: herr.Error()})
				break
			}
		}
	}
	// 4. Restore every written original (reverse order), never on ctx alone.
	res.Hergestellt, res.Abweichungen = l.herstellen(reihenfolge, worteJe, res.Originale, geschrieben)
	// 5. Afterwards, the device on its own again.
	if l.nachlauf > 0 && res.Hergestellt {
		ende := time.Now().Add(l.nachlauf)
		for time.Now().Before(ende) {
			time.Sleep(l.takt)
			_ = l.v.mit(context.Background(), func(c *modbustcp.Client) error {
				m, _ := beobachte(c)
				l.p.schreib(eintrag{Schritt: "beobachtung_nachher", Messung: m})
				return nil
			})
		}
	}
	return res
}

// einschwingen samples battery (37765) and AC power (32080) as fast as the
// dongle answers, for l.schnell after the last write of the sequence, in the
// write's own session: the settling time of the device.
func (l *lauf) einschwingen(ctx context.Context, c *modbustcp.Client) {
	if l.schnell <= 0 {
		return
	}
	t0 := time.Now()
	for time.Since(t0) < l.schnell && ctx.Err() == nil {
		m := map[string]float64{"ms_nach_schreiben": float64(time.Since(t0).Milliseconds())}
		if regs, err := c.ReadHolding(37765, 2); err == nil {
			m["battery_power_kw"] = float64(int32(uint32(regs[0])<<16|uint32(regs[1]))) / 1000
		}
		if regs, err := c.ReadHolding(32080, 2); err == nil {
			m["active_power_kw"] = float64(int32(uint32(regs[0])<<16|uint32(regs[1]))) / 1000
		}
		l.p.schreib(eintrag{Schritt: "einschwingen", Messung: m})
	}
}

// herstellen writes the originals back and reads them; three sessions at
// most. Abweichungen holds the registers still off (read value).
func (l *lauf) herstellen(reihenfolge []int, worteJe, originale map[int]int, geschrieben map[int]bool) (bool, map[int]int) {
	var offen []int
	for i := len(reihenfolge) - 1; i >= 0; i-- {
		if a := reihenfolge[i]; geschrieben[a] {
			offen = append(offen, a)
		}
	}
	if len(offen) == 0 {
		return true, nil
	}
	ab := map[int]int{}
	frist, abstand := l.herstellFrist, l.herstellAbstand
	if frist <= 0 {
		frist = 15 * time.Minute
	}
	if abstand <= 0 {
		abstand = 10 * time.Second
	}
	ende := time.Now().Add(frist)
	antworten := 0 // sessions in which the device answered and still disagreed
	for versuch := 1; ; versuch++ {
		if versuch > 1 {
			time.Sleep(abstand)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		err := l.v.mit(ctx, func(c *modbustcp.Client) error {
			var rest []int
			for _, a := range offen {
				want := originale[a]
				if err := schreibe(c, a, worteJe[a], want); err != nil {
					l.p.schreib(eintrag{Schritt: "wiederherstellen", Register: a, Neu: ip(want), Fehler: err.Error()})
					rest = append(rest, a)
					continue
				}
				got, err := lies(c, a, worteJe[a])
				e := eintrag{Schritt: "wiederherstellen", Register: a, Neu: ip(want)}
				if err != nil {
					e.Fehler = err.Error()
					rest = append(rest, a)
				} else {
					e.Gelesen = ip(got)
					if got != want {
						ab[a] = got
						rest = append(rest, a)
					} else {
						delete(ab, a)
					}
				}
				l.p.schreib(e)
			}
			offen = rest
			return nil
		})
		cancel()
		if err != nil {
			l.p.schreib(eintrag{Schritt: "wiederherstellen", Fehler: fmt.Sprintf("Versuch %d: %v", versuch, err)})
		} else if len(ab) > 0 {
			antworten++
		}
		if len(offen) == 0 {
			return true, nil
		}
		// A lost connection (box WLAN, tunnel) is retried until the deadline;
		// a device that answers and keeps another value, three times.
		if antworten >= 3 || time.Now().After(ende) {
			break
		}
	}
	for _, a := range offen {
		if _, ok := ab[a]; !ok {
			ab[a] = -1 // not readable
		}
	}
	return false, ab
}

// --- read-only survey --------------------------------------------------------

// feld is one register field of the survey, always read whole (the dongle
// answers a part of a multi-register field with exception 2).
type feld struct {
	Name   string
	Addr   int
	Count  int
	Art    string // text, u16, i16, u32, i32
	Faktor float64
	Geheim bool // read, never printed (serial number)
	Gruppe string
}

var erhebung = []feld{
	{"modell", 30000, 15, "text", 0, false, "geraet"},
	{"seriennummer", 30015, 10, "text", 0, true, "geraet"},
	{"teilenummer", 30025, 10, "text", 0, false, "geraet"},
	{"firmware", 30035, 15, "text", 0, false, "geraet"},
	{"software", 30050, 15, "text", 0, false, "geraet"},
	{"protokoll", 30068, 2, "u32", 0, false, "geraet"},
	{"modell_id", 30070, 1, "u16", 0, false, "geraet"},
	{"pv_strings", 30071, 1, "u16", 0, false, "geraet"},
	{"mpp_tracker", 30072, 1, "u16", 0, false, "geraet"},
	{"nennleistung_w", 30073, 2, "u32", 0, false, "geraet"},
	{"max_wirkleistung_w", 30075, 2, "u32", 0, false, "geraet"},
	{"pv1_spannung_v", 32016, 1, "i16", 0.1, false, "messung"},
	{"pv1_strom_a", 32017, 1, "i16", 0.01, false, "messung"},
	{"eingangsleistung_w", 32064, 2, "i32", 0, false, "messung"},
	{"wirkleistung_w", 32080, 2, "i32", 0, false, "messung"},
	{"temperatur_c", 32087, 1, "i16", 0.1, false, "messung"},
	{"geraetestatus", 32089, 1, "u16", 0, false, "messung"},
	{"zaehler_status", 37100, 1, "u16", 0, false, "zaehler"},
	{"zaehler_wirkleistung_w", 37113, 2, "i32", 0, false, "zaehler"},
	{"zaehler_typ", 37125, 1, "u16", 0, false, "zaehler"},
	{"speicher1_status", 37000, 1, "u16", 0, false, "speicher"},
	{"speicher1_leistung_w", 37001, 2, "i32", 0, false, "speicher"},
	{"speicher1_soc_pct", 37004, 1, "u16", 0.1, false, "speicher"},
	{"speicher_kapazitaet_wh", 37758, 2, "u32", 0, false, "speicher"},
	{"speicher_soc_pct", 37760, 1, "u16", 0.1, false, "speicher"},
	{"speicher_status", 37762, 1, "u16", 0, false, "speicher"},
	{"speicher_leistung_w", 37765, 2, "i32", 0, false, "speicher"},
	{"speicher1_produkt", 47000, 1, "u16", 0, false, "speicher"},
	{"max_ladeleistung_w", 47075, 2, "u32", 0, false, "absicht"},
	{"max_entladeleistung_w", 47077, 2, "u32", 0, false, "absicht"},
	{"ladeschluss_soc_pct", 47081, 1, "u16", 0.1, false, "absicht"},
	{"entladeschluss_soc_pct", 47082, 1, "u16", 0.1, false, "absicht"},
	{"zwang_dauer_min", 47083, 1, "u16", 0, false, "absicht"},
	{"arbeitsmodus", 47086, 1, "u16", 0, false, "absicht"},
	{"netzladen", 47087, 1, "u16", 0, false, "absicht"},
	{"zwang_richtung", 47100, 1, "u16", 0, false, "absicht"},
	{"zwang_modus", 47246, 1, "u16", 0, false, "absicht"},
	{"zwang_ladeleistung_w", 47247, 2, "u32", 0, false, "absicht"},
	{"zwang_entladeleistung_w", 47249, 2, "u32", 0, false, "absicht"},
}

func deute(f feld, regs []uint16) any {
	switch f.Art {
	case "text":
		b := make([]byte, 0, 2*len(regs))
		for _, r := range regs {
			b = append(b, byte(r>>8), byte(r))
		}
		if i := bytes.IndexByte(b, 0); i >= 0 {
			b = b[:i] // the text ends at its first NUL; what follows is left over
		}
		for len(b) > 0 && b[len(b)-1] == ' ' {
			b = b[:len(b)-1]
		}
		if f.Geheim {
			return fmt.Sprintf("(%d Zeichen, nicht ausgegeben)", len(b))
		}
		return string(b)
	}
	var v float64
	switch f.Art {
	case "u16":
		v = float64(regs[0])
	case "i16":
		v = float64(int16(regs[0]))
	case "u32":
		v = float64(uint32(regs[0])<<16 | uint32(regs[1]))
	case "i32":
		v = float64(int32(uint32(regs[0])<<16 | uint32(regs[1])))
	}
	if f.Faktor != 0 {
		v *= f.Faktor
	}
	return v
}

// erhebe reads every survey field in one session; a refused field is named
// with its error, never filled.
func erhebe(ctx context.Context, v verbindung) (map[string]map[string]any, error) {
	out := map[string]map[string]any{}
	err := v.mit(ctx, func(c *modbustcp.Client) error {
		for _, f := range erhebung {
			if out[f.Gruppe] == nil {
				out[f.Gruppe] = map[string]any{}
			}
			regs, err := c.ReadHolding(uint16(f.Addr), uint16(f.Count))
			if err != nil {
				if !modbustcp.IsException(err) {
					return fmt.Errorf("%s (%d): %w", f.Name, f.Addr, err)
				}
				out[f.Gruppe][f.Name] = "abgelehnt: " + err.Error()
				continue
			}
			out[f.Gruppe][f.Name] = deute(f, regs)
		}
		m, n := beobachte(c)
		lp := map[string]any{"bloecke_abgelehnt": n}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			lp[k] = m[k]
		}
		out["leseplan_edge_light"] = lp
		return nil
	})
	return out, err
}

// --- the pause measurement (read only) ---------------------------------------

type wartezeitProbe struct {
	Pause     string `json:"pause"`
	Versuch   int    `json:"versuch"`
	Antwort   bool   `json:"antwort"`
	AntwortMs int64  `json:"antwort_ms,omitempty"`
	Fehler    string `json:"fehler,omitempty"`
}

// probiereWartezeit connects, waits pause, asks 30000 (model, 15 registers)
// once with the given answer timeout.
func probiereWartezeit(ctx context.Context, v verbindung, pause, antwort time.Duration) wartezeitProbe {
	v.pause, v.timeout = pause, antwort
	p := wartezeitProbe{Pause: pause.String()}
	err := v.mit(ctx, func(c *modbustcp.Client) error {
		t0 := time.Now()
		_, err := c.ReadHolding(30000, 15)
		if err == nil {
			p.Antwort, p.AntwortMs = true, time.Since(t0).Milliseconds()
		}
		return err
	})
	if err != nil {
		p.Fehler = err.Error()
	}
	return p
}
