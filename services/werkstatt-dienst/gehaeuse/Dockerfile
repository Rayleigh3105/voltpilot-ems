# Bau-Image der Gehäuse-Druckdatei (Werkstatt-Automatik P10, PS-8): Debian 13
# mit dem Gehäuse-Programm (edge-light/gehaeuse/glinet-gl-mt300n-v2), seiner
# Python-Umgebung und Bambu Studio für die Prüfung aus dem G-Code. Bambu Studio
# gibt es kopflos nur als AppImage für x86_64, darum nur linux/amd64.
#
# Der Werkstatt-Dienst startet es je Box als Kubernetes-Job (internal/gehaeuse):
#   args: [<referenz>]  ->  bauen.sh --referenz <referenz>
# Ausgabe nach aus/ des Programms (dort hängt der Job den Unterordner der Ablage
# ein): aus/kennung/<referenz>/ und aus/ausgabe.log. Läuft als 10001 mit
# schreibgeschütztem Dateisystem; schreibbar sind nur aus/ und /tmp (HOME).
#
# Bauen, Kontext ist die Wurzel des Repositorys (Dockerfile.dockerignore):
#   docker buildx build --platform linux/amd64 -f services/werkstatt-dienst/gehaeuse/Dockerfile .
FROM --platform=linux/amd64 debian:13-slim

# Wie werkzeug/bambu_einrichten.sh: Fassung und Prüfsumme fest.
ARG BAMBU_VERSION=v02.08.02.61
ARG BAMBU_DATEI=BambuStudio_ubuntu24.04-v02.08.02.61-20260820225108.AppImage
ARG BAMBU_SHA256=d501b103fac5424513ec0e8d6bc145fb30719de2c7d94d7320d723740c81a7fd

# python3 für das Programm und die Werkzeuge des Slicer-Laufs; die Bibliotheken
# für OCP (build123d), cairosvg und Bambu Studio (WebKit, GStreamer, GTK, GL).
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl python3 python3-venv squashfs-tools \
      libgl1 libegl1 libglu1-mesa libx11-6 libxext6 libxrender1 libxi6 libxrandr2 libxcursor1 libxinerama1 \
      libsm6 libice6 libxt6 libfontconfig1 libfreetype6 libcairo2 libgomp1 \
      libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0 libgtk-3-0t64 \
      libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 libsecret-1-0 libosmesa6 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/vp/edge-light/gehaeuse/glinet-gl-mt300n-v2

# Python-Umgebung zuerst: ändert sich nur mit anforderungen.txt.
COPY edge-light/gehaeuse/glinet-gl-mt300n-v2/anforderungen.txt ./
RUN python3 -m venv .venv \
 && .venv/bin/pip install --no-cache-dir --disable-pip-version-check -r anforderungen.txt \
 && .venv/bin/python -c "import build123d, lib3mf, zxingcpp; print('build123d', build123d.__version__)"

# Bambu Studio dort, wo bauen.sh es sucht (.werkzeug/bambu/squashfs-root).
# Entpackt ohne das AppImage auszuführen: Sein squashfs beginnt hinter dem
# ELF-Teil (Ende der Abschnittstabelle). So geht es auch emuliert; binfmt
# nimmt ein AppImage wegen seiner Kennung im ELF-Kopf nicht an.
RUN mkdir -p .werkzeug/bambu && cd .werkzeug/bambu \
 && curl -L --fail -sS -o BambuStudio.AppImage \
      "https://github.com/bambulab/BambuStudio/releases/download/${BAMBU_VERSION}/${BAMBU_DATEI}" \
 && echo "${BAMBU_SHA256}  BambuStudio.AppImage" | sha256sum --check \
 && versatz=$(python3 -c 'import struct,sys; h=open(sys.argv[1],"rb").read(64); print(struct.unpack_from("<Q",h,0x28)[0] + struct.unpack_from("<H",h,0x3A)[0] * struct.unpack_from("<H",h,0x3C)[0])' BambuStudio.AppImage) \
 && unsquashfs -q -n -d squashfs-root -o "$versatz" BambuStudio.AppImage >/dev/null \
 && rm BambuStudio.AppImage \
 && fehlt=$(LD_LIBRARY_PATH=squashfs-root/bin ldd squashfs-root/bin/bambu-studio | grep "not found" || true) \
 && if [ -n "$fehlt" ]; then echo "Bambu Studio: es fehlen Bibliotheken:" >&2; echo "$fehlt" >&2; exit 1; fi

# Die Vektoren, gegen die das Programm die Kennung prüft (kennung.py: REPO/docs/contracts).
COPY docs/contracts/werkstatt-beschriftung.json docs/contracts/edge-ref-vectors.json /opt/vp/docs/contracts/
COPY edge-light/gehaeuse/glinet-gl-mt300n-v2/ ./
COPY services/werkstatt-dienst/gehaeuse/gehaeuse-job.sh /usr/local/bin/gehaeuse-job

RUN useradd --system --uid 10001 --user-group --no-create-home --home-dir /tmp werkstatt \
 && mkdir -p aus && chown 10001:10001 aus

USER 10001:10001
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["/usr/local/bin/gehaeuse-job"]
