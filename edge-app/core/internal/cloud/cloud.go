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

// PublishStatus sends the lightweight heartbeat on .../status (no frozen
// schema; mirrors the Node-RED edge's shape). Fire-and-forget semantics:
// errors are returned but the caller does not retry status.
func (l *Link) PublishStatus(controlSource string, socPct *float64) error {
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
