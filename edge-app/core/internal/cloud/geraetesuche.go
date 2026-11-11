package cloud

import (
	"encoding/json"
	"fmt"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
)

// The device search on the link (docs/contracts/v2/mqtt-geraetesuche.md §1):
// progress and the one result go NOT retained (QoS 1) to the box's own
// .../v2/geraetesuche-stand and -ergebnis - a retained copy would only be a
// stale one, the cloud takes one result per such_id. The identity in the
// payload is the link's own: topic and payload never differ.

// PublishGeraetesucheStand sends one progress message.
func (l *Link) PublishGeraetesucheStand(s geraetesuche.Stand) error {
	s.TenantID, s.SiteID, s.DeviceID = l.identity.TenantID, l.identity.SiteID, l.identity.DeviceID
	return l.publishGeraetesuche(geraetesuche.TopicStand, s)
}

// PublishGeraetesucheErgebnis sends the result of a search.
func (l *Link) PublishGeraetesucheErgebnis(e geraetesuche.Ergebnis) error {
	e.TenantID, e.SiteID, e.DeviceID = l.identity.TenantID, l.identity.SiteID, l.identity.DeviceID
	return l.publishGeraetesuche(geraetesuche.TopicErgebnis, e)
}

func (l *Link) publishGeraetesuche(leaf string, v any) error {
	if l.client == nil || !l.client.IsConnected() {
		return fmt.Errorf("geraetesuche %s: cloud link not connected", leaf)
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tok := l.client.Publish(l.topic("v2/"+leaf), 1, false, raw)
	if !tok.WaitTimeout(10 * time.Second) {
		return fmt.Errorf("geraetesuche %s publish timed out", leaf)
	}
	return tok.Error()
}
