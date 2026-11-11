//go:build unix

package suche

import (
	"net/netip"
	"syscall"
)

// multicastAusgang pins the interface a multicast query leaves through: the
// address of the network it is meant for, never the default route's.
func multicastAusgang(quelle netip.Addr) func(network, address string, c syscall.RawConn) error {
	return func(_, _ string, c syscall.RawConn) error {
		var serr error
		err := c.Control(func(fd uintptr) {
			serr = syscall.SetsockoptInet4Addr(int(fd), syscall.IPPROTO_IP, syscall.IP_MULTICAST_IF, quelle.As4())
		})
		if err != nil {
			return err
		}
		return serr
	}
}
