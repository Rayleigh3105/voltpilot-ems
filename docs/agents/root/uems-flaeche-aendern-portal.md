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
| „Umzug“ im selben Blatt, ab 2 km (§7, E1 = B) | `AnlageOrtBlatt.tsx` (Schritte `frage`/`datum`) · `src/anlageOrtBerichtigen.ts` (`istUmzugsfrage`/`umzugAnfrage`) · Backend `AnlageOrtService.umziehen`/`AnlageOrtController` · `.umzug.test.tsx` |
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
9. **Schritt 2c (fertig): „Gehört zu: … · Ändern” oben im Blatt, nicht mehr an der Zeile.**
   `AnlageOrtBlatt` zeigt für einen vollständigen Standort selbst „Gehört zu: {Standort}
   ({Kurzzeichen}) · {n} Anlagen · Ändern” über der Karte (nur ab zwei Standorten, `mehrereStandorte`)
   und öffnet dafür direkt `AnlageStandortDialog` (keine `AnlageStandortZeile` mehr dafür nötig -
   das `verweise`-Übergangsstück aus der Captain-Korrektur ist wieder entfernt). Siehe
   `docs/agents/root/uems-anlage-umziehen.md` für den Dialog selbst (Seit wann?, Neuer Standort, B2/B4).
   **Nicht hier:** die Fläche eines STANDORTS ändern (keine Schreibroute), der Verlauf vor dem
   Speichern (Server-Weg), die Lage des Standorts als Karten-Vorschlag im Assistenten. Befund: unter
   dem Picker steht im Assistenten weiter „Gleicher Standort wie …” (Koordinaten) — W4 ist dort
   nicht aufgelöst.
10. **Recht „Ort berichtigen" (E2 = A, vp-standort-konzept §7, Rechte-Stufe B5):** `PUT /api/v1/sites/
    {id}/ort` prüft seitdem `anlage.ort_berichtigen` statt des vorläufigen `anlage.verwalten`
    (`AnlageOrtController`) — Kundenadministrator und Energiemanager unternehmensweit, Unterstützer
    ab Umfang „Einrichten" (befristet, mit dem bestehenden Banner/Protokoll der Unterstützung, keine
    neue Mechanik), VoltPilot-Betrieb; Bearbeiter bekommt es nicht (wie `standort.verwalten`). Beide
    Portal-Einstiege (`Recht aktion` in `AnlageOrtBlatt.tsx` am Speichern/Rückgängig, `AnlageOrtZeile.tsx`
    am Öffnen der Zeile) tragen die neue Kennung; `docs/contracts/v2/rechte-matrix.json` trägt die
    Zeile als `nachtrag: "Standort v1 §7"` (Captain-Entscheid, kein AP-03-Bestand - Format der
    Nachtrags-Kennung siehe andere `nachtraege`-Einträge, z. B. „Steuerlogik v1 §8.8"), mit drei
    Vektor-Fällen in `rechte-vectors.json` und einer Zeile in `RechtMatrixApiTest.zeilen()`. „Gehört
    zu" ändern bleibt separat `anlage.zuordnen` (nur Kundenadministrator) — unberührt.
11. **„Umzug" (vp-standort-konzept §7, E1 = B): derselbe Weg wie die Berichtigung, ein eigener
    Schreibweg erst ab 2 km.** `AnlageOrtBlatt`s `AdressSuche` prüft jede Wahl mit
    `istUmzugsfrage(ursprung, neuerPunkt)` (`WEIT_WEG_METER = 2000`, wie seit §6.6 schon für Box-
    Neubau/Wetter-Nachholung dokumentiert — nur jetzt auch als UI-Schwelle genutzt); darunter bleibt
    es die normale Berichtigung (Regel 5: nie ein Datum). Darüber fragt das Blatt erst „Ist Ihre
    Anlage umgezogen?“ — „Nein, die Adresse war falsch“ übernimmt die Adresse wie gehabt; „Ja, wir
    sind umgezogen“ fragt den Umzugstag (`VpDatePicker` mit `max = antwort.stichtag`: heute oder
    rückwirkend, nie in die Zukunft) und speichert über den neuen `POST /api/v1/sites/{id}/ort/
    umzug` (`AnlageOrtController`/`AnlageOrtService.umziehen`).
    **Der Standort entsteht still.** `AnlageOrtService.umziehen` ruft `StandortService.anlegen`
    DIREKT auf (Bean-zu-Bean, nicht über `StandortController`) — ein Unterstützer mit
    `anlage.ort_berichtigen`, aber ohne `standort.verwalten`, kann so trotzdem einen neuen Standort
    auslösen, weil `@Recht` nur am HTTP-Rand prüft. Der neue Standort heißt wie die Anlage (keine
    eigene Eingabe). Anschließend ruft der Service — intern, nicht über HTTP — denselben
    `AnlageUmzugService.umziehen` wie „Gehört zu“ (`docs/agents/root/uems-anlage-umziehen.md`) auf:
    Geschwister am alten Standort ziehen NICHT mit (anders als `berichtigen()`s „Geschwister
    mitziehen“ — ein bewusst getrennter Code-Pfad, keine Erweiterung von `berichtigen()`). Die
    Antwort (`AnlageOrtUmzugErgebnis`) bettet das volle `AnlageUmzug`-Objekt der Umzugs-Antwort ein,
    damit das Blatt dieselbe, schon getestete `folgenKarte()`/`kurzeFolgen()` aus `anlageUmziehen.ts`
    für die Ergebnis-Sätze wiederverwendet (keine zweite, unverifizierte Satzliste) — eine echte
    Vorschau VOR dem Speichern ist strukturell nicht möglich, da `AnlageUmzugService.vorschau()`
    einen bereits bestehenden `standortId` braucht.
    **Danach:** wie bei „Zuordnung korrigieren“ liest das Blatt `GET /standorte/{id}/orte` des
    bisherigen Standorts und bietet `ArchivierenDialog` an, wenn `aktionen.archivieren.erlaubt` —
    keine eigene Mechanik, derselbe `archivAngebot`-Zustand wie in `AnlageStandortDialog.tsx`
    (dort jetzt als `FolgenKarteAnsicht`/`ArchivObjekt`-Pattern exportiert statt dupliziert). Ist der
    Kunde danach wieder bei genau einem Standort, verschwindet „Gehört zu“ von selbst
    (`mehrereStandorte()`) — keine eigene Privatkunden-Prüfung nötig.
    **„Fertig“ zeigt sofort die neue Adresse, kein eigener Mechanismus nötig:** `onGespeichert`
    ruft dieselbe Kette wie jede Berichtigung (`AnlageOrtZeile` → `AnlageTechnik`s
    `standortNeuLaden()` → `useAnlageStandort`s `GET /api/v1/standorte` neu) — die Zeile UND das
    Blatt lesen live, nie eine lokale Kopie der alten Adresse (Inbox 017, Captain-Frage vor dem
    ersten Merge: ein Screenshot mit der statisch gebliebenen alten Adresse war eine Lücke im
    e2e-Mock, kein Produktverhalten — `e2e/anlage-ort-umzug.spec.ts` trägt seitdem einen
    ZUSTANDSBEHAFTETEN `standorte()`-Mock, der nach `POST .../ort/umzug` wie ein echter Server
    antwortet, und prüft die neue Adresse an der Zeile UND im wieder geöffneten Blatt). Ab zwei
    Standorten (der bisherige, jetzt nur mit seinen übrigen Geschwistern, UND der neue) trägt die
    Zeile zusätzlich den Standort-Namen voran (§6.2, E3) — normales `ortZeileText`-Verhalten, kein
    Umzug-Sonderfall.
    **Zwei Umzüge derselben Anlage:** der zweite still angelegte Standort hieße wieder wie die
    Anlage — kollidiert der Name mit dem ersten (noch nicht archivierten) Umzugs-Standort,
    hängt `StandortService.freierStandortName(basis)` einen Zähler an („Halle 1 (2)“), statt mit
    `name_belegt` (409) abzulehnen.
    **Ergebnis-Sätze in Kundenworten, nicht die Zuordnungs-Sätze von „Gehört zu“** (Captain-
    Korrektur): weil der neue Standort wie die Anlage heißt, wäre „{Anlage} gehört ab {Tag} zu
    {Standort}“ ein wörtliches „X gehört zu X“ — doppelt und sinnlos. Das Ergebnis trägt stattdessen
    EIGENE Sätze aus `anlageOrtBerichtigen.ts` (`umzugErgebnisSatz`: „Ab {Tag} steht die Anlage in
    {Adresse}.“; `umzugsFolgenSaetze`: Verlauf/Prognose/Box aus den ECHTEN `AnlageUmzug`-Feldern,
    „Die Box bleibt …“ nur, wenn `boxen > 0`). Der Titel bleibt durchgehend „Standort“, nicht
    „Gehört zu“ — `folgenKarte()`/`FolgenKarteAnsicht` bleiben nur hinter „Alle Folgen“ als
    optionaler, server-wahrer Beleg erhalten.
    **Wetter trennt sich am Umzugstag, Lernfenster beginnt dort neu** (Captain-Korrektur auf die
    vorherige Vereinfachung): `ort_wetter_nachholung.ab_tag` (Migration `V20261127130000`)
    unterscheidet die zwei Auslöser derselben Outbox-Tabelle — `NULL` bleibt „Ort berichtigen“
    (verwirft weiter ALLES und holt `NACHHOL_TAGE = 28` Tage am neuen Punkt nach, B3 unverändert);
    gesetzt (Umzug) behält `wetter_nachholung.py`s `_umzug_fetch` das Wetter VOR `ab_tag`
    (`WeatherForecastRepository.points_before`, pro Stunde der letzte `run_at` — derselbe Rang wie
    `forecast_collect._weather_history`) und ersetzt nur AB `ab_tag` durch das neue am neuen Punkt
    (`OpenMeteoWeatherSource.with_past_days`, dynamisch auf `heute - ab_tag` Tage, gedeckelt bei
    `PAST_DAYS_MAX = 92`) — beide Hälften landen unter EINEM frischen `run_at`, damit `latest()`
    weiter genau einen zusammenhängenden Lauf sieht, wie heute. `site.umzug_seit` (dieselbe
    Migration) trägt den jüngsten Umzugstag; `forecast_collect.lernfenster_start` beginnt das
    Lernfenster bei `max(heute − history_days, umzug_seit)` statt immer bei `heute − 28 Tage` — ein
    länger als 28 Tage zurückliegender Umzug wirkt sich von selbst nicht mehr aus (das Maximum
    fällt zurück), kein eigenes Aufräumen von `umzug_seit` nötig. Eine Berichtigung setzt
    `umzug_seit` NICHT — sie darf weiter rückwirkend alles ersetzen. Dev-Mirror:
    `infra/local/timescale/08-umzug-lernfenster.sql` (`site.umzug_seit`); `ort_wetter_nachholung`
    selbst hat (wie schon vor diesem PR) keinen Mirror — reiner api/forecast-Schreibweg, nie vom
    Init-Seed berührt.
    **Merkzettel „Neues Haus? Bitte prüfen“ ist jetzt persistent, je Anlage, auf jedem Gerät
    sichtbar** (Captain-Korrektur auf die vorherige Vereinfachung): Tabelle
    `anlage_umzug_merkzettel` (Migration `V20261127140000`, `site_id` Primärschlüssel — ein Umzug
    ERSETZT eine noch offene Erinnerung vollständig statt eine zweite anzulegen) mit drei
    Haken-Spalten (`solaranlage_erledigt`/`stromtarif_erledigt`/`einspeiseverguetung_erledigt`).
    `UmzugMerkzettelController` (`GET`/`POST .../erledigen`, Recht wie `SiteController#updateSite`:
    `anlage.verwalten`) liest/schreibt sie; „geprüft“ und „weggeklickt“ sind dieselbe Handlung — EIN
    Tipp auf einen Chip setzt seinen Haken, es gibt keine eigene Unterscheidung im Produkt.
    „Geändert“ für Stromtarif/Einspeisevergütung braucht KEINEN eigenen Schreibweg-Hook: die api
    liest live, ob seit `seit` eine neue `anlage_preisfassung`-Zeile entstanden ist
    (`PreisfassungRepository.geaendertSeit`) — jede Preisänderung zeichnet dort ein Trigger auf,
    unabhängig vom aufrufenden Endpunkt. Beide Felder werden GEMEINSAM wahr (eine Fassung trägt
    Tarif, Preisblatt UND Einspeisevergütung zusammen; eine feinere Unterscheidung bräuchte einen
    Vergleich gegen die vorherige Fassung — bewusst nicht gebaut). Solaranlage hat keine
    entsprechende Fassungs-Historie — ihr Haken kommt NUR vom Tipp (dokumentierte, bewusste
    Vereinfachung, im Unterschied zu den zwei oben korrigierten Punkten). Portal: die geteilte
    `UmzugMerkzettelKarte` (`src/components/`) steht sowohl auf dem Ergebnis des Umzugs
    (`AnlageOrtBlatt`, dort mit dem echten, frisch vom Server gelesenen Stand statt eines
    geratenen Anfangswerts) als auch als eigene Zeile über den Einstellungsgruppen auf „Meine
    Anlage“ (`AnlageTechnik`, `GET` beim Laden der Anlage) — verschwindet die Karte (alle drei
    Haken), meldet sie `null` zurück.
    Preise/Tarif/Einspeisevergütung selbst brauchen KEINEN Umzug-Sondercode: seit
    `anlage_preisfassung` (PR #2043, „Preise ab einem Tag“) gelten sie ohnehin je Anlage ab einem
    Tag, nicht je Standort.

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/flaecheAendern.test.ts src/anlageStandort.test.ts src/anlageOrtBerichtigen.test.ts src/anlageUmziehen.test.ts src/components/FlaecheDialog.test.tsx src/components/OrtDialog.test.tsx src/components/AnlageFlow.standort.test.tsx src/components/AnlageStandortDialog.test.tsx src/components/AnlageOrtBlatt.umzug.test.tsx src/components/UmzugMerkzettelKarte.test.tsx src/pages/AnlageTechnik.standort.test.tsx src/pages/AnlageTechnik.test.tsx src/rechte.test.ts src/rechteMatrix.sync.test.ts src/copy.test.ts src/migration.test.ts)
(cd frontend/portal && npx playwright test e2e/flaeche-aendern.spec.ts e2e/anlage-ort-berichtigen.spec.ts e2e/anlage-ort-umzug.spec.ts e2e/anlage-umziehen.spec.ts e2e/zuordnung-korrigieren.spec.ts e2e/einspeiseverguetung.spec.ts --project=desktop-chromium)
(cd services/api && ./mvnw test -Dtest='AnlageOrtApiTest,OrtSchnittstelleVertragTest,RechteKennungenDerRoutenTest,RechteAbleitungVectorsTest,RechtRoutenArchitekturTest,RechtMatrixApiTest,KundeDatenBestandMigrationTest')
(cd services/forecast && python3 -m pytest tests/test_wetter_nachholung.py tests/test_collect.py -q)
```
