#!/bin/sh
# Probe fuer den Wartungstunnel des WAGO PFC200: edge-industrie/wartung.sh, das
# Dienst-Skript und das ECHTE Tunnel-Programm vp-wartung (ARMv7) gegen ein
# BusyBox-Linux fuer ARMv7 im Container - ohne PFC200, ohne Wartungsserver und
# ohne Root auf dem Rechner.
#
# Zwei Container an einem eigenen Docker-Netz:
#   das "Geraet"     busybox:1.34.1-glibc fuer linux/arm/v7 mit BusyBox-Init
#                    als PID 1 (rcS startet die Links in /etc/rc.d), /tmp im
#                    RAM, Host-Schluessel im Dropbear-Format unter
#                    /etc/dropbear, eine Web-App-Attrappe auf 127.0.0.1:8484
#   die Gegenstelle  vp-wartung-gegenstelle (edge-industrie/wartung): ein
#                    Wartungsserver im Kleinen mit echtem WireGuard,
#                    Schluesselausgabe nach fernwartung-schluessel-v1 und
#                    Anmeldung als Techniker
# Das Geraet erreicht den Server unter dessen NAMEN im Docker-Netz, wie eine
# Box wartung.voltpilot.de aufloest.
#
# Was die Probe NICHT belegt (nur am Geraet, edge-industrie/README.md): den
# echten Kernel und die SPS-Laufzeit daneben, den Dropbear und die Firewall
# der WAGO-Firmware, Speicher und Rechenzeit, den echten Wartungsserver
# (vp-tunnel-dienst) mit seiner Firewall.
#
#   1. verweigert, bevor etwas auf das Geraet geht,
#   2. fehlt dem Geraet ein Werkzeug, endet das Skript, ohne etwas zu aendern,
#   3. key: Programm, Schluessel der Box (nur root, bleibt auf dem Geraet),
#   4. Tunnel einrichten: Dienst laeuft als root, Handshake, Server antwortet,
#   5. Bauart: 2222 und 8484 lauschen auf keiner Netzbuchse, nur im Tunnel,
#   6. Anmeldung: ohne Fenster abgewiesen; dauerhafter Schluessel; der Server
#      zeigt die Host-Schluessel des Geraets; Terminal; SIGHUP nicht ignoriert,
#   7. Fenster-Schluessel: Anmeldung im Fenster, Ende der Sitzung mit dem
#      Schluessel, Ereignisliste ohne Schluessel,
#   8. die Frist fuehrt die Box selbst (Server gibt keine Liste mehr aus),
#   9. Web-App der Box im Tunnel,
#  10. endet das Programm, startet der Dienst es nach 10 s neu, bei sofortigem
#      Ende mit wachsender Pause; stop, status,
#  11. nach einem Neustart des Geraets startet der Dienst von selbst; kein
#      Fenster-Schluessel ueberlebt,
#  12. ein zweiter Aufruf mit denselben Werten fasst den Tunnel nicht an; mit
#      anderen Werten startet er neu; Werte, mit denen das Programm nicht
#      startete, werden nicht abgelegt,
#  13. wartung.sh DURCH den Tunnel (wie ein Fernlauf): unveraendert bleibt die
#      Sitzung; abbauen verweigert,
#  14. abbauen: nichts bleibt; Dropbear, Schluesseldatei von root und der Rest
#      von /etc sind unveraendert.
#
#   edge-industrie/scripts/build-wartung.sh
#   edge-industrie/test/wartung-probe.sh
#   VPPW_BEHALTEN=1 edge-industrie/test/wartung-probe.sh   # Container zum Nachsehen stehen lassen
# shellcheck disable=SC2015,SC2016 # ok/falsch-Zeilen; die Pruefausdruecke werten im Container aus
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
SKRIPT="$HIER/../wartung.sh"
BIN="$HIER/../dist/vp-wartung-linux-arm"
SCHLUESSEL="$HIER/../wartung/internal/hostkey/testdata"
BILD="${VPPW_BILD:-busybox:1.34.1-glibc}"
PLATTFORM=linux/arm/v7
C="vppw-$$"
G="vppw-$$-server"
NETZ="vppw-$$"
ARBEIT="$(mktemp -d)"
ADRESSE=10.10.16.7
OK=0
FEHLER=0

aufraeumen() {
  if [ -n "${VPPW_BEHALTEN:-}" ]; then
    # Zum Nachsehen: die Container bleiben stehen (von Hand entfernen).
    echo "--- behalten: Geraet $C, Gegenstelle $G, Netz $NETZ, Arbeit $ARBEIT"
    return 0
  fi
  docker rm -f "$C" "$G" >/dev/null 2>&1 || true
  docker network rm "$NETZ" >/dev/null 2>&1 || true
  rm -rf "$ARBEIT"
}
trap aufraeumen EXIT INT TERM

ok() { OK=$((OK + 1)); echo "  ok      $*"; }
falsch() { FEHLER=$((FEHLER + 1)); echo "  FEHLER  $*"; }
schritt() { echo; echo "== $*"; }
x() { docker exec "$C" sh -c "$*"; }
pruefe() { # pruefe <beschreibung> <befehl im geraet...>
  b="$1"; shift
  if docker exec "$C" sh -c "$*" >/dev/null 2>&1; then ok "$b"; else falsch "$b"; fi
}
# g <pfad?angaben> - die Steuerung der Gegenstelle fragen
g() { docker exec "$G" /gegenstelle frage "$1"; }
# g_ssh <schluessel> <befehl> - als Techniker durch den Tunnel
g_ssh() { docker exec -i "$G" /gegenstelle ssh "$1" "$2"; }
# bis <sekunden> <befehl...> - wartet, bis der Befehl gelingt
bis() {
  n="$1"; shift
  i=0
  until "$@" >/dev/null 2>&1; do
    [ "$i" -lt "$n" ] || return 1
    i=$((i + 1))
    sleep 1
  done
}
wert() { x "/home/voltpilot/wartung/vp-wartung status werte 2>/dev/null" | sed -n "s/^$1=//p"; }
hat_antwort() { case "$(wert antwort_vor)" in '' | -1) return 1 ;; esac; }
protokoll() { x 'cat /var/log/messages 2>/dev/null' | grep 'vp-wartung' || true; }
# diagnose - was ein gescheiterter Schritt am Tunnel zum Nachsehen braucht: der
# Stand beider Seiten, die Uhren (WireGuard verwirft einen Handshake mit
# aelterem Zeitstempel), die Einstellungen ohne Schluessel, das Protokoll.
diagnose() {
  {
    echo "--- Diagnose"
    x '/home/voltpilot/wartung/vp-wartung status werte; /etc/init.d/vp-wartung status; echo "Uhr Geraet: $(date)"; ps | grep "wartun[g]"; sed "s/^server_pubkey.*/server_pubkey = (ausgelassen)/" /home/voltpilot/wartung/konfig' || true
    echo "Gegenstelle: Handshake $(g handshake || true), Uhr $(docker exec "$G" date || true)"
    protokoll | tail -n 15
  } 2>&1 | sed 's/^/    | /'
}
zeige() { sed 's/^/    | /' "$1"; }

[ -f "$BIN" ] || { echo "FEHLER: erst edge-industrie/scripts/build-wartung.sh" >&2; exit 1; }
command -v ssh-keygen >/dev/null 2>&1 || { echo "FEHLER: ssh-keygen fehlt (Schluessel der Techniker)" >&2; exit 1; }

# Die Gegenstelle fuer dieselbe Plattform wie das Geraet.
echo "--- baue die Gegenstelle (linux/arm)"
(cd "$HIER/../wartung" && GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 go build -trimpath -o "$ARBEIT/gegenstelle" ./cmd/vp-wartung-gegenstelle)
# SSH-Schluessel der Techniker und der Notfall-Schluessel: auf dem Rechner
# erzeugt (schnell), der private Teil geht nur an die Gegenstelle.
mkdir -p "$ARBEIT/ssh"
for n in notfall anna bert; do
  ssh-keygen -q -t rsa -b 2048 -N '' -C '' -m PEM -f "$ARBEIT/ssh/$n"
done

# ssh-Ersatz: ssh [-i <datei>] root@<container> <befehl>  ->  docker exec.
# Mit VPPW_WEG=tunnel geht derselbe Aufruf als Techniker durch den Tunnel.
mkdir -p "$ARBEIT/bin"
cat > "$ARBEIT/bin/ssh" <<EOF
#!/bin/sh
if [ "\$1" = -i ]; then shift 2; fi
ziel="\${1#*@}"
shift
if [ "\${VPPW_WEG:-}" = tunnel ]; then
  exec docker exec -i "$G" /gegenstelle ssh notfall "\$1"
fi
exec docker exec -i "\$ziel" sh -c "\$1"
EOF
chmod +x "$ARBEIT/bin/ssh"
PATH="$ARBEIT/bin:$PATH"
export PATH

# Das "Geraet": BusyBox-Init als PID 1, rcS startet syslogd, die Attrappe der
# Web-App und die Links in /etc/rc.d.
mkdir -p "$ARBEIT/etc/init.d" "$ARBEIT/etc/rc.d" "$ARBEIT/etc/dropbear" "$ARBEIT/www"
printf '::sysinit:/etc/init.d/rcS\n' >"$ARBEIT/etc/inittab"
cat >"$ARBEIT/etc/init.d/rcS" <<'EOF'
#!/bin/sh
mkdir -p /var/log /var/run
syslogd -O /var/log/messages
httpd -p 127.0.0.1:8484 -h /www
for s in /etc/rc.d/S*; do
  [ -x "$s" ] && "$s" start
done
EOF
chmod 0755 "$ARBEIT/etc/init.d/rcS"
cp "$SCHLUESSEL/dropbear_ecdsa_host_key" "$SCHLUESSEL/dropbear_rsa_host_key" "$ARBEIT/etc/dropbear/"
chmod 0400 "$ARBEIT/etc/dropbear/"*
printf '{"status":"UP","ref":"edge-probe"}\n' >"$ARBEIT/www/health"

docker network create "$NETZ" >/dev/null
docker create --name "$G" --platform "$PLATTFORM" --network "$NETZ" "$BILD" /gegenstelle -port 51820 -schluessel-ordner /ssh >/dev/null
docker cp "$ARBEIT/gegenstelle" "$G:/gegenstelle" >/dev/null
docker cp "$ARBEIT/ssh" "$G:/ssh" >/dev/null
docker start "$G" >/dev/null
docker create --name "$C" --platform "$PLATTFORM" --network "$NETZ" --tmpfs "/tmp:rw,exec,size=64m" "$BILD" /bin/init >/dev/null
docker cp "$ARBEIT/etc/." "$C:/etc/" >/dev/null
docker cp "$ARBEIT/www" "$C:/www" >/dev/null
docker start "$C" >/dev/null
bis 30 docker exec "$C" sh -c '[ -S /dev/log ]' || true
x 'mkdir -p /root/.ssh && chmod 700 /root/.ssh && chown -R root:root /etc/dropbear /www'

schritt "Aufbau: BusyBox-Linux fuer ARMv7 mit BusyBox-Init, Gegenstelle im selben Docker-Netz"
pruefe "BusyBox-Init ist PID 1, syslogd laeuft" 'tr "\000" " " </proc/1/cmdline | grep -q init && [ -S /dev/log ]'
pruefe "ARMv7 ($(x 'uname -m'))" '[ "$(uname -m)" = armv7l ]'
pruefe "die Attrappe der Web-App antwortet nur auf dem Geraet selbst" 'wget -q -O - http://127.0.0.1:8484/health | grep -q edge-probe'
if bis 60 g pub; then ok "die Gegenstelle laeuft"; else falsch "die Gegenstelle laeuft"; docker logs "$G" 2>&1 | tail -n 20; fi
SERVER_PUB="$(g pub)"
NOTFALL_PUB="$(g 'schluessel?name=notfall')"
g 'schluessel?name=anna' >/dev/null
g 'schluessel?name=bert' >/dev/null
# Was die Probe am Ende unveraendert vorfinden muss.
x 'find /etc -type f | sort | xargs sha256sum' >"$ARBEIT/etc.vorher"

schritt "1. Verweigert, bevor etwas auf das Geraet geht"
: > "$ARBEIT/schluesseldatei"
verweigert() { # verweigert <beschreibung> <grund-muster> <env...> -- <argumente...>
  b="$1"; muster="$2"; shift 2
  if env "$@" >"$ARBEIT/nein.out" 2>&1; then
    falsch "$b"
  elif grep -q "$muster" "$ARBEIT/nein.out"; then
    ok "$b"
  else
    falsch "$b (Grund fehlt)"; zeige "$ARBEIT/nein.out"
  fi
}
verweigert "unbekannte Bauart verweigert" "unbekannte Bauart" VP_INDUSTRIE_ARCH=mipsle "$SKRIPT" "root@$C" key
verweigert "fehlende Schluesseldatei verweigert" "keine lesbare Schluesseldatei" VP_SSH_KEY="$ARBEIT/gibt-es-nicht" "$SKRIPT" "root@$C" key
verweigert "Link-Name mit Pfad verweigert" "ist kein Dateiname" VP_PFC_RC_LINK_WARTUNG=../S99x "$SKRIPT" "root@$C" key
verweigert "ohne Server-Schluessel verweigert" "Server-Schluessel fehlt" "$SKRIPT" "root@$C" "$ADRESSE"
verweigert "Server-Schluessel mit fremden Zeichen verweigert" "kein WireGuard-Schluessel" VP_SERVICE_PUBKEY='abc def' "$SKRIPT" "root@$C" "$ADRESSE"
verweigert "halbe Adresse verweigert" "keine IPv4-Adresse" VP_SERVICE_PUBKEY="$SERVER_PUB" "$SKRIPT" "root@$C" 10.10.16
verweigert "VP_SERVICE_WEB=vielleicht verweigert" '"netz" oder "zu"' VP_SERVICE_PUBKEY="$SERVER_PUB" VP_SERVICE_WEB=vielleicht "$SKRIPT" "root@$C" "$ADRESSE"
verweigert "Endpunkt mit Schraegstrich verweigert" "kein Name" VP_SERVICE_PUBKEY="$SERVER_PUB" VP_SERVICE_ENDPOINT='a/b' "$SKRIPT" "root@$C" "$ADRESSE"
pruefe "auf dem Geraet liegt nichts" '[ ! -e /home/voltpilot ] && [ ! -e /etc/init.d/vp-wartung ]'

schritt "2. Fehlt dem Geraet ein Werkzeug, aendert sich nichts"
x 'mv /bin/sha256sum /bin/sha256sum.weg'
verweigert "ohne sha256sum verweigert, mit Namen" "fehlt: sha256sum" "$SKRIPT" "root@$C" key
pruefe "auf dem Geraet liegt nichts" '[ ! -e /home/voltpilot ] && [ ! -e /etc/init.d/vp-wartung ]'
x 'mv /bin/sha256sum.weg /bin/sha256sum'
verweigert "Tunnel einrichten ohne Schluessel der Box verweigert" "erst: wartung.sh <ziel> key" VP_SERVICE_PUBKEY="$SERVER_PUB" "$SKRIPT" "root@$C" "$ADRESSE"
grep -q "Pruefsumme auf dem Geraet bestaetigt" "$ARBEIT/nein.out" && ok "das Programm liegt dabei schon dort, die Pruefsumme auf dem Geraet bestaetigt" || falsch "das Programm liegt dabei schon dort, die Pruefsumme auf dem Geraet bestaetigt"
pruefe "kein Dienst-Skript, kein Start-Link, keine Einstellungen" '[ ! -e /etc/init.d/vp-wartung ] && [ ! -e /etc/rc.d/S99_vp-wartung ] && [ ! -e /home/voltpilot/wartung/konfig ]'

schritt "3. key: Programm und Schluessel der Box"
if VP_SSH_KEY="$ARBEIT/schluesseldatei" "$SKRIPT" "root@$C" key >"$ARBEIT/key.1" 2>&1; then ok "wartung.sh key laeuft durch"; else falsch "wartung.sh key laeuft durch"; zeige "$ARBEIT/key.1"; fi
BOX_PUB="$(grep -A1 '^oeffentlicher Schluessel des Geraets:' "$ARBEIT/key.1" | tail -n 1)"
[ "${#BOX_PUB}" = 44 ] && ok "oeffentlicher Schluessel der Box ausgegeben" || falsch "oeffentlicher Schluessel der Box ausgegeben ('$BOX_PUB')"
grep -q "Box-Referenz: noch keine" "$ARBEIT/key.1" && ok "ohne Box-Programm: Box-Referenz noch keine" || falsch "ohne Box-Programm: Box-Referenz noch keine"
pruefe "Ordner nur fuer root (0700), Programm root 0755, Schluessel root 0600" \
  '[ "$(stat -c "%U %a" /home/voltpilot/wartung)" = "root 700" ] && [ "$(stat -c "%U %a" /home/voltpilot/wartung/vp-wartung)" = "root 755" ] && [ "$(stat -c "%U %a" /home/voltpilot/wartung/wg.key)" = "root 600" ]'
PRIV="$(x 'cat /home/voltpilot/wartung/wg.key')"
if [ -n "$PRIV" ] && ! grep -qF "$PRIV" "$ARBEIT/key.1"; then ok "der private Schluessel steht nicht in der Ausgabe"; else falsch "der private Schluessel steht nicht in der Ausgabe"; fi
"$SKRIPT" "root@$C" key >"$ARBEIT/key.2" 2>&1 || true
[ "$(grep -A1 '^oeffentlicher Schluessel des Geraets:' "$ARBEIT/key.2" | tail -n 1)" = "$BOX_PUB" ] && grep -q "liegt schon dort" "$ARBEIT/key.2" &&
  ok "ein zweiter Aufruf nennt denselben Schluessel und kopiert das Programm nicht neu" || falsch "ein zweiter Aufruf nennt denselben Schluessel und kopiert das Programm nicht neu"
x 'mkdir -p /home/voltpilot/daten && echo edge-probe7 > /home/voltpilot/daten/ref'
"$SKRIPT" "root@$C" key 2>&1 | grep -q "Box-Referenz: edge-probe7" && ok "mit Box-Programm nennt key die Box-Referenz" || falsch "mit Box-Programm nennt key die Box-Referenz"
pruefe "noch kein Dienst: key richtet keinen Tunnel ein" '[ ! -e /etc/init.d/vp-wartung ] && ! pgrep -f "vp-wartun[g] lauf" >/dev/null'

schritt "4. Tunnel einrichten"
# Im Portal: Tunnel-Schluessel hinterlegen. Hier: der Gegenstelle die Box nennen.
g "box?pub=$(printf '%s' "$BOX_PUB" | sed 's/+/%2B/g; s/\//%2F/g; s/=/%3D/g')&adresse=$ADRESSE" >/dev/null
einrichten() { VP_SERVICE_PUBKEY="$SERVER_PUB" VP_SERVICE_ENDPOINT="$G" "$@" "$SKRIPT" "root@$C" "$ADRESSE"; }
# Derselbe Aufruf, aber der ssh-Ersatz geht als Techniker durch den Tunnel.
einrichten_tunnel() {
  VPPW_WEG=tunnel
  export VPPW_WEG
  et_rc=0
  einrichten "$@" || et_rc=$?
  unset VPPW_WEG
  return "$et_rc"
}
if einrichten env >"$ARBEIT/tunnel.1" 2>&1; then ok "wartung.sh <adresse> laeuft durch"; else falsch "wartung.sh <adresse> laeuft durch"; zeige "$ARBEIT/tunnel.1"; protokoll | tail -n 20 | sed 's/^/    | /'; fi
grep -q "Wartungsserver:     antwortet - die Schluesselausgabe ist an" "$ARBEIT/tunnel.1" && ok "das Skript meldet: Wartungsserver antwortet" || { falsch "das Skript meldet: Wartungsserver antwortet"; zeige "$ARBEIT/tunnel.1"; }
grep -q "ecdsa-sha2-nistp521 SHA256:" "$ARBEIT/tunnel.1" && grep -q "ssh-rsa SHA256:" "$ARBEIT/tunnel.1" && ok "das Skript nennt die Host-Schluessel des Geraets" || falsch "das Skript nennt die Host-Schluessel des Geraets"
pruefe "Dienst-Skript root 0755, Start-Link, Einstellungen root 0600" \
  '[ "$(stat -c "%U %a" /etc/init.d/vp-wartung)" = "root 755" ] && [ "$(readlink /etc/rc.d/S99_vp-wartung)" = ../init.d/vp-wartung ] && [ "$(stat -c "%U %a" /home/voltpilot/wartung/konfig)" = "root 600" ]'
pruefe "das Programm laeuft als root" 'k="$(cat /var/run/vp-wartung.kind)"; [ "$(stat -c %u /proc/$k)" = 0 ] && tr "\000" " " </proc/$k/cmdline | grep -q "/home/voltpilot/wartung/vp-wartung lauf"'
pruefe "oom_score_adj 300: nach dem Box-Programm, vor der SPS-Laufzeit" '[ "$(cat /proc/$(cat /var/run/vp-wartung.kind)/oom_score_adj)" = 300 ]'
pruefe "status des Dienstes meldet 0" '/etc/init.d/vp-wartung status'
[ "$(g handshake)" = ja ] && ok "Handshake am Server" || falsch "Handshake am Server"
case "$(wert handshake_vor)" in '' | -1) falsch "status werte: Handshake" ;; *) ok "status werte: Handshake vor $(wert handshake_vor) s" ;; esac
[ "$(wert ssh_2222)" = nur_im_tunnel ] && [ "$(wert laeuft)" = ja ] && ok "status werte: laeuft, SSH 2222 nur im Tunnel" || falsch "status werte: laeuft, SSH 2222 nur im Tunnel"
"$SKRIPT" "root@$C" status >"$ARBEIT/status.1" 2>&1 || true
grep -q "Wartungstunnel: laeuft seit" "$ARBEIT/status.1" && grep -q "letzte gueltige Antwort des Wartungsservers: vor" "$ARBEIT/status.1" && grep -q "Start beim Hochfahren: /etc/rc.d/S99_vp-wartung" "$ARBEIT/status.1" &&
  ok "wartung.sh status zeigt Tunnel, Abholer und Start-Link" || { falsch "wartung.sh status zeigt Tunnel, Abholer und Start-Link"; zeige "$ARBEIT/status.1"; }
g gefragt | grep -q '^fragen=[1-9]' && ok "die Box fragt die Schluesselausgabe durch den Tunnel" || falsch "die Box fragt die Schluesselausgabe durch den Tunnel"

schritt "5. Bauart: SSH 2222 und die Web-App lauschen nur im Tunnel"
x 'netstat -ltn' >"$ARBEIT/netstat" 2>&1 || true
if grep -q ':2222 ' "$ARBEIT/netstat"; then falsch "auf keiner Netzbuchse lauscht 2222"; zeige "$ARBEIT/netstat"; else ok "auf keiner Netzbuchse lauscht 2222 (netstat -ltn)"; fi
[ "$(grep -c ':8484 ' "$ARBEIT/netstat")" = 1 ] && grep -q '127.0.0.1:8484 ' "$ARBEIT/netstat" && ok "8484 lauscht nur auf dem Geraet selbst (die Attrappe)" || falsch "8484 lauscht nur auf dem Geraet selbst (die Attrappe)"
if docker exec "$G" sh -c "nc -w 3 $C 2222 </dev/null" >/dev/null 2>&1; then falsch "ueber das Netz ist 2222 nicht erreichbar"; else ok "ueber das Netz ist 2222 nicht erreichbar"; fi
[ "$(g 'tcp?port=2222')" = offen ] && ok "im Tunnel ist 2222 offen" || falsch "im Tunnel ist 2222 offen"
case "$(g 'tcp?port=22')" in zu=*) ok "im Tunnel ist sonst nichts offen (Port 22)" ;; *) falsch "im Tunnel ist sonst nichts offen (Port 22)" ;; esac

schritt "6. Anmeldung im Tunnel"
case "$(g 'ssh?schluessel=anna&befehl=true')" in
  *abgewiesen=*"unable to authenticate"*) ok "ohne Fenster und ohne dauerhaften Schluessel abgewiesen" ;;
  *) falsch "ohne Fenster und ohne dauerhaften Schluessel abgewiesen" ;;
esac
printf '%s\n' "$NOTFALL_PUB" | docker exec -i "$C" sh -c 'cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys'
x 'sha256sum /root/.ssh/authorized_keys' >"$ARBEIT/authorized.vorher"
g_ssh notfall 'echo "uid=$(id -u) art=$VP_WARTUNG_SITZUNG heim=$HOME"; echo "$SSH_CONNECTION"; cat; grep SigIgn /proc/self/status' </dev/null >"$ARBEIT/ssh.1" 2>&1 || true
grep -q '^uid=0 art=dauerhaft heim=/root$' "$ARBEIT/ssh.1" && ok "dauerhafter Schluessel: Anmeldung als root" || { falsch "dauerhafter Schluessel: Anmeldung als root"; zeige "$ARBEIT/ssh.1"; }
grep -q "^10.10.32.1 [0-9]* $ADRESSE 2222\$" "$ARBEIT/ssh.1" && ok "SSH_CONNECTION nennt Techniker-Netz und Tunnel-Adresse" || falsch "SSH_CONNECTION nennt Techniker-Netz und Tunnel-Adresse"
# SIGHUP ist Signal 1: das unterste Bit der Maske. Das Dienst-Skript ignoriert
# es; eine Sitzung darf das nicht erben.
case "$(sed -n 's/^SigIgn:[[:space:]]*//p' "$ARBEIT/ssh.1")" in
  *[02468ace]) ok "SIGHUP ist in der Sitzung nicht ignoriert" ;;
  *) falsch "SIGHUP ist in der Sitzung nicht ignoriert ($(grep SigIgn "$ARBEIT/ssh.1"))" ;;
esac
echo "eingabe ueber die leitung" | g_ssh notfall 'cat; exit 7' >"$ARBEIT/ssh.2" 2>&1 && rc=0 || rc=$?
[ "$rc" = 7 ] && grep -q '^eingabe ueber die leitung$' "$ARBEIT/ssh.2" && ok "Standardeingabe, Ausgabe und Ausgang 7 kommen durch" || { falsch "Standardeingabe, Ausgabe und Ausgang 7 kommen durch (rc $rc)"; zeige "$ARBEIT/ssh.2"; }
HOST_TUNNEL="$(g 'ssh?schluessel=notfall&befehl=true' | sed -n 's/^host=//p')"
x '/home/voltpilot/wartung/vp-wartung hostschluessel' >"$ARBEIT/hostkeys" 2>&1 || true
HOST_SOLL="$(ssh-keygen -lf "$SCHLUESSEL/dropbear_ecdsa_host_key.pub" | awk '{print $2}')"
[ -n "$HOST_TUNNEL" ] && grep -qxF "$HOST_TUNNEL" "$ARBEIT/hostkeys" && [ "${HOST_TUNNEL#* }" = "$HOST_SOLL" ] &&
  ok "der Server im Tunnel zeigt den Host-Schluessel des Geraets ($HOST_TUNNEL)" || { falsch "der Server im Tunnel zeigt den Host-Schluessel des Geraets ('$HOST_TUNNEL', Soll $HOST_SOLL)"; zeige "$ARBEIT/hostkeys"; }
g 'ssh?schluessel=notfall&terminal=1&befehl=tty' | grep -q '^/dev/pts/' && ok "eine Sitzung mit Terminal bekommt /dev/pts/N" || falsch "eine Sitzung mit Terminal bekommt /dev/pts/N"
BERT_PUB="$(g 'schluessel?name=bert')"
printf 'no-pty %s\n' "$BERT_PUB" | docker exec -i "$C" sh -c 'cat >> /root/.ssh/authorized_keys'
case "$(g 'ssh?schluessel=bert&befehl=true')" in *abgewiesen=*) ok "eine Zeile mit Optionen gilt im Tunnel nicht" ;; *) falsch "eine Zeile mit Optionen gilt im Tunnel nicht" ;; esac
mit_option_gezaehlt() { [ "$(wert dauerhaft)" = 1 ] && [ "$(wert dauerhaft_mit_optionen)" = 1 ]; }
bis 10 mit_option_gezaehlt && ok "status: 1 dauerhafter Schluessel gilt, 1 Zeile mit Optionen nicht" || falsch "status: 1 dauerhafter Schluessel gilt, 1 Zeile mit Optionen nicht ($(wert dauerhaft), $(wert dauerhaft_mit_optionen))"
printf '%s\n' "$NOTFALL_PUB" | docker exec -i "$C" sh -c 'cat > /root/.ssh/authorized_keys'

schritt "7. Fenster-Schluessel: Anmeldung im Fenster, Ende mit dem Schluessel"
g 'fenster?rest=600&zugang=anna:anna' >/dev/null
fenster_da() { [ "$(wert fenster)" = "$1" ]; }
bis 20 fenster_da 1 && ok "die Box hat den Fenster-Schluessel abgeholt" || falsch "die Box hat den Fenster-Schluessel abgeholt"
g_ssh anna 'echo "art=$VP_WARTUNG_SITZUNG"' </dev/null 2>&1 | grep -q '^art=fenster$' && ok "Anmeldung mit dem Fenster-Schluessel" || falsch "Anmeldung mit dem Fenster-Schluessel"
x '/home/voltpilot/wartung/vp-wartung status' >"$ARBEIT/status.2" 2>&1 || true
grep -q "im Fenster: Zugang anna, noch [0-9]* s" "$ARBEIT/status.2" && ok "status nennt Zugang und Restlaufzeit" || { falsch "status nennt Zugang und Restlaufzeit"; zeige "$ARBEIT/status.2"; }
[ "$(g 'halte?schluessel=anna&name=a')" = ok ] && [ "$(g 'halte?schluessel=notfall&name=n')" = ok ] && ok "zwei Sitzungen offen: Fenster-Schluessel und dauerhafter" || falsch "zwei Sitzungen offen: Fenster-Schluessel und dauerhafter"
[ "$(wert sitzungen_fenster)" = 1 ] && [ "$(wert sitzungen_dauerhaft)" = 1 ] && ok "status zaehlt sie nach der Art des Schluessels" || falsch "status zaehlt sie nach der Art des Schluessels ($(wert sitzungen_fenster), $(wert sitzungen_dauerhaft))"
g fenster >/dev/null
haelt_nicht() { [ "$(g "haelt?name=$1")" = nein ]; }
bis 15 haelt_nicht a && ok "Fenster geschlossen: die Sitzung des Fenster-Schluessels endet" || falsch "Fenster geschlossen: die Sitzung des Fenster-Schluessels endet"
sleep 2
[ "$(g 'haelt?name=n')" = ja ] && ok "die Sitzung mit dauerhaftem Schluessel bleibt" || falsch "die Sitzung mit dauerhaftem Schluessel bleibt"
case "$(g 'ssh?schluessel=anna&befehl=true')" in *abgewiesen=*) ok "neue Anmeldung nach dem Ende des Fensters abgewiesen" ;; *) falsch "neue Anmeldung nach dem Ende des Fensters abgewiesen" ;; esac
x 'cat /home/voltpilot/wartung/ereignisse' >"$ARBEIT/ereignisse" 2>&1 || true
ereignis() { grep -q "$1" "$ARBEIT/ereignisse"; }
ereignis 'Fenster-Schluessel jetzt: anna' && ereignis 'Anmeldung: Schluessel SHA256:.* (Fenster-Schluessel, Zugang anna) von 10.10.32.1:' &&
  ereignis 'Sitzung beendet (Fenster-Schluessel, Zugang anna, von 10.10.32.1:.*): ihr Fenster-Schluessel ist gestrichen' && ereignis 'Fenster-Schluessel jetzt: keine' &&
  ok "Ereignisliste: Schluessel kam, Anmeldung mit Fingerabdruck und Absender, Ende mit Grund, Schluessel ging" || { falsch "Ereignisliste vollstaendig"; zeige "$ARBEIT/ereignisse"; }
if grep -q 'AAAA' "$ARBEIT/ereignisse"; then falsch "nie ein Schluessel in der Ereignisliste"; else ok "nie ein Schluessel in der Ereignisliste"; fi
pruefe "Ereignisliste nur fuer root lesbar; kein Schluessel im Stand und im Protokoll" \
  '[ "$(stat -c "%U %a" /home/voltpilot/wartung/ereignisse)" = "root 600" ] && ! grep -q AAAA /var/run/vp-wartung.stand && ! grep vp-wartung /var/log/messages | grep -q AAAA'
"$SKRIPT" "root@$C" status 2>&1 | grep -q "Ereignisse der Fernwartung: [0-9]* in /home/voltpilot/wartung/ereignisse" && ok "wartung.sh status zeigt die letzten Ereignisse" || falsch "wartung.sh status zeigt die letzten Ereignisse"

schritt "8. Die Frist fuehrt die Box selbst"
g 'fenster?rest=12&zugang=anna:anna' >/dev/null
bis 20 fenster_da 1 || true
g 'ausgabe?status=503' >/dev/null
[ "$(g 'halte?schluessel=anna&name=frist')" = ok ] && ok "Anmeldung im Fenster, danach gibt der Server keine Liste mehr aus (503)" || falsch "Anmeldung im Fenster, danach gibt der Server keine Liste mehr aus (503)"
bis 25 haelt_nicht frist && ok "zur Frist endet die Sitzung, ohne Server" || falsch "zur Frist endet die Sitzung, ohne Server"
case "$(g 'ssh?schluessel=anna&befehl=true')" in *abgewiesen=*) ok "nach der Frist gilt der Schluessel nicht mehr" ;; *) falsch "nach der Frist gilt der Schluessel nicht mehr" ;; esac
x '/home/voltpilot/wartung/vp-wartung status' 2>&1 | grep -q "zuletzt ohne Antwort: .*503" && ok "status nennt den Grund (503)" || falsch "status nennt den Grund (503)"
g 'ausgabe?status=200' >/dev/null
g fenster >/dev/null

schritt "9. Web-App der Box im Tunnel"
g 'web?pfad=/health' >"$ARBEIT/web" 2>&1 || true
grep -q '^status=200$' "$ARBEIT/web" && grep -q 'edge-probe' "$ARBEIT/web" && ok "http://$ADRESSE:8484/health antwortet im Tunnel" || { falsch "http://$ADRESSE:8484/health antwortet im Tunnel"; zeige "$ARBEIT/web"; }

schritt "10. Dienst: Neustart nach 10 s, stop, status"
K1="$(x 'cat /var/run/vp-wartung.kind')"
x "kill -KILL $K1"
anderes_programm() { k="$(x 'cat /var/run/vp-wartung.kind 2>/dev/null')"; [ -n "$k" ] && [ "$k" != "$K1" ] && hat_antwort; }
bis 40 anderes_programm && ok "nach einem harten Ende startet der Dienst das Programm neu, der Server antwortet wieder" || { falsch "nach einem harten Ende startet der Dienst das Programm neu"; diagnose; }
protokoll | grep -q "das Programm endete mit Code" && ok "das Ende steht im Protokoll (syslog, Marke vp-wartung)" || falsch "das Ende steht im Protokoll (syslog, Marke vp-wartung)"
g_ssh notfall 'echo wieder-da' </dev/null 2>&1 | grep -q wieder-da && ok "die Anmeldung im Tunnel geht wieder" || falsch "die Anmeldung im Tunnel geht wieder"
# Ein Programm, das gleich wieder endet (hier: kaputte Einstellungen), darf das
# Protokoll nicht fuellen: die Pause waechst (10 s, 20 s, 40 s ...).
x 'cp /home/voltpilot/wartung/konfig /tmp/konfig.gut && echo "unbekannt = 1" >> /home/voltpilot/wartung/konfig && /etc/init.d/vp-wartung restart' >/dev/null 2>&1 || true
ENDEN_VOR="$(protokoll | grep -c 'das Programm endete mit Code' || true)"
sleep 45
ENDEN="$(($(protokoll | grep -c 'das Programm endete mit Code' || true) - ENDEN_VOR))"
[ "$ENDEN" -ge 2 ] && [ "$ENDEN" -le 3 ] && ok "endet das Programm sofort wieder, waechst die Pause ($ENDEN Starts in 45 s statt 5)" || falsch "endet das Programm sofort wieder, waechst die Pause ($ENDEN Starts in 45 s)"
protokoll | grep -q 'FEHLER: .*unbekannte Angabe "unbekannt"' && ok "der Grund steht im Protokoll" || falsch "der Grund steht im Protokoll"
x 'cat /tmp/konfig.gut > /home/voltpilot/wartung/konfig && rm -f /tmp/konfig.gut && /etc/init.d/vp-wartung restart' >/dev/null 2>&1 || true
bis 40 hat_antwort && ok "mit heilen Einstellungen steht der Tunnel wieder" || { falsch "mit heilen Einstellungen steht der Tunnel wieder"; diagnose; }
x '/etc/init.d/vp-wartung stop' >/dev/null 2>&1 || true
pruefe "stop: kein Programm, kein Dienst, kein Stand" '! pgrep -f "vp-wartun[g] lauf" >/dev/null && [ ! -e /var/run/vp-wartung.stand ] && [ ! -e /var/run/vp-wartung.pid ]'
x '/etc/init.d/vp-wartung status' >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" = 3 ] && ok "status des Dienstes meldet 3" || falsch "status des Dienstes meldet 3 (rc $rc)"
x '/home/voltpilot/wartung/vp-wartung status' >"$ARBEIT/status.3" 2>&1 && rc=0 || rc=$?
[ "$rc" = 3 ] && grep -q "laeuft NICHT" "$ARBEIT/status.3" && ok "vp-wartung status meldet 3 und sagt es" || falsch "vp-wartung status meldet 3 und sagt es (rc $rc)"
case "$(g 'tcp?port=2222')" in zu=*) ok "ohne Programm ist im Tunnel nichts erreichbar" ;; *) falsch "ohne Programm ist im Tunnel nichts erreichbar" ;; esac

schritt "11. Neustart des Geraets"
g 'fenster?rest=600&zugang=anna:anna' >/dev/null
x '/etc/init.d/vp-wartung start' >/dev/null 2>&1 || true
bis 30 fenster_da 1 || true
g fenster >/dev/null
g 'ausgabe?status=503' >/dev/null
docker restart -t 5 "$C" >/dev/null
bis 30 docker exec "$C" sh -c '[ -S /dev/log ]' || true
laeuft() { [ "$(wert laeuft)" = ja ]; }
bis 60 laeuft && ok "der Dienst startet ueber /etc/rc.d von selbst" || { falsch "der Dienst startet ueber /etc/rc.d von selbst"; protokoll | tail -n 10 | sed 's/^/    | /'; }
[ "$(wert fenster)" = 0 ] && ok "kein Fenster-Schluessel ueberlebt den Neustart (der Server gibt gerade keine Liste aus)" || falsch "kein Fenster-Schluessel ueberlebt den Neustart"
case "$(g 'ssh?schluessel=anna&befehl=true')" in *abgewiesen=*) ok "der Schluessel von vor dem Neustart gilt nicht" ;; *) falsch "der Schluessel von vor dem Neustart gilt nicht" ;; esac
g 'ausgabe?status=200' >/dev/null
pruefe "die Ereignisliste hat den Neustart ueberstanden" 'grep -q "Fenster-Schluessel jetzt: anna" /home/voltpilot/wartung/ereignisse'
[ "$(x 'cat /home/voltpilot/wartung/wg.key')" = "$PRIV" ] && ok "die Box behaelt ihren Schluessel" || falsch "die Box behaelt ihren Schluessel"

schritt "12. Zweiter Aufruf: gleiche Werte, dann andere"
bis 30 hat_antwort || true
K2="$(x 'cat /var/run/vp-wartung.kind')"
if einrichten env >"$ARBEIT/tunnel.2" 2>&1; then ok "wartung.sh <adresse> laeuft noch einmal durch"; else falsch "wartung.sh <adresse> laeuft noch einmal durch"; zeige "$ARBEIT/tunnel.2"; fi
grep -q "Tunnel unveraendert - das Programm laeuft weiter" "$ARBEIT/tunnel.2" && [ "$(x 'cat /var/run/vp-wartung.kind')" = "$K2" ] && ok "gleiche Werte: das Programm laeuft weiter (dieselbe PID)" || { falsch "gleiche Werte: das Programm laeuft weiter (dieselbe PID)"; zeige "$ARBEIT/tunnel.2"; }
[ "$(x 'ls /etc/rc.d | grep -c vp-wartung')" = 1 ] && ok "ein Start-Link" || falsch "ein Start-Link"
# Einstellungen, mit denen das Programm nicht startete, werden nicht abgelegt:
# sonst bliebe die Box nach dem Neustart des Dienstes ohne Tunnel.
verweigert "ein Server-Schluessel, der keiner ist, wird auf dem Geraet geprueft und verweigert" "startet der Tunnel nicht" VP_SERVICE_PUBKEY=AAAA VP_SERVICE_ENDPOINT="$G" "$SKRIPT" "root@$C" "$ADRESSE"
pruefe "die bisherigen Einstellungen bleiben, nichts Halbes liegt daneben" "grep -qF 'server_pubkey = $SERVER_PUB' /home/voltpilot/wartung/konfig && [ ! -e /home/voltpilot/wartung/konfig.neu ]"
[ "$(x 'cat /var/run/vp-wartung.kind')" = "$K2" ] && hat_antwort && ok "das Programm laeuft unberuehrt weiter" || falsch "das Programm laeuft unberuehrt weiter"
if einrichten env VP_SERVICE_WEB=zu >"$ARBEIT/tunnel.3" 2>&1; then ok "wartung.sh mit VP_SERVICE_WEB=zu laeuft durch"; else falsch "wartung.sh mit VP_SERVICE_WEB=zu laeuft durch"; zeige "$ARBEIT/tunnel.3"; fi
[ "$(x 'cat /var/run/vp-wartung.kind')" != "$K2" ] && ok "andere Werte: das Programm ist neu gestartet" || falsch "andere Werte: das Programm ist neu gestartet"
case "$(g 'tcp?port=8484')" in zu=*) ok "web = zu: 8484 ist im Tunnel zu" ;; *) falsch "web = zu: 8484 ist im Tunnel zu" ;; esac
[ "$(g 'tcp?port=2222')" = offen ] && ok "SSH im Tunnel bleibt" || falsch "SSH im Tunnel bleibt"
einrichten env >/dev/null 2>&1 || true
bis 30 hat_antwort || true

schritt "13. wartung.sh durch den Tunnel (wie ein Fernlauf)"
K3="$(x 'cat /var/run/vp-wartung.kind')"
if einrichten_tunnel env >"$ARBEIT/tunnel.4" 2>&1; then ok "wartung.sh durch den Tunnel laeuft durch"; else falsch "wartung.sh durch den Tunnel laeuft durch"; zeige "$ARBEIT/tunnel.4"; fi
grep -q "Tunnel unveraendert" "$ARBEIT/tunnel.4" && [ "$(x 'cat /var/run/vp-wartung.kind')" = "$K3" ] && ok "unveraendert: der Tunnel, durch den der Lauf spricht, bleibt" || { falsch "unveraendert: der Tunnel, durch den der Lauf spricht, bleibt"; zeige "$ARBEIT/tunnel.4"; }
if einrichten_tunnel env VP_SERVICE_WEB=zu >"$ARBEIT/tunnel.5" 2>&1; then ok "andere Werte durch den Tunnel: das Skript endet ohne Fehler"; else falsch "andere Werte durch den Tunnel: das Skript endet ohne Fehler"; zeige "$ARBEIT/tunnel.5"; fi
grep -q "der Dienst startet in 2 s neu" "$ARBEIT/tunnel.5" && ok "es sagt, dass der Dienst neu startet und die Sitzung endet" || falsch "es sagt, dass der Dienst neu startet und die Sitzung endet"
neu_gestartet() { k="$(x 'cat /var/run/vp-wartung.kind 2>/dev/null')"; [ -n "$k" ] && [ "$k" != "$K3" ] && hat_antwort; }
bis 40 neu_gestartet && ok "der Dienst ist danach von selbst wieder da, mit den neuen Werten" || { falsch "der Dienst ist danach von selbst wieder da"; diagnose; }
verweigert "abbauen durch den Tunnel verweigert" "laeuft durch den Wartungstunnel" VPPW_WEG=tunnel "$SKRIPT" "root@$C" abbauen
pruefe "nach dem verweigerten Abbauen ist alles noch da" '[ -x /home/voltpilot/wartung/vp-wartung ] && [ -s /home/voltpilot/wartung/wg.key ] && /etc/init.d/vp-wartung status'

schritt "14. abbauen"
if "$SKRIPT" "root@$C" abbauen >"$ARBEIT/abbauen" 2>&1; then ok "wartung.sh abbauen laeuft durch"; else falsch "wartung.sh abbauen laeuft durch"; zeige "$ARBEIT/abbauen"; fi
pruefe "nichts bleibt: Programm, Schluessel, Einstellungen, Ereignisliste" '[ ! -e /home/voltpilot/wartung ]'
pruefe "nichts bleibt: Dienst-Skript, Start-Link, PID-Dateien, Stand" \
  '[ ! -e /etc/init.d/vp-wartung ] && [ ! -e /etc/rc.d/S99_vp-wartung ] && [ ! -e /var/run/vp-wartung.pid ] && [ ! -e /var/run/vp-wartung.kind ] && [ ! -e /var/run/vp-wartung.stand ]'
if x 'pgrep -f "vp-wartun[g]"' >"$ARBEIT/rest" 2>&1; then
  falsch "kein Prozess des Tunnels laeuft mehr"
  x 'for p in $(pgrep -f "vp-wartun[g]"); do echo "$p $(tr "\000" " " </proc/$p/cmdline)"; done' | sed 's/^/    | /'
else
  ok "kein Prozess des Tunnels laeuft mehr"
fi
pruefe "was dem Box-Programm gehoert, bleibt (/home/voltpilot/daten)" '[ -s /home/voltpilot/daten/ref ]'
x 'find /etc -type f | sort | xargs sha256sum' >"$ARBEIT/etc.nachher"
cmp -s "$ARBEIT/etc.vorher" "$ARBEIT/etc.nachher" && ok "/etc ist wie vor der Probe (auch /etc/dropbear)" || { falsch "/etc ist wie vor der Probe"; diff "$ARBEIT/etc.vorher" "$ARBEIT/etc.nachher" | sed 's/^/    | /' || true; }
x 'sha256sum /root/.ssh/authorized_keys' >"$ARBEIT/authorized.nachher"
cmp -s "$ARBEIT/authorized.vorher" "$ARBEIT/authorized.nachher" && ok "die Schluesseldatei von root ist unveraendert (nur gelesen)" || falsch "die Schluesseldatei von root ist unveraendert (nur gelesen)"
"$SKRIPT" "root@$C" status 2>&1 | grep -q "nicht eingerichtet" && ok "status sagt: nicht eingerichtet" || falsch "status sagt: nicht eingerichtet"

schritt "Ergebnis"
echo "  $OK ok, $FEHLER Fehler ($(x 'busybox | head -n 1' | cut -d'(' -f1 | sed 's/ *$//'), $(x 'uname -m'))"
[ "$FEHLER" -eq 0 ]
