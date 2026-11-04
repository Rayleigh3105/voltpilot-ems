#!/bin/sh
# Trockenlauf des Labor-Pakets (laborbau.sh) gegen ein ECHTES OpenWrt 25.12.5 im
# Container (procd, uci, uhttpd), mit den ECHTEN amd64-Programmen und der
# eingebackenen Labor-Wurzel - bevor das Paket an die Labor-Mango geht.
# Ohne Mango, ohne Netz, ohne Portal: Die Zuweisung legt die Probe dort ab, wo
# das Programm sie aus dem Broker ablegen wuerde, und die Programme liefert
# uhttpd unter dem Pfad der offenen Portal-Route aus.
#
#   1. install.sh richtet die Ausgangsfassung ein: Labor-Vertrauens-Set,
#      Stand aus dem Manifest; /health meldet das Set gegen die Labor-Wurzel
#      geprueft und current_seq
#   2. Zuweisung der guten Fassung: das Programm laedt, prueft, beendet sich;
#      der Loader tauscht und startet zur Probe; ohne Cloud bleibt das Urteil
#      offen, nach der Frist nimmt der Loader zurueck ("keine Cloud-Verbindung
#      in der Probezeit"), die Ausgangsfassung laeuft wieder und meldet
#      zurueckgenommen (wie P4 an der Mango)
#   3. Zuweisung der mit rel-fremd signierten Fassung: abgelehnt, nichts
#      geladen (P10b)
#
#   edge-light/labor/labor-probe.sh [<ausgabe von laborbau.sh amd64>]
#   (ohne Argument baut die Probe das Paket selbst in ein temporaeres Verzeichnis)
# shellcheck disable=SC2015,SC2016 # ok/falsch-Zeilen; Ausdruecke werten im Container aus
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HIER/../.." && pwd -P)"
BILD="${VPLP_BILD:-openwrt/rootfs:x86-64-25.12.5}"
C="vplp-$$"
ARBEIT="$(mktemp -d)"
OK=0
FEHLER=0
aufraeumen() { docker rm -f "$C" >/dev/null 2>&1 || true; rm -rf "$ARBEIT"; }
trap aufraeumen EXIT INT TERM
ok() { OK=$((OK + 1)); echo "  ok      $*"; }
falsch() { FEHLER=$((FEHLER + 1)); echo "  FEHLER  $*"; }
schritt() { echo; echo "== $*"; }
x() { docker exec "$C" sh -c "$*"; }
zeige() { x 'logread -e vp-edge-light | tail -n 25 | sed "s/^/    | /"; echo "    --- versuche"; sed "s/^/    | /" /etc/vp-edge-light/ota/versuche 2>/dev/null' || true; }
warte() { # warte <beschreibung> <bedingung> [sekunden]
  i=0
  while ! x "$2" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt "${3:-60}" ]; then falsch "$1 (Zeitueberschreitung)"; zeige; return 0; fi
    sleep 1
  done
  ok "$1"
}
health() { x 'wget -q -O - http://127.0.0.1:8484/health' 2>/dev/null || true; }

PAKET="${1:-}"
if [ -z "$PAKET" ]; then
  PAKET="$ARBEIT/paket"
  bash "$HIER/laborbau.sh" "$PAKET" 500 amd64 >/dev/null
fi
[ -f "$PAKET/fassungen/ausgang/vp-edge-light-linux-amd64" ] || { echo "FEHLER: $PAKET ist kein amd64-Labor-Paket" >&2; exit 2; }
SEQ_AUSGANG="$(sed -n 's/^  "release_seq": \([0-9]*\),$/\1/p' "$PAKET/fassungen/ausgang/release.json")"
SEQ_GUT="$(sed -n 's/^  "release_seq": \([0-9]*\),$/\1/p' "$PAKET/fassungen/gut/release.json")"

# Der Skriptstand wie im Release, das Programm der Ausgangsfassung daneben.
mkdir -p "$ARBEIT/stand/dist"
cp -R "$REPO/edge-light/openwrt" "$ARBEIT/stand/"
cp "$PAKET/fassungen/ausgang/vp-edge-light-linux-amd64" "$ARBEIT/stand/dist/"
# ssh-Ersatz: ssh [-i <datei>] <ziel> <befehl> -> docker exec
mkdir -p "$ARBEIT/bin"
cat >"$ARBEIT/bin/ssh" <<EOF
#!/bin/sh
if [ "\$1" = -i ]; then shift 2; fi
shift
exec docker exec -i "$C" sh -c "\$1"
EOF
chmod +x "$ARBEIT/bin/ssh"

schritt "Aufbau: OpenWrt mit procd, ohne Netz; uhttpd als offene Portal-Route"
docker run -d --name "$C" --network none "$BILD" /sbin/init >/dev/null
i=0
until x 'ubus list service' >/dev/null 2>&1 || [ "$i" -ge 30 ]; do i=$((i + 1)); sleep 1; done
for f in gut fremd; do
  gz="$(sha256sum "$PAKET/fassungen/$f/vp-edge-light-linux-amd64.gz" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$PAKET/fassungen/$f/vp-edge-light-linux-amd64.gz" | cut -d' ' -f1)"
  x "mkdir -p /srv/api/v1/edge/light-programm"
  docker cp "$PAKET/fassungen/$f/vp-edge-light-linux-amd64.gz" "$C:/srv/api/v1/edge/light-programm/$gz" >/dev/null
done
docker exec -d "$C" uhttpd -p 127.0.0.1:8099 -h /srv -f
x 'touch /srv/abrufe'

schritt "1. Einrichten mit install.sh: Ausgangsfassung, Labor-Vertrauens-Set, Stand"
if PATH="$ARBEIT/bin:$PATH" VP_LIGHT_ARCH=amd64 VP_TRUST_SET_DIR="$PAKET/trust-set" \
  VP_LIGHT_MANIFEST="$PAKET/fassungen/ausgang/release.json" sh "$ARBEIT/stand/openwrt/install.sh" root@box >"$ARBEIT/install.out" 2>&1; then
  ok "install.sh laeuft durch"
else
  falsch "install.sh"; sed 's/^/    | /' "$ARBEIT/install.out"
fi
x "uci set vp-edge-light.main.portal_url=http://127.0.0.1:8099 && uci set vp-edge-light.main.probe_frist=60 && uci commit vp-edge-light && /etc/init.d/vp-edge-light restart" >/dev/null 2>&1 || true
warte "die Ausgangsfassung laeuft" 'wget -q -O - http://127.0.0.1:8484/health | grep -q edge-light-2099.01.0' 90
health >"$ARBEIT/h1"
python3 - "$ARBEIT/h1" "$SEQ_AUSGANG" <<'PY' && ok "/health: Labor-Vertrauens-Set gegen die Labor-Wurzel geprueft (rel-labor), current_seq $SEQ_AUSGANG" || { falsch "/health nach dem Einrichten"; cat "$ARBEIT/h1"; }
import json, sys
u = json.load(open(sys.argv[1]))["ota_update"]
assert u["backend"] == "light", u
assert u["trust"]["root_key_ids"] == ["root-labor"], u
assert u["trust"]["trust_set_key_ids"] == ["rel-labor"] and not u["trust"].get("trust_set_error"), u
assert u.get("current_seq") == int(sys.argv[2]), u
PY

# zuweisen <fassung> - die Zuweisung so ablegen, wie das Programm sie aus dem
# Broker ablegt (RAM); das Programm prueft sie im naechsten Takt (30 s).
zuweisen() {
  python3 - "$PAKET/fassungen/$1/release.json" "$2" >"$ARBEIT/target.json" <<'PY'
import base64, json, sys
m = open(sys.argv[1], "rb").read()
s = open(sys.argv[1] + ".sig", "rb").read()
d = json.loads(m)
print(json.dumps({"schema_version": "1.0", "type": "update_target",
  "tenant_id": "00000000-0000-0000-0000-000000000001", "site_id": "00000000-0000-0000-0000-000000000002",
  "device_id": "00000000-0000-0000-0000-000000000003", "release": d["release"], "release_seq": d["release_seq"],
  "assigned_at": sys.argv[2], "manifest_b64": base64.b64encode(m).decode(), "signature_b64": base64.b64encode(s).decode()}))
PY
  docker cp "$ARBEIT/target.json" "$C:/tmp/vp-edge-light/ota/target.json" >/dev/null
}

schritt "2. Zuweisung der guten Fassung ohne Cloud (wie P4)"
zuweisen gut 2026-11-04T16:00:00Z
warte "das Programm laedt, prueft und legt den Kandidaten ab; der Loader tauscht (Marke start)" "grep -qx 'start $SEQ_GUT 2026-11-04T16:00:00Z' /etc/vp-edge-light/ota/versuche" 120
warte "die neue Fassung laeuft zur Probe" 'wget -q -O - http://127.0.0.1:8484/health | grep -q edge-light-2099.01.1' 60
warte "ihr Urteil: offen, keine Cloud" "grep -q 'keine Cloud-Verbindung in der Probezeit' /tmp/vp-edge-light/ota/probe-urteil.json" 90
warte "nach der Frist: zurueck mit Grund" "grep -q '^zurueck $SEQ_GUT 2026-11-04T16:00:00Z keine Cloud-Verbindung in der Probezeit' /etc/vp-edge-light/ota/versuche" 120
warte "die Ausgangsfassung laeuft wieder" 'wget -q -O - http://127.0.0.1:8484/health | grep -q edge-light-2099.01.0' 60
warte "sie meldet zurueckgenommen und versucht es nicht erneut" 'wget -q -O - http://127.0.0.1:8484/health | grep -q "\"ota_state\":\"rolled_back\""' 60
x "grep -q 'edge-light-2099.01.1' /usr/share/vp-edge-light/vp-edge-light-linux-amd64.sha256" && falsch "der Flash traegt die nicht bestaetigte Fassung" ||
  ok "im Flash liegt weiter die Ausgangsfassung"
x "gunzip -c /usr/share/vp-edge-light/vp-edge-light-linux-amd64.gz | sha256sum | cut -d' ' -f1 | grep -qx \"\$(sed -n 1p /usr/share/vp-edge-light/vp-edge-light-linux-amd64.sha256 | cut -d' ' -f1)\"" &&
  ok "Kopie im Flash passt zur Pruefsumme" || falsch "Kopie im Flash"

schritt "3. Zuweisung einer fremd signierten Fassung (P10b)"
zuweisen fremd 2026-11-04T16:30:00Z
warte "abgelehnt: fehlgeschlagen, Signatur nicht im Vertrauens-Set" 'wget -q -O - http://127.0.0.1:8484/health | grep -q "\"ota_state\":\"failed\""' 60
sleep 5
x '[ ! -f /tmp/vp-edge-light/ota/kandidat.gz ] && ! grep -q "^start" /etc/vp-edge-light/ota/versuche.neu 2>/dev/null' && ok "nichts geladen, nichts getauscht" || falsch "nach der Ablehnung"
x "[ \"\$(grep -c '^start' /etc/vp-edge-light/ota/versuche)\" = 1 ]" && ok "keine weitere Probe" || falsch "weitere Probe"

echo
echo "$OK bestanden, $FEHLER fehlgeschlagen"
[ "$FEHLER" = 0 ]
