# Die Box meldet ihre Adresse im KUNDEN-LAN — getrennt vom Zugriffsweg

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 76).


`internal/netinfo` + `agent/network.go` (Konzept `data/vp-anlagen-zentrale-konzept-h6`
D5). Sie beantwortet die eine Frage, die der Container über sich selbst nie
sagen konnte: unter welcher Host-Adresse ist er im Kundennetz erreichbar? **Reine
ANZEIGE — es entsteht kein Schreibweg und keine Entscheidung.**

- **⚠ `net.Interfaces()` ist hier die FALSCHE Antwort.** Der Core läuft in einem
  bridge-vernetzten Container mit veröffentlichten Ports, seine Schnittstelle
  trägt also die Docker-Bridge-Adresse (172.x) — wahr über den Container,
  nutzlos für den Kunden. Sie als „Adresse Ihrer Box" zu melden wäre eine
  erfundene Antwort. Gemeldet wird sie deshalb NUR, wenn der Prozess NICHT in
  einem Container läuft (`/.dockerenv` bzw. cgroup), und bei mehreren
  Kandidaten GAR KEINE.
- **Die Antwort kommt vom HOST:** `install.sh` liest zuerst die Source-Adresse
  der IPv4-Default-Route, verwirft WireGuard-/Tunnel-/Tailscale-/Docker-Interfaces
  und schreibt sie samt Web-Port als `VP_LAN_HOST`. Der Betreiber darf den Wert
  fuer statische/ungewoehnliche Netze explizit setzen. Core UND Updater erhalten
  ihn, damit ein autonomes Compose-Update ihn nicht verliert.
- **Der HTTP-`Host`-Kopf ist nur noch ein Legacy-Fallback:** Dockers DNAT laesst
  ihn zwar unveraendert, aber ein Supporter kann `:8484` ueber das VPN aufrufen.
  Dieser Zugriff ist dann wahr, aber fuer den Kunden unbrauchbar.
  `agent.WebObserver` speichert ihn weiter getrennt; ein beobachtetes
  `10.10.x.x` darf `VP_LAN_HOST=192.168.x.x:8484` nie ueberschreiben.
- **`network.lan_host` wird strenger gefiltert:** nur private/link-lokale
  IPv4/IPv6-Adressen oder `.local`/`.lan`/`.home.arpa`-Namen inklusive gueltigem
  Port. **Beim beobachteten Host verworfen wird, was kein Zweiter tippen kann:** Loopback und `localhost`
  (genau das schickt der Installer-Selbsttest bei jedem Start), ein leerer Wert
  und ein PUNKTLOSER Hostname (`voltpilot` — er löst nur in fremden Suchdomänen
  auf). Alles andere reist VERBATIM inklusive Port.
- **`<data>/network.json` (tmp+rename, EIN Schreiber)** lässt die Adresse einen
  Neustart überleben — sonst wäre sie nach jedem Update genau dann unbekannt,
  wenn jemand sie sucht. Älter als 14 Tage gilt sie nicht mehr: eine falsche
  Adresse schickt einen Menschen auf eine Seite, die nicht antwortet.
- **Der Block hängt am LINK, nicht an einem Aufruf-Argument** (`cloud.Options.NetworkFn`,
  das `Version`-Muster) — kein künftiger Aufrufer kann ihn vergessen, und die
  Antwort ändert sich (DHCP, oder der erste Aufruf der lokalen Oberfläche).
  `NetworkSummary` traegt `lan_host` und den beobachteten `host` GETRENNT.
  **Weiß die Box nichts, wird GAR KEIN Block gesendet** und der Herzschlag
  bleibt byte-gleich zu vorher.
- **Bewusst NICHT gebaut:** die `:8484`-Fläche zeigt die Adresse nicht (wer dort
  ist, hat sie gerade benutzt). Die naheliegende Folgearbeit ist der
  OCPP-Anbinden-Dialog, der bis heute keine Box-Adresse nennen kann.
- Beweise: `internal/netinfo/netinfo_test.go` · `agent/network_test.go` (LAN
  gewinnt gegen VPN-Serviceaufruf) ·
  `cloud/status_test.go` (die Draht-Form gegen einen echten In-Process-Broker).

