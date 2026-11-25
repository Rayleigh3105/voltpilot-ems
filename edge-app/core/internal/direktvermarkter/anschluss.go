package direktvermarkter

import (
	"errors"
	"log/slog"
	"path/filepath"
	"reflect"
	"strconv"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ereignisliste"
)

var (
	errZugangOhneProfil            = errors.New("direktvermarktung: zugang ohne aktives profil - verworfen")
	errZugangFalscherFingerabdruck = errors.New("direktvermarktung: zugang mit fremdem fingerabdruck - verworfen")
)

// Anschluss is the shared box-side state of the direct-marketing connection
// (vp-direktvermarktung-konzept d2 §5.4), for BOTH box kinds: it holds the
// delivered profile, the access store, the partner's data-mirror Server and
// the tunnel facts, and derives the one Lage the customer reads.
//
// What it does NOT do (Stage 2 Mango / Stage 4 PFC200): bring up OpenVPN,
// open the firewall, start the Server's listener on the tunnel address, feed
// SetValues from the measurements, or wire the limit into composeCurtailment.
// Those stages attach through SetzeTunnel / Server / SetValues; until a
// tunnel manager attaches, a connection with profile and access honestly
// stays in "baut_auf" - the tunnel is indeed not up yet.
const (
	// handshakeFrisch separates "tunnel_oben" from "tunnel_unten" (§5.4:
	// Handshake älter als 3 Min. = tunnel_unten).
	handshakeFrisch = 3 * time.Minute
	// abfrageFrisch separates "verbunden" from "tunnel_oben" (§5.4: letzte
	// Abfrage jünger als 15 Min. = verbunden).
	abfrageFrisch = 15 * time.Minute
	// werteFrisch bounds the input cache like the Stage-1 server command does.
	werteFrisch = 30 * time.Second
)

// The Lagen of §5.4 this component can observe today. The remaining ones
// ("zugang_ungueltig" via SetzeZugangUngueltig, handshake-driven states via
// SetzeTunnel) switch on as soon as a tunnel manager attaches.
const (
	LageOhneProfil    = "ohne_profil"
	LageOhneZugang    = "ohne_zugang"
	LageBautAuf       = "baut_auf"
	LageTunnelOben    = "tunnel_oben"
	LageVerbunden     = "verbunden"
	LageVorgabeAktiv  = "vorgabe_aktiv"
	LageAbgelaufen    = "abgelaufen"
	LageTunnelUnten   = "tunnel_unten"
	LageZugangKaputt  = "zugang_ungueltig"
)

// TunnelStand is what the tunnel manager (Stage 2/4) reports about the VPN.
type TunnelStand struct {
	ObenSeit    time.Time
	HandshakeAm time.Time
	Gegenstelle string
}

// AnschlussStand is one snapshot for the heartbeat block, the dv.* points and
// the local card.
type AnschlussStand struct {
	Partner             string
	Lage                string
	Revision            int
	ZugangFingerabdruck string // the access the box HOLDS ("" = none)
	ErwarteterZugang    string // the access the profile names
	Tunnel              *TunnelStand
	Server              *ServerStand // nil without a profile
}

// Anschluss events beyond the Server's own (§5.4 Nachweis).
const (
	EventProfilErhalten      = "profil_erhalten"
	EventProfilZurueck       = "profil_zurueckgezogen"
	EventZugangGespeichert   = "zugang_gespeichert"
	EventZugangGeloescht     = "zugang_geloescht"
)

// Anschluss owns the box-side state. All methods are safe for concurrent use.
type Anschluss struct {
	ablage Ablage
	liste  *ereignisliste.Liste
	now    func() time.Time

	mu              sync.Mutex
	doc             *ProfilDokument
	server          *Server
	tunnel          *TunnelStand
	zugangUngueltig bool

	// Server events arrive while the Server's own mutex is held (see
	// server.go): they are handed off here and drained by one goroutine, so
	// flash I/O never stalls a Modbus answer.
	events chan Event
	quit   chan struct{}
	done   sync.WaitGroup
}

// NewAnschluss builds the connection state over the given store. The event
// list lives beside the access (§5.4: Ereignisliste im Flash). onEvent (may
// be nil) additionally receives every event after it is recorded.
func NewAnschluss(ablage Ablage, onEvent func(Event)) *Anschluss {
	a := &Anschluss{
		ablage: ablage,
		liste:  &ereignisliste.Liste{Pfad: filepath.Join(ablage.Dir, AblageEreignisse)},
		now:    time.Now,
		events: make(chan Event, 32),
		quit:   make(chan struct{}),
	}
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		for {
			select {
			case ev := <-a.events:
				a.recordEvent(ev)
				if onEvent != nil {
					onEvent(ev)
				}
			case <-a.quit:
				return
			}
		}
	}()
	return a
}

// Close stops the event drain. Pending events may be dropped - the list is
// evidence, not a ledger.
func (a *Anschluss) Close() {
	close(a.quit)
	a.done.Wait()
}

func (a *Anschluss) emit(ev Event) {
	select {
	case a.events <- ev:
	default:
		// A full queue drops the oldest evidence path silently rather than
		// blocking a Modbus answer; the heartbeat still carries the state.
	}
}

func (a *Anschluss) recordEvent(ev Event) {
	text := ev.Kind
	if ev.Pct != nil {
		text = text + " pct=" + strconv.Itoa(*ev.Pct)
	}
	if err := a.liste.Schreibe(text); err != nil {
		slog.Warn("direktvermarktung: Ereignisliste nicht beschreibbar", "err", err)
	}
}

// Boot restores the persisted profile document at start, so a box that boots
// offline serves its state (and later, Stage 2, its tunnel) without waiting
// for the broker. A corrupt file leaves the box without a profile - the
// retained redelivery repairs that on the next connect.
func (a *Anschluss) Boot() {
	raw, ok := a.ablage.LadeProfil()
	if !ok {
		return
	}
	doc, err := ParseProfilDokument(raw)
	if err != nil || doc == nil {
		if err != nil {
			slog.Warn("direktvermarktung: gespeichertes Profil beschaedigt - verworfen", "err", err)
		}
		return
	}
	if _, _, err := a.UebernimmProfil(doc, nil); err != nil {
		slog.Warn("direktvermarktung: gespeichertes Profil nicht uebernommen", "err", err)
	}
}

// UebernimmProfil applies a (re)delivered profile document. persistRaw, when
// non-nil, is written to the store (the boot path passes nil - the file is
// already on disk).
//
// It returns which access the box must now ASK for (zugangNoetig) and which
// stored access it DELETED because the profile names a different one
// (geloeschterZugang, "" = none) - the caller acknowledges that deletion.
// Redelivery of the unchanged document (every reconnect, retained) is
// idempotent and never resets the running Server's watchdog state.
func (a *Anschluss) UebernimmProfil(doc *ProfilDokument, persistRaw []byte) (zugangNoetig bool, geloeschterZugang string, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	neu := a.doc == nil || a.doc.Partner != doc.Partner ||
		!reflect.DeepEqual(a.doc.Profil, doc.Profil)
	bekannt := a.doc != nil && a.doc.Revision == doc.Revision &&
		a.doc.ZugangFingerabdruck == doc.ZugangFingerabdruck && !neu

	if persistRaw != nil {
		if err := a.ablage.SpeichereProfil(persistRaw); err != nil {
			return false, "", err
		}
	}
	a.doc = doc
	if neu {
		if a.server != nil {
			a.server.Stop()
		}
		a.server = NewServer(*doc.Profil, werteFrisch, a.emit)
	}
	if !bekannt {
		a.emit(Event{Kind: EventProfilErhalten, At: a.now()})
	}

	stored, hasStored := a.ablage.Zugang()
	if hasStored && stored.Fingerabdruck == doc.ZugangFingerabdruck {
		return false, "", nil
	}
	if hasStored {
		// The profile names a DIFFERENT access: the old one is obsolete and
		// is deleted before the new one is asked for - the box never holds
		// two (§8 "Ein Zertifikat, eine Anlage").
		if err := a.ablage.LoescheZugang(); err != nil {
			return true, "", err
		}
		a.emit(Event{Kind: EventZugangGeloescht, At: a.now()})
		return true, stored.Fingerabdruck, nil
	}
	return true, "", nil
}

// Zuruecknehmen applies the retained-clear (empty profile): the Server stops,
// access and profile are deleted. It returns the fingerprint of the access it
// deleted ("" = none was stored) - the caller acknowledges with "geloescht"
// so the box swap can proceed (§5.7: the old box deletes and acknowledges
// BEFORE the new one receives).
func (a *Anschluss) Zuruecknehmen() (geloeschterZugang string, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.doc == nil {
		// Nothing was delivered; still make sure nothing is left on disk.
		stored, hasStored := a.ablage.Zugang()
		if err := a.ablage.LoescheZugang(); err != nil {
			return "", err
		}
		_ = a.ablage.LoescheProfil()
		if hasStored {
			a.emit(Event{Kind: EventZugangGeloescht, At: a.now()})
			return stored.Fingerabdruck, nil
		}
		return "", nil
	}
	stored, hasStored := a.ablage.Zugang()
	if err := a.ablage.LoescheZugang(); err != nil {
		return "", err
	}
	if err := a.ablage.LoescheProfil(); err != nil {
		return "", err
	}
	if a.server != nil {
		a.server.Stop()
		a.server = nil
	}
	a.doc = nil
	a.tunnel = nil
	a.zugangUngueltig = false
	a.emit(Event{Kind: EventProfilZurueck, At: a.now()})
	if hasStored {
		a.emit(Event{Kind: EventZugangGeloescht, At: a.now()})
		return stored.Fingerabdruck, nil
	}
	return "", nil
}

// UebernimmZugang stores a delivered access. It is accepted only when a
// profile is active and names exactly this fingerprint - a late or
// misdirected answer changes nothing.
func (a *Anschluss) UebernimmZugang(z *ZugangAntwort) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.doc == nil {
		return errZugangOhneProfil
	}
	if a.doc.ZugangFingerabdruck != z.ZugangFingerabdruck {
		return errZugangFalscherFingerabdruck
	}
	if err := a.ablage.SpeichereZugang(z, a.now()); err != nil {
		return err
	}
	a.zugangUngueltig = false
	a.emit(Event{Kind: EventZugangGespeichert, At: a.now()})
	return nil
}

// ErwarteterZugang returns the fingerprint the active profile names and
// whether the box already holds it.
func (a *Anschluss) ErwarteterZugang() (fingerabdruck string, vorhanden bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.doc == nil {
		return "", false
	}
	stored, hasStored := a.ablage.Zugang()
	return a.doc.ZugangFingerabdruck, hasStored && stored.Fingerabdruck == a.doc.ZugangFingerabdruck
}

// SetzeTunnel is the Stage-2/4 hook: the tunnel manager reports the VPN facts
// (nil = tunnel torn down).
func (a *Anschluss) SetzeTunnel(t *TunnelStand) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.tunnel = t
}

// SetzeZugangUngueltig is the Stage-2/4 hook for a rejected or expired
// certificate (§5.4 "zugang_ungueltig").
func (a *Anschluss) SetzeZugangUngueltig(ungueltig bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.zugangUngueltig = ungueltig
}

// SetValues feeds the Server's input cache (Stage 2: from the measurements
// the box already holds, never a new device read). Without a profile it does
// nothing.
func (a *Anschluss) SetValues(at time.Time, values map[string]float64) {
	a.mu.Lock()
	srv := a.server
	a.mu.Unlock()
	if srv != nil {
		srv.SetValues(at, values)
	}
}

// Server exposes the partner interface for the tunnel manager (Stage 2/4
// starts and stops its listener on the tunnel address); nil without a
// profile.
func (a *Anschluss) Server() *Server {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.server
}

// Stand is the one snapshot everything reports from (§5.4 "Stand").
func (a *Anschluss) Stand() *AnschlussStand {
	a.mu.Lock()
	doc := a.doc
	srv := a.server
	tunnel := a.tunnel
	ungueltig := a.zugangUngueltig
	a.mu.Unlock()
	if doc == nil {
		return nil
	}
	stored, hasStored := a.ablage.Zugang()
	st := &AnschlussStand{
		Partner:          doc.Partner,
		Revision:         doc.Revision,
		ErwarteterZugang: doc.ZugangFingerabdruck,
		Tunnel:           tunnel,
	}
	if hasStored {
		st.ZugangFingerabdruck = stored.Fingerabdruck
	}
	if srv != nil {
		s := srv.Stand()
		st.Server = &s
	}
	st.Lage = a.lage(doc, st, hasStored && stored.Fingerabdruck == doc.ZugangFingerabdruck, ungueltig)
	return st
}

// Lage derives the §5.4 state from the snapshot. The order mirrors the
// concept table: the most fundamental lack wins.
func (a *Anschluss) lage(doc *ProfilDokument, st *AnschlussStand, zugangDa, ungueltig bool) string {
	if ungueltig {
		return LageZugangKaputt
	}
	if !zugangDa {
		return LageOhneZugang
	}
	now := a.now()
	t := st.Tunnel
	if t == nil || (t.HandshakeAm.IsZero() && t.ObenSeit.IsZero()) {
		return LageBautAuf
	}
	if t.HandshakeAm.IsZero() || now.Sub(t.HandshakeAm) > handshakeFrisch {
		if t.HandshakeAm.IsZero() {
			return LageBautAuf
		}
		return LageTunnelUnten
	}
	s := st.Server
	if s == nil {
		return LageTunnelOben
	}
	if s.State == StateExpired {
		return LageAbgelaufen
	}
	if s.LetzteAbfrage.IsZero() || now.Sub(s.LetzteAbfrage) > abfrageFrisch {
		return LageTunnelOben
	}
	if s.Aktiv {
		return LageVorgabeAktiv
	}
	return LageVerbunden
}

// WerteAktuell returns the input cache (by Bedeutung) when it is FRESH - the
// same bound the Server itself answers reads under. ok=false means the
// partner currently gets the stale exception, so nothing is reported either
// (§5.1 "veraltete Telemetrie ist nicht aktuell").
func (st *AnschlussStand) WerteAktuell(now time.Time) (map[string]float64, bool) {
	s := st.Server
	if s == nil || len(s.Werte) == 0 || s.WerteStand.IsZero() || now.Sub(s.WerteStand) > werteFrisch {
		return nil, false
	}
	return s.Werte, true
}

// GrenzeKw is the effective partner limit in kW, when it can be computed:
// effective set-point times the reference power from the FRESH input cache
// (concept §5.4 "aus Prozent und Referenz eine Grenze in kW"). ok=false when
// no limit is active or the reference is unknown/stale - unknown is never
// zero.
func (st *AnschlussStand) GrenzeKw(now time.Time) (float64, bool) {
	s := st.Server
	if s == nil || !s.Aktiv {
		return 0, false
	}
	referenz, ok := s.Werte["referenz_w"]
	if !ok || s.WerteStand.IsZero() || now.Sub(s.WerteStand) > werteFrisch {
		return 0, false
	}
	return referenz * float64(s.EffektivPct) / 100 / 1000, true
}
