// Package agent wires the core together: local bus, enrollment, cloud link,
// store-and-forward buffer, schedule cache + guards + setpoint loop, and the
// runtime state for the local web app.
package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/buffer"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flowdeploy"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/history"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan2"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
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

	despiker *guards.Despiker
	envelope *guards.Envelope
	// peak tracks the running wall-clock quarter hour's mean grid import for
	// the PS-3 peak guard (fed with the gated composite power_kw at
	// onLocalTelemetry, read at applySetpoint). Concurrency-safe internally.
	peak           *guards.PeakTracker
	despikeStore   *guards.SettingsStore
	lastDespikeLog time.Time
	lastBalanceLog time.Time // rate-limits the house-balance fallback warning
	lastDriftLog   time.Time // rate-limits the battery cross-check drift log

	invMu sync.Mutex
	inv   *inverter.Selection // the customer's inverter choice; nil until set

	// Additional read-only measurement points (Erzeuger/PV + a Netz/grid meter).
	// srcs is the persisted config; srcReadings holds the latest per-source
	// reading (its PV and/or signed grid power + the wall-clock receive time, for
	// freshness/error isolation). The core sums fresh Erzeuger PV into the
	// composite site reading and lets a fresh Netz meter override site grid at
	// onLocalTelemetry.
	srcStore    *sources.Store
	srcMu       sync.Mutex
	srcs        []sources.Source
	srcReadings map[string]sourceReading
	// lastPvMix / lastGridMix are the source-composition signatures of the last
	// fold (which sources actually contributed PV / the grid override). When the
	// composition changes - a source added/removed or flipping fresh<->stale -
	// the composite series legitimately STEPS (e.g. +26,9 kW when a second
	// Fronius starts contributing); the despiker/envelope baselines for the
	// affected channels are reset so the explained step is adopted immediately
	// instead of being held as a suspected spike (an oscillating composition
	// would otherwise keep resetting the despiker's confirmation candidate and
	// freeze the displayed value forever - the captain's 45,4-kW tile). Guarded
	// by srcMu.
	lastPvMix   string
	lastGridMix string

	// Site power-balance settings (operator-declared topology facts, persisted
	// in data-dir/balance.json): today the single expert OPT-OUT from the
	// default-on house-consumption standard ("primary grid CT does NOT sit at
	// the site connection"). Guarded by srcMu (read on the telemetry hot path
	// together with srcs).
	balStore *sources.BalanceStore
	bal      sources.BalanceSettings

	// testReads correlates an in-flight "Verbindung testen" round-trip
	// (edge/test-read/request -> Node-RED -> edge/test-read/result) to the
	// waiting HTTP handler by request id. The channel is buffered (size 1) so the
	// bus handler never blocks even if the handler already timed out and left.
	testMu    sync.Mutex
	testReads map[string]chan testconn.Result

	link       *cloud.Link
	linkCancel context.CancelFunc // cancels the current link's heartbeat goroutine
	linkMu     sync.Mutex

	// v2 entity layer (agent/entities.go; contract docs/contracts/v2/
	// edge-entity-config.md): the applied registry, its persistence, the
	// latest per-entity readings and the live v2 uplink queue. Empty registry
	// = byte-for-byte v1 behavior.
	entMu        sync.Mutex
	entStore     *entities.Store
	entRegistry  entities.Registry
	entIdentity  entities.Identity
	entAppliedAt time.Time
	entReadings  map[string]entReading

	// E2 arbitration layer (agent/arbitration.go; contract docs/contracts/v2/
	// edge-desired-arbitration.md + mqtt-schedule-2.0.md): the desired
	// arbiter, the cached v2 plan + its staleness-surviving postures, the
	// plan-executor bookkeeping and per-entity readback verdicts. All no-ops
	// without a pushed registry.
	arb        *desired.Arbiter
	plan2Store *plan2.Store
	arbMu      sync.Mutex
	curPlan2   *plan2.Plan
	peak2      *float64            // v2 site peak target (survives staleness)
	reserve2   map[string]*float64 // v2 per-entity reserves (survive staleness)
	planHeld    map[string]string // entity -> "v1"|"v2" currently plan-commanded
	entReadback map[string]*bool  // per-entity latest readback all_match
	arbWake     chan struct{}

	// flowDep consumes the retained flow deployment set (agent/flows.go).
	// Always constructed; without VP_NODERED_ADMIN_URL it verifies + persists
	// but acks 'error' honestly instead of materializing tabs.
	flowDep *flowdeploy.Deployer

	// cloudRemoved is true while the device is in the geraet_entfernt state: a
	// SUSTAINED run of definitive clean-404 "not claimed" answers confirmed the
	// device was removed (unclaimed) in the cloud. The cloud link is torn down
	// and onLocalTelemetry stops growing the store-and-forward buffer (the local
	// dashboard keeps running); the reconcile loop keeps polling so a re-claim
	// exits the state and resumes normal operation.
	cloudRemoved atomic.Bool

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
	ss, err := sources.NewStore(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	bs, err := sources.NewBalanceStore(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	ds, err := guards.NewSettingsStore(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	es, err := entities.NewStore(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	p2s, err := plan2.NewStore(cfg.DataDir)
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
		srcStore:     ss,
		balStore:     bs,
		srcReadings:  map[string]sourceReading{},
		entReadings:  map[string]entReading{},
		testReads:    map[string]chan testconn.Result{},
		despiker:     guards.NewDespikerWithSettings(despikeCfg),
		envelope:     guards.NewEnvelope(),
		peak:         guards.NewPeakTracker(),
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
	// Restore the additional read-only measurement points (Erzeuger/PV) BEFORE
	// the envelope is applied, so its widened PV bound accounts for them; they are
	// (re-)published retained on the local bus once the bus is up in Start.
	if list, ok, err := ss.Load(); err == nil && ok {
		a.srcs = list
		slog.Info("loaded additional measurement points from disk", "count", len(list))
	} else if err != nil {
		slog.Warn("stored measurement points unreadable; starting without", "err", err)
	}
	// Restore the site power-balance settings. A corrupt/missing file falls back
	// to the defaults (opt-out OFF = the house-consumption standard runs; a
	// legacy opt-in balance.json migrates to the same, see BalanceStore.Load).
	if cfg, ok, err := bs.Load(); err == nil && ok {
		a.bal = cfg
		if cfg.PrimaryGridNotSiteTotal {
			slog.Info("expert opt-out active: primary grid CT declared NOT at the site connection; house load stays on the raw-load fallback path")
		}
	} else if err != nil {
		slog.Warn("stored balance settings unreadable; using defaults", "err", err)
	}
	// Restore the applied v2 entity registry (persisted across restarts); its
	// per-entity retained configs are re-published once the bus is up in Start.
	a.entStore = es
	a.restoreEntities()
	// E2 arbitration: the engine is always constructed (no-op without
	// entities); the persisted v2 plan is restored like the v1 plan cache.
	a.plan2Store = p2s
	a.arbWake = make(chan struct{}, 1)
	a.arb = a.newArbiter()
	a.flowDep = a.newFlowDeployer()
	a.entMu.Lock()
	reg := a.entRegistry
	a.entMu.Unlock()
	a.arb.SetEntities(reg)
	if p2, err := p2s.Load(); err == nil && p2 != nil {
		a.curPlan2 = p2
		a.peak2 = p2.GridImportLimitKw
		reserves := map[string]*float64{}
		for _, e := range p2.Entities {
			if e.ReserveSocPct != nil {
				v := *e.ReserveSocPct
				reserves[e.ID] = &v
			}
		}
		a.reserve2 = reserves
		slog.Info("loaded cached v2 plan from disk", "plan_id", p2.PlanID, "entities", len(p2.Entities))
	} else if err != nil {
		slog.Warn("cached v2 plan unreadable; starting without", "err", err)
	}
	// Restore the customer's inverter selection (persisted across restarts); it
	// is (re-)published retained on the local bus once the bus is up in Start.
	if sel, ok, err := is.Load(); err == nil && ok {
		a.inv = &sel
		a.State.Update(func(s *state.Snapshot) { s.Inverter = inverterInfo(&sel) })
		slog.Info("loaded inverter selection from disk", "brand", sel.Brand, "family", sel.Family)
	} else if err != nil {
		slog.Warn("stored inverter selection unreadable; starting without", "err", err)
	}
	// Configure the physical envelope from the restored primary + sources (its PV
	// bound is Σ generation nameplate). Safe with no inverter (inactive/PV-only).
	a.reapplyEnvelope()
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
	if err := bus.Subscribe(localbus.TopicControlReadback, 3, a.onControlReadback); err != nil {
		return err
	}
	// Additional read-only sources (Phase 1: Erzeuger/PV) publish per-source
	// telemetry under edge/sources/{id}/telemetry; the core sums them into the
	// composite site reading. Wildcard subscription so any number of sources works
	// without per-source (un)subscribe on add/remove.
	if err := bus.Subscribe(sources.TopicWildcard, 4, a.onSourceTelemetry); err != nil {
		return err
	}
	// One-shot "Verbindung testen" results from Node-RED (edge/test-read/result),
	// correlated to the waiting HTTP handler by request id.
	if err := bus.Subscribe(localbus.TopicTestReadResult, 5, a.onTestReadResult); err != nil {
		return err
	}

	// Re-publish the persisted inverter selection retained, so a Node-RED that
	// (re)joins the bus after a reboot immediately self-wires the right adapter.
	a.publishInverterConfig()
	// Same for the additional-source config: Node-RED self-wires a read of each.
	a.publishSourcesConfig()

	// v2 entity layer: telemetry wildcard subscription (id 6) + boot republish
	// of the per-entity retained configs. The v2 uplink rides the shared
	// store-and-forward buffer (E1b), drained by the publisher loop below.
	if err := a.startEntityLayer(); err != nil {
		return err
	}
	// E2 arbitration layer: desired + readback wildcard subscriptions (ids
	// 7/8) and the executor/expiry loop. No-op without a pushed registry.
	if err := a.startArbitration(ctx); err != nil {
		return err
	}
	// E2 flow deployment: reconcile the persisted set at boot (self-heal from
	// truth) and keep reconciling periodically.
	a.flowDep.Reconcile()
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		a.flowReconcileLoop(ctx)
	}()

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
//
// It also hosts the confirmed-unclaim detection: this loop only ever runs for a
// device that HOLDS a valid identity (enrollment completed), so a SUSTAINED,
// UNINTERRUPTED run of definitive clean-404 "not claimed" answers from a
// REACHABLE portal (enroll.UnclaimDetector; window + poll count from
// VP_UNCLAIM_CONFIRM_*) means the device was removed (unclaimed) in the cloud
// -> geraet_entfernt. A never-claimed device polls pending inside enroll.Run
// and never reaches this loop, so it can structurally never read "removed";
// dial errors / timeouts / 5xx reset the detector, so a transient portal
// outage keeps the existing portal-blip behavior (identity kept, link up).
func (a *Agent) reconcileLoop(ctx context.Context, e *enroll.Enroller, current enroll.Identity) {
	interval := a.Cfg.ReconcileInterval
	if interval <= 0 {
		interval = time.Duration(a.Cfg.ReconcileIntervalSeconds) * time.Second
	}
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	detector := &enroll.UnclaimDetector{
		Window:   a.Cfg.UnclaimConfirm,
		MinPolls: a.Cfg.UnclaimConfirmPolls,
	}
	removed := false
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
			// Dial error / timeout / 5xx or any other poll failure: NOT a
			// definitive "not claimed" answer - never counts toward removal.
			detector.Reset()
			if !errors.Is(err, context.Canceled) {
				slog.Warn("identity reconcile failed; will retry", "err", err)
			}
			continue
		}
		if res.Pending {
			// Definitive clean 404 from a reachable portal while we HOLD a valid
			// identity. Escalate only when sustained (window + consecutive polls).
			if !removed && detector.ObservePending(time.Now()) {
				a.enterRemoved(current)
				removed = true
			}
			continue
		}
		// A real certificate answer: any accumulated clean-404 run is over.
		detector.Reset()
		if res.Changed {
			// Re-claim (usual exit from geraet_entfernt too): adopt the new
			// identity and stand the cloud link back up on the new topics.
			key, cert, ca := e.CertFiles()
			if err := a.adoptIdentity(res.Identity, key, cert, ca); err != nil {
				slog.Error("failed to adopt new device identity", "err", err)
				continue
			}
			current = res.Identity
			removed = false
		} else if removed {
			// The portal serves the SAME identity again after a removal verdict
			// (a false alarm - e.g. a misrouted portal that answered clean 404s
			// for a while). Self-heal: resume buffering and stand the cloud link
			// back up with the unchanged identity (blocking retry, like boot).
			slog.Warn("portal serves the previous identity again after a removal verdict; resuming cloud operation",
				"device_id", current.DeviceID)
			a.resumeFromRemoved()
			key, cert, ca := e.CertFiles()
			if !a.startCloudWithRetry(ctx, current, key, cert, ca) {
				return // ctx cancelled while retrying
			}
			removed = false
		}
	}
}

// enterRemoved transitions into the honest "removed in the cloud" state: tear
// down the cloud publish path (nothing to publish into - the broker ACL grant
// is pulled on unclaim anyway), pause the store-and-forward buffer so it stops
// growing with data that has no claimed identity to go to, and surface
// geraet_entfernt on :8484 + /health. The local identity/keys stay ON DISK -
// a re-claim re-issues against the same key and the reconcile loop (which
// keeps polling) adopts the new identity and resumes normally.
func (a *Agent) enterRemoved(current enroll.Identity) {
	a.teardownLink()
	a.cloudRemoved.Store(true)
	a.State.Update(func(s *state.Snapshot) {
		s.PairingState = string(enroll.StateRemoved)
		s.CloudConnected = false
		s.BufferPaused = true
	})
	slog.Warn("device was removed (unclaimed) in the cloud - sustained 'not claimed' answers from a reachable portal; "+
		"pausing cloud publishing + buffering, keeping identity on disk, polling for a re-claim",
		"device_id", current.DeviceID, "ref", a.State.Get().Ref)
}

// resumeFromRemoved clears the removed state's flags (buffering resumes with
// the next sample). The caller stands the cloud link back up.
func (a *Agent) resumeFromRemoved() {
	a.cloudRemoved.Store(false)
	a.State.Update(func(s *state.Snapshot) {
		s.BufferPaused = false
		if s.PairingState == string(enroll.StateRemoved) {
			s.PairingState = string(enroll.StateCertificateReceived)
		}
	})
}

// adoptIdentity switches the cloud link to a new device identity: the old mTLS
// link is torn down and a fresh one is stood up with the new certificate and
// topics. Reconnecting is REQUIRED - the hardened broker derives the identity
// from the client-cert CN and its ACL only grants that device its own topics,
// so publishing new-device topics over the old connection would be denied. The
// store-and-forward buffer is untouched: pending entries are stamped with the
// current identity at publish time, so they flow to the new device_id.
func (a *Agent) adoptIdentity(id enroll.Identity, keyPath, certPath, caPath string) error {
	a.teardownLink()
	// A re-claim is also the normal exit from geraet_entfernt: buffering
	// resumes and the pairing state leaves "removed" (OnConnect sets verbunden
	// once the broker accepts the new certificate).
	a.cloudRemoved.Store(false)
	a.State.Update(func(s *state.Snapshot) {
		s.TenantID, s.SiteID, s.DeviceID = id.TenantID, id.SiteID, id.DeviceID
		s.MqttHost = id.MqttHost
		s.CloudConnected = false
		s.BufferPaused = false
		if s.PairingState == string(enroll.StateRemoved) {
			s.PairingState = string(enroll.StateCertificateReceived)
		}
	})
	slog.Info("switching cloud link to new device identity", "device_id", id.DeviceID)
	return a.startCloud(id, keyPath, certPath, caPath)
}

// teardownLink stops the current cloud link (and its heartbeat goroutine), if
// any. Shared by identity adoption and the removed-state transition.
func (a *Agent) teardownLink() {
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
}

// pokeReconcile nudges the reconcile loop without blocking.
func (a *Agent) pokeReconcile() {
	select {
	case a.reconcileNow <- struct{}{}:
	default:
	}
}

func (a *Agent) startCloud(id enroll.Identity, keyPath, certPath, caPath string) error {
	// The v2 entity-registry push must match this identity (topic==payload).
	a.setEntityIdentity(id.TenantID, id.SiteID, id.DeviceID)
	link, err := cloud.New(cloud.Options{
		Identity:    id,
		KeyPath:     keyPath,
		CertPath:    certPath,
		CAPath:      caPath,
		DevURL:      a.Cfg.DevCloudURL,
		DevInsecure: a.Cfg.DevInsecure,
		OnSchedule:  a.onSchedule,
		OnCommand:   a.onPurgeCommand,
		OnEntities:  a.onEntityRegistryPush,
		OnPlanV2:    a.onPlanV2,
		OnFlows:     a.onFlows,
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
				if err := link.PublishStatus(src, soc, controlSummary(snap), a.entitiesSummary(),
					a.flowsSummary()); err != nil {
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
		// BatteryPowerKw is the primary inverter's MEASURED battery power
		// (+ charge / - discharge, matching edge/setpoint and the cloud's
		// balance-derived battery_kw). It is an INTERNAL input to the Netz-meter
		// house-load balance below, deliberately NOT a published measurement
		// channel - the cloud contract stays untouched and keeps deriving battery
		// from the power balance.
		BatteryPowerKw *float64 `json:"battery_power_kw"`
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
	// The PRIMARY inverter's OWN reading, captured BEFORE the multi-source
	// aggregation below folds Erzeuger PV / a Netz meter's grid into the
	// composite: the setup page's "Zuletzt gelesen" line shows per-DEVICE
	// values, and with additional sources the composite would misattribute
	// their share to the primary. Committed into the state snapshot only after
	// the gates below KEEP the sample; a gated channel is held to its last
	// accepted primary value there (the same display policy as the composite).
	primary := make(map[string]float64, len(measurements))
	for k, v := range measurements {
		primary[k] = v
	}
	// The measured battery power stays OUT of the measurements map: it feeds
	// the house-load balance below and the LOCAL history ring's battery line
	// (measured, never derived - the decree), but never the cloud buffer or a
	// published measurement channel (the cloud contract keeps deriving battery
	// from the power balance - which, with a balance-derived load, resolves to
	// exactly this measured value).
	battKw := m.BatteryPowerKw
	if battKw != nil && (math.IsNaN(*battKw) || math.IsInf(*battKw, 0)) {
		battKw = nil
	}
	// Register-level cross-check (diagnostic ONLY, never displayed): the
	// balance-derived battery from the primary's own raw registers
	// (grid − load + pv) should agree with the hybrid's measured battery
	// register. A persistent large drift is the signature of a wrong grid
	// register - the captain's hybrid_3p read the config-dependent "Grid
	// Power" alias (inverter-side −23,7) instead of the external CT (−54,2),
	// so the derived battery read 30,5 kW against a measured 0. Rate-limited.
	if battKw != nil {
		pv, okP := primary["pv_power_kw"]
		load, okL := primary["load_kw"]
		grid, okG := primary["power_kw"]
		if okP && okL && okG {
			if drift := grid - load + pv - *battKw; drift > battDriftLogKw || drift < -battDriftLogKw {
				a.mu.Lock()
				quiet := time.Since(a.lastDriftLog) < balanceLogInterval
				if !quiet {
					a.lastDriftLog = time.Now()
				}
				a.mu.Unlock()
				if !quiet {
					slog.Debug("battery cross-check drift: primary's balance-derived battery deviates from the measured register (wrong grid register / sign?)",
						"derived_kw", grid-load+pv, "measured_kw", *battKw)
				}
			}
		}
	}
	// ---- ONE fold order (captain decree 2026-07-17): pv-sum → grid
	// precedence → measured battery → house. -------------------------------
	//
	// Step 1, pv-sum: fold every FRESH additional Erzeuger source's PV into
	// the composite site reading BEFORE the guards run (so the physical
	// envelope, widened to Σ generation nameplate, sees the composite, and the
	// despiker acts on the site total). A stale/absent source contributes
	// nothing (never a fabricated 0), so with zero sources this is a no-op and
	// the single-source path stays byte-for-byte unchanged.
	extraPv, pvMix := a.aggregateSourcePv()
	if extraPv > 0 {
		base := measurements["pv_power_kw"] // 0 when the primary reports no PV
		measurements["pv_power_kw"] = base + extraPv
	}
	// Step 2, grid precedence: the site grid value for the standard house
	// balance. A FRESH dedicated Netz meter at the point of common coupling
	// measures site_grid directly, so its signed value (+import/-export)
	// REPLACES the primary inverter's CT-derived power_kw (the money channel
	// stays install-independent). Without a meter, the primary's own grid
	// reading IS the site grid BY DEFAULT - the standard: a single inverter
	// with no sources trivially measures the connection point, and on the
	// captain's multi-source site the hybrid's external CT sees the AC-coupled
	// Erzeugers' feed-in too. The expert OPT-OUT (sources.BalanceSettings
	// PrimaryGridNotSiteTotal, "Die Netzmessung des Wechselrichters sitzt
	// NICHT am Hausanschluss") declares the genuinely different topology and
	// withdraws the primary's reading from site-grid duty (the raw-load
	// fallback path below applies then).
	g, gridMix := a.authoritativeGrid()
	if g != nil {
		measurements["power_kw"] = *g
	}
	siteGrid := g
	if siteGrid == nil && !a.primaryGridNotSiteTotal() {
		if grid, ok := measurements["power_kw"]; ok {
			grid := grid
			siteGrid = &grid
		}
	}
	// Steps 3+4, measured battery → house: with a site-authoritative grid the
	// house consumption is THE standard
	//
	//	house = pv_total + grid - battery      (battery: + charge/- discharge)
	//
	// i.e. everything generated/imported that did not go into the battery is
	// being consumed. The battery term is the hybrid's MEASURED register
	// (battery_power_kw), never derived from the balance ("Register lesen …
	// nicht berechnen!" - the decree). Honest degradation, per class:
	//   - battery measured, or the primary is PROVABLY batteryless -> the
	//     standard runs;
	//   - a PROVABLE hybrid (FamilyHasBattery) whose standard inputs are
	//     missing this sample (battery register unreadable, no PV) -> the
	//     house is honestly NOT measurable: load_kw is dropped (chart gap),
	//     never an estimate that silently pretends battery = 0;
	//   - an unknown family (no selection, generic Modbus, Fronius Solar API
	//     without a verified battery reading) -> the raw-load fallback path
	//     (the pre-standard estimate), loud-but-rate-limited warned.
	// Without any usable site grid (no meter + opt-out, or a sample without
	// power_kw) the raw-load fallback path applies too.
	if siteGrid != nil {
		if house, ok := a.houseFromBalance(measurements, *siteGrid, battKw); ok {
			measurements["load_kw"] = house
		} else if a.primaryProvableBattery() {
			delete(measurements, "load_kw")
		} else {
			a.fallbackLoad(measurements, extraPv)
		}
	} else {
		a.fallbackLoad(measurements, extraPv)
	}
	// A changed source composition (added/removed source, fresh<->stale flip)
	// resets the spike-gate baselines of the folded channels BEFORE the gates
	// run: the resulting step is explained by configuration, not the device.
	a.noteSourceMix(pvMix, gridMix)
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

	// Feed the PS-3 peak tracker with the gated composite site grid (a despiked
	// channel already carries its last accepted value, so a spike can never
	// poison the quarter mean). A sample without power_kw feeds nothing - the
	// tracker goes stale and the peak guard turns inactive rather than
	// regulating blind.
	if g, ok := measurements["power_kw"]; ok {
		a.peak.Add(ts, g)
	}

	// While the device is removed (unclaimed) in the cloud, the local dashboard
	// stays fully alive (guard reading, history ring, KPIs below) but the
	// store-and-forward buffer is NOT grown: there is no claimed identity to
	// deliver it to, and the cloud deleted the device's data on unclaim anyway.
	// Honest pause (surfaced as BufferPaused) instead of silently piling up
	// data that can never be sent; buffering resumes on re-claim.
	bufferPaused := a.cloudRemoved.Load()
	if !bufferPaused {
		if _, err := a.buf.Append(ts, measurements); err != nil {
			slog.Error("telemetry buffer append failed", "err", err)
			return
		}
	}
	// Feed the in-memory live-chart ring (local dashboard only). An absent
	// measurement stays absent (nil) on the chart, never coerced to 0; a despiked
	// one already carries its last-good value (hold-last), so the line is
	// continuous. The battery line is the MEASURED register (or a physical 0 on
	// a provably batteryless primary) - never the balance derivation; a hybrid
	// whose register is unreadable this sample leaves an honest gap.
	var histBatt *float64
	if battKw != nil {
		histBatt = battKw
	} else if a.primaryBatteryless() {
		zero := 0.0
		histBatt = &zero
	}
	a.hist.Add(history.Sample{
		Ts:          ts,
		PvKw:        ptr("pv_power_kw"),
		LoadKw:      ptr("load_kw"),
		GridKw:      ptr("power_kw"),
		SocPct:      ptr("soc_pct"),
		GridLimitKw: ptr("grid_limit_kw"),
		BattKw:      histBatt,
	})
	a.State.Update(func(s *state.Snapshot) {
		s.LastTelemetry = ts
		s.BufferPending = a.buf.Pending()
		s.BufferDataLoss = a.buf.DataLoss()
		// Commit the primary's own reading for the "Zuletzt gelesen" display.
		// A channel a gate rejected THIS sample holds its last accepted primary
		// value (hold-last, like the composite); with no last-good yet it stays
		// absent - the raw spike value is never displayed.
		for _, d := range drops {
			if _, ok := primary[d.Channel]; !ok {
				continue
			}
			if prev, ok := s.LastReading[d.Channel]; ok {
				primary[d.Channel] = prev
			} else {
				delete(primary, d.Channel)
			}
		}
		s.LastReading = primary
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
	if !bufferPaused {
		a.kick()
	}
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

// controlSummary distils the latest control readback into the compact heartbeat
// block the cloud ingests (report §5.3). Returns nil when no readback exists yet
// (the block is then omitted). commanded/confirmed kW come from the battery_power
// register when present.
func controlSummary(snap state.Snapshot) *cloud.ControlSummary {
	c := snap.Control
	if c == nil {
		return nil
	}
	sum := &cloud.ControlSummary{
		AllMatch:       c.AllMatch,
		ControlEnabled: c.ControlEnabled,
		Certified:      c.Certified,
		SlotStart:      c.SlotStart,
		CheckedAt:      c.CheckedAt.UTC().Format(time.RFC3339Nano),
		MismatchRoles:  c.MismatchRoles,
	}
	if sum.MismatchRoles == nil {
		sum.MismatchRoles = []string{}
	}
	for _, r := range c.Registers {
		if r.Role == "battery_power" {
			sum.CommandedKw = r.CommandedKw
			sum.ConfirmedKw = r.ActualKw
			break
		}
	}
	return sum
}

// onControlReadback ingests one control readback from Layer 1 (edge/control/
// readback): the per-register commanded-vs-actual result of a control write. It
// is stored in the Snapshot for the :8484 "Steuerung & Bestätigung" card and
// folded into the status heartbeat so the cloud sees a compact confirmation
// (report §5). Read-only - it never influences execution.
func (a *Agent) onControlReadback(_ string, payload []byte) {
	var m struct {
		Ts             string   `json:"ts"`
		Family         string   `json:"family"`
		Source         string   `json:"source"`
		SlotStart      string   `json:"slot_start"`
		ControlEnabled bool     `json:"control_enabled"`
		Certified      bool     `json:"certified"`
		AllMatch       bool     `json:"all_match"`
		MismatchRoles  []string `json:"mismatch_roles"`
		Registers      []struct {
			Role         string   `json:"role"`
			Fc           int      `json:"fc"`
			Addr         int      `json:"addr"`
			CommandedRaw int      `json:"commanded_raw"`
			CommandedKw  *float64 `json:"commanded_kw"`
			ActualRaw    int      `json:"actual_raw"`
			ActualKw     *float64 `json:"actual_kw"`
			Match        bool     `json:"match"`
		} `json:"registers"`
	}
	if err := json.Unmarshal(payload, &m); err != nil || len(m.Registers) == 0 {
		slog.Warn("control readback malformed; skipped")
		return
	}
	checkedAt := time.Now().UTC()
	if m.Ts != "" {
		if t, err := time.Parse(time.RFC3339, m.Ts); err == nil {
			checkedAt = t.UTC()
		}
	}
	info := &state.ControlInfo{
		CheckedAt:      checkedAt,
		Family:         m.Family,
		Source:         m.Source,
		SlotStart:      m.SlotStart,
		ControlEnabled: m.ControlEnabled,
		Certified:      m.Certified,
		AllMatch:       m.AllMatch,
		MismatchRoles:  m.MismatchRoles,
	}
	for _, r := range m.Registers {
		info.Registers = append(info.Registers, state.ControlRegister{
			Role: r.Role, Fc: r.Fc, Addr: r.Addr,
			CommandedRaw: r.CommandedRaw, CommandedKw: r.CommandedKw,
			ActualRaw: r.ActualRaw, ActualKw: r.ActualKw, Match: r.Match,
		})
	}
	a.State.Update(func(s *state.Snapshot) { s.Control = info })
	// E2: the register-level proof also surfaces per entity - mirror it onto
	// the battery entity's readback topic (same payload shape, entity contract
	// §4) and record the verdict for the heartbeat. No-op without a registry.
	a.mirrorReadbackToEntity(payload, m.AllMatch)
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

	// P5 EEG execution gap: a plan carrying grid_charge_allowed=false (the
	// site is EEG-funded, site.netzladen_erlaubt) demands the solar-only
	// clamp - charge <= MEASURED pv (PV-bus semantics since FK3: the house
	// may import its load in parallel) - on every commanded setpoint.
	// FAIL-SAFE: the field ABSENT (legacy/hand-crafted payload) or no plan at
	// all also clamps - only an explicit true releases it (the optimizer
	// always publishes the field, so a merchant site's plan is unaffected).
	// The self-consumption fallback follows pv - load and never grid-charges,
	// so the clamp composing into it is a no-op there.
	solarOnly := p.SolarOnlyCharge()

	// PS-3 peak shaving: the LAST plan-carried target/reserve, deliberately
	// surviving plan staleness (the billing peak is a 15-min mean only the edge
	// can defend in closed loop; on a dead cloud link the guard keeps working
	// against the last known target - restrict-only, so it can never widen
	// anything). nil = module off = byte-for-byte pre-PS behavior.
	peakTarget := p.PeakImportLimit()
	peakReserve := p.PeakReserveSoc()
	// The v2 plan's site-level target / battery-entity reserve compose in
	// (tighter wins, both staleness survivors). nil without a v2 plan - the
	// v1 path is then byte-identical.
	if t2 := a.peakTargetV2(); t2 != nil && (peakTarget == nil || *t2 < *peakTarget) {
		peakTarget = t2
	}
	if r2 := a.reserveV2ForBattery(); r2 != nil && (peakReserve == nil || *r2 > *peakReserve) {
		peakReserve = r2
	}

	limits := guards.Limits{
		MaxChargeKw:     a.Cfg.MaxChargeKw,
		MaxDischargeKw:  a.Cfg.MaxDischargeKw,
		SocMinPct:       a.Cfg.SocMinPct,
		SocMaxPct:       a.Cfg.SocMaxPct,
		SolarOnlyCharge: solarOnly,
	}

	var (
		kw        float64
		mode      state.Mode
		source    string
		slotStart time.Time
		pvLimit   *float64
	)
	if raw, start, ok := p.ActiveSetpoint(now); ok {
		kw = guards.Clamp(raw, limits, r)
		mode, source, slotStart = state.ModeSchedule, "schedule", start
		// Forward the slot's PV feed-in cap so a control adapter can execute
		// curtailment (report §4.5). Guard: only-reduce, never negative; cleared
		// (nil) on stale/fallback because ActivePvLimit returns nil there.
		if lim := p.ActivePvLimit(now); lim != nil && *lim >= 0 {
			v := math.Round(*lim*1000) / 1000
			pvLimit = &v
		}
	} else if hasReading {
		fallback := guards.SelfConsumption(r)
		// PS-3 reserve composition: on a stale/absent plan whose last version
		// carried a peak reserve, ORDINARY self-consumption discharge stops at
		// that floor - the old fallback burned the whole battery on ordinary
		// load in the first hours of an outage and left nothing for the real
		// peak. Peak DEFENSE (the PeakShave below) may still discharge below
		// the reserve down to the technical SoC floor: the reserve exists for
		// exactly that. Unknown SoC leaves the fallback untouched (the guards'
		// never-regulate-blind convention); charging is never affected.
		if peakReserve != nil && fallback < 0 && !math.IsNaN(r.SocPct) && r.SocPct <= *peakReserve {
			fallback = 0
		}
		kw = guards.Clamp(fallback, limits, r)
		mode, source = state.ModeSelfConsume, "default"
	} else {
		// No inverter reading at all: publish nothing (mirrors the Node-RED
		// watchdog, which does not write without a reading). The peak module's
		// display state stays honest: target/reserve are known from the plan,
		// but without a reading the guard cannot be active.
		a.State.Update(func(s *state.Snapshot) {
			s.Mode = state.ModeNoReading
			s.PeakTargetKw = peakTarget
			s.PeakReserveSocPct = peakReserve
			s.PeakGuardActive = false
			s.PeakQuarterMeanKw = nil
		})
		return
	}

	// E2 arbitration: the entity's HOLDER drives the physical write path. Its
	// granted value is already clamped through the per-entity guard chain
	// COMPOSED with the v1 device limits (most restrictive wins,
	// internal/desired clampFor), so the certified driver only ever sees a
	// guard-safe value - flows still never write registers. Three cases:
	//   - no registry (batteryEntityID empty) -> nothing here runs, the v1
	//     path is byte-identical;
	//   - holder = plan executor: the injected plan slot (the v1 plan during
	//     the shadow phase, else the v2 plan) executes as source "schedule" -
	//     with a v1 plan this equals the v1 computation above, additionally
	//     bound by the registry guard band (the E1a mirror inconsistency -
	//     command tighter than setpoint - ends here);
	//   - holder = a desired (flow/override/cloud-command): it takes over as
	//     source "desired"; claim unit = the entity, so the plan's pv limit
	//     no longer applies - the holder's own limit does (absent = cleared,
	//     the 1.0 pv_limit clearing rule).
	// The registry FAILSAFE (no holder) deliberately stays with the v1
	// fallback computation above.
	if battID := a.batteryEntityID(); battID != "" {
		if granted, kind, ok := a.arb.HolderCommand(battID); ok && granted.SetpointKw != nil {
			kw = *granted.SetpointKw
			if kind == desired.SourcePlanExecutor {
				mode, source = state.ModeSchedule, "schedule"
			} else {
				mode, source = state.ModeDesired, "desired"
				slotStart = time.Time{}
			}
			pvLimit = nil
			if granted.LimitKw != nil {
				v := *granted.LimitKw
				pvLimit = &v
			}
		}
	}

	// PS-3 peak guard, in BOTH modes (schedule + fallback): when the running
	// wall-clock quarter hour's projected mean import threatens the target,
	// lower the setpoint (raise discharge / reduce charge) so the 15-min mean
	// holds - the local closed loop the 15-min cloud MPC cannot provide. Runs
	// AFTER every compliance clamp and only ever lowers the setpoint, so §14a,
	// EEG solar-only, SoC floor and the rated band are never violated. With no
	// fresh grid measurement the tracker reports inactive - never regulate
	// blind; a missed quarter only costs money, never safety.
	peakActive := false
	var quarterMean *float64
	if peakTarget != nil {
		if allowed, ok := a.peak.AllowedImport(now, *peakTarget); ok {
			kw = guards.PeakShave(kw, allowed, limits, r)
			peakActive = true
		}
		if mean, ok := a.peak.QuarterMean(now); ok {
			m := math.Round(mean*1000) / 1000
			quarterMean = &m
		}
	}

	// Control gate (report §6.6/§6.7): the setpoint carries the core's kill-switch
	// AND per-model certification verdict as control_enabled. Layer 1 writes only
	// when this is true (defence in depth with its own family allowlist). OFF by
	// default - no inverter is driven until an operator enables control.
	a.invMu.Lock()
	family := ""
	if a.inv != nil {
		family = a.inv.Family
	}
	a.invMu.Unlock()
	certified := a.Cfg.ControlCertified(family)
	controlEnabled := a.Cfg.ControlEnabled && certified

	msg := map[string]any{
		"battery_setpoint_kw": kw,
		"source":              source,
		"ts":                  now.Format(time.RFC3339Nano),
		"control_enabled":     controlEnabled,
		// Most restrictive wins: the device-local VP_GRID_CHARGE_ALLOWED gate
		// AND the plan-carried site posture (an EEG plan also turns off the
		// adapter-level grid-charge bit, e.g. Deye ToU Charging=Grid). A plan
		// without the field - or no plan - is fail-safe: the bit stays off
		// until a plan explicitly allows grid charging.
		"grid_charge_allowed": a.Cfg.GridChargeAllowed && !solarOnly,
		"soc_min_pct":         a.Cfg.SocMinPct,
	}
	// pv_limit_kw is only present when the active slot caps feed-in; its ABSENCE
	// tells the adapter to clear any latched limit (backward-compatible: an
	// adapter that ignores the field keeps working).
	if pvLimit != nil {
		msg["pv_limit_kw"] = *pvLimit
	}
	if !slotStart.IsZero() {
		msg["slot_start"] = slotStart.UTC().Format(time.RFC3339)
	}
	raw, _ := json.Marshal(msg)
	if err := a.Bus.Publish(localbus.TopicSetpoint, raw, true); err != nil {
		slog.Error("setpoint publish failed", "err", err)
		return
	}
	// The per-entity retained command is owned by the ARBITER since E2 (the
	// plan executor injects the plan as market desires, the failsafe is the
	// arbiter's registry fallback) - the E1a applySetpoint-side mirror is
	// retired; without a pushed registry neither path publishes anything.
	a.State.Update(func(s *state.Snapshot) {
		s.Mode = mode
		s.SetpointKw = kw
		s.SlotStart = slotStart
		s.ControlEnabled = controlEnabled
		s.ControlCertified = certified
		s.PeakTargetKw = peakTarget
		s.PeakReserveSocPct = peakReserve
		s.PeakGuardActive = peakActive
		s.PeakQuarterMeanKw = quarterMean
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
			// One buffer, two eras (E1b): an entry with an EntityID is a v2
			// per-entity sample, everything else the v1 site sample.
			publish := link.PublishTelemetry
			if e.EntityID != "" {
				publish = link.PublishTelemetryV2
			}
			if err := publish(e); err != nil {
				slog.Warn("telemetry publish failed; will retry", "seq", e.Seq, "err", err)
				break
			}
			if err := a.buf.Ack(e.Seq); err != nil {
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

// CurrentPlan returns the cached battery-dispatch plan projected for "now" (the
// local Fahrplan view): its slots, freshness and the executing slot. ok=false
// when no plan has been received/cached yet. Read-only - it never influences
// execution (that stays with applySetpoint over the same cached plan).
func (a *Agent) CurrentPlan() (plan.View, bool) {
	a.mu.Lock()
	p := a.currentPlan
	a.mu.Unlock()
	if p == nil {
		return plan.View{}, false
	}
	return p.BuildView(time.Now().UTC()), true
}

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

// reapplyEnvelope reconfigures the physical envelope from the CURRENT primary
// selection plus the additional sources - called whenever either changes.
func (a *Agent) reapplyEnvelope() {
	a.invMu.Lock()
	sel := a.inv
	a.invMu.Unlock()
	a.applyEnvelope(sel)
}

// applyEnvelope (re)configures the physical-plausibility envelope from the
// selected inverter model AND the additional generation sources: the PV bound is
// Σ generation nameplate (the primary's rating plus every Erzeuger source's kWp)
// so a legitimate multi-source PV total is never "despiked"; the derived-battery
// bound stays the primary's rating alone (only the battery-hybrid moves the
// battery). Enforced regardless of the operator's despike preset. With no known
// rating anywhere the envelope stays inactive (bounds 0).
func (a *Agent) applyEnvelope(sel *inverter.Selection) {
	if a.envelope == nil {
		return
	}
	var pvRated, maxBatt float64
	if sel != nil {
		if rated, ok := a.invCat.RatedKw(sel.Brand, sel.Model); ok {
			pvRated += rated
			_, maxBatt = guards.EnvelopeFor(rated, inverter.FamilyHasBattery(sel.Family))
		}
	}
	unknownKwp := false
	a.srcMu.Lock()
	for _, s := range a.srcs {
		if s.Role != sources.RoleErzeuger {
			continue
		}
		if s.CapacityKwp > 0 {
			pvRated += s.CapacityKwp
		} else {
			// An Erzeuger without a nameplate contributes REAL power the bound
			// cannot account for - a stated bound would clip a legitimate
			// composite (hold a delivering source's share). No honest PV bound
			// exists then; the operator enters the source's kWp to restore it.
			unknownKwp = true
		}
	}
	nSrc := len(a.srcs)
	a.srcMu.Unlock()
	maxPv := guards.EnvelopePvBound(pvRated)
	if unknownKwp {
		maxPv = 0
	}
	a.envelope.SetBounds(maxPv, maxBatt)
	slog.Info("physical envelope configured", "max_pv_kw", maxPv, "max_battery_kw", maxBatt,
		"sources", nSrc, "erzeuger_without_kwp", unknownKwp)
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

// --- Additional read-only measurement points (Erzeuger/PV) ---

// sourceReading is the latest reading kept per additional source: its PV (kW,
// for an Erzeuger), its signed grid power (kW, +import/-export, for a Netz
// meter) and the wall-clock time it arrived (for freshness / error isolation,
// decoupled from any device clock). A role only ever populates its own field;
// the other stays nil.
type sourceReading struct {
	pv   *float64
	grid *float64
	recv time.Time
	// period is the ACHIEVED read cadence: the wall-clock spacing between this
	// reading and the previous one (0 until a second reading arrived). The
	// freshness window derives from it, because the configured interval_s is a
	// wish, not reality: two SunSpec sources behind one slow Fronius Datamanager
	// are read strictly sequentially with a full model-discovery walk each, so
	// the real cadence can be 30-60+ s - far beyond 3*interval_s - and a fixed
	// window would drop a perfectly delivering source in and out of the
	// aggregation (the captain's WR2 missing from the PV tile).
	period time.Duration
}

// sourceStaleFloor is the minimum freshness window: a source whose last reading
// is older than max(3*interval, 3*achieved period, this) is treated as absent
// (contributes nothing), so one dead AC-PV inverter never blanks the composite -
// it just stops adding its share.
const sourceStaleFloor = 60 * time.Second

// sourceStaleCap bounds the achieved-cadence widening of the freshness window: a
// source is never considered fresh longer than this after its last reading, so
// even a source whose last observed period was huge (an outage between two
// reads) goes honestly stale within a bounded time once it truly dies.
const sourceStaleCap = 15 * time.Minute

// onSourceTelemetry ingests one additional source's reading (edge/sources/{id}/
// telemetry): keep the latest PV and/or signed grid power per source, by role.
// An Erzeuger carries pv_power_kw; a Netz meter carries power_kw (signed,
// +import/-export). It never fabricates a value - an absent/invalid field is
// simply not recorded, so the source contributes nothing; a reading with no
// usable field at all is dropped entirely (never advances freshness).
func (a *Agent) onSourceTelemetry(topic string, payload []byte) {
	id := sources.IDFromTopic(topic)
	if id == "" {
		slog.Warn("source telemetry on unexpected topic; skipped", "topic", topic)
		return
	}
	var m struct {
		PvPowerKw *float64 `json:"pv_power_kw"`
		PowerKw   *float64 `json:"power_kw"`
	}
	if err := json.Unmarshal(payload, &m); err != nil {
		slog.Warn("source telemetry malformed; skipped", "id", id, "err", err)
		return
	}
	usable := func(v *float64) *float64 {
		if v == nil || math.IsNaN(*v) || math.IsInf(*v, 0) {
			return nil // stay absent, never a fabricated 0
		}
		return v
	}
	pv, grid := usable(m.PvPowerKw), usable(m.PowerKw)
	if pv == nil && grid == nil {
		return // nothing usable in this reading
	}
	now := time.Now().UTC()
	a.srcMu.Lock()
	var period time.Duration
	if prev, ok := a.srcReadings[id]; ok && !prev.recv.IsZero() {
		period = now.Sub(prev.recv) // the ACHIEVED cadence, feeds the freshness window
	}
	a.srcReadings[id] = sourceReading{pv: pv, grid: grid, recv: now, period: period}
	a.srcMu.Unlock()
}

// sourceFresh reports whether a source's last reading is within its freshness
// window; ok=false when there is no reading yet. Callers hold a.srcMu.
//
// The window is max(3*interval_s, 3*achieved period, sourceStaleFloor), capped
// at sourceStaleCap. The achieved-period term is load-bearing (real prod bug,
// captain's site 2026-07-17): two fronius_sunspec sources behind ONE slow
// Datamanager are read strictly sequentially with a full SunSpec walk each, so
// the real per-source cadence can far exceed the configured interval; with a
// fixed 60-s window a DELIVERING source flapped in and out of the aggregation,
// the composite PV oscillated (72,6 <-> 45,7 kW), the despiker's confirmation
// candidate kept resetting, and the dashboard tile froze at primary+WR1 while
// WR2's 26,9 kW silently vanished from the sum. A delivering source must NEVER
// be dropped for merely being read slowly - the window follows the cadence the
// reads actually achieve, and staleness means "missed ~3 of its own reads".
func (a *Agent) sourceFresh(s sources.Source, now time.Time) (sourceReading, bool) {
	r, ok := a.srcReadings[s.ID]
	if !ok {
		return sourceReading{}, false
	}
	window := time.Duration(3*s.IntervalS) * time.Second
	if window < sourceStaleFloor {
		window = sourceStaleFloor
	}
	if achieved := 3 * r.period; achieved > window {
		window = achieved
	}
	if window > sourceStaleCap {
		window = sourceStaleCap
	}
	if now.Sub(r.recv) > window {
		return sourceReading{}, false
	}
	return r, true
}

// aggregateSourcePv sums the PV of every fresh Erzeuger source. A source with no
// reading yet, or a stale one, is skipped (absent, not zero). The second return
// is the composition signature - which source ids actually contributed - so the
// caller can detect a composition CHANGE (a step in the composite that is
// explained by configuration/freshness, not by the device) and reset the
// despiker/envelope baselines for the affected channels. The sum deliberately
// never depends on capacity_kwp - a kWp-less source contributes its full
// measured PV (kWp only feeds the physical-envelope bound).
func (a *Agent) aggregateSourcePv() (float64, string) {
	now := time.Now().UTC()
	a.srcMu.Lock()
	defer a.srcMu.Unlock()
	var sum float64
	var mix []string
	for _, s := range a.srcs {
		if s.Role != sources.RoleErzeuger {
			continue
		}
		r, ok := a.sourceFresh(s, now)
		if !ok || r.pv == nil {
			continue
		}
		sum += *r.pv
		mix = append(mix, s.ID)
	}
	return sum, strings.Join(mix, ",")
}

// authoritativeGrid returns the signed grid power (kW, +import/-export) from the
// newest FRESH Netz (grid-meter) source, or nil when no such fresh reading
// exists. A dedicated meter at the point of common coupling measures site_grid
// directly, so its value OVERRIDES the primary hybrid inverter's CT-derived
// power_kw; a stale/absent meter falls back to the primary CT (graceful
// degradation, never a fabricated value). With 0-1 Netz per site (enforced in
// the portal) "newest" is a safety net for a misconfigured pair, not a real
// aggregation.
func (a *Agent) authoritativeGrid() (*float64, string) {
	now := time.Now().UTC()
	a.srcMu.Lock()
	defer a.srcMu.Unlock()
	var best *sourceReading
	var bestID string
	for _, s := range a.srcs {
		if s.Role != sources.RoleNetz {
			continue
		}
		r, ok := a.sourceFresh(s, now)
		if !ok || r.grid == nil {
			continue
		}
		if best == nil || r.recv.After(best.recv) {
			rr := r
			best = &rr
			bestID = s.ID
		}
	}
	if best == nil {
		return nil, ""
	}
	return best.grid, bestID
}

// noteSourceMix compares the fold's source-composition signatures with the last
// fold's and, on a CHANGE, resets the despiker + envelope baselines of the
// channels the changed composition rewrites (PV mix -> pv_power_kw + load_kw;
// grid mix -> power_kw + load_kw). A composition change is an EXPLAINED
// discontinuity - a source was added/removed or flipped fresh<->stale - not a
// device spike: without the reset a strict despike preset holds the new
// composite level, and an oscillating composition keeps restarting the
// confirmation candidate so the displayed value can freeze forever (the
// captain's PV tile stuck at 45,4 kW while WR2 delivered 26,9 kW).
func (a *Agent) noteSourceMix(pvMix, gridMix string) {
	a.srcMu.Lock()
	pvChanged := pvMix != a.lastPvMix
	gridChanged := gridMix != a.lastGridMix
	a.lastPvMix = pvMix
	a.lastGridMix = gridMix
	a.srcMu.Unlock()
	if !pvChanged && !gridChanged {
		return
	}
	chans := map[string]bool{"load_kw": true}
	if pvChanged {
		chans["pv_power_kw"] = true
	}
	if gridChanged {
		chans["power_kw"] = true
	}
	keys := make([]string, 0, len(chans))
	for k := range chans {
		keys = append(keys, k)
	}
	if a.despiker != nil {
		a.despiker.ResetChannels(keys...)
	}
	if a.envelope != nil {
		a.envelope.ResetChannels(keys...)
	}
	slog.Info("source composition changed; spike-gate baselines reset",
		"pv_mix", pvMix, "grid_mix", gridMix, "channels", keys)
}

// fallbackLoad is the raw-load path - the ONLY surviving consumer of the
// primary's own load register: without a usable site grid value (expert
// opt-out with no meter, or a sample without power_kw), or when the standard's
// inputs are honestly unavailable on a primary that merely MAY have a battery,
// the primary's load reading is the best available estimate. With additional
// Erzeuger sources it is corrected (the #155 netting) - which way depends on
// where the primary's load figure comes from, two real topologies:
//
//	(+) the primary misattributes the AC PV's production TO load
//	    (load_reg = house + Σac, the original 46,7-kW bug) -> subtract;
//	(−) the primary's grid CT sits at the site coupling point, so its
//	    internally-balanced load figure already NETS the AC PV OUT
//	    (load_reg = pv_p + grid_site − batt = house − Σac) -> ADD.
//
// A load figure ≥ 0 is ambiguous between the two (only a Netz meter or the
// standard balance resolves it); the established subtraction stays. But a
// MEANINGFULLY NEGATIVE load figure falsifies (+) outright (house + Σac can
// never be negative) and proves (−): the derivable house is load + Σac. The
// 1-kW deadband keeps plain measurement noise around zero on the established
// branch. Without sources the raw load passes through unchanged (the plain
// single-inverter case, where the register IS the best local truth).
func (a *Agent) fallbackLoad(measurements map[string]float64, extraPv float64) {
	if extraPv <= 0 {
		return
	}
	load, ok := measurements["load_kw"]
	if !ok {
		return
	}
	corrected := load - extraPv
	if load < -negLoadProofKw {
		corrected = load + extraPv
	}
	if corrected < 0 {
		corrected = 0
	}
	measurements["load_kw"] = corrected
}

// houseFromBalance computes the TRUE house consumption from the site power
// balance once a site-authoritative grid value exists - either a fresh Netz
// (grid-meter) reading, or (the default-on standard, opt-out via
// sources.BalanceSettings PrimaryGridNotSiteTotal) the primary inverter's own
// grid CT at the point of common coupling:
//
//	house = pv_total + grid - battery
//
// with pv_total the composite site PV (primary + fresh Erzeuger, already folded
// into measurements), grid the site's signed grid exchange (+import/-export)
// and battery the primary's MEASURED battery power (+charge/-discharge). With a
// battery-hybrid primary PLUS a separate AC-coupled PV, NEITHER device measures
// the house directly and the Erzeuger load-subtraction clamps to 0 behind a
// large AC PV ("Hausverbrauch 0,0 kW" masking real consumption) - a grid value
// that truly covers the whole site closes the balance. ok=false leaves the
// house to the caller's honesty policy (dropped for a provable hybrid,
// raw-load fallback otherwise) when a needed signal is honestly unavailable:
// no composite PV in the sample, or an UNKNOWN battery power (battery power
// missing while the primary is not provably batteryless - only
// string/micro/SunSpec-live families count battery as a physical 0). Small
// negative results are measurement noise around a balanced node and clamp to 0;
// house consumption is never negative.
func (a *Agent) houseFromBalance(measurements map[string]float64, grid float64, batt *float64) (float64, bool) {
	pv, ok := measurements["pv_power_kw"]
	if !ok {
		return 0, false
	}
	var battKw float64
	switch {
	case batt != nil:
		battKw = *batt
	case a.primaryBatteryless():
		battKw = 0 // a grid-tie primary has no battery: 0 is a fact, not a guess
	default:
		// A (possible) battery whose power this sample does not carry: the
		// balance would be wrong by the full battery power, so keep the estimate.
		// Loud but rate-limited - a Netz meter / the site-total toggle is
		// configured precisely for the accurate house figure, so silently staying
		// on the estimate would look like the feature not working (e.g. a Layer-1
		// flow predating battery_power_kw on the local bus).
		a.mu.Lock()
		quiet := time.Since(a.lastBalanceLog) < balanceLogInterval
		if !quiet {
			a.lastBalanceLog = time.Now()
		}
		a.mu.Unlock()
		if !quiet {
			slog.Warn("site grid is authoritative (Netz meter or primary CT declared site-total) but the primary " +
				"sample carries no battery_power_kw; house load stays the estimate " +
				"(update the Node-RED flows / wire battery power onto edge/telemetry)")
		}
		return 0, false
	}
	house := pv + grid - battKw
	if house < 0 {
		house = 0
	}
	return house, true
}

// balanceLogInterval rate-limits the house-balance fallback warning.
const balanceLogInterval = 5 * time.Minute

// battDriftLogKw: the tolerance of the battery cross-check diagnostic - a
// primary whose balance-derived battery deviates from the measured register by
// more than this is flagged (rate-limited debug). Generous enough for register
// rounding + phase-timing skew between the read blocks.
const battDriftLogKw = 2.0

// negLoadProofKw: a primary load figure below -this (with Erzeuger PV present)
// PROVES the primary's load figure nets the AC PV out (see the fold's topology
// comment); mere noise around zero stays on the established subtraction branch.
const negLoadProofKw = 1.0

// primaryBatteryless reports whether the configured primary inverter PROVABLY
// has no battery (see inverter.FamilyBatteryless). No selection = unknown,
// never assumed batteryless.
func (a *Agent) primaryBatteryless() bool {
	a.invMu.Lock()
	defer a.invMu.Unlock()
	return a.inv != nil && inverter.FamilyBatteryless(a.inv.Family)
}

// primaryProvableBattery reports whether the configured primary inverter
// PROVABLY has a battery (a hybrid register-map family). For such a device the
// battery power is a register to READ; when the sample does not carry it, the
// house is honestly not measurable - never estimated (see the fold).
func (a *Agent) primaryProvableBattery() bool {
	a.invMu.Lock()
	defer a.invMu.Unlock()
	return a.inv != nil && inverter.FamilyHasBattery(a.inv.Family)
}

// primaryGridNotSiteTotal reports the operator-declared EXPERT OPT-OUT from
// the house-consumption standard: the primary inverter's grid CT does NOT sit
// at the site connection point, so its power_kw must not serve as the site
// grid. Default false = the standard runs off the primary's grid reading
// whenever no dedicated Netz meter is authoritative.
func (a *Agent) primaryGridNotSiteTotal() bool {
	a.srcMu.Lock()
	defer a.srcMu.Unlock()
	return a.bal.PrimaryGridNotSiteTotal
}

// GetBalance returns the site power-balance settings (web.SourcesController).
func (a *Agent) GetBalance() sources.BalanceSettings {
	a.srcMu.Lock()
	defer a.srcMu.Unlock()
	return a.bal
}

// SetBalance persists the site power-balance settings and applies them live
// (the next telemetry sample already uses them; no restart needed).
func (a *Agent) SetBalance(cfg sources.BalanceSettings) (sources.BalanceSettings, error) {
	if err := a.balStore.Save(cfg); err != nil {
		return sources.BalanceSettings{}, err
	}
	a.srcMu.Lock()
	a.bal = cfg
	a.srcMu.Unlock()
	slog.Info("balance settings updated", "primary_grid_not_site_total", cfg.PrimaryGridNotSiteTotal)
	return cfg, nil
}

// ListSources returns a copy of the configured additional sources.
func (a *Agent) ListSources() []sources.Source {
	a.srcMu.Lock()
	defer a.srcMu.Unlock()
	return append([]sources.Source(nil), a.srcs...)
}

// SourceStatuses reports the live delivery status per source id, so the web app
// can render the ok/warn/pending dot next to each source (the freshness
// machinery already exists internally; this surfaces it):
//   - "ok"      the source delivered a reading within its freshness window,
//   - "warn"    a reading arrived once but is now stale (window elapsed),
//   - "pending" no reading has ever arrived (waiting for first data).
//
// It never fabricates a value - "pending" is the honest state for a source the
// flow has not yet read.
func (a *Agent) SourceStatuses() map[string]string {
	now := time.Now().UTC()
	a.srcMu.Lock()
	defer a.srcMu.Unlock()
	out := make(map[string]string, len(a.srcs))
	for _, s := range a.srcs {
		if _, ok := a.srcReadings[s.ID]; !ok {
			out[s.ID] = "pending"
			continue
		}
		if _, fresh := a.sourceFresh(s, now); fresh {
			out[s.ID] = "ok"
		} else {
			out[s.ID] = "warn"
		}
	}
	return out
}

// SourceLastReadings maps each configured source id to its most recent accepted
// reading (per-channel value + wall-clock receive time) for the setup page's
// "Zuletzt gelesen" line - the freshness machinery (srcReadings) already tracks
// exactly this, so this only surfaces it. A source that never delivered is
// ABSENT from the map (the page keeps its honest "Wartet auf erste Daten"
// state, never a fabricated value); a stale reading stays included - its
// timestamp says how old it is, and SourceStatuses already flags it "warn".
// Read-only display data; nothing downstream consumes it.
func (a *Agent) SourceLastReadings() map[string]sources.LastReading {
	a.srcMu.Lock()
	defer a.srcMu.Unlock()
	out := make(map[string]sources.LastReading, len(a.srcReadings))
	for _, s := range a.srcs {
		r, ok := a.srcReadings[s.ID]
		if !ok {
			continue
		}
		out[s.ID] = sources.LastReading{
			PvKw:     r.pv,
			PowerKw:  r.grid,
			ReadAtMs: r.recv.UnixMilli(),
		}
	}
	return out
}

// --- "Verbindung testen" one-shot connection probe ---

// testReadTimeout bounds a single "Verbindung testen" round-trip. It matches the
// solarman-probe default (8 s) plus headroom for the flow's own socket timeout.
// A var (not const) so tests can shorten it.
var testReadTimeout = 10 * time.Second

// TestConnection reads the given UNSAVED connection form ONCE and returns the
// decoded values or a classified error. It never persists or publishes any
// config and never blocks Speichern - it is a confidence check. The actual read
// runs in Node-RED via the same route()+decode the self-wiring poll uses
// (edge/test-read/request -> edge/test-read/result), correlated by request id.
func (a *Agent) TestConnection(req testconn.Request) testconn.Result {
	// Normalize the form against the catalog to derive communication/family and
	// validate the connection, exactly like a save would - but persist nothing.
	connRaw, _ := json.Marshal(req.Connection)
	var conn inverter.Connection
	_ = json.Unmarshal(connRaw, &conn)
	sel, err := a.invCat.Normalize(inverter.SelectionRequest{
		Brand:      req.Brand,
		Model:      req.Model,
		Family:     req.Family,
		Connection: conn,
	}, time.Now())
	if err != nil {
		msg := "Die Verbindungsdaten sind unvollständig."
		var ve *inverter.ValidationError
		if errors.As(err, &ve) {
			msg = ve.Msg
		}
		return testconn.Result{OK: false, ErrorCode: testconn.ErrInvalidRequest, Message: msg}
	}
	return a.testReadExchange(sel, req.Role, false, testReadTimeout)
}

// probeUnitsTimeout bounds the multi-inverter unit-ID probe round-trip. Wider
// than testReadTimeout: the flow scans up to 10 unit ids (one SID read each,
// short per-id timeout, 12-s overall flow budget) instead of one read.
// A var (not const) so tests can shorten it.
var probeUnitsTimeout = 15 * time.Second

// ProbeUnits scans the UNSAVED connection form's address for FURTHER SunSpec
// inverter unit ids (multi-inverter at one Fronius Datamanager; convention:
// inverter number = Modbus unit id). Bounded, read-only, never persists
// anything; only meaningful for fronius_sunspec connections - every other
// transport is refused as invalid_request before any I/O. The scan itself runs
// in Node-RED (edge/test-read/request with probe_units=true), reusing the
// one-shot test-read machinery and correlation.
func (a *Agent) ProbeUnits(req testconn.Request) testconn.Result {
	connRaw, _ := json.Marshal(req.Connection)
	var conn inverter.Connection
	_ = json.Unmarshal(connRaw, &conn)
	sel, err := a.invCat.Normalize(inverter.SelectionRequest{
		Brand:      req.Brand,
		Model:      req.Model,
		Family:     req.Family,
		Connection: conn,
	}, time.Now())
	if err != nil {
		msg := "Die Verbindungsdaten sind unvollständig."
		var ve *inverter.ValidationError
		if errors.As(err, &ve) {
			msg = ve.Msg
		}
		return testconn.Result{OK: false, ErrorCode: testconn.ErrInvalidRequest, Message: msg}
	}
	if sel.Communication != inverter.CommFroniusSunSpec {
		return testconn.Result{OK: false, ErrorCode: testconn.ErrInvalidRequest,
			Message: "Die Suche nach weiteren Wechselrichtern gibt es nur für SunSpec (Modbus TCP)."}
	}
	return a.testReadExchange(sel, req.Role, true, probeUnitsTimeout)
}

// testReadExchange runs one correlated request/response round trip over the
// local bus test-read topics (shared by TestConnection and ProbeUnits; probe
// adds probe_units=true so the flow scans unit ids instead of reading once).
func (a *Agent) testReadExchange(sel inverter.Selection, role string, probe bool, timeout time.Duration) testconn.Result {
	if a.Bus == nil {
		return testconn.Result{OK: false, ErrorCode: testconn.ErrTimeout, Message: "Die Prüfung ist derzeit nicht möglich."}
	}

	id := newTestReadID()
	ch := make(chan testconn.Result, 1)
	a.testMu.Lock()
	a.testReads[id] = ch
	a.testMu.Unlock()
	defer func() {
		a.testMu.Lock()
		delete(a.testReads, id)
		a.testMu.Unlock()
	}()

	var payload map[string]any
	_ = json.Unmarshal(sel.BusPayload(), &payload)
	payload["request_id"] = id
	if role = strings.TrimSpace(role); role != "" {
		payload["role"] = role
	}
	if probe {
		payload["probe_units"] = true
	}
	raw, _ := json.Marshal(payload)
	if err := a.Bus.Publish(localbus.TopicTestReadRequest, raw, false); err != nil {
		return testconn.Result{OK: false, ErrorCode: testconn.ErrTimeout, Message: "Die Prüfung konnte nicht gestartet werden."}
	}

	select {
	case res := <-ch:
		return res
	case <-time.After(timeout):
		return testconn.Result{OK: false, ErrorCode: testconn.ErrTimeout}
	}
}

// onTestReadResult routes a one-shot test-read result from Node-RED to the
// waiting TestConnection/ProbeUnits call by request id. Unknown/expired ids are
// dropped (the handler already timed out and left); the buffered channel +
// non-blocking send mean this never blocks the bus.
func (a *Agent) onTestReadResult(_ string, payload []byte) {
	var m struct {
		RequestID  string            `json:"request_id"`
		OK         bool              `json:"ok"`
		ErrorCode  string            `json:"error_code"`
		Message    string            `json:"message"`
		Reading    *testconn.Reading `json:"reading"`
		FoundUnits []int             `json:"found_units"`
	}
	if err := json.Unmarshal(payload, &m); err != nil || m.RequestID == "" {
		slog.Warn("test-read result malformed; skipped")
		return
	}
	a.testMu.Lock()
	ch := a.testReads[m.RequestID]
	a.testMu.Unlock()
	if ch == nil {
		return // unknown / already-timed-out request
	}
	select {
	case ch <- testconn.Result{OK: m.OK, ErrorCode: m.ErrorCode, Message: m.Message, Reading: m.Reading, FoundUnits: m.FoundUnits}:
	default:
	}
}

// newTestReadID returns a short random correlation id for a test-read round-trip.
func newTestReadID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "tr-" + hex.EncodeToString(b)
}

// AddSource validates a request against the catalog, assigns a stable id,
// persists it, re-publishes the retained source config for Node-RED, and widens
// the physical envelope. A bad request returns a *sources.ValidationError (the
// web layer maps it to HTTP 400). READ-ONLY by construction: a source never gets
// a control topic.
func (a *Agent) AddSource(req sources.Request) (sources.Source, error) {
	src, err := sources.Normalize(a.invCat, req, time.Now())
	if err != nil {
		return sources.Source{}, err
	}
	src.ID = sources.NewID()
	a.srcMu.Lock()
	a.srcs = append(a.srcs, src)
	list := append([]sources.Source(nil), a.srcs...)
	a.srcMu.Unlock()
	if err := a.srcStore.Save(list); err != nil {
		// Roll back the in-memory add so disk + memory stay consistent.
		a.srcMu.Lock()
		a.srcs = removeSourceByID(a.srcs, src.ID)
		a.srcMu.Unlock()
		return sources.Source{}, fmt.Errorf("Energiequelle konnte nicht gespeichert werden: %w", err)
	}
	a.publishSourcesConfig()
	a.reapplyEnvelope()
	slog.Info("measurement point added", "id", src.ID, "role", src.Role,
		"brand", src.Brand, "family", src.Family, "capacity_kwp", src.CapacityKwp)
	return src, nil
}

// DeleteSource removes an additional source by id, persists, re-publishes the
// retained config and re-applies the envelope. Unknown id -> sources.ErrNotFound.
// A failed persist rolls the in-memory removal back (mirroring AddSource), so
// memory, disk and the retained Node-RED config never diverge: without the
// rollback, aggregation would stop summing the Erzeuger (site load jumps)
// while Node-RED keeps reading it and a reboot resurrects it.
func (a *Agent) DeleteSource(id string) error {
	a.srcMu.Lock()
	var removed *sources.Source
	for i := range a.srcs {
		if a.srcs[i].ID == id {
			s := a.srcs[i]
			removed = &s
			break
		}
	}
	if removed == nil {
		a.srcMu.Unlock()
		return sources.ErrNotFound
	}
	a.srcs = removeSourceByID(a.srcs, id)
	reading, hadReading := a.srcReadings[id]
	delete(a.srcReadings, id)
	list := append([]sources.Source(nil), a.srcs...)
	a.srcMu.Unlock()
	if err := a.srcStore.Save(list); err != nil {
		// Roll back the in-memory removal so disk + memory stay consistent.
		a.srcMu.Lock()
		a.srcs = append(a.srcs, *removed)
		if hadReading {
			a.srcReadings[id] = reading
		}
		a.srcMu.Unlock()
		return fmt.Errorf("Energiequelle konnte nicht entfernt werden: %w", err)
	}
	a.publishSourcesConfig()
	a.reapplyEnvelope()
	slog.Info("measurement point removed", "id", id)
	return nil
}

func removeSourceByID(list []sources.Source, id string) []sources.Source {
	out := list[:0:0]
	for _, s := range list {
		if s.ID != id {
			out = append(out, s)
		}
	}
	return out
}

// publishSourcesConfig publishes the current source list retained on the local
// bus (empty array clears it). No-op when the bus is not up yet.
func (a *Agent) publishSourcesConfig() {
	if a.Bus == nil {
		return
	}
	a.srcMu.Lock()
	list := append([]sources.Source(nil), a.srcs...)
	a.srcMu.Unlock()
	if err := a.Bus.Publish(sources.TopicConfig, sources.BusConfig(list), true); err != nil {
		slog.Error("source config publish failed", "err", err)
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
