// Package portal spricht mit dem Baum des Dienstes in der Portal-API
// (/api/v1/werkstatt-dienst/**, Rolle werkstatt-dienst): Einmal-Code holen,
// Probe-Fenster einer Einlösung schließen, Abnahme mit Belegen schreiben. Die
// Formen stehen in docs/contracts/openapi.yaml (Tag werkstatt-dienst) und
// docs/contracts/werkstatt-einloesen-v1.md. Der Code lebt nur als
// geheim.Geheim und steht in keinem Log und keinem Fehler.
package portal

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
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// TokenQuelle liefert das Token des Dienstkontos.
type TokenQuelle interface {
	Token(ctx context.Context) (string, error)
}

// Client ist der Zugang zum Dienst-Baum.
type Client struct {
	URL    string
	Token  TokenQuelle
	Client *http.Client
}

// Code ist ein Einmal-Code für genau eine Box.
type Code struct {
	Code       geheim.Geheim
	EdgeRef    string
	Freigabe   string
	GueltigBis time.Time
	Tausch     bool
}

// Abnahme ist die Abnahme mit den Belegen des Dienstes.
type Abnahme struct {
	Fassung        string            `json:"fassung"`
	HostSchluessel string            `json:"hostSchluessel"`
	LanNetz        string            `json:"lanNetz"`
	Belege         map[string]string `json:"belege"`
	PasswortAge    string            `json:"passwortAge"`
	Notiz          string            `json:"notiz,omitempty"`
}

// Angenommen ist die Antwort auf eine Abnahme.
type Angenommen struct {
	ID            string    `json:"id"`
	EdgeRef       string    `json:"edgeRef"`
	FreigabeID    string    `json:"freigabeId"`
	EinloesungID  string    `json:"einloesungId"`
	LanNetz       string    `json:"lanNetz"`
	TunnelAdresse string    `json:"tunnelAdresse"`
	ErfasstAm     time.Time `json:"erfasstAm"`
}

// Abgelehnt ist eine Antwort außer 2xx, mit dem Satz der API.
type Abgelehnt struct {
	Status  int
	Message string
}

func (a Abgelehnt) Error() string {
	return fmt.Sprintf("Portal: HTTP %d: %s", a.Status, a.Message)
}

// CodeHolen holt einen Einmal-Code (POST /codes).
func (c Client) CodeHolen(ctx context.Context, edgeRef string, tausch bool) (Code, error) {
	var out struct {
		Code       string    `json:"code"`
		EdgeRef    string    `json:"edgeRef"`
		Freigabe   string    `json:"freigabe"`
		GueltigBis time.Time `json:"gueltigBis"`
		Tausch     bool      `json:"tausch"`
	}
	if err := c.rufe(ctx, http.MethodPost, "/codes", map[string]any{"edgeRef": edgeRef, "tausch": tausch}, http.StatusCreated, &out); err != nil {
		return Code{}, err
	}
	if out.EdgeRef != edgeRef || out.Code == "" {
		return Code{}, errors.New("Portal: Antwort auf den Code passt nicht zur Box")
	}
	return Code{Code: geheim.Neu(out.Code), EdgeRef: out.EdgeRef, Freigabe: out.Freigabe, GueltigBis: out.GueltigBis, Tausch: out.Tausch}, nil
}

// FensterSchliessen schließt das Probe-Fenster einer Einlösung. Ein schon
// geschlossenes (409) ist kein Fehler: geschlossen ist es dann ja.
func (c Client) FensterSchliessen(ctx context.Context, fensterID string) (schonZu bool, err error) {
	err = c.rufe(ctx, http.MethodPost, "/fenster/"+url.PathEscape(fensterID)+"/schliessen", nil, http.StatusOK, nil)
	var ab Abgelehnt
	if errors.As(err, &ab) && ab.Status == http.StatusConflict {
		return true, nil
	}
	return false, err
}

// AbnahmeSchreiben schreibt die Abnahme mit Belegen (POST /abnahmen/{ref}).
func (c Client) AbnahmeSchreiben(ctx context.Context, edgeRef string, a Abnahme) (Angenommen, error) {
	var out Angenommen
	err := c.rufe(ctx, http.MethodPost, "/abnahmen/"+url.PathEscape(edgeRef), a, http.StatusCreated, &out)
	return out, err
}

func (c Client) rufe(ctx context.Context, methode, pfad string, rein any, erwartet int, raus any) error {
	tok, err := c.Token.Token(ctx)
	if err != nil {
		return err
	}
	var body io.Reader
	if rein != nil {
		b, err := json.Marshal(rein)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, methode, strings.TrimRight(c.URL, "/")+"/api/v1/werkstatt-dienst"+pfad, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Accept", "application/json")
	if rein != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	cl := c.Client
	if cl == nil {
		cl = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := cl.Do(req)
	if err != nil {
		return fmt.Errorf("Portal nicht erreicht: %s", geheim.Schwaerze(err.Error()))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if resp.StatusCode != erwartet {
		var m struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &m)
		if m.Message == "" {
			m.Message = http.StatusText(resp.StatusCode)
		}
		return Abgelehnt{Status: resp.StatusCode, Message: geheim.Schwaerze(m.Message)}
	}
	if raus != nil {
		if err := json.Unmarshal(raw, raus); err != nil {
			return fmt.Errorf("Portal: Antwort kein JSON: %v", err)
		}
	}
	return nil
}
