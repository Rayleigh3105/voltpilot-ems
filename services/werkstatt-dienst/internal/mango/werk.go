package mango

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/box"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// Die Web-Schnittstelle der GL-Werksfirmware (Befund PS-1, docs/runbook.md):
// Ab 4.3.30 schaltet die Werksfirmware Dropbear ab, bis jemand sie einrichtet
// (uci-defaults/80_nginx-oui: dropbear.enable=0, solange oui-httpd.main.inited
// fehlt). Eingerichtet wird sie über JSON-RPC an http://192.168.8.1/rpc, ohne
// Anmeldung: ui.check_initialized sagt Fassung und Zustand, ui.init setzt das
// root-Passwort (/bin/passwd), merkt sich die Einrichtung und schaltet
// Dropbear ein. Die 3.x-Firmware hat statt /rpc /cgi-bin/api/router/hello und
// lässt SSH ab Werk zu.

// Werk ist, was die Web-Schnittstelle der Werksfirmware über sich sagt.
type Werk struct {
	// RPC: Die Schnittstelle der 4.x-Firmware (/rpc) hat geantwortet.
	RPC          bool
	Eingerichtet bool   // ui.check_initialized: initialized
	Fassung      string // firmware_version (/etc/glversion)
	Modell       string
	// Text ist der Beleg: welche Schnittstelle was gesagt hat.
	Text string
}

// rpcFehler ist ein JSON-RPC-Fehler der Werksfirmware.
type rpcFehler struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcFehler) Error() string { return fmt.Sprintf("JSON-RPC %d %s", e.Code, e.Message) }

// rpcZugriff ist ERROR_CODE_ACCESS der Werksfirmware: ui.init an einer schon
// eingerichteten Mango.
const rpcZugriff = -32000

func werkClient(weg box.Weg) (*http.Client, func()) {
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return weg.Dial(ctx, netip.AddrPortFrom(WerksAdresse, 80))
	}, DisableKeepAlives: true}
	cl := &http.Client{Transport: tr, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return cl, tr.CloseIdleConnections
}

// rpc ruft ui.<methode> der Werksfirmware ohne Sitzung auf und gibt result.
// Der Fehlertext nennt nie die Parameter (ui.init trägt das Passwort).
func rpc(ctx context.Context, weg box.Weg, methode string, params map[string]string) (json.RawMessage, error) {
	if params == nil {
		params = map[string]string{}
	}
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "call", "params": []any{"", "ui", methode, params}})
	if err != nil {
		return nil, err
	}
	cl, zu := werkClient(weg)
	defer zu()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://192.168.8.1/rpc", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := cl.Do(req)
	if err != nil {
		return nil, errors.New(geheim.Schwaerze(err.Error()))
	}
	defer resp.Body.Close()
	text, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, kurz(strings.TrimSpace(geheim.Schwaerze(string(text))), 120))
	}
	var a struct {
		Result json.RawMessage `json:"result"`
		Error  *rpcFehler      `json:"error"`
	}
	if err := json.Unmarshal(text, &a); err != nil {
		return nil, fmt.Errorf("keine JSON-RPC-Antwort: %s", kurz(strings.TrimSpace(geheim.Schwaerze(string(text))), 120))
	}
	if a.Error != nil {
		return nil, a.Error
	}
	return a.Result, nil
}

// FrageWerk fragt die Web-Schnittstelle der Werksfirmware, ohne etwas zu
// ändern: erst ui.check_initialized (4.x), sonst /cgi-bin/api/router/hello
// (3.x). Ein Fehler heißt: keine der beiden hat erkennbar geantwortet.
func FrageWerk(ctx context.Context, weg box.Weg) (Werk, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	res, err := rpc(ctx, weg, "check_initialized", nil)
	if err == nil {
		var c struct {
			Initialized *bool  `json:"initialized"`
			Fassung     string `json:"firmware_version"`
			Modell      string `json:"model"`
		}
		if json.Unmarshal(res, &c) == nil && c.Initialized != nil {
			w := Werk{RPC: true, Eingerichtet: *c.Initialized, Fassung: c.Fassung, Modell: c.Modell}
			zustand := "noch nicht eingerichtet"
			if w.Eingerichtet {
				zustand = "schon eingerichtet"
			}
			w.Text = fmt.Sprintf("GL %s, Modell %s, %s (Web-Schnittstelle /rpc ui.check_initialized)", orNone(w.Fassung), orNone(w.Modell), zustand)
			return w, nil
		}
		err = fmt.Errorf("ui.check_initialized ohne initialized: %s", kurz(string(res), 120))
	}
	hallo, herr := hello(ctx, weg)
	if herr != nil {
		return Werk{Text: "keine Antwort: /rpc " + err.Error() + "; /cgi-bin/api/router/hello " + herr.Error()}, fmt.Errorf("die Web-Schnittstelle der Werksfirmware antwortet nicht erkennbar (/rpc: %v)", err)
	}
	return Werk{Text: "3.x /cgi-bin/api/router/hello: " + hallo}, nil
}

// hello fragt die 3.x-Schnittstelle (ohne Anmeldung).
func hello(ctx context.Context, weg box.Weg) (string, error) {
	cl, zu := werkClient(weg)
	defer zu()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://192.168.8.1/cgi-bin/api/router/hello", nil)
	resp, err := cl.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 400))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return strings.TrimSpace(string(body)), nil
}

// richteWerkEin ruft ui.init mit dem Einmal-Passwort: root bekommt es als
// Passwort, Dropbear startet. Nur die Felder, die ui.init verlangt; das WLAN
// bleibt, wie es ist (sysupgrade -n löscht danach ohnehin alles).
func richteWerkEin(ctx context.Context, weg box.Weg, pw geheim.Geheim) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	_, err := rpc(ctx, weg, "init", map[string]string{"username": "root", "password": pw.Offenbaren(), "lang": "en"})
	return err
}
