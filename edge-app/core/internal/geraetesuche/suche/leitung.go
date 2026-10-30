package suche

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

// Leitung takes the orders of the cloud and runs at most one search at a time
// (contract §2/§3): the admission of the probe channel - identity, deadline,
// duplicate delivery, limiter, the run on its own goroutine - plus the
// one-shot discipline of the Sprungprobe: a taken order ends with exactly one
// result, and on the Docker box the open order is on disk, so a restart
// reports it aborted with "neustart" instead of letting it vanish. Edge Light
// keeps it in RAM only (no flash writes): there the search ends without a
// result and the cloud says "nicht zu Ende gemeldet" after 30 s.
type Leitung struct {
	o       LeitungOptionen
	limiter *probe.Limiter

	mu      sync.Mutex
	ctx     context.Context
	laufend *laufend
	gesehen map[string]time.Time

	sendeMu sync.Mutex
	wartend []wartend
}

// LeitungOptionen wire a Leitung into its box.
type LeitungOptionen struct {
	BoxArt string
	// Identitaet is the box's own identity (tenant, site, device); empty
	// while not enrolled - then no order is taken.
	Identitaet func() (tenant, site, device string)
	// Umgebung is what the box sees, built when an order arrives. It must be
	// cheap: it runs on the link's router goroutine.
	Umgebung func() Umgebung
	// Bekannt lists what the box already reads; called on the search's own
	// goroutine.
	Bekannt func() []Bekannt
	// SendeStand / SendeErgebnis publish on .../v2/geraetesuche-stand and
	// -ergebnis (QoS 1, not retained). An error keeps a result waiting.
	SendeStand    func(geraetesuche.Stand) error
	SendeErgebnis func(geraetesuche.Ergebnis) error
	// OffenPfad is where the open order lives ("" = RAM only, Edge Light).
	OffenPfad string
	Log       *slog.Logger

	// For tests only: zero keeps the contract values.
	MaxDauer  time.Duration
	StandTakt time.Duration
	Jetzt     func() time.Time
}

type laufend struct {
	auftrag   geraetesuche.Auftrag
	lauf      *Lauf
	abbrechen context.CancelCauseFunc
	start     time.Time
}

type wartend struct {
	e geraetesuche.Ergebnis
	// offen: the persisted order this result closes.
	offen bool
}

var (
	errAufWunsch = errors.New("geraetesuche: cancelled on request")
	errZeitlimit = errors.New("geraetesuche: time limit")
)

// NeueLeitung builds a Leitung; Start must run before orders are taken.
func NeueLeitung(o LeitungOptionen) *Leitung {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.MaxDauer <= 0 {
		o.MaxDauer = geraetesuche.MaxDauer
	}
	if o.StandTakt <= 0 {
		o.StandTakt = geraetesuche.StandTakt
	}
	if o.Jetzt == nil {
		o.Jetzt = time.Now
	}
	return &Leitung{o: o, limiter: probe.NewLimiter(time.Hour, geraetesuche.MaxJeStunde),
		gesehen: map[string]time.Time{}, ctx: context.Background()}
}

// Start reports an order that was open at the last stop (Docker box) and
// keeps waiting results going out until ctx ends. A search still running when
// ctx ends sends nothing more: its order stays on disk for the next start.
func (l *Leitung) Start(ctx context.Context) {
	l.mu.Lock()
	l.ctx = ctx
	l.mu.Unlock()
	l.wiederherstellen()
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				l.Senden()
			}
		}
	}()
}

// Nimm handles one order from .../v2/geraetesuche. It runs on the link's
// router goroutine: only the cheap gate is here, the search has its own.
func (l *Leitung) Nimm(payload []byte) {
	jetzt := l.o.Jetzt().UTC()
	tenant, site, device := l.o.Identitaet()
	if tenant == "" || site == "" || device == "" {
		l.o.Log.Warn("geraetesuche: order before enrollment dropped")
		return
	}
	a, err := geraetesuche.LiesAuftrag(geraetesuche.Topic(tenant, site, device, geraetesuche.TopicAuftrag), payload)
	if err != nil {
		// Silently towards the broker; the box only says THAT it did not fit.
		l.o.Log.Warn("geraetesuche: order dropped", "err", err)
		return
	}
	l.o.Log.Info("geraetesuche: order", "aktion", a.Aktion, "such_id", a.SuchID, "ausgeloest_von", a.AusgeloestVon)

	l.mu.Lock()
	defer l.mu.Unlock()
	if a.Aktion == "abbrechen" {
		if l.laufend != nil && l.laufend.auftrag.SuchID == a.SuchID {
			l.laufend.abbrechen(errAufWunsch)
		}
		return
	}
	// QoS 1 may deliver twice: the same order never starts a second search
	// and never earns a second result.
	if l.schonGesehen(a.SuchID, jetzt) {
		l.o.Log.Warn("geraetesuche: duplicate delivery dropped", "such_id", a.SuchID)
		return
	}
	if !a.Beginnbar(jetzt) {
		l.ablehnen(a, "abgelaufen")
		return
	}
	if l.laufend != nil {
		l.ablehnen(a, "laeuft_schon")
		return
	}
	u := l.o.Umgebung()
	u.BoxArt = l.o.BoxArt
	lauf, grund := Neu(u, a.Erkenner)
	if grund != "" {
		l.ablehnen(a, grund)
		return
	}
	if !l.limiter.Allow(jetzt) {
		l.ablehnen(a, "zu_oft")
		return
	}
	if err := l.offenMerken(a.SuchID, lauf.Netze()); err != nil {
		// An order that would vanish on a restart is not run.
		l.o.Log.Error("geraetesuche: open order not persisted", "err", err)
		l.warte(geraetesuche.Ergebnis{SuchID: a.SuchID, Ts: jetzt, Zustand: "fehlgeschlagen",
			Grund: "interner_fehler", Erkenner: []string{}, Netze: []geraetesuche.Netz{}, Funde: []geraetesuche.Fund{}}, false)
		return
	}
	ctx, abbrechen := context.WithCancelCause(l.ctx)
	la := &laufend{auftrag: a, lauf: lauf, abbrechen: abbrechen, start: jetzt}
	l.laufend = la
	go l.fahre(ctx, la)
}

// Laeuft says whether a search runs (for the local surface and tests).
func (l *Leitung) Laeuft() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.laufend != nil
}

func (l *Leitung) schonGesehen(id string, jetzt time.Time) bool {
	for k, t := range l.gesehen {
		if jetzt.Sub(t) > time.Hour {
			delete(l.gesehen, k)
		}
	}
	if _, ok := l.gesehen[id]; ok {
		return true
	}
	if len(l.gesehen) < 256 {
		l.gesehen[id] = jetzt
	}
	return false
}

// ablehnen answers an order that is not searched: nothing found, no time spent.
// Caller holds mu.
func (l *Leitung) ablehnen(a geraetesuche.Auftrag, grund string) {
	l.o.Log.Info("geraetesuche: refused", "such_id", a.SuchID, "grund", grund)
	l.warte(geraetesuche.Ergebnis{SuchID: a.SuchID, Ts: l.o.Jetzt().UTC(), Zustand: "abgelehnt", Grund: grund,
		Erkenner: []string{}, Netze: []geraetesuche.Netz{}, Funde: []geraetesuche.Fund{}}, false)
}

// fahre runs one search, sends its progress every StandTakt and queues its
// one result.
func (l *Leitung) fahre(ctx context.Context, la *laufend) {
	sctx, stop := context.WithTimeoutCause(ctx, l.o.MaxDauer, errZeitlimit)
	defer stop()
	la.lauf.u.Bekannt = l.o.Bekannt()
	fertig := make(chan Ausgang, 1)
	go func() { fertig <- la.lauf.Suche(sctx) }()

	takt := time.NewTicker(l.o.StandTakt)
	defer takt.Stop()
	nr, gesendet := 0, 0
	for {
		select {
		case aus := <-fertig:
			l.abschliessen(sctx, la, aus)
			return
		case <-takt.C:
			nr++
			gesendet = l.zwischenstand(la, nr, gesendet)
		}
	}
}

// zwischenstand sends the progress: the step, the counts, the networks and
// the finds since the last progress that went out. It is display only - a
// lost one costs nothing, the next one carries the finds.
func (l *Leitung) zwischenstand(la *laufend, nr, gesendet int) int {
	z := la.lauf.Stand()
	tenant, site, device := l.o.Identitaet()
	jetzt := l.o.Jetzt().UTC()
	s := geraetesuche.Stand{SchemaVersion: geraetesuche.SchemaVersion, TenantID: tenant, SiteID: site,
		DeviceID: device, SuchID: la.auftrag.SuchID, Nr: nr, Ts: jetzt, Schritt: z.Schritt,
		Erledigt: z.Erledigt, Gesamt: z.Gesamt, Netze: z.Netze, Funde: z.Funde[gesendet:]}
	if s.Netze == nil {
		s.Netze = []geraetesuche.Netz{}
	}
	if r, ok := restSekunden(jetzt.Sub(la.start), z.Erledigt, z.Gesamt, l.o.MaxDauer); ok {
		s.RestS = &r
	}
	if err := s.Pruefe(l.o.BoxArt); err != nil {
		l.o.Log.Error("geraetesuche: progress not sent", "err", err)
		return gesendet
	}
	if l.o.SendeStand == nil || l.o.SendeStand(s) != nil {
		return gesendet
	}
	return len(z.Funde)
}

// restSekunden estimates the rest from the pace so far, never beyond the
// time limit. ok=false while nothing is done yet (unknown is no number).
func restSekunden(vergangen time.Duration, erledigt, gesamt int, max time.Duration) (int, bool) {
	if erledigt <= 0 || gesamt <= 0 {
		return 0, false
	}
	rest := time.Duration(float64(vergangen) * float64(gesamt-erledigt) / float64(erledigt))
	if grenze := max - vergangen; rest > grenze {
		rest = grenze
	}
	if rest < 0 {
		rest = 0
	}
	return int(rest.Round(time.Second) / time.Second), true
}

func (l *Leitung) abschliessen(ctx context.Context, la *laufend, aus Ausgang) {
	e := geraetesuche.Ergebnis{SuchID: la.auftrag.SuchID, Ts: l.o.Jetzt().UTC(), Zustand: "fertig",
		DauerMs: int(l.o.Jetzt().Sub(la.start) / time.Millisecond), Erkenner: aus.Erkenner, Netze: aus.Netze,
		Funde: aus.Funde, Weitere: aus.Weitere}
	if e.DauerMs < 0 {
		e.DauerMs = 0
	}
	halt := false
	switch cause := context.Cause(ctx); {
	case cause == nil:
	case errors.Is(cause, errAufWunsch):
		e.Zustand, e.Grund = "abgebrochen", "auf_wunsch"
	case errors.Is(cause, errZeitlimit):
		e.Zustand, e.Grund = "abgebrochen", "zeitlimit"
	default:
		// The box is stopping: no result now - on the Docker box the order is
		// still on disk and the next start reports it aborted ("neustart").
		halt = true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.laufend == la {
		l.laufend = nil
	}
	if halt {
		return
	}
	l.o.Log.Info("geraetesuche: done", "such_id", e.SuchID, "zustand", e.Zustand, "grund", e.Grund,
		"funde", len(e.Funde), "dauer_ms", e.DauerMs)
	l.warte(e, true)
}

// warte queues a result and tries to send it at once. Caller holds mu.
func (l *Leitung) warte(e geraetesuche.Ergebnis, offen bool) {
	e.SchemaVersion = geraetesuche.SchemaVersion
	l.sendeMu.Lock()
	if len(l.wartend) < 16 {
		l.wartend = append(l.wartend, wartend{e: e, offen: offen})
	}
	l.sendeMu.Unlock()
	go l.Senden()
}

// Senden hands every waiting result to the link; one that does not go out
// stays waiting for the next try.
func (l *Leitung) Senden() {
	l.sendeMu.Lock()
	defer l.sendeMu.Unlock()
	tenant, site, device := l.o.Identitaet()
	if tenant == "" || site == "" || device == "" || l.o.SendeErgebnis == nil {
		return
	}
	rest := l.wartend[:0]
	for _, w := range l.wartend {
		e := w.e
		e.TenantID, e.SiteID, e.DeviceID = tenant, site, device
		if err := e.Pruefe(l.o.BoxArt); err != nil {
			// The box never sends what the schema refuses: a broken result
			// becomes an honest failure of the same search.
			l.o.Log.Error("geraetesuche: result invalid, reported as failed", "err", err)
			e.Zustand, e.Grund, e.Funde, e.Weitere = "fehlgeschlagen", "interner_fehler", []geraetesuche.Fund{}, geraetesuche.Weitere{}
			if _, err := geraetesuche.Bereiche(e.Netze); err != nil {
				e.Netze = []geraetesuche.Netz{}
			}
		}
		if err := l.o.SendeErgebnis(e); err != nil {
			rest = append(rest, w)
			continue
		}
		if w.offen {
			l.offenVergessen(e.SuchID)
		}
	}
	l.wartend = rest
}

// ---------------------------------------------------------------- the open order

type offenerAuftrag struct {
	SuchID string              `json:"such_id"`
	Netze  []geraetesuche.Netz `json:"netze"`
}

// offenMerken writes the open order atomically (temp, fsync, rename).
func (l *Leitung) offenMerken(suchID string, netze []geraetesuche.Netz) error {
	if l.o.OffenPfad == "" {
		return nil
	}
	raw, err := json.Marshal(offenerAuftrag{SuchID: suchID, Netze: netze})
	if err != nil {
		return err
	}
	tmp := l.o.OffenPfad + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
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
	return os.Rename(tmp, l.o.OffenPfad)
}

func (l *Leitung) offenVergessen(suchID string) {
	if l.o.OffenPfad == "" {
		return
	}
	raw, err := os.ReadFile(l.o.OffenPfad)
	if err != nil {
		return
	}
	var o offenerAuftrag
	if json.Unmarshal(raw, &o) == nil && o.SuchID != suchID {
		return // a newer order is open
	}
	if err := os.Remove(l.o.OffenPfad); err != nil && !errors.Is(err, os.ErrNotExist) {
		l.o.Log.Warn("geraetesuche: open order not removed", "err", err)
	}
}

// wiederherstellen reports an order that was open when the box stopped, once,
// aborted with "neustart" - a search is never resumed.
func (l *Leitung) wiederherstellen() {
	if l.o.OffenPfad == "" {
		return
	}
	raw, err := os.ReadFile(l.o.OffenPfad)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	var o offenerAuftrag
	if err == nil {
		err = json.Unmarshal(raw, &o)
	}
	if err != nil || o.SuchID == "" {
		l.o.Log.Warn("geraetesuche: open order unreadable; dropped", "err", err)
		_ = os.Remove(l.o.OffenPfad)
		return
	}
	netze := o.Netze
	if _, err := geraetesuche.Bereiche(netze); err != nil || netze == nil {
		netze = []geraetesuche.Netz{}
	}
	l.o.Log.Info("geraetesuche: order was open at the restart; reporting it aborted", "such_id", o.SuchID)
	l.mu.Lock()
	l.gesehen[o.SuchID] = l.o.Jetzt().UTC()
	l.warte(geraetesuche.Ergebnis{SuchID: o.SuchID, Ts: l.o.Jetzt().UTC(), Zustand: "abgebrochen", Grund: "neustart",
		Erkenner: []string{}, Netze: netze, Funde: []geraetesuche.Fund{}}, true)
	l.mu.Unlock()
}
