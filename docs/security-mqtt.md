# MQTT broker security model (mTLS + per-device ACL)

How VoltPilot lets a real remote edge device connect securely to the self-hosted broker, and how to run/harden it. Companion to the device-facing [connect-a-device.md](connect-a-device.md).

## Listeners

| Port | Listener | TLS | Auth | Exposure | Purpose |
|---|---|---|---|---|---|
| `1883` | `tcp/default` | none | anonymous | **loopback + firewalled** (prod) / host (dev) | internal ingest consumer + local dev only |
| `8883` | `ssl/default` | **mTLS** | client x.509 cert | **public** | real remote devices |

The plaintext dev listener (1883) is **kept intact** so the local stack and the internal ingest→Redpanda path work unchanged.
The secure overlay publishes it on `127.0.0.1` only; devices never use it.

## mTLS (transport auth)

The 8883 listener runs with:

- `verify = verify_peer` and `fail_if_no_peer_cert = true` - a client with **no** cert or a cert **not** signed by the device CA is dropped at the TLS handshake.
- `cacertfile = device-ca.crt` - the trust anchor for client certs.
- `certfile/keyfile = server.crt/server.key` - the broker's own identity, which the device verifies against the CA it was shipped.
- `peer_cert_as_username = cn` and `peer_cert_as_clientid = cn` - the MQTT username **and** clientid are taken from the cert CN, so a device cannot spoof its identity by setting them in the CONNECT packet.

## Identity binding

A device cert encodes the full tenant/site/device identity in its subject:

```
O  = {tenant_id}      OU = {site_id}      CN = {device_id}
SAN: URI spiffe://voltpilot/ems/{tenant_id}/{site_id}/{device_id}
```

CN carries the `device_id` (a UUID, within the 64-char CN limit); `tenant_id`/`site_id` ride in O/OU (and the SPIFFE SAN) for audit.
Because `peer_cert_as_username = cn`, the broker sees `username = device_id`, which is what the ACL grants key on.

## Per-tenant / per-device ACL

`infra/mqtt/acl.conf` (mounted into EMQX by the secure overlay) is evaluated top-down, first match wins:

1. `dashboard` may watch `$SYS/#`.
2. The internal backbone user **`vp-internal`** (ingest/writer on the trusted 1883) gets full `ems/#` - ingest subscribes to `ems/+/+/+/telemetry` across tenants.
3. **Generated per-device grants** - one block per issued device, binding its exact path:
   ```
   {allow, {username, "<device_id>"}, publish,   ["ems/<t>/<s>/<device_id>/telemetry", ".../status"]}.
   {allow, {username, "<device_id>"}, subscribe, ["ems/<t>/<s>/<device_id>/schedule", ".../command", ".../config"]}.
   ```
   Telemetry/status are **up-only**, schedule/command/config **down-only**.
4. **Default-deny for devices**: any client whose username is a UUID but matched no grant above is denied **every** topic. This is why revocation = "remove the grant".
5. `$SYS` is protected from everyone else; anonymous internal/dev clients on the firewalled 1883 are allowed last.

**Result:** a device can talk on its own `ems/{tenant}/{site}/{device}/…` path and nothing else. One site cannot publish as another - a cross-tenant publish falls through to default-deny.

The grants are managed by `tools/pki/voltpilot-ca.sh` (`issue` inserts a block, `revoke` removes it). Apply changes with `emqx ctl conf reload`.

## CA & certificate issuance

`tools/pki/voltpilot-ca.sh` is the reproducible CLI:

| Command | Does |
|---|---|
| `init-ca --domain <fqdn> [--ip <ip>]` | create the device CA once + issue the broker server cert |
| `issue --tenant <uuid> --site <uuid> --device <uuid>` | mint a client cert bound to those IDs + write its ACL grant |
| `revoke --device <uuid>` | CRL-revoke the cert + remove its ACL grant |
| `gen-crl` | (re)generate the CRL |
| `list` | list issued/revoked certs |

Keys are written under `tools/pki/out/` (git-ignored). **CA and device private keys are never committed.**
`openssl.cnf` holds the CA policy and the server/device extension profiles (serverAuth vs clientAuth EKU).

## Revocation

Two independent cut-offs (architecture §6.6):

1. **ACL denylist (immediate):** `revoke` removes the device's grant; the default-deny rule then blocks it on the next `emqx ctl conf reload` - no restart, no handshake change.
2. **CRL (cryptographic backstop):** `revoke` also marks the cert on the CA CRL (`out/ca/crl.pem`). Copy it to `infra/mqtt/certs/crl.pem`; if you enable CRL checking on the listener (`ssl_options.enable_crl_check = true` + a served CRL) the revoked cert is rejected at the TLS handshake itself.

## Run the secure broker (single self-hosted host)

```bash
# 1. Create CA + broker cert for your public domain.
./tools/pki/voltpilot-ca.sh init-ca --domain mqtt.example.com --ip <public-ip>

# 2. Stage the broker material (dir is git-ignored).
cp tools/pki/out/server/server.crt     infra/mqtt/certs/
cp tools/pki/out/server/server.key     infra/mqtt/certs/
cp tools/pki/out/server/device-ca.crt  infra/mqtt/certs/
cp tools/pki/out/ca/crl.pem            infra/mqtt/certs/     # optional

# 3. Bring up the backbone with the SECURE overlay.
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# 4. Provision devices (claim + cert) and hand out params - see connect-a-device.md.
```

## Hardening checklist (production)

- [ ] **Firewall**: expose only `8883/tcp` to the internet. Block `1883`, `8083`, `18083`, `9092`, `9644`, `5432`, Keycloak, etc. The overlay already binds 1883/dashboard to loopback; the firewall is the real guarantee.
- [ ] **TLS only for external**: devices use 8883 mTLS exclusively. Never expose 1883 off-host.
- [ ] **No anonymous device access**: 8883 requires a CA-signed client cert (`fail_if_no_peer_cert = true`). Verified by `verify_mqtt_security.py` (A2/A3).
- [ ] **Cert identity is bound**: `peer_cert_as_username/clientid = cn` - devices cannot self-assign identity.
- [ ] **ACL default-deny for devices**: ungranted UUID usernames get nothing (`no_match = deny` + the UUID deny rule).
- [ ] **Rotate certs**: default validity 825 days; re-issue before expiry. Rotating = `issue` a fresh cert (same IDs), ship it, reload.
- [ ] **Revocation ready**: `revoke` + `emqx ctl conf reload` on any suspected compromise; keep the CRL current.
- [ ] **Internal creds**: give ingest/writer the `vp-internal` username (or tighten the last ACL rule to your internal clientids) and keep 1883 loopback-only.
- [ ] **Dashboard**: change the default dashboard password; reach it via SSH tunnel to `127.0.0.1:18083`, not publicly.
- [ ] **Secrets**: CA/device keys stay in `tools/pki/out/` (git-ignored) or your secret store - never in the repo or images.

## Verification

Docker-free, CI-friendly proof of the whole model:

```bash
python3 tools/pki/verify_mqtt_security.py
```

It uses the real cert tool + Python's `ssl` (the same OpenSSL machinery EMQX uses) to prove: valid cert connects, no-cert/untrusted-cert rejected, revoked cert fails CRL check, and the ACL (parsed from the real `acl.conf` with EMQX first-match semantics) confines devices and denies cross-tenant publishes.

### Live-broker manual check (when Docker is available)

Run a throwaway secured EMQX on non-colliding ports and exercise it with `mosquitto_pub`:

```bash
# Mint a PKI + a device cert (writes to tools/pki/out, appends an ACL grant).
./tools/pki/voltpilot-ca.sh init-ca --domain localhost --ip 127.0.0.1
./tools/pki/voltpilot-ca.sh issue --tenant 00000000-0000-0000-0000-000000000001 \
  --site 00000000-0000-0000-0000-000000000002 --device 00000000-0000-0000-0000-000000000003

# Throwaway broker on 18883 (no host-port collision with a running dev stack).
docker run --rm -d --name emqx-secure-test -p 18883:8883 \
  -v "$PWD/tools/pki/out/server/server.crt:/opt/emqx/etc/certs/server.crt:ro" \
  -v "$PWD/tools/pki/out/server/server.key:/opt/emqx/etc/certs/server.key:ro" \
  -v "$PWD/tools/pki/out/server/device-ca.crt:/opt/emqx/etc/certs/device-ca.crt:ro" \
  -v "$PWD/infra/mqtt/acl.conf:/opt/emqx/etc/acl.conf:ro" \
  -e EMQX_LISTENERS__SSL__DEFAULT__SSL_OPTIONS__CACERTFILE=/opt/emqx/etc/certs/device-ca.crt \
  -e EMQX_LISTENERS__SSL__DEFAULT__SSL_OPTIONS__CERTFILE=/opt/emqx/etc/certs/server.crt \
  -e EMQX_LISTENERS__SSL__DEFAULT__SSL_OPTIONS__KEYFILE=/opt/emqx/etc/certs/server.key \
  -e EMQX_LISTENERS__SSL__DEFAULT__SSL_OPTIONS__VERIFY=verify_peer \
  -e EMQX_LISTENERS__SSL__DEFAULT__SSL_OPTIONS__FAIL_IF_NO_PEER_CERT=true \
  -e EMQX_LISTENERS__SSL__DEFAULT__PEER_CERT_AS_USERNAME=cn \
  -e EMQX_AUTHORIZATION__NO_MATCH=deny \
  emqx/emqx:5.8.3
sleep 15
D=tools/pki/out/devices/00000000-0000-0000-0000-000000000003

# (a) valid cert publishes its OWN topic -> success
mosquitto_pub -h localhost -p 18883 --cafile $D/device-ca.crt \
  --cert $D/device.crt --key $D/device.key \
  -t ems/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002/00000000-0000-0000-0000-000000000003/telemetry \
  -q 1 -m '{"schema_version":"1.0"}'          # exit 0

# (b) no client cert -> TLS handshake rejected
mosquitto_pub -h localhost -p 18883 --cafile $D/device-ca.crt \
  -t ems/.../telemetry -m x                    # non-zero, TLS error

# (c) valid cert, ANOTHER tenant's topic -> ACL denied (broker disconnects)
mosquitto_pub -h localhost -p 18883 --cafile $D/device-ca.crt \
  --cert $D/device.crt --key $D/device.key \
  -t ems/10000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002/00000000-0000-0000-0000-000000000003/telemetry \
  -q 1 -m x                                    # not authorized

docker rm -f emqx-secure-test
```

> This repo's sandbox blocks the Docker socket, so the live recipe above is documented for the captain's host; the automated `verify_mqtt_security.py` covers the same three guarantees (mTLS gating + ACL confinement + revocation) without Docker.
