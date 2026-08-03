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
	"time"
)

// Dir ist das Protokoll-Verzeichnis unter dem Datenverzeichnis.
func Dir(dataDir string) string { return filepath.Join(dataDir, "ota") }

// Die Dateinamen. Sie stehen hier EINMAL, damit Kern und Sidecar denselben
// String benutzen (ein Tippfehler waere ein stumm nie gelesener Kanal).
const (
	FileTarget         = "target.json"
	FileCurrent        = "current.json"
	FileAutonomy       = "autonomy.json"
	FileCoreSignal     = "core-signal.json"
	FileUpdaterState   = "updater-state.json"
	FilePendingConfirm = "pending-confirm.json"
	FileSelfTest       = "self-test.json"
	FileLKG            = "lkg.json"
	FileFailed         = "failed.json"
	FileApplyRequest   = "apply-request.json"
	// SubdirLKG haelt die `docker save`-Archive der steuerungskritischen
	// Images - das Rueckfallziel, das auch `docker system prune -a` ueberlebt.
	SubdirLKG = "lkg"
	// SubdirSnapshot haelt die Gruppen-Sicherung der kleinen kritischen
	// /data-Dateien (Identitaet, Zertifikat, Freigaben) vor einem Tausch.
	SubdirSnapshot = "snapshot"
)

// TimeFormat ist das Format jedes Zeitstempels im Protokoll.
const TimeFormat = time.RFC3339Nano

// Autonomy ist der Schalter je Geraet. **Die fehlende Datei ist AUS** - ein
// Geraet, auf dem niemand etwas eingerichtet hat, wendet nie autonom an.
//
// Spaeter setzt ihn das Portal (der Kern schreibt die Datei dann aus einem
// Cloud-Kommando); heute ist er eine Datei, plus der Not-Ein `VP_OTA_AUTONOMOUS`
// fuer den Laborstand.
type Autonomy struct {
	Enabled   bool   `json:"enabled"`
	Note      string `json:"note,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

// ApplyRequest ist die EINMALIGE, von einem MENSCHEN ausgeloeste Anwendung
// (OTA Stufe 4 „Politur"): der Knopf „Jetzt anwenden" auf `:8484`.
//
// **Sie ist NICHT Autonomie.** Autonomie heisst „die Box entscheidet selbst,
// WANN sie anwendet"; das hier heisst „ein Betreiber hat sich diese eine
// Anwendung angesehen und sie ausgeloest". Beide gehen durch DIESELBE
// Torkette ([Decide]) und dieselbe Orchestrierung - was diese Anfrage oeffnet,
// ist ausschliesslich das ERSTE Tor, und zwar fuer GENAU EINEN Vorgang.
//
// Damit ist der beaufsichtigte Pfad nicht schwaecher als vorher, sondern
// STAERKER: `update.sh --from-target` tauscht die Container roh, waehrend
// dieser Weg dieselbe Sicherung bekommt wie der autonome (Digest-Gegenprobe,
// dreifach gesichertes Rueckfallziel, Brotkrume, sequenzierter Tausch,
// Selbsttest, Wachhund, Ruecknahme).
//
// Zwei Felder tragen die Sicherheit:
//
//   - **Release** ist der Stand, den der Mensch GESEHEN hat. Aendert sich die
//     Zuweisung zwischen Klick und Takt, passt sie nicht mehr und es wird
//     NICHTS angewandt - eine Freigabe gilt fuer das, was auf dem Schirm
//     stand, nicht fuer das, was inzwischen da liegt.
//   - **Token** macht sie EINMALIG: der Sidecar merkt sich den zuletzt
//     ausgefuehrten Token in seinem eigenen Zustand, also kann dieselbe Datei
//     nie zweimal einen Tausch ausloesen (das waere die Schleife, gegen die es
//     `failed.json` gibt).
//
// Sie verfaellt zusaetzlich nach [ApplyRequestWindow] - eine vergessene
// Freigabe darf nicht Tage spaeter zuschlagen.
//
// SCHREIBER: der Kern (er hat die Bedien-Oberflaeche und das Passwort). Der
// Sidecar liest sie nur; QUITTIERT wird ueber sein eigenes
// [UpdaterState.AppliedRequestToken], damit die Einzelschreiber-Regel je Datei
// gilt.
type ApplyRequest struct {
	Token       string `json:"token"`
	Release     string `json:"release"`
	RequestedAt string `json:"requested_at"`
	RequestedBy string `json:"requested_by,omitempty"`
}

// ApplyRequestWindow ist die Gueltigkeit einer Freigabe.
//
// Grosszuegig genug fuer eine Box, deren Sidecar gerade neu startet (der Takt
// ist 30 s), kurz genug, dass eine vergessene Freigabe nicht am naechsten Tag
// wirkt.
const ApplyRequestWindow = 15 * time.Minute

// Fresh sagt, ob die Freigabe noch gilt. Ein unlesbarer Stempel gilt NICHT -
// im Zweifel wird nichts angewandt.
func (r *ApplyRequest) Fresh(now time.Time) bool {
	if r == nil || r.Token == "" {
		return false
	}
	t, err := time.Parse(TimeFormat, r.RequestedAt)
	if err != nil {
		return false
	}
	if now.Before(t) {
		return true // Uhr-Sprung: gerade eben (siehe CoreSignal.Age)
	}
	return now.Sub(t) <= ApplyRequestWindow
}

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
	// Wechselrichter STEUERT (Not-Aus an UND Freigabe erteilt). Nur dann ist
	// die Inverter-Neutral-Zeit T ueberhaupt tragend.
	ControlActive bool `json:"control_active"`
	// InverterFamily ist die gewaehlte Register-Familie ("" = keine Auswahl).
	InverterFamily string `json:"inverter_family,omitempty"`
	// Dispatching sagt, ob GERADE ein von neutral abweichender Sollwert
	// ausgefuehrt wird (der „nicht mitten im Schreiben"-Interlock).
	Dispatching bool    `json:"dispatching"`
	SetpointKw  float64 `json:"setpoint_kw,omitempty"`
	// NeutralHeldSince ist gesetzt, sobald der Kern die Anlage auf Bitte des
	// Sidecars nachweislich neutral geparkt hat (der Eil-Pfad).
	NeutralHeldSince string `json:"neutral_held_since,omitempty"`
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
	Reason        string `json:"reason,omitempty"`
	Release       string `json:"release,omitempty"`
	ReleaseSeq    int64  `json:"release_seq,omitempty"`
	LastKnownGood string `json:"last_known_good,omitempty"`
	// Autonomous spiegelt den Schalter - so sieht jede Oberflaeche, ob das
	// Schweigen des Sidecars „nichts zu tun" oder „ausgeschaltet" heisst.
	Autonomous bool `json:"autonomous"`
	// Phase ist Diagnose (welcher Schritt laeuft gerade).
	Phase string `json:"phase,omitempty"`
	// NeedApplyingAck bittet den Kern um den DURABLEN `applying`-Bericht -
	// die letzte Handlung, bevor irgendetwas gestoppt wird.
	NeedApplyingAck bool   `json:"need_applying_ack,omitempty"`
	AckToken        string `json:"ack_token,omitempty"`
	// NeedNeutral bittet den Kern, die Anlage neutral zu parken (Eil-Pfad).
	NeedNeutral bool `json:"need_neutral,omitempty"`
	// AppliedRequestToken quittiert eine einmalige Freigabe ([ApplyRequest]).
	// Sie ist DAS, was sie einmalig macht - und sie steht hier statt in einer
	// Loeschung der Anfrage-Datei, damit jede Datei GENAU EINEN Schreiber hat.
	AppliedRequestToken string `json:"applied_request_token,omitempty"`
	// DeadlineAt ist die Wachhund-Frist des laufenden Vorgangs.
	DeadlineAt string `json:"deadline_at,omitempty"`
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

// FailedRelease haelt fest, dass GENAU DIESES Release auf DIESEM Geraet schon
// einmal zurueckgenommen werden musste.
//
// **Ohne diesen Merkzettel dreht sich die Anlage im Kreis** (in der
// Fehlerinjektions-Matrix aufgefallen, Fall `selftest_fail`): die Zuweisung
// bleibt ja liegen, das Release laeuft nach der Ruecknahme immer noch nicht -
// also begann der naechste Takt denselben Tausch von vorn. Ein kaputtes
// Release haette die Box damit endlos durch Tausch und Ruecknahme geschickt,
// jedes Mal mit den Sekunden ohne Steuerung, die ein Tausch nun einmal kostet.
//
// Die Regel ist deshalb: **was hier einmal zurueckgerollt wurde, wird nie
// wieder von selbst angewandt.** Weiter geht es nur ueber ein ANDERES Release
// (der Rollout im Portal haelt bei einem `rolled_back` ohnehin automatisch an,
// also ist der naechste Schritt ohnehin eine menschliche Entscheidung) oder
// dadurch, dass ein Betreiber diese Datei entfernt.
type FailedRelease struct {
	Release    string `json:"release"`
	ReleaseSeq int64  `json:"release_seq"`
	Reason     string `json:"reason,omitempty"`
	At         string `json:"at,omitempty"`
	Attempts   int    `json:"attempts,omitempty"`
}

// Blocks sagt, ob dieser Merkzettel das genannte Release sperrt.
//
// Verglichen wird der NAME: eine neu gebaute, erneut ausgerollte Fassung
// desselben Release-Tags ist per Kontrakt dasselbe Release (release_seq ist
// die Ordnung, nicht die Identitaet). Ein anderes Release laeuft normal durch.
func (f *FailedRelease) Blocks(release string) bool {
	return f != nil && f.Release != "" && f.Release == release
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

// ReadAutonomy liest den Schalter. **Jeder Zweifel ist AUS**: fehlende Datei,
// unlesbare Datei, kaputtes JSON - alles ergibt „nicht autonom". Ein Schalter,
// dessen Defekt zum EINSCHALTEN fuehrt, waere kein Schalter.
func ReadAutonomy(dataDir string) Autonomy {
	a, err := ReadJSON[Autonomy](dataDir, FileAutonomy)
	if err != nil || a == nil {
		return Autonomy{}
	}
	return *a
}

// ApplyView ist, was `:8484` ueber die Anwendbarkeit weiss.
//
// Jedes „nein" traegt seinen GRUND - ein ausgegrauter Knopf ohne Begruendung
// ist eine Sackgasse (die Haus-Disziplin des Flotten-Puls, hier auf dem
// Geraet).
type ApplyView struct {
	// CanApply: es gibt ein geprueftes Ziel UND einen laufenden Aktualisierer.
	CanApply bool `json:"can_apply"`
	// Reason ist der deutsche Grund, wenn NICHT angewandt werden kann.
	Reason string `json:"reason,omitempty"`
	// Release ist der Stand, um den es geht (leer ohne Zuweisung).
	Release string `json:"release,omitempty"`
	// UpdaterPresent sagt, ob ueberhaupt ein Aktualisierer laeuft. false =
	// das Compose-Profil `ota` ist nicht aktiv; dann bleibt `update.sh
	// --from-target` der Weg, und die Oberflaeche sagt genau das.
	UpdaterPresent bool `json:"updater_present"`
	// Autonomous spiegelt den Geraete-Schalter - so unterscheidet die
	// Oberflaeche „wartet auf Sie" von „macht es ohnehin selbst".
	Autonomous bool `json:"autonomous"`
	// Requested/RequestedAt: eine Freigabe liegt und wartet auf den naechsten
	// Takt des Aktualisierers.
	Requested   bool   `json:"requested"`
	RequestedAt string `json:"requested_at,omitempty"`
}
