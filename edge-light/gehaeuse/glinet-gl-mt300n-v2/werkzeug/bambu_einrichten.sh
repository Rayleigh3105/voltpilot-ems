#!/bin/bash
# Richtet Bambu Studio für die Kommandozeile ein: ohne Root-Rechte, ohne
# Bildschirm. Lädt das AppImage (Prüfsumme fest), entpackt es und legt die
# Laufzeitbibliotheken daneben, die auf Debian 13 fehlen (WebKit, GStreamer
# samt deren Abhängigkeiten), per "apt-get download" und "dpkg -x".
#
#   werkzeug/bambu_einrichten.sh            -> .werkzeug/bambu/
#
# Braucht rund 0,8 GB Platz und einmalig das Netz. Das Ergebnis gehört nicht
# ins Repository (.werkzeug/ ist ausgenommen).
set -euo pipefail
WURZEL=$(dirname "$(dirname "$(readlink -f "$0")")")
ZIEL="$WURZEL/.werkzeug/bambu"
VERSION="v02.08.02.61"
DATEI="BambuStudio_ubuntu24.04-v02.08.02.61-20260820225108.AppImage"
SHA256="d501b103fac5424513ec0e8d6bc145fb30719de2c7d94d7320d723740c81a7fd"
# Pakete, deren Bibliotheken dem Programm unmittelbar fehlen:
PAKETE="libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0 libgstreamer1.0-0 libgstreamer-plugins-base1.0-0"

mkdir -p "$ZIEL/debs" "$ZIEL/sysroot"
cd "$ZIEL"

if [ ! -x squashfs-root/bin/bambu-studio ]; then
    if [ ! -f BambuStudio.AppImage ]; then
        curl -L --fail -o BambuStudio.AppImage \
            "https://github.com/bambulab/BambuStudio/releases/download/$VERSION/$DATEI"
    fi
    echo "$SHA256  BambuStudio.AppImage" | sha256sum --check
    chmod +x BambuStudio.AppImage
    nice ./BambuStudio.AppImage --appimage-extract >/dev/null
    rm BambuStudio.AppImage
fi

fehlt() {
    LD_LIBRARY_PATH="$ZIEL/squashfs-root/bin:$BIBLIOTHEKEN" \
        ldd squashfs-root/bin/bambu-studio | grep "not found" || true
}
BIBLIOTHEKEN="$ZIEL/sysroot/usr/lib/x86_64-linux-gnu"

if [ -n "$(fehlt)" ]; then
    # Alle Abhängigkeiten der vier Pakete, soweit sie nicht schon installiert sind.
    alle=$(apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts \
               --no-breaks --no-replaces --no-enhances $PAKETE | grep '^[a-z0-9]' | sort -u)
    for p in $alle; do
        dpkg -s "$p" >/dev/null 2>&1 && continue
        (cd debs && apt-get download "$p" >/dev/null 2>&1) || echo "übersprungen (kein Paket): $p"
    done
    for d in debs/*.deb; do dpkg -x "$d" sysroot; done
    rm -rf debs sysroot/usr/share
fi

if [ -n "$(fehlt)" ]; then
    echo "Es fehlen weiterhin Bibliotheken:" >&2
    fehlt >&2
    exit 1
fi
echo "Bambu Studio bereit: $ZIEL/squashfs-root/bin/bambu-studio"
echo "Bibliotheken:        $BIBLIOTHEKEN"
