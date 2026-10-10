// schalterprobe prüft den Prozess der Schlüsselausgabe auf einem echten
// Kernel, ohne WireGuard und nftables: Er startet den Schalter des genannten
// Programms so, wie der Dienst es tut, fragt ihn über HTTP wie eine Box und
// sieht nach, welche Rechte der Prozess danach noch hat. Gedacht für
// test/dateisperre.sh, das ihn in einer kleinen VM mit einem Debian-Kernel
// laufen lässt (Landlock ist in Containern dieser Arbeitsmaschine nicht aktiv).
//
//	schalterprobe /pfad/zu/vp-tunnel-dienst
//
// Die "Box" ist 127.0.0.1; das Box-Netz der Probe ist so gewählt, dass diese
// Adresse darin eine gewöhnliche ist.
package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/abgleich"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/ausgabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/probe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/soll"
)

type menge map[abgleich.Paar]time.Duration

func (m menge) Fenster(context.Context) (map[abgleich.Paar]time.Duration, error) { return m, nil }

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "schalterprobe <vp-tunnel-dienst>")
		os.Exit(2)
	}
	fehler := 0
	pruefe := func(gut bool, was string) {
		if gut {
			fmt.Println("  ok      " + was)
		} else {
			fehler++
			fmt.Println("  FEHLER  " + was)
		}
	}
	boxNetz := netip.MustParsePrefix("126.0.0.0/7")
	box := netip.MustParseAddr("127.0.0.1")
	techniker := netip.MustParseAddr("10.10.32.2")
	adresse := netip.MustParseAddrPort("127.0.0.1:8022")
	ssh, err := soll.PruefeSSHSchluessel(probe.SSHZeile(3072, 1))
	if err != nil {
		panic(err)
	}
	stelle := &ausgabe.Stelle{Menge: menge{{Techniker: techniker, Box: box}: time.Hour}, BoxNetz: boxNetz,
		Log: slog.New(slog.NewTextHandler(os.Stderr, nil)), Jetzt: time.Now}
	stelle.SetzeStand(soll.Gueltig{Peers: map[string]soll.PeerSoll{
		"box":  {Art: soll.ArtBox, ID: "b1", Kennung: "edge-probe", Adresse: box},
		"tech": {Art: soll.ArtTechniker, ID: "t1", Kennung: "Probe-Techniker", Adresse: techniker, SSH: ssh},
	}})
	ctx, abbruch := context.WithCancel(context.Background())
	defer abbruch()
	go stelle.Betreibe(ctx, os.Args[1], adresse)

	frage := func() (int, string) {
		klient := &http.Client{Timeout: 5 * time.Second}
		antwort, err := klient.Get("http://" + adresse.String() + ausgabe.Pfad + "?warte=0&stand=")
		if err != nil {
			return 0, err.Error()
		}
		defer antwort.Body.Close()
		text, _ := io.ReadAll(antwort.Body)
		return antwort.StatusCode, string(text)
	}
	var code int
	var text string
	for i := 0; i < 40; i++ {
		if code, text = frage(); code != 0 {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	pruefe(code == http.StatusOK && strings.Contains(text, "\nschluessel ") && strings.HasSuffix(text, " t1 "+ssh.Zeile+"\nende 1\n"),
		fmt.Sprintf("der Schalter beantwortet die Anfrage einer Box (HTTP %d)", code))

	// Was darf der Prozess des Schalters noch?
	pid := ""
	eintraege, _ := filepath.Glob("/proc/[0-9]*/cmdline")
	for _, e := range eintraege {
		if daten, err := os.ReadFile(e); err == nil && strings.Contains(string(daten), ausgabe.SchalterBefehl) {
			pid = filepath.Base(filepath.Dir(e))
		}
	}
	status, _ := os.ReadFile("/proc/" + pid + "/status")
	feld := func(name string) string {
		for _, z := range strings.Split(string(status), "\n") {
			if rest, ok := strings.CutPrefix(z, name+":"); ok {
				return strings.TrimSpace(rest)
			}
		}
		return "?"
	}
	pruefe(pid != "", "der Schalter ist ein eigener Prozess (PID "+pid+")")
	for _, c := range []string{"CapInh", "CapPrm", "CapEff", "CapAmb"} {
		pruefe(feld(c) == "0000000000000000", "Schalter: "+c+" leer ("+feld(c)+")")
	}
	pruefe(feld("NoNewPrivs") == "1", "Schalter: NoNewPrivs gesetzt")
	// Mit Landlock zeigt der Kernel ab 6.x keine eigene Zeile im Status;
	// belegt wird die Sperre durch die Startzeile des Schalters
	// (dateizugriff=gesperrt: er hat versucht, / zu öffnen, und es ging nicht)
	// und dadurch, dass er danach weiter antwortet.
	for i := 0; i < 3; i++ {
		code, text = frage()
	}
	pruefe(code == http.StatusOK && strings.HasSuffix(text, "ende 1\n"), "der Schalter antwortet nach der Sperre weiter")
	abbruch()
	time.Sleep(time.Second)
	if _, err := os.Stat("/proc/" + pid); pid != "" && err == nil {
		pruefe(false, "der Schalter endet mit dem Dienst")
	} else {
		pruefe(true, "der Schalter endet mit dem Dienst")
	}
	fmt.Printf("SCHALTERPROBE %d Fehler\n", fehler)
	if fehler > 0 {
		os.Exit(1)
	}
}
