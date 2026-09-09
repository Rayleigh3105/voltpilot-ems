# Der generische Batterie-Anschluss, Ebene 1 (P5): `user-defined-battery` + `vp.mqtt.read`

Angelegt am 09.09.2026 (P5 Ebene 1). Konzept: `data/vp-deye-diybms-luecke-l5/report.md`
§3.2b „Zwei-Ebenen-Architektur", Bauplan-Paket P5. Vertrags-Entscheid: `docs/contracts/v2/README.md`
D-22.

## Warum es das gibt

Weder ein Deye im Spannungsmodus noch ein DIYBMS ohne Shunt MESSEN einen Ladestand. Der Kunde
rechnet ihn heute selbst in seinem Home-Assistant-Node-RED aus den Zellspannungen. Weder HA
noch dieser Kunden-Flow sind eine Quelle für VoltPilot — also baut VoltPilot das Verfahren
generisch nach, in **zwei Ebenen**:

- **Ebene 1 (DIESES Paket):** Rohwerte aus irgendeiner Quelle holen und per NUTZER-DEFINIERTER
  Feld-Zuordnung auf die Standard-Batteriekanäle abbilden.
- **Ebene 2 (P5b, noch nicht gebaut):** aus diesen Rohwerten den Ladestand ABLEITEN
  (Spannungskennlinie, Ladungszählung).

DIYBMS ist nur das Beispiel. Ein Pylontech, Seplos oder JK fällt mit demselben Modell und nur
Feld-Zuordnung als Aufwand hinein.

## Was Ebene 1 ist

| Stück | Wo |
|---|---|
| Entitätstyp `user-defined-battery` | `services/api/src/main/resources/entitytypes/catalog.json` |
| Die REGELN (rein, ohne Docker) | `services/api/.../components/UserDefinedBatteryDefinition.java` |
| Der Flow-Compiler | `services/api/.../components/UserDefinedBatteryFlowCompiler.java` |
| Der Anlege-/Änder-/Lösch-Weg | `services/api/.../components/UserDefinedBatteryService.java`, Routen `/api/v1/sites/{id}/components/battery[/{entityId}]` |
| Katalogtyp `vp.mqtt.read` | `services/api/src/main/resources/flowcatalog/catalog.json` + `frontend/portal/src/flows/catalog.json` (byte-gleich) + `edge-app/nodered/flowc/catalog.js` |
| Der ausführende Knoten | `edge-app/nodered/vp-palette/nodes/vp-mqtt-read.js` (+ `lib/mqtt-mapping.js`), Palette **0.10.0** |
| Vertrags-Beispiel | `docs/contracts/v2/examples/flow-graph.valid.mqtt-battery.json` |

## Die Regeln, die tragen

- **Die Standard-Kanäle sind ein GESCHLOSSENES Vokabular, und der Typkatalog ist seine EINE
  Wahrheit.** `user-defined-battery.default_measure` nennt `soc_pct`, `voltage_v`, `current_a`,
  `power_kw`, `cell_min_mv`, `cell_max_mv`, `temp_max_c`, `charge_allowed`,
  `discharge_allowed`, `charge_limit_a`, `discharge_limit_a` samt Einheit.
  `UserDefinedBatteryDefinition.validate` bekommt diese Liste HEREIN gereicht statt sie zu
  kopieren — eine zweite Liste liefe genauso lautlos auseinander wie der Rollen-Default, den
  die Korrektur vom 09.09.2026 beseitigt hat.
- **Die Fähigkeiten einer angelegten Batterie sind die ZUGEORDNETEN Kanäle, nie die ganze
  Liste.** Wer nur Zellspannungen abbildet, hat eine Batterie mit `cell_min_mv`/`cell_max_mv`.
  Einen Ladestand zu versprechen, den niemand liest, wäre eine erfundene Messung.
- **Ein Aggregat über VIELE Topics ist der ganze Grund für diesen Bausatz.** Der reale Pack des
  Kunden meldet 11 Bänke × 16 Zellen EINZELN (`emon/diybms/<bank>/<cell>`, JSON-Feld
  `.voltage`, in Volt). Eine Zuordnung „ein Topic → ein Kanal" hätte den Fall nicht abgebildet;
  `min`/`max` über den Filter `emon/diybms/+/+` mit Skalierung 1000 macht daraus genau
  `cell_min_mv` und `cell_max_mv`.
- **EIN Knoten je Gerät, nie einer je Kanal.** Alle Zuordnungen leben an EINER Broker-
  Verbindung; zwei Zuordnungen auf demselben Filter teilen sich EIN Abo. Ein Knoten je Kanal
  wäre eine zweite Verbindung zum selben Broker — die Kollision, die dieses Produkt schon
  einmal einen Lesezyklus gekostet hat.
- **Der Auslöser IST der Sendeabstand.** Das Abo läuft dauernd und füllt den Puffer;
  veröffentlicht wird im Takt (Vorgabe 15 s) EINE Telemetrie-Nachricht mit allen Kanälen, die
  gerade einen frischen Wert haben. Ein zweiter Kadenz-Begriff im Knoten wäre eine Vorgabe, die
  der Takt jederzeit widerlegen könnte.
- **Ehrlichkeit, Zeile für Zeile.** Ein Kanal ohne frische Probe FEHLT in der Nachricht (nie 0).
  Ein `sentinel` ist ein ausdrücklich benannter Rohwert, der „nicht gemessen" heißt. Ein Wort
  außerhalb der Wahrheitswert-Liste wird VERWORFEN, nie geraten. Ein Ja/Nein-Wert kennt keine
  Skalierung — 0/1 IST die Aussage, und er lässt sich nur mit `last`/`min` (konservatives UND)
  /`max` (ODER) zusammenfassen: die SUMME von Freigaben ist keine Freigabe, und ein Mittel von
  0,5 wäre eine Zahl, die kein Gerät je gemeldet hat. Hat KEIN Kanal einen frischen Wert, wird
  gar nichts veröffentlicht.
- **LAN-only, doppelt geprüft.** Cloud (`SelfBuildDefinition.isPrivateHost`, benutzt statt
  kopiert) und Box (`vp-palette/lib/private-host.js`) prüfen unabhängig; die Box abonniert ein
  öffentliches Ziel gar nicht erst.
- **`vp.mqtt.read` ist GENERATED-ONLY** unter der Herkunft `mqtt-device`. Die api ist sein
  einziger Autor — solange es die Zuordnungs-Fläche mit Live-Vorschau (P5d) nicht gibt, wäre
  ein freier Baustein ein Formular, das niemand ausfüllen kann. Der Katalog markiert ihn
  zusätzlich `customer_visible: false`.

## ⚠ Rollout-Reihenfolge (die einzige echte Falle)

Die Box überspringt eine so angebundene Komponente an ihrer `communication` `mqtt_local`
(`componentapply.isSelfRead`, Zwilling von `UserDefinedBatteryDefinition.COMMUNICATION`). Eine
Box, die den Wert noch NICHT kennt, lehnt den Treiber mit „nennt keine Marke" ab — und `Derive`
ist alles-oder-nichts: die Anlage verlöre die Anwendung ihres Wechselrichters und aller
Quellen. **Das Edge-Release muss eine Anlage erreichen, BEVOR dort die erste eigene Batterie
angelegt wird.** Dieselbe Falle gab es bei `modbus_baukasten` (Einheitsmodell Stufe 3); der
Sprung sitzt aus demselben Grund VOR der Marken-Prüfung.

Der Flow selbst schützt sich: `min_palette_version` `0.10.0` — eine ältere Palette quittiert
den Rollout mit `unsupported`, statt still nichts zu tun.

## Was bewusst NICHT in diesem Paket ist

| Später | Was fehlt |
|---|---|
| **P5b** | die SoC-ABLEITUNG (Spannungskennlinie mit Doppelkurve + konservativem Minimum, Ladungszählung). Andockpunkt vorhanden: `soc_derivation` in der gespeicherten Definition. Heute existiert nur `direct` („die Quelle liefert einen echten Ladestand", gebunden an ein zugeordnetes `soc_pct`); `ocv_curve`/`coulomb` werden BENANNT abgelehnt statt unausgeführt gespeichert. |
| **P5c** | der Schutz-/Strombegrenzungs-Baustein (Strom-Treppe + Zellspannungs-Hysterese → `guards.Clamp`). |
| **P5d** | die Portal-Fläche: Zuordnungs-Assistent mit Rohwert-Vorschau und Kurven-Editor. Ein MQTT-Vorschau braucht ein LAUSCHFENSTER statt der Einmal-Lesung des Probe-Kanals (`mqtt-probe.schema.json`, `transport: modbus_tcp`) — deshalb gibt es hier auch KEINE Verbindungstest-Pflicht: eine Pflicht ohne Tür wäre eine Sackgasse, kein Schutz. |
| **P6** | die ausdrückliche Speiser-Bindung an den Hybrid-Speicherknoten (die Batterie-LEISTUNG bleibt beim Wechselrichter; sie doppelt zu zählen wäre falsch). |
| **P5-HTTP** | der HTTP/JSON-Lesetyp — und mit ihm der GEHEIMNIS-Weg. Deshalb kennt `vp.mqtt.read` bewusst keine Broker-Anmeldedaten: ein Kennwort in einem retained ausgerollten Flow-Dokument wäre ein Klartext-Geheimnis. |

## Tests (alle ohne Docker)

```bash
(cd services/api && ./mvnw test -Dtest='UserDefinedBatteryDefinitionTest,UserDefinedBatteryFlowCompilerTest,UserDefinedBatteryCatalogTypeTest,FlowGraphValidatorTest')
(cd edge-app/nodered/vp-palette && npx mocha test/mqtt_read_spec.js --timeout 10000 --exit)
(cd edge-app/nodered/flowc && node --test compile.test.js)
(cd edge-app/core && go test ./internal/componentapply/...)
```

Der DIYBMS-Fall ist in beiden Welten der ausführbare Testfall: 176 Zell-Topics → genau
`cell_min_mv` 3393 und `cell_max_mv` 3606 (die gemessene Spreizung des Kunden am 09.09.2026).
