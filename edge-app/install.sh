#!/usr/bin/env bash
#
# VoltPilot Edge-App - standalone guided installer for a NEW edge device.
#
# This is the ONLY file that needs to be on the device. It WRITES its own
# docker-compose.yml (real mode: core + nodered pulled from the registry, NO
# build contexts, NO simulator) plus the .env into the current directory, then
# runs the manual DEPLOY.md flow as a guided, idempotent install: prerequisite
# checks, registry login, .env creation, pull + up, Reference-ID display +
# portal-claim guidance, and honest connection verification. No repo clone
# required - hand a technician just this script.
#
# The generated compose mirrors the repo's real-mode services (image names,
# env wiring, volumes, ports) so a pulled stack behaves identically to a
# repo-based `docker compose up -d`. If the repo compose's real-mode
# image refs / env / volumes change, update generate_compose() below to match.
#
# Safe to re-run: it reconfigures / pulls the latest images / brings the stack
# back up with `up -d`. It NEVER destroys the device's data volumes
# (vp-edge-data / vp-nodered-data) or its established identity, and it never
# silently clobbers a hand-edited docker-compose.yml.
#
# Usage: ./install.sh [--help]   (writes compose + .env into the current dir)
#
set -euo pipefail

# --------------------------------------------------------------------------
# Constants + defaults (mirrored from .env.example; production endpoints per
# the captain's decision).
# --------------------------------------------------------------------------
readonly REGISTRY="git.tecmaxx.de"
readonly PORTAL_URL="https://portal.voltpilot.de"

# Registry image repositories for the generated compose (real mode only, no
# build). Keep in lockstep with edge-app/docker-compose.yml's real-mode
# services. The concrete VERSION is a runtime lever, not baked in here:
# VP_EDGE_IMAGE_TAG pins both images to one tag (default 'latest' = today's
# behaviour), VP_EDGE_CORE_IMAGE / VP_EDGE_NODERED_IMAGE override the full ref
# (that is how a digest pin - the clean per-device rollback - is expressed).
readonly CORE_REPO="git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core"
readonly NODERED_REPO="git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered"
readonly DEF_VP_EDGE_IMAGE_TAG="latest"
# Marker on the first line of a compose file WE generated, so a re-run can tell
# our file apart from a hand-edited one and never clobbers a foreign file.
readonly COMPOSE_MARKER="# @voltpilot-edge-install: generated docker-compose.yml (do not hand-edit; re-run install.sh --reconfigure)"

readonly DEF_VP_PORTAL_BASE_URL="https://portal.voltpilot.de"
readonly DEF_VP_MQTT_HOST="mqtt.voltpilot.de"
readonly DEF_VP_MQTT_PORT="8883"
readonly DEF_VP_REF=""
readonly DEF_VP_MAX_CHARGE_KW="50"
readonly DEF_VP_MAX_DISCHARGE_KW="50"
readonly DEF_VP_SOC_MIN_PCT="5"
readonly DEF_VP_SOC_MAX_PCT="95"
readonly DEF_VP_BUFFER_HOURS="48"
readonly DEF_VP_WEB_PORT="8484"
readonly DEF_VP_NODERED_PORT="1881"
readonly DEF_VP_BUS_PORT="1884"
readonly DEF_VP_NODERED_USER="voltpilot"
readonly INSECURE_NODERED_PASSWORD="voltpilot"

# The dev-only escape hatches. The installer NEVER sets these; it only warns
# if a kept .env carries them.
readonly DEV_HATCHES="VP_DEV_TENANT_ID VP_DEV_SITE_ID VP_DEV_DEVICE_ID VP_DEV_CLOUD_URL"

# Runtime flags.
NON_INTERACTIVE=0
FORCE_RECONFIGURE=0
FORCE_COMPOSE=0
SKIP_PULL=0
DRY_RUN=0
PRINT_COMPOSE=0

# --------------------------------------------------------------------------
# Output helpers (color only on a TTY).
# --------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''
fi

step()  { printf '\n%s==> %s%s\n' "${C_BOLD}${C_BLUE}" "$*" "${C_RESET}"; }
info()  { printf '    %s\n' "$*"; }
ok()    { printf '    %s✓%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn()  { printf '    %s! %s%s\n' "${C_YELLOW}" "$*" "${C_RESET}"; }
err()   { printf '    %s✗ %s%s\n' "${C_RED}" "$*" "${C_RESET}" >&2; }
die()   { err "$*"; printf '\n%sInstallation abgebrochen.%s\n' "${C_RED}" "${C_RESET}" >&2; exit 1; }

usage() {
  cat <<EOF
${C_BOLD}VoltPilot Edge-App - eigenständiger Installer${C_RESET}

Die einzige Datei, die auf dem Gerät liegen muss: sie SCHREIBT ihre eigene
docker-compose.yml und die .env in das aktuelle Verzeichnis und richtet ein
NEUES Edge-Gerät gegen die VoltPilot-Live-Cloud ein - prüft die
Voraussetzungen, meldet an der Image-Registry an, erstellt die .env,
zieht die Images, startet ${C_BOLD}core + nodered${C_RESET} (echter Wechselrichter, KEIN Simulator),
zeigt die Referenz-ID an und verifiziert die Anbindung. Kein Repo-Klon nötig.

Die erzeugte docker-compose.yml nutzt ausschließlich vorgefertigte
Registry-Images (${C_BOLD}pull_policy: always${C_RESET}, kein lokaler Build, kein Simulator).

Mehrfaches Ausführen ist sicher: es konfiguriert neu / zieht die neuesten Images
/ startet erneut mit 'up -d' und löscht dabei NIE die Datenvolumes
(vp-edge-data / vp-nodered-data) oder die Geräteidentität. Eine bestehende,
selbst erzeugte docker-compose.yml wird aktualisiert; eine ${C_BOLD}handbearbeitete${C_RESET}
docker-compose.yml wird nie ohne Rückfrage überschrieben.

${C_BOLD}Aufruf:${C_RESET}
  ./install.sh [Optionen]      (schreibt compose + .env ins aktuelle Verzeichnis)

${C_BOLD}Optionen:${C_RESET}
  -h, --help           Diese Hilfe anzeigen und beenden.
      --non-interactive
                       Keine Rückfragen; Werte aus der Umgebung / bestehenden
                       .env / Standardwerten übernehmen. Erfordert ein
                       gesetztes, nicht-Standard VP_NODERED_PASSWORD.
      --reconfigure    Die .env UND die docker-compose.yml neu erstellen, auch
                       wenn sie schon existieren.
      --force-compose  Nur die docker-compose.yml neu erzeugen (auch eine
                       handbearbeitete wird überschrieben), .env bleibt.
      --print-compose  Die erzeugte docker-compose.yml nach stdout schreiben und
                       beenden (schreibt nichts, prüft nichts). Nützlich zum
                       Prüfen / Ableiten der Datei.
      --skip-pull      'docker compose pull' überspringen (nur 'up -d').
      --dry-run        Nur prüfen: Voraussetzungen + 'docker compose config'
                       gegen die erzeugte Compose-Datei (temporär). Kein Login,
                       kein Pull, kein Start, keine Änderung an compose/.env.

${C_BOLD}Umgebungsvariablen${C_RESET} (für --non-interactive; überschreiben die Standardwerte):
  VP_PORTAL_BASE_URL VP_MQTT_HOST VP_MQTT_PORT VP_REF
  VP_MAX_CHARGE_KW VP_MAX_DISCHARGE_KW VP_SOC_MIN_PCT VP_SOC_MAX_PCT
  VP_BUFFER_HOURS VP_WEB_PORT VP_NODERED_PORT VP_BUS_PORT
  VP_NODERED_USER VP_NODERED_PASSWORD

${C_BOLD}Image-Version${C_RESET} (Rollback-Hebel, optional; ungesetzt = 'latest' wie bisher):
  VP_EDGE_IMAGE_TAG      beide Images auf EINEN Tag festnageln
  VP_EDGE_CORE_IMAGE     vollständige Referenz für core (z. B. Digest-Pin)
  VP_EDGE_NODERED_IMAGE  vollständige Referenz für nodered
Bequemer gesetzt/gelöst per ./update.sh --tag <tag> / --core-image <ref> / --latest.
Bestehende Werte in der .env bleiben auch bei --reconfigure erhalten.

Die Entwicklungs-Schalter VP_DEV_* werden vom Installer NIE gesetzt.
EOF
}

# --------------------------------------------------------------------------
# Argument parsing.
# --------------------------------------------------------------------------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      --non-interactive) NON_INTERACTIVE=1 ;;
      --reconfigure) FORCE_RECONFIGURE=1; FORCE_COMPOSE=1 ;;
      --force-compose) FORCE_COMPOSE=1 ;;
      --print-compose) PRINT_COMPOSE=1 ;;
      --skip-pull) SKIP_PULL=1 ;;
      --dry-run) DRY_RUN=1 ;;
      *) err "Unbekannte Option: $1"; echo; usage; exit 2 ;;
    esac
    shift
  done
}

# --------------------------------------------------------------------------
# docker compose wrapper (v2 plugin form only). Pins the generated compose
# file + project directory (= the target dir) so it works regardless of CWD
# and always loads the target dir's .env.
# --------------------------------------------------------------------------
dc() { docker compose --project-directory "$TARGET_DIR" -f "$COMPOSE_FILE" "$@"; }

# --------------------------------------------------------------------------
# Prompt with a default; honors --non-interactive (uses env/default silently).
# Sets the named variable.
# --------------------------------------------------------------------------
prompt_default() {
  local varname="$1" label="$2" default="$3" reply
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    # In non-interactive mode a same-named env var (if exported) wins over the
    # default; otherwise the default is used.
    printf -v "$varname" '%s' "${!varname:-$default}"
    return
  fi
  if [ -n "$default" ]; then
    read -rp "    ${label} [${C_DIM}${default}${C_RESET}]: " reply || reply=""
    printf -v "$varname" '%s' "${reply:-$default}"
  else
    read -rp "    ${label} [${C_DIM}leer${C_RESET}]: " reply || reply=""
    printf -v "$varname" '%s' "${reply}"
  fi
}

# Read a secret without echoing it. Sets the named variable.
prompt_secret() {
  local varname="$1" label="$2" reply
  read -rsp "    ${label}: " reply || reply=""
  echo
  printf -v "$varname" '%s' "${reply}"
}

# --------------------------------------------------------------------------
# Detect a usable LAN IP for the web-app URL. Degrades to a placeholder.
# --------------------------------------------------------------------------
detect_lan_ip() {
  local ip=""
  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -vE '^127\.' | head -n1 || true)"
  fi
  if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -n1 || true)"
  fi
  if [ -z "$ip" ] && command -v ipconfig >/dev/null 2>&1; then
    # macOS fallback (dev machine).
    ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  fi
  printf '%s' "${ip:-<geraet-ip>}"
}

# --------------------------------------------------------------------------
# Extract a flat JSON string/bare value by key (portable; no jq required).
# --------------------------------------------------------------------------
json_field() {
  local json="$1" key="$2"
  printf '%s' "$json" \
    | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" \
    | head -n1
}

# =========================================================================
# STEP 1 - Prerequisites.
# =========================================================================
check_prerequisites() {
  step "1/7  Voraussetzungen prüfen"
  local os; os="$(uname -s 2>/dev/null || echo unknown)"

  if ! command -v docker >/dev/null 2>&1; then
    err "Docker ist nicht installiert."
    case "$os" in
      Linux)
        info "Installieren (Debian/Ubuntu):"
        info "  ${C_CYAN}curl -fsSL https://get.docker.com | sh${C_RESET}"
        info "  (danach ggf. den Benutzer zur 'docker'-Gruppe hinzufügen und neu anmelden)" ;;
      Darwin) info "Installieren: Docker Desktop von https://www.docker.com/products/docker-desktop/" ;;
      *)      info "Docker installieren: https://docs.docker.com/engine/install/" ;;
    esac
    die "Docker fehlt."
  fi
  ok "docker gefunden ($(docker --version 2>/dev/null | head -n1))"

  if ! docker compose version >/dev/null 2>&1; then
    err "Das Docker-Compose-Plugin (v2) fehlt."
    info "'docker compose' (mit Leerzeichen) muss verfügbar sein - das alte"
    info "'docker-compose' (v1) wird nicht unterstützt."
    case "$os" in
      Linux) info "Installieren (Debian/Ubuntu): ${C_CYAN}sudo apt-get install docker-compose-plugin${C_RESET}" ;;
      *)     info "Siehe https://docs.docker.com/compose/install/" ;;
    esac
    die "docker compose (v2) fehlt."
  fi
  ok "docker compose gefunden ($(dc version --short 2>/dev/null || echo v2))"

  if ! docker info >/dev/null 2>&1; then
    err "Der Docker-Daemon läuft nicht oder ist für diesen Benutzer nicht erreichbar."
    case "$os" in
      Linux)
        info "Starten: ${C_CYAN}sudo systemctl start docker${C_RESET}"
        info "Ohne sudo nutzen: ${C_CYAN}sudo usermod -aG docker \"\$USER\"${C_RESET} (danach neu anmelden)" ;;
      Darwin) info "Docker Desktop starten und warten, bis es 'running' zeigt." ;;
    esac
    die "Docker-Daemon nicht erreichbar."
  fi
  ok "Docker-Daemon läuft"
}

# =========================================================================
# STEP 2 - Registry login.
# =========================================================================
registry_config_has_auth() {
  # Best-effort detection: the registry host appears in ~/.docker/config.json
  # (either an inline auth entry or a credential-helper mapping).
  local cfg="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
  [ -f "$cfg" ] && grep -q "$REGISTRY" "$cfg" 2>/dev/null
}

check_registry_login() {
  step "2/7  An der Image-Registry (${REGISTRY}) anmelden"
  if [ "$DRY_RUN" -eq 1 ]; then
    if registry_config_has_auth; then
      ok "Ein Anmelde-Eintrag für ${REGISTRY} ist vorhanden (Dry-Run: nicht verifiziert)."
    else
      warn "Kein Anmelde-Eintrag für ${REGISTRY} gefunden (Dry-Run: kein Login durchgeführt)."
    fi
    return
  fi

  if registry_config_has_auth; then
    ok "Anmeldung an ${REGISTRY} vorhanden (wird beim Pull final verifiziert)."
    return
  fi

  warn "Noch nicht an ${REGISTRY} angemeldet."
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    die "Nicht angemeldet und --non-interactive gesetzt. Vorab ausführen: docker login ${REGISTRY}"
  fi
  info "Melde dich jetzt mit den von VoltPilot bereitgestellten Zugangsdaten an."
  info "(Das Passwort wird von 'docker login' abgefragt und nie angezeigt.)"
  local attempts=0
  while ! docker login "$REGISTRY"; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 3 ]; then
      die "Anmeldung an ${REGISTRY} fehlgeschlagen (3 Versuche)."
    fi
    warn "Anmeldung fehlgeschlagen - bitte erneut versuchen."
  done
  ok "An ${REGISTRY} angemeldet."
}

# =========================================================================
# STEP 3 - Generate docker-compose.yml (images only, REAL mode).
# =========================================================================

# Emit the standalone compose YAML to stdout. Mirrors the real-mode services
# of edge-app/docker-compose.yml EXACTLY (image names, env var names +
# defaults, volume names, port mappings) MINUS the build: contexts and the
# sim profile - a device only ever pulls prebuilt images. Keep in lockstep
# with edge-app/docker-compose.yml.
generate_compose() {
  cat <<EOF
${COMPOSE_MARKER}
#
# VoltPilot Edge-App - eigenständige docker-compose.yml, erzeugt von install.sh.
# Echter Betrieb: NUR vorgefertigte Registry-Images (kein lokaler Build), NUR
# core + nodered (kein Simulator). Behandelt sich wie ein Repo-basiertes
# 'docker compose up -d' im echten Modus.
#
# Neu erzeugen (z. B. nach einem Installer-Update):
#   ./install.sh --force-compose      (nur diese Datei)
#   ./install.sh --reconfigure        (diese Datei + .env)
#
# Die Datenvolumes (vp-edge-data / vp-nodered-data) bleiben dabei unberührt.
#
# Image-Version (Rollback-Hebel, alles optional - ungesetzt = :latest wie
# bisher). In der .env setzen oder per ./update.sh:
#   VP_EDGE_IMAGE_TAG      beide Images auf EINEN Tag festnageln (z. B. ein
#                          Commit-SHA)             -> ./update.sh --tag <tag>
#   VP_EDGE_CORE_IMAGE     vollständige Referenz für core, z. B. ein
#                          Digest-Pin repo@sha256:...
#                                                  -> ./update.sh --core-image <ref>
#   VP_EDGE_NODERED_IMAGE  dito für nodered        -> ./update.sh --nodered-image <ref>

name: voltpilot-edge

services:
  core:
    image: \${VP_EDGE_CORE_IMAGE:-${CORE_REPO}:\${VP_EDGE_IMAGE_TAG:-latest}}
    pull_policy: always
    restart: unless-stopped
    environment:
      VP_PORTAL_BASE_URL: \${VP_PORTAL_BASE_URL:-https://portal.voltpilot.de}
      VP_MQTT_HOST: \${VP_MQTT_HOST:-mqtt.voltpilot.de}
      VP_MQTT_PORT: \${VP_MQTT_PORT:-8883}
      VP_REF: \${VP_REF:-}
      VP_MAX_CHARGE_KW: \${VP_MAX_CHARGE_KW:-50}
      VP_MAX_DISCHARGE_KW: \${VP_MAX_DISCHARGE_KW:-50}
      VP_SOC_MIN_PCT: \${VP_SOC_MIN_PCT:-5}
      VP_SOC_MAX_PCT: \${VP_SOC_MAX_PCT:-95}
      VP_BUFFER_HOURS: \${VP_BUFFER_HOURS:-48}
      # Dev-only escape hatches (skip enrollment / plain-MQTT cloud). Leave
      # EMPTY on customer devices - the installer never sets them.
      VP_DEV_TENANT_ID: \${VP_DEV_TENANT_ID:-}
      VP_DEV_SITE_ID: \${VP_DEV_SITE_ID:-}
      VP_DEV_DEVICE_ID: \${VP_DEV_DEVICE_ID:-}
      VP_DEV_CLOUD_URL: \${VP_DEV_CLOUD_URL:-}
    volumes:
      - vp-edge-data:/data
    ports:
      # Local device web app (LAN): http://<geraet>:8484
      - "\${VP_WEB_PORT:-8484}:8484"
      # Embedded local MQTT bus, host-loopback only (debugging; Layer 1
      # reaches it via the compose network as core:1883).
      - "127.0.0.1:\${VP_BUS_PORT:-1884}:1883"

  nodered:
    image: \${VP_EDGE_NODERED_IMAGE:-${NODERED_REPO}:\${VP_EDGE_IMAGE_TAG:-latest}}
    pull_policy: always
    restart: unless-stopped
    depends_on:
      - core
    environment:
      VP_NODERED_USER: \${VP_NODERED_USER:-voltpilot}
      # Kein Standard-Passwort (fail closed): unset/'voltpilot' verweigert
      # settings.js den Editor-Start. Wert in der .env setzen (install.sh).
      VP_NODERED_PASSWORD: \${VP_NODERED_PASSWORD:-}
    volumes:
      # Named volume so per-customer flow wiring survives container
      # recreation; seeded from the image (template flows) on first run.
      - vp-nodered-data:/data
    ports:
      # Node-RED editor (LAN, behind adminAuth): the VoltPilot service
      # access for per-customer flow wiring. NOT for customers.
      - "\${VP_NODERED_PORT:-1881}:1880"

volumes:
  vp-edge-data:
  vp-nodered-data:
EOF
}

# True if the file exists and carries OUR generated marker on its first line.
compose_is_ours() {
  local file="$1"
  [ -f "$file" ] && IFS= read -r first < "$file" 2>/dev/null && [ "$first" = "$COMPOSE_MARKER" ]
}

# Write the compose atomically (never touches data volumes).
write_compose_file() {
  local tmp; tmp="$(mktemp "${TARGET_DIR}/.docker-compose.yml.XXXXXX")"
  generate_compose > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$COMPOSE_FILE"
}

generate_compose_step() {
  step "3/7  docker-compose.yml erzeugen (nur Images, echter Modus)"

  if [ "$DRY_RUN" -eq 1 ]; then
    warn "Dry-Run: docker-compose.yml wird NICHT geschrieben (Konfiguration wird temporär geprüft)."
    return
  fi

  if [ ! -f "$COMPOSE_FILE" ]; then
    write_compose_file
    ok "docker-compose.yml erzeugt (core + nodered, Registry-Images, kein Simulator)."
    return
  fi

  # A file already exists.
  if compose_is_ours "$COMPOSE_FILE"; then
    # It is one we generated - safe to refresh so image refs/wiring stay in
    # lockstep. Data volumes are never touched by rewriting this file.
    write_compose_file
    ok "Bestehende (vom Installer erzeugte) docker-compose.yml aktualisiert."
    return
  fi

  # Foreign / hand-edited file: never clobber silently.
  if [ "$FORCE_COMPOSE" -eq 1 ]; then
    write_compose_file
    warn "Vorhandene, NICHT vom Installer erzeugte docker-compose.yml überschrieben (--force-compose/--reconfigure)."
    return
  fi

  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    ok "Bestehende docker-compose.yml wird beibehalten (--non-interactive; --force-compose zum Überschreiben)."
    return
  fi

  warn "Es existiert bereits eine docker-compose.yml, die NICHT vom Installer stammt (evtl. handbearbeitet)."
  local choice=""
  read -rp "    Beibehalten [B] oder mit der Installer-Version überschreiben [Ü]? [${C_DIM}B${C_RESET}]: " choice || choice=""
  case "${choice:-B}" in
    [ÜüUu]*)
      write_compose_file
      warn "docker-compose.yml mit der Installer-Version überschrieben." ;;
    *)
      ok "Bestehende docker-compose.yml wird beibehalten." ;;
  esac
}

# =========================================================================
# STEP 4 - Configure .env.
# =========================================================================

# Read a KEY=value from an existing .env (uncommented lines only).
env_get() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^${key}=\(.*\)$/\1/p" "$file" | tail -n1
}

warn_dev_hatches() {
  local file="$1" h val found=0
  for h in $DEV_HATCHES; do
    val="$(env_get "$h" "$file")"
    if [ -n "$val" ]; then
      if [ "$found" -eq 0 ]; then
        warn "In der bestehenden .env sind Entwicklungs-Schalter GESETZT - auf einem echten Gerät gefährlich:"
        found=1
      fi
      warn "    ${h}=${val}  <- entfernen/leeren!"
    fi
  done
  [ "$found" -eq 1 ] && warn "Diese VP_DEV_* überspringen das Enrollment / nutzen Klartext-MQTT. Bitte aus der .env entfernen."
  return 0
}

configure_env() {
  step "4/7  Konfiguration (.env)"
  local envfile="$ENV_FILE"

  if [ -f "$envfile" ] && [ "$FORCE_RECONFIGURE" -eq 0 ]; then
    if [ "$NON_INTERACTIVE" -eq 1 ]; then
      ok "Bestehende .env wird beibehalten (--non-interactive, kein --reconfigure)."
      warn_dev_hatches "$envfile"
      return
    fi
    info "Eine .env existiert bereits."
    local choice=""
    read -rp "    Beibehalten [B] oder neu konfigurieren [N]? [${C_DIM}B${C_RESET}]: " choice || choice=""
    case "${choice:-B}" in
      [Nn]*) : ;; # fall through to reconfigure
      *) ok "Bestehende .env wird beibehalten."; warn_dev_hatches "$envfile"; return ;;
    esac
    info "Bestehende Werte werden als Vorgabe genutzt."
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    warn "Dry-Run: .env wird NICHT geschrieben/geändert."
    return
  fi

  # Snapshot any values already in the environment BEFORE we assign the target
  # variables (else the assignment clobbers the incoming env). Precedence:
  #   non-interactive: environment > existing .env > default
  #   interactive:     prompt default = existing .env > environment > default
  local IN_PORTAL="${VP_PORTAL_BASE_URL:-}" IN_MHOST="${VP_MQTT_HOST:-}" IN_MPORT="${VP_MQTT_PORT:-}"
  local IN_REF="${VP_REF:-}" IN_MAXC="${VP_MAX_CHARGE_KW:-}" IN_MAXD="${VP_MAX_DISCHARGE_KW:-}"
  local IN_SMIN="${VP_SOC_MIN_PCT:-}" IN_SMAX="${VP_SOC_MAX_PCT:-}" IN_BUF="${VP_BUFFER_HOURS:-}"
  local IN_WEB="${VP_WEB_PORT:-}" IN_NRP="${VP_NODERED_PORT:-}" IN_BUS="${VP_BUS_PORT:-}"
  local IN_NRU="${VP_NODERED_USER:-}"
  local IN_ITAG="${VP_EDGE_IMAGE_TAG:-}" IN_CIMG="${VP_EDGE_CORE_IMAGE:-}" IN_NIMG="${VP_EDGE_NODERED_IMAGE:-}"

  # seed VAR ENV_SNAPSHOT DEFAULT - resolves the effective value per mode.
  seed() {
    local var="$1" envval="$2" default="$3" fileval
    fileval="$(env_get "$var" "$envfile")"
    if [ "$NON_INTERACTIVE" -eq 1 ]; then
      printf -v "$var" '%s' "${envval:-${fileval:-$default}}"
    else
      printf -v "$var" '%s' "${fileval:-${envval:-$default}}"
    fi
  }
  seed VP_PORTAL_BASE_URL  "$IN_PORTAL" "$DEF_VP_PORTAL_BASE_URL"
  seed VP_MQTT_HOST        "$IN_MHOST"  "$DEF_VP_MQTT_HOST"
  seed VP_MQTT_PORT        "$IN_MPORT"  "$DEF_VP_MQTT_PORT"
  seed VP_REF             "$IN_REF"    "$DEF_VP_REF"
  seed VP_MAX_CHARGE_KW    "$IN_MAXC"   "$DEF_VP_MAX_CHARGE_KW"
  seed VP_MAX_DISCHARGE_KW "$IN_MAXD"   "$DEF_VP_MAX_DISCHARGE_KW"
  seed VP_SOC_MIN_PCT      "$IN_SMIN"   "$DEF_VP_SOC_MIN_PCT"
  seed VP_SOC_MAX_PCT      "$IN_SMAX"   "$DEF_VP_SOC_MAX_PCT"
  seed VP_BUFFER_HOURS     "$IN_BUF"    "$DEF_VP_BUFFER_HOURS"
  seed VP_WEB_PORT         "$IN_WEB"    "$DEF_VP_WEB_PORT"
  seed VP_NODERED_PORT     "$IN_NRP"    "$DEF_VP_NODERED_PORT"
  seed VP_BUS_PORT         "$IN_BUS"    "$DEF_VP_BUS_PORT"
  seed VP_NODERED_USER     "$IN_NRU"    "$DEF_VP_NODERED_USER"
  # Image-Pin: NIE abgefragt (Ops-Hebel, keine Kundeneinstellung), aber immer
  # aus einer bestehenden .env übernommen - ein per update.sh gesetzter Pin
  # darf durch --reconfigure nicht stillschweigend verloren gehen.
  seed VP_EDGE_IMAGE_TAG     "$IN_ITAG" "$DEF_VP_EDGE_IMAGE_TAG"
  seed VP_EDGE_CORE_IMAGE    "$IN_CIMG" ""
  seed VP_EDGE_NODERED_IMAGE "$IN_NIMG" ""
  local existing_pw; existing_pw="$(env_get VP_NODERED_PASSWORD "$envfile")"

  if [ "$NON_INTERACTIVE" -eq 0 ]; then
    info "${C_BOLD}Cloud-Endpunkte${C_RESET} (Standard = VoltPilot-Produktion; mit Enter übernehmen):"
    prompt_default VP_PORTAL_BASE_URL "Portal-URL"        "$VP_PORTAL_BASE_URL"
    prompt_default VP_MQTT_HOST       "MQTT-Host"         "$VP_MQTT_HOST"
    prompt_default VP_MQTT_PORT       "MQTT-Port"         "$VP_MQTT_PORT"
    echo
    info "${C_BOLD}Geräte-Referenz${C_RESET} (leer = das Gerät erzeugt eine dauerhafte edge-xxxxxx):"
    prompt_default VP_REF             "VP_REF"            "$VP_REF"
    echo
    info "${C_BOLD}Batterie-Grenzen${C_RESET} für die lokalen Guards (an die echte Anlage anpassen):"
    prompt_default VP_MAX_CHARGE_KW    "Max. Ladeleistung (kW)"    "$VP_MAX_CHARGE_KW"
    prompt_default VP_MAX_DISCHARGE_KW "Max. Entladeleistung (kW)" "$VP_MAX_DISCHARGE_KW"
    prompt_default VP_SOC_MIN_PCT      "SoC Minimum (%)"           "$VP_SOC_MIN_PCT"
    prompt_default VP_SOC_MAX_PCT      "SoC Maximum (%)"           "$VP_SOC_MAX_PCT"
    echo
    info "${C_BOLD}Puffer & lokale Ports${C_RESET}:"
    prompt_default VP_BUFFER_HOURS   "Telemetrie-Puffer (Stunden)"      "$VP_BUFFER_HOURS"
    prompt_default VP_WEB_PORT       "Webansicht-Port"                  "$VP_WEB_PORT"
    prompt_default VP_NODERED_PORT   "Node-RED-Editor-Port"             "$VP_NODERED_PORT"
    prompt_default VP_BUS_PORT       "Lokaler MQTT-Bus-Port (Loopback)" "$VP_BUS_PORT"
    echo
    info "${C_BOLD}Node-RED-Editor-Zugang${C_RESET} (VoltPilot-Service-Zugang):"
    prompt_default VP_NODERED_USER   "Benutzer"                         "$VP_NODERED_USER"
  fi

  # --- Node-RED password: MUST be set to a non-default value. --------------
  echo
  local pw=""
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    pw="${VP_NODERED_PASSWORD:-$existing_pw}"
    if [ -z "$pw" ] || [ "$pw" = "$INSECURE_NODERED_PASSWORD" ]; then
      die "VP_NODERED_PASSWORD muss gesetzt und darf nicht der Standard '${INSECURE_NODERED_PASSWORD}' sein (--non-interactive)."
    fi
  else
    if [ -n "$existing_pw" ] && [ "$existing_pw" != "$INSECURE_NODERED_PASSWORD" ]; then
      info "Ein Node-RED-Passwort ist bereits gesetzt."
      local keep=""
      read -rp "    Beibehalten? [${C_DIM}J${C_RESET}/n]: " keep || keep=""
      case "${keep:-J}" in [Nn]*) : ;; *) pw="$existing_pw" ;; esac
    fi
    while [ -z "$pw" ]; do
      info "${C_BOLD}Node-RED-Passwort${C_RESET} setzen (Pflicht - der Standard '${INSECURE_NODERED_PASSWORD}' ist nicht erlaubt)."
      local pw1="" pw2=""
      prompt_secret pw1 "Neues Passwort"
      if [ -z "$pw1" ]; then warn "Leer ist nicht erlaubt."; continue; fi
      if [ "$pw1" = "$INSECURE_NODERED_PASSWORD" ]; then warn "Der Standard '${INSECURE_NODERED_PASSWORD}' ist nicht erlaubt."; continue; fi
      prompt_secret pw2 "Passwort wiederholen"
      if [ "$pw1" != "$pw2" ]; then warn "Die Passwörter stimmen nicht überein."; continue; fi
      pw="$pw1"
    done
  fi
  VP_NODERED_PASSWORD="$pw"

  # --- Write the .env atomically (never echo the password). ----------------
  local tmp; tmp="$(mktemp "${TARGET_DIR}/.env.XXXXXX")"
  # Restrict permissions before writing the secret.
  chmod 600 "$tmp"
  {
    echo "# VoltPilot Edge-App - erzeugt von install.sh. Nicht ins Git einchecken."
    echo "# Neu konfigurieren: ./install.sh --reconfigure"
    echo
    echo "# Cloud-Endpunkte (Live-Cloud)."
    echo "VP_PORTAL_BASE_URL=${VP_PORTAL_BASE_URL}"
    echo "VP_MQTT_HOST=${VP_MQTT_HOST}"
    echo "VP_MQTT_PORT=${VP_MQTT_PORT}"
    echo
    echo "# Geräte-Referenz (leer = automatisch erzeugt und in der Webansicht angezeigt)."
    echo "VP_REF=${VP_REF}"
    echo
    echo "# Batterie-Grenzen für die lokalen Guards."
    echo "VP_MAX_CHARGE_KW=${VP_MAX_CHARGE_KW}"
    echo "VP_MAX_DISCHARGE_KW=${VP_MAX_DISCHARGE_KW}"
    echo "VP_SOC_MIN_PCT=${VP_SOC_MIN_PCT}"
    echo "VP_SOC_MAX_PCT=${VP_SOC_MAX_PCT}"
    echo
    echo "# Telemetrie-Puffer + lokale Ports."
    echo "VP_BUFFER_HOURS=${VP_BUFFER_HOURS}"
    echo "VP_WEB_PORT=${VP_WEB_PORT}"
    echo "VP_NODERED_PORT=${VP_NODERED_PORT}"
    echo "VP_BUS_PORT=${VP_BUS_PORT}"
    echo
    echo "# Node-RED-Editor-Zugang (Service-Zugang; pro Installation gesetzt)."
    echo "VP_NODERED_USER=${VP_NODERED_USER}"
    echo "VP_NODERED_PASSWORD=${VP_NODERED_PASSWORD}"
    echo
    echo "# Image-Version (Rollback-Hebel). 'latest' = wie bisher; ein Tag oder"
    echo "# ein Digest-Pin friert das Gerät auf einen geprüften Stand ein."
    echo "# Setzen per: ./update.sh --tag <tag> | --core-image <ref> | --latest"
    echo "VP_EDGE_IMAGE_TAG=${VP_EDGE_IMAGE_TAG}"
    if [ -n "$VP_EDGE_CORE_IMAGE" ]; then echo "VP_EDGE_CORE_IMAGE=${VP_EDGE_CORE_IMAGE}"; fi
    if [ -n "$VP_EDGE_NODERED_IMAGE" ]; then echo "VP_EDGE_NODERED_IMAGE=${VP_EDGE_NODERED_IMAGE}"; fi
    echo
    echo "# VP_DEV_* bleiben bewusst UNGESETZT (nur Entwicklung/E2E, nie auf echten Geräten)."
  } > "$tmp"
  mv "$tmp" "$envfile"
  chmod 600 "$envfile"
  ok "${envfile#"$TARGET_DIR"/} geschrieben (Passwort nicht protokolliert, Rechte 600)."

  # Remember the web port for the verification step in this process.
  ACTIVE_WEB_PORT="$VP_WEB_PORT"
}

# =========================================================================
# STEP 5 - Validate the compose config.
# =========================================================================
compose_validate() {
  step "5/7  Compose-Konfiguration prüfen"
  local errlog; errlog="$(mktemp)"

  # In dry-run no file was written, so validate the GENERATED content via a
  # throwaway compose file (all env vars carry :-defaults, so no .env needed).
  # This self-checks the generator even in an empty directory.
  if [ "$DRY_RUN" -eq 1 ]; then
    local tmpc; tmpc="$(mktemp "${TMPDIR:-/tmp}/vp-compose.XXXXXX.yml")"
    generate_compose > "$tmpc"
    if docker compose -f "$tmpc" config >/dev/null 2>"$errlog"; then
      ok "'docker compose config' gegen die erzeugte Compose-Datei ist valide (Dry-Run)."
      rm -f "$errlog" "$tmpc"
    else
      err "'docker compose config' (erzeugte Datei) ist fehlerhaft:"
      sed 's/^/      /' "$errlog" >&2 || true
      rm -f "$errlog" "$tmpc"
      die "Erzeugte Compose-Konfiguration ungültig."
    fi
    return
  fi

  if dc config >/dev/null 2>"$errlog"; then
    ok "'docker compose config' ist valide."
    rm -f "$errlog"
  else
    err "'docker compose config' ist fehlerhaft:"
    sed 's/^/      /' "$errlog" >&2 || true
    rm -f "$errlog"
    die "Compose-Konfiguration ungültig."
  fi
}

pull_and_up() {
  step "6/7  Images ziehen und starten (core + nodered, ohne Simulator)"
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "Dry-Run: 'docker compose pull' und 'up -d' werden übersprungen."
    return
  fi

  if [ "$SKIP_PULL" -eq 1 ]; then
    warn "--skip-pull: 'docker compose pull' übersprungen."
  else
    info "Ziehe die aktuellen Registry-Images ..."
    if ! dc pull core nodered; then
      err "Das Ziehen der Images ist fehlgeschlagen."
      info "Häufige Ursachen: nicht an ${REGISTRY} angemeldet, keine Netzverbindung,"
      info "oder kein Image für diese Architektur. Prüfe: docker login ${REGISTRY}"
      die "Image-Pull fehlgeschlagen."
    fi
    ok "Images gezogen."
  fi

  info "Starte die Container (up -d, Volumes bleiben erhalten) ..."
  if ! dc up -d; then
    err "'docker compose up -d' ist fehlgeschlagen."
    info "Logs ansehen: (cd '${TARGET_DIR}' && docker compose logs)"
    die "Start fehlgeschlagen."
  fi
  ok "core + nodered gestartet."
}

# =========================================================================
# STEP 7 - Reference-ID + claim guidance + verification.
# =========================================================================
health_json() {
  curl -fsS --max-time 3 "http://127.0.0.1:${ACTIVE_WEB_PORT}/health" 2>/dev/null || true
}

wait_for_core() {
  local waited=0 timeout=90 json=""
  # Progress to stderr so it stays out of the captured JSON on stdout.
  info "Warte auf den Core (Webansicht :${ACTIVE_WEB_PORT}) ..." >&2
  while [ "$waited" -lt "$timeout" ]; do
    json="$(health_json)"
    if [ -n "$json" ]; then
      printf '%s' "$json"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

show_reference_and_verify() {
  step "7/7  Referenz-ID, Portal-Beanspruchung und Verifizierung"

  if [ "$DRY_RUN" -eq 1 ]; then
    warn "Dry-Run: keine laufenden Container - Referenz/Verifizierung übersprungen."
    return
  fi

  if ! command -v curl >/dev/null 2>&1; then
    warn "curl ist nicht installiert - die Referenz kann nicht automatisch ausgelesen werden."
    info "Öffne die Webansicht im Browser: http://$(detect_lan_ip):${ACTIVE_WEB_PORT}"
    return
  fi

  local json ref pairing cloud
  if ! json="$(wait_for_core)"; then
    err "Der Core hat sich innerhalb von 90 s nicht gemeldet."
    info "Status ansehen: (cd '${TARGET_DIR}' && docker compose ps)"
    info "Logs ansehen:   (cd '${TARGET_DIR}' && docker compose logs -f core)"
    VERIFY_RESULT="FAIL"
    return
  fi

  ref="$(json_field "$json" ref)"
  pairing="$(json_field "$json" pairing_state)"
  cloud="$(json_field "$json" cloud_connected)"
  local lan_ip web_url; lan_ip="$(detect_lan_ip)"; web_url="http://${lan_ip}:${ACTIVE_WEB_PORT}"

  # --- Reference-ID banner (prominent). ------------------------------------
  echo
  printf '%s  ┌───────────────────────────────────────────────┐%s\n' "${C_BOLD}${C_CYAN}" "${C_RESET}"
  printf '%s  │  Referenz-ID dieses Geräts:                    │%s\n' "${C_BOLD}${C_CYAN}" "${C_RESET}"
  printf '%s  │                                                │%s\n' "${C_BOLD}${C_CYAN}" "${C_RESET}"
  printf '%s  │    %s%-42s%s%s│%s\n' "${C_BOLD}${C_CYAN}" "${C_GREEN}" "${ref:-<wird erzeugt>}" "${C_RESET}" "${C_BOLD}${C_CYAN}" "${C_RESET}"
  printf '%s  └───────────────────────────────────────────────┘%s\n' "${C_BOLD}${C_CYAN}" "${C_RESET}"
  echo
  info "Lokale Webansicht:  ${C_BOLD}${web_url}${C_RESET}"
  echo
  info "${C_BOLD}Nächster Schritt - Gerät im Portal beanspruchen:${C_RESET}"
  info "  1. Portal öffnen: ${C_BOLD}${PORTAL_URL}${C_RESET} und anmelden."
  info "  2. Geräte → ＋ Gerät hinzufügen."
  info "  3. Standort wählen und als Referenz exakt ${C_BOLD}${ref:-die oben angezeigte ID}${C_RESET} eintragen."
  info "  4. Beanspruchen. Das Gerät bekommt dann automatisch sein Zertifikat und verbindet sich."

  # --- Verification. -------------------------------------------------------
  echo
  info "${C_BOLD}Verifizierung:${C_RESET}"
  local containers_ok=1
  if dc ps --status running --services 2>/dev/null | grep -qx core \
     && dc ps --status running --services 2>/dev/null | grep -qx nodered; then
    ok "Beide Container laufen (core + nodered)."
  else
    err "Nicht beide Container laufen."
    dc ps || true
    containers_ok=0
  fi

  ok "Webansicht erreichbar (/health)."

  # Enrollment / cloud reachability.
  case "$pairing" in
    warte_auf_beanspruchung|zertifikat_erhalten|verbunden|cloud_getrennt|cloud_fehler)
      ok "Enrollment hat das Portal erreicht (Pairing-Zustand: ${pairing})." ;;
    portal_nicht_erreichbar)
      err "Das Gerät erreicht das Portal NICHT (${pairing})."
      info "Prüfen: Internetverbindung, VP_PORTAL_BASE_URL=${VP_PORTAL_BASE_URL:-?}, Firewall zu ${PORTAL_URL}:443."
      containers_ok=0 ;;
    referenz_unbekannt)
      err "Die Referenz ist der Registry unbekannt (${pairing})."
      info "Eine VP-Aufkleber-ID muss in der Geräte-Registry hinterlegt sein. Sonst VP_REF leer lassen." ;;
    schluessel_konflikt)
      err "Schlüsselkonflikt (${pairing}) - die Referenz wurde bereits mit einem anderen Schlüssel ausgestellt."
      info "Aktion: im Portal widerrufen + neu beanspruchen (siehe DEPLOY.md)." ;;
    geraet_fehler)
      err "Lokaler Gerätefehler (${pairing}) - z. B. /data nicht schreibbar."
      info "Logs prüfen: (cd '${TARGET_DIR}' && docker compose logs core)"
      containers_ok=0 ;;
    start|"")
      warn "Enrollment noch nicht gestartet (Pairing-Zustand: ${pairing:-unbekannt}). Kurz warten und /health erneut prüfen." ;;
    *)
      warn "Unerwarteter Pairing-Zustand: ${pairing}." ;;
  esac

  # Optional: wait a short while for the cloud link (completes after the
  # operator claims in the portal). We never falsely claim success.
  if [ "$cloud" = "true" ]; then
    ok "Cloud-Verbindung steht bereits (cloud_connected=true)."
  elif [ "$NON_INTERACTIVE" -eq 0 ]; then
    echo
    info "Die Cloud-Verbindung entsteht, sobald du die Referenz im Portal beanspruchst."
    local ans=""
    read -rp "    Jetzt bis zu 5 Min auf die Cloud-Verbindung warten? [${C_DIM}j${C_RESET}/N]: " ans || ans=""
    case "${ans:-N}" in
      [Jj]*)
        info "Warte auf cloud_connected=true (Strg-C bricht ab, das Gerät verbindet sich dennoch weiter) ..."
        local waited=0 timeout=300 j c
        while [ "$waited" -lt "$timeout" ]; do
          j="$(health_json)"; c="$(json_field "$j" cloud_connected)"
          if [ "$c" = "true" ]; then cloud="true"; break; fi
          sleep 10; waited=$((waited + 10))
          printf '    %s... %ss (Pairing: %s)%s\n' "${C_DIM}" "$waited" "$(json_field "$j" pairing_state)" "${C_RESET}"
        done ;;
      *) : ;;
    esac
    if [ "$cloud" = "true" ]; then
      ok "Cloud-Verbindung steht (cloud_connected=true)."
    else
      warn "Noch keine Cloud-Verbindung. Das ist normal, solange die Referenz nicht beansprucht ist."
      info "Nach dem Beanspruchen prüfen: curl -s http://127.0.0.1:${ACTIVE_WEB_PORT}/health"
    fi
  else
    warn "Noch keine Cloud-Verbindung (cloud_connected=false) - erwartet, solange nicht beansprucht."
  fi

  # Final verdict.
  if [ "$containers_ok" -eq 1 ]; then
    if [ "$cloud" = "true" ]; then
      VERIFY_RESULT="PASS (verbunden)"
    else
      VERIFY_RESULT="PASS (bereit; Cloud-Verbindung nach dem Beanspruchen)"
    fi
  else
    VERIFY_RESULT="FAIL"
  fi

  FINAL_REF="$ref"
  FINAL_WEB_URL="$web_url"
  FINAL_PAIRING="$pairing"
}

# =========================================================================
# Final summary.
# =========================================================================
print_summary() {
  echo
  printf '%s────────────────────────────────────────────────────────%s\n' "${C_BOLD}" "${C_RESET}"
  printf '%s VoltPilot Edge-App - Zusammenfassung%s\n' "${C_BOLD}" "${C_RESET}"
  printf '%s────────────────────────────────────────────────────────%s\n' "${C_BOLD}" "${C_RESET}"
  if [ "$DRY_RUN" -eq 1 ]; then
    info "Dry-Run abgeschlossen: Voraussetzungen + Compose-Konfiguration geprüft."
    info "Kein Login, kein Pull, kein Start, keine .env-Änderung."
    return
  fi
  info "Referenz-ID:       ${C_GREEN}${FINAL_REF:-<siehe Webansicht>}${C_RESET}"
  info "Webansicht:        ${FINAL_WEB_URL:-http://<geraet-ip>:${ACTIVE_WEB_PORT}}"
  info "Im Portal beanspruchen: ${PORTAL_URL}"
  info "Pairing-Zustand:   ${FINAL_PAIRING:-unbekannt}"
  case "$VERIFY_RESULT" in
    PASS*) printf '    Verifizierung:     %s%s%s\n' "${C_GREEN}" "$VERIFY_RESULT" "${C_RESET}" ;;
    FAIL*) printf '    Verifizierung:     %s%s%s\n' "${C_RED}"   "$VERIFY_RESULT" "${C_RESET}" ;;
    *)     printf '    Verifizierung:     %s\n' "${VERIFY_RESULT:-unbekannt}" ;;
  esac
  echo
  info "Nützliche Befehle (in ${TARGET_DIR}):"
  info "  Status:  docker compose ps"
  info "  Logs:    docker compose logs -f core"
  info "  Update:  ./update.sh    (Compose aktuell halten + neue Images, Volumes bleiben)"
}

# =========================================================================
# main
# =========================================================================
main() {
  parse_args "$@"

  # --print-compose: emit the generated compose and exit. Writes nothing,
  # needs no docker - the docker-free self-check + an ops "derive the file"
  # escape hatch.
  if [ "$PRINT_COMPOSE" -eq 1 ]; then
    generate_compose
    exit 0
  fi

  # Standalone: operate in the CURRENT working directory (where the operator
  # ran the script). We WRITE docker-compose.yml + .env here and never require
  # a repo checkout. Resolve to a physical path so it is CWD-robust.
  TARGET_DIR="$(pwd -P)"
  readonly TARGET_DIR
  COMPOSE_FILE="${TARGET_DIR}/docker-compose.yml"
  readonly COMPOSE_FILE
  ENV_FILE="${TARGET_DIR}/.env"
  readonly ENV_FILE

  # Defaults for the verification step (overwritten once .env is known).
  ACTIVE_WEB_PORT="$(env_get VP_WEB_PORT "$ENV_FILE")"; ACTIVE_WEB_PORT="${ACTIVE_WEB_PORT:-$DEF_VP_WEB_PORT}"
  VERIFY_RESULT="unbekannt"; FINAL_REF=""; FINAL_WEB_URL=""; FINAL_PAIRING=""

  printf '%s%sVoltPilot Edge-App - geführte Installation (eigenständig)%s\n' "${C_BOLD}" "${C_CYAN}" "${C_RESET}"
  printf '%sArbeitsverzeichnis: %s%s\n' "${C_DIM}" "$TARGET_DIR" "${C_RESET}"
  [ "$DRY_RUN" -eq 1 ] && printf '%sModus: DRY-RUN (nur prüfen)%s\n' "${C_YELLOW}" "${C_RESET}"

  check_prerequisites
  check_registry_login
  generate_compose_step
  configure_env
  compose_validate
  pull_and_up
  show_reference_and_verify
  print_summary
}

# Source guard: update.sh sources this file to reuse generate_compose() and
# the shared helpers (ONE source of truth for the compose template - see the
# lockstep note above generate_compose). Sourcing defines everything but runs
# nothing; direct execution behaves exactly as before.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
