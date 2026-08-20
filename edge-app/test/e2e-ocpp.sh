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
#   L9  (Stufe 4) „Jetzt voll laden" nimmt GENAU EINEN Ladevorgang aus der
#       Quellen-Bahn - und der Anschluss hält trotzdem
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

BOX="http://127.0.0.1:${WEB_PORT}"

cleanup() {
  echo "--- cleanup"
  for pid in "${SIM_PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  [ -n "$NETZ_PID" ] && kill "$NETZ_PID" 2>/dev/null || true
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

echo "=== OCPP-Lastmanagement-Rig ==="
echo "--- bauen"
( cd core && go build -o "$WORK/vp-edge-core" ./cmd/vp-edge-core )
( cd core && go build -o "$WORK/vp-ocpp-sim" ./cmd/vp-ocpp-sim )
( cd core && go build -o "$WORK/vp-netz-sim" ./cmd/vp-netz-sim )

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
  --connectors 2 --status "$S2_STATUS" >"$WORK/s2.log" 2>&1 &
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
echo "--- L9: (Stufe 4) „Jetzt voll laden\" nimmt GENAU EINEN Ladevorgang heraus"
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
echo "== Rig OK: L1 · L2 · L3 · L5 · L6 · L7 · L8 · L9 · L4 =="
