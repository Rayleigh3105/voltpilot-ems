# Dateien in Probe-Container bringen, ohne Bind-Mount (wird von den Proben
# mit "." eingelesen, kein eigenes Programm).
#
# Auf dem Forgejo-Runner fährt der Job selbst in einem Container am
# Docker-Socket des Hosts: Ein Pfad aus dem Job (mktemp, Workspace) existiert
# für den Daemon nicht, ein "-v $TMP/...:..." hängt dort ein leeres Verzeichnis
# des Hosts ein (docs/agents/root/production-deployment-single-vm-vps-depl.md).
# docker cp streamt dagegen aus dem Dateisystem des Clients - derselbe Weg auf
# dem Laptop wie auf dem Runner.

# volumen_aus <volume> <verzeichnis> <bild>: legt das Volume an und kopiert den
# Inhalt des Verzeichnisses hinein (über einen nie gestarteten Hilfscontainer).
volumen_aus() {
  docker volume create "$1" >/dev/null
  docker create --name "$1-fuellen" -v "$1:/v" --entrypoint true "$3" >/dev/null
  docker cp "$2/." "$1-fuellen:/v"
  docker rm "$1-fuellen" >/dev/null
}

# volumen_nach <volume> <verzeichnis> <bild>: kopiert den Inhalt des Volumes
# in das (vorhandene) Verzeichnis.
volumen_nach() {
  docker create --name "$1-lesen" -v "$1:/v" --entrypoint true "$3" >/dev/null
  docker cp "$1-lesen:/v/." "$2"
  docker rm "$1-lesen" >/dev/null
}
