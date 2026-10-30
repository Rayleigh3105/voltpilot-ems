package geraetesuche

import (
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

// OCPP "klopft an" (docs/contracts/ocpp-klopft-an.md): the charge points whose
// identity the box refused in the last 24 h because it is not on the
// allowlist, carried as `rejected` in the heartbeat block chargers next to the
// list of admitted stations. Wiring it into internal/csms and
// cloud.ChargersSummary belongs to the package that builds it; this is the
// shape and the strict check before sending.

// KlopftAn is one refused charge point.
type KlopftAn struct {
	ID        string    `json:"id"`
	IP        string    `json:"ip,omitempty"`
	FirstSeen time.Time `json:"first_seen"`
	LastSeen  time.Time `json:"last_seen"`
	Attempts  int       `json:"attempts"`
}

const (
	KlopftAnFenster     = 24 * time.Hour
	MaxKlopftAn         = 16 // the same bound as the chargers list
	MaxKlopftAnVersuche = 100000
)

// The form the allowlist accepts (POST …/charging-config/charge-points); the
// box remembers no other identity, it could never be admitted.
var ladesaeulenKennung = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// PruefeKlopftAn checks the list strictly before the box sends it: at most 16,
// newest last_seen first, each identity once, first_seen <= last_seen,
// attempts 1..100000, an address only as a private RFC1918 host address that
// is none of the box's own.
func PruefeKlopftAn(eintraege []KlopftAn, boxAdressen []netip.Addr) error {
	if eintraege == nil {
		return errors.New("rejected missing")
	}
	if len(eintraege) > MaxKlopftAn {
		return fmt.Errorf("%d entries, at most %d", len(eintraege), MaxKlopftAn)
	}
	for i, e := range eintraege {
		switch {
		case !ladesaeulenKennung.MatchString(e.ID):
			return fmt.Errorf("id %q", e.ID)
		case e.FirstSeen.IsZero() || e.LastSeen.Before(e.FirstSeen):
			return fmt.Errorf("%s: first_seen %s, last_seen %s", e.ID, e.FirstSeen, e.LastSeen)
		case e.Attempts < 1 || e.Attempts > MaxKlopftAnVersuche:
			return fmt.Errorf("%s: attempts %d", e.ID, e.Attempts)
		case e.IP != "" && !KlopftAnAdresse(e.IP, boxAdressen):
			return fmt.Errorf("%s: ip %q", e.ID, e.IP)
		}
		for _, f := range eintraege[:i] {
			if f.ID == e.ID {
				return fmt.Errorf("id %q twice", e.ID)
			}
			if f.LastSeen.Before(e.LastSeen) {
				return fmt.Errorf("%s: not ordered newest first", e.ID)
			}
		}
	}
	return nil
}

// KlopftAnAdresse: a private RFC1918 host address (range rule suchbereich
// without a prefix) and none of the box's own addresses.
func KlopftAnAdresse(ip string, boxAdressen []netip.Addr) bool {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	if _, grund := probe.SuchBereich(ip, ""); grund != "" {
		return false
	}
	for _, b := range boxAdressen {
		if b == a {
			return false
		}
	}
	return true
}
