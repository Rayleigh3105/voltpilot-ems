# Connect an edge device

How a physical edge device on a customer site connects to the VoltPilot broker and starts publishing telemetry.

There are two paths:

- **[Zero-touch onboarding](#zero-touch-onboarding-recommended)** (recommended, v1: plain MQTT/dev): the device knows only its **edge reference** and the broker host; identity arrives over the provisioning handshake once the ref is claimed in the portal. No IDs to copy.
- **[Secure mTLS](#connect-over-mtls-production-hardened-broker)** (production, hardened broker): explicit per-device certificate + IDs, for the internet-facing 8883 listener.

## Zero-touch onboarding (recommended)

The customer flow is exactly two things:

1. **Portal:** *Geräte → ＋ Gerät hinzufügen* - pick the Standort, type the device's **Edge-Referenz** (e.g. `plant-a-inverter-01`), claim. The row shows *"wartet auf erste Daten"*.
   Sticker Geräte-IDs (prefix `VP-`, case-insensitive, uppercased on claim) must first be registered in the provisioned-device registry (admin *Geräte-Registry* page or `POST /api/v1/admin/provisioned-devices`), or the claim is refused; free-form refs like the example stay ungated.
2. **Device:** power it on, configured with only the broker host and its ref.

Under the hood (binding contract [`docs/contracts/mqtt-provisioning.schema.json`](contracts/mqtt-provisioning.schema.json)):

```
device                                 cloud
  │  publish provision/{ref}/hello       │   (QoS1; retried until claimed)
  │  subscribe provision/{ref}/config    │
  │                                      │  ref claimed? -> publish RETAINED
  │  ◄─ provision/{ref}/config ───────── │  {tenant_id, site_id, device_id}
  │  adopt identity, then publish        │
  │  ems/{t}/{s}/{d}/telemetry (frozen   │
  │  telemetry contract, unchanged)      │
```

- **Unclaimed ref:** no answer; the device retries its hello (default every 10 s). Normal pre-onboarding state.
- **Claim-later:** the portal api publishes the retained config the moment the claim succeeds, so an already-waiting device converges instantly.
- **Restart:** the config is retained on the broker - the device re-provisions on subscribe with no cloud round-trip.
- The portal row flips to **online** as soon as the first telemetry arrives.

Try it with the standalone simulator (see [`tools/edge-simulator/README.md`](../tools/edge-simulator/README.md)):

```bash
python3 tools/edge-simulator/voltpilot_edge_sim.py --host mqtt.example.com --ref plant-a-inverter-01 --verbose
```

v1 note: the zero-touch handshake runs over the dev/plain-MQTT listener (1883). The mTLS variant (hello/config over the hardened 8883 listener with a bootstrap cert) is future work - for the hardened production broker, use the explicit mTLS path below.

## Connect over mTLS (production, hardened broker)

The edge makes **only an outbound** MQTT connection (mutual TLS on port 8883).
It exposes **no inbound ports** - this is a hard architecture rule (architecture §6), so the device works behind NAT/CGNAT with no port-forwarding.

```
   customer site                      internet            your server (EU)
 ┌───────────────┐   mqtts:8883   ┌───────────────────────────────────────┐
 │ Node-RED edge │ ─────────────► │ EMQX  mTLS listener 8883               │
 │  (device.crt) │  outbound only │  verify_peer + per-device ACL          │
 └───────────────┘                │  1883 (loopback) → ingest → Redpanda…  │
                                   └───────────────────────────────────────┘
```

## Prerequisites

- The device is **claimed** in the portal (it exists in your tenant with a `device_id`). See [Provisioning](#provisioning-claim--issue-cert) to do both steps in one command.
- You know the topic IDs: `tenant_id`, `site_id`, `device_id` (all UUIDs).
- You have the device's mTLS bundle: `device.crt`, `device.key`, and `device-ca.crt` (the CA that signs the broker's server cert).
- Node-RED 4.x on the device (the VoltPilot edge image already has it).

## 1. Get a device certificate

Certs are issued by the device-CA tool. On the server that holds the CA:

```bash
# One-time: create the device CA + broker server cert for your domain.
./tools/pki/voltpilot-ca.sh init-ca --domain mqtt.example.com --ip 203.0.113.10

# Per device: issue a client cert whose identity encodes tenant/site/device.
./tools/pki/voltpilot-ca.sh issue \
  --tenant 00000000-0000-0000-0000-000000000001 \
  --site   00000000-0000-0000-0000-000000000002 \
  --device 00000000-0000-0000-0000-000000000003
```

This writes the bundle to `tools/pki/out/devices/<device_id>/` and appends an ACL grant to `infra/mqtt/acl.conf` binding that cert to exactly its own topics.
Ship `device.crt`, `device.key` and `device-ca.crt` to the device over a secure channel (the **private key never leaves your control except onto that one device**).

Reload the broker authorization so the new grant takes effect:

```bash
docker compose -f docker-compose.prod.yml exec emqx emqx ctl conf reload
```

## 2. Broker connection params

| Setting | Value |
|---|---|
| Protocol | `mqtts` (MQTT over TLS) |
| Host | `mqtt.example.com` *(your broker's public FQDN)* |
| Port | `8883` |
| TLS | on, **mutual** (present the client cert) |
| CA cert | `device-ca.crt` (verify the broker) |
| Client cert / key | `device.crt` / `device.key` |
| Username / clientid | **do not set** - the broker derives both from the cert CN (`device_id`) |
| QoS | `1` |

The host you dial must be in the broker server cert's SAN: `init-ca --domain mqtt.example.com --ip <ip>` puts both in, so the **MQTT domain (recommended)** and the raw IP both verify.
If the domain was added only after the broker went live, re-running `init-ca` is safe - it keeps the existing CA (all device certs stay valid) and re-issues only the server cert with the new SANs; re-stage `server.crt`/`server.key` and restart EMQX (see [`deploy.md`](deploy.md)).

## 3. Topics (contract)

The device may use **only its own** path. Publishing under any other tenant/site/device is denied by the broker ACL.

```
ems/{tenant_id}/{site_id}/{device_id}/telemetry   # publish  (QoS1)   measurements
ems/{tenant_id}/{site_id}/{device_id}/status      # publish           heartbeat/health
ems/{tenant_id}/{site_id}/{device_id}/schedule    # subscribe (retained) cloud→edge schedule
ems/{tenant_id}/{site_id}/{device_id}/command     # subscribe          ad-hoc command
ems/{tenant_id}/{site_id}/{device_id}/config      # subscribe (retained) config
```

Telemetry payload is the binding contract [`docs/contracts/mqtt-telemetry.schema.json`](contracts/mqtt-telemetry.schema.json) (`schema_version` `"1.0"`).
No payload/mapping change is needed - the existing edge flow already publishes this shape.

## 4. Node-RED MQTT-out config (mTLS)

On the device, configure the `mqtt-broker` config node and a `tls-config` node:

**TLS configuration node**

| Field | Value |
|---|---|
| Certificate | `device.crt` |
| Private Key | `device.key` |
| CA Certificate | `device-ca.crt` |
| Verify server certificate | ✅ on |
| Server name (SNI) | `mqtt.example.com` |

**MQTT broker config node**

| Field | Value |
|---|---|
| Server | `mqtt.example.com` |
| Port | `8883` |
| Enable secure (SSL/TLS) connection | ✅ on → select the TLS config node above |
| Protocol | MQTT V3.1.1 or V5 |
| Client ID | *leave blank* (broker sets it from the cert) |
| Username / Password | *leave blank* |

The equivalent `flows.json` fragment (the edge already publishes telemetry at QoS1 - only the broker/TLS config changes for production):

```json
{
  "id": "cfg-tls-prod", "type": "tls-config",
  "cert": "/data/certs/device.crt",
  "key": "/data/certs/device.key",
  "ca": "/data/certs/device-ca.crt",
  "verifyservercert": true, "servername": "mqtt.example.com"
},
{
  "id": "cfg-mqtt-prod", "type": "mqtt-broker", "name": "VoltPilot (prod mTLS)",
  "broker": "mqtt.example.com", "port": "8883",
  "usetls": true, "tls": "cfg-tls-prod",
  "protocolVersion": "5", "clientid": "", "keepalive": "60", "cleansession": false
}
```

Point the existing `mqtt out` telemetry/status nodes at `cfg-mqtt-prod` (QoS 1) and the `mqtt in` schedule/command/config nodes at the same broker.

## Provisioning (claim + issue cert)

To do the DB claim and the cert in one step, use the helper (it reuses the portal's `POST /api/v1/devices/claim`, then issues the cert bound to the returned `device_id`):

```bash
./tools/pki/provision-device.sh \
  --api-base https://portal.example.com \
  --token "$ACCESS_TOKEN" \
  --site 00000000-0000-0000-0000-000000000002 \
  --external-ref plant-a-inverter-01 \
  --domain mqtt.example.com
```

`tenant_id` is read from the access token's `tenant_id` claim. The script prints the broker URL, exact topics and the cert bundle path.

## Revoke a compromised device

```bash
./tools/pki/voltpilot-ca.sh revoke --device 00000000-0000-0000-0000-000000000003
docker compose -f docker-compose.prod.yml exec emqx emqx ctl conf reload
```

Revoke removes the device's ACL grant (an ungranted device_id is denied every topic by default) **and** adds the cert to the CRL. If you enable CRL checking on the listener, the cert is also rejected at the TLS handshake.

## Verify it works

- Server side: `docker compose -f docker-compose.prod.yml logs -f emqx` and the EMQX dashboard (loopback `:18083`) show the client connecting with clientid = `device_id`.
- Local proof without a live broker (CI-friendly): `python3 tools/pki/verify_mqtt_security.py` runs the mutual-TLS handshake and the ACL policy checks (valid cert connects, no/untrusted cert rejected, cross-tenant denied, revocation). See [`docs/security-mqtt.md`](security-mqtt.md) for the full model and the live-broker test recipe.
