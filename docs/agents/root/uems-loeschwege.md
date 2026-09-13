# UEMS-Löschwege: Abmelden baut aus, Entfernen lehnt mit Liste ab (AP-07 IP-11)

Paket AP-07 §8 IP-11 (E8, AP-06 E7, W6). Captain 13.09.2026: **beim Abmelden und beim Tausch geht kein
Datenbestand verloren.** Migration `V20260913150000__uems_loeschwege.sql`, Tests
`UemsLoeschwegeMigrationTest`, `UemsLoeschwegeApiTest` (A14), `ComponentAdoptionAusgebauteBoxTest`,
`WriterPipeTest.eineAusgebauteBoxNimmtNurWerteVorIhremAusbauAn`.

## Die drei Wege

| Weg | Route | Was geschieht | Ablehnung |
|---|---|---|---|
| **Abmelden** („Gerät entfernen") | `DELETE /api/v1/devices/{id}` | Box wird **ausgebaut** (`device.ausgebaut_am`, `status = 'ausgebaut'`, CHECK hält beides gleich, Trigger `device_ausgebaut_endgueltig`: Kennung/Mandant/Anlage/Zeitpunkt nie mehr änderbar). **Nichts Aufgezeichnetes wird gelöscht**: v1-Telemetrie, alle OCPP-Tabellen, `device_measurement_*`, `messreihe_ereignis`, Komponenten-Ist-Zustand, Freigaben bleiben. `DeviceRepository.ausDerTopologieLoesen` tut, was das FK-`SET NULL` tat (`measurement_point`, `asset`, `entity_registry_state`, `site.lead_device_id`); Broker, ACL, OTA-Zuweisung, Overrides wie vorher. | 404 fremd/schon ausgebaut |
| **Datenaufzeichnungen löschen** (Purge) | `POST /api/v1/devices/{id}/purge-data` + MQTT `purge_request` | wie heute (v1-Telemetrie + OCPP, Wasserzeichen) — die Messwert-Strecke war nie Teil davon | **409 `messstellen_belege` + Liste**, VOR Sperre/Wasserzeichen, schreibt nichts |
| **Anlage entfernen** | `DELETE /api/v1/sites/{id}` | wie heute, dazu räumt `uems_messwerte_der_anlage_entfernen(site)` die Messwert-Zeilen der Anlage und ihrer Boxen ab (die App-Rolle hat auf der Auswahl kein DELETE); ausgebaute Boxen gehen per Kaskade mit | 409 solange eine NICHT ausgebaute Box da ist; **409 `messstellen_belege` + Liste**, schreibt nichts |

**Beleg** = eine Reihe (Komponente + Kanal), die JE an eine Messstelle gebunden war: `messstelle_quelle`
(laufend/beendet), Protokoll `messstelle_aenderung` Art `quelle_gebunden` (`neu.komponente`/`neu.kanal` —
überlebt die Bindungs-Zeile, wenn deren Komponente per Kaskade ging) oder `messstelle_formel_term`. Die Regel
steht EINMAL in `uems_messreihen_belege(p_site, p_box)` (SECURITY INVOKER, RLS); Java `MessreihenBelege`,
Kundensatz + Körper `BelegeImWeg`. Die Anlage-Funktion prüft dieselbe Regel selbst — ein Beleg ist für jede
Rolle unlöschbar, die diesen Weg nimmt. Offboarding: `uems_messwerte_des_kundenbereichs_entfernen(tenant)`,
nur Verwaltungsrolle, in `TenantRepository.offboard`.

## Fremdschlüssel

`device_measurement_sample/event/point_state/selection_event` → `device` und → `site`, `device_measurement_selection`
→ `device`: **`ON DELETE RESTRICT`** (gleiche Namen, `NOT VALID` — der alte gleichlautende FK galt bis zum
Statement in derselben Transaktion; die Wirkung beim Löschen gilt sofort). `device_measurement_selection_entity_fk`
bleibt CASCADE (Einstellung, kein Wert). `uq_device_external_ref` ist partiell (`WHERE ausgebaut_am IS NULL`):
dieselbe Aufkleber-Kennung ist wieder anmeldbar, als neue Box.

## Die Live-Regel: gefiltert wird über den Zustand, nie durch Löschen

Jede Live-Fläche prüft `ausgebaut_am IS NULL`; Historie liest weiter alles. Umgestellt:
- **Box-Listen und -Zugänge** (`FROM device`): `DeviceRepository` (findAll/findById/findByExternalRef/update/countForSite),
  Enrollment-Lookup + ACL-Startliste, Ladekonfiguration, Verbraucher-Override, Registry-Push-Ziele, Mess-Config-Reconciler,
  Asset-Autolink, Steuer-Zertifizierung (4), Flotte/Übersicht/Metriken, OTA (2), Edge-Versionen, Admin-Registry und
  -Enrollment, Datenquellen-Boxwahl, Ingest `JdbcDeviceDirectory`; Trigger `uems_zustaendigkeit_box_pruefen` lehnt eine
  neue Zuständigkeit an einer ausgebauten Box ab.
- **Neu durch das Behalten** (vorher gelöscht): OCPP `stations`/`configurations`/Befehlsziel `target` (offene
  Ladevorgänge einer ausgebauten Box erscheinen nicht als laufend, beendete bleiben), `entity_observed_state`
  (`EntityObservedRepository.forSite`, `ComponentAdoptionRunner.withOrphanedPins`), `device_component_apply`
  (Anlage + Flotte), Messkanal-Auswahl (`MesskanalService`, `MessstelleFormelTermRepository`,
  `MessstelleFormelWerteRepository.quelle` bevorzugt aktive Box, Register-`kanalDefinition`), Lücken-Melder
  (Auswahl einer ausgebauten Box endet mit dem Ausbau; eine offene Reihen-Lücke schließt dort), Übersicht-Live-Karte,
  Auswahl-API (`aktiverDeviceScope`; Verlauf/Export der ausgebauten Box bleiben lesbar über `deviceScope`),
  Writer: Werte mit Messzeit **ab** `ausgebaut_am` werden abgewiesen, frühere (unterwegs) angenommen.

## Fallen

- ⚠ Die App-Rolle hat auf `device_measurement_sample/event/point_state` (Default-Rechte) DELETE, auf der Auswahl
  und ihrer Historie nicht — nicht ändern, ohne die Aufrufer zu prüfen; der Belegschutz steht in den Funktionen.
- ⚠ Eine neue Leser-Abfrage auf `device` oder einer Box-geschlüsselten Tabelle braucht die Live-Regel — sonst
  erscheint die ausgebaute Box als aktiv. Historie ausdrücklich NICHT filtern.
- ⚠ `MessstelleRegisterRepository.WERTE` filtert bewusst nicht: der jüngste gute Wert über alle Boxen ist
  zeitrichtig (nach dem Ausbau kommt von der alten Box nichts Neueres), und „liefert keine Daten seit …“ braucht
  den letzten Wert der ausgebauten Box.
- Die Ereignis-Zeiten der Lücken sind sekundengenau: eine mit dem Ausbau endende Lücke trägt `ausgebaut_am` auf die Sekunde.

## Offen / Befunde

- **Schon heute lecken 19 Live-Leser** (Herzschlag-Tabellen ohne FK, die das Abmelden nie geräumt hat) — **nicht
  durch IP-11**, als Folgepaket geschnitten (siehe Tabelle unten).
- `data_source_assignment.device_id` ohne FK (Bestand: Zeiträume gelöschter Boxen); ein offener Zeitraum wird beim
  Abmelden nicht beendet, „Gerät entfernen“ prüft Zuständigkeiten noch nicht (AP-06 IP-19).
- MQTT-`purge_request` einer Box mit Belegen: abgelehnt und geloggt; der Vertrag kennt keine Ablehnung, die Box
  wiederholt ihre Absicht bei jedem Verbinden.
- `MessstelleFormelWerteRepository.verlauf15m` liest je Term EINE Box — der Verlauf einer berechneten Messstelle
  über einen Box-Wechsel hinweg zeigt nur die Zeiträume der gewählten Box.

## Folgepaket: die 19 Live-Leser, die schon vor IP-11 leckten

Pfade relativ zu `services/api/src/main/java/com/voltpilot/api/`. „Alte Box“ = eine abgemeldete (heute: ausgebaute) Box derselben Anlage.

| # | Datei:Zeile | Was der Kunde fälschlich sieht |
|---|---|---|
| 1 | `repo/DeviceChargerStatusRepository.java:86` `ocppControlStatus` → `SiteOcppControlController:47,75` | den OCPP-Steuerstatus (Lastmanagement aktiv/inaktiv) der alten Box als aktuellen Stand der Anlage |
| 2 | `repo/DeviceChargerStatusRepository.java:222` `forSite` (Anschlüsse `:225`, Ladepunkte `:235`, Budget `:254` nimmt `get(0)`) → `SiteChargerController:52`, `VerbraucherService:115`, `ChargingBoostService:193`, `FahrzeugService:142`, `DeviceScopes:180`, `ChargingConfigService:384` | Ladepunkte und Anschlüsse der alten Box doppelt oder als verbunden; das Ladebudget kann aus der alten Box stammen; „Boost“ kann an sie adressiert werden; eine Ladekarte gilt über den eingefrorenen `tag_ref` weiter als „lädt gerade“ |
| 3 | `repo/DeviceChargerStatusRepository.java:187` `connectionsByEntity` → `TopologyService:205` | im Anlagenbild eine Verbindung Ladepunkt ↔ alte Box |
| 4 | `entities/EntityRegistryRepository.java:107` `chargePointIdsByEntity` → `EntityRegistryService:1045,1453`, `SteuerartService:232`, `VerbraucherService:131,252` | im Registry-Push und in der Steuerart Ladepunkt-Kennungen, die nur die alte Box meldete |
| 5 | `uems/DatenquelleBestandRepository.java:88-92` (`ORDER BY device_id LIMIT 1`) | in der Vorschlagsliste der Datenquellen die alte Box als Station-Box |
| 6 | `repo/CurtailmentStatusRepository.java:138` `latestForSite` (+ `device_curtailment_unit` `:147`) → `SiteController:508`, `CommandLogReader:176` | den Abregelungsstatus der alten Box, wenn ihr Bericht der jüngste ist |
| 7 | `repo/AdminFleetRepository.java:241` `curtailmentPerSite` | in der Admin-Flotte den Abregelungsstand der alten Box |
| 8 | `repo/ControlStatusRepository.java:127` `latestForSite` → `SiteController:486`, `CommandLogReader:175` | den Steuerstatus („regelt“ / Grund) der alten Box als aktuellen Stand |
| 9 | `repo/AdminFleetRepository.java:197` `controlPerSite` | in der Admin-Flotte den Steuerstatus der alten Box |
| 10 | `repo/AdminComponentFleetRepository.java:143` `controlPerSite` | in der Komponenten-Flotte den Steuerstatus der alten Box |
| 11 | `repo/ConsumerRuntimeStatusRepository.java:93` `listForSite`, `:102` `forEntity` | den Laufzeitstatus eines Verbrauchers (an/aus, zuletzt geschaltet) aus der alten Box |
| 12 | `repo/DeviceSourceStatusRepository.java:72` `forSite` → `SiteController:529`, `DeviceScopes:116` | Datenquellen-Rückmeldungen („liest“ / Fehlerklasse) der alten Box als aktuell |
| 13 | `consumers/ConsumerRepository.java:283` `reportedSources` → `ConsumerService:160,541` | beim Verbraucher-Anlegen Quellen, die nur die alte Box meldete |
| 14 | `repo/AdminFleetRepository.java:322` `sourceCountsPerSite` | in der Admin-Flotte Quellen-Zähler inklusive der alten Box |
| 15 | `repo/FlowStatusRepository.java:96` `nodeStatusesForSite` | im Flow-Editor Knoten-Status (grün/rot) der alten Box |
| 16 | `repo/FlowStatusRepository.java:86` `acksForSite` (`flow_device_ack`) → `FlowService.liveStatus:819,823` | Flow-Bestätigungen („auf der Box aktiv“) der alten Box |
| 17 | `repo/AdminFleetRepository.java:259` `edgeVersionPerSite` | in der Admin-Flotte den Software-Stand der alten Box |
| 18 | `repo/AdminFleetRepository.java:282` `updateStatusPerSite` | in der Admin-Flotte den Update-Status der alten Box |
| 19 | `repo/CommandLogRepository.java:451` `window()` / `:344` `count` → `CommandLogReader:124-126` | im Befehlsverlauf offene Halte-Zeiträume (`ended_at IS NULL`) der alten Box für immer als „läuft“ — hier gehört eher das Schließen beim Ausbau als ein Filter |
