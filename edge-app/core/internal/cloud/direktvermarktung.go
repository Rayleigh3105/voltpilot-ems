package cloud

import (
	"encoding/json"
	"fmt"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
)

// The direct-marketing delivery on the link (contract
// docs/contracts/v2/direktvermarktung-zustellung.md): the access request and
// the two acknowledgements go NOT retained (QoS 1) to the box's own
// .../v2/direktvermarktung-anfrage and -quittung. The identity in the payload
// is the link's own: topic and payload never differ. The request and the
// Quittung carry a FINGERPRINT, never material - nothing published here is a
// secret.

// PublishDirektvermarktungAnfrage asks the cloud for the access the retained
// profile named and the box does not hold yet.
func (l *Link) PublishDirektvermarktungAnfrage(a direktvermarkter.Anfrage) error {
	a.TenantID, a.SiteID, a.DeviceID = l.identity.TenantID, l.identity.SiteID, l.identity.DeviceID
	return l.publishDirektvermarktung(direktvermarkter.TopicAnfrage, a)
}

// PublishDirektvermarktungQuittung acknowledges a stored or deleted access.
func (l *Link) PublishDirektvermarktungQuittung(q direktvermarkter.Quittung) error {
	q.TenantID, q.SiteID, q.DeviceID = l.identity.TenantID, l.identity.SiteID, l.identity.DeviceID
	return l.publishDirektvermarktung(direktvermarkter.TopicQuittung, q)
}

func (l *Link) publishDirektvermarktung(leaf string, v any) error {
	if l.client == nil || !l.client.IsConnected() {
		return fmt.Errorf("direktvermarktung %s: cloud link not connected", leaf)
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tok := l.client.Publish(l.topic("v2/"+leaf), 1, false, raw)
	if !tok.WaitTimeout(10 * time.Second) {
		return fmt.Errorf("direktvermarktung %s publish timed out", leaf)
	}
	return tok.Error()
}

// DirektvermarktungSummary is the additive heartbeat block "direktvermarktung"
// (concept §5.4 "Stand", §5.7 "Zustellung"; the cloud mirrors it into
// direktvermarktung_stand, display only - never into the Soll-Stand). Absent
// pointers mean UNKNOWN or "never", not zero (§5.1 "Unbekannt ist keine
// Null"). Werte are the values the partner currently reads at the interface,
// straight from the Server's input cache.
type DirektvermarktungSummary struct {
	Partner             string                   `json:"partner"`
	Lage                string                   `json:"lage"`
	Revision            int                      `json:"revision"`
	ZugangFingerabdruck string                   `json:"zugang_fingerabdruck,omitempty"`
	VorgabePct          *int                     `json:"vorgabe_pct,omitempty"`
	GrenzeKw            *float64                 `json:"grenze_kw,omitempty"`
	LebenszeichenAm     *time.Time               `json:"lebenszeichen_am,omitempty"`
	LetzteAbfrageAm     *time.Time               `json:"letzte_abfrage_am,omitempty"`
	LetzteSchreibungAm  *time.Time               `json:"letzte_schreibung_am,omitempty"`
	AbfragenJeMinute    *float64                 `json:"abfragen_je_minute,omitempty"`
	Tunnel              *DirektvermarktungTunnel `json:"tunnel,omitempty"`
	Werte               *DirektvermarktungWerte  `json:"werte,omitempty"`
}

// DirektvermarktungTunnel are the VPN facts the tunnel manager (Stage 2/4)
// reports; absent until one attaches.
type DirektvermarktungTunnel struct {
	ObenSeit    *time.Time `json:"oben_seit,omitempty"`
	HandshakeAm *time.Time `json:"handshake_am,omitempty"`
	Gegenstelle string     `json:"gegenstelle,omitempty"`
}

// DirektvermarktungWerte are the interface's current input values (what the
// partner reads), by the profile's Bedeutungen.
type DirektvermarktungWerte struct {
	EinspeisungW     *int `json:"einspeisung_w,omitempty"`
	ErzeugungW       *int `json:"erzeugung_w,omitempty"`
	NetzbetreiberPct *int `json:"netzbetreiber_pct,omitempty"`
	ReferenzW        *int `json:"referenz_w,omitempty"`
}
