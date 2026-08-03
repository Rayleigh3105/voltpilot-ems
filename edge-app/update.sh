#!/usr/bin/env bash
#
# VoltPilot Edge-App - safe one-command UPDATER for a RUNNING edge device.
# Companion to install.sh (which sets up a NEW device).
#
# What it does, in order:
#   1. checks the prerequisites (docker + compose v2),
#   2. detects the existing deployment in the CURRENT directory - either an
#      install.sh-generated one (compose carries the @voltpilot-edge-install
#      marker) or a repo-clone deployment (compose is git-tracked),
#   3. brings the compose file(s) up to date:
#        - installer model: regenerates docker-compose.yml via install.sh's
#          generate_compose() (this script SOURCES install.sh - ONE source of
#          truth for the compose template, never a duplicated copy) and, when
#          present/in use, refreshes docker-compose.hostnet.yml;
#        - repo model: offers `git pull --ff-only` (never force/stash/reset);
#        - a hand-edited compose is NEVER overwritten without --force-compose,
#   4. pulls the current registry images and runs `up -d --remove-orphans`
#      (the Node-RED template auto-reseed applies flow updates on start - no
#      volume wipe, ever),
#   5. verifies via the core's local /health endpoint and prints PASS/FAIL
#      with the pairing/cloud state plus rollback guidance on failure, and
#      prints the RESOLVED image digests so the operator can record them as
#      the rollback target of the next update.
#
# Image version / rollback: by default the device tracks `:latest` exactly as
# before. `--tag <tag>` pins BOTH images to one tag, `--core-image <ref>` /
# `--nodered-image <ref>` pin a full ref (that is how a digest pin is
# expressed), `--latest` releases the pin. A pin is persisted so it also
# survives a later plain `docker compose up -d`.
#
# Hard safety rules: never `down -v`, never touches the data volumes
# (vp-edge-data / vp-nodered-data) or the device identity, never sets the
# VP_DEV_* dev hatches, never echoes secrets. The .env is NEVER rewritten -
# with exactly ONE narrow, opt-in exception: `--tag`/`--core-image`/
# `--nodered-image`/`--latest` replace the corresponding VP_EDGE_* image key
# (and only that key) in place, byte-preserving every other line, mode 600.
# Without one of those flags not a single byte of the .env is touched.
#
# Usage: ./update.sh [--help]   (run it in the deploy directory)
#
set -euo pipefail

# --------------------------------------------------------------------------
# Locate + source install.sh: the single source of truth for the compose
# template (generate_compose), the marker, and the shared helpers. install.sh
# guards its main() behind a BASH_SOURCE check, so sourcing runs nothing.
# --------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TARGET_DIR="$(pwd -P)"
readonly SCRIPT_DIR TARGET_DIR

if [ -f "${SCRIPT_DIR}/install.sh" ]; then
  INSTALL_SH="${SCRIPT_DIR}/install.sh"
elif [ -f "${TARGET_DIR}/install.sh" ]; then
  INSTALL_SH="${TARGET_DIR}/install.sh"
else
  {
    echo "FEHLER: install.sh wurde nicht gefunden (weder neben update.sh noch im aktuellen Verzeichnis)."
    echo "update.sh nutzt install.sh als gemeinsame Vorlagen-Quelle. Einmalig nachladen:"
    echo "  curl -fsSLO https://git.tecmaxx.de/mamotec/voltpilot-ems/raw/branch/main/edge-app/install.sh"
    echo "und update.sh danach erneut ausführen."
  } >&2
  exit 1
fi
readonly INSTALL_SH
# shellcheck source=install.sh
# shellcheck disable=SC1091
. "$INSTALL_SH"

COMPOSE_FILE="${TARGET_DIR}/docker-compose.yml"
ENV_FILE="${TARGET_DIR}/.env"
HOSTNET_FILE="${TARGET_DIR}/docker-compose.hostnet.yml"
readonly COMPOSE_FILE ENV_FILE HOSTNET_FILE

# Marker on the first line of a hostnet override WE generated (same
# @voltpilot-edge-install vocabulary as the compose marker, so marker-based
# provenance detection covers both files).
readonly HOSTNET_MARKER="# @voltpilot-edge-install: generated docker-compose.hostnet.yml (do not hand-edit; re-run update.sh --force-compose)"

# Update-specific flags/state (NON_INTERACTIVE / FORCE_COMPOSE / SKIP_PULL /
# DRY_RUN / PRINT_COMPOSE are initialized by the sourced install.sh).
PRINT_HOSTNET=0
FORCE_HOSTNET=0
DOCKER_AVAILABLE=0
MODEL=""                 # installer | repo | foreign
HOSTNET_ACTIVE=0
COMPOSE_ARGS=()
VERIFY_RESULT="unbekannt"
FINAL_PAIRING=""
FINAL_CLOUD=""
# Image pin request (empty = untouched; PIN_REQUESTED gates every .env write).
PIN_REQUESTED=0
PIN_TAG=""
PIN_CORE_IMAGE=""
PIN_NODERED_IMAGE=""
# --from-target (OTA Stufe 2): das vom Portal ZUGEWIESENE Release anwenden.
FROM_TARGET=0
TARGET_RELEASE=""
TARGET_RELEASE_SEQ=""
PIN_RELEASE=0

# Abort wording for the updater (overrides install.sh's installer wording).
die() { err "$*"; printf '\n%sUpdate abgebrochen.%s\n' "${C_RED}" "${C_RESET}" >&2; exit 1; }

usage() {
  cat <<EOF
${C_BOLD}VoltPilot Edge-App - sicheres Ein-Befehl-Update${C_RESET}

Aktualisiert ein LAUFENDES Edge-Gerät im aktuellen Verzeichnis: bringt die
docker-compose.yml (und ggf. docker-compose.hostnet.yml) auf den aktuellen
Stand, zieht die neuesten Registry-Images und startet die Container neu
('up -d --remove-orphans'). Die Node-RED-Flow-Vorlagen aktualisieren sich
beim Start automatisch aus dem Image - KEIN Volume wird gelöscht.

Unterstützt beide Deploy-Modelle:
  - vom Installer erzeugte docker-compose.yml (Marker in der ersten Zeile):
    wird über install.sh's Vorlage neu erzeugt (eine Quelle, kein Duplikat);
  - Repo-Klon (docker-compose.yml ist git-verwaltet): Aktualisierung per
    'git pull --ff-only' (niemals force/stash/reset).

Sicherheitsregeln (fest verdrahtet): niemals 'down -v', die Datenvolumes
(vp-edge-data / vp-nodered-data) und die Geräteidentität bleiben unberührt,
die VP_DEV_*-Schalter werden nie gesetzt, eine handbearbeitete Compose-Datei
wird nie ohne --force-compose überschrieben. Die .env wird NIE verändert -
mit genau EINER Ausnahme: die Image-Pin-Optionen unten ersetzen exakt den
zugehörigen VP_EDGE_*-Schlüssel (jede andere Zeile bleibt Byte für Byte
erhalten, Rechte 600, kein Geheimnis wird gelesen oder ausgegeben).

${C_BOLD}Aufruf:${C_RESET}
  ./update.sh [Optionen]        (im Deploy-Verzeichnis ausführen)
  ./update.sh --tag <tag>       (auf eine bestimmte Version aktualisieren)
  ./update.sh --core-image <ref> --nodered-image <ref>   (Rollback per Digest)

${C_BOLD}Optionen:${C_RESET}
  -h, --help           Diese Hilfe anzeigen und beenden.
      --non-interactive
                       Keine Rückfragen: fremde Compose-Dateien werden
                       beibehalten, 'git pull --ff-only' wird versucht.
      --force-compose  Auch eine handbearbeitete docker-compose.yml /
                       docker-compose.hostnet.yml mit der aktuellen Vorlage
                       überschreiben (nicht im Repo-Klon-Modell - dort
                       verwaltet Git die Dateien).
      --hostnet        Das Host-Netz-Override docker-compose.hostnet.yml
                       einbeziehen, auch wenn es nicht automatisch erkannt
                       wird (z. B. weil die Container gerade gestoppt sind).
      --skip-pull      'docker compose pull' überspringen (nur Compose-Refresh
                       + 'up -d').
      --print-compose  Die aktuelle docker-compose.yml-Vorlage nach stdout
                       schreiben und beenden (identisch zu install.sh).
      --print-hostnet  Die aktuelle docker-compose.hostnet.yml-Vorlage nach
                       stdout schreiben und beenden.
      --dry-run        Nur zeigen, was sich ändern würde: kein Schreiben,
                       kein Pull, kein Start. Funktioniert auch ohne Docker.

${C_BOLD}Image-Version / Rollback${C_RESET} (ohne diese Optionen bleibt alles wie bisher:
das Gerät folgt ':latest'):
      --tag <tag>      BEIDE Images auf diesen Tag festnageln (z. B. den
                       Commit-SHA eines geprüften Stands) und darauf
                       aktualisieren. Wird in der .env als
                       VP_EDGE_IMAGE_TAG hinterlegt, gilt also auch für ein
                       späteres 'docker compose up -d'.
      --core-image <ref>
      --nodered-image <ref>
                       Vollständige Image-Referenz festnageln - so wird ein
                       DIGEST-Pin gesetzt, der saubere Rollback:
                         --core-image git.tecmaxx.de/.../edge-app-core@sha256:<digest>
                       (Digests der laufenden Stände zeigt jedes Update am
                       Ende an; VP_EDGE_CORE_IMAGE / VP_EDGE_NODERED_IMAGE).
      --latest         Alle Pins lösen: zurück auf ':latest' (Standard).

${C_BOLD}Portal-Zuweisung anwenden${C_RESET} (OTA Stufe 2 - Verteilen):
      --from-target    Genau das Release anwenden, das das Portal DIESEM Gerät
                       zugewiesen hat. Die Artefakt-Digests kommen aus
                       /api/ota/target - und ausschließlich dann, wenn das
                       GERÄT die Signaturkette selbst geprüft hat (eingebackene
                       Vertrauenswurzel). Ist die Kette nicht geprüft oder gibt
                       es keine Zuweisung, bricht der Lauf ab, statt irgendetwas
                       anzuwenden. Nach erfolgreicher Prüfung meldet das Gerät
                       den angewandten Stand ans Portal zurück.
EOF
}

# An option value must exist and must not be another option. Called directly
# (never in a subshell) so its `exit` really ends the script.
require_value() {
  case "${2-}" in
    ""|-*) err "Option ${1} benötigt einen Wert."; echo; usage; exit 2 ;;
  esac
}

# Docker tag charset (docker's own rule). Rejects anything that could break an
# .env line (space, quote, $, newline) by construction.
valid_tag() {
  case "$1" in
    *[!A-Za-z0-9._-]*|"") return 1 ;;
    [.-]*) return 1 ;;
  esac
  [ "${#1}" -le 128 ]
}

# Full image reference: registry/repo:tag or registry/repo@sha256:<digest>.
# Deliberately a strict charset - no shell/env metacharacters can get through.
valid_image_ref() {
  case "$1" in
    *[!A-Za-z0-9._:/@-]*|"") return 1 ;;
    [!A-Za-z0-9]*) return 1 ;;
  esac
  case "$1" in
    *:*|*@*) return 0 ;;
    *) return 1 ;;   # an unversioned ref would silently mean :latest again
  esac
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      --non-interactive) NON_INTERACTIVE=1 ;;
      --force-compose) FORCE_COMPOSE=1 ;;
      --hostnet) FORCE_HOSTNET=1 ;;
      --skip-pull) SKIP_PULL=1 ;;
      --print-compose) PRINT_COMPOSE=1 ;;
      --print-hostnet) PRINT_HOSTNET=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --tag)
        require_value --tag "${2-}"; PIN_TAG="$2"; shift
        if ! valid_tag "$PIN_TAG"; then err "Ungültiger Image-Tag: ${PIN_TAG}"; exit 2; fi
        PIN_REQUESTED=1 ;;
      --core-image)
        require_value --core-image "${2-}"; PIN_CORE_IMAGE="$2"; shift
        if ! valid_image_ref "$PIN_CORE_IMAGE"; then err "Ungültige Image-Referenz: ${PIN_CORE_IMAGE}"; exit 2; fi
        PIN_REQUESTED=1 ;;
      --nodered-image)
        require_value --nodered-image "${2-}"; PIN_NODERED_IMAGE="$2"; shift
        if ! valid_image_ref "$PIN_NODERED_IMAGE"; then err "Ungültige Image-Referenz: ${PIN_NODERED_IMAGE}"; exit 2; fi
        PIN_REQUESTED=1 ;;
      --latest) PIN_RELEASE=1; PIN_REQUESTED=1 ;;
      --from-target) FROM_TARGET=1; PIN_REQUESTED=1 ;;
      *) err "Unbekannte Option: $1"; echo; usage; exit 2 ;;
    esac
    shift
  done
  if [ "$PIN_RELEASE" -eq 1 ] && { [ -n "$PIN_TAG" ] || [ -n "$PIN_CORE_IMAGE" ] || [ -n "$PIN_NODERED_IMAGE" ]; }; then
    err "--latest schließt --tag / --core-image / --nodered-image aus."
    exit 2
  fi
  if [ "$FROM_TARGET" -eq 1 ] && { [ "$PIN_RELEASE" -eq 1 ] || [ -n "$PIN_TAG" ] \
       || [ -n "$PIN_CORE_IMAGE" ] || [ -n "$PIN_NODERED_IMAGE" ]; }; then
    # Zwei Quellen fuer dieselbe Frage waeren genau die Mehrdeutigkeit, gegen
    # die die Zuweisung gebaut ist: welches Release soll denn nun laufen?
    err "--from-target schließt --latest / --tag / --core-image / --nodered-image aus."
    exit 2
  fi
}

# docker compose wrapper pinning the project dir + the ACTIVE compose file
# set (base + hostnet override when in use), so it works regardless of CWD
# and always loads the target dir's .env.
dcu() { docker compose --project-directory "$TARGET_DIR" "${COMPOSE_ARGS[@]}" "$@"; }

# True if the file exists and its first line carries the generated marker
# (prefix match, so files from older script versions are still recognized).
is_generated_file() {
  local first=""
  [ -f "$1" ] || return 1
  IFS= read -r first < "$1" || true
  case "$first" in
    "# @voltpilot-edge-install:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Emit the current hostnet override template (marker + the repo's
# docker-compose.hostnet.yml, byte for byte). Kept in lockstep with
# edge-app/docker-compose.hostnet.yml - edge-app/test/update-selfcheck.sh
# fails on drift.
generate_hostnet_compose() {
  printf '%s\n' "$HOSTNET_MARKER"
  cat <<'EOF'
# VoltPilot Edge-App: Host-Networking-Override fuer Node-RED.
#
# Wann brauche ich das?
#   Ein Docker-Bridge-Container erreicht viele LAN-Wechselrichter-Logger (Deye/
#   Solarman-WiFi-Dongle, UDP 48899) NICHT zuverlaessig: das ausgehende UDP-
#   Paket wird ge-SNAT-tet, die Antwort des Dongles kommt oft von einem anderen
#   Quellport oder als Broadcast zurueck und wird von conntrack verworfen -> der
#   `deye`-Read liefert leer / laeuft in den Timeout, obwohl die IP stimmt.
#   Host-Networking setzt den Node-RED-Container direkt aufs LAN (kein NAT) und
#   ist der Standard-Fix fuer Solarman/USR-UDP-Logger.
#
# Verwendung (Node-RED aufs Host-Netz, core + sim unveraendert):
#   docker compose -f docker-compose.yml -f docker-compose.hostnet.yml up -d
#
# Ohne dieses Override laeuft alles wie gehabt (Bridge). Details + Caveats:
# siehe DEPLOY.md, Abschnitt "LAN-Logger nicht aus dem Container erreichbar?".
#
# Hinweis: Host-Networking ist ein Linux-Feature (Kundengeraete: Raspberry Pi /
# Linux-VM). Auf Docker Desktop (macOS/Windows) hat `network_mode: host` keine
# volle Wirkung - das ist nur fuer den Linux-Produktivbetrieb gedacht.

services:
  nodered:
    # Direkt aufs Host-LAN: kein NAT, damit der UDP-Austausch mit dem Deye-
    # Logger (48899) klappt.
    network_mode: host
    # Portmappings sind mit host-networking ungueltig (der Container bindet die
    # Hostports direkt): Node-RED-Editor liegt danach fest auf Host-Port 1880
    # (nicht mehr VP_NODERED_PORT).
    ports: !reset []
    environment:
      VP_NODERED_USER: ${VP_NODERED_USER:-voltpilot}
      # Kein Standard-Passwort (fail closed): unset/'voltpilot' verweigert
      # settings.js den Editor-Start. Wert in der .env setzen (install.sh).
      VP_NODERED_PASSWORD: ${VP_NODERED_PASSWORD:-}
      # Auf dem Host-Netz ist der Compose-Dienstname "core" nicht mehr
      # aufloesbar. Der Core gibt den lokalen Bus per Host-Loopback frei
      # (127.0.0.1:${VP_BUS_PORT:-1884} -> core:1883), also zeigen die vp-Knoten
      # dorthin. VP_CORE_HOST/PORT haben Vorrang vor der Flow-Konfiguration.
      VP_CORE_HOST: 127.0.0.1
      VP_CORE_PORT: ${VP_BUS_PORT:-1884}
EOF
}

# Write the hostnet override atomically (never touches data volumes).
write_hostnet_file() {
  local tmp; tmp="$(mktemp "${TARGET_DIR}/.docker-compose.hostnet.yml.XXXXXX")"
  generate_hostnet_compose > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$HOSTNET_FILE"
}

# =========================================================================
# Image pin (.env): the ONLY place update.sh ever writes the .env, reached
# ONLY via --tag / --core-image / --nodered-image / --latest.
# =========================================================================

# Replace exactly ONE VP_EDGE_* image key in the .env, byte-preserving every
# other line (secrets included - they are never read, matched or echoed).
# An empty value REMOVES the key. Atomic (tmp + mv), mode 600.
env_set_pin() {
  local key="$1" value="${2-}" tmp
  case "$key" in
    VP_EDGE_IMAGE_TAG|VP_EDGE_CORE_IMAGE|VP_EDGE_NODERED_IMAGE) : ;;
    *) die "interner Fehler: env_set_pin akzeptiert nur VP_EDGE_*-Image-Schlüssel (bekam '${key}')." ;;
  esac
  tmp="$(mktemp "${TARGET_DIR}/.env.XXXXXX")"
  chmod 600 "$tmp"
  if [ -f "$ENV_FILE" ]; then
    # awk (not grep -v) so an .env that consists only of this key is not
    # mistaken for an error, and so the exit status is always 0.
    if ! awk -v pat="^[[:space:]]*${key}=" '$0 ~ pat { next } { print }' "$ENV_FILE" > "$tmp"; then
      rm -f "$tmp"
      die "Die .env konnte nicht gelesen werden - es wurde nichts verändert."
    fi
  else
    printf '%s\n' "# VoltPilot Edge-App - von update.sh angelegt (nur Image-Pin)." > "$tmp"
  fi
  if [ -n "$value" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# Apply the requested pin: export it for THIS run's compose calls and persist
# it in the .env so a later plain `docker compose up -d` keeps the same
# version. No pin requested -> returns immediately, .env untouched.
apply_image_pin() {
  [ "$PIN_REQUESTED" -eq 1 ] || return 0

  local what=""
  if [ "$PIN_RELEASE" -eq 1 ]; then
    what="Pins gelöst -> :latest"
  else
    if [ -n "$PIN_TAG" ]; then what="Tag ${PIN_TAG}"; fi
    if [ -n "$PIN_CORE_IMAGE" ]; then what="${what:+${what}, }core=${PIN_CORE_IMAGE}"; fi
    if [ -n "$PIN_NODERED_IMAGE" ]; then what="${what:+${what}, }nodered=${PIN_NODERED_IMAGE}"; fi
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    warn "Dry-Run: Image-Version WÜRDE festgelegt (${what}); die .env bleibt unverändert."
    return
  fi

  if [ "$PIN_RELEASE" -eq 1 ]; then
    env_set_pin VP_EDGE_IMAGE_TAG "latest"
    env_set_pin VP_EDGE_CORE_IMAGE ""
    env_set_pin VP_EDGE_NODERED_IMAGE ""
    unset VP_EDGE_CORE_IMAGE VP_EDGE_NODERED_IMAGE
    export VP_EDGE_IMAGE_TAG="latest"
  else
    if [ -n "$PIN_TAG" ]; then
      env_set_pin VP_EDGE_IMAGE_TAG "$PIN_TAG"
      export VP_EDGE_IMAGE_TAG="$PIN_TAG"
      # A tag pin must not be silently outranked by a stale full-ref pin.
      local old_core old_nodered
      old_core="$(env_get VP_EDGE_CORE_IMAGE "$ENV_FILE")"
      old_nodered="$(env_get VP_EDGE_NODERED_IMAGE "$ENV_FILE")"
      if [ -n "$old_core" ] && [ -z "$PIN_CORE_IMAGE" ]; then
        env_set_pin VP_EDGE_CORE_IMAGE ""; unset VP_EDGE_CORE_IMAGE
        info "Bisheriger core-Image-Pin (${old_core}) wurde durch --tag ersetzt."
      fi
      if [ -n "$old_nodered" ] && [ -z "$PIN_NODERED_IMAGE" ]; then
        env_set_pin VP_EDGE_NODERED_IMAGE ""; unset VP_EDGE_NODERED_IMAGE
        info "Bisheriger nodered-Image-Pin (${old_nodered}) wurde durch --tag ersetzt."
      fi
    fi
    if [ -n "$PIN_CORE_IMAGE" ]; then
      env_set_pin VP_EDGE_CORE_IMAGE "$PIN_CORE_IMAGE"
      export VP_EDGE_CORE_IMAGE="$PIN_CORE_IMAGE"
    fi
    if [ -n "$PIN_NODERED_IMAGE" ]; then
      env_set_pin VP_EDGE_NODERED_IMAGE "$PIN_NODERED_IMAGE"
      export VP_EDGE_NODERED_IMAGE="$PIN_NODERED_IMAGE"
    fi
  fi
  ok "Image-Version festgelegt (${what}); in der .env hinterlegt - sonst wurde dort nichts verändert."
  if [ -n "$PIN_CORE_IMAGE" ] && [ -z "$PIN_NODERED_IMAGE" ]; then
    warn "Nur das core-Image ist gepinnt - für einen vollständigen Rollback auch --nodered-image setzen."
  fi
  if [ -n "$PIN_NODERED_IMAGE" ] && [ -z "$PIN_CORE_IMAGE" ]; then
    warn "Nur das nodered-Image ist gepinnt - für einen vollständigen Rollback auch --core-image setzen."
  fi
}

# =========================================================================
# STEP 1 - Prerequisites (dry-run degrades to file-only checks, no docker
# needed - unlike the installer, the updater's dry-run must run anywhere).
# =========================================================================
update_prerequisites() {
  step "1/5  Voraussetzungen prüfen"
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      ok "docker + compose (v2) gefunden, Daemon läuft"
      DOCKER_AVAILABLE=1
      return
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
      warn "Docker-Daemon nicht erreichbar - Dry-Run prüft nur die Dateien."
      return
    fi
    err "Der Docker-Daemon läuft nicht oder ist für diesen Benutzer nicht erreichbar."
    info "Starten (Linux): ${C_CYAN}sudo systemctl start docker${C_RESET}"
    die "Docker-Daemon nicht erreichbar."
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "docker / docker compose (v2) nicht verfügbar - Dry-Run prüft nur die Dateien."
    return
  fi
  err "docker bzw. das Docker-Compose-Plugin (v2) fehlt."
  info "Voraussetzungen wie bei der Installation - siehe ./install.sh bzw. DEPLOY.md."
  die "docker / docker compose (v2) fehlt."
}

# =========================================================================
# STEP 2 - Detect the existing deployment (model, .env, hostnet override).
# =========================================================================
detect_hostnet() {
  HOSTNET_ACTIVE=0
  if [ "$FORCE_HOSTNET" -eq 1 ]; then
    HOSTNET_ACTIVE=1
    ok "Host-Netz-Override wird einbezogen (--hostnet)."
    return
  fi
  [ -f "$HOSTNET_FILE" ] || return 0

  # The file alone does not mean it is in use (a repo clone always has it).
  # Ask the running nodered container.
  local cid="" mode=""
  if [ "$DOCKER_AVAILABLE" -eq 1 ]; then
    cid="$(docker compose --project-directory "$TARGET_DIR" -f "$COMPOSE_FILE" ps -q nodered 2>/dev/null | head -n1 || true)"
    if [ -n "$cid" ]; then
      mode="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$cid" 2>/dev/null || true)"
    fi
  fi
  case "$mode" in
    host)
      HOSTNET_ACTIVE=1
      ok "Host-Netz-Override ist in Benutzung (nodered läuft mit network_mode: host)." ;;
    "")
      if [ "$MODEL" = "installer" ] || [ "$MODEL" = "foreign" ]; then
        # Outside a repo clone the file only exists because the operator
        # deliberately switched to host networking - include it rather than
        # silently moving nodered back onto the bridge.
        HOSTNET_ACTIVE=1
        warn "docker-compose.hostnet.yml vorhanden, laufender Container nicht prüfbar - Override wird einbezogen."
      else
        warn "docker-compose.hostnet.yml vorhanden, laufender Container nicht prüfbar."
        info "Falls dein Deployment das Host-Netz nutzt: update.sh mit --hostnet aufrufen."
      fi ;;
    *)
      info "docker-compose.hostnet.yml vorhanden, aber nodered läuft im Bridge-Netz - Override bleibt außen vor." ;;
  esac
}

detect_deployment() {
  step "2/5  Bestehendes Deployment erkennen"
  if [ ! -f "$COMPOSE_FILE" ]; then
    err "Keine docker-compose.yml in ${TARGET_DIR} gefunden - hier liegt kein VoltPilot-Edge-Deployment."
    info "Für die Erstinstallation: ./install.sh (im gewünschten Verzeichnis) ausführen."
    die "Kein Deployment gefunden."
  fi

  if is_generated_file "$COMPOSE_FILE"; then
    MODEL="installer"
    ok "Vom Installer erzeugte docker-compose.yml erkannt (Marker vorhanden)."
  elif command -v git >/dev/null 2>&1 \
       && git -C "$TARGET_DIR" ls-files --error-unmatch docker-compose.yml >/dev/null 2>&1; then
    MODEL="repo"
    ok "Repo-Klon-Deployment erkannt (docker-compose.yml ist git-verwaltet)."
  else
    MODEL="foreign"
    warn "Die docker-compose.yml stammt weder vom Installer noch aus einem Git-Klon (evtl. handbearbeitet)."
  fi

  # .env: NEVER rewritten by the updater - secrets stay exactly as they are.
  if [ -f "$ENV_FILE" ]; then
    ok ".env vorhanden - bleibt unverändert (Geheimnisse werden nie angefasst)."
    if [ "$DRY_RUN" -eq 0 ]; then
      chmod 600 "$ENV_FILE" 2>/dev/null || true
    fi
    warn_dev_hatches "$ENV_FILE"
  else
    warn "Keine .env gefunden - es gelten die eingebauten Standardwerte."
  fi
  ACTIVE_WEB_PORT="$(env_get VP_WEB_PORT "$ENV_FILE")"
  ACTIVE_WEB_PORT="${ACTIVE_WEB_PORT:-$DEF_VP_WEB_PORT}"

  detect_hostnet

  COMPOSE_ARGS=(-f "$COMPOSE_FILE")
  if [ "$HOSTNET_ACTIVE" -eq 1 ]; then
    COMPOSE_ARGS+=(-f "$HOSTNET_FILE")
  fi
}

# =========================================================================
# STEP 3 - Refresh the compose file(s).
# =========================================================================
refresh_generated_compose() {
  if generate_compose | cmp -s - "$COMPOSE_FILE"; then
    ok "docker-compose.yml ist bereits auf dem aktuellen Stand."
    return
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "Dry-Run: docker-compose.yml WÜRDE auf die aktuelle Vorlage gebracht (Änderungen unten)."
    diff -u "$COMPOSE_FILE" <(generate_compose) 2>/dev/null | sed 's/^/      /' || true
    return
  fi
  write_compose_file
  ok "docker-compose.yml auf die aktuelle Vorlage gebracht (.env und Volumes unberührt)."
}

refresh_repo_compose() {
  info "Die Compose-Datei(en) kommen aus dem Git-Klon - Aktualisierung per 'git pull --ff-only'."
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "Dry-Run: 'git pull --ff-only' wird nicht ausgeführt."
    return
  fi
  local do_pull=1 ans=""
  if [ "$NON_INTERACTIVE" -eq 0 ]; then
    read -rp "    Jetzt 'git pull --ff-only' ausführen? [${C_DIM}J${C_RESET}/n]: " ans || ans=""
    case "${ans:-J}" in [Nn]*) do_pull=0 ;; esac
  fi
  if [ "$do_pull" -eq 0 ]; then
    info "Übersprungen - es wird der vorhandene Stand der Compose-Datei(en) verwendet."
    return
  fi
  if git -C "$TARGET_DIR" pull --ff-only; then
    ok "Repo aktualisiert (fast-forward) - docker-compose.yml/hostnet.yml sind auf dem Stand des Repos."
  else
    warn "'git pull --ff-only' ist fehlgeschlagen (lokale Änderungen, Divergenz oder kein Netz)."
    warn "Es wird mit dem VORHANDENEN Stand fortgefahren - bitte den Klon manuell aufräumen."
    info "Absichtlich NIE verwendet: force-pull, stash-Verwerfen oder 'down -v'."
  fi
}

refresh_foreign_compose() {
  if [ "$FORCE_COMPOSE" -eq 1 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      warn "Dry-Run: die fremde docker-compose.yml WÜRDE mit der aktuellen Vorlage überschrieben (--force-compose)."
      return
    fi
    write_compose_file
    warn "Handbearbeitete docker-compose.yml mit der aktuellen Vorlage überschrieben (--force-compose)."
    MODEL="installer"
    return
  fi
  if [ "$NON_INTERACTIVE" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
    ok "Bestehende (nicht vom Installer erzeugte) docker-compose.yml wird beibehalten (--force-compose zum Ersetzen)."
    return
  fi
  warn "Die docker-compose.yml stammt nicht vom Installer (evtl. handbearbeitet)."
  local choice=""
  read -rp "    Beibehalten [B] oder mit der aktuellen Vorlage überschreiben [Ü]? [${C_DIM}B${C_RESET}]: " choice || choice=""
  case "${choice:-B}" in
    [ÜüUu]*)
      write_compose_file
      warn "docker-compose.yml mit der aktuellen Vorlage überschrieben."
      MODEL="installer" ;;
    *)
      ok "Bestehende docker-compose.yml wird beibehalten." ;;
  esac
}

refresh_hostnet_file() {
  # Repo model: git owns the file (refreshed by the pull above).
  if [ "$MODEL" = "repo" ]; then
    return
  fi
  if [ -f "$HOSTNET_FILE" ]; then
    if is_generated_file "$HOSTNET_FILE"; then
      if generate_hostnet_compose | cmp -s - "$HOSTNET_FILE"; then
        ok "docker-compose.hostnet.yml ist bereits auf dem aktuellen Stand."
      elif [ "$DRY_RUN" -eq 1 ]; then
        warn "Dry-Run: docker-compose.hostnet.yml WÜRDE auf die aktuelle Vorlage gebracht."
      else
        write_hostnet_file
        ok "docker-compose.hostnet.yml auf die aktuelle Vorlage gebracht."
      fi
    elif [ "$FORCE_COMPOSE" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
      write_hostnet_file
      warn "Handkopierte docker-compose.hostnet.yml mit der aktuellen Vorlage überschrieben (--force-compose)."
    else
      info "docker-compose.hostnet.yml stammt nicht vom Updater - bleibt unverändert (--force-compose ersetzt sie durch die aktuelle Vorlage)."
    fi
  elif [ "$HOSTNET_ACTIVE" -eq 1 ]; then
    # --hostnet requested but no override file present: write the template so
    # the following 'up -d' has something to apply.
    if [ "$DRY_RUN" -eq 1 ]; then
      warn "Dry-Run: docker-compose.hostnet.yml fehlt und WÜRDE aus der Vorlage erzeugt (--hostnet)."
    else
      write_hostnet_file
      ok "docker-compose.hostnet.yml aus der aktuellen Vorlage erzeugt (--hostnet)."
    fi
  fi
}

# =========================================================================
# --from-target: die Zuweisung des Portals anwenden (OTA Stufe 2)
# =========================================================================
#
# DIE Sicherheits-Eigenschaft dieses Modus: die Digests kommen vom GERÄT,
# nicht aus dem Aufruf und nicht aus der Cloud-Antwort. Das Gerät hat das
# signierte Manifest gegen seine EINGEBACKENE Vertrauenswurzel geprüft und
# gibt die Artefakt-Referenzen erst danach heraus (GET /api/ota/target liefert
# `images` nur bei verdict=ok). Ein beaufsichtigter Lauf kann damit nie etwas
# anwenden, das diese Box nicht selbst verifiziert hat - und der Mensch am
# Gerät muss keinen Digest mehr abtippen.

# Ein verschachteltes JSON-Feld ("images": { "core": "..." }) lesen. Absichtlich
# ohne jq (auf einer Box nicht vorausgesetzt) und absichtlich eng: gesucht wird
# der Wert GENAU dieses Schlüssels innerhalb des images-Objekts.
target_image_ref() {
  local json="$1" name="$2"
  printf '%s' "$json" \
    | tr -d '\n' \
    | sed -n 's/.*"images"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p' \
    | sed -n "s/.*\"${name}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" \
    | head -n1
}

resolve_target_pin() {
  [ "$FROM_TARGET" -eq 1 ] || return 0
  step "2b/5 Zugewiesenes Release vom Gerät lesen (--from-target)"

  if ! command -v curl >/dev/null 2>&1; then
    die "--from-target benötigt curl (die Zuweisung wird über /api/ota/target gelesen)."
  fi
  local json
  json="$(curl -fsS --max-time 5 "http://127.0.0.1:${ACTIVE_WEB_PORT}/api/ota/target" 2>/dev/null || true)"
  if [ -z "$json" ]; then
    err "Das Gerät antwortet nicht auf /api/ota/target (Port ${ACTIVE_WEB_PORT})."
    info "Läuft der Core? ${C_CYAN}docker compose ps${C_RESET}"
    info "Ein älterer Core kennt diesen Endpunkt noch nicht - dann per Digest aktualisieren:"
    info "  ${C_CYAN}./update.sh --core-image <ref@sha256:...> --nodered-image <ref@sha256:...>${C_RESET}"
    die "Keine Zuweisung lesbar."
  fi

  local has verdict reason release seq core nodered
  has="$(json_field "$json" has_target)"
  verdict="$(json_field "$json" verdict)"
  reason="$(json_field "$json" reason)"
  release="$(json_field "$json" release)"
  seq="$(json_field "$json" release_seq)"

  if [ "$has" != "true" ]; then
    err "Diesem Gerät ist im Portal kein Release zugewiesen."
    info "Im Portal unter Plattform → Edge-Updates ein Ziel setzen und erneut ausführen."
    die "Keine Zuweisung vorhanden."
  fi
  if [ "$verdict" != "ok" ]; then
    # Ein nicht geprüftes Release wird NICHT angewandt - egal wie es heißt.
    err "Das zugewiesene Release ist auf diesem Gerät nicht anwendbar (${verdict:-unbekannt})."
    [ -n "$reason" ] && info "Grund: ${reason}"
    die "Signaturkette bzw. Politik nicht erfüllt - es wurde nichts angewandt."
  fi

  core="$(target_image_ref "$json" core)"
  nodered="$(target_image_ref "$json" nodered)"
  if [ -z "$core" ] || [ -z "$nodered" ]; then
    err "Die geprüfte Zuweisung nennt nicht beide Artefakte (core/nodered)."
    die "Unvollständiges Release - es wurde nichts angewandt."
  fi
  # Dieselbe strenge Prüfung wie bei --core-image: was hier durchkommt, geht in
  # die .env und in eine docker-Kommandozeile.
  if ! valid_image_ref "$core"; then die "Ungültige core-Referenz in der Zuweisung: ${core}"; fi
  if ! valid_image_ref "$nodered"; then die "Ungültige nodered-Referenz in der Zuweisung: ${nodered}"; fi
  case "$core" in *@sha256:*) ;; *) die "Die core-Referenz ist kein Digest-Pin: ${core}" ;; esac
  case "$nodered" in *@sha256:*) ;; *) die "Die nodered-Referenz ist kein Digest-Pin: ${nodered}" ;; esac

  PIN_CORE_IMAGE="$core"
  PIN_NODERED_IMAGE="$nodered"
  TARGET_RELEASE="$release"
  TARGET_RELEASE_SEQ="$seq"
  ok "Zuweisung geprüft: ${release} (Stand ${seq:-?}) - vom Gerät selbst verifiziert."
  info "  core:    ${core}"
  info "  nodered: ${nodered}"
}

# Nach einem erfolgreichen Lauf meldet das GERÄT den angewandten Stand zurück.
# Der Aufruf kann nur bestätigen, was nachweislich läuft (der Core prüft den
# Release gegen seine eigene Build-Stempelung) und hebt den Anti-Rollback-Boden
# nur je an - deshalb ist er ungefährlich und deshalb ist er ehrlich.
report_applied_target() {
  [ "$FROM_TARGET" -eq 1 ] || return 0
  [ "$DRY_RUN" -eq 0 ] || return 0
  [ -n "$TARGET_RELEASE" ] || return 0
  case "$VERIFY_RESULT" in FAIL*) return 0 ;; esac
  command -v curl >/dev/null 2>&1 || return 0

  local body out
  body="{\"release\":\"${TARGET_RELEASE}\",\"release_seq\":${TARGET_RELEASE_SEQ:-0}}"
  out="$(curl -fsS --max-time 5 -X POST -H 'Content-Type: application/json' \
        -d "$body" "http://127.0.0.1:${ACTIVE_WEB_PORT}/api/ota/applied" 2>/dev/null || true)"
  if [ -z "$out" ]; then
    warn "Das Gerät hat den angewandten Stand nicht bestätigt - im Portal erscheint er"
    warn "erst, wenn der laufende Build das zugewiesene Release IST."
    return 0
  fi
  ok "Angewandter Stand aufgezeichnet: ${TARGET_RELEASE} - das Portal sieht ihn beim nächsten Herzschlag."
}

validate_compose_config() {
  if [ "$DOCKER_AVAILABLE" -eq 0 ]; then
    warn "Compose-Validierung übersprungen (Docker nicht verfügbar)."
    return
  fi
  local errlog; errlog="$(mktemp)"
  if dcu config >/dev/null 2>"$errlog"; then
    ok "'docker compose config' ist valide."
    rm -f "$errlog"
  else
    err "'docker compose config' ist fehlerhaft:"
    sed 's/^/      /' "$errlog" >&2 || true
    rm -f "$errlog"
    die "Compose-Konfiguration ungültig - es wurde nichts gestartet."
  fi
}

refresh_compose() {
  step "3/5  Compose-Datei(en) + Image-Version auf den aktuellen Stand bringen"
  apply_image_pin
  case "$MODEL" in
    installer) refresh_generated_compose ;;
    repo)      refresh_repo_compose ;;
    foreign)   refresh_foreign_compose ;;
  esac
  refresh_hostnet_file
  validate_compose_config
}

# =========================================================================
# STEP 4 - Pull the current images + recreate the containers.
# =========================================================================
update_containers() {
  step "4/5  Images ziehen und Container aktualisieren"
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "Dry-Run: 'docker compose pull' und 'up -d --remove-orphans' werden übersprungen."
    return
  fi

  if [ "$SKIP_PULL" -eq 1 ]; then
    warn "--skip-pull: 'docker compose pull' übersprungen (nur Compose-Refresh + 'up -d')."
  else
    if ! registry_config_has_auth; then
      warn "Keine Anmeldung an ${REGISTRY} gefunden."
      if [ "$NON_INTERACTIVE" -eq 0 ]; then
        docker login "$REGISTRY" || die "Anmeldung an ${REGISTRY} fehlgeschlagen."
      else
        warn "Der Pull kann fehlschlagen - vorab ausführen: docker login ${REGISTRY}"
      fi
    fi
    info "Ziehe die aktuellen Registry-Images ..."
    if ! dcu pull core nodered; then
      err "Das Ziehen der Images ist fehlgeschlagen."
      info "Häufige Ursachen: nicht an ${REGISTRY} angemeldet, keine Netzverbindung."
      info "Die laufenden Container sind unverändert - es wurde nichts gestoppt."
      die "Image-Pull fehlgeschlagen."
    fi
    ok "Images gezogen."
  fi

  info "Aktualisiere die Container (up -d --remove-orphans, Volumes bleiben erhalten) ..."
  if ! dcu up -d --remove-orphans; then
    err "'docker compose up -d --remove-orphans' ist fehlgeschlagen."
    rollback_hints
    die "Start fehlgeschlagen."
  fi
  ok "Container laufen auf dem neuen Stand (Node-RED-Vorlagen aktualisieren sich beim Start selbst)."
  print_image_digests
}

# Print the RESOLVED image references + their registry digests after the
# update, so the operator can record them as the rollback target of the NEXT
# update (--core-image/--nodered-image take exactly these strings).
print_image_digests() {
  [ "$DOCKER_AVAILABLE" -eq 1 ] || return 0
  local refs ref digest
  refs="$(dcu config --images 2>/dev/null || true)"
  [ -n "$refs" ] || return 0

  echo
  info "${C_BOLD}Laufende Images - für einen späteren Rollback notieren:${C_RESET}"
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    digest="$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$ref" 2>/dev/null || true)"
    if [ -n "$digest" ]; then
      info "  ${digest}"
    else
      info "  ${ref}   (kein Registry-Digest bekannt - lokal gebautes Image?)"
    fi
  done <<EOF
${refs}
EOF
  info "Zurückrollen auf genau diesen Stand:"
  info "  ${C_CYAN}./update.sh --core-image <core@sha256:...> --nodered-image <nodered@sha256:...>${C_RESET}"
}

rollback_hints() {
  echo
  info "${C_BOLD}Diagnose / Rollback${C_RESET} (in ${TARGET_DIR}):"
  info "  Status:   docker compose ps"
  info "  Logs:     docker compose logs --tail=100 core nodered"
  info "  Neustart: docker compose up -d"
  if [ "$MODEL" = "repo" ]; then
    info "  Rollback: git -C '${TARGET_DIR}' log --oneline -5   (vorherigen Stand finden)"
    info "            git -C '${TARGET_DIR}' checkout <commit> -- docker-compose.yml docker-compose.hostnet.yml"
    info "            danach: docker compose up -d"
  fi
  info "  Defektes Image - auf den zuvor notierten Stand zurückrollen:"
  info "    ${C_CYAN}./update.sh --core-image <ref@sha256:...> --nodered-image <ref@sha256:...>${C_RESET}"
  info "    oder auf einen bekannten Tag: ${C_CYAN}./update.sh --tag <tag>${C_RESET}"
  info "    ('docker images --digests' zeigt die lokal vorhandenen Stände;"
  info "     ./update.sh --latest löst den Pin wieder) - oder VoltPilot kontaktieren."
  info "  Die Datenvolumes (vp-edge-data / vp-nodered-data) sind unberührt - NIEMALS 'down -v' ausführen."
}

# =========================================================================
# STEP 5 - Verify via the core's local /health endpoint.
# =========================================================================
verify_update() {
  step "5/5  Verifizierung (/health)"
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "Dry-Run: keine Container gestartet - Verifizierung übersprungen."
    VERIFY_RESULT="übersprungen (Dry-Run)"
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl ist nicht installiert - /health kann nicht automatisch geprüft werden."
    info "Manuell prüfen: http://$(detect_lan_ip):${ACTIVE_WEB_PORT}"
    VERIFY_RESULT="nicht geprüft (curl fehlt)"
    return
  fi

  local json
  if ! json="$(wait_for_core)"; then
    err "Der Core hat sich innerhalb von 90 s nicht auf /health gemeldet."
    rollback_hints
    VERIFY_RESULT="FAIL"
    return
  fi

  local pairing cloud uptime containers_ok=1
  pairing="$(json_field "$json" pairing_state)"
  cloud="$(json_field "$json" cloud_connected)"
  uptime="$(json_field "$json" uptime_seconds)"
  ok "Webansicht erreichbar (/health, Uptime ${uptime:-?} s)."

  if dcu ps --status running --services 2>/dev/null | grep -qx core \
     && dcu ps --status running --services 2>/dev/null | grep -qx nodered; then
    ok "Beide Container laufen (core + nodered)."
  else
    err "Nicht beide Container laufen."
    dcu ps || true
    containers_ok=0
  fi

  case "$pairing" in
    verbunden)
      ok "Pairing-Zustand: verbunden." ;;
    warte_auf_beanspruchung|zertifikat_erhalten)
      ok "Pairing-Zustand: ${pairing} (normal, solange die Referenz nicht beansprucht ist)." ;;
    cloud_getrennt|cloud_fehler)
      warn "Pairing-Zustand: ${pairing} - die Cloud-Verbindung wird nach dem Neustart neu aufgebaut." ;;
    portal_nicht_erreichbar)
      err "Das Gerät erreicht das Portal NICHT (${pairing}) - Internet/Firewall prüfen."
      containers_ok=0 ;;
    geraet_fehler)
      err "Lokaler Gerätefehler (${pairing}) - Logs prüfen: docker compose logs core"
      containers_ok=0 ;;
    *)
      warn "Pairing-Zustand: ${pairing:-unbekannt}." ;;
  esac

  # A previously claimed device should get its cloud link back shortly after
  # the restart - give it up to 2 minutes before judging.
  if [ "$cloud" != "true" ]; then
    case "$pairing" in
      verbunden|zertifikat_erhalten|cloud_getrennt|cloud_fehler)
        info "Warte bis zu 120 s auf die Cloud-Verbindung ..."
        local waited=0 j=""
        while [ "$waited" -lt 120 ]; do
          sleep 10; waited=$((waited + 10))
          j="$(health_json)"
          cloud="$(json_field "$j" cloud_connected)"
          pairing="$(json_field "$j" pairing_state)"
          [ "$cloud" = "true" ] && break
          printf '    %s... %ss (Pairing: %s)%s\n' "${C_DIM}" "$waited" "${pairing:-?}" "${C_RESET}"
        done ;;
    esac
  fi

  if [ "$cloud" = "true" ]; then
    ok "Cloud-Verbindung steht (cloud_connected=true)."
  else
    case "$pairing" in
      warte_auf_beanspruchung|referenz_unbekannt|start|"")
        info "Keine Cloud-Verbindung - erwartet, solange die Referenz nicht beansprucht ist." ;;
      *)
        warn "Cloud-Verbindung noch nicht wieder aufgebaut (cloud_connected=false)."
        info "Später prüfen: curl -s http://127.0.0.1:${ACTIVE_WEB_PORT}/health" ;;
    esac
  fi

  FINAL_PAIRING="$pairing"
  FINAL_CLOUD="$cloud"
  if [ "$containers_ok" -eq 0 ]; then
    VERIFY_RESULT="FAIL"
    rollback_hints
  elif [ "$cloud" = "true" ]; then
    VERIFY_RESULT="PASS (verbunden)"
  else
    case "$pairing" in
      warte_auf_beanspruchung|zertifikat_erhalten|start|"")
        VERIFY_RESULT="PASS (bereit; Cloud-Verbindung nach dem Beanspruchen)" ;;
      *)
        VERIFY_RESULT="PASS (mit Warnung: Cloud-Verbindung noch nicht wieder da - beobachten)" ;;
    esac
  fi
}

print_update_summary() {
  echo
  printf '%s────────────────────────────────────────────────────────%s\n' "${C_BOLD}" "${C_RESET}"
  printf '%s VoltPilot Edge-App - Update-Zusammenfassung%s\n' "${C_BOLD}" "${C_RESET}"
  printf '%s────────────────────────────────────────────────────────%s\n' "${C_BOLD}" "${C_RESET}"
  info "Deploy-Modell:     ${MODEL}$( [ "$HOSTNET_ACTIVE" -eq 1 ] && printf ' (+ Host-Netz-Override)' )"
  local pin_tag pin_core pin_nodered
  pin_tag="$(env_get VP_EDGE_IMAGE_TAG "$ENV_FILE")"
  pin_core="$(env_get VP_EDGE_CORE_IMAGE "$ENV_FILE")"
  pin_nodered="$(env_get VP_EDGE_NODERED_IMAGE "$ENV_FILE")"
  if [ -n "$pin_core" ] || [ -n "$pin_nodered" ]; then
    info "Image-Version:     gepinnt (core=${pin_core:-<Tag>}, nodered=${pin_nodered:-<Tag>})"
  else
    info "Image-Version:     ${pin_tag:-latest}"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    info "Dry-Run abgeschlossen: nichts geschrieben, nichts gezogen, nichts gestartet."
    return
  fi
  info "Pairing-Zustand:   ${FINAL_PAIRING:-unbekannt}"
  info "Cloud-Verbindung:  ${FINAL_CLOUD:-unbekannt}"
  case "$VERIFY_RESULT" in
    PASS*) printf '    Verifizierung:     %s%s%s\n' "${C_GREEN}" "$VERIFY_RESULT" "${C_RESET}" ;;
    FAIL*) printf '    Verifizierung:     %s%s%s\n' "${C_RED}"   "$VERIFY_RESULT" "${C_RESET}" ;;
    *)     printf '    Verifizierung:     %s\n' "$VERIFY_RESULT" ;;
  esac
  echo
  info "Nützliche Befehle (in ${TARGET_DIR}):"
  info "  Status:  docker compose ps"
  info "  Logs:    docker compose logs -f core"
  info "  Update:  ./update.sh   (Compose aktuell halten + neue Images, Volumes bleiben)"
}

# =========================================================================
# main
# =========================================================================
update_main() {
  parse_args "$@"

  # Print modes: emit a template and exit. Write nothing, need no docker.
  if [ "$PRINT_COMPOSE" -eq 1 ]; then
    generate_compose
    exit 0
  fi
  if [ "$PRINT_HOSTNET" -eq 1 ]; then
    generate_hostnet_compose
    exit 0
  fi

  printf '%s%sVoltPilot Edge-App - sicheres Update%s\n' "${C_BOLD}" "${C_CYAN}" "${C_RESET}"
  printf '%sArbeitsverzeichnis: %s%s\n' "${C_DIM}" "$TARGET_DIR" "${C_RESET}"
  [ "$DRY_RUN" -eq 1 ] && printf '%sModus: DRY-RUN (nur prüfen)%s\n' "${C_YELLOW}" "${C_RESET}"

  update_prerequisites
  detect_deployment
  resolve_target_pin
  refresh_compose
  update_containers
  verify_update
  report_applied_target
  print_update_summary

  case "$VERIFY_RESULT" in
    FAIL*) exit 1 ;;
  esac
}

# Source guard (same pattern as install.sh): sourcing defines everything but
# runs nothing, so the self-check can exercise single functions (e.g. the
# .env pin writer) directly. Direct execution behaves exactly as before.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  update_main "$@"
fi
