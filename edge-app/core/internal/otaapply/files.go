package otaapply

// Die Dateien des Protokolls: Formen + atomares Lesen/Schreiben.
//
// Jede Datei wird tmp+rename geschrieben. Es gibt deshalb keinen halb
// geschriebenen Zustand, den der jeweils andere Prozess lesen koennte - eine
// Eigenschaft, die hier nicht Komfort ist, sondern die Voraussetzung dafuer,
// dass ein Neustart MITTEN im Tausch deterministisch bewertbar bleibt.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Dir ist das Protokoll-Verzeichnis unter dem Datenverzeichnis.
func Dir(dataDir string) string { return filepath.Join(dataDir, "ota") }

// Die Dateinamen. Sie stehen hier EINMAL, damit Kern und Sidecar denselben
// String benutzen (ein Tippfehler waere ein stumm nie gelesener Kanal).
const (
	FileTarget         = "target.json"
	FileCurrent        = "current.json"
	FileCoreSignal     = "core-signal.json"
	FileUpdaterState   = "updater-state.json"
	FilePendingConfirm = "pending-confirm.json"
	FileSelfTest       = "self-test.json"
	FileLKG            = "lkg.json"
	FileFailed         = "failed.json"
	// SubdirLKG haelt die `docker save`-Archive der steuerungskritischen
	// Images - das Rueckfallziel, das auch `docker system prune -a` ueberlebt.
	SubdirLKG = "lkg"
	// SubdirSnapshot haelt die Gruppen-Sicherung der kleinen kritischen
	// /data-Dateien (Identitaet, Zertifikat, Freigaben) vor einem Tausch.
	SubdirSnapshot = "snapshot"
)

// TimeFormat ist das Format jedes Zeitstempels im Protokoll.
const TimeFormat = time.RFC3339Nano

// CoreSignal ist, was der KERN dem Sidecar ueber den Zustand der Anlage sagt.
//
// Es ist bewusst eine MOMENTAUFNAHME mit Zeitstempel und keine Historie: der
// Sidecar prueft das Alter, und ein Kern, der sich nicht mehr meldet, fuehrt
// zum Nicht-Anwenden statt zu einem Anwenden im Blindflug.
type CoreSignal struct {
	UpdatedAt string `json:"updated_at"`
	// Version ist die Build-Stempelung des laufenden Kerns.
	Version string `json:"version,omitempty"`
	// Healthy/CloudConnected sind die zwei Lebendigkeits-Signale, die der Kern
	// ueber sich selbst kennt.
	Healthy        bool `json:"healthy"`
	CloudConnected bool `json:"cloud_connected"`
	// ControlActive sagt, ob dieses Geraet gerade wirklich einen
	// Wechselrichter STEUERT (Not-Aus an UND Freigabe erteilt).
	//
	// Es ist seit dem Umbau vom 26.08.2026 KEIN Tor mehr, sondern nur noch
	// eine Tatsache fuer den Selbsttest: hat die Anlage VOR dem Tausch
	// gesteuert, muss sie es danach wieder tun (PendingConfirm.ControlActiveBefore).
	ControlActive bool `json:"control_active"`
	// InverterFamily ist die gewaehlte Register-Familie ("" = keine Auswahl).
	InverterFamily string `json:"inverter_family,omitempty"`
	// AckToken/ApplyingAckedAt bestaetigen, dass der Kern den durablen
	// `applying`-Bericht fuer GENAU diesen Vorgang abgesetzt hat.
	AckToken        string `json:"ack_token,omitempty"`
	ApplyingAckedAt string `json:"applying_acked_at,omitempty"`
	// AckFailed sagt ehrlich, dass der durable Bericht NICHT abgesetzt werden
	// konnte (kein Broker). Der Sidecar wartet dann nicht endlos - siehe
	// Decide/ApplyingAck.
	AckFailed bool `json:"ack_failed,omitempty"`
}

// Age liefert das Alter der Momentaufnahme (unlesbarer Stempel = sehr alt).
func (c *CoreSignal) Age(now time.Time) time.Duration {
	if c == nil {
		return 100 * 365 * 24 * time.Hour
	}
	t, err := time.Parse(TimeFormat, c.UpdatedAt)
	if err != nil {
		return 100 * 365 * 24 * time.Hour
	}
	if now.Before(t) {
		// Uhr-Sprung: ein Stempel aus der Zukunft ist kein Beleg fuer
		// Frische, aber auch kein Grund zur Panik - er zaehlt als „gerade
		// eben", weil die Alternative (sehr alt) eine Anwendung blockiert,
		// die der Kern nachweislich gerade begleitet.
		return 0
	}
	return now.Sub(t)
}

// UpdaterState ist, was der SIDECAR dem Kern (und damit dem Herzschlag und
// `:8484`) ueber sich sagt.
type UpdaterState struct {
	UpdatedAt string `json:"updated_at"`
	// State ist das Vertrags-Vokabular aus cloud.UpdateState* - dieselben
	// Woerter, die die Cloud seit Stufe 0 versteht.
	State string `json:"state"`
	// Reason ist PFLICHT bei jedem Nicht-idle/Nicht-succeeded (deutsch).
	Reason string `json:"reason,omitempty"`
	// Blocker ist der MASCHINENLESBARE Name des Tores, das gerade zu ist
	// (leer = keines). Er ist der Grund, warum eine Verweigerung nicht mehr
	// still sein kann: das Sidecar-Log vergleicht darauf (und schreibt nur bei
	// AENDERUNG), der Kern faltet den zugehoerigen Satz in den Herzschlag, und
	// keine Oberflaeche muss dafuer einen deutschen Satz nach Stichworten
	// durchsuchen. Vokabular: die Blocker*-Konstanten in decide.go.
	Blocker       string `json:"blocker,omitempty"`
	Release       string `json:"release,omitempty"`
	ReleaseSeq    int64  `json:"release_seq,omitempty"`
	LastKnownGood string `json:"last_known_good,omitempty"`
	// Phase ist Diagnose (welcher Schritt laeuft gerade).
	Phase string `json:"phase,omitempty"`
	// NeedApplyingAck bittet den Kern um den DURABLEN `applying`-Bericht -
	// die letzte Handlung, bevor irgendetwas gestoppt wird.
	NeedApplyingAck bool   `json:"need_applying_ack,omitempty"`
	AckToken        string `json:"ack_token,omitempty"`
	// DeadlineAt ist die Wachhund-Frist des laufenden Vorgangs.
	DeadlineAt string `json:"deadline_at,omitempty"`
}

// Blocked sagt, ob der Sidecar eine STEHENDE Sperre meldet.
func (s *UpdaterState) Blocked() bool {
	return s != nil && s.Blocker != ""
}

// BlockedReason ist der Satz, den jede Oberflaeche zeigt, wenn eine Sperre
// steht - mit [BlockedPrefix], damit „wartet" und „blockiert" nie gleich
// aussehen. Leer, wenn keine Sperre gemeldet ist.
//
// Er wohnt HIER und nicht in der Oberflaeche, weil Sidecar-Log und Herzschlag
// denselben Satz tragen muessen: zwei Formulierungen desselben Befundes waeren
// zwei Wahrheiten ueber dieselbe Anlage.
func (s *UpdaterState) BlockedReason() string {
	if !s.Blocked() {
		return ""
	}
	if strings.TrimSpace(s.Reason) == "" {
		// Kann per Konstruktion nicht vorkommen (jeder Blocker traegt seinen
		// deutschen Grund) - und genau deshalb steht hier ein ehrlicher Satz
		// statt eines nackten Praefixes.
		return BlockedPrefix + "kein Grund gemeldet (" + s.Blocker + ")."
	}
	return BlockedPrefix + s.Reason
}

// PendingConfirm ist die BROTKRUME: sie wird geschrieben, BEVOR der erste
// Container getauscht wird, und ueberlebt jeden Absturz und jeden Neustart.
//
// Solange sie existiert, ist ein Tausch im Gange - und zwar deterministisch
// bewertbar: der Sidecar sieht beim Start genau, wo er war, und faehrt
// Bestaetigen oder Zuruecknehmen zu Ende. Der Kern seinerseits sieht sie und
// weiss, dass er sich selbst pruefen muss, statt sich fuer gesund zu halten.
type PendingConfirm struct {
	Token      string `json:"token"`
	Release    string `json:"release"`
	ReleaseSeq int64  `json:"release_seq"`
	StartedAt  string `json:"started_at"`
	DeadlineAt string `json:"deadline_at"`
	// Phase ist der zuletzt BEGONNENE Schritt (siehe Phase*).
	Phase string `json:"phase"`
	// Target sind die digest-gepinnten Ziel-Referenzen je Komponente.
	Target map[string]string `json:"target"`
	// Previous ist das Rueckfallziel, gueltig ab dem Moment, in dem die
	// Brotkrume geschrieben wurde.
	Previous LKG `json:"previous"`
	// Urgent merkt sich, dass dieser Vorgang den Eil-Pfad genommen hat.
	Urgent bool `json:"urgent,omitempty"`
	// ControlActiveBefore haelt fest, ob die Anlage VOR dem Tausch gesteuert
	// hat. Der Selbsttest des neuen Standes verlangt die Freigabe dann auch
	// DANACH - ein Update, das die First-Light-Freigabe oder die Geraetewahl
	// verliert, wuerde sonst als gesund durchgehen und die Anlage waere
	// stillschweigend nur noch lesend.
	ControlActiveBefore bool `json:"control_active_before,omitempty"`
	// StateSchema ist die /data-Zustandsversion, die das Ziel-Release traegt -
	// nach bestandenem Selbsttest zeichnet der Kern sie als neuen Boden auf.
	StateSchema int `json:"state_schema,omitempty"`
}

// Die Phasen eines Vorgangs. Sie sind eine ORDNUNG: eine hoehere Phase
// impliziert, dass die vorherigen abgeschlossen sind.
const (
	PhasePrepared = "prepared"  // Images geladen + LKG gesichert, nichts getauscht
	PhaseSwapCore = "swap_core" // core wird/wurde getauscht
	PhaseSwapNode = "swap_node" // nodered wird/wurde getauscht
	PhaseSelfTest = "self_test" // beide getauscht, der neue Kern prueft sich
)

// LKG ist das Rueckfallziel: was VOR dem Tausch lief.
type LKG struct {
	Release    string              `json:"release,omitempty"`
	ReleaseSeq int64               `json:"release_seq,omitempty"`
	SavedAt    string              `json:"saved_at,omitempty"`
	Images     map[string]LKGImage `json:"images"`
}

// LKGImage haelt EIN Rueckfall-Image dreifach abgesichert.
type LKGImage struct {
	// Ref ist die Referenz, die vorher in der .env stand (kann ein Tag sein).
	Ref string `json:"ref"`
	// Digest ist der aufgeloeste Digest-Pin - DAS ist das Rueckfallziel.
	Digest string `json:"digest,omitempty"`
	// Tag ist der lokale `:lkg`-Tag.
	Tag string `json:"tag,omitempty"`
	// Holder ist der Name des GESTOPPTEN Containers, der dieses Image
	// referenziert. `docker system prune -a` verschont Images, auf die ein
	// Container zeigt - auch ein gestoppter. Das ist der Mechanismus, mit dem
	// das Rueckfall-Image den Aufraeum-Befehl des Betreibers ueberlebt.
	Holder string `json:"holder,omitempty"`
	// Tar ist der Pfad des `docker save`-Archivs (die dritte Kopie, fuer den
	// Fall, dass jemand auch die Container weggeraeumt hat).
	Tar string `json:"tar,omitempty"`
}

// FailedRelease haelt fest, dass GENAU DIESE ZUWEISUNG auf DIESEM Geraet schon
// einmal zurueckgenommen werden musste.
//
// **Ohne diesen Merkzettel dreht sich die Anlage im Kreis** (in der
// Fehlerinjektions-Matrix aufgefallen, Fall `selftest_fail`): die Zuweisung
// bleibt ja liegen, das Release laeuft nach der Ruecknahme immer noch nicht -
// also begaenne der naechste Takt denselben Tausch von vorn, endlos, jedes Mal
// mit den Sekunden ohne Steuerung, die ein Tausch nun einmal kostet.
//
// # Er ist seit dem 26.08.2026 KEINE Dauersperre mehr
//
// Frueher sperrte er das RELEASE - fuer immer, bis jemand die Datei von Hand
// entfernte. Das war genau das „Tor, das ein Release verhindern kann", das die
// Order abgeschafft hat. Er haengt jetzt an der ZUWEISUNG (`assigned_at` aus
// dem Umschlag): ein erneutes „Aktualisieren" im Portal erzeugt einen frischen
// Stempel und loest ihn damit von selbst - auch fuer dasselbe Release. Was
// bleibt, ist die Runaway-Bremse fuer GENAU DEN Fall, in dem sich nichts
// geaendert hat.
type FailedRelease struct {
	Release    string `json:"release"`
	ReleaseSeq int64  `json:"release_seq"`
	// Assignment ist der `assigned_at`-Stempel der Zuweisung, die
	// zurueckgenommen wurde. Leer = ein Merkzettel aus der Zeit vor dem Umbau;
	// er sperrt dann nichts mehr (siehe Blocks).
	Assignment string `json:"assignment,omitempty"`
	Reason     string `json:"reason,omitempty"`
	At         string `json:"at,omitempty"`
	Attempts   int    `json:"attempts,omitempty"`
}

// Blocks sagt, ob dieser Merkzettel die vorliegende Zuweisung sperrt.
//
// Es muessen BEIDE uebereinstimmen: das Release (der Name - eine neu gebaute
// Fassung desselben Tags ist per Kontrakt dasselbe Release) UND der
// Zuweisungs-Stempel. Weicht der Stempel ab, hat ein Mensch im Portal erneut
// „Aktualisieren" gedrueckt, und genau das soll es wieder versuchen.
//
// Ein Merkzettel OHNE Stempel (aus der Zeit vor dem Umbau) sperrt nichts: er
// wuerde sonst eine Dauersperre ueberleben, die es nicht mehr geben soll.
func (f *FailedRelease) Blocks(release, assignment string) bool {
	if f == nil || f.Release == "" || f.Assignment == "" {
		return false
	}
	return f.Release == release && f.Assignment == assignment
}

// SelfTest ist das Urteil des NEUEN Standes ueber sich selbst - geschrieben
// vom Kern, gelesen vom Sidecar.
type SelfTest struct {
	Token      string          `json:"token"`
	Release    string          `json:"release,omitempty"`
	StartedAt  string          `json:"started_at,omitempty"`
	FinishedAt string          `json:"finished_at,omitempty"`
	Passed     bool            `json:"passed"`
	Reason     string          `json:"reason,omitempty"`
	Checks     []SelfTestCheck `json:"checks,omitempty"`
}

// SelfTestCheck ist EINE Pruefung mit ihrem deutschen Befund.
type SelfTestCheck struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
}

// ---------------------------------------------------------------------------
// Lesen/Schreiben
// ---------------------------------------------------------------------------

// ErrAbsent sagt „diese Datei gibt es nicht" - im Protokoll ein NORMALER
// Zustand (kein Ziel, keine Brotkrume, kein Urteil), niemals ein Fehler.
var ErrAbsent = errors.New("nicht vorhanden")

// ReadJSON liest EINE Protokolldatei.
func ReadJSON[T any](dataDir, name string) (*T, error) {
	raw, err := os.ReadFile(filepath.Join(Dir(dataDir), name))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrAbsent
		}
		return nil, err
	}
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return &v, nil
}

// WriteJSON schreibt EINE Protokolldatei atomar (tmp + rename).
func WriteJSON(dataDir, name string, v any) error {
	dir := Dir(dataDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(dir, name)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Remove loescht eine Protokolldatei; ein fehlender Eintrag ist Erfolg.
func Remove(dataDir, name string) error {
	err := os.Remove(filepath.Join(Dir(dataDir), name))
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}
