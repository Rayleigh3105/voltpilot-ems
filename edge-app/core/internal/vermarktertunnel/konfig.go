package vermarktertunnel

import (
	"fmt"
	"path/filepath"
	"strings"
)

// TunnelGeraet is the fixed tun device name of the partner tunnel. Fixed so
// the firewall rules, the zone and the status surface always mean the same
// interface (14 characters fits IFNAMSIZ).
const TunnelGeraet = "vp_vermarkter"

// Pfade is where the generated runtime artifacts live. Dir is flash
// (configuration, survives reboot and sysupgrade), RAM is tmpfs (pid,
// management socket, status - gone on reboot, like the §5.4 rule that no
// set-point survives a restart).
type Pfade struct {
	Dir string // the delivery dir (see zugang.go), also holds openvpn.conf
	RAM string // tmpfs for pidfile, management socket and status file
}

func (p Pfade) Konfig() string     { return filepath.Join(p.Dir, "openvpn.conf") }
func (p Pfade) Pid() string        { return filepath.Join(p.RAM, "openvpn.pid") }
func (p Pfade) Stand() string      { return filepath.Join(p.RAM, "stand") }
func (p Pfade) Ereignisse() string { return filepath.Join(p.Dir, "ereignisse") }

// KonfigOptionen tune the generated configuration for the host it runs on.
type KonfigOptionen struct {
	// Nutzer/Gruppe the OpenVPN process drops to after the start (concept §8
	// "Prozess ohne Rechte nach dem Start"). Empty = keep the OpenWrt
	// defaults nobody/nogroup; "-" = omit the directive (containers without
	// that user).
	Nutzer, Gruppe string
}

func (o KonfigOptionen) nutzer() string {
	if o.Nutzer == "" {
		return "nobody"
	}
	return o.Nutzer
}

func (o KonfigOptionen) gruppe() string {
	if o.Gruppe == "" {
		return "nogroup"
	}
	return o.Gruppe
}

// OpenVPNKonfig builds the box's OWN OpenVPN client configuration from the
// validated access facts - never the partner's file as a whole (concept §8
// "die Box erzeugt ihre Konfiguration selbst"). Everything here is fixed
// policy; the only delivered inputs are peer host/port/protocol and which
// TLS key mode the material uses. The host was validated against hostOK, so
// no delivered byte can smuggle a directive into this file.
//
// The security-relevant lines, each tied to its rule in concept §8:
//   - route-nopull + the pull-filter ignores: the partner is a point, not a
//     network - no pushed route, no redirect-gateway, no DNS is accepted
//     (PS-D17).
//   - script-security 0: the configuration may execute nothing, whatever a
//     pushed option or a future config edit tries.
//   - remote-cert-tls server: the box only ever talks to a certified SERVER
//     certificate, so a stolen second client certificate cannot impersonate
//     the partner.
//   - user/group: the process keeps no root after the start; persist-key and
//     persist-tun keep restarts working without re-reading the key.
//   - connect-retry 5 300: the growing back-off of §5.4 "baut_auf" (doubling
//     after five attempts, capped at five minutes).
//   - daemon + writepid: the tunnel outlives the program (PS-D8); the
//     manager and the boot init adopt it through the pidfile.
func OpenVPNKonfig(z Zugang, p Pfade, o KonfigOptionen) ([]byte, error) {
	if !hostOK.MatchString(z.Gegenstelle.Host) {
		return nil, fmt.Errorf("gegenstelle.host ist keine Adresse")
	}
	proto := z.Gegenstelle.Protokoll
	if proto == "tcp" {
		proto = "tcp-client"
	}
	var b strings.Builder
	w := func(line string, args ...any) { fmt.Fprintf(&b, line+"\n", args...) }
	w("# VoltPilot Direktvermarktung - von vp-edge-light erzeugt, nicht von Hand aendern.")
	w("# Quelle: Partnerprofil + zugang.json (nie die Datei des Partners im Ganzen).")
	w("client")
	w("dev %s", TunnelGeraet)
	w("dev-type tun")
	w("proto %s", proto)
	w("remote %s %d", z.Gegenstelle.Host, z.Gegenstelle.Port)
	w("nobind")
	w("resolv-retry infinite")
	w("connect-retry 5 300")
	w("remote-cert-tls server")
	w("auth-nocache")
	w("script-security 0")
	w("route-nopull")
	w(`pull-filter ignore "route "`)
	w(`pull-filter ignore "route-ipv6 "`)
	w(`pull-filter ignore "redirect-gateway"`)
	w(`pull-filter ignore "dhcp-option "`)
	w(`pull-filter ignore "block-outside-dns"`)
	w("persist-key")
	w("persist-tun")
	if o.nutzer() != "-" {
		w("user %s", o.nutzer())
	}
	if o.gruppe() != "-" {
		w("group %s", o.gruppe())
	}
	w("verb 3")
	zdir := filepath.Join(p.Dir, ZugangOrdner)
	w("ca %s", filepath.Join(zdir, CADatei))
	w("cert %s", filepath.Join(zdir, ZertifikatDatei))
	w("key %s", filepath.Join(zdir, SchluesselDatei))
	switch z.TLSSchluessel {
	case "tls_crypt":
		w("tls-crypt %s", filepath.Join(zdir, TLSSchluesselDatei))
	case "tls_auth":
		// Direction 1 is the client side of a directional tls-auth pair.
		w("tls-auth %s 1", filepath.Join(zdir, TLSSchluesselDatei))
	}
	// keepalive: a ping every 10 s proves the peer is really there, and 60 s
	// of silence makes OpenVPN reconnect on its own. The manager reads the
	// resulting counter growth from the status file - that is its whole
	// "Handshake jung" signal (stand.go), no extra control surface.
	w("keepalive 10 60")
	w("daemon")
	w("writepid %s", p.Pid())
	w("status %s 10", p.Stand())
	return []byte(b.String()), nil
}
