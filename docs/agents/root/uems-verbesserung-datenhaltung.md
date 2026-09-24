# UEMS-Vorgänge: Datenhaltung, Energieziel und Maßnahme (AP-18 IP-5/IP-9)

Neu am 24.09.2026: Migration `V20260924223000__uems_verbesserung.sql`, drei leere Tabellen, keine Route, kein Leser,
keine Fläche. Routen und Ziel-Stand IP-6, Bewertung IP-7, Portal IP-8; Maßnahme (IP-9) und Abweichung (IP-14) bauen
nach demselben Muster daneben. Vertrag: [`verbesserung.md`](../../contracts/v2/verbesserung.md) (IP-2).

| Stelle | Was |
|---|---|
| `verbesserung_kennung_seq` | Zähler je Kundenbereich × Art (`EZ · M · AW`) × Jahr, Muster `bericht_kennung_seq`; `uems_verbesserung_kennung(tenant, art, jahr)` vergibt lückenlos (rückt in der Transaktion vor), `uems_verbesserung_kennung_vorruecken` schiebt ihn hinter ein ausdrücklich gesetztes Kennzeichen; rückt nie zurück (Trigger) |
| `energieziel` | EZ-JJJJ-nnnn, **JJJJ = erstes Jahr der Zielperiode** (Z1/LA6: EZ-2028-0001 am 20.12.2027 angelegt; M/AW nehmen das Jahr des Anlegens); Kennzahl + `bezugsbasis_id`/`fassung` (FK auf `bezugsbasis_fassung_nummer_uq`), Zielwert NUMERIC eine Stelle (−100 < x < 100, weniger negativ), Zielperiode `JJJJ-MM/JJJJ-MM`, Verantwortlicher `benutzer`-FK + Schnappschuss, `standort_id`, Zustand `offen · bewertet · beendet`, Bewertung `ergebnis`/`bewertung_begruendung`/`bewertung_kopie` + `bewertung_pruefsumme = bericht_pruefsumme(kopie)`, Vier-Augen `bewertung_status` `beantragt · bewertet · abgelehnt` mit `freigabe_*`/`entscheidung_*` |
| `energieziel_ein_laufendes_uq` | je Kennzahl × Zielperiode höchstens ein Ziel mit `zustand = 'offen'` (genau gleicher Text; überlappende Perioden prüft der Schreibweg) |
| Anlege-Trigger `energieziel_anlegen` | Fassung freigegeben, nicht beendet, Basis nicht beendet, Basis der Kennzahl (`…_fassung_freigegeben_chk`, `…_basis_der_kennzahl_chk`); Beginn ≥ Monat von `gilt_ab` und > Monat von `angelegt_am` in der Zeitzone des Unternehmens; Standort = Standort der Kennzahl bei Geltung Standort, NULL bei Unternehmen (andere Geltungen leitet IP-6 ab); entsteht `offen` und unbewertet |
| `energieziel_aenderung` | Protokoll nur anhängen, ohne FK auf das Ziel (§8.1 Nr. 12); Wörter `energieziel_protokoll` |
| Vokabulare | `verbesserung_vokabular()` + `verbesserung_wort()`: alle 18 Listen aus `verbesserung-vectors.json` zeilengleich, dazu nur `kennung_art`, `energieziel_bewertung_status`, `energieziel_protokoll` (IP-9: `massnahme_bewertung_status`, `massnahme_protokoll`). Weiten = `CREATE OR REPLACE` der Funktion mit der ganzen Liste, kein CHECK |
| Zaun | RLS + FORCE; RESTRICTIVE `site_scope` auf `energieziel` (über `standort_id`) und `energieziel_aenderung` (über sein Ziel); im engen Zaun ist ein Ziel am Unternehmen nie sichtbar (RE2) |
| Rechte · Ereignisse | `verbesserung.verwalten/abschliessen/ansehen` (Gruppe `kennzahlen`, Zellen wie `bezugsbasis.*`, reserviert in `RechtMatrixApiTest.OHNE_SCHREIBROUTE`); Reservierungen `auffaelligkeit_vermerkt`/`abweichung_eroeffnet` (Bezug `kennzahl`), `massnahme_umgesetzt`/`massnahme_bewertet` (Bezug `massnahme`) — Anlage offen |

⚠ **Übergänge einmalig** (`energieziel_eingefroren`): Anker, Zielwert, Anlage-Begründung, Standort nie; Zielperiode nur
das Ende nach hinten; `bewertet`/`beendet` endgültig; ein Antrag ändert sich nicht, bei Vier-Augen geht jede Bewertung
über `beantragt` und die zweite Person (KA/EM, nie der Urheber); nach `abgelehnt` darf ein neuer Antrag kommen, zurück
auf „keine Bewertung“ nie. Die Begründung einer Änderung gehört ins Protokoll, nicht in `begruendung`.
⚠ **Späte Ankunft:** die Migration baut ohne `to_regclass`-Wache auf Kennzahl, Benutzer, Bericht-Prüfsumme und
Bezugsbasis auf — ihre Version steht darum in `BAUEN_DARAUF_AUF` von `UemsKennzahlMigrationTest`,
`UemsZugriffMigrationTest`, `UemsBerichtMigrationTest` und `UemsBezugsbasisMigrationTest`. IP-9/IP-14 tragen sich dort
genauso ein. Offboarding räumt Protokoll, Ziel und Zähler vor Fassung/Kennzahl/Standort/Benutzer ab.
Nachweis: `UemsVerbesserungMigrationTest`.

## Maßnahme (AP-18 IP-9, M1/M2/M4–M7, WK6)

Neu am 24.09.2026: Migration `V20260924233000__uems_massnahme.sql`, vier leere Tabellen, keine Route, kein Leser, keine
Fläche (Routen IP-10, Wirkung IP-11, Bewertung IP-12, Portal IP-13, Anstoß-Naht IP-17). Keine neue Rechte-Kennung.

| Stelle | Was |
|---|---|
| `massnahme` | M-JJJJ-nnnn, **JJJJ = Jahr des Anlegens** in der Zeitzone des Unternehmens (LA6; Trigger prüft ein gesetztes Kennzeichen); Titel, Verantwortlicher `benutzer`-FK + Schnappschuss, `termin`, `standort_id`, Zustand `geplant · umgesetzt · bewertet · verworfen`, Herkunft `herkunft_art`/`herkunft_kennung` (AW-/EZ-/EE-Muster; `energieziel`/`einsatz` verlangen den Verweis); Messgrundlage `kennzahl_id`/`bezugsbasis_id`/`fassung` + `ausgangslage` TEXT + `ausgangslage_pruefsumme = bericht_pruefsumme(…)`; wahlfrei `einsatz_id` × `einstufung_fassung` (FK auf `energieeinsatz_einstufung_nummer_uq`, nur freigegeben), `energieziel_id`; `erwartete_wirkung_wortlaut` Pflicht, `…_prozent` eine Stelle |
| `massnahme_messgrundlage_chk` | Messgrundlage ganz oder gar nicht; mit ihr immer die Ausgangslage, ohne sie weder Ausgangslage noch Zahl (M4, E2 = A) |
| Anlege-/Änderungs-Trigger | `massnahme_anker_pruefen`: Fassung freigegeben, Basis nicht beendet und die der Kennzahl, gilt am Anlegetag; Einstufung freigegeben; Standort = der der Kennzahl (Geltung Standort) bzw. NULL (Unternehmen) — geprüft beim Anlegen und wenn sich der Anker ändert |
| `massnahme_eingefroren` | Übergänge nur geplant → umgesetzt · verworfen, umgesetzt → bewertet (`massnahme_uebergang_einmalig`); `umgesetzt_am`/`…_begruendung`/`…_gemeldet_am` einmal; **`umgesetzt_am` ≤ Tag von `umgesetzt_gemeldet_am`** (fehlt sie: DB-Uhr — ein Schreibweg mit eigener `Clock` gibt sie mit); Titel/Termin/Verantwortlicher/Messgrundlage/Verweise/erwartete Wirkung nur solange geplant; `verworfen` endgültig; `bewertet` nur mit einem Stand `status = 'bewertet'` (erst Stand anlegen, dann Zustand setzen). Die Ausgangslage bleibt änderbar — nur für eine Antwort `neu_kopiert` (alte Prüfsumme ins Protokoll) |
| `massnahme_aenderung` | Protokoll ohne FK (M7), Wörter `massnahme_protokoll`; `kommentar` TEXT nur bei `art = 'kommentar'` (1–2 000 Zeichen) |
| `massnahme_bewertung` | Stand Nr. n (`stand_nr` vergibt der Trigger lückenlos, auch ein abgelehnter Antrag behält seine Nr.), nur an umgesetzter/bewerteter Maßnahme; trägt deren Messgrundlage (Trigger) — **ohne sie nur `nicht_messbar`** (`massnahme_bewertung_nicht_messbar_chk`), mit ihr `wirkung` TEXT + `pruefsumme` Pflicht; Vier-Augen wie `energieziel` (`status` `beantragt · bewertet · abgelehnt`, höchstens ein offener Antrag, zweite Person ≠ erste, KA/EM); nie geändert außer dem einen Entscheid. „Nicht der Verantwortliche“ prüft der Schreibweg (IP-12) |
| `vorgang_anstoss` | `num_nonnulls(massnahme_id, energieziel_id) = 1`; Art/Zustand/Antwort aus `verbesserung_vokabular()`; eindeutig je Vorgang × Art × Anlass (zwei partielle Unique-Indizes — `ON CONFLICT … WHERE massnahme_id IS NOT NULL`); `ausgangslage_korrigiert`/`neu_kopiert` nur an der Maßnahme; entsteht offen, Antwort einmalig, `bleibt` mit Begründung 10–500. Beendete Vorgänge filtert die Naht (IP-17), kein Fehler der Datenbank |
| Zaun · Rechte | RLS + FORCE; RESTRICTIVE `site_scope`: Maßnahme über `standort_id`, Protokoll/Stände über ihre Maßnahme, Anstoß über Maßnahme ODER Energieziel; Grants ohne App-DELETE, Update nur benannter Spalten |

⚠ **Vokabular weiten = Vereinigung:** `V20260924233000` ersetzt `verbesserung_vokabular()` mit allen Zeilen von IP-5
plus `massnahme_bewertung_status`/`massnahme_protokoll`. Wer sie später weitet (IP-14), schreibt die ganze Liste
fort; `UemsVerbesserungMigrationTest` nennt die Tabellen-Listen, `UemsMassnahmeMigrationTest` prüft „nur geweitet“.
⚠ **Späte Ankunft:** `20260924233000` steht in `BAUEN_DARAUF_AUF` von `UemsKennzahlMigrationTest`,
`UemsZugriffMigrationTest`, `UemsBerichtMigrationTest`, `UemsBezugsbasisMigrationTest` und (neu)
`UemsVerbesserungMigrationTest`. Offboarding: Anstoß, Stände, Protokoll, Maßnahme vor Energieziel & Co.
⚠ **PL/pgSQL:** `IF x IS DISTINCT FROM CASE … THEN … END THEN` bricht (`IF` liest bis zum ersten `THEN`) — `CASE` klammern.
Nachweis: `UemsMassnahmeMigrationTest`.
