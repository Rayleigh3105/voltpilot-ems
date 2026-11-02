package freigabe

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// TokenQuelle liefert das Zugangs-Token des Dienstkontos.
type TokenQuelle interface {
	Token(ctx context.Context) (string, error)
}

// API liest die laufende Freigabe aus der Portal-API (Werkstatt-Automatik V1):
// GET /api/v1/werkstatt-dienst/freigabe, nur mit der Rolle werkstatt-dienst.
// Die Antwort hat das Format der Datei (Schema vp-werkstatt-freigabe.v1) und
// geht durch dieselbe Prüfung wie sie. Freigeben kann der Dienst dort nicht.
type API struct {
	URL    string // Basis, etwa https://portal.voltpilot.de
	BoxArt string
	Token  TokenQuelle
	Client *http.Client
}

// Aktuell fragt die API. 404 heißt: es läuft keine Freigabe.
func (a API) Aktuell() (Freigabe, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tok, err := a.Token.Token(ctx)
	if err != nil {
		return Freigabe{}, err
	}
	box := a.BoxArt
	if box == "" {
		box = Mango
	}
	u := strings.TrimRight(a.URL, "/") + "/api/v1/werkstatt-dienst/freigabe?boxArt=" + url.QueryEscape(box)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return Freigabe{}, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Accept", "application/json")
	cl := a.Client
	if cl == nil {
		cl = &http.Client{Timeout: 20 * time.Second}
	}
	resp, err := cl.Do(req)
	if err != nil {
		return Freigabe{}, fmt.Errorf("Freigabe aus der API: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	switch resp.StatusCode {
	case http.StatusOK:
		return Lies(body)
	case http.StatusNotFound:
		return Freigabe{}, Keine{"Die Werkstatt ist nicht freigegeben (keine laufende Freigabe im Portal)."}
	default:
		return Freigabe{}, fmt.Errorf("Freigabe aus der API: HTTP %d", resp.StatusCode)
	}
}
