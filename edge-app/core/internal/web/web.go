// Package web serves the local device web app (the captain's kinderleicht
// UX): open http://<geraet>:8484 in a browser, see the Referenz-ID and the
// pairing state, enter the reference in the portal - done. Read-only for
// MVP; German copy; design-system token values baked into the stylesheet so
// the page is fully self-contained (no CDN, works offline).
package web

import (
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

//go:embed static
var staticFS embed.FS

// Handler builds the HTTP mux: the single-page UI, the state JSON it polls,
// and the health endpoint.
func Handler(st *state.Store) http.Handler {
	mux := http.NewServeMux()

	sub, _ := fs.Sub(staticFS, "static")
	mux.Handle("/", http.FileServer(http.FS(sub)))

	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(st.Get())
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
