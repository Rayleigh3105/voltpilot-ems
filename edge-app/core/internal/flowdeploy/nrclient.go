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

// NRClient is the slice of the Node-RED Admin API the deployer needs.
//
// Deployment goes through the GLOBAL /flows endpoint, NOT the per-flow API:
// POST /flow IGNORES client-supplied flow ids (the runtime always generates
// one - caught live by the September-Gate rig: the tab landed under a
// generated id and the deployer's own not-in-set sweep removed it again).
// The full-config roundtrip preserves OUR deterministic tab ids, which is
// what makes "redeploy replaces instead of duplicating" (flow-artifact.md §2)
// actually hold; the 'flows' deployment type restarts only changed flows, so
// vendor tabs keep running untouched.
type NRClient interface {
	// PaletteVersion returns the installed @voltpilot/node-red-vp-palette
	// version (GET /nodes) - the source of truth for the min_palette_version
	// gate, live from the runtime instead of a hand-maintained env.
	PaletteVersion() (string, error)
	// GetFlows returns the full flow configuration (node array, v1 API).
	GetFlows() ([]json.RawMessage, error)
	// PostFlows replaces the full flow configuration with deployment type
	// 'flows' (only modified flows restart).
	PostFlows(flows []json.RawMessage) error
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
func (c *HTTPNRClient) do(method, path string, body []byte, extra map[string]string) (int, []byte, error) {
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
		// Node-RED content-negotiates several admin endpoints (GET /nodes
		// serves an HTML/script bundle without this - caught live by the
		// September-Gate rig): always ask for JSON.
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		for k, v := range extra {
			req.Header.Set(k, v)
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
	status, data, err := c.do(http.MethodGet, "/nodes", nil, nil)
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

// GetFlows implements NRClient (v1 API: the plain node array).
func (c *HTTPNRClient) GetFlows() ([]json.RawMessage, error) {
	status, data, err := c.do(http.MethodGet, "/flows", nil, nil)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("GET /flows -> HTTP %d", status)
	}
	var nodes []json.RawMessage
	if err := json.Unmarshal(data, &nodes); err != nil {
		// v2-format response ({rev, flows}) - tolerate it.
		var v2 struct {
			Flows []json.RawMessage `json:"flows"`
		}
		if err2 := json.Unmarshal(data, &v2); err2 != nil || v2.Flows == nil {
			return nil, err
		}
		nodes = v2.Flows
	}
	return nodes, nil
}

// PostFlows implements NRClient (v1 API, deployment type 'flows').
func (c *HTTPNRClient) PostFlows(flows []json.RawMessage) error {
	if flows == nil {
		flows = []json.RawMessage{}
	}
	body, err := json.Marshal(flows)
	if err != nil {
		return err
	}
	status, data, err := c.do(http.MethodPost, "/flows", body,
		map[string]string{"Node-RED-Deployment-Type": "flows"})
	if err != nil {
		return err
	}
	if status != http.StatusOK && status != http.StatusNoContent {
		return fmt.Errorf("POST /flows -> HTTP %d: %s", status, truncate(data))
	}
	return nil
}

func truncate(b []byte) string {
	s := string(b)
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}
