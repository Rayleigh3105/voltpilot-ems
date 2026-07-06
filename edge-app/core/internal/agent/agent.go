// Package agent wires the core together: local bus, enrollment, cloud link,
// store-and-forward buffer, schedule cache + guards + setpoint loop, and the
// runtime state for the local web app.
package agent

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/buffer"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/history"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// Version is stamped by the build (ldflags); shown in the UI + deviceInfo.
var Version = "dev"

// historyCapacity bounds the in-memory live-chart ring. At a typical 2-10 s
// telemetry cadence this comfortably covers several hours of recent data; the
// dashboard only ever asks for the last hour or two.
const historyCapacity = 5000

// Agent is the running core.
type Agent struct {
	Cfg   config.Config
	State *state.Store
	Bus   *localbus.Bus

	buf       *buffer.Buffer
	hist      *history.Ring
	planStore *plan.Store
	invStore  *inverter.Store
	invCat    inverter.Catalog

	mu          sync.Mutex
	currentPlan *plan.Plan
	lastReading guards.Reading
	lastRawSoc  *float64

	despiker       *guards.Despiker
	envelope       *guards.Envelope
	despikeStore   *guards.SettingsStore
	lastDespikeLog time.Time

	invMu sync.Mutex
	inv   *inverter.Selection // the customer's inverter choice; nil until set

	link       *cloud.Link
	linkCancel context.CancelFunc // cancels the current link's heartbeat goroutine
	linkMu     sync.Mutex

	// wake signals the publisher that new telemetry or connectivity arrived.
	wake chan struct{}
	// reconcileNow nudges the identity-reconcile loop to re-check ahead of its
	// tick (e.g. right after a cloud disconnect, which is how a broker rejects
	// a device whose identity has drifted).
	reconcileNow chan struct{}

	ctx    context.Context
	cancel context.CancelFunc
	done   sync.WaitGroup
}

// LoadRef returns the effective device reference: the configured one, or a
// generated persistent reference stored in the data dir (kinderleicht: an
// unconfigured device still shows a claimable reference in its web app).
func LoadRef(cfg config.Config) (string, error) {
	if cfg.Ref != "" {
		return strings.TrimSpace(cfg.Ref), nil
	}
	refPath := filepath.Join(cfg.DataDir, "ref")
	if raw, err := os.ReadFile(refPath); err == nil {
		if ref := strings.TrimSpace(string(raw)); ref != "" {
			return ref, nil
		}
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return "", err
	}
	// Short, human-typeable, MQTT-topic-safe (provisioning ref charset), with a
	// trailing check character so the portal can reject a single-character typo
	// instead of silently creating a ghost device that "waits for first data"
	// forever (see EdgeRef.java on the api side - the two MUST stay in lockstep).
	ref := newGeneratedRef()
	if err := os.WriteFile(refPath, []byte(ref+"\n"), 0o644); err != nil {
		return "", err
	}
	slog.Info("generated persistent device reference", "ref", ref)
	return ref, nil
}

// refAlphabet has no 0/O/1/l/i lookalikes, so a customer reading a reference off
// the :8484 web app is unlikely to confuse characters. The api-side validator
// (EdgeRef.java) uses the SAME alphabet and check-character algorithm.
const refAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"

// generatedRefPrefix marks a self-generated reference. The portal validates the
// trailing check character for refs carrying this prefix.
const generatedRefPrefix = "edge-"

// newGeneratedRef builds "edge-" + six random body characters + one check
// character (a position-weighted mod-31 checksum over the body). A single-char
// substitution, adjacent transposition, or wrong length breaks the checksum, so
// the api claim path rejects a typo with 422.
func newGeneratedRef() string {
	body := randomToken(6)
	return generatedRefPrefix + body + string(refCheckChar(body))
}

// refCheckChar computes the check character for a generated-ref body. MUST match
// EdgeRef.isValid on the api side byte for byte.
func refCheckChar(body string) byte {
	sum := 0
	for i := 0; i < len(body); i++ {
		sum += (i + 1) * strings.IndexByte(refAlphabet, body[i])
	}
	return refAlphabet[sum%len(refAlphabet)]
}

func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = refAlphabet[int(b[i])%len(refAlphabet)]
	}
	return string(b)
}

// New builds the agent (opens buffer + plan store, starts nothing yet).
func New(cfg config.Config) (*Agent, error) {
	ref, err := LoadRef(cfg)
	if err != nil {
		return nil, err
	}
	buf, err := buffer.Open(filepath.Join(cfg.DataDir, "buffer"), time.Duration(cfg.BufferHours)*time.Hour)
	if err != nil {
		return nil, err
	}
	ps, err := plan.NewStore(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	is, err := inverter.NewStore(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	ds, err := guards.NewSettingsStore(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	// Restore the operator's despike (Ausreißer-Filter) settings, or fall back
	// to the safe defaults. A corrupt file must not stop the agent booting.
	despikeCfg := guards.DefaultSettings()
	if loaded, ok, err := ds.Load(); err == nil && ok {
		despikeCfg = loaded
	} else if err != nil {
		slog.Warn("stored despike settings unreadable; using defaults", "err", err)
	}
	a := &Agent{
		Cfg:          cfg,
		State:        state.New(ref, Version),
		buf:          buf,
		hist:         history.New(historyCapacity),
		planStore:    ps,
		invStore:     is,
		invCat:       inverter.DefaultCatalog(),
		despiker:     guards.NewDespikerWithSettings(despikeCfg),
		envelope:     guards.NewEnvelope(),
		despikeStore: ds,
		wake:         make(chan struct{}, 1),
		reconcileNow: make(chan struct{}, 1),
		lastReading: guards.Reading{
			SocPct: guards.Unknown(), PvKw: guards.Unknown(),
			LoadKw: guards.Unknown(), GridLimitKw: guards.Unknown(),
		},
	}
	// Boot-without-network: the disk-cached plan is available immediately.
	if p, err := ps.Load(); err == nil && p != nil {
		a.currentPlan = p
		a.State.Update(func(s *state.Snapshot) {
			s.PlanReceived = p.ReceivedAt
			s.PlanSlots = len(p.Slots)
		})
		slog.Info("loaded cached plan from disk", "slots", len(p.Slots), "received_at", p.ReceivedAt)
	} else if err != nil {
		slog.Warn("cached plan unreadable; starting without", "err", err)
	}
	// Restore the customer's inverter selection (persisted across restarts); it
	// is (re-)published retained on the local bus once the bus is up in Start.
	if sel, ok, err := is.Load(); err == nil && ok {
		a.inv = &sel
		a.State.Update(func(s *state.Snapshot) { s.Inverter = inverterInfo(&sel) })
		a.applyEnvelope(&sel)
		slog.Info("loaded inverter selection from disk", "brand", sel.Brand, "family", sel.Family)
	} else if err != nil {
		slog.Warn("stored inverter selection unreadable; starting without", "err", err)
	}
	// A purge requested before a restart and not yet confirmed by the cloud is
	// restored and re-sent once connected.
	a.restorePendingPurge()
	return a, nil
}

// Start brings up the local bus, the setpoint loop, enrollment and the cloud
// link. It returns once the local side is up; enrollment/cloud run in the
// background (claiming may happen days later).
func (a *Agent) Start(ctx context.Context) error {
	ctx, a.cancel = context.WithCancel(ctx)
	a.ctx = ctx

	bus, err := localbus.Start(a.Cfg.LocalMQTTAddr, slog.Default().WithGroup("localbus"))
	if err != nil {
		return fmt.Errorf("local bus: %w", err)
	}
	a.Bus = bus

	if err := bus.Subscribe(localbus.TopicTelemetry, 1, a.onLocalTelemetry); err != nil {
		return err
	}
	if err := bus.Subscribe(localbus.TopicStatus, 2, a.onLocalStatus); err != nil {
		return err
	}

	// Re-publish the persisted inverter selection retained, so a Node-RED that
	// (re)joins the bus after a reboot immediately self-wires the right adapter.
	a.publishInverterConfig()

	a.done.Add(2)
	go a.setpointLoop(ctx)
	go a.publisherLoop(ctx)

	if a.Cfg.DevIdentity() {
		id := enroll.Identity{
			TenantID: a.Cfg.DevTenantID,
			SiteID:   a.Cfg.DevSiteID,
			DeviceID: a.Cfg.DevDeviceID,
			MqttHost: a.Cfg.MQTTHost,
			MqttPort: a.Cfg.MQTTPort,
		}
		slog.Warn("DEV identity configured - skipping enrollment (never do this on a customer device)",
			"device_id", id.DeviceID)
		a.State.Update(func(s *state.Snapshot) {
			s.PairingState = string(enroll.StateCertificateReceived)
			s.TenantID, s.SiteID, s.DeviceID = id.TenantID, id.SiteID, id.DeviceID
			s.MqttHost = id.MqttHost
		})
		return a.startCloud(id, "", "", "")
	}

	a.done.Add(1)
	go func() {
		defer a.done.Done()
		a.enrollAndConnect(ctx)
	}()
	return nil
}

func (a *Agent) enrollAndConnect(ctx context.Context) {
	e := &enroll.Enroller{
		PortalBaseURL: strings.TrimRight(a.Cfg.PortalBaseURL, "/"),
		Ref:           a.State.Get().Ref,
		Dir:           filepath.Join(a.Cfg.DataDir, "identity"),
		DeviceInfo:    "vp-edge-core " + Version,
		OnState: func(st enroll.State) {
			a.State.Update(func(s *state.Snapshot) { s.PairingState = string(st) })
		},
	}
	// Run enrollment, retrying local-init failures (geraet_fehler) with backoff
	// instead of silently exiting the goroutine - a transient disk problem then
	// recovers on its own, and a persistent one keeps the error state visible.
	id, ok := a.runEnrollment(ctx, e)
	if !ok {
		return // ctx cancelled
	}
	a.State.Update(func(s *state.Snapshot) {
		s.TenantID, s.SiteID, s.DeviceID = id.TenantID, id.SiteID, id.DeviceID
		s.MqttHost = id.MqttHost
	})
	key, cert, ca := e.CertFiles()
	// Bring up the cloud link, retrying setup failures (cloud_fehler) with
	// backoff rather than exiting - the certificate is on disk, so a corrupt
	// bundle or a momentary broker problem must not strand an enrolled device.
	if !a.startCloudWithRetry(ctx, id, key, cert, ca) {
		return // ctx cancelled while retrying
	}
	// Stay reconciled while connected: adopt a re-claim's new device_id so the
	// edge never keeps publishing under a stale identity. Blocks until ctx is
	// done (this goroutine is dedicated to enrollment + its follow-up).
	a.reconcileLoop(ctx, e, id)
}

// runEnrollment drives the enroller to completion, retrying local-init failures
// (which surface as geraet_fehler) with capped backoff. Returns ok=false only
// when ctx is cancelled.
func (a *Agent) runEnrollment(ctx context.Context, e *enroll.Enroller) (enroll.Identity, bool) {
	backoff := 5 * time.Second
	for {
		id, err := e.Run(ctx)
		if err == nil {
			return id, true
		}
		if errors.Is(err, context.Canceled) {
			return enroll.Identity{}, false
		}
		// Non-cancel error = a local-init failure (Run already set the
		// geraet_fehler pairing state). Retry with backoff.
		slog.Error("enrollment failed; retrying", "err", err, "retry_in", backoff)
		select {
		case <-ctx.Done():
			return enroll.Identity{}, false
		case <-time.After(backoff):
		}
		if backoff < time.Minute {
			backoff *= 2
			if backoff > time.Minute {
				backoff = time.Minute
			}
		}
	}
}

// startCloudWithRetry brings up the cloud link, retrying a setup failure with
// capped backoff and surfacing it as cloud_fehler (distinct from a normal
// disconnect). Returns false only when ctx is cancelled while retrying.
func (a *Agent) startCloudWithRetry(ctx context.Context, id enroll.Identity, keyPath, certPath, caPath string) bool {
	backoff := 5 * time.Second
	for {
		if err := a.startCloud(id, keyPath, certPath, caPath); err == nil {
			return true
		} else {
			slog.Error("cloud link failed to start; retrying", "err", err, "retry_in", backoff)
			a.State.Update(func(s *state.Snapshot) {
				if s.PairingState != string(enroll.StateConnected) {
					s.PairingState = string(enroll.StateCloudError)
				}
			})
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(backoff):
		}
		if backoff < time.Minute {
			backoff *= 2
			if backoff > time.Minute {
				backoff = time.Minute
			}
		}
	}
}

// reconcileLoop periodically (and on a disconnect nudge) re-checks the device's
// identity against the portal and adopts a changed device_id. It runs only for
// enrolled devices (a DevIdentity never drifts). No-op when the identity is
// unchanged, so it does not thrash.
func (a *Agent) reconcileLoop(ctx context.Context, e *enroll.Enroller, current enroll.Identity) {
	interval := a.Cfg.ReconcileInterval
	if interval <= 0 {
		interval = time.Duration(a.Cfg.ReconcileIntervalSeconds) * time.Second
	}
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-a.reconcileNow:
		}
		res, err := e.Reconcile(ctx, current)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				slog.Warn("identity reconcile failed; will retry", "err", err)
			}
			continue
		}
		if !res.Changed {
			continue
		}
		key, cert, ca := e.CertFiles()
		if err := a.adoptIdentity(res.Identity, key, cert, ca); err != nil {
			slog.Error("failed to adopt new device identity", "err", err)
			continue
		}
		current = res.Identity
	}
}

// adoptIdentity switches the cloud link to a new device identity: the old mTLS
// link is torn down and a fresh one is stood up with the new certificate and
// topics. Reconnecting is REQUIRED - the hardened broker derives the identity
// from the client-cert CN and its ACL only grants that device its own topics,
// so publishing new-device topics over the old connection would be denied. The
// store-and-forward buffer is untouched: pending entries are stamped with the
// current identity at publish time, so they flow to the new device_id.
func (a *Agent) adoptIdentity(id enroll.Identity, keyPath, certPath, caPath string) error {
	a.linkMu.Lock()
	old := a.link
	oldCancel := a.linkCancel
	a.link = nil
	a.linkCancel = nil
	a.linkMu.Unlock()
	if oldCancel != nil {
		oldCancel() // stop the old link's heartbeat goroutine
	}
	if old != nil {
		old.Close()
	}
	a.State.Update(func(s *state.Snapshot) {
		s.TenantID, s.SiteID, s.DeviceID = id.TenantID, id.SiteID, id.DeviceID
		s.MqttHost = id.MqttHost
		s.CloudConnected = false
	})
	slog.Info("switching cloud link to new device identity", "device_id", id.DeviceID)
	return a.startCloud(id, keyPath, certPath, caPath)
}

// pokeReconcile nudges the reconcile loop without blocking.
func (a *Agent) pokeReconcile() {
	select {
	case a.reconcileNow <- struct{}{}:
	default:
	}
}

func (a *Agent) startCloud(id enroll.Identity, keyPath, certPath, caPath string) error {
	link, err := cloud.New(cloud.Options{
		Identity:    id,
		KeyPath:     keyPath,
		CertPath:    certPath,
		CAPath:      caPath,
		DevURL:      a.Cfg.DevCloudURL,
		DevInsecure: a.Cfg.DevInsecure,
		OnSchedule:  a.onSchedule,
		OnCommand:   a.onPurgeCommand,
		OnConnect: func(connected bool) {
			a.State.Update(func(s *state.Snapshot) {
				s.CloudConnected = connected
				if connected {
					s.PairingState = string(enroll.StateConnected)
				} else if s.PairingState == string(enroll.StateConnected) {
					// Was connected and dropped: move the pairing checklist off
					// the green "Verbunden" so it agrees with the Cloud stat now
					// showing "getrennt" (reconnect is automatic).
					s.PairingState = string(enroll.StateCloudDisconnected)
				}
			})
			if connected {
				a.kick()
				// A purge requested while the device was offline is queued on
				// disk; (re-)send it now that the cloud is reachable again.
				a.trySendPurgeRequest()
			} else {
				// A drifted identity is rejected by the broker as a connection
				// failure; re-check the identity promptly instead of waiting for
				// the next tick (a no-op if nothing actually changed).
				a.pokeReconcile()
			}
		},
	})
	if err != nil {
		return err
	}
	// Each link gets its own context so its heartbeat goroutine exits when the
	// link is replaced (identity adoption) or closed - not only at process
	// shutdown. Without this, every re-claim leaked a heartbeat goroutine holding
	// the closed old link and ticking forever.
	linkCtx, linkCancel := context.WithCancel(a.ctx)
	a.linkMu.Lock()
	a.link = link
	a.linkCancel = linkCancel
	a.linkMu.Unlock()
	link.Connect()

	// Status heartbeat.
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				if !link.Connected() {
					continue
				}
				snap := a.State.Get()
				src := "default"
				if snap.Mode == state.ModeSchedule {
					src = "schedule"
				}
				a.mu.Lock()
				soc := a.lastRawSoc
				a.mu.Unlock()
				if err := link.PublishStatus(src, soc); err != nil {
					slog.Warn("status publish failed", "err", err)
				}
			case <-linkCtx.Done():
				return
			}
		}
	}()
	return nil
}

// onLocalTelemetry ingests one Layer-1 measurement sample: update the guard
// reading, buffer it (store-and-forward), and wake the publisher.
func (a *Agent) onLocalTelemetry(_ string, payload []byte) {
	var m struct {
		Ts          string   `json:"ts"`
		PowerKw     *float64 `json:"power_kw"`
		SocPct      *float64 `json:"soc_pct"`
		PvPowerKw   *float64 `json:"pv_power_kw"`
		LoadKw      *float64 `json:"load_kw"`
		GridLimitKw *float64 `json:"grid_limit_kw"`
	}
	if err := json.Unmarshal(payload, &m); err != nil {
		slog.Warn("local telemetry malformed; skipped", "err", err)
		return
	}
	ts := time.Now().UTC()
	if m.Ts != "" {
		if t, err := time.Parse(time.RFC3339, m.Ts); err == nil {
			ts = t.UTC()
		}
	}
	measurements := map[string]float64{}
	put := func(k string, v *float64) {
		if v != nil && !math.IsNaN(*v) && !math.IsInf(*v, 0) {
			measurements[k] = *v
		}
	}
	put("power_kw", m.PowerKw)
	put("soc_pct", m.SocPct)
	put("pv_power_kw", m.PvPowerKw)
	put("load_kw", m.LoadKw)
	put("grid_limit_kw", m.GridLimitKw)
	if len(measurements) == 0 {
		slog.Warn("local telemetry carried no known measurement; skipped")
		return
	}
	// SoC plausibility gate (drop-don't-fabricate), the same policy as the Deye
	// decoder's socPlausible(): an out-of-band SoC marks the WHOLE read as
	// untrustworthy (degraded logger answer / misaligned frame), so nothing may
	// consume it - not the dashboard tiles and live charts, not the cloud
	// publish, not the setpoint guards. Every display keeps its last good value,
	// and the existing freshness UI turns honest on its own ("keine aktuellen
	// Daten") because LastTelemetry only advances on kept samples.
	if soc, ok := measurements["soc_pct"]; ok && !guards.SocPlausible(soc) {
		slog.Warn("implausible soc_pct reading; sample dropped", "soc_pct", soc)
		return
	}
	// Despike gate (operator-configurable, per channel): reject a transient
	// in-band excursion that slips through the plausibility gate - the captain's
	// real symptom of a SoC (or other channel) reading e.g. 2 % for one sample
	// between two steady 94 % samples, or a power channel briefly reading an
	// impossible value and reverting. A rejected channel is REPLACED with its
	// last accepted value (hold-last), so every recorded series stays a
	// continuous line with no gaps (the captain's explicit requirement); other
	// channels in the same sample are unaffected. SoC uses a strict rate bound
	// (integrative, cannot step fast); power channels use a generous bound so
	// normal fast dynamics pass unfiltered. Thresholds are set by the operator on
	// the device (guards.DespikeSettings). See guards.Despiker for the
	// accept-after-confirmation semantics that let a genuinely new level converge
	// instead of holding the old one forever.
	drops := a.despiker.Accept(measurements, ts)
	// Physical-envelope gate (preset-INDEPENDENT): the configured inverter model
	// bounds PV and the DERIVED battery (grid - load + pv). This catches what the
	// rate gate leaves through at a slow cadence - the captain's ~26 kW single
	// sample on a 12 kW inverter, whose UNBALANCED grid spike snaps the derived
	// battery curve to an impossible value. The offending measured channel is held
	// to its last in-envelope value (hold-last), so all four lines - including the
	// derived battery - stay continuous. Inactive when no inverter/rating is known.
	drops = append(drops, a.envelope.Accept(measurements)...)
	if len(drops) > 0 {
		a.logDespike(drops)
		total := a.despiker.DroppedTotal() + a.envelope.DroppedTotal()
		a.State.Update(func(s *state.Snapshot) { s.DespikedDropped = total })
	}

	// From here on the (hold-last-filtered) measurements map is authoritative: a
	// channel the despiker rejected now carries its last accepted value, so every
	// consumer (guard reading, cloud buffer, status heartbeat, live-chart ring)
	// sees a continuous series.
	pick := func(k string) float64 {
		if v, ok := measurements[k]; ok {
			return v
		}
		return guards.Unknown()
	}
	ptr := func(k string) *float64 {
		if v, ok := measurements[k]; ok {
			v := v
			return &v
		}
		return nil
	}
	a.mu.Lock()
	a.lastReading = guards.Reading{
		SocPct:      pick("soc_pct"),
		PvKw:        pick("pv_power_kw"),
		LoadKw:      pick("load_kw"),
		GridLimitKw: pick("grid_limit_kw"),
	}
	// Keep the last-good raw SoC for the status heartbeat when this sample had
	// no (or a despiked) SoC - mirrors the tile's last-good behaviour rather
	// than reporting a hole to the cloud.
	if p := ptr("soc_pct"); p != nil {
		a.lastRawSoc = p
	}
	a.mu.Unlock()

	if _, err := a.buf.Append(ts, measurements); err != nil {
		slog.Error("telemetry buffer append failed", "err", err)
		return
	}
	// Feed the in-memory live-chart ring (local dashboard only). An absent
	// measurement stays absent (nil) on the chart, never coerced to 0; a despiked
	// one already carries its last-good value (hold-last), so the line is
	// continuous.
	a.hist.Add(history.Sample{
		Ts:          ts,
		PvKw:        ptr("pv_power_kw"),
		LoadKw:      ptr("load_kw"),
		GridKw:      ptr("power_kw"),
		SocPct:      ptr("soc_pct"),
		GridLimitKw: ptr("grid_limit_kw"),
	})
	a.State.Update(func(s *state.Snapshot) {
		s.LastTelemetry = ts
		s.BufferPending = a.buf.Pending()
		s.BufferDataLoss = a.buf.DataLoss()
		if v, ok := measurements["soc_pct"]; ok {
			s.SocPct = v
		}
		if v, ok := measurements["pv_power_kw"]; ok {
			s.PvKw = v
		}
		if v, ok := measurements["load_kw"]; ok {
			s.LoadKw = v
		}
		if v, ok := measurements["grid_limit_kw"]; ok {
			s.GridLimitKw = v
		}
	})
	a.kick()
}

// logDespike records dropped spike samples for field diagnosis, rate-limited to
// at most one line per despikeLogInterval so a persistently spiking sensor does
// not flood the log. The running total is always available in the state
// snapshot (DespikedDropped).
func (a *Agent) logDespike(drops []guards.Drop) {
	a.mu.Lock()
	now := time.Now()
	quiet := now.Sub(a.lastDespikeLog) < despikeLogInterval
	if !quiet {
		a.lastDespikeLog = now
	}
	a.mu.Unlock()
	if quiet {
		return
	}
	for _, d := range drops {
		slog.Debug("despiked telemetry channel; last-good value held",
			"channel", d.Channel, "value", d.Value, "held", d.Held,
			"dropped_total", a.despiker.DroppedTotal())
	}
}

// despikeLogInterval rate-limits the despike debug log.
const despikeLogInterval = 30 * time.Second

// onLocalStatus tracks the inverter link state Layer 1 reports.
func (a *Agent) onLocalStatus(_ string, payload []byte) {
	var m struct {
		InverterLink string `json:"inverter_link"`
	}
	if err := json.Unmarshal(payload, &m); err != nil || (m.InverterLink != "up" && m.InverterLink != "down") {
		slog.Warn("local status malformed; skipped")
		return
	}
	a.State.Update(func(s *state.Snapshot) {
		s.InverterLink = m.InverterLink
		s.InverterLinkSeen = time.Now().UTC()
	})
}

// onSchedule handles a (retained) schedule payload from the cloud: validate
// against the frozen contract, verify it addresses THIS device, cache it in
// memory + on disk.
func (a *Agent) onSchedule(payload []byte) {
	p, err := plan.Parse(payload, time.Now().UTC())
	if err != nil {
		slog.Warn("schedule payload rejected", "err", err)
		return
	}
	// Identity check mirrors the Node-RED edge: the subscription is already
	// device-scoped, but a defensive payload check costs nothing.
	var ids struct {
		DeviceID string `json:"device_id"`
	}
	_ = json.Unmarshal(payload, &ids)
	snap := a.State.Get()
	if ids.DeviceID != "" && snap.DeviceID != "" && ids.DeviceID != snap.DeviceID {
		slog.Warn("schedule for another device ignored", "payload_device", ids.DeviceID)
		return
	}
	a.mu.Lock()
	a.currentPlan = p
	a.mu.Unlock()
	if err := a.planStore.Save(p); err != nil {
		slog.Warn("plan not persisted", "err", err)
	}
	a.State.Update(func(s *state.Snapshot) {
		s.PlanReceived = p.ReceivedAt
		s.PlanSlots = len(p.Slots)
	})
	slog.Info("schedule cached", "plan_id", p.PlanID, "slots", len(p.Slots), "slot_minutes", p.SlotMinutes)
	a.applySetpoint(time.Now().UTC()) // react immediately, don't wait for the tick
}

// setpointLoop recomputes + publishes the current setpoint on every tick
// (the interval divides 15 min, so every slot boundary is hit).
func (a *Agent) setpointLoop(ctx context.Context) {
	defer a.done.Done()
	t := time.NewTicker(a.Cfg.SetpointInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.applySetpoint(time.Now().UTC())
		}
	}
}

// applySetpoint computes the guarded setpoint for now and publishes it
// RETAINED on the local bus, so Layer 1 always sees the latest command.
func (a *Agent) applySetpoint(now time.Time) {
	a.mu.Lock()
	p := a.currentPlan
	r := a.lastReading
	a.mu.Unlock()

	hasReading := !math.IsNaN(r.PvKw) || !math.IsNaN(r.LoadKw) || !math.IsNaN(r.SocPct)

	limits := guards.Limits{
		MaxChargeKw:    a.Cfg.MaxChargeKw,
		MaxDischargeKw: a.Cfg.MaxDischargeKw,
		SocMinPct:      a.Cfg.SocMinPct,
		SocMaxPct:      a.Cfg.SocMaxPct,
	}

	var (
		kw        float64
		mode      state.Mode
		source    string
		slotStart time.Time
	)
	if raw, start, ok := p.ActiveSetpoint(now); ok {
		kw = guards.Clamp(raw, limits, r)
		mode, source, slotStart = state.ModeSchedule, "schedule", start
	} else if hasReading {
		kw = guards.Clamp(guards.SelfConsumption(r), limits, r)
		mode, source = state.ModeSelfConsume, "default"
	} else {
		// No inverter reading at all: publish nothing (mirrors the Node-RED
		// watchdog, which does not write without a reading).
		a.State.Update(func(s *state.Snapshot) { s.Mode = state.ModeNoReading })
		return
	}

	msg := map[string]any{
		"battery_setpoint_kw": kw,
		"source":              source,
		"ts":                  now.Format(time.RFC3339Nano),
	}
	if !slotStart.IsZero() {
		msg["slot_start"] = slotStart.UTC().Format(time.RFC3339)
	}
	raw, _ := json.Marshal(msg)
	if err := a.Bus.Publish(localbus.TopicSetpoint, raw, true); err != nil {
		slog.Error("setpoint publish failed", "err", err)
		return
	}
	a.State.Update(func(s *state.Snapshot) {
		s.Mode = mode
		s.SetpointKw = kw
		s.SlotStart = slotStart
	})
}

// publisherLoop drains the buffer oldest-first whenever the cloud link is
// up, acking each entry only after the broker confirmed the QoS1 publish.
func (a *Agent) publisherLoop(ctx context.Context) {
	defer a.done.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case <-a.wake:
		case <-time.After(5 * time.Second):
		}
		a.linkMu.Lock()
		link := a.link
		a.linkMu.Unlock()
		if link == nil || !link.Connected() {
			continue
		}
		for {
			e, ok := a.buf.Next()
			if !ok {
				break
			}
			if err := link.PublishTelemetry(e); err != nil {
				slog.Warn("telemetry publish failed; will retry", "seq", e.Seq, "err", err)
				break
			}
			if err := a.buf.Ack(); err != nil {
				slog.Error("buffer ack failed", "err", err)
				break
			}
			a.State.Update(func(s *state.Snapshot) {
				s.LastCloudPub = time.Now().UTC()
				s.BufferPending = a.buf.Pending()
				s.BufferDataLoss = a.buf.DataLoss()
			})
			select {
			case <-ctx.Done():
				return
			default:
			}
		}
	}
}

// kick wakes the publisher without blocking.
func (a *Agent) kick() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

// --- Inverter selection (the local web app's config surface) ---

// History exposes the in-memory live-telemetry ring for the local web app's
// charts (recent samples + live stream). Local, read-only.
func (a *Agent) History() *history.Ring { return a.hist }

// InverterCatalog returns the selectable brand/family/field option tree.
func (a *Agent) InverterCatalog() inverter.Catalog { return a.invCat }

// GetInverter returns the current selection, ok=false if none is set yet.
func (a *Agent) GetInverter() (inverter.Selection, bool) {
	a.invMu.Lock()
	defer a.invMu.Unlock()
	if a.inv == nil {
		return inverter.Selection{}, false
	}
	return *a.inv, true
}

// SetInverter validates a selection request against the catalog, persists it,
// updates the UI state, and (re-)publishes it retained on the local bus so
// Layer 1 picks up the change immediately. A bad request returns a
// *inverter.ValidationError (the web layer maps it to HTTP 400).
func (a *Agent) SetInverter(req inverter.SelectionRequest) (inverter.Selection, error) {
	sel, err := a.invCat.Normalize(req, time.Now())
	if err != nil {
		return inverter.Selection{}, err
	}
	if err := a.invStore.Save(sel); err != nil {
		return inverter.Selection{}, fmt.Errorf("inverter selection not persisted: %w", err)
	}
	a.invMu.Lock()
	a.inv = &sel
	a.invMu.Unlock()
	a.State.Update(func(s *state.Snapshot) { s.Inverter = inverterInfo(&sel) })
	a.applyEnvelope(&sel)
	a.publishInverterConfig()
	slog.Info("inverter selection updated", "brand", sel.Brand, "family", sel.Family,
		"communication", sel.Communication)
	return sel, nil
}

// applyEnvelope (re)configures the physical-plausibility envelope from the
// selected inverter model: the model's nameplate rating bounds PV and (for
// battery families) the derived battery charge/discharge, enforced regardless of
// the operator's despike preset. An unknown model / no rating leaves the
// envelope inactive (bounds 0), so a device without a known rating is unaffected.
func (a *Agent) applyEnvelope(sel *inverter.Selection) {
	if a.envelope == nil || sel == nil {
		return
	}
	var maxPv, maxBatt float64
	if rated, ok := a.invCat.RatedKw(sel.Brand, sel.Model); ok {
		maxPv, maxBatt = guards.EnvelopeFor(rated, inverter.FamilyHasBattery(sel.Family))
	}
	a.envelope.SetBounds(maxPv, maxBatt)
	slog.Info("physical envelope configured", "model", sel.Model, "family", sel.Family,
		"max_pv_kw", maxPv, "max_battery_kw", maxBatt)
}

// publishInverterConfig publishes the current selection retained on the local
// bus. No-op when nothing is selected yet or the bus is not up.
func (a *Agent) publishInverterConfig() {
	a.invMu.Lock()
	sel := a.inv
	a.invMu.Unlock()
	if sel == nil || a.Bus == nil {
		return
	}
	if err := a.Bus.Publish(localbus.TopicInverterConfig, sel.BusPayload(), true); err != nil {
		slog.Error("inverter config publish failed", "err", err)
	}
}

// --- Despike settings (the local web app's Ausreißer-Filter surface) ---

// GetDespike returns the current despike settings, per-channel drop counters and
// the channel metadata (labels/units/help) for the settings page. The envelope's
// per-channel rejections are folded into the same counters so the operator sees
// the total "N gefiltert" per channel (the envelope is not preset-configurable,
// so it adds no knobs - only visible drops).
func (a *Agent) GetDespike() guards.DespikeStatus {
	st := a.despiker.Status()
	for ch, n := range a.envelope.DroppedByChannel() {
		st.Counters[ch] += n
	}
	return st
}

// SetDespike validates a settings request, persists it, and applies it live to
// the running despiker (no restart). A bad request returns a
// *guards.SettingsValidationError (the web layer maps it to HTTP 400).
func (a *Agent) SetDespike(req guards.DespikeSettings) (guards.DespikeStatus, error) {
	cfg, err := req.Normalize()
	if err != nil {
		return guards.DespikeStatus{}, err
	}
	if err := a.despikeStore.Save(cfg); err != nil {
		return guards.DespikeStatus{}, fmt.Errorf("filter settings not persisted: %w", err)
	}
	a.despiker.Reconfigure(cfg)
	slog.Info("despike settings updated", "preset", cfg.Preset)
	return a.GetDespike(), nil
}

// inverterInfo projects a selection onto the UI-facing snapshot summary.
func inverterInfo(sel *inverter.Selection) *state.InverterInfo {
	if sel == nil {
		return nil
	}
	return &state.InverterInfo{
		Brand:         sel.Brand,
		Label:         sel.Label,
		Model:         sel.Model,
		Family:        sel.Family,
		Communication: sel.Communication,
		Host:          sel.Connection.IP,
		Configured:    true,
	}
}

// Stop shuts everything down.
func (a *Agent) Stop() {
	if a.cancel != nil {
		a.cancel()
	}
	a.linkMu.Lock()
	if a.link != nil {
		a.link.Close()
	}
	a.linkMu.Unlock()
	if a.Bus != nil {
		_ = a.Bus.Close()
	}
	a.done.Wait()
	_ = a.buf.Close()
}
