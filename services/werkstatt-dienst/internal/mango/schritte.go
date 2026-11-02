package mango

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/box"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/durchreiche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/passwort"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/referenz"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/wartung"
)

// zurSeite ist der Handgriff, wenn eine Box nicht in den Ablauf passt.
const zurSeite = "Mango abziehen und zur Seite legen; den Grund im Portal oder beim Betreiber melden."

// ---- P3: erkennen ab Werk ------------------------------------------------------

// Was die Werksfirmware über sich sagt. Nie das Passwort selbst: nur, ob root eines hat.
const befehlWerk = `echo "board=$(cat /tmp/sysinfo/board_name 2>/dev/null)"
echo "modell=$(cat /tmp/sysinfo/model 2>/dev/null)"
echo "gl=$(cat /etc/glversion 2>/dev/null)"
echo "basis=$(. /etc/openwrt_release 2>/dev/null; echo "$DISTRIB_RELEASE")"
if [ -z "$(sed -n 's/^root:\([^:]*\):.*/\1/p' /etc/shadow 2>/dev/null)" ]; then echo rootpw=leer; else echo rootpw=gesetzt; fi
echo "tmp_frei_kb=$(df -k /tmp 2>/dev/null | awk 'NR==2 {print $4}')"
echo "edge=$([ -e /etc/init.d/vp-edge-light ] && echo ja || echo nein)"`

func (l *Lauf) erkennenWerk(ctx context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
	s, err := l.k.Werkbank.Status(ctx)
	if err != nil {
		return nil, err
	}
	e, err := Einzeln(s)
	if err != nil {
		return nil, err
	}
	if e.Adresse != WerksAdresse {
		return nil, fmt.Errorf("das Gerät antwortet unter %s, nicht unter %s (ab Werk)", e.Adresse, WerksAdresse)
	}
	l.mac = e.MAC
	b := protokoll.Beleg{}.Mit("mac", e.MAC).Mit("mac_hinweis", macHinweis(e.MAC))
	v, err := box.Verbinde(ctx, l.k.Werkbank, netip.AddrPortFrom(WerksAdresse, 22), geheim.Geheim{}, nil, l.k.Zeiten.Verbinden)
	var ab box.Abgewiesen
	if errors.As(err, &ab) {
		return b, lauf.Handgriff{Was: zurSeite, Grund: "Die Mango verlangt ein Passwort: Sie ist schon eingerichtet, oder ihre Firmware lässt SSH ohne Passwort nicht zu (Prüfstein PS-1). Der Dienst rät keine Passwörter."}
	}
	if err != nil {
		return b, err
	}
	defer v.Schliesse()
	b = b.Mit("ssh", "root ohne Passwort angenommen").Mit("host_schluessel_werk", v.HostArt()+" "+v.HostFingerabdruck())
	w, _, err := v.Werte(ctx, befehlWerk)
	if err != nil {
		return b, err
	}
	b = b.Mit("board", w["board"]).Mit("modell", w["modell"]).Mit("gl_firmware", w["gl"]).Mit("basis", "OpenWrt "+w["basis"]).Mit("root_passwort", w["rootpw"])
	switch {
	case !boardPasst(w["board"]):
		return b, lauf.Handgriff{Was: zurSeite, Grund: fmt.Sprintf("Das Gerät ist keine GL-MT300N-V2 (board %q).", w["board"])}
	case w["gl"] == "":
		return b, lauf.Handgriff{Was: zurSeite, Grund: "Unter 192.168.8.1 antwortet keine GL-Werksfirmware (/etc/glversion fehlt)."}
	case w["rootpw"] != "leer":
		return b, lauf.Handgriff{Was: zurSeite, Grund: "root hat ein Passwort: Die Mango ist schon eingerichtet. Der Dienst fasst eingerichtete Geräte nicht an."}
	case w["edge"] == "ja":
		return b, lauf.Handgriff{Was: zurSeite, Grund: "Auf dem Gerät ist schon Edge Light: keine Mango ab Werk."}
	}
	l.tmpFrei, _ = strconv.ParseInt(w["tmp_frei_kb"], 10, 64)
	b = b.Mit("gl_schnittstelle", l.glSchnittstelle(ctx))
	return b, nil
}

// glSchnittstelle fragt die GL-Schnittstelle (3.x: /cgi-bin/api/router/hello)
// und hält die Antwort als Beleg fest. Ihre Felder sind nicht nachgemessen
// (PS-1); entschieden wird über SSH, Board und Passwort, nicht hierüber.
func (l *Lauf) glSchnittstelle(ctx context.Context) string {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return l.k.Werkbank.Dial(ctx, netip.AddrPortFrom(WerksAdresse, 80))
	}}
	defer tr.CloseIdleConnections()
	cl := &http.Client{Transport: tr, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://192.168.8.1/cgi-bin/api/router/hello", nil)
	resp, err := cl.Do(req)
	if err != nil {
		return "keine Antwort: " + err.Error()
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 400))
	return fmt.Sprintf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
}

func macHinweis(mac string) string {
	if strings.HasPrefix(strings.ToLower(mac), "94:83:c4") {
		return "Hersteller GL.iNet (94:83:C4) - ein Hinweis, kein Beweis"
	}
	return "Präfix nicht von GL.iNet - ein Hinweis, kein Beweis"
}

// ---- P3/P5: erkennen mit frischem OpenWrt -----------------------------------------

const befehlOpenWrt = `. /etc/openwrt_release 2>/dev/null; echo "release=$DISTRIB_RELEASE"; echo "target=$DISTRIB_TARGET"
echo "board=$(cat /tmp/sysinfo/board_name 2>/dev/null)"
echo "gl=$([ -e /etc/glversion ] && echo ja || echo nein)"
if [ -z "$(sed -n 's/^root:\([^:]*\):.*/\1/p' /etc/shadow 2>/dev/null)" ]; then echo rootpw=leer; else echo rootpw=gesetzt; fi
echo "edge=$([ -e /etc/init.d/vp-edge-light ] && echo ja || echo nein)"
echo "dropbear=$(dropbear -V 2>&1 | head -n1)"`

// openwrtPruefen meldet sich an frischem OpenWrt an, hält den Host-Schlüssel
// für den Lauf fest und prüft Fassung und Werkszustand.
func (l *Lauf) openwrtPruefen(ctx context.Context, b protokoll.Beleg) (protokoll.Beleg, error) {
	ziel := netip.AddrPortFrom(OpenWrtAdresse, 22)
	v, err := box.Verbinde(ctx, l.k.Werkbank, ziel, geheim.Geheim{}, nil, l.k.Zeiten.Verbinden)
	var ab box.Abgewiesen
	if errors.As(err, &ab) {
		return b, lauf.Handgriff{Was: zurSeite, Grund: "Das Gerät unter 192.168.1.1 verlangt ein Passwort: kein frisches OpenWrt. Der Dienst fasst eingerichtete Geräte nicht an."}
	}
	if err != nil {
		return b, err
	}
	w, _, err := v.Werte(ctx, befehlOpenWrt)
	if err != nil {
		v.Schliesse()
		return b, err
	}
	b = b.Mit("openwrt", w["release"]+" "+w["target"]).Mit("board", w["board"]).Mit("dropbear", w["dropbear"]).Mit("root_passwort", w["rootpw"]).
		Mit("host_schluessel", v.HostArt()+" "+v.HostFingerabdruck())
	grund := ""
	switch {
	case w["release"] != l.freigabe.OpenWrt.Fassung:
		grund = fmt.Sprintf("OpenWrt %q statt %s aus der Freigabe.", w["release"], l.freigabe.OpenWrt.Fassung)
	case !boardPasst(w["board"]):
		grund = fmt.Sprintf("Das Gerät ist keine GL-MT300N-V2 (board %q).", w["board"])
	case w["gl"] == "ja":
		grund = "Unter 192.168.1.1 läuft noch GL-Firmware."
	case w["rootpw"] != "leer":
		grund = "root hat ein Passwort: kein frisches OpenWrt."
	case w["edge"] == "ja":
		grund = "Auf dem Gerät ist schon Edge Light: kein frisches OpenWrt."
	}
	if grund != "" {
		v.Schliesse()
		return b, lauf.Handgriff{Was: zurSeite, Grund: grund}
	}
	l.v, l.ziel = v, ziel
	l.host, l.hostArt = v.HostFingerabdruck(), v.HostArt()
	l.belege["host_schluessel"] = "LAN-Weg: " + l.host + " (Schritt erkennen/wiedererkennen und neustart)"
	return b, nil
}

func (l *Lauf) erkennenOpenWrt(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	s, err := l.k.Werkbank.Status(ctx)
	if err != nil {
		return nil, err
	}
	e, err := Einzeln(s)
	if err != nil {
		return nil, err
	}
	if e.Adresse != OpenWrtAdresse {
		return nil, fmt.Errorf("das Gerät antwortet unter %s, nicht unter %s (frisches OpenWrt)", e.Adresse, OpenWrtAdresse)
	}
	l.mac = e.MAC
	return l.openwrtPruefen(ctx, protokoll.Beleg{}.Mit("mac", e.MAC).Mit("mac_hinweis", macHinweis(e.MAC)))
}

// ---- Fassungen ---------------------------------------------------------------------

func (l *Lauf) fassungenHolen(mitAbbild bool) func(context.Context, *lauf.Kontext) (protokoll.Beleg, error) {
	return func(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
		abbild, programm, skripte := fassungen.Dateien(l.freigabe, l.k.Bauart)
		liste := []fassungen.Datei{programm, skripte}
		if mitAbbild {
			liste = append([]fassungen.Datei{abbild}, liste...)
		}
		b := protokoll.Beleg{}.Mit("freigabe", l.freigabe.Kennung)
		for _, d := range liste {
			erg, err := l.k.Fassungen.Hole(ctx, d)
			if err != nil {
				return b, err
			}
			herkunft := "aus dem Zwischenspeicher"
			if erg.Geladen {
				herkunft = "geladen von " + d.URL
			}
			b = b.Mit(d.Name, fmt.Sprintf("sha256 %s, %d Bytes, %s", d.Sha256, erg.Groesse, herkunft))
			switch d.Name {
			case abbild.Name:
				l.pfadAbbild = erg.Pfad
			case programm.Name:
				l.pfadProgramm = erg.Pfad
			case skripte.Name:
				l.pfadSkripte = erg.Pfad
			}
		}
		return b, nil
	}
}

// ---- P3: OpenWrt aufspielen ---------------------------------------------------------

const abbildAufBox = "/tmp/vp-openwrt.bin"

func (l *Lauf) openwrtAufspielen(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	st, err := os.Stat(l.pfadAbbild)
	if err != nil {
		return nil, err
	}
	if l.tmpFrei > 0 && l.tmpFrei < st.Size()/1024+1024 {
		return nil, fmt.Errorf("auf der Mango sind in /tmp nur %d kB frei, das Abbild braucht %d kB", l.tmpFrei, st.Size()/1024+1024)
	}
	v, err := box.Verbinde(ctx, l.k.Werkbank, netip.AddrPortFrom(WerksAdresse, 22), geheim.Geheim{}, nil, l.k.Zeiten.Verbinden)
	if err != nil {
		return nil, err
	}
	defer v.Schliesse()
	summe, err := fassungen.Summe(l.pfadAbbild)
	if err != nil || summe != l.freigabe.OpenWrt.Sha256 {
		return nil, fmt.Errorf("Abbild im Zwischenspeicher hat nicht die Prüfsumme der Freigabe")
	}
	b := protokoll.Beleg{}.Mit("sha256_dienst", summe)
	f, err := os.Open(l.pfadAbbild)
	if err != nil {
		return b, err
	}
	erg, err := v.Fuehre(ctx, "cat > "+abbildAufBox, f)
	_ = f.Close()
	if err != nil || erg.Code != 0 {
		return b, fmt.Errorf("Abbild übertragen: %v %s", err, erg.Text())
	}
	erg, err = v.Fuehre(ctx, "sha256sum "+abbildAufBox, nil)
	if err != nil {
		return b, err
	}
	aufBox := strings.Fields(erg.Aus + " ")[0]
	b = b.Mit("sha256_box", aufBox)
	if aufBox != summe {
		return b, fmt.Errorf("Prüfsumme auf der Box %s, erwartet %s: nicht aufgespielt", aufBox, summe)
	}
	erg, err = v.Fuehre(ctx, "sysupgrade -T "+abbildAufBox, nil)
	if err != nil {
		return b, err
	}
	b = b.Mit("sysupgrade_test", "Ausgang "+strconv.Itoa(erg.Code)+" "+kurz(erg.Text(), 300))
	if erg.Code != 0 {
		return b, lauf.Handgriff{
			Was:   "Startlader (Handgriff M4): Mango vom Strom, Reset-Knopf halten und Strom stecken, bis die Leuchte fünfmal blinkt; am Rechner 192.168.1.2 einstellen, http://192.168.1.1 öffnen und " + l.freigabe.OpenWrt.Datei + " hochladen. Danach steckt die Mango mit frischem OpenWrt am orangen Kabel, und der Dienst macht weiter.",
			Grund: "Die Werksfirmware nimmt das Abbild nicht an (sysupgrade -T): " + letzte(erg.Text(), 3),
		}
	}
	// -n: GL-Einstellungen passen nicht zu OpenWrt. Nie -F.
	erg, err = v.Fuehre(ctx, "sysupgrade -n "+abbildAufBox, nil)
	switch {
	case errors.Is(err, box.Abgerissen):
		b = b.Mit("sysupgrade", strings.TrimSpace(kurz(erg.Text()+"\n(Verbindung beendet: die Mango startet neu)", 300)))
	case err != nil:
		return b, err
	case erg.Code != 0:
		return b, fmt.Errorf("sysupgrade -n endete mit %d: %s", erg.Code, letzte(erg.Text(), 4))
	default:
		b = b.Mit("sysupgrade", kurz(erg.Text(), 300)+" (angenommen, die Mango startet neu)")
	}
	return b, nil
}

func (l *Lauf) wiedererkennen(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	b := protokoll.Beleg{}
	beginn := time.Now()
	var e Einzig
	err := l.warteAuf(ctx, l.k.Zeiten.Sysupgrade, func() error {
		s, err := l.k.Werkbank.Status(ctx)
		if err != nil {
			return err
		}
		if len(antworten(s, OpenWrtAdresse)) == 0 {
			return errors.New("unter 192.168.1.1 antwortet noch nichts")
		}
		e, err = Einzeln(s)
		if err != nil {
			return err
		}
		if e.Adresse != OpenWrtAdresse {
			return fmt.Errorf("Gerät unter %s statt 192.168.1.1", e.Adresse)
		}
		// Dropbear kommt etwas nach dem Netz.
		probe, err := box.Verbinde(ctx, l.k.Werkbank, netip.AddrPortFrom(OpenWrtAdresse, 22), geheim.Geheim{}, nil, l.k.Zeiten.Verbinden)
		if err != nil {
			var ab box.Abgewiesen
			if errors.As(err, &ab) {
				return lauf.Handgriff{Was: zurSeite, Grund: "Nach dem Aufspielen verlangt die Box ein Passwort: kein frisches OpenWrt."}
			}
			return err
		}
		probe.Schliesse()
		return nil
	})
	if err != nil {
		return b, fmt.Errorf("nach %s antwortet kein frisches OpenWrt unter 192.168.1.1: %w", l.k.Zeiten.Sysupgrade, err)
	}
	b = b.Mit("dauer_bis_openwrt", time.Since(beginn).Round(time.Second).String()).Mit("mac", e.MAC)
	if e.MAC != l.mac {
		b = b.Mit("mac_hinweis", "MAC ab Werk war "+l.mac+"; OpenWrt meldet "+e.MAC+" (eine Box am Kabel)")
		l.mac = e.MAC
	}
	return l.openwrtPruefen(ctx, b)
}

// ---- P5: befristetes Werkstatt-Internet --------------------------------------------

func (l *Lauf) netzNeuLaden(ctx context.Context, befehle string, ziel netip.AddrPort) error {
	// Die Box lädt ihr Netz neu; die Sitzung kann dabei abreißen. Darum im
	// Hintergrund, danach neu anmelden.
	if _, err := l.fuehre(ctx, befehle+"\nuci commit network\n(sleep 1; /etc/init.d/network reload) >/dev/null 2>&1 </dev/null &", ""); err != nil && !errors.Is(err, box.Abgerissen) {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(3 * l.k.Zeiten.Takt):
	}
	return l.neuVerbinden(ctx, ziel, l.k.Zeiten.Netz)
}

func (l *Lauf) internetAn(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	gw := BrueckeOpenWrt
	var dns strings.Builder
	for _, d := range l.k.DNS {
		dns.WriteString("uci add_list network.lan.dns=" + shellWort(d.String()) + "\n")
	}
	befehle := "uci -q delete network.lan.gateway\nuci set network.lan.gateway=" + shellWort(gw.String()) + "\nuci -q delete network.lan.dns\n" + dns.String()
	if err := l.netzNeuLaden(ctx, befehle, l.ziel); err != nil {
		return nil, err
	}
	b := protokoll.Beleg{}
	var w map[string]string
	err := l.warteAuf(ctx, l.k.Zeiten.Netz, func() error {
		var err error
		w, _, err = l.v.Werte(ctx, `echo "weg=$(ip -4 route show default | head -n1)"
if wget -q -O /dev/null -T 10 https://downloads.openwrt.org/ 2>/dev/null; then echo internet=ja; else echo internet=nein; fi`)
		if err != nil {
			return err
		}
		if !strings.Contains(w["weg"], "via "+gw.String()) || w["internet"] != "ja" {
			return fmt.Errorf("Standardweg %q, Internet %s", w["weg"], w["internet"])
		}
		return nil
	})
	if err != nil {
		return b.Mit("standardweg", w["weg"]).Mit("internet", w["internet"]), fmt.Errorf("kein Internet über die Brücke (Prüfstein PS-12): %w", err)
	}
	return b.Mit("standardweg", w["weg"]).Mit("internet", "https://downloads.openwrt.org erreichbar über die Brücke (befristet, am Ende entfernt)"), nil
}

// ---- P5: Root-Passwort ------------------------------------------------------------

func (l *Lauf) passwortSetzen(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	pw, err := passwort.Neu()
	if err != nil {
		return nil, err
	}
	text, err := passwort.Verschluessle(pw, l.k.Empfaenger)
	if err != nil {
		pw.Vergessen()
		return nil, fmt.Errorf("Passwort verschlüsseln: %v", err)
	}
	// Erst verschlüsseln, dann setzen: Ohne Ablage gäbe es eine Box mit
	// einem Passwort, das niemand kennt.
	erg, err := l.fuehre(ctx, "passwd root", pw.Offenbaren()+"\n"+pw.Offenbaren()+"\n")
	if err != nil {
		pw.Vergessen()
		return nil, err
	}
	b := protokoll.Beleg{}.Mit("passwd", zeilenMit(erg.Text(), "passw"))
	if _, err := box.Verbinde(ctx, l.k.Werkbank, l.ziel, geheim.Geheim{}, box.GenauDieser(l.host), l.k.Zeiten.Verbinden); err == nil {
		l.pw = pw
		return b, errors.New("die Box nimmt die Anmeldung ohne Passwort weiter an")
	} else if !errors.As(err, new(box.Abgewiesen)) {
		l.pw = pw
		return b, err
	}
	b = b.Mit("ohne_passwort", "abgewiesen")
	l.pw = pw
	if err := l.neuVerbinden(ctx, l.ziel, l.k.Zeiten.Verbinden); err != nil {
		return b, fmt.Errorf("Anmeldung mit dem neuen Passwort: %w", err)
	}
	b = b.Mit("mit_passwort", "angemeldet").Mit("passwort_age", text)
	l.passwortAge = text
	l.belege["root_passwort"] = "Schritt passwort: je Box zufällig (20 Zeichen), verschlüsselt für den age-Schlüssel Box-Passwörter im Beleg passwort_age"
	return b, nil
}

// ---- P5: Notfall-Schlüssel ------------------------------------------------------------

func (l *Lauf) notfallSchluessel(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	if _, err := l.fuehre(ctx, "umask 077 && cat > /etc/dropbear/authorized_keys && chmod 600 /etc/dropbear/authorized_keys", strings.TrimSpace(l.k.Notfall)+"\n"); err != nil {
		return nil, err
	}
	n, fp, err := l.dauerhafteSchluessel(ctx)
	b := protokoll.Beleg{}.Mit("zeilen", strconv.Itoa(n)).Mit("fingerabdruck", fp)
	if err != nil {
		return b, err
	}
	l.belege["notfall_schluessel"] = "Schritt notfall und neustart: genau eine Zeile, Fingerabdruck " + fp
	return b, nil
}

// dauerhafteSchluessel liest /etc/dropbear/authorized_keys: genau eine Zeile,
// der Notfall-Schlüssel.
func (l *Lauf) dauerhafteSchluessel(ctx context.Context) (int, string, error) {
	erg, err := l.fuehre(ctx, "cat /etc/dropbear/authorized_keys", "")
	if err != nil {
		return 0, "", err
	}
	var fps []string
	sc := bufio.NewScanner(strings.NewReader(erg.Aus))
	for sc.Scan() {
		z := strings.TrimSpace(sc.Text())
		if z == "" || strings.HasPrefix(z, "#") {
			continue
		}
		pk, _, _, _, err := ssh.ParseAuthorizedKey([]byte(z))
		if err != nil {
			fps = append(fps, "unlesbar")
			continue
		}
		fps = append(fps, ssh.FingerprintSHA256(pk))
	}
	if len(fps) != 1 || fps[0] != l.notfallFP {
		return len(fps), strings.Join(fps, ", "), fmt.Errorf("dauerhafte Schlüssel auf der Box: %d (%s), erwartet genau den Notfall-Schlüssel %s", len(fps), strings.Join(fps, ", "), l.notfallFP)
	}
	return 1, fps[0], nil
}

// ---- P5: Edge Light ----------------------------------------------------------------

func (l *Lauf) skripte() (*durchreiche.Server, string, error) {
	basis := filepath.Join(l.dir, "edge-light")
	if l.dr == nil {
		if err := fassungen.Auspacken(l.pfadSkripte, basis); err != nil {
			return nil, "", err
		}
		dist := filepath.Join(basis, "dist")
		if err := os.MkdirAll(dist, 0o755); err != nil {
			return nil, "", err
		}
		inhalt, err := os.ReadFile(l.pfadProgramm)
		if err != nil {
			return nil, "", err
		}
		if err := os.WriteFile(filepath.Join(dist, fassungen.ProgrammPraefix+l.k.Bauart), inhalt, 0o755); err != nil {
			return nil, "", err
		}
		dr, err := durchreiche.Starte(filepath.Join(l.dir, "d"), func() *ssh.Client {
			if l.v == nil {
				return nil
			}
			return l.v.Client()
		}, l.log)
		if err != nil {
			return nil, "", err
		}
		l.dr = dr
	}
	return l.dr, filepath.Join(basis, "openwrt"), nil
}

// skript führt ein Skript des Release-Stands gegen die Box aus.
func (l *Lauf) skript(ctx context.Context, name string, args []string, env ...string) (durchreiche.Lauf, error) {
	dr, dir, err := l.skripte()
	if err != nil {
		return durchreiche.Lauf{}, err
	}
	return dr.FuehreSkript(ctx, filepath.Join(dir, name), append([]string{"root@" + l.ziel.Addr().String()}, args...), env)
}

type health struct {
	Status  string `json:"status"`
	Ref     string `json:"ref"`
	Version string `json:"version"`
}

func (l *Lauf) programmEinspielen(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	summe, err := fassungen.Summe(l.pfadProgramm)
	if err != nil || summe != l.freigabe.EdgeLight.ProgrammSha256 {
		return nil, errors.New("Programm im Zwischenspeicher hat nicht die Prüfsumme der Freigabe")
	}
	r, err := l.skript(ctx, "install.sh", nil, "VP_LIGHT_ARCH="+l.k.Bauart)
	if err != nil {
		return nil, err
	}
	b := protokoll.Beleg{}.Mit("install", zeilenMit(r.Ausgabe, "Pruefsumme", "FEHLER", "fertig"))
	if r.Code != 0 || !strings.Contains(r.Ausgabe, "Pruefsumme auf dem Geraet bestaetigt") {
		return b, fmt.Errorf("install.sh endete mit %d: %s", r.Code, letzte(r.Ausgabe, 4))
	}
	if _, err := l.fuehre(ctx, "/etc/init.d/vp-edge-light restart", ""); err != nil {
		return b, err
	}
	var h health
	err = l.warteAuf(ctx, l.k.Zeiten.Programm, func() error {
		erg, err := l.v.Fuehre(ctx, "wget -q -O - http://127.0.0.1:8484/health", nil)
		if err != nil {
			return err
		}
		h = health{}
		if json.Unmarshal([]byte(strings.TrimSpace(erg.Aus)), &h) != nil || h.Ref == "" {
			return errors.New("/health nennt noch keine Referenz")
		}
		return nil
	})
	if err != nil {
		return b, err
	}
	b = b.Mit("health", fmt.Sprintf("ref %s, version %s", h.Ref, h.Version))
	if !referenz.Gueltig(h.Ref) {
		return b, fmt.Errorf("Referenz %q hat kein gültiges Prüfzeichen", h.Ref)
	}
	if h.Version != l.freigabe.EdgeLight.Fassung {
		return b, fmt.Errorf("Edge Light meldet %q, die Freigabe nennt %s", h.Version, l.freigabe.EdgeLight.Fassung)
	}
	l.ref, l.version = h.Ref, h.Version
	return b.Mit("referenz", h.Ref+" (Prüfzeichen gültig)"), nil
}

// ---- P5: Tunnel -----------------------------------------------------------------------

var pubMuster = regexp.MustCompile(`^[A-Za-z0-9+/]{43}=$`)

func (l *Lauf) tunnelSchluessel(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	r, err := l.skript(ctx, "service-tunnel.sh", []string{"key"})
	if err != nil {
		return nil, err
	}
	if r.Code != 0 {
		return nil, fmt.Errorf("service-tunnel.sh key endete mit %d: %s", r.Code, letzte(r.Ausgabe, 4))
	}
	z := strings.Split(r.Ausgabe, "\n")
	pub, ref := "", ""
	for i, s := range z {
		if strings.HasPrefix(s, "oeffentlicher Schluessel des Geraets:") && i+1 < len(z) {
			pub = strings.TrimSpace(z[i+1])
		}
		if v, ok := strings.CutPrefix(s, "Box-Referenz: "); ok {
			ref = strings.TrimSpace(v)
		}
	}
	b := protokoll.Beleg{}.Mit("tunnel_schluessel", pub).Mit("referenz", ref)
	if !pubMuster.MatchString(pub) {
		return b, fmt.Errorf("kein öffentlicher WireGuard-Schlüssel in der Ausgabe: %s", letzte(r.Ausgabe, 4))
	}
	if ref != l.ref {
		return b, fmt.Errorf("Box-Referenz %q, /health nannte %s", ref, l.ref)
	}
	l.tunnelPub = pub
	return b, nil
}

// HinweisTunnel sagt, was der Betreiber für die Tunnel-Adresse tut.
func HinweisTunnel(ref, pub string) string {
	return "Im Portal unter Geräte › Fernwartung „Tunnel-Schlüssel hinterlegen“: Referenz " + ref + ", Schlüssel " + pub +
		". Dann die zugeteilte Adresse eintragen: kubectl -n werkstatt-prod exec deploy/werkstatt-dienst -- vp-werkstatt-dienst eingabe tunnel_adresse <adresse>"
}

// PruefeTunnelAdresse prüft eine Eingabe für die Tunnel-Adresse.
func PruefeTunnelAdresse(s string, boxNetz netip.Prefix) (netip.Addr, error) {
	a, err := netip.ParseAddr(strings.TrimSpace(s))
	if err != nil || !a.Is4() || !boxNetz.Contains(a) || a == boxNetz.Masked().Addr() {
		return netip.Addr{}, fmt.Errorf("%q ist keine Adresse im Box-Netz %s", s, boxNetz)
	}
	return a, nil
}

// adressSchritt: mit der API löst die Box selbst einen Einmal-Code ein und
// bekommt dabei ihre Adresse (V1); ohne sie trägt der Betreiber die Adresse
// aus dem Portal ein (V1a).
func (l *Lauf) adressSchritt() lauf.Schritt {
	if l.k.Portal != nil {
		return lauf.Schritt{Kennung: "einloesen", Titel: "Einmal-Code einlösen", Frist: 5 * time.Minute, Tun: l.einloesen}
	}
	return lauf.Schritt{Kennung: "tunnel_adresse", Titel: "Tunnel-Adresse aus dem Portal", Frist: 12 * time.Hour, Tun: l.tunnelAdresseHolen}
}

// Rückgabewerte von werkstatt-anmelden (edge-app/core/internal/werkstatt).
const (
	anmeldenAbgewiesen   = 3
	anmeldenUnerreichbar = 4
)

// anmeldenBefehl ruft werkstatt-anmelden mit Datenverzeichnis, Programm und
// Portal aus der UCI-Konfiguration der Box auf (wie boot.sh). Der Code kommt
// über die Standardeingabe und steht nie im Befehl.
func anmeldenBefehl(wgPub, host string) string {
	return `D="$(uci -q get vp-edge-light.main.data_dir || echo /etc/vp-edge-light)"
R="$(uci -q get vp-edge-light.main.ram_dir || echo /tmp/vp-edge-light)"
P="$(uci -q get vp-edge-light.main.portal_url || echo https://portal.voltpilot.de)"
exec "$R/vp-edge-light" werkstatt-anmelden --daten "$D" --portal "$P" --wireguard '` + wgPub + `' --host-schluessel '` + host + `'`
}

// einloesung ist der Teil der Antwort, den der Lauf braucht
// (docs/contracts/werkstatt-einloesen-v1.md, Antwort).
type einloesung struct {
	Schema         string `json:"schema"`
	EdgeRef        string `json:"edgeRef"`
	Freigabe       string `json:"freigabe"`
	TunnelErgebnis string `json:"tunnelErgebnis"`
	Tunnel         struct {
		Adresse         string `json:"adresse"`
		ServerPublicKey string `json:"serverPublicKey"`
		ServerEndpunkt  string `json:"serverEndpunkt"`
		ServerPort      int    `json:"serverPort"`
	} `json:"tunnel"`
	Probe struct {
		FensterID     string    `json:"fensterId"`
		TechnikerName string    `json:"technikerName"`
		Ende          time.Time `json:"ende"`
	} `json:"probe"`
	GeraeteSchluessel struct {
		Sha256 string `json:"sha256"`
	} `json:"geraeteSchluessel"`
}

// einloesen: Code holen (nur in der laufenden Freigabe), die Box löst ihn mit
// ihrem Geräteschlüssel selbst ein. Die API hält dabei den Geräteschlüssel
// fest (D2), hinterlegt den Tunnel-Schlüssel und öffnet das Probe-Fenster.
// Der Code steht in keinem Beleg und keinem Log.
func (l *Lauf) einloesen(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	if !pubMuster.MatchString(l.tunnelPub) || l.host == "" {
		return nil, errors.New("Tunnel-Schlüssel oder Host-Schlüssel fehlen (Schritte tunnel_schluessel, erkennen)")
	}
	c, err := l.k.Portal.CodeHolen(ctx, l.ref, false)
	if err != nil {
		return nil, fmt.Errorf("Einmal-Code: %w", err)
	}
	defer c.Code.Vergessen()
	b := protokoll.Beleg{}.Mit("code", "für "+c.EdgeRef+" ausgegeben, gilt bis "+c.GueltigBis.UTC().Format(time.RFC3339)+" (steht in keinem Beleg)").
		Mit("freigabe", c.Freigabe)
	erg, err := l.v.Fuehre(ctx, anmeldenBefehl(l.tunnelPub, l.host), strings.NewReader(c.Code.Offenbaren()+"\n"))
	if err != nil {
		return b, err
	}
	switch erg.Code {
	case 0:
	case anmeldenAbgewiesen:
		return b.Mit("abgewiesen", geheim.Schwaerze(letzte(erg.Fehl, 4))), fmt.Errorf("das Portal hat die Einlösung abgewiesen: %s", geheim.Schwaerze(letzte(erg.Fehl, 2)))
	case anmeldenUnerreichbar:
		return b, fmt.Errorf("die Box erreicht das Portal nicht: %s", geheim.Schwaerze(letzte(erg.Fehl, 2)))
	default:
		return b, fmt.Errorf("werkstatt-anmelden endete mit %d: %s", erg.Code, geheim.Schwaerze(letzte(erg.Text(), 4)))
	}
	var e einloesung
	if err := json.Unmarshal([]byte(strings.TrimSpace(erg.Aus)), &e); err != nil {
		return b, fmt.Errorf("Antwort von werkstatt-anmelden ist kein JSON: %v", err)
	}
	if e.Schema != "vp-werkstatt-einloesung.v1" || e.EdgeRef != l.ref {
		return b, fmt.Errorf("Antwort passt nicht zur Box (Schema %q, Kennung %q)", e.Schema, e.EdgeRef)
	}
	a, err := PruefeTunnelAdresse(e.Tunnel.Adresse, l.k.BoxNetz)
	if err != nil {
		return b, fmt.Errorf("Adresse aus der Einlösung: %w", err)
	}
	if e.Tunnel.ServerPublicKey != "" && l.k.WartungPub != "" && e.Tunnel.ServerPublicKey != l.k.WartungPub {
		return b, errors.New("das Portal nennt einen anderen Schlüssel des Wartungsservers als die Konfiguration des Dienstes")
	}
	if e.Probe.FensterID == "" {
		return b, errors.New("die Einlösung nennt kein Probe-Fenster")
	}
	l.tunnelAdresse = a.String()
	l.probeFenster = e.Probe.FensterID
	l.serverPub, l.serverEP = l.k.WartungPub, l.k.WartungEP
	if e.Tunnel.ServerPublicKey != "" {
		l.serverPub = e.Tunnel.ServerPublicKey
	}
	if e.Tunnel.ServerEndpunkt != "" && e.Tunnel.ServerPort > 0 {
		l.serverEP = net.JoinHostPort(e.Tunnel.ServerEndpunkt, strconv.Itoa(e.Tunnel.ServerPort))
	}
	return b.Mit("tunnel_ergebnis", e.TunnelErgebnis).
		Mit("tunnel_adresse", a.String()).
		Mit("probe_fenster", e.Probe.FensterID+" für "+e.Probe.TechnikerName+" bis "+e.Probe.Ende.UTC().Format(time.RFC3339)).
		Mit("geraete_schluessel", "festgehalten, sha256 "+e.GeraeteSchluessel.Sha256), nil
}

func (l *Lauf) tunnelAdresseHolen(ctx context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
	for {
		w, err := k.Warte(ctx, "tunnel_adresse", HinweisTunnel(l.ref, l.tunnelPub))
		if err != nil {
			return nil, err
		}
		a, err := PruefeTunnelAdresse(w, l.k.BoxNetz)
		if err != nil {
			k.Log.Warn("Eingabe abgelehnt", "grund", err)
			continue
		}
		l.tunnelAdresse = a.String()
		return protokoll.Beleg{}.Mit("tunnel_adresse", a.String()).Mit("herkunft", "Portal, Tunnel-Schlüssel hinterlegt (eingetragen vom Betreiber)"), nil
	}
}

var handshakeMuster = regexp.MustCompile(`latest handshake: (.*) ago`)

// handshakeFrisch sagt, ob "latest handshake" jünger als max ist.
func handshakeFrisch(status string, max time.Duration) (string, bool) {
	m := handshakeMuster.FindStringSubmatch(status)
	if m == nil {
		return "", false
	}
	var d time.Duration
	for _, teil := range strings.Split(m[1], ",") {
		f := strings.Fields(teil)
		if len(f) != 2 {
			return m[0], false
		}
		n, err := strconv.Atoi(f[0])
		if err != nil {
			return m[0], false
		}
		switch strings.TrimSuffix(f[1], "s") {
		case "second":
			d += time.Duration(n) * time.Second
		case "minute":
			d += time.Duration(n) * time.Minute
		default:
			return m[0], false
		}
	}
	return m[0], d <= max
}

var dauerhaftMuster = regexp.MustCompile(`dauerhaft aus \S+: (\d+) Schluessel`)

// tunnelStand prüft die Ausgabe von service-tunnel.sh status.
func tunnelStand(status string) (protokoll.Beleg, error) {
	hs, frisch := handshakeFrisch(status, 3*time.Minute)
	b := protokoll.Beleg{}.Mit("handshake", hs).
		Mit("ssh_2222", zeilenMit(status, "SSH 2222 ausserhalb der Tunnel")).
		Mit("abholer", zeilenMit(status, "Fenster-Schluessel: Abholer", "letzte gueltige Antwort")).
		Mit("dauerhaft", zeilenMit(status, "dauerhaft aus"))
	var f []string
	if !frisch {
		f = append(f, "kein frischer Handshake")
	}
	if !strings.Contains(status, "SSH 2222 ausserhalb der Tunnel: abgewiesen") {
		f = append(f, "SSH 2222 außerhalb der Tunnel nicht abgewiesen")
	}
	if !strings.Contains(status, "Fenster-Schluessel: Abholer laeuft,") {
		f = append(f, "Abholer läuft nicht")
	}
	if !strings.Contains(status, "letzte gueltige Antwort des Wartungsservers: vor") {
		f = append(f, "keine gültige Antwort des Wartungsservers")
	}
	if m := dauerhaftMuster.FindStringSubmatch(status); m == nil || m[1] != "1" {
		f = append(f, "nicht genau ein dauerhafter Schlüssel")
	}
	if len(f) > 0 {
		return b, errors.New(strings.Join(f, ", "))
	}
	return b, nil
}

func (l *Lauf) tunnelPruefen(ctx context.Context) (protokoll.Beleg, error) {
	var b protokoll.Beleg
	err := l.warteAuf(ctx, l.k.Zeiten.Tunnel, func() error {
		r, err := l.skript(ctx, "service-tunnel.sh", []string{"status"})
		if err != nil {
			return err
		}
		b, err = tunnelStand(r.Ausgabe)
		return err
	})
	return b, err
}

func (l *Lauf) tunnelEinrichten(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	env := []string{"VP_SERVICE_ZIEL=wartung", "VP_SERVICE_PUBKEY=" + l.k.WartungPub}
	if l.k.WartungEP != "" {
		env = append(env, "VP_SERVICE_ENDPOINT="+l.k.WartungEP)
	}
	r, err := l.skript(ctx, "service-tunnel.sh", []string{l.tunnelAdresse}, env...)
	if err != nil {
		return nil, err
	}
	b := protokoll.Beleg{}.Mit("einrichten", zeilenMit(r.Ausgabe, "eingerichtet:", "Wartungsserver:", "FEHLER"))
	if r.Code != 0 || !strings.Contains(r.Ausgabe, "eingerichtet: wg_wartung "+l.tunnelAdresse) {
		return b, fmt.Errorf("service-tunnel.sh endete mit %d: %s", r.Code, letzte(r.Ausgabe, 4))
	}
	st, err := l.tunnelPruefen(ctx)
	b = append(b, st...)
	if err != nil {
		return b, fmt.Errorf("Tunnel steht nicht: %w", err)
	}
	l.belege["tunnel_status"] = "Schritt tunnel: Handshake, SSH 2222 außerhalb der Tunnel abgewiesen, Abholer läuft mit gültiger Antwort"
	return b, nil
}

// ---- P5: LAN (Entscheid 6a) und Neustart ---------------------------------------------

func (l *Lauf) lanUmstellen(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	lan := l.k.LanNetz.String()
	befehl := "uci -q delete network.lan.ipaddr; uci -q delete network.lan.netmask; uci add_list network.lan.ipaddr=" + shellWort(lan) +
		"; uci set network.lan.gateway=" + shellWort(l.k.LanBruecke.String()) + "; uci commit network && (sleep 1; reboot) >/dev/null 2>&1 </dev/null &"
	if _, err := l.fuehre(ctx, befehl, ""); err != nil && !errors.Is(err, box.Abgerissen) {
		return nil, err
	}
	l.v.Schliesse()
	l.v = nil
	l.belege["lan_netz"] = "Schritt lan: " + lan
	return protokoll.Beleg{}.Mit("lan_netz", lan).Mit("weg_werkstatt", "über die Brücke "+l.k.LanBruecke.String()+" (bis Schritt internet_weg)").Mit("neustart", "angestoßen"), nil
}

func (l *Lauf) neustartProbe(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	beginn := time.Now()
	ziel := l.zielLan()
	err := l.warteAuf(ctx, l.k.Zeiten.Neustart, func() error {
		s, err := l.k.Werkbank.Status(ctx)
		if err != nil {
			return err
		}
		e, err := Einzeln(s)
		if err != nil {
			return err
		}
		if e.Adresse != ziel.Addr() {
			return fmt.Errorf("Box unter %s statt %s", e.Adresse, ziel.Addr())
		}
		return l.neuVerbinden(ctx, ziel, l.k.Zeiten.Verbinden)
	})
	if err != nil {
		return nil, fmt.Errorf("nach dem Neustart antwortet die Box nicht unter %s: %w", ziel.Addr(), err)
	}
	l.ziel = ziel
	b := protokoll.Beleg{}.Mit("dauer_bis_antwort", time.Since(beginn).Round(time.Second).String()).Mit("host_schluessel", l.hostArt+" "+l.v.HostFingerabdruck()+" (derselbe wie nach OpenWrt)")
	w, _, err := l.v.Werte(ctx, `echo "ref=$(cat /etc/vp-edge-light/ref 2>/dev/null)"
echo "lan=$(uci -q get network.lan.ipaddr)"
echo "start=$(ls /etc/rc.d 2>/dev/null | grep vp- | tr '\n' ' ')"`)
	if err != nil {
		return b, err
	}
	b = b.Mit("referenz", w["ref"]).Mit("lan", w["lan"]).Mit("startdienste", w["start"])
	switch {
	case w["ref"] != l.ref:
		return b, fmt.Errorf("Referenz nach dem Neustart %q, vorher %s", w["ref"], l.ref)
	case w["lan"] != l.k.LanNetz.String():
		return b, fmt.Errorf("LAN nach dem Neustart %q, erwartet %s", w["lan"], l.k.LanNetz)
	case !strings.Contains(w["start"], "vp-edge-light"):
		return b, errors.New("vp-edge-light startet nicht mit der Box")
	}
	n, fp, err := l.dauerhafteSchluessel(ctx)
	b = b.Mit("dauerhafte_schluessel", fmt.Sprintf("%d (%s)", n, fp))
	if err != nil {
		return b, err
	}
	st, err := l.tunnelPruefen(ctx)
	b = append(b, st...)
	if err != nil {
		return b, fmt.Errorf("Tunnel nach dem Neustart: %w", err)
	}
	l.belege["neustart"] = "Schritt neustart: frischer Handshake, dieselbe Referenz, Startdienste, ein dauerhafter Schlüssel, derselbe Host-Schlüssel"
	return b, nil
}

// HinweisProbe sagt, was der Betreiber für die Probe im Fenster tut (V1a:
// Werkstatt-Regel 4 bis 6 im Portal). Der Tunnel steht dafür noch, über das
// Werkstatt-Internet der Brücke.
func HinweisProbe(ref, host string) string {
	return "Im Portal unter Geräte › Werkstatt bei " + ref + ": Fenster „Werkstatt-Probe“ öffnen, dich durch den Tunnel anmelden, den Host-Schlüssel lesen (hier im LAN gelesen: " + host +
		"), das Fenster schließen und den abgewiesenen Versuch machen. Dann: kubectl -n werkstatt-prod exec deploy/werkstatt-dienst -- vp-werkstatt-dienst eingabe probe erledigt"
}

// PruefeProbe prüft die Eingabe für die Probe.
func PruefeProbe(s string) error {
	if strings.TrimSpace(s) != "erledigt" {
		return fmt.Errorf("für die Probe gibt es nur die Eingabe „erledigt“, nicht %q", s)
	}
	return nil
}

func (l *Lauf) probeImPortal(ctx context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
	if l.k.Portal != nil && l.k.Probe != nil && l.probeFenster != "" {
		return l.probeUeberTunnel(ctx)
	}
	for {
		w, err := k.Warte(ctx, "probe", HinweisProbe(l.ref, l.host))
		if err != nil {
			return nil, err
		}
		if err := PruefeProbe(w); err != nil {
			k.Log.Warn("Eingabe abgelehnt", "grund", err)
			continue
		}
		l.belege["anmeldeprobe"] = "Handgriff im Portal (V1a): Anmeldung über Portal und Tunnel im Fenster, vom Betreiber im Schritt probe bestätigt"
		l.belege["fenster_zu"] = "Handgriff im Portal (V1a): Fenster geschlossen, neuer Versuch abgewiesen, vom Betreiber im Schritt probe bestätigt"
		b := protokoll.Beleg{}.Mit("probe", "vom Betreiber im Portal erledigt: angemeldet, Host-Schlüssel gelesen, Fenster geschlossen, neuer Versuch abgewiesen").
			Mit("host_schluessel_lan", l.host)
		if l.k.Portal != nil && l.probeFenster != "" {
			// Das Probe-Fenster der Einlösung gehört dem Dienst; zu muss es vor der Abnahme sein.
			schonZu, err := l.k.Portal.FensterSchliessen(ctx, l.probeFenster)
			if err != nil {
				return b, fmt.Errorf("Probe-Fenster der Einlösung schließen: %w", err)
			}
			zustand := "geschlossen"
			if schonZu {
				zustand = "war schon zu"
			}
			b = b.Mit("probe_fenster", l.probeFenster+": "+zustand)
		}
		return b, nil
	}
}

// boxLog liest die Zeilen von Dropbear und vp-wartung aus dem Log der Box (im LAN).
func (l *Lauf) boxLog(ctx context.Context) string {
	erg, err := l.v.Fuehre(ctx, "logread 2>/dev/null | grep -E 'dropbear|vp-wartung' | tail -n 80", nil)
	if err != nil {
		return ""
	}
	return erg.Aus
}

// probeUeberTunnel ist die Probe durch den Dienst selbst (Werkstatt-Regel 4
// bis 6, WI-5 A): als Techniker-Zugang durch den Tunnel anmelden, den
// Host-Schlüssel dort lesen und mit dem aus dem LAN vergleichen, das
// Probe-Fenster der Einlösung schließen, der neue Versuch endet mit
// „Connection timed out“, und das Log der Box nennt Anmeldung und Ende.
func (l *Lauf) probeUeberTunnel(ctx context.Context) (protokoll.Beleg, error) {
	a, err := netip.ParseAddr(l.tunnelAdresse)
	if err != nil {
		return nil, fmt.Errorf("Tunnel-Adresse %q: %v", l.tunnelAdresse, err)
	}
	if l.serverPub == "" || l.serverEP == "" {
		return nil, errors.New("Schlüssel oder Endpunkt des Wartungsservers fehlen (Einlösung, Konfiguration)")
	}
	s := wartung.Server{PublicKey: l.serverPub, Endpunkt: l.serverEP, BoxNetz: l.k.BoxNetz}
	ziel := netip.AddrPortFrom(a, 2222)
	fp := l.k.Probe.Fingerabdruck()
	b := protokoll.Beleg{}.Mit("techniker_schluessel", fp).Mit("ziel", ziel.String())

	actx, cancel := context.WithTimeout(ctx, l.k.Zeiten.Tunnel)
	an, err := l.k.Probe.Anmelden(actx, s, ziel)
	cancel()
	if err != nil {
		return b, fmt.Errorf("Probe über den Tunnel: %w", err)
	}
	b = b.Mit("anmeldung", fmt.Sprintf("gelungen nach %d Versuchen in %s", an.Versuche, an.Dauer.Round(time.Second))).
		Mit("host_schluessel_tunnel", an.HostSchluessel).Mit("host_schluessel_lan", l.host)
	if an.HostSchluessel != l.host {
		return b, fmt.Errorf("Host-Schlüssel durch den Tunnel %s, im LAN %s: zwei verschiedene Geräte?", an.HostSchluessel, l.host)
	}
	anmeldung := ""
	for _, z := range strings.Split(l.boxLog(ctx), "\n") {
		if strings.Contains(z, fp) {
			anmeldung = strings.TrimSpace(z)
		}
	}
	if anmeldung == "" {
		return b, fmt.Errorf("das Log der Box nennt die Anmeldung mit %s nicht", fp)
	}
	b = b.Mit("box_log_anmeldung", anmeldung)

	schonZu, err := l.k.Portal.FensterSchliessen(ctx, l.probeFenster)
	if err != nil {
		return b, fmt.Errorf("Probe-Fenster schließen: %w", err)
	}
	zu := "geschlossen"
	if schonZu {
		zu = "war schon zu"
	}
	b = b.Mit("probe_fenster", l.probeFenster+": "+zu)
	nctx, cancel := context.WithTimeout(ctx, l.k.Zeiten.Tunnel)
	nach, err := l.k.Probe.NachEnde(nctx, s, ziel)
	cancel()
	if err != nil {
		return b, fmt.Errorf("neuer Versuch nach dem Ende: %w", err)
	}
	b = b.Mit("neuer_versuch", nach)
	var ende string
	_ = l.warteAuf(ctx, l.k.Zeiten.Tunnel, func() error {
		for _, z := range strings.Split(l.boxLog(ctx), "\n") {
			if strings.Contains(z, "Sitzung beendet") || strings.Contains(z, "Fenster-Schluessel jetzt: keine") {
				ende = strings.TrimSpace(z)
			}
		}
		if ende == "" {
			return errors.New("das Log der Box nennt das Ende noch nicht")
		}
		return nil
	})
	if ende == "" {
		return b, errors.New("das Log der Box nennt weder „Sitzung beendet“ noch „Fenster-Schluessel jetzt: keine“")
	}
	b = b.Mit("box_log_ende", ende)
	l.belege["anmeldeprobe"] = "Schritt probe: Anmeldung über Portal und Tunnel als Techniker-Zugang " + fp + " im Probe-Fenster der Einlösung; Box-Log: " + anmeldung
	l.belege["fenster_zu"] = "Schritt probe: Fenster " + l.probeFenster + " geschlossen, neuer Versuch: " + nach + "; Box-Log: " + ende
	l.belege["host_schluessel"] += "; Tunnel-Weg: " + an.HostSchluessel + " (gleich)"
	l.probeAutomatisch = true
	return b, nil
}

func (l *Lauf) internetWeg(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	if err := l.netzNeuLaden(ctx, "uci -q delete network.lan.gateway\nuci -q delete network.lan.dns", l.ziel); err != nil {
		return nil, err
	}
	w, _, err := l.v.Werte(ctx, `echo "gateway=$(uci -q get network.lan.gateway || echo keiner)"
echo "dns=$(uci -q get network.lan.dns || echo keiner)"
echo "weg=$(ip -4 route show default | head -n1)"`)
	if err != nil {
		return nil, err
	}
	b := protokoll.Beleg{}.Mit("gateway", w["gateway"]).Mit("dns", w["dns"]).Mit("standardweg", w["weg"])
	if w["gateway"] != "keiner" || w["dns"] != "keiner" || strings.Contains(w["weg"], "via "+l.k.LanBruecke.String()) {
		return b, errors.New("der Weg über die Brücke steht noch in der Netz-Einstellung")
	}
	return b.Mit("ergebnis", "beim Kunden geht die Box nur über WAN ins Netz"), nil
}

// ---- Übergabe ------------------------------------------------------------------------------

// Pruefungen der Werkstatt-Regel (docs/contracts/werkstatt-pruefungen.json) in
// ihrer Reihenfolge; anmeldeprobe und fenster_zu bleiben in V1a Handgriffe im
// Portal, bestätigt im Schritt probe.
var Pruefungen = []string{"root_passwort", "notfall_schluessel", "tunnel_status", "anmeldeprobe", "host_schluessel", "fenster_zu", "lan_netz", "neustart"}

func (l *Lauf) uebergabe(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	b := protokoll.Beleg{}.
		Mit("referenz", l.ref).
		Mit("fassung", l.version).
		Mit("host_schluessel", l.host).
		Mit("tunnel_adresse", l.tunnelAdresse).
		Mit("lan_netz", l.k.LanNetz.String())
	if !l.probeAutomatisch {
		l.belege["host_schluessel"] += "; Tunnel-Weg: bei der Probe im Portal gelesen und verglichen (Schritt probe)"
	}
	belege := map[string]string{}
	for _, p := range Pruefungen {
		b = b.Mit("pruefung_"+p, l.belege[p])
		belege[p] = l.belege[p]
	}
	if l.k.Portal != nil {
		// Die Abnahme mit den Belegen (WI-7 A); das Passwort nur verschlüsselt (WI-6 A).
		an, err := l.k.Portal.AbnahmeSchreiben(ctx, l.ref, portal.Abnahme{Fassung: l.version, HostSchluessel: l.host,
			LanNetz: l.k.LanNetz.String(), Belege: belege, PasswortAge: l.passwortAge})
		if err != nil {
			return b, fmt.Errorf("Abnahme im Portal: %w", err)
		}
		b = b.Mit("abnahme", an.ID+" (Freigabe "+an.FreigabeID+", Einlösung "+an.EinloesungID+")")
	}
	return b.Mit("versand", "Nicht versenden: Stufe 1 (Entscheid 5c)"), nil
}
