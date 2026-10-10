// Package quelle holt den Soll-Stand von der VoltPilot-API: Token über
// client_credentials beim Keycloak, dann GET /api/v1/fernwartung/soll.
// Pull, nur ausgehend - die VM braucht keine eingehende Verbindung.
package quelle

import (
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

// MaxAntwort begrenzt, was der Dienst liest.
const MaxAntwort = 4 << 20

// ErrAnmeldungAbgelehnt: der Token-Endpunkt hat die Anmeldung des
// Dienstkontos abgelehnt (HTTP 401 oder 403). Das ist kein Ausfall der API,
// sondern ein falscher Client oder ein falsches Secret - der Dienst meldet es
// deshalb mit eigenem Wortlaut.
var ErrAnmeldungAbgelehnt = errors.New("Anmeldung abgelehnt: Client oder Secret prüfen")

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
