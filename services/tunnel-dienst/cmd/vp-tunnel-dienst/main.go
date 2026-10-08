// vp-tunnel-dienst setzt den Soll-Stand der Fernwartung auf der Wartungs-VM
// um: Peers auf der WireGuard-Schnittstelle, offene Fenster als
// nft-Elemente mit Ablaufzeit. Installation: services/tunnel-dienst/README.md.
//
//	vp-tunnel-dienst [lauf]   alle VP_TUNNEL_INTERVALL abgleichen (systemd)
//	vp-tunnel-dienst einmal   ein Abgleich, Rückgabe 0/1
//	vp-tunnel-dienst basis    die nft-Basis ausgeben (für /etc/nftables.d)
//	vp-tunnel-dienst status   Version, Firewall-Basis, Peers mit Handshake, offene Fenster, letzter Lauf
//	vp-tunnel-dienst version  der Stand (Commit), aus dem das Programm gebaut wurde
//	vp-tunnel-dienst pruefen <datei>   einen Soll-Stand offline prüfen
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"runtime/debug"
	"sort"
	"syscall"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/dienst"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/konfig"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/quelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/soll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/system"
)

// version ist der Commit, aus dem das Programm gebaut wurde. Der Bau setzt
// ihn mit -ldflags "-X main.version=<commit>" (README, Schritt 3).
var version = ""

// stand liefert die Version: den beim Bau gesetzten Wert, sonst den Commit,
// den Go selbst einträgt, wenn aus einem Git-Checkout gebaut wird.
func stand(gesetzt string, info *debug.BuildInfo) string {
	if gesetzt != "" {
		return gesetzt
	}
	if info == nil {
		return "unbekannt"
	}
	commit, geaendert := "", false
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			commit = s.Value
		case "vcs.modified":
			geaendert = s.Value == "true"
		}
	}
	if commit == "" {
		return "unbekannt"
	}
	if len(commit) > 12 {
		commit = commit[:12]
	}
	if geaendert {
		commit += "+geaendert"
	}
	return commit
}

func programmVersion() string {
	info, _ := debug.ReadBuildInfo()
	return stand(version, info)
}

func main() {
	befehl := "lauf"
	if len(os.Args) > 1 {
		befehl = os.Args[1]
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	var code int
	switch befehl {
	case "lauf":
		code = lauf(log, false)
	case "einmal":
		code = lauf(log, true)
	case "basis":
		code = basis()
	case "status":
		code = status()
	case "version":
		fmt.Println(versionsZeile(programmVersion()))
	case "pruefen":
		code = pruefen(os.Args[2:])
	case "-h", "--help", "hilfe":
		fmt.Println("vp-tunnel-dienst [lauf|einmal|basis|status|version|pruefen <datei>] - siehe services/tunnel-dienst/README.md")
	default:
		fmt.Fprintf(os.Stderr, "unbekannter Befehl %q (lauf, einmal, basis, status, version, pruefen)\n", befehl)
		code = 2
	}
	os.Exit(code)
}

func versionsZeile(v string) string { return "vp-tunnel-dienst Version " + v }

// basisZeile sagt, ob die geladene nft-Tabelle die Basis dieser Konfiguration ist.
func basisZeile(stimmt bool, err error) string {
	switch {
	case err != nil:
		return "Firewall-Basis: nicht prüfbar (" + err.Error() + ")"
	case stimmt:
		return "Firewall-Basis stimmt: ja"
	default:
		return "Firewall-Basis stimmt: nein (Tabelle fehlt oder weicht von `vp-tunnel-dienst basis` ab)"
	}
}

func startMeldung(log *slog.Logger, k konfig.Konfig, v string) {
	log.Info("Tunnel-Dienst läuft", "version", v, "api", k.APIURL, "schnittstelle", k.Schnittstelle, "intervall", k.Intervall,
		"boxNetz", k.BoxNetz, "technikerNetz", k.TechnikerNetz)
}

func regeln(k konfig.Konfig) system.Regeln {
	return system.Regeln{Tabelle: k.Tabelle, Schnittstelle: k.Schnittstelle, BoxNetz: k.BoxNetz,
		TechnikerNetz: k.TechnikerNetz, Ports: k.Ports, MaxFenster: k.MaxFenster,
		VerbindungenProtokollieren: k.VerbindungenProtokollieren}
}

func lauf(log *slog.Logger, einmal bool) int {
	k, err := konfig.Lies(os.Getenv, false)
	if err != nil {
		log.Error("Start abgebrochen", "fehler", err)
		return 1
	}
	api, err := quelle.Neu(k.APIURL, k.TokenURL, k.ClientID, k.ClientSecret, 15*time.Second)
	if err != nil {
		log.Error("Start abgebrochen", "fehler", err)
		return 1
	}
	r := system.Exec{}
	d := &dienst.Dienst{
		Quelle:       api,
		WG:           system.WireGuard{R: r, Schnittstelle: k.Schnittstelle},
		FW:           system.Nft{R: r, Regeln: regeln(k)},
		Netze:        soll.Netze{Box: k.BoxNetz, Techniker: k.TechnikerNetz},
		MaxFenster:   k.MaxFenster,
		MaxEntfernen: k.MaxEntfernen,
		Zustand:      k.Zustand,
		Log:          log,
		Jetzt:        time.Now,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if einmal {
		if e := d.Lauf(ctx); e.Fehler != nil {
			return 1
		}
		return 0
	}
	startMeldung(log, k, programmVersion())
	takt := time.NewTicker(k.Intervall)
	defer takt.Stop()
	for {
		laufCtx, abbruch := context.WithTimeout(ctx, k.Intervall)
		d.Lauf(laufCtx)
		abbruch()
		select {
		case <-ctx.Done():
			// Beim Beenden wird bewusst NICHTS abgebaut: Peers bleiben,
			// Fenster laufen im Kernel von selbst ab.
			log.Info("Tunnel-Dienst beendet; Fenster laufen von selbst ab")
			return 0
		case <-takt.C:
		}
	}
}

func basis() int {
	k, err := konfig.Lies(os.Getenv, true)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Print(regeln(k).Basis())
	return 0
}

func status() int {
	k, err := konfig.Lies(os.Getenv, true)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	ctx := context.Background()
	r := system.Exec{}
	fw := system.Nft{R: r, Regeln: regeln(k)}
	fmt.Println(versionsZeile(programmVersion()))
	fmt.Println(basisZeile(fw.BasisStimmt(ctx)))
	kennung := map[string]string{}
	adressen := map[string]string{}
	if s, err := dienst.LiesZwischenstand(k.Zustand); err == nil {
		for _, p := range s.Peers {
			kennung[p.PublicKey] = p.Art + " " + p.Kennung
			adressen[p.Adresse] = p.Kennung
		}
	}
	if st, err := dienst.LiesStatus(k.Zustand); err == nil {
		fmt.Printf("letzter Lauf %s, letzter Erfolg %s, Fehlläufe in Folge %d\n",
			st.LetzterLauf.Format(time.RFC3339), st.LetzterErfolg.Format(time.RFC3339), st.FehlerInFolge)
		if st.LetzterFehler != "" {
			fmt.Printf("letzter Fehler: %s\n", st.LetzterFehler)
		}
	}
	wg := system.WireGuard{R: r, Schnittstelle: k.Schnittstelle}
	peers, err := wg.Peers(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	hs, _ := wg.Handshakes(ctx)
	keys := make([]string, 0, len(peers))
	for key := range peers {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	fmt.Printf("\nPeers auf %s: %d\n", k.Schnittstelle, len(peers))
	for _, key := range keys {
		zuletzt := "nie"
		if t := hs[key]; !t.IsZero() {
			zuletzt = "vor " + time.Since(t).Round(time.Second).String()
		}
		fmt.Printf("  %-28s %-18v Handshake %s\n", kennung[key], peers[key], zuletzt)
	}
	fenster, err := fw.Fenster(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Printf("\nOffene Fenster: %d\n", len(fenster))
	for p, rest := range fenster {
		fmt.Printf("  %s -> %s (%s)  noch %s\n", p.Techniker, p.Box, adressen[p.Box.String()], rest.Round(time.Second))
	}
	return 0
}

func pruefen(args []string) int {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "pruefen <datei>")
		return 2
	}
	k, err := konfig.Lies(os.Getenv, true)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	daten, err := os.ReadFile(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	s, err := soll.Lies(daten)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	g, befunde, err := soll.Pruefe(s, soll.Netze{Box: k.BoxNetz, Techniker: k.TechnikerNetz})
	if err != nil {
		fmt.Fprintln(os.Stderr, "verworfen:", err)
		return 1
	}
	fmt.Printf("gültig: %d Peers, %d Fenster\n", len(g.Peers), len(g.Fenster))
	for _, b := range befunde {
		fmt.Println("übersprungen:", b)
	}
	if len(befunde) > 0 {
		return 1
	}
	return 0
}
