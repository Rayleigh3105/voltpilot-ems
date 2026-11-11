// Package bruecke bündelt die Dateien der Werkbank-Brücke (WI-13 B: ein
// Raspberry Pi im WLAN, seine Netzwerkbuchse ist der Werkstatt-Anschluss).
//
// Auf der Brücke läuft kein eigenes Programm, nur Konfiguration: Netz,
// Firewall und Durchleitung, SSH mit drei Schlüsseln des Dienstes, ein
// Status-Befehl. Der Dienst baut aus diesen Dateien und den Parametern seiner
// Konfiguration ein Paket (tar) und spielt es auf (siehe README.md). Die
// Fassung des Pakets steht danach in /etc/vp-werkbank/fassung; weicht sie
// von der Fassung ab, die der Dienst gerade bauen würde, spielt er neu auf.
package bruecke

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net/netip"
	"regexp"
	"sort"
	"strings"
	"time"
)

//go:embed einrichten.sh pruefen.sh bin sbin nftables sysctl ssh netz systemd sudoers
var dateien embed.FS

// Parameter der Brücke. Jeder Wert wird hier geprüft und auf der Brücke von
// einrichten.sh noch einmal.
type Parameter struct {
	Netz              string           // Schnittstelle ins Netz der Werkbank (WLAN), "wlan0"
	Werkstatt         string           // Werkstatt-Anschluss, "eth0"
	WerkstattAdressen []netip.Prefix   // Adressen der Brücke am Werkstatt-Anschluss
	Ziele             []netip.AddrPort // wohin die Weiterleitung darf
	SSHQuellen        []netip.Prefix   // von wo SSH auf die Brücke darf (Cluster, Admin)
	AuthorizedKeys    []string         // Zeilen für den Benutzer werkstatt
}

var schnittstelleMuster = regexp.MustCompile(`^[a-z][a-z0-9]{0,14}$`)

// Pruefe prüft die Parameter.
func (p Parameter) Pruefe() error {
	var f []string
	if !schnittstelleMuster.MatchString(p.Netz) {
		f = append(f, fmt.Sprintf("Netz-Schnittstelle %q ungültig", p.Netz))
	}
	if !schnittstelleMuster.MatchString(p.Werkstatt) {
		f = append(f, fmt.Sprintf("Werkstatt-Schnittstelle %q ungültig", p.Werkstatt))
	}
	if p.Netz == p.Werkstatt {
		f = append(f, "Netz und Werkstatt-Anschluss sind dieselbe Schnittstelle")
	}
	if len(p.WerkstattAdressen) == 0 {
		f = append(f, "keine Adresse am Werkstatt-Anschluss")
	}
	for _, a := range p.WerkstattAdressen {
		if !a.Addr().Is4() || a.Bits() != 24 {
			f = append(f, fmt.Sprintf("Werkstatt-Adresse %s: nur IPv4 /24", a))
		}
	}
	if len(p.Ziele) == 0 {
		f = append(f, "keine Ziele für die Weiterleitung")
	}
	for _, z := range p.Ziele {
		if !z.Addr().Is4() || !imWerkstattNetz(p.WerkstattAdressen, z.Addr()) {
			f = append(f, fmt.Sprintf("Ziel %s liegt nicht am Werkstatt-Anschluss", z))
		}
	}
	if len(p.SSHQuellen) == 0 {
		f = append(f, "keine SSH-Quelle (Cluster)")
	}
	for _, q := range p.SSHQuellen {
		if !q.Addr().Is4() || q.Bits() < 16 {
			f = append(f, fmt.Sprintf("SSH-Quelle %s: IPv4, höchstens /16", q))
		}
	}
	if len(p.AuthorizedKeys) < 3 {
		f = append(f, "authorized_keys braucht die drei Schlüssel des Dienstes")
	}
	for _, z := range p.AuthorizedKeys {
		if strings.ContainsAny(z, "\n\r") || strings.TrimSpace(z) == "" {
			f = append(f, "eine Zeile in authorized_keys ist leer oder mehrzeilig")
		}
	}
	if len(f) > 0 {
		return fmt.Errorf("Parameter der Brücke: %s", strings.Join(f, "; "))
	}
	return nil
}

func imWerkstattNetz(netze []netip.Prefix, a netip.Addr) bool {
	for _, n := range netze {
		if n.Masked().Contains(a) {
			return true
		}
	}
	return false
}

func liste[T fmt.Stringer](xs []T, sep string) string {
	s := make([]string, len(xs))
	for i, x := range xs {
		s[i] = x.String()
	}
	return strings.Join(s, sep)
}

func (p Parameter) env(fassung string) string {
	var b strings.Builder
	b.WriteString("# Parameter der Werkbank-Brücke, vom Werkstatt-Dienst erzeugt. Nicht von Hand ändern.\n")
	if fassung != "" {
		fmt.Fprintf(&b, "FASSUNG=%s\n", fassung)
	}
	fmt.Fprintf(&b, "NETZ=%s\n", p.Netz)
	fmt.Fprintf(&b, "WERKSTATT=%s\n", p.Werkstatt)
	fmt.Fprintf(&b, "WERKSTATT_ADRESSEN=%s\n", liste(p.WerkstattAdressen, " "))
	fmt.Fprintf(&b, "ZIELE=%s\n", liste(p.Ziele, " "))
	fmt.Fprintf(&b, "SSH_QUELLEN=%s\n", liste(p.SSHQuellen, " "))
	return b.String()
}

func (p Parameter) authorizedKeys() string {
	return strings.Join(p.AuthorizedKeys, "\n") + "\n"
}

type datei struct {
	name   string
	inhalt []byte
	modus  int64
}

func eingebettet() ([]datei, error) {
	var out []datei
	err := fs.WalkDir(dateien, ".", func(pfad string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := dateien.ReadFile(pfad)
		if err != nil {
			return err
		}
		modus := int64(0o644)
		if strings.HasSuffix(pfad, ".sh") || strings.HasPrefix(pfad, "bin/") || strings.HasPrefix(pfad, "sbin/") {
			modus = 0o755
		}
		out = append(out, datei{name: pfad, inhalt: b, modus: modus})
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out, err
}

// Paket ist ein fertiges Paket für die Brücke.
type Paket struct {
	Fassung string // steht danach auf der Brücke in /etc/vp-werkbank/fassung
	Tar     []byte
	Sha256  string // Prüfsumme des tar, für die Übertragung
}

// Baue baut das Paket. Gleiche Dateien und Parameter ergeben dieselbe
// Fassung und dasselbe tar, Byte für Byte.
func Baue(p Parameter) (Paket, error) {
	if err := p.Pruefe(); err != nil {
		return Paket{}, err
	}
	ds, err := eingebettet()
	if err != nil {
		return Paket{}, err
	}
	h := sha256.New()
	for _, d := range ds {
		fmt.Fprintf(h, "%s\x00%d\x00", d.name, len(d.inhalt))
		h.Write(d.inhalt)
	}
	fmt.Fprintf(h, "parameter.env\x00%s\x00authorized_keys\x00%s", p.env(""), p.authorizedKeys())
	fassung := hex.EncodeToString(h.Sum(nil))[:16]

	ds = append(ds,
		datei{name: "parameter.env", inhalt: []byte(p.env(fassung)), modus: 0o644},
		datei{name: "authorized_keys", inhalt: []byte(p.authorizedKeys()), modus: 0o644},
	)
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	zeit := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, d := range ds {
		if err := tw.WriteHeader(&tar.Header{Name: d.name, Mode: d.modus, Size: int64(len(d.inhalt)), ModTime: zeit, Typeflag: tar.TypeReg, Format: tar.FormatUSTAR}); err != nil {
			return Paket{}, err
		}
		if _, err := tw.Write(d.inhalt); err != nil {
			return Paket{}, err
		}
	}
	if err := tw.Close(); err != nil {
		return Paket{}, err
	}
	summe := sha256.Sum256(buf.Bytes())
	return Paket{Fassung: fassung, Tar: buf.Bytes(), Sha256: hex.EncodeToString(summe[:])}, nil
}
