// Package konfig liest die Einstellungen des Tunnel-Programms: eine Datei mit
// Zeilen "schluessel = wert" (wie /home/voltpilot/konfig von Edge Light auf
// dem PFC200). Sie wird gelesen, nie ausgeführt, und gehört root;
// edge-industrie/wartung.sh schreibt sie.
package konfig

import (
	"bufio"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
)

// Vorgabe ist der Ort der Einstellungen auf dem Gerät.
const Vorgabe = "/home/voltpilot/wartung/konfig"

// Konfig sind die Einstellungen.
type Konfig struct {
	Adresse          netip.Addr     // Tunnel-Adresse der Box (aus dem Portal)
	Endpunkt         string         // Wartungsserver, name:port
	ServerPub        string         // sein öffentlicher WireGuard-Schlüssel
	Netze            []netip.Prefix // erlaubte Absender im Tunnel: das Techniker-Netz
	SchluesselServer netip.AddrPort // Schlüsselausgabe, Server-Adresse im Techniker-Netz
	Web              bool           // Web-App der Box im Tunnel frei (für die erlaubten Netze)
	WebZiel          string         // wohin die Durchreiche auf der Box führt
	WGSchluessel     string         // Datei mit dem privaten WireGuard-Schlüssel der Box
	Hostkeys         []string       // Host-Schlüssel des Dropbear des Geräts
	Dauerhaft        string         // dauerhafte SSH-Schlüssel von root (nur gelesen)
	Ereignisse       string         // Ereignisliste (Flash)
	Stand            string         // Stand für "status" (RAM)
}

// Vorgaben gibt die Einstellungen ohne Datei: alles außer Adresse und
// Server-Schlüssel.
func Vorgaben() Konfig {
	return Konfig{
		Endpunkt:     "wartung.voltpilot.de:51820",
		Netze:        []netip.Prefix{netip.MustParsePrefix("10.10.32.0/24")},
		Web:          true,
		WebZiel:      "127.0.0.1:8484",
		WGSchluessel: "/home/voltpilot/wartung/wg.key",
		Hostkeys: []string{
			"/etc/dropbear/dropbear_ecdsa_host_key",
			"/etc/dropbear/dropbear_rsa_host_key",
			"/etc/dropbear/dropbear_ed25519_host_key",
		},
		Dauerhaft:  "/root/.ssh/authorized_keys",
		Ereignisse: "/home/voltpilot/wartung/ereignisse",
		Stand:      "/var/run/vp-wartung.stand",
	}
}

// Lies liest die Datei. Ein unbekannter Schlüssel ist ein Fehler: Ein
// Tippfehler soll nicht still nichts bewirken.
func Lies(pfad string) (Konfig, error) {
	k := Vorgaben()
	f, err := os.Open(pfad)
	if err != nil {
		return k, err
	}
	defer f.Close()
	schluesselServer := ""
	sc := bufio.NewScanner(f)
	for nr := 1; sc.Scan(); nr++ {
		z := strings.TrimSpace(sc.Text())
		if z == "" || strings.HasPrefix(z, "#") {
			continue
		}
		name, wert, ok := strings.Cut(z, "=")
		name, wert = strings.TrimSpace(name), strings.TrimSpace(wert)
		if !ok || name == "" {
			return k, fmt.Errorf("%s Zeile %d: keine Angabe \"schluessel = wert\"", pfad, nr)
		}
		switch name {
		case "adresse":
			if k.Adresse, err = netip.ParseAddr(wert); err != nil || !k.Adresse.Is4() {
				return k, fmt.Errorf("%s Zeile %d: adresse ist keine IPv4-Adresse", pfad, nr)
			}
		case "endpunkt":
			k.Endpunkt = wert
		case "server_pubkey":
			k.ServerPub = wert
		case "netz":
			k.Netze = nil
			for _, t := range strings.Split(wert, ",") {
				n, err := netip.ParsePrefix(strings.TrimSpace(t))
				if err != nil || !n.Addr().Is4() {
					return k, fmt.Errorf("%s Zeile %d: netz %q ist kein IPv4-Netz", pfad, nr, t)
				}
				k.Netze = append(k.Netze, n.Masked())
			}
		case "schluessel_server":
			schluesselServer = wert
		case "web":
			switch wert {
			case "netz":
				k.Web = true
			case "zu":
				k.Web = false
			default:
				return k, fmt.Errorf("%s Zeile %d: web ist \"netz\" oder \"zu\"", pfad, nr)
			}
		case "web_ziel":
			k.WebZiel = wert
		case "wg_schluessel":
			k.WGSchluessel = wert
		case "hostkeys":
			k.Hostkeys = nil
			for _, t := range strings.Split(wert, ",") {
				if t = strings.TrimSpace(t); t != "" {
					k.Hostkeys = append(k.Hostkeys, t)
				}
			}
		case "dauerhaft":
			k.Dauerhaft = wert
		case "ereignisse":
			k.Ereignisse = wert
		case "stand":
			k.Stand = wert
		default:
			return k, fmt.Errorf("%s Zeile %d: unbekannte Angabe %q", pfad, nr, name)
		}
	}
	if err := sc.Err(); err != nil {
		return k, err
	}
	if schluesselServer != "" {
		if k.SchluesselServer, err = netip.ParseAddrPort(schluesselServer); err != nil {
			return k, fmt.Errorf("%s: schluessel_server ist keine Adresse mit Port", pfad)
		}
	}
	return k, k.Pruefe()
}

// Pruefe ergänzt, was sich ableiten lässt, und nennt, was fehlt.
func (k *Konfig) Pruefe() error {
	if !k.Adresse.Is4() {
		return fmt.Errorf("adresse fehlt (die Tunnel-Adresse der Box aus dem Portal)")
	}
	if strings.TrimSpace(k.ServerPub) == "" {
		return fmt.Errorf("server_pubkey fehlt (der Schlüssel des Wartungsservers aus dem Portal)")
	}
	if len(k.Netze) == 0 {
		return fmt.Errorf("netz fehlt")
	}
	host, port, err := net.SplitHostPort(k.Endpunkt)
	if p, perr := strconv.Atoi(port); err != nil || host == "" || perr != nil || p < 1 || p > 65535 {
		return fmt.Errorf("endpunkt %q ist nicht name:port", k.Endpunkt)
	}
	if !k.SchluesselServer.IsValid() {
		// Die Schlüsselausgabe lauscht auf der Server-Adresse im Techniker-Netz.
		k.SchluesselServer = netip.AddrPortFrom(k.Netze[0].Masked().Addr().Next(), 8022)
	}
	if k.Web {
		if _, _, err := net.SplitHostPort(k.WebZiel); err != nil {
			return fmt.Errorf("web_ziel %q ist nicht adresse:port", k.WebZiel)
		}
	}
	return nil
}
