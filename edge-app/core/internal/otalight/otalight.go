// Package otalight ist die REINE Haelfte des Edge-Light-Updates (Konzept
// vp-edge-light-update, U-3 A): das Datei-Protokoll zwischen dem laufenden
// Programm und dem Loader `boot.sh`, und die Regeln, ob eine geprueft
// zugewiesene Fassung angewandt wird.
//
// Kein Netz, kein Prozess, kein Signal - nur Entscheidungen und Formate. Der
// Loader ist ein Shell-Skript; was er liest und schreibt, steht HIER als
// Dateiname und Format, und edge-light/test/boot-update-probe.sh faehrt beide
// Seiten gegeneinander.
//
// # Wer was schreibt (jede Datei hat genau einen Schreiber)
//
// Im Flash (DataDir/ota, ueberlebt einen Stromausfall, wird selten geschrieben):
//
//	trust-set.json(.sig)  Einrichtung (install.sh)
//	current.json          Programm   die BESTAETIGTE Fassung (nur ausserhalb der Probe)
//	versuche              Loader     eine Zeile je Schritt eines Versuchs, feste Obergrenze
//
// Im RAM (Config.OtaRAMDir, ein Stromausfall loescht es):
//
//	target.json           Programm   die retained Zuweisung
//	kandidat.gz           Programm   die geladene Lieferung, geprueft gegen gz_sha256/gz_size
//	kandidat.json         Programm   NACH kandidat.gz: was der Loader entpacken und pruefen soll
//	probe.json            Loader     die neue Fassung laeuft zur Probe
//	probe-urteil.json     Programm   das Urteil des Selbsttests in der Probe
//
// # Die Saetze, auf denen die Sicherheit ruht
//
//  1. Echtheit: das Programm laedt nur, was ein gegen die eingebackene Wurzel
//     gepruefte Manifest beschreibt, und prueft die Bytes gegen dessen
//     gz_sha256. Der Loader startet aus dem RAM nur, was die sha256 aus
//     kandidat.json traegt; in den Flash kommt nur Bestaetigtes.
//  2. Kein Draengeln: eine zurueckgenommene Zuweisung wird nicht von selbst
//     wiederholt; erst eine NEUE Zuweisung (anderes assigned_at) versucht es
//     erneut - wie bei der Docker-Box.
//  3. Datenformat: ein Release mit anderem state_schema als dem bestaetigten
//     wird nicht automatisch angewandt.
package otalight

import (
	"bufio"
	"bytes"
	"fmt"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

// Dateinamen des Protokolls (siehe Paketdokumentation).
const (
	FileKandidat   = "kandidat.json"
	FileKandidatGz = "kandidat.gz"
	FileProbe      = "probe.json"
	FileUrteil     = "probe-urteil.json"
	FileVersuche   = "versuche"
)

// Zahlen des Waechters - dieselben wie bei der Docker-Box
// (otaapply/watchdog.go): 10 min Probezeit, 3 Abstuerze. Der Loader traegt sie
// als Vorgabe; hier stehen sie fuer Programm, Tests und Doku.
const (
	ProbeFrist     = 10 * time.Minute
	ProbeStartsMax = 3
	// AbbruchMax: so oft darf ein Versuch durch einen Neustart des ganzen
	// Geraets in der Probe enden, bevor das Release als gescheitert gilt
	// (gegen eine Fassung, die das ganze Geraet neu startet).
	AbbruchMax = 2
	// VersucheMaxZeilen ist die feste Obergrenze der Datei im Flash.
	VersucheMaxZeilen = 40
)

// Arten einer Zeile in [FileVersuche].
const (
	VersuchStart   = "start"   // Loader: Probestart bestanden, die neue Fassung startet zur Probe
	VersuchOK      = "ok"      // Loader: bestaetigt, im Flash
	VersuchZurueck = "zurueck" // Loader: zurueckgenommen, Grund folgt
	VersuchAbbruch = "abbruch" // Loader: kalter Start fand einen offenen Versuch (Strom weg / Neustart)
)

// Kandidat ist [FileKandidat]: was das Programm geladen und geprueft hat und
// was der Loader daraus starten darf. Alle Pruefsummen stammen aus dem
// GEPRUEFTEN Manifest, nie aus dem unsignierten Umschlag.
type Kandidat struct {
	Release     string `json:"release"`
	ReleaseSeq  int64  `json:"release_seq"`
	Arch        string `json:"arch"`
	SHA256      string `json:"sha256"`
	Size        int64  `json:"size"`
	GzSHA256    string `json:"gz_sha256"`
	GzSize      int64  `json:"gz_size"`
	Zuweisung   string `json:"zuweisung"`
	StateSchema int    `json:"state_schema"`
	// SteuerteVorher: steuerte die Anlage vor dem Tausch? Dann muss die
	// Freigabe den Tausch ueberleben (Selbsttest-Pruefung "freigabe").
	SteuerteVorher bool   `json:"steuerte_vorher"`
	ErstelltAm     string `json:"erstellt_am"`
}

// Probe ist [FileProbe], geschrieben vom Loader. Das Programm liest nur, was
// es braucht; weitere Felder (Frist, Starts) gehoeren dem Loader.
type Probe struct {
	Release    string `json:"release"`
	ReleaseSeq int64  `json:"release_seq"`
	Zuweisung  string `json:"zuweisung"`
}

// Urteil ist [FileUrteil]: der Selbsttest der neuen Fassung in der Probe.
type Urteil struct {
	Release   string `json:"release"`
	Zuweisung string `json:"zuweisung"`
	Bestanden bool   `json:"bestanden"`
	// Offen: noch nicht entschieden (etwa: Cloud noch nicht erreicht). Der
	// Loader handelt nur auf ein endgueltiges Urteil; laeuft die Frist ab,
	// nennt er Grund des offenen als Ursache der Ruecknahme.
	Offen bool   `json:"offen,omitempty"`
	Grund string `json:"grund,omitempty"`
	Am    string `json:"am"`
}

// Versuch ist eine Zeile in [FileVersuche]: "<art> <seq> <zuweisung> [grund…]".
type Versuch struct {
	Art       string
	Seq       int64
	Zuweisung string
	Grund     string
}

// Zuweisung macht aus dem Umschlag die Kennung EINER Zuweisung: assigned_at
// (ein neues "Aktualisieren" im Portal setzt es neu), ersatzweise die
// Rollout-ID. Ein Wort ohne Leerraum, damit es in eine Zeile von
// [FileVersuche] passt; "-" ohne beides.
func Zuweisung(assignedAt, rolloutID string) string {
	k := strings.TrimSpace(assignedAt)
	if k == "" {
		k = strings.TrimSpace(rolloutID)
	}
	if k == "" {
		return "-"
	}
	return strings.Join(strings.Fields(k), "_")
}

// ParseVersuche liest [FileVersuche]. Unlesbare Zeilen werden uebergangen -
// eine halb geschriebene letzte Zeile nach einem Stromausfall darf die
// uebrigen nicht entwerten.
func ParseVersuche(raw []byte) []Versuch {
	var out []Versuch
	sc := bufio.NewScanner(bytes.NewReader(raw))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 {
			continue
		}
		switch f[0] {
		case VersuchStart, VersuchOK, VersuchZurueck, VersuchAbbruch:
		default:
			continue
		}
		seq, err := strconv.ParseInt(f[1], 10, 64)
		if err != nil || seq < 1 {
			continue
		}
		out = append(out, Versuch{Art: f[0], Seq: seq, Zuweisung: f[2], Grund: strings.Join(f[3:], " ")})
	}
	return out
}

// Update-Zustaende des Herzschlags (dieselben Woerter wie cloud.UpdateState*;
// hier als Text, damit das reine Paket nicht vom Cloud-Paket abhaengt).
const (
	ZustandDeferred   = "deferred"
	ZustandRolledBack = "rolled_back"
)

// Eingang ist alles, was [Entscheide] braucht.
type Eingang struct {
	// Manifest ist das GEPRUEFTE Manifest (Urteil ok, laeuft noch nicht).
	Manifest *otaverify.Manifest
	// Arch ist die eigene Plattform, GOOS/GOARCH (linux/mipsle).
	Arch string
	// Zuweisung siehe [Zuweisung].
	Zuweisung string
	// StateSchemaLokal ist das state_schema der bestaetigten Fassung
	// (current.json); 0 = unbekannt.
	StateSchemaLokal int
	// Versuche ist der Inhalt von [FileVersuche].
	Versuche []Versuch
}

// Entscheid ist das Ergebnis von [Entscheide]. Anwenden=false traegt Zustand
// und deutschen Grund fuer den Herzschlag.
type Entscheid struct {
	Anwenden bool
	Programm otaverify.Artifact
	Zustand  string
	Grund    string
}

// Entscheide sagt, ob eine geprueft zugewiesene, noch nicht laufende Fassung
// angewandt wird. Im Zweifel nicht - mit Grund.
func Entscheide(in Eingang) Entscheid {
	m := in.Manifest
	if m == nil {
		return Entscheid{Zustand: ZustandDeferred, Grund: "Kein gepruefte Manifest - es wird nichts angewandt."}
	}
	var prog *otaverify.Artifact
	for i := range m.Artifacts {
		a := m.Artifacts[i]
		if a.Type == otaverify.ArtifactBinary && a.Arch == in.Arch {
			prog = &a
			break
		}
	}
	if prog == nil {
		return Entscheid{Zustand: ZustandDeferred,
			Grund: fmt.Sprintf("Release %s enthaelt kein Programm fuer %s - es wird nicht angewandt.", m.Release, in.Arch)}
	}
	if in.StateSchemaLokal > 0 && m.StateSchema != in.StateSchemaLokal {
		return Entscheid{Zustand: ZustandDeferred,
			Grund: fmt.Sprintf("Release %s hat ein anderes Datenformat (state_schema %d, bestaetigt %d) - "+
				"es wird nicht automatisch angewandt.", m.Release, m.StateSchema, in.StateSchemaLokal)}
	}
	abbrueche := 0
	for _, v := range in.Versuche {
		if v.Seq != m.ReleaseSeq || v.Zuweisung != in.Zuweisung {
			continue
		}
		switch v.Art {
		case VersuchZurueck:
			grund := v.Grund
			if grund == "" {
				grund = "ohne Angabe"
			}
			return Entscheid{Zustand: ZustandRolledBack,
				Grund: "Release " + m.Release + " wurde zurueckgenommen (" + grund + "). Ein neuer Versuch " +
					"braucht eine neue Zuweisung im Portal."}
		case VersuchAbbruch:
			abbrueche++
		}
	}
	if abbrueche >= AbbruchMax {
		return Entscheid{Zustand: ZustandRolledBack,
			Grund: fmt.Sprintf("Release %s: die Probezeit endete %d-mal mit einem Neustart des Geraets "+
				"(Strom weg oder Absturz des Geraets) - es gilt als gescheitert. Ein neuer Versuch braucht "+
				"eine neue Zuweisung im Portal.", m.Release, abbrueche)}
	}
	return Entscheid{Anwenden: true, Programm: *prog}
}
