# Messwert-Strecke, Herkunft und Speicherklassen — Betriebswegweiser

Dieser Wegweiser beschreibt den **gebauten Stand** von AP-07 IP-6 bis IP-14. Die
Messwert-Strecke ist Box → MQTT → Ingest → `measurements.raw` → Writer → Rohwert →
Verdichtungs-Jobs → Langzeitklassen. Die Reihe eines UEMS-Messwerts ist
`tenant_id + entity_id + point_key + time`; Bestandswerte und Spiegel bleiben auf dem alten
Box-Schlüssel. Der Writer schlägt Einbau, Fassung, Wertart, Rolle und Zustellart zur Messzeit nach
und verliert bei einem fehlgeschlagenen Nachschlag keinen Wert
(`services/timescale-writer/src/main/java/com/voltpilot/writer/MeasurementWriteRepository.java:37-55`,
`services/timescale-writer/src/main/java/com/voltpilot/writer/MeasurementWriteRepository.java:249-269`).

## Speicherklassen und Verarbeitung

| Klasse | Gebauter Vertrag | Beleg im Code |
|---|---|---|
| Rohwerte `device_measurement_sample` | Originalkadenz, 90 Tage; Herkunftsspalten je Wert; RLS-Tabelle ohne Kompression | `services/api/src/main/resources/db/migration/V20260848000000__additional_measurement_pipeline.sql:27-61,198-202`; `services/api/src/main/resources/db/migration/V20260912140000__uems_messwert_rohtabelle.sql:58-76,186-188` |
| Ereignisse `messreihe_ereignis` | append-only, keine Retention und keine Kompression; Fortschreibung als neue Zeile | `services/api/src/main/resources/db/migration/V20260911260000__uems_messreihe_ereignis.sql:254-324,372-373`; `services/api/src/main/java/com/voltpilot/api/uems/MessreiheEreignisRepository.java:35-52` |
| Viertelstunden `messreihe_viertelstunde` | 30-Tage-Chunks, 3 653 Tage, RLS + FORCE; dauerhafte Arbeitsliste; **keine Kompression** | `services/api/src/main/resources/db/migration/V20260912170000__uems_messreihe_viertelstunde.sql:239-258,293-314,364-374` |
| Tage `messreihe_tag` | Tagesgrenze in der gespeicherten Standort-Zeitzone, 1-Jahr-Chunks, 3 653 Tage, RLS + FORCE; **keine Kompression** | `services/api/src/main/resources/db/migration/V20260912190000__uems_endgueltigkeit_tageswerte.sql:174-230,328-344,430-438` |
| Monat/Jahr `messreihe_periode` | 3 653 Tage, RLS + FORCE; dauerhafte Arbeitsliste; **keine Kompression** | `services/api/src/main/resources/db/migration/V20260912205000__uems_periodenmengen.sql:81-115,171-188,199-230` |

Die UEMS-Verdichtungen sind **Anwendungs-Jobs, keine Continuous Aggregates**. Der
Viertelstundenlauf läuft standardmäßig alle fünf Minuten, Lücken ebenso; Endgültigkeit, Tage und
höhere Perioden laufen stündlich
(`services/api/src/main/java/com/voltpilot/api/uems/ViertelstundeLaeufer.java:29-42`,
`services/api/src/main/java/com/voltpilot/api/uems/LueckenLaeufer.java:29-41`,
`services/api/src/main/java/com/voltpilot/api/uems/EndgueltigkeitLaeufer.java:46-86`). Die Flags sind in Produktion
standardmäßig an und im Testlauf aus
(`services/api/src/main/resources/application.yml:465-512`, `services/api/pom.xml:289-317`).

Arbeitslisten sind dauerhaft und werden mit `FOR UPDATE SKIP LOCKED` stapelweise entnommen; der
Eintrag verschwindet in derselben Transaktion wie das Ergebnis. Ein Prozessabbruch verliert daher
keinen Auftrag (`services/api/src/main/java/com/voltpilot/api/uems/ViertelstundeVerdichter.java:360-405`,
`services/api/src/main/java/com/voltpilot/api/uems/TagVerdichter.java:350-389`). Rückstand und Alter der Arbeitslisten gehören in den Betrieb, nicht
in die Pod-Readiness; der aktuelle Stand der Metrik und des Alarms steht in
[`docs/k8s-readiness.md`](../../k8s-readiness.md).

Der gebaute Speicher-Wächter misst täglich Tabellenanteile und Planverbrauch je interner
Mandantenkennung; er ist ein Kapazitätswächter und ersetzt keinen Arbeitslisten-Alarm
(`services/api/src/main/java/com/voltpilot/api/metrics/DbStorageMetricsCollector.java:39-88`).
Grenzen, Planwerte und die lokale Kompressionsmessung:
[`uems-speicher-waechter.md`](uems-speicher-waechter.md).

## Herkunft, Lücken und Endgültigkeit

- Die Datenquelle der Komponente entscheidet zwischen UEMS-Reihe und Bestandsweg. Der Writer löst
  Zeitlinien zur **Messzeit** auf; ein Fehler fällt auf den Bestandsweg zurück
  (`services/timescale-writer/src/main/java/com/voltpilot/writer/MeasurementWriteRepository.java:37-55`,
  `services/timescale-writer/src/main/java/com/voltpilot/writer/HerkunftNachschlag.java:330-348`).
- Der Lücken-Melder erkennt Reihenlücken aus der damals geltenden Kadenz und Box-Ausfälle aus dem
  letzten Eingang. Er liest derzeit `telemetry.received_at` und
  `device_measurement_sample.received_at`, nicht den neuen Box-Herzschlag
  (`services/api/src/main/java/com/voltpilot/api/uems/LueckenMelder.java:35-50,230-317`).
- Nach sieben Tagen ist eine Viertelstunde endgültig. Späte Rohwerte bleiben gespeichert, werden
  als `late_arrival` gemeldet und vorgeschlagen, aber nicht still angewendet. Seit der
  Nacharbeit im Sammelstand gilt die Prüfung für jeden Arbeitslistengrund
  (`services/api/src/main/java/com/voltpilot/api/uems/ViertelstundeVerdichter.java:374-426`,
  `services/api/src/main/java/com/voltpilot/api/uems/SpaetankunftMelder.java:53-101`).
- Abmelden baut eine Box aus und behält Aufzeichnungen. Purge und Anlagen-Löschen prüfen Belege;
  nur Anlagen-Löschen ohne Beleg sowie Kundenbereich-Offboarding entfernen die Messwerttabellen
  (`services/api/src/main/resources/db/migration/V20260913150000__uems_loeschwege.sql:275-319,329-352`).

## Lesen und Betrieb

Der vorhandene Roh-/5-Minuten-/15-Minuten-Weg antwortet zuerst. Nur wenn der angefragte Zeitraum
über die 90-Tage-Rohwertgrenze reicht **und** dieser Weg keine Daten liefert, fällt der Leser auf
Viertelstunden beziehungsweise Tageswerte zurück. Eine Antwort wird nicht aus mehreren Klassen
zusammengenäht und nennt ihre Quelle und Rohwertgrenze
(`services/api/src/main/java/com/voltpilot/api/measurement/MeasurementHistoryService.java:232-291`,
`services/api/src/main/java/com/voltpilot/api/uems/LesepfadQuelle.java:69-118`). Ereignismarken
werden daneben aus `messreihe_ereignis` gelesen
(`services/api/src/main/java/com/voltpilot/api/measurement/SpeicherklasseHistorie.java:315-365`).

Backup und PITR sichern alle Klassen gemeinsam als physische TimescaleDB. Nach einem Restore
werden die vorhandenen Daten und Jobs aus dem wiederhergestellten Cluster betrieben; Nachlieferung
der Boxen kann daraus neue Arbeitslisteneinträge erzeugen. Das Runbook und die ausdrücklich nicht
gebaute Restore-Meldung stehen in [`docs/backup-restore.md`](../../backup-restore.md).

## Noch nicht gebaut

- Die Box sendet die optionalen 2.1-Felder `entity_id` und `applied_revision` noch nicht durch die
  Strecke. Ingest validiert sie, entfernt sie aber vor `measurements.raw`; der Writer schlägt beide
  weiterhin aus Cloud-Fakten nach
  (`services/ingest/src/main/java/com/voltpilot/ingest/MeasurementSamplesValidator.java:41-48`,
  `services/timescale-writer/src/main/java/com/voltpilot/writer/HerkunftNachschlag.java:344-365`).
- `clock_jump` ist im Vertrag enthalten, aber nicht in der zustandslosen Datenannahme erkannt; ihre
  Ereignisarten sind nur `rejected`, `clock_ahead` und `too_old`
  (`services/ingest/src/main/java/com/voltpilot/ingest/Ereignisart.java:3-12`).
- Der Lücken-Melder ist noch nicht an `device_status_seen_at` beziehungsweise den neuen
  Box-Herzschlag angeschlossen (`services/api/src/main/java/com/voltpilot/api/uems/LueckenMelder.java:386-430`).
- Ein fachliches Ereignis `restore` ist weder im Ereignisvokabular noch in einem Restore-Schreiber
  gebaut. Der Wiederanlauf ist deshalb heute nur über Betriebsprotokoll, Datenstand, Lücken und
  Nachlieferungen belegbar (`services/api/src/main/java/com/voltpilot/api/uems/EreignisVokabular.java:414-550`,
  `tools/backup/vp-db-restore.sh:1-40`).

## Vertiefungen

Herkunft und Writer: [`uems-messwert-rohtabelle-reihe-herkunft.md`](uems-messwert-rohtabelle-reihe-herkunft.md),
[`uems-writer-herkunft-zur-messzeit.md`](uems-writer-herkunft-zur-messzeit.md) · Ereignisse und
Lücken: [`uems-messreihe-ereignis-tabelle.md`](uems-messreihe-ereignis-tabelle.md),
[`uems-luecken-melder.md`](uems-luecken-melder.md) · Speicher und Leser:
[`uems-viertelstundenwerte-speicherklasse.md`](uems-viertelstundenwerte-speicherklasse.md),
[`uems-endgueltigkeit-tageswerte.md`](uems-endgueltigkeit-tageswerte.md),
[`uems-lesepfad-verlauf-herkunft-rueckfall.md`](uems-lesepfad-verlauf-herkunft-rueckfall.md) ·
Löschen: [`uems-loeschwege.md`](uems-loeschwege.md).
