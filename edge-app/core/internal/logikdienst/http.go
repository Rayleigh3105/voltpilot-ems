package logikdienst

// The HTTP face of the service, shaped like flowc (edge-app/nodered/flowc/
// serve.js) so the API's client follows the same seam:
//
//   POST /pruefe   {text, anlage?, registry?}     -> 200 {kanonisch, bericht}
//                                                 |  422 {message}           (unreadable)
//   POST /artefakt {text, anlage?, registry?, flow_id, flow_version, compiled_at?, site?,
//                   armed?, settings?: {revision, values}, settings_keep_fitting?}
//                                                 -> 200 {artifact, bericht, settings?, verworfen?}
//                                                 |  422 {message, bericht?} (unreadable or blocked)
//                                                 |  422 {message, grund: "stellwerte"} (set values do not fit)
//   GET  /health                                  -> 200 {status, version, sprache}
//   anything malformed                            -> 400 {message}

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
)

// maxBody bounds a request: the text plus slack for the envelope.
const maxBody = MaxTextBytes + 64*1024

// Handler serves the service.
func Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		schreibe(w, http.StatusOK, map[string]any{"status": "ok", "version": Version, "sprache": 1})
	})
	mux.HandleFunc("POST /pruefe", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Text     string          `json:"text"`
			Anlage   Anlage          `json:"anlage"`
			Registry json.RawMessage `json:"registry"`
		}
		if !lies(w, r, &req) {
			return
		}
		g, err := Pruefe([]byte(req.Text), req.Anlage, req.Registry)
		if err != nil {
			antworteFehler(w, err, nil)
			return
		}
		schreibe(w, http.StatusOK, map[string]any{"kanonisch": string(g.Kanonisch), "bericht": g.Bericht})
	})
	mux.HandleFunc("POST /artefakt", func(w http.ResponseWriter, r *http.Request) {
		var req Auftrag
		if !lies(w, r, &req) {
			return
		}
		art, bericht, gebaut, err := ArtefaktMitWerten(req)
		if err != nil {
			antworteFehler(w, err, bericht)
			return
		}
		slog.Info("logik-dienst: Artefakt gebaut", "flow_id", req.FlowID, "flow_version", req.FlowVersion,
			"name", bericht.Name, "scharf", req.Armed)
		antwort := map[string]any{"artifact": art, "bericht": bericht}
		if gebaut.Settings != nil {
			antwort["settings"] = gebaut.Settings
		}
		if len(gebaut.Verworfen) > 0 {
			antwort["verworfen"] = gebaut.Verworfen
		}
		schreibe(w, http.StatusOK, antwort)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		schreibe(w, http.StatusNotFound, map[string]any{"message": "Nicht gefunden"})
	})
	return mux
}

func lies(w http.ResponseWriter, r *http.Request, ziel any) bool {
	roh, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		schreibe(w, http.StatusBadRequest, map[string]any{"message": "Anfrage zu groß oder nicht lesbar"})
		return false
	}
	if err := json.Unmarshal(roh, ziel); err != nil {
		schreibe(w, http.StatusBadRequest, map[string]any{"message": "Anfrage ist kein gültiges JSON"})
		return false
	}
	return true
}

func antworteFehler(w http.ResponseWriter, err error, bericht *Bericht) {
	switch {
	case errors.Is(err, ErrAuftrag):
		schreibe(w, http.StatusBadRequest, map[string]any{"message": err.Error()})
	case errors.Is(err, ErrUnlesbar):
		schreibe(w, http.StatusUnprocessableEntity, map[string]any{"message": err.Error()})
	case errors.Is(err, ErrStellwerte):
		schreibe(w, http.StatusUnprocessableEntity, map[string]any{"message": err.Error(), "grund": "stellwerte"})
	case errors.Is(err, ErrSperrt):
		schreibe(w, http.StatusUnprocessableEntity, map[string]any{"message": err.Error(), "bericht": bericht})
	default:
		slog.Error("logik-dienst: interner Fehler", "err", err)
		schreibe(w, http.StatusInternalServerError, map[string]any{"message": "Interner Fehler"})
	}
}

func schreibe(w http.ResponseWriter, status int, doc any) {
	raw, err := json.Marshal(doc)
	if err != nil {
		status, raw = http.StatusInternalServerError, []byte(`{"message":"Interner Fehler"}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
