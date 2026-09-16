# UEMS-Entzug: Sofortwirkung, Fehlerbild `zugriff_beendet` und die zwei 409 (AP-03 IP-9)

Neu angelegt am 16.09.2026. Spezifikation: AP-03 §4.7 (Entzug), §5.4, §5.9, E15, W12/W13, A6/A7/A8/A13,
§8 IP-9. Code: `zugriff/` (`ZugriffAenderung`, `ZugriffBeendet`, `ZugriffBeendetAntwort`, `ZugriffAbgelehnt`,
`ZugriffAbgelehntAntwort`, `ZugriffEtikett`, dazu `ZugriffFilter`, `ZugriffKontextLader`, `RechtPruefung`,
`ZugriffRepository`), `web/ZugriffController`, `web/SiteInterventionController`, `uems/AenderungSatz`,
`uems/AenderungsprotokollRepository`, Migration `V20260916150000`. Beweis: `ZugriffEntzugApiTest` (A6, A7, A8,
A13, Bestand), `ZugriffAenderungArchitekturTest`.

## Was gilt

- **Sofort heißt: mit der NÄCHSTEN Anfrage, nicht mit der nächsten Anmeldung.** Es gibt keinen
  Zwischenspeicher für Zuweisungen: `ZugriffKontextLader` liest sie je Anfrage (`ZugriffRepository.stand`,
  EINE Abfrage für wirksame UND vorbeie), das Token wird nie gefragt. `ZugriffEntzugApiTest` beweist es in
  beide Richtungen — die Anfrage unmittelbar nach dem Entzug ist abgelehnt, die unmittelbar nach einer neuen
  Zuweisung wieder erlaubt.
- **`zugriff_beendet` ist die Ablehnung für den, der den Zugang HATTE.** Wer ihn nie hatte, bekommt weiter die
  stumme 404 (W2: die Existenz wird nicht bestätigt). Zwei Stellen antworten:
  - `ZugriffFilter` — ein Kundenkonto ohne JEDE wirksame Zuweisung, das einmal eine hatte
    (`ZugriffContext.Zugriff.jederZugriffBeendet`), bekommt 404 auf JEDER Kundenroute außer `/api/v1/me`
    (A6). Ein Partner, dessen Unterstützung endete, ebenso, mit seinem Satz.
  - `RechtPruefung` — verliert jemand EINEN Standort und behält andere, nennt `RechteAbleitung.darf` den
    Grund `zugriff_beendet`; der Aufrufer trägt dafür seine BEENDETEN Zuweisungen im Kontext.
- **Der Satz kommt aus `RechteAbleitung.TEXTE`**, nie aus dem Code: „Ihr Zugriff auf {standort} wurde
  beendet." / „Ihre Unterstützung für {kundenbereich} ist beendet." Portal (`rechte.ts`) und API zeigen
  denselben Wortlaut.
- **Ein Entzug schaltet nie (E15).** Ein gesetzter Handeingriff bleibt ZEICHENGLEICH in `device_override`,
  wird weiter erneuert und läuft bis zu seinem Ende (≤ 24 h, W13). Nur sein ETIKETT ändert sich; es steht als
  `etikett` in `GET /api/v1/sites/{id}/interventions` und kommt aus `RechteAbleitung.handeingriff`
  (`ZugriffEtikett`).
- **Zwei 409 lehnen jede Änderung an einer Zuweisung ab** — und zwar im Vertrag
  (`RechteAbleitung.zuweisungAendern`), nicht im Dienst: die eigene Zuweisung ist unveränderlich
  (`eigene_zuweisung`, W12), der letzte Kundenadministrator ist geschützt (`letzter_kundenadministrator`).
- **Ein Vorgang, zwei Protokolle:** `zugriff_protokoll` (Kundenbereich, IP-2) UND eine Zeile im
  Änderungsprotokoll des STANDORTS (`ort_aenderung`, neue Arten `zugriff_zugewiesen`/`zugriff_entzogen`,
  V20260916150000) — damit AP-12 den Berichtszeitraum erklären kann. Unternehmensweite Zuweisungen schreiben
  die Zeile am Unternehmen.
- **Der Weg ist `POST` / `DELETE /api/v1/zugriff`** mit Recht `zuweisung.verwalten` (Matrix-Zelle U). Konten
  ANLEGEN gehört nicht dazu (`benutzer.verwalten`, IP-13/IP-14): diese Routen arbeiten mit Konten, die im
  Kundenbereich schon gespiegelt sind.

## Fallen

- ⚠ **`ZugriffRepository.Zeile.standortName` kommt aus einem Unterabfrage-Join auf `standort` und trägt den
  Standort-Zaun** (IP-5). Wer den Standort nicht mehr sieht, liest `null`. Der Lader liest die Zeilen darum,
  BEVOR der Zaun der Anfrage steht — nur so trägt eine beendete Zuweisung den Namen für ihren Satz. Wer sie
  woanders liest, bekommt für fremde Standorte kein Kennzeichen und keinen Namen.
- ⚠ **Ein Konto mit nur KÜNFTIGER Zuweisung (Sabine ab 01.03.2027) ist NICHT „beendet"** — an ihr ist nichts
  vorbei. `stand()` liefert es in keiner der beiden Listen; es behält den engen Zaun ohne Fehlerbild.
- ⚠ **Ein Bestandskonto (E12) kann `letzter_kundenadministrator` auslösen.** Es handelt nach der Regel als
  Kundenadministrator, steht aber in KEINER Zuweisung und darum nicht in der Liste, die der Vertrag zählt.
  Der Schutz fällt dadurch nur strenger aus, nie lockerer. Das ist zugleich der einzige Weg, auf dem die 409
  heute erreichbar ist — `sperren`/`entfernen` (die anderen beiden Auslöser) baut erst IP-13/IP-14.
- ⚠ **Die Unterstützung geht NICHT durch diesen Prüfpunkt** und darf es nicht: der Notfall-Zugriff gewährt
  sich mit Absicht selbst (E8), `eigene_zuweisung` würde ihn verbieten. Ihr Urteil spricht
  `RechteAbleitung.gewaehren` (IP-8); `DELETE /api/v1/zugriff/{id}` antwortet auf eine Unterstützer-Zeile 404.
  `ZugriffAenderungArchitekturTest` führt die Liste der drei erlaubten Schreiber.
- ⚠ **Die neuen `ort_aenderung`-Arten sind PUNKTE.** `AenderungsprotokollRepository` (STROM_ORT) gibt ihnen
  `gilt_bis` = `gilt_ab`; ohne diese Ausnahme blieben sie offen und stünden in jedem späteren Zeitraum
  (`achse=gueltigkeit`, die AP-12-Schnittstelle). Für Berichte sind sie keine Strukturänderung
  (`BerichtRegeln.struktur`: unbekannte Art = `keine_strukturaenderung`) — ein Entzug ändert keine Zahl.
- ⚠ **Ein Standort ARCHIVIEREN beendet seine Zuweisungen nicht** (§5.6 will das). Wer dort zugewiesen ist,
  behält ihn in `app.standort_ids`. Befund für AP-02/IP-13, hier nicht gebaut.
- ⚠ **`ZugriffContext.Zugriff` trägt jetzt zwei Listen.** `zuweisungen` bleibt WIRKSAM (Zaun, `modus()`,
  `standortIds()`); `beendete` gibt nichts frei und dient allein dem Fehlerbild. `RechtPruefung.benutzer`
  reicht beide an den Vertrag, der selbst nach `wirksam(jetzt)` filtert.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='ZugriffEntzugApiTest,ZugriffAenderungArchitekturTest')
(cd services/api && ./mvnw test -Dtest='ZugriffZaunApiTest,SelbstauskunftApiTest,RechtMatrixApiTest')
(cd services/api && ./mvnw test -Dtest='AenderungSatzTest,AenderungsprotokollApiTest,OrtAenderungenApiTest')
(cd frontend/portal && npx vitest run src/rechte.test.ts)
```
