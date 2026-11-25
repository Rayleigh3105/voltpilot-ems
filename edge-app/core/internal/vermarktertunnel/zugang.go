// Package vermarktertunnel is the Mango's side of the direct-marketing
// connection (vp-direktvermarktung-konzept d2 §5.4, Stage 2): the OpenVPN
// tunnel manager that builds the box's own OpenVPN configuration from the
// partner profile and the delivered access material (NEVER the partner's
// file as a whole), applies the firewall rules of the zone `vermarkter`
// (inbound nothing but the one Modbus port to the tunnel address, no
// forwarding, no partner-pushed routes), starts and supervises the OpenVPN
// service with a growing back-off, and reports the connection states of
// concept §5.4.
//
// Ownership: the manager also owns the partner's Modbus interface
// (internal/direktvermarkter.Server) - it binds it to the tunnel address
// while the tunnel is up and stops it when the tunnel goes away. The agent
// feeds measured values in (SetValues) and reads the partner limit out
// (Grenze); everything partner-shaped lives here.
//
// The tunnel belongs to the SYSTEM, not the program (§5.4 "Neustart und
// Update", PS-D8): OpenVPN runs daemonized with a pidfile, so a program
// update or crash leaves the tunnel standing; the restarted program adopts
// the running daemon through the pidfile and the management socket. At boot
// the init script edge-light/openwrt/files/etc/init.d/vp-vermarkter starts
// the same daemon from the same written configuration before the program is
// up.
//
// Security (concept §8): the partner reaches nothing but the one Modbus port
// of the box - never the customer network, the devices, SSH or the local
// page. No pushed route, no redirect-gateway, no DNS is ever accepted
// (route-nopull plus explicit pull-filter ignores); the OpenVPN process
// drops to an unprivileged user after the start and may execute no scripts
// (script-security 0). No key, no password and no file content is ever
// logged - log lines carry file NAMES and error CLASSES only.
package vermarktertunnel

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// The delivery contract with the cloud (task vp-dv-zustellung; until it
// lands, the workshop or a technician places the same files by hand):
//
//	<dir>/anschluss.json     which partner is connected and the site's
//	                         reference power - see Anschluss
//	<dir>/zugang/zugang.json the non-secret access facts - see Zugang
//	<dir>/zugang/ca.pem           the partner CA certificate
//	<dir>/zugang/zertifikat.pem   the plant's client certificate
//	<dir>/zugang/schluessel.pem   the plant's private key (0600, root)
//	<dir>/zugang/tls.key          the shared TLS key, only when
//	                              zugang.json names tls_crypt or tls_auth
//
// <dir> is /etc/vp-edge-light/vermarkter on the Mango (flash, survives
// sysupgrade with the rest of /etc/vp-edge-light). Removing anschluss.json
// withdraws the whole connection ("Ein leeres Profil zieht alles zurück"):
// the manager stops the tunnel, removes its firewall opening and stops the
// interface on its next tick.
const (
	AnschlussDatei     = "anschluss.json"
	ZugangOrdner       = "zugang"
	ZugangDatei        = "zugang.json"
	CADatei            = "ca.pem"
	ZertifikatDatei    = "zertifikat.pem"
	SchluesselDatei    = "schluessel.pem"
	TLSSchluesselDatei = "tls.key"
)

// maxPEMBytes bounds every delivered key/certificate file: real material is
// a few KiB, and a runaway file must never be read into RAM whole.
const maxPEMBytes = 64 * 1024

// Anschluss is anschluss.json: the delivered choice of partner plus the
// site's reference power. The partner's register map, word order and rules
// come from the EMBEDDED catalog (internal/direktvermarkter), never from a
// delivered file - the delivery only picks which embedded profile runs.
type Anschluss struct {
	// Partner is the catalog id (e.g. "luox").
	Partner string `json:"partner"`
	// ReferenzWp is the plant's reference power in watts for the percent
	// set-point and the input register referenz_w. WHAT it means
	// (installed module power, F6 open) is the delivering cloud's business -
	// the box only uses the number.
	ReferenzWp float64 `json:"referenz_wp"`
}

// Gegenstelle is the one peer the box dials - taken from the partner's
// delivered configuration by the cloud's intake, never more than this.
type Gegenstelle struct {
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Protokoll string `json:"protokoll"` // "udp" or "tcp"
}

// Zugang is zugang/zugang.json: the non-secret facts of the access material.
// The secrets live beside it as PEM files and are NEVER carried through this
// struct, so no marshal/log path can ever see them.
type Zugang struct {
	Gegenstelle   Gegenstelle `json:"gegenstelle"`
	TLSSchluessel string      `json:"tls_schluessel"` // "tls_crypt", "tls_auth" or "keine"
	GueltigBis    time.Time   `json:"gueltig_bis"`
	Fingerabdruck string      `json:"fingerabdruck"`
}

// hostOK keeps the peer host to DNS-name/IP characters. This is a SECURITY
// bound, not pedantry: the host is written into the generated OpenVPN
// configuration, and a value with whitespace or quotes could smuggle extra
// directives into it.
var hostOK = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.:-]*$`)

// LadeAnschluss reads <dir>/anschluss.json. ok=false (with err=nil) when the
// file does not exist - the ordinary "ohne_profil" state, not an error.
func LadeAnschluss(dir string) (Anschluss, bool, error) {
	raw, err := os.ReadFile(filepath.Join(dir, AnschlussDatei))
	if os.IsNotExist(err) {
		return Anschluss{}, false, nil
	}
	if err != nil {
		return Anschluss{}, false, fmt.Errorf("anschluss.json: %w", err)
	}
	var a Anschluss
	if err := json.Unmarshal(raw, &a); err != nil {
		return Anschluss{}, false, fmt.Errorf("anschluss.json: %w", err)
	}
	if a.Partner == "" {
		return Anschluss{}, false, fmt.Errorf("anschluss.json: partner fehlt")
	}
	if !(a.ReferenzWp > 0) {
		// Without a reference the percent set-point has no meaning in kW. An
		// invented reference could curtail the wrong amount, so the whole
		// Anschluss is refused until the delivery carries one.
		return Anschluss{}, false, fmt.Errorf("anschluss.json: referenz_wp fehlt oder ist nicht positiv")
	}
	return a, true, nil
}

// LadeZugang reads and validates <dir>/zugang. ok=false (err=nil) when no
// access has been delivered yet ("ohne_zugang"); err non-nil when material
// is there but unusable. Validation never puts file CONTENT into an error.
func LadeZugang(dir string) (Zugang, bool, error) {
	zdir := filepath.Join(dir, ZugangOrdner)
	raw, err := os.ReadFile(filepath.Join(zdir, ZugangDatei))
	if os.IsNotExist(err) {
		return Zugang{}, false, nil
	}
	if err != nil {
		return Zugang{}, false, fmt.Errorf("zugang.json: %w", err)
	}
	var z Zugang
	if err := json.Unmarshal(raw, &z); err != nil {
		return Zugang{}, false, fmt.Errorf("zugang.json: %w", err)
	}
	if !hostOK.MatchString(z.Gegenstelle.Host) {
		return Zugang{}, false, fmt.Errorf("zugang.json: gegenstelle.host ist keine Adresse")
	}
	if z.Gegenstelle.Port < 1 || z.Gegenstelle.Port > 65535 {
		return Zugang{}, false, fmt.Errorf("zugang.json: gegenstelle.port %d außerhalb 1-65535", z.Gegenstelle.Port)
	}
	switch z.Gegenstelle.Protokoll {
	case "udp", "tcp":
	default:
		return Zugang{}, false, fmt.Errorf("zugang.json: protokoll %q (udp oder tcp)", z.Gegenstelle.Protokoll)
	}
	switch z.TLSSchluessel {
	case "tls_crypt", "tls_auth", "keine":
	default:
		return Zugang{}, false, fmt.Errorf("zugang.json: tls_schluessel %q (tls_crypt, tls_auth oder keine)", z.TLSSchluessel)
	}
	brauchen := []string{CADatei, ZertifikatDatei, SchluesselDatei}
	if z.TLSSchluessel != "keine" {
		brauchen = append(brauchen, TLSSchluesselDatei)
	}
	for _, name := range brauchen {
		if err := pemPlausibel(filepath.Join(zdir, name)); err != nil {
			return Zugang{}, false, fmt.Errorf("zugang/%s: %w", name, err)
		}
	}
	return z, true, nil
}

// pemPlausibel checks a delivered key/certificate file is present, bounded
// and PEM-shaped - WITHOUT ever returning its content.
func pemPlausibel(path string) error {
	fi, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("fehlt")
	}
	if fi.Size() == 0 || fi.Size() > maxPEMBytes {
		return fmt.Errorf("%d Bytes - außerhalb 1..%d", fi.Size(), maxPEMBytes)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("nicht lesbar")
	}
	if !strings.Contains(string(raw), "-----BEGIN ") {
		return fmt.Errorf("kein PEM")
	}
	return nil
}

// Abgelaufen reports whether the access material's validity has passed -
// the "zugang_ungueltig" state of §5.4.
func (z Zugang) Abgelaufen(now time.Time) bool {
	return !z.GueltigBis.IsZero() && now.After(z.GueltigBis)
}
