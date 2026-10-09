#!/bin/sh
# Fenster-Schluessel der Fernwartung - Box-Seite. Gehoert zum Betriebssystem,
# NICHT zu vp-edge-light: ein Update, ein Absturz oder ein falsches Programm
# beruehren die Anmeldung im Wartungstunnel nicht.
#
# Holt beim Wartungsserver ab, wessen SSH-Schluessel sich gerade an dieser Box
# anmelden darf, und schreibt die Schluesseldatei der Wartungs-Instanz von
# Dropbear (dropbear -D, /etc/init.d/vp-wartung). Anfrage und Antwort:
# docs/contracts/fernwartung-schluessel-v1.md.
#
#   schluessel-holen.sh lauf    Dauerlauf (procd): fragt den Server, wartet dort
#                               auf eine Aenderung, uebernimmt die Liste
#   schluessel-holen.sh frist   nur Verfallenes streichen (cron, jede Minute) -
#                               unabhaengig vom Dauerlauf, ohne Netz
#   schluessel-holen.sh einmal  eine Abfrage von Hand (loest die offene Anfrage
#                               des Dauerlaufs ab; der fragt danach neu)
#   schluessel-holen.sh status  Stand zeigen - nie einen Schluessel, nur Zugang
#                               und Restlaufzeit
#
# Regeln:
#   - Gefragt wird nur ueber den Wartungstunnel: die Route zum Server muss ueber
#     die Tunnel-Schnittstelle fuehren (und die Firewall der Box weist die
#     Anfrage auf jedem anderen Weg ab, service-tunnel.sh). WireGuard belegt,
#     dass der Server es ist; die Box ist an ihrer Tunnel-Adresse erkannt.
#   - Alles liegt im RAM: der Arbeitsstand unter /tmp, die Schluesseldatei in
#     einem eigenen tmpfs. Ein Neustart loescht jeden Fenster-Schluessel. (Nicht
#     unter /tmp: Dropbear prueft jedes Elternverzeichnis, und /tmp ist fuer
#     alle schreibbar.) Ohne das tmpfs schreibt das Skript nichts.
#   - Jeder Schluessel hat eine Frist in LAUFZEIT der Box (/proc/uptime), nicht
#     in Uhrzeit: eine falsche oder springende Uhr verlaengert nichts.
#   - Nur eine vollstaendige, formgerechte Antwort gilt, und sie ist die ganze
#     Liste: was sie nicht mehr nennt, ist sofort gestrichen. Kommt keine
#     gueltige Antwort, kommt nichts dazu; was da ist, verfaellt zur Frist.
#   - /etc/dropbear/authorized_keys (dauerhafte Schluessel, Anmeldung im LAN)
#     wird nur GELESEN und gilt im Tunnel weiter.
set -u

ART="${1:-lauf}"
einstellung() { uci -q get "vp-wartung.schluessel.$1" 2>/dev/null || true; }
SERVER="${VP_WARTUNG_SERVER:-$(einstellung server)}"
SERVER="${SERVER:-10.10.32.1}"
PORT="${VP_WARTUNG_PORT:-$(einstellung port)}"
PORT="${PORT:-8022}"
IFACE="${VP_WARTUNG_SCHNITTSTELLE:-$(einstellung schnittstelle)}"
IFACE="${IFACE:-wg_wartung}"
WARTE="${VP_WARTUNG_WARTE:-$(einstellung warte)}"
WARTE="${WARTE:-45}"
DIR="${VP_WARTUNG_DIR:-/tmp/vp-wartung}"
KEYDIR="${VP_WARTUNG_KEYDIR:-/etc/vp-wartung/keys}"
DAUER="${VP_WARTUNG_DAUERHAFT:-/etc/dropbear/authorized_keys}"
UPTIME="${VP_WARTUNG_UPTIME:-/proc/uptime}"
MAX_SEK=86400     # laengstes Fenster, das die Box annimmt (24 h)
MAX_ANZAHL=8      # mehr Schluessel auf einmal nimmt die Box nicht an
MAX_BYTES=16384   # eine groessere Antwort ist keine
VORLAUF=5         # so viele Sekunden vor einer Frist fragt die Box wieder
# Letzte Zeile der Schluesseldatei: fehlt sie, ist die Datei abgeschnitten.
# Kuerzer als jede Schluesselzeile - Dropbear uebergeht sie ohne Meldung.
ENDE="#ende"
KEYS="$KEYDIR/authorized_keys"
STAND="$DIR/stand" # Zeilen: <frist in Laufzeit> <zugang> <schluessel-base64>

melde() { logger -t vp-wartung "$*"; }
laufzeit() { cut -d. -f1 "$UPTIME" 2>/dev/null; }
ganzzahl() { case "$1" in "" | *[!0-9]*) return 1 ;; esac; }
tmpfs_da() { grep -q " $KEYDIR tmpfs " /proc/mounts; }
# tunnel_steht: fuehrt der Weg zum Server durch den Tunnel? Ohne die
# Schnittstelle nicht. Nennt ip keinen Weg (kein "route get", keine Route),
# entscheidet allein die Firewall der Box: sie weist die Anfrage auf jedem
# anderen Weg ab.
tunnel_steht() {
  [ -d "/sys/class/net/$IFACE" ] || return 1
  weg="$(ip -4 route get "$SERVER" 2>/dev/null)" || return 0
  case "$weg" in
    "" | *" dev $IFACE "*) return 0 ;;
  esac
  return 1
}

# mit_sperre <befehl ...>: Stand und Schluesseldatei aendert immer nur einer.
# Rueckgabe 75, wenn die Sperre nach 10 s nicht frei ist.
mit_sperre() {
  (
    n=0
    until flock -n 9; do
      n=$((n + 1))
      [ "$n" -le 10 ] || exit 75
      sleep 1
    done
    "$@"
  ) 9>"$DIR/sperre"
}

# pruefe <datei>: 0 und die neue Liste auf stdout (Zeilen wie im Stand), wenn
# die Antwort vollstaendig und formgerecht ist. Die Box prueft jede Zeile
# selbst, auch den Schluessel, und kappt die Restlaufzeit.
pruefe() {
  awk -v jetzt="$(laufzeit)" -v max_sek="$MAX_SEK" -v max_anzahl="$MAX_ANZAHL" '
    function schlecht() { kaputt = 1; exit 2 }
    NR == 1 {
      if (jetzt !~ /^[0-9]+$/) schlecht()
      if ($0 != "vp-wartung-schluessel 1 " $3 || $3 !~ /^[0-9a-f]+$/ || length($3) != 16) schlecht()
      next
    }
    zu { schlecht() }
    $1 == "schluessel" {
      if (NF != 5 || $0 != "schluessel " $2 " " $3 " " $4 " " $5) schlecht()
      if ($2 !~ /^[0-9]+$/ || length($2) > 9 || $2 + 0 < 1) schlecht()
      if ($3 !~ /^[A-Za-z0-9_-]+$/ || length($3) > 64) schlecht()
      if ($4 != "ssh-rsa" || $5 !~ /^AAAAB3NzaC1yc2E[A-Za-z0-9+\/]+=*$/) schlecht()
      if (length($5) < 360 || length($5) > 720 || length($5) % 4 != 0) schlecht()
      sek = $2 + 0
      if (sek > max_sek) sek = max_sek
      n++
      if (n > max_anzahl) schlecht()
      zeile[n] = (jetzt + sek) " " $3 " " $5
      next
    }
    $1 == "ende" {
      if ($0 != "ende " $2 || $2 !~ /^[0-9]+$/ || $2 + 0 != n + 0) schlecht()
      zu = 1
      next
    }
    { schlecht() }
    END {
      if (kaputt || !zu) exit 2
      for (i = 1; i <= n; i++) print zeile[i]
    }
  ' "$1"
}

# gueltig <laufzeit>: die Zeilen des Stands, deren Frist noch nicht erreicht ist.
gueltig() {
  [ -f "$STAND" ] || return 0
  awk -v jetzt="$1" 'NF == 3 && $1 ~ /^[0-9]+$/ && $1 + 0 > jetzt + 0' "$STAND" 2>/dev/null
}

# schreibe: Verfallenes streichen, die Schluesseldatei neu zusammensetzen.
# Laesst sie sich nicht vollstaendig schreiben, bleibt keine alte Fassung
# stehen: lieber keine Anmeldung als eine mit einem verfallenen Schluessel.
schreibe() {
  tmpfs_da || return 1
  jetzt="$(laufzeit)"
  neu="$KEYS.neu.$$"
  {
    if [ -r "$DAUER" ]; then awk '{ print }' "$DAUER"; fi
    # Ohne lesbare Laufzeit gilt kein Fenster-Schluessel.
    if ganzzahl "$jetzt"; then gueltig "$jetzt" | awk '{ print "ssh-rsa " $3 " vp-fenster:" $2 }'; fi
    echo "$ENDE"
  } >"$neu" 2>/dev/null
  if [ "$(tail -n 1 "$neu" 2>/dev/null)" != "$ENDE" ] || ! chmod 600 "$neu"; then
    rm -f "$neu" "$KEYS"
    melde "FEHLER: Schluesseldatei nicht schreibbar - keine Anmeldung im Tunnel, bis es wieder geht"
    return 1
  fi
  if cmp -s "$neu" "$KEYS" 2>/dev/null; then
    rm -f "$neu"
  elif mv -f "$neu" "$KEYS"; then
    zugaenge="$(sed -n 's/^ssh-rsa [^ ]* vp-fenster://p' "$KEYS" | tr '\n' ' ')"
    melde "Fenster-Schluessel jetzt: ${zugaenge:-keine}"
  else
    rm -f "$neu" "$KEYS"
    melde "FEHLER: Schluesseldatei nicht ersetzbar - keine Anmeldung im Tunnel, bis es wieder geht"
    return 1
  fi
  # Nur Ordnung im Stand; die Schluesseldatei haengt nicht daran.
  if ganzzahl "$jetzt" && [ -f "$STAND" ]; then
    gueltig "$jetzt" >"$STAND.neu.$$" 2>/dev/null && mv -f "$STAND.neu.$$" "$STAND"
    rm -f "$STAND.neu.$$"
  fi
  return 0
}

# uebernimm <datei>: eine gepruefte Antwort wird der neue Stand - die ganze
# Liste, mit der Restlaufzeit aus dieser Antwort (sie kann kuerzer geworden sein).
uebernimm() {
  if pruefe "$1" >"$STAND.antwort.$$" 2>/dev/null; then
    mv -f "$STAND.antwort.$$" "$STAND" && schreibe && laufzeit >"$DIR/zuletzt"
  else
    rm -f "$STAND.antwort.$$"
    return 2
  fi
}

# frage <warte> <frist der anfrage in s>: 0, wenn eine gueltige Antwort
# uebernommen wurde. Sonst steht der Grund in $grund, und nichts aendert sich.
kind=""
kennung=""
grund=""
frage() {
  antwort="$DIR/antwort.$ART"
  rm -f "$antwort"
  if ! tunnel_steht; then
    grund="Tunnel $IFACE unten (keine Route zu $SERVER ueber den Tunnel)"
    return 1
  fi
  # Die Verbindung bleibt bis zur Antwort offen; der Server haelt die Anfrage,
  # solange sich die Liste nicht aendert. ulimit: eine Antwort ueber 32 KiB
  # bricht ab, statt den RAM zu fuellen. Kein Proxy, auch nicht aus der Umgebung.
  (
    ulimit -f 64
    exec uclient-fetch -q --no-proxy -T "$2" -O "$antwort" \
      "http://$SERVER:$PORT/v1/schluessel?warte=$1&stand=$kennung"
  ) >/dev/null 2>&1 8>&- &
  kind=$!
  wait "$kind"
  rc=$?
  kind=""
  if [ "$rc" -ne 0 ] || [ ! -f "$antwort" ]; then
    grund="keine Antwort von $SERVER:$PORT (Schluesselausgabe aus, kein frischer Stand oder Anfrage abgeloest)"
    rm -f "$antwort"
    return 1
  fi
  if [ "$(wc -c <"$antwort")" -ge "$MAX_BYTES" ]; then
    grund="Antwort verworfen (zu gross)"
    rm -f "$antwort"
    return 1
  fi
  mit_sperre uebernimm "$antwort"
  case "$?" in
    0) ;;
    2) grund="Antwort verworfen (Form) - nichts uebernommen"; rm -f "$antwort"; return 1 ;;
    *) grund="Antwort nicht uebernommen (Sperre oder Schluesseldatei)"; rm -f "$antwort"; return 1 ;;
  esac
  kennung="$(awk 'NR == 1 { print $3 }' "$antwort")"
  rm -f "$antwort"
  grund=""
}

# wartezeit: so lange haelt die naechste Anfrage am Server - nicht laenger
# als bis kurz vor die naechste Frist (das Fenster kann verlaengert worden sein).
wartezeit() {
  jetzt="$(laufzeit)"
  ganzzahl "$jetzt" || { echo 0; return; }
  gueltig "$jetzt" | awk -v jetzt="$jetzt" -v m="$WARTE" -v v="$VORLAUF" '
    { d = $1 - jetzt - v; if (d < 0) d = 0; if (d < m) m = d }
    END { print m }'
}

# schlafe <s>: unterbrechbar (procd beendet den Dauerlauf mit SIGTERM).
schlafe() {
  sleep "$1" 8>&- &
  kind=$!
  wait "$kind"
  kind=""
}

mkdir -p "$DIR" && chmod 700 "$DIR" || exit 1

case "$ART" in
  frist)
    # Auch ohne Sperre: haengt der Dauerlauf, streicht dieser Lauf trotzdem.
    mit_sperre schreibe
    rc=$?
    [ "$rc" -ne 75 ] || schreibe
    ;;
  einmal | lauf)
    case "$SERVER" in *[!0-9.]* | "") echo "FEHLER: Server \"$SERVER\" ist keine IPv4-Adresse" >&2; exit 2 ;; esac
    case "$IFACE" in *[!a-z0-9_]* | "") echo "FEHLER: Schnittstelle \"$IFACE\"" >&2; exit 2 ;; esac
    ganzzahl "$PORT" && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || { echo "FEHLER: Port \"$PORT\"" >&2; exit 2; }
    ganzzahl "$WARTE" || WARTE=45
    [ "$WARTE" -ge 5 ] || WARTE=5
    [ "$WARTE" -le 300 ] || WARTE=300 # mehr laesst der Server nicht zu
    if ! tmpfs_da; then
      # Ohne das tmpfs kaemen Fenster-Schluessel in den Flash und ueberlebten einen Neustart.
      melde "FEHLER: $KEYDIR ist kein tmpfs - keine Fenster-Schluessel"
      echo "FEHLER: $KEYDIR ist kein tmpfs" >&2
      exit 1
    fi
    trap '[ -z "$kind" ] || kill "$kind" 2>/dev/null; exit 0' TERM INT
    if [ "$ART" = einmal ]; then
      frage 0 10
      rc=$?
      mit_sperre schreibe
      [ "$rc" -eq 0 ] || echo "$grund" >&2
      exit "$rc"
    fi
    # Genau ein Dauerlauf: zwei loesten einander am Server staendig ab.
    exec 8>"$DIR/lauf.sperre"
    flock -n 8 || { melde "Dauerlauf laeuft schon - dieser endet"; exit 1; }
    zustand="start"
    while :; do
      mit_sperre schreibe
      w="$(wartezeit)"
      if frage "$w" "$((w + 15))"; then
        [ "$zustand" = ok ] || melde "Wartungsserver antwortet ($SERVER:$PORT ueber $IFACE)"
        zustand=ok
        rm -f "$DIR/grund"
        # Kurz vor einer Frist antwortet der Server sofort: nicht im Kreis fragen.
        [ "$w" -gt 0 ] || schlafe 2
      else
        # Keine gueltige Antwort: nichts dazu, das Vorhandene verfaellt zur Frist.
        [ "$zustand" = "$grund" ] || melde "$grund"
        zustand="$grund"
        echo "$grund" >"$DIR/grund"
        schlafe 5
      fi
    done
    ;;
  status)
    jetzt="$(laufzeit)"
    if pgrep -f 'schluessel-holen.sh lauf' >/dev/null 2>&1; then lauf="laeuft"; else lauf="laeuft NICHT"; fi
    echo "Fenster-Schluessel: Abholer $lauf, Server $SERVER:$PORT ueber $IFACE"
    if [ -s "$DIR/zuletzt" ] && ganzzahl "$jetzt"; then
      echo "  letzte gueltige Antwort des Wartungsservers: vor $((jetzt - $(cat "$DIR/zuletzt"))) s"
    else
      echo "  letzte gueltige Antwort des Wartungsservers: seit dem Start keine"
    fi
    [ ! -s "$DIR/grund" ] || echo "  zuletzt ohne Antwort: $(cat "$DIR/grund")"
    if tmpfs_da; then echo "  Schluesseldatei im RAM (tmpfs $KEYDIR): ja"; else echo "  Schluesseldatei im RAM (tmpfs $KEYDIR): NEIN - keine Fenster-Schluessel"; fi
    n="$(grep -c -E '(^| )(ssh-|ecdsa-)' "$DAUER" 2>/dev/null)"
    echo "  dauerhaft aus $DAUER: ${n:-0} Schluessel (gelten im Tunnel weiter)"
    if ganzzahl "$jetzt" && [ -n "$(gueltig "$jetzt")" ]; then
      gueltig "$jetzt" | awk -v jetzt="$jetzt" '{ print "  im Fenster: Zugang " $2 ", noch " ($1 - jetzt) " s" }'
    else
      echo "  im Fenster: keine"
    fi
    ;;
  *)
    echo "lauf | frist | einmal | status" >&2
    exit 2
    ;;
esac
