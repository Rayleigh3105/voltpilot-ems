# UEMS-Datenquellen-Tabellen: Datenquelle, zeitgültige Zuständigkeit je Box, führende Box

Neu angelegt am 11.09.2026 (AP-06 IP-2). Migration
`services/api/src/main/resources/db/migration/V20260911150000__uems_datenquelle_zustaendigkeit.sql`,
Repositories im Paket `com.voltpilot.api.uems` (`DatenquelleRepository`,
`ZustaendigkeitRepository`), Beweis `UemsDatenquelleMigrationTest` (Testcontainers). Die Regeln
sind der Vertrag `docs/contracts/v2/data-source-assignment.md` mit `DatenquelleRegeln` (siehe
`uems-datenquelle-und-zustaendigkeit-als.md`); der Test spielt dessen Familien `zeitraeume`,
`antrag` und `zustaendig` gegen die Datenbank.

## Was es gibt — und was (noch) nicht

- `data_source` (Kennzeichen DQ-n, Anlage, Name optional, Protokoll, Adresse, Geräte-IDs,
  Netzlage, `mehrere_leser`, `steuerquelle`, `kadenz_s`, Archiv-Felder),
  `data_source_kennzeichen_seq` (der Zähler je Kundenbereich) und `data_source_assignment`
  (Box · ab · bis). Nach der Migration LEER.
- `site.lead_device_id` und `measurement_point.data_source_id`: je EINE nullable Spalte mit
  ihrem Fremdschlüssel, sonst sind beide Tabellen zeichengleich; der Bestand behält NULL.
- Kein Endpunkt (IP-3), keine Vorschlagsliste (IP-4); `site.lead_device_id` liest seit IP-5
  allein `LeadDeviceService` (Ziel von Registry-Push und Flow-Aktivierung,
  `uems-fuehrende-box-lead-device-service.md`), Mess-Plan und Herzschlag lesen keine der neuen
  Spalten. Kein
  Quellen-Protokoll (bringt IP-3 mit), keine Rücknahme eines geplanten Wechsels (IP-12). Der
  ⚠-Stand-Hinweis im Vertrag („es gibt keine Tabelle …“) ist mit IP-2 überholt und wird mit
  IP-3 nachgezogen.

## ⚠ Die Fallen, die der Test gefunden hat

- **ZEITPUNKTE halboffen, nicht Tage.** `tstzrange(effective_from, effective_to, '[)')`,
  `effective_to` gehört nicht dazu — anders als `anlage_standort` (`daterange … '[]'`). Die
  volle Minute prüft ein CHECK in UTC (`date_trunc` auf `timestamptz` hinge an der Sitzung).
- **Die lesende Box hat KEINEN Fremdschlüssel.** RESTRICT bräche das heutige Unclaim, CASCADE
  löschte die Herkunft, SET NULL tilgte sie still. Der Trigger `data_source_assignment_box_pruefen`
  prüft Box + Mandant beim Eintragen (unter RLS ist eine fremde Box „nicht vorhanden“, gemeldet
  als 23503 `data_source_assignment_box_fk`), danach überlebt der Zeitraum seine Box. Er fragt
  NUR, wenn sich Box oder Mandant wirklich ändern: die `ON UPDATE CASCADE` einer neuen Adresse
  setzt `tenant_id` mit — sonst wäre die Adresse einer Quelle unänderbar, sobald eine Box ihrer
  Geschichte entfernt ist (der Unclaim-Test fängt genau das).
- **Eindeutigkeit je Box braucht die Kopie des Wegs.** Protokoll + Adresse stehen an der
  Quelle, die Box am Zeitraum; der Exklusions-Constraint `…_ein_weg_je_box` sieht eine Zeile.
  Darum trägt jeder Zeitraum Protokoll + Adresse, gehalten vom Fremdschlüssel
  `(data_source_id, tenant_id, protokoll, adresse)` `ON UPDATE CASCADE`. Eine geänderte
  Adresse gilt für die ganze Geschichte der Quelle (der Vertrag führt sie ohne Zeit).
- **`SET NULL (spalte)`** (PG 15+): `site_lead_device_fk` setzt beim Unclaim nur
  `lead_device_id`, nie `tenant_id`. Der Kreis site → device (Kaskade) → site (SET NULL) bricht
  weder das Löschen einer Anlage noch das Offboarding.
- **Offboarding:** `measurement_point.data_source_id` ist RESTRICT, die Komponenten gehen aber
  erst mit der Mandanten-Kaskade — `TenantRepository.offboard` löst deshalb zuerst den Verweis
  (`UPDATE … SET data_source_id = NULL`), dann Zeiträume, Quellen, Zähler.

## Wer was trägt

Die Datenbank: `protokoll_unbekannt`, `keine_volle_minute`, `leerer_zeitraum`,
`ueberschneidung` (auch ein Wechsel VOR einem geplanten), `adresse_an_box_vergeben`. Der
Schreibweg mit `DatenquelleRegeln` (IP-3): `rueckwirkend` (ein „jetzt“ gehört in keinen
Constraint), `steuerquelle`, `schon_zustaendig`, Netzlage/Ein-Leser/Vergleichsquelle an einer
ANDEREN Box, Prüfung. `jederGrundEinesAntragsHatGenauEinenTraeger` hält die Aufteilung
vollständig. Kennzeichen: `uems_datenquelle_kennzeichen(tenant)` — nächste freie Nummer, der
Zähler rückt nur mit einer gespeicherten Quelle vor. Die App-Rolle ändert an
`data_source_assignment` nur `effective_to` und löscht auf keiner der drei Tabellen.
