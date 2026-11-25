package vermarktertunnel

import (
	"bytes"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// The firewall of the partner tunnel (concept §8 "Netz", PS-D3, PS-D16).
//
// Two layers, like the Wartungstunnel's vp_sperre (service-tunnel.sh):
//
//  1. The fw4 ZONE `vermarkter` (uci, OpenWrt only): the tun device in its
//     own zone with input REJECT / forward REJECT, plus ONE rule that lets
//     TCP onto the Modbus port. This is what makes fw4 accept the partner's
//     connection at all.
//  2. The nftables include below (hook chains at priority -5, BEFORE fw4's
//     chains): the hard guarantee that holds even if someone edits the
//     zones - inbound from the tunnel nothing but the one Modbus port to
//     the tunnel address, no forwarding in either direction, and outbound
//     into the tunnel only the interface's own answers (the box never calls
//     the partner network; the OpenVPN control channel runs over WAN, not
//     through the tun device).
//
// In the container proof (no fw4) the same generated ruleset is applied as
// its own table - the bytes under test are identical.

// NftRegeln renders the nftables chains. tunnelAddr is the box's current
// tunnel address ("" while the tunnel has never been up: then NOTHING is
// accepted inbound, which is the safe state before the first handshake).
func NftRegeln(tunnelAddr string, modbusPort int) []byte {
	var b strings.Builder
	w := func(line string, args ...any) { fmt.Fprintf(&b, line+"\n", args...) }
	w("# VoltPilot Direktvermarktung - von vp-edge-light erzeugt, nicht von Hand aendern.")
	w("chain vp_vermarkter_eingang {")
	w("\ttype filter hook input priority -5; policy accept;")
	if tunnelAddr != "" && net.ParseIP(tunnelAddr) != nil {
		w("\tiifname \"%s\" ip daddr %s tcp dport %d counter accept comment \"vp-vermarkter: nur die Schnittstelle\"", TunnelGeraet, tunnelAddr, modbusPort)
	}
	w("\tiifname \"%s\" counter drop comment \"vp-vermarkter: sonst erreicht der Partner nichts\"", TunnelGeraet)
	w("}")
	w("chain vp_vermarkter_weiter {")
	w("\ttype filter hook forward priority -5; policy accept;")
	w("\tiifname \"%s\" counter drop comment \"vp-vermarkter: keine Weiterleitung ins Kundennetz\"", TunnelGeraet)
	w("\toifname \"%s\" counter drop comment \"vp-vermarkter: keine Weiterleitung zum Partner\"", TunnelGeraet)
	w("}")
	w("chain vp_vermarkter_ausgang {")
	w("\ttype filter hook output priority -5; policy accept;")
	w("\toifname \"%s\" tcp sport %d ct state established counter accept comment \"vp-vermarkter: Antworten der Schnittstelle\"", TunnelGeraet, modbusPort)
	w("\toifname \"%s\" counter drop comment \"vp-vermarkter: die Box ruft den Partner nicht\"", TunnelGeraet)
	w("}")
	return []byte(b.String())
}

// Netz applies the generated ruleset to the host (and removes it again).
type Netz interface {
	// Anwenden makes the ruleset effective. Called on every change of the
	// tunnel address, so it must be idempotent.
	Anwenden(regeln []byte) error
	// Entfernen takes every vp_vermarkter rule away (profile withdrawn).
	Entfernen() error
}

// NetzFuerHost picks the implementation for this host: fw4/uci on OpenWrt,
// plain nft everywhere else (the container proof). modbusPort is the
// partner's Modbus port for the zone's one allow rule.
func NetzFuerHost(modbusPort int) Netz {
	if _, err := exec.LookPath("uci"); err == nil {
		return &openwrtNetz{port: modbusPort}
	}
	return &nftNetz{}
}

// --- OpenWrt (fw4 + uci) ------------------------------------------------------

// nftInclude is where fw4 picks the hard chains up (loaded into table inet
// fw4 on every firewall reload, like 20-vp-wartung.nft of the maintenance
// tunnel).
const nftInclude = "/etc/nftables.d/30-vp-vermarkter.nft"

type openwrtNetz struct {
	port     int
	zoneOnce bool
}

func (o *openwrtNetz) Anwenden(regeln []byte) error {
	if err := o.zone(); err != nil {
		return err
	}
	// Check before placing: an include nft cannot parse would make the NEXT
	// fw4 reload fail and leave the box without a firewall (the vp_sperre
	// lesson in service-tunnel.sh).
	probe := append([]byte("table inet vp_pruefung {\n"), regeln...)
	probe = append(probe, []byte("}\n")...)
	cmd := exec.Command("nft", "-c", "-f", "-")
	cmd.Stdin = bytes.NewReader(probe)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("nft -c: %v: %s", err, strings.TrimSpace(string(out)))
	}
	if err := os.MkdirAll(filepath.Dir(nftInclude), 0o755); err != nil {
		return err
	}
	if alt, err := os.ReadFile(nftInclude); err == nil && bytes.Equal(alt, regeln) {
		return nil
	}
	if err := os.WriteFile(nftInclude+".neu", regeln, 0o644); err != nil {
		return err
	}
	if err := os.Rename(nftInclude+".neu", nftInclude); err != nil {
		return err
	}
	return o.firewallReload()
}

func (o *openwrtNetz) Entfernen() error {
	hatte := false
	if err := os.Remove(nftInclude); err == nil {
		hatte = true
	}
	for _, abschnitt := range []string{"firewall.vp_vermarkter_modbus", "firewall.vp_vermarkter"} {
		if exec.Command("uci", "-q", "get", abschnitt).Run() == nil {
			hatte = true
		}
		_ = exec.Command("uci", "-q", "delete", abschnitt).Run()
	}
	_ = exec.Command("uci", "commit", "firewall").Run()
	o.zoneOnce = false
	if !hatte {
		return nil
	}
	return o.firewallReload()
}

// zone writes the fw4 zone `vermarkter` and its one Modbus allow rule, only
// when something is missing (uci churn would reload the firewall for
// nothing).
func (o *openwrtNetz) zone() error {
	if o.zoneOnce {
		return nil
	}
	if exec.Command("uci", "-q", "get", "firewall.vp_vermarkter").Run() == nil &&
		exec.Command("uci", "-q", "get", "firewall.vp_vermarkter_modbus").Run() == nil {
		o.zoneOnce = true
		return nil
	}
	saetze := [][]string{
		{"-q", "delete", "firewall.vp_vermarkter"},
		{"set", "firewall.vp_vermarkter=zone"},
		{"set", "firewall.vp_vermarkter.name=vermarkter"},
		{"set", "firewall.vp_vermarkter.input=REJECT"},
		{"set", "firewall.vp_vermarkter.output=ACCEPT"},
		{"set", "firewall.vp_vermarkter.forward=REJECT"},
		{"add_list", "firewall.vp_vermarkter.device=" + TunnelGeraet},
		{"-q", "delete", "firewall.vp_vermarkter_modbus"},
		{"set", "firewall.vp_vermarkter_modbus=rule"},
		{"set", "firewall.vp_vermarkter_modbus.name=Allow-Vermarkter-Modbus"},
		{"set", "firewall.vp_vermarkter_modbus.src=vermarkter"},
		{"set", "firewall.vp_vermarkter_modbus.proto=tcp"},
		{"set", fmt.Sprintf("firewall.vp_vermarkter_modbus.dest_port=%d", o.port)},
		{"set", "firewall.vp_vermarkter_modbus.target=ACCEPT"},
		{"commit", "firewall"},
	}
	for _, args := range saetze {
		if out, err := exec.Command("uci", args...).CombinedOutput(); err != nil && args[0] != "-q" {
			return fmt.Errorf("uci %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
		}
	}
	o.zoneOnce = true
	return nil
}

func (o *openwrtNetz) firewallReload() error {
	if out, err := exec.Command("/etc/init.d/firewall", "reload").CombinedOutput(); err != nil {
		return fmt.Errorf("firewall reload: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// --- plain nftables (container proof) ----------------------------------------

type nftNetz struct{}

func (n *nftNetz) Anwenden(regeln []byte) error {
	skript := bytes.Buffer{}
	// add + delete first = idempotent replace, whether or not the table
	// already exists.
	skript.WriteString("add table inet vp_vermarkter\n")
	skript.WriteString("delete table inet vp_vermarkter\n")
	skript.WriteString("table inet vp_vermarkter {\n")
	skript.Write(regeln)
	skript.WriteString("}\n")
	cmd := exec.Command("nft", "-f", "-")
	cmd.Stdin = &skript
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("nft -f: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (n *nftNetz) Entfernen() error {
	cmd := exec.Command("nft", "-f", "-")
	cmd.Stdin = strings.NewReader("add table inet vp_vermarkter\ndelete table inet vp_vermarkter\n")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("nft -f: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
