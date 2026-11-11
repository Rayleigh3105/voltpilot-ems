package protokoll

import (
	"strings"
)

// Spur ist, was die Protokolle dieses Dienstes über eine Box wissen: der
// jüngste Lauf, der ihr ein Passwort gesetzt hat. Nur dann ist ein Passwort
// auf der Box eines dieser Werkstatt (Schritt passwort belegt), und nur dann
// kann sie eine halb eingerichtete Box dieser Werkstatt sein.
type Spur struct {
	Lauf    string   // Kennung des Laufs
	Zustand string   // fertig, angehalten oder leer (der Lauf ist nicht beendet)
	Belegt  []string // die belegten Schritte, in ihrer Reihenfolge
	// Host ist der Fingerabdruck des Host-Schlüssels, den der Lauf nach
	// OpenWrt festhielt (gilt für den ganzen Lauf und übersteht Neustarts).
	Host string
	Ref  string // Referenz aus dem Schritt programm; leer, wenn er nicht so weit kam
}

// Hat sagt, ob der Schritt belegt ist.
func (s Spur) Hat(schritt string) bool {
	for _, b := range s.Belegt {
		if b == schritt {
			return true
		}
	}
	return false
}

// Fertig sagt, ob der Lauf die Box übergeben hat.
func (s Spur) Fertig() bool { return s.Zustand == "fertig" || s.Hat("uebergabe") }

// SpurDerMAC sucht in allen Protokollen den jüngsten Lauf, der dieser MAC ein
// Passwort gesetzt hat (ausser dem Lauf ausser, dem gerade laufenden). Die MAC
// zählt aus der Angabe beim Beginn und aus jedem Beleg „mac“ (nach OpenWrt kann
// die Box eine andere melden als ab Werk). false: kein solcher Lauf.
func (a *Ablage) SpurDerMAC(mac, ausser string) (Spur, bool, error) {
	mac = strings.ToLower(strings.TrimSpace(mac))
	if mac == "" {
		return Spur{}, false, nil
	}
	laeufe, err := a.Laeufe() // neueste zuerst
	if err != nil {
		return Spur{}, false, err
	}
	for _, k := range laeufe {
		if k == ausser {
			continue
		}
		es, err := a.Lies(k)
		if err != nil {
			return Spur{}, false, err
		}
		s, passt := spurAus(k, es, mac)
		if passt && s.Hat("passwort") {
			return s, true, nil
		}
	}
	return Spur{}, false, nil
}

func spurAus(k string, es []Eintrag, mac string) (Spur, bool) {
	s := Spur{Lauf: k}
	passt := false
	for _, e := range es {
		if strings.ToLower(e.Angaben["mac"]) == mac {
			passt = true
		}
		if v, ok := e.Beleg.Wert("mac"); ok && strings.ToLower(strings.TrimSpace(v)) == mac {
			passt = true
		}
		switch e.Art {
		case SchrittBelegt:
			s.Belegt = append(s.Belegt, e.Schritt)
			if e.Schritt == "programm" {
				if v, ok := e.Beleg.Wert("referenz"); ok {
					if f := strings.Fields(v); len(f) > 0 {
						s.Ref = f[0]
					}
				}
			}
			if e.Schritt == "erkennen" || e.Schritt == "wiedererkennen" {
				// "ssh-rsa SHA256:…" nach OpenWrt; ab Werk heißt der Beleg host_schluessel_werk.
				if v, ok := e.Beleg.Wert("host_schluessel"); ok {
					if f := strings.Fields(v); len(f) == 2 {
						s.Host = f[1]
					}
				}
			}
		case LaufBeendet:
			s.Zustand = e.Zustand
		}
	}
	return s, passt
}
