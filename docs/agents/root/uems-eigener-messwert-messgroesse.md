# UEMS: der eigene Messwert trägt Messgröße, Richtung und Wertart (Schnitt 2)

Neu am 21.09.2026 (Paket `vp-uems-baukasten-messwert-groesse`, Untersuchung „Portal-Weg Messkunde“).
Ein eigener Messwert aus dem Modbus-Baukasten („Eigenen Messwert hinzufügen“) bekommt nur dann eine
Messstelle, wenn der Kunde sagt, was er misst. Ohne diese Angabe bleibt er Beobachtung wie bisher.

- **Form:** `custom_definition.measures {quantity, direction, aggregationKind}` in Katalogwörtern
  (`CustomMeasurementPoint.Measures`, openapi `CustomMeasurementMeasures`). `MesskanalService.kanal`
  bildet die Angabe über `MesskanalAbbildung` ab. Das gilt für Vorschlag und Handbindung gleichermaßen.
  Erlaubt sind nur `active_energy`/`counter` und `active_power`/`gauge`, jeweils mit
  `import|export|generation|charge|discharge`, weil nur diese Kombinationen eine Messstelle tragen.
- ⚠ **Nur in der Cloud.** `MeasurementConfigPublisher.fuerDieBox` entfernt `measures`.
  `mqtt-measurement-config` ist geschlossen (`additionalProperties: false`, die Box liest mit
  `DisallowUnknownFields`), eine Box würde die ganze Auswahl verwerfen. Beweis:
  `MeasurementContractsTest.publisherGibtDieAngabeDesEigenenMesswertsNichtAnDieBox`.
- ⚠ **`measures` ist ein Feld von `Canonical`** (`@JsonInclude(NON_NULL)`) und kein Zusatz-JSON.
  `BestandsboxBudgetPruefung` liest die gespeicherte Zeile mit einem strengen `new ObjectMapper()`.
  Ohne Angabe bleibt die Zeile Zeichen für Zeichen die alte.
- ⚠ **Die Aufbewahrungsklasse muss zur Wertart passen.** Der Writer liest die Wertart eines eigenen
  Messwerts aus `retention_class` (`energy_counter` → counter, sonst gauge). Ein Zählerstand braucht
  darum `energy_counter`, die API lehnt eine andere Klasse ab. Das Portal leitet die Klasse aus der
  Antwort ab (`eigenerMesswert.ts`). Das Formular schickte vorher fest `gauge`, eine Klasse, die die
  API gar nicht kennt, und jeder Speicherversuch endete in 400.
- ⚠ **Unveränderlich.** Eine eigene Definition hat keine Änderungsroute (`ensureSame` lehnt ab). Die
  Angabe lässt sich also weder nachtragen noch an einem gebundenen Kanal ändern (Folgepunkt F1).
- **Portal:** EINE Frage „Was misst dieser Wert?“ (`VpPicker`, elf Antworten).
  Fehler der API zeigt das Formular in `customError`, nicht in `error`, denn das steht nur im Katalog-Einschub.
  Bühne: `e2e/eigener-messwert.{html,tsx,spec.ts}`. Abnahme: `PortalwegMesskundeAbnahmeTest` (MS-06).
