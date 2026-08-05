package agent

// Portal-Apply: die EINMALIGE Freigabe aus dem Portal (Konzept
// `vp-admin-geraete-ux-k2` §6 / E3, Captain-Go 05.08.2026).
//
// **Es ist die Freigabe der `:8484`-Taste mit anderem TRANSPORT, sonst
// nichts.** Bis hierher brauchte der unbequemste Moment des ganzen Flusses
// einen Tunnel und das Geraetepasswort je Box - und genau deshalb blieb der
// Rollout eine halbe Sache: entschieden und verteilt im Portal, angewandt per
// SSH.
//
// Die Sicherheits-Haltung ist damit UNVERAENDERT, und das ist keine
// Beteuerung, sondern eine Konstruktions-Aussage:
//
//   - Sie ruft `OtaRequestApply` auf, also GENAU DEN Pfad, den die Taste an
//     der Box benutzt. Es gibt hier keinen zweiten Weg zum Anwenden, den man
//     spaeter getrennt absichern muesste.
//   - Damit oeffnet sie ausschliesslich das ERSTE Tor von `otaapply.Decide`,
//     fuer GENAU EIN Release und GENAU EINEN Vorgang, und verfaellt nach 15
//     Minuten. `autonomy.json` bleibt unberuehrt AUS.
//   - Jede weitere Sicherung gilt woertlich weiter: eigenstaendige
//     Signaturpruefung im Sidecar gegen SEINE eingebackene Wurzel,
//     Anti-Rollback-Boden, Neutral-Zeit-Regel einer STEUERNDEN Anlage,
//     Interlock, Plattenwaechter, dreifach gesichertes Rueckfallziel,
//     Selbsttest, Wachhund, `failed.json`.
//
// Sie ist eine ZEITPUNKT-Autorisierung, keine Inhalts-Autorisierung: WAS
// laufen darf, entscheidet weiterhin allein das signierte Manifest gegen die
// eingebackene Wurzel. Der Umschlag ist unsigniert - wie der Zuweisungs-
// Umschlag - und damit Routing/Timing, nie Autoritaet.

import (
	"encoding/json"
	"log/slog"
	"strings"
	"time"
)

// otaApplyEnvelope ist der Umschlag der Einmal-Freigabe
// (`docs/contracts/mqtt-ota-apply.schema.json`).
type otaApplyEnvelope struct {
	SchemaVersion string `json:"schema_version"`
	Type          string `json:"type"`
	TenantID      string `json:"tenant_id"`
	SiteID        string `json:"site_id"`
	DeviceID      string `json:"device_id"`
	Token         string `json:"token"`
	Release       string `json:"release"`
	RequestedAt   string `json:"requested_at"`
	RequestedBy   string `json:"requested_by,omitempty"`
}

// onApplyRequest verarbeitet eine Einmal-Freigabe vom Portal.
//
// **Jede Ablehnung ist STUMM fuer das Geraet und LAUT im Protokoll**: die
// Cloud erfaehrt das Ergebnis ohnehin ueber den `update`-Block des
// Herzschlags (die Freigabe wird sichtbar oder eben nicht), und eine
// Fehlerantwort auf einem Downlink-Topic gaebe es hier gar nicht.
func (a *Agent) onApplyRequest(payload []byte) {
	if len(payload) == 0 {
		return
	}
	var env otaApplyEnvelope
	if err := json.Unmarshal(payload, &env); err != nil {
		slog.Warn("OTA: Freigabe ist kein gueltiges JSON - verworfen", "err", err)
		return
	}
	if env.SchemaVersion != "1.0" || env.Type != "apply_request" {
		slog.Warn("OTA: Freigabe mit unbekannter Form verworfen",
			"schema_version", env.SchemaVersion, "type", env.Type)
		return
	}
	// DIESELBE Identitaetsregel wie bei Telemetrie, purge_data und der
	// Zuweisung: was nicht auf das eigene Topic passt, wird verworfen. Der
	// Broker faellt darauf ohnehin nicht herein (ACL + Zertifikats-CN); dies
	// ist die zweite Haelfte derselben Disziplin.
	a.entMu.Lock()
	id := a.entIdentity
	a.entMu.Unlock()
	if id.DeviceID == "" {
		slog.Warn("OTA: Freigabe vor bekannter Cloud-Identitaet - ignoriert")
		return
	}
	if !strings.EqualFold(env.DeviceID, id.DeviceID) ||
		!strings.EqualFold(env.TenantID, id.TenantID) ||
		!strings.EqualFold(env.SiteID, id.SiteID) {
		slog.Warn("OTA: Freigabe meint ein anderes Geraet - verworfen",
			"gemeldet", env.DeviceID, "eigen", id.DeviceID)
		return
	}
	if env.Token == "" || env.Release == "" {
		slog.Warn("OTA: Freigabe ohne Token oder Release verworfen")
		return
	}
	// ⚠ Der Stempel des UMSCHLAGS ist der Beginn des Fensters, nicht der
	// Empfangs-Zeitpunkt. Der Cloud-Link haelt eine dauerhafte Sitzung, der
	// Broker darf also nachliefern - eine stundenalte Zustimmung waere sonst
	// beim Wiederverbinden wieder taufrisch. Ein unlesbarer Stempel gilt NICHT
	// (so steht es im Kontrakt): im Zweifel wird nichts angewandt.
	requestedAt, err := time.Parse(time.RFC3339, env.RequestedAt)
	if err != nil {
		slog.Warn("OTA: Freigabe mit unlesbarem Zeitstempel verworfen",
			"requested_at", env.RequestedAt)
		return
	}

	// Die Freigabe gilt dem Stand, den der Betreiber SAH. Traegt die Box
	// inzwischen ein anderes Ziel, wird NICHTS angewandt - und das wird
	// GESAGT, nicht stillschweigend uebergangen.
	state := a.OtaApplyState()
	if state.Release != env.Release {
		slog.Warn("OTA: Freigabe passt nicht zum zugewiesenen Release - nichts angewandt",
			"freigegeben", env.Release, "zugewiesen", orNone(state.Release))
		return
	}

	by := env.RequestedBy
	if by == "" {
		by = "Portal"
	}
	// Ab hier: DERSELBE Pfad wie die Taste an der Box. Er prueft selbst, ob
	// gerade ueberhaupt angewandt werden kann, und lehnt mit deutschem Grund
	// ab - der Grund reist ueber den Herzschlag zurueck.
	if _, err := a.OtaRequestApplyWithToken(by, env.Token, requestedAt); err != nil {
		slog.Warn("OTA: Freigabe aus dem Portal abgelehnt", "grund", err.Error())
		return
	}
	slog.Warn("OTA: Anwendung aus dem PORTAL freigegeben",
		"release", env.Release, "freigegeben_von", by)
}
