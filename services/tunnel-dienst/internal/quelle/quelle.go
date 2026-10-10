// Package quelle holt den Soll-Stand von der VoltPilot-API: Token über
// client_credentials beim Keycloak, dann GET /api/v1/fernwartung/soll.
// Pull, nur ausgehend - die VM braucht keine eingehende Verbindung.
package quelle

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// SollPfad ist die Leseroute der API.
const SollPfad = "/api/v1/fernwartung/soll"

// MeldePfad ist die Route der Rückmeldung ans Portal (Vertrag:
// docs/contracts/fernwartung-rueckmeldung-v1.md).
const MeldePfad = "/api/v1/fernwartung/rueckmeldung"

// MaxAntwort begrenzt, was der Dienst liest.
const MaxAntwort = 4 << 20

// ErrAnmeldungAbgelehnt: der Token-Endpunkt hat die Anmeldung des
// Dienstkontos abgelehnt (HTTP 401 oder 403). Das ist kein Ausfall der API,
// sondern ein falscher Client oder ein falsches Secret - der Dienst meldet es
// deshalb mit eigenem Wortlaut.
var ErrAnmeldungAbgelehnt = errors.New("Anmeldung abgelehnt: Client oder Secret prüfen")

// ErrKeinToken: für die Rückmeldung liegt kein gültiges Token bereit. Die
// Rückmeldung holt nie selbst eines - das tut allein der Abruf des
// Soll-Stands.
var ErrKeinToken = errors.New("kein gültiges Token (das holt nur der Abruf des Soll-Stands)")

// MeldeFehler: die API hat die Rückmeldung nicht angenommen.
type MeldeFehler struct {
	Status int
	// Text ist der Anfang der Antwort (höchstens 300 Zeichen, eine Zeile).
	Text string
}

func (e *MeldeFehler) Error() string {
	if e.Text == "" {
		return fmt.Sprintf("Rückmeldung: HTTP %d", e.Status)
	}
	return fmt.Sprintf("Rückmeldung: HTTP %d: %s", e.Status, e.Text)
}

// RouteFehlt: die API kennt die Rückmeldung nicht - ein älterer Stand der
// API, kein Fehler dieser Meldung.
func (e *MeldeFehler) RouteFehlt() bool {
	return e.Status == http.StatusNotFound || e.Status == http.StatusMethodNotAllowed ||
		e.Status == http.StatusNotImplemented
}

// API holt den Soll-Stand.
type API struct {
	Basis        string // z. B. https://portal.voltpilot.de
	TokenURL     string
	ClientID     string
	ClientSecret string
	HTTP         *http.Client

	mu         sync.Mutex
	token      string
	gueltigBis time.Time
	jetzt      func() time.Time
}

// Neu prüft die Adressen: HTTPS ist Pflicht, außer für die eigene Maschine
// (Integrationsprobe, lokaler Tunnel). Ein Token im Klartext übers Netz
// gäbe jedem Mitleser den Soll-Stand.
func Neu(basis, tokenURL, clientID, clientSecret string, timeout time.Duration) (*API, error) {
	for _, u := range []string{basis, tokenURL} {
		if err := sicher(u); err != nil {
			return nil, err
		}
	}
	if clientID == "" || clientSecret == "" {
		return nil, errors.New("Client-ID und Client-Secret des Dienstkontos fehlen")
	}
	return &API{
		Basis:        strings.TrimRight(basis, "/"),
		TokenURL:     tokenURL,
		ClientID:     clientID,
		ClientSecret: clientSecret,
		HTTP:         &http.Client{Timeout: timeout},
		jetzt:        time.Now,
	}, nil
}

func sicher(roh string) error {
	u, err := url.Parse(roh)
	if err != nil || u.Host == "" {
		return fmt.Errorf("keine gültige URL: %q", roh)
	}
	if u.Scheme == "https" {
		return nil
	}
	h := u.Hostname()
	if u.Scheme == "http" && (h == "localhost" || h == "127.0.0.1" || h == "::1") {
		return nil
	}
	return fmt.Errorf("%s: nur https erlaubt (http nur für localhost)", roh)
}

// Hole liefert die Rohbytes des Soll-Stands.
func (a *API) Hole(ctx context.Context) ([]byte, error) {
	for versuch := 0; versuch < 2; versuch++ {
		token, err := a.holeToken(ctx, versuch > 0)
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.Basis+SollPfad, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/json")
		res, err := a.HTTP.Do(req)
		if err != nil {
			return nil, fmt.Errorf("Soll-Stand abholen: %w", err)
		}
		daten, err := io.ReadAll(io.LimitReader(res.Body, MaxAntwort+1))
		res.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("Soll-Stand lesen: %w", err)
		}
		if res.StatusCode == http.StatusUnauthorized && versuch == 0 {
			continue // Token abgelaufen oder widerrufen: einmal neu holen
		}
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("Soll-Stand: HTTP %d", res.StatusCode)
		}
		if len(daten) > MaxAntwort {
			return nil, fmt.Errorf("Soll-Stand größer als %d Byte", MaxAntwort)
		}
		return daten, nil
	}
	return nil, errors.New("Soll-Stand: HTTP 401 auch mit frischem Token")
}

type tokenAntwort struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
}

func (a *API) holeToken(ctx context.Context, erzwingen bool) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !erzwingen && a.token != "" && a.jetzt().Before(a.gueltigBis) {
		return a.token, nil
	}
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {a.ClientID},
		"client_secret": {a.ClientSecret}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := a.HTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("Token holen: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		return "", fmt.Errorf("%w (Token-Endpunkt: HTTP %d)", ErrAnmeldungAbgelehnt, res.StatusCode)
	}
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Token holen: HTTP %d", res.StatusCode)
	}
	var t tokenAntwort
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&t); err != nil || t.AccessToken == "" {
		return "", errors.New("Token holen: Antwort ohne access_token")
	}
	leben := time.Duration(t.ExpiresIn) * time.Second
	if leben <= 0 {
		leben = time.Minute
	}
	// Eine halbe Minute Puffer, damit kein Token auf dem Weg abläuft.
	a.token = t.AccessToken
	a.gueltigBis = a.jetzt().Add(leben - min(leben/2, 30*time.Second))
	return a.token, nil
}

// Melder schickt die Rückmeldung ans Portal. Er teilt mit dem Abruf des
// Soll-Stands nur das Token und nimmt es, wie es gerade bereitliegt: eigener
// HTTP-Client mit eigener Frist und eigenen Verbindungen, kein eigener Gang
// zum Keycloak, keine Wiederholung. Was hier hängt oder scheitert, hält den
// Abruf des Soll-Stands nicht auf.
type Melder struct {
	api  *API
	http *http.Client
}

// Melder liefert den Absender der Rückmeldung; frist gilt für den ganzen
// Aufruf.
func (a *API) Melder(frist time.Duration) *Melder {
	return &Melder{api: a, http: &http.Client{
		Timeout:   frist,
		Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, MaxIdleConns: 1, IdleConnTimeout: 90 * time.Second},
		// Das Token geht nur an die eingestellte Adresse, nie einer Umleitung nach.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// bereitesToken liefert das Token, wenn es bereitliegt und noch gilt. Holt
// der Abruf des Soll-Stands gerade eines, wartet diese Seite nicht darauf.
func (a *API) bereitesToken() (string, bool) {
	if !a.mu.TryLock() {
		return "", false
	}
	defer a.mu.Unlock()
	if a.token == "" || !a.jetzt().Before(a.gueltigBis) {
		return "", false
	}
	return a.token, true
}

// Melde schickt den Rumpf als PUT an MeldePfad. Angenommen ist die Meldung
// nur mit einer Antwort 2xx; alles andere ist ein *MeldeFehler,
// ErrKeinToken oder ein Fehler des Netzes.
func (m *Melder) Melde(ctx context.Context, rumpf []byte) error {
	token, ok := m.api.bereitesToken()
	if !ok {
		return ErrKeinToken
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, m.api.Basis+MeldePfad, bytes.NewReader(rumpf))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := m.http.Do(req)
	if err != nil {
		return fmt.Errorf("Rückmeldung senden: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return nil
	}
	anfang, _ := io.ReadAll(io.LimitReader(res.Body, 300))
	return &MeldeFehler{Status: res.StatusCode, Text: eineZeile(string(anfang))}
}

// eineZeile macht aus dem Anfang einer Antwort eine Zeile fürs Journal.
func eineZeile(text string) string {
	return strings.Join(strings.Fields(strings.ToValidUTF8(text, "?")), " ")
}
