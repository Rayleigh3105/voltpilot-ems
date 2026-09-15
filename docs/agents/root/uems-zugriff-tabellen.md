# UEMS-Zugriffs-Tabellen: Benutzer-Spiegel, Zuweisung, Zugriffsprotokoll — und die Bestandsübernahme (AP-03 IP-2)

Neu angelegt am 15.09.2026. Migration
`services/api/src/main/resources/db/migration/V20260915030000__uems_zugriff.sql`, Beweis
`UemsZugriffMigrationTest` (Testcontainers; spielt JEDE Zuweisung von `rechte-vectors.json` gegen die DB),
`ZugriffBestandTest` (Bestandsübernahme gegen eine echte DB, Keycloak als Attrappe) und
`ZugriffBestandWiringTest` (Schalter, Hintergrund-Lauf, Ereignis). Der Vertrag ist
`rechte-vectors.json` + `rechte-matrix.json` (`uems-rechte-matrix-als-daten-und-rechte-v.md`). Code:
`services/api/src/main/java/com/voltpilot/api/zugriff/` (`ZugriffRepository`, `ZugriffBestand`,
`ZugriffBestandLaeufer`, `KundenbenutzerAngelegt`).

## Was es gibt — und was (noch) nicht

- `benutzer` (Schlüssel `tenant_id` + `sub`): der Spiegel eines Kontos je Kundenbereich — `konto`
  benutzer · partner · plattform, `zustand` angelegt · aktiv · gesperrt · entfernt, Einladung, Annahme, letzte
  Anmeldung. Keycloak bleibt die Identität (E11).
- `zugriff`: Rolle × Standort (`standort_id` NULL = mandantenweit) × Gültigkeit. Die Unterstützung ist die Rolle
  `unterstuetzer` mit `art` + `umfang` + Ende. Eine Zuweisung an drei Standorte sind drei Zeilen.
- `zugriff_protokoll`: `aktion`, Betroffener (Subject UND Name), Zuweisung, Geltungsbereich, Zeit, Grund, Akteur
  (`actor_*` wie `kennzahl_aenderung`).
- ⚠ **Noch setzt niemand durch:** seit IP-4 lädt der `ZugriffContext` die Zuweisungen je Anfrage und `/me` zeigt
  sie (`uems-zugriff-kontext.md`), aber es gibt keine Policy `site_scope` (IP-5) und kein `@Recht` (IP-6/IP-7).
  `ProtokollAkteur` legt die Rolle weiter fest (Kundenbenutzer = Kundenadministrator).

## ⚠ Zeit: drei Spalten, eine Tatsache

- `gueltig_ab` ist ein Zeitpunkt. `gueltig_bis` (DATE) ist das Enddatum, letzter Tag EINSCHLIESSLICH.
  `endet_am` ist derselbe Ablauf als Zeitpunkt: Folgetag 00:00 in `zeitzone` (= `RechteAbleitung.bisZeitpunkt`).
  Der CHECK `zugriff_ende_chk` hält beide gleich. Nur der Notfall-Zugriff trägt allein `endet_am` (24 h).
- Wirksam zu t ⇔ `zugriff_zeitraum(gueltig_ab, endet_am, beendet_am) @> t` — halboffen, vor dem Beginn beendet
  = leer. `ZugriffRepository.wirksam` fragt genau das. `Zeile.alsZuweisung()` ist die Vertrags-Zuweisung mit
  EINEM Standort; IP-4 fasst sie für `darf` zusammen.
- Wer schreibt, rechnet `endet_am` IMMER mit `bisZeitpunkt` in der Zone des Kundenbereichs (Unternehmen, sonst
  Europe/Berlin).

## ⚠ Nie umschreiben, einmal beenden, keine Überlappung

- Trigger `zugriff_nur_beenden`: jede Änderung außer `beendet_am/_von/_grund` → `zugriff_nur_beenden`; ein zweites
  Beenden → `zugriff_einmal_beendet` — für jede Rolle, auch den Eigentümer. Die App-Rolle hat UPDATE nur auf diese
  drei Spalten und kein DELETE. Eine Unterstützung verlängern (E6) = neue Zeile oder neue Migration — IP-8 entscheidet.
- Beenden braucht `beendet_von` (Subject einer Person). `beendet_grund` ist freiwillig (§4.7), nie leer.
- Exklusion `zugriff_keine_ueberlappung` je (Kundenbereich, Benutzer, Rolle, `coalesce(standort_id, Null-UUID)`).
  Eine andere Rolle oder ein anderer Standort überlappt nicht.
- Der Geltungsbereich kommt aus der Rolle (`zugriff_rolle_geltung`): `unternehmen` ⇒ ohne Standort,
  `standort`/`standort_befristet` ⇒ genau einer; `voltpilot_betrieb` ist keine Zuweisung (`zugriff_rolle_chk`).
- NICHT in der DB (Sache der Schreibwege): 12 Monate/30 Tage (E6), genau 24 h Notfall, letzter
  Kundenadministrator, eigene Zuweisung, „Entzug wirkt sofort".

## ⚠ Die Vokabular-Bindung

- `zugriff_vokabular()` = `vokabular.konto|konto_zustand|art|umfang|aenderung`, Zeile für Zeile;
  `zugriff_rolle()` = Matrix `rollen` (Kennung, Geltungsbereich, zuweisbar). Nicht gespeichert: `ocpp_stufe`,
  `unterstuetzung_zustand`, `rolle_noetig_reihenfolge`. Weitet der Vertrag, druckt der Test den VALUES-Block —
  eine NEUE Migration ersetzt nur die Funktion; danach alle Leser von `rechte-vectors.json` laufen lassen.
- Protokoll-Wörter = Vertrag: `zuweisen · entziehen · sperren · entfernen`. Gewähren, Verlängern, erste Anmeldung
  → zuerst den Vertrag weiten.

## ⚠ Bestandsübernahme (E12)

- Regel: jedes Keycloak-Konto mit `tenant_id` des Kundenbereichs bekommt den Spiegel (deaktiviert = `gesperrt`).
  Hatte es hier NIE eine Zuweisung, wird es Kundenadministrator: mandantenweit, ab jetzt, Protokoll `zuweisen`,
  Urheber und Grund „Bestandsübernahme". „Nie" statt „keine wirksame": ein Entzug kommt nicht zurück.
- Zwei Wege:
  - `ZugriffBestandLaeufer`: `ApplicationReadyEvent`, eigener virtueller Thread, Schalter
    `voltpilot.uems.zugriff-bestand.enabled` (prod AN, surefire AUS).
  - Ereignis `KundenbenutzerAngelegt` aus `RegistrationController` und `AdminController.createUser`. Der Hörer
    `ZugriffBestand.beiAnlage` ist isoliert: er wirft nie, zählt `voltpilot_zugriff_bestand_total{ergebnis="fehler"}`
    und stellt den `TenantContext` wieder her.
- ⚠ **Für IP-13/IP-14:** eine Kundenroute, die ein Konto anlegt, schreibt seine Zuweisung in DERSELBEN Handlung und
  veröffentlicht `KundenbenutzerAngelegt` nicht. Sonst macht der nächste Start das Konto zum Kundenadministrator,
  denn die Regel kennt nur „nie eine Zuweisung".
- Ist Keycloak nicht erreichbar, endet der Lauf mit EINER Meldung. Eine Ablehnung für einen Kundenbereich hält die
  anderen nicht auf. Je Kundenbereich läuft EINE Transaktion unter
  `pg_advisory_xact_lock(hashtext('uems-zugriff-bestand:<tenant>'))`.

## Zaun, Rechte, Offboarding

- RLS ENABLE + FORCE + Policy mit USING/WITH CHECK auf allen drei Tabellen. Die zusammengesetzten FKs tragen
  `tenant_id` (Standort, Benutzer, Zuweisung im Protokoll) und sind alle RESTRICT.
- App-Rolle: SELECT + INSERT, UPDATE nur `benutzer(anzeigename, email, zustand, angenommen_am, zuletzt_angemeldet)`
  und `zugriff(beendet_*)`, dazu das Sequenz-Recht auf `zugriff_protokoll_id_seq`. Verwaltungsrolle: SELECT + DELETE.
- `TenantRepository.offboard` räumt `zugriff_protokoll` → `zugriff` → `benutzer` ab, VOR Kennzahlen und Standorten.
- Ein Standort mit Zuweisung ist nicht löschbar (FK). Heute gibt es keinen Standort-Löschweg; wer einen baut,
  zählt `zugriff` als Historie.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='UemsZugriffMigrationTest,ZugriffBestandTest,ZugriffBestandWiringTest')
```
