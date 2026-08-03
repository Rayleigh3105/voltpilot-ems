// Package cloud is the SINGLE outbound connection to the VoltPilot broker:
// one mTLS MQTT link (paho) using the enrolled device certificate.
//
// It publishes contract telemetry + status on the device's own topic path
// and subscribes the retained schedule topic
// (docs/contracts/mqtt-telemetry.schema.json x-topics /
// mqtt-schedule.schema.json). Username/clientid stay unset - the hardened
// broker derives both from the certificate CN (docs/connect-a-device.md).
package cloud

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/buffer"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
)

// Link is the cloud MQTT connection.
type Link struct {
	client   pahomqtt.Client
	identity enroll.Identity
	// version is the BUILD stamp (agent.Version). It is a link-level field on
	// purpose: OTA Stufe 0 requires the top-level `version` to ride EVERY
	// heartbeat, so it must not be a per-call argument a future caller could
	// forget or condition on something.
	version string

	onSchedule     func(payload []byte)
	onCommand      func(payload []byte)
	onEntities     func(payload []byte)
	onPlanV2       func(payload []byte)
	onFlows        func(payload []byte)
	onUpdateTarget func(payload []byte)
	onConnect      func(connected bool)
}

// Options configure the link.
type Options struct {
	Identity enroll.Identity
	// mTLS material (ignored when DevURL is set).
	KeyPath, CertPath, CAPath string
	// DevURL is the dev-only plain-MQTT escape hatch, e.g. "tcp://host:1883"
	// (mirrors tools/edge-simulator --insecure). Empty in production.
	DevURL string
	// DevInsecure skips server-cert verification (dev only).
	DevInsecure bool
	// OnSchedule receives every (retained) schedule payload.
	OnSchedule func(payload []byte)
	// OnCommand receives every (retained) ad-hoc command payload, e.g. the
	// purge_data command (docs/contracts/mqtt-data-purge.schema.json).
	OnCommand func(payload []byte)
	// OnEntities receives the retained v2 entity-registry push on
	// .../v2/entities (docs/contracts/v2/edge-entity-config.md §1). An EMPTY
	// payload is delivered too - it clears the registry (retained-clear). nil
	// = the v2 entity layer is not wired (pure v1 build behavior).
	OnEntities func(payload []byte)
	// OnPlanV2 receives the retained multi-entity plan on .../v2/plan
	// (docs/contracts/v2/mqtt-schedule-2.0.md). Empty payload = retained
	// clear. nil = the v2 plan executor is not wired.
	OnPlanV2 func(payload []byte)
	// OnFlows receives the retained flow deployment set on .../v2/flows
	// (docs/contracts/v2/flow-artifact.md §3). Empty payload = retained
	// clear (every artifact tab removed). nil = flow deployment not wired.
	OnFlows func(payload []byte)
	// OnUpdateTarget receives the retained OTA update assignment on
	// .../v2/update (docs/contracts/mqtt-ota-target.schema.json, OTA Stufe 2).
	// An EMPTY payload IS forwarded - it withdraws the assignment
	// (retained-clear, e.g. on unclaim). nil = the OTA downlink is not wired.
	//
	// This delivers the SIGNED manifest bytes; it does NOT authorize anything.
	// The device verifies against its own baked root before the assignment
	// means a thing, and applying stays supervised in this stage.
	OnUpdateTarget func(payload []byte)
	// OnConnect is called with the connection state on every transition.
	OnConnect func(connected bool)
	// ClientID override for dev; production leaves it to the broker (CN).
	DevClientID string
	// Version is the ldflags-stamped build version (agent.Version). It rides
	// EVERY status heartbeat as the top-level `version` field (OTA Stufe 0) -
	// independent of the `flows` ack block, which only exists once the device
	// has seen a flow deployment. Empty = omit the field (never a fabricated
	// empty version).
	Version string
}

func (o Options) brokerURL() string {
	if o.DevURL != "" {
		return o.DevURL
	}
	return fmt.Sprintf("ssl://%s:%d", o.Identity.MqttHost, o.Identity.MqttPort)
}

// New builds (but does not connect) the link.
func New(o Options) (*Link, error) {
	l := &Link{identity: o.Identity, version: o.Version, onSchedule: o.OnSchedule,
		onCommand: o.OnCommand, onEntities: o.OnEntities, onPlanV2: o.OnPlanV2,
		onFlows: o.OnFlows, onUpdateTarget: o.OnUpdateTarget, onConnect: o.OnConnect}

	opts := pahomqtt.NewClientOptions().
		AddBroker(o.brokerURL()).
		SetAutoReconnect(true).
		SetMaxReconnectInterval(60 * time.Second).
		SetConnectRetry(true).
		SetConnectRetryInterval(5 * time.Second).
		SetCleanSession(false).
		SetOrderMatters(true).
		SetKeepAlive(30 * time.Second)

	if o.DevURL == "" {
		tlsCfg, err := mtlsConfig(o.KeyPath, o.CertPath, o.CAPath, o.Identity.MqttHost, o.DevInsecure)
		if err != nil {
			return nil, err
		}
		opts.SetTLSConfig(tlsCfg)
		// clientid must be non-empty for paho; the hardened broker overrides
		// it from the cert CN (peer_cert_as_clientid), so the wire value is
		// irrelevant - use the device id for readable broker logs.
		opts.SetClientID(o.Identity.DeviceID)
	} else {
		cid := o.DevClientID
		if cid == "" {
			cid = "vp-edge-core-" + o.Identity.DeviceID
		}
		opts.SetClientID(cid)
	}

	opts.OnConnect = func(c pahomqtt.Client) {
		slog.Info("cloud link connected", "broker", o.brokerURL())
		topic := l.topic("schedule")
		if tok := c.Subscribe(topic, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
			if l.onSchedule != nil {
				l.onSchedule(msg.Payload())
			}
		}); tok.Wait() && tok.Error() != nil {
			slog.Error("schedule subscribe failed", "topic", topic, "err", tok.Error())
		}
		// Ad-hoc cloud commands, e.g. the retained purge_data command. Retained
		// delivery means a device that was OFFLINE during a purge wipes its
		// buffers right here on reconnect, BEFORE the publisher drains anything.
		cmdTopic := l.topic("command")
		if tok := c.Subscribe(cmdTopic, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
			if l.onCommand != nil && len(msg.Payload()) > 0 {
				l.onCommand(msg.Payload())
			}
		}); tok.Wait() && tok.Error() != nil {
			slog.Error("command subscribe failed", "topic", cmdTopic, "err", tok.Error())
		}
		// The retained v2 entity-registry push (only when the entity layer is
		// wired): retained delivery makes every (re)connect converge; an empty
		// payload IS forwarded - it clears the registry.
		if l.onEntities != nil {
			entTopic := l.topic("v2/entities")
			if tok := c.Subscribe(entTopic, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
				l.onEntities(msg.Payload())
			}); tok.Wait() && tok.Error() != nil {
				slog.Error("v2 entities subscribe failed", "topic", entTopic, "err", tok.Error())
			}
		}
		// The retained schedule-2.0 plan and the retained flow deployment set
		// live in the same v2/# subtree (D-2); empty payloads ARE forwarded
		// (retained-clear semantics).
		if l.onPlanV2 != nil {
			planTopic := l.topic("v2/plan")
			if tok := c.Subscribe(planTopic, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
				l.onPlanV2(msg.Payload())
			}); tok.Wait() && tok.Error() != nil {
				slog.Error("v2 plan subscribe failed", "topic", planTopic, "err", tok.Error())
			}
		}
		if l.onFlows != nil {
			flowsTopic := l.topic("v2/flows")
			if tok := c.Subscribe(flowsTopic, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
				l.onFlows(msg.Payload())
			}); tok.Wait() && tok.Error() != nil {
				slog.Error("v2 flows subscribe failed", "topic", flowsTopic, "err", tok.Error())
			}
		}
		// The retained OTA update assignment (OTA Stufe 2), in the same v2/#
		// subtree the per-device ACL already covers (D-2). Retained delivery is
		// the whole distribution mechanism: a box that was offline when the
		// rollout started picks its assignment up right here on reconnect -
		// there is no push, and there never can be one behind NAT.
		if l.onUpdateTarget != nil {
			updTopic := l.topic("v2/update")
			if tok := c.Subscribe(updTopic, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
				l.onUpdateTarget(msg.Payload())
			}); tok.Wait() && tok.Error() != nil {
				slog.Error("v2 update subscribe failed", "topic", updTopic, "err", tok.Error())
			}
		}
		if l.onConnect != nil {
			l.onConnect(true)
		}
	}
	opts.OnConnectionLost = func(_ pahomqtt.Client, err error) {
		slog.Warn("cloud link lost; buffering continues, reconnect is automatic", "err", err)
		if l.onConnect != nil {
			l.onConnect(false)
		}
	}

	l.client = pahomqtt.NewClient(opts)
	return l, nil
}

func mtlsConfig(keyPath, certPath, caPath, serverName string, insecure bool) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, fmt.Errorf("device certificate: %w", err)
	}
	caPem, err := os.ReadFile(caPath)
	if err != nil {
		return nil, fmt.Errorf("ca certificate: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPem) {
		return nil, fmt.Errorf("ca certificate %s: no PEM certs found", caPath)
	}
	return &tls.Config{
		Certificates:       []tls.Certificate{cert},
		RootCAs:            pool,
		ServerName:         serverName,
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: insecure,
	}, nil
}

// Connect starts the (retrying) connection attempt; non-blocking.
func (l *Link) Connect() {
	l.client.Connect()
}

// Connected reports the live connection state.
func (l *Link) Connected() bool {
	return l.client.IsConnectionOpen()
}

func (l *Link) topic(leaf string) string {
	return fmt.Sprintf("ems/%s/%s/%s/%s", l.identity.TenantID, l.identity.SiteID, l.identity.DeviceID, leaf)
}

// PublishTelemetry publishes ONE buffered entry as a contract-exact
// telemetry payload (schema_version 1.0, ORIGINAL timestamp) and waits for
// the QoS1 ack. The caller acks the buffer cursor only on nil error.
func (l *Link) PublishTelemetry(e buffer.Entry) error {
	payload := map[string]any{
		"schema_version": "1.0",
		"tenant_id":      l.identity.TenantID,
		"site_id":        l.identity.SiteID,
		"device_id":      l.identity.DeviceID,
		"ts":             e.Ts.UTC().Format(time.RFC3339Nano),
		"seq":            e.Seq,
		"measurements":   e.Measurements,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	tok := l.client.Publish(l.topic("telemetry"), 1, false, raw)
	if !tok.WaitTimeout(30 * time.Second) {
		return fmt.Errorf("telemetry publish timed out")
	}
	return tok.Error()
}

// PublishTelemetryV2 publishes ONE buffered v2 entry (EntityID non-empty) as
// a contract-exact mqtt-telemetry-2.0 payload on .../v2/telemetry (QoS1, not
// retained, ORIGINAL timestamp) and waits for the ack. Since E1b the v2
// uplink rides the store-and-forward buffer exactly like v1: the caller acks
// the buffer cursor only on nil error, and a replayed entry keeps its
// original ts (the cloud writer keys liveness on arrival time and is
// idempotent per (entity, channel, time)).
func (l *Link) PublishTelemetryV2(e buffer.Entry) error {
	payload := map[string]any{
		"schema_version": "2.0",
		"tenant_id":      l.identity.TenantID,
		"site_id":        l.identity.SiteID,
		"device_id":      l.identity.DeviceID,
		"ts":             e.Ts.UTC().Format(time.RFC3339Nano),
		"seq":            e.Seq,
		"entities": map[string]any{
			e.EntityID: map[string]any{"channels": e.Measurements},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	tok := l.client.Publish(l.topic("v2/telemetry"), 1, false, raw)
	if !tok.WaitTimeout(30 * time.Second) {
		return fmt.Errorf("v2 telemetry publish timed out")
	}
	return tok.Error()
}

// EntitiesSummary is the additive status-heartbeat block acknowledging the
// applied v2 entity registry (edge-entity-config.md §5): the cloud compares
// Revision against its latest push to verify convergence. nil = no v2
// entities on this device (the block is omitted; pure v1 heartbeat).
type EntitiesSummary struct {
	Revision  string   `json:"revision"`
	AppliedAt string   `json:"applied_at"`
	Count     int      `json:"count"`
	IDs       []string `json:"ids"`
	// Arbitration is the E2 extension (edge-desired-arbitration.md §6 sink 3):
	// per entity the holder source, the granted command and the latest
	// readback verdict. Additive; absent for entities without a decision.
	Arbitration map[string]EntityArbitration `json:"arbitration,omitempty"`
	// Observed is the E1b per-entity Ist (edge-entity-config.md §5): the type
	// as applied plus telemetry health. Additive; keys are entity ids.
	Observed map[string]EntityObserved `json:"observed,omitempty"`
	// LocalSetup reports the edge-authoritative commissioning view (the
	// :8484 inverter selection + sources) so the cloud can SEE edge-side
	// master data that has no registry counterpart. The cloud reconciles and
	// surfaces drift; it never auto-imports.
	LocalSetup []LocalSetupEntry `json:"local_setup,omitempty"`
}

// EntityObserved is one entity's edge-side Ist in the heartbeat (E1b).
type EntityObserved struct {
	EntityType string `json:"entity_type"`
	// Health: ok = local telemetry within the liveness window | stale = had
	// readings, none recently | never = none since boot.
	Health          string   `json:"health"`
	LastTelemetryAt string   `json:"last_telemetry_at,omitempty"`
	Channels        []string `json:"channels,omitempty"`
}

// LocalSetupEntry is one edge-local commissioning item (inverter or source).
type LocalSetupEntry struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"` // inverter | source
	Role  string `json:"role,omitempty"`
	Brand string `json:"brand,omitempty"`
	Model string `json:"model,omitempty"`
	Label string `json:"label,omitempty"`
}

// SourcesSummary is the additive status-heartbeat block reporting the
// edge-authoritative PER-MEASUREMENT-POINT Ist: the primary inverter plus every
// configured additional source with its LATEST reading and freshness. It exists
// so the cloud can show WHY the composite PV is what it is - a multi-inverter
// site's portal PV ("39,0 kW") is the sum of several devices, and before this
// the only place to see the parts was the edge's own :8484 page.
//
// It rides the STATUS channel, never telemetry: the composite site reading on
// the telemetry topic is unchanged, this is pure added visibility. Bounded by
// maxSourceEntries so a misconfigured device can never inflate the heartbeat.
type SourcesSummary struct {
	// ReportedAt is when the edge assembled this view (RFC 3339).
	ReportedAt string `json:"reported_at"`
	// Entries are the primary inverter first, then the configured sources in
	// their persisted order. Never nil when the block is present.
	Entries []SourceEntry `json:"entries"`
}

// maxSourceEntries bounds the per-source block (a handful of sources per site;
// the portal breakdown is a calm one-liner, not a table).
const maxSourceEntries = 16

// SourceEntry is one measurement point's live Ist for the cloud breakdown.
// Absent measurements stay ABSENT (nil), never a fabricated 0 - the
// drop-don't-fabricate discipline the whole edge follows.
type SourceEntry struct {
	ID   string `json:"id"`
	Kind string `json:"kind"` // primary | source
	// Role is the source role (pv-generation | grid-meter | consumer); empty
	// for the primary inverter, whose role is implied.
	Role  string `json:"role,omitempty"`
	Label string `json:"label,omitempty"`
	Brand string `json:"brand,omitempty"`
	Model string `json:"model,omitempty"`
	// PvKw / PowerKw / LoadKw are the point's own latest measured values
	// (PowerKw signed, +import/-export).
	PvKw    *float64 `json:"pv_kw,omitempty"`
	PowerKw *float64 `json:"power_kw,omitempty"`
	LoadKw  *float64 `json:"load_kw,omitempty"`
	// Health: ok = a reading inside the point's freshness window |
	// stale = had a reading, none recently | never = nothing since boot.
	Health string `json:"health"`
	// ReadAt is when the latest reading arrived (RFC 3339); empty for never.
	ReadAt string `json:"read_at,omitempty"`
}

// EntityArbitration is one entity's decision summary in the heartbeat.
type EntityArbitration struct {
	// Holder is the holder's source kind ("" = registry failsafe).
	Holder string `json:"holder,omitempty"`
	// Source is the command-topic vocabulary: plan | desired | failsafe.
	Source string `json:"source,omitempty"`
	// GrantedSetpointKw echoes the granted setpoint when one is commanded.
	GrantedSetpointKw *float64 `json:"granted_setpoint_kw,omitempty"`
	// AllMatch is the latest per-entity readback verdict (nil = none yet).
	AllMatch *bool `json:"all_match,omitempty"`
}

// The OTA update states (scout vp-ota-rollout-h4 §5). Stufe 0 only ever
// reports Idle - the rest is the vocabulary the later stages fill in, declared
// here so cloud and edge speak ONE language from the first heartbeat on.
const (
	UpdateStateIdle        = "idle"
	UpdateStateVerifying   = "verifying"
	UpdateStateDeferred    = "deferred"
	UpdateStateDownloading = "downloading"
	UpdateStateApplying    = "applying"
	UpdateStateSelfTest    = "self_test"
	UpdateStateSucceeded   = "succeeded"
	UpdateStateFailed      = "failed"
	UpdateStateRolledBack  = "rolled_back"
)

// UpdateBackendCompose is the apply backend of today's fleet: docker compose
// (the boxes are updated by update.sh). The field exists from Stufe 0 on
// because the contract is deliberately runtime-agnostic - a podman/quadlet or
// Mender box reports its own backend and nothing above it changes.
const UpdateBackendCompose = "compose"

// UpdateSummary is the additive `update` block of the status heartbeat (scout
// vp-ota-rollout-h4 §5), the device's own answer to "what am I running and
// what am I doing about it".
//
// **Honesty over completeness.** Stufe 0 fills only what the box can actually
// know: the backend, the version it is running (verbatim as stamped), and
// state=idle. Everything else stays ABSENT rather than invented:
//
//   - CurrentSeq/TargetSeq/Target/Channel need the cloud's release register and
//     a target assignment - neither exists on the device before Stufe 2.
//   - LastKnownGood needs an update to have been applied and committed once;
//     a box that never updated has no last-known-good, and claiming the
//     current version as one would fabricate a rollback target.
//
// Reason is MANDATORY (German) for deferred/failed/rolled_back once those
// states exist - a red state that cannot say why is only an alarm.
type UpdateSummary struct {
	Backend       string `json:"backend"`
	Current       string `json:"current,omitempty"`
	CurrentSeq    *int64 `json:"current_seq,omitempty"`
	Target        string `json:"target,omitempty"`
	TargetSeq     *int64 `json:"target_seq,omitempty"`
	Channel       string `json:"channel,omitempty"`
	State         string `json:"state"`
	Reason        string `json:"reason,omitempty"`
	LastKnownGood string `json:"last_known_good,omitempty"`
	// TargetVerdict is the VERIFIER's own verdict on the assigned release
	// (ok | deferred | rejected), added in OTA Stufe 2. Absent = no assignment.
	//
	// It stands NEXT TO State because they answer different questions: State
	// is the state of the APPLICATION, TargetVerdict the state of the CHECK.
	// In this stage "verified, waiting for a human" and "valid but not for this
	// device" are both State=deferred - only this field separates them
	// machine-readably, so no surface has to grep the German reason.
	TargetVerdict string `json:"target_verdict,omitempty"`
}

// FlowsSummary is the additive status-heartbeat block acknowledging the
// applied flow deployment set (flow-artifact.md §5). nil = flow deployment
// not wired / nothing ever deployed (block omitted).
type FlowsSummary struct {
	PaletteVersion string        `json:"palette_version,omitempty"`
	CoreVersion    string        `json:"core_version,omitempty"`
	Applied        []AppliedFlow `json:"applied"`
}

// AppliedFlow acknowledges one artifact: state active | error | unsupported.
type AppliedFlow struct {
	FlowID      string `json:"flow_id"`
	FlowVersion int    `json:"flow_version"`
	ContentHash string `json:"content_hash"`
	State       string `json:"state"`
	Detail      string `json:"detail,omitempty"`
}

// FlowNodeStatusSummary is the additive, FEATURE-FLAGGED status-heartbeat block
// carrying the per-node live state of the deployed flows (Portal v3 M5 Part C):
// the portal editor renders "erfüllt" / "EIN seit 14:02" on the node it belongs
// to. Strictly REPORTING - nothing here commands anything.
//
// It is additive and bounded exactly like SourcesSummary: an edge with the flag
// off (the default) simply omits the block, and the portal then shows channel
// values only and NO node state - never a guessed one.
type FlowNodeStatusSummary struct {
	// ReportedAt is when the edge assembled this view (RFC 3339).
	ReportedAt string `json:"reported_at"`
	// Nodes are the currently known per-node states, newest state per node.
	Nodes []FlowNodeState `json:"nodes"`
}

// maxFlowNodeStates bounds the block so a misbehaving flow cannot inflate the
// heartbeat (a customer automation is a handful of nodes).
const maxFlowNodeStates = 128

// FlowNodeState is ONE node's reported state. Absent fields stay absent.
type FlowNodeState struct {
	FlowID string `json:"flow_id"`
	NodeID string `json:"node_id"`
	// State is the vocabulary the portal maps: active | idle | error.
	State string `json:"state"`
	// Text is the node's own short status text, when it sent one.
	Text string `json:"text,omitempty"`
	// Since is when the state was entered (RFC 3339), when known.
	Since string `json:"since,omitempty"`
}

// ActiveControl is the READ-ONLY "Aktive Steuerung" view the edge :8484 page
// renders (report §7): the RESULT of the portal-composed flows, never the flow
// graph itself. It reuses the SAME facts the status heartbeat already carries -
// the applied flow deployment set (Flows) plus the per-entity arbitration
// winner (Entities) - so the edge shows "what is running and what is steering
// each entity RIGHT NOW" without ever composing. Empty (no flows, no entity
// decisions) => the page shows its honest empty state. There is NO write path.
type ActiveControl struct {
	// PaletteVersion is the running vp-palette version (from the deployer),
	// "" when flow deployment is not wired / nothing was ever deployed.
	PaletteVersion string `json:"palette_version,omitempty"`
	// Flows are the deployed @vp-flow tabs with their last ack state. Empty
	// (never nil) when nothing is deployed.
	Flows []AppliedFlow `json:"flows"`
	// Entities are the per-entity arbitration winners: only entities an active
	// holder (a flow, an override, or the plan executor) is currently steering.
	// Empty (never nil) when the arbiter commands nothing.
	Entities []ActiveControlEntity `json:"entities"`
}

// ActiveControlEntity is one entity's current arbitration winner, enriched with
// the entity's label/type so the read-only strip can name it for the customer
// (EntityArbitration alone is keyed by id and carries no label). Read-only.
type ActiveControlEntity struct {
	EntityID string `json:"entity_id"`
	Label    string `json:"label,omitempty"`
	Type     string `json:"entity_type,omitempty"`
	// Holder is the winning source kind (e.g. flow | plan | override), "" when
	// the registry failsafe runs.
	Holder string `json:"holder,omitempty"`
	// Source is the command-topic vocabulary: plan | desired | failsafe.
	Source string `json:"source,omitempty"`
	// SetpointKw echoes the granted setpoint when one is commanded.
	SetpointKw *float64 `json:"setpoint_kw,omitempty"`
	// AllMatch is the latest per-entity readback verdict (nil = none yet).
	AllMatch *bool `json:"all_match,omitempty"`
}

// ControlSummary is the compact inverter-control confirmation folded into the
// status heartbeat (report §5.3), so the cloud sees "Fahrplan sagt X ->
// Wechselrichter bestätigt Y" without register-level detail. Additive; the
// status heartbeat has no frozen schema, schema_version stays "1.0".
type ControlSummary struct {
	CommandedKw    *float64 `json:"commanded_kw"`
	ConfirmedKw    *float64 `json:"confirmed_kw"`
	AllMatch       bool     `json:"all_match"`
	ControlEnabled bool     `json:"control_enabled"`
	Certified      bool     `json:"certified"`
	SlotStart      string   `json:"slot_start,omitempty"`
	CheckedAt      string   `json:"checked_at"`
	MismatchRoles  []string `json:"mismatch_roles"`
	// ControlPath names WHICH Deye control surface drove the write: "remote" (the
	// Tier-2 register block 1100-1121) or "tou" (the legacy Time-of-Use synthesis).
	// Additive and informational - empty for every other adapter.
	ControlPath string `json:"control_path,omitempty"`
	// PossibleConflict surfaces the dual-controller "only-controller" awareness to
	// the cloud (additive; report §9 #6). True = a commanded register is not held
	// while actively controlling -> a second controller may be steering the inverter.
	PossibleConflict bool `json:"possible_conflict,omitempty"`
	// Execution is WHY the commanded value is what it is - see ExecutionSummary.
	// Additive; absent on an older core, and the cloud then keeps its generic
	// "the device adjusted the value" wording.
	Execution *ExecutionSummary `json:"execution,omitempty"`
}

// ExecutionSummary is the additive `execution` block inside ControlSummary
// (Fahrplan-Konzept vp-fahrplan-kunde-konzept §5, PR 3): the in-slot correction
// the box applied, so the cloud can name it instead of guessing.
//
// The reported problem it closes: since the in-slot duties (2026-07-30) the box
// DELIBERATELY deviates from the plan's watt value - it tracks the measured
// house deficit (load following) or holds a charge at the measured PV surplus
// (price-aware trim). CommandedKw already carries the CORRECTED value, but the
// heartbeat carried no trace of the correction, so the portal could only state
// that "something was adjusted" - without direction, without cause. The
// direction is the load-bearing half: raising and limiting a discharge are both
// deliberate, and an unnamed correction reads as a defect.
//
// Every field except Mode is optional, and each one is only present when the
// device actually measured it - an absent value is never coerced to 0.
type ExecutionSummary struct {
	// Mode is what drives the commanded setpoint right now:
	//
	//	"plan"     - the fresh cloud plan's own value, uncorrected
	//	"follow"   - in-slot load following (guards.LoadFollower)
	//	"trim"     - price-aware in-slot trim (guards.PriceTrimmer)
	//	"absorb"   - in-slot surplus absorption (guards.SurplusCharger): the
	//	             commanded CHARGE was RAISED to the measured PV surplus
	//	"fallback" - no fresh plan: the built-in self-consumption rule
	//
	// A cloud that does not know a mode DROPS it (the strict filter in the api's
	// ControlStatusListener), so an older portal degrades to its generic wording
	// instead of rendering a word it cannot explain.
	Mode string `json:"mode"`
	// Direction is guards.FollowDeepen ("deepen", the discharge was RAISED to
	// cover the house) or guards.FollowReduce ("reduce", it was LIMITED to what
	// the house needs). Only set for mode "follow".
	Direction string `json:"direction,omitempty"`
	// PlannedKw is the setpoint BEFORE the correction - what the plan/holder
	// asked for, so the portal can show plan and execution side by side instead
	// of two contradicting numbers under one word. Only set for follow/trim.
	PlannedKw *float64 `json:"planned_kw,omitempty"`
	// DeficitKw is the measured house deficit max(load - pv, 0) a "follow"
	// discharge tracks; absent when unknown (the correction is inactive then -
	// never regulate blind).
	DeficitKw *float64 `json:"deficit_kw,omitempty"`
	// SurplusKw is the measured PV surplus a charge is held at ("trim") or
	// raised to ("absorb"); absent when unknown, same rule as DeficitKw.
	SurplusKw *float64 `json:"surplus_kw,omitempty"`
}

// CurtailmentSummary is the additive `curtailment` heartbeat block: the
// device's CURTAILMENT CAPABILITY + latest execution state, so the cloud can
// distinguish a Fahrplan "Abregeln" slot that is "geplant und ausgeführt" from
// one that is "geplant, Anlage kann es (noch) nicht" (units exist but none is
// certified / the kill-switch is off). Gate flags (Units/CertifiedUnits/
// ControlEnabled) come from the CORE - never from a readback stamp; Active/
// AllMatch/PossibleOverride are the latest per-unit readback OBSERVATIONS.
// Additive; the status heartbeat has no frozen schema, schema_version stays
// "1.0". Portal rendering of this block is a documented follow-up.
type CurtailmentSummary struct {
	// Units = curtailment-capable Fronius SunSpec Erzeuger units configured.
	Units int `json:"units"`
	// CertifiedUnits = units with a persisted per-unit First-Light grant.
	CertifiedUnits int  `json:"certified_units"`
	ControlEnabled bool `json:"control_enabled"`
	// Active = at least one unit currently APPLIES a cap (written + confirmed
	// path ran this readback cycle).
	Active bool `json:"active"`
	// AppliedCapKw = the summed per-unit caps currently applied (nil = none).
	AppliedCapKw *float64 `json:"applied_cap_kw,omitempty"`
	// AllMatch over the applying units' readbacks (nil = nothing applied).
	AllMatch *bool `json:"all_match,omitempty"`
	// PossibleOverride: a unit's measured power exceeds its cap after the
	// settle window - a foreign controller may override the Modbus limit.
	PossibleOverride bool   `json:"possible_override,omitempty"`
	CheckedAt        string `json:"checked_at,omitempty"`
}

// PublishStatus sends the lightweight heartbeat on .../status (no frozen
// schema; mirrors the Node-RED edge's shape). Fire-and-forget semantics:
// errors are returned but the caller does not retry status. `control` is the
// optional control confirmation, `entities` the optional v2 entity-registry
// ack, `flows` the optional flow-deployment ack, `sources` the optional
// per-measurement-point Ist, `update` the optional OTA block (nil = omit the
// block - all additive, schema_version stays "1.0").
//
// The top-level `version` is NOT optional in that sense: it rides every
// heartbeat from the link's build stamp (OTA Stufe 0, scout
// vp-ota-rollout-h4 §2.3 hole 1). Before this, the core version travelled
// ONLY inside the `flows` ack block, which the edge does not build until it
// has seen its first flow deployment - so a box without a rolled-out
// automation reported no version at all and the fleet view was blind to it.
func (l *Link) PublishStatus(controlSource string, socPct *float64, control *ControlSummary,
	entities *EntitiesSummary, flows *FlowsSummary, sources *SourcesSummary,
	flowNodes *FlowNodeStatusSummary, curtail *CurtailmentSummary,
	update *UpdateSummary) error {
	payload := map[string]any{
		"schema_version": "1.0",
		"tenant_id":      l.identity.TenantID,
		"site_id":        l.identity.SiteID,
		"device_id":      l.identity.DeviceID,
		"ts":             time.Now().UTC().Format(time.RFC3339Nano),
		"online":         true,
		"control_source": controlSource,
		"soc_pct":        socPct,
	}
	if l.version != "" {
		payload["version"] = l.version
	}
	if update != nil {
		payload["update"] = update
	}
	if control != nil {
		payload["control"] = control
	}
	if curtail != nil {
		payload["curtailment"] = curtail
	}
	if entities != nil {
		payload["entities"] = entities
	}
	if flows != nil {
		payload["flows"] = flows
	}
	if sources != nil && len(sources.Entries) > 0 {
		if len(sources.Entries) > maxSourceEntries {
			sources.Entries = sources.Entries[:maxSourceEntries]
		}
		payload["sources"] = sources
	}
	if flowNodes != nil && len(flowNodes.Nodes) > 0 {
		if len(flowNodes.Nodes) > maxFlowNodeStates {
			flowNodes.Nodes = flowNodes.Nodes[:maxFlowNodeStates]
		}
		payload["flow_node_status"] = flowNodes
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	tok := l.client.Publish(l.topic("status"), 1, false, raw)
	if !tok.WaitTimeout(10 * time.Second) {
		return fmt.Errorf("status publish timed out")
	}
	return tok.Error()
}

// updateStateAckTimeout bounds the durable state publish. It is deliberately
// LONGER than the fire-and-forget status timeout: this call exists to be the
// last thing a device does before it stops itself, so waiting a little longer
// for the broker's ack is exactly the point.
const updateStateAckTimeout = 30 * time.Second

// PublishUpdateState durably reports ONE update-state transition and waits for
// the QoS1 ack before returning.
//
// **GROUNDWORK - nothing calls it in Stufe 0.** It exists now because the
// transition it is built for cannot be retrofitted later without the same
// blind spot it removes: an updater must report `applying` as its LAST act
// BEFORE stopping the stack (scout vp-ota-rollout-h4 §5, Reconcile-Rail D2),
// and only a CONFIRMED publish makes "im Update verstummt" a state of its own
// instead of indistinguishable from "the box is simply gone". The regular
// 15-s heartbeat cannot carry it: the process is about to disappear.
//
// It sends the same status shape minus the live measurement blocks - identity,
// the build version, and the update block - so an ingest that already
// understands the heartbeat understands this too, with no second parser.
func (l *Link) PublishUpdateState(u UpdateSummary) error {
	payload := map[string]any{
		"schema_version": "1.0",
		"tenant_id":      l.identity.TenantID,
		"site_id":        l.identity.SiteID,
		"device_id":      l.identity.DeviceID,
		"ts":             time.Now().UTC().Format(time.RFC3339Nano),
		"online":         true,
		"update":         u,
	}
	if l.version != "" {
		payload["version"] = l.version
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	tok := l.client.Publish(l.topic("status"), 1, false, raw)
	if !tok.WaitTimeout(updateStateAckTimeout) {
		return fmt.Errorf("update state publish timed out")
	}
	return tok.Error()
}

// PublishPurgeRequest asks the cloud to purge THIS device's recorded data
// (contract: docs/contracts/mqtt-data-purge.schema.json). Published on the
// device's own status topic - the broker ACL only permits a device its own
// path, which is exactly the authorization the cloud relies on. requestedAt is
// when the customer triggered the purge on the device.
func (l *Link) PublishPurgeRequest(requestedAt time.Time) error {
	payload := map[string]any{
		"schema_version": "1.0",
		"type":           "purge_request",
		"tenant_id":      l.identity.TenantID,
		"site_id":        l.identity.SiteID,
		"device_id":      l.identity.DeviceID,
		"ts":             requestedAt.UTC().Format(time.RFC3339Nano),
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	tok := l.client.Publish(l.topic("status"), 1, false, raw)
	if !tok.WaitTimeout(10 * time.Second) {
		return fmt.Errorf("purge request publish timed out")
	}
	return tok.Error()
}

// Close disconnects.
func (l *Link) Close() {
	l.client.Disconnect(250)
}
