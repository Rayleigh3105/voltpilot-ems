//go:build !unix

package suche

import (
	"net/netip"
	"syscall"
)

// multicastAusgang: without unix sockets the default interface is used.
func multicastAusgang(netip.Addr) func(network, address string, c syscall.RawConn) error {
	return nil
}
