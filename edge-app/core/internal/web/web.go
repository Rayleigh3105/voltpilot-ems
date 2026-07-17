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

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/history"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
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
	// TestConnection reads an UNSAVED connection form once and returns the
	// decoded values or a classified error. It serves BOTH the inverter form and
	// the add-source drawer (they share the brand/model/connection shape) and
	// never persists anything - it is a confidence check, never a save gate.
	TestConnection(testconn.Request) testconn.Result
	// ProbeUnits scans the form's address for FURTHER SunSpec inverter unit ids
	// (multi-inverter at one Fronius Datamanager: inverter number = unit id).
	// Bounded + read-only; fronius_sunspec only. The UI uses the result to say
	// "An dieser Adresse wurden N Wechselrichter gefunden" and OFFER creating a
	// source per found unit - never a silent auto-add.
	ProbeUnits(testconn.Request) testconn.Result
}

// SourcesController backs the "Energiequellen" surface: the ADDITIONAL read-only
// measurement points (Phase 1: Erzeuger/PV) a site has beyond its one
// battery-hybrid inverter. The agent implements it; adding/removing a source
// re-publishes the retained edge/sources/config and widens the physical
// envelope. Read-only by construction - a source never gets a control path.
type SourcesController interface {
	ListSources() []sources.Source
	// SourceStatuses maps each source id to its live delivery status
	// ("ok"|"warn"|"pending"), so the web app can show a status dot per source.
	SourceStatuses() map[string]string
	// SourceLastReadings maps each source id to its most recent accepted
	// reading (per-channel value + receive time) for the "Zuletzt gelesen"
	// line; a source that never delivered is absent from the map.
	SourceLastReadings() map[string]sources.LastReading
	AddSource(sources.Request) (sources.Source, error)
	DeleteSource(id string) error
	// Balance settings: the operator-declared "primary grid CT measures the
	// whole site connection" toggle rendered in the Netz-Zähler group (it is
	// the meter-less alternative for the true house consumption). Persisted +
	// applied live by the agent.
	GetBalance() sources.BalanceSettings
	SetBalance(sources.BalanceSettings) (sources.BalanceSettings, error)
}

// PurgeController backs the "Datenaufzeichnungen löschen" action: wipe the
// device-local recordings and request the cloud-side purge (queued while
// offline). The agent implements it.
type PurgeController interface {
	PurgeRecordedData() (state.DataPurgeInfo, error)
}

// PlanController exposes the cached battery-dispatch plan for the local
// Fahrplan view: the slots, freshness and the executing slot. Read-only. The
// agent implements it.
type PlanController interface {
	CurrentPlan() (plan.View, bool)
}

// DespikeController backs the "Ausreißer-Filter" settings surface: read the
// current per-channel filter configuration + drop counters, and apply a new
// one (which the core persists + applies live). The agent implements it.
type DespikeController interface {
	GetDespike() guards.DespikeStatus
	SetDespike(guards.DespikeSettings) (guards.DespikeStatus, error)
}

// stateEnvelope is the snapshot the dashboard renders, plus the device clock so
// the browser can compute accurate "vor X" ages and align chart axes even when
// its own clock drifts from the edge device's, plus the derived onboarding-gate
// signals the guided two-step onboarding needs.
type stateEnvelope struct {
	state.Snapshot
	ServerNowMs int64 `json:"server_now_ms"`

	// InverterConnected is the gate for the portal-claim step: an inverter is
	// configured AND at least one telemetry reading has arrived (the inverter is
	// proven to actually deliver data). Only then may the customer claim the
	// device in the portal.
	InverterConnected bool `json:"inverter_connected"`
	// OnboardingStep is the current guided step: "inverter" (connect the
	// inverter first), "claim" (inverter delivers data -> claim in the portal),
	// or "done" (device already claimed/paired - onboarding no longer governs).
	OnboardingStep string `json:"onboarding_step"`
	// ClaimUnlocked is true once the reference may be shown (gate satisfied or
	// the device is already paired). While false the reference is withheld from
	// the envelope entirely so the UI cannot accidentally reveal it (the
	// belt-and-suspenders half of the enforcement).
	ClaimUnlocked bool `json:"claim_unlocked"`
}

// paired reports whether a certificate is already on disk (the device is
// claimed), mirroring the frontend's step derivation: any post-claim pairing
// state counts, including the transient cloud-error/disconnect states.
// geraet_entfernt (removed/unclaimed in the cloud) is DELIBERATELY not paired:
// a cert is still on disk, but the claim mapping is gone - the onboarding gate
// re-opens the portal step (revealing the reference once the inverter delivers
// data) so the customer can re-claim.
func paired(pairingState string) bool {
	switch pairingState {
	case "verbunden", "zertifikat_erhalten", "cloud_getrennt", "cloud_fehler":
		return true
	}
	return false
}

// deriveOnboarding computes the gate signals from a snapshot: the inverter is
// "connected" only when it is configured AND has delivered at least one reading.
func deriveOnboarding(snap state.Snapshot) (step string, inverterConnected, claimUnlocked bool) {
	inverterConfigured := snap.Inverter != nil && snap.Inverter.Configured
	inverterConnected = inverterConfigured && !snap.LastTelemetry.IsZero()
	switch {
	case paired(snap.PairingState):
		return "done", inverterConnected, true
	case inverterConnected:
		return "claim", inverterConnected, true
	default:
		return "inverter", inverterConnected, false
	}
}

func envelope(st *state.Store) stateEnvelope {
	snap := st.Get()
	step, invConnected, claimUnlocked := deriveOnboarding(snap)
	// Withhold the reference until the claim step is unlocked, so the portal
	// reference cannot leak into the UI before the inverter is proven to work.
	// The device's own enrollment uses the ref from its config, not this
	// envelope, so this never blocks the background key/CSR/cert handshake.
	if !claimUnlocked {
		snap.Ref = ""
	}
	return stateEnvelope{
		Snapshot:          snap,
		ServerNowMs:       time.Now().UnixMilli(),
		InverterConnected: invConnected,
		OnboardingStep:    step,
		ClaimUnlocked:     claimUnlocked,
	}
}

// Handler builds the HTTP mux: the single-page UI, the state JSON it polls, the
// live telemetry history + stream (for the dashboard charts), the cached
// dispatch plan (Fahrplan view), the inverter-selection API, the data-purge
// action, and the health endpoint.
func Handler(st *state.Store, inv InverterController, purge PurgeController,
	despike DespikeController, hist *history.Ring, pl PlanController,
	src SourcesController) http.Handler {
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

	// GET /api/plan - the cached battery-dispatch plan for the Fahrplan view:
	// the slots (setpoint + optional planned curtailment), freshness against the
	// contract's 20-min staleness window, the executing slot, and the live
	// guard-clamped current setpoint/mode (from state) so the section is
	// self-contained. has_plan=false with no "plan" key = no plan received yet
	// (the UI shows the honest empty state). Read-only; never drives execution.
	mux.HandleFunc("GET /api/plan", func(w http.ResponseWriter, r *http.Request) {
		snap := st.Get()
		resp := map[string]any{
			"server_now_ms": time.Now().UnixMilli(),
			"mode":          snap.Mode,
			"setpoint_kw":   snap.SetpointKw,
		}
		if !snap.SlotStart.IsZero() {
			resp["slot_start"] = snap.SlotStart
		}
		if view, ok := pl.CurrentPlan(); ok {
			resp["has_plan"] = true
			resp["plan"] = view
		} else {
			resp["has_plan"] = false
		}
		writeJSON(w, http.StatusOK, resp)
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

	// POST /api/test-connection - "Verbindung testen": read an UNSAVED
	// connection form ONCE and return the decoded values or a classified error.
	// Serves both the inverter form and the add-source drawer. Never persists;
	// never a save gate. Always HTTP 200 (the outcome, incl. failures, is in the
	// JSON body) except on a malformed request body.
	mux.HandleFunc("POST /api/test-connection", func(w http.ResponseWriter, r *http.Request) {
		var req testconn.Request
		body, _ := io.ReadAll(io.LimitReader(r.Body, 16<<10))
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Ungültige Anfrage."})
			return
		}
		writeJSON(w, http.StatusOK, inv.TestConnection(req))
	})

	// POST /api/probe-units - multi-inverter auto-detection: scan the (unsaved)
	// fronius_sunspec connection's address for further inverter unit ids
	// (Fronius Datamanager: inverter number = Modbus unit id). Read-only and
	// bounded; the UI offers to create a source per found unit, the operator
	// confirms. Same body shape and always-200 semantics as test-connection.
	mux.HandleFunc("POST /api/probe-units", func(w http.ResponseWriter, r *http.Request) {
		var req testconn.Request
		body, _ := io.ReadAll(io.LimitReader(r.Body, 16<<10))
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Ungültige Anfrage."})
			return
		}
		writeJSON(w, http.StatusOK, inv.ProbeUnits(req))
	})

	// GET /api/sources - the ADDITIONAL read-only measurement points (Phase 1:
	// Erzeuger/PV) plus the SAME option catalog the inverter form uses, so the
	// "Energiequelle hinzufügen" form is fully data-driven off one endpoint.
	mux.HandleFunc("GET /api/sources", func(w http.ResponseWriter, r *http.Request) {
		list := src.ListSources()
		if list == nil {
			list = []sources.Source{}
		}
		statuses := src.SourceStatuses()
		if statuses == nil {
			statuses = map[string]string{}
		}
		readings := src.SourceLastReadings()
		if readings == nil {
			readings = map[string]sources.LastReading{}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"sources":  list,
			"statuses": statuses,
			// readings carries each source's last accepted value + read time
			// ("Zuletzt gelesen"); server_now_ms lets the page compute an honest
			// "vor X" age against the DEVICE clock, browser skew notwithstanding.
			"readings":      readings,
			"server_now_ms": time.Now().UnixMilli(),
			"catalog":       inv.InverterCatalog(),
			"balance":       src.GetBalance(),
		})
	})

	// POST /api/balance - the site power-balance settings (today the single
	// expert OPT-OUT "Die Netzmessung des Wechselrichters sitzt NICHT am
	// Hausanschluss" from the default-on house-consumption standard). Persisted
	// and applied live; a dedicated Netz meter always takes precedence, so
	// flipping it can never override a working meter.
	mux.HandleFunc("POST /api/balance", func(w http.ResponseWriter, r *http.Request) {
		var req sources.BalanceSettings
		body, _ := io.ReadAll(io.LimitReader(r.Body, 16<<10))
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Ungültige Anfrage."})
			return
		}
		cfg, err := src.SetBalance(req)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "Einstellung konnte nicht gespeichert werden."})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"balance": cfg})
	})

	// POST /api/sources - add an additional Erzeuger source (master data only, no
	// device claim). Validation failures return 400 with a German message.
	mux.HandleFunc("POST /api/sources", func(w http.ResponseWriter, r *http.Request) {
		var req sources.Request
		body, _ := io.ReadAll(io.LimitReader(r.Body, 16<<10))
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Ungültige Anfrage."})
			return
		}
		s, err := src.AddSource(req)
		if err != nil {
			var ve *sources.ValidationError
			if errors.As(err, &ve) {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": ve.Msg})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "Energiequelle konnte nicht gespeichert werden."})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"source": s})
	})

	// DELETE /api/sources/{id} - remove an additional source. Unknown id -> 404.
	mux.HandleFunc("DELETE /api/sources/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := src.DeleteSource(id); err != nil {
			if errors.Is(err, sources.ErrNotFound) {
				writeJSON(w, http.StatusNotFound, map[string]any{"error": "Energiequelle nicht gefunden."})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "Energiequelle konnte nicht entfernt werden."})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	// GET /api/despike - the "Ausreißer-Filter" configuration: the current
	// per-channel settings, the running drop counters and the channel/preset
	// metadata (labels/units/help) so the settings page is fully data-driven.
	mux.HandleFunc("GET /api/despike", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, despike.GetDespike())
	})

	// POST /api/despike - apply a new filter configuration (a named preset, or a
	// custom per-channel set). Validation failures return 400 with a German
	// message the UI shows inline; on success the new configuration is persisted
	// and applied live (no restart), and the updated status is returned.
	mux.HandleFunc("POST /api/despike", func(w http.ResponseWriter, r *http.Request) {
		var req guards.DespikeSettings
		body, _ := io.ReadAll(io.LimitReader(r.Body, 16<<10))
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Ungültige Anfrage."})
			return
		}
		status, err := despike.SetDespike(req)
		if err != nil {
			var ve *guards.SettingsValidationError
			if errors.As(err, &ve) {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": ve.Msg})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "Einstellungen konnten nicht gespeichert werden."})
			return
		}
		writeJSON(w, http.StatusOK, status)
	})

	// POST /api/purge-data - "Datenaufzeichnungen löschen": wipe the device's
	// local recordings immediately and request the cloud-side purge (queued and
	// re-sent on connect while the device is offline). The UI guards this
	// behind an explicit typed confirmation; the endpoint itself is idempotent.
	mux.HandleFunc("POST /api/purge-data", func(w http.ResponseWriter, r *http.Request) {
		info, err := purge.PurgeRecordedData()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError,
				map[string]any{"error": "Die Aufzeichnungen konnten nicht gelöscht werden. Bitte versuchen Sie es erneut."})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data_purge": info})
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
