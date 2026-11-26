package pfc200

// Direktvermarktung-bereit am WAGO PFC200 (vp-direktvermarktung-konzept d2,
// E5=A, Stufe 5; Vektor docs/contracts/werkstatt-pruefungen.json): Das
// Firmware-OpenVPN bringt das Geraet mit, den root-Helfer vp-vermarkter legt
// install.sh aus dem Skriptstand auf (Stufe 4, PS-D14); hier wird geprueft,
// dass beides da ist und NICHTS laeuft - kein Zugang, kein Tunnel, keine
// Umleitung (eine frische Box hat keine Zustellung).

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
)

// helferImSkriptstand ist der Pfad des Helfers im ausgepackten Skriptstand.
const helferImSkriptstand = "files/etc/init.d/vp-vermarkter"

// befehlDirektvermarktung liest den Stand am Geraet. Die Schluessel kollidieren
// bewusst nicht mit denen des status-Verbs (dienst, zugang, openvpn, tunnel,
// umleitung), das als root dahinter laeuft; sein Exit-Code (3 = Waechter steht)
// ist hier kein Fehler.
const befehlDirektvermarktung = `if command -v openvpn >/dev/null 2>&1; then echo firmware_openvpn=da; else echo firmware_openvpn=fehlt; fi
echo openvpn_fassung=$(openvpn --version 2>/dev/null | head -n 1 | cut -d' ' -f1-2)
if [ -x /etc/init.d/vp-vermarkter ]; then echo helfer=da; else echo helfer=fehlt; fi
if ls /etc/rc.d/ 2>/dev/null | grep -q 'vp-vermarkter$'; then echo start=da; else echo start=fehlt; fi
/etc/init.d/vp-vermarkter status 2>/dev/null || true`

// direktvermarktungBereit prueft die Pruefung direktvermarktung_bereit. Ein
// Skriptstand ohne den Helfer (vor Stufe 5) laesst den Beleg das sagen, statt
// zu schweigen - wie der Schritt grundprogramm bei einer Fassung ohne
// Bootapplikation.
func (l *Lauf) direktvermarktungBereit(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	// Ob der Skriptstand der Fassung den Helfer traegt, sagt der ausgepackte
	// Stand des Laufs - deterministisch, nicht der Zustand des Geraets.
	_, dir, err := l.skripte()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(dir, helferImSkriptstand)); err != nil {
		grund := "der Skriptstand der Fassung " + l.freigabe.EdgeLight.Fassung + " trägt den Helfer vp-vermarkter nicht (vor Stufe 5)"
		l.belege["direktvermarktung_bereit"] = "Schritt direktvermarktung: übersprungen - " + grund +
			". Am Gerät ist nichts geändert; der Helfer kommt mit der nächsten Fassung."
		return protokoll.Beleg{}.Mit("ergebnis", "übersprungen - "+grund), nil
	}
	aus, err := l.lies(ctx, befehlDirektvermarktung)
	if err != nil {
		return nil, err
	}
	w := map[string]string{}
	for _, zeile := range strings.Split(aus, "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(zeile), "="); ok {
			w[k] = v
		}
	}
	b := protokoll.Beleg{}
	for _, k := range []string{"firmware_openvpn", "openvpn_fassung", "helfer", "start", "dienst", "zugang", "openvpn", "tunnel", "umleitung"} {
		b = b.Mit(k, orNull(w[k]))
	}
	switch {
	case w["firmware_openvpn"] != "da":
		return b, errors.New("das Firmware-OpenVPN fehlt auf dem Gerät")
	case !strings.HasPrefix(w["openvpn_fassung"], "OpenVPN "):
		return b, fmt.Errorf("openvpn --version nennt keine Fassung (%q)", w["openvpn_fassung"])
	case w["helfer"] != "da":
		return b, errors.New("der Helfer /etc/init.d/vp-vermarkter fehlt auf dem Gerät - install.sh hat ihn nicht gelegt")
	case w["start"] != "da":
		return b, errors.New("der Start-Link des Helfers in /etc/rc.d fehlt - er startet nicht mit dem Gerät")
	case w["zugang"] != "fehlt":
		return b, errors.New("auf einem frischen Gerät darf kein Vermarkter-Zugang liegen")
	case w["openvpn"] != "steht":
		return b, errors.New("auf einem frischen Gerät darf kein Vermarkter-OpenVPN laufen")
	case w["tunnel"] != "unten":
		return b, errors.New("die Tunnel-Schnittstelle des Vermarkters darf auf einem frischen Gerät nicht oben sein")
	case w["umleitung"] != "fehlt":
		return b, errors.New("auf einem frischen Gerät darf keine Umleitung (502 auf 1512) stehen")
	}
	l.belege["direktvermarktung_bereit"] = "Schritt direktvermarktung: " + w["openvpn_fassung"] +
		" (Firmware), Helfer vp-vermarkter aus dem Skriptstand (Prüfsumme im signierten Manifest), Start mit dem Gerät (" + waechter(w["dienst"]) +
		"); ohne Zustellung: kein Zugang, Tunnel aus, keine Umleitung"
	return b.Mit("ergebnis", "bereit (ohne Zustellung, Tunnel aus)"), nil
}

// waechter beschreibt den Waechter-Stand fuer den Beleg: install.sh startet
// ihn; vor dem Neustart darf er auch noch stehen (der rc-Link bringt ihn hoch).
func waechter(dienst string) string {
	if dienst == "laeuft" {
		return "Wächter läuft"
	}
	return "Wächter steht noch, rc-Link gesetzt"
}
