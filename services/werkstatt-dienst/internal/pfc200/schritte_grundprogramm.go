package pfc200

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
)

// ---- Grundprogramm ------------------------------------------------------------------
//
// Lädt die Boot-Applikation des Basisprojekts (Modbus TCP, WAGO Telecontrol,
// VoltPilot-Bibliothek, leerer Klemmenbus - gebaut im Repo voltpilot-sps,
// nicht hier) auf die CODESYS-V3.5-Laufzeit. Das Anlagenprogramm und seine
// Koppelprobe bleiben SPS-Programmierung nach dem Lauf (Abschnitt 6.7 im
// Konzept vp-pfc200-edge-konzept), nicht Werkstatt.
//
// Beleg-Lage, nach Konzept-Abschnitt 6.7/7 (PS-P14): CODESYS sagt allgemein,
// eine offline erzeugte Boot-Applikation lasse sich „mit externen Werkzeugen
// auf die Steuerung kopieren“ ([C-BA]); ein CODESYS-Forumsbeitrag nennt für
// WAGO dafür den Ordner /home/codesys/PlcLogic/Application ([C-FO], keine
// Herstelleraussage). Welcher Dienst die Laufzeit danach neu einliest, ist an
// keinem echten Gerät belegt (PS-P14 offen) - wie der Rest dieses Pakets ab
// dem Schritt zugaenge (README: „nicht an einem echten Gerät gelaufen“). Der
// Schritt versucht darum mehrere plausible Dienst-Namen und hält mit einem
// Handgriff an, statt etwas Falsches stillschweigend anzunehmen; der zweite,
// im Konzept genannte Weg (eine Sicherung „PLC Runtime Project“ einspielen)
// ist laut Handbuch ein Weg über das WBM (Web-Oberfläche), nicht über ein
// Werkzeug von /etc/config-tools - also nicht aus der Werkstatt heraus
// aufrufbar; der Handgriff nennt ihn als Fallback für die Technik.

// CodesysMindestlinie ist die erste Firmware-Hauptlinie mit der
// CODESYS-V3.5-Laufzeit (WAGO-Firmware 04.xx, FW23 und neuer; Entscheid D1
// der Pi-Ablösung). Die Linie 03 (e!COCKPIT, das Test-Gerät dieses Pakets)
// kann das Grundprogramm nicht laden.
const CodesysMindestlinie = 4

// codesysBootApplikation ist der Ordner der Boot-Applikation auf dem Gerät.
const codesysBootApplikation = "/home/codesys/PlcLogic/Application"

// codesysMarke trägt die Prüfsumme des zuletzt von dieser Werkstatt
// eingespielten Grundprogramms: Damit erkennt ein neuer Versuch (nach einem
// Dienst-Neustart mitten im Lauf) sein eigenes Grundprogramm wieder, statt es
// ein zweites Mal zu schreiben oder ein fremdes zu überschreiben.
const codesysMarke = codesysBootApplikation + "/.vp-grundprogramm-sha256"

// codesysDienstKandidaten sind die Namen, unter denen die BusyBox-Firmware
// des PFC200 den Dienst der CODESYS-Laufzeit starten könnte. Keiner davon ist
// an einem echten Gerät belegt (siehe oben): Der Neustart versucht sie der
// Reihe nach und meldet deutlich, wenn keiner passt.
var codesysDienstKandidaten = []string{"/etc/init.d/pfc-codesys3", "/etc/init.d/codesys3", "/etc/init.d/runtime"}

// befehlGrundprogrammStand liest, was auf der SPS liegt, ohne etwas zu ändern.
const befehlGrundprogrammStand = `D='` + codesysBootApplikation + `'
echo "marke=$(cat '` + codesysMarke + `' 2>/dev/null)"
echo "dateien=$(find "$D" -mindepth 1 -maxdepth 1 ! -name '.vp-grundprogramm-sha256' 2>/dev/null | wc -l | tr -d ' ')"`

// befehlGrundprogrammLaeuft prüft, OHNE eine Anlagen-Kopplung (Koppelprobe)
// zu versuchen: läuft der Prozess der Laufzeit, und lauscht ihr
// Modbus-TCP-Server (den das Grundprogramm immer anlegt, Konzept 4.4) auf der
// Schleife. Kein Register wird gelesen - das bleibt dem späteren Koppelbild
// vorbehalten; dieser Schritt beweist nur das Gerät, nicht die Anlage.
const befehlGrundprogrammLaeuft = `echo "codesys=$(if pidof codesys3 >/dev/null 2>&1; then echo laeuft; else echo nein; fi)"
echo "modbus=$(if netstat -ltn 2>/dev/null | grep -q '127\.0\.0\.1:502 '; then echo laeuft; else echo nein; fi)"`

// firmwareHauptlinie liest die erste Zifferngruppe vor dem ersten Punkt
// (03.10.08(22) -> 3, 04.02.13(24) -> 4).
func firmwareHauptlinie(firmware string) (int, bool) {
	teil, _, _ := strings.Cut(strings.TrimSpace(firmware), ".")
	n, err := strconv.Atoi(teil)
	return n, err == nil
}

// codesysNeustart startet die CODESYS-Laufzeit neu, über den ersten
// passenden Dienst-Namen aus codesysDienstKandidaten.
func (l *Lauf) codesysNeustart(ctx context.Context) error {
	skript := "for d in"
	for _, d := range codesysDienstKandidaten {
		skript += " " + shellWort(d)
	}
	skript += `; do
  if [ -x "$d" ]; then "$d" restart >/dev/null 2>&1; exit $?; fi
done
echo "FEHLER: kein Dienst-Skript der CODESYS-Laufzeit gefunden (versucht: ` + strings.Join(codesysDienstKandidaten, ", ") + `)" >&2
exit 9`
	_, err := l.fuehre(ctx, skript, "")
	return err
}

func (l *Lauf) grundprogrammEinspielen(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	b := protokoll.Beleg{}.Mit("firmware", orKeins(l.firmware))
	haupt, ok := firmwareHauptlinie(l.firmware)
	if !ok || haupt < CodesysMindestlinie {
		return b, lauf.Handgriff{Was: ZurSeite, Fall: faelle.PFCFirmwareAlt,
			Grund: fmt.Sprintf("Firmware %s (Hauptlinie vor %02d.xx): Die CODESYS-V3.5-Laufzeit für das Grundprogramm gibt es erst ab Firmware %02d.xx oder neuer. Am Gerät ist nichts geändert.",
				orKeins(l.firmware), CodesysMindestlinie, CodesysMindestlinie)}
	}

	soll := l.freigabe.EdgeIndustrie.GrundprogrammSha256
	if soll == "" {
		return b, lauf.Handgriff{Was: ZurSeite, Fall: faelle.PFCKeinGrundprogramm,
			Grund: "Die Fassung " + l.freigabe.EdgeIndustrie.Fassung + " trägt kein Grundprogramm (kein grundprogramm_sha256 in der Freigabe). Am Gerät ist nichts geändert."}
	}
	if l.pfadGrundprogramm == "" {
		return b, errors.New("Grundprogramm im Zwischenspeicher fehlt, obwohl die Freigabe eine Prüfsumme nennt (Schritt fassungen)")
	}
	if summe, err := fassungen.Summe(l.pfadGrundprogramm); err != nil || summe != soll {
		return b, errors.New("Grundprogramm im Zwischenspeicher hat nicht die Prüfsumme der Freigabe")
	}

	w, err := l.werte(ctx, befehlGrundprogrammStand)
	if err != nil {
		return b, err
	}
	dateien, _ := strconv.Atoi(w["dateien"])
	switch {
	case w["marke"] == soll:
		b = b.Mit("vorher", "schon eingespielt (Marke gleich dieser Prüfsumme), wird neu geladen")
	case dateien > 0, w["marke"] != "":
		return b.Mit("vorher", fmt.Sprintf("%d Datei(en) in %s, Marke %s", dateien, codesysBootApplikation, orKeins(w["marke"]))),
			lauf.Handgriff{Was: ZurSeite, Fall: faelle.PFCGrundprogrammFremd,
				Grund: fmt.Sprintf("Auf der SPS liegt schon eine Boot-Applikation, die nicht dieses Grundprogramm ist (%d Datei(en) in %s, Marke %s). Der Dienst überschreibt sie nie von selbst. Am Gerät ist nichts geändert.",
					dateien, codesysBootApplikation, orKeins(w["marke"]))}
	default:
		b = b.Mit("vorher", "keine Boot-Applikation auf der SPS")
	}

	daten, err := os.ReadFile(l.pfadGrundprogramm)
	if err != nil {
		return b, err
	}
	if _, err := l.fuehre(ctx, "mkdir -p '"+codesysBootApplikation+"' && tar -xzf - -C '"+codesysBootApplikation+"' && sync", string(daten)); err != nil {
		return b, fmt.Errorf("Grundprogramm auspacken: %w", err)
	}
	if _, err := l.fuehre(ctx, "printf '%s' "+shellWort(soll)+" > '"+codesysMarke+"' && sync", ""); err != nil {
		return b, err
	}
	b = b.Mit("eingespielt", fmt.Sprintf("sha256 %s nach %s", soll, codesysBootApplikation))

	if err := l.codesysNeustart(ctx); err != nil {
		return b, lauf.Handgriff{Was: ZurSeite, Fall: faelle.PFCGrundprogrammLaedtNicht,
			Grund: "Die CODESYS-Laufzeit ließ sich nicht neu starten: " + err.Error() +
				". Entweder von Hand mit CODESYS online eine Boot-Applikation erzeugen, oder eine Sicherung „PLC Runtime Project“ einspielen (Web-Oberfläche des Geräts)."}
	}

	var w2 map[string]string
	err = l.warteAuf(ctx, l.k.Zeiten.Grundprogramm, func() error {
		var err error
		if w2, err = l.werte(ctx, befehlGrundprogrammLaeuft); err != nil {
			return err
		}
		if w2["codesys"] != "laeuft" || w2["modbus"] != "laeuft" {
			return fmt.Errorf("CODESYS-Laufzeit %s, Modbus-Server auf der Schleife %s", orKeins(w2["codesys"]), orKeins(w2["modbus"]))
		}
		return nil
	})
	if err != nil {
		return b, lauf.Handgriff{Was: ZurSeite, Fall: faelle.PFCGrundprogrammLaedtNicht,
			Grund: "Das Grundprogramm läuft nach dem Neustart der Laufzeit nicht nachweisbar (" + err.Error() +
				"). Entweder von Hand mit CODESYS online eine Boot-Applikation erzeugen, oder eine Sicherung „PLC Runtime Project“ einspielen (Web-Oberfläche des Geräts)."}
	}
	l.belege["grundprogramm"] = fmt.Sprintf("Schritt grundprogramm: sha256 %s nach %s eingespielt, CODESYS-Laufzeit neu gestartet und läuft, ihr Modbus-Server lauscht auf 127.0.0.1:502 (kein Register gelesen, keine Koppelprobe)", soll, codesysBootApplikation)
	return b.Mit("laeuft", "CODESYS läuft, Modbus-Server auf der Schleife"), nil
}
