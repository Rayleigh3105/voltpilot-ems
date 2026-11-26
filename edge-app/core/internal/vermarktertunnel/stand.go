package vermarktertunnel

import (
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// How the manager sees the tunnel, without any extra control surface:
//
//   - The tunnel ADDRESS is the address on the tun device TunnelGeraet
//     (tunnelAdresse). It is what the Modbus interface binds to and what the
//     firewall's accept rule names.
//   - The tunnel is ALIVE ("Handshake jung", §5.4) while the keepalive
//     traffic flows: openvpn.conf sets `keepalive 10 60` and a `status` file
//     every 10 s, so the status file's byte counters grow at least every
//     10 s on a standing tunnel and stop the moment the peer is gone.
//     zaehlerStand reads the counters; the manager compares them between
//     ticks and keeps the time of the last growth.
//
// With persist-tun (required for the privilege drop) the tun device and its
// address survive a reconnect, so the ADDRESS alone can never prove a
// standing tunnel - only the counters can.

// tunnelAdresse returns the IPv4 address on the tun device, or "".
func tunnelAdresse() string {
	ifc, err := net.InterfaceByName(TunnelGeraet)
	if err != nil {
		return ""
	}
	addrs, err := ifc.Addrs()
	if err != nil {
		return ""
	}
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok {
			if v4 := ipn.IP.To4(); v4 != nil {
				return v4.String()
			}
		}
	}
	return ""
}

// zaehlerStand reads the OpenVPN client status file: the sum of its byte
// counters and the file's own update stamp. ok=false when the file is
// missing or carries no counters (daemon not running or not written yet).
func zaehlerStand(path string) (summe uint64, aktualisiert time.Time, ok bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, time.Time{}, false
	}
	gefunden := false
	for _, zeile := range strings.Split(string(raw), "\n") {
		name, wert, hatKomma := strings.Cut(strings.TrimSpace(zeile), ",")
		if !hatKomma {
			continue
		}
		switch name {
		// READ-side counters only: they grow when bytes arrive FROM the
		// peer (its keepalive pings, ~every 10 s). The write side would
		// grow on our own unanswered reconnect attempts too and claim a
		// peer that is not there.
		case "TCP/UDP read bytes", "Auth read bytes":
			if n, err := strconv.ParseUint(wert, 10, 64); err == nil {
				summe += n
				gefunden = true
			}
		case "Updated":
			if t, err := time.ParseInLocation("2006-01-02 15:04:05", wert, time.Local); err == nil {
				aktualisiert = t
			}
		}
	}
	return summe, aktualisiert, gefunden
}
