# Fähigkeiten im Box-Herzschlag (AP-06 IP-18)

`ems/{tenant}/{site}/{device}/status` bleibt bei `schema_version: "1.0"`.
`supports: ["data_sources", "measurement_sample_provenance", "events", "automation_paused_until_revoked", "plan_quittung", "steuerungsverbund_anteil", "sprungprobe"]` steht unabhängig neben
`data_sources`. [Schema](edge-supports.schema.json), [Vokabular und Vektoren](edge-supports-vectors.json).
Der Core sendet ausschließlich die dort als gebaut belegten Fähigkeiten. Neue Namen
brauchen einen Vertragseintrag, Codebeleg und gemeinsame Go-/Java-/TS-Nachweise.

## Bedeutung und Abfrage

- `data_sources`: Quellenstatus im Herzschlag (siehe [Quellenstatus](data-source-status.md)).
- `measurement_sample_provenance`: optionale Herkunft in `measurement-samples` 2.1,
  `applied_revision` je Umschlag und `entity_id` je eindeutig gebundenem Sample;
  bestehende Outbox-Umschläge bleiben bytegleich. Dies verspricht keinen neuen Messplan.
- `events`: Box-Ereignisse über `.../v2/events` (`mqtt-events-2.1`): `box_restart`, die
  Puffer-Verdrängung als `data_gap` mit `erkannt_aus: verdraengung` und die vom lokalen Bus
  eingelieferten `device_restart`, `frozen_source`, `range_limit`, `layout_changed`
  (`edge-app/core/internal/boxevents`, AP-07 IP-19). Das Vokabular bleibt geschlossen und der
  Cloud gehörend; `clock_jump` ist keine Box-Art und wird nie gesendet.
- `automation_paused_until_revoked`: die Box versteht das gleichnamige Registry-Feld und
  hält die Ruhe ohne Enddatum über Uhr und Neustart hinweg, bis ein Push ohne das Feld sie aufhebt.
- `plan_quittung` (AP-15 IP-10): die Box quittiert jeden Plan 2.0 auf `.../v2/plan-result` und
  spiegelt den wirksamen Plan im Herzschlag-Block `gemeinsame_steuerung`
  ([Plan-Quittung](mqtt-plan-result.md)). Nur gemeldet, keine Zeile in `edge-capabilities.json`.
- `steuerungsverbund_anteil` (AP-15 IP-17): die Box prüft das Anteils-Dokument einer Gemeinsamen
  Steuerung auf `.../v2/verbund-anteile`, hält ein angenommenes auf der Platte, quittiert jedes Urteil
  auf `.../v2/verbund-anteile-result` und spiegelt Rolle, Epoche, Revision und die wirksamen Anteile
  im Herzschlag ([Anteils-Dokument](mqtt-verbund-anteile.md)). Die Scharfschalt-Prüfung I1
  (`faehigkeit_fehlt`) fragt dieses Wort. **Nur gemeldet, keine Zeile in `edge-capabilities.json`**:
  eine Zeile verlangte ein `ab_release`, und jede Bestandsbox bekäme einen allgemeinen „Update
  nötig“-Hinweis; der Hinweis A12 gehört auf die Fläche der Gemeinsamen Steuerung (IP-23).
- `sprungprobe` (AP-15 IP-21): die Box führt einen Sprungprobe-Auftrag auf `.../v2/sprungprobe` aus und berichtet auf
  `.../v2/sprungprobe-result` ([Sprungprobe](mqtt-sprungprobe.md)). Die Route
  `POST …/admin/sites/{id}/gemeinsame-steuerung/sprungprobe` fragt dieses Wort (`sprungprobe_nicht_gemeldet`). **Nur
  gemeldet, keine Zeile in `edge-capabilities.json`** (Begründung wie `plan_quittung`). Die Box meldet es, weil ihr
  Ausführer gebaut ist (`internal/sprungprobe`, `agent/sprungprobe.go`; Beleg `agent/sprungprobe_test.go`).
- `measurement_config_per_component` (AP-07 IP-18b Teil 2): die Box nimmt den Mess-Plan mit
  **geteiltem Punkt** an — derselbe `point_key` einmal je Komponente, jede mit `entity_id`
  ([`mqtt-measurement-config`](mqtt-measurement-config.schema.json) `x-point-key-rule`) —, liest
  ihn je Ziel einmal und sendet je Komponente ein Sample mit ihrer `entity_id`
  ([`measurement-samples` 2.1 §2](mqtt-measurement-samples-2.1.md)). `MeasurementConfigPublisher`
  fragt dieses Wort; ohne es bekommt die Box den zusammengelegten Plan Byte für Byte wie bisher.
  **Gesendet seit dem Box-Schritt** (wirkt erst mit dem Box-Release): Core
  (`measurements.geteiltePunkte` in Plan, lokalem Stapel und Status) und Node-RED
  (`measurement-planner.js` `lesungenJeZiel`) lesen den Punkt je Ziel einmal in der schnellsten
  Kadenz; eine Ablehnung nur einer Komponente nennt deren `entity_id`
  ([`mqtt-measurement-config-status`](mqtt-measurement-config-status.schema.json)
  `x-rejection-entity-rule`). Keine Zeile in `edge-capabilities.json` (Begründung wie `plan_quittung`).
- `assignment_effective_at` bleibt bekannt, wird aber **nicht gesendet**: die gebaute
  Übergabe zum Zeitpunkt arbeitet ausschließlich im Cloud-Zeitgeber (`37205f8f`,
  `QuellenUebergabe`, [Ausführungsweg](../../agents/root/uems-quellen-uebergabe.md)).
  Die Fähigkeit würde eine vorab zugestellte Zuständigkeit erst zum Gültigkeitsbeginn
  lokal ausführen. Diese lokale Zeitsteuerung ist noch nicht gebaut.

Die Cloud fragt zentral `BoxFaehigkeiten.kann(deviceId, capability)` unter dem aktuellen
Mandanten ab: **gemeldet ODER laut Versions-Tabelle**. Eine positive Meldung gilt ohne
Release-Eintrag. Fehlend, `null` und `[]` lassen die Tabelle gelten; eine Teilmeldung
entzieht keine dort belegte Fähigkeit. Ein unbekannter Name gilt nie als unterstützt.
Die Tabelle bleibt Daten (`edge-capabilities.json`); die Ordnung kommt aus `release_seq`.
Das ersetzt die frühere, alleinige Auswertung eines vorhandenen `supports`-Blocks.

## Speicherung und Mischbetrieb

Der Listener prüft Topic-/Payload-Identität und den Box-Standort vor jeder Speicherung.
`device.supports` und `supports_reported_at` sind nullable; bestehende Zeilen bleiben
unverändert und nutzen die vorhandene RLS. Nur bekannte Namen werden gespeichert.
Unbekannte gültige Namen werden ignoriert und einmal je API-Prozess protokolliert
(auf 128 unterschiedliche Namen begrenzt). Ungültige Blöcke werden verworfen; ein
Fehler des Zusatzschreibwegs (eigene Transaktion, Log und Fehlerzähler) verhindert
weder Box-Lebenszeichen noch Quellenstatus.
Ältere Meldungen überschreiben keinen neueren Stand. Ein neuerer Herzschlag ohne Block
setzt den Bericht auf NULL zurück, beispielsweise nach Rücknahme auf eine ältere Box-Version.

Die bestehenden Box- und Flotten-Lesewege tragen den Bericht additiv. Der Kundenweg
trägt zusätzlich die durch die Cloud aufgelösten `capabilities`, damit auch künftige
Tabelleneinträge ohne ein öffentliches Release-Register richtig erscheinen.
Keine neue Ansicht und keine neue Route.

Neue Box an bisheriger Cloud: `EdgeSupportsLegacyListenerTest` wurde vor Änderung des
Listeners auf `origin/uems` (`2b3d51c7`) mit `clean test` ausgeführt. Der Zusatz wird
ignoriert, Quellenstatus und Lebenszeichen bleiben erhalten. Auch die heutige Produktion
auf `main` liest im Status-Zuhörer nur ihren jeweiligen Block und überliest `supports[]`.
Alte Box an neuer Cloud:
fehlender Block nutzt unverändert die Tabelle; die geteilten Vektoren und Listener-Tests
prüfen beide Richtungen sowie unbekannte Namen.

`RUNTIME_VERSION`, Tags, Release-Register und Rollout bleiben unverändert. Auf der Box
wirkt die Meldung erst mit einem späteren Edge-Release.
