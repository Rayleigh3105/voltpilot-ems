// Package web serves the local device web app (the captain's kinderleicht
// UX): open http://<geraet>:8484 in a browser, see the Referenz-ID and the
// pairing state, enter the reference in the portal - done. Read-only for
// MVP; German copy; design-system token values baked into the stylesheet so
// the page is fully self-contained (no CDN, works offline).
package web

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strconv"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/history"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

//go:embed static
var staticFS embed.FS

// InverterController backs the inverter-selection surface: the option catalog,
// the current choice, and applying a new one (which the core persists +
// re-publishes retained on the local bus). The agent implements it.
type InverterController interface {
	InverterCatalog() inverter.Catalog
	GetInverter() (inverter.Selection, bool)
	SetInverter(inverter.SelectionRequest) (inverter.Selection, error)
}

// stateEnvelope is the snapshot the dashboard renders, plus the device clock so
// the browser can compute accurate "vor X" ages and align chart axes even when
// its own clock drifts from the edge device's.
type stateEnvelope struct {
	state.Snapshot
	ServerNowMs int64 `json:"server_now_ms"`
}

func envelope(st *state.Store) stateEnvelope {
	return stateEnvelope{Snapshot: st.Get(), ServerNowMs: time.Now().UnixMilli()}
}

// Handler builds the HTTP mux: the single-page UI, the state JSON it polls, the
// live telemetry history + stream (for the dashboard charts), the
// inverter-selection API, and the health endpoint.
func Handler(st *state.Store, inv InverterController, hist *history.Ring) http.Handler {
	mux := http.NewServeMux()

	sub, _ := fs.Sub(staticFS, "static")
	mux.Handle("/", http.FileServer(http.FS(sub)))

	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(envelope(st))
	})

	// GET /api/history?minutes=N - recent telemetry samples for the charts on
	// first load (default 60 min, clamped to a day). server_now_ms lets the
	// client align its time axis to the device clock.
	mux.HandleFunc("GET /api/history", func(w http.ResponseWriter, r *http.Request) {
		minutes := 60
		if q := r.URL.Query().Get("minutes"); q != "" {
			if n, err := strconv.Atoi(q); err == nil && n > 0 {
				minutes = n
			}
		}
		if minutes > 24*60 {
			minutes = 24 * 60
		}
		now := time.Now()
		writeJSON(w, http.StatusOK, map[string]any{
			"samples":       hist.Recent(time.Duration(minutes)*time.Minute, now),
			"server_now_ms": now.UnixMilli(),
		})
	})

	// GET /api/stream - Server-Sent Events pushing live device state and new
	// telemetry samples, so the dashboard updates without polling. Robust and
	// dependency-free: an internal 1 s tick forwards any samples that arrived
	// since the last one and re-sends the state snapshot.
	mux.HandleFunc("GET /api/stream", func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-store")
		h.Set("Connection", "keep-alive")
		h.Set("X-Accel-Buffering", "no") // disable proxy buffering if one is ever in front

		send := func(event string, v any) bool {
			b, err := json.Marshal(v)
			if err != nil {
				return true
			}
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b); err != nil {
				return false
			}
			flusher.Flush()
			return true
		}

		ctx := r.Context()
		// Only stream samples that arrive after we connect; the client fetches
		// the backlog via /api/history first.
		last := time.Now()
		send("state", envelope(st))

		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				for _, s := range hist.Since(last) {
					if !send("sample", s) {
						return
					}
					last = s.Ts
				}
				if !send("state", envelope(st)) {
					return
				}
			}
		}
	})

	// GET /api/inverter - the option catalog + the current selection (if any),
	// so the config page can render the form and show what is configured.
	mux.HandleFunc("GET /api/inverter", func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{"catalog": inv.InverterCatalog()}
		if sel, ok := inv.GetInverter(); ok {
			resp["selection"] = sel
		} else {
			resp["selection"] = nil
		}
		writeJSON(w, http.StatusOK, resp)
	})

	// POST /api/inverter - apply a new selection. Validation failures return
	// 400 with a German message the UI shows inline.
	mux.HandleFunc("POST /api/inverter", func(w http.ResponseWriter, r *http.Request) {
		var req inverter.SelectionRequest
		body, _ := io.ReadAll(io.LimitReader(r.Body, 16<<10))
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Ungültige Anfrage."})
			return
		}
		sel, err := inv.SetInverter(req)
		if err != nil {
			var ve *inverter.ValidationError
			if errors.As(err, &ve) {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": ve.Msg})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "Auswahl konnte nicht gespeichert werden."})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"selection": sel})
	})

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		snap := st.Get()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":          "UP",
			"ref":             snap.Ref,
			"pairing_state":   snap.PairingState,
			"cloud_connected": snap.CloudConnected,
			"uptime_seconds":  int(time.Since(snap.StartedAt).Seconds()),
		})
	})

	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
