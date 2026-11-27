package vermarktertunnel

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
)

// The connection states of concept §5.4 ("Lagen des Anschlusses").
const (
	LageOhneProfil      = "ohne_profil"
	LageOhneZugang      = "ohne_zugang"
	LageBautAuf         = "baut_auf"
	LageTunnelOben      = "tunnel_oben"
	LageVerbunden       = "verbunden"
	LageVorgabeAktiv    = "vorgabe_aktiv"
	LageAbgelaufen      = "abgelaufen"
	LageTunnelUnten     = "tunnel_unten"
	LageZugangUngueltig = "zugang_ungueltig"
)

// GrundTunnelKommtNicht is set on LageBautAuf once the build-up has run for
// aufbauFrist without a peer (§5.4).
const GrundTunnelKommtNicht = "tunnel_kommt_nicht"

const (
	// tunnelFrisch: the peer's keepalive bytes arrived within this - the
	// §5.4 "Handshake jung". keepalive pings every 10 s; three missed plus
	// margin.
	tunnelFrisch = 90 * time.Second
	// abfrageFrisch: "verbunden" means the partner queried within 15 min.
	abfrageFrisch = 15 * time.Minute
	// aufbauFrist: after this much fruitless build-up the Grund
	// tunnel_kommt_nicht appears.
	aufbauFrist = 10 * time.Minute
	// trennAlarm: a lost tunnel raises the alarm event after 15 min (§5.6).
	trennAlarm = 15 * time.Minute
	// Growing back-off for restarting a DEAD daemon (the connection attempts
	// of a live daemon already grow via connect-retry in the config).
	startPauseMin = 10 * time.Second
	startPauseMax = 15 * time.Minute
)

// schnittstelle is the slice of direktvermarkter.Server the manager drives;
// an interface so the state machine tests run without sockets.
type schnittstelle interface {
	Start(addr string) error
	Stop()
	State() string
	LastQuery() time.Time
	Limit() (pct int, active bool)
	SetValues(at time.Time, values map[string]float64)
	Stand() direktvermarkter.ServerStand
}

// Options wires a Manager. Zero values mean: real clock, real runner, host-
// detected firewall, 5 s tick, 30 s input freshness.
type Options struct {
	Dir        string // delivery dir (flash) - see zugang.go
	RAM        string // tmpfs for pid and status file
	OpenVPNBin string
	Konfig     KonfigOptionen
	Takt       time.Duration
	StaleAfter time.Duration
	Jetzt      func() time.Time
	Netz       Netz
	Runner     Runner
	// OnEreignis mirrors every flash-list event to the caller (logging,
	// later the heartbeat). Never carries secrets.
	OnEreignis func(Ereignis)
	// LebenszeichenHoechstens SHORTENS the partner's watchdog deadline for
	// test rigs (the container probe shows the §5.4 expiry in minutes, not
	// 15 of them). It can only tighten: a value at or above the profile's
	// deadline - or 0 - changes nothing, so no configuration can ever
	// LOOSEN the watchdog.
	LebenszeichenHoechstens time.Duration
	// neueSchnittstelle is the test seam; nil = direktvermarkter.NewServer.
	neueSchnittstelle func(p direktvermarkter.Profile, staleAfter time.Duration, onEvent func(direktvermarkter.Event)) schnittstelle
}

// Status is the §5.4 view of the connection - for the local web app now and
// the heartbeat block in Stage 3. Display material only, never a secret.
type Status struct {
	Lage          string    `json:"lage"`
	Seit          time.Time `json:"seit"`
	Grund         string    `json:"grund,omitempty"`
	Fehler        string    `json:"fehler,omitempty"`
	Partner       string    `json:"partner,omitempty"`
	TunnelAdresse string    `json:"tunnel_adresse,omitempty"`
	Gegenstelle   string    `json:"gegenstelle,omitempty"`
	// TunnelLebteZuletzt is the last proof of the peer (the keepalive byte
	// counters grew) - the heartbeat block's handshake_am.
	TunnelLebteZuletzt *time.Time `json:"tunnel_lebte_zuletzt,omitempty"`
	LetzteAbfrage      *time.Time `json:"letzte_abfrage,omitempty"`
	VorgabePct         *int       `json:"vorgabe_pct,omitempty"`
	GrenzeKw           *float64   `json:"grenze_kw,omitempty"`
	GueltigBis         *time.Time `json:"gueltig_bis,omitempty"`
}

// Manager converges the box to the delivered state on every tick: profile
// and access from the delivery dir, configuration written, firewall applied,
// daemon supervised with growing back-off, Modbus interface bound to the
// tunnel address, Lage computed, events recorded.
type Manager struct {
	o      Options
	pfade  Pfade
	liste  ereignisliste
	jetzt  func() time.Time
	neueSS func(p direktvermarkter.Profile, staleAfter time.Duration, onEvent func(direktvermarkter.Event)) schnittstelle

	mu        sync.Mutex
	anschluss *Anschluss
	profil    *direktvermarkter.Profile
	server    schnittstelle
	zugang    *Zugang
	lage      string
	lageSeit  time.Time
	grund     string
	fehler    string
	addr      string // tunnel address the interface and firewall are on

	// tunnel liveness via the status file counters (stand.go)
	zaehler        uint64
	zaehlerGueltig bool
	lebteZuletzt   time.Time // last counter growth = last proof of the peer
	verbundenWar   bool      // the daemon run reached the peer at least once
	getrenntSeit   time.Time
	alarmGemeldet  bool
	aufbauSeit     time.Time

	// growing back-off for a dead daemon
	startPause    time.Duration
	naechsteStart time.Time

	// last reported set-point, to record its transitions once
	vorgabePct   int
	vorgabeAktiv bool

	netz        Netz
	netzDa      bool // rules currently applied
	konfigStand []byte
}

// New builds a Manager; Run starts its loop.
func New(o Options) *Manager {
	if o.Takt <= 0 {
		o.Takt = 5 * time.Second
	}
	if o.StaleAfter <= 0 {
		o.StaleAfter = 30 * time.Second
	}
	m := &Manager{
		o:     o,
		pfade: Pfade{Dir: o.Dir, RAM: o.RAM},
		liste: ereignisliste{pfad: Pfade{Dir: o.Dir, RAM: o.RAM}.Ereignisse()},
		jetzt: o.Jetzt,
	}
	if m.jetzt == nil {
		m.jetzt = time.Now
	}
	m.neueSS = o.neueSchnittstelle
	if m.neueSS == nil {
		m.neueSS = func(p direktvermarkter.Profile, staleAfter time.Duration, onEvent func(direktvermarkter.Event)) schnittstelle {
			return direktvermarkter.NewServer(p, staleAfter, onEvent)
		}
	}
	m.lage = LageOhneProfil
	m.lageSeit = m.jetzt()
	return m
}

// Run converges on every tick until ctx ends. On shutdown the DAEMON and the
// firewall stay: the tunnel belongs to the system, not the program (PS-D8) -
// only the box-local Modbus listener closes with the program that owns it.
func (m *Manager) Run(ctx context.Context) {
	t := time.NewTicker(m.o.Takt)
	defer t.Stop()
	m.Pruefe()
	for {
		select {
		case <-ctx.Done():
			m.mu.Lock()
			if m.server != nil {
				m.server.Stop()
			}
			m.mu.Unlock()
			return
		case <-t.C:
			m.Pruefe()
		}
	}
}

// Pruefe is one convergence tick (exported for the agent's tests and the
// container probe's determinism; Run calls it on every tick).
func (m *Manager) Pruefe() {
	now := m.jetzt()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.fehler = ""

	a, ok, err := LadeAnschluss(m.o.Dir)
	if err != nil {
		m.fehler = err.Error()
	}
	if !ok {
		m.abbauenLocked(now)
		m.setLageLocked(now, LageOhneProfil, "")
		return
	}
	profil, bekannt := direktvermarkter.For(a.Partner)
	if !bekannt {
		m.fehler = fmt.Sprintf("Partner %q ist nicht im Katalog dieser Fassung", a.Partner)
		m.abbauenLocked(now)
		m.setLageLocked(now, LageOhneProfil, "")
		return
	}
	if kurz := m.o.LebenszeichenHoechstens; kurz > 0 && int(kurz.Seconds()) < profil.Rules.WatchdogDeadlineS {
		profil.Rules.WatchdogDeadlineS = int(kurz.Seconds())
	}
	if m.anschluss == nil || m.anschluss.Partner != a.Partner || m.profil == nil {
		if m.server != nil {
			m.server.Stop()
		}
		m.server = m.neueSS(profil, m.o.StaleAfter, func(ev direktvermarkter.Event) {
			m.ereignis(Ereignis{Zeit: ev.At, Text: "lebenszeichen abgelaufen - vorgabe zurueck auf ruhewert"})
		})
		m.addr = "" // force a fresh bind
		m.ereignis(Ereignis{Zeit: now, Text: "anschluss " + a.Partner + " uebernommen"})
	}
	m.anschluss = &a
	m.profil = &profil

	z, zok, zerr := LadeZugang(m.o.Dir)
	if zerr != nil {
		m.fehler = zerr.Error()
	}
	if !zok {
		m.tunnelStoppenLocked()
		m.setLageLocked(now, LageOhneZugang, "")
		return
	}
	if z.Abgelaufen(now) {
		m.tunnelStoppenLocked()
		m.zugang = &z
		m.setLageLocked(now, LageZugangUngueltig, "")
		return
	}
	m.zugang = &z

	// Desired state: tunnel up. Configuration, firewall, daemon, binding.
	if err := m.tunnelSichernLocked(now, z, profil); err != nil && m.fehler == "" {
		m.fehler = err.Error()
	}
	m.lageAusTunnelLocked(now)
	m.vorgabeVerfolgenLocked(now)
}

// tunnelSichernLocked writes the configuration when it changed, applies the
// firewall for the current tunnel address, keeps the daemon alive with a
// growing back-off and the Modbus interface bound to the tunnel address.
func (m *Manager) tunnelSichernLocked(now time.Time, z Zugang, profil direktvermarkter.Profile) error {
	konfig, err := OpenVPNKonfig(z, m.pfade, m.o.Konfig)
	if err != nil {
		return err
	}
	runner := m.runner()
	if !bytes.Equal(konfig, m.konfigStand) {
		alt, leseErr := os.ReadFile(m.pfade.Konfig())
		if leseErr != nil || !bytes.Equal(alt, konfig) {
			if err := os.WriteFile(m.pfade.Konfig(), konfig, 0o600); err != nil {
				return err
			}
			// A changed peer or TLS mode only takes effect in a fresh daemon.
			if runner.Alive() {
				_ = runner.Stop()
			}
		}
		m.konfigStand = konfig
	}

	if !runner.Alive() {
		if m.naechsteStart.IsZero() || !now.Before(m.naechsteStart) {
			if err := runner.Start(m.pfade.Konfig()); err != nil {
				m.fehler = err.Error()
			}
			if m.startPause == 0 {
				m.startPause = startPauseMin
			} else if m.startPause < startPauseMax {
				m.startPause *= 2
				if m.startPause > startPauseMax {
					m.startPause = startPauseMax
				}
			}
			m.naechsteStart = now.Add(m.startPause)
			if m.aufbauSeit.IsZero() {
				m.aufbauSeit = now
			}
		}
	}

	// Liveness from the status file counters (stand.go).
	if summe, _, ok := zaehlerStand(m.pfade.Stand()); ok {
		if !m.zaehlerGueltig || summe != m.zaehler {
			if m.zaehlerGueltig && summe != m.zaehler {
				if m.lebteZuletzt.IsZero() || !m.tunnelFrischLocked(m.lebteZuletzt) {
					// first proof of the peer (again)
					m.ereignis(Ereignis{Zeit: now, Text: "tunnel verbunden (" + z.Gegenstelle.Host + ":" + strconv.Itoa(z.Gegenstelle.Port) + ")"})
				}
				m.lebteZuletzt = now
				m.verbundenWar = true
				m.getrenntSeit = time.Time{}
				m.alarmGemeldet = false
				m.aufbauSeit = time.Time{}
				m.startPause = 0
				m.naechsteStart = time.Time{}
			}
			m.zaehler = summe
			m.zaehlerGueltig = true
		}
	} else {
		m.zaehlerGueltig = false
	}

	// Tunnel address: bind the interface and point the firewall at it.
	addr := tunnelAdresse()
	if addr != m.addr {
		if m.server != nil {
			m.server.Stop()
		}
		if addr != "" && m.server != nil {
			ziel := net.JoinHostPort(addr, strconv.Itoa(profil.Modbus.Port))
			if err := m.server.Start(ziel); err != nil {
				m.fehler = "schnittstelle: " + err.Error()
			}
		}
		if err := m.netzAnwenden(addr, profil.Modbus.Port); err != nil {
			return err
		}
		m.addr = addr
	} else if m.addr != "" && !m.netzDa {
		if err := m.netzAnwenden(m.addr, profil.Modbus.Port); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) netzAnwenden(addr string, port int) error {
	if m.netz == nil {
		m.netz = m.o.Netz
	}
	if m.netz == nil {
		m.netz = NetzFuerHost(port)
	}
	if err := m.netz.Anwenden(NftRegeln(addr, port)); err != nil {
		return fmt.Errorf("firewall: %w", err)
	}
	m.netzDa = true
	return nil
}

func (m *Manager) tunnelFrischLocked(seit time.Time) bool {
	return !seit.IsZero() && m.jetzt().Sub(seit) < tunnelFrisch
}

// lageAusTunnelLocked maps the observed tunnel + interface facts onto the
// §5.4 Lagen while profile and access are in place.
func (m *Manager) lageAusTunnelLocked(now time.Time) {
	frisch := m.tunnelFrischLocked(m.lebteZuletzt)
	switch {
	case frisch:
		abfrage := time.Time{}
		state := ""
		if m.server != nil {
			abfrage = m.server.LastQuery()
			state = m.server.State()
		}
		switch {
		case abfrage.IsZero() || now.Sub(abfrage) > abfrageFrisch:
			m.setLageLocked(now, LageTunnelOben, "")
		case state == direktvermarkter.StateLimitActive:
			m.setLageLocked(now, LageVorgabeAktiv, "")
		case state == direktvermarkter.StateExpired:
			m.setLageLocked(now, LageAbgelaufen, "")
		default:
			m.setLageLocked(now, LageVerbunden, "")
		}
	case m.verbundenWar:
		if m.getrenntSeit.IsZero() {
			m.getrenntSeit = m.lebteZuletzt
			m.ereignis(Ereignis{Zeit: now, Text: "tunnel getrennt"})
		}
		if !m.alarmGemeldet && now.Sub(m.getrenntSeit) >= trennAlarm {
			m.alarmGemeldet = true
			m.ereignis(Ereignis{Zeit: now, Text: "tunnel seit 15 min getrennt (alarm)"})
		}
		m.setLageLocked(now, LageTunnelUnten, "")
	default:
		grund := ""
		if !m.aufbauSeit.IsZero() && now.Sub(m.aufbauSeit) >= aufbauFrist {
			grund = GrundTunnelKommtNicht
		}
		if m.aufbauSeit.IsZero() {
			m.aufbauSeit = now
		}
		m.setLageLocked(now, LageBautAuf, grund)
	}
}

// vorgabeVerfolgenLocked records set-point transitions once, as events.
func (m *Manager) vorgabeVerfolgenLocked(now time.Time) {
	if m.server == nil {
		return
	}
	pct, aktiv := m.server.Limit()
	if aktiv != m.vorgabeAktiv || (aktiv && pct != m.vorgabePct) {
		if aktiv {
			m.ereignis(Ereignis{Zeit: now, Text: fmt.Sprintf("vorgabe %d %% aktiv", pct)})
		} else if m.vorgabeAktiv {
			m.ereignis(Ereignis{Zeit: now, Text: "vorgabe aufgehoben (ruhewert)"})
		}
	}
	m.vorgabePct, m.vorgabeAktiv = pct, aktiv
}

// tunnelStoppenLocked takes the tunnel down (access withdrawn, expired or
// never delivered) but keeps profile knowledge.
func (m *Manager) tunnelStoppenLocked() {
	_ = m.runner().Stop()
	if m.server != nil {
		m.server.Stop()
	}
	if m.netzDa && m.netz != nil {
		// Keep the chains, but with no accepted inbound port: the safe
		// ruleset for a tunnel that must not stand.
		port := 502
		if m.profil != nil {
			port = m.profil.Modbus.Port
		}
		_ = m.netz.Anwenden(NftRegeln("", port))
	}
	_ = os.Remove(m.pfade.Konfig())
	m.konfigStand = nil
	m.addr = ""
	m.zaehlerGueltig = false
	m.lebteZuletzt = time.Time{}
	m.verbundenWar = false
	m.aufbauSeit = time.Time{}
	m.startPause = 0
	m.naechsteStart = time.Time{}
}

// abbauenLocked withdraws everything (profile gone): tunnel, firewall rules,
// interface. The delivered access FILES stay the delivery's business.
func (m *Manager) abbauenLocked(now time.Time) {
	if m.anschluss == nil && !m.netzDa {
		return
	}
	m.tunnelStoppenLocked()
	if m.netz != nil && m.netzDa {
		_ = m.netz.Entfernen()
		m.netzDa = false
	}
	if m.anschluss != nil {
		m.ereignis(Ereignis{Zeit: now, Text: "anschluss " + m.anschluss.Partner + " zurueckgezogen"})
	}
	m.anschluss = nil
	m.profil = nil
	m.server = nil
	m.zugang = nil
}

func (m *Manager) runner() Runner {
	if m.o.Runner == nil {
		m.o.Runner = &ExecRunner{Bin: m.o.OpenVPNBin, Pfade: m.pfade}
	}
	return m.o.Runner
}

func (m *Manager) setLageLocked(now time.Time, lage, grund string) {
	if m.lage != lage {
		m.lage = lage
		m.lageSeit = now
		slog.Info("direktvermarktung: lage", "lage", lage, "grund", grund)
	}
	m.grund = grund
}

func (m *Manager) ereignis(ev Ereignis) {
	m.liste.schreibe(ev)
	slog.Info("direktvermarktung: ereignis", "text", ev.Text)
	if m.o.OnEreignis != nil {
		m.o.OnEreignis(ev)
	}
}

// --- what the agent reads and feeds -------------------------------------------

// SetValues forwards the gated composite values to the partner interface
// (nothing here ever reads a device - the agent feeds what it already has).
func (m *Manager) SetValues(at time.Time, values map[string]float64) {
	m.mu.Lock()
	s := m.server
	m.mu.Unlock()
	if s != nil {
		s.SetValues(at, values)
	}
}

// Grenze is the partner limit for the guard chain: the effective limit in
// kW (from the percent set-point and the delivered reference power) while
// the watchdog is fresh and the set-point is below the rest value. wirktAuf
// says what it limits (direktvermarkter.WirktAufEinspeisung or
// ...Erzeugung).
func (m *Manager) Grenze() (kw float64, wirktAuf string, aktiv bool) {
	m.mu.Lock()
	s, a, p := m.server, m.anschluss, m.profil
	m.mu.Unlock()
	if s == nil || a == nil || p == nil {
		return 0, "", false
	}
	pct, active := s.Limit()
	if !active {
		return 0, p.Rules.WirktAuf, false
	}
	return a.ReferenzWp * float64(pct) / 100 / 1000, p.Rules.WirktAuf, true
}

// ServerStand is the partner interface's own snapshot (watchdog, last write,
// query counter, cached values) - the heartbeat block's facts beyond Status.
// ok=false while no profile is adopted.
func (m *Manager) ServerStand() (direktvermarkter.ServerStand, bool) {
	m.mu.Lock()
	s := m.server
	m.mu.Unlock()
	if s == nil {
		return direktvermarkter.ServerStand{}, false
	}
	return s.Stand(), true
}

// Ereignis records a DELIVERY event (profile received, access stored or
// deleted) in the same flash list as the tunnel's own - one evidence trail
// per connection (§5.4 "Nachweis"). The text carries state words only, never
// a key or file content; the caller holds to that like every ereignis here.
func (m *Manager) Ereignis(text string) {
	m.ereignis(Ereignis{Zeit: m.jetzt(), Text: text})
}

// Anschluss returns the delivered connection facts (ok=false without one).
func (m *Manager) Anschluss() (Anschluss, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.anschluss == nil {
		return Anschluss{}, false
	}
	return *m.anschluss, true
}

// Status is the current §5.4 view.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := Status{Lage: m.lage, Seit: m.lageSeit, Grund: m.grund, Fehler: m.fehler, TunnelAdresse: m.addr}
	if m.anschluss != nil {
		st.Partner = m.anschluss.Partner
	}
	if !m.lebteZuletzt.IsZero() {
		t := m.lebteZuletzt
		st.TunnelLebteZuletzt = &t
	}
	if m.zugang != nil {
		st.Gegenstelle = fmt.Sprintf("%s:%d", m.zugang.Gegenstelle.Host, m.zugang.Gegenstelle.Port)
		if !m.zugang.GueltigBis.IsZero() {
			t := m.zugang.GueltigBis
			st.GueltigBis = &t
		}
	}
	if m.server != nil {
		if q := m.server.LastQuery(); !q.IsZero() {
			st.LetzteAbfrage = &q
		}
		pct, aktiv := m.server.Limit()
		st.VorgabePct = &pct
		if aktiv && m.anschluss != nil {
			kw := m.anschluss.ReferenzWp * float64(pct) / 100 / 1000
			st.GrenzeKw = &kw
		}
	}
	return st
}
