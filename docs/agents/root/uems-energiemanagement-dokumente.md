# UEMS-Energiemanagement: Dokumente (AP-19 IP-7)

Neu am 25.09.2026: die Routen über den Dokument-Tabellen aus IP-5 ([Datenhaltung](uems-energiemanagement-datenhaltung.md)).
Konzept: AP-19 §4.4 DK1–DK8, §5.1, §5.6, R1, R2, W5 (`vp-uems-ap19-fundament/report.md`). Noch keine Fläche (Portal
IP-9), kein Verzeichnis-Leser (IP-8; die Quelle `DokumentVerzeichnis` steht); Bezug Energieeinsatz, Person und Aufgabe folgen mit IP-14 (heute 422
`bezug_nicht_verfuegbar`).

| Stelle | Was |
|---|---|
| `EnergiemanagementDokumentController` | `GET/POST /api/v1/energiemanagement/dokumente`, `GET …/{id}`, `GET …/{id}/vergleich`, `POST …/{id}/fassungen`, `…/fassungen/{nr}/beantragen · freigeben · ablehnen`, `POST …/{id}/geprueft`, `…/bekanntmachungen`, `…/aufheben`; keine Lösch-, keine PUT-Route |
| `EnergiemanagementDokumentService` | Prüfungen und Codes (`openapi.yaml`); Recht `RechtZiel.DIENST` → `schreibbar`: `energiemanagement.verwalten` (anlegen, entwerfen, bekannt machen) bzw. `.freigeben` (beantragen, freigeben, ablehnen, geprüft, aufheben) am Standort des Bezugs, ohne Standort am Unternehmen; Leitungs-Pflicht über `EnergiemanagementPersonenService.leitungAm(entschieden_am)` → 422 `leitung_fehlt` vor dem Trigger; Vier-Augen wie `BezugsbasisService` (`vieraugen_aus`, `vieraugen_beantragen`, `vieraugen_urheber`, `vieraugen_rolle`); `uhrStellen(Clock)` für Tests |
| `EnergiemanagementDokumentRepository` | SQL unter RLS/`site_scope`; jeder Übergang eine Zeile `energiemanagement_aenderung` mit `objekt = 'dokument'` (auch Fassung und Eintrag) |
| Kopie und Prüfsumme | `kopie()` baut `{nr, form, wortlaut, verweis, anwendungsbereich}` (Verweis mit allen sieben Teilen, Standorte als Kurzzeichen) und ruft `BerichtRegeln.kanonisch`; D-0001/1, D-0002/1, D-0004/1 treffen die Prüfsummen der Vektoren |
| Überprüfung und Sätze | `EnergiemanagementRegeln.ueberpruefung` beim Abruf mit `abruf = heute` (Zeitzone des Unternehmens); Basis ist `entschieden_tag` der gültigen Fassung bzw. ihr jüngstes „geprüft, bleibt“; Sätze nur über `EnergiemanagementRegeln.satz` |
| Vergleich (DK7, W5) | gültige Fassung des Anwendungsbereichs gegen den am Abruf-Tag laufenden `bewertung_umfang` (`BewertungUmfangRepository.fassungen`, Muster `BewertungUmfangService.lesen`); Satz nur für „gehört zum Anwendungsbereich, aber nicht …“ (Vertrag §9) |
| `DokumentVerzeichnis` | Verzeichnis-Quelle (`VerzeichnisQuelle`, `@Order(10)`, Leser IP-8): je freigegebene Fassung (auch abgelöste) bis zum Stichtag eine Zeile in der Gruppe ihrer Art (`GRUPPE`; `verfahren` → `grundlagen` ist Lesart, das Konzept nennt es nicht), Verweis mit Browser-Prüfsumme und „Geführt in Ihrem System: …“, Wortlaut mit Original „Wortlaut in VoltPilot, Original bei Ihnen: …“; je Bekanntmachung eine Zeile in `kompetenz_kommunikation` (Katalog R3); gelesen über den Dienst im Zaun |
| Nachweis | `EnergiemanagementDokumentApiTest` (R1, R2, Prüffall nur Strom, Leitung 422, Vier-Augen, Zaun 404, Recht 403, Verweis, Aufheben), `EnergiemanagementDokumentSchnittstelleVertragTest`, Zeilen in `RechtMatrixApiTest` und `RechtRoutenArchitekturTest.DIENST` |

⚠ **Freigegeben am = Tag der Entscheidung:** `freigegeben_am` ist der Zeitpunkt des Eintrags (Datenbank-`now()`), die
Überprüfung und der Kopf-Satz rechnen mit `entschieden_tag` („entschieden am“, Vorgabe heute, nie in der Zukunft). Wer
die Fälle mit gestellter Uhr prüft, stellt `EnergiemanagementDokumentService.uhrStellen`.
⚠ **Ein offener Entwurf wird überschrieben:** `POST …/fassungen` schreibt bei offenem Entwurf dieselbe Nr. (200),
sonst Nr. n + 1 (201); ein offener Antrag 409 `fassung_beantragt`. Die zweite Person bei Vier-Augen schickt höchstens
eine Begründung (nur im Protokoll) — „entschieden von“ und der Tag stehen im Antrag.
⚠ **Ein Weg je Bekanntmachung:** die Referenzdatei 1.10 schreibt `"weg": "aushang · intranet"`; die Tabelle hält ein
Wort — zwei Wege sind zwei Einträge.
⚠ **Einsicht und Standort-Konten:** Dokumente am Unternehmen sieht nur, wer unternehmensweit liest; ein Standort-Konto
bekommt 404 und nie den Satz `freigabe_gesperrt` (die Aufgaben sieht es nicht).

```bash
(cd services/api && ./mvnw test -Dtest='EnergiemanagementDokument*Test,RechtMatrixApiTest,RechtRoutenArchitekturTest,RechteKennungenDerRoutenTest')
```
