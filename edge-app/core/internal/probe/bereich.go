package probe

import (
	"net/netip"
	"regexp"
	"strings"
)

// The range rule (Bereichsregel) of the device search: IsPrivateHost extended
// from ONE host string to address RANGES (docs/contracts/v2/mqtt-geraetesuche.md
// §4, shared vectors docs/contracts/lan-range-vectors.json, Java twin
// services/api .../geraetesuche/Suchbereich).
//
// A range is stricter than a host. A host was typed by a person, so loopback,
// link-local, CGNAT, IPv6 and LAN names may name it. A range the box walks by
// itself, address by address - so it is only what is certainly its own home
// network: RFC1918 IPv4, at most a /24, and only networks of its own
// interfaces. A larger network is searched only as the /24 around the box's
// own address, and the result says so (Ausschnitt). The box's own address is
// never a target, which also takes its own ports (502 mirror, 1883/1884 bus,
// 8484, OCPP 8887) out; a foreign device on port 8484 (a KACO stick) stays a
// target - excluding by port number would be wrong.

// Bereich is one network a search may cover and the box's own address in it.
// Ausschnitt is true when the interface's network is larger than /24 and only
// the /24 around the box is searched; nil = unknown (the Docker box knows only
// VP_LAN_HOST, not the host's mask).
type Bereich struct {
	Netz       netip.Prefix
	BoxAdresse netip.Addr
	Ausschnitt *bool
}

// The reasons of the rule, the words of lan-range-vectors.json.
const (
	BereichKeineAdresse     = "keine_adresse"
	BereichNichtPrivat      = "nicht_privat"
	BereichZuGross          = "zu_gross"
	BereichZuKlein          = "zu_klein"
	BereichKeineHostadresse = "keine_hostadresse"
	BereichKeineNetzadresse = "keine_netzadresse"
	BereichBoxAusserhalb    = "box_ausserhalb"
	BereichBoxKeineHost     = "box_keine_hostadresse"
	BereichTunnel           = "tunnel"
	BereichContainer        = "container"

	ZielBoxSelbst   = "box_selbst"
	ZielAusserhalb  = "ausserhalb"
	ZielNetzadresse = "netzadresse"
	ZielBroadcast   = "broadcast"
)

const (
	bereichMaxBits = 24 // at most a /24
	bereichMinHost = 30 // a /31 or /32 has no address besides the box
)

// A Docker bridge is br- and twelve hex characters; br-lan (OpenWrt) is the
// LAN of Edge Light and stays a home network.
var dockerBruecke = regexp.MustCompile(`^br-[0-9a-f]{12}$`)

// SuchBereich forms the search network from one of the box's own addresses.
// adresse carries the interface prefix ("192.168.178.20/24"); without one it
// is VP_LAN_HOST of the Docker box, searched as its /24 with an unknown mask.
// schnittstelle is the interface name, "" when the box sees none. The second
// result is the reason when the address yields no search network.
func SuchBereich(adresse, schnittstelle string) (Bereich, string) {
	switch {
	case strings.HasPrefix(schnittstelle, "wg"), strings.HasPrefix(schnittstelle, "tun"):
		return Bereich{}, BereichTunnel
	case strings.HasPrefix(schnittstelle, "docker"), strings.HasPrefix(schnittstelle, "veth"),
		dockerBruecke.MatchString(schnittstelle):
		return Bereich{}, BereichContainer
	}
	var addr netip.Addr
	bits := -1
	if strings.Contains(adresse, "/") {
		p, err := netip.ParsePrefix(adresse)
		if err != nil {
			return Bereich{}, BereichKeineAdresse
		}
		addr, bits = p.Addr(), p.Bits()
	} else {
		a, err := netip.ParseAddr(adresse)
		if err != nil {
			return Bereich{}, BereichKeineAdresse
		}
		addr = a
	}
	if !addr.Is4() || !addr.IsPrivate() {
		return Bereich{}, BereichNichtPrivat
	}
	if bits > bereichMinHost {
		return Bereich{}, BereichZuKlein
	}
	var ausschnitt *bool
	if bits >= 0 {
		v := bits < bereichMaxBits
		ausschnitt = &v
	}
	if bits < bereichMaxBits {
		bits = bereichMaxBits
	}
	netz := netip.PrefixFrom(addr, bits).Masked()
	if addr == netz.Addr() || addr == broadcastVon(netz) {
		return Bereich{}, BereichKeineHostadresse
	}
	return Bereich{Netz: netz, BoxAdresse: addr, Ausschnitt: ausschnitt}, ""
}

// PruefeBereich checks a reported pair (netz, box_adresse): netz is the network
// address of an RFC1918 IPv4 network with a prefix of 24 to 30, the box a host
// address in it. The pair alone does not tell Ausschnitt.
func PruefeBereich(netz, boxAdresse string) (Bereich, string) {
	if !strings.Contains(netz, "/") {
		return Bereich{}, BereichKeineAdresse
	}
	p, err := netip.ParsePrefix(netz)
	if err != nil || !p.Addr().Is4() {
		return Bereich{}, BereichKeineAdresse
	}
	box, err := netip.ParseAddr(boxAdresse)
	if err != nil || !box.Is4() {
		return Bereich{}, BereichKeineAdresse
	}
	switch {
	case !p.Addr().IsPrivate():
		return Bereich{}, BereichNichtPrivat
	case p.Bits() < bereichMaxBits:
		return Bereich{}, BereichZuGross
	case p.Bits() > bereichMinHost:
		return Bereich{}, BereichZuKlein
	case p.Masked() != p:
		return Bereich{}, BereichKeineNetzadresse
	case !p.Contains(box):
		return Bereich{}, BereichBoxAusserhalb
	case box == p.Addr() || box == broadcastVon(p):
		return Bereich{}, BereichBoxKeineHost
	}
	return Bereich{Netz: p, BoxAdresse: box}, ""
}

// ZielImBereich says whether ip may be addressed in a search or count as a
// find: an IPv4 host address inside one of the ranges, never the box itself,
// never a network or broadcast address. "" = allowed, else the reason. The
// port changes nothing: the box's own address is out with every port.
func ZielImBereich(ip string, bereiche []Bereich) string {
	a, err := netip.ParseAddr(ip)
	if err != nil || !a.Is4() {
		return BereichKeineAdresse
	}
	for _, b := range bereiche {
		if b.BoxAdresse == a {
			return ZielBoxSelbst
		}
	}
	for _, b := range bereiche {
		if !b.Netz.Contains(a) {
			continue
		}
		switch a {
		case b.Netz.Addr():
			return ZielNetzadresse
		case broadcastVon(b.Netz):
			return ZielBroadcast
		}
		return ""
	}
	return ZielAusserhalb
}

func broadcastVon(p netip.Prefix) netip.Addr {
	b := p.Masked().Addr().As4()
	for i := p.Bits(); i < 32; i++ {
		b[i/8] |= 1 << (7 - uint(i%8))
	}
	return netip.AddrFrom4(b)
}
