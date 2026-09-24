# UEMS-Energiemanagement: Personen und Aufgaben (AP-19 IP-6)

Neu am 25.09.2026: die Routen über den Tabellen `energiemanagement_person` und `energiemanagement_aufgabe` aus IP-5
([Datenhaltung](uems-energiemanagement-datenhaltung.md)). Konzept: AP-19 §4.5 PA1–PA5, §5.2, §5.6, R5
(`vp-uems-ap19-fundament/report.md`). Noch keine Fläche (Portal IP-9), kein „Wer ist wofür verantwortlich“ (IP-10).

| Stelle | Was |
|---|---|
| `EnergiemanagementPersonenController` | `GET/POST /api/v1/energiemanagement/personen`, `GET/PUT …/personen/{id}`, `GET/POST …/aufgaben` (`?tag=`), `POST …/aufgaben/{id}/beenden`; Schreiben `@Recht(energiemanagement.verwalten, UNTERNEHMEN)` (KA U · EM U · Bearbeiter nur Standort und Einsicht → 403; Einsicht liest Aufgaben unternehmensweit), keine Löschroute (PA5) |
| `EnergiemanagementPersonenService` | Prüfungen und Ablehnungs-Codes (`openapi.yaml`); `leitungAm(tag)` = die Personen mit laufender `unternehmensleitung` — für die Leitungs-Pflicht der Dokument-Freigabe (IP-7) und die Managementbewertung (IP-23) |
| `EnergiemanagementPersonenRepository` | SQL unter RLS; jeder Übergang schreibt `energiemanagement_aenderung` (`person_erfasst · person_geaendert · person_beendet · aufgabe_zugeordnet · aufgabe_beendet`, alt/neu ohne `tenant_id`, Begründung) |
| Satz und Wort | `EnergiemanagementRegeln.satz("aufgabe_ohne_person", …)` und `WOERTER.aufgabe` aus dem Vertrag IP-2 — nie im Dienst nachgebaut |
| Nachweis | `EnergiemanagementPersonenApiTest` (R5, Leitung am Tag X, Konto-Verknüpfung im Verlauf, 403, 422), `EnergiemanagementPersonenSchnittstelleVertragTest` (openapi ↔ DTO ↔ Vokabular), Zeilen in `RechtMatrixApiTest` |

⚠ **`PUT …/personen/{id}` ist der ganze Stand:** ein fehlendes wahlfreies Feld heißt „keins“ — wer nur `bis` schicken
will, schickt Name, Funktion, Kürzel, Organisation, Konto und seit mit. Ein anderes Konto (auch lösen) und `bis`
verlangen eine Begründung (10–500); eine beendete Person ist endgültig (409 `person_beendet`), und `bis` geht nur, wenn
sie danach keine Zuordnung mehr trägt — auch nicht als Vertretung (409 `aufgaben_laufen`).
⚠ **Aufgaben sieht nur, wer unternehmensweit liest** (`site_scope` aus IP-5): ein Standort-Konto bekommt leere Listen
und nie den Satz „… — keine Person festgelegt.“ — der wäre für es falsch. Personen dagegen tragen nur den
Mandanten-Zaun.
⚠ **Die Leitung ist eine Liste:** mehrere laufende `unternehmensleitung` (zwei Geschäftsführer) sind erlaubt; gesperrt
ist nur dieselbe Aufgabe für dieselbe Person im selben Zeitraum (409 `zuordnung_laeuft_bereits`). Eine Übergabe ist
`beenden` (letzter Tag eingeschlossen) plus eine neue Zuordnung ab dem Folgetag.
⚠ **Tests:** `findValuesAsText("name")` sammelt auch `akteur.name`, `konto.name`, `entschieden_von.name` — Listen je
Element lesen.
