#!/usr/bin/env bash
# Zusatzlauf zu NW-3 — „kurzer Verbraucher" am GEBAUTEN Box-Image
# (Speicher-Korrekturen UE-1/UE-2, Entscheid E2 A vom 10.10.2026; Haltezeit in
# jeder Viertelstunde, Entscheid A vom 13.10.2026).
#
# Was dieser Lauf beweist und was nicht
# -------------------------------------
# NW-3 selbst (nw3.sh) prueft, ob die Box die Nutzlasten der Cloud ERTRAEGT; ueber
# das Regelverhalten des Speichers sagt keiner seiner Punkte etwas. Dieser Lauf
# faehrt dazu den Fall von Herzogau am 10.10.2026: gleichmaessige PV, ein kleiner
# Ueberschuss, und ein Verbraucher, der groesser ist als der Ueberschuss und nur
# 10-15 s laeuft.
#
#   --fall laden (Vorgabe)  Die Viertelstunde plant ein Laden. Regel: das Laden
#       wird sofort zurueckgenommen, ENTLADEN wird erst nach 60 s ununterbrochen
#       gemessenem Defizit (docs/edge-runtime.md „Kurzer Verbraucher – Haltezeit
#       vor dem Entladen"). Gruen heisst: kein Entlade-Befehl und nichts aus dem
#       Speicher eingespeist. Der Ueberschuss kommt in zwei Abschnitten - erst
#       0,76 kW (die Box laedt sichtbar), dann 0,5 kW (so gross wie die Reserve
#       des Folgers: der Sollwert steht auf 0, obwohl ein Laden geplant ist).
#   --fall ruhe             Die Viertelstunde plant nichts. Dieselbe Regel seit
#       dem Entscheid A vom 13.10.2026: ENTLADEN erst nach 60 s gemessenem
#       Defizit. Gruen heisst auch hier: kein Entlade-Befehl und nichts aus dem
#       Speicher eingespeist - ab dem Box-Release NACH edge-2026.10.1. An
#       edge-2026.10.1 und davor deckte die Box in dieser Viertelstunde sofort;
#       diese Staende sind rot (und sind die Gegenprobe).
#
# Ein Lauf allein beweist die Korrektur NICHT - er zeigt nur, dass dieser Stand
# im Fall nicht entlaedt. Die Aussage entsteht erst aus der GEGENPROBE: derselbe
# Lauf gegen den Stand VOR der Korrektur muss rot sein.
#
# Echt sind der Go-Core und die Node-RED-Palette aus den Bildern, die nw3.sh fuer
# das Paar gebaut hat, und ein echter MQTT-Broker. Der Simulator ist das MODELL
# des Tags (edge/sim/sim-model.js) mit einer eigenen Last- und PV-Kurve - siehe
# kurzer-verbraucher-sim.js. Das ist ein Simulatorbeleg an einem Geraet mit
# reiner Totzeit; er ersetzt weder den Prueflauf je Steuerprofil
# (edge-app/nodered/CONTROL-BENCH.md) noch einen Hardware-Pruefstand.
#
# Der Lauf fuehrt KEIN Urteil in das NW-3-Protokoll ein: er schreibt ein eigenes
# Ergebnis (--aus), und die dreizehn Punkte von nw3.sh bleiben, was sie sind.
#
# Hausregeln wie nw3.sh: eigenes Compose-Projekt nw3kv-<pid>, eigenes Netz, kein
# fester Port, am Ende nur Eigenes abraeumen.
#
# Aufruf:  tools/nw3-box-image/kurzer-verbraucher.sh --ref <tag> [--fall laden|ruhe]
#                                                    [--aus <datei>] [--behalten]
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HIER="$REPO/tools/nw3-box-image"
REF=""
FALL="laden"
AUS=""
BEHALTEN=0
ARBEIT="${TMPDIR:-/tmp}/nw3kv-$$"
# Der Folger braucht nach dem Plan Einschwingzeit plus Messtakt, bis sein erster
# gedaempfter Sollwert steht; das Urteilsfenster beginnt erst danach.
VORLAUF="${NW3_KV_VORLAUF_S:-60}"

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)      REF="$2"; shift 2 ;;
    --fall)     FALL="$2"; shift 2 ;;
    --aus)      AUS="$2"; shift 2 ;;
    --behalten) BEHALTEN=1; shift ;;
    -h|--help)  sed -n '2,46p' "$0"; exit 0 ;;
    *) echo "unbekanntes Argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REF" ] || { echo "--ref <tag> fehlt" >&2; exit 2; }

# Der Fall. Die Verbraucher starten bei 43, 103, 193, 313, 388, 493, 553, 643,
# 763, 838 s (Abstaende des Prueflaufs im Tag); das Fenster endet zu einer festen
# Simulatorzeit, damit in jedem Abschnitt gleich viele Verbraucher liegen.
case "$FALL" in
  laden) PLANWERT=1.3; PFLICHTEN="--ueberschuss-pflichten"; ABSCHNITTE="0.76:420,0.5"; BIS=860 ;;
  ruhe)  PLANWERT=0;   PFLICHTEN="";                        ABSCHNITTE="0.76";         BIS=560 ;;
  *) echo "--fall laden|ruhe" >&2; exit 2 ;;
esac
mkdir -p "$ARBEIT/edge-app/test"
[ -n "$AUS" ] || AUS="$ARBEIT/kurzer-verbraucher-$FALL-$REF.json"

TEN=00000000-0000-0000-0000-000000000001
SIT=00000000-0000-0000-0000-000000000002
DEV=00000000-0000-0000-0000-000000000003
BASIS="ems/$TEN/$SIT/$DEV"

PROJEKT=""
SIMBILD="nw3-kv-sim:$$"
COMPOSE=()

aufraeumen() {
  local rc=$?
  if [ "$BEHALTEN" = "1" ]; then
    echo "--- behalten: Projekt $PROJEKT, Arbeitsordner $ARBEIT"
    return $rc
  fi
  echo "--- aufraeumen (nur Eigenes)"
  if [ -n "$PROJEKT" ]; then
    "${COMPOSE[@]}" --profile sim down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  docker image rm -f "$SIMBILD" >/dev/null 2>&1 || true
  return $rc
}
trap aufraeumen EXIT

# --- Die Bilder des Paars: gebaut hat sie nw3.sh, hier wird nichts neu gebaut --
for bild in "nw3-edge-core:$REF" "nw3-edge-nodered:$REF" "nw3-edge-sim:$REF" "nw3-broker:$REF"; do
  docker image inspect "$bild" >/dev/null 2>&1 || {
    echo "Bild $bild fehlt. Erst tools/nw3-box-image/nw3.sh fuer das Paar $REF fahren -" >&2
    echo "es baut die vier Bilder aus dem Tag; dieser Lauf baut den Stand nicht selbst." >&2
    exit 2
  }
done
SHA="$(git -C "$REPO" rev-parse "$REF^{commit}")"
KERN_STEMPEL="$(docker run --rm --entrypoint /bin/sh "nw3-edge-core:$REF" -c \
  "strings /usr/local/bin/vp-edge-core | grep -o '$REF-[0-9a-f]\{12\}' | head -1")"

# Die Compose-Dateien DES TAGS, ohne eigenen Arbeitsbaum: nur die zwei Dateien.
git -C "$REPO" show "$REF:edge-app/docker-compose.yml" > "$ARBEIT/edge-app/docker-compose.yml"
git -C "$REPO" show "$REF:edge-app/test/docker-compose.e2e.yml" \
  > "$ARBEIT/edge-app/test/docker-compose.e2e.yml"

# Der Szenario-Simulator: das Simulator-Bild des Tags plus EINE Datei. Totzeit
# und Messtakt sind Variablen des Modells (sim-model.js optionsFromEnv): das
# Geraet folgt einem Sollwert nach 12 s (Herzogau: „~12 s later") und meldet
# alle 5 s - innerhalb dessen, was die Box fuer ein Geraet ohne Profil annimmt
# (guards.DefaultDampProfile: Einschwingzeit 15 s, Messtakt hoechstens 25 s).
echo "==> Szenario-Simulator aus nw3-edge-sim:$REF (Fall $FALL, Ueberschuss $ABSCHNITTE)"
docker build -q -t "$SIMBILD" -f - "$HIER" >/dev/null <<EOF
FROM nw3-edge-sim:$REF
ENV SIM_SOC_START=37 SIM_FOLLOW_DELAY_S=12 SIM_MEASURE_INTERVAL_S=5 SZ_ABSCHNITTE=$ABSCHNITTE
COPY kurzer-verbraucher-sim.js ./
CMD ["node", "kurzer-verbraucher-sim.js"]
EOF

PROJEKT="nw3kv-$$"
COMPOSE=(docker compose -p "$PROJEKT"
  -f "$ARBEIT/edge-app/docker-compose.yml"
  -f "$ARBEIT/edge-app/test/docker-compose.e2e.yml"
  -f "$HIER/nw3-overlay.yml")
echo "==> Stack $PROJEKT hoch (eigenes Netz, Ports 0 = Docker waehlt)"
VP_EDGE_CORE_IMAGE="nw3-edge-core:$REF" \
VP_EDGE_NODERED_IMAGE="nw3-edge-nodered:$REF" \
NW3_SIM_IMAGE="$SIMBILD" \
NW3_BROKER_IMAGE="nw3-broker:$REF" \
VP_WEB_PORT=0 VP_NODERED_PORT=0 VP_BUS_PORT=0 VP_MIRROR_PORT=0 VP_OCPP_PORT=0 \
VP_NODERED_PASSWORD=nw3-pruefstand \
  "${COMPOSE[@]}" --profile sim up -d >/dev/null
BROKER="$("${COMPOSE[@]}" ps -q cloud-broker)"
KERN="$("${COMPOSE[@]}" ps -q core)"
SIM="$("${COMPOSE[@]}" --profile sim ps -q edge-sim)"
NETZ="${PROJEKT}_default"

docker exec "$BROKER" sh -c ": > /tmp/mitschnitt.txt"
docker exec -d "$BROKER" sh -c \
  "mosquitto_sub -h 127.0.0.1 -q 1 -v -t 'ems/#' >> /tmp/mitschnitt.txt 2>&1"
letzte() { # <leaf>
  docker exec "$BROKER" cat /tmp/mitschnitt.txt \
    | awk -v t="$BASIS/$1" '$1==t {sub(/^[^ ]+ /,""); l=$0} END{print l}'
}
simzeit() { # Sekunden seit Simulatorstart, aus seiner juengsten Sekundenzeile
  docker logs --tail 40 "$SIM" 2>&1 | sed -n 's/^\[szenario\] t=\([0-9.]*\) .*/\1/p' | tail -1
}
# Ein Feld aus control des juengsten Herzschlags; leer, wenn es fehlt.
herzschlag() { # <pyausdruck ueber c>
  letzte status | python3 -c '
import json,sys
try:
    c=(json.load(sys.stdin).get("control") or {})
    print(eval(sys.argv[1]) or "")
except Exception:
    print("")' "$1" 2>/dev/null
}

echo "    warte auf den ersten Herzschlag der Box"
STAND=""
for _ in $(seq 1 90); do
  STAND="$(letzte status | python3 -c '
import json,sys
try: print(json.load(sys.stdin).get("version") or "")
except Exception: print("")' 2>/dev/null)"
  [ -n "$STAND" ] && break
  sleep 1
done
[ -n "$STAND" ] || { echo "Box meldete keinen Herzschlag"; docker logs --tail 40 "$KERN"; exit 1; }
echo "    Box meldet Stand: $STAND (Stempel im Binary: $KERN_STEMPEL)"

# Dieselbe Geraetewahl wie nw3.sh (wechselrichter_waehlen): ohne gewaehltes
# Geraet ist der gedaempfte Folger aus und die Box schreibt nichts.
echo "    waehle den Wechselrichter an der Box (lokale Weboberflaeche, wie der Installateur)"
WAHL="$(docker run --rm --network "$NETZ" "nw3-broker:$REF" wget -q -O - \
    --header 'Content-Type: application/json' \
    --post-data '{"brand":"generic_modbus","family":"sunspec","connection":{"ip":"edge-sim"}}' \
    "http://core:8484/api/inverter" 2>&1 || true)"
printf '%s' "$WAHL" | python3 -c '
import json,sys
print("    gewaehlt:", json.load(sys.stdin)["selection"]["communication"])' 2>/dev/null \
  || { echo "die Box hat keine Wechselrichter-Wahl angenommen: $WAHL"; exit 1; }

echo "==> Fahrplan 1.0 zustellen (Planwert $PLANWERT kW${PFLICHTEN:+, beide Ueberschuss-Pflichten})"
# shellcheck disable=SC2086
python3 "$HIER/nutzlast.py" fahrplan \
  --vorlage "$REPO/docs/contracts/examples/mqtt-schedule.valid.surplus-only-charge.json" \
  --planwert-kw "$PLANWERT" $PFLICHTEN --aus "$ARBEIT/fahrplan.json"
SLOTS="$(python3 -c 'import json,sys; print(" ".join(s["start"] for s in json.load(open(sys.argv[1]))["slots"]))' "$ARBEIT/fahrplan.json")"
docker exec -i "$BROKER" sh -c 'cat > /tmp/nutzlast.json' < "$ARBEIT/fahrplan.json"
docker exec "$BROKER" mosquitto_pub -h 127.0.0.1 -q 1 -r -t "$BASIS/schedule" -f /tmp/nutzlast.json

# Das Fenster beginnt erst, wenn die Box DIESEN Fahrplan ausfuehrt: ihr Herzschlag
# nennt dann den Slot des Plans und nicht mehr den Rueckfall ohne Plan. (Ein
# Lade-Sollwert allein beweist das nicht - auch der Rueckfall laedt den Ueberschuss.)
echo "    warte, bis der Herzschlag einen Slot des Fahrplans nennt (${SLOTS%% *} ...)"
T_PLAN=""
for _ in $(seq 1 120); do
  GENANNT="$(herzschlag 'c.get("slot_start")')"
  case " $SLOTS " in
    *" ${GENANNT:-keiner} "*)
      if [ "$(herzschlag '(c.get("execution") or {}).get("mode")')" != "fallback" ]; then
        T_PLAN="$(simzeit)"
        [ -n "$T_PLAN" ] && break
      fi ;;
  esac
  sleep 1
done
[ -n "$T_PLAN" ] || {
  echo "die Box fuehrt den zugestellten Fahrplan nicht aus"
  letzte status; docker logs --tail 30 "$SIM"; exit 1; }
# Simulatorzeit -> Wanduhr, damit die Herzschlaege dem Fenster zugeordnet werden koennen.
T0_EPOCHE="$(python3 -c 'import sys,time; print(time.time() - float(sys.argv[1]))' "$T_PLAN")"
VON="$(python3 -c 'import sys; print(round(float(sys.argv[1]) + float(sys.argv[2])))' "$T_PLAN" "$VORLAUF")"
echo "    Fahrplan in Ausfuehrung bei t=$T_PLAN s; Urteilsfenster t=$VON..$BIS s"

while :; do
  JETZT="$(simzeit)"
  python3 -c 'import sys; sys.exit(0 if float(sys.argv[1] or 0) >= float(sys.argv[2]) + 2 else 1)' \
    "$JETZT" "$BIS" && break
  sleep 10
done

docker logs "$SIM" > "$ARBEIT/simulator.log" 2>&1
letzte status > "$ARBEIT/status.json"
docker exec "$BROKER" cat /tmp/mitschnitt.txt > "$ARBEIT/mitschnitt.txt"
python3 "$HIER/kurzer_verbraucher_pruefen.py" --protokoll "$ARBEIT/simulator.log" \
  --von "$VON" --bis "$BIS" --fall "$FALL" > "$ARBEIT/urteil.json"

python3 - "$ARBEIT/urteil.json" "$ARBEIT/mitschnitt.txt" "$ARBEIT/fahrplan.json" "$AUS" \
  "$REF" "$SHA" "$KERN_STEMPEL" "$STAND" "$(git -C "$REPO" rev-parse HEAD)" \
  "$FALL" "$ABSCHNITTE" "$BASIS/status" "$T0_EPOCHE" "$VON" "$BIS" <<'PY'
import datetime, json, sys
(urteil, mitschnitt, plan, aus, ref, sha, kern, stand, repo,
 fall, abschnitte, thema, t0, von, bis) = sys.argv[1:16]
t0, von, bis = float(t0), float(von), float(bis)
u = json.load(open(urteil, encoding="utf-8"))

# Was die Box im Fenster ueber sich selbst sagte: control.execution.mode je
# Herzschlag (alle 15 s). `deficit_cover` heisst: die Defizitdeckung hat gegriffen.
modi, letzter = {}, {}
for z in open(mitschnitt, encoding="utf-8", errors="replace"):
    if not z.startswith(thema + " "):
        continue
    try:
        d = json.loads(z.split(" ", 1)[1])
        ts = datetime.datetime.fromisoformat(d["ts"][:19] + "+00:00").timestamp()
    except Exception:
        continue
    if von <= ts - t0 < bis:
        c = d.get("control") or {}
        modus = (c.get("execution") or {}).get("mode") or "ohne"
        modi[modus] = modi.get(modus, 0) + 1
        letzter = {k: d.get(k) for k in ("version", "battery_control", "control") if k in d}

d = {
    "nachweis": "Zusatzlauf zu NW-3 — kurzer Verbraucher am gebauten Box-Image",
    "gefahren_am": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "repo_stand_des_pruefstands": repo,
    "paar": {"ref": ref, "tag_commit": sha, "core_binary_stempel": kern,
             "stand_den_die_box_selbst_meldet": stand,
             "herkunft": "die von nw3.sh aus dem Tag gebauten Bilder, NICHT das Release-Artefakt"},
    "fall": {
        "name": fall,
        "quelle": "edge-app/core/internal/agent/surplus_short_consumer_scenario_test.go "
                  "(herzogauBenchScenario)",
        "pv_kw": 5.0, "ueberschuss_kw_bis_sekunde": abschnitte, "verbraucher_kw": 2.62,
        "verbraucher_dauern_s": [15, 10, 12], "verbraucher_abstaende_s": [60, 90, 120, 75, 105],
        "geraet": "Modell des Tags (edge/sim/sim-model.js): folgt einem Sollwert nach 12 s "
                  "(reine Totzeit), meldet alle 5 s, Ladezustand 37 %",
        "fahrplan": json.load(open(plan, encoding="utf-8")),
    },
    "ergebnis": u,
    "herzschlag_modi_im_fenster": modi,
    "letzter_herzschlag_im_fenster": letzter,
    "grenzen": [
        "Simulatorbeleg, kein Hardware-Pruefstand und kein Prueflauf je Steuerprofil",
        "ein Fall (zwei Ueberschuesse, eine Verbrauchergroesse), ein Geraet mit reiner Totzeit",
        "geprueft ist der Weg, auf dem die Box gedaempft selbst regelt; ems_freigabe_entzogen "
        "im Ergebnis zaehlt, wie oft sie im Fenster an das Geraet uebergeben hat",
        "ein Lauf allein beweist die Korrektur nicht - erst die Gegenprobe gegen den Stand davor",
    ],
}
json.dump(d, open(aus, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print()
print(f"=== Ergebnis: {aus}")
print(f"[{u['urteil']}] Fall {fall} an {stand} — {u['satz']}")
print(f"    Herzschlag-Modi im Fenster: {modi}")
PY
