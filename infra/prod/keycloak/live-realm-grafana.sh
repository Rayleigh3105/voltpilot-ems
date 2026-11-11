#!/usr/bin/env bash
# RL-P2a (RL-3 = B): der Client `grafana` in einem BESTEHENDEN Realm - dieselbe Definition wie der Eintrag im
# Import voltpilot-realm.json (der Import allein aendert keinen bestehenden Realm).
#
#   angleichen  legt den Client an oder setzt ihn auf die Definition unten: Felder, Mapper, Client-Scopes. Die
#               Realm-Rolle platform-admin kommt erst in den Scope des Clients, wenn alles andere stimmt - bricht
#               ein Lauf vorher ab, traegt kein Token eine Rolle. Ein zweiter Lauf legt nichts doppelt an. Das
#               Client-Geheimnis erzeugt Keycloak beim Anlegen; angleichen aendert es danach nie.
#   pruefen     liest nur; Exit 0 = der Client steht wie im Import, und die Beispiel-Token, die Keycloak fuer zwei
#               Konten des Realms ausstellt, tragen, was der Vertrag verlangt. Sonst eine Zeile je Abweichung.
#               Das Geheimnis steht nie in dieser Ausgabe.
#   geheimnis   schreibt das Client-Geheimnis auf die Standardausgabe und sonst nichts.
#
# Laeuft dort, wo kcadm.sh liegt (im Keycloak-Pod) und NACH `kcadm.sh config credentials ...`.
# Nur Bash-Bordmittel (ab 4.4): das Keycloak-Image hat kein jq. Anleitung und Bestaetigung: live-realm-grafana.md.
# ProduktionsRealmGrafanaClientTest faehrt alle drei Modi gegen einen Realm ohne den Client, vergleicht das
# Ergebnis mit dem Import und verstellt den Client Stueck fuer Stueck.
set -euo pipefail

MODUS="${1:-}"
R="${REALM:-voltpilot}"
KC="${KCADM:-/opt/keycloak/bin/kcadm.sh}"

CLIENT=grafana
ADRESSE='https://grafana.voltpilot.de/login/generic_oauth'   # Rueckruf und Adresse nach dem Abmelden
ROLLE=platform-admin
CLAIM=grafana_roles
MAPPER=oidc-usermodel-realm-role-mapper
SCOPES=(basic profile email)   # Default Client Scopes - NICHT roles: dessen Mapper schriebe realm_access ins Zugriffstoken
HAERTUNG=voltpilot-browser     # Browser-Ablauf mit zweitem Faktor fuer platform-admin (live-realm-anmeldung.sh)

# Derselbe Eintrag wie unter "clients" in voltpilot-realm.json. ProduktionsRealmGrafanaDateiTest vergleicht beide
# Zeichen fuer Zeichen als JSON; wer hier etwas aendert, aendert es dort.
read -r -d '' DEFINITION << 'JSON' || true
{
  "clientId": "grafana",
  "name": "Grafana (Betrieb)",
  "description": "Anmeldung an Grafana, nur platform-admin (Claim grafana_roles im ID-Token). Scope roles und Full Scope bleiben AUS: das Zugriffstoken darf keine Rolle tragen (infra/prod/keycloak/live-realm-grafana.md).",
  "enabled": true,
  "protocol": "openid-connect",
  "publicClient": false,
  "standardFlowEnabled": true,
  "implicitFlowEnabled": false,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": false,
  "fullScopeAllowed": false,
  "redirectUris": ["https://grafana.voltpilot.de/login/generic_oauth"],
  "webOrigins": [],
  "attributes": {
    "pkce.code.challenge.method": "S256",
    "post.logout.redirect.uris": "https://grafana.voltpilot.de/login/generic_oauth"
  },
  "defaultClientScopes": ["basic", "profile", "email"],
  "optionalClientScopes": [],
  "protocolMappers": [
    {
      "name": "grafana_roles",
      "protocol": "openid-connect",
      "protocolMapper": "oidc-usermodel-realm-role-mapper",
      "config": {
        "claim.name": "grafana_roles",
        "jsonType.label": "String",
        "multivalued": "true",
        "id.token.claim": "true",
        "access.token.claim": "false",
        "userinfo.token.claim": "false"
      }
    }
  ]
}
JSON

# Was die Definition nicht nennt, aber einen weiteren Weg zu einem Token oeffnete: zwei weitere Ablaeufe und ein
# eigener Anmelde-Ablauf am Client (er umginge den zweiten Faktor des Realms). Nur gesendet, wenn es abweicht.
# webOrigins steht dabei, weil Keycloak 26.0.5 sie sonst aus der Rueckruf-Adresse ableitet, sobald ein Rumpf sie weglaesst.
RUECKNAHME='{"webOrigins":[],"attributes":{"oauth2.device.authorization.grant.enabled":"false","oidc.ciba.grant.enabled":"false"},"authenticationFlowBindingOverrides":{"browser":"","direct_grant":""}}'

# Felder des Clients mit festem Wert, in dieser Reihenfolge: Feld=Soll
FELDER=(
  "enabled=true" "protocol=openid-connect" "publicClient=false" "clientAuthenticatorType=client-secret"
  "standardFlowEnabled=true" "implicitFlowEnabled=false" "directAccessGrantsEnabled=false"
  "serviceAccountsEnabled=false" "fullScopeAllowed=false"
)
# Konfiguration des Mappers: Schluessel=Soll. Der Claim steht NUR im ID-Token.
MAPPER_SOLL=(
  "claim.name=$CLAIM" "jsonType.label=String" "multivalued=true"
  "id.token.claim=true" "access.token.claim=false" "userinfo.token.claim=false"
)

# Im Cluster setzt der Pod JAVA_TOOL_OPTIONS fuer den Server; Java schriebe sonst bei jedem Aufruf von kcadm
# "Picked up JAVA_TOOL_OPTIONS: ..." zwischen die Zeilen dieses Skripts. kcadm braucht die Angabe nicht.
# Die Standardeingabe ist bei `bash -s` das Skript selbst; kcadm bekommt sie nur, wenn es einen Rumpf lesen soll.
# kcadm schreibt zu jeder JSON-Antwort eine Leerzeile auf die Fehlerausgabe; nur die faellt weg, jede Meldung bleibt
# und steht vor der naechsten Zeile dieses Skripts. Die Standardausgabe geht unveraendert durch.
kc_aufruf() {
  local meldung z status=0
  { meldung="$( (unset JAVA_TOOL_OPTIONS; "$KC" "$@") 2>&1 1>&3 3>&-)" || status=$?; } 3>&1
  while IFS= read -r z; do
    if [[ -n "$z" ]]; then echo "$z" >&2; fi
  done <<< "$meldung"
  return $status
}
kc() { kc_aufruf "$@" < /dev/null; }
kc_rumpf() { kc_aufruf "$@"; }   # Rumpf ueber die Standardeingabe: ... -f - <<< "$json"

# Der erste Abruf jedes Modus. Er muss gelingen: sonst hiesse "kcadm ist nicht angemeldet" spaeter "der Client fehlt".
# Setzt BROWSER_ABLAUF (den gebundenen Browser-Ablauf des Realms).
realm_lesen() {
  if ! BROWSER_ABLAUF="$(kc get "realms/$R" --fields browserFlow --format csv --noquotes)"; then
    echo "FEHLER: kcadm liest den Realm $R nicht (Meldung darueber; fehlt die Anmeldung, siehe live-realm-import.md, Schritt 2)." >&2
    echo "Nichts wurde geprueft, nichts geaendert." >&2
    exit 5
  fi
}

zeilen() { # Ausgabe von kcadm als Zeilen in das Feld ZEILEN (leere Ausgabe = leeres Feld)
  ZEILEN=()
  local z
  while IFS= read -r z; do
    if [[ -n "$z" ]]; then ZEILEN+=("$z"); fi
  done <<< "$1"
  return 0
}

hat() { # JSON Schluessel -> Status 0, wenn es den Schluessel gibt
  local muster="\"${2//./\\.}\"[[:space:]]*:"
  [[ "$1" =~ $muster ]]
}

wert() { # JSON Schluessel -> Wert (Zeichenkette, Wahrheitswert oder Zahl); leer, wenn es den Schluessel nicht gibt
  local muster="\"${2//./\\.}\"[[:space:]]*:[[:space:]]*(\"([^\"]*)\"|[a-z0-9.-]+)"
  if [[ "$1" =~ $muster ]]; then
    if [[ "${BASH_REMATCH[1]}" == \"* ]]; then echo "${BASH_REMATCH[2]}"; else echo "${BASH_REMATCH[1]}"; fi
  fi
  return 0
}

liste() { # JSON Schluessel -> Eintraege einer Liste aus Zeichenketten, mit Komma getrennt; "-" = Schluessel fehlt
  local muster="\"${2//./\\.}\"[[:space:]]*:[[:space:]]*\[([^]]*)\]" inhalt
  if [[ ! "$1" =~ $muster ]]; then echo "-"; return 0; fi
  inhalt="${BASH_REMATCH[1]//[[:space:]]/}"
  echo "${inhalt//\"/}"
}

client_lesen() { # setzt KENNUNG auf die interne Id des Clients; leer = es gibt ihn nicht
  KENNUNG="$(kc get clients -r "$R" -q "clientId=$CLIENT" --fields id --format csv --noquotes)"
}

geheimnis_lesen() { # Client-Id -> das Geheimnis; nur fuer die Pruefung und den Modus geheimnis
  kc get "clients/$1/client-secret" -r "$R" --fields value --format csv --noquotes
}

# Ein Platzhalter ist kein Geheimnis: `${VP_...}` bleibt beim Import woertlich stehen, wenn die Variable fehlt,
# und ein leeres Geheimnis nimmt Keycloak 26.0.5 am Token-Endpunkt an (beides nachgestellt).
geheimnis_brauchbar() {
  local klein="${1,,}"
  # shellcheck disable=SC2016  # gemeint ist die Zeichenfolge "${" selbst
  [[ ${#1} -ge 24 && "$1" != *'${'* && "$klein" != *change-me* ]]
}

# Felder, Mapper und Client-Scopes des Clients gegen die Definition. Ergebnis im Feld MELDUNGEN; leer = gleich.
# RUECKNAHME_NOETIG=1, wenn ein weiterer Ablauf oder ein eigener Anmelde-Ablauf am Client haengt.
einstellungen_abweichungen() { # Client-Id
  MELDUNGEN=()
  RUECKNAHME_NOETIG=0
  local json paar feld soll ist z id name protokoll anbieter treffer="" s
  local namen="" abfrage="redirectUris,webOrigins,authenticationFlowBindingOverrides(*)"
  abfrage+=",attributes(pkce.code.challenge.method,post.logout.redirect.uris"
  abfrage+=",oauth2.device.authorization.grant.enabled,oidc.ciba.grant.enabled)"
  for paar in "${FELDER[@]}"; do abfrage+=",${paar%%=*}"; done
  json="$(kc get "clients/$1" -r "$R" --fields "$abfrage")"

  for paar in "${FELDER[@]}"; do
    feld="${paar%%=*}"; soll="${paar#*=}"; ist="$(wert "$json" "$feld")"
    if [[ "$ist" != "$soll" ]]; then MELDUNGEN+=("$feld: ist '$ist', soll '$soll'"); fi
  done
  ist="$(liste "$json" redirectUris)"
  if [[ "$ist" != "$ADRESSE" ]]; then
    MELDUNGEN+=("redirectUris: ist '$ist', soll genau eine Adresse: '$ADRESSE'")
  fi
  ist="$(liste "$json" webOrigins)"
  if [[ -n "$ist" && "$ist" != "-" ]]; then MELDUNGEN+=("webOrigins: ist '$ist', soll leer"); fi
  for paar in "pkce.code.challenge.method=S256" "post.logout.redirect.uris=$ADRESSE"; do
    feld="${paar%%=*}"; soll="${paar#*=}"; ist="$(wert "$json" "$feld")"
    if [[ "$ist" != "$soll" ]]; then MELDUNGEN+=("attributes.$feld: ist '$ist', soll '$soll'"); fi
  done
  for feld in oauth2.device.authorization.grant.enabled oidc.ciba.grant.enabled; do
    if [[ "$(wert "$json" "$feld")" == true ]]; then
      MELDUNGEN+=("attributes.$feld: ist 'true', soll aus - nur der Standard Flow"); RUECKNAHME_NOETIG=1
    fi
  done
  local leer='"authenticationFlowBindingOverrides"[[:space:]]*:[[:space:]]*\{[[:space:]]*\}'
  if [[ ! "$json" =~ $leer ]]; then
    MELDUNGEN+=("authenticationFlowBindingOverrides: der Client hat einen eigenen Anmelde-Ablauf, soll keinen (der zweite Faktor haengt am Ablauf des Realms)")
    RUECKNAHME_NOETIG=1
  fi

  # Genau ein Mapper am Client. Jeder weitere koennte eine Rolle in das Zugriffstoken schreiben.
  zeilen "$(kc get "clients/$1/protocol-mappers/models" -r "$R" --fields id,name,protocol,protocolMapper --format csv --noquotes)"
  for z in "${ZEILEN[@]}"; do
    IFS=, read -r id name protokoll anbieter <<< "$z"
    if [[ "$name" == "$CLAIM" && "$protokoll" == openid-connect && "$anbieter" == "$MAPPER" && -z "$treffer" ]]; then
      treffer="$id"
    else
      MELDUNGEN+=("Mapper '$name' ($anbieter) ist zu viel - am Client steht nur der Mapper $CLAIM")
    fi
  done
  if [[ -z "$treffer" ]]; then
    MELDUNGEN+=("Mapper $CLAIM ($MAPPER) fehlt")
  else
    json="$(kc get "clients/$1/protocol-mappers/models/$treffer" -r "$R")"
    for paar in "${MAPPER_SOLL[@]}"; do
      feld="${paar%%=*}"; soll="${paar#*=}"; ist="$(wert "$json" "$feld")"
      if [[ "$ist" != "$soll" ]]; then MELDUNGEN+=("Mapper $CLAIM, $feld: ist '$ist', soll '$soll'"); fi
    done
    for feld in introspection.token.claim lightweight.claim; do
      if [[ "$(wert "$json" "$feld")" == true ]]; then
        MELDUNGEN+=("Mapper $CLAIM, $feld: ist 'true', soll aus - der Claim steht nur im ID-Token")
      fi
    done
    ist="$(wert "$json" usermodel.realmRoleMapping.rolePrefix)"
    if [[ -n "$ist" ]]; then MELDUNGEN+=("Mapper $CLAIM, Vorsilbe '$ist': soll keine haben"); fi
  fi

  # Client-Scopes: genau die drei, und keiner zur Wahl. Jeder weitere bringt eigene Mapper mit.
  zeilen "$(kc get "clients/$1/default-client-scopes" -r "$R" --fields name --format csv --noquotes)"
  for s in "${SCOPES[@]}"; do
    treffer=""
    for z in "${ZEILEN[@]}"; do
      if [[ "$z" == "$s" ]]; then treffer=1; fi
    done
    if [[ -z "$treffer" ]]; then MELDUNGEN+=("Default Client Scope $s fehlt"); fi
  done
  for z in "${ZEILEN[@]}"; do
    if [[ " ${SCOPES[*]} " != *" $z "* ]]; then
      MELDUNGEN+=("Default Client Scope $z ist zu viel - soll nur ${SCOPES[*]}")
    fi
  done
  zeilen "$(kc get "clients/$1/optional-client-scopes" -r "$R" --fields name --format csv --noquotes)"
  for z in "${ZEILEN[@]}"; do namen+="$z "; done
  if [[ -n "$namen" ]]; then MELDUNGEN+=("Optional Client Scopes: ist '${namen% }', soll keine"); fi
  return 0
}

# Scope-Zuordnung des Clients (Full Scope ist aus): genau die Realm-Rolle platform-admin, keine Client-Rolle.
# Ergebnis im Feld MELDUNGEN; ZU_VIEL nennt die Realm-Rollen, die nicht hineingehoeren (Id,Name), FEHLT=1 = Rolle fehlt.
zuordnung_abweichungen() { # Client-Id
  MELDUNGEN=()
  ZU_VIEL=()
  FEHLT=1
  local z json
  zeilen "$(kc get "clients/$1/scope-mappings/realm" -r "$R" --fields id,name --format csv --noquotes)"
  for z in "${ZEILEN[@]}"; do
    if [[ "${z#*,}" == "$ROLLE" ]]; then
      FEHLT=0
    else
      ZU_VIEL+=("$z")
      MELDUNGEN+=("Scope-Zuordnung: Realm-Rolle '${z#*,}' ist zu viel - soll nur $ROLLE")
    fi
  done
  if [[ $FEHLT == 1 ]]; then
    MELDUNGEN+=("Scope-Zuordnung: Realm-Rolle $ROLLE fehlt - ohne sie traegt kein ID-Token den Claim $CLAIM, niemand kaeme hinein")
  fi
  json="$(kc get "clients/$1/scope-mappings" -r "$R")"
  if hat "$json" clientMappings; then
    MELDUNGEN+=("Scope-Zuordnung: Client-Rollen sind zugeordnet, soll keine (Administration: Clients > $CLIENT > Client scopes > $CLIENT-dedicated > Scope)")
  fi
  return 0
}

# Die vier Sollwerte an Beispiel-Token: Keycloak stellt sie fuer ein Konto aus, ohne es anzumelden (Clients >
# Client scopes > Evaluate). Geprueft wird ein Konto mit der Rolle platform-admin und eines ohne.
# Ergebnis in MELDUNGEN (Abweichungen) und BELEGE (was gelesen wurde).
token_abweichungen() { # Client-Id
  MELDUNGEN=()
  BELEGE=()
  local z betrieb="" betrieb_name="" kunde="" abfrage id_token zugriff rollen
  local -A betriebskonten=()
  zeilen "$(kc get "roles/$ROLLE/users" -r "$R" --fields id,username --format csv --noquotes)"
  for z in "${ZEILEN[@]}"; do
    betriebskonten["${z%%,*}"]=1
    if [[ -z "$betrieb" ]]; then betrieb="${z%%,*}"; betrieb_name="${z#*,}"; fi
  done
  # Erst die Konten von Menschen, dann die Servicekonten (ein neuer Realm hat sonst nur den Portal-Admin).
  for abfrage in "max=50" "username=service-account-"; do
    if [[ -n "$kunde" ]]; then break; fi
    zeilen "$(kc get users -r "$R" -q "$abfrage" --fields id --format csv --noquotes)"
    for z in "${ZEILEN[@]}"; do
      if [[ -z "${betriebskonten[$z]:-}" ]]; then kunde="$z"; break; fi
    done
  done

  if [[ -z "$betrieb" ]]; then
    MELDUNGEN+=("Sollwert 1 nicht pruefbar: kein Konto traegt die Realm-Rolle $ROLLE")
  else
    id_token="$(kc get "clients/$1/evaluate-scopes/generate-example-id-token" -r "$R" -q "scope=openid profile email" -q "userId=$betrieb")"
    zugriff="$(kc get "clients/$1/evaluate-scopes/generate-example-access-token" -r "$R" -q "scope=openid profile email" -q "userId=$betrieb")"
    rollen="$(liste "$id_token" "$CLAIM")"
    if [[ "$rollen" == "$ROLLE" ]]; then
      BELEGE+=("Sollwert 1: ID-Token des Kontos $betrieb_name ($ROLLE) traegt $CLAIM = [$rollen]")
    elif [[ "$rollen" == "-" ]]; then
      MELDUNGEN+=("Sollwert 1: ID-Token des Kontos $betrieb_name ($ROLLE) traegt $CLAIM nicht, soll [$ROLLE]")
    else
      MELDUNGEN+=("Sollwert 1: ID-Token des Kontos $betrieb_name ($ROLLE) traegt $CLAIM = [$rollen], soll [$ROLLE]")
    fi
    token_ohne_rolle "$zugriff" "Zugriffstoken des Kontos $betrieb_name ($ROLLE)"
    token_mit_sub "$id_token" "$zugriff" "des Kontos $betrieb_name ($ROLLE)"
  fi
  if [[ -z "$kunde" ]]; then
    MELDUNGEN+=("Sollwert 2 nicht pruefbar: kein Konto ohne die Realm-Rolle $ROLLE gefunden")
  else
    id_token="$(kc get "clients/$1/evaluate-scopes/generate-example-id-token" -r "$R" -q "scope=openid profile email" -q "userId=$kunde")"
    zugriff="$(kc get "clients/$1/evaluate-scopes/generate-example-access-token" -r "$R" -q "scope=openid profile email" -q "userId=$kunde")"
    rollen="$(liste "$id_token" "$CLAIM")"
    if [[ "$rollen" == "-" || -z "$rollen" ]]; then
      BELEGE+=("Sollwert 2: ID-Token eines Kontos ohne $ROLLE (Kennung $kunde) traegt $CLAIM nicht")
    else
      MELDUNGEN+=("Sollwert 2: ID-Token eines Kontos ohne $ROLLE (Kennung $kunde) traegt $CLAIM = [$rollen], soll fehlen")
    fi
    token_ohne_rolle "$zugriff" "Zugriffstoken eines Kontos ohne $ROLLE (Kennung $kunde)"
    token_mit_sub "$id_token" "$zugriff" "eines Kontos ohne $ROLLE (Kennung $kunde)"
  fi
  return 0
}

token_ohne_rolle() { # Zugriffstoken (JSON) Bezeichnung -> Sollwert 3
  local feld zu_viel=""
  # realm_access macht an der API aus platform-admin das Plattform-Konto, tenant_id ein Kundenkonto.
  for feld in realm_access resource_access "$CLAIM" tenant_id; do
    if hat "$1" "$feld"; then zu_viel+="$feld "; fi
  done
  if [[ -n "$zu_viel" ]]; then
    MELDUNGEN+=("Sollwert 3: $2 traegt ${zu_viel% }, soll weder Rolle noch Kundenbereich tragen")
  else
    BELEGE+=("Sollwert 3: $2 traegt weder realm_access noch resource_access, $CLAIM oder tenant_id")
  fi
  return 0
}

token_mit_sub() { # ID-Token Zugriffstoken Bezeichnung -> Sollwert 4
  if [[ -n "$(wert "$1" sub)" && -n "$(wert "$2" sub)" ]]; then
    BELEGE+=("Sollwert 4: ID-Token und Zugriffstoken $3 tragen sub")
  else
    MELDUNGEN+=("Sollwert 4: ID-Token oder Zugriffstoken $3 traegt kein sub (fehlt dem Client der Scope basic?)")
  fi
  return 0
}

scopes_angleichen() { # Client-Id; REALM_SCOPES (Name -> Id) ist gefuellt
  local z s treffer
  # Erst die Scopes zur Wahl loesen: einer davon kann einer der drei sein, die fest dazugehoeren.
  zeilen "$(kc get "clients/$1/optional-client-scopes" -r "$R" --fields id,name --format csv --noquotes)"
  for z in "${ZEILEN[@]}"; do
    kc delete "clients/$1/optional-client-scopes/${z%%,*}" -r "$R"
    echo "Optional Client Scope ${z#*,} vom Client geloest."
  done
  zeilen "$(kc get "clients/$1/default-client-scopes" -r "$R" --fields id,name --format csv --noquotes)"
  for z in "${ZEILEN[@]}"; do
    if [[ " ${SCOPES[*]} " != *" ${z#*,} "* ]]; then
      kc delete "clients/$1/default-client-scopes/${z%%,*}" -r "$R"
      echo "Default Client Scope ${z#*,} vom Client geloest."
    fi
  done
  for s in "${SCOPES[@]}"; do
    treffer=""
    for z in "${ZEILEN[@]}"; do
      if [[ "${z#*,}" == "$s" ]]; then treffer=1; fi
    done
    if [[ -z "$treffer" ]]; then
      kc update "clients/$1/default-client-scopes/${REALM_SCOPES[$s]}" -r "$R"
      echo "Default Client Scope $s an den Client gehaengt."
    fi
  done
  return 0
}

angleichen() {
  local id rolle_id="" z s m neu=0
  local -A REALM_SCOPES=()

  # 1. Voraussetzungen ansehen, bevor irgendetwas geaendert wird
  realm_lesen
  zeilen "$(kc get roles -r "$R" --fields id,name --format csv --noquotes)"
  for z in "${ZEILEN[@]}"; do
    if [[ "${z#*,}" == "$ROLLE" ]]; then rolle_id="${z%%,*}"; fi
  done
  if [[ -z "$rolle_id" ]]; then
    echo "VERWEIGERT: Die Realm-Rolle $ROLLE fehlt im Realm $R. Nichts wurde geaendert."
    exit 3
  fi
  zeilen "$(kc get client-scopes -r "$R" --fields id,name --format csv --noquotes)"
  for z in "${ZEILEN[@]}"; do REALM_SCOPES["${z#*,}"]="${z%%,*}"; done
  for s in "${SCOPES[@]}"; do
    if [[ -z "${REALM_SCOPES[$s]:-}" ]]; then
      echo "VERWEIGERT: Der Client Scope $s fehlt im Realm $R (basic gibt es seit Keycloak 25). Nichts wurde geaendert."
      exit 3
    fi
  done

  # 2. Client anlegen oder auf die Definition setzen. Der Rumpf nennt kein Geheimnis: beim Anlegen erzeugt
  #    Keycloak eines, ein vorhandenes bleibt stehen. Mapper, die nicht in der Definition stehen, entfernt Keycloak.
  client_lesen
  id="$KENNUNG"
  if [[ -n "$id" ]]; then
    kc_rumpf update "clients/$id" -r "$R" -n -f - <<< "$DEFINITION"
    echo "Client $CLIENT war vorhanden: Felder und Mapper auf die Definition gesetzt, Geheimnis unveraendert."
  else
    id="$(kc_rumpf create clients -r "$R" -i -f - <<< "$DEFINITION")"
    neu=1
    echo "Client $CLIENT angelegt, noch ohne Rolle im Scope."
  fi

  # 3. Client-Scopes; danach, falls noetig, weitere Ablaeufe und einen eigenen Anmelde-Ablauf zuruecknehmen
  scopes_angleichen "$id"
  einstellungen_abweichungen "$id"
  if [[ $RUECKNAHME_NOETIG == 1 ]]; then
    kc_rumpf update "clients/$id" -r "$R" -n -f - <<< "$RUECKNAHME"
    echo "Weitere Ablaeufe und eigener Anmelde-Ablauf am Client zurueckgenommen."
    einstellungen_abweichungen "$id"
  fi

  # 4. Erst pruefen, dann die Rolle in den Scope
  if [[ ${#MELDUNGEN[@]} -ne 0 ]]; then
    echo "FEHLER: Der Client $CLIENT weicht nach dem Angleichen noch ab. Die Scope-Zuordnung wurde nicht angefasst:"
    for m in "${MELDUNGEN[@]}"; do echo "  $m"; done
    echo "angleichen noch einmal starten; bleibt die Meldung, die Ausgabe aufheben und nicht weitermachen."
    exit 4
  fi
  zuordnung_abweichungen "$id"
  for z in "${ZU_VIEL[@]}"; do
    kc delete "clients/$id/scope-mappings/realm" -r "$R" -b "[{\"id\":\"${z%%,*}\"}]"
    echo "Realm-Rolle ${z#*,} aus dem Scope des Clients genommen."
  done
  if [[ $FEHLT == 1 ]]; then
    kc create "clients/$id/scope-mappings/realm" -r "$R" -b "[{\"id\":\"$rolle_id\",\"name\":\"$ROLLE\"}]"
    echo "Realm-Rolle $ROLLE in den Scope des Clients genommen."
  fi
  zuordnung_abweichungen "$id"
  if [[ ${#MELDUNGEN[@]} -ne 0 ]]; then
    echo "FEHLER: Die Scope-Zuordnung des Clients $CLIENT weicht noch ab:"
    for m in "${MELDUNGEN[@]}"; do echo "  $m"; done
    exit 4
  fi

  if [[ "$BROWSER_ABLAUF" != "$HAERTUNG" ]]; then
    echo "ACHTUNG: Der Realm $R bindet den Browser-Ablauf $HAERTUNG nicht. Ohne ihn schuetzt den Zugang zu Grafana"
    echo "         nur ein Passwort. Vor dem oeffentlichen Namen: live-realm-anmeldung.sh angleichen (live-realm-import.md)."
  fi
  if [[ $neu == 1 ]]; then
    echo "Client $CLIENT im Realm $R angelegt. Als Naechstes: pruefen, dann geheimnis (live-realm-grafana.md)."
  else
    echo "Client $CLIENT im Realm $R angeglichen. Als Naechstes: pruefen (derselbe Aufruf mit pruefen statt angleichen)."
  fi
}

pruefen() {
  local id m fehler=0
  realm_lesen
  client_lesen
  id="$KENNUNG"
  if [[ -z "$id" ]]; then
    echo "ABWEICHUNG Client $CLIENT fehlt im Realm $R"
    return 1
  fi
  einstellungen_abweichungen "$id"
  for m in "${MELDUNGEN[@]}"; do echo "ABWEICHUNG $m"; fehler=1; done
  zuordnung_abweichungen "$id"
  for m in "${MELDUNGEN[@]}"; do echo "ABWEICHUNG $m"; fehler=1; done
  if ! geheimnis_brauchbar "$(geheimnis_lesen "$id")"; then
    echo "ABWEICHUNG Client-Geheimnis: ein Platzhalter oder kuerzer als 24 Zeichen (Administration: Clients > $CLIENT > Credentials > Regenerate)"
    fehler=1
  fi
  token_abweichungen "$id"
  for m in "${BELEGE[@]}"; do echo "$m"; done
  for m in "${MELDUNGEN[@]}"; do echo "ABWEICHUNG $m"; fehler=1; done
  if [[ "$BROWSER_ABLAUF" != "$HAERTUNG" ]]; then
    echo "ABWEICHUNG Realm, browserFlow: ist '$BROWSER_ABLAUF', soll '$HAERTUNG' - ohne die Anmelde-Haertung fragt Keycloak ein Konto mit $ROLLE nicht nach dem zweiten Faktor (live-realm-anmeldung.sh)"
    fehler=1
  fi
  if [[ $fehler == 0 ]]; then
    echo "Client $CLIENT im Realm $R steht wie im Import. Datum und Person in live-realm-grafana.md eintragen."
  fi
  return $fehler
}

geheimnis() {
  local g
  realm_lesen
  client_lesen
  if [[ -z "$KENNUNG" ]]; then
    echo "Der Client $CLIENT fehlt im Realm $R." >&2
    exit 1
  fi
  g="$(geheimnis_lesen "$KENNUNG")"
  if ! geheimnis_brauchbar "$g"; then
    echo "Das Geheimnis des Clients $CLIENT ist ein Platzhalter oder kuerzer als 24 Zeichen. Nicht verwenden:" >&2
    echo "in der Administration neu erzeugen (Clients > $CLIENT > Credentials > Regenerate)." >&2
    exit 1
  fi
  printf '%s\n' "$g"
}

case "$MODUS" in
  angleichen) angleichen ;;
  pruefen) pruefen ;;
  geheimnis) geheimnis ;;
  *) echo "Aufruf: live-realm-grafana.sh angleichen|pruefen|geheimnis   (Realm: REALM=${R})" >&2; exit 2 ;;
esac
