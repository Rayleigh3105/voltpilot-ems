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
	"io"
	"io/fs"
	"net/http"
	"time"

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

// Handler builds the HTTP mux: the single-page UI, the state JSON it polls,
// the inverter-selection API, and the health endpoint.
func Handler(st *state.Store, inv InverterController) http.Handler {
	mux := http.NewServeMux()

	sub, _ := fs.Sub(staticFS, "static")
	mux.Handle("/", http.FileServer(http.FS(sub)))

	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(st.Get())
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
