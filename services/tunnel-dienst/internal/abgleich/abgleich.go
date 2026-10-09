// Package abgleich rechnet aus Soll und Ist, was zu tun ist - ohne selbst
// etwas zu tun. Rein und deterministisch, damit jede Regel testbar ist.
package abgleich

import (
	"fmt"
	"net/netip"
	"sort"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/soll"
)

// Paar ist ein Element der nft-Menge "fenster": Techniker . Box.
type Paar struct {
	Techniker netip.Addr
	Box       netip.Addr
}

func (p Paar) String() string { return p.Techniker.String() + " . " + p.Box.String() }

// Ist ist der Zustand auf dem Server.
type Ist struct {
	// Peers: öffentlicher Schlüssel -> erlaubte Adressen, wie WireGuard sie meldet.
	Peers map[string][]netip.Prefix
	// Fenster: Paar -> Restlaufzeit laut Kernel.
	Fenster map[Paar]time.Duration
}

// PeerSetzen legt einen Peer an oder setzt seine erlaubte Adresse.
type PeerSetzen struct {
	PublicKey string
	Adresse   netip.Addr
	Kennung   string
	Neu       bool
}

// FensterSetzen fügt ein Element mit Ablaufzeit hinzu.
type FensterSetzen struct {
	Paar    Paar
	Timeout time.Duration
	// FensterID ist das Fenster der API, aus dem das Element stammt (fürs Log).
	FensterID string
}

// Plan ist, was ein Lauf umsetzen soll. Reihenfolge der Umsetzung:
// FensterEntfernen, PeersEntfernen, PeersSetzen, FensterHinzufuegen -
// erst schließen, dann öffnen.
type Plan struct {
	FensterEntfernen   []Paar
	PeersEntfernen     []string
	PeersSetzen        []PeerSetzen
	FensterHinzufuegen []FensterSetzen
	// Alarme: Gründe, warum etwas bewusst NICHT umgesetzt wird.
	Alarme []string
}

// Leer sagt, ob es nichts zu tun gibt.
func (p Plan) Leer() bool {
	return len(p.FensterEntfernen) == 0 && len(p.PeersEntfernen) == 0 && len(p.PeersSetzen) == 0 &&
		len(p.FensterHinzufuegen) == 0
}

// Optionen steuern einen Abgleich.
type Optionen struct {
	// Jetzt ist die Uhr des Servers.
	Jetzt time.Time
	// MitFenster: nur ein FRISCH abgeholter Soll-Stand darf Fenster öffnen
	// oder schließen. Aus dem Zwischenspeicher (API nicht erreichbar) kommen
	// höchstens Peers - nie ein Fenster.
	MitFenster bool
	// NurHinzufuegen: keine Peers entfernen (Wiederanlauf aus dem
	// Zwischenspeicher).
	NurHinzufuegen bool
	// MaxEntfernen: mehr Peer-Entfernungen in einem Lauf gelten als Fehler
	// der Quelle; dann wird keiner entfernt und Alarm geschlagen.
	MaxEntfernen int
	// MaxFenster: längste Ablaufzeit, die der Dienst setzt, egal was die API sagt.
	MaxFenster time.Duration
	// Toleranz: Abweichung der Restlaufzeit, ab der ein Element neu gesetzt wird.
	Toleranz time.Duration
	// Vorlauf: Uhrabweichung, um die ein Beginn in der Zukunft noch als
	// begonnen gilt.
	Vorlauf time.Duration
}

// Rechne vergleicht Soll und Ist.
func Rechne(g soll.Gueltig, ist Ist, o Optionen) Plan {
	var p Plan

	// ── Peers ─────────────────────────────────────────────────────────────
	for _, key := range sortierteSchluessel(g.Peers) {
		ps := g.Peers[key]
		gewollt := netip.PrefixFrom(ps.Adresse, 32)
		hat, vorhanden := ist.Peers[key]
		if vorhanden && len(hat) == 1 && hat[0] == gewollt {
			continue
		}
		p.PeersSetzen = append(p.PeersSetzen, PeerSetzen{PublicKey: key, Adresse: ps.Adresse, Kennung: ps.Kennung,
			Neu: !vorhanden})
	}
	if !o.NurHinzufuegen {
		var weg []string
		for key := range ist.Peers {
			if _, gewollt := g.Peers[key]; !gewollt {
				weg = append(weg, key)
			}
		}
		sort.Strings(weg)
		if o.MaxEntfernen >= 0 && len(weg) > o.MaxEntfernen {
			p.Alarme = append(p.Alarme, fmt.Sprintf(
				"%d Peers sollen weg, erlaubt sind höchstens %d je Lauf - es wird KEINER entfernt "+
					"(VP_TUNNEL_MAX_ENTFERNEN; bewusst gewollt? dann den Wert für einen Lauf erhöhen)",
				len(weg), o.MaxEntfernen))
		} else {
			p.PeersEntfernen = weg
		}
	}

	if !o.MitFenster {
		return p
	}

	// ── Fenster ───────────────────────────────────────────────────────────
	gewollt := map[Paar]time.Duration{}
	herkunft := map[Paar]string{}
	for _, f := range g.Fenster {
		if f.Beginn.After(o.Jetzt.Add(o.Vorlauf)) || !f.Ende.After(o.Jetzt) {
			continue
		}
		rest := f.Ende.Sub(o.Jetzt)
		if o.MaxFenster > 0 && rest > o.MaxFenster {
			p.Alarme = append(p.Alarme, fmt.Sprintf("Fenster %s reicht %s weit, der Dienst setzt höchstens %s",
				f.ID, rest.Round(time.Second), o.MaxFenster))
			rest = o.MaxFenster
		}
		rest = rest.Truncate(time.Second)
		if rest < time.Second {
			continue
		}
		paar := Paar{Techniker: f.Techniker, Box: f.Box}
		if rest > gewollt[paar] {
			gewollt[paar] = rest
			herkunft[paar] = f.ID
		}
	}
	for _, paar := range sortiertePaare(ist.Fenster) {
		soll, ok := gewollt[paar]
		if !ok {
			p.FensterEntfernen = append(p.FensterEntfernen, paar)
			continue
		}
		if abweichung(ist.Fenster[paar], soll) > o.Toleranz {
			p.FensterEntfernen = append(p.FensterEntfernen, paar)
			p.FensterHinzufuegen = append(p.FensterHinzufuegen, FensterSetzen{Paar: paar, Timeout: soll,
				FensterID: herkunft[paar]})
		}
	}
	for _, paar := range sortiertePaare(gewollt) {
		if _, ok := ist.Fenster[paar]; !ok {
			p.FensterHinzufuegen = append(p.FensterHinzufuegen, FensterSetzen{Paar: paar, Timeout: gewollt[paar],
				FensterID: herkunft[paar]})
		}
	}
	return p
}

func abweichung(a, b time.Duration) time.Duration {
	if a > b {
		return a - b
	}
	return b - a
}

func sortierteSchluessel(m map[string]soll.PeerSoll) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func sortiertePaare(m map[Paar]time.Duration) []Paar {
	paare := make([]Paar, 0, len(m))
	for p := range m {
		paare = append(paare, p)
	}
	sort.Slice(paare, func(i, j int) bool { return paare[i].String() < paare[j].String() })
	return paare
}
