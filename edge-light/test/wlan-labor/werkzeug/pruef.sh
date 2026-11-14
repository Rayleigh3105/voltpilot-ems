# Pruefhelfer im Gast (wird mit "." geladen). Jede Pruefung schreibt genau eine
# Zeile "PRUEF ok <text>" oder "PRUEF FEHLER <text>"; wlan-anschluss-probe.sh
# zaehlt sie auf dem Rechner aus. Zeilen "INFO <text>" sind Messwerte ohne Urteil.
pruef_ok() { echo "PRUEF ok $*"; }
pruef_fehler() { echo "PRUEF FEHLER $*"; }
info() { echo "INFO $*"; }
# pruefe <text> <befehl ...>: erwartet Rueckgabe 0
pruefe() {
  p_t="$1"
  shift
  if "$@" >/dev/null 2>&1; then pruef_ok "$p_t"; else pruef_fehler "$p_t"; fi
}
# verneine <text> <befehl ...>: erwartet eine Rueckgabe ungleich 0
verneine() {
  p_t="$1"
  shift
  if "$@" >/dev/null 2>&1; then pruef_fehler "$p_t"; else pruef_ok "$p_t"; fi
}
# gleich <text> <ist> <soll>
gleich() {
  if [ "$2" = "$3" ]; then pruef_ok "$1 ($2)"; else pruef_fehler "$1 (ist '$2', soll '$3')"; fi
}
# wert <schluessel> <datei>: Wert aus einer Ausgabe "schluessel=wert"
wert() { sed -n "s/^$1=//p" "$2" | head -n 1; }
# tcp <ns|-> <adresse> <port>: 0, wenn der Port antwortet (auch wenn kein HTTP
# dahinter steht, etwa SSH); 1 bei abgewiesen, Zeitueberschreitung oder keinem
# Weg. Die Stellvertreter-Dienste sind uhttpd. Eine Regel REJECT der Firewall
# meldet uclient-fetch hier als "Operation not permitted".
tcp() {
  if [ "$1" = - ]; then t_aus="$(uclient-fetch -q -T 4 -O /dev/null "http://$2:$3/" 2>&1)"; else
    t_aus="$(ip netns exec "$1" uclient-fetch -q -T 4 -O /dev/null "http://$2:$3/" 2>&1)"; fi
  t_rc=$?
  [ "$t_rc" -eq 0 ] && return 0
  case "$t_aus" in
    *refused* | *"not permitted"* | *"timed out"* | *[Uu]nreachable* | *"No route"* | *"Connection failed"*) return 1 ;;
  esac
  return 0
}
# tcp_meldung <ns|-> <adresse> <port>: was uclient-fetch sagt (fuer INFO)
tcp_meldung() {
  if [ "$1" = - ]; then uclient-fetch -q -T 4 -O /dev/null "http://$2:$3/" 2>&1 | head -n 1; else
    ip netns exec "$1" uclient-fetch -q -T 4 -O /dev/null "http://$2:$3/" 2>&1 | head -n 1; fi
}
# dhcp_neu <ns> <schnittstelle>: das Geraet fragt neu nach einer Adresse; gibt sie aus
dhcp_neu() {
  ip netns exec "$1" udhcpc -i "$2" -s /tmp/udhcpc.sh -q -n -t 10 >/dev/null 2>&1
  ip netns exec "$1" ip -4 -o addr show "$2" | awk '{print $4}' | cut -d/ -f1 | head -n 1
}
