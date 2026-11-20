#!/bin/sh
# Edge Industrie - Loader fuer den WAGO PFC200 (750-8212, ARMv7, WAGO-Firmware mit
# BusyBox-Init). Die Fassung des Mango-Loaders
# (edge-light/openwrt/files/usr/libexec/vp-edge-light/boot.sh) fuer ein Linux
# ohne UCI, procd und jsonfilter.
#
# DASSELBE PROTOKOLL wie auf der Mango (edge-app/core/internal/otalight,
# edge-light/docs/boot-und-updates.md): Das Programm laeuft aus dem RAM, der
# Loader entpackt bei jedem Start die BESTAETIGTE Fassung aus dem Flash
# (local_dir, gzip, eine Fassung, mit Pruefsumme), prueft sie und startet sie.
# Ein Update legt das laufende Programm als Kandidat in den RAM und beendet
# sich; dieser Loader tauscht, wacht ueber die Probe (10 min, 3 Abstuerze),
# behaelt oder nimmt zurueck. Die Funktionen des Protokolls (versuch, zurueck,
# behalten, probestart, tauschen, probe_pruefen, waechter, ...) sind
# ZEICHENGLEICH mit dem Mango-Loader; edge-light/scripts/test.sh vergleicht
# sie und die Marke ABGLEICH_MANGO_STAND unten.
#
# Was hier anders ist (die Plattform):
#   - Einstellungen aus /home/voltpilot/konfig (Zeilen "schluessel = wert")
#     statt UCI. Die Datei wird gelesen, nie ausgefuehrt.
#   - JSON liest ein kleines awk-Programm statt jsonfilter.
#   - Nachladen mit wget oder curl statt uclient-fetch.
#   - Den Neustart nach dem Ende des Programms macht das Dienst-Skript
#     (/etc/init.d/vp-edge-industrie) statt procd.
#   - Der Loader laeuft als Benutzer voltpilot, NIE als root. Das Dienst-Skript
#     legt das RAM-Verzeichnis an, fragt die Bestellnummer des Geraets ab und
#     wechselt den Benutzer. Loader, Dienst-Skript und Einstellungen gehoeren
#     root; das Programm kann sie nicht aendern.
#   - Der Seitencache wird nie geraeumt: das trifft auf einer Steuerung auch
#     die SPS-Laufzeit, und ohne Root-Rechte ginge es ohnehin nicht.
#   - Der Modbus-Datenspiegel wird mit Port 1502 angezeigt (auf 502 sitzt der
#     Modbus-Server der SPS); er bleibt ab Werk aus.
#   - Kein Loader-Selbstupdate: das Programm bringt nur den Mango-Loader
#     eingebettet mit. Dieser Loader und das Dienst-Skript aendern sich nur
#     durch edge-industrie/install.sh.
#
# In den Flash schreibt der Loader nur: die Marken (versuche, feste
# Obergrenze, eine Zeile je Schritt), und beim Behalten Pruefsummen + Kopie.
# Was laufend geschrieben wird, liegt im RAM (HOT_DIRS).

# Kein "set -u", wie im Mango-Loader: die gemeinsamen Funktionen lesen
# Angaben, die fehlen duerfen (versuch ohne Grund).

# PFC_LOADER_STAND: die Fassung von Loader UND Dienst-Skript des PFC200. Bei
# jeder Aenderung erhoehen; ins Geraet kommt sie nur ueber install.sh.
# Bewusst NICHT "LOADER_STAND": diese Marke liest das Programm fuer das
# Loader-Selbstupdate der Mango.
PFC_LOADER_STAND=2
# ABGLEICH_MANGO_STAND: der LOADER_STAND des Mango-Loaders, mit dem diese
# Fassung zuletzt abgeglichen wurde. Hebt die Mango ihren Stand, schlaegt
# edge-light/scripts/test.sh fehl, bis die Aenderung hier nachgezogen (oder
# als fuer den PFC200 unerheblich befunden) und die Marke gehoben ist.
ABGLEICH_MANGO_STAND=2

PATH="${PATH:+$PATH:}/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

# Die Ausgabe faengt das Dienst-Skript ein und gibt sie an syslog
# (logger -t vp-edge-industrie). Von Hand gestartet steht sie im Terminal.
log() { echo "vp-edge-industrie: $*" >&2; }

if [ "$(id -u)" = 0 ]; then
  log "der Loader laeuft nie als root - starten mit /etc/init.d/vp-edge-industrie start"
  exit 1
fi
log "Loader PFC Stand $PFC_LOADER_STAND (Protokoll wie Mango-Loader Stand $ABGLEICH_MANGO_STAND)"

KONFIG=/home/voltpilot/konfig

# kwert <schluessel> <vorgabe> - der Wert aus der Einstellungsdatei; steht ein
# Schluessel mehrfach da, gilt die letzte Zeile. Fehlt er oder ist er leer,
# gilt die Vorgabe.
kwert() {
  w="$(sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$KONFIG" 2>/dev/null | sed 's/[[:space:]]*$//' | tail -n 1)"
  echo "${w:-$2}"
}
# kliste <schluessel> - alle Werte eines mehrfach erlaubten Schluessels (env).
kliste() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$KONFIG" 2>/dev/null | sed 's/[[:space:]]*$//'; }

ARCH="$(kwert arch arm)"
DATA_DIR="$(kwert data_dir /home/voltpilot/daten)"
RAM_DIR="$(kwert ram_dir /tmp/vp-edge-industrie)"
# programm_dir: wo das entpackte Programm liegt und startet. Vorgabe ist der
# RAM. Traegt /tmp "noexec", setzt install.sh ein Verzeichnis im Flash.
PROG_DIR="$(kwert programm_dir "$RAM_DIR")"
PORTAL="$(kwert portal_url https://portal.voltpilot.de)"
WEB_ADDR="$(kwert web_addr :8484)"
BUS_ADDR="$(kwert bus_addr 127.0.0.1:1883)"
MEMLIMIT="$(kwert gomemlimit 96MiB)"
MIN_FREE_KB="$(kwert min_free_kb 40000)"
PROZESS_RESERVE_KB="$(kwert prozess_reserve_kb 12000)"
LOCAL_DIR="$(kwert local_dir /home/voltpilot/fassung)"
# Wache der Probe (dieselben Zahlen wie Mango und Docker-Box): Frist in s,
# Starts, Probestart-Frist in s, Takt der Wache in s.
PROBE_FRIST="$(kwert probe_frist 600)"
PROBE_STARTS="$(kwert probe_starts 3)"
VERSION_FRIST="$(kwert version_frist 5)"
PROBE_TAKT="$(kwert probe_takt 5)"
# Bei Speichernot trifft der Kernel zuerst das Programm, nie die SPS-Laufzeit.
OOM_ADJ="$(kwert oom_score_adj 800)"

BIN="$PROG_DIR/vp-edge-industrie"
NAME="vp-edge-industrie-linux-$ARCH"
LOCAL_GZ="$LOCAL_DIR/$NAME.gz"
# Zeile 1: sha256 des ENTPACKTEN Programms, Zeile 2: sha256 der gepackten
# Kopie - mit ihr laesst sich genau diese Fassung nachladen. Dazu die Zeile
# "groesse <bytes> <gz_bytes>": aus der Groesse des entpackten Programms leitet
# der Loader seine Speicherschwelle ab.
LOCAL_SUM="$LOCAL_DIR/$NAME.sha256"
OTA_FEST="$DATA_DIR/ota"
OTA_RAM="$RAM_DIR/ota"
VERSUCHE="$OTA_FEST/versuche"
KAND="$OTA_RAM/kandidat.json"
KGZ="$OTA_RAM/kandidat.gz"
PROBE="$OTA_RAM/probe.json"
URTEIL="$OTA_RAM/probe-urteil.json"
VERSUCHE_MAX=40

# VP_LOADER_PROC nur fuer die Proben (edge-industrie/test/*-probe.sh).
PROC="${VP_LOADER_PROC:-/proc}"

if ! mkdir -p "$RAM_DIR" "$DATA_DIR" "$PROG_DIR" 2>/dev/null || [ ! -w "$RAM_DIR" ] || [ ! -w "$DATA_DIR" ] || [ ! -w "$PROG_DIR" ]; then
  log "$RAM_DIR, $DATA_DIR oder $PROG_DIR fehlt oder ist fuer $(id -un) nicht beschreibbar - edge-industrie/install.sh ausfuehren"
  exit 1
fi

# --- Was laufend geschrieben wird, gehoert in den RAM -----------------------
# buffer             Messwert-Puffer (Store-and-forward, alle paar Sekunden)
# measurement-outbox Zusatzmesswerte vor dem Hochladen
# ocpp-journal       OCPP-Ereignisse vor dem Hochladen
# Folge, bewusst: ein STROMAUSFALL verliert noch nicht hochgeladene Messwerte.
# Bei einem Cloud-Ausfall puffert die Box weiter, solange sie laeuft.
HOT_DIRS="buffer measurement-outbox ocpp-journal"
for d in $HOT_DIRS; do
  mkdir -p "$RAM_DIR/$d"
  if [ -L "$DATA_DIR/$d" ]; then
    continue
  fi
  if [ -d "$DATA_DIR/$d" ]; then
    # Bestand aus einem frueheren Lauf behalten, nicht wegwerfen.
    cp -a "$DATA_DIR/$d/." "$RAM_DIR/$d/" 2>/dev/null
    rm -rf "${DATA_DIR:?}/$d"
  fi
  ln -s "$RAM_DIR/$d" "$DATA_DIR/$d"
done
mkdir -p "$OTA_FEST" "$OTA_RAM" || exit 1

# --- Speicher fuer das Programm --------------------------------------------------
# Die Schwelle ist wie auf der Mango der TATSAECHLICHE Bedarf der Fassung:
# Groesse des entpackten Programms plus PROZESS_RESERVE_KB fuer den privaten
# Speicher des Prozesses und das Entpacken. Nur wenn die Groesse unbekannt ist
# (Pruefsummen-Datei ohne groesse-Zeile), gilt die Pauschale MIN_FREE_KB.
# Gemessen wird MemAvailable. Die Zahlen sind die der Mango und fuer den
# PFC200 (512 MB RAM, daneben die SPS-Laufzeit) noch NICHT am Geraet gemessen
# (Pruefstein PS-P6, edge-industrie/README.md).
#
# Anders als auf der Mango raeumt dieser Loader den Seitencache nie: liegt der
# Wert unter der Schwelle, startet er nicht und das Dienst-Skript versucht es
# nach 10 s erneut.

free_kb() { awk '/^MemAvailable:/ {print $2; exit}' "$PROC/meminfo"; }

# bedarf_kb <groesse_bytes> - was Entpacken und Start dieser Fassung brauchen:
# das entpackte Programm liegt im tmpfs, dazu der private Speicher des
# Prozesses und das Entpacken (PROZESS_RESERVE_KB). Ohne bekannte Groesse gilt
# die Pauschale MIN_FREE_KB.
bedarf_kb() {
  case "${1:-}" in
    '' | *[!0-9]* | 0) echo "$MIN_FREE_KB" ;;
    *) echo $(($1 / 1024 + PROZESS_RESERVE_KB)) ;;
  esac
}

# genug_speicher <Folge> [schwelle_kb] - 0, wenn das Programm Platz hat (oder
# der Wert unbekannt ist); sonst Meldung "zu wenig freier Speicher ... -
# <Folge>". Ohne zweite Angabe gilt die Pauschale MIN_FREE_KB. Beide Wege
# nennen den gemessenen Wert.
genug_speicher() {
  schwelle="${2:-$MIN_FREE_KB}"
  avail="$(free_kb)"
  if [ -z "$avail" ] || [ "$avail" -ge "$schwelle" ]; then
    [ -n "$avail" ] && log "genug freier Speicher (${avail} kB >= ${schwelle} kB)"
    return 0
  fi
  log "zu wenig freier Speicher (${avail} kB < ${schwelle} kB) - $1"
  return 1
}

summe() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }
uptime_s() { awk '{printf "%d", $1}' "$PROC/uptime"; }

# jwert <datei> <schluessel> - der Wert eines Schluessels der OBERSTEN Ebene
# einer JSON-Datei (Zeichenkette entschluesselt, Zahl, true/false). Ersetzt
# jsonfilter der Mango fuer die flachen Dateien des Protokolls (kandidat.json,
# probe.json, probe-urteil.json: otalight). Fehlt der Schluessel, ist der Wert
# null, ein Gefuege oder die Datei kein JSON-Objekt, bleibt die Ausgabe leer.
jwert() {
  [ -f "$1" ] || return 1
  awk -v K="$2" '
    function hexwert(s,   i, n, c) {
      n = 0
      s = tolower(s)
      for (i = 1; i <= length(s); i++) {
        c = index("0123456789abcdef", substr(s, i, 1))
        if (c == 0) return -1
        n = n * 16 + c - 1
      }
      return n
    }
    function utf8(cp) {
      if (cp < 0) return "?"
      if (cp < 128) return sprintf("%c", cp)
      if (cp < 2048) return sprintf("%c%c", 192 + int(cp / 64), 128 + cp % 64)
      return sprintf("%c%c%c", 224 + int(cp / 4096), 128 + int(cp / 64) % 64, 128 + cp % 64)
    }
    function leer() { while (P <= N && index(" \t\r\n", substr(T, P, 1)) > 0) P++ }
    function text(   s, c, e) {
      s = ""
      P++
      while (P <= N) {
        c = substr(T, P, 1)
        if (c == "\"") { P++; return s }
        if (c == "\\") {
          e = substr(T, P + 1, 1)
          if (e == "n") s = s "\n"
          else if (e == "t") s = s "\t"
          else if (e == "r") s = s "\r"
          else if (e == "b" || e == "f") s = s " "
          else if (e == "u") { s = s utf8(hexwert(substr(T, P + 2, 4))); P += 4 }
          else s = s e
          P += 2
          continue
        }
        s = s c
        P++
      }
      KAPUTT = 1
      return s
    }
    function ueberspringen(   tiefe, c) {
      tiefe = 0
      while (P <= N) {
        c = substr(T, P, 1)
        if (c == "\"") { text(); continue }
        if (c == "{" || c == "[") tiefe++
        if (c == "}" || c == "]") { tiefe--; if (tiefe == 0) { P++; return } }
        P++
      }
      KAPUTT = 1
    }
    { T = T $0 "\n" }
    END {
      N = length(T)
      P = 1
      leer()
      if (substr(T, P, 1) != "{") exit 1
      P++
      while (P <= N && !KAPUTT) {
        leer()
        c = substr(T, P, 1)
        if (c == ",") { P++; continue }
        if (c != "\"") exit 1
        name = text()
        leer()
        if (substr(T, P, 1) != ":") exit 1
        P++
        leer()
        c = substr(T, P, 1)
        art = "wort"
        if (c == "\"") { wert = text(); art = "text" }
        else if (c == "{" || c == "[") { ueberspringen(); art = "gefuege" }
        else {
          wert = ""
          while (P <= N && index(",} \t\r\n", substr(T, P, 1)) == 0) { wert = wert substr(T, P, 1); P++ }
        }
        if (KAPUTT) exit 1
        if (name == K) {
          if (art == "gefuege" || (art == "wort" && wert == "null")) exit 1
          print wert
          exit 0
        }
      }
      exit 1
    }' "$1" 2>/dev/null
}

# versuch <art> <seq> <zuweisung> [grund] - eine Marke in den Flash (Format:
# otalight.Versuch). Feste Obergrenze: nur die letzten VERSUCHE_MAX Zeilen.
versuch() {
  zeile="$1 $2 $3"
  if [ -n "$4" ]; then
    zeile="$zeile $(printf '%s' "$4" | tr '\n\r\t' '   ')"
  fi
  {
    [ -f "$VERSUCHE" ] && tail -n $((VERSUCHE_MAX - 1)) "$VERSUCHE"
    echo "$zeile"
  } >"$VERSUCHE.tmp" && mv -f "$VERSUCHE.tmp" "$VERSUCHE"
  sync
}

# --- Bestaetigte Fassung aus dem Flash (oder nachgeladen) ---------------------

# hole <url> <ziel> - wget, sonst curl. Der Weg begruendet kein Vertrauen
# (BusyBox-wget prueft kein Zertifikat): was ankommt, wird gegen die beiden
# Pruefsummen der bestaetigten Fassung geprueft.
hole() {
  if command -v wget >/dev/null 2>&1 && wget -q -T 120 -O "$2" "$1"; then
    return 0
  fi
  if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 120 -o "$2" "$1"; then
    return 0
  fi
  return 1
}

# nachladen <gz_sha256> <sha256> [groesse_bytes] - genau diese Fassung aus dem
# Portal holen, gegen beide Pruefsummen pruefen, entpacken und die Kopie im
# Flash erneuern.
nachladen() {
  gzsoll="$1"
  soll="$2"
  rm -f "$BIN" "$BIN.part" "$BIN.gz"
  genug_speicher "nicht nachgeladen" "$(bedarf_kb "${3:-}")" || return 1
  url="$PORTAL/api/v1/edge/light-programm/$gzsoll"
  hole "$url" "$BIN.gz" || { log "bestaetigte Fassung nicht ladbar: $url"; rm -f "$BIN.gz"; return 1; }
  if [ "$(summe "$BIN.gz")" != "$gzsoll" ]; then
    log "nachgeladene Fassung: Pruefsumme stimmt nicht - verworfen"
    rm -f "$BIN.gz"
    return 1
  fi
  gunzip -c "$BIN.gz" >"$BIN.part" || { rm -f "$BIN.gz" "$BIN.part"; return 1; }
  if [ "$(summe "$BIN.part")" != "$soll" ]; then
    log "nachgeladene Fassung: Programm passt nicht zur Pruefsumme - verworfen"
    rm -f "$BIN.gz" "$BIN.part"
    return 1
  fi
  # Die Kopie im Flash erneuern, damit der naechste Start kein Netz braucht.
  rm -f "$LOCAL_GZ"
  if cp "$BIN.gz" "$LOCAL_GZ.part" && mv -f "$LOCAL_GZ.part" "$LOCAL_GZ"; then
    sync
  else
    rm -f "$LOCAL_GZ.part"
    log "Kopie im Flash nicht erneuert - der naechste Start laedt erneut"
  fi
  rm -f "$BIN.gz"
  chmod 0755 "$BIN.part" && mv -f "$BIN.part" "$BIN"
  log "bestaetigte Fassung aus dem Portal nachgeladen ($soll)"
}

# unpack_local - die bestaetigte Fassung aus dem Flash entpacken und gegen die
# Pruefsumme des UNGEPACKTEN Programms pruefen (kaputter Flash startet nie).
# Ist die Kopie unvollstaendig (Strom weg beim Behalten), wird genau diese
# Fassung nachgeladen.
unpack_local() {
  [ -f "$LOCAL_SUM" ] || { log "keine bestaetigte Fassung ($LOCAL_SUM) - edge-industrie/install.sh ausfuehren"; return 1; }
  want="$(awk 'NR == 1 {print $1; exit}' "$LOCAL_SUM")"
  gzwant="$(awk 'NR == 2 && $1 != "groesse" {print $1; exit}' "$LOCAL_SUM")"
  groesse="$(awk '$1 == "groesse" {print $2; exit}' "$LOCAL_SUM")"
  # Neustart durch den Dienst (Absturz, Update-Neustart): liegt GENAU diese
  # Fassung schon entpackt da, wird sie genommen. Sonst die alte zuerst weg.
  if [ -x "$BIN" ]; then
    if [ "$(summe "$BIN")" = "$want" ]; then
      log "entpackte Fassung entspricht der bestaetigten - wird wiederverwendet"
      return 0
    fi
    rm -f "$BIN"
  fi
  rm -f "$BIN.part"
  if [ -f "$LOCAL_GZ" ]; then
    genug_speicher "lokale Kopie nicht entpackt" "$(bedarf_kb "$groesse")" || return 1
    if gunzip -c "$LOCAL_GZ" >"$BIN.part" 2>/dev/null && [ -n "$want" ] && [ "$(summe "$BIN.part")" = "$want" ]; then
      chmod 0755 "$BIN.part" && mv -f "$BIN.part" "$BIN"
      log "lokale Kopie entpackt ($want)"
      return 0
    fi
    rm -f "$BIN.part"
    log "lokale Kopie unvollstaendig oder passt nicht zur Pruefsumme ($want)"
  fi
  if [ -n "$gzwant" ]; then
    nachladen "$gzwant" "$want" "$groesse" && return 0
  fi
  return 1
}

# --- Tauschen, Probe, Behalten, Zurueck ----------------------------------------
# Zeichengleich mit dem Mango-Loader. "RAM" und "Flash" in den Texten meinen
# hier das RAM-Verzeichnis und die Datenpartition des PFC200.

# zurueck <grund> - die neue Fassung aufgeben; die bestaetigte startet danach.
zurueck() {
  zseq="$(jwert "$PROBE" release_seq)"
  zzuw="$(jwert "$PROBE" zuweisung)"
  zrel="$(jwert "$PROBE" release)"
  if [ -z "$zseq" ]; then
    zseq="$(jwert "$KAND" release_seq)"
    zzuw="$(jwert "$KAND" zuweisung)"
    zrel="$(jwert "$KAND" release)"
  fi
  log "ZURUECK: $zrel wird nicht behalten - $1"
  [ -n "$zseq" ] && versuch zurueck "$zseq" "${zzuw:--}" "$1"
  rm -f "$PROBE" "$URTEIL" "$KAND" "$KGZ" "$BIN" "$BIN.part"
}

# behalten - die neue Fassung wird die bestaetigte: Pruefsummen zuerst
# (Schicht 6), Marke "ok", dann die Kopie im Flash ersetzen.
behalten() {
  brel="$(jwert "$KAND" release)"
  bseq="$(jwert "$KAND" release_seq)"
  bzuw="$(jwert "$KAND" zuweisung)"
  bsha="$(jwert "$KAND" sha256)"
  bgz="$(jwert "$KAND" gz_sha256)"
  bsize="$(jwert "$KAND" size)"
  bgzsize="$(jwert "$KAND" gz_size)"
  if [ -z "$bsha" ] || [ -z "$bgz" ] || [ ! -f "$KGZ" ]; then
    log "Behalten unmoeglich: Kandidat fehlt im RAM"
    return 1
  fi
  mkdir -p "$LOCAL_DIR"
  printf '%s  %s\n%s  %s\ngroesse %s %s\n' "$bsha" "$NAME" "$bgz" "$NAME.gz" \
    "${bsize:-0}" "${bgzsize:-0}" >"$LOCAL_SUM.tmp" && mv -f "$LOCAL_SUM.tmp" "$LOCAL_SUM"
  sync
  versuch ok "$bseq" "${bzuw:--}"
  # Nur eine Fassung passt in den Flash: die alte Kopie zuerst weg.
  rm -f "$LOCAL_GZ"
  if cp "$KGZ" "$LOCAL_GZ.part" && mv -f "$LOCAL_GZ.part" "$LOCAL_GZ"; then
    sync
  else
    rm -f "$LOCAL_GZ.part"
    log "Kopie im Flash unvollstaendig - der naechste Start laedt $brel aus dem Portal"
  fi
  if [ "$(summe "$LOCAL_GZ")" != "$bgz" ]; then
    log "Kopie im Flash passt nicht zur Pruefsumme - der naechste Start laedt $brel aus dem Portal"
  fi
  rm -f "$PROBE" "$URTEIL" "$KAND" "$KGZ"
  log "BEHALTEN: $brel ist die bestaetigte Fassung (im Flash)"
}

# probestart <release> - `<programm> version` mit Frist: gibt es genau diese
# Fassung aus? Ein Programm fuer die falsche Architektur scheitert hier.
probestart() {
  "$BIN" version >"$OTA_RAM/version.out" 2>&1 &
  vp=$!
  i=0
  while kill -0 "$vp" 2>/dev/null; do
    if [ "$i" -ge "$VERSION_FRIST" ]; then
      kill -9 "$vp" 2>/dev/null
      wait "$vp" 2>/dev/null
      echo "keine Antwort binnen ${VERSION_FRIST} s"
      return 1
    fi
    sleep 1
    i=$((i + 1))
  done
  if ! wait "$vp"; then
    echo "Programm startet nicht ($(head -c 120 "$OTA_RAM/version.out" | tr '\n' ' '))"
    return 1
  fi
  aus="$(head -n 1 "$OTA_RAM/version.out")"
  case "$aus" in
    "$1" | "$1"-*) return 0 ;;
  esac
  echo "meldet Fassung '$aus' statt $1"
  return 1
}

# tauschen - den Kandidaten aus dem RAM pruefen, entpacken, probestarten.
tauschen() {
  krel="$(jwert "$KAND" release)"
  kseq="$(jwert "$KAND" release_seq)"
  kzuw="$(jwert "$KAND" zuweisung)"
  ksha="$(jwert "$KAND" sha256)"
  kgz="$(jwert "$KAND" gz_sha256)"
  ksize="$(jwert "$KAND" size)"
  if [ -z "$krel" ] || [ -z "$kseq" ] || [ -z "$ksha" ] || [ -z "$kgz" ]; then
    zurueck "Kandidat unvollstaendig beschrieben"
    return 1
  fi
  log "Tausch: $krel (Stand $kseq) wird geprueft"
  if [ "$(summe "$KGZ")" != "$kgz" ]; then
    zurueck "Lieferung im RAM passt nicht zur Pruefsumme"
    return 1
  fi
  # Die alte Fassung zuerst freigeben - beide passen nicht nebeneinander.
  rm -f "$BIN" "$BIN.part"
  if ! genug_speicher "Kandidat nicht entpackt" "$(bedarf_kb "$ksize")"; then
    zurueck "zu wenig freier Speicher zum Entpacken"
    return 1
  fi
  if ! gunzip -c "$KGZ" >"$BIN.part" 2>/dev/null; then
    rm -f "$BIN.part"
    zurueck "Kandidat nicht entpackbar (kein Platz im RAM oder beschaedigt)"
    return 1
  fi
  if [ "$(summe "$BIN.part")" != "$ksha" ]; then
    zurueck "Programm passt nicht zur Pruefsumme"
    return 1
  fi
  chmod 0755 "$BIN.part" && mv -f "$BIN.part" "$BIN"
  if ! warum="$(probestart "$krel")"; then
    zurueck "Probestart gescheitert: $warum"
    return 1
  fi
  versuch start "$kseq" "${kzuw:--}"
  frist=$(($(uptime_s) + PROBE_FRIST))
  printf '{"release":"%s","release_seq":%s,"zuweisung":"%s","frist":%s,"starts":1}\n' \
    "$krel" "$kseq" "${kzuw:--}" "$frist" >"$PROBE.tmp" && mv -f "$PROBE.tmp" "$PROBE"
  rm -f "$URTEIL"
  log "Probe: $krel startet (Frist ${PROBE_FRIST} s, hoechstens $PROBE_STARTS Starts)"
  return 0
}

# probe_pruefen - bei jedem Start in der Probe: Urteil, Frist, Starts. 0 =
# weiter zur Probe starten; 1 = Probe ist vorbei (behalten oder zurueck).
probe_pruefen() {
  if [ -f "$URTEIL" ] && [ "$(jwert "$URTEIL" zuweisung)" = "$(jwert "$PROBE" zuweisung)" ]; then
    if [ "$(jwert "$URTEIL" bestanden)" = "true" ]; then
      behalten
      return 1
    fi
    if [ "$(jwert "$URTEIL" offen)" != "true" ]; then
      zurueck "$(jwert "$URTEIL" grund)"
      return 1
    fi
  fi
  if [ "$(uptime_s)" -ge "$(jwert "$PROBE" frist)" ]; then
    grund="Selbsttest nicht binnen $((PROBE_FRIST / 60)) min bestanden"
    if [ -f "$URTEIL" ] && [ "$(jwert "$URTEIL" offen)" = "true" ] && [ -n "$(jwert "$URTEIL" grund)" ]; then
      grund="$(jwert "$URTEIL" grund)"
    fi
    zurueck "$grund"
    return 1
  fi
  starts="$(jwert "$PROBE" starts)"
  starts=$((${starts:-0} + 1))
  if [ "$starts" -gt "$PROBE_STARTS" ]; then
    zurueck "in der Probezeit $PROBE_STARTS-mal abgestuerzt"
    return 1
  fi
  # Starts mitzaehlen (RAM).
  sed "s/\"starts\":[0-9]*/\"starts\":$starts/" "$PROBE" >"$PROBE.tmp" && mv -f "$PROBE.tmp" "$PROBE"
  # Die Fassung im RAM muss weiter der Kandidat sein.
  if [ "$(summe "$BIN")" != "$(jwert "$KAND" sha256)" ]; then
    rm -f "$BIN"
    if ! genug_speicher "Kandidat nicht erneut entpackt" "$(bedarf_kb "$(jwert "$KAND" size)")"; then
      zurueck "zu wenig freier Speicher, um den Kandidaten erneut zu entpacken"
      return 1
    fi
    if ! gunzip -c "$KGZ" >"$BIN.part" 2>/dev/null || [ "$(summe "$BIN.part")" != "$(jwert "$KAND" sha256)" ]; then
      rm -f "$BIN.part"
      zurueck "Kandidat im RAM nicht mehr lesbar"
      return 1
    fi
    chmod 0755 "$BIN.part" && mv -f "$BIN.part" "$BIN"
  fi
  return 0
}

# waechter <pid> - im Hintergrund, solange das Programm zur Probe laeuft:
# bestanden -> behalten (das Programm laeuft weiter); endgueltig
# durchgefallen oder Frist um -> Programm beenden, der naechste Start nimmt zurueck.
waechter() {
  while kill -0 "$1" 2>/dev/null; do
    sleep "$PROBE_TAKT"
    [ -f "$PROBE" ] || return 0
    if [ -f "$URTEIL" ] && [ "$(jwert "$URTEIL" zuweisung)" = "$(jwert "$PROBE" zuweisung)" ]; then
      if [ "$(jwert "$URTEIL" bestanden)" = "true" ]; then
        behalten
        return 0
      fi
      if [ "$(jwert "$URTEIL" offen)" != "true" ]; then
        log "Probe: Selbsttest durchgefallen - Programm wird beendet"
        kill -TERM "$1" 2>/dev/null
        return 0
      fi
    fi
    if [ "$(uptime_s)" -ge "$(jwert "$PROBE" frist)" ]; then
      log "Probe: Frist abgelaufen - Programm wird beendet"
      kill -TERM "$1" 2>/dev/null
      return 0
    fi
  done
}

# --- Ablauf --------------------------------------------------------------------

# Kalter Start mit offener Marke "start" (keine Probe im RAM): Strom weg oder
# Neustart des Geraets in der Probe. Das zaehlt als Abbruch.
if [ ! -f "$PROBE" ] && [ -f "$VERSUCHE" ]; then
  letzte="$(tail -n 1 "$VERSUCHE")"
  case "$letzte" in
    "start "*)
      # shellcheck disable=SC2086 # bewusst in Woerter zerlegt: art seq zuweisung
      set -- $letzte
      log "Abbruch: die Probe von Stand $2 endete mit einem Neustart des Geraets"
      versuch abbruch "$2" "$3"
      set --
      ;;
  esac
fi

ZUR_PROBE=0
if [ -f "$PROBE" ]; then
  if [ -f "$KAND" ] && [ -f "$KGZ" ]; then
    probe_pruefen && ZUR_PROBE=1
  else
    zurueck "Kandidat fehlt im RAM"
  fi
elif [ -f "$KAND" ] && [ -f "$KGZ" ]; then
  tauschen && ZUR_PROBE=1
elif [ -f "$KAND" ] || [ -f "$KGZ" ]; then
  rm -f "$KAND" "$KGZ"
fi

if [ "$ZUR_PROBE" != 1 ]; then
  if ! unpack_local; then
    log "kein startbares Programm (bestaetigte Fassung/Nachladen) - neuer Versuch durch den Dienst"
    exit 1
  fi
fi

# --- Starten ------------------------------------------------------------------
# Zusaetzliche Umgebung aus den Zeilen "env = NAME=wert" (z. B. VP_REF=VP-1234).
# Jede Zeile wird EIN Argument; ein Wert darf Leerzeichen tragen.
set --
while IFS= read -r zeile; do
  [ -n "$zeile" ] || continue
  name="${zeile%%=*}"
  case "$zeile" in
    *=*)
      case "$name" in
        '' | [0-9]* | *[!A-Za-z0-9_]*) log "eine env-Zeile ohne gueltigen Namen wird uebergangen" ;;
        *) set -- "$@" "$zeile" ;;
      esac
      ;;
    *) log "eine env-Zeile ohne NAME=wert wird uebergangen" ;;
  esac
done <<EOF
$(kliste env)
EOF

{ echo "$OOM_ADJ" >/proc/self/oom_score_adj; } 2>/dev/null

# Was NACH der zusaetzlichen Umgebung steht, laesst sich dort nicht
# uebersteuern:
#   VP_MIRROR_PORT=1502    der Datenspiegel lauscht fest auf 1502 und wird so
#                          angezeigt; 502 gehoert dem Modbus-Server der SPS.
#   VP_WAGO_BESTELLNUMMER  die Modellangabe ("WAGO 750-8212") stammt vom
#                          Geraet (Dienst-Skript, get_coupler_details).
#   VP_LOADER_PATH leer    das Programm sucht den Mango-Loader am Mango-Pfad,
#                          findet keinen und schreibt nichts (kein
#                          Loader-Selbstupdate auf dem PFC200).
set -- \
  VP_DATA_DIR="$DATA_DIR" \
  VP_OTA_RAM_DIR="$OTA_RAM" \
  VP_HTTP_ADDR="$WEB_ADDR" \
  VP_LOCAL_MQTT_ADDR="$BUS_ADDR" \
  VP_PORTAL_BASE_URL="$PORTAL" \
  GOMEMLIMIT="$MEMLIMIT" \
  "$@" \
  VP_MIRROR_PORT=1502 \
  VP_WAGO_BESTELLNUMMER="${VP_WAGO_BESTELLNUMMER:-}" \
  VP_LOADER_PATH= \
  VP_LOADER_INIT_PATH= \
  "$BIN"

if [ "$ZUR_PROBE" != 1 ]; then
  exec env "$@"
fi

# Zur Probe: das Programm als Kind, der Waechter daneben. Das Dienst-Skript
# beendet den Loader - das Signal geht an das Programm weiter.
env "$@" &
PID=$!
trap 'kill -TERM "$PID" 2>/dev/null' TERM INT
waechter "$PID" &
WPID=$!
wait "$PID"
RC=$?
# wait kehrt bei einem Signal frueher zurueck - auf das Programm warten.
while kill -0 "$PID" 2>/dev/null; do
  wait "$PID"
  RC=$?
done
kill "$WPID" 2>/dev/null
exit "$RC"
