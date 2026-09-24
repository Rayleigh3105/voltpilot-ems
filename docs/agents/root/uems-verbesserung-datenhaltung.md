# UEMS-Vorgänge: Datenhaltung und Energieziel (AP-18 IP-5, Z1/Z2/RE1/RE2)

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
| Vokabulare | `verbesserung_vokabular()` + `verbesserung_wort()`: alle 18 Listen aus `verbesserung-vectors.json` zeilengleich, dazu nur `kennung_art`, `energieziel_bewertung_status`, `energieziel_protokoll`. Weiten = `CREATE OR REPLACE` der Funktion, kein CHECK |
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
