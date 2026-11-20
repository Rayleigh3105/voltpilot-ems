# Gemeinsame Helfer der Attrappe "PFC200 ab Werk" (wird eingelesen, nicht
# ausgefuehrt). Die Werkzeuge daneben spielen die WAGO-Werkzeuge unter
# /etc/config-tools nach, so wie ihre Hilfetexte und Skripte am Geraet
# (750-8212, Firmware 03.10.08(22)) sie zeigen. Sie halten ihren Zustand in
# Dateien unter VP_PFC_WURZEL (dem Sandkasten der Go-Attrappe,
# internal/attrappe/pfc200.go); ausserhalb davon fassen sie nichts an. Was am
# echten Geraet danach von selbst geschieht (der SSH-Dienst startet neu, das
# Netz wechselt), spielt die Go-Attrappe aus diesem Zustand nach.
W="${VP_PFC_WURZEL:?VP_PFC_WURZEL fehlt: die Attrappe laeuft nur im Sandkasten}"
Z="$W/var/lib/pfc-attrappe"

# lies <datei> <vorgabe>
lies() { if [ -f "$Z/$1" ]; then cat "$Z/$1"; else printf '%s\n' "$2"; fi; }
# setze <datei> <wert>
setze() {
  mkdir -p "$(dirname "$Z/$1")"
  printf '%s\n' "$2" >"$Z/$1.neu" && mv -f "$Z/$1.neu" "$Z/$1"
}
# merke <text...> - jede Aenderung steht in der Liste der Aufrufe (Tests).
merke() { mkdir -p "$Z"; printf '%s %s\n' "$(basename "$0")" "$*" >>"$Z/aufrufe"; }
# param <name> <argumente...> - der Wert von name=wert (das letzte gilt)
param() {
  _n="$1"
  shift
  _w=""
  for _a in "$@"; do
    case "$_a" in "$_n"=*) _w="${_a#*=}" ;; esac
  done
  printf '%s' "$_w"
}
# hat <name> <argumente...> - steht name=… in den Argumenten?
hat() {
  _n="$1"
  shift
  for _a in "$@"; do
    case "$_a" in "$_n"=*) return 0 ;; esac
  done
  return 1
}
# falsch <text> - wie die Werkzeuge: Fehlertext, Ausgang ungleich 0
falsch() {
  echo "$(basename "$0"): $*" >&2
  exit 3
}
ip4() {
  case "$1" in
    *[!0-9.]* | "" | *..* | .* | *.) return 1 ;;
  esac
  _alt="$IFS"
  IFS=.
  # shellcheck disable=SC2086 # bewusst an den Punkten geteilt
  set -- $1
  IFS="$_alt"
  [ "$#" = 4 ] || return 1
  for _t in "$@"; do [ "$_t" -le 255 ] 2>/dev/null || return 1; done
  return 0
}
