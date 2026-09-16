# Rückmeldung je Datenquelle aus dem Herzschlag

AP-06 IP-14 nimmt den additiven Herzschlag-Block `data_sources[]` in der Cloud an. Der Edge-Bau,
der diesen Block erzeugt, ist ein getrenntes Paket; bestehende Boxen senden ihn noch nicht.

## Schreibweg und Senke

- `uems/DataSourceStatusListener` hört wie seine Geschwister auf `ems/+/+/+/status`. Er prüft die
  drei Topic-UUIDs gegen den Payload und löst das Gerät unter dem Topic-Mandanten auf. Seit
  AP-06 IP-15 schreibt er bei jedem gültigen Herzschlag außerdem die Cloud-Ankunft nach
  `device.device_status_seen_at`, auch wenn der Block `data_sources[]` fehlt.
- Der Block ist eine vollständige Liste. `DeviceDataSourceStatusRepository.replaceForDevice`
  ersetzt deshalb die Zeilen der Box. Ältere als bereits gespeicherte Meldungen werden verworfen.
- Die Drahtkennung ist das stabile `DQ-*`-Kennzeichen. Geschrieben wird nur, wenn die Quelle im
  Mandanten existiert und die meldende Box zum Meldungszeitpunkt zuständig ist. Unbekannte oder
  fremde Kennzeichen erzeugen keine Zeile.
- `device_data_source_status` hat den Schlüssel `(device_id, data_source_id)`, RLS mit `FORCE`,
  die Quellen-Fremdschranke und geschlossene CHECKs für Gesundheit und Fehlerklasse. Sie ist eine
  Letztzustands-Senke, keine Historie und kein Messwertpfad.

## Ehrliche Ableitung

`DeviceDataSourceStatusRepository.ableiten` unterscheidet genau drei Fälle:

- `ok` → „Liefert Daten“;
- `stale|never` → „Liefert keine Daten seit …“, optional mit einer belegten Fehlerklasse aus
  `DatenquelleRegeln`;
- keine Zeile → „Box meldet noch nicht je Quelle“.

Der letzte Fall ist das Übergangsverhalten für heutige Boxen. Er behauptet weder Nullwerte noch
eine Ursache. Ob eine Software die Rückmeldung unterstützt, bleibt Daten in
`docs/contracts/v2/edge-capabilities.json`; deren Java-/TS-Vektoren bleiben die einzige
Versionsregel.

## Betrieb und Tests

Der Schalter `voltpilot.uems.data-source-status.mqtt-listener-enabled` ist ausgeliefert AN und in
beiden Compose-Dateien ausdrücklich AN. Surefire setzt ihn AUS; Parser-Tests rufen `handle`
direkt auf. Der Listener folgt der heutigen Replica-Singleton-Annahme der MQTT-Geschwister: vor
mehr als einer API-Replica braucht der Status-Filter eine gemeinsame Subscription oder Führung.

Fixtures `data-source-status-heartbeat-new.json` und `data-source-status-heartbeat-old.json`
halten neue und bestehende Boxen auseinander. `DataSourceStatusMigrationTest` prüft RLS,
Zuständigkeitsauflösung, veraltete Meldungen und Offboarding auf PostgreSQL/TimescaleDB.
