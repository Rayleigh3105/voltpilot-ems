# Production deployment (single VPS)

How VoltPilot-EMS is deployed for the MVP: one VPS running the whole server-side stack from `docker-compose.prod.yml`, TLS terminated by an **external** Caddy on another host, and push-to-deploy from Forgejo.
This mirrors the proven saalo recipe (single VPS + external Caddy + Forgejo registry + SSH roll-out).

This is deliberately the smallest thing that works.
It is escalatable later (managed Postgres, Kubernetes, a Hetzner/GitOps setup) without changing the application - see [Escalating beyond one VPS](#escalating-beyond-one-vps).

## Topology

```
   devices (edge)                internet                your infra
 ┌───────────────┐  mqtts:8883  ┌──────────────────────────────────────────────┐
 │ Node-RED edge │ ───────────► │ VPS (this compose)                            │
 └───────────────┘  outbound    │   emqx :8883  ── ingest → redpanda → writer   │
                                 │   frontend :APP_PORT (plain HTTP) ─┐          │
 ┌───────────────┐   https:443  │        │ /api → api  /auth → keycloak│         │
 │   browser     │ ──► Caddy ──► │ ◄──────┘ (X-Forwarded-Proto: https)          │
 └───────────────┘  (other host)│   timescaledb · keycloak(+db) · redpanda …    │
                                 └──────────────────────────────────────────────┘
```

Only **two** ports are published from the VPS:

| Port | Who reaches it | Notes |
|---|---|---|
| `APP_PORT` (default 8080, plain HTTP) | **only the Caddy host** | The single web entry point. Firewall it so nothing else can reach it. TLS is terminated upstream. |
| `8883` (mTLS) | **the internet (devices)** | Remote edge devices connect outbound with a client cert. See [`connect-a-device.md`](connect-a-device.md). |

Everything else (api, keycloak, keycloak-db, timescaledb, redpanda, ingest, writer, collectors) stays on the internal compose network `voltpilot-prod`.
The plaintext MQTT `1883` and the EMQX dashboard `18083` are bound to loopback for on-host/tunnel use only.

## What you provide

### 1. Forgejo Actions secrets

Set these under the repo **Settings → Actions → Secrets** before running a deploy workflow.
They are placeholders in the pipeline today; fill them with the real values.

| Secret | Meaning |
|---|---|
| `FORGEJO_USERNAME` / `FORGEJO_PASSWORD` | Login for the Forgejo container registry `git.tecmaxx.de` (build push + VPS pull). |
| `DEPLOY_HOST` | The VPS hostname/IP the pipeline SSHes into. |
| `DEPLOY_USER` / `DEPLOY_PASSWORD` | SSH user + password on the VPS (the user needs `sudo` and Docker access). |
| `DOMAIN` | Public FQDN, e.g. `ems.example.com`. Baked into the SPA build (`VITE_KEYCLOAK_URL=https://${DOMAIN}/auth`). |

### 2. The VPS `.env`

Copy [`.env.prod.example`](../.env.prod.example) to `/srv/docker/voltpilot/.env` on the VPS and fill it in.
`docker compose` reads it automatically; the deploy workflow only overrides `IMAGE_TAG` per rollout.
The `${VAR:?}` entries in the compose file abort the deploy if a required secret is blank.

Generate the secrets:

```bash
openssl rand -base64 24   # POSTGRES_PASSWORD, APP_DB_PASSWORD, KEYCLOAK_DB_PASSWORD,
                          # KEYCLOAK_ADMIN_PASSWORD, VP_API_CLIENT_SECRET, EMQX_DASHBOARD_PASSWORD
openssl rand -hex 16      # EMQX_NODE_COOKIE
```

Set `DOMAIN` and `APP_PORT` to match your Caddy config.
Leave `SPRING_PROFILES_ACTIVE=local` to seed the two demo tenants + demo users for a first look; set it **blank** for a clean production database (and remove the demo users from the realm - see below).

### 3. Device mTLS material (staged once on the VPS)

The EMQX service bind-mounts the broker cert/key + device CA from `/srv/docker/voltpilot/infra/mqtt/certs/`.
These keys are **never** in the repo or the images - stage them on the VPS before the first `up`:

```bash
# On the machine that holds the CA (see docs/security-mqtt.md):
./tools/pki/voltpilot-ca.sh init-ca --domain ${DOMAIN} --ip <vps-public-ip>

# Copy the broker material to the VPS deploy dir:
scp tools/pki/out/server/{server.crt,server.key,device-ca.crt} \
    ${DEPLOY_USER}@${DEPLOY_HOST}:/srv/docker/voltpilot/infra/mqtt/certs/
# optional CRL for revocation:
scp tools/pki/out/ca/crl.pem ${DEPLOY_USER}@${DEPLOY_HOST}:/srv/docker/voltpilot/infra/mqtt/certs/
```

The deploy workflow ships the committed `infra/mqtt/acl.conf` and the `infra/prod/**` bootstrap for you; only the private certs are manual.

## First deploy

1. **Provision the VPS**: install Docker Engine + the compose plugin, create `/srv/docker/voltpilot/`, and put `.env` there (step 2 above).
2. **Stage the device certs** into `/srv/docker/voltpilot/infra/mqtt/certs/` (step 3 above).
3. **Set the Forgejo secrets** (step 1 above).
4. **Run the pipeline**: trigger the **Build & Deploy** workflow (`.forgejo/workflows/deploy.yaml`) from the Forgejo Actions tab.
   It runs the test gate, builds + pushes every image to `git.tecmaxx.de/mamotec/voltpilot-ems/<svc>:<sha>`, then SSHes to the VPS, copies `docker-compose.prod.yml` → `/srv/docker/voltpilot/docker-compose.yml`, and runs `docker compose pull && up -d --remove-orphans` pinned to that SHA.
   For a quick rollout that skips the test gate, use **Build & Deploy (fast)** (`deploy-fast.yaml`).
5. **Point Caddy at the VPS** (next section) and browse to `https://${DOMAIN}`.
6. **Onboard devices** against `8883` per [`connect-a-device.md`](connect-a-device.md).

Manual roll-out (no CI) does the same thing:

```bash
cd /srv/docker/voltpilot
export IMAGE_TAG=latest        # or a specific commit SHA
echo "$FORGEJO_PASSWORD" | docker login git.tecmaxx.de -u "$FORGEJO_USERNAME" --password-stdin
docker compose pull
docker compose up -d --remove-orphans
```

## External Caddy (on the other host)

TLS terminates on Caddy; it forwards plain HTTP to the VPS app port and tells the stack the original scheme was HTTPS.
Minimal `Caddyfile`:

```caddy
ems.example.com {
    # VPS private/public address and the published APP_PORT.
    reverse_proxy http://VPS_HOST:8080 {
        header_up X-Forwarded-Proto https
        # Caddy preserves the Host header and appends X-Forwarded-For by default.
    }
}
```

`X-Forwarded-Proto: https` is required: Keycloak (`KC_PROXY_HEADERS=xforwarded`) and the frontend nginx both trust it to reconstruct HTTPS URLs, and the `/auth` login flow breaks without it.
Caddy obtains and renews the certificate for `${DOMAIN}` automatically.

## Firewall

On the VPS:

- **Allow `8883/tcp` from anywhere** - remote devices need it.
- **Allow `APP_PORT/tcp` only from the Caddy host** - it is plain HTTP; nothing else should reach it.
- **Block everything else** inbound: `1883`, `8083`, `18083` (EMQX), `9092`/`9644` (Redpanda), `5432` (Postgres), and the internal service ports.
  The compose file already binds `1883`/`18083` to loopback and publishes no other host ports, but the firewall is the real guarantee.

Reach the EMQX dashboard via an SSH tunnel to `127.0.0.1:18083`, never publicly.
The full checklist is in [`security-mqtt.md`](security-mqtt.md#hardening-checklist-production).

## How devices reach 8883

Unchanged from the secure-broker design: a device makes an **outbound-only** mutual-TLS connection to `${DOMAIN}:8883` with a client cert issued by `tools/pki/voltpilot-ca.sh`.
The cert CN carries the `device_id`; EMQX binds identity from the cert and the per-device ACL confines it to `ems/{tenant}/{site}/{device}/#`.
Issue + hand out certs with the provisioning flow in [`connect-a-device.md`](connect-a-device.md); revoke with `voltpilot-ca.sh revoke` + an EMQX config reload.

## Going to a real production launch

The defaults make a fresh deploy immediately demoable.
Before serving real customers:

- Set `SPRING_PROFILES_ACTIVE=` (blank) in `.env` so the api does **not** seed demo tenants/telemetry.
- Remove the `demo`/`demo2` users from `infra/prod/keycloak/voltpilot-realm.json` (or delete them in the Keycloak admin console) and create real users, each with a `tenant_id` attribute and a matching `tenant` row.
- Rotate every secret in `.env` and the EMQX dashboard password.
- Confirm the firewall rules above and change the Keycloak admin password.

## Escalating beyond one VPS

The application is infra-agnostic; this compose is just the MVP substrate.
Later moves that need **no application change**:

- Managed Postgres/Timescale and object storage instead of the in-compose databases.
- Kubernetes manifests (the services are already stateless with their own Dockerfiles) + GitOps.
- A dedicated ingress/observability tier (Prometheus/Grafana/Loki/OTel) and Mender OTA for edges.

Until then, one VPS + external Caddy + this pipeline is the supported path.
