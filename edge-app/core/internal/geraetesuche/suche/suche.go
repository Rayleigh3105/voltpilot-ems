// Package suche is the device search of the box (Gerätesuche,
// docs/contracts/v2/mqtt-geraetesuche.md; concept vp-portal-geraetesuche-konzept
// §5-§8). One Go module for both box types; it differs only in what the box
// can see (DP-2 A):
//
//   - Edge Light (a router) walks its own private networks: a UDP nudge per
//     address makes the kernel ask by ARP, /proc/net/arp names who answered,
//     and only those neighbours are spoken to. mDNS, SSDP, the Speedwire
//     multicast and the built-in vendor list of radio modules add hints.
//   - The Docker box sits in a bridge container behind NAT: it tries TCP to
//     all 253 addresses of the /24 around VP_LAN_HOST. Multicast and MAC
//     addresses never reach it, so it runs none of those ways.
//
// Everything is READ-ONLY (werkzeug.go): a TCP connect, an HTTP GET on a
// fixed path, Modbus FC 3 on identity registers, Solarman V5 FC 3 on
// 0x0000-0x0007. Never a login, a default password, a write, an AT command or
// a configuration page; 401/403 ends a recogniser with hindernis geschuetzt.
//
// MAC addresses and names stay in this process's memory for the length of a
// search (DP-3 A): no Fund has a field for them, and phones, computers and the
// unknown leave the box only as a count in weitere.
//
// The search is bounded by the box, not by the order: its own networks only,
// each at most /24, at most two; JeSekunde new connections per second; at most
// AnfragenJeErkenner requests per recogniser and device; Zeitlimit per
// request. The caller (Leitung) bounds the duration and the frequency.
package suche

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"sort"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

// Umgebung is what the box can see. Everything that touches the network or
// the kernel is a field, so the same search runs on both box types and against
// simulators in a test.
type Umgebung struct {
	// BoxArt is geraetesuche.BoxArtDocker or BoxArtEdgeLight.
	BoxArt string
	// LANHost is VP_LAN_HOST of the Docker box ("" = missing).
	LANHost string

	// Edge Light: interfaces, routing table, ARP table and the UDP nudge.
	Schnittstellen func() ([]Schnittstelle, error)
	Routen         func() ([]Route, error)
	Nachbarn       func() ([]Nachbar, error)
	Anstoss        func(ctx context.Context, ip netip.Addr) error
	// Rundruf asks and listens by multicast (mDNS, SSDP, Speedwire); nil = no
	// such ways (always on the Docker box).
	Rundruf Rundruf

	// Dial opens a TCP connection (nil = net.Dialer).
	Dial func(ctx context.Context, addr string) (net.Conn, error)

	// Bekannt is what the box already reads: never connected again.
	Bekannt []Bekannt
	// Spur takes the Layer-1 logger lane of a Solarman address before the
	// search speaks to it (Edge Light); nil = none.
	Spur func(ctx context.Context, addr string) (release func(), ok bool)

	Takt Takt
	Log  *slog.Logger
}

// Nachbar is one complete entry of the ARP table. The MAC stays on the box.
type Nachbar struct {
	IP            netip.Addr
	MAC           net.HardwareAddr
	Schnittstelle string
}

// Bekannt is a device the box already reads (inverter selection, sources,
// entity registry), in the words of its configuration.
type Bekannt struct {
	Communication string
	IP            string
	Port          int
	// Serial is the Solarman logger serial as configured ("" = none).
	Serial     string
	UnitID     int
	Familie    string
	Hersteller string
	Modell     string
	// Rolle is the source role (plant-controller marks a WAGO controller).
	Rolle string
}

// geraet is one address of the search, in RAM only.
type geraet struct {
	lauf    *Lauf
	ip      netip.Addr
	mac     net.HardwareAddr // Edge Light; never leaves the box
	alive   bool
	offen   map[int]bool
	hinweis hinweise
	// httpGefragt: the device's first HTTP request is sent - only that one
	// may be repeated (werkzeug.go, budget.get).
	httpGefragt bool
}

// hinweise are what the multicast ways and the vendor list said about an
// address - reduced to words before anything is kept.
type hinweise struct {
	mdns      map[string]bool // shelly, goe, telefon, rechner
	ssdp      string          // LOCATION of an SSDP answer
	speedwire uint32          // SMA energy meter serial (0 = none)
	funkmodul string          // vendor of the radio module (vendor list)
}

// Ausgang is what a search found. Zustand and Grund are the caller's: the
// search does not know why its context ended.
type Ausgang struct {
	Netze    []geraetesuche.Netz
	Funde    []geraetesuche.Fund
	Weitere  geraetesuche.Weitere
	Erkenner []string
}

// Zwischen is a snapshot for the progress message.
type Zwischen struct {
	Schritt  string
	Erledigt int
	Gesamt   int
	Netze    []geraetesuche.Netz
	// Funde is every find so far; the caller sends the new ones.
	Funde []geraetesuche.Fund
}

// Lauf is one search.
type Lauf struct {
	u        Umgebung
	erkenner map[string]bool
	takt     *taktgeber
	http     *http.Client
	dial     func(ctx context.Context, addr string) (net.Conn, error)
	log      *slog.Logger

	wahl     []netzwahl
	bereiche []probe.Bereich

	mu       sync.Mutex
	schritt  string
	erledigt int
	gesamt   int
	// vorbehalt is the part of gesamt that stands for a step still to come
	// whose units are not known yet; that step replaces it with its own.
	vorbehalt int
	netze     []geraetesuche.Netz
	funde     []geraetesuche.Fund
	liefen    map[string]bool
}

// ErkennerDerBox lists the recognisers and ways this box type runs, in
// contract order: the ways (mdns, ssdp, funkmodul) only on Edge Light.
func ErkennerDerBox(boxArt string) []string {
	out := make([]string, 0, len(geraetesuche.Erkenner))
	for _, e := range geraetesuche.Erkenner {
		if boxArt != geraetesuche.BoxArtEdgeLight && enthaelt(geraetesuche.Wege, e) {
			continue
		}
		out = append(out, e)
	}
	return out
}

// Neu prepares a search. erkenner is the order's narrowing (nil = all of this
// box type). The second result is the refusal reason of step 1
// (lan_host_fehlt, kein_privates_netz); then there is nothing to search.
func Neu(u Umgebung, erkenner []string) (*Lauf, string) {
	if u.Log == nil {
		u.Log = slog.Default()
	}
	l := &Lauf{u: u, erkenner: map[string]bool{}, takt: neuerTaktgeber(u.Takt.jeSekunde()), log: u.Log,
		schritt: "netze_bestimmen", liefen: map[string]bool{}}
	for _, e := range ErkennerDerBox(u.BoxArt) {
		if erkenner == nil || enthaelt(erkenner, e) {
			l.erkenner[e] = true
		}
	}
	l.dial = u.Dial
	if l.dial == nil {
		var d net.Dialer
		l.dial = func(ctx context.Context, addr string) (net.Conn, error) { return d.DialContext(ctx, "tcp", addr) }
	}
	l.http = l.neuerHTTPClient()
	wahl, grund := waehleNetze(u)
	if grund != "" {
		return nil, grund
	}
	l.wahl = wahl
	for _, w := range wahl {
		l.bereiche = append(l.bereiche, w.bereich)
		l.netze = append(l.netze, w.netz)
	}
	return l, ""
}

// Netze is the networks of the search as reported.
func (l *Lauf) Netze() []geraetesuche.Netz {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]geraetesuche.Netz(nil), l.netze...)
}

// Stand is a snapshot for the progress message.
func (l *Lauf) Stand() Zwischen {
	l.mu.Lock()
	defer l.mu.Unlock()
	return Zwischen{Schritt: l.schritt, Erledigt: l.erledigt, Gesamt: l.gesamt,
		Netze: append([]geraetesuche.Netz{}, l.netze...), Funde: append([]geraetesuche.Fund{}, l.funde...)}
}

// schritte enters a step with its units and a reserve for the step after it
// (VoltPilotGATE 30.10.2026: rest_s stood at 0 while the follow-up still ran,
// because gesamt only grew when a step began).
func (l *Lauf) schritte(schritt string, mehr, vorbehalt int) {
	l.mu.Lock()
	l.schritt = schritt
	l.gesamt += mehr - l.vorbehalt + vorbehalt
	l.vorbehalt = vorbehalt
	l.mu.Unlock()
}

func (l *Lauf) erledige(n int) {
	l.mu.Lock()
	l.erledigt += n
	if l.erledigt > l.gesamt {
		l.erledigt = l.gesamt
	}
	l.mu.Unlock()
}

func (l *Lauf) lief(name string) {
	l.mu.Lock()
	l.liefen[name] = true
	l.mu.Unlock()
}

// melde adds a find - checked against the contract first: the box never
// sends what the schema refuses, and a schluessel stays unique.
func (l *Lauf) melde(f geraetesuche.Fund) bool {
	if row, ok := geraetesuche.KatalogPaar(f.Erkenner, f.Art); ok {
		f.Anbindung = row.Anbindung(l.u.BoxArt)
		if f.Erkennung == geraetesuche.ErkennungUnbekannt {
			f.Anbindung = geraetesuche.AnbindungSelbstBeschreiben
		}
	}
	if err := geraetesuche.PruefeFund(f, l.bereiche); err != nil {
		l.log.Warn("geraetesuche: find dropped", "erkenner", f.Erkenner, "err", err)
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.funde) >= geraetesuche.MaxFunde {
		return false
	}
	for _, g := range l.funde {
		if g.Schluessel == f.Schluessel {
			return false
		}
	}
	l.funde = append(l.funde, f)
	return true
}

// Suche runs steps 2 to 4 until done or ctx ends; what was found until then
// is in the Ausgang either way.
func (l *Lauf) Suche(ctx context.Context) Ausgang {
	geraete := l.nachbarnFinden(ctx)

	// What the box already reads is never connected again; it is reported
	// from the configuration at the end (unless the search found the same
	// device under another address - then the fresh find wins).
	bekannt := l.bekannteAdressen()
	ziele := make([]*geraet, 0, len(geraete))
	for _, g := range geraete {
		if !bekannt[g.ip] {
			ziele = append(ziele, g)
		}
	}
	sort.Slice(ziele, func(i, j int) bool { return ziele[i].ip.Less(ziele[j].ip) })

	l.geraeteAnsprechen(ctx, ziele)
	gezaehlt := l.geraeteErkennen(ctx, ziele)
	l.bekannteMelden()

	l.mu.Lock()
	defer l.mu.Unlock()
	var weitere geraetesuche.Weitere
	if l.u.BoxArt != geraetesuche.BoxArtEdgeLight {
		// The Docker box cannot tell a phone from a computer: all is unknown.
		weitere = geraetesuche.Weitere{Unbekannt: zahl(gezaehlt.unbekannt + gezaehlt.telefon + gezaehlt.rechner)}
	} else {
		weitere = geraetesuche.Weitere{TelefonTablet: zahl(gezaehlt.telefon), Rechner: zahl(gezaehlt.rechner),
			Unbekannt: zahl(gezaehlt.unbekannt)}
	}
	out := Ausgang{Netze: append([]geraetesuche.Netz(nil), l.netze...),
		Funde: append([]geraetesuche.Fund{}, l.funde...), Weitere: weitere, Erkenner: []string{}}
	for _, e := range geraetesuche.Erkenner {
		if l.liefen[e] {
			out.Erkenner = append(out.Erkenner, e)
		}
	}
	return out
}

// Weitere as the search counts them before the box type decides the words.
type weitereZahl struct{ telefon, rechner, unbekannt int }

func zahl(n int) *int {
	if n > 512 {
		n = 512
	}
	return &n
}

// ---------------------------------------------------------------- step 2

// nachbarnFinden returns the addresses to speak to. Edge Light: whoever
// answered the ARP question after the UDP nudge (plus whoever answered by
// multicast). Docker: every host address of the /24 - the ARP table of the
// host is not visible in the container.
func (l *Lauf) nachbarnFinden(ctx context.Context) []*geraet {
	geraete := map[netip.Addr]*geraet{}
	neu := func(ip netip.Addr) *geraet {
		g, ok := geraete[ip]
		if !ok {
			g = &geraet{lauf: l, ip: ip, offen: map[int]bool{}}
			geraete[ip] = g
		}
		return g
	}
	if l.u.BoxArt != geraetesuche.BoxArtEdgeLight {
		for _, w := range l.wahl {
			if !w.netz.Erreichbar {
				continue
			}
			for ip := w.bereich.Netz.Addr().Next(); w.bereich.Netz.Contains(ip); ip = ip.Next() {
				if probeZiel(ip, l.bereiche) == "" {
					neu(ip)
				}
			}
		}
		return werte(geraete)
	}

	var adressen []netip.Addr
	var namen []string
	for _, w := range l.wahl {
		if !w.netz.Erreichbar {
			continue
		}
		namen = append(namen, w.schnittstelle)
		for ip := w.bereich.Netz.Addr().Next(); w.bereich.Netz.Contains(ip); ip = ip.Next() {
			if probeZiel(ip, l.bereiche) == "" {
				adressen = append(adressen, ip)
			}
		}
	}
	// The listening after the last nudge counts as the nudges it could have
	// sent at the pace: the rest stays above 0 until the ARP table is read.
	nachlauf := int(l.u.Takt.nachlauf() * time.Duration(l.u.Takt.jeSekunde()) / time.Second)
	l.schritte("nachbarn_finden", len(adressen)+nachlauf, 0)

	// The multicast ways listen while the nudges go out.
	var antworten Antworten
	hoerCtx, hoerEnde := context.WithCancel(ctx)
	fertig := make(chan struct{})
	if l.u.Rundruf != nil && len(namen) > 0 {
		go func() {
			defer close(fertig)
			antworten = l.u.Rundruf.Hoeren(hoerCtx, namen, l.wege())
		}()
	} else {
		close(fertig)
	}
	for _, ip := range adressen {
		if err := l.takt.warte(ctx); err != nil {
			break
		}
		if l.u.Anstoss != nil {
			_ = l.u.Anstoss(ctx, ip)
		}
		l.erledige(1)
	}
	select {
	case <-time.After(l.u.Takt.nachlauf()):
	case <-ctx.Done():
	}
	l.erledige(nachlauf)
	hoerEnde()
	<-fertig

	if l.u.Nachbarn != nil {
		if eintraege, err := l.u.Nachbarn(); err == nil {
			for _, n := range eintraege {
				if probeZiel(n.IP, l.bereiche) != "" || !l.ueberSchnittstelle(n) {
					continue
				}
				g := neu(n.IP)
				g.alive, g.mac = true, n.MAC
				if l.erkenner["funkmodul"] {
					g.hinweis.funkmodul = Funkmodul(n.MAC)
				}
			}
			if l.erkenner["funkmodul"] {
				l.lief("funkmodul")
			}
		}
	}
	for _, w := range antworten.Wege {
		l.lief(w)
	}
	for ip, h := range antworten.MDNS {
		if probeZiel(ip, l.bereiche) == "" {
			g := neu(ip)
			g.alive = true
			g.hinweis.mdns = h
		}
	}
	for ip, loc := range antworten.SSDP {
		if probeZiel(ip, l.bereiche) == "" {
			g := neu(ip)
			g.alive = true
			g.hinweis.ssdp = loc
		}
	}
	for ip, sn := range antworten.Speedwire {
		if probeZiel(ip, l.bereiche) == "" {
			g := neu(ip)
			g.alive = true
			g.hinweis.speedwire = sn
		}
	}
	l.mu.Lock()
	for i, w := range l.wahl {
		n := 0
		for ip := range geraete {
			if w.bereich.Netz.Contains(ip) {
				n++
			}
		}
		if n > 254 {
			n = 254
		}
		l.netze[i].Aktiv = n
	}
	l.mu.Unlock()
	return werte(geraete)
}

// ueberSchnittstelle: an ARP entry counts for the network of its interface.
func (l *Lauf) ueberSchnittstelle(n Nachbar) bool {
	for _, w := range l.wahl {
		if w.netz.Erreichbar && w.bereich.Netz.Contains(n.IP) {
			return n.Schnittstelle == "" || w.schnittstelle == "" || n.Schnittstelle == w.schnittstelle
		}
	}
	return false
}

// wege lists the multicast ways this search may run.
func (l *Lauf) wege() []string {
	var out []string
	for _, w := range []string{"mdns", "ssdp"} {
		if l.erkenner[w] {
			out = append(out, w)
		}
	}
	if l.erkenner["sma"] {
		out = append(out, "speedwire")
	}
	return out
}

func werte(m map[netip.Addr]*geraet) []*geraet {
	out := make([]*geraet, 0, len(m))
	for _, g := range m {
		out = append(out, g)
	}
	return out
}

// ---------------------------------------------------------------- step 3

// geraeteAnsprechen checks the fixed ports of every target: connect, close.
// One device sees one connection at a time; Arbeiter devices in parallel; all
// of them share the pace of JeSekunde.
func (l *Lauf) geraeteAnsprechen(ctx context.Context, ziele []*geraet) {
	ports := l.ports()
	// Recognising follows: at most one unit per device until it knows which
	// ones answered.
	l.schritte("geraete_ansprechen", len(ziele)*len(ports), len(ziele))
	l.parallel(ctx, ziele, func(g *geraet) {
		for _, p := range ports {
			if ctx.Err() != nil {
				return
			}
			offen, alive := l.portOffen(ctx, g.ip, p)
			if offen {
				g.offen[p] = true
			}
			if alive {
				g.alive = true
			}
			l.erledige(1)
		}
	})
	if l.u.BoxArt != geraetesuche.BoxArtEdgeLight {
		l.mu.Lock()
		for i, w := range l.wahl {
			n := 0
			for _, g := range ziele {
				if g.alive && w.bereich.Netz.Contains(g.ip) {
					n++
				}
			}
			l.netze[i].Aktiv = n
		}
		l.mu.Unlock()
	}
}

// ports are the fixed ports the enabled recognisers listen on.
func (l *Lauf) ports() []int {
	var out []int
	for _, k := range kette {
		for _, e := range k.erkenner {
			if l.erkenner[e.name] {
				out = append(out, k.port)
				break
			}
		}
	}
	return out
}

func (l *Lauf) parallel(ctx context.Context, ziele []*geraet, f func(*geraet)) {
	jobs := make(chan *geraet)
	var wg sync.WaitGroup
	n := Arbeiter
	if len(ziele) < n {
		n = len(ziele)
	}
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for g := range jobs {
				f(g)
			}
		}()
	}
	for _, g := range ziele {
		if ctx.Err() != nil {
			break
		}
		jobs <- g
	}
	close(jobs)
	wg.Wait()
}

// ---------------------------------------------------------------- step 4

// geraeteErkennen runs the recognisers of every device with an open port or a
// hint, and counts the rest that answered.
func (l *Lauf) geraeteErkennen(ctx context.Context, ziele []*geraet) weitereZahl {
	var kandidaten []*geraet
	for _, g := range ziele {
		if len(g.offen) > 0 || g.hinweis.ssdp != "" || g.hinweis.speedwire != 0 || g.hinweis.mdns["goe"] {
			kandidaten = append(kandidaten, g)
		}
	}
	l.schritte("geraete_erkennen", len(kandidaten), 0)
	for _, k := range kette {
		for _, e := range k.erkenner {
			if l.erkenner[e.name] {
				l.lief(e.name)
			}
		}
	}
	for _, e := range []string{"netztechnik", "modbus_offen"} {
		if l.erkenner[e] {
			l.lief(e)
		}
	}
	gefunden := make(map[netip.Addr]bool)
	var mu sync.Mutex
	l.parallel(ctx, kandidaten, func(g *geraet) {
		if l.erkenne(ctx, g) {
			mu.Lock()
			gefunden[g.ip] = true
			mu.Unlock()
		}
		l.erledige(1)
	})
	var w weitereZahl
	for _, g := range ziele {
		if !g.alive || gefunden[g.ip] {
			continue
		}
		switch weitereArt(g) {
		case "telefon_tablet":
			w.telefon++
		case "rechner":
			w.rechner++
		default:
			w.unbekannt++
		}
	}
	return w
}

// ---------------------------------------------------------------- what the box reads

func (l *Lauf) bekannteAdressen() map[netip.Addr]bool {
	out := map[netip.Addr]bool{}
	for _, b := range l.u.Bekannt {
		if ip, err := netip.ParseAddr(b.IP); err == nil && probeZiel(ip, l.bereiche) == "" {
			if _, _, ok := bekanntPaar(b); ok {
				out[ip] = true
			}
		}
	}
	return out
}

// bekannteMelden reports what the box already reads, from its configuration
// (liest_box_schon: true). A device the search found again under another
// address keeps only the fresh find: its schluessel is taken.
func (l *Lauf) bekannteMelden() {
	for _, b := range l.u.Bekannt {
		f, ok := bekanntFund(b)
		if !ok {
			continue
		}
		ip, err := netip.ParseAddr(b.IP)
		if err != nil || probeZiel(ip, l.bereiche) != "" {
			continue
		}
		l.melde(f)
	}
}

func probeZiel(ip netip.Addr, bereiche []probe.Bereich) string {
	return probe.ZielImBereich(ip.String(), bereiche)
}

func enthaelt(liste []string, s string) bool {
	for _, x := range liste {
		if x == s {
			return true
		}
	}
	return false
}
