package flowdeploy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// NRClient is the slice of the Node-RED Admin API the deployer needs
// (runtime deploy via the per-flow endpoints - no container restart).
type NRClient interface {
	// PaletteVersion returns the installed @voltpilot/node-red-vp-palette
	// version (GET /nodes) - the source of truth for the min_palette_version
	// gate, live from the runtime instead of a hand-maintained env.
	PaletteVersion() (string, error)
	// GetFlow returns one flow (tab) by id; found=false on 404.
	GetFlow(id string) (json.RawMessage, bool, error)
	CreateFlow(flow NRFlow) error
	UpdateFlow(id string, flow NRFlow) error
	DeleteFlow(id string) error
	// ListTabs enumerates all tabs with their info field (GET /flows), so the
	// deployer can remove @vp-flow tabs that left the deployment set.
	ListTabs() ([]TabInfo, error)
}

// NRFlow is the per-flow API representation (POST/PUT /flow).
type NRFlow struct {
	ID    string            `json:"id,omitempty"`
	Label string            `json:"label"`
	Info  string            `json:"info,omitempty"`
	Nodes []json.RawMessage `json:"nodes"`
}

// TabInfo is one tab from GET /flows.
type TabInfo struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Info  string `json:"info"`
}

// PaletteModule is the vp-palette module name looked up in GET /nodes.
const PaletteModule = "@voltpilot/node-red-vp-palette"

// HTTPNRClient talks to a real Node-RED admin endpoint with adminAuth
// credentials (POST /auth/token, bearer thereafter; re-login on 401).
type HTTPNRClient struct {
	BaseURL  string
	Username string
	Password string
	Client   *http.Client

	mu    sync.Mutex
	token string
}

// NewHTTPNRClient builds a client; baseURL like "http://nodered:1880".
func NewHTTPNRClient(baseURL, username, password string) *HTTPNRClient {
	return &HTTPNRClient{
		BaseURL:  strings.TrimRight(baseURL, "/"),
		Username: username,
		Password: password,
		Client:   &http.Client{Timeout: 15 * time.Second},
	}
}

func (c *HTTPNRClient) login() (string, error) {
	body, _ := json.Marshal(map[string]string{
		"client_id":  "node-red-admin",
		"grant_type": "password",
		"scope":      "*",
		"username":   c.Username,
		"password":   c.Password,
	})
	resp, err := c.Client.Post(c.BaseURL+"/auth/token", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("admin login refused (HTTP %d)", resp.StatusCode)
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil || tok.AccessToken == "" {
		return "", fmt.Errorf("admin login returned no token")
	}
	return tok.AccessToken, nil
}

// do performs one authenticated request, re-logging-in once on 401.
func (c *HTTPNRClient) do(method, path string, body []byte) (int, []byte, error) {
	c.mu.Lock()
	token := c.token
	c.mu.Unlock()
	for attempt := 0; attempt < 2; attempt++ {
		if token == "" {
			t, err := c.login()
			if err != nil {
				return 0, nil, err
			}
			c.mu.Lock()
			c.token = t
			c.mu.Unlock()
			token = t
		}
		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		}
		req, err := http.NewRequest(method, c.BaseURL+path, reader)
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := c.Client.Do(req)
		if err != nil {
			return 0, nil, err
		}
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 {
			token = ""
			c.mu.Lock()
			c.token = ""
			c.mu.Unlock()
			continue
		}
		return resp.StatusCode, data, nil
	}
	return 0, nil, fmt.Errorf("unreachable")
}

// PaletteVersion implements NRClient via GET /nodes.
func (c *HTTPNRClient) PaletteVersion() (string, error) {
	status, data, err := c.do(http.MethodGet, "/nodes", nil)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("GET /nodes -> HTTP %d", status)
	}
	var sets []struct {
		Module  string `json:"module"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &sets); err != nil {
		return "", err
	}
	for _, s := range sets {
		if s.Module == PaletteModule && s.Version != "" {
			return s.Version, nil
		}
	}
	return "", fmt.Errorf("%s ist in der Flow-Runtime nicht installiert", PaletteModule)
}

// GetFlow implements NRClient.
func (c *HTTPNRClient) GetFlow(id string) (json.RawMessage, bool, error) {
	status, data, err := c.do(http.MethodGet, "/flow/"+id, nil)
	if err != nil {
		return nil, false, err
	}
	switch status {
	case http.StatusOK:
		return data, true, nil
	case http.StatusNotFound:
		return nil, false, nil
	default:
		return nil, false, fmt.Errorf("GET /flow/%s -> HTTP %d", id, status)
	}
}

// CreateFlow implements NRClient.
func (c *HTTPNRClient) CreateFlow(flow NRFlow) error {
	body, err := json.Marshal(flow)
	if err != nil {
		return err
	}
	status, data, err := c.do(http.MethodPost, "/flow", body)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("POST /flow -> HTTP %d: %s", status, truncate(data))
	}
	return nil
}

// UpdateFlow implements NRClient.
func (c *HTTPNRClient) UpdateFlow(id string, flow NRFlow) error {
	flow.ID = id
	body, err := json.Marshal(flow)
	if err != nil {
		return err
	}
	status, data, err := c.do(http.MethodPut, "/flow/"+id, body)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("PUT /flow/%s -> HTTP %d: %s", id, status, truncate(data))
	}
	return nil
}

// DeleteFlow implements NRClient.
func (c *HTTPNRClient) DeleteFlow(id string) error {
	status, data, err := c.do(http.MethodDelete, "/flow/"+id, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK && status != http.StatusNoContent && status != http.StatusNotFound {
		return fmt.Errorf("DELETE /flow/%s -> HTTP %d: %s", id, status, truncate(data))
	}
	return nil
}

// ListTabs implements NRClient via GET /flows.
func (c *HTTPNRClient) ListTabs() ([]TabInfo, error) {
	status, data, err := c.do(http.MethodGet, "/flows", nil)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("GET /flows -> HTTP %d", status)
	}
	var nodes []struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		Label string `json:"label"`
		Info string `json:"info"`
	}
	if err := json.Unmarshal(data, &nodes); err != nil {
		return nil, err
	}
	var tabs []TabInfo
	for _, n := range nodes {
		if n.Type == "tab" {
			tabs = append(tabs, TabInfo{ID: n.ID, Label: n.Label, Info: n.Info})
		}
	}
	return tabs, nil
}

func truncate(b []byte) string {
	s := string(b)
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}
