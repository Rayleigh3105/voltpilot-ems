// attrappe ersetzt API und Keycloak in der Integrationsprobe: Token über
// client_credentials, dann der Soll-Stand aus einer Datei, die das
// Testskript zwischen den Läufen umschreibt. Fehlt die Datei, antwortet die
// Attrappe mit 503; ist der Prozess beendet, ist die API „unerreichbar".
//
// Die Route der Rückmeldung gibt es nur mit -rueckmeldung <datei>: Dann legt
// die Attrappe die letzte Meldung dort ab. Ohne die Angabe ist sie eine API
// vor der Rückmeldung und antwortet auf der Route mit 404.
package main

import (
	"flag"
	"io"
	"log"
	"net/http"
	"os"
)

func main() {
	adresse := flag.String("adresse", "127.0.0.1:8080", "Lauschadresse")
	datei := flag.String("soll", "/srv/soll.json", "Soll-Stand")
	secret := flag.String("secret", "probe-geheim", "Client-Secret des Dienstkontos")
	rueckmeldung := flag.String("rueckmeldung", "", "Datei für die letzte Rückmeldung (leer: die Route gibt es nicht)")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("grant_type") != "client_credentials" || r.Form.Get("client_id") != "voltpilot-tunnel-dienst" ||
			r.Form.Get("client_secret") != *secret {
			http.Error(w, "falsche Zugangsdaten", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"probe-token","expires_in":300}`))
	})
	mux.HandleFunc("GET /api/v1/fernwartung/soll", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer probe-token" {
			http.Error(w, "kein Token", http.StatusUnauthorized)
			return
		}
		daten, err := os.ReadFile(*datei)
		if err != nil {
			http.Error(w, "kein Soll-Stand", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(daten)
	})
	if *rueckmeldung != "" {
		mux.HandleFunc("PUT /api/v1/fernwartung/rueckmeldung", func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer probe-token" {
				http.Error(w, "kein Token", http.StatusUnauthorized)
				return
			}
			daten, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
			if err != nil || os.WriteFile(*rueckmeldung+".neu", daten, 0o644) != nil ||
				os.Rename(*rueckmeldung+".neu", *rueckmeldung) != nil {
				http.Error(w, "nicht abgelegt", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
	}
	log.Fatal(http.ListenAndServe(*adresse, mux))
}
