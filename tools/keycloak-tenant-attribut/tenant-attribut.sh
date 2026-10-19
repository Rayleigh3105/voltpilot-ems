#!/usr/bin/env bash
# tenant-attribut.sh - Diagnose und Reparatur des Keycloak-Attributs tenant_id (VoltPilot, Realm voltpilot).
#
# Läuft auf dem Betriebsrechner (k3s-1). kcadm läuft im Keycloak-Pod (kubectl exec), die Auswertung
# lokal mit python3 (tenant_attribut.py daneben). Das Skript fragt NIE nach Passwörtern und gibt keine
# aus: kcadm meldet sich vorher selbst an (Unterbefehl anmelden zeigt den Befehl), Clients werden nur
# mit --fields id,clientId gelesen (ein voller Client-Abruf enthält das Client-Secret im Klartext).
#
#   anmelden                       zeigt den Anmeldebefehl für kcadm und prüft, ob die Anmeldung gilt
#   profil                         User-Profil + Token-Mapper prüfen (nur lesend; Exit 0 gut, 1 Fehler, 3 kritisch)
#   profil-angleichen [--ausfuehren]  tenant_id-Deklaration (nur admin schreibt) + ADMIN_EDIT wie im Import;
#                                  Vorgabe: nur die Abweichung zeigen
#   sweep                          alle Konten + DB-Wahrheit -> befund.txt, befund.csv, plan.csv (nur lesend)
#   reparatur PLAN [--ausfuehren]  tenant_id je Planzeile setzen; Vorgabe: Trockenlauf
#   token KONTO                    Rollen + tenant_id des Beispiel-Tokens eines Kontos (Name oder Kennung)
#   aufraeumen                     die kcadm-Anmeldung aus dem Pod entfernen
#
# Umgebung (alle optional):
#   KUBECTL   Befehl für kubectl              Vorgabe: "sudo kubectl"
#   NS        Namespace                       Vorgabe: voltpilot-prod
#   KC_ZIEL   Ziel für exec                   Vorgabe: deploy/keycloak (bei mehreren Replikaten: pod/<name>)
#   KC_SERVER kcadm-Server im Pod             Vorgabe: http://localhost:8080/auth
#   REALM     Realm                           Vorgabe: voltpilot
#   AUS       Ausgabeordner (sweep)           Vorgabe: ./tenant-attribut-<UTC-Zeitstempel>
#   VP_DB_URL psql-Verbindung (BYPASSRLS)     für den DB-Teil des sweep
#   DB_PSQL   anderer psql-Befehl, liest SQL von stdin, schreibt CSV nach stdout
#   DB_CSV    fertige Ausgabe von db-wahrheit.sql (statt VP_DB_URL/DB_PSQL)
#   KCADM_LOKAL  Pfad zu einem lokalen kcadm.sh statt kubectl (nur Labor/Test)
set -euo pipefail
umask 077

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$HIER/tenant_attribut.py"
SQL="$HIER/db-wahrheit.sql"
read -r -a KCTL <<< "${KUBECTL:-sudo kubectl}"
NS="${NS:-voltpilot-prod}"
KC_ZIEL="${KC_ZIEL:-deploy/keycloak}"
KC_SERVER="${KC_SERVER:-http://localhost:8080/auth}"
R="${REALM:-voltpilot}"

die() { echo "ABBRUCH: $*" >&2; exit 2; }
# Ein Arbeitsordner für Zwischenstände; nur er wird beim Ende entfernt.
TMPD="$(mktemp -d)"
trap 'rm -rf "${TMPD:?}"' EXIT
hinweis() { echo "$*" >&2; }

command -v python3 >/dev/null || die "python3 fehlt auf diesem Rechner (nur Standardbibliothek nötig)."
[[ -f "$PY" ]] || die "tenant_attribut.py fehlt neben diesem Skript ($PY)."

# kcadm im Pod. JAVA_TOOL_OPTIONS des Pods schreibt sonst "Picked up ..." in jede Ausgabe.
# Ohne -i: in einer while-read-Schleife würde kubectl sonst die Eingabe der Schleife verschlucken.
# kcadm schreibt bei jedem Aufruf eine Leerzeile nach stderr; leise() lässt nur echte Meldungen durch.
leise() { grep -v '^[[:space:]]*$' >&2 || true; }
kc() {
  if [[ -n "${KCADM_LOKAL:-}" ]]; then "$KCADM_LOKAL" "$@" </dev/null 2> >(leise); return; fi
  "${KCTL[@]}" -n "$NS" exec "$KC_ZIEL" -- \
    bash -c 'unset JAVA_TOOL_OPTIONS; export HOME=/tmp; exec /opt/keycloak/bin/kcadm.sh "$@"' kcadm "$@" </dev/null 2> >(leise)
}
# dasselbe mit stdin (nur für -f -)
kc_ein() {
  if [[ -n "${KCADM_LOKAL:-}" ]]; then "$KCADM_LOKAL" "$@" 2> >(leise); return; fi
  "${KCTL[@]}" -n "$NS" exec -i "$KC_ZIEL" -- \
    bash -c 'unset JAVA_TOOL_OPTIONS; export HOME=/tmp; exec /opt/keycloak/bin/kcadm.sh "$@"' kcadm "$@" 2> >(leise)
}

anmeldebefehl() {
  cat >&2 <<EOF
kcadm ist im Keycloak-Pod nicht (mehr) angemeldet. Anmelden - kcadm fragt das Passwort selbst:

  ${KCTL[*]} -n $NS exec -it $KC_ZIEL -- bash -c 'export HOME=/tmp; /opt/keycloak/bin/kcadm.sh config credentials --server $KC_SERVER --realm master --user <admin>'

<admin> ist der Administrator des Realms master. Hat er den zweiten Faktor, nimmt kcadm sein Passwort
nicht an: dann das Notfall-Konto aus infra/prod/keycloak/live-realm-import.md ("Wenn kcadm oder der
Administrator ausgesperrt ist"). Die Anmeldung gilt 30 Minuten ohne Benutzung; danach erneut.
EOF
}

angemeldet() {
  local aus
  if ! aus="$(kc get "realms/$R" --fields realm --format csv --noquotes 2>&1)"; then
    hinweis "kcadm-Probe gescheitert: $(printf '%s' "$aus" | tail -1)"
    anmeldebefehl
    return 1
  fi
  if [[ "$(printf '%s' "$aus" | tail -1)" != "$R" ]]; then
    hinweis "kcadm-Probe: unerwartete Antwort '$(printf '%s' "$aus" | tail -1)'"
    anmeldebefehl
    return 1
  fi
}

replikate_pruefen() {
  [[ -n "${KCADM_LOKAL:-}" || "$KC_ZIEL" != deploy/* ]] && return 0
  local n
  n="$("${KCTL[@]}" -n "$NS" get "$KC_ZIEL" -o jsonpath='{.status.replicas}' 2>/dev/null || echo "?")"
  if [[ "$n" != "1" ]]; then
    hinweis "WARNUNG: $KC_ZIEL hat $n Replikate. kcadm merkt die Anmeldung je Pod; mit KC_ZIEL=pod/<name> einen Pod festlegen."
  fi
}

client_id() { # interne Kennung eines Clients, nie der volle Client (Secret!)
  kc get clients -r "$R" -q "clientId=$1" --fields id --format csv --noquotes | tail -1
}

profil_holen() { # $1 = Ordner
  kc get users/profile -r "$R" > "$1/profil.json"
  local c id
  kc get clients -r "$R" --fields id,clientId > "$1/clients.json"
  for c in voltpilot-frontend voltpilot-api; do
    id="$(client_id "$c")"
    if [[ -z "$id" ]]; then
      echo "[]" > "$1/mapper-$c.json"; hinweis "WARNUNG: Client $c nicht gefunden."; continue
    fi
    kc get "clients/$id/protocol-mappers/models" -r "$R" > "$1/mapper-$c.json"
  done
}

beispiel_token() { # $1 = Konto-Kennung, $2 = Zieldatei; Token so, wie das Portal (voltpilot-frontend) es bekäme
  kc get "clients/$FRONTEND_ID/evaluate-scopes/generate-example-access-token" -r "$R" \
    -q "userId=$1" -q scope=openid > "$2"
}

konto_kennung() { # Name oder Kennung -> Kennung
  if [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    echo "$1"; return
  fi
  kc get users -r "$R" -q "username=$1" -q exact=true --fields id --format csv --noquotes | tail -1
}

# --------------------------------------------------------------------------------------------- Befehle

cmd_anmelden() {
  replikate_pruefen
  if angemeldet; then echo "kcadm ist angemeldet (Realm $R erreichbar)."; fi
}

cmd_profil() {
  angemeldet || exit 2
  local d="$TMPD/profil"; mkdir -p "$d"
  profil_holen "$d"
  echo "User-Profil und Token-Mapper im Realm $R:"
  set +e; python3 "$PY" profil-pruefen "$d"; local rc=$?; set -e
  case $rc in
    0) echo "Ergebnis: in Ordnung." ;;
    1) echo "Ergebnis: FEHLER - vor jeder Reparatur 'profil-angleichen' (sonst verwirft Keycloak das Attribut still)." ;;
    3) echo "Ergebnis: KRITISCH - Kunden können ihren Kundenbereich selbst wechseln. Sofort 'profil-angleichen'." ;;
  esac
  exit $rc
}

cmd_profil_angleichen() {
  local ausfuehren=0
  [[ "${1:-}" == "--ausfuehren" ]] && ausfuehren=1
  angemeldet || exit 2
  local stempel d; stempel="$(date -u +%Y%m%dT%H%M%SZ)"; d="./profil-$stempel"; mkdir -p "$d"
  profil_holen "$d"
  cp "$d/profil.json" "$d/profil-vorher.json"
  set +e; python3 "$PY" profil-angleichen "$d"; local rc=$?; set -e
  [[ $rc -eq 10 ]] && { echo "Nichts zu tun. Gesichert: $d/profil-vorher.json"; exit 0; }
  [[ $rc -eq 0 ]] || die "Profil nicht lesbar; nichts geändert."
  if [[ $ausfuehren -eq 0 ]]; then
    echo
    echo "TROCKENLAUF: nichts geändert. Oben die Abweichung (live -> neu). Vorher-Stand: $d/profil-vorher.json"
    echo "Schreiben mit: $0 profil-angleichen --ausfuehren"
    exit 0
  fi
  echo "Schreibe das User-Profil (nur tenant_id-Deklaration und unmanagedAttributePolicy) ..."
  kc_ein update users/profile -r "$R" -f - < "$d/profil-neu.json"
  kc get users/profile -r "$R" > "$d/profil.json"
  set +e; python3 "$PY" profil-pruefen "$d"; rc=$?; set -e
  echo "Rückweg (stellt den alten Stand her; ein Profil-Wechsel löscht keine gespeicherten Attribute):"
  echo "  ${KCTL[*]} -n $NS exec -i $KC_ZIEL -- bash -c 'unset JAVA_TOOL_OPTIONS; export HOME=/tmp; /opt/keycloak/bin/kcadm.sh update users/profile -r $R -f -' < $d/profil-vorher.json"
  if [[ $rc -eq 0 ]]; then
    echo "Ergebnis: Profil in Ordnung."
  else
    die "Profil nach dem Schreiben noch nicht in Ordnung (siehe oben)."
  fi
}

cmd_sweep() {
  angemeldet || exit 2
  replikate_pruefen
  local d="${AUS:-./tenant-attribut-$(date -u +%Y%m%dT%H%M%SZ)}"
  mkdir -p "$d/token"
  echo "Ausgabe nach $d (nur für den Betreiber: enthält Namen und E-Mail-Adressen)"
  kc get "realms/$R" --fields realm,eventsEnabled,adminEventsEnabled,eventsExpiration > "$d/realm.txt"
  profil_holen "$d"
  FRONTEND_ID="$(client_id voltpilot-frontend)"
  [[ -n "$FRONTEND_ID" ]] || die "Client voltpilot-frontend nicht gefunden - ohne ihn kein Beispiel-Token."
  # Nur Kennung und Name: damit die Admin-Ereignisse sagen, ob Administration (security-admin-console),
  # kcadm (admin-cli) oder die API (voltpilot-api) etwas geändert hat.
  kc get clients -r master --fields id,clientId > "$d/clients-master.json" 2>/dev/null || echo "[]" > "$d/clients-master.json"
  kc get users -r master --fields id,username > "$d/users-master.json" 2>/dev/null || echo "[]" > "$d/users-master.json"

  local anzahl seite=0 gross=200
  anzahl="$(kc get users/count -r "$R" | tail -1)"
  [[ "$anzahl" =~ ^[0-9]+$ ]] || die "Kontenzahl nicht lesbar: '$anzahl'"
  echo "Konten im Realm: $anzahl"
  : > "$d/users-seiten.txt"
  while (( seite * gross < anzahl )); do
    kc get users -r "$R" --offset $((seite * gross)) --limit "$gross" -q briefRepresentation=false \
      > "$d/users-$seite.json"
    echo "$d/users-$seite.json" >> "$d/users-seiten.txt"
    seite=$((seite + 1))
  done
  python3 - "$d" <<'EOF'
import json, sys, os
d = sys.argv[1]
alle = []
for p in open(os.path.join(d, "users-seiten.txt")).read().split():
    t = open(p, encoding="utf-8").read()
    alle += json.loads(t[t.find("["):])
    os.remove(p)
os.remove(os.path.join(d, "users-seiten.txt"))
json.dump(alle, open(os.path.join(d, "users.json"), "w"), ensure_ascii=False)
print(f"{len(alle)} Konten gelesen", file=sys.stderr)
EOF

  # Beispiel-Token je Konto (außer Dienstkonten): genau das, was TenantFilter sähe - Rollen und Claim.
  local id name n=0 fehler=0 folge=0
  while IFS=';' read -r id name; do
    n=$((n + 1))
    printf '\r  Beispiel-Token %d ... %-40s' "$n" "$name" >&2
    if beispiel_token "$id" "$d/token/$id.json" 2>"$d/token/$id.err"; then
      rm -f "$d/token/$id.err"; folge=0
    else
      fehler=$((fehler + 1)); folge=$((folge + 1)); rm -f "$d/token/$id.json"
      if (( folge >= 3 )); then
        echo >&2; die "drei Beispiel-Token in Folge gescheitert (zuletzt: $(tail -1 "$d/token/$id.err")). Anmeldung prüfen: $0 anmelden"
      fi
    fi
  done < <(python3 -c '
import json, sys
for u in json.load(open(sys.argv[1])):
    if not (u.get("serviceAccountClientId") or str(u.get("username","")).startswith("service-account-")):
        print(u["id"] + ";" + str(u.get("username")))' "$d/users.json")
  echo >&2
  (( fehler == 0 )) || hinweis "WARNUNG: $fehler Beispiel-Token gescheitert (Fehler in $d/token/*.err); diese Konten erscheinen als 'unklar'."

  # Ereignisse: nur vorhanden, wenn der Realm sie speichert (Härtung, 90 Tage).
  kc get admin-events -r "$R" -q resourceTypes=USER_PROFILE -q max=5000 > "$d/admin-ereignisse-profil.json" 2>/dev/null \
    || { echo "[]" > "$d/admin-ereignisse-profil.json"; hinweis "WARNUNG: Admin-Ereignisse (Profil) nicht lesbar."; }
  kc get admin-events -r "$R" -q resourceTypes=USER -q max=50000 > "$d/admin-ereignisse-konten.json" 2>/dev/null \
    || { echo "[]" > "$d/admin-ereignisse-konten.json"; hinweis "WARNUNG: Admin-Ereignisse (Konten) nicht lesbar."; }
  kc get events -r "$R" -q type=LOGIN -q max=50000 > "$d/anmeldungen.json" 2>/dev/null \
    || { echo "[]" > "$d/anmeldungen.json"; hinweis "WARNUNG: Anmelde-Ereignisse nicht lesbar."; }

  # DB-Wahrheit
  if [[ -n "${DB_CSV:-}" ]]; then
    cp "$DB_CSV" "$d/db.csv"
  elif [[ -n "${DB_PSQL:-}" ]]; then
    bash -c "$DB_PSQL" < "$SQL" > "$d/db.csv" || die "DB-Teil gescheitert ($DB_PSQL). Keycloak-Teil liegt in $d."
  elif [[ -n "${VP_DB_URL:-}" ]] && command -v psql >/dev/null; then
    psql "$VP_DB_URL" -X -q --csv -v ON_ERROR_STOP=1 -f "$SQL" -o "$d/db.csv" \
      || die "DB-Teil gescheitert (psql). Keycloak-Teil liegt in $d."
  else
    hinweis "WARNUNG: kein DB-Teil (VP_DB_URL+psql, DB_PSQL oder DB_CSV). Befund ohne Ziel-Kundenbereich, Plan bleibt leer."
  fi
  python3 "$PY" auswerten "$d"
  echo "Dateien: $d/befund.txt  $d/befund.csv  $d/plan.csv"
}

cmd_reparatur() {
  local plan="${1:-}" ausfuehren=0 alt_ok=0 a
  [[ -n "$plan" && -f "$plan" ]] || die "Aufruf: $0 reparatur PLAN.csv [--ausfuehren] [--plan-alt-ok]"
  shift
  for a in "$@"; do
    case "$a" in
      --ausfuehren) ausfuehren=1 ;;
      --plan-alt-ok) alt_ok=1 ;;
      *) die "unbekannte Angabe: $a" ;;
    esac
  done
  local zeilen
  zeilen="$(python3 "$PY" plan-lesen "$plan")" || die "Plan fehlerhaft (siehe oben); nichts geändert."
  [[ -n "$zeilen" ]] || { echo "Plan ohne Datenzeilen: nichts zu tun."; exit 0; }
  local alter_h
  alter_h="$(python3 -c '
import os, sys, time, re, datetime as dt
kopf = open(sys.argv[1], encoding="utf-8").readline()
m = re.search(r"erstellt (\S+Z)", kopf)
t = dt.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc).timestamp() if m else os.path.getmtime(sys.argv[1])
print(int((time.time() - t) / 3600))' "$plan")"
  if (( alter_h > 48 && alt_ok == 0 )); then
    die "Plan ist $alter_h Stunden alt. Neuen sweep fahren oder bewusst --plan-alt-ok angeben."
  fi
  angemeldet || exit 2
  replikate_pruefen

  # Vorbedingung: das Profil muss tenant_id für admin schreibbar halten, sonst verwirft Keycloak den Wert still.
  local pd="$TMPD/vorbedingung"; mkdir -p "$pd"
  profil_holen "$pd"
  set +e; python3 "$PY" profil-pruefen "$pd" > "$pd/urteil.txt"; local prc=$?; set -e
  if (( prc != 0 )); then
    cat "$pd/urteil.txt"
    die "Profil/Mapper nicht in Ordnung. Erst '$0 profil-angleichen --ausfuehren', dann die Reparatur."
  fi
  FRONTEND_ID="$(client_id voltpilot-frontend)"
  [[ -n "$FRONTEND_ID" ]] || die "Client voltpilot-frontend nicht gefunden."

  local log w="$TMPD/konto"
  log="./reparatur-$(date -u +%Y%m%dT%H%M%SZ).log"
  mkdir -p "$w"
  local modus="TROCKENLAUF"; (( ausfuehren )) && modus="AUSFÜHREN"
  echo "Reparatur $modus, Plan $plan, Realm $R - Protokoll $log" | tee "$log"
  local id name ziel quelle urteil n_setzen=0 n_schon=0 n_fehler=0 n_ok=0
  while IFS=';' read -r id name ziel quelle; do
    if ! kc get "users/$id" -r "$R" > "$w/u.json" 2>"$w/u.err"; then
      echo "FEHLT    $name ($id): Konto nicht lesbar ($(tail -1 "$w/u.err"))" | tee -a "$log"; n_fehler=$((n_fehler + 1)); continue
    fi
    if ! beispiel_token "$id" "$w/t.json" 2>"$w/t.err"; then
      echo "FEHLER   $name ($id): Beispiel-Token nicht lesbar ($(tail -1 "$w/t.err"))" | tee -a "$log"; n_fehler=$((n_fehler + 1)); continue
    fi
    set +e; urteil="$(python3 "$PY" konto-pruefen "$w/u.json" "$w/t.json" "$ziel" "$name")"; local rc=$?; set -e
    case "$urteil" in
      SCHON*) echo "UNVERÄNDERT $name ($id): ${urteil#SCHON }" | tee -a "$log"; n_schon=$((n_schon + 1)); continue ;;
      SETZEN*) ;;
      *) echo "ÜBERSPRUNGEN $name ($id): $urteil" | tee -a "$log"; n_fehler=$((n_fehler + 1)); continue ;;
    esac
    if (( ausfuehren == 0 )); then
      echo "WÜRDE SETZEN $name ($id): tenant_id=$ziel [$quelle] - ${urteil#SETZEN }" | tee -a "$log"
      n_setzen=$((n_setzen + 1)); continue
    fi
    # Nur dieses eine Attribut; kcadm liest das Konto und schreibt es zusammengeführt zurück (andere Attribute bleiben).
    if ! kc update "users/$id" -r "$R" -s "attributes.tenant_id=[\"$ziel\"]" 2>"$w/s.err"; then
      echo "FEHLER   $name ($id): Setzen gescheitert ($(tail -1 "$w/s.err"))" | tee -a "$log"; n_fehler=$((n_fehler + 1)); continue
    fi
    kc get "users/$id" -r "$R" > "$w/u.json" 2>/dev/null || : > "$w/u.json"
    beispiel_token "$id" "$w/t.json" 2>/dev/null || : > "$w/t.json"
    set +e; urteil="$(python3 "$PY" konto-pruefen "$w/u.json" "$w/t.json" "$ziel" "$name")"; set -e
    if [[ "$urteil" == SCHON* ]]; then
      echo "GESETZT  $name ($id): tenant_id=$ziel, Token trägt den Claim" | tee -a "$log"; n_ok=$((n_ok + 1))
    else
      echo "FEHLER   $name ($id): nach dem Setzen: $urteil (Keycloak hat den Wert verworfen? Profil prüfen)" | tee -a "$log"
      n_fehler=$((n_fehler + 1))
    fi
  done <<< "$zeilen"
  echo "Summe: gesetzt $n_ok, würde setzen $n_setzen, unverändert $n_schon, Fehler/übersprungen $n_fehler" | tee -a "$log"
  if (( ausfuehren )); then
    cat <<'EOF'
Danach:
  - Angemeldete Kunden bekommen den Claim mit dem nächsten Token-Refresh (spätestens nach 15 Minuten);
    die Portal-Seite neu laden oder ab- und wieder anmelden zeigt die Daten sofort.
  - Konten OHNE Spiegel in der Datenbank haben noch keine Rechte im Kundenbereich: der Bestandslauf nimmt
    sie beim nächsten api-Start auf und macht ein Konto ohne je eine Zuweisung zum Kundenadministrator.
  - Prüfen: tenant-attribut.sh token <konto>
EOF
  else
    echo "TROCKENLAUF: nichts geändert. Schreiben mit: $0 reparatur $plan --ausfuehren"
  fi
  (( n_fehler == 0 )) || exit 1
}

cmd_token() {
  [[ -n "${1:-}" ]] || die "Aufruf: $0 token <Benutzername|Kennung>"
  angemeldet || exit 2
  FRONTEND_ID="$(client_id voltpilot-frontend)"
  [[ -n "$FRONTEND_ID" ]] || die "Client voltpilot-frontend nicht gefunden."
  local id; id="$(konto_kennung "$1")"
  [[ -n "$id" ]] || die "Konto '$1' nicht gefunden."
  local t="$TMPD/token.json"
  beispiel_token "$id" "$t" || die "Beispiel-Token für $id nicht lesbar."
  python3 "$PY" token-zeigen "$t"
}

cmd_aufraeumen() {
  [[ -n "${KCADM_LOKAL:-}" ]] && { echo "Labor: nichts zu tun."; return; }
  "${KCTL[@]}" -n "$NS" exec "$KC_ZIEL" -- rm -f /opt/keycloak/.keycloak/kcadm.config
  echo "kcadm-Anmeldung im Pod entfernt."
}

case "${1:-}" in
  anmelden) cmd_anmelden ;;
  profil) cmd_profil ;;
  profil-angleichen) shift; cmd_profil_angleichen "$@" ;;
  sweep) cmd_sweep ;;
  reparatur) shift; cmd_reparatur "$@" ;;
  token) shift; cmd_token "$@" ;;
  aufraeumen) cmd_aufraeumen ;;
  *) sed -n '2,32p' "$0"; exit 2 ;;
esac
