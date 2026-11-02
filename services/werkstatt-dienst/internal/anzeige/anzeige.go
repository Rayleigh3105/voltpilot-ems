// Package anzeige hat die zwei HTTP-Seiten des Dienstes:
//
//   - Betrieb (VP_WERKSTATT_HTTP, im Cluster erreichbar): /health, /ready und
//     /metrics. Nichts davon nennt eine Referenz, MAC oder ein Geheimnis.
//   - Werkstatt-Anzeige (VP_WERKSTATT_ANZEIGE, nur Loopback, also nur über
//     kubectl port-forward): Stand der Brücke, Freigabe, Läufe mit Belegen.
//     Nur lesen; keine Anmeldung, darum nur auf Loopback und nur mit einem
//     Host-Kopf von localhost (gegen DNS-Rebinding).
package anzeige

import (
	"encoding/json"
	"html/template"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/dienst"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
)

// Betrieb ist die Seite für Kubernetes und Prometheus.
func Betrieb(d *dienst.Dienst, reg *metriken.Register) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /ready", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		if !d.Bereit() {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("nicht bereit\n"))
			return
		}
		_, _ = w.Write([]byte("bereit\n"))
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_ = reg.Schreibe(w)
	})
	return mux
}

// Steuerung nimmt Eingaben des Betreibers an (nur über die Unix-Socket im
// Pod, also nur mit kubectl exec): POST /eingabe mit name und wert.
func Steuerung(d *dienst.Dienst) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /eingabe", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := d.Eingabe(r.Context(), r.PostForm.Get("name"), r.PostForm.Get("wert")); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		_, _ = w.Write([]byte("angenommen\n"))
	})
	return mux
}

// Werkstatt ist die Anzeige für den Betreiber.
func Werkstatt(d *dienst.Dienst, ablage *protokoll.Ablage, log *slog.Logger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		a := d.Ansicht()
		laeufe := laeufeListe(ablage, 20)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if err := seite.Execute(w, struct {
			A      dienst.Ansicht
			Laeufe []laufZeile
		}{a, laeufe}); err != nil {
			log.Error("Anzeige", "fehler", err)
		}
	})
	mux.HandleFunc("GET /zustand.json", func(w http.ResponseWriter, _ *http.Request) {
		schreibeJSON(w, d.Ansicht())
	})
	mux.HandleFunc("GET /laeufe/{kennung}", func(w http.ResponseWriter, r *http.Request) {
		k := strings.TrimSuffix(r.PathValue("kennung"), ".json")
		if !protokoll.GueltigeKennung(k) {
			http.NotFound(w, r)
			return
		}
		e, err := ablage.Lies(k)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		schreibeJSON(w, e)
	})
	return nurLokal(mux)
}

func schreibeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

// nurLokal lässt nur Anfragen mit dem Host localhost/127.0.0.1/[::1] durch und
// setzt strenge Kopfzeilen.
func nurLokal(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if hh, _, err := net.SplitHostPort(host); err == nil {
			host = hh
		}
		host = strings.Trim(host, "[]")
		if host != "localhost" && host != "127.0.0.1" && host != "::1" {
			http.Error(w, "nur über kubectl port-forward (Host localhost)", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}

type laufZeile struct {
	Kennung, Zustand, Schritt, Grund string
}

func laeufeListe(a *protokoll.Ablage, max int) []laufZeile {
	ks, err := a.Laeufe()
	if err != nil {
		return nil
	}
	if len(ks) > max {
		ks = ks[:max]
	}
	out := make([]laufZeile, 0, len(ks))
	for _, k := range ks {
		z := laufZeile{Kennung: k, Zustand: "laeuft"}
		es, _ := a.Lies(k)
		for _, e := range es {
			if e.Schritt != "" {
				z.Schritt = e.Schritt
			}
			if e.Art == protokoll.LaufBeendet {
				z.Zustand, z.Grund = e.Zustand, e.Grund
			}
		}
		out = append(out, z)
	}
	return out
}

var seite = template.Must(template.New("seite").Funcs(template.FuncMap{
	"zeit": func(t time.Time) string {
		if t.IsZero() {
			return "–"
		}
		return t.UTC().Format("02.01.2006 15:04:05 UTC")
	},
	"jaNein": func(b bool) string {
		if b {
			return "ja"
		}
		return "nein"
	},
}).Parse(`<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Werkstatt-Dienst</title>
<style>
body{font-family:Inter,system-ui,sans-serif;margin:16px;max-width:960px;color:#1a202c;background:#fff}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:1.5rem}
.karte{border:1px solid #cbd5e0;border-radius:12px;padding:12px 16px;margin:8px 0}
.gut{color:#22543d}.schlecht{color:#9b2c2c}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}
td,th{border-bottom:1px solid #e2e8f0;padding:4px 8px;text-align:left;vertical-align:top}
code{word-break:break-all}
@media (prefers-color-scheme:dark){body{background:#1a202c;color:#e2e8f0}.karte{border-color:#4a5568}.gut{color:#9ae6b4}.schlecht{color:#feb2b2}}
</style></head><body>
<h1>Werkstatt-Dienst</h1>
<p>Stand {{zeit .A.Zeit}}. Diese Seite liest nur. Keine Box mit Stufe 1 an einen Kunden, bevor Stufe 2 steht.</p>

<h2>Werkbank-Brücke</h2>
<div class="karte">
{{with .A.Werkbank}}
<p class="{{if .Bereit}}gut{{else}}schlecht{{end}}"><strong>{{if .Bereit}}Brücke bereit{{else}}Brücke nicht bereit{{end}}</strong>{{if .Grund}}: {{.Grund}}{{end}}</p>
<p>Adresse <code>{{.Adresse}}</code> · Fassung (soll) <code>{{.Fassung}}</code> · Host-Schlüssel <code>{{if .HostSchluessel}}{{.HostSchluessel}}{{else}}noch kein Kontakt{{end}}</code></p>
{{with .Status}}
<p>Kabel am Werkstatt-Anschluss ({{.Werkstatt.Schnittstelle}}): {{jaNein .Werkstatt.Kabel}} · WLAN ({{.Netz.Schnittstelle}}): {{if .Netz.Oben}}oben{{else}}unten{{end}}, Energiesparen {{.Netz.Energiesparen}} · Fassung (ist) <code>{{.Fassung}}</code></p>
<p>Antworten am Werkstatt-Anschluss: {{range .Antworten}}<code>{{.Adresse}}</code> ({{range $i, $m := .MACs}}{{if $i}}, {{end}}{{$m}}{{end}}) {{else}}keine{{end}}</p>
{{end}}
<p>Status gelesen: {{zeit .StatusZeit}}</p>
{{with .Einrichten}}<p>Zuletzt eingerichtet: {{zeit .Zeit}}, {{.Weg}}{{if .Fassung}} (Fassung <code>{{.Fassung}}</code>){{end}}{{if .Fehler}}: <span class="schlecht">{{.Fehler}}</span>{{end}}</p>{{end}}
{{end}}
</div>

<h2>Freigabe</h2>
<div class="karte">
{{with .A.Freigabe}}
<p class="{{if .Laufend}}gut{{else}}schlecht{{end}}"><strong>{{if .Laufend}}Werkstatt freigegeben{{else}}Keine laufende Freigabe{{end}}</strong>{{if .Grund}}: {{.Grund}}{{end}}</p>
{{with .Freigabe}}
<p>Freigabe <code>{{.Kennung}}</code> für {{.BoxArt}}, erteilt von {{.ErteiltVon}} am {{zeit .ErteiltAm}}, bis {{zeit .GueltigBis}}{{if .BeendetAm}}, beendet {{zeit .BeendetAm}}{{end}}</p>
<p>OpenWrt {{.OpenWrt.Fassung}} (<code>{{.OpenWrt.Datei}}</code>, sha256 <code>{{.OpenWrt.Sha256}}</code>) · Edge Light {{.EdgeLight.Fassung}} (Programm <code>{{.EdgeLight.ProgrammSha256}}</code>, Skripte <code>{{.EdgeLight.SkripteSha256}}</code>)</p>
<p>Boxen unter dieser Freigabe: {{$.A.Freigabe.Boxen}} von höchstens {{.Obergrenze}}</p>
{{end}}
{{end}}
</div>

<h2>Werkstatt-Anschluss</h2>
<div class="karte">
<p>{{if .A.Anschluss}}{{.A.Anschluss}}{{else}}–{{end}}</p>
{{with .A.Lauf}}
<p><strong>Lauf <a href="laeufe/{{.Kennung}}.json"><code>{{.Kennung}}</code></a>: {{.Zustand}}</strong>{{if .Titel}} · {{.Titel}}{{end}}</p>
{{if .Hinweis}}<p class="schlecht"><strong>Dein Schritt:</strong> {{.Hinweis}}</p>{{end}}
{{if .Handgriff}}<p class="schlecht"><strong>Handgriff:</strong> {{.Handgriff}}</p>{{end}}
{{if .Grund}}<p>Grund: {{.Grund}}</p>{{end}}
<p>Erledigt: {{range $i, $s := .Erledigt}}{{if $i}}, {{end}}{{$s}}{{else}}noch nichts{{end}}</p>
{{end}}
</div>

<h2>Läufe</h2>
<table><thead><tr><th>Lauf</th><th>Zustand</th><th>Schritt</th><th>Grund</th></tr></thead><tbody>
{{range .Laeufe}}<tr><td><a href="laeufe/{{.Kennung}}.json"><code>{{.Kennung}}</code></a></td><td>{{.Zustand}}</td><td>{{.Schritt}}</td><td>{{.Grund}}</td></tr>
{{else}}<tr><td colspan="4">noch kein Lauf</td></tr>{{end}}
</tbody></table>
</body></html>
`))
