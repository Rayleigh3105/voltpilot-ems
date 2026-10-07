// Package system ist die Befehlsschicht: WireGuard über `wg`, die Firewall
// über `nft`. Alles läuft über einen Runner, damit Tests die Schicht sauber
// ersetzen können; die Integrationsprobe (test/integration.sh) fährt sie
// gegen echtes WireGuard und nftables.
//
// Der private Schlüssel des Servers wird nie gelesen: `wg show … dump` trüge
// ihn in der ersten Zeile, deshalb nur `allowed-ips` und `latest-handshakes`.
package system

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/netip"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Runner führt einen Befehl aus.
type Runner interface {
	Run(ctx context.Context, name string, args []string, stdin []byte) ([]byte, error)
}

// Exec ist der echte Runner.
type Exec struct{}

// Run führt den Befehl aus; stderr landet in der Fehlermeldung.
func (Exec) Run(ctx context.Context, name string, args []string, stdin []byte) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var out, errOut bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		return out.Bytes(), &Fehler{Befehl: name + " " + strings.Join(args, " "), Ausgabe: strings.TrimSpace(errOut.String()), Err: err}
	}
	return out.Bytes(), nil
}

// Fehler ist ein fehlgeschlagener Befehl.
type Fehler struct {
	Befehl  string
	Ausgabe string
	Err     error
}

func (f *Fehler) Error() string {
	if f.Ausgabe == "" {
		return f.Befehl + ": " + f.Err.Error()
	}
	return f.Befehl + ": " + f.Err.Error() + ": " + f.Ausgabe
}

func (f *Fehler) Unwrap() error { return f.Err }

// WireGuard verwaltet die Peers einer Schnittstelle.
type WireGuard struct {
	R             Runner
	Schnittstelle string
}

// Peers liest öffentliche Schlüssel und erlaubte Adressen.
func (w WireGuard) Peers(ctx context.Context) (map[string][]netip.Prefix, error) {
	out, err := w.R.Run(ctx, "wg", []string{"show", w.Schnittstelle, "allowed-ips"}, nil)
	if err != nil {
		return nil, err
	}
	return LiesAllowedIPs(out)
}

// LiesAllowedIPs zerlegt die Ausgabe von `wg show <if> allowed-ips`:
// je Zeile Schlüssel, Tab, Adressen durch Leerzeichen (oder "(none)").
func LiesAllowedIPs(out []byte) (map[string][]netip.Prefix, error) {
	peers := map[string][]netip.Prefix{}
	for _, zeile := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.TrimSpace(zeile) == "" {
			continue
		}
		teile := strings.Fields(zeile)
		key := teile[0]
		var adressen []netip.Prefix
		for _, a := range teile[1:] {
			if a == "(none)" {
				continue
			}
			p, err := netip.ParsePrefix(a)
			if err != nil {
				return nil, fmt.Errorf("wg allowed-ips: %q: %w", zeile, err)
			}
			adressen = append(adressen, p)
		}
		peers[key] = adressen
	}
	return peers, nil
}

// Handshakes liest den letzten Handshake je Peer (Null-Zeit = nie).
func (w WireGuard) Handshakes(ctx context.Context) (map[string]time.Time, error) {
	out, err := w.R.Run(ctx, "wg", []string{"show", w.Schnittstelle, "latest-handshakes"}, nil)
	if err != nil {
		return nil, err
	}
	hs := map[string]time.Time{}
	for _, zeile := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		teile := strings.Fields(zeile)
		if len(teile) != 2 {
			continue
		}
		sek, err := strconv.ParseInt(teile[1], 10, 64)
		if err != nil {
			continue
		}
		if sek == 0 {
			hs[teile[0]] = time.Time{}
		} else {
			hs[teile[0]] = time.Unix(sek, 0)
		}
	}
	return hs, nil
}

// Setze legt einen Peer an bzw. setzt seine erlaubte Adresse (genau eine /32).
func (w WireGuard) Setze(ctx context.Context, key string, adresse netip.Addr) error {
	_, err := w.R.Run(ctx, "wg", []string{"set", w.Schnittstelle, "peer", key, "allowed-ips",
		netip.PrefixFrom(adresse, 32).String()}, nil)
	return err
}

// Entferne entfernt einen Peer.
func (w WireGuard) Entferne(ctx context.Context, key string) error {
	_, err := w.R.Run(ctx, "wg", []string{"set", w.Schnittstelle, "peer", key, "remove"}, nil)
	return err
}

// IstNichtVorhanden erkennt den nft-Fehler für ein fehlendes Objekt (ein
// Element, das in der Zwischenzeit von selbst abgelaufen ist).
func IstNichtVorhanden(err error) bool {
	var f *Fehler
	return errors.As(err, &f) && strings.Contains(f.Ausgabe, "No such file or directory")
}
