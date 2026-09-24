# UEMS-Energiemanagement: Datenhaltung von Grundlage und Dokument (AP-19 IP-5)

Neu am 25.09.2026: Migration `V20260925013500__uems_energiemanagement.sql`, neun leere Tabellen, keine Route, kein
Leser, keine Fläche. Routen: Personen und Aufgaben IP-6 ([gebaut](uems-energiemanagement-personen.md)), Dokument IP-7, Verzeichnis IP-8; Audit und Feststellung
bauen in IP-16 daneben ([Audit und Feststellung](uems-audit-feststellung-datenhaltung.md)). Konzept: AP-19 §4.2–§4.5, §4.11, §5.6, §6.1 (`vp-uems-ap19-fundament/report.md`).

| Stelle | Was |
|---|---|
| `energiemanagement_vokabular()` + `energiemanagement_wort()` | die 25 `vokabulare` von [`energiemanagement-vectors.json`](../../contracts/v2/energiemanagement-vectors.json) (IP-2) zeilengleich, dann `leitungs_pflicht` (DK3), dazu Wörter nur der Tabellen: `kennung_art`, `anwendungsbereich_ausschluss`, `energiemanagement_protokoll` (§5.6). `dokument_art_klasse` ist `energiemanagement_dokument_klasse(art)`. Weiten = `CREATE OR REPLACE` mit der GANZEN Liste |
| `energiemanagement_kennung_seq` | ein Zähler (BIGINT) für D-nnnn (Jahr 0 = ohne Jahr, `^D-[0-9]{4,13}$` wie BB-) und AU-/F-JJJJ-nnnn (IP-16) — die Muster sind `kennzeichen_muster` des Vertrags; `uems_energiemanagement_kennung(tenant, art, jahr)` (bei D `jahr` NULL), `…_vorruecken` schiebt hinter ein gesetztes Kennzeichen; rückt nie zurück |
| `energiemanagement_einstellung` | eine Zeile je Unternehmen, Spalten = Schlüssel der `startwerte` (`ueberpruefung_monate` 1–60, `audit_rhythmus_monate`, `managementbewertung_rhythmus_monate`, `feststellung_frist_tage`, `vorschau_tage`), Vorgaben = die Startwerte; Vier-Augen bleibt `unternehmen.vieraugen_freigabe` (DK3) |
| `energiemanagement_person` | Name, Funktion, wahlfrei Kürzel (eindeutig; so nennen die Kopien die Person: `"entschieden_von": "RF"`), Organisation, Konto (`benutzer`-FK, ein Konto höchstens einer Person), seit/bis; „bis“ beendet mit Begründung, endgültig |
| `energiemanagement_aufgabe` | Aufgabe × Person × gilt ab/bis (Tag, der letzte eingeschlossen), wahlfrei Vertretung, Beleg als Verweis (`energiemanagement_verweis_ok`), Beschluss `BR-JJJJ-nnnn/Bn`; `entschieden_von` Pflicht außer `unternehmensleitung`; nur anhängen — außer dem einmaligen Ende ändert sich keine Spalte |
| `energiemanagement_dokument` | D-nnnn (Trigger vergibt), Art, Titel, Bezug mit GENAU seinem Verweis (`…_bezug_chk`); `standort_id` = Zaun (Bezug Standort = der Standort, Energieeinsatz = vom Schreibweg abgeleitet, Unternehmen/Person/Aufgabe = NULL); `ueberpruefung_monate` nur an Vorgaben (fehlt er: Einstellung, sonst 12), `beleg_*` = das unterschriebene Original beim Kunden; entwurf → gueltig nur mit freigegebener Fassung, → aufgehoben nur nach dem Eintrag „aufgehoben“, dann endgültig |
| `energiemanagement_dokument_fassung` | Nr. n lückenlos (Trigger); Wortlaut ≤ 20 000 ODER Verweis mit Ablage (Bezeichnung, Kennung, Adresse, Fassungsangabe, Datum, Browser-SHA-256 wahlfrei), ganz oder gar nicht (`…_form_chk`); wahlfrei Beschluss; ab dem Antrag `kopie` = `BerichtRegeln.kanonisch({nr, form, wortlaut, verweis, anwendungsbereich})` (Vertrag §6) — `…_kopie_chk` prüft Schlüssel, Nr., Form, Wortlaut und Ablage gegen die Spalten — und `pruefsumme = bericht_pruefsumme(kopie)`; Freigabe-Spalten wie `bezugsbasis_fassung` + `entschieden_von` (Person) + `entschieden_tag` + `freigabe_begruendung` |
| `energiemanagement_anwendungsbereich` | je Fassung eines Anwendungsbereichs: `standort_ids` (Trigger prüft Mandant), `traeger` (Vokabular von `bewertung_umfang`), `ausschluesse` JSONB `[{art, verweis, begruendung}]`; nur im Entwurf schreibbar |
| `energiemanagement_dokument_eintrag` | `am` + bekannt gemacht (Kreis, Weg, Person) · geprüft, bleibt (`entschieden_von`, nur Vorgabe-Arten) · aufgehoben (`entschieden_von`, einmal) · Kommentar (≤ 2 000); bekannt/geprüft nur an einer freigegebenen Fassung eines gültigen Dokuments; Felder wie `dokumente[].eintraege[]` der Referenzdatei 1.10 |
| `energiemanagement_aenderung` | Protokoll ohne FK, `objekt` `person · aufgabe · dokument · einstellung`, Wörter `energiemanagement_protokoll` |
| Zaun · Rechte | RLS + FORCE überall; RESTRICTIVE `site_scope`: Dokument über `standort_id`, Fassung/Eintrag/Anwendungsbereich/Protokoll über ihr Dokument, Aufgaben nur unternehmensweit; Personen, Einstellung und Zähler nur Mandanten-Zaun (ein Standort-Leser braucht den Namen hinter „entschieden von“). `energiemanagement.verwalten/freigeben/ansehen` (Gruppe `kennzahlen`, Zellen wie `verbesserung.verwalten`, `bezugsbasis.freigeben`, `verbesserung.ansehen`; die Spalte Einsicht folgt mit IP-12), reserviert in `RechtMatrixApiTest.OHNE_SCHREIBROUTE` |

⚠ **Freigegeben ist unveränderlich — auch „abgelöst“ wird nie gespeichert:** `…_fassung_eingefroren` weist jede
Änderung einer freigegebenen oder abgelehnten Fassung ab; der Status `abgeloest` steht im Vokabular (Vertragswort),
der CHECK verbietet ihn aber als gespeicherten Wert — die jüngste freigegebene Fassung gilt, die früheren heißen beim
Lesen „abgelöst“ (DK4). Ein Antrag (Vier-Augen) ändert nur noch die Entscheid-Spalten; bei Vier-Augen geht jede
Freigabe über `beantragt`.
⚠ **Leitungs-Pflicht in der Datenbank:** wer eine Fassung von Energiepolitik, Anwendungsbereich oder Bestellung
beantragt oder freigibt, nennt als `entschieden_von` eine Person mit laufender Aufgabe `unternehmensleitung` am
`entschieden_tag` (`energiemanagement_fassung_leitung`); ein Anwendungsbereich verlässt den Entwurf nur mit seiner
Zeile in `…_anwendungsbereich` und mit `anwendungsbereich` in der Kopie, jede andere Art mit `null`. Die Routen (IP-7) melden das vorher als 422 `leitung_fehlt`.
⚠ **Späte Ankunft:** `20260925013500` steht in `BAUEN_DARAUF_AUF` von `UemsZugriffMigrationTest` (Konto der Person)
und `UemsBerichtMigrationTest` (`bericht_pruefsumme`); IP-16 und spätere tragen sich dort und im eigenen Test ein.
Offboarding: Protokoll, Einträge, Anwendungsbereich, Fassungen, Dokumente, Aufgaben, Personen, Einstellung, Zähler
vor Energieeinsatz, Standort und Benutzer. Nachweis: `UemsEnergiemanagementMigrationTest`.
