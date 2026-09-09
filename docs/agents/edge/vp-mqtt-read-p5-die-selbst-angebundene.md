# vp-mqtt-read (P5 Ebene 1): die selbst angebundene Batterie auf der Box

Angelegt am 09.09.2026. Cloud-Seite, Kontrakt und die volle Begründung: root
`AGENTS.md` → `docs/agents/root/der-generische-batterie-anschluss-p5-ebe.md`.
Konzept `data/vp-deye-diybms-luecke-l5/report.md` §3.2b, Vertrags-Entscheid D-22.

Palette **0.10.0** bringt `nodes/vp-mqtt-read.js` (Katalogtyp `vp.mqtt.read`) und
`lib/mqtt-mapping.js`. Der Knoten abonniert auf einem LOKALEN MQTT-Broker im Kundennetz die
Topics einer selbstgebauten Batterie und bildet ihre Felder per nutzer-definierter Zuordnung
auf die Standard-Batteriekanäle ab; das Ergebnis reist als ganz normale Entitäts-Telemetrie auf
`edge/entities/{id}/telemetry`. Es entsteht KEINE zweite Ingest-Mechanik.

## Die Regeln, die halten müssen

- **`lib/mqtt-mapping.js` ist die reine Rechnung** — `topicMatches` / `extract` / `convert` /
  `aggregate`, ohne Broker, ohne Node-RED, ohne Uhr (`now` reist als Parameter herein). Was aus
  einer Nachricht ein Messwert wird, ist eine Aussage über Ehrlichkeit; sie muss ohne Docker
  vollständig prüfbar sein. Der Knoten selbst hält nur Verbindung, Puffer und Status.
- **EIN Abo je DISTINKTEM Filter.** Zwei Zuordnungen auf `emon/diybms/+/+` (min und max) sind
  EIN Abo — der Broker bekommt keine doppelte Last, die Nachricht wird lokal verteilt.
- **Auslöser-getrieben veröffentlichen** (die `vp-modbus-read`-Disziplin): das Abo füllt
  dauernd den Puffer, gesendet wird im Takt des kompilierten Intervalls. Ohne das würden 176
  Zellen den Uplink mit jeder Zellmeldung fluten.
- **Der Puffer ist je Zuordnung eine Map `topic → {value, at}`**, gedeckelt auf
  `MAX_SOURCES` (512). Ein `#`-Filter auf einem belebten Broker wäre sonst unbegrenzt
  wachsender Speicher. Die Schranke SCHWEIGT nicht: `overflow` setzt den Status auf gelb und
  warnt ratenbegrenzt mit dem Hinweis, den Filter enger zu fassen.
- **Skaliert wird JE PROBE, dann aggregiert** — „min über alle Zellen in mV" heißt genau das.
- **Nie eine erfundene Zahl.** Ein Kanal ohne frische Probe fehlt in der Nachricht; hat KEIN
  Kanal einen frischen Wert, wird gar nichts veröffentlicht (der Status sagt, ob überhaupt
  etwas ankam). Ein `sentinel`-Rohwert und ein Wort außerhalb der Wahrheitswert-Liste sind
  FEHLEND, nie 0.
- **LAN-only, auf der BOX geprüft** (`lib/private-host.js`): ein ausgerollter Flow ist eine
  Anweisung von außen, und wer eine Verbindung öffnet, prüft ihr Ziel selbst. Der Knoten
  abonniert dann gar nichts und sagt laut warum.
- **Nur lesend.** Auf den Kunden-Broker schreibt der Knoten nie; veröffentlicht wird
  ausschließlich auf dem lokalen VoltPilot-Bus.
- **Keine Broker-Anmeldedaten** — bewusst: ein Kennwort in einem retained ausgerollten
  Flow-Dokument wäre ein Klartext-Geheimnis. Der Geheimnis-Weg kommt mit dem HTTP-Lesetyp.

## ⚠ `componentapply` überspringt sie — und das ist tragend

`componentapply.CommunicationMqttLocal` (`mqtt_local`) ist der Zwilling der Cloud-Konstante.
`ParseDriver` überspringt so eine Komponente VOR der Marken-Prüfung, weil `Derive`
alles-oder-nichts ist und eine MQTT-Batterie konstruktionsbedingt keine Marke trägt. **Eine Box
ohne diese Konstante lässt den GANZEN Push fallen** — das Edge-Release muss eine Anlage
erreichen, bevor dort die erste eigene Batterie angelegt wird.

`IsSelfBuilt` bleibt dagegen auf `modbus_baukasten`: die `:8484`-Gerätekarte ist Modbus-geformt
(Adresse, Unit-ID, Kanalliste), und eine MQTT-Batterie hätte davon nichts — eine leere
Adresskarte wäre eine schlechtere Antwort als keine. Seit P5 ist die ÜBERSPRUNGENE Menge also
größer als die GELISTETE; beide Tests stehen in `componentapply_test.go`.

## Tests

```bash
(cd edge-app/nodered/vp-palette && npx mocha test/mqtt_read_spec.js --timeout 10000 --exit)
(cd edge-app/nodered/flowc && node --test compile.test.js)
(cd edge-app/core && go test ./internal/componentapply/...)
```

`test/mqtt_read_spec.js` führt den Ground-Truth-Fall aus: 11 Bänke × 16 Zellen ergeben
`cell_min_mv` 3393 und `cell_max_mv` 3606, plus die Alterung, den Sentinel und die
Quellen-Schranke; dazu drei Läufe gegen einen echten aedes-Broker.
