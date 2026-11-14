package agent

import (
	"errors"
	"log/slog"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/pricefeed"
)

// onPriceCurrent mirrors ONE retained current-spot-price document from the
// cloud (contract docs/contracts/v2/mqtt-price-current.md) onto the local bus
// topic edge/price/current. Pure wiring: parsing, freshness and the explicit
// stale marker live in internal/pricefeed - nothing here decides anything
// about power, and the dispatch principle of internal/plan stands (the cloud
// decides the schedule; this feed only lets customer rules evaluate their
// price conditions on a cloud-delivered price).
func (a *Agent) onPriceCurrent(payload []byte) {
	feed := a.priceFeed()
	doc, err := pricefeed.Parse(payload)
	if errors.Is(err, pricefeed.ErrEmpty) {
		// Die Rücknahme: der Preis ist ab jetzt ausdrücklich unbekannt - eine
		// Regel darf auf dem letzten Stand nicht weiterschalten.
		slog.Info("price feed withdrawn - the local price is now unknown")
		feed.Withdraw()
		return
	}
	if err != nil {
		slog.Warn("price document rejected", "err", err)
		return
	}
	// Topic == Payload: die Regel jedes Downlinks. Ein fremd adressiertes
	// Dokument wird STUMM verworfen - laut nur im Protokoll.
	a.entMu.Lock()
	id := a.entIdentity
	a.entMu.Unlock()
	if id.DeviceID == "" {
		slog.Warn("price document before a known cloud identity - ignored")
		return
	}
	if !doc.MatchesIdentity(id.TenantID, id.SiteID, id.DeviceID) {
		slog.Warn("price document for a foreign identity ignored",
			"tenant", doc.TenantID, "site", doc.SiteID, "device", doc.DeviceID)
		return
	}
	feed.Accept(doc)
}

// priceFeed lazily builds the one mirror publishing retained on the local bus.
func (a *Agent) priceFeed() *pricefeed.Feed {
	a.priceFeedMu.Lock()
	defer a.priceFeedMu.Unlock()
	if a.priceFeedMirror == nil {
		a.priceFeedMirror = pricefeed.New(func(payload []byte) error {
			return a.Bus.Publish(localbus.TopicPriceCurrent, payload, true)
		})
	}
	return a.priceFeedMirror
}
