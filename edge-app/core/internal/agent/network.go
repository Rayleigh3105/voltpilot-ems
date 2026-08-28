package agent

import (
	"log/slog"
	"net/http"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
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
// The installer-provided LAN endpoint and an observed Host header are kept as
// TWO facts. The former is detected in the host namespace from the non-VPN
// route and is what a customer can open. The latter merely proves that some
// caller reached the box; that caller may be VoltPilot support over WireGuard.
func (a *Agent) networkSummary() *cloud.NetworkSummary {
	if a.net == nil {
		return nil
	}
	now := time.Now()
	obs := a.net.Snapshot(now)
	lanHost, hasLANHost := netinfo.AcceptLANHost(a.Cfg.LANHost)
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
