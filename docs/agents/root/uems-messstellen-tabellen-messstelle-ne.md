# UEMS-Messstellen-Tabellen: Messstelle, Nebengröße, Kennzeichen-Belegung, Zähler, Änderungsprotokoll

Neu angelegt am 11.09.2026 (AP-04 IP-2). Migration
`services/api/src/main/resources/db/migration/V20260911140000__uems_messstelle.sql`,
Repositories im Paket `com.voltpilot.api.uems` (`MessstelleRepository`,
`MessstelleAenderungRepository`), Beweis `MessstelleMigrationTest` (Testcontainers). Die Regeln
sind der Vertrag `docs/contracts/v2/messstelle.md` mit dem Zwilling `MessstelleRegeln` (siehe
`uems-messstellen-vertrag-kennzeichen-gro.md`); die Tabellen sagen dasselbe als Constraint, und
der Test spielt die Kennzeichen-Fälle der Vektor-Datei gegen die Datenbank.

## Was es gibt — und was (noch) nicht

- `messstelle`: heutiges Kennzeichen, Name (NULL = fehlt noch, ein Entwurf; ein leerer Name wird
  abgelehnt), Art, Medium (volles Schema-Vokabular), die EINE Hauptgröße (Größe · Richtung ·
  Einheit · Wertart, geprüft von `messstelle_groesse_im_katalog`), Notiz. Art, Medium und
  Hauptgröße sind per Trigger nie änderbar. Gespeichert werden NUR die Zustands-Eingänge
  `angehalten_ab` / `archiviert_am` — Entwurf/eingerichtet/aktiv leitet
  `MessstelleRegeln.lebenszyklus` ab, eine gespeicherte Stufe liefe der Vollständigkeit hinterher.
- `messstelle_groesse`: Nebengrößen, je `(groesse, richtung)` einmal und nie die Hauptgröße (so
  identifiziert `MessstelleRegeln.Bindung` die Größe einer Quelle); Medium über den Verweis
  `(messstelle_id, tenant_id, medium)` gleich dem der Messstelle.
- `messstelle_kennzeichen_seq`: der Zähler je Mandant, `messstelle_aenderung`: das Protokoll
  (wie `ort_aenderung`: append-only per Trigger, ohne Fremdschlüssel; geht erst im Löschzug nach der
  Mandantenzeile mit, `V20260925234500`).
- Kein Endpunkt (IP-3), keine Zuordnung zu Ort/Stellung (IP-7), keine Quellenbindung (IP-13).

## ⚠ Die Fallen

- **Ein Kennzeichen wird nie weitergegeben — auch kein früheres.** `UNIQUE (tenant_id,
  kennzeichen)` sieht nur das heutige. Der Trigger `messstelle_kennzeichen_belegen` (SECURITY
  DEFINER; die App-Rolle darf die Belegung nur lesen) schreibt JEDE Vergabe und Umbenennung nach
  `messstelle_kennzeichen`. Die Ablehnung ist 23505 an `messstelle_kennzeichen_eindeutig` (heute
  getragen, auch archiviert) ODER `messstelle_kennzeichen_belegt` (früher getragen) — beides ist
  409 `kennzeichen_belegt`; das Urteil mit dem Träger holt die Route VOR dem Schreiben mit
  `MessstelleRepository.vergeben()` + `MessstelleRegeln.kennzeichenPruefen`.
- **Die automatische Vergabe braucht EINE Transaktion.** `anlegen` mit Kennzeichen `null`
  sperrt die Zählerzeile (`SELECT … FOR UPDATE`), vergibt den Vorschlag der Regeln und rückt den
  Zähler vor; ohne aktive Transaktion verweigert sie (`IllegalStateException`). Der
  8-Threads-Test wird ohne `FOR UPDATE` rot (`DuplicateKeyException`) — nachgewiesen.
- **Postgres prüft CHECKs in der Reihenfolge ihrer NAMEN.** Ein unbekanntes Medium scheitert an
  `messstelle_hauptgroesse_katalog` (h…), bevor `messstelle_medium_chk` (m…) spricht. Wer eine
  bestimmte Constraint-Ablehnung erwartet, prüft die Namensreihenfolge.
- **Nie Kaskade → das Offboarding räumt ausdrücklich ab** (dieselbe Linie wie die Ortsstruktur):
  `TenantRepository.offboard` löscht `messstelle_groesse`, `messstelle_kennzeichen`,
  `messstelle`, `messstelle_kennzeichen_seq` VOR den Ortsstruktur-Tabellen und dem Mandanten.
- **Urheber heißt `actor_*`** (AP-03-Vokabular: `actor_sub` NULL nur bei `actor_art`
  „voltpilot“; `actor_rolle` ist die Rollen-KENNUNG aus `docs/contracts/v2/rechte-matrix.json` =
  `RechteAbleitung.Rolle`, nie das Kundenwort — der Test pinnt den CHECK gegen das Enum);
  `ort_aenderung` nennt dieselben Felder `akteur_*` — AP-03 IP-7 vereinheitlicht.
