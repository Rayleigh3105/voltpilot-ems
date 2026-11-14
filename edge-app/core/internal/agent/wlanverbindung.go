package agent

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// wlanVerbindungZeit begrenzt den Skriptaufruf - "status" liest nur uci/
// iwinfo und braucht normalerweise Millisekunden. Anders als die
// Einrichtungsseite (30 s, dort kann das Funkmodul gerade das Kunden-WLAN
// suchen) läuft dieser Aufruf im Herzschlag-Takt alle 15 s und darf ihn nie
// lange blockieren.
const wlanVerbindungZeit = 3 * time.Second

// wlanVerbindung ist, womit Edge Light gerade zum Kundenrouter kommt
// (Konzept vp-edge-light-wlan, E1=B, S5): "kabel" oder "wlan", dazu bei WLAN
// das von der Box selbst gemessene Signal. "", nil bei jedem anderen Fall -
// kein Edge Light, das Netz-Skript fehlt, oder modus=keins (noch nichts
// eingerichtet). "" ist nie "kabel" oder "wlan": die Oberfläche darf daraus
// nie eine Verbindungsart erfinden.
func (a *Agent) wlanVerbindung() (string, *int) {
	if a.wlanVerbindungFn != nil {
		return a.wlanVerbindungFn()
	}
	if !a.isLight() || a.Cfg.WlanSkript == "" {
		return "", nil
	}
	return wlanVerbindungVonSkript(a.Cfg.WlanSkript)
}

// wlanVerbindungVonSkript ruft das Netz-Skript der Box NUR LESEND auf
// ("status" ändert nichts, edge-light/openwrt/.../wlan-anschluss.sh,
// befehl_status) und liest modus=/wlan_signal= aus seiner
// "schluessel=wert"-Ausgabe - derselben Form wie web/einrichtung.go.
func wlanVerbindungVonSkript(skript string) (string, *int) {
	ctx, cancel := context.WithTimeout(context.Background(), wlanVerbindungZeit)
	defer cancel()
	aus, err := exec.CommandContext(ctx, skript, "status").Output()
	if err != nil {
		return "", nil
	}
	felder := wlanFelderAusZeilen(string(aus))
	switch felder["modus"] {
	case "wlan":
		var signal *int
		if n, err := strconv.Atoi(strings.TrimSpace(felder["wlan_signal"])); err == nil {
			signal = &n
		}
		return "wlan", signal
	case "kabel":
		return "kabel", nil
	default:
		return "", nil // "keins" oder ein unbekanntes Wort: nichts behaupten
	}
}

// wlanFelderAusZeilen liest dieselbe "schluessel=wert"-Form wie die private
// web.felderAusZeilen - eine eigene, kleine Kopie, weil beide Pakete dafür
// keine gemeinsame Abhängigkeit verdienen.
func wlanFelderAusZeilen(aus string) map[string]string {
	f := map[string]string{}
	for _, z := range strings.Split(aus, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(z), "=")
		if ok && k != "" && !strings.ContainsAny(k, " \t") {
			f[k] = v
		}
	}
	return f
}
