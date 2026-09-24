# UEMS-Vorgänge: Datenhaltung, Energieziel, Maßnahme und Abweichung (AP-18 IP-5/IP-9/IP-14)

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

## Abweichung und Auffälligkeit (AP-18 IP-14, A1–A4, A6, U1/U2)

Neu am 24.09.2026: Migration `V20260924235130__uems_abweichung.sql`, drei leere Tabellen, keine Route, kein Leser,
keine Fläche (Naht IP-15, Routen IP-16, Portal IP-18). Keine neue Rechte-Kennung.

| Stelle | Was |
|---|---|
| `auffaelligkeit` | Vermerk der Naht, kein Vorgang: **`auffaelligkeit_eindeutig_uq`** je Kennzahl × `bezugsbasis_id`/`fassung` × `periode` (`JJJJ-MM`) — die Naht schreibt idempotent mit `ON CONFLICT ON CONSTRAINT auffaelligkeit_eindeutig_uq DO NOTHING`; `anlass` TEXT + `anlass_pruefsumme = bericht_pruefsumme(…)`, `vermerkt_am`, `standort_id` (Zaun wie die Abweichung, von der Naht aus der Geltung der Kennzahl abzuleiten); Antwort `abweichung` (mit `abweichung_id` derselben Kennzahl × Fassung, deren `monate` den Monat enthalten — `auffaelligkeit_abweichung_passt_chk`) · `zur_kenntnis` (Begründung 10–500), **einmalig per Trigger** (`auffaelligkeit_antwort_einmalig`) |
| `abweichung` | AW-JJJJ-nnnn, **JJJJ = Jahr des Eröffnens** (`eroeffnet_am`, Zeitzone des Unternehmens); Kennzahl × Fassung × `monate TEXT[]` (aufsteigend, ohne Doppel, ≥ 1); `herkunft_art` `auffaelligkeit · von_hand` (von Hand mit `herkunft_wortlaut` 10–500); Anlass-Kopie + Prüfsumme; Verantwortlicher `benutzer`-FK + Schnappschuss; `frist` (fehlt sie: Eröffnungstag + 30, Vertrag §1); `standort_id`; Zustand `offen · abgeschlossen`; Abschluss `ergebnis`/`abschluss_begruendung` (10–500)/`abgeschlossen_*` (`abgeschlossen_am` fehlt → DB-Uhr); **`abweichung_massnahme_verweis_chk`**: `massnahme` genau mit `massnahme_id` (FK auf `massnahme`) |
| Anker (Trigger `uems_abweichung_anker_pruefen`) | Fassung freigegeben (auch eine beendete), Basis der Kennzahl, jeder Monat in `gilt_ab … gilt_bis` der Fassung (monatsgenau), Standort = der der Kennzahl (Geltung Standort) bzw. NULL (Unternehmen) — beim Anlegen; übrige Geltungen leitet der Schreibweg ab |
| `abweichung_eingefroren` | Anker, Monate, Anlass, Herkunft, Standort, Eröffnung nie; offen ändern sich nur Frist und Verantwortlicher; offen → abgeschlossen genau einmal, danach endgültig (`abweichung_abschluss_einmalig`) |
| `abweichung_aenderung` | Protokoll ohne FK, Wörter `abweichung_protokoll` (`abweichung_eroeffnet · kommentar · ursache_aussage · abweichung_geaendert · verantwortlicher_geaendert · abweichung_abgeschlossen`); `kommentar` 1–2 000; Ursache-Aussage = `aussage_wortlaut` (10–500) + `aussage_name` (wahlfrei `aussage_sub`) + `aussage_am` + wahlfrei `beleg_kennung` — eingetragen von `actor_*`, das nicht die aussagende Person sein muss (R2); Frist/Verantwortlicher-Änderung mit `begruendung` 10–500 |
| Zaun · Rechte | RLS + FORCE; RESTRICTIVE `site_scope` über `standort_id` (Vermerk, Abweichung) bzw. die Abweichung (Protokoll); Grants ohne App-DELETE, Update nur Frist/Verantwortlicher/Abschluss bzw. Antwort-Spalten |

⚠ **Vokabular = Vereinigung:** `V20260924235130` schreibt `verbesserung_vokabular()` mit allen Zeilen von IP-5 und IP-9
fort, dazu nur `abweichung_herkunft`/`abweichung_protokoll`; `UemsMassnahmeMigrationTest` und
`UemsVerbesserungMigrationTest` nennen sie mit.
⚠ **Späte Ankunft:** `20260924235130` steht in `BAUEN_DARAUF_AUF` von `UemsKennzahlMigrationTest`,
`UemsZugriffMigrationTest`, `UemsBerichtMigrationTest`, `UemsBezugsbasisMigrationTest`, `UemsVerbesserungMigrationTest`
und (neu) `UemsMassnahmeMigrationTest`. Offboarding: Vermerk, Protokoll, Abweichung vor der Maßnahme.
⚠ **Kein Zeitbezug in der Datenbank:** weder „Monat vor dem Vermerk“ noch „Frist nach dem Eröffnen“ prüft ein CHECK
(`now()` im Test läge vor den Ahrenberg-Daten) — das prüfen Naht und Routen mit ihrer `Clock`.
Nachweis: `UemsAbweichungMigrationTest`.

## Auffälligkeits-Naht (AP-18 IP-15, A1, E4 = A)

`VerbesserungNaht#vermerken(con, tenant, werte, jetzt)` — je endgültigem Monatswert einer Kennzahl mit freigegebener
Fassung `BezugsbasisVergleich#fuerNaht` (dieselbe Zeile wie der Leser, gegen die Fassung am letzten Tag), bei
`schlechter` ein Vermerk (`ON CONFLICT … DO NOTHING`); Anlass = kanonische Kopie (`BezugsbasisGrundlage.kanonisch`) von
Kennzahl, Bezugsbasis, Fassung, Monat, Beschriftung, `bereinigt` und Satz — ohne `roh` (VG3); `vermerkt_am` = Uhr des
Laufs; Standort = Geltung der Kennzahl (`KennzahlService#fuerNaht`, wie das Energieziel). Schalter
`voltpilot.uems.verbesserung.enabled` nur hier (`UemsVerbesserungFlagArchitekturTest`), Fehler zählen unter
`laeufer="verbesserung_naht"`.
⚠ **Takt = je Wert eine Transaktion:** `KennzahlLauf#lauf` schreibt jede Periode in eigener Transaktion — die Naht hängt
darum IN `inTransaktion` des Regellaufs (nach `zeile`), nicht hinter `lauf`; `Lauf.endgueltig` nennt die Monatswerte nur
noch. Die Kaskade ruft sie nach `KennzahlNeuGebildet.melden` mit `Neubildung.endgueltig` (Version n + 1 UND erstmals
endgültig). Ein Fehler der Naht rollt den Wert mit zurück; der Regellauf übergeht dann die Kennzahl (`nicht_gerechnet`).
⚠ **Lesen in der Transaktion:** der Vergleich liest über `SingleConnectionDataSource(con)` (Verwaltungsrolle, ohne
Sichtprüfung) — sonst sähe die Kaskade Version n statt n + 1. Beide Wege schreiben als `voltpilot_admin`:
`V20260925002000` gibt ihr `INSERT` auf `auffaelligkeit`. Nachweis: `VerbesserungNahtTest` (Takt R1, Schalter, R11,
`besser`/`im_rahmen`/`nicht_anwendbar`, R13, Kaskade mit Rücklauf, Rechte).
