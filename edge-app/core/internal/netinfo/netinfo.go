// Package netinfo answers ONE question the box could never answer about
// itself: under which address is it reachable in the customer's network?
//
// The gap is documented and cost two support rounds: the portal shows every
// DEVICE address (the box stores them) but not the box's own, so "how do I
// open the local surface" ended in "look it up in your router" - and it is the
// first question on a support call (concept `vp-anlagen-zentrale-konzept-h6`
// D5).
//
// # Why the interface address alone is NOT the answer
//
// The core runs in a bridge-networked container with published ports, so
// net.Interfaces() reports the DOCKER bridge address (172.x). That address is
// a true fact about the container and a USELESS one for the customer - typing
// it opens nothing. Reporting it as "the address of your box" would be exactly
// the fabricated answer this package exists to avoid.
//
// # What IS provable
//
// The address a browser DEMONSTRABLY reached the local web app on. Docker's
// DNAT rewrites the packet's destination IP but never the HTTP `Host` header,
// which the browser writes as the customer TYPED it - so a request to
// :8484 carries the exact address that worked, port included. That is the
// strongest possible evidence and it is also the exact URL a human needs.
//
// The interface address is reported ONLY when the process is not
// containerized (a future host-network or bare-metal install), so it can never
// be mistaken for a reachable one.
//
// Everything here is deterministic and takes its `now` - the house rule for a
// pure rule module.
package netinfo

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Observation is what the box can prove about its own reachability.
type Observation struct {
	// Host is the address a browser reached the local web app on, VERBATIM
	// (including the port, because the port is part of the address a human
	// types). Empty = never observed.
	Host string `json:"host,omitempty"`
	// SeenAt is when that address last worked (RFC 3339). Empty with Host
	// empty; the two always travel together.
	SeenAt time.Time `json:"seen_at,omitempty"`
	// IP / Iface are the box's OWN interface address, reported ONLY on a
	// non-containerized install (see the package doc). Empty otherwise - never
	// a bridge address dressed up as a LAN address.
	IP    string `json:"ip,omitempty"`
	Iface string `json:"iface,omitempty"`
}

// Empty reports whether nothing at all is known - then no block is sent and
// the portal keeps saying "your box does not report this yet".
func (o Observation) Empty() bool { return o.Host == "" && o.IP == "" }

// forgetAfter bounds how long an observed address stays credible. A DHCP lease
// or a moved box makes an old address wrong, and a wrong address is worse than
// none: it sends a human to a page that does not answer. Two weeks is far
// longer than any onboarding and far shorter than a lease that never renews.
const forgetAfter = 14 * 24 * time.Hour

// AcceptHost normalizes a `Host` header into an address worth reporting, or
// returns false.
//
// Rejected on purpose:
//   - loopback and `localhost` (the installer's own health check, an SSH
//     tunnel) - useless to anyone reading the portal;
//   - an empty or malformed value;
//   - a bare, dot-less hostname (`voltpilot`, the container name) - it only
//     resolves inside someone's own search domains, so it is not an address a
//     second person can type.
//
// Accepted VERBATIM otherwise: an IP literal or a dotted name, with its port.
func AcceptHost(raw string) (string, bool) {
	h := strings.TrimSpace(raw)
	if h == "" || len(h) > 255 {
		return "", false
	}
	host := h
	if v, _, err := net.SplitHostPort(h); err == nil {
		host = v
	}
	host = strings.Trim(host, "[]")
	if host == "" {
		return "", false
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsLoopback() || ip.IsUnspecified() {
			return "", false
		}
		return h, true
	}
	name := strings.ToLower(strings.TrimSuffix(host, "."))
	if name == "localhost" || !strings.Contains(name, ".") {
		return "", false
	}
	return h, true
}

// Store keeps the newest proven address and persists it, so a restart does not
// forget an address that has already worked. One file, one writer - the
// inverter.json / despike.json pattern.
type Store struct {
	path string
	// obs is guarded by the agent's usual single-goroutine discipline for
	// writes plus a mutex, because HTTP handlers observe concurrently.
	mu  chan struct{}
	obs Observation
}

// NewStore loads the persisted observation from `<dir>/network.json`. A missing
// or unreadable file is simply "nothing known yet" - this is a convenience
// fact, never a reason to fail a boot.
func NewStore(dir string) *Store {
	s := &Store{path: filepath.Join(dir, "network.json"), mu: make(chan struct{}, 1)}
	s.mu <- struct{}{}
	if raw, err := os.ReadFile(s.path); err == nil {
		var o Observation
		if json.Unmarshal(raw, &o) == nil {
			s.obs.Host, s.obs.SeenAt = o.Host, o.SeenAt
		}
	}
	return s
}

// Observe records that `raw` (a Host header) demonstrably reached this box.
// Returns true when something was stored (a caller may then persist).
func (s *Store) Observe(raw string, now time.Time) bool {
	host, ok := AcceptHost(raw)
	if !ok {
		return false
	}
	<-s.mu
	changed := s.obs.Host != host || now.Sub(s.obs.SeenAt) > time.Minute
	s.obs.Host, s.obs.SeenAt = host, now
	s.mu <- struct{}{}
	return changed
}

// Snapshot is what the heartbeat reports: the proven address (while it is
// still credible) plus, on a non-containerized install, the interface address.
func (s *Store) Snapshot(now time.Time) Observation {
	<-s.mu
	o := s.obs
	s.mu <- struct{}{}
	if o.Host != "" && now.Sub(o.SeenAt) > forgetAfter {
		o.Host, o.SeenAt = "", time.Time{}
	}
	if !InContainer() {
		if ip, iface, ok := Interface(); ok {
			o.IP, o.Iface = ip, iface
		}
	}
	return o
}

// Persist writes the proven address to disk (tmp + rename, so a restart in the
// middle stays deterministic). Best-effort: a read-only data dir costs the
// convenience, never the boot.
func (s *Store) Persist() error {
	<-s.mu
	o := Observation{Host: s.obs.Host, SeenAt: s.obs.SeenAt}
	s.mu <- struct{}{}
	raw, err := json.Marshal(o)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// InContainer reports whether this process runs inside a container. Docker
// creates /.dockerenv in every container it starts; the cgroup file is the
// fallback for runtimes that do not.
func InContainer() bool {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true
	}
	raw, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return false
	}
	body := string(raw)
	return strings.Contains(body, "/docker/") || strings.Contains(body, "/kubepods")
}

// Interface returns the box's own up, non-loopback IPv4 address and the
// interface carrying it. With several candidates it returns none rather than
// picking one - a guessed address is the thing this package refuses to do.
func Interface() (string, string, bool) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", "", false
	}
	var ip, name string
	for _, i := range ifaces {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := i.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			n, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			v4 := n.IP.To4()
			if v4 == nil || v4.IsLoopback() || v4.IsLinkLocalUnicast() {
				continue
			}
			if ip != "" && ip != v4.String() {
				return "", "", false // ambiguous - say nothing
			}
			ip, name = v4.String(), i.Name
		}
	}
	if ip == "" {
		return "", "", false
	}
	return ip, name, true
}
