package mango

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/box"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
)

// Zuruecksetzen ist der eine Handgriff für eine Mango, in die der Dienst nicht
// hineinkommt, die er aber zurücksetzen lassen darf: eine GL-Mango mit dem
// Passwort eines Vorbesitzers oder eine Box, die diese Werkstatt begonnen und
// nicht fertig gemacht hat (Entscheid NA-1 B: kein eigener Zugang des Dienstes
// über das Ende eines Laufs hinaus). Unter OpenWrt löscht der Reset ab 5 s
// alle Einstellungen (jffs2reset), unter der GL-Firmware ab 10 s. Danach steht
// die Box frisch unter 192.168.1.1 bzw. 192.168.8.1; ihre MAC war während des
// Neustarts weg, darum beginnt der Dienst von selbst einen neuen Lauf.
// Das Portal erkennt den Handgriff am Anfang "Zurücksetzen:".
const Zuruecksetzen = "Zurücksetzen: Den Reset-Knopf der Mango mit einem Stift 10 Sekunden gedrückt halten, bis die Leuchte schnell blinkt, dann loslassen. Kabel und Strom bleiben stecken. Die Mango startet neu und ist danach wie neu; der Dienst macht von selbst weiter."

// Startlader ist der Handgriff M4 (Werksfirmware nimmt das Abbild nicht an
// oder lässt kein SSH zu). Das Portal erkennt ihn am Anfang "Startlader".
func (l *Lauf) startlader() string {
	return "Startlader (Handgriff M4): Mango vom Strom, Reset-Knopf halten und Strom stecken, bis die Leuchte fünfmal blinkt; am Rechner 192.168.1.2 einstellen, http://192.168.1.1 öffnen und " + l.freigabe.OpenWrt.Datei + " hochladen. Danach steckt die Mango mit frischem OpenWrt am orangen Kabel, und der Dienst macht weiter."
}

// HalbEigene prüft, ob die Box mit dieser MAC und diesem Host-Schlüssel eine
// ist, die diese Werkstatt begonnen und nicht fertig gemacht hat, und ob sie
// zurückgesetzt werden darf. Leer heißt ja; sonst sagt der Text, warum nicht.
// Die Sicherheitslinie, alles muss stimmen:
//
//   - ein Lauf dieses Dienstes hat dieser MAC ein Passwort gesetzt (das
//     Passwort auf der Box ist also eines der Werkstatt, kein fremdes);
//   - dieser Lauf hat sie nicht übergeben (nicht fertig, Schritt uebergabe
//     nicht belegt);
//   - die Box zeigt denselben Host-Schlüssel wie in diesem Lauf (MAC allein
//     beweist keine Gleichheit);
//   - hat sie schon eine Referenz, sagt das Portal: nicht abgenommen und nicht
//     gekoppelt. Ohne Portal oder ohne Antwort: nein (unbekannt ist nicht nein).
func (k Konfig) HalbEigene(ctx context.Context, mac, host, ausser string) (sp protokoll.Spur, nein, fall string) {
	if k.Spuren == nil {
		return sp, "der Dienst hat keine Protokolle, in denen er die Box suchen könnte", faelle.NichtNachweisbar
	}
	sp, ok, err := k.Spuren.SpurDerMAC(mac, ausser)
	switch {
	case err != nil:
		return sp, "Protokolle nicht lesbar: " + err.Error(), faelle.NichtNachweisbar
	case !ok:
		return sp, "kein Lauf dieser Werkstatt hat der Box " + mac + " ein Passwort gesetzt: ein fremdes Passwort", faelle.PasswortFremd
	case sp.Fertig():
		return sp, "der Lauf " + sp.Lauf + " hat sie fertig eingerichtet und übergeben", faelle.BoxInGebrauch
	case host == "" || sp.Host == "" || host != sp.Host:
		return sp, fmt.Sprintf("ihr Host-Schlüssel (%s) ist nicht der aus dem Lauf %s (%s): nicht nachweislich dieselbe Box", orNone(host), sp.Lauf, orNone(sp.Host)), faelle.NichtNachweisbar
	}
	if sp.Ref == "" {
		return sp, "", ""
	}
	if k.Portal == nil {
		return sp, "ohne Portal lässt sich nicht prüfen, ob " + sp.Ref + " abgenommen oder gekoppelt ist", faelle.NichtNachweisbar
	}
	pctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	st, err := k.Portal.BoxStandLesen(pctx, sp.Ref)
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

// halbGrund ist der Grund für den Handgriff Zurücksetzen an einer eigenen Box.
func halbGrund(sp protokoll.Spur) string {
	g := "Diese Mango hat der Lauf " + sp.Lauf + " begonnen und nicht fertig gemacht (dieselbe MAC, derselbe Host-Schlüssel"
	if sp.Ref != "" {
		g += "; " + sp.Ref + " ist im Portal nicht abgenommen und nicht gekoppelt"
	}
	return g + "). Ihr Passwort kennt der Dienst nicht mehr; zurückgesetzt richtet er sie neu ein. Ein alter Eintrag im Register bleibt als Verlauf stehen."
}

// pruefeVerbinden meldet sich an ziel ohne Passwort an. Antwortet die Box noch
// nicht (Connection refused, No route to host: sie startet), versucht es der
// Lauf bis frist weiter; eine Abweisung oder ein fremder Host-Schlüssel enden
// sofort.
func (l *Lauf) pruefeVerbinden(ctx context.Context, ziel netip.AddrPort, frist time.Duration) (*box.Verbindung, error) {
	return l.verbinde(ctx, ziel, geheim.Geheim{}, frist)
}

// startetNoch sagt, ob ein Fehler nur heißt: Die Box ist noch nicht so weit.
func startetNoch(err error) bool {
	if err == nil {
		return false
	}
	t := err.Error()
	return strings.Contains(t, "Connection refused") || strings.Contains(t, "No route to host") || strings.Contains(t, "i/o timeout")
}

// erkennenHalbImLan: die Box unter dem LAN-Netz, deren MAC laut Protokoll ein
// unfertiger Lauf dieser Werkstatt kennt. Nur der SSH-Handshake (für den
// Host-Schlüssel), keine Anmeldung, keine Änderung.
func (l *Lauf) erkennenHalbImLan(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	s, err := l.k.Werkbank.Status(ctx)
	if err != nil {
		return nil, err
	}
	e, err := Einzeln(s)
	if err != nil {
		return nil, err
	}
	if e.Adresse != l.k.LanNetz.Addr() {
		return nil, fmt.Errorf("das Gerät antwortet unter %s, nicht unter %s (LAN-Netz)", e.Adresse, l.k.LanNetz.Addr())
	}
	l.mac = e.MAC
	b := protokoll.Beleg{}.Mit("mac", e.MAC).Mit("adresse", e.Adresse.String())
	v, err := l.pruefeVerbinden(ctx, l.zielLan(), 2*l.k.Zeiten.Verbinden)
	var ab box.Abgewiesen
	switch {
	case errors.As(err, &ab):
		b = b.Mit("ssh", "Anmeldung ohne Passwort abgewiesen").Mit("host_schluessel", orNone(ab.Host))
	case err != nil:
		return b, err
	default:
		host := v.HostFingerabdruck()
		v.Schliesse()
		return b.Mit("host_schluessel", host), lauf.Handgriff{Was: zurSeite, Fall: faelle.NichtNachweisbar, Grund: "Die Box unter dem LAN-Netz nimmt root ohne Passwort an: Das ist kein Stand, den ein Lauf dieser Werkstatt hinterlässt."}
	}
	sp, nein, fall := l.k.HalbEigene(ctx, e.MAC, ab.Host, l.kennung)
	b = b.Mit("lauf_vorher", orNone(sp.Lauf)).Mit("referenz_vorher", orNone(sp.Ref))
	if nein != "" {
		return b.Mit("zuruecksetzen", "nein - "+nein), lauf.Handgriff{Was: zurSeite, Fall: fall, Grund: "Unter dem LAN-Netz steht eine eingerichtete Box; der Dienst lässt sie nicht zurücksetzen: " + nein + "."}
	}
	return b.Mit("zuruecksetzen", "ja"), lauf.Handgriff{Was: Zuruecksetzen, Fall: faelle.HalbEigene, Grund: halbGrund(sp)}
}
