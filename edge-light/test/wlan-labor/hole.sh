#!/bin/sh
# Holt alles, was das WLAN-Labor braucht, in einen Zwischenspeicher AUSSERHALB
# des Repos (Abbilder und Pakete gehoeren nicht ins Repo):
#
#   edge-light/test/wlan-labor/hole.sh [<zwischenspeicher>]
#     Vorgabe: $VP_WLAN_LABOR_CACHE, sonst ~/.cache/vp-wlan-labor
#
#   dl/      OpenWrt 25.12.5 x86/generic: Kernel und ext4-Abbild (entpackt),
#            SeaBIOS und VGA-BIOS des Emulators v86 - alles gegen die
#            Pruefsummen unten
#   node/    v86 0.5.473 aus der npm-Registry (package-lock.json hier)
#   repo/    die vier Paketindizes von 25.12.5 und die Pakete aus pakete.txt;
#            ihre Signaturen prueft apk im Gast gegen den Schluessel im Abbild
#
# Wiederholbar: was schon da und richtig ist, wird nicht neu geholt.
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
CACHE="${1:-${VP_WLAN_LABOR_CACHE:-$HOME/.cache/vp-wlan-labor}}"
B=https://downloads.openwrt.org/releases/25.12.5
KMODS="$B/targets/x86/generic/kmods/6.12.94-1-51074894d6e4312fd47e3ddc204b63bd"
GEN="$B/targets/x86/generic/packages"
BASE="$B/packages/i386_pentium4/base"
PKGS="$B/packages/i386_pentium4/packages"
# SeaBIOS und VGA-BIOS: Stand von copy/v86, den v86 0.5.473 mitbringen wuerde
V86_BIOS=https://raw.githubusercontent.com/copy/v86/b8a39b11dd2076870699e6cac053556271b9bfab/bios
KERNEL=openwrt-25.12.5-x86-generic-generic-kernel.bin
ROOTFS=openwrt-25.12.5-x86-generic-generic-ext4-rootfs.img.gz

mkdir -p "$CACHE/dl" "$CACHE/node" "$CACHE/repo/kmods" "$CACHE/repo/gen" "$CACHE/repo/base" "$CACHE/repo/pkgs"

if command -v sha256sum >/dev/null 2>&1; then
  pruefsumme() { sha256sum "$1" | cut -d' ' -f1; }
else
  pruefsumme() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

# hole_geprueft <url> <datei> <sha256>
hole_geprueft() {
  if [ -s "$2" ] && [ "$(pruefsumme "$2")" = "$3" ]; then return 0; fi
  echo "    hole $(basename "$2")"
  curl -sSfL -m 600 -o "$2.neu" "$1"
  if [ "$(pruefsumme "$2.neu")" != "$3" ]; then
    rm -f "$2.neu"
    echo "FEHLER: Pruefsumme von $(basename "$2") stimmt nicht" >&2
    exit 1
  fi
  mv -f "$2.neu" "$2"
}

echo "--- Abbilder und BIOS nach $CACHE/dl"
hole_geprueft "$B/targets/x86/generic/$KERNEL" "$CACHE/dl/$KERNEL" 33205d157732e800936f2cc8a61f5fb73e9678fbb5f34bf6a5f6b1548002d2f7
hole_geprueft "$B/targets/x86/generic/$ROOTFS" "$CACHE/dl/$ROOTFS" 5ceaec667dece6085b28fcc54e90fad2202ee2901d020bdcdc7f93abb64b6f99
hole_geprueft "$V86_BIOS/seabios.bin" "$CACHE/dl/seabios.bin" 73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98
hole_geprueft "$V86_BIOS/vgabios.bin" "$CACHE/dl/vgabios.bin" a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880
img="$CACHE/dl/${ROOTFS%.gz}"
if [ ! -s "$img" ] || [ "$CACHE/dl/$ROOTFS" -nt "$img" ]; then
  # gunzip meldet "trailing garbage" (Signatur am Ende des Abbilds) - harmlos.
  gunzip -c "$CACHE/dl/$ROOTFS" >"$img.neu" 2>/dev/null || [ -s "$img.neu" ]
  mv -f "$img.neu" "$img"
fi

echo "--- v86 nach $CACHE/node"
if [ ! -f "$CACHE/node/node_modules/v86/package.json" ] || ! cmp -s "$HIER/package-lock.json" "$CACHE/node/package-lock.json"; then
  cp "$HIER/package.json" "$HIER/package-lock.json" "$CACHE/node/"
  (cd "$CACHE/node" && npm_config_registry="${npm_config_registry:-https://registry.npmjs.org}" npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
fi

echo "--- Paketindizes und Pakete nach $CACHE/repo"
for r in kmods gen base pkgs; do
  case "$r" in
    kmods) u="$KMODS" ;; gen) u="$GEN" ;; base) u="$BASE" ;; pkgs) u="$PKGS" ;;
  esac
  [ -s "$CACHE/repo/$r/packages.adb" ] || curl -sSfL -m 300 -o "$CACHE/repo/$r/packages.adb" "$u/packages.adb"
done
fehlt=0
while read -r name ver; do
  [ -n "$name" ] || continue
  datei="$name-$ver.apk"
  da=""
  for r in kmods base gen pkgs; do
    [ -s "$CACHE/repo/$r/$datei" ] && { da=$r; break; }
  done
  if [ -z "$da" ]; then
    for r in kmods base gen pkgs; do
      case "$r" in
        kmods) u="$KMODS" ;; gen) u="$GEN" ;; base) u="$BASE" ;; pkgs) u="$PKGS" ;;
      esac
      # "~" in Fassungen muss in der Adresse kodiert sein
      if curl -sSf -m 120 -o "$CACHE/repo/$r/$datei" "$u/$(printf '%s' "$datei" | sed 's/~/%7E/g')" 2>/dev/null; then
        da=$r
        break
      fi
      rm -f "$CACHE/repo/$r/$datei"
    done
  fi
  if [ -z "$da" ]; then
    echo "FEHLER: $datei in keinem der vier Paketquellen" >&2
    fehlt=$((fehlt + 1))
  fi
done <"$HIER/pakete.txt"
[ "$fehlt" -eq 0 ] || exit 1
echo "--- fertig: $CACHE"
