# Samples 2.1 aus der Box: eindeutig gebundene Punkte und Replay

AP-07 IP-18 sendet `entity_id` je Sample aus der expliziten Messauswahl und
`applied_revision` je Umschlag aus dem beim Lesen aktiven Plan. Der Vertrag
[`mqtt-measurement-samples-2.1`](../../contracts/v2/mqtt-measurement-samples-2.1.md)
bleibt unverändert. Ohne eindeutige Komponentenbindung wird keine Kennung geraten.

## Grenze: der Config-Merge bleibt bestehen

Mehrdeutige `point_key` über mehrere Komponenten werden weiterhin ohne `entity_id`
geliefert. Die Zuordnung fehlt schon am Eingang der Box:

- `services/api/.../measurement/MeasurementConfigPublisher.java`, `payload`: Merge
  je Punkt mit schnellster Kadenz; mehrdeutige `entity_id` wird entfernt.
- `docs/contracts/v2/mqtt-measurement-config.schema.json`, `x-point-key-rule`:
  `point_key` bleibt eindeutig je Auswahl.
- `edge-app/core/internal/measurements/measurements.go`, `ParseConfig`: doppelte
  Punkte werden zurückgewiesen.
- `edge-app/nodered/measurements/measurement-planner.js`, `buildPlan`: dieselbe
  Duplikat-Ablehnung. Diese vier Stellen wurden nicht geändert.

Die Aufhebung gehört in `vp-uems-b07-ip18b-config-demerge`, nach der
Fähigkeitsmeldung `supports[]` (AP-06 IP-18). Die Cloud nimmt einen geteilten
Punkt seit dem Cloud-Vorpaket an (Regel in `mqtt-measurement-samples-2.1.md` §2/§3);
Speicherschlüssel und Box-Verlauf regelt Teil 1b ([uems-geteilter-punkt-box-schluessel.md](uems-geteilter-punkt-box-schluessel.md)). Ältere Boxen benötigen weiter den
bisherigen Plan. Registry-Pins oder gleiche Transportadressen ersetzen keine
verlorene Auswahlzuordnung.

## Laufzeit und Auslieferung

- `measurement-runtime.js` übernimmt die Kennung bei Modbus, abgeleiteten
  Registerwerten, HTTP/JSON, SunSpec-Platzhaltern und OCPP. Gemeinsame Registerblöcke
  und Lesebudgets bleiben gleich. Ein wartender oder abgelehnter Plan wird nicht
  als angewendet ausgegeben; laufende Lesungen behalten ihren Plan.
- Core `parseBatch` prüft beide optionalen Herkunftsfelder streng. `Outbox.Append`
  wählt 2.1 nur bei vorhandener Herkunft, sonst weiter 2.0. `Next` liest bereits
  gespeicherte Umschläge ohne neue Herkunft oder Versionswechsel wieder aus.
- Core und Palette müssen gemeinsam ausgeliefert werden: ältere Core-Versionen
  lehnen neue lokale Felder ab. Dieses Paket erzeugt kein Edge-Release und hebt
  weder `RUNTIME_VERSION` noch den Katalogstand. Die heutige Cloud nimmt 2.0 sowie
  2.1 mit und ohne Herkunft an.

## Nachweise

- `measurement-provenance.test.js`: identisches Modbus-Lesebudget, alle Lesewege,
  Planwechsel während I/O, abgelehnter Plan und ausstehende OCPP-Bestätigung.
- Go `internal/measurements/provenance_test.go`: Versionswahl, strenge Feldprüfung,
  fehlend versus Null, Restart und bytegleiches Replay alter 2.0/2.1-Umschläge.
- Ingest `MeasurementEdgeProvenanceTest`: echte Node-Runtime mit injizierter
  Registerantwort → echte Go-Outbox mit Neustart → beide Schemas und heutiger
  Ingest-Validator. Läuft ohne Dienste/Container, benötigt `node` und `go` im PATH;
  Hilfsprogramme liegen unter `measurements/testdata` beider Box-Module.
- Ingest `MeasurementSamplesContractSchemaTest` und `MeasurementSamplesValidatorTest`
  prüfen den Mischbetrieb unveränderter alter Sender mit der heutigen Cloud.
