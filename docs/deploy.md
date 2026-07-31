# Production deployment (single VM/VPS)

How VoltPilot-EMS is deployed for the MVP: one Linux server (an internal Ubuntu VM or a VPS) running the whole server-side stack from `docker-compose.prod.yml`, TLS terminated by an **external** reverse proxy on another host (Nginx Proxy Manager or Caddy), and - once CI secrets are set - push-to-deploy from Forgejo.
This mirrors the proven saalo recipe (single server + external TLS proxy + Forgejo registry + SSH roll-out).

This is deliberately the smallest thing that works.
It is escalatable later (managed Postgres, Kubernetes, a Hetzner/GitOps setup) without changing the application - see [Escalating beyond one VPS](#escalating-beyond-one-vps).
The per-service operating contract a Kubernetes manifest may rely on (probe path + port, SIGTERM behaviour + recommended grace period, required env, scalability incl. the api singleton blockers) is [`docs/k8s-readiness.md`](k8s-readiness.md).

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

`SPRING_PROFILES_ACTIVE` is **blank by default = production** (only the prod-safe `db/migration` core runs, no demo data). For a throwaway internal/demo VM where you want `demo`/`demo` to show data immediately, set `SPRING_PROFILES_ACTIVE=local` - it additionally runs the dev seed migrations (`db/dev`). Read [Spring profile: production is blank, demo is `local`](#spring-profile-production-is-blank-demo-is-local) before choosing, and especially before editing a `db/dev` migration on a running `local` VM.

### 3. Stage the MQTT broker certs (required - EMQX will not start without them)

The EMQX service bind-mounts `infra/mqtt/certs/{server.crt,server.key,device-ca.crt,crl.pem}` as read-only files.
They are git-ignored, so a fresh clone does not have them; generate them right on the VM:

```bash
cd /srv/docker/voltpilot
./tools/pki/voltpilot-ca.sh init-ca --domain mqtt.<company-domain> --ip <VM-IP>
mkdir -p infra/mqtt/certs
cp tools/pki/out/server/{server.crt,server.key,device-ca.crt} infra/mqtt/certs/
cp tools/pki/out/ca/crl.pem infra/mqtt/certs/
# REQUIRED: make the broker key readable by the emqx process (see below).
chmod 0755 infra/mqtt/certs
chmod 0644 infra/mqtt/certs/*.crt infra/mqtt/certs/*.pem infra/mqtt/certs/server.key
```

> **`server.key` MUST be readable by the `emqx` process, or EMQX will not start.**
> The `emqx/emqx` container runs as the non-root `emqx` user (uid/gid `1000`), and
> the bind mount preserves the file's *host* numeric ownership - so a key that
> `voltpilot-ca.sh` created `0600`-owned-by-your-deploy-user is **not readable by
> emqx inside the container**, and the broker fails boot with `cannot read keyfile`
> (the live incident on 2026-07-03). The **exact expectation**: the mounted
> `infra/mqtt/certs/` directory is traversable (`0755`) and `server.key` is
> readable by the emqx uid. The robust, uid-independent way (matching the
> `acl.conf` convention this stack already uses, and safe on this firewalled,
> single-purpose VM where the key already lives in plaintext) is `chmod 0644
> server.key`. If you prefer to keep the private key non-world-readable, the
> tighter `chown 1000:1000 infra/mqtt/certs/server.key && chmod 0640 …/server.key`
> also works because the emqx image runs as uid `1000`. The CI deploy workflows
> enforce these permissions automatically on every roll-out (see the deploy
> pipeline), so a re-staged key never has to be hand-fixed live again.

`--domain` is the name devices will dial: the recommended setup is a **dedicated MQTT subdomain** (`mqtt.<company-domain>`, plain DNS A record to the VM - see the MQTT note in the NPM section below); the `--ip` lands in the SAN too, so dialing the raw IP stays a working fallback.

The CA working dir this creates (`tools/pki/out/ca` in the clone) also powers **first-boot device enrollment**: the api mounts it read-write (`docker-compose.prod.yml`) and signs device CSRs with it once their ref is claimed in the portal, plus the ACL directory `infra/mqtt/acl/` to write per-device grants into `acl.conf`.
Both are **directory** mounts on purpose: the api replaces `acl.conf` atomically via rename, and renaming onto a single-file bind mount fails with EBUSY (and would pin EMQX's read-only view to the replaced inode) - never remap `acl.conf` as a single-file mount (see [connect-a-device.md](connect-a-device.md)).
Security consideration: this makes the api container the CA **signer**, so the VM and that mount are part of the PKI trust boundary; every issuance is audit-logged by the api, and `voltpilot-ca.sh revoke` keeps working over api-issued certs (shared serial/index.txt database).
EMQX reads the ACL directory **read-only** and applies changed grants only on an authz reload - after an enrollment issuance, run (or cron, e.g. every 5 minutes):

```bash
./tools/pki/reload-broker-authz.sh
```

(The CI deploy workflows run this automatically after `up -d`. Note that `emqx ctl conf reload` does **not** re-read the ACL file - the file authorizer compiles its rules at source init and is only re-initialized when its config changes, which the script forces; verified on EMQX 5.8.3.)

**Self-healing ACL (grant ordering).**
EMQX's file authorizer is first-match, top to bottom: a per-device grant is only reachable if it sits **above** the catch-all UUID default-deny, i.e. INSIDE the `%%<<BEGIN..>> .. %%<<END GENERATED DEVICE GRANTS>>` region.
A past bug could leave a grant appended **below** the default-deny (unreachable, so the device was denied and kicked off the broker) with the template tail duplicated, or - the residual 2026-07-08 incident - **drop the device grant from `acl.conf` entirely** (a buggy rebuild lost it), leaving nothing to reorder or reload.
Three layers now keep `acl.conf` canonical and repair it with **no manual edit and no device re-claim**:
1. **api startup self-heal (primary), regenerate-from-truth + always-reload.** On boot the api **rebuilds the generated-grant region from the database source of truth**: for every claimed + enrolled device (`EnrollmentDeviceLookup.allEnrolledDeviceIdentities()`) it emits a correct in-region grant, so a grant that was **dropped from the file is restored** (not merely reordered - you cannot reload a grant that is not there), a misordered one is moved above the default-deny, duplicated tails are collapsed to one, and grants written out of band (`tools/pki`) are preserved. If the DB is briefly unreachable it falls back to a pure canonicalize (fixes ordering, still reloads) and never crashes the boot. Then it **ALWAYS forces EMQX to re-read the file** - *regardless of whether the file changed* - because a long-running EMQX (up across earlier deploys) can still hold **stale compiled rules** even when the on-disk file is already correct (EMQX compiles `acl.conf` once at source init and never re-reads it on its own; a plain `emqx ctl conf reload` does **not** re-read it - verified on 5.8.3, only the REST `PUT /authorization/sources/file` does). So **deploying (or even just restarting) the api reconstructs every enrolled device's grant and reconciles the running broker every boot - the device recovers on its own, with zero manual steps** - the api logs the resolved `acl.conf` path, how many grants it (re)wrote, and the reload outcome (`INFO` on success, a loud actionable `ERROR` if the broker did not accept it). Proven end-to-end against a real EMQX 5.8.3 by `AclRegenerateReloadBrokerE2eTest` (a *missing* grant regenerated from truth flips the device to allowed; an already-canonical file over a *stale* broker still reloads and flips it) and `AclSelfHealBrokerE2eTest` (a *misordered* grant healed + reloaded).
2. **Grant writes** (enrollment issuance, `voltpilot-ca.sh issue/revoke`) do the same canonicalizing rebuild, so any claim/unclaim also self-heals.
3. **The deploy-time merge** (`tools/pki/merge-acl-grants.sh`) collects device grants from the deployed file wherever they sit (a grant below the deny is no longer silently dropped) and re-emits them inside the base's single region above a single tail.

All three are idempotent and never duplicate the tail.

**Does an already-running EMQX need `docker restart emqx` after this deploy? No - not when `broker-authz-reload` is enabled** (the prod compose sets `VOLTPILOT_BROKER_AUTHZ_RELOAD_ENABLED=true`, reusing `EMQX_DASHBOARD_PASSWORD`). The startup self-heal drives the REST `PUT /authorization/sources/file` on **every** boot, which re-initializes EMQX's file authorizer on the running broker (verified: a plain `emqx ctl conf reload` does **not** re-read `acl.conf`, but this does). **Break-glass:** if the api logs `Broker authz reload FAILED on startup` (broker unreachable, wrong `broker-authz-reload.api-url`/credentials, or the feature disabled), the file on disk is already correct - just force the re-read manually:

```bash
./tools/pki/reload-broker-authz.sh            # preferred (same re-init the api attempts)
# or, if that is unavailable:
docker compose -f docker-compose.prod.yml restart emqx   # re-reads acl.conf at boot
```

Never hand-edit `acl.conf` to fix ordering - the self-heal already made it canonical; only the broker re-read is missing.

If the CA must NOT live on this host, set `VOLTPILOT_ENROLLMENT_ENABLED=false` in `.env`, run `init-ca` elsewhere and `scp` the four broker files over - see [Device mTLS material](#3-device-mtls-material-staged-once-on-the-vps); device certs are then issued manually with `voltpilot-ca.sh issue`.

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
(That recreate is only needed on the bind-mount path - the project Keycloak image below bakes the theme in and is replaced rather than restarted, so its cache cannot go stale.)

#### Optional: the project Keycloak image

`keycloak` is the one service whose compose default is still an upstream image (`quay.io/keycloak/keycloak`) with the realm import and the login theme bind-mounted.
CI also builds a **project image that bakes both in** (`git.tecmaxx.de/mamotec/voltpilot-ems/keycloak:{latest,<sha>}`, from `deploy/keycloak/Dockerfile`) - that is what the Kubernetes deployment pulls, since a cluster cannot supply an 8-file theme directory as a mount.
To run that same image here, put a full reference into `.env` and recreate the one service:

```bash
echo 'KEYCLOAK_IMAGE=git.tecmaxx.de/mamotec/voltpilot-ems/keycloak:latest' >> .env
docker compose -f docker-compose.prod.yml up -d keycloak
```

Leaving `KEYCLOAK_IMAGE` unset keeps today's behaviour exactly.
The bind-mounts may stay (they overlay byte-identical files from the same commit); note that `KEYCLOAK_IMAGE` is a complete reference and is **not** pinned by `IMAGE_TAG` - write a SHA literally if you want one.
Background and the version-lockstep rule: [`deploy/keycloak/README.md`](../deploy/keycloak/README.md).

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

**MQTT is TCP, not HTTP** - NPM proxy hosts are HTTP-only and do NOT cover it.
Recommended: give devices a **dedicated MQTT subdomain** via a plain DNS **A record** `mqtt.<company-domain> -> <VM-IP>` - `8883` is published by the VM directly, so no NPM involvement is needed.

> **Set `MQTT_DOMAIN` in `.env` to that exact name.** With device enrollment on
> (`VOLTPILOT_ENROLLMENT_ENABLED=true`, the default proxied production model),
> `MQTT_DOMAIN` is what enrolled devices are told to dial - it **must** match a
> name in the broker server-cert SAN (`init-ca --domain/--ip`). Leaving it unset
> silently fell back to `mqtt.${DOMAIN}` and handed devices the wrong host live
> (2026-07-03), so the CI deploy preflight now **aborts** when enrollment is on
> and `MQTT_DOMAIN` is unset. For a raw-IP (non-proxied) setup, set
> `MQTT_DOMAIN=<VM-IP>`. Only a non-enrollment deployment
> (`VOLTPILOT_ENROLLMENT_ENABLED=false`) may leave it unset.
An NPM **Stream** (incoming `8883` -> `<VM-IP>:8883`) could pass the TCP through if you insist on one entry point, but it is unnecessary; dialing the raw `<VM-IP>` also keeps working as a fallback.
The broker's server certificate must contain the name devices dial (`init-ca --domain/--ip` puts both the domain and the IP in the SAN).
Adding the MQTT domain to an **already-running** broker is safe: re-running `init-ca` keeps the existing CA (all issued device certs stay valid) and re-issues only the server cert with the new DNS+IP SANs - then re-stage it and restart the broker:

```bash
./tools/pki/voltpilot-ca.sh init-ca --domain mqtt.<company-domain> --ip <VM-IP>
cp tools/pki/out/server/{server.crt,server.key} infra/mqtt/certs/
chmod 0644 infra/mqtt/certs/server.key   # re-staged 0600; emqx must be able to read it (see step 3)
docker compose -f docker-compose.prod.yml restart emqx
```

Afterwards both the domain and the IP verify.

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
| `DEPLOY_USER` / `DEPLOY_PASSWORD` | SSH user + password on the VPS. `root` works directly (no `sudo` needed on the host); a non-root user needs `sudo`, or - on a host without `sudo` - must own `/srv/docker/voltpilot` and be in the `docker` group. |
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
`SPRING_PROFILES_ACTIVE` is **blank by default = production** (clean DB, no demo data); set it to `local` only for a throwaway VM where you want the two demo tenants + demo users seeded for a first look. See [Spring profile: production is blank, demo is `local`](#spring-profile-production-is-blank-demo-is-local) - it also covers what to do when a VM that once ran `local` fails Flyway validation on startup.

**Optional: ENTSO-E as the day-ahead price source.**
The `market-data` collector defaults to the keyless energy-charts.info API (`MARKET_DATA_SOURCE=energy-charts`), so prices flow with no secret.
To fetch from the official ENTSO-E Transparency Platform instead, set **both** `MARKET_DATA_SOURCE=entsoe` and `ENTSOE_SECURITY_TOKEN=<your token>` in the VPS `.env`, then recreate the collector: `docker compose -f docker-compose.prod.yml up -d market-data`.
Setting only the token has no effect - the source stays energy-charts until `MARKET_DATA_SOURCE` is flipped; switching back is the same edit in reverse, no code change or image rebuild either way.

**Optional: Marktstammdatenregister (MaStR) credentials.**
`MASTR_API_KEY` and `MASTR_MARKTAKTEUR_NUMMER` may stay blank: the portal's "Anlage verknüpfen" step then uses the keyless public MaStR JSON backend, which is fine to launch with.
To promote lookups to the official BNetzA SOAP webservice, do the one-time free registration (MaStR account -> register the company as Marktakteur -> create a **Webdienstnutzer**, which yields the Webdienst-Schlüssel), fill both variables and `docker compose up -d api` - the api picks the source per config, no code change or image rebuild.
Handle the key like `ENTSOE_SECURITY_TOKEN`: env only, never committed.

### 3. Device mTLS material (staged once on the VPS)

The EMQX service bind-mounts the broker cert/key + device CA from `/srv/docker/voltpilot/infra/mqtt/certs/`.
These keys are **never** in the repo or the images - stage them on the VPS before the first `up`:

```bash
# On the machine that holds the CA (see docs/security-mqtt.md).
# --domain is the name devices dial - recommended: a dedicated MQTT subdomain
# with a plain DNS A record to the VPS (the IP in the SAN stays a fallback):
./tools/pki/voltpilot-ca.sh init-ca --domain mqtt.example.com --ip <vps-public-ip>

# Copy the broker material to the VPS deploy dir:
scp tools/pki/out/server/{server.crt,server.key,device-ca.crt} \
    ${DEPLOY_USER}@${DEPLOY_HOST}:/srv/docker/voltpilot/infra/mqtt/certs/
# optional CRL for revocation:
scp tools/pki/out/ca/crl.pem ${DEPLOY_USER}@${DEPLOY_HOST}:/srv/docker/voltpilot/infra/mqtt/certs/
# scp preserves the source 0600 on server.key; emqx (uid 1000 in the container)
# must be able to read it or the broker fails boot (see step 3). The CI deploy
# workflows chmod this automatically; when staging by hand, do it too:
ssh ${DEPLOY_USER}@${DEPLOY_HOST} \
    'chmod 0755 /srv/docker/voltpilot/infra/mqtt/certs && \
     chmod 0644 /srv/docker/voltpilot/infra/mqtt/certs/*.crt \
                /srv/docker/voltpilot/infra/mqtt/certs/*.pem \
                /srv/docker/voltpilot/infra/mqtt/certs/server.key'
```

The deploy workflow ships the committed `infra/mqtt/acl/acl.conf` and the `infra/prod/**` bootstrap for you; only the private certs are manual.
It never plainly overwrites the deployed ACL: the base rules come from the repo, while the per-device grant blocks between the anchors are runtime state (api enrollment issuance, `voltpilot-ca.sh issue`) and are preserved by `tools/pki/merge-acl-grants.sh`; afterwards it reloads the broker authorizer so the merged rules apply.

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

### Do not let the external proxy cache HTML

The portal's cache policy lives in `frontend/portal/nginx.conf`: hashed `/assets/*` are `immutable`, `index.html` (and every SPA fallback route) is `no-cache` = must be revalidated on every request.
A caching layer in front of it that stores HTML would defeat that and bring back the symptom the policy fixes: after a deploy, a reload renders the PREVIOUS version of the whole app (the stale `index.html` still points at the old bundles).
So keep the upstream proxy a pure pass-through for HTML - the plain `reverse_proxy` above and NPM's default proxy-host template both are; in NPM specifically, do **not** enable "Cache Assets" for this host.
If a CDN/proxy is added later, configure it to honour origin `Cache-Control` (then `no-cache` HTML is already correct there) and verify with the `curl -I` checks in `frontend/portal/test/cache-smoke.sh`.

## Firewall

On the VPS:

- **Allow `8883/tcp` from anywhere** - remote devices need it.
- **Allow `APP_PORT/tcp` only from the Caddy host** - it is plain HTTP; nothing else should reach it.
- **Block everything else** inbound: `1883`, `8083`, `18083` (EMQX), `9092`/`9644` (Redpanda), `5432` (Postgres), and the internal service ports.
  The compose file already binds `1883`/`18083` to loopback and publishes no other host ports, but the firewall is the real guarantee.

Reach the EMQX dashboard via an SSH tunnel to `127.0.0.1:18083`, never publicly.
The full checklist is in [`security-mqtt.md`](security-mqtt.md#hardening-checklist-production).

## How devices reach 8883

Unchanged from the secure-broker design: a device makes an **outbound-only** mutual-TLS connection to `mqtt.<domain>:8883` (the dedicated MQTT subdomain, a plain DNS A record to the server; the raw IP works as fallback since both are in the server cert SAN) with a client cert issued by `tools/pki/voltpilot-ca.sh`.
The cert CN carries the `device_id`; EMQX binds identity from the cert and the per-device ACL confines it to `ems/{tenant}/{site}/{device}/#`.
Issue + hand out certs with the provisioning flow in [`connect-a-device.md`](connect-a-device.md); revoke with `voltpilot-ca.sh revoke` + `tools/pki/reload-broker-authz.sh`.

## Spring profile: production is blank, demo is `local`

**Production runs with a BLANK `SPRING_PROFILES_ACTIVE`** (the default in `.env.prod.example` and `docker-compose.prod.yml`).
Then only `db/migration` (the prod-safe core schema) runs, and no demo tenants or telemetry ever land on the database.

Set `SPRING_PROFILES_ACTIVE=local` **only** for a throwaway internal/demo VM.
`local` additionally runs the DEV-ONLY seed migrations in `db/dev` (two demo tenants, the demo fleet + earnings history, and the `demo`/`demo2` realm users).

### Deploys self-heal a `db/dev` checksum drift (no manual step)

Flyway records the checksum of every applied migration in `flyway_schema_history` and, by default, aborts startup if a recorded migration either changed checksum or is no longer present on the classpath.
That produced two recurring outages on the captain's `local` VM:

- **Editing an already-applied `db/dev` migration** (e.g. the FK existence-guard hotfixes to `V20260706020000` / `V20260706030000`) changed its checksum → `Migration checksum mismatch` → the api refused to start.
- **Switching a `local` VM back to a blank profile** dropped `db/dev` off the classpath while those migrations stayed in `flyway_schema_history` → `detected applied migration not resolved locally` → the api refused to start.

Two mechanisms now fix this, and **neither needs a human at the database**:

1. **Self-healing migration on startup (primary).** The api ships a `FlywayMigrationStrategy` (`SelfHealingFlywayMigrationStrategy`) that keeps STRICT validation on the happy path but reacts to a validation failure instead of crash-looping: it logs a loud `WARN` naming the drifted versions, runs `flyway repair()` to realign the recorded checksums to the shipped migrations (no migration is re-executed - the schema is already in that state), and retries `migrate()` once.
   So simply deploying the new image boots the captain's **existing `local` VM** cleanly even though its dev-seed rows carry the old pre-hotfix checksums - the drift heals itself.
   The catch is narrow: only a Flyway *validation* failure triggers a repair. A genuinely broken migration (a SQL error while applying) is a different exception, is not caught, and still fails the boot.
2. **`spring.flyway.ignore-migration-patterns: "*:missing"` (hygiene).** Tolerates *applied-but-now-absent* migrations, scoped to `:missing` only - so a VM that once ran `local` and is moved to the blank production profile boots cleanly (the off-classpath `db/dev` rows are ignored) without even needing a repair. It does **not** loosen checksum validation, so at the pure-Flyway-config level a real edit of an on-classpath migration is still flagged (the self-healing strategy is what then repairs it, loudly).

**Residual risk (accepted):** because `repair()` realigns checksums to whatever ships, an accidental edit of an already-applied **core** (`db/migration`) migration would be accepted with only the logged `WARN`, not blocked.
The mitigation is unchanged discipline - **never edit an already-applied migration** (see AGENTS.md) plus code review - and the `WARN` names the versions, so an unexpected *core* version appearing in the deploy log is the signal to investigate.
Fresh CI/Testcontainers DBs have no prior history, so they never drift and always run a plain strict migrate.

**Forward-looking cleanup:** moving the VM to the blank production profile (`SPRING_PROFILES_ACTIVE=` in `.env`, then `docker compose -f docker-compose.prod.yml up -d --force-recreate api`) stops it running the dev seeds at all, so there is eventually no dev-seed drift left to heal. The already-seeded demo rows stay in the DB (blank does not delete them - see the launch cleanup below).

### Break-glass: manual repair (should not be needed)

The self-healing strategy above makes this unnecessary, but if you ever need to realign a recorded checksum by hand (e.g. the strategy is disabled, or you are on an older image), the manual equivalent of what `repair()` does is a direct `UPDATE`.
The mismatch error prints the value Flyway computed locally (`resolved locally: <n>`); write it straight into the history row:

```bash
# <version> and <resolved-locally-checksum> come from the mismatch error, e.g.
# "Migration checksum mismatch for migration version 20260706020000
#  -> Applied to database : 111111111
#  -> Resolved locally    : 222222222"
docker compose -f docker-compose.prod.yml exec timescaledb \
  psql -U voltpilot -d voltpilot -c \
  "UPDATE flyway_schema_history SET checksum = <resolved-locally-checksum> WHERE version = '<version>';"
```

Then restart the api. As normal practice you **never edit an already-applied migration** (see AGENTS.md).

## Automationen (Flow-Aktivierung) - was der Schalter tut und wie man ihn zurücknimmt

Seit dem Portal-v3-Release **steuern kundengebaute Automationen wirklich Geräte**: Der Kunde baut
eine Regel im Portal, sie wird über den `flowc`-Sidecar zu einem Flow-Artefakt kompiliert und
retained auf `ems/{t}/{s}/{d}/v2/flows` an sein Edge-Gerät ausgerollt.

**Das Sicherheitsnetz ist strukturell, nicht prozedural.** Ein Flow kann immer nur einen **Wunsch**
äußern (`vp-desired`); die Arbitrierung auf dem Gerät bestimmt den Halter, und die **Guard-Kette**
begrenzt jeden Befehl, bevor ein Register geschrieben wird: § 14a-Hüllkurve in beide Richtungen,
EEG-Solarladen, Leistungsband des Wechselrichters, SoC-Fenster, Rate-Limit. Genau deshalb stehen
Guard-Kette und Arbitrierung auf der Do-not-touch-Liste - eine Klemme wegzuoptimieren, damit eine
Demo „schöner" läuft, ist der eine Fehler, den man hier nicht machen darf.

| Schalter | Wo | Wirkung |
|---|---|---|
| `VOLTPILOT_FLOWS_ACTIVATION_ENABLED` | api-Service, `docker-compose.prod.yml` (Default **true**), überschreibbar in `.env` | **false** = jede NEUE Aktivierung wird mit `activation_disabled` abgelehnt. |
| `POST /api/v1/sites/{siteId}/flows/{flowId}/deactivate` | Portal / API | Stilllegen EINER laufenden Regel: die aktive Version wird zurückgezogen und das kleinere Deployment-Set neu veröffentlicht. **Bewusst NICHT** vom Flag oben abhängig. |

**Wichtig - der Flag-Flip nimmt nichts zurück, was schon läuft.** Bereits ausgerollte Artefakte
liegen *retained* auf `…/v2/flows` und laufen weiter, auch nachdem das Flag auf `false` steht. Der
Hebel, der eine LAUFENDE Regel wirklich stoppt, ist `deactivate`. Beide Hebel gehören in die
Generalprobe (siehe `docs/portal-v3/BUILD.md` §6/§7), nicht in den Störfall.

Zusätzlich pro Anlage: gated Strategie-Bausteine (Markt, Lastspitzenkappung, atyp. Netznutzung)
bleiben freischaltpflichtig - der Kunde öffnet sie über den Modus-Profil-Schalter (M3), der
serverseitig genau die Bausteine dieses Profils freigibt; die Aktivierung prüft das erneut.

## Going to a real production launch

Before serving real customers (on a VM that was demoed with `local`, or a fresh one):

- Confirm `SPRING_PROFILES_ACTIVE=` (blank) in `.env` so the api does **not** seed demo tenants/telemetry (the production default; see [the profile section](#spring-profile-production-is-blank-demo-is-local)).
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
