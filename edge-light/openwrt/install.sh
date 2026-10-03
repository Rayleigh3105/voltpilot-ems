#!/bin/sh
# Edge Light auf einem OpenWrt-Geraet einrichten (Pilot, Stufe 1).
#
# Kopiert Loader, Dienst und Standard-Konfiguration auf das Geraet und - wenn
# gebaut - die lokale Kopie des Programms (gzip, ~4,4 MB) in den Flash. Mit
# base_url laedt der Loader bei jedem Start die aktuelle Fassung per HTTPS und
# nimmt die lokale Kopie nur als Notfall; ohne base_url startet er die lokale
# Kopie.
#
#   edge-light/scripts/build.sh mipsle
#   edge-light/openwrt/install.sh root@192.168.1.1                  # nur lokale Kopie
#   edge-light/openwrt/install.sh root@10.8.0.23 https://downloads.example.de/edge-light
#
# Ein erneuter Aufruf aktualisiert Loader, Dienst und lokale Kopie; eine
# bestehende Konfiguration bleibt (nur base_url, local_dir und enabled werden
# gesetzt). Danach auf dem Geraet:
#   /etc/init.d/vp-edge-light restart ; logread -f -e vp-edge-light
set -eu

TARGET="${1:?Ziel fehlt, z. B. root@192.168.1.1}"
BASE_URL="${2:-}"
ARCH="${VP_LIGHT_ARCH:-mipsle}"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
BIN="$HERE/../dist/vp-edge-light-linux-$ARCH"
NAME="vp-edge-light-linux-$ARCH"
LOCAL_DIR=/usr/share/vp-edge-light

case "$BASE_URL" in
  "" | https://*) ;;
  *) echo "FEHLER: base_url muss mit https:// beginnen" >&2; exit 1 ;;
esac
if [ -z "$BASE_URL" ] && [ ! -f "$BIN" ]; then
  echo "FEHLER: ohne base_url braucht es die lokale Kopie - erst edge-light/scripts/build.sh $ARCH" >&2
  exit 1
fi

echo "--- kopiere Loader und Dienst nach $TARGET"
# Einzeldateien per cat|ssh: Dropbear auf OpenWrt bringt oft kein scp/sftp mit.
for f in usr/libexec/vp-edge-light/boot.sh etc/init.d/vp-edge-light; do
  # shellcheck disable=SC2029 # bewusst lokal expandiert: der Zielpfad kommt von hier
  ssh "$TARGET" "mkdir -p /$(dirname "$f") && cat > /$f && chmod 0755 /$f" <"$HERE/files/$f"
done
# Die Konfiguration nur anlegen, nie eine bestehende ueberschreiben.
ssh "$TARGET" "[ -f /etc/config/vp-edge-light ] || cat > /etc/config/vp-edge-light" <"$HERE/files/etc/config/vp-edge-light"

if [ -f "$BIN" ]; then
  echo "--- lokale Kopie in den Flash ($LOCAL_DIR/$NAME.gz)"
  sum="$(sha256sum "$BIN" | awk '{print $1}')"
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  gzip -9 -n -c "$BIN" >"$tmp"
  need_kb=$(($(wc -c <"$tmp") / 1024 + 512))
  # shellcheck disable=SC2029
  avail_kb="$(ssh "$TARGET" "mkdir -p $LOCAL_DIR && df -k $LOCAL_DIR | awk 'NR==2 {print \$4}'")"
  # shellcheck disable=SC2029
  if [ "$avail_kb" -lt "$need_kb" ]; then
    # Kein Platz fuer alt und neu nebeneinander: die alte Kopie zuerst weg.
    echo "    wenig Flash frei (${avail_kb} kB) - alte Kopie wird vorher entfernt"
    ssh "$TARGET" "rm -f $LOCAL_DIR/$NAME.gz $LOCAL_DIR/$NAME.sha256"
  fi
  # shellcheck disable=SC2029
  ssh "$TARGET" "cat > $LOCAL_DIR/$NAME.gz.part" <"$tmp"
  # shellcheck disable=SC2029
  remote_sum="$(ssh "$TARGET" "gunzip -c $LOCAL_DIR/$NAME.gz.part | sha256sum" | awk '{print $1}')"
  if [ "$remote_sum" != "$sum" ]; then
    ssh "$TARGET" "rm -f $LOCAL_DIR/$NAME.gz.part"
    echo "FEHLER: Pruefsumme der lokalen Kopie stimmt auf dem Geraet nicht" >&2
    exit 1
  fi
  # shellcheck disable=SC2029
  ssh "$TARGET" "mv -f $LOCAL_DIR/$NAME.gz.part $LOCAL_DIR/$NAME.gz && echo '$sum  $NAME' > $LOCAL_DIR/$NAME.sha256 && sync"
  awk -v b="$(wc -c <"$tmp")" 'BEGIN {printf "    %.1f MB gepackt, Pruefsumme auf dem Geraet bestaetigt\n", b / 1048576}'
fi

echo "--- setze base_url und aktiviere den Dienst"
# shellcheck disable=SC2029 # bewusst lokal expandiert: base_url kommt von hier
ssh "$TARGET" "uci set vp-edge-light.main.base_url='$BASE_URL' && uci set vp-edge-light.main.local_dir='$LOCAL_DIR' && uci set vp-edge-light.main.enabled='1' && uci commit vp-edge-light && /etc/init.d/vp-edge-light enable"

echo "--- fertig. Starten:  ssh $TARGET /etc/init.d/vp-edge-light restart"
echo "    Protokoll:         ssh $TARGET logread -f -e vp-edge-light"
echo "    Lokale Web-App:    http://<mango-ip>:8484"
