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
