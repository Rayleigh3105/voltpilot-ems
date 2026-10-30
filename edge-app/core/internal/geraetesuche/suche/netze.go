package suche

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"sort"
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

// Step 1, netze_bestimmen (contract §3 "Je Box-Art", §4 range rule). The box
// believes no network the cloud names: it searches only its own private
// networks, each at most a /24, at most two (DP-5 A).

// Schnittstelle is one interface of Edge Light with its IPv4 prefixes.
type Schnittstelle struct {
	Name    string
	Prefixe []netip.Prefix
}

// Route is one line of the kernel routing table.
type Route struct {
	Schnittstelle string
	Ziel          netip.Prefix
	Gateway       netip.Addr
	Metrik        int
}

// netzwahl is one network of the search: the reported Netz plus what the box
// needs to walk it.
type netzwahl struct {
	netz          geraetesuche.Netz
	bereich       probe.Bereich
	schnittstelle string     // "" on the Docker box
	gateway       netip.Addr // the default gateway in the customer network (Edge Light)
}

// Refusals of step 1 (the words of the contract's abgelehnt reasons).
const (
	GrundLanHostFehlt     = "lan_host_fehlt"
	GrundKeinPrivatesNetz = "kein_privates_netz"
)

// waehleNetze forms the networks of this box type. The second result is the
// refusal reason when there is none to search.
func waehleNetze(u Umgebung) ([]netzwahl, string) {
	if u.BoxArt == geraetesuche.BoxArtEdgeLight {
		return netzeEdgeLight(u)
	}
	return netzDocker(u.LANHost)
}

// netzDocker: the core sits in a bridge container and sees only 172.x. The
// customer network is the /24 around VP_LAN_HOST (the installer sets it from
// the host's default route); its mask is unknown, so ausschnitt stays absent.
// Without VP_LAN_HOST there is no search, with a named reason (DP-2 A).
func netzDocker(lanHost string) ([]netzwahl, string) {
	host := strings.TrimSpace(lanHost)
	if host == "" {
		return nil, GrundLanHostFehlt
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	b, grund := probe.SuchBereich(strings.Trim(host, "[]"), "")
	if grund != "" {
		return nil, GrundKeinPrivatesNetz
	}
	return []netzwahl{{
		netz: geraetesuche.Netz{Rolle: "kundennetz", Netz: b.Netz.String(), BoxAdresse: b.BoxAdresse.String(),
			Erreichbar: true},
		bereich: b,
	}}, ""
}

// netzeEdgeLight: every interface with a private IPv4 address, without tunnels
// and containers. The customer network is the interface of the default route
// (Mango: WAN), the box network the first of the others (br-lan first). A
// network whose route does not really leave through its interface (on
// 30.10. the router's LAN route pointed into the tunnel) is reported as not
// reachable and not walked.
func netzeEdgeLight(u Umgebung) ([]netzwahl, string) {
	if u.Schnittstellen == nil {
		return nil, GrundKeinPrivatesNetz
	}
	ifs, err := u.Schnittstellen()
	if err != nil {
		return nil, GrundKeinPrivatesNetz
	}
	var routen []Route
	if u.Routen != nil {
		routen, _ = u.Routen()
	}
	standard, gateway := standardRoute(routen)

	type kandidat struct {
		w    netzwahl
		name string
	}
	var kandidaten []kandidat
	for _, s := range ifs {
		for _, p := range s.Prefixe {
			if !p.Addr().Is4() {
				continue
			}
			b, grund := probe.SuchBereich(p.String(), s.Name)
			if grund != "" {
				continue
			}
			w := netzwahl{
				netz: geraetesuche.Netz{Netz: b.Netz.String(), BoxAdresse: b.BoxAdresse.String(),
					Ausschnitt: b.Ausschnitt, Erreichbar: routeGehtUeber(routen, b.Netz, s.Name)},
				bereich: b, schnittstelle: s.Name,
			}
			kandidaten = append(kandidaten, kandidat{w: w, name: s.Name})
		}
	}
	if len(kandidaten) == 0 {
		return nil, GrundKeinPrivatesNetz
	}
	var out []netzwahl
	// The customer network: on the default route's interface, the network that
	// holds the gateway (else the first one there).
	kunde := -1
	for i, k := range kandidaten {
		if k.name != standard {
			continue
		}
		if kunde < 0 || (gateway.IsValid() && k.w.bereich.Netz.Contains(gateway)) {
			kunde = i
		}
	}
	if kunde >= 0 {
		w := kandidaten[kunde].w
		w.netz.Rolle = "kundennetz"
		if gateway.IsValid() && w.bereich.Netz.Contains(gateway) {
			w.gateway = gateway
		}
		out = append(out, w)
	}
	// The box network: br-lan before the rest, the rest by name.
	rest := make([]kandidat, 0, len(kandidaten))
	for i, k := range kandidaten {
		if i != kunde && (kunde < 0 || k.w.bereich.Netz != kandidaten[kunde].w.bereich.Netz) {
			rest = append(rest, k)
		}
	}
	sort.SliceStable(rest, func(i, j int) bool {
		if (rest[i].name == "br-lan") != (rest[j].name == "br-lan") {
			return rest[i].name == "br-lan"
		}
		return rest[i].name < rest[j].name
	})
	if len(rest) > 0 && len(out) < geraetesuche.MaxNetze {
		w := rest[0].w
		w.netz.Rolle = "box_netz"
		out = append(out, w)
	}
	return out, ""
}

// standardRoute is the interface and gateway of the default route with the
// lowest metric ("" = none).
func standardRoute(routen []Route) (string, netip.Addr) {
	best := -1
	for i, r := range routen {
		if r.Ziel.Bits() != 0 {
			continue
		}
		if best < 0 || r.Metrik < routen[best].Metrik {
			best = i
		}
	}
	if best < 0 {
		return "", netip.Addr{}
	}
	return routen[best].Schnittstelle, routen[best].Gateway
}

// routeGehtUeber says whether the kernel's route for the network leaves
// through the interface: the longest matching prefix (then the lowest metric)
// for its first host address. Without a routing table the interface's own
// network is believed.
func routeGehtUeber(routen []Route, netz netip.Prefix, schnittstelle string) bool {
	if len(routen) == 0 {
		return true
	}
	ziel := netz.Addr().Next()
	best := -1
	for i, r := range routen {
		if !r.Ziel.Contains(ziel) {
			continue
		}
		if best < 0 || r.Ziel.Bits() > routen[best].Ziel.Bits() ||
			(r.Ziel.Bits() == routen[best].Ziel.Bits() && r.Metrik < routen[best].Metrik) {
			best = i
		}
	}
	return best >= 0 && routen[best].Schnittstelle == schnittstelle
}

// ---------------------------------------------------------------- Linux readers

// SystemSchnittstellen lists the interfaces that are up, with their IPv4
// prefixes (loopback left out).
func SystemSchnittstellen() ([]Schnittstelle, error) {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	var out []Schnittstelle
	for _, ifi := range ifs {
		if ifi.Flags&net.FlagUp == 0 || ifi.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifi.Addrs()
		if err != nil {
			continue
		}
		s := Schnittstelle{Name: ifi.Name}
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil {
				continue
			}
			bits, _ := ipn.Mask.Size()
			addr, ok := netip.AddrFromSlice(ipn.IP.To4())
			if !ok {
				continue
			}
			s.Prefixe = append(s.Prefixe, netip.PrefixFrom(addr, bits))
		}
		if len(s.Prefixe) > 0 {
			out = append(out, s)
		}
	}
	return out, nil
}

// SystemRouten reads /proc/net/route.
func SystemRouten() ([]Route, error) {
	f, err := os.Open("/proc/net/route")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return LiesRouten(f)
}

// LiesRouten parses the /proc/net/route format (addresses in host byte order,
// little endian on every box we build for).
func LiesRouten(r io.Reader) ([]Route, error) {
	var out []Route
	sc := bufio.NewScanner(r)
	erste := true
	for sc.Scan() {
		if erste {
			erste = false
			continue
		}
		f := strings.Fields(sc.Text())
		if len(f) < 8 {
			continue
		}
		ziel, ok1 := hexAdresse(f[1])
		gw, ok2 := hexAdresse(f[2])
		maske, ok3 := hexAdresse(f[7])
		if !ok1 || !ok2 || !ok3 {
			continue
		}
		bits := 0
		m := maske.As4()
		for _, b := range m {
			for i := 7; i >= 0 && b&(1<<uint(i)) != 0; i-- {
				bits++
			}
		}
		metrik, _ := strconv.Atoi(f[6])
		rt := Route{Schnittstelle: f[0], Ziel: netip.PrefixFrom(ziel, bits).Masked(), Metrik: metrik}
		if !gw.IsUnspecified() {
			rt.Gateway = gw
		}
		out = append(out, rt)
	}
	return out, sc.Err()
}

func hexAdresse(s string) (netip.Addr, bool) {
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != 4 {
		return netip.Addr{}, false
	}
	var a [4]byte
	binary.BigEndian.PutUint32(a[:], binary.LittleEndian.Uint32(b))
	return netip.AddrFrom4(a), true
}

// SystemNachbarn reads /proc/net/arp.
func SystemNachbarn() ([]Nachbar, error) {
	f, err := os.Open("/proc/net/arp")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return LiesNachbarn(f)
}

// LiesNachbarn parses the /proc/net/arp format and keeps the complete entries
// (flag ATF_COM) - an incomplete one is an address nobody answered for.
func LiesNachbarn(r io.Reader) ([]Nachbar, error) {
	var out []Nachbar
	sc := bufio.NewScanner(r)
	erste := true
	for sc.Scan() {
		if erste {
			erste = false
			continue
		}
		f := strings.Fields(sc.Text())
		if len(f) < 6 {
			continue
		}
		ip, err := netip.ParseAddr(f[0])
		if err != nil || !ip.Is4() {
			continue
		}
		flags, err := strconv.ParseUint(strings.TrimPrefix(f[2], "0x"), 16, 32)
		if err != nil || flags&0x2 == 0 {
			continue
		}
		mac, err := net.ParseMAC(f[3])
		if err != nil || strings.Trim(f[3], "0:") == "" {
			continue
		}
		out = append(out, Nachbar{IP: ip, MAC: mac, Schnittstelle: f[5]})
	}
	return out, sc.Err()
}

// UDPAnstoss sends one datagram to the discard port: the kernel has to ask by
// ARP who holds the address. No raw socket - it runs under any user.
func UDPAnstoss(ip netip.Addr) error {
	c, err := net.DialUDP("udp4", nil, net.UDPAddrFromAddrPort(netip.AddrPortFrom(ip, 9)))
	if err != nil {
		return err
	}
	defer c.Close()
	if _, err := c.Write([]byte{0}); err != nil {
		return fmt.Errorf("udp nudge %s: %w", ip, err)
	}
	return nil
}
