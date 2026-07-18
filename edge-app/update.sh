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
#      with the pairing/cloud state plus rollback guidance on failure.
#
# Hard safety rules: never `down -v`, never touches the data volumes
# (vp-edge-data / vp-nodered-data) or the device identity, never rewrites the
# .env (secrets stay untouched, permissions kept at 600), never sets the
# VP_DEV_* dev hatches, never echoes secrets.
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
die .env wird NIE verändert (Geheimnisse bleiben, Rechte 600), die
VP_DEV_*-Schalter werden nie gesetzt, eine handbearbeitete Compose-Datei
wird nie ohne --force-compose überschrieben.

${C_BOLD}Aufruf:${C_RESET}
  ./update.sh [Optionen]        (im Deploy-Verzeichnis ausführen)

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
EOF
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
      *) err "Unbekannte Option: $1"; echo; usage; exit 2 ;;
    esac
    shift
  done
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
  step "3/5  Compose-Datei(en) auf den aktuellen Stand bringen"
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
  info "  Defektes Image: das vorherige Image per Digest in der Compose-Datei pinnen"
  info "  ('docker images --digests' zeigt die lokalen Stände; image: ...@sha256:<digest>),"
  info "  dann 'docker compose up -d' - oder VoltPilot kontaktieren."
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
  refresh_compose
  update_containers
  verify_update
  print_update_summary

  case "$VERIFY_RESULT" in
    FAIL*) exit 1 ;;
  esac
}

update_main "$@"
