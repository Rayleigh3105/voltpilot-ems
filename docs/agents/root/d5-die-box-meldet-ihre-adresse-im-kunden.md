# D5: die Box meldet ihre Adresse im KUNDEN-LAN, getrennt vom Zugriffsweg

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 139).


Anlagen-Zentrale Stufe 2 PR 2c (Konzept `data/vp-anlagen-zentrale-konzept-h6`
§8.3 + Captain-Entscheid **D5: ja, additives Feld, NUR Anzeige**). Additiv auf
allen drei Ebenen; eine ältere Box und ein älteres Portal verhalten sich
zeichengleich wie vorher.

- **Die Lücke war belegt und hat zwei Support-Runden gekostet:** das Portal
  zeigt JEDE Geräte-Adresse (die Box speichert sie), aber nicht die eigene — und
  für den Kunden ist sie der Weg zur lokalen Oberfläche, für den Support die
  erste Frage am Telefon. Es gab dafür kein Feld und keinen Uplink.
- **⚠ DIE CONTAINER-INTERFACE-ADRESSE IST NICHT DIE ANTWORT.** Der Core läuft in
  einem bridge-vernetzten Container; `net.Interfaces()` sieht dort nur die
  Docker-Adresse. Darum erkennt `install.sh` die Default-Route des HOSTS,
  verwirft VPN-/Tunnel-/Docker-Interfaces und schreibt den erreichbaren
  Endpunkt inklusive Port als `VP_LAN_HOST`. Eine statische Installation darf
  ihn explizit setzen; Core UND Updater bekommen denselben Wert, damit er auch
  autonome Updates ueberlebt.
- **Der HTTP-`Host`-Kopf bleibt nur der Fallback, nie mehr die staerkere
  Wahrheit.** Er beweist zwar, unter welcher Adresse eine Anfrage funktioniert
  hat, kann aber von einem Support-Aufruf ueber WireGuard/Tailscale stammen und
  damit fuer den Kunden unerreichbar sein. `network.lan_host` und
  `network.host` reisen deshalb GETRENNT; ein VPN-Aufruf darf die konfigurierte
  Kunden-LAN-Adresse nicht ueberschreiben.
- **Die automatisch gelesene Prozess-Interface-Adresse reist NUR ohne Container** (`/.dockerenv` bzw.
  cgroup), damit sie nie mit einer erreichbaren verwechselt werden kann; bei
  mehreren Kandidaten wird GAR KEINE gemeldet statt einer geratenen. Eine
  Adresse älter als 14 Tage gilt nicht mehr — eine falsche Adresse ist schlimmer
  als keine.
- **Draht:** additiver Top-Level-Block `network` im Herzschlag
  (`cloud.NetworkSummary`, gespeist über `Options.NetworkFn` — er hängt am LINK
  wie `version`, damit kein künftiger Aufrufer ihn vergessen kann, und weil die
  Antwort sich ändert). **Eine Box, die nichts weiß, sendet GAR KEINEN Block** —
  der Herzschlag bleibt byte-gleich und das Portal behält seinen ehrlichen Satz.
- **⚠ Der Ingest hängt am `UpdateStatusListener`, NICHT an einem eigenen
  Geschwister.** `network` ist ein TOP-LEVEL-Block wie `version`, und dies ist
  der eine Zuhörer, der ohne Unterblock nicht früh zurückkehrt — genau die
  Eigenschaft, für die er in OTA Stufe 0 entstanden ist. Ein eigener wäre eine
  zweite Broker-Verbindung, eine zweite Identitätsprüfung für dieselben Bytes
  UND ein neues, per Vorgabe ausgeschaltetes Flag, das im gitops-Repo
  nachgezogen werden müsste (die dokumentierte Falle). Er schreibt dafür in ein
  ANDERES Repository — ein Zuhörer ist ein Transportweg, keine Tabelle.
- **Speicher: drei additive Spalten auf `device`** (Migration
  `V20260832000000`), nicht eine — `lan_source` unterscheidet den vom Installer
  konfigurierten Kunden-LAN-Endpunkt (`schnittstelle`, HOECHSTE Prioritaet) vom
  beobachteten HTTP-Zugriff (`erreicht`, Legacy-Fallback); `lan_seen_at` ist ihr
  eigener Frische-Anker. Beides-oder-keines als CHECK. Sie reisen auf
  `DeviceDto` → `GET /devices`, also **ohne neuen Endpunkt und ohne zusätzlichen
  Abruf** — Zentrale, Geräteseite und Schaltbild laden die Geräteliste ohnehin.
  `DeviceDto` behält dafür einen 8-stelligen Bequemlichkeits-Konstruktor (jede
  Test-Attrappe bleibt unverändert, und `null` ist dort die ehrliche Antwort).
- **⚠ Ein Herzschlag OHNE den Block schreibt GAR NICHTS** — eine gespeicherte
  Adresse überlebt damit eine stille Strecke, statt zu verschwinden.
- **Bewusst NICHT gebaut:** die `:8484`-Fläche zeigt die Adresse nicht (wer dort
  ist, hat sie gerade benutzt). Die naheliegende Folgearbeit ist der
  OCPP-Anbinden-Dialog, dessen `ws://<box>:8887/…` bis heute die Adresse NICHT
  nennen kann („Das Portal behauptet KEINE Box-Adresse") — mit einer bewiesenen
  Adresse könnte er es.
- **Beweise:** Go `internal/netinfo` (private LAN-Whitelist, Host-Whitelist,
  Neustart, Verfall, Loopback, Container-Regel) · `agent/network_test.go` (eine
  konfigurierte LAN-Adresse ueberlebt einen VPN-Serviceaufruf; Beobachter aendert
  keine Antwort; ohne Wissen KEIN Block) · `cloud/status_test.go` (die Draht-Form gegen einen
  echten In-Process-Broker, und der weggelassene Block) · api
  `UpdateStatusListenerTest` (konfiguriertes LAN schlaegt VPN-Host, Legacy-Fallback,
  ohne Block kein Schreiben, leerer Block, gefälschte Identität, nur-Adresse)
  · `PortalApiTest.theBoxOwnReachabilityIsIngestedAndTenantScoped` (echte DB,
  echter Zuhörer, RLS) · Portal `geraetSeite.test.ts`/`schaltbild.test.ts`.

