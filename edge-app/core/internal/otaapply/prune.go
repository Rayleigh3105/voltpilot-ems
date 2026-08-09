package otaapply

// Das Aufraeumen abgeloester Abbilder - die REGEL, ohne einen einzigen
// docker-Aufruf.
//
// Der Anlass ist gemessen (Pilsting, Raspberry Pi 5, 15-GB-Karte, 09.08.2026):
// `docker system df` meldete 58 Abbilder, davon 3 in Benutzung, 5,8 GB
// rueckgewinnbar - und der Plattenwaechter verweigerte einen legitimen Rollout
// mit „Platz auf dem Datentraeger schaffen". Die Verweigerung war richtig, der
// Grund war unser Muell: der Sidecar holt je Update BEIDE neuen Abbilder und
// sichert das Rueckfallziel dreifach - die ABGELOESTEN Abbilder hat er nie
// entsorgt.
//
// # Die Sicherheits-Invariante ist der ganze Inhalt dieser Datei
//
// Entfernt wird ausschliesslich, was BEWEISBAR niemand mehr braucht; im
// Zweifel bleibt ein Abbild stehen. Ein zu vorsichtiger Aufraeumer kostet
// Platten-Platz, ein zu gieriger nimmt die Rueckfallebene - also genau die
// Zusage, auf der der ganze autonome Tausch ruht. Konkret wird NIE entfernt:
//
//   - ein Abbild, auf das IRGENDEIN Container zeigt (laufend ODER gestoppt).
//     Das deckt die laufenden core/nodered/updater UND - ohne Sonderregel -
//     die gestoppten `vp-edge-lkg-*`-Halter, die das Rueckfall-Image tragen;
//   - ein Abbild aus dem Rueckfall-Namensraum ([LKGTagPrefix]), auch wenn sein
//     Halter fehlen sollte;
//   - alles ausdruecklich Geschuetzte (aufgeloeste Ziel- und
//     Rueckfall-Referenzen, siehe [PruneInput.Protected]);
//   - je Repository die [PrunePolicy.KeepReleases] JUENGSTEN verwaisten
//     Abbilder - die Kulanz fuer abgeloeste Releases.
//
// Das `docker save`-Archiv der dritten Sicherungsebene ist eine DATEI unter
// `<data>/ota/lkg/` und wird von keiner Abbild-Entfernung beruehrt - es ist
// per Konstruktion ausserhalb der Reichweite dieser Regel.
//
// Und: es wird bewusst NICHT pauschal weggeraeumt. `docker image prune -a`
// naehme auch ein vorab geholtes naechstes Ziel und jedes von aussen
// abgelegte Abbild (tools/pki, Pruefstand) mit; hier wird je NAME entfernt,
// und die Kandidatenmenge kommt ausschliesslich aus den Repositories, die
// dieses Geraet selbst getauscht hat.

import (
	"errors"
	"sort"
	"strings"
	"time"
)

// FilePrune ist der Schalter JE GERAET (siehe [PruneSwitch]).
const FilePrune = "prune.json"

// LKGTagPrefix ist der Namensraum des Rueckfallziels - der lokale `:lkg`-Tag
// UND der gestoppte Halter-Container tragen ihn.
//
// Er steht HIER, damit die Regel („was so heisst, wird nie entfernt") und die
// Wirkung (die Tag-/Halter-Namen in otaupdater) dieselbe Zeichenkette
// benutzen: zwei Schreibweisen desselben Namensraums waeren genau die Sorte
// Drift, bei der ein Aufraeumer irgendwann die Rueckfallebene mitnimmt.
const LKGTagPrefix = "vp-edge-lkg-"

// DefaultPruneKeepReleases ist die Vorgabe: EIN abgeloestes Release je
// Komponente bleibt liegen.
//
// Bewusst nicht 0. Nach einem bestaetigten Tausch zeigt das Rueckfallziel
// bereits auf den NEUEN, bewiesenen Stand - der Vorgaenger waere technisch
// entbehrlich. Ihn eine Runde laenger aufzuheben kostet einmal Abbild-Groesse
// und gibt einem Betreiber die Moeglichkeit, von Hand auf den Stand davor zu
// pinnen, ohne die Registry zu brauchen.
const DefaultPruneKeepReleases = 1

// Die Herkunft der Politik - reine Diagnose fuers Log.
const (
	PruneSourceDefault    = "vorgabe"
	PruneSourceDevice     = "prune.json"
	PruneSourceUnreadable = "prune.json_unlesbar"
)

// PrunePolicy ist die aufgeloeste Aufraeum-Politik.
type PrunePolicy struct {
	// Enabled: darf ueberhaupt etwas entfernt werden.
	Enabled bool
	// KeepReleases ist die Zahl ABGELOESTER Releases, deren Abbilder JE
	// REPOSITORY zusaetzlich aufgehoben werden. Je Repository, weil ein Release
	// je Komponente genau ein Abbild mitbringt - global gezaehlt haette „eines
	// aufheben" den Vorgaenger von `core` behalten und den von `nodered`
	// entfernt.
	KeepReleases int
	// Source sagt, woher die Politik kommt. Leer = nicht gesetzt.
	Source string
}

// DefaultPrunePolicy ist die ausgelieferte Vorgabe: aufraeumen, ein abgeloestes
// Release je Komponente aufheben.
func DefaultPrunePolicy() PrunePolicy {
	return PrunePolicy{Enabled: true, KeepReleases: DefaultPruneKeepReleases,
		Source: PruneSourceDefault}
}

// PruneSwitch ist die Datei `<data>/ota/prune.json` - der Schalter JE GERAET.
//
// Beide Felder sind Zeiger, damit „nicht genannt" und „ausdruecklich false /
// 0" unterscheidbar bleiben: ein Betreiber, der nur die Zahl setzen will, soll
// das Aufraeumen nicht versehentlich abschalten.
//
// SCHREIBER: der Betreiber (wie bei `autonomy.json`). Der Sidecar liest sie nur.
type PruneSwitch struct {
	Enabled      *bool  `json:"enabled,omitempty"`
	KeepReleases *int   `json:"keep_releases,omitempty"`
	Note         string `json:"note,omitempty"`
	UpdatedAt    string `json:"updated_at,omitempty"`
}

// ResolvePrunePolicy loest Flotten-Vorgabe und Geraete-Schalter auf.
//
// **Die Vorzeichen sind hier bewusst ANDERS als bei der Autonomie.** Dort ist
// jeder Zweifel AUS, weil ein Schalter, dessen Defekt zum Anwenden fuehrt,
// kein Schalter waere. Hier ist die ABWESENHEIT der Datei die Vorgabe (das
// Aufraeumen ist der gesunde Zustand, sein Fehlen war der Defekt) - eine
// UNLESBARE Datei ist aber etwas anderes als „nichts gesagt": dann wird nicht
// geraten, sondern nichts entfernt.
func ResolvePrunePolicy(dataDir string, fleet PrunePolicy) PrunePolicy {
	if fleet.Source == "" {
		fleet = DefaultPrunePolicy()
	}
	if fleet.KeepReleases < 0 {
		fleet.KeepReleases = 0
	}
	sw, err := ReadJSON[PruneSwitch](dataDir, FilePrune)
	switch {
	case errors.Is(err, ErrAbsent):
		return fleet
	case err != nil || sw == nil:
		return PrunePolicy{Enabled: false, KeepReleases: fleet.KeepReleases,
			Source: PruneSourceUnreadable}
	}
	out := fleet
	out.Source = PruneSourceDevice
	if sw.Enabled != nil {
		out.Enabled = *sw.Enabled
	}
	if sw.KeepReleases != nil && *sw.KeepReleases >= 0 {
		out.KeepReleases = *sw.KeepReleases
	}
	return out
}

// ImageRecord ist EIN Eintrag aus `docker images` - also ein NAME eines
// Abbildes, nicht das Abbild selbst. Dieselbe [ImageRecord.ID] kann mehrfach
// auftauchen (Tag und Digest desselben Abbildes), und genau deshalb wird ueber
// die ID entschieden und ueber die Namen entfernt.
type ImageRecord struct {
	// ID ist die lokale Abbild-Kennung (`sha256:…`) - die IDENTITAET.
	ID string
	// Repo/Tag/Digest sind die NAMEN (leer, wo docker `<none>` meldet).
	Repo   string
	Tag    string
	Digest string
	// Created ist die Bau-Zeit. Der Nullwert heisst „unbekannt" und gilt als
	// NEU - die vorsichtige Richtung, denn Neues wird eher aufgehoben.
	Created time.Time
}

// Refs sind die Namen, unter denen dieser Eintrag entfernt wird.
//
// Entfernt wird ueber NAMEN und nie ueber die Kennung mit `-f`: `docker image
// rm <name>` haengt nur den Namen ab und loescht das Abbild erst, wenn der
// letzte weg ist - und es VERWEIGERT die Loeschung, solange ein Container das
// Abbild haelt. Das ist eine dritte Sicherungsebene unterhalb unserer eigenen
// Pruefung, die ein `-f` gerade aushebeln wuerde.
func (r ImageRecord) Refs() []string {
	var out []string
	if r.Repo != "" && r.Tag != "" {
		out = append(out, r.Repo+":"+r.Tag)
	}
	if r.Repo != "" && r.Digest != "" {
		out = append(out, r.Repo+"@"+r.Digest)
	}
	if len(out) == 0 && r.ID != "" {
		out = append(out, r.ID)
	}
	return out
}

// PruneInput ist alles, was die Regel braucht.
type PruneInput struct {
	Policy PrunePolicy
	// Images sind die KANDIDATEN - ausschliesslich Eintraege aus den
	// Repositories, die dieses Geraet selbst getauscht hat. Was hier nicht
	// drinsteht, kann nicht entfernt werden.
	Images []ImageRecord
	// InUse sind die Abbild-Kennungen, auf die IRGENDEIN Container zeigt -
	// laufend ODER gestoppt. Die gestoppten Rueckfall-Halter sind damit
	// abgedeckt, ohne dass es dafuer eine Sonderregel braucht.
	InUse []string
	// Protected sind zusaetzlich geschuetzte Kennungen (aufgeloeste Ziel-,
	// Rueckfall- und Zuweisungs-Referenzen).
	Protected []string
	// Superseded sind die Kennungen des zuletzt abgeloesten Standes. Sie sind
	// KEIN Schutz, sondern eine RANGFOLGE: sie stehen bei der Kulanz vorn, also
	// ist bei der Vorgabe (eines aufheben) genau der Vorgaenger derjenige, der
	// bleibt - unabhaengig davon, was seine Bau-Zeitstempel behaupten.
	Superseded []string
}

// PruneRemoval ist EIN zu entfernender Name.
type PruneRemoval struct {
	Ref  string
	ID   string
	Repo string
}

// PrunePlan ist das Ergebnis - eine LISTE, keine Handlung.
type PrunePlan struct {
	// Remove sind die Namen, die abgehaengt werden (in stabiler Reihenfolge).
	Remove []PruneRemoval
	// Keep sind die Kennungen, die als Kulanz stehen bleiben.
	Keep []string
	// Skipped traegt den deutschen Grund, wenn gar nicht aufgeraeumt wird.
	Skipped string
}

// PlanPrune entscheidet, welche Namen entfernt werden.
func PlanPrune(in PruneInput) PrunePlan {
	if !in.Policy.Enabled {
		return PrunePlan{Skipped: "Das Aufraeumen abgeloester Abbilder ist " +
			"ausgeschaltet (" + in.Policy.Source + ")."}
	}

	keep := map[string]bool{}
	for _, id := range append(append([]string{}, in.InUse...), in.Protected...) {
		if s := strings.TrimSpace(id); s != "" {
			keep[s] = true
		}
	}

	// Eine Kennung kann mehrere Namen tragen; entschieden wird ueber die
	// Kennung, entfernt ueber jeden ihrer Namen.
	byID := map[string][]ImageRecord{}
	var order []string
	for _, img := range in.Images {
		id := strings.TrimSpace(img.ID)
		if id == "" {
			continue
		}
		// Guerteltier: was im Rueckfall-Namensraum liegt, wird nie entfernt -
		// auch dann nicht, wenn sein Halter-Container fehlen sollte. `docker`
		// selbst schuetzt hier NICHT: einen Tag abzuhaengen gelingt auch bei
		// vorhandenem Container, solange ein anderer Name bleibt.
		if strings.HasPrefix(img.Repo, LKGTagPrefix) {
			keep[id] = true
		}
		if _, seen := byID[id]; !seen {
			order = append(order, id)
		}
		byID[id] = append(byID[id], img)
	}

	// Die Kulanz wird JE REPOSITORY vergeben (siehe PrunePolicy.KeepReleases).
	superseded := map[string]bool{}
	for _, id := range in.Superseded {
		if s := strings.TrimSpace(id); s != "" {
			superseded[s] = true
		}
	}
	var repos []string
	candByRepo := map[string][]string{}
	seenInRepo := map[string]map[string]bool{}
	for _, img := range in.Images {
		id := strings.TrimSpace(img.ID)
		if id == "" || keep[id] {
			continue
		}
		if _, ok := candByRepo[img.Repo]; !ok {
			repos = append(repos, img.Repo)
			seenInRepo[img.Repo] = map[string]bool{}
		}
		if seenInRepo[img.Repo][id] {
			continue
		}
		seenInRepo[img.Repo][id] = true
		candByRepo[img.Repo] = append(candByRepo[img.Repo], id)
	}

	plan := PrunePlan{}
	spared := map[string]bool{}
	for _, repo := range repos {
		cand := candByRepo[repo]
		sort.SliceStable(cand, func(i, j int) bool {
			return pruneRankLess(cand[i], cand[j], superseded, byID)
		})
		n := in.Policy.KeepReleases
		if n > len(cand) {
			n = len(cand)
		}
		for _, id := range cand[:n] {
			if !spared[id] {
				spared[id] = true
				plan.Keep = append(plan.Keep, id)
			}
		}
	}

	// Eine Kennung, die in EINEM Repository aufgehoben wird, bleibt ueberall -
	// sonst widerspraechen sich zwei Gruppen ueber dasselbe Abbild.
	for _, id := range order {
		if keep[id] || spared[id] {
			continue
		}
		for _, rec := range byID[id] {
			for _, ref := range rec.Refs() {
				plan.Remove = append(plan.Remove, PruneRemoval{Ref: ref, ID: id, Repo: rec.Repo})
			}
		}
	}
	return plan
}

// pruneRankLess ordnet die Kandidaten: der zuletzt abgeloeste Stand zuerst,
// dann nach Bau-Zeit absteigend, unbekannte Bau-Zeit gilt als neu, zuletzt die
// Kennung - damit die Reihenfolge deterministisch ist und ein Test sie
// festnageln kann.
func pruneRankLess(a, b string, superseded map[string]bool, byID map[string][]ImageRecord) bool {
	if superseded[a] != superseded[b] {
		return superseded[a]
	}
	ta, tb := newestCreated(byID[a]), newestCreated(byID[b])
	if ta.IsZero() != tb.IsZero() {
		return ta.IsZero()
	}
	if !ta.Equal(tb) {
		return ta.After(tb)
	}
	return a < b
}

func newestCreated(recs []ImageRecord) time.Time {
	var out time.Time
	for _, r := range recs {
		if r.Created.After(out) {
			out = r.Created
		}
	}
	return out
}
