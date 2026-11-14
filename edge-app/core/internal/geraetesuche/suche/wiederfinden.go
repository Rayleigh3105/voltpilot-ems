package suche

import (
	"net"
	"net/netip"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
)

// S6 ("Edge Light: Geräte im Heimnetz", vp-edge-light-wlan-konzept §6): in the
// WLAN way (relayd) the devices behind the box sit in the customer's own
// network, and the customer's router - not the box - hands out their
// addresses. A lease can move at any time (a router reboot, a new lease, a
// switch between cable and WLAN), and nothing here tells the box WHY an
// address changed, only that it did.
//
// planWiederfinden reads, once per run and from this run's OWN ARP picture
// alone (nachbarnFinden's geraete), whether every Bekannt device with a
// pinned MAC still sits where it is configured. It is deliberately the ONLY
// place that looks for a moved device: netze.go never changes, and nothing
// here speaks to a device - the candidate it names is only something still
// to verify by the device's own protocol (bekannt.go meldeWiederfinden),
// never a result (AGENTS.md "Verträge und Identitäten": an address or a MAC
// alone proves no device identity).

// wiederfindenPlan is what this run decided for one Bekannt device, from the
// ARP picture alone.
type wiederfindenPlan struct {
	// intakt: either the device carries no pinned MAC (nothing to doubt the
	// configured address with - unchanged, pre-S6 trust), or its MAC still
	// answers there. Everything downstream treats it exactly as before.
	intakt bool
	// kandidat is the one OTHER live address this run saw the pinned MAC
	// under, when intakt is false. Invalid when the MAC was not seen again at
	// all, or turned up under more than one address (an ARP oddity - never a
	// guess between them).
	kandidat netip.Addr
}

// planWiederfinden is nil on the Docker box: it has no ARP table, so a MAC
// pinned there (there should be none) is left exactly as configured.
func planWiederfinden(boxArt string, bekannt []Bekannt, geraete []*geraet) []wiederfindenPlan {
	if boxArt != geraetesuche.BoxArtEdgeLight || len(bekannt) == 0 {
		return nil
	}
	macAnAdresse := map[netip.Addr]string{}
	adressenMitMAC := map[string][]netip.Addr{}
	for _, g := range geraete {
		m := normalisiereMAC(g.mac)
		if m == "" {
			continue
		}
		macAnAdresse[g.ip] = m
		adressenMitMAC[m] = append(adressenMitMAC[m], g.ip)
	}

	out := make([]wiederfindenPlan, len(bekannt))
	for i, b := range bekannt {
		mac := normalisiereMACText(b.MAC)
		if mac == "" {
			out[i] = wiederfindenPlan{intakt: true}
			continue
		}
		ip, err := netip.ParseAddr(strings.TrimSpace(b.IP))
		if err != nil {
			out[i] = wiederfindenPlan{intakt: true}
			continue
		}
		if aktuell, da := macAnAdresse[ip]; da && aktuell == mac {
			out[i] = wiederfindenPlan{intakt: true}
			continue
		}
		p := wiederfindenPlan{intakt: false}
		var andere []netip.Addr
		for _, a := range adressenMitMAC[mac] {
			if a != ip {
				andere = append(andere, a)
			}
		}
		if len(andere) == 1 {
			p.kandidat = andere[0]
		}
		out[i] = p
	}
	return out
}

// normalisiereMAC/normalisiereMACText bring an ARP entry's and a configured
// MAC into the same comparable form; "" for anything that does not parse as
// one (an empty/absent MAC is not a match for anything).
func normalisiereMAC(hw net.HardwareAddr) string {
	if len(hw) == 0 {
		return ""
	}
	return hw.String()
}

func normalisiereMACText(s string) string {
	hw, err := net.ParseMAC(strings.TrimSpace(s))
	if err != nil {
		return ""
	}
	return hw.String()
}
