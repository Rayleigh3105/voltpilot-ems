#!/bin/sh
# Edge Light auf einem OpenWrt-Geraet einrichten (Pilot, Stufe 1).
#
# Kopiert Loader, Dienst und Standard-Konfiguration auf das Geraet. Das
# Programm selbst wird NICHT kopiert - der Loader holt es bei jedem Start von
# base_url in den RAM.
#
# Aufruf vom Rechner aus (Zugang ueber den bestehenden WireGuard-Tunnel):
#
#   edge-light/openwrt/install.sh root@10.8.0.23 https://downloads.example.de/edge-light
#
# Danach auf dem Geraet:  /etc/init.d/vp-edge-light start ; logread -e vp-edge-light
set -eu

TARGET="${1:?Ziel fehlt, z. B. root@10.8.0.23}"
BASE_URL="${2:?base_url fehlt, z. B. https://downloads.example.de/edge-light}"
HERE="$(cd "$(dirname "$0")" && pwd -P)"

case "$BASE_URL" in
  https://*) ;;
  *) echo "FEHLER: base_url muss mit https:// beginnen" >&2; exit 1 ;;
esac

echo "--- kopiere Dateien nach $TARGET"
# Einzeldateien per cat|ssh: Dropbear auf OpenWrt bringt oft kein scp/sftp mit.
for f in usr/libexec/vp-edge-light/boot.sh etc/init.d/vp-edge-light; do
  # shellcheck disable=SC2029 # bewusst lokal expandiert: der Zielpfad kommt von hier
  ssh "$TARGET" "mkdir -p /$(dirname "$f") && cat > /$f && chmod 0755 /$f" <"$HERE/files/$f"
done
# Die Konfiguration nur anlegen, nie eine bestehende ueberschreiben.
ssh "$TARGET" "[ -f /etc/config/vp-edge-light ] || cat > /etc/config/vp-edge-light" <"$HERE/files/etc/config/vp-edge-light"

echo "--- setze base_url und aktiviere den Dienst"
# shellcheck disable=SC2029 # bewusst lokal expandiert: base_url kommt von hier
ssh "$TARGET" "uci set vp-edge-light.main.base_url='$BASE_URL' && uci set vp-edge-light.main.enabled='1' && uci commit vp-edge-light && /etc/init.d/vp-edge-light enable"

echo "--- fertig. Starten:  ssh $TARGET /etc/init.d/vp-edge-light start"
echo "    Protokoll:         ssh $TARGET logread -f -e vp-edge-light"
echo "    Lokale Web-App:    http://<mango-ip>:8484"
