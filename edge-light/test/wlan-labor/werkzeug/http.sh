# Roher HTTP-Aufruf fuer die Laeufe (mit ". " laden). uclient-fetch kann
# weder eigene Header noch Cookies, und die Einrichtungs-API verlangt beides
# (JSON-Inhaltstyp, Sitzungs-Cookie) - also HTTP/1.0 von Hand ueber busybox nc.
#
#   http_ruf <ns|-> <adresse> <port> <methode> <pfad> [cookie] [json-body]
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
  if [ "$h_ns" = - ]; then
    nc -w 10 "$h_adr" "$h_port" </tmp/http.anfrage 2>/dev/null | tr -d '\r' >/tmp/http.antwort
  else
    ip netns exec "$h_ns" nc -w 10 "$h_adr" "$h_port" </tmp/http.anfrage 2>/dev/null | tr -d '\r' >/tmp/http.antwort
  fi
  cat /tmp/http.antwort
}
# http_status: der Status der letzten Antwort (z. B. 200)
http_status() { head -n 1 /tmp/http.antwort | cut -d' ' -f2; }
# http_cookie: die Sitzungsmarke aus der letzten Antwort
http_cookie() { sed -n 's/^Set-Cookie: vp_einricht=\([^;]*\).*/\1/p' /tmp/http.antwort | head -n 1; }
