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

Die zwei `…_zustand`-Metriken sind der Hausstil von `voltpilot_site_telemetry_state`. Ohne sie kann
eine Regel „steht“ nicht von „ist abgeschaltet“ und „lief seit dem Neustart noch nie“ unterscheiden
— und ein abgeschalteter Läufer soll gerade KEINEN Daueralarm erzeugen.

## Die dreizehn Läufer

Der Katalog steht in `UemsLaeuferMelder.KATALOG` und ist VOLLSTÄNDIG: `UemsMetrikenWiringTest` liest
die Quelltexte von `uems`, `unterstuetzung` und `zugriff` und verlangt für jede Klasse mit
`@Scheduled` oder `ApplicationReadyEvent` einen Eintrag. Wer einen Läufer ergänzt und den Katalog
vergisst, wird dort rot — sonst bliebe der neue Läufer still unbeobachtet.

| `laeufer` | Klasse | Schalter | Takt |
|---|---|---|---|
| `viertelstunde` | `ViertelstundeLaeufer` | `voltpilot.uems.viertelstunde.enabled` | 5 min |
| `endgueltigkeit` | `EndgueltigkeitLaeufer` | `voltpilot.uems.endgueltigkeit.enabled` | 1 h |
| `luecken` | `LueckenLaeufer` | `voltpilot.uems.luecken.enabled` | 5 min |
| `ersatzwert` | `ErsatzwertLaeufer` | `voltpilot.uems.ersatzwert.enabled` | 5 min |
| `kaskade` | `KorrekturKaskadeLaeufer` | `voltpilot.uems.kaskade.enabled` | 5 min |
| `bericht_struktur` | `StrukturAenderungLaeufer` | `…berichte.struktur.enabled` UND `…berichte.enabled` | 5 min |
| `zeilentexte` | `ZeilentextAufbewahrungLaeufer` | `voltpilot.uems.zeilentexte.enabled` | täglich 03:17 Europe/Berlin |
| `uebergabe` | `UebergabeLaeufer` | `voltpilot.uems.uebergabe.enabled` | 1 s |
| `box_tausch` | `BoxTauschZustellung` | `voltpilot.uems.uebergabe.enabled` | 15 s |
| `unterstuetzung` | `AblaufLaeufer` | `voltpilot.uems.unterstuetzung.enabled` | 1 min |
| `bestand_standort` | `BestandsuebernahmeLaeufer` | `voltpilot.uems.bestandsuebernahme.enabled` | Start |
| `bestand_funktion` | `FunktionBestandLaeufer` | `voltpilot.uems.funktion-bestand.enabled` | Start |
| `bestand_rechte` | `ZugriffBestandLaeufer` | `voltpilot.uems.zugriff-bestand.enabled` | Start |

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
- **Messkunde = `funktion.funktion = 'messen' AND funktion.zustand = 'aktiv'`** — dieselbe Bedingung,
  die das Produkt in `NetzanschlussVorschlagService` stellt.
- **Gelesen wird über `adminJdbcTemplate` (`voltpilot_admin`, BYPASSRLS).** Unter der Mandanten-RLS
  gäbe jede dieser Abfragen null Zeilen zurück, und null Zeilen hieße hier „kein Rückstand, kein
  Messkunde ohne Werte“: ein stiller Fehlalarm in die beruhigende Richtung.
- **Kein Scrape löst eine Abfrage aus** (das Muster von `DbStorageMetricsCollector`). Was der Scrape
  rechnet, ist Arithmetik auf dem zuletzt gesammelten Zeitpunkt — darum wachsen die Alter zwischen
  zwei Sammel-Läufen weiter, und ein ausgefallener SAMMLER wird an denselben Regeln sichtbar, ohne
  eigene Metrik.
- **Kardinalität**: drei Arbeitslisten, dreizehn Läufer, ein Wert je Messkunden-Kundenbereich. Keine
  Anlage, keine Box, keine Messstelle als Label — und `tenant` trägt die INTERNE Kennung, nie einen
  Namen.

## Was hier NICHT entsteht

- Die ★-Metrik „Verbraucher-Rückstand je Gruppe“ der Schicht „Strecke“ liegt beim Writer und beim
  ingest, nicht in der api. Der Writer hat sie halb: `voltpilot_kafka_consumer_lag{group,topic}` aus
  `services/timescale-writer/.../KafkaLagMetricsCollector` auf seinem `/metrics` (8092). Der ingest
  hat sie gar nicht — er veröffentlicht nur `/health` auf 8091, keinen Metrik-Endpunkt. Und
  abgeholt wird bis heute keiner von beiden: die `ServiceMonitor`-Objekte für Writer und ingest baut
  laut §3.5 erst IP-10 in gitops.
- Alarm-Regeln, Schwellen, `ServiceMonitor` und Dashboards liegen im gitops-Repo; die neue
  Writer-Verwerfregel wird dort nachgezogen.

## Nachweise

`UemsMetricsScrapeTest` (je Metrik aus dem echten Scrape-Rumpf, „kein Scrape löst eine Abfrage aus“),
`UemsMetricsDbTest` (das SQL gegen eine echte Datenbank über die BYPASSRLS-Rolle, zwei
Kundenbereiche), `UemsMetricsEndpointE2eTest` (anonymes `GET /metrics`: keine Zeile trägt
Kundensprache), `UemsMetrikenWiringTest` (Katalog gegen den Code, Schalternamen gegen die echte
`application.yml`).
