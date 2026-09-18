# Quellenstatus im Box-Herzschlag (AP-06 IP-13)

`ems/{tenant}/{site}/{device}/status` bleibt bei `schema_version: "1.0"`.
Der optionale Nachbarblock `data_sources` ist eine vollständige Liste; `[]` entfernt
vorherige Quellenzustände. Sein [Schema](data-source-status.schema.json) beschreibt
nur den Zusatz, alle bisherigen Herzschlag-Felder bleiben unverändert. Ein künftiges
`supports[]` kann unabhängig daneben stehen.

## Identität und Mischbetrieb

Der Registry-Push trägt das gespeicherte `data_source.kennzeichen` je Entität als
`driver.data_source_id` (beispielsweise `DQ-4`). Das ist ausdrücklich keine UUID und
keine lokale `edge_source_id`. `driver` ist schon im bisherigen Registry-Schema ein
offenes Objekt. Eine reine Metadaten-Ergänzung ohne Anschluss bleibt im bisherigen
Core ein nicht lesender Descriptor. Alte Boxen ignorieren diese Metadaten; neue
Boxen akzeptieren weiterhin Pushes ohne das Feld und erfinden keine Quellenkennung.

`EntityRegistryRepository.datenquellenKennzeichen` liest die Zuordnung unter RLS;
der Push fügt sie nur den tatsächlich für diese Box ausgewählten Entitäten bei.
Der Komponenten-Applier reicht sie in die lokale Quellenkonfiguration weiter, ohne
die lokale Quellenkennung zu ändern. Weder gleiche Adresse noch gemeinsamer Port
begründen eine Zuordnung. Umbenennen erhält den Zustand, Entfernen aus dem Push
entfernt ihn aus dem nächsten Herzschlag.

## Lese-Belege

Node-RED sendet einzelne, nicht retained Lese-Belege auf `edge/data-sources/poll`:
`id` (DQ-Kennzeichen), alternativ `entity_id` oder `source_id` (lokale Kennung),
`ts`, `event_id` zur QoS-Wiederholungskennung, optionale `requests`, `samples`,
`failed`, optionale `error_class`.
Der Core akzeptiert nur Kennungen aus seiner aktuellen Registry. Telemetrie bleibt
auf ihren bisherigen Topics; der Quellenstatus erzeugt keine Messwerte.

- `health`: `never` bis zur ersten brauchbaren Lesung, danach `ok`; ein Fehler oder
  eine verstummte Quelle wird `stale`. Ohne Poll-Beleg gilt die bestehende
  Mindesttoleranz von 300 Sekunden beziehungsweise drei Quelltakten.
- `since`: Beginn des Zustands ohne Daten; wiederholte Fehler verschieben ihn nicht.
  Bei `ok` fehlen `since` und `error_class`. Nach Neustart beginnt die Beobachtung neu.
- `read_at`: letzte akzeptierte Lesung, UTC; fehlt vor der ersten Lesung. Verspätete
  Belege dürfen den letzten Stand nicht zurückdrehen.
- `requests_per_min`, `samples_per_min`: beobachtete Leseversuche und gelieferte
  Werte im gleitenden Fenster `(jetzt − 60 s, jetzt]`, keine Plankosten. Mehrere
  Registerblöcke sind mehrere Versuche. Fehlt ein Instrument für Leseversuche
  (etwa beim bisherigen primären Telemetriepfad), bleibt `requests_per_min: null`.
- Fehlerklassen sind die Box-Wörter aus [§7 des Quellenvertrags](data-source-assignment.md#7-fehlerklassen-je-quelle-e5--a-geschlossenes-vokabular),
  einschließlich `budget`. Eine unbekannte Ursache bleibt ohne Klasse;
  `box_meldet_sich_nicht` kommt niemals von der Box. Budget verweigert I/O,
  ohne einen ausgeführten Request oder Messwert vorzutäuschen.

Instrumentiert sind der zusätzliche Quellen-Poll, die Messruntime sowie die
Modbus-/HTTP-Palette. Der Core berücksichtigt außerdem direkte Entitäts- und
primäre Telemetrie und den Core-eigenen Shelly-Poll. Der Quellen-Poll zählt reale Socket-/HTTP-Leseversuche; sein
Timeout und seine Zähler gehören zu genau einem Poll und können keinen späteren
Poll einer anderen Quelle verfälschen.

## Nachweise und Grenzen

Die [gemeinsamen Vektoren](data-source-status-vectors.json) laufen im Go-Collector,
im gebauten Java-Listener und im TS-Vertragsleser. Der MQTT-Test prüft den tatsächlichen
Herzschlag. Mischbetrieb: bisheriger Core/Node-RED samt unverändertem Registry-Schema
akzeptieren den Zusatz; `DataSourceStatusListenerTest` akzeptiert alte Herzschläge
weiterhin ohne Quellenblock.

Der gebaute Listener begrenzt seine Senke auf 128 Einträge; die alte Kappe von 16
Messpunkten gilt nicht für diesen Block. Version/Fähigkeit-Tabelle und
`RUNTIME_VERSION` bleiben unverändert. Wirksam auf einer Box wird der Zusatz erst
mit einem späteren Edge-Release; dieses Paket erzeugt keines.

Der Cloud-`LueckenMelder` liest weiterhin Telemetrie-Ankunft statt
`device_status_seen_at`. Diese getrennte Cloud-Naht wird hier nicht geändert.
