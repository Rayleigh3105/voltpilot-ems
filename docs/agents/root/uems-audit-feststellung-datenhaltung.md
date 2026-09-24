# UEMS-Energiemanagement: Datenhaltung von internem Audit und Feststellung (AP-19 IP-16)

Neu am 25.09.2026: Migration `V20260925031500__uems_audit_feststellung.sql`, fünf leere Tabellen neben denen von
IP-5 ([Datenhaltung Grundlage und Dokument](uems-energiemanagement-datenhaltung.md)), keine Route, kein Leser, keine
Fläche. Routen: Audit IP-18, Feststellung und Wirksamkeit IP-19; die Herkunft der Maßnahme (F-…/AU-…) weitet IP-17.
Konzept: AP-19 §4.2, §4.6, §4.7, §4.14, §5.6 (`vp-uems-ap19-fundament/report.md`).

| Stelle | Was |
|---|---|
| `internes_audit` | AU-JJJJ-nnnn (Zähler von IP-5, **Jahr des Anlegens** in der Zeitzone des Unternehmens), Titel, Termin, `auditor_ids` (Personen, auch ohne Konto), Unabhängigkeit/was/woran (Pflicht), Verantwortlich als Konto (`benutzer` + Schnappschuss), `standort_ids` (wahlfrei); geplant → durchgefuehrt (`durchgefuehrt_am`) · abgesagt (Begründung 10–500) → abgeschlossen (`entschieden_von`, `abgeschlossen_am`, Bericht-Verweis `bericht_*` ODER `zusammenfassung`, `kopie` + `pruefsumme = bericht_pruefsumme(kopie)`, `abschluss_*` = eintragendes Konto) |
| `internes_audit_eintrag` | `hinweis` (Nr. n lückenlos, `am`, `festgestellt_von` Person, nur am durchgeführten Audit) · `kommentar` (jederzeit); nur anhängen |
| `feststellung` | F-JJJJ-nnnn; Quelle `internes_audit` (`audit_id`, nur solange das Audit durchgeführt ist) · `eigene` · `extern` (`quelle_wortlaut`) · `managementbewertung` (`quelle_kennung` BR-…/Bn); Vorgabe = Fassung (`vorgabe_dokument_id` + `vorgabe_fassung`) und/oder `vorgabe_wortlaut`; Bezug = `standort_id` (Zaun, NULL = Unternehmen), `bezug_aufgabe` (Wort aus `aufgabe`), `bezug_dokument_id`, `bezug_objekte` (Kennzeichen); `frist` fehlt → festgestellt am + `feststellung_frist_tage` (90); offen ändern sich nur Frist und Verantwortlich |
| `feststellung_eintrag` | Kommentar · Behebung · Ursache (Aussage) · ähnliche Fälle, IMMER mit `am`, `person_id` und Wortlaut ≤ 2 000; nach dem Abschluss nur Kommentar; nur anhängen |
| `feststellung_wirksamkeit` | Stand Nr. n: `ergebnis`, `begruendung` (10–500, Pflicht), `entschieden_von` + `entschieden_tag`, `kopie` (ihr `feststellung` = Kennzeichen, ihr `am` = Tag) + `pruefsumme`; Vier-Augen wie `massnahme_bewertung`, `status` beantragt · freigegeben · abgelehnt (Wörter von `fassung_status`) |
| Protokoll | `energiemanagement_aenderung.objekt` + `internes_audit`, `feststellung`; 13 Wörter in `energiemanagement_protokoll` (§5.6 + `wirksamkeit_beantragt/_abgelehnt`) |
| Zaun · Rechte | RLS + FORCE; `site_scope`: Audit nur mit Standorten, die ALLE zur Anfrage gehören (ohne Standort nur unternehmensweit), Feststellung über `standort_id`, Einträge/Stände/Protokoll folgen ihrem Objekt; App ohne DELETE, Einträge ohne UPDATE, Stand nur die Entscheid-Spalten |

⚠ **Der Stand schließt selbst:** ein freigegebener Stand `wirksam`, `ohne_massnahme` oder `zurueckgenommen` setzt
`feststellung.zustand = 'abgeschlossen'` im AFTER-Trigger (`feststellung_wirksamkeit_schliesst`) — die Route (IP-19)
schreibt den Zustand NICHT selbst; `nicht_wirksam` hält offen. Von Hand geht `abgeschlossen` nur mit so einem Stand.
⚠ **Ein zweiter Abschluss scheitert:** abgeschlossenes/abgesagtes Audit und abgeschlossene Feststellung sind endgültig
(`internes_audit_endgueltig`, `feststellung_endgueltig`), dazu `feststellung_wirksamkeit_ein_abschluss_uq`.
⚠ **Vier-Augen in der Datenbank:** die zweite Person ≠ Urheberin (CHECK) und ≠ `feststellung.verantwortlich_sub`
(Trigger `…_vieraugen_verantwortlich`); ein neuer Stand wartet, solange ein Antrag offen ist. „Vier-Augen nicht
erfüllbar“ (FS6) sagt die Route — die Datenbank sperrt nur.
⚠ **Kopie des Audit-Abschlusses:** `kennzeichen`, `hinweise`, `feststellungen`, `bericht` (genau diese Schlüssel);
der Trigger vergleicht die Feststellungen und die Hinweis-Nummern mit den Tabellen, `bericht` = null ohne Ablage.
⚠ **Späte Ankunft:** `20260925031500` steht in `BAUEN_DARAUF_AUF` von `UemsEnergiemanagementMigrationTest`,
`UemsZugriffMigrationTest` (Verantwortlich → `benutzer`) und `UemsBerichtMigrationTest` (`bericht_pruefsumme`).
Offboarding: Stände, Einträge, Feststellungen, Hinweise, Audits vor den Tabellen von IP-5. Nachweis:
`UemsAuditFeststellungMigrationTest` (R9 AU-2029-0001 `27a580b9…`, R11 F-2029-0001/1 `dbda6aff…`).
