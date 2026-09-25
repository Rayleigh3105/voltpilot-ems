#!/usr/bin/env bash
# UEMS AP-20 IP-20 (E12 = A, BT6): Anmelde-Haertung eines BESTEHENDEN Realms - dieselben Werte und Ablaeufe
# wie der Import voltpilot-realm.json (der Import allein aendert keinen bestehenden Realm).
#
#   angleichen  setzt Ereignisse (90 Tage), Passwort-Vorgabe und den bedingten zweiten Faktor, bindet die
#               Ablaeufe; ein zweiter Lauf legt nichts doppelt an
#   pruefen     liest nur; Exit 0 = der Realm traegt die Haertung, sonst eine Zeile je Abweichung
#
# Laeuft dort, wo kcadm.sh liegt (im Keycloak-Pod) und NACH `kcadm.sh config credentials ...`.
# Nur Bash-Bordmittel: das Keycloak-Image hat kein jq. Anleitung und Bestaetigung: live-realm-import.md.
# ProduktionsRealmImportTest faehrt beide Modi gegen einen Realm ohne Haertung und vergleicht mit dem Import.
set -euo pipefail

MODUS="${1:-}"
R="${REALM:-voltpilot}"
KC="${KCADM:-/opt/keycloak/bin/kcadm.sh}"
VORGABE='length(12) and notUsername and passwordHistory(3)'
NEUNZIG_TAGE=7776000

kc() { "$KC" "$@"; }

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

zeilen() { # Ausgabe von kcadm als Zeilen in das Feld ZEILEN
  ZEILEN=()
  local z
  while IFS= read -r z; do [[ -n "$z" ]] && ZEILEN+=("$z"); done <<< "$1"
}

ablauf_da() {
  zeilen "$(kc get authentication/flows -r "$R" --fields alias --format csv --noquotes)"
  local z
  for z in "${ZEILEN[@]}"; do [[ "$z" == "$1" ]] && return 0; done
  return 1
}

# Id der Ausfuehrung eines Unterablaufs (Ebene 0) im Elternablauf
unterablauf_id() {
  zeilen "$(kc get "authentication/flows/$1/executions" -r "$R" --fields id,displayName,level --format csv --noquotes)"
  local z id name ebene
  for z in "${ZEILEN[@]}"; do
    IFS=, read -r id name ebene <<< "$z"
    [[ "$name" == "$2" && "$ebene" == "0" ]] && { echo "$id"; return 0; }
  done
  return 1
}

anforderung() { # Ablauf Ausfuehrungs-Id Anforderung Prioritaet
  kc update "authentication/flows/$1/executions" -r "$R" \
    -b "{\"id\":\"$2\",\"requirement\":\"$3\",\"priority\":$4}"
}

angleichen() {
  kc update "realms/$R" -s eventsEnabled=true -s "eventsExpiration=$NEUNZIG_TAGE" \
    -s adminEventsEnabled=true -s adminEventsDetailsEnabled=false -s "passwordPolicy=$VORGABE"
  # Ein Realm-Attribut nur ueber -b: `-s attributes.x=...` setzt es in kcadm 26.0.5 nicht (im Test gesehen)
  kc update "realms/$R" -b "{\"attributes\":{\"adminEventsExpiration\":\"$NEUNZIG_TAGE\"}}"

  if ablauf_da voltpilot-browser; then
    echo "Ablaeufe schon vorhanden - nur die Bindung wird gesetzt."
  else
    local eintrag alias eltern anf text prio=0 schritt ablauf anbieter konfig id negate
    for eintrag in "${ABLAEUFE[@]}"; do
      IFS='|' read -r alias eltern anf text <<< "$eintrag"
      if [[ -z "$eltern" ]]; then
        kc create authentication/flows -r "$R" -s "alias=$alias" -s providerId=basic-flow \
          -s topLevel=true -s builtIn=false -s "description=$text"
      fi
    done
    for schritt in "${SCHRITTE[@]}"; do
      IFS='|' read -r ablauf anbieter anf konfig <<< "$schritt"
      prio=$((prio + 10))
      if [[ "$anbieter" == @* ]]; then
        alias="${anbieter#@}"
        for eintrag in "${ABLAEUFE[@]}"; do
          IFS='|' read -r a e anf text <<< "$eintrag"
          [[ "$a" == "$alias" ]] && break
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
        negate=false; [[ "$konfig" == nicht-betrieb ]] && negate=true
        kc create "authentication/executions/$id/config" -r "$R" \
          -b "{\"alias\":\"voltpilot-rolle-${konfig/betrieb/platform-admin}\",\"config\":{\"condUserRole\":\"platform-admin\",\"negate\":\"$negate\"}}" > /dev/null
      fi
    done
  fi
  kc update "realms/$R" -s browserFlow=voltpilot-browser -s directGrantFlow=voltpilot-direct-grant
  echo "Realm $R angeglichen. Jetzt: $0 pruefen"
}

pruefen() {
  local fehler=0 feld soll ist
  for paar in "passwordPolicy=$VORGABE" "eventsEnabled=true" "eventsExpiration=$NEUNZIG_TAGE" \
              "adminEventsEnabled=true" "adminEventsDetailsEnabled=false" \
              "browserFlow=voltpilot-browser" "directGrantFlow=voltpilot-direct-grant"; do
    feld="${paar%%=*}"; soll="${paar#*=}"
    ist="$(kc get "realms/$R" --fields "$feld" --format csv --noquotes)"
    [[ "$ist" == "$soll" ]] || { echo "ABWEICHUNG $feld: ist '$ist', soll '$soll'"; fehler=1; }
  done
  local json
  json="$(kc get "realms/$R" --fields 'attributes(adminEventsExpiration)')"
  [[ "$json" =~ \"adminEventsExpiration\"[[:space:]]*:[[:space:]]*\"$NEUNZIG_TAGE\" ]] \
    || { echo "ABWEICHUNG attributes.adminEventsExpiration: soll $NEUNZIG_TAGE, gelesen: ${json//$'\n'/ }"; fehler=1; }

  # Die Unterablaeufe mit Anbietern und Anforderungen, wie angleichen sie baut
  local schritt ablauf anbieter anf konfig oben z gefunden
  for oben in voltpilot-browser voltpilot-direct-grant; do
    ablauf_da "$oben" || { echo "ABWEICHUNG Ablauf $oben fehlt"; fehler=1; continue; }
    zeilen "$(kc get "authentication/flows/$oben/executions" -r "$R" \
      --fields displayName,providerId,requirement --format csv --noquotes)"
    local ist_zeilen=("${ZEILEN[@]}")
    for schritt in "${SCHRITTE[@]}"; do
      IFS='|' read -r ablauf anbieter anf konfig <<< "$schritt"
      [[ "$ablauf" == "$oben"* ]] || continue
      [[ "$anbieter" == @* ]] && continue
      gefunden=0
      for z in "${ist_zeilen[@]}"; do [[ "$z" == *",$anbieter,$anf" ]] && gefunden=1; done
      [[ $gefunden == 1 ]] || { echo "ABWEICHUNG $ablauf: $anbieter $anf fehlt"; fehler=1; }
    done
  done
  # Die Rollen-Bedingungen: platform-admin, im Ablauf "gewaehlt" verneint
  local unter negate cfg
  for unter in voltpilot-browser-otp-betrieb voltpilot-direct-grant-betrieb \
               voltpilot-browser-otp-gewaehlt voltpilot-direct-grant-otp-gewaehlt; do
    negate=false; [[ "$unter" == *gewaehlt ]] && negate=true
    ablauf_da "$unter" || continue
    cfg="$(kc get "authentication/flows/$unter/executions" -r "$R" --fields providerId,authenticationConfig)"
    if [[ "$cfg" =~ \"conditional-user-role\"[^}]*\"authenticationConfig\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] \
       || [[ "$cfg" =~ \"authenticationConfig\"[[:space:]]*:[[:space:]]*\"([^\"]+)\"[^}]*\"conditional-user-role\" ]]; then
      cfg="$(kc get "authentication/config/${BASH_REMATCH[1]}" -r "$R")"
      [[ "$cfg" =~ \"condUserRole\"[[:space:]]*:[[:space:]]*\"platform-admin\" \
         && "$cfg" =~ \"negate\"[[:space:]]*:[[:space:]]*\"$negate\" ]] \
        || { echo "ABWEICHUNG $unter: Bedingung nicht platform-admin/negate=$negate"; fehler=1; }
    else
      echo "ABWEICHUNG $unter: Rollen-Bedingung ohne Konfiguration"; fehler=1
    fi
  done
  if [[ $fehler == 0 ]]; then
    echo "Realm $R traegt die Anmelde-Haertung (E12). Datum und Person in live-realm-import.md eintragen."
  fi
  return $fehler
}

case "$MODUS" in
  angleichen) angleichen ;;
  pruefen) pruefen ;;
  *) echo "Aufruf: $0 angleichen|pruefen   (Realm: REALM=${R})" >&2; exit 2 ;;
esac
