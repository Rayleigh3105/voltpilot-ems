package suche

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// The multicast ways of Edge Light (contract `wege`): mDNS and SSDP QUERIES
// and listening for the Speedwire multicast of an SMA energy meter. They make
// no find of their own - they give the recognisers hints and sort what is
// counted in weitere. Answers carry names (instance names, friendly names);
// they are reduced to fixed words here and never kept.

// Rundruf asks and listens on the given interfaces until ctx ends.
type Rundruf interface {
	Hoeren(ctx context.Context, schnittstellen []string, wege []string) Antworten
}

// Antworten is what the multicast ways heard, per address.
type Antworten struct {
	MDNS      map[netip.Addr]map[string]bool
	SSDP      map[netip.Addr]string
	Speedwire map[netip.Addr]uint32
	// Wege lists the ways that really ran (a socket that would not open is
	// "not searched", never "nothing there").
	Wege []string
}

// mdnsDienste are the service types asked for, and the word each one gives.
var mdnsDienste = []struct{ typ, wort string }{
	{"_shelly._tcp.local.", "shelly"},
	{"_http._tcp.local.", ""},
	{"_apple-mobdev2._tcp.local.", "telefon"},
	{"_workstation._tcp.local.", "rechner"},
	{"_smb._tcp.local.", "rechner"},
	{"_ssh._tcp.local.", "rechner"},
}

// SystemRundruf is the real multicast of the box.
type SystemRundruf struct{}

// Hoeren runs the ways in parallel until ctx ends.
func (SystemRundruf) Hoeren(ctx context.Context, schnittstellen []string, wege []string) Antworten {
	out := Antworten{MDNS: map[netip.Addr]map[string]bool{}, SSDP: map[netip.Addr]string{},
		Speedwire: map[netip.Addr]uint32{}}
	var mu sync.Mutex
	var wg sync.WaitGroup
	lief := func(w string) {
		mu.Lock()
		if !enthaelt(out.Wege, w) {
			out.Wege = append(out.Wege, w)
		}
		mu.Unlock()
	}
	for _, name := range schnittstellen {
		ifi, err := net.InterfaceByName(name)
		if err != nil {
			continue
		}
		quelle := ipv4Von(ifi)
		if !quelle.IsValid() {
			continue
		}
		if enthaelt(wege, "mdns") {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if mdnsFragen(ctx, quelle, func(ip netip.Addr, wort string) {
					mu.Lock()
					if out.MDNS[ip] == nil {
						out.MDNS[ip] = map[string]bool{}
					}
					if wort != "" {
						out.MDNS[ip][wort] = true
					}
					mu.Unlock()
				}) {
					lief("mdns")
				}
			}()
		}
		if enthaelt(wege, "ssdp") {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if ssdpFragen(ctx, quelle, func(ip netip.Addr, ort string) {
					mu.Lock()
					out.SSDP[ip] = ort
					mu.Unlock()
				}) {
					lief("ssdp")
				}
			}()
		}
		if enthaelt(wege, "speedwire") {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if speedwireHoeren(ctx, ifi, func(ip netip.Addr, sn uint32) {
					mu.Lock()
					out.Speedwire[ip] = sn
					mu.Unlock()
				}) {
					lief("speedwire")
				}
			}()
		}
	}
	wg.Wait()
	return out
}

func ipv4Von(ifi *net.Interface) netip.Addr {
	addrs, err := ifi.Addrs()
	if err != nil {
		return netip.Addr{}
	}
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok {
			if v4 := ipn.IP.To4(); v4 != nil {
				ip, _ := netip.AddrFromSlice(v4)
				return ip
			}
		}
	}
	return netip.Addr{}
}

// multicastSocket opens a UDP socket on the interface's address from an
// ephemeral port: answers to a query from a port other than 5353/1900 come
// back by unicast (mDNS "legacy unicast", SSDP), no group join needed.
func multicastSocket(quelle netip.Addr) (*net.UDPConn, error) {
	lc := net.ListenConfig{Control: multicastAusgang(quelle)}
	pc, err := lc.ListenPacket(context.Background(), "udp4", netip.AddrPortFrom(quelle, 0).String())
	if err != nil {
		return nil, err
	}
	return pc.(*net.UDPConn), nil
}

// mdnsFragen sends one query for the service types and collects answers.
func mdnsFragen(ctx context.Context, quelle netip.Addr, melde func(netip.Addr, string)) bool {
	c, err := multicastSocket(quelle)
	if err != nil {
		return false
	}
	defer c.Close()
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{})
	b.EnableCompression()
	if b.StartQuestions() != nil {
		return false
	}
	for _, d := range mdnsDienste {
		name, err := dnsmessage.NewName(d.typ)
		if err != nil {
			return false
		}
		_ = b.Question(dnsmessage.Question{Name: name, Type: dnsmessage.TypePTR, Class: dnsmessage.ClassINET})
	}
	frage, err := b.Finish()
	if err != nil {
		return false
	}
	if _, err := c.WriteToUDPAddrPort(frage, netip.MustParseAddrPort("224.0.0.251:5353")); err != nil {
		return false
	}
	lesen(ctx, c, func(quelle netip.Addr, paket []byte) {
		for _, wort := range mdnsWoerter(paket) {
			melde(quelle, wort)
		}
	})
	return true
}

// mdnsWoerter reduces an answer to words: the service types it names, and
// "goe" for a go-e charger's instance name. The names themselves are dropped.
func mdnsWoerter(paket []byte) []string {
	var p dnsmessage.Parser
	if _, err := p.Start(paket); err != nil {
		return nil
	}
	_ = p.SkipAllQuestions()
	woerter := []string{""}
	for {
		h, err := p.AnswerHeader()
		if err != nil {
			break
		}
		name := strings.ToLower(h.Name.String())
		if h.Type == dnsmessage.TypePTR {
			if r, err := p.PTRResource(); err == nil {
				ziel := strings.ToLower(r.PTR.String())
				if strings.HasPrefix(ziel, "go-echarger") {
					woerter = append(woerter, "goe")
				}
			}
		} else {
			_ = p.SkipAnswer()
		}
		for _, d := range mdnsDienste {
			if d.wort != "" && strings.HasSuffix(name, d.typ) {
				woerter = append(woerter, d.wort)
			}
		}
	}
	return woerter
}

// ssdpFragen sends one M-SEARCH and collects the LOCATION of every answer.
func ssdpFragen(ctx context.Context, quelle netip.Addr, melde func(netip.Addr, string)) bool {
	c, err := multicastSocket(quelle)
	if err != nil {
		return false
	}
	defer c.Close()
	frage := "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\n" +
		"ST: upnp:rootdevice\r\n\r\n"
	if _, err := c.WriteToUDPAddrPort([]byte(frage), netip.MustParseAddrPort("239.255.255.250:1900")); err != nil {
		return false
	}
	lesen(ctx, c, func(quelle netip.Addr, paket []byte) {
		resp, err := http.ReadResponse(bufio.NewReader(bytes.NewReader(paket)), nil)
		if err != nil {
			return
		}
		_ = resp.Body.Close()
		if ort := resp.Header.Get("Location"); ort != "" && len(ort) <= 256 {
			melde(quelle, ort)
		}
	})
	return true
}

// speedwireHoeren listens for the SMA energy meter's multicast and keeps its
// serial (protocol 0x6069: SUSy-ID at 18, serial at 20). false = the socket
// did not open: not listened, which is not "no meter there".
func speedwireHoeren(ctx context.Context, ifi *net.Interface, melde func(netip.Addr, uint32)) bool {
	c, err := net.ListenMulticastUDP("udp4", ifi, &net.UDPAddr{IP: net.IPv4(239, 12, 255, 254), Port: 9522})
	if err != nil {
		return false
	}
	defer c.Close()
	lesen(ctx, c, func(quelle netip.Addr, p []byte) {
		if len(p) >= 24 && string(p[0:4]) == "SMA\x00" && binary.BigEndian.Uint16(p[16:]) == 0x6069 {
			if sn := binary.BigEndian.Uint32(p[20:]); sn != 0 && sn != 0xFFFFFFFF {
				melde(quelle, sn)
			}
		}
	})
	return true
}

// lesen hands every datagram to f until ctx ends.
func lesen(ctx context.Context, c *net.UDPConn, f func(netip.Addr, []byte)) {
	buf := make([]byte, 9000)
	for ctx.Err() == nil {
		_ = c.SetReadDeadline(time.Now().Add(250 * time.Millisecond))
		n, von, err := c.ReadFromUDPAddrPort(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			return
		}
		f(von.Addr().Unmap(), append([]byte(nil), buf[:n]...))
	}
}
