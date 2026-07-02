# Production deployment (single VM/VPS)

How VoltPilot-EMS is deployed for the MVP: one Linux server (an internal Ubuntu VM or a VPS) running the whole server-side stack from `docker-compose.prod.yml`, TLS terminated by an **external** reverse proxy on another host (Nginx Proxy Manager or Caddy), and - once CI secrets are set - push-to-deploy from Forgejo.
This mirrors the proven saalo recipe (single server + external TLS proxy + Forgejo registry + SSH roll-out).

This is deliberately the smallest thing that works.
It is escalatable later (managed Postgres, Kubernetes, a Hetzner/GitOps setup) without changing the application - see [Escalating beyond one VPS](#escalating-beyond-one-vps).

There are two ways to deploy, both against the same compose file:

- **(a) Manual, no CI** - clone the repo on the server, build the images there, `up -d`. The path for the FIRST deployment (next section).
- **(b) CI push-to-deploy** - the Forgejo workflow builds/pushes images and rolls the server out over SSH. Needs the Actions secrets; see [First deploy via CI](#first-deploy-via-ci).

## Erstes Deployment (interne Ubuntu-VM)

The first real deployment target: an internal Ubuntu VM at the company, reachable by colleagues, sitting behind the company's **Nginx Proxy Manager** (NPM) on a different host that maps `voltpilot.<company-domain>` to the VM.
No CI secrets are needed - everything is built and started on the VM itself with plain `docker compose`.

### 1. Prerequisites on the VM (once)

Ubuntu 22.04/24.04 with Docker Engine + the compose plugin:

```bash
# Docker's convenience installer (installs engine + buildx + compose plugin):
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out/in afterwards
docker compose version          # sanity: v2.x
```

### 2. Get the code and configure

The repo clone itself is the deploy directory - the compose file bind-mounts `infra/prod/`, `infra/mqtt/` and `deploy/keycloak/themes/` by relative path, and a clone has all of them:

```bash
sudo mkdir -p /srv/docker
sudo chown $USER /srv/docker
git clone https://git.tecmaxx.de/mamotec/voltpilot-ems.git /srv/docker/voltpilot
cd /srv/docker/voltpilot

cp .env.prod.example .env
```

Fill in `.env` (every `${VAR:?}` in the compose aborts the start while blank):

```bash
# DOMAIN: what NPM will serve, e.g. voltpilot.<company-domain>
# APP_PORT: the plain-HTTP port NPM forwards to (default 8080)

# One secret per line - paste the output into .env:
openssl rand -base64 24   # POSTGRES_PASSWORD
openssl rand -base64 24   # APP_DB_PASSWORD
openssl rand -base64 24   # ADMIN_DB_PASSWORD
openssl rand -base64 24   # KEYCLOAK_DB_PASSWORD
openssl rand -base64 24   # KEYCLOAK_ADMIN_PASSWORD
openssl rand -base64 24   # VP_PORTAL_ADMIN_PASSWORD
openssl rand -base64 24   # VP_API_CLIENT_SECRET
openssl rand -hex 16      # EMQX_NODE_COOKIE
openssl rand -base64 24   # EMQX_DASHBOARD_PASSWORD
```

Leave `SPRING_PROFILES_ACTIVE=local` for the first look (seeds the demo tenants, so `demo`/`demo` shows data immediately).

### 3. Stage the MQTT broker certs (required - EMQX will not start without them)

The EMQX service bind-mounts `infra/mqtt/certs/{server.crt,server.key,device-ca.crt,crl.pem}` as read-only files.
They are git-ignored, so a fresh clone does not have them; generate them right on the VM:

```bash
cd /srv/docker/voltpilot
./tools/pki/voltpilot-ca.sh init-ca --domain voltpilot.<company-domain> --ip <VM-IP>
mkdir -p infra/mqtt/certs
cp tools/pki/out/server/{server.crt,server.key,device-ca.crt} infra/mqtt/certs/
cp tools/pki/out/ca/crl.pem infra/mqtt/certs/
```

(If the CA should not live on the VM, run `init-ca` elsewhere and `scp` the four files over - see [Device mTLS material](#3-device-mtls-material-staged-once-on-the-vps).)

### 4. Build and start

```bash
cd /srv/docker/voltpilot
docker compose -f docker-compose.prod.yml build     # builds all six app images locally
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps        # wait until everything is healthy
```

The compose file carries both `image:` (registry name) and `build:` (local context) for every app service, so `build` tags the local images under the registry names and `up -d` uses them without pulling.
The first build takes a while (Maven + npm inside Docker); subsequent builds are cached.
To update later: `git pull && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d`.
If the Keycloak login theme changed, add `docker compose -f docker-compose.prod.yml up -d --force-recreate keycloak`: in `start` mode Keycloak caches themes at boot AND pre-gzips served resources onto the container filesystem, so a plain `restart` keeps serving the old CSS to browsers.

### 5. Create the NPM Proxy Host

See [Nginx Proxy Manager](#nginx-proxy-manager-on-the-other-host) below, then browse to `https://voltpilot.<company-domain>`.

### 6. First-login checklist

| Login | Where | Credentials | Do |
|---|---|---|---|
| Portal-Admin | `https://${DOMAIN}` (portal) | `admin` / `VP_PORTAL_ADMIN_PASSWORD` | Create the real tenants + colleague users in the admin console. |
| Portal demo | `https://${DOMAIN}` (portal) | `demo` / `demo`, `demo2` / `demo2` | Verify telemetry/prices/weather render. Remove before customer launch. |
| Keycloak admin console | `https://${DOMAIN}/auth/admin` | `admin` / `KEYCLOAK_ADMIN_PASSWORD` | Verify the `voltpilot` realm imported with the VoltPilot login theme. |
| EMQX dashboard | SSH tunnel to `127.0.0.1:18083` | `admin` / `EMQX_DASHBOARD_PASSWORD` | Check the mTLS listener on 8883 is running. |

The demo users have well-known passwords - keep the stack internal (firewall, see below) until they are removed, and change any password you handed out on first use.
Before serving real customers, follow [Going to a real production launch](#going-to-a-real-production-launch).

## Nginx Proxy Manager (on the other host)

The company reverse proxy is **Nginx Proxy Manager** (NPM) on a different host; it terminates TLS and forwards plain HTTP to the VM.
Create a **Proxy Host** in the NPM UI:

| NPM field | Value |
|---|---|
| Domain Names | `voltpilot.<company-domain>` |
| Scheme | `http` |
| Forward Hostname / IP | `<VM-IP>` |
| Forward Port | `${APP_PORT}` (default `8080`) |
| Block Common Exploits | **ON** |
| Websockets Support | **ON** (harmless now, required once the portal's live WS channel lands) |
| SSL | Request a Let's Encrypt certificate (or attach the internal-CA cert), **Force SSL** ON, HTTP/2 ON |

Header expectations - NPM's default proxy host template already does the right thing:

- NPM forwards the original `Host` header and sets `X-Forwarded-Proto` (`$scheme`, i.e. `https`) and `X-Forwarded-For` automatically.
- The stack **requires** exactly that: Keycloak (`KC_PROXY_HEADERS=xforwarded`) and the frontend nginx trust `X-Forwarded-Proto` to reconstruct HTTPS URLs, and the `/auth` login flow breaks without it.
  No custom-location or advanced-config snippets are needed.
- The registration rate limiter keys clients by the **`X-Forwarded-For`** chain: NPM appends the real client address, the frontend nginx appends NPM's, so the api (with `VOLTPILOT_REGISTRATION_RATE_LIMIT_TRUSTED_PROXIES=2`, the prod default) reads the 2nd-from-the-right entry as the client.
  Entries further left are client-supplied and are deliberately ignored - never lower `trusted-proxies`, and raise it by one for every additional own proxy layer in front of NPM.
- If you use an internal CA instead of Let's Encrypt, colleagues' browsers/OS trust stores must contain that CA - the stack itself does not care.

**MQTT is TCP, not HTTP** - NPM proxy hosts do NOT cover it.
Edge devices connect to `<VM-IP>:8883` (mTLS) directly; give them the VM's address (or a dedicated DNS record pointing at the VM).
If you prefer one entry point, NPM can pass TCP through with a **Stream** (incoming `8883` -> `<VM-IP>:8883`), but plain direct access on the internal net is simpler.
Note: the broker's server certificate contains the names passed to `init-ca --domain/--ip`, so devices must dial one of those - if devices should connect via a different name than `${DOMAIN}`, include it at CA init time.

### Firewall (internal VM)

On the VM (example: `ufw`):

- **Allow `${APP_PORT}/tcp` only from the NPM host** - it is plain HTTP; nothing else should reach it.
- **Allow `8883/tcp` from the internal network** (or wherever devices live).
- **Allow SSH** from your admin network.
- **Block everything else** inbound; the compose file publishes nothing else (`1883`/`18083` are loopback-only).

```bash
sudo ufw allow from <NPM-IP> to any port ${APP_PORT:-8080} proto tcp
sudo ufw allow from <internal-net-CIDR> to any port 8883 proto tcp
sudo ufw allow OpenSSH
sudo ufw enable
```

## Topology

```
   devices (edge)                network                 your infra
 ┌───────────────┐  mqtts:8883  ┌──────────────────────────────────────────────┐
 │ Node-RED edge │ ───────────► │ VM/VPS (this compose)                         │
 └───────────────┘  outbound    │   emqx :8883  ── ingest → redpanda → writer   │
                                 │   frontend :APP_PORT (plain HTTP) ─┐          │
 ┌───────────────┐   https:443  │        │ /api → api  /auth → keycloak│         │
 │   browser     │ ──► NPM  ──► │ ◄──────┘ (X-Forwarded-Proto: https)          │
 └───────────────┘  or Caddy   │   timescaledb · keycloak(+db) · redpanda …    │
                    (other host)└──────────────────────────────────────────────┘
```

Only **two** ports are published from the server:

| Port | Who reaches it | Notes |
|---|---|---|
| `APP_PORT` (default 8080, plain HTTP) | **only the reverse-proxy host** | The single web entry point. Firewall it so nothing else can reach it. TLS is terminated upstream (NPM or Caddy). |
| `8883` (mTLS) | **devices** (internet or internal net) | Remote edge devices connect outbound with a client cert. See [`connect-a-device.md`](connect-a-device.md). |

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
openssl rand -base64 24   # POSTGRES_PASSWORD, APP_DB_PASSWORD, ADMIN_DB_PASSWORD,
                          # KEYCLOAK_DB_PASSWORD, KEYCLOAK_ADMIN_PASSWORD,
                          # VP_PORTAL_ADMIN_PASSWORD, VP_API_CLIENT_SECRET,
                          # EMQX_DASHBOARD_PASSWORD
openssl rand -hex 16      # EMQX_NODE_COOKIE
```

Set `DOMAIN` and `APP_PORT` to match your reverse-proxy config.
Leave `SPRING_PROFILES_ACTIVE=local` to seed the two demo tenants + demo users for a first look; set it **blank** for a clean production database (and remove the demo users from the realm - see below).

**Optional: Marktstammdatenregister (MaStR) credentials.**
`MASTR_API_KEY` and `MASTR_MARKTAKTEUR_NUMMER` may stay blank: the portal's "Anlage verknüpfen" step then uses the keyless public MaStR JSON backend, which is fine to launch with.
To promote lookups to the official BNetzA SOAP webservice, do the one-time free registration (MaStR account -> register the company as Marktakteur -> create a **Webdienstnutzer**, which yields the Webdienst-Schlüssel), fill both variables and `docker compose up -d api` - the api picks the source per config, no code change or image rebuild.
Handle the key like `ENTSOE_SECURITY_TOKEN`: env only, never committed.

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

## First deploy via CI

The later path, once the Forgejo runner + Actions secrets are set up (the manual VM path above needs none of this).

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

## External Caddy (alternative to NPM)

If the TLS-terminating host runs Caddy instead of Nginx Proxy Manager: TLS terminates on Caddy; it forwards plain HTTP to the server's app port and tells the stack the original scheme was HTTPS.
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
- Decide whether to keep public self-registration (`VOLTPILOT_REGISTRATION_ENABLED`, default `true`; set `false` in `.env` for a closed platform where only Portal-Admins create accounts).
  Its rate limiter assumes **2** own proxy hops appending to `X-Forwarded-For` (external reverse proxy → frontend nginx, `VOLTPILOT_REGISTRATION_RATE_LIMIT_TRUSTED_PROXIES=2`) - adjust the value if you add or remove a proxy layer.
- Rotate every secret in `.env` and the EMQX dashboard password.
- Confirm the firewall rules above and change the Keycloak admin password.

## Escalating beyond one VPS

The application is infra-agnostic; this compose is just the MVP substrate.
Later moves that need **no application change**:

- Managed Postgres/Timescale and object storage instead of the in-compose databases.
- Kubernetes manifests (the services are already stateless with their own Dockerfiles) + GitOps.
- A dedicated ingress/observability tier (Prometheus/Grafana/Loki/OTel) and Mender OTA for edges.

Until then, one VPS + external Caddy + this pipeline is the supported path.
