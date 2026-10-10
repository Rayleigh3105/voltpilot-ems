package guards

// The loss of a FIXED feed-in share (UEMS AP-15 IP-22, E1 = A, case R2;
// concept vp-uems-ap15-verbund §5.8). A box that does not see the connection
// point holds its share even when there would be room at the connection
// point; what that costs is counted here, per box and per local day of the
// plant, so the operator decides after the pilot with counted kWh whether the
// allocation over time (IP-33/IP-34) is worth building.
//
// WHAT IS COUNTED: while the SHARE is the binding quantity - the cap with the
// share lies below the cap the same box would hold without it (the shadow
// "heute" of CapAnteil) AND the producers are held at that cap - the rate is
//
//	min(cap without share, available generation) - cap with share
//
// integrated over time. The leading box with a fresh measurement regulates
// against the whole limit; what it curtails is the limit, not its share, and
// is never counted.
//
// HOW FIRM THE NUMBER IS: the available generation of a curtailed PV is not
// measured - no inverter register reports it, the box has no PV forecast (the
// plan carries setpoints only), and a cap moves the measured value down with
// it. The box takes the cautious reading: available = the highest PV power
// MEASURED within the last VerlustBelegFenster (a delivered value proves the
// sun was there). The kWh are therefore a LOWER BOUND; while a steady share
// holds a rising clear-day curve, the measured PV equals the cap and the
// bound stays near 0 although generation is lost. GebundenS - how long the
// share held the producers - is exact and says that it happened. Unknown is
// not zero: without a PV measurement nothing is counted, neither kWh nor time.

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	// VerlustBelegFenster is how long a measured PV value counts as evidence of
	// the available generation (a cloud can take it away within minutes).
	VerlustBelegFenster = 15 * time.Minute
	// VerlustLuecke is the longest interval integrated between two
	// evaluations. A longer gap (restart, stalled loop) is not counted - the
	// box did not regulate then, and the rate at its start says nothing about
	// its end.
	VerlustLuecke = time.Minute
	// VerlustSpeichernAlle bounds disk writes: the day's counter is persisted
	// at most this often (and at every day change); a crash loses at most this
	// much counting, never the day.
	VerlustSpeichernAlle = time.Minute
)

// AnteilVerlustKw is the rate the feed-in share holds back in one evaluation
// of CapAnteil (kW >= 0) and whether the share is binding at all.
//
// pvKw is the MEASURED PV power of this evaluation (nil = not measured);
// verfuegbarKw is the available generation (nil = only what is measured). The
// rate is never above what the shadow without a share would have allowed.
func AnteilVerlustKw(c ExportCap, fuehrt bool, pvKw, verfuegbarKw *float64) (kw float64, gebunden bool) {
	if c.AnteilKw == nil || !c.Active || pvKw == nil || !finite(*pvKw) {
		return 0, false
	}
	// the leading box with a fresh measurement regulates against the whole
	// limit - its curtailment is the limit's, not the share's
	if fuehrt && !c.Blind {
		return 0, false
	}
	ohne := math.Inf(1)
	if c.HeuteCapKw != nil && finite(*c.HeuteCapKw) {
		ohne = *c.HeuteCapKw
	}
	if !(c.CapKw < ohne-1e-9) {
		return 0, false // without the share the box would hold the same (or less)
	}
	if *pvKw < c.CapKw-exportLimitingMarginKw {
		return 0, false // the producers run below the cap: nothing is held back
	}
	v := *pvKw
	if verfuegbarKw != nil && finite(*verfuegbarKw) && *verfuegbarKw > v {
		v = *verfuegbarKw
	}
	return math.Max(math.Min(ohne, v)-c.CapKw, 0), true
}

// VerlustTag is one local day of the plant: kWh the share held back (lower
// bound, see above) and seconds it held the producers.
type VerlustTag struct {
	Tag       string  `json:"tag"` // YYYY-MM-DD, local day of the plant
	Kwh       float64 `json:"kwh"`
	GebundenS float64 `json:"gebunden_s"`
}

// AnteilVerlust integrates the rate per local day of the plant; the day's
// counter survives a restart (atomic file). Concurrency-safe.
type AnteilVerlust struct {
	mu      sync.Mutex
	loc     *time.Location
	path    string // "" = not persisted
	heute   VerlustTag
	vortag  *VerlustTag
	last    time.Time
	rate    float64
	bound   bool
	pvMax   float64
	pvMaxAt time.Time
	saved   time.Time
	dirty   bool
}

// NewAnteilVerlust counts in loc (the plant's local time; nil = time.Local)
// and persists under dir ("" = in memory only). A stored counter of the same
// or the previous day is loaded - an unreadable file starts at 0, never above.
func NewAnteilVerlust(loc *time.Location, dir string) *AnteilVerlust {
	if loc == nil {
		loc = time.Local
	}
	v := &AnteilVerlust{loc: loc}
	if dir != "" {
		v.path = filepath.Join(dir, "anteil-verlust.json")
	}
	return v
}

type verlustDatei struct {
	Heute  VerlustTag  `json:"heute"`
	Vortag *VerlustTag `json:"vortag,omitempty"`
}

// Laden reads the stored counter; now decides whether it is today's.
func (v *AnteilVerlust) Laden(now time.Time) error {
	if v.path == "" {
		return nil
	}
	raw, err := os.ReadFile(v.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var d verlustDatei
	if err := json.Unmarshal(raw, &d); err != nil {
		return err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	heute := v.tag(now)
	switch d.Heute.Tag {
	case heute:
		v.heute, v.vortag = d.Heute, d.Vortag
	case v.tag(v.mitternacht(now).Add(-time.Hour)):
		t := d.Heute
		v.heute, v.vortag = VerlustTag{Tag: heute}, &t
	}
	return nil
}

// Zaehle adds one evaluation at now: the interval since the previous one is
// integrated with the PREVIOUS rate (it held until now), split at the local
// midnight. pvKw feeds the evidence window of the available generation.
func (v *AnteilVerlust) Zaehle(now time.Time, c ExportCap, fuehrt bool, pvKw *float64) {
	v.zaehle(now, c, fuehrt, pvKw, nil, true)
}

// ZaehleVerfuegbar is Zaehle with a KNOWN available generation (the R2
// half-sine in the test) instead of the evidence window.
func (v *AnteilVerlust) ZaehleVerfuegbar(now time.Time, c ExportCap, fuehrt bool, pvKw, verfuegbarKw *float64) {
	v.zaehle(now, c, fuehrt, pvKw, verfuegbarKw, false)
}

func (v *AnteilVerlust) zaehle(now time.Time, c ExportCap, fuehrt bool, pvKw, verfuegbar *float64, beleg bool) {
	if v == nil {
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.heute.Tag == "" {
		v.heute.Tag = v.tag(now)
	}
	if !v.last.IsZero() && now.After(v.last) && now.Sub(v.last) <= VerlustLuecke {
		v.integriere(v.last, now)
	}
	if v.tag(now) != v.heute.Tag {
		v.tageswechsel(now)
	}
	if beleg && pvKw != nil && finite(*pvKw) {
		if *pvKw >= v.pvMax || now.Sub(v.pvMaxAt) > VerlustBelegFenster {
			v.pvMax, v.pvMaxAt = *pvKw, now
		}
		m := v.pvMax
		verfuegbar = &m
	}
	v.rate, v.bound = AnteilVerlustKw(c, fuehrt, pvKw, verfuegbar)
	v.last = now
	v.speichernFaellig(now)
}

// integriere books [von, bis) with the held rate, the part after a local
// midnight to the new day. Caller holds v.mu.
func (v *AnteilVerlust) integriere(von, bis time.Time) {
	if !v.bound {
		return
	}
	if m := v.mitternacht(bis); von.Before(m) && v.tag(von) == v.heute.Tag {
		v.buche(m.Sub(von))
		v.tageswechsel(bis)
		von = m
	}
	v.buche(bis.Sub(von))
}

func (v *AnteilVerlust) buche(d time.Duration) {
	v.heute.Kwh += v.rate * d.Hours()
	v.heute.GebundenS += d.Seconds()
	v.dirty = true
}

// tageswechsel closes the day: it becomes the previous day, final. Caller
// holds v.mu.
func (v *AnteilVerlust) tageswechsel(now time.Time) {
	t := v.heute
	v.vortag = &t
	v.heute = VerlustTag{Tag: v.tag(now)}
	v.dirty = true
	v.saved = time.Time{} // persist the closed day at once
}

func (v *AnteilVerlust) tag(t time.Time) string { return t.In(v.loc).Format("2006-01-02") }

func (v *AnteilVerlust) mitternacht(t time.Time) time.Time {
	l := t.In(v.loc)
	return time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, v.loc)
}

// Stand is the running day and the closed previous day (nil before the first
// day change), rounded for the heartbeat: kWh to 0.1, seconds whole.
func (v *AnteilVerlust) Stand() (heute VerlustTag, vortag *VerlustTag) {
	v.mu.Lock()
	defer v.mu.Unlock()
	heute = gerundet(v.heute)
	if v.vortag != nil {
		t := gerundet(*v.vortag)
		vortag = &t
	}
	return heute, vortag
}

func gerundet(t VerlustTag) VerlustTag {
	return VerlustTag{Tag: t.Tag, Kwh: math.Round(t.Kwh*10) / 10, GebundenS: math.Round(t.GebundenS)}
}

// speichernFaellig persists when due. Caller holds v.mu.
func (v *AnteilVerlust) speichernFaellig(now time.Time) {
	if v.path == "" || !v.dirty || (!v.saved.IsZero() && now.Sub(v.saved) < VerlustSpeichernAlle) {
		return
	}
	if err := v.schreiben(); err == nil {
		v.saved, v.dirty = now, false
	}
}

// Speichern persists now (shutdown); a failure keeps the counter in memory.
func (v *AnteilVerlust) Speichern() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.path == "" {
		return nil
	}
	return v.schreiben()
}

// schreiben writes atomically (temp file, fsync, rename): a crash leaves the
// old or the new counter, never half of one. Caller holds v.mu.
func (v *AnteilVerlust) schreiben() error {
	raw, err := json.Marshal(verlustDatei{Heute: v.heute, Vortag: v.vortag})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(v.path), 0o755); err != nil {
		return err
	}
	tmp := v.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, v.path)
}

// TagVon is the local day of the plant at t (YYYY-MM-DD).
func (v *AnteilVerlust) TagVon(t time.Time) string { return v.tag(t) }
