package agent

// Edge Light: das BESTAETIGTE Programm pflegt die WLAN-Skripte der Box
// (wlan-anschluss.sh, einrichtung-wlan.sh) aus seinen eingebetteten Kopien
// (internal/wlanstand) - wie den Loader (loader_pflege.go). Ein Update tauschte
// bisher nur das Programm; Fixes an diesen Skripten (etwa `wege`, PR 1988)
// erreichten eine Box nur durch die Werkstatt oder von Hand durch den
// Wartungstunnel.
//
// Dieselben Schranken wie beim Loader, jede mit Test belegt
// (wlan_pflege_test.go, wlanstand_test.go, Fall 12 von
// edge-light/test/boot-update-probe.sh, Lauf skripte-update von
// edge-light/test/wlan-anschluss-probe.sh):
//
//   - nur Edge Light (nicht Edge Industrie, nicht die Docker-Box), nur ein vom
//     Loader gestartetes Programm (VP_OTA_RAM_DIR; der Labortest und Stufe 1
//     fassen den Flash nie an), nie waehrend der Probe;
//   - kein Rueckschritt (WLAN_STAND, eigener Zaehler), nur ersetzen, nie
//     einrichten, nie eine halbe Fassung (sh -n vor dem Umbenennen), die alte
//     Fassung bleibt als <skript>.alt daneben, ein zweiter Start schreibt
//     nichts, hoechstens loaderPflegeVersucheMax gescheiterte Versuche je
//     Programmlauf;
//   - nichts startet neu: kein verbinden, kein ifup, kein Netz-Neustart; nach
//     dem Ersetzen einmal `wlan-anschluss.sh wege` (ergaenzt nur Wege).

import (
	"context"
	"log/slog"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/wlanstand"
)

// wlanPflegeErsterBlick: etwas nach der Loader-Pflege, damit sich die beiden
// Flash-Schreiben nicht ueberlagern.
const wlanPflegeErsterBlick = 45 * time.Second

// wlanPflegeState haelt die Testnaehte der WLAN-Pflege.
type wlanPflegeState struct {
	// nachSchreiben (Testnaht, nil = echt): wlanstand.Pflege.NachSchreiben.
	nachSchreiben func(tmp string)
}

// wlanPflegeLoop spielt die WLAN-Skripte genau einmal je Programmlauf ein,
// sobald keine Probe laeuft. Nur Edge Light.
func (a *Agent) wlanPflegeLoop(ctx context.Context, ersterBlick, takt time.Duration) {
	defer a.done.Done()
	if a.boxArt() != geraetesuche.BoxArtEdgeLight || !a.otaLightLoaderBereit() || a.Cfg.WlanSkript == "" {
		return
	}
	if wlanstand.EingebetteterStand() < 1 {
		slog.Error("WLAN-Skripte: die eingebettete Fassung traegt keinen Stand - nichts wird eingespielt")
		return
	}
	pflegeWiederholen(ctx, "WLAN-Skripte", ersterBlick, takt, func() (bool, error) { return a.wlanPflegen(ctx) })
}

// wlanPflegen prueft einmal und spielt noetigenfalls ein. fertig heisst:
// nichts mehr zu tun in diesem Programmlauf; err verlangt einen weiteren
// Versuch.
func (a *Agent) wlanPflegen(ctx context.Context) (fertig bool, err error) {
	if a.probeLaeuft() {
		return false, nil
	}
	p := wlanstand.Pflege{Anschluss: a.Cfg.WlanSkript, NachSchreiben: a.wlanPflege.nachSchreiben}
	erg, err := p.Lauf(ctx)
	if err != nil {
		return false, err
	}
	switch {
	case erg.KeinSkript:
		slog.Info("WLAN-Skripte: kein wlan-anschluss.sh vorhanden - nichts einzuspielen", "pfad", a.Cfg.WlanSkript)
	case len(erg.Geschrieben) == 0:
		if erg.Vorher > wlanstand.EingebetteterStand() {
			slog.Info("WLAN-Skripte: der Stand im Flash ist neuer als der eingebettete - er bleibt",
				"flash", erg.Vorher, "eingebettet", wlanstand.EingebetteterStand())
		}
	default:
		slog.Info("WLAN-Skripte erneuert - wirken ab dem naechsten Takt oder ifup, die alte Fassung liegt als .alt daneben",
			"von", erg.Vorher, "auf", erg.Nachher, "dateien", erg.Geschrieben,
			"wege", erg.Wege, "wege_fehler", erg.WegeFehler)
	}
	return true, nil
}
