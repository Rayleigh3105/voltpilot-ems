# UEMS-Fläche: „Fläche ändern“ mit Verlauf, die Zeile „Standort“ in „Meine Anlage“, der Standort-Picker im Assistenten (AP-02 IP-8)

Drei kleine Portal-Stücke der Ortsstruktur (Mockups T7, T6a; Widerspruch W4): eine vorhandene
Bezugsfläche ändert der Kunde mit „gültig ab“ und sieht danach ihren Verlauf; „Meine Anlage“ nennt
das Objekt „Standort“; der Anlage-Assistent fragt in Schritt 1 nach dem Standort. Kein Backend, keine
Migration: geschrieben über `PUT /api/v1/orte/{id}/flaeche` (IP-5), gelesen über `GET /api/v1/standorte`
(IP-3), angelegt über `POST /api/v1/sites` mit `standortId` (IP-9).

| Teil | Datei |
|---|---|
| Ableitung Fläche (rein): Prüfung, Anfrage, Folgen vorher/nachher, Verlauf | `frontend/portal/src/flaecheAendern.ts` · `flaecheAendern.test.ts` |
| Dialog „Fläche ändern“ (T7), Einstieg „Fläche ändern“ im Gebäude-/Bereich-Dialog | `src/components/FlaecheDialog.tsx` (+ `.css`, `.test.tsx`) · `OrtDialog.tsx` |
| Ableitung Standort der Anlage und Picker (rein) | `src/anlageStandort.ts` · `anlageStandort.test.ts` |
| Zeile „Standort” (unvollständiger Standort) + Lese-Hook, Wirt `TechnikSection` | `src/components/AnlageStandortZeile.tsx` (+ `.css`) · `pages/AnlageTechnik.tsx` |
| Zeile „Standort” + Blatt „Ort berichtigen” (vollständiger Standort, vp-standort-konzept §6.1, B1/B3/B6/E3) | `src/components/AnlageOrtZeile.tsx`/`.css`, `AnlageOrtBlatt.tsx`/`.css` · `src/anlageOrtBerichtigen.ts` (+ `.test.ts`) |
| Umschalter + Felder „Koordinaten manuell bearbeiten” (geteilt: `LocationMap` selbst UND unter „Details” im Blatt) | `src/components/KoordinatenManuellFelder.tsx` |
| Picker in Schritt 1 | `AnlageStep` in `src/components/AnlageFlow.tsx` |
| Bestandsschutz (Snapshots aufgenommen VOR IP-8, eigener Commit) | `pages/AnlageTechnik.standort.test.tsx`, `components/AnlageFlow.standort.test.tsx`, je `__snapshots__/*.html` |
| 375/1440 px + Bilder | `e2e/flaeche-aendern.spec.ts` (Bühnen `standorte.html`, `meine-anlage.html`), `e2e/anlage-ort-berichtigen.spec.ts`; `FLAECHE_BILDER=<Ordner>`/`ORT_BILDER=<Ordner>` |
| Kundenwort | Glossar-Verfeinerung „AP-02 W4 (IP-8)” (`docs/fachmodell/tools/fachmodell.py`), `UEMS_STANDORT_AUF_DER_KARTE` |

## Die Fallen

1. **Es gibt keinen Lese-Weg für die Flächen-Intervalle eines Orts.** Vor dem Speichern stehen nur
   „Heute gilt: …“ (Ortsbaum) und die Folgen des Datums — `rueckwirkung` AUFGERUFEN am Eintragstag
   heute (`mitternacht(antwort.stichtag, zeitzone)`, Zeitzone des Standorts). Wie lange die neue Fläche
   gilt, weiß erst der Server (eine spätere beendet sie): die Sätze vorher nennen kein Ende. Der
   Verlauf kommt aus der PUT-Antwort `Ort.flaechen`, die neue Zeile trägt das Abzeichen des Servers,
   die Folgen nachher nennen die Tage aus `rueckwirkendBetroffen`. Ein Verlauf VOR dem Speichern
   braucht einen Server-Weg — nie einen geratenen.
2. **Kein Satz über freigegebene Berichte** („Kein freigegebener Bericht ist betroffen“, T7): die gibt
   es erst mit AP-12. Die Referenz sagt „rückwirkend (14 Tage)“ (01.01. → 15.01.2027), das Mockup
   15 — es gelten Regel und Referenzdatei.
3. **Nach „Fläche ändern“ lädt auch „Abbrechen“ des Gebäude-Dialogs den Baum neu** (`onGespeichert`),
   sonst stünde dort die alte Fläche; der Dialog zeigt die heute gültige aus der Antwort. Der Knopf
   steht UNTER dem Flächen-Kasten (`vp-sd-verweis`), der Kasten selbst ist unverändert (Test IP-7).
4. **Bestandsschutz W4/W8:** ohne Standort-Objekt (keins, nur andere Anlagen, unlesbar) ist „Meine
   Anlage“ byte-identisch — kein Umbenennen der Koordinaten-Zeile, keine leere Zeile — und Schritt 1
   ohne Picker, `POST` ohne `standortId` (`...(standortId ? { standortId } : {})`). Die Snapshots
   normalisieren NUR Reacts `useId`-Zähler (`:rN:` in Reihenfolge); ändert sich dort ein Byte, ist das
   ein Bruch, kein neuer Snapshot.
5. **Zwei Zeilen, zwei Namen — NUR solange der Standort unvollständig ist.** Ohne Standort-Objekt
   oder mit einem unvollständigen (`esFehlt` nicht leer, z. B. gerade erst automatisch angelegt)
   bleibt es wie bisher: „Standort” ist das Objekt (Name, Kurzzeichen, Adresse, „seit” = Beginn der
   Zuordnung), die Koordinaten-Zeile heißt dann „Standort auf der Karte” (`koordinatenLabel`) — direkt
   untereinander wie T6a. Die Vergleichsvariante (Koordinaten-Zeile über die Landkarte versetzt) ist
   in der Vorschau fotografiert und verworfen; siehe dort die Maße.
   Ein VOLLSTÄNDIGER Standort (Adresse UND Lage, `esFehlt.length === 0`) bekommt seit
   vp-standort-konzept §6.1 (B1/B3/B6, E3) NUR NOCH EINE Zeile „Standort” — `AnlageOrtZeile` mit
   kleiner Karte (58×44 px) statt des Objekts und der zweiten Koordinaten-Zeile; ein Tipp öffnet
   `AnlageOrtBlatt` (Karte groß + Adresssuche, schreibt Adresse/Lage/Gebotszone/Box-Neubau/
   Wetter-Nachholung in einem Zug über `PUT /api/v1/sites/{id}/ort`). Grund: B1 beschreibt genau den
   Fall einer VOLLSTÄNDIGEN, nur falschen Adresse — die Objekt-Zeile bot dafür keinen Schreibweg.
   **Captain-Korrektur (gleiche Fassung):** die Zeile sieht aus wie ihre Nachbarn - eigenes `<li>`
   mit denselben Klassen wie `Zeile` in `AnlageTechnik.tsx` (`vp-einst-zeile`/`vp-einst-lab`/
   `vp-einst-wert`/`vp-einst-ende`, die Karte ersetzt nur die Symbol-Kachel, kein `vp-kv`). Die
   kompakte Karte verankert ihren Marker in seiner eigenen Mitte (nicht an der Pin-Spitze wie die
   große Karte), sonst klebt er in 44 px Höhe sichtbar am oberen Rand.
6. **„Adresse nachtragen“** öffnet den Standort-Dialog aus IP-6 („vervollständigen“) — für
   Einzel-Anlagen-Kunden der einzige Weg zu ihrem Standort; `unternehmen` wird erst beim Öffnen gelesen.
7. **Picker:** mehrere Standorte ohne Wahl → der Satz des Servers (`standortWaehlenSatz` ≡
   `AnlageStandortService`) VOR dem Senden; war die Auswahl unlesbar, antwortet der Server 422
   `standort_waehlen` → sein Satz an den Picker, Auswahl neu lesen. `standort_waehlen` fehlt in der
   Codeliste von `OrtFehler` (Vergleich als `string`).
8. **Tests:** Testing Library glättet NBSP nur im DOM-Text — `getByText`/`toHaveTextContent` mit
   `m2Text`-Sätzen suchen mit Leerzeichen (`sp()` in `FlaecheDialog.test.tsx`). E2E: Leaflet-Kacheln
   liegen abgeschnitten außerhalb ihres Rahmens — die Elementprüfung nimmt `.leaflet-container` aus
   (`seite` misst trotzdem); am Telefon ist `TechCard` zugeklappt.
9. **Anlage zuordnen/umziehen (IP-11, T6b) bleibt übergangsweise an `AnlageStandortZeile` hängen -
   aber unter „Details” im Blatt, nicht mehr an der Zeile.** `AnlageOrtZeile` nimmt einen optionalen
   `verweise`-Slot und reicht ihn nur an `AnlageOrtBlatt` weiter; solange Schritt 2c („Gehört zu” mit
   Liste/„Neuer Standort”/„Seit wann?”, B4) noch nicht steht, rendert `AnlageTechnik.tsx` für einen
   vollständigen Standort `<AnlageStandortZeile nurVerweise />` als `verweise` - dieser Zweig gibt
   seit der Korrektur ein Fragment zurück (keine eigene Hülle, `AnlageOrtBlatt` platziert die beiden
   Verweise „Anderem Standort zuordnen”/„Zuordnung korrigieren” selbst unter „Details”, zusammen mit
   Strommarkt/Zeitzone UND „Koordinaten manuell bearbeiten” (`KoordinatenManuellFelder`, dieselbe
   Komponente wie in `LocationMap` selbst - die Karte im Blatt blendet ihre eigene Kopie über
   `manuellAusblenden` aus). Ohne den Slot verlöre ein vollständiger Standort die Fähigkeit
   ersatzlos (AGENTS.md: bestehende Funktion erhalten). Ein Test, der „Anderem Standort
   zuordnen”/„Zuordnung korrigieren” sucht, muss die Zeile erst öffnen und „Details” aufklappen
   (`e2e/anlage-umziehen.spec.ts`, `e2e/zuordnung-korrigieren.spec.ts`). **Nicht hier:** die Fläche
   eines STANDORTS ändern (keine Schreibroute), der Verlauf vor dem Speichern (Server-Weg), die Lage
   des Standorts als Karten-Vorschlag im Assistenten. Befund: unter dem Picker steht im Assistenten
   weiter „Gleicher Standort wie …” (Koordinaten) — W4 ist dort nicht aufgelöst.

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/flaecheAendern.test.ts src/anlageStandort.test.ts src/anlageOrtBerichtigen.test.ts src/components/FlaecheDialog.test.tsx src/components/OrtDialog.test.tsx src/components/AnlageFlow.standort.test.tsx src/pages/AnlageTechnik.standort.test.tsx src/pages/AnlageTechnik.test.tsx src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/flaeche-aendern.spec.ts e2e/anlage-ort-berichtigen.spec.ts e2e/anlage-umziehen.spec.ts e2e/einspeiseverguetung.spec.ts --project=desktop-chromium)
```
