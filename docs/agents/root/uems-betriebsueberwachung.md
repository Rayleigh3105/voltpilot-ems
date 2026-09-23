# UEMS-Betriebsüberwachung in der api (AP-14 IP-9)

Die Metriken, an denen der Betreiber vor und nach dem Rollout-Tag sieht, ob die UEMS-Maschine läuft
— Konzept „Erste Produktfreigabe“ §3.5. **Die Namen und Label-Werte sind der Vertrag mit den
Alarm-Regeln, die IP-10 im gitops-Repo baut; sie ändern sich nicht ohne dieses Paket.**

Gebaut in `services/api`: `metrics/UemsLaeuferMelder`, `metrics/UemsMetricsCollector`,
`metrics/UemsMetricsSchedulingConfig`, `repo/UemsMetricsRepository`. Keine Migration, keine Route,
keine Fläche. Schalter `voltpilot.metrics.uems.enabled` (Vorgabe AN, im Testlauf AUS),
Takt `…interval-ms` (Vorgabe 60 s).

## Der Export

| Metrik | Labels | Bedeutung |
|---|---|---|
| `voltpilot_uems_arbeitsliste_aeltester_eintrag_age_seconds` | `liste` | Alter des ältesten offenen Eintrags. **Fehlt, wenn die Liste leer ist** |
| `voltpilot_uems_arbeitsliste_offen` | `liste` | Offene Einträge; `liste` = `viertelstunde` \| `tag` \| `periode` |
| `voltpilot_uems_laeufer_letzter_lauf_age_seconds` | `laeufer` | Alter des letzten beendeten Laufs. **Fehlt, wenn der Läufer aus ist oder seit dem Prozess-Start nie lief** |
| `voltpilot_uems_laeufer_zustand` | `laeufer`, `zustand` | 1 für den aktiven Zustand: `gelaufen` \| `nie` \| `aus` |
| `voltpilot_uems_laeufer_fehler_total` | `laeufer` | Gescheiterte Läufe seit dem Prozess-Start; ab Start als `0` vorhanden |
| `voltpilot_uems_kundenbereich_letzter_messwert_age_seconds` | `tenant` | Alter des jüngsten Mess-EINGANGS. **Fehlt, wenn nie** |
| `voltpilot_uems_kundenbereich_messwert_zustand` | `tenant`, `zustand` | 1 für den aktiven Zustand: `bekannt` \| `nie` |
| `voltpilot_uems_bestandslaeufer_total` | `laeufer`, `ergebnis` | Kundenbereiche je Ergebnis des Start-Laufs; `ergebnis` = `erledigt` \| `fehler` |

## Verwerfungen im Writer

Der Writer exportiert auf seinem bestehenden `/metrics`-Endpunkt zusätzlich:

| Metrik | Labels | Bedeutung |
|---|---|---|
| `voltpilot_writer_verworfen_total` | `strom`, `grund` | Nicht geschriebene Eingangsumschläge; `strom` = `measurements` \| `telemetry` \| `telemetry_v2` \| `events`, `grund` = `unlesbar` \| `ungueltig` \| `identitaet` \| `pflichtfeld` |
| `voltpilot_writer_verworfene_samples_total` | `grund` | Samples in einem verworfenen `measurements`-Umschlag, wenn ihre Zahl trotz der Ablehnung lesbar war |

Alle geschlossenen Reihen stehen ab Prozessstart als `0` bereit. Ein syntaktisch unlesbarer
Umschlag zählt nur als Umschlag, weil seine Sample-Zahl nicht belastbar bekannt ist. Mandant, Box,
Anlage und andere Kennungen sind keine Labels; die betroffene Identität bleibt ausschließlich in
der WARN-Zeile.

Die Alarm-Regel „Zuwachs > 0 über 15 Minuten → Warnung an `betreiber`“ gehört in das gitops-Repo
und ist nicht Teil dieses PRs. Gitops-PR 37 liegt beim Betreiber; die Regel wird dort nachgezogen.

## Verwerfungen in der Datenannahme (AP-14 IP-10)

Der ingest sitzt VOR dem Writer und veröffentlicht seit diesem Paket einen eigenen
`/metrics`-Endpunkt auf **8091** (gleiche Bauart: Actuator-Endpunkt `prometheus`, umgehängt auf
`/metrics`, anonym lesbar, kein Security-Starter). Bis dahin liefen dort Micrometer-Zähler, die
niemand abholen konnte — auch das ältere `voltpilot_ingest_events_undelivered_total`.

| Metrik | Labels | Bedeutung |
|---|---|---|
| `voltpilot_ingest_angenommen_total` | `strom` | Bei der Datenannahme eingegangene Umschläge |
| `voltpilot_ingest_weitergereicht_total` | `strom` | An Redpanda übergebene Umschläge |
| `voltpilot_ingest_verworfen_total` | `strom`, `grund` | Umschläge, die ihr Nutzlast-Topic nicht erreicht haben; `grund` = `ungueltig` \| `identitaet` \| `serialisierung` |
| `voltpilot_ingest_letzter_schreibzug_age_seconds` | `strom` | Sekunden seit dem letzten von Redpanda BESTÄTIGTEN Schreibzug; `NaN` bis zum ersten |

`strom` ist dasselbe geschlossene Wort wie beim Writer (`measurements` \| `telemetry` \|
`telemetry_v2` \| `events`). Das Grund-Vokabular ist **kleiner als beim Writer**: der ingest
unterscheidet `unlesbar` und `pflichtfeld` nicht (beide laufen durch dieselbe Abweisung, der v1-Weg
hat gar keine Grund-Kennung), kennt dafür den Serialisierungsfehler. Ein geratenes Label wäre
schlechter als ein grobes.

**`angenommen` = `weitergereicht` + `verworfen` gilt bewusst nicht.** Abgelehnte TEILWERTE eines
angenommenen Umschlags zählen NICHT als Verwerfung — sie gehen als Ereignis auf `events.raw` heraus
und wären sonst doppelt gezählt, womit jede Regel „Verwerfungen > 0“ im Normalbetrieb feuert. Das
ist dieselbe Trennung, die PR 972 beim Writer gezogen hat.

Vier Verwerf-Stellen, wie PR 972 sie gefunden hat — Verhalten unverändert, nur zählbar:

| Stelle | Was | Zählt als |
|---|---|---|
| `TelemetryIngestHandler` (v1-Prüfung) | unlesbares JSON, fehlendes Pflichtfeld ODER Topic-Abweichung | `telemetry` / `ungueltig` |
| `TelemetryIngestHandler` (Serialisierung) | geprüfter Umschlag, der sich nicht schreiben lässt | `telemetry` / `serialisierung` |
| `TelemetryV2IngestHandler` (Abweisung) | `UmschlagAbgewiesen` | `telemetry_v2` / `identitaet` bei `KENNUNG_ABWEICHEND`, sonst `ungueltig` |
| `TelemetryV2IngestHandler` (Serialisierung) | war die EINZIGE Stelle ganz ohne Zähler | `telemetry_v2` / `serialisierung` |
| `MeasurementIngestHandler` | `UmschlagAbgewiesen` | `measurements` / wie oben |
| `BoxEventsIngestHandler` | `UmschlagAbgewiesen` | `events` / wie oben |
| alle vier: abgelehnte Teilwerte | Ablehnung geht als `events.raw` heraus | **nichts** — kein stiller Verlust |
| Messwert-/Ereignisweg: äußerer Fehler | Quittung wird zurückgehalten, der Broker stellt erneut zu | **nichts** — Wiederzustellung, keine Verwerfung |

Nachweise: `IngestMetrikenTest` (je Stelle genau ein Zuwachs mit dem richtigen `grund` UND die
Nachricht wird weiterhin nicht weitergereicht), `MetrikEndpunktTest` (anonymes `GET /metrics`, und
kein anderer Actuator-Endpunkt ist mitaufgegangen).

Die zwei `…_zustand`-Metriken sind der Hausstil von `voltpilot_site_telemetry_state`. Ohne sie kann
eine Regel „steht“ nicht von „ist abgeschaltet“ und „lief seit dem Neustart noch nie“ unterscheiden
— und ein abgeschalteter Läufer soll gerade KEINEN Daueralarm erzeugen.

## Die neunzehn Läufer

Der Katalog steht in `UemsLaeuferMelder.KATALOG` und ist VOLLSTÄNDIG: `UemsMetrikenWiringTest` liest
die Quelltexte von `uems`, `unterstuetzung`, `zugriff` und `chargers` und verlangt für jede Klasse mit
`@Scheduled` oder `ApplicationReadyEvent` einen Eintrag. Wer einen Läufer ergänzt und den Katalog
vergisst, wird dort rot — sonst bliebe der neue Läufer still unbeobachtet. Ausnahme mit Grund:
`PlanResultListener` (AP-15 IP-10) — sein `@Scheduled` hält nur die Broker-Verbindung
(`KEIN_LAEUFER` im Test; sein Ausfall zeigt sich an `voltpilot_uems_box_plan_angenommen_age_seconds`).

| `laeufer` | Klasse | Schalter | Takt |
|---|---|---|---|
| `viertelstunde` | `ViertelstundeLaeufer` | `voltpilot.uems.viertelstunde.enabled` | 5 min |
| `endgueltigkeit` | `EndgueltigkeitLaeufer` | `voltpilot.uems.endgueltigkeit.enabled` | 1 h |
| `luecken` | `LueckenLaeufer` | `voltpilot.uems.luecken.enabled` | 5 min |
| `ersatzwert` | `ErsatzwertLaeufer` | `voltpilot.uems.ersatzwert.enabled` | 5 min |
| `kaskade` | `KorrekturKaskadeLaeufer` | `voltpilot.uems.kaskade.enabled` | 5 min |
| `bericht_struktur` | `StrukturAenderungLaeufer` | `…berichte.struktur.enabled` UND `…berichte.enabled` | 5 min |
| `zeilentexte` | `ZeilentextAufbewahrungLaeufer` | `voltpilot.uems.zeilentexte.enabled` | täglich 03:17 Europe/Berlin |
| `plan_zustellung` | `PlanZustellungAufbewahrungLaeufer` | `voltpilot.uems.plan-zustellung.enabled` | täglich 03:47 Europe/Berlin |
| `ladepark_grenze` | `chargers/LadeparkGrenzeLaeufer` | `voltpilot.uems.ladepark-grenze.enabled` | 1 h (Minute 1, UTC) |
| `verbund_bilanz` | `VerbundBilanzLaeufer` (danach im selben Takt die Schätzung des Anteils-Verlusts, `AnteilVerlustSchaetzung` — kein eigener Läufer) | `voltpilot.uems.verbund-bilanz.enabled` | täglich 04:37 Europe/Berlin |
| `vorbehalt` | `VorbehaltLaeufer` | `voltpilot.uems.vorbehalt.enabled` | täglich 04:52 Europe/Berlin |
| `vorbehalt_viertelstunde` | `VorbehaltViertelstundeLaeufer` | `…vorbehalt.enabled` UND `…vorbehalt.viertelstunde.enabled` | 15 min (Minute 10/25/40/55 Europe/Berlin) |
| `uebergabe` | `UebergabeLaeufer` | `voltpilot.uems.uebergabe.enabled` | 1 s |
| `box_tausch` | `BoxTauschZustellung` | `voltpilot.uems.uebergabe.enabled` | 15 s |
| `unterstuetzung` | `AblaufLaeufer` | `voltpilot.uems.unterstuetzung.enabled` | 1 min |
| `bestand_standort` | `BestandsuebernahmeLaeufer` | `voltpilot.uems.bestandsuebernahme.enabled` | Start |
| `bestand_funktion` | `FunktionBestandLaeufer` | `voltpilot.uems.funktion-bestand.enabled` | Start |
| `bestand_rechte` | `ZugriffBestandLaeufer` | `voltpilot.uems.zugriff-bestand.enabled` | Start |
| `bestand_tagesmenge` | `TagesmengeNachtragLaeufer` (Nachtrag der Tagesmenge vor AP-08 IP-5, nur Vorschläge) | `voltpilot.uems.tagesmenge-nachtrag.enabled` | Start |

`uebergabe` und `box_tausch` teilen sich einen Schalter und lesen beide
`voltpilot.uems.uebergabe.interval-ms` — mit verschiedenen Vorgaben (1 s bzw. 15 s). Das ist Bestand
von vor diesem Paket und hier nur festgehalten, nicht geändert.

## Entscheide und Fallen

- **Ein abgeschalteter Läufer exportiert KEINEN Alterswert**, sondern `zustand="aus"`. Ein
  Marker-Wert im Alter (etwa `-1`) wäre die Alternative gewesen; er zwänge jede Regel von IP-10 zu
  einem `!= -1` und ginge still durch, wenn jemand es vergisst. Fehlen ist die sichere Vorgabe:
  `> 3 × Takt` feuert auf einer fehlenden Reihe nie.
- **Ehrlichkeit nach einem api-Neustart**: der Melder hält den Stand IM PROZESS. Ein Läufer, der
  seit dem Start nie lief, meldet kein Alter `0`, sondern `zustand="nie"`. Mehrere Repliken melden
  jede ihren eigenen Stand; die Regel aggregiert (`min by (laeufer)`), wie bei `voltpilot_site_*`.
- **Der Melder darf keinen Lauf brechen.** Jede seiner Methoden schluckt alles, und jeder Läufer
  hält ihn als Feld mit der Vorgabe `UemsLaeuferMelder.STUMM` — so ändert sich kein bestehender
  Konstruktor, und ein direkt gebauter Läufer läuft nicht auf `null`.
- **`voltpilot_uems_laeufer_fehler_total` steht ab dem Start auf `0`.** Eine fehlende Reihe ist für
  `increase(...) > 0` nicht dasselbe wie `0`.
- **Der Endgültigkeits-Takt meldet „gelaufen“ auch dann, wenn ein Schritt aussetzte**, und zählt den
  Fehlschlag getrennt: „steht“ und „hatte einen Fehler“ sind zwei Fragen.
- **Der Dateneingang je Messkunde liest `messreihe_luecke_stand` (`art = 'box'`), nicht
  `device_measurement_sample`.** Der Rohwert-Hypertable ist die heißeste Tabelle der Plattform; die
  Lückenstand-Zeile trägt je Box denselben `received_at` bereits verdichtet (so nimmt es auch das
  Pilot-Blatt T01a). Preis: die Zahl entsteht im Lücken-Melder — steht der, altert sie mit. Genau
  dafür gibt es die Schicht „Wächter über den Wächter“ mit `laeufer="luecken"`.
- **Messkunde = eine bestehende `funktion`-Zeile `messen` an einem nicht archivierten Standort**
  (`f.zustand <> 'archiviert' AND s.archiviert_am IS NULL`) — **nicht** `zustand = 'aktiv'`. Die Falle
  (AP-14 IP-7, BEFUND B2): für „Messen & Auswerten“ gibt es kein Starten. `FunktionService.MESSEN_AKTIONEN`
  kennt nur `einrichten`, `FunktionZustandAbleitung.uebergangMessen` lehnt `starten` mit
  `STARTET_AUTOMATISCH` ab, und die Zeile wird genau einmal als `entwurf` geschrieben
  (`FunktionService.messenStandort`) — danach rührt sie kein Weg des Produkts mehr an (`nachziehen` und
  `FunktionBestandService` betreffen nur `steuern`). Das `aktiv`, das der Kunde in `GET /funktionen`
  liest, leitet `FunktionZustandAbleitung.messen` bei jedem Lesen frisch ab und speichert es nie.
  `zustand = 'aktiv'` traf deshalb keinen einzigen über die Kundenrouten entstandenen Messkunden — der
  Betreiber sähe ihn nicht. Die frühere gleiche SQL-Bedingung in `NetzanschlussVorschlagService` ist
  inzwischen auf die von `FunktionService` gelieferte Ableitung umgestellt; dort zählt fachlich erst die
  aktive Messfunktion, während die Betreiber-Metrik schon den eingerichteten Messkunden überwacht.
  Metrikname und Labels sind unverändert geblieben — die Betreiber-Regel `VoltPilotMesskundeOhneMesswerte`
  (gitops PR 37) muss nicht angefasst werden. Sie sieht ab jetzt nur MEHR Kundenbereiche und kann darum
  früher anschlagen: ein eben eingerichteter Messkunde, bei dem noch nie etwas ankam, trägt
  `zustand="nie"` und fällt der Regel auf. Das ist gewollt — stockt beim Messkunden etwas, soll es der
  Betreiber vor dem Kunden wissen.
- **Gelesen wird über `adminJdbcTemplate` (`voltpilot_admin`, BYPASSRLS).** Unter der Mandanten-RLS
  gäbe jede dieser Abfragen null Zeilen zurück, und null Zeilen hieße hier „kein Rückstand, kein
  Messkunde ohne Werte“: ein stiller Fehlalarm in die beruhigende Richtung.
- **Kein Scrape löst eine Abfrage aus** (das Muster von `DbStorageMetricsCollector`). Was der Scrape
  rechnet, ist Arithmetik auf dem zuletzt gesammelten Zeitpunkt — darum wachsen die Alter zwischen
  zwei Sammel-Läufen weiter, und ein ausgefallener SAMMLER wird an denselben Regeln sichtbar, ohne
  eigene Metrik.
- **Kardinalität**: drei Arbeitslisten, neunzehn Läufer, ein Wert je Messkunden-Kundenbereich. Keine
  Anlage, keine Box, keine Messstelle als Label (Ausnahme mit Absicht: die Box-Sicht unten, nur für
  Boxen mit Bezug) — und `tenant` trägt die INTERNE Kennung, nie einen Namen.

## Was hier NICHT entsteht

- Die ★-Metrik „Verbraucher-Rückstand je Gruppe“ der Schicht „Strecke“ liegt beim Writer und beim
  ingest, nicht in der api. Der Writer hat sie halb: `voltpilot_kafka_consumer_lag{group,topic}` aus
  `services/timescale-writer/.../KafkaLagMetricsCollector` auf seinem `/metrics` (8092). Der ingest
  hat seit AP-14 IP-10 einen eigenen `/metrics` auf 8091 (Abschnitt oben), aber KEINEN Lag-Sammler —
  er ist Producer, nicht Consumer. Und abgeholt wird bis heute keiner von beiden: die
  `ServiceMonitor`-Objekte für Writer und ingest baut laut §3.5 erst gitops.
- Alarm-Regeln, Schwellen, `ServiceMonitor` und Dashboards liegen im gitops-Repo; die neue
  Writer-Verwerfregel wird dort nachgezogen.

## Nachweise

`UemsMetricsScrapeTest` (je Metrik aus dem echten Scrape-Rumpf, „kein Scrape löst eine Abfrage aus“),
`UemsMetricsDbTest` (das SQL gegen eine echte Datenbank über die BYPASSRLS-Rolle, zwei
Kundenbereiche), `UemsMetricsEndpointE2eTest` (anonymes `GET /metrics`: keine Zeile trägt
Kundensprache), `UemsMetrikenWiringTest` (Katalog gegen den Code, Schalternamen gegen die echte
`application.yml`).

## Box-Sicht der Gemeinsamen Steuerung (AP-15 IP-11)

`metrics/GemeinsameSteuerungMetrikSammler` am selben Schalter und Takt: `voltpilot_uems_box_*` mit
`tenant`/`site`/`device`, nur für aktive Boxen mit `plan_zustellung`-Zeile, Herzschlag-Block oder
gültiger Mitgliedschaft (`repo/BoxMetrikRepository`, Admin-Rolle; Rolle und Anteils-Revision aus
`steuerungsverbund_mitglied`). Der Block `gemeinsame_steuerung` liegt nur im Prozess
(`metrics/GemeinsameSteuerungHerzschlag`, vom `DataSourceStatusListener` gefüllt). Namen, Leer-bis-Paket
und die acht Regeln: [Übergabe an Teil B](../../rollout/gemeinsame-steuerung-metriken.md).
⚠ „veröffentlicht“/„angenommen“ sind die ERZEUGUNG des Plans, nicht die Ankunft der Quittung — die
retained Quittung kommt nach jedem api-Neustart erneut und setzte ein Ankunfts-Alter zurück.
