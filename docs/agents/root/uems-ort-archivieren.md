# UEMS: Archivieren, Wiederherstellen und Löschen im Ortsbaum (AP-02 IP-15)

Grundsatz (E1, Captain 13.09.2026 „Ich will das nichts verloren geht“): archivieren statt löschen —
gefiltert wird über den Zustand, nie durch Löschen der Geschichte; gelöscht wird nur, woran nie etwas hing.

| Teil | Datei |
|---|---|
| Routen `POST /api/v1/orte/{id}/archivieren` · `…/wiederherstellen` · `DELETE /api/v1/orte/{id}` | `web/OrtController`, Arbeit `uems/OrtService` (`archivieren`, `wiederherstellen`, `loeschen`) |
| Aktionen je Knoten (rein, ohne Uhr) — additiv `aktionen` an Gebäude/Bereich/Standort und `archiviert` (Grabsteine) an `GET …/standorte/{id}/orte` | `uems/OrtAktionen`, `uems/OrtsbaumLesemodell.archiviert` |
| Löschen am Datenbank-Zaun | `V20260914233000__uems_ort_loeschen.sql` → `uems_ort_loeschen(ort)` (SECURITY DEFINER, nur App-Rolle) |
| Portal: Menü je Knoten · Dialog Z1/Z2/Z3/Löschen · reine Texte | `components/OrtMenue.tsx`, `components/ArchivierenDialog.tsx`, `src/ortArchiv.ts` |
| Wirte | `components/Ortsbaum.tsx` (Gebäude/Bereich + Grabsteine), `StandortKopf` (Standort-Menü), `StandortePage` („Wiederherstellen …“ an archivierten Standorten) |
| Beweise | `OrtArchivApiTest` (A7/A8/A9), `OrtSchnittstelleVertragTest`; `ortArchiv.test.ts`, `components/OrtsbaumArchiv.test.tsx`, `copy.test.ts`; Bilder `e2e/ort-archivieren.spec.ts` (`ORT_ARCHIV_BILDER=<Ordner>`) |

## Die Fallen

1. **Kein Knopf, der dann 409 sagt.** Das Menü baut NUR aus `aktionen` des Servers (`OrtAktionen`, auf
   DEMSELBEN Baum wie die Schreibrouten: `StandortService.baum(zeilen, messstellen)` — Orte nach
   KURZZEICHEN, sonst sieht die Sperre die Messstellen nicht). Mit Stichtag sind `aktionen` `null`.
2. **Gesperrtes Archivieren bleibt sichtbar, gesperrtes Löschen ist nur ein Hinweis.** „Archivieren nicht
   möglich …“ trägt die Kurzfassung des Grunds und öffnet Z1 (Satz des Vertrags + „So geht es weiter“) —
   es gibt einen Weg. Löschen mit Historie hat keinen Weg: ein `<p>` ohne Handlung. Darum ist das Menü
   KEIN `role="menu"` (das darf nur Menüpunkte tragen), sondern eine Aufklapp-Gruppe.
3. **`hat_bezugsgroessen` steht NICHT im Vertrag.** E1 kennt Messstelle, Anlage, Fläche, Kinder; eine
   Bezugsgröße (AP-09) am Ort blockiert per Fremdschlüssel ohnehin — sie zählt deshalb als Historie. Die
   Ablehnung heißt `loeschen_gesperrt` mit `historie` (nicht `gruende`: das ist die Sperrgrund-Liste).
4. **Grabstein = Tag nach dem letzten Intervall vor dem Stichtag** (`OrtsbaumLesemodell.archiviert`), der
   Standort aus dem letzten Intervall (direkt oder über das Gebäude). Am Anlagetag mitarchiviert → das
   Intervall ist aufgehoben, der Tag kommt aus `archiviert_am`; Wiederherstellen sagt dort `nicht_archiviert`
   (kein Eintrag im Menü), Löschen bleibt der Weg.
5. **Wiederherstellen**: neues Intervall ab heute am letzten Elternknoten, `archiviert_am` wieder NULL — die
   Lücke steht in den Intervallen (nicht im Protokoll wie beim Standort). Belegter Name öffnet trotzdem
   (Satz am Feld, Umbenennen im selben Dialog); archivierter Elternknoten = Hinweis.
6. **Löschen**: Protokoll „geloescht“ am Elternknoten des letzten Intervalls; das Kurzzeichen bleibt in
   `ort_kurzzeichen` belegt. Die Datenbank-Ablehnung (23001/23503) wird zur selben 409.
7. **Stift UND Menü je Zeile (Variante A, gebaut) — nicht „Bearbeiten“ im Menü (B, Mockup V1).** Vorschau
   IP-15, gemessen bei 375 px: A lässt dem Zeilentext 132 px (Kurzzeichen bricht unter lange Namen), B 184 px.
   Gebaut ist A, weil Bearbeiten ein Tipp bleibt und der getestete Stift-Weg aus IP-7/IP-13 unverändert
   bleibt; B ist der Kandidat, sobald „Verschieben“ (IP-12) und „Änderungen“ (H2) ins Menü kommen. Ein
   archivierter Knoten hält KEINEN Stift-Platz (kein Stift, keine Datenlage-Spalte) — sonst bricht der Archivtag um.
8. **Nicht hier:** Löschen eines Standorts (§4.1, nie), eine Messstellen-Seite im Portal für den Weg aus Z1
   (der Satz nennt ihn, ein Link kommt mit AP-13), Verschieben (IP-12), das Änderungsprotokoll (H2).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='OrtSchnittstelleVertragTest,OrtsbaumLesemodellTest,OrtsbaumAbleitungVectorsTest')
(cd services/api && ./mvnw test -Dtest=OrtArchivApiTest)   # Testcontainers, ~60 s
(cd frontend/portal && npx vitest run src/ortArchiv.test.ts src/components/OrtsbaumArchiv.test.tsx src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/ort-archivieren.spec.ts --project=desktop-chromium)
```
