#!/usr/bin/env bash
# Das Lastmanagement-Rig (Konzept `vp-ocpp-lastmgmt-konzept-w4` §6.2, Fälle
# L1-L5) — der Beweis, dass das statische OCPP-Lastmanagement hält, was es
# verspricht, OHNE eine einzige echte Ladesäule.
#
# Gefahren wird der ECHTE Kern (`vp-edge-core`) gegen ECHTE OCPP-Ladesäulen
# (`vp-ocpp-sim`) über ECHTE Websockets. Behauptet wird nichts: JEDE Zusicherung
# unten liest, was eine Säule ZIEHEN WÜRDE — abgeleitet aus den Ladeprofilen,
# die der Kern ihr wirklich installiert hat. Eine Quittung ist kein Beweis.
#
#   L1  zwei Säulen teilen sich das Budget
#   L2  ein drittes Fahrzeug steckt an -> Umverteilung UNTER der Grenze
#   L3  eines steckt ab -> die Leistung wird wieder frei
#   L4  der KERN STIRBT -> das Profil läuft ab -> die Säulen fallen von SELBST
#       auf ihr Sicherheitsprofil zurück (der Totmann)
#   L5  Budget < n × Mindestleistung -> pausieren + Rotation statt aushungern
#   L6  (Stufe 2) das Budget FOLGT dem gemessenen Netzanschluss - und bei
#       Messausfall wird gehalten und zusammengezogen, nie freigegeben
#   L7  (Stufe 4) „Nur Sonnenstrom" deckelt auf den GEMESSENEN Überschuss -
#       und die niedrigere der beiden Bahnen gewinnt
#   L8  (Stufe 4) die zwei Prioritäten bewegen WIRKLICH Leistung: „Speicher
#       vor Auto" gegen „Auto vor Speicher", an den Säulen gemessen
#   L9  (Stufe 4 + P3b) die zwei Richtungen des EINEN Handeingriffs:
#       „Jetzt voll laden" nimmt GENAU EINEN Ladevorgang aus der
#       Quellen-Bahn (der Anschluss hält trotzdem), „Laden pausieren" deckelt
#       GENAU EINEN auf 0 (der Nachbar lädt weiter), die EINE Rücknahme gibt
#       beide zurück, und Abstecken beendet sie - ein neues Fahrzeug erbt nie
#   L10 (Slice 10) der vollständige privacy-sichere OCPP-J-Datenstrom liegt
#       absturzfest am Edge: Protokolltypen, Konfiguration/Fähigkeiten,
#       dimensionsgetreue MeterValues, Auth-Referenzen und TransactionData
#   L13 (Cockpit Phase 0, Entscheid E7) die Box meldet für JEDES Zustandswort
#       des Konzepts §4.2 die Form, die die geteilten Vektoren
#       `docs/contracts/ocpp-ladezustand-vectors.json` behaupten - dieselbe
#       Datei, aus der `frontend/portal/src/ladepunkte.test.ts` die deutschen
#       Wörter ableitet. Ein gerissenes Glied fällt damit auf EINER der beiden
#       Seiten auf, statt still zu bleiben.
#   L11/L12 der Command-Gateway fährt die vollständige Aktionsfläche mit
#       persistentem Replay-/Deadline-Schutz, crashfester wire-id-Korrelation
#       und echtem mutieren→Antwort→Readback über lokale Websockets
#   L14 (Verbrauchsmanagement v1 / P5, K3) die ARBITRIERUNGS-BRÜCKE: ein
#       Halter - der Plan, eine Regel, ein Handeingriff, eine fällige Frist -
#       erreicht den Ladepunkt durch DIESELBE Maschine wie jede andere
#       Komponente. Ohne Halter gilt die Steuerart-Quelle unverändert; mit
#       Halter wird gedeckelt bzw. aus der Quellen-Bahn befreit - und die
#       PHYSIK bindet weiter.
#   L16 (Verbrauchsmanagement v1 / P7) die FAHRZEUG-PROFILE: zwei Karten am
#       selben Ladepark fahren zwei verschiedene Steuerarten, und das Profil
#       folgt der KARTE - tauschen die Wagen die Plaetze, wandert die Ladung
#       mit. Der Schluessel ist der Pseudonym, den die BOX bildet; das Rig
#       liest ihn genauso, wie das Portal ihn liest.
#
# Bewusst OHNE Docker: alles hier läuft als Prozess, also ist das Rig auf jedem
# Rechner mit Go reproduzierbar und braucht kein gebautes Image.
#
#   edge-app/test/e2e-ocpp.sh
set -euo pipefail

cd "$(dirname "$0")/.."

WORK="$(mktemp -d)"
CORE_PID=""
NETZ_PID=""
declare -a SIM_PIDS=()

# Hohe, unwahrscheinliche Ports: das Rig darf einen laufenden Stack nie stören.
WEB_PORT=28585
BUS_PORT=28586
OCPP_PORT=28587
S1_STATUS=127.0.0.1:28591
S2_STATUS=127.0.0.1:28592
S3_STATUS=127.0.0.1:28593
NETZ_STATUS=127.0.0.1:28594
# L14 fährt einen ZWEITEN Kern (eigene Verzeichnisse, eigene Ports): die
# Brücke braucht eine Entitäts-REGISTRY, und die kommt ausschliesslich aus der
# Cloud - während L1-L13 ihre Cloud bewusst ins Leere zeigen lassen, um die
# Offline-Fähigkeit des Lastmanagements zu zeigen. Zwei Kerne halten beide
# Aussagen, statt eine gegen die andere zu tauschen.
WEB_PORT2=28595
BUS_PORT2=28596
OCPP_PORT2=28597
B1_STATUS=127.0.0.1:28598
B2_STATUS=127.0.0.1:28599
NETZ_STATUS2=127.0.0.1:28600
BOX2="http://127.0.0.1:${WEB_PORT2}"
CORE2_PID=""
NETZ2_PID=""
declare -a SIM2_PIDS=()

BOX="http://127.0.0.1:${WEB_PORT}"

cleanup() {
  echo "--- cleanup"
  for pid in "${SIM_PIDS[@]:-}" "${SIM2_PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  [ -n "$CORE2_PID" ] && kill "$CORE2_PID" 2>/dev/null || true
  [ -n "$NETZ_PID" ] && kill "$NETZ_PID" 2>/dev/null || true
  [ -n "$NETZ2_PID" ] && kill "$NETZ2_PID" 2>/dev/null || true
  [ -n "$CORE_PID" ] && kill "$CORE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  PASS  $*"; }

# nearly <ist> <soll> <toleranz> - kW-Vergleich ohne bc (awk ist überall da).
nearly() {
  awk -v a="$1" -v b="$2" -v t="$3" 'BEGIN{d=a-b; if(d<0)d=-d; exit (d<=t)?0:1}'
}

# drawn <status-addr> [connector] - was die Säule (bzw. ein Stecker) zieht.
drawn() {
  local addr="$1" con="${2:-}"
  if [ -z "$con" ]; then
    curl -sf "http://${addr}/status" | sed -n 's/.*"total_kw":\([-0-9.e]*\).*/\1/p'
  else
    curl -sf "http://${addr}/status" |
      tr '{' '\n' | sed -n "s/.*\"id\":${con},\"draw_kw\":\([-0-9.e]*\).*/\1/p" | head -1
  fi
}

# site_kw - was der GANZE Standort gerade zieht.
site_kw() {
  awk -v a="$(drawn $S1_STATUS)" -v b="$(drawn $S2_STATUS)" 'BEGIN{print a+b}'
}

# charging_count - wie viele Stecker wirklich laden (> 1 kW).
#
# ⚠ Bewusst zaehlend statt "Saeule X zieht Y": WELCHE zwei Fahrzeuge bedient
# werden, entscheidet die Rotation - und das ist gewolltes Verhalten, kein
# Zufall, den ein Rig festnageln duerfte. Geprueft wird deshalb die Zusage
# (zwei laden, keiner hungert, das Budget haelt), nie die Besetzung.
charging_count() {
  local n=0 d
  for probe in "$S1_STATUS 1" "$S1_STATUS 2" "$S2_STATUS 1" "$S2_STATUS 2"; do
    set -- $probe
    d=$(drawn "$1" "$2")
    awk -v d="${d:-0}" 'BEGIN{exit (d>1)?0:1}' && n=$((n+1))
  done
  echo "$n"
}

# site_near <soll> <toleranz> - zieht der ganze Standort ungefaehr so viel?
site_near() { nearly "$(site_kw)" "$1" "$2"; }

# ocpp_json - NUR der ocpp-Block der Antwort.
#
# ⚠ Seit Stufe 2 traegt die Antwort ZWEI Felder namens budget_kw: das LEBENDE
# Budget im ocpp-Block und das, was die Einstellungen allein ergaeben. Ein
# blosses grep haenge damit am Zufall der Feld-Reihenfolge.
ocpp_json()   { curl -sf "${BOX}/api/ocpp" | sed -e 's/.*"ocpp":{//' -e 's/,"settings":{.*//'; }
budget_kw()   { ocpp_json | sed -n 's/.*"budget_kw":\([0-9.]*\).*/\1/p' | head -1; }
budget_mode() { ocpp_json | sed -n 's/.*"budget_mode":"\([a-z_]*\)".*/\1/p' | head -1; }
# Die Quellen-Bahn (Stufe 4) - dieselbe Antwort, andere Felder.
surplus_kw()      { ocpp_json | sed -n 's/.*"surplus_kw":\([0-9.]*\).*/\1/p' | head -1; }
surplus_mode()    { ocpp_json | sed -n 's/.*"surplus_mode":"\([a-z_]*\)".*/\1/p' | head -1; }
surplus_total()   { ocpp_json | sed -n 's/.*"surplus_total_kw":\([0-9.]*\).*/\1/p' | head -1; }
source_alloc()    { ocpp_json | sed -n 's/.*"source_allocated_kw":\([0-9.]*\).*/\1/p' | head -1; }
# policy <wort> [speicher-prioritaet] - die Wahl des Kunden setzen.
policy() {
  local body="{\"surplus_policy\":\"$1\""
  [ -n "${2:-}" ] && body="${body},\"storage_priority\":\"$2\""
  curl -sf -X POST "${BOX}/api/ocpp/settings" -H 'Content-Type: application/json' \
    -d "${body}}" >/dev/null || fail "Quellen-Wahl '$1' abgelehnt"
}

# connector_json <saeule> <stecker> - der Herzschlag-Block GENAU dieses Steckers.
#
# ⚠ Aus `/api/ocpp` und nicht aus dem Simulator: geprueft wird, was die BOX
# meldet - der Simulator ist die Quelle, nicht der Zeuge.
connector_json() {
  ocpp_json \
    | sed -e "s/.*\"id\":\"$1\"//" -e 's/},{"id":"SAEULE.*//' \
    | sed -e "s/.*{\"id\":$2,//" -e 's/}.*//'
}

# sim_status <status-addr> <stecker> <status> [fehlercode] - der Rig-Haken.
sim_status() {
  local q="connector=$2&status=$3"
  [ -n "${4:-}" ] && q="${q}&error=$4"
  curl -sf -X POST "http://$1/status?${q}" >/dev/null \
    || fail "Simulator lehnt Zustand '$3' ab"
}

# surplus_state - die Quellen-Bahn in einer Zeile (fuer Fehlermeldungen).
surplus_state() {
  echo "Ueberschuss: kw=$(surplus_kw) total=$(surplus_total) modus=$(surplus_mode) budget=$(budget_kw)/$(budget_mode) Saeulen=$(site_kw)"
}

waitfor() { # waitfor <sekunden> <beschreibung> <kommando...>
  local secs="$1" what="$2"; shift 2
  local deadline=$(( $(date +%s) + secs ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.3
  done
  fail "timeout ($secs s) beim Warten auf: $what"
}

# haelt <warte-s> <halte-s> <beschreibung> <kommando...> - warte auf den Zustand
# UND verlange, dass er ihn HAELT.
#
# ⚠ Sie gehoert ueberall dort hin, wo die Zusicherung ein EINGESCHWUNGENER
# Zustand ist. Ein Regelkreis kann den richtigen Wert im Vorbeigehen treffen und
# ihn danach wieder verlieren; eine Zusicherung, die den ERSTEN Treffer nimmt,
# prueft dann einen Zufall statt einer Zusage - und genau so hat der L15b-Defekt
# (die vergiftete Messwert-Paarung, 01.09.2026) in CI geflackert statt jedes Mal
# zu fallen: die Saeule stand fuer ein, zwei Sekunden auf dem richtigen Wert und
# fiel danach fuer eine ganze Glaettungs-Minute zurueck.
#
# ⚠ Sie ist NICHT fatal (0/1), damit der Aufrufer vorher noch die Lage
# ausdrucken kann - eine Untersuchung, die dafuer einen zweiten Lauf braucht,
# kostet auf dem geteilten Pruefstand eine halbe Stunde.
haelt() {
  local secs="$1" hold="$2" what="$3"; shift 3
  local deadline=$(( $(date +%s) + secs )) seen=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if "$@" >/dev/null 2>&1; then seen=1; break; fi
    sleep 0.3
  done
  if [ "$seen" -ne 1 ]; then
    echo "  timeout ($secs s) beim Warten auf: $what" >&2
    return 1
  fi
  deadline=$(( $(date +%s) + hold ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! "$@" >/dev/null 2>&1; then
      echo "  der Zustand haelt nicht ($hold s): $what" >&2
      return 1
    fi
    sleep 0.5
  done
  return 0
}

echo "=== OCPP-Lastmanagement-Rig ==="
echo "--- bauen"
( cd core && go build -o "$WORK/vp-edge-core" ./cmd/vp-edge-core )
( cd core && go build -o "$WORK/vp-ocpp-sim" ./cmd/vp-ocpp-sim )
( cd core && go build -o "$WORK/vp-netz-sim" ./cmd/vp-netz-sim )
( cd core && go build -o "$WORK/vp-mqtt-pub" ./cmd/vp-mqtt-pub )

echo "--- Kern starten (Ladepunkte AN, Steuerung freigegeben)"
mkdir -p "$WORK/data"
# Die DEV-Identität überspringt das Enrollment; die Cloud-URL zeigt bewusst ins
# Leere - der Kern versucht sie im Hintergrund und stört das Rig nicht. Das
# Lastmanagement ist per Konstruktion offline-fähig, und genau das zeigt das hier.
VP_DATA_DIR="$WORK/data" \
VP_HTTP_ADDR="127.0.0.1:${WEB_PORT}" \
VP_LOCAL_MQTT_ADDR="127.0.0.1:${BUS_PORT}" \
VP_OCPP_ENABLED=true VP_OCPP_PORT="${OCPP_PORT}" \
VP_CONTROL_ENABLED=true VP_CONSUMER_CONTROL_ENABLED=true \
VP_DEV_TENANT_ID=00000000-0000-0000-0000-000000000001 \
VP_DEV_SITE_ID=00000000-0000-0000-0000-000000000002 \
VP_DEV_DEVICE_ID=00000000-0000-0000-0000-000000000003 \
VP_DEV_CLOUD_URL="tcp://127.0.0.1:1" \
  "$WORK/vp-edge-core" >"$WORK/core.log" 2>&1 &
CORE_PID=$!
waitfor 30 "die Box antwortet" curl -sf "${BOX}/health"

echo "--- Standort einrichten (das Szenario der abgenommenen Mockups)"
# 277 kW Anschluss, 10 % Sicherheitsabstand, 167 kW Gebäude -> 82,3 kW Budget.
curl -sf -X POST "${BOX}/api/ocpp/settings" -H 'Content-Type: application/json' \
  -d '{"grid_limit_kw":277,"house_reserve_kw":167,"margin_pct":10,"min_power_kw":30,"rotation_minutes":15,"max_house_load_kw":180}' >/dev/null \
  || fail "Standort-Einstellungen abgelehnt"
BUDGET=$(budget_kw)
nearly "$BUDGET" 82.3 0.05 || fail "Budget ist $BUDGET kW, erwartet 82,3 kW"
pass "Budget 82,3 kW (der Sicherheitsabstand kommt von der Anschlussgrenze, dann erst das Gebäude)"

for id in SAEULE-1 SAEULE-2; do
  curl -sf -X POST "${BOX}/api/ocpp/chargers" -H 'Content-Type: application/json' \
    -d "{\"id\":\"${id}\",\"label\":\"${id}\",\"rated_kw\":240,\"connectors\":2}" >/dev/null \
    || fail "Ladepunkt ${id} konnte nicht eingetragen werden"
done

echo "--- Ladesäulen verbinden"
"$WORK/vp-ocpp-sim" --csms "ws://127.0.0.1:${OCPP_PORT}/ocpp" --id SAEULE-1 \
  --connectors 2 --status "$S1_STATUS" >"$WORK/s1.log" 2>&1 &
SIM_PIDS+=($!)
"$WORK/vp-ocpp-sim" --csms "ws://127.0.0.1:${OCPP_PORT}/ocpp" --id SAEULE-2 \
  --connectors 2 --status "$S2_STATUS" --reject-full-configuration \
  >"$WORK/s2.log" 2>&1 &
SIM_PIDS+=($!)
sims_up() { curl -sf "http://${S1_STATUS}/status" >/dev/null && curl -sf "http://${S2_STATUS}/status" >/dev/null; }
waitfor 20 "beide Säulen melden sich" sims_up

# Eingerichtet heißt: die zwei PERMANENTEN Profile liegen an der Säule.
commissioned() {
  local body
  for addr in "$S1_STATUS" "$S2_STATUS"; do
    body=$(curl -sf "http://${addr}/status") || return 1
    echo "$body" | grep -q TxDefaultProfile || return 1
    echo "$body" | grep -q ChargePointMaxProfile || return 1
  done
}
waitfor 60 "die Säulen sind eingerichtet" commissioned
pass "Sicherheitsprofil + Höchstgrenze bei jeder Säule hinterlegt"

# ---------------------------------------------------------------- L1
echo "--- L1: zwei Fahrzeuge teilen sich das Budget"
curl -sf -X POST "http://${S1_STATUS}/plug?connector=1&demand=240&min=5" >/dev/null
curl -sf -X POST "http://${S2_STATUS}/plug?connector=1&demand=240&min=5" >/dev/null
l1_ready() { [ "$(charging_count)" -eq 2 ] && nearly "$(site_kw)" 82.3 0.5; }
waitfor 60 "beide laden" l1_ready
A=$(drawn $S1_STATUS); B=$(drawn $S2_STATUS); TOTAL=$(site_kw)
nearly "$A" 41.15 0.5 || fail "L1: Säule 1 zieht $A kW, erwartet 41,15"
nearly "$B" 41.15 0.5 || fail "L1: Säule 2 zieht $B kW, erwartet 41,15"
nearly "$TOTAL" 82.3 0.5 || fail "L1: der Standort zieht $TOTAL kW, das Budget ist 82,3"
pass "L1: 2 × 41,15 kW = 82,3 kW - das Budget wird an den Säulen gehalten"

# ---------------------------------------------------------------- L2
echo "--- L2: ein drittes Fahrzeug steckt an"
curl -sf -X POST "http://${S1_STATUS}/plug?connector=2&demand=240&min=5" >/dev/null
# Drei Fahrzeuge, 82,3 kW: 27,4 kW je Stueck laegen UNTER der 30-kW-
# Mindestleistung. Also laden weiterhin genau zwei, und eines wartet.
l2_ready() { [ "$(charging_count)" -eq 2 ] && nearly "$(site_kw)" 82.3 0.5 \
  && curl -sf "${BOX}/api/ocpp" | grep -q '"reason":"wartet_budget"'; }
waitfor 60 "die Umverteilung ist da" l2_ready
TOTAL=$(site_kw)
awk -v t="$TOTAL" 'BEGIN{exit (t<=82.8)?0:1}' || fail "L2: der Standort zieht $TOTAL kW - über dem Budget"
# 82,3 kW auf DREI Fahrzeuge wären 27,4 kW - unter der 30-kW-Mindestleistung.
# Also laden zwei und eines wartet: pausieren schlägt aushungern.
for probe in "$S1_STATUS 1" "$S1_STATUS 2" "$S2_STATUS 1"; do
  set -- $probe
  d=$(drawn "$1" "$2")
  awk -v d="${d:-0}" 'BEGIN{exit (d>0.5 && d<29.9)?1:0}' || fail "L2: ein Fahrzeug hungert bei $d kW (unter der Mindestleistung)"
done
CHARGING=$(charging_count)
[ "$CHARGING" -eq 2 ] || fail "L2: $CHARGING Fahrzeuge laden, erwartet 2 (das dritte muss warten)"
pass "L2: $TOTAL kW unter der Grenze, zwei laden ≥ 30 kW, eines wartet"

# ---------------------------------------------------------------- L5
echo "--- L5: der wartende Ladevorgang trägt seinen GRUND (und keine erfundene Zahl)"
OCPP_JSON=$(curl -sf "${BOX}/api/ocpp")
echo "$OCPP_JSON" | grep -q '"reason":"wartet_budget"' \
  || fail "L5: kein wartender Ladevorgang mit dem Grund 'wartet_budget' gemeldet"
echo "$OCPP_JSON" | grep -q '"reason_text":"wartet' \
  || fail "L5: der wartende Ladevorgang trägt keinen deutschen Satz"
pass "L5: der Wartende nennt seinen Grund - kein Fahrzeug bleibt unerklärt stehen"

# ---------------------------------------------------------------- L3
echo "--- L3: eines steckt ab, die Leistung wird wieder frei"
curl -sf -X POST "http://${S1_STATUS}/unplug?connector=2" >/dev/null
l3_ready() { [ "$(charging_count)" -eq 2 ] && nearly "$(site_kw)" 82.3 0.5 \
  && ! curl -sf "${BOX}/api/ocpp" | grep -q '"reason":"wartet_budget"'; }
waitfor 60 "die Freigabe ist verteilt" l3_ready
TOTAL=$(site_kw)
nearly "$TOTAL" 82.3 0.5 || fail "L3: nach dem Abstecken zieht der Standort $TOTAL kW, erwartet 82,3"
pass "L3: die freigewordene Leistung ist wieder verteilt, niemand wartet mehr (Standort $TOTAL kW)"

# ---------------------------------------------------------------- L6
echo "--- L6: das Budget folgt dem GEMESSENEN Netzanschluss (Stufe 2)"
# Der simulierte Netz-Zaehler meldet den VERKNUEPFUNGSPUNKT: Gebaeudelast PLUS
# das, was die Saeulen gerade ziehen (er LIEST ihren Zug, wie ein echter Zaehler
# ihn sieht) - auf demselben lokalen Bus, ueber den eine Layer-1-Verdrahtung
# einen Netz-Zaehler meldet. Es gibt also keinen Test-Hebel, nur den echten Weg.
"$WORK/vp-netz-sim" --bus "127.0.0.1:${BUS_PORT}" --status "$NETZ_STATUS" \
  --house 20 --charger "http://${S1_STATUS}/status" --charger "http://${S2_STATUS}/status" \
  >"$WORK/netz.log" 2>&1 &
NETZ_PID=$!
waitfor 20 "der Netz-Zaehler meldet sich" curl -sf "http://${NETZ_STATUS}/status"

# 249,3 kW planbar - 20 kW uebriger Standortbezug = 229,3 kW Ladebudget.
l6_measured() { [ "$(budget_mode)" = "gemessen" ] && nearly "$(budget_kw)" 229.3 0.6; }
waitfor 90 "das Budget folgt der Messung" l6_measured
waitfor 90 "die Fahrzeuge haben die freie Leistung uebernommen" site_near 229.3 1.0
TOTAL=$(site_kw)
nearly "$TOTAL" 229.3 1.0 || fail "L6: der Standort zieht $TOTAL kW, erwartet 229,3"
pass "L6a: die gemessenen 20 kW Gebaeudelast ersetzen die gepflegten 167 kW - $TOTAL kW statt 82,3 kW"

# Eine Maschine im Gebaeude geht an: 100 kW. 249,3 - 100 = 149,3 kW.
curl -sf -X POST "http://${NETZ_STATUS}/set?house=100" >/dev/null
l6_step() { nearly "$(budget_kw)" 149.3 0.6; }
waitfor 90 "das Budget zieht sich zusammen" l6_step
waitfor 90 "die Fahrzeuge sind heruntergeregelt" site_near 149.3 1.0
TOTAL=$(site_kw)
nearly "$TOTAL" 149.3 1.0 || fail "L6: nach dem Lastsprung zieht der Standort $TOTAL kW, erwartet 149,3"
# Und der Anschluss haelt: Gebaeude + Laden bleibt unter der planbaren Leistung.
SITE=$(awk -v c="$TOTAL" 'BEGIN{print 100+c}')
awk -v s="$SITE" 'BEGIN{exit (s<=249.9)?0:1}' \
  || fail "L6: der Verknuepfungspunkt traegt $SITE kW - ueber den planbaren 249,3 kW"
pass "L6b: Lastsprung im Gebaeude -> Budget $TOTAL kW, Verknuepfungspunkt $SITE kW unter 249,3"

# Der Zaehler faellt aus. BLIND HEISST NIE UNBEGRENZT: das Budget wird
# GEHALTEN, nicht auf die 229,3 kW von vorhin freigegeben.
kill "$NETZ_PID"; wait "$NETZ_PID" 2>/dev/null || true; NETZ_PID=""
sleep 45   # laenger als das Frische-Fenster (30 s)
MODE=$(budget_mode); HELD=$(budget_kw)
[ "$MODE" = "haelt" ] || fail "L6: nach dem Messausfall ist der Modus '$MODE', erwartet 'haelt'"
nearly "$HELD" 149.3 0.6 || fail "L6: das Budget wurde auf $HELD kW freigegeben statt gehalten"
pass "L6c: Messausfall -> das Budget wird bei $HELD kW GEHALTEN, nicht freigegeben"

# Und wenn das Halten nicht mehr vertretbar ist, wird auf das SICHERE Budget
# zusammengezogen (249,3 - hoechste bekannte Gebaeudelast 180 = 69,3 kW).
# Geprueft wird die BEWEGUNG, nicht ein Schwellwert: zwei Messungen, und die
# zweite muss spuerbar tiefer liegen - ein Schwellwert waere schon eine Sekunde
# nach Beginn der Kontraktion erfuellt und wuerde nichts beweisen.
l6_contracting() { [ "$(budget_mode)" = "zieht_zusammen" ]; }
waitfor 180 "das Budget beginnt sich zusammenzuziehen" l6_contracting
FROM=$(budget_kw)
sleep 25
TO=$(budget_kw)
awk -v a="$FROM" -v b="$TO" 'BEGIN{exit (b<a-3)?0:1}' \
  || fail "L6: das Budget bewegt sich nicht ($FROM -> $TO kW)"
awk -v b="$TO" 'BEGIN{exit (b>=69.2)?0:1}' \
  || fail "L6: das Budget ist unter das sichere Budget gefallen ($TO kW < 69,3)"
pass "L6d: ohne Messung wird zusammengezogen ($FROM -> $TO kW, Ziel 69,3) - nie freigegeben"

# ---------------------------------------------------------------- L7
echo "--- L7: (Stufe 4) „Nur Sonnenstrom\" deckelt auf den gemessenen Überschuss"
# Der Zaehler meldet den VERKNUEPFUNGSPUNKT. Eine NEGATIVE Gebaeudelast ist die
# PV: waehrend nichts laedt, speist der Standort 120 kW ein - genau der
# Ueberschuss, aus dem die Quellen-Bahn abgeleitet wird.
#
# ⚠ Die Rechnung ist stabil, obwohl die Autos gleich daran ziehen: der Rest des
# Standorts ist `Netz - Laden`, und beide Haelften stammen aus DEMSELBEN
# Augenblick (das ist der Grund, warum die Box sie am Telemetrie-Chokepoint
# paart). Ziehen die Autos 120 kW, meldet der Zaehler 0 - der Rest bleibt -120.
"$WORK/vp-netz-sim" --bus "127.0.0.1:${BUS_PORT}" --status "$NETZ_STATUS" \
  --house -120 --battery 0 \
  --charger "http://${S1_STATUS}/status" --charger "http://${S2_STATUS}/status" \
  >"$WORK/netz2.log" 2>&1 &
NETZ_PID=$!
waitfor 20 "der Netz-Zaehler meldet wieder" curl -sf "http://${NETZ_STATUS}/status"
policy nur_sonne speicher_vor_auto

l7_ready() { [ "$(surplus_mode)" = "gemessen" ] && nearly "$(surplus_kw)" 120 1.0; }
waitfor 200 "der Ueberschuss wird gemessen" l7_ready || { surplus_state; exit 1; }
SURPLUS=$(surplus_kw); PHYS=$(budget_kw)
# ⚠ Die physische Bahn steht bei den planbaren 249,3 kW, NICHT bei 369 kW: das
# Budget wird bewusst nie ueber die planbare Leistung des Anschlusses gehoben,
# auch wenn der Standort gerade einspeist (measuredBudget - eine Wolke nimmt
# den Ueberschuss in Sekunden, und kein Sekunden-Regelkreis folgt dem). Der
# Fall beweist nur dann etwas, wenn sie DEUTLICH groesser ist als die Sonne.
awk -v p="$PHYS" -v s="$SURPLUS" 'BEGIN{exit (p>s+50)?0:1}' \
  || fail "L7: die physische Bahn ist $PHYS kW gegen $SURPLUS kW Sonne - zu nah beieinander, der Fall beweist nichts"
waitfor 120 "die Fahrzeuge laden aus dem Ueberschuss" site_near 120 1.5
TOTAL=$(site_kw)
nearly "$TOTAL" 120 1.5 || fail "L7: der Standort zieht $TOTAL kW, erwartet den Ueberschuss 120"
pass "L7: $TOTAL kW aus $SURPLUS kW Sonne - die niedrigere der beiden Bahnen gewinnt (physisch waeren $PHYS kW erlaubt)"

# Und der Standort kauft dabei NICHTS: Gebaeude + Laden = -120 + 120 = 0.
#
# ⚠ Gewartet, nicht einmal gemessen: der Zaehler veroeffentlicht alle 2 s und
# LIEST den Zug der Saeulen - waehrend die Fahrzeuge von der vorigen Stufe
# herunterfahren, ist sein Wert kurz von gestern. Geprueft wird der Zustand,
# in dem die Anlage zur Ruhe kommt, nicht ein Augenblick der Rampe.
grid_meter_kw() { curl -sf "http://${NETZ_STATUS}/status" | sed -n 's/.*"grid_kw":\([-0-9.e]*\).*/\1/p'; }
l7_no_import() { awk -v g="$(grid_meter_kw)" 'BEGIN{exit (g<=1.5)?0:1}'; }
waitfor 90 "der Verknuepfungspunkt kommt zur Ruhe" l7_no_import
GRID=$(grid_meter_kw)
awk -v g="$GRID" 'BEGIN{exit (g<=1.5)?0:1}' \
  || fail "L7: der Verknuepfungspunkt bezieht $GRID kW - „Nur Sonnenstrom\" hat Netzstrom gekauft"
pass "L7b: der Verknuepfungspunkt steht bei $GRID kW - es wurde kein Netzstrom gekauft"

# ---------------------------------------------------------------- L8
echo "--- L8: (Stufe 4) die zwei Prioritaeten bewegen WIRKLICH Leistung"
# Jetzt nimmt der Speicher 40 kW von der Sonne: PV 120 - Speicher 40 = 80 kW
# Einspeisung, waehrend nichts laedt.
#
# ⚠ Der Zaehler bildet den Speicher NICHT nach, wie er auf die Klemme reagiert -
# das Rig ist kein Physik-Simulator. Es misst genau das, was es messen soll: wie
# viel die Box den AUTOS zugesteht, wenn der Kunde die Reihenfolge umlegt.
curl -sf -X POST "http://${NETZ_STATUS}/set?house=-80&battery=40" >/dev/null
# ⚠ Grosszuegige Fristen, und zwar aus einem BENANNTEN Grund: der Rest des
# Standorts wird als MAXIMUM ueber ein 60-s-Fenster genommen (BudgetSmoothWindow),
# und waehrend die Fahrzeuge herunterfahren liest der Zaehler ihren Zug kurz zu
# hoch. Beides UNTERSCHAETZT den Ueberschuss - die Bahn ist konservativ, nie
# grosszuegig. Geprueft wird der Zustand, in dem die Anlage zur Ruhe kommt.
l8_storage_first() { nearly "$(surplus_kw)" 80 1.0 && nearly "$(surplus_total)" 120 1.0; }
waitfor 200 "der Speicher hat Vorrang" l8_storage_first || { surplus_state; exit 1; }
waitfor 120 "die Fahrzeuge folgen dem Rest" site_near 80 1.5
FIRST=$(site_kw)
nearly "$FIRST" 80 1.5 || fail "L8: mit „Speicher vor Auto\" ziehen die Fahrzeuge $FIRST kW, erwartet 80"
pass "L8a: „Speicher vor Auto\" - der Speicher nimmt 40 kW, die Fahrzeuge bekommen $FIRST kW von 120"

policy nur_sonne auto_vor_speicher
l8_cars_first() { nearly "$(surplus_kw)" 120 1.0; }
waitfor 200 "die Fahrzeuge haben Vorrang" l8_cars_first || { surplus_state; exit 1; }
waitfor 120 "die Fahrzeuge holen sich den GANZEN Ueberschuss" site_near 120 1.5
SECOND=$(site_kw)
nearly "$SECOND" 120 1.5 || fail "L8: mit „Auto vor Speicher\" ziehen die Fahrzeuge $SECOND kW, erwartet 120"
awk -v a="$FIRST" -v b="$SECOND" 'BEGIN{exit (b>a+20)?0:1}' \
  || fail "L8: die Wahl bewegt nichts ($FIRST -> $SECOND kW)"
pass "L8b: „Auto vor Speicher\" - dieselbe Sonne, $FIRST -> $SECOND kW an den Saeulen"

# ---------------------------------------------------------------- L9
echo "--- L9: (Stufe 4 + P3b) die zwei Richtungen des EINEN Handeingriffs"
policy nur_sonne speicher_vor_auto
waitfor 200 "zurueck auf dem Ueberschuss-Deckel" site_near 80 1.5
BEFORE_1=$(drawn $S1_STATUS 1)
curl -sf -X POST "${BOX}/api/ocpp/boost" -H 'Content-Type: application/json' \
  -d '{"charge_point_id":"SAEULE-1","connector_id":1}' | grep -q '"active":true' \
  || fail "L9: die Uebersteuerung wurde nicht angenommen"

# Der uebersteuerte Ladevorgang konkurriert nicht mehr um den Ueberschuss - er
# wird aus der PHYSISCHEN Bahn bedient und darf dafuer Netzstrom ziehen.
# 249,3 kW planbar minus die 80 kW, die der andere aus der Sonne bekommt.
l9_boosted() { awk -v d="$(drawn $S1_STATUS 1)" 'BEGIN{exit (d>120)?0:1}'; }
waitfor 120 "der uebersteuerte Ladevorgang zieht hoch" l9_boosted
BOOSTED=$(drawn $S1_STATUS 1); OTHER=$(drawn $S2_STATUS 1)
awk -v d="$BOOSTED" 'BEGIN{exit (d>120)?0:1}' \
  || fail "L9: der uebersteuerte Ladevorgang zieht nur $BOOSTED kW"
# Und der ANDERE ist NICHT mit freigegeben - eine Uebersteuerung gilt GENAU
# EINEM Ladevorgang. Er bleibt hoechstens auf seinem Anteil der Sonne; nimmt
# der uebersteuerte Ladevorgang die physische Bahn ganz in Anspruch, bleibt
# unter der Mindestleistung nichts uebrig und er PAUSIERT - aushungern gibt es
# hier nicht (L2/L5), und der Grund steht dabei.
awk -v d="$OTHER" 'BEGIN{exit (d<=85)?0:1}' \
  || fail "L9: der zweite Ladevorgang zieht $OTHER kW - die Uebersteuerung hat die ganze Anlage freigegeben"
if awk -v d="${OTHER:-0}" 'BEGIN{exit (d<0.5)?0:1}'; then
  curl -sf "${BOX}/api/ocpp" | grep -q '"reason":"wartet' \
    || fail "L9: der zweite Ladevorgang steht still, ohne seinen Grund zu nennen"
  OTHER_NOTE="er pausiert mit genanntem Grund"
else
  awk -v d="$OTHER" 'BEGIN{exit (d>=29.9)?0:1}' \
    || fail "L9: der zweite Ladevorgang hungert bei $OTHER kW (unter der Mindestleistung)"
  OTHER_NOTE="er laedt weiter mit $OTHER kW"
fi
# Der Anschluss haelt trotzdem: Gebaeude + Laden bleibt unter den planbaren 249,3 kW.
GRID=$(grid_meter_kw)
awk -v g="$GRID" 'BEGIN{exit (g<=249.9)?0:1}' \
  || fail "L9: der Verknuepfungspunkt traegt $GRID kW - ueber den planbaren 249,3 kW"
pass "L9a: uebersteuert $BOOSTED kW (vorher $BEFORE_1), der andere ist NICHT mitfreigegeben ($OTHER_NOTE), Anschluss $GRID kW"

# Zuruecknehmen - und die eigene Prioritaet des Kunden gilt wieder.
curl -sf -X POST "${BOX}/api/ocpp/boost" -H 'Content-Type: application/json' \
  -d '{"charge_point_id":"SAEULE-1","connector_id":1,"cancel":true}' >/dev/null \
  || fail "L9: die Uebersteuerung liess sich nicht zuruecknehmen"
waitfor 120 "die Prioritaet gilt wieder" site_near 80 2.0
AFTER=$(site_kw)
nearly "$AFTER" 80 2.0 || fail "L9: nach der Ruecknahme zieht der Standort $AFTER kW, erwartet den Ueberschuss 80"
pass "L9b: zurueckgenommen - der Standort steht wieder bei $AFTER kW auf der Sonne"

# --- L9c (P3b): das GESCHWISTER - „Laden pausieren" deckelt GENAU EINEN
# Ladevorgang auf 0, waehrend jeder andere unveraendert weiterlaedt. Gemessen
# an den SAEULEN, nie an einer Quittung.
BEFORE_2=$(drawn $S2_STATUS 1)
awk -v d="$BEFORE_2" 'BEGIN{exit (d>1)?0:1}' \
  || fail "L9c: der Nachbar muss vorher laden (er zieht $BEFORE_2 kW)"
curl -sf -X POST "${BOX}/api/ocpp/boost" -H 'Content-Type: application/json' \
  -d '{"charge_point_id":"SAEULE-1","connector_id":1,"pause":true}' \
  | grep -q '"pause":true' \
  || fail "L9c: die Pause wurde nicht angenommen"

l9c_paused() { awk -v d="$(drawn $S1_STATUS 1)" 'BEGIN{exit (d<0.5)?0:1}'; }
waitfor 120 "der pausierte Ladevorgang steht" l9c_paused
PAUSED=$(drawn $S1_STATUS 1); NEIGHBOUR=$(drawn $S2_STATUS 1)
awk -v d="$PAUSED" 'BEGIN{exit (d<0.5)?0:1}' \
  || fail "L9c: der pausierte Ladevorgang zieht $PAUSED kW"
# ⚠ Der Nachbar ist UNBERUEHRT - das ist die ganze Zusage des Dialogs. Er darf
# durch die frei gewordene Sonne hoeher, nie niedriger.
awk -v a="$BEFORE_2" -v b="$NEIGHBOUR" 'BEGIN{exit (b>=a-0.5)?0:1}' \
  || fail "L9c: der Nachbar verlor Leistung ($BEFORE_2 -> $NEIGHBOUR kW)"
# Und der Grund NENNT den Hebel: „wartet - kein Ueberschuss" schickte den
# Kunden zu seiner Quellen-Wahl statt zu seinem eigenen Eingriff.
curl -sf "${BOX}/api/ocpp" | grep -q '"reason":"handeingriff"' \
  || fail "L9c: die Pause nennt sich nicht - der Grund fehlt im Zustand"
pass "L9c: pausiert ($PAUSED kW), der Nachbar laedt weiter ($BEFORE_2 -> $NEIGHBOUR kW), Grund benannt"

# Dieselbe Ruecknahme wie beim Boost - „Automatik fortsetzen" ist EINE Handlung.
curl -sf -X POST "${BOX}/api/ocpp/boost" -H 'Content-Type: application/json' \
  -d '{"charge_point_id":"SAEULE-1","connector_id":1,"cancel":true}' >/dev/null \
  || fail "L9c: die Pause liess sich nicht zuruecknehmen"
l9c_back() { awk -v d="$(drawn $S1_STATUS 1)" 'BEGIN{exit (d>1)?0:1}'; }
waitfor 120 "die Quellen-Politik gilt wieder" l9c_back
BACK=$(drawn $S1_STATUS 1)
awk -v d="$BACK" 'BEGIN{exit (d>1)?0:1}' \
  || fail "L9c: nach der Ruecknahme zieht der Ladevorgang $BACK kW"
pass "L9d: zurueckgenommen - der Ladevorgang laedt wieder ($BACK kW)"

# Und die Bindung an DIE Sitzung: abstecken beendet die Pause, ein NEUES
# Fahrzeug erbt sie nie.
curl -sf -X POST "${BOX}/api/ocpp/boost" -H 'Content-Type: application/json' \
  -d '{"charge_point_id":"SAEULE-1","connector_id":1,"pause":true}' >/dev/null \
  || fail "L9e: die Pause wurde nicht angenommen"
waitfor 120 "wieder pausiert" l9c_paused
curl -sf -X POST "http://${S1_STATUS}/unplug?connector=1" >/dev/null \
  || fail "L9e: abstecken schlug fehl"
sleep 2
curl -sf -X POST "http://${S1_STATUS}/plug?connector=1&demand=240&min=5" >/dev/null \
  || fail "L9e: einstecken schlug fehl"
waitfor 150 "das NAECHSTE Fahrzeug laedt" l9c_back
INHERIT=$(drawn $S1_STATUS 1)
awk -v d="$INHERIT" 'BEGIN{exit (d>1)?0:1}' \
  || fail "L9e: das naechste Fahrzeug erbt die Pause ($INHERIT kW)"
pass "L9e: abgesteckt - das naechste Fahrzeug erbt die Pause nicht ($INHERIT kW)"

# ---------------------------------------------------------------- L10
echo "--- L10: vollständiges OCPP-Datenjournal (Slice 10)"
JOURNAL_DIR="$WORK/data/ocpp-journal"
[ -d "$JOURNAL_DIR" ] || fail "L10: kein dauerhaftes OCPP-Journal angelegt"
journal_has() { grep -R -F -q -- "$1" "$JOURNAL_DIR"; }

journal_has '"message_type":"Call"' || fail "L10: OCPP Call fehlt"
journal_has '"message_type":"CallResult"' || fail "L10: OCPP CallResult fehlt"
journal_has '"action":"BootNotification"' || fail "L10: BootNotification fehlt"
journal_has '"action":"StatusNotification"' || fail "L10: StatusNotification fehlt"
journal_has '"vendorErrorCode":"RV-0"' || fail "L10: Status-Vendorfelder fehlen"
journal_has '"action":"Authorize"' || fail "L10: Authorize fehlt"
journal_has '"action":"StartTransaction"' || fail "L10: StartTransaction fehlt"
journal_has '"action":"StopTransaction"' || fail "L10: StopTransaction fehlt"
journal_has '"reason":"EVDisconnected"' || fail "L10: Stopgrund fehlt"
journal_has '"transactionData"' || fail "L10: transactionData fehlt"
journal_has '"action":"DiagnosticsStatusNotification"' || fail "L10: Diagnostics-Status fehlt"
journal_has '"action":"FirmwareStatusNotification"' || fail "L10: Firmware-Status fehlt"
journal_has '"action":"GetConfiguration"' || fail "L10: vollständiges GetConfiguration fehlt"
journal_has '"key":"SupportedFeatureProfiles"' || fail "L10: SupportedFeatureProfiles fehlt"
journal_has '"key":"RigVendor.Mode"' || fail "L10: Vendor-Key fehlt"
journal_has '"key":"AuthorizationKey"' || fail "L10: redigierter Secret-Key-Beleg fehlt"
journal_has '"redacted":true' || fail "L10: AuthorizationKey ist nicht als redigiert markiert"
journal_has '"message_type":"CallError"' || fail "L10: verweigerte Vollinventur nicht belegt"
journal_has '"error_description":"[redacted-call-error-description]"' \
  || fail "L10: CallError-Freitext ist nicht konservativ redigiert"

# Zwei Spannungen unterscheiden sich NUR in der Phase. Beide muessen im Wire-
# Journal mit allen Dimensionen stehen; die Cloud baut daraus verschiedene
# Point-Keys (der API-Integrationstest prueft genau diese Eindeutigkeit).
journal_has '"context":"Sample.Periodic","format":"Raw","location":"Outlet","measurand":"Voltage","phase":"L1-N","unit":"V"' \
  || fail "L10: vollständige L1-N-Messdimension fehlt"
journal_has '"context":"Sample.Periodic","format":"Raw","location":"Outlet","measurand":"Voltage","phase":"L2-N","unit":"V"' \
  || fail "L10: vollständige L2-N-Messdimension fehlt"

if grep -R -q -- 'rig-secret-must-never-leave-edge' "$JOURNAL_DIR"; then
  fail "L10: AuthorizationKey ist unmaskiert im Journal"
fi
if grep -R -q -- 'RIG-TAG' "$JOURNAL_DIR"; then
  fail "L10: idTag ist unmaskiert im Journal"
fi
for secret in rig-full-secret rig-url-token RIG-DESC-TAG rig-generic-secret; do
  if grep -R -q -- "$secret" "$JOURNAL_DIR"; then
    fail "L10: CallError-Freitext-Secret ${secret} ist unmaskiert im Journal"
  fi
  if grep -q -- "$secret" "$WORK/core.log"; then
    fail "L10: CallError-Freitext-Secret ${secret} ist unmaskiert im Edge-Log"
  fi
done
journal_has 'tagref_' || fail "L10: maskierter idTag-/LocalAuth-Bezug fehlt"
pass "L10: Vollinventur best-effort, gezielte Sicherheitsabfrage erfolgreich; Events vollständig und Secrets vor Disk redigiert"

# ---------------------------------------------------------------- L13
echo "--- L13: die Zustandswörter (Cockpit Phase 0, Entscheid E7)"
# Die Abnahme der Phase 0 läuft am SIMULATOR: das Rig fährt jeden Zustand, den
# eine echte Säule melden kann, und prüft, dass die BOX genau die Form
# weiterreicht, aus der das Portal sein deutsches Wort bildet. Die Vektoren
# stehen in `docs/contracts/ocpp-ladezustand-vectors.json`; die andere Hälfte
# (Form -> Wort) prüft `frontend/portal/src/ladepunkte.test.ts` an derselben
# Datei. Reisst ein Glied, fällt genau EINE der beiden Seiten - nie beide still.
VEKTOREN="../docs/contracts/ocpp-ladezustand-vectors.json"
[ -f "$VEKTOREN" ] || fail "L13: die geteilten Zustands-Vektoren fehlen"

# ⚠ Der Schritt ist UMKEHRBAR gebaut: er fasst keine Säule an, die L4 danach
# noch braucht, und gibt Stecker 1 am Ende über einen SAUBEREN Ein-/Aussteck-
# Zyklus an das Lastmanagement zurück - erst wenn er wieder wirklich zieht, ist
# der Schritt fertig. Ein Abnahme-Schritt, der seine Nachbarn beschädigt, prüft
# am Ende sie statt sich.
l13_plug() {
  curl -sf -X POST "http://${S1_STATUS}/unplug?connector=1" >/dev/null || true
  sleep 1
  curl -sf -X POST "http://${S1_STATUS}/plug?connector=1&demand=240&min=5" >/dev/null \
    || fail "L13: der Wagen liess sich nicht einstecken"
}
l13_charging() { connector_json SAEULE-1 1 | grep -q '"status":"Charging"'; }
l13_zieht()    { awk -v d="$(drawn $S1_STATUS 1)" 'BEGIN{exit (d>30)?0:1}'; }

l13_plug
waitfor 30 "Stecker 1 lädt" l13_charging
connector_json SAEULE-1 1 | grep -q '"charging":true' \
  || fail "L13: ein ladender Stecker meldet charging=false"
# ⚠ Die Leistung kommt mit dem NÄCHSTEN MeterValues-Takt der Säule (10 s), nicht
# mit der StatusNotification - sofort danach zu prüfen hiesse, das Fehlen einer
# noch nicht gesendeten Messung als Fehler zu lesen.
l13_misst() { connector_json SAEULE-1 1 | grep -q '"power_kw":'; }
waitfor 40 "die Säule meldet ihre gemessene Leistung" l13_misst
pass "L13: Charging - Status, charging-Flag und gemessene Leistung liegen an"

# Jeder Zustand, den ein Ein-/Ausstecken NICHT erzeugt, über den Rig-Haken des
# Simulators. Die Namen sind die des OCPP-1.6-Vertrags UND die Schlüssel der
# Vektoren - läuft eines von beiden weg, fällt dieser Schritt.
for zustand in SuspendedEVSE SuspendedEV Finishing Preparing Unavailable Reserved; do
  grep -q "\"sim_status\": \"${zustand}\"" "$VEKTOREN" \
    || fail "L13: '${zustand}' fehlt in den geteilten Vektoren"
  sim_status "$S1_STATUS" 1 "$zustand"
  l13_is() { connector_json SAEULE-1 1 | grep -q "\"status\":\"${zustand}\""; }
  waitfor 15 "die Box meldet ${zustand}" l13_is
done
pass "L13: SuspendedEVSE · SuspendedEV · Finishing · Preparing · Unavailable · Reserved gemeldet"

# Störung: der Fehlercode reist mit, das WORT bleibt „Störung an der Säule" -
# der Code gehört auf die Geräteseite, nie in die Cockpit-Zeile.
sim_status "$S1_STATUS" 1 Faulted OtherError
l13_faulted() { connector_json SAEULE-1 1 | grep -q '"status":"Faulted"'; }
waitfor 15 "die Box meldet Faulted" l13_faulted
pass "L13: Faulted (mit Fehlercode) gemeldet"

# ⚠ Und die Regel, die VOR jedem Stecker-Status gilt: eine Säule, die nicht
# spricht, meldet `connected:false` - über ihren Stecker wissen wir dann nichts,
# und jedes Wort darüber wäre eine Behauptung. Der Beweis läuft an einer eigenen,
# nie verbundenen Säule OHNE Stecker: eine echte Trennung würde das Budget
# umverteilen und L4 an einer Ursache scheitern lassen, die nichts mit L4 zu tun
# hat.
curl -sf -X POST "${BOX}/api/ocpp/chargers" -H 'Content-Type: application/json' \
  -d '{"id":"SAEULE-STUMM","label":"Nie verbunden","connectors":0}' >/dev/null \
  || fail "L13: die stumme Säule liess sich nicht eintragen"
ocpp_json | sed -e 's/.*"id":"SAEULE-STUMM"//' -e 's/}.*//' | grep -q '"connected":false' \
  || fail "L13: eine nie verbundene Säule meldet nicht connected=false"
curl -sf -X DELETE "${BOX}/api/ocpp/chargers/SAEULE-STUMM" >/dev/null \
  || fail "L13: die stumme Säule liess sich nicht wieder entfernen"
pass "L13: Säule getrennt - connected=false, unabhängig vom letzten Stecker-Status"

# Zurück in den Betrieb - und zwar BEWIESEN: nicht bis der Status wieder
# „Charging" sagt, sondern bis der Wagen wieder wirklich zieht. Ein
# `Unavailable` nimmt den Stecker aus der Zuteilung; käme er nur formal zurück,
# fiele L4 an einer Ursache, die nichts mit L4 zu tun hat.
l13_plug
waitfor 60 "Stecker 1 zieht wieder seinen Anteil" l13_zieht
pass "L13: Ausgangslage wiederhergestellt ($(drawn $S1_STATUS 1) kW)"

# ---------------------------------------------------------------- L11/L12
echo "--- L11/L12: OCPP-Command-Gateway (lokal, ohne Live-Station)"
# The real websocket rig above proves the station half. These focused checks
# prove the cloud command boundary covers every OCPP 1.6 action, survives
# replay/reconnect/crash/reverse responses and executes a real
# ChangeConfiguration -> CallResult -> targeted GetConfiguration readback.
( cd core && go test ./internal/csms -run 'TestCommandRequestCoversCompleteOcpp16Surface|TestCommandReplayAndReconnectAreDurablyDeduplicated|TestCommandCrashAfterDurableClaimNeverReplays|TestCommandDeadlineAndIdentityFailClosedBeforeExecution|TestWireCorrelationSurvivesCrashAndConcurrentReverseResponses|TestJournalCarriesExternalCorrelationAcrossWireID|TestCloudChangeConfigurationPersistsResponseAndPerformsReadback' -count=1 ) \
  || fail "L11/L12: Command-Dispatcher oder Korrelationsbrücke fehlgeschlagen"
pass "L11/L12: vollständige Command-Fläche, Replay/Deadline/Crash, exakte Korrelation und persistierter Readback lokal bewiesen"

# ---------------------------------------------------------------- L14
echo "--- L14: (P5/K3) die Arbitrierungs-Brücke - Halter deckelt · befreit · kein Halter"
# ⚠ EIGENER Kern, und zwar aus einem benannten Grund: die Brücke braucht die
# Entitäts-REGISTRY, und die kommt ausschliesslich über die Cloud
# (`.../v2/entities`). L1-L13 lassen ihre Cloud bewusst ins Leere zeigen, weil
# das Lastmanagement offline-fähig sein MUSS. Hier zeigt die Cloud-URL auf den
# EIGENEN lokalen Bus dieses zweiten Kerns - ein echter MQTT-Broker, also ein
# echter Downlink, ohne Docker und ohne ein Wort an der Aussage von L1-L13 zu
# ändern.
T_TEN=00000000-0000-0000-0000-000000000001
T_SITE=00000000-0000-0000-0000-000000000002
T_DEV=00000000-0000-0000-0000-000000000003
T_BASE="ems/${T_TEN}/${T_SITE}/${T_DEV}"
ENT_ID=11111111-2222-3333-4444-555555555555

mkdir -p "$WORK/data2"
VP_DATA_DIR="$WORK/data2" \
VP_HTTP_ADDR="127.0.0.1:${WEB_PORT2}" \
VP_LOCAL_MQTT_ADDR="127.0.0.1:${BUS_PORT2}" \
VP_OCPP_ENABLED=true VP_OCPP_PORT="${OCPP_PORT2}" \
VP_CONTROL_ENABLED=true VP_CONSUMER_CONTROL_ENABLED=true \
VP_DEV_TENANT_ID="$T_TEN" VP_DEV_SITE_ID="$T_SITE" VP_DEV_DEVICE_ID="$T_DEV" \
VP_DEV_CLOUD_URL="tcp://127.0.0.1:${BUS_PORT2}" \
  "$WORK/vp-edge-core" >"$WORK/core2.log" 2>&1 &
CORE2_PID=$!
waitfor 30 "der zweite Kern antwortet" curl -sf "${BOX2}/health"

# Derselbe Standort wie oben, aber mit zwei 22-kW-Säulen: der Deckel des
# Halters soll die bindende Grösse sein, nicht die Steckdose.
curl -sf -X POST "${BOX2}/api/ocpp/settings" -H 'Content-Type: application/json' \
  -d '{"grid_limit_kw":277,"house_reserve_kw":0,"margin_pct":10,"min_power_kw":5,"max_house_load_kw":180}' \
  >/dev/null || fail "L14: Einstellungen abgelehnt"
for saeule in SAEULE-B1 SAEULE-B2; do
  curl -sf -X POST "${BOX2}/api/ocpp/chargers" -H 'Content-Type: application/json' \
    -d "{\"id\":\"${saeule}\",\"connectors\":1,\"rated_kw\":22}" >/dev/null \
    || fail "L14: ${saeule} liess sich nicht eintragen"
done
"$WORK/vp-ocpp-sim" --csms "ws://127.0.0.1:${OCPP_PORT2}/ocpp" --id SAEULE-B1 \
  --connectors 1 --status "$B1_STATUS" >"$WORK/b1.log" 2>&1 &
SIM2_PIDS+=($!)
"$WORK/vp-ocpp-sim" --csms "ws://127.0.0.1:${OCPP_PORT2}/ocpp" --id SAEULE-B2 \
  --connectors 1 --status "$B2_STATUS" >"$WORK/b2.log" 2>&1 &
SIM2_PIDS+=($!)
waitfor 30 "beide Säulen verbunden" curl -sf "http://${B2_STATUS}/status"
for st in "$B1_STATUS" "$B2_STATUS"; do
  curl -sf -X POST "http://${st}/plug?connector=1&demand=22&min=5" >/dev/null \
    || fail "L14: Wagen liess sich nicht einstecken"
done

b1_kw() { drawn "$B1_STATUS" 1; }
b2_kw() { drawn "$B2_STATUS" 1; }
b1_near() { nearly "$(b1_kw)" "$1" "${2:-1.0}"; }
box2_json() { curl -sf "${BOX2}/api/ocpp" | sed -e 's/.*"ocpp":{//' -e 's/,"settings":{.*//'; }
connector2_json() { box2_json | sed -e 's/.*"id":"SAEULE-B1"//' -e 's/},{"id":"SAEULE-B2.*//'; }
b1_reason() { connector2_json | sed -n 's/.*"reason":"\([a-z_]*\)".*/\1/p' | head -1; }

l14_both_full() { nearly "$(b1_kw)" 22 1.0 && nearly "$(b2_kw)" 22 1.0; }
waitfor 60 "beide laden voll" l14_both_full

# --- kein Halter = die QUELLE der Säule gilt -----------------------------
# „Nur Sonnenstrom" OHNE Messung: die Bahn kann keinen Überschuss BELEGEN, also
# pausiert sie - fail-closed, genau wie L7. Kein Halter mischt sich ein.
curl -sf -X POST "${BOX2}/api/ocpp/settings" -H 'Content-Type: application/json' \
  -d '{"surplus_policy":"nur_sonne"}' >/dev/null || fail "L14: Quellen-Wahl abgelehnt"
l14_both_paused() { awk -v a="$(b1_kw)" -v b="$(b2_kw)" 'BEGIN{exit (a<1 && b<1)?0:1}'; }
waitfor 60 "ohne Halter gilt die Quelle" l14_both_paused
pass "L14a: kein Halter - beide Säulen folgen der Quellen-Wahl und pausieren"

# ---------------------------------------------------------------- L16
echo "--- L16: (P7) Fahrzeug-Profile - zwei Karten, zwei Steuerarten am selben Ladepark"
# ⚠ Er laeuft INNERHALB des L14-Aufbaus (zwischen L14a und L14b), weil er
# dessen zweiten Kern samt Entitaets-Registry braucht - und er muss VOR den
# Haltern von L14b-d laufen, damit ein Profil ohne fremden Wunsch sichtbar ist.
# Die Nummer ist deshalb hoeher als seine Stelle im Ablauf; L15 gehoert P6.
# ⚠ DER SCHLUESSEL IST DER PSEUDONYM DER BOX, und niemand sonst kann ihn
# bilden. Das Rig macht deshalb genau das, was das Portal macht: es LIEST die
# `tag_ref`, die die Box selbst gemeldet hat, und schreibt seine Profile darauf.
# Ein von aussen gerechneter Bezug traefe nie ein Fahrzeug.
# ⚠ HOECHSTENS 20 Zeichen: OCPP 1.6 begrenzt `IdToken` darauf, und die
# Client-Bibliothek weist einen laengeren Tag ab, BEVOR er die Box erreicht.
KARTE_A="RIG-KARTE-DIENST"
KARTE_B="RIG-KARTE-PRIVAT"

# tagref <sim-status> - der Pseudonym, den die Box fuer die Karte an DIESER
# Saeule gebildet hat (sie steht im lokalen `/api/ocpp`, nie in der Cloud).
tagref_of() { box2_json | sed -e "s/.*\"id\":\"$1\"//" -e 's/}]}.*//' \
  | sed -n 's/.*"tag_ref":"\([a-z0-9_]*\)".*/\1/p' | head -1; }

# Beide Wagen neu einstecken, jetzt mit IHRER Karte.
for st in "$B1_STATUS" "$B2_STATUS"; do
  curl -sf -X POST "http://${st}/unplug?connector=1" >/dev/null || fail "L16: Ausstecken"
done
curl -sf -X POST "http://${B1_STATUS}/plug?connector=1&demand=22&min=5&tag=${KARTE_A}" \
  >/dev/null || fail "L16: Karte A liess sich nicht einstecken"
curl -sf -X POST "http://${B2_STATUS}/plug?connector=1&demand=22&min=5&tag=${KARTE_B}" \
  >/dev/null || fail "L16: Karte B liess sich nicht einstecken"

l15_two_refs() { [ -n "$(tagref_of SAEULE-B1)" ] && [ -n "$(tagref_of SAEULE-B2)" ]; }
waitfor 30 "die Box hat beide Karten pseudonymisiert" l15_two_refs
REF_A=$(tagref_of SAEULE-B1)
REF_B=$(tagref_of SAEULE-B2)
[ "$REF_A" != "$REF_B" ] || fail "L16: zwei Karten, EIN Pseudonym ($REF_A)"
case "$REF_A" in tagref_*) ;; *) fail "L16: kein Pseudonym, sondern „$REF_A\"";; esac
# ⚠ Der KLARTEXT der Karte steht NIRGENDS - nicht in der Cloud-Form und nicht
# einmal auf der eigenen LAN-Flaeche der Box. `state.OcppInfo` traegt nur den
# Bezug; der IdTag verlaesst das `csms`-Paket gar nicht erst.
for flaeche in "${BOX2}/api/ocpp" "${BOX2}/api/state"; do
  curl -sf "$flaeche" | grep -q "$KARTE_A" \
    && fail "L16: der Klartext der Karte steht in $flaeche"
done
pass "L16a: die Box bildet je Karte ein eigenes Pseudonym ($REF_A / $REF_B)"

# profile <ref-schnell> - EIN Profil „Sofort laden", alle anderen ohne.
profile() {
  cat >"$WORK/vehicles.json" <<JSON
{"schema_version":"1.0","tenant_id":"${T_TEN}","site_id":"${T_SITE}","device_id":"${T_DEV}",
 "published_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "vehicle_profiles":[{"tag_ref":"$1","name":"Dienstwagen","source":"schnell"}]}
JSON
  "$WORK/vp-mqtt-pub" -broker "tcp://127.0.0.1:${BUS_PORT2}" \
    -topic "${T_BASE}/v2/charging-config" -retain -file "$WORK/vehicles.json" \
    || fail "L16: Profile liessen sich nicht veroeffentlichen"
}

# --- Die Karte faehrt ihre EIGENE Bahn -----------------------------------
# Die Anlage steht seit L14a auf „nur Sonnenstrom" OHNE Messung, also pausiert
# jede Saeule. Genau darin ist ein Profil sichtbar: der Dienstwagen laedt, der
# Privatwagen wartet weiter - am selben Ladepark, unter derselben Grenze.
profile "$REF_A"
l16_a_charges() { nearly "$(b1_kw)" 22 1.0 && awk -v d="$(b2_kw)" 'BEGIN{exit (d<1)?0:1}'; }
waitfor 60 "der Dienstwagen laedt, der Privatwagen wartet" l16_a_charges
pass "L16b: zwei Karten, zwei Steuerarten - A laedt $(b1_kw) kW, B pausiert ($(b2_kw) kW)"

# --- Das Profil folgt der KARTE, nicht der Saeule ------------------------
# ⚠ Der Beweis, den keine Saeulen-Einstellung liefern koennte: die Wagen
# TAUSCHEN die Plaetze, an den Saeulen aendert sich nichts - und die Ladung
# wandert mit der Karte.
for st in "$B1_STATUS" "$B2_STATUS"; do
  curl -sf -X POST "http://${st}/unplug?connector=1" >/dev/null || fail "L16: Ausstecken"
done
curl -sf -X POST "http://${B1_STATUS}/plug?connector=1&demand=22&min=5&tag=${KARTE_B}" \
  >/dev/null || fail "L16: Karte B liess sich nicht einstecken"
curl -sf -X POST "http://${B2_STATUS}/plug?connector=1&demand=22&min=5&tag=${KARTE_A}" \
  >/dev/null || fail "L16: Karte A liess sich nicht einstecken"
l16_swapped() { nearly "$(b2_kw)" 22 1.0 && awk -v d="$(b1_kw)" 'BEGIN{exit (d<1)?0:1}'; }
waitfor 60 "die Ladung wandert mit der Karte" l16_swapped
pass "L16c: die Wagen tauschen die Plaetze - jetzt laedt B2 ($(b2_kw) kW), B1 pausiert"

# --- Die RUECKNAHME: eine leere Liste nimmt alle Profile zurueck ----------
cat >"$WORK/vehicles.json" <<JSON
{"schema_version":"1.0","tenant_id":"${T_TEN}","site_id":"${T_SITE}","device_id":"${T_DEV}",
 "published_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","vehicle_profiles":[]}
JSON
"$WORK/vp-mqtt-pub" -broker "tcp://127.0.0.1:${BUS_PORT2}" \
  -topic "${T_BASE}/v2/charging-config" -retain -file "$WORK/vehicles.json" \
  || fail "L16: Ruecknahme liess sich nicht veroeffentlichen"
waitfor 60 "ohne Profil gilt wieder die Anlage" l14_both_paused
pass "L16d: leere Liste = keine Profile - beide Karten folgen wieder dem Ladepark"

# Ausgangslage fuer L14b wiederherstellen: die eine Rig-Karte, kein Profil.
for st in "$B1_STATUS" "$B2_STATUS"; do
  curl -sf -X POST "http://${st}/unplug?connector=1" >/dev/null || fail "L16: Ausstecken"
  curl -sf -X POST "http://${st}/plug?connector=1&demand=22&min=5" >/dev/null \
    || fail "L16: Wagen liess sich nicht einstecken"
done
waitfor 60 "die Ausgangslage steht wieder" l14_both_paused

# --- die Registry bindet Säule B1 an eine Komponente ---------------------
cat >"$WORK/registry.json" <<JSON
{"schema_version":"1.0","tenant_id":"${T_TEN}","site_id":"${T_SITE}","device_id":"${T_DEV}",
 "revision":"rig-p5","published_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "entities":[{"entity_id":"${ENT_ID}","entity_type":"ev-charger","label":"Stellplatz 1",
   "charge_point_id":"SAEULE-B1",
   "capabilities":{"measure":[{"channel":"power_kw","unit":"kW"}],
     "actuate":[{"command":"limit_kw","min":0,"max":22}]},
   "guards":{"limits":{"max_consumption_kw":22},"failsafe":{"behavior":"release"}}}]}
JSON
"$WORK/vp-mqtt-pub" -broker "tcp://127.0.0.1:${BUS_PORT2}" -topic "${T_BASE}/v2/entities" \
  -retain -file "$WORK/registry.json" || fail "L14: Registry liess sich nicht veroeffentlichen"
l14_bound() { curl -sf "${BOX2}/api/state" | grep -q "$ENT_ID"; }
waitfor 30 "die Box hat die Ladepunkt-Komponente" l14_bound

# wunsch <klasse> <quellenart> <limit_kw> [override] - ein Halter auf der Komponente.
wunsch() {
  cat >"$WORK/desired.json" <<JSON
{"schema_version":"1.0","entity_id":"${ENT_ID}","request_id":"rig-$(date +%s%N)",
 "source":{"kind":"$2"},"priority":"$1","override":${4:-false},"ttl_s":600,
 "issued_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "command":{"type":"limit_kw","value":$3}}
JSON
  "$WORK/vp-mqtt-pub" -broker "tcp://127.0.0.1:${BUS_PORT2}" \
    -topic "edge/entities/${ENT_ID}/desired" -file "$WORK/desired.json" \
    || fail "L14: Wunsch liess sich nicht veroeffentlichen"
}

# --- Halter BEFREIT: der PLAN nimmt die Säule aus der Quellen-Bahn -------
# Genau der Weg, auf dem „Günstige Stunden" und „Bis Uhrzeit fertig" eine
# OCPP-Säule erreichen: die Wolke entscheidet, DASS jetzt geladen wird, und
# der Ladepunkt bekommt es durch dieselbe Arbitrierung wie jeder Verbraucher.
wunsch market cloud-command 22
waitfor 60 "die befreite Säule lädt" b1_near 22 1.0
B2_STILL=$(b2_kw)
awk -v d="${B2_STILL:-0}" 'BEGIN{exit (d<1)?0:1}' \
  || fail "L14: die UNGEBUNDENE Säule wurde mitbefreit ($B2_STILL kW)"
pass "L14b: Halter befreit - B1 lädt $(b1_kw) kW auf der Quellen-Bahn, B2 pausiert weiter"

# --- Halter DECKELT ------------------------------------------------------
wunsch market cloud-command 6
waitfor 60 "der Deckel des Halters erreicht die Säule" b1_near 6 0.6
pass "L14c: Halter deckelt - B1 auf $(b1_kw) kW (Steckdose 22 kW)"

# --- Deckel 0 = PAUSE mit eigenem Grund ----------------------------------
# ⚠ Ein HANDEINGRIFF (local-ui + override, Rang 75) schlägt den Plan (60) - die
# D-6a-Regel, hier am Ladepunkt. Und der Grund heisst „regel", nicht „wartet":
# es fehlt keine Leistung, es HÄLT etwas, und der Kunde muss den Hebel
# erkennen können.
wunsch flow local-ui 0 true
l14_paused() { awk -v d="$(b1_kw)" 'BEGIN{exit (d<1)?0:1}'; }
waitfor 60 "die Säule pausiert" l14_paused
l14_reason_rule() { [ "$(b1_reason)" = "regel" ]; }
waitfor 30 "die Box nennt den Grund" l14_reason_rule \
  || { echo "    Stecker-Block: $(connector2_json)"; exit 1; }
pass "L14d: Handeingriff mit Deckel 0 - B1 pausiert, Grund „$(b1_reason)\" statt Leistungsmangel"

# ---------------------------------------------------------------- L15
echo "--- L15: (P6) die RANGLISTE erreicht die Box"
# Sie reist im retained `charging-config`-Dokument - also ueber genau den Weg,
# den P5 fuer die Steuerart je Saeule schon benutzt. Gemessen wird wie ueberall
# hier an dem, was die Saeulen ZIEHEN WUERDEN, nie an einer Quittung.

# Der Handeingriff aus L14d haelt B1 noch bei 0 - er wird zurueckgenommen,
# sonst misst L15 den Halter statt der Rangliste.
wunsch flow local-ui 0 true   # (derselbe Wunsch, gleich abgeloest)
"$WORK/vp-mqtt-pub" -broker "tcp://127.0.0.1:${BUS_PORT2}" \
  -topic "${T_BASE}/v2/entities" -retain -payload '' \
  || fail "L15: Registry liess sich nicht zuruecknehmen"
l15_frei() { ! curl -sf "${BOX2}/api/state" | grep -q "$ENT_ID"; }
waitfor 30 "die Komponente ist wieder weg" l15_frei
policy2() {
  curl -sf -X POST "${BOX2}/api/ocpp/settings" -H 'Content-Type: application/json' \
    -d "{\"surplus_policy\":\"$1\"}" >/dev/null || fail "L15: Quellen-Wahl abgelehnt"
}
policy2 schnell

# cfg <json-rumpf> - das retained Konfigurations-Dokument der Anlage.
cfg2() {
  cat >"$WORK/cfg.json" <<JSON
{"schema_version":"1.0","tenant_id":"${T_TEN}","site_id":"${T_SITE}","device_id":"${T_DEV}",
 "published_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",$1}
JSON
  "$WORK/vp-mqtt-pub" -broker "tcp://127.0.0.1:${BUS_PORT2}" \
    -topic "${T_BASE}/v2/charging-config" -retain -file "$WORK/cfg.json" \
    || fail "L15: Konfiguration liess sich nicht veroeffentlichen"
}

# --- L15a: zwei GERANKTE Saeulen bei knapper Leistung --------------------
# Budget: (30 - 10 %) - 0 Gebaeudelast = 27 kW fuer zwei 22-kW-Saeulen. Rang 1
# wird ZUERST voll bedient, der Rest bleibt fuer Rang 2 - und weil 5 kW ueber
# der Mindestleistung liegen, laedt er langsam weiter statt zu pausieren.
cfg2 '"grid_limit_kw":30,"charge_points":[{"id":"SAEULE-B1","rank":1},{"id":"SAEULE-B2","rank":2}]'
l15a() { b1_near 22 1.0 && nearly "$(b2_kw)" 5 1.0; }
haelt 60 6 "Rang 1 wird zuerst bedient" l15a \
  || { echo "    B1=$(b1_kw) B2=$(b2_kw)"; exit 1; }
pass "L15a: knappe Leistung - Rang 1 laedt $(b1_kw) kW, Rang 2 bekommt den Rest ($(b2_kw) kW)"

# Und die Gegenprobe: GLEICHE Raenge sind gleichrangig, also teilen sie sich
# die knappe Leistung wieder (die Rotation bleibt IHR Mechanismus).
cfg2 '"grid_limit_kw":30,"charge_points":[{"id":"SAEULE-B1","rank":1},{"id":"SAEULE-B2","rank":1}]'
l15a_gleich() { awk -v a="$(b1_kw)" -v b="$(b2_kw)" 'BEGIN{exit (a<21 && b>1)?0:1}'; }
haelt 60 6 "gleiche Raenge teilen wieder" l15a_gleich \
  || { echo "    B1=$(b1_kw) B2=$(b2_kw)"; exit 1; }
pass "L15a: gleiche Raenge sind GLEICHRANGIG - B1=$(b1_kw) B2=$(b2_kw)"

# --- L15b: der SPEICHER steht zwischen den zwei Saeulen ------------------
# Ein Netz-Zaehler auf dem zweiten Bus meldet Einspeisung und einen ladenden
# Speicher: 12 kW gehen ins Netz, waehrend der Speicher 10 kW nimmt. Fuer die
# Fahrzeuge sind das zwei verschiedene Toepfe - und WELCHEN eine Saeule sieht,
# entscheidet ihre Position zum Speicher:
#   unter dem Speicher: nur die 12 kW, die wirklich uebrig bleiben
#   ueber  dem Speicher: die ganzen 22 kW Sonne (10 davon nimmt sonst der Speicher)
"$WORK/vp-netz-sim" --bus "127.0.0.1:${BUS_PORT2}" --status "$NETZ_STATUS2" \
  --house -12 --battery 10 --interval 1s \
  --charger "http://${B1_STATUS}/status" --charger "http://${B2_STATUS}/status" \
  >"$WORK/netz3.log" 2>&1 &
NETZ2_PID=$!
# ⚠ Es wird der EINGESCHWUNGENE Zustand geprueft (haelt), nicht der erste
# Treffer: der Speicher-Split ist eine Zusage ueber die Lage, in der die Anlage
# zur Ruhe kommt. Bei einem Fehlschlag steht die Lage samt Zaehler im Protokoll,
# sonst kostet jede Untersuchung einen zweiten Lauf.
warte_l15() { # warte_l15 <sekunden> <beschreibung> <kommando...>
  local secs="$1" what="$2"; shift 2
  haelt "$secs" 6 "$what" "$@" && return 0
  echo "    B1=$(b1_kw) B2=$(b2_kw) netz=$(curl -sf "http://${NETZ_STATUS2}/status" || true)" >&2
  fail "L15: $what"
}

# UNTEN: B1 steht unter dem Speicher (Rang 2 gegen storage_rank 1) und sieht
# nur die 12 kW, die der Speicher uebrig laesst.
cfg2 '"grid_limit_kw":277,"surplus_policy":"nur_sonne","storage_priority":"speicher_vor_auto",
 "storage_rank":1,"charge_points":[{"id":"SAEULE-B1","rank":2},{"id":"SAEULE-B2","rank":3}]'
l15b_unten() { b1_near 12 1.5; }
warte_l15 90 "die Saeule unter dem Speicher sieht nur den Rest" l15b_unten
pass "L15b: B1 UNTER dem Speicher zieht $(b1_kw) kW - der Speicher geht vor"

# OBEN: dieselbe Sonne, dieselbe Saeule - nur ihre POSITION wechselt. Jetzt
# greift sie in den ganzen Ueberschuss und nimmt dem Speicher seine 10 kW ab.
cfg2 '"grid_limit_kw":277,"surplus_policy":"nur_sonne","storage_priority":"speicher_vor_auto",
 "storage_rank":2,"charge_points":[{"id":"SAEULE-B1","rank":1},{"id":"SAEULE-B2","rank":3}]'
l15b_oben() { b1_near 22 1.5; }
warte_l15 90 "die Saeule ueber dem Speicher greift in den ganzen Ueberschuss" l15b_oben
pass "L15b: B1 UEBER dem Speicher zieht $(b1_kw) kW - dieselbe Sonne, andere Position"

# --- L15c: eine WALLBOX nimmt als virtuelle Sitzung Budget weg -----------
# Sie haengt nicht an OCPP, sondern als v2-Verbraucher am Arbiter: die Box
# zaehlt ihre GEMESSENE Leistung ins Budget zurueck und deckelt sie ueber den
# Verbraucher-Sollwert. Ohne Eintrag in `wallboxes[]` ist sie blosse
# Gebaeudelast - genau das ist der Vorher-Zustand.
# ⚠ Der Netz-Zaehler BLEIBT an. Ihn hier zu toeten war eine Wettlauf-Quelle:
# das Budget haengt danach an der 30-s-Frische-Grenze, und wer sie verpasst,
# HAELT das zuletzt berechnete Budget des vorigen Blocks (249,3 kW statt 27) und
# misst 60 s lang einen Zustand, den es nie gab. Stattdessen wird der Standort
# EHRLICH umgestellt: das Gebaeude speist 12 kW ein und die Wallbox zieht 11, der
# Verknuepfungspunkt sieht also -1 kW plus die Saeulen. Weil `measuredBudget` auf
# die planbare Leistung deckelt, ist das Budget damit in BEIDEN Phasen exakt
# 27 kW - ohne Halten, ohne Zusammenziehen, ohne Wettlauf.
curl -sf -X POST "http://${NETZ_STATUS2}/set?house=-1" >/dev/null \
  || fail "L15c: die Gebaeudelast liess sich nicht umstellen"
policy2 schnell
WB_ID=99999999-8888-7777-6666-555555555555
cat >"$WORK/registry-wb.json" <<JSON
{"schema_version":"1.0","tenant_id":"${T_TEN}","site_id":"${T_SITE}","device_id":"${T_DEV}",
 "revision":"rig-p6","published_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "entities":[{"entity_id":"${WB_ID}","entity_type":"wallbox","label":"Wallbox Garage",
   "capabilities":{"measure":[{"channel":"power_kw","unit":"kW"}],
     "actuate":[{"command":"setpoint_kw","min":0,"max":11}]},
   "guards":{"limits":{"max_consumption_kw":11},"failsafe":{"behavior":"off"}}}]}
JSON
"$WORK/vp-mqtt-pub" -broker "tcp://127.0.0.1:${BUS_PORT2}" -topic "${T_BASE}/v2/entities" \
  -retain -file "$WORK/registry-wb.json" || fail "L15: Wallbox-Registry abgelehnt"
l15_wb_da() { curl -sf "${BOX2}/api/state" | grep -q "$WB_ID"; }
waitfor 30 "die Box hat die Wallbox" l15_wb_da

# Der Arbiter bekommt einen Wunsch (= die Wallbox ist wirklich kommandiert) ...
cat >"$WORK/wb-desired.json" <<JSON
{"schema_version":"1.0","entity_id":"${WB_ID}","request_id":"rig-wb-$(date +%s%N)",
 "source":{"kind":"cloud-command"},"priority":"market","override":false,"ttl_s":600,
 "issued_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "command":{"type":"setpoint_kw","value":11}}
JSON
"$WORK/vp-mqtt-pub" -broker "tcp://127.0.0.1:${BUS_PORT2}" \
  -topic "edge/entities/${WB_ID}/desired" -file "$WORK/wb-desired.json" \
  || fail "L15: Wallbox-Wunsch abgelehnt"
# ... und sie MISST 11 kW. Beides zusammen macht sie erst zur Teilnehmerin.
wb_misst() {
  cat >"$WORK/wb-telemetry.json" <<JSON
{"schema_version":"1.0","entity_id":"${WB_ID}","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "channels":{"power_kw":11}}
JSON
  "$WORK/vp-mqtt-pub" -broker "tcp://127.0.0.1:${BUS_PORT2}" \
    -topic "edge/entities/${WB_ID}/telemetry" -file "$WORK/wb-telemetry.json" >/dev/null
}
wb_misst

# Budget 27 kW, eine 22-kW-Saeule allein: sie laedt voll, solange die Wallbox
# nur Gebaeudelast ist.
cfg2 '"grid_limit_kw":30,"charge_points":[{"id":"SAEULE-B1","rank":1},{"id":"SAEULE-B2","rank":2}]'
# ⚠ Erst auf den ZUSTANDSUEBERGANG warten, dann messen: die neue
# Anschlussgrenze erreicht den Verteiler ueber den 20-s-Takt, und eine
# Zusicherung ueber die Aufteilung ist wertlos, solange noch das Budget des
# vorigen Blocks gilt.
budget2() { curl -sf "${BOX2}/api/ocpp" | sed -e 's/.*"ocpp":{//' -e 's/,"settings":{.*//' \
  | sed -n 's/.*"budget_kw":\([0-9.]*\).*/\1/p' | head -1; }
l15c_budget() { nearly "$(budget2)" 27 0.5; }
waitfor 60 "das Budget folgt der neuen Anschlussgrenze" l15c_budget \
  || { echo "    budget=$(budget2)"; exit 1; }
warte_l15 60 "Ausgangslage" l15a
pass "L15c: OHNE Eintrag ist die Wallbox blosse Gebaeudelast - B1=$(b1_kw) B2=$(b2_kw)"

# Jetzt tritt sie dem Rahmen bei - mit Rang 1, also VOR beiden Saeulen.
cfg2 '"grid_limit_kw":30,"charge_points":[{"id":"SAEULE-B1","rank":2},{"id":"SAEULE-B2","rank":3}],
 "wallboxes":[{"entity_id":"'"${WB_ID}"'","label":"Wallbox Garage","rated_kw":11,"rank":1}]'
# 27 kW Budget, die Wallbox nimmt 11 - fuer B1 bleiben 16, fuer B2 nichts
# (unter der Mindestleistung von 5 kW wird pausiert, nie ausgehungert).
l15c() { nearly "$(b1_kw)" 16 1.5 && awk -v d="$(b2_kw)" 'BEGIN{exit (d<1)?0:1}'; }
for _ in 1 2 3 4 5 6 7 8 9 10; do wb_misst; sleep 2; l15c && break; done
l15c || { echo "    B1=$(b1_kw) B2=$(b2_kw)"; fail "L15c: die Wallbox nahm kein Budget weg"; }
pass "L15c: die Wallbox nimmt 11 kW aus dem Budget - B1=$(b1_kw) kW, B2 pausiert"

kill "$NETZ2_PID"; wait "$NETZ2_PID" 2>/dev/null || true; NETZ2_PID=""
kill "$CORE2_PID"; wait "$CORE2_PID" 2>/dev/null || true; CORE2_PID=""
for pid in "${SIM2_PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
SIM2_PIDS=()

# Fuer L4 zaehlt die PHYSISCHE Bahn: der Totmann wird ohne Quellen-Deckel
# geprueft (er ist eine Eigenschaft der Saeule, nicht der Oekonomie).
policy schnell
kill "$NETZ_PID"; wait "$NETZ_PID" 2>/dev/null || true; NETZ_PID=""

# ---------------------------------------------------------------- L4
echo "--- L4: der Totmann - die Box stirbt"
S1_BEFORE=$(drawn $S1_STATUS 1)
awk -v d="$S1_BEFORE" 'BEGIN{exit (d>30)?0:1}' || fail "L4: Ausgangslage - Säule 1 zieht nur $S1_BEFORE kW"
kill "$CORE_PID"; wait "$CORE_PID" 2>/dev/null || true; CORE_PID=""
echo "    (der Kern ist beendet - jetzt darf NICHTS von uns mehr laufen)"

# Das TxProfile trägt eine duration von 120 s. Danach gilt es nicht mehr, und
# die Säule fällt auf ihr gespeichertes Sicherheitsprofil zurück - ohne dass
# irgendein Prozess von uns dabei hilft. Das Sicherheitsprofil ist
# (277 - 180) / 4 Stecker = 24,25 kW.
l4_ready() { nearly "$(drawn $S1_STATUS 1)" 24.25 0.5; }
waitfor 200 "das Ladeprofil läuft ab" l4_ready
S1_AFTER=$(drawn $S1_STATUS 1)
nearly "$S1_AFTER" 24.25 0.5 || fail "L4: Säule 1 zieht $S1_AFTER kW, erwartet das Sicherheitsprofil 24,25 kW"
# Und die WICHTIGSTE Hälfte: sie lädt WEITER. Ein Totmann, der den Ladevorgang
# abwürgt, wäre kein Schutz, sondern ein Ausfall.
awk -v d="$S1_AFTER" 'BEGIN{exit (d>1)?0:1}' || fail "L4: die Säule hat aufgehört zu laden - das Sicherheitsprofil soll begrenzen, nicht abschalten"
pass "L4: die Box ist tot, die Säule begrenzt sich SELBST auf 24,25 kW - und lädt weiter"

echo
echo "== Rig OK: L1 · L2 · L3 · L5 · L6 · L7 · L8 · L9 · L10 · L13 · L11/L12 · L14 · L16 · L15 · L4 =="
