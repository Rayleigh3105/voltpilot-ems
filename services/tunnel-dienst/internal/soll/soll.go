// Package soll liest und prüft den Soll-Stand, den die VoltPilot-API unter
// GET /api/v1/fernwartung/soll ausliefert (Vertrag:
// docs/contracts/fernwartung-soll-v1.example.json).
//
// Die API ist die Quelle der Wahrheit, aber nicht unfehlbar: der Dienst prüft
// jeden Eintrag gegen seine EIGENE Konfiguration (Netze, Schlüsselform,
// Eindeutigkeit). Ein Fehler im Dokument als Ganzes (falsche Version,
// abweichende Netze) verwirft den Stand vollständig; ein einzelner
// fehlerhafter Eintrag wird mit Befund übersprungen, der Rest gilt.
package soll

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"time"
)

// Version ist die einzige Soll-Version, die dieser Dienst kennt.
const Version = 1

// Arten eines Peers.
const (
	ArtBox       = "box"
	ArtTechniker = "techniker"
)

// Soll ist das Dokument, wie die API es liefert.
type Soll struct {
	Version       int       `json:"version"`
	ErzeugtAm     time.Time `json:"erzeugtAm"`
	BoxNetz       string    `json:"boxNetz"`
	TechnikerNetz string    `json:"technikerNetz"`
	Peers         []Peer    `json:"peers"`
	Fenster       []Fenster `json:"fenster"`
}

// Peer ist ein WireGuard-Peer: eine Box oder ein Techniker-Zugang.
//
// SSHPublicKey ist der öffentliche SSH-Schlüssel eines Technikers, mit dem er
// sich im offenen Fenster an der Box anmeldet ("ssh-rsa <Base64>", ohne
// Kommentar). Die API liefert das Feld nur an einem Techniker-Peer mit
// hinterlegtem Schlüssel. Für WireGuard und die Firewall spielt es keine
// Rolle. Pruefe reicht es nur weiter, wenn es die eigene Prüfung besteht
// (PruefeSSHSchluessel) - auch wenn die API das schon geprüft hat: die Zeile
// geht über die Schlüsselausgabe unverändert in die Schlüsseldatei einer Box.
type Peer struct {
	Art          string `json:"art"`
	ID           string `json:"id"`
	Kennung      string `json:"kennung"`
	PublicKey    string `json:"publicKey"`
	Adresse      string `json:"adresse"`
	SSHPublicKey string `json:"sshPublicKey,omitempty"`
}

// Fenster ist ein offenes Fernwartungsfenster; es verweist über die IDs auf
// zwei Peers.
type Fenster struct {
	ID          string    `json:"id"`
	BoxID       string    `json:"boxId"`
	TechnikerID string    `json:"technikerId"`
	Beginn      time.Time `json:"beginn"`
	Ende        time.Time `json:"ende"`
}

// Lies dekodiert ein Dokument. Unbekannte Felder sind erlaubt: eine additive
// Erweiterung des Vertrags darf den Dienst nicht anhalten.
func Lies(daten []byte) (Soll, error) {
	var s Soll
	if err := json.Unmarshal(daten, &s); err != nil {
		return Soll{}, fmt.Errorf("Soll-Stand ist kein gültiges JSON: %w", err)
	}
	return s, nil
}

// LiesStreng dekodiert wie Lies, verbietet aber unbekannte Felder. Für den
// Vertragstest: ein Feld, das die API neu liefert, muss hier bekannt sein.
func LiesStreng(daten []byte) (Soll, error) {
	dec := json.NewDecoder(bytes.NewReader(daten))
	dec.DisallowUnknownFields()
	var s Soll
	if err := dec.Decode(&s); err != nil {
		return Soll{}, err
	}
	return s, nil
}

// Netze ist die lokale Konfiguration, gegen die geprüft wird.
type Netze struct {
	Box       netip.Prefix
	Techniker netip.Prefix
}

// PeerSoll ist ein geprüfter Peer.
type PeerSoll struct {
	Art       string
	ID        string
	Kennung   string
	PublicKey string
	Adresse   netip.Addr
	// SSH ist der geprüfte SSH-Schlüssel eines Technikers; leer (Zeile ""),
	// wenn keiner hinterlegt ist oder der gelieferte die Prüfung nicht besteht.
	SSH SSHSchluessel
}

// FensterSoll ist ein geprüftes Fenster mit aufgelösten Adressen.
type FensterSoll struct {
	ID        string
	Techniker netip.Addr
	Box       netip.Addr
	Beginn    time.Time
	Ende      time.Time
}

// Gueltig ist das, was nach der Prüfung umgesetzt werden darf.
type Gueltig struct {
	// Peers nach öffentlichem Schlüssel.
	Peers   map[string]PeerSoll
	Fenster []FensterSoll
}

// Befund ist ein übersprungener Eintrag mit Grund.
type Befund struct {
	Was   string
	Grund string
}

func (b Befund) String() string { return b.Was + ": " + b.Grund }

var schluesselForm = regexp.MustCompile(`^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$`)

// SchluesselGueltig prüft einen öffentlichen WireGuard-Schlüssel: 32 Byte
// Base64 - dieselbe Regel wie API (WireguardSchluessel) und Datenbank.
func SchluesselGueltig(s string) bool {
	if !schluesselForm.MatchString(s) {
		return false
	}
	b, err := base64.StdEncoding.DecodeString(s)
	return err == nil && len(b) == 32
}

// ServerAdresse ist die erste Host-Adresse eines Netzes (der Server selbst).
func ServerAdresse(netz netip.Prefix) netip.Addr {
	return netz.Masked().Addr().Next()
}

func broadcast(netz netip.Prefix) netip.Addr {
	a := netz.Masked().Addr().As4()
	bits := netz.Bits()
	wert := uint32(a[0])<<24 | uint32(a[1])<<16 | uint32(a[2])<<8 | uint32(a[3])
	wert |= ^uint32(0) >> bits
	return netip.AddrFrom4([4]byte{byte(wert >> 24), byte(wert >> 16), byte(wert >> 8), byte(wert)})
}

// IstHost sagt, ob eine Adresse einem Peer gehören kann: im Netz, aber weder
// die Netz-, die Server- noch die Broadcast-Adresse.
func IstHost(netz netip.Prefix, a netip.Addr) bool {
	return a.Is4() && netz.Contains(a) && a != netz.Masked().Addr() && a != ServerAdresse(netz) && a != broadcast(netz)
}

// Pruefe prüft das Dokument gegen die lokalen Netze. Ein Fehler betrifft
// das ganze Dokument; Befunde betreffen einzelne, übersprungene Einträge.
func Pruefe(s Soll, netze Netze) (Gueltig, []Befund, error) {
	if s.Version != Version {
		return Gueltig{}, nil, fmt.Errorf("Soll-Version %d unbekannt (erwartet %d)", s.Version, Version)
	}
	if s.BoxNetz != netze.Box.String() || s.TechnikerNetz != netze.Techniker.String() {
		return Gueltig{}, nil, fmt.Errorf("Netze der API (%s, %s) weichen von der Konfiguration ab (%s, %s)",
			s.BoxNetz, s.TechnikerNetz, netze.Box, netze.Techniker)
	}
	var befunde []Befund

	// Erst jeden Peer für sich, dann Doppelte: ein Schlüssel oder eine
	// Adresse, die zweimal vorkommt, ist ein Widerspruch - BEIDE fallen weg,
	// statt zu raten, welcher gemeint ist.
	type kandidat struct {
		p    Peer
		addr netip.Addr
	}
	var kandidaten []kandidat
	for _, p := range s.Peers {
		was := "Peer " + p.Kennung + " (" + p.ID + ")"
		var netz netip.Prefix
		switch p.Art {
		case ArtBox:
			netz = netze.Box
		case ArtTechniker:
			netz = netze.Techniker
		default:
			befunde = append(befunde, Befund{was, "unbekannte Art " + p.Art})
			continue
		}
		if p.ID == "" {
			befunde = append(befunde, Befund{was, "ohne id"})
			continue
		}
		if !SchluesselGueltig(p.PublicKey) {
			befunde = append(befunde, Befund{was, "kein gültiger öffentlicher WireGuard-Schlüssel"})
			continue
		}
		addr, err := netip.ParseAddr(p.Adresse)
		if err != nil || !addr.Is4() {
			befunde = append(befunde, Befund{was, "keine IPv4-Adresse: " + p.Adresse})
			continue
		}
		if !IstHost(netz, addr) {
			befunde = append(befunde, Befund{was, fmt.Sprintf("Adresse %s liegt nicht im %s-Netz %s oder ist reserviert",
				addr, p.Art, netz)})
			continue
		}
		kandidaten = append(kandidaten, kandidat{p, addr})
	}
	zaehleKey := map[string]int{}
	zaehleAddr := map[netip.Addr]int{}
	zaehleID := map[string]int{}
	for _, k := range kandidaten {
		zaehleKey[k.p.PublicKey]++
		zaehleAddr[k.addr]++
		zaehleID[k.p.ID]++
	}
	g := Gueltig{Peers: map[string]PeerSoll{}}
	nachID := map[string]PeerSoll{}
	for _, k := range kandidaten {
		was := "Peer " + k.p.Kennung + " (" + k.p.ID + ")"
		switch {
		case zaehleKey[k.p.PublicKey] > 1:
			befunde = append(befunde, Befund{was, "Schlüssel mehrfach vergeben"})
			continue
		case zaehleAddr[k.addr] > 1:
			befunde = append(befunde, Befund{was, "Adresse " + k.addr.String() + " mehrfach vergeben"})
			continue
		case zaehleID[k.p.ID] > 1:
			befunde = append(befunde, Befund{was, "id mehrfach vergeben"})
			continue
		}
		ps := PeerSoll{Art: k.p.Art, ID: k.p.ID, Kennung: k.p.Kennung, PublicKey: k.p.PublicKey, Adresse: k.addr}
		// Der SSH-Schlüssel ist ein Zusatz: ein unbrauchbarer nimmt dem Peer
		// nicht den Netzweg, er wird nur an keine Box ausgegeben.
		if k.p.SSHPublicKey != "" {
			ssh, err := PruefeSSHSchluessel(k.p.SSHPublicKey)
			switch {
			case k.p.Art != ArtTechniker:
				befunde = append(befunde, Befund{"SSH-Schlüssel an " + was, "nur ein Techniker-Zugang trägt einen; er wird nicht ausgegeben"})
			case err != nil:
				befunde = append(befunde, Befund{"SSH-Schlüssel an " + was, err.Error() + "; er wird nicht ausgegeben"})
			default:
				ps.SSH = ssh
			}
		}
		g.Peers[ps.PublicKey] = ps
		nachID[ps.ID] = ps
	}

	for _, f := range s.Fenster {
		was := "Fenster " + f.ID
		box, okBox := nachID[f.BoxID]
		tech, okTech := nachID[f.TechnikerID]
		switch {
		case !okBox || box.Art != ArtBox:
			befunde = append(befunde, Befund{was, "verweist auf keine gültige Box (" + f.BoxID + ")"})
			continue
		case !okTech || tech.Art != ArtTechniker:
			befunde = append(befunde, Befund{was, "verweist auf keinen gültigen Techniker-Zugang (" + f.TechnikerID + ")"})
			continue
		case !f.Ende.After(f.Beginn):
			befunde = append(befunde, Befund{was, "Ende liegt nicht nach dem Beginn"})
			continue
		}
		g.Fenster = append(g.Fenster, FensterSoll{ID: f.ID, Techniker: tech.Adresse, Box: box.Adresse,
			Beginn: f.Beginn, Ende: f.Ende})
	}
	sort.Slice(g.Fenster, func(i, j int) bool { return g.Fenster[i].ID < g.Fenster[j].ID })
	return g, befunde, nil
}
