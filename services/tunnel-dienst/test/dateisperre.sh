#!/bin/sh
# Prüft den Prozess der Schlüsselausgabe (den "Schalter") auf einem Kernel
# mit aktivem Landlock: Rechte abgelegt, Dateizugriff gesperrt, und er
# antwortet danach weiter.
#
# Warum eine eigene Probe: test/integration.sh läuft in Containern auf dem
# Kernel des Rechners. Ist Landlock dort nicht eingeschaltet (so auf der
# Arbeitsmaschine: "operation not supported"), bleibt die Dateisperre dort
# ungeprüft. Diese Probe startet deshalb eine kleine VM mit dem Kernel von
# Debian 13, dem Kernel der Wartungs-VM - mit QEMU ohne KVM, also langsam,
# aber ohne besondere Rechte. In der VM läuft nur test/schalterprobe: kein
# WireGuard, kein nftables.
#
# Aufruf aus dem Repo:   services/tunnel-dienst/test/dateisperre.sh
# Ohne DNS im Container: VPTD_DOCKER_DNS=1.1.1.1 …
# Voraussetzung: Docker und Netz (lädt QEMU und das Kernel-Paket von Debian).
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
MODUL="$(cd "$HIER/.." && pwd -P)"
DNS="${VPTD_DOCKER_DNS:+--dns $VPTD_DOCKER_DNS}"
W="$(mktemp -d)"
chmod 755 "$W"
trap 'rm -rf "$W"' EXIT INT TERM

echo "== Bauen (ohne cgo, wie für die VM)"
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e GOCACHE=/tmp/gocache -e CGO_ENABLED=0 -e GOFLAGS=-buildvcs=false \
  -v "$MODUL":/src:ro -v "$W":/out -w /src golang:1.24 \
  sh -c 'go build -o /out/vp-tunnel-dienst ./cmd/vp-tunnel-dienst && go build -o /out/schalterprobe ./test/schalterprobe'

cat > "$W/init" <<'EOF'
#!/bin/busybox sh
/bin/busybox mount -t devtmpfs dev /dev
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sys /sys
/bin/busybox mount -t securityfs securityfs /sys/kernel/security
echo "KERNEL $(/bin/busybox uname -r)"
echo "LSM $(/bin/busybox cat /sys/kernel/security/lsm)"
/bin/busybox ip link set lo up
/schalterprobe /vp-tunnel-dienst
echo "RC $?"
/bin/busybox poweroff -f
EOF

cat > "$W/innen.sh" <<'EOF'
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq install -y --no-install-recommends qemu-system-x86 busybox-static cpio >/dev/null
cd /tmp
paket="$(apt-cache depends linux-image-amd64 | sed -n 's/^ *Depends: \(linux-image-[^ ]*\)$/\1/p' | head -n 1)"
apt-get -qq download "$paket"
dpkg-deb -x "$paket"_*.deb /k
mkdir -p /r/bin /r/dev /r/proc /r/sys /r/tmp
cp /bin/busybox /r/bin/busybox
cp /w/vp-tunnel-dienst /w/schalterprobe /w/init /r/
chmod 755 /r/init /r/vp-tunnel-dienst /r/schalterprobe
(cd /r && find . | cpio -o -H newc 2>/dev/null | gzip -1) > /tmp/initramfs.gz
echo "== VM mit $paket (QEMU ohne KVM, das dauert)"
timeout 900 qemu-system-x86_64 -accel tcg -m 512 -nographic -no-reboot \
  -kernel /k/boot/vmlinuz-* -initrd /tmp/initramfs.gz -append "console=ttyS0 panic=-1 loglevel=3"
EOF

echo "== VM vorbereiten"
# shellcheck disable=SC2086 # DNS bewusst als Wortliste
docker run --rm $DNS -v "$W":/w:ro debian:trixie-slim sh /w/innen.sh 2>&1 | tr -d '\r' | tee "$W/log" |
  grep -E '^(==|KERNEL|LSM|RC|SCHALTERPROBE|  ok|  FEHLER|time=.*Schlüsselausgabe)' || true

echo "== Ergebnis"
fehler=0
pruefe() { if grep -q -- "$1" "$W/log"; then echo "  ok      $2"; else fehler=$((fehler + 1)); echo "  FEHLER  $2"; fi; }
pruefe '^LSM .*landlock' "Landlock ist in diesem Kernel eingeschaltet"
pruefe 'msg="Schlüsselausgabe lauscht".*rechte=keine dateizugriff=gesperrt' "Startzeile: Rechte abgelegt, Dateizugriff gesperrt"
pruefe '^SCHALTERPROBE 0 Fehler' "Schalter antwortet einer Box, vor und nach der Sperre, ohne Capabilities"
if [ "$fehler" -ne 0 ]; then
  echo "--- Ausgabe der VM"; cat "$W/log"
  exit 1
fi
