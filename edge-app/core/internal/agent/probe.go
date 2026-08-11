package agent

// Probe-Kanal (Einheitsmodell Stufe 0b, Kontrakt
// docs/contracts/mqtt-probe.schema.json): die Cloud bittet die Box, ein Geraet
// im KUNDEN-LAN einmal zu lesen, und bekommt Roh- und dekodierten Wert zurueck -
// der Unterbau, aus dem spaeter jede Live-Vorschau des Anlege-Assistenten lebt.
//
// Diese Datei ist ausschliesslich die VERDRAHTUNG. Jede Regel, die eine Probe
// verhindern kann, liegt in `internal/probe` und ist ohne Socket, ohne Bus und
// ohne Uhr pruefbar (das otaapply/calibration/curtailcal-Muster); die
// eigentliche Lesung fuehrt Node-RED aus, weil dort die Socket-Disziplin wohnt
// (`lib/modbus-conn.js`: EIN Socket je (host, port) ueber alle Leser hinweg).
//
// ⚠ Der Core oeffnet hier bewusst KEINEN eigenen Modbus-Socket. Viele
// Kundengeraete (Solarman-Logger, billige Gateways) bedienen genau einen
// TCP-Client und verdraengen den laufenden. Eine Vorschau, die sich ihre eigene
// Verbindung nimmt, waere deshalb nicht „eine Lesung mehr", sondern der
// Abbruch des Polls genau des Geraets, auf das der Kunde gerade schaut. Der
// Umweg ueber den lokalen Bus IST die Einhaltung der Warteschlange.
//
// Was NICHT beantwortet wird, und warum: eine Anfrage mit fremder Identitaet
// und eine verfallene Anfrage werden STUMM verworfen (laut nur im Protokoll) -
// eine Antwort auf eine fremde Identitaet bestaetigte einem falsch adressierten
// Absender die Existenz dieses Geraets, und eine Antwort auf eine verfallene
// Anfrage erreicht niemanden mehr (die Portal-Route hat laengst aufgegeben).
// Eine Ratenbegrenzung dagegen WIRD beantwortet: sie ist unsere Entscheidung,
// nicht die des Geraets, und der Assistent muss sagen koennen, warum gerade
// nichts kommt.

import (
	"encoding/json"
	"log/slog"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

// probeExchangeTimeout bounds ONE probe's local-bus round trip. It is wider
// than the portal's own wait (~5 s) on purpose: a slow device should still be
// read to the end, and an answer that arrives after the portal gave up is
// simply dropped by the cloud's correlation (it is not a failure, just late).
// Narrower than the connection manager's worst case, so the box can never sit
// on an open probe for a minute. A var so tests can shorten it.
var probeExchangeTimeout = 15 * time.Second

// probeWindow is how long a request stays executable, counted from its OWN
// `requested_at`. A var so tests can shorten it.
var probeWindow = probe.DefaultWindow

// Modbus function codes as the palette node expects them (`fc` on the local-bus
// op). Kept as plain numbers here: the core has no Modbus codec and must not
// grow one for two constants.
const (
	probeFnReadHolding = 3
	probeFnReadInput   = 4
)

// probeBusOp is one already-validated read step as it goes down the local bus.
// It deliberately carries NO scale/offset: those are DISPLAY arithmetic and
// stay in one place (probe.Op.Scaled here in the core), so the node reads
// registers and nothing else.
type probeBusOp struct {
	ID        string `json:"id"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	UnitID    int    `json:"unit_id"`
	FC        int    `json:"fc"`
	Address   int    `json:"address"`
	DataType  string `json:"data_type"`
	WordOrder string `json:"word_order"`
}

type probeBusRequest struct {
	RequestID string       `json:"request_id"`
	Ops       []probeBusOp `json:"ops"`
}

// probeBusResult is one answered read step coming back from Node-RED.
type probeBusResult struct {
	ID        string   `json:"id"`
	OK        bool     `json:"ok"`
	Raw       *float64 `json:"raw"`
	Registers []int    `json:"registers"`
	ErrorCode string   `json:"error_code"`
	Message   string   `json:"message"`
}

type probeBusResponse struct {
	RequestID string           `json:"request_id"`
	Results   []probeBusResult `json:"results"`
}

// onProbeRequest is the cloud link's handler. It runs the CHEAP gate here and
// hands the rest to its own goroutine.
//
// ⚠ That split is not tidiness, it is required: the link is configured with
// paho's SetOrderMatters(true), so incoming messages are dispatched
// SEQUENTIALLY on one router goroutine. Blocking here for the length of a
// local-bus round trip would stall EVERY other downlink for that time - the
// plan, the entity registry, the flow deployment, the OTA assignment, the
// one-shot apply approval. A preview must never be able to do that.
//
// What stays synchronous is exactly what costs nothing and must not spawn
// anything: parsing, the identity and expiry checks, and the rate limit. So a
// malformed, foreign, expired or throttled request never starts a goroutine at
// all, and the limiter doubles as the bound on how many can ever be in flight.
func (a *Agent) onProbeRequest(payload []byte) {
	now := time.Now()
	req, err := probe.Parse(payload)
	if err != nil {
		slog.Warn("Probe: Anfrage verworfen", "grund", err.Error())
		return
	}

	a.entMu.Lock()
	ident := a.entIdentity
	a.entMu.Unlock()
	id := probe.Identity{
		TenantID: ident.TenantID, SiteID: ident.SiteID, DeviceID: ident.DeviceID,
	}
	if !req.Matches(id) {
		// Bewusst OHNE die gemeldete Kennung im Klartext-Vergleich: das Geraet
		// nennt nur, DASS es nicht passt.
		slog.Warn("Probe: Anfrage meint ein anderes Geraet - verworfen")
		return
	}
	if req.Expired(now, probeWindow) {
		slog.Warn("Probe: verfallene Anfrage verworfen (nachgeliefert?)",
			"request_id", req.RequestID, "requested_at", req.RequestedAt)
		return
	}
	if a.probeLimiter != nil && !a.probeLimiter.Allow(now) {
		slog.Warn("Probe: Ratenbegrenzung greift", "request_id", req.RequestID)
		go a.publishProbeResult(probe.Refused(req, id, now,
			probe.ErrRateLimited, probe.RateLimitedMessage))
		return
	}
	go a.runProbe(req, id)
}

// runProbe executes an ADMITTED probe: per-op admission, the bounded local-bus
// round trip, and the one answer. Off the link's router goroutine (see
// onProbeRequest).
func (a *Agent) runProbe(req probe.Request, id probe.Identity) {
	// Admission per op. The verdicts keep the request's ORDER, so the answer
	// reads like the question - a refused step stays in its place instead of
	// disappearing from the list.
	verdicts := probe.ValidateOps(req.Ops)
	results := make([]probe.OpResult, len(req.Ops))
	busOps := make([]probeBusOp, 0, len(req.Ops))
	index := make(map[string]int, len(req.Ops))
	for i, op := range req.Ops {
		if !verdicts[i].OK() {
			results[i] = probe.Failed(op.ID, verdicts[i].Code, verdicts[i].Message)
			continue
		}
		fc := probeFnReadHolding
		if op.RegisterKind == "input" {
			fc = probeFnReadInput
		}
		index[op.ID] = i
		busOps = append(busOps, probeBusOp{
			ID:        op.ID,
			Host:      op.Host,
			Port:      op.EffectivePort(),
			UnitID:    op.EffectiveUnit(),
			FC:        fc,
			Address:   op.EffectiveAddress(),
			DataType:  op.DataType,
			WordOrder: op.EffectiveWordOrder(),
		})
	}

	if len(busOps) > 0 {
		for _, r := range a.probeExchange(req.RequestID, busOps) {
			i, ok := index[r.ID]
			if !ok {
				continue // an answer to a step we never asked for
			}
			op := req.Ops[i]
			if r.OK && r.Raw != nil {
				results[i] = probe.Succeeded(op.ID, *r.Raw, r.Registers, op.Scaled(*r.Raw))
				continue
			}
			code, msg := r.ErrorCode, r.Message
			if code == "" {
				// The node always names its class; if one ever does not, the
				// honest fallback is the "we do not understand this" bucket -
				// never a fabricated success.
				code, msg = probe.ErrInvalidResponse, "Die Antwort des Geräts war nicht lesbar."
			}
			results[i] = probe.Failed(op.ID, code, msg)
		}
		// Whatever the exchange did not answer at all is a timeout - stated,
		// never left as a zero value that would read like a successful 0.
		for i, op := range req.Ops {
			if verdicts[i].OK() && results[i].ID == "" {
				results[i] = probe.Failed(op.ID, probe.ErrTimeout,
					"Die Prüfung hat nicht rechtzeitig geantwortet.")
			}
		}
	}

	a.publishProbeResult(probe.NewResult(req, id, time.Now(), results))
}

// probeExchange runs ONE correlated request/response round trip over the local
// bus probe topics. It mirrors testReadExchange (the "Verbindung testen"
// machinery) - same correlation, same buffered channel so a late answer can
// never block the bus, same deliberate absence of a retry: a preview that
// missed its window is re-asked by a second click, not by the box.
func (a *Agent) probeExchange(requestID string, ops []probeBusOp) []probeBusResult {
	if a.Bus == nil {
		return nil
	}
	ch := make(chan []probeBusResult, 1)
	a.probeMu.Lock()
	if a.probeReads == nil {
		a.probeReads = map[string]chan []probeBusResult{}
	}
	a.probeReads[requestID] = ch
	a.probeMu.Unlock()
	defer func() {
		a.probeMu.Lock()
		delete(a.probeReads, requestID)
		a.probeMu.Unlock()
	}()

	raw, err := json.Marshal(probeBusRequest{RequestID: requestID, Ops: ops})
	if err != nil {
		return nil
	}
	if err := a.Bus.Publish(localbus.TopicProbeRequest, raw, false); err != nil {
		slog.Warn("Probe: Anfrage konnte nicht auf den lokalen Bus", "err", err)
		return nil
	}
	select {
	case res := <-ch:
		return res
	case <-time.After(probeExchangeTimeout):
		slog.Warn("Probe: keine Antwort vom Lese-Flow", "request_id", requestID)
		return nil
	}
}

// onProbeBusResult routes a probe answer from Node-RED to the waiting handler
// by request id. Unknown/expired ids are dropped (the handler already gave up
// and left); the buffered channel + non-blocking send mean this never blocks
// the bus.
func (a *Agent) onProbeBusResult(_ string, payload []byte) {
	var m probeBusResponse
	if err := json.Unmarshal(payload, &m); err != nil || m.RequestID == "" {
		slog.Warn("Probe: Ergebnis vom Lese-Flow unlesbar; verworfen")
		return
	}
	a.probeMu.Lock()
	ch := a.probeReads[m.RequestID]
	a.probeMu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- m.Results:
	default:
	}
}

// publishProbeResult answers the cloud. Best-effort by nature: the portal route
// is waiting with its own short timeout, so a failed publish is logged and
// nothing is retried - a late duplicate answer would only confuse a correlation
// that has already been dropped.
//
// a.probePublish is the TEST SEAM (the a.goeDoer / otaRoots precedent): nil
// means the real cloud link, so the production path has no branch of its own
// and a test asserts on the CONTRACT BYTES the box would put on the wire.
func (a *Agent) publishProbeResult(res probe.Result) {
	raw, err := json.Marshal(res)
	if err != nil {
		slog.Warn("Probe: Ergebnis nicht serialisierbar", "err", err)
		return
	}
	if a.probePublish != nil {
		if err := a.probePublish(raw); err != nil {
			slog.Warn("Probe: Ergebnis konnte nicht gesendet werden",
				"request_id", res.RequestID, "err", err)
		}
		return
	}
	a.linkMu.Lock()
	link := a.link
	a.linkMu.Unlock()
	if link == nil {
		slog.Warn("Probe: keine Cloud-Verbindung - Ergebnis nicht gesendet",
			"request_id", res.RequestID)
		return
	}
	if err := link.PublishProbeResult(raw); err != nil {
		slog.Warn("Probe: Ergebnis konnte nicht gesendet werden",
			"request_id", res.RequestID, "err", err)
	}
}
