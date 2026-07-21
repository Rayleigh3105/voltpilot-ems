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

	onSchedule func(payload []byte)
	onCommand  func(payload []byte)
	onEntities func(payload []byte)
	onPlanV2   func(payload []byte)
	onFlows    func(payload []byte)
	onConnect  func(connected bool)
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
	// OnConnect is called with the connection state on every transition.
	OnConnect func(connected bool)
	// ClientID override for dev; production leaves it to the broker (CN).
	DevClientID string
}

func (o Options) brokerURL() string {
	if o.DevURL != "" {
		return o.DevURL
	}
	return fmt.Sprintf("ssl://%s:%d", o.Identity.MqttHost, o.Identity.MqttPort)
}

// New builds (but does not connect) the link.
func New(o Options) (*Link, error) {
	l := &Link{identity: o.Identity, onSchedule: o.OnSchedule, onCommand: o.OnCommand,
		onEntities: o.OnEntities, onPlanV2: o.OnPlanV2, onFlows: o.OnFlows,
		onConnect: o.OnConnect}

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
}

// PublishStatus sends the lightweight heartbeat on .../status (no frozen
// schema; mirrors the Node-RED edge's shape). Fire-and-forget semantics:
// errors are returned but the caller does not retry status. `control` is the
// optional control confirmation, `entities` the optional v2 entity-registry
// ack, `flows` the optional flow-deployment ack, `sources` the optional
// per-measurement-point Ist (nil = omit the block - all additive,
// schema_version stays "1.0").
func (l *Link) PublishStatus(controlSource string, socPct *float64, control *ControlSummary,
	entities *EntitiesSummary, flows *FlowsSummary, sources *SourcesSummary) error {
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
	if control != nil {
		payload["control"] = control
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
