package otaapply

// Die Inverter-Neutral-Zeit T - die eine EXTERNE Abhaengigkeit der Autonomie
// (Scout vp-ota-rollout-h4 §10, Vorentwurf §3 „failsafe backstop").
//
// # Worum es geht
//
// Waehrend eines Tausches ist fuer Sekunden keine Software da, die einen
// Sollwert erneuert. Sequenzierung sorgt dafuer, dass in einem GESUNDEN Tausch
// immer eine der beiden Failsafe-Kopien (Kern bzw. Node-RED) lebt. Fuer den
// Fall, dass die getauschte Komponente sich AUFHAENGT, gibt es nur noch EINEN
// Rueckhalt: der Wechselrichter selbst faellt nach seiner Kommunikations-
// Verlust-Zeit T von sich aus auf neutral zurueck. Die Wachhund-Frist muss
// deshalb STRIKT unter T liegen - sonst kann ein Haenger T ueberleben und die
// Batterie bliebe auf dem letzten Kommando stehen.
//
// # Warum hier heute NICHTS verifiziert ist
//
// Fuer keine der gefahrenen Familien liegt eine belegte Messung von T vor. Der
// Vorentwurf ist dazu unmissverstaendlich: „No family ships autonomous OTA on
// the unproven assumption that it holds its last command for seconds." Also
// gilt hier: **eine Familie ohne verifiziertes T bekommt kein autonomes
// Anwenden, solange dieses Geraet wirklich steuert.**
//
// Die heutige Flotte LIEST nur (keine Freigabe erteilt, Not-Aus greift), und
// eine Anlage ohne Steuerpfad hat kein gehaltenes Kommando, das T ueberleben
// koennte. Genau diese Unterscheidung trifft [Decide] ueber
// CoreSignal.ControlActive - der Mechanismus ist von Anfang an richtig, ohne
// die read-only-Flotte grundlos auszusperren.
//
// # Wie eine Familie verifiziert wird
//
// Am Pruefstand (docs/ota-autonomie.md §T): Steuerung aktiv, Verbindung
// abreissen lassen, messen, ab wann der Wechselrichter nachweislich neutral
// ist. Das Ergebnis traegt der Betreiber als `VP_OTA_NEUTRAL_VERIFIED`
// ein - dieselbe Betreiber-Oberflaeche wie `VP_CONTROL_CERTIFIED_FAMILIES`,
// bewusst NICHT die `.env` des Kunden-Installers.

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// DefaultNeutralT ist die konservative Annahme fuer eine NICHT verifizierte
// Familie. Sie wird nur zur Fristberechnung benutzt und ersetzt die
// Verifikation NIE - `Verified:false` bleibt eine Sperre.
const DefaultNeutralT = 60 * time.Second

// NeutralRecord ist EIN gemessener, belegter Nachweis fuer eine Familie - das
// geraete-lokale Gegenstueck zu einem Eintrag in VP_OTA_NEUTRAL_VERIFIED,
// erzeugt vom gefuehrten First-Light-Neutral-Zeit-Test auf `:8484`
// (internal/neutralcal) statt von einer Pruefstands-Sitzung.
//
// Er ist eine SOFTWARE-Naeherung des Pruefstand-Verfahrens (das den Link
// physisch trennt) - gemessen wird das Verhalten, wenn schlicht niemand mehr
// den Sollwert auffrischt, nicht ein echter Kommunikationsabriss. Das ist
// exakt der Ausfall, den OTA Stufe 3 ueberleben muss (ein haengender Tausch),
// weshalb der Nachweis trotzdem tragfaehig ist.
type NeutralRecord struct {
	Family     string `json:"family"`
	Seconds    int    `json:"seconds"`
	MeasuredAt string `json:"measured_at"`
	// TestKw/SettleSamples sind Diagnose (was wurde befohlen, wie viele
	// Messwerte haben den Rueckfall belegt) - fuer die Torkette irrelevant.
	TestKw        float64 `json:"test_kw,omitempty"`
	SettleSamples int     `json:"settle_samples,omitempty"`
}

// FileNeutralEvidence ist die Protokolldatei der geraete-lokal GEMESSENEN
// Neutral-Zeiten (ota/neutral-verified.json) - eine Zeile je Familie, damit
// ein Wechsel des Wechselrichter-Modells nie die Messung des alten Geraets
// erbt.
const FileNeutralEvidence = "neutral-verified.json"

// neutralEvidenceVersion ist die Schema-Version der Datei, damit ein
// kuenftiger Aenderungsbedarf (etwa strengere Beweisregeln) alte Eintraege
// beim Laden verwerfen kann, statt sie stillschweigend weiterzuverwenden -
// dasselbe Muster wie calibrationCertVersion in agent/calibration.go.
const neutralEvidenceVersion = 1

// NeutralEvidenceFile ist die Form der Protokolldatei.
type NeutralEvidenceFile struct {
	Version int                      `json:"version"`
	Records map[string]NeutralRecord `json:"records"`
}

// LoadNeutralEvidence liest die geraete-lokal gemessenen Nachweise. Eine
// fehlende, unlesbare oder zu alte Datei ergibt eine LEERE Tabelle - niemals
// ein erfundener Beleg (derselbe fail-closed-Vorsatz wie jede andere Datei in
// diesem Paket).
func LoadNeutralEvidence(dataDir string) map[string]NeutralRecord {
	f, err := ReadJSON[NeutralEvidenceFile](dataDir, FileNeutralEvidence)
	if err != nil || f == nil || f.Version != neutralEvidenceVersion {
		return nil
	}
	return f.Records
}

// SaveNeutralRecord traegt EINEN gemessenen Nachweis ein (ersetzt einen
// vorherigen fuer dieselbe Familie). Sie fasst NIE einen Nicht-Erfolg an - der
// Aufrufer (agent/neutral.go) ruft sie ausschliesslich fuer einen
// `neutralcal.VerdictPassed` mit einer gemessenen Sekundenzahl auf.
func SaveNeutralRecord(dataDir string, rec NeutralRecord) error {
	fam := strings.ToLower(strings.TrimSpace(rec.Family))
	if fam == "" {
		return fmt.Errorf("ein Nachweis ohne Familie kann nicht gespeichert werden")
	}
	if rec.Seconds <= 0 {
		return fmt.Errorf("ein Nachweis ohne gemessene Sekundenzahl kann nicht gespeichert werden")
	}
	rec.Family = fam
	records := LoadNeutralEvidence(dataDir)
	out := make(map[string]NeutralRecord, len(records)+1)
	for k, v := range records {
		out[k] = v
	}
	out[fam] = rec
	return WriteJSON(dataDir, FileNeutralEvidence, NeutralEvidenceFile{
		Version: neutralEvidenceVersion, Records: out,
	})
}

// NeutralTimeout ist die aufgeloeste Aussage ueber EINE Familie.
type NeutralTimeout struct {
	Family   string
	T        time.Duration
	Verified bool
	// Note ist der deutsche Klartext fuer jede Oberflaeche.
	Note string
}

// NeutralTable ist die aufgeloeste Tabelle (Familie -> Aussage).
type NeutralTable struct {
	verified map[string]time.Duration
}

// ParseNeutralTable liest die Betreiber-Angabe `familie:sekunden[,…]`.
//
// Bewusst streng: ein unlesbarer Eintrag wird ABGELEHNT statt ignoriert. Eine
// stillschweigend verworfene Zeile hiesse „nicht verifiziert", waehrend der
// Betreiber glaubt, verifiziert zu haben - der teuerste Irrtum, den diese
// Tabelle haben kann.
func ParseNeutralTable(spec string) (*NeutralTable, error) {
	t := &NeutralTable{verified: map[string]time.Duration{}}
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		fam, secs, ok := strings.Cut(part, ":")
		fam = strings.ToLower(strings.TrimSpace(fam))
		if !ok || fam == "" {
			return nil, fmt.Errorf("'%s' ist kein Eintrag der Form familie:sekunden", part)
		}
		n, err := strconv.Atoi(strings.TrimSpace(secs))
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("'%s': die Neutral-Zeit muss eine positive Sekundenzahl sein", part)
		}
		if n > 3600 {
			return nil, fmt.Errorf("'%s': eine Neutral-Zeit ueber einer Stunde ist kein Rueckhalt", part)
		}
		t.verified[fam] = time.Duration(n) * time.Second
	}
	return t, nil
}

// Families listet die verifizierten Familien (stabil sortiert, fuer Logs).
func (t *NeutralTable) Families() []string {
	if t == nil {
		return nil
	}
	out := make([]string, 0, len(t.verified))
	for f := range t.verified {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}

// For loest die Aussage fuer EINE Familie auf.
func (t *NeutralTable) For(family string) NeutralTimeout {
	fam := strings.ToLower(strings.TrimSpace(family))
	if fam == "" {
		return NeutralTimeout{
			Family: "", T: DefaultNeutralT, Verified: false,
			Note: "Es ist kein Wechselrichter ausgewaehlt - die Neutral-Zeit ist damit nicht bewertbar.",
		}
	}
	if t != nil {
		if d, ok := t.verified[fam]; ok {
			return NeutralTimeout{
				Family: fam, T: d, Verified: true,
				Note: fmt.Sprintf("Neutral-Zeit %s am Pruefstand belegt.", d),
			}
		}
	}
	return NeutralTimeout{
		Family: fam, T: DefaultNeutralT, Verified: false,
		Note: fmt.Sprintf("Fuer die Familie '%s' ist die Neutral-Zeit des Wechselrichters "+
			"NICHT verifiziert.", fam),
	}
}

// ForWithMeasured loest die Aussage fuer eine Familie wie [For] auf, zieht
// aber zusaetzlich einen geraete-lokal GEMESSENEN Nachweis heran
// ([NeutralRecord], typischerweise aus [LoadNeutralEvidence]), wenn die
// Betreiber-Tabelle (VP_OTA_NEUTRAL_VERIFIED) fuer diese Familie KEINEN
// Eintrag traegt.
//
// Der Vorrang ist ABSICHTLICH und EINSEITIG: ein Tabellen-Eintrag gewinnt
// IMMER, auch wenn er kleiner ist als der gemessene Wert - ein Betreiber, der
// eine Pruefstands-Zahl eingetragen hat (docs/ota-autonomie.md §3: „mehrfach
// wiederholen, den GROESSTEN Wert nehmen"), hat bereits die konservative,
// wiederholte Messung gemacht, die dieses Paket nicht besser wissen kann. Nur
// wenn die Tabelle schweigt, oeffnet die eigene gefuehrte Messung der Box das
// Tor.
func (t *NeutralTable) ForWithMeasured(family string, measured map[string]NeutralRecord) NeutralTimeout {
	fam := strings.ToLower(strings.TrimSpace(family))
	if fam == "" {
		return t.For(family)
	}
	if t != nil {
		if _, ok := t.verified[fam]; ok {
			return t.For(family) // die Betreiber-Angabe gewinnt unveraendert.
		}
	}
	if rec, ok := measured[fam]; ok && rec.Seconds > 0 {
		d := time.Duration(rec.Seconds) * time.Second
		return NeutralTimeout{
			Family: fam, T: d, Verified: true,
			Note: fmt.Sprintf("Neutral-Zeit %s am Geraet per gefuehrtem First-Light-Test "+
				"gemessen (%s).", d, rec.MeasuredAt),
		}
	}
	return t.For(family)
}

// WatchdogMargin ist der Sicherheitsabstand unter T.
//
// Ein Fuenftel von T, mindestens fuenf Sekunden: die Frist muss auch dann noch
// unter T liegen, wenn das Zuruecknehmen selbst ein paar Sekunden braucht.
func WatchdogMargin(t time.Duration) time.Duration {
	m := t / 5
	if m < 5*time.Second {
		m = 5 * time.Second
	}
	return m
}

// MinWatchdogDeadline ist die harte Untergrenze. Kuerzer waere keine Frist,
// sondern ein garantierter Fehlschlag (ein Container-Start dauert Sekunden).
const MinWatchdogDeadline = 15 * time.Second

// WatchdogDeadline berechnet die Frist fuer EINEN Vorgang.
//
//   - Steuert das Geraet NICHT, gibt es kein gehaltenes Kommando, das T
//     ueberleben koennte - dann gilt die konfigurierte Frist unveraendert.
//   - Steuert es, wird die Frist auf `T - Marge` gedeckelt. Das ist die
//     Zusage „ein Haenger kann den Rueckfall des Wechselrichters nie
//     ueberleben", und sie ist Arithmetik, keine Absicht.
//
// Die Untergrenze [MinWatchdogDeadline] gewinnt zuletzt: ein absurd kleines T
// wuerde sonst eine Frist erzeugen, die JEDER Tausch reisst. Ein T, das die
// Untergrenze nicht traegt, ist deshalb ein Fall fuer [Decide] (die Familie
// wird abgelehnt), nicht fuer eine unmoegliche Frist.
func WatchdogDeadline(n NeutralTimeout, controlActive bool, configured time.Duration) time.Duration {
	if configured < MinWatchdogDeadline {
		configured = MinWatchdogDeadline
	}
	if !controlActive {
		return configured
	}
	capped := n.T - WatchdogMargin(n.T)
	if capped < configured {
		configured = capped
	}
	if configured < MinWatchdogDeadline {
		configured = MinWatchdogDeadline
	}
	return configured
}

// NeutralSupportsWatchdog sagt, ob T ueberhaupt gross genug ist, um darunter
// eine brauchbare Frist zu setzen. Ist es das nicht, gibt es fuer diese
// Familie kein autonomes Anwenden - auch dann nicht, wenn jemand sie als
// verifiziert eingetragen hat.
func NeutralSupportsWatchdog(n NeutralTimeout) bool {
	return n.T-WatchdogMargin(n.T) >= MinWatchdogDeadline
}
