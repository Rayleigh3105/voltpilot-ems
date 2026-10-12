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
#                               und Restlaufzeit; dazu die letzten Ereignisse
#   schluessel-holen.sh ereignisse  die ganze Ereignisliste
#
# Regeln:
#   - Gefragt wird nur ueber den Wartungstunnel: die Route zum Server muss ueber
#     die Tunnel-Schnittstelle fuehren (und die Firewall der Box weist die
#     Anfrage auf jedem anderen Weg ab, service-tunnel.sh). WireGuard belegt,
#     dass der Server es ist; die Box ist an ihrer Tunnel-Adresse erkannt.
#   - Alles liegt im RAM: der Arbeitsstand unter /tmp, die Schluesseldatei in
#     einem eigenen tmpfs. Ein Neustart loescht jeden Fenster-Schluessel. (Nicht
#     unter /tmp: Dropbear prueft jedes Elternverzeichnis, und /tmp ist fuer
#     alle schreibbar.) Ohne das tmpfs schreibt das Skript nichts. Einzige
#     Ausnahme ist die Ereignisliste (unten): sie liegt im Flash und nennt nie
#     einen Schluessel.
#   - Jeder Schluessel hat eine Frist in LAUFZEIT der Box (/proc/uptime), nicht
#     in Uhrzeit: eine falsche oder springende Uhr verlaengert nichts.
#   - Nur eine vollstaendige, formgerechte Antwort gilt, und sie ist die ganze
#     Liste: was sie nicht mehr nennt, ist sofort gestrichen. Kommt keine
#     gueltige Antwort, kommt nichts dazu; was da ist, verfaellt zur Frist.
#   - /etc/dropbear/authorized_keys (dauerhafte Schluessel, Anmeldung im LAN)
#     wird nur GELESEN und gilt im Tunnel weiter.
#   - Wird ein Fenster-Schluessel gestrichen (neue Liste, Frist, cron-Lauf),
#     enden die Sitzungen, die mit genau diesem Schluessel begonnen wurden -
#     so, wie sie nach einem Verbindungsabbruch enden: der Anmeldeprozess von
#     Dropbear bekommt SIGTERM. Sitzungen mit einem dauerhaften oder einem
#     anderen, noch gueltigen Fenster-Schluessel bleiben.
#   - Welche Sitzung zu welchem Schluessel gehoert, steht in keinem Protokoll:
#     jede Zeile der Schluesseldatei traegt hinter dem Schluessel eine Marke
#     (vpf-<kennzahl> Fenster, vpd-<kennzahl> dauerhaft), und Dropbear gibt sie
#     den Prozessen der Sitzung als SSH_PUBKEYINFO mit. Gelesen wird sie aus
#     /proc; das uebersteht einen Neustart des Abholers und des Lauschers.
#   - Im Zweifel endet die Sitzung: laesst sie sich keinem Schluessel zuordnen,
#     der jetzt in der Schluesseldatei steht (nur Weiterleitung ohne Prozess,
#     begonnen vor diesem Skript, dauerhafte Zeile mit Optionen davor), endet
#     sie beim naechsten Streichen ebenfalls. Mit einem gueltigen Schluessel
#     meldet sie sich sofort wieder an.
#   - Ereignisliste (/etc/vp-wartung/ereignisse): was an dieser Box ueber die
#     Fernwartung geschah, laenger nachlesbar als im Protokollspeicher der Box
#     (logread: 128 KiB im RAM, laeuft ueber und ist nach einem Neustart leer).
#     Der cron-Lauf uebernimmt jede Minute aus den letzten 200 Zeilen des
#     Protokollspeichers, was neu ist, und nur das: wann welcher
#     Fenster-Schluessel kam und ging (Zugang),
#     jede Anmeldung durch einen Wartungstunnel (Fingerabdruck des Schluessels,
#     Absender, Zeit), jedes Ende einer solchen Sitzung mit Grund, und welche
#     Sitzung die Box beendet hat. Nie ein Schluessel. Geschrieben wird nur,
#     wenn ein Ereignis dazukam - ohne Fernwartung schreibt die Box nichts in
#     den Flash. Hoechstens 250 Zeilen zu hoechstens 400 Zeichen; darueber
#     bleiben die neuesten 200. Die Liste uebersteht Neustart und sysupgrade;
#     das Abraeumen der Fenster-Schluessel loescht sie.
#   - Gelesen wird nie der ganze Protokollspeicher, immer nur sein Ende: zwei
#     Leser, die ihn zugleich ganz lesen, lassen den Protokolldienst der Box
#     neu starten, und dann ist alles weg (OpenWrt 25.12.5 im Container: 98 von
#     100 Versuchen; mit einem Leser von hoechstens 300 Zeilen daneben keiner).
#     Schreibt die Box in einer Minute mehr als 200 Zeilen, kann der Liste
#     deshalb ein Ereignis fehlen.
#   - cron protokolliert die Starts seiner Zeitauftraege nicht mehr
#     (service-tunnel.sh stellt cronloglevel auf 9). Dafuer legt jeder Lauf
#     "frist" ein Lebenszeichen ab, und der Dauerlauf meldet, wenn es ausbleibt.
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
# Liegt, solange nach einem gestrichenen Schluessel noch Sitzungen zu beenden
# sind: bricht ein Lauf dazwischen ab, fuehrt der naechste den Auftrag aus.
BEENDEN="$DIR/beenden"
PIDDATEI="${VP_WARTUNG_PIDDATEI:-/var/run/dropbear.vp_wartung.pid}"
# Die Ereignisliste liegt als Einziges im Flash: neben dem Einhaengepunkt der
# Schluesseldatei, nicht darin.
EREIGNISSE="${VP_WARTUNG_EREIGNISSE:-/etc/vp-wartung/ereignisse}"
EREIGNISSE_MAX=250     # mehr Zeilen hat die Liste nie
EREIGNISSE_BLEIBEN=200 # so viele bleiben, wenn sie gekuerzt wird
EREIGNIS_BREITE=400    # laengere Zeilen werden abgeschnitten
EREIGNISSE_FENSTER=200 # so viele Zeilen vom Ende des Protokollspeichers liest ein Lauf
# Lebenszeichen des cron-Laufs (Laufzeit der Box beim letzten Lauf "frist").
FRIST_ZULETZT="$DIR/frist"
CRON_AUS=180           # so viele Sekunden ohne Lauf, dann meldet es der Dauerlauf
MARKEN=""      # Kennzahlen der Schluessel, die jetzt in der Schluesseldatei stehen
streichen=nein # ja: dieser Lauf hat einen Fenster-Schluessel gestrichen
NL='
'

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

# kennzahl <schluessel-base64>: 32 Hex-Zeichen, die den Schluessel benennen.
# Wer die Rechnung aendert, beendet beim ersten Lauf die Sitzungen aller
# Fenster-Schluessel: ihre alte Marke steht dann nicht mehr in der Datei.
kennzahl() { printf '%s' "$1" | sha256sum 2>/dev/null | cut -c 1-32; }
ist_kennzahl() {
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
  [ "${#1}" -eq 32 ]
}

# zeilen_dauerhaft: die dauerhaften Schluessel, wie sie in die Schluesseldatei
# kommen. Eine Zeile in der einfachen Form "<art> <schluessel> [kommentar]"
# bekommt die Marke vpd-<kennzahl> als erstes Wort hinter dem Schluessel - nur
# das gibt Dropbear als SSH_PUBKEYINFO weiter. Jede andere Zeile (Optionen
# davor, Kommentarzeile) bleibt, wie sie ist: sie gilt weiter, ihre Sitzungen
# sind aber nicht zuzuordnen.
zeilen_dauerhaft() {
  [ -r "$DAUER" ] || return 0
  awk '
    function kennzahl(k,    c, h) {
      c = "printf %s \047" k "\047 | sha256sum"
      h = ""
      c | getline h
      close(c)
      return substr(h, 1, 32)
    }
    /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp(256|384|521)) AAAA[A-Za-z0-9+\/]+=*( |$)/ {
      h = kennzahl($2)
      if (length(h) == 32 && h ~ /^[0-9a-f]+$/) {
        print $1 " " $2 " vpd-" h substr($0, length($1) + length($2) + 2)
        next
      }
    }
    { print }
  ' "$DAUER"
}

# zeilen_fenster <laufzeit>: die Fenster-Schluessel, deren Frist noch laeuft,
# mit der Marke vpf-<kennzahl>.
zeilen_fenster() {
  gueltig "$1" | while read -r _ zf_zugang zf_k; do
    zf_m="$(kennzahl "$zf_k")"
    if ist_kennzahl "$zf_m"; then
      echo "ssh-rsa $zf_k vpf-$zf_m vp-fenster:$zf_zugang"
    else
      # Ohne Marke gilt der Schluessel trotzdem; seine Sitzungen sind dann
      # nicht zuzuordnen und enden beim naechsten Streichen.
      echo "ssh-rsa $zf_k vp-fenster:$zf_zugang"
    fi
  done
}

# marken: aus Zeilen einer Schluesseldatei (stdin) die Kennzahlen.
marken() { sed -n 's/^[a-z0-9-]* [A-Za-z0-9+\/=]* vp[df]-\([0-9a-f]\{32\}\)\( .*\)\{0,1\}$/\1/p'; }
# fenster_in: aus Zeilen einer Schluesseldatei (stdin) die Fenster-Schluessel,
# auch in der Form vor den Marken.
fenster_in() { sed -n 's/^ssh-rsa \([^ ]*\) \(vpf-[0-9a-f]* \)\{0,1\}vp-fenster:[^ ]*$/\1/p'; }

# schluesseldatei: die Schluesseldatei aus $s_dauer und $s_fenster neu
# zusammensetzen. Laesst sie sich nicht vollstaendig schreiben, bleibt keine
# alte Fassung stehen: lieber keine Anmeldung als eine mit einem verfallenen
# Schluessel. Rueckgabe 1, wenn danach keine Datei steht.
schluesseldatei() {
  tmpfs_da || return 1
  neu="$KEYS.neu.$$"
  {
    [ -z "$s_dauer" ] || printf '%s\n' "$s_dauer"
    [ -z "$s_fenster" ] || printf '%s\n' "$s_fenster"
    echo "$ENDE"
  } >"$neu" 2>/dev/null
  if [ "$(tail -n 1 "$neu" 2>/dev/null)" != "$ENDE" ] || ! chmod 600 "$neu"; then
    rm -f "$neu" "$KEYS"
    melde "FEHLER: Schluesseldatei nicht schreibbar - keine Anmeldung im Tunnel, bis es wieder geht"
    return 1
  fi
  if cmp -s "$neu" "$KEYS" 2>/dev/null; then
    rm -f "$neu"
    return 0
  fi
  # Faellt ein Fenster-Schluessel weg? Der Auftrag, seine Sitzungen zu beenden,
  # liegt, BEVOR die Datei getauscht wird.
  sd_weg="$({
    printf '%s\n' "$s_fenster" | fenster_in | sed 's/^/n /'
    fenster_in <"$KEYS" 2>/dev/null | sed 's/^/a /'
  } | awk '$1 == "n" { n[$2] = 1 } $1 == "a" && !($2 in n) { w++ } END { print w + 0 }')"
  if [ "$sd_weg" != 0 ]; then
    streichen=ja
    : >"$BEENDEN" 2>/dev/null
  fi
  if mv -f "$neu" "$KEYS"; then
    zugaenge="$(sed -n 's/^ssh-rsa [^ ]* \(vpf-[0-9a-f]* \)\{0,1\}vp-fenster://p' "$KEYS" | tr '\n' ' ')"
    melde "Fenster-Schluessel jetzt: ${zugaenge:-keine}"
  else
    rm -f "$neu" "$KEYS"
    melde "FEHLER: Schluesseldatei nicht ersetzbar - keine Anmeldung im Tunnel, bis es wieder geht"
    return 1
  fi
}

# sitzungen: die Anmeldeprozesse der Wartungs-Instanz - jeder Dropbear mit
# dieser Schluesseldatei (-D) ausser dem Lauscher. Dazu gehoeren die Kinder
# eines frueheren Lauschers: sie ueberleben dessen Neustart.
sitzungen() {
  si_alle="$(pgrep -f "dropbear .*-D $KEYDIR( |\$)" 2>/dev/null)"
  [ -n "$si_alle" ] || return 0
  si_lauscher="$(ubus -t 3 call service list '{"name":"vp-wartung"}' 2>/dev/null | jsonfilter -e '@["vp-wartung"].instances.ssh.pid' 2>/dev/null)"
  [ -n "$si_lauscher" ] || si_lauscher="$(cat "$PIDDATEI" 2>/dev/null)"
  for si_p in $si_alle; do
    [ "$si_p" != "$si_lauscher" ] || continue
    si_cmd="$(tr '\0' ' ' <"/proc/$si_p/cmdline" 2>/dev/null)"
    case "$si_cmd" in dropbear\ * | */dropbear\ *) ;; *) continue ;; esac
    case "$si_cmd" in *" -D $KEYDIR "*) echo "$si_p" ;; esac
  done
}

# urteil <pid>: zu welchem Schluessel gehoert die Sitzung? Gelesen wird die
# Marke, die Dropbear den Prozessen direkt unter dem Anmeldeprozess mitgibt.
#   dauerhaft, fenster  ein Schluessel, der jetzt in der Schluesseldatei steht
#   gestrichen          ein Fenster-Schluessel, der dort nicht mehr steht
#   unbekannt           nicht zuzuordnen: kein Prozess unter der Anmeldung (nur
#                       Weiterleitung, mitten im Anmelden) oder einer ohne Marke
urteil() {
  u_erg=""
  for u_k in $(pgrep -P "$1" 2>/dev/null); do
    # Zeilenumbrueche in Werten zu Leerzeichen: sonst koennte ein Wert (TERM
    # kommt vom Techniker) eine eigene Zeile SSH_PUBKEYINFO vortaeuschen.
    u_m="$(tr '\n\0' ' \n' <"/proc/$u_k/environ" 2>/dev/null | sed -n 's/^SSH_PUBKEYINFO=//p')"
    u_art=unbekannt
    if ist_kennzahl "${u_m#vp?-}"; then
      case "$NL$MARKEN$NL" in
        *"$NL${u_m#vp?-}$NL"*) case "$u_m" in vpd-*) u_art=dauerhaft ;; vpf-*) u_art=fenster ;; esac ;;
        *) case "$u_m" in vpf-*) u_art=gestrichen ;; esac ;;
      esac
    fi
    case "$u_art:$u_erg" in
      gestrichen:*) u_erg=gestrichen; break ;;
      unbekannt:* | *:unbekannt) u_erg=unbekannt ;;
      fenster:*) u_erg=fenster ;;
      dauerhaft:"") u_erg=dauerhaft ;;
    esac
  done
  echo "${u_erg:-unbekannt}"
}

startzeit() { awk '{ print $22 }' "/proc/$1/stat" 2>/dev/null; }
# ahnen: die Prozesse, unter denen dieser Lauf selbst haengt.
ahnen() {
  a_p=$$
  a_l=" "
  while [ -n "$a_p" ] && [ "$a_p" -gt 1 ] 2>/dev/null; do
    a_l="$a_l$a_p "
    a_p="$(awk '/^PPid:/ { print $2 }' "/proc/$a_p/status" 2>/dev/null)"
  done
  echo "$a_l"
}

# beende_sitzungen: beendet die Sitzungen gestrichener Fenster-Schluessel -
# bei jedem Lauf, nicht nur im Augenblick des Streichens. Nach einem Streichen
# (Auftrag) auch jede, die sich nicht zuordnen laesst. Beendet wird der
# Anmeldeprozess von Dropbear, wie bei einem Verbindungsabbruch: ein Terminal
# bekommt SIGHUP, ein Befehl ohne Terminal laeuft zu Ende oder scheitert an der
# naechsten Ausgabe.
beende_sitzungen() {
  b_auftrag=nein
  if [ "$streichen" = ja ] || [ -e "$BEENDEN" ]; then b_auftrag=ja; fi
  b_ahnen=""
  b_weg=""
  b_bleibt=nein
  for b_p in $(sitzungen); do
    case "$(urteil "$b_p")" in
      gestrichen) b_grund="ihr Fenster-Schluessel ist gestrichen" ;;
      unbekannt)
        [ "$b_auftrag" = ja ] || continue
        b_grund="keinem gueltigen Schluessel zuzuordnen, und ein Fenster-Schluessel wurde gestrichen"
        ;;
      *) continue ;;
    esac
    # Haengt dieser Lauf selbst an der Sitzung (von Hand, Einrichten durch den
    # Tunnel), beendet er sie nicht: er braeche mittendrin ab. Der Auftrag
    # bleibt liegen, der naechste Lauf von Abholer oder cron fuehrt ihn aus.
    [ -n "$b_ahnen" ] || b_ahnen="$(ahnen)"
    case "$b_ahnen" in *" $b_p "*) b_bleibt=ja; continue ;; esac
    b_start="$(startzeit "$b_p")"
    [ -n "$b_start" ] || continue
    if kill -TERM "$b_p" 2>/dev/null; then
      b_weg="$b_weg $b_p:$b_start"
      melde "Sitzung beendet (Dropbear-Prozess $b_p): $b_grund"
    fi
  done
  # Wer auf SIGTERM nicht hoert, bekommt SIGKILL.
  b_n=0
  while [ -n "$b_weg" ] && [ "$b_n" -lt 3 ]; do
    sleep 1
    b_n=$((b_n + 1))
    b_rest=""
    for b_e in $b_weg; do
      [ "$(startzeit "${b_e%%:*}")" != "${b_e#*:}" ] || b_rest="$b_rest $b_e"
    done
    b_weg="$b_rest"
  done
  for b_e in $b_weg; do
    kill -KILL "${b_e%%:*}" 2>/dev/null && melde "Sitzung mit SIGKILL beendet (Dropbear-Prozess ${b_e%%:*})"
  done
  if [ "$b_bleibt" = ja ] && [ "$b_auftrag" = ja ]; then
    : >"$BEENDEN" 2>/dev/null
  else
    rm -f "$BEENDEN"
  fi
  return 0
}

# schreibe: Verfallenes streichen, die Schluesseldatei neu zusammensetzen und
# die Sitzungen beenden, deren Fenster-Schluessel nicht mehr darin steht.
schreibe() {
  jetzt="$(laufzeit)"
  s_dauer="$(zeilen_dauerhaft 2>/dev/null)"
  s_fenster=""
  # Ohne lesbare Laufzeit gilt kein Fenster-Schluessel.
  if ganzzahl "$jetzt"; then s_fenster="$(zeilen_fenster "$jetzt")"; fi
  s_rc=0
  if ! schluesseldatei; then
    # Ohne Schluesseldatei meldet sich niemand an; kein Fenster-Schluessel gilt.
    s_rc=1
    s_fenster=""
    streichen=ja
    : >"$BEENDEN" 2>/dev/null
  fi
  # Nur Ordnung im Stand; die Schluesseldatei haengt nicht daran.
  if ganzzahl "$jetzt" && [ -f "$STAND" ]; then
    gueltig "$jetzt" >"$STAND.neu.$$" 2>/dev/null && mv -f "$STAND.neu.$$" "$STAND"
    rm -f "$STAND.neu.$$"
  fi
  MARKEN="$(printf '%s\n%s\n' "$s_dauer" "$s_fenster" | marken)"
  beende_sitzungen
  return "$s_rc"
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

# tunnel_netze: aus welchen Netzen eine Anmeldung durch einen Wartungstunnel
# kommt - die erlaubten Absender (allowed_ips) aller Tunnel der Zone service.
# WireGuard nimmt einen Absender aus diesen Netzen nur durch den Tunnel an; an
# derselben Eigenschaft haengt die Freigabe der Web-App (service-tunnel.sh).
tunnel_netze() {
  if [ -n "${VP_WARTUNG_NETZE:-}" ]; then
    echo "$VP_WARTUNG_NETZE"
    return 0
  fi
  tn_alle="$(uci -q get firewall.vp_service.network 2>/dev/null)"
  for tn_t in ${tn_alle:-$IFACE}; do
    uci -q get "network.${tn_t}_peer.allowed_ips" 2>/dev/null
  done | tr '\n' ' '
}

# ereignisse_neu: aus dem Ende des Protokollspeichers der Box (stdin: logread)
# die Zeilen der Fernwartung, die noch nicht in der Liste stehen - alles nach
# ihrer letzten Zeile ($LETZTE). Steht die nicht mehr darin (seither kamen
# mehr Zeilen, als gelesen werden, oder die Box wurde neu gestartet), ist alles
# Gelesene neu. Genommen wird nur, was hier steht; eine Zeile mit einem
# Schluessel nie.
ereignisse_neu() {
  awk -v netze="$(tunnel_netze)" -v breite="$EREIGNIS_BREITE" '
    function zahl(s,    a, i, z) {
      if (split(s, a, ".") != 4) return -1
      z = 0
      for (i = 1; i <= 4; i++) {
        if (a[i] !~ /^[0-9]+$/ || a[i] + 0 > 255) return -1
        z = z * 256 + a[i]
      }
      return z
    }
    # im_tunnel <adresse:port>: kommt der Absender aus einem Tunnel-Netz?
    function im_tunnel(h,    z, i) {
      sub(/:[0-9]+$/, "", h)
      z = zahl(h)
      if (z < 0) return 0
      for (i = 1; i <= nn; i++) if (int(z / gr[i]) == int(ba[i] / gr[i])) return 1
      return 0
    }
    BEGIN {
      letzte = ENVIRON["LETZTE"]
      m = split(netze, t, /[ ,]+/)
      for (i = 1; i <= m; i++) {
        if (split(t[i], p, "/") != 2 || p[2] !~ /^[0-9]+$/ || p[2] + 0 > 32) continue
        b = zahl(p[1])
        if (b < 0) continue
        nn++
        ba[nn] = b
        gr[nn] = 2 ^ (32 - p[2])
      }
    }
    { nimm = 0 }
    # Der Abholer: Fenster-Schluessel kam oder ging, Sitzung beendet.
    $7 == "vp-wartung:" && (($8 == "Fenster-Schluessel" && $9 == "jetzt:") || $8 == "Sitzung") { nimm = 1 }
    # Dropbear: Anmeldung und Ende einer Sitzung, nur aus einem Tunnel-Netz.
    $7 ~ /^dropbear\[[0-9]+\]:$/ {
      if ($8 == "Pubkey" && $9 == "auth" && $10 == "succeeded") {
        nimm = im_tunnel($NF)
      } else if ($8 == "Exit" && $9 ~ /^\(/) {
        for (i = 10; i < NF; i++) {
          if ($i != "from") continue
          h = $(i + 1)
          if (h ~ /^<.*>:$/) nimm = im_tunnel(substr(h, 2, length(h) - 3))
          break
        }
      }
    }
    nimm {
      z = substr($0, 1, breite)
      if (z ~ /AAAA(B3NzaC1|C3NzaC1|E2VjZHNh)/) next
      n++
      zeile[n] = z
      if (z == letzte) ab = n
    }
    END { for (i = ab + 1; i <= n; i++) print zeile[i] }
  '
}

# ereignisse_lesen: die Liste um das Neue ergaenzen. Schreibt nur, wenn etwas
# dazukam, und haelt die Obergrenze VOR dem Schreiben ein: passt das Neue nicht
# mehr, ersetzt eine gekuerzte Fassung die Liste in einem Zug - oder es bleibt
# beim Alten (Flash voll), und der naechste Lauf versucht es wieder. Immer nur
# einer; laeuft schon einer, tut dieser nichts. logread bekommt 5 s: es wartet
# ohne Ende, solange der Protokolldienst der Box fehlt, und daran darf weder
# eine Anzeige noch der naechste Lauf haengen.
ereignisse_lesen() {
  [ -d "${EREIGNISSE%/*}" ] || return 0
  command -v logread >/dev/null 2>&1 || return 0
  (
    flock -n 7 || exit 0
    umask 077
    el_roh="$DIR/ereignisse.roh"
    logread -l "$EREIGNISSE_FENSTER" >"$el_roh" 2>/dev/null 7>&- &
    el_p=$!
    (
      sleep 5
      kill "$el_p" 2>/dev/null
    ) </dev/null >/dev/null 2>&1 7>&- &
    el_w=$!
    wait "$el_p"
    el_rc=$?
    kill "$el_w" 2>/dev/null
    el_neu=""
    [ "$el_rc" -ne 0 ] || el_neu="$(LETZTE="$(tail -n 1 "$EREIGNISSE" 2>/dev/null)" ereignisse_neu <"$el_roh")"
    rm -f "$el_roh"
    [ -n "$el_neu" ] || exit 0
    el_alt="$({ wc -l <"$EREIGNISSE"; } 2>/dev/null)"
    ganzzahl "$el_alt" || el_alt=0
    el_dazu="$(printf '%s\n' "$el_neu" | wc -l)"
    if [ "$((el_alt + el_dazu))" -le "$EREIGNISSE_MAX" ]; then
      printf '%s\n' "$el_neu" >>"$EREIGNISSE" 2>/dev/null
    elif { cat "$EREIGNISSE" 2>/dev/null; printf '%s\n' "$el_neu"; } | tail -n "$EREIGNISSE_BLEIBEN" >"$EREIGNISSE.neu" 2>/dev/null; then
      mv -f "$EREIGNISSE.neu" "$EREIGNISSE" 2>/dev/null
    fi
    rm -f "$EREIGNISSE.neu"
    exit 0
  ) 7>"$DIR/ereignisse.sperre" 8>&- 2>/dev/null
}

# ereignisse_zeigen [anzahl]: die Liste, ohne die Spalte der Protokollstufe;
# mit einer Anzahl nur die letzten Zeilen.
ereignisse_zeigen() {
  [ -s "$EREIGNISSE" ] || return 0
  if [ -n "${1:-}" ]; then tail -n "$1" "$EREIGNISSE"; else cat "$EREIGNISSE"; fi |
    sed 's/^\(.\{24\}\) [a-z0-9]*\.[a-z]* /\1 /'
}

# cron_pruefen: kommt der cron-Lauf noch? cron selbst sagt es nicht mehr (es
# protokolliert weder den Start eines Zeitauftrags noch, dass der vorige noch
# laeuft). Gemeldet wird der Wechsel, nicht jeder Durchgang.
cron_stand=ok
cron_seit=""
cron_pruefen() {
  cp_jetzt="$(laufzeit)"
  ganzzahl "$cp_jetzt" || return 0
  cp_z="$(cat "$FRIST_ZULETZT" 2>/dev/null)"
  ganzzahl "$cp_z" || cp_z="$cron_seit"
  ganzzahl "$cp_z" || return 0
  if [ "$((cp_jetzt - cp_z))" -gt "$CRON_AUS" ]; then
    [ "$cron_stand" = aus ] || melde "FEHLER: der cron-Lauf (frist) ist seit $((cp_jetzt - cp_z)) s ausgeblieben - Verfallenes streicht nur noch der Abholer (pruefen: /etc/crontabs/root, /etc/init.d/cron)"
    cron_stand=aus
  else
    [ "$cron_stand" != aus ] || melde "der cron-Lauf (frist) kommt wieder"
    cron_stand=ok
  fi
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
    # Lebenszeichen fuer den Dauerlauf, dann im Hintergrund die Ereignisliste:
    # an ihr haengt weder dieser Lauf noch der Start der Anmelde-Instanz.
    laufzeit >"$FRIST_ZULETZT" 2>/dev/null
    ereignisse_lesen </dev/null >/dev/null 2>&1 &
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
    cron_seit="$(laufzeit)"
    while :; do
      mit_sperre schreibe
      cron_pruefen
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
    # Wer gerade angemeldet ist, und mit welcher Art von Schluessel.
    MARKEN="$(marken <"$KEYS" 2>/dev/null)"
    st_d=0
    st_f=0
    st_g=0
    st_u=0
    for st_p in $(sitzungen); do
      case "$(urteil "$st_p")" in
        dauerhaft) st_d=$((st_d + 1)) ;;
        fenster) st_f=$((st_f + 1)) ;;
        gestrichen) st_g=$((st_g + 1)) ;;
        *) st_u=$((st_u + 1)) ;;
      esac
    done
    echo "  Sitzungen im Tunnel: $((st_d + st_f + st_g + st_u)) - dauerhafter Schluessel $st_d, Fenster-Schluessel $st_f, gestrichener Fenster-Schluessel $st_g, nicht zuzuordnen $st_u"
    echo "    (gestrichen: endet beim naechsten Lauf; nicht zuzuordnen: endet, sobald ein Fenster-Schluessel gestrichen wird)"
    st_c="$(cat "$FRIST_ZULETZT" 2>/dev/null)"
    if ! ganzzahl "$st_c" || ! ganzzahl "$jetzt"; then
      echo "  cron-Lauf (streicht Verfallenes, jede Minute): seit dem Start keiner"
    elif [ "$((jetzt - st_c))" -gt "$CRON_AUS" ]; then
      echo "  cron-Lauf (streicht Verfallenes, jede Minute): AUSGEBLIEBEN seit $((jetzt - st_c)) s - /etc/crontabs/root und /etc/init.d/cron pruefen"
    else
      echo "  cron-Lauf (streicht Verfallenes, jede Minute): zuletzt vor $((jetzt - st_c)) s"
    fi
    # Was zuletzt geschah - auch dann, wenn es im Protokollspeicher der Box
    # (logread) laengst ueberschrieben ist.
    ereignisse_lesen
    st_e="$({ wc -l <"$EREIGNISSE"; } 2>/dev/null)"
    if ganzzahl "$st_e" && [ "$st_e" -gt 0 ]; then
      echo "  Ereignisse der Fernwartung: $st_e in $EREIGNISSE (Flash, hoechstens $EREIGNISSE_MAX, nie ein Schluessel) - die letzten:"
      ereignisse_zeigen 10 | sed 's/^/    /'
      echo "    (alle: $0 ereignisse)"
    else
      echo "  Ereignisse der Fernwartung: noch keine in $EREIGNISSE"
    fi
    ;;
  ereignisse)
    ereignisse_lesen
    ereignisse_zeigen
    ;;
  *)
    echo "lauf | frist | einmal | status | ereignisse" >&2
    exit 2
    ;;
esac
