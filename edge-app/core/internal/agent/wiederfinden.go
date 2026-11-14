package agent

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche/suche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
)

// Wiederfinden (S6, vp-edge-light-wlan-konzept §6) keeps the box's own
// READING working after an address change, not only the device search's
// report of one: in the WLAN way (relayd) the customer router hands out the
// addresses of the devices behind the box, and a lease can move at any time.
// geraetesuche/suche/wiederfinden.go already finds a moved, MAC-pinned device
// again and verifies it there by its own protocol; what happens here is the
// other half - adopting that confirmed address into the ONE configuration
// the box actually reads from (durably, on disk, republished so the running
// Layer 1 or the core's own poll picks it up immediately), logging it, and
// learning a MAC for a configured device that does not have one pinned yet
// (at setup through normalizeOptionalMAC, and retroactively here for devices
// configured before this existed).
//
// Never on an address or a MAC alone (AGENTS.md "Verträge und Identitäten"):
// the candidate suche.Lauf names is only ever something its OWN recogniser
// already confirmed there, in the normal probe/recognise pass, before
// anything here writes a single byte.

// wiederfindenIntervall paces the watchdog; a var so a test can shrink it.
// Mostly a near-free single-IP ARP check (nudge + read, no sweep) - the full
// network search only ever runs when that check actually finds something
// wrong.
var wiederfindenIntervall = 2 * time.Minute

// wiederfindenEinzelsondeWartezeit is how long the single-IP check waits
// between its nudge and reading the ARP table for an answer.
var wiederfindenEinzelsondeWartezeit = 300 * time.Millisecond

// bekannteQuelle is one configured, network-reachable device with enough
// origin information to write an adopted address (or a newly learned MAC)
// back into the ONE store it actually came from. suche.Bekannt itself stays
// free of this - it only ever carries what the search needs (DP-3 A keeps it
// free of agent-internal plumbing).
type bekannteQuelle struct {
	b suche.Bekannt
	// id is "" for the one inverter selection, the source id otherwise.
	id string
}

// wiederfindenQuellen lists the inverter selection and the additional
// sources - never the v2 entity registry: componentapply.Derive re-derives
// those FROM the registry on every push, so writing an address into the
// derived form would just be overwritten on the next apply, and that only
// happens on a portal-managed plant anyway, where SetInverter and
// setSourceConnection already refuse a box-side write (refuseIfPortalManaged,
// Einheitsmodell Stufe 1) - every plant that exists today is box-managed.
func (a *Agent) wiederfindenQuellen() []bekannteQuelle {
	var out []bekannteQuelle
	if a.invStore != nil {
		if sel, ok, err := a.invStore.Load(); err == nil && ok && sel.Connection.IP != "" {
			out = append(out, bekannteQuelle{b: suche.Bekannt{
				Communication: sel.Communication, IP: sel.Connection.IP, Port: sel.Connection.Port,
				Serial: sel.Connection.Serial, UnitID: sel.Connection.MbSlaveID, Familie: sel.Family,
				Hersteller: sel.Brand, Modell: sel.Model, MAC: sel.Connection.MAC,
			}})
		}
	}
	for _, s := range a.ListSources() {
		if s.Connection.IP == "" {
			continue
		}
		out = append(out, bekannteQuelle{id: s.ID, b: suche.Bekannt{
			Communication: s.Communication, IP: s.Connection.IP, Port: s.Connection.Port,
			Serial: s.Connection.Serial, UnitID: s.Connection.MbSlaveID, Familie: s.Family,
			Hersteller: s.Brand, Modell: s.Model, Rolle: s.Role, MAC: s.Connection.MAC,
		}})
	}
	return out
}

// wiederfindenUmgebung mirrors neueGeraetesuche's Edge Light environment
// (interfaces, routing table, ARP table, the UDP nudge), kept as its own copy
// rather than a shared refactor so the cloud-ordered search's existing,
// already-proven wiring stays untouched. netzSchnittstellen/netzRouten are
// the SAME test seams network.go already defines; netzNachbarn/netzAnstoss
// are their Wiederfinden-only siblings (agent.go) - a unit test sends nothing
// into a real network, same discipline throughout this package.
func (a *Agent) wiederfindenUmgebung() suche.Umgebung {
	u := suche.Umgebung{BoxArt: a.boxArt(), Dial: a.geraetesucheDial, Takt: a.netzTakt}
	if u.BoxArt != geraetesuche.BoxArtEdgeLight {
		return u
	}
	u.Schnittstellen, u.Routen, u.Nachbarn = suche.SystemSchnittstellen, suche.SystemRouten, suche.SystemNachbarn
	u.Anstoss = func(_ context.Context, ip netip.Addr) error { return suche.UDPAnstoss(ip) }
	if a.netzSchnittstellen != nil {
		u.Schnittstellen = a.netzSchnittstellen
	}
	if a.netzRouten != nil {
		u.Routen = a.netzRouten
	}
	if a.netzNachbarn != nil {
		u.Nachbarn = a.netzNachbarn
	}
	if a.netzAnstoss != nil {
		u.Anstoss = a.netzAnstoss
	}
	return u
}

// startWiederfindenWatch ticks the watchdog; a no-op loop (cheap: nothing
// configured carries a pinned MAC and nothing is missing one) on the Docker
// box and on a freshly set up Edge Light box alike.
func (a *Agent) startWiederfindenWatch(ctx context.Context) {
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		t := time.NewTicker(wiederfindenIntervall)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			a.wiederfindenTick(ctx)
		}
	}()
}

// wiederfindenTick is one pass: learn a MAC for every configured device that
// does not have one yet, then - only if a single-IP check finds a pinned one
// missing - run ONE full search (the FULL Bekannt list, so every OTHER
// already-configured device stays excluded from re-probing, the "Ein-Client-
// Geräte" rule) and adopt what it confirms for each device found missing.
func (a *Agent) wiederfindenTick(ctx context.Context) {
	if a.boxArt() != geraetesuche.BoxArtEdgeLight {
		return
	}
	quellen := a.wiederfindenQuellen()
	if len(quellen) == 0 {
		return
	}
	u := a.wiederfindenUmgebung()
	if u.Schnittstellen == nil {
		return
	}
	var kaputt []bekannteQuelle
	for _, q := range quellen {
		if q.b.MAC == "" {
			a.wiederfindenLernen(ctx, u, q)
			continue
		}
		if ok, err := a.wiederfindenNochDa(ctx, u, q.b); err != nil || !ok {
			kaputt = append(kaputt, q)
		}
	}
	if len(kaputt) == 0 {
		return
	}
	u.Bekannt = a.geraetesucheBekannt()
	l, grund := suche.Neu(u, nil)
	if grund != "" {
		slog.Warn("wiederfinden: Suche konnte nicht starten", "grund", grund)
		return
	}
	aus := l.Suche(ctx)
	// The same ARP picture the sweep itself just populated - read once, after
	// the sweep, so every device's candidate comes from its OWN MAC, never
	// from matching by communication alone (two devices of the same kind
	// could otherwise be confused with each other on a simultaneous move).
	nachbarn, _ := u.Nachbarn()
	for _, q := range kaputt {
		a.wiederfindenAnwenden(q, aus.Funde, nachbarn)
	}
}

// wiederfindenNochDa is the cheap precheck: nudge exactly the configured
// address and read this run's own ARP answer for it - never a sweep, so a
// healthy device costs nothing beyond what a single ARP lookup always did.
// true when the pinned MAC answers there, or when nothing is pinned at all
// (nothing to doubt the address with).
func (a *Agent) wiederfindenNochDa(ctx context.Context, u suche.Umgebung, b suche.Bekannt) (bool, error) {
	mac := wiederfindenNormMAC(b.MAC)
	if mac == "" {
		return true, nil
	}
	ip, err := netip.ParseAddr(strings.TrimSpace(b.IP))
	if err != nil {
		return false, err
	}
	if err := wiederfindenSonde(ctx, u, ip); err != nil {
		return false, err
	}
	nachbarn, err := u.Nachbarn()
	if err != nil {
		return false, err
	}
	for _, n := range nachbarn {
		if n.IP == ip {
			return wiederfindenNormHW(n.MAC) == mac, nil
		}
	}
	return false, nil
}

// wiederfindenLernen tries to learn a MAC for a configured device that does
// not have one pinned yet, at its OWN configured address (never elsewhere -
// learning is not re-finding: without a MAC there is nothing yet to doubt the
// address with, so this never triggers the full search).
func (a *Agent) wiederfindenLernen(ctx context.Context, u suche.Umgebung, q bekannteQuelle) {
	ip, err := netip.ParseAddr(strings.TrimSpace(q.b.IP))
	if err != nil {
		return
	}
	if err := wiederfindenSonde(ctx, u, ip); err != nil {
		return
	}
	nachbarn, err := u.Nachbarn()
	if err != nil {
		return
	}
	for _, n := range nachbarn {
		if n.IP != ip {
			continue
		}
		mac := wiederfindenNormHW(n.MAC)
		if mac == "" {
			return
		}
		if err := a.wiederfindenUebernehmen(q, q.b.IP, mac); err != nil {
			slog.Warn("wiederfinden: MAC konnte nicht hinterlegt werden",
				"communication", q.b.Communication, "ip", q.b.IP, "err", err)
			return
		}
		slog.Info("wiederfinden: MAC fuer ein eingerichtetes Geraet gelernt",
			"communication", q.b.Communication, "ip", q.b.IP, "mac", mac)
		return
	}
}

// wiederfindenSonde nudges one address and waits long enough for the ARP
// table to carry the answer, if there is one.
func wiederfindenSonde(ctx context.Context, u suche.Umgebung, ip netip.Addr) error {
	if u.Anstoss != nil {
		if err := u.Anstoss(ctx, ip); err != nil {
			return err
		}
	}
	select {
	case <-time.After(wiederfindenEinzelsondeWartezeit):
	case <-ctx.Done():
		return ctx.Err()
	}
	return nil
}

// wiederfindenAnwenden adopts the candidate THIS run's own Wiederfinden
// already confirmed for q - never on an address or a MAC alone, and never by
// matching communication alone either (two devices of the same kind must
// never be told apart by anything but their OWN MAC): q's pinned MAC first
// names the ONE address it answers under now in nachbarn, and only a Fund at
// EXACTLY that address, liest_box_schon and of the right communication,
// counts as confirmed. Without that the device is reported missing by
// staying out of the result, logged instead of repeating a stale "already
// reading" claim.
func (a *Agent) wiederfindenAnwenden(q bekannteQuelle, funde []geraetesuche.Fund, nachbarn []suche.Nachbar) {
	mac := wiederfindenNormMAC(q.b.MAC)
	var kandidatIP string
	for _, n := range nachbarn {
		if wiederfindenNormHW(n.MAC) == mac {
			kandidatIP = n.IP.String()
			break
		}
	}
	if kandidatIP == "" || kandidatIP == q.b.IP {
		slog.Warn("wiederfinden: Geraet unter seiner MAC nirgends mehr gefunden",
			"communication", q.b.Communication, "ip", q.b.IP)
		return
	}
	for _, f := range funde {
		if !f.LiestBoxSchon || f.Verbindung.Communication != q.b.Communication || f.Verbindung.IP != kandidatIP {
			continue
		}
		if err := a.wiederfindenUebernehmen(q, kandidatIP, ""); err != nil {
			slog.Warn("wiederfinden: Adresse konnte nicht uebernommen werden",
				"communication", q.b.Communication, "alte_ip", q.b.IP, "neue_ip", kandidatIP, "err", err)
			return
		}
		slog.Info("wiederfinden: Geraet unter neuer Adresse wiedergefunden, Lesen laeuft weiter",
			"communication", q.b.Communication, "alte_ip", q.b.IP, "neue_ip", kandidatIP)
		return
	}
	slog.Warn("wiederfinden: MAC gefunden, aber die Identitaet dort nicht bestaetigt",
		"communication", q.b.Communication, "ip", q.b.IP, "kandidat", kandidatIP)
}

// wiederfindenUebernehmen writes a confirmed address (and, if not pinned yet,
// a learned MAC) back into the ONE store the device actually came from,
// republishing the retained config exactly as any other edit would (so the
// running Layer 1, or the core's own poll, picks it up without a restart) -
// SetInverter/setSourceConnection carry the usual refuseIfPortalManaged gate,
// so a portal-managed plant is refused here exactly as it would be for any
// other local edit, never forced through.
func (a *Agent) wiederfindenUebernehmen(q bekannteQuelle, neueIP, neueMAC string) error {
	if q.id == "" {
		sel, ok, err := a.invStore.Load()
		if err != nil || !ok {
			return fmt.Errorf("inverter selection unavailable: %w", err)
		}
		req := inverter.SelectionRequest{Brand: sel.Brand, Model: sel.Model, Family: sel.Family, Connection: sel.Connection}
		req.Connection.IP = neueIP
		if req.Connection.MAC == "" && neueMAC != "" {
			req.Connection.MAC = neueMAC
		}
		_, err = a.SetInverter(req)
		return err
	}
	_, err := a.setSourceConnection(q.id, neueIP, neueMAC)
	return err
}

func wiederfindenNormMAC(s string) string {
	hw, err := net.ParseMAC(strings.TrimSpace(s))
	if err != nil {
		return ""
	}
	return hw.String()
}

func wiederfindenNormHW(hw net.HardwareAddr) string {
	if len(hw) == 0 {
		return ""
	}
	return hw.String()
}
