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

	onSchedule        func(payload []byte)
	onCommand         func(payload []byte)
	onEntities        func(payload []byte)
	onPlanV2          func(payload []byte)
	onFlows           func(payload []byte)
	onUpdateTarget    func(payload []byte)
	onApplyRequest    func(payload []byte)
	onProbeRequest    func(payload []byte)
	onRegisterWrite   func(payload []byte)
	onDesiredDownlink func(payload []byte)
	onControlCert     func(payload []byte)
	onConnect         func(connected bool)
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
	// OnControlCert receives the RETAINED platform control-certification
	// document on .../v2/control-certification (contract
	// docs/contracts/mqtt-control-certification.schema.json). An EMPTY payload
	// IS forwarded - it withdraws the document (retained-clear, e.g. on
	// unclaim). nil = the platform register is not wired (pure pre-register
	// behaviour: env allowlist + local First-Light only).
	//
	// It carries the register and the plant's activation; it does NOT authorize
	// a write. The DEVICE decides by comparing the register against its own
	// inverter selection, and every guard binds unchanged afterwards.
	OnControlCert func(payload []byte)
	// OnApplyRequest receives the NON-RETAINED one-shot apply approval on
	// .../v2/apply (docs/contracts/mqtt-ota-apply.schema.json, „Portal-Apply").
	// nil = the portal-apply downlink is not wired.
	//
	// ⚠ NON-retained is the load-bearing half of this feature: a retained
	// message is redelivered on EVERY reconnect, so a one-shot approval placed
	// there would not be one - it would re-apply for as long as it sat on the
	// broker. An offline box therefore never gets a missed approval delivered
	// late, and that is intended: a consent from three hours ago is not a
	// consent for now.
	OnApplyRequest func(payload []byte)
	// OnProbeRequest receives the NON-RETAINED one-shot probe on .../v2/probe
	// (docs/contracts/mqtt-probe.schema.json, Einheitsmodell Stufe 0b). nil =
	// the probe channel is not wired.
	//
	// ⚠ NON-retained for the same reason as the apply approval, and with the
	// same second half: the box adopts the envelope's own `requested_at` as the
	// start of its expiry window instead of the arrival time, so a QoS1 message
	// the broker redelivers after an outage is already expired when it lands.
	// Without that, a probe from an hour ago would knock on a customer's device
	// long after the portal route that asked for it gave up waiting.
	OnProbeRequest func(payload []byte)
	// OnRegisterWrite receives the NON-RETAINED one-shot register order on
	// .../v2/register-write (docs/contracts/mqtt-register-write.schema.json,
	// „Register schreiben ueber das Portal"). nil = the portal trigger is not
	// wired.
	//
	// ⚠ NON-retained for the same reason as the apply approval and the probe -
	// and here it weighs MORE: a retained write order would be redelivered on
	// EVERY reconnect, i.e. one EEPROM write cycle per reconnect on a
	// customer's inverter. The second half is the same too: the box adopts the
	// envelope's own `requested_at` as the start of its window, so a QoS1
	// message the broker redelivers after an outage is already expired when it
	// lands - and the third is the request_id the box remembers as executed.
	OnRegisterWrite func(payload []byte)
	// OnDesiredDownlink receives the NON-RETAINED manual override envelope on
	// .../v2/desired (Verbrauchssteuerung §11/§14.13). nil = not wired. It
	// carries either a full edge-desired envelope (forwarded to the local bus
	// where the arbiter clamps + enforces the bounded TTL) or a
	// {entity_id, withdraw:true} to end the intervention ("Automatik
	// fortsetzen"). NON-retained like the apply approval: a manual wish must
	// never be revived as an immortal retained desire (§16).
	OnDesiredDownlink func(payload []byte)
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
		onFlows: o.OnFlows, onUpdateTarget: o.OnUpdateTarget,
		onControlCert:  o.OnControlCert,
		onApplyRequest: o.OnApplyRequest, onProbeRequest: o.OnProbeRequest,
		onRegisterWrite:   o.OnRegisterWrite,
		onDesiredDownlink: o.OnDesiredDownlink,
		onConnect:         o.OnConnect}

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
		// The retained platform control-certification document, in the same
		// v2/# subtree the per-device ACL already covers (D-2) - no broker
		// change. Retained is the whole mechanism again: a box that was offline
		// when an operator armed it picks the document up on reconnect. An empty
		// payload IS forwarded - it withdraws the document.
		if l.onControlCert != nil {
			certTopic := l.topic("v2/control-certification")
			if tok := c.Subscribe(certTopic, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
				l.onControlCert(msg.Payload())
			}); tok.Wait() && tok.Error() != nil {
				slog.Error("v2 control-certification subscribe failed", "topic", certTopic, "err", tok.Error())
			}
		}
		// Die NICHT-retained Einmal-Freigabe (Portal-Apply). Sie liegt
		// ausdruecklich NICHT auf dem retained Zuweisungs-Slot: retained
		// wuerde bei jedem Reconnect erneut zugestellt, und eine
		// Einmal-Freigabe darf nie replayt werden.
		if l.onApplyRequest != nil {
			applyTopic := l.topic("v2/apply")
			if tok := c.Subscribe(applyTopic, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
				l.onApplyRequest(msg.Payload())
			}); tok.Wait() && tok.Error() != nil {
				slog.Error("v2 apply subscribe failed", "topic", applyTopic, "err", tok.Error())
			}
		}
		// Die NICHT-retained Einmal-Anfrage des Probe-Kanals. Aus demselben
		// Grund wie die Freigabe nicht retained: eine Vorschau, die bei jedem
		// Reconnect erneut zugestellt wird, klopft beliebig oft an einem
		// Kundengeraet an.
		if l.onProbeRequest != nil {
			probeTopic := l.topic("v2/probe")
			if tok := c.Subscribe(probeTopic, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
				if len(msg.Payload()) > 0 {
					l.onProbeRequest(msg.Payload())
				}
			}); tok.Wait() && tok.Error() != nil {
				slog.Error("v2 probe subscribe failed", "topic", probeTopic, "err", tok.Error())
			}
		}
		// Der NICHT-retained Einmal-Schreibauftrag aus dem Portal. Aus
		// demselben Grund nicht retained wie Freigabe und Vorschau - und hier
		// waere ein Replay teurer als anderswo: jeder Reconnect kostete einen
		// EEPROM-Schreibzyklus auf einem Kundengeraet.
		if l.onRegisterWrite != nil {
			regTopic := l.topic("v2/register-write")
			if tok := c.Subscribe(regTopic, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
				if len(msg.Payload()) > 0 {
					l.onRegisterWrite(msg.Payload())
				}
			}); tok.Wait() && tok.Error() != nil {
				slog.Error("v2 register-write subscribe failed", "topic", regTopic, "err", tok.Error())
			}
		}
		// The NON-RETAINED manual override envelope (Verbrauchssteuerung §11).
		// Not retained on purpose: a manual wish is never revived as an immortal
		// desire (§16); an offline box simply misses a stale intervention.
		if l.onDesiredDownlink != nil {
			desiredTopic := l.topic("v2/desired")
			if tok := c.Subscribe(desiredTopic, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
				if len(msg.Payload()) > 0 {
					l.onDesiredDownlink(msg.Payload())
				}
			}); tok.Wait() && tok.Error() != nil {
				slog.Error("v2 desired subscribe failed", "topic", desiredTopic, "err", tok.Error())
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
	// ComponentApply is the Einheitsmodell-Stufe-1 Ist of the ONE applier:
	// WHO owns this plant's device configuration and which push revision the
	// box really derived its local files from. ADDITIVE and only sent once a
	// portal-managed push was seen, so a box-managed plant's heartbeat is
	// byte-identical to before.
	ComponentApply *ComponentApplySummary `json:"component_apply,omitempty"`
}

// ComponentApplySummary is the applier's honest Ist (Einheitsmodell Stufe 1).
//
// The two revisions are deliberately SEPARATE fields: `revision` is what the
// box really runs, `refused_revision` is what it could not apply. Collapsing
// them would force the portal to choose between claiming a refused Soll is live
// and losing the reason - and the whole point of a refusal is that it stays
// visible while the last working configuration keeps running.
type ComponentApplySummary struct {
	// Authority: "portal" = derived from the cloud push | "box" = local.
	Authority string `json:"authority"`
	// Revision that was successfully APPLIED (empty = none yet).
	Revision  string `json:"revision,omitempty"`
	AppliedAt string `json:"applied_at,omitempty"`
	// RefusedRevision/RefusedReason carry the LAST refusal in plain German.
	// Absent = nothing was refused.
	RefusedRevision string `json:"refused_revision,omitempty"`
	RefusedReason   string `json:"refused_reason,omitempty"`
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
//
// Einheitsmodell Stufe 2 completed it: until then it named WHAT a device is
// (role/brand/model/label) but never HOW it is reached, so the cloud could show
// the box's commissioning Ist but could not take it over as its own Soll - a
// takeover derived from an incomplete Ist would have had to GUESS the address of
// a live plant's read path. The fields below are the missing half, and they are
// exactly the ones sources.Source / inverter.Selection persist, so the Soll the
// cloud writes back re-derives byte-identically to what already runs.
//
// ADDITIVE in both directions: an older cloud ignores the new fields, and an
// older box simply omits them - which the cloud must read as "takeover not
// possible yet", never as "this device has no connection".
type LocalSetupEntry struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"` // inverter | source
	Role  string `json:"role,omitempty"`
	Brand string `json:"brand,omitempty"`
	Model string `json:"model,omitempty"`
	Label string `json:"label,omitempty"`

	// Family is the register-map key the Layer-1 self-wiring routes on. It is
	// reported even though it is derivable from brand+model, because the box's
	// OWN catalog decided it - and that decision is what the cloud must mirror.
	Family string `json:"family,omitempty"`
	// Communication is the transport (solarman_v5 / modbus_tcp / ...). Part of
	// the source identity (sources.DeterministicID), so it must travel.
	Communication string `json:"communication,omitempty"`
	// Connection carries the transport fields VERBATIM as the box persists them
	// (an inverter.Connection object). It stays json.RawMessage on purpose - the
	// entities.Entity.Driver precedent: the field list lives in exactly ONE place
	// (inverter.Connection), so a transport field added there rides along without
	// a second mapping table to forget, and the bytes are not reshaped on the way.
	Connection json.RawMessage `json:"connection,omitempty"`
	// IntervalS / CapacityKwp / RegistryUnitID are the source's master data.
	// They are NOT part of the transport identity, but they ARE part of what the
	// box runs: the interval is the poll cadence, the kWp widens the physical
	// plausibility envelope, and the registry unit id is the operator's MaStR
	// reference. Losing one of them in a takeover would be a silent downgrade.
	IntervalS      int     `json:"interval_s,omitempty"`
	CapacityKwp    float64 `json:"capacity_kwp,omitempty"`
	RegistryUnitID string  `json:"registry_unit_id,omitempty"`
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

// ChargersSummary is the additive status-heartbeat block reporting the site's
// OCPP charge points and the load-management budget they share (Stufe 3 of the
// Lastmanagement concept, `vp-ocpp-lastmgmt-konzept-w4` §5.3). It is the EIGHTH
// sibling block on the status topic and, like every one before it, pure added
// VISIBILITY: the cloud sees what the box decided, it never decides.
//
// ⚠ The block is the box's OWN view, verbatim. Budget, allocation, the safe
// default and every German sentence are written ONCE, in internal/lastmgmt, and
// only repeated here - the :8484 card and the portal must never word the same
// verdict differently, and only the box knows the numbers behind it.
//
// A box with no charge points sends NO block at all, so a plant without a
// charging station keeps a byte-identical heartbeat. Bounded by
// maxChargerEntries / maxChargerConnectors so a misconfigured plant can never
// inflate the heartbeat.
type ChargersSummary struct {
	// ReportedAt is when the edge assembled this view (RFC 3339).
	ReportedAt string `json:"reported_at"`

	// --- the site half: the budget every station shares ---

	// Enabled mirrors VP_OCPP_ENABLED (the server), ControlEnabled whether the
	// LIVE allocation may be written at all. They are DIFFERENT gates: without
	// the second the plant runs on n x safe default, which is safe but not
	// optimised - and ControlNote says so, because a refusal nobody can see is
	// a riddle.
	Enabled        bool   `json:"enabled"`
	ControlEnabled bool   `json:"control_enabled"`
	ControlNote    string `json:"control_note,omitempty"`

	// GridLimitKw is the maintained Anschlussgrenze, MarginPct the safety
	// margin taken FROM it, MinPowerKw the allocation floor below which nothing
	// is granted (pausing beats starving).
	GridLimitKw float64 `json:"grid_limit_kw"`
	MarginPct   float64 `json:"margin_pct"`
	MinPowerKw  float64 `json:"min_power_kw"`
	// BudgetKw is what may be handed to vehicles right now, AllocatedKw what
	// the current plan granted, ReservedKw what is held back for stations the
	// box cannot reach (they hold their own default and their cars may take
	// it - "blind never means unlimited", the import twin of the export guard).
	BudgetKw    float64 `json:"budget_kw"`
	AllocatedKw float64 `json:"allocated_kw"`
	ReservedKw  float64 `json:"reserved_kw,omitempty"`
	// MeasuredKw is what the stations REPORT drawing. nil = not one connector
	// reported a measurement - never a fabricated 0.
	MeasuredKw *float64 `json:"measured_kw,omitempty"`
	// SiteLoadKw / SiteGridKw are the rest of the site and the newest measured
	// grid power the budget was formed from (Stufe 2). Both nil while the
	// budget is static or blind - never a fabricated measurement.
	SiteLoadKw *float64 `json:"site_load_kw,omitempty"`
	SiteGridKw *float64 `json:"site_grid_kw,omitempty"`
	// BudgetMode is the machine-readable stage (statisch | gemessen | haelt |
	// zieht_zusammen | sicherheitsbudget) and BudgetNote its German sentence.
	// BudgetBlind is true whenever the budget was NOT formed from a fresh
	// measurement.
	BudgetMode  string `json:"budget_mode,omitempty"`
	BudgetNote  string `json:"budget_note,omitempty"`
	BudgetBlind bool   `json:"budget_blind,omitempty"`
	// EffLimitKw is the connection limit actually in force (the maintained one
	// or the observed §14a envelope, whichever is tighter).
	EffLimitKw float64 `json:"eff_limit_kw,omitempty"`

	// SafeDefaultKw is the per-connector emergency limit currently installed in
	// the stations, with the terms it was derived from so a surface can show
	// the customer the sum instead of a bare number.
	SafeDefaultKw   float64 `json:"safe_default_kw"`
	SafeDefaultNote string  `json:"safe_default_note,omitempty"`
	// SafeDefaultHolds is the invariant itself: connectors x default + the
	// worst building load ever measured stays under the connection limit. A
	// false here is a SITE fact no charging default can repair, and it must
	// reach the cloud - saying "holds" would be a comfortable lie about a
	// customer's fuse.
	SafeDefaultHolds bool    `json:"safe_default_holds"`
	SafeWorstCaseKw  float64 `json:"safe_worst_case_kw,omitempty"`
	MaxHouseLoadKw   float64 `json:"max_house_load_kw,omitempty"`
	ConnectorCount   int     `json:"connector_count"`

	// Chargers are the registered charge points, id-sorted. Never nil when the
	// block is present.
	Chargers []ChargerEntry `json:"chargers"`
}

// maxChargerEntries / maxChargerConnectors bound the block. A charging park of
// this size is far beyond anything one box manages; the caps exist so a
// misconfigured allowlist cannot inflate every heartbeat.
const (
	maxChargerEntries    = 16
	maxChargerConnectors = 8
)

// ChargerEntry is one charge point. Vendor / Model / Firmware are the station's
// OWN words, recorded and DISPLAYED only - the herstellerneutral rule (concept
// §0, VERBINDLICH): no mechanism anywhere branches on them.
type ChargerEntry struct {
	ID        string `json:"id"`
	Label     string `json:"label,omitempty"`
	Priority  bool   `json:"priority,omitempty"`
	Connected bool   `json:"connected"`
	Vendor    string `json:"vendor,omitempty"`
	Model     string `json:"model,omitempty"`
	Firmware  string `json:"firmware,omitempty"`
	// Ready is true once the two PERMANENT profiles (station cap + safe
	// default) are installed; Note names the reason when they are not - never
	// an unexplained "not ready".
	Ready bool   `json:"ready"`
	Note  string `json:"note,omitempty"`
	// LastSeen is the newest message of ANY kind from this station (RFC 3339);
	// empty = it has never spoken to this box.
	LastSeen   string                  `json:"last_seen,omitempty"`
	Connectors []ChargerConnectorEntry `json:"connectors,omitempty"`
}

// ChargerConnectorEntry is one plug: one vehicle, one claimant on the budget.
type ChargerConnectorEntry struct {
	ID     int    `json:"id"`
	Status string `json:"status,omitempty"`
	// Charging reports whether this plug claims budget right now.
	Charging bool `json:"charging"`
	// AllocatedKw is what the load management granted (0 while paused);
	// nil = this plug is not part of the current decision at all.
	AllocatedKw *float64 `json:"allocated_kw,omitempty"`
	// Reason is the allocator's machine word and ReasonText its German
	// sentence - both from internal/lastmgmt, never re-worded here.
	Reason     string `json:"reason,omitempty"`
	ReasonText string `json:"reason_text,omitempty"`
	// NextTurn is when a waiting plug is estimated to get its turn (RFC 3339);
	// empty = not computable, and then the surface must say nothing.
	NextTurn string `json:"next_turn,omitempty"`
	// PowerKw / EnergyKwh / SocPct are what the station MEASURED. Absent =
	// not reported, never a fabricated 0.
	PowerKw   *float64 `json:"power_kw,omitempty"`
	EnergyKwh *float64 `json:"energy_kwh,omitempty"`
	SocPct    *float64 `json:"soc_pct,omitempty"`
	// CommandStatus is the station's own answer to the last limit, Readback the
	// GetCompositeSchedule verdict (ok | abweichend | unbekannt): an accepted
	// command is not a command in force (the PR-280 lesson on OCPP).
	CommandStatus string `json:"command_status,omitempty"`
	Readback      string `json:"readback,omitempty"`
	ReadbackNote  string `json:"readback_note,omitempty"`
	// SessionSince is when the running transaction started (RFC 3339); empty =
	// no session on this plug.
	SessionSince string `json:"session_since,omitempty"`
}

// ConsumersSummary is the additive status-heartbeat block reporting the edge
// runtime state of every CONTROLLABLE consumer entity (Verbrauchssteuerung
// Inkrement 3, D9/§15.1): per entity {state, reason_code, actual_kw,
// confirmed, requirement_progress}. Keys are entity ids. A device without
// consumer entities sends NO block (the heartbeat stays byte-identical); the
// cloud ingests it with its OWN sibling listener and discards unknown state/
// reason words instead of storing them.
// RegisterWritesSummary is the additive `register_writes` heartbeat block: the
// box's OWN audit of one-shot installer-register writes, reported so the cloud
// journal shows a write that was made AT THE DEVICE too (Konzept
// vp-reg-schreib-konzept-p8, Captain-Entscheid D6).
//
// ⚠ It closes the "two truths about one operation" gap the concept names (§2.9
// point 7): the box's book and the cloud's book are correlated by `request_id`,
// and without this uplink a local write existed in ONE of them only - the
// Befehle-Seite would have had to say "Vor-Ort-Schreibvorgaenge erscheinen hier
// nicht". The cloud dedupes on (request_id, event), so re-reporting the same
// entry in every heartbeat is a no-op, and a PORTAL-triggered write - which the
// cloud already recorded - simply matches what is there.
//
// Bounded and short-lived on purpose: only the newest few entries of the last
// day travel, so a normal heartbeat carries NO block at all (an installer write
// is a rare, deliberate act).
type RegisterWritesSummary struct {
	// ReportedAt is when the edge assembled this view (RFC 3339).
	ReportedAt string `json:"reported_at"`
	// Entries are the newest first. Never nil when the block is present.
	Entries []RegisterWriteEntry `json:"entries"`
}

// RegisterWriteEntry is ONE audited write. Before/After are POINTERS: "not
// read" and "read as 0" are different facts, and 0 is a legitimate value of a
// feed-in limit ("may not feed in at all").
type RegisterWriteEntry struct {
	RequestID string `json:"request_id"`
	At        string `json:"at"`
	// Register is the operator-facing spelling the box recorded ("0x00e7") -
	// verbatim, so the cloud journal shows what the device's own book shows.
	Register  string `json:"register"`
	Before    *int   `json:"before,omitempty"`
	Requested int    `json:"requested"`
	After     *int   `json:"after,omitempty"`
	// Result is the box's own outcome word (dry_run|applied|mismatch|failed|
	// precondition); Message carries its German sentence.
	Result  string `json:"result"`
	Message string `json:"message,omitempty"`
	// Source names WHICH trigger asked - the local maintenance access or the
	// portal. The cloud maps it onto its own two-value vocabulary.
	Source string `json:"source"`
}

type ConsumersSummary map[string]ConsumerRuntime

// ConsumerRuntime is one consumer entity's edge runtime state.
type ConsumerRuntime struct {
	// State is from the §14.13 vocabulary. The edge only ever claims what it
	// can know: running_forced | running_optimized | clamped | waiting |
	// offline (device had telemetry, went silent).
	State string `json:"state"`
	// ReasonCode is from the §15 vocabulary incl. the cycle-guard extension
	// (guard_min_on | guard_min_off | guard_max_starts | guard_ramp |
	// guard_rated_power | readback_mismatch | device_offline | plan_stale)
	// and the Inkrement-6 deadline fallback (flex_deadline_fallback: the
	// device started the flexible task itself so the deadline holds).
	// Empty = no notable reason.
	ReasonCode string `json:"reason_code,omitempty"`
	// ActualKw is the entity's own MEASURED power (fresh local telemetry);
	// absent when the device never/staleley reports - never a fabricated 0.
	ActualKw *float64 `json:"actual_kw,omitempty"`
	// Confirmed is the latest readback verdict (nil = no readback evidence -
	// "Ausführung nicht bestätigt" territory, never claimed).
	Confirmed *bool `json:"confirmed,omitempty"`
	// RequirementProgress is the edge view of the running day (measured
	// commanded runtime + starts; the cloud-side fulfilment ledger keys on
	// telemetry, this is the device's own honest counter).
	RequirementProgress *ConsumerRequirementProgress `json:"requirement_progress,omitempty"`
}

// ConsumerRequirementProgress carries the edge's per-day counters.
type ConsumerRequirementProgress struct {
	RuntimeSecondsToday int `json:"runtime_seconds_today"`
	StartsToday         int `json:"starts_today"`
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
	// Blocker is the MACHINE-READABLE name of a STANDING block
	// (`otaapply.Blocker*`: neutralzeit, platte, interlock, kern_still, …),
	// additive since the admin-UX rework.
	//
	// PR #331 deliberately kept it on the device („kein Schema, kein DTO") and
	// let the German Reason carry the whole statement. That was the right call
	// for a log line and the wrong one for a fleet: cloud-side a T-guard halt
	// was indistinguishable from „the assignment is on its way" and landed in
	// the BUSY tone „ausstehend" - a standing block looked like progress.
	//
	// It travels NEXT TO Reason for the same reason TargetVerdict travels next
	// to State: so no surface has to grep a German sentence for keywords. The
	// sentence stays the statement; this is the LEVER's name.
	//
	// ABSENT means „no standing block reported" - it is emitted only while the
	// sidecar really blocks, so an older cloud simply ignores an extra field
	// and this box behaves exactly as before.
	Blocker string `json:"blocker,omitempty"`
	// Trust is the device's VERTRAUENS-IDENTITAET (OTA Stufe 4 „Politur"):
	// against which baked root does this build check, and which release keys
	// does it currently accept? nil = an older edge that does not report it.
	//
	// It is what finally makes the TOFU crossover and a key rotation
	// OBSERVABLE fleet-wide instead of a hand-kept list: „does this box carry
	// a key-bearing image at all" is `root_key_ids` non-empty, and „has this
	// box seen the new trust set yet" is `trust_set_generated_at`/
	// `trust_set_key_ids`.
	//
	// ABSENT and EMPTY mean different things on purpose - see TrustSummary.
	Trust *TrustSummary `json:"trust,omitempty"`
	// CanApply says whether a Portal-Apply approval would actually be picked up
	// RIGHT NOW - i.e. an assignment is verified AND a Stufe-3 sidecar is
	// running here (the `:8484` card's own gate, `otaapply.ApplyView.CanApply`).
	//
	// It exists because the portal must not offer a button that cannot work.
	// The honest alternative - offering it always and letting the device refuse
	// silently - is exactly the „ein Rätsel statt einer Verweigerung" failure
	// the blocker field was added to end.
	//
	// It is a CAPABILITY, never an authorization: a `true` grants nothing, and
	// a device that never reports it is simply „unbekannt" cloud-side, never
	// „geht nicht". That THIRD state is why the field is emitted
	// UNCONDITIONALLY (no omitempty): a build that knows the question always
	// answers it, so „absent" can only ever mean „an older build", never „no".
	CanApply bool `json:"can_apply"`
	// NeutralVerified is the device-MEASURED Inverter-Neutral-Zeit T for the
	// CURRENTLY selected inverter family (docs/ota-autonomie.md §3), produced
	// by the guided :8484 First-Light Neutral-Zeit-Test - the belegte
	// Ergaenzung zum Betreiber-Eintrag VP_OTA_NEUTRAL_VERIFIED. nil = never
	// measured on this device (or no inverter selected).
	//
	// It is a FACT about the device, never an authorization: whether it
	// actually opens the autonomous-apply gate is decided entirely on-device
	// by otaapply.NeutralTable.ForWithMeasured, where the operator's env
	// entry ALWAYS wins when present. An older device simply never sends this
	// field.
	NeutralVerified *NeutralVerifiedSummary `json:"neutral_verified,omitempty"`
}

// NeutralVerifiedSummary is one geraete-lokal gemessener Neutral-Zeit-Nachweis
// (the otaapply.NeutralRecord counterpart carried in the heartbeat).
type NeutralVerifiedSummary struct {
	Family     string `json:"family"`
	Seconds    int    `json:"seconds"`
	MeasuredAt string `json:"measured_at,omitempty"`
}

// TrustSummary is the reported trust identity (OTA Stufe 4).
//
// **The absent/empty distinction is the whole point.** A device that does not
// send the block at all is an OLDER build: the cloud says „unbekannt" and never
// „veraltet". A device that sends the block with an EMPTY `root_key_ids` is a
// build that carries the verifier but no anchor - the documented PRE-CEREMONY /
// pre-crossover state, which is honest information, not an error.
//
// The keys are reported only after the trust set VERIFIED against the baked
// root (otaverify.InspectTrust). Reporting an unverified set would let anyone
// who can write /data tell the fleet a key set no device would ever accept.
type TrustSummary struct {
	// RootKeyIDs are the key_ids of this image's BAKED root, sorted. An empty
	// (but present) array = key-less image, i.e. the crossover is still open.
	RootKeyIDs []string `json:"root_key_ids"`
	// TrustSetKeyIDs are the key_ids of the verified trust set, sorted.
	TrustSetKeyIDs []string `json:"trust_set_key_ids,omitempty"`
	// TrustSetGeneratedAt is that set's `generated_at` - the stamp a rotation
	// drill compares across the fleet.
	TrustSetGeneratedAt string `json:"trust_set_generated_at,omitempty"`
	// TrustSetSignedBy is the root key_id that actually signed it.
	TrustSetSignedBy string `json:"trust_set_signed_by,omitempty"`
	// TrustSetError is the German reason why no valid trust set is present.
	// „none placed" and „present but not ours" trigger different actions - the
	// first is an open crossover, the second an incident.
	TrustSetError string `json:"trust_set_error,omitempty"`
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
	// CertSource names WHICH of the three certification sources granted control:
	// "env" (the fleet-wide allowlist), "device" (this box's First-Light grant)
	// or "platform" (the cloud model register). Empty = not certified, or an
	// older core that does not report it - so the cloud must never read an
	// absent value as a claim about the source.
	CertSource string `json:"cert_source,omitempty"`
	// PlatformCert is what the PLATFORM register says about the selected model.
	// Absent = this box has no cloud document at all, which reads "unknown" and
	// NEVER "not certified": those are different sentences, and only this field
	// lets the portal tell "a bench run is needed" from "one click is needed".
	PlatformCert *PlatformCertSummary `json:"platform_cert,omitempty"`
}

// PlatformCertSummary is the additive `platform_cert` block: the device's own
// verdict on the cloud register, reported so the portal can name the state
// instead of guessing it. Like every gate-adjacent flag it comes from the CORE,
// never from a Layer-1 readback stamp.
type PlatformCertSummary struct {
	// Verdict: "granted" | "covered_not_activated" | "not_covered" | "unknown".
	Verdict string `json:"verdict"`
	// Model is the register entry that matched, when one did.
	Model string `json:"model,omitempty"`
	// Reason is the plain-German cause where a covered-looking model still gets
	// nothing (today: a contradicted write-sign convention).
	Reason string `json:"reason,omitempty"`
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
	// ExportGuard is the ADDITIVE live feed-in watchdog block (dynamische
	// Einspeisebegrenzung, 2026-08-06), present only when the site HAS a feed-in
	// limit configured. It rides inside `curtailment` because the watchdog IS the
	// curtailment path's live driver - same actors, same gates, one freshness
	// anchor. An older cloud ignores it (the api reads the heartbeat as a
	// JsonNode), so this is safe to add without any cloud change.
	ExportGuard *ExportGuardSummary `json:"export_guard,omitempty"`

	// DeviceExportLimitKw is the feed-in limit the INVERTER ITSELF holds, read
	// from its own register at most once a day („Grenzen & Wächter" Stufe 0,
	// Vierer #4). At Anlage Herzogau the Deye held an installer cap of 33,0 kW
	// while 70 kW were configured in the portal, and nobody could see it.
	//
	// It rides HERE next to ExportGuard on purpose: the two are the two limits
	// at the same grid connection point, and a DISCREPANCY statement needs BOTH
	// halves - co-locating them means they arrive together or not at all, under
	// one block. Its FRESHNESS is separate though (see DeviceExportLimitReadAt):
	// CheckedAt is the curtailment units' readback stamp and would claim a
	// recency this once-a-day register does not have.
	//
	// KNOWN BOUNDARY, inherited from the block: a plant with NO
	// curtailment-capable unit sends no `curtailment` block at all, so it
	// reports no device limit either. Absent therefore means "not reported",
	// never "the device has no limit".
	DeviceExportLimitKw *float64 `json:"device_export_limit_kw,omitempty"`
	// DeviceExportLimitRegister is WHERE the value came from ("0x00e7") - a
	// number without its origin is not evidence.
	DeviceExportLimitRegister string `json:"device_export_limit_register,omitempty"`
	// DeviceExportLimitReadAt is its OWN freshness anchor (RFC3339).
	DeviceExportLimitReadAt string `json:"device_export_limit_read_at,omitempty"`
}

// ExportGuardSummary is the heartbeat half of the dynamic feed-in limitation.
// It carries the MACHINE-READABLE state next to the German sentence (the
// target_verdict-beside-state pattern): no surface ever has to parse a sentence,
// and the sentence is written ONCE (guards.ExportLimiter) so the device page and
// the portal can never word the same verdict differently.
type ExportGuardSummary struct {
	// LimitKw is the configured feed-in limit at the connection point.
	LimitKw float64 `json:"limit_kw"`
	// State: ueberwacht | regelt | haelt | zieht_zusammen | sicherheitskappe.
	State string `json:"state"`
	// Reason is the German sentence for exactly that state.
	Reason string `json:"reason"`
	// CapKw is the plant-level PV cap the watchdog currently commands.
	CapKw *float64 `json:"cap_kw,omitempty"`
	// Limiting: the cap is actually holding the producers back right now.
	Limiting bool `json:"limiting,omitempty"`
	// Blind: the verdict was NOT formed from a fresh connection-point
	// measurement (hold / contract / safe cap).
	Blind bool `json:"blind,omitempty"`
	// Effective is false when the cap cannot reach ANY device. Reach names the
	// gap in German whenever the reach is not complete. This is the field that
	// keeps a plant from believing in a protection it does not have.
	Effective bool   `json:"effective"`
	Reach     string `json:"reach,omitempty"`
}

// PublishStatus sends the lightweight heartbeat on .../status (no frozen
// schema; mirrors the Node-RED edge's shape). Fire-and-forget semantics:
// errors are returned but the caller does not retry status. `control` is the
// optional control confirmation, `entities` the optional v2 entity-registry
// ack, `flows` the optional flow-deployment ack, `sources` the optional
// per-measurement-point Ist, `update` the optional OTA block, `chargers` the
// optional OCPP charge-point + load-management block (nil = omit the block -
// all additive, schema_version stays "1.0").
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
	update *UpdateSummary, consumers ConsumersSummary,
	registerWrites *RegisterWritesSummary, chargers *ChargersSummary) error {
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
	if len(consumers) > 0 {
		payload["consumers"] = consumers
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
	if registerWrites != nil && len(registerWrites.Entries) > 0 {
		payload["register_writes"] = registerWrites
	}
	if chargers != nil && len(chargers.Chargers) > 0 {
		if len(chargers.Chargers) > maxChargerEntries {
			chargers.Chargers = chargers.Chargers[:maxChargerEntries]
		}
		payload["chargers"] = chargers
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

// PublishProbeResult answers ONE probe on .../v2/probe-result - NON-retained,
// QoS1 (contract docs/contracts/mqtt-probe.schema.json).
//
// Non-retained is the point on this side too: the answer belongs to the one
// question that is being waited on right now. A retained answer would be
// redelivered to every later subscriber and would outlive the portal request
// that could still make sense of it; the correlation id is held only in the
// cloud's memory for a few seconds.
//
// The caller has already built the contract envelope (internal/probe), so this
// only puts the bytes on the wire and waits for the QoS1 ack - an answer nobody
// received is worth knowing about, because the portal route is blocked on it.
func (l *Link) PublishProbeResult(payload []byte) error {
	tok := l.client.Publish(l.topic("v2/probe-result"), 1, false, payload)
	if !tok.WaitTimeout(10 * time.Second) {
		return fmt.Errorf("probe result publish timed out")
	}
	return tok.Error()
}

// PublishRegisterWriteResult answers ONE register order on
// .../v2/register-write-result - NON-retained, QoS1 (contract
// docs/contracts/mqtt-register-write.schema.json).
//
// Non-retained on this side too: the answer belongs to the ONE order being
// waited on right now. A retained receipt would be redelivered to every later
// subscriber and would outlive the portal request that could still make sense
// of it - and the durable record of what happened is the cloud JOURNAL, not a
// message sitting on a broker.
//
// The caller has already built the contract envelope (internal/registerwrite),
// so this only puts the bytes on the wire and waits for the QoS1 ack.
func (l *Link) PublishRegisterWriteResult(payload []byte) error {
	tok := l.client.Publish(l.topic("v2/register-write-result"), 1, false, payload)
	if !tok.WaitTimeout(10 * time.Second) {
		return fmt.Errorf("register write result publish timed out")
	}
	return tok.Error()
}

// Close disconnects.
func (l *Link) Close() {
	l.client.Disconnect(250)
}
