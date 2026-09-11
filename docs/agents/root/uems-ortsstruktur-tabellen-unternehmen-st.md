# UEMS-Ortsstruktur-Tabellen: Unternehmen, Standort, Anlagen-Zuordnung, Änderungsprotokoll

Neu angelegt am 11.09.2026 (AP-02 IP-2a — die ersten UEMS-Tabellen). Migration
`services/api/src/main/resources/db/migration/V20260911100000__uems_unternehmen_standort.sql`,
Repositories im Paket `com.voltpilot.api.uems` (`UnternehmenRepository`, `StandortRepository`,
`AnlageStandortRepository`, `OrtAenderungRepository`), Beweis
`UemsStandortMigrationTest` (Testcontainers). Die Prosa-Wahrheit ist das AP-02-Konzept (§4.1
Felder, §4.2 Zustände, §4.5 Invarianten, §6.2/§6.3); die Gültigkeitsmechanik ist der Vertrag
`docs/contracts/v2/ortsbaum-vectors.json` (siehe `uems-ortsbaum-zeitgueltige-zuordnungen-a.md`).

## Was es gibt — und was (noch) nicht

- `unternehmen` 1 : 1 neben `tenant` (UNIQUE `tenant_id`), Backfill je Mandant: Name des
  Kundenbereichs (getrimmt, ≤ 120, leer → „Unternehmen“), `Europe/Berlin`, dazu EIN
  Protokolleintrag „angelegt“ durch „VoltPilot (Bestandsübernahme)“. Die App-Rolle darf es
  lesen und ändern, **nicht anlegen**: ein Kundenbereich, der NACH der Migration entsteht, hat
  noch KEIN Unternehmen, bis sein Anlege-Weg es mitbringt (offen für IP-3/IP-4).
- `standort`, `anlage_standort` und `ort_aenderung` sind nach der Migration LEER: Standorte und
  Zuordnungen der Bestandskunden legt erst die Bestandsübernahme an (IP-9). Kein Endpunkt, kein
  Read-Model, keine Fläche (IP-3/IP-4). `site` und `tenant` sind zeichengleich (der Test
  vergleicht Spalten, Zeilen, Constraints, Indexe, Policies, Trigger und Rechte).

## ⚠ Die Fallen, die der Test gefunden hat

- **Nie Kaskade → das Offboarding räumt ausdrücklich ab.** Jeder Fremdschlüssel auf
  `tenant`/`site`/`unternehmen`/`standort` ist `ON DELETE RESTRICT`. `TenantRepository.offboard`
  löscht deshalb `anlage_standort`, `standort`, `unternehmen` VOR dem Mandanten — wer eine neue
  RESTRICT-Tabelle mit `tenant_id` anlegt, trägt sie dort ein, sonst bricht das Offboarding
  jedes Bestandsmandanten. `ort_aenderung` hat (wie `component_change_event`) gar keinen
  Fremdschlüssel und bleibt nach dem Offboarding stehen. Eine Anlage mit Zuordnung ist nicht
  löschbar, bis IP-9/AP-14 den Grabstein (AP-02 W5) baut.
- **`tenant_id` VORN in jedem Exklusions-/Unique-Schlüssel.** Ein Exklusions-Constraint und
  ein Unique-Index prüfen VOR dem Fremdschlüssel und OHNE RLS: ohne `tenant_id` im Schlüssel
  nannte die Ablehnung einem fremden Mandanten die Intervalle (bzw. Namen) einer Anlage, die er
  nicht sehen darf. Deshalb `EXCLUDE (tenant_id =, site_id =, daterange(…,'[]') &&)` und
  `uq_standort_name_nicht_archiviert (tenant_id, unternehmen_id, lower(btrim(name)))`.
- **Ein CHECK nimmt NULL an.** `land = 'DE' AND …` ist bei fehlendem Land NULL, und
  `array_ndims('{}')` ist NULL — beides ließ ein CHECK durch. Die PLZ-Regeln und
  `uems_nutzung_gueltig` stehen deshalb in `coalesce(…, false)`.

## Vokabulare (Codes, nie Kundenwörter)

Zeitzone `Europe/Berlin|Europe/Vienna|Europe/Zurich` · Land `DE|AT|CH` (PLZ DE fünf, AT/CH vier
Ziffern) · Standort-Zustand `entwurf|eingerichtet|aktiv|archiviert` (kein „angehalten“ am Ort;
`archiviert` ⟺ `archiviert_am`) · Nutzung über die Funktion `uems_nutzung_gueltig` (Kundenwort
kleingeschrieben, ä→ae, ö→oe, ü→ue, ß→ss; die erste ist die Hauptnutzung; IP-2b benutzt dieselbe
Funktion) · `ort_aenderung.art` `angelegt|bearbeitet|verschoben|korrigiert|flaeche_geaendert|
archiviert|wiederhergestellt|geloescht` — ein Paket, das mehr braucht, weitet den CHECK durch
Abschreiben des aktuellen Stands. Die App-Rolle ändert an `anlage_standort` nur `gueltig_bis`
und `aufgehoben_am` (Spaltenrecht); löschen darf sie auf keiner der vier Tabellen.
