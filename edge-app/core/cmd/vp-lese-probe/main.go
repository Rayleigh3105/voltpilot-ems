// vp-lese-probe reads SunSpec inverters (Modbus TCP, FC3 only) and Shelly
// three-phase meters (Shelly.GetStatus only) with the SAME readers Edge Light
// uses (internal/sunspeclive, internal/shellyem), in the cadence of the source
// executor: every device once per cycle, one after the other, one connection at
// a time. It prints each read and, at the end, what the reads cost the machine
// it runs on (CPU time, peak RSS, Go heap) - the evidence for "three inverters
// and three meters per cycle" on a Mango before such a plant is switched on.
//
// READ-ONLY by construction: it never writes a register and never sends an RPC
// other than the status read. It is a field tool, not part of the box program.
//
//	vp-lese-probe -sunspec 192.168.1.156:502 -shelly 192.168.1.146:80 -takt 5s -zyklen 36
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shellyem"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sunspeclive"
)

type liste []string

func (l *liste) String() string     { return strings.Join(*l, ",") }
func (l *liste) Set(v string) error { *l = append(*l, v); return nil }

type lesung struct {
	Zyklus   int      `json:"zyklus"`
	Ziel     string   `json:"ziel"`
	Art      string   `json:"art"`
	Ms       int64    `json:"ms"`
	Anfragen int      `json:"anfragen"`
	PvKw     *float64 `json:"pv_kw,omitempty"`
	NetzKw   *float64 `json:"leistung_kw,omitempty"`
	Modell   string   `json:"modell,omitempty"`
	Fehler   string   `json:"fehler,omitempty"`
}

type kosten struct {
	WandS      float64 `json:"wand_s"`
	CPUUserS   float64 `json:"cpu_user_s"`
	CPUSysS    float64 `json:"cpu_sys_s"`
	CPUProzent float64 `json:"cpu_prozent"`
	MaxRSSKB   int64   `json:"max_rss_kb"`
	HeapKB     uint64  `json:"heap_kb"`
	SysKB      uint64  `json:"go_sys_kb"`
	Lesungen   int     `json:"lesungen"`
	Fehler     int     `json:"fehler"`
}

func main() {
	var sunspec, shelly liste
	flag.Var(&sunspec, "sunspec", "ip:port eines SunSpec-Wechselrichters (mehrfach)")
	flag.Var(&shelly, "shelly", "ip:port eines Shelly-Zaehlers (mehrfach)")
	unit := flag.Int("unit", 1, "Modbus-Unit der SunSpec-Geraete")
	takt := flag.Duration("takt", 5*time.Second, "Abstand zweier Zyklen")
	zyklen := flag.Int("zyklen", 1, "Anzahl Zyklen")
	timeout := flag.Duration("timeout", 8*time.Second, "Verbindungs-/Lese-Timeout je Geraet")
	jsonOut := flag.Bool("json", false, "jede Lesung als JSON-Zeile")
	flag.Parse()
	if len(sunspec)+len(shelly) == 0 {
		fmt.Fprintln(os.Stderr, "mindestens ein -sunspec oder -shelly angeben")
		os.Exit(2)
	}

	client := &http.Client{Timeout: *timeout, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true,
		DialContext: (&net.Dialer{Timeout: *timeout}).DialContext}}
	start := time.Now()
	var alle []lesung
	for z := 1; z <= *zyklen; z++ {
		zyklusStart := time.Now()
		for _, ziel := range sunspec {
			l := lesung{Zyklus: z, Ziel: ziel, Art: "sunspec"}
			t0 := time.Now()
			res, err := sunspeclive.Read(context.Background(), nil, ziel, byte(*unit), *timeout, *timeout, sunspeclive.Target{})
			l.Ms = time.Since(t0).Milliseconds()
			switch {
			case err != nil:
				l.Fehler = err.Error()
			case !res.Found:
				l.Fehler, l.Anfragen = "kein SunS-Marker", res.Requests
			case res.Result == nil:
				l.Fehler, l.Anfragen = "kein Messwert", res.Requests
				if res.Stopped != "" {
					l.Fehler += " (Walk abgebrochen bei " + res.Stopped + ")"
				}
			default:
				l.Anfragen = res.Requests
				l.Modell = res.Common.Hersteller + " " + res.Common.Modell + " " + res.Common.Version
				if v, ok := res.Result.Reading["pv_power_kw"]; ok {
					l.PvKw = &v
				}
				if v, ok := res.Result.Reading["power_kw"]; ok {
					l.NetzKw = &v
				}
			}
			alle = append(alle, ausgeben(l, *jsonOut))
		}
		for _, ziel := range shelly {
			l := lesung{Zyklus: z, Ziel: ziel, Art: "shelly_em", Anfragen: 1}
			host, port, _ := net.SplitHostPort(ziel)
			var p int
			fmt.Sscanf(port, "%d", &p)
			t0 := time.Now()
			body, err := shellyem.Get(context.Background(), client, shellyem.URL(host, p))
			var m *shellyem.Messung
			if err == nil {
				m, err = shellyem.Decode(body, 0)
			}
			l.Ms = time.Since(t0).Milliseconds()
			if err != nil {
				l.Fehler = err.Error()
			} else {
				v := m.PowerKw(false)
				l.NetzKw = &v
			}
			alle = append(alle, ausgeben(l, *jsonOut))
		}
		if z < *zyklen {
			if rest := *takt - time.Since(zyklusStart); rest > 0 {
				time.Sleep(rest)
			}
		}
	}
	wand := time.Since(start).Seconds()

	var ru syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	k := kosten{WandS: round(wand, 1), CPUUserS: tv(ru.Utime), CPUSysS: tv(ru.Stime), MaxRSSKB: maxRSSKB(ru.Maxrss),
		HeapKB: ms.HeapAlloc / 1024, SysKB: ms.Sys / 1024, Lesungen: len(alle)}
	k.CPUProzent = round(100*(k.CPUUserS+k.CPUSysS)/wand, 2)
	for _, l := range alle {
		if l.Fehler != "" {
			k.Fehler++
		}
	}
	zusammenfassung(alle)
	raw, _ := json.Marshal(k)
	fmt.Println("KOSTEN " + string(raw))
}

func ausgeben(l lesung, jsonOut bool) lesung {
	if jsonOut {
		raw, _ := json.Marshal(l)
		fmt.Println(string(raw))
		return l
	}
	wert := ""
	if l.PvKw != nil {
		wert += fmt.Sprintf(" pv=%.3f kW", *l.PvKw)
	}
	if l.NetzKw != nil {
		wert += fmt.Sprintf(" leistung=%.3f kW", *l.NetzKw)
	}
	if l.Fehler != "" {
		wert += " FEHLER " + l.Fehler
	}
	fmt.Printf("%3d %-9s %-21s %5d ms %2d Anfr.%s %s\n", l.Zyklus, l.Art, l.Ziel, l.Ms, l.Anfragen, wert, l.Modell)
	return l
}

func zusammenfassung(alle []lesung) {
	je := map[string][]int64{}
	fehler := map[string]int{}
	for _, l := range alle {
		je[l.Ziel] = append(je[l.Ziel], l.Ms)
		if l.Fehler != "" {
			fehler[l.Ziel]++
		}
	}
	ziele := make([]string, 0, len(je))
	for z := range je {
		ziele = append(ziele, z)
	}
	sort.Strings(ziele)
	for _, z := range ziele {
		ms := je[z]
		sort.Slice(ms, func(i, j int) bool { return ms[i] < ms[j] })
		var sum int64
		for _, v := range ms {
			sum += v
		}
		fmt.Printf("ZIEL %-21s lesungen=%d fehler=%d ms min=%d median=%d max=%d mittel=%d\n",
			z, len(ms), fehler[z], ms[0], ms[len(ms)/2], ms[len(ms)-1], sum/int64(len(ms)))
	}
}

func tv(t syscall.Timeval) float64 { return round(float64(t.Sec)+float64(t.Usec)/1e6, 3) }

func round(x float64, n int) float64 {
	p := 1.0
	for i := 0; i < n; i++ {
		p *= 10
	}
	return float64(int64(x*p+0.5)) / p
}
