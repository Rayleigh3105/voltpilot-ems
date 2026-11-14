// einrichtung-probe ist NUR fuer die Labor-Pruefung der Einrichtungsseite
// (edge-light/test/wlan-anschluss-probe.sh, Lauf einrichtung-weg): dieselbe
// Einrichtungsseite, dieselbe API, dieselbe Schranke wie auf der Box
// (internal/web), aber ohne Agent, Cloud und Bus - so laeuft sie als kleines
// i686-Programm im OpenWrt-Emulator und ruft dort das ECHTE Netz-Skript auf.
// Auf keiner Box installiert; die Box verdrahtet web.Handler in edgemain.
package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/web"
)

func env(k, vorgabe string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return vorgabe
}

func main() {
	einr := web.NewEinrichtung(
		env("VP_REF", ""),
		env("VP_WLAN_SKRIPT", "/usr/libexec/vp-edge-light/wlan-anschluss.sh"),
		env("VP_EINRICHT_ADDR", "10.213.1.1"),
	)
	srv := &http.Server{
		Addr:              env("VP_HTTP_ADDR", ":8484"),
		Handler:           web.EinrichtungProbe(einr),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("einrichtung-probe auf %s", srv.Addr)
	log.Fatal(srv.ListenAndServe())
}
