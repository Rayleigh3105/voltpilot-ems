# UEMS-Energiemanagement: Personen und Aufgaben (AP-19 IP-6)

Neu am 25.09.2026: die Routen über den Tabellen `energiemanagement_person` und `energiemanagement_aufgabe` aus IP-5
([Datenhaltung](uems-energiemanagement-datenhaltung.md)). Konzept: AP-19 §4.5 PA1–PA5, §5.2, §5.6, R5
(`vp-uems-ap19-fundament/report.md`). Seit IP-10 daneben der Leser „Wer ist wofür verantwortlich“ (PA4) und die
Verzeichnis-Quelle „Aufgaben“. Flächen: Reiter „Aufgaben“, „Wer ist wofür verantwortlich“ und Personen-Seite
([Portal IP-13](uems-energiemanagement-portal.md)).

| Stelle | Was |
|---|---|
| `EnergiemanagementPersonenController` | `GET/POST /api/v1/energiemanagement/personen`, `GET/PUT …/personen/{id}`, `GET/POST …/aufgaben` (`?tag=`), `POST …/aufgaben/{id}/beenden`; Schreiben `@Recht(energiemanagement.verwalten, UNTERNEHMEN)` (KA U · EM U · Bearbeiter nur Standort und Einsicht → 403; Einsicht liest Aufgaben unternehmensweit), keine Löschroute (PA5) |
| `EnergiemanagementPersonenService` | Prüfungen und Ablehnungs-Codes (`openapi.yaml`); `leitungAm(tag)` = die Personen mit laufender `unternehmensleitung` — für die Leitungs-Pflicht der Dokument-Freigabe (IP-7) und die Managementbewertung (IP-23) |
| `EnergiemanagementPersonenRepository` | SQL unter RLS; jeder Übergang schreibt `energiemanagement_aenderung` (`person_erfasst · person_geaendert · person_beendet · aufgabe_zugeordnet · aufgabe_beendet`, alt/neu ohne `tenant_id`, Begründung) |
| Satz und Wort | `EnergiemanagementRegeln.satz("aufgabe_ohne_person", …)` und `WOERTER.aufgabe` aus dem Vertrag IP-2 — nie im Dienst nachgebaut |
| `GET …/verantwortung` (IP-10) | `EnergiemanagementVerantwortungService`: die Aufgaben am `tag` aus `aufgaben(tag)` plus `ohne_person`, die Objekte aller `VerantwortungQuelle`-Beans in ihrer `@Order` und `VerantwortungBestand#bezugsbasenFreigaben` (jede freigegebene Fassung, auch abgelöste, mit Freigabe-Person und bei Vier-Augen der zweiten) — kein SQL, kein Repository, nur die Register-Leser von AP-11 bis AP-18 |
| Andockstelle `VerantwortungQuelle` | `VerantwortungBestand` (Order 0): laufende Kennzahlen, Energieeinsätze, Bezugsbasen; Energieziele, Maßnahmen, Abweichungen in jedem Zustand. Internes Audit (IP-18) und Feststellung (IP-19) kommen als eigene `@Component` dazu und ergänzen `objekt.art` in `openapi.yaml` (und `ARTEN` im Wächter) |
| Verzeichnis-Quelle `AufgabenVerzeichnis` | `VerzeichnisQuelle#zeilen(stichtag)`: je laufende Zuordnung eine Zeile der Gruppe `verantwortung` über `EnergiemanagementRegeln.verzeichnisZeile` (Kennzeichen = Wort, Titel „Wort: Person“, Tag = gilt ab, Ort `verweis` mit der Ablage des Belegs, sonst `in_voltpilot`); der Leser `…/verzeichnis` (IP-8) sammelt alle `VerzeichnisQuelle`-Beans |
| Nachweis | `EnergiemanagementVerantwortungApiTest` (R5: zehn Zuordnungen, `ohne_person` = Bezugsbasen, Basis-Verantwortliche IK/IK/IK/JW/PH, acht Freigaben IK, Standort-Konto ohne Aufgaben; Verzeichnis-Quelle zehn Zeilen am 12.02.2029), `EnergiemanagementVerantwortungSchnittstelleVertragTest` (openapi ↔ DTO, `art` = `ARTEN`, keine eigene Abfrage); `EnergiemanagementPersonenApiTest` (R5, Leitung am Tag X, Konto-Verknüpfung im Verlauf, 403, 422), `EnergiemanagementPersonenSchnittstelleVertragTest` (openapi ↔ DTO ↔ Vokabular), Zeilen in `RechtMatrixApiTest` |

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
⚠ **Die Objekte stehen, wie ihre Register sie HEUTE zeigen** — nur die Aufgaben folgen `?tag=`. Der Verantwortliche
einer Kennzahl und einer Bezugsbasis ist ein Name ohne `sub` (die DTOs führen keinen); an der Bezugsbasis ist er die
Vorgabe aus der Kennzahl (AP-17 B4), die Freigabe steht getrennt daneben. Jede Quelle liest mit dem Zaun und den
Rechten ihres eigenen Registers: ein Standort-Konto sieht keine Aufgaben und keine Kennzahl eines fremden Standorts.
