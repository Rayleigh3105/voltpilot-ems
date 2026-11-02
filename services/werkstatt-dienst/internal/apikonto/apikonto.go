// Package apikonto holt das Token des Dienstkontos voltpilot-werkstatt-dienst
// (Keycloak, nur client_credentials) und hält es bis kurz vor Ablauf. Das
// Client-Secret lebt nur als geheim.Geheim.
package apikonto

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

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// Konto ist das Dienstkonto.
type Konto struct {
	TokenURL string
	ClientID string
	Secret   geheim.Geheim
	Client   *http.Client
	Jetzt    func() time.Time

	mu    sync.Mutex
	token geheim.Geheim
	bis   time.Time
}

// Token gibt ein gültiges Zugangs-Token zurück (mindestens 30 s gültig).
func (k *Konto) Token(ctx context.Context) (string, error) {
	jetzt := time.Now
	if k.Jetzt != nil {
		jetzt = k.Jetzt
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if !k.token.Leer() && jetzt().Add(30*time.Second).Before(k.bis) {
		return k.token.Offenbaren(), nil
	}
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {k.ClientID}, "client_secret": {k.Secret.Offenbaren()}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, k.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	cl := k.Client
	if cl == nil {
		cl = &http.Client{Timeout: 15 * time.Second}
	}
	resp, err := cl.Do(req)
	if err != nil {
		return "", fmt.Errorf("Token des Dienstkontos: %s", geheim.Schwaerze(err.Error()))
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Token des Dienstkontos: HTTP %d (Client %s, Secret und Rolle werkstatt-dienst prüfen)", resp.StatusCode, k.ClientID)
	}
	var t struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &t); err != nil || t.AccessToken == "" {
		return "", errors.New("Token des Dienstkontos: Antwort ohne access_token")
	}
	k.token.Vergessen()
	k.token = geheim.Neu(t.AccessToken)
	if t.ExpiresIn <= 0 {
		t.ExpiresIn = 60
	}
	k.bis = jetzt().Add(time.Duration(t.ExpiresIn) * time.Second)
	return t.AccessToken, nil
}
