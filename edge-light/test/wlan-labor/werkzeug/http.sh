# Roher HTTP-Aufruf fuer die Laeufe (mit ". " laden). uclient-fetch kann
# weder eigene Header noch Cookies, und die Einrichtungs-API verlangt beides
# (JSON-Inhaltstyp, Sitzungs-Cookie) - also HTTP/1.0 von Hand ueber busybox nc.
#
#   http_ruf <ns|-> <adresse> <port> <methode> <pfad> [cookie] [json-body] [frist]
#
# schreibt die ganze Antwort (ohne \r) nach /tmp/http.antwort und gibt sie
# aus. http_status und http_cookie lesen daraus.
http_ruf() {
  h_ns="$1"
  h_adr="$2"
  h_port="$3"
  h_met="$4"
  h_pfad="$5"
  h_cookie="${6:-}"
  h_body="${7:-}"
  h_frist="${8:-12}"
  {
    printf '%s %s HTTP/1.0\r\n' "$h_met" "$h_pfad"
    printf 'Host: %s\r\n' "$h_adr"
    [ -z "$h_cookie" ] || printf 'Cookie: vp_einricht=%s\r\n' "$h_cookie"
    if [ -n "$h_body" ]; then
      printf 'Content-Type: application/json\r\n'
      printf 'Content-Length: %s\r\n' "${#h_body}"
    fi
    printf '\r\n'
    [ -z "$h_body" ] || printf '%s' "$h_body"
  } >/tmp/http.anfrage
  # Waechter von Hand: die OpenWrt-busybox hat weder nc -w noch timeout
  # (gemessen: jede Antwort blieb leer), und ohne Deckel wartet ein SYN ohne
  # Antwort minutenlang (Handy gerade beim WLAN-Wechsel).
  if [ "$h_ns" = - ]; then
    nc "$h_adr" "$h_port" </tmp/http.anfrage >/tmp/http.roh 2>/dev/null &
  else
    ip netns exec "$h_ns" nc "$h_adr" "$h_port" </tmp/http.anfrage >/tmp/http.roh 2>/dev/null &
  fi
  h_pid=$!
  h_i=0
  while kill -0 "$h_pid" 2>/dev/null && [ "$h_i" -lt "$h_frist" ]; do
    sleep 1
    h_i=$((h_i + 1))
  done
  kill "$h_pid" 2>/dev/null
  wait "$h_pid" 2>/dev/null
  tr -d '\r' </tmp/http.roh >/tmp/http.antwort
  cat /tmp/http.antwort
}
# http_status: der Status der letzten Antwort (z. B. 200)
http_status() { head -n 1 /tmp/http.antwort | cut -d' ' -f2; }
# http_cookie: die Sitzungsmarke aus der letzten Antwort
http_cookie() { sed -n 's/^Set-Cookie: vp_einricht=\([^;]*\).*/\1/p' /tmp/http.antwort | head -n 1; }
