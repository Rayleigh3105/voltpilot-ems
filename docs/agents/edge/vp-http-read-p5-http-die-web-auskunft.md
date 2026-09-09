# vp-http-read (P5-HTTP): die Web-Auskunft des BMS auf der Box

Angelegt am 09.09.2026. Cloud-Seite, Kontrakt und die volle Begründung: root `AGENTS.md` →
`docs/agents/root/der-http-json-lesetyp-p5-http-ebene-1.md`. Der MQTT-Zwilling steht daneben
(`vp-mqtt-read-p5-die-selbst-angebundene.md`); **hier steht nur, was ANDERS ist.**

Palette **0.12.0** bringt `nodes/vp-http-read.js` (Katalogtyp `vp.http.read`) und
`lib/http-mapping.js`. Der Knoten fragt im Takt EINE JSON-Auskunft im Kundennetz ab
(`GET http://<host>:<port><pfad>`) und bildet ihre Felder auf DIESELBEN Standard-
Batteriekanäle ab wie `vp-mqtt-read`; das Ergebnis reist als ganz normale Entitäts-Telemetrie
auf `edge/entities/{id}/telemetry`.

## Die Regeln, die halten müssen

- **`lib/http-mapping.js` TEILT SICH die zweite Rechenhälfte mit `mqtt-mapping.js`.** `convert`
  (Sentinel = fehlend, Wahrheitswert-Vokabular, scale/offset) und `aggregate` (min/max/sum/avg/
  count/last) leben dort und werden hier BENUTZT, nicht kopiert. Zwei Kopien derselben
  Ehrlichkeitsregel hätten `soc_pct` je Transport eine andere Bedeutung geben können.
- **`collect(doc, path)` ist der einzige eigene Schritt:** alle Rohwerte an einem
  punkt-getrennten Wertepfad, in dem `*` ein GANZES Segment ersetzt (Liste oder Objekt).
  `cells.*.v` ist das Gegenstück zum Topic-Filter — ohne es wäre `min`/`max` hier bedeutungslos.
  Die Schranke `MAX_SOURCES` (512) gilt unverändert und SCHWEIGT nicht.
- **Kein `stale_s`.** Eine Antwort ist EIN Zeitpunkt; `decode` aggregiert nur innerhalb dieser
  einen Antwort (`staleMs = 0`). Ein Fehlschlag veröffentlicht GAR NICHTS — eine vorige Antwort
  noch einmal zu senden wäre ein Messwert von damals mit dem Zeitstempel von jetzt.
- **EIN Flug je HOST**, auf Modul-Ebene (`inFlight`, Schlüssel `host:port`): ein Takt, der auf
  eine laufende Abfrage trifft, wird ÜBERSPRUNGEN statt gestapelt. Zwei Anschlüsse auf demselben
  Host sind dasselbe Gerät, und ein BMS mit einem einzigen Web-Server hält keine Warteschlange
  aus.
- **Jeder Fehlschlag heißt beim Namen** — wörtlich das testconn-Vokabular aus `test-read.js`:
  `unreachable` (Verbindungsfehler), `no_answer` (Zeitablauf), `invalid_response` (HTTP ≥ 400,
  kein JSON, zu große Antwort). ⚠ Ein 401 ist `invalid_response`, nicht `no_answer`: die
  Anmeldung wurde ABGELEHNT, das Gerät schweigt nicht.
- **LAN-only, auf der BOX geprüft** (`lib/private-host.js`) und **nur lesend** (GET) — wie beim
  MQTT-Zwilling, aus denselben Gründen.

## ⚠ Das Geheimnis kommt aus der Entitäts-Konfiguration, NIE aus dem Flow

Der Flow trägt nur `auth: { mode, header?, username? }`. Den WERT liest der Knoten aus dem
retained `edge/entities/{id}/config` (`driver.connection.auth_secret`) — dem Kanal, über den
jedes andere Gerätekennwort dieser Box auch kommt. Grund: ein Flow-Dokument ist über die
Portal-API für jeden Benutzer des Mandanten lesbar.

`secretFrom()` prüft dabei die IDENTITÄT (`entity_id`) — eine Konfiguration, die eine ANDERE
Entität nennt, wird verworfen statt ihr Kennwort zu benutzen. Solange kein Schlüssel angekommen
ist, wird NICHT abgefragt: Status „Zugangsdaten fehlen", denn ein 401 sähe aus wie ein
Gerätefehler, den niemand verschuldet hat.

## ⚠ `componentapply` überspringt sie — dieselbe Rollout-Falle

`componentapply.CommunicationHTTPLocal` (`http_local`) ist der Zwilling der Cloud-Konstante und
steht in `isSelfRead`. **Eine Box ohne diese Konstante lässt den GANZEN Push fallen** (`Derive`
ist alles-oder-nichts, und eine solche Batterie trägt konstruktionsbedingt keine Marke) — das
Edge-Release muss eine Anlage erreichen, bevor dort die erste HTTP-Batterie entsteht. Anders als
bei `mqtt_local` trägt ihr Treiberblock hier auch WIRKLICH etwas, das die Box braucht: das
`auth_secret`.

## Tests

```bash
(cd edge-app/nodered/vp-palette && npx mocha test/http_read_spec.js --timeout 15000 --exit)
(cd edge-app/nodered/flowc && node --test compile.test.js)
(cd edge-app/core && go test ./internal/componentapply/...)
```

`test/http_read_spec.js` fährt den Vorlagen-Fall (DIYBMS v4 `/ha`) erst als reine Rechnung und
dann am laufenden Knoten gegen einen echten HTTP-Server im Prozess: die Kopfzeile reist mit, ein
Fehlschlag veröffentlicht nichts, ohne Zugangsdaten wird gar nicht abgefragt, und drei
gleichzeitige Takte ergeben genau EINE Abfrage.
