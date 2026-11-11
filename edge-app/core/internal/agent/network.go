package agent

import (
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche/suche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/netinfo"
)

// WebObserver wraps the local web app so every request that reaches it teaches
// the box its OWN address (Anlagen-Zentrale Stufe 2, D5).
//
// It is a WRAPPER on purpose, not a fifteenth parameter of web.Handler: the
// fact is a property of the HTTP transport, not of any surface, and web/ must
// not learn about it. It changes NOTHING about the response - it only reads
// the Host header the browser already wrote, and forwards.
//
// ⚠ This observation is deliberately only a fallback. The container's own
// interface address is the Docker bridge address, while the Host header may be
// a support VPN address. The separately configured VP_LAN_HOST is the
// customer-facing truth and always wins in the heartbeat/API.
func (a *Agent) WebObserver(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.net != nil && a.net.Observe(r.Host, time.Now()) {
			if err := a.net.Persist(); err != nil {
				// Eine Bequemlichkeit, kein Betriebsfakt: ein nur lesbares
				// Datenverzeichnis kostet die Adresse, nie die Oberflaeche.
				slog.Debug("network address not persisted", "err", err)
			}
		}
		next.ServeHTTP(w, r)
	})
}

// networkSummary is what every heartbeat reports - or nil when the box knows
// nothing, in which case NO block is sent at all and the portal keeps its
// honest "your box does not report this yet" (a fabricated address would send
// a human to a page that does not answer).
//
// The LAN endpoint and an observed Host header are kept as TWO facts. The
// former is what a customer can open: on the Docker box the installer detects
// it in the host namespace from the non-VPN route (VP_LAN_HOST); Edge Light
// runs on the router itself and detects it from its own interfaces by the
// rule of the device search (lanHostEdgeLight). The latter merely proves that
// some caller reached the box; that caller may be VoltPilot support over
// WireGuard.
//
// ⚠ On Edge Light that is exactly what happened (04.11.2026): the box set no
// VP_LAN_HOST, withheld its own address among several interfaces, and the
// only address the cloud had was the tunnel address a technician had opened
// the web app under - the portal then told the customer to enter
// ws://10.10.1.25:8887/ocpp into a charge point that cannot reach it. So an
// observation that came in over the box's own tunnel is dropped here: it is
// true about the tunnel and worthless to the customer.
func (a *Agent) networkSummary() *cloud.NetworkSummary {
	if a.net == nil {
		return nil
	}
	now := time.Now()
	obs := a.net.Snapshot(now)
	lanHost, hasLANHost := netinfo.AcceptLANHost(a.Cfg.LANHost)
	if a.boxArt() == geraetesuche.BoxArtEdgeLight {
		eigene := suche.EigeneErreichbarkeit(a.netzUmgebung())
		if !hasLANHost && eigene.Kundennetz.IsValid() {
			lanHost, hasLANHost = netinfo.AcceptLANHost(net.JoinHostPort(eigene.Kundennetz.String(), a.webPort()))
		}
		if ip, ok := hostAdresse(obs.Host); ok && eigene.ImTunnel(ip) {
			obs.Host, obs.SeenAt = "", time.Time{}
		}
	}
	if obs.Empty() && !hasLANHost {
		return nil
	}
	out := &cloud.NetworkSummary{
		ReportedAt: now.UTC().Format(time.RFC3339),
		LANHost:    lanHost,
		Host:       obs.Host,
		IP:         obs.IP,
		Iface:      obs.Iface,
	}
	if !obs.SeenAt.IsZero() {
		out.SeenAt = obs.SeenAt.UTC().Format(time.RFC3339)
	}
	return out
}

// netzUmgebung is what Edge Light reads about its own networks - interfaces
// and routing table from the kernel, the same readers the device search uses;
// tests replace them.
func (a *Agent) netzUmgebung() suche.Umgebung {
	u := suche.Umgebung{BoxArt: a.boxArt(), LANHost: a.Cfg.LANHost,
		Schnittstellen: suche.SystemSchnittstellen, Routen: suche.SystemRouten}
	if a.netzSchnittstellen != nil {
		u.Schnittstellen = a.netzSchnittstellen
	}
	if a.netzRouten != nil {
		u.Routen = a.netzRouten
	}
	return u
}

// webPort is the port of the local web app, the part of the LAN endpoint a
// human types after the address (VP_HTTP_ADDR ":8484" on every box).
func (a *Agent) webPort() string {
	if _, port, err := net.SplitHostPort(a.Cfg.HTTPAddr); err == nil && port != "" {
		return port
	}
	return "8484"
}

// hostAdresse is the IP literal of an observed Host header ("" or a name =
// none): only an address can be matched against the box's own interfaces.
func hostAdresse(host string) (netip.Addr, bool) {
	h := host
	if split, _, err := net.SplitHostPort(host); err == nil {
		h = split
	}
	ip, err := netip.ParseAddr(strings.Trim(h, "[]"))
	if err != nil {
		return netip.Addr{}, false
	}
	return ip.Unmap(), true
}
