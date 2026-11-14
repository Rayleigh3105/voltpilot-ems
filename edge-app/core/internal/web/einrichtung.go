// Die Einrichtungsseite der Box (Scheibe S3 des WLAN-Konzepts, Entscheide vom
// 13.11.2026): Kabel oder WLAN, Liste der 2,4-GHz-Netze, Passwort,
// Empfangspruefung - sie ruft dafuer das Netz-Skript der Box auf
// (wlan-anschluss.sh, Scheibe S2). Das Programm aendert die Konfiguration
// weiter nie selbst; es reicht nur den Knopfdruck weiter
// (edge-light/docs/boot-und-updates.md).
//
// Zwei Regeln schuetzen die Box:
//
//  1. Die Kennung (E6=B): JEDER aendernde Aufruf verlangt die vorher
//     eingegebene Kennung, die unten auf der Box und im Portal steht - egal,
//     aus welchem Netz er kommt. Fuenf Fehlversuche, dann fuenf Minuten
//     Pause. Die Seite zeigt die Kennung vor der Eingabe nirgends; sie steht
//     deshalb auch in keiner Antwort dieser Endpunkte.
//  2. Die Schranke: Anfragen, die die Box unter ihrer Einrichtungs-Adresse
//     erreichen (das offene WLAN "VoltPilot-Einrichtung", einrichtung-wlan.sh),
//     sehen NUR die Einrichtungsseite und ihre API - nicht die uebrige
//     Web-App, die am Kabel der Box ohne Anmeldung offen ist. Jede andere
//     GET-Anfrage wird auf die Seite umgelenkt; so oeffnet auch die
//     Anmelde-Erkennung des Handys die Seite von selbst (die Firewall der
//     Box lenkt Port 80 im Einrichtungs-WLAN auf die Web-App um).
package web

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	einrichtungVersuche = 5                // Fehlversuche bis zur Pause
	einrichtungPause    = 5 * time.Minute  // Pause nach den Fehlversuchen
	einrichtungSitzung  = 30 * time.Minute // Sitzung, gleitend verlaengert
)

// Einrichtung ist die Einrichtungsseite der Box: Kennungs-Schranke, Sitzungen
// und die Aufrufe des Netz-Skripts. edgemain baut sie einmal und reicht sie an
// Handler; die Labor-Probe (cmd/einrichtung-probe) nutzt dieselbe Umsetzung.
type Einrichtung struct {
	ref     string // die Kennung der Box, normalisiert (z. B. "edgewrk7abg")
	skript  string // Pfad des Netz-Skripts (wlan-anschluss.sh)
	adresse string // Adresse der Box im Einrichtungs-WLAN (Schranke)

	// jetzt und ausfuehren tauschen die Tests aus.
	jetzt      func() time.Time
	ausfuehren func(ctx context.Context, stdin string, arg ...string) (string, int, error)

	mu           sync.Mutex
	fehlversuche int
	gesperrtBis  time.Time
	sitzungen    map[string]time.Time // Sitzungsmarke -> Ablauf
	lauf         *verbindenLauf
}

// verbindenLauf ist der eine laufende oder zuletzt beendete verbinden-Aufruf.
// Er laeuft im Hintergrund: waehrend der Pruefung wechselt das Funkmodul zum
// Kunden-WLAN, das Handy verliert das Einrichtungs-WLAN kurz und holt sich das
// Ergebnis danach mit GET ab.
type verbindenLauf struct {
	laeuft bool
	ssid   string
	beginn time.Time
	rc     int
	felder map[string]string
}

// NewEinrichtung baut die Einrichtungsseite. ref ist die Kennung der Box
// (agent.LoadRef), skript das Netz-Skript, adresse die Box-Adresse im
// Einrichtungs-WLAN ("" schaltet nur die Schranke ab, nie die Kennung).
func NewEinrichtung(ref, skript, adresse string) *Einrichtung {
	e := &Einrichtung{
		ref:       kennungNormalisieren(ref),
		skript:    skript,
		adresse:   adresse,
		jetzt:     time.Now,
		sitzungen: map[string]time.Time{},
	}
	e.ausfuehren = e.skriptAusfuehren
	return e
}

// kennungNormalisieren macht aus jeder Schreibweise die Vergleichsform:
// Kleinbuchstaben, ohne Leerzeichen, Striche und Unterstriche - wie
// pruefeKennung im Portal (frontend/portal/src/edgeRef.ts). "EDGE-WRK7ABG"
// und "edge wrk7abg" meinen dieselbe Box.
func kennungNormalisieren(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		if r == '-' || r == '_' || r == ' ' {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// verfuegbar: gibt es das Netz-Skript auf dieser Box? Auf der Docker-Box
// fehlt es, und die Seite sagt das, statt ins Leere zu laufen.
func (e *Einrichtung) verfuegbar() bool {
	if e.skript == "" {
		return false
	}
	st, err := os.Stat(e.skript)
	return err == nil && st.Mode().IsRegular()
}

// skriptAusfuehren ruft das Netz-Skript auf. stdin traegt das Passwort bei
// verbinden - nie ein Argument: die Prozessliste zeigt Argumente jedem.
func (e *Einrichtung) skriptAusfuehren(ctx context.Context, stdin string, arg ...string) (string, int, error) {
	cmd := exec.CommandContext(ctx, e.skript, arg...)
	cmd.Stdin = strings.NewReader(stdin)
	var aus, fehler strings.Builder
	cmd.Stdout = &aus
	cmd.Stderr = &fehler
	err := cmd.Run()
	rc := 0
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			rc = ee.ExitCode()
			err = nil
		} else if ctx.Err() == context.DeadlineExceeded {
			err = fmt.Errorf("%s: ohne Antwort abgebrochen", e.skript)
		}
	}
	return aus.String(), rc, err
}

// felderAusZeilen liest die "schluessel=wert"-Ausgabe des Skripts.
func felderAusZeilen(aus string) map[string]string {
	f := map[string]string{}
	for _, z := range strings.Split(aus, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(z), "=")
		if ok && k != "" && !strings.ContainsAny(k, " \t") {
			f[k] = v
		}
	}
	return f
}

// ---- Sitzungen und Kennung -------------------------------------------------

func (e *Einrichtung) angemeldet(r *http.Request) bool {
	c, err := r.Cookie("vp_einricht")
	if err != nil || c.Value == "" {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	ablauf, ok := e.sitzungen[c.Value]
	if !ok {
		return false
	}
	now := e.jetzt()
	if now.After(ablauf) {
		delete(e.sitzungen, c.Value)
		return false
	}
	e.sitzungen[c.Value] = now.Add(einrichtungSitzung) // gleitend
	return true
}

// anmelden prueft die Kennung. Rueckgabe: Sitzungsmarke, Sperr-Rest,
// verbleibende Versuche, ob die Kennung passt.
func (e *Einrichtung) anmelden(kennung string) (marke string, gesperrt time.Duration, frei int, ok bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.jetzt()
	if now.Before(e.gesperrtBis) {
		return "", e.gesperrtBis.Sub(now), 0, false
	}
	e.fehlversucheZuruecksetzenWennPauseVorbei(now)
	eingabe := []byte(kennungNormalisieren(kennung))
	if subtle.ConstantTimeCompare(eingabe, []byte(e.ref)) != 1 {
		e.fehlversuche++
		if e.fehlversuche >= einrichtungVersuche {
			e.gesperrtBis = now.Add(einrichtungPause)
			e.fehlversuche = 0
			return "", einrichtungPause, 0, false
		}
		return "", 0, einrichtungVersuche - e.fehlversuche, false
	}
	e.fehlversuche = 0
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", 0, einrichtungVersuche, false
	}
	marke = hex.EncodeToString(b)
	for alte, ablauf := range e.sitzungen {
		if now.After(ablauf) {
			delete(e.sitzungen, alte)
		}
	}
	e.sitzungen[marke] = now.Add(einrichtungSitzung)
	return marke, 0, einrichtungVersuche, true
}

func (e *Einrichtung) fehlversucheZuruecksetzenWennPauseVorbei(now time.Time) {
	if !e.gesperrtBis.IsZero() && now.After(e.gesperrtBis) {
		e.gesperrtBis = time.Time{}
		e.fehlversuche = 0
	}
}

// ---- Die Schranke -----------------------------------------------------------

// einrichtungsPfade sind die einzigen Pfade, die das Einrichtungs-WLAN sieht:
// die Seite, ihre Dateien und ihre API. tokens.css teilt sich die Seite mit
// der uebrigen Web-App.
var einrichtungsPfade = map[string]bool{
	"/einrichtung.html": true,
	"/einrichtung.css":  true,
	"/einrichtung.js":   true,
	"/tokens.css":       true,
	"/favicon.svg":      true,
	"/favicon.ico":      true,
}

// Schranke trennt die zwei Gesichter der Web-App: Anfragen an die
// Einrichtungs-Adresse der Box (lokale Adresse der Verbindung, faelschbar ist
// sie nicht) sehen nur die Einrichtungsseite und gehen am Beobachter vorbei -
// eine Anmelde-Erkennung mit fremdem Host-Header soll der Box nie als
// "beobachtete Adresse" gelten (agent.WebObserver). Alles andere laeuft
// unveraendert ueber beobachtet.
func (e *Einrichtung) Schranke(beobachtet, direkt http.Handler) http.Handler {
	if e == nil || e.adresse == "" {
		return beobachtet
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lokal, _ := r.Context().Value(http.LocalAddrContextKey).(net.Addr)
		if lokal == nil || !e.istEinrichtungsAdresse(lokal.String()) {
			beobachtet.ServeHTTP(w, r)
			return
		}
		if einrichtungsPfade[r.URL.Path] || strings.HasPrefix(r.URL.Path, "/api/einrichtung/") {
			direkt.ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			http.Redirect(w, r, "/einrichtung.html", http.StatusFound)
			return
		}
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error": "Im Einrichtungs-WLAN gibt es nur die Einrichtungsseite.",
		})
	})
}

func (e *Einrichtung) istEinrichtungsAdresse(lokal string) bool {
	host, _, err := net.SplitHostPort(lokal)
	if err != nil {
		host = lokal
	}
	return host == e.adresse
}

// ---- Die API ----------------------------------------------------------------

// registriere haengt die Einrichtungs-API an den mux. Alle aendernden und
// lesenden Skript-Aufrufe stehen hinter der Kennung; offen ist nur der
// Anmeldestand selbst.
func (e *Einrichtung) registriere(mux *http.ServeMux) {
	schranke := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !e.angemeldet(r) {
				writeJSON(w, http.StatusUnauthorized, map[string]any{
					"error":                  "Bitte zuerst die Kennung eingeben, die unten auf der Box steht.",
					"anmeldung_erforderlich": true,
				})
				return
			}
			if !e.verfuegbar() {
				writeJSON(w, http.StatusNotFound, map[string]any{
					"error": "Auf dieser Box gibt es den WLAN-Anschluss nicht.",
				})
				return
			}
			h(w, r)
		}
	}
	// Aendernde Aufrufe nur als JSON: ein Formular einer fremden Seite im
	// selben Browser kommt ohne CORS-Freigabe nicht an diesen Inhaltstyp.
	nurJSON := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
				writeJSON(w, http.StatusUnsupportedMediaType, map[string]any{
					"error": "Ungültige Anfrage.",
				})
				return
			}
			h(w, r)
		}
	}
	readBody := func(r *http.Request, v any) bool {
		return json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(v) == nil
	}

	mux.HandleFunc("GET /api/einrichtung/anmeldung", func(w http.ResponseWriter, r *http.Request) {
		e.mu.Lock()
		now := e.jetzt()
		e.fehlversucheZuruecksetzenWennPauseVorbei(now)
		gesperrt := 0
		if now.Before(e.gesperrtBis) {
			gesperrt = int(e.gesperrtBis.Sub(now).Seconds()) + 1
		}
		frei := einrichtungVersuche - e.fehlversuche
		e.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"verfuegbar":    e.verfuegbar(),
			"angemeldet":    e.angemeldet(r),
			"gesperrt_s":    gesperrt,
			"versuche_frei": frei,
		})
	})

	mux.HandleFunc("POST /api/einrichtung/anmeldung", nurJSON(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Kennung string `json:"kennung"`
		}
		if !readBody(r, &body) || strings.TrimSpace(body.Kennung) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Ungültige Anfrage."})
			return
		}
		marke, gesperrt, frei, ok := e.anmelden(body.Kennung)
		if gesperrt > 0 {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{
				"error":      "Zu viele Versuche. Bitte warten Sie fünf Minuten und versuchen Sie es dann erneut.",
				"gesperrt_s": int(gesperrt.Seconds()) + 1,
			})
			return
		}
		if !ok {
			writeJSON(w, http.StatusForbidden, map[string]any{
				"error":         "Die Kennung passt nicht zu dieser Box. Sie steht unten auf der Box und im Portal.",
				"versuche_frei": frei,
			})
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name:     "vp_einricht",
			Value:    marke,
			Path:     "/",
			MaxAge:   int(einrichtungSitzung.Seconds()),
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
		})
		writeJSON(w, http.StatusOK, map[string]any{"angemeldet": true})
	}))

	mux.HandleFunc("GET /api/einrichtung/status", schranke(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		aus, rc, err := e.ausfuehren(ctx, "", "status")
		if err != nil || rc != 0 {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "Der Zustand ließ sich nicht lesen."})
			return
		}
		e.mu.Lock()
		laeuft := e.lauf != nil && e.lauf.laeuft
		e.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"status":           felderAusZeilen(aus),
			"verbinden_laeuft": laeuft,
		})
	}))

	mux.HandleFunc("GET /api/einrichtung/netze", schranke(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		defer cancel()
		aus, rc, err := e.ausfuehren(ctx, "", "scan")
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "Die Suche nach WLANs ist fehlgeschlagen."})
			return
		}
		if rc != 0 {
			f := felderAusZeilen(aus)
			meldung := f["meldung"]
			if meldung == "" {
				meldung = "Die Suche nach WLANs ist fehlgeschlagen."
			}
			writeJSON(w, http.StatusOK, map[string]any{"netze": []any{}, "fehler": meldung})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"netze": netzeAusZeilen(aus)})
	}))

	mux.HandleFunc("POST /api/einrichtung/verbinden", schranke(nurJSON(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SSID     string `json:"ssid"`
			Passwort string `json:"passwort"`
		}
		if !readBody(r, &body) || strings.TrimSpace(body.SSID) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Ungültige Anfrage."})
			return
		}
		if !e.verbindenStarten(body.SSID, body.Passwort) {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "Die Box prüft gerade schon eine Verbindung."})
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"gestartet": true})
	})))

	mux.HandleFunc("GET /api/einrichtung/verbinden", schranke(func(w http.ResponseWriter, r *http.Request) {
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.lauf == nil {
			writeJSON(w, http.StatusOK, map[string]any{"laeuft": false})
			return
		}
		if e.lauf.laeuft {
			writeJSON(w, http.StatusOK, map[string]any{
				"laeuft": true,
				"ssid":   e.lauf.ssid,
				"seit_s": int(e.jetzt().Sub(e.lauf.beginn).Seconds()),
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"laeuft": false,
			"ssid":   e.lauf.ssid,
			"rc":     e.lauf.rc,
			"felder": e.lauf.felder,
		})
	}))

	mux.HandleFunc("POST /api/einrichtung/kabel", schranke(nurJSON(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			OhneKabel bool `json:"ohne_kabel"`
		}
		if !readBody(r, &body) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Ungültige Anfrage."})
			return
		}
		arg := []string{"kabel"}
		if body.OhneKabel {
			arg = append(arg, "--ohne-kabel")
		}
		ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
		defer cancel()
		aus, rc, err := e.ausfuehren(ctx, "", arg...)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "Der Wechsel auf das Kabel ist fehlgeschlagen."})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"rc": rc, "felder": felderAusZeilen(aus)})
	})))
}

// verbindenStarten startet den Hintergrund-Lauf; false, wenn schon einer laeuft.
func (e *Einrichtung) verbindenStarten(ssid, passwort string) bool {
	e.mu.Lock()
	if e.lauf != nil && e.lauf.laeuft {
		e.mu.Unlock()
		return false
	}
	lauf := &verbindenLauf{laeuft: true, ssid: ssid, beginn: e.jetzt()}
	e.lauf = lauf
	e.mu.Unlock()
	go func() {
		// Unabhaengig von der Anfrage: das Handy verliert waehrend der
		// Pruefung das Einrichtungs-WLAN, der Lauf geht trotzdem zu Ende.
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		stdin := ""
		if passwort != "" {
			stdin = passwort + "\n"
		}
		aus, rc, err := e.ausfuehren(ctx, stdin, "verbinden", ssid)
		felder := felderAusZeilen(aus)
		if err != nil {
			rc = 9
			if felder["meldung"] == "" {
				felder["meldung"] = "Die Prüfung ist fehlgeschlagen. Bitte erneut versuchen."
			}
		}
		e.mu.Lock()
		lauf.laeuft = false
		lauf.rc = rc
		lauf.felder = felder
		e.mu.Unlock()
	}()
	return true
}

// netzeAusZeilen liest die scan-Ausgabe: je Netz eine Zeile
// "signal=-30 kanal=6 verschluesselung=psk2 ssid=Name mit Leerzeichen".
func netzeAusZeilen(aus string) []map[string]any {
	netze := []map[string]any{}
	for _, z := range strings.Split(aus, "\n") {
		z = strings.TrimSpace(z)
		if !strings.HasPrefix(z, "signal=") {
			continue
		}
		teile := strings.SplitN(z, " ", 4)
		if len(teile) != 4 || !strings.HasPrefix(teile[3], "ssid=") {
			continue
		}
		wert := func(t string) string { _, v, _ := strings.Cut(t, "="); return v }
		enc := wert(teile[2])
		n := map[string]any{
			"ssid":             wert(teile[3]),
			"signal":           wert(teile[0]),
			"kanal":            wert(teile[1]),
			"verschluesselung": enc,
			"offen":            enc == "none",
			"geeignet":         enc != "nicht_unterstuetzt",
			"hinweis":          "",
		}
		if enc == "nicht_unterstuetzt" {
			n["hinweis"] = "Diese Anmeldung kann die Box nicht (Firmen-WLAN, WEP oder OWE)."
		} else if s := strings.ToLower(wert(teile[3])); strings.Contains(s, "gast") || strings.Contains(s, "guest") {
			n["hinweis"] = "Ein Gäste-WLAN trennt die Box von den Geräten im Haus – besser das normale WLAN wählen."
		}
		netze = append(netze, n)
	}
	return netze
}

// EinrichtungProbe ist die Oberflaeche der Labor-Probe (edge-light/test,
// Lauf einrichtung-weg): nur die statischen Seiten, die Einrichtungs-API und
// die Schranke, ohne Agent. Die echte Box verdrahtet Handler() in edgemain.
func EinrichtungProbe(einr *Einrichtung) http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(staticFS, "static")
	mux.Handle("/", http.FileServer(http.FS(sub)))
	einr.registriere(mux)
	return einr.Schranke(mux, mux)
}
