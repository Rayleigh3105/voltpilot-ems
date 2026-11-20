#!/bin/sh
# Wartungstunnel auf einem WAGO PFC200 (WAGO-Firmware) einrichten - dauerhaft
# und unabhaengig von vp-edge-industrie. Das Gegenstueck zu
# edge-light/openwrt/service-tunnel.sh fuer ein Geraet ohne OpenWrt: statt
# WireGuard im Kern, Dropbear und Firewall-Regeln laeuft EIN Programm,
# vp-wartung (edge-industrie/wartung), mit WireGuard im eigenen Prozess. Der
# private Schluessel entsteht auf dem Geraet und verlaesst es nie.
#
#   1. Programm und Schluessel:
#        edge-industrie/scripts/build-wartung.sh           (oder das Programm aus einem Release)
#        edge-industrie/wartung.sh root@192.168.1.17 key
#      -> gibt oeffentlichen Schluessel und Box-Referenz aus; beides im Portal
#         unter Geraete > Fernwartung > "Tunnel-Schluessel hinterlegen" eintragen.
#   2. Tunnel mit der dort zugeteilten Adresse einrichten:
#        VP_SERVICE_PUBKEY='<server>' edge-industrie/wartung.sh root@192.168.1.17 10.10.16.5 [port]
#   3. Zustand ansehen:
#        edge-industrie/wartung.sh root@<pfc> status
#   4. Den Tunnel vollstaendig abbauen (Programm, Schluessel, Einstellungen,
#      Ereignisliste, Dienst):
#        edge-industrie/wartung.sh root@<pfc> abbauen
#      Verweigert, solange die SSH-Sitzung durch genau diesen Tunnel laeuft.
#
# Umgebung (dieselben Namen wie bei service-tunnel.sh):
#   VP_SSH_KEY=<datei>              Schluesseldatei fuer ssh (ssh -i); ohne die
#                                   Variable entscheidet ~/.ssh/config.
#   VP_SERVICE_PUBKEY               oeffentlicher Schluessel des Wartungsservers
#                                   (Pflicht in Schritt 2, steht im Portal).
#   VP_SERVICE_ENDPOINT             Name des Wartungsservers (wartung.voltpilot.de).
#   VP_SERVICE_NET                  erlaubtes Netz im Tunnel = Techniker-Netz
#                                   (10.10.32.0/24; mehrere mit Komma).
#   VP_SERVICE_WEB=netz|zu          Web-App :8484 im Tunnel fuer das Techniker-Netz
#                                   (Vorgabe netz) oder gar nicht.
#   VP_SERVICE_SCHLUESSEL_SERVER    Schluesselausgabe (Vorgabe: .1 des Netzes)
#   VP_SERVICE_SCHLUESSEL_PORT      und ihr Port (8022).
#   VP_INDUSTRIE_ARCH                   Bauart (arm; arm64/amd64 nur fuer Proben).
#   VP_PFC_RC_LINK_WARTUNG          Name des Start-Links in /etc/rc.d
#                                   (Vorgabe S99_vp-wartung).
#
# Was auf dem Geraet entsteht (alles gehoert root):
#   /home/voltpilot/wartung/vp-wartung   das Programm
#   /home/voltpilot/wartung/wg.key       Schluessel der Box (0600)
#   /home/voltpilot/wartung/konfig       Einstellungen
#   /home/voltpilot/wartung/ereignisse   Ereignisliste (nur bei einem Ereignis,
#                                        hoechstens 250 Zeilen, nie ein Schluessel)
#   /etc/init.d/vp-wartung               Dienst-Skript
#   /etc/rc.d/S99_vp-wartung             Link: Start beim Hochfahren
#
# Was im Tunnel gilt (docs/fernwartung.md):
#   - SSH auf Port 2222, nur als root, nur mit Schluessel. Der Port lauscht
#     auf KEINER Netzbuchse: er existiert nur im Tunnel. Port 22 im Netz des
#     Geraets aendert sich nicht.
#   - Im offenen Fenster gilt der SSH-Schluessel, der im Portal am
#     Techniker-Zugang steht (nur RSA). Das Programm holt ihn beim
#     Wartungsserver ab, haelt ihn nur im Arbeitsspeicher und streicht ihn zum
#     Ende des Fensters; mit ihm enden die Sitzungen, die mit ihm begannen.
#   - Was dauerhaft in /root/.ssh/authorized_keys steht, gilt im Tunnel weiter
#     (die Datei wird nur gelesen); Zeilen mit Optionen gelten dort nicht.
#   - Der Server im Tunnel zeigt die Host-Schluessel des Geraets
#     (/etc/dropbear), keinen eigenen.
#   - Web-App :8484 im Tunnel fuer das Techniker-Netz, ohne eigene Anmeldung:
#     die Schranke ist das Fenster am Wartungsserver.
#
# Das Skript fasst die SPS-Laufzeit, die Firewall, die Netzeinstellungen und
# den Dropbear des Geraets nicht an. Erneut ausfuehrbar; der Schluessel bleibt.
set -eu

TARGET="${1:?Ziel fehlt, z. B. root@192.168.1.17}"
WHAT="${2:?\"key\", \"status\", \"abbauen\" oder die Tunnel-Adresse fehlt}"
ARCH="${VP_INDUSTRIE_ARCH:-arm}"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
BIN="$HERE/dist/vp-wartung-linux-$ARCH"
HEIM=/home/voltpilot
ORT="$HEIM/wartung"
PROG="$ORT/vp-wartung"
KONFIG="$ORT/konfig"
RC_LINK="${VP_PFC_RC_LINK_WARTUNG:-S99_vp-wartung}"

case "$ARCH" in
  arm | arm64 | amd64) ;;
  *) echo "FEHLER: unbekannte Bauart VP_INDUSTRIE_ARCH=$ARCH (arm; arm64|amd64 nur fuer Proben)" >&2; exit 1 ;;
esac
case "$RC_LINK" in
  '' | */* | *[!A-Za-z0-9_.-]*) echo "FEHLER: VP_PFC_RC_LINK_WARTUNG=$RC_LINK ist kein Dateiname" >&2; exit 1 ;;
esac
if [ -n "${VP_SSH_KEY:-}" ] && [ ! -r "$VP_SSH_KEY" ]; then
  echo "FEHLER: VP_SSH_KEY=$VP_SSH_KEY ist keine lesbare Schluesseldatei" >&2
  exit 1
fi
# box_ssh <ziel> <befehl> - ssh zur Box, mit VP_SSH_KEY als Schluesseldatei
box_ssh() {
  if [ -n "${VP_SSH_KEY:-}" ]; then
    ssh -i "$VP_SSH_KEY" "$@"
  else
    ssh "$@"
  fi
}
summe() { sha256sum "$1" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$1" | awk '{print $1}'; }

if [ "$WHAT" = status ]; then
  # shellcheck disable=SC2029 # die Pfade kommen bewusst von hier
  box_ssh "$TARGET" "
    if [ -x $PROG ]; then $PROG status; else echo 'Wartungstunnel: nicht eingerichtet (kein Programm unter $PROG)'; fi
    if [ -x /etc/init.d/vp-wartung ]; then /etc/init.d/vp-wartung status || true; else echo 'vp-wartung: kein Dienst-Skript'; fi
    if [ -L /etc/rc.d/$RC_LINK ]; then echo 'Start beim Hochfahren: /etc/rc.d/$RC_LINK'; else echo 'Start beim Hochfahren: NICHT eingerichtet'; fi"
  exit 0
fi

if [ "$WHAT" = abbauen ]; then
  echo "--- Wartungstunnel auf $TARGET abbauen"
  # Nicht den Ast absaegen, auf dem man sitzt: laeuft diese SSH-Sitzung durch
  # genau diesen Tunnel, waere die Box danach nur noch vor Ort erreichbar.
  # shellcheck disable=SC2029
  box_ssh "$TARGET" "set -e
    if [ -n \"\${VP_WARTUNG_SITZUNG:-}\" ]; then
      echo 'FEHLER: diese Sitzung laeuft durch den Wartungstunnel - erst auf einem anderen Weg anmelden' >&2
      exit 1
    fi
    if [ -x /etc/init.d/vp-wartung ]; then /etc/init.d/vp-wartung stop >/dev/null 2>&1 || true; fi
    rm -f /etc/rc.d/$RC_LINK /etc/init.d/vp-wartung /etc/init.d/vp-wartung.neu
    rm -f /var/run/vp-wartung.pid /var/run/vp-wartung.kind /var/run/vp-wartung.stand
    rm -rf $ORT
    echo 'abgebaut: Dienst, Start-Link, Programm, Schluessel, Einstellungen, Ereignisliste'"
  exit 0
fi

if [ ! -f "$BIN" ]; then
  echo "FEHLER: das Programm fehlt ($BIN) - erst edge-industrie/scripts/build-wartung.sh $ARCH" >&2
  exit 1
fi
SUM="$(summe "$BIN")"

# --- Was Schritt 2 braucht, pruefen, bevor irgendetwas auf das Geraet geht -------
if [ "$WHAT" != key ]; then
  case "$WHAT" in
    *[!0-9.]* | "") echo "FEHLER: keine IPv4-Adresse: $WHAT" >&2; exit 1 ;;
    *.*.*.*) ADDR="$WHAT" ;;
    *) echo "FEHLER: keine IPv4-Adresse: $WHAT" >&2; exit 1 ;;
  esac
  ENDPOINT="${VP_SERVICE_ENDPOINT:-wartung.voltpilot.de}"
  PORT="${3:-51820}"
  SERVER_PUB="${VP_SERVICE_PUBKEY:-}"
  NET="${VP_SERVICE_NET:-10.10.32.0/24}"
  WEB="${VP_SERVICE_WEB:-netz}"
  S_PORT="${VP_SERVICE_SCHLUESSEL_PORT:-8022}"
  S_NETZ="${NET%%,*}"
  S_NETZ="${S_NETZ%%/*}"
  S_SERVER="${VP_SERVICE_SCHLUESSEL_SERVER:-${S_NETZ%.*}.1}"
  case "$SERVER_PUB" in
    "")
      echo "FEHLER: Server-Schluessel fehlt - VP_SERVICE_PUBKEY='<Schluessel aus dem Portal, Geraete > Fernwartung>' setzen" >&2
      exit 1
      ;;
    *[!A-Za-z0-9+/=]*)
      echo "FEHLER: VP_SERVICE_PUBKEY ist kein WireGuard-Schluessel" >&2
      exit 1
      ;;
  esac
  case "$WEB" in netz | zu) ;; *) echo "FEHLER: VP_SERVICE_WEB ist \"netz\" oder \"zu\", nicht \"$WEB\"" >&2; exit 1 ;; esac
  case "$PORT" in "" | *[!0-9]*) echo "FEHLER: kein Port: $PORT" >&2; exit 1 ;; esac
  case "$S_PORT" in "" | *[!0-9]*) echo "FEHLER: VP_SERVICE_SCHLUESSEL_PORT ist kein Port: $S_PORT" >&2; exit 1 ;; esac
  case "$ENDPOINT" in "" | *[!A-Za-z0-9.-]*) echo "FEHLER: VP_SERVICE_ENDPOINT ist kein Name: $ENDPOINT" >&2; exit 1 ;; esac
  case "$NET" in "" | *[!0-9.,/]*) echo "FEHLER: VP_SERVICE_NET ist kein Netz: $NET" >&2; exit 1 ;; esac
  case "$S_SERVER" in
    *[!0-9.]* | "") echo "FEHLER: keine IPv4-Adresse fuer die Schluesselausgabe: $S_SERVER" >&2; exit 1 ;;
    *.*.*.*) ;;
    *) echo "FEHLER: keine IPv4-Adresse fuer die Schluesselausgabe: $S_SERVER" >&2; exit 1 ;;
  esac
fi

# --- Das Geraet: erst pruefen, dann aendern ---------------------------------------
echo "--- pruefe $TARGET"
# shellcheck disable=SC2029
pruefung="$(box_ssh "$TARGET" "
  [ \"\$(id -u)\" = 0 ] || echo 'FEHLT: Anmeldung als root'
  for w in sha256sum awk sed grep cut tr logger id; do
    command -v \$w >/dev/null 2>&1 || echo \"FEHLT: \$w\"
  done
  [ -d /etc/init.d ] || echo 'FEHLT: /etc/init.d'
  [ ! -L $HEIM ] || echo 'FEHLT: $HEIM ist ein Link, kein Verzeichnis'
  [ ! -L $ORT ] || echo 'FEHLT: $ORT ist ein Link, kein Verzeichnis'
  [ -d /etc/rc.d ] || echo 'HINWEIS: /etc/rc.d fehlt - der Start beim Hochfahren wird nicht eingerichtet'
  echo PRUEFUNG-ENDE
")"
case "$pruefung" in
  *PRUEFUNG-ENDE*) ;;
  *) echo "FEHLER: $TARGET antwortet nicht wie erwartet (ssh als root?)" >&2; exit 1 ;;
esac
echo "$pruefung" | sed -n 's/^HINWEIS: /    HINWEIS: /p'
if echo "$pruefung" | grep -q '^FEHLT: '; then
  echo "$pruefung" | sed -n 's/^FEHLT: /    fehlt: /p' >&2
  echo "FEHLER: $TARGET erfuellt die Voraussetzungen nicht - nichts geaendert" >&2
  exit 1
fi

# Was vor diesem Lauf auf dem Geraet lag: nur zum Vergleich, damit ein erneuter
# Lauf mit denselben Werten den Tunnel nicht anfasst.
stand_befehl="cat $PROG $KONFIG /etc/init.d/vp-wartung 2>/dev/null | sha256sum | cut -c 1-64"
# shellcheck disable=SC2029
STAND_ALT="$(box_ssh "$TARGET" "$stand_befehl")"

echo "--- Programm vp-wartung nach $TARGET ($PROG)"
# $HEIM gehoert root (wie bei install.sh): nur root legt darunter etwas an.
# Einzeldatei per cat|ssh (kein scp/sftp vorausgesetzt), atomar: die
# Pruefsumme wird auf dem Geraet nachgerechnet, bevor das Programm gilt. Ein
# laufendes Programm behaelt seine alte Datei, bis der Dienst neu startet.
# shellcheck disable=SC2029
gleich="$(box_ssh "$TARGET" "set -e
  mkdir -p $HEIM $ORT
  chown root:root $ORT
  chmod 0700 $ORT
  if [ \"\$(sha256sum $PROG 2>/dev/null | cut -c 1-64)\" = $SUM ]; then echo gleich; else echo anders; fi")"
if [ "$gleich" = gleich ]; then
  echo "    liegt schon dort (Pruefsumme gleich)"
else
  # shellcheck disable=SC2029
  box_ssh "$TARGET" "cat > $PROG.neu && chown root:root $PROG.neu && chmod 0755 $PROG.neu" <"$BIN"
  # shellcheck disable=SC2029
  remote_sum="$(box_ssh "$TARGET" "sha256sum $PROG.neu" | awk '{print $1}')"
  if [ "$remote_sum" != "$SUM" ]; then
    # shellcheck disable=SC2029
    box_ssh "$TARGET" "rm -f $PROG.neu"
    echo "FEHLER: Pruefsumme des Programms stimmt auf dem Geraet nicht" >&2
    exit 1
  fi
  # Laeuft es dort? Eine falsche Bauart faellt hier auf, bevor es gilt.
  # shellcheck disable=SC2029
  if ! box_ssh "$TARGET" "$PROG.neu fassung >/dev/null 2>&1"; then
    # shellcheck disable=SC2029
    box_ssh "$TARGET" "rm -f $PROG.neu"
    echo "FEHLER: das Programm startet auf dem Geraet nicht (Bauart $ARCH?)" >&2
    exit 1
  fi
  # shellcheck disable=SC2029
  box_ssh "$TARGET" "mv -f $PROG.neu $PROG && sync"
  awk -v b="$(wc -c <"$BIN")" 'BEGIN {printf "    %.1f MB, Pruefsumme auf dem Geraet bestaetigt\n", b / 1048576}'
fi

if [ "$WHAT" = key ]; then
  echo "--- Schluessel der Box (der private bleibt auf dem Geraet)"
  # shellcheck disable=SC2029
  box_ssh "$TARGET" "set -e
    $PROG schluessel
    if [ -s $HEIM/daten/ref ]; then
      echo \"Box-Referenz: \$(cat $HEIM/daten/ref)\"
    else
      echo 'Box-Referenz: noch keine (vp-edge-industrie einmal starten, dann steht sie in $HEIM/daten/ref)'
    fi"
  echo "--- im Portal: Geraete > Fernwartung > Tunnel-Schluessel hinterlegen (Referenz + Schluessel)"
  exit 0
fi

echo "--- Tunnel $ADDR -> $ENDPOINT:$PORT einrichten"
# Der Server im Tunnel zeigt die Host-Schluessel des Geraets. Kann das
# Programm keinen lesen, startete es nicht: das faellt hier auf, bevor der
# Dienst angefasst wird.
# shellcheck disable=SC2029
if ! hostkeys="$(box_ssh "$TARGET" "[ -s $ORT/wg.key ] || { echo 'kein Schluessel der Box - erst: wartung.sh <ziel> key' >&2; exit 1; }; $PROG hostschluessel" 2>&1)"; then
  echo "FEHLER: $hostkeys" >&2
  exit 1
fi

# Die Einstellungen: nur, was dieses Skript bestimmt; alles andere sind die
# Vorgaben des Programms (Host-Schluessel, dauerhafte Schluessel, Ereignisliste).
# shellcheck disable=SC2029
{
  echo "# Wartungstunnel - geschrieben von edge-industrie/wartung.sh, nicht von Hand aendern."
  echo "adresse = $ADDR"
  echo "endpunkt = $ENDPOINT:$PORT"
  echo "server_pubkey = $SERVER_PUB"
  echo "netz = $NET"
  echo "schluessel_server = $S_SERVER:$S_PORT"
  echo "web = $WEB"
} | box_ssh "$TARGET" "cat > $KONFIG.neu && chown root:root $KONFIG.neu && chmod 0600 $KONFIG.neu"
# Erst pruefen, dann ablegen: mit Einstellungen, mit denen das Programm nicht
# startet (falscher Wert, abgerissene Uebertragung), bliebe die Box ohne
# Tunnel - bei einem Lauf durch den Tunnel selbst ohne Rueckweg.
# shellcheck disable=SC2029
if ! urteil="$(box_ssh "$TARGET" "$PROG pruefe -konfig $KONFIG.neu" 2>&1)"; then
  # shellcheck disable=SC2029
  box_ssh "$TARGET" "rm -f $KONFIG.neu"
  echo "FEHLER: mit diesen Einstellungen startet der Tunnel nicht - die bisherigen bleiben, der Dienst ist nicht angefasst: $urteil" >&2
  exit 1
fi
# shellcheck disable=SC2029
box_ssh "$TARGET" "cat > /etc/init.d/vp-wartung.neu && chown root:root /etc/init.d/vp-wartung.neu && chmod 0755 /etc/init.d/vp-wartung.neu && mv -f /etc/init.d/vp-wartung.neu /etc/init.d/vp-wartung" <"$HERE/files/etc/init.d/vp-wartung"
# shellcheck disable=SC2029
box_ssh "$TARGET" "mv -f $KONFIG.neu $KONFIG && sync"

# shellcheck disable=SC2029
STAND_NEU="$(box_ssh "$TARGET" "$stand_befehl")"
# shellcheck disable=SC2029
box_ssh "$TARGET" "set -e
  if [ -d /etc/rc.d ]; then
    ln -sf ../init.d/vp-wartung /etc/rc.d/$RC_LINK
  else
    echo '    WARNUNG: /etc/rc.d fehlt - Start beim Hochfahren NICHT eingerichtet'
  fi
  if [ '$STAND_ALT' = '$STAND_NEU' ] && /etc/init.d/vp-wartung status >/dev/null 2>&1; then
    echo 'Tunnel unveraendert - das Programm laeuft weiter'
  elif [ -n \"\${VP_WARTUNG_SITZUNG:-}\" ]; then
    # Diese Sitzung laeuft durch den Tunnel, den der Neustart beendet: erst
    # antworten, dann neu starten.
    echo 'der Dienst startet in 2 s neu - diese Sitzung laeuft durch den Tunnel und endet damit'
    ( sleep 2; /etc/init.d/vp-wartung restart ) </dev/null >/dev/null 2>&1 &
    exit 0
  else
    /etc/init.d/vp-wartung restart >/dev/null
  fi
  # Bis das Programm seinen Stand nennt und der Server geantwortet hat.
  i=0
  until $PROG status werte 2>/dev/null | grep -q '^antwort_vor=[0-9]' || [ \"\$i\" -ge 20 ]; do
    i=\$((i + 1))
    sleep 1
  done
  w() { $PROG status werte 2>/dev/null | sed -n \"s/^\$1=//p\"; }
  if [ \"\$(w laeuft)\" != ja ]; then
    echo 'FEHLER: das Tunnel-Programm laeuft nicht (syslog mit der Marke vp-wartung)' >&2
    exit 1
  fi
  echo \"eingerichtet: Tunnel $ADDR, SSH 2222 und Web-App 8484 ($WEB) nur im Tunnel, Start beim Hochfahren /etc/rc.d/$RC_LINK\"
  echo 'Anmeldung im Tunnel: ssh -p 2222 root@$ADDR, nur mit Schluessel'
  echo '  im offenen Fenster: der SSH-Schluessel, der im Portal am Techniker-Zugang hinterlegt ist (RSA). Das Programm holt ihn beim'
  echo '                      Wartungsserver ($S_SERVER:$S_PORT, nur durch den Tunnel), haelt ihn nur im Arbeitsspeicher und streicht'
  echo '                      ihn zum Ende des Fensters. Vom Techniker-Geraet: ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 root@$ADDR'
  echo '  zum Ende:           mit dem Schluessel enden die Sitzungen, die mit ihm begonnen wurden'
  echo '  nachlesen:          wer wann angemeldet war, steht auf der Box in $ORT/ereignisse (hoechstens 250 Zeilen,'
  echo '                      nie ein Schluessel); die letzten zeigt: wartung.sh <ziel> status'
  echo \"  dauerhaft:          \$(w dauerhaft) Schluessel aus /root/.ssh/authorized_keys gelten im Tunnel weiter\"
  if [ \"\$(w handshake_vor)\" = -1 ]; then
    echo '  Wartungsserver:     noch KEIN Handshake (Weg ins Internet, Uhr der Box, Schluessel im Portal hinterlegt?) - das Programm versucht es weiter'
  elif [ \"\$(w antwort_vor)\" = -1 ]; then
    echo '  Wartungsserver:     Handshake steht, er gibt aber noch KEINE Schluessel aus. Bis dahin gelingt die Anmeldung nur mit'
    echo '                      einem dauerhaften Schluessel; das Programm fragt weiter.'
  else
    echo '  Wartungsserver:     antwortet - die Schluesselausgabe ist an'
  fi"

echo "    Host-Schluessel im Tunnel (die des Geraets):"
echo "$hostkeys" | sed 's/^/      /'
echo "--- fertig. Stand der Box:  $(basename "$0") $TARGET status"
if [ "$WEB" = netz ]; then
  echo "    Web-App ueber den Tunnel: http://$ADDR:8484 (aus $NET, im offenen Fenster)"
else
  echo "    Web-App ueber den Tunnel: ssh -p 2222 -L 8484:127.0.0.1:8484 root@$ADDR  -> http://127.0.0.1:8484"
fi
