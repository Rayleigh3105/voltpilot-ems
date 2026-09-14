# UEMS-Funktionen: Tabellen `funktion` und `funktion_teilnahme`, Umstieg aus dem Bestand

Neu am 14.09.2026 (AP-01 IP-2; Entscheide E6 = C, E7, E8; W5, W7; Abnahme A11). Migration
`services/api/src/main/resources/db/migration/V20260914190000__uems_funktion.sql`, Repositories
`uems/FunktionRepository` und `uems/FunktionTeilnahmeRepository`, Umstieg
`uems/FunktionBestandFakten` → `uems/FunktionBestandService` → `uems/FunktionBestandLaeufer`.
Die Regel ist der IP-1-Vertrag (`uems-funktions-zustand-je-standort-und-t.md`) — hier wird sie
nur ANGEWANDT. Beweis: `UemsFunktionMigrationTest`, `FunktionBestandApiTest`,
`FunktionBestandWiringTest`.

## Was es gibt — und was (noch) nicht

- `funktion` = eine Funktion (`messen` | `steuern`) an einem Standort mit Zustand und Zeitpunkt je
  Übergang, höchstens EINE nicht archivierte je Standort und Art (`uq_funktion_je_standort`).
  `funktion_teilnahme` = eine Anlage nimmt an „Steuern & Optimieren“ teil, höchstens EINE laufende
  je Anlage; `uebernommen` sagt „aus dem Bestand“ (Vertrag `teilnahmeEingang.uebernommen`).
- Zustände sind die Vertrags-Codes OHNE `kein_objekt` (kein Objekt = keine Zeile). Messen kennt nur
  `entwurf|aktiv|archiviert`; eine Teilnahme hängt per zusammengesetztem FK
  `(funktion_id, tenant_id, funktion='steuern')` nur an „Steuern“. `archiviert` ⟺ `archiviert_am`
  bzw. `beendet_am`; `angehalten` braucht `angehalten_seit`; `entwurf`/`eingerichtet` tragen weder
  Start noch Anhalten. Die Beobachtungen „liefert Daten“/„steuert“ werden nie gespeichert.
- Kein Endpunkt, keine Fläche, kein Übergang starten/anhalten (IP-3/IP-4). Messen bekommt beim
  Umstieg KEIN Objekt (A11). Der Löschweg einer Anlage beendet ihre Teilnahme noch nicht (offen
  für IP-3) — die Zeile bleibt stehen (W5, kein FK auf `site`, Einfüge-Trigger
  `funktion_teilnahme_site_fk`).

## ⚠ Die Fallen

- **Die Migration füllt NICHTS.** Die Standorte der Bestandskunden legt erst der Start-Läufer
  `BestandsuebernahmeLaeufer` an, NACH allen Migrationen — eine SQL-Füllung fände beim Ausrollen
  keinen Standort, und die Regel wäre eine zweite Wahrheit neben dem Java/TS-Vertrag. Darum
  kommen beide Tabellen LEER (der Bestandsschutz-Vergleich der Nachbar-Migrationstests bleibt grün).
- **Reihenfolge über `@Order`, sonst keine.** Zwei `ApplicationReadyEvent`-Hörer ohne Angabe haben
  keine zugesagte Reihenfolge. `BestandsuebernahmeLaeufer.beimStart` trägt `@Order(ORDER)`
  (`LOWEST_PRECEDENCE - 100`, also vor den unsortierten Start-Läufern), `FunktionBestandLaeufer`
  `@Order(ORDER + 1)`. KEIN Ereignis und kein `ApplicationEventPublisher`: der Wächter
  `BestandsuebernahmeApiTest.keinDienstDerUebernahmeKenntEinenPublisher` prüft die
  Konstruktor-Typen nach dem Namen „Publisher“ (für die Funktions-Klassen dasselbe in
  `FunktionBestandWiringTest`).
  Schalter `voltpilot.uems.funktion-bestand.enabled`: Vorgabe AN (`application.yml`), im
  Testlauf AUS (`pom.xml`) — wer ihn prüft, ruft `lauf()` selbst.
- **Idempotent über „irgendeine Teilnahme“.** Eine Anlage mit einer Teilnahme (auch beendet) wird
  nie wieder betrachtet. Eine Anlage OHNE Zeile („reine Messung“) wird bei jedem Start neu gelesen:
  läuft bei ihr inzwischen etwas, bekommt sie „aktiv (übernommen)“ und ihr Standort zieht nach.
  Nur HEUTE zugeordnete Anlagen nicht archivierter Standorte zählen (Tage inklusiv, Zeitzone des
  Standorts); ohne Standort (nur Vorschläge) nichts.
- **Die Abbildung Bestand → Fakten** (`FunktionBestandFakten`), im Zweifel „läuft“ — eine
  steuernde Anlage fälschlich in Ruhe zu übernehmen schaltete sie mit IP-4 ab:
  Betriebsmodell an = Karte der Exklusiv-Gruppe `speicher` mit `active` aus
  `SiteProfileService.profiles` (gespeichert `an` ODER abgeleitet; `seit` nur bei gespeichertem
  `an`) · Scharfschaltung = Zeile `device_control_activation` an einem nicht ausgebauten Gerät
  der Anlage (mandantenfrei → BYPASSRLS, eng auf Mandant + Anlage) · Eigenverbrauch = scharf UND
  `speicher-fahrplan` aktiv · Steuerart/Regel = aktive `consumer_policy` eines eingeschalteten
  Verbrauchers, aktiver `flow_definition` (seit `activated_at`) oder Lade-Steuerart
  `nur_sonne|sonne_zuerst` (Anlage oder Ladepunkt, ohne Datum). Wer eine neue Betriebsweise baut,
  trägt sie HIER ein.
- **Lesend gegenüber dem Bestand (A11).** Der Lauf schreibt nur `funktion`/`funktion_teilnahme`;
  `FunktionBestandApiTest` vergleicht `site_profile_state` Zeile für Zeile als Text und jede andere
  Tabelle per `Bestandsschutz`. Urheber „VoltPilot (Bestandsübernahme)“ (`OrtProtokoll.akteurName`).
- **Offboarding:** `TenantRepository.offboard` löscht `funktion_teilnahme`, dann `funktion`, vor
  `standort`. Die App-Rolle hat kein DELETE und ändert nur Zustand und Zeitpunkte (Spaltenrechte).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='UemsFunktionMigrationTest')   # 8, Testcontainers
(cd services/api && ./mvnw test -Dtest='FunktionBestandApiTest')      # 4, Testcontainers + Dev-Saat
(cd services/api && ./mvnw test -Dtest='FunktionBestandWiringTest')   # 5, rein
```
