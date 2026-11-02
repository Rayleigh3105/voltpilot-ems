package bruecke

import (
	"archive/tar"
	"bytes"
	"io"
	"io/fs"
	"net/netip"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"testing"
)

func parameter() Parameter {
	return Parameter{
		Netz:              "wlan0",
		Werkstatt:         "eth0",
		WerkstattAdressen: []netip.Prefix{netip.MustParsePrefix("192.168.8.2/24"), netip.MustParsePrefix("192.168.1.2/24"), netip.MustParsePrefix("10.213.0.2/24")},
		Ziele:             []netip.AddrPort{netip.MustParseAddrPort("192.168.8.1:22"), netip.MustParseAddrPort("10.213.0.1:8484")},
		SSHQuellen:        []netip.Prefix{netip.MustParsePrefix("192.168.178.241/32")},
		AuthorizedKeys:    []string{"restrict ssh-ed25519 AAAA a", "restrict ssh-ed25519 AAAA b", "restrict ssh-ed25519 AAAA c"},
	}
}

func TestPaketGleichBleibtGleich(t *testing.T) {
	a, err := Baue(parameter())
	if err != nil {
		t.Fatal(err)
	}
	b, _ := Baue(parameter())
	if a.Fassung != b.Fassung || a.Sha256 != b.Sha256 || !bytes.Equal(a.Tar, b.Tar) {
		t.Fatal("gleiche Eingabe, anderes Paket")
	}
	p := parameter()
	p.SSHQuellen = append(p.SSHQuellen, netip.MustParsePrefix("192.168.178.242/32"))
	c, _ := Baue(p)
	if c.Fassung == a.Fassung {
		t.Fatal("andere Parameter, gleiche Fassung")
	}
	if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(a.Fassung) {
		t.Fatalf("Fassung %q", a.Fassung)
	}
	tr := tar.NewReader(bytes.NewReader(a.Tar))
	var namen []string
	modi := map[string]int64{}
	inhalt := map[string]string{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		d, _ := io.ReadAll(tr)
		namen = append(namen, h.Name)
		modi[h.Name] = h.Mode
		inhalt[h.Name] = string(d)
	}
	sort.Strings(namen)
	want := "authorized_keys bin/vp-werkbank-pflege einrichten.sh netz/90-werkbank.conf netz/vp-werkstatt.nmconnection nftables/werkbank.nft parameter.env pruefen.sh sbin/vp-werkbank-einrichten sbin/vp-werkbank-status ssh/10-werkbank.conf sudoers/vp-werkbank sysctl/90-werkbank.conf systemd/vp-werkbank-firewall.service"
	if strings.Join(namen, " ") != want {
		t.Fatalf("Inhalt\n got %s\nwant %s", strings.Join(namen, " "), want)
	}
	if modi["einrichten.sh"] != 0o755 || modi["sbin/vp-werkbank-status"] != 0o755 || modi["parameter.env"] != 0o644 {
		t.Fatalf("Modi %v", modi)
	}
	pe := inhalt["parameter.env"]
	for _, z := range []string{"FASSUNG=" + a.Fassung, "NETZ=wlan0", "WERKSTATT=eth0", "WERKSTATT_ADRESSEN=192.168.8.2/24 192.168.1.2/24 10.213.0.2/24", "ZIELE=192.168.8.1:22 10.213.0.1:8484", "SSH_QUELLEN=192.168.178.241/32"} {
		if !strings.Contains(pe, z+"\n") {
			t.Errorf("parameter.env ohne %q:\n%s", z, pe)
		}
	}
}

func TestParameterGeprueft(t *testing.T) {
	faelle := map[string]func(*Parameter){
		"gleich":        func(p *Parameter) { p.Werkstatt = p.Netz },
		"name":          func(p *Parameter) { p.Netz = "wlan0;rm" },
		"ziel fremd":    func(p *Parameter) { p.Ziele = append(p.Ziele, netip.MustParseAddrPort("192.168.0.1:22")) },
		"quelle /8":     func(p *Parameter) { p.SSHQuellen = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")} },
		"zwei keys":     func(p *Parameter) { p.AuthorizedKeys = p.AuthorizedKeys[:2] },
		"mehrzeilig":    func(p *Parameter) { p.AuthorizedKeys[0] = "a\nb" },
		"/16 anschluss": func(p *Parameter) { p.WerkstattAdressen[0] = netip.MustParsePrefix("192.168.8.2/16") },
	}
	for name, f := range faelle {
		p := parameter()
		p.AuthorizedKeys = append([]string(nil), p.AuthorizedKeys...)
		p.WerkstattAdressen = append([]netip.Prefix(nil), p.WerkstattAdressen...)
		f(&p)
		if _, err := Baue(p); err == nil {
			t.Errorf("%s: angenommen", name)
		}
	}
}

// Jeder Platzhalter in den Vorlagen wird von einrichten.sh ersetzt.
func TestPlatzhalterBekannt(t *testing.T) {
	bekannt := map[string]bool{"@NETZ@": true, "@WERKSTATT@": true, "@SSH_QUELLEN@": true, "@WERKSTATT_NETZE@": true, "@ZIELE@": true, "@ADRESSEN@": true}
	ein, _ := dateien.ReadFile("einrichten.sh")
	re := regexp.MustCompile(`@[A-Z_]+@`)
	_ = fs.WalkDir(dateien, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || strings.HasSuffix(p, ".sh") || strings.HasPrefix(p, "bin/") || strings.HasPrefix(p, "sbin/") {
			return err
		}
		b, _ := dateien.ReadFile(p)
		for _, m := range re.FindAllString(string(b), -1) {
			if !bekannt[m] {
				t.Errorf("%s: unbekannter Platzhalter %s", p, m)
			}
			if !strings.Contains(string(ein), m) {
				t.Errorf("%s: %s wird in einrichten.sh nicht ersetzt", p, m)
			}
		}
		return nil
	})
}

// Die Skripte sind gültiges sh (und, wenn shellcheck da ist, sauber).
func TestSkripteSyntax(t *testing.T) {
	skripte := []string{"einrichten.sh", "pruefen.sh", "bin/vp-werkbank-pflege", "sbin/vp-werkbank-status", "sbin/vp-werkbank-einrichten"}
	for _, s := range skripte {
		if out, err := exec.Command("sh", "-n", s).CombinedOutput(); err != nil {
			t.Errorf("sh -n %s: %v\n%s", s, err, out)
		}
	}
	if _, err := exec.LookPath("shellcheck"); err != nil {
		t.Log("shellcheck fehlt: nur sh -n geprüft")
		return
	}
	args := append([]string{"-s", "sh", "-S", "warning"}, skripte...)
	if out, err := exec.Command("shellcheck", args...).CombinedOutput(); err != nil {
		t.Errorf("shellcheck: %v\n%s", err, out)
	}
}
