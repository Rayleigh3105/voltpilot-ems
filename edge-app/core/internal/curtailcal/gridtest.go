// gridtest.go - der begrenzte „Netz-Sollwert-Test" (P1 des Konzepts
// `vp-deye-netzseitig-drossel-k2`): die armierte, TTL-begrenzte, sich selbst
// zuruecknehmende Probe, mit der am ECHTEN Geraet geklaert wird, ob der
// netzseitige Fernsteuermodus des Deye (Register 1104 = 2) tut, was ein
// EINZIGER Feldbericht ueber ein LV-12K-Geraet behauptet - und ob er es auf
// dem HV-30K des Piloten genauso tut.
//
// ER IST DIE SCHWESTER VON curtailcal.Session (dem Fronius-Abregeltest), nicht
// eine zweite Mechanik: armiert, begrenzt, TTL, Beweis durch WIRKUNG statt
// durch ein gehaltenes Register, Freigabe getrennt. Deshalb liegt er in
// DIESEM Paket - dieselbe Disziplin, dieselben Woerter, dieselbe Testform:
//
//   - kein I/O; jede zeitabhaengige Funktion nimmt ihr `now` (deterministische
//     Tests - das Tagesprotokoll/FleetPflege-Muster des Hauses);
//   - der Test ist BEGRENZT (Ziele nie ueber 0 Bezug, Schrittweite 2 kW, SoC-
//     Fenster) und TTL-begrenzt; die Rueckkehr faehrt der Testpfad selbst,
//     und UNABHAENGIG davon der Totmann IM Wechselrichter (1101, 60 s);
//   - „Register gehalten" beweist hier NICHTS. Der Beweis ist die MESSUNG:
//     der Netzpunkt muss dem Ziel ueber ein Plateau folgen (die
//     Klemm-Plateau-Regel des Fronius-Tests, GridPlateauSamples), waehrend die
//     Fronius-Umgebung belegt, dass nicht einfach die Sonne weggegangen ist.
//
// ⚠ WAS ER NICHT IST: ein Produktivpfad. Er wird von Hand armiert, er laeuft
// hoechstens GridDefaultTTL, er schaltet nichts frei, und es gibt keinen Weg,
// aus einem Fahrplan-Slot in den netzseitigen Modus zu kommen. Der
// Produktivpfad ist Paket 3 und wird erst nach dem Live-Test gebaut.
//
// ⚠ DIE VORZEICHEN-KONVENTION, und sie ist der Grund fuer den Halte-Test:
// unser `target_kw` ist die NETZLEISTUNG in der Hauskonvention
// (+ Bezug / − Einspeisung, dieselbe wie `power_kw` ueberall im Repo), und
// das Deye-Register 1109 traegt netzseitig laut Feldbericht dieselbe
// Konvention (− = Einspeisung). Der Umrechnungsschritt ist deshalb DIREKT
// (`units = round(target_kw / rated * 1000)`) und NICHT negiert - anders als
// batterieseitig, wo unser Kontrakt + = laden und das Register − = laden ist.
// Das ist ein FELDBERICHT ueber ein anderes Geraet, also ist der erste
// Testschritt nach dem Umschalten ein HALTE-Test auf den gerade gemessenen
// Export: bewegt sich der Netzpunkt dabei Richtung BEZUG, ist das Vorzeichen
// falsch und der Test bricht ab, bevor irgendetwas Groesseres kommandiert wird.
package curtailcal

import (
	"fmt"
	"math"
	"sort"
	"time"
)

// --- Vokabular ---------------------------------------------------------------

// Die zwei Laeufe. Sie sind BEWUSST getrennt (Captain-Entscheid E1: „AC-seitig
// hoechstens als 60-s-Probe im selben Test, kein Produktivpfad"): die
// netzseitige Semantik (1109 = Netzleistung) und die AC-seitige (1109 =
// AC-Ausgangsleistung des Deye, und dort ist sogar offen, ob 1109 oder 1111
// der Sollwert ist) beantworten VERSCHIEDENE Fragen. In einen Lauf gemischt
// waere ein einzelnes Urteil bedeutungslos, und die 120-s-Huelle des
// netzseitigen Laufs (§3.2/E7) waere verwaessert.
const (
	GridModeGrid = "grid"
	GridModeAc   = "ac"
)

// Die Schritte des Zustandsautomaten (Konzept §3.2).
const (
	// GridStepNeutral - Batterie ruht (1109 ← 0) in der ALTEN, batterieseitigen
	// Semantik. Er ist der Neutralschritt der glitchfreien Umschaltsequenz UND
	// die Messbedingung: der Halte-Sollwert wird am ENDE dieses Schrittes
	// gelatcht, also mit ruhender Batterie.
	GridStepNeutral = "neutral"
	// GridStepHalten - netzseitig, Ziel = der gerade gemessene Netzpunkt.
	// Nichts darf sich bewegen. Das ist der Vorzeichen- und der T8-Test
	// (1115 steht hier noch auf dem Geraetewert).
	GridStepHalten = "halten"
	// GridStepPvKappe - 1115 ← 999 (Captain-Entscheid E5). Erst danach ist die
	// eigene PV des Deye ueberhaupt regelbar, falls die LV-Beobachtung
	// („1000 regelt auf 0") auch fuer HV gilt.
	GridStepPvKappe = "pv_kappe"
	// GridStepSchritt - der kleine, nachweisbare Schritt: 2 kW weniger Export.
	GridStepSchritt = "schritt"
	// GridStepNullExport - der Drossel-Fall: Ziel 0 (Null-Export).
	GridStepNullExport = "null_export"
	// GridStepAcProbe - der AC-seitige Lauf (1104 ← 0), eigener Durchgang.
	GridStepAcProbe = "ac_probe"
	// GridStepRueckkehr - 1109 ← 0, dann 1104 ← 1: zurueck auf die
	// batterieseitige Regelung. Er laeuft nach der TTL, nach einem Abbruch und
	// nach jedem Ausstieg - und er ist der EINZIGE Ausgang.
	GridStepRueckkehr = "rueckkehr"
)

// Die Regelseite (Register 1104), als WORT statt als Zahl: der Adapter
// uebersetzt, damit die Registerkenntnis dort bleibt, wo sie hingehoert.
const (
	GridSideBattery = "battery" // 1104 = 1
	GridSideGrid    = "grid"    // 1104 = 2
	GridSideAc      = "ac"      // 1104 = 0
)

// Urteile. Wortgleich zu den Fronius-Urteilen, wo die Bedeutung dieselbe ist.
const (
	GridVerdictRunning    = "laeuft"
	GridVerdictPassed     = "bestanden"
	GridVerdictUnprovable = "nicht_beweisbar"
	GridVerdictNoProof    = "kein_nachweis"
	GridVerdictAborted    = "abgebrochen"
)

// --- Zeiten und Grenzen ------------------------------------------------------

const (
	// GridDefaultTTL begrenzt den NETZSEITIGEN Teil eines Laufs (Konzept §3.2:
	// „Gesamt netzseitig ≤ 120 s", Test-TTL wie beim Fronius-Test). Die Summe
	// der Schrittdauern unten IST diese Zahl - wer einen Schritt verlaengert,
	// verkuerzt einen anderen.
	GridDefaultTTL = 120 * time.Second
	// GridAcTTL begrenzt den AC-Probelauf (E1: „60-s-Probe").
	GridAcTTL = 60 * time.Second
	// GridReturnGrace ist das Fenster, in dem der Testpfad NACH der TTL (oder
	// nach einem Abbruch) die Rueckkehr faehrt: 1109 ← 0, dann 1104 ← 1. Es ist
	// die Selbst-Ruecknahme, nicht die Aufmerksamkeit des Bedieners - und
	// unabhaengig davon laeuft der Totmann IM Wechselrichter (60 s).
	GridReturnGrace = 30 * time.Second
	// GridConfirmGrace haelt den Beweis nach dem Ende noch bestaetigbar
	// (dieselbe Regel wie ConfirmGrace beim Fronius-Test).
	GridConfirmGrace = 3 * time.Minute
)

// Die Schrittdauern des NETZSEITIGEN Laufs. Summe = GridDefaultTTL.
const (
	gridDurNeutral    = 20 * time.Second
	gridDurHalten     = 20 * time.Second
	gridDurPvKappe    = 5 * time.Second
	gridDurSchritt    = 30 * time.Second
	gridDurNullExport = 45 * time.Second
)

// Die Schrittdauern des AC-Laufs. Summe = GridAcTTL.
const (
	gridDurAcNeutral = 15 * time.Second
	gridDurAcProbe   = 45 * time.Second
)

const (
	// GridMinSitePvKw / GridMinDeyePvKw / GridPvJumpKw / GridPvStableFor sind
	// die „Sonne stabil"-Bedingung aus §3.1: die Drosselung muss sich von einer
	// Wolke unterscheiden lassen (die zwei Fehlpositive der Fronius-Freigabe).
	GridMinSitePvKw = 25.0
	GridMinDeyePvKw = 8.0
	GridPvJumpKw    = 3.0
	GridPvStableFor = 60 * time.Second
	// GridMinExportKw - unter so wenig Export ist der 2-kW-Schritt nicht von
	// Rauschen zu unterscheiden, und der Halte-Test haette nichts zu halten.
	GridMinExportKw = 4.0
	// GridStepKw ist der kleine, nachweisbare Schritt (§3.2 Schritt 5).
	GridStepKw = 2.0
	// Das SoC-Fenster (§3.1): nicht voll (sonst sieht man nur PV-Drosselung
	// statt der Akku-zuerst-Reihenfolge), nicht am Boden (der netzseitige
	// Modus DARF entladen, und die geraeteeigenen SoC-Grenzen greifen im
	// Fernsteuermodus laut Feldbericht nicht).
	GridSocMinPct = 25.0
	GridSocMaxPct = 80.0
	// GridMeasurementMaxAge - aelter als das ist keine Messung mehr (§3.5).
	GridMeasurementMaxAge = 15 * time.Second
	// GridPlateauSamples - so viele AUFEINANDERFOLGENDE Messwerte im Band um
	// das Ziel machen den Beweis (die Plateau-Regel des Fronius-Tests; bei
	// ~5-10 s Telemetrie-Takt sind das 15-30 s auf dem Ziel).
	GridPlateauSamples = 3
	// GridRegisterHoldFresh - eine Register-Bestaetigung, die aelter ist,
	// belegt nicht mehr „das Ziel steht gerade".
	GridRegisterHoldFresh = 30 * time.Second
	// GridBadCyclesAbort - zwei aufeinanderfolgende Rueckmelde-Zyklen ohne
	// Bestaetigung brechen ab (§3.5).
	GridBadCyclesAbort = 2
	// Die Abbruch-Huelle (§3.5). GridOutOfBandGrace ist die 10 s, die ein
	// Ausreisser zurueckkommen darf, bevor abgebrochen wird.
	GridMaxExportKw    = 33.0
	GridMaxImportKw    = 5.0
	GridMaxBatteryKw   = 25.0
	GridAbortSocMinPct = 20.0
	GridAbortSocMaxPct = 95.0
	GridOutOfBandGrace = 10 * time.Second
	// GridAmbientDropFrac - faellt die Fronius-Umgebung um mehr als das,
	// zieht eine Wolke durch: der Test ist „nicht beweisbar", nicht
	// „durchgefallen" (die Fronius-Freigabe-Regel).
	GridAmbientDropFrac = 0.30
	// GridSignMarginKw - bewegt sich der Netzpunkt im Halte-Test um mehr als
	// das Richtung BEZUG, ist das Vorzeichen falsch.
	GridSignMarginKw = 2.0
	// GridPvCapPermille ist der Wert, den der Test auf 1115 schreibt: 999 =
	// 99,9 % der Nennleistung. NICHT 1000 - laut Feldbericht regelt der
	// Wechselrichter bei 1000 und daruber die eigene PV auf 0.
	GridPvCapPermille = 999
)

// gridPlateauTolerance ist das Band um das Ziel, in dem ein Messwert als „auf
// dem Ziel" zaehlt (Regelabweichung, Messrauschen, die ~30-W-Quantisierung des
// Registers). §3.4 nennt ±0,5 kW; der relative Anteil traegt groessere Ziele.
func gridPlateauTolerance(targetKw float64) float64 {
	return math.Max(0.5, 0.02*math.Abs(targetKw))
}

// --- Eingaben ----------------------------------------------------------------

// GridConditions sind die Tatsachen, die der Kern zum Armieren beibringt. Der
// Zustandsautomat prueft sie ALLE (§3.1) und lehnt mit einem deutschen Grund
// ab - die Karte spiegelt die Regel nur, entschieden wird hier.
type GridConditions struct {
	Mode string
	// ControlEnabled/Certified/RemotePath sind die drei Tore, die auch der
	// gewoehnliche Schreibpfad passieren muss. Der Test hebt KEINES davon auf.
	ControlEnabled bool
	Certified      bool
	RemotePath     bool
	// RatedKw ist die Nennleistung aus dem Katalog - ohne sie gibt es keinen
	// Sollwert (er ist 0,1 % davon), nie eine geratene Zahl.
	RatedKw float64
	// MeasurementAge ist das Alter der juengsten Messung.
	MeasurementAge time.Duration
	// Die Messgroessen. nil = unbekannt, NIE eine erfundene 0.
	GridKw      *float64 // Netzpunkt, + Bezug / − Einspeisung
	SitePvKw    *float64 // Anlagen-PV (Verbund)
	DeyePvKw    *float64 // Anlagen-PV minus frische Fronius-PV = der Deye-Anteil
	FroniusPvKw *float64 // die Umgebungs-Referenz
	BatteryKw   *float64 // + laden / − entladen
	SocPct      *float64
	// PvStableFor - wie lange die Anlagen-PV schon ohne Sprung > GridPvJumpKw
	// laeuft (GridPvTracker).
	PvStableFor time.Duration
	// PlanBatteryOk: der Fahrplan will im laufenden UND im naechsten Slot
	// laden oder ruhen. PlanNative: es ist ein Selbstregel-Slot (schliesst
	// sich mit dem Netzmodus aus).
	PlanBatteryOk bool
	PlanNative    bool
	// FroniusHealthy: beide Einheiten freigegeben, Rueckmeldung haelt, kein
	// Fremdregler. FroniusNote traegt den Grund, wenn nicht.
	FroniusHealthy bool
	FroniusNote    string
}

// GridObservation ist ein Messtakt waehrend des Tests.
type GridObservation struct {
	GridKw      *float64
	SitePvKw    *float64
	DeyePvKw    *float64
	FroniusPvKw *float64
	BatteryKw   *float64
	SocPct      *float64
	Age         time.Duration
}

// --- Der laufende Test -------------------------------------------------------

// GridTest ist EIN begrenzter Lauf.
type GridTest struct {
	Mode      string
	RatedKw   float64
	StartedAt time.Time
	Deadline  time.Time

	// Die Ausgangslage, gemessen beim Armieren (E0/D0/F0/B0/SoC in §3.2
	// Schritt 0). Sie ist der Massstab jeder spaeteren Aussage.
	BaseGridKw    float64
	BaseSitePvKw  float64
	BaseDeyePvKw  float64
	BaseFroniusKw float64
	BaseSocPct    float64

	// holdTargetKw wird am ENDE des Neutralschritts gelatcht - mit RUHENDER
	// Batterie, denn genau darauf zielt der Halte-Test. (Bewusste Praezisierung
	// gegenueber §3.2, das E0 aus Schritt 0 nennt: Schritt 1 aendert den Export
	// um die Batterieleistung, ein Halte-Ziel von VOR dem Neutralschritt waere
	// also gar kein Halte-Ziel.)
	holdTargetKw *float64
	// acTargetKw ist das Ziel des AC-Laufs: die gemessene Deye-PV minus
	// GridStepKw, nie darueber - ein Ziel ueber der verfuegbaren PV wuerde die
	// Batterie entladen (E1).
	acTargetKw *float64

	// lastSide ist die zuletzt VEROEFFENTLICHTE Regelseite. Der Neutralschritt
	// (1109 ← 0 vor 1104) wird genau bei einem Wechsel emittiert - nicht in
	// jedem Takt, sonst blinkte der Sollwert bei jedem Takt auf Null-Export.
	lastSide string
	// pvCapWritten latcht, ab wann 1115 ← 999 zum Plan gehoert.
	pvCapWritten bool

	registerConfirmed bool
	registerHeldAt    time.Time
	badCycles         int

	// Der Beweis: das laengste Plateau je Schritt, und ob ueberhaupt eines
	// zustande kam. plateauRun laeuft, plateauBest merkt sich.
	plateauRun  int
	plateauBest map[string]int

	// ambientCollapsed latcht, wenn die Fronius-Umgebung eingebrochen ist:
	// danach kann nichts Beobachtetes mehr etwas beweisen.
	ambientCollapsed bool
	lastAmbientKw    *float64

	// Beobachtungs-Extrema, rein informativ fuer das Protokoll.
	minGridKw   *float64
	maxGridKw   *float64
	minDeyePvKw *float64

	// outOfBandSince: seit wann der Netzpunkt ausserhalb der Abbruch-Huelle
	// liegt (er darf GridOutOfBandGrace lang zurueckkommen).
	outOfBandSince time.Time

	// nullExportUnreachable latcht, wenn im Null-Export-Schritt der Deye
	// nachweislich am Ende ist und die Fronius allein den Rest exportieren:
	// das ist ERWARTET (§3.6) und kein Fehlschlag.
	nullExportUnreachable bool

	aborted     bool
	abortedAt   time.Time
	abortReason string
	// unprovable latcht die „nicht beweisbar"-Lage (Wolkenzug).
	unprovable bool
}

// GridCommand ist, was der Sollwert in diesem Takt tragen soll. Er ist die
// GANZE Anweisung an Layer 1 - der Adapter uebersetzt sie in Register.
type GridCommand struct {
	Mode string `json:"mode"`
	Step string `json:"step"`
	Side string `json:"side"`
	// TargetKw ist der Sollwert dieses Schrittes in kW. Netzseitig ist es die
	// NETZLEISTUNG (+ Bezug / − Einspeisung), AC-seitig die AC-Ausgangsleistung
	// des Deye. nil = kein Sollwert (der Neutralschritt schreibt 0, das ist
	// eine 0 und kein nil - siehe Neutral).
	TargetKw *float64 `json:"target_kw,omitempty"`
	// Neutralize: dieser Takt wechselt die Regelseite, also muss 1109 VOR 1104
	// auf 0 (die glitchfreie Sequenz, Konzept §2.9). Nur dann.
	Neutralize bool `json:"neutralize,omitempty"`
	// PvCapPermille ist 1115: ab dem pv_kappe-Schritt 999. nil = nicht
	// schreiben (der Wert des Geraets bleibt, und genau das ist die
	// T8-Beobachtung des Halte-Schrittes).
	PvCapPermille *int `json:"pv_cap_permille,omitempty"`
	// SecondsRemaining bis zur TTL (0 in der Rueckkehr).
	SecondsRemaining int `json:"seconds_remaining"`
}

// --- Die Sitzung -------------------------------------------------------------

// GridSession haelt hoechstens EINEN laufenden/juengsten Netz-Sollwert-Test.
type GridSession struct {
	test *GridTest
}

// NewGrid baut eine leere Sitzung.
func NewGrid() *GridSession { return &GridSession{} }

func gridInvalid(format string, a ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, a...)}
}

func gridTTL(mode string) time.Duration {
	if mode == GridModeAc {
		return GridAcTTL
	}
	return GridDefaultTTL
}

// Start armiert einen Lauf. ERST pruefen, DANN anlegen: eine abgelehnte
// Anfrage hinterlaesst keinen halben Test.
func (s *GridSession) Start(cond GridConditions, now time.Time) (*GridTest, error) {
	mode := cond.Mode
	if mode == "" {
		mode = GridModeGrid
	}
	if mode != GridModeGrid && mode != GridModeAc {
		return nil, gridInvalid("Unbekannte Testart. Möglich sind „netzseitig\" und „AC-seitig\".")
	}
	if s.Engaged(now) {
		return nil, gridInvalid("Es läuft bereits ein Netz-Sollwert-Test. Bitte abwarten oder abbrechen.")
	}
	if !cond.ControlEnabled {
		return nil, gridInvalid("Die Wechselrichter-Steuerung ist als Sicherheitsvorgabe deaktiviert (Not-Aus). Test nicht möglich.")
	}
	if !cond.Certified {
		return nil, gridInvalid("Die Steuerung dieses Wechselrichter-Modells ist noch nicht freigegeben. Der Test schreibt echte Register und braucht dieselbe Freigabe wie der Fahrplan.")
	}
	if !cond.RemotePath {
		return nil, gridInvalid("Dieser Wechselrichter wird gerade nicht über die Fernsteuerung (Register 1100-1121) geregelt. Der netzseitige Modus lebt in genau diesem Registerblock.")
	}
	if !(cond.RatedKw > 0) {
		return nil, gridInvalid("Die Nennleistung des Modells ist unbekannt - ohne sie gibt es keinen Sollwert (er ist 0,1 %% der Nennleistung). Bitte das genaue Modell auswählen.")
	}
	if cond.MeasurementAge > GridMeasurementMaxAge {
		return nil, gridInvalid("Die Messwerte sind älter als %d Sekunden. Ohne frische Messung ist der Test nicht auswertbar.", int(GridMeasurementMaxAge/time.Second))
	}
	if cond.PlanNative {
		return nil, gridInvalid("Gerade läuft die Wechselrichter-Automatik (Selbstregel-Modus). Sie und der netzseitige Modus schließen sich aus.")
	}
	if !cond.PlanBatteryOk {
		return nil, gridInvalid("Der Fahrplan will den Speicher gerade (oder im nächsten Slot) entladen. Im netzseitigen Modus führt der Wechselrichter die Batterie selbst - der Test läuft nur in Slots, die laden oder ruhen.")
	}
	if !cond.FroniusHealthy {
		note := cond.FroniusNote
		if note == "" {
			note = "Die Fronius-Wechselrichter melden gerade keine bestätigte Abregelung."
		}
		return nil, gridInvalid("Die Fronius-Seite ist nicht in einem ruhigen Zustand: %s Während des Tests müssen die Fronius-Kappen bleiben, wie sie sind.", note)
	}
	if cond.SitePvKw == nil || cond.DeyePvKw == nil || cond.FroniusPvKw == nil || cond.GridKw == nil || cond.SocPct == nil {
		return nil, gridInvalid("Für den Test fehlen Messwerte (Anlagen-PV, Deye-Anteil, Fronius, Netzpunkt und Ladestand müssen alle vorliegen).")
	}
	if *cond.SitePvKw < GridMinSitePvKw {
		return nil, gridInvalid("Die Anlage liefert gerade %.1f kW - für einen aussagekräftigen Test sind mindestens %.0f kW nötig. Bitte bei mehr Sonne erneut versuchen.", *cond.SitePvKw, GridMinSitePvKw)
	}
	if *cond.DeyePvKw < GridMinDeyePvKw {
		return nil, gridInvalid("Der Deye liefert gerade nur %.1f kW eigene PV - unter %.0f kW wäre eine Drosselung nicht von einer Wolke zu unterscheiden.", *cond.DeyePvKw, GridMinDeyePvKw)
	}
	if cond.PvStableFor < GridPvStableFor {
		return nil, gridInvalid("Die Erzeugung schwankt gerade (sie ist erst %d s ohne Sprung über %.0f kW; nötig sind %d s). Bitte bei ruhigerem Himmel erneut versuchen.", int(cond.PvStableFor/time.Second), GridPvJumpKw, int(GridPvStableFor/time.Second))
	}
	if *cond.SocPct < GridSocMinPct || *cond.SocPct > GridSocMaxPct {
		return nil, gridInvalid("Der Ladestand liegt bei %.0f %% - der Test braucht %.0f-%.0f %%: nicht voll (sonst zeigt sich nur die PV-Drosselung) und nicht am Boden (der netzseitige Modus darf entladen).", *cond.SocPct, GridSocMinPct, GridSocMaxPct)
	}
	if mode == GridModeGrid {
		export := -*cond.GridKw
		if export < GridMinExportKw {
			return nil, gridInvalid("Die Anlage speist gerade nur %.1f kW ein - unter %.0f kW gäbe es weder einen Halte-Punkt noch einen unterscheidbaren %.0f-kW-Schritt.", math.Max(0, export), GridMinExportKw, GridStepKw)
		}
	}

	t := &GridTest{
		Mode:          mode,
		RatedKw:       cond.RatedKw,
		StartedAt:     now,
		Deadline:      now.Add(gridTTL(mode)),
		BaseGridKw:    *cond.GridKw,
		BaseSitePvKw:  *cond.SitePvKw,
		BaseDeyePvKw:  *cond.DeyePvKw,
		BaseFroniusKw: *cond.FroniusPvKw,
		BaseSocPct:    *cond.SocPct,
		plateauBest:   map[string]int{},
		// Der Test uebernimmt einen Wechselrichter, der batterieseitig faehrt -
		// das ist die Ausgangsseite, und daraus folgt, wann der Neutralschritt
		// emittiert wird.
		lastSide: GridSideBattery,
	}
	s.test = t
	return t, nil
}

// Abort beendet den Lauf sofort. Die Rueckkehr faehrt danach noch
// GridReturnGrace lang (1109 ← 0, dann 1104 ← 1) - abbrechen heisst
// zuruecknehmen, nicht aufhoeren zu schreiben.
func (s *GridSession) Abort(reason string, now time.Time) {
	t := s.test
	if t == nil || t.aborted {
		return
	}
	t.aborted = true
	t.abortedAt = now
	t.abortReason = reason
}

// Active meldet, ob der Lauf noch in seinen Testschritten steht.
func (s *GridSession) Active(now time.Time) bool {
	t := s.test
	return t != nil && !t.aborted && !now.After(t.Deadline)
}

// Engaged meldet, ob der Testpfad den Sollwert gerade besitzt - das schliesst
// die Rueckkehr ausdruecklich EIN (dieselbe Regel wie calibration.Engaged: das
// Zuruecknehmen gehoert zum Test, nicht zum Danach).
func (s *GridSession) Engaged(now time.Time) bool {
	t := s.test
	if t == nil {
		return false
	}
	return now.Before(t.returnEnd())
}

// returnEnd ist das Ende des Rueckkehr-Fensters.
func (t *GridTest) returnEnd() time.Time {
	if t.aborted {
		return t.abortedAt.Add(GridReturnGrace)
	}
	return t.Deadline.Add(GridReturnGrace)
}

// stepAt leitet den Schritt aus der verstrichenen Zeit ab. Rein - derselbe
// Zeitpunkt liefert immer denselben Schritt.
func (t *GridTest) stepAt(now time.Time) string {
	if t.aborted || now.After(t.Deadline) {
		return GridStepRueckkehr
	}
	d := now.Sub(t.StartedAt)
	if t.Mode == GridModeAc {
		if d < gridDurAcNeutral {
			return GridStepNeutral
		}
		return GridStepAcProbe
	}
	switch {
	case d < gridDurNeutral:
		return GridStepNeutral
	case d < gridDurNeutral+gridDurHalten:
		return GridStepHalten
	case d < gridDurNeutral+gridDurHalten+gridDurPvKappe:
		return GridStepPvKappe
	case d < gridDurNeutral+gridDurHalten+gridDurPvKappe+gridDurSchritt:
		return GridStepSchritt
	default:
		return GridStepNullExport
	}
}

func gridSideOf(step string) string {
	switch step {
	case GridStepHalten, GridStepPvKappe, GridStepSchritt, GridStepNullExport:
		return GridSideGrid
	case GridStepAcProbe:
		return GridSideAc
	default:
		return GridSideBattery
	}
}

// targetFor liefert den Sollwert des Schrittes. Er ist nil, solange das
// Halte-/AC-Ziel noch nicht gelatcht ist - dann faellt der Schritt auf den
// Neutralschritt zurueck statt ein Ziel zu erfinden.
func (t *GridTest) targetFor(step string) *float64 {
	zero := 0.0
	switch step {
	case GridStepNeutral, GridStepRueckkehr:
		return &zero
	case GridStepHalten, GridStepPvKappe:
		return t.holdTargetKw
	case GridStepSchritt:
		if t.holdTargetKw == nil {
			return nil
		}
		// 2 kW WENIGER Export: der Netzpunkt wandert Richtung 0, also PLUS in
		// unserer Konvention (− = Einspeisung). Nie ueber 0 - ein positives
		// Ziel waere ein BEZUGS-Ziel, und der Deye wuerde die Batterie aus dem
		// Netz laden (EEG-Sicherheit durch Konstruktion, §1.9 Vermutung 4).
		v := math.Min(0, *t.holdTargetKw+GridStepKw)
		return &v
	case GridStepNullExport:
		return &zero
	case GridStepAcProbe:
		return t.acTargetKw
	}
	return nil
}

// Publish liefert die Anweisung fuer GENAU DIESEN Sollwert-Takt und latcht
// dabei die Regelseite - der Neutralschritt (1109 ← 0 vor 1104) wird deshalb
// genau bei einem Seitenwechsel emittiert und nie in jedem Takt.
//
// Das zweite Rueckgabe-Flag ist false, wenn der Testpfad den Sollwert nicht
// (mehr) besitzt.
func (s *GridSession) Publish(now time.Time) (GridCommand, bool) {
	t := s.test
	if t == nil || !now.Before(t.returnEnd()) {
		return GridCommand{}, false
	}
	step := t.stepAt(now)
	side := gridSideOf(step)
	if step == GridStepPvKappe || step == GridStepSchritt || step == GridStepNullExport || step == GridStepAcProbe {
		t.pvCapWritten = true
	}
	target := t.targetFor(step)
	// Ein Schritt, dessen Ziel noch nicht feststeht (der Neutralschritt hat
	// keinen Messwert geliefert), faellt auf die batterieseitige Ruhe zurueck.
	// Lieber ein Takt ohne Fortschritt als ein erfundener Sollwert.
	if target == nil {
		zero := 0.0
		step, side, target = GridStepNeutral, GridSideBattery, &zero
	}
	cmd := GridCommand{
		Mode:       t.Mode,
		Step:       step,
		Side:       side,
		TargetKw:   target,
		Neutralize: side != t.lastSide,
	}
	if t.pvCapWritten {
		v := GridPvCapPermille
		cmd.PvCapPermille = &v
	}
	if rem := t.Deadline.Sub(now); rem > 0 && !t.aborted {
		cmd.SecondsRemaining = int(rem / time.Second)
	}
	t.lastSide = side
	return cmd, true
}

// NoteRegister nimmt das Urteil eines Rueckmelde-Zyklus entgegen (die SEMANTIK
// von readback-verify.js, nicht ein roher Wertvergleich).
//
//	held == true  -> das Ziel steht gerade; der Beweis darf sammeln.
//	held == false -> zwei solche Zyklen hintereinander brechen ab (§3.5).
//
// „Nicht bestaetigt" ist ausdruecklich NICHT „abgelehnt": ein Zyklus ohne
// Antwort ist keine Aussage - deshalb ruft der Kern diese Funktion nur mit
// einem ENTSCHIEDENEN Zyklus auf.
func (s *GridSession) NoteRegister(held bool, now time.Time) {
	t := s.test
	if t == nil || !s.Active(now) {
		return
	}
	if held {
		t.registerConfirmed = true
		t.registerHeldAt = now
		t.badCycles = 0
		return
	}
	t.registerHeldAt = time.Time{}
	t.plateauRun = 0
	t.badCycles++
	if t.badCycles >= GridBadCyclesAbort {
		s.Abort("Der Wechselrichter hat den geschriebenen Netz-Sollwert zweimal hintereinander nicht bestätigt.", now)
	}
}

// Observe fuettert einen Messtakt. Er tut DREI Dinge, in dieser Reihenfolge:
// die Ausgangslage fortschreiben (Extrema, Umgebung), die Abbruch-Huelle
// pruefen, und - nur wenn alles steht - Plateau-Beweis sammeln.
func (s *GridSession) Observe(o GridObservation, now time.Time) {
	t := s.test
	if t == nil || !s.Active(now) {
		return
	}
	if o.Age > GridMeasurementMaxAge {
		s.Abort(fmt.Sprintf("Die Messwerte sind %d s alt - ohne frische Messung wird nicht weiter kommandiert.", int(o.Age/time.Second)), now)
		return
	}

	step := t.stepAt(now)

	// Die Umgebung: faellt die Fronius-Erzeugung deutlich, zieht eine Wolke
	// durch. Dann beweist nichts Beobachtetes mehr etwas - der Test ist
	// „nicht beweisbar" und wird wiederholt, nicht gewertet.
	if o.FroniusPvKw != nil {
		v := *o.FroniusPvKw
		t.lastAmbientKw = &v
		if t.BaseFroniusKw > 0 && v < t.BaseFroniusKw*(1-GridAmbientDropFrac) {
			t.ambientCollapsed = true
			t.unprovable = true
			t.plateauRun = 0
		}
	}
	if o.DeyePvKw != nil && (t.minDeyePvKw == nil || *o.DeyePvKw < *t.minDeyePvKw) {
		v := *o.DeyePvKw
		t.minDeyePvKw = &v
	}
	if o.SocPct != nil {
		if *o.SocPct < GridAbortSocMinPct || *o.SocPct > GridAbortSocMaxPct {
			s.Abort(fmt.Sprintf("Der Ladestand hat %.0f %% erreicht (erlaubt sind %.0f-%.0f %% während des Tests).", *o.SocPct, GridAbortSocMinPct, GridAbortSocMaxPct), now)
			return
		}
	}
	if o.BatteryKw != nil && math.Abs(*o.BatteryKw) > GridMaxBatteryKw {
		s.Abort(fmt.Sprintf("Die Batterie fährt %.1f kW - mehr als die zulässigen %.0f kW während des Tests.", *o.BatteryKw, GridMaxBatteryKw), now)
		return
	}

	if o.GridKw == nil {
		return
	}
	g := *o.GridKw
	if t.minGridKw == nil || g < *t.minGridKw {
		v := g
		t.minGridKw = &v
	}
	if t.maxGridKw == nil || g > *t.maxGridKw {
		v := g
		t.maxGridKw = &v
	}

	// Die Abbruch-Huelle (§3.5): zu viel Export oder zu viel Bezug, das nicht
	// binnen GridOutOfBandGrace zurueckkommt.
	if -g > GridMaxExportKw || g > GridMaxImportKw {
		if t.outOfBandSince.IsZero() {
			t.outOfBandSince = now
		} else if now.Sub(t.outOfBandSince) >= GridOutOfBandGrace {
			s.Abort(fmt.Sprintf("Der Netzpunkt liegt seit über %d s außerhalb der Testgrenzen (%.1f kW; erlaubt sind bis %.0f kW Einspeisung und %.0f kW Bezug).", int(GridOutOfBandGrace/time.Second), g, GridMaxExportKw, GridMaxImportKw), now)
			return
		}
	} else {
		t.outOfBandSince = time.Time{}
	}

	// Am ENDE des Neutralschrittes: das Halte-/AC-Ziel latchen. Der letzte
	// Messwert des Schrittes ist der mit der ruhigsten Batterie.
	if step == GridStepNeutral {
		if t.Mode == GridModeGrid {
			v := g
			t.holdTargetKw = &v
		} else if o.DeyePvKw != nil {
			// Ziel = gemessene Deye-PV minus dem kleinen Schritt, nie darüber:
			// ein Ziel über der verfügbaren PV ließe den Wechselrichter die
			// Batterie entladen, um die AC-Leistung zu erreichen (E1).
			v := math.Max(0, *o.DeyePvKw-GridStepKw)
			t.acTargetKw = &v
		}
		return
	}

	// Der VORZEICHEN-Test: im Halte-Schritt darf sich nichts bewegen. Wandert
	// der Netzpunkt Richtung BEZUG, ist die Feldbericht-Konvention für dieses
	// Gerät falsch - abbrechen, bevor ein größeres Ziel kommandiert wird.
	if step == GridStepHalten && t.holdTargetKw != nil {
		if g-*t.holdTargetKw > GridSignMarginKw {
			s.Abort(fmt.Sprintf("Der Netzpunkt wandert Richtung Bezug (%.1f kW statt gehaltener %.1f kW): das Vorzeichen des netzseitigen Sollwerts stimmt für dieses Gerät nicht.", g, *t.holdTargetKw), now)
			return
		}
	}

	// Beweis sammeln - aber NUR in den Schritten, die eine ÄNDERUNG
	// kommandieren. Der Halte-Schritt beweist das Vorzeichen, nicht das Folgen.
	if step != GridStepSchritt && step != GridStepNullExport && step != GridStepAcProbe {
		return
	}
	target := t.targetFor(step)
	if target == nil {
		return
	}
	// Ohne belastbare Umgebung beweist ein Plateau nichts.
	if t.ambientCollapsed {
		return
	}
	// Das Register muss NACHWEISLICH gerade halten - ein Plateau unter einem
	// abgelaufenen oder überschriebenen Befehl beweist nichts.
	if t.registerHeldAt.IsZero() || now.Sub(t.registerHeldAt) > GridRegisterHoldFresh {
		t.plateauRun = 0
		return
	}
	if math.Abs(g-*target) <= gridPlateauTolerance(*target) {
		t.plateauRun++
		if t.plateauRun > t.plateauBest[step] {
			t.plateauBest[step] = t.plateauRun
		}
		return
	}
	t.plateauRun = 0
	// Der ehrliche Sonderfall des Null-Export-Schrittes: der Deye ist am Ende
	// (seine eigene PV steht praktisch), und was übrig bleibt, exportieren die
	// Fronius. Das ist ERWARTET (§3.6) und wird protokolliert, nicht gewertet.
	if step == GridStepNullExport && o.DeyePvKw != nil && *o.DeyePvKw <= math.Max(0.5, 0.05*t.BaseDeyePvKw) && -g > 0.5 {
		t.nullExportUnreachable = true
	}
}

// --- Beweis und Sicht --------------------------------------------------------

// GridEvidence ist das bestaetigbare Ergebnis des juengsten Laufs.
type GridEvidence struct {
	Valid   bool   `json:"valid"`
	Mode    string `json:"mode"`
	Verdict string `json:"verdict"`
	Reason  string `json:"reason,omitempty"`
	// Die Ausgangslage, damit das Protokoll ohne zweite Quelle lesbar ist.
	BaseGridKw    float64 `json:"base_grid_kw"`
	BaseDeyePvKw  float64 `json:"base_deye_pv_kw"`
	BaseFroniusKw float64 `json:"base_fronius_pv_kw"`
	BaseSocPct    float64 `json:"base_soc_pct"`

	HoldTargetKw *float64 `json:"hold_target_kw,omitempty"`
	AcTargetKw   *float64 `json:"ac_target_kw,omitempty"`

	RegisterConfirmed bool `json:"register_confirmed"`
	// FollowObserved: der Netzpunkt ist dem Ziel ueber ein Plateau gefolgt -
	// der WIRKUNGS-Beweis. Ein gehaltenes Register allein ist keiner.
	FollowObserved  bool           `json:"follow_observed"`
	PlateauRequired int            `json:"plateau_required"`
	PlateauSamples  map[string]int `json:"plateau_samples,omitempty"`

	MinGridKw   *float64 `json:"min_grid_kw,omitempty"`
	MaxGridKw   *float64 `json:"max_grid_kw,omitempty"`
	MinDeyePvKw *float64 `json:"min_deye_pv_kw,omitempty"`
	AmbientKw   *float64 `json:"ambient_pv_kw,omitempty"`
	// NullExportUnreachable: das Null-Export-Ziel war nicht erreichbar, weil
	// die Fronius allein mehr einspeisen als das Haus verbraucht. Erwartet,
	// kein Fehlschlag.
	NullExportUnreachable bool `json:"null_export_unreachable,omitempty"`

	AgeSeconds       int `json:"age_seconds"`
	ExpiresInSeconds int `json:"expires_in_seconds"`
}

// Evidence liefert den Beweis des juengsten Laufs, solange er gilt.
func (s *GridSession) Evidence(now time.Time) *GridEvidence {
	t := s.test
	if t == nil {
		return nil
	}
	endedAt := t.Deadline
	if t.aborted {
		endedAt = t.abortedAt
	}
	expiry := endedAt.Add(GridConfirmGrace)
	ev := &GridEvidence{
		Mode:              t.Mode,
		BaseGridKw:        t.BaseGridKw,
		BaseDeyePvKw:      t.BaseDeyePvKw,
		BaseFroniusKw:     t.BaseFroniusKw,
		BaseSocPct:        t.BaseSocPct,
		HoldTargetKw:      t.holdTargetKw,
		AcTargetKw:        t.acTargetKw,
		RegisterConfirmed: t.registerConfirmed,
		PlateauRequired:   GridPlateauSamples,
		MinGridKw:         t.minGridKw,
		MaxGridKw:         t.maxGridKw,
		MinDeyePvKw:       t.minDeyePvKw,
		AmbientKw:         t.lastAmbientKw,

		NullExportUnreachable: t.nullExportUnreachable,
	}
	if len(t.plateauBest) > 0 {
		ev.PlateauSamples = map[string]int{}
		for k, v := range t.plateauBest {
			ev.PlateauSamples[k] = v
			if v >= GridPlateauSamples {
				ev.FollowObserved = true
			}
		}
	}
	if now.After(endedAt) {
		ev.AgeSeconds = int(now.Sub(endedAt) / time.Second)
	}
	if now.Before(expiry) {
		ev.Valid = true
		ev.ExpiresInSeconds = int(expiry.Sub(now) / time.Second)
	}
	ev.Verdict, ev.Reason = gridVerdictOf(t, ev, now)
	return ev
}

// gridVerdictOf ist die ehrliche Auswertung. Die REIHENFOLGE ist eine Aussage:
// ein bewiesenes Folgen schlaegt alles (eine Wolke SPAETER entwertet ein
// frueher beobachtetes Plateau nicht), dann der Abbruch (er nennt seinen
// Grund), dann „laeuft", dann die Wetter-Entschuldigung, dann „kein Nachweis".
func gridVerdictOf(t *GridTest, ev *GridEvidence, now time.Time) (string, string) {
	if ev.FollowObserved && ev.RegisterConfirmed {
		return GridVerdictPassed, ""
	}
	if t.aborted {
		return GridVerdictAborted, t.abortReason
	}
	if !now.After(t.Deadline) {
		return GridVerdictRunning, ""
	}
	if !ev.RegisterConfirmed {
		return GridVerdictNoProof, "Der Wechselrichter hat die netzseitige Regelseite nie bestätigt - der Befehl kam nicht an oder wurde überschrieben."
	}
	if t.unprovable {
		return GridVerdictUnprovable, fmt.Sprintf("Nicht beweisbar: die Fronius-Erzeugung ist während des Tests um mehr als %.0f %% eingebrochen (Wolkenzug). Ein Rückgang am Netzpunkt beweist dann nichts - der Test muss bei stabilerer Einstrahlung wiederholt werden.", GridAmbientDropFrac*100)
	}
	if t.nullExportUnreachable {
		return GridVerdictNoProof, "Der Netzpunkt ist dem Ziel nicht auf ein Plateau gefolgt. Der Deye stand dabei nachweislich auf seiner eigenen Null - was übrig blieb, haben die Fronius eingespeist. Das ist erwartet und kein Gerätefehler; der 2-kW-Schritt ist der aussagekräftigere Teil des Laufs."
	}
	return GridVerdictNoProof, fmt.Sprintf("Der Netzpunkt hat sich nicht auf das Ziel eingependelt (nötig sind %d Messwerte hintereinander im Zielband). Entweder übernimmt dieses Gerät den netzseitigen Modus nicht, oder es regelt langsamer als das Testfenster.", GridPlateauSamples)
}

// --- Die :8484-Sicht ---------------------------------------------------------

// GridRunView ist der laufende Test, gerendert.
type GridRunView struct {
	Mode             string   `json:"mode"`
	Step             string   `json:"step"`
	Side             string   `json:"side"`
	TargetKw         *float64 `json:"target_kw,omitempty"`
	SecondsRemaining int      `json:"seconds_remaining"`
	RegisterOk       bool     `json:"register_ok"`
	PlateauSamples   int      `json:"plateau_samples"`
	PlateauRequired  int      `json:"plateau_required"`
	GridKw           *float64 `json:"grid_kw,omitempty"`
	DeyePvKw         *float64 `json:"deye_pv_kw,omitempty"`
	AmbientKw        *float64 `json:"ambient_pv_kw,omitempty"`
	PvCapWritten     bool     `json:"pv_cap_written"`
}

// GridView ist die GET /api/curtail/grid-test - Nutzlast.
type GridView struct {
	// Available: ein Lauf liesse sich JETZT armieren. Reason nennt sonst den
	// GRUND - eine Karte, die nur einen ausgegrauten Knopf zeigt, ist ein
	// Raetsel.
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	// Supported: diese Box hat ueberhaupt einen Deye auf dem Fernsteuerpfad.
	// false blendet die Karte aus (wie die Fronius-Karte ohne Fronius).
	Supported      bool   `json:"supported"`
	ControlEnabled bool   `json:"control_enabled"`
	AdminGate      bool   `json:"admin_gate"`
	TTLSeconds     int    `json:"ttl_seconds"`
	AcTTLSeconds   int    `json:"ac_ttl_seconds"`
	Label          string `json:"label,omitempty"`
	Target         string `json:"target,omitempty"`
	// Preconditions sind die einzelnen Bedingungen aus §3.1, jede mit ihrem
	// eigenen Urteil - damit die Karte SAGT, woran es liegt.
	Preconditions []GridPrecondition `json:"preconditions,omitempty"`
	Run           *GridRunView       `json:"run,omitempty"`
	Evidence      *GridEvidence      `json:"evidence,omitempty"`
}

// GridPrecondition ist eine einzelne Voraussetzung, benannt und beurteilt.
type GridPrecondition struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Ok    bool   `json:"ok"`
	Value string `json:"value,omitempty"`
}

// RunView rendert den laufenden Test (nil, wenn keiner laeuft).
func (s *GridSession) RunView(now time.Time) *GridRunView {
	t := s.test
	if t == nil || !s.Active(now) {
		return nil
	}
	step := t.stepAt(now)
	v := &GridRunView{
		Mode:            t.Mode,
		Step:            step,
		Side:            gridSideOf(step),
		TargetKw:        t.targetFor(step),
		RegisterOk:      t.registerConfirmed && !t.registerHeldAt.IsZero() && now.Sub(t.registerHeldAt) <= GridRegisterHoldFresh,
		PlateauSamples:  t.plateauBest[step],
		PlateauRequired: GridPlateauSamples,
		GridKw:          t.maxGridKw,
		DeyePvKw:        t.minDeyePvKw,
		AmbientKw:       t.lastAmbientKw,
		PvCapWritten:    t.pvCapWritten,
	}
	if rem := t.Deadline.Sub(now); rem > 0 {
		v.SecondsRemaining = int(rem / time.Second)
	}
	return v
}

// GridPreconditions beurteilt die Voraussetzungen aus §3.1 EINZELN - dieselbe
// Regel, mit der Start ablehnt, nur aufgeschluesselt, damit die Karte den
// fehlenden Punkt benennen kann statt nur „nicht möglich".
func GridPreconditions(cond GridConditions) []GridPrecondition {
	num := func(v *float64, unit string) string {
		if v == nil {
			return "unbekannt"
		}
		return fmt.Sprintf("%.1f %s", *v, unit)
	}
	out := []GridPrecondition{
		{Key: "control_enabled", Label: "Steuerung eingeschaltet (kein Not-Aus)", Ok: cond.ControlEnabled},
		{Key: "certified", Label: "Modell für die Steuerung freigegeben", Ok: cond.Certified},
		{Key: "remote_path", Label: "Fernsteuerung (Register 1100-1121) aktiv", Ok: cond.RemotePath},
		{Key: "rated", Label: "Nennleistung bekannt", Ok: cond.RatedKw > 0, Value: fmt.Sprintf("%.1f kW", cond.RatedKw)},
		{Key: "measurement", Label: "Messwerte frisch", Ok: cond.MeasurementAge <= GridMeasurementMaxAge, Value: fmt.Sprintf("%d s alt", int(cond.MeasurementAge/time.Second))},
		{Key: "site_pv", Label: fmt.Sprintf("Anlagen-PV ≥ %.0f kW", GridMinSitePvKw), Ok: cond.SitePvKw != nil && *cond.SitePvKw >= GridMinSitePvKw, Value: num(cond.SitePvKw, "kW")},
		{Key: "deye_pv", Label: fmt.Sprintf("Deye-Anteil ≥ %.0f kW", GridMinDeyePvKw), Ok: cond.DeyePvKw != nil && *cond.DeyePvKw >= GridMinDeyePvKw, Value: num(cond.DeyePvKw, "kW")},
		{Key: "pv_stable", Label: fmt.Sprintf("Erzeugung ≥ %d s ruhig", int(GridPvStableFor/time.Second)), Ok: cond.PvStableFor >= GridPvStableFor, Value: fmt.Sprintf("%d s", int(cond.PvStableFor/time.Second))},
		{Key: "soc", Label: fmt.Sprintf("Ladestand %.0f-%.0f %%", GridSocMinPct, GridSocMaxPct), Ok: cond.SocPct != nil && *cond.SocPct >= GridSocMinPct && *cond.SocPct <= GridSocMaxPct, Value: num(cond.SocPct, "%")},
		{Key: "plan", Label: "Fahrplan lädt oder ruht (kein Entlade-Slot)", Ok: cond.PlanBatteryOk && !cond.PlanNative},
		{Key: "fronius", Label: "Fronius freigegeben und bestätigt", Ok: cond.FroniusHealthy, Value: cond.FroniusNote},
	}
	if cond.Mode != GridModeAc {
		export := 0.0
		if cond.GridKw != nil {
			export = -*cond.GridKw
		}
		out = append(out, GridPrecondition{
			Key: "export", Label: fmt.Sprintf("Einspeisung ≥ %.0f kW", GridMinExportKw),
			Ok:    cond.GridKw != nil && export >= GridMinExportKw,
			Value: fmt.Sprintf("%.1f kW", math.Max(0, export)),
		})
	}
	return out
}

// GridPreconditionsFailed liefert die Labels der NICHT erfüllten Bedingungen,
// sortiert - damit eine Karte einen stabilen Satz bilden kann.
func GridPreconditionsFailed(pre []GridPrecondition) []string {
	var out []string
	for _, p := range pre {
		if !p.Ok {
			out = append(out, p.Label)
		}
	}
	sort.Strings(out)
	return out
}

// --- Der PV-Stabilitäts-Beobachter -------------------------------------------

// GridPvTracker beantwortet „läuft die Erzeugung schon lange genug ruhig?".
// Rein, ohne Uhr - jede Methode nimmt ihr `now`. Er lebt im Kern und wird aus
// dem Telemetrie-Pfad gefüttert, damit die Bedingung schon VOR dem Armieren
// beantwortbar ist.
//
// Die Regel in einem Satz: der Anker springt auf JETZT, sobald ein Messwert um
// mehr als GridPvJumpKw vom vorigen abweicht - oder wenn zwischen zwei
// Messwerten eine Lücke klafft (eine Lücke ist keine Ruhe, sie ist Schweigen).
type GridPvTracker struct {
	have   bool
	lastKw float64
	lastAt time.Time
	anchor time.Time
}

// gridPvGapReset - eine Messlücke größer als das ist keine Stabilität.
const gridPvGapReset = 60 * time.Second

// Observe nimmt einen Messwert der Anlagen-PV entgegen.
func (t *GridPvTracker) Observe(pvKw float64, now time.Time) {
	if math.IsNaN(pvKw) || math.IsInf(pvKw, 0) {
		return
	}
	if !t.have {
		t.have, t.lastKw, t.lastAt, t.anchor = true, pvKw, now, now
		return
	}
	if now.Sub(t.lastAt) > gridPvGapReset || math.Abs(pvKw-t.lastKw) > GridPvJumpKw {
		t.anchor = now
	}
	t.lastKw, t.lastAt = pvKw, now
}

// StableFor meldet, wie lange die Erzeugung schon ruhig läuft. 0, solange kein
// Messwert vorliegt oder die letzte Messung zu alt ist - „unbekannt" ist hier
// dieselbe Antwort wie „nicht stabil", und das ist die sichere Richtung.
func (t *GridPvTracker) StableFor(now time.Time) time.Duration {
	if !t.have || now.Sub(t.lastAt) > gridPvGapReset || now.Before(t.anchor) {
		return 0
	}
	return now.Sub(t.anchor)
}
