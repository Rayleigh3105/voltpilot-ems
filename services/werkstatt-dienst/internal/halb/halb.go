// Package halb beantwortet eine Frage für jedes Gerät an der Werkbank: Ist
// die Box, die den Dienst nicht hineinlässt, eine, die diese Werkstatt
// begonnen und nicht fertig gemacht hat - und darf sie darum zurückgesetzt
// werden? Die Sicherheitslinie ist für Mango und PFC200 dieselbe.
package halb

import (
	"context"
	"fmt"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
)

// Spuren sucht in den Protokollen des Dienstes (protokoll.Ablage).
type Spuren interface {
	SpurDerMAC(mac, ausser string) (protokoll.Spur, bool, error)
}

// Portal sagt, ob eine Box abgenommen oder gekoppelt ist (internal/portal).
type Portal interface {
	BoxStandLesen(ctx context.Context, edgeRef string) (portal.BoxStand, error)
}

// Eigene prüft, ob die Box mit dieser MAC und diesem Host-Schlüssel eine ist,
// die diese Werkstatt begonnen und nicht fertig gemacht hat, und ob sie
// zurückgesetzt werden darf. nein leer heißt ja; sonst sagt der Text, warum
// nicht, und fall ist der Code dazu. Die Sicherheitslinie, alles muss stimmen:
//
//   - ein Lauf dieses Dienstes hat dieser MAC ein Passwort gesetzt (das
//     Passwort auf der Box ist also eines der Werkstatt, kein fremdes);
//   - dieser Lauf hat sie nicht übergeben (nicht fertig, Schritt uebergabe
//     nicht belegt);
//   - die Box zeigt denselben Host-Schlüssel wie in diesem Lauf (MAC allein
//     beweist keine Gleichheit);
//   - hat sie schon eine Referenz, sagt das Portal: nicht abgenommen und nicht
//     gekoppelt. Ohne Portal oder ohne Antwort: nein (unbekannt ist nicht nein).
//
// spuren und ptl dürfen nil sein: dann lässt sich nichts nachweisen.
func Eigene(ctx context.Context, spuren Spuren, ptl Portal, mac, host, ausser string) (sp protokoll.Spur, nein, fall string) {
	if spuren == nil {
		return sp, "der Dienst hat keine Protokolle, in denen er die Box suchen könnte", faelle.NichtNachweisbar
	}
	sp, ok, err := spuren.SpurDerMAC(mac, ausser)
	switch {
	case err != nil:
		return sp, "Protokolle nicht lesbar: " + err.Error(), faelle.NichtNachweisbar
	case !ok:
		return sp, "kein Lauf dieser Werkstatt hat der Box " + mac + " ein Passwort gesetzt: ein fremdes Passwort", faelle.PasswortFremd
	case sp.Fertig():
		return sp, "der Lauf " + sp.Lauf + " hat sie fertig eingerichtet und übergeben", faelle.BoxInGebrauch
	case host == "" || sp.Host == "" || host != sp.Host:
		return sp, fmt.Sprintf("ihr Host-Schlüssel (%s) ist nicht der aus dem Lauf %s (%s): nicht nachweislich dieselbe Box", orKeins(host), sp.Lauf, orKeins(sp.Host)), faelle.NichtNachweisbar
	}
	if sp.Ref == "" {
		return sp, "", ""
	}
	if ptl == nil {
		return sp, "ohne Portal lässt sich nicht prüfen, ob " + sp.Ref + " abgenommen oder gekoppelt ist", faelle.NichtNachweisbar
	}
	pctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	st, err := ptl.BoxStandLesen(pctx, sp.Ref)
	switch {
	case err != nil:
		return sp, "das Portal sagt nicht, ob " + sp.Ref + " abgenommen oder gekoppelt ist: " + geheim.Schwaerze(err.Error()), faelle.NichtNachweisbar
	case st.Abgenommen:
		return sp, sp.Ref + " ist im Portal abgenommen", faelle.BoxInGebrauch
	case st.Gekoppelt:
		return sp, sp.Ref + " ist im Portal gekoppelt", faelle.BoxInGebrauch
	}
	return sp, "", ""
}

func orKeins(s string) string {
	if s == "" {
		return "keins"
	}
	return s
}
