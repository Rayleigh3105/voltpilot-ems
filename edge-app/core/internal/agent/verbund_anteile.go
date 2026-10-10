package agent

import (
	"errors"
	"log/slog"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/anteile"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
)

// AP-15 IP-17: the share document of a Gemeinsame Steuerung on the box
// (docs/contracts/v2/mqtt-verbund-anteile.md, rules Y1-Y3, G5, T4). The box
// judges it with the Go twin, keeps an accepted one on disk, receipts EVERY
// verdict and mirrors the effective share in the heartbeat. The feed-in
// watchdog regulates against it (IP-18, einspeisewaechter_anteil.go); the
// import side follows with IP-19. Without a document nothing here runs.

// restoreAnteile loads the accepted document in New, before Start opens the
// local bus - the share holds before the first measurement (R15, A13).
func (a *Agent) restoreAnteile(s *anteile.Store) {
	a.anteileStore = s
	h, err := s.Load()
	if err != nil {
		// unreadable = no share: the box starts as it did before IP-17, and
		// the retained document is judged again on the next connect
		slog.Warn("stored share document unreadable; starting without", "err", err)
		return
	}
	if h == nil {
		return
	}
	a.anteileMu.Lock()
	a.anteile = h
	a.anteileMu.Unlock()
	slog.Info("loaded share document from disk", "epoche", h.Stand.Epoche, "revision", h.Stand.Revision)
}

// onVerbundAnteile handles the retained …/v2/verbund-anteile payload: every
// verdict on a readable document of this box is receipted.
func (a *Agent) onVerbundAnteile(payload []byte) {
	if r := a.nimmAnteile(payload, time.Now().UTC()); r != nil {
		a.quittiereAnteile(*r)
	}
}

// nimmAnteile judges one payload and applies an acceptance; the result is the
// receipt to send, nil when there is none (empty, unreadable, another box's
// document, or not persisted).
func (a *Agent) nimmAnteile(payload []byte, now time.Time) *cloud.AnteileResult {
	if len(payload) == 0 {
		// The contract names no deletion of the document. A lost or cleared
		// document must never widen what the box holds: the share stays, on
		// disk and in the heartbeat, until a newer document replaces it.
		slog.Warn("share document cleared (empty retained message); keeping the held share")
		return nil
	}
	snap := a.State.Get()
	own := anteile.Identitaet{Mandant: snap.TenantID, Anlage: snap.SiteID, Box: snap.DeviceID}
	g, err := anteile.Lesen(own, payload)
	if errors.Is(err, anteile.ErrNichtIhres) {
		slog.Warn("share document for another device ignored")
		return nil
	}
	if err != nil {
		slog.Warn("share document unreadable; keeping the held share", "err", err)
		return nil
	}
	a.anteileMu.Lock()
	held := a.anteile
	a.anteileMu.Unlock()
	p := anteile.DokumentPruefen(own, held.StandFuer(own), g.Dokument)
	r := cloud.AnteileResult{Epoche: g.Dokument.Epoche, Revision: g.Dokument.Revision, At: now}
	if !p.Angenommen() {
		r.Grund = p.Grund
		if held != nil {
			r.Wirksam = &cloud.AnteileStand{Epoche: held.Stand.Epoche, Revision: held.Stand.Revision}
		}
		slog.Warn("share document rejected", "grund", p.Grund, "epoche", r.Epoche, "revision", r.Revision)
		return &r
	}
	// Y2: accepted means on disk. A document that would not survive a restart
	// is not accepted and not receipted - the cloud keeps its transition
	// state, the retained document is judged again on the next connect.
	if a.anteileStore != nil {
		if err := a.anteileStore.Save(payload, now); err != nil {
			slog.Error("share document not persisted; not accepted", "err", err)
			return nil
		}
	}
	h := anteile.Halten(g)
	a.anteileMu.Lock()
	a.anteile = h
	a.anteileMu.Unlock()
	r.Angenommen = true
	r.Wirksam = &cloud.AnteileStand{Epoche: h.Stand.Epoche, Revision: h.Stand.Revision}
	slog.Info("share document accepted", "epoche", r.Epoche, "revision", r.Revision, "schritt", g.Schritt)
	return &r
}

// quittiereAnteile sends the receipt without blocking the MQTT callback that
// delivered the document. No link = no receipt: the retained document is
// redelivered after the next connect and judged again.
func (a *Agent) quittiereAnteile(r cloud.AnteileResult) {
	a.linkMu.Lock()
	link := a.link
	a.linkMu.Unlock()
	if link == nil {
		return
	}
	go func() {
		if err := link.PublishAnteileResult(r); err != nil {
			slog.Warn("share result publish failed", "err", err, "revision", r.Revision)
		}
	}()
}

// heldAnteile is the held share, nil without a document.
func (a *Agent) heldAnteile() *anteile.Gehalten {
	a.anteileMu.Lock()
	defer a.anteileMu.Unlock()
	return a.anteile
}
