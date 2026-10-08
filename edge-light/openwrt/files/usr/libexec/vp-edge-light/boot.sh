#!/bin/sh
# Edge Light - Loader fuer OpenWrt (GL.iNet Mango und Verwandte).
#
# Das Programm liegt NICHT im Flash (der Mango hat 16 MB, das Programm ~14 MB):
# bei jedem Start wird es in den RAM (/tmp, tmpfs) geladen, gegen seine
# Pruefsumme geprueft und dann gestartet. procd (/etc/init.d/vp-edge-light)
# startet diesen Loader neu, wenn das Programm endet - so ist auch ein
# Update nur ein Neustart.
#
# Im Flash bleibt nur, was selten geschrieben wird und einen Neustart
# ueberleben MUSS: Identitaet, Zertifikat, Auswahl, Freigaben, OCPP-Befehlsbuch.
# Was laufend geschrieben wird, liegt im RAM (NOR-Flash vertraegt Dauerschreiben
# schlecht) - siehe HOT_DIRS und edge-light/docs/mango.md.
#
# Lokale Kopie (Notfall-Kopie): liegt das Programm gepackt im Flash
# (local_dir, ~4,4 MB gzip), startet die Box auch ohne Download-Server und nach
# einem Stromausfall ohne Internet. Reihenfolge: Download (wenn base_url
# gesetzt) -> schon geladene Fassung im RAM -> lokale Kopie aus dem Flash.
#
# ⚠ STUFE 1 (Pilot): die Echtheit des Programms haengt an HTTPS zum
# konfigurierten Server bzw. an der per SSH aufgespielten lokalen Kopie; die
# Pruefsumme schuetzt nur gegen unvollstaendige Downloads und kaputten Flash.
# Die signierte Kette (Ed25519 gegen die eingebackene Wurzel, wie beim OTA der
# Docker-Box) ist Stufe 2: edge-light/docs/boot-und-updates.md.
# NICHT ohne Stufe 2 auf eine Kundenflotte ausrollen.

# Kein "set -u": /lib/functions.sh (config_load & Co.) liest ungesetzte
# Variablen wie IPKG_INSTROOT und bricht sonst ab (am Mango gefunden). Jede
# eigene Variable bekommt ueber config_get eine Vorgabe.

# shellcheck source=/dev/null # OpenWrt-Systembibliothek, nur auf dem Geraet vorhanden
. /lib/functions.sh

log() { logger -t vp-edge-light "$*"; echo "vp-edge-light: $*" >&2; }

config_load vp-edge-light
config_get BASE_URL main base_url ""
config_get ARCH main arch "mipsle"
config_get CHANNEL main channel "latest"
config_get DATA_DIR main data_dir "/etc/vp-edge-light"
config_get RAM_DIR main ram_dir "/tmp/vp-edge-light"
config_get PORTAL main portal_url "https://portal.voltpilot.de"
config_get WEB_ADDR main web_addr ":8484"
config_get BUS_ADDR main bus_addr "127.0.0.1:1883"
config_get MEMLIMIT main gomemlimit "48MiB"
config_get MIN_FREE_KB main min_free_kb "40000"
config_get_bool ALLOW_HTTP main allow_http 0
config_get LOCAL_DIR main local_dir "/usr/share/vp-edge-light"

BIN="$RAM_DIR/vp-edge-light"
NAME="vp-edge-light-linux-$ARCH"
LOCAL_GZ="$LOCAL_DIR/$NAME.gz"
LOCAL_SUM="$LOCAL_DIR/$NAME.sha256"

if [ -n "$BASE_URL" ]; then
  case "$BASE_URL" in
    https://*) ;;
    http://*)
      [ "$ALLOW_HTTP" = 1 ] || { log "base_url ohne HTTPS abgelehnt (nur fuer Entwicklung: allow_http=1)"; exit 1; }
      ;;
    *) log "base_url muss mit https:// beginnen: $BASE_URL"; exit 1 ;;
  esac
elif [ ! -f "$LOCAL_GZ" ]; then
  log "weder base_url noch lokale Kopie ($LOCAL_GZ) - edge-light/openwrt/install.sh ausfuehren"
  exit 1
fi
URL="$BASE_URL/$CHANNEL/$NAME"

mkdir -p "$RAM_DIR" "$DATA_DIR" || exit 1

# --- Was laufend geschrieben wird, gehoert in den RAM -----------------------
# buffer             Messwert-Puffer (Store-and-forward, alle paar Sekunden)
# measurement-outbox Zusatzmesswerte vor dem Hochladen
# ocpp-journal       OCPP-Ereignisse vor dem Hochladen
# Folge, bewusst: ein STROMAUSFALL verliert noch nicht hochgeladene Messwerte.
# Bei einem Cloud-Ausfall puffert die Box weiter, solange sie laeuft.
# ota                der Core schreibt ota/core-signal.json alle 2 s. Stufe 1
#                    haelt dort nichts Dauerhaftes (kein Trust-Set, kein
#                    Updater); Stufe 2 muss Trust-Set und current.json in den
#                    Flash legen und nur das Signal im RAM lassen.
HOT_DIRS="buffer measurement-outbox ocpp-journal ota"
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

free_kb() { awk '/^MemAvailable:/ {print $2; exit}' /proc/meminfo; }

# --- Programm in den RAM laden (oder die schon geladene Fassung nehmen) -------
fetch() {
  rm -f "$BIN.part" "$BIN.sha256"
  avail="$(free_kb)"
  if [ -n "$avail" ] && [ "$avail" -lt "$MIN_FREE_KB" ]; then
    log "zu wenig freier Speicher (${avail} kB < ${MIN_FREE_KB} kB) - Download verschoben"
    return 1
  fi
  uclient-fetch -q -T 30 -O "$BIN.sha256" "$URL.sha256" || { log "Pruefsumme nicht ladbar: $URL.sha256"; return 1; }
  uclient-fetch -q -T 120 -O "$BIN.part" "$URL" || { log "Programm nicht ladbar: $URL"; rm -f "$BIN.part"; return 1; }
  want="$(awk '{print $1; exit}' "$BIN.sha256")"
  got="$(sha256sum "$BIN.part" | awk '{print $1}')"
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    log "Pruefsumme stimmt nicht (erwartet $want, erhalten $got) - Programm verworfen"
    rm -f "$BIN.part"
    return 1
  fi
  chmod 0755 "$BIN.part" && mv -f "$BIN.part" "$BIN"
  log "Programm geladen ($got)"
}

# unpack_local - die lokale Kopie aus dem Flash in den RAM entpacken und gegen
# die Pruefsumme des UNGEPACKTEN Programms pruefen (kaputter Flash startet nie).
unpack_local() {
  [ -f "$LOCAL_GZ" ] || return 1
  [ -f "$LOCAL_SUM" ] || { log "lokale Kopie ohne Pruefsumme ($LOCAL_SUM) - nicht gestartet"; return 1; }
  want="$(awk '{print $1; exit}' "$LOCAL_SUM")"
  # Neustart durch procd (Absturz, Update-Neustart): liegt GENAU diese Fassung
  # schon im RAM, wird sie genommen. Sonst die alte Fassung zuerst freigeben -
  # mit ihr im tmpfs reicht der freie Speicher nicht fuers Entpacken.
  if [ -x "$BIN" ]; then
    if [ "$(sha256sum "$BIN" | awk '{print $1}')" = "$want" ]; then
      log "Fassung im RAM entspricht der lokalen Kopie - wird wiederverwendet"
      return 0
    fi
    rm -f "$BIN"
  fi
  rm -f "$BIN.part"
  avail="$(free_kb)"
  if [ -n "$avail" ] && [ "$avail" -lt "$MIN_FREE_KB" ]; then
    log "zu wenig freier Speicher (${avail} kB < ${MIN_FREE_KB} kB) - lokale Kopie nicht entpackt"
    return 1
  fi
  gunzip -c "$LOCAL_GZ" >"$BIN.part" || { log "lokale Kopie nicht entpackbar: $LOCAL_GZ"; rm -f "$BIN.part"; return 1; }
  got="$(sha256sum "$BIN.part" | awk '{print $1}')"
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    log "lokale Kopie: Pruefsumme stimmt nicht (erwartet $want, erhalten $got) - verworfen"
    rm -f "$BIN.part"
    return 1
  fi
  chmod 0755 "$BIN.part" && mv -f "$BIN.part" "$BIN"
  log "lokale Kopie entpackt ($got)"
}

ok=0
if [ -n "$BASE_URL" ]; then
  for wait in 0 5 15 30 60; do
    [ "$wait" -gt 0 ] && sleep "$wait"
    if fetch; then ok=1; break; fi
  done
fi
if [ "$ok" != 1 ]; then
  if [ -n "$BASE_URL" ] && [ -x "$BIN" ]; then
    # Ein Neustart des Dienstes ohne Netz: die schon geladene und damals
    # gepruefte Fassung weiterverwenden statt ohne Box dazustehen.
    log "Download fehlgeschlagen - starte die bereits geladene Fassung"
  elif unpack_local; then
    [ -n "$BASE_URL" ] && log "Download fehlgeschlagen - starte die lokale Kopie aus dem Flash"
  else
    log "kein startbares Programm (Download/RAM/lokale Kopie) - neuer Versuch durch procd"
    exit 1
  fi
fi

# --- Starten ------------------------------------------------------------------
# Zusaetzliche Umgebung aus der UCI-Liste "env" (z. B. VP_REF=VP-1234).
EXTRA_ENV=""
add_env() { EXTRA_ENV="$EXTRA_ENV $1"; }
config_list_foreach main env add_env

# shellcheck disable=SC2086 # EXTRA_ENV traegt bewusst mehrere Worte
exec env \
  VP_DATA_DIR="$DATA_DIR" \
  VP_HTTP_ADDR="$WEB_ADDR" \
  VP_LOCAL_MQTT_ADDR="$BUS_ADDR" \
  VP_PORTAL_BASE_URL="$PORTAL" \
  GOMEMLIMIT="$MEMLIMIT" \
  $EXTRA_ENV \
  "$BIN"
