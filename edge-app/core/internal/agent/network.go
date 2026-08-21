package agent

import (
	"log/slog"
	"net/http"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
)

// WebObserver wraps the local web app so every request that reaches it teaches
// the box its OWN address (Anlagen-Zentrale Stufe 2, D5).
//
// It is a WRAPPER on purpose, not a fifteenth parameter of web.Handler: the
// fact is a property of the HTTP transport, not of any surface, and web/ must
// not learn about it. It changes NOTHING about the response - it only reads
// the Host header the browser already wrote, and forwards.
//
// ⚠ The Host header is the ONLY provable source here. The container's own
// interface address is the Docker bridge address; Docker's DNAT rewrites the
// packet's destination IP but never this header, so it carries the address the
// customer TYPED - the exact one they need again.
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
func (a *Agent) networkSummary() *cloud.NetworkSummary {
	if a.net == nil {
		return nil
	}
	now := time.Now()
	obs := a.net.Snapshot(now)
	if obs.Empty() {
		return nil
	}
	out := &cloud.NetworkSummary{
		ReportedAt: now.UTC().Format(time.RFC3339),
		Host:       obs.Host,
		IP:         obs.IP,
		Iface:      obs.Iface,
	}
	if !obs.SeenAt.IsZero() {
		out.SeenAt = obs.SeenAt.UTC().Format(time.RFC3339)
	}
	return out
}
