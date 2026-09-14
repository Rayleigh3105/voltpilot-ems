# v2-Verträge

v2 ergänzt mehrere Entitäten je Box, typisierte Flows, Verbraucheranforderungen und zusätzliche Messpunkte. v1 läuft auf getrennten Topics weiter.

## Referenzen

| Thema | Erklärung / Form |
|---|---|
| Wünsche und Vorrang | [Arbitration](edge-desired-arbitration.md), [Schema](edge-desired.schema.json) |
| Plan und Ausführung | [Fahrplan](mqtt-schedule-2.0.md), [Verantwortung](plan-execution-ownership.md), [Schema](mqtt-schedule-2.0.schema.json) |
| Telemetrie | [Vertrag](mqtt-telemetry-2.0.md), [Schema](mqtt-telemetry-2.0.schema.json), [Ereignis](telemetry-v2-raw.event.schema.json) |
| Registry und Entity-Konfiguration | [Erklärung](edge-entity-config.md), [Schema](edge-entity.schema.json) |
| Flow-Graph und Artefakt | [Graph](flow-graph.md), [Artefakt](flow-artifact.md), [Graph-Schema](flow-graph.schema.json), [Artefakt-Schema](flow-artifact.schema.json) |
| Verbraucher | [Funktionsmodell](../../verbrauchssteuerung.md), [Policy](consumer-policy.schema.json), [Vektoren](consumer-policy-vectors.json) |
| Anlagenprojektion | [Topologie](topology-read-model.md), [Nutzungsprofil](usage-profile.md) |
| Zusätzliche Messpunkte | [Konfiguration](mqtt-measurement-config.schema.json), [Status](mqtt-measurement-config-status.schema.json), [Messungen](mqtt-measurement-samples.schema.json), [Ereignis](measurements-raw.event.schema.json) |
| Prüfung | [Fixtures](examples/README.md), [Simulator](edge-simulator-v2.md) |

## Dauerhafte Entscheidungen

Die Kennungen bleiben für Querverweise erhalten; Detailregeln stehen im jeweiligen Vertrag.

| Kennung | Entscheidung |
|---|---|
| D-1 / D-2 | Getrenntes `v2/#` je Gerät; v1-retained Slots nicht überschreiben |
| D-3 | Lokale Topics je Entität |
| D-4 | Explizite Prioritäten und Quellberechtigungen; Schutzgrenzen bleiben verbindlich |
| D-5 | Zulässiger Override höchstens vier Stunden, unter Vertrag/Netz/Schutz |
| D-6 | Innerhalb derselben Klasse bleibt der Besitzer; Handeingriff-Ausnahme D-6a beachten |
| D-7 | Wünsche nicht retained; TTL erforderlich |
| D-8 | Netzladen nur bei ausdrücklicher Freigabe |
| D-9 | Entity-Failsafe in Konfiguration; dokumentierte Peak-Ausnahmen im Plan |
| D-10 | Core besitzt normale Planausführung und Arbitration |
| D-11 | Vollständiger retained Flow-Bestand; 256/512-KiB-Budgets |
| D-12 | `@vp-flow`-Eigentumsmarker erhalten Kundenflows bei Reseed |
| D-13 | Explizite Entitäts-Claims im Graph |
| D-14 | Gemeinsame Kommandos: `setpoint_kw`, `on_off`, `limit_pct`, `limit_kw`, `mode` |
| D-15 | Generische Modbus-Knoten als gesonderte, governancegebundene Ausnahme |
| D-16 | Begrenzter `vp.logic.function`-Katalogknoten auf dem Edge |
| D-17 | `edge_source_id` erhält eindeutige lokale Anzeigezuordnung; keine zweite Telemetrieschreibquelle |
| D-18 | Eine ConsumerPolicy je Verbraucher mit gemeinsam validierter Semantik |
| D-19 | Generierter reaktiver Flow über bestehenden Compiler; serverseitiges `origin`, kein freier Control-Override |
| D-20 | Interner Deadline-Fallback zwischen Flow und Marktplan, nur mit belegtem Fortschritt |
| D-21 | `origin` markiert generierte Herkunft; Consumer-Policy/Modbus sowie ergänzend MQTT-/HTTP-Geräte (D-22/D-24) |

## Implementierung und bekannte Abweichung

Die Entity-Familie, Flow-Compiler und Erhaltung von Flow-Tabs sind implementiert. Historische E0/E1/E2-Zeitpläne beschreiben keinen aktuellen Funktionsstatus mehr.

Der eingefrorene v1-Schematext zum Default von `grid_charge_allowed` weicht vom restriktiven Go-Core ab. v2 beschreibt den restriktiven Default ausdrücklich. [Details](mqtt-schedule-2.0.md#netzladen).

Gemeinsame Vektoren für Topologie, Nutzungsprofile, Anwendungen, Policies und Auswertungen halten die Sprachimplementierungen zusammen. Eine redaktionelle Überarbeitung ändert keine dieser Vektoren oder Schemaformen.

## Ergänzende UEMS-Verträge

Umsetzungsstand und Kundenbegriffe: [Fachmodell](../../fachmodell/README.md). Schemas und Vektoren werden gemeinsam mit den Java-/TypeScript-Ableitungen geprüft. Die Messstellen-Fixtures liegen unter [fixtures/messstelle](fixtures/messstelle/README.md).

| Referenz | Zweck |
|---|---|
| [`mqtt-measurement-samples.schema.json`](./mqtt-measurement-samples.schema.json) (2.0) + [`mqtt-measurement-samples-2.1.md`](./mqtt-measurement-samples-2.1.md) + [`mqtt-measurement-samples-2.1.schema.json`](./mqtt-measurement-samples-2.1.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`anwendung-vectors.json`](./anwendung-vectors.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`uems-zustand-vectors.json`](./uems-zustand-vectors.json) + [`uems-zustand.schema.json`](./uems-zustand.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) + [`uems-referenzunternehmen.schema.json`](./uems-referenzunternehmen.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`funktion-zustand-vectors.json`](./funktion-zustand-vectors.json) + [`funktion-zustand.schema.json`](./funktion-zustand.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`override-vectors.json`](./override-vectors.json) + [`edge-entity.schema.json`](./edge-entity.schema.json) `registry_push` | AP-01 IP-4: Ruhe bis zum Start — Tabellen-CHECKs, Pausen-Felder des Registry-Pushs, Box bis auf Widerruf (Java `RuheRegel` ⟷ Go `Registry.Paused`). |
| [`messwert-herkunft.md`](./messwert-herkunft.md) + [`messwert-herkunft-vectors.json`](./messwert-herkunft-vectors.json) + [`messwert-herkunft.schema.json`](./messwert-herkunft.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`ortsbaum-vectors.json`](./ortsbaum-vectors.json) + [`ortsbaum.schema.json`](./ortsbaum.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`messstelle.md`](./messstelle.md) + [`messstelle.schema.json`](./messstelle.schema.json) + [`messstelle-vectors.json`](./messstelle-vectors.json) + [`fixtures/messstelle/`](./fixtures/messstelle/) | Schema, Regeln und gemeinsame Testvektoren. |
| [`data-source-assignment.md`](./data-source-assignment.md) + [`data-source-vectors.json`](./data-source-vectors.json) + [`data-source-assignment.schema.json`](./data-source-assignment.schema.json) + [`edge-capabilities.json`](./edge-capabilities.json) + [`edge-capabilities.schema.json`](./edge-capabilities.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`lead-device-vectors.json`](./lead-device-vectors.json) + [`lead-device.schema.json`](./lead-device.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`quelle-einstellung.md`](./quelle-einstellung.md) + [`quelle-einstellung.schema.json`](./quelle-einstellung.schema.json) + [`quelle-einstellung-vectors.json`](./quelle-einstellung-vectors.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`rechte-matrix.json`](./rechte-matrix.json) + [`rechte-matrix.md`](./rechte-matrix.md) + [`rechte-vectors.json`](./rechte-vectors.json) + [`rechte.schema.json`](./rechte.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`events-vocabulary.md`](./events-vocabulary.md) + [`mqtt-events-2.1.schema.json`](./mqtt-events-2.1.schema.json) + [`events-raw.event.schema.json`](./events-raw.event.schema.json) + [`events-vocabulary-vectors.json`](./events-vocabulary-vectors.json) + [`events-vocabulary.schema.json`](./events-vocabulary.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`datenannahme-events-vectors.json`](./datenannahme-events-vectors.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`verbrauch.md`](./verbrauch.md) + [`verbrauch-vectors.json`](./verbrauch-vectors.json) + [`verbrauch.schema.json`](./verbrauch.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`ergebnis-zustand.md`](./ergebnis-zustand.md) + [`ergebnis-zustand-vectors.json`](./ergebnis-zustand-vectors.json) + [`ergebnis-zustand.schema.json`](./ergebnis-zustand.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`korrektur-vorschlag-vectors.json`](./korrektur-vorschlag-vectors.json) | AP-08 IP-14: vorbelegte Begründung, Notizen, Vorschau-Form und Sperre der System-Vorschläge (Java `KorrekturVorschlagRegeln`, `copy.test.ts`). |
| [`bezugsdaten.md`](./bezugsdaten.md) + [`bezugsdaten-vectors.json`](./bezugsdaten-vectors.json) + [`bezugsdaten.schema.json`](./bezugsdaten.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`bezugsdaten.md`](./bezugsdaten.md) + [`bezugsdaten-vectors.json`](./bezugsdaten-vectors.json) + [`bezugsdaten.schema.json`](./bezugsdaten.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`bilanz.md`](./bilanz.md) + [`bilanz-vectors.json`](./bilanz-vectors.json) + [`bilanz.schema.json`](./bilanz.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`verteilung.md`](./verteilung.md) + [`verteilung-vectors.json`](./verteilung-vectors.json) + [`verteilung.schema.json`](./verteilung.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`netzanschluss.md`](./netzanschluss.md) + [`netzanschluss-vectors.json`](./netzanschluss-vectors.json) + [`netzanschluss.schema.json`](./netzanschluss.schema.json) | Schema, Regeln und gemeinsame Testvektoren. |
| [`bilanzwert-herkunft.md`](./bilanzwert-herkunft.md) + [`bilanzwert-herkunft.schema.json`](./bilanzwert-herkunft.schema.json) + [`bilanzwert-herkunft-vectors.json`](./bilanzwert-herkunft-vectors.json) | Schema, Regeln und gemeinsame Testvektoren; seit 1.1 die Ableitung der Routen aus gespeicherten Zeilen. |

## Ergänzende Entscheidungen

| Kennung | Regel |
|---|---|
| D-6a | Handeingriff `local-ui` + `override` hat Rang 75; Ausnahme beim Konflikt mit einer Regel. [Arbitration](edge-desired-arbitration.md#handeingriff-d-6a). |
| D-22 | Selbst angebundene Batterie: ein generierter `vp.mqtt.read`, gemeinsame Feldzuordnung und Aggregation über Zelltopics. |
| D-23 | `vp.soc.derive` liefert SoC mit numerischer Herkunft; fehlend bleibt abwesend. |
| D-24 | `vp.http.read` als zweiter Lesepfad; Auth-Geheimnis in Registry/Probe, nicht im Flow. |
| D-25 | `vp.bms.limit` begrenzt Wünsche anhand aktueller Batteriegrenzen; ein Autor je Kanal, kein direkter Register-Schreibpfad. |

Details zu D-22–25: [Entity-Konfiguration](edge-entity-config.md#selbst-angebundene-batterien-und-schutzgrenzen). Fehlende optionale Felder erhalten das bisherige Verhalten; neue Leser zuerst auf der Box ausrollen.
