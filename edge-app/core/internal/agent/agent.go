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
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/buffer"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/calibration"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/componentapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/controlcert"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/curtailcal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flexfallback"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flowdeploy"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/goe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/history"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/installerwrite"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/mirror"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/netinfo"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan2"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/registerwrite"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shelly"
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

	buf                 *buffer.Buffer
	hist                *history.Ring
	planStore           *plan.Store
	invStore            *inverter.Store
	invCat              inverter.Catalog
	measurementOutbox   *measurements.Outbox
	measurementMu       sync.Mutex
	measurementIdentity measurements.Identity
	measurementRevision int64
	measurementConfig   []byte

	mu            sync.Mutex
	currentPlan   *plan.Plan
	lastReading   guards.Reading
	lastReadingAt time.Time
	lastRawSoc    *float64

	// net answers "under which address is my box reachable" - the ONE fact the
	// box could never say about itself (D5). It records the Host header of
	// every request that reaches the local web app (see internal/netinfo) and
	// rides the heartbeat; it is DISPLAY ONLY and reaches no decision.
	net *netinfo.Store

	despiker *guards.Despiker
	envelope *guards.Envelope
	// peak tracks the running wall-clock quarter hour's mean grid import for
	// the PS-3 peak guard (fed with the gated composite power_kw at
	// onLocalTelemetry, read at applySetpoint). Concurrency-safe internally.
	peak *guards.PeakTracker
	// trim holds the hysteresis of the price-aware in-slot trim: in a slot the
	// cloud marked charge_from_surplus_only the commanded CHARGE is capped to the
	// MEASURED surplus, so a forecast shortfall is no longer covered from the
	// grid (guards.PriceTrimmer - the edge enforces, the cloud priced).
	trim *guards.PriceTrimmer
	// follow holds the hysteresis of the in-slot load following: in a slot the
	// cloud marked cover_load_from_battery the commanded DISCHARGE is raised to
	// the MEASURED house deficit, so an under-forecast quarter hour is no longer
	// covered from the grid (guards.LoadFollower - the discharge-side mirror of
	// trim; the edge enforces, the cloud priced).
	follow *guards.LoadFollower
	// absorb holds the hysteresis of the in-slot surplus absorption: in a slot the
	// cloud marked charge_surplus_to_battery the commanded CHARGE is RAISED to the
	// MEASURED PV surplus, so a surplus the 15-min forecast never saw is stored
	// instead of exported - at a negative price, paid away (guards.SurplusCharger -
	// the charge-side counterpart of trim, which only ever lowers; the edge
	// enforces, the cloud priced).
	absorb *guards.SurplusCharger
	// native carries the per-slot supervision of the NATIVE SELF-REGULATION: in
	// a covering slot the setpoint itself is handed back to the inverter, which
	// then decides its own watts - and this type is what takes it back at the
	// reserve floor, on a threatened billing peak, on a lost measurement/readback
	// and when the device never confirms the mode (guards/nativemode.go). Never a
	// failsafe: on any doubt the proven 10-second follower carries the slot.
	native *guards.NativeMode
	// export is the REAL-TIME feed-in watchdog (dynamische Einspeisebegrenzung):
	// it regulates the CONTROLLABLE producers against the MEASURED connection
	// point so the site's feed-in limit holds no matter what the house does -
	// the job a customer-owned Loxone does at Anlage Pilsting today. Fed with
	// (power_kw, pv_power_kw) at onLocalTelemetry, read at applySetpoint, where
	// its plant cap composes most-restrictive-wins with the plan's own
	// curtailment. Unlike every economic guard it does NOT go inactive when
	// blind (guards/exportlimit.go: hold, then contract to a safe static cap).
	export         *guards.ExportLimiter
	curtailTrack   *guards.CurtailTracker
	despikeStore   *guards.SettingsStore
	lastDespikeLog time.Time
	lastBalanceLog time.Time // rate-limits the house-balance fallback warning
	lastDriftLog   time.Time // rate-limits the battery cross-check drift log
	lastCertDivLog time.Time // rate-limits the control-gate-divergence warning

	invMu sync.Mutex
	inv   *inverter.Selection // the customer's inverter choice; nil until set

	// OTA Stufe 3 „Autonom" (agent/ota_autonomy.go): der Kern tauscht nichts,
	// er BEZEUGT. otaAcked*/otaAckFailed*
	// merken sich, fuer welchen Vorgang der DURABLE `applying`-Bericht schon
	// abgesetzt (bzw. nachweislich nicht absetzbar) war - er darf nicht bei
	// jedem 2-s-Takt erneut gesendet werden.
	otaMu             sync.Mutex
	otaAckedToken     string
	otaAckedAt        string
	otaAckFailedToken string
	// otaBlockerLogged ist die zuletzt vom Kern PROTOKOLLIERTE Sperre des
	// Sidecars ("" = keine). Der Sidecar protokolliert seine Sperre selbst;
	// der Kern tut es zusaetzlich, weil `docker compose logs core` der Ort ist,
	// an dem ohnehin jeder nachsieht - und auch hier nur bei AENDERUNG.
	otaBlockerLogged string
	otaBlockerKnown  bool

	// First-Light calibration (agent/calibration.go): the bounded, armed,
	// TTL-limited procedure that proves a battery inverter's control sign + scale
	// on the REAL hardware BEFORE the family is certified. cal is the pure state
	// machine, calWatchdog the controller-owned auto-revert timer, calCert the
	// persisted per-device certification a passed First-Light grants ("Steuerung
	// freigeben") - all guarded by calMu. lastBattKw is the latest MEASURED battery
	// power (the verdict's before/after cross-check input), guarded by a.mu
	// alongside lastReading (read into a local before taking calMu, so the two
	// locks never nest).
	lastBattKw  *float64
	calMu       sync.Mutex
	cal         *calibration.Session
	calWatchdog *time.Timer
	calCert     map[string]bool

	// pcMu guards platformDoc, the retained PLATFORM control-certification
	// document (agent/controlcert.go). ⚠ Lock order: invMu (the inverter
	// selection) is always taken BEFORE pcMu, never the other way round.
	pcMu        sync.Mutex
	platformDoc *controlcert.Document
	// calPath records, per granted family, WHICH control surface the First-Light
	// evidence was produced on ("remote"/"tou") - persisted with the grant in
	// calibration-certified.json and published as device_certified_path on
	// edge/setpoint, so Layer 1 can hold the proven path across restarts instead
	// of re-deriving it from a single (possibly degenerate) probe answer. Absent
	// for pre-path grants until certify or the one-time readback backfill records it.
	calPath map[string]string

	// PV-curtailment First-Light (agent/curtail.go): the per-UNIT certification
	// of the fronius_sunspec Erzeuger sources (keyed ip:port#unit_id), the
	// bounded curtailment test session, its auto-revert watchdog and the latest
	// per-unit readbacks - all guarded by curtailMu (never nested with calMu).
	curtailMu       sync.Mutex
	curtailCal      *curtailcal.Session
	curtailWatchdog *time.Timer
	curtailCert     map[string]bool
	curtailUnits    map[string]state.CurtailUnit
	// exportLogKey deduplicates the feed-in watchdog's log line: it is written on
	// a state CHANGE, never per tick (the OTA-blocker lesson).
	exportLogKey string

	// OCPP charge points (agent/ocpp.go). nil while VP_OCPP_ENABLED is off,
	// which is the default - the box then behaves byte-for-byte as it did
	// before the feature existed.
	ocpp *ocppRuntime
	// purgeOcpp is a narrow failure-injection seam for the all-recordings purge
	// tests. nil means the real OCPP runtime (or no OCPP feature at all).
	purgeOcpp func(time.Time) error

	// Per-node live flow state (Portal v3 M5 Part C), recorded from the local
	// bus and folded into the heartbeat ONLY when the feature flag is on.
	flowNodeMu     sync.Mutex
	flowNodeStates map[string]flowNodeState

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

	// probeReads correlates an in-flight Probe-Kanal round-trip
	// (edge/probe/request -> Node-RED -> edge/probe/result) to the waiting
	// cloud handler by request id - the same machinery as testReads, on its own
	// topic pair because a probe reads FREE registers while a test-read reads a
	// catalog selection. probeLimiter bounds how often this box knocks on a
	// customer's device on the cloud's behalf (internal/probe).
	// The guided switch test (Einheitsmodell Stufe 4). switchTimers holds at
	// most ONE pending auto-off per written register - a second test on the same
	// register replaces the first, so no revert can ever be orphaned.
	switchMu      sync.Mutex
	switchTimers  map[string]*time.Timer
	switchWaiters map[string]chan []switchBusResult

	// The narrow installer write (agent/installerwrite.go): ONE Deye register,
	// 0x00E7. installerBusy is the one-shot guard - two overlapping writes to
	// one EEPROM register is the single thing this path must never do -,
	// installerWaiters correlates the round trip, and installerLog is the
	// audit trail that survives a restart. The first three are guarded by
	// installerMu; the log has its own lock and is safe alone.
	installerMu      sync.Mutex
	installerBusy    bool
	installerWaiters map[string]chan installerBusResult
	installerLog     *installerwrite.Log

	probeMu      sync.Mutex
	probeReads   map[string]chan []probeBusResult
	probeLimiter *probe.Limiter
	// probePublish is the test seam for the cloud answer (nil = the real link).
	probePublish func(payload []byte) error

	// The PORTAL trigger of the same one-shot write (agent/register_write.go;
	// contract docs/contracts/mqtt-register-write.schema.json). registerSeen is
	// the replay guard - non-retained plus the `requested_at` window stop a LATE
	// redelivery, this stops an immediate one, and on an EEPROM register that
	// distinction is a write cycle. registerLimiter is deliberately TIGHTER than
	// the probe channel's, for the same reason.
	registerMu      sync.Mutex
	registerSeen    map[string]time.Time
	registerLimiter *registerwrite.Limiter
	// registerPublish is the test seam for the cloud answer (nil = the real link).
	registerPublish func(payload []byte) error

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

	// Einheitsmodell Stufe 1 (agent/component_apply.go): WHO owns this plant's
	// device configuration, and which push revision was last applied. The
	// configuration itself stays where it always was (invStore + srcStore) -
	// only the WRITER changes on a portal-managed plant. Absent record = box
	// managed, which is every plant that exists today.
	compMu     sync.Mutex
	compStore  *componentapply.Store
	compRecord componentapply.Record
	// entComposed holds the DISPLAY-ONLY local composition of the composed
	// entities (battery-hybrid/grid-meter/house-load) derived from the gated
	// composite site sample at onLocalTelemetry - see entities.ComposeLocal.
	// It fills the :8484 entity tiles + Energiefluss on a migrated plant whose
	// Layer-1 flows still publish only the v1 site sample. It NEVER enters the
	// buffer/uplink (the cloud fans the same v1 sample out itself) and never
	// the heartbeat's observed Ist (which reports what the DEVICE reports).
	entComposed map[string]entReading

	// E2 arbitration layer (agent/arbitration.go; contract docs/contracts/v2/
	// edge-desired-arbitration.md + mqtt-schedule-2.0.md): the desired
	// arbiter, the cached v2 plan + its staleness-surviving postures, the
	// plan-executor bookkeeping and per-entity readback verdicts. All no-ops
	// without a pushed registry.
	arb         *desired.Arbiter
	plan2Store  *plan2.Store
	arbMu       sync.Mutex
	curPlan2    *plan2.Plan
	peak2       *float64            // v2 site peak target (survives staleness)
	reserve2    map[string]*float64 // v2 per-entity reserves (survive staleness)
	planHeld    map[string]string   // entity -> "v1"|"v2" currently plan-commanded
	entReadback map[string]*bool    // per-entity latest readback all_match
	arbWake     chan struct{}

	// Edge-local deadline fallback (agent/flexfallback.go + internal/
	// flexfallback; Verbrauchssteuerung Inkrement 6, D-20): the validated
	// per-entity deadline duties from the registry push, the confirmed-progress
	// trackers (persisted, flexfallback.json), the currently emitted wishes and
	// the last logged decision reason. ALL empty/no-op unless
	// VP_CONSUMER_CONTROL_ENABLED is set (byte-identical behavior otherwise).
	flexMu      sync.Mutex
	flexReqs    map[string][]flexfallback.Requirement
	flexTrack   map[string]map[string]*flexfallback.Tracker
	flexHeld    map[string]bool
	flexLast    map[string]string
	flexDirty   bool
	flexSavedAt time.Time

	// Modbus-Datenspiegel (agent/mirror.go + internal/mirror): the read-only
	// Modbus-TCP slave for the customer's building automation. mirSettings is
	// the persisted config (mirror.json), guarded by mirMu; the server's own
	// caches are internally synchronized.
	mirStore    *mirror.Store
	mir         *mirror.Server
	mirMu       sync.Mutex
	mirSettings mirror.Settings

	// goeDoer executes go-e Charger control HTTP (nil = the default http.Client
	// doer, set in Start; injectable for tests). The consumer-control loop
	// (agent/consumer_control.go) reads the arbiter's clamped consumer command
	// for each go-e-backed wallbox entity and drives its physical set+readback.
	goeDoer goe.Doer
	// goeHolds carries the go-e driver-level hold reason per entity (today:
	// guard_phase_switch while a D4 phase switch is paced) for the heartbeat's
	// consumers block. Written by the consumer-control pass, read by
	// consumersSummary; own mutex so neither touches the other's locks.
	goeMu    sync.Mutex
	goeHolds map[string]string

	// shellyDoer executes Shelly HTTP (nil = a default http.Client-backed
	// doer; injectable for tests). shellyStore persists the once-detected
	// generation dialect + metering capability per device
	// (data_dir/shelly-devices.json), lazily opened by shellyStoreRef.
	// The CORE owns the whole Shelly socket - source poll, connection test
	// AND the consumer executor (single-writer, internal/shelly).
	shellyDoer    shelly.Doer
	shellyStoreMu sync.Mutex
	shellyStore   *shelly.Store

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

	// ota holds the verdict of the last OTA release verification (agent/ota.go,
	// OTA Stufe 1). Verification only - there is no apply path on the device.
	ota otaState
	// otaRoots overrides the BAKED trust root - a TEST SEAM only (the repo
	// carries no private key, so a test must mint its own throwaway root).
	// nil = the production path: otaverify.BakedRoots(), i.e. rootkeys.json.
	otaRoots *otaverify.KeySet

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
	measurementOutbox, err := measurements.OpenOutbox(
		filepath.Join(cfg.DataDir, "measurement-outbox"), 10000)
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
	ns := netinfo.NewStore(cfg.DataDir)
	ms, err := mirror.NewStore(cfg.DataDir)
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
	cs, err := componentapply.NewStore(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	iwl, err := installerwrite.NewLog(cfg.DataDir)
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
		Cfg:               cfg,
		State:             state.New(ref, Version),
		buf:               buf,
		measurementOutbox: measurementOutbox,
		hist:              history.New(historyCapacity),
		planStore:         ps,
		invStore:          is,
		invCat:            inverter.DefaultCatalog(),
		srcStore:          ss,
		balStore:          bs,
		mirStore:          ms,
		net:               ns,
		installerLog:      iwl,
		srcReadings:       map[string]sourceReading{},
		entReadings:       map[string]entReading{},
		testReads:         map[string]chan testconn.Result{},
		probeReads:        map[string]chan []probeBusResult{},
		probeLimiter:      probe.NewLimiter(probe.DefaultRateWindow, probe.DefaultRateBudget),
		registerLimiter: registerwrite.NewLimiter(
			registerwrite.DefaultRateWindow, registerwrite.DefaultRateBudget),
		despiker:     guards.NewDespikerWithSettings(despikeCfg),
		envelope:     guards.NewEnvelope(),
		peak:         guards.NewPeakTracker(),
		trim:         guards.NewPriceTrimmer(),
		follow:       guards.NewLoadFollower(),
		absorb:       guards.NewSurplusCharger(),
		export:       guards.NewExportLimiter(),
		curtailTrack: guards.NewCurtailTracker(),
		despikeStore: ds,
		cal:          calibration.NewSession(calibration.Config{MaxKw: cfg.CalibrationMaxKw, TTL: cfg.CalibrationTTL}),
		calCert:      map[string]bool{},
		calPath:      map[string]string{},
		curtailCal:   curtailcal.New(0),
		curtailCert:  map[string]bool{},
		curtailUnits: map[string]state.CurtailUnit{},
		wake:         make(chan struct{}, 1),
		reconcileNow: make(chan struct{}, 1),
		lastReading: guards.Reading{
			SocPct: guards.Unknown(), PvKw: guards.Unknown(),
			LoadKw: guards.Unknown(), GridLimitKw: guards.Unknown(),
		},
	}
	// The native supervision's proof grace derives from the setpoint cadence, so
	// it is constructed after the Agent literal (a.Cfg is set there).
	a.native = guards.NewNativeMode(a.nativeProofGrace())
	if raw, err := os.ReadFile(filepath.Join(cfg.DataDir, "measurement-config.json")); err == nil {
		var header struct {
			Revision int64 `json:"revision"`
		}
		if json.Unmarshal(raw, &header) == nil && header.Revision > 0 {
			a.measurementRevision, a.measurementConfig = header.Revision, raw
		}
	} else if !os.IsNotExist(err) {
		slog.Warn("stored measurement config unreadable", "err", err)
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
	// Restore the per-device First-Light calibration certification (families the
	// operator proved + released via "Steuerung freigeben"). A corrupt/missing file
	// leaves the set empty - the family stays uncertified, the fail-safe default.
	a.loadCalibrationCert()
	// Restore the per-UNIT curtailment certification (Fronius units the operator
	// proved + released via the bounded curtailment test). Fail-safe like above.
	a.loadCurtailCert()
	// Restore the PLATFORM control-certification document (the cloud register +
	// this plant's activation). Missing/corrupt = no platform grant, and the
	// retained redelivery repairs it on the next cloud connect.
	a.loadControlCert()
	// Restore the applied v2 entity registry (persisted across restarts); its
	// per-entity retained configs are re-published once the bus is up in Start.
	a.entStore = es
	a.restoreEntities()
	// Einheitsmodell Stufe 1: who owns this plant's device configuration. Loaded
	// BEFORE the first push of the session, so a portal-managed plant refuses
	// local edits even while offline.
	a.compStore = cs
	a.restoreComponentRecord()
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
	// Edge-local deadline fallback (Inkrement 6): restore the confirmed-progress
	// trackers and derive the deadline duties from the restored registry. Both
	// no-ops unless VP_CONSUMER_CONTROL_ENABLED is set.
	a.loadFlexState()
	a.rebuildFlexRequirements(reg)
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
		// Backfill the catalog-owned metadata (nameplate + control tier) onto a
		// selection persisted BEFORE those fields existed - otherwise the retained
		// edge/inverter/config re-published on boot carries rated_kw:0 and the Deye
		// remote-mode control adapter refuses every tick (0.1 %-of-rated setpoint).
		// This never touches operator-owned connection settings; see Catalog.Backfill.
		if filled, changed, resolved := a.invCat.Backfill(sel); !resolved {
			slog.Warn("stored inverter selection: brand/model no longer in the catalog, control metadata not backfilled",
				"brand", sel.Brand, "model", sel.Model)
		} else if changed {
			sel = filled
			if err := is.Save(sel); err != nil {
				slog.Warn("could not persist backfilled inverter selection", "err", err)
			}
			slog.Info("backfilled inverter selection metadata from catalog",
				"brand", sel.Brand, "model", sel.Model, "rated_kw", sel.RatedKw, "control_tier", sel.ControlTier)
		}
		a.inv = &sel
		a.State.Update(func(s *state.Snapshot) { s.Inverter = inverterInfo(&sel) })
		slog.Info("loaded inverter selection from disk", "brand", sel.Brand, "family", sel.Family)
	} else if err != nil {
		slog.Warn("stored inverter selection unreadable; starting without", "err", err)
	}
	// Configure the physical envelope from the restored primary + sources (its PV
	// bound is Σ generation nameplate). Safe with no inverter (inactive/PV-only).
	a.reapplyEnvelope()
	// Modbus-Datenspiegel: build the mirror from its persisted settings (OFF by
	// default; the listener comes up in Start when enabled). After the inverter
	// restore so the native unit follows the selection's mb_slave_id.
	a.initMirror()
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
	// Probe-Kanal results from Node-RED (edge/probe/result), correlated to the
	// waiting cloud handler by request id (agent/probe.go).
	if err := bus.Subscribe(localbus.TopicProbeResult, 11, a.onProbeBusResult); err != nil {
		return err
	}
	if err := bus.Subscribe(localbus.TopicSwitchResult, 14, a.onSwitchBusResult); err != nil {
		return err
	}
	// The narrow installer write's answer (edge/installer-write/result). The
	// SUBSCRIPTION is unconditional and free - nothing is ever published on the
	// request topic unless the feature flag is on, so an unflagged box simply
	// never sees a message here.
	if err := bus.Subscribe(localbus.TopicInstallerWriteResult, 15, a.onInstallerWriteResult); err != nil {
		return err
	}
	// The SAME handler serves the plain Modbus-TCP lane (Stufe 2): one waiter
	// map, one result shape, two transports - so a lane added later cannot grow
	// a second correlation mechanism that drifts from this one.
	if err := bus.Subscribe(localbus.TopicRegisterWriteResult, 15, a.onInstallerWriteResult); err != nil {
		return err
	}
	// Per-node flow state (Portal v3 M5 Part C, additive + feature-flagged):
	// the handler itself no-ops unless VP_FLOW_NODE_STATUS_ENABLED is set, so
	// subscribing always is free and the block simply stays absent.
	if err := bus.Subscribe(localbus.TopicFlowNodeStatus, 9, a.onFlowNodeStatus); err != nil {
		return err
	}
	if err := bus.Subscribe(measurements.LocalStatusTopic, 16, a.onMeasurementStatus); err != nil {
		return err
	}
	if err := bus.Subscribe(measurements.LocalSamplesTopic, 17, a.onMeasurementSamples); err != nil {
		return err
	}

	// Re-publish the persisted inverter selection retained, so a Node-RED that
	// (re)joins the bus after a reboot immediately self-wires the right adapter.
	a.publishInverterConfig()
	// Same for the additional-source config: Node-RED self-wires a read of each.
	a.publishSourcesConfig()
	// The retained plant-wide control gate a Node-RED executor reads instead of
	// the box's env (Einheitsmodell Stufe 4). Published at boot and never again
	// unless the flags could have changed - they come from the environment, so
	// in practice once per process.
	a.publishControlGate()
	// Modbus-Datenspiegel: raw-block subscription + retained want republish +
	// (if enabled) the read-only LAN listener.
	if err := a.startMirror(); err != nil {
		return err
	}

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
	// Consumer-control executor (go-e Charger + Shelly relay): a no-op while
	// VP_CONTROL_ENABLED is off (the default), so a read-only deployment never
	// pays for it.
	a.startConsumerControl(ctx)
	// Shelly source poll: the READ half of the core-owned shelly transport
	// (Node-RED has no shelly reader). Independent of the control flags, like
	// every other source read path; idles cheaply without shelly sources.
	a.startShellySourcePoll(ctx)
	// OCPP charge points: the CSMS the stations dial + the load-management
	// executor. A no-op while VP_OCPP_ENABLED is off (the default), so a box
	// without charge points pays nothing for it.
	if err := a.startOcpp(ctx); err != nil {
		return err
	}
	if err := bus.Subscribe(measurements.LocalOcppConfigTopic, 18,
		a.onOcppMeasurementConfiguration); err != nil {
		return err
	}
	// A customer intent is persisted BEFORE cleanup. If a prior boot died or
	// hit an I/O fault during that cleanup, retry it now that every local store
	// (including the optional OCPP journal) is open, before cloud reconnect.
	a.retryPendingLocalPurge()
	// E2 flow deployment: reconcile the persisted set at boot (self-heal from
	// truth) and keep reconciling periodically.
	a.flowDep.Reconcile()
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		a.flowReconcileLoop(ctx)
	}()

	// OTA Stufe 1: verify a release placed in <data_dir>/ota/ and REPORT the
	// verdict in the heartbeat. There is no downlink and no apply path yet -
	// this loop only ever reads files and forms an opinion.
	a.done.Add(1)
	go a.otaCheckLoop(ctx)

	// OTA Stufe 3: der Zustandskanal zum Sidecar und der Selbsttest eines
	// frisch getauschten Standes. Beide sind harmlos ohne Sidecar - der eine
	// schreibt eine kleine Datei, der andere kehrt ohne Brotkrume sofort
	// zurueck.
	a.done.Add(2)
	go a.otaSignalLoop(ctx)
	go a.otaSelfTestOnBoot(ctx)

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
	a.setMeasurementIdentity(id.TenantID, id.SiteID, id.DeviceID)
	var link *cloud.Link
	link, err := cloud.New(cloud.Options{
		Identity:    id,
		KeyPath:     keyPath,
		CertPath:    certPath,
		CAPath:      caPath,
		DevURL:      a.Cfg.DevCloudURL,
		DevInsecure: a.Cfg.DevInsecure,
		// The build stamp rides EVERY heartbeat as the top-level `version`
		// (OTA Stufe 0) - see cloud.Options.Version.
		Version:    Version,
		NetworkFn:  a.networkSummary,
		OnSchedule: a.onSchedule,
		OnCommand:  a.onCloudCommand,
		OnEntities: a.onEntityRegistryPush,
		OnPlanV2:   a.onPlanV2,
		OnFlows:    a.onFlows,
		// OTA Stufe 2: das zugewiesene Release kommt retained ueber denselben
		// Link. Es wird geprueft, abgelegt und gemeldet - angewandt wird es
		// beaufsichtigt (update.sh --from-target).
		OnUpdateTarget: a.onUpdateTarget,
		// Probe-Kanal: die NICHT-retained Einmal-Anfrage, ein Geraet im
		// Kunden-LAN einmal zu lesen - siehe probe.go.
		OnProbeRequest: a.onProbeRequest,
		// Register schreiben ueber das Portal: der ZWEITE Trigger auf den
		// Einmal-Schreib-Kern. NICHT retained - siehe register_write.go.
		OnRegisterWrite:  a.onRegisterWrite,
		OnControlCert:    a.onControlCert,
		OnChargingConfig: a.onChargingConfig,
		OnChargingBoost:  a.onChargingBoost,
		// Verbrauchssteuerung §11/§14.13: der manuelle Eingriff. NICHT retained -
		// siehe override.go.
		OnDesiredDownlink:   a.onDesiredDownlink,
		OnMeasurementConfig: a.onMeasurementConfig,
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
				a.republishMeasurementStatus(link)
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
				a.logControlGateDivergence(snap)
				if err := link.PublishStatus(src, soc, controlSummary(snap), a.entitiesSummary(),
					a.flowsSummary(), a.sourcesSummary(), a.flowNodeStatusSummary(),
					a.curtailmentSummary(), a.updateSummary(), a.consumersSummary(),
					a.registerWritesSummary(), a.chargersSummary()); err != nil {
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
	a.lastReadingAt = ts
	// Keep the last-good raw SoC for the status heartbeat when this sample had
	// no (or a despiked) SoC - mirrors the tile's last-good behaviour rather
	// than reporting a hole to the cloud.
	if p := ptr("soc_pct"); p != nil {
		a.lastRawSoc = p
	}
	// Track the latest MEASURED battery power for the First-Light calibration
	// cross-check ("hat die Batterie sich bewegt?"). Absent = nil, never a
	// fabricated 0. Guarded by a.mu alongside lastReading (read into a local in
	// the calibration snapshot so calMu is never held under a.mu).
	if battKw != nil {
		v := *battKw
		a.lastBattKw = &v
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

	// Feed the feed-in watchdog with the SAME gated composite connection-point
	// measurement plus the total plant PV: those two are the whole control law
	// (guards/exportlimit.go), and because the grid value already contains the
	// house, the wallboxes and the battery, they are netted in automatically -
	// that is what the customer's Loxone does today. A sample missing either
	// channel is not a measurement for this purpose: the guard then runs its
	// staged HOLD/CONTRACT fallback instead of releasing.
	//
	// urgent = this sample demands a MEANINGFULLY tighter cap than the one
	// currently commanded (a wallbox was unplugged). Republish the setpoint at
	// once instead of waiting up to a full tick: the curtailment executor is
	// driven BY the setpoint (vp-sollwert -> plan -> exec), and a changed cap
	// changes the command signature, so the write goes out on the next executor
	// pass. Deliberately only on a TIGHTENING - a release must never bypass its
	// rate limit, and an unconditional nudge would republish at telemetry
	// cadence for no gain.
	if g, ok := measurements["power_kw"]; ok {
		if pv, okPv := measurements["pv_power_kw"]; okPv {
			if a.export.Observe(ts, g, pv) {
				a.nudgeSetpoint()
			}
		}
	}

	// Feed the OCPP charging budget with the SAME gated composite connection
	// point (Stufe 2, internal/lastmgmt/budget.go). It is the IMPORT-side twin
	// of the feed-in watchdog above and shares its inverted fail-safe rule:
	// blind never means unlimited. A box without charge points has no runtime
	// and this costs nothing.
	// battKw is passed EXPLICITLY - it is not in `measurements` (see the parse
	// above: it is an internal channel, never a published one).
	a.ocppObserve(ts, measurements, battKw)

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
	// Feed the Modbus-Datenspiegel's VoltPilot standard map (unit 100) with the
	// SAME gated composite the dashboard/cloud see: absent channels stay absent
	// (served as sentinels, never a fabricated 0); the battery term follows the
	// history ring's rule (measured register, or a physical 0 on a provably
	// batteryless primary).
	a.feedMirrorTelemetry(ts, mirror.Composite{
		PvKw:        ptr("pv_power_kw"),
		LoadKw:      ptr("load_kw"),
		GridKw:      ptr("power_kw"),
		BattKw:      histBatt,
		SocPct:      ptr("soc_pct"),
		GridLimitKw: ptr("grid_limit_kw"),
	})
	// Local composition of the composed v2 entities for the device's OWN view
	// (M-B3-local). Display-only: it feeds Topology() -> the :8484 entity tiles
	// + Energiefluss, never the buffer/uplink (the cloud fans the very same v1
	// sample out itself, so uplinking here would double-write telemetry_v2).
	a.composeEntities(measurements, ts)
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

// certDivergenceLogInterval rate-limits the certified-divergence warning.
const certDivergenceLogInterval = 10 * time.Minute

// logControlGateDivergence surfaces the conditions the controlSummary fix would
// otherwise hide: a flow-stamped readback GATE FLAG disagreeing with the core's
// authoritative value. The core wins for BOTH flags (that is the fix), but a
// disagreement is a real fact worth naming.
//
//   - certified: the expected steady state on a released non-allowlisted family
//     (flow=false, core=true) as much as the inverse (flow=true, core=false),
//     which would mean the executor considers a family certified that the core
//     does not.
//   - control_enabled: the release path (controlRelease) historically carried no
//     controlEnabled at all, so its readback stamped `false` and pinned the portal
//     to "ausgeschaltet" after every calibration auto-revert. A divergence here now
//     means either that old Layer 1 or a real gate disagreement.
//
// Rate-limited to one line per interval so a permanent, by-design divergence does
// not flood the log.
func (a *Agent) logControlGateDivergence(snap state.Snapshot) {
	c := snap.Control
	if c == nil || c.Blocked {
		return
	}
	certDiverges := c.Certified != snap.ControlCertified
	enabledDiverges := c.ControlEnabled != snap.ControlEnabled
	if !certDiverges && !enabledDiverges {
		return
	}
	a.mu.Lock()
	now := time.Now()
	quiet := now.Sub(a.lastCertDivLog) < certDivergenceLogInterval
	if !quiet {
		a.lastCertDivLog = now
	}
	a.mu.Unlock()
	if quiet {
		return
	}
	slog.Warn("control gate sources disagree; reporting the core's own values to the cloud",
		"flow_readback_certified", c.Certified,
		"core_certified", snap.ControlCertified,
		"flow_readback_control_enabled", c.ControlEnabled,
		"core_control_enabled", snap.ControlEnabled,
		"control_path", c.ControlPath)
}

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
//
// BOTH GATE FLAGS ARE SOURCED FROM THE CORE, NOT FROM THE READBACK (portal-signal
// fix, 2026-07-27). A readback stamp is a Layer-1 observation, never the authority
// for a gate flag - the two live defects that proved it:
//
//   - `certified` is stamped by the Node-RED flow's STATIC family allowlist
//     (inverter-control-routing.js CERTIFIED = {sunspec}), which cannot know the
//     per-device First-Light grant the operator issued at runtime - so a released
//     Deye reported certified:false to the cloud forever while :8484 (reading
//     snap.ControlCertified) correctly said "freigegeben".
//   - `control_enabled` is stamped from ctrl.controlEnabled, which controlRelease
//     never set - so `!!undefined` === false. After every First-Light test the TTL
//     auto-revert fires a RELEASE, that release readback is the LAST one the cloud
//     receives, and every following heartbeat re-published control_enabled:false:
//     the portal said "Die Wechselrichter-Steuerung ist ausgeschaltet" forever
//     while the core had it on.
//
// snap.ControlEnabled/snap.ControlCertified are the authoritative values
// applySetpoint/calibration maintain (ControlEnabled = the kill-switch ANDed with
// certification; ControlCertified = env allowlist merged with the persisted
// First-Light grant), and they are exactly what the local card renders, so the
// cloud now agrees with the device by construction. This changes only what is
// REPORTED - who may WRITE is still decided by the control_enabled the core puts
// on edge/setpoint and by the executor's own allowlist.
func controlSummary(snap state.Snapshot) *cloud.ControlSummary {
	c := snap.Control
	// A blocked control info (empty plan: unknown nameplate/scale) is a local :8484
	// affordance only - it carries no readback and must NOT fold into the heartbeat,
	// so the cloud contract is byte-identical to before Defect 2 (no summary when
	// there is nothing confirmed).
	if c == nil || c.Blocked {
		return nil
	}
	// AllMatch/MismatchRoles carry the DEBOUNCED verdict (state.ControlInfo's
	// hold-last AllMatch + roles that are only named once "not_held" is confirmed),
	// so the cloud sees the same calm truth the device shows instead of every
	// flickering cycle. A cycle without an answer keeps the last known verdict -
	// the cloud DTO has no third state, and a missing ANSWER is not a mismatch.
	sum := &cloud.ControlSummary{
		AllMatch:         c.AllMatch,
		ControlEnabled:   snap.ControlEnabled,
		Certified:        snap.ControlCertified,
		SlotStart:        c.SlotStart,
		CheckedAt:        c.CheckedAt.UTC().Format(time.RFC3339Nano),
		MismatchRoles:    c.MismatchRoles,
		ControlPath:      c.ControlPath,
		PossibleConflict: c.PossibleConflict,
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
	sum.Execution = executionSummary(snap)
	// WHICH source granted the certification, and what the PLATFORM register
	// says about the selected model. Both come from the CORE snapshot for the
	// same reason `certified` does (see above): a Layer-1 readback stamp cannot
	// know a runtime grant. Absent on a device that never received a cloud
	// document - the cloud then keeps its generic wording rather than reading
	// silence as "not certified".
	sum.CertSource = snap.ControlCertSource
	if p := snap.PlatformCert; p != nil {
		sum.PlatformCert = &cloud.PlatformCertSummary{
			Verdict: p.Verdict, Model: p.Model, Reason: p.Reason,
		}
	}
	return sum
}

// The `execution.mode` vocabulary - see cloud.ExecutionSummary.
const (
	execModePlan         = "plan"
	execModeFollow       = "follow"
	execModeIdleFollow   = "idle_follow"
	execModeDeficitCover = "deficit_cover"
	// execModeHighSocFollow is the RETIRED narrow full-battery relief
	// (2026-08-28, superseded by execModeDeficitCover, which covers every SoC
	// above the reserve stack instead of a five-point top band). No build
	// emits it any more; the word stays documented because a box on an older
	// image still reports it and the cloud must keep understanding it.
	execModeHighSocFollow = "high_soc_follow"
	// execModeHighSocCharge is the RETIRED narrow upper PV buffer (2026-08-29,
	// superseded by execModeSurplusStore, which stores a measured surplus at
	// every SoC below the ceiling instead of inside a five-point top band). No
	// build emits it any more; the word stays documented because a box on an
	// older image still reports it and the cloud must keep understanding it.
	execModeHighSocCharge = "high_soc_charge"
	// execModeSurplusStore is the CHARGE-side trust floor (2026-08-29, scout
	// report vp-herzogau-einspeisung-statt-laden-h3 §8 B1): the plan's OWN
	// charge was raised to the measured PV surplus. It is deliberately a
	// separate word from execModeAbsorb, which claims the CLOUD weighed storing
	// against selling for this slot - here only the AMOUNT was corrected
	// locally, and an unearned economic claim would be the same class of
	// dishonesty as an unnamed correction.
	execModeSurplusStore        = "surplus_store"
	execModeAutonomousDischarge = "autonomous_discharge"
	execModeTrim                = "trim"
	execModeAbsorb              = "absorb"
	execModeFallback            = "fallback"
)

// executionSummary folds the in-slot corrections (snap.Follow / snap.Trim) plus
// the plan-vs-fallback mode into the additive heartbeat block, so the cloud can
// name WHY the commanded value deviates from the plan's watt value instead of
// stating a bare "the device adjusted it" (the concept's PR-3 gap).
//
// The corrections are disjoint by construction (the trim lowers a charge, the
// follower acts on a discharge, the absorber raises a non-negative command up to
// the surplus), but the order is fixed anyway so the block is deterministic -
// and the ABSORPTION is checked FIRST because it runs LAST in the setpoint
// chain, so where it bit, its value is the one that was published. A device
// without a fresh plan reports "fallback" - the truth the top-level
// control_source carries too, repeated here so ONE block answers the question.
// Values are COPIED out of the snapshot, never aliased.
func executionSummary(snap state.Snapshot) *cloud.ExecutionSummary {
	// NATIVE SELF-REGULATION is checked FIRST because it OUTRANKS every
	// correction below: in a native slot the inverter itself decides the watts,
	// so "the follower deepened the discharge" would describe a computation
	// nobody executed. Only a PROVEN mode makes the claim - while the device has
	// not confirmed it, the reference value IS what the executor writes, so the
	// honest report is the correction that produced it.
	if n := snap.Native; n != nil && n.Active && n.Proven {
		return &cloud.ExecutionSummary{
			Mode:                 execModeAutonomousDischarge,
			PlannedKw:            copyFloat(&n.ReferenceKw),
			EffectiveFloorSocPct: copyFloat(snap.EffectiveFloorSocPct),
			MeasurementsFresh:    true,
		}
	}
	if a := snap.Absorb; a != nil && a.Active {
		mode := execModeAbsorb
		if a.Path == execModeSurplusStore {
			mode = execModeSurplusStore
		}
		return &cloud.ExecutionSummary{
			Mode:      mode,
			PlannedKw: copyFloat(&a.PlannedKw),
			SurplusKw: copyFloat(a.SurplusKw),
			// Only the LOCALLY authorized path carries the recent-measurement
			// evidence as an explicit fact; the cloud-economic absorption is
			// authorized by the plan, not by a freshness window of ours.
			MeasurementsFresh: mode == execModeSurplusStore,
		}
	}
	if f := snap.Follow; f != nil && f.Active {
		mode := execModeFollow
		if f.Path == execModeIdleFollow {
			mode = execModeIdleFollow
		} else if f.Path == execModeDeficitCover {
			mode = execModeDeficitCover
		}
		floor := snap.EffectiveFloorSocPct
		if f.FloorSocPct != nil {
			floor = f.FloorSocPct
		}
		return &cloud.ExecutionSummary{
			Mode:                 mode,
			Direction:            f.Direction,
			PlannedKw:            copyFloat(&f.PlannedKw),
			DeficitKw:            copyFloat(f.DeficitKw),
			EffectiveFloorSocPct: copyFloat(floor),
			MeasurementsFresh:    true,
		}
	}
	if t := snap.Trim; t != nil && t.Active {
		return &cloud.ExecutionSummary{
			Mode:      execModeTrim,
			PlannedKw: copyFloat(&t.PlannedKw),
			SurplusKw: copyFloat(t.SurplusKw),
		}
	}
	// Only the two modes that map CLEANLY onto the vocabulary make a claim. A
	// desired-held battery (v2 flow/override), a calibration run or a device
	// without readings is none of "plan"/"fallback" - the block is then omitted
	// entirely rather than mislabelled, and the cloud keeps its coarse wording
	// (the top-level control_source collapses all of these into "default",
	// which is exactly why it cannot be the precise signal).
	switch snap.Mode {
	case state.ModeSchedule:
		return &cloud.ExecutionSummary{Mode: execModePlan}
	case state.ModeSelfConsume:
		return &cloud.ExecutionSummary{Mode: execModeFallback}
	default:
		return nil
	}
}

// copyFloat returns an independent copy so the heartbeat block never aliases
// snapshot memory (a pointer into a struct the next Update replaces).
func copyFloat(v *float64) *float64 {
	if v == nil {
		return nil
	}
	out := *v
	return &out
}

// The confirmation state machine behind the :8484 warning (the flap fix,
// 2026-07-30). The Layer-1 readback reports ONE cycle; whether a run of cycles
// becomes an operator-facing warning is decided HERE, because the live symptom was
// exactly that a single flickering cycle raised the alarm every ~10 s tick while
// the battery was demonstrably following the setpoint.
const (
	controlCycleHeld        = "held"
	controlCycleMismatch    = "mismatch"
	controlCycleUnconfirmed = "unconfirmed"

	// ControlMismatchAlarmCycles consecutive deviating cycles turn the state into
	// "not_held" (the warning). 3 x the ~10 s setpoint cadence ~= 30 s: long enough
	// that a flicker is silent, short enough that a real refusal is named quickly.
	controlMismatchAlarmCycles = 3
	// ControlNoAnswerCycles consecutive cycles WITHOUT any answer turn the state
	// into "no_answer": silence must be visible, but it is never "not adopted".
	controlNoAnswerCycles = 6
)

// controlCycleVerdict normalizes what Layer 1 reported into the three cycle
// verdicts. An older Layer-1 build sends no `verify` field, so the verdict is
// derived from the tri-state all_match: nil there means "no verdict" - the
// conservative reading, never a fabricated mismatch.
func controlCycleVerdict(verify string, allMatch *bool) string {
	switch verify {
	case controlCycleHeld, controlCycleMismatch, controlCycleUnconfirmed:
		return verify
	}
	if allMatch == nil {
		return controlCycleUnconfirmed
	}
	if *allMatch {
		return controlCycleHeld
	}
	return controlCycleMismatch
}

// applyControlConfirm folds this cycle into the debounced confirmation state,
// carrying the run lengths over from the previous readback.
//
//	held        -> confirmed, both counters reset
//	mismatch    -> the mismatch run grows; the REPORTED verdict (AllMatch, and with
//	               it the heartbeat) flips only when the run reaches the threshold
//	unconfirmed -> NO evidence: the last known verdict is KEPT (the project's
//	               hold-last discipline) and the mismatch run is left untouched,
//	               so silence can neither raise nor clear an alarm.
func applyControlConfirm(info *state.ControlInfo, prev *state.ControlInfo, cycle string) {
	// A blocked readback (empty plan, e.g. an unknown nameplate) is not a cycle.
	if info.Blocked {
		info.Verify = ""
		info.Confirm = ""
		return
	}
	held := false
	mismatchRun, unconfirmedRun := 0, 0
	if prev != nil && !prev.Blocked {
		held = prev.AllMatch
		mismatchRun = prev.MismatchCycles
		unconfirmedRun = prev.UnconfirmedCycles
	}
	switch cycle {
	case controlCycleHeld:
		held, mismatchRun, unconfirmedRun = true, 0, 0
	case controlCycleMismatch:
		mismatchRun, unconfirmedRun = mismatchRun+1, 0
		// The REPORTED verdict only flips once the deviation is confirmed: below the
		// threshold the last known verdict stands, which is what keeps the card AND
		// the cloud calm through a flicker.
		if mismatchRun >= controlMismatchAlarmCycles {
			held = false
		}
	default: // unconfirmed
		unconfirmedRun++
	}
	info.AllMatch = held
	info.MismatchCycles = mismatchRun
	info.UnconfirmedCycles = unconfirmedRun
	switch {
	case mismatchRun >= controlMismatchAlarmCycles:
		info.Confirm = "not_held"
	case unconfirmedRun >= controlNoAnswerCycles:
		info.Confirm = "no_answer"
	case mismatchRun > 0:
		info.Confirm = "checking"
	case held:
		info.Confirm = "held"
	default:
		info.Confirm = "pending"
	}
	// The roles are only NAMED once the deviation is confirmed - naming registers
	// for an unconfirmed flicker is what made the page read like a fault.
	if info.Confirm != "not_held" {
		info.MismatchRoles = nil
	}
}

// onControlReadback ingests one control readback from Layer 1 (edge/control/
// readback): the per-register commanded-vs-actual result of a control write. It
// is stored in the Snapshot for the :8484 "Steuerung & Bestätigung" card and
// folded into the status heartbeat so the cloud sees a compact confirmation
// (report §5). Read-only - it never influences execution.
func (a *Agent) onControlReadback(_ string, payload []byte) {
	// Curtailment readbacks (the Fronius fleet write path) ride the SAME topic
	// with a curtail:true discriminator - they are PER SOURCE UNIT and must
	// never clobber the primary inverter's control state. Route them off.
	var probe struct {
		Curtail bool `json:"curtail"`
	}
	if err := json.Unmarshal(payload, &probe); err == nil && probe.Curtail {
		a.onCurtailReadback(payload)
		return
	}
	var m struct {
		Ts             string `json:"ts"`
		Family         string `json:"family"`
		Source         string `json:"source"`
		SlotStart      string `json:"slot_start"`
		Mode           string `json:"mode"`
		ControlEnabled bool   `json:"control_enabled"`
		Certified      bool   `json:"certified"`
		// AllMatch is TRI-STATE since the flap fix: nil = the cycle produced NO
		// verdict (the inverter did not answer the readback). An older Layer-1 build
		// sends a plain bool, so nil there means "no verdict" too - never "mismatch".
		AllMatch *bool `json:"all_match"`
		// Verify / UnreadRoles / VerifyReason are the Layer-1 cycle verdict
		// (readback-verify.js). Absent on an older build -> derived from AllMatch.
		Verify        string   `json:"verify"`
		UnreadRoles   []string `json:"unread_roles"`
		VerifyReason  string   `json:"verify_reason"`
		MismatchRoles []string `json:"mismatch_roles"`
		// ControlPath names WHICH Deye control surface drove this write - "remote"
		// (the Tier-2 register block 1100-1121) or "tou" (the legacy Time-of-Use
		// synthesis). Empty for every other adapter. Purely informational.
		ControlPath string `json:"control_path"`
		// RemoteStatusRaw is the Deye remote-control STATUS register (1121), a
		// read-only OBSERVATION deliberately kept OUT of Registers so it can never
		// fabricate or break all_match. nil = not read (not the remote path).
		RemoteStatusRaw *int `json:"remote_status_raw"`
		// Blocked/Reason: the control plan was EMPTY because something is WRONG
		// (unknown nameplate / power scale). A blocked readback carries no registers
		// (there was nothing to write/read) - it exists to show the CAUSE on the
		// :8484 card instead of an eternal "warte auf Rückmeldung" (Defect 2).
		Blocked        bool   `json:"blocked"`
		Reason         string `json:"reason"`
		DualController struct {
			OnlyControllerRequired bool   `json:"only_controller_required"`
			PossibleConflict       bool   `json:"possible_conflict"`
			Reason                 string `json:"reason"`
		} `json:"dual_controller"`
		// Native is the additive evidence block of the native self-regulation:
		// Layer 1 states whether it really ran the native primitive and what the
		// device answered about its own grid-charging configuration. Absent for
		// every other cycle and for an older Layer-1 build.
		Native struct {
			GridChargeBlocked *bool `json:"grid_charge_blocked"`
		} `json:"native"`
		Registers []struct {
			Role         string   `json:"role"`
			Fc           int      `json:"fc"`
			Addr         int      `json:"addr"`
			CommandedRaw int      `json:"commanded_raw"`
			CommandedKw  *float64 `json:"commanded_kw"`
			ActualRaw    *int     `json:"actual_raw"`
			ActualKw     *float64 `json:"actual_kw"`
			Match        bool     `json:"match"`
			Verdict      string   `json:"verdict"`
			Note         string   `json:"note"`
		} `json:"registers"`
	}
	if err := json.Unmarshal(payload, &m); err != nil {
		slog.Warn("control readback malformed; skipped")
		return
	}
	// A blocked readback legitimately carries NO registers (the plan was empty
	// because something is wrong); every other readback must carry registers.
	if len(m.Registers) == 0 && !m.Blocked {
		slog.Warn("control readback malformed; skipped")
		return
	}
	checkedAt := time.Now().UTC()
	if m.Ts != "" {
		if t, err := time.Parse(time.RFC3339, m.Ts); err == nil {
			checkedAt = t.UTC()
		}
	}
	cycle := controlCycleVerdict(m.Verify, m.AllMatch)
	info := &state.ControlInfo{
		CheckedAt:        checkedAt,
		Family:           m.Family,
		Source:           m.Source,
		SlotStart:        m.SlotStart,
		ControlEnabled:   m.ControlEnabled,
		Certified:        m.Certified,
		MismatchRoles:    m.MismatchRoles,
		ControlPath:      m.ControlPath,
		RemoteStatusRaw:  m.RemoteStatusRaw,
		PossibleConflict: m.DualController.PossibleConflict,
		ConflictReason:   m.DualController.Reason,
		Blocked:          m.Blocked,
		Reason:           m.Reason,
		Mode:             m.Mode,
		Verify:           cycle,
		UnreadRoles:      m.UnreadRoles,
	}
	if info.Reason == "" && cycle == controlCycleUnconfirmed {
		info.Reason = m.VerifyReason
	}
	// TRI-STATE, deliberately: nil = "the device did not say", which on an EEG
	// site counts as NOT proven - a compliance rule may not rest on silence.
	if m.Native.GridChargeBlocked != nil {
		v := *m.Native.GridChargeBlocked
		info.NativeGridChargeBlocked = &v
	}
	for _, r := range m.Registers {
		info.Registers = append(info.Registers, state.ControlRegister{
			Role: r.Role, Fc: r.Fc, Addr: r.Addr,
			CommandedRaw: r.CommandedRaw, CommandedKw: r.CommandedKw,
			ActualRaw: r.ActualRaw, ActualKw: r.ActualKw, Match: r.Match,
			Verdict: r.Verdict, Note: r.Note,
		})
	}
	// Debounce INSIDE the state update so the counters read and written are the same
	// snapshot's - the previous ControlInfo is the only carrier of the run length.
	a.State.Update(func(s *state.Snapshot) {
		applyControlConfirm(info, s.Control, cycle)
		s.Control = info
	})
	// Modbus-Datenspiegel: the ACTUAL values this readback read from the Deye
	// remote-mode window 1100-1121 make those registers READABLE on the mirror
	// - fresh from reads the control path performs anyway, never via an extra
	// poll (and structurally never writable there).
	if !m.Blocked {
		ctrlRegs := map[uint16]uint16{}
		for _, r := range m.Registers {
			// A register without an answer publishes NOTHING on the mirror - the
			// alternative would serve a fabricated 0 to every LAN consumer.
			if r.ActualRaw != nil && r.Addr >= mirror.ControlRegFirst && r.Addr <= mirror.ControlRegLast {
				ctrlRegs[uint16(r.Addr)] = uint16(*r.ActualRaw)
			}
		}
		if m.RemoteStatusRaw != nil {
			ctrlRegs[1121] = uint16(*m.RemoteStatusRaw)
		}
		a.feedMirrorControl(checkedAt, ctrlRegs)
	}
	// First-Light Gap B (report §7): a calibration WRITE's readback (source ==
	// "calibration" and NOT the neutral release) is the objective "the write landed"
	// evidence the sign/scale confirm + certify gates require. Correlate a full-register
	// match to the current test so certification cannot precede a real, confirmed write.
	// A BLOCKED readback performed no write (the plan was refused), so it is never
	// write-readback evidence - it must not mark the calibration test as failed.
	// An UNCONFIRMED cycle is not evidence either: the inverter did not answer the
	// readback, so recording a `false` there would fail a First-Light test over a
	// missing ANSWER (the flap's second victim). The test simply keeps waiting.
	if !m.Blocked && cycle != controlCycleUnconfirmed &&
		strings.EqualFold(strings.TrimSpace(m.Source), "calibration") && m.Mode != "release" {
		a.calMu.Lock()
		a.cal.NoteWriteReadback(cycle == controlCycleHeld)
		// Also record WHICH control surface drove the write ("remote" = the Deye Tier-2
		// register block, else ToU/default), so the displayed scale hint is path-aware:
		// the remote setpoint scales from the model's rated power, not the ToU power_scale.
		a.cal.SetControlPath(m.ControlPath)
		a.calMu.Unlock()
	}
	// Sticky-path backfill (2026-07-28): a NORMAL driving readback names the surface
	// a device-granted family is actually controlled on. For a grant certified before
	// the path field existed (the live pilot) this records the proven path ONCE, so
	// device_certified_path starts flowing without a re-certification.
	if !m.Blocked && m.Mode != "release" && !strings.EqualFold(strings.TrimSpace(m.Source), "calibration") {
		a.backfillCertifiedControlPath(m.Family, m.ControlPath)
	}
	// E2: the register-level proof also surfaces per entity - mirror it onto
	// the battery entity's readback topic (same payload shape, entity contract
	// §4) and record the verdict for the heartbeat. No-op without a registry.
	// A blocked readback performed no write, so it must not fabricate an entity
	// readback / mismatch - the entity + arbitration view stays untouched by it.
	if !m.Blocked {
		a.mirrorReadbackToEntity(payload, m.AllMatch)
	}
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
	readingAt := a.lastReadingAt
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
	effectiveFloor := p.EffectiveFloorSoc()
	// The site's feed-in limit at the grid connection point (FK1, published as
	// grid_export_limit_kw). Like the peak target it deliberately survives plan
	// staleness - and here the argument is stronger: this is a COMPLIANCE limit,
	// so a dead optimizer must never hand the plant back its unlimited feed-in.
	// nil = no limit configured -> byte-for-byte pre-feature behavior.
	exportLimit := p.ExportLimit()
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

	// First-Light calibration OVERRIDE (agent/calibration.go): while a bounded test
	// is engaged (active OR its auto-revert window), publish the small clamped test
	// setpoint (or the neutral release) INSTEAD of the plan/arbiter value. The value
	// still flows through guards.Clamp (the SAME limits), the magnitude is already
	// capped, and the global kill-switch still gates the write - calibration only
	// bypasses the certification allowlist so the first real write can prove
	// sign/scale. Returns true when it handled the tick.
	if a.calibrationOverride(now, r, limits) {
		// A bounded First-Light write owns the inverter for its TTL, so no
		// economic execution mode may carry an armed state across it.
		a.native.Release()
		return
	}

	var (
		kw            float64
		mode          state.Mode
		source        string
		slotStart     time.Time
		pvLimit       *float64
		nonPlanHolder bool
	)
	paused := a.automationPausedAt(now)
	plannedKw, start, planActive := p.ActiveSetpoint(now)
	switch {
	case paused && hasReading:
		// Steuerung Stufe 4: the v1 physical write path must honor the SAME
		// plant-rest authority as the entity arbiter. A pause means local
		// self-consumption, never a still-active optimizer slot. Compliance
		// guards below (rated/SoC, grid and export) remain in force.
		fallback := guards.SelfConsumption(r)
		if peakReserve != nil && fallback < 0 && !math.IsNaN(r.SocPct) && r.SocPct <= *peakReserve {
			fallback = 0
		}
		kw = guards.Clamp(fallback, limits, r)
		mode, source = state.ModeSelfConsume, "default"
	case !paused && planActive:
		kw = guards.Clamp(plannedKw, limits, r)
		mode, source, slotStart = state.ModeSchedule, "schedule", start
		// Forward the slot's PV feed-in cap so a control adapter can execute
		// curtailment (report §4.5). Guard: only-reduce, never negative; cleared
		// (nil) on stale/fallback because ActivePvLimit returns nil there.
		if lim := p.ActivePvLimit(now); lim != nil && *lim >= 0 {
			v := math.Round(*lim*1000) / 1000
			pvLimit = &v
		}
	case hasReading:
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
	default:
		// No inverter reading at all: publish nothing (mirrors the Node-RED
		// watchdog, which does not write without a reading). The peak module's
		// display state stays honest: target/reserve are known from the plan,
		// but without a reading the guard cannot be active.
		//
		// The feed-in watchdog is the ONE guard that does NOT stand down here:
		// "no measurement" is exactly what its staged fallback exists for, and a
		// compliance limit may not be released just because the box has not seen
		// its plant yet. It is EVALUATED (so the state shows the safe static cap
		// it would command) while this branch still publishes nothing - the honest
		// outcome is that state, on :8484 and in the heartbeat.
		exportGuard := a.exportGuardInfo(
			a.export.Cap(now, exportLimit, exportSafeStaticCap(exportLimit, 0)))
		a.State.Update(func(s *state.Snapshot) {
			s.Mode = state.ModeNoReading
			s.PeakTargetKw = peakTarget
			s.PeakReserveSocPct = peakReserve
			s.EffectiveFloorSocPct = effectiveFloor
			s.PeakGuardActive = false
			s.PeakQuarterMeanKw = nil
			// Without a reading none of the economic corrections can regulate
			// (never blind), so any previous claim is cleared rather than left
			// stale.
			s.Trim = nil
			s.Follow = nil
			s.Absorb = nil
			// Without a reading the native supervision cannot supervise at all,
			// so a previous claim is cleared rather than left standing - the
			// same rule the three corrections above follow.
			s.Native = nil
			s.CarsFirstCapKw = nil
			s.ExportGuard = exportGuard
			// Without a reading the tracker has no evaluation point at all, so a
			// previous claim is cleared rather than left standing - the same rule
			// the economic corrections above follow.
			s.CurtailTrack = nil
		})
		a.trim.Release()
		a.follow.Release()
		a.absorb.Release()
		a.native.Release()
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
		if granted, kind, ok := a.arb.HolderCommand(battID); ok {
			nonPlanHolder = kind != desired.SourcePlanExecutor
			if granted.SetpointKw != nil {
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
	}

	// Price-aware in-slot trim (2026-07-30): in a slot the CLOUD marked
	// charge_from_surplus_only (importing costs more than the extra stored kWh
	// earns - services/optimization slot_trim.py), cap the commanded CHARGE at the
	// MEASURED surplus so a forecast shortfall inside the quarter hour is no
	// longer covered by buying expensive grid energy for the battery. Runs after
	// every compliance clamp AND after the holder override. It follows only the
	// plan holder: every non-plan holder, technical ownership and plant rest
	// explicitly outrank market economics. It only ever LOWERS charge toward the surplus - the
	// resulting predicted grid power is >= 0, so no §14a/feed-in bound can be
	// re-violated (see guards/slottrim.go for the full safety argument). The
	// self-consumption fallback follows pv - load, i.e. the surplus itself, so the
	// trim is a no-op there. NOTE the setpoint published below is the TRIMMED
	// value: the register readback therefore matches it and the confirmation logic
	// never reads a deliberate limitation as "setpoint not adopted".
	// The arbiter's selected holder is the authority boundary for the physical
	// battery setpoint. No retained market flag may rewrite a technical/rule or
	// contract/grid/safety command after arbitration; owner_claimed closes the
	// registry transition even before its first holder command is available.
	// Hard export/compliance/watchdog and device write gates remain downstream.
	marketCorrectionsAllowed := !paused && !nonPlanHolder && !a.batteryOwnerClaimed()
	trimmed := a.trim.Apply(now, kw,
		marketCorrectionsAllowed && p.ActiveChargeFromSurplusOnly(now), r)
	kw = trimmed.Kw

	// In-slot LOAD FOLLOWING (2026-07-30, the discharge-side mirror of the trim
	// above - firstmate scout vp-netzbezug-nacht-s3 P1): in a slot the CLOUD
	// marked cover_load_from_battery (covering the house from the battery is
	// cheaper than importing - lambda/eta + wear below the import price), TRACK
	// the commanded DISCHARGE to the MEASURED house deficit instead of executing
	// this slot's forecast-derived watt value rigidly and settling the difference
	// at the grid. BOTH directions, both measured live at Pilsting on the same
	// night: raise it where the forecast fell short (4,33 kW planned into a
	// 7,12 kW house -> 2,79 kW bought at ~32,5 ct with the battery at 77 % SoC)
	// AND limit it where the forecast overshot (6,7 kW planned into a 5,1 kW
	// house -> 1,4 kW exported at ~21 ct while the same kWh was worth ~32,5 ct
	// later). Runs at the SAME place as the trim - after every compliance clamp
	// and after the holder override. Existing flow/desired semantics stay intact:
	// every non-plan holder, technical owner and plant rest is exempt because
	// market economics may not rewrite it. The two corrections are disjoint by
	// construction (one acts on charge,
	// one on discharge). It only ever moves the predicted grid power TOWARD 0,
	// never past it, so no §14a/feed-in bound can be re-violated; a raised
	// discharge is bounded by the rated band, the SoC floor AND the peak reserve
	// (ordinary load covering is exactly what that reserve must survive - the
	// same rule the stale-plan fallback applies), and a limited one has a hard
	// floor at zero discharge - the follower never commands a charge. See
	// guards/loadfollow.go for the full safety argument. NOTE the setpoint
	// published below is the FOLLOWED value: the register readback therefore
	// matches it and the confirmation logic never reads a deliberate correction
	// as "setpoint not adopted".
	// The additive idle-slot authorization is stricter than the established
	// planned-discharge follower: it may START a discharge, so it needs one
	// recent complete measurement, the cloud-computed full floor, and both live
	// write gates. Every supported driver uses this exact-setpoint path until an
	// exact model/firmware native capability has completed its bench gate.
	freshWindow := 2 * a.Cfg.SetpointInterval
	if freshWindow < 30*time.Second {
		freshWindow = 30 * time.Second
	}
	measurementFresh := !readingAt.IsZero() && !now.Before(readingAt) && now.Sub(readingAt) <= freshWindow
	coverLoad := marketCorrectionsAllowed && p.ActiveCoverLoadFromBattery(now)
	economicUnplannedRequested := marketCorrectionsAllowed && p.ActiveUnplannedLoadDischarge(now)
	portableReady := false
	// This additive economic permission belongs exclusively to an idle MARKET
	// slot. The shared marketCorrectionsAllowed boundary above protects both it
	// and the established cover_load_from_battery follower from every non-plan
	// holder and from the owner-claim transition race.
	if economicUnplannedRequested || (marketCorrectionsAllowed && p.Fresh(now)) {
		// The new authority starts a discharge, so unlike the established
		// magnitude-only follower it also requires a recent independently held
		// Layer-1 readback. Lost/mismatching/unconfirmed inverter communication
		// drops back to the plan's 0 kW on this very tick.
		readbackHealthy := idleReadbackHealthy(a.State.Get().Control, now, freshWindow)
		a.invMu.Lock()
		familyForIdle := ""
		if a.inv != nil {
			familyForIdle = a.inv.Family
		}
		a.invMu.Unlock()
		portableReady = a.Cfg.ControlEnabled && a.controlCertified(familyForIdle) && readbackHealthy
	}
	economicUnplanned := economicUnplannedRequested && portableReady

	unplanned := economicUnplanned
	floor := peakReserve
	if effectiveFloor != nil {
		floor = effectiveFloor
	}
	// DEFICIT COVERAGE (2026-08-28, Captain decision after Pilsting/Herzogau
	// 19:37): a MEASURED house deficit is covered from the battery in every
	// Fahrplan slot the plan does not charge, as long as no hold reason stands.
	// It generalizes the one-day-old full-battery relief, which only engaged
	// within one point of the SoC ceiling and therefore refused the live case -
	// 92 % storage, PV 1,3 kW, house 2,7 kW, 1,4 kW bought at ~25 ct against a
	// plan slot commanding 0,0 kW because its PV forecast still saw dusk
	// surplus. The economics stay with the cloud duties above; this is the trust
	// floor under them (guards/deficitcover.go carries the full argument).
	//
	// Every hold reason the decision cannot see itself is folded into Eligible:
	// the plant pause / non-plan holder / owner claim boundary
	// (marketCorrectionsAllowed), the Fahrplan mode itself (the
	// self-consumption fallback already follows pv - load, so the rule must not
	// second-guess it), a fresh plan, "a cloud duty is already in charge", and
	// the two write gates plus the held readback (portableReady) that every
	// locally STARTED discharge demands. Charge slot, SoC floor, stale
	// measurement and the sale protection live in the decision.
	deficitCover := guards.CoverDeficit(guards.DeficitCoverInput{
		Eligible: marketCorrectionsAllowed && mode == state.ModeSchedule &&
			p.Fresh(now) && !coverLoad && !economicUnplannedRequested &&
			portableReady,
		MeasurementsFresh: measurementFresh,
		CommandKw:         kw,
		SocPct:            r.SocPct,
		EffectiveFloorPct: floor,
		PvKw:              r.PvKw,
		LoadKw:            r.LoadKw,
	})
	preFollowKw := kw
	followed := a.follow.ApplyAuthorized(now, kw,
		coverLoad,
		unplanned, deficitCover.Active, floor, measurementFresh, limits, r)
	kw = followed.Kw

	// In-slot SURPLUS ABSORPTION (2026-08-02, the charge-side counterpart that
	// RAISES - firstmate scout vp-pilsting-abregeln §5b): in a slot the CLOUD
	// marked charge_surplus_to_battery (storing one more kWh beats selling it -
	// eta*lambda - wear above the slot's export value), RAISE the commanded
	// CHARGE to the MEASURED PV surplus instead of leaving a surplus the 15-min
	// forecast never saw to be exported. Measured live at Pilsting on
	// 2026-08-02: PV 23,9 kW, house 4,3 kW, battery at 7 % SoC, and 16,6 kW
	// leaving the site at a NEGATIVE price for hours, because the solver charges
	// only the FORECAST surplus and no nowcast corrects the running slot.
	//
	// This is the ONLY guard in the chain that RAISES a setpoint, so it is
	// deliberately the LAST of the three in-slot duties and its target is re-run
	// through the SAME guards.Clamp the command came from (rated band, SoC
	// ceiling, EEG solar-only charge, §14a envelope all still bind - it can never
	// write past a guard). It only ever raises a NON-NEGATIVE command, so it is
	// disjoint from the load following above; bounded by the measured surplus it
	// lands at predicted grid <= 0, i.e. it can never create or raise an IMPORT
	// (the §14a import bound and the peak target below are untouched) and only
	// ever moves an export TOWARD zero. See guards/surpluscharge.go for the full
	// argument. NOTE the setpoint published below is the RAISED value: the
	// register readback therefore matches it and the confirmation logic never
	// reads a deliberate correction as "setpoint not adopted". Since 2026-08-29
	// the same safe controller also executes the LOCAL charge-side trust floor
	// below; that authorization is not the cloud's economic verdict and gets its
	// own execution path/name.
	absorbAuthorized := marketCorrectionsAllowed && p.ActiveChargeSurplusToBattery(now)
	// SURPLUS STORAGE (2026-08-29, scout report
	// vp-herzogau-einspeisung-statt-laden-h3 §8 B1/B2): the same measured-surplus
	// controller, authorized LOCALLY instead of by a cloud flag - because the
	// cloud-economic duty is structurally silent on exactly the surplus days it
	// was built for (lambda collapses to ~wear/2 once the plan's own trajectory
	// fills the battery inside the horizon). Two live gaps from the same morning:
	//
	//   B1 - the plan commanded +9,82 kW against a measured 27,9 kW surplus, so
	//        ~18 kW left the site at a NEGATIVE price with the storage at 38 %;
	//   B2 - the plan RESTED (its obsolete -7,17 kW forecast discharge had been
	//        followed down to 0,0 kW) while 22,8 kW left the site, storage 19 %.
	//
	// The two entries differ in exactly one thing, and it is the safety
	// argument: with a CHARGE the store-versus-sell decision has been made by
	// the cloud and only the AMOUNT is corrected - there is no sale that could
	// be flipped. A RESTING command could also mean "sell at the peak", so it
	// needs the cloud's own discriminator: cover_load_from_battery marks a
	// "grid ~ 0" own-consumption slot and is never set on a sell slot. That
	// entry additionally demands the gates every locally STARTED direction
	// demands (kill switch, family certification, a held Layer-1 readback), and
	// it can only act after the follower has reduced an obsolete planned
	// discharge to real idle. See guards/surplusstore.go.
	//
	// Eligible folds the hold reasons the decision cannot see: the plant pause /
	// non-plan holder / owner claim boundary, the Fahrplan mode itself (the
	// self-consumption fallback already follows pv - load, so this must not
	// second-guess it), a fresh plan, and "a cloud duty is already in charge" -
	// where the cloud authorized the absorption it keeps its own name.
	surplusStore := guards.StoreSurplus(guards.SurplusStoreInput{
		Eligible: marketCorrectionsAllowed && mode == state.ModeSchedule &&
			p.Fresh(now) && !absorbAuthorized,
		IdleAuthorized:    coverLoad && portableReady,
		MeasurementsFresh: measurementFresh,
		CommandKw:         kw,
		SocPct:            r.SocPct,
		SocMaxPct:         limits.SocMaxPct,
		PvKw:              r.PvKw,
		LoadKw:            r.LoadKw,
	})
	absorbed := a.absorb.Apply(now, kw,
		absorbAuthorized || surplusStore.Active, limits, r)
	surplusStored := surplusStore.Active && absorbed.Active
	if surplusStored {
		absorbed.Path = execModeSurplusStore
		if surplusStore.Idle {
			// The portal compares execution with the Fahrplan, not with the
			// follower's intermediate 0 kW. Preserve the original forecast
			// discharge from the reported case. On the charge entry the
			// follower never touched the command, so the pre-absorption value
			// already IS the plan's own charge.
			absorbed.CommandedKw = preFollowKw
		}
	}
	kw = absorbed.Kw

	// „AUTO VOR SPEICHER" (OCPP-Lastmanagement Stufe 4, internal/lastmgmt/
	// surplus.go): the customer decided their VEHICLES get the PV surplus
	// before the battery does. That choice is only a RULE if the battery
	// actually yields - otherwise both would claim the same kilowatts and the
	// site would import the difference, which is exactly what „Nur
	// Sonnenstrom" promises never happens.
	//
	// ⚠ RESTRICT-ONLY and CHARGE-ONLY: it caps a POSITIVE command at what is
	// left of the MEASURED surplus once the vehicles took their share (never
	// what they were ALLOCATED - an allocation a car does not use must not be
	// taken from the storage). It never raises anything, never touches a
	// discharge and never flips a direction, so every guard above it - rated
	// band, SoC window, EEG solar-only, §14a - holds a fortiori, and the peak
	// guard below can only lower it further. Inactive without the choice,
	// without a charging vehicle or without a fresh measurement: a blind cap
	// would be a guess about a customer's storage. It runs LAST of the charge
	// corrections because the absorption above RAISES to the surplus, and with
	// cars-first that surplus is not the battery's to take.
	var carsFirstCap *float64
	if cap, ok := a.OcppBatteryChargeCap(now); marketCorrectionsAllowed && ok && kw > cap {
		v := cap
		carsFirstCap = &v
		kw = cap
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
	if marketCorrectionsAllowed && peakTarget != nil {
		if allowed, ok := a.peak.AllowedImport(now, *peakTarget); ok {
			kw = guards.PeakShave(kw, allowed, limits, r)
			peakActive = true
		}
		if mean, ok := a.peak.QuarterMean(now); ok {
			m := math.Round(mean*1000) / 1000
			quarterMean = &m
		}
	}

	// DYNAMISCHE EINSPEISEBEGRENZUNG (2026-08-06): the real-time watchdog at the
	// grid connection point. The plan already carries the site's feed-in limit as
	// a hard EXPORT cap for the solver (FK1), but a 15-min plan cannot HOLD that
	// limit: it is shared with the house, so unplugging a wallbox raises the
	// feed-in by that wallbox's power INSIDE the slot - which is exactly the job
	// a customer-owned Loxone does at Anlage Pilsting today, and the reason it
	// cannot be disconnected until we do it. guards.ExportLimiter closes the loop
	// on the MEASURED connection point (house, wallboxes and battery netted in
	// automatically, because they are already inside that measurement) and
	// returns the PLANT-level PV cap - the same quantity the plan's pv_limit_kw
	// carries, so the existing curtailment executor splits it across the Fronius
	// units unchanged.
	//
	// The safe static cap it falls back to when blind is `limit - commanded
	// discharge`, derived HERE because only this point knows the final setpoint.
	// It is sufficient for ANY house load: export = pv + discharge - load -
	// charge <= pv + discharge <= (limit - discharge) + discharge = limit.
	//
	// COMPOSITION IS A MINIMUM, never a widening: the watchdog cap and the plan's
	// own (negative-price / FK1) curtailment compose most-restrictive-wins, so the
	// watchdog can never release a planned curtailment, and §14a/EEG/SoC/rated
	// guards are untouched - this only ever REDUCES generation, and never
	// commands the battery (absorbing a surplus is an optimizer decision, see
	// guards/surpluscharge.go).
	// LIVE CURTAILMENT (Fix D, 2026-08-29, scout report
	// vp-herzogau-einspeisung-statt-laden-h3 §2 Glied 1b / §8): where the plan
	// curtails this slot, follow the MEASUREMENT instead of standing on the
	// quarter-hour-old watt value. The plan's own 10:30 cap (36,869 kW = 6,5 kW
	// house + 30 kW battery, i.e. "export nothing") was right at 10:30 and
	// pinned the plant ~20 kW below its capability for the ten minutes in which
	// the house climbed to 29 kW - and that frozen cap fed the next run's PV
	// nowcast, which then under-estimated the surplus (the loop of §2 Glied 1b).
	//
	// The law is feed-forward from what the plant can absorb right now:
	// cap = house_measured + max(battery_command, 0). `kw` is final here - after
	// every clamp, every in-slot correction, the cars-first cap and the peak
	// guard - so the term is what the battery will REALLY take, not the power it
	// happens to draw under the old cap. See guards/curtailtrack.go for the full
	// argument, including why a closed loop on the grid measurement cannot
	// release (its fixed point is every operating point with export 0).
	//
	// It REPLACES the plan's static value, in BOTH directions, and that is safe
	// by construction: it targets ZERO grid exchange, which is at least as tight
	// as any feed-in or §14a bound, so the plan's own value can only ever have
	// been a tighter-or-equal export target. Without a planned curtailment the
	// tracker is inactive and this whole block is a no-op.
	// ⚠ The freshness anchor is the LOAD MEASUREMENT, not the tick: observing
	// with `now` would keep re-stamping a stale reading and the staged fallback
	// below could never fire. Without a reading at all nothing is observed - a
	// zero-valued Reading is not a measured house.
	if !readingAt.IsZero() {
		a.curtailTrack.Observe(readingAt, r.LoadKw, kw)
	}
	curtailCap := a.curtailTrack.Cap(now, pvLimit)
	if curtailCap.Active {
		v := curtailCap.CapKw
		pvLimit = &v
	}
	curtailTrack := a.curtailTrackInfo(curtailCap)

	exportCap := a.export.Cap(now, exportLimit, exportSafeStaticCap(exportLimit, kw))
	if exportCap.Active {
		if pvLimit == nil || exportCap.CapKw < *pvLimit {
			v := exportCap.CapKw
			pvLimit = &v
		}
	}
	exportGuard := a.exportGuardInfo(exportCap)
	a.logExportGuard(exportGuard)

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
	// controlCertified merges the env allowlist with the per-device First-Light
	// certification (agent/calibration.go), so a family the operator proved + released
	// drives the optimizer path live without an env change.
	certified := a.controlCertified(family)
	// certSource names WHICH of the three sources granted it (env allowlist /
	// this box's First-Light grant / the platform model register) - reported
	// only, it decides nothing.
	certSource := a.certSource(family)
	controlEnabled := a.Cfg.ControlEnabled && certified

	// NATIVE SELF-REGULATION (Selbstregel-Modus, guards/nativemode.go): in a slot
	// the CLOUD marked worth covering from the battery, hand the SETPOINT itself
	// back to the inverter's own self-consumption loop instead of writing a
	// recomputed watt value every 10 s. It runs LAST of the decisions - after
	// every clamp, every in-slot correction and both peak/export guards - for two
	// reasons: `kw` is then the REFERENCE the take-back would command on the very
	// next tick (so a withdrawal is instant, not a recomputation), and the mode
	// can never be entered on a value the guard chain has not finished with.
	//
	// It publishes an INTENT. Layer 1 owns the register knowledge and therefore
	// the certificate, so it decides whether it CAN, and answers on the control
	// readback; an intent that is never confirmed is withdrawn after a bounded
	// grace and the proven follower carries the slot. `kw` is published either
	// way - unchanged for the executor to write in setpoint mode, and as the
	// display/take-back reference in native mode.
	nativeDec, nativeInfo := a.nativeDecide(now, p, r, kw,
		marketCorrectionsAllowed && !surplusStored, controlEnabled, measurementFresh, freshWindow,
		effectiveFloor, peakTarget, solarOnly)

	msg := map[string]any{
		"battery_setpoint_kw": kw,
		"source":              source,
		"ts":                  now.Format(time.RFC3339Nano),
		"control_enabled":     controlEnabled,
		// device_certified is the CERTIFICATION VERDICT ALONE (control_enabled is
		// that verdict ANDed with the kill-switch). Layer 1 runs its OWN certification
		// gate from a STATIC family allowlist that cannot know the per-device
		// First-Light grant an operator issued at runtime - so a released Deye kept
		// planning writes:[] forever and the Fahrplan never reached the inverter,
		// which made the whole First-Light mechanism inert for real operation. The
		// executor ORs this runtime grant into its gate, scoped to THIS device.
		// The kill-switch stays the outer AND on both sides, and the grant is still
		// only obtainable from a readback-confirmed First-Light test (calibration.go)
		// - this changes who the grant REACHES, never how it is earned.
		"device_certified": certified,
		// Most restrictive wins: the device-local VP_GRID_CHARGE_ALLOWED gate
		// AND the plan-carried site posture (an EEG plan also turns off the
		// adapter-level grid-charge bit, e.g. Deye ToU Charging=Grid). A plan
		// without the field - or no plan - is fail-safe: the bit stays off
		// until a plan explicitly allows grid charging.
		"grid_charge_allowed": a.Cfg.GridChargeAllowed && !solarOnly,
		"soc_min_pct":         a.Cfg.SocMinPct,
		// soc_max_pct is the ceiling half of the guard band. The Deye REMOTE-MODE
		// adapter arms the inverter's own constant-SOC belt (register 1108) with the
		// bound that matches the direction - the floor for a discharge, the ceiling
		// for a charge - because a field report says the inverter's OWN min/max-SoC
		// protections may not apply in remote mode. Additive; an adapter that ignores
		// it is unchanged.
		"soc_max_pct": a.Cfg.SocMaxPct,
		// battery_mode is ADDITIVE and always present since the native mode
		// shipped: "setpoint" (write battery_setpoint_kw, the byte-for-byte
		// pre-feature behaviour) or "native" (do NOT write it - run the
		// certified native primitive and read the device's state back instead).
		// An ABSENT field means "setpoint" for a Layer 1 that predates it.
		"battery_mode": batteryModeSetpoint,
	}
	if nativeDec.Native {
		msg["battery_mode"] = batteryModeNative
		msg["battery_native_duty"] = nativeDec.Duty
	}
	if effectiveFloor != nil {
		msg["effective_floor_soc_pct"] = *effectiveFloor
	}
	// device_certified_path names the control surface the grant's First-Light
	// evidence was produced on ("remote"/"tou") - Layer 1's plan node seeds its
	// durable sticky path decision from it, so a certified remote pilot plans its
	// PROVEN path from the first post-restart tick instead of falling back to the
	// EEPROM ToU writes on a degenerate probe answer (live regression 2026-07-28).
	// Absent for env-allowlisted families and pre-path grants (backward-compatible).
	if certified {
		if p := a.certifiedControlPath(family); p != "" {
			msg["device_certified_path"] = p
		}
	}
	// pv_limit_kw is only present when the active slot caps feed-in; its ABSENCE
	// tells the adapter to clear any latched limit (backward-compatible: an
	// adapter that ignores the field keeps working).
	if pvLimit != nil {
		msg["pv_limit_kw"] = *pvLimit
	}
	// The additive PV-curtailment block for the fronius_sunspec Erzeuger
	// sources (agent/curtail.go): kill-switch, uncontrollable PV share and the
	// per-unit First-Light grants/tests the flow's fleet split consumes. Absent
	// without curtailment-capable sources - byte-identical setpoint then.
	if cur := a.curtailSetpointExtras(now); cur != nil {
		msg["curtail"] = cur
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
	trimInfo := trimSnapshot(trimmed)
	followInfo := followSnapshot(followed)
	absorbInfo := absorbSnapshot(absorbed)
	a.State.Update(func(s *state.Snapshot) {
		s.Mode = mode
		s.SetpointKw = kw
		s.SlotStart = slotStart
		s.ControlEnabled = controlEnabled
		s.ControlCertified = certified
		s.ControlCertSource = certSource
		s.PeakTargetKw = peakTarget
		s.PeakReserveSocPct = peakReserve
		s.EffectiveFloorSocPct = effectiveFloor
		s.PeakGuardActive = peakActive
		s.PeakQuarterMeanKw = quarterMean
		s.Trim = trimInfo
		s.Follow = followInfo
		s.Absorb = absorbInfo
		s.CarsFirstCapKw = carsFirstCap
		s.ExportGuard = exportGuard
		s.CurtailTrack = curtailTrack
		s.Native = nativeInfo
	})
}

func idleReadbackHealthy(control *state.ControlInfo, now time.Time, window time.Duration) bool {
	return control != nil && control.AllMatch && control.Confirm == "held" &&
		!control.CheckedAt.IsZero() && !now.Before(control.CheckedAt) &&
		now.Sub(control.CheckedAt) <= window
}

// exportSafeStaticCap is the BLIND fallback cap of the feed-in watchdog: the
// plant-level PV cap that holds the site's feed-in limit WITHOUT any
// measurement, for any house load.
//
//	export = pv + discharge - load - charge
//	      <= pv + discharge                        (load, charge >= 0)
//	      <= (limit - discharge) + discharge = limit
//
// So capping total PV at `limit - commanded discharge` is sufficient. It is
// derived at the setpoint path because only there is the final commanded
// setpoint known - a CHARGE only ever absorbs PV, so it subtracts nothing.
func exportSafeStaticCap(limitKw *float64, setpointKw float64) float64 {
	if limitKw == nil {
		return 0
	}
	discharge := 0.0
	if setpointKw < 0 && !math.IsNaN(setpointKw) && !math.IsInf(setpointKw, 0) {
		discharge = -setpointKw
	}
	if v := *limitKw - discharge; v > 0 {
		return v
	}
	return 0
}

// trimSnapshot turns one trim evaluation into the UI-facing block, or nil when
// nothing was limited (an untrimmed device then carries no trim key at all - the
// :8484 card renders exactly as before).
func trimSnapshot(t guards.TrimResult) *state.TrimInfo {
	if !t.Active {
		return nil
	}
	info := &state.TrimInfo{
		Active:    true,
		PlannedKw: math.Round(t.CommandedKw*1000) / 1000,
	}
	if !math.IsNaN(t.SurplusKw) {
		v := math.Round(t.SurplusKw*1000) / 1000
		info.SurplusKw = &v
	}
	return info
}

// followSnapshot turns one load-following evaluation into the UI-facing block,
// or nil when nothing was corrected (a device that is not following carries no
// follow key at all - the :8484 card renders exactly as before). The DIRECTION
// rides along: raising and limiting a discharge are both deliberate corrections,
// and the card must be able to say which one it did.
func followSnapshot(f guards.FollowResult) *state.FollowInfo {
	if !f.Active {
		return nil
	}
	info := &state.FollowInfo{
		Active:    true,
		Direction: f.Direction,
		Path:      f.Path,
		PlannedKw: math.Round(f.CommandedKw*1000) / 1000,
	}
	if !math.IsNaN(f.DeficitKw) {
		v := math.Round(f.DeficitKw*1000) / 1000
		info.DeficitKw = &v
	}
	if f.FloorSocPct != nil {
		v := math.Round(*f.FloorSocPct*1000) / 1000
		info.FloorSocPct = &v
	}
	return info
}

// absorbSnapshot turns one surplus-absorption evaluation into the UI-facing
// block, or nil when nothing was raised (a device that is not absorbing carries
// no absorb key at all - the :8484 card renders exactly as before). Like its two
// siblings it carries the PLAN's own value: a setpoint far ABOVE the Fahrplan
// number with no reason next to it reads as a defect.
func absorbSnapshot(a guards.AbsorbResult) *state.AbsorbInfo {
	if !a.Active {
		return nil
	}
	info := &state.AbsorbInfo{
		Active:    true,
		Path:      a.Path,
		PlannedKw: math.Round(a.CommandedKw*1000) / 1000,
	}
	if !math.IsNaN(a.SurplusKw) {
		v := math.Round(a.SurplusKw*1000) / 1000
		info.SurplusKw = &v
	}
	return info
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
		// Bound each drain turn so a multi-hour replay in either additive
		// pipeline cannot starve the other one after reconnect.
		for sent := 0; sent < 256; sent++ {
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
		for sent := 0; sent < 256; sent++ {
			e, ok := a.measurementOutbox.Next()
			if !ok {
				break
			}
			if err := link.PublishMeasurementSamples(e.Raw); err != nil {
				slog.Warn("measurement publish failed; will retry", "seq", e.Sequence, "err", err)
				break
			}
			if err := a.measurementOutbox.Ack(e.Sequence); err != nil {
				slog.Error("measurement outbox ack failed", "err", err)
				break
			}
			select {
			case <-ctx.Done():
				return
			default:
			}
		}
		if a.buf.Pending() > 0 || a.measurementOutbox.Pending() > 0 {
			a.kick()
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
	// Einheitsmodell Stufe 1: on a portal-managed plant the Soll lives in the
	// portal - two writers on one configuration would make the next push
	// silently discard whatever was typed here.
	if err := a.refuseIfPortalManaged(); err != nil {
		return inverter.Selection{}, err
	}
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
	// The mirror's native pass-through area follows the device's mb_slave_id.
	a.applyMirrorNativeUnit()
	// The PLATFORM register is matched against brand+model+family+sign, so a
	// changed selection can gain or lose the grant. Re-derive it (and nudge the
	// setpoint if the gate flipped) instead of leaving a stale verdict on the
	// card - the register did not change, but what it applies to did.
	a.refreshPlatformCertAfterSelectionChange()
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
	load *float64 // Consumer load (kW, >= 0); only a consumer source populates it
	// relayOn is the switch state of a relay consumer source (shelly). It is
	// a REAL fact both metering and non-metering relays have - for the
	// non-metering class it is the ONLY per-reading fact, so it carries the
	// freshness/liveness of that source (a fabricated load would not).
	relayOn *bool
	recv    time.Time
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
// telemetry): keep the latest PV, signed grid power and/or consumer load per
// source, by role. An Erzeuger carries pv_power_kw; a Netz meter carries power_kw
// (signed, +import/-export); a Consumer (e.g. a go-e wallbox) carries load_kw
// (>= 0). It never fabricates a value - an absent/invalid field is simply not
// recorded, so the source contributes nothing; a reading with no usable field at
// all is dropped entirely (never advances freshness). Consumer load is recorded
// for the setup page's "Zuletzt gelesen" + freshness status; its aggregation
// into the house balance / a consumer entity is topology-layer work.
func (a *Agent) onSourceTelemetry(topic string, payload []byte) {
	id := sources.IDFromTopic(topic)
	if id == "" {
		slog.Warn("source telemetry on unexpected topic; skipped", "topic", topic)
		return
	}
	var m struct {
		PvPowerKw *float64 `json:"pv_power_kw"`
		PowerKw   *float64 `json:"power_kw"`
		LoadKw    *float64 `json:"load_kw"`
		RelayOn   *bool    `json:"relay_on"`
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
	pv, grid, load := usable(m.PvPowerKw), usable(m.PowerKw), usable(m.LoadKw)
	if pv == nil && grid == nil && load == nil && m.RelayOn == nil {
		return // nothing usable in this reading
	}
	now := time.Now().UTC()
	a.srcMu.Lock()
	var period time.Duration
	if prev, ok := a.srcReadings[id]; ok && !prev.recv.IsZero() {
		period = now.Sub(prev.recv) // the ACHIEVED cadence, feeds the freshness window
	}
	a.srcReadings[id] = sourceReading{pv: pv, grid: grid, load: load, relayOn: m.RelayOn,
		recv: now, period: period}
	a.srcMu.Unlock()
	// Feed a running curtailment First-Light test with the unit's measured
	// output (the enforcement half of the evidence) - a no-op without a test.
	if pv != nil {
		a.curtailObserve(id, *pv, now)
	}
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
			LoadKw:   r.load,
			RelayOn:  r.relayOn,
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
	if sel.Communication == inverter.CommShellyHTTP {
		// Shelly is CORE-owned (single-writer, internal/shelly): the one-shot
		// test runs in-process - detect the generation dialect + metering
		// capability FRESH (an unsaved form is never answered from the
		// persisted identity store) and read the relay state. Node-RED has no
		// shelly reader, so the flow round-trip would only time out.
		return a.shellyTest(req)
	}
	res := a.testReadExchange(sel, req.Role, false, testReadTimeout)
	if res.OK && req.ControlTest && sel.Communication == inverter.CommGoeHTTP {
		// The D11 write short-test (go-e wallbox): re-write the charger's
		// CURRENT requested current and read it back - non-disruptive by
		// construction (a value-identical write), run ONLY on the wizard's
		// explicit request. It runs in the CORE (the single go-e writer -
		// Node-RED stays read-only), and it is deliberately independent of the
		// control flags: the wizard proves the write path BEFORE an operator
		// arms VP_CONTROL_ENABLED/VP_CONSUMER_CONTROL_ENABLED.
		res.ControlCheck = a.goeControlCheck(req.Connection)
	}
	return res
}

// goeControlCheck runs the non-disruptive go-e write short-test against the
// UNSAVED connection form. Never nil: a malformed connection yields the honest
// invalid_request verdict.
func (a *Agent) goeControlCheck(conn testconn.Connection) *testconn.ControlCheck {
	raw, _ := json.Marshal(conn)
	var cfg goe.Config
	_ = json.Unmarshal(raw, &cfg)
	doer := a.goeDoer
	if doer == nil {
		doer = goeHTTPDoer{c: &http.Client{Timeout: goeHTTPTimeout}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), testReadTimeout)
	defer cancel()
	out := goe.ControlCheck(ctx, doer, cfg)
	return &testconn.ControlCheck{
		OK: out.OK, Key: out.Key, Value: out.Value,
		ErrorCode: out.ErrorCode, Message: out.Message,
		PhaseSwitchMode: out.PhaseSwitchMode, PhasesInUse: out.PhasesInUse,
	}
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
	if !inverter.IsSunSpecTCP(sel.Communication) {
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
		Finding    *testconn.Finding `json:"finding"`
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
	// The reading rides a REFUSAL too when a Finding names the one violating
	// channel: the flow really read the device and the other channels decoded.
	case ch <- testconn.Result{OK: m.OK, ErrorCode: m.ErrorCode, Message: m.Message,
		Reading: m.Reading, Finding: m.Finding, FoundUnits: m.FoundUnits}:
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
	if err := a.refuseIfPortalManaged(); err != nil {
		return sources.Source{}, err
	}
	src, err := sources.Normalize(a.invCat, req, time.Now())
	if err != nil {
		return sources.Source{}, err
	}
	// Deterministic id from the transport identity: deleting + re-adding the
	// same physical device converges on the SAME id, so the portal's adoption
	// pin survives (vp-vier-erzeuger-p9). An already-taken id (a second source
	// with the identical transport identity - not a valid setup) falls back to
	// a random id so both rows stay addressable, loudly.
	src.ID = sources.DeterministicID(src)
	a.srcMu.Lock()
	for i := range a.srcs {
		if a.srcs[i].ID == src.ID {
			src.ID = sources.NewID()
			slog.Warn("source id collision: identical transport identity already configured; "+
				"falling back to a random id", "existing", a.srcs[i].ID, "fallback", src.ID,
				"ip", src.Connection.IP)
			break
		}
	}
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
	if err := a.refuseIfPortalManaged(); err != nil {
		return err
	}
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

// RenameSource updates ONLY the label of an existing source - identity
// (id/transport) and master data stay untouched. This is the "Umbenennen
// ohne Identitätswechsel" the sources UI lacked: before it, the only way to
// rename was delete + re-add, which minted a new id and orphaned the portal's
// adoption pin (vp-vier-erzeuger-p9). Unknown id -> sources.ErrNotFound; an
// empty/oversized label -> *sources.ValidationError (HTTP 400 upstream).
func (a *Agent) RenameSource(id, label string) (sources.Source, error) {
	if err := a.refuseIfPortalManaged(); err != nil {
		return sources.Source{}, err
	}
	label = strings.TrimSpace(label)
	if label == "" || len([]rune(label)) > 64 {
		return sources.Source{}, &sources.ValidationError{
			Msg: "Bitte einen Namen mit 1 bis 64 Zeichen angeben."}
	}
	a.srcMu.Lock()
	idx := -1
	for i := range a.srcs {
		if a.srcs[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		a.srcMu.Unlock()
		return sources.Source{}, sources.ErrNotFound
	}
	previous := a.srcs[idx].Label
	a.srcs[idx].Label = label
	updated := a.srcs[idx]
	list := append([]sources.Source(nil), a.srcs...)
	a.srcMu.Unlock()
	if err := a.srcStore.Save(list); err != nil {
		// Roll back the in-memory rename so disk + memory stay consistent
		// (the AddSource/DeleteSource discipline).
		a.srcMu.Lock()
		if idx < len(a.srcs) && a.srcs[idx].ID == id {
			a.srcs[idx].Label = previous
		}
		a.srcMu.Unlock()
		return sources.Source{}, fmt.Errorf("Energiequelle konnte nicht umbenannt werden: %w", err)
	}
	a.publishSourcesConfig()
	slog.Info("measurement point renamed", "id", id)
	return updated, nil
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
	a.stopOcpp()
	if a.Bus != nil {
		_ = a.Bus.Close()
	}
	if a.mir != nil {
		a.mir.Stop()
	}
	a.done.Wait()
	_ = a.buf.Close()
}
