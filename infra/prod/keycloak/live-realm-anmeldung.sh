#!/usr/bin/env bash
# UEMS AP-20 IP-20 (E12 = A, BT6): Anmelde-Haertung eines BESTEHENDEN Realms - dieselben Werte und Ablaeufe
# wie der Import voltpilot-realm.json (der Import allein aendert keinen bestehenden Realm).
#
#   angleichen  setzt Ereignisse (90 Tage), Passwort-Vorgabe und den bedingten zweiten Faktor, bindet die
#               Ablaeufe. Gebunden wird erst, wenn beide Ablaeufe vollstaendig sind (Schritt fuer Schritt wie
#               der Import, samt Rollen-Bedingung). Ein zweiter Lauf legt nichts doppelt an. Nach einem
#               abgebrochenen Lauf entfernt der naechste die unvollstaendigen, ungebundenen Ablaeufe
#               (voltpilot-browser, voltpilot-direct-grant samt Unterablaeufen) und baut sie neu. Weicht ein
#               GEBUNDENER Ablauf ab, aendert er nichts und sagt, was zu tun ist (Exit 3).
#   pruefen     liest nur; Exit 0 = der Realm traegt die Haertung, sonst eine Zeile je Abweichung
#
# Laeuft dort, wo kcadm.sh liegt (im Keycloak-Pod) und NACH `kcadm.sh config credentials ...`.
# Nur Bash-Bordmittel (ab 4.4): das Keycloak-Image hat kein jq. Anleitung und Bestaetigung: live-realm-import.md.
# ProduktionsRealmImportTest faehrt beide Modi gegen einen Realm ohne Haertung und vergleicht mit dem Import,
# bricht einen Lauf mittendrin ab und verstellt die Rollen-Bedingungen.
set -euo pipefail

MODUS="${1:-}"
R="${REALM:-voltpilot}"
KC="${KCADM:-/opt/keycloak/bin/kcadm.sh}"
VORGABE='length(12) and notUsername and passwordHistory(3)'
NEUNZIG_TAGE=7776000

OBEN=(voltpilot-browser voltpilot-direct-grant)   # die zwei obersten Ablaeufe, in dieser Reihenfolge

# Im Cluster setzt der Pod JAVA_TOOL_OPTIONS fuer den Server; Java schriebe sonst bei jedem Aufruf von kcadm
# "Picked up JAVA_TOOL_OPTIONS: ..." zwischen die Zeilen dieses Skripts. kcadm braucht die Angabe nicht.
kc() { (unset JAVA_TOOL_OPTIONS; "$KC" "$@"); }

# Reihenfolge: Ablauf|Elternablauf|Anforderung|Beschreibung  (Elternablauf leer = oben)
ABLAEUFE=(
  "voltpilot-browser||-|Browser-Anmeldung (UEMS AP-20 IP-20, E12): zweiter Faktor Pflicht fuer platform-admin (VoltPilot-Betrieb), fuer alle anderen Konten waehlbar"
  "voltpilot-browser-formular|voltpilot-browser|ALTERNATIVE|Benutzername und Passwort, danach der zweite Faktor je Konto"
  "voltpilot-browser-otp-betrieb|voltpilot-browser-formular|CONDITIONAL|platform-admin: OTP Pflicht; ohne eingerichtetes OTP verlangt Keycloak die Einrichtung bei dieser Anmeldung"
  "voltpilot-browser-otp-gewaehlt|voltpilot-browser-formular|CONDITIONAL|Alle anderen Konten: OTP nur, wenn das Konto es selbst eingerichtet hat"
  "voltpilot-direct-grant||-|Passwort-Grant (UEMS AP-20 IP-20, E12): kein Token fuer platform-admin, OTP fuer Konten, die es eingerichtet haben"
  "voltpilot-direct-grant-betrieb|voltpilot-direct-grant|CONDITIONAL|platform-admin: kein Passwort-Grant - Betriebskonten melden sich nur im Browser mit zweitem Faktor an"
  "voltpilot-direct-grant-otp-gewaehlt|voltpilot-direct-grant|CONDITIONAL|Alle anderen Konten: OTP nur, wenn das Konto es selbst eingerichtet hat"
)
# Schritte je Ablauf in Reihenfolge: Ablauf|Anbieter|Anforderung|Konfiguration (leer, betrieb, nicht-betrieb)
SCHRITTE=(
  "voltpilot-browser|auth-cookie|ALTERNATIVE|"
  "voltpilot-browser|identity-provider-redirector|ALTERNATIVE|"
  "voltpilot-browser|@voltpilot-browser-formular||"
  "voltpilot-browser-formular|auth-username-password-form|REQUIRED|"
  "voltpilot-browser-formular|@voltpilot-browser-otp-betrieb||"
  "voltpilot-browser-formular|@voltpilot-browser-otp-gewaehlt||"
  "voltpilot-browser-otp-betrieb|conditional-user-role|REQUIRED|betrieb"
  "voltpilot-browser-otp-betrieb|auth-otp-form|REQUIRED|"
  "voltpilot-browser-otp-gewaehlt|conditional-user-role|REQUIRED|nicht-betrieb"
  "voltpilot-browser-otp-gewaehlt|conditional-user-configured|REQUIRED|"
  "voltpilot-browser-otp-gewaehlt|auth-otp-form|REQUIRED|"
  "voltpilot-direct-grant|direct-grant-validate-username|REQUIRED|"
  "voltpilot-direct-grant|direct-grant-validate-password|REQUIRED|"
  "voltpilot-direct-grant|@voltpilot-direct-grant-betrieb||"
  "voltpilot-direct-grant|@voltpilot-direct-grant-otp-gewaehlt||"
  "voltpilot-direct-grant-betrieb|conditional-user-role|REQUIRED|betrieb"
  "voltpilot-direct-grant-betrieb|deny-access-authenticator|REQUIRED|"
  "voltpilot-direct-grant-otp-gewaehlt|conditional-user-role|REQUIRED|nicht-betrieb"
  "voltpilot-direct-grant-otp-gewaehlt|conditional-user-configured|REQUIRED|"
  "voltpilot-direct-grant-otp-gewaehlt|direct-grant-validate-otp|REQUIRED|"
)

zeilen() { # Ausgabe von kcadm als Zeilen in das Feld ZEILEN (leere Ausgabe = leeres Feld)
  ZEILEN=()
  local z
  while IFS= read -r z; do
    if [[ -n "$z" ]]; then ZEILEN+=("$z"); fi
  done <<< "$1"
  return 0
}

# Id eines obersten Ablaufs; Status 1, wenn es ihn nicht gibt. Unterablaeufe stehen nicht in dieser Liste.
ablauf_id() {
  zeilen "$(kc get authentication/flows -r "$R" --fields id,alias --format csv --noquotes)"
  local z
  for z in "${ZEILEN[@]}"; do
    if [[ "${z#*,}" == "$1" ]]; then echo "${z%%,*}"; return 0; fi
  done
  return 1
}

# Id der Ausfuehrung eines Unterablaufs (Ebene 0) im Elternablauf
unterablauf_id() {
  zeilen "$(kc get "authentication/flows/$1/executions" -r "$R" --fields id,displayName,level --format csv --noquotes)"
  local z id name ebene
  for z in "${ZEILEN[@]}"; do
    IFS=, read -r id name ebene <<< "$z"
    if [[ "$name" == "$2" && "$ebene" == "0" ]]; then echo "$id"; return 0; fi
  done
  return 1
}

anforderung() { # Ablauf Ausfuehrungs-Id Anforderung Prioritaet
  kc update "authentication/flows/$1/executions" -r "$R" \
    -b "{\"id\":\"$2\",\"requirement\":\"$3\",\"priority\":$4}"
}

bedingung_soll() { # Kuerzel aus SCHRITTE -> Rolle/negate, wie bedingung_ist es liest
  case "$1" in
    betrieb) echo "platform-admin/negate=false" ;;
    nicht-betrieb) echo "platform-admin/negate=true" ;;
    *) echo "" ;;
  esac
}

bedingung_ist() { # JSON einer Authenticator-Konfiguration -> Rolle/negate
  local rolle="?" negate="?"
  if [[ "$1" =~ \"condUserRole\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then rolle="${BASH_REMATCH[1]}"; fi
  if [[ "$1" =~ \"negate\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then negate="${BASH_REMATCH[1]}"; fi
  echo "$rolle/negate=$negate"
}

# SOLL und IST haben dieselbe Form, eine Zeile je Schritt in der Reihenfolge des Ablaufs:
#   Elternablauf|Anbieter oder @Unterablauf|Anforderung|Bedingung
soll_bild() { # Ablauf -> haengt seine Schritte an SOLL an, Unterablaeufe gleich dahinter (wie Keycloak sie listet)
  local schritt ablauf anbieter anf konfig eintrag a e uanf text
  for schritt in "${SCHRITTE[@]}"; do
    IFS='|' read -r ablauf anbieter anf konfig <<< "$schritt"
    if [[ "$ablauf" != "$1" ]]; then continue; fi
    if [[ "$anbieter" == @* ]]; then
      uanf=""
      for eintrag in "${ABLAEUFE[@]}"; do
        IFS='|' read -r a e uanf text <<< "$eintrag"
        if [[ "$a" == "${anbieter#@}" ]]; then break; fi
      done
      SOLL+=("$1|$anbieter|$uanf|")
      soll_bild "${anbieter#@}"
    else
      SOLL+=("$1|$anbieter|$anf|$(bedingung_soll "$konfig")")
    fi
  done
  return 0
}

ist_bild() { # oberster Ablauf -> IST, aus den Ausfuehrungen gelesen; je Rollen-Bedingung ein Abruf der Konfiguration
  IST=()
  zeilen "$(kc get "authentication/flows/$1/executions" -r "$R" \
    --fields level,index,requirement,providerId,displayName,authenticationFlow,authenticationConfig --format csv --noquotes)"
  local roh=("${ZEILEN[@]}") eltern=("$1") z ebene idx anf anbieter name istablauf cfg json bed
  for z in "${roh[@]}"; do
    IFS=, read -r ebene idx anf anbieter name istablauf cfg <<< "$z"
    if [[ "$istablauf" == true ]]; then
      IST+=("${eltern[$ebene]:-?}|@$name|$anf|")
      eltern[$((ebene + 1))]="$name"
    else
      bed=""
      if [[ -n "$cfg" ]]; then
        if json="$(kc get "authentication/config/$cfg" -r "$R" 2> /dev/null)"; then
          bed="$(bedingung_ist "$json")"
        else
          bed="nicht lesbar"
        fi
      fi
      IST+=("${eltern[$ebene]:-?}|$anbieter|$anf|$bed")
    fi
  done
  return 0
}

# Vergleicht einen obersten Ablauf Schritt fuer Schritt mit dem, was angleichen baut (= dem Import):
# Anbieter, Anforderung, Reihenfolge, Unterablaeufe und die Rollen-Bedingung je Unterablauf.
# Ergebnis im Feld MELDUNGEN; leer = vollstaendig.
ablauf_abweichungen() {
  MELDUNGEN=()
  SOLL=()
  soll_bild "$1"
  ist_bild "$1"
  if [[ ${#IST[@]} -eq 0 ]]; then
    MELDUNGEN+=("$1: Ablauf ist leer (kein einziger Schritt)")
    return 0
  fi
  local s i treffer eltern anbieter anf bed e2 a2 n2 b2
  local -A vergeben=()
  for s in "${SOLL[@]}"; do
    IFS='|' read -r eltern anbieter anf bed <<< "$s"
    treffer=""
    for i in "${!IST[@]}"; do
      if [[ -z "${vergeben[$i]:-}" && "${IST[$i]}" == "$s" ]]; then treffer="$i"; break; fi
    done
    if [[ -n "$treffer" ]]; then vergeben[$treffer]=1; continue; fi
    # derselbe Schritt an derselben Stelle, aber mit anderer Bedingung?
    for i in "${!IST[@]}"; do
      if [[ -n "${vergeben[$i]:-}" ]]; then continue; fi
      IFS='|' read -r e2 a2 n2 b2 <<< "${IST[$i]}"
      if [[ "$e2|$a2|$n2" == "$eltern|$anbieter|$anf" ]]; then treffer="$i"; break; fi
    done
    if [[ -n "$treffer" ]]; then
      vergeben[$treffer]=1
      MELDUNGEN+=("$eltern: ${anbieter#@} $anf - Bedingung ist '${b2:-keine}', soll '${bed:-keine}'")
    else
      MELDUNGEN+=("$eltern: ${anbieter#@} $anf fehlt")
    fi
  done
  for i in "${!IST[@]}"; do
    if [[ -n "${vergeben[$i]:-}" ]]; then continue; fi
    IFS='|' read -r e2 a2 n2 b2 <<< "${IST[$i]}"
    MELDUNGEN+=("$e2: ${a2#@} $n2 ist zu viel")
  done
  if [[ ${#MELDUNGEN[@]} -eq 0 && "${IST[*]}" != "${SOLL[*]}" ]]; then
    MELDUNGEN+=("$1: Reihenfolge der Schritte weicht ab")
  fi
  return 0
}

ablauf_anlegen() { # oberster Ablauf, noch ohne Schritte
  local eintrag alias eltern anf text
  for eintrag in "${ABLAEUFE[@]}"; do
    IFS='|' read -r alias eltern anf text <<< "$eintrag"
    if [[ "$alias" == "$1" ]]; then
      kc create authentication/flows -r "$R" -s "alias=$alias" -s providerId=basic-flow \
        -s topLevel=true -s builtIn=false -s "description=$text"
    fi
  done
  return 0
}

schritte_bauen() { # alle Schritte eines obersten Ablaufs samt Unterablaeufen
  local eintrag alias anf text prio=0 schritt ablauf anbieter konfig id negate a e
  for schritt in "${SCHRITTE[@]}"; do
    IFS='|' read -r ablauf anbieter anf konfig <<< "$schritt"
    prio=$((prio + 10))   # eine Zaehlung ueber alle Schritte, auch wenn nur ein Ablauf gebaut wird
    if [[ "$ablauf" != "$1"* ]]; then continue; fi
    if [[ "$anbieter" == @* ]]; then
      alias="${anbieter#@}"
      for eintrag in "${ABLAEUFE[@]}"; do
        IFS='|' read -r a e anf text <<< "$eintrag"
        if [[ "$a" == "$alias" ]]; then break; fi
      done
      kc create "authentication/flows/$ablauf/executions/flow" -r "$R" -s "alias=$alias" \
        -s type=basic-flow -s "description=$text" -s "priority=$prio" > /dev/null
      id="$(unterablauf_id "$ablauf" "$alias")"
    else
      id="$(kc create "authentication/flows/$ablauf/executions/execution" -r "$R" \
        -s "provider=$anbieter" -s "priority=$prio" -i)"
    fi
    anforderung "$ablauf" "$id" "$anf" "$prio"
    if [[ -n "$konfig" ]]; then
      negate=false
      if [[ "$konfig" == nicht-betrieb ]]; then negate=true; fi
      kc create "authentication/executions/$id/config" -r "$R" \
        -b "{\"alias\":\"voltpilot-rolle-${konfig/betrieb/platform-admin}\",\"config\":{\"condUserRole\":\"platform-admin\",\"negate\":\"$negate\"}}" > /dev/null
    fi
  done
  return 0
}

angleichen() {
  local oben id m feld gebunden eintrag
  local -a bauen=() entfernen=()

  # 1. Bestand ansehen, bevor irgendetwas geaendert wird
  for oben in "${OBEN[@]}"; do
    id="$(ablauf_id "$oben")" || id=""
    if [[ -z "$id" ]]; then bauen+=("$oben"); continue; fi
    ablauf_abweichungen "$oben"
    if [[ ${#MELDUNGEN[@]} -eq 0 ]]; then
      echo "Ablauf $oben ist schon vollstaendig vorhanden."
      continue
    fi
    echo "Ablauf $oben weicht vom Import ab (abgebrochener Lauf?):"
    for m in "${MELDUNGEN[@]}"; do echo "  $m"; done
    feld=browserFlow
    if [[ "$oben" == voltpilot-direct-grant ]]; then feld=directGrantFlow; fi
    gebunden="$(kc get "realms/$R" --fields "$feld" --format csv --noquotes)"
    if [[ "$gebunden" == "$oben" ]]; then
      echo "VERWEIGERT: Der Ablauf $oben weicht vom Import ab, ist aber als $feld gebunden. Nichts wurde geaendert."
      echo "So geht es weiter:"
      echo "  1. Die eingebauten Ablaeufe binden (der Rueckweg aus live-realm-import.md):"
      echo "     kcadm.sh update realms/$R -s browserFlow=browser -s 'directGrantFlow=direct grant'"
      echo "  2. angleichen noch einmal starten. Es entfernt die abweichenden Ablaeufe und baut sie neu."
      exit 3
    fi
    entfernen+=("$id|$oben")
    bauen+=("$oben")
  done

  # 2. Werte des Realms
  kc update "realms/$R" -s eventsEnabled=true -s "eventsExpiration=$NEUNZIG_TAGE" \
    -s adminEventsEnabled=true -s adminEventsDetailsEnabled=false -s "passwordPolicy=$VORGABE"
  # Ein Realm-Attribut nur ueber -b: `-s attributes.x=...` setzt es in kcadm 26.0.5 nicht (im Test gesehen)
  kc update "realms/$R" -b "{\"attributes\":{\"adminEventsExpiration\":\"$NEUNZIG_TAGE\"}}"

  # 3. Abweichendes entfernen (ungebunden, also ohne Wirkung auf eine Anmeldung), Fehlendes bauen
  for eintrag in "${entfernen[@]}"; do
    kc delete "authentication/flows/${eintrag%%|*}" -r "$R"
    echo "Ablauf ${eintrag#*|} entfernt, wird neu gebaut."
  done
  for oben in "${bauen[@]}"; do
    ablauf_anlegen "$oben"
  done
  for oben in "${bauen[@]}"; do
    schritte_bauen "$oben"
  done

  # 4. Erst pruefen, dann binden
  for oben in "${OBEN[@]}"; do
    ablauf_abweichungen "$oben"
    if [[ ${#MELDUNGEN[@]} -ne 0 ]]; then
      echo "FEHLER: Der Ablauf $oben ist nach dem Bauen nicht vollstaendig. Es wurde nichts gebunden:"
      for m in "${MELDUNGEN[@]}"; do echo "  $m"; done
      echo "angleichen noch einmal starten; bleibt die Meldung, die Ausgabe aufheben und nicht weitermachen."
      exit 4
    fi
  done
  kc update "realms/$R" -s browserFlow=voltpilot-browser -s directGrantFlow=voltpilot-direct-grant
  echo "Realm $R angeglichen. Als Naechstes: pruefen (derselbe Aufruf mit pruefen statt angleichen)."
}

pruefen() {
  local fehler=0 feld soll ist paar
  for paar in "passwordPolicy=$VORGABE" "eventsEnabled=true" "eventsExpiration=$NEUNZIG_TAGE" \
              "adminEventsEnabled=true" "adminEventsDetailsEnabled=false" \
              "browserFlow=voltpilot-browser" "directGrantFlow=voltpilot-direct-grant"; do
    feld="${paar%%=*}"; soll="${paar#*=}"
    ist="$(kc get "realms/$R" --fields "$feld" --format csv --noquotes)"
    if [[ "$ist" != "$soll" ]]; then echo "ABWEICHUNG $feld: ist '$ist', soll '$soll'"; fehler=1; fi
  done
  local json
  json="$(kc get "realms/$R" --fields 'attributes(adminEventsExpiration)')"
  if [[ ! "$json" =~ \"adminEventsExpiration\"[[:space:]]*:[[:space:]]*\"$NEUNZIG_TAGE\" ]]; then
    echo "ABWEICHUNG attributes.adminEventsExpiration: soll $NEUNZIG_TAGE, gelesen: ${json//$'\n'/ }"; fehler=1
  fi

  # Die Ablaeufe Schritt fuer Schritt: Anbieter, Anforderung, Reihenfolge und die Rollen-Bedingung je Unterablauf
  local oben m
  for oben in "${OBEN[@]}"; do
    if ! ablauf_id "$oben" > /dev/null; then echo "ABWEICHUNG Ablauf $oben fehlt"; fehler=1; continue; fi
    ablauf_abweichungen "$oben"
    for m in "${MELDUNGEN[@]}"; do echo "ABWEICHUNG $m"; fehler=1; done
  done
  if [[ $fehler == 0 ]]; then
    echo "Realm $R traegt die Anmelde-Haertung (E12). Datum und Person in live-realm-import.md eintragen."
  fi
  return $fehler
}

case "$MODUS" in
  angleichen) angleichen ;;
  pruefen) pruefen ;;
  *) echo "Aufruf: live-realm-anmeldung.sh angleichen|pruefen   (Realm: REALM=${R})" >&2; exit 2 ;;
esac
