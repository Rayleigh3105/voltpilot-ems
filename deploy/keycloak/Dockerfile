# syntax=docker/dockerfile:1
# VoltPilot Keycloak: the upstream image with the PRODUCTION realm import and
# the VoltPilot login theme BAKED IN, pre-built (`kc.sh build`).
#
# Why this image exists
# --------------------
# `docker-compose.prod.yml` bind-mounts both artifacts into the stock upstream
# image. Kubernetes cannot supply them the same way (a theme is ~8 files across
# nested directories - a ConfigMap is the wrong tool, and the login theme is
# customer-facing, so "no theme" is not an option), so the k8s Deployment pulls
# THIS image instead. See the GitOps repo's
# apps/voltpilot/base/keycloak/deployment.yaml.
#
# It also removes the compose `--force-recreate keycloak` hack: in `start` mode
# Keycloak caches + pre-gzips themes onto the container FS at boot, and that
# cache survives a plain restart - so a changed bind-mounted theme kept serving
# the OLD CSS to gzip-capable browsers. An immutable image is replaced, never
# restarted in place, so the cache can never go stale against its own theme.
#
# Build context is the REPO ROOT (like services/optimization/Dockerfile): the
# two inputs live in different directories, so both must be visible.
#   docker build -f deploy/keycloak/Dockerfile \
#     -t git.tecmaxx.de/mamotec/voltpilot-ems/keycloak:latest .
#
# The version MUST stay in lockstep with the `keycloak` service in
# docker-compose.prod.yml and infra/local/keycloak (dev realm) - see
# deploy/keycloak/README.md.
ARG KEYCLOAK_VERSION=26.0.5

# ---------------------------------------------------------------------------
# Builder: augment Quarkus with the BUILD-time options, so the runtime starts
# with `--optimized` and skips the ~30 s config build on every boot.
# ---------------------------------------------------------------------------
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION} AS builder

# These three are Keycloak BUILD options and are therefore persisted into the
# image by `kc.sh build`. They must match what the runtime env supplies
# (docker-compose.prod.yml keycloak service / the GitOps keycloak.env), or a
# `start --optimized` refuses to boot. Everything host- or secret-specific
# (KC_DB_URL/USERNAME/PASSWORD, KC_HOSTNAME, KC_PROXY_HEADERS, the realm's
# VP_* placeholders) stays a RUNTIME value and is never baked.
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_HTTP_RELATIVE_PATH=/auth

# Login theme (referenced by the realm's `loginTheme: voltpilot`) and the
# production realm import. --chown=1000:0 mirrors the base image's ownership
# (uid 1000, group root) so the non-root Keycloak user reads them under an
# arbitrary-uid runtime too. Only the realm JSON is copied - Keycloak scans
# /opt/keycloak/data/import for *.json, and the directory's README.md has no
# business inside an image.
COPY --chown=1000:0 deploy/keycloak/themes/voltpilot /opt/keycloak/themes/voltpilot
COPY --chown=1000:0 infra/prod/keycloak/voltpilot-realm.json /opt/keycloak/data/import/voltpilot-realm.json

RUN /opt/keycloak/bin/kc.sh build

# ---------------------------------------------------------------------------
# Runtime: the stock image plus the augmented /opt/keycloak (which carries the
# theme and the realm import along, they live inside that tree).
# ---------------------------------------------------------------------------
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}

COPY --from=builder /opt/keycloak/ /opt/keycloak/

# No HEALTHCHECK on purpose: the base image ships neither curl nor wget, and
# both orchestrators already define their own probe against the MANAGEMENT port
# 9000 (compose: a /dev/tcp shell check; k8s: startup/liveness/readiness
# httpGet on /auth/health/*). One health definition per deployment, not two.
#
# ENTRYPOINT (/opt/keycloak/bin/kc.sh) is inherited from the base image, so the
# usual `command:` / `args:` forms keep working unchanged. This CMD is only the
# standalone default - compose currently overrides it with the un-optimized
# `start --import-realm`, which stays correct here (identical build options =
# no re-augmentation).
CMD ["start", "--optimized", "--import-realm"]
