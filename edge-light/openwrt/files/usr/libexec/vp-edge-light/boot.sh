#!/bin/sh
# Edge Light - Loader fuer OpenWrt (GL.iNet Mango und Verwandte).
#
# Das Programm laeuft aus dem RAM (/tmp, tmpfs): bei jedem Start entpackt der
# Loader die BESTAETIGTE Fassung aus dem Flash (local_dir, gzip, eine Fassung,
# mit Pruefsumme), prueft sie und startet sie. procd (/etc/init.d/vp-edge-light)
# startet den Loader neu, wenn das Programm endet.
#
# UPDATES (Konzept vp-edge-light-update, U-3 A; Protokoll in
# edge-app/core/internal/otalight): Das laufende Programm prueft eine Zuweisung
# aus dem Portal gegen seine eingebackene Wurzel, laedt die gepackte neue
# Fassung in den RAM (kandidat.gz + kandidat.json mit den Pruefsummen aus dem
# GEPRUEFTEN Manifest) und beendet sich. Dieser Loader dann:
#
#   1. Tauschen: alte Fassung im RAM freigeben, Kandidat entpacken, gegen
#      sha256 pruefen, Probestart `<programm> version` (5 s), Versuchsmarke
#      "start" in den Flash, probe.json in den RAM, neue Fassung zur Probe starten.
#   2. Wache (10 min, 3 Abstuerze): das Programm urteilt ueber sich
#      (probe-urteil.json). Bestanden -> Behalten. Durchgefallen, Frist um oder
#      dreimal abgestuerzt -> zurueck zur bestaetigten Fassung, Marke "zurueck".
#   3. Behalten: Pruefsummen ZUERST (eine Datei, atomar), Marke "ok", dann die
#      alte Kopie im Flash ersetzen, sync. Ist die Kopie danach unvollstaendig
#      (Strom weg), laedt der Loader GENAU diese Fassung aus dem Portal nach
#      und prueft sie gegen die Pruefsumme.
#   4. Ein kalter Start mit offener Marke "start" (Strom weg in der Probe)
#      schreibt "abbruch"; das Programm gibt nach zwei Abbruechen auf.
#
# In den Flash schreibt der Loader nur: die Marken (versuche, feste
# Obergrenze, eine Zeile je Schritt), und beim Behalten Pruefsummen + Kopie.
# Was laufend geschrieben wird, liegt im RAM (HOT_DIRS). Ein Update tauscht nur
# das Programm - dieser Loader aendert Dienst und Wartungstunnel nie (Schicht
# 8). Loader und Dienst-Init erneuert das BESTAETIGTE Programm selbst, wenn
# sein eingebetteter Stand NEUER ist (LOADER_STAND unten, agent/loader_pflege);
# den Wartungstunnel aendert auch das nie.
#
# base_url (Laden bei jedem Start, ungeprueft) ist abgeschafft: ein gesetzter
# Wert wird ignoriert und gemeldet.

# Kein "set -u": /lib/functions.sh (config_load & Co.) liest ungesetzte
# Variablen wie IPKG_INSTROOT und bricht sonst ab (am Mango gefunden). Jede
# eigene Variable bekommt ueber config_get eine Vorgabe.

# shellcheck source=/dev/null # OpenWrt-Systembibliothek, nur auf dem Geraet vorhanden
. /lib/functions.sh

# LOADER_STAND: die Fassung von Loader UND Dienst-Init (ein Stand fuer beide).
# Das BESTAETIGTE Programm bringt beide eingebettet mit und erneuert sie im
# Flash, wenn sein eingebetteter Stand NEUER ist (edge-app/core/internal/
# loaderstand; nie waehrend der Probe, nie ein Rueckschritt). Bei JEDER
# Aenderung an boot.sh oder dem Init-Skript den Stand erhoehen und den Verlauf
# in loaderstand/stand-verlauf fortschreiben - ohne neuen Stand erreicht die
# Aenderung keine Box im Feld. Kein Stand (alte Loader) zaehlt als 0.
LOADER_STAND=1

log() { logger -t vp-edge-light "$*"; echo "vp-edge-light: $*" >&2; }
log "Loader Stand $LOADER_STAND"

config_load vp-edge-light
config_get BASE_URL main base_url ""
config_get ARCH main arch "mipsle"
config_get DATA_DIR main data_dir "/etc/vp-edge-light"
config_get RAM_DIR main ram_dir "/tmp/vp-edge-light"
config_get PORTAL main portal_url "https://portal.voltpilot.de"
config_get WEB_ADDR main web_addr ":8484"
config_get BUS_ADDR main bus_addr "127.0.0.1:1883"
config_get MEMLIMIT main gomemlimit "48MiB"
config_get MIN_FREE_KB main min_free_kb "40000"
config_get PROZESS_RESERVE_KB main prozess_reserve_kb "20000"
config_get LOCAL_DIR main local_dir "/usr/share/vp-edge-light"
# Wache der Probe (dieselben Zahlen wie die Docker-Box): Frist in s, Starts,
# Probestart-Frist in s, Takt der Wache in s.
config_get PROBE_FRIST main probe_frist "600"
config_get PROBE_STARTS main probe_starts "3"
config_get VERSION_FRIST main version_frist "5"
config_get PROBE_TAKT main probe_takt "5"
# Bei Speichernot trifft der Kernel zuerst das Programm, nie WireGuard/SSH.
config_get OOM_ADJ main oom_score_adj "800"

BIN="$RAM_DIR/vp-edge-light"
NAME="vp-edge-light-linux-$ARCH"
LOCAL_GZ="$LOCAL_DIR/$NAME.gz"
# Zeile 1: sha256 des ENTPACKTEN Programms, Zeile 2 (seit Updates): sha256 der
# gepackten Kopie - mit ihr laesst sich genau diese Fassung nachladen. Dazu
# (seit der Bedarfs-Schwelle) die Zeile "groesse <bytes> <gz_bytes>": aus der
# Groesse des entpackten Programms leitet der Loader seine Speicherschwelle ab.
LOCAL_SUM="$LOCAL_DIR/$NAME.sha256"
OTA_FEST="$DATA_DIR/ota"
OTA_RAM="$RAM_DIR/ota"
VERSUCHE="$OTA_FEST/versuche"
KAND="$OTA_RAM/kandidat.json"
KGZ="$OTA_RAM/kandidat.gz"
PROBE="$OTA_RAM/probe.json"
URTEIL="$OTA_RAM/probe-urteil.json"
VERSUCHE_MAX=40

# VP_LOADER_PROC nur fuer die Proben (edge-light/test/boot-*-probe.sh).
PROC="${VP_LOADER_PROC:-/proc}"

[ -n "$BASE_URL" ] && log "base_url ist abgeschafft (laedt ungeprueft) und wird ignoriert - Updates kommen signiert aus dem Portal"

mkdir -p "$RAM_DIR" "$DATA_DIR" || exit 1

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
# ota: bis Stufe 1 ein Symlink in den RAM. Seit Updates liegen dort
# Vertrauens-Set, current.json und die Marken - sie muessen einen Stromausfall
# ueberleben. Der Symlink wird einmal aufgeloest (sein Inhalt lag im RAM und
# war nach jedem Stromausfall ohnehin weg); das Fluechtige liegt in OTA_RAM.
if [ -L "$OTA_FEST" ]; then
  rm -f "$OTA_FEST"
  log "ota liegt jetzt im Flash ($OTA_FEST), Fluechtiges in $OTA_RAM"
fi
mkdir -p "$OTA_FEST" "$OTA_RAM" || exit 1

# --- Speicher fuer das Programm im tmpfs ---------------------------------------
# MemAvailable rechnet vom Seitencache nur etwa die Haelfte als verfuegbar, und
# ohne Speicherdruck raeumt der Kernel ihn nicht. Am VoltPilotGATE zeigte der
# Router nach einem Update so nur ~39 600 kB (MemFree 45 964, Inactive(file)
# 29 092 kB) - unter der Schwelle bei jedem Versuch procds, die Box blieb aus.
# Deshalb: liegt der Wert unter der Schwelle, wird der Seitencache einmal
# geraeumt und neu gemessen. Gemessen wird weiter MemAvailable, die Reserve des
# Kernels zaehlt also nie als frei. Bewusst NICHT MemFree + Inactive(file): das
# zaehlt Seiten, die gerade nicht frei werden (gemappt, schmutzig), und
# uebergeht die Reserve - und das Programm im tmpfs ist ohne Swap nicht
# verdraengbar, eine zu hohe Schaetzung endet beim OOM-Killer.
#
# Die Schwelle ist seit dem Tausch-Vorfall an der Box "Zuhause" (11.2026, knapp
# unter 40 000 kB auch nach dem Raeumen) der TATSAECHLICHE Bedarf der Fassung:
# Groesse des entpackten Programms (tmpfs) plus PROZESS_RESERVE_KB fuer
# Prozess und Entpacken (gemessene VmRSS 16-18 MB plus ~2 MB, mango.md
# "Speicherbudget"). So gelingt der Tausch auf jeder Box, die das laufende
# Programm halten kann - und eine gewachsene Fassung wird ehrlich verweigert,
# auch wenn mehr als die alte Pauschale frei ist. Nur wenn die Groesse
# unbekannt ist (Pruefsummen-Datei ohne groesse-Zeile), gilt die Pauschale
# MIN_FREE_KB wie bisher.

free_kb() { awk '/^MemAvailable:/ {print $2; exit}' "$PROC/meminfo"; }

# bedarf_kb <groesse_bytes> - was Entpacken und Start dieser Fassung brauchen:
# das entpackte Programm liegt im tmpfs, dazu Prozess und Entpacken
# (PROZESS_RESERVE_KB). Ohne bekannte Groesse gilt die Pauschale MIN_FREE_KB.
bedarf_kb() {
  case "${1:-}" in
    '' | *[!0-9]* | 0) echo "$MIN_FREE_KB" ;;
    *) echo $(($1 / 1024 + PROZESS_RESERVE_KB)) ;;
  esac
}

# genug_speicher <Folge> [schwelle_kb] - 0, wenn das Programm Platz hat (oder
# der Wert unbekannt ist); sonst Meldung "zu wenig freier Speicher ... -
# <Folge>". Ohne zweite Angabe gilt die Pauschale MIN_FREE_KB.
genug_speicher() {
  schwelle="${2:-$MIN_FREE_KB}"
  avail="$(free_kb)"
  if [ -z "$avail" ] || [ "$avail" -ge "$schwelle" ]; then return 0; fi
  sync
  if { echo 1 >"$PROC/sys/vm/drop_caches"; } 2>/dev/null; then
    vorher="$avail"
    # Neu messen, bis zu dreimal mit 1 s Pause: der Kernel gibt die Seiten
    # nicht immer schon im selben Augenblick frei.
    for _ in 1 2 3; do
      avail="$(free_kb)"
      if [ -z "$avail" ] || [ "$avail" -ge "$schwelle" ]; then break; fi
      sleep 1
    done
    log "Seitencache geraeumt: ${vorher} kB -> ${avail} kB verfuegbar"
    if [ -z "$avail" ] || [ "$avail" -ge "$schwelle" ]; then return 0; fi
  else
    log "Seitencache nicht raeumbar ($PROC/sys/vm/drop_caches)"
  fi
  log "zu wenig freier Speicher (${avail} kB < ${schwelle} kB) - $1"
  return 1
}

summe() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }
uptime_s() { awk '{printf "%d", $1}' "$PROC/uptime"; }
jwert() { jsonfilter -i "$1" -e "@.$2" 2>/dev/null; }

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

# nachladen <gz_sha256> <sha256> [groesse_bytes] - genau diese Fassung aus dem
# Portal holen, gegen beide Pruefsummen pruefen, entpacken und die Kopie im
# Flash erneuern.
nachladen() {
  gzsoll="$1"
  soll="$2"
  rm -f "$BIN" "$BIN.part" "$BIN.gz"
  genug_speicher "nicht nachgeladen" "$(bedarf_kb "${3:-}")" || return 1
  url="$PORTAL/api/v1/edge/light-programm/$gzsoll"
  uclient-fetch -q -T 120 -O "$BIN.gz" "$url" || { log "bestaetigte Fassung nicht ladbar: $url"; rm -f "$BIN.gz"; return 1; }
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

# unpack_local - die bestaetigte Fassung aus dem Flash in den RAM entpacken und
# gegen die Pruefsumme des UNGEPACKTEN Programms pruefen (kaputter Flash startet
# nie). Ist die Kopie unvollstaendig (Strom weg beim Behalten), wird genau
# diese Fassung nachgeladen.
unpack_local() {
  [ -f "$LOCAL_SUM" ] || { log "keine bestaetigte Fassung ($LOCAL_SUM) - edge-light/openwrt/install.sh ausfuehren"; return 1; }
  want="$(awk 'NR == 1 {print $1; exit}' "$LOCAL_SUM")"
  gzwant="$(awk 'NR == 2 && $1 != "groesse" {print $1; exit}' "$LOCAL_SUM")"
  groesse="$(awk '$1 == "groesse" {print $2; exit}' "$LOCAL_SUM")"
  # Neustart durch procd (Absturz, Update-Neustart): liegt GENAU diese Fassung
  # schon im RAM, wird sie genommen. Sonst die alte Fassung zuerst freigeben -
  # mit ihr im tmpfs reicht der freie Speicher nicht fuers Entpacken.
  if [ -x "$BIN" ]; then
    if [ "$(summe "$BIN")" = "$want" ]; then
      log "Fassung im RAM entspricht der bestaetigten - wird wiederverwendet"
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
    log "kein startbares Programm (bestaetigte Fassung/Nachladen) - neuer Versuch durch procd"
    exit 1
  fi
fi

# --- Starten ------------------------------------------------------------------
# Zusaetzliche Umgebung aus der UCI-Liste "env" (z. B. VP_REF=VP-1234).
EXTRA_ENV=""
# shellcheck disable=SC2329 # aufgerufen von config_list_foreach
add_env() { EXTRA_ENV="$EXTRA_ENV $1"; }
config_list_foreach main env add_env

{ echo "$OOM_ADJ" >/proc/self/oom_score_adj; } 2>/dev/null

if [ "$ZUR_PROBE" != 1 ]; then
  # shellcheck disable=SC2086 # EXTRA_ENV traegt bewusst mehrere Worte
  exec env \
    VP_DATA_DIR="$DATA_DIR" \
    VP_OTA_RAM_DIR="$OTA_RAM" \
    VP_HTTP_ADDR="$WEB_ADDR" \
    VP_LOCAL_MQTT_ADDR="$BUS_ADDR" \
    VP_PORTAL_BASE_URL="$PORTAL" \
    GOMEMLIMIT="$MEMLIMIT" \
    $EXTRA_ENV \
    "$BIN"
fi

# Zur Probe: das Programm als Kind, der Waechter daneben. procd beendet den
# Loader - das Signal geht an das Programm weiter.
# shellcheck disable=SC2086
env \
  VP_DATA_DIR="$DATA_DIR" \
  VP_OTA_RAM_DIR="$OTA_RAM" \
  VP_HTTP_ADDR="$WEB_ADDR" \
  VP_LOCAL_MQTT_ADDR="$BUS_ADDR" \
  VP_PORTAL_BASE_URL="$PORTAL" \
  GOMEMLIMIT="$MEMLIMIT" \
  $EXTRA_ENV \
  "$BIN" &
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
