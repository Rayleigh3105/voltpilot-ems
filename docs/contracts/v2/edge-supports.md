# Fähigkeiten im Box-Herzschlag (AP-06 IP-18)

`ems/{tenant}/{site}/{device}/status` bleibt bei `schema_version: "1.0"`.
`supports: ["data_sources", "measurement_sample_provenance", "events", "automation_paused_until_revoked", "plan_quittung", "steuerungsverbund_anteil", "sprungprobe", "measurement_config_per_component", "erzeuger_registerbild", "anlagensteuerung_quelle", "geraetesuche"]` (Docker-Box; Edge Light ohne die drei Palette-Wörter, siehe „Je Box-Art“) steht unabhängig neben
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
  **Gemeldet** (Entscheid firstmate 23.09.2026 A, wirksam mit dem nächsten Box-Release): Core
  (`measurements.geteiltePunkte` in Plan, lokalem Stapel und Status) und Node-RED
  (`measurement-planner.js` `lesungenJeZiel`) lesen den Punkt je Ziel einmal in der schnellsten
  Kadenz; eine Ablehnung nur einer Komponente nennt deren `entity_id`
  ([`mqtt-measurement-config-status`](mqtt-measurement-config-status.schema.json)
  `x-rejection-entity-rule`). Eingeschaltet, nachdem Punktzustand, Cloud-Status je Komponente,
  Revisions-Anstoß und der Summen-Wächter gegen doppelt gebundene Komponenten desselben Registers
  (Bilanz, Formel, Kennzahl, sichtbar im Portal) gebaut waren; Beleg
  `cloud/geteilter_punkt_gemeldet_test.go`. Eine Box ohne das Wort bekommt weiter den
  zusammengelegten Plan. Keine Zeile in `edge-capabilities.json` (Begründung wie `plan_quittung`).
- `erzeuger_registerbild` (UEMS EZ-6): die Box liest das VoltPilot-Registerbild Erzeuger v1
  (Katalogfamilie `voltpilot.erzeuger_registerbild_v1`) mit den Parametern aus
  [`mqtt-measurement-config`](mqtt-measurement-config.schema.json) `erzeuger_registerbilder`
  (`x-erzeuger-registerbilder-rule`). Die Cloud fragt das Wort an zwei Stellen: `MeasurementConfigPublisher`
  sendet das Feld nur an eine Box, die es meldet (ein älterer Core verwürfe sonst das ganze Dokument), und
  die Anlagensteuerung wird nur angelegt bzw. im Portal angeboten, wenn die zuständige Box es meldet
  ([Anlagensteuerung](../../agents/root/erzeuger-anlagensteuerung.md)). **Gemeldet seit EZ-5** (`advertised: true`,
  `BuiltSupports`), wirksam mit dem Box-Release, das den Laufzeitkatalog 2026.10.21.1 trägt: die Box liest das Bild
  alle 5 s (bis 8 Einheiten eine Anfrage), prüft Kopf und Soll, sendet die Punkte mit Qualität (`stale`,
  `uncertain`) und meldet `frozen_source`/`device_restart`; dazu die Probe-Art `erzeuger_kopf`
  ([Probe-Vertrag](../mqtt-probe.schema.json), [Box-Leser](../../agents/root/uems-erzeuger-registerbild-box.md)).
  Beleg `edge-app/nodered/measurements/erzeuger-laufzeit.test.js`. Keine Zeile in `edge-capabilities.json`
  (Begründung wie `plan_quittung`).
- `anlagensteuerung_quelle` (UEMS EZ-21): der Applier (`componentapply`) leitet aus dem Registry-Treiber einer
  Entität vom Typ `anlagensteuerung` (`communication: modbus_tcp`, `connection` = Adresse, Port und Geräte-ID der
  Datenquelle, Lesetakt 5 s, keine Marke) eine Quelle der Rolle `plant-controller` in `edge/sources/config` ab —
  ohne Wechselrichter-Katalog, ohne dass Core oder Selbstverdrahtung sie pollen —, und die Palette bindet die
  Komponente über ihren Pin `edge_source_id` daran ([Treiber-Regel](edge-entity.schema.json)
  `x-anlagensteuerung-driver-rule`, [Vektoren](anlagensteuerung-quelle-vectors.json)). Die Cloud fragt das Wort
  in `EntityRegistryService.composePush` je Box: nur eine Box, die es meldet, bekommt Treiber und Pin; jede andere
  den Push Byte für Byte wie vorher. Ein älterer Applier sähe einen Treiber mit Verbindung und ohne Marke und
  verweigerte den GANZEN Push. **Gemeldet seit EZ-21** (`BuiltSupports`), wirksam mit dem Box-Release, das diesen
  Applier trägt. Beleg `edge-app/core/internal/componentapply/plant_controller_test.go`. Keine Zeile in
  `edge-capabilities.json`: eine Zeile gälte für jeden Stand ab einem Release-Tag, und ein Tag, das diesen Applier
  doch nicht trägt, bekäme den Treiber und verweigerte damit jede Konfiguration der Anlage — nur die eigene Meldung
  der Box ist dafür sicher.
- `geraetesuche` (Gerätesuche, 30.10.2026): die Box sucht auf `.../v2/geraetesuche` lesend im Heimnetz, meldet alle 2 s
  auf `.../v2/geraetesuche-stand` und genau ein Ergebnis auf `.../v2/geraetesuche-ergebnis`
  ([Gerätesuche](mqtt-geraetesuche.md)). Die Route `POST /api/v1/sites/{siteId}/geraetesuche` fragt dieses Wort
  (409 `nicht_unterstuetzt`). **Gesendet von beiden Box-Arten** (Paket 2, 30.10.2026): das Suchmodul
  `edge-app/core/internal/geraetesuche/suche` steckt in `vp-edge-core` und `vp-edge-light`, verdrahtet in
  `agent/geraetesuche.go` (Beleg `suche/suche_test.go`: eine ganze Suche je Box-Art gegen simulierte Geräte). Eine ältere
  Box meldet das Wort nicht und bekommt nie einen Auftrag. **Die Zeile in `edge-capabilities.json`** kam mit dem
  Portal-Paket zusammen mit dem Knopf „Geräte suchen“ (vorher hätte jede Box-Karte und die Flotte „Update nötig für:
  Gerätesuche“ für einen Knopf gesagt, den es nicht gab). Anders als bei `sprungprobe` sagt die Fläche einer älteren Box
  „Update nötig für: Gerätesuche“ und „Update planen“ (`ab_release` null, siehe „Je Box-Art“).
  Das Wort wird **je Box-Art** gemeldet (siehe unten); welche Erkenner eine Box-Art wirklich laufen ließ, nennt das
  Ergebnis, nicht dieses Wort.
- `assignment_effective_at` bleibt bekannt, wird aber **nicht gesendet**: die gebaute
  Übergabe zum Zeitpunkt arbeitet ausschließlich im Cloud-Zeitgeber (`37205f8f`,
  `QuellenUebergabe`, [Ausführungsweg](../../agents/root/uems-quellen-uebergabe.md)).
  Die Fähigkeit würde eine vorab zugestellte Zuständigkeit erst zum Gültigkeitsbeginn
  lokal ausführen. Diese lokale Zeitsteuerung ist nicht gebaut und nicht geplant (E8 = A);
  darum steht „Zuständigkeit ab Zeitpunkt“ in `edge-capabilities.json` unter
  `keine_faehigkeit` und erzeugt nie ein „Update nötig“.

Die Cloud fragt zentral `BoxFaehigkeiten.kann(deviceId, capability)` unter dem aktuellen
Mandanten ab: **gemeldet ODER laut Versions-Tabelle**. Eine positive Meldung gilt ohne
Release-Eintrag. Fehlend, `null` und `[]` lassen die Tabelle gelten; eine Teilmeldung
entzieht keine dort belegte Fähigkeit. Ein unbekannter Name gilt nie als unterstützt.
Die Tabelle bleibt Daten (`edge-capabilities.json`); die Ordnung kommt aus `release_seq`.
Das ersetzt die frühere, alleinige Auswertung eines vorhandenen `supports`-Blocks.

## Je Box-Art

`supports[]` und das Update-Backend (`update.backend` im Herzschlag) meldet jede Box **aus ihrem eigenen Build**: Edge
Light (`vp-edge-light`, Backend `light`) und die Docker-Box (`edge-app`, Backend `compose`, `quadlet` oder `mender`)
tragen je eine eigene Liste der gebauten Fähigkeiten. Ein Wort heißt „diese Box-Art in diesem Build kann es“; die Cloud
schließt nie von der einen Box-Art auf die andere (`ota/BoxArt`). Seit Paket 2 der Gerätesuche nennt jedes Programm seine
Box-Art (`edgemain.Options.BoxArt`): `cloud.BuiltSupports(boxArt)` gibt die Liste je Build, `cloud.UpdateBackend(boxArt)`
das Backend (`light` bzw. `compose`), mit dem die Box auch ein Release prüft. Eine Edge-Light-Box ab diesem Stand meldet
also `light`; ältere Stände melden weiter `compose`, darum bleibt die Erkennung am Versionsstempel in der API bestehen.

Die Vektoren sagen je Wort, welche Box-Art es trägt: `box_arten` (wahlfrei; fehlt = beide). Edge Light hat keine
Node-RED-Palette und meldet darum `measurement_config_per_component`, `erzeuger_registerbild` und
`anlagensteuerung_quelle` nicht (`box_arten: ["docker"]`): deren Weg endet in der Palette. Das Feld liest nur der
Go-Test (`cloud/edge_supports_test.go`); Java und TS überlesen es.

Auch die Tabelle `edge-capabilities.json` kennt die Box-Art nicht: `BoxFaehigkeiten.effective` ordnet nach `release_seq`
über beide Linien, ein Edge-Light-Stand hinter dem `ab_release` eines Docker-Tags gälte also mit. Die Zeile
`geraetesuche` trägt deshalb `ab_release` null, bis die Tabelle je Box-Art liest; bis dahin belegt allein die eigene
Meldung der Box die Fähigkeit.

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
