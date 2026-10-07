package system

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/abgleich"
)

// aufzeichner ist ein Runner, der Aufrufe festhält und vorbereitete
// Antworten liefert.
type aufzeichner struct {
	aufrufe []string
	stdin   []string
	antwort func(befehl string) ([]byte, error)
}

func (a *aufzeichner) Run(_ context.Context, name string, args []string, stdin []byte) ([]byte, error) {
	befehl := name + " " + strings.Join(args, " ")
	a.aufrufe = append(a.aufrufe, befehl)
	a.stdin = append(a.stdin, string(stdin))
	if a.antwort != nil {
		return a.antwort(befehl)
	}
	return nil, nil
}

func regeln() Regeln {
	return Regeln{Tabelle: "voltpilot_wartung", Schnittstelle: "wg-wartung",
		BoxNetz: netip.MustParsePrefix("10.10.16.0/20"), TechnikerNetz: netip.MustParsePrefix("10.10.32.0/24"),
		Ports: []int{2222, 8484}, MaxFenster: 24 * time.Hour, VerbindungenProtokollieren: true}
}

func TestLiesAllowedIPs(t *testing.T) {
	out := "jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=\t10.10.16.2/32\n" +
		"SBsk0U9z6BgB/U8nb+L9PdK/46p7mBvWRQe8I0Vg3C0=\t(none)\n" +
		"FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=\t10.10.32.2/32 10.10.32.3/32\n"
	peers, err := LiesAllowedIPs([]byte(out))
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 3 || len(peers["SBsk0U9z6BgB/U8nb+L9PdK/46p7mBvWRQe8I0Vg3C0="]) != 0 ||
		len(peers["FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y="]) != 2 {
		t.Fatalf("%v", peers)
	}
	if leer, err := LiesAllowedIPs([]byte("")); err != nil || len(leer) != 0 {
		t.Fatalf("leere Schnittstelle: %v %v", leer, err)
	}
}

// Ausgaben echter nft-Versionen: 1.0.6 (Debian 12) mit und ohne eigene
// Ablaufzeit, 1.0.9 (Alpine 3.20) - beide in der Integrationsprobe gesehen.
func TestLiesFensterAusNftJson(t *testing.T) {
	out := `{"nftables": [{"metainfo": {"version": "1.0.6", "json_schema_version": 1}}, {"set": {"family": "inet", "name": "fenster", "table": "voltpilot_wartung", "type": ["ipv4_addr", "ipv4_addr"], "handle": 2, "comment": "x", "flags": ["timeout"], "timeout": 86400, "elem": [{"elem": {"val": {"concat": ["10.10.32.2", "10.10.16.2"]}, "timeout": 3600, "expires": 3550}}, {"elem": {"val": {"concat": ["10.10.32.3", "10.10.16.3"]}, "expires": 86399}}]}}]}`
	f, err := LiesFenster([]byte(out))
	if err != nil {
		t.Fatal(err)
	}
	if f[abgleich.Paar{Techniker: netip.MustParseAddr("10.10.32.2"), Box: netip.MustParseAddr("10.10.16.2")}] != 3550*time.Second {
		t.Fatalf("%v", f)
	}
	if len(f) != 2 {
		t.Fatalf("%v", f)
	}
	ohne := `{"nftables": [{"set": {"name": "fenster", "elem": [{"concat": ["10.10.32.2", "10.10.16.2"]}]}}]}`
	if f, err := LiesFenster([]byte(ohne)); err != nil || len(f) != 1 {
		t.Fatalf("%v %v", f, err)
	}
	leer := `{"nftables": [{"set": {"name": "fenster", "flags": ["timeout"]}}]}`
	if f, err := LiesFenster([]byte(leer)); err != nil || len(f) != 0 {
		t.Fatalf("%v %v", f, err)
	}
}

func TestBasisRegelnSindEngGeschnitten(t *testing.T) {
	b := regeln().Basis()
	for _, muss := range []string{
		"table inet voltpilot_wartung {",
		"type ipv4_addr . ipv4_addr",
		"flags timeout",
		"timeout 86400s",
		`iifname "wg-wartung" oifname "wg-wartung" ip saddr 10.10.32.0/24 ip daddr 10.10.16.0/20 ip saddr . ip daddr @fenster tcp dport { 2222, 8484 } ct state new log prefix "vp-wartung neu: " level info accept`,
		`ip saddr 10.10.16.0/20 ip daddr 10.10.32.0/24 ip daddr . ip saddr @fenster ct state established,related accept`,
		"icmp type echo-request accept",
		"counter drop",
		"type filter hook forward priority filter; policy accept;",
		"type filter hook input priority filter; policy accept;",
	} {
		if !strings.Contains(b, muss) {
			t.Errorf("Basis enthält nicht %q:\n%s", muss, b)
		}
	}
	// Keine Regel lässt Box -> Box oder Box -> neue Verbindung zu.
	if strings.Contains(b, "ip saddr 10.10.16.0/20 ip daddr 10.10.16.0/20") {
		t.Error("Box -> Box darf nirgends erlaubt sein")
	}
	r := regeln()
	r.VerbindungenProtokollieren = false
	if strings.Contains(r.Basis(), "log prefix") {
		t.Error("ohne Protokoll kein log")
	}
	r.Ports = []int{2222}
	if !strings.Contains(r.Basis(), "tcp dport 2222 ct state new accept") {
		t.Errorf("ein Port: %s", r.Basis())
	}
	if regeln().Kennung() == r.Kennung() {
		t.Error("eine andere Basis braucht eine andere Kennung")
	}
}

func TestSichereBasisLaedtNurBeiAbweichung(t *testing.T) {
	r := regeln()
	stimmt := `{"nftables": [{"table": {"family": "inet", "name": "voltpilot_wartung"}},` +
		`{"set": {"name": "fenster", "comment": "` + r.Kennung() + `"}},` +
		`{"chain": {"name": "weiterleiten"}}, {"chain": {"name": "wartung"}},` +
		`{"chain": {"name": "eingang"}}, {"chain": {"name": "eingang_wartung"}}]}`
	a := &aufzeichner{antwort: func(b string) ([]byte, error) {
		if strings.HasPrefix(b, "nft -j list table") {
			return []byte(stimmt), nil
		}
		return nil, nil
	}}
	neu, err := Nft{R: a, Regeln: r}.SichereBasis(context.Background())
	if err != nil || neu || len(a.aufrufe) != 1 {
		t.Fatalf("stimmt: neu=%v err=%v %v", neu, err, a.aufrufe)
	}

	// Fehlt die Tabelle (nft meldet "No such file or directory"), wird sie in
	// einer Transaktion angelegt - "table" vor "delete", damit das Löschen
	// auch dann gelingt, wenn sie fehlt.
	a = &aufzeichner{antwort: func(b string) ([]byte, error) {
		if strings.HasPrefix(b, "nft -j list table") {
			return nil, &Fehler{Befehl: b, Ausgabe: "Error: No such file or directory", Err: errors.New("exit status 1")}
		}
		return nil, nil
	}}
	neu, err = Nft{R: a, Regeln: r}.SichereBasis(context.Background())
	if err != nil || !neu || len(a.aufrufe) != 2 || a.aufrufe[1] != "nft -f -" {
		t.Fatalf("fehlt: neu=%v err=%v %v", neu, err, a.aufrufe)
	}
	if !strings.HasPrefix(a.stdin[1], "table inet voltpilot_wartung\ndelete table inet voltpilot_wartung\ntable inet voltpilot_wartung {") {
		t.Fatalf("Skript: %s", a.stdin[1])
	}

	// Ein anderer Kommentar (alte Basis) oder eine fehlende Kette: neu laden.
	a = &aufzeichner{antwort: func(b string) ([]byte, error) {
		if strings.HasPrefix(b, "nft -j list table") {
			return []byte(strings.Replace(stimmt, `{"chain": {"name": "wartung"}},`, "", 1)), nil
		}
		return nil, nil
	}}
	if neu, _ := (Nft{R: a, Regeln: r}).SichereBasis(context.Background()); !neu {
		t.Fatal("fehlende Kette muss neu laden")
	}
}

func TestFensterBefehle(t *testing.T) {
	a := &aufzeichner{}
	n := Nft{R: a, Regeln: regeln()}
	paar := abgleich.Paar{Techniker: netip.MustParseAddr("10.10.32.2"), Box: netip.MustParseAddr("10.10.16.2")}
	if err := n.FuegeFensterHinzu(context.Background(), []abgleich.FensterSetzen{{Paar: paar, Timeout: 3599500 * time.Millisecond}}); err != nil {
		t.Fatal(err)
	}
	if a.stdin[0] != "add element inet voltpilot_wartung fenster { 10.10.32.2 . 10.10.16.2 timeout 3599s }\n" {
		t.Fatalf("%q", a.stdin[0])
	}
	// Ein inzwischen von selbst abgelaufenes Element zu löschen ist kein Fehler.
	a = &aufzeichner{antwort: func(string) ([]byte, error) {
		return nil, &Fehler{Ausgabe: "Error: Could not process rule: No such file or directory", Err: errors.New("exit status 1")}
	}}
	if err := (Nft{R: a, Regeln: regeln()}).EntferneFenster(context.Background(), paar); err != nil {
		t.Fatal(err)
	}
	if a.aufrufe[0] != "nft delete element inet voltpilot_wartung fenster { 10.10.32.2 . 10.10.16.2 }" {
		t.Fatalf("%q", a.aufrufe[0])
	}
}

func TestWireGuardBefehleBeruehrenNieDenPrivatenSchluessel(t *testing.T) {
	a := &aufzeichner{}
	w := WireGuard{R: a, Schnittstelle: "wg-wartung"}
	ctx := context.Background()
	_ = w.Setze(ctx, "jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=", netip.MustParseAddr("10.10.16.2"))
	_ = w.Entferne(ctx, "jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=")
	_, _ = w.Peers(ctx)
	_, _ = w.Handshakes(ctx)
	want := []string{
		"wg set wg-wartung peer jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM= allowed-ips 10.10.16.2/32",
		"wg set wg-wartung peer jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM= remove",
		"wg show wg-wartung allowed-ips",
		"wg show wg-wartung latest-handshakes",
	}
	for i, w := range want {
		if a.aufrufe[i] != w {
			t.Errorf("Aufruf %d: %q, erwartet %q", i, a.aufrufe[i], w)
		}
	}
	for _, b := range a.aufrufe {
		if strings.Contains(b, "dump") || strings.Contains(b, "private") {
			t.Errorf("Befehl liest den privaten Schlüssel: %s", b)
		}
	}
}
