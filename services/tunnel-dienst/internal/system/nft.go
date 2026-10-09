package system

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/abgleich"
)

// Regeln beschreibt die Server-Firewall, aus der die Basis erzeugt wird.
type Regeln struct {
	Tabelle       string
	Schnittstelle string
	BoxNetz       netip.Prefix
	TechnikerNetz netip.Prefix
	// Ports: TCP-Ports, die ein Techniker im offenen Fenster auf der Box erreicht.
	Ports []int
	// MaxFenster ist zugleich die Vorgabe-Ablaufzeit der Menge: kein Element
	// kann länger leben, auch nicht eines ohne eigene Ablaufzeit.
	MaxFenster time.Duration
	// VerbindungenProtokollieren: neue Techniker-Verbindungen ins Kernel-Log.
	VerbindungenProtokollieren bool
}

// Menge heißt die nft-Menge der offenen Fenster.
const Menge = "fenster"

// Ketten, die zur Basis gehören (geprüft bei jedem Lauf).
var basisKetten = []string{"weiterleiten", "wartung", "eingang", "eingang_wartung"}

func (r Regeln) ports() string {
	if len(r.Ports) == 1 {
		return strconv.Itoa(r.Ports[0])
	}
	teile := make([]string, len(r.Ports))
	for i, p := range r.Ports {
		teile[i] = strconv.Itoa(p)
	}
	return "{ " + strings.Join(teile, ", ") + " }"
}

func (r Regeln) koerper() string {
	wg := strconv.Quote(r.Schnittstelle)
	tech := r.TechnikerNetz.String()
	box := r.BoxNetz.String()
	paar := "iifname " + wg + " oifname " + wg
	neu := "ct state new accept"
	if r.VerbindungenProtokollieren {
		neu = `ct state new log prefix "vp-wartung neu: " level info accept`
	}
	var b strings.Builder
	fmt.Fprintf(&b, "\tchain weiterleiten {\n")
	fmt.Fprintf(&b, "\t\ttype filter hook forward priority filter; policy accept;\n")
	fmt.Fprintf(&b, "\t\tiifname %s jump wartung\n", wg)
	fmt.Fprintf(&b, "\t\toifname %s jump wartung\n", wg)
	fmt.Fprintf(&b, "\t}\n")
	fmt.Fprintf(&b, "\tchain wartung {\n")
	fmt.Fprintf(&b, "\t\t%s ip saddr %s ip daddr %s ip saddr . ip daddr @%s tcp dport %s %s\n", paar, tech, box, Menge, r.ports(), neu)
	fmt.Fprintf(&b, "\t\t%s ip saddr %s ip daddr %s ip saddr . ip daddr @%s tcp dport %s ct state established accept\n", paar, tech, box, Menge, r.ports())
	fmt.Fprintf(&b, "\t\t%s ip saddr %s ip daddr %s ip saddr . ip daddr @%s icmp type echo-request accept\n", paar, tech, box, Menge)
	fmt.Fprintf(&b, "\t\t%s ip saddr %s ip daddr %s ip daddr . ip saddr @%s ct state established,related accept\n", paar, box, tech, Menge)
	fmt.Fprintf(&b, "\t\tcounter drop\n")
	fmt.Fprintf(&b, "\t}\n")
	fmt.Fprintf(&b, "\tchain eingang {\n")
	fmt.Fprintf(&b, "\t\ttype filter hook input priority filter; policy accept;\n")
	fmt.Fprintf(&b, "\t\tiifname %s jump eingang_wartung\n", wg)
	fmt.Fprintf(&b, "\t}\n")
	fmt.Fprintf(&b, "\tchain eingang_wartung {\n")
	fmt.Fprintf(&b, "\t\ticmp type echo-request limit rate 5/second accept\n")
	fmt.Fprintf(&b, "\t\tcounter drop\n")
	fmt.Fprintf(&b, "\t}\n")
	return b.String()
}

// Kennung ist der Prüfwert der Basis; er steht im Kommentar der Menge
// (nft 1.0.6 gibt Tabellen-Kommentare nicht als JSON aus, Mengen-Kommentare schon).
func (r Regeln) Kennung() string {
	summe := sha256.Sum256([]byte(r.Tabelle + "\n" + r.koerper() + r.MaxFenster.String()))
	return "vp-tunnel-dienst v1 " + hex.EncodeToString(summe[:6])
}

// Basis ist der vollständige Regelsatz der eigenen Tabelle. Er regelt NUR
// Verkehr, der die Wartungs-Schnittstelle berührt, und verwirft davon alles,
// was nicht ausdrücklich erlaubt ist:
//
//   - Techniker -> Box nur, wenn das Paar in der Menge "fenster" steht, nur
//     auf den Dienste-Ports und Ping. Die Prüfung gilt für JEDES Paket, nicht
//     nur für den Verbindungsaufbau: läuft ein Element ab, reißt auch eine
//     bestehende Sitzung ab.
//   - Box -> Techniker nur Antworten, ebenfalls nur bei offenem Fenster.
//   - Box <-> Box, Box -> anderswohin (Internet, altes VPN), Techniker <->
//     Techniker: verworfen.
//   - Zum Server selbst aus dem Tunnel: nur Ping.
//
// Die Menge hat Ablaufzeiten: ein Fenster schließt im Kernel, auch wenn API
// oder Dienst ausfallen.
func (r Regeln) Basis() string {
	var b strings.Builder
	fmt.Fprintf(&b, "table inet %s {\n", r.Tabelle)
	fmt.Fprintf(&b, "\tset %s {\n", Menge)
	fmt.Fprintf(&b, "\t\ttype ipv4_addr . ipv4_addr\n")
	fmt.Fprintf(&b, "\t\tflags timeout\n")
	fmt.Fprintf(&b, "\t\ttimeout %ds\n", int(r.MaxFenster.Seconds()))
	fmt.Fprintf(&b, "\t\tcomment %s\n", strconv.Quote(r.Kennung()))
	fmt.Fprintf(&b, "\t}\n")
	b.WriteString(r.koerper())
	fmt.Fprintf(&b, "}\n")
	return b.String()
}

// Nft verwaltet die eigene Tabelle.
type Nft struct {
	R      Runner
	Regeln Regeln
}

type nftAusgabe struct {
	Nftables []map[string]json.RawMessage `json:"nftables"`
}

type nftMenge struct {
	Name    string            `json:"name"`
	Comment string            `json:"comment"`
	Elem    []json.RawMessage `json:"elem"`
}

type nftKette struct {
	Name string `json:"name"`
}

// BasisStimmt prüft, ob die Tabelle mit genau dieser Basis existiert.
func (n Nft) BasisStimmt(ctx context.Context) (bool, error) {
	out, err := n.R.Run(ctx, "nft", []string{"-j", "list", "table", "inet", n.Regeln.Tabelle}, nil)
	if err != nil {
		if IstNichtVorhanden(err) {
			return false, nil
		}
		return false, err
	}
	var a nftAusgabe
	if err := json.Unmarshal(out, &a); err != nil {
		return false, fmt.Errorf("nft -j list table: %w", err)
	}
	kommentarStimmt := false
	ketten := map[string]bool{}
	for _, o := range a.Nftables {
		if raw, ok := o["set"]; ok {
			var m nftMenge
			if json.Unmarshal(raw, &m) == nil && m.Name == Menge && m.Comment == n.Regeln.Kennung() {
				kommentarStimmt = true
			}
		}
		if raw, ok := o["chain"]; ok {
			var k nftKette
			if json.Unmarshal(raw, &k) == nil {
				ketten[k.Name] = true
			}
		}
	}
	if !kommentarStimmt {
		return false, nil
	}
	for _, k := range basisKetten {
		if !ketten[k] {
			return false, nil
		}
	}
	return true, nil
}

// SichereBasis legt die Tabelle an oder ersetzt sie, wenn sie fehlt oder
// abweicht - in EINER nft-Transaktion. Beim Ersetzen gehen offene
// Fenster verloren (sicher: geschlossen); der nächste frische Soll-Stand
// öffnet sie wieder. Liefert true, wenn neu geladen wurde.
func (n Nft) SichereBasis(ctx context.Context) (bool, error) {
	ok, err := n.BasisStimmt(ctx)
	if err != nil {
		return false, err
	}
	if ok {
		return false, nil
	}
	skript := "table inet " + n.Regeln.Tabelle + "\n" +
		"delete table inet " + n.Regeln.Tabelle + "\n" +
		n.Regeln.Basis()
	if _, err := n.R.Run(ctx, "nft", []string{"-f", "-"}, []byte(skript)); err != nil {
		return false, err
	}
	return true, nil
}

// Fenster liest die Elemente der Menge mit ihrer Restlaufzeit.
func (n Nft) Fenster(ctx context.Context) (map[abgleich.Paar]time.Duration, error) {
	out, err := n.R.Run(ctx, "nft", []string{"-j", "list", "set", "inet", n.Regeln.Tabelle, Menge}, nil)
	if err != nil {
		return nil, err
	}
	return LiesFenster(out)
}

// LiesFenster zerlegt `nft -j list set`. Ein Element ist entweder
// {"elem": {"val": {"concat": [a, b]}, "timeout": t, "expires": e}} oder
// - ohne eigene Zeiten - direkt {"concat": [a, b]}.
func LiesFenster(out []byte) (map[abgleich.Paar]time.Duration, error) {
	var a nftAusgabe
	if err := json.Unmarshal(out, &a); err != nil {
		return nil, fmt.Errorf("nft -j list set: %w", err)
	}
	fenster := map[abgleich.Paar]time.Duration{}
	for _, o := range a.Nftables {
		raw, ok := o["set"]
		if !ok {
			continue
		}
		var m nftMenge
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, fmt.Errorf("nft-Menge: %w", err)
		}
		for _, e := range m.Elem {
			paar, rest, err := liesElement(e)
			if err != nil {
				return nil, err
			}
			fenster[paar] = rest
		}
	}
	return fenster, nil
}

type nftConcat struct {
	Concat []string `json:"concat"`
}

type nftElem struct {
	Elem *struct {
		Val     nftConcat `json:"val"`
		Expires float64   `json:"expires"`
	} `json:"elem"`
	Concat []string `json:"concat"`
}

func liesElement(raw json.RawMessage) (abgleich.Paar, time.Duration, error) {
	var e nftElem
	if err := json.Unmarshal(raw, &e); err != nil {
		return abgleich.Paar{}, 0, fmt.Errorf("nft-Element %s: %w", raw, err)
	}
	werte := e.Concat
	var rest time.Duration
	if e.Elem != nil {
		werte = e.Elem.Val.Concat
		rest = time.Duration(e.Elem.Expires * float64(time.Second))
	}
	if len(werte) != 2 {
		return abgleich.Paar{}, 0, fmt.Errorf("nft-Element %s: kein Paar", raw)
	}
	tech, err1 := netip.ParseAddr(werte[0])
	box, err2 := netip.ParseAddr(werte[1])
	if err1 != nil || err2 != nil {
		return abgleich.Paar{}, 0, fmt.Errorf("nft-Element %s: keine Adressen", raw)
	}
	return abgleich.Paar{Techniker: tech, Box: box}, rest, nil
}

// EntferneFenster löscht ein Element. Ein inzwischen von selbst
// abgelaufenes Element ist kein Fehler.
func (n Nft) EntferneFenster(ctx context.Context, p abgleich.Paar) error {
	_, err := n.R.Run(ctx, "nft", []string{"delete", "element", "inet", n.Regeln.Tabelle, Menge,
		"{ " + p.String() + " }"}, nil)
	if err != nil && IstNichtVorhanden(err) {
		return nil
	}
	return err
}

// FuegeFensterHinzu fügt Elemente mit Ablaufzeit in einer Transaktion hinzu.
func (n Nft) FuegeFensterHinzu(ctx context.Context, elemente []abgleich.FensterSetzen) error {
	if len(elemente) == 0 {
		return nil
	}
	var b strings.Builder
	for _, e := range elemente {
		fmt.Fprintf(&b, "add element inet %s %s { %s timeout %ds }\n", n.Regeln.Tabelle, Menge, e.Paar,
			int(e.Timeout.Seconds()))
	}
	_, err := n.R.Run(ctx, "nft", []string{"-f", "-"}, []byte(b.String()))
	return err
}
