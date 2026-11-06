package layer1

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/kostaldxs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// Classic KOSTAL PIKO over its local Web-API `/api/dxs.json`: the Go twin of
// the flow's "KOSTAL PIKO (Web-API) lesen" node on top of
// kostal-dxs-decode.js. ONE bundled GET per cycle (report §4.6) - FastIDs
// alone for the regular tick (the live precedent: the customer's legacy
// system reads exactly one id every 5 s), AllIDs (+ identity) for
// "Verbindung testen". Read only - `/api/dxs.json` has no documented write
// path.

// DefaultKostalDxsTimeout bounds one GET (report §4.6: 3-4 s, not go-e's 8 s,
// so a 5-s poll tick never stacks two requests against the weak webserver).
const DefaultKostalDxsTimeout = 4 * time.Second

var errKostalDxsBadResponse = errors.New("kostal dxs: ungueltige Antwort")

// getDxs runs one GET against `/api/dxs.json` and returns the decoded
// result. A transport error (dial/timeout/HTTP status/body) is returned as
// is for the caller to classify; a parseable-but-empty answer is (nil, nil).
func (r *Runtime) getDxs(ctx context.Context, p *kostalDxsPlan, ids []int) (*kostaldxs.Result, error) {
	rctx, cancel := context.WithTimeout(ctx, r.opts.KostalDxsTimeout)
	defer cancel()
	url := kostaldxs.DxsURL("http", p.IP, p.Port, ids)
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := r.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxHTTPBody))
		return nil, errHTTPStatus
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxHTTPBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxHTTPBody {
		return nil, errBodyTooLarge
	}
	result := kostaldxs.Decode(body)
	if result == nil {
		return nil, errKostalDxsBadResponse
	}
	return result, nil
}

// pollKostalDxs is one tick of the self-wiring poll.
func (r *Runtime) pollKostalDxs(ctx context.Context, p *kostalDxsPlan) {
	release, ok := r.lanes.tryAcquire(p.Addr)
	if !ok {
		r.log.Debug("PIKO (Web-API) belegt - Lesen uebersprungen", "ziel", p.Addr)
		return
	}
	defer release()

	res, err := r.getDxs(ctx, p, kostaldxs.PollIDs)
	if err != nil {
		r.noteError(p.Addr, "KOSTAL PIKO (Web-API): keine Antwort/ungueltige Antwort: "+err.Error())
		return
	}
	if len(res.Reading) == 0 {
		r.noteError(p.Addr, "KOSTAL PIKO (Web-API): keine AC-Leistung in der Antwort")
		return
	}
	r.publishTelemetry(p.Addr, telemetryFrom(res.Reading, nil, "", r.opts.Now()))
}

// testKostalDxs is "Verbindung testen" for the Web-API path: reads AllIDs in
// one bundled GET and names type/UI-Fassung/Seriennummer/Status in Message
// for the Sichtpruefung, in addition to the canonical Reading.
func (r *Runtime) testKostalDxs(ctx context.Context, p *kostalDxsPlan, role string) testReadResult {
	release, ok := r.lanes.acquire(ctx, p.Addr, r.opts.LaneWait)
	if !ok {
		return testReadResult{ErrorCode: testconn.ErrNoAnswer,
			Message: "Das Gerät ist gerade mit einer anderen Abfrage beschäftigt - bitte gleich noch einmal testen."}
	}
	defer release()

	res, err := r.getDxs(ctx, p, kostaldxs.AllIDs)
	switch {
	case errors.Is(err, errKostalDxsBadResponse):
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse,
			Message: "Die Antwort ist kein brauchbares /api/dxs.json (kein JSON oder kein dxsEntries-Array). Ist unter dieser IP wirklich ein KOSTAL-PIKO-Webserver (UI ab 06) erreichbar?"}
	case errors.Is(err, errHTTPStatus), errors.Is(err, errBodyTooLarge):
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse}
	case isTimeout(err):
		return testReadResult{ErrorCode: testconn.ErrNoAnswer}
	case err != nil:
		return testReadResult{ErrorCode: testconn.ErrUnreachable}
	}
	if len(res.Reading) == 0 {
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse,
			Message: "Keine AC-Leistung (dxs 67109120) in der Antwort."}
	}
	return testReadResult{OK: true, Reading: toTestReading(res.Reading, role), Message: kostalDxsIdentityMessage(res.Meta)}
}

// kostalDxsIdentityMessage names Typ/UI-Fassung/Seriennummer/Status for the
// connection test's Sichtpruefung (report E4: "prueft ... Typ, UI-Fassung").
func kostalDxsIdentityMessage(m kostaldxs.Meta) string {
	var parts []string
	if m.Type != "" {
		parts = append(parts, "Typ: "+m.Type)
	}
	if m.UiVersion != "" {
		parts = append(parts, "UI "+m.UiVersion)
	}
	if m.FwVersion != "" {
		parts = append(parts, "FW "+m.FwVersion)
	}
	if m.Serial != "" {
		parts = append(parts, "Seriennummer "+m.Serial)
	}
	if m.StatusText != "" {
		parts = append(parts, "Status: "+m.StatusText)
	}
	if m.LimitationPct != nil && *m.LimitationPct < 100 {
		parts = append(parts, "Abregelung auf "+strconv.FormatFloat(*m.LimitationPct, 'f', -1, 64)+" %")
	}
	return strings.Join(parts, " · ")
}
