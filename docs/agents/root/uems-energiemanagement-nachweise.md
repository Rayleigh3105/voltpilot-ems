# UEMS-Energiemanagement: Nachweise am Einsatz und an der Person (AP-19 IP-14)

Neu am 25.09.2026: Dokument-Bezüge Energieeinsatz, Person und Aufgabe über die Routen von IP-7
([Dokumente](uems-energiemanagement-dokumente.md)), drei Leser, keine Migration (Spalten, CHECK und Zaun-Spalte stehen seit
IP-5). Fläche seit IP-15: Abschnitt „Nachweise“ an Einsatz- und Personen-Seite ([Portal](uems-energiemanagement-portal.md)). Konzept: AP-19 §3.5, §3.7, §4.4 DK1/DK6, §4.10 KS1, §5.3, R7, R8
(`vp-uems-ap19-fundament/report.md`).

| Stelle | Was |
|---|---|
| `EnergiemanagementDokumentService#anlegen` | Bezug `energieeinsatz` (`energieeinsatz_id`, sichtbar über `EnergieeinsatzService#sichtbareZeile`, sonst 422 `energieeinsatz_unbekannt`), `person` (`person_id`, 422 `person_unbekannt`), `aufgabe` (`aufgabe_id` = eine Zuordnung, 422 `aufgabe_unbekannt`); eine Kennung einer anderen Art 422 `angabe_ungueltig`; Recht `energiemanagement.verwalten` am abgeleiteten Standort bzw. am Unternehmen |
| Zaun des Einsatzes | `standortDesEinsatzes`: der EINE Standort, an dem am Tag des Anlegens die Messstellen seines Prozesses hängen (`EnergieeinsatzRepository#messstellen` + `KennzahlRepository#standortVonMessstelle`); mehrere oder keiner → `standort_id NULL` (nur unternehmensweit). Der Trigger friert ihn mit dem Bezug ein |
| `BezugAus` | `standort` (Zaun) plus genau eines von `energieeinsatz` (Kennzeichen, Name), `person` (`PersonKurz`), `aufgabe` (Zuordnung mit Wort und Person) |
| `EnergiemanagementNachweise` | Leser über `EnergiemanagementDokumentService` (keine eigene Abfrage — Wächter `EnergiemanagementNachweiseSchnittstelleVertragTest`): `amEinsatz` (404 außerhalb des Zauns), `derPerson` (Bezug Person und Aufgaben der Person), `bekanntmachungen`; `ort()` = Ort der gültigen Fassung mit `ort_satz` aus `verzeichnis_zeile` und Satz `ort_verweis`/`ort_wortlaut`, `adresse_als_verweis` nur bei `https:` (KS1) |
| Bekanntmachung | `kommunikation()`: Einträge `bekannt_gemacht` mit gleicher Fassung, Tag, Kreis und Person sind EINE Mitteilung (`wege[]`, „Aushang und Intranet“, Satz `bekanntmachung`); `DokumentVerzeichnis` nutzt dieselbe Bündelung (Katalog R3: „Kompetenz und Kommunikation“ = 3 Zeilen am 12.02.2029) |
| `EnergiemanagementNachweiseController` | `GET /api/v1/energiemanagement/energieeinsaetze/{id}/nachweise`, `GET …/personen/{id}/nachweise`, `GET …/bekanntmachungen` — nur lesend, Recht `energiemanagement.ansehen` im Kommentar |
| Nachweis | `EnergiemanagementNachweiseApiTest` (R7, R8, Zaun, Aufgabe, Ablehnungen), `EnergiemanagementNachweiseSchnittstelleVertragTest` (openapi ⟷ DTO, Sätze gegen die Vektoren), `EnergiemanagementDokumentApiTest` (R1: eine Bekanntmachungs-Zeile) |

⚠ **Person und Aufgabe haben keinen Standort:** ihre Dokumente sieht nur, wer unternehmensweit liest; ein Standort-Konto
bekommt die Person mit leerer Liste (keine 404 — die Person ist mandantenweit sichtbar).
⚠ **Messstellen sind nur mandanten-, nicht standortgetrennt (RLS):** die Ableitung sieht alle Messstellen des Einsatzes,
unabhängig vom Aufrufer — derselbe Einsatz ergibt für jede Person denselben Zaun.
⚠ **VoltPilot bemerkt keine Änderung im Kundensystem:** eine neue Revision beim Kunden ist eine neue Fassung, die eine
Person festhält (R7 Schritt 3).

```bash
(cd services/api && ./mvnw test -Dtest='EnergiemanagementNachweise*Test,EnergiemanagementDokument*Test,RechtRoutenArchitekturTest,RechteKennungenDerRoutenTest')
```
