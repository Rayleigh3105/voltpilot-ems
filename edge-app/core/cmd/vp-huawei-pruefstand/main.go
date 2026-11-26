// vp-huawei-pruefstand ist das PRUEFSTANDS-Werkzeug fuer einen Huawei SUN2000
// (+ LUNA2000) hinter seinem Smart Dongle (Modbus TCP): es liest mit dem
// Leseplan und Decoder der Box (internal/huaweidecode) ueber den Modbus-Client
// der Box (internal/modbustcp) und faehrt die Schreibfolgen des Huawei-Adapters
// (edge-app/nodered/inverter-control-routing.js, `planned` von controlRoute
// bzw. controlRelease, als JSON-Datei) gegen das echte Geraet.
//
// ⚠ Dev-/Pruefstands-Werkzeug: es gehoert in KEIN Kunden-Image und kennt weder
// Arbiter noch Freigabe noch Not-Aus. Seine eigenen Grenzen: geschrieben werden
// nur die Absichtsregister aus catalog/control-profiles/profiles/huawei.json
// (47075, 47077, 47083, 47086, 47087, 47100, 47246, 47247, 47249) mit
// Leistungen bis -max-w; 47246 nie 1 (SoC-Modus ohne Zeit-Rueckfall). Vor dem
// ersten Schreiben liest es jeden Ausgangswert und legt ihn in -sicherung ab;
// nach dem Halten (oder Strg-C) schreibt es jeden Ausgangswert zurueck und
// liest ihn nach. Jede Sitzung wartet -pause nach dem Verbinden (der Dongle
// beantwortet eine fruehere Anfrage nicht).
//
//	vp-huawei-pruefstand -ziel 127.0.0.1:15502 -unit 1 lesen
//	vp-huawei-pruefstand -ziel 127.0.0.1:15502 -unit 1 wartezeit
//	vp-huawei-pruefstand -ziel 127.0.0.1:15502 -unit 1 leseplan -n 12
//	vp-huawei-pruefstand -ziel 127.0.0.1:15502 -unit 1 -halten 3m -protokoll h.jsonl -sicherung h.json folge H_halten.json
//	vp-huawei-pruefstand -ziel 127.0.0.1:15502 -unit 1 zuruecksetzen h.json
//	vp-huawei-pruefstand -ziel 127.0.0.1:15502 -unit 1 -programm "0:60s,-1:60s,0.5:60s" -protokoll g.jsonl -sicherung g.json steuerweg
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
)

func main() {
	ziel := flag.String("ziel", "", "host:port des Smart Dongles")
	unit := flag.Int("unit", 1, "Modbus-Unit (hinter dem Smart Dongle meist 1)")
	pause := flag.Duration("pause", time.Second, "Wartezeit nach dem Verbinden")
	timeout := flag.Duration("timeout", 5*time.Second, "Zeitlimit je Verbindung und Anfrage")
	halten := flag.Duration("halten", 2*time.Minute, "folge: wie lange die Folge steht")
	takt := flag.Duration("takt", 5*time.Second, "folge/leseplan: Abstand der Beobachtungen")
	nachlauf := flag.Duration("nachlauf", 30*time.Second, "folge: Beobachtung nach der Wiederherstellung")
	auffrischen := flag.Bool("auffrischen", true, "folge: Schritte mit always je Takt neu schreiben (aus: Totmann-Messung)")
	maxW := flag.Int("max-w", 1000, "folge: hoechste Leistung in W")
	schnell := flag.Duration("einschwingen", 0, "folge: so lange nach dem Schreiben Batterie/AC so schnell wie moeglich lesen")
	prot := flag.String("protokoll", "", "folge: Protokolldatei (JSON-Zeilen)")
	sich := flag.String("sicherung", "", "folge: Datei der Ausgangswerte (vor dem ersten Schreiben)")
	n := flag.Int("n", 6, "leseplan: Anzahl Lesungen; wartezeit: Versuche je Pause")
	pausen := flag.String("pausen", "0s,300ms,500ms,700ms,1s,1500ms", "wartezeit: Pausen")
	programm := flag.String("programm", "0:60s", "steuerweg: Sollwerte kw:dauer, mit Komma getrennt (danach Not-Aus)")
	modell := flag.String("modell", "sun2000-m1", "steuerweg: Modell der Auswahl")
	flag.Parse()
	if *ziel == "" || flag.NArg() == 0 || *unit < 0 || *unit > 247 {
		die("Aufruf: vp-huawei-pruefstand -ziel <host:port> [-unit 1] lesen|wartezeit|leseplan|folge <datei>|steuerweg|zuruecksetzen <sicherung>")
	}
	v := verbindung{ziel: *ziel, unit: byte(*unit), pause: *pause, timeout: *timeout}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch flag.Arg(0) {
	case "lesen":
		out, err := erhebe(ctx, v)
		dump(out)
		check(err)
	case "wartezeit":
		var proben []wartezeitProbe
		for _, s := range strings.Split(*pausen, ",") {
			d, err := time.ParseDuration(strings.TrimSpace(s))
			check(err)
			for i := 1; i <= *n && ctx.Err() == nil; i++ {
				p := probiereWartezeit(ctx, v, d, 3*time.Second)
				p.Versuch = i
				proben = append(proben, p)
				time.Sleep(2 * time.Second) // the dongle frees its slot
			}
		}
		dump(proben)
	case "leseplan":
		for i := 0; i < *n && ctx.Err() == nil; i++ {
			t0 := time.Now()
			err := v.mit(ctx, func(c *modbustcp.Client) error {
				m, ab, fe := beobachteMitFehlern(c)
				dump(map[string]any{"lesung": i + 1, "ms": time.Since(t0).Milliseconds(), "abgelehnt": ab, "fehler_je_block": fe, "messung": m})
				return nil
			})
			if err != nil {
				dump(map[string]any{"lesung": i + 1, "fehler": err.Error()})
			}
			time.Sleep(*takt)
		}
	case "folge":
		if flag.NArg() != 2 || *sich == "" {
			die("folge <datei> braucht -sicherung <datei>")
		}
		folge, err := leseFolgeDatei(flag.Arg(1))
		check(err)
		check(pruefeFolge(folge, *maxW))
		l := &lauf{v: v, p: neuesProtokoll(*prot), folge: folge, halten: *halten, takt: *takt,
			nachlauf: *nachlauf, auffrische: *auffrischen, sicherung: *sich, schnell: *schnell}
		res := l.run(ctx)
		dump(res)
		if !res.Hergestellt {
			fmt.Fprintln(os.Stderr, "⚠ WIEDERHERSTELLUNG NICHT BESTAETIGT - Geraetezustand siehe abweichungen/originale")
			os.Exit(3)
		}
		if res.Unerwartet != "" {
			os.Exit(2)
		}
	case "steuerweg":
		prog, err := leseProgramm(*programm)
		check(err)
		if *sich == "" {
			die("steuerweg braucht -sicherung <datei>")
		}
		s := &steuerwegLauf{v: v, modell: *modell, programm: prog, takt: 10 * time.Second, p: neuesProtokoll(*prot), sicher: *sich}
		zurueck, err := s.run(ctx)
		dump(map[string]any{"rueckgabe_durch_go_pfad": zurueck, "fehler": fehlerText(err)})
		if err != nil {
			os.Exit(3)
		}
	case "zuruecksetzen":
		if flag.NArg() != 2 {
			die("zuruecksetzen <sicherung>")
		}
		raw, err := os.ReadFile(flag.Arg(1))
		check(err)
		var s struct {
			Worte     map[int]int `json:"worte"`
			Originale map[int]int `json:"originale"`
		}
		check(json.Unmarshal(raw, &s))
		var reihenfolge []int
		geschrieben := map[int]bool{}
		for a := range s.Originale {
			if _, ok := schreibbar[a]; !ok {
				die(fmt.Sprintf("Register %d ist nicht freigegeben", a))
			}
			reihenfolge = append(reihenfolge, a)
			geschrieben[a] = true
		}
		l := &lauf{v: v, p: neuesProtokoll(*prot)}
		ok, ab := l.herstellen(reihenfolge, s.Worte, s.Originale, geschrieben)
		dump(map[string]any{"wiederhergestellt": ok, "abweichungen": ab})
		if !ok {
			os.Exit(3)
		}
	default:
		die("unbekannter Befehl " + flag.Arg(0))
	}
}

func fehlerText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func neuesProtokoll(pfad string) *protokoll {
	p := &protokoll{jetzt: time.Now}
	enc := json.NewEncoder(os.Stderr)
	p.out = append(p.out, func(e eintrag) { _ = enc.Encode(e) })
	if pfad != "" {
		f, err := os.OpenFile(pfad, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		check(err)
		fe := json.NewEncoder(f)
		p.out = append(p.out, func(e eintrag) { _ = fe.Encode(e) })
	}
	return p
}

func dump(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func check(err error) {
	if err != nil {
		die(err.Error())
	}
}

func die(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}
