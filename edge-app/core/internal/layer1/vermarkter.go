package layer1

// The direct-marketer connection on Edge Industrie (vp-direktvermarktung-
// konzept d2 §5.4 and §5.5, Stufe 4 PFC200):
//
//   - the root helper vp-vermarkter (edge-industrie/files/etc/init.d/
//     vp-vermarkter) brings the partner's OpenVPN tunnel up with the system
//     and redirects TCP 502 to 1512 on the tunnel interface ONLY - 502 on
//     X1/X2 stays with the PLC and 1502 with the data mirror (PS-D12);
//   - this file runs the partner's data-mirror interface
//     (internal/direktvermarkter) bound to the TUNNEL ADDRESS on port 1512,
//     feeds its input registers from the Erzeuger image of the plant
//     controller, and turns the partner's effective percentage into a
//     Koppelbild limit_w wish with reason "vertrag" (contract 1.1):
//     the edge writes the MINIMUM of plan and partner on the one Stellplatz
//     and names the binding reason (§5.5).
//
// The partner is data: which partner is connected comes from the file
// <VermarkterPfad>/partner (written by the cloud delivery, a later stage);
// the profile itself is embedded (internal/direktvermarkter). No partner
// file, no profile, no tunnel address - no listener, by construction.
//
// Freshness discipline (§5.1 "Unbekannt ist keine Null"): input values reach
// the server only from a fresh, good Erzeuger reading of the SAME controller
// the Koppelbild writes to; a partner query never triggers a device read.

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/erzeugerbild"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/koppelbild"
)

const (
	// vermarkterSchnittstelle is the tunnel interface the root helper
	// vp-vermarkter creates (OpenVPN "dev tun-vermarkter"); helper and edge
	// must agree on the name.
	vermarkterSchnittstelle = "tun-vermarkter"
	// vermarkterTakt paces the reconcile loop (partner file, tunnel address).
	vermarkterTakt = 5 * time.Second
	// vermarkterWerteFrist bounds how old a fed input value may be before a
	// partner read answers with the gateway exception instead (§5.1).
	vermarkterWerteFrist = 30 * time.Second
)

// vermarkterPort is the partner interface's port at the tunnel address. The
// helper redirects 502 -> 1512 on the tunnel interface only; on 502 itself
// sits the PLC's own Modbus server, and 1502 stays with the customer's data
// mirror (fixed on Edge Industrie, see edge-industrie konfig). The concept
// text says 1502, but on Linux a wildcard :1502 listener (the mirror) and a
// specific tunnel-address:1502 listener cannot coexist (EADDRINUSE even with
// SO_REUSEADDR; only SO_REUSEPORT on BOTH sockets would allow it, which the
// mirror does not set) - proven in the container probe. The partner never
// sees this number: luox speaks 502 through the tunnel. A variable only for
// the tests.
var vermarkterPort = 1512

// vermarkterFristOverride shrinks the profile's watchdog deadline; tests only.
var vermarkterFristOverride time.Duration

// vermarkterPartnerMuster bounds what the partner file may name: a catalog id.
var vermarkterPartnerMuster = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)

// vermarkterZustand is the running partner connection of this box.
type vermarkterZustand struct {
	partner string
	profil  direktvermarkter.Profile
	server  *direktvermarkter.Server
	adresse string // the bound "ip:port" ("" = not listening)
	// installiertW is the last good reference power in W (p_installiert_kw,
	// profile regeln.referenz = installierte_leistung_wp, F6 open) and when
	// it was read; without it a percentage has no base and no wish goes out.
	installiertW  float64
	installiertAt time.Time
	// fehlerSchonGemeldet keeps the log quiet: one line per distinct problem.
	fehlerSchonGemeldet string
}

// runVermarkter reconciles the partner connection: it exists exactly while
// the partner file names a known profile, and listens exactly while the
// tunnel interface has an address.
func (r *Runtime) runVermarkter(ctx context.Context) {
	t := time.NewTicker(vermarkterTakt)
	defer t.Stop()
	for {
		r.vermarkterAbgleich()
		select {
		case <-ctx.Done():
			r.vermMu.Lock()
			if r.verm != nil && r.verm.server != nil {
				r.verm.server.Stop()
			}
			r.verm = nil
			r.vermMu.Unlock()
			return
		case <-t.C:
		}
	}
}

// vermarkterAbgleich is one reconcile step.
func (r *Runtime) vermarkterAbgleich() {
	partner := r.leseVermarkterPartner()
	r.vermMu.Lock()
	defer r.vermMu.Unlock()
	if partner == "" {
		if r.verm != nil {
			if r.verm.server != nil {
				r.verm.server.Stop()
			}
			r.verm = nil
			r.log.Info("Direktvermarkter: Anschluss beendet (kein Partner mehr eingerichtet)")
		}
		return
	}
	if r.verm == nil || r.verm.partner != partner {
		profil, da := direktvermarkter.For(partner)
		if !da {
			if r.verm == nil || r.verm.fehlerSchonGemeldet != "partner_unbekannt:"+partner {
				r.log.Warn("Direktvermarkter: Partner nicht im Katalog, Anschluss bleibt aus", "partner", partner)
				r.verm = &vermarkterZustand{fehlerSchonGemeldet: "partner_unbekannt:" + partner}
			}
			return
		}
		if r.verm != nil && r.verm.server != nil {
			r.verm.server.Stop()
		}
		if vermarkterFristOverride > 0 {
			profil.Rules.WatchdogDeadlineS = int(vermarkterFristOverride.Seconds())
		}
		z := &vermarkterZustand{partner: partner, profil: profil}
		frist := time.Duration(profil.Rules.WatchdogDeadlineS) * time.Second
		z.server = direktvermarkter.NewServer(profil, vermarkterWerteFrist, func(e direktvermarkter.Event) {
			r.log.Info("Direktvermarkter: Ereignis", "partner", partner, "art", e.Kind)
		})
		r.verm = z
		r.log.Info("Direktvermarkter: Partner eingerichtet", "partner", partner,
			"lebenszeichen_frist", frist.String())
	}
	z := r.verm
	if z.server == nil {
		return
	}
	adresse := vermarkterTunnelAdresse()
	soll := ""
	if adresse != "" {
		soll = net.JoinHostPort(adresse, strconv.Itoa(vermarkterPort))
	}
	if z.adresse != soll || (soll != "" && !z.server.Running()) {
		if z.server.Running() {
			z.server.Stop()
		}
		z.adresse = ""
		if soll == "" {
			if z.fehlerSchonGemeldet != "tunnel_unten" {
				z.fehlerSchonGemeldet = "tunnel_unten"
				r.log.Info("Direktvermarkter: Tunnel-Schnittstelle ohne Adresse, Schnittstelle lauscht nicht",
					"schnittstelle", vermarkterSchnittstelle)
			}
			return
		}
		if err := z.server.Start(soll); err != nil {
			if z.fehlerSchonGemeldet != "start:"+soll {
				z.fehlerSchonGemeldet = "start:" + soll
				r.log.Warn("Direktvermarkter: Schnittstelle startet nicht", "adresse", soll, "err", err)
			}
			return
		}
		z.adresse = soll
		z.fehlerSchonGemeldet = ""
		r.log.Info("Direktvermarkter: Schnittstelle lauscht an der Tunnel-Adresse", "adresse", soll)
	}
}

// leseVermarkterPartner reads the partner file; "" when unset or invalid.
func (r *Runtime) leseVermarkterPartner() string {
	if r.opts.VermarkterPfad == "" {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(r.opts.VermarkterPfad, "partner"))
	if err != nil {
		return ""
	}
	partner := strings.TrimSpace(string(raw))
	if !vermarkterPartnerMuster.MatchString(partner) {
		return ""
	}
	return partner
}

// vermarkterTunnelAdresse is the first global IPv4 of the tunnel interface;
// "" while the tunnel is down. Overridable for tests.
var vermarkterTunnelAdresse = func() string {
	ifc, err := net.InterfaceByName(vermarkterSchnittstelle)
	if err != nil {
		return ""
	}
	addrs, err := ifc.Addrs()
	if err != nil {
		return ""
	}
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		if v4 := ipn.IP.To4(); v4 != nil {
			return v4.String()
		}
	}
	return ""
}

// vermarkterWerte feeds the partner interface from one fresh Erzeuger reading
// of the controller the Koppelbild writes to (vocabulary Fassung 1 of the
// partner catalog; §4 of the concept: p_nvp_w turned, p_erzeugung_w,
// p_installiert_kw, n_p_prozent). Only values of quality "gut" are served;
// everything else stays absent and a partner read answers the gateway
// exception once the last good value is older than vermarkterWerteFrist.
func (r *Runtime) vermarkterWerte(bilder map[string]*erzeugerbild.StufenLesung, ziele map[string][]koppelZiel, jetzt time.Time) {
	r.vermMu.Lock()
	z := r.verm
	r.vermMu.Unlock()
	if z == nil || z.server == nil {
		return
	}
	lesung := vermarkterLesung(bilder, ziele)
	if lesung == nil {
		return
	}
	gut := map[string]float64{}
	for _, v := range lesung.Werte {
		if v.Wert == nil || v.Qualitaet != erzeugerbild.QualitaetGut {
			continue
		}
		gut[v.Feld] = *v.Wert
	}
	werte := map[string]float64{}
	if nvp, da := gut["p_nvp_w"]; da {
		// p_nvp_w: + Bezug, - Einspeisung; the partner vocabulary counts
		// feed-in positive (nvp_einspeisung_w, einspeisung_positiv).
		werte["nvp_einspeisung_w"] = -nvp
	}
	if erz, da := gut["p_erzeugung_w"]; da {
		werte["erzeugung_w"] = erz
	}
	if pct, da := gut["n_p_prozent"]; da {
		// decoded in %, the partner register is a whole u16 percentage
		werte["netzbetreiber_vorgabe_pct"] = pct
	}
	if kw, da := gut["p_installiert_kw"]; da {
		werte["referenz_w"] = kw * 1000
		r.vermMu.Lock()
		z.installiertW, z.installiertAt = kw*1000, jetzt
		r.vermMu.Unlock()
	}
	if len(werte) == 0 {
		return
	}
	z.server.SetValues(jetzt, werte)
}

// vermarkterLesung picks the reading of the (one) Koppelbild target
// controller out of this tick's judged images.
func vermarkterLesung(bilder map[string]*erzeugerbild.StufenLesung, ziele map[string][]koppelZiel) *erzeugerbild.StufenLesung {
	keys := make([]string, 0, len(ziele))
	for k, liste := range ziele {
		if len(liste) > 0 {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		if l := bilder[k]; l != nil && l.Ergebnis == erzeugerbild.ErgebnisErkannt {
			return l
		}
	}
	return nil
}

// vermarkterGrenzeW is the partner's effective limit in W and its Koppelbild
// target: the effective percentage (watchdog-gated by the server) times the
// reference power. ok is false while no limit binds - partner at rest,
// watchdog stale, no reference power (F6) or no partner at all.
func (r *Runtime) vermarkterGrenzeW() (grenzeW int32, ziel string, ok bool) {
	r.vermMu.Lock()
	z := r.verm
	var referenzW float64
	if z != nil {
		referenzW = z.installiertW
		if z.installiertAt.IsZero() {
			referenzW = 0
		}
		ziel = vermarkterZielName(z.profil.Rules.WirktAuf)
	}
	r.vermMu.Unlock()
	if z == nil || z.server == nil {
		return 0, "", false
	}
	pct, aktiv := z.server.Limit()
	if !aktiv {
		return 0, "", false
	}
	if referenzW <= 0 {
		// A binding percentage without a reference base cannot become watts.
		// Honest refusal (§5.1): no wish instead of a guessed one; the
		// partner sees the plant not following and the watchdog still rules.
		r.log.Warn("Direktvermarkter: Vorgabe ohne Referenzleistung, kein Wunsch", "pct", pct)
		return 0, "", false
	}
	w := float64(pct) / 100 * referenzW
	if w < 0 {
		w = 0
	}
	if w > 0x7FFFFFFE {
		return 0, "", false
	}
	return int32(w + 0.5), ziel, true
}

// vermarkterZielName maps the profile's 'vorgabe_wirkt_auf' onto the
// Koppelbild target vocabulary (contract §7): the grid-point feed-in by
// default (F5), the whole generation when the profile says so.
func vermarkterZielName(wirktAuf string) string {
	if wirktAuf == direktvermarkter.WirktAufErzeugung {
		return "erzeugung_gesamt"
	}
	return "einspeisung"
}

// vermarkterWunsch pins the partner limit on one Stellplatz of this
// controller (concept §5.5): one Stellplatz per command, so the twin writes
// the MINIMUM of plan and partner and names the binding reason ("vertrag",
// contract 1.1, SetzeVertragsgrenze - it rides without the box's control
// gates, because luox must still bind when the VoltPilot cloud is away).
// Target choice: the offered limit_w Stellplatz whose ziel matches the
// profile; if the profile means the feed-in and the plant only offers the
// whole generation, that stricter cap is a safe stand-in (capping generation
// at X also caps feed-in at X) - never the other way round.
func (r *Runtime) vermarkterWunsch(st *koppelbild.Steuerung, wuensche map[int]koppelbild.Wunsch) {
	grenzeW, ziel, aktiv := r.vermarkterGrenzeW()
	if !aktiv {
		st.SetzeVertragsgrenze(0, nil)
		return
	}
	angebote := st.Angebote()
	platz := vermarkterPlatz(angebote, wuensche, ziel)
	if platz == 0 && ziel == "einspeisung" {
		platz = vermarkterPlatz(angebote, wuensche, "erzeugung_gesamt")
	}
	if platz == 0 {
		st.SetzeVertragsgrenze(0, nil)
		return
	}
	st.SetzeVertragsgrenze(platz, &grenzeW)
}

// vermarkterPlatz picks the Stellplatz for the partner limit: a limit_w offer
// with the wanted ziel, preferring one that already carries the plan's
// limit_w wish (one Stellplatz per command), else the lowest offered.
func vermarkterPlatz(angebote map[int]koppelbild.Angebot, wuensche map[int]koppelbild.Wunsch, ziel string) int {
	best := 0
	for n, a := range angebote {
		if a.Art != "limit_w" || a.Ziel != ziel {
			continue
		}
		if w, da := wuensche[n]; da && w.Art == "limit_w" {
			return n
		}
		if best == 0 || n < best {
			best = n
		}
	}
	return best
}
