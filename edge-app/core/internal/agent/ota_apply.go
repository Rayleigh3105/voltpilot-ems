package agent

// Der Knopf „Jetzt anwenden" auf `:8484` (OTA Stufe 4 „Politur").
//
// Er vervollstaendigt den BEAUFSICHTIGTEN Pfad, den Stufe 2 begonnen hat:
// entschieden und verteilt wird im Portal, angewandt am Geraet - bisher aber
// ausschliesslich ueber SSH und `update.sh --from-target`. Diese Datei macht
// aus dem Anwenden eine Handlung an der Box selbst, hinter demselben
// Betreiber-Passwort wie die Kalibrier-Eingriffe.
//
// **Es ist ausdruecklich KEINE Autonomie.** Der Unterschied ist nicht
// Wortklauberei:
//
//	Autonomie      = die Box entscheidet SELBST, wann sie anwendet
//	Diese Freigabe = ein Mensch hat sich GENAU DIESE Anwendung angesehen
//
// Beide gehen durch dieselbe Torkette (`otaapply.Decide`) und dieselbe
// Orchestrierung; die Freigabe oeffnet ausschliesslich das ERSTE Tor, und zwar
// fuer GENAU EINEN Vorgang und GENAU EIN Release. Jede weitere Sicherung -
// eigenstaendige Signaturpruefung im Sidecar, Anti-Rollback-Boden,
// Plattenwaechter, Neutral-Zeit-Regel bei steuernden Anlagen, Interlock,
// dreifach gesichertes Rueckfallziel, Selbsttest, Wachhund, `failed.json` -
// gilt UNVERAENDERT.
//
// Daraus folgt der eine Satz, der diesen Weg rechtfertigt: er ist SICHERER als
// das, was er ersetzt. `update.sh --from-target` tauscht die Container roh und
// hat weder Selbsttest noch automatische Ruecknahme.
//
// **Er braucht den Sidecar.** Ohne das Compose-Profil `ota` laeuft kein
// Prozess, der anwenden koennte - dann sagt die Oberflaeche das ehrlich, statt
// eine Datei zu schreiben, die niemand liest.

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

// otaUpdaterSeenWithin ist das Fenster, in dem eine Zustandsmeldung des
// Sidecars als „er laeuft" gilt. Er schreibt jeden Takt (30 s); zwei Minuten
// ueberbruecken einen Neustart, ohne einen gestoppten Sidecar zu uebersehen.
const otaUpdaterSeenWithin = 2 * time.Minute

// otaApplyTokenRe ist die Form aus `docs/contracts/mqtt-ota-apply.schema.json`.
var otaApplyTokenRe = regexp.MustCompile(`^[0-9a-f]{16,64}$`)

// otaApplyRejection ist eine ABLEHNUNG mit deutschem Grund (400), kein Fehler.
type otaApplyRejection struct{ msg string }

func (e *otaApplyRejection) Error() string { return e.msg }

// OtaApplyState beantwortet „kann diese Box das zugewiesene Release jetzt
// anwenden - und wenn nein, warum nicht?".
func (a *Agent) OtaApplyState() otaapply.ApplyView {
	view := otaapply.ApplyView{}
	up, upFresh := a.otaUpdaterState()
	view.UpdaterPresent = upFresh
	view.Autonomous = up != nil && up.Autonomous

	if req, err := otaapply.ReadJSON[otaapply.ApplyRequest](a.Cfg.DataDir,
		otaapply.FileApplyRequest); err == nil && req != nil {
		done := up != nil && up.AppliedRequestToken == req.Token
		if !done && req.Fresh(time.Now()) {
			view.Requested = true
			view.RequestedAt = req.RequestedAt
		}
	}

	target := a.OtaTarget()
	view.Release = target.Release
	switch {
	case target.Release == "":
		view.Reason = "Diesem Geraet ist kein Release zugewiesen."
	case target.Verdict != string(otaverify.OutcomeOK):
		// Die Ursache steht im Urteil des Verifizierers; sie hier zu
		// wiederholen hiesse, sie an zwei Stellen zu pflegen.
		view.Reason = "Das zugewiesene Release ist auf diesem Geraet nicht anwendbar."
	case !upFresh:
		view.Reason = "Auf dieser Box laeuft kein Aktualisierer (Compose-Profil „ota\"). " +
			"Angewandt wird hier weiterhin ueber `update.sh --from-target`."
	case view.Requested:
		view.Reason = "Die Freigabe liegt vor - der Aktualisierer beginnt beim naechsten Takt."
	default:
		view.CanApply = true
	}
	return view
}

// OtaRequestApply legt die EINMALIGE Freigabe ab - der Weg der `:8484`-Taste,
// die ihren Token selbst erzeugt.
func (a *Agent) OtaRequestApply(by string) (otaapply.ApplyView, error) {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return a.OtaApplyState(), fmt.Errorf("Freigabe konnte nicht erzeugt werden: %w", err)
	}
	// Der lokale Weg stempelt JETZT: der Mensch steht an der Box.
	return a.OtaRequestApplyWithToken(by, hex.EncodeToString(raw), time.Now())
}

// OtaRequestApplyWithToken legt dieselbe Freigabe mit einem VORGEGEBENEN Token
// und einem VORGEGEBENEN Zeitpunkt ab - der Weg des Portals
// (`ota_apply_downlink.go`), das beides erzeugt.
//
// Sie schreibt nur eine Datei; angewandt wird von einem anderen Prozess, der
// alles noch einmal selbst prueft. Genau deshalb ist dieser Aufruf so kurz -
// er darf gar nichts entscheiden koennen. Dass BEIDE Wege hier
// zusammenlaufen, ist der ganze Sicherheits-Beweis der Portal-Taste: es gibt
// nur EINEN Weg zum Anwenden, und er ist derselbe wie vorher.
//
// ⚠ `requestedAt` ist der Beginn des 15-Minuten-Fensters und kommt beim
// Portal-Weg aus dem UMSCHLAG, nicht von der lokalen Uhr. Das ist tragend: der
// Cloud-Link haelt eine DAUERHAFTE Sitzung (`cleanSession=false`), der Broker
// darf eine QoS1-Nachricht fuer ein abwesendes Geraet also nachliefern. Wuerde
// hier der Empfangs-Zeitpunkt gestempelt, waere eine stundenalte Zustimmung
// beim Wiederverbinden wieder taufrisch - genau das, was eine EINMALIGE
// Freigabe nie sein darf. Ein Zeitpunkt, der schon ausserhalb des Fensters
// liegt, wird deshalb ABGELEHNT statt abgelegt.
func (a *Agent) OtaRequestApplyWithToken(by, token string,
	requestedAt time.Time) (otaapply.ApplyView, error) {
	state := a.OtaApplyState()
	if !state.CanApply {
		reason := state.Reason
		if reason == "" {
			reason = "Es kann gerade nichts angewandt werden."
		}
		return state, &otaApplyRejection{msg: reason}
	}
	// Der Token wird QUITTIERT (`UpdaterState.AppliedRequestToken`) und ist
	// damit die Einmaligkeit selbst - ein unbrauchbarer Token liesse denselben
	// Tausch beliebig oft anlaufen.
	if !otaApplyTokenRe.MatchString(token) {
		return state, &otaApplyRejection{msg: "Die Freigabe traegt keine brauchbare Kennung."}
	}
	// Dieselbe Frist, die `ApplyRequest.Fresh` spaeter anwendet - nur eben schon
	// hier, damit eine nachgelieferte Freigabe gar nicht erst auf Platte landet.
	if requestedAt.IsZero() || time.Since(requestedAt) >= otaapply.ApplyRequestWindow {
		return state, &otaApplyRejection{
			msg: "Diese Freigabe ist aelter als das 15-Minuten-Fenster - sie gilt nicht mehr."}
	}
	req := otaapply.ApplyRequest{
		Token: token,
		// Das Release, das der Mensch GESEHEN hat. Aendert sich die Zuweisung
		// bis zum naechsten Takt, gilt die Freigabe nicht mehr - eine
		// Zustimmung gilt fuer das, was auf dem Schirm stand.
		Release:     state.Release,
		RequestedAt: requestedAt.UTC().Format(otaapply.TimeFormat),
		RequestedBy: by,
	}
	if err := otaapply.WriteJSON(a.Cfg.DataDir, otaapply.FileApplyRequest, req); err != nil {
		return state, fmt.Errorf("Freigabe konnte nicht abgelegt werden: %w", err)
	}
	slog.Warn("OTA: Anwendung am Geraet FREIGEGEBEN",
		"release", req.Release, "freigegeben_von", orNone(by))
	return a.OtaApplyState(), nil
}

// otaUpdaterState liest den Zustand des Sidecars und sagt, ob er FRISCH ist.
func (a *Agent) otaUpdaterState() (*otaapply.UpdaterState, bool) {
	up, err := otaapply.ReadJSON[otaapply.UpdaterState](a.Cfg.DataDir,
		otaapply.FileUpdaterState)
	if err != nil || up == nil {
		return nil, false
	}
	t, perr := time.Parse(otaapply.TimeFormat, up.UpdatedAt)
	return up, perr == nil && time.Since(t) <= otaUpdaterSeenWithin
}
